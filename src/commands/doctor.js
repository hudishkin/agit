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
import { hookPath, hooksInstalled, installHooks } from "../hooks.js";
import { inspectIsolation } from "../mirror.js";
import { listPruneCandidates, staleHint } from "../prune.js";
import { providerOf } from "../prhost.js";
import { enforcementOf, sandboxOf } from "../profile.js";
import { loadWorkspace } from "../store.js";
import {
  detectAgents,
  inspectAgentSandbox,
  inspectHostPublishEnv,
  inspectWorktreeCredentials,
  probeRuntime,
  sandboxRoots,
} from "../sandbox.js";
import { installAgentGuardsCommand } from "./guards.js";

const execFileAsync = promisify(execFile);

export const LAYERS = {
  environment: "Environment",
  server: "Layer 1: server-side rules (cannot be bypassed locally)",
  agent: "Layer 2: agent tool-call guards (block the command before the shell)",
  git: "Layer 3: git pre-push hook (guardrail, bypassable with --no-verify)",
  credential: "Layer 4: push credential boundary",
  sandbox: "Layer 5: agent OS sandbox",
};

async function hasCommand(name) {
  try {
    await execFileAsync("which", [name], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function runCli(name, args) {
  try {
    const { stdout } = await execFileAsync(name, args, { encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

async function gh(args) {
  return runCli("gh", args);
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
  let store = null;
  if (repo) {
    try {
      const workspace = await loadWorkspace(cwd, { required: false });
      store = workspace.store;
      profile = workspace.profile;
    } catch {
      store = null;
      profile = null;
    }
  }
  if (profile) {
    try {
      const location = store?.kind === "home" ? store.dir : ".agit/profile.yml";
      add(checks, "environment", "profile", "ok", `Loaded ${location}`);
      add(checks, "environment", "store", "ok", store?.kind === "home" ? `Store is home (${store.dir})` : "Store is in the repository");
      add(
        checks,
        "environment",
        "enforcement",
        "ok",
        profile.workflow.enforcement === "remote"
          ? "Enforcement is remote: local git is allowed, publish is blocked"
          : `Enforcement is ${profile.workflow.enforcement}`,
      );
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
    add(checks, "environment", "profile", "fail", "agit is not initialized. Run agit init --yes or agit init --yes --store home");
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

  if (repo && profile) {
    try {
      const stale = await listPruneCandidates(store, profile);
      const hint = staleHint(stale.length);
      add(
        checks,
        "environment",
        "stale_tasks",
        stale.length ? "warn" : "ok",
        hint ?? "No stale task worktrees",
      );
    } catch {
      add(checks, "environment", "stale_tasks", "unknown", "Could not inspect stale tasks");
    }
  }

  return { repo, profile, store };
}

async function checkServerLayer(checks, profile) {
  const provider = providerOf(profile);
  add(checks, "server", "pr_provider", "ok", `pr.provider is ${provider}`);

  if (provider === "none") {
    add(checks, "server", "gh", "ok", "Host CLI is not required (pr.provider is none)");
    add(checks, "server", "server_rules", "unknown", "Server-side rules are not checked when pr.provider is none");
    return;
  }

  if (provider === "gitlab") {
    if (!(await hasCommand("glab"))) {
      add(checks, "server", "glab", "warn", "glab is not on PATH; cannot open a draft merge request");
      add(checks, "server", "server_rules", "unknown", "agit protect is GitHub-only; configure protected branches on GitLab");
      return;
    }
    if ((await runCli("glab", ["auth", "status"])) === null) {
      add(checks, "server", "glab", "warn", "glab is installed but not authenticated. Run glab auth login");
      add(checks, "server", "server_rules", "unknown", "agit protect is GitHub-only; configure protected branches on GitLab");
      return;
    }
    add(checks, "server", "glab", "ok", "glab is installed and authenticated");
    add(checks, "server", "server_rules", "unknown", "agit protect is GitHub-only; configure protected branches on GitLab");
    return;
  }

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

async function checkSandboxLayer(checks, cwd, { store, profile, isolation }) {
  if (!profile) {
    return;
  }
  const mode = sandboxOf(profile);
  if (mode !== "agents") {
    add(
      checks,
      "sandbox",
      "sandbox_mode",
      "ok",
      "workflow.sandbox is off. Agent OS sandbox is not required",
    );
    return;
  }

  add(checks, "sandbox", "sandbox_mode", "ok", "workflow.sandbox is agents");

  const runtime = await probeRuntime();
  add(checks, "sandbox", "sandbox_runtime", runtime.ok ? "ok" : "fail", runtime.message);

  add(checks, "sandbox", "sandbox_isolate", isolation?.isolated ? "ok" : "fail", isolation?.isolated
    ? "origin is the local mirror"
    : "sandbox=agents requires origin to be the local mirror. agit start enables it; or run agit isolate");

  const hostPat = inspectHostPublishEnv();
  add(checks, "sandbox", hostPat.id, hostPat.status, hostPat.message);

  const agents = await detectAgents();
  const present = Object.entries(agents).filter(([, onPath]) => onPath);
  const roots = sandboxRoots(store, cwd);

  if (roots.length === 0) {
    add(
      checks,
      "sandbox",
      "sandbox_config",
      "warn",
      "No task worktree yet. agit start writes sandbox configs, isolates origin, and locks git credentials",
    );
    return;
  }

  const credResults = await Promise.all(roots.map((root) => inspectWorktreeCredentials(root)));
  const credFail = credResults.find((result) => result.status === "fail");
  add(
    checks,
    "sandbox",
    "sandbox_credentials",
    credFail ? "fail" : "ok",
    credFail?.message ?? "Task worktrees have git credentials locked. agit finish pushes from the main checkout",
  );

  if (present.length === 0) {
    add(
      checks,
      "sandbox",
      "sandbox_agents",
      "warn",
      "No Cursor, Claude Code, or Codex on PATH. agit start still writes sandbox configs",
    );
    return;
  }

  for (const [agent] of present) {
    const results = roots.map((root) => inspectAgentSandbox(root, agent));
    const failed = results.find((result) => result.status === "fail");
    add(
      checks,
      "sandbox",
      failed?.id ?? `${agent}_sandbox`,
      failed ? "fail" : "ok",
      failed ? `${failed.message} (${agent})` : `${agent} sandbox config is fail-closed in the task worktree`,
    );
  }
}

export async function doctorCommand(cwd, { fix = false } = {}) {
  const checks = [];
  const { repo, profile, store } = await checkEnvironment(checks, cwd);

  let fixed = null;
  if (fix) {
    if (!repo || !profile) {
      add(checks, "environment", "fix", "fail", "Cannot apply --fix until this directory is a Git repo with agit init");
    } else {
      const hook = await installHooks(cwd, profile);
      const guards = await installAgentGuardsCommand(cwd, {
        claude: true,
        cursor: true,
        copilot: true,
        enforcement: enforcementOf(profile),
      });
      fixed = {
        hooks: Boolean(hook),
        hook_backup: hook?.backup ?? null,
        guards: guards.guards ?? [],
        files: guards.files ?? [],
      };
      add(checks, "environment", "fix", "ok", "Reinstalled the pre-push hook and agent guards");
    }
  }

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
        "origin is the local mirror. The agent cannot read agit.pushUrl. git push <url> and mutating curl can still reach GitHub if the guard is not running. This is not a sandbox.",
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
    await checkSandboxLayer(checks, cwd, { store, profile, isolation });
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
    fixed,
    message: lines.join("\n"),
  };
}
