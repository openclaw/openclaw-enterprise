import { connect } from "node:net";
import { lstat, unlink } from "node:fs/promises";

export async function prepareControlSocket(socketPath: string, timeoutMs: number): Promise<void> {
  let previous;
  try {
    previous = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !previous.isSocket() ||
    (previous.mode & 0o7777) !== 0o600 ||
    previous.uid !== process.getuid?.()
  ) {
    throw new Error("control-socket-exists");
  }
  // A crash can leave this owner's socket behind. Only an explicit refusal
  // proves it is eligible for recovery; timeout or other errors fail closed.
  await new Promise<void>((done, reject) => {
    const probe = connect(socketPath);
    const timer = setTimeout(() => probe.destroy(new Error("control-socket-exists")), timeoutMs);
    probe.once("close", () => clearTimeout(timer));
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("control-socket-exists"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        done();
      } else {
        reject(new Error("control-socket-exists"));
      }
    });
  });
  const current = await lstat(socketPath);
  if (
    !current.isSocket() ||
    current.dev !== previous.dev ||
    current.ino !== previous.ino ||
    current.mode !== previous.mode ||
    current.uid !== previous.uid ||
    current.gid !== previous.gid
  ) {
    throw new Error("control-socket-exists");
  }
  await unlink(socketPath);
}
