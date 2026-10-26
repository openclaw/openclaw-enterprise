import assert from "node:assert/strict";
import test from "node:test";
import {
  modelProbeSettled,
  modelProbeDiagnostic,
  recordModelProbeMeasurement,
  trackProbeCpuHog,
} from "../helpers/runtime-model-probe-observation.mjs";
import {
  constrainedGatewayCpuLimit,
  docker,
  execute,
  imageTestOptions,
  observed,
  phaseAt,
  productionGatewayMemoryLimit,
  runDocker,
  runEmbeddedGatewayProbe,
  runtimeFailure,
} from "../helpers/runtime-image-model-probe.mjs";
import { jsonLines } from "../helpers/json-lines.mjs";
import { isModelTurn } from "../helpers/runtime-image-startup-probe.mjs";

// The embedded Gateway's startup model probe on the real runtime image under CPU
// contention (setup: tests/helpers/runtime-image-model-probe.mjs). Its other
// outcomes run in the model probe outcomes file, in another lane, because this
// case alone takes 110-230 s.

// CPU contention may delay the probe past its cap, but faster hosts can still
// complete the real turn. Require correct settlement in either case. The
// generated-wrapper conformance tests exercise cap classification deterministically.
test(
  "runtime image embedded Gateway settles its model probe under CPU contention",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    let hogs;
    const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
    const run = await runEmbeddedGatewayProbe(t, {
      mode: "answer",
      delayMs: 2_000,
      cpus: constrainedGatewayCpuLimit,
      memory: productionGatewayMemoryLimit,
      limitMs: 400_000,
      stress,
      afterStop: async () => {
        await hogs;
      },
      until: (snapshot, containerName) => {
        hogs ??= Promise.all(
          Array.from({ length: 8 }, () =>
            trackProbeCpuHog(
              execute(
                docker,
                [
                  "exec",
                  containerName,
                  "node",
                  "-e",
                  'process.stdout.write("openclaw-cpu-hog-started\\n"); for (;;) {}',
                ],
                {
                  timeout: 600_000,
                  maxBuffer: 4_000_000,
                },
              ),
              stress,
            ),
          ),
        );
        return modelProbeSettled(snapshot);
      },
    });
    const { events, phases, output } = run.snapshot;
    const detail = `\n${output}\n${JSON.stringify(events)}`;
    // CI keeps only a failed assertion's location: each cause fails on its own line.
    const probe = jsonLines(output, { lenient: true }).find(
      ({ event }) => event === "openclaw.model_probe",
    );
    recordModelProbeMeasurement(t, "gateway-500m-contended", run);
    try {
      assert.equal(stress.started, 8, "all eight owned CPU hogs reached their loops");
      assert.ok(probe, `the wrapper logged its probe${detail}`);
      assert.equal(probe.capMs, 110_000, `cap from the 500m cgroup limit${detail}`);
      assert.notEqual(probe.cpuWaitMs, null, `the cgroup reported CPU waiting${detail}`);
      assert.ok(probe.cpuWaitMs > 0, `the hogs made the probe wait for CPU${detail}`);
      if (probe.code === "READY") {
        assert.equal(runtimeFailure(events), undefined, detail);
        assert.ok(
          events.some((event) => event.event === "turn-answered"),
          detail,
        );
        assert.equal(phaseAt(phases, "model-probe")?.outcome, "ok", detail);
        assert.equal(phaseAt(phases, "native-spawn")?.outcome, "ok", detail);
        assert.ok(events.some(observed("ready", true)), detail);
        assert.ok(events.some(observed("plugin", "ready")), detail);
      } else {
        // A probe that reaches its cap is classified by the wrapper's own CPU-wait reading: over
        // a quarter of the time waiting is CPU_STARVED, otherwise TIMEOUT (the rule itself is in
        // runtime-probe-cpu-counter.test.mjs). The reading here is normally about twice the
        // elapsed time, but one CI VM reported 0.24 of it while the hogs kept the probe from
        // ever reaching its model turn (finding 2271, run 40270134616). Require the code the
        // rule gives for the reading, and a TIMEOUT only when the fixture saw no model turn.
        const starved = probe.cpuWaitMs > probe.elapsedMs / 4;
        const capCode = starved ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
        assert.equal(probe.code, capCode, detail);
        assert.ok(probe.elapsedMs >= probe.capMs, `the probe reached its cap${detail}`);
        assert.ok(starved || !events.some(isModelTurn), `starved before its turn${detail}`);
        assert.equal(runtimeFailure(events), capCode, detail);
        assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed", detail);
        assert.equal(phaseAt(phases, "native-spawn"), undefined, detail);
      }
      t.diagnostic(
        `CPU-contended probe at --cpus ${constrainedGatewayCpuLimit}: ${JSON.stringify(probe)}`,
      );
    } catch (error) {
      error.openclawCiDiagnostic = modelProbeDiagnostic(run.snapshot, stress, "classification");
      throw error;
    }
    await runDocker(["rm", "-f", run.containerName]).catch(() => {});
    await hogs;
  },
);
