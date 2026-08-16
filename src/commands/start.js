import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NotInitialized, TaskStateError } from "../errors.js";
import {
  addWorktree,
  branchExists,
  defaultBranch,
  fetch,
  isAncestor,
  isRepo,
  refExists,
  remoteUrl,
  revParse,
} from "../git.js";
import { withTaskLock } from "../lock.js";
import { isolationEnabled, syncMirror } from "../mirror.js";
import { enforcementOf, loadProfile, profileExists } from "../profile.js";
import { agitRoot, resolveTaskTree, worktreeAbsPath, worktreeRelPath } from "../root.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

function nextHint(taskId, enforcement, path) {
  const work = path ? `Work in: ${path}` : null;
  if (enforcement === "remote") {
    return [
      `Task started: ${taskId}`,
      work,
      `Work with local git. Do not push.`,
      `A human publishes with:`,
      `  agit finish ${taskId}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `Task started: ${taskId}`,
    work,
    `Work normally, but do not use git push directly.`,
    `When ready, run:`,
    `  agit commit -m "${taskId}: <summary>"`,
    `  agit finish ${taskId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Prefer origin so a task never starts from a stale local base, but never drop
// local commits that were not pushed yet.
export async function resolveStartPoint(cwd, base, hasRemote, { preferOrigin = false } = {}) {
  const originRef = `origin/${base}`;
  const originExists = hasRemote ? await refExists(cwd, originRef) : false;
  const localExists = await refExists(cwd, base);

  if (!originExists && !localExists) {
    throw new TaskStateError(
      `Cannot resolve base branch ${base}.`,
      "Set repo.default_branch in .agit/profile.yml to a branch that exists.",
    );
  }

  if (originExists && (preferOrigin || !localExists)) {
    const note =
      preferOrigin && localExists && !(await isAncestor(cwd, base, originRef))
        ? `The local mirror is the source of truth; branching from origin/${base}.`
        : null;
    return { ref: originRef, note };
  }

  if (!originExists) {
    return { ref: base, note: hasRemote ? `origin/${base} not found; branching from local ${base}.` : null };
  }

  if (await isAncestor(cwd, base, originRef)) {
    return { ref: originRef, note: null };
  }

  if (await isAncestor(cwd, originRef, base)) {
    return { ref: base, note: `Local ${base} is ahead of origin/${base}; branching from local ${base}.` };
  }

  return { ref: base, note: `Local ${base} and origin/${base} have diverged; branching from local ${base}.` };
}

async function ensureTaskWorktree(root, task) {
  const tree = resolveTaskTree(root, task, worktreeAbsPath(root, task.task_id));
  if (existsSync(tree)) {
    return tree;
  }

  mkdirSync(dirname(tree), { recursive: true });
  if (await branchExists(root, task.branch)) {
    await addWorktree(root, tree, { startPoint: task.branch });
    return tree;
  }

  throw new TaskStateError(
    `Task ${task.task_id} has no worktree and branch ${task.branch} is missing.`,
    `Run agit start ${task.task_id} after restoring the branch, or start a new task id.`,
  );
}

function normalizeIssue(issue) {
  if (issue == null || issue === "") {
    return null;
  }
  const value = String(issue).replace(/^#/, "");
  if (!/^\d+$/.test(value)) {
    throw new TaskStateError(
      `Invalid issue: ${issue}`,
      "Pass a GitHub issue number, for example --issue 12.",
    );
  }
  return value;
}

function applyMetadata(task, { title, body, issue } = {}) {
  if (title != null) {
    task.title = title;
  }
  if (body != null) {
    task.body = body;
  }
  if (issue !== undefined) {
    task.issue = normalizeIssue(issue);
  }
  return task;
}

export async function startCommand(cwd, taskId, metadata = {}) {
  assertTaskId(taskId);

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const root = await agitRoot(cwd);
  const profile = loadProfile(cwd);
  const branch = `${profile.workflow.branch_prefix}${taskId}`;
  const base = profile.repo.default_branch ?? (await defaultBranch(cwd));
  const url = await remoteUrl(cwd);
  const isolated = await isolationEnabled(cwd);

  if (isolated) {
    await syncMirror(cwd, profile);
  } else if (url) {
    await fetch(cwd);
  }

  return withTaskLock(root, taskId, async () => {
    if (taskExists(root, taskId)) {
      const task = loadTask(root, taskId);
      const path = await ensureTaskWorktree(root, { ...task, worktree: task.worktree ?? worktreeRelPath(taskId) });
      if (!task.worktree) {
        task.worktree = worktreeRelPath(taskId);
      }

      const wasAborted = task.status === "aborted";
      if (wasAborted) {
        task.status = "started";
      }
      applyMetadata(task, metadata);
      saveTask(root, task);

      return {
        task_id: taskId,
        branch: task.branch,
        base: task.base_ref,
        path,
        resumed: true,
        status: task.status,
        message: `${wasAborted ? "Restarted aborted" : "Resumed"} task ${taskId} on ${task.branch}.\n${nextHint(taskId, enforcementOf(profile), path)}`,
      };
    }

    const { ref: startPoint, note } = await resolveStartPoint(root, base, Boolean(url), {
      preferOrigin: isolated,
    });

    const path = worktreeAbsPath(root, taskId);
    mkdirSync(dirname(path), { recursive: true });
    await addWorktree(root, path, { branch, startPoint });

    const task = applyMetadata(
      {
        task_id: taskId,
        branch,
        worktree: worktreeRelPath(taskId),
        base_ref: startPoint,
        base_sha: await revParse(path, "HEAD"),
        status: "started",
        created_at: new Date().toISOString(),
        commits: [],
        checks: { last_status: null },
        publish: { pushed: false, pushed_sha: null, pr_url: null },
      },
      metadata,
    );
    saveTask(root, task);

    return {
      task_id: taskId,
      branch,
      base: startPoint,
      path,
      resumed: false,
      status: "started",
      message: [note, nextHint(taskId, enforcementOf(profile), path)].filter(Boolean).join("\n"),
    };
  });
}
