import { findDeniedFiles } from "../denylist.js";
import { DenylistHit, EmptyCommit, NotInitialized, WrongBranch } from "../errors.js";
import { add, commit, currentBranch, isRepo, listCommitCandidates } from "../git.js";
import { loadProfile, profileExists } from "../profile.js";
import { agitRoot } from "../root.js";
import { scanFilesForSecrets } from "../secretscan.js";
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
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  if (!message?.trim()) {
    throw new EmptyCommit("Commit message is required.", 'Run: agit commit -m "<task-id>: <summary>"');
  }

  const root = await agitRoot(cwd);
  const profile = loadProfile(cwd);
  const branch = await currentBranch(cwd);

  if (branch === profile.repo.default_branch) {
    throw new WrongBranch(`Refusing to commit on ${branch}.`);
  }

  const taskId = taskIdFromBranch(branch, profile.workflow.branch_prefix);
  if (!taskId || !taskExists(root, taskId)) {
    throw new WrongBranch(`No agit task for branch ${branch}.`, "Run agit start <task-id> first.");
  }

  const task = loadTask(root, taskId);
  if (task.branch !== branch) {
    throw new WrongBranch(`Current branch ${branch} does not match task ${taskId}.`);
  }

  const candidates = await listCommitCandidates(cwd);
  if (candidates.length === 0) {
    throw new EmptyCommit();
  }

  const files = resolveFiles(candidates, requested, profile.commit.scope);

  const denied = findDeniedFiles(files, profile.commit.denylist, profile.commit.allowlist);
  if (denied.length > 0) {
    throw new DenylistHit(
      "Refusing to commit denied files.",
      "Remove secret files from the change set and retry.",
      { files: denied },
    );
  }

  if (profile.commit.scan_contents !== false) {
    const secrets = scanFilesForSecrets(cwd, files);
    if (secrets.length > 0) {
      throw new DenylistHit(
        "Refusing to commit files that look like they contain secrets.",
        "Move the credential to an environment variable or a secret store, then retry.",
        { secrets },
      );
    }
  }

  await add(cwd, files);
  const hash = await commit(cwd, message, files);
  task.commits = [...(task.commits ?? []), hash];
  task.status = "committed";
  saveTask(root, task);

  return {
    task_id: taskId,
    branch,
    files,
    commit: hash,
    message: `Committed ${hash.slice(0, 7)}\nFiles:\n${files.map((file) => `- ${file}`).join("\n")}`,
  };
}
