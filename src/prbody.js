import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "pr-body.md");

export function formatTitle(template, taskId, summary) {
  return template.replaceAll("{task_id}", taskId).replaceAll("{summary}", summary);
}

export function summarizeCommit(taskId, subject) {
  const prefix = `${taskId}: `;
  return subject.startsWith(prefix) ? subject.slice(prefix.length) : subject;
}

export function renderPrBody({ taskId, branch, summary, checks, files, issue = null }) {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const checkLines = checks.length
    ? checks.map((check) => `- [${check.ok ? "x" : " "}] \`${check.command}\``).join("\n")
    : "- —";
  const fileLines = files.length ? files.map((file) => `- ${file}`).join("\n") : "- —";
  const checksStatus = checks.length === 0 || checks.every((check) => check.ok) ? "passed" : "failed";
  const closes = issue ? `Closes #${issue}\n` : "";

  return template
    .replaceAll("{summary}", summary || "—")
    .replaceAll("{task_id}", taskId)
    .replaceAll("{branch}", branch)
    .replaceAll("{checks_status}", checksStatus)
    .replaceAll("{checks}", checkLines)
    .replaceAll("{files}", fileLines)
    .replaceAll("{closes}", closes);
}
