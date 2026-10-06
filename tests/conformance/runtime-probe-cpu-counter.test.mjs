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
  "\nfunction runOpenClawAuthenticationProbe(fs, capMs) {",
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
        return `usage_usec 1\nthrottled_usec ${value}\n`;
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
  return { code, cpuWaitMs: events[0].cpuWaitMs };
}

test("missing final PSI does not subtract an unrelated throttling total", () => {
  assert.deepEqual(probe([1_000_000, null], [31_000_000, 32_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

test("new PSI does not replace the original throttling baseline", () => {
  assert.deepEqual(probe([null, 1_000_000], [31_000_000, 32_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: 1_000,
  });
});

test("a high same-counter PSI delta retains the starvation classification", () => {
  assert.deepEqual(probe([1_000_000, 31_000_000], [0, 0]), {
    code: "MODEL_PROBE_CPU_STARVED",
    cpuWaitMs: 30_000,
  });
});

test("a low same-counter PSI delta retains the timeout classification", () => {
  assert.deepEqual(probe([1_000_000, 3_000_000], [1_000_000, 31_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: 2_000,
  });
});

test("unavailable PSI still allows a stable throttling delta", () => {
  assert.deepEqual(probe([null, null], [1_000_000, 31_000_000]), {
    code: "MODEL_PROBE_CPU_STARVED",
    cpuWaitMs: 30_000,
  });
});

test("missing initial counters leave wait unavailable", () => {
  assert.deepEqual(probe([null, 31_000_000], [null, 31_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

test("a reset counter leaves wait unavailable", () => {
  assert.deepEqual(probe([31_000_000, 1_000_000], [31_000_000, 61_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

test("missing final throttling leaves wait unavailable", () => {
  assert.deepEqual(probe([null, null], [1_000_000, null]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

test("a reset throttling counter leaves wait unavailable", () => {
  assert.deepEqual(probe([null, null], [31_000_000, 1_000_000]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

test("a nonfinite final counter cannot classify a probe as CPU-starved", () => {
  assert.deepEqual(probe([1_000_000, "9".repeat(400)], [0, 0]), {
    code: "MODEL_PROBE_TIMEOUT",
    cpuWaitMs: null,
  });
});

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
    });
  }
});

test("counter selection preserves the fractional CPU deadline", () => {
  assert.deepEqual(
    probe([1_000_000, 3_000_000], [0, 0], {
      quota: "50000 100000\n",
      capMs: 110_000,
    }),
    { code: "MODEL_PROBE_TIMEOUT", cpuWaitMs: 2_000 },
  );
});

test("counter selection preserves the maximum probe deadline", () => {
  assert.deepEqual(
    probe([1_000_000, 3_000_000], [0, 0], {
      quota: "1000 100000\n",
      capMs: 600_000,
    }),
    { code: "MODEL_PROBE_TIMEOUT", cpuWaitMs: 2_000 },
  );
});
