import { existsSync } from "node:fs";
import { DirtyTree, TaskStateError } from "../errors.js";
import { deleteBranch, isClean, removeWorktree } from "../git.js";
import { withTaskLock } from "../lock.js";
import { resolveTaskTree } from "../root.js";
import { loadWorkspace } from "../store.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

export async function abortCommand(cwd, taskId) {
  assertTaskId(taskId);

  const { store, root } = await loadWorkspace(cwd);
  const state = store.dir;
  if (!taskExists(state, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  return withTaskLock(state, taskId, async () => {
    const task = loadTask(state, taskId);
    if (task.publish?.pushed || task.status === "pr_created" || task.status === "pushed") {
      throw new TaskStateError(
        `Task ${taskId} was already published.`,
        task.publish?.pr_url
          ? "Close the pull request yourself. agit abort will not delete a remote branch."
          : `Run agit done ${taskId} to remove the local worktree. The remote branch is left in place.`,
      );
    }

    const tree = resolveTaskTree(store, task, cwd);
    if (existsSync(tree) && tree !== root) {
      if (!(await isClean(tree))) {
        throw new DirtyTree("Working tree is not clean.");
      }
      await removeWorktree(root, tree);
    } else if (tree === root || !task.worktree) {
      if (!(await isClean(cwd))) {
        throw new DirtyTree("Working tree is not clean.");
      }
    }

    await deleteBranch(root, task.branch);

    task.status = "aborted";
    saveTask(state, task);

    return {
      task_id: taskId,
      branch: task.branch,
      status: "aborted",
      message: `Aborted ${taskId}. Local branch removed. Remote was not changed.`,
    };
  });
}
