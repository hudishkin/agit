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

Before the first `start`, if sandbox has not already been chosen, ask the user whether to enable Cursor / Claude Code / Codex sandboxes. Do not add `--sandbox` unless they say yes. Skip the question when the user already said yes or no in this conversation.

If they say yes (needs an origin remote):

```bash
AGIT_STORE=home npx agit start <task-id> --sandbox
```

## Workflow

1. If sandbox is undecided, ask. Then `AGIT_STORE=home npx agit start <task-id>` (add `--sandbox` only if they said yes).
2. Work only in the path `start` printed. Do not run `git worktree`.
3. Local Git is allowed: commit, branch, `status`, `diff`, `log`.
4. Do not push. Do not create or merge pull requests. Do not pass `--no-verify`.
5. When the work is done, ask the user whether to finish the task (publish a draft PR).
   - If they say no: stop. Leave the worktree as-is.
   - If they say yes: do not run `agit finish` yourself. Tell them to run:

```bash
npx agit finish <task-id>
```

## Commands

| You want to | Run |
| --- | --- |
| start a task | `AGIT_STORE=home npx agit start <task-id>` |
| start with agent sandbox | `AGIT_STORE=home npx agit start <task-id> --sandbox` |
| see where you are | `npx agit status` / `npx agit status --all` |
| drop an unpublished task | `npx agit abort <task-id>` |

## If something fails

- A push, `gh pr`, or `glab mr` command was blocked → stop. Ask the user whether to finish; if they say yes, they run `npx agit finish <task-id>`.
- `agit is not initialized` → `AGIT_STORE=home npx agit start <task-id>`, or `npx agit init --yes --store home`.
- Do not `git push` manually. Do not force-push.
