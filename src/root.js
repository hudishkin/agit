import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitCommonDir } from "./git.js";
import { WORKTREES_DIR } from "./paths.js";

function existingPath(path) {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export function asStore(rootOrStore) {
  if (rootOrStore && typeof rootOrStore === "object" && rootOrStore.dir && rootOrStore.root) {
    return rootOrStore;
  }
  return { kind: "repo", root: rootOrStore, dir: join(rootOrStore, ".agit"), project: null };
}

export async function agitRoot(cwd) {
  const common = await gitCommonDir(cwd);
  return existingPath(dirname(common));
}

export function worktreeRelPath(taskId, store) {
  if (store?.kind === "home") {
    return `worktrees/${taskId}`;
  }
  return `${WORKTREES_DIR}/${taskId}`;
}

export function worktreeAbsPath(rootOrStore, taskId) {
  const store = asStore(rootOrStore);
  if (store.kind === "home") {
    return resolve(existingPath(store.dir), "worktrees", taskId);
  }
  return resolve(existingPath(store.root), WORKTREES_DIR, taskId);
}

export function resolveTaskTree(rootOrStore, task, cwd) {
  if (!task?.worktree) {
    return cwd;
  }
  if (isAbsolute(task.worktree)) {
    return existingPath(task.worktree);
  }
  const store = asStore(rootOrStore);
  if (task.worktree.startsWith(".agit/")) {
    return resolve(existingPath(store.root), task.worktree);
  }
  return resolve(existingPath(store.dir), task.worktree);
}
