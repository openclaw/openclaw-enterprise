import type { ChildProcess } from "node:child_process";

// Attach at spawn: exitCode alone cannot tell us whether inherited pipes closed.
export function ownPortForward(child: ChildProcess, { graceMs = 2_000 } = {}) {
  let closed = false;
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure = error;
  };
  child.on("error", onError);
  const closure = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      child.off("error", onError);
      resolve();
    });
  });
  const waitForClose = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closure,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    if (!closed) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await waitForClose();
    }
    if (!closed) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await waitForClose();
    }
    if (!closed) {
      throw new Error("Port-forward did not close after bounded shutdown");
    }
  };
  // Readiness reports launch failures; cleanup fails only when closure is unconfirmed.
  return {
    close,
    get error() {
      return failure;
    },
  };
}
