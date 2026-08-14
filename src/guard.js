const GIT_HINTS = {
  push: "Run: agit finish <task-id>",
  commit: 'Run: agit commit -m "<task-id>: <summary>"',
  checkout: "Run: agit start <task-id>",
  switch: "Run: agit start <task-id>",
  restore: "Edit files directly instead of restoring them with git.",
  branch: "Run: agit start <task-id>",
  pull: "Do not pull. Start a new task id if you need a fresh base from origin.",
  merge: "Stop and report the conflict. Do not merge.",
  rebase: "Stop and report. Do not rewrite published history.",
  reset: "Stop and report. Do not rewrite history.",
  revert: 'Make the fix as a normal change and run: agit commit -m "<task-id>: ..."',
  "cherry-pick": "Stop and report. Do not move commits between branches.",
  stash: "Leave the working tree alone; agit commit stages what you changed.",
  clean: "Do not delete untracked work.",
  rm: "Delete the file with your editor tools; agit commit stages the deletion.",
  mv: "Move the file with your editor tools; agit commit stages the rename.",
  tag: "agit does not use tags for task workflow.",
  remote: "Do not change remotes.",
  submodule: "Do not change submodules.",
  worktree: "Do not create worktrees.",
  "update-ref": "Do not move refs by hand.",
  "filter-branch": "Do not rewrite history.",
  am: "Do not apply patches; make the change directly.",
  apply: "Do not apply patches; make the change directly.",
  gc: "Do not run garbage collection.",
  prune: "Do not prune objects.",
};

const MUTATING_GIT = new Set(Object.keys(GIT_HINTS));

const REMOTE_PUSH_HINT = "A human publishes with agit finish <task-id>.";
const REMOTE_FOOTER = "Local git is allowed. Do not push or create pull requests.";
const PROTOCOL_FOOTER = "Read-only git is allowed: git status, git diff, git log.";

// Subcommands that mutate only when given more than a listing flag.
const LISTABLE_GIT = new Map([
  ["branch", new Set(["-l", "--list", "-v", "-vv", "-a", "--all", "-r", "--remotes", "--show-current", "--merged", "--no-merged", "--contains", "--points-at", "--format", "--sort", "--color", "--no-color"])],
  ["tag", new Set(["-l", "--list", "-n", "--contains", "--points-at", "--merged", "--no-merged", "--format", "--sort", "--color", "--no-color"])],
  ["remote", new Set(["-v", "--verbose", "show", "get-url"])],
  ["stash", new Set(["list", "show"])],
]);

const READONLY_CONFIG_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);

// Global git options that consume the following token as their value.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

const GH_MUTATING = new Map([
  ["pr", new Set(["create", "merge", "ready", "close", "reopen", "edit"])],
  ["release", new Set(["create", "delete", "upload", "edit"])],
  ["repo", new Set(["delete", "archive", "edit", "rename"])],
]);

const HTTP_MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CURL_BODY_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "--json",
]);

export function tokenize(segment) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(segment);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
    match = pattern.exec(segment);
  }
  return tokens;
}

function segments(command) {
  return command.split(/\|\||&&|;|\||\n|&/).map((part) => part.trim()).filter(Boolean);
}

function isProgram(token, name) {
  const bare = token.replace(/\.exe$/i, "");
  return bare === name || bare.endsWith(`/${name}`);
}

function subcommandOf(tokens, programIndex) {
  let index = programIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      return { name: token, args: tokens.slice(index + 1) };
    }
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return { name: null, args: [] };
}

function findProgram(tokens, name) {
  return tokens.findIndex((token) => isProgram(token, name));
}

function listingOnly(subcommand, args) {
  const allowed = LISTABLE_GIT.get(subcommand);
  if (!allowed) {
    return false;
  }
  // `git stash` with no args is `stash push`, not a listing.
  if (args.length === 0) {
    return subcommand !== "stash";
  }
  return args.every((arg) => allowed.has(arg) || allowed.has(arg.split("=")[0]));
}

function denial(reason, hint) {
  return { decision: "deny", reason, hint };
}

const ALLOW = { decision: "allow", reason: null, hint: null };

function optionsOf(options) {
  if (typeof options === "number") {
    return { depth: options, enforcement: "protocol", isolated: false };
  }
  return {
    depth: options?.depth ?? 0,
    enforcement: options?.enforcement === "remote" ? "remote" : "protocol",
    isolated: Boolean(options?.isolated),
  };
}

function publishHint(enforcement) {
  return enforcement === "remote" ? REMOTE_PUSH_HINT : "Run: agit finish <task-id>.";
}

export function classifyCommand(command, options = {}) {
  const { depth, enforcement, isolated } = optionsOf(options);
  if (typeof command !== "string" || !command.trim()) {
    return ALLOW;
  }

  if (/agit-allow-push/.test(command)) {
    return denial("Tampering with the agit push token is not allowed.", publishHint(enforcement));
  }

  for (const segment of segments(command)) {
    const tokens = tokenize(segment);

    const gitIndex = findProgram(tokens, "git");
    if (gitIndex !== -1) {
      const verdict = classifyGit(tokens, gitIndex, enforcement, isolated);
      if (verdict.decision === "deny") {
        return verdict;
      }
    }

    const ghIndex = findProgram(tokens, "gh");
    if (ghIndex !== -1) {
      const verdict = classifyGh(tokens, ghIndex, enforcement);
      if (verdict.decision === "deny") {
        return verdict;
      }
    }

    const curlIndex = findProgram(tokens, "curl");
    if (curlIndex !== -1) {
      const verdict = classifyCurl(tokens, curlIndex, enforcement);
      if (verdict.decision === "deny") {
        return verdict;
      }
    }

    const wgetIndex = findProgram(tokens, "wget");
    if (wgetIndex !== -1) {
      const verdict = classifyWget(tokens, wgetIndex, enforcement);
      if (verdict.decision === "deny") {
        return verdict;
      }
    }

    const agitIndex = tokens.findIndex(isAgitBinary);
    if (agitIndex !== -1) {
      const verdict = classifyAgit(tokens, agitIndex, enforcement);
      if (verdict.decision === "deny") {
        return verdict;
      }
    }

    // sh -c "git push" hides the real command inside one quoted token.
    if (depth < 3) {
      for (const token of tokens) {
        if (!/\s/.test(token)) {
          continue;
        }
        const verdict = classifyCommand(token, { depth: depth + 1, enforcement, isolated });
        if (verdict.decision === "deny") {
          return verdict;
        }
      }
    }
  }

  return ALLOW;
}

function classifyRemoteGit(name, args, tokens) {
  if (tokens.includes("--no-verify")) {
    return denial("Skipping git hooks is not allowed.", "Do not pass --no-verify.");
  }

  if (name === "config") {
    const readOnly = args.some((arg) => READONLY_CONFIG_FLAGS.has(arg.split("=")[0]));
    return readOnly
      ? ALLOW
      : denial("Changing git config is not allowed.", "Ask the human to change git config.");
  }

  if (name === "push") {
    return denial("git push is blocked in this repository.", REMOTE_PUSH_HINT);
  }

  if (name === "reset" && args.some((arg) => arg === "--hard" || arg.startsWith("--hard="))) {
    return denial("git reset --hard is not allowed.", "Do not destroy the working tree.");
  }

  return ALLOW;
}

function readsPushUrl(args) {
  if (args.some((arg) => arg === "agit.pushUrl" || arg.endsWith(".agit.pushUrl"))) {
    return true;
  }
  const regexpAt = args.findIndex((arg) => arg === "--get-regexp");
  if (regexpAt === -1) {
    return false;
  }
  return /agit|pushUrl/i.test(args[regexpAt + 1] ?? "");
}

function classifyGit(tokens, gitIndex, enforcement, isolated) {
  const { name, args } = subcommandOf(tokens, gitIndex);

  if (name === "config" && isolated && readsPushUrl(args)) {
    return denial(
      "The publish URL is not visible to the agent.",
      "A human publishes with agit finish <task-id>.",
    );
  }

  if (enforcement === "remote") {
    return classifyRemoteGit(name, args, tokens);
  }

  if (tokens.includes("--no-verify")) {
    return denial("Skipping git hooks is not allowed.", "Run: agit finish <task-id>");
  }

  if (name === null) {
    return ALLOW;
  }

  if (name === "config") {
    const readOnly = args.some((arg) => READONLY_CONFIG_FLAGS.has(arg.split("=")[0]));
    return readOnly
      ? ALLOW
      : denial("Changing git config is not allowed.", "Ask the human to change git config.");
  }

  if (name === "fetch") {
    if (args.some(isRefspec)) {
      return denial(
        "git fetch with a refspec can move local branches.",
        "Run: agit start <task-id> to refresh from origin.",
      );
    }
    return ALLOW;
  }

  if (!MUTATING_GIT.has(name)) {
    return ALLOW;
  }

  if (listingOnly(name, args)) {
    return ALLOW;
  }

  return denial(
    `git ${name} is managed by agit in this repository.`,
    GIT_HINTS[name] ?? "Use agit for git mutations.",
  );
}

function isRefspec(arg) {
  if (!arg.includes(":") || arg.startsWith("-")) {
    return false;
  }
  if (arg.includes("://")) {
    return false;
  }
  // scp-like remote: git@host:path
  if (/^[\w.-]+@[\w.-]+:/.test(arg)) {
    return false;
  }
  return true;
}

function classifyGhApi(args, hint) {
  const methodAt = args.findIndex((arg) => arg === "--method" || arg === "-X");
  const method = methodAt !== -1 ? (args[methodAt + 1] ?? "").toUpperCase() : null;
  const isGraphql = args.some((arg) => arg === "graphql" || arg.startsWith("graphql/"));
  const hasBody = args.some(
    (arg) =>
      arg === "--input" ||
      arg === "-f" ||
      arg === "-F" ||
      arg === "--raw-field" ||
      arg.startsWith("-f=") ||
      arg.startsWith("-F="),
  );
  const effective = method ?? (hasBody || isGraphql ? "POST" : "GET");
  if (effective === "GET" || effective === "HEAD") {
    return ALLOW;
  }
  return denial("gh api mutations are managed by agit in this repository.", hint);
}

function classifyGh(tokens, ghIndex, enforcement) {
  const hint = publishHint(enforcement);
  const { name, args } = subcommandOf(tokens, ghIndex);
  if (name === "api") {
    return classifyGhApi(args, hint);
  }
  const mutating = GH_MUTATING.get(name);
  if (!mutating) {
    return ALLOW;
  }
  const action = args.find((arg) => !arg.startsWith("-"));
  if (action && mutating.has(action)) {
    return denial(`gh ${name} ${action} is managed by agit in this repository.`, hint);
  }
  return ALLOW;
}

function looksLikeGithubApi(token) {
  return /api\.github\.com/i.test(token);
}

function httpMethodFromFlags(args, { methodFlags, bodyFlags, inlinePrefix }) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (methodFlags.has(arg)) {
      return (args[index + 1] ?? "").toUpperCase();
    }
    if (inlinePrefix && arg.startsWith(inlinePrefix) && arg.length > inlinePrefix.length) {
      return arg.slice(inlinePrefix.length).toUpperCase();
    }
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
    if (arg.startsWith("--request=")) {
      return arg.slice("--request=".length).toUpperCase();
    }
  }
  if (args.some((arg) => bodyFlags.has(arg.split("=")[0]))) {
    return "POST";
  }
  return "GET";
}

function classifyHttpToGithub(args, method, enforcement) {
  if (!args.some(looksLikeGithubApi)) {
    return ALLOW;
  }
  if (!HTTP_MUTATING.has(method)) {
    return ALLOW;
  }
  return denial("Mutating HTTP to GitHub is blocked.", publishHint(enforcement));
}

function classifyCurl(tokens, curlIndex, enforcement) {
  const args = tokens.slice(curlIndex + 1);
  const method = httpMethodFromFlags(args, {
    methodFlags: new Set(["-X", "--request"]),
    bodyFlags: CURL_BODY_FLAGS,
    inlinePrefix: "-X",
  });
  return classifyHttpToGithub(args, method, enforcement);
}

function classifyWget(tokens, wgetIndex, enforcement) {
  const args = tokens.slice(wgetIndex + 1);
  const method = httpMethodFromFlags(args, {
    methodFlags: new Set(["--method"]),
    bodyFlags: new Set(["--post-data", "--post-file"]),
    inlinePrefix: null,
  });
  return classifyHttpToGithub(args, method, enforcement);
}

function isAgitBinary(token) {
  const bare = token.replace(/\.exe$/i, "");
  return bare === "agit" || bare.endsWith("/agit") || bare === "agit.js" || bare.endsWith("/agit.js");
}

function classifyAgit(tokens, agitIndex, enforcement) {
  if (enforcement !== "remote") {
    return ALLOW;
  }
  const { name } = subcommandOf(tokens, agitIndex);
  if (name === "finish") {
    return denial(
      "agit finish is not allowed for the agent in remote mode.",
      "A human runs agit finish <task-id> in their own terminal.",
    );
  }
  return ALLOW;
}

function footerFor(enforcement) {
  return enforcement === "remote" ? REMOTE_FOOTER : PROTOCOL_FOOTER;
}

export function cursorResponse(verdict, enforcement = "protocol") {
  if (verdict.decision === "allow") {
    return { permission: "allow" };
  }
  return {
    permission: "deny",
    user_message: `agit blocked: ${verdict.reason}`,
    agent_message: `${verdict.reason}\n${verdict.hint}\n${footerFor(enforcement)}`,
  };
}

export function claudeResponse(verdict, enforcement = "protocol") {
  if (verdict.decision === "allow") {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${verdict.reason}\n${verdict.hint}\n${footerFor(enforcement)}`,
    },
  };
}

export function commandFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.command === "string") {
    return payload.command;
  }
  return typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
}
