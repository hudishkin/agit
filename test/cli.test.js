import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agit.js");

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
  });

  test("--version prints package version", () => {
    const result = runAgit(["--version"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^0\.1\.0\n$/);
  });
});
