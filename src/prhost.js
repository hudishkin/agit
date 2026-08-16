import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PublishFailed } from "./errors.js";
import { createDraftPr, inspectPr as inspectGithubPr } from "./gh.js";

const execFileAsync = promisify(execFile);

export const PR_PROVIDERS = ["github", "gitlab", "none"];

export function normalizeProvider(value) {
  return PR_PROVIDERS.includes(value) ? value : "github";
}

export function providerOf(profile) {
  return normalizeProvider(profile?.pr?.provider);
}

export function detectProvider(url) {
  if (!url) {
    return "github";
  }
  const text = String(url);
  if (/gitlab/i.test(text)) {
    return "gitlab";
  }
  if (/github/i.test(text)) {
    return "github";
  }
  return "github";
}

export async function createDraftMr(cwd, { base, head, title, body, repo }) {
  const args = [
    "mr",
    "create",
    "--draft",
    "--yes",
    "--no-editor",
    "--target-branch",
    base,
    "--source-branch",
    head,
    "--title",
    title,
    "--description",
    body,
  ];
  if (repo) {
    args.push("--repo", repo);
  }

  try {
    const { stdout } = await execFileAsync("glab", args, { cwd, encoding: "utf8" });
    const url = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!url) {
      throw new Error("glab did not print a merge request URL");
    }
    return url;
  } catch (error) {
    if (error instanceof PublishFailed) {
      throw error;
    }
    throw new PublishFailed(
      "Checks passed, but remote publish failed.",
      "Install and authenticate GitLab CLI (glab), then run agit finish again.",
      { error: error.stderr?.toString().trim() || error.message },
    );
  }
}

export function openerFor(provider) {
  if (provider === "gitlab") {
    return createDraftMr;
  }
  return createDraftPr;
}

export async function inspectGitlabMr(cwd, url) {
  if (!url) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("glab", ["mr", "view", url, "--output", "json"], {
      cwd,
      encoding: "utf8",
    });
    const data = JSON.parse(stdout);
    const state = String(data.state ?? "").toLowerCase();
    return {
      state: data.state ?? null,
      merged: Boolean(data.merged_at) || state === "merged",
    };
  } catch {
    return null;
  }
}

export async function inspectMergeRequest(cwd, url) {
  if (!url) {
    return null;
  }
  if (/gitlab/i.test(url)) {
    return inspectGitlabMr(cwd, url);
  }
  return inspectGithubPr(cwd, url);
}
