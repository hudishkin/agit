---
name: agit
description: >-
  Task-to-draft-PR workflow with agit. Use when starting a coding task, opening
  a pull request, working in a worktree, running parallel agents, or when the
  user mentions agit, AGIT_STORE, home store, or keeping .agit out of the
  repository.
---

# agit

Use `npx @hudishkin/agit` if `agit` is not on PATH.

State lives in the home store (`~/.agit/<project>/`), not in the repository. Do not create `.agit/profile.yml`. Location is environment-only: `AGIT_HOME` for the parent directory, `AGIT_STORE=repo` only if you explicitly want an in-repo store.

```bash
npx agit start <task-id>
```

Open this project's profile (path is printed; in a TTY it also opens `$VISUAL` / `$EDITOR`):

```bash
npx agit edit
```

## First start in a project

Before the first `start`, ask two things unless already decided in this conversation or already saved in the home profile (`start --json` shows `finish_explicit: true`, or `workflow.sandbox: agents`).

1. **Sandbox** — enable Cursor / Claude Code / Codex sandboxes? Do not add `--sandbox` unless they say yes.

2. **Finish policy** — how should publishing work? Default is **ask**.
   - **ask** (default): before each publish, ask whether to finish this task. You never run `agit finish`. If they say yes, they run it.
   - **human**: do not ask each time. They publish from their terminal when ready.
   - **agent**: before each publish, ask; if they say yes, you may run `agit finish`.

Persist the choice on start (even if they take the default):

```bash
npx agit start <task-id> --finish ask
```

If they also want sandbox:

```bash
npx agit start <task-id> --finish ask --sandbox
```

Skip the finish-policy question when `finish_explicit` is already true. If they refuse to choose, start without `--finish`; the default **ask** still applies, and the next agent should ask again.

## Workflow

1. First start: ask sandbox and finish policy as above, then start.
2. Work only in the path `start` printed. Do not run `git worktree`.
3. Local Git is allowed: commit, branch, `status`, `diff`, `log`.
4. Do not push. Do not create or merge pull requests. Do not pass `--no-verify`.
5. When the work is done, follow the saved policy:
   - **ask** (default): ask whether to finish this task. If no, stop. If yes, do not run `agit finish`. Tell them:

```bash
npx agit finish <task-id>
```

   - **human**: do not ask, do not run `agit finish`.
   - **agent**: ask; if yes, you may run `npx agit finish <task-id>`.

## Commands

| You want to | Run |
| --- | --- |
| start a task | `npx agit start <task-id>` |
| save finish policy | `npx agit start <task-id> --finish ask\|human\|agent` |
| start with agent sandbox | `npx agit start <task-id> --sandbox` |
| edit this project's profile | `npx agit edit` |
| see where you are | `npx agit status` / `npx agit status --all` |
| drop an unpublished task | `npx agit abort <task-id>` |
| land a task on its base branch | `npx agit done <task-id> --merge` |
| remove a merged or no-PR published task | `npx agit done <task-id>` |

## If something fails

- A push, `gh pr`, or `glab mr` command was blocked → stop. Ask whether to finish; if they say yes, they run `npx agit finish <task-id>` (unless policy is `agent`).
- `agit is not initialized` with `AGIT_STORE=repo` → unset it, or `npx agit init --yes --store repo`.
- Do not `git push` manually. Do not force-push.
