import { NotInitialized } from "../errors.js";
import { isRepo } from "../git.js";
import { installHooks } from "../hooks.js";
import { loadProfile, profileExists } from "../profile.js";

export async function installHooksCommand(cwd) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  const profile = profileExists(cwd) ? loadProfile(cwd) : undefined;
  const { path, backup } = await installHooks(cwd, profile);

  return {
    hook: path,
    backup,
    message: backup
      ? `Installed pre-push hook at ${path}\nBacked up the previous hook to ${backup}`
      : `Installed pre-push hook at ${path}`,
  };
}
