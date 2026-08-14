# agit

**A boring, reviewable handoff between an AI coding agent and your Git remote.**

The agent starts a task, commits locally, and finishes into one draft pull request. You get one branch, a history you can read, and a human still merges.

```bash
agit start AUTH-123
# edit code
agit commit -m "AUTH-123: fix login validation"
agit finish AUTH-123
```

## The problem

AI coding agents are good at changing code and bad at Git.

They push too early, open a second pull request for a follow-up, commit `.env` files, invent branch names, force-push, and sometimes push to `main`. A long `AGENTS.md` does not stop this. Agents forget rules, or ignore them "to be helpful."

The result is noisy remotes, broken CI, dirty history, and pull requests a human cannot review.

`AGENTS.md` is a hint. Agit still writes one — and, in Cursor and Claude Code, intercepts `git push` / `git commit` before the shell runs them:

```text
agit blocked: git push is managed by agit in this repository.
Run: agit finish <task-id>
```

Without those hooks, you are back to instructions.

## What agit does

`agit` is a small CLI protocol. Git mutations go through that interface instead of raw `git`.

| Command | What happens |
| --- | --- |
| `agit start <task-id>` | Creates a local `agit/<task-id>` branch from `origin/<default>`. No push. |
| `agit commit -m "..."` | Commits locally. Prints the file list. Blocks secrets. Never pushes. |
| `agit finish <task-id>` | Runs your checks. If they pass: push and a **draft PR**. Review fixes go to the same PR. |
| `agit status` | Prints task state as text or `--json` for the agent. |

Read-only Git stays allowed: `git status`, `git diff`, `git log`.

## Why this is not an alias

Agit makes the wrong thing inconvenient and the right thing the path of least resistance. `agit doctor` reports which layers are actually active in this clone, and says so plainly when one is missing.

**Layer 1: GitHub rules (server-side).** Push to the default branch, force-push, and merges without review are blocked by a GitHub ruleset. This is the only layer a local agent cannot bypass. `agit protect --apply` creates it.

**Layer 2: agent tool-call guards.** `init` wires Cursor's `beforeShellExecution` and Claude Code's `PreToolUse` hooks to `agit guard`. A blocked command gets a redirect, not a bare refusal. The Cursor hook is fail-closed. Claude Code also gets declarative `permissions.deny` rules.

**Layer 3: git pre-push hook.** A raw `git push` fails unless `agit finish` issued a single-use token bound to the exact commit being pushed. The hook is installed at the path git actually uses, so it works alongside husky. An existing `pre-push` hook is backed up, not overwritten.

**Layer 4: the local mirror (optional).** `agit isolate` points this clone's `origin` at `.agit/mirror.git`. Details below.

Push to `main`, force-push, and dirty history are closed by layer 1, which is GitHub's job, not agit's.

## Install

Needs Node 20+, `git`, and [GitHub CLI](https://cli.github.com/) (`gh`) for `finish`.

```bash
npm i -g @hudishkin/agit
```

Or keep it in the repo so agents can find it with `npx`:

```bash
npm i -D @hudishkin/agit
npx agit init --yes --checks "npm test"
agit start AUTH-123
# change code; git diff and git status are fine
agit commit -m "AUTH-123: fix login validation"
agit finish AUTH-123
```

`init` writes `.agit/profile.yml`, merges an agit section into `AGENTS.md`, installs the pre-push hook and the agent guards, and adds Cursor / Claude / Copilot instruction files. After `init`, layers 2 and 3 are already on. It does not overwrite the rest of your `AGENTS.md`, your hooks, or your existing hook configuration. It does not rewrite `origin`.

Then, if you want the layers `init` cannot turn on by itself:

```bash
agit protect --apply    # GitHub ruleset; needs admin on the repo
agit isolate            # optional; this clone only
agit doctor             # confirm what is actually active
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

## Who this is for

People who already let a coding agent commit or push in a real repository, and want one branch, one draft PR, and checks before publish.

Hooks are first-class for **Cursor** and **Claude Code**. Copilot gets instruction files. Codex can follow the CLI; there is no Codex adapter.

Not for: workflows where the agent is never allowed to touch Git; hosted agents whose platform already owns the PR workflow; or anyone who needs a sandbox.

## What agit does not do

- It does not run agents, replace GitHub, or hide a merge queue.
- It does not sandbox the agent or hold a separate credential. The guard blocks `git push` (including a literal URL), mutating `curl`/`wget` to `api.github.com`, and reading `agit.pushUrl` in an isolated clone. A process that skips the guard and already has a URL can still push.
- It does not defend against a hostile agent. It reduces the cost of an unreliable one.
- It does not resolve conflicts. On conflict, it stops and asks a human.

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
agit init [--mode remote]   Prepare this repository (remote = local git, no publish)
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
workflow:
  enforcement: remote     # new init default. protocol = current agit CLI workflow

checks:
  - npm test
checks_timeout_sec: 900   # a hanging check fails instead of hanging finish

commit:
  scope: all              # or explicit, to require agit commit --files
  denylist: [".env", ".env.*", "credentials.json", "*.pem", "*.p12"]
  allowlist: ["*.example", "*.sample", "*.template", "*.dist"]
  scan_contents: true     # also scan file contents for credentials
```

`enforcement: remote` lets the agent use local git and blocks publish (`git push`, mutating `gh`/`curl`, `agit finish`). A human runs `agit finish` in their own terminal. Existing profiles without this key stay on `protocol`, where git mutations go through `agit start` / `commit` / `finish`. `agit init --yes --mode protocol` keeps that workflow. `patch` denies local commits too.

`scope: all` stages everything that changed, which is usually what an agent means, and always prints the full list. Set `scope: explicit` if you would rather have the agent name the files with `agit commit --files a.ts b.ts`.

Content scanning catches a key pasted into `config.ts`, which a filename denylist cannot do in principle. It is a cheap local check, not a replacement for GitHub secret scanning push protection.

Isolation is not in this file. It lives in the clone's git config (`agit.isolate`, `agit.pushUrl`) so a `start` from `origin/main` cannot roll it back, and so a teammate's clone is not silently isolated.

## Contributing

Try it on one repository where the agent can already commit or push. If agit blocks a Git action you actually wanted, open an issue with the exact command.

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
