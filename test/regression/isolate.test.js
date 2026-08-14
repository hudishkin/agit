import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitCommand } from "../../src/commands/commit.js";
import { doctorCommand } from "../../src/commands/doctor.js";
import { finishCommand } from "../../src/commands/finish.js";
import { initCommand } from "../../src/commands/init.js";
import { isolateCommand } from "../../src/commands/isolate.js";
import { startCommand } from "../../src/commands/start.js";
import { getConfig } from "../../src/git.js";
import { isMirrorUrl, mirrorPath, normalizeGitUrl } from "../../src/mirror.js";
import { cloneRepo, createGitRepo, gitPushSetup, gitRun } from "../helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

async function readyRepo() {
  const created = createGitRepo();
  repos.push(created);
  await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: adopt agit"]);
  gitPushSetup(created.work, ["origin", "main"]);
  return created;
}

async function isolatedRepo() {
  const created = await readyRepo();
  await isolateCommand(created.work);
  return created;
}

function prStub(url = "https://github.com/acme/backend/pull/1") {
  return { createPr: async () => url };
}

function originUrl(work) {
  return gitRun(work, ["remote", "get-url", "origin"]).trim();
}

describe("regression: local mirror", () => {
  test("isolate rewrites origin to the mirror and keeps the real URL in the profile", async () => {
    const { work, origin } = await readyRepo();

    const result = await isolateCommand(work);

    assert.equal(result.isolated, true);
    assert.equal(isMirrorUrl(work, originUrl(work)), true);
    assert.equal(await getConfig(work, "agit.isolate"), "true");
    assert.equal(normalizeGitUrl(await getConfig(work, "agit.pushUrl")), normalizeGitUrl(origin));
    assert.match(readFileSync(join(work, ".gitignore"), "utf8"), /\.agit\/mirror\.git\//);
    assert.equal(existsSync(join(mirrorPath(work), "hooks/pre-receive")), true);
  });

  test("git push --no-verify origin stays on the mirror", async () => {
    const { work, origin } = await isolatedRepo();
    await startCommand(work, "T1");
    writeFileSync(join(work, "leak.txt"), "should not reach github\n");
    await commitCommand(work, "T1: leak");

    gitRun(work, ["push", "--no-verify", "-u", "origin", "agit/T1"]);
    gitRun(work, ["push", "--no-verify", originUrl(work), "HEAD:refs/heads/via-url"]);

    assert.doesNotMatch(gitRun(origin, ["branch"]), /agit\/T1|via-url/);
    assert.match(gitRun(mirrorPath(work), ["branch"]), /agit\/T1/);
    assert.match(gitRun(mirrorPath(work), ["branch"]), /via-url/);
  });

  test("the mirror rejects a push to the default branch", async () => {
    const { work } = await isolatedRepo();
    writeFileSync(join(work, "nope.txt"), "main\n");
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "onto main"]);

    assert.throws(() => gitRun(work, ["push", "--no-verify", "origin", "main"]));
  });

  test("start syncs the default branch from the real remote", async () => {
    const created = await isolatedRepo();

    const other = cloneRepo(created);
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "feat: upstream work"]);
    gitPushSetup(other, ["origin", "main"]);

    await startCommand(created.work, "T2");

    assert.match(gitRun(created.work, ["ls-tree", "-r", "--name-only", "HEAD"]), /upstream\.txt/);
  });

  test("sync does not clobber an unpublished task branch on the mirror", async () => {
    const { work, origin } = await isolatedRepo();
    await startCommand(work, "T3");
    writeFileSync(join(work, "local-only.txt"), "only on the mirror\n");
    await commitCommand(work, "T3: local only");
    gitRun(work, ["push", "--no-verify", "-u", "origin", "agit/T3"]);
    const mirrorSha = gitRun(mirrorPath(work), ["rev-parse", "agit/T3"]).trim();

    await startCommand(work, "T4");

    assert.equal(gitRun(mirrorPath(work), ["rev-parse", "agit/T3"]).trim(), mirrorSha);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /agit\/T3/);
  });

  test("finish still publishes to the real remote and updates the same PR", async () => {
    const { work, origin } = await isolatedRepo();
    await startCommand(work, "T5");
    writeFileSync(join(work, "a.txt"), "first\n");
    await commitCommand(work, "T5: add a");
    await finishCommand(work, "T5", prStub());

    assert.match(gitRun(origin, ["branch"]), /agit\/T5/);
    assert.match(gitRun(origin, ["ls-tree", "-r", "--name-only", "agit/T5"]), /a\.txt/);

    writeFileSync(join(work, "b.txt"), "review\n");
    await commitCommand(work, "T5: address review");
    const second = await finishCommand(work, "T5", prStub());

    assert.equal(second.already, false);
    assert.match(gitRun(origin, ["ls-tree", "-r", "--name-only", "agit/T5"]), /b\.txt/);
    assert.match(gitRun(mirrorPath(work), ["ls-tree", "-r", "--name-only", "agit/T5"]), /b\.txt/);
  });

  test("isolate --undo restores origin", async () => {
    const { work, origin } = await readyRepo();
    await isolateCommand(work);
    await isolateCommand(work, { undo: true });

    assert.equal(normalizeGitUrl(originUrl(work)), normalizeGitUrl(origin));
    assert.equal(await getConfig(work, "agit.isolate"), null);
  });

  test("doctor reports the mirror as layer 4", async () => {
    const { work } = await readyRepo();

    const before = await doctorCommand(work);
    assert.equal(before.checks.find((check) => check.id === "credential_boundary").status, "warn");

    await isolateCommand(work);
    const after = await doctorCommand(work);
    assert.equal(after.checks.find((check) => check.id === "credential_boundary").status, "ok");
    assert.match(after.checks.find((check) => check.id === "credential_boundary").message, /not a sandbox/);
  });
});
