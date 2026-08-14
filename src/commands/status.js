import { NotInitialized, TaskStateError } from "../errors.js";
import { currentBranch, isRepo } from "../git.js";
import { loadProfile, profileExists } from "../profile.js";
import { loadTask, taskExists } from "../taskstore.js";
import { taskIdFromBranch } from "./commit.js";

export async function statusCommand(cwd, taskId) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const profile = loadProfile(cwd);
  let resolvedId = taskId;

  if (!resolvedId) {
    const branch = await currentBranch(cwd);
    resolvedId = taskIdFromBranch(branch, profile.workflow.branch_prefix);
    if (!resolvedId) {
      throw new TaskStateError("No active task on this branch.", "Run agit start <task-id> or agit status <task-id>.");
    }
  }

  if (!taskExists(cwd, resolvedId)) {
    throw new TaskStateError(`Task ${resolvedId} was not found.`, "Run agit start <task-id> first.");
  }

  const task = loadTask(cwd, resolvedId);
  const data = {
    task_id: task.task_id,
    branch: task.branch,
    status: task.status,
    commits: task.commits ?? [],
    checks: task.checks ?? { last_status: null },
    pushed: Boolean(task.publish?.pushed),
    pr_url: task.publish?.pr_url ?? null,
  };

  return {
    ...data,
    message: [
      `Task: ${data.task_id}`,
      `Branch: ${data.branch}`,
      `Status: ${data.status}`,
      `Commits: ${data.commits.length}`,
      `Checks: ${data.checks.last_status ?? "not run yet"}`,
      `Pushed: ${data.pushed ? "yes" : "no"}`,
      `PR: ${data.pr_url ?? "not created"}`,
    ].join("\n"),
  };
}
