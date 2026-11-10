import { spawn } from "node:child_process";

// This process leads the detached POSIX group. Its private IPC channel belongs
// only to its preparation or cleanup caller, so even that caller's SIGKILL or process.exit()
// closes the channel. Descendants inherit output pipes, never this channel.
function stopGroup() {
  process.kill(-process.pid, "SIGKILL");
}

process.once("disconnect", stopGroup);
process.once("exit", stopGroup);
// The caller sends TERM at the deadline and forwards INT on cancellation.
// Keep the leader alive until output drains, escalation, or IPC disconnection.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

type CommandMessage = { command: string; args: string[] };

function isCommandMessage(message: unknown): message is CommandMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "command" in message &&
    typeof message.command === "string" &&
    "args" in message &&
    Array.isArray(message.args) &&
    message.args.every((arg: unknown) => typeof arg === "string")
  );
}

process.once("message", (message: unknown) => {
  if (!isCommandMessage(message)) {
    stopGroup();
    return;
  }
  const { command, args } = message;
  if (!process.connected) {
    stopGroup();
    return;
  }
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: { message: string; code: string | undefined } | undefined;
  child.on("error", (error) => {
    spawnError = {
      message: error.message,
      code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    };
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.once("close", (code, signal) => {
    // Flush both streams before reporting completion. The caller still owns the
    // deadline if descendants keep a pipe open or output cannot drain.
    process.stdout.end(() => {
      process.stderr.end(() => {
        if (!process.connected || !process.send) {
          stopGroup();
          return;
        }
        process.send({ code, signal, error: spawnError }, stopGroup);
      });
    });
  });
});
