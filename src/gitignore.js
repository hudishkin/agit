import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITIGNORE_ENTRIES } from "./paths.js";

export function ensureGitignore(cwd, entries = GITIGNORE_ENTRIES) {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const added = entries.filter((entry) => !present.has(entry));

  if (added.length === 0) {
    return { path, added };
  }

  let text = existing;
  if (text && !text.endsWith("\n")) {
    text += "\n";
  }
  writeFileSync(path, `${text}${added.join("\n")}\n`);
  return { path, added };
}
