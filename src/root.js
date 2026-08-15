import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gitCommonDir } from "./git.js";
import { WORKTREES_DIR } from "./paths.js";

function existingPath(path) {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export async function agitRoot(cwd) {
  const common = await gitCommonDir(cwd);
  return existingPath(dirname(common));
}

export function worktreeRelPath(taskId) {
  return `${WORKTREES_DIR}/${taskId}`;
}

export function worktreeAbsPath(root, taskId) {
  return resolve(existingPath(root), worktreeRelPath(taskId));
}

export function resolveTaskTree(root, task, cwd) {
  if (task?.worktree) {
    return resolve(existingPath(root), task.worktree);
  }
  return cwd;
}
