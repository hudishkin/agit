import { assertTaskId } from "../taskstore.js";

export function buildPrompt(taskId) {
  return `This repository uses agit.
Read AGENTS.md and follow the CLI workflow.

Task ID: ${taskId}

Run:
agit start ${taskId}

After making changes, commit locally only through:
agit commit -m "${taskId}: <summary>"

When done, run:
agit finish ${taskId}

If review comments arrive, commit the fixes and run agit finish ${taskId} again.
It updates the same pull request.

Do not use git push directly.
Do not push to main.
Do not force push.
Git mutations are blocked before the shell runs them, so use agit instead.
Read-only Git is allowed: git status, git diff, git log.
`;
}

export async function promptCommand(_cwd, taskId) {
  assertTaskId(taskId);
  const prompt = buildPrompt(taskId);
  return {
    task_id: taskId,
    prompt,
    message: prompt,
  };
}
