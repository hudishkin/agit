import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatAge } from "../src/taskinfo.js";

describe("formatAge", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  test("returns null without created_at", () => {
    assert.equal(formatAge(undefined, now), null);
    assert.equal(formatAge("", now), null);
  });

  test("clamps a future timestamp to 0m", () => {
    assert.equal(formatAge("2026-08-16T13:00:00.000Z", now), "0m");
  });

  test("uses minutes under an hour", () => {
    assert.equal(formatAge("2026-08-16T11:01:00.000Z", now), "59m");
  });

  test("switches to hours at 60 minutes", () => {
    assert.equal(formatAge("2026-08-16T11:00:00.000Z", now), "1h");
  });

  test("stays on hours until 48h", () => {
    assert.equal(formatAge("2026-08-14T13:00:00.000Z", now), "47h");
    assert.equal(formatAge("2026-08-14T12:00:00.000Z", now), "2d");
  });
});
