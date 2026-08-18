import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitCommand } from "../src/commands/commit.js";
import { finishCommand } from "../src/commands/finish.js";
import { initCommand } from "../src/commands/init.js";
import { startCommand } from "../src/commands/start.js";
import { ChecksFailed, DirtyTree, PublishFailed, TaskStateError } from "../src/errors.js";
import { createDraftPr } from "../src/gh.js";
import { createDraftMr } from "../src/prhost.js";
import { currentBranch, isClean, logOneline } from "../src/git.js";
import { loadProfile, saveProfile } from "../src/profile.js";
import { loadTask } from "../src/taskstore.js";
import { cloneRepo, createGitRepo, gitPushSetup, gitRun, taskWork } from "./helpers/git-harness.js";

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

async function readyTask({ checks = ["true"] } = {}) {
  const created = repo();
  await initCommand(created.work, { yes: true, install: false, checks });
  gitRun(created.work, ["add", "-A"]);
  gitRun(created.work, ["commit", "-m", "chore: init agit"]);
  await startCommand(created.work, "AUTH-123");
  created.tree = taskWork(created.work, "AUTH-123");
  writeFileSync(join(created.tree, "note.txt"), "ok\n");
  await commitCommand(created.tree, "AUTH-123: add note");
  return created;
}

function fakePr(url = "https://github.com/acme/backend/pull/1") {
  const calls = [];
  return {
    calls,
    createPr: async (_cwd, args) => {
      calls.push(args);
      return url;
    },
  };
}

function fakeGhPath(url = "https://github.com/acme/backend/pull/9") {
  const dir = mkdtempSync(join(tmpdir(), "agit-gh-"));
  dirs.push(dir);
  const script = join(dir, "gh");
  writeFileSync(script, `#!/bin/sh\necho ${url}\n`);
  chmodSync(script, 0o755);
  return dir;
}

describe("finish", () => {
  test("does not push when checks dirty the tree", async () => {
    const { work, origin } = await readyTask({ checks: ["touch leftover.txt"] });
    const gh = fakePr();

    await assert.rejects(() => finishCommand(work, "AUTH-123", gh), DirtyTree);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
    assert.equal(gh.calls.length, 0);
  });

  test("does not push when checks fail", async () => {
    const { work, origin } = await readyTask({ checks: ["false"] });
    const gh = fakePr();

    const failure = await finishCommand(work, "AUTH-123", gh).then(
      () => null,
      (error) => error,
    );
    assert.ok(failure instanceof ChecksFailed);
    assert.equal(loadTask(work, "AUTH-123").status, "checks_failed");
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
    assert.equal(gh.calls.length, 0);
    assert.match(readFileSync(join(work, ".agit/logs/AUTH-123-checks.log"), "utf8"), /\$ false/);
    assert.match(failure.details.log_tail, /\$ false/);
    assert.match(failure.details.log_path, /AUTH-123-checks\.log$/);
  });

  test("pushes once and creates a draft PR", async () => {
    const { work, origin } = await readyTask();
    const gh = fakePr();

    const result = await finishCommand(work, "AUTH-123", gh);
    const task = loadTask(work, "AUTH-123");

    assert.equal(result.pr_url, "https://github.com/acme/backend/pull/1");
    assert.equal(task.status, "pr_created");
    assert.equal(task.publish.pushed, true);
    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-123/);
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0].head, "agit/AUTH-123");
    assert.equal(gh.calls[0].base, "main");
    assert.match(gh.calls[0].title, /AUTH-123: add note/);
    assert.match(gh.calls[0].body, /AUTH-123/);
    assert.match(gh.calls[0].body, /note\.txt/);
    assert.match(gh.calls[0].body, /`true`/);
    assert.doesNotMatch(gh.calls[0].body, /Closes #123/);
  });

  test("uses start title, body, and issue in the draft PR", async () => {
    const created = repo();
    await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);
    await startCommand(created.work, "AUTH-123", {
      title: "Fix login",
      body: "Cover the timeout path.",
      issue: 12,
    });
    const tree = taskWork(created.work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");

    const gh = fakePr();
    await finishCommand(created.work, "AUTH-123", gh);
    assert.equal(gh.calls[0].title, "AUTH-123: Fix login");
    assert.match(gh.calls[0].body, /Cover the timeout path/);
    assert.match(gh.calls[0].body, /Closes #12/);
  });

  test("second finish does not push again", async () => {
    const { work, origin } = await readyTask();
    const gh = fakePr();

    await finishCommand(work, "AUTH-123", gh);
    const sha = gitRun(origin, ["rev-parse", "agit/AUTH-123"]).trim();

    const again = await finishCommand(work, "AUTH-123", gh);
    assert.equal(again.already, true);
    assert.equal(again.pr_url, "https://github.com/acme/backend/pull/1");
    assert.equal(gitRun(origin, ["rev-parse", "agit/AUTH-123"]).trim(), sha);
    assert.equal(gh.calls.length, 1);
  });

  test("hints agit done when the PR is already merged", async () => {
    const { work, origin, tree } = await readyTask();
    const gh = fakePr();

    await finishCommand(work, "AUTH-123", gh);
    writeFileSync(join(tree, "extra.txt"), "more\n");
    await commitCommand(tree, "AUTH-123: extra");

    const result = await finishCommand(work, "AUTH-123", {
      ...gh,
      inspectPr: async () => ({ state: "MERGED", merged: true }),
    });

    assert.equal(result.merged, true);
    assert.equal(result.already, true);
    assert.match(result.message, /agit done AUTH-123/);
    assert.doesNotMatch(gitRun(origin, ["log", "--oneline", "agit/AUTH-123"]), /extra/);
    assert.equal(gh.calls.length, 1);
  });

  test("retries PR only after push succeeded and gh failed", async () => {
    const { work, origin } = await readyTask();
    let fail = true;
    const calls = [];

    await assert.rejects(
      () =>
        finishCommand(work, "AUTH-123", {
          createPr: async (_cwd, args) => {
            calls.push(args);
            if (fail) {
              throw new PublishFailed("Checks passed, but remote publish failed.");
            }
            return "https://github.com/acme/backend/pull/2";
          },
        }),
      PublishFailed,
    );

    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-123/);
    assert.equal(loadTask(work, "AUTH-123").status, "pushed");
    const sha = gitRun(origin, ["rev-parse", "agit/AUTH-123"]).trim();

    fail = false;
    const result = await finishCommand(work, "AUTH-123", {
      createPr: async (_cwd, args) => {
        calls.push(args);
        return "https://github.com/acme/backend/pull/2";
      },
    });

    assert.equal(result.pr_url, "https://github.com/acme/backend/pull/2");
    assert.equal(loadTask(work, "AUTH-123").status, "pr_created");
    assert.equal(gitRun(origin, ["rev-parse", "agit/AUTH-123"]).trim(), sha);
    assert.equal(calls.length, 2);
  });

  test("finish from the main checkout publishes the task worktree", async () => {
    const { work, origin } = await readyTask();
    const gh = fakePr();

    const result = await finishCommand(work, "AUTH-123", gh);
    assert.equal(result.pr_url, "https://github.com/acme/backend/pull/1");
    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-123/);
    assert.equal(await currentBranch(work), "main");
  });

  test("refuses to finish without commits", async () => {
    const created = repo();
    await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);
    await startCommand(created.work, "AUTH-123");

    await assert.rejects(() => finishCommand(created.work, "AUTH-123", fakePr()), TaskStateError);
  });

  test("CLI finish --json uses gh on PATH", async () => {
    const { work } = await readyTask();
    const ghDir = fakeGhPath("https://github.com/acme/backend/pull/9");

    const result = spawnSync(process.execPath, [bin, "finish", "AUTH-123", "--json", "-C", work], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.pr_url, "https://github.com/acme/backend/pull/9");
  });

  test("squashes commits before the first push", async () => {
    const { work, tree } = await readyTask();
    writeFileSync(join(tree, "note2.txt"), "two\n");
    await commitCommand(tree, "AUTH-123: second change");
    assert.equal((await logOneline(tree, "main..HEAD")).length, 2);

    await finishCommand(work, "AUTH-123", { ...fakePr(), squash: true });
    assert.equal((await logOneline(tree, "main..HEAD")).length, 1);
    assert.equal(loadTask(work, "AUTH-123").commits.length, 1);
  });

  test("passes owner/name to PR creation", async () => {
    const { work } = await readyTask();
    const profile = loadProfile(work);
    profile.repo.owner = "acme";
    profile.repo.name = "backend";
    saveProfile(work, profile);
    gitRun(work, ["add", "-A"]);
    gitRun(work, ["commit", "-m", "chore: set repo slug"]);

    const gh = fakePr();
    await finishCommand(work, "AUTH-123", gh);
    assert.equal(gh.calls[0].repo, "acme/backend");
  });

  test("createDraftPr fails clearly when gh is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-nogh-"));
    dirs.push(dir);
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      await assert.rejects(
        () =>
          createDraftPr(dir, {
            base: "main",
            head: "agit/T1",
            title: "t",
            body: "b",
          }),
        PublishFailed,
      );
    } finally {
      process.env.PATH = previous;
    }
  });

  test("createDraftPr forwards --repo to gh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-gh-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > "$(dirname "$0")/args"\necho https://github.com/acme/backend/pull/1\n`,
    );
    chmodSync(join(dir, "gh"), 0o755);

    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      const url = await createDraftPr(dir, {
        base: "main",
        head: "agit/T1",
        title: "t",
        body: "b",
        repo: "acme/backend",
      });
      assert.equal(url, "https://github.com/acme/backend/pull/1");
      assert.match(readFileSync(join(dir, "args"), "utf8"), /--repo acme\/backend/);
    } finally {
      process.env.PATH = previous;
    }
  });

  test("rebases onto origin/main before the first push", async () => {
    const { work, origin, tree, root } = await readyTask();
    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream change"]);
    gitPushSetup(other, ["origin", "main"]);

    await finishCommand(work, "AUTH-123", fakePr());
    const files = gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.match(files, /upstream\.txt/);
    assert.match(files, /note\.txt/);
  });

  test("rebase conflict aborts and leaves a clean tree", async () => {
    const { work, origin, tree, root } = await readyTask();
    writeFileSync(join(tree, "README.md"), "task edit\n");
    await commitCommand(tree, "AUTH-123: edit readme");

    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "README.md"), "upstream edit\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream readme"]);
    gitPushSetup(other, ["origin", "main"]);

    await assert.rejects(() => finishCommand(work, "AUTH-123", fakePr()), /Could not rebase/);
    assert.equal(await isClean(tree), true);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
  });

  test("skips rebase when --no-rebase is set", async () => {
    const { work, tree, root, origin } = await readyTask();
    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream change"]);
    gitPushSetup(other, ["origin", "main"]);

    await finishCommand(work, "AUTH-123", { ...fakePr(), rebase: false });
    const files = gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.doesNotMatch(files, /upstream\.txt/);
    assert.match(files, /note\.txt/);
  });

  test("refuses to squash after a push", async () => {
    const { work } = await readyTask();
    await finishCommand(work, "AUTH-123", fakePr());

    await assert.rejects(
      () => finishCommand(work, "AUTH-123", { ...fakePr(), squash: true }),
      TaskStateError,
    );
  });

  test("does not rebase after the first push even if origin/main moved", async () => {
    const { work, tree, root, origin } = await readyTask();
    await finishCommand(work, "AUTH-123", fakePr());

    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream change"]);
    gitPushSetup(other, ["origin", "main"]);

    writeFileSync(join(tree, "review.txt"), "review fix\n");
    await commitCommand(tree, "AUTH-123: address review");
    const gh = fakePr("https://github.com/acme/backend/pull/1");
    const result = await finishCommand(work, "AUTH-123", gh);

    assert.equal(result.already, false);
    assert.equal(result.pr_url, "https://github.com/acme/backend/pull/1");
    assert.equal(gh.calls.length, 0);
    const files = gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.doesNotMatch(files, /upstream\.txt/);
    assert.match(files, /review\.txt/);
    assert.match(gitRun(origin, ["ls-tree", "-r", "--name-only", "agit/AUTH-123"]), /review\.txt/);
  });

  test("records the new base after a successful rebase", async () => {
    const { work, origin, root } = await readyTask();
    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream change"]);
    gitPushSetup(other, ["origin", "main"]);
    const upstreamSha = gitRun(other, ["rev-parse", "HEAD"]).trim();

    await finishCommand(work, "AUTH-123", fakePr());
    const task = loadTask(work, "AUTH-123");
    assert.equal(task.base_ref, "origin/main");
    assert.equal(task.base_sha, upstreamSha);
  });

  test("keeps a successful rebase when later checks fail", async () => {
    const { work, tree, root, origin } = await readyTask({ checks: ["false"] });
    const other = cloneRepo({ root, origin });
    writeFileSync(join(other, "upstream.txt"), "from a teammate\n");
    gitRun(other, ["add", "-A"]);
    gitRun(other, ["commit", "-m", "upstream change"]);
    gitPushSetup(other, ["origin", "main"]);

    await assert.rejects(() => finishCommand(work, "AUTH-123", fakePr()), ChecksFailed);
    assert.match(gitRun(tree, ["ls-tree", "-r", "--name-only", "HEAD"]), /upstream\.txt/);
    assert.doesNotMatch(gitRun(origin, ["branch"]), /AUTH-123/);
    assert.equal(await isClean(tree), true);
  });

  test("refuses to finish when the worktree directory is missing", async () => {
    const { work, tree } = await readyTask();
    rmSync(tree, { recursive: true, force: true });
    assert.equal(existsSync(tree), false);

    await assert.rejects(() => finishCommand(work, "AUTH-123", fakePr()), /worktree is missing/);
  });

  test("skips PR creation when pr.provider is none", async () => {
    const { work, origin } = await readyTask();
    const profile = loadProfile(work);
    profile.pr.provider = "none";
    saveProfile(work, profile);
    const gh = fakePr();

    const result = await finishCommand(work, "AUTH-123", gh);
    assert.equal(result.pr_url, null);
    assert.equal(result.status, "pushed");
    assert.equal(result.already, false);
    assert.equal(loadTask(work, "AUTH-123").status, "pushed");
    assert.match(gitRun(origin, ["branch"]), /AUTH-123/);
    assert.equal(gh.calls.length, 0);

    const again = await finishCommand(work, "AUTH-123", gh);
    assert.equal(again.already, true);
    assert.equal(again.status, "pushed");
    assert.equal(gh.calls.length, 0);
  });

  test("opens a GitLab merge request when pr.provider is gitlab", async () => {
    const { work } = await readyTask();
    const profile = loadProfile(work);
    profile.pr.provider = "gitlab";
    profile.repo.owner = "acme";
    profile.repo.name = "backend";
    saveProfile(work, profile);
    const gh = fakePr("https://gitlab.com/acme/backend/-/merge_requests/3");

    const result = await finishCommand(work, "AUTH-123", gh);
    assert.equal(result.pr_url, "https://gitlab.com/acme/backend/-/merge_requests/3");
    assert.match(result.message, /merge request/);
    assert.equal(gh.calls[0].repo, "acme/backend");
  });

  test("createDraftMr fails clearly when glab is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-noglab-"));
    dirs.push(dir);
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      await assert.rejects(
        () =>
          createDraftMr(dir, {
            base: "main",
            head: "agit/T1",
            title: "t",
            body: "b",
          }),
        PublishFailed,
      );
    } finally {
      process.env.PATH = previous;
    }
  });

  test("createDraftMr forwards flags to glab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-glab-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "glab"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > "$(dirname "$0")/args"\necho https://gitlab.com/acme/backend/-/merge_requests/1\n`,
    );
    chmodSync(join(dir, "glab"), 0o755);

    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      const url = await createDraftMr(dir, {
        base: "main",
        head: "agit/T1",
        title: "t",
        body: "b",
        repo: "acme/backend",
      });
      assert.equal(url, "https://gitlab.com/acme/backend/-/merge_requests/1");
      const args = readFileSync(join(dir, "args"), "utf8");
      assert.match(args, /--draft/);
      assert.match(args, /--repo acme\/backend/);
      assert.match(args, /--source-branch agit\/T1/);
      assert.match(args, /--target-branch main/);
    } finally {
      process.env.PATH = previous;
    }
  });

  test("strips a leading # from --issue in the PR body", async () => {
    const created = repo();
    await initCommand(created.work, { yes: true, install: false, checks: ["true"] });
    gitRun(created.work, ["add", "-A"]);
    gitRun(created.work, ["commit", "-m", "chore: init agit"]);
    await startCommand(created.work, "AUTH-123", { issue: "#12" });
    const tree = taskWork(created.work, "AUTH-123");
    writeFileSync(join(tree, "note.txt"), "ok\n");
    await commitCommand(tree, "AUTH-123: add note");

    const gh = fakePr();
    await finishCommand(created.work, "AUTH-123", gh);
    assert.match(gh.calls[0].body, /Closes #12/);
    assert.doesNotMatch(gh.calls[0].body, /Closes ##12/);
  });
});
