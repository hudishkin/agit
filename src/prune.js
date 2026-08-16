import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectMergeRequest } from "./prhost.js";
import { branchExists, currentBranch, deleteBranch, isClean, removeWorktree } from "./git.js";
import { WORKTREES_DIR } from "./paths.js";
import { worktreeAbsPath } from "./root.js";
import { liveCommitCount } from "./taskinfo.js";
import { deleteTask, listTaskIds, loadTask, taskExists } from "./taskstore.js";

export const DEFAULT_PRUNE_AFTER_DAYS = 14;

function pruneAfterDays(profile) {
  const value = Number(profile?.workflow?.prune_after_days);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRUNE_AFTER_DAYS;
}

function isPublishedOpen(task) {
  return Boolean(task.publish?.pushed) && task.status !== "aborted";
}

function ageDays(createdAt, now) {
  if (!createdAt) {
    return 0;
  }
  const ms = now.getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return 0;
  }
  return ms / 86_400_000;
}

async function taskCommitCount(root, task) {
  const tree = task.worktree ? worktreeAbsPath(root, task.task_id) : null;
  if (tree && existsSync(tree)) {
    return liveCommitCount(tree, task);
  }
  return task.commits?.length ?? 0;
}

export async function classifyPruneReason(root, task, { maxAgeDays, now, inspectPr: inspect = inspectMergeRequest }) {
  if (task.status === "aborted") {
    return "aborted";
  }

  if (isPublishedOpen(task) && task.publish?.pr_url) {
    const pr = await inspect(root, task.publish.pr_url);
    if (pr?.merged) {
      return "merged";
    }
    return null;
  }

  if (isPublishedOpen(task)) {
    return null;
  }

  const commits = await taskCommitCount(root, task);
  if (commits === 0 && ageDays(task.created_at, now) >= maxAgeDays) {
    return "empty_old";
  }

  return null;
}

export async function listOrphanWorktrees(root) {
  const dir = join(root, WORKTREES_DIR);
  if (!existsSync(dir)) {
    return [];
  }

  const orphans = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || taskExists(root, entry.name)) {
      continue;
    }
    const path = worktreeAbsPath(root, entry.name);
    const branch = existsSync(path) ? await currentBranch(path).catch(() => null) : null;
    orphans.push({
      task_id: entry.name,
      reason: "orphan_worktree",
      branch,
      path,
      status: null,
    });
  }
  return orphans;
}

export async function listPruneCandidates(root, profile, { inspectPr: inspect = inspectMergeRequest, now = new Date() } = {}) {
  const maxAgeDays = pruneAfterDays(profile);
  const candidates = [];

  for (const id of listTaskIds(root)) {
    const task = loadTask(root, id);
    const reason = await classifyPruneReason(root, task, { maxAgeDays, now, inspectPr: inspect });
    if (!reason) {
      continue;
    }
    candidates.push({
      task_id: id,
      reason,
      branch: task.branch ?? null,
      path: task.worktree ? worktreeAbsPath(root, id) : null,
      status: task.status,
    });
  }

  candidates.push(...(await listOrphanWorktrees(root)));
  return candidates;
}

export function staleHint(count) {
  if (count <= 0) {
    return null;
  }
  const noun = count === 1 ? "stale task" : "stale tasks";
  return `${count} ${noun}. Run: agit prune`;
}

async function removeCandidate(root, candidate) {
  const tree = candidate.path;
  if (tree && existsSync(tree)) {
    const dirty = !(await isClean(tree));
    if (dirty && candidate.reason === "empty_old") {
      return { ...candidate, skipped: "dirty" };
    }
    await removeWorktree(root, tree, { force: candidate.reason !== "empty_old" || dirty });
  }

  if (candidate.branch && (await branchExists(root, candidate.branch))) {
    await deleteBranch(root, candidate.branch);
  }

  if (taskExists(root, candidate.task_id)) {
    deleteTask(root, candidate.task_id);
  }

  return { ...candidate, removed: true };
}

export async function applyPrune(root, candidates) {
  const results = [];
  for (const candidate of candidates) {
    results.push(await removeCandidate(root, candidate));
  }
  return results;
}
