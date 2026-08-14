export function successPayload(command, data = {}) {
  return { ok: true, command, data };
}

export function errorPayload(command, error) {
  return {
    ok: false,
    command,
    error: {
      code: error.code ?? "error",
      message: error.message,
      hint: error.hint ?? null,
      details: error.details ?? null,
    },
  };
}

export function renderSuccess(command, data = {}, { json = false, stdout = process.stdout } = {}) {
  if (json) {
    stdout.write(`${JSON.stringify(successPayload(command, data))}\n`);
    return;
  }

  const text = typeof data.message === "string" ? data.message : "";
  if (text) {
    stdout.write(`${text}\n`);
  }
}

export function renderError(command, error, { json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (json) {
    stdout.write(`${JSON.stringify(errorPayload(command, error))}\n`);
    return;
  }

  stderr.write(`${error.message}\n`);
  if (error.hint) {
    stderr.write(`${error.hint}\n`);
  }
}
