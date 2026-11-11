// Runtime wrapper SIGTERM in every startup phase, split from
// runtime-image-startup-probe.test.mjs so CI runs it beside the startup model
// probes. Both files start the wrapper through the same scenario helper. The
// Gateway restart after an unclean stop is in
// runtime-image-gateway-unclean-restart.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { imageTestOptions, runDocker, failureTail } from "../helpers/runtime-image-startup.mjs";
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

// Each case starts its own wrappers and stand-in providers through the scenario
// helper: random container names, its own certificate directory and network
// namespace, no shared volume or port, and CPU-limited wrappers. Two run at a
// time, as in the startup probe file.
describe("runtime image wrapper termination", { concurrency: 2 }, () => {
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
});
