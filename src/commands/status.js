import { NotInitialized, TaskStateError } from "../errors.js";
import { currentBranch, isRepo } from "../git.js";
import { listPruneCandidates, staleHint } from "../prune.js";
import { loadProfile, profileExists } from "../profile.js";
import { agitRoot } from "../root.js";
import { enrichTask } from "../taskinfo.js";
import { listTaskIds, loadTask, taskExists } from "../taskstore.js";
import { taskIdFromBranch } from "./commit.js";

function formatTask(data) {
  const tree = !data.path
    ? null
    : !data.worktree_exists
      ? "missing"
      : data.dirty
        ? "dirty"
        : "clean";

  return [
    `Task: ${data.task_id}`,
    `Branch: ${data.branch}`,
    `Status: ${data.status}`,
    data.path ? `Path: ${data.path}` : null,
    `Commits: ${data.commit_count}`,
    data.last_commit ? `Last commit: ${data.last_commit}` : null,
    data.age ? `Age: ${data.age}` : null,
    tree ? `Tree: ${tree}` : null,
    `Checks: ${data.checks.last_status ?? "not run yet"}`,
    `Pushed: ${data.pushed ? "yes" : "no"}`,
    `PR: ${data.pr_url ?? "not created"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function pad(value, width) {
  const text = String(value ?? "—");
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function treeLabel(task) {
  if (!task.worktree_exists) {
    return "gone";
  }
  return task.dirty ? "dirty" : "clean";
}

function formatTable(tasks) {
  const header = [
    pad("TASK", 16),
    pad("STATUS", 12),
    pad("BRANCH", 22),
    pad("COMMITS", 8),
    pad("AGE", 6),
    pad("TREE", 6),
    "PR",
  ].join("  ");

  const rows = tasks.map((task) =>
    [
      pad(task.task_id, 16),
      pad(task.status, 12),
      pad(task.branch, 22),
      pad(task.commit_count, 8),
      pad(task.age ?? "—", 6),
      pad(treeLabel(task), 6),
      task.pr_url ?? "—",
    ].join("  "),
  );

  return [header, ...rows].join("\n");
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
    const tasks = [];
    for (const id of listTaskIds(root)) {
      tasks.push(await enrichTask(root, loadTask(root, id), cwd));
    }
    const stale = await listPruneCandidates(root, profile);
    const hint = staleHint(stale.length);
    const body =
      tasks.length === 0
        ? "No agit tasks."
        : formatTable(tasks);

    return {
      tasks,
      stale_count: stale.length,
      message: hint ? `${body}\n\n${hint}` : body,
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

  const data = await enrichTask(root, loadTask(root, resolvedId), cwd);
  return {
    ...data,
    message: formatTask(data),
  };
}
