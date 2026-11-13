import assert from "node:assert/strict";
import test from "node:test";
import {
  modelProbeSettled,
  modelProbeDiagnostic,
  recordModelProbeMeasurement,
  trackProbeCpuHog,
} from "../helpers/runtime-model-probe-observation.ts";
import {
  constrainedGatewayCpuLimit,
  docker,
  execute,
  imageTestOptions,
  observed,
  phaseAt,
  probeLogRecords,
  runDocker,
  runEmbeddedGatewayProbe,
  runtimeFailure,
} from "../helpers/runtime-image-model-probe.ts";

// The embedded Gateway's startup model probe on the real runtime image under CPU
// contention (setup: tests/helpers/runtime-image-model-probe.ts). Its other
// outcomes run in the model probe outcomes file, in another lane, because this
// case alone takes 110-230 s.

// Ends the CPU hogs inside the Gateway container. The marker is split so this
// program's own command line does not match it.
function stopProbeCpuHogs(containerName: string) {
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
    let hogs: Promise<void[]> | undefined;
    let released: ReturnType<typeof stopProbeCpuHogs> | undefined;
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
    const probe = probeLogRecords(output).find(({ event }) => event === "openclaw.model_probe");
    // The wrapper's stage log times the probe CLI from spawn to return. The cap kills the
    // CLI only after capMs; a return before that is the CLI's own result.
    const stageMs = (name: string) => {
      const elapsedMs = probeLogRecords(output).find(
        ({ event, stage }) => event === "openclaw.model_probe_stage" && stage === name,
      )?.elapsedMs;
      return typeof elapsedMs === "number" ? elapsedMs : Number.NaN;
    };
    const cliMs = stageMs("returned") - stageMs("spawn");
    recordModelProbeMeasurement(t, "gateway-500m-contended", run);
    try {
      assert.equal(stress.started, 8, "all eight owned CPU hogs reached their loops");
      assert.ok(probe, `the wrapper logged its probe${detail}`);
      assert.equal(probe.capMs, 110_000, `cap from the 500m cgroup limit${detail}`);
      assert.notEqual(probe.cpuWaitMs, null, `the cgroup reported CPU waiting${detail}`);
      assert.ok(typeof probe.cpuWaitMs === "number", detail);
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
        // runtime-probe-cpu-counter.test.ts). With pressure accounting the eight hogs keep
        // some task waiting nearly all the time, so the reading must be starvation. CI's
        // runners have none (pressureWaitMs null): the reading is then throttling alone, which
        // misses waiting while other containers hold the node's CPUs, and read 0.22-0.34 of
        // the elapsed time across 50 runs on 10-27. Either code is then the rule's answer, and
        // a starved probe can still reach its model turn just before the cap (finding 2675).
        assert.ok(typeof probe.elapsedMs === "number", detail);
        const starved = probe.cpuWaitMs > probe.elapsedMs / 4;
        const capCode = starved ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
        assert.equal(probe.code, capCode, detail);
        assert.ok(
          starved || probe.pressureWaitMs === null,
          `pressure accounting reads the hogs as starvation${detail}`,
        );
        assert.equal(runtimeFailure(events), capCode, detail);
        assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed", detail);
        assert.equal(phaseAt(phases, "native-spawn"), undefined, detail);
      } else {
        // OpenClaw's own 15 s --probe-timeout covers the whole isolated run, local work
        // included. When the hogs hold that work back long enough, it fires before the
        // cap (main run 40419787603: returned at 105.4 s of a 110 s cap with 66 s of CPU
        // wait; finding 2673). The wrapper then judges only the 15 s window the CLI
        // preload sampled, not the whole run, whose boot waits even when the provider
        // hangs (finding 2675): over a quarter waiting and no 5 s idle stretch is
        // starvation. The hogs keep the CLI runnable through its window, so pressure
        // accounting must read starvation; without it, throttling alone decides, as at
        // the cap.
        assert.ok(cliMs >= 15_000, `the CLI ran its 15 s timeout${detail}`);
        assert.ok(typeof probe.timeoutWindowMs === "number", detail);
        assert.ok(typeof probe.timeoutWindowCpuWaitMs === "number", detail);
        assert.ok(typeof probe.timeoutWindowIdleMs === "number", detail);
        assert.ok(probe.timeoutWindowMs >= 15_000, `the preload read the window${detail}`);
        const starved =
          probe.timeoutWindowCpuWaitMs > probe.timeoutWindowMs / 4 &&
          probe.timeoutWindowIdleMs < 5_000;
        const windowCode = starved ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
        assert.equal(probe.code, windowCode, `turn timeout before the cap${detail}`);
        assert.ok(
          starved || probe.pressureWaitMs === null,
          `pressure accounting reads the hogs as starvation in the window${detail}`,
        );
        assert.equal(runtimeFailure(events), windowCode, detail);
        assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed", detail);
        assert.equal(phaseAt(phases, "native-spawn"), undefined, detail);
      }
      t.diagnostic(
        `CPU-contended probe at --cpus ${constrainedGatewayCpuLimit}: ${JSON.stringify(probe)}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        Object.assign(error, {
          openclawCiDiagnostic: modelProbeDiagnostic(run.snapshot, stress, "classification"),
        });
      }
      throw error;
    }
    await runDocker(["rm", "-f", run.containerName]).catch(() => {});
    await hogs;
  },
);
