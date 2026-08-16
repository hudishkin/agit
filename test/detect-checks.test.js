import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { detectChecks } from "../src/detect-checks.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dir() {
  const path = mkdtempSync(join(tmpdir(), "agit-detect-"));
  dirs.push(path);
  return path;
}

describe("detectChecks", () => {
  test("uses package.json scripts.test", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.deepEqual(detectChecks(cwd), ["npm test"]);
  });

  test("detects pytest, cargo, and go", () => {
    const py = dir();
    writeFileSync(join(py, "pyproject.toml"), "[project]\nname = 'x'\n");
    assert.deepEqual(detectChecks(py), ["pytest"]);

    const rust = dir();
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = 'x'\n");
    assert.deepEqual(detectChecks(rust), ["cargo test"]);

    const go = dir();
    writeFileSync(join(go, "go.mod"), "module example.com/x\n");
    assert.deepEqual(detectChecks(go), ["go test ./..."]);
  });

  test("returns nothing when there is no test runner", () => {
    assert.deepEqual(detectChecks(dir()), []);
  });

  test("detects vitest when package.json has no test script", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(cwd, "vitest.config.js"), "export default {}\n");
    assert.deepEqual(detectChecks(cwd), ["npx vitest run"]);
  });

  test("ignores a broken package.json and keeps looking", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "package.json"), "{ not json");
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'x'\n");
    assert.deepEqual(detectChecks(cwd), ["pytest"]);
  });

  test("prefers package.json scripts.test over pytest", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'x'\n");
    assert.deepEqual(detectChecks(cwd), ["npm test"]);
  });

  test("falls through to pytest when package.json has no test script", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(cwd, "setup.py"), "from setuptools import setup\n");
    assert.deepEqual(detectChecks(cwd), ["pytest"]);
  });
});
