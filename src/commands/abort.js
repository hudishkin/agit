import { existsSync } from "node:fs";
import { DirtyTree, NotInitialized, TaskStateError } from "../errors.js";
import { deleteBranch, isClean, isRepo, removeWorktree } from "../git.js";
import { withTaskLock } from "../lock.js";
import { profileExists } from "../profile.js";
import { agitRoot, resolveTaskTree } from "../root.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

export async function abortCommand(cwd, taskId) {
  assertTaskId(taskId);

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const root = await agitRoot(cwd);
  if (!taskExists(root, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  return withTaskLock(root, taskId, async () => {
    const task = loadTask(root, taskId);
    if (task.publish?.pushed || task.status === "pr_created" || task.status === "pushed") {
      throw new TaskStateError(
        `Task ${taskId} was already published.`,
        "Close the pull request yourself. agit abort will not delete a remote branch.",
      );
    }

    const tree = resolveTaskTree(root, task, cwd);
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
    saveTask(root, task);

    return {
      task_id: taskId,
      branch: task.branch,
      status: "aborted",
      message: `Aborted ${taskId}. Local branch removed. Remote was not changed.`,
    };
  });
}
