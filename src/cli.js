import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { abortCommand } from "./commands/abort.js";
import { commitCommand } from "./commands/commit.js";
import { doneCommand } from "./commands/done.js";
import { doctorCommand } from "./commands/doctor.js";
import { finishCommand } from "./commands/finish.js";
import { guardCommand } from "./commands/guard.js";
import { installAgentGuardsCommand } from "./commands/guards.js";
import { installHooksCommand } from "./commands/hooks.js";
import { initCommand } from "./commands/init.js";
import { isolateCommand } from "./commands/isolate.js";
import { promptCommand } from "./commands/prompt.js";
import { pruneCommand } from "./commands/prune.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { AgitError } from "./errors.js";
import { renderError, renderSuccess } from "./output.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

function applyOutputOptions(command) {
  return command
    .option("--json", "Machine-readable JSON output")
    .option("-C, --cwd <path>", "Run as if started in this directory");
}

function cwdFrom(command) {
  return resolve(command.optsWithGlobals().cwd ?? process.cwd());
}

async function runCommand(name, command, fn) {
  const json = Boolean(command.optsWithGlobals().json);
  try {
    const data = await fn();
    renderSuccess(name, data, { json });
    if (data?.ok === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof AgitError) {
      renderError(name, error, { json });
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

export function createProgram() {
  const program = new Command();

  program
    .name("agit")
    .description("Task-to-draft-PR workflow for AI coding agents")
    .version(pkg.version)
    .option("--json", "Machine-readable JSON output")
    .option("-C, --cwd <path>", "Run as if started in this directory");

  applyOutputOptions(
    program
      .command("init")
      .description("Initialize agit in this repository")
      .option("--yes", "Non-interactive init")
      .option("--repo <url>", "Repository URL")
      .option("--default-branch <name>", "Default branch")
      .option("--checks <command>", "Check to run before finish", (value, previous) => [...previous, value], [])
      .option("--mode <mode>", "Enforcement: remote (default), protocol, or patch")
      .option("--guard-only", "Remote enforcement; local git stays allowed")
      .option("--sandbox", "Write Cursor, Claude Code, and Codex sandbox configs on start")
      .option("--store <store>", "repo (default) or home (~/.agit/<project>)")
      .option("--no-install", "Do not add agit as a devDependency")
      .option("--no-hooks", "Do not install the pre-push hook")
      .option("--no-rules", "Do not write Cursor/Claude/Copilot rule files")
      .action(async (opts, command) => {
        await runCommand("init", command, () => initCommand(cwdFrom(command), opts));
      }),
  );

  applyOutputOptions(
    program
      .command("start")
      .description("Start a task branch")
      .argument("<task-id>", "Task id, for example AUTH-123")
      .option("--title <title>", "Title stored for the draft PR")
      .option("--body <body>", "Body stored for the draft PR")
      .option("--issue <number>", "GitHub issue to close from the draft PR")
      .option("--sandbox", "Enable agent sandboxes without re-running init")
      .action(async (taskId, opts, command) => {
        await runCommand("start", command, () =>
          startCommand(cwdFrom(command), taskId, {
            title: opts.title,
            body: opts.body,
            issue: opts.issue,
            sandbox: Boolean(opts.sandbox),
          }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("commit")
      .description("Create a local commit for the active task")
      .requiredOption("-m, --message <message>", "Commit message")
      .option("-f, --files <paths...>", "Commit only these paths")
      .action(async (opts, command) => {
        await runCommand("commit", command, () =>
          commitCommand(cwdFrom(command), opts.message, { files: opts.files }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("status")
      .description("Show task status")
      .argument("[task-id]", "Task id, defaults to the current branch")
      .option("--all", "List every task with age, dirty state, and PR")
      .action(async (taskId, opts, command) => {
        await runCommand("status", command, () =>
          statusCommand(cwdFrom(command), taskId, { all: Boolean(opts.all) }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("finish")
      .description("Run checks, push, and open or update the draft PR or MR")
      .argument("<task-id>", "Task id, for example AUTH-123")
      .option("--squash", "Squash commits before the first push")
      .option("--no-squash", "Do not squash")
      .option("--no-rebase", "Do not rebase onto the default branch before the first push")
      .action(async (taskId, opts, command) => {
        await runCommand("finish", command, () =>
          finishCommand(cwdFrom(command), taskId, { squash: opts.squash, rebase: opts.rebase }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("abort")
      .description("Abort a local task without pushing")
      .argument("<task-id>", "Task id, for example AUTH-123")
      .action(async (taskId, _opts, command) => {
        await runCommand("abort", command, () => abortCommand(cwdFrom(command), taskId));
      }),
  );

  applyOutputOptions(
    program
      .command("done")
      .description("Remove a local task worktree after its PR is merged")
      .argument("<task-id>", "Task id, for example AUTH-123")
      .action(async (taskId, _opts, command) => {
        await runCommand("done", command, () => doneCommand(cwdFrom(command), taskId));
      }),
  );

  applyOutputOptions(
    program
      .command("prune")
      .description("List or remove stale local task worktrees and branches")
      .option("--apply", "Delete candidates instead of listing them")
      .action(async (opts, command) => {
        await runCommand("prune", command, () => pruneCommand(cwdFrom(command), { apply: Boolean(opts.apply) }));
      }),
  );

  applyOutputOptions(
    program
      .command("doctor")
      .description("Report environment, hooks, and sandbox status")
      .option("--fix", "Install missing hooks and agent guards")
      .action(async (opts, command) => {
        await runCommand("doctor", command, () =>
          doctorCommand(cwdFrom(command), { fix: Boolean(opts.fix) }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("install-hooks")
      .description("Install a local pre-push hook")
      .action(async (_opts, command) => {
        await runCommand("install-hooks", command, () => installHooksCommand(cwdFrom(command)));
      }),
  );

  applyOutputOptions(
    program
      .command("prompt")
      .description("Print a copy-paste prompt for an agent")
      .argument("<task-id>", "Task id, for example AUTH-123")
      .action(async (taskId, _opts, command) => {
        await runCommand("prompt", command, () => promptCommand(cwdFrom(command), taskId));
      }),
  );

  applyOutputOptions(
    program
      .command("install-agent-guards")
      .description("Install Cursor and Claude tool-call guards plus instruction files")
      .option("--claude", "Claude Code guard and CLAUDE.md")
      .option("--cursor", "Cursor guard and .cursor/rules/agit.mdc")
      .option("--copilot", "Copilot instructions")
      .action(async (opts, command) => {
        await runCommand("install-agent-guards", command, () =>
          installAgentGuardsCommand(cwdFrom(command), opts),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("isolate")
      .description("Point origin at a local mirror so git push origin cannot reach GitHub")
      .option("--undo", "Restore origin to the real remote")
      .action(async (opts, command) => {
        await runCommand("isolate", command, () => isolateCommand(cwdFrom(command), opts));
      }),
  );

  program
    .command("guard", { hidden: true })
    .description("Tool-call hook adapter used by the agent guards")
    .requiredOption("--vendor <vendor>", "cursor or claude")
    .action(async (opts) => {
      await guardCommand(opts.vendor);
    });

  return program;
}

export async function run(argv = process.argv) {
  const program = createProgram();
  await program.parseAsync(argv);
}
