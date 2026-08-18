import { existsSync } from "node:fs";
import { TaskStateError } from "../errors.js";
import { deleteBranch, removeWorktree } from "../git.js";
import { withTaskLock } from "../lock.js";
import { inspectMergeRequest } from "../prhost.js";
import { resolveTaskTree } from "../root.js";
import { loadWorkspace } from "../store.js";
import { assertTaskId, deleteTask, loadTask, taskExists } from "../taskstore.js";

export function doneHint(taskId) {
  return `PR merged. Run: agit done ${taskId}`;
}

export async function doneCommand(cwd, taskId, { inspectPr: inspect = inspectMergeRequest } = {}) {
  assertTaskId(taskId);

  const { store, root } = await loadWorkspace(cwd);
  const state = store.dir;
  if (!taskExists(state, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  return withTaskLock(state, taskId, async () => {
    const task = loadTask(state, taskId);
    const prUrl = task.publish?.pr_url ?? null;

    if (!prUrl) {
      if (task.publish?.pushed || task.status === "pushed") {
        throw new TaskStateError(
          `Task ${taskId} was pushed without a pull request.`,
          `Run agit finish ${taskId} to open one, then agit done ${taskId} after it is merged.`,
        );
      }
      throw new TaskStateError(
        `Task ${taskId} was not published.`,
        `Run agit abort ${taskId} to drop an unpublished task.`,
      );
    }

    const pr = await inspect(root, prUrl);
    if (!pr) {
      throw new TaskStateError(
        `Could not inspect the pull request for ${taskId}.`,
        "Install and authenticate the CLI for pr.provider, then retry.",
      );
    }
    if (!pr.merged) {
      throw new TaskStateError(
        "Pull request is not merged.",
        "Wait until it is merged, then run agit done again.",
        { pr_url: prUrl, state: pr.state },
      );
    }

    const tree = resolveTaskTree(store, task, cwd);
    if (existsSync(tree) && tree !== root) {
      await removeWorktree(root, tree, { force: true });
    }

    await deleteBranch(root, task.branch);
    deleteTask(state, taskId);

    return {
      task_id: taskId,
      branch: task.branch,
      pr_url: prUrl,
      status: "done",
      message: `Done ${taskId}. Local worktree and branch removed. Remote was not changed.`,
    };
  });
}
