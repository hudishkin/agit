import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgitError } from "../src/errors.js";
import {
  installSkills,
  packagedSkillPath,
  parseEditors,
  parseScope,
  skillFilePath,
} from "../src/skills.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("skills", () => {
  test("parseEditors accepts cursor, claude, and both", () => {
    assert.deepEqual(parseEditors("cursor"), ["cursor"]);
    assert.deepEqual(parseEditors("Claude"), ["claude"]);
    assert.deepEqual(parseEditors("both"), ["cursor", "claude"]);
    assert.equal(parseEditors(""), null);
  });

  test("parseEditors rejects an unknown editor", () => {
    assert.throws(() => parseEditors("vscode"), AgitError);
  });

  test("parseScope accepts local and global", () => {
    assert.equal(parseScope("local"), "local");
    assert.equal(parseScope("Global"), "global");
    assert.equal(parseScope(""), null);
    assert.throws(() => parseScope("home"), AgitError);
  });

  test("installSkills writes SKILL.md from AGIT.md", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agit-skill-cwd-"));
    const homeDir = mkdtempSync(join(tmpdir(), "agit-skill-home-"));
    dirs.push(cwd, homeDir);
    const source = readFileSync(packagedSkillPath(), "utf8");
    assert.equal(
      packagedSkillPath(),
      join(dirname(fileURLToPath(import.meta.url)), "..", "AGIT.md"),
    );

    const local = installSkills({ cwd, editors: ["cursor"], scope: "local", homeDir });
    const expected = skillFilePath({ editor: "cursor", scope: "local", cwd, homeDir });
    assert.deepEqual(local.files, [expected]);
    assert.equal(readFileSync(expected, "utf8"), source);

    const global = installSkills({ cwd, editors: ["claude"], scope: "global", homeDir });
    const globalPath = skillFilePath({ editor: "claude", scope: "global", cwd, homeDir });
    assert.equal(existsSync(globalPath), true);
    assert.equal(existsSync(join(cwd, ".claude/skills/agit/SKILL.md")), false);
    assert.equal(readFileSync(globalPath, "utf8"), source);
  });
});
