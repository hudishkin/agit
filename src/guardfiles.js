import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgitError } from "./errors.js";

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

function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

function parseJsonObject(text) {
  const stripped = stripJsonComments(text);
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  return parsed;
}

function readJson(path, { required = false } = {}) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return parseJsonObject(readFileSync(path, "utf8"));
  } catch {
    if (required) {
      throw new AgitError({
        code: "error",
        message: `Cannot parse ${path}.`,
        hint: "Fix the JSON (comments are ok) and retry. agit will not overwrite a file it cannot read.",
      });
    }
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
  const config = readJson(path, { required: true });
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
  const config = readJson(path, { required: true });
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
