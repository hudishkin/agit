import { existsSync } from "node:fs";
import { commitSubject, isClean, logOneline, refExists } from "./git.js";
import { resolveTaskTree } from "./root.js";

export function formatAge(createdAt, now = new Date()) {
  if (!createdAt) {
    return null;
  }

  const ms = now.getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "0m";
  }

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

export async function liveCommitCount(tree, task) {
  for (const base of [task.base_sha, task.base_ref]) {
    if (base && (await refExists(tree, base))) {
      return (await logOneline(tree, `${base}..HEAD`)).length;
    }
  }
  return task.commits?.length ?? 0;
}

export async function enrichTask(root, task, cwd) {
  const path = resolveTaskTree(root, task, cwd);
  const worktreeExists = Boolean(task.worktree && path && existsSync(path));
  let dirty = null;
  let lastCommit = null;
  let commitCount = task.commits?.length ?? 0;

  if (worktreeExists) {
    dirty = !(await isClean(path));
    lastCommit = await commitSubject(path).catch(() => null);
    commitCount = await liveCommitCount(path, task);
  }

  return {
    task_id: task.task_id,
    branch: task.branch,
    status: task.status,
    path: task.worktree ? path : null,
    commits: task.commits ?? [],
    commit_count: commitCount,
    last_commit: lastCommit,
    created_at: task.created_at ?? null,
    age: formatAge(task.created_at),
    dirty,
    worktree_exists: worktreeExists,
    checks: task.checks ?? { last_status: null },
    pushed: Boolean(task.publish?.pushed),
    pr_url: task.publish?.pr_url ?? null,
  };
}
