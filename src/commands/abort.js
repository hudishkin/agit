import { DirtyTree, NotInitialized, TaskStateError } from "../errors.js";
import { checkout, currentBranch, isClean, isRepo } from "../git.js";
import { loadProfile, profileExists } from "../profile.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

export async function abortCommand(cwd, taskId) {
  assertTaskId(taskId);

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  if (!taskExists(cwd, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  const task = loadTask(cwd, taskId);
  if (task.publish?.pushed || task.status === "pr_created" || task.status === "pushed") {
    throw new TaskStateError(
      `Task ${taskId} was already published.`,
      "Close the pull request yourself. agit abort will not delete a remote branch.",
    );
  }

  if (!(await isClean(cwd))) {
    throw new DirtyTree("Working tree is not clean.");
  }

  const profile = loadProfile(cwd);
  const current = await currentBranch(cwd);
  if (current === task.branch) {
    await checkout(cwd, profile.repo.default_branch);
  }

  task.status = "aborted";
  saveTask(cwd, task);

  return {
    task_id: taskId,
    branch: task.branch,
    status: "aborted",
    message: `Aborted ${taskId}. Remote was not changed.`,
  };
}
