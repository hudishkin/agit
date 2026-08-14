<!-- agit:start -->
# agit Rules

This repository uses `agit` so an agent can work locally and cannot publish.

Local Git is allowed: commit, branch, history, `status`, `diff`, `log`.

Do not push. Do not create or merge pull requests. Do not pass `--no-verify`.

A human publishes:

```bash
agit finish <task-id>
```

If `agit` is not on PATH, use `npx agit`.

This file is a hint. Tool-call guards block publish commands before the shell runs them.

## If something fails

- A push or `gh pr` command was blocked → stop. A human runs `agit finish <task-id>`.
- Do not `git push` manually.
<!-- agit:end -->
