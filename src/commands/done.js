import { existsSync } from "node:fs";
import { DirtyTree, TaskStateError } from "../errors.js";
import {
  checkout,
  createBranch,
  currentBranch,
  deleteBranch,
  isClean,
  localBranchFromRef,
  mergeBranch,
  refExists,
  removeWorktree,
} from "../git.js";
import { withTaskLock } from "../lock.js";
import { inspectMergeRequest } from "../prhost.js";
import { resolveTaskTree } from "../root.js";
import { loadWorkspace } from "../store.js";
import { assertTaskId, deleteTask, loadTask, taskExists } from "../taskstore.js";
import { commitIfDirty } from "./commit.js";

export function doneHint(taskId) {
  return `PR merged. Run: agit done ${taskId}`;
}

function isPublished(task) {
  return Boolean(task.publish?.pushed || task.status === "pr_created" || task.status === "pushed");
}

async function assertMergeBranch(root, name) {
  const local = localBranchFromRef(name) || name;
  if ((await refExists(root, local)) || (await refExists(root, `origin/${local}`))) {
    return local;
  }
  throw new TaskStateError(
    `Branch ${name} does not exist.`,
    "Pass a local branch name, or omit the name to create one from the task id.",
  );
}

async function mergeStartPoint(root, task, profile) {
  const candidates = [
    profile.repo.default_branch,
    `origin/${profile.repo.default_branch}`,
    task.base_ref,
    localBranchFromRef(task.base_ref),
  ].filter(Boolean);
  const seen = new Set();
  for (const ref of candidates) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    if (await refExists(root, ref)) {
      return ref;
    }
  }
  return null;
}

async function resolveMergeTarget(root, task, profile, merge) {
  const named = typeof merge === "string" ? merge.trim() : "";
  if (named) {
    return assertMergeBranch(root, named);
  }

  const name = task.task_id;
  if ((await refExists(root, name)) || (await refExists(root, `origin/${name}`))) {
    return name;
  }

  const startPoint = await mergeStartPoint(root, task, profile);
  if (!startPoint) {
    throw new TaskStateError(
      `Could not create branch ${name}.`,
      `Pass an existing branch: agit done ${task.task_id} --merge <branch>`,
    );
  }

  try {
    await createBranch(root, name, startPoint);
  } catch (error) {
    throw new TaskStateError(
      `Could not create branch ${name}.`,
      `Pass an existing branch: agit done ${task.task_id} --merge <branch>`,
      { error: error.message },
    );
  }
  return name;
}

async function ensureOnBranch(cwd, name) {
  if ((await currentBranch(cwd)) === name) {
    return;
  }

  try {
    await checkout(cwd, name);
  } catch (error) {
    throw new TaskStateError(
      `Could not check out ${name} to merge into.`,
      "Commit or stash changes on the main checkout, then retry.",
      { error: error.message },
    );
  }
}

async function cleanupTask(store, root, task, cwd) {
  const tree = resolveTaskTree(store, task, cwd);
  if (existsSync(tree) && tree !== root) {
    await removeWorktree(root, tree, { force: true });
  }
  await deleteBranch(root, task.branch);
  deleteTask(store.dir, task.task_id);
}

async function mergeAndDone(store, root, profile, task, cwd, merge) {
  if (isPublished(task)) {
    throw new TaskStateError(
      `Task ${task.task_id} was already published.`,
      task.publish?.pr_url
        ? `Merge the pull request on the host, then run agit done ${task.task_id}.`
        : `Run agit done ${task.task_id} to remove the local worktree. The remote branch is left in place.`,
    );
  }

  const tree = resolveTaskTree(store, task, cwd);
  if (existsSync(tree) && tree !== root) {
    await commitIfDirty(tree, task.task_id);
  }
  if (!(await isClean(root))) {
    throw new DirtyTree(
      "The main checkout is not clean.",
      "Commit or stash those changes, then retry.",
    );
  }

  const target = await resolveMergeTarget(root, task, profile, merge);
  await ensureOnBranch(root, target);

  const result = await mergeBranch(root, task.branch);
  if (!result.ok) {
    const files = result.files.length ? result.files.join(", ") : "unknown paths";
    throw new TaskStateError(
      `Could not merge ${task.branch} into ${target}.`,
      `Conflicts in ${files}. The main checkout is clean again. Fix the overlap, then retry.`,
      { conflicts: result.files, base: target, branch: task.branch },
    );
  }

  await cleanupTask(store, root, task, cwd);

  return {
    task_id: task.task_id,
    branch: task.branch,
    base: target,
    status: "done",
    message: `Done ${task.task_id}. Merged ${task.branch} into ${target}. Local worktree and branch removed. Remote was not changed.`,
  };
}

export async function doneCommand(
  cwd,
  taskId,
  { inspectPr: inspect = inspectMergeRequest, merge = false } = {},
) {
  assertTaskId(taskId);

  const { store, profile, root } = await loadWorkspace(cwd);
  const state = store.dir;
  if (!taskExists(state, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  return withTaskLock(state, taskId, async () => {
    const task = loadTask(state, taskId);
    if (merge) {
      return mergeAndDone(store, root, profile, task, cwd, merge);
    }

    const prUrl = task.publish?.pr_url ?? null;

    if (!prUrl) {
      if (task.publish?.pushed || task.status === "pushed") {
        await cleanupTask(store, root, task, cwd);
        return {
          task_id: taskId,
          branch: task.branch,
          pr_url: null,
          status: "done",
          message: `Done ${taskId}. Local worktree and branch removed. Remote was not changed.`,
        };
      }
      throw new TaskStateError(
        `Task ${taskId} was not published.`,
        `Run agit done ${taskId} --merge to land it on a local branch, or agit abort ${taskId} to drop it.`,
      );
    }

    const pr = await inspect(root, prUrl);
    if (!pr) {
      throw new TaskStateError(
        `Could not inspect the pull request for ${taskId}.`,
        "Install and authenticate the CLI for pr.provider, then retry.",
      );
    }
    if (!pr.merged) {
      throw new TaskStateError(
        "Pull request is not merged.",
        "Wait until it is merged, then run agit done again.",
        { pr_url: prUrl, state: pr.state },
      );
    }

    await cleanupTask(store, root, task, cwd);

    return {
      task_id: taskId,
      branch: task.branch,
      pr_url: prUrl,
      status: "done",
      message: `Done ${taskId}. Local worktree and branch removed. Remote was not changed.`,
    };
  });
}
