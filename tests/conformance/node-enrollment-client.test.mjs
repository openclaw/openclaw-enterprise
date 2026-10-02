import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_SETUP_POLL_MS,
  observeNodeSetup,
} from "../../apps/controller/src/gateway/node-enrollment-client.ts";

const COMMANDS = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
];

// A Gateway whose setup completes on the `pairedAt`-th status read and whose
// node reports connected from the `connectedAt`-th describe.
function gateway({ pairedAt = Infinity, connectedAt = 1, completion } = {}) {
  const calls = [];
  let statusReads = 0;
  let describes = 0;
  const request = async (method, params) => {
    calls.push(method);
    if (method === "device.pair.setupStatus") {
      statusReads++;
      if (statusReads < pairedAt) {
        return { setupId: params.setupId };
      }
      return {
        completion: completion ?? { setupId: params.setupId, access: "node", deviceId: "node-1" },
      };
    }
    if (method === "node.describe") {
      describes++;
      return { nodeId: params.nodeId, connected: describes >= connectedAt, commands: COMMANDS };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

test("a setup observation without a wait reads the Gateway once", async () => {
  const { request, calls } = gateway();
  assert.equal(await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000)), undefined);
  assert.deepEqual(calls, ["device.pair.setupStatus"]);
});

test("a waiting setup observation returns as soon as the node pairs and connects", async () => {
  const { request, calls } = gateway({ pairedAt: 3, connectedAt: 2 });
  const started = Date.now();
  assert.deepEqual(await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000), {
    deviceId: "node-1",
    connected: true,
  });
  // Two unpaired reads, the pairing, one describe before the node connects, then one after.
  assert.deepEqual(calls, [
    "device.pair.setupStatus",
    "device.pair.setupStatus",
    "device.pair.setupStatus",
    "node.describe",
    "node.describe",
  ]);
  assert.ok(Date.now() - started < 5_000, "it does not wait out its budget");
});

test("a waiting setup observation returns the last reading when its time is up", async () => {
  const unpaired = gateway();
  const started = Date.now();
  assert.equal(
    await observeNodeSetup(unpaired.request, "setup-1", AbortSignal.timeout(5_000), 600),
    undefined,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 600 - NODE_SETUP_POLL_MS && elapsed < 600 + NODE_SETUP_POLL_MS * 4);
  // A node that paired but never connected is reported with its device, as before.
  const disconnected = gateway({ pairedAt: 1, connectedAt: Infinity });
  assert.deepEqual(
    await observeNodeSetup(disconnected.request, "setup-1", AbortSignal.timeout(5_000), 600),
    { deviceId: "node-1", connected: false },
  );
  // The completion is read once; only presence is re-read.
  assert.equal(
    disconnected.calls.filter((method) => method === "device.pair.setupStatus").length,
    1,
  );
});

test("waiting does not relax setup completion validation", async () => {
  const { request } = gateway({
    pairedAt: 2,
    completion: { setupId: "another-setup", access: "node", deviceId: "node-1" },
  });
  await assert.rejects(
    observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000),
    /invalid node setup completion/,
  );
});

test("a waiting setup observation stops when its owner aborts", async () => {
  const { request } = gateway();
  const owner = new AbortController();
  setTimeout(() => owner.abort(new Error("claim lost")), 50);
  await assert.rejects(observeNodeSetup(request, "setup-1", owner.signal, 5_000), /claim lost/);
});

// The worker is serial: other Work waiting for it ends the wait early (D221).
// Every wait still reads the Gateway at least once.
test("a waiting setup observation ends early once other work is waiting", async () => {
  const unpaired = gateway();
  let asked = 0;
  const started = Date.now();
  assert.equal(
    await observeNodeSetup(
      unpaired.request,
      "setup-1",
      AbortSignal.timeout(5_000),
      5_000,
      async () => {
        asked++;
        return asked >= 3;
      },
    ),
    undefined,
  );
  assert.equal(asked, 3);
  assert.equal(unpaired.calls.length, 3, "one reading before each question");
  assert.ok(Date.now() - started < 5_000 - NODE_SETUP_POLL_MS, "it does not wait out its budget");
  // Work already waiting: one reading, and a paired device is still reported.
  const disconnected = gateway({ pairedAt: 1, connectedAt: Infinity });
  assert.deepEqual(
    await observeNodeSetup(
      disconnected.request,
      "setup-1",
      AbortSignal.timeout(5_000),
      5_000,
      async () => true,
    ),
    { deviceId: "node-1", connected: false },
  );
  assert.deepEqual(disconnected.calls, ["device.pair.setupStatus", "node.describe"]);
  // A connected node returns without asking; validation is unchanged.
  const connected = gateway({ pairedAt: 1 });
  assert.deepEqual(
    await observeNodeSetup(connected.request, "setup-1", AbortSignal.timeout(5_000), 5_000, () =>
      assert.fail("not asked once the node is connected"),
    ),
    { deviceId: "node-1", connected: true },
  );
  const invalid = gateway({
    pairedAt: 1,
    completion: { setupId: "another-setup", access: "node", deviceId: "node-1" },
  });
  await assert.rejects(
    observeNodeSetup(
      invalid.request,
      "setup-1",
      AbortSignal.timeout(5_000),
      5_000,
      async () => true,
    ),
    /invalid node setup completion/,
  );
});
