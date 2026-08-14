import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promptCommand } from "../src/commands/prompt.js";
import { TaskStateError } from "../src/errors.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agit.js");

describe("prompt", () => {
  test("builds a copy-paste prompt", async () => {
    const result = await promptCommand("/tmp", "AUTH-123");
    assert.match(result.prompt, /agit start AUTH-123/);
    assert.match(result.prompt, /agit finish AUTH-123/);
    assert.match(result.prompt, /Do not use git push directly/);
  });

  test("rejects an invalid task id", async () => {
    await assert.rejects(() => promptCommand("/tmp", "foo/bar"), TaskStateError);
  });

  test("CLI prompt --json returns the prompt", () => {
    const result = spawnSync(process.execPath, [bin, "prompt", "AUTH-123", "--json"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(payload.data.prompt, /Task ID: AUTH-123/);
  });
});
