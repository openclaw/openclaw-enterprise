import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maskRuntimeEventText,
  redactRuntimeLogText,
} from "../../packages/occ/src/runtime-logs/redact.ts";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { readRuntimeLogPage } from "../../packages/occ/src/runtime-logs/read.ts";
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
  const codex = lines.find((record) => record.kind === "codex");
  assert.equal(codex.message, "retrying model request");
  assert.equal(codex.subsystem, "codex_core::client");
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
      const started = performance.now();
      sanitizeRuntimeLogChunk({
        stream,
        truncated: false,
        lines: ["-----BEGIN X-----", hostile + suffix, hostile + suffix, "-----END X-----"].map(
          (raw, index) => ({ time: lineTime(index), raw }),
        ),
      });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 400, `${JSON.stringify(unit)} took ${elapsed.toFixed(0)} ms`);
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
      const started = performance.now();
      redactRuntimeLogText(input);
      maskRuntimeEventText(input);
      const elapsed = performance.now() - started;
      assert.ok(
        elapsed < budgetMs,
        `${JSON.stringify(unit)} + ${JSON.stringify(suffix)} took ${elapsed.toFixed(0)} ms`,
      );
    }
  }
  // A whole page of such messages stays well inside one request's budget.
  const started = performance.now();
  sanitizeRuntimeLogChunk({
    stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
    truncated: false,
    lines: Array.from({ length: 50 }, (_, index) => ({
      time: lineTime(index),
      raw: JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
    })),
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50 * budgetMs, `50 hostile lines took ${elapsed.toFixed(0)} ms`);
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
    const unitStarted = performance.now();
    redactRuntimeLogText(input);
    maskRuntimeEventText(input);
    const elapsed = performance.now() - unitStarted;
    if (elapsed > worst.elapsed) {
      worst = { unit, elapsed };
    }
  }
  const total = performance.now() - started;
  assert.ok(
    worst.elapsed < budgetMs,
    `${JSON.stringify(worst.unit)} took ${worst.elapsed.toFixed(0)} ms (sweep total ${total.toFixed(0)} ms)`,
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
      { kind: "codex", level: "info", message: "close", subsystem: "codex_core::client" },
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
  const now = Date.parse("2026-09-30T12:10:00Z");
  return {
    codec,
    binding,
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
        readLogs: async () => {
          reads += 1;
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
    ...Array.from({ length: 70 }, (_, i) => timedLog("A".repeat(8192), i + 1)),
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
    ...Array.from({ length: 70 }, (_, i) => timedLog("A".repeat(8192), i + 1)),
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
