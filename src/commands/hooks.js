import { NotInitialized } from "../errors.js";
import { isRepo } from "../git.js";
import { installHooks } from "../hooks.js";
import { loadWorkspace } from "../store.js";

export async function installHooksCommand(cwd) {
  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  let profile;
  try {
    profile = (await loadWorkspace(cwd, { required: false })).profile ?? undefined;
  } catch {
    profile = undefined;
  }
  const { path, backup } = await installHooks(cwd, profile);

  return {
    hook: path,
    backup,
    message: backup
      ? `Installed pre-push hook at ${path}\nBacked up the previous hook to ${backup}`
      : `Installed pre-push hook at ${path}`,
  };
}
