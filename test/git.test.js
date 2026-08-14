import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { PublishFailed } from "../src/errors.js";
import {
  add,
  commit,
  createBranch,
  currentBranch,
  defaultBranch,
  isClean,
  isRepo,
  listCommitCandidates,
  push,
  remoteUrl,
} from "../src/git.js";
import { createGitRepo, gitRun } from "./helpers/git-harness.js";

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

describe("git", () => {
  test("isRepo detects a work tree", async () => {
    const { work, root } = repo();

    assert.equal(await isRepo(work), true);
    assert.equal(await isRepo(root), false);
  });

  test("isClean reflects working tree state", async () => {
    const { work } = repo();

    assert.equal(await isClean(work), true);
    writeFileSync(join(work, "README.md"), "changed\n");
    assert.equal(await isClean(work), false);
  });

  test("defaultBranch and remoteUrl come from origin", async () => {
    const { work, origin } = repo();

    assert.equal(await defaultBranch(work), "main");
    assert.equal(await remoteUrl(work), origin);
  });

  test("createBranch checks out a new branch", async () => {
    const { work } = repo();

    await createBranch(work, "agit/AUTH-123", "main");
    assert.equal(await currentBranch(work), "agit/AUTH-123");
  });

  test("commit records a hash without pushing", async () => {
    const { work, origin } = repo();

    writeFileSync(join(work, "note.txt"), "local\n");
    await add(work, ["note.txt"]);
    const hash = await commit(work, "AUTH-123: add note");

    assert.match(hash, /^[0-9a-f]{40}$/);
    assert.equal(await currentBranch(work), "main");

    const originBranches = gitRun(origin, ["branch"]);
    assert.doesNotMatch(originBranches, /AUTH-123/);
  });

  test("listCommitCandidates includes tracked edits and untracked files", async () => {
    const { work } = repo();

    writeFileSync(join(work, "README.md"), "changed\n");
    writeFileSync(join(work, "new.txt"), "fresh\n");
    writeFileSync(join(work, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(work, "ignored.txt"), "nope\n");

    const files = await listCommitCandidates(work);
    assert.deepEqual(files, [".gitignore", "README.md", "new.txt"]);
  });

  test("push refuses without an explicit allow and ignores the old env bypass", async () => {
    const { work } = repo();

    await createBranch(work, "agit/AUTH-123", "main");
    writeFileSync(join(work, "note.txt"), "local\n");
    await add(work, ["note.txt"]);
    await commit(work, "AUTH-123: add note");

    const previous = process.env.AGIT_ALLOW_PUSH;
    process.env.AGIT_ALLOW_PUSH = "1";
    try {
      await assert.rejects(() => push(work, "agit/AUTH-123"), PublishFailed);
    } finally {
      if (previous === undefined) {
        delete process.env.AGIT_ALLOW_PUSH;
      } else {
        process.env.AGIT_ALLOW_PUSH = previous;
      }
    }
  });

  test("push with allow updates origin and leaves no token behind", async () => {
    const { work, origin } = repo();

    await createBranch(work, "agit/AUTH-123", "main");
    writeFileSync(join(work, "note.txt"), "local\n");
    await add(work, ["note.txt"]);
    await commit(work, "AUTH-123: add note");

    await push(work, "agit/AUTH-123", { allow: true });

    assert.match(gitRun(origin, ["branch"]), /agit\/AUTH-123/);
    assert.equal(existsSync(join(work, ".git/agit-allow-push")), false);
  });

  test("does not import commander", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "git.js"), "utf8");
    assert.doesNotMatch(source, /commander/);
  });
});
