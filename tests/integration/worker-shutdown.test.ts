import assert from "node:assert/strict";
import { lstat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { socketDirectory } from "../helpers/socket-directory.mjs";
import { deferred } from "../helpers/deferred.ts";
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

for (const rejectRead of [false, true]) {
  test(`worker shutdown drains a receipt read that ${rejectRead ? "rejects" : "succeeds"}`, async (t) => {
    const directory = await socketDirectory(t, "occ-worker-drain-", {
      longest: "receipt.sock",
    });
    const receiptPath = join(directory, "receipt.sock");
    const state = new InMemoryPlatformState();
    const entered = deferred();
    const release = deferred();
    const stopped = deferred();
    const events: string[] = [];
    const read = state.read.bind(state);
    let readSettled: Promise<void> | undefined;
    // Hold the actual receipt State operation, without replacing its lookup behavior.
    state.read = (work) => {
      const operation = (async () => {
        entered.resolve();
        await release.promise;
        try {
          const result = await read(work);
          if (rejectRead) {
            throw new Error("State read failed");
          }
          return result;
        } finally {
          events.push("read settled");
        }
      })();
      readSettled = operation.then(
        () => {},
        () => {},
      );
      return operation;
    };
    const receipt = await startRepositoryReceiptServer({
      controlSocket: join(directory, "control.sock"),
      state,
      driverId: "repository-credentials",
      implementation: "github",
      backendId: "github",
    });
    const client = connect(receiptPath);
    const disconnected = new Promise<void>((resolve) => client.once("close", resolve));
    client.on("error", () => {});
    let shutdown: Promise<void> | undefined;
    try {
      const body = JSON.stringify({ kind: "status", sessionId: "pending-session" });
      client.write(
        `POST /v1/receipt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      await Promise.race([
        entered.promise,
        delay(2000).then(() => assert.fail("receipt read did not start")),
      ]);
      shutdown = closeWorkerComposition({
        receiptServer: receipt,
        closeMetrics: async () => {
          events.push("metrics");
        },
        worker: {
          stopLoop: async () => {},
          stop: async () => {
            events.push("worker");
            stopped.resolve();
          },
        },
      });
      // Observe shutdown immediately so failure cleanup cannot leave a rejection unhandled.
      void shutdown.catch(() => {});
      await Promise.race([
        disconnected,
        delay(1000).then(() => assert.fail("shutdown did not disconnect the client")),
      ]);
      assert.equal(
        await Promise.race([stopped.promise.then(() => "stopped"), delay(100).then(() => "held")]),
        "held",
        "worker dependencies closed while the receipt read was held",
      );
      assert.deepEqual(events, []);
      release.resolve();
      await shutdown;
      // Ordering remains the discriminator even if the bounded observation is delayed.
      assert.deepEqual(events, ["read settled", "metrics", "worker"]);
      await assert.rejects(lstat(receiptPath), { code: "ENOENT" });
    } finally {
      release.resolve();
      client.destroy();
      await shutdown?.catch(() => {});
      await receipt.close().catch(() => {});
      // If setup reached State, join that operation even on the unfixed listener.
      await readSettled;
    }
  });
}

// Finding 2989: when the repository Git transport or the prepared Git owner failed to close,
// worker shutdown skipped the receipt server. Its listener kept the worker process alive after
// SIGTERM until the kubelet's SIGKILL. Every later step must still close, and the first failure
// is the one worker.mjs reports as SHUTDOWN_FAILED. A failed worker loop stop (finding 2997)
// still removes readiness and closes every part.
for (const failing of [
  { first: "loop", also: ["transport"] },
  { first: "transport", also: ["prepared"] },
  { first: "prepared", also: [] },
]) {
  test(`worker shutdown closes the receipt server after a ${failing.first} close failure`, async (t) => {
    const directory = await socketDirectory(t, "occ-worker-shutdown-", {
      longest: "receipt.sock",
    });
    const receiptPath = join(directory, "receipt.sock");
    const readinessPath = join(directory, "ready");
    await writeFile(readinessPath, "");
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
        readinessPath,
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
        worker: { stopLoop: step("loop"), stop: step("worker") },
      }),
      (error) => error === failures.get(failing.first),
    );

    // The loop stops first and the worker's database pool closes last, with no step skipped.
    assert.deepEqual(events, [
      "loop",
      "transport",
      "prepared",
      "receipt",
      "metrics",
      "github",
      "worker",
    ]);
    await assert.rejects(lstat(readinessPath), { code: "ENOENT" });
    // The listener is gone and its socket removed: nothing keeps the process alive.
    assert.equal(await reach(receiptPath), "ENOENT");
    await assert.rejects(lstat(receiptPath), { code: "ENOENT" });
  });
}
