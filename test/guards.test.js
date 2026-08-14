import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { installAgentGuardsCommand } from "../src/commands/guards.js";
import { AgitError } from "../src/errors.js";
import { CLAUDE_HOOK_COMMAND, CURSOR_HOOK_COMMAND } from "../src/guardfiles.js";
import { createGitRepo } from "./helpers/git-harness.js";

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function repo() {
  const created = createGitRepo();
  repos.push(created);
  return created;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("install-agent-guards", () => {
  test("writes Claude, Cursor, and Copilot instructions", async () => {
    const { work } = repo();

    const result = await installAgentGuardsCommand(work);

    assert.equal(result.files.length, 3);
    assert.match(readFileSync(join(work, "CLAUDE.md"), "utf8"), /agit start <task-id>/);
    assert.match(readFileSync(join(work, ".cursor/rules/agit.mdc"), "utf8"), /alwaysApply: true/);
    assert.match(
      readFileSync(join(work, ".github/copilot-instructions.md"), "utf8"),
      /Do not use Git mutations/,
    );
  });

  test("wires a fail-closed Cursor beforeShellExecution guard", async () => {
    const { work } = repo();

    await installAgentGuardsCommand(work, { cursor: true });

    const config = readJson(join(work, ".cursor/hooks.json"));
    assert.equal(config.version, 1);
    const entry = config.hooks.beforeShellExecution.find((item) => item.command === CURSOR_HOOK_COMMAND);
    assert.ok(entry, "guard entry is missing");
    assert.equal(entry.failClosed, true);

    const script = join(work, ".cursor/hooks/agit-guard.sh");
    assert.match(readFileSync(script, "utf8"), /guard --vendor cursor/);
    assert.equal(statSync(script).mode & 0o111, 0o111);
  });

  test("wires a Claude PreToolUse guard and deny rules", async () => {
    const { work } = repo();

    await installAgentGuardsCommand(work, { claude: true });

    const config = readJson(join(work, ".claude/settings.json"));
    const group = config.hooks.PreToolUse.find((item) => item.matcher === "Bash");
    assert.ok(group, "Bash matcher is missing");
    assert.ok(group.hooks.some((item) => item.command === CLAUDE_HOOK_COMMAND));
    assert.ok(config.permissions.deny.includes("Bash(git push:*)"));
    assert.match(readFileSync(join(work, ".claude/hooks/agit-guard.sh"), "utf8"), /guard --vendor claude/);
  });

  test("keeps existing hook entries and instruction text", async () => {
    const { work } = repo();
    mkdirSync(join(work, ".cursor"), { recursive: true });
    writeFileSync(
      join(work, ".cursor/hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: "./team/audit.sh" }],
          afterFileEdit: [{ command: "./team/format.sh" }],
        },
      }),
    );
    writeFileSync(join(work, "CLAUDE.md"), "# Keep me\n\nProject notes.\n");

    await installAgentGuardsCommand(work, { claude: true, cursor: true });

    const config = readJson(join(work, ".cursor/hooks.json"));
    assert.equal(config.hooks.beforeShellExecution.length, 2);
    assert.ok(config.hooks.beforeShellExecution.some((item) => item.command === "./team/audit.sh"));
    assert.equal(config.hooks.afterFileEdit[0].command, "./team/format.sh");

    const claude = readFileSync(join(work, "CLAUDE.md"), "utf8");
    assert.match(claude, /# Keep me/);
    assert.match(claude, /agit start <task-id>/);
  });

  test("merges into Claude settings that have comments", async () => {
    const { work } = repo();
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(
      join(work, ".claude/settings.json"),
      `{
  // keep this permission
  "permissions": {
    "allow": ["Bash(npm test:*)"],
  },
}
`,
    );

    await installAgentGuardsCommand(work, { claude: true });

    const config = readJson(join(work, ".claude/settings.json"));
    assert.deepEqual(config.permissions.allow, ["Bash(npm test:*)"]);
    assert.ok(config.permissions.deny.includes("Bash(git push:*)"));
  });

  test("refuses to overwrite unreadable Claude settings", async () => {
    const { work } = repo();
    mkdirSync(join(work, ".claude"), { recursive: true });
    const path = join(work, ".claude/settings.json");
    writeFileSync(path, "not json {{{");

    await assert.rejects(() => installAgentGuardsCommand(work, { claude: true }), AgitError);
    assert.equal(readFileSync(path, "utf8"), "not json {{{");
  });

  test("is idempotent", async () => {
    const { work } = repo();

    await installAgentGuardsCommand(work, { cursor: true, claude: true });
    await installAgentGuardsCommand(work, { cursor: true, claude: true });

    const cursor = readJson(join(work, ".cursor/hooks.json"));
    const claude = readJson(join(work, ".claude/settings.json"));
    assert.equal(cursor.hooks.beforeShellExecution.length, 1);
    assert.equal(claude.hooks.PreToolUse.length, 1);
    assert.equal(claude.hooks.PreToolUse[0].hooks.length, 1);
    assert.equal(new Set(claude.permissions.deny).size, claude.permissions.deny.length);
  });
});
