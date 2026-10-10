import assert from "node:assert/strict";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maskRuntimeEventText,
  redactRuntimeLogText,
} from "../../packages/occ/src/runtime-logs/redact.ts";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { readRuntimeLogPage } from "../../packages/occ/src/runtime-logs/read.ts";
import { cpuTimeMs } from "../helpers/cpu-time.mjs";
import {
  createRuntimeLogCursorCodec,
  RUNTIME_LOG_CURSOR_TTL_MS,
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

test("runtime log route bodies never contain planted credentials, prompts or protocol output", async () => {
  const { createRuntimeLogComputeDriver, createRuntimeLogFixture } =
    await import("../helpers/runtime-logs.mjs");
  const values = {
    ...canaries(),
    DEEP: `deep-canary-${randomUUID()}`,
    CONTROL: "visible-control-text",
  };
  // Hex split at the 1 MiB boundary: the fragment is below every redaction threshold,
  // so only dropping the partial final line keeps it out of the page.
  const splitFragment = randomBytes(10).toString("hex");
  const eventBearer = randomString(30);
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  computeDriver.state.lines = [
    ...(await corpusLines(values)),
    { time: lineTime(90), raw: `export GIT_TOKEN_PART=${splitFragment}` },
  ];
  computeDriver.state.truncated = true;
  computeDriver.state.restartCount = 1;
  computeDriver.state.terminationReason = `Error: token ${values.GITHUB_PAT}`;
  computeDriver.state.events = [
    {
      type: "Warning",
      reason: "Failed",
      message: `Failed to pull image: Authorization: Bearer ${eventBearer}`,
      count: 3,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];

  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.headers.get("cache-control"), "no-store");
  assert.equal(runtime.text.includes(eventBearer), false, "Event messages are redacted");
  assert.equal(runtime.text.includes(values.GITHUB_PAT), false, "termination reasons are redacted");
  assert.match(runtime.data.pods[0].events[0].message, /\[redacted:header\]/);

  const logs = await fixture.request("GET", target.logsPath("source=gateway&tailLines=1000"));
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries({ ...values, SPLIT: splitFragment })) {
    if (name === "CONTROL") {
      continue;
    }
    assert.equal(logs.text.includes(value), false, `canary ${name} leaked into the response`);
  }
  // A level floor only removes sanitized records; it never reaches unsanitized text.
  const floored = await fixture.request(
    "GET",
    target.logsPath("source=gateway&tailLines=1000&minLevel=warn"),
  );
  assert.equal(floored.status, 200, floored.text);
  for (const [name, value] of Object.entries({ ...values, SPLIT: splitFragment })) {
    if (name === "CONTROL") {
      continue;
    }
    assert.equal(floored.text.includes(value), false, `canary ${name} leaked at minLevel=warn`);
  }
  assert.ok(
    floored.data.records.every(
      (record) => record.type !== "line" || ["error", "warn", "unknown"].includes(record.level),
    ),
  );
  assert.equal(floored.data.records.at(-1).reason, "truncated");
  // The download is the same sanitized page in a second serializer.
  const download = await fixture.request("GET", target.logsPath("source=gateway&download=true"));
  assert.equal(download.status, 200, download.text);
  assert.equal(download.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries({ ...values, SPLIT: splitFragment })) {
    if (name === "CONTROL") {
      continue;
    }
    assert.equal(download.text.includes(value), false, `canary ${name} leaked into the download`);
  }
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
  const codex = lines.filter((record) => record.kind === "codex");
  assert.deepEqual(
    codex.map(({ level, message, subsystem }) => ({ level, message, subsystem })),
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
  const withheld = logs.data.records.filter((record) => record.type === "withheld");
  assert.deepEqual(
    withheld.map(({ reason, count }) => ({ reason, count })),
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
  const stream = { source: "gateway", pod: "gateway-0", container: "gateway" };
  const reply = `reply-canary-${randomUUID()}`;
  const { records } = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      { time: lineTime(1), raw: JSON.stringify({ level: "info", message: reply }) },
      { time: lineTime(2), raw: JSON.stringify({ level: "debug", message: reply, subsystem: "" }) },
      {
        time: lineTime(3),
        raw: JSON.stringify({
          level: "error",
          message: "Gateway failed to start: gateway.bind=custom requires gateway.customBindHost",
        }),
      },
      { time: lineTime(4), raw: JSON.stringify({ level: "warn", message: "config reloaded" }) },
      {
        time: lineTime(5),
        raw: JSON.stringify({ level: "info", subsystem: "gateway", message: "listening" }),
      },
    ],
  });
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
  const stream = { source: "agent", pod: "gateway-0", container: "agent" };
  const password = `pw${randomString(14)}`;
  const hf = `hf_${randomString(34)}`;
  const stripe = `sk_live_${randomString(24)}`;
  const restricted = `rk_test_${randomString(24)}`;
  const basic = Buffer.from(`svc:${randomString(12)}`).toString("base64");
  const netrc = `n${randomString(15)}`;
  const serviceKey = randomBytes(16).toString("hex");
  const turn = `curl --user ops:${password} https://x.example.invalid`;
  const { records } = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      { time: lineTime(1), raw: `curl -u admin:${password} https://x.example.invalid` },
      { time: lineTime(2), raw: `token ${hf} ${stripe} ${restricted}` },
      { time: lineTime(3), raw: `Proxy auth Basic ${basic}` },
      { time: lineTime(4), raw: `machine github.com login bob password ${netrc}` },
      { time: lineTime(5), raw: `MY_SERVICE_KEY=${serviceKey}` },
      {
        time: lineTime(6),
        raw: JSON.stringify({
          level: "warn",
          target: "codex_core::tools::parallel",
          fields: { message: "tool failed", turn_id: turn },
        }),
      },
      {
        time: lineTime(7),
        raw: JSON.stringify({ level: "warn", subsystem: "x", message: "m", code: stripe }),
      },
      // Prose and identifiers stay readable.
      { time: lineTime(8), raw: "basic authentication failed; see hf_hub_download and sort -u" },
    ],
  });
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
  const stream = { source: "agent", pod: "gateway-0", container: "agent" };
  const { records } = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      { time: lineTime(1), raw: "Harness model authentication probe failed." },
      { time: lineTime(2), raw: "Harness model authentication probe failed. extra" },
    ],
  });
  assert.deepEqual(
    records.map(({ kind, level, message }) => ({ kind, level, message })),
    [
      { kind: "wrapper", level: "error", message: "Harness model authentication probe failed." },
      {
        kind: "text",
        level: "unknown",
        message: "Harness model authentication probe failed. extra",
      },
    ],
  );
});

test("a failed startup phase keeps its fixed cause code", () => {
  const { records } = sanitizeRuntimeLogChunk({
    stream: { source: "agent", pod: "agent-0", container: "agent" },
    truncated: false,
    lines: [
      {
        time: lineTime(1),
        raw: '{"event":"runtime.startup_phase","container":"agent","phase":"plugin-install","outcome":"failed","ms":60000,"sinceStartMs":62000,"code":"PLUGIN_NOT_IN_CATALOG"}',
      },
    ],
  });
  assert.deepEqual(
    records.map(({ kind, level, message, fields }) => ({ kind, level, message, fields })),
    [
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
    ],
  );
});

test("a failed model probe keeps its closed-vocabulary cause, never other cause text", () => {
  const probe = (event, cause) =>
    JSON.stringify({ event, elapsedMs: 2340, code: "MODEL_PROBE_FAILED", cause });
  const { records, withheld } = sanitizeRuntimeLogChunk({
    stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
    truncated: false,
    lines: [
      {
        time: lineTime(1),
        raw: probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: "format" }),
      },
      {
        time: lineTime(2),
        raw: probe("codex.model_probe", { kind: "PROBE_STATUS", detail: "error-event" }),
      },
      { time: lineTime(3), raw: probe("openclaw.model_probe", { kind: "WRAPPER_ERROR" }) },
      // Off-vocabulary details, unknown kinds and extra keys drop the cause, never the line.
      {
        time: lineTime(4),
        raw: probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: "sk-live-abc" }),
      },
      { time: lineTime(5), raw: probe("openclaw.model_probe", { kind: "PROVIDER_TEXT" }) },
      {
        time: lineTime(6),
        raw: probe("codex.model_probe", { kind: "PROBE_STATUS", detail: "format", text: "x" }),
      },
      { time: lineTime(7), raw: probe("codex.model_probe", "PROBE_STATUS") },
      {
        time: lineTime(8),
        raw: probe("openclaw.model_probe", { kind: "PROBE_STATUS", detail: 42 }),
      },
      // Only a failed check carries a cause, and only probe records keep one.
      {
        time: lineTime(9),
        raw: JSON.stringify({
          event: "codex.model_probe",
          elapsedMs: 2340,
          code: "READY",
          cause: { kind: "PROBE_STATUS", detail: "format" },
        }),
      },
      {
        time: lineTime(10),
        raw: JSON.stringify({
          event: "runtime.startup_phase",
          phase: "model-probe",
          outcome: "failed",
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "format" },
        }),
      },
    ],
  });
  assert.equal(withheld, 0);
  const fields = (event, cause = {}) => ({
    kind: "wrapper",
    level: "error",
    message: event,
    fields: { elapsedMs: 2340, code: "MODEL_PROBE_FAILED", ...cause },
  });
  assert.deepEqual(
    records.map(({ kind, level, message, fields }) => ({ kind, level, message, fields })),
    [
      fields("openclaw.model_probe", { causeKind: "PROBE_STATUS", causeDetail: "format" }),
      fields("codex.model_probe", { causeKind: "PROBE_STATUS", causeDetail: "error-event" }),
      fields("openclaw.model_probe", { causeKind: "WRAPPER_ERROR" }),
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
    ],
  );
});

test("a Gateway settings override keeps its setting names, never values (D322)", () => {
  const event = (settings) =>
    JSON.stringify({
      event: "runtime.gateway_settings_overridden",
      container: "gateway",
      settings,
    });
  const { records, withheld } = sanitizeRuntimeLogChunk({
    stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
    truncated: false,
    lines: [
      {
        time: lineTime(1),
        raw: event([
          "cron.triggers.enabled",
          "models.providers.codex.baseUrl",
          "models.providers.codex.apiKey",
          "models.providers.codex.models[].headers",
        ]),
      },
      // An item that is not a key path drops the list, never the event.
      { time: lineTime(2), raw: event(["cron.triggers.enabled", "models.providers.sk-live x"]) },
      { time: lineTime(3), raw: event("cron.triggers.enabled") },
    ],
  });
  assert.equal(withheld, 0);
  assert.deepEqual(
    records.map(({ kind, level, message, fields }) => ({ kind, level, message, fields })),
    [
      {
        kind: "wrapper",
        level: "warn",
        message: "runtime.gateway_settings_overridden",
        fields: {
          container: "gateway",
          settings:
            "cron.triggers.enabled, models.providers.codex.baseUrl, models.providers.codex.apiKey, models.providers.codex.models[].headers",
        },
      },
      ...[2, 3].map(() => ({
        kind: "wrapper",
        level: "warn",
        message: "runtime.gateway_settings_overridden",
        fields: { container: "gateway" },
      })),
    ],
  );
});

test("the sanitizer drops a partial final line and bounds oversized input", () => {
  const stream = { source: "gateway", pod: "gateway-0", container: "gateway" };
  const fragment = randomBytes(10).toString("hex");
  const partial = sanitizeRuntimeLogChunk({
    stream,
    truncated: true,
    lines: [
      { time: lineTime(1), raw: "complete line" },
      { time: lineTime(2), raw: `partial ${fragment}` },
    ],
  });
  assert.deepEqual(
    partial.records.map((record) => record.message),
    ["complete line"],
  );
  const oversized = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      { time: lineTime(1), raw: `plain ${"x".repeat(5 * 1024)}` },
      { time: lineTime(2), raw: `{"level":"info","message":"${"y".repeat(33 * 1024)}"}` },
    ],
  });
  assert.deepEqual(
    oversized.records.map(({ type, reason, count }) => ({ type, reason, count })),
    [{ type: "withheld", reason: "oversized", count: 2 }],
  );
  const long = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      {
        time: lineTime(1),
        raw: `{"level":"info","subsystem":"gateway","message":"${"z ".repeat(6000)}"}`,
      },
    ],
  });
  assert.equal(long.records[0].truncated, true);
  assert.ok(Buffer.byteLength(long.records[0].message) <= 8 * 1024);
  assert.match(long.records[0].message, /…\[truncated\]$/);
});

test("pretty-printed JSON is withheld as one run, not shown line by line", () => {
  const stream = { source: "agent", pod: "agent-0", container: "agent" };
  const prompt = `prompt-canary-${randomUUID()}`;
  const element = `element-canary-${randomUUID()}`;
  const tail = `tail-canary-${randomUUID()}`;
  const raw = [
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
  ];
  const result = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: raw.map((line, index) => ({ time: lineTime(index), raw: line })),
  });
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
  const midValue = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [`    "prompt": "${tail}",`, '    "n": 1', "  }", "}", "after"].map((line, index) => ({
      time: lineTime(index),
      raw: line,
    })),
  });
  assert.equal(JSON.stringify(midValue).includes(tail), false, "a mid-value member leaked");
  assert.deepEqual(
    midValue.records.map((record) =>
      record.type === "withheld" ? `withheld ${record.count}` : record.message,
    ),
    ["withheld 3", "}", "after"],
  );

  // An unclosed `{` does not swallow the plain text that follows it.
  const stray = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: ["{ unbalanced", "plain text resumes"].map((line, index) => ({
      time: lineTime(index),
      raw: line,
    })),
  });
  assert.deepEqual(
    stray.records.map((record) => (record.type === "withheld" ? record.type : record.message)),
    ["withheld", "plain text resumes"],
  );

  // A bracket-tagged text line ends an open block instead of reading as its continuation.
  const tagged = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: ["{ x", "[node-host] advertised commands: a, b"].map((line, index) => ({
      time: lineTime(index),
      raw: line,
    })),
  });
  assert.deepEqual(
    tagged.records.map((record) =>
      record.type === "withheld" ? `withheld ${record.count}` : record.message,
    ),
    ["withheld 1", "[node-host] advertised commands: a, b"],
  );
});

test("a PEM block printed over several lines is masked on every line", () => {
  const stream = { source: "gateway", pod: "gateway-0", container: "gateway" };
  const body = randomBytes(48).toString("base64");
  const tail = `PEMTAIL${randomString(12)}`;
  const header = `DEK-Info: AES-128-CBC,${randomBytes(8).toString("hex").toUpperCase()}`;
  const lines = [
    "before the key",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    header,
    "",
    body,
    tail,
    "-----END ENCRYPTED PRIVATE KEY----- after the key",
    "ordinary line",
  ];
  const chunk = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: lines.map((raw, index) => ({ time: lineTime(index), raw })),
  });
  const messages = chunk.records.map((record) => record.message);
  assert.deepEqual(messages, [
    "before the key",
    "[redacted:pem]",
    "[redacted:pem]",
    "[redacted:pem]",
    "[redacted:pem]",
    "[redacted:pem]",
    "[redacted:pem] after the key",
    "ordinary line",
  ]);

  // A page that starts inside a block has no BEGIN line; the END line and the body
  // lines directly above it are masked.
  const midBlock = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: ["page start", body, tail, "-----END PRIVATE KEY-----", "next"].map((raw, index) => ({
      time: lineTime(index),
      raw,
    })),
  });
  assert.deepEqual(
    midBlock.records.map((record) => record.message),
    ["page start", "[redacted:pem]", "[redacted:pem]", "[redacted:pem]", "next"],
  );

  // A BEGIN marker quoted in prose ends at the first line that is not PEM-shaped.
  const prose = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: ["expected a -----BEGIN CERTIFICATE----- header", "retrying in 5s", "done"].map(
      (raw, index) => ({ time: lineTime(index), raw }),
    ),
  });
  assert.deepEqual(
    prose.records.map((record) => record.message),
    ["expected a [redacted:pem]", "retrying in 5s", "done"],
  );

  // Continuation lines are workload-controlled plain text up to 32 KiB each.
  for (const unit of [" ", "a", "A:", "A: ", "-----BEGIN A-----", "-----END A-----"]) {
    const hostile = unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - 1);
    for (const suffix of ["!", " x"]) {
      const budgetMs = 400;
      const elapsed = cpuTimeMs(
        () =>
          sanitizeRuntimeLogChunk({
            stream,
            truncated: false,
            lines: ["-----BEGIN X-----", hostile + suffix, hostile + suffix, "-----END X-----"].map(
              (raw, index) => ({ time: lineTime(index), raw }),
            ),
          }),
        { budgetMs },
      );
      assert.ok(elapsed < budgetMs, `${JSON.stringify(unit)} took ${elapsed.toFixed(0)} ms of CPU`);
    }
  }
});

test("the sanitizer keeps bracket-tagged text lines but withholds malformed JSON arrays", () => {
  const stream = { source: "agent", pod: "agent-0", container: "agent" };
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
  const page = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [...tagged, ...arrays].map((raw, index) => ({ time: lineTime(index), raw })),
  });
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
test("redaction stays linear on hostile 32 KiB lines", () => {
  const budgetMs = 100;
  const line = (unit, suffix = "") =>
    unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - suffix.length) + suffix;
  redactRuntimeLogText(line("warm-up "));
  maskRuntimeEventText(line("warm-up "));
  const units = [
    "a-",
    "a.",
    "-",
    "--a-",
    "=/",
    "(/",
    '"a-',
    "a0a",
    "tokena-",
    "bearer ",
    "-eyJa",
    "-eyJ_",
    "_eyJa",
    "-eyJa-",
    "-eyJaaaa",
  ];
  for (const unit of units) {
    for (const suffix of ["", "?", "token", "=x"]) {
      const input = line(unit, suffix);
      const elapsed = cpuTimeMs(
        () => {
          redactRuntimeLogText(input);
          maskRuntimeEventText(input);
        },
        { budgetMs },
      );
      assert.ok(
        elapsed < budgetMs,
        `${JSON.stringify(unit)} + ${JSON.stringify(suffix)} took ${elapsed.toFixed(0)} ms of CPU`,
      );
    }
  }
  // A whole page of such messages stays well inside one request's budget.
  const elapsed = cpuTimeMs(
    () =>
      sanitizeRuntimeLogChunk({
        stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
        truncated: false,
        lines: Array.from({ length: 50 }, (_, index) => ({
          time: lineTime(index),
          raw: JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
        })),
      }),
    { budgetMs: 50 * budgetMs },
  );
  assert.ok(elapsed < 50 * budgetMs, `50 hostile lines took ${elapsed.toFixed(0)} ms of CPU`);
});

test("redaction stays linear on a generated sweep of short repeated units", () => {
  // Guards shapes nobody enumerated: every unit of 2 characters over an alphabet of
  // pattern delimiters and prefix letters, every 3-character unit over a smaller one, and
  // each delimiter ahead of the JWT, token and bearer prefixes.
  const budgetMs = 100;
  const alphabet = [
    "a",
    "-",
    ".",
    "=",
    "/",
    "?",
    '"',
    ":",
    "_",
    "+",
    "@",
    "e",
    "y",
    "J",
    "t",
    "o",
    "k",
    "n",
    " ",
  ];
  const units = [];
  for (const x of alphabet) {
    for (const y of alphabet) {
      units.push(x + y);
    }
  }
  const short = ["a", "-", ".", "=", "/", '"', "_", "e", "J", " "];
  for (const x of short) {
    for (const y of short) {
      for (const z of short) {
        units.push(x + y + z);
      }
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
    const elapsed = cpuTimeMs(
      () => {
        redactRuntimeLogText(input);
        maskRuntimeEventText(input);
      },
      { budgetMs },
    );
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
  assert.equal(redactRuntimeLogText(`x-token-${jwt} next`), "x-token-[redacted:jwt] next");
  assert.equal(redactRuntimeLogText(`a.${jwt}.b`), "a.[redacted:jwt].b");
  assert.equal(redactRuntimeLogText(`${jwt}.${jwt}`), "[redacted:jwt].[redacted:jwt]");
  assert.equal(redactRuntimeLogText("xeyJabcd.efgh.ij"), "xeyJabcd.efgh.ij");
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

test("Event messages hide node names, image references and Secret names", async () => {
  const { createRuntimeLogComputeDriver, createRuntimeLogFixture } =
    await import("../helpers/runtime-logs.mjs");
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
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  computeDriver.state.events = messages.map((message) => ({
    type: "Warning",
    reason: "Failed",
    message,
    count: 1,
    lastObservedAt: "2026-09-30T11:59:00Z",
  }));
  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.data.pods[0].events.length, messages.length);
  for (const name of [node, image, secret]) {
    assert.equal(runtime.text.includes(name), false, `${name} reached the runtime route`);
  }
  assert.match(runtime.data.pods[0].events[0].message, /to \[redacted:node\]$/);
});

test("Codex span lifecycle records: turns are info events, other spans are debug, no span payload leaves", () => {
  const stream = { source: "agent", pod: "gateway-0", container: "agent" };
  const canary = `codex-span-canary-${randomUUID()}`;
  const tracing = (level, target, fields, span) =>
    JSON.stringify({
      timestamp: "2026-10-01T07:49:44.100970Z",
      level,
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
  const { records } = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      tracing("INFO", "codex_core::tasks", { message: "new" }, turn),
      tracing("INFO", "codex_core::tasks", { message: "enter" }, turn),
      tracing("INFO", "codex_core::tasks", { message: "exit" }, turn),
      tracing("INFO", "codex_core::tools::parallel", {
        message: "tool call completed",
        tool_name: "shell",
        turn_id: "turn-1",
        call_id: canary,
        total_duration_ms: 42,
        arguments: canary,
      }),
      tracing(
        "INFO",
        "codex_core::tasks",
        { message: "close", "time.busy": "2.1s", "time.idle": "9ms" },
        closed,
      ),
      tracing(
        "INFO",
        "codex_exec_server::local_file_system",
        { message: "close", "time.busy": "35µs" },
        { name: "fs.read_file", path: canary },
      ),
      tracing("INFO", "codex_core::client", { message: "new" }, { name: `${canary} x` }),
      // A plain event whose message happens to be a lifecycle word is not a span record.
      tracing("INFO", "codex_core::client", { message: "close" }),
    ].map((raw, index) => ({ time: lineTime(index + 1), raw })),
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
      {
        kind: "codex",
        level: "info",
        message: "turn started",
        subsystem: "codex_core::tasks",
        fields: { model: "gpt-5.6-luna", turn_id: "turn-1" },
      },
      { kind: "codex", level: "debug", message: "span enter turn", subsystem: "codex_core::tasks" },
      { kind: "codex", level: "debug", message: "span exit turn", subsystem: "codex_core::tasks" },
      {
        kind: "codex",
        level: "info",
        message: "tool call completed",
        subsystem: "codex_core::tools::parallel",
        fields: { tool_name: "shell", turn_id: "turn-1", total_duration_ms: 42 },
      },
      {
        kind: "codex",
        level: "info",
        message: "turn completed",
        subsystem: "codex_core::tasks",
        fields: {
          model: "gpt-5.6-luna",
          turn_id: "turn-1",
          input_tokens: 1200,
          output_tokens: 80,
          total_tokens: 1280,
          busy: "2.1s",
        },
      },
      {
        kind: "codex",
        level: "debug",
        message: "span close fs.read_file",
        subsystem: "codex_exec_server::local_file_system",
      },
      { kind: "codex", level: "debug", message: "span new span", subsystem: "codex_core::client" },
      {
        kind: "codex",
        level: "info",
        message: "Codex message withheld",
        subsystem: "codex_core::client",
      },
    ],
  );
  assert.equal(JSON.stringify(records).includes(canary), false, "no span payload or call ID leaks");
});

// Controlled Driver output; the reader, authenticated cursor and sanitizer are real.
// These source tests do not qualify a Kubernetes/provider deployment.
function pollReader() {
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
  const codec = createRuntimeLogCursorCodec(randomBytes(32).toString("hex"));
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
  };
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
function assertTailMasked(page) {
  assert.equal(JSON.stringify(page.records).includes(syntheticPemTail), false);
  assert.ok(messages(page).some((message) => message.includes("[redacted:pem]")));
}

test("runtime log cursor carries PEM context over three polls and empty polls", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0), timedLog(randomBytes(48).toString("base64"), 1)]);
  const beforeEmpty = reader.codec.decode(reader.cursor, reader.binding).position;
  await reader.poll([]);
  const afterEmpty = reader.codec.decode(reader.cursor, reader.binding).position;
  assert.equal(afterEmpty.pemOpen, beforeEmpty.pemOpen);
  assert.equal(afterEmpty.pemAfterTime, beforeEmpty.pemAfterTime);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
  const final = await reader.poll([timedLog(pemEnd, 3), timedLog("retrying in 5s", 4)]);
  assert.ok(messages(final).includes("retrying in 5s"));
  assert.ok(
    messages(await reader.poll([timedLog(syntheticPemTail, 5)])).includes(syntheticPemTail),
  );
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
  assert.deepEqual(
    full.records.map((record) => record.reason ?? record.message),
    ["window_exceeded", "retrying in 0s", "retrying in 1s", "retrying in 2s"],
  );
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
  assert.deepEqual(
    cut.records.map((record) => record.reason ?? record.message),
    ["window_exceeded", "retrying in 600s", "retrying in 601s", "truncated"],
  );
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
  assert.deepEqual(
    cut.records.map((record) => record.reason ?? record.message),
    ["window_exceeded", "retrying in 600s", "retrying in 601s", "truncated"],
  );
  // A cut page that still re-reads the last delivered line lost nothing before it.
  const overlap = await reader.poll(
    [timedLog("retrying in 601s", 601), timedLog("retrying in 700s", 700), timedLog("retr", 701)],
    { elapsed: 700_000, truncated: true },
  );
  assert.deepEqual(
    overlap.records.map((record) => record.reason ?? record.message),
    ["retrying in 700s", "truncated"],
  );
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
      .map(({ reason, time, remedy }) => ({
        reason,
        time,
        remedy,
      }));
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
  assert.equal(
    reader.codec.decode(reader.cursor, reader.binding).position.lastTime,
    timedLog("", 0).time,
  );
  // Once the line is older than where the next read starts, the view skips past it and
  // says that lines were lost behind it.
  const skipped = await reader.poll(stuck, { elapsed: 3_000, truncated: true });
  assert.deepEqual(
    gaps(skipped).map(({ reason, time }) => [reason, time]),
    [["window_exceeded", timedLog("", 599).time]],
  );
  assert.match(gaps(skipped)[0].remedy, /longer than the rest of the 1 MiB read limit/);
  assert.doesNotMatch(JSON.stringify(skipped.records), /fewer lines/);
  const position = reader.codec.decode(reader.cursor, reader.binding).position;
  assert.equal(position.lastTime, null);
  // The cursor cannot keep a delivered PEM frontier, so the open block stays masked.
  assert.equal(position.pemOpen, true);
  assert.equal(position.pemAfterTime, null);
  // The next read starts from the previous read, past the oversized line, not from second 0.
  const next = await reader.poll(
    [timedLog(syntheticPemTail, 604), timedLog("retrying in 604s", 604)],
    {
      elapsed: 5_000,
    },
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
  assert.deepEqual(
    resumed.records.map((record) => record.reason ?? record.message),
    ["retrying in 606s", "truncated"],
  );
  assert.match(gaps(resumed)[0].remedy, /Request fewer lines/);
  assert.equal(
    reader.codec.decode(reader.cursor, reader.binding).position.lastTime,
    timedLog("", 606).time,
  );
  assert.equal(reader.admissions, 1);
});

test("a resumed view skips a stalled read only when every poll would stall", async () => {
  const reader = pollReader();
  const summary = (page) =>
    page.records.map((record) => [
      record.reason ?? record.message,
      ...(record.type === "gap" ? [/fewer lines/.test(record.remedy)] : []),
    ]);
  const lastTime = () => reader.codec.decode(reader.cursor, reader.binding).position.lastTime;
  // `now` is second 600; the view has delivered second 596.
  await reader.poll([timedLog("retrying in 590s", 590), timedLog("retrying in 596s", 596)]);
  // A line older than the overlap every read covers is re-read only on some polls, so a
  // later poll may get past the cut: keep the frontier and the usual remedy.
  const partial = await reader.poll(
    [timedLog("retrying in 593s", 593), timedLog("retrying in 596s", 596), timedLog("retr", 606)],
    { elapsed: 8_000, truncated: true },
  );
  assert.deepEqual(summary(partial), [["truncated", true]]);
  assert.equal(lastTime(), timedLog("", 596).time);
  // Exactly at the guard the view stays put.
  const atGuard = await reader.poll([timedLog("retrying in 596s", 596), timedLog("retr", 605)], {
    elapsed: 8_000,
    truncated: true,
  });
  assert.deepEqual(summary(atGuard), [["truncated", false]]);
  assert.equal(lastTime(), timedLog("", 596).time);
  // A cut line at the cursor time also stalls every poll; untimed lines are not progress.
  const sameTime = await reader.poll(
    [timedLog("retrying in 596s", 596), timedLog("untimed", null), timedLog("retr", 596)],
    { elapsed: 8_001, truncated: true },
  );
  assert.deepEqual(summary(sameTime), [["untimed"], ["window_exceeded", false]]);
  assert.equal(sameTime.records.at(-1).time, timedLog("", 596).time);
  assert.equal(lastTime(), null);

  // A stream replaced during the read is not a stalled read.
  const replaced = pollReader();
  await replaced.poll([timedLog("retrying in 0s", 0)]);
  const page = await replaced.poll([timedLog("retr", 500)], {
    elapsed: 2_000,
    truncated: true,
    stream: { restartCount: 1 },
  });
  assert.deepEqual(summary(page), [
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
  assert.ok(
    messages(await reader.poll([timedLog(syntheticPemTail, 3)])).includes(syntheticPemTail),
  );
});

test("runtime log cursor retains uncertain context after an untimestamped BEGIN", async () => {
  const reader = pollReader();
  await reader.poll([timedLog("started worker", 0), timedLog(pemBegin, null)]);
  const page = await reader.poll([
    timedLog(pemEnd, 1),
    timedLog("retrying in 5s", 2),
    timedLog(syntheticPemTail, null),
  ]);
  assertTailMasked(page);
  assert.ok(messages(page).includes("retrying in 5s"));
});

test("runtime log cursor ignores an undelivered byte-cut END", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  assertTailMasked(
    await reader.poll([timedLog(syntheticPemTail, 1), timedLog(pemEnd, 2)], { truncated: true }),
  );
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 3)]));
});

test("runtime log cursor context stops at the page byte bound before a future END", async () => {
  const reader = pollReader();
  const page = await reader.poll([
    timedLog(pemBegin, 0),
    ...Array.from({ length: 70 }, (_, i) =>
      timedLog(
        JSON.stringify({
          level: "info",
          subsystem: "gateway",
          message: "ordinary diagnostic ".repeat(500),
        }),
        i + 1,
      ),
    ),
    timedLog(pemEnd, 72),
  ]);
  assert.equal(page.truncated, true);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 100)]));
});

test("runtime log cursor verifies context authentication before any Driver read", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  const parts = reader.cursor.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
  payload.po = false;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const before = reader.reads;
  await assert.rejects(reader.poll([], { query: { cursor: parts.join(".") } }), {
    reason: "cursor_invalid",
  });
  assert.equal(reader.reads, before);
  await assert.rejects(
    reader.poll([], { binding: { ...reader.binding, principalId: "other-person" } }),
    { reason: "cursor_invalid" },
  );
  assert.equal(reader.reads, before);
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
      const reader = pollReader();
      await reader.poll([timedLog(pemBegin, 0)]);
      // A new/unknown tail cannot infer a BEGIN from the old stream/view.
      assert.ok(
        messages(await reader.poll([timedLog(syntheticPemTail, 1)], options)).includes(
          syntheticPemTail,
        ),
      );
    });
  }
});

async function runtimeLogRoutePoller() {
  const { createRuntimeLogComputeDriver, createRuntimeLogFixture } =
    await import("../helpers/runtime-logs.mjs");
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  let cursor;
  return {
    startView() {
      cursor = undefined;
    },
    async poll(lines, { tailLines = "1000", truncated = false } = {}) {
      computeDriver.state.lines = lines;
      computeDriver.state.truncated = truncated;
      const query = new URLSearchParams({
        source: "gateway",
        tailLines,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const response = await fixture.request("GET", target.logsPath(query.toString()));
      assert.equal(response.status, 200, response.text);
      assert.equal(typeof response.data.cursor, "string");
      cursor = response.data.cursor;
      return response.data;
    },
  };
}

test("runtime log route polling preserves identical same-time line occurrences", async () => {
  const reader = await runtimeLogRoutePoller();
  const repeated = timedLog("retrying in 5s", 0);
  // The Driver contract supplies raw lines without requiring unique timestamps.
  // A later poll must subtract the two delivered occurrences, not all equal text.
  assert.deepEqual(messages(await reader.poll([repeated, repeated])), [
    "retrying in 5s",
    "retrying in 5s",
  ]);
  const burst = [repeated, repeated, repeated, timedLog("worker connected", 0)];
  assert.deepEqual(messages(await reader.poll(burst)), ["retrying in 5s", "worker connected"]);
  assert.deepEqual(
    messages(await reader.poll(burst)),
    [],
    "replaying the whole overlap must show no duplicate",
  );
  assert.deepEqual(messages(await reader.poll([...burst, timedLog("retrying in 5s", 1)])), [
    "retrying in 5s",
  ]);

  // A new view can deliver more occurrences than its bounded cursor remembers.
  // An incomplete count cannot establish a new copy on unchanged follow polls.
  reader.startView();
  const saturated = Array.from({ length: 17 }, () => timedLog("retrying in 5s", 0));
  assert.equal(messages(await reader.poll(saturated)).length, 17);
  assert.deepEqual(
    messages(await reader.poll(saturated)),
    [],
    "a saturated frontier must not replay old copies",
  );
  assert.deepEqual(
    messages(await reader.poll(saturated)),
    [],
    "repeated unchanged polls must remain empty",
  );
  assert.deepEqual(messages(await reader.poll([...saturated, timedLog("worker connected", 1)])), [
    "worker connected",
  ]);
});

test("runtime log route polling keeps a cut timestamp group conservative when the tail expands", async () => {
  const reader = await runtimeLogRoutePoller();
  const old = Array.from({ length: 3 }, () => timedLog("retrying in 5s", 0));
  assert.equal(messages(await reader.poll(old, { tailLines: "2" })).length, 2);
  assert.deepEqual(
    messages(await reader.poll(old)),
    [],
    "expanding the tail does not make an old copy new",
  );
  assert.deepEqual(
    messages(await reader.poll([...old, timedLog("retrying in 5s", 0)])),
    [],
    "an incomplete frontier cannot distinguish another identical copy",
  );
  assert.deepEqual(messages(await reader.poll([...old, timedLog("worker connected", 1)])), [
    "worker connected",
  ]);
  assert.deepEqual(
    messages(
      await reader.poll([...old, timedLog("worker connected", 1), timedLog("worker connected", 1)]),
    ),
    ["worker connected"],
  );

  reader.startView();
  assert.equal(messages(await reader.poll(old, { truncated: true })).length, 2);
  assert.deepEqual(
    messages(await reader.poll(old)),
    [],
    "a Driver byte cut cannot establish a complete first timestamp group",
  );
});

test("runtime log route polling counts undelivered copies after its page byte cut", async () => {
  const reader = await runtimeLogRoutePoller();
  const padding = Array.from({ length: 20 }, (_, index) =>
    timedLog(
      JSON.stringify({
        level: "info",
        subsystem: "gateway",
        message: `line ${index} ${"x ".repeat(4096)}`,
      }),
      0,
    ),
  );
  const repeated = timedLog(
    JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `retrying ${"x ".repeat(4096)}`,
    }),
    1,
  );
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
  assert.deepEqual(messages(await reader.poll(lines)), []);
});

test("runtime log cursor keeps legacy frontier counts conservative", async () => {
  const reader = pollReader();
  const repeated = timedLog("retrying in 5s", 0);
  await reader.poll([repeated, repeated]);
  const position = reader.codec.decode(reader.cursor, reader.binding).position;
  const cursor = reader.codec.encode(reader.binding, { ...position, frontierComplete: undefined });
  assert.deepEqual(
    messages(await reader.poll([repeated, repeated, repeated], { query: { cursor } })),
    [],
  );
  assert.deepEqual(
    messages(await reader.poll([repeated, repeated, timedLog("retrying in 5s", 1)])),
    ["retrying in 5s"],
  );
});

test("runtime log polling delivers a timestamp group larger than the hash history once", async () => {
  for (const size of [16, 17, 20]) {
    for (const lead of [[timedLog("boot", -1)], []]) {
      const reader = pollReader();
      const label = `${size} distinct lines${lead.length === 0 ? " without an earlier line" : ""}`;
      const group = Array.from({ length: size }, (_, index) =>
        timedLog(`worker ${index} ready`, 0),
      );
      const lines = [...lead, ...group];
      assert.equal(messages(await reader.poll(lines)).length, lines.length, label);
      for (let poll = 0; poll < 3; poll += 1) {
        assert.deepEqual(messages(await reader.poll(lines)), [], `${label}: poll ${poll} replays`);
      }
      lines.push(timedLog("worker late ready", 0), timedLog("worker 0 ready", 0));
      assert.deepEqual(
        messages(await reader.poll(lines)),
        ["worker late ready", "worker 0 ready"],
        `${label}: later lines at the same time`,
      );
      assert.deepEqual(messages(await reader.poll(lines)), [], `${label}: after later lines`);
      lines.push(timedLog("worker connected", 1));
      assert.deepEqual(messages(await reader.poll(lines)), ["worker connected"], label);
    }
  }
});

test("runtime log polling counts mixed identical and distinct lines at one timestamp", async () => {
  const reader = pollReader();
  const lines = [timedLog("boot", -1)];
  for (let index = 0; index < 12; index += 1) {
    lines.push(timedLog("retrying in 5s", 0), timedLog(`attempt ${index}`, 0));
  }
  assert.equal(messages(await reader.poll(lines)).length, 25);
  assert.deepEqual(messages(await reader.poll(lines)), []);
  lines.push(
    timedLog("retrying in 5s", 0),
    timedLog("attempt 0", 0),
    timedLog("retrying in 5s", 0),
  );
  assert.deepEqual(messages(await reader.poll(lines)), [
    "retrying in 5s",
    "attempt 0",
    "retrying in 5s",
  ]);
  assert.deepEqual(messages(await reader.poll(lines)), []);
});

test("runtime log polling pages through a large timestamp group and ends", async () => {
  const reader = pollReader();
  const big = (index) =>
    timedLog(
      JSON.stringify({
        level: "info",
        subsystem: "gateway",
        message: `line ${index} ${"x ".repeat(4096)}`,
      }),
      0,
    );
  const lines = [timedLog("boot", -1), ...Array.from({ length: 200 }, (_, index) => big(index))];
  const seen = [];
  let polls = 0;
  for (; polls < 20; polls += 1) {
    const page = messages(await reader.poll(lines));
    if (page.length === 0) {
      break;
    }
    seen.push(...page);
  }
  assert.ok(polls < 20, "pagination must end");
  assert.equal(seen.length, 201);
  assert.equal(new Set(seen).size, 201, "no line is delivered twice");
  assert.deepEqual(messages(await reader.poll(lines)), []);
});

test("runtime log polling suppresses a forgotten timestamp group when completeness is unknown", async () => {
  const reader = pollReader();
  const all = Array.from({ length: 30 }, (_, index) => timedLog(`worker ${index} ready`, 0));
  // The requested tail clips the group, so the cursor cannot count it from its start.
  const tail = all.slice(-20);
  const query = { tailLines: 20 };
  assert.equal(messages(await reader.poll(tail, { query })).length, 20);
  assert.deepEqual(messages(await reader.poll(tail, { query })), []);
  assert.deepEqual(messages(await reader.poll(all)), [], "an expanded tail adds no old line");
  assert.deepEqual(messages(await reader.poll([...all, timedLog("worker connected", 1)])), [
    "worker connected",
  ]);
});

test("runtime log polling checks a counted timestamp group against its hashes", async () => {
  const reader = pollReader();
  const group = Array.from({ length: 10 }, (_, index) => timedLog(`worker ${index} ready`, 0));
  assert.equal(messages(await reader.poll([timedLog("boot", -1), ...group])).length, 11);
  // Rotation removed the start of the group; a short page no longer begins with it.
  const fresh = Array.from({ length: 5 }, (_, index) => timedLog(`worker ${index} joined`, 0));
  assert.deepEqual(
    messages(await reader.poll([...group.slice(5), ...fresh])),
    fresh.map(({ raw }) => raw),
  );
  assert.deepEqual(messages(await reader.poll([...group.slice(5), ...fresh])), []);
});

test("runtime log polling counts a timestamp group past an untimed line", async () => {
  const reader = pollReader();
  const lines = [
    timedLog("boot", -1),
    ...Array.from({ length: 20 }, (_, index) => timedLog(`worker ${index} ready`, 0)),
  ];
  assert.equal(messages(await reader.poll(lines)).length, 21);
  lines.push(timedLog("untimed", null), timedLog("worker late ready", 0));
  assert.deepEqual(messages(await reader.poll(lines)), ["untimed", "worker late ready"]);
  assert.deepEqual(messages(await reader.poll(lines)), ["untimed"]);
});

test("runtime log polling stops counting by position after tail-clipped polls", async () => {
  const reader = pollReader();
  const group = [timedLog("worker 0 ready", 0)];
  const seen = messages(await reader.poll([timedLog("boot", -1), ...group]));
  assert.equal(seen.length, 2);
  for (let index = 1; index < 25; index += 1) {
    group.push(timedLog(`worker ${index} ready`, 0));
  }
  // The view's tail changes between polls, so some polls cannot see the group start.
  for (const tailLines of [4, 20, 1000]) {
    const lines = [timedLog("boot", -1), ...group].slice(-tailLines);
    seen.push(...messages(await reader.poll(lines, { query: { tailLines } })));
  }
  assert.equal(new Set(seen).size, seen.length, "no line is delivered twice");
  assert.deepEqual(messages(await reader.poll([timedLog("boot", -1), ...group])), []);
});

test("runtime log cursor without a frontier count keeps legacy cursors usable", async () => {
  const strip = (reader) => {
    const { frontierCount: _count, ...position } = reader.codec.decode(
      reader.cursor,
      reader.binding,
    ).position;
    return reader.codec.encode(reader.binding, position);
  };
  const full = pollReader();
  const lines = [
    timedLog("boot", -1),
    ...Array.from({ length: 20 }, (_, index) => timedLog(`worker ${index} ready`, 0)),
  ];
  await full.poll(lines);
  assert.equal(full.codec.decode(full.cursor, full.binding).position.frontierCount, 20);
  assert.deepEqual(messages(await full.poll(lines, { query: { cursor: strip(full) } })), []);
  assert.deepEqual(messages(await full.poll([...lines, timedLog("worker connected", 1)])), [
    "worker connected",
  ]);

  const short = pollReader();
  const few = [timedLog("boot", -1), timedLog("retrying in 5s", 0), timedLog("retrying in 5s", 0)];
  await short.poll(few);
  assert.deepEqual(
    messages(
      await short.poll([...few, timedLog("retrying in 5s", 0)], {
        query: { cursor: strip(short) },
      }),
    ),
    ["retrying in 5s"],
  );

  const position = full.codec.decode(full.cursor, full.binding).position;
  const inconsistent = full.codec.encode(full.binding, {
    ...position,
    lastHashes: ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"],
    frontierCount: 1,
  });
  assert.equal(full.codec.decode(inconsistent, full.binding).status, "invalid");
  const untimed = full.codec.encode(full.binding, {
    ...position,
    lastTime: null,
    lastHashes: [],
    frontierCount: 1,
  });
  assert.equal(full.codec.decode(untimed, full.binding).status, "invalid");
});

test("runtime log route polling carries PEM masking through the serialized cursor", async () => {
  const { createRuntimeLogComputeDriver, createRuntimeLogFixture } =
    await import("../helpers/runtime-logs.mjs");
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  const lines = [
    timedLog(pemBegin, 0),
    timedLog(randomBytes(48).toString("base64"), 1),
    timedLog(syntheticPemTail, 2),
    timedLog(pemEnd, 3),
    timedLog("retrying in 5s", 4),
  ];
  let cursor;
  for (const count of [2, 3, 5]) {
    computeDriver.state.lines = lines.slice(0, count);
    const query = new URLSearchParams({
      source: "gateway",
      tailLines: "1000",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const response = await fixture.request("GET", target.logsPath(query.toString()));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.text.includes(syntheticPemTail),
      false,
      "the actual handler must not serialize the middle-poll fragment",
    );
    assert.equal(typeof response.data.cursor, "string");
    cursor = response.data.cursor;
    if (count === 5) {
      assert.ok(response.data.records.some((record) => record.message === "retrying in 5s"));
    }
  }
});

test("runtime log cursor keeps an ambiguous same-time close conservative", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  await reader.poll([timedLog(pemEnd, 0), timedLog("retrying in 5s", 0)]);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 1)]));
  await reader.poll([timedLog("retrying in 5s", 2)]);
  assert.ok(
    messages(await reader.poll([timedLog(syntheticPemTail, 3)])).includes(syntheticPemTail),
  );
});

test("runtime log cursor retains uncertainty for missing, malformed and reordered times", async (t) => {
  for (const [name, lines] of [
    ["missing", [timedLog(pemEnd, null), timedLog(syntheticPemTail, 1)]],
    ["malformed", [{ raw: pemEnd, time: "not-a-time" }, timedLog(syntheticPemTail, 1)]],
    ["reordered", [timedLog(pemEnd, 3), timedLog(syntheticPemTail, 2)]],
  ]) {
    await t.test(name, async () => {
      const reader = pollReader();
      await reader.poll([timedLog(pemBegin, 0)]);
      assertTailMasked(await reader.poll(lines));
      // Later timestamps cannot reconstruct the missing chronology of this view.
      await reader.poll([timedLog(pemEnd, 4)]);
      assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 5)]));
    });
  }
});

test("runtime log cursor keeps a later BEGIN on the same line as END", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  await reader.poll([timedLog(`${pemEnd} ${pemBegin}`, 1)]);
  assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
});

test("runtime log cursor rejects malformed or inconsistent signed PEM field pairs before reading", async () => {
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
  const position = reader.codec.decode(reader.cursor, reader.binding).position;
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
  await reader.poll([timedLog("retrying in 5s", 0)]);
  const position = reader.codec.decode(reader.cursor, reader.binding).position;
  const legacy = reader.codec.encode(reader.binding, {
    ...position,
    pemOpen: undefined,
    pemAfterTime: undefined,
  });
  assert.equal(reader.codec.decode(legacy, reader.binding).position.pemOpen, undefined);
  // No observed BEGIN and no END: short arbitrary text remains best-effort.
  const page = await reader.poll([timedLog(syntheticPemTail, 1)], { query: { cursor: legacy } });
  assert.ok(messages(page).includes(syntheticPemTail));
  assert.equal(reader.codec.decode(page.cursor, reader.binding).position.pemOpen, undefined);
});

test("runtime log cursor keeps the frontier stable on replay and does not inspect undelivered lookahead", async () => {
  const reader = pollReader();
  const begin = timedLog(pemBegin, 0);
  await reader.poll([begin]);
  const prior = reader.codec.decode(reader.cursor, reader.binding).position;
  await reader.poll([begin]);
  const replay = reader.codec.decode(reader.cursor, reader.binding).position;
  assert.equal(replay.pemOpen, true);
  assert.equal(replay.pemAfterTime, prior.pemAfterTime);
  // A malformed future line beyond the response cut is not consumed evidence.
  const page = await reader.poll([
    ...Array.from({ length: 70 }, (_, i) =>
      timedLog(
        JSON.stringify({
          level: "info",
          subsystem: "gateway",
          message: "ordinary diagnostic ".repeat(500),
        }),
        i + 1,
      ),
    ),
    { raw: pemEnd, time: null },
  ]);
  assert.equal(page.truncated, true);
  const frontier = reader.codec.decode(page.cursor, reader.binding).position;
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
  const reader = pollReader();
  await reader.poll([timedLog(pemBegin, 0)]);
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
            await reader.poll([timedLog("retrying in 5s", 0)]);
            assert.equal(
              reader.codec.decode(reader.cursor, reader.binding).position.pemOpen,
              undefined,
            );
          }
          // BEGIN is observed in this very page. Missing earlier cursor context does
          // not make this older END valid evidence of a close.
          await reader.poll([timedLog(pemBegin, beginTime), timedLog(pemEnd, 1)]);
          const context = reader.codec.decode(reader.cursor, reader.binding).position;
          const next = await reader.poll([
            timedLog(syntheticPemTail, 4),
            timedLog("retrying in 5s", 5),
          ]);
          assertTailMasked(next);
          assert.ok(messages(next).includes("retrying in 5s"));
          assert.equal(context.pemOpen, true);
          assert.equal(context.pemAfterTime, null);
        },
      );
    }
  }
});

test("runtime container wire pages include escaped messages, cursor and HTTP metadata in the limit", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-budget");
  const started = Date.now() - 1000;
  fixture.computeDriver.state.lines = Array.from({ length: 70 }, (_, index) => ({
    time: new Date(started + index).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; 网络🙂 process arguments: ${'--option="value" '.repeat(500)}`,
    }),
  }));
  const seen = [];
  let cursor;
  let pages = 0;
  let firstCount;
  do {
    const response = await fixture.request(
      "GET",
      target.logsPath(
        `source=gateway&tailLines=200${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.equal(response.body.meta.requestId.length, 40);
    assert.equal(
      Buffer.byteLength(response.text, "utf8"),
      Buffer.byteLength(JSON.stringify(response.body), "utf8"),
      "the actual formatter matches measured JSON, including Unicode",
    );
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    if (pages === 0) {
      firstCount = lines.length;
      assert.equal(response.data.truncated, true);
    }
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    pages += 1;
    if (!response.data.truncated) {
      break;
    }
    assert.ok(lines.length > 0, "a byte-cut page must advance");
  } while (pages < 10);
  assert.ok(firstCount > 0 && firstCount < 70);
  assert.deepEqual(
    seen,
    Array.from({ length: 70 }, (_, index) => index),
  );
  const replay = await fixture.request("GET", target.logsPath(`source=gateway&cursor=${cursor}`));
  assert.deepEqual(replay.data.records, []);
  assert.equal(
    fixture.computeDriver.calls.filter(({ operation }) => operation === "read").length,
    pages + 1,
    "prefix builds do not read the Driver again",
  );
  assert.equal(
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view")
      .length,
    1,
    "prefix builds and continuation do not open extra views",
  );
  const download = await fixture.request("GET", target.logsPath("source=gateway&download=true"));
  assert.equal(download.status, 200);
  assert.ok(Buffer.byteLength(download.text, "utf8") <= 512 * 1024);
});

test("runtime container checkpoint suffixes survive append-only growth to a full tail", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const { tail, identical } of [
    { tail: 100, identical: false },
    { tail: 300, identical: false },
    { tail: 100, identical: true },
  ]) {
    const cursorSecret = randomBytes(32).toString("hex");
    const fixture = await createRuntimeLogFixture({
      agentRuntimeLogs: { enabled: true, cursorSecret },
    });
    const target = await fixture.deployAgent("wire-budget-growing-tail");
    const time = new Date(Date.now() - 1000).toISOString();
    const row = (index, large = false) => ({
      time,
      raw:
        large && tail === 300
          ? `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`
          : JSON.stringify({
              level: "info",
              subsystem: "gateway",
              message: `row=${identical ? 7 : index}; ${large || identical ? '--option="value" '.repeat(500) : "anchor"}`,
            }),
    });
    const ids = (page) => messages(page).map((message) => Number(/row=(\d+);/.exec(message)[1]));
    fixture.computeDriver.state.lines = Array.from({ length: 20 }, (_, index) => row(index));
    const prime = await fixture.request("GET", target.logsPath(`source=gateway&tailLines=${tail}`));
    assert.equal(prime.status, 200);
    const seen = ids(prime.data);
    assert.equal(seen.length, 20, "the baseline exceeds the retained frontier hash history");
    fixture.computeDriver.state.lines.push(
      ...Array.from({ length: tail - 21 }, (_, index) => row(index + 20, true)),
    );
    assert.ok(
      fixture.computeDriver.state.lines.reduce(
        (bytes, line) => bytes + Buffer.byteLength(line.raw) + 32,
        0,
      ) <
        1024 * 1024,
    );
    let cursor = prime.data.cursor;
    let cuts = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await fixture.request(
        "GET",
        target.logsPath(`source=gateway&tailLines=${tail}&cursor=${cursor}`),
      );
      assert.equal(response.status, 200);
      assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
      assert.ok(response.data.cursor.length <= 2048);
      seen.push(...ids(response.data));
      cuts += response.data.truncated ? 1 : 0;
      cursor = response.data.cursor;
      if (identical && page > 0) {
        assert.ok(
          response.data.records.some(
            ({ type, reason }) => type === "gap" && reason === "window_exceeded",
          ),
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
          const parts = cursor.split(".");
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
          if (payload.cw.length === 11) {
            payload.cw.pop();
          }
          const legacyPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
          const mac = createHmac("sha256", cursorSecret)
            .update("occ-runtime-logs-cursor")
            .update("\0")
            .update(legacyPayload)
            .digest("base64url");
          const legacy = await fixture.request(
            "GET",
            target.logsPath(`source=gateway&tailLines=100&cursor=v1.${legacyPayload}.${mac}`),
          );
          assert.equal(
            legacy.status,
            200,
            "legacy windows remain usable on their stable short source",
          );
          assert.deepEqual(
            ids(legacy.data),
            Array.from({ length: 99 - seen.length }, (_, index) => index + seen.length),
          );
        }
        fixture.computeDriver.state.lines.push(row(tail - 1, true));
      }
      if (!response.data.truncated) {
        break;
      }
    }
    assert.deepEqual(
      seen,
      Array.from({ length: tail }, (_, index) => (identical ? 7 : index)),
    );
    const replay = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=${tail}&cursor=${cursor}`),
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(ids(replay.data), []);
    if (tail === 300) {
      assert.ok(cuts >= 2, "positional proof survives multiple full-tail cuts");
    }
  }
});

test("container byte-cut checkpoints retain untimed progress or advance mixed windows", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const mixed of [false, true]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-untimed-driver-cut");
    const count = 330;
    const started = Date.now() - 40_000;
    fixture.computeDriver.state.lines = [
      ...Array.from({ length: count }, (_, index) => ({
        time: mixed && index > 0 ? new Date(started + index * 118).toISOString() : null,
        raw: `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`,
      })),
      { time: null, raw: "partial trailing row" },
    ];
    fixture.computeDriver.state.truncated = true;
    assert.ok(
      fixture.computeDriver.state.lines.reduce(
        (bytes, line) => bytes + Buffer.byteLength(line.raw) + 32,
        0,
      ) <
        1024 * 1024,
    );
    const seen = [];
    let cursor;
    let pages = 0;
    let drained;
    while (seen.length < count && pages < 10) {
      const response = await fixture.request(
        "GET",
        target.logsPath(
          `source=gateway&tailLines=1000${cursor === undefined ? "" : `&cursor=${cursor}`}`,
        ),
      );
      assert.equal(response.status, 200);
      assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
      assert.equal(response.data.truncated, true, "the underlying Driver cut remains visible");
      const rows = messages(response.data).map((message) => Number(/row=(\d+);/.exec(message)[1]));
      assert.ok(rows.length > 0, "each wire cut advances through the complete fetched prefix");
      seen.push(...rows);
      cursor = response.data.cursor;
      drained = response.data;
      pages += 1;
    }
    assert.ok(pages > 1);
    assert.deepEqual(
      seen,
      Array.from({ length: count }, (_, index) => index),
    );
    if (mixed) {
      assert.ok(
        drained.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
        "timed advancement explicitly resets the uncertain window",
      );
      const next = await fixture.request(
        "GET",
        target.logsPath(`source=gateway&tailLines=1000&cursor=${cursor}`),
      );
      assert.equal(next.status, 200);
      const resumedRead = fixture.computeDriver.calls
        .filter(({ operation }) => operation === "read")
        .at(-1);
      assert.ok(
        Number.isInteger(resumedRead.sinceSeconds) && resumedRead.sinceSeconds <= 10,
        "the supported Driver receives a recent floor instead of rereading the entire old byte-cut window",
      );
      continue;
    }
    for (let poll = 0; poll < 2; poll += 1) {
      const replay = await fixture.request(
        "GET",
        target.logsPath(`source=gateway&tailLines=1000&cursor=${cursor}`),
      );
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
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-budget-boundaries");
  const row = (raw, index = 0) => ({
    raw,
    time: new Date(Date.now() - 1000 + index).toISOString(),
  });
  for (const lines of [
    [],
    [
      row(
        JSON.stringify({
          level: "info",
          subsystem: "gateway",
          message: `single 网络🙂 ${'--option="value" '.repeat(500)}`,
        }),
      ),
    ],
  ]) {
    fixture.computeDriver.state.lines = lines;
    const response = await fixture.request("GET", target.logsPath("source=gateway&tailLines=200"));
    assert.equal(response.status, 200);
    assert.equal(response.data.truncated, false);
    assert.equal(response.data.records.filter(({ type }) => type === "line").length, lines.length);
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
  }
  fixture.computeDriver.state.lines = Array.from({ length: 80 }, (_, index) =>
    row(JSON.stringify({ ordinary_metadata: "diagnostic ".repeat(900) }), index),
  );
  const withheld = await fixture.request("GET", target.logsPath("source=gateway&tailLines=200"));
  assert.equal(withheld.status, 200);
  assert.equal(
    withheld.data.truncated,
    false,
    "a compact withheld run fits even when its input is large",
  );
  assert.equal(withheld.data.withheld, 80);
  assert.equal(withheld.data.records[0].count, 80);
  assert.ok(Buffer.byteLength(withheld.text, "utf8") <= 512 * 1024);
  const replay = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${withheld.data.cursor}`),
  );
  assert.deepEqual(replay.data.records, []);
});

function wireContainerRows(time, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time,
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; diagnostic ${'--option="value" '.repeat(500)}`,
    }),
  }));
}

test("container byte-window checkpoints drain full same-time and untimed tails", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const time of [new Date(Date.now() - 1000).toISOString(), null]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-window");
    fixture.computeDriver.state.lines = wireContainerRows(time);
    const seen = [];
    let cursor;
    let first;
    for (let page = 0; page < 10; page += 1) {
      const response = await fixture.request(
        "GET",
        target.logsPath(
          `source=gateway&tailLines=60${cursor === undefined ? "" : `&cursor=${cursor}`}`,
        ),
      );
      assert.equal(response.status, 200);
      assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
      const lines = response.data.records.filter(({ type }) => type === "line");
      if (page === 0) {
        first = lines.length;
        assert.equal(response.data.truncated, true);
      }
      seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
      cursor = response.data.cursor;
      if (!response.data.truncated) {
        break;
      }
      assert.ok(lines.length > 0);
    }
    assert.ok(first > 16 && first < 60);
    assert.deepEqual(
      seen,
      Array.from({ length: 60 }, (_, index) => index),
    );
    const replay = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=60&cursor=${cursor}`),
    );
    assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
  }
});

test("container byte-window changes expose a fresh snapshot and fitting untimed progress", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const changed of ["value", "tail", "buffer"]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-window-change");
    fixture.computeDriver.state.lines = wireContainerRows(null);
    const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
    assert.equal(first.data.truncated, true);
    if (changed === "value") {
      fixture.computeDriver.state.lines[59] = {
        time: null,
        raw: JSON.stringify({ level: "info", message: "changed suffix" }),
      };
    }
    if (changed === "buffer") {
      fixture.computeDriver.state.lines.splice(25);
    }
    const tail = changed === "tail" ? 25 : 60;
    const next = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=${tail}&cursor=${first.data.cursor}`),
    );
    assert.equal(next.status, 200);
    assert.ok(Buffer.byteLength(next.text) <= 512 * 1024);
    assert.ok(
      next.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
      changed,
    );
    assert.ok(
      next.data.records.some(({ type }) => type === "line"),
      changed,
    );
    if (changed !== "value") {
      assert.equal(next.data.truncated, false);
      const replay = await fixture.request(
        "GET",
        target.logsPath(`source=gateway&tailLines=${tail}&cursor=${next.data.cursor}`),
      );
      assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0, changed);
    }
  }
});

test("container byte-window checkpoints retain the pre-cut deduplication baseline", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("container-window-baseline");
  const time = new Date(Date.now() - 1000).toISOString();
  const anchor = { time, raw: JSON.stringify({ level: "info", message: "previous diagnostic" }) };
  fixture.computeDriver.state.lines = [anchor];
  const initial = await fixture.request("GET", target.logsPath("source=gateway&tailLines=100"));
  fixture.computeDriver.state.lines = [
    anchor,
    ...wireContainerRows(new Date(Date.parse(time) + 1).toISOString()),
  ];
  let cursor = initial.data.cursor;
  const seen = [];
  for (let page = 0; page < 10; page += 1) {
    const response = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=100&cursor=${cursor}`),
    );
    const lines = response.data.records.filter(({ type }) => type === "line");
    assert.ok(lines.every(({ message }) => message !== "previous diagnostic"));
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 60 }, (_, index) => index),
  );
});

test("container byte-window progress does not cross UID or restart changes", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const changed of ["uid", "restart"]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-window-instance");
    fixture.computeDriver.state.lines = wireContainerRows(
      new Date(Date.now() - 1000).toISOString(),
    );
    const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
    assert.equal(first.data.truncated, true);
    if (changed === "uid") {
      fixture.computeDriver.state.podUid = randomUUID();
    } else {
      fixture.computeDriver.state.restartCount += 1;
    }
    const next = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=60&cursor=${first.data.cursor}`),
    );
    assert.equal(next.status, 200);
    assert.ok(
      next.data.records.some(({ type, reason }) => type === "gap" && reason === "stream_replaced"),
    );
    assert.ok(
      next.data.records.some(
        ({ type, message }) => type === "line" && message.startsWith("row=0;"),
      ),
    );
  }
});

test("container changed byte-windows keep PEM masking conservative", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("container-window-pem");
  const time = new Date(Date.now() - 1000).toISOString();
  fixture.computeDriver.state.lines = wireContainerRows(time);
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
  assert.equal(first.data.truncated, true);
  fixture.computeDriver.state.lines[30] = {
    time,
    raw: pemBegin,
  };
  fixture.computeDriver.state.lines[31] = {
    time,
    raw: syntheticPemTail,
  };
  const replacement = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=60&cursor=${first.data.cursor}`),
  );
  assert.equal(replacement.status, 200);
  assert.ok(
    replacement.data.records.some(
      ({ type, reason }) => type === "gap" && reason === "window_exceeded",
    ),
  );
  assertTailMasked(replacement.data);
  fixture.computeDriver.state.lines = [
    {
      time: new Date(Date.parse(time) + 1).toISOString(),
      raw: syntheticPemTail,
    },
  ];
  const carried = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=60&cursor=${replacement.data.cursor}`),
  );
  assertTailMasked(carried.data);
});

test("container byte-window baselines reset when the Driver observes an instance change during read", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const changed of ["uid", "restart"]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-window-reread");
    const time = new Date(Date.now() - 1000).toISOString();
    fixture.computeDriver.state.lines = [
      {
        time: new Date(Date.parse(time) + 100).toISOString(),
        raw: JSON.stringify({ level: "info", message: "prior instance" }),
      },
    ];
    const initial = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
    fixture.computeDriver.state.lines = wireContainerRows(time);
    if (changed === "uid") {
      fixture.computeDriver.state.readPodUid = randomUUID();
    } else {
      fixture.computeDriver.state.readRestartCount = 1;
    }
    const replaced = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=60&cursor=${initial.data.cursor}`),
    );
    assert.equal(replaced.data.truncated, true);
    assert.ok(
      replaced.data.records.some(
        ({ type, reason }) => type === "gap" && reason === "stream_replaced",
      ),
    );
    if (changed === "uid") {
      fixture.computeDriver.state.podUid = fixture.computeDriver.state.readPodUid;
    } else {
      fixture.computeDriver.state.restartCount = fixture.computeDriver.state.readRestartCount;
    }
    const rest = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=60&cursor=${replaced.data.cursor}`),
    );
    assert.equal(rest.status, 200);
    const seen = [...replaced.data.records, ...rest.data.records]
      .filter(({ type }) => type === "line")
      .map(({ message }) => Number(/^row=(\d+);/.exec(message)[1]));
    assert.deepEqual(
      seen,
      Array.from({ length: 60 }, (_, index) => index),
    );
  }
});

test("container expanded byte-windows preserve valid conservative PEM cursors", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const changed of ["expanded", "empty"]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-window-recovery");
    const time = new Date(Date.now() - 1000).toISOString();
    const before = new Date(Date.parse(time) - 2000).toISOString();
    fixture.computeDriver.state.lines = [{ time: before, raw: pemEnd }];
    const prime = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
    const older = Array.from({ length: 100 }, (_, i) => ({
      time: new Date(Date.parse(time) - 1000).toISOString(),
      raw: `[info] older row=${i}; diagnostic ${'"a" '.repeat(1000)}`,
    }));
    const current = wireContainerRows(time);
    fixture.computeDriver.state.lines = [...older, ...current];
    const first = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=60&cursor=${prime.data.cursor}`),
    );
    assert.equal(first.data.truncated, true);
    if (changed === "empty") {
      fixture.computeDriver.state.lines = [];
    }
    const seen = [];
    let cursor = first.data.cursor;
    for (let page = 0; page < 10; page += 1) {
      const response = await fixture.request(
        "GET",
        target.logsPath(`source=gateway&tailLines=160&cursor=${cursor}`),
      );
      assert.equal(response.status, 200, "recovery must not poison the next signed cursor");
      assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
      const lines = response.data.records.filter(({ type }) => type === "line");
      seen.push(...lines.map(({ message }) => message.split(";", 1)[0]));
      cursor = response.data.cursor;
      if (!response.data.truncated) {
        break;
      }
    }
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
    const replay = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=160&cursor=${cursor}`),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
  }
});

test("container empty checkpoint recovery suppresses the next single untimed snapshot", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("container-empty-window");
  fixture.computeDriver.state.lines = wireContainerRows(null);
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=60"));
  assert.equal(first.data.truncated, true);
  fixture.computeDriver.state.lines = [];
  const empty = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=60&cursor=${first.data.cursor}`),
  );
  assert.equal(empty.status, 200);
  fixture.computeDriver.state.lines = [
    {
      time: null,
      raw: JSON.stringify({ level: "info", subsystem: "gateway", message: "worker ready" }),
    },
  ];
  const single = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=60&cursor=${empty.data.cursor}`),
  );
  assert.equal(single.data.records.filter(({ type }) => type === "line").length, 1);
  const replay = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=60&cursor=${single.data.cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});

test("container checkpoints preserve the existing overlap through backend processing delay", async () => {
  const { createRuntimeLogFixture, createRuntimeLogComputeDriver } =
    await import("../helpers/runtime-logs.mjs");
  const underlying = createRuntimeLogComputeDriver();
  const read = underlying.readAgentRuntimeLogs.bind(underlying);
  let calls = 0;
  const driver = {
    ...underlying,
    async readAgentRuntimeLogs(binding, request) {
      calls += 1;
      if (calls === 1) {
        const time = new Date(Date.now() - request.sinceSeconds * 1000 + 500).toISOString();
        underlying.state.lines = wireContainerRows(time);
      }
      const chunk = await read(binding, request);
      // Equivalent backend processing time, without changing the host clock or reader.
      const floor = Date.now() + (calls === 1 ? 0 : 1800) - request.sinceSeconds * 1000;
      return { ...chunk, lines: chunk.lines.filter(({ time }) => Date.parse(time) >= floor) };
    },
  };
  const fixture = await createRuntimeLogFixture({ computeDriver: driver });
  const target = await fixture.deployAgent("container-processing-delay");
  const first = await fixture.request(
    "GET",
    target.logsPath("source=gateway&tailLines=200&sinceSeconds=60"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  const next = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=200&cursor=${first.data.cursor}`),
  );
  assert.equal(next.status, 200);
  const seen = [...messages(first.data), ...messages(next.data)].map((message) =>
    Number(/^row=(\d+);/.exec(message)[1]),
  );
  assert.deepEqual(
    seen,
    Array.from({ length: 60 }, (_, index) => index),
  );
});

test("container checkpoint windows remain stable when relative seconds round outward", async () => {
  const { createRuntimeLogFixture, createRuntimeLogComputeDriver } =
    await import("../helpers/runtime-logs.mjs");
  for (const skew of [0, 2000]) {
    const underlying = createRuntimeLogComputeDriver();
    const read = underlying.readAgentRuntimeLogs.bind(underlying);
    const driver = {
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
    const fixture = await createRuntimeLogFixture({ computeDriver: driver });
    const target = await fixture.deployAgent("container-relative-window");
    const now = Date.now();
    const time = new Date(now - (skew === 0 ? 1000 : 11000)).toISOString();
    const rows = wireContainerRows(time);
    underlying.state.lines = [
      {
        time: new Date(now - skew - 10050).toISOString(),
        raw: JSON.stringify({
          level: "info",
          subsystem: "gateway",
          message: "older than original window",
        }),
      },
      ...rows,
    ];
    const first = await fixture.request(
      "GET",
      target.logsPath("source=gateway&tailLines=61&sinceSeconds=10"),
    );
    assert.equal(first.data.truncated, true);
    const rest = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&tailLines=61&cursor=${first.data.cursor}`),
    );
    assert.equal(rest.status, 200);
    assert.equal(rest.data.truncated, false);
    const seen = [...first.data.records, ...rest.data.records]
      .filter(({ type }) => type === "line")
      .map(({ message }) => message.split(";", 1)[0]);
    assert.deepEqual(
      seen,
      rows.map(({ raw }) => JSON.parse(raw).message.split(";", 1)[0]),
    );
    assert.ok(
      !rest.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
    );
  }
});

test("container wire-prefix builds retain fetched masking evidence without advancing PEM state", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("container-mask-evidence");
  const start = Date.now() - 1000;
  fixture.computeDriver.state.lines = [
    ...wireContainerRows(null, 50),
    ...Array.from({ length: 300 }, () => ({ time: null, raw: "QUJD" })),
    { time: null, raw: pemEnd },
  ].map((line, index) => ({ ...line, time: new Date(start + index).toISOString() }));
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=1000"));
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  assert.ok(!messages(first.data).includes("QUJD"));
  const payload = JSON.parse(Buffer.from(first.data.cursor.split(".")[1], "base64url").toString());
  assert.equal(payload.po, undefined, "an undelivered END must not advance persistent PEM state");
  const rest = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=1000&cursor=${first.data.cursor}`),
  );
  assert.equal(rest.status, 200);
  assert.ok(!messages(rest.data).includes("QUJD"));
});

test("container wire continuation retains fetched JSON withholding decisions", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  for (const offset of [0]) {
    const fixture = await createRuntimeLogFixture();
    const target = await fixture.deployAgent("container-json-evidence");
    const start = Date.now() - 1000;
    const rows = [
      ...wireContainerRows(null, 42).map((line, index) => ({
        ...line,
        raw: JSON.stringify({
          level: "info",
          subsystem: "gateway",
          message: `row=${index}; diagnostic ${" ".repeat(500)}${'"a" '.repeat(2100)}`,
        }),
      })),
      ...Array.from({ length: offset }, () => ({
        raw: JSON.stringify({ ordinary_metadata: "padding" }),
        time: null,
      })),
      { raw: "[", time: null },
      ...Array.from({ length: 15 }, () => [
        { raw: "1".repeat(32769) + ",", time: null },
        { raw: "  true,", time: null },
      ]).flat(),
      { raw: "]", time: null },
    ];
    fixture.computeDriver.state.lines = rows.map((line, index) => ({
      ...line,
      time: new Date(start + index).toISOString(),
    }));
    assert.ok(
      fixture.computeDriver.state.lines.reduce(
        (bytes, line) => bytes + Buffer.byteLength(line.raw) + Buffer.byteLength(line.time) + 2,
        0,
      ) <=
        1024 * 1024,
      "the whole fetched fixture respects the Driver read bound",
    );
    let cursor;
    let cut = false;
    for (let page = 0; page < 10; page += 1) {
      const response = await fixture.request(
        "GET",
        target.logsPath(
          `source=gateway&tailLines=1000${cursor === undefined ? "" : `&cursor=${cursor}`}`,
        ),
      );
      assert.equal(response.status, 200);
      assert.ok(!messages(response.data).some((message) => message.trim() === "true,"));
      cursor = response.data.cursor;
      cut ||= response.data.truncated;
      if (!response.data.truncated) {
        break;
      }
    }
    assert.equal(cut, true);
  }
});

test("container follows a growing full wire-cut tail without replaying its delivered prefix", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("full-growing-wire-tail");
  const start = Date.now() - 120_000;
  const row = (index) => ({
    time: new Date(start + index * 1000).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    }),
  });
  fixture.computeDriver.state.lines = Array.from({ length: 100 }, (_, index) => row(index));
  let cursor;
  const seen = [];
  const counts = [];
  for (let poll = 0; poll < 6; poll += 1) {
    if (poll > 0) {
      const offset = fixture.computeDriver.state.lines.length;
      fixture.computeDriver.state.lines.push(
        ...Array.from({ length: 3 }, (_, index) => row(offset + index)),
      );
    }
    const response = await fixture.request(
      "GET",
      target.logsPath(
        `source=gateway&tailLines=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    counts.push(lines.length);
    if (poll === 0) {
      assert.equal(response.data.truncated, true);
    }
    cursor = response.data.cursor;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 115 }, (_, index) => index),
  );
  assert.deepEqual(counts.slice(2), [3, 3, 3, 3]);
  const replay = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=100&cursor=${cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line"),
    [],
  );
});

test("container checkpoint recovery does not duplicate an observed window-loss gap", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-cut-burst-gap");
  const start = Date.now() - 120_000;
  const row = (index) => ({
    time: new Date(start + index * 1000).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    }),
  });
  fixture.computeDriver.state.lines = Array.from({ length: 100 }, (_, index) => row(index));
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=100"));
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  // The burst replaces the whole tail before the byte-cut snapshot drains.
  // Actual missing rows still require one window gap, not a second gap for the
  // discarded checkpoint alongside that same observed loss.
  fixture.computeDriver.state.lines.push(
    ...Array.from({ length: 100 }, (_, index) => row(100 + index)),
  );
  const second = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=100&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.ok(Buffer.byteLength(second.text) <= 512 * 1024);
  assert.equal(
    second.data.records.filter(({ type, reason }) => type === "gap" && reason === "window_exceeded")
      .length,
    1,
  );
});

test("container checkpoint recovery keeps an unknown-time reset visible", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-cut-unknown-reset");
  const start = Date.now() - 120_000;
  fixture.computeDriver.state.lines = Array.from({ length: 80 }, (_, index) => ({
    time: index === 0 ? null : new Date(start + index * 1000).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    }),
  }));
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=100"));
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  // The timed frontier cannot locate an unknown row in a changed snapshot.
  // Recovering timed rows must keep that reset visible, even on a short tail.
  fixture.computeDriver.state.lines[0] = { time: null, raw: "changed unknown-time diagnostic" };
  const second = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=100&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.ok(
    second.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
  );
});

test("container shortened timed checkpoints disclose missing undelivered rows", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-cut-shortened-timed-window");
  const start = Date.now() - 120_000;
  fixture.computeDriver.state.lines = Array.from({ length: 80 }, (_, index) => ({
    time: new Date(start + index * 1000).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    }),
  }));
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=100"));
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  // Rotation can leave a short surviving window in the same container. Its
  // later times establish progress, not continuity with the unread snapshot.
  fixture.computeDriver.state.lines = fixture.computeDriver.state.lines.slice(-5);
  const second = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=100&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.records.filter(({ type }) => type === "line").length, 5);
  assert.ok(
    second.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
  );
});

test("container same-size short replacements disclose missing undelivered rows", async () => {
  const { createRuntimeLogFixture } = await import("../helpers/runtime-logs.mjs");
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("wire-cut-same-size-short-window");
  const start = Date.now() - 120_000;
  fixture.computeDriver.state.lines = Array.from({ length: 80 }, (_, index) => ({
    time: new Date(start + index * 1000).toISOString(),
    raw: JSON.stringify({
      level: "info",
      subsystem: "gateway",
      message: `old=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    }),
  }));
  const first = await fixture.request("GET", target.logsPath("source=gateway&tailLines=100"));
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  // Rotation retains the same row count but replaces the unread part with newer rows.
  fixture.computeDriver.state.lines = Array.from({ length: 80 }, (_, index) => ({
    time: new Date(start + (100 + index) * 1000).toISOString(),
    raw: JSON.stringify({ level: "info", subsystem: "gateway", message: `new=${index}` }),
  }));
  const second = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&tailLines=100&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.records.filter(({ type }) => type === "line").length, 80);
  assert.equal(
    second.data.records.filter(({ type, reason }) => type === "gap" && reason === "window_exceeded")
      .length,
    1,
  );
});
