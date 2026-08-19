import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import yaml from "js-yaml";
import { detectChecks } from "./detect-checks.js";
import { NotInitialized } from "./errors.js";
import { defaultBranch, isRepo, remoteUrl } from "./git.js";
import { detectProvider } from "./prhost.js";
import { DEFAULT_PROFILE, finishChosen, loadProfileAt, profileExistsAt, saveProfileAt } from "./profile.js";
import { agitRoot } from "./root.js";

export const STORE_KINDS = ["repo", "home"];

export function parseRepoUrl(url) {
  if (!url) {
    return {};
  }

  const github = String(url).match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (github) {
    return { url, owner: github[1], name: github[2] };
  }

  const gitlab = String(url).match(/(?:^|@|\/\/)([^/:]*gitlab[^/:]*)[:/](.+?)(?:\.git)?$/i);
  if (gitlab) {
    const parts = gitlab[2].replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { url, owner: parts.slice(0, -1).join("/"), name: parts.at(-1) };
    }
  }

  return { url };
}

export function normalizeStoreKind(value) {
  return STORE_KINDS.includes(value) ? value : "repo";
}

export function agitHome() {
  return process.env.AGIT_HOME || join(homedir(), ".agit");
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "repo"
  );
}

function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 8);
}

export function projectId(root, remote) {
  const parsed = parseRepoUrl(remote);
  const slug =
    parsed.owner && parsed.name ? slugify(`${parsed.owner}-${parsed.name}`) : slugify(basename(root));
  const path = existsSync(root) ? realpathSync(root) : root;
  return `${slug}-${shortHash(path)}`;
}

export function readGlobalConfig(home = agitHome()) {
  const path = join(home, "config.yml");
  if (!existsSync(path)) {
    return {};
  }
  try {
    return yaml.load(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function storeProfilePath(store) {
  return join(store.dir, "profile.yml");
}

export function storeTasksDir(store) {
  return join(store.dir, "tasks");
}

export function storeLogsDir(store) {
  return join(store.dir, "logs");
}

export function storeWorktreesDir(store) {
  return join(store.dir, "worktrees");
}

export function storeMirrorPath(store) {
  return join(store.dir, "mirror.git");
}

export function storeHasProfile(store) {
  return Boolean(store?.dir) && profileExistsAt(storeProfilePath(store));
}

export function loadStoreProfile(store) {
  return loadProfileAt(storeProfilePath(store));
}

export function saveStoreProfile(store, profile) {
  saveProfileAt(storeProfilePath(store), profile);
  return storeProfilePath(store);
}

function repoStore(root) {
  return { kind: "repo", root, dir: join(root, ".agit"), project: null };
}

async function homeStore(root) {
  const remote = (await remoteUrl(root)) ?? null;
  const project = projectId(root, remote);
  return { kind: "home", root, dir: join(agitHome(), project), project, remote };
}

function wantsHome(preferred) {
  if (preferred === "home") {
    return true;
  }
  if (preferred === "repo") {
    return false;
  }
  if (process.env.AGIT_STORE === "home") {
    return true;
  }
  if (process.env.AGIT_STORE === "repo") {
    return false;
  }
  return readGlobalConfig().store === "home";
}

export async function resolveStore(cwd, { preferred } = {}) {
  const root = await agitRoot(cwd);
  const repo = repoStore(root);
  const home = await homeStore(root);
  const repoReady = storeHasProfile(repo);
  const homeReady = storeHasProfile(home);

  if (preferred === "home" || (wantsHome(preferred) && !repoReady)) {
    return home;
  }
  if (repoReady) {
    return repo;
  }
  if (homeReady || wantsHome(preferred)) {
    return home;
  }
  return { kind: "none", root, dir: repo.dir, project: null };
}

export function writeStoreSource(store) {
  if (store.kind !== "home") {
    return null;
  }
  mkdirSync(store.dir, { recursive: true });
  const path = join(store.dir, "source.yml");
  writeFileSync(
    path,
    yaml.dump(
      {
        path: store.root,
        remote: store.remote ?? null,
        project: store.project,
      },
      { lineWidth: 120, noRefs: true },
    ),
  );
  return path;
}

export async function detectedProfile(cwd, overrides = {}) {
  const url = overrides.repo ?? (await remoteUrl(cwd)) ?? undefined;
  const parsed = parseRepoUrl(url);
  const existed = overrides.current;
  const branch = overrides.defaultBranch ?? existed?.repo?.default_branch ?? (await defaultBranch(cwd));
  const checks = overrides.checks?.length
    ? overrides.checks
    : existed?.checks?.length
      ? existed.checks
      : detectChecks(cwd);
  const current = existed ?? DEFAULT_PROFILE;
  const enforcement = overrides.enforcement ?? current.workflow.enforcement ?? "remote";

  return {
    ...current,
    repo: {
      ...current.repo,
      ...parsed,
      default_branch: branch,
    },
    workflow: {
      ...current.workflow,
      enforcement,
      sandbox: overrides.sandbox ?? current.workflow.sandbox ?? "off",
      ...(overrides.finish || finishChosen(current) ? { finish: overrides.finish ?? current.workflow.finish } : {}),
    },
    checks,
    pr: {
      ...current.pr,
      base: branch,
      provider: existed ? current.pr.provider : detectProvider(url),
    },
  };
}

export async function ensureHomeProfile(store, cwd, overrides = {}) {
  writeStoreSource(store);
  if (!storeHasProfile(store)) {
    const current = overrides.current ?? DEFAULT_PROFILE;
    const profile = await detectedProfile(cwd, {
      ...overrides,
      current,
      enforcement: overrides.enforcement ?? (overrides.current ? current.workflow.enforcement : "remote"),
    });
    saveStoreProfile(store, profile);
    return profile;
  }
  return loadStoreProfile(store);
}

export async function loadWorkspace(cwd, { required = true, createHome = false, preferred } = {}) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  let store = await resolveStore(cwd, { preferred });
  if (!storeHasProfile(store) && (createHome || store.kind === "home") && store.kind !== "repo") {
    if (store.kind === "none") {
      store = await resolveStore(cwd, { preferred: "home" });
    }
    if (createHome || wantsHome(preferred)) {
      await ensureHomeProfile(store, store.root);
    }
  }

  if (required && !storeHasProfile(store)) {
    throw new NotInitialized(
      "agit is not initialized.",
      "Run agit init --yes, or agit init --yes --store home to keep state out of the repository.",
    );
  }

  return {
    store,
    root: store.root,
    profile: storeHasProfile(store) ? loadStoreProfile(store) : null,
  };
}
