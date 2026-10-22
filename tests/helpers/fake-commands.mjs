import { chmod, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Stand-ins for external commands (docker, kubectl, helm, k3d, gh, ...) that a test
// writes into a directory and puts first on PATH. Each scenario keeps its own script
// body; these helpers own the plumbing around it: the shebang, the executable mode,
// PATH and the call log.

const shebangs = {
  sh: "#!/bin/sh",
  bash: "#!/usr/bin/env bash",
  node: "#!/usr/bin/env node",
  python3: "#!/usr/bin/env python3",
};

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Writes an executable stand-in for the command `name` into `directory` and returns
// its path. `body` is the script after the shebang line, which `interpreter` picks:
// "sh" (the default), "bash", "node", "python3", or an absolute path such as
// process.execPath. With `log` (interpreter "sh" or "bash" only), the stand-in first
// appends its arguments ("$*") to that file, one line per call; read them back with
// `commandCalls`. Writing the same name again replaces the stand-in.
export async function writeCommand(directory, name, body = "", { interpreter = "sh", log } = {}) {
  const shebang = interpreter.startsWith("/")
    ? `#!${interpreter}`
    : Object.hasOwn(shebangs, interpreter)
      ? shebangs[interpreter]
      : undefined;
  if (!shebang) {
    throw new Error(`writeCommand: unknown interpreter ${JSON.stringify(interpreter)}`);
  }
  const lines = [shebang];
  if (log !== undefined) {
    if (interpreter !== "sh" && interpreter !== "bash") {
      throw new Error(`writeCommand: a call log needs a shell stand-in, not ${interpreter}`);
    }
    lines.push(`printf '%s\\n' "$*" >> ${shellQuote(log)}`);
  }
  if (body !== "") {
    lines.push(body.endsWith("\n") ? body.slice(0, -1) : body);
  }
  const path = join(directory, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  // writeFile's mode applies only when it creates the file, and under the umask.
  await chmod(path, 0o755);
  return path;
}

// A PATH value that finds commands in `directories` first, in order, then on the
// inherited PATH (if any).
export function commandPath(...directories) {
  return [...directories, process.env.PATH].filter(Boolean).join(delimiter);
}

// Puts `directories` first on this process's PATH until the test that owns `t` ends.
// For code under test that runs commands from the test process itself.
export function prependPath(t, ...directories) {
  const original = process.env.PATH;
  process.env.PATH = commandPath(...directories);
  t.after(() => {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  });
}

// The lines a call log holds, one per call, oldest first; none when no stand-in has
// run yet (the file does not exist). So a test that expects no calls should also show
// that its stand-in is reachable, or it passes when the wiring is wrong.
export async function commandCalls(log) {
  let text;
  try {
    text = await readFile(log, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}
