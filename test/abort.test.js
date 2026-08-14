import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
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
import { createGitRepo, gitRun } from "./helpers/git-harness.js";

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
  test("checks out default and does not touch remote", async () => {
    const { work, origin } = await readyRepo();
    await startCommand(work, "AUTH-123");

    const result = await abortCommand(work, "AUTH-123");

    assert.equal(result.status, "aborted");
    assert.equal(await currentBranch(work), "main");
    assert.equal(loadTask(work, "AUTH-123").status, "aborted");
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("refuses to abort after publish", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    writeFileSync(join(work, "note.txt"), "ok\n");
    await commitCommand(work, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    await assert.rejects(() => abortCommand(work, "AUTH-123"), TaskStateError);
  });

  test("start resumes an aborted task and refuses a published one", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    await abortCommand(work, "AUTH-123");

    const restarted = await startCommand(work, "AUTH-123");
    assert.equal(restarted.resumed, true);
    assert.equal(await currentBranch(work), "agit/AUTH-123");
    assert.equal(loadTask(work, "AUTH-123").status, "started");

    writeFileSync(join(work, "note.txt"), "ok\n");
    await commitCommand(work, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    await assert.rejects(() => startCommand(work, "AUTH-123"), TaskStateError);
  });
});
