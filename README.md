# agit

**A boring, reviewable handoff between an AI coding agent and your Git remote.**

The agent works in a task worktree. It cannot publish. You finish into one draft pull request.

```bash
agit start AUTH-123
# open the printed path; the agent edits and commits with git
agit finish AUTH-123
```

`finish` is yours: checks, push, a **draft PR**. The agent is blocked from running it.

## Parallel work

Each `start` creates `.agit/worktrees/<task-id>` on `agit/<task-id>`. The main checkout stays on the default branch.

Several agents can run at once. Each task has its own dirty tree, branch, and later draft PR. `finish` from the main checkout publishes only that task.

```bash
agit start AUTH-123
agit start AUTH-124
agit status --all
agit finish AUTH-123
```

Do not run `git worktree`. `agit start` already created the directory.

## Modes

New clones default to **remote**: local git is allowed, publish is blocked. A human runs `agit finish`.

`agit init --yes --mode protocol` keeps the older loop, where the agent also runs `agit commit` and `agit finish`.

## Install

Needs Node 20+, `git`, and [GitHub CLI](https://cli.github.com/) (`gh`) for `finish`.

```bash
npm i -g @hudishkin/agit
```

Or keep it in the repo:

```bash
npm i -D @hudishkin/agit
npx agit init --yes --checks "npm test"
```

`init` writes `.agit/profile.yml`, merges an agit section into `AGENTS.md`, and installs the pre-push hook and agent guards. It does not rewrite `origin`.

Then, if you want the layers `init` cannot turn on by itself:

```bash
agit protect --apply    # GitHub ruleset; needs admin
agit isolate            # optional; this clone only
agit doctor             # confirm what is actually active
```

## What agit does

| Command | What happens |
| --- | --- |
| `agit start <task-id>` | Creates or resumes a worktree. Prints the path. No push. |
| `agit commit -m "..."` | Local commit in that worktree. Blocks secrets. Never pushes. Optional in `remote`. |
| `agit finish <task-id>` | Checks → push → **draft PR**. Same PR on later runs. Works from the main checkout. |
| `agit status --all` | Lists every task and its path. |

Read-only Git stays allowed. In `remote`, local mutating git is allowed too.

`AGENTS.md` is a hint. In Cursor and Claude Code, agit also intercepts the command before the shell runs it.

## Protection

`agit doctor` reports which layers are actually on.

1. **GitHub ruleset** — blocks push to the default branch, force-push, and unreviewed merges. `agit protect --apply`. The only layer a local agent cannot bypass.
2. **Agent guards** — Cursor `beforeShellExecution` and Claude Code `PreToolUse` call `agit guard`. In `remote`, publish is blocked. In `protocol`, git mutations are redirected to agit.
3. **pre-push hook** — a raw `git push` fails unless `agit finish` issued a one-use token. Works alongside husky.
4. **Local mirror (optional)** — `agit isolate` points this clone's `origin` at `.agit/mirror.git`. Everyday `git push` stays local. Undo with `agit isolate --undo`.

`finish` never force-pushes. On conflict or rewritten history, it stops.

## Commands

```text
agit init [--mode remote|protocol|patch]
                            Prepare this repository (default: remote)
agit start <task-id>        Create or resume a task worktree
agit commit -m "..."        Local commit, never a push
agit commit --files a b     Commit only these paths
agit finish <task-id>       Checks → push → draft PR
agit finish --squash        Squash commits before the first push
agit status [task-id]       Task state
agit status --all           Every task and its worktree path
agit abort <task-id>        Drop a local task (not after publish)
agit doctor                 Report which protection layers are active
agit protect [--apply]      Show or create the GitHub ruleset
agit isolate [--undo]       Point this clone's origin at a local mirror
agit prompt <task-id>       Copy-paste prompt for an agent
agit install-hooks          Install the pre-push hook
agit install-agent-guards   Install the Cursor and Claude tool-call guards
```

`init --guard-only` is the same as `--mode remote`. Every command accepts `--json`.

## Configuration

`.agit/profile.yml`:

```yaml
workflow:
  enforcement: remote     # new init default. protocol = agit CLI workflow

checks:
  - npm test
checks_timeout_sec: 900

commit:
  scope: all              # or explicit, to require agit commit --files
  denylist: [".env", ".env.*", "credentials.json", "*.pem", "*.p12"]
  allowlist: ["*.example", "*.sample", "*.template", "*.dist"]
  scan_contents: true
```

Existing profiles without `enforcement` stay on `protocol`. Isolation lives in this clone's git config, not in the profile.

## Who this is for

People who already let a coding agent change code, and want publish to stay with a human: one branch, one draft PR, checks before push. Several agents at once, each in its own worktree.

Hooks are first-class for **Cursor** and **Claude Code**. Copilot gets instruction files.

Not a sandbox. Not a merge queue. Not a defense against a hostile agent.

## Name

The npm package is `@hudishkin/agit`; the binary is `agit`. If another `agit` is already on `PATH`, use `npx agit`.

## License

MIT
