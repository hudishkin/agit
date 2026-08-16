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
      "git stash",
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
      "git fetch git@github.com:acme/x.git",
      "gh api repos/acme/x",
      "gh api --method GET repos/acme/x/pulls",
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
    assert.equal(decide("gh release create v1"), "deny");
    assert.equal(decide("gh repo delete acme/x"), "deny");
    assert.equal(decide("gh repo view acme/x"), "allow");
    assert.equal(decide("glab mr create --fill"), "deny");
    assert.equal(decide("glab mr merge 4"), "deny");
    assert.equal(decide("glab mr list"), "allow");
    assert.equal(decide("glab mr view 4"), "allow");
  });

  test("denies fetch refspecs that can move local branches", () => {
    assert.equal(decide("git fetch origin +main:main"), "deny");
    assert.equal(decide("git fetch origin main:agit/T1"), "deny");
    assert.equal(decide("git fetch . HEAD:refs/heads/main"), "deny");
    assert.equal(decide("git fetch origin main"), "allow");
  });

  test("denies mutating gh api calls", () => {
    assert.equal(decide("gh api --method POST repos/acme/x/pulls"), "deny");
    assert.equal(decide("gh api -X PUT repos/acme/x/pulls/1/merge"), "deny");
    assert.equal(decide("gh api graphql -f query=mutation { }"), "deny");
    assert.equal(decide("gh api repos/acme/x/pulls -f title=x -f head=y -f base=z"), "deny");
  });

  test("remote enforcement allows local git and still blocks publish", () => {
    const remote = { enforcement: "remote" };
    for (const command of [
      "git commit -m 'wip'",
      "git checkout -b feature",
      "git switch -c feature",
      "git stash",
      "git merge main",
      "git reset HEAD",
      "git fetch origin +main:main",
    ]) {
      assert.equal(classifyCommand(command, remote).decision, "allow", command);
    }
    for (const command of [
      "git push",
      "git push origin main",
      "git push git@github.com:acme/x.git HEAD:main",
      "git reset --hard HEAD",
      "git push --no-verify",
      "git commit -m x && git push",
      "gh pr create --fill",
      "gh api --method POST repos/acme/x/pulls",
      "gh release create v1.0.0",
      "gh repo delete acme/x",
      "agit finish AUTH-1",
      "npx agit finish AUTH-1",
      "git worktree add ../other",
    ]) {
      assert.equal(classifyCommand(command, remote).decision, "deny", command);
    }
  });

  test("blocks mutating HTTP to api.github.com", () => {
    for (const command of [
      "curl -X POST https://api.github.com/repos/acme/x/contents/app.js",
      "curl --request PUT https://api.github.com/repos/acme/x/git/refs/heads/main",
      "curl -d '{\"a\":1}' https://api.github.com/repos/acme/x/contents/x",
      "wget --method=POST https://api.github.com/repos/acme/x/git/blobs",
      "wget --post-data=x https://api.github.com/user/repos",
    ]) {
      assert.equal(decide(command), "deny", command);
    }
    for (const command of [
      "curl https://api.github.com/repos/acme/x",
      "curl --method GET https://api.github.com/user",
      "curl -X POST https://example.com/hook",
      "wget https://api.github.com/repos/acme/x",
    ]) {
      assert.equal(decide(command), "allow", command);
    }
  });

  test("hides agit.pushUrl from the agent when the clone is isolated", () => {
    const isolated = { isolated: true };
    assert.equal(classifyCommand("git config --get agit.pushUrl", isolated).decision, "deny");
    assert.equal(classifyCommand("git config --get-regexp agit", isolated).decision, "deny");
    assert.equal(classifyCommand("git config --get user.email", isolated).decision, "allow");
    assert.equal(decide("git config --get agit.pushUrl"), "allow");
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
