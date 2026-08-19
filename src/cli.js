import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { abortCommand } from "./commands/abort.js";
import { commitCommand } from "./commands/commit.js";
import { doneCommand } from "./commands/done.js";
import { doctorCommand } from "./commands/doctor.js";
import { editCommand } from "./commands/edit.js";
import { finishCommand } from "./commands/finish.js";
import { guardCommand } from "./commands/guard.js";
import { initCommand } from "./commands/init.js";
import { isolateCommand } from "./commands/isolate.js";
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
      .addOption(new Option("--mode <mode>", "Legacy enforcement: remote or protocol").hideHelp())
      .option("--finish <policy>", "Who publishes: ask (default), human, or agent")
      .option("--sandbox", "Write Cursor, Claude Code, and Codex sandbox configs on start")
      .option("--store <store>", "home (default, ~/.agit/<project>) or repo (.agit in the clone)")
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
      .option("--finish <policy>", "Save finish policy: ask, human, or agent")
      .action(async (taskId, opts, command) => {
        await runCommand("start", command, () =>
          startCommand(cwdFrom(command), taskId, {
            title: opts.title,
            body: opts.body,
            issue: opts.issue,
            sandbox: Boolean(opts.sandbox),
            finish: opts.finish,
          }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("edit")
      .description("Open this project's agit profile in $VISUAL or $EDITOR")
      .action(async (_opts, command) => {
        await runCommand("edit", command, () => editCommand(cwdFrom(command)));
      }),
  );

  applyOutputOptions(
    program
      .command("commit", { hidden: true })
      .description("Create a local commit for the active task (protocol enforcement)")
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
      .argument("[task-id]", "Task id, for example AUTH-123")
      .option("--stale", "List stale local tasks instead of a single merged task")
      .option("--apply", "With --stale, delete candidates instead of listing them")
      .action(async (taskId, opts, command) => {
        await runCommand("done", command, () => {
          if (opts.apply && !opts.stale) {
            throw new AgitError({
              code: "error",
              message: "--apply requires --stale.",
              hint: "Run: agit done --stale --apply",
            });
          }
          if (opts.stale) {
            return pruneCommand(cwdFrom(command), { apply: Boolean(opts.apply) });
          }
          if (!taskId) {
            throw new AgitError({
              code: "error",
              message: "Task id is required unless --stale is set.",
              hint: "Run: agit done <task-id>  or  agit done --stale",
            });
          }
          return doneCommand(cwdFrom(command), taskId);
        });
      }),
  );

  applyOutputOptions(
    program
      .command("prune", { hidden: true })
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
      .option("--undo-isolate", "Restore origin to the real remote")
      .action(async (opts, command) => {
        await runCommand("doctor", command, () =>
          doctorCommand(cwdFrom(command), {
            fix: Boolean(opts.fix),
            undoIsolate: Boolean(opts.undoIsolate),
          }),
        );
      }),
  );

  applyOutputOptions(
    program
      .command("isolate", { hidden: true })
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
