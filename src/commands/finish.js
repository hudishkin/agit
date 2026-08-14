import { join } from "node:path";
import { runChecks } from "../checks.js";
import { ChecksFailed, DirtyTree, NotInitialized, PublishFailed, TaskStateError, WrongBranch } from "../errors.js";
import { createDraftPr } from "../gh.js";
import {
  commitSubject,
  currentBranch,
  diffNames,
  firstCommitSubject,
  isAncestor,
  isClean,
  isRepo,
  logOneline,
  push,
  refExists,
  remoteBranchSha,
  revParse,
  squashCommits,
} from "../git.js";
import { isolationEnabled, publishUrl, syncMirror, updateMirrorBranch } from "../mirror.js";
import { LOGS_DIR } from "../paths.js";
import { formatTitle, renderPrBody, summarizeCommit } from "../prbody.js";
import { loadProfile, profileExists } from "../profile.js";
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

export async function finishCommand(cwd, taskId, { createPr = createDraftPr, squash } = {}) {
  assertTaskId(taskId);

  if (!(await isRepo(cwd))) {
    throw new NotInitialized("Not a Git repository.", "Run this command inside a Git repository.");
  }

  if (!profileExists(cwd)) {
    throw new NotInitialized("agit is not initialized.");
  }

  if (!taskExists(cwd, taskId)) {
    throw new TaskStateError(`Task ${taskId} was not found.`, "Run agit start <task-id> first.");
  }

  const profile = loadProfile(cwd);
  const isolated = await isolationEnabled(cwd);
  if (isolated) {
    await syncMirror(cwd, profile);
  }

  const task = loadTask(cwd, taskId);
  const branch = await currentBranch(cwd);
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

  if (!(await isClean(cwd))) {
    throw new DirtyTree("Working tree is not clean.");
  }

  const head = await revParse(cwd, "HEAD");
  const publishedSha = task.publish?.pushed_sha ?? null;
  const existingPr = task.publish?.pr_url ?? null;

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

  const base = await resolveBase(cwd, task, profile);
  const ahead = await logOneline(cwd, `${base}..HEAD`);
  if (ahead.length === 0) {
    throw new TaskStateError("Nothing to publish.", "Run agit commit first.");
  }

  const needsPush = !wasPushed || publishedSha !== head;

  if (needsPush) {
    const logPath = join(cwd, LOGS_DIR, `${taskId}-checks.log`);
    const checkResults = await runChecks(cwd, profile.checks ?? [], logPath, {
      timeoutSec: profile.checks_timeout_sec,
    });
    const failed = checkResults.filter((check) => !check.ok);
    task.checks = { last_status: failed.length ? "failed" : "passed", results: checkResults };

    if (failed.length > 0) {
      task.status = "checks_failed";
      saveTask(cwd, task);
      throw new ChecksFailed(
        "Finish failed: checks did not pass.",
        `Fix the errors and run agit finish ${taskId} again.`,
        { failed: failed.map((check) => check.command) },
      );
    }

    if (shouldSquash(profile, squash)) {
      const subject = await firstCommitSubject(cwd, base);
      const hash = await squashCommits(cwd, base, subject);
      task.commits = [hash];
      saveTask(cwd, task);
    }

    if (wasPushed) {
      const publishedRemote = isolated ? await publishUrl(cwd, profile) : "origin";
      const remoteSha = await remoteBranchSha(cwd, task.branch, publishedRemote);
      if (remoteSha && !(await isAncestor(cwd, remoteSha, "HEAD"))) {
        throw new TaskStateError(
          "The task branch has diverged from what was already published.",
          "agit never force-pushes. Reconcile locally, or open a new task id.",
        );
      }
    }

    try {
      const target = isolated ? await publishUrl(cwd, profile) : undefined;
      await push(cwd, task.branch, { allow: true, url: target });
      if (isolated) {
        await updateMirrorBranch(cwd, task.branch, await revParse(cwd, "HEAD"));
      }
    } catch (error) {
      saveTask(cwd, task);
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
      pushed_sha: await revParse(cwd, "HEAD"),
      pr_url: existingPr,
    };
    task.status = existingPr ? "pr_created" : "pushed";
    saveTask(cwd, task);
  }

  const files = await diffNames(cwd, `${base}...HEAD`);
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

  const subject = await commitSubject(cwd);
  const summary = summarizeCommit(taskId, subject);
  const title = formatTitle(profile.pr.title_template, taskId, summary);
  const body = renderPrBody({ taskId, branch: task.branch, summary, checks, files });

  try {
    const repo =
      profile.repo.owner && profile.repo.name ? `${profile.repo.owner}/${profile.repo.name}` : undefined;
    const prUrl = await createPr(cwd, {
      base: profile.pr.base ?? profile.repo.default_branch,
      head: task.branch,
      title,
      body,
      repo,
    });
    task.publish = { ...(task.publish ?? {}), pushed: true, pr_url: prUrl };
    task.status = "pr_created";
    saveTask(cwd, task);

    return {
      task_id: taskId,
      branch: task.branch,
      pr_url: prUrl,
      pushed: true,
      already: false,
      status: "pr_created",
      files,
      checks,
      message: `Pushed ${task.branch}\nDraft PR created:\n${prUrl}`,
    };
  } catch (error) {
    task.status = "pushed";
    saveTask(cwd, task);
    if (error instanceof PublishFailed) {
      throw error;
    }
    throw new PublishFailed(
      "Checks passed, but remote publish failed.",
      `Run agit finish ${taskId} again later.`,
      { error: error.message },
    );
  }
}
