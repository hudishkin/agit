import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultBranch, isClean, isRepo } from "../git.js";
import {
  CLAUDE_GUARD_SCRIPT,
  CLAUDE_HOOK_COMMAND,
  CURSOR_GUARD_SCRIPT,
  CURSOR_HOOK_COMMAND,
  readGuardConfig,
} from "../guardfiles.js";
import { hookPath, hooksInstalled } from "../hooks.js";
import { inspectIsolation } from "../mirror.js";
import { loadProfile, profileExists } from "../profile.js";

const execFileAsync = promisify(execFile);

export const LAYERS = {
  environment: "Environment",
  server: "Layer 1: GitHub server-side rules (cannot be bypassed locally)",
  agent: "Layer 2: agent tool-call guards (block the command before the shell)",
  git: "Layer 3: git pre-push hook (guardrail, bypassable with --no-verify)",
  credential: "Layer 4: push credential boundary",
};

async function hasCommand(name) {
  try {
    await execFileAsync("which", [name], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function gh(args) {
  try {
    const { stdout } = await execFileAsync("gh", args, { encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

function add(checks, layer, id, status, message) {
  checks.push({ layer, id, status, message });
}

async function checkEnvironment(checks, cwd) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(
    checks,
    "environment",
    "node",
    nodeMajor >= 20 ? "ok" : "fail",
    nodeMajor >= 20 ? `Node ${process.versions.node}` : `Node ${process.versions.node} is too old (need >= 20)`,
  );

  const gitOk = await hasCommand("git");
  add(checks, "environment", "git", gitOk ? "ok" : "fail", gitOk ? "git is on PATH" : "git is not on PATH");

  const repo = await isRepo(cwd);
  add(
    checks,
    "environment",
    "repo",
    repo ? "ok" : "fail",
    repo ? "Current directory is a Git repository" : "Current directory is not a Git repository",
  );

  let profile = null;
  if (repo && profileExists(cwd)) {
    try {
      profile = loadProfile(cwd);
      add(checks, "environment", "profile", "ok", "Loaded .agit/profile.yml");
      try {
        const branch = await defaultBranch(cwd);
        add(
          checks,
          "environment",
          "default_branch",
          "ok",
          `Default branch is ${profile.repo.default_branch ?? branch}`,
        );
      } catch {
        add(checks, "environment", "default_branch", "fail", "Cannot resolve the default branch");
      }
    } catch {
      add(checks, "environment", "profile", "fail", ".agit/profile.yml exists but cannot be parsed");
    }
  } else {
    add(checks, "environment", "profile", "fail", "agit is not initialized. Run agit init --yes");
  }

  const agitOnPath = await hasCommand("agit");
  add(
    checks,
    "environment",
    "agit",
    agitOnPath ? "ok" : "warn",
    agitOnPath ? "agit is on PATH" : "agit is not on PATH; agents must use npx agit",
  );

  if (repo) {
    const clean = await isClean(cwd);
    add(checks, "environment", "dirty", clean ? "ok" : "warn", clean ? "Working tree is clean" : "Working tree is dirty");
  }

  const foreign = existsSync(join(cwd, ".agit.toml"));
  add(
    checks,
    "environment",
    "foreign_agit",
    foreign ? "warn" : "ok",
    foreign ? "Found .agit.toml from another agit tool" : "No foreign agit metadata",
  );

  return { repo, profile };
}

async function checkServerLayer(checks, profile) {
  if (!(await hasCommand("gh"))) {
    add(checks, "server", "gh", "warn", "gh is not on PATH; cannot read GitHub rules or open a draft PR");
    add(checks, "server", "server_rules", "unknown", "Cannot verify server-side rules without gh");
    return;
  }

  if ((await gh(["auth", "status"])) === null) {
    add(checks, "server", "gh", "warn", "gh is installed but not authenticated. Run gh auth login");
    add(checks, "server", "server_rules", "unknown", "Cannot verify server-side rules without gh auth");
    return;
  }

  add(checks, "server", "gh", "ok", "gh is installed and authenticated");

  const owner = profile?.repo?.owner;
  const name = profile?.repo?.name;
  if (!owner || !name) {
    add(checks, "server", "server_rules", "unknown", "repo.owner and repo.name are not set in .agit/profile.yml");
    return;
  }

  const slug = `${owner}/${name}`;
  const branch = profile.repo.default_branch;

  const rulesetTypes = new Set();
  const listRaw = await gh(["api", `repos/${slug}/rulesets`]);
  if (listRaw) {
    let rulesets = [];
    try {
      rulesets = JSON.parse(listRaw);
    } catch {
      rulesets = [];
    }
    for (const ruleset of rulesets) {
      if (ruleset?.target !== "branch" || ruleset?.enforcement !== "active") {
        continue;
      }
      const detailRaw = await gh(["api", `repos/${slug}/rulesets/${ruleset.id}`]);
      if (!detailRaw) {
        continue;
      }
      try {
        for (const rule of JSON.parse(detailRaw).rules ?? []) {
          rulesetTypes.add(rule.type);
        }
      } catch {
        // ignore an unreadable ruleset
      }
    }
  }

  const classic = await gh(["api", `repos/${slug}/branches/${branch}/protection`]);
  const hasPr = rulesetTypes.has("pull_request");
  const hasNoForce = rulesetTypes.has("non_fast_forward");

  if (hasPr && hasNoForce) {
    add(checks, "server", "server_rules", "ok", `Ruleset protects ${branch}: pull request required, force-push blocked`);
  } else if (classic) {
    add(checks, "server", "server_rules", "ok", `Classic branch protection is enabled on ${branch}`);
  } else if (rulesetTypes.size > 0) {
    const missing = [!hasPr ? "pull_request" : null, !hasNoForce ? "non_fast_forward" : null].filter(Boolean);
    add(checks, "server", "server_rules", "warn", `Ruleset exists but is missing: ${missing.join(", ")}. Run agit protect`);
  } else {
    add(
      checks,
      "server",
      "server_rules",
      "warn",
      `No server-side protection on ${branch}. An agent can still push there. Run agit protect`,
    );
  }

  const repoRaw = await gh(["api", `repos/${slug}`]);
  if (!repoRaw) {
    add(checks, "server", "secret_push_protection", "unknown", "Cannot read repository settings");
    return;
  }
  let status = null;
  try {
    status = JSON.parse(repoRaw).security_and_analysis?.secret_scanning_push_protection?.status ?? null;
  } catch {
    status = null;
  }
  add(
    checks,
    "server",
    "secret_push_protection",
    status === "enabled" ? "ok" : "warn",
    status === "enabled"
      ? "Secret scanning push protection is enabled"
      : "Secret scanning push protection is not enabled; agit only scans locally",
  );
}

function checkGuard(checks, cwd, vendor, id, scriptRelative, hookCommand, describe) {
  const scriptPath = join(cwd, scriptRelative);
  const { exists, config } = readGuardConfig(cwd, vendor);

  if (!exists) {
    add(checks, "agent", id, "warn", `${describe} is not configured. Run agit install-agent-guards`);
    return;
  }

  if (!existsSync(scriptPath)) {
    add(checks, "agent", id, "fail", `${describe} references a missing script ${scriptRelative}`);
    return;
  }

  if (vendor === "cursor") {
    const list = Array.isArray(config.hooks?.beforeShellExecution) ? config.hooks.beforeShellExecution : [];
    const entry = list.find((item) => item?.command === hookCommand);
    if (!entry) {
      add(checks, "agent", id, "warn", `${describe} does not run the agit guard`);
      return;
    }
    if (entry.failClosed !== true) {
      add(checks, "agent", id, "warn", `${describe} is fail-open; set failClosed: true`);
      return;
    }
    add(checks, "agent", id, "ok", `${describe} blocks git mutations before the shell runs`);
    return;
  }

  const groups = Array.isArray(config.hooks?.PreToolUse) ? config.hooks.PreToolUse : [];
  const wired = groups.some((group) =>
    (Array.isArray(group?.hooks) ? group.hooks : []).some((item) => item?.command === hookCommand),
  );
  if (!wired) {
    add(checks, "agent", id, "warn", `${describe} does not run the agit guard`);
    return;
  }
  const deny = Array.isArray(config.permissions?.deny) ? config.permissions.deny : [];
  add(
    checks,
    "agent",
    id,
    "ok",
    deny.length > 0
      ? `${describe} blocks git mutations, with ${deny.length} deny rules as a second layer`
      : `${describe} blocks git mutations before the shell runs`,
  );
}

async function checkGitLayer(checks, cwd, profile) {
  const path = await hookPath(cwd);
  if (!(await hooksInstalled(cwd))) {
    add(
      checks,
      "git",
      "pre_push_hook",
      "warn",
      `No agit pre-push hook at ${path}. Run agit install-hooks`,
    );
    return;
  }

  const body = readFileSync(path, "utf8");
  const branch = profile?.repo?.default_branch;
  if (branch && !body.includes(`protected="${branch}"`)) {
    add(
      checks,
      "git",
      "pre_push_hook",
      "warn",
      `The pre-push hook does not protect ${branch}. Run agit install-hooks to regenerate it`,
    );
    return;
  }

  add(checks, "git", "pre_push_hook", "ok", `pre-push hook is active at ${path}`);
}

export async function doctorCommand(cwd) {
  const checks = [];
  const { repo, profile } = await checkEnvironment(checks, cwd);

  await checkServerLayer(checks, profile);

  checkGuard(checks, cwd, "cursor", "cursor_guard", CURSOR_GUARD_SCRIPT, CURSOR_HOOK_COMMAND, "Cursor beforeShellExecution guard");
  checkGuard(checks, cwd, "claude", "claude_guard", CLAUDE_GUARD_SCRIPT, CLAUDE_HOOK_COMMAND, "Claude Code PreToolUse guard");

  if (repo) {
    await checkGitLayer(checks, cwd, profile);
    const isolation = profile ? await inspectIsolation(cwd, profile) : null;
    if (!isolation) {
      add(
        checks,
        "credential",
        "credential_boundary",
        "warn",
        "Cannot check the local mirror until agit is initialized. Run agit isolate",
      );
    } else if (isolation.isolated) {
      add(
        checks,
        "credential",
        "credential_boundary",
        "ok",
        `origin is the local mirror; agit finish publishes to ${isolation.push_url}. git push <url> still uses your credential`,
      );
    } else if (isolation.flagged && !isolation.origin_is_mirror) {
      add(
        checks,
        "credential",
        "credential_boundary",
        "warn",
        "This clone is marked isolated, but origin does not point at .agit/mirror.git. Run agit isolate",
      );
    } else {
      add(
        checks,
        "credential",
        "credential_boundary",
        "warn",
        "origin still points at the real remote. git push origin uses your credential. Run agit isolate",
      );
    }
  }

  const failed = checks.some((check) => check.status === "fail");
  const lines = [];
  for (const [layer, title] of Object.entries(LAYERS)) {
    const group = checks.filter((check) => check.layer === layer);
    if (group.length === 0) {
      continue;
    }
    lines.push(title);
    for (const check of group) {
      lines.push(`  ${check.status.toUpperCase().padEnd(7)} ${check.id}: ${check.message}`);
    }
  }

  return {
    ok: !failed,
    checks,
    message: lines.join("\n"),
  };
}
