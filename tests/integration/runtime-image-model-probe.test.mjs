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

// Ends the CPU hogs inside the Gateway container. The marker is split so this
// program's own command line does not match it.
function stopProbeCpuHogs(containerName) {
  const program = String.raw`
const fs = require("node:fs");
const marker = "openclaw-cpu-" + "hog-started";
for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
  try {
    if (Number(pid) !== process.pid && fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes(marker)) process.kill(Number(pid), "SIGKILL");
  } catch {}
}`;
  return execute(docker, ["exec", containerName, "node", "-e", program], { timeout: 60_000 });
}

// CPU contention may delay the probe past its cap, but faster hosts can still
// complete the real turn. Require correct settlement in either case. The
// generated-wrapper conformance tests exercise cap classification deterministically.
test(
  "runtime image embedded Gateway settles its model probe under CPU contention",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    let hogs;
    let released;
    const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
    const run = await runEmbeddedGatewayProbe(t, {
      mode: "answer",
      delayMs: 2_000,
      cpus: constrainedGatewayCpuLimit,
      limitMs: 400_000,
      stress,
      afterStop: async () => {
        await released;
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
        // A probe that answers just inside its cap leaves the Gateway to start beside the
        // eight hogs, on about a ninth of its 500m limit. On a remote test VM at 2 CPUs that
        // start outlasted the 400 s guard in 4 of 20 runs (finding 2673). This case proves
        // how the probe settles, so stop the hogs once the wrapper has logged READY.
        if (snapshot.probe?.code === "READY") {
          released ??= stopProbeCpuHogs(containerName);
        }
        return modelProbeSettled(snapshot);
      },
    });
    const { events, phases, output } = run.snapshot;
    const detail = `\n${output}\n${JSON.stringify(events)}`;
    // CI keeps only a failed assertion's location: each cause fails on its own line.
    const probe = jsonLines(output, { lenient: true }).find(
      ({ event }) => event === "openclaw.model_probe",
    );
    // The wrapper's stage log times the probe CLI from spawn to return. The cap kills the
    // CLI only after capMs; a return before that is the CLI's own result.
    const stageMs = (name) =>
      jsonLines(output, { lenient: true }).find(
        ({ event, stage }) => event === "openclaw.model_probe_stage" && stage === name,
      )?.elapsedMs;
    const cliMs = stageMs("returned") - stageMs("spawn");
    recordModelProbeMeasurement(t, "gateway-500m-contended", run);
    try {
      assert.equal(stress.started, 8, "all eight owned CPU hogs reached their loops");
      assert.ok(probe, `the wrapper logged its probe${detail}`);
      assert.equal(probe.capMs, 110_000, `cap from the 500m cgroup limit${detail}`);
      assert.notEqual(probe.cpuWaitMs, null, `the cgroup reported CPU waiting${detail}`);
      assert.ok(probe.cpuWaitMs > 0, `the hogs made the probe wait for CPU${detail}`);
      assert.ok(Number.isFinite(cliMs), `the wrapper logged spawn and return${detail}`);
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
      } else if (cliMs >= probe.capMs) {
        // A probe that reaches its cap is classified by the wrapper's own CPU-wait reading: over
        // a quarter of the time waiting is CPU_STARVED, otherwise TIMEOUT (the rule itself is in
        // runtime-probe-cpu-counter.test.mjs). The reading here is normally about twice the
        // elapsed time, but one CI VM reported 0.24 of it while the hogs kept the probe from
        // ever reaching its model turn (finding 2271, run 40270134616). Require the code the
        // rule gives for the reading, and a TIMEOUT only when the fixture saw no model turn.
        const starved = probe.cpuWaitMs > probe.elapsedMs / 4;
        const capCode = starved ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
        assert.equal(probe.code, capCode, detail);
        assert.ok(starved || !events.some(isModelTurn), `starved before its turn${detail}`);
        assert.equal(runtimeFailure(events), capCode, detail);
        assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed", detail);
        assert.equal(phaseAt(phases, "native-spawn"), undefined, detail);
      } else {
        // OpenClaw's own 15 s --probe-timeout covers the whole isolated run, local work
        // included. When the hogs hold that work back long enough, it fires before the
        // cap and the wrapper reports the CLI's timeout status as MODEL_PROBE_TIMEOUT
        // without reading CPU wait (main run 40419787603: returned at 105.4 s of a
        // 110 s cap with 66 s of CPU wait; finding 2673). The cap rule above does not
        // apply to this path, so require exactly that code. Whether a starved probe should
        // report CPU_STARVED here too is a product question (finding 2675).
        assert.equal(probe.code, "MODEL_PROBE_TIMEOUT", `turn timeout before the cap${detail}`);
        assert.ok(cliMs >= 15_000, `the CLI ran its 15 s timeout${detail}`);
        assert.equal(runtimeFailure(events), "MODEL_PROBE_TIMEOUT", detail);
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
