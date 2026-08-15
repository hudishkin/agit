import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { agitRoot, worktreeAbsPath } from "../src/root.js";
import { createGitRepo, gitRun } from "./helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

describe("agitRoot", () => {
  test("from a linked worktree still returns the main checkout", async () => {
    const created = createGitRepo();
    repos.push(created);
    const extra = join(created.root, "extra");
    gitRun(created.work, ["worktree", "add", extra, "-b", "extra"]);

    assert.equal(await agitRoot(created.work), realpathSync(created.work));
    assert.equal(await agitRoot(extra), realpathSync(created.work));
    assert.equal(worktreeAbsPath(created.work, "T1"), join(realpathSync(created.work), ".agit/worktrees/T1"));
  });
});
