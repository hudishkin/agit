# agit

**One task. One worktree. One PR.**

Agents work locally. You control what gets published.

Agit gives each coding-agent task its own worktree and turns finished local work into a draft pull request.

```bash
agit start AUTH-123
# open the printed path; the agent edits and commits with git
agit finish AUTH-123
```

`finish` is the handoff: checks, push, a **draft PR**. You run it. Later runs update the same PR.

## Parallel agents

Run multiple coding agents without mixing their Git state.

```bash
agit start AUTH-123
agit start TESTS-124
agit start REFACTOR-125

agit status --all
```

Each `start` creates `.agit/worktrees/<task-id>` on `agit/<task-id>`. The main checkout stays on the default branch. Each task keeps its own dirty tree, branch, and later draft PR. `finish` from the main checkout publishes only that task.

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

## Why this workflow

```text
one task → one worktree → one branch → one PR
```

Give several coding agents several tasks and get several reviewable draft PRs — without creating worktrees by hand, remembering which agent is where, or publishing from the wrong tree.

## The publish boundary

Local work and publishing are different trust boundaries.

Locally, the agent can edit, commit, rebase, and inspect history. Mistakes stay in that worktree.

Publishing — push, PR, CI, review, shared history — is a shared side effect. That path is `agit finish`, run by a human.

## How it works

1. `agit start` creates or resumes one worktree and one branch per task.
2. The agent works there with normal local Git.
3. You run `agit finish`.
4. Local checks run.
5. The branch is pushed.
6. A draft PR is created or updated.
7. A human reviews and merges. GitHub rulesets stay the server-side boundary.

## Who this is for

A good fit if you regularly use Claude Code, Cursor, or another coding agent, let it commit, juggle more than one task, and want a separate reviewable PR per task.

A weak fit if one agent does one tiny change and you already review the diff and push yourself. Then Agit may be extra ceremony.

Hooks are first-class for **Cursor** and **Claude Code**. Other agents can still work in the task worktree; Copilot gets instruction files.

## Why not just…

**git worktree.** Worktrees isolate a working tree. Agit is the lifecycle around them: task, branch, status, checks, publish handoff, draft PR.

**Branch protection.** Rulesets control what GitHub accepts. Agit controls how local agent work reaches that boundary. They are complementary.

**Cursor / Claude permissions.** Use them. Agit uses native guards where it can and adds one workflow above them: `task → worktree → local work → finish → PR`.

## Keeping the workflow predictable

`agit doctor` reports which layers are actually on.

1. **GitHub ruleset** — blocks push to the default branch, force-push, and unreviewed merges. `agit protect --apply`. The only layer a local agent cannot bypass.
2. **Agent guards** — Cursor `beforeShellExecution` and Claude Code `PreToolUse` call `agit guard`. In the default workflow, direct publishing is discouraged. In `protocol`, git mutations are redirected to agit.
3. **pre-push hook** — a raw `git push` fails unless `agit finish` issued a one-use token. Works alongside husky.
4. **Local mirror (optional)** — `agit isolate` points this clone's `origin` at `.agit/mirror.git`. Everyday `git push` stays local. Undo with `agit isolate --undo`.

`finish` never force-pushes. On conflict or rewritten history, it stops.

```bash
agit protect --apply    # GitHub ruleset; needs admin
agit isolate            # optional; this clone only
agit doctor             # confirm what is actually active
```

## Commands

```text
agit init [--mode remote|protocol|patch]
                            Prepare this repository (default: remote)
agit start <task-id>        Create or resume a task worktree
agit start --title --body --issue
                            Store PR title, body, and a GitHub issue
agit commit -m "..."        Local commit, never a push
agit commit --files a b     Commit only these paths
agit finish <task-id>       Checks → push → draft PR
agit finish --squash        Squash commits before the first push
agit finish --no-rebase     Skip rebase onto the default branch before the first push
agit status [task-id]       Task state
agit status --all           Every task: path, age, dirty, PR
agit abort <task-id>        Drop a local task and its branch
agit prune                  List stale worktrees (dry-run)
agit prune --apply          Delete stale worktrees and local branches
agit doctor                 Report which protection layers are active
agit doctor --fix           Reinstall the pre-push hook and agent guards
agit protect [--apply]      Show or create the GitHub ruleset
agit isolate [--undo]       Point this clone's origin at a local mirror
agit prompt <task-id>       Copy-paste prompt for an agent
agit install-hooks          Install the pre-push hook
agit install-agent-guards   Install the Cursor and Claude tool-call guards
```

Every command accepts `--json`.

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

`init --yes` without `--checks` looks at the repo (`package.json` scripts.test, pytest, cargo, go) and writes what it finds. Existing non-empty `checks` are left alone.

Existing profiles without `enforcement` stay on `protocol`. Isolation lives in this clone's git config, not in the profile.

These profile keys are reserved and unused: `one_push_policy`, `finish_mode`, `allow_direct_push`, `allow_force_push`. Review-loop pushes after the first `finish` are allowed.

## End-to-end

**One agent, one PR.** `agit start AUTH-123 --title "Fix login" --issue 12`. Work in the printed path. Commit there. A human runs `agit finish AUTH-123`. Checks run, the branch is pushed, a draft PR opens with that title and `Closes #12`.

**Two agents in parallel.** `agit start AUTH-123` and `agit start TESTS-124`. Each worktree has its own dirty tree. `agit status --all` shows both. `agit finish` from the main checkout publishes one task.

**Review loop.** After review comments, commit in the same worktree and run `agit finish AUTH-123` again. It pushes to the same draft PR. It does not force-push.

## Troubleshooting

- **Checks failed.** Read `.agit/logs/<task-id>-checks.log`, fix, run `agit finish` again.
- **Branch diverged after publish.** agit never force-pushes. Reconcile locally or start a new task id.
- **`gh` missing or not logged in.** Push may have succeeded. Install and authenticate GitHub CLI, then `agit finish` again to open the PR.
- **`abort` refuses.** The worktree is dirty, or the task was already published. Commit/restore, or close the PR yourself.
- **Stale worktrees.** `agit abort` drops one unpublished task. `agit status --all` lists the rest.

## agit vs git worktree vs worktrunk

| | agit | `git worktree` | worktrunk |
| --- | --- | --- | --- |
| Isolate a working tree | yes | yes | yes |
| One task → one branch → one draft PR | yes | no | no |
| Local checks before publish | yes | no | optional |
| Agent publish boundary | yes | no | no |
| You still review and merge | yes | yes | yes |

## Advanced workflows

New clones default to **remote**: the agent works with local git; a human runs `agit finish`.

`agit init --yes --mode protocol` keeps the older loop, where the agent also runs `agit commit` and `agit finish`.

`init --guard-only` is the same as `--mode remote`.

## Threat model

Agit is a workflow boundary, not a sandbox.

**Designed for** accidental direct publishing, workflow drift, premature pushes, the wrong task or branch, and parallel-agent Git state conflicts.

**Not designed for** hostile processes, credential theft, unrestricted network attacks, or a compromised machine.

Not a merge queue. Not a replacement for GitHub rulesets.

## Name

The npm package is `@hudishkin/agit`; the binary is `agit`. If another `agit` is already on `PATH`, use `npx agit`.

## License

MIT
