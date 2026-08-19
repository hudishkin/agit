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
  finishChosen,
  finishOf,
  loadProfile,
  normalizeEnforcement,
  parseFinish,
  profileExists,
  sandboxOf,
  saveProfile,
} from "../profile.js";
import {
  loadStoreProfile,
  normalizeStoreKind,
  parseRepoUrl,
  resolveStore,
  saveStoreProfile,
  STORE_KINDS,
  storeHasProfile,
  storeProfilePath,
  writeStoreSource,
} from "../store.js";

export { parseRepoUrl };

const execFileAsync = promisify(execFile);


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
      hint: "Run: agit init --yes [--finish ask|human|agent] [--default-branch main] [--checks <cmd>]",
    });
  }

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (options.finish) {
    if (!parseFinish(options.finish)) {
      throw new AgitError({
        code: "error",
        message: `Unknown finish policy: ${options.finish}`,
        hint: "Use --finish ask, human, or agent.",
      });
    }
  }

  if (options.mode && !ENFORCEMENT_MODES.includes(options.mode)) {
    throw new AgitError({
      code: "error",
      message: `Unknown enforcement mode: ${options.mode}`,
      hint: "Use --mode remote or --mode protocol.",
    });
  }

  if (options.store && !STORE_KINDS.includes(options.store)) {
    throw new AgitError({
      code: "error",
      message: `Unknown store: ${options.store}`,
      hint: "Use --store repo or --store home.",
    });
  }

  const storeKind = normalizeStoreKind(options.store);
  const store = await resolveStore(cwd, { preferred: storeKind });
  const existed = storeKind === "home" ? storeHasProfile(store) : profileExists(cwd);
  const current = existed
    ? storeKind === "home"
      ? loadStoreProfile(store)
      : loadProfile(cwd)
    : DEFAULT_PROFILE;
  const detectedUrl = options.repo ?? current.repo.url ?? (await remoteUrl(cwd)) ?? undefined;
  const parsed = parseRepoUrl(detectedUrl);
  const branch = options.defaultBranch ?? current.repo.default_branch ?? (await defaultBranch(cwd));
  const checks = options.checks?.length
    ? options.checks
    : existed && current.checks?.length
      ? current.checks
      : detectChecks(cwd);
  const enforcement = options.mode
    ? normalizeEnforcement(options.mode)
    : existed
      ? current.workflow.enforcement
      : "remote";

  const sandbox = options.sandbox
    ? "agents"
    : existed
      ? sandboxOf(current)
      : "off";
  const finish = options.finish
    ? parseFinish(options.finish)
    : existed && finishChosen(current)
      ? current.workflow.finish
      : undefined;

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
      sandbox,
      ...(finish ? { finish } : {}),
    },
    checks,
    pr: {
      ...current.pr,
      base: branch,
      provider: existed ? current.pr.provider : detectProvider(detectedUrl),
    },
  };

  const home = storeKind === "home";
  if (home) {
    writeStoreSource(store);
    saveStoreProfile(store, profile);
  } else {
    saveProfile(cwd, profile);
  }
  const gitignore = home ? { added: [] } : ensureGitignore(cwd);
  if (!home) {
    writeAgentsMd(cwd, undefined, enforcement);
  }
  const setup = home ? null : writeSetupAgent(cwd);
  const prTemplate = home ? { path: null, written: false } : writePrTemplate(cwd);
  const hook = options.hooks === false ? null : await installHooks(cwd, profile);
  const rules =
    home || options.rules === false
      ? { files: [] }
      : await installAgentGuardsCommand(cwd, {
          claude: true,
          cursor: true,
          copilot: true,
          enforcement,
          profile,
        });

  let install = { attempted: false, installed: false, reason: "skipped" };
  if (home) {
    install = { attempted: false, installed: false, reason: "home_store" };
  } else if (options.install !== false) {
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
    profile: home ? storeProfilePath(store) : ".agit/profile.yml",
    store: storeKind,
    store_dir: home ? store.dir : join(cwd, ".agit"),
    agents: home ? null : "AGENTS.md",
    gitignore: gitignore.added,
    default_branch: profile.repo.default_branch,
    enforcement,
    sandbox,
    finish: finishOf(profile),
    finish_explicit: finishChosen(profile),
    checks: profile.checks,
    install,
    hooks: Boolean(hook),
    hook_backup: hook?.backup ?? null,
    setup,
    pr_template: prTemplate,
    rules: rules.files,
    guards: rules.guards ?? [],
    message: [
      home
        ? `Initialized agit in ${store.dir}. The repository working tree was not changed.`
        : "Initialized agit.",
      hook?.backup ? `Backed up your previous pre-push hook to ${hook.backup}` : null,
      sandbox === "agents"
        ? "workflow.sandbox is agents: agit start writes agent sandbox configs and isolates the clone."
        : "Next: agit start <task-id>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
