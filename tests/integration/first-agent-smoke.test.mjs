import assert from "node:assert/strict";
import test from "node:test";

import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  STOP_PHASE_TIMEOUT_MS,
  agentStopDiagnostic,
  observeAgentStop,
  waitFor,
} from "../../scripts/ci/first-agent-smoke.mjs";

const revision = "rev_00000000-0000-4000-8000-000000000001";

function virtualClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    advance: (ms) => {
      elapsed += ms;
    },
  };
}

function stoppedAt(clock, time) {
  return async () => ({
    desiredRuntimeState: "stopped",
    activeRevisionId: clock.now() < time ? revision : undefined,
    status: "active",
  });
}

test("stop observation accepts a fast shutdown and checks Pods afterward", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, 20_000),
    async () => {
      podReads += 1;
      return [];
    },
    clock,
  );
  assert.equal(clock.now(), 20_000);
  assert.equal(podReads, 1);
});

test("default stop observation covers the selected gateway grace", async () => {
  const clock = virtualClock();
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, GATEWAY_STOP_TIMEOUT_MS - 15_000),
    async () => [],
    clock,
  );
  assert.ok(clock.now() > 300_000);
  assert.ok(clock.now() < GATEWAY_STOP_TIMEOUT_MS);
});

test("the second stop can wait behind the serial worker's first gateway drain", async () => {
  const clock = virtualClock();
  const activeClears = 2 * (GATEWAY_STOP_TIMEOUT_MS - 15_000);
  let observedPods = false;
  await observeAgentStop(
    "codex",
    stoppedAt(clock, activeClears),
    async () => {
      observedPods = true;
      return clock.now() < activeClears + 8_000 ? [{}] : [];
    },
    clock,
  );
  assert.equal(clock.now(), activeClears + 8_000);
  assert.ok(observedPods);
  assert.ok(clock.now() < STOP_PHASE_TIMEOUT_MS);
});

test("an explicit shorter deadline is authoritative and does not start a later Pod read", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 1_500),
      async () => {
        podReads += 1;
        return [];
      },
      { ...clock, timeout: 1_000 },
    ),
    /Timed out waiting for embedded to stop/,
  );
  assert.equal(clock.now(), 1_000);
  assert.equal(podReads, 0);
});

test("permanent nonconvergence retains the active-pointer assertion and bounded state", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, Infinity), async () => [], clock),
    (error) => {
      assert.match(error.message, /active-revision/);
      assert.match(error.message, /elapsedMs/);
      assert.ok(error.message.includes(revision));
      return true;
    },
  );
  assert.equal(clock.now(), STOP_PHASE_TIMEOUT_MS);
});

test("a desired-state reversal fails without accepting an empty active pointer", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      async () => ({ desiredRuntimeState: "running" }),
      async () => {
        podReads += 1;
        return [];
      },
      clock,
    ),
    /desired state changed while stopping/,
  );
  assert.equal(podReads, 0);
});

test("an empty active pointer does not accept remaining Pods", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, 0), async () => [{}], {
      ...clock,
      timeout: 5_000,
    }),
    /"phase":"pods".*"remainingPods":1/,
  );
  assert.equal(clock.now(), 5_000);
});

test("both observation stages share the explicit deadline", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 8_000),
      async () => (clock.now() < 12_000 ? [{}] : []),
      { ...clock, timeout: 10_000 },
    ),
    /Pods to terminate/,
  );
  assert.equal(clock.now(), 10_000);
});

test("invalid bounds fail before any observation", async () => {
  for (const timeout of [0, -1, Infinity, NaN, 1.5, null]) {
    let reads = 0;
    await assert.rejects(
      observeAgentStop(
        "embedded",
        async () => {
          reads += 1;
        },
        async () => [],
        { timeout },
      ),
      /positive finite integer/,
    );
    await assert.rejects(
      waitFor(
        "invalid",
        async () => {
          reads += 1;
        },
        timeout,
      ),
      /positive finite integer/,
    );
    assert.equal(reads, 0);
  }
});

test("an observation that returns after its explicit deadline cannot report success", async () => {
  const clock = virtualClock();
  await assert.rejects(
    waitFor(
      "late",
      async () => {
        clock.advance(1_001);
        return { done: true };
      },
      1_000,
      clock,
    ),
    /Timed out waiting for late/,
  );
});

test("failed diagnostic reads return a fixed marker without exposing or throwing the error", async () => {
  const state = await agentStopDiagnostic(async () => {
    throw new Error("synthetic-private-value");
  });
  assert.deepEqual(state, { phase: "agent-state", unavailable: true });
  assert.ok(!JSON.stringify(state).includes("synthetic-private-value"));
});

test("diagnostics project only fixed lifecycle fields", async () => {
  assert.deepEqual(
    await agentStopDiagnostic(async () => ({
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
      unrelated: "synthetic-private-value",
    })),
    {
      phase: "agent-state",
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
    },
  );
  const invalid = await agentStopDiagnostic(async () => ({
    desiredRuntimeState: "synthetic-private-value",
    activeRevisionId: "synthetic-private-value",
    status: "synthetic-private-value",
  }));
  assert.deepEqual(invalid, {
    phase: "agent-state",
    desiredRuntimeState: "unknown",
    activeRevisionId: "invalid",
    status: "unknown",
  });
});
