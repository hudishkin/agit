import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { rmSync } from "node:fs";
import { protectCommand } from "../src/commands/protect.js";
import { initCommand } from "../src/commands/init.js";
import { loadProfile, saveProfile } from "../src/profile.js";
import { createGitRepo } from "./helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

describe("protect", () => {
  test("does not apply a GitHub ruleset when pr.provider is not github", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false, repo: "git@gitlab.com:acme/backend.git" });
    const profile = loadProfile(created.work);
    assert.equal(profile.pr.provider, "gitlab");

    let applied = false;
    const result = await protectCommand(created.work, { apply: true }, {
      applyRuleset: async () => {
        applied = true;
      },
    });

    assert.equal(applied, false);
    assert.equal(result.applied, false);
    assert.match(result.message, /GitHub ruleset/);
    assert.match(result.message, /gitlab/);
  });

  test("still previews a GitHub ruleset when pr.provider is github", async () => {
    const created = createGitRepo();
    repos.push(created);
    await initCommand(created.work, { yes: true, install: false, repo: "git@github.com:acme/backend.git" });
    saveProfile(created.work, loadProfile(created.work));

    const result = await protectCommand(created.work, { apply: false });
    assert.equal(result.applied, false);
    assert.equal(result.repo, "acme/backend");
    assert.match(result.message, /agit protect --apply/);
  });
});
