import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Check } from "typebox/value";

import {
  AgentRuntimeLogsResponse,
  AgentRuntimeResponse,
  ErrorResponse,
  type AgentRuntimeLogPageWire,
  type RuntimeLogRecord,
  type RuntimeLogStream,
} from "../../packages/contracts/src/index.ts";
import {
  sanitizeRuntimeLogChunk,
  type SanitizedRuntimeLogChunk,
} from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { cpuTimeMs } from "../helpers/cpu-time.ts";
import { logsRoute } from "../helpers/runtime-logs-content.ts";

const corpusUrl = new URL("../fixtures/runtime-logs/canary-corpus.txt", import.meta.url);
const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Canaries are generated per run so no credential-shaped value is committed.
export function randomString(length: number, alphabet = alphanumeric) {
  return Array.from({ length }, () => alphabet.charAt(randomInt(alphabet.length))).join("");
}

function canaries() {
  const base64url = (value: Record<string, string>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
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

export function lineTime(index: number) {
  return `2026-09-30T12:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(9, "0")}Z`;
}

type CorpusCanaries = ReturnType<typeof canaries> & { DEEP: string; CONTROL: string };
type NestedLogFields = { nested?: NestedLogFields; secret?: string };

async function corpusLines(values: CorpusCanaries) {
  const replacements = new Map(Object.entries(values));
  const template = await readFile(corpusUrl, "utf8");
  const lines = template
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line.replace(/\{\{([A-Z_0-9]+)\}\}/g, (_match: string, name: string) => {
        const value = replacements.get(name);
        assert.ok(value !== undefined, `unknown corpus canary ${name}`);
        return value;
      }),
    );
  // Hostile shapes that a text fixture cannot carry literally.
  const deep: NestedLogFields & { level: string; message: string } = {
    level: "info",
    message: "deep",
  };
  let cursor: NestedLogFields = deep;
  for (let depth = 0; depth < 12; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  cursor.secret = values.DEEP;
  lines.push(JSON.stringify(deep));
  lines.push(`\u001b[31mcolored\u001b[0m output\u0007 with ${values.CONTROL} and \u0000nul`);
  return lines.map((raw, index) => ({ time: lineTime(index), raw }));
}

export const gatewayStream: RuntimeLogStream = {
  source: "gateway",
  pod: "gateway-0",
  container: "gateway",
};
export const agentStream: RuntimeLogStream = {
  source: "agent",
  pod: "gateway-0",
  container: "agent",
};
const agentPodStream: RuntimeLogStream = { source: "agent", pod: "agent-0", container: "agent" };

// One sanitizer pass over raw lines timed lineTime(first), lineTime(first + 1), ...
export function sanitize(
  stream: RuntimeLogStream,
  raws: readonly string[],
  {
    first = 0,
    truncated = false,
  }: { first?: number | undefined; truncated?: boolean | undefined } = {},
) {
  return sanitizeRuntimeLogChunk({
    stream,
    truncated,
    lines: raws.map((raw, index) => ({ time: lineTime(first + index), raw })),
  });
}

type LineRecord = Extract<RuntimeLogRecord, { type: "line" }>;
type LogFields = NonNullable<LineRecord["fields"]>;
type ModelProbeEvent = "openclaw.model_probe" | "codex.model_probe";

function requireLine(record: RuntimeLogRecord | undefined): LineRecord {
  assert.ok(record?.type === "line");
  return record;
}

function lineMessage(record: RuntimeLogRecord) {
  return record.type === "line" ? record.message : undefined;
}

function requireTruncationGap(record: AgentRuntimeLogPageWire["records"][number] | undefined) {
  assert.ok(record?.type === "gap");
  assert.equal(record.reason, "truncated");
}

function openclawError(message: string) {
  return JSON.stringify({ level: "error", message });
}

function assertNoCanary(text: string, values: Readonly<Record<string, string>>, where: string) {
  for (const [name, value] of Object.entries(values)) {
    if (name !== "CONTROL") {
      assert.equal(text.includes(value), false, `canary ${name} leaked ${where}`);
    }
  }
}

// Serves raw Gateway container lines, timed lineTime(0), lineTime(1), ..., through the logs
// route. Returns the page's messages and the download; neither body may contain a secret.
async function routeMessages(raws: readonly string[], secrets: readonly string[]) {
  const route = await logsRoute();
  route.state.lines = raws.map((raw, index) => ({ time: lineTime(index), raw }));
  const logs = await route.read({ tailLines: 100 });
  assert.equal(logs.status, 200, logs.text);
  const { body } = logs;
  assert.ok(Check(AgentRuntimeLogsResponse, body), "expected a runtime log response");
  const download = await route.read({ download: true });
  assert.equal(download.status, 200, download.text);
  for (const value of secrets) {
    assert.equal(logs.text.includes(value), false, `${value.slice(0, 4)}... leaked`);
    assert.equal(download.text.includes(value), false, `${value.slice(0, 4)}... leaked`);
  }
  return {
    messages: body.data.records.map((record) =>
      record.type === "line" ? record.message : undefined,
    ),
    download: download.text,
  };
}

function wrapperRecords({ records }: Pick<SanitizedRuntimeLogChunk, "records">) {
  return records.map((record) => {
    if (record.type === "line") {
      const { kind, level, message, fields } = record;
      return { kind, level, message, fields };
    }
    return { kind: undefined, level: undefined, message: undefined, fields: undefined };
  });
}

// Line messages, and withheld runs as `withheld <count>`.
function withheldSummary(page: Pick<SanitizedRuntimeLogChunk, "records">) {
  return page.records.map((record) =>
    record.type === "withheld" ? `withheld ${record.count}` : lineMessage(record),
  );
}

export function registerRuntimeLogSanitizerCases() {
  test("runtime status refuses an invalid Driver timestamp instead of normalizing it", async () => {
    const route = await logsRoute({ state: { observedAt: "2026-02-30" } });

    const runtime = await route.get(route.target.runtimePath);

    assert.equal(runtime.status, 503, runtime.text);
    const { body } = runtime;
    assert.ok(Check(ErrorResponse, body), "expected an API error envelope");
    assert.equal(body.error.code, "RUNTIME_LOGS_UNAVAILABLE");
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
        // @ts-expect-error Drivers may omit the container for a Pod-scoped Event.
        {
          type: "Warning",
          reason: "Failed",
          message: `Failed to pull image: Authorization: Bearer ${eventBearer}`,
          count: 3,
          lastObservedAt: "2026-09-30T11:59:00Z",
        },
      ],
    } satisfies Partial<typeof route.state>);

    const runtime = await route.get(route.target.runtimePath);
    assert.equal(runtime.status, 200, runtime.text);
    assert.equal(runtime.headers.get("cache-control"), "no-store");
    assert.equal(runtime.text.includes(eventBearer), false, "Event messages are redacted");
    assert.equal(
      runtime.text.includes(values.GITHUB_PAT),
      false,
      "termination reasons are redacted",
    );
    const { body: runtimeBody } = runtime;
    assert.ok(Check(AgentRuntimeResponse, runtimeBody), "expected a runtime status response");
    const event = runtimeBody.data.pods[0]?.events[0];
    assert.ok(event);
    assert.equal(event.container, null);
    assert.match(event.message, /\[redacted:header\]/);

    const logs = await route.read({ tailLines: 1000 });
    assert.equal(logs.status, 200, logs.text);
    assert.equal(logs.headers.get("cache-control"), "no-store");
    assertNoCanary(logs.text, planted, "into the response");
    const { body: logsBody } = logs;
    assert.ok(Check(AgentRuntimeLogsResponse, logsBody), "expected a runtime log response");
    const { data: logPage } = logsBody;
    // A level floor only removes sanitized records; it never reaches unsanitized text.
    const floored = await route.read({ tailLines: 1000, minLevel: "warn" });
    assert.equal(floored.status, 200, floored.text);
    assertNoCanary(floored.text, planted, "at minLevel=warn");
    const { body: flooredBody } = floored;
    assert.ok(Check(AgentRuntimeLogsResponse, flooredBody), "expected a runtime log response");
    const { records: flooredRecords } = flooredBody.data;
    assert.ok(
      flooredRecords.every(
        (record) => record.type !== "line" || ["error", "warn", "unknown"].includes(record.level),
      ),
    );
    requireTruncationGap(flooredRecords.at(-1));
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
      assert.ok(code !== undefined);
      return (code < 0x20 && code !== 0x0a) || code === 0x7f;
    });
    assert.deepEqual(controls, [], "the download carries no control characters");
    // `content` is reserved and has no producer.
    assert.ok(logPage.records.length > 0);
    assert.ok(
      logPage.records.every(
        (record) => record.type !== "line" || record.contentClass === "operational",
      ),
    );
    assert.equal(logs.text.includes('"contentClass":"content"'), false);

    // Operational context survives; payloads are withheld and counted.
    const lines = logPage.records.filter((record) => record.type === "line");
    const wrapper = lines.find((record) => record.kind === "wrapper");
    assert.deepEqual(wrapper?.fields, {
      container: "gateway",
      phase: "config",
      outcome: "ok",
      ms: 12,
      sinceStartMs: 40,
    });
    assert.deepEqual(
      lines
        .filter((record) => record.kind === "codex")
        .map(({ level, message, subsystem }) => ({ level, message, subsystem })),
      [
        {
          level: "warn",
          message: "stream connection failed; waiting to retry",
          subsystem: "codex_core::responses_retry",
        },
        // codex_core text outside the reviewed messages keeps its level and target only.
        {
          level: "warn",
          message: "Codex message withheld",
          subsystem: "codex_core::event_mapping",
        },
      ],
    );
    const openclaw = lines.find((record) => record.message === "turn started");
    assert.deepEqual(openclaw?.fields, { agent_id: "main" });
    assert.ok(lines.some((record) => record.message.includes("[redacted:userinfo]@github.com")));
    assert.ok(lines.some((record) => record.message.includes("visible-control-text")));
    assert.equal(logs.text.includes("\\u001b"), false, "ANSI escapes are stripped");
    assert.deepEqual(
      logPage.records
        .filter((record) => record.type === "withheld")
        .map(({ reason, count }) => ({ reason, count })),
      [
        { reason: "unrecognised_structured", count: 3 },
        { reason: "malformed", count: 2 },
      ],
    );
    assert.equal(logPage.withheld, 5);
    // The byte cut is labelled, never silent.
    assert.equal(logPage.truncated, true);
    requireTruncationGap(logPage.records.at(-1));
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
      records.map((record) => {
        if (record.type === "withheld") {
          return `withheld ${record.reason} ${record.count}`;
        }
        const { level, message } = requireLine(record);
        return `${level} ${message}`;
      }),
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
      requireLine(records.at(-1)).message,
      "basic authentication failed; see hf_hub_download and sort -u",
    );
    assert.match(requireLine(records[0]).message, /^curl -u \[redacted:argv\] https:/);
    assert.equal(requireLine(records[4]).message, "MY_SERVICE_KEY=[redacted:key-value]");
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
    const shown = records.map((record) => {
      const { kind, level, message } = requireLine(record);
      return { kind, level, message };
    });
    assert.deepEqual(shown, [
      { kind: "wrapper", level: "error", message: "Harness model authentication probe failed." },
      {
        kind: "text",
        level: "unknown",
        message: "Harness model authentication probe failed. extra",
      },
    ]);
  });

  test("a failed startup phase keeps its fixed cause code", () => {
    const { records } = sanitize(
      agentPodStream,
      [
        '{"event":"runtime.startup_phase","container":"agent","phase":"plugin-install","outcome":"failed","ms":60000,"sinceStartMs":62000,"code":"PLUGIN_NOT_IN_CATALOG"}',
      ],
      { first: 1 },
    );
    assert.deepEqual(wrapperRecords({ records }), [
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
    const probe = (event: ModelProbeEvent, cause: unknown, extra?: Record<string, unknown>) =>
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
        // closed-set error code and type, and a failed probe directory removal its
        // error code; the Codex probe has none of these fields, and provider text never passes.
        probe("openclaw.model_probe", undefined, {
          providerStatus: 401,
          providerCode: "missing_api_key",
          responseHeaderMarker: "provider-like",
          bodyShape: "json-error-code",
          providerErrorCode: "no_organization",
          providerErrorType: "invalid_request_error",
          cleanupError: "ENOTEMPTY",
          providerMessage: "Missing bearer or basic authentication in header",
          error: { code: "no_organization", message: "sk-live-abc" },
          body: '{"error":{"message":"sk-live-abc"}}',
        }),
        probe("codex.model_probe", undefined, {
          cleanupError: "ENOTEMPTY",
          responseHeaderMarker: "provider-like",
          bodyShape: "json-error-code",
          providerErrorCode: "no_organization",
          providerErrorType: "invalid_request_error",
        }),
        // An OpenClaw timeout keeps the CPU reading of its window (finding 2675); the raw
        // samples never pass, and the Codex probe has no window.
        probe("openclaw.model_probe", undefined, {
          timeoutWindowMs: 15_400,
          timeoutWindowCpuWaitMs: 4_200,
          timeoutWindowIdleMs: 2_000,
          timeoutWindowSamples: [[1, 2, 3, 4]],
        }),
        probe("codex.model_probe", undefined, { timeoutWindowMs: 15_400 }),
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
    const fields = (event: ModelProbeEvent, cause: LogFields = {}) => ({
      kind: "wrapper",
      level: "error",
      message: event,
      fields: { elapsedMs: 2340, code: "MODEL_PROBE_FAILED", ...cause },
    });
    assert.deepEqual(wrapperRecords({ records }), [
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
        cleanupError: "ENOTEMPTY",
      }),
      fields("codex.model_probe"),
      fields("openclaw.model_probe", {
        timeoutWindowMs: 15_400,
        timeoutWindowCpuWaitMs: 4_200,
        timeoutWindowIdleMs: 2_000,
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
    const login = (failureClass: unknown) =>
      JSON.stringify({
        event: "runtime.startup_phase",
        container: "agent",
        phase: "codex-login",
        outcome: "failed",
        ms: 812,
        sinceStartMs: 900,
        failureClass,
      });
    const probe = (event: ModelProbeEvent, failureClass: unknown) =>
      JSON.stringify({
        event,
        elapsedMs: 2340,
        exitCode: 1,
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROCESS_EXIT", detail: "exit-1" },
        failureClass,
      });
    const loginAttempt = (failureClass: unknown) =>
      JSON.stringify({
        event: "codex.login",
        attempt: 1,
        elapsedMs: 640,
        exitCode: 1,
        failureClass,
      });
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
    const loginFields = (extra: LogFields = {}) => ({
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
    const probeFields = (event: ModelProbeEvent, extra: LogFields = {}) => ({
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
    const loginAttemptFields = (extra: LogFields = {}) => ({
      kind: "wrapper",
      level: "warn",
      message: "codex.login",
      fields: { attempt: 1, elapsedMs: 640, exitCode: 1, ...extra },
    });
    assert.deepEqual(wrapperRecords({ records }), [
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
    const event = (settings: unknown) =>
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
    const override = (fields?: LogFields) => ({
      kind: "wrapper",
      level: "warn",
      message: "runtime.gateway_settings_overridden",
      fields: { container: "gateway", ...fields },
    });
    assert.deepEqual(wrapperRecords({ records }), [
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
    assert.deepEqual(partial.records.map(lineMessage), ["complete line"]);
    const oversized = sanitize(
      gatewayStream,
      [`plain ${"x".repeat(5 * 1024)}`, `{"level":"info","message":"${"y".repeat(33 * 1024)}"}`],
      { first: 1 },
    );
    const withheld = oversized.records.map((record) => {
      assert.ok(record.type === "withheld");
      const { type, reason, count } = record;
      return { type, reason, count };
    });
    assert.deepEqual(withheld, [{ type: "withheld", reason: "oversized", count: 2 }]);
    const long = sanitize(
      gatewayStream,
      [`{"level":"info","subsystem":"gateway","message":"${"z ".repeat(6000)}"}`],
      { first: 1 },
    );
    const longLine = requireLine(long.records[0]);
    assert.equal(longLine.truncated, true);
    assert.ok(Buffer.byteLength(longLine.message) <= 8 * 1024);
    assert.match(longLine.message, /…\[truncated\]$/);
  });

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
        record.type === "withheld"
          ? `withheld ${record.reason} ${record.count}`
          : requireLine(record).message,
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
      stray.records.map((record) =>
        record.type === "withheld" ? record.type : requireLine(record).message,
      ),
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
    const shown = (raws: readonly string[]) =>
      sanitize(gatewayStream, raws).records.map(lineMessage);
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
        assert.ok(
          elapsed < budgetMs,
          `${JSON.stringify(unit)} took ${elapsed.toFixed(0)} ms of CPU`,
        );
      }
    }
  });

  test("a multi-line message stays one record with its line breaks as spaces (3048)", async () => {
    const pemBody = randomBytes(48).toString("base64");
    const lines = [
      // The embedded OpenClaw Gateway emits one JSON record per paragraph, with
      // `\n` between the lines of a paragraph.
      openclawError(
        "  - plugins.entries.example-plugin.config.mirror.endpoint: invalid config: must have required property 'endpoint'\n  - plugins.entries.example-plugin.config.mirror.catalogs: invalid config: must have required property 'catalogs'",
      ),
      openclawError(
        "Fix: Config is externally managed (`OPENCLAW_CONFIG_READONLY=1`), so OpenClaw treats openclaw.json as immutable.\nConfig path: /etc/openclaw/openclaw.json\nEdit the config in your external deployment source, then redeploy or restart OpenClaw as needed.",
      ),
      openclawError(
        `key:\n-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\ndone`,
      ),
      // A CRLF-terminated container line keeps no trailing space.
      "plain text from a CRLF writer\r",
    ];
    const { messages, download } = await routeMessages(lines, [pemBody]);
    const expected = [
      "  - plugins.entries.example-plugin.config.mirror.endpoint: invalid config: must have required property 'endpoint'   - plugins.entries.example-plugin.config.mirror.catalogs: invalid config: must have required property 'catalogs'",
      "Fix: Config is externally managed (`OPENCLAW_CONFIG_READONLY=1`), so OpenClaw treats openclaw.json as immutable. Config path: /etc/openclaw/openclaw.json Edit the config in your external deployment source, then redeploy or restart OpenClaw as needed.",
      "key: [redacted:pem] done",
      "plain text from a CRLF writer",
    ];
    assert.deepEqual(messages, expected);
    // The download prints one record per line: a message cannot start a forged record.
    assert.deepEqual(
      download
        .trimEnd()
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/^\S+ ERROR openclaw /, "").replace(/^\S+ UNKNOWN text /, "")),
      expected,
    );
  });

  test("a credential is masked when a spacing control, a literal escape, a quoted key or a percent-encoded separator separates it from its key", async () => {
    const token = `Ab1${randomString(29)}`;
    const password = `pw${randomString(14)}`;
    const apiKey = `key${randomString(21)}`;
    const digest = randomBytes(20).toString("hex");
    // A line break, vertical tab, form feed or NEL shows as one space, so the keyword stays
    // apart from its value and the digest from the next word.
    const gaps = ["\n", "\u000b", "\u000c", "\u0085"];
    const lines = [
      ...gaps.flatMap((gap) => [
        openclawError(`retry with bearer${gap}${token}`),
        openclawError(`login failed: --password${gap}${password}`),
        openclawError(`fetched sha1 ${digest}${gap}next step`),
      ]),
      // A cursor-forward escape shows as a gap too.
      `retry with bearer\u001b[1C${token}`,
      // Python dict reprs and JSON quoted inside a logfmt value: the closing quote of the
      // key sits between the key and its separator.
      `ERROR request failed: {'Authorization': 'token ${token}', 'password': '${password}'}`,
      `level=error msg="token refresh failed" body="{\\"api_key\\":\\"${apiKey}\\"}"`,
      openclawError(
        `upstream body: ${JSON.stringify(JSON.stringify({ client_secret: password }))}`,
      ),
      // Plain-text lines (logfmt, Go %q, Python reprs) keep a line break or tab inside a
      // quoted value as a two-character escape. It separates a keyword from its value,
      // before or after the keyword, and starts a new long-token run.
      `level=error msg="retry with bearer\\n${token}"`,
      `level=error msg="login failed: --password\\t${password}"`,
      `level=info msg="fetched sha1\\n${digest}"`,
      `ERROR retry: 'bearer\\x0a${token}'`,
      `ERROR request failed: {'Authorization':\\u000a'token ${token}'}`,
      `level=warn msg="env:\\nMY_SERVICE_KEY=${apiKey}"`,
      // An escape inside a value does not end it: no tail after the escape is shown.
      `level=error msg="cli: --token=${apiKey.slice(0, 12)}\\n${apiKey.slice(12)}"`,
      // Ordinary text around escapes stays.
      `level=info msg="line one\\nline two\\tthe token\\nwas refreshed"`,
      // Percent-encoded separators outside a URL query.
      `level=error body=password%3D${password}&next=1`,
      `level=error header=Authorization%3A%20Bearer%20${token}`,
    ];
    const secrets = [token, password, apiKey, digest, apiKey.slice(12)];
    const { messages, download } = await routeMessages(lines, secrets);
    assert.deepEqual(messages, [
      ...gaps.flatMap(() => [
        "retry with bearer [redacted:bearer]",
        "login failed: --password [redacted:argv]",
        "fetched sha1 [redacted:long-token] next step",
      ]),
      "retry with bearer [redacted:bearer]",
      "ERROR request failed: {'Authorization': '[redacted:header]', 'password': [redacted:key-value]}",
      'level=error msg="token refresh failed" body="{\\"api_key\\":[redacted:key-value]}"',
      'upstream body: "{\\"client_secret\\":[redacted:key-value]}"',
      'level=error msg="retry with bearer\\n[redacted:bearer]"',
      'level=error msg="login failed: --password\\t[redacted:argv]',
      'level=info msg="fetched sha1\\n[redacted:long-token]"',
      "ERROR retry: 'bearer\\x0a[redacted:bearer]'",
      "ERROR request failed: {'Authorization':\\u000a'[redacted:header]'}",
      'level=warn msg="env:\\nMY_SERVICE_KEY=[redacted:key-value]"',
      'level=error msg="cli: --token=[redacted:argv]',
      'level=info msg="line one\\nline two\\tthe token\\nwas refreshed"',
      "level=error body=password%3D[redacted:key-value]&next=1",
      "level=error header=Authorization%3A[redacted:header]",
    ]);
    // The download prints each record on its own line.
    const downloadLines = download.trimEnd().split("\n").slice(1);
    assert.equal(downloadLines.length, messages.length, download);
    for (const [index, message] of messages.entries()) {
      assert.ok(downloadLines[index]?.endsWith(message), `download lacks ${message}`);
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
      page.records.map((record) => {
        if (record.type === "line") {
          return { kind: record.kind, message: record.message };
        }
        assert.ok(record.type === "withheld");
        return { reason: record.reason, count: record.count };
      }),
      [
        ...tagged.map((message) => ({ kind: "text", message })),
        { reason: "malformed", count: arrays.length },
      ],
    );
    assert.equal(JSON.stringify(page).includes(canary), false);
  });
}
