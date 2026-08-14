import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findDeniedFiles, matchesDenylist } from "../src/denylist.js";

describe("denylist", () => {
  test("matches .env and pem files", () => {
    assert.equal(matchesDenylist(".env"), true);
    assert.equal(matchesDenylist(".env.local"), true);
    assert.equal(matchesDenylist("secrets.pem"), true);
    assert.equal(matchesDenylist("certs/prod.p12"), true);
    assert.equal(matchesDenylist("credentials.json"), true);
  });

  test("matches denied names regardless of case", () => {
    assert.equal(matchesDenylist(".ENV"), true);
    assert.equal(matchesDenylist("CREDENTIALS.JSON"), true);
    assert.equal(matchesDenylist("secrets.PEM"), true);
    assert.equal(matchesDenylist(".ENV.EXAMPLE"), false);
  });

  test("does not match ordinary source files", () => {
    assert.equal(matchesDenylist("src/env.ts"), false);
    assert.equal(matchesDenylist("README.md"), false);
  });

  test("returns only denied files from a list", () => {
    assert.deepEqual(findDeniedFiles(["src/app.js", ".env", "notes.md"]), [".env"]);
  });
});
