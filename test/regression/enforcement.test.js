import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { doctorCommand } from "../../src/commands/doctor.js";
import { initCommand } from "../../src/commands/init.js";
import { createGitRepo, gitRun } from "../helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function repo(options) {
  const created = createGitRepo(options);
  repos.push(created);
  return created;
}

function tryPush(cwd, args, env = {}) {
  return spawnSync("git", ["push", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writePushToken(cwd) {
  writeFileSync(join(cwd, ".git/agit-allow-push"), gitRun(cwd, ["rev-parse", "HEAD"]));
}

describe("regression: git hook installation", () => {
  test("an existing pre-push hook is backed up, not silently replaced", async () => {
    const { work } = repo();
    const path = join(work, ".git/hooks/pre-push");
    writeFileSync(path, "#!/bin/sh\necho husky ran\n");

    await initCommand(work, { yes: true, install: false });

    assert.match(readFileSync(path, "utf8"), /agit:pre-push/);
    assert.equal(existsSync(`${path}.agit-backup`), true);
    assert.match(readFileSync(`${path}.agit-backup`, "utf8"), /husky ran/);
  });

  test("the hook is installed where core.hooksPath points", async () => {
    const { work } = repo();
    mkdirSync(join(work, ".husky"), { recursive: true });
    gitRun(work, ["config", "core.hooksPath", ".husky"]);

    await initCommand(work, { yes: true, install: false });

    assert.equal(existsSync(join(work, ".husky/pre-push")), true);
    assert.equal(existsSync(join(work, ".git/hooks/pre-push")), false);

    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: adopt agit"]);
    gitRun(work, ["checkout", "-b", "agit/T1"]);

    const pushed = tryPush(work, ["-u", "origin", "agit/T1"]);
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /agit: git push is blocked/);

    const result = await doctorCommand(work);
    const check = result.checks.find((item) => item.id === "pre_push_hook");
    assert.equal(check.status, "ok");
    assert.match(check.message, /\.husky/);
  });

  test("the hook protects the configured default branch, not only main", async () => {
    const { work } = repo({ branch: "trunk" });

    await initCommand(work, { yes: true, install: false, defaultBranch: "trunk" });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: adopt agit"]);
    writePushToken(work);

    const pushed = tryPush(work, ["origin", "trunk"]);

    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /push to trunk is blocked/);
    assert.equal(gitRun(work, ["rev-parse", "origin/trunk"]).trim() !== gitRun(work, ["rev-parse", "trunk"]).trim(), true);
  });

  test("the old environment variable no longer opens the hook", async () => {
    const { work } = repo();

    await initCommand(work, { yes: true, install: false });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: adopt agit"]);
    gitRun(work, ["checkout", "-b", "agit/T1"]);

    const pushed = tryPush(work, ["-u", "origin", "agit/T1"], { AGIT_ALLOW_PUSH: "1" });

    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /agit: git push is blocked/);
    assert.doesNotMatch(gitRun(work, ["branch", "-r"]), /agit\/T1/);
  });

  test("a push token is single use", async () => {
    const { work } = repo();

    await initCommand(work, { yes: true, install: false });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: adopt agit"]);
    gitRun(work, ["checkout", "-b", "agit/T1"]);
    writePushToken(work);

    const first = tryPush(work, ["-u", "origin", "agit/T1"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(join(work, ".git/agit-allow-push")), false);

    writeFileSync(join(work, "next.txt"), "more\n");
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "T1: more"]);

    const second = tryPush(work, ["origin", "agit/T1"]);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /agit: git push is blocked/);
  });
});
