import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";

const fixtureEnvironment = {
  OPENCLAW_HARNESS_MODEL: "fixture/model",
  OPENCLAW_HARNESS_PROVIDER: "fixture",
  OPENCLAW_HARNESS_CREDENTIAL_ENV: "FIXTURE_VALUE",
  FIXTURE_VALUE: "synthetic",
  OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
    agents: { defaults: { model: "fixture/model" } },
  }),
};

function wrapperSourceFrom(anchor: string) {
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(anchor);
  const wrapper = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\nfunction runOpenClawAuthenticationProbe(");
  const end = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\n}\n", wrapper);
  assert.ok(begin >= 0 && wrapper > begin && end > wrapper, "expected the generated probe wrapper");
  return GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end + 2);
}

function readProbeLog(line: unknown) {
  assert.ok(typeof line === "string");
  const event: unknown = JSON.parse(line);
  assert.ok(isRecord(event) && typeof event.event === "string");
  return event;
}

type ProbeSpawnResult = { status: number; stdout: string } | { error: { code: string } };
type CpuSample = [
  ms: number,
  pressureMs: number,
  throttledMs: number | null,
  periodsMs: number | null,
];

interface PreloadRun {
  now: number;
  pressureUs: number;
  tick?: () => void;
  exit?: () => void;
  writes: Map<string, string>;
}

export function registerModelProbeWrapperCases() {
  test("real generated probe marks spawn return and cleanup without changing CAP", () => {
    // From the upfront credential check, which a fixture provider skips.
    const helper = wrapperSourceFrom("const UPFRONT_ENDPOINTS = {");
    const events: Record<string, unknown>[] = [];
    const cleanup = {};
    let removed = false;
    const fs = {
      mkdtempSync: () => "/owned",
      mkdirSync() {},
      writeFileSync() {},
      rmSync() {
        removed = true;
      },
    };
    const code: unknown = vm.runInNewContext(
      helper + "\nrunOpenClawAuthenticationProbe(fs,110000,cleanup)",
      {
        fs,
        cleanup,
        Date,
        JSON,
        require: () => ({ spawnSync: () => ({ error: { code: "ETIMEDOUT" } }) }),
        process: { env: fixtureEnvironment },
        console: {
          error(line: unknown) {
            const event = readProbeLog(line);
            assert.equal(event.event, "openclaw.model_probe_stage");
            assert.ok(typeof event.stage === "string" && typeof event.elapsedMs === "number");
            events.push(event);
          },
        },
      },
    );
    assert.equal(code, "CAP");
    assert.equal(removed, true);
    // A removal that succeeds reports no cleanup error.
    assert.deepEqual(cleanup, {});
    assert.deepEqual(
      events.map((event) => event.stage),
      ["prepare", "spawn", "returned", "cleanup", "complete"],
    );
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ["capMs", "elapsedMs", "event", "stage"]);
      assert.equal(event.capMs, 110000);
    }
  });

  test("an OpenClaw probe timeout is classified by CPU wait inside its window (finding 2675)", () => {
    // --probe-timeout bounds OpenClaw's local preparation too, so under CPU
    // starvation its own timer can fire before the wrapper cap. Its window is only
    // the CLI's last 15 s, though: the boot before it is throttled at a CPU limit
    // even when the provider hangs, so a CLI timeout is judged on the wait inside
    // that window (read by the CLI preload), and the cap on the whole run.
    const helper = wrapperSourceFrom("function probeOpenClawAuthenticationFailure() {");
    // `window` is the preload's cpu-window.json, absent when undefined.
    const classify = (spawnResult: ProbeSpawnResult, pressureWaitUs: number, window?: string) => {
      let spawned = false;
      const files = new Map<string, string>();
      const calls: string[][] = [];
      const events: Record<string, unknown>[] = [];
      const fs = {
        readFileSync(path: string) {
          if (path.endsWith("/cpu.max")) {
            return "100000 100000\n";
          }
          if (path.endsWith("/cpu.pressure")) {
            return `some avg10=0.00 total=${spawned ? pressureWaitUs : 0}\n`;
          }
          if (path.endsWith("/cpu.stat")) {
            return "nr_throttled 0\nthrottled_usec 0\n";
          }
          if (path === "/owned/cpu-window.json" && window !== undefined) {
            return window;
          }
          throw Object.assign(new Error(`unexpected path ${path}`), { code: "ENOENT" });
        },
        mkdtempSync: () => "/owned",
        mkdirSync() {},
        writeFileSync(path: string, value: string) {
          files.set(path, value);
        },
        rmSync() {},
      };
      const spawnSync = (command: string, args: string[]) => {
        spawned = true;
        calls.push([command, ...args]);
        return spawnResult;
      };
      const observations: { result?: unknown; preload?: unknown } = {};
      const context = {
        observations,
        Date,
        JSON,
        Math,
        Number,
        require: (name: unknown) => {
          if (name === "node:fs") {
            return fs;
          }
          assert.equal(name, "node:child_process");
          return { spawnSync };
        },
        process: { env: fixtureEnvironment },
        console: {
          error(line: unknown) {
            events.push(readProbeLog(line));
          },
        },
      };
      vm.runInNewContext(
        helper +
          "\nobservations.result = probeOpenClawAuthenticationFailure();" +
          '\nobservations.preload = OPENCLAW_PROBE_CPU_WINDOW("/owned/cpu-window.json");',
        context,
      );
      // The CLI loads the generated window preload, written into its own directory.
      const [command] = calls;
      assert.ok(command);
      assert.deepEqual(command.slice(0, 4), [
        "node",
        "--require",
        "/owned/cpu-window.cjs",
        "/app/openclaw.mjs",
      ]);
      const timeoutFlag = command.indexOf("--probe-timeout");
      assert.ok(timeoutFlag >= 0);
      assert.equal(command[timeoutFlag + 1], "15000");
      assert.ok(typeof observations.preload === "string");
      assert.equal(files.get("/owned/cpu-window.cjs"), observations.preload);
      const probe = events.find(({ event }) => event === "openclaw.model_probe");
      assert.ok(probe && typeof probe.code === "string");
      const result = observations.result;
      assert.ok(result === undefined || (isRecord(result) && typeof result.code === "string"));
      assert.equal(probe.code, result?.code ?? "READY");
      return probe;
    };
    const openclawTimeout = {
      status: 0,
      stdout: JSON.stringify({
        auth: {
          probes: {
            results: [
              { provider: "fixture", model: "fixture/model", source: "env", status: "timeout" },
            ],
          },
        },
      }),
    };
    const cap = { error: { code: "ETIMEDOUT" } };
    // Any positive elapsed time in this synchronous run is far below an hour of wait.
    const starved = 3_600_000_000;
    // Each sample records elapsed, pressure, throttled and throttled-period time in ms.
    // Unreadable counters serialize as null.
    const window = (waits: readonly number[]) => {
      let pressureMs = 50;
      const samples: CpuSample[] = [[1000, pressureMs, null, null]];
      for (const [second, waitMs] of waits.entries()) {
        pressureMs += waitMs;
        samples.push([2000 + second * 1000, pressureMs, null, null]);
      }
      return JSON.stringify(samples);
    };
    const seconds = (count: number, waitMs: number) => Array.from({ length: count }, () => waitMs);
    // The cap is still judged on the whole run.
    assert.equal(classify(cap, starved).code, "MODEL_PROBE_CPU_STARVED");
    assert.equal(classify(cap, 0).code, "MODEL_PROBE_TIMEOUT");
    // OpenClaw's own timer: starvation needs over a quarter of the window waiting
    // and no 5 s stretch idle (each second at most a tenth waiting). The whole-run
    // reading (here an hour of wait, as a throttled boot reads) never decides it.
    for (const [name, waits, code, idleMs] of [
      // A hung provider on a remote test VM: 4.1 s of a 15.9 s window waited, in
      // the CLI's own work before and after the turn, around an idle turn.
      [
        "hung provider",
        [...seconds(3, 800), ...seconds(10, 0), ...seconds(3, 700)],
        "MODEL_PROBE_TIMEOUT",
        10_000,
      ],
      ["starved throughout", seconds(16, 600), "MODEL_PROBE_CPU_STARVED", 0],
      // A quarter exactly is not over a quarter.
      ["a quarter waiting", seconds(16, 250), "MODEL_PROBE_TIMEOUT", 0],
      ["just over a quarter", seconds(16, 251), "MODEL_PROBE_CPU_STARVED", 0],
      // A tenth of a second waiting still counts as idle.
      [
        "5 s idle",
        [...seconds(6, 900), ...seconds(5, 100), ...seconds(5, 900)],
        "MODEL_PROBE_TIMEOUT",
        5000,
      ],
      [
        "over a tenth waiting each second",
        [...seconds(6, 900), ...seconds(4, 101), ...seconds(6, 900)],
        "MODEL_PROBE_CPU_STARVED",
        0,
      ],
      [
        "4 s idle",
        [...seconds(6, 900), ...seconds(4, 0), ...seconds(6, 900)],
        "MODEL_PROBE_CPU_STARVED",
        4000,
      ],
    ] as const) {
      const probe = classify(openclawTimeout, starved, window(waits));
      assert.equal(probe.code, code, name);
      assert.deepEqual(
        [probe.timeoutWindowMs, probe.timeoutWindowCpuWaitMs, probe.timeoutWindowIdleMs],
        [16_000, waits.reduce((sum, waitMs) => sum + waitMs, 0), idleMs],
        name,
      );
    }
    // Without a usable window reading the CLI's timeout stays a timeout.
    for (const reading of [
      undefined,
      "not json",
      JSON.stringify([null, [16200, 50, 0, 0]]),
      JSON.stringify([
        [1000, null, null, null],
        [16200, null, null, null],
      ]),
    ]) {
      const probe = classify(openclawTimeout, starved, reading);
      assert.equal(probe.code, "MODEL_PROBE_TIMEOUT");
    }
  });

  test("the probe CLI preload records the CPU wait of OpenClaw's timeout window", () => {
    // Run the generated preload as the CLI would load it, with a fake clock and
    // cgroup: on the main thread it samples each second and at exit writes the
    // samples from the last one at least 15 s old, then the exit sample; worker
    // threads skip it.
    const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("function cpuCgroupFile(");
    const end = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\nfunction runOpenClawAuthenticationProbe(");
    assert.ok(begin >= 0 && end > begin);
    const preload: unknown = vm.runInNewContext(
      GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end) +
        '\nOPENCLAW_PROBE_CPU_WINDOW("/probe/cpu-window.json");',
      { JSON },
    );
    assert.ok(typeof preload === "string");
    const load = (isMainThread: boolean) => {
      const run: PreloadRun = { now: 0, pressureUs: 0, writes: new Map() };
      const fs = {
        readFileSync(path: string) {
          if (path === "/sys/fs/cgroup/cpu.max") {
            return "50000 100000\n";
          }
          if (path === "/sys/fs/cgroup/cpu.pressure") {
            return `some avg10=0.00 total=${run.pressureUs}\n`;
          }
          if (path === "/sys/fs/cgroup/cpu.stat") {
            return "nr_throttled 7\nthrottled_usec 900000\n";
          }
          throw new Error(`unexpected path ${path}`);
        },
        writeFileSync(path: string, value: string) {
          run.writes.set(path, value);
        },
      };
      vm.runInNewContext(preload, {
        JSON,
        Date: { now: () => run.now },
        require(name: unknown) {
          if (name === "node:worker_threads") {
            return { isMainThread };
          }
          assert.equal(name, "node:fs");
          return fs;
        },
        setInterval(callback: unknown, delay: unknown) {
          assert.equal(delay, 1000);
          assert.ok(typeof callback === "function");
          run.tick = () => {
            Reflect.apply(callback, undefined, []);
          };
          return { unref() {} };
        },
        process: {
          on(event: unknown, callback: unknown) {
            assert.equal(event, "exit");
            assert.ok(typeof callback === "function");
            run.exit = () => {
              Reflect.apply(callback, undefined, []);
            };
          },
        },
      });
      return run;
    };
    const worker = load(false);
    assert.deepEqual([worker.tick, worker.exit], [undefined, undefined]);
    const run = load(true);
    assert.ok(run.tick && run.exit, "expected the main-thread preload callbacks");
    // A 9 s boot waiting 1 s in every 2, then an idle 15.5 s window.
    for (let second = 1; second <= 24; second += 1) {
      run.now = second * 1000;
      if (second <= 9) {
        run.pressureUs += 500_000;
      }
      run.tick();
    }
    run.now = 24_500;
    run.exit();
    // Every sample from the last one at least 15 s before exit, then the exit sample.
    const written = run.writes.get("/probe/cpu-window.json");
    assert.ok(written);
    const samples: unknown = JSON.parse(written);
    assert.deepEqual(samples, [
      ...Array.from({ length: 16 }, (_, index) => [9000 + index * 1000, 4500, 900, 700]),
      [24_500, 4500, 900, 700],
    ]);
  });
}
