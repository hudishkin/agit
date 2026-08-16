import { NotInitialized } from "../errors.js";
import { isRepo } from "../git.js";
import { applyPrune, listPruneCandidates, staleHint } from "../prune.js";
import { loadProfile, profileExists } from "../profile.js";
import { agitRoot } from "../root.js";

function formatCandidates(candidates) {
  return candidates
    .map((item) => {
      const skip = item.skipped ? `  skipped (${item.skipped})` : "";
      return `${item.task_id}  ${item.reason}${skip}`;
    })
    .join("\n");
}

export async function pruneCommand(cwd, { apply = false, inspectPr } = {}) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const root = await agitRoot(cwd);
  const profile = loadProfile(cwd);
  const candidates = await listPruneCandidates(root, profile, { inspectPr });

  if (candidates.length === 0) {
    return {
      apply,
      candidates: [],
      removed: [],
      stale_count: 0,
      message: "No stale tasks.",
    };
  }

  if (!apply) {
    return {
      apply: false,
      candidates,
      removed: [],
      stale_count: candidates.length,
      message: `Would remove ${candidates.length} stale ${candidates.length === 1 ? "task" : "tasks"}. Re-run with: agit prune --apply\n${formatCandidates(candidates)}`,
    };
  }

  const removed = await applyPrune(root, candidates);
  const deleted = removed.filter((item) => item.removed);
  const skipped = removed.filter((item) => item.skipped);
  const hint = skipped.length ? `\n${staleHint(skipped.length)}` : "";

  return {
    apply: true,
    candidates,
    removed,
    stale_count: skipped.length,
    message:
      deleted.length === 0 && skipped.length > 0
        ? `Nothing removed.\n${formatCandidates(removed)}`
        : `Removed ${deleted.length} stale ${deleted.length === 1 ? "task" : "tasks"}.\n${formatCandidates(removed)}${hint}`,
  };
}
