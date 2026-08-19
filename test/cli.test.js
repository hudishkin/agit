import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "agit.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function runAgit(args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
  });
}

describe("agit cli", () => {
  test("--help prints the public workflow", () => {
    const result = runAgit(["--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: agit/);
    assert.match(result.stdout, /Task-to-draft-PR workflow for AI coding agents/);
    assert.match(result.stdout, /init/);
    assert.match(result.stdout, /start/);
    assert.match(result.stdout, /status/);
    assert.match(result.stdout, /finish/);
    assert.match(result.stdout, /abort/);
    assert.match(result.stdout, /done/);
    assert.match(result.stdout, /doctor/);
  });

  test("--help hides protocol and repair commands", () => {
    const result = runAgit(["--help"]);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\bcommit\b/);
    assert.doesNotMatch(result.stdout, /\bprune\b/);
    assert.doesNotMatch(result.stdout, /\bisolate\b/);
    assert.doesNotMatch(result.stdout, /\bprompt\b/);
    assert.doesNotMatch(result.stdout, /install-hooks/);
    assert.doesNotMatch(result.stdout, /install-agent-guards/);
  });

  test("init --help documents --finish and hides --mode", () => {
    const result = runAgit(["init", "--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--finish/);
    assert.match(result.stdout, /ask \(default\)/);
    assert.doesNotMatch(result.stdout, /--mode/);
    assert.doesNotMatch(result.stdout, /patch/);
    assert.doesNotMatch(result.stdout, /guard-only/);
  });

  test("done --help documents --stale", () => {
    const result = runAgit(["done", "--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--stale/);
    assert.match(result.stdout, /--apply/);
  });

  test("doctor --help documents repair flags", () => {
    const result = runAgit(["doctor", "--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--fix/);
    assert.match(result.stdout, /--undo-isolate/);
  });

  test("hidden commit and isolate still parse", () => {
    const commit = runAgit(["commit", "--help"]);
    const isolate = runAgit(["isolate", "--help"]);
    const prune = runAgit(["prune", "--help"]);

    assert.equal(commit.status, 0);
    assert.equal(isolate.status, 0);
    assert.equal(prune.status, 0);
    assert.match(isolate.stdout, /--undo/);
  });

  test("--version prints package version", () => {
    const result = runAgit(["--version"]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${pkg.version}\n`);
  });

  test("removed commands are unknown", () => {
    for (const name of ["prompt", "install-hooks", "install-agent-guards", "protect"]) {
      const result = runAgit([name]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, new RegExp(`unknown command '${name}'`));
    }
  });
});
