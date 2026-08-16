import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDraftPr } from "../src/gh.js";
import { createDraftMr, detectProvider, normalizeProvider, openerFor, providerOf } from "../src/prhost.js";

describe("pr host", () => {
  test("normalizes unknown providers to github", () => {
    assert.equal(normalizeProvider("github"), "github");
    assert.equal(normalizeProvider("gitlab"), "gitlab");
    assert.equal(normalizeProvider("none"), "none");
    assert.equal(normalizeProvider("bitbucket"), "github");
    assert.equal(normalizeProvider(undefined), "github");
  });

  test("reads provider from the profile", () => {
    assert.equal(providerOf({ pr: { provider: "none" } }), "none");
    assert.equal(providerOf({ pr: {} }), "github");
    assert.equal(providerOf({}), "github");
  });

  test("detects the host from a remote URL", () => {
    assert.equal(detectProvider("git@github.com:acme/backend.git"), "github");
    assert.equal(detectProvider("https://gitlab.com/acme/backend.git"), "gitlab");
    assert.equal(detectProvider("git@gitlab.example.com:acme/backend.git"), "gitlab");
    assert.equal(detectProvider("git@git.internal:/repo.git"), "github");
    assert.equal(detectProvider(undefined), "github");
  });

  test("picks the opener for the provider", () => {
    assert.equal(openerFor("github"), createDraftPr);
    assert.equal(openerFor("gitlab"), createDraftMr);
    assert.equal(openerFor("none"), createDraftPr); // unused; finish skips the opener
  });
});
