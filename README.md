# agit

**A boring, reviewable handoff between an AI coding agent and your Git remote.**

The agent works with four commands instead of raw Git. You get one branch, one draft pull request, and a history you can read.

```bash
agit start AUTH-123
# edit code
agit commit -m "AUTH-123: fix login validation"
agit finish AUTH-123
```

## The problem

AI coding agents are good at changing code and bad at Git.

They push too early, push many times, skip tests, commit `.env` files, invent branch names, force-push, and sometimes push to `main`. A long `AGENTS.md` does not stop this. Agents forget rules, or ignore them "to be helpful."

The result is noisy remotes, broken CI, dirty history, and pull requests a human cannot review.

## What agit does

`agit` is a small CLI protocol. The agent gets a short, boring interface, and Git mutations go through that interface instead of raw `git`.

| Command | What happens |
| --- | --- |
| `agit start <task-id>` | Creates a local `agit/<task-id>` branch from `origin/<default>`. No push. |
| `agit commit -m "..."` | Commits locally. Prints the file list. Blocks secrets. Never pushes. |
| `agit finish <task-id>` | Runs your checks. If they pass: push and a **draft PR**. Review fixes go to the same PR. |
| `agit status` | Prints task state as text or `--json` for the agent. |

Read-only Git stays allowed: `git status`, `git diff`, `git log`.

## Four layers, and what each one is worth

Enforcement is layered because no single layer is enough. `agit doctor` reports which layers are actually active in this clone, and says so plainly when one is missing.

**Layer 1: GitHub rules (server-side).** Push to the default branch, force-push, and merges without review are blocked by a GitHub ruleset. This is the only layer a local agent cannot bypass. `agit protect` shows the ruleset; `agit protect --apply` creates it.

**Layer 2: agent tool-call guards.** `agit install-agent-guards` wires Cursor's `beforeShellExecution` and Claude Code's `PreToolUse` hooks to `agit guard`, which inspects the command **before the shell runs it**. This catches `git push --no-verify`, chained commands, and `sh -c "git push"`, and answers with a redirect: *use `agit commit -m ...`* rather than a bare refusal. The Cursor hook is installed fail-closed. For Claude Code, declarative `permissions.deny` rules back the hook up.

**Layer 3: git pre-push hook.** A raw `git push` fails unless `agit finish` issued a single-use token bound to the exact commit being pushed. The hook is installed at the path git actually uses, so it works alongside husky, and an existing `pre-push` hook is backed up rather than overwritten.

**Layer 4: the local mirror.** `agit isolate` rewrites `origin` to `.agit/mirror.git` for both fetch and push. `git push origin` and `git push "$(git remote get-url origin)"` stay on this machine. The real URL is stored in this clone's git config (`agit.pushUrl`), not in the tracked profile. `agit start` syncs the default branch from that URL before creating the task; `agit finish` publishes there. Isolation is opt-in and per-clone: it does not travel with the repository.

So: agit makes the wrong thing inconvenient and the right thing the path of least resistance. Push to `main`, force-push, and dirty history are closed by layer 1, which is GitHub's job, not agit's.

## Install

Needs Node 20+, `git`, and [GitHub CLI](https://cli.github.com/) (`gh`) for `finish`.

```bash
npm i -g @hudishkin/agit
```

Or keep it in the repo so agents can find it with `npx`:

```bash
npm i -D @hudishkin/agit
npx agit init --yes
```

`init` writes `.agit/profile.yml`, merges an agit section into `AGENTS.md`, installs the pre-push hook and the agent guards, and adds Cursor / Claude / Copilot instruction files. It does not overwrite the rest of your `AGENTS.md`, your hooks, or your existing hook configuration. It does not rewrite `origin`.

Then close the layers that init cannot turn on by itself:

```bash
agit protect            # show the GitHub ruleset
agit protect --apply    # create it (needs admin on the repo)
agit isolate            # point this clone's origin at a local mirror
agit doctor             # confirm what is actually active
```

## Quick start

```bash
agit init --yes --checks "npm test"
agit isolate            # optional; see below
agit start AUTH-123
# change code; git diff and git status are fine
agit commit -m "AUTH-123: fix login validation"
agit finish AUTH-123
```

You get a draft PR. Review it, ask for changes, and the agent's fixes land on the same PR:

```bash
agit commit -m "AUTH-123: address review"
agit finish AUTH-123
```

`finish` never force-pushes. If the branch was rewritten so that the published commit is no longer an ancestor, it stops and tells you, instead of quietly reporting success.

If the agent starts in an empty chat, generate a prompt:

```bash
agit prompt AUTH-123
```

## Isolate this clone

`agit isolate` is how layer 4 is turned on. It is a property of **this clone**, not of the project.

What it does:

- Creates `.agit/mirror.git` (gitignored) and points `origin` at it.
- Stores the previous `origin` URL in `git config agit.pushUrl`.
- On `start` and `finish`, syncs the default branch from that URL into the mirror. Unpublished `agit/*` branches already on the mirror are left alone.
- Rejects `git push origin <default-branch>` even with `--no-verify`.

What changes for everyday Git:

- `git fetch` / `git pull` no longer talk to GitHub. Freshness comes from `agit start` and `agit finish`.
- Your `git push` also stays local. Publish with `agit finish`, or `agit isolate --undo` first.
- `git remote get-url origin` returns the mirror path, so an agent that "discovers the URL and pushes" still does not reach GitHub.

Undo:

```bash
agit isolate --undo
```

That restores `origin` to the real remote. The mirror directory is kept.

## Commands

```text
agit init                   Prepare this repository
agit start <task-id>        Create or resume a task branch
agit commit -m "..."        Local commit, never a push
agit commit --files a b     Commit only these paths
agit finish <task-id>       Checks → push → draft PR (same PR on later runs)
agit status [task-id]       Task state
agit abort <task-id>        Drop a local task (not after publish)
agit doctor                 Report which protection layers are active
agit protect [--apply]      Show or create the GitHub ruleset
agit isolate [--undo]       Point this clone's origin at a local mirror
agit prompt <task-id>       Copy-paste prompt for an agent
agit install-hooks          Install the pre-push hook
agit install-agent-guards   Install the Cursor and Claude tool-call guards
```

Every command accepts `--json` so agents do not have to parse human output.

## Configuration

`.agit/profile.yml`, the parts worth knowing:

```yaml
checks:
  - npm test
checks_timeout_sec: 900   # a hanging check fails instead of hanging finish

commit:
  scope: all              # or explicit, to require agit commit --files
  denylist: [".env", ".env.*", "credentials.json", "*.pem", "*.p12"]
  allowlist: ["*.example", "*.sample", "*.template", "*.dist"]
  scan_contents: true     # also scan file contents for credentials
```

`scope: all` stages everything that changed, which is usually what an agent means, and always prints the full list. Set `scope: explicit` if you would rather have the agent name the files with `agit commit --files a.ts b.ts`.

Content scanning catches a key pasted into `config.ts`, which a filename denylist cannot do in principle. It is a cheap local check, not a replacement for GitHub secret scanning push protection.

Isolation is not in this file. It lives in the clone's git config (`agit.isolate`, `agit.pushUrl`) so a `start` from `origin/main` cannot roll it back, and so a teammate's clone is not silently isolated.

## Who this is for

Teams that already let Cursor, Claude Code, Copilot, or Codex touch a real repository and want a boring, reviewable handoff: one branch, one draft PR, checks before publish.

## What agit does not do

- It does not run agents, replace GitHub, or hide a merge queue.
- It does not sandbox the agent or hold a separate credential. `agit isolate` stops `git push origin` and `git push "$(git remote get-url origin)"`. It does not stop `git push git@github.com:…` or `git push "$(git config --get agit.pushUrl)"`.
- It does not defend against a hostile agent. It reduces the cost of an unreliable one.
- It does not resolve conflicts. On conflict, it stops and asks a human.

## Contributing

The core loop is intentionally small. Useful contributions:

- dogfood it on a real repo and open issues for agent failure modes
- guard cases that should be denied or allowed and currently are not
- clearer errors when `gh` or checks fail
- adapters for agent tools without a tool-call hook API

```bash
git clone https://github.com/hudishkin/agit.git
cd agit
npm install
npm test
node bin/agit.js --help
```

Open an issue or a PR. A failed agent session with the exact commands it ran is more useful than a vague "Git is messy" report.

## Name

Other tools also use the `agit` command (session stores, context graphs). The npm package is `@hudishkin/agit`; the binary is `agit`. This package writes `.agit/profile.yml` and does not manage agent transcripts. If another `agit` is already on `PATH`, call this one with `npx agit`.

## License

MIT
