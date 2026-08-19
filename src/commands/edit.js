import { spawnSync } from "node:child_process";
import { AgitError } from "../errors.js";
import { loadWorkspace, storeProfilePath } from "../store.js";

function splitEditor(value) {
  const tokens = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  return { cmd: tokens[0], args: tokens.slice(1) };
}

export function editorFromEnv(env = process.env) {
  return splitEditor(env.VISUAL || env.EDITOR || "");
}

function defaultOpen(path, editor) {
  const result = spawnSync(editor.cmd, [...editor.args, path], { stdio: "inherit" });
  if (result.error) {
    throw new AgitError({
      code: "error",
      message: `Could not open the editor (${editor.cmd}).`,
      hint: `Set VISUAL or EDITOR. Profile: ${path}`,
    });
  }
  if (result.status !== 0) {
    throw new AgitError({
      code: "error",
      message: `Editor exited with status ${result.status}.`,
      hint: `Profile: ${path}`,
    });
  }
}

export async function editCommand(
  cwd,
  { tty = Boolean(process.stdin.isTTY), openEditor = defaultOpen } = {},
) {
  const { store } = await loadWorkspace(cwd, { createHome: true });
  const path = storeProfilePath(store);
  const editor = editorFromEnv();

  if (!tty) {
    return {
      path,
      store: store.kind,
      opened: false,
      message: `Profile: ${path}`,
    };
  }

  if (!editor) {
    throw new AgitError({
      code: "error",
      message: "No editor is set.",
      hint: `Set VISUAL or EDITOR, or open ${path}`,
    });
  }

  openEditor(path, editor);
  return {
    path,
    store: store.kind,
    opened: true,
    message: `Opened ${path}`,
  };
}
