import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeAgentsMd } from "../agentsmd.js";
import { detectChecks } from "../detect-checks.js";
import { installAgentGuardsCommand } from "./guards.js";
import { AgitError, NotInitialized } from "../errors.js";
import { defaultBranch, isRepo, remoteUrl } from "../git.js";
import { ensureGitignore } from "../gitignore.js";
import { installHooks } from "../hooks.js";
import { writePrTemplate, writeSetupAgent } from "../onboard.js";
import { PACKAGE_NAME } from "../paths.js";
import { detectProvider } from "../prhost.js";
import {
  DEFAULT_PROFILE,
  ENFORCEMENT_MODES,
  loadProfile,
  normalizeEnforcement,
  profileExists,
  saveProfile,
} from "../profile.js";

const execFileAsync = promisify(execFile);

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
      hint: "Run: agit init --yes [--mode remote|protocol] [--default-branch main] [--checks <cmd>]",
    });
  }

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (options.mode && !ENFORCEMENT_MODES.includes(options.mode)) {
    throw new AgitError({
      code: "error",
      message: `Unknown enforcement mode: ${options.mode}`,
      hint: "Use --mode remote, --mode protocol, or --mode patch.",
    });
  }

  const existed = profileExists(cwd);
  const current = existed ? loadProfile(cwd) : DEFAULT_PROFILE;
  const detectedUrl = options.repo ?? current.repo.url ?? (await remoteUrl(cwd)) ?? undefined;
  const parsed = parseRepoUrl(detectedUrl);
  const branch = options.defaultBranch ?? current.repo.default_branch ?? (await defaultBranch(cwd));
  const checks = options.checks?.length
    ? options.checks
    : existed && current.checks?.length
      ? current.checks
      : detectChecks(cwd);
  const enforcement = options.guardOnly
    ? "remote"
    : options.mode
      ? normalizeEnforcement(options.mode)
      : existed
        ? current.workflow.enforcement
        : "remote";

  const profile = {
    ...current,
    repo: {
      ...current.repo,
      ...parsed,
      default_branch: branch,
    },
    workflow: {
      ...current.workflow,
      enforcement,
    },
    checks,
    pr: {
      ...current.pr,
      base: branch,
      provider: existed ? current.pr.provider : detectProvider(detectedUrl),
    },
  };

  saveProfile(cwd, profile);
  const gitignore = ensureGitignore(cwd);
  writeAgentsMd(cwd, undefined, enforcement);
  const setup = writeSetupAgent(cwd);
  const prTemplate = writePrTemplate(cwd);
  const hook = options.hooks === false ? null : await installHooks(cwd, profile);
  const rules =
    options.rules === false
      ? { files: [] }
      : await installAgentGuardsCommand(cwd, {
          claude: true,
          cursor: true,
          copilot: true,
          enforcement,
        });

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
    enforcement,
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
