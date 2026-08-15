import { enforcementOf, loadProfile, profileExists } from "../profile.js";
import { assertTaskId } from "../taskstore.js";

function enforcementFrom(cwd) {
  if (!profileExists(cwd)) {
    return "protocol";
  }
  try {
    return enforcementOf(loadProfile(cwd));
  } catch {
    return "protocol";
  }
}

export function buildPrompt(taskId, enforcement = "protocol") {
  if (enforcement === "remote") {
    return `This repository uses agit.
Read AGENTS.md. Local git is allowed. You cannot publish.

Task ID: ${taskId}

Run:
agit start ${taskId}

Then edit and commit with git.

Do not push.
Do not create or merge pull requests.
Do not run agit finish. A human publishes from their own terminal.
Do not pass --no-verify.
`;
  }

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

export async function promptCommand(cwd, taskId) {
  assertTaskId(taskId);
  const prompt = buildPrompt(taskId, enforcementFrom(cwd));
  return {
    task_id: taskId,
    prompt,
    message: prompt,
  };
}
