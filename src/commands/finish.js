import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLogTail, runChecks } from "../checks.js";
import { ChecksFailed, DirtyTree, PublishFailed, TaskStateError, WrongBranch } from "../errors.js";
import { inspectMergeRequest, openerFor, providerOf } from "../prhost.js";
import { doneHint } from "./done.js";
import {
  commitSubject,
  currentBranch,
  diffNames,
  fetch,
  firstCommitSubject,
  isAncestor,
  isClean,
  logOneline,
  push,
  rebaseOnto,
  refExists,
  remoteBranchSha,
  revParse,
  squashCommits,
} from "../git.js";
import { withTaskLock } from "../lock.js";
import { isolationEnabled, publishUrl, syncMirror, updateMirrorBranch } from "../mirror.js";
import { formatTitle, renderPrBody, summarizeCommit } from "../prbody.js";
import { resolveTaskTree } from "../root.js";
import { loadWorkspace, storeLogsDir } from "../store.js";
import { assertTaskId, loadTask, saveTask, taskExists } from "../taskstore.js";

function shouldSquash(profile, squash) {
  if (squash === true) {
    return true;
  }
  if (squash === false) {
    return false;
  }
  return Boolean(profile.workflow.squash_on_finish);
}

// The base the task actually started from, so "what did this task change" stays
// stable even when the default branch moves underneath it.
async function resolveBase(cwd, task, profile) {
  for (const candidate of [task.base_sha, task.base_ref]) {
    if (candidate && (await refExists(cwd, candidate))) {
      return candidate;
    }
  }

  const base = profile.repo.default_branch;
  for (const candidate of [`origin/${base}`, base]) {
    if (await refExists(cwd, candidate)) {
      return candidate;
    }
  }

  throw new TaskStateError(
    `Cannot resolve the base branch for task ${task.task_id}.`,
    "Set repo.default_branch in .agit/profile.yml to a branch that exists.",
  );
}

async function rebaseOntoDefault(tree, profile, task) {
  const upstream = `origin/${profile.repo.default_branch}`;
  if (!(await refExists(tree, upstream))) {
    return false;
  }
  if (await isAncestor(tree, upstream, "HEAD")) {
    return false;
  }

  const result = await rebaseOnto(tree, upstream);
  if (!result.ok) {
    const files = result.files.length ? result.files.join(", ") : "unknown paths";
    throw new TaskStateError(
      `Could not rebase onto ${upstream}.`,
      `Conflicts in ${files}. The worktree is clean again. Fix the overlap, or pass --no-rebase.`,
      { conflicts: result.files, upstream },
    );
  }

  task.base_ref = upstream;
  task.base_sha = await revParse(tree, upstream);
  return true;
}

export async function finishCommand(cwd, taskId, { createPr, squash, rebase, inspectPr: inspect = inspectMergeRequest } = {}) {
  assertTaskId(taskId);

  const { store, profile, root } = await loadWorkspace(cwd);
  const state = store.dir;
  if (!taskExists(state, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }
  const provider = providerOf(profile);
  const openPr = createPr ?? openerFor(provider);
  const isolated = await isolationEnabled(cwd);
  if (isolated) {
    await syncMirror(cwd, profile);
  }

  return withTaskLock(state, taskId, async () => {
    const task = loadTask(state, taskId);
    const tree = resolveTaskTree(store, task, cwd);
    if (task.worktree && !existsSync(tree)) {
      throw new TaskStateError(
        `Task ${taskId} worktree is missing.`,
        `Run agit start ${taskId} to recreate it.`,
      );
    }

    const branch = await currentBranch(tree);
    const wasPushed = Boolean(task.publish?.pushed);

    if (shouldSquash(profile, squash) && wasPushed) {
      throw new TaskStateError(
        "Cannot squash after the branch was pushed.",
        "Do not force-push. Open a new task if you need a squashed history.",
      );
    }

    if (branch === profile.repo.default_branch) {
      throw new WrongBranch(`Refusing to finish on ${branch}.`);
    }

    if (branch !== task.branch) {
      throw new WrongBranch(`Current branch ${branch} does not match task ${taskId}.`);
    }

    const existingPr = task.publish?.pr_url ?? null;
    if (existingPr) {
      const pr = await inspect(root, existingPr);
      if (pr?.merged) {
        return {
          task_id: taskId,
          branch: task.branch,
          pr_url: existingPr,
          pushed: wasPushed,
          already: true,
          merged: true,
          status: task.status,
          message: `PR already merged:\n${existingPr}\n${doneHint(taskId)}`,
        };
      }
    }

    if (!(await isClean(tree))) {
      throw new DirtyTree("Working tree is not clean.");
    }

    const head = await revParse(tree, "HEAD");
    const publishedSha = task.publish?.pushed_sha ?? null;

    if (wasPushed && existingPr && publishedSha === head) {
      return {
        task_id: taskId,
        branch: task.branch,
        pr_url: existingPr,
        pushed: true,
        already: true,
        status: "pr_created",
        message: `Draft PR already up to date:\n${existingPr}`,
      };
    }

    let base = await resolveBase(tree, task, profile);
    const ahead = await logOneline(tree, `${base}..HEAD`);
    if (ahead.length === 0) {
      throw new TaskStateError("Nothing to publish.", "Run agit commit first.");
    }

    const needsPush = !wasPushed || publishedSha !== head;

    if (needsPush) {
      if (!wasPushed && rebase !== false) {
        if (!isolated) {
          await fetch(tree);
        }
        if (await rebaseOntoDefault(tree, profile, task)) {
          saveTask(state, task);
          base = await resolveBase(tree, task, profile);
        }
      }

      const logPath = join(storeLogsDir(store), `${taskId}-checks.log`);
      const checkResults = await runChecks(tree, profile.checks ?? [], logPath, {
        timeoutSec: profile.checks_timeout_sec,
      });
      const failed = checkResults.filter((check) => !check.ok);
      task.checks = { last_status: failed.length ? "failed" : "passed", results: checkResults };

      if (failed.length > 0) {
        task.status = "checks_failed";
        saveTask(state, task);
        throw new ChecksFailed(
          "Finish failed: checks did not pass.",
          `Fix the errors and run agit finish ${taskId} again.`,
          {
            failed: failed.map((check) => check.command),
            log_path: logPath,
            log_tail: readLogTail(logPath),
          },
        );
      }

      if (!(await isClean(tree))) {
        saveTask(state, task);
        throw new DirtyTree(
          "Checks passed, but they left the working tree dirty.",
          "Commit the check output with agit commit, or restore the files, then run agit finish again.",
        );
      }

      if (shouldSquash(profile, squash)) {
        const subject = await firstCommitSubject(tree, base);
        const hash = await squashCommits(tree, base, subject);
        task.commits = [hash];
        saveTask(state, task);
      }

      if (wasPushed) {
        const publishedRemote = isolated ? await publishUrl(cwd, profile) : "origin";
        const remoteSha = await remoteBranchSha(tree, task.branch, publishedRemote);
        if (remoteSha && !(await isAncestor(tree, remoteSha, "HEAD"))) {
          const localSha = await revParse(tree, "HEAD");
          throw new TaskStateError(
            "The task branch has diverged from what was already published.",
            `agit never force-pushes. Local HEAD is ${localSha}. Remote is ${remoteSha}. Reconcile locally, or run agit start with a new task id.`,
            { local_sha: localSha, remote_sha: remoteSha },
          );
        }
      }

      try {
        const target = isolated ? await publishUrl(cwd, profile) : undefined;
        await push(root, task.branch, { allow: true, url: target });
        if (isolated) {
          await updateMirrorBranch(root, task.branch, await revParse(tree, "HEAD"));
        }
      } catch (error) {
        saveTask(state, task);
        if (error instanceof PublishFailed) {
          throw error;
        }
        throw new PublishFailed("git push failed.", `Fix the remote error and run agit finish ${taskId} again.`, {
          error: error.message,
        });
      }

      task.publish = {
        ...(task.publish ?? {}),
        pushed: true,
        pushed_sha: await revParse(tree, "HEAD"),
        pr_url: existingPr,
      };
      task.status = existingPr ? "pr_created" : "pushed";
      saveTask(state, task);
    }

    const files = await diffNames(tree, `${base}...HEAD`);
    const checks = task.checks?.results ?? [];

    if (existingPr) {
      return {
        task_id: taskId,
        branch: task.branch,
        pr_url: existingPr,
        pushed: true,
        already: false,
        status: "pr_created",
        files,
        checks,
        message: `Pushed ${task.branch}\nUpdated draft PR:\n${existingPr}`,
      };
    }

    if (provider === "none") {
      return {
        task_id: taskId,
        branch: task.branch,
        pr_url: null,
        pushed: true,
        already: !needsPush,
        status: "pushed",
        files,
        checks,
        message: `Pushed ${task.branch}\nNo pull request opened (pr.provider is none).`,
      };
    }

    const subject = await commitSubject(tree);
    const summary = task.title || summarizeCommit(taskId, subject);
    const title = formatTitle(profile.pr.title_template, taskId, summary);
    const body = renderPrBody({
      taskId,
      branch: task.branch,
      summary: task.body || summary,
      checks,
      files,
      issue: task.issue ?? null,
    });

    try {
      const repo =
        profile.repo.owner && profile.repo.name ? `${profile.repo.owner}/${profile.repo.name}` : undefined;
      const prUrl = await openPr(tree, {
        base: profile.pr.base ?? profile.repo.default_branch,
        head: task.branch,
        title,
        body,
        repo,
      });
      task.publish = { ...(task.publish ?? {}), pushed: true, pr_url: prUrl };
      task.status = "pr_created";
      saveTask(state, task);

      return {
        task_id: taskId,
        branch: task.branch,
        pr_url: prUrl,
        pushed: true,
        already: false,
        status: "pr_created",
        files,
        checks,
        message: `Pushed ${task.branch}\nDraft ${provider === "gitlab" ? "merge request" : "PR"} created:\n${prUrl}`,
      };
    } catch (error) {
      task.status = "pushed";
      saveTask(state, task);
      if (error instanceof PublishFailed) {
        throw error;
      }
      throw new PublishFailed(
        "Checks passed, but remote publish failed.",
        `Run agit finish ${taskId} again later.`,
        { error: error.message },
      );
    }
  });
}
