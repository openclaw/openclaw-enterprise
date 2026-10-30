import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { socketDirectory } from "../helpers/socket-directory.mjs";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { closeWorkerComposition } from "../../apps/controller/src/worker/shutdown.ts";

// Resolves "connected" or the connect error code of a Unix socket path.
function reach(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
}

// Finding 2989: when the repository Git transport or the prepared Git owner failed to close,
// worker shutdown skipped the receipt server. Its listener kept the worker process alive after
// SIGTERM until the kubelet's SIGKILL. Every later step must still close, and the first failure
// is the one worker.mjs reports as SHUTDOWN_FAILED.
for (const failing of [
  { first: "transport", also: ["prepared"] },
  { first: "prepared", also: [] },
]) {
  test(`worker shutdown closes the receipt server after a ${failing.first} close failure`, async (t) => {
    const directory = await socketDirectory(t, "occ-worker-shutdown-", {
      longest: "receipt.sock",
    });
    const receiptPath = join(directory, "receipt.sock");
    // The real receipt listener on its private socket, as worker.mjs starts it.
    const receipt = await startRepositoryReceiptServer({
      controlSocket: join(directory, "control.sock"),
      state: new InMemoryPlatformState(),
      driverId: "repository-credentials",
      implementation: "github",
      backendId: "github",
    });
    // A listener this test leaves open would keep the test process alive, as it kept the worker.
    t.after(() => receipt.close().catch(() => {}));
    assert.equal(await reach(receiptPath), "connected");

    const events: string[] = [];
    const failures = new Map(
      [failing.first, ...failing.also].map((name) => [name, new Error(`${name} close failed`)]),
    );
    const step = (name: string) => async () => {
      events.push(name);
      const failure = failures.get(name);
      if (failure !== undefined) {
        throw failure;
      }
    };
    await assert.rejects(
      closeWorkerComposition({
        repositoryGitTransport: { close: step("transport") },
        preparedRepositoryGit: { close: step("prepared") },
        receiptServer: {
          async close() {
            events.push("receipt");
            await receipt.close();
          },
        },
        closeMetrics: step("metrics"),
        preparedGitHub: { close: step("github") },
        worker: { stop: step("worker") },
      }),
      (error) => error === failures.get(failing.first),
    );

    // Same order as before the fix, with no step skipped.
    assert.deepEqual(events, ["transport", "prepared", "receipt", "metrics", "github", "worker"]);
    // The listener is gone and its socket removed: nothing keeps the process alive.
    assert.equal(await reach(receiptPath), "ENOENT");
    await assert.rejects(lstat(receiptPath), { code: "ENOENT" });
  });
}
