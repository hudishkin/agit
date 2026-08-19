import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadAgentsSection, mergeAgentsMd, writeAgentsMd } from "../src/agentsmd.js";
import { MARKER_END, MARKER_START } from "../src/paths.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentsmd", () => {
  test("creates a file when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-md-"));
    dirs.push(dir);

    writeAgentsMd(dir, "");
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");

    assert.match(text, new RegExp(MARKER_START));
    assert.match(text, /agit start <task-id>/);
    assert.match(text, new RegExp(MARKER_END));
  });

  test("appends a section when markers are missing", () => {
    const existing = "# Team rules\n\nBe kind.\n";
    const merged = mergeAgentsMd(existing);

    assert.match(merged, /^# Team rules/);
    assert.match(merged, /Be kind\./);
    assert.ok(merged.indexOf("Be kind.") < merged.indexOf(MARKER_START));
  });

  test("replaces only the marked section", () => {
    const existing = `# Keep me\n\n${MARKER_START}\nold\n${MARKER_END}\n\n# Also keep\n`;
    const merged = mergeAgentsMd(existing, loadAgentsSection());

    assert.match(merged, /^# Keep me/);
    assert.match(merged, /# Also keep/);
    assert.doesNotMatch(merged, /\nold\n/);
    assert.match(merged, /Use `agit` instead/);
  });

  test("writes the remote section when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "agit-md-"));
    dirs.push(dir);

    writeAgentsMd(dir, "", "remote");
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");

    assert.match(text, /Local Git is allowed/);
    assert.match(text, /agit start <task-id>/);
    assert.match(text, /ask the user whether to finish/);
    assert.doesNotMatch(text, /Do not use Git mutations for task workflow/);
  });
});
