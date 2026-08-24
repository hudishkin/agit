import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DirtyTree, TaskStateError } from "../errors.js";
import {
  checkout,
  currentBranch,
  deleteBranch,
  isClean,
  listLocalBranches,
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

export function orderBranchChoices(branches, preferred = []) {
  const available = new Set(branches);
  const seen = new Set();
  const head = [];
  for (const name of preferred.filter(Boolean)) {
    if (available.has(name) && !seen.has(name)) {
      seen.add(name);
      head.push(name);
    }
  }
  const rest = [...available].filter((name) => !seen.has(name)).sort();
  return [...head, ...rest];
}

export async function promptMergeBranch(
  branches,
  { stdin = process.stdin, stdout = process.stdout, taskId } = {},
) {
  const header = taskId ? `Merge ${taskId} into which branch?` : "Merge into which branch?";
  stdout.write(`${header}\n`);
  branches.forEach((name, index) => {
    stdout.write(`  ${index + 1}) ${name}\n`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Branch [1-${branches.length}]: `)).trim();
    const index = Number.parseInt(answer, 10);
    if (String(index) === answer && index >= 1 && index <= branches.length) {
      return branches[index - 1];
    }
    if (branches.includes(answer)) {
      return answer;
    }
    throw new TaskStateError(
      `Invalid branch choice: ${answer || "(empty)"}.`,
      `Pick a number 1-${branches.length}, or a branch name from the list.`,
    );
  } finally {
    rl.close();
  }
}

async function assertMergeBranch(root, name) {
  const local = localBranchFromRef(name) || name;
  if ((await refExists(root, local)) || (await refExists(root, `origin/${local}`))) {
    return local;
  }
  throw new TaskStateError(
    `Branch ${name} does not exist.`,
    "Pass a local branch name, or create it first.",
  );
}

async function resolveMergeTarget(
  root,
  task,
  profile,
  { merge, chooseBranch, interactive, stdin, stdout },
) {
  const named = typeof merge === "string" ? merge.trim() : "";
  if (named) {
    return assertMergeBranch(root, named);
  }

  const preferred = [localBranchFromRef(task.base_ref), profile.repo.default_branch];
  const available = (await listLocalBranches(root)).filter((name) => name !== task.branch);
  const branches = orderBranchChoices(available, preferred);
  if (branches.length === 0) {
    throw new TaskStateError(
      `No local branch to merge ${task.task_id} into.`,
      `Create the target branch, then run: agit done ${task.task_id} --merge <branch>`,
    );
  }

  if (chooseBranch) {
    return assertMergeBranch(root, await chooseBranch(branches));
  }

  if (!interactive) {
    throw new TaskStateError(
      "A merge target branch is required.",
      `Run: agit done ${task.task_id} --merge <branch>`,
    );
  }

  return assertMergeBranch(
    root,
    await promptMergeBranch(branches, { stdin, stdout, taskId: task.task_id }),
  );
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

async function mergeAndDone(store, root, profile, task, cwd, mergeOpts) {
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

  const target = await resolveMergeTarget(root, task, profile, mergeOpts);
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
  {
    inspectPr: inspect = inspectMergeRequest,
    merge = false,
    chooseBranch,
    interactive = Boolean(process.stdin.isTTY),
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
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
      return mergeAndDone(store, root, profile, task, cwd, {
        merge,
        chooseBranch,
        interactive,
        stdin,
        stdout,
      });
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
        `Run agit done ${taskId} --merge <branch> to land it on a local branch, or agit abort ${taskId} to drop it.`,
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
