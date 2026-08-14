import { basename } from "node:path";
import { minimatch } from "minimatch";
import { DEFAULT_PROFILE } from "./profile.js";

// dot: true so that * also matches leading dots; without it *.example never
// matches .env.example.
function matchesAny(file, patterns) {
  return patterns.some(
    (pattern) => minimatch(file, pattern, { dot: true }) || minimatch(basename(file), pattern, { dot: true }),
  );
}

export function matchesAllowlist(file, patterns = DEFAULT_PROFILE.commit.allowlist) {
  return matchesAny(file, patterns);
}

export function matchesDenylist(
  file,
  patterns = DEFAULT_PROFILE.commit.denylist,
  allowlist = DEFAULT_PROFILE.commit.allowlist,
) {
  if (matchesAny(file, allowlist)) {
    return false;
  }
  return matchesAny(file, patterns);
}

export function findDeniedFiles(
  files,
  patterns = DEFAULT_PROFILE.commit.denylist,
  allowlist = DEFAULT_PROFILE.commit.allowlist,
) {
  return files.filter((file) => matchesDenylist(file, patterns, allowlist));
}
