import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { initCommand, packageHasAgit, parseRepoUrl } from "../src/commands/init.js";
import { AgitError, NotInitialized } from "../src/errors.js";
import { isClean } from "../src/git.js";
import { loadProfile } from "../src/profile.js";
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

function repo() {
  const created = createGitRepo();
  repos.push(created);
  return created;
}

describe("init", () => {
  test("rejects a directory that is not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-nongit-"));
    dirs.push(dir);

    await assert.rejects(() => initCommand(dir, { yes: true, install: false }), NotInitialized);
  });

  test("rejects missing --yes", async () => {
    const { work } = repo();

    await assert.rejects(() => initCommand(work, { install: false }), AgitError);
  });

  test("writes profile, gitignore, and AGENTS.md without committing", async () => {
    const { work } = repo();
    const head = gitRun(work, ["rev-parse", "HEAD"]).trim();

    const result = await initCommand(work, {
      yes: true,
      install: false,
      repo: "git@github.com:acme/backend.git",
      defaultBranch: "main",
      checks: ["npm test"],
    });

    const profile = loadProfile(work);
    assert.equal(profile.repo.owner, "acme");
    assert.equal(profile.repo.name, "backend");
    assert.equal(profile.repo.default_branch, "main");
    assert.equal(profile.workflow.enforcement, "remote");
    assert.deepEqual(profile.checks, ["npm test"]);
    assert.match(readFileSync(join(work, "AGENTS.md"), "utf8"), /Local Git is allowed/);
    assert.match(readFileSync(join(work, ".gitignore"), "utf8"), /\.agit\/tasks\//);
    assert.match(readFileSync(join(work, ".gitignore"), "utf8"), /\.agit\/mirror\.git\//);
    assert.equal(existsSync(join(work, ".agit/setup-agent.sh")), true);
    assert.equal(existsSync(join(work, ".github/pull_request_template.md")), true);
    assert.equal(existsSync(join(work, ".cursor/rules/agit.mdc")), true);
    assert.equal(existsSync(join(work, "CLAUDE.md")), true);
    assert.equal(gitRun(work, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(await isClean(work), false);
    assert.deepEqual(result.checks, ["npm test"]);
  });

  test("init --mode protocol keeps the agit CLI workflow", async () => {
    const { work } = repo();

    await initCommand(work, { yes: true, install: false, mode: "protocol" });

    assert.equal(loadProfile(work).workflow.enforcement, "protocol");
    assert.match(readFileSync(join(work, "AGENTS.md"), "utf8"), /agit start <task-id>/);
  });

  test("re-init keeps an existing enforcement mode", async () => {
    const { work } = repo();

    await initCommand(work, { yes: true, install: false, mode: "protocol" });
    await initCommand(work, { yes: true, install: false });

    assert.equal(loadProfile(work).workflow.enforcement, "protocol");
  });

  test("init --guard-only selects remote enforcement", async () => {
    const { work } = repo();

    await initCommand(work, { yes: true, install: false, guardOnly: true });

    assert.equal(loadProfile(work).workflow.enforcement, "remote");
  });

  test("rejects an unknown enforcement mode", async () => {
    const { work } = repo();

    await assert.rejects(() => initCommand(work, { yes: true, install: false, mode: "sandbox" }), AgitError);
  });

  test("does not overwrite text outside AGENTS.md markers", async () => {
    const { work } = repo();
    writeFileSync(join(work, "AGENTS.md"), "# Keep me\n\nDo not drop this.\n");

    await initCommand(work, { yes: true, install: false, checks: ["true"] });
    await initCommand(work, { yes: true, install: false, checks: ["npm test"] });

    const text = readFileSync(join(work, "AGENTS.md"), "utf8");
    assert.match(text, /# Keep me/);
    assert.match(text, /Do not drop this/);
    assert.equal(text.indexOf("# Keep me"), text.lastIndexOf("# Keep me"));
    assert.deepEqual(loadProfile(work).checks, ["npm test"]);
  });

  test("skips npm install without package.json", async () => {
    const { work } = repo();
    let called = false;

    const result = await initCommand(
      work,
      { yes: true, install: true },
      {
        npmInstall: async () => {
          called = true;
        },
      },
    );

    assert.equal(called, false);
    assert.equal(result.install.reason, "no_package_json");
  });

  test("installs agit when package.json has no dependency", async () => {
    const { work } = repo();
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    let called = false;

    const result = await initCommand(
      work,
      { yes: true, install: true },
      {
        npmInstall: async () => {
          called = true;
        },
      },
    );

    assert.equal(called, true);
    assert.equal(result.install.reason, "added");
  });

  test("CLI init --json --no-install succeeds", () => {
    const { work } = repo();
    const result = spawnSync(process.execPath, [bin, "init", "--yes", "--no-install", "--json", "-C", work], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "init");
    assert.equal(existsSync(join(work, ".agit/profile.yml")), true);
  });

  test("does not overwrite an existing PR template", async () => {
    const { work } = repo();
    mkdirSync(join(work, ".github"), { recursive: true });
    writeFileSync(join(work, ".github/pull_request_template.md"), "keep\n");

    await initCommand(work, { yes: true, install: false, rules: false });
    assert.equal(readFileSync(join(work, ".github/pull_request_template.md"), "utf8"), "keep\n");
  });

  test("parseRepoUrl and packageHasAgit helpers", () => {
    assert.deepEqual(parseRepoUrl("git@github.com:acme/backend.git"), {
      url: "git@github.com:acme/backend.git",
      owner: "acme",
      name: "backend",
    });
    assert.equal(packageHasAgit({ devDependencies: { "@hudishkin/agit": "^0.1.0" } }), true);
    assert.equal(packageHasAgit({ name: "app" }), false);
    assert.equal(packageHasAgit({ devDependencies: { agit: "^0.0.6" } }), false);
  });
});
