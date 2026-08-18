<!-- agit:start -->
# agit Rules

This repository uses `agit` for AI coding agent work.

Do not use Git mutations for task workflow. Use `agit` instead. If `agit` is not on PATH, use `npx agit`.

This file is a hint, not the enforcement. Tool-call guards block Git mutations before the shell runs them, so a blocked command is expected behaviour, not a bug to work around.

## Required workflow

```bash
agit start <task-id>
# work only in the path start printed
agit commit -m "<task-id>: <summary>"
agit finish <task-id>
```

Read-only Git is allowed: `git status`, `git diff`, `git log`, `git show`.
Do not run `git worktree`. `agit start` already created the task directory.

## Instead of Git

| You want to | Run |
| --- | --- |
| start work on a task | `agit start <task-id>` |
| record progress | `agit commit -m "<task-id>: <summary>"` |
| publish and open a PR | `agit finish <task-id>` |
| publish review fixes | `agit commit ...` then `agit finish <task-id>` again |
| see where you are | `agit status` |
| drop an unpublished task | `agit abort <task-id>` |
| remove a merged task | `agit done <task-id>` |
| remove stale worktrees | `agit prune` then `agit prune --apply` |

`agit finish` pushes and opens a draft PR. Running it again after review fixes updates the same PR. A human reviews and merges. After merge, `agit done <task-id>` removes the local worktree.

## If something fails

- Checks fail → read `.agit/logs/<task-id>-checks.log`, fix, retry `agit finish <task-id>`.
- A Git command was blocked → use the `agit` command from the table above.
- Conflict, or history diverged from what was published → stop and report. Do not force-push.
- Publish fails → do not `git push` manually. Retry `agit finish <task-id>`.
<!-- agit:end -->
