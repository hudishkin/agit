import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { PROFILE_FILE } from "./paths.js";

export const ENFORCEMENT_MODES = ["remote", "protocol", "patch"];

export function normalizeEnforcement(value) {
  return ENFORCEMENT_MODES.includes(value) ? value : "protocol";
}

export function enforcementOf(profile) {
  return normalizeEnforcement(profile?.workflow?.enforcement);
}

export const DEFAULT_PROFILE = {
  repo: {
    default_branch: "main",
  },
  workflow: {
    branch_prefix: "agit/",
    require_clean_tree_on_start: true,
    allow_direct_push: false,
    allow_force_push: false,
    finish_mode: "draft_pr",
    squash_on_finish: false,
    one_push_policy: true,
    prune_after_days: 14,
    // Missing key in an existing profile.yml also loads as protocol.
    enforcement: "protocol",
  },
  checks: [],
  checks_timeout_sec: 900,
  commit: {
    scope: "all",
    denylist: [".env", ".env.*", "credentials.json", "*.pem", "*.p12"],
    allowlist: ["*.example", "*.sample", "*.template", "*.dist"],
    scan_contents: true,
  },
  pr: {
    provider: "github",
    draft: true,
    title_template: "{task_id}: {summary}",
    base: "main",
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(extra)) {
    return extra;
  }
  if (extra && typeof extra === "object" && base && typeof base === "object" && !Array.isArray(base)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      result[key] = deepMerge(base[key], value);
    }
    return result;
  }
  return extra === undefined ? base : extra;
}

export function profilePath(cwd) {
  return join(cwd, PROFILE_FILE);
}

export function profileExists(cwd) {
  return existsSync(profilePath(cwd));
}

export function loadProfile(cwd) {
  const raw = yaml.load(readFileSync(profilePath(cwd), "utf8")) ?? {};
  return deepMerge(DEFAULT_PROFILE, raw);
}

export function saveProfile(cwd, profile) {
  const path = profilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const body = yaml.dump(profile, { lineWidth: 120, noRefs: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
