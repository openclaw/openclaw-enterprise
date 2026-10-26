import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// Exercise the helper embedded in the actual generated Gateway program. Fake
// cgroup reads make the two independently cumulative counters deterministic.
const helperStart = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
  "function probeOpenClawAuthenticationFailure() {",
);
const helperEnd = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
  "\nfunction runOpenClawAuthenticationProbe(fs, capMs, cleanup) {",
  helperStart,
);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helper = GATEWAY_RUNTIME_ENTRYPOINT.slice(helperStart, helperEnd);

function probe(pressure, throttling, options = {}) {
  let phase = 0;
  let clock = 0;
  const events = [];
  const fs = {
    readFileSync(path) {
      if (path.endsWith("/cpu.max")) {
        return options.quota ?? "100000 100000\n";
      }
      if (path.endsWith("/cpu.pressure")) {
        const value = pressure[phase];
        if (value === null) {
          throw new Error("pressure unavailable");
        }
        return `some avg10=0.00 total=${value}\n`;
      }
      if (path.endsWith("/cpu.stat")) {
        const value = throttling[phase];
        if (value === null) {
          throw new Error("throttling unavailable");
        }
        // Throttled periods bound throttled time by wall time: 1000 periods of
        // 100 ms allow 100 s unless a case sets fewer.
        const periods = phase === 0 ? 0 : (options.periods ?? 1000);
        return `usage_usec 1\nnr_throttled ${periods}\nthrottled_usec ${value}\n`;
      }
      throw new Error(`unexpected cgroup path ${path}`);
    },
  };
  const context = {
    require(name) {
      assert.equal(name, "node:fs");
      return fs;
    },
    Date: { now: () => (clock++ === 0 ? 1000 : 66000) },
    Math,
    Number,
    console: { error: (line) => events.push(JSON.parse(line)) },
    runOpenClawAuthenticationProbe(actualFs, capMs) {
      assert.equal(actualFs, fs);
      assert.equal(capMs, options.capMs ?? 65_000);
      phase = 1;
      return Object.hasOwn(options, "code") ? options.code : "CAP";
    },
  };
  const failure = vm.runInNewContext(`${helper}\nprobeOpenClawAuthenticationFailure();`, context);
  const code = failure?.code;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "openclaw.model_probe");
  assert.equal(events[0].elapsedMs, 65_000);
  assert.equal(events[0].code, code ?? "READY");
  // The event logs each counter's own delta beside the wait that classified it.
  const { cpuWaitMs, pressureWaitMs, throttledWaitMs } = events[0];
  return { code, cpuWaitMs, readings: [pressureWaitMs, throttledWaitMs] };
}

const TIMEOUT = "MODEL_PROBE_TIMEOUT";
const STARVED = "MODEL_PROBE_CPU_STARVED";

// run: [PSI totals, throttling totals, expected code, expected cpuWaitMs,
// expected [PSI delta, throttling delta], optional throttled periods]; each
// totals pair is the reading before and after the probe. The wait is the larger
// valid delta, so one counter that under-reads cannot hide starvation the other
// one saw (finding 2271). Throttled time, a sum over CPUs, is capped by the wall
// time of the throttled periods.
for (const { name, run } of [
  {
    name: "a low PSI delta with a high throttling delta is CPU starvation",
    run: [[1_000_000, 3_000_000], [1_000_000, 31_000_000], STARVED, 30_000, [2_000, 30_000]],
  },
  {
    name: "a high PSI delta without throttling is CPU starvation",
    run: [[1_000_000, 31_000_000], [0, 0], STARVED, 30_000, [30_000, 0]],
  },
  {
    name: "throttled time summed over CPUs is capped by the throttled periods",
    run: [[1_000_000, 3_000_000], [0, 900_000_000], TIMEOUT, 10_000, [2_000, 10_000], 100],
  },
  {
    name: "throttled periods covering most of the probe are CPU starvation",
    run: [[1_000_000, 3_000_000], [0, 900_000_000], STARVED, 60_000, [2_000, 60_000], 600],
  },
  {
    name: "two low deltas leave the timeout classification",
    run: [[1_000_000, 3_000_000], [1_000_000, 2_000_000], TIMEOUT, 2_000, [2_000, 1_000]],
  },
  {
    name: "unavailable PSI still allows a stable throttling delta",
    run: [[null, null], [1_000_000, 31_000_000], STARVED, 30_000, [null, 30_000]],
  },
  {
    name: "unavailable throttling still allows a stable PSI delta",
    run: [[1_000_000, 31_000_000], [null, null], STARVED, 30_000, [30_000, null]],
  },
  {
    name: "a low PSI delta without throttling samples is a timeout",
    run: [[1_000_000, 3_000_000], [null, null], TIMEOUT, 2_000, [2_000, null]],
  },
  {
    name: "missing final PSI is not subtracted from an unrelated total",
    run: [[1_000_000, null], [31_000_000, 32_000_000], TIMEOUT, 1_000, [null, 1_000]],
  },
  {
    name: "PSI that appears after the start has no baseline",
    run: [[null, 1_000_000], [31_000_000, 32_000_000], TIMEOUT, 1_000, [null, 1_000]],
  },
  {
    name: "a reset PSI counter leaves only the throttling delta",
    run: [[31_000_000, 1_000_000], [31_000_000, 61_000_000], STARVED, 30_000, [null, 30_000]],
  },
  {
    name: "missing initial counters leave wait unavailable",
    run: [[null, 31_000_000], [null, 31_000_000], TIMEOUT, null, [null, null]],
  },
  {
    name: "missing final throttling leaves wait unavailable",
    run: [[null, null], [1_000_000, null], TIMEOUT, null, [null, null]],
  },
  {
    name: "a reset throttling counter leaves wait unavailable",
    run: [[null, null], [31_000_000, 1_000_000], TIMEOUT, null, [null, null]],
  },
  {
    name: "a nonfinite final counter cannot classify a probe as CPU-starved",
    run: [[1_000_000, "9".repeat(400)], [null, null], TIMEOUT, null, [null, null]],
  },
  {
    name: "a nonfinite throttled total is not capped into a wait",
    run: [[1_000_000, 3_000_000], [0, "9".repeat(400)], TIMEOUT, 2_000, [2_000, null]],
  },
]) {
  test(name, () => {
    const [pressure, throttling, code, cpuWaitMs, readings, periods] = run;
    assert.deepEqual(probe(pressure, throttling, { periods }), { code, cpuWaitMs, readings });
  });
}

test("counter observation preserves ready and non-cap failure results", () => {
  for (const code of [
    undefined,
    "UNAVAILABLE",
    "AUTHENTICATION_FAILED",
    "MODEL_PROBE_FAILED",
    "MODEL_PROBE_TIMEOUT",
  ]) {
    assert.deepEqual(probe([1_000_000, 31_000_000], [0, 0], { code }), {
      code,
      cpuWaitMs: 30_000,
      readings: [30_000, 0],
    });
  }
});

test("counter selection preserves the fractional CPU deadline", () => {
  assert.deepEqual(
    probe([1_000_000, 3_000_000], [0, 0], {
      quota: "50000 100000\n",
      capMs: 110_000,
    }),
    { code: "MODEL_PROBE_TIMEOUT", cpuWaitMs: 2_000, readings: [2_000, 0] },
  );
});

test("counter selection preserves the maximum probe deadline", () => {
  assert.deepEqual(
    probe([1_000_000, 3_000_000], [0, 0], {
      quota: "1000 100000\n",
      capMs: 600_000,
    }),
    { code: "MODEL_PROBE_TIMEOUT", cpuWaitMs: 2_000, readings: [2_000, 0] },
  );
});
