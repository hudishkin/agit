import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { runChecks } from "../src/checks.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("checks", () => {
  test("timeout kills the process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-checks-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "hang.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
setInterval(() => {}, 1000);
`,
    );

    const results = await runChecks(dir, [`${process.execPath} hang.mjs`], join(dir, "log.txt"), {
      timeoutSec: 1,
    });

    assert.equal(results[0].timed_out, true);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    assert.equal(Number.isInteger(pid) && pid > 0, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});
