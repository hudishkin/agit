import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { DirtyTree, NotInitialized, TaskStateError } from "../src/errors.js";
import { currentBranch } from "../src/git.js";
import { acquireTaskLock } from "../src/lock.js";
import { isMirrorUrl } from "../src/mirror.js";
import { inspectWorktreeCredentials } from "../src/sandbox.js";
import { loadProfile, saveProfile } from "../src/profile.js";
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

  test("refuses to start when the main checkout is dirty", async () => {
    const { work } = await readyRepo();
    writeFileSync(join(work, "dirty.txt"), "nope\n");

    await assert.rejects(() => startCommand(work, "AUTH-123"), DirtyTree);
    assert.equal(await currentBranch(work), "main");
  });

  test("starts when dirty if require_clean_tree_on_start is false", async () => {
    const { work } = await readyRepo();
    const profile = loadProfile(work);
    profile.workflow.require_clean_tree_on_start = false;
    saveProfile(work, profile);
    writeFileSync(join(work, "dirty.txt"), "nope\n");

    const result = await startCommand(work, "AUTH-123");
    assert.equal(await currentBranch(work), "main");
    assert.equal(await currentBranch(result.path), "agit/AUTH-123");
  });

  test("concurrent start of the same id fails the second lock", async () => {
    const { work } = await readyRepo();
    const release = acquireTaskLock(work, "AUTH-123");
    try {
      await assert.rejects(() => startCommand(work, "AUTH-123"), TaskStateError);
    } finally {
      release();
    }
  });

  test("rejects an invalid task id", async () => {
    const { work } = await readyRepo();
    await assert.rejects(() => startCommand(work, "foo/bar"), TaskStateError);
  });

  test("fails when origin cannot be fetched", async () => {
    const { work } = await readyRepo();
    gitRun(work, ["remote", "set-url", "origin", join(work, "missing.git")]);

    await assert.rejects(() => startCommand(work, "AUTH-123"), /Could not fetch from origin/);
  });

  test("creates a local task worktree without pushing", async () => {
    const { work, origin } = await readyRepo();
    const result = await startCommand(work, "AUTH-123");

    assert.equal(result.branch, "agit/AUTH-123");
    assert.equal(result.resumed, false);
    assert.equal(result.path, taskWork(work, "AUTH-123"));
    assert.equal(await currentBranch(work), "main");
    assert.equal(await currentBranch(result.path), "agit/AUTH-123");
    assert.equal(loadTask(work, "AUTH-123").status, "started");
    assert.equal(loadTask(work, "AUTH-123").worktree, ".agit/worktrees/AUTH-123");
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
    assert.match(result.message, /A human publishes/);
    assert.match(result.message, /Work in:/);
    assert.doesNotMatch(result.message, /agit commit -m/);
  });

  test("protocol start tells the agent to commit and finish", async () => {
    const created = repo();
    await initCommand(created.work, { yes: true, install: false, mode: "protocol" });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);

    const result = await startCommand(created.work, "AUTH-123");
    assert.match(result.message, /agit commit -m/);
    assert.match(result.message, /agit finish AUTH-123/);
  });

  test("resumes the same task without switching the main checkout", async () => {
    const { work } = await readyRepo();
    const first = await startCommand(work, "AUTH-123");
    const again = await startCommand(work, "AUTH-123");

    assert.equal(again.resumed, true);
    assert.equal(again.path, first.path);
    assert.equal(await currentBranch(work), "main");
    assert.equal(await currentBranch(again.path), "agit/AUTH-123");
  });

  test("stores title, body, and issue on the task", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123", {
      title: "Fix login",
      body: "Cover the timeout path.",
      issue: "12",
    });

    const task = loadTask(work, "AUTH-123");
    assert.equal(task.title, "Fix login");
    assert.equal(task.body, "Cover the timeout path.");
    assert.equal(task.issue, "12");
  });

  test("does not treat the task id as a GitHub issue", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    assert.equal(loadTask(work, "AUTH-123").issue, undefined);

    await assert.rejects(() => startCommand(work, "AUTH-123", { issue: "AUTH-123" }), TaskStateError);
  });

  test("strips a leading # from --issue", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123", { issue: "#12" });
    assert.equal(loadTask(work, "AUTH-123").issue, "12");
  });

  test("treats an empty issue as unset", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123", { issue: "" });
    assert.equal(loadTask(work, "AUTH-123").issue, null);
  });

  test("resume updates title and body", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123", { title: "First" });
    await startCommand(work, "AUTH-123", { title: "Later", body: "Cover the timeout." });

    const task = loadTask(work, "AUTH-123");
    assert.equal(task.title, "Later");
    assert.equal(task.body, "Cover the timeout.");
  });

  test("resume is allowed when the main checkout is dirty", async () => {
    const { work } = await readyRepo();
    const first = await startCommand(work, "AUTH-123");
    writeFileSync(join(work, "dirty.txt"), "nope\n");

    const again = await startCommand(work, "AUTH-123");
    assert.equal(again.resumed, true);
    assert.equal(again.path, first.path);
  });

  test("recreates a missing worktree from the existing branch", async () => {
    const { work } = await readyRepo();
    const first = await startCommand(work, "AUTH-123");
    writeFileSync(join(first.path, "note.txt"), "keep\n");
    gitRun(first.path, ["add", "-A"]);
    gitRun(first.path, ["commit", "-m", "AUTH-123: keep"]);
    gitRun(work, ["worktree", "remove", "--force", first.path]);

    const again = await startCommand(work, "AUTH-123");
    assert.equal(again.resumed, true);
    assert.equal(again.path, first.path);
    assert.match(gitRun(again.path, ["ls-tree", "-r", "--name-only", "HEAD"]), /note\.txt/);
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
    assert.equal(payload.data.path, taskWork(work, "AUTH-123"));
  });

  test("start with sandbox=agents writes agent configs in the worktree", async () => {
    const created = repo();
    await initCommand(created.work, { yes: true, install: false, sandbox: true });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);

    const result = await startCommand(created.work, "AUTH-123");
    assert.equal(result.sandbox, "agents");
    assert.equal(existsSync(join(result.path, ".cursor/sandbox.json")), true);
    assert.equal(existsSync(join(result.path, ".claude/settings.json")), true);
    assert.equal(existsSync(join(result.path, ".codex/config.toml")), true);
    assert.equal(isMirrorUrl(created.work, gitRun(created.work, ["remote", "get-url", "origin"]).trim()), true);
    assert.equal((await inspectWorktreeCredentials(result.path)).status, "ok");
    assert.match(result.message, /local mirror/);
    assert.match(result.message, /credentials are locked/);
  });

  test("start without sandbox does not write agent sandbox configs", async () => {
    const { work } = await readyRepo();
    const origin = gitRun(work, ["remote", "get-url", "origin"]).trim();
    const result = await startCommand(work, "AUTH-123");
    assert.equal(result.sandbox, undefined);
    assert.equal(existsSync(join(result.path, ".cursor/sandbox.json")), false);
    assert.equal(existsSync(join(result.path, ".codex/config.toml")), false);
    assert.equal(gitRun(work, ["remote", "get-url", "origin"]).trim(), origin);
    assert.equal(isMirrorUrl(work, origin), false);
  });
});
