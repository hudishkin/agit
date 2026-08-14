import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PublishFailed } from "./errors.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout.replace(/\n$/, "");
  } catch (error) {
    if (allowFail) {
      return null;
    }
    throw error;
  }
}

async function runGitZ(cwd, args) {
  const output = await runGit(cwd, args);
  if (!output) {
    return [];
  }
  return output.split("\0").filter(Boolean);
}

export async function isRepo(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  return result === "true";
}

export async function defaultBranch(cwd) {
  const remoteHead = await runGit(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"], { allowFail: true });
  if (remoteHead) {
    return remoteHead.replace(/^origin\//, "");
  }

  for (const name of ["main", "master"]) {
    const exists = await runGit(cwd, ["rev-parse", "--verify", name], { allowFail: true });
    if (exists !== null) {
      return name;
    }
  }

  throw new Error("Cannot determine default branch");
}

export async function remoteUrl(cwd, name = "origin") {
  return runGit(cwd, ["remote", "get-url", name], { allowFail: true });
}

export async function setRemoteUrl(cwd, name, url) {
  await runGit(cwd, ["remote", "set-url", name, url]);
}

export async function getConfig(cwd, key) {
  return runGit(cwd, ["config", "--get", key], { allowFail: true });
}

export async function setConfig(cwd, key, value) {
  await runGit(cwd, ["config", key, value]);
}

export async function unsetConfig(cwd, key) {
  await runGit(cwd, ["config", "--unset", key], { allowFail: true });
}

export async function currentBranch(cwd) {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function isClean(cwd) {
  const status = await runGit(cwd, ["status", "--porcelain"]);
  return status === "";
}

export async function fetch(cwd) {
  return runGit(cwd, ["fetch", "origin"], { allowFail: true });
}

export async function createBranch(cwd, name, startPoint) {
  await runGit(cwd, ["checkout", "-b", name, startPoint]);
}

export async function checkout(cwd, name) {
  await runGit(cwd, ["checkout", name]);
}

export async function branchExists(cwd, name) {
  const result = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    allowFail: true,
  });
  return result !== null;
}

export async function refExists(cwd, ref) {
  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFail: true,
  });
  return result !== null;
}

export async function isAncestor(cwd, ancestor, descendant) {
  const result = await runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFail: true,
  });
  return result !== null;
}

export async function remoteBranchSha(cwd, branch, remote = "origin") {
  const output = await runGit(cwd, ["ls-remote", remote, `refs/heads/${branch}`], { allowFail: true });
  if (!output) {
    return null;
  }
  return output.split(/\s+/)[0] || null;
}

export async function gitDir(cwd) {
  return runGit(cwd, ["rev-parse", "--git-dir"]);
}

export async function hooksPath(cwd) {
  const path = await runGit(cwd, ["rev-parse", "--git-path", "hooks"]);
  return resolve(cwd, path);
}

async function pushTokenPath(cwd) {
  const path = await runGit(cwd, ["rev-parse", "--git-path", "agit-allow-push"]);
  return resolve(cwd, path);
}

export async function listCommitCandidates(cwd) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGitZ(cwd, ["diff", "-z", "--name-only"]),
    runGitZ(cwd, ["diff", "-z", "--name-only", "--cached"]),
    runGitZ(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);

  return [...new Set([...unstaged, ...staged, ...untracked])].sort();
}

export async function add(cwd, paths) {
  if (paths.length === 0) {
    return;
  }
  await runGit(cwd, ["add", "--", ...paths]);
}

export async function commit(cwd, message, paths = []) {
  const args = ["commit", "-m", message];
  if (paths.length > 0) {
    args.push("--only", "--", ...paths);
  }
  await runGit(cwd, args);
  return revParse(cwd, "HEAD");
}

export async function push(cwd, branch, { allow = false, url } = {}) {
  if (!allow) {
    throw new PublishFailed("Direct git push is not allowed.", "Use agit finish <task-id>.");
  }

  const tokenPath = await pushTokenPath(cwd);
  const sha = await revParse(cwd, "HEAD");
  writeFileSync(tokenPath, `${sha}\n`);

  try {
    await runGit(cwd, ["push", "-u", url ?? "origin", branch]);
  } finally {
    rmSync(tokenPath, { force: true });
  }
}

export async function revParse(cwd, ref) {
  return runGit(cwd, ["rev-parse", ref]);
}

export async function logOneline(cwd, range) {
  const output = await runGit(cwd, ["log", "--oneline", range], { allowFail: true });
  if (!output) {
    return [];
  }
  return output.split("\n").filter(Boolean);
}

export async function diffNames(cwd, range) {
  const output = await runGit(cwd, ["diff", "-z", "--name-only", range], { allowFail: true });
  if (!output) {
    return [];
  }
  return output.split("\0").filter(Boolean);
}

export async function commitSubject(cwd, ref = "HEAD") {
  return runGit(cwd, ["log", "-1", "--pretty=%s", ref]);
}

export async function firstCommitSubject(cwd, base) {
  const output = await runGit(cwd, ["log", "--reverse", "--pretty=%s", `${base}..HEAD`], {
    allowFail: true,
  });
  if (!output) {
    return commitSubject(cwd);
  }
  return output.split("\n").filter(Boolean)[0] ?? commitSubject(cwd);
}

export async function squashCommits(cwd, base, message) {
  const original = await revParse(cwd, "HEAD");
  const mergeBase = await runGit(cwd, ["merge-base", base, "HEAD"]);

  await runGit(cwd, ["reset", "--soft", mergeBase]);
  try {
    return await commit(cwd, message);
  } catch (error) {
    await runGit(cwd, ["reset", "--soft", original], { allowFail: true });
    throw error;
  }
}
