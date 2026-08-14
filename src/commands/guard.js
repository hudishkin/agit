import { claudeResponse, classifyCommand, commandFromPayload, cursorResponse } from "../guard.js";

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

  const verdict = classifyCommand(commandFromPayload(payload));

  if (vendor === "claude") {
    const response = claudeResponse(verdict);
    if (response) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
    return verdict;
  }

  stdout.write(`${JSON.stringify(cursorResponse(verdict))}\n`);
  return verdict;
}
