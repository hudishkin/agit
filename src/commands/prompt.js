import { enforcementOf } from "../profile.js";
import { resolveTaskTree, worktreeAbsPath } from "../root.js";
import { loadWorkspace } from "../store.js";
import { assertTaskId, loadTask, taskExists } from "../taskstore.js";

async function enforcementFrom(cwd) {
  try {
    const { profile } = await loadWorkspace(cwd, { required: false });
    return profile ? enforcementOf(profile) : "protocol";
  } catch {
    return "protocol";
  }
}

export function buildPrompt(taskId, enforcement = "protocol", path = null, { title, body } = {}) {
  const work = path ? `\nWork in: ${path}\nagit start already created this directory. Do not run git worktree.\n` : "";
  const meta = [title ? `Title: ${title}` : null, body ? `Body:\n${body}` : null].filter(Boolean).join("\n");
  const metaBlock = meta ? `${meta}\n` : "";

  if (enforcement === "remote") {
    return `This repository uses agit.
Read AGENTS.md. Local git is allowed. You cannot publish.

Task ID: ${taskId}
${metaBlock}${work}
Run:
agit start ${taskId}

Then edit and commit with git in the task directory.

Do not push.
Do not create or merge pull requests.
Do not run agit finish. A human publishes from their own terminal.
Do not pass --no-verify.
Do not run git worktree.
`;
  }

  return `This repository uses agit.
Read AGENTS.md and follow the CLI workflow.

Task ID: ${taskId}
${metaBlock}${work}
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
Do not run git worktree.
Git mutations are blocked before the shell runs them, so use agit instead.
Read-only Git is allowed: git status, git diff, git log.
`;
}

export async function promptCommand(cwd, taskId) {
  assertTaskId(taskId);
  const enforcement = await enforcementFrom(cwd);
  let path = null;
  let title = null;
  let body = null;
  try {
    const { store } = await loadWorkspace(cwd, { required: false });
    if (store && taskExists(store.dir, taskId)) {
      const task = loadTask(store.dir, taskId);
      path = resolveTaskTree(store, task, cwd);
      title = task.title ?? null;
      body = task.body ?? null;
    } else if (store) {
      path = worktreeAbsPath(store, taskId);
    }
  } catch {
    path = null;
  }
  const prompt = buildPrompt(taskId, enforcement, path, { title, body });
  return {
    task_id: taskId,
    path,
    prompt,
    message: prompt,
  };
}
