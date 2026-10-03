import type {
  AgentRuntimeLogChunk,
  SandboxLogLine,
  RuntimeLogGapReason,
  RuntimeLogKind,
  RuntimeLogLevel,
  RuntimeLogRecord,
  RuntimeLogStream,
  RuntimeLogWithheldReason,
} from "@openclaw-enterprise/contracts";
import {
  maskPemBlockLines,
  redactArgvCredentials,
  redactRuntimeLogText,
  stripRuntimeLogControls,
} from "./redact.ts";

declare const sanitizedRuntimeLogRecord: unique symbol;

/**
 * A record that passed classification and redaction. Only this module creates the
 * brand; route serializers accept nothing else, so a new source cannot bypass it.
 */
export type SanitizedRuntimeLogRecord = RuntimeLogRecord & {
  readonly [sanitizedRuntimeLogRecord]: true;
};

export const RUNTIME_LOG_MAX_INPUT_BYTES = 32 * 1024;
export const RUNTIME_LOG_MAX_OUTPUT_BYTES = 8 * 1024;
export const RUNTIME_LOG_MAX_TEXT_BYTES = 4 * 1024;
const MAX_FIELD_CHARS = 512;
const MAX_JSON_DEPTH = 8;
const TRUNCATION_MARK = "…[truncated]";

const WRAPPER_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "runtime.startup_phase": ["container", "phase", "outcome", "ms", "sinceStartMs", "code"],
  "openclaw.model_probe": ["elapsedMs", "capMs", "cpuWaitMs", "code"],
  "codex.model_probe": ["attempt", "elapsedMs", "exitCode", "signal", "code"],
  "runtime.workspace_node": ["container", "outcome", "code"],
  "runtime.gateway_settings_overridden": ["container"],
});

// `runtime.gateway_settings_overridden` names (never values) the owner settings a
// Gateway replaced. A name can carry an owner-typed key, so the list is kept only
// when every item is a short key path; otherwise the event keeps no list.
const OVERRIDDEN_SETTING =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:(?:\[\])?\.[A-Za-z][A-Za-z0-9_-]{0,63}){0,7}$/;
const MAX_OVERRIDDEN_SETTINGS = 32;

function overriddenSettings(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_OVERRIDDEN_SETTINGS ||
    !value.every((item) => typeof item === "string" && OVERRIDDEN_SETTING.test(item))
  ) {
    return undefined;
  }
  return scalar(value.join(", ")) as string;
}

// Fixed plain-text failure lines the runtime wrapper prints next to its structured
// events (`runtime-entrypoints.ts`). They are wrapper errors, not `unknown` text.
const WRAPPER_ERROR_LINES: ReadonlySet<string> = new Set([
  "Harness model authentication probe failed.",
]);

// Operational keys only. Anything else, and every free-text or payload key
// (`args`, `payload`, `body`, `prompt`, `messages`, `content`, `text`, `transcript`,
// `headers`, `env`), never leaves OCC.
const STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  "agent_id",
  "session_id",
  "channel",
  "run_id",
  "traceId",
  "spanId",
  "code",
  "status",
  "durationMs",
  "elapsedMs",
  "url",
  "method",
]);

// Codex tool-call fields (`codex_core::tools::parallel`): names and timings only.
const CODEX_FIELDS: readonly string[] = ["tool_name", "turn_id", "total_duration_ms"];
// Codex tracing prints span lifecycle records (`new`, `enter`, `exit`, `close`)
// as events whose message is the lifecycle word and whose `span` names the span.
const CODEX_SPAN_EVENTS: ReadonlySet<string> = new Set(["new", "enter", "exit", "close"]);
const CODEX_SPAN_NAME = /^[A-Za-z_][\w.:-]{0,63}$/;
// Fields of Codex's `turn` span (`codex_core::tasks`) kept on its start and end.
const CODEX_TURN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  model: "model",
  "turn.id": "turn_id",
  "codex.turn.token_usage.input_tokens": "input_tokens",
  "codex.turn.token_usage.output_tokens": "output_tokens",
  "codex.turn.token_usage.total_tokens": "total_tokens",
  "time.busy": "busy",
});

const LEVELS: Readonly<Record<string, RuntimeLogLevel>> = Object.freeze({
  fatal: "error",
  error: "error",
  warn: "warn",
  warning: "warn",
  info: "info",
  debug: "debug",
  trace: "debug",
});

const GAP_REMEDIES: Readonly<Record<RuntimeLogGapReason, string>> = Object.freeze({
  stream_replaced: "Container restarted; showing the new instance.",
  window_exceeded:
    "Lines between the previous page and this one were not retrieved. Refresh to read the current tail.",
  cursor_expired: "The previous view expired; resumed from the current tail.",
  truncated:
    "The page reached its byte limit; later lines were not retrieved. Request fewer lines to read them.",
  buffer_lost:
    "The source no longer holds the lines after the previous page: its in-memory buffer rolled over or restarted. Showing what it still holds.",
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type LineRecord = Extract<RuntimeLogRecord, { type: "line" }>;

function brand(record: RuntimeLogRecord): SanitizedRuntimeLogRecord {
  return Object.freeze(record) as SanitizedRuntimeLogRecord;
}

function cleanStream(stream: RuntimeLogStream): RuntimeLogStream {
  return Object.freeze({
    source: stream.source,
    ...(stream.pod === undefined ? {} : { pod: stream.pod }),
    ...(stream.podUid === undefined ? {} : { podUid: stream.podUid }),
    ...(stream.container === undefined ? {} : { container: stream.container }),
    ...(stream.restartCount === undefined ? {} : { restartCount: stream.restartCount }),
    ...(stream.sandbox === undefined ? {} : { sandbox: stream.sandbox }),
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateBytes(value: string, limit: number): { text: string; truncated: boolean } {
  if (byteLength(value) <= limit) {
    return { text: value, truncated: false };
  }
  const budget = limit - byteLength(TRUNCATION_MARK);
  let text = Buffer.from(value, "utf8").subarray(0, budget).toString("utf8");
  // A cut inside a multibyte character decodes to U+FFFD; drop it.
  text = text.replace(/�$/, "");
  return { text: `${text}${TRUNCATION_MARK}`, truncated: true };
}

/**
 * Redacts, then bounds, one retained string. argv credentials (`curl -u user:pass`,
 * `-p pass`) have no key the text rules can see, so they are masked first, for every
 * source and field.
 */
export function sanitizeRuntimeLogText(value: string, limit = RUNTIME_LOG_MAX_OUTPUT_BYTES) {
  return truncateBytes(
    redactRuntimeLogText(redactArgvCredentials(stripRuntimeLogControls(value))),
    limit,
  );
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    return sanitizeRuntimeLogText(value, MAX_FIELD_CHARS).text;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function pickFields(
  source: Readonly<Record<string, unknown>>,
  allowed: Iterable<string>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const fields: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(source, key)) {
      continue;
    }
    const value = scalar(source[key]);
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return Object.keys(fields).length === 0 ? undefined : Object.freeze(fields);
}

function withinDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.every((child) => withinDepth(child, depth + 1));
}

function level(value: unknown): RuntimeLogLevel {
  return typeof value === "string" ? (LEVELS[value.toLowerCase()] ?? "unknown") : "unknown";
}

type Classified =
  | {
      readonly type: "line";
      readonly kind: RuntimeLogKind;
      readonly level: RuntimeLogLevel;
      readonly message: string;
      readonly subsystem?: string;
      readonly fields?: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly type: "withheld"; readonly reason: RuntimeLogWithheldReason };

function classifyStructured(value: Readonly<Record<string, unknown>>): Classified {
  const event = value.event;
  if (typeof event === "string" && Object.hasOwn(WRAPPER_FIELDS, event)) {
    let fields = pickFields(value, WRAPPER_FIELDS[event]!);
    const overridden = event === "runtime.gateway_settings_overridden";
    const settings = overridden ? overriddenSettings(value.settings) : undefined;
    if (settings !== undefined) {
      fields = Object.freeze({ ...fields, settings });
    }
    const failed =
      value.outcome === "failed" ||
      (typeof value.code === "string" && value.code !== "READY" && event.endsWith("model_probe"));
    return {
      type: "line",
      kind: "wrapper",
      // The Gateway ignored owner settings: the owner should see it at the default level.
      level: failed ? "error" : overridden ? "warn" : "info",
      message: event,
      ...(fields === undefined ? {} : { fields }),
    };
  }
  if (typeof value.level === "string" && typeof value.message === "string") {
    if (typeof value.target === "string") {
      return codexRecord(value, value.message);
    }
    // OpenClaw JSON console style: `{ ...meta, time, level, subsystem?, message }`.
    const recordLevel = level(value.level);
    const subsystem =
      typeof value.subsystem === "string" && value.subsystem.length > 0
        ? value.subsystem
        : undefined;
    if (subsystem === undefined && recordLevel !== "error" && recordLevel !== "warn") {
      // Without a subsystem this is a `runtime.log` stdout write, not a logger record:
      // the agent command prints reply payloads that way (the OpenAI-compatible chat
      // endpoint). Errors and warnings stay, since `Gateway failed to start: ...` has no
      // subsystem either.
      return { type: "withheld", reason: "unrecognised_structured" };
    }
    const fields = pickFields(value, STRUCTURED_FIELDS);
    return {
      type: "line",
      kind: "openclaw",
      level: recordLevel,
      message: value.message,
      ...(subsystem === undefined ? {} : { subsystem }),
      ...(fields === undefined ? {} : { fields }),
    };
  }
  // Codex tracing JSON: `{ timestamp, level, target, fields: { message, ... } }`.
  if (
    typeof value.level === "string" &&
    typeof value.target === "string" &&
    value.fields !== null &&
    typeof value.fields === "object" &&
    !Array.isArray(value.fields)
  ) {
    const nested = value.fields as Readonly<Record<string, unknown>>;
    if (typeof nested.message === "string") {
      const span = codexSpanLifecycle(value, nested);
      if (span !== undefined) {
        return span;
      }
      return codexRecord({ ...nested, level: value.level, target: value.target }, nested.message);
    }
  }
  // Everything else, including Codex JSON-RPC protocol output, is withheld.
  return { type: "withheld", reason: "unrecognised_structured" };
}

/**
 * A Codex span lifecycle record. The `turn` span's start and end are the turn's
 * operational events (info, with model, IDs, token counts and busy time); every
 * other lifecycle record is debug noise, labelled with the span name. Span fields
 * other than those listed never leave OCC.
 */
function codexSpanLifecycle(
  value: Readonly<Record<string, unknown>>,
  nested: Readonly<Record<string, unknown>>,
): Classified | undefined {
  const event = nested.message as string;
  const span = value.span;
  if (
    !CODEX_SPAN_EVENTS.has(event) ||
    span === null ||
    typeof span !== "object" ||
    Array.isArray(span)
  ) {
    return undefined;
  }
  const spanFields = span as Readonly<Record<string, unknown>>;
  const name =
    typeof spanFields.name === "string" && CODEX_SPAN_NAME.test(spanFields.name)
      ? spanFields.name
      : "span";
  const subsystem = value.target as string;
  if (
    name === "turn" &&
    subsystem === "codex_core::tasks" &&
    (event === "new" || event === "close")
  ) {
    const source: Readonly<Record<string, unknown>> = {
      ...spanFields,
      ...(event === "close" ? { "time.busy": nested["time.busy"] } : {}),
    };
    const fields: Record<string, string | number | boolean> = {};
    for (const [from, to] of Object.entries(CODEX_TURN_FIELDS)) {
      const kept = Object.hasOwn(source, from) ? scalar(source[from]) : undefined;
      if (kept !== undefined) {
        fields[to] = kept;
      }
    }
    return {
      type: "line",
      kind: "codex",
      level: level(value.level),
      message: event === "new" ? "turn started" : "turn completed",
      subsystem,
      ...(Object.keys(fields).length === 0 ? {} : { fields: Object.freeze(fields) }),
    };
  }
  return {
    type: "line",
    kind: "codex",
    level: "debug",
    message: `span ${event} ${name}`,
    subsystem,
  };
}

// Codex messages shown as written. `codex_core` formats can interpolate chat text and
// model-proposed values (`event_mapping` logs `Output text in user message: <text>`),
// so only reviewed operational targets (app-server and its listener and remote-control
// loops, login, CA setup, plugin manifests) and reviewed fixed-format messages keep
// their text. Every other target, `codex_otel` included, shows a fixed message.
// The Collector keeps message text only from `codex_app_server`.
const CODEX_MESSAGE_TARGET =
  /^(?:codex_app_server|codex_app_server_transport::transport::(?:websocket|remote_control)|codex_login|codex_http_client::custom_ca|codex_core_plugins)(?:::|$)/;
// A configured model endpoint (provider base URL plus path) or a loopback listener.
const CODEX_ENDPOINT_URL = String.raw`wss?://\S{1,2048}`;
const CODEX_SOCKET_ADDRESS = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]{2,45}\]):\d{1,5}`;
// A WebSocket connect error as tungstenite's Display prints it: its error kind, then an
// OS error, an HTTP status code and reason (never the body), or a proxy, URL or TLS
// diagnostic. Anchored to the kinds so a changed error type falls back to withholding.
const CODEX_CONNECT_ERROR = String.raw`(?:Connection closed normally|Trying to work with closed connection|Write buffer is full|Attack attempt detected|(?:IO|TLS|URL|HTTP|HTTP format|UTF-8 encoding) error: [^\n]{1,1000}|WebSocket protocol error: [^\n]{1,1000}|Space limit exceeded: [^\n]{1,1000})`;
// Reviewed fixed-format diagnostics (codex-cli 0.158.0) from targets that also log
// payloads, so the target as a whole is never kept: `responses_websocket` logs
// `failed to parse websocket event: <err>, data: <event>`, and the network proxy logs
// the hosts and paths of sandboxed requests. The variable parts allowed here are a
// configured endpoint URL, a socket address, counts, durations and a WebSocket
// connect error.
const CODEX_FIXED_MESSAGES: Readonly<Record<string, readonly (string | RegExp)[]>> = Object.freeze({
  "codex_api::endpoint::responses_websocket": Object.freeze([
    new RegExp(`^connecting to websocket: ${CODEX_ENDPOINT_URL}$`),
    new RegExp(`^successfully connected to websocket: ${CODEX_ENDPOINT_URL}$`),
    new RegExp(
      `^failed to connect to websocket: ${CODEX_CONNECT_ERROR}, url: ${CODEX_ENDPOINT_URL}$`,
    ),
  ]),
  "codex_core::client": Object.freeze(["falling back to HTTP"]),
  "codex_core::responses_retry": Object.freeze([
    "stream connection failed; waiting to retry",
    "remote compaction v2 stream failed; retrying request after delay",
    /^stream disconnected - retrying sampling request \(\d{1,10}\/\d{1,10} in [\d.]{1,24}(?:ns|µs|ms|s)\)\.\.\.$/,
  ]),
  "codex_core::tools::parallel": Object.freeze(["tool call completed"]),
  "codex_network_proxy::certs": Object.freeze(["generated process-local MITM CA"]),
  "codex_network_proxy::http_proxy": Object.freeze([
    new RegExp(`^HTTP proxy listening on ${CODEX_SOCKET_ADDRESS}$`),
  ]),
  "codex_network_proxy::proxy": Object.freeze([
    "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform",
    "network.enabled is false; skipping proxy listeners",
  ]),
  "codex_network_proxy::socks5": Object.freeze([
    new RegExp(`^SOCKS5 proxy listening on ${CODEX_SOCKET_ADDRESS}$`),
    "SOCKS5 UDP and non-HTTPS SOCKS5 TCP are blocked in limited mode; HTTPS SOCKS5 TCP requires MITM inspection",
  ]),
});
const CODEX_WITHHELD_MESSAGE = "Codex message withheld";

function codexMessage(target: string, message: string): string {
  if (CODEX_MESSAGE_TARGET.test(target)) {
    return message;
  }
  const formats = Object.hasOwn(CODEX_FIXED_MESSAGES, target) ? CODEX_FIXED_MESSAGES[target]! : [];
  const fixed = formats.some((format) =>
    typeof format === "string" ? format === message : format.test(message),
  );
  return fixed ? message : CODEX_WITHHELD_MESSAGE;
}

function codexRecord(value: Readonly<Record<string, unknown>>, message: string): Classified {
  const fields = pickFields(value, [...STRUCTURED_FIELDS, ...CODEX_FIELDS]);
  const target = value.target as string;
  return {
    type: "line",
    kind: "codex",
    level: level(value.level),
    message: codexMessage(target, message),
    subsystem: target,
    ...(fields === undefined ? {} : { fields }),
  };
}

/** Net bracket depth of one line, ignoring brackets inside JSON strings. */
function bracketDelta(text: string): number {
  let delta = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      delta += 1;
    } else if (character === "}" || character === "]") {
      delta -= 1;
    }
  }
  return delta;
}

// A pretty-printed member (`"prompt": "..."`) or string element (`"...",`). These lines
// carry payload values even when the enclosing `{` is on another line or page.
const JSON_MEMBER_LINE = /^"(?:[^"\\]|\\.){0,4096}"\s*(?::|,?$)/;
// Any line that can continue a pretty-printed JSON value.
const JSON_CONTINUATION_LINE = /^(?:["{}[\]\-\d]|true\b|false\b|null\b)/;

/**
 * Tracks one multi-line JSON value within a chunk. JSON.parse sees one line at a time,
 * so the `{` line alone is malformed and every inner line would otherwise read as text.
 *
 * Depth only falls on closing brackets or a line that cannot continue JSON, so after an
 * unclosed `{` (or a bare quoted-string line) plain lines that start with a digit, `-`,
 * `"`, `{`, `[`, `true`, `false` or `null` stay withheld until such a line appears. That
 * errs toward withholding, never toward showing payload. Bracket-tagged text lines such
 * as `[node-host] ...` always end the block.
 */
interface JsonBlock {
  depth: number;
}

// A plain-text line tagged with a bracketed component name, such as
// `[node-host] advertised commands: ...`. The tag starts with a letter and holds no
// quotes, commas, braces or spaces, so no JSON array (or fragment of one) matches.
const BRACKET_TAG = /^\[(?!(?:true|false|null)\])[A-Za-z][\w.:/@-]{0,63}\](?:\s|$)/;

function classify(line: string, block: JsonBlock): Classified {
  if (byteLength(line) > RUNTIME_LOG_MAX_INPUT_BYTES) {
    return { type: "withheld", reason: "oversized" };
  }
  const text = stripRuntimeLogControls(line);
  const trimmed = text.trim();
  if (block.depth > 0) {
    if (
      JSON_CONTINUATION_LINE.test(trimmed) &&
      !BRACKET_TAG.test(trimmed) &&
      !parsesAlone(trimmed)
    ) {
      block.depth += bracketDelta(trimmed);
      return { type: "withheld", reason: "malformed" };
    }
    // Plain text, or a complete single-line record: the value ended or was interleaved.
    block.depth = 0;
  }
  if (JSON_MEMBER_LINE.test(trimmed)) {
    // The rest of a value whose opening line was on an earlier page, or was not seen.
    block.depth = Math.max(0, 1 + bracketDelta(trimmed));
    return { type: "withheld", reason: "malformed" };
  }
  if (trimmed.startsWith("{") || (trimmed.startsWith("[") && !BRACKET_TAG.test(trimmed))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // JSON-shaped but unparseable output may be a structured payload; never show it.
      block.depth = Math.max(0, bracketDelta(trimmed));
      return { type: "withheld", reason: "malformed" };
    }
    if (!withinDepth(parsed)) {
      return { type: "withheld", reason: "malformed" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { type: "withheld", reason: "unrecognised_structured" };
    }
    return classifyStructured(parsed as Readonly<Record<string, unknown>>);
  }
  if (byteLength(text) > RUNTIME_LOG_MAX_TEXT_BYTES) {
    return { type: "withheld", reason: "oversized" };
  }
  if (WRAPPER_ERROR_LINES.has(trimmed)) {
    return { type: "line", kind: "wrapper", level: "error", message: trimmed };
  }
  return { type: "line", kind: "text", level: "unknown", message: text };
}

function parsesAlone(trimmed: string): boolean {
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export interface SanitizedRuntimeLogChunk {
  readonly records: readonly SanitizedRuntimeLogRecord[];
  readonly withheld: number;
}

/**
 * The only producer of `SanitizedRuntimeLogRecord` lines. Classifies each raw line
 * against the operational allowlist, redacts every retained string, bounds sizes and
 * coalesces consecutive withheld lines into one counted record.
 */
export function sanitizeRuntimeLogChunk(
  chunk: Pick<AgentRuntimeLogChunk, "stream" | "lines" | "truncated">,
  pemContext?: {
    readonly open: boolean | undefined;
    readonly canClose?: readonly boolean[] | undefined;
  },
): SanitizedRuntimeLogChunk & { readonly pemOpen?: boolean } {
  const stream = cleanStream(chunk.stream);
  let lines = chunk.lines;
  // The byte limit cuts the final line; a partial line may end inside a token.
  if (chunk.truncated && lines.length > 0) {
    lines = lines.slice(0, -1);
  }
  const records: SanitizedRuntimeLogRecord[] = [];
  let withheld = 0;
  let run: Mutable<Extract<RuntimeLogRecord, { type: "withheld" }>> | undefined;
  const block: JsonBlock = { depth: 0 };
  // Classify in order: an open pretty-printed JSON block carries across lines.
  const classifiedLines = lines.map((line) => classify(line.raw, block));
  // A key printed over several lines is split across records; mask the whole block.
  const pemState = { open: pemContext?.open, canClose: pemContext?.canClose };
  const pem = maskPemBlockLines(
    classifiedLines.map((classified) =>
      classified.type === "line" && classified.kind === "text" ? classified.message : undefined,
    ),
    pemState,
  );
  for (const [index, line] of lines.entries()) {
    const classified = classifiedLines[index]!;
    const time = validTime(line.time);
    if (classified.type === "withheld") {
      withheld += 1;
      if (run !== undefined && run.reason === classified.reason) {
        run.count += 1;
        continue;
      }
      if (run !== undefined) {
        records.push(brand(run));
      }
      run = { type: "withheld", time, stream, count: 1, reason: classified.reason };
      continue;
    }
    if (run !== undefined) {
      records.push(brand(run));
      run = undefined;
    }
    const message = sanitizeRuntimeLogText(pem.get(index) ?? classified.message);
    const subsystem =
      classified.subsystem === undefined
        ? undefined
        : sanitizeRuntimeLogText(classified.subsystem, MAX_FIELD_CHARS).text;
    const record: LineRecord = {
      type: "line",
      time,
      stream,
      // Slice 1 recognises operational output only; nothing is ever classed `content`.
      contentClass: "operational",
      kind: classified.kind,
      level: classified.level,
      message: message.text,
      ...(subsystem === undefined ? {} : { subsystem }),
      ...(classified.fields === undefined ? {} : { fields: classified.fields }),
      ...(message.truncated ? { truncated: true as const } : {}),
    };
    records.push(brand(record));
  }
  if (run !== undefined) {
    records.push(brand(run));
  }
  return Object.freeze({
    records: Object.freeze(records),
    withheld,
    ...(pemState.open === undefined ? {} : { pemOpen: pemState.open }),
  });
}

// Sandbox policy and supervisor records (OpenShell OCSF shorthand and tracing fields).
// Operational and activity keys only; `cmd_line` and `url` carry credentials in argv and
// query strings, so they are kept only after redaction and cut to 1 KiB.
const SANDBOX_FIELDS: ReadonlySet<string> = new Set([
  "activity",
  "action",
  "disposition",
  "dst_host",
  "dst_port",
  "method",
  "path",
  "binary",
  "pid",
  "rule_name",
  "rule_type",
  "policy_generation",
  "reason",
]);
const SANDBOX_REDACTED_FIELDS: ReadonlySet<string> = new Set(["cmd_line", "url"]);
const SANDBOX_REDACTED_FIELD_BYTES = 1024;
const SANDBOX_ORIGINS: ReadonlySet<string> = new Set(["gateway", "sandbox"]);
const OCSF_SEVERITIES: Readonly<Record<string, RuntimeLogLevel>> = Object.freeze({
  INFO: "info",
  LOW: "info",
  MED: "warn",
  HIGH: "error",
  CRIT: "error",
  FATAL: "error",
});

/**
 * Fields recovered from one OpenShell OCSF shorthand line, for example
 * `HTTP:GET [INFO] ALLOWED curl(42) -> GET https://host/p?q=1 [policy:web engine:opa]` or
 * `PROC:LAUNCH [INFO] git(7) [cmd:git clone https://...]`. OpenShell pushes OCSF events
 * with an empty field map, so the shorthand is the only structure. Every pattern is
 * anchored on a fixed keyword and scans bounded tokens.
 */
function ocsfFields(message: string): {
  readonly fields: Record<string, string>;
  readonly message: string;
  readonly level: RuntimeLogLevel;
} {
  const fields: Record<string, string> = {};
  let rest = message;
  // The command line closes the PROC shorthand and may itself contain brackets. A string
  // search, not a regex, keeps hostile lines full of ` [cmd:` linear.
  const command = rest.startsWith("PROC:") && rest.endsWith("]") ? rest.indexOf(" [cmd:") : -1;
  if (command !== -1) {
    fields.cmd_line = rest.slice(command + " [cmd:".length, -1);
    rest = rest.slice(0, command);
  }
  const head = /^([A-Z]{2,16}:[A-Z_]{1,32}) \[([A-Z]{3,5})\]/.exec(rest);
  if (head !== null) {
    fields.activity = head[1]!;
  }
  const action = /^[A-Z]{2,16}:[A-Z_]{1,32} \[[A-Z]{3,5}\] ([A-Z]{3,16})\b/.exec(rest);
  if (action !== null && action[1] !== "UNKNOWN") {
    fields.action = action[1]!;
  }
  const actor = /(?:^|\s)([^\s()[\]]{1,256})\((\d{1,10})\)/.exec(rest);
  if (actor !== null) {
    fields.binary = actor[1]!;
    fields.pid = actor[2]!;
  }
  if (rest.startsWith("HTTP:")) {
    // `... curl(42) -> GET <url>`, or `... ALLOWED GET <url>` when no process is known.
    const request =
      /-> ([A-Z]{3,10}) (\S{1,32768})/.exec(rest) ??
      /^HTTP:[A-Z_]{1,32} \[[A-Z]{3,5}\] (?:[A-Z]{3,16} )?([A-Z]{3,10}) (\S{1,32768})/.exec(rest);
    if (request !== null) {
      fields.method = request[1]!;
      fields.url = request[2]!;
    }
  } else if (rest.startsWith("NET:")) {
    const target = /-> ([^\s:/]{1,253})(?::(\d{1,5}))?/.exec(rest);
    if (target !== null) {
      fields.dst_host = target[1]!;
      if (target[2] !== undefined) {
        fields.dst_port = target[2];
      }
    }
  }
  const policy = /\[policy:([^\s\]]{1,256}) engine:([^\s\]]{1,64})\]/.exec(rest);
  if (policy !== null) {
    fields.rule_name = policy[1]!;
    fields.rule_type = policy[2]!;
  }
  const reason = /[[ ]reason:([^\]]{1,512})\]/.exec(rest);
  if (reason !== null) {
    fields.reason = reason[1]!;
  }
  let severity: RuntimeLogLevel =
    head === null ? "unknown" : (OCSF_SEVERITIES[head[2]!] ?? "unknown");
  if (fields.action === "DENIED" && (severity === "info" || severity === "unknown")) {
    severity = "warn";
  }
  return { fields, message: rest, level: severity };
}

function sandboxFields(
  line: Readonly<SandboxLogLine>,
  parsed: Readonly<Record<string, string>>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const fields: Record<string, string | number | boolean> = {};
  const candidates: Record<string, unknown> = { ...parsed };
  for (const [key, value] of Object.entries(line.fields)) {
    if (!Object.hasOwn(candidates, key)) {
      candidates[key] = value;
    }
  }
  for (const [key, value] of Object.entries(candidates)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (key === "cmd_line") {
      // argv credentials (`-u user:pass`, `-p pass`) have no key the text rules can see.
      const command = redactArgvCredentials(stripRuntimeLogControls(value));
      fields[key] = sanitizeRuntimeLogText(command, SANDBOX_REDACTED_FIELD_BYTES).text;
    } else if (SANDBOX_REDACTED_FIELDS.has(key)) {
      fields[key] = sanitizeRuntimeLogText(value, SANDBOX_REDACTED_FIELD_BYTES).text;
    } else if (SANDBOX_FIELDS.has(key)) {
      fields[key] = sanitizeRuntimeLogText(value, MAX_FIELD_CHARS).text;
    }
  }
  if (SANDBOX_ORIGINS.has(line.source)) {
    fields.source = line.source;
  }
  return Object.keys(fields).length === 0 ? undefined : Object.freeze(fields);
}

function sandboxLineSize(line: Readonly<SandboxLogLine>): number {
  let size = byteLength(line.message) + byteLength(line.target);
  for (const [key, value] of Object.entries(line.fields)) {
    size += byteLength(key) + byteLength(value);
  }
  return size;
}

/**
 * The sandbox counterpart of `sanitizeRuntimeLogChunk`: OpenShell policy decisions and
 * supervisor tracing become `activity` records. Messages, command lines and URLs are
 * redacted; any structured payload in a message is withheld.
 */
export function sanitizeSandboxLogLines(
  streamValue: RuntimeLogStream,
  lines: readonly Readonly<SandboxLogLine>[],
): SanitizedRuntimeLogChunk {
  const stream = cleanStream(streamValue);
  const records: SanitizedRuntimeLogRecord[] = [];
  let withheld = 0;
  let run: Mutable<Extract<RuntimeLogRecord, { type: "withheld" }>> | undefined;
  for (const line of lines) {
    const time = validTime(line.time);
    let reason: RuntimeLogWithheldReason | undefined;
    let text = "";
    if (sandboxLineSize(line) > RUNTIME_LOG_MAX_INPUT_BYTES) {
      reason = "oversized";
    } else {
      text = stripRuntimeLogControls(line.message);
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        // A structured payload in a tracing message is never shown.
        reason = "unrecognised_structured";
      }
    }
    if (reason !== undefined) {
      withheld += 1;
      if (run !== undefined && run.reason === reason) {
        run.count += 1;
        continue;
      }
      if (run !== undefined) {
        records.push(brand(run));
      }
      run = { type: "withheld", time, stream, count: 1, reason };
      continue;
    }
    if (run !== undefined) {
      records.push(brand(run));
      run = undefined;
    }
    const ocsf = line.level.toUpperCase() === "OCSF";
    const parsed = ocsf ? ocsfFields(text) : undefined;
    let shown = parsed?.message ?? text;
    if (parsed?.fields.url !== undefined) {
      // The URL in the message is cut like the field so a long query cannot fill a page.
      // A replacer function: a URL may contain `$&`-style replacement patterns.
      const url = sanitizeRuntimeLogText(parsed.fields.url, SANDBOX_REDACTED_FIELD_BYTES).text;
      shown = shown.replace(parsed.fields.url, () => url);
    }
    // A PROC line whose `[cmd:` was not recovered, or a tracing message quoting a
    // command, still carries argv; mask credential flags in the message too.
    const message = sanitizeRuntimeLogText(redactArgvCredentials(shown));
    const subsystem =
      line.target.length === 0
        ? undefined
        : sanitizeRuntimeLogText(line.target, MAX_FIELD_CHARS).text;
    const fields = sandboxFields(line, parsed?.fields ?? {});
    const record: LineRecord = {
      type: "line",
      time,
      stream,
      // Policy decisions name hosts, methods and binaries: activity, never content.
      contentClass: "activity",
      kind: "sandbox",
      level: parsed?.level ?? level(line.level),
      message: message.text,
      ...(subsystem === undefined ? {} : { subsystem }),
      ...(fields === undefined ? {} : { fields }),
      ...(message.truncated ? { truncated: true as const } : {}),
    };
    records.push(brand(record));
  }
  if (run !== undefined) {
    records.push(brand(run));
  }
  return Object.freeze({ records: Object.freeze(records), withheld });
}

/** A labelled gap for loss the API observed. Remedy text is fixed. */
export function runtimeLogGap(
  reason: RuntimeLogGapReason,
  stream: RuntimeLogStream,
  time: string | null = null,
): SanitizedRuntimeLogRecord {
  return brand({
    type: "gap",
    time: validTime(time),
    stream: cleanStream(stream),
    reason,
    remedy:
      reason === "stream_replaced" && stream.source === "sandbox"
        ? "The Sandbox was recreated; showing the new one."
        : GAP_REMEDIES[reason],
  });
}

function validTime(value: string | null): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    ? value
    : null;
}
