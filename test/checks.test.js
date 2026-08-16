import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { readLogTail, runChecks } from "../src/checks.js";

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

  test("readLogTail returns empty when the log is missing", () => {
    assert.equal(readLogTail(join(tmpdir(), "agit-missing-checks.log")), "");
  });

  test("readLogTail keeps only the last lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-checks-"));
    dirs.push(dir);
    const path = join(dir, "log.txt");
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

    const tail = readLogTail(path, 3);
    assert.equal(tail, "line 48\nline 49\nline 50");
  });
});
