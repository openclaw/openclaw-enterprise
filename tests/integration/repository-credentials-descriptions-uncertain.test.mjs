import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { socketDirectory } from "../helpers/socket-directory.mjs";

test(
  "unknown metadata token ownership settles queued display and remains visible at shutdown",
  { timeout: 20000 },
  async (t) => {
    // This child owns only local fixture services. Its intentionally unknown token
    // cannot be disposed, so the parent terminates and joins the disposable process.
    // The killed child cannot remove its temporary directories, so it gets a TMPDIR
    // the parent owns. `longest` mirrors createServiceConfiguration's
    // socketDirectory(t, "rcs-") in the child, so that call keeps its directory here
    // instead of falling back to /tmp.
    // After hooks run in registration order, and on a timeout they run while the body
    // is still waiting. Register the kill first so the child has exited before
    // socketDirectory's hook removes its TMPDIR.
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    });
    const temporaryRoot = await socketDirectory(t, "rcs-uncertain-", {
      longest: "rcs-XXXXXX/control-relay.sock",
    });
    child = fork(
      new URL("../fixtures/repository-credentials/metadata-uncertain-child.mjs", import.meta.url),
      [],
      {
        execArgv: [],
        env: { ...process.env, TMPDIR: temporaryRoot },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => {
        throw new Error("metadata fixture exited before its report");
      }),
    ]);
    assert.notEqual(message.type, "error", message.message);
    assert.deepEqual(message, { type: "result", graceExpired: true, pendingCredentials: 1 });
  },
);
