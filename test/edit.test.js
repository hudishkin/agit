import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { editCommand, editorFromEnv } from "../src/commands/edit.js";
import { AgitError } from "../src/errors.js";
import { createGitRepo } from "./helpers/git-harness.js";

const repos = [];
const homes = [];
const previousHome = process.env.AGIT_HOME;
const previousStore = process.env.AGIT_STORE;

function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), "agit-home-"));
  homes.push(home);
  process.env.AGIT_HOME = home;
  delete process.env.AGIT_STORE;
  return home;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo.root, { recursive: true, force: true });
  }
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  if (previousHome === undefined) {
    delete process.env.AGIT_HOME;
  } else {
    process.env.AGIT_HOME = previousHome;
  }
  if (previousStore === undefined) {
    delete process.env.AGIT_STORE;
  } else {
    process.env.AGIT_STORE = previousStore;
  }
});

describe("edit", () => {
  test("editorFromEnv splits VISUAL", () => {
    assert.deepEqual(editorFromEnv({ VISUAL: "code --wait" }), { cmd: "code", args: ["--wait"] });
    assert.equal(editorFromEnv({}), null);
  });

  test("prints the home profile path without a TTY", async () => {
    const home = isolateHome();
    const created = createGitRepo();
    repos.push(created);

    const result = await editCommand(created.work, { tty: false, openEditor: () => {
      throw new Error("should not open");
    } });

    assert.equal(result.opened, false);
    assert.equal(result.store, "home");
    assert.equal(existsSync(result.path), true);
    assert.ok(result.path.startsWith(home));
    assert.match(result.message, /Profile:/);
  });

  test("opens the profile when a TTY and editor are available", async () => {
    isolateHome();
    const created = createGitRepo();
    repos.push(created);
    const opened = [];
    const previousEditor = process.env.EDITOR;
    process.env.EDITOR = "vi";

    try {
      const result = await editCommand(created.work, {
        tty: true,
        openEditor: (path, editor) => {
          opened.push({ path, editor });
        },
      });

      assert.equal(result.opened, true);
      assert.equal(opened.length, 1);
      assert.equal(opened[0].path, result.path);
    } finally {
      if (previousEditor === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previousEditor;
      }
    }
  });

  test("fails on a TTY without an editor", async () => {
    isolateHome();
    const created = createGitRepo();
    repos.push(created);
    const previousVisual = process.env.VISUAL;
    const previousEditor = process.env.EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;

    try {
      await assert.rejects(() => editCommand(created.work, { tty: true }), AgitError);
    } finally {
      if (previousVisual === undefined) {
        delete process.env.VISUAL;
      } else {
        process.env.VISUAL = previousVisual;
      }
      if (previousEditor === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previousEditor;
      }
    }
  });
});
