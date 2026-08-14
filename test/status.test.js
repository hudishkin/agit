import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitCommand } from "../src/commands/commit.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { statusCommand } from "../src/commands/status.js";
import { TaskStateError } from "../src/errors.js";
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

describe("status", () => {
  test("errors when there is no active task", async () => {
    const { work } = await readyRepo();
    await assert.rejects(() => statusCommand(work), TaskStateError);
  });

  test("shows started and committed state", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");

    const started = await statusCommand(work);
    assert.equal(started.status, "started");
    assert.equal(started.pushed, false);

    writeFileSync(join(work, "note.txt"), "ok\n");
    await commitCommand(work, "AUTH-123: add note");

    const committed = await statusCommand(work, "AUTH-123");
    assert.equal(committed.status, "committed");
    assert.equal(committed.commits.length, 1);
  });

  test("CLI status --json returns task fields", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");

    const result = spawnSync(process.execPath, [bin, "status", "--json", "-C", work], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.task_id, "AUTH-123");
    assert.equal(payload.data.status, "started");
  });
});
