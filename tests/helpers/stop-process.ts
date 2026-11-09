import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

// Sends `signal` (SIGTERM unless given) and waits for the child to exit, sending SIGKILL if
// it is still running after `graceMs`. A child that has already exited returns at once.
// Teardown uses it so no child outlives its test.
export async function stopProcess(
  child: ChildProcess,
  {
    signal = "SIGTERM",
    graceMs = 2_000,
  }: { signal?: NodeJS.Signals | undefined; graceMs?: number | undefined } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
  force.unref();
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}
