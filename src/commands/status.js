import { existsSync } from "node:fs";
import { NotInitialized, TaskStateError } from "../errors.js";
import { currentBranch, isRepo } from "../git.js";
import { loadProfile, profileExists } from "../profile.js";
import { agitRoot, resolveTaskTree } from "../root.js";
import { listTaskIds, loadTask, taskExists } from "../taskstore.js";
import { taskIdFromBranch } from "./commit.js";

function taskPayload(root, task, cwd) {
  const path = resolveTaskTree(root, task, cwd);
  return {
    task_id: task.task_id,
    branch: task.branch,
    status: task.status,
    path: task.worktree ? path : null,
    commits: task.commits ?? [],
    checks: task.checks ?? { last_status: null },
    pushed: Boolean(task.publish?.pushed),
    pr_url: task.publish?.pr_url ?? null,
  };
}

function formatTask(data) {
  return [
    `Task: ${data.task_id}`,
    `Branch: ${data.branch}`,
    `Status: ${data.status}`,
    data.path ? `Path: ${data.path}` : null,
    `Commits: ${data.commits.length}`,
    `Checks: ${data.checks.last_status ?? "not run yet"}`,
    `Pushed: ${data.pushed ? "yes" : "no"}`,
    `PR: ${data.pr_url ?? "not created"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function statusCommand(cwd, taskId, { all = false } = {}) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const root = await agitRoot(cwd);
  const profile = loadProfile(cwd);

  if (all) {
    const tasks = listTaskIds(root).map((id) => {
      const task = loadTask(root, id);
      const data = taskPayload(root, task, cwd);
      return {
        ...data,
        worktree_exists: Boolean(data.path && existsSync(data.path)),
      };
    });
    return {
      tasks,
      message:
        tasks.length === 0
          ? "No agit tasks."
          : tasks
              .map((task) => `${task.task_id}  ${task.status}  ${task.path ?? task.branch}`)
              .join("\n"),
    };
  }

  let resolvedId = taskId;

  if (!resolvedId) {
    const branch = await currentBranch(cwd);
    resolvedId = taskIdFromBranch(branch, profile.workflow.branch_prefix);
    if (!resolvedId) {
      throw new TaskStateError("No active task on this branch.", "Run agit start <task-id> or agit status <task-id>.");
    }
  }

  if (!taskExists(root, resolvedId)) {
    throw new TaskStateError(`Task ${resolvedId} was not found.`, "Run agit start <task-id> first.");
  }

  const data = taskPayload(root, loadTask(root, resolvedId), cwd);
  return {
    ...data,
    message: formatTask(data),
  };
}
