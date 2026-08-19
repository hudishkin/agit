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

Needs Node 20+ and `git`. `finish` also needs the host CLI for the configured `pr.provider`: [GitHub CLI](https://cli.github.com/) (`gh`) or [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`). Set `pr.provider: none` to only push the branch.

```bash
npm i -g @hudishkin/agit
```

Or keep it in the repo:

```bash
npm i -D @hudishkin/agit
npx agit init --yes --checks "npm test"
```

`init` writes `.agit/profile.yml`, merges an agit section into `AGENTS.md`, and installs the pre-push hook and agent guards. It does not rewrite `origin`.

To keep agit state out of the working tree (no `.agit/` in the repo):

```bash
npx agit init --yes --store home
```

That writes `~/.agit/<project>/` (profile, tasks, worktrees, logs). The project id is `{owner}-{name}-{hash}` from the remote and the clone path. Override the parent directory with `AGIT_HOME`. Make home the default for repos without an in-repo profile:

```yaml
# ~/.agit/config.yml
store: home
```

Or set `AGIT_STORE=home` for one command. An in-repo `.agit/profile.yml` still wins.

## Editor skill

`AGIT.md` is a ready Cursor / Claude Code skill. Copy it once into the editor — no `agit init` in the target repo:

```bash
# Cursor
mkdir -p ~/.cursor/skills/agit
cp AGIT.md ~/.cursor/skills/agit/SKILL.md

# Claude Code
mkdir -p ~/.claude/skills/agit
cp AGIT.md ~/.claude/skills/agit/SKILL.md
```

From a published install: `cp "$(npm root -g)/@hudishkin/agit/AGIT.md" ~/.cursor/skills/agit/SKILL.md`.

The skill tells the agent to use `npx @hudishkin/agit` and the home store, so the working tree stays clean. On first start it asks how to publish (default: always ask). If you say yes to finishing a task, you run `agit finish`.

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
7. A human reviews and merges.

## Who this is for

A good fit if you regularly use Claude Code, Cursor, or another coding agent, let it commit, juggle more than one task, and want a separate reviewable PR per task.

A weak fit if one agent does one tiny change and you already review the diff and push yourself. Then Agit may be extra ceremony.

Hooks are first-class for **Cursor** and **Claude Code**. Other agents can still work in the task worktree; Copilot gets instruction files.

## Why not just…

**git worktree.** Worktrees isolate a working tree. Agit is the lifecycle around them: task, branch, status, checks, publish handoff, draft PR.

**Branch protection.** GitHub/GitLab rulesets control what the host accepts. Agit does not create or manage them. Configure them on the host if you want that boundary.

**Cursor / Claude permissions.** Use them. Agit uses native guards where it can and adds one workflow above them: `task → worktree → local work → finish → PR`.

## Keeping the workflow predictable

`agit doctor` reports what is actually on.

1. **Agent guards** — Cursor `beforeShellExecution` and Claude Code `PreToolUse` call `agit guard`. In the default workflow, direct publishing is discouraged. In `protocol`, git mutations are redirected to agit.
2. **pre-push hook** — a raw `git push` fails unless `agit finish` issued a one-use token. Works alongside husky.
3. **Agent OS sandbox (opt-in)** — `agit start --sandbox` (or `agit init --sandbox`) sets `workflow.sandbox: agents`. `agit start` writes Cursor, Claude Code, and Codex sandbox configs, points origin at a local mirror, and locks git credentials in the task worktree. No in-repo init: `AGIT_STORE=home npx agit start TASK --sandbox`. `agit finish` still pushes with host credentials from the main checkout. `agit doctor` probes the OS runtime, then the files. Fail-closed: missing runtime or `insecure_none` / `danger-full-access` is a failure. Cursor can still read `~/.ssh`; `GH_TOKEN` in your shell is for finish, not for the agent worktree. Undo the mirror with `agit doctor --undo-isolate`.

`finish` never force-pushes. On conflict or rewritten history, it stops.

```bash
agit doctor             # confirm what is actually active
```

## Commands

```text
agit init [--finish ask|human|agent] [--sandbox] [--store repo|home]
                            Prepare this repository (default: ask, repo store)
agit start <task-id>        Create or resume a task worktree
agit start --finish ask     Save finish policy for this project (ask|human|agent)
agit start --sandbox        Enable agent sandboxes without re-running init
agit start --title --body --issue
                            Store PR title, body, and a GitHub issue
agit finish <task-id>       Checks → push → draft PR
agit finish --squash        Squash commits before the first push
agit finish --no-rebase     Skip rebase onto the default branch before the first push
agit status [task-id]       Task state
agit status --all           Every task: path, age, dirty, PR
agit abort <task-id>        Drop a local task and its branch
agit done <task-id>         Remove the worktree after the PR is merged
agit done --stale           List stale worktrees (dry-run)
agit done --stale --apply   Delete stale worktrees and local branches
agit doctor                 Report environment, hooks, and sandbox status
agit doctor --fix           Reinstall the pre-push hook and agent guards
agit doctor --undo-isolate  Restore origin to the real remote (sandbox)
```

Every command accepts `--json`. Protocol enforcement still accepts `agit commit` for denylist and secret-scan; it is not shown in `--help`.

## Configuration

`.agit/profile.yml`:

```yaml
workflow:
  finish: ask             # default if omitted. ask | human | agent
                          # ask   → agent asks before each publish; you run agit finish
                          # human → do not ask each time; you publish from your terminal
                          # agent → agent asks, then may run agit finish
  sandbox: off            # agents = write Cursor/Claude/Codex sandbox configs on start

pr:
  provider: github        # github | gitlab | none
                          # github → gh pr create
                          # gitlab → glab mr create
                          # none → push the branch only

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

Existing profiles without `finish` behave as `ask`. Existing profiles without `enforcement` stay on `protocol`. Existing profiles without `sandbox` stay `off`. Existing profiles without `pr.provider` stay on `github`. `init` writes `gitlab` when the remote URL looks like GitLab. Isolation lives in this clone's git config, not in the profile. `init --sandbox` is a flag, not a finish policy.

These profile keys are reserved and unused: `one_push_policy`, `finish_mode`, `allow_direct_push`, `allow_force_push`. Review-loop pushes after the first `finish` are allowed.

## End-to-end

**One agent, one PR.** `agit start AUTH-123 --title "Fix login" --issue 12`. Work in the printed path. Commit there. A human runs `agit finish AUTH-123`. Checks run, the branch is pushed, a draft PR opens with that title and `Closes #12`.

**Two agents in parallel.** `agit start AUTH-123` and `agit start TESTS-124`. Each worktree has its own dirty tree. `agit status --all` shows both. `agit finish` from the main checkout publishes one task.

**Review loop.** After review comments, commit in the same worktree and run `agit finish AUTH-123` again. It pushes to the same draft PR. It does not force-push. After the PR is merged, `agit done AUTH-123` removes the local worktree and branch.

## Troubleshooting

- **Checks failed.** Read `.agit/logs/<task-id>-checks.log`, fix, run `agit finish` again.
- **Branch diverged after publish.** agit never force-pushes. Reconcile locally or start a new task id.
- **`gh` or `glab` missing or not logged in.** Push may have succeeded. Install and authenticate the CLI for `pr.provider`, then `agit finish` again to open the request. Or set `pr.provider: none` to skip that step.
- **`abort` refuses.** The worktree is dirty, or the task was already published. Commit/restore, or close the PR yourself.
- **PR merged.** Run `agit done <task-id>` to remove the local worktree. `finish` and `status` hint this once GitHub/GitLab report merged.
- **Stale worktrees.** `agit abort` drops one unpublished task. `agit done` drops a merged one. `agit done --stale --apply` clears the rest.

## agit vs git worktree vs worktrunk

| | agit | `git worktree` | worktrunk |
| --- | --- | --- | --- |
| Isolate a working tree | yes | yes | yes |
| One task → one branch → one draft PR | yes | no | no |
| Local checks before publish | yes | no | optional |
| Agent publish boundary | yes | no | no |
| You still review and merge | yes | yes | yes |

## Advanced workflows

New clones default to **ask**: the agent works with local git and asks whether to finish; you run `agit finish`. Pass `--finish human` or `--finish agent` on `start` (or `init`) to save a different policy for that project.

`agit init --yes --mode protocol` is a hidden legacy loop, where the agent also runs `agit commit` and `agit finish`.

## Threat model

Agit is a workflow boundary. `init --sandbox` additionally configures vendor OS sandboxes (Cursor, Claude Code, Codex) and `doctor` fails if that runtime or those configs are missing.

**Designed for** accidental direct publishing, workflow drift, premature pushes, the wrong task or branch, and parallel-agent Git state conflicts.

**Not designed for** hostile processes, credential theft, unrestricted network attacks, or a compromised machine. Agent sandboxes do not hide `~/.ssh`. Host `GH_TOKEN` stays in your shell for `agit finish`; the task worktree cannot use it for git.

Not a merge queue. Not a replacement for GitHub rulesets.

## Name

The npm package is `@hudishkin/agit`; the binary is `agit`. If another `agit` is already on `PATH`, use `npx agit`.

## License

MIT
