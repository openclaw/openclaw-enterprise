import assert from "node:assert/strict";
import test from "node:test";
import {
  constrainedGatewayCpuLimit,
  imageTestOptions,
  jsonLines,
  observed,
  phaseAt,
  probeApiKey,
  productionGatewayMemoryLimit,
  runEmbeddedGatewayProbe,
  runtimeFailure,
} from "../helpers/runtime-image-model-probe.mjs";
import { recordModelProbeMeasurement } from "../helpers/runtime-model-probe-observation.mjs";

// The embedded Gateway's startup model probe on the real runtime image at a 500m
// CPU limit (setup: tests/helpers/runtime-image-model-probe.mjs). The CPU
// contention case runs in the runtime image model probe file, in its own lane.

// The Gateway at a 500m CPU limit, with a model turn a real provider can take,
// passes its probe and becomes ready.
test(
  "runtime image embedded Gateway passes its model probe at a 500m CPU limit",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    const delayMs = 5_000;
    const run = await runEmbeddedGatewayProbe(t, {
      mode: "answer",
      delayMs,
      cpus: constrainedGatewayCpuLimit,
      memory: productionGatewayMemoryLimit,
      limitMs: 300_000,
      until: ({ events }) =>
        runtimeFailure(events) !== undefined ||
        (events.some(observed("ready", true)) && events.some(observed("plugin", "ready"))),
    });
    const { events, phases, output } = run.snapshot;
    const detail = `\n${output}\n${JSON.stringify(events)}`;
    recordModelProbeMeasurement(t, "gateway-500m-answer", run);
    assert.equal(runtimeFailure(events), undefined, `startup failed${detail}`);
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "ok", detail);
    assert.ok(
      events.some((event) => event.event === "turn-answered"),
      detail,
    );
    const probe = jsonLines(output).find(({ event }) => event === "openclaw.model_probe");
    t.diagnostic(
      `embedded Gateway at --cpus ${constrainedGatewayCpuLimit}, ${delayMs} ms model turn: ` +
        JSON.stringify({
          probeMs: phaseAt(phases, "model-probe")?.ms,
          probeCapMs: probe?.capMs,
          probeCpuWaitMs: probe?.cpuWaitMs,
          modelTurnMs: events.find((event) => event.event === "request" && event.turn)?.ms,
          nativeSpawnMs: phaseAt(phases, "native-spawn")?.sinceStartMs,
          readyMs: events.find(observed("ready", true))?.ms,
        }),
    );
  },
);

const failed = ({ events }) => runtimeFailure(events) !== undefined;

// A provider that never answers the turn: OpenClaw's own turn timeout ends the
// probe well inside the wrapper's cap, and the Gateway holds MODEL_PROBE_TIMEOUT,
// not CPU starvation, without starting OpenClaw.
test(
  "runtime image embedded Gateway reports a hung provider as a model probe timeout",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    const run = await runEmbeddedGatewayProbe(t, {
      mode: "hang",
      cpus: constrainedGatewayCpuLimit,
      memory: productionGatewayMemoryLimit,
      limitMs: 300_000,
      until: failed,
    });
    const { events, phases, output } = run.snapshot;
    const detail = `\n${output}\n${JSON.stringify(events)}`;
    recordModelProbeMeasurement(t, "gateway-500m-hang", run);
    assert.equal(runtimeFailure(events), "MODEL_PROBE_TIMEOUT", detail);
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed", detail);
    assert.equal(phaseAt(phases, "native-spawn"), undefined, detail);
    const probe = jsonLines(output).find(({ event }) => event === "openclaw.model_probe");
    assert.equal(probe?.code, "MODEL_PROBE_TIMEOUT", detail);
    assert.ok(probe.elapsedMs < probe.capMs, detail);
    assert.doesNotMatch(output, new RegExp(probeApiKey));
    t.diagnostic(`hung provider at --cpus ${constrainedGatewayCpuLimit}: ${JSON.stringify(probe)}`);
  },
);
