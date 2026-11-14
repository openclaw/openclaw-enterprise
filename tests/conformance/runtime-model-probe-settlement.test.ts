import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

import reporter from "../../scripts/ci/reporter.mjs";
import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";
import type { ProbeEvent, ProbePhase } from "../helpers/runtime-model-probe-diagnostic.ts";
import {
  modelProbeDiagnostic,
  modelProbeSettled,
  recordModelProbeMeasurement,
  trackProbeCpuHog,
} from "../helpers/runtime-model-probe-observation.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { registerModelProbeAuthenticationCases } from "./runtime-model-probe-authentication-cases.ts";
import { registerModelProbeWrapperCases } from "./runtime-model-probe-wrapper-cases.ts";

const execute = promisify(execFile);
const ready: { events: ProbeEvent[] } = {
  events: [
    { event: "observe", key: "ready", value: true },
    { event: "observe", key: "plugin", value: "ready" },
  ],
};

test("probe settlement accepts ready and failed outcomes without accepting partial readiness", () => {
  assert.equal(modelProbeSettled(ready), true);
  assert.equal(
    modelProbeSettled({
      events: [{ event: "observe", key: "runtimeFailure", value: "MODEL_PROBE_CPU_STARVED" }],
    }),
    true,
  );
  assert.equal(modelProbeSettled({ events: ready.events.slice(0, 1) }), false);
  assert.equal(
    modelProbeSettled({ events: [{ event: "observe", key: "runtimeFailure", value: null }] }),
    false,
  );
  assert.equal(modelProbeSettled({ events: [{ event: "observe", key: "runtimeFailure" }] }), false);
});

test("diagnostics ignore malformed mixed logs and do not retain input", () => {
  const phases: ProbePhase[] = [{ phase: "model-probe", outcome: "private-outcome" }];
  const snapshot = {
    output:
      'secret ordinary line\n{broken\nnull\n{"event":"openclaw.model_probe","code":"private-code","input":"secret-value"}\n',
    phases,
    events: [{ event: "observe", key: "runtimeFailure", value: 0 }],
    running: false,
  };
  const diagnostic = modelProbeDiagnostic(snapshot, undefined, "outer-timeout");
  assert.equal(diagnostic.probe, "other");
  assert.equal(diagnostic.modelPhase, "other");
  assert.equal(diagnostic.failureObserved, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private/);
});

function readMeasurement([line]: string[]) {
  const prefix = "openclaw-ci-measurement ";
  assert.ok(line && line.startsWith(prefix), "expected a probe measurement");
  const measurement: unknown = JSON.parse(line.slice(prefix.length));
  assert.ok(isRecord(measurement));
  return measurement;
}

test("measurement records rounded finite values and leaves absent values null", () => {
  const lines: string[] = [];
  recordModelProbeMeasurement({ diagnostic: (line) => lines.push(line) }, "case", {
    setupMs: 1.6,
    snapshot: {
      probe: { code: "READY", elapsedMs: 2.5, capMs: Infinity, cpuWaitMs: null },
      phases: [{ phase: "model-probe", sinceStartMs: 5.2 }],
      events: [{ event: "observe", key: "ready", value: true, ms: 8.7 }],
    },
  });
  assert.deepEqual(readMeasurement(lines), {
    kind: "runtime-model-probe",
    case: "case",
    code: "READY",
    elapsedMs: 3,
    capMs: null,
    cpuWaitMs: null,
    setupMs: 2,
    probeDoneMs: 5,
    readyMs: 9,
  });
});

test("raw probe fields preserve diagnostics and reject nonfinite measurements", () => {
  for (const value of ["5", { private: "sentinel" }, null, NaN, Infinity, -Infinity, -0, 2.6]) {
    const snapshot = {
      output: '{"event":"openclaw.model_probe","code":"READY","input":"secret"}',
      phases: [{ phase: "model-probe", outcome: value, sinceStartMs: value }],
      events: [],
      running: true,
      probe: { code: "READY", capMs: value, elapsedMs: value, cpuWaitMs: value },
      probeStage: value,
    };
    const diagnostic = modelProbeDiagnostic(snapshot, undefined, "outer-timeout");
    assert.equal(diagnostic.probe, "READY");
    assert.equal(diagnostic.modelPhase, "other");
    assert.equal(diagnostic.probeStage, value ?? "not-observed");
    assert.equal(diagnostic.capMs, value);
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret/);
    const lines: string[] = [];
    recordModelProbeMeasurement({ diagnostic: (line) => lines.push(line) }, "case", { snapshot });
    const measurement = readMeasurement(lines);
    const expected = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
    // JSON serialization normalizes negative zero to zero.
    for (const key of ["capMs", "elapsedMs", "cpuWaitMs", "probeDoneMs"]) {
      assert.equal(measurement[key], Object.is(expected, -0) ? 0 : expected);
    }
    assert.doesNotMatch(lines.join("\n"), /sentinel|secret/);
  }
});

test("actual starved-case callback accepts READY; guard-removal control does not", async () => {
  const source = await readFile(
    new URL("../integration/runtime-image-model-probe.test.ts", import.meta.url),
    "utf8",
  );
  const caseStart = source.indexOf(
    '"runtime image embedded Gateway settles its model probe under CPU contention"',
  );
  assert.ok(caseStart >= 0, "expected the image CPU-contention case");
  const body = source.slice(caseStart);
  const start = body.indexOf("until: ");
  const end = body.indexOf("\n      },", start);
  assert.ok(start >= 0 && end > start, "expected the image case's settlement callback");
  const callback = body.slice(start + "until: ".length, end + "\n      }".length);
  const evaluate = (code: string) => {
    const until: unknown = vm.runInNewContext(`let hogs; (${code})`, {
      Promise,
      modelProbeSettled,
      failed: ({ events }: { events: ProbeEvent[] }) =>
        events.some((event) => event.key === "runtimeFailure" && event.value != null),
      trackProbeCpuHog: () => Promise.resolve(),
      execute: () => Promise.resolve(),
      docker: "unused",
      stress: {},
    });
    assert.ok(typeof until === "function");
    const settled: unknown = Reflect.apply(until, undefined, [ready, "owned"]);
    assert.equal(typeof settled, "boolean");
    return settled;
  };
  assert.equal(evaluate(callback), true);
  const negative = callback.replace(
    "return modelProbeSettled(snapshot);",
    "return failed(snapshot);",
  );
  assert.notEqual(negative, callback);
  assert.equal(evaluate(negative), false);
  const program = /'([^']*openclaw-cpu-hog-started[^']*)'/u.exec(callback)?.[1];
  assert.ok(program);
  const actualArgument: unknown = vm.runInNewContext(`'${program}'`);
  assert.ok(typeof actualArgument === "string");
  assert.doesNotThrow(() => new vm.Script(actualArgument));
});

function executeInertChild(program: string) {
  const operation = execute(process.execPath, ["-e", program], { timeout: 2_000 });
  assertChildStdout(operation);
  return operation;
}

function assertChildStdout(operation: ReturnType<typeof execute>): asserts operation is ReturnType<
  typeof execute
> & {
  child: { stdout: NonNullable<typeof operation.child.stdout> };
} {
  assert.ok(operation.child.stdout, "the child must capture stdout");
}

test(
  "owned inert Node child proves marker observation and terminal settlement",
  { timeout: 10_000 },
  async () => {
    const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
    const operation = executeInertChild('process.stdout.write("openclaw-cpu-hog-started\\n")');
    await trackProbeCpuHog(operation, stress);
    assert.deepEqual(stress, { requested: 1, started: 1, settled: 1, rejected: 0 });
  },
);

test("a rejected owned inert child is not counted as started", { timeout: 10_000 }, async () => {
  const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
  await trackProbeCpuHog(executeInertChild("process.exit(3)"), stress);
  assert.deepEqual(stress, { requested: 1, started: 0, settled: 1, rejected: 1 });
});

function readReporterEvent(line: string) {
  const event: unknown = JSON.parse(line);
  assert.ok(isRecord(event) && typeof event.type === "string", "expected a reporter event");
  return event;
}

function readFailureDiagnostic(event: Record<string, unknown>, name: string): unknown {
  assert.equal(event.type, "test:fail");
  assert.ok(isRecord(event.data));
  assert.equal(event.data.name, name);
  assert.ok(isRecord(event.data.error));
  return event.data.error.diagnostic;
}

test(
  "real Node reporter retains only closed probe failure observations",
  { timeout: 10_000 },
  async (t) => {
    const directory = await temporaryDirectory(t, "pr687-probe-report-");
    const fixture = join(directory, "failure.test.mjs");
    await writeFile(
      fixture,
      `import test from 'node:test'; import assert from 'node:assert/strict';
    test('owned failure',()=>{ const error=new assert.AssertionError({message:'probe failed'});
    error.openclawCiDiagnostic={kind:'runtime-model-probe',reason:'outer-timeout',
    readyObserved:true,pluginReadyObserved:true,running:true,probeStage:'cleanup',probe:'READY',modelPhase:'ok',nativeSpawnPhaseObserved:true,failureObserved:false,
    capMs:110000,elapsedMs:120000,cpuWaitMs:null,loadClientsSubmitted:8,loadClientsStarted:7,loadClientsSettled:1,loadClientsRejected:1,
    raw:'must-not-be-retained',url:'https://must-not-be-retained.invalid',environment:'must-not-be-retained'};
    throw error;});`,
    );
    const reporterPath = fileURLToPath(new URL("../../scripts/ci/reporter.mjs", import.meta.url));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;
    const stdout = await execute(
      process.execPath,
      ["--test", "--test-reporter", reporterPath, fixture],
      {
        timeout: 5_000,
        env: childEnv,
      },
    ).then(
      () => assert.fail("the reporter fixture must fail"),
      (error: unknown) => {
        if (
          !isRecord(error) ||
          typeof error.code !== "number" ||
          typeof error.stdout !== "string"
        ) {
          throw error;
        }
        assert.equal(error.code, 1);
        return error.stdout;
      },
    );
    assert.doesNotMatch(stdout, /must-not-be-retained/u);
    const failure = stdout
      .trim()
      .split("\n")
      .map(readReporterEvent)
      .find(
        (event) =>
          event.type === "test:fail" && isRecord(event.data) && event.data.name === "owned failure",
      );
    assert.ok(failure);
    const diagnostic = readFailureDiagnostic(failure, "owned failure");
    assert.deepEqual(diagnostic, {
      kind: "runtime-model-probe",
      reason: "outer-timeout",
      running: true,
      readyObserved: true,
      pluginReadyObserved: true,
      capMs: 110000,
      elapsedMs: 120000,
      cpuWaitMs: null,
      loadClientsSubmitted: 8,
      loadClientsStarted: 7,
      loadClientsSettled: 1,
      loadClientsRejected: 1,
      probeStage: "cleanup",
      probe: "READY",
      modelPhase: "ok",
      nativeSpawnPhaseObserved: true,
      failureObserved: false,
    });
  },
);

test("reporter rejects unknown categories and strips unbounded or arbitrary fields", async () => {
  const render = async (diagnostic: unknown) => {
    const source = [
      {
        type: "test:fail",
        data: { name: "owned", details: { error: { openclawCiDiagnostic: diagnostic } } },
      },
    ];
    let text = "";
    for await (const chunk of reporter(source)) {
      assert.equal(typeof chunk, "string");
      text += chunk;
    }
    // A failed case is followed by the file's output tail event.
    const [failure] = text.split("\n");
    assert.ok(failure);
    return readFailureDiagnostic(readReporterEvent(failure), "owned");
  };
  assert.equal(await render({ kind: "runtime-model-probe", reason: "arbitrary" }), undefined);
  const result = await render({
    kind: "runtime-model-probe",
    reason: "classification",
    probeStage: "must-not-be-retained",
    probeCode: "must-not-be-retained",
    running: "must-not-be-retained",
    capMs: Infinity,
    hogsStarted: 9,
    elapsedMs: -1,
    raw: "must-not-be-retained",
  });
  assert.equal(result, undefined);
  const valid = {
    kind: "runtime-model-probe",
    reason: "classification",
    probe: "READY",
    modelPhase: "ok",
    running: true,
    readyObserved: true,
    pluginReadyObserved: true,
    nativeSpawnPhaseObserved: true,
    failureObserved: false,
    loadClientsSubmitted: 8,
    loadClientsStarted: 8,
    loadClientsSettled: 1,
    loadClientsRejected: 1,
    capMs: 110000,
    elapsedMs: 120000,
    cpuWaitMs: null,
    probeStage: "complete",
  };
  const accepted = await render(valid);
  assert.ok(isRecord(accepted));
  assert.equal(accepted.probe, "READY");
  for (const [key, value] of [
    ["running", "arbitrary"],
    ["probe", "arbitrary"],
    ["modelPhase", "arbitrary"],
    ["loadClientsSubmitted", 9],
    ["loadClientsStarted", -1],
    ["loadClientsRejected", 2],
    ["capMs", Infinity],
    ["elapsedMs", -1],
    ["cpuWaitMs", "arbitrary"],
  ] as const) {
    assert.equal(await render({ ...valid, [key]: value }), undefined);
  }
  const stripped = await render({
    ...valid,
    probeStage: "must-not-be-retained",
    extra: "must-not-be-retained",
  });
  assert.ok(isRecord(stripped));
  assert.equal(stripped.probeStage, "not-observed");
  assert.doesNotMatch(JSON.stringify(stripped), /must-not-be-retained/u);
});

registerModelProbeWrapperCases();
registerModelProbeAuthenticationCases();
