import test from "node:test";
import { runStartupReadCase } from "./codex-plugin-startup-read-cases.ts";
import { captureChild } from "../helpers/child-processes.mjs";

for (const mode of [
  "ordinary",
  "scoped-no-ambient",
  "scoped-hostile-ambient",
  "missing",
  "invalid",
  "wrong-credential",
]) {
  for (const retry of ["ordinary", "scoped-no-ambient", "scoped-hostile-ambient"].includes(mode)
    ? [false, true]
    : [false]) {
    test(
      ["missing", "invalid", "wrong-credential"].includes(mode)
        ? `generated Codex preparation refuses ${mode} caller before native effects`
        : `generated Codex startup overlaps metadata reads and preserves policy ordering (${mode})${retry ? " after a read failure" : ""}`,
      { timeout: 15_000 },
      (t) =>
        runStartupReadCase(t, mode, retry, (script, env, signal) =>
          captureChild(process.execPath, ["-e", script], {
            env,
            signal,
            killSignal: "SIGKILL",
          }),
        ),
    );
  }
}
