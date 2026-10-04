import { once } from "node:events";

// Sends SIGTERM and waits for the child to exit, sending SIGKILL if it is still running
// after `graceMs`. A child that has already exited returns at once.
export async function stopProcess(child, { graceMs = 2_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
  force.unref();
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}
