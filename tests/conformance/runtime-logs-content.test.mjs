import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maskRuntimeEventText,
  redactArgvCredentials,
  redactRuntimeLogText,
  stripRuntimeLogControls,
} from "../../packages/occ/src/runtime-logs/redact.ts";
import {
  runtimeLogEvidence,
  sanitizeRuntimeLogChunk,
} from "../../packages/occ/src/runtime-logs/sanitize.ts";
import {
  compareRuntimeLogTime,
  readRuntimeLogPage,
} from "../../packages/occ/src/runtime-logs/read.ts";
import { cpuTimeMs } from "../helpers/cpu-time.mjs";
import {
  createRuntimeLogCursorCodec,
  RUNTIME_LOG_CURSOR_TTL_MS,
  validRuntimeLogFrontierTime,
} from "../../packages/occ/src/runtime-logs/cursor.ts";

const corpusUrl = new URL("../fixtures/runtime-logs/canary-corpus.txt", import.meta.url);
const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Canaries are generated per run so no credential-shaped value is committed.
function randomString(length, alphabet = alphanumeric) {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function canaries() {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    QUERY_TOKEN: `q${randomString(23)}`,
    SIGNATURE: randomString(32),
    FRAGMENT: `frag${randomString(20)}`,
    PROMPT: `prompt-canary-${randomUUID()}`,
    CONTENT: `content-canary-${randomUUID()}`,
    PROTO: `proto-canary-${randomUUID()}`,
    OPENAI_KEY: `sk-proj-${randomString(40)}`,
    API_KEY: `key${randomString(21)}`,
    INSTALLATION_TOKEN: `ghs_${randomString(36)}`,
    BEARER: randomString(32),
    COOKIE: randomString(24),
    PASSWORD: `pw${randomString(14)}`,
    CLI_PASSWORD: `cli${randomString(13)}`,
    AWS_KEY: `AKIA${randomString(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
    HEX40: randomBytes(20).toString("hex"),
    JWT: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: randomUUID() })}.${randomString(43)}`,
    PEM_BODY: randomBytes(48).toString("base64"),
    GITHUB_PAT: `github_pat_${randomString(40)}`,
    RPC: `rpc-canary-${randomUUID()}`,
    CODEX_PROMPT: `codex-prompt-${randomUUID()}`,
    // Chat text that codex_core interpolates into a warning message.
    CODEX_CHAT: `codex-chat-${randomUUID()}`,
    WRAPPER_EXTRA: `wrapper-extra-${randomUUID()}`,
    MALFORMED: `malformed-canary-${randomUUID()}`,
    ARGV_PASSWORD: `argv${randomString(12)}`,
    HF_TOKEN: `hf_${randomString(34)}`,
    STRIPE_KEY: `sk_live_${randomString(24)}`,
    BASIC: Buffer.from(`user:${randomString(12)}`).toString("base64"),
    NETRC_PASSWORD: `netrc${randomString(12)}`,
    SERVICE_KEY: randomBytes(16).toString("hex"),
    // A chat reply that the agent command prints through `runtime.log` (no subsystem).
    REPLY: `reply-canary-${randomUUID()}`,
  };
}

function lineTime(index) {
  return `2026-09-30T12:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(9, "0")}Z`;
}

async function corpusLines(values) {
  const template = await readFile(corpusUrl, "utf8");
  const lines = template
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\{\{([A-Z_0-9]+)\}\}/g, (_match, name) => values[name]));
  // Hostile shapes that a text fixture cannot carry literally.
  const deep = { level: "info", message: "deep" };
  let cursor = deep;
  for (let depth = 0; depth < 12; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  cursor.secret = values.DEEP;
  lines.push(JSON.stringify(deep));
  lines.push(`\u001b[31mcolored\u001b[0m output\u0007 with ${values.CONTROL} and \u0000nul`);
  return lines.map((raw, index) => ({ time: lineTime(index), raw }));
}

const gatewayStream = { source: "gateway", pod: "gateway-0", container: "gateway" };
const agentStream = { source: "agent", pod: "gateway-0", container: "agent" };
const agentPodStream = { source: "agent", pod: "agent-0", container: "agent" };

// One sanitizer pass over raw lines timed lineTime(first), lineTime(first + 1), ...
function sanitize(stream, raws, { first = 0, truncated = false } = {}) {
  return sanitizeRuntimeLogChunk({
    stream,
    truncated,
    lines: raws.map((raw, index) => ({ time: lineTime(first + index), raw })),
  });
}
function pick(records, keys) {
  return records.map((record) => Object.fromEntries(keys.map((key) => [key, record[key]])));
}
function gatewayJson(message) {
  return JSON.stringify({ level: "info", subsystem: "gateway", message });
}

// The production controller app over the in-memory runtime-log Compute Driver
// (tests/helpers/runtime-logs.mjs) with one deployed Agent. `wrap` decorates the Driver.
async function logsRoute({ label, state, wrap, ...options } = {}) {
  const { createRuntimeLogComputeDriver, createRuntimeLogFixture } =
    await import("../helpers/runtime-logs.mjs");
  const driver = createRuntimeLogComputeDriver(state === undefined ? {} : { state });
  const fixture = await createRuntimeLogFixture({
    ...options,
    computeDriver: wrap === undefined ? driver : wrap(driver),
  });
  const target = await fixture.deployAgent(label);
  return {
    fixture,
    target,
    state: driver.state,
    get: (path) => fixture.request("GET", path),
    // GET the gateway source's logs; undefined query values are left out.
    read(query = {}) {
      const params = new URLSearchParams({ source: "gateway" });
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(name, String(value));
        }
      }
      return fixture.request("GET", target.logsPath(params.toString()));
    },
  };
}

function assertNoCanary(text, values, where) {
  for (const [name, value] of Object.entries(values)) {
    if (name !== "CONTROL") {
      assert.equal(text.includes(value), false, `canary ${name} leaked ${where}`);
    }
  }
}

test("runtime status refuses an invalid Driver timestamp instead of normalizing it", async () => {
  const route = await logsRoute({ state: { observedAt: "2026-02-30" } });

  const runtime = await route.get(route.target.runtimePath);

  assert.equal(runtime.status, 503, runtime.text);
  assert.equal(runtime.body.error.code, "RUNTIME_LOGS_UNAVAILABLE");
  assert.equal(runtime.text.includes("2026-03-02"), false);
});

test("runtime log route bodies never contain planted credentials, prompts or protocol output", async () => {
  const values = {
    ...canaries(),
    DEEP: `deep-canary-${randomUUID()}`,
    CONTROL: "visible-control-text",
  };
  // Hex split at the 1 MiB boundary: the fragment is below every redaction threshold,
  // so only dropping the partial final line keeps it out of the page.
  const splitFragment = randomBytes(10).toString("hex");
  const planted = { ...values, SPLIT: splitFragment };
  const eventBearer = randomString(30);
  const route = await logsRoute();
  Object.assign(route.state, {
    lines: [
      ...(await corpusLines(values)),
      { time: lineTime(90), raw: `export GIT_TOKEN_PART=${splitFragment}` },
    ],
    truncated: true,
    restartCount: 1,
    terminationReason: `Error: token ${values.GITHUB_PAT}`,
    events: [
      {
        type: "Warning",
        reason: "Failed",
        message: `Failed to pull image: Authorization: Bearer ${eventBearer}`,
        count: 3,
        lastObservedAt: "2026-09-30T11:59:00Z",
      },
    ],
  });

  const runtime = await route.get(route.target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.headers.get("cache-control"), "no-store");
  assert.equal(runtime.text.includes(eventBearer), false, "Event messages are redacted");
  assert.equal(runtime.text.includes(values.GITHUB_PAT), false, "termination reasons are redacted");
  assert.match(runtime.data.pods[0].events[0].message, /\[redacted:header\]/);

  const logs = await route.read({ tailLines: 1000 });
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.headers.get("cache-control"), "no-store");
  assertNoCanary(logs.text, planted, "into the response");
  // A level floor only removes sanitized records; it never reaches unsanitized text.
  const floored = await route.read({ tailLines: 1000, minLevel: "warn" });
  assert.equal(floored.status, 200, floored.text);
  assertNoCanary(floored.text, planted, "at minLevel=warn");
  assert.ok(
    floored.data.records.every(
      (record) => record.type !== "line" || ["error", "warn", "unknown"].includes(record.level),
    ),
  );
  assert.equal(floored.data.records.at(-1).reason, "truncated");
  // The download is the same sanitized page in a second serializer.
  const download = await route.read({ download: true });
  assert.equal(download.status, 200, download.text);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assertNoCanary(download.text, planted, "into the download");
  assert.match(download.text, /\[redacted:/);
  assert.match(download.text, / WITHHELD 3 unrecognised_structured$/m);
  assert.match(download.text, / GAP truncated: /);
  const controls = [...download.text].filter((character) => {
    const code = character.codePointAt(0);
    return (code < 0x20 && code !== 0x0a) || code === 0x7f;
  });
  assert.deepEqual(controls, [], "the download carries no control characters");
  // `content` is reserved and has no producer.
  assert.ok(logs.data.records.length > 0);
  assert.ok(
    logs.data.records.every(
      (record) => record.type !== "line" || record.contentClass === "operational",
    ),
  );
  assert.equal(logs.text.includes('"contentClass":"content"'), false);

  // Operational context survives; payloads are withheld and counted.
  const lines = logs.data.records.filter((record) => record.type === "line");
  const wrapper = lines.find((record) => record.kind === "wrapper");
  assert.deepEqual(wrapper.fields, {
    container: "gateway",
    phase: "config",
    outcome: "ok",
    ms: 12,
    sinceStartMs: 40,
  });
  assert.deepEqual(
    pick(
      lines.filter((record) => record.kind === "codex"),
      ["level", "message", "subsystem"],
    ),
    [
      {
        level: "warn",
        message: "stream connection failed; waiting to retry",
        subsystem: "codex_core::responses_retry",
      },
      // codex_core text outside the reviewed messages keeps its level and target only.
      { level: "warn", message: "Codex message withheld", subsystem: "codex_core::event_mapping" },
    ],
  );
  const openclaw = lines.find((record) => record.message === "turn started");
  assert.deepEqual(openclaw.fields, { agent_id: "main" });
  assert.ok(lines.some((record) => record.message.includes("[redacted:userinfo]@github.com")));
  assert.ok(lines.some((record) => record.message.includes("visible-control-text")));
  assert.equal(logs.text.includes("\\u001b"), false, "ANSI escapes are stripped");
  assert.deepEqual(
    pick(
      logs.data.records.filter((record) => record.type === "withheld"),
      ["reason", "count"],
    ),
    [
      { reason: "unrecognised_structured", count: 3 },
      { reason: "malformed", count: 2 },
    ],
  );
  assert.equal(logs.data.withheld, 5);
  // The byte cut is labelled, never silent.
  assert.equal(logs.data.truncated, true);
  assert.equal(logs.data.records.at(-1).type, "gap");
  assert.equal(logs.data.records.at(-1).reason, "truncated");
});

test("OpenClaw console records without a subsystem are withheld below warn", () => {
  const reply = `reply-canary-${randomUUID()}`;
  const { records } = sanitize(
    gatewayStream,
    [
      JSON.stringify({ level: "info", message: reply }),
      JSON.stringify({ level: "debug", message: reply, subsystem: "" }),
      JSON.stringify({
        level: "error",
        message: "Gateway failed to start: gateway.bind=custom requires gateway.customBindHost",
      }),
      JSON.stringify({ level: "warn", message: "config reloaded" }),
      JSON.stringify({ level: "info", subsystem: "gateway", message: "listening" }),
    ],
    { first: 1 },
  );
  assert.deepEqual(
    records.map((record) =>
      record.type === "withheld"
        ? `withheld ${record.reason} ${record.count}`
        : `${record.level} ${record.message}`,
    ),
    [
      "withheld unrecognised_structured 2",
      "error Gateway failed to start: gateway.bind=custom requires gateway.customBindHost",
      "warn config reloaded",
      "info listening",
    ],
  );
});

test("credential shapes outside key names are masked in messages and kept fields", () => {
  const password = `pw${randomString(14)}`;
  const hf = `hf_${randomString(34)}`;
  const stripe = `sk_live_${randomString(24)}`;
  const restricted = `rk_test_${randomString(24)}`;
  const basic = Buffer.from(`svc:${randomString(12)}`).toString("base64");
  const netrc = `n${randomString(15)}`;
  const serviceKey = randomBytes(16).toString("hex");
  const turn = `curl --user ops:${password} https://x.example.invalid`;
  const { records } = sanitize(
    agentStream,
    [
      `curl -u admin:${password} https://x.example.invalid`,
      `token ${hf} ${stripe} ${restricted}`,
      `Proxy auth Basic ${basic}`,
      `machine github.com login bob password ${netrc}`,
      `MY_SERVICE_KEY=${serviceKey}`,
      JSON.stringify({
        level: "warn",
        target: "codex_core::tools::parallel",
        fields: { message: "tool failed", turn_id: turn },
      }),
      JSON.stringify({ level: "warn", subsystem: "x", message: "m", code: stripe }),
      // Prose and identifiers stay readable.
      "basic authentication failed; see hf_hub_download and sort -u",
    ],
    { first: 1 },
  );
  const text = JSON.stringify(records);
  for (const value of [password, hf, stripe, restricted, basic, netrc, serviceKey]) {
    assert.equal(text.includes(value), false, `${value.slice(0, 6)}... leaked`);
  }
  assert.equal(
    records.at(-1).message,
    "basic authentication failed; see hf_hub_download and sort -u",
  );
  assert.match(records[0].message, /^curl -u \[redacted:argv\] https:/);
  assert.equal(records[4].message, "MY_SERVICE_KEY=[redacted:key-value]");
});

test("the wrapper's fixed plain-text failure line is a wrapper error, not unknown text", () => {
  const { records } = sanitize(
    agentStream,
    [
      "Harness model authentication probe failed.",
      "Harness model authentication probe failed. extra",
    ],
    { first: 1 },
  );
  assert.deepEqual(pick(records, ["kind", "level", "message"]), [
    { kind: "wrapper", level: "error", message: "Harness model authentication probe failed." },
    {
      kind: "text",
      level: "unknown",
      message: "Harness model authentication probe failed. extra",
    },
  ]);
});

const wrapperKeys = ["kind", "level", "message", "fields"];

test("a failed startup phase keeps its fixed cause code", () => {
  const { records } = sanitize(
    agentPodStream,
    [
      '{"event":"runtime.startup_phase","container":"agent","phase":"plugin-install","outcome":"failed","ms":60000,"sinceStartMs":62000,"code":"PLUGIN_NOT_IN_CATALOG"}',
    ],
    { first: 1 },
  );
  assert.deepEqual(pick(records, wrapperKeys), [
    {
      kind: "wrapper",
      level: "error",
      message: "runtime.startup_phase",
      fields: {
        container: "agent",
        phase: "plugin-install",
        outcome: "failed",
        ms: 60000,
        sinceStartMs: 62000,
        code: "PLUGIN_NOT_IN_CATALOG",
      },
    },
  ]);
});

test("a failed model probe keeps its closed-vocabulary cause, never other cause text", () => {
  const probe = (event, cause, extra) =>
    JSON.stringify({ event, elapsedMs: 2340, code: "MODEL_PROBE_FAILED", cause, ...extra });
  const { records, withheld } = sanitize(
    gatewayStream,
    [
      probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: "format" }),
      // The provider's HTTP status and known error code, never its text, are kept.
      probe(
        "codex.model_probe",
        { kind: "PROBE_STATUS", detail: "rate_limit" },
        {
          providerStatus: 429,
          providerCode: "usage_limit_reached",
          providerMessage: "You've hit your usage limit.",
        },
      ),
      probe("openclaw.model_probe", { kind: "WRAPPER_ERROR" }),
      // The upfront 401 reports which header names it saw and its body's shape and
      // closed-set error code and type; the Codex probe has none of these fields,
      // and provider text never passes.
      probe("openclaw.model_probe", undefined, {
        providerStatus: 401,
        providerCode: "missing_api_key",
        responseHeaderMarker: "provider-like",
        bodyShape: "json-error-code",
        providerErrorCode: "no_organization",
        providerErrorType: "invalid_request_error",
        providerMessage: "Missing bearer or basic authentication in header",
        error: { code: "no_organization", message: "sk-live-abc" },
        body: '{"error":{"message":"sk-live-abc"}}',
      }),
      probe("codex.model_probe", undefined, {
        responseHeaderMarker: "provider-like",
        bodyShape: "json-error-code",
        providerErrorCode: "no_organization",
        providerErrorType: "invalid_request_error",
      }),
      // Off-vocabulary details, unknown kinds and extra keys drop the cause, never the line.
      probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: "sk-live-abc" }),
      probe("openclaw.model_probe", { kind: "PROVIDER_TEXT" }),
      probe("codex.model_probe", { kind: "PROBE_STATUS", detail: "format", text: "x" }),
      probe("codex.model_probe", "PROBE_STATUS"),
      probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: 42 }),
      // Only a failed check carries a cause, and only probe records keep one.
      probe("codex.model_probe", { kind: "PROBE_STATUS", detail: "format" }, { code: "READY" }),
      JSON.stringify({
        event: "runtime.startup_phase",
        phase: "model-probe",
        outcome: "failed",
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROBE_STATUS", detail: "format" },
      }),
    ],
    { first: 1 },
  );
  assert.equal(withheld, 0);
  const fields = (event, cause = {}) => ({
    kind: "wrapper",
    level: "error",
    message: event,
    fields: { elapsedMs: 2340, code: "MODEL_PROBE_FAILED", ...cause },
  });
  assert.deepEqual(pick(records, wrapperKeys), [
    fields("openclaw.model_probe", { causeKind: "PROBE_STATUS", causeDetail: "format" }),
    fields("codex.model_probe", {
      providerStatus: 429,
      providerCode: "usage_limit_reached",
      causeKind: "PROBE_STATUS",
      causeDetail: "rate_limit",
    }),
    fields("openclaw.model_probe", { causeKind: "WRAPPER_ERROR" }),
    fields("openclaw.model_probe", {
      providerStatus: 401,
      providerCode: "missing_api_key",
      responseHeaderMarker: "provider-like",
      bodyShape: "json-error-code",
      providerErrorCode: "no_organization",
      providerErrorType: "invalid_request_error",
    }),
    fields("codex.model_probe"),
    fields("openclaw.model_probe"),
    fields("openclaw.model_probe"),
    fields("codex.model_probe"),
    fields("codex.model_probe"),
    fields("openclaw.model_probe"),
    {
      kind: "wrapper",
      level: "info",
      message: "codex.model_probe",
      fields: { elapsedMs: 2340, code: "READY" },
    },
    {
      kind: "wrapper",
      level: "error",
      message: "runtime.startup_phase",
      fields: { phase: "model-probe", outcome: "failed", code: "MODEL_PROBE_FAILED" },
    },
  ]);
});

// Finding 2017: a failed Codex login or model check names the class of Codex's error
// output. Only a value from the contract's closed list passes, and only on those events.
test("a failed Codex login or model check keeps its closed-list failure class, never other text", () => {
  const login = (failureClass) =>
    JSON.stringify({
      event: "runtime.startup_phase",
      container: "agent",
      phase: "codex-login",
      outcome: "failed",
      ms: 812,
      sinceStartMs: 900,
      failureClass,
    });
  const probe = (event, failureClass) =>
    JSON.stringify({
      event,
      elapsedMs: 2340,
      exitCode: 1,
      code: "MODEL_PROBE_FAILED",
      cause: { kind: "PROCESS_EXIT", detail: "exit-1" },
      failureClass,
    });
  const loginAttempt = (failureClass) =>
    JSON.stringify({ event: "codex.login", attempt: 1, elapsedMs: 640, exitCode: 1, failureClass });
  const { records, withheld } = sanitize(
    agentPodStream,
    [
      login("network"),
      probe("codex.model_probe", "http_5xx"),
      loginAttempt("network"),
      loginAttempt("Error: error sending request for url (https://auth.example.invalid/?a=b)"),
      // Off-list values, token-shaped text and non-strings are dropped, never the line.
      login("sk-proj-0123456789abcdefghijklmnop"),
      probe(
        "codex.model_probe",
        "error sending request for url (https://auth.example.invalid/?a=b)",
      ),
      probe("codex.model_probe", { class: "network" }),
      probe("codex.model_probe", "NETWORK"),
      // Other wrapper events never carry a class.
      probe("openclaw.model_probe", "network"),
    ],
    { first: 1 },
  );
  assert.equal(withheld, 0);
  const loginFields = (extra = {}) => ({
    kind: "wrapper",
    level: "error",
    message: "runtime.startup_phase",
    fields: {
      container: "agent",
      phase: "codex-login",
      outcome: "failed",
      ms: 812,
      sinceStartMs: 900,
      ...extra,
    },
  });
  const probeFields = (event, extra = {}) => ({
    kind: "wrapper",
    level: "error",
    message: event,
    fields: {
      elapsedMs: 2340,
      code: "MODEL_PROBE_FAILED",
      ...(event === "codex.model_probe" ? { exitCode: 1 } : {}),
      causeKind: "PROCESS_EXIT",
      causeDetail: "exit-1",
      ...extra,
    },
  });
  const loginAttemptFields = (extra = {}) => ({
    kind: "wrapper",
    level: "warn",
    message: "codex.login",
    fields: { attempt: 1, elapsedMs: 640, exitCode: 1, ...extra },
  });
  assert.deepEqual(pick(records, wrapperKeys), [
    loginFields({ failureClass: "network" }),
    probeFields("codex.model_probe", { failureClass: "http_5xx" }),
    loginAttemptFields({ failureClass: "network" }),
    loginAttemptFields(),
    loginFields(),
    probeFields("codex.model_probe"),
    probeFields("codex.model_probe"),
    probeFields("codex.model_probe"),
    probeFields("openclaw.model_probe"),
  ]);
  assert.doesNotMatch(JSON.stringify(records), /sk-proj|error sending|example\.invalid|NETWORK/);
});

test("a Gateway settings override keeps its setting names, never values (D322)", () => {
  const event = (settings) =>
    JSON.stringify({
      event: "runtime.gateway_settings_overridden",
      container: "gateway",
      settings,
    });
  const { records, withheld } = sanitize(
    gatewayStream,
    [
      event([
        "cron.triggers.enabled",
        "models.providers.codex.baseUrl",
        "models.providers.codex.apiKey",
        "models.providers.codex.models[].headers",
      ]),
      // An item that is not a key path drops the list, never the event.
      event(["cron.triggers.enabled", "models.providers.sk-live x"]),
      event("cron.triggers.enabled"),
    ],
    { first: 1 },
  );
  assert.equal(withheld, 0);
  const override = (fields) => ({
    kind: "wrapper",
    level: "warn",
    message: "runtime.gateway_settings_overridden",
    fields: { container: "gateway", ...fields },
  });
  assert.deepEqual(pick(records, wrapperKeys), [
    override({
      settings:
        "cron.triggers.enabled, models.providers.codex.baseUrl, models.providers.codex.apiKey, models.providers.codex.models[].headers",
    }),
    override(),
    override(),
  ]);
});

test("the sanitizer drops a partial final line and bounds oversized input", () => {
  const fragment = randomBytes(10).toString("hex");
  const partial = sanitize(gatewayStream, ["complete line", `partial ${fragment}`], {
    first: 1,
    truncated: true,
  });
  assert.deepEqual(
    partial.records.map((record) => record.message),
    ["complete line"],
  );
  const oversized = sanitize(
    gatewayStream,
    [`plain ${"x".repeat(5 * 1024)}`, `{"level":"info","message":"${"y".repeat(33 * 1024)}"}`],
    { first: 1 },
  );
  assert.deepEqual(pick(oversized.records, ["type", "reason", "count"]), [
    { type: "withheld", reason: "oversized", count: 2 },
  ]);
  const long = sanitize(
    gatewayStream,
    [`{"level":"info","subsystem":"gateway","message":"${"z ".repeat(6000)}"}`],
    { first: 1 },
  );
  assert.equal(long.records[0].truncated, true);
  assert.ok(Buffer.byteLength(long.records[0].message) <= 8 * 1024);
  assert.match(long.records[0].message, /…\[truncated\]$/);
});

// Line messages, and withheld runs as `withheld <count>`.
function withheldSummary(page) {
  return page.records.map((record) =>
    record.type === "withheld" ? `withheld ${record.count}` : record.message,
  );
}

test("pretty-printed JSON is withheld as one run, not shown line by line", () => {
  const prompt = `prompt-canary-${randomUUID()}`;
  const element = `element-canary-${randomUUID()}`;
  const tail = `tail-canary-${randomUUID()}`;
  const result = sanitize(agentPodStream, [
    "setup starting",
    "{",
    '  "event": "setup",',
    `  "prompt": "${prompt} {not a brace",`,
    '  "attempts": [',
    `    "${element}",`,
    "    42",
    "  ],",
    '  "ok": true',
    "}",
    '{"event":"runtime.startup_phase","container":"agent","phase":"node-setup","outcome":"ok","ms":5,"sinceStartMs":9}',
    "node host connected",
  ]);
  const body = JSON.stringify(result);
  assert.equal(body.includes(prompt), false, "a pretty-printed prompt value leaked");
  assert.equal(body.includes(element), false, "a pretty-printed array element leaked");
  assert.deepEqual(
    result.records.map((record) =>
      record.type === "withheld" ? `withheld ${record.reason} ${record.count}` : record.message,
    ),
    ["setup starting", "withheld malformed 9", "runtime.startup_phase", "node host connected"],
  );

  // A page that starts inside a value has no `{` line; its members are still withheld.
  const midValue = sanitize(agentPodStream, [
    `    "prompt": "${tail}",`,
    '    "n": 1',
    "  }",
    "}",
    "after",
  ]);
  assert.equal(JSON.stringify(midValue).includes(tail), false, "a mid-value member leaked");
  assert.deepEqual(withheldSummary(midValue), ["withheld 3", "}", "after"]);

  // An unclosed `{` does not swallow the plain text that follows it.
  const stray = sanitize(agentPodStream, ["{ unbalanced", "plain text resumes"]);
  assert.deepEqual(
    stray.records.map((record) => (record.type === "withheld" ? record.type : record.message)),
    ["withheld", "plain text resumes"],
  );

  // A bracket-tagged text line ends an open block instead of reading as its continuation.
  const tagged = sanitize(agentPodStream, ["{ x", "[node-host] advertised commands: a, b"]);
  assert.deepEqual(withheldSummary(tagged), [
    "withheld 1",
    "[node-host] advertised commands: a, b",
  ]);
});

test("a PEM block printed over several lines is masked on every line", () => {
  const body = randomBytes(48).toString("base64");
  const tail = `PEMTAIL${randomString(12)}`;
  const header = `DEK-Info: AES-128-CBC,${randomBytes(8).toString("hex").toUpperCase()}`;
  const shown = (raws) => sanitize(gatewayStream, raws).records.map((record) => record.message);
  assert.deepEqual(
    shown([
      "before the key",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      header,
      "",
      body,
      tail,
      "-----END ENCRYPTED PRIVATE KEY----- after the key",
      "ordinary line",
    ]),
    [
      "before the key",
      "[redacted:pem]",
      "[redacted:pem]",
      "[redacted:pem]",
      "[redacted:pem]",
      "[redacted:pem]",
      "[redacted:pem] after the key",
      "ordinary line",
    ],
  );

  // A page that starts inside a block has no BEGIN line; the END line and the body
  // lines directly above it are masked.
  assert.deepEqual(shown(["page start", body, tail, "-----END PRIVATE KEY-----", "next"]), [
    "page start",
    "[redacted:pem]",
    "[redacted:pem]",
    "[redacted:pem]",
    "next",
  ]);

  // A BEGIN marker quoted in prose ends at the first line that is not PEM-shaped.
  assert.deepEqual(
    shown(["expected a -----BEGIN CERTIFICATE----- header", "retrying in 5s", "done"]),
    ["expected a [redacted:pem]", "retrying in 5s", "done"],
  );

  // Continuation lines are workload-controlled plain text up to 32 KiB each.
  for (const unit of [" ", "a", "A:", "A: ", "-----BEGIN A-----", "-----END A-----"]) {
    const hostile = unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - 1);
    for (const suffix of ["!", " x"]) {
      const budgetMs = 400;
      const elapsed = cpuTimeMs(
        () =>
          sanitize(gatewayStream, [
            "-----BEGIN X-----",
            hostile + suffix,
            hostile + suffix,
            "-----END X-----",
          ]),
        { budgetMs },
      );
      assert.ok(elapsed < budgetMs, `${JSON.stringify(unit)} took ${elapsed.toFixed(0)} ms of CPU`);
    }
  }
});

test("the sanitizer keeps bracket-tagged text lines but withholds malformed JSON arrays", () => {
  const canary = `array-canary-${randomUUID()}`;
  const tagged = [
    "[node-host] advertised commands: dir.list, file.create, file.fetch",
    "[DF3-P10] bracket-prefixed operational line",
    "[gateway/ws] reconnecting",
    "[plugins]",
  ];
  const arrays = [
    "[",
    `["${canary}",`,
    `[{"role":"user","text":"${canary}"}`,
    `[ "${canary}" ] trailing`,
    `[null, "${canary}"`,
    `[true] ${canary}`,
    `[${canary}`,
  ];
  const page = sanitize(agentPodStream, [...tagged, ...arrays]);
  assert.deepEqual(
    page.records.map(({ type, kind, message, reason, count }) =>
      type === "line" ? { kind, message } : { reason, count },
    ),
    [
      ...tagged.map((message) => ({ kind: "text", message })),
      { reason: "malformed", count: arrays.length },
    ],
  );
  assert.equal(JSON.stringify(page).includes(canary), false);
});

// The redactor runs synchronously on workload-controlled lines of up to 32 KiB, before
// the 8 KiB output cut. A pattern that backtracks quadratically on such a line would stall
// the API replica's event loop for every caller, so each hostile shape has a budget.
function redactionCpuMs(input, budgetMs) {
  return cpuTimeMs(
    () => {
      redactRuntimeLogText(input);
      maskRuntimeEventText(input);
    },
    { budgetMs },
  );
}

test("redaction stays linear on hostile 32 KiB lines", () => {
  const budgetMs = 100;
  const line = (unit, suffix = "") =>
    unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - suffix.length) + suffix;
  redactRuntimeLogText(line("warm-up "));
  maskRuntimeEventText(line("warm-up "));
  const units = ["a-", "a.", "-", "--a-", "=/", "(/", '"a-', "a0a", "tokena-", "bearer "];
  units.push("-eyJa", "-eyJ_", "_eyJa", "-eyJa-", "-eyJaaaa");
  for (const unit of units) {
    for (const suffix of ["", "?", "token", "=x"]) {
      const elapsed = redactionCpuMs(line(unit, suffix), budgetMs);
      assert.ok(
        elapsed < budgetMs,
        `${JSON.stringify(unit)} + ${JSON.stringify(suffix)} took ${elapsed.toFixed(0)} ms of CPU`,
      );
    }
  }
  // A whole page of such messages stays well inside one request's budget.
  const page = Array.from({ length: 50 }, () =>
    JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
  );
  const elapsed = cpuTimeMs(() => sanitize(gatewayStream, page), { budgetMs: 50 * budgetMs });
  assert.ok(elapsed < 50 * budgetMs, `50 hostile lines took ${elapsed.toFixed(0)} ms of CPU`);
});

test("redaction stays linear on a generated sweep of short repeated units", () => {
  // Guards shapes nobody enumerated: every unit of 2 characters over an alphabet of
  // pattern delimiters and prefix letters, every 3-character unit over a smaller one, and
  // each delimiter ahead of the JWT, token and bearer prefixes.
  const budgetMs = 100;
  const alphabet = [...'a-.=/?":_+@eyJtokn '];
  const short = [...'a-.=/"_eJ '];
  const units = [];
  for (const x of alphabet) {
    units.push(...alphabet.map((y) => x + y));
  }
  for (const x of short) {
    for (const y of short) {
      units.push(...short.map((z) => x + y + z));
    }
  }
  for (const x of alphabet) {
    units.push(`${x}eyJ`, `${x}eyJa`, `${x}eyJa.`, `${x}token`, `${x}bearer`);
  }
  const length = 32 * 1024;
  redactRuntimeLogText("warm-up ".repeat(length / 8));
  let worst = { unit: "", elapsed: 0 };
  const started = performance.now();
  for (const unit of units) {
    const input = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const elapsed = redactionCpuMs(input, budgetMs);
    if (elapsed > worst.elapsed) {
      worst = { unit, elapsed };
    }
  }
  const total = performance.now() - started;
  assert.ok(
    worst.elapsed < budgetMs,
    `${JSON.stringify(worst.unit)} took ${worst.elapsed.toFixed(0)} ms of CPU (sweep total ${total.toFixed(0)} ms)`,
  );
});

test("the jwt rule masks tokens in every delimiter context but not inside a longer word", () => {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${base64url({ alg: "HS256" })}.${base64url({ sub: randomUUID() })}.${randomString(43)}`;
  for (const [before, after] of [
    ["", ""],
    ["token ", " next"],
    ["auth=", "&x=1"],
    ['{"t":"', '"}'],
    ["(", ")"],
    ["/", "/"],
    [":", ","],
  ]) {
    const output = redactRuntimeLogText(`${before}${jwt}${after}`);
    assert.ok(!output.includes(jwt), `${JSON.stringify(before)} context leaked the token`);
    assert.match(output, /\[redacted:/);
  }
  // `-` and `.` are word boundaries inside a run; a word character ahead of `eyJ` is not.
  for (const [input, expected] of [
    [`x-token-${jwt} next`, "x-token-[redacted:jwt] next"],
    [`a.${jwt}.b`, "a.[redacted:jwt].b"],
    [`${jwt}.${jwt}`, "[redacted:jwt].[redacted:jwt]"],
    ["xeyJabcd.efgh.ij", "xeyJabcd.efgh.ij"],
  ]) {
    assert.equal(redactRuntimeLogText(input), expected);
  }
});

test("the linear jwt scan matches the reference regex on random runs", () => {
  const reference = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
  const pieces = ["eyJ", "a", "b", "-", ".", "_", "0", " ", "/", "e", "J"];
  for (let round = 0; round < 3000; round += 1) {
    const input = Array.from(
      { length: randomInt(1, 13) },
      () => pieces[randomInt(pieces.length)],
    ).join("");
    const expected = input.replace(reference, "[redacted:jwt]");
    // Only the jwt rule can fire here: no key names or URLs, and at most 12 pieces of up
    // to 3 characters each (randomInt excludes its upper bound), so 36 characters at most.
    assert.equal(redactRuntimeLogText(input), expected, JSON.stringify(input));
  }
});

test("bounded key and path patterns still mask the shapes they did before", () => {
  // The digit keeps the value inside the digit-gated `bearer` rule on every run.
  const value = `v7${randomString(20)}`;
  for (const [input, expected] of [
    [`github_token=${value} next`, "github_token=[redacted:key-value] next"],
    [`--db-password ${value}`, "--db-password [redacted:key-value]"],
    [`--api-key=${value}`, "--api-key=[redacted:key-value]"],
    [`spring.datasource.password: ${value}`, "spring.datasource.password: [redacted:key-value]"],
    // A key prefix longer than the affix bound still masks: the match starts at the keyword.
    [`${"x".repeat(100)}_password=${value}`, `${"x".repeat(100)}_password=[redacted:key-value]`],
    [`{"client_secret":"${value}"}`, '{"client_secret":"[redacted:key-value]"}'],
    [
      `GET /hooks?token=${value}&a=1 HTTP/1.1`,
      "GET /hooks?token=[redacted:query]&a=[redacted:query] HTTP/1.1",
    ],
    [`url=/cb?code=${value}`, "url=/cb?code=[redacted:query]"],
    [`call(/cb?code=${value}`, "call(/cb?code=[redacted:query]"],
    [`"/cb?${value}"`, '"/cb?[redacted:query]"'],
    ["see /a#b?c", "see /a#b?c"],
    [`bearer token ${value} for upstream`, "bearer token [redacted:bearer] for upstream"],
    ["bearer authentication failed", "bearer authentication failed"],
  ]) {
    assert.equal(redactRuntimeLogText(input), expected, input);
  }
});

test("rule prefilters skip only text a rule cannot change", () => {
  for (const [input, expected] of [
    // Long-token rules run only on a 40-character run of their joint alphabet.
    [`k=${"Ab1x".repeat(9)}Ab1`, `k=${"Ab1x".repeat(9)}Ab1`],
    [`k=${"Ab1x".repeat(10)}`, "k=[redacted:long-token]"],
    // A joint run of 40 that is no single rule's run of 40 stays.
    [`k=${"Ab1+".repeat(5)}${"Ab1_".repeat(5)}`, `k=${"Ab1+".repeat(5)}${"Ab1_".repeat(5)}`],
    [`${"A1".repeat(20)}==${"B2".repeat(20)}`, "[redacted:long-token][redacted:long-token]"],
    [`x${"a1B_".repeat(10)} eyJ, a://b, why?`, "[redacted:long-token] eyJ, a://b, why?"],
  ]) {
    assert.equal(redactRuntimeLogText(input), expected, input);
  }
  // Every character of either long-token alphabet counts toward the 40-character run.
  for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-") {
    assert.equal(
      redactRuntimeLogText(`k=${`Ab1${character}`.repeat(10)}`),
      "k=[redacted:long-token]",
      character,
    );
  }
  assert.equal(
    stripRuntimeLogControls(
      "a\tb\u0000c\u001b[31md\u001b[0m\u007fe\u0085f\u009fg\u00a0h🙂\ud800\u2028",
    ),
    "a bcdefg\u00a0h🙂\ud800\u2028",
  );
  for (const [input, expected] of [
    ["/usr/local/bin/redis-cli -a pw1", "/usr/local/bin/redis-cli -a [redacted:argv]"],
    // A client name inside a longer token names no client.
    ["redis-cli-wrapper -a pw2", "redis-cli-wrapper -a pw2"],
    ["echo mysql; ls -pfoo", "echo mysql; ls -pfoo"],
    ["sudo mysql -uroot -ppw3", "sudo mysql -uroot -p[redacted:argv]"],
  ]) {
    assert.equal(redactArgvCredentials(input), expected, input);
  }
});

test("Event messages hide node names, image references and Secret names", async () => {
  const node = `ip-10-0-${randomInt(255)}-${randomInt(255)}.ec2.internal`;
  const image = `registry.example.com/team-${randomString(8).toLowerCase()}/gateway:1.2.3`;
  const secret = `db-creds-${randomString(8).toLowerCase()}`;
  const messages = [
    `Successfully assigned tenant/gateway-0 to ${node}`,
    `Pulling image "${image}"`,
    `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to resolve reference "${image}": not found`,
    `Error: pull access denied for ${image}, repository does not exist`,
    `MountVolume.SetUp failed for volume "creds" : secret "${secret}" not found`,
    `Error: couldn't find key password in Secret tenant/${secret}`,
    `configmap "${secret}" not found`,
    `Preempted by a higher priority Pod on node ${node}`,
    `nodes "${node}" not found`,
  ];
  for (const message of messages) {
    const masked = maskRuntimeEventText(message);
    for (const name of [node, image, secret]) {
      assert.equal(masked.includes(name), false, `${name} survived in ${masked}`);
    }
  }
  assert.equal(
    maskRuntimeEventText("Back-off restarting failed container gateway in pod gateway-0"),
    "Back-off restarting failed container gateway in pod gateway-0",
  );

  // The Tier 1 route applies the masking to every Event message.
  const route = await logsRoute();
  route.state.events = messages.map((message) => ({
    type: "Warning",
    reason: "Failed",
    message,
    count: 1,
    lastObservedAt: "2026-09-30T11:59:00Z",
  }));
  const runtime = await route.get(route.target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.data.pods[0].events.length, messages.length);
  for (const name of [node, image, secret]) {
    assert.equal(runtime.text.includes(name), false, `${name} reached the runtime route`);
  }
  assert.match(runtime.data.pods[0].events[0].message, /to \[redacted:node\]$/);
});

test("Codex span lifecycle records: turns are info events, other spans are debug, no span payload leaves", () => {
  const canary = `codex-span-canary-${randomUUID()}`;
  const tracing = (target, fields, span) =>
    JSON.stringify({
      timestamp: "2026-10-01T07:49:44.100970Z",
      level: "INFO",
      fields,
      target,
      ...(span === undefined ? {} : { span, spans: [] }),
    });
  // Field names follow Codex 0.158's `turn` span (codex_core::tasks) and tool-call event.
  const turn = {
    name: "turn",
    "otel.name": "session_task.turn",
    "thread.id": canary,
    "turn.id": "turn-1",
    model: "gpt-5.6-luna",
    "codex.turn.reasoning_effort": "medium",
    prompt: canary,
  };
  const closed = {
    ...turn,
    "codex.turn.token_usage.input_tokens": 1200,
    "codex.turn.token_usage.output_tokens": 80,
    "codex.turn.token_usage.total_tokens": 1280,
  };
  const { records } = sanitize(
    agentStream,
    [
      tracing("codex_core::tasks", { message: "new" }, turn),
      tracing("codex_core::tasks", { message: "enter" }, turn),
      tracing("codex_core::tasks", { message: "exit" }, turn),
      tracing("codex_core::tools::parallel", {
        message: "tool call completed",
        tool_name: "shell",
        turn_id: "turn-1",
        call_id: canary,
        total_duration_ms: 42,
        arguments: canary,
      }),
      tracing(
        "codex_core::tasks",
        { message: "close", "time.busy": "2.1s", "time.idle": "9ms" },
        closed,
      ),
      tracing(
        "codex_exec_server::local_file_system",
        { message: "close", "time.busy": "35µs" },
        { name: "fs.read_file", path: canary },
      ),
      tracing("codex_core::client", { message: "new" }, { name: `${canary} x` }),
      // A plain event whose message happens to be a lifecycle word is not a span record.
      tracing("codex_core::client", { message: "close" }),
    ],
    { first: 1 },
  );
  const codex = (level, message, subsystem, fields) => ({
    kind: "codex",
    level,
    message,
    subsystem,
    ...(fields === undefined ? {} : { fields }),
  });
  assert.deepEqual(
    records.map(({ kind, level, message, subsystem, fields }) => ({
      kind,
      level,
      message,
      subsystem,
      ...(fields === undefined ? {} : { fields }),
    })),
    [
      codex("info", "turn started", "codex_core::tasks", {
        model: "gpt-5.6-luna",
        turn_id: "turn-1",
      }),
      codex("debug", "span enter turn", "codex_core::tasks"),
      codex("debug", "span exit turn", "codex_core::tasks"),
      codex("info", "tool call completed", "codex_core::tools::parallel", {
        tool_name: "shell",
        turn_id: "turn-1",
        total_duration_ms: 42,
      }),
      codex("info", "turn completed", "codex_core::tasks", {
        model: "gpt-5.6-luna",
        turn_id: "turn-1",
        input_tokens: 1200,
        output_tokens: 80,
        total_tokens: 1280,
        busy: "2.1s",
      }),
      codex("debug", "span close fs.read_file", "codex_exec_server::local_file_system"),
      codex("debug", "span new span", "codex_core::client"),
      codex("info", "Codex message withheld", "codex_core::client"),
    ],
  );
  assert.equal(JSON.stringify(records).includes(canary), false, "no span payload or call ID leaks");
});

// Controlled Driver output; the reader, authenticated cursor and sanitizer are real.
// These source tests do not qualify a Kubernetes/provider deployment.
function pollReader({ secret = randomBytes(32).toString("hex") } = {}) {
  const binding = {
    principalId: "synthetic-person",
    agentId: "agent-test",
    revisionId: "revision-test",
    source: "gateway",
  };
  const pod = {
    name: "gateway-test-0",
    uid: "synthetic-pod-0",
    container: "gateway",
    restartCount: 0,
  };
  const codec = createRuntimeLogCursorCodec(secret);
  let cursor;
  let reads = 0;
  let admissions = 0;
  const requests = [];
  const now = Date.parse("2026-09-30T12:10:00Z");
  return {
    codec,
    binding,
    requests,
    get cursor() {
      return cursor;
    },
    // The signed position of the current cursor.
    get position() {
      return codec.decode(cursor, binding).position;
    },
    get reads() {
      return reads;
    },
    get admissions() {
      return admissions;
    },
    async poll(lines, options = {}) {
      const selected = { ...pod, ...options.pod };
      const description = {
        revisionId: binding.revisionId,
        sources: [{ id: "gateway", kind: "container", available: true, pods: [selected] }],
      };
      const result = await readRuntimeLogPage({
        description,
        query: { source: "gateway", previous: false, tailLines: 1000, cursor, ...options.query },
        codec,
        binding: options.binding ?? binding,
        signal: new AbortController().signal,
        now: () => now + (options.elapsed ?? 0),
        admitView: async () => {
          admissions += 1;
        },
        readLogs: async (request) => {
          reads += 1;
          requests.push(request);
          return {
            stream: {
              source: "gateway",
              pod: selected.name,
              podUid: selected.uid,
              container: "gateway",
              restartCount: selected.restartCount,
              ...options.stream,
            },
            lines,
            truncated: options.truncated ?? false,
          };
        },
      });
      cursor = result.cursor;
      return result;
    },
    // The messages of the delivered lines.
    async shown(lines, options) {
      return messages(await this.poll(lines, options));
    },
  };
}
// A view that has delivered a PEM BEGIN line at second 0.
async function pemOpenReader() {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  return reader;
}
const pemBegin = "-----BEGIN PRIVATE KEY-----";
const pemEnd = "-----END PRIVATE KEY-----";
const syntheticPemTail = Buffer.from("synthetic-tail-data").toString("base64");
function timedLog(raw, second) {
  return {
    raw,
    time:
      second === null
        ? null
        : new Date(Date.parse("2026-09-30T12:00:00Z") + second * 1000).toISOString(),
  };
}
function messages(page) {
  return page.records.filter((record) => record.type === "line").map((record) => record.message);
}
// Gap reasons and line messages, in page order.
function summary(page) {
  return page.records.map((record) => record.reason ?? record.message);
}
function assertTailMasked(page) {
  assert.equal(JSON.stringify(page.records).includes(syntheticPemTail), false);
  assert.ok(messages(page).some((message) => message.includes("[redacted:pem]")));
}
function assertTailShown(page) {
  assert.ok(messages(page).includes(syntheticPemTail));
}
// Lines larger than the page budget leaves for them: 70 of these cut a page.
function largeDiagnostics(count, firstSecond) {
  return Array.from({ length: count }, (_, i) =>
    timedLog(gatewayJson("ordinary diagnostic ".repeat(500)), firstSecond + i),
  );
}
function workers(count, second = 0) {
  return Array.from({ length: count }, (_, index) => timedLog(`worker ${index} ready`, second));
}
const retrying = (second) => timedLog("retrying in 5s", second);

test("runtime log cursor carries PEM context over three polls and empty polls", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0), timedLog(randomBytes(48).toString("base64"), 1)]);
  const beforeEmpty = reader.position;
  await reader.poll([]);
  const afterEmpty = reader.position;
  assert.equal(afterEmpty.pemOpen, beforeEmpty.pemOpen);
  assert.equal(afterEmpty.pemAfterTime, beforeEmpty.pemAfterTime);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
  const final = await reader.poll([timedLog(pemEnd, 3), retrying(4)]);
  assert.ok(messages(final).includes("retrying in 5s"));
  assertTailShown(await reader.poll([timedLog(syntheticPemTail, 5)]));
  assert.equal(reader.admissions, 1);
});

test("a cursor from a page with no lines reads only output newer than that page", async () => {
  const reader = pollReader();
  // `occ agent logs --since 1m --follow` on a quiet container: the first page is empty.
  await reader.poll([], { query: { sinceSeconds: 60 } });
  // Follow polls send only the cursor; the read must not fall back to the whole tail.
  await reader.poll([], { elapsed: 4_000 });
  await reader.poll([], { elapsed: 9_000 });
  assert.deepEqual(
    reader.requests.map(({ sinceSeconds }) => sinceSeconds),
    [60, 6, 7],
  );
  // The first line the view sees is delivered once, and a full tail is labelled.
  const burst = Array.from({ length: 3 }, (_, i) => timedLog(`retrying in ${i}s`, 600 + i));
  const full = await reader.poll(burst, { elapsed: 10_000, query: { tailLines: 3 } });
  assert.deepEqual(summary(full), [
    "window_exceeded",
    "retrying in 0s",
    "retrying in 1s",
    "retrying in 2s",
  ]);
  const again = await reader.poll(burst, { elapsed: 11_000 });
  assert.deepEqual(messages(again), []);
  assert.equal(reader.admissions, 1);

  // A burst of long lines on another quiet view: the Driver applies the tail before
  // its byte cut, so a cut page holds fewer than `tailLines` lines but may still
  // have lost the oldest lines of the burst.
  const cutReader = pollReader();
  await cutReader.poll([], { query: { sinceSeconds: 60 } });
  const cut = await cutReader.poll(
    [timedLog("retrying in 600s", 600), timedLog("retrying in 601s", 601), timedLog("retr", 602)],
    { elapsed: 10_000, truncated: true, query: { tailLines: 5 } },
  );
  assert.deepEqual(summary(cut), [
    "window_exceeded",
    "retrying in 600s",
    "retrying in 601s",
    "truncated",
  ]);
});

test("a resumed page cut by the byte limit still reports lines lost before it", async () => {
  const reader = pollReader();
  await reader.poll([timedLog("retrying in 0s", 0), timedLog("retrying in 1s", 1)]);
  // A burst of long lines: the tail dropped second 1, then the byte limit cut the page
  // to fewer than `tailLines` lines, ending in a partial line.
  const cut = await reader.poll(
    [timedLog("retrying in 600s", 600), timedLog("retrying in 601s", 601), timedLog("retr", 602)],
    { elapsed: 600_000, truncated: true },
  );
  assert.deepEqual(summary(cut), [
    "window_exceeded",
    "retrying in 600s",
    "retrying in 601s",
    "truncated",
  ]);
  // A cut page that still re-reads the last delivered line lost nothing before it.
  const overlap = await reader.poll(
    [timedLog("retrying in 601s", 601), timedLog("retrying in 700s", 700), timedLog("retr", 701)],
    { elapsed: 700_000, truncated: true },
  );
  assert.deepEqual(summary(overlap), ["retrying in 700s", "truncated"]);
  // One line longer than the byte limit fills the page; its leading time still dates the
  // loss, and the view skips past it (one gap, not a "request fewer lines" truncation).
  const single = await reader.poll([timedLog("retr", 900)], {
    elapsed: 900_000,
    truncated: true,
  });
  assert.deepEqual(
    single.records.map((record) => [record.reason ?? record.message, record.time]),
    [["window_exceeded", timedLog("", 900).time]],
  );
});

test("a resumed view moves past a line longer than the read limit", async () => {
  const reader = pollReader();
  const gaps = (page) =>
    page.records
      .filter((record) => record.type === "gap")
      .map(({ reason, time, remedy }) => ({ reason, time, remedy }));
  // The view delivers second 0 with a PEM block open; `now` is second 600.
  await reader.poll([timedLog(pemBegin, 0)]);
  // Every resumed read starts before the cursor time, so it re-reads the overlap line and
  // then a line over 1 MiB fills the byte limit: nothing new is delivered.
  const stuck = [timedLog(pemBegin, 0), timedLog("retr", 599)];
  // Within about 3 s of the read the view stays put; the gap does not ask for fewer lines.
  const recent = await reader.poll(stuck, { elapsed: 1_000, truncated: true });
  assert.deepEqual(
    gaps(recent).map(({ reason }) => reason),
    ["truncated"],
  );
  assert.match(gaps(recent)[0].remedy, /longer than the rest of the 1 MiB read limit/);
  assert.equal(reader.position.lastTime, timedLog("", 0).time);
  // Once the line is older than where the next read starts, the view skips past it and
  // says that lines were lost behind it.
  const skipped = await reader.poll(stuck, { elapsed: 3_000, truncated: true });
  assert.deepEqual(
    gaps(skipped).map(({ reason, time }) => [reason, time]),
    [["window_exceeded", timedLog("", 599).time]],
  );
  assert.match(gaps(skipped)[0].remedy, /longer than the rest of the 1 MiB read limit/);
  assert.doesNotMatch(JSON.stringify(skipped.records), /fewer lines/);
  const position = reader.position;
  assert.equal(position.lastTime, null);
  // The cursor cannot keep a delivered PEM frontier, so the open block stays masked.
  assert.equal(position.pemOpen, true);
  assert.equal(position.pemAfterTime, null);
  // The next read starts from the previous read, past the oversized line, not from second 0.
  const next = await reader.poll(
    [timedLog(syntheticPemTail, 604), timedLog("retrying in 604s", 604)],
    { elapsed: 5_000 },
  );
  assert.equal(reader.requests.at(-1).sinceSeconds, 4);
  assertTailMasked(next);
  assert.ok(messages(next).includes("retrying in 604s"));
  assert.deepEqual(gaps(next), []);
  // Resume after small lines is unchanged: overlap de-duplication, and a byte cut after a
  // new line keeps the cursor on that line with the usual remedy.
  const resumed = await reader.poll(
    [timedLog("retrying in 604s", 604), timedLog("retrying in 606s", 606), timedLog("retr", 607)],
    { elapsed: 7_000, truncated: true },
  );
  assert.equal(reader.requests.at(-1).sinceSeconds, 5);
  assert.deepEqual(summary(resumed), ["retrying in 606s", "truncated"]);
  assert.match(gaps(resumed)[0].remedy, /Request fewer lines/);
  assert.equal(reader.position.lastTime, timedLog("", 606).time);
  assert.equal(reader.admissions, 1);
});

test("a resumed view skips a stalled read only when every poll would stall", async () => {
  const reader = pollReader();
  const stalls = (page) =>
    page.records.map((record) => [
      record.reason ?? record.message,
      ...(record.type === "gap" ? [/fewer lines/.test(record.remedy)] : []),
    ]);
  // `now` is second 600; the view has delivered second 596.
  await reader.poll([timedLog("retrying in 590s", 590), timedLog("retrying in 596s", 596)]);
  // A line older than the overlap every read covers is re-read only on some polls, so a
  // later poll may get past the cut: keep the frontier and the usual remedy.
  const partial = await reader.poll(
    [timedLog("retrying in 593s", 593), timedLog("retrying in 596s", 596), timedLog("retr", 606)],
    { elapsed: 8_000, truncated: true },
  );
  assert.deepEqual(stalls(partial), [["truncated", true]]);
  assert.equal(reader.position.lastTime, timedLog("", 596).time);
  // Exactly at the guard the view stays put.
  const atGuard = await reader.poll([timedLog("retrying in 596s", 596), timedLog("retr", 605)], {
    elapsed: 8_000,
    truncated: true,
  });
  assert.deepEqual(stalls(atGuard), [["truncated", false]]);
  assert.equal(reader.position.lastTime, timedLog("", 596).time);
  // A cut line at the cursor time also stalls every poll; untimed lines are not progress.
  const sameTime = await reader.poll(
    [timedLog("retrying in 596s", 596), timedLog("untimed", null), timedLog("retr", 596)],
    { elapsed: 8_001, truncated: true },
  );
  assert.deepEqual(stalls(sameTime), [["untimed"], ["window_exceeded", false]]);
  assert.equal(sameTime.records.at(-1).time, timedLog("", 596).time);
  assert.equal(reader.position.lastTime, null);

  // A stream replaced during the read is not a stalled read.
  const replaced = pollReader();
  await replaced.poll([timedLog("retrying in 0s", 0)]);
  const page = await replaced.poll([timedLog("retr", 500)], {
    elapsed: 2_000,
    truncated: true,
    stream: { restartCount: 1 },
  });
  assert.deepEqual(stalls(page), [
    ["stream_replaced", false],
    ["truncated", true],
  ]);
});

test("runtime log cursor does not let an evicted same-time old END erase a later BEGIN", async () => {
  const reader = pollReader();
  const overlap = [
    pemEnd,
    ...Array.from({ length: 20 }, (_, i) => `retrying worker ${i}`),
    pemBegin,
  ].map((raw) => timedLog(raw, 0));
  await reader.poll(overlap);
  // END was evicted from the 16 retained hashes; BEGIN is deduplicated. Neither
  // replayed END nor another unseen same-time line proves forward progress.
  assertTailMasked(await reader.poll([...overlap, timedLog(syntheticPemTail, 0)]));
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 1)]));
  await reader.poll([timedLog(pemEnd, 2)]);
  assertTailShown(await reader.poll([timedLog(syntheticPemTail, 3)]));
});

test("runtime log cursor retains uncertain context after an untimestamped BEGIN", async () => {
  const reader = pollReader();
  await reader.poll([timedLog("started worker", 0), timedLog(pemBegin, null)]);
  const page = await reader.poll([
    timedLog(pemEnd, 1),
    retrying(2),
    timedLog(syntheticPemTail, null),
  ]);
  assertTailMasked(page);
  assert.ok(messages(page).includes("retrying in 5s"));
});

test("runtime log cursor ignores an undelivered byte-cut END", async () => {
  const reader = await pemOpenReader();
  assertTailMasked(
    await reader.poll([timedLog(syntheticPemTail, 1), timedLog(pemEnd, 2)], { truncated: true }),
  );
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 3)]));
});

test("runtime log cursor context stops at the page byte bound before a future END", async () => {
  const reader = pollReader();
  const page = await reader.poll([
    timedLog(pemBegin, 0),
    ...largeDiagnostics(70, 1),
    timedLog(pemEnd, 72),
  ]);
  assert.equal(page.truncated, true);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 100)]));
});

test("runtime log cursor verifies context authentication before any Driver read", async () => {
  const reader = await pemOpenReader();
  const parts = reader.cursor.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
  payload.po = false;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const before = reader.reads;
  for (const options of [
    { query: { cursor: parts.join(".") } },
    { binding: { ...reader.binding, principalId: "other-person" } },
  ]) {
    await assert.rejects(reader.poll([], options), { reason: "cursor_invalid" });
    assert.equal(reader.reads, before);
  }
});

test("runtime log cursor context resets for changed stream, view, expiry and mid-read replacement", async (t) => {
  for (const [name, options] of [
    ["pod UID", { pod: { uid: "new-pod" } }],
    ["restart", { pod: { restartCount: 1 } }],
    ["pod choice", { pod: { name: "gateway-test-1" }, query: { pod: "gateway-test-1" } }],
    ["previous instance", { query: { previous: true } }],
    ["new view", { query: { cursor: undefined } }],
    ["expired", { elapsed: RUNTIME_LOG_CURSOR_TTL_MS + 1 }],
    ["mid-read UID", { stream: { podUid: "new-pod" } }],
    ["mid-read restart", { stream: { restartCount: 1 } }],
  ]) {
    await t.test(name, async () => {
      const reader = await pemOpenReader();
      // A new/unknown tail cannot infer a BEGIN from the old stream/view.
      assertTailShown(await reader.poll([timedLog(syntheticPemTail, 1)], options));
    });
  }
});

// The same polls through the controller's logs route: the cursor is serialized and
// parsed again on every request.
async function runtimeLogRoutePoller() {
  const route = await logsRoute();
  let cursor;
  let response;
  return {
    startView() {
      cursor = undefined;
    },
    // The last response, with its headers and serialized text.
    get response() {
      return response;
    },
    async poll(lines, { tailLines = "1000", truncated = false } = {}) {
      route.state.lines = lines;
      route.state.truncated = truncated;
      response = await route.read({ tailLines, cursor });
      assert.equal(response.status, 200, response.text);
      assert.equal(typeof response.data.cursor, "string");
      cursor = response.data.cursor;
      return response.data;
    },
    async shown(lines, options) {
      return messages(await this.poll(lines, options));
    },
  };
}

test("runtime log route polling preserves identical same-time line occurrences", async () => {
  const reader = await runtimeLogRoutePoller();
  const repeated = retrying(0);
  // The Driver contract supplies raw lines without requiring unique timestamps.
  // A later poll must subtract the two delivered occurrences, not all equal text.
  assert.deepEqual(await reader.shown([repeated, repeated]), ["retrying in 5s", "retrying in 5s"]);
  const burst = [repeated, repeated, repeated, timedLog("worker connected", 0)];
  assert.deepEqual(await reader.shown(burst), ["retrying in 5s", "worker connected"]);
  assert.deepEqual(
    await reader.shown(burst),
    [],
    "replaying the whole overlap must show no duplicate",
  );
  assert.deepEqual(await reader.shown([...burst, retrying(1)]), ["retrying in 5s"]);

  // A new view can deliver more occurrences than its bounded cursor remembers.
  // An incomplete count cannot establish a new copy on unchanged follow polls.
  reader.startView();
  const saturated = Array.from({ length: 17 }, () => retrying(0));
  assert.equal((await reader.shown(saturated)).length, 17);
  for (const message of [
    "a saturated frontier must not replay old copies",
    "repeated unchanged polls must remain empty",
  ]) {
    assert.deepEqual(await reader.shown(saturated), [], message);
  }
  assert.deepEqual(await reader.shown([...saturated, timedLog("worker connected", 1)]), [
    "worker connected",
  ]);
});

test("runtime log route polling keeps a cut timestamp group conservative when the tail expands", async () => {
  const reader = await runtimeLogRoutePoller();
  const old = Array.from({ length: 3 }, () => retrying(0));
  const connected = timedLog("worker connected", 1);
  assert.equal((await reader.shown(old, { tailLines: "2" })).length, 2);
  assert.deepEqual(await reader.shown(old), [], "expanding the tail does not make an old copy new");
  assert.deepEqual(
    await reader.shown([...old, retrying(0)]),
    [],
    "an incomplete frontier cannot distinguish another identical copy",
  );
  assert.deepEqual(await reader.shown([...old, connected]), ["worker connected"]);
  assert.deepEqual(await reader.shown([...old, connected, connected]), ["worker connected"]);

  reader.startView();
  assert.equal((await reader.shown(old, { truncated: true })).length, 2);
  assert.deepEqual(
    await reader.shown(old),
    [],
    "a Driver byte cut cannot establish a complete first timestamp group",
  );
});

// About 8 KiB per line: some tens of these fill a 512 KiB page.
function bigLine(text, second) {
  return timedLog(gatewayJson(`${text} ${"x ".repeat(4096)}`), second);
}

test("runtime log route polling counts undelivered copies after its page byte cut", async () => {
  const reader = await runtimeLogRoutePoller();
  const padding = Array.from({ length: 20 }, (_, index) => bigLine(`line ${index}`, 0));
  const repeated = bigLine("retrying", 1);
  const lines = [...padding, ...Array.from({ length: 80 }, () => repeated)];
  const first = await reader.poll(lines);
  assert.equal(first.truncated, true);
  const delivered = messages(first).length;
  assert.ok(delivered > padding.length && delivered < lines.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 512 * 1024);
  const next = await reader.poll(lines);
  assert.equal(
    messages(next).length,
    lines.length - delivered,
    "a page cut leaves the remaining copies to deliver at the complete frontier",
  );
  assert.deepEqual(await reader.shown(lines), []);
});

test("runtime log cursor keeps legacy frontier counts conservative", async () => {
  const reader = pollReader();
  const repeated = retrying(0);
  await reader.poll([repeated, repeated]);
  const cursor = reader.codec.encode(reader.binding, {
    ...reader.position,
    frontierComplete: undefined,
  });
  assert.deepEqual(await reader.shown([repeated, repeated, repeated], { query: { cursor } }), []);
  assert.deepEqual(await reader.shown([repeated, repeated, retrying(1)]), ["retrying in 5s"]);
});

test("runtime log polling delivers a timestamp group larger than the hash history once", async () => {
  for (const size of [16, 17, 20]) {
    for (const lead of [[timedLog("boot", -1)], []]) {
      const reader = pollReader();
      const label = `${size} distinct lines${lead.length === 0 ? " without an earlier line" : ""}`;
      const lines = [...lead, ...workers(size)];
      assert.equal((await reader.shown(lines)).length, lines.length, label);
      for (let poll = 0; poll < 3; poll += 1) {
        assert.deepEqual(await reader.shown(lines), [], `${label}: poll ${poll} replays`);
      }
      lines.push(timedLog("worker late ready", 0), timedLog("worker 0 ready", 0));
      assert.deepEqual(
        await reader.shown(lines),
        ["worker late ready", "worker 0 ready"],
        `${label}: later lines at the same time`,
      );
      assert.deepEqual(await reader.shown(lines), [], `${label}: after later lines`);
      lines.push(timedLog("worker connected", 1));
      assert.deepEqual(await reader.shown(lines), ["worker connected"], label);
    }
  }
});

test("runtime log polling counts mixed identical and distinct lines at one timestamp", async () => {
  const reader = pollReader();
  const lines = [timedLog("boot", -1)];
  for (let index = 0; index < 12; index += 1) {
    lines.push(retrying(0), timedLog(`attempt ${index}`, 0));
  }
  assert.equal((await reader.shown(lines)).length, 25);
  assert.deepEqual(await reader.shown(lines), []);
  lines.push(retrying(0), timedLog("attempt 0", 0), retrying(0));
  assert.deepEqual(await reader.shown(lines), ["retrying in 5s", "attempt 0", "retrying in 5s"]);
  assert.deepEqual(await reader.shown(lines), []);
});

test("runtime log polling pages through a large timestamp group and ends", async () => {
  const reader = pollReader();
  const lines = [
    timedLog("boot", -1),
    ...Array.from({ length: 200 }, (_, index) => bigLine(`line ${index}`, 0)),
  ];
  const seen = [];
  let polls = 0;
  for (; polls < 20; polls += 1) {
    const page = await reader.shown(lines);
    if (page.length === 0) {
      break;
    }
    seen.push(...page);
  }
  assert.ok(polls < 20, "pagination must end");
  assert.equal(seen.length, 201);
  assert.equal(new Set(seen).size, 201, "no line is delivered twice");
  assert.deepEqual(await reader.shown(lines), []);
});

test("runtime log polling suppresses a forgotten timestamp group when completeness is unknown", async () => {
  const reader = pollReader();
  const all = workers(30);
  // The requested tail clips the group, so the cursor cannot count it from its start.
  const tail = all.slice(-20);
  const query = { tailLines: 20 };
  assert.equal((await reader.shown(tail, { query })).length, 20);
  assert.deepEqual(await reader.shown(tail, { query }), []);
  assert.deepEqual(await reader.shown(all), [], "an expanded tail adds no old line");
  assert.deepEqual(await reader.shown([...all, timedLog("worker connected", 1)]), [
    "worker connected",
  ]);
});

test("runtime log polling checks a counted timestamp group against its hashes", async () => {
  const reader = pollReader();
  const group = workers(10);
  assert.equal((await reader.shown([timedLog("boot", -1), ...group])).length, 11);
  // Rotation removed the start of the group; a short page no longer begins with it.
  const fresh = Array.from({ length: 5 }, (_, index) => timedLog(`worker ${index} joined`, 0));
  assert.deepEqual(
    await reader.shown([...group.slice(5), ...fresh]),
    fresh.map(({ raw }) => raw),
  );
  assert.deepEqual(await reader.shown([...group.slice(5), ...fresh]), []);
});

test("runtime log polling counts a timestamp group past an untimed line", async () => {
  const reader = pollReader();
  const lines = [timedLog("boot", -1), ...workers(20)];
  assert.equal((await reader.shown(lines)).length, 21);
  lines.push(timedLog("untimed", null), timedLog("worker late ready", 0));
  assert.deepEqual(await reader.shown(lines), ["untimed", "worker late ready"]);
  assert.deepEqual(await reader.shown(lines), ["untimed"]);
});

test("runtime log polling stops counting by position after tail-clipped polls", async () => {
  const reader = pollReader();
  const group = workers(25);
  const seen = await reader.shown([timedLog("boot", -1), group[0]]);
  assert.equal(seen.length, 2);
  // The view's tail changes between polls, so some polls cannot see the group start.
  for (const tailLines of [4, 20, 1000]) {
    const lines = [timedLog("boot", -1), ...group].slice(-tailLines);
    seen.push(...(await reader.shown(lines, { query: { tailLines } })));
  }
  assert.equal(new Set(seen).size, seen.length, "no line is delivered twice");
  assert.deepEqual(await reader.shown([timedLog("boot", -1), ...group]), []);
});

test("runtime log cursor without a frontier count keeps legacy cursors usable", async () => {
  const strip = (reader) => {
    const { frontierCount: _count, ...position } = reader.position;
    return reader.codec.encode(reader.binding, position);
  };
  const full = pollReader();
  const lines = [timedLog("boot", -1), ...workers(20)];
  await full.poll(lines);
  assert.equal(full.position.frontierCount, 20);
  assert.deepEqual(await full.shown(lines, { query: { cursor: strip(full) } }), []);
  assert.deepEqual(await full.shown([...lines, timedLog("worker connected", 1)]), [
    "worker connected",
  ]);

  const short = pollReader();
  const few = [timedLog("boot", -1), retrying(0), retrying(0)];
  await short.poll(few);
  assert.deepEqual(await short.shown([...few, retrying(0)], { query: { cursor: strip(short) } }), [
    "retrying in 5s",
  ]);

  const position = full.position;
  for (const change of [
    { lastHashes: ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"], frontierCount: 1 },
    { lastTime: null, lastHashes: [], frontierCount: 1 },
  ]) {
    const inconsistent = full.codec.encode(full.binding, { ...position, ...change });
    assert.equal(full.codec.decode(inconsistent, full.binding).status, "invalid");
  }
});

function cursorCodecFixture() {
  const codec = createRuntimeLogCursorCodec(randomBytes(32).toString("hex"));
  const binding = {
    principalId: "synthetic-person",
    agentId: "agent-test",
    revisionId: "revision-test",
    source: "gateway",
  };
  const issuedAt = Date.parse("2026-09-30T12:10:00Z");
  const position = {
    viewId: "rlv_synthetic",
    pod: "gateway-test-0",
    podUid: "synthetic-pod-0",
    restartCount: 0,
    previous: false,
    lastTime: "2026-09-30T12:00:00Z",
    lastHashes: [codec.lineHash("worker ready")],
    frontierComplete: true,
    frontierCount: 1,
    issuedAt,
  };
  const status = (cursor, { now = issuedAt, bound = binding } = {}) =>
    codec.decode(cursor, bound, now).status;
  return { codec, binding, issuedAt, position, status };
}

test("runtime log cursor codec refuses other bindings, altered envelopes and future issue times", () => {
  const { codec, binding, issuedAt, position, status } = cursorCodecFixture();
  const cursor = codec.encode(binding, position);
  assert.equal(status(cursor), "valid");
  for (const [label, bound] of [
    ["agent", { ...binding, agentId: "agent-other" }],
    ["revision", { ...binding, revisionId: "revision-other" }],
    ["source", { ...binding, source: "sandbox" }],
    // Fields are delimited: moving text between them is another binding.
    ["boundary", { ...binding, principalId: "synthetic-personagent", agentId: "-test" }],
  ]) {
    assert.equal(status(cursor, { bound }), "invalid", label);
  }
  // Only the exact three-part v2 envelope verifies; a short MAC is refused, not thrown.
  // The MAC covers the version, so relabelling a v2 cursor as v1 does not verify.
  const [, payload, mac] = cursor.split(".");
  for (const [label, forged] of [
    ["extra part", `${cursor}.extra`],
    ["version", `v1.${payload}.${mac}`],
    ["unknown version", `v3.${payload}.${mac}`],
    ["short MAC", `v2.${payload}.${mac.slice(0, -1)}`],
  ]) {
    assert.equal(status(forged), "invalid", label);
  }
  // Expiry starts strictly after the TTL; up to one minute of clock skew is tolerated.
  for (const [now, expected] of [
    [issuedAt + RUNTIME_LOG_CURSOR_TTL_MS, "valid"],
    [issuedAt + RUNTIME_LOG_CURSOR_TTL_MS + 1, "expired"],
    [issuedAt - 60_000, "valid"],
    [issuedAt - 60_001, "invalid"],
  ]) {
    assert.equal(status(cursor, { now }), expected, `${now - issuedAt} ms`);
  }
});

test("runtime log cursor codec keeps the newest 48 hashes, hashes raw lines exactly and needs a 32-character secret", () => {
  const { codec, binding, issuedAt, position } = cursorCodecFixture();
  const hashes = Array.from({ length: 49 }, (_, index) => codec.lineHash(`worker ${index}`));
  const many = codec.encode(binding, { ...position, lastHashes: hashes, frontierCount: 49 });
  assert.deepEqual(codec.decode(many, binding, issuedAt).position.lastHashes, hashes.slice(-48));
  // Frontier hashes compare raw lines exactly.
  assert.notEqual(codec.lineHash("worker ready"), codec.lineHash("worker ready "));
  assert.throws(() => createRuntimeLogCursorCodec("s".repeat(31)), TypeError);
  assert.doesNotThrow(() => createRuntimeLogCursorCodec("s".repeat(32)));
});

function cursorPayload(cursor) {
  return JSON.parse(Buffer.from(cursor.split(".")[1], "base64url").toString("utf8"));
}
function plainLineHash(raw) {
  return createHash("sha256").update(raw).digest("base64url").slice(0, 16);
}
// The pre-keying envelope: version outside the MAC and plain SHA-256 line hashes.
function legacyCursor(secret, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(`occ-runtime-logs-cursor\0${encoded}`)
    .digest("base64url");
  return `v1.${encoded}.${mac}`;
}

test("runtime log cursor line hashes are keyed by the server secret, not plain SHA-256", async () => {
  const secret = randomBytes(32).toString("hex");
  const reader = pollReader({ secret });
  // A low-entropy value that redaction masks; its raw-line digest must not be testable.
  const secretLine = "db login password=hunter2";
  const lines = [timedLog("worker ready", 0), timedLog(secretLine, 0)];
  const page = await reader.poll(lines);
  assert.equal(JSON.stringify(page.records).includes("hunter2"), false);
  const carried = cursorPayload(reader.cursor).h.match(/.{16}/g);
  assert.deepEqual(
    carried,
    lines.map(({ raw }) => reader.codec.lineHash(raw)),
  );
  for (const { raw } of lines) {
    assert.equal(carried.includes(plainLineHash(raw)), false, raw);
  }
  const keyed = reader.codec.lineHash(secretLine);
  // Same secret, same digest; another secret cannot reproduce it.
  assert.equal(createRuntimeLogCursorCodec(secret).lineHash(secretLine), keyed);
  assert.notEqual(
    createRuntimeLogCursorCodec(randomBytes(32).toString("hex")).lineHash(secretLine),
    keyed,
  );
  // Nor is the line hash the cursor MAC key applied directly.
  assert.notEqual(
    createHmac("sha256", secret).update(secretLine).digest("base64url").slice(0, 16),
    keyed,
  );
  // Frontier hashes and byte-cut window checkpoints (container and Sandbox) all go
  // through the keyed codec; the readers have no unkeyed digest of their own.
  for (const file of ["read.ts", "sandbox.ts"]) {
    const source = await readFile(
      new URL(`../../packages/occ/src/runtime-logs/${file}`, import.meta.url),
      "utf8",
    );
    assert.equal(/node:crypto|createHash|createHmac/.test(source), false, file);
  }
});

test("runtime log cursor keyed hashes still de-duplicate and resume", async () => {
  const reader = pollReader();
  const first = [timedLog("worker ready", 0), timedLog("worker ready", 0), timedLog("a", 1)];
  assert.deepEqual(await reader.shown(first), ["worker ready", "worker ready", "a"]);
  // The overlap at the frontier is consumed; a new copy and later lines are kept.
  assert.deepEqual(await reader.shown([...first, timedLog("a", 1), timedLog("b", 2)]), ["a", "b"]);
  assert.deepEqual(await reader.shown([timedLog("a", 1), timedLog("b", 2)]), []);
  assert.equal(reader.admissions, 1);
});

test("runtime log cursors from before keyed hashes expire into a new audited view", async () => {
  const secret = randomBytes(32).toString("hex");
  const reader = pollReader({ secret });
  const lines = [timedLog("worker ready", 0), timedLog("worker ready", 0), timedLog("a", 1)];
  await reader.poll(lines);
  const current = cursorPayload(reader.cursor);
  // What the previous release issued for the same position: plain hashes, v1 MAC.
  const legacy = legacyCursor(secret, { ...current, h: plainLineHash("a") });
  const decoded = reader.codec.decode(legacy, reader.binding);
  assert.equal(decoded.status, "expired");
  assert.deepEqual(decoded.position.lastHashes, []);
  assert.equal(decoded.position.containerWindow, undefined);
  // Forged, foreign or malformed legacy envelopes stay invalid. The forged MAC always
  // differs: about one MAC in 1024 already ends in "AA".
  const forgedEnd = legacy.endsWith("AA") ? "AE" : "AA";
  for (const [cursor, binding] of [
    [`${legacy.slice(0, -2)}${forgedEnd}`, reader.binding],
    [legacy, { ...reader.binding, principalId: "other-person" }],
    [legacyCursor(secret, { ...current, r: -1 }), reader.binding],
  ]) {
    assert.equal(reader.codec.decode(cursor, binding).status, "invalid");
  }
  const before = reader.admissions;
  const page = await reader.poll([...lines, timedLog("b", 2)], { query: { cursor: legacy } });
  // A visible gap and a fresh audited view, never a silent de-duplication.
  assert.ok(page.records.some(({ type, reason }) => type === "gap" && reason === "cursor_expired"));
  assert.equal(reader.admissions, before + 1);
  assert.deepEqual(messages(page), ["worker ready", "worker ready", "a", "b"]);
  assert.match(reader.cursor, /^v2\./);
  assert.notEqual(cursorPayload(reader.cursor).v, current.v);
});

test("runtime log cursor refuses signed positions with malformed fields", () => {
  const { codec, binding, position, status } = cursorCodecFixture();
  assert.equal(status(codec.encode(binding, position)), "valid");
  for (const change of [
    { viewId: 7 },
    { podUid: null },
    { restartCount: -1 },
    { restartCount: 1.5 },
    { previous: "false" },
    { lastTime: 5 },
    { lastHashes: ["short"] },
    { issuedAt: String(position.issuedAt) },
    { frontierComplete: "true" },
    { frontierCount: "1" },
    { pemOpen: false, pemAfterTime: [position.lastTime] },
  ]) {
    // Authenticated schema validation, separately from MAC tampering.
    assert.equal(
      status(codec.encode(binding, { ...position, ...change })),
      "invalid",
      JSON.stringify(change),
    );
  }
});

test("runtime log frontier times accept only kubelet UTC and order trimmed fractions", () => {
  for (const [value, valid] of [
    ["2026-09-30T12:00:00Z", true],
    ["2026-09-30T12:00:00.123456789Z", true],
    ["2026-09-30T12:00:00.1234567890Z", false],
    ["2026-09-30T12:00:00+00:00", false],
    ["+012026-09-30T12:00:00Z", false],
    ["2026-02-30T12:00:00Z", false],
    ["2026-13-01T12:00:00Z", false],
  ]) {
    assert.equal(validRuntimeLogFrontierTime(value), valid, value);
  }
  // Kubelet trims trailing zeros from the fraction.
  assert.equal(compareRuntimeLogTime("2026-09-30T12:00:00Z", "2026-09-30T12:00:00.000Z"), 0);
  assert.equal(compareRuntimeLogTime("2026-09-30T12:00:00.5Z", "2026-09-30T12:00:00.123Z"), 1);
});

test("runtime log route polling carries PEM masking through the serialized cursor", async () => {
  const reader = await runtimeLogRoutePoller();
  const lines = [
    timedLog(pemBegin, 0),
    timedLog(randomBytes(48).toString("base64"), 1),
    timedLog(syntheticPemTail, 2),
    timedLog(pemEnd, 3),
    retrying(4),
  ];
  for (const count of [2, 3, 5]) {
    const page = await reader.poll(lines.slice(0, count));
    assert.equal(reader.response.headers.get("cache-control"), "no-store");
    assert.equal(
      reader.response.text.includes(syntheticPemTail),
      false,
      "the actual handler must not serialize the middle-poll fragment",
    );
    if (count === 5) {
      assert.ok(page.records.some((record) => record.message === "retrying in 5s"));
    }
  }
});

test("runtime log cursor keeps an ambiguous same-time close conservative", async () => {
  const reader = await pemOpenReader();
  await reader.poll([timedLog(pemEnd, 0), retrying(0)]);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 1)]));
  await reader.poll([retrying(2)]);
  assertTailShown(await reader.poll([timedLog(syntheticPemTail, 3)]));
});

test("runtime log cursor retains uncertainty for missing, malformed and reordered times", async (t) => {
  for (const [name, lines] of [
    ["missing", [timedLog(pemEnd, null), timedLog(syntheticPemTail, 1)]],
    ["malformed", [{ raw: pemEnd, time: "not-a-time" }, timedLog(syntheticPemTail, 1)]],
    ["reordered", [timedLog(pemEnd, 3), timedLog(syntheticPemTail, 2)]],
  ]) {
    await t.test(name, async () => {
      const reader = await pemOpenReader();
      assertTailMasked(await reader.poll(lines));
      // Later timestamps cannot reconstruct the missing chronology of this view.
      await reader.poll([timedLog(pemEnd, 4)]);
      assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 5)]));
    });
  }
});

test("runtime log cursor keeps a later BEGIN on the same line as END", async () => {
  const reader = await pemOpenReader();
  await reader.poll([timedLog(`${pemEnd} ${pemBegin}`, 1)]);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
});

test("runtime log cursor rejects malformed or inconsistent signed PEM field pairs before reading", async () => {
  const reader = await pemOpenReader();
  const position = reader.position;
  for (const change of [
    { pemOpen: undefined },
    { pemAfterTime: undefined },
    { pemOpen: "true" },
    { pemOpen: null },
    { pemAfterTime: 123 },
    { pemAfterTime: "invalid" },
    { pemAfterTime: "2026-02-31T12:00:00Z" },
    { pemAfterTime: timedLog("", 1).time },
    { lastTime: null },
  ]) {
    // Exercise authenticated schema validation, separately from MAC tampering.
    const cursor = reader.codec.encode(reader.binding, { ...position, ...change });
    const before = reader.reads;
    await assert.rejects(reader.poll([], { query: { cursor } }), { reason: "cursor_invalid" });
    assert.equal(reader.reads, before);
  }
});

test("runtime log cursor preserves legacy absent context as unknown", async () => {
  const reader = pollReader();
  await reader.poll([retrying(0)]);
  const legacy = reader.codec.encode(reader.binding, {
    ...reader.position,
    pemOpen: undefined,
    pemAfterTime: undefined,
  });
  assert.equal(reader.codec.decode(legacy, reader.binding).position.pemOpen, undefined);
  // No observed BEGIN and no END: short arbitrary text remains best-effort.
  assertTailShown(
    await reader.poll([timedLog(syntheticPemTail, 1)], { query: { cursor: legacy } }),
  );
  assert.equal(reader.position.pemOpen, undefined);
});

test("runtime log cursor keeps the frontier stable on replay and does not inspect undelivered lookahead", async () => {
  const reader = pollReader();
  const begin = timedLog(pemBegin, 0);
  await reader.poll([begin]);
  const prior = reader.position;
  await reader.poll([begin]);
  const replay = reader.position;
  assert.equal(replay.pemOpen, true);
  assert.equal(replay.pemAfterTime, prior.pemAfterTime);
  // A malformed future line beyond the response cut is not consumed evidence.
  const page = await reader.poll([...largeDiagnostics(70, 1), { raw: pemEnd, time: null }]);
  assert.equal(page.truncated, true);
  const frontier = reader.position;
  assert.equal(frontier.pemOpen, true);
  assert.notEqual(frontier.pemAfterTime, null);
  assert.equal(frontier.pemAfterTime, frontier.lastTime);
});

test("runtime log cursor detects reordered overlap even when deduplication removes the old frontier line", async () => {
  const reader = pollReader();
  const body = timedLog(randomBytes(48).toString("base64"), 1);
  await reader.poll([timedLog(pemBegin, 0), body]);
  assertTailMasked(await reader.poll([timedLog(pemEnd, 3), body, timedLog(syntheticPemTail, 4)]));
});

test("runtime log cursor preserves known-open context across a lost overlap window", async () => {
  const reader = await pemOpenReader();
  const page = await reader.poll([timedLog(syntheticPemTail, 100)], { query: { tailLines: 1 } });
  assert.ok(
    page.records.some((record) => record.type === "gap" && record.reason === "window_exceeded"),
  );
  assertTailMasked(page);
});

test("runtime log cursor preserves an observed BEGIN on uncertain initial and legacy pages", async (t) => {
  for (const legacy of [false, true]) {
    for (const beginTime of [3, null]) {
      await t.test(
        `${legacy ? "legacy" : "initial"} ${beginTime === null ? "null" : "reordered"}`,
        async () => {
          const reader = pollReader();
          if (legacy) {
            await reader.poll([retrying(0)]);
            assert.equal(reader.position.pemOpen, undefined);
          }
          // BEGIN is observed in this very page. Missing earlier cursor context does
          // not make this older END valid evidence of a close.
          await reader.poll([timedLog(pemBegin, beginTime), timedLog(pemEnd, 1)]);
          const context = reader.position;
          const next = await reader.poll([timedLog(syntheticPemTail, 4), retrying(5)]);
          assertTailMasked(next);
          assert.ok(messages(next).includes("retrying in 5s"));
          assert.equal(context.pemOpen, true);
          assert.equal(context.pemAfterTime, null);
        },
      );
    }
  }
});

const lineRecords = (page) => page.records.filter(({ type }) => type === "line");
const gapCount = (page, reason) =>
  page.records.filter((record) => record.type === "gap" && record.reason === reason).length;
const range = (count) => Array.from({ length: count }, (_, index) => index);
// The `row=<n>` index of each delivered line, from JSON messages or `[info]` text lines.
const rowIds = (page) =>
  lineRecords(page).map(({ message }) => {
    const match = /^(?:\[info\] )?row=(\d+);/.exec(message);
    assert.ok(match, `not a row line: ${message.slice(0, 80)}`);
    return Number(match[1]);
  });
// Raw bytes plus 32 bytes of timestamp per line: what the kubelet's 1 MiB read covers.
const rawBytes = (lines) =>
  lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.raw) + 32, 0);
const iso = (milliseconds) => new Date(milliseconds).toISOString();

// One page of the route's response, within the 512 KiB response bound.
async function boundedPage(route, query, message) {
  const response = await route.read(query);
  assert.equal(response.status, 200, message ?? response.text.slice(0, 200));
  assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
  return response;
}
// A first page that the response bound cut.
async function cutPage(route, query) {
  const response = await boundedPage(route, query);
  assert.equal(response.data.truncated, true);
  return response;
}
// Follows a view until a page is not truncated (at most 10 pages).
async function drain(route, { tailLines, cursor, message, onPage = () => {} }) {
  const lines = [];
  let pages = 0;
  while (pages < 10) {
    const response = await boundedPage(route, { tailLines, cursor }, message);
    onPage(response, pages);
    lines.push(...lineRecords(response.data));
    cursor = response.data.cursor;
    pages += 1;
    if (!response.data.truncated) {
      break;
    }
  }
  return {
    lines,
    cursor,
    pages,
    get rows() {
      return rowIds({ records: lines });
    },
  };
}
// Every truncated page delivers at least one line.
function advances(response) {
  if (response.data.truncated) {
    assert.ok(lineRecords(response.data).length > 0, "a byte-cut page must advance");
  }
}

test("runtime container wire pages include escaped messages, cursor and HTTP metadata in the limit", async () => {
  const route = await logsRoute({ label: "wire-budget" });
  const started = Date.now() - 1000;
  route.state.lines = Array.from({ length: 70 }, (_, index) => ({
    time: iso(started + index),
    raw: gatewayJson(`row=${index}; 网络🙂 process arguments: ${'--option="value" '.repeat(500)}`),
  }));
  let firstCount;
  const { rows, cursor, pages } = await drain(route, {
    tailLines: 200,
    onPage(response, page) {
      assert.equal(response.body.meta.requestId.length, 40);
      assert.equal(
        Buffer.byteLength(response.text, "utf8"),
        Buffer.byteLength(JSON.stringify(response.body), "utf8"),
        "the actual formatter matches measured JSON, including Unicode",
      );
      if (page === 0) {
        firstCount = lineRecords(response.data).length;
        assert.equal(response.data.truncated, true);
      }
      advances(response);
    },
  });
  assert.ok(firstCount > 0 && firstCount < 70);
  assert.deepEqual(rows, range(70));
  const replay = await route.read({ cursor });
  assert.deepEqual(replay.data.records, []);
  assert.equal(
    route.fixture.computeDriver.calls.filter(({ operation }) => operation === "read").length,
    pages + 1,
    "prefix builds do not read the Driver again",
  );
  assert.equal(
    route.fixture.auditSink.events.filter(
      ({ action }) => action === "openclaw.agents.runtime_logs.view",
    ).length,
    1,
    "prefix builds and continuation do not open extra views",
  );
  const download = await route.read({ download: true });
  assert.equal(download.status, 200);
  assert.ok(Buffer.byteLength(download.text, "utf8") <= 512 * 1024);
});

test("runtime container checkpoint suffixes survive append-only growth to a full tail", async () => {
  for (const { tail, identical } of [
    { tail: 100, identical: false },
    { tail: 300, identical: false },
    { tail: 100, identical: true },
  ]) {
    const cursorSecret = randomBytes(32).toString("hex");
    const route = await logsRoute({
      label: "wire-budget-growing-tail",
      agentRuntimeLogs: { enabled: true, cursorSecret },
    });
    const time = iso(Date.now() - 1000);
    const row = (index, large = false) => ({
      time,
      raw:
        large && tail === 300
          ? `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`
          : gatewayJson(
              `row=${identical ? 7 : index}; ${large || identical ? '--option="value" '.repeat(500) : "anchor"}`,
            ),
    });
    route.state.lines = Array.from({ length: 20 }, (_, index) => row(index));
    const prime = await route.read({ tailLines: tail });
    assert.equal(prime.status, 200);
    const seen = rowIds(prime.data);
    assert.equal(seen.length, 20, "the baseline exceeds the retained frontier hash history");
    route.state.lines.push(
      ...Array.from({ length: tail - 21 }, (_, index) => row(index + 20, true)),
    );
    assert.ok(rawBytes(route.state.lines) < 1024 * 1024);
    let cursor = prime.data.cursor;
    let cuts = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await boundedPage(route, { tailLines: tail, cursor });
      assert.ok(response.data.cursor.length <= 2048);
      seen.push(...rowIds(response.data));
      cuts += response.data.truncated ? 1 : 0;
      cursor = response.data.cursor;
      if (identical && page > 0) {
        assert.ok(
          gapCount(response.data, "window_exceeded") > 0,
          "full identical-value windows retain the conservative gap even when their checkpoint drains",
        );
      }
      if (page === 0) {
        assert.equal(
          response.data.truncated,
          true,
          "the short window must cut the serialized page",
        );
        if (tail === 100 && !identical) {
          // The previous compact cursor had ten window entries and no inherited proof.
          const payload = cursorPayload(cursor);
          if (payload.cw.length === 11) {
            payload.cw.pop();
          }
          const legacyPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
          const mac = createHmac("sha256", cursorSecret)
            .update("occ-runtime-logs-cursor\0v2\0")
            .update(legacyPayload)
            .digest("base64url");
          const legacy = await route.read({ tailLines: 100, cursor: `v2.${legacyPayload}.${mac}` });
          assert.equal(
            legacy.status,
            200,
            "legacy windows remain usable on their stable short source",
          );
          assert.deepEqual(
            rowIds(legacy.data),
            Array.from({ length: 99 - seen.length }, (_, index) => index + seen.length),
          );
        }
        route.state.lines.push(row(tail - 1, true));
      }
      if (!response.data.truncated) {
        break;
      }
    }
    assert.deepEqual(
      seen,
      range(tail).map((index) => (identical ? 7 : index)),
    );
    const replay = await route.read({ tailLines: tail, cursor });
    assert.equal(replay.status, 200);
    assert.deepEqual(rowIds(replay.data), []);
    if (tail === 300) {
      assert.ok(cuts >= 2, "positional proof survives multiple full-tail cuts");
    }
  }
});

test("container byte-cut checkpoints retain untimed progress or advance mixed windows", async () => {
  for (const mixed of [false, true]) {
    const route = await logsRoute({ label: "container-untimed-driver-cut" });
    const count = 330;
    const started = Date.now() - 40_000;
    route.state.lines = [
      ...Array.from({ length: count }, (_, index) => ({
        time: mixed && index > 0 ? iso(started + index * 118) : null,
        raw: `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`,
      })),
      { time: null, raw: "partial trailing row" },
    ];
    route.state.truncated = true;
    assert.ok(rawBytes(route.state.lines) < 1024 * 1024);
    const seen = [];
    let cursor;
    let pages = 0;
    let drained;
    while (seen.length < count && pages < 10) {
      const response = await boundedPage(route, { tailLines: 1000, cursor });
      assert.equal(response.data.truncated, true, "the underlying Driver cut remains visible");
      const rows = rowIds(response.data);
      assert.ok(rows.length > 0, "each wire cut advances through the complete fetched prefix");
      seen.push(...rows);
      cursor = response.data.cursor;
      drained = response.data;
      pages += 1;
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, range(count));
    if (mixed) {
      assert.ok(
        gapCount(drained, "window_exceeded") > 0,
        "timed advancement explicitly resets the uncertain window",
      );
      const next = await route.read({ tailLines: 1000, cursor });
      assert.equal(next.status, 200);
      const resumedRead = route.fixture.computeDriver.calls
        .filter(({ operation }) => operation === "read")
        .at(-1);
      assert.ok(
        Number.isInteger(resumedRead.sinceSeconds) && resumedRead.sinceSeconds <= 10,
        "the supported Driver receives a recent floor instead of rereading the entire old byte-cut window",
      );
      continue;
    }
    for (let poll = 0; poll < 2; poll += 1) {
      const replay = await route.read({ tailLines: 1000, cursor });
      assert.equal(replay.status, 200);
      assert.equal(
        messages(replay.data).length,
        0,
        "a stable byte-truncated window cannot replay its consumed untimed prefix",
      );
      assert.equal(replay.data.truncated, true);
      cursor = replay.data.cursor;
    }
  }
});

test("runtime container wire budgeting handles empty, single and grouped withheld pages", async () => {
  const route = await logsRoute({ label: "wire-budget-boundaries" });
  const row = (raw, index = 0) => ({ raw, time: iso(Date.now() - 1000 + index) });
  for (const lines of [
    [],
    [row(gatewayJson(`single 网络🙂 ${'--option="value" '.repeat(500)}`))],
  ]) {
    route.state.lines = lines;
    const response = await boundedPage(route, { tailLines: 200 });
    assert.equal(response.data.truncated, false);
    assert.equal(lineRecords(response.data).length, lines.length);
  }
  route.state.lines = Array.from({ length: 80 }, (_, index) =>
    row(JSON.stringify({ ordinary_metadata: "diagnostic ".repeat(900) }), index),
  );
  const withheld = await boundedPage(route, { tailLines: 200 });
  assert.equal(
    withheld.data.truncated,
    false,
    "a compact withheld run fits even when its input is large",
  );
  assert.equal(withheld.data.withheld, 80);
  assert.equal(withheld.data.records[0].count, 80);
  const replay = await route.read({ cursor: withheld.data.cursor });
  assert.deepEqual(replay.data.records, []);
});

test("a full 1 MiB container window is cut after sanitizing it once", async (t) => {
  // With tailLines=1000 a chatty container fills the kubelet's 1 MiB read on every
  // poll: twice what one 512 KiB page may carry. Choosing the cut must not sanitize
  // the window again for each candidate prefix (a binary search did about five
  // window sanitizations per poll). Sanitizing a line classifies it (one JSON.parse of
  // the raw line) and redacts its message (one argv split of the message text), so
  // call-through spies on both count per-line work without depending on runner load.
  // Every spied call returns the real result.
  const started = Date.parse("2026-09-30T12:00:00Z");
  const lines = Array.from({ length: 1000 }, (_, index) => ({
    time: iso(started + index),
    raw: gatewayJson(`row=${index}; ${"diagnostic detail ".repeat(56)}`),
  }));
  assert.ok(lines.reduce((sum, { raw }) => sum + Buffer.byteLength(raw), 0) > 1024 * 1024);
  const stream = { source: "gateway", pod: "gateway-test-0", container: "gateway" };
  const raws = new Set(lines.map(({ raw }) => raw));
  const texts = new Set(lines.map(({ raw }) => JSON.parse(raw).message));
  const parse = t.mock.method(JSON, "parse");
  const split = t.mock.method(String.prototype, "split");
  const work = async (run) => {
    parse.mock.resetCalls();
    split.mock.resetCalls();
    await run();
    return {
      classified: parse.mock.calls.filter(({ arguments: [text] }) => raws.has(text)).length,
      redacted: split.mock.calls.filter((call) => texts.has(String(call.this))).length,
    };
  };
  // The Driver's byte cut drops the final, partial line before any classification.
  const complete = lines.slice(0, -1);
  const evidence = await work(() => runtimeLogEvidence(complete));
  const once = await work(() => sanitizeRuntimeLogChunk({ stream, lines, truncated: true }));
  // The proxies hold: one sanitization classifies and redacts each complete line once,
  // and the evidence pass classifies without redacting.
  assert.deepEqual(once, { classified: complete.length, redacted: complete.length });
  assert.equal(evidence.redacted, 0);
  let page;
  const cut = await work(async () => {
    page = await pollReader().poll(lines, { truncated: true });
  });
  const delivered = lineRecords(page).length;
  assert.equal(page.truncated, true);
  assert.ok(delivered > 300 && delivered < 999, `${delivered} lines delivered`);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 512 * 1024);
  // The fetched safety evidence classifies every complete line once; the prefix
  // builds then share one sanitization. Both bounds are exact today: classifying or
  // redacting even the delivered prefix once more adds at least 300 lines.
  assert.ok(
    cut.classified <= evidence.classified + once.classified,
    `the cut page classified ${cut.classified} window lines; the evidence pass and one sanitization classify ${evidence.classified + once.classified}`,
  );
  assert.ok(
    cut.redacted <= once.redacted,
    `the cut page redacted ${cut.redacted} window messages; one sanitization redacts ${once.redacted}`,
  );
});

test("the page budget measures every page it returns, whatever its prefix estimate", async () => {
  const { boundedRuntimeLogPage } =
    await import("../../packages/occ/src/runtime-logs/page-budget.ts");
  const stream = { source: "gateway", pod: "gateway-test-0", container: "gateway" };
  const line = (index) => ({
    type: "line",
    time: null,
    stream,
    contentClass: "operational",
    kind: "text",
    level: "unknown",
    message: `${index}`.padEnd(1000, "x"),
  });
  // `grow` bytes of cursor per delivered line defeat the estimate, which reads only
  // record sizes; `skip` drops records so they no longer account for every line.
  const budget = ({ count, grow = 0, skip = false }) => {
    let builds = 0;
    const page = boundedRuntimeLogPage(count, (end) => {
      builds += 1;
      return {
        revisionId: "revision-test",
        source: "gateway",
        stream,
        observedAt: "2026-09-30T12:10:00.000Z",
        records: Array.from({ length: end }, (_, index) => line(index)).filter(
          (_, index) => !skip || index % 2 === 0,
        ),
        withheld: 0,
        truncated: end < count,
        cursor: "c".repeat(64 + grow * end),
      };
    });
    return { page, builds, bytes: Buffer.byteLength(JSON.stringify(page), "utf8") };
  };
  const estimated = budget({ count: 1000 });
  const missed = budget({ count: 1000, grow: 64 });
  const unaccounted = budget({ count: 1000, skip: true });
  // A sound estimate costs the full, empty and estimated builds.
  assert.equal(estimated.builds, 3);
  for (const { page, builds, bytes } of [estimated, missed, unaccounted]) {
    assert.ok(bytes <= 512 * 1024 - 64, `${bytes} bytes`);
    assert.ok(page.records.length > 0 && page.truncated);
    assert.ok(builds <= 13, `${builds} builds`);
  }
  // A missed estimate falls back to the search below it rather than returning it.
  assert.ok(missed.builds > 3);
  assert.ok(missed.page.records.length < estimated.page.records.length);
});

// 60 rows of about 8.5 KiB at one time (or untimed): a 60-line tail is cut.
function wireContainerRows(time, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time,
    raw: gatewayJson(`row=${index}; diagnostic ${'--option="value" '.repeat(500)}`),
  }));
}
const recently = () => iso(Date.now() - 1000);

test("container byte-window checkpoints drain full same-time and untimed tails", async () => {
  for (const time of [recently(), null]) {
    const route = await logsRoute({ label: "container-window" });
    route.state.lines = wireContainerRows(time);
    let first;
    const { rows, cursor } = await drain(route, {
      tailLines: 60,
      onPage(response, page) {
        if (page === 0) {
          first = lineRecords(response.data).length;
          assert.equal(response.data.truncated, true);
        }
        advances(response);
      },
    });
    assert.ok(first > 16 && first < 60);
    assert.deepEqual(rows, range(60));
    const replay = await route.read({ tailLines: 60, cursor });
    assert.equal(lineRecords(replay.data).length, 0);
  }
});

test("container byte-window changes expose a fresh snapshot and fitting untimed progress", async () => {
  for (const changed of ["value", "tail", "buffer"]) {
    const route = await logsRoute({ label: "container-window-change" });
    route.state.lines = wireContainerRows(null);
    const first = await cutPage(route, { tailLines: 60 });
    if (changed === "value") {
      route.state.lines[59] = {
        time: null,
        raw: JSON.stringify({ level: "info", message: "changed suffix" }),
      };
    }
    if (changed === "buffer") {
      route.state.lines.splice(25);
    }
    const tailLines = changed === "tail" ? 25 : 60;
    const next = await boundedPage(route, { tailLines, cursor: first.data.cursor });
    assert.ok(gapCount(next.data, "window_exceeded") > 0, changed);
    assert.ok(lineRecords(next.data).length > 0, changed);
    if (changed !== "value") {
      assert.equal(next.data.truncated, false);
      const replay = await route.read({ tailLines, cursor: next.data.cursor });
      assert.equal(lineRecords(replay.data).length, 0, changed);
    }
  }
});

test("container byte-window checkpoints retain the pre-cut deduplication baseline", async () => {
  const route = await logsRoute({ label: "container-window-baseline" });
  const time = recently();
  const anchor = { time, raw: gatewayJson("previous diagnostic") };
  route.state.lines = [anchor];
  const initial = await route.read({ tailLines: 100 });
  assert.deepEqual(messages(initial.data), ["previous diagnostic"]);
  route.state.lines = [anchor, ...wireContainerRows(iso(Date.parse(time) + 1))];
  const { rows } = await drain(route, {
    tailLines: 100,
    cursor: initial.data.cursor,
    onPage(response) {
      assert.ok(messages(response.data).every((message) => message !== "previous diagnostic"));
    },
  });
  assert.deepEqual(rows, range(60));
});

test("container byte-window progress does not cross UID or restart changes", async () => {
  for (const changed of ["uid", "restart"]) {
    const route = await logsRoute({ label: "container-window-instance" });
    route.state.lines = wireContainerRows(recently());
    const first = await cutPage(route, { tailLines: 60 });
    if (changed === "uid") {
      route.state.podUid = randomUUID();
    } else {
      route.state.restartCount += 1;
    }
    const next = await route.read({ tailLines: 60, cursor: first.data.cursor });
    assert.equal(next.status, 200);
    assert.ok(gapCount(next.data, "stream_replaced") > 0);
    assert.ok(messages(next.data).some((message) => message.startsWith("row=0;")));
  }
});

test("container changed byte-windows keep PEM masking conservative", async () => {
  const route = await logsRoute({ label: "container-window-pem" });
  const time = recently();
  route.state.lines = wireContainerRows(time);
  const first = await cutPage(route, { tailLines: 60 });
  route.state.lines[30] = { time, raw: pemBegin };
  route.state.lines[31] = { time, raw: syntheticPemTail };
  const replacement = await route.read({ tailLines: 60, cursor: first.data.cursor });
  assert.equal(replacement.status, 200);
  assert.ok(gapCount(replacement.data, "window_exceeded") > 0);
  assertTailMasked(replacement.data);
  route.state.lines = [{ time: iso(Date.parse(time) + 1), raw: syntheticPemTail }];
  const carried = await route.read({ tailLines: 60, cursor: replacement.data.cursor });
  assertTailMasked(carried.data);
});

test("container byte-window baselines reset when the Driver observes an instance change during read", async () => {
  for (const changed of ["uid", "restart"]) {
    const route = await logsRoute({ label: "container-window-reread" });
    const { state } = route;
    const time = recently();
    state.lines = [
      {
        time: iso(Date.parse(time) + 100),
        raw: JSON.stringify({ level: "info", message: "prior instance" }),
      },
    ];
    const initial = await route.read({ tailLines: 60 });
    state.lines = wireContainerRows(time);
    if (changed === "uid") {
      state.readPodUid = randomUUID();
    } else {
      state.readRestartCount = 1;
    }
    const replaced = await route.read({ tailLines: 60, cursor: initial.data.cursor });
    assert.equal(replaced.data.truncated, true);
    assert.ok(gapCount(replaced.data, "stream_replaced") > 0);
    if (changed === "uid") {
      state.podUid = state.readPodUid;
    } else {
      state.restartCount = state.readRestartCount;
    }
    const rest = await route.read({ tailLines: 60, cursor: replaced.data.cursor });
    assert.equal(rest.status, 200);
    assert.deepEqual([...rowIds(replaced.data), ...rowIds(rest.data)], range(60));
  }
});

test("container expanded byte-windows preserve valid conservative PEM cursors", async () => {
  for (const changed of ["expanded", "empty"]) {
    const route = await logsRoute({ label: "container-window-recovery" });
    const time = recently();
    route.state.lines = [{ time: iso(Date.parse(time) - 2000), raw: pemEnd }];
    const prime = await route.read({ tailLines: 60 });
    const older = Array.from({ length: 100 }, (_, i) => ({
      time: iso(Date.parse(time) - 1000),
      raw: `[info] older row=${i}; diagnostic ${'"a" '.repeat(1000)}`,
    }));
    const current = wireContainerRows(time);
    route.state.lines = [...older, ...current];
    const first = await route.read({ tailLines: 60, cursor: prime.data.cursor });
    assert.equal(first.data.truncated, true);
    if (changed === "empty") {
      route.state.lines = [];
    }
    const { lines, cursor } = await drain(route, {
      tailLines: 160,
      cursor: first.data.cursor,
      message: "recovery must not poison the next signed cursor",
    });
    const seen = lines.map(({ message }) => message.split(";", 1)[0]);
    if (changed === "expanded") {
      assert.deepEqual(
        seen,
        [...older, ...current].map(({ raw }) =>
          raw.startsWith("[info]")
            ? raw.split(";", 1)[0]
            : JSON.parse(raw).message.split(";", 1)[0],
        ),
      );
    } else {
      assert.equal(seen.length, 0);
    }
    const replay = await route.read({ tailLines: 160, cursor });
    assert.equal(replay.status, 200);
    assert.equal(lineRecords(replay.data).length, 0);
  }
});

test("container empty checkpoint recovery suppresses the next single untimed snapshot", async () => {
  const route = await logsRoute({ label: "container-empty-window" });
  route.state.lines = wireContainerRows(null);
  const first = await cutPage(route, { tailLines: 60 });
  route.state.lines = [];
  const empty = await route.read({ tailLines: 60, cursor: first.data.cursor });
  assert.equal(empty.status, 200);
  route.state.lines = [{ time: null, raw: gatewayJson("worker ready") }];
  const single = await route.read({ tailLines: 60, cursor: empty.data.cursor });
  assert.equal(lineRecords(single.data).length, 1);
  const replay = await route.read({ tailLines: 60, cursor: single.data.cursor });
  assert.equal(lineRecords(replay.data).length, 0);
});

// The Driver fakes below cut lines against the clock, as kubelet `sinceSeconds` does. The
// clock is frozen so the windows do not depend on how long the host takes between reads.
function freezeClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

test("container checkpoints preserve the existing overlap through backend processing delay", async (t) => {
  freezeClock(t);
  let calls = 0;
  const route = await logsRoute({
    label: "container-processing-delay",
    wrap: (underlying) => {
      const read = underlying.readAgentRuntimeLogs.bind(underlying);
      return {
        ...underlying,
        async readAgentRuntimeLogs(binding, request) {
          calls += 1;
          if (calls === 1) {
            underlying.state.lines = wireContainerRows(
              iso(Date.now() - request.sinceSeconds * 1000 + 500),
            );
          }
          const chunk = await read(binding, request);
          // Equivalent backend processing time, without changing the reader.
          const floor = Date.now() + (calls === 1 ? 0 : 1800) - request.sinceSeconds * 1000;
          return { ...chunk, lines: chunk.lines.filter(({ time }) => Date.parse(time) >= floor) };
        },
      };
    },
  });
  const first = await cutPage(route, { tailLines: 200, sinceSeconds: 60 });
  const next = await route.read({ tailLines: 200, cursor: first.data.cursor });
  assert.equal(next.status, 200);
  assert.deepEqual([...rowIds(first.data), ...rowIds(next.data)], range(60));
});

test("container checkpoint windows remain stable when relative seconds round outward", async (t) => {
  freezeClock(t);
  for (const skew of [0, 2000]) {
    const route = await logsRoute({
      label: "container-relative-window",
      wrap: (underlying) => {
        const read = underlying.readAgentRuntimeLogs.bind(underlying);
        return {
          ...underlying,
          async readAgentRuntimeLogs(binding, request) {
            const chunk = await read(binding, request);
            const floor = Date.now() - skew - request.sinceSeconds * 1000;
            return {
              ...chunk,
              lines:
                request.sinceSeconds === undefined
                  ? chunk.lines
                  : chunk.lines.filter(({ time }) => time === null || Date.parse(time) >= floor),
            };
          },
        };
      },
    });
    const now = Date.now();
    const rows = wireContainerRows(iso(now - (skew === 0 ? 1000 : 11000)));
    route.state.lines = [
      { time: iso(now - skew - 10050), raw: gatewayJson("older than original window") },
      ...rows,
    ];
    const first = await route.read({ tailLines: 61, sinceSeconds: 10 });
    assert.equal(first.data.truncated, true);
    // A fraction of a second passes, so the resumed relative window rounds outward.
    t.mock.timers.tick(400);
    const rest = await route.read({ tailLines: 61, cursor: first.data.cursor });
    assert.equal(rest.status, 200);
    assert.equal(rest.data.truncated, false);
    assert.deepEqual([...rowIds(first.data), ...rowIds(rest.data)], range(60));
    assert.equal(gapCount(rest.data, "window_exceeded"), 0);
  }
});

test("container wire-prefix builds retain fetched masking evidence without advancing PEM state", async () => {
  const route = await logsRoute({ label: "container-mask-evidence" });
  const start = Date.now() - 1000;
  route.state.lines = [
    ...wireContainerRows(null, 50),
    ...Array.from({ length: 300 }, () => ({ time: null, raw: "QUJD" })),
    { time: null, raw: pemEnd },
  ].map((line, index) => ({ ...line, time: iso(start + index) }));
  const first = await cutPage(route, { tailLines: 1000 });
  assert.ok(!messages(first.data).includes("QUJD"));
  assert.equal(
    cursorPayload(first.data.cursor).po,
    undefined,
    "an undelivered END must not advance persistent PEM state",
  );
  const rest = await route.read({ tailLines: 1000, cursor: first.data.cursor });
  assert.equal(rest.status, 200);
  assert.ok(!messages(rest.data).includes("QUJD"));
});

test("container wire continuation retains fetched JSON withholding decisions", async () => {
  const route = await logsRoute({ label: "container-json-evidence" });
  const start = Date.now() - 1000;
  const rows = [
    ...range(42).map((index) => ({
      raw: gatewayJson(`row=${index}; diagnostic ${" ".repeat(500)}${'"a" '.repeat(2100)}`),
      time: null,
    })),
    { raw: "[", time: null },
    ...Array.from({ length: 15 }, () => [
      { raw: "1".repeat(32769) + ",", time: null },
      { raw: "  true,", time: null },
    ]).flat(),
    { raw: "]", time: null },
  ];
  route.state.lines = rows.map((line, index) => ({ ...line, time: iso(start + index) }));
  assert.ok(
    route.state.lines.reduce(
      (bytes, line) => bytes + Buffer.byteLength(line.raw) + Buffer.byteLength(line.time) + 2,
      0,
    ) <=
      1024 * 1024,
    "the whole fetched fixture respects the Driver read bound",
  );
  let cut = false;
  await drain(route, {
    tailLines: 1000,
    onPage(response) {
      assert.ok(!messages(response.data).some((message) => message.trim() === "true,"));
      cut ||= response.data.truncated;
    },
  });
  assert.equal(cut, true);
});

// Rows of about 7 KiB, one second apart from `start`: a 100-line tail is cut.
function ordinaryRow(start, index, name = "row") {
  return {
    time: iso(start + index * 1000),
    raw: gatewayJson(`${name}=${index}; ${"ordinary diagnostic ".repeat(350)}`),
  };
}

test("container follows a growing full wire-cut tail without replaying its delivered prefix", async () => {
  const route = await logsRoute({ label: "full-growing-wire-tail" });
  const start = Date.now() - 120_000;
  route.state.lines = range(100).map((index) => ordinaryRow(start, index));
  let cursor;
  const seen = [];
  const counts = [];
  for (let poll = 0; poll < 6; poll += 1) {
    if (poll > 0) {
      const offset = route.state.lines.length;
      route.state.lines.push(...range(3).map((index) => ordinaryRow(start, offset + index)));
    }
    const response = await boundedPage(route, { tailLines: 100, cursor });
    const rows = rowIds(response.data);
    seen.push(...rows);
    counts.push(rows.length);
    if (poll === 0) {
      assert.equal(response.data.truncated, true);
    }
    cursor = response.data.cursor;
  }
  assert.deepEqual(seen, range(115));
  assert.deepEqual(counts.slice(2), [3, 3, 3, 3]);
  const replay = await route.read({ tailLines: 100, cursor });
  assert.deepEqual(lineRecords(replay.data), []);
});

// A cut first page of 80 or 100 ordinary rows, then the rows a rotation leaves behind.
// Returns both pages.
async function rotatedWindow(label, rows, rotate) {
  const route = await logsRoute({ label });
  route.state.lines = rows;
  const first = await cutPage(route, { tailLines: 100 });
  route.state.lines = rotate(route.state.lines);
  const second = await boundedPage(route, { tailLines: 100, cursor: first.data.cursor });
  return [first.data, second.data];
}

test("container checkpoint recovery does not duplicate an observed window-loss gap", async () => {
  const start = Date.now() - 120_000;
  // The burst replaces the whole tail before the byte-cut snapshot drains.
  // Actual missing rows still require one window gap, not a second gap for the
  // discarded checkpoint alongside that same observed loss.
  const [, second] = await rotatedWindow(
    "wire-cut-burst-gap",
    range(100).map((index) => ordinaryRow(start, index)),
    (lines) => [...lines, ...range(100).map((index) => ordinaryRow(start, 100 + index))],
  );
  assert.equal(gapCount(second, "window_exceeded"), 1);
});

test("container checkpoint recovery keeps an unknown-time reset visible", async () => {
  const start = Date.now() - 120_000;
  // The timed frontier cannot locate an unknown row in a changed snapshot.
  // Recovering timed rows must keep that reset visible, even on a short tail.
  const [, second] = await rotatedWindow(
    "wire-cut-unknown-reset",
    range(80).map((index) => ({
      ...ordinaryRow(start, index),
      ...(index === 0 && { time: null }),
    })),
    ([, ...rest]) => [{ time: null, raw: "changed unknown-time diagnostic" }, ...rest],
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container shortened timed checkpoints disclose missing undelivered rows", async () => {
  const start = Date.now() - 120_000;
  // Rotation can leave a short surviving window in the same container. Its
  // later times establish progress, not continuity with the unread snapshot.
  const [, second] = await rotatedWindow(
    "wire-cut-shortened-timed-window",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => lines.slice(-5),
  );
  assert.equal(lineRecords(second).length, 5);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container same-size short replacements disclose missing undelivered rows", async () => {
  const start = Date.now() - 120_000;
  // Rotation retains the same row count but replaces the unread part with newer rows.
  const [, second] = await rotatedWindow(
    "wire-cut-same-size-short-window",
    range(80).map((index) => ordinaryRow(start, index, "old")),
    () =>
      range(80).map((index) => ({
        time: iso(start + (100 + index) * 1000),
        raw: gatewayJson(`new=${index}`),
      })),
  );
  assert.equal(lineRecords(second).length, 80);
  assert.equal(gapCount(second, "window_exceeded"), 1);
});

test("container checkpoint recovery that still covers the delivered frontier reports no loss", async () => {
  const start = Date.now() - 120_000;
  // Rotation drops only the oldest, already delivered row. The changed window still
  // starts before the delivered frontier, so every undelivered row survives.
  const [first, second] = await rotatedWindow(
    "wire-cut-covered-frontier",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => lines.slice(1),
  );
  assert.deepEqual([...rowIds(first), ...rowIds(second)], range(80));
  assert.equal(gapCount(second, "window_exceeded"), 0);
});

// Ordinary rows whose rows from `from` on share one timestamp group.
function groupedRows(start, from) {
  return range(80).map((index) => ({
    ...ordinaryRow(start, index),
    ...(index >= from && { time: iso(start + from * 1000) }),
  }));
}

test("container checkpoint recovery discloses rows lost inside the frontier time group", async () => {
  const start = Date.now() - 120_000;
  // The surviving window starts at the delivered frontier time, so undelivered
  // rows of that group can sit before it; a later row lets time recovery start.
  const [first, second] = await rotatedWindow(
    "wire-cut-frontier-group-loss",
    groupedRows(start, 60),
    (lines) => [...lines.slice(-3), ordinaryRow(start, 80)],
  );
  assert.ok(rowIds(first).at(-1) >= 60 && rowIds(first).at(-1) < 76);
  assert.deepEqual(rowIds(second), [77, 78, 79, 80]);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery discloses a reordered changed window", async () => {
  const start = Date.now() - 120_000;
  // An undelivered row now dates before the frontier, so time resumption drops it.
  const [, second] = await rotatedWindow(
    "wire-cut-reordered-window",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => [...lines.slice(1, -1), { ...lines.at(-1), time: iso(start) }],
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery discloses frontier rows its hash history cannot place", async () => {
  const start = Date.now() - 120_000;
  // The delivered group outgrows the frontier hashes and a changed row breaks the
  // positional proof, so undelivered rows of that group cannot be told apart.
  const [first, second] = await rotatedWindow(
    "wire-cut-frontier-history-loss",
    groupedRows(start, 3),
    (lines) => [
      ...lines.slice(1, 3),
      { time: lines[3].time, raw: gatewayJson("changed group row") },
      ...lines.slice(3),
    ],
  );
  assert.ok(rowIds(first).length > 3 + 16);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery discloses a window whose clock stepped back", async () => {
  const start = Date.now() - 120_000;
  // Rotation dropped the delivered frontier and the rows after it, and the node
  // clock stepped back: the new rows are ordered and all before the frontier.
  const [, second] = await rotatedWindow(
    "wire-cut-clock-step-back",
    range(80).map((index) => ordinaryRow(start, index)),
    () => range(6).map((index) => ordinaryRow(start, 40 + index, "after-step")),
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});
