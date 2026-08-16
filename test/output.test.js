import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Writable } from "node:stream";
import { ChecksFailed } from "../src/errors.js";
import { errorPayload, renderError, renderSuccess, successPayload } from "../src/output.js";

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    text: () => text,
  };
}

describe("output", () => {
  test("success JSON is a single object", () => {
    const stdout = capture();
    renderSuccess("start", { branch: "agit/AUTH-123" }, { json: true, stdout: stdout.stream });

    assert.deepEqual(JSON.parse(stdout.text()), successPayload("start", { branch: "agit/AUTH-123" }));
  });

  test("error JSON keeps message and hint", () => {
    const stdout = capture();
    const error = new ChecksFailed("Finish failed: checks did not pass.", "Fix the errors and run agit finish AUTH-123 again.", {
      failed: ["npm test"],
    });

    renderError("finish", error, { json: true, stdout: stdout.stream });

    assert.deepEqual(JSON.parse(stdout.text()), errorPayload("finish", error));
    assert.equal(JSON.parse(stdout.text()).error.details.failed[0], "npm test");
  });

  test("human error prints message and hint", () => {
    const stderr = capture();
    const error = new ChecksFailed("Finish failed: checks did not pass.", "Fix the errors and retry.");

    renderError("finish", error, { json: false, stderr: stderr.stream });

    assert.equal(stderr.text(), "Finish failed: checks did not pass.\nFix the errors and retry.\n");
  });

  test("human error prints the checks log tail", () => {
    const stderr = capture();
    const error = new ChecksFailed("Finish failed: checks did not pass.", "Fix the errors and retry.", {
      log_path: "/tmp/checks.log",
      log_tail: "$ false\nexit 1",
    });

    renderError("finish", error, { json: false, stderr: stderr.stream });

    assert.match(stderr.text(), /\$ false/);
    assert.match(stderr.text(), /Full log: \/tmp\/checks.log/);
  });
});
