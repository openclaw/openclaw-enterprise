// Runtime wrapper SIGTERM in every startup phase, and a Gateway restart after
// an unclean stop, split from runtime-image-startup-probe.test.mjs so CI runs
// them beside the startup model probes. Both files start the wrapper through
// the same scenario helper.
import assert from "node:assert/strict";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  imageTestOptions,
  runDocker,
  failureTail,
  gatewayStateVolume,
} from "../helpers/runtime-image-startup.mjs";
import {
  runStartupProbeScenario,
  observedValue,
  isModelTurn,
  heldFailure,
  phaseAt,
  withStartupProbeEvidence,
} from "../helpers/runtime-image-startup-probe.mjs";

// Runtime wrapper termination. A Pod stop sends SIGTERM to the container's
// PID 1, waits terminationGracePeriodSeconds (the Gateway's is 330 seconds),
// then sends SIGKILL; an embedded Gateway redeploy uses Recreate, so the new
// Pod waits for the old one. These tests send SIGTERM to the real wrappers,
// started with the container command the Compute driver renders, in each
// startup phase.
// Well below the 30-second default grace a Harness Pod gets, and far below the
// Gateway's 330 seconds: a wrapper that ignores SIGTERM never meets it.
const promptTerminationMs = 15_000;

// Sends SIGTERM as the kubelet does and measures how long the container takes
// to stop (the scenario follows its exit with `docker wait`). Container exit
// ends its PID namespace, so no child outlives it.
async function assertPromptTermination(t, { containerName, collect, exited }, description, phase) {
  const budgetMs = promptTerminationMs * imageSmokeTimeoutMultiplier;
  const signalledAt = Date.now();
  await runDocker(["kill", "--signal", "TERM", containerName]);
  const exitedAt = await exited(signalledAt + budgetMs);
  // An exit not seen by the deadline counts as the budget, not the inspect after it.
  const elapsedMs = exitedAt === undefined ? budgetMs : exitedAt - signalledAt;
  const state = await collect();
  // An exit found later than the budget, or not at all by the deadline, is not prompt.
  const stopped = exitedAt !== undefined && !state.running && elapsedMs <= budgetMs;
  t.diagnostic(
    `${description}: ${state.running ? "still running" : `exit ${state.exitCode}`} ` +
      `${elapsedMs} ms after SIGTERM`,
  );
  // Kept in the lane result (files[].measurements) on passing runs too, so flake sweeps can
  // read each phase's headroom against its budget.
  t.diagnostic(
    `openclaw-ci-measurement ${JSON.stringify({
      kind: "runtime-sigterm",
      case: phase,
      stopped,
      elapsedMs,
      budgetMs,
    })}`,
  );
  if (!stopped) {
    assert.fail(
      `${description}: SIGTERM did not stop the wrapper in ${budgetMs} ms` +
        `${elapsedMs > budgetMs ? ` (it exited after ${elapsedMs} ms)` : ""}.\n${failureTail(state.output)}`,
    );
  }
  // A terminated wrapper exits cleanly in every phase, as it does once running.
  assert.equal(state.exitCode, 0, `${description}: exit code`);
}

// Starts one wrapper, waits for `until`, then sends SIGTERM. `phase` names the
// measurement: the wrapper kind and the startup phase it was stopped in.
async function runTerminationScenario(t, { kind, mode, until, description, phase }) {
  return runStartupProbeScenario(t, {
    kind,
    mode,
    until,
    act: (scenario) => assertPromptTermination(t, scenario, description, `${kind}-${phase}`),
  });
}

async function assertWrapperTermination(t, kind) {
  const label = kind === "codex" ? "Codex Harness" : "embedded Gateway";

  // SIGTERM while the provider holds the probe's model turn: the wrapper is
  // blocked in its synchronous probe child.
  const probing = await runTerminationScenario(t, {
    kind,
    mode: "hang",
    until: ({ events }) => events.some(isModelTurn),
    description: `${label} during its model probe`,
    phase: "model-probe",
  });
  await withStartupProbeEvidence(probing, async () => {
    const { events, phases } = probing.snapshot;
    assert.equal(phaseAt(phases, "model-probe"), undefined, "a terminated probe has no outcome");
    assert.equal(events.filter(isModelTurn).length, 1, "termination starts no further attempt");
    assert.equal(events.some(observedValue("ready", true)), false);
  });

  // SIGTERM while the wrapper holds a rejected credential for the controller.
  const holding = await runTerminationScenario(t, {
    kind,
    mode: "reject",
    until: heldFailure("AUTHENTICATION_FAILED"),
    description: `${label} holding AUTHENTICATION_FAILED`,
    phase: "held-failure",
  });
  await withStartupProbeEvidence(holding, async () => {
    assert.equal(holding.snapshot.events.some(observedValue("ready", true)), false);
  });

  // SIGTERM once the native process serves: the wrapper forwards it and exits
  // with the native process.
  await runTerminationScenario(t, {
    kind,
    mode: "answer",
    until: ({ events }) => events.some(observedValue("ready", true)),
    description: `${label} while ready`,
    phase: "ready",
  });
}

test(
  "runtime image Codex Harness exits promptly on SIGTERM in every startup phase",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    await assertWrapperTermination(t, "codex");
  },
);

test(
  "runtime image embedded Gateway exits promptly on SIGTERM in every startup phase",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    await assertWrapperTermination(t, "gateway");
  },
);

test(
  "runtime image dedicated Gateway exits promptly on SIGTERM while it waits for its Harness",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    const waiting = await runTerminationScenario(t, {
      kind: "dedicated-gateway",
      mode: "answer",
      until: ({ output }) => /Waiting for Harness plugin runtime status/.test(output),
      description: "dedicated Gateway waiting for its Harness",
      phase: "harness-wait",
    });
    await withStartupProbeEvidence(waiting, async () => {
      assert.equal(waiting.snapshot.events.some(observedValue("native", true)), false);
    });
  },
);

// Runs in the Gateway container: waits for the runtime readiness endpoint the
// kubelet probes, then sends one chat turn at once, as a client does on the
// first message after Start. Prints the turn's outcome as JSON.
async function firstTurnAfterReadiness({ budgetMs }) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const readiness = await fetch("http://127.0.0.1:18791/readyz", {
        signal: AbortSignal.timeout(2_000),
      });
      if (readiness.status === 200) {
        break;
      }
    } catch {
      // The status server is not listening yet.
    }
    if (Date.now() > deadline) {
      process.stdout.write(JSON.stringify({ error: "the Gateway did not become ready" }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_PASSWORD}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [{ role: "user", content: "Reply with READY." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let content;
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content;
  } catch {
    // A refused turn's body need not be JSON; the status and body are reported.
  }
  process.stdout.write(
    JSON.stringify({ status: response.status, content, body: text.slice(0, 1_000) }),
  );
}

async function sendFirstTurn(containerName) {
  const budgetMs = 240_000 * imageSmokeTimeoutMultiplier;
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `await (${firstTurnAfterReadiness.toString()})(${JSON.stringify({ budgetMs })});`,
    ],
    { timeout: budgetMs + 150_000 },
  );
  return JSON.parse(stdout);
}

// Finding 2185: a Gateway Pod went Ready while OpenClaw was still inspecting
// the agent database its previous process left without a release, and the
// first chat turn after Start got HTTP 500. A Gateway killed without its
// SIGTERM drain (OOM kill, node loss) leaves the same lease. Its restart on the
// same state must stay unready until the agent takes turns.
test(
  "runtime image embedded Gateway restarted after an unclean stop is ready only when its agent takes turns",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    const homeVolume = await gatewayStateVolume(t, "/home/node");
    // The first Gateway answers a turn, so its agent database holds a lease,
    // and is then killed with no chance to release it.
    let firstTurn;
    let killedAt;
    const first = await runStartupProbeScenario(t, {
      kind: "gateway",
      mode: "answer",
      homeVolume,
      until: ({ events }) => events.some(observedValue("ready", true)),
      act: async ({ containerName }) => {
        firstTurn = await sendFirstTurn(containerName);
        await runDocker(["kill", "--signal", "KILL", containerName]);
        killedAt = Date.now();
      },
    });
    await withStartupProbeEvidence(first, async () => {
      assert.equal(firstTurn.status, 200, `first Gateway turn: ${JSON.stringify(firstTurn)}`);
    });
    // A Gateway in another PID namespace cannot verify that the killed owner
    // is gone until its heartbeat is 90 s old (OpenClaw's
    // GATEWAY_OWNER_HEARTBEAT_STALE_MS): an earlier start refuses the shared
    // state and exits. Start once the restart can take over.
    await new Promise((resolve) => setTimeout(resolve, killedAt + 92_000 - Date.now()));
    // The restart's first turn goes out as soon as the runtime reports ready.
    let turn;
    const restarted = await runStartupProbeScenario(t, {
      kind: "gateway",
      mode: "answer",
      homeVolume,
      until: ({ phases }) => phaseAt(phases, "native-spawn") !== undefined,
      act: async ({ containerName }) => {
        // A failed exec is reported with the wrapper output below.
        turn = await sendFirstTurn(containerName).catch((error) => ({ error: error.message }));
      },
    });
    await withStartupProbeEvidence(restarted, async () => {
      // Before the fix: HTTP 500 {"error":{"message":"internal error"}}.
      assert.equal(turn.status, 200, `first turn after restart: ${JSON.stringify(turn)}`);
      assert.equal(turn.content, "READY");
      // The restart did inspect the unreleased database in the background
      // after its listener bound: the window this readiness must cover.
      assert.match(restarted.snapshot.output, /previous release not observed/);
      assert.match(restarted.snapshot.output, /recovered after background inspection/);
    });
  },
);
