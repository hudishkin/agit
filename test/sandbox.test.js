import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  CLAUDE_SETTINGS_FILE,
  CODEX_CONFIG_FILE,
  CURSOR_SANDBOX_FILE,
  inspectClaudeSandbox,
  inspectCodexSandbox,
  inspectCursorSandbox,
  inspectHostPublishEnv,
  writeAgentSandbox,
} from "../src/sandbox.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dir() {
  const path = mkdtempSync(join(tmpdir(), "agit-sandbox-"));
  dirs.push(path);
  return path;
}

describe("agent sandbox configs", () => {
  test("writeAgentSandbox produces fail-closed configs", () => {
    const cwd = dir();
    writeAgentSandbox(cwd);

    assert.equal(inspectCursorSandbox(cwd).status, "ok");
    assert.equal(inspectClaudeSandbox(cwd).status, "ok");
    assert.equal(inspectCodexSandbox(cwd).status, "ok");

    const cursor = JSON.parse(readFileSync(join(cwd, CURSOR_SANDBOX_FILE), "utf8"));
    assert.equal(cursor.type, "workspace_readwrite");
    assert.equal(cursor.networkPolicy.default, "deny");
    assert.ok(cursor.networkPolicy.deny.includes("github.com"));
    assert.equal(cursor.networkPolicy.allow.includes("github.com"), false);

    const claude = JSON.parse(readFileSync(join(cwd, CLAUDE_SETTINGS_FILE), "utf8"));
    assert.equal(claude.sandbox.enabled, true);
    assert.equal(claude.sandbox.failIfUnavailable, true);
    assert.equal(claude.sandbox.allowUnsandboxedCommands, false);
    assert.ok(claude.sandbox.network.deniedDomains.includes("github.com"));

    const codex = readFileSync(join(cwd, CODEX_CONFIG_FILE), "utf8");
    assert.match(codex, /sandbox_mode = "workspace-write"/);
    assert.match(codex, /network_access = false/);
  });

  test("cursor insecure_none fails inspection", () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(
      join(cwd, CURSOR_SANDBOX_FILE),
      `${JSON.stringify({ type: "insecure_none", networkPolicy: { default: "deny", deny: ["github.com"] } }, null, 2)}\n`,
    );
    assert.equal(inspectCursorSandbox(cwd).status, "fail");
    assert.match(inspectCursorSandbox(cwd).message, /insecure_none/);
  });

  test("cursor Defaults hole fails without github.com in deny", () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(
      join(cwd, CURSOR_SANDBOX_FILE),
      `${JSON.stringify({ type: "workspace_readwrite", networkPolicy: { default: "deny", allow: ["github.com"] } }, null, 2)}\n`,
    );
    assert.equal(inspectCursorSandbox(cwd).status, "fail");
    assert.match(inspectCursorSandbox(cwd).message, /github.com/);
  });

  test("codex danger-full-access fails inspection", () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, CODEX_CONFIG_FILE), 'sandbox_mode = "danger-full-access"\n');
    assert.equal(inspectCodexSandbox(cwd).status, "fail");
  });

  test("writeAgentSandbox replaces danger-full-access", () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, CODEX_CONFIG_FILE), 'sandbox_mode = "danger-full-access"\nnetwork_access = true\n');
    writeAgentSandbox(cwd);
    assert.equal(inspectCodexSandbox(cwd).status, "ok");
  });

  test("inspectHostPublishEnv treats GH_TOKEN as finish-only", () => {
    const withToken = inspectHostPublishEnv({ GH_TOKEN: "gho_test" });
    assert.equal(withToken.status, "ok");
    assert.match(withToken.message, /GH_TOKEN/);
    assert.match(withToken.message, /finish/);

    const without = inspectHostPublishEnv({});
    assert.equal(without.status, "ok");
    assert.match(without.message, /No GH_TOKEN/);
  });
});
