import { DirtyTree, EmptyCommit, WrongBranch } from "../errors.js";
import { add, commit, currentBranch, isClean, listCommitCandidates } from "../git.js";
import { loadWorkspace } from "../store.js";
import { loadTask, saveTask, taskExists } from "../taskstore.js";

export function taskIdFromBranch(branch, prefix) {
  if (!branch.startsWith(prefix)) {
    return null;
  }
  return branch.slice(prefix.length) || null;
}

function resolveFiles(candidates, requested, scope) {
  if (requested?.length) {
    const unknown = requested.filter((file) => !candidates.includes(file));
    if (unknown.length > 0) {
      throw new EmptyCommit(
        `No changes for: ${unknown.join(", ")}`,
        "Pass paths that actually changed, or run agit status.",
      );
    }
    return [...new Set(requested)].sort();
  }

  if (scope === "explicit") {
    throw new EmptyCommit(
      "This repository requires an explicit file list.",
      'Run: agit commit -m "<task-id>: <summary>" --files <path> [<path>...]',
    );
  }

  return candidates;
}

export async function commitCommand(cwd, message, { files: requested } = {}) {
  const { store, profile } = await loadWorkspace(cwd);
  const state = store.dir;

  if (!message?.trim()) {
    throw new EmptyCommit("Commit message is required.", 'Run: agit commit -m "<task-id>: <summary>"');
  }
  const branch = await currentBranch(cwd);

  if (branch === profile.repo.default_branch) {
    throw new WrongBranch(`Refusing to commit on ${branch}.`);
  }

  const taskId = taskIdFromBranch(branch, profile.workflow.branch_prefix);
  if (!taskId || !taskExists(state, taskId)) {
    throw new WrongBranch(`No agit task for branch ${branch}.`, "Run agit start <task-id> first.");
  }

  const task = loadTask(state, taskId);
  if (task.branch !== branch) {
    throw new WrongBranch(`Current branch ${branch} does not match task ${taskId}.`);
  }

  const candidates = await listCommitCandidates(cwd);
  if (candidates.length === 0) {
    throw new EmptyCommit();
  }

  const files = resolveFiles(candidates, requested, profile.commit.scope);

  await add(cwd, files);
  const hash = await commit(cwd, message, files);
  task.commits = [...(task.commits ?? []), hash];
  task.status = "committed";
  saveTask(state, task);

  return {
    task_id: taskId,
    branch,
    files,
    commit: hash,
    message: `Committed ${hash.slice(0, 7)}\nFiles:\n${files.map((file) => `- ${file}`).join("\n")}`,
  };
}

export function pendingCommitMessage(taskId, files) {
  if (files.length === 1) {
    return `${taskId}: update ${files[0]}`;
  }
  return `${taskId}: update ${files.length} files`;
}

export async function commitIfDirty(cwd, taskId) {
  if (await isClean(cwd)) {
    return null;
  }

  const files = await listCommitCandidates(cwd);
  if (files.length === 0) {
    throw new DirtyTree("Working tree is not clean.");
  }

  return commitCommand(cwd, pendingCommitMessage(taskId, files), { files });
}
