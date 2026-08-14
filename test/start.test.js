import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { DirtyTree, NotInitialized, TaskStateError } from "../src/errors.js";
import { currentBranch } from "../src/git.js";
import { loadTask } from "../src/taskstore.js";
import { createGitRepo, gitRun } from "./helpers/git-harness.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agit.js");
const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function repo() {
  const created = createGitRepo();
  repos.push(created);
  return created;
}

async function readyRepo() {
  const created = repo();
  await initCommand(created.work, { yes: true, install: false });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: init agit"]);
  return created;
}

describe("start", () => {
  test("requires init", async () => {
    const { work } = repo();
    await assert.rejects(() => startCommand(work, "AUTH-123"), NotInitialized);
  });

  test("rejects a dirty tree", async () => {
    const { work } = await readyRepo();
    writeFileSync(join(work, "dirty.txt"), "nope\n");

    await assert.rejects(() => startCommand(work, "AUTH-123"), DirtyTree);
  });

  test("rejects an invalid task id", async () => {
    const { work } = await readyRepo();
    await assert.rejects(() => startCommand(work, "foo/bar"), TaskStateError);
  });

  test("creates a local task branch without pushing", async () => {
    const { work, origin } = await readyRepo();
    const result = await startCommand(work, "AUTH-123");

    assert.equal(result.branch, "agit/AUTH-123");
    assert.equal(result.resumed, false);
    assert.equal(await currentBranch(work), "agit/AUTH-123");
    assert.equal(loadTask(work, "AUTH-123").status, "started");
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("resumes the same clean task", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const again = await startCommand(work, "AUTH-123");

    assert.equal(again.resumed, true);
    assert.equal(await currentBranch(work), "agit/AUTH-123");
  });

  test("CLI start --json prints task state", async () => {
    const { work } = await readyRepo();
    const result = spawnSync(process.execPath, [bin, "start", "AUTH-123", "--json", "-C", work], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.branch, "agit/AUTH-123");
  });
});
