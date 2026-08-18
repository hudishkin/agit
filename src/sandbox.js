import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release as osRelease, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { addWorktreeConfig, enableWorktreeConfig, getWorktreeConfig, setWorktreeConfig, unsetWorktreeConfig } from "./git.js";
import { sandboxOf } from "./profile.js";
import { resolveTaskTree } from "./root.js";
import { listTaskIds, loadTask } from "./taskstore.js";

const execFileAsync = promisify(execFile);

export const CURSOR_SANDBOX_FILE = ".cursor/sandbox.json";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CODEX_CONFIG_FILE = ".codex/config.toml";

export const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

export const PACKAGE_REGISTRIES = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "proxy.golang.org",
];

const CREDENTIAL_PATHS = ["~/.ssh", "~/.config/gh", "~/.git-credentials"];

const CODEX_TEMPLATE = `sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false
`;

export async function commandOnPath(name) {
  try {
    await execFileAsync("which", [name], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export async function detectAgents() {
  return {
    cursor: (await commandOnPath("cursor")) || (await commandOnPath("cursor-agent")),
    claude: await commandOnPath("claude"),
    codex: await commandOnPath("codex"),
  };
}

function linuxKernelAtLeast(major, minor) {
  const match = /^(\d+)\.(\d+)/.exec(osRelease());
  if (!match) {
    return false;
  }
  const foundMajor = Number(match[1]);
  const foundMinor = Number(match[2]);
  return foundMajor > major || (foundMajor === major && foundMinor >= minor);
}

export async function probeRuntime({ platform = osPlatform() } = {}) {
  if (platform === "darwin") {
    const seatbelt = await commandOnPath("sandbox-exec");
    return {
      platform,
      ok: seatbelt,
      seatbelt,
      message: seatbelt
        ? "macOS Seatbelt (sandbox-exec) is available"
        : "sandbox-exec is missing; Cursor/Claude/Codex cannot sandbox on this Mac",
    };
  }

  if (platform === "linux") {
    const landlock = linuxKernelAtLeast(6, 2);
    const bwrap = await commandOnPath("bwrap");
    const socat = await commandOnPath("socat");
    const ok = landlock || (bwrap && socat);
    return {
      platform,
      ok,
      landlock,
      bwrap,
      socat,
      message: ok
        ? landlock
          ? "Linux Landlock is available"
          : "bubblewrap and socat are available"
        : "Linux sandbox runtime missing: need kernel >= 6.2 (Landlock) or bubblewrap + socat",
    };
  }

  return {
    platform,
    ok: false,
    message: "Native Windows has no agent sandbox; run Cursor/Claude/Codex in WSL2",
  };
}

function readJson(path) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function union(list, extra) {
  const result = [...asArray(list)];
  for (const item of extra) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function hostPattern(host) {
  return [host, `*.${host}`];
}

export function cursorSandboxPolicy() {
  return {
    type: "workspace_readwrite",
    networkPolicy: {
      default: "deny",
      allow: [...PACKAGE_REGISTRIES],
      deny: GIT_HOSTS.flatMap(hostPattern),
    },
  };
}

export function writeCursorSandbox(cwd) {
  const path = join(cwd, CURSOR_SANDBOX_FILE);
  let current = {};
  try {
    current = readJson(path);
  } catch {
    current = {};
  }
  const wanted = cursorSandboxPolicy();
  const network = current.networkPolicy && typeof current.networkPolicy === "object" ? current.networkPolicy : {};
  const next = {
    ...current,
    type: current.type === "workspace_readonly" ? "workspace_readonly" : "workspace_readwrite",
    networkPolicy: {
      ...network,
      default: "deny",
      allow: union(network.allow, wanted.networkPolicy.allow).filter(
        (host) => !GIT_HOSTS.some((git) => host === git || host === `*.${git}` || host.endsWith(`.${git}`)),
      ),
      deny: union(network.deny, wanted.networkPolicy.deny),
    },
  };
  writeJson(path, next);
  return path;
}

export function writeClaudeSandbox(cwd) {
  const path = join(cwd, CLAUDE_SETTINGS_FILE);
  let current = {};
  try {
    current = readJson(path);
  } catch {
    current = {};
  }
  const sandbox = current.sandbox && typeof current.sandbox === "object" ? current.sandbox : {};
  const filesystem = sandbox.filesystem && typeof sandbox.filesystem === "object" ? sandbox.filesystem : {};
  const network = sandbox.network && typeof sandbox.network === "object" ? sandbox.network : {};
  current.sandbox = {
    ...sandbox,
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      ...filesystem,
      denyRead: union(filesystem.denyRead, CREDENTIAL_PATHS),
    },
    network: {
      ...network,
      deniedDomains: union(network.deniedDomains, GIT_HOSTS),
      allowedDomains: union(network.allowedDomains, PACKAGE_REGISTRIES).filter(
        (host) => !GIT_HOSTS.includes(host),
      ),
    },
  };
  writeJson(path, current);
  return path;
}

export function writeCodexSandbox(cwd) {
  const path = join(cwd, CODEX_CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, CODEX_TEMPLATE);
    return path;
  }

  let text = readFileSync(path, "utf8");
  if (/^\s*sandbox_mode\s*=/m.test(text)) {
    text = text.replace(/^\s*sandbox_mode\s*=\s*"[^"]*"/m, 'sandbox_mode = "workspace-write"');
  } else {
    text = `sandbox_mode = "workspace-write"\n\n${text}`;
  }
  if (/network_access\s*=/.test(text)) {
    text = text.replace(/network_access\s*=\s*(true|false)/, "network_access = false");
  } else {
    text += `\n[sandbox_workspace_write]\nnetwork_access = false\n`;
  }
  writeFileSync(path, text);
  return path;
}

export function writeAgentSandbox(cwd) {
  return [writeCursorSandbox(cwd), writeClaudeSandbox(cwd), writeCodexSandbox(cwd)];
}

function denyCovers(list, host) {
  return asArray(list).some((pattern) => pattern === host || pattern === `*.${host}` || pattern === `*${host}`);
}

export function inspectCursorSandbox(cwd) {
  const path = join(cwd, CURSOR_SANDBOX_FILE);
  if (!existsSync(path)) {
    return { id: "cursor_sandbox", status: "fail", message: `Missing ${CURSOR_SANDBOX_FILE}` };
  }
  let config;
  try {
    config = readJson(path);
  } catch {
    return { id: "cursor_sandbox", status: "fail", message: `Cannot parse ${CURSOR_SANDBOX_FILE}` };
  }
  if (config.type === "insecure_none") {
    return { id: "cursor_sandbox", status: "fail", message: `${CURSOR_SANDBOX_FILE} type is insecure_none` };
  }
  const policy = config.networkPolicy ?? {};
  const missing = GIT_HOSTS.filter((host) => !denyCovers(policy.deny, host));
  if (missing.length > 0) {
    return {
      id: "cursor_sandbox",
      status: "fail",
      message: `${CURSOR_SANDBOX_FILE} does not deny ${missing.join(", ")}. Cursor Defaults allow github.com unless it is in deny`,
    };
  }
  if ((policy.default ?? "deny") !== "deny") {
    return { id: "cursor_sandbox", status: "fail", message: `${CURSOR_SANDBOX_FILE} networkPolicy.default is not deny` };
  }
  return { id: "cursor_sandbox", status: "ok", message: `${CURSOR_SANDBOX_FILE} denies git hosts` };
}

export function inspectClaudeSandbox(cwd) {
  const path = join(cwd, CLAUDE_SETTINGS_FILE);
  if (!existsSync(path)) {
    return { id: "claude_sandbox", status: "fail", message: `Missing ${CLAUDE_SETTINGS_FILE}` };
  }
  let config;
  try {
    config = readJson(path);
  } catch {
    return { id: "claude_sandbox", status: "fail", message: `Cannot parse ${CLAUDE_SETTINGS_FILE}` };
  }
  const sandbox = config.sandbox ?? {};
  if (sandbox.enabled !== true) {
    return { id: "claude_sandbox", status: "fail", message: "Claude sandbox.enabled is not true" };
  }
  if (sandbox.failIfUnavailable !== true) {
    return { id: "claude_sandbox", status: "fail", message: "Claude sandbox.failIfUnavailable is not true" };
  }
  if (sandbox.allowUnsandboxedCommands !== false) {
    return { id: "claude_sandbox", status: "fail", message: "Claude allowUnsandboxedCommands is not false" };
  }
  const denied = sandbox.network?.deniedDomains ?? [];
  const missing = GIT_HOSTS.filter((host) => !denyCovers(denied, host));
  if (missing.length > 0) {
    return { id: "claude_sandbox", status: "fail", message: `Claude sandbox does not deny ${missing.join(", ")}` };
  }
  return { id: "claude_sandbox", status: "ok", message: "Claude sandbox is fail-closed and denies git hosts" };
}

export function inspectCodexSandbox(cwd) {
  const path = join(cwd, CODEX_CONFIG_FILE);
  if (!existsSync(path)) {
    return { id: "codex_sandbox", status: "fail", message: `Missing ${CODEX_CONFIG_FILE}` };
  }
  const text = readFileSync(path, "utf8");
  const mode = /^\s*sandbox_mode\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (mode === "danger-full-access") {
    return { id: "codex_sandbox", status: "fail", message: "Codex sandbox_mode is danger-full-access" };
  }
  if (mode && mode !== "workspace-write" && mode !== "read-only") {
    return { id: "codex_sandbox", status: "fail", message: `Codex sandbox_mode is ${mode}` };
  }
  if (/network_access\s*=\s*true/.test(text)) {
    return { id: "codex_sandbox", status: "fail", message: "Codex network_access is true" };
  }
  return { id: "codex_sandbox", status: "ok", message: "Codex sandbox_mode is workspace-write with network off" };
}

const INSPECTORS = {
  cursor: inspectCursorSandbox,
  claude: inspectClaudeSandbox,
  codex: inspectCodexSandbox,
};

export function sandboxRoots(store, cwd) {
  const roots = [];
  const seen = new Set();
  if (!store?.dir) {
    return roots;
  }
  for (const id of listTaskIds(store.dir)) {
    const task = loadTask(store.dir, id);
    if (task.status === "aborted") {
      continue;
    }
    const path = resolveTaskTree(store, task, cwd);
    if (!path || seen.has(path) || !existsSync(path)) {
      continue;
    }
    seen.add(path);
    roots.push(path);
  }
  return roots;
}

export function inspectAgentSandbox(cwd, agent) {
  return INSPECTORS[agent](cwd);
}

export function applySandbox(cwd, profile) {
  if (sandboxOf(profile) !== "agents") {
    return [];
  }
  return writeAgentSandbox(cwd);
}

export const CREDENTIAL_LOCK_HELPER =
  '!f() { echo "agit-credential-lock" >&2; exit 1; }; f';

export const HOST_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GLAB_TOKEN"];

export async function lockWorktreeCredentials(cwd) {
  await enableWorktreeConfig(cwd);
  await unsetWorktreeConfig(cwd, "credential.helper");
  await setWorktreeConfig(cwd, "credential.helper", "");
  await addWorktreeConfig(cwd, "credential.helper", CREDENTIAL_LOCK_HELPER);
}

export async function inspectWorktreeCredentials(cwd) {
  const raw = (await getWorktreeConfig(cwd, "credential.helper")) ?? "";
  const helpers = raw.split("\n").map((line) => line.trim());
  if (!helpers.some((helper) => helper.includes("agit-credential-lock"))) {
    return {
      id: "sandbox_credentials",
      status: "fail",
      message: "Worktree git credentials are not locked. agit start writes a fail-closed credential.helper",
    };
  }
  if (helpers.some((helper) => /osxkeychain|gh auth|libsecret|manager|store/i.test(helper))) {
    return {
      id: "sandbox_credentials",
      status: "fail",
      message: "Worktree still has a host credential helper",
    };
  }
  return {
    id: "sandbox_credentials",
    status: "ok",
    message: "Worktree credential.helper is locked. git push from this tree cannot use the host PAT",
  };
}

export function inspectHostPublishEnv(env = process.env) {
  const present = HOST_TOKEN_VARS.filter((name) => Boolean(env[name]));
  return {
    id: "sandbox_host_pat",
    status: "ok",
    message: present.length
      ? `${present.join(", ")} is in this process for agit finish. Task worktrees do not use it for git`
      : "No GH_TOKEN in this process. agit finish uses host gh auth or git credentials, not the task worktree",
  };
}
