import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_TIMEOUT_SEC = 900;

function runOne(cwd, command, log, timeoutSec) {
  return new Promise((resolve) => {
    log.write(`$ ${command}\n`);

    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);

    child.stdout.on("data", (chunk) => log.write(chunk));
    child.stderr.on("data", (chunk) => log.write(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      log.write(`agit: ${error.message}\n`);
      resolve({ command, ok: false, code: 1 });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        log.write(`agit: timed out after ${timeoutSec}s\n`);
        resolve({ command, ok: false, code: 124, timed_out: true });
        return;
      }
      if (code === 0) {
        resolve({ command, ok: true });
        return;
      }
      resolve({ command, ok: false, code: code ?? 1 });
    });
  });
}

export async function runChecks(cwd, commands, logPath, { timeoutSec = DEFAULT_TIMEOUT_SEC } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);

  const results = [];
  try {
    for (const command of commands) {
      results.push(await runOne(cwd, command, log, timeoutSec));
    }
  } finally {
    await new Promise((resolve) => log.end(resolve));
  }

  return results;
}
