import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitCommand } from "../../src/commands/commit.js";
import { finishCommand } from "../../src/commands/finish.js";
import { initCommand } from "../../src/commands/init.js";
import { startCommand } from "../../src/commands/start.js";
import { DenylistHit, EmptyCommit } from "../../src/errors.js";
import { loadProfile, saveProfile } from "../../src/profile.js";
import { loadTask } from "../../src/taskstore.js";
import { cloneRepo, createGitRepo, gitPushSetup, gitRun, taskWork } from "../helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// A repository where agit is initialized and that state is already on origin,
// which is where a real project starts from.
async function readyRepo(options = {}) {
  const created = createGitRepo({ branch: options.branch ?? "main" });
  repos.push(created);
  await initCommand(created.work, {
    yes: true,
    install: false,
    checks: options.checks ?? ["true"],
    defaultBranch: options.branch ?? "main",
  });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: adopt agit"]);
  gitPushSetup(created.work, ["origin", options.branch ?? "main"]);
  return created;
}

function prStub(url = "https://github.com/acme/backend/pull/1") {
  const calls = [];
  return {
    calls,
    createPr: async (_cwd, args) => {
      calls.push(args);
      return url;
    },
  };
}

describe("regression: review loop", () => {
  test("commits made after the PR exists reach the same PR", async () => {
    const { work, origin } = await readyRepo();
    const pr = prStub();

    await startCommand(work, "T1");
    const tree = taskWork(work, "T1");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T1: add a");
    await finishCommand(work, "T1", { createPr: pr.createPr });

    const published = gitRun(origin, ["rev-parse", "agit/T1"]).trim();

    writeFileSync(join(tree, "b.txt"), "review fix\n");
    await commitCommand(tree, "T1: address review");
    const second = await finishCommand(work, "T1", { createPr: pr.createPr });

    assert.equal(second.already, false);
    assert.equal(second.pr_url, "https://github.com/acme/backend/pull/1");
    assert.equal(pr.calls.length, 1, "the PR must not be recreated");

    const head = gitRun(tree, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(gitRun(origin, ["rev-parse", "agit/T1"]).trim(), published);
    assert.equal(gitRun(origin, ["rev-parse", "agit/T1"]).trim(), head);
    assert.match(gitRun(origin, ["ls-tree", "-r", "--name-only", "agit/T1"]), /b\.txt/);
  });

  test("finishing twice without new commits is a no-op", async () => {
    const { work } = await readyRepo();
    const pr = prStub();

    await startCommand(work, "T1");
    const tree = taskWork(work, "T1");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T1: add a");
    await finishCommand(work, "T1", { createPr: pr.createPr });

    const again = await finishCommand(work, "T1", { createPr: pr.createPr });
    assert.equal(again.already, true);
    assert.equal(pr.calls.length, 1);
  });

  test("a rewritten task branch is reported instead of force-pushed", async () => {
    const { work, origin } = await readyRepo();
    const pr = prStub();

    await startCommand(work, "T1");
    const tree = taskWork(work, "T1");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T1: add a");
    await finishCommand(work, "T1", { createPr: pr.createPr });
    const published = gitRun(origin, ["rev-parse", "agit/T1"]).trim();

    gitRun(tree, ["reset", "--hard", "HEAD~1"]);
    writeFileSync(join(tree, "c.txt"), "rewritten\n");
    await commitCommand(tree, "T1: rewritten");

    await assert.rejects(() => finishCommand(work, "T1", { createPr: pr.createPr }), /diverged/);
    assert.equal(gitRun(origin, ["rev-parse", "agit/T1"]).trim(), published);
  });
});

describe("regression: task base", () => {
  test("a new task starts from origin, not from a stale local branch", async () => {
    const created = await readyRepo();
    const other = cloneRepo(created);
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "feat: upstream work"]);
    gitPushSetup(other, ["origin", "main"]);

    await startCommand(created.work, "T2");

    assert.match(gitRun(taskWork(created.work, "T2"), ["ls-tree", "-r", "--name-only", "HEAD"]), /upstream\.txt/);
    assert.equal(loadTask(created.work, "T2").base_ref, "origin/main");
  });

  test("a new task keeps local commits that were never pushed", async () => {
    const { work } = await readyRepo();
    writeFileSync(join(work, "local-only.txt"), "not pushed yet\n");
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: local only"]);

    await startCommand(work, "T3");

    assert.match(gitRun(taskWork(work, "T3"), ["ls-tree", "-r", "--name-only", "HEAD"]), /local-only\.txt/);
  });

  test("a task with no commits of its own cannot be published", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T4");

    await assert.rejects(() => finishCommand(work, "T4", { createPr: prStub().createPr }), /Nothing to publish/);
  });
});

describe("regression: commit scope", () => {
  test("--files commits only the listed paths", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T5");
    const tree = taskWork(work, "T5");
    writeFileSync(join(tree, "mine.txt"), "agent work\n");
    writeFileSync(join(tree, "human-scratch.txt"), "unrelated\n");

    const result = await commitCommand(tree, "T5: add mine", { files: ["mine.txt"] });

    assert.deepEqual(result.files, ["mine.txt"]);
    assert.doesNotMatch(gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]), /human-scratch/);
  });

  test("scope: explicit refuses to guess the file list", async () => {
    const { work } = await readyRepo();
    const profile = loadProfile(work);
    profile.commit.scope = "explicit";
    saveProfile(work, profile);
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: explicit scope"]);

    await startCommand(work, "T6");
    const tree = taskWork(work, "T6");
    writeFileSync(join(tree, "mine.txt"), "agent work\n");

    await assert.rejects(() => commitCommand(tree, "T6: add mine"), EmptyCommit);
    await commitCommand(tree, "T6: add mine", { files: ["mine.txt"] });
  });

  test("--files rejects paths that did not change", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T7");
    const tree = taskWork(work, "T7");
    writeFileSync(join(tree, "mine.txt"), "agent work\n");

    await assert.rejects(() => commitCommand(tree, "T7: typo", { files: ["mien.txt"] }), EmptyCommit);
  });
});

describe("regression: file names and secrets", () => {
  test("commits paths that are not ASCII", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T8");
    const tree = taskWork(work, "T8");
    writeFileSync(join(tree, "документация.md"), "текст\n");
    writeFileSync(join(tree, "spaced name.txt"), "ok\n");

    const result = await commitCommand(tree, "T8: add docs");

    assert.deepEqual(result.files, ["spaced name.txt", "документация.md"]);
    const tracked = gitRun(tree, ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "HEAD"]);
    assert.match(tracked, /документация\.md/);
    assert.match(tracked, /spaced name\.txt/);
  });

  test("allows example env files but still blocks the real one", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T9");
    const tree = taskWork(work, "T9");
    writeFileSync(join(tree, ".env.example"), "API_KEY=\n");

    const result = await commitCommand(tree, "T9: document env");
    assert.deepEqual(result.files, [".env.example"]);

    writeFileSync(join(tree, ".env"), "API_KEY=real\n");
    await assert.rejects(() => commitCommand(tree, "T9: leak"), DenylistHit);
  });

  test("blocks a credential hardcoded in a source file", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T10");
    const tree = taskWork(work, "T10");
    const awsExample = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    writeFileSync(join(tree, "config.ts"), `export const key = "${awsExample}";\n`);

    await assert.rejects(() => commitCommand(tree, "T10: add config"), DenylistHit);
    assert.doesNotMatch(gitRun(tree, ["log", "--oneline"]), /T10/);
  });
});

describe("regression: checks", () => {
  test("a check with large output still passes", async () => {
    const { work } = await readyRepo({
      checks: ["node -e \"process.stdout.write('x'.repeat(2*1024*1024))\""],
    });
    const pr = prStub();

    await startCommand(work, "T11");
    const tree = taskWork(work, "T11");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T11: add a");

    const result = await finishCommand(work, "T11", { createPr: pr.createPr });
    assert.equal(result.checks.every((check) => check.ok), true);
  });

  test("a hanging check fails on the profile timeout", async () => {
    const { work } = await readyRepo({ checks: ["sleep 30"] });
    const profile = loadProfile(work);
    profile.checks_timeout_sec = 1;
    saveProfile(work, profile);
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: short timeout"]);

    await startCommand(work, "T12");
    const tree = taskWork(work, "T12");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T12: add a");

    await assert.rejects(() => finishCommand(work, "T12", { createPr: prStub().createPr }), /checks/);
    assert.equal(loadTask(work, "T12").checks.results[0].timed_out, true);
  });
});

describe("regression: resume and squash", () => {
  test("start returns to the task worktree from anywhere", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T13");
    const tree = taskWork(work, "T13");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T13: add a");

    const resumed = await startCommand(work, "T13");

    assert.equal(resumed.resumed, true);
    assert.equal(resumed.path, tree);
    assert.equal(gitRun(work, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(gitRun(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "agit/T13");
  });

  test("a squashed commit keeps the first subject, not the last", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "T14");
    const tree = taskWork(work, "T14");
    writeFileSync(join(tree, "a.txt"), "first\n");
    await commitCommand(tree, "T14: add the feature");
    writeFileSync(join(tree, "a.txt"), "second\n");
    await commitCommand(tree, "T14: fix a typo");

    const result = await finishCommand(work, "T14", { createPr: prStub().createPr, squash: true });

    assert.equal(gitRun(tree, ["log", "-1", "--pretty=%s"]).trim(), "T14: add the feature");
    assert.equal(gitRun(tree, ["rev-list", "--count", "origin/main..HEAD"]).trim(), "1");
    assert.match(result.message, /Draft PR created/);
  });
});
