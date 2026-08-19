import { claudeResponse, classifyCommand, commandFromPayload, cursorResponse } from "../guard.js";
import { isolationEnabled } from "../mirror.js";
import { agentMayFinish, enforcementOf } from "../profile.js";
import { loadWorkspace } from "../store.js";

function cwdFromPayload(payload) {
  if (payload && typeof payload.cwd === "string" && payload.cwd) {
    return payload.cwd;
  }
  return process.cwd();
}

async function guardOptionsFromCwd(cwd) {
  try {
    const { profile } = await loadWorkspace(cwd, { required: false });
    if (!profile) {
      return { enforcement: "protocol", allowFinish: true };
    }
    return { enforcement: enforcementOf(profile), allowFinish: agentMayFinish(profile) };
  } catch {
    return { enforcement: "protocol", allowFinish: true };
  }
}

async function readAll(stream) {
  if (stream.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function guardCommand(vendor, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const raw = await readAll(stdin);

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  const cwd = cwdFromPayload(payload);
  const { enforcement, allowFinish } = await guardOptionsFromCwd(cwd);
  let isolated = false;
  try {
    isolated = await isolationEnabled(cwd);
  } catch {
    isolated = false;
  }
  const verdict = classifyCommand(commandFromPayload(payload), { enforcement, isolated, allowFinish });

  if (vendor === "claude") {
    const response = claudeResponse(verdict, enforcement);
    if (response) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
    return verdict;
  }

  stdout.write(`${JSON.stringify(cursorResponse(verdict, enforcement))}\n`);
  return verdict;
}
