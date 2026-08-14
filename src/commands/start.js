import { DirtyTree, NotInitialized, TaskStateError } from "../errors.js";
import {
  branchExists,
  checkout,
  createBranch,
  currentBranch,
  defaultBranch,
  fetch,
  isAncestor,
  isClean,
  isRepo,
  refExists,
  remoteUrl,
  revParse,
} from "../git.js";
import { isolationEnabled, syncMirror } from "../mirror.js";
import { loadProfile, profileExists } from "../profile.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

const PUBLISHED = new Set(["pushed", "pr_created"]);

function nextHint(taskId) {
  return [
    `Task started: ${taskId}`,
    `Work normally, but do not use git push directly.`,
    `When ready, run:`,
    `  agit commit -m "${taskId}: <summary>"`,
    `  agit finish ${taskId}`,
  ].join("\n");
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

export async function startCommand(cwd, taskId) {
  assertTaskId(taskId);

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

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

  if (taskExists(cwd, taskId)) {
    const task = loadTask(cwd, taskId);

    if (PUBLISHED.has(task.status)) {
      throw new TaskStateError(
        `Task ${taskId} is already published.`,
        "Continue on the task branch, or start a new task id.",
      );
    }

    const current = await currentBranch(cwd);
    if (current !== task.branch) {
      if (!(await isClean(cwd))) {
        throw new DirtyTree("Working tree is not clean.");
      }
      if (await branchExists(cwd, task.branch)) {
        await checkout(cwd, task.branch);
      } else {
        const { ref } = await resolveStartPoint(cwd, base, Boolean(url), { preferOrigin: isolated });
        await createBranch(cwd, task.branch, ref);
      }
    }

    const wasAborted = task.status === "aborted";
    if (wasAborted) {
      task.status = "started";
      saveTask(cwd, task);
    }

    return {
      task_id: taskId,
      branch: task.branch,
      base: task.base_ref,
      resumed: true,
      status: task.status,
      message: `${wasAborted ? "Restarted aborted" : "Resumed"} task ${taskId} on ${task.branch}.\n${nextHint(taskId)}`,
    };
  }

  if (!(await isClean(cwd))) {
    throw new DirtyTree("Working tree is not clean.");
  }

  const { ref: startPoint, note } = await resolveStartPoint(cwd, base, Boolean(url), {
    preferOrigin: isolated,
  });
  await createBranch(cwd, branch, startPoint);

  const task = {
    task_id: taskId,
    branch,
    base_ref: startPoint,
    base_sha: await revParse(cwd, "HEAD"),
    status: "started",
    created_at: new Date().toISOString(),
    commits: [],
    checks: { last_status: null },
    publish: { pushed: false, pushed_sha: null, pr_url: null },
  };
  saveTask(cwd, task);

  return {
    task_id: taskId,
    branch,
    base: startPoint,
    resumed: false,
    status: "started",
    message: [note, nextHint(taskId)].filter(Boolean).join("\n"),
  };
}
