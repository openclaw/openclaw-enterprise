// Runtime image startup smoke tests split from runtime-image-startup.test.ts so
// CI can run the files in parallel lanes: startup model probes and ephemeral
// native worker reconnect from an expired replayed setup code. SIGTERM during
// startup is in runtime-image-startup-termination.test.ts; workspace node
// enrollment and the inactive Slack approver startup check are in
// runtime-image-native-worker.test.ts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { describe, test } from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { recordModelProbeMeasurement } from "../helpers/runtime-model-probe-observation.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import {
  assertHeldAuthenticationResult,
  assertHeldFailureDeadline,
  assertNoEarlyStartupObservations,
  assertStartupReady,
  describeStartupProbeRun,
  heldAuthenticationFailure,
  readyOrFailed,
} from "../helpers/runtime-image-startup-probe-observation.ts";
import {
  imageTestOptions,
  runGatewaySmoke,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.ts";
import {
  startupProbeApiKey,
  runStartupProbeScenario,
  observedValue,
  isTurnAnswer,
  isRuntimeFailure,
  phaseAt,
  withStartupProbeEvidence,
} from "../helpers/runtime-image-startup-probe.mjs";

// The endpoint's events and the wrapper's output reach the test through
// separate log followers, so the endpoint can report a state before the wrapper
// lines written ahead of it arrive. Each wait below also waits for the last
// wrapper line its assertions read.

// The probe gates native startup: the provider answered the model turn before
// the native process listened or the HTTP readiness endpoint passed.
async function assertProbeGatesStartup(t, kind, delayMs) {
  const run = await runStartupProbeScenario(t, {
    kind,
    mode: "answer",
    delayMs,
    until: readyOrFailed,
  });
  if (kind === "gateway") {
    // The case name assumes gatewayStartupProbeCpuLimit stays at one core.
    recordModelProbeMeasurement(t, "gateway-1cpu-answer", run);
  }
  assertStartupReady(run);
  await withStartupProbeEvidence(run, async () => {
    const { events, phases } = run.snapshot;
    const answered = run.first(events, isTurnAnswer);
    assert.ok(answered, "the stand-in provider answered the probe");
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "ok");
    assert.ok(
      phaseAt(phases, "model-probe").sinceStartMs <= phaseAt(phases, "native-spawn").sinceStartMs,
    );
    assertNoEarlyStartupObservations(events, answered.at);
    assert.ok(run.first(events, observedValue("ready", true)).at >= answered.at);
    assert.equal(events.some(isRuntimeFailure), false);
    if (kind === "codex") {
      // Exercise resident HTTP readiness after the full wrapper's real Codex
      // startup. Only the upstream model provider is substituted by this fixture.
      const observed = await runDocker([
        "exec",
        run.containerName,
        "node",
        "-e",
        "(async () => { const statuses = []; for (let index = 0; index < 3; index++) { " +
          "const response = await fetch('http://127.0.0.1:18791/readyz', { signal: AbortSignal.timeout(5000) }); " +
          "await response.text(); statuses.push(response.status); " +
          "} console.log(JSON.stringify(statuses)); })()" +
          ".catch(() => process.exit(1));",
      ]);
      assert.deepEqual(JSON.parse(observed.stdout), [200, 200, 200]);
    }
    t.diagnostic(
      describeStartupProbeRun(`${kind}, ${delayMs} ms model turn, --cpus ${run.wrapper.cpus}`, run),
    );
  });
}

// A rejected credential reports AUTHENTICATION_FAILED for #583's prompt
// deployment failure, starts no native process, the wrapper holds that
// evidence until it is terminated, and HTTP readiness stays unavailable.
async function assertRejectedCredentialFailsFast(t, kind) {
  const run = await runStartupProbeScenario(t, {
    kind,
    mode: "reject",
    until: heldAuthenticationFailure,
  });
  await withStartupProbeEvidence(run, async () => {
    const { events } = run.snapshot;
    assertHeldAuthenticationResult(run.snapshot, new RegExp(startupProbeApiKey));
    const failure = run.first(events, observedValue("runtimeFailure", "AUTHENTICATION_FAILED"));
    assertHeldFailureDeadline(failure.ms);
    assert.equal((await run.collect()).running, true, "the wrapper holds the failure evidence");
    t.diagnostic(describeStartupProbeRun(`${kind} rejected credential`, run));
  });
}

// Each case starts its own wrapper and stand-in provider: random container
// names, its own certificate directory and network namespace, no shared volume
// or port. Two run at a time, so the CPU-limited probes keep most of the
// headroom their recorded measurements report.
describe("runtime image startup model probes", { concurrency: 2 }, () => {
  test(
    "runtime image Codex Harness stays unready until its model probe passes",
    { ...imageTestOptions, timeout: 600_000 },
    async (t) => {
      // A model turn slower than app-server startup, but far inside the probe's
      // 30-second attempt cap, so it does not retry.
      await assertProbeGatesStartup(t, "codex", 8_000);
    },
  );

  test(
    "runtime image Codex Harness fails fast when the provider rejects its credential",
    { ...imageTestOptions, timeout: 600_000 },
    async (t) => {
      await assertRejectedCredentialFailsFast(t, "codex");
    },
  );

  test(
    "runtime image embedded Gateway probes its model before it starts OpenClaw",
    { ...imageTestOptions, timeout: 600_000 },
    async (t) => {
      // A short turn keeps the probe well inside its attempt cap.
      await assertProbeGatesStartup(t, "gateway", 2_000);
    },
  );

  test(
    "runtime image embedded Gateway fails fast when the provider rejects its credential",
    { ...imageTestOptions, timeout: 600_000 },
    async (t) => {
      await assertRejectedCredentialFailsFast(t, "gateway");
    },
  );

  test(
    "runtime image reconnects an ephemeral native worker from an expired replayed setup code",
    imageTestOptions,
    async (t) => {
      // Pod restarts replay the enrollment Secret's setup code after its expiry.
      const configurationPath = await temporaryGatewayConfiguration(t, "codex");
      const { containerName } = await runGatewaySmoke(t, "codex", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
        volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
      });
      const source = await readFile(
        new URL("../fixtures/runtime-native-worker-restart.ts", import.meta.url),
        "utf8",
      );
      const { stdout } = await runDocker(
        ["exec", containerName, "node", "--input-type=module", "-e", stripTypeScriptTypes(source)],
        { timeout: 300_000 * imageSmokeTimeoutMultiplier },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.sameIdentityAfterExpiredReplay, true);
      assert.equal(result.singleBootstrapCompletion, true);
      assert.equal(result.unpairedExpiredRejected, true);
    },
  );
});
