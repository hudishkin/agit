import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { abortCommand } from "../src/commands/abort.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { statusCommand } from "../src/commands/status.js";
import { agitHome, loadStoreProfile, projectId, resolveStore } from "../src/store.js";
import { loadTask } from "../src/taskstore.js";
import { createGitRepo, gitRun, taskWork } from "./helpers/git-harness.js";

const repos = [];
const homes = [];
const previousHome = process.env.AGIT_HOME;
const previousStore = process.env.AGIT_STORE;

function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), "agit-home-"));
  homes.push(home);
  process.env.AGIT_HOME = home;
  delete process.env.AGIT_STORE;
  return home;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  if (previousHome === undefined) {
    delete process.env.AGIT_HOME;
  } else {
    process.env.AGIT_HOME = previousHome;
  }
  if (previousStore === undefined) {
    delete process.env.AGIT_STORE;
  } else {
    process.env.AGIT_STORE = previousStore;
  }
});

function repo() {
  const created = createGitRepo();
  repos.push(created);
  return created;
}

describe("home store", () => {
  test("agitHome uses AGIT_HOME", () => {
    const home = isolateHome();
    assert.equal(agitHome(), home);
  });

  test("init --store home writes nothing into the working tree", async () => {
    const home = isolateHome();
    const { work } = repo();
    gitRun(work, ["remote", "set-url", "origin", "git@github.com:acme/backend.git"]);

    const result = await initCommand(work, { yes: true, store: "home", hooks: false });

    assert.equal(result.store, "home");
    assert.equal(existsSync(join(work, ".agit")), false);
    assert.equal(existsSync(join(work, "AGENTS.md")), false);
    assert.equal(existsSync(join(work, "CLAUDE.md")), false);
    assert.equal(existsSync(join(work, ".cursor")), false);
    assert.ok(result.profile.startsWith(home));
    assert.equal(existsSync(result.profile), true);
    assert.match(readFileSync(join(result.store_dir, "source.yml"), "utf8"), /acme\/backend/);
  });

  test("start and abort use the home worktree", async () => {
    isolateHome();
    const { work } = repo();
    await initCommand(work, { yes: true, store: "home", hooks: false });

    const started = await startCommand(work, "AUTH-123");
    assert.match(started.path, /\/worktrees\/AUTH-123$/);
    assert.equal(existsSync(join(work, ".agit")), false);
    assert.equal(existsSync(started.path), true);

    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.equal(loadTask(store.dir, "AUTH-123").worktree, "worktrees/AUTH-123");

    const status = await statusCommand(work, "AUTH-123");
    assert.equal(status.store.kind, "home");
    assert.equal(status.path, started.path);

    await abortCommand(work, "AUTH-123");
    assert.equal(existsSync(started.path), false);
    assert.equal(loadTask(store.dir, "AUTH-123").status, "aborted");
  });

  test("AGIT_STORE=home starts without init", async () => {
    isolateHome();
    process.env.AGIT_STORE = "home";
    const { work } = repo();

    const started = await startCommand(work, "AUTH-123");
    assert.equal(existsSync(join(work, ".agit")), false);
    assert.equal(existsSync(started.path), true);

    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.equal(existsSync(join(store.dir, "profile.yml")), true);
  });

  test("AGIT_STORE=home start --sandbox without init", async () => {
    isolateHome();
    process.env.AGIT_STORE = "home";
    const { work } = repo();

    const started = await startCommand(work, "AUTH-123", { sandbox: true });
    assert.equal(started.sandbox, "agents");
    assert.equal(existsSync(join(work, ".agit")), false);
    assert.equal(existsSync(join(started.path, ".cursor/sandbox.json")), true);
    assert.equal(existsSync(join(started.path, ".claude/settings.json")), true);
    assert.equal(existsSync(join(started.path, ".codex/config.toml")), true);

    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.equal(loadStoreProfile(store).workflow.sandbox, "agents");
  });

  test("in-repo profile does not override the home store", async () => {
    isolateHome();
    const { work } = repo();
    await initCommand(work, { yes: true, store: "repo", install: false, hooks: false, rules: false });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: init agit"]);

    const started = await startCommand(work, "AUTH-123");
    assert.equal(existsSync(join(work, ".agit", "worktrees", "AUTH-123")), false);
    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.match(started.path, /\/worktrees\/AUTH-123$/);
  });

  test("AGIT_STORE=repo uses the in-repo store", async () => {
    isolateHome();
    process.env.AGIT_STORE = "repo";
    const { work } = repo();
    await initCommand(work, { yes: true, store: "repo", install: false, hooks: false, rules: false });
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: init agit"]);

    const started = await startCommand(work, "AUTH-123");
    assert.equal(started.path, taskWork(work, "AUTH-123"));
    const store = await resolveStore(work);
    assert.equal(store.kind, "repo");
  });

  test("start without init uses the home store", async () => {
    isolateHome();
    const { work } = repo();
    const started = await startCommand(work, "AUTH-123");
    assert.equal(existsSync(join(work, ".agit")), false);
    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.equal(existsSync(join(store.dir, "profile.yml")), true);
    assert.equal(existsSync(started.path), true);
  });

  test("two clones get different project ids", () => {
    isolateHome();
    const first = repo();
    const second = repo();
    assert.notEqual(projectId(first.work, null), projectId(second.work, null));
  });

  test("config.yml does not select the store", async () => {
    const home = isolateHome();
    writeFileSync(join(home, "config.yml"), "store: repo\n");
    const { work } = repo();

    const started = await startCommand(work, "AUTH-123");
    assert.equal(existsSync(join(work, ".agit")), false);
    const store = await resolveStore(work);
    assert.equal(store.kind, "home");
    assert.ok(store.dir.startsWith(home));
    assert.equal(existsSync(started.path), true);
  });
});
