import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

export function writeSetupAgent(cwd) {
  const path = join(cwd, ".agit", "setup-agent.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(join(TEMPLATES, "setup-agent.sh"), "utf8"));
  chmodSync(path, 0o755);
  return path;
}

export function writePrTemplate(cwd) {
  const path = join(cwd, ".github", "pull_request_template.md");
  if (existsSync(path)) {
    return { path, written: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(join(TEMPLATES, "pull_request_template.md"), "utf8"));
  return { path, written: true };
}
