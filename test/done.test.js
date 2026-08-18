import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitCommand } from "../src/commands/commit.js";
import { doneCommand } from "../src/commands/done.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { PublishFailed, TaskStateError } from "../src/errors.js";
import { branchExists, currentBranch } from "../src/git.js";
import { loadTask, taskExists } from "../src/taskstore.js";
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
  await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: init agit"]);
  return created;
}

async function publishedTask() {
  const created = await readyRepo();
  await startCommand(created.work, "AUTH-123");
  created.tree = taskWork(created.work, "AUTH-123");
  writeFileSync(join(created.tree, "note.txt"), "ok\n");
  await commitCommand(created.tree, "AUTH-123: add note");
  await finishCommand(created.work, "AUTH-123", {
    createPr: async () => "https://github.com/acme/backend/pull/1",
  });
  return created;
}

describe("done", () => {
  test("removes the worktree after the PR is merged and does not touch remote", async () => {
    const { work, origin, tree } = await publishedTask();

    const result = await doneCommand(work, "AUTH-123", {
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });

    assert.equal(result.status, "done");
    assert.equal(result.pr_url, "https://github.com/acme/backend/pull/1");
    assert.equal(existsSync(tree), false);
    assert.equal(taskExists(work, "AUTH-123"), false);
    assert.equal(await currentBranch(work), "main");
    assert.equal(await branchExists(work, "agit/AUTH-123"), false);
    assert.match(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("force-removes a dirty worktree after merge", async () => {
    const { work, tree } = await publishedTask();
    writeFileSync(join(tree, "scratch.txt"), "leftover\n");

    const result = await doneCommand(work, "AUTH-123", {
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });

    assert.equal(result.status, "done");
    assert.equal(existsSync(tree), false);
    assert.equal(taskExists(work, "AUTH-123"), false);
  });

  test("removes the task when the worktree directory is already gone", async () => {
    const { work, tree } = await publishedTask();
    gitRun(work, ["worktree", "remove", "--force", tree]);

    const result = await doneCommand(work, "AUTH-123", {
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });

    assert.equal(result.status, "done");
    assert.equal(await branchExists(work, "agit/AUTH-123"), false);
    assert.equal(taskExists(work, "AUTH-123"), false);
  });

  test("refuses when the PR is still open", async () => {
    const { work, tree } = await publishedTask();

    await assert.rejects(
      () =>
        doneCommand(work, "AUTH-123", {
          inspectPr: async () => ({ state: "OPEN", merged: false }),
        }),
      TaskStateError,
    );
    assert.equal(existsSync(tree), true);
    assert.equal(loadTask(work, "AUTH-123").status, "pr_created");
  });

  test("refuses a closed unmerged PR", async () => {
    const { work } = await publishedTask();

    await assert.rejects(
      () =>
        doneCommand(work, "AUTH-123", {
          inspectPr: async () => ({ state: "CLOSED", merged: false }),
        }),
      /not merged/,
    );
    assert.equal(taskExists(work, "AUTH-123"), true);
  });

  test("refuses when the PR cannot be inspected", async () => {
    const { work } = await publishedTask();

    await assert.rejects(
      () => doneCommand(work, "AUTH-123", { inspectPr: async () => null }),
      /Could not inspect/,
    );
    assert.equal(taskExists(work, "AUTH-123"), true);
  });

  test("refuses an unpublished task", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");

    await assert.rejects(() => doneCommand(work, "AUTH-123"), /was not published/);
    assert.equal(await branchExists(work, "agit/AUTH-123"), true);
  });

  test("refuses a pushed task that never got a PR", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await assert.rejects(
      () =>
        finishCommand(work, "AUTH-123", {
          createPr: async () => {
            throw new PublishFailed("Checks passed, but remote publish failed.");
          },
        }),
      PublishFailed,
    );

    await assert.rejects(() => doneCommand(work, "AUTH-123"), /without a pull request/);
    assert.equal(loadTask(work, "AUTH-123").status, "pushed");
  });
});
