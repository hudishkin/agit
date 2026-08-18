import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { abortCommand } from "../src/commands/abort.js";
import { commitCommand } from "../src/commands/commit.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { statusCommand } from "../src/commands/status.js";
import { TaskStateError } from "../src/errors.js";
import { createGitRepo, gitRun, taskWork } from "./helpers/git-harness.js";

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
    const tree = taskWork(work, "AUTH-123");

    const started = await statusCommand(tree);
    assert.equal(started.status, "started");
    assert.equal(started.pushed, false);
    assert.equal(started.path, tree);

    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");

    const committed = await statusCommand(work, "AUTH-123");
    assert.equal(committed.status, "committed");
    assert.equal(committed.commits.length, 1);
  });

  test("CLI status --json returns task fields", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");

    const result = spawnSync(process.execPath, [bin, "status", "AUTH-123", "--json", "-C", work], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.task_id, "AUTH-123");
    assert.equal(payload.data.status, "started");
  });

  test("status --all lists every task", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "A1");
    await startCommand(work, "A2");

    const result = await statusCommand(work, undefined, { all: true });
    assert.deepEqual(
      result.tasks.map((task) => task.task_id),
      ["A1", "A2"],
    );
    assert.equal(result.tasks[0].path, taskWork(work, "A1"));
    assert.equal(result.tasks[1].worktree_exists, true);
    assert.equal(result.tasks[0].dirty, false);
    assert.equal(result.tasks[0].commit_count, 0);
    assert.equal(typeof result.tasks[0].age, "string");
    assert.equal(result.tasks[0].pr_url, null);
    assert.match(result.message, /TASK/);
    assert.match(result.message, /A1/);
  });

  test("status --all reports a dirty tree and a stale hint", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "A1");
    writeFileSync(join(taskWork(work, "A1"), "note.txt"), "dirty\n");
    await startCommand(work, "OLD");
    await abortCommand(work, "OLD");

    const result = await statusCommand(work, undefined, { all: true });
    const dirty = result.tasks.find((task) => task.task_id === "A1");
    assert.equal(dirty.dirty, true);
    assert.ok(result.stale_count >= 1);
    assert.match(result.message, /agit prune/);

    const aborted = result.tasks.find((task) => task.task_id === "OLD");
    assert.equal(aborted.worktree_exists, false);
    assert.match(result.message, /gone/);
  });

  test("status hints agit done when the PR is merged", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const result = await statusCommand(work, "AUTH-123", {
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });
    assert.equal(result.merged, true);
    assert.match(result.message, /agit done AUTH-123/);
  });

  test("status --all hints agit done for a merged PR", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const result = await statusCommand(work, undefined, {
      all: true,
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });
    assert.equal(result.stale_count, 1);
    assert.match(result.message, /agit done AUTH-123/);
    assert.doesNotMatch(result.message, /agit prune/);
  });

  test("status --all shows live commit count and last subject", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "A1");
    const tree = taskWork(work, "A1");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "A1: add note");

    const result = await statusCommand(work, undefined, { all: true });
    assert.equal(result.tasks[0].commit_count, 1);
    assert.equal(result.tasks[0].last_commit, "A1: add note");
    assert.equal(result.tasks[0].dirty, false);
  });
});
