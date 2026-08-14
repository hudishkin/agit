import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER_END, MARKER_START } from "./paths.js";

const SECTION_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "agents-section.md");

export function loadAgentsSection() {
  return readFileSync(SECTION_PATH, "utf8").replace(/\s*$/, "\n");
}

export function mergeAgentsMd(existing, section = loadAgentsSection()) {
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MARKER_END.length).replace(/^\n/, "");
    return `${before}${section}${after ? `\n${after}` : ""}`.replace(/\n*$/, "\n");
  }

  if (!existing.trim()) {
    return section;
  }

  return `${existing.replace(/\n*$/, "\n")}\n${section}`;
}

export function writeAgentsMd(cwd, existing) {
  const path = join(cwd, "AGENTS.md");
  const current = existing ?? (existsSync(path) ? readFileSync(path, "utf8") : "");
  writeFileSync(path, mergeAgentsMd(current, loadAgentsSection()));
  return path;
}

export function writeMarkedFile(cwd, relativePath, section = loadAgentsSection()) {
  const path = join(cwd, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeAgentsMd(current, section));
  return path;
}
