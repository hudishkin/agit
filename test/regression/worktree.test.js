import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { abortCommand } from "../../src/commands/abort.js";
import { commitCommand } from "../../src/commands/commit.js";
import { finishCommand } from "../../src/commands/finish.js";
import { initCommand } from "../../src/commands/init.js";
import { isolateCommand } from "../../src/commands/isolate.js";
import { startCommand } from "../../src/commands/start.js";
import { currentBranch } from "../../src/git.js";
import { mirrorPath } from "../../src/mirror.js";
import { createGitRepo, gitPushSetup, gitRun, taskWork } from "../helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

async function readyRepo() {
  const created = createGitRepo();
  repos.push(created);
  await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: adopt agit"]);
  gitPushSetup(created.work, ["origin", "main"]);
  return created;
}

function prStub(url = "https://github.com/acme/backend/pull/1") {
  return { createPr: async () => url };
}

describe("regression: parallel worktrees", () => {
  test("two dirty task trees can exist at once", async () => {
    const { work } = await readyRepo();
    const first = await startCommand(work, "AUTH-1");
    writeFileSync(join(first.path, "one.txt"), "first agent\n");

    const second = await startCommand(work, "AUTH-2");
    writeFileSync(join(second.path, "two.txt"), "second agent\n");

    assert.equal(await currentBranch(work), "main");
    assert.equal(await currentBranch(first.path), "agit/AUTH-1");
    assert.equal(await currentBranch(second.path), "agit/AUTH-2");
    assert.match(gitRun(first.path, ["status", "--porcelain"]), /one\.txt/);
    assert.match(gitRun(second.path, ["status", "--porcelain"]), /two\.txt/);
  });

  test("finish from the main checkout publishes only that task", async () => {
    const { work, origin } = await readyRepo();
    await startCommand(work, "AUTH-1");
    await startCommand(work, "AUTH-2");
    writeFileSync(join(taskWork(work, "AUTH-1"), "one.txt"), "keep\n");
    writeFileSync(join(taskWork(work, "AUTH-2"), "two.txt"), "publish\n");
    await commitCommand(taskWork(work, "AUTH-2"), "AUTH-2: add two");

    await finishCommand(work, "AUTH-2", prStub());

    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-2/);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /agit\/AUTH-1/);
    assert.match(gitRun(origin, ["ls-tree", "-r", "--name-only", "agit/AUTH-2"]), /two\.txt/);
    assert.equal(await currentBranch(work), "main");
  });

  test("abort removes the worktree and leaves the remote alone", async () => {
    const { work, origin } = await readyRepo();
    const started = await startCommand(work, "AUTH-3");
    await abortCommand(work, "AUTH-3");

    assert.equal(existsSync(started.path), false);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-3/);
  });

  test("isolate: push from a worktree stays on the mirror", async () => {
    const { work, origin } = await readyRepo();
    await isolateCommand(work);
    await startCommand(work, "AUTH-4");
    const tree = taskWork(work, "AUTH-4");
    writeFileSync(join(tree, "leak.txt"), "local\n");
    await commitCommand(tree, "AUTH-4: leak");
    gitRun(tree, ["push", "--no-verify", "-u", "origin", "agit/AUTH-4"]);

    assert.doesNotMatch(gitRun(origin, ["branch"]), /agit\/AUTH-4/);
    assert.match(gitRun(mirrorPath(work), ["branch"]), /agit\/AUTH-4/);
  });

  test("start from inside a worktree creates the sibling at the repo root", async () => {
    const { work } = await readyRepo();
    const first = await startCommand(work, "AUTH-5");
    const second = await startCommand(first.path, "AUTH-6");

    assert.equal(second.path, taskWork(work, "AUTH-6"));
    assert.equal(second.path.startsWith(first.path), false);
    assert.equal(await currentBranch(first.path), "agit/AUTH-5");
    assert.equal(await currentBranch(second.path), "agit/AUTH-6");
  });

  test("resume after publish returns the same path", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "AUTH-7");
    writeFileSync(join(started.path, "a.txt"), "first\n");
    await commitCommand(started.path, "AUTH-7: add a");
    await finishCommand(work, "AUTH-7", prStub());

    const resumed = await startCommand(work, "AUTH-7");
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.path, started.path);
  });
});
