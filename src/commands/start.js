import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DirtyTree, TaskStateError } from "../errors.js";
import { ensureGitignore } from "../gitignore.js";
import {
  addWorktree,
  branchExists,
  defaultBranch,
  fetch,
  isAncestor,
  isClean,
  refExists,
  remoteUrl,
  revParse,
} from "../git.js";
import { withTaskLock } from "../lock.js";
import { enableIsolation, inspectIsolation, syncMirror } from "../mirror.js";
import { enforcementOf, sandboxOf } from "../profile.js";
import { resolveTaskTree, worktreeAbsPath, worktreeRelPath } from "../root.js";
import { applySandbox, lockWorktreeCredentials } from "../sandbox.js";
import { loadWorkspace } from "../store.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

function nextHint(taskId, enforcement, path, sandbox = "off") {
  const work = path ? `Work in: ${path}` : null;
  const sandboxLine =
    sandbox === "agents"
      ? "Agent sandbox configs written. Origin is the local mirror. Worktree git credentials are locked."
      : null;
  if (enforcement === "remote") {
    return [
      `Task started: ${taskId}`,
      work,
      sandboxLine,
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
    sandboxLine,
    `Work normally, but do not use git push directly.`,
    `When ready, run:`,
    `  agit commit -m "${taskId}: <summary>"`,
    `  agit finish ${taskId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function withSandbox(result, profile) {
  const files = applySandbox(result.path, profile);
  if (sandboxOf(profile) !== "agents") {
    return result;
  }
  await lockWorktreeCredentials(result.path);
  return {
    ...result,
    sandbox: "agents",
    sandbox_files: files,
  };
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

async function ensureTaskWorktree(store, task) {
  const tree = resolveTaskTree(store, task, worktreeAbsPath(store, task.task_id));
  if (existsSync(tree)) {
    return tree;
  }

  mkdirSync(dirname(tree), { recursive: true });
  if (await branchExists(store.root, task.branch)) {
    await addWorktree(store.root, tree, { startPoint: task.branch });
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

  const { store, profile, root } = await loadWorkspace(cwd);
  const state = store.dir;
  const branch = `${profile.workflow.branch_prefix}${taskId}`;
  const base = profile.repo.default_branch ?? (await defaultBranch(cwd));
  const url = await remoteUrl(cwd);
  let isolated = (await inspectIsolation(cwd, profile)).isolated;

  if (sandboxOf(profile) === "agents" && !isolated) {
    try {
      await enableIsolation(cwd, profile);
      if (store.kind === "repo") {
        ensureGitignore(store.root);
      }
      isolated = true;
    } catch (error) {
      throw new TaskStateError(
        error.message,
        "sandbox=agents needs an origin remote so agit can isolate this clone.",
      );
    }
  } else if (isolated) {
    await syncMirror(cwd, profile);
  } else if (url) {
    await fetch(cwd);
  }

  return withTaskLock(state, taskId, async () => {
    if (taskExists(state, taskId)) {
      const task = loadTask(state, taskId);
      const intended = worktreeAbsPath(store, taskId);
      if (!existsSync(intended) && !(await branchExists(root, task.branch))) {
        const { ref: startPoint, note } = await resolveStartPoint(root, base, Boolean(url), {
          preferOrigin: isolated,
        });
        mkdirSync(dirname(intended), { recursive: true });
        await addWorktree(root, intended, { branch: task.branch, startPoint });
        task.worktree = worktreeRelPath(taskId, store);
        task.base_ref = startPoint;
        task.base_sha = await revParse(intended, "HEAD");
        task.commits = [];
        task.status = "started";
        saveTask(state, task);
        return await withSandbox(
          {
            task_id: taskId,
            branch: task.branch,
            base: startPoint,
            path: intended,
            resumed: true,
            status: task.status,
            message: [`Restarted aborted task ${taskId} on ${task.branch}.`, note, nextHint(taskId, enforcementOf(profile), intended, sandboxOf(profile))]
              .filter(Boolean)
              .join("\n"),
          },
          profile,
        );
      }

      const path = await ensureTaskWorktree(store, { ...task, worktree: task.worktree ?? worktreeRelPath(taskId, store) });
      if (!task.worktree) {
        task.worktree = worktreeRelPath(taskId, store);
      }

      const wasAborted = task.status === "aborted";
      if (wasAborted) {
        task.status = "started";
      }
      applyMetadata(task, metadata);
      saveTask(state, task);

      return await withSandbox(
        {
          task_id: taskId,
          branch: task.branch,
          base: task.base_ref,
          path,
          resumed: true,
          status: task.status,
          message: `${wasAborted ? "Restarted aborted" : "Resumed"} task ${taskId} on ${task.branch}.\n${nextHint(taskId, enforcementOf(profile), path, sandboxOf(profile))}`,
        },
        profile,
      );
    }

    if (profile.workflow.require_clean_tree_on_start && !(await isClean(root))) {
      throw new DirtyTree(
        "The main checkout is not clean.",
        "Commit or stash those changes, or set workflow.require_clean_tree_on_start: false.",
      );
    }

    const { ref: startPoint, note } = await resolveStartPoint(root, base, Boolean(url), {
      preferOrigin: isolated,
    });

    const path = worktreeAbsPath(store, taskId);
    mkdirSync(dirname(path), { recursive: true });
    await addWorktree(root, path, { branch, startPoint });

    const task = applyMetadata(
      {
        task_id: taskId,
        branch,
        worktree: worktreeRelPath(taskId, store),
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
    saveTask(state, task);

    return await withSandbox(
      {
        task_id: taskId,
        branch,
        base: startPoint,
        path,
        resumed: false,
        status: "started",
        message: [note, nextHint(taskId, enforcementOf(profile), path, sandboxOf(profile))].filter(Boolean).join("\n"),
      },
      profile,
    );
  });
}
