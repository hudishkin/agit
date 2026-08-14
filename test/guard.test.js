import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCommand } from "../src/guard.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agit.js");

function decide(command) {
  return classifyCommand(command).decision;
}

function runGuard(vendor, payload) {
  return spawnSync(process.execPath, [bin, "guard", "--vendor", vendor], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

describe("guard", () => {
  test("denies git mutations", () => {
    for (const command of [
      "git push",
      "git push --force origin main",
      "git push -u origin agit/AUTH-1",
      "git commit -m 'wip'",
      "git merge main",
      "git rebase -i HEAD~3",
      "git reset --hard HEAD~1",
      "git checkout -b feature",
      "git switch -c feature",
      "git cherry-pick abc123",
      "git revert HEAD",
      "git stash push",
      "git clean -fd",
      "git pull --rebase",
      "git tag v1.0.0",
      "git remote add upstream git@github.com:acme/x.git",
      "git branch -D old",
      "git config user.email a@b.c",
    ]) {
      assert.equal(decide(command), "deny", command);
    }
  });

  test("allows read-only git and everything else", () => {
    for (const command of [
      "git status",
      "git status --porcelain",
      "git diff",
      "git diff --cached",
      "git log --oneline -20",
      "git show HEAD",
      "git branch",
      "git branch --list",
      "git branch -a",
      "git tag --list",
      "git remote -v",
      "git stash list",
      "git config --get user.email",
      "git fetch origin",
      "git rev-parse HEAD",
      "npm test",
      "agit commit -m 'AUTH-1: fix'",
      "agit finish AUTH-1",
      "ls -la",
    ]) {
      assert.equal(decide(command), "allow", command);
    }
  });

  test("sees through chained commands and hook bypasses", () => {
    assert.equal(decide("npm test && git push"), "deny");
    assert.equal(decide("git status; git commit -m x"), "deny");
    assert.equal(decide("bash -c 'git push origin main'"), "deny");
    assert.equal(decide("git -C /repo push"), "deny");
    assert.equal(decide("git push --no-verify"), "deny");
    assert.equal(decide("AGIT_ALLOW_PUSH=1 git push"), "deny");
    assert.equal(decide("echo abc > .git/agit-allow-push"), "deny");
  });

  test("denies taking over pull request creation", () => {
    assert.equal(decide("gh pr create --fill"), "deny");
    assert.equal(decide("gh pr merge 4 --squash"), "deny");
    assert.equal(decide("gh pr list"), "allow");
    assert.equal(decide("gh pr view 4"), "allow");
  });

  test("allows an empty or unknown payload", () => {
    assert.equal(decide(""), "allow");
    assert.equal(classifyCommand(undefined).decision, "allow");
  });

  test("cursor adapter answers with a permission decision", () => {
    const denied = runGuard("cursor", { command: "git push", cwd: "/tmp" });
    assert.equal(denied.status, 0, denied.stderr);
    const payload = JSON.parse(denied.stdout);
    assert.equal(payload.permission, "deny");
    assert.match(payload.agent_message, /agit finish/);

    const allowed = runGuard("cursor", { command: "git status", cwd: "/tmp" });
    assert.equal(JSON.parse(allowed.stdout).permission, "allow");
  });

  test("claude adapter answers with hookSpecificOutput and exit 0", () => {
    const denied = runGuard("claude", { tool_name: "Bash", tool_input: { command: "git push" } });
    assert.equal(denied.status, 0, denied.stderr);
    const payload = JSON.parse(denied.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");

    const allowed = runGuard("claude", { tool_name: "Bash", tool_input: { command: "npm test" } });
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout.trim(), "");
  });
});
