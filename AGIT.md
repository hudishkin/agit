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

Prefer the home store so the repository working tree stays clean (no `.agit/` in the repo):

```bash
AGIT_STORE=home npx agit start <task-id>
```

Enable Cursor / Claude Code / Codex sandboxes without `init` (needs an origin remote):

```bash
AGIT_STORE=home npx agit start <task-id> --sandbox
```

That writes `workflow.sandbox: agents` into the home profile, so later starts keep sandbox on. One-time setup, still without writing into the repo:

```bash
npx agit init --yes --store home --sandbox
```

Or set `store: home` in `~/.agit/config.yml`. Override the parent directory with `AGIT_HOME`.
If `.agit/profile.yml` exists in the repo, use that store instead.

## Workflow

1. `npx agit start <task-id>`
2. Work only in the path `start` printed. Do not run `git worktree`.
3. Local Git is allowed: commit, branch, `status`, `diff`, `log`.
4. Do not push. Do not create or merge pull requests. Do not pass `--no-verify`.
5. Do not run `agit finish`. A human publishes:

```bash
npx agit finish <task-id>
```

## Commands

| You want to | Run |
| --- | --- |
| start a task | `npx agit start <task-id>` |
| start with agent sandbox | `AGIT_STORE=home npx agit start <task-id> --sandbox` |
| see where you are | `npx agit status` / `npx agit status --all` |
| drop an unpublished task | `npx agit abort <task-id>` |

## If something fails

- A push, `gh pr`, or `glab mr` command was blocked → stop. A human runs `npx agit finish <task-id>`.
- `agit is not initialized` → `AGIT_STORE=home npx agit start <task-id>`, or `npx agit init --yes --store home`.
- Do not `git push` manually. Do not force-push.
