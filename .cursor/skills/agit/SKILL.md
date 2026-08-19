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

Keep agit state out of the repository. Do not create `.agit/profile.yml` in the repo.

```bash
AGIT_STORE=home npx agit start <task-id>
```

Or set `store: home` in `~/.agit/config.yml`. Override the parent directory with `AGIT_HOME`.
An in-repo `.agit/profile.yml` overrides the home store — remove it if you find one.

## First start in a project

Before the first `start`, ask two things unless already decided in this conversation or already saved in the home profile (`start --json` shows `finish_explicit: true`, or `workflow.sandbox: agents`).

1. **Sandbox** — enable Cursor / Claude Code / Codex sandboxes? Do not add `--sandbox` unless they say yes.

2. **Finish policy** — how should publishing work? Default is **ask**.
   - **ask** (default): before each publish, ask whether to finish this task. You never run `agit finish`. If they say yes, they run it.
   - **human**: do not ask each time. They publish from their terminal when ready.
   - **agent**: before each publish, ask; if they say yes, you may run `agit finish`.

Persist the choice on start (even if they take the default):

```bash
AGIT_STORE=home npx agit start <task-id> --finish ask
```

If they also want sandbox:

```bash
AGIT_STORE=home npx agit start <task-id> --finish ask --sandbox
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
| start a task | `AGIT_STORE=home npx agit start <task-id>` |
| save finish policy | `AGIT_STORE=home npx agit start <task-id> --finish ask\|human\|agent` |
| start with agent sandbox | `AGIT_STORE=home npx agit start <task-id> --sandbox` |
| see where you are | `npx agit status` / `npx agit status --all` |
| drop an unpublished task | `npx agit abort <task-id>` |

## If something fails

- A push, `gh pr`, or `glab mr` command was blocked → stop. Ask whether to finish; if they say yes, they run `npx agit finish <task-id>` (unless policy is `agent`).
- `agit is not initialized` → `AGIT_STORE=home npx agit start <task-id>`, or `npx agit init --yes --store home`.
- Do not `git push` manually. Do not force-push.
