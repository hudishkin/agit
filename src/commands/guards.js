import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAgentsSection, mergeAgentsMd, writeMarkedFile } from "../agentsmd.js";
import {
  CLAUDE_GUARD_SCRIPT,
  CURSOR_GUARD_SCRIPT,
  writeClaudeSettings,
  writeCursorHooks,
  writeGuardScript,
} from "../guardfiles.js";
import { enforcementOf, loadProfile, profileExists } from "../profile.js";

function enforcementFor(cwd, override) {
  if (override) {
    return override;
  }
  if (!profileExists(cwd)) {
    return "protocol";
  }
  return enforcementOf(loadProfile(cwd));
}

const CURSOR_RULE = ".cursor/rules/agit.mdc";
const CLAUDE_FILE = "CLAUDE.md";
const COPILOT_FILE = ".github/copilot-instructions.md";

function writeCursorRule(cwd, section, enforcement) {
  const path = join(cwd, CURSOR_RULE);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(dirname(path), { recursive: true });
  if (!existing.trim()) {
    const description =
      enforcement === "remote" ? "Local git is allowed; do not publish" : "Use agit for Git task workflow";
    writeFileSync(path, `---\ndescription: ${description}\nalwaysApply: true\n---\n\n${section}`);
    return path;
  }
  writeFileSync(path, mergeAgentsMd(existing, section));
  return path;
}

export async function installAgentGuardsCommand(cwd, options = {}) {
  const none = !options.claude && !options.cursor && !options.copilot;
  const want = {
    claude: none || Boolean(options.claude),
    cursor: none || Boolean(options.cursor),
    copilot: none || Boolean(options.copilot),
  };
  const enforcement = enforcementFor(cwd, options.enforcement);
  const section = loadAgentsSection(enforcement);

  const files = [];
  const guards = [];

  if (want.claude) {
    files.push(writeMarkedFile(cwd, CLAUDE_FILE, section));
    guards.push(writeGuardScript(cwd, CLAUDE_GUARD_SCRIPT, "claude"));
    guards.push(writeClaudeSettings(cwd, { enforcement }));
  }
  if (want.cursor) {
    files.push(writeCursorRule(cwd, section, enforcement));
    guards.push(writeGuardScript(cwd, CURSOR_GUARD_SCRIPT, "cursor"));
    guards.push(writeCursorHooks(cwd));
  }
  if (want.copilot) {
    files.push(writeMarkedFile(cwd, COPILOT_FILE, section));
  }

  const lines = [
    guards.length ? `Installed tool-call guards:\n${guards.map((file) => `- ${file}`).join("\n")}` : null,
    files.length ? `Wrote agent instructions:\n${files.map((file) => `- ${file}`).join("\n")}` : null,
  ].filter(Boolean);

  return {
    files,
    guards,
    message: lines.join("\n"),
  };
}
