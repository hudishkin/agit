import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeAgentsMd } from "../agentsmd.js";
import { installAgentGuardsCommand } from "./guards.js";
import { AgitError, NotInitialized } from "../errors.js";
import { defaultBranch, isRepo, remoteUrl } from "../git.js";
import { ensureGitignore } from "../gitignore.js";
import { installHooks } from "../hooks.js";
import { writePrTemplate, writeSetupAgent } from "../onboard.js";
import { PACKAGE_NAME } from "../paths.js";
import { DEFAULT_PROFILE, loadProfile, profileExists, saveProfile } from "../profile.js";

const execFileAsync = promisify(execFile);

export function parseRepoUrl(url) {
  if (!url) {
    return {};
  }

  const match = String(url).match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (!match) {
    return { url };
  }

  return { url, owner: match[1], name: match[2] };
}

export function packageHasAgit(pkg) {
  return Boolean(pkg.dependencies?.[PACKAGE_NAME] || pkg.devDependencies?.[PACKAGE_NAME]);
}

async function defaultNpmInstall(cwd) {
  await execFileAsync("npm", ["install", "-D", PACKAGE_NAME], { cwd, encoding: "utf8" });
}

export async function initCommand(cwd, options = {}, { npmInstall = defaultNpmInstall } = {}) {
  if (!options.yes) {
    throw new AgitError({
      code: "error",
      message: "Non-interactive init requires --yes.",
      hint: "Run: agit init --yes [--default-branch main] [--checks <cmd>]",
    });
  }

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  const current = profileExists(cwd) ? loadProfile(cwd) : DEFAULT_PROFILE;
  const detectedUrl = options.repo ?? current.repo.url ?? (await remoteUrl(cwd)) ?? undefined;
  const parsed = parseRepoUrl(detectedUrl);
  const branch = options.defaultBranch ?? current.repo.default_branch ?? (await defaultBranch(cwd));
  const checks = options.checks?.length ? options.checks : current.checks;

  const profile = {
    ...current,
    repo: {
      ...current.repo,
      ...parsed,
      default_branch: branch,
    },
    checks,
    pr: {
      ...current.pr,
      base: branch,
    },
  };

  saveProfile(cwd, profile);
  const gitignore = ensureGitignore(cwd);
  writeAgentsMd(cwd);
  const setup = writeSetupAgent(cwd);
  const prTemplate = writePrTemplate(cwd);
  const hook = options.hooks === false ? null : await installHooks(cwd, profile);
  const rules =
    options.rules === false
      ? { files: [] }
      : await installAgentGuardsCommand(cwd, { claude: true, cursor: true, copilot: true });

  let install = { attempted: false, installed: false, reason: "skipped" };
  if (options.install !== false) {
    const packagePath = join(cwd, "package.json");
    if (!existsSync(packagePath)) {
      install = { attempted: false, installed: false, reason: "no_package_json" };
    } else {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageHasAgit(pkg)) {
        install = { attempted: false, installed: false, reason: "already_present" };
      } else {
        await npmInstall(cwd);
        install = { attempted: true, installed: true, reason: "added" };
      }
    }
  }

  return {
    profile: ".agit/profile.yml",
    agents: "AGENTS.md",
    gitignore: gitignore.added,
    default_branch: profile.repo.default_branch,
    checks: profile.checks,
    install,
    hooks: Boolean(hook),
    hook_backup: hook?.backup ?? null,
    setup,
    pr_template: prTemplate,
    rules: rules.files,
    guards: rules.guards ?? [],
    message: [
      "Initialized agit.",
      hook?.backup ? `Backed up your previous pre-push hook to ${hook.backup}` : null,
      "Next: agit protect (server-side rules), agit isolate (local mirror), then agit start <task-id>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
