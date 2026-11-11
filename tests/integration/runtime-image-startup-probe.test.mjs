// Runtime image startup smoke tests split from runtime-image-startup.test.mjs so
// CI can run the files in parallel lanes: startup model probes and ephemeral
// native worker reconnect from an expired replayed setup code. SIGTERM during
// startup is in runtime-image-startup-termination.test.mjs; workspace node
// enrollment and the inactive Slack approver startup check are in
// runtime-image-native-worker.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { recordModelProbeMeasurement } from "../helpers/runtime-model-probe-observation.ts";
import {
  imageTestOptions,
  runDocker,
  failureTail,
  runGatewaySmoke,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.mjs";
import {
  startupProbeApiKey,
  runStartupProbeScenario,
  observedValue,
  isModelTurn,
  isTurnAnswer,
  isRuntimeFailure,
  heldFailure,
  phaseAt,
  withStartupProbeEvidence,
} from "../helpers/runtime-image-startup-probe.mjs";

// The endpoint's events and the wrapper's output reach the test through
// separate log followers, so the endpoint can report a state before the wrapper
// lines written ahead of it arrive. Each wait below also waits for the last
// wrapper line its assertions read.

// The endpoint reads status and runs readiness in parallel, so readiness can
// pass before the same poll's status read shows it: wait until both have. The
// wrapper logs native-spawn before it starts the native process.
const readyOrFailed = ({ events, phases }) =>
  events.some(isRuntimeFailure) ||
  (events.some(observedValue("ready", true)) &&
    events.some(observedValue("plugin", "ready")) &&
    phaseAt(phases, "native-spawn") !== undefined);

// A held failure's last wrapper line, written in the same synchronous step that
// publishes the failure.
const heldFailureLine = /Harness model authentication probe failed\./;
const heldAuthenticationFailure = (snapshot) =>
  heldFailure("AUTHENTICATION_FAILED")(snapshot) && heldFailureLine.test(snapshot.output);

// CI keeps only a failed assertion's location, so each startup failure the
// stand-in provider should not cause fails on its own line.
function assertStartupReady(run) {
  const failure = run.snapshot.events.find(isRuntimeFailure)?.value;
  const detail = `${failureTail(run.snapshot.output)}\n${JSON.stringify(run.snapshot.events)}`;
  if (failure === "MODEL_PROBE_TIMEOUT") {
    assert.fail(`the model probe timed out\n${detail}`);
  }
  if (failure === "MODEL_PROBE_FAILED") {
    assert.fail(`the model probe failed\n${detail}`);
  }
  if (failure !== undefined) {
    assert.fail(`startup failed with ${failure}\n${detail}`);
  }
}

// Every observation of `key` made before `at` (epoch milliseconds).
function observationsBefore(events, key, at) {
  return events.filter((event) => event.event === "observe" && event.key === key && event.at < at);
}

function describeStartupProbeRun(label, run) {
  const { events, phases } = run.snapshot;
  const at = (predicate) => run.first(events, predicate)?.ms;
  return (
    `${label}: ` +
    JSON.stringify({
      modelProbeMs: phaseAt(phases, "model-probe")?.sinceStartMs,
      nativeSpawnMs: phaseAt(phases, "native-spawn")?.sinceStartMs,
      modelTurnMs: at(isModelTurn),
      turnAnsweredMs: at(isTurnAnswer),
      nativeListeningMs: at(observedValue("native", true)),
      runtimeFailureMs: at(isRuntimeFailure),
      readyMs: at(observedValue("ready", true)),
    })
  );
}

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
    // Phase times count from wrapper start, endpoint times from container
    // start; compare each only within its own clock.
    assert.equal(
      observationsBefore(events, "native", answered.at).some(({ value }) => value === true),
      false,
      "the native process listened before the probe passed",
    );
    assert.equal(
      observationsBefore(events, "ready", answered.at).some(({ value }) => value === true),
      false,
      "readiness passed before the probe passed",
    );
    assert.equal(
      observationsBefore(events, "plugin", answered.at).some(({ value }) => value === "ready"),
      false,
      "plugin status was ready before the probe passed",
    );
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
    const { events, phases, output } = run.snapshot;
    assert.equal(events.some(observedValue("ready", true)), false);
    assert.equal(events.some(observedValue("plugin", "ready")), false);
    assert.equal(events.some(observedValue("native", true)), false);
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed");
    assert.equal(phaseAt(phases, "native-spawn"), undefined, "a failed probe starts nothing");
    assert.doesNotMatch(output, new RegExp(startupProbeApiKey));
    const failure = run.first(events, observedValue("runtimeFailure", "AUTHENTICATION_FAILED"));
    // Far inside the 900-second convergence deadline #583 cuts short.
    assert.ok(failure.ms < 120_000 * imageSmokeTimeoutMultiplier, `failure after ${failure.ms} ms`);
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
        new URL("../fixtures/runtime-native-worker-restart.mjs", import.meta.url),
        "utf8",
      );
      const { stdout } = await runDocker(
        ["exec", containerName, "node", "--input-type=module", "-e", source],
        { timeout: 300_000 * imageSmokeTimeoutMultiplier },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.sameIdentityAfterExpiredReplay, true);
      assert.equal(result.singleBootstrapCompletion, true);
      assert.equal(result.unpairedExpiredRejected, true);
    },
  );
});

// This is a controlled Compute release, not Supervisor injection or grant redemption.
// Both inputs run the full provider-owned wrapper against the same credential-checking origin.
test(
  "runtime image protected Codex distinguishes an origin key from an uninjected placeholder",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    // Exercise the real assertion emission boundary with hostile diagnostic fields.
    // This is a diagnostic control, not a substitute for either runtime case below.
    const canary = "synthetic-diagnostic-canary";
    let diagnostic;
    try {
      await withStartupProbeEvidence(
        {
          protected: true,
          snapshot: {
            output: canary,
            phases: [{ phase: canary, outcome: canary }],
            events: [
              {
                event: "transport",
                status: 401,
                failure: {
                  check: "model-probe",
                  code: "AUTHENTICATION_FAILED",
                  message: canary,
                },
              },
              { event: "wire", method: canary, target: canary, credential: canary },
            ],
          },
        },
        async () => {
          throw new Error(canary);
        },
      );
    } catch (error) {
      diagnostic = error;
    }
    if (
      !diagnostic ||
      String(diagnostic.stack).includes(canary) ||
      !diagnostic.message.includes("AUTHENTICATION_FAILED") ||
      !diagnostic.message.includes('"status":401')
    ) {
      throw new Error("Protected diagnostic control failed");
    }
    t.diagnostic("Protected diagnostic canary suppressed; supported failure and status retained.");
    for (const accepted of [true, false]) {
      await t.test(accepted ? "origin key" : "uninjected placeholder", async (subtest) => {
        const run = await runStartupProbeScenario(subtest, {
          kind: "codex",
          mode: "answer",
          protectedCredential: accepted ? startupProbeApiKey : "synthetic-uninjected-placeholder",
          // Transport and wrapper phases arrive through independent log followers.
          until: ({ events, phases }) =>
            accepted
              ? phaseAt(phases, "native-spawn") !== undefined &&
                events.some(
                  (event) =>
                    event.event === "transport" &&
                    Number.isInteger(event.authenticatedUpgrade) &&
                    Number.isInteger(event.unauthenticatedUpgrade),
                )
              : phaseAt(phases, "model-probe")?.outcome === "failed" &&
                events.some(
                  (event) =>
                    event.event === "transport" &&
                    event.failure?.check === "model-probe" &&
                    event.failure?.code === "AUTHENTICATION_FAILED" &&
                    event.ms < 120_000 * imageSmokeTimeoutMultiplier,
                ),
        });
        await withStartupProbeEvidence(run, async () => {
          const { events, phases } = run.snapshot;
          assert.ok(
            events.some(
              (event) =>
                event.event === "release" &&
                event.accepted === 200 &&
                event.unauthorized === 401 &&
                event.invalidSignature === 409 &&
                event.requestsBeforeRelease === 0,
            ),
          );
          assert.equal(phaseAt(phases, "egress-enrollment")?.outcome, "ok");
          assert.equal(
            phaseAt(phases, "codex-login")?.outcome,
            "ok",
            "both synthetic values permit local login",
          );
          const origin = events.filter((event) => event.event === "origin");
          assert.equal(origin.length, 1, "exactly one native model probe reaches the origin");
          assert.equal(origin[0].status, accepted ? 200 : 401);
          assert.equal(origin[0].kind, accepted ? "unmarked" : "rejected");
          const transport = events.filter((event) => event.event === "transport").at(-1);
          const wire = events.filter((event) => event.event === "wire");
          assert.equal(wire.length, 1);
          assert.equal(wire[0].method, "POST");
          assert.equal(wire[0].target, "responses");
          assert.equal(wire[0].credential, accepted ? "origin-key" : "placeholder");
          if (accepted) {
            assert.equal(phaseAt(phases, "model-probe")?.outcome, "ok");
            assert.ok(phaseAt(phases, "native-spawn"));
            assert.equal(transport.failure, null);
            assert.equal(transport.status, 400);
            assert.equal(transport.unauthorized, 400);
            assert.equal(transport.authenticatedUpgrade, 101);
            assert.equal(transport.unauthenticatedUpgrade, 401);
          } else {
            assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed");
            assert.equal(phaseAt(phases, "native-spawn"), undefined);
            assert.equal(transport.status, 200);
            assert.equal(transport.unauthorized, 401);
            assert.equal(transport.failure.check, "model-probe");
            assert.equal(transport.failure.code, "AUTHENTICATION_FAILED");
            assert.ok(transport.ms < 120_000 * imageSmokeTimeoutMultiplier);
            assert.equal((await run.collect()).running, true, "failure remains held");
          }
          subtest.diagnostic(
            JSON.stringify({
              container: run.containerName,
              release: events.find((event) => event.event === "release"),
              origin,
              wire,
              transport,
              phases,
            }),
          );
        });
      });
    }
  },
);
