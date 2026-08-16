import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_PROFILE, loadProfile, saveProfile } from "../src/profile.js";
import { assertTaskId, loadTask, saveTask } from "../src/taskstore.js";
import { TaskStateError } from "../src/errors.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("profile and tasks", () => {
  test("roundtrips a profile and fills defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-profile-"));
    dirs.push(dir);

    saveProfile(dir, {
      repo: { default_branch: "develop", url: "git@github.com:acme/backend.git" },
      checks: ["npm test"],
    });

    const loaded = loadProfile(dir);
    assert.equal(loaded.repo.default_branch, "develop");
    assert.equal(loaded.repo.url, "git@github.com:acme/backend.git");
    assert.equal(loaded.workflow.branch_prefix, DEFAULT_PROFILE.workflow.branch_prefix);
    assert.equal(loaded.workflow.enforcement, "protocol");
    assert.equal(loaded.pr.provider, "github");
    assert.deepEqual(loaded.checks, ["npm test"]);
    assert.ok(loaded.commit.denylist.includes(".env"));
  });

  test("roundtrips a task", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-task-"));
    dirs.push(dir);

    const task = {
      task_id: "AUTH-123",
      branch: "agit/AUTH-123",
      status: "started",
      commits: [],
    };
    saveTask(dir, task);

    assert.deepEqual(loadTask(dir, "AUTH-123"), task);
  });

  test("rejects a task id with a slash", () => {
    assert.throws(() => assertTaskId("../x"), TaskStateError);
    assert.throws(() => assertTaskId("foo/bar"), TaskStateError);
  });
});
