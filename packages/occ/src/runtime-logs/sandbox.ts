import type {
  AgentRuntimeDescription,
  RuntimeLogStream,
  SandboxLogChunk,
  SandboxLogLine,
  SandboxLogRequest,
} from "@openclaw-enterprise/contracts";
import {
  newRuntimeLogViewId,
  runtimeLogLineHash,
  type RuntimeLogCursorBinding,
  type RuntimeLogCursorCodec,
  type RuntimeLogCursorPosition,
} from "./cursor.ts";
import {
  compareRuntimeLogTime,
  RuntimeLogReadError,
  RUNTIME_LOG_MAX_TAIL_LINES,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type RuntimeLogViewAdmission,
} from "./read.ts";
import {
  runtimeLogGap,
  sanitizeSandboxLogLines,
  type SanitizedRuntimeLogRecord,
} from "./sanitize.ts";

const SANDBOX_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SANDBOX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_FIELDS_PER_LINE = 64;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_LINE_BYTES_COUNTED = 8 * 1024;

/** Fixed notice for loss the API cannot observe (AL2). */
export const SANDBOX_LOG_RETENTION =
  "OpenShell keeps the last 2000 lines per sandbox in memory and loses them when its gateway restarts. Lines the sandbox could not send under load are dropped without notice.";

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_FIELDS_PER_LINE &&
    entries.every(([key, entry]) => key.length <= 64 && typeof entry === "string")
  );
}

function validLine(value: unknown): value is SandboxLogLine {
  const line = value as SandboxLogLine;
  return (
    line !== null &&
    typeof line === "object" &&
    (line.time === null || (typeof line.time === "string" && TIME.test(line.time))) &&
    typeof line.sandboxId === "string" &&
    (line.sandboxId.length === 0 || SANDBOX_ID.test(line.sandboxId)) &&
    typeof line.level === "string" &&
    line.level.length <= 32 &&
    typeof line.target === "string" &&
    typeof line.message === "string" &&
    typeof line.source === "string" &&
    line.source.length <= 32 &&
    isStringMap(line.fields)
  );
}

/**
 * A Driver chunk for the revision's one Sandbox: a DNS name, bounded lines, and every
 * line from the same Sandbox object. Lines naming two Sandboxes are refused whole.
 */
function validChunk(value: unknown, requested: number): SandboxLogChunk {
  const chunk = value as SandboxLogChunk;
  if (
    chunk === null ||
    typeof chunk !== "object" ||
    typeof chunk.sandbox !== "string" ||
    !SANDBOX_NAME.test(chunk.sandbox) ||
    !Array.isArray(chunk.lines) ||
    chunk.lines.length > requested ||
    !Number.isSafeInteger(chunk.bufferTotal) ||
    chunk.bufferTotal < chunk.lines.length ||
    !chunk.lines.every(validLine)
  ) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  const ids = new Set(chunk.lines.map(({ sandboxId }) => sandboxId).filter((id) => id !== ""));
  if (ids.size > 1) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  return chunk;
}

/** Stable identity of one raw line for overlap de-duplication. */
export function sandboxLogLineHash(line: Readonly<SandboxLogLine>): string {
  const fields = Object.keys(line.fields)
    .sort()
    .map((key) => [key, line.fields[key]]);
  return runtimeLogLineHash(
    JSON.stringify([line.time, line.level, line.target, line.message, line.source, fields]),
  );
}

function lineBytes(line: Readonly<SandboxLogLine>): number {
  let size = Buffer.byteLength(line.message, "utf8") + Buffer.byteLength(line.target, "utf8");
  for (const [key, value] of Object.entries(line.fields)) {
    size += key.length + Buffer.byteLength(value, "utf8");
  }
  return Math.min(size, MAX_LINE_BYTES_COUNTED) + 256;
}

export interface ReadSandboxLogPageInput {
  readonly description: Readonly<AgentRuntimeDescription>;
  readonly query: RuntimeLogQuery;
  readonly codec: RuntimeLogCursorCodec;
  readonly binding: RuntimeLogCursorBinding;
  readonly now?: () => number;
  /** Writes the view audit event; runs before any Driver read of log text. */
  readonly admitView: (admission: RuntimeLogViewAdmission) => Promise<void>;
  readonly readLogs: (request: SandboxLogRequest) => Promise<SandboxLogChunk>;
}

/**
 * How far a follow resume re-reads behind the newest line it delivered. OpenShell stamps
 * a supervisor line when it is recorded and pushes it up to 500 ms later (longer across a
 * reconnect), while the gateway files its own lines at once, so a line can arrive after
 * a newer one was already shown. The gateway filters by time only, so without the
 * overlap such a line would fall before the resume time and never be returned.
 */
export const SANDBOX_LOG_OVERLAP_MS = 5_000;
/** Occurrences the cursor remembers inside the overlap; bounded by the cursor size. */
export const SANDBOX_LOG_OVERLAP_LINES = 48;

const FRACTION_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

/** `time` moved by whole seconds plus nanoseconds, kept at nanosecond precision. */
function shiftTime(time: string, seconds: number, nanos = 0): string {
  const match = FRACTION_TIME.exec(time)!;
  let wholeMs = Date.parse(`${match[1]}Z`) + seconds * 1000;
  let fraction = Number((match[2] ?? "").padEnd(9, "0")) + nanos;
  if (fraction >= 1e9) {
    fraction -= 1e9;
    wholeMs += 1000;
  }
  return `${new Date(wholeMs).toISOString().slice(0, 19)}.${String(fraction).padStart(9, "0")}Z`;
}

interface OverlapLine {
  readonly time: string;
  readonly hash: string;
}

/**
 * The cursor's overlap: a resume time and the occurrences delivered at or after it. Whole
 * timestamps are dropped from the oldest end until the rest fits, so every delivered line
 * at or after `since` is counted. When one timestamp alone holds more lines than fit, the
 * cursor resumes just after it and `overflow` is set: a late line stamped at or before it
 * could be missed, which the page reports as a gap.
 */
function overlapWindow(
  seen: readonly OverlapLine[],
  floor: string | null,
): { since: string | null; hashes: string[]; overflow: string | null } {
  if (seen.length === 0) {
    return { since: floor, hashes: [], overflow: null };
  }
  const ordered = [...seen].sort((a, b) => compareRuntimeLogTime(a.time, b.time));
  const newest = ordered.at(-1)!.time;
  let since = shiftTime(newest, -SANDBOX_LOG_OVERLAP_MS / 1000);
  if (floor !== null && compareRuntimeLogTime(floor, since) > 0) {
    since = floor;
  }
  let kept = ordered.filter((line) => compareRuntimeLogTime(line.time, since) >= 0);
  if (kept.length > SANDBOX_LOG_OVERLAP_LINES) {
    // Drop the boundary timestamp whole so every retained occurrence fits in the cursor.
    const cutoff = kept[kept.length - SANDBOX_LOG_OVERLAP_LINES - 1]!.time;
    if (compareRuntimeLogTime(cutoff, newest) === 0) {
      return { since: shiftTime(newest, 0, 1), hashes: [], overflow: newest };
    }
    kept = kept.filter((line) => compareRuntimeLogTime(line.time, cutoff) > 0);
    since = kept[0]!.time;
  }
  return { since, hashes: kept.map(({ hash }) => hash), overflow: null };
}

/**
 * One bounded page of the revision's Sandbox log: cursor validation, an overlapping
 * resume, occurrence-counted de-duplication, gap records and sanitization.
 *
 * The source is a ring buffer read as "of the last N lines, those at or after
 * `sinceTime`". The cursor holds a resume time up to `SANDBOX_LOG_OVERLAP_MS` behind the
 * newest delivered line and one hash per line delivered at or after it, repeats included.
 * A resume re-reads that overlap and each returned line consumes one matching hash; what
 * is left over is new, so a late-arriving older line and a repeat of an identical line
 * are both delivered, and no delivered line is shown twice. When no remembered line came
 * back and nothing older did either, lines were lost: `window_exceeded` when the
 * requested window was full, otherwise `buffer_lost` (the buffer rolled over or
 * restarted).
 */
export async function readSandboxLogPage(input: ReadSandboxLogPageInput): Promise<RuntimeLogPage> {
  const now = input.now ?? Date.now;
  const { description, query, codec, binding } = input;
  const decoded =
    query.cursor === undefined ? undefined : codec.decode(query.cursor, binding, now());
  if (decoded?.status === "invalid") {
    throw new RuntimeLogReadError("cursor_invalid");
  }
  if (!description.sources.some(({ id, kind }) => id === "sandbox" && kind === "sandbox")) {
    throw new RuntimeLogReadError("source_unavailable");
  }
  // A Sandbox has no Pods to choose from and no previous instance.
  if (query.pod !== undefined || query.previous) {
    throw new RuntimeLogReadError("pod_invalid");
  }
  const prior =
    decoded?.status === "valid" && !decoded.position.previous ? decoded.position : undefined;
  // A view is audited once, before its first read; an expired cursor starts a new view.
  const viewId = prior?.viewId ?? newRuntimeLogViewId();
  if (prior === undefined) {
    await input.admitView({
      viewId,
      revisionId: description.revisionId,
      source: "sandbox",
      previous: false,
      tailLines: query.tailLines,
    });
  }
  // For this source the cursor's `lastTime` is the resume time, not the newest line.
  const resume = prior?.lastTime === null ? undefined : prior;
  const sinceTime =
    resume !== undefined
      ? resume.lastTime!
      : query.sinceSeconds === undefined
        ? undefined
        : new Date(now() - query.sinceSeconds * 1000).toISOString();
  const tailLines = Math.min(query.tailLines, RUNTIME_LOG_MAX_TAIL_LINES);
  const chunk = validChunk(
    await input.readLogs({ lines: tailLines, ...(sinceTime === undefined ? {} : { sinceTime }) }),
    tailLines,
  );
  const stream: RuntimeLogStream = { source: "sandbox", sandbox: chunk.sandbox };
  const lineId = chunk.lines.find(({ sandboxId }) => sandboxId !== "")?.sandboxId;
  const sandboxId = lineId ?? (prior?.pod === chunk.sandbox ? prior.podUid : "");
  const leading: SanitizedRuntimeLogRecord[] = [];
  if (decoded?.status === "expired") {
    leading.push(runtimeLogGap("cursor_expired", stream));
  }
  // The same revision's Sandbox was deleted and created again: a new stream.
  const replaced =
    prior !== undefined &&
    (prior.pod !== chunk.sandbox ||
      (prior.podUid !== "" && sandboxId !== "" && prior.podUid !== sandboxId));
  if (replaced) {
    leading.push(runtimeLogGap("stream_replaced", stream));
  }
  const continuing = resume !== undefined && !replaced;
  // Lines already delivered that the read returned again, with their times.
  const matched: OverlapLine[] = [];
  const carried: OverlapLine[] = [];
  let gapFloor: string | null = null;
  let lines = chunk.lines;
  if (continuing) {
    const remaining = new Map<string, number>();
    for (const hash of resume.lastHashes) {
      remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
    }
    lines = lines.filter((line) => {
      if (line.time === null) {
        return true;
      }
      const hash = sandboxLogLineHash(line);
      const count = remaining.get(hash) ?? 0;
      if (count === 0) {
        return true;
      }
      remaining.set(hash, count - 1);
      matched.push({ time: line.time, hash });
      return false;
    });
    // A remembered line the read did not return may only be outside a smaller tail than
    // before; keep it, dated at the resume time (its earliest possible time), so it is
    // forgotten once the window moves past that time instead of being shown again.
    for (const [hash, count] of remaining) {
      for (let index = 0; index < count; index += 1) {
        carried.push({ time: resume.lastTime!, hash });
      }
    }
    // Lines the source dropped by time were older than the resume time: nothing between
    // pages is missing. A cursor with no remembered lines has nothing to anchor on.
    const olderSeen = chunk.lines.length < chunk.bufferTotal;
    if (resume.lastHashes.length > 0 && matched.length === 0 && !olderSeen) {
      const earliest = lines.find((line) => line.time !== null)?.time ?? null;
      // The gap covers everything before the lines read now; resume from the oldest.
      for (const line of lines) {
        if (
          line.time !== null &&
          (gapFloor === null || compareRuntimeLogTime(line.time, gapFloor) < 0)
        ) {
          gapFloor = line.time;
        }
      }
      leading.push(
        runtimeLogGap(
          chunk.bufferTotal >= tailLines ? "window_exceeded" : "buffer_lost",
          stream,
          earliest,
        ),
      );
    }
  }
  let pageBytes = 0;
  let pageCut = false;
  const delivered: SandboxLogLine[] = [];
  for (const line of lines) {
    pageBytes += lineBytes(line);
    if (pageBytes > MAX_PAGE_BYTES) {
      pageCut = true;
      break;
    }
    delivered.push(line);
  }
  const sanitized = sanitizeSandboxLogLines(stream, delivered);
  const window = overlapWindow(
    [
      ...carried,
      ...matched,
      ...delivered
        .filter((line) => line.time !== null)
        .map((line) => ({ time: line.time!, hash: sandboxLogLineHash(line) })),
    ],
    gapFloor ?? (continuing ? resume.lastTime : null),
  );
  const records = [
    ...leading,
    ...sanitized.records,
    ...(window.overflow === null
      ? []
      : [runtimeLogGap("window_exceeded", stream, window.overflow)]),
    ...(pageCut ? [runtimeLogGap("truncated", stream, delivered.at(-1)?.time ?? null)] : []),
  ];
  // The cursor reuses the container position shape: `pod` holds the Sandbox name and
  // `podUid` the Sandbox object ID the source reported.
  const position: RuntimeLogCursorPosition = {
    viewId,
    pod: chunk.sandbox,
    podUid: sandboxId,
    restartCount: 0,
    previous: false,
    lastTime: window.since,
    lastHashes: window.hashes,
    issuedAt: now(),
  };
  return Object.freeze({
    revisionId: description.revisionId,
    source: "sandbox",
    stream: Object.freeze(stream),
    observedAt: new Date(now()).toISOString(),
    records: Object.freeze(records),
    withheld: sanitized.withheld,
    truncated: pageCut,
    cursor: codec.encode(binding, position),
  });
}
