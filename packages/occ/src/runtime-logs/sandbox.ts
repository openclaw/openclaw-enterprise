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

import { boundedRuntimeLogPage } from "./page-budget.ts";

const SANDBOX_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SANDBOX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_FIELDS_PER_LINE = 64;

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

function sandboxPrefixHash(lines: readonly SandboxLogLine[], count: number): string {
  return runtimeLogLineHash(lines.slice(0, count).map(sandboxLogLineHash).join("\0"));
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
  const checkpoint = prior?.sandboxWindow;
  const sinceTime =
    checkpoint !== undefined
      ? (checkpoint.since ?? undefined)
      : resume !== undefined
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
  const checkpointValid =
    checkpoint !== undefined &&
    !replaced &&
    checkpoint.tailLines === tailLines &&
    checkpoint.seen <= chunk.lines.length &&
    checkpoint.hash === sandboxPrefixHash(chunk.lines, checkpoint.seen) &&
    !(
      checkpoint.total !== chunk.bufferTotal &&
      (checkpoint.total >= tailLines || chunk.bufferTotal >= tailLines)
    );
  const checkpointLost = checkpoint !== undefined && !replaced && !checkpointValid;
  // A position-only checkpoint retains its pre-cut baseline. A resumable timed
  // cut can also retain a window witness beside advanced overlap. If that witness
  // changes, an ordered earlier timestamp establishes the overlap group's start;
  // otherwise a fresh snapshot with a gap may replay, but must not hide unread copies.
  const resumeTime = replaced ? null : (resume?.lastTime ?? null);
  const timed = chunk.lines.filter((line) => line.time !== null);
  const overlapContext =
    !checkpointLost ||
    resumeTime === null ||
    (timed.some((line) => compareRuntimeLogTime(line.time!, resumeTime) < 0) &&
      timed.every(
        (line, index) =>
          index === 0 || compareRuntimeLogTime(line.time!, timed[index - 1]!.time!) >= 0,
      ));
  const baseTime = overlapContext ? resumeTime : null;
  const baseHashes = replaced || !overlapContext ? [] : (prior?.lastHashes ?? []);
  const continuing = baseTime !== null && !replaced;
  if (checkpointLost) {
    leading.push(
      runtimeLogGap(
        chunk.bufferTotal >= tailLines ? "window_exceeded" : "buffer_lost",
        stream,
        chunk.lines.find((line) => line.time !== null)?.time ?? null,
      ),
    );
  }
  // Lines already delivered that the read returned again, with their times.
  const matched: OverlapLine[] = [];
  const carried: OverlapLine[] = [];
  let gapFloor: string | null = null;
  let eligible = chunk.lines.map((line, index) => ({ line, index }));
  if (continuing) {
    const remaining = new Map<string, number>();
    for (const hash of baseHashes) {
      remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
    }
    eligible = eligible.filter(({ line, index }) => {
      if (line.time === null) {
        return true;
      }
      // A retained witness reads its original window; the advanced overlap has
      // already delivered timed rows before this floor.
      if (
        compareRuntimeLogTime(line.time, baseTime) < 0 &&
        !(checkpointValid && index >= checkpoint.count)
      ) {
        return false;
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
        carried.push({ time: baseTime, hash });
      }
    }
    // Lines the source dropped by time were older than the resume time: nothing between
    // pages is missing. A cursor with no remembered lines has nothing to anchor on.
    const olderSeen = chunk.lines.length < chunk.bufferTotal;
    if (baseHashes.length > 0 && matched.length === 0 && !olderSeen) {
      const earliest = eligible.find(({ line }) => line.time !== null)?.line.time ?? null;
      // The gap covers everything before the lines read now; resume from the oldest.
      for (const { line } of eligible) {
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
  const remaining = checkpointValid
    ? eligible.filter(({ index }) => index >= checkpoint.count)
    : eligible;
  const lines = remaining.map(({ line }) => line);
  // A later ordered tail cannot establish order in this observed snapshot.
  // Keep its positional baseline when delayed batches made its times uncertain.
  const orderedSnapshot = chunk.lines.every(
    (line, index) =>
      line.time !== null &&
      (index === 0 ||
        (chunk.lines[index - 1]!.time !== null &&
          compareRuntimeLogTime(line.time, chunk.lines[index - 1]!.time!) >= 0)),
  );
  const issuedAt = now();
  const observedAt = new Date(issuedAt).toISOString();
  return boundedRuntimeLogPage(lines.length, (end) => {
    const delivered = lines.slice(0, end);
    const pageCut = end < lines.length;
    const consumed =
      end === lines.length
        ? chunk.lines.length
        : end === 0
          ? checkpointValid
            ? checkpoint.count
            : 0
          : remaining[end - 1]!.index + 1;
    const consumedLines = eligible.filter(({ index }) => index < consumed).map(({ line }) => line);
    const sanitized = sanitizeSandboxLogLines(stream, delivered);
    const window = overlapWindow(
      [
        ...carried,
        ...matched,
        ...consumedLines
          .filter((line) => line.time !== null)
          .map((line) => ({ time: line.time!, hash: sandboxLogLineHash(line) })),
      ],
      // A view's first page floors the resume time at its requested window start, so a
      // cursor poll without `sinceSeconds` (after an empty page) reads nothing older.
      gapFloor ?? (continuing ? baseTime : (sinceTime ?? null)),
    );
    // A full moving tail invalidates positional checkpoints on every append. Use
    // the normal delivered overlap when it still covers every undelivered time.
    // A partial timestamp group still fits when the overlap counts every delivered
    // occurrence at its time. Untimed rows, overflow, or a suffix before the overlap
    // floor require the signed snapshot until that observed window drains.
    const newestDelivered = delivered.reduce<string | null>(
      (newest, line) =>
        line.time !== null && (newest === null || compareRuntimeLogTime(line.time, newest) > 0)
          ? line.time
          : newest,
      null,
    );
    const retainCheckpoint =
      (pageCut &&
        (!orderedSnapshot ||
          chunk.bufferTotal < tailLines ||
          consumedLines.some((line) => line.time === null) ||
          window.overflow !== null ||
          window.since === null ||
          newestDelivered === null ||
          lines
            .slice(end)
            .some(
              (line) => line.time === null || compareRuntimeLogTime(line.time, window.since!) < 0,
            ))) ||
      (checkpoint !== undefined &&
        (consumedLines.some((line) => line.time === null) || lines.length === 0));
    // Every wire cut needs a witness: a late identical copy may arrive after
    // this read, even when its current suffix has no repeated hash.
    const saveCheckpoint = pageCut || retainCheckpoint;
    // Identical occurrences in a full single-time tail can roll without visible change.
    const firstTime = chunk.lines[0]?.time;
    const fullSingleTime =
      firstTime != null &&
      chunk.lines.length >= tailLines &&
      chunk.lines.every(
        (line) => line.time !== null && compareRuntimeLogTime(line.time, firstTime) === 0,
      );
    const unobservableTail =
      (saveCheckpoint || checkpoint !== undefined || fullSingleTime) &&
      chunk.bufferTotal >= tailLines;
    const records = [
      ...leading,
      ...(unobservableTail &&
      window.overflow === null &&
      !leading.some((record) => record.type === "gap" && record.reason === "window_exceeded")
        ? [runtimeLogGap("window_exceeded", stream)]
        : []),
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
      // Pin the baseline for positional-only cuts. Safe timed overlap can advance
      // beside the raw witness without crossing an undelivered time.
      lastTime: retainCheckpoint ? (baseTime ?? sinceTime ?? null) : window.since,
      lastHashes: retainCheckpoint ? baseHashes : window.hashes,
      ...(saveCheckpoint
        ? {
            sandboxWindow: {
              since: sinceTime ?? null,
              tailLines,
              count: consumed,
              seen: chunk.lines.length,
              hash: sandboxPrefixHash(chunk.lines, chunk.lines.length),
              total: chunk.bufferTotal,
            },
          }
        : {}),
      issuedAt,
    };
    return Object.freeze({
      revisionId: description.revisionId,
      source: "sandbox",
      stream: Object.freeze(stream),
      observedAt,
      records: Object.freeze(records),
      withheld: sanitized.withheld,
      truncated: pageCut,
      cursor: codec.encode(binding, position),
    });
  });
}
