import { AgitError, NotInitialized } from "../errors.js";
import { isRepo } from "../git.js";
import { ensureGitignore } from "../gitignore.js";
import { disableIsolation, enableIsolation, inspectIsolation } from "../mirror.js";
import { loadProfile, profileExists } from "../profile.js";

export async function isolateCommand(cwd, { undo = false } = {}) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  const profile = loadProfile(cwd);

  if (undo) {
    const state = await inspectIsolation(cwd, profile);
    if (!state.origin_is_mirror && !state.isolated) {
      return {
        isolated: false,
        origin: state.origin,
        message: "origin already points at the real remote.",
      };
    }

    try {
      const { origin } = await disableIsolation(cwd, profile);
      return {
        isolated: false,
        origin,
        message: `Restored origin to ${origin}.\nThe local mirror is still at .agit/mirror.git; git fetch now talks to the real remote again.`,
      };
    } catch (error) {
      throw new AgitError({
        code: "error",
        message: error.message,
        hint: "Set the real remote with: git config agit.pushUrl <url>",
      });
    }
  }

  try {
    const { mirror, push_url, already } = await enableIsolation(cwd, profile);
    ensureGitignore(cwd);

    return {
      isolated: true,
      origin: mirror,
      push_url,
      message: [
        already ? "origin already points at the local mirror." : `Rewrote origin to ${mirror}.`,
        `The real remote is stored in this clone's git config (agit.pushUrl), not in profile.yml.`,
        `git push origin and git push "$(git remote get-url origin)" stay on this machine.`,
        `git fetch no longer talks to GitHub; run agit start to refresh the default branch.`,
      ].join("\n"),
    };
  } catch (error) {
    throw new AgitError({
      code: "error",
      message: error.message,
      hint: "origin must exist. Run this in a clone that already has a remote.",
    });
  }
}
