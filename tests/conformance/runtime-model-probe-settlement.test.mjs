import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";
import {
  modelProbeSettled,
  trackProbeCpuHog,
} from "../helpers/runtime-model-probe-observation.mjs";
import reporter from "../../scripts/ci/reporter.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const execute = promisify(execFile);
const ready = {
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

test("actual starved-case callback accepts READY; guard-removal control does not", async () => {
  const source = await readFile(
    new URL("../integration/runtime-image-model-probe.test.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf('"runtime image embedded Gateway reports a CPU-starved model probe at its cap"'),
  );
  const start = body.indexOf("until: ") + 7;
  const end = body.indexOf("\n      },", start) + 8;
  const callback = body.slice(start, end);
  const evaluate = (code) =>
    vm.runInNewContext(`let hogs; (${code})`, {
      Promise,
      modelProbeSettled,
      failed: ({ events }) =>
        events.some((event) => event.key === "runtimeFailure" && event.value != null),
      trackProbeCpuHog: () => Promise.resolve(),
      execute: () => Promise.resolve(),
      docker: "unused",
      stress: {},
    });
  assert.equal(evaluate(callback)(ready, "owned"), true);
  const negative = callback.replace(
    "return modelProbeSettled(snapshot);",
    "return failed(snapshot);",
  );
  assert.notEqual(negative, callback);
  assert.equal(evaluate(negative)(ready, "owned"), false);
  const program = /'([^']*openclaw-cpu-hog-started[^']*)'/u.exec(callback)?.[1];
  assert.ok(program);
  const actualArgument = vm.runInNewContext(`'${program}'`);
  assert.doesNotThrow(() => new vm.Script(actualArgument));
});

test(
  "owned inert Node child proves marker observation and terminal settlement",
  { timeout: 10_000 },
  async () => {
    const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
    const operation = execute(
      process.execPath,
      ["-e", 'process.stdout.write("openclaw-cpu-hog-started\\n")'],
      { timeout: 2_000 },
    );
    await trackProbeCpuHog(operation, stress);
    assert.deepEqual(stress, { requested: 1, started: 1, settled: 1, rejected: 0 });
  },
);

test("a rejected owned inert child is not counted as started", { timeout: 10_000 }, async () => {
  const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
  await trackProbeCpuHog(
    execute(process.execPath, ["-e", "process.exit(3)"], { timeout: 2_000 }),
    stress,
  );
  assert.deepEqual(stress, { requested: 1, started: 0, settled: 1, rejected: 1 });
});

test(
  "real Node reporter retains only closed probe failure observations",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pr687-probe-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = join(directory, "failure.test.mjs");
    await writeFile(
      fixture,
      `import test from 'node:test'; import assert from 'node:assert/strict';
    test('owned failure',()=>{ const error=new assert.AssertionError({message:'must-not-be-retained'});
    error.openclawCiDiagnostic={kind:'runtime-model-probe',reason:'outer-timeout',
    readyObserved:true,pluginReadyObserved:true,running:true,probeStage:'cleanup',probe:'READY',modelPhase:'ok',nativeSpawnPhaseObserved:true,failureObserved:false,
    capMs:110000,elapsedMs:120000,cpuWaitMs:null,loadClientsSubmitted:8,loadClientsStarted:7,loadClientsSettled:1,loadClientsRejected:1,
    raw:'must-not-be-retained',url:'https://must-not-be-retained.invalid',environment:'must-not-be-retained'};
    throw error;});`,
    );
    const reporterPath = fileURLToPath(new URL("../../scripts/ci/reporter.mjs", import.meta.url));
    let result;
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;
    try {
      await execute(process.execPath, ["--test", "--test-reporter", reporterPath, fixture], {
        timeout: 5_000,
        env: childEnv,
      });
    } catch (error) {
      result = error;
    }
    assert.equal(result?.code, 1);
    assert.doesNotMatch(result.stdout, /must-not-be-retained/u);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const diagnostic = events.find(
      (event) => event.type === "test:fail" && event.data.name === "owned failure",
    )?.data.error.diagnostic;
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
  const render = async (diagnostic) => {
    const source = [
      {
        type: "test:fail",
        data: { name: "owned", details: { error: { openclawCiDiagnostic: diagnostic } } },
      },
    ];
    let text = "";
    for await (const chunk of reporter(source)) {
      text += chunk;
    }
    return JSON.parse(text).data.error.diagnostic;
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
  assert.equal((await render(valid)).probe, "READY");
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
  ]) {
    assert.equal(await render({ ...valid, [key]: value }), undefined);
  }
  const stripped = await render({
    ...valid,
    probeStage: "must-not-be-retained",
    extra: "must-not-be-retained",
  });
  assert.equal(stripped.probeStage, "not-observed");
  assert.doesNotMatch(JSON.stringify(stripped), /must-not-be-retained/u);
});

test("real generated probe marks spawn return and cleanup without changing CAP", () => {
  // From the upfront credential check, which a fixture provider skips.
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const end =
    GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
      "\n}\n",
      GATEWAY_RUNTIME_ENTRYPOINT.indexOf("function runOpenClawAuthenticationProbe(fs, capMs) {"),
    ) + 2;
  const helper = GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end);
  assert.ok(begin >= 0 && end > begin);
  const events = [];
  let removed = false;
  const fs = {
    mkdtempSync: () => "/owned",
    mkdirSync() {},
    writeFileSync() {},
    rmSync() {
      removed = true;
    },
  };
  const code = vm.runInNewContext(helper + "\nrunOpenClawAuthenticationProbe(fs,110000)", {
    fs,
    Date,
    JSON,
    require: () => ({ spawnSync: () => ({ error: { code: "ETIMEDOUT" } }) }),
    process: {
      env: {
        OPENCLAW_HARNESS_MODEL: "fixture/model",
        OPENCLAW_HARNESS_PROVIDER: "fixture",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "FIXTURE_VALUE",
        FIXTURE_VALUE: "synthetic",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          agents: { defaults: { model: "fixture/model" } },
        }),
      },
    },
    console: {
      error(line) {
        events.push(JSON.parse(line));
      },
    },
  });
  assert.equal(code, "CAP");
  assert.equal(removed, true);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["prepare", "spawn", "returned", "cleanup", "complete"],
  );
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["capMs", "elapsedMs", "event", "stage"]);
    assert.equal(event.capMs, 110000);
  }
});

// The generated upfront credential check, run with a recording spawnSync.
function upfrontCheck(provider, fragment, key = "fixture-key", status = 3) {
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const end = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\nfunction runOpenClawAuthenticationProbe(");
  assert.ok(begin >= 0 && end > begin);
  const calls = [];
  const stages = [];
  const rejected = vm.runInNewContext(
    GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end) +
      "\ncredentialRejectedUpfront(provider, fragment, key, stage)",
    {
      provider,
      fragment,
      key,
      stage: (name) => stages.push(name),
      JSON,
      process: { execPath: "/node", env: { NODE_EXTRA_CA_CERTS: "/ca.pem" } },
      require: () => ({
        spawnSync(command, args, options) {
          calls.push({ command, args, options });
          return { status };
        },
      }),
    },
  );
  return { rejected, calls, stages };
}

test("the upfront credential check runs only where OpenClaw would send the same request", () => {
  const openai = upfrontCheck("openai", undefined);
  assert.equal(openai.rejected, true);
  assert.deepEqual(openai.stages, ["preflight"]);
  assert.equal(openai.calls.length, 1);
  assert.equal(openai.calls[0].options.env.U, "https://api.openai.com/v1/responses");
  assert.deepEqual(JSON.parse(openai.calls[0].options.env.H), {
    authorization: "Bearer fixture-key",
    "content-type": "application/json",
  });
  // Only the provider's 401 (exit 3) is a rejection.
  for (const status of [0, 1, null]) {
    assert.equal(upfrontCheck("openai", undefined, "fixture-key", status).rejected, false);
  }
  for (const [provider, fragment, key] of [
    ["openai", { baseUrl: "https://api.openai.com/v1/" }],
    ["openai", { api: "openai-completions", models: [{ id: "gpt-5" }] }],
    ["openai", { request: { allowPrivateNetwork: true } }],
    ["openai", null],
    ["anthropic", { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }],
    ["anthropic", undefined, "sk-ant-api03-fixture"],
  ]) {
    assert.equal(upfrontCheck(provider, fragment, key).calls.length, 1, JSON.stringify(fragment));
  }
  for (const [provider, fragment, key] of [
    ["openai", { baseUrl: "https://gateway.example/v1" }],
    ["openai", { api: "anthropic-messages" }],
    ["openai", { headers: { "OpenAI-Project": "proj_fixture" } }],
    ["openai", { authHeader: false }],
    ["openai", { request: { allowPrivateNetwork: true, proxy: { url: "http://proxy" } } }],
    ["openai", { models: [{ id: "gpt-5", headers: { "x-fixture": "1" } }] }],
    ["anthropic", { baseUrl: "https://api.openai.com/v1" }],
    ["anthropic", undefined, "sk-ant-oat01-fixture"],
    ["codex", undefined],
    ["fixture", undefined],
  ]) {
    const skipped = upfrontCheck(provider, fragment, key);
    assert.deepEqual([skipped.rejected, skipped.calls, skipped.stages], [false, [], []]);
  }
});

test("the upfront request exits 3 only when the provider answers 401", async (t) => {
  const { createServer } = await import("node:http");
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const source = /\["-e",\s*'([^']+)',/.exec(GATEWAY_RUNTIME_ENTRYPOINT.slice(begin))?.[1];
  assert.ok(source);
  const received = [];
  let answer = 401;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body,
      });
      response.writeHead(answer, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const run = (U) =>
    execute(process.execPath, ["-e", source], {
      env: { U, H: JSON.stringify({ authorization: "Bearer fixture-key" }) },
    }).then(
      () => 0,
      (error) => error.code,
    );
  assert.equal(await run(url), 3);
  assert.deepEqual(received, [
    { method: "POST", url: "/v1/responses", auth: "Bearer fixture-key", body: "{}" },
  ]);
  for (const status of [400, 403, 429, 500]) {
    answer = status;
    assert.equal(await run(url), 0, `HTTP ${status}`);
  }
  assert.equal(await run("http://127.0.0.1:1/v1/responses"), 0, "an unreachable endpoint");
});
