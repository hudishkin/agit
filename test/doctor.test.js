import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { abortCommand } from "../src/commands/abort.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { initCommand } from "../src/commands/init.js";
import { isolateCommand } from "../src/commands/isolate.js";
import { startCommand } from "../src/commands/start.js";
import { hookPath } from "../src/hooks.js";
import { loadProfile, saveProfile } from "../src/profile.js";
import { createGitRepo, gitRun } from "./helpers/git-harness.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agit.js");
const repos = [];
const dirs = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  test("fails outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-doctor-"));
    dirs.push(dir);

    const result = await doctorCommand(dir);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.id === "repo").status, "fail");
  });

  test("reports profile and hooks after init", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);

    const result = await doctorCommand(created.work);
    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.id === "profile").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "enforcement").status, "ok");
    assert.match(result.checks.find((check) => check.id === "enforcement").message, /remote/);
    assert.equal(result.checks.find((check) => check.id === "pre_push_hook").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "cursor_guard").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "claude_guard").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "stale_tasks").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "pr_provider").status, "ok");
    assert.match(result.checks.find((check) => check.id === "pr_provider").message, /github/);
    assert.equal(result.checks.find((check) => check.id === "sandbox_mode").status, "ok");
    assert.match(result.checks.find((check) => check.id === "sandbox_mode").message, /off/);
  });

  test("does not require gh when pr.provider is none", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });
    const profile = loadProfile(created.work);
    profile.pr.provider = "none";
    saveProfile(created.work, profile);

    const result = await doctorCommand(created.work);
    assert.match(result.checks.find((check) => check.id === "pr_provider").message, /none/);
    assert.match(result.checks.find((check) => check.id === "gh").message, /not required/);
  });

  test("warns about stale tasks", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);
    await startCommand(created.work, "OLD");
    await abortCommand(created.work, "OLD");

    const result = await doctorCommand(created.work);
    const stale = result.checks.find((check) => check.id === "stale_tasks");
    assert.equal(stale.status, "warn");
    assert.match(stale.message, /agit prune/);
  });

  test("warns about a foreign agit file", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });
    writeFileSync(join(created.work, ".agit.toml"), "foreign = true\n");

    const result = await doctorCommand(created.work);
    assert.equal(result.checks.find((check) => check.id === "foreign_agit").status, "warn");
  });

  test("doctor --fix reinstalls a missing pre-push hook", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });
    const path = await hookPath(created.work);
    rmSync(path, { force: true });
    assert.equal(existsSync(path), false);

    const result = await doctorCommand(created.work, { fix: true });
    assert.equal(result.fixed.hooks, true);
    assert.equal(existsSync(path), true);
    assert.equal(result.checks.find((check) => check.id === "pre_push_hook").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "fix").status, "ok");
  });

  test("CLI doctor --json returns checks", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false });

    const result = spawnSync(process.execPath, [bin, "doctor", "--json", "-C", created.work], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.data.checks));
  });

  test("sandbox=agents without isolate fails doctor", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false, sandbox: true });

    const result = await doctorCommand(created.work);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.id === "sandbox_mode").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "sandbox_isolate").status, "fail");
  });

  test("sandbox=agents with isolate and start reports the worktree configs", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false, sandbox: true });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);
    await isolateCommand(created.work);
    await startCommand(created.work, "AUTH-123");

    const result = await doctorCommand(created.work);
    assert.equal(result.checks.find((check) => check.id === "sandbox_mode").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "sandbox_isolate").status, "ok");
    assert.equal(result.checks.find((check) => check.id === "sandbox_runtime").status, "ok");
    const configFail = result.checks.find(
      (check) =>
        check.layer === "sandbox" &&
        check.status === "fail" &&
        /sandbox\.json|settings\.json|config\.toml|insecure_none|danger-full-access/.test(check.message),
    );
    assert.equal(configFail, undefined);
  });
});
