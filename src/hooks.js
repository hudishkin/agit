import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hooksPath } from "./git.js";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "pre-push.sh");

export const HOOK_MARKER = "agit:pre-push";

export async function hookPath(cwd) {
  return join(await hooksPath(cwd), "pre-push");
}

export async function hooksInstalled(cwd) {
  const path = await hookPath(cwd);
  if (!existsSync(path)) {
    return false;
  }
  return readFileSync(path, "utf8").includes(HOOK_MARKER);
}

function backupPath(path) {
  let candidate = `${path}.agit-backup`;
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.agit-backup.${counter}`;
    counter += 1;
  }
  return candidate;
}

export async function installHooks(cwd, profile) {
  const path = await hookPath(cwd);
  mkdirSync(dirname(path), { recursive: true });

  let backup = null;
  if (existsSync(path) && !readFileSync(path, "utf8").includes(HOOK_MARKER)) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }

  const body = readFileSync(TEMPLATE_PATH, "utf8").replaceAll(
    "{{DEFAULT_BRANCH}}",
    profile?.repo?.default_branch ?? "main",
  );
  writeFileSync(path, body);
  chmodSync(path, 0o755);

  return { path, backup };
}
