import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AgitError } from "./errors.js";

export const SKILL_EDITORS = ["cursor", "claude"];
export const SKILL_SCOPES = ["local", "global"];

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function packagedSkillPath() {
  return join(PACKAGE_ROOT, "AGIT.md");
}

export function parseEditors(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === "both" || raw === "all") {
    return [...SKILL_EDITORS];
  }
  if (SKILL_EDITORS.includes(raw)) {
    return [raw];
  }
  throw new AgitError({
    code: "error",
    message: `Unknown editor: ${value}`,
    hint: "Use --editor cursor, claude, or both.",
  });
}

export function parseScope(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const raw = String(value).trim().toLowerCase();
  if (SKILL_SCOPES.includes(raw)) {
    return raw;
  }
  throw new AgitError({
    code: "error",
    message: `Unknown skill location: ${value}`,
    hint: "Use --skills local or --skills global.",
  });
}

export function skillFilePath({ editor, scope, cwd, homeDir }) {
  const root = scope === "global" ? homeDir : cwd;
  if (editor === "cursor") {
    return join(root, ".cursor", "skills", "agit", "SKILL.md");
  }
  return join(root, ".claude", "skills", "agit", "SKILL.md");
}

function parseEditorAnswer(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === "1" || value === "cursor") {
    return ["cursor"];
  }
  if (value === "2" || value === "claude" || value === "claude code") {
    return ["claude"];
  }
  if (value === "3" || value === "both" || value === "all") {
    return [...SKILL_EDITORS];
  }
  if (value === "4" || value === "skip" || value === "none" || value === "n" || value === "s" || value === "") {
    return null;
  }
  throw new AgitError({
    code: "error",
    message: `Unknown editor: ${raw}`,
    hint: "Choose 1-4, or cursor, claude, both, skip.",
  });
}

function parseScopeAnswer(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === "1" || value === "global" || value === "g") {
    return "global";
  }
  if (value === "2" || value === "local" || value === "l") {
    return "local";
  }
  throw new AgitError({
    code: "error",
    message: `Unknown skill location: ${raw}`,
    hint: "Choose 1-2, or global, local.",
  });
}

export async function promptSkillInstall({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY) {
    throw new AgitError({
      code: "error",
      message: "Non-interactive init requires --yes.",
      hint: "Run: agit init --yes [--editor cursor|claude|both --skills local|global] [--finish ask|human|agent]",
    });
  }

  const rl = createInterface({ input, output });
  try {
    output.write("Install the agit skill for which editor?\n");
    output.write("  1) Cursor\n");
    output.write("  2) Claude Code\n");
    output.write("  3) Both\n");
    output.write("  4) Skip\n");
    const editors = parseEditorAnswer(await rl.question("Editor [1-4]: "));
    if (!editors) {
      return { skipped: true, reason: "declined" };
    }

    output.write("Install the skill where?\n");
    output.write("  1) Global (this machine)\n");
    output.write("  2) Local (this repository)\n");
    const scope = parseScopeAnswer(await rl.question("Location [1-2]: "));
    return { skipped: false, editors, scope };
  } finally {
    rl.close();
  }
}

export async function resolveSkillChoice(options, { prompt = promptSkillInstall } = {}) {
  const hasEditor = options.editor != null && String(options.editor).trim() !== "";
  const hasScope = typeof options.skills === "string" && options.skills.trim() !== "";

  if (hasEditor && hasScope) {
    return {
      skipped: false,
      editors: parseEditors(options.editor),
      scope: parseScope(options.skills),
      source: "flags",
    };
  }

  if (hasEditor || hasScope) {
    throw new AgitError({
      code: "error",
      message: "Skill install requires both --editor and --skills.",
      hint: "Run: agit init --yes --editor cursor --skills global",
    });
  }

  if (options.yes) {
    return { skipped: true, reason: "not_requested", source: "flags" };
  }

  const answered = await prompt();
  return { ...answered, source: "prompt" };
}

export function installSkills({
  cwd,
  editors,
  scope,
  homeDir = osHomedir(),
  source = packagedSkillPath(),
}) {
  const body = readFileSync(source, "utf8");
  const files = [];
  for (const editor of editors) {
    const path = skillFilePath({ editor, scope, cwd, homeDir });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    files.push(path);
  }
  return { skipped: false, editors, scope, files };
}
