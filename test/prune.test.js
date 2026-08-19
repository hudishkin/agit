import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { abortCommand } from "../src/commands/abort.js";
import { commitCommand } from "../src/commands/commit.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { pruneCommand } from "../src/commands/prune.js";
import { startCommand } from "../src/commands/start.js";
import { PublishFailed } from "../src/errors.js";
import { branchExists } from "../src/git.js";
import { loadProfile, saveProfile } from "../src/profile.js";
import { deleteTask, loadTask, saveTask } from "../src/taskstore.js";
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

describe("prune", () => {
  test("dry-run lists aborted tasks and does not delete them", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "AUTH-123");
    await abortCommand(work, "AUTH-123");

    const result = await pruneCommand(work);
    assert.equal(result.apply, false);
    assert.equal(result.candidates[0].task_id, "AUTH-123");
    assert.equal(result.candidates[0].reason, "aborted");
    assert.equal(loadTask(work, "AUTH-123").status, "aborted");
    assert.equal(existsSync(started.path), false);
    assert.match(result.message, /agit done --stale --apply/);
  });

  test("apply removes aborted task metadata", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    await abortCommand(work, "AUTH-123");

    const result = await pruneCommand(work, { apply: true });
    assert.equal(result.removed[0].removed, true);
    assert.equal(existsSync(join(work, ".agit/tasks/AUTH-123.yml")), false);
    assert.equal(await branchExists(work, "agit/AUTH-123"), false);
  });

  test("prunes empty tasks older than prune_after_days", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "OLD");
    const task = loadTask(work, "OLD");
    task.created_at = new Date(Date.now() - 15 * 86_400_000).toISOString();
    saveTask(work, task);

    const result = await pruneCommand(work);
    assert.equal(result.candidates[0].reason, "empty_old");
  });

  test("does not prune a published open PR", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const result = await pruneCommand(work, {
      inspectPr: async () => ({ state: "OPEN", merged: false }),
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(loadTask(work, "AUTH-123").status, "pr_created");
  });

  test("prunes a merged PR when gh reports merged", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const listed = await pruneCommand(work, {
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });
    assert.equal(listed.candidates[0].reason, "merged");

    const applied = await pruneCommand(work, {
      apply: true,
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });
    assert.equal(applied.removed[0].removed, true);
    assert.equal(existsSync(join(work, ".agit/tasks/AUTH-123.yml")), false);
  });

  test("prunes an orphan worktree without task yaml", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "ORPHAN");
    deleteTask(work, "ORPHAN");

    const result = await pruneCommand(work, { apply: true });
    assert.equal(result.candidates[0].reason, "orphan_worktree");
    assert.equal(existsSync(started.path), false);
    assert.equal(await branchExists(work, "agit/ORPHAN"), false);
  });

  test("does not prune a young empty task", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "FRESH");

    const result = await pruneCommand(work);
    assert.equal(result.candidates.length, 0);
  });

  test("skips a dirty empty_old task on apply", async () => {
    const { work } = await readyRepo();
    const started = await startCommand(work, "OLD");
    const task = loadTask(work, "OLD");
    task.created_at = new Date(Date.now() - 15 * 86_400_000).toISOString();
    saveTask(work, task);
    writeFileSync(join(started.path, "scratch.txt"), "uncommitted\n");

    const result = await pruneCommand(work, { apply: true });
    assert.equal(result.removed[0].skipped, "dirty");
    assert.equal(result.removed[0].removed, undefined);
    assert.equal(existsSync(join(work, ".agit/tasks/OLD.yml")), true);
    assert.equal(existsSync(started.path), true);
  });

  test("does not prune a published PR when gh is unavailable", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const result = await pruneCommand(work, { inspectPr: async () => null });
    assert.equal(result.candidates.length, 0);
    assert.equal(loadTask(work, "AUTH-123").status, "pr_created");
  });

  test("does not prune a closed unmerged PR", async () => {
    const { work } = await readyRepo();
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");
    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });

    const result = await pruneCommand(work, {
      inspectPr: async () => ({ state: "CLOSED", merged: false }),
    });
    assert.equal(result.candidates.length, 0);
  });

  test("does not prune a pushed task that never got a PR", async () => {
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
    assert.equal(loadTask(work, "AUTH-123").status, "pushed");

    const result = await pruneCommand(work);
    assert.equal(result.candidates.length, 0);
  });

  test("respects a custom prune_after_days", async () => {
    const { work } = await readyRepo();
    const profile = loadProfile(work);
    profile.workflow.prune_after_days = 1;
    saveProfile(work, profile);
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: set prune_after_days"]);
    await startCommand(work, "OLD");
    const task = loadTask(work, "OLD");
    task.created_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    saveTask(work, task);

    const result = await pruneCommand(work);
    assert.equal(result.candidates[0].reason, "empty_old");
  });

  test("falls back to 14 days when prune_after_days is invalid", async () => {
    const { work } = await readyRepo();
    const profile = loadProfile(work);
    profile.workflow.prune_after_days = 0;
    saveProfile(work, profile);
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: invalid prune_after_days"]);
    await startCommand(work, "OLD");
    const task = loadTask(work, "OLD");
    task.created_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    saveTask(work, task);

    const young = await pruneCommand(work);
    assert.equal(young.candidates.length, 0);

    task.created_at = new Date(Date.now() - 15 * 86_400_000).toISOString();
    saveTask(work, task);
    const old = await pruneCommand(work);
    assert.equal(old.candidates[0].reason, "empty_old");
  });
});
