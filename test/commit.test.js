import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitCommand } from "../src/commands/commit.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { DenylistHit, EmptyCommit, WrongBranch } from "../src/errors.js";
import { loadTask } from "../src/taskstore.js";
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

async function startedRepo() {
  const created = repo();
  await initCommand(created.work, { yes: true, install: false });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: init agit"]);
  await startCommand(created.work, "AUTH-123");
  created.tree = taskWork(created.work, "AUTH-123");
  return created;
}

describe("commit", () => {
  test("refuses to commit on the default branch", async () => {
    const { work } = repo();
    await initCommand(work, { yes: true, install: false });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: init agit"]);
    writeFileSync(join(work, "note.txt"), "x\n");

    await assert.rejects(() => commitCommand(work, "AUTH-123: nope"), WrongBranch);
  });

  test("rejects an empty change set", async () => {
    const { tree } = await startedRepo();
    await assert.rejects(() => commitCommand(tree, "AUTH-123: empty"), EmptyCommit);
  });

  test("rejects .env and does not create a commit", async () => {
    const { tree } = await startedRepo();
    const head = gitRun(tree, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(tree, ".env"), "SECRET=1\n");

    await assert.rejects(() => commitCommand(tree, "AUTH-123: leak"), DenylistHit);
    assert.equal(gitRun(tree, ["rev-parse", "HEAD"]).trim(), head);
  });

  test("commits locally and does not push", async () => {
    const { work, tree, origin } = await startedRepo();
    writeFileSync(join(tree, "note.txt"), "ok\n");

    const result = await commitCommand(tree, "AUTH-123: add note");
    const task = loadTask(work, "AUTH-123");

    assert.deepEqual(result.files, ["note.txt"]);
    assert.equal(task.status, "committed");
    assert.equal(task.commits.length, 1);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("CLI commit --json lists files", async () => {
    const { tree } = await startedRepo();
    writeFileSync(join(tree, "note.txt"), "ok\n");

    const result = spawnSync(
      process.execPath,
      [bin, "commit", "-m", "AUTH-123: add note", "--json", "-C", tree],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.data.files, ["note.txt"]);
  });

  test("--files does not commit other staged paths", async () => {
    const { tree } = await startedRepo();
    writeFileSync(join(tree, "mine.txt"), "agent work\n");
    writeFileSync(join(tree, ".env"), "SECRET=1\n");
    gitRun(tree, ["add", ".env"]);

    const result = await commitCommand(tree, "AUTH-123: add mine", { files: ["mine.txt"] });

    assert.deepEqual(result.files, ["mine.txt"]);
    const tracked = gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.match(tracked, /mine\.txt/);
    assert.doesNotMatch(tracked, /\.env/);
  });
});
