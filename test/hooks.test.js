import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitCommand } from "../src/commands/commit.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { createGitRepo, gitRun, taskWork } from "./helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

describe("hooks", () => {
  test("init installs a pre-push hook that blocks raw git push", async () => {
    const created = createGitRepo();
    repos.push(created);
    const { work, origin } = created;

    await initCommand(work, { yes: true, install: false });
    assert.equal(existsSync(join(work, ".git/hooks/pre-push")), true);

    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: init agit"]);
    await startCommand(work, "AUTH-123");
    const tree = taskWork(work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");

    assert.throws(() => gitRun(tree, ["push", "-u", "origin", "agit/AUTH-123"]));
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);

    await finishCommand(work, "AUTH-123", {
      createPr: async () => "https://github.com/acme/backend/pull/1",
    });
    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-123/);
  });
});
