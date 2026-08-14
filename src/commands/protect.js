import { spawn } from "node:child_process";
import { AgitError, NotInitialized, PublishFailed } from "../errors.js";
import { isRepo } from "../git.js";
import { loadProfile, profileExists } from "../profile.js";

export function rulesetBody() {
  return {
    name: "agit",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
    ],
  };
}

function defaultApply(cwd, slug, body) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "--method", "POST", `repos/${slug}/rulesets`, "--input", "-"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new PublishFailed("Could not create the ruleset.", "Check that gh is authenticated and you have admin rights.", { error: stderr.trim() }));
    });

    child.stdin.end(JSON.stringify(body));
  });
}

export async function protectCommand(cwd, { apply = false } = {}, { applyRuleset = defaultApply } = {}) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const profile = loadProfile(cwd);
  const { owner, name } = profile.repo;
  if (!owner || !name) {
    throw new AgitError({
      code: "error",
      message: "Cannot tell which GitHub repository this is.",
      hint: "Set repo.owner and repo.name in .agit/profile.yml, or run agit init --yes --repo <url>.",
    });
  }

  const body = rulesetBody();
  const slug = `${owner}/${name}`;

  if (!apply) {
    return {
      applied: false,
      repo: slug,
      ruleset: body,
      message: [
        `Would create a branch ruleset on ${slug} for the default branch:`,
        "- block branch deletion",
        "- block force-push",
        "- require a pull request with 1 approval",
        "",
        "This is the only layer an agent cannot bypass locally.",
        "Run: agit protect --apply",
      ].join("\n"),
    };
  }

  await applyRuleset(cwd, slug, body);

  return {
    applied: true,
    repo: slug,
    ruleset: body,
    message: `Created the agit branch ruleset on ${slug}.\nRun agit doctor to confirm.`,
  };
}
