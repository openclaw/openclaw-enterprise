import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_SETUP_POLL_MS,
  observeNodeSetup,
} from "../../apps/controller/src/gateway/node-enrollment-client.ts";

// Protocol responses exercise the observation adapter, not native pairing or delivery.
function gateway({ pairedAt = Infinity, completion, uncertain = false } = {}) {
  const calls = [];
  const request = async (method, params) => {
    calls.push(method);
    // A receipt must reach its owner before any fallible node lookup or probe.
    assert.equal(method, "device.pair.setupStatus");
    if (calls.length < pairedAt) {
      return {};
    }
    return {
      [uncertain ? "deliveryUncertain" : "completion"]: completion ?? {
        setupId: params.setupId,
        access: "node",
        deviceId: "node-1",
        ts: 1,
      },
    };
  };
  return { request, calls };
}

test("a setup observation without a wait reads the Gateway once", async () => {
  const { request, calls } = gateway();
  assert.equal(await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000)), undefined);
  assert.deepEqual(calls, ["device.pair.setupStatus"]);
});

test("setup observation rejects malformed receipts without treating them as absent", async (t) => {
  const receipt = { setupId: "setup-1", access: "node", deviceId: "node-1", ts: 1 };
  const malformed = [
    ["array", []],
    ["string", "broken"],
    ["null", null],
    ["number", 1],
    ["boolean", true],
  ];
  for (const { name, status, invalid, expected } of [
    { name: "absent receipts", status: {}, expected: undefined },
    ...[
      { completion: receipt },
      { deliveryUncertain: receipt },
      // The schema permits both: confirmed completion keeps precedence.
      { completion: receipt, deliveryUncertain: { ...receipt, deviceId: "node-2" } },
    ].map((status) => ({
      name: Object.keys(status).join(" and "),
      status,
      expected: {
        deviceId: "node-1",
        delivery: Object.hasOwn(status, "completion") ? "confirmed" : "uncertain",
      },
    })),
    ...["completion", "deliveryUncertain"].flatMap((field) => [
      ...malformed.map(([shape, value]) => ({
        name: `${field} is ${shape}`,
        status: { [field]: value },
        invalid: true,
      })),
      {
        name: `malformed ${field} alongside a valid receipt`,
        status: { completion: receipt, deliveryUncertain: receipt, [field]: [] },
        invalid: true,
      },
    ]),
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const request = async (method) => {
        calls.push(method);
        assert.equal(method, "device.pair.setupStatus");
        return status;
      };
      // Only a genuinely absent receipt permits the caller to replace expired
      // setup. Malformed evidence must stop before node lookup or renewal.
      if (invalid) {
        await assert.rejects(
          observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000)),
          /invalid node setup completion/,
        );
      } else {
        assert.deepEqual(
          await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000)),
          expected,
        );
      }
      assert.deepEqual(calls, ["device.pair.setupStatus"]);
    });
  }
});

test("a waiting setup observation returns either receipt before any node lookup", async () => {
  for (const uncertain of [false, true]) {
    const { request, calls } = gateway({ pairedAt: 3, uncertain });
    const started = Date.now();
    assert.deepEqual(
      await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000),
      {
        deviceId: "node-1",
        delivery: uncertain ? "uncertain" : "confirmed",
      },
    );
    assert.deepEqual(calls, Array(3).fill("device.pair.setupStatus"));
    assert.ok(Date.now() - started < 5_000, "it does not wait out its budget");
  }
});

test("a waiting setup observation returns absent when its time is up", async () => {
  const unpaired = gateway();
  const started = Date.now();
  assert.equal(
    await observeNodeSetup(unpaired.request, "setup-1", AbortSignal.timeout(5_000), 600),
    undefined,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 600 - NODE_SETUP_POLL_MS && elapsed < 600 + NODE_SETUP_POLL_MS * 4);
});

test("waiting does not relax setup completion validation", async () => {
  for (const completion of [
    { setupId: "another-setup", access: "node", deviceId: "node-1", ts: 1 },
    { setupId: "setup-1", access: "node", deviceId: "bad/id", ts: 1 },
  ]) {
    const { request, calls } = gateway({ pairedAt: 2, completion });
    await assert.rejects(
      observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000),
      /invalid node setup completion/,
    );
    assert.equal(calls.includes("node.describe"), false);
  }
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
  // Either receipt must reach the owner before another wait or fallible lookup.
  for (const uncertain of [false, true]) {
    const observed = gateway({ pairedAt: 1, uncertain });
    assert.deepEqual(
      await observeNodeSetup(observed.request, "setup-1", AbortSignal.timeout(5_000), 5_000, () =>
        assert.fail("a consumed receipt must return before yielding to other work"),
      ),
      { deviceId: "node-1", delivery: uncertain ? "uncertain" : "confirmed" },
    );
    assert.deepEqual(observed.calls, ["device.pair.setupStatus"]);
  }
  const invalid = gateway({
    pairedAt: 1,
    completion: { setupId: "another-setup", access: "node", deviceId: "node-1", ts: 1 },
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
