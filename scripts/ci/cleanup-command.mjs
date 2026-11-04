import { spawn } from "node:child_process";

// This process leads the detached POSIX group. Its private IPC channel belongs
// only to the cleanup caller, so even that caller's SIGKILL or process.exit()
// closes the channel. Descendants inherit output pipes, never this channel.
function stopGroup() {
  process.kill(-process.pid, "SIGKILL");
}

process.once("disconnect", stopGroup);
process.once("exit", stopGroup);
// The caller sends TERM to the group at the deadline. Keep its leader alive
// until output drains or the caller escalates, even if the command exits first.
process.on("SIGTERM", () => {});

process.once("message", ({ command, args }) => {
  if (!process.connected) {
    stopGroup();
    return;
  }
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let spawnError;
  child.on("error", (error) => {
    spawnError = { message: error.message, code: error.code };
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.once("close", (code, signal) => {
    // Flush both streams before reporting completion. The caller still owns the
    // deadline if descendants keep a pipe open or output cannot drain.
    process.stdout.end(() => {
      process.stderr.end(() => {
        if (!process.connected) {
          stopGroup();
          return;
        }
        process.send({ code, signal, error: spawnError }, stopGroup);
      });
    });
  });
});
