import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "agit test",
      GIT_AUTHOR_EMAIL: "test@agit.dev",
      GIT_COMMITTER_NAME: "agit test",
      GIT_COMMITTER_EMAIL: "test@agit.dev",
    },
  });
}

function configure(cwd) {
  git(cwd, ["config", "user.email", "test@agit.dev"]);
  git(cwd, ["config", "user.name", "agit test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

export function createGitRepo({ branch = "main" } = {}) {
  if (!process.env.AGIT_HOME && process.env.AGIT_STORE === undefined) {
    process.env.AGIT_STORE = "repo";
  }
  const root = mkdtempSync(join(tmpdir(), "agit-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");

  mkdirSync(work, { recursive: true });
  git(work, ["init", "-b", branch]);
  configure(work);
  writeFileSync(join(work, "README.md"), "hello\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "-m", "init"]);
  git(root, ["clone", "--bare", work, origin]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", branch]);

  return { root, origin, work, branch };
}

export function gitRun(cwd, args) {
  return git(cwd, args);
}

// Setup helper: publishes without the agit pre-push guard, the way a human would
// when bootstrapping a repository.
export function gitPushSetup(cwd, args) {
  return git(cwd, ["push", "--no-verify", ...args]);
}

// A second working copy of the same origin, for changes that arrive from other people.
export function taskWork(work, taskId) {
  const base = existsSync(work) ? realpathSync(work) : work;
  return join(base, ".agit/worktrees", taskId);
}

export function cloneRepo({ root, origin }, name = "other") {
  const path = join(root, name);
  git(root, ["clone", origin, path]);
  configure(path);
  return path;
}
