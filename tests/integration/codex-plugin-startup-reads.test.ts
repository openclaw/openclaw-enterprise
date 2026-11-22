import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import test from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import { runStartupReadCase } from "./codex-plugin-startup-read-cases.ts";

const cases = [
  ["ordinary", "read"],
  ["scoped-no-ambient", "read"],
  ["scoped-hostile-ambient", "read"],
  ["missing", "refuse"],
  ["invalid", "refuse"],
  ["wrong-credential", "refuse"],
] as const;

const launchInstaller: Parameters<typeof runStartupReadCase>[3] = async (script, env, signal) => {
  const options = {
    encoding: "utf8",
    env,
    signal,
    killSignal: "SIGKILL",
  } satisfies SpawnOptions & {
    encoding: BufferEncoding;
  };
  const result: unknown = await captureChild(process.execPath, ["-e", script], options);
  assert.ok(
    result &&
      typeof result === "object" &&
      "status" in result &&
      (result.status === null || typeof result.status === "number") &&
      "stdout" in result &&
      typeof result.stdout === "string" &&
      "stderr" in result &&
      typeof result.stderr === "string",
    "installer process must return an exit status and text output",
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

for (const [mode, outcome] of cases) {
  for (const retry of outcome === "read" ? [false, true] : [false]) {
    test(
      outcome === "refuse"
        ? `generated Codex preparation refuses ${mode} caller before native effects`
        : `generated Codex startup overlaps metadata reads and preserves policy ordering (${mode})${retry ? " after a read failure" : ""}`,
      { timeout: 15_000 },
      (t) => runStartupReadCase(t, mode, retry, launchInstaller),
    );
  }
}
