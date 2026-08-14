import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "agit-guard.sh");

export const CURSOR_HOOKS_FILE = ".cursor/hooks.json";
export const CURSOR_GUARD_SCRIPT = ".cursor/hooks/agit-guard.sh";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CLAUDE_GUARD_SCRIPT = ".claude/hooks/agit-guard.sh";

export const CURSOR_HOOK_COMMAND = `./${CURSOR_GUARD_SCRIPT}`;
export const CLAUDE_HOOK_COMMAND = `$CLAUDE_PROJECT_DIR/${CLAUDE_GUARD_SCRIPT}`;

export const CLAUDE_DENY_RULES = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git reset:*)",
  "Bash(git rebase:*)",
  "Bash(git merge:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git cherry-pick:*)",
  "Bash(git revert:*)",
  "Bash(git stash:*)",
  "Bash(git clean:*)",
  "Bash(git pull:*)",
];

const FALLBACKS = {
  cursor: `printf '%s\\n' '{"permission": "allow"}'`,
  claude: ": # no decision; the normal permission flow applies",
};

function readJson(path) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function writeGuardScript(cwd, relativePath, vendor) {
  const path = join(cwd, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const body = readFileSync(TEMPLATE_PATH, "utf8")
    .replaceAll("{{VENDOR}}", vendor)
    .replaceAll("{{FALLBACK}}", FALLBACKS[vendor]);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

export function writeCursorHooks(cwd) {
  const path = join(cwd, CURSOR_HOOKS_FILE);
  const config = readJson(path);
  config.version = config.version ?? 1;
  config.hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};

  const entry = { command: CURSOR_HOOK_COMMAND, matcher: "git|gh", failClosed: true };
  const list = asArray(config.hooks.beforeShellExecution);
  const index = list.findIndex((item) => item?.command === CURSOR_HOOK_COMMAND);
  if (index === -1) {
    list.push(entry);
  } else {
    list[index] = { ...list[index], ...entry };
  }
  config.hooks.beforeShellExecution = list;

  writeJson(path, config);
  return path;
}

export function writeClaudeSettings(cwd) {
  const path = join(cwd, CLAUDE_SETTINGS_FILE);
  const config = readJson(path);
  config.hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};

  const groups = asArray(config.hooks.PreToolUse);
  let group = groups.find((item) => item?.matcher === "Bash");
  if (!group) {
    group = { matcher: "Bash", hooks: [] };
    groups.push(group);
  }
  group.hooks = asArray(group.hooks);
  if (!group.hooks.some((item) => item?.command === CLAUDE_HOOK_COMMAND)) {
    group.hooks.push({ type: "command", command: CLAUDE_HOOK_COMMAND });
  }
  config.hooks.PreToolUse = groups;

  config.permissions = config.permissions && typeof config.permissions === "object" ? config.permissions : {};
  const deny = asArray(config.permissions.deny);
  for (const rule of CLAUDE_DENY_RULES) {
    if (!deny.includes(rule)) {
      deny.push(rule);
    }
  }
  config.permissions.deny = deny;

  writeJson(path, config);
  return path;
}

export function readGuardConfig(cwd, vendor) {
  const file = vendor === "claude" ? CLAUDE_SETTINGS_FILE : CURSOR_HOOKS_FILE;
  const path = join(cwd, file);
  return { path, exists: existsSync(path), config: readJson(path) };
}
