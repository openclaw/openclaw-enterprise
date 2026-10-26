import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
import {
  bodyShapes as helperBodyShapes,
  providerErrorCodes as helperErrorCodes,
  providerErrorTypes as helperErrorTypes,
} from "../helpers/local-first-agent-native.mjs";
import { listen } from "../helpers/listen.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

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
    source.indexOf('"runtime image embedded Gateway settles its model probe under CPU contention"'),
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
    // A failed case is followed by the file's output tail event.
    return JSON.parse(text.split("\n")[0]).data.error.diagnostic;
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
      GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
        "function runOpenClawAuthenticationProbe(fs, capMs, cleanup) {",
      ),
    ) + 2;
  const helper = GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end);
  assert.ok(begin >= 0 && end > begin);
  const events = [];
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
  const code = vm.runInNewContext(helper + "\nrunOpenClawAuthenticationProbe(fs,110000,cleanup)", {
    fs,
    cleanup,
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

// The generated upfront credential check, run with a recording spawnSync. `status`
// is the child's exit status, or its whole `{ status, stdout }` result.
function upfrontCheck(provider, fragment, key = "fixture-key", status = 3) {
  const result = typeof status === "object" && status !== null ? status : { status };
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
          return result;
        },
      }),
    },
  );
  // A rejection is built in the VM context: copy it so deepEqual compares plain objects.
  return { rejected: rejected === false ? false : { ...rejected }, calls, stages };
}

test("the upfront credential check runs only where OpenClaw would send the same request", () => {
  const openai = upfrontCheck("openai", undefined);
  // A rejection names the provider's 401, who answered it (from response header
  // names only) and, when the child classified it, a closed-vocabulary code; the
  // response body and header values never leave the child.
  assert.deepEqual(openai.rejected, { providerStatus: 401, responseHeaderMarker: "none" });
  assert.deepEqual(openai.stages, ["preflight"]);
  assert.equal(openai.calls.length, 1);
  assert.equal(openai.calls[0].options.env.U, "https://api.openai.com/v1/responses");
  assert.deepEqual(JSON.parse(openai.calls[0].options.env.H), {
    authorization: "Bearer fixture-key",
    "content-type": "application/json",
  });
  // The request goes to the configured API's own path: OpenAI answers 401 to a key
  // that lacks the scope of an endpoint OpenClaw would never call.
  assert.equal(
    upfrontCheck("openai", { api: "openai-completions" }).calls[0].options.env.U,
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    upfrontCheck("openai", {
      api: "openai-completions",
      models: [{ id: "gpt-5", api: "openai-completions" }],
    }).calls[0].options.env.U,
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    upfrontCheck("openai", { api: "openai-responses" }).calls[0].options.env.U,
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    upfrontCheck("anthropic", undefined, "sk-ant-api03-fixture").calls[0].options.env.U,
    "https://api.anthropic.com/v1/messages",
  );
  // Only a 401 (exit 3-6 plus a known header marker 0, 10, 20 or 30) is a rejection.
  for (const status of [0, 1, 2, 7, 9, 10, 12, 17, 27, 30, 37, 40, 43, -3, 3.5, "13", null]) {
    assert.equal(upfrontCheck("openai", undefined, "fixture-key", status).rejected, false, status);
  }
  for (const [status, providerCode, responseHeaderMarker] of [
    [4, "invalid_api_key", "none"],
    [5, "missing_api_key", "none"],
    [6, "insufficient_permissions", "none"],
    [13, undefined, "provider-like"],
    [14, "invalid_api_key", "provider-like"],
    [15, "missing_api_key", "provider-like"],
    [16, "insufficient_permissions", "provider-like"],
    [23, undefined, "openshell-policy"],
    [25, "missing_api_key", "openshell-policy"],
    [33, undefined, "mixed"],
    [34, "invalid_api_key", "mixed"],
  ]) {
    assert.deepEqual(
      upfrontCheck("openai", undefined, "fixture-key", status).rejected,
      {
        providerStatus: 401,
        responseHeaderMarker,
        ...(providerCode === undefined ? {} : { providerCode }),
      },
      String(status),
    );
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
    ["openai", { models: [{ id: "gpt-5", api: "openai-completions" }] }],
    ["openai", { models: [{ id: "gpt-5", baseUrl: "https://gateway.example/v1" }] }],
    ["openai", { api: "__proto__" }],
    ["anthropic", { baseUrl: "https://api.openai.com/v1" }],
    ["anthropic", undefined, "sk-ant-oat01-fixture"],
    ["codex", undefined],
    ["fixture", undefined],
  ]) {
    const skipped = upfrontCheck(provider, fragment, key);
    assert.deepEqual([skipped.rejected, skipped.calls, skipped.stages], [false, [], []]);
  }
});

// The closed sets the child receives (C, T) and the parent keeps.
const UPFRONT_ERROR_CODES = [
  "invalid_api_key",
  "insufficient_permissions",
  "invalid_organization",
  "mismatched_organization",
  "no_organization",
  "invalid_project",
  "mismatched_project",
  "account_deactivated",
  "deactivated_workspace",
  "ip_not_authorized",
];
const UPFRONT_ERROR_TYPES = ["invalid_request_error", "authentication_error", "permission_error"];
const HOSTILE_KEY = "sk-proj-HostileFixtureKey0123456789abcdef";

test("the upfront check keeps only closed-set body tokens from its child", () => {
  const { calls } = upfrontCheck("openai", undefined);
  // Only stdout is read, bounded; the child gets the closed sets, never "other".
  assert.deepEqual([...calls[0].options.stdio], ["ignore", "pipe", "ignore"]);
  assert.equal(calls[0].options.encoding, "utf8");
  assert.ok(calls[0].options.maxBuffer <= 1024);
  assert.deepEqual(JSON.parse(calls[0].options.env.C), UPFRONT_ERROR_CODES);
  assert.deepEqual(JSON.parse(calls[0].options.env.T), UPFRONT_ERROR_TYPES);
  // The QA helper reads the same sets, plus "other".
  assert.deepEqual([...helperErrorCodes], [...UPFRONT_ERROR_CODES, "other"]);
  assert.deepEqual([...helperErrorTypes], [...UPFRONT_ERROR_TYPES, "other"]);
  assert.deepEqual(
    [...helperBodyShapes],
    ["json-error-code", "json-error-no-code", "json-no-error", "non-json", "empty"],
  );
  const rejected = (stdout, status = 13) =>
    upfrontCheck("openai", undefined, "fixture-key", { status, stdout }).rejected;
  const base = { providerStatus: 401, responseHeaderMarker: "provider-like" };
  for (const [bodyShape, providerErrorCode, providerErrorType] of [
    ["json-error-code", "no_organization", "invalid_request_error"],
    ["json-error-code", "other", "other"],
    ["json-error-code", "ip_not_authorized", "permission_error"],
    ["json-error-no-code", "", "authentication_error"],
    ["json-error-no-code", "", ""],
    ["json-no-error", "", ""],
    ["non-json", "", ""],
    ["empty", "", ""],
  ]) {
    assert.deepEqual(
      rejected(JSON.stringify([bodyShape, providerErrorCode, providerErrorType])),
      {
        ...base,
        bodyShape,
        ...(providerErrorCode && { providerErrorCode }),
        ...(providerErrorType && { providerErrorType }),
      },
      bodyShape,
    );
  }
  for (const code of UPFRONT_ERROR_CODES) {
    assert.equal(rejected(JSON.stringify(["json-error-code", code, ""])).providerErrorCode, code);
  }
  for (const type of UPFRONT_ERROR_TYPES) {
    assert.equal(rejected(JSON.stringify(["json-error-code", "", type])).providerErrorType, type);
  }
  // Each token is checked on its own: exact, case-sensitive set members only.
  assert.deepEqual(
    rejected(JSON.stringify(["json-error-code", "Invalid_API_Key", "authentication_error "])),
    { ...base, bodyShape: "json-error-code" },
  );
  assert.deepEqual(rejected(JSON.stringify(["html", "other", "permission_error"])), {
    ...base,
    providerErrorCode: "other",
    providerErrorType: "permission_error",
  });
  // Anything off-set, misplaced or malformed is dropped, never passed on.
  for (const stdout of [
    JSON.stringify(["html", "", ""]),
    JSON.stringify(["other", "invalid_request_error", "invalid_api_key"]),
    JSON.stringify([HOSTILE_KEY, HOSTILE_KEY, "Bearer " + HOSTILE_KEY]),
    JSON.stringify([["empty"], { code: "invalid_api_key" }, 401]),
    JSON.stringify({ bodyShape: "empty", providerErrorCode: "invalid_api_key" }),
    '"empty"',
    "empty",
    "",
    HOSTILE_KEY,
    undefined,
    null,
  ]) {
    const result = rejected(stdout);
    assert.deepEqual(result, base, String(stdout));
    assert.ok(!JSON.stringify(result).includes("Hostile"));
  }
  // Tokens never turn a non-401 into a rejection.
  for (const status of [0, 1, 7, null]) {
    assert.equal(rejected(JSON.stringify(["empty", "", ""]), status), false, String(status));
  }
});

test("the upfront request exits 3 only when the provider answers 401", async (t) => {
  const { createServer } = await import("node:http");
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const source = /\["-e",\s*'([^']+)',/.exec(GATEWAY_RUNTIME_ENTRYPOINT.slice(begin))?.[1];
  assert.ok(source);
  const received = [];
  let answer = 401;
  let answerBody = "{}";
  let answerHeaders = {};
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
      response
        .writeHead(answer, { "content-type": "application/json", ...answerHeaders })
        .end(answerBody);
    });
  });
  const url = `http://127.0.0.1:${await listen(t, server)}/v1/responses`;
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
  // The 401 is classified from the provider's error code or a few fixed phrases
  // (finding 1643: a request that reached the provider without its credential is
  // told apart from a rejected key); anything else stays 3. OpenAI's actual
  // answer to an absent, empty, schemeless or duplicated Authorization header on
  // /v1/responses is "Missing bearer or basic authentication in header" with a
  // null code.
  for (const [body, code] of [
    ['{"error":{"code":"invalid_api_key","message":"Incorrect API key provided: sk-x"}}', 4],
    ['{"error":{"code":null,"message":"You didn\'t provide an API key."}}', 5],
    ['{"error":{"message":"No API key provided."}}', 5],
    ['{"error":{"code":null,"message":"Missing bearer or basic authentication in header"}}', 5],
    ['{"error":{"code":"insufficient_permissions","message":"x"}}', 6],
    ['{"error":{"message":"Missing scopes: api.responses.write"}}', 6],
    ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 4],
    ['{"error":{"type":"authentication_error","message":"x-api-key header is required"}}', 5],
    ['{"error":{"code":"other","message":"Unauthorized"}}', 3],
    ["not json", 3],
    ['{"error":"string"}', 3],
  ]) {
    answerBody = body;
    assert.equal(await run(url), code, body);
  }
  // The response header names seen are added as 10 (provider-like: OpenAI's
  // x-request-id plus an openai-* or x-openai-* header, or Anthropic's request-id
  // plus x-should-retry), 20 (X-OpenShell-Policy) or 30 (both: an upstream 401
  // forwarded with the relay's stamp); header values never matter.
  for (const [headers, source] of [
    [{ "x-request-id": "req_fixture", "openai-version": "2020-10-01" }, 10],
    [{ "x-request-id": "req_fixture", "x-openai-authorization-error": "1" }, 10],
    [{ "X-Request-Id": "req_fixture", "OpenAI-Processing-Ms": "3" }, 10],
    [{ "request-id": "req_fixture", "x-should-retry": "false" }, 10],
    [{ "x-request-id": "req_fixture" }, 0],
    [{ "request-id": "req_fixture" }, 0],
    [{ "x-should-retry": "false" }, 0],
    [{ "openai-version": "2020-10-01" }, 0],
    [{ "x-request-id": "req_fixture", "x-not-openai-marker": "1" }, 0],
    [{ "x-openshell-policy": "fixture-policy" }, 20],
    [{ "X-OpenShell-Policy": "fixture-policy", "x-request-id": "r", "openai-version": "1" }, 30],
    [{ "x-openshell-policy": "fixture-policy", "request-id": "r", "x-should-retry": "false" }, 30],
    [{ "x-openshell-policy": "fixture-policy", "x-request-id": "r" }, 20],
    [{ "x-openshell": "no-dash-suffix" }, 0],
    [{ "x-openshell-other": "1" }, 0],
  ]) {
    answerHeaders = headers;
    answerBody =
      '{"error":{"code":null,"message":"Missing bearer or basic authentication in header"}}';
    assert.equal(await run(url), source + 5, JSON.stringify(headers));
    answerBody = "{}";
    assert.equal(await run(url), source + 3, JSON.stringify(headers));
  }
  answerHeaders = {};
  answerBody = "{}";
  for (const status of [400, 403, 429, 500]) {
    answer = status;
    assert.equal(await run(url), 0, `HTTP ${status}`);
  }
  // The relay's own denial (403 stamped with X-OpenShell-Policy) is never a 401 rejection.
  answer = 403;
  answerHeaders = { "x-openshell-policy": "fixture-policy" };
  assert.equal(await run(url), 0, "a relay denial");
  answerHeaders = {
    "x-openshell-policy": "fixture-policy",
    "x-request-id": "r",
    "openai-version": "1",
  };
  assert.equal(await run(url), 0, "a forwarded 403");
  answerHeaders = {};
  assert.equal(await run("http://127.0.0.1:1/v1/responses"), 0, "an unreachable endpoint");
});

test("the upfront child names a 401 body's shape and closed-set code and type, never its text", async (t) => {
  const { createServer } = await import("node:http");
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const source = /\["-e",\s*'([^']+)',/.exec(GATEWAY_RUNTIME_ENTRYPOINT.slice(begin))?.[1];
  assert.ok(source);
  // The child runs with the environment the parent gives it.
  const { env } = upfrontCheck("openai", undefined).calls[0].options;
  let answer = 401;
  let answerBody = "";
  let breakOff = false;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(answer, {
        "content-type": "application/json",
        "x-request-id": "req_" + HOSTILE_KEY,
        "openai-organization": HOSTILE_KEY,
        ...(breakOff && { "content-length": String(answerBody.length + 100) }),
      });
      if (breakOff) {
        response.write(answerBody, () => response.socket.destroy());
      } else {
        response.end(answerBody);
      }
    });
  });
  const url = `http://127.0.0.1:${await listen(t, server)}/v1/responses`;
  const run = (body) => {
    answerBody = body;
    return execute(process.execPath, ["-e", source], {
      env: {
        U: url,
        H: JSON.stringify({ authorization: "Bearer fixture-key" }),
        C: env.C,
        T: env.T,
      },
    }).then(
      ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
      ({ code, stdout, stderr }) => ({ status: code, stdout, stderr }),
    );
  };
  const quoted = JSON.stringify(HOSTILE_KEY);
  for (const [body, status, bodyShape, providerErrorCode, providerErrorType] of [
    [
      `{"error":{"message":"Incorrect API key provided: ${HOSTILE_KEY}","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`,
      14,
      "json-error-code",
      "invalid_api_key",
      "invalid_request_error",
    ],
    [
      '{"error":{"message":"Missing bearer or basic authentication in header","type":"invalid_request_error","param":null,"code":null}}',
      15,
      "json-error-no-code",
      undefined,
      "invalid_request_error",
    ],
    [
      '{"error":{"message":"You must be a member of an organization to use the API.","type":"invalid_request_error","param":null,"code":"no_organization"}}',
      13,
      "json-error-code",
      "no_organization",
      "invalid_request_error",
    ],
    [
      '{"error":{"code":"mismatched_project","message":"x"}}',
      13,
      "json-error-code",
      "mismatched_project",
      undefined,
    ],
    [
      '{"error":{"code":"ip_not_authorized","type":"permission_error"}}',
      13,
      "json-error-code",
      "ip_not_authorized",
      "permission_error",
    ],
    [
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      14,
      "json-error-no-code",
      undefined,
      "authentication_error",
    ],
    // Off-set codes and types, however key-shaped, become "other".
    [
      `{"error":{"code":${quoted},"type":${quoted},"message":${quoted},"param":${quoted}}}`,
      13,
      "json-error-code",
      "other",
      "other",
    ],
    [
      '{"error":{"code":"INVALID_API_KEY","type":"Authentication_Error"}}',
      13,
      "json-error-code",
      "other",
      "other",
    ],
    [
      '{"error":{"code":401,"type":["authentication_error"]}}',
      13,
      "json-error-code",
      "other",
      "other",
    ],
    ['{"error":{"code":"","type":{"name":"x"}}}', 13, "json-error-code", "other", "other"],
    ['{"error":{"code":false}}', 13, "json-error-code", "other", undefined],
    // Prototype-shaped names are plain off-set values or own keys, never lookups.
    [
      '{"error":{"code":"__proto__","type":"constructor"}}',
      13,
      "json-error-code",
      "other",
      "other",
    ],
    [
      '{"error":{"code":"toString","type":"hasOwnProperty"}}',
      13,
      "json-error-code",
      "other",
      "other",
    ],
    [
      '{"error":{"__proto__":{"code":"invalid_api_key"}}}',
      13,
      "json-error-no-code",
      undefined,
      undefined,
    ],
    [
      '{"__proto__":{"error":{"code":"invalid_api_key"}}}',
      13,
      "json-no-error",
      undefined,
      undefined,
    ],
    ['{"error":{}}', 13, "json-error-no-code", undefined, undefined],
    // JSON without an error object, including a bare error string or array.
    [`{"error":${quoted}}`, 13, "json-no-error", undefined, undefined],
    ['{"error":["invalid_api_key"]}', 13, "json-no-error", undefined, undefined],
    ['{"error":null,"code":"invalid_api_key"}', 13, "json-no-error", undefined, undefined],
    [`{"message":${quoted}}`, 13, "json-no-error", undefined, undefined],
    ["null", 13, "json-no-error", undefined, undefined],
    [quoted, 13, "json-no-error", undefined, undefined],
    [`Unauthorized: ${HOSTILE_KEY}`, 13, "non-json", undefined, undefined],
    [`<html><body>401 ${HOSTILE_KEY}</body></html>`, 13, "non-json", undefined, undefined],
    ["", 13, "empty", undefined, undefined],
    [" \n\t", 13, "empty", undefined, undefined],
  ]) {
    const child = await run(body);
    assert.equal(child.status, status, body);
    assert.deepEqual(
      JSON.parse(child.stdout),
      [bodyShape, providerErrorCode ?? "", providerErrorType ?? ""],
      body,
    );
    // The parent turns the child's result into the probe's fields.
    const { rejected } = upfrontCheck("openai", undefined, "fixture-key", child);
    assert.deepEqual(
      rejected,
      {
        providerStatus: 401,
        responseHeaderMarker: "provider-like",
        ...({ 4: { providerCode: "invalid_api_key" }, 5: { providerCode: "missing_api_key" } }[
          status % 10
        ] ?? {}),
        bodyShape,
        ...(providerErrorCode && { providerErrorCode }),
        ...(providerErrorType && { providerErrorType }),
      },
      body,
    );
    // Neither the body, a header value, the request's key nor any part of a
    // hostile key leaves the child.
    for (const text of [child.stdout, child.stderr, JSON.stringify(rejected)]) {
      assert.ok(
        !/Hostile|sk-proj|fixture-key|Incorrect|Unauthorized|member|html/i.test(text),
        text,
      );
    }
  }
  // A body that breaks off mid-read names no shape: it was neither empty nor parsed.
  breakOff = true;
  const broken = await run(`{"error":{"code":"invalid_api_key","message":${quoted}`);
  breakOff = false;
  assert.equal(broken.status, 13);
  assert.deepEqual(JSON.parse(broken.stdout), ["", "", ""]);
  assert.deepEqual(upfrontCheck("openai", undefined, "fixture-key", broken).rejected, {
    providerStatus: 401,
    responseHeaderMarker: "provider-like",
  });
  // A non-401 answer writes nothing, whatever its body.
  for (const status of [400, 403, 500]) {
    answer = status;
    const child = await run(`{"error":{"code":"invalid_api_key","message":${quoted}}}`);
    assert.deepEqual([child.status, child.stdout], [0, ""], String(status));
  }
});
