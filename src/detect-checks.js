import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function detectChecks(cwd) {
  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    const pkg = readJson(packagePath);
    if (pkg?.scripts?.test) {
      return ["npm test"];
    }
    if (
      existsSync(join(cwd, "vitest.config.ts")) ||
      existsSync(join(cwd, "vitest.config.js")) ||
      existsSync(join(cwd, "vitest.config.mjs"))
    ) {
      return ["npx vitest run"];
    }
  }

  if (
    existsSync(join(cwd, "pytest.ini")) ||
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "setup.cfg")) ||
    existsSync(join(cwd, "setup.py"))
  ) {
    return ["pytest"];
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    return ["cargo test"];
  }

  if (existsSync(join(cwd, "go.mod"))) {
    return ["go test ./..."];
  }

  return [];
}
