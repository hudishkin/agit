import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PublishFailed } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function createDraftPr(cwd, { base, head, title, body, repo }) {
  const args = ["pr", "create", "--draft", "--base", base, "--head", head, "--title", title, "--body", body];
  if (repo) {
    args.push("--repo", repo);
  }

  try {
    const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8" });
    const url = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!url) {
      throw new Error("gh did not print a pull request URL");
    }
    return url;
  } catch (error) {
    if (error instanceof PublishFailed) {
      throw error;
    }
    throw new PublishFailed(
      "Checks passed, but remote publish failed.",
      "Install and authenticate GitHub CLI (gh), then run agit finish again.",
      { error: error.stderr?.toString().trim() || error.message },
    );
  }
}
