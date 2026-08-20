import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitCommand } from "../src/commands/commit.js";
import { doneCommand } from "../src/commands/done.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { DirtyTree, PublishFailed, TaskStateError } from "../src/errors.js";
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

    await assert.rejects(
      () => doneCommand(work, "AUTH-123"),
      (error) => {
        assert.match(error.message, /was not published/);
        assert.match(error.hint, /done AUTH-123 --merge/);
        return true;
      },
    );
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

describe("done --merge", () => {
  test("merges the task branch into the base and deletes it", async () => {
    const created = await readyRepo();
    await startCommand(created.work, "AUTH-123");
    const tree = taskWork(created.work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");

    const result = await doneCommand(created.work, "AUTH-123", { merge: true });

    assert.equal(result.status, "done");
    assert.equal(result.base, "main");
    assert.equal(result.branch, "agit/AUTH-123");
    assert.equal(existsSync(tree), false);
    assert.equal(taskExists(created.work, "AUTH-123"), false);
    assert.equal(await branchExists(created.work, "agit/AUTH-123"), false);
    assert.equal(await currentBranch(created.work), "main");
    assert.equal(readFileSync(join(created.work, "note.txt"), "utf8"), "ok\n");
    assert.doesNotMatch(gitRun(created.origin, ["branch"]), /AUTH-123/);
  });

  test("merges an empty task and still removes the work branch", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "AUTH-123");

    const result = await doneCommand(work, "AUTH-123", { merge: true });

    assert.equal(result.status, "done");
    assert.equal(existsSync(started.path), false);
    assert.equal(await branchExists(work, "agit/AUTH-123"), false);
    assert.equal(taskExists(work, "AUTH-123"), false);
    assert.equal(await currentBranch(work), "main");
  });

  test("merges when the worktree directory is already gone", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "AUTH-123");
    writeFileSync(join(started.path, "note.txt"), "ok\n");
    await commitCommand(started.path, "AUTH-123: add note");
    gitRun(work, ["worktree", "remove", "--force", started.path]);

    const result = await doneCommand(work, "AUTH-123", { merge: true });

    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(work, "note.txt"), "utf8"), "ok\n");
    assert.equal(await branchExists(work, "agit/AUTH-123"), false);
  });

  test("refuses a dirty task worktree", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    writeFileSync(join(taskWork(work, "AUTH-123"), "note.txt"), "dirty\n");

    await assert.rejects(() => doneCommand(work, "AUTH-123", { merge: true }), DirtyTree);
    assert.equal(await branchExists(work, "agit/AUTH-123"), true);
    assert.equal(taskExists(work, "AUTH-123"), true);
  });

  test("refuses a dirty main checkout", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    writeFileSync(join(work, "README.md"), "dirty main\n");

    await assert.rejects(() => doneCommand(work, "AUTH-123", { merge: true }), /main checkout is not clean/);
    assert.equal(await branchExists(work, "agit/AUTH-123"), true);
    assert.equal(taskExists(work, "AUTH-123"), true);
  });

  test("refuses a published task", async () => {
    const { work, tree } = await publishedTask();

    await assert.rejects(() => doneCommand(work, "AUTH-123", { merge: true }), /already published/);
    assert.equal(existsSync(tree), true);
    assert.equal(taskExists(work, "AUTH-123"), true);
  });

  test("refuses a merge conflict and leaves the task intact", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");

    writeFileSync(join(work, "note.txt"), "from-main\n");
    gitRun(work, ["add", "note.txt"]);
    gitRun(work, ["commit", "-m", "main note"]);

    writeFileSync(join(tree, "note.txt"), "from-task\n");
    await commitCommand(tree, "AUTH-123: add note");

    await assert.rejects(() => doneCommand(work, "AUTH-123", { merge: true }), /Could not merge/);
    assert.equal(existsSync(tree), true);
    assert.equal(taskExists(work, "AUTH-123"), true);
    assert.equal(await branchExists(work, "agit/AUTH-123"), true);
    assert.equal(await currentBranch(work), "main");
    assert.equal(existsSync(join(work, "note.txt")), true);
    assert.equal(readFileSync(join(work, "note.txt"), "utf8"), "from-main\n");
  });
});
