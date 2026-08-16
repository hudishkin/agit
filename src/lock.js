import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { TaskStateError } from "./errors.js";
import { resolveTasksDir } from "./taskstore.js";

export function acquireTaskLock(root, taskId) {
  const tasks = resolveTasksDir(root);
  const dir = join(tasks, `${taskId}.lock`);
  try {
    mkdirSync(tasks, { recursive: true });
    mkdirSync(dir);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new TaskStateError(
        `Task ${taskId} is already in use.`,
        "Wait for the other agit command to finish, then retry.",
      );
    }
    throw error;
  }

  return () => {
    try {
      rmdirSync(dir);
    } catch {
      // The lock is best-effort; a leftover dir is cleared by the next start.
    }
  };
}

export async function withTaskLock(root, taskId, fn) {
  const release = acquireTaskLock(root, taskId);
  try {
    return await fn();
  } finally {
    release();
  }
}
