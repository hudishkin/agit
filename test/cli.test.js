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
  test("--help prints usage", () => {
    const result = runAgit(["--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: agit/);
    assert.match(result.stdout, /Task-to-draft-PR workflow for AI coding agents/);
    assert.match(result.stdout, /init/);
    assert.match(result.stdout, /start/);
    assert.match(result.stdout, /finish/);
    assert.match(result.stdout, /prune/);
  });

  test("--version prints package version", () => {
    const result = runAgit(["--version"]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${pkg.version}\n`);
  });
});
