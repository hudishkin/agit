import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { abortCommand } from "../src/commands/abort.js";
import { commitCommand } from "../src/commands/commit.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { TaskStateError } from "../src/errors.js";
import { currentBranch } from "../src/git.js";
import { loadTask } from "../src/taskstore.js";
import { createGitRepo, gitRun, taskWork } from "./helpers/git-harness.js";

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

describe("abort", () => {
  test("removes the worktree and does not touch remote", async () => {
    const { work, origin } = await readyRepo();
    const started = await startCommand(work, "AUTH-123");

    const result = await abortCommand(work, "AUTH-123");

    assert.equal(result.status, "aborted");
    assert.equal(await currentBranch(work), "main");
    assert.equal(existsSync(started.path), false);
    assert.equal(loadTask(work, "AUTH-123").status, "aborted");
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("refuses to abort after publish", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    await assert.rejects(() => abortCommand(work, "AUTH-123"), TaskStateError);
  });

  test("start resumes an aborted task and a published one", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    await abortCommand(work, "AUTH-123");

    const restarted = await startCommand(work, "AUTH-123");
    assert.equal(restarted.resumed, true);
    assert.equal(await currentBranch(work), "main");
    assert.equal(await currentBranch(restarted.path), "agit/AUTH-123");
    assert.equal(loadTask(work, "AUTH-123").status, "started");

    writeFileSync(join(restarted.path, "note.txt"), "ok\n");
    await commitCommand(restarted.path, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const afterPublish = await startCommand(work, "AUTH-123");
    assert.equal(afterPublish.resumed, true);
    assert.equal(afterPublish.path, restarted.path);
  });
});
