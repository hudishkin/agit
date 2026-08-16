import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { TaskStateError } from "./errors.js";
import { TASKS_DIR, TASK_ID_PATTERN } from "./paths.js";

export function resolveTasksDir(cwd) {
  const storeMarker = existsSync(join(cwd, "profile.yml")) || existsSync(join(cwd, "source.yml"));
  if (storeMarker && !existsSync(join(cwd, ".agit", "profile.yml"))) {
    return join(cwd, "tasks");
  }
  return join(cwd, TASKS_DIR);
}

export function assertTaskId(taskId) {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new TaskStateError(
      `Invalid task id: ${taskId}`,
      "Use letters, numbers, dots, underscores, or dashes. Do not use '/'.",
    );
  }
}

export function taskPath(cwd, taskId) {
  assertTaskId(taskId);
  return join(resolveTasksDir(cwd), `${taskId}.yml`);
}

export function taskExists(cwd, taskId) {
  return existsSync(taskPath(cwd, taskId));
}

export function loadTask(cwd, taskId) {
  return yaml.load(readFileSync(taskPath(cwd, taskId), "utf8"));
}

export function saveTask(cwd, task) {
  assertTaskId(task.task_id);
  const path = taskPath(cwd, task.task_id);
  mkdirSync(resolveTasksDir(cwd), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yaml.dump(task, { lineWidth: 120, noRefs: true }));
  renameSync(tmp, path);
}

export function deleteTask(cwd, taskId) {
  rmSync(taskPath(cwd, taskId), { force: true });
}

export function listTaskIds(root) {
  const dir = resolveTasksDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => name.slice(0, -".yml".length))
    .sort();
}
