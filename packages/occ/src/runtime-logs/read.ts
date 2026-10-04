import type {
  AgentRuntimeDescription,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  RuntimeLogLevel,
  RuntimeLogSourceId,
  RuntimeLogStream,
} from "@openclaw-enterprise/contracts";
import {
  newRuntimeLogViewId,
  runtimeLogLineHash,
  runtimeLogTimeKey,
  validRuntimeLogFrontierTime,
  type RuntimeLogCursorBinding,
  type RuntimeLogCursorCodec,
  type RuntimeLogCursorPosition,
} from "./cursor.ts";
import {
  runtimeLogGap,
  sanitizeRuntimeLogChunk,
  type SanitizedRuntimeLogRecord,
} from "./sanitize.ts";

export const RUNTIME_LOG_LIMIT_BYTES = 1024 * 1024;
export const RUNTIME_LOG_DEFAULT_TAIL_LINES = 200;
export const RUNTIME_LOG_MAX_TAIL_LINES = 1000;
const RUNTIME_LOG_MAX_PAGE_BYTES = 512 * 1024;
const RESUME_OVERLAP_SECONDS = 2;

export interface RuntimeLogQuery {
  readonly source: RuntimeLogSourceId;
  readonly pod?: string;
  readonly previous: boolean;
  readonly tailLines: number;
  readonly sinceSeconds?: number;
  readonly cursor?: string;
  /** Drop lines below this level; unknown-level lines, gaps and withheld counts stay. */
  readonly minLevel?: RuntimeLogMinimumLevel;
}

export type RuntimeLogMinimumLevel = Exclude<RuntimeLogLevel, "unknown">;

const LEVEL_RANK: Readonly<Record<RuntimeLogMinimumLevel, number>> = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
});

/**
 * The page with lines below `minLevel` removed. It runs after the page is read,
 * sanitized and its cursor signed, so the cursor still resumes after the last line
 * read (shown or not), and gap and withheld records are kept.
 */
export function runtimeLogPageAtLevel(
  page: RuntimeLogPage,
  minLevel: RuntimeLogMinimumLevel | undefined,
): RuntimeLogPage {
  if (minLevel === undefined || minLevel === "debug") {
    return page;
  }
  const floor = LEVEL_RANK[minLevel];
  return Object.freeze({
    ...page,
    records: Object.freeze(
      page.records.filter(
        (record) =>
          record.type !== "line" || record.level === "unknown" || LEVEL_RANK[record.level] >= floor,
      ),
    ),
  });
}

/** Audit details for one view; never message text. */
export interface RuntimeLogViewAdmission {
  readonly viewId: string;
  readonly revisionId: string;
  readonly source: RuntimeLogSourceId;
  /** Container sources only; a Sandbox view is identified by its revision. */
  readonly pod?: string;
  readonly container?: string;
  readonly previous: boolean;
  readonly tailLines: number;
}

export interface RuntimeLogPage {
  readonly revisionId: string;
  readonly source: RuntimeLogSourceId;
  readonly stream: RuntimeLogStream | null;
  readonly observedAt: string;
  readonly records: readonly SanitizedRuntimeLogRecord[];
  readonly withheld: number;
  readonly truncated: boolean;
  readonly cursor: string | null;
}

export type RuntimeLogReadFailure =
  "cursor_invalid" | "source_unavailable" | "pod_invalid" | "invalid_chunk";

export class RuntimeLogReadError extends Error {
  readonly reason: RuntimeLogReadFailure;

  constructor(reason: RuntimeLogReadFailure) {
    super(`Runtime log read failed: ${reason}.`);
    this.name = "RuntimeLogReadError";
    this.reason = reason;
  }
}

export function compareRuntimeLogTime(left: string, right: string): number {
  const a = runtimeLogTimeKey(left);
  const b = runtimeLogTimeKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validChunk(value: unknown, source: RuntimeLogSourceId): AgentRuntimeLogChunk {
  const chunk = value as AgentRuntimeLogChunk;
  if (
    chunk === null ||
    typeof chunk !== "object" ||
    chunk.stream === null ||
    typeof chunk.stream !== "object" ||
    chunk.stream.source !== source ||
    !Array.isArray(chunk.lines) ||
    chunk.lines.length > RUNTIME_LOG_MAX_TAIL_LINES + 1 ||
    typeof chunk.truncated !== "boolean" ||
    !chunk.lines.every(
      (line) =>
        line !== null &&
        typeof line === "object" &&
        typeof line.raw === "string" &&
        (line.time === null || typeof line.time === "string"),
    )
  ) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  return chunk;
}

export interface ReadRuntimeLogPageInput {
  readonly description: Readonly<AgentRuntimeDescription>;
  readonly query: RuntimeLogQuery;
  readonly codec: RuntimeLogCursorCodec;
  readonly binding: RuntimeLogCursorBinding;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Writes the view audit event; runs before any Driver read of log text. */
  readonly admitView: (admission: RuntimeLogViewAdmission) => Promise<void>;
  readonly readLogs: (request: AgentRuntimeLogRequest) => Promise<AgentRuntimeLogChunk>;
}

/**
 * One bounded page of one container stream: cursor validation, resume window,
 * de-duplication, gap records and sanitization. The Driver sees only Pods that
 * `describeAgentRuntime` listed for this revision.
 */
export async function readRuntimeLogPage(input: ReadRuntimeLogPageInput): Promise<RuntimeLogPage> {
  const now = input.now ?? Date.now;
  const { description, query, codec, binding } = input;
  const decoded =
    query.cursor === undefined ? undefined : codec.decode(query.cursor, binding, now());
  if (decoded?.status === "invalid") {
    throw new RuntimeLogReadError("cursor_invalid");
  }
  const sourceId = query.source;
  const source = description.sources.find(({ id }) => id === sourceId);
  if (sourceId === "sandbox" || source === undefined || source.kind !== "container") {
    throw new RuntimeLogReadError("source_unavailable");
  }
  if (query.pod !== undefined && !source.pods.some(({ name }) => name === query.pod)) {
    throw new RuntimeLogReadError("pod_invalid");
  }
  const cursorPosition = decoded?.status === "valid" ? decoded.position : undefined;
  // A cursor continues only its own view: the same instance selection and Pod choice.
  // Anything else is a new view and is audited like a request without a cursor.
  const prior =
    cursorPosition !== undefined &&
    cursorPosition.previous === query.previous &&
    (query.pod === undefined || query.pod === cursorPosition.pod)
      ? cursorPosition
      : undefined;
  const podName = query.pod ?? prior?.pod ?? source.pods[0]?.name;
  const pod =
    source.pods.find(({ name }) => name === podName) ??
    (query.pod === undefined ? source.pods[0] : undefined);
  const observedAt = new Date(now()).toISOString();
  if (pod === undefined) {
    return Object.freeze({
      revisionId: description.revisionId,
      source: query.source,
      stream: null,
      observedAt,
      records: Object.freeze([]),
      withheld: 0,
      truncated: false,
      cursor: null,
    });
  }
  const stream: RuntimeLogStream = {
    source: sourceId,
    pod: pod.name,
    podUid: pod.uid,
    container: pod.container,
    restartCount: pod.restartCount,
  };
  const leading: SanitizedRuntimeLogRecord[] = [];
  if (decoded?.status === "expired") {
    leading.push(runtimeLogGap("cursor_expired", stream));
  }
  const sameStream =
    prior !== undefined &&
    prior.pod === pod.name &&
    prior.podUid === pod.uid &&
    prior.restartCount === pod.restartCount;
  if (prior !== undefined && !sameStream) {
    leading.push(runtimeLogGap("stream_replaced", stream));
  }
  const resume = sameStream && prior.lastTime !== null ? prior : undefined;
  // A view that has delivered no line yet (a quiet container, or an empty
  // `sinceSeconds` window) continues from its previous page, not from the whole tail:
  // cursor polls need not repeat `sinceSeconds`, and a cursor reads newer lines only.
  // The bound starts at the previous read, not the end of its page: the cursor's
  // `issuedAt` is taken before the Driver read.
  const quiet = sameStream && prior.lastTime === null ? prior : undefined;
  // A view is audited once, before its first Driver read. Cursor polls inside a
  // view are not re-audited; an expired cursor starts a new view, and so does a
  // cursor whose Pod is gone (the audit row names the Pod that is read).
  const continuesView = prior !== undefined && prior.pod === pod.name;
  const viewId = continuesView ? prior.viewId : newRuntimeLogViewId();
  if (!continuesView) {
    await input.admitView({
      viewId,
      revisionId: description.revisionId,
      source: query.source,
      pod: pod.name,
      container: pod.container,
      previous: query.previous,
      tailLines: query.tailLines,
    });
  }
  const secondsSince = (time: number) =>
    Math.min(86_400, Math.max(1, Math.ceil((now() - time) / 1000) + RESUME_OVERLAP_SECONDS));
  const sinceSeconds =
    resume !== undefined
      ? secondsSince(Date.parse(resume.lastTime!))
      : quiet !== undefined
        ? secondsSince(quiet.issuedAt)
        : query.sinceSeconds;
  const readStartedAt = now();
  const chunk = validChunk(
    await input.readLogs({
      source: sourceId,
      pod: pod.name,
      podUid: pod.uid,
      container: pod.container,
      previous: query.previous,
      tailLines: query.tailLines,
      ...(sinceSeconds === undefined ? {} : { sinceSeconds }),
      limitBytes: RUNTIME_LOG_LIMIT_BYTES,
      signal: input.signal,
    }),
    sourceId,
  );
  const observedStream: RuntimeLogStream = {
    source: sourceId,
    pod: pod.name,
    podUid:
      typeof chunk.stream.podUid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(chunk.stream.podUid)
        ? chunk.stream.podUid
        : pod.uid,
    container: pod.container,
    restartCount:
      Number.isSafeInteger(chunk.stream.restartCount) && chunk.stream.restartCount! >= 0
        ? chunk.stream.restartCount!
        : pod.restartCount,
  };
  // The Driver re-reads the Pod after the log read; a changed instance means the
  // lines may span two containers.
  const replacedDuringRead =
    observedStream.podUid !== pod.uid || observedStream.restartCount !== pod.restartCount;
  if (
    replacedDuringRead &&
    !leading.some((record) => record.type === "gap" && record.reason === "stream_replaced")
  ) {
    leading.push(runtimeLogGap("stream_replaced", observedStream));
  }
  // The byte limit cuts the final line; a partial line may end inside a token.
  const completeLines = chunk.truncated ? chunk.lines.slice(0, -1) : chunk.lines;
  let lines = completeLines;
  // A line longer than the byte limit fills the page alone; its leading time is intact.
  const earliest =
    (completeLines.length === 0 ? chunk.lines : lines).find((line) => line.time !== null)?.time ??
    null;
  // A full tail since a quiet view's previous read may have dropped its oldest lines.
  // A byte-cut page counts as full: the Driver cuts after applying the tail.
  if (
    quiet !== undefined &&
    !replacedDuringRead &&
    (chunk.lines.length >= query.tailLines || chunk.truncated) &&
    earliest !== null
  ) {
    leading.push(runtimeLogGap("window_exceeded", observedStream, earliest));
  }
  if (resume !== undefined && !replacedDuringRead) {
    const lastTime = resume.lastTime!;
    const seen = new Set(resume.lastHashes);
    // The overlap re-reads the last delivered line unless the tail dropped it. The
    // Driver applies the tail before its byte cut, so a cut page may hold fewer than
    // `tailLines` lines and still have lost the lines before it.
    if (
      (chunk.lines.length >= query.tailLines || chunk.truncated) &&
      earliest !== null &&
      compareRuntimeLogTime(earliest, lastTime) > 0
    ) {
      leading.push(runtimeLogGap("window_exceeded", observedStream, earliest));
    }
    lines = lines.filter((line) => {
      if (line.time === null) {
        return true;
      }
      const order = compareRuntimeLogTime(line.time, lastTime);
      return order > 0 || (order === 0 && !seen.has(runtimeLogLineHash(line.raw)));
    });
  }
  // Bound the page. Later lines are dropped so the cursor resumes after the last
  // delivered line; the Driver's byte cut already dropped the final partial line.
  let pageBytes = 0;
  let pageCut = false;
  const delivered: (typeof lines)[number][] = [];
  for (const line of lines) {
    pageBytes += Math.min(Buffer.byteLength(line.raw, "utf8"), 8 * 1024) + 256;
    if (pageBytes > RUNTIME_LOG_MAX_PAGE_BYTES) {
      pageCut = true;
      break;
    }
    delivered.push(line);
  }
  // A resumed read starts RESUME_OVERLAP_SECONDS (plus up to one second of rounding)
  // before the newest delivered line. When the overlap and the next line do not fit in
  // the byte limit (typically one line longer than 1 MiB), the read delivers nothing
  // new and the cursor never moves. `stalledAt` is that cut line's time, set only when
  // every poll re-reads the same lines: each complete line is inside the overlap every
  // read covers. Once the cut line is older than where a poll from this read starts
  // (overlap plus one second of rounding), drop the frontier and continue in the form
  // a fresh view already takes after one oversized line: no delivered time, reading
  // from this read (`issuedAt`). There is no cursor format change. Bounded costs:
  // - the lines logged after the cut line until this read are lost (no read could
  //   reach them past the limit); the window_exceeded gap says so;
  // - a carried PEM context keeps no delivered frontier (`pemAfterTime` null), so an
  //   open block cannot close and a later BEGIN stays open for the rest of the view:
  //   more masking, never less;
  // - the new read has no time de-duplication, so kubelet clock skew behind OCC by
  //   more than the guard can re-deliver lines near the old frontier;
  // - until the cut line is past the guard (up to about 3 s) the view stays put.
  const cutLine = chunk.truncated ? chunk.lines.at(-1) : undefined;
  const overlapStart =
    resume === undefined ? 0 : Date.parse(resume.lastTime!) - RESUME_OVERLAP_SECONDS * 1000;
  const stalledAt =
    resume !== undefined &&
    !replacedDuringRead &&
    delivered.every((line) => line.time === null) &&
    completeLines.every((line) => line.time === null || Date.parse(line.time) >= overlapStart) &&
    validRuntimeLogFrontierTime(cutLine?.time) &&
    compareRuntimeLogTime(cutLine.time, resume.lastTime!) >= 0
      ? cutLine.time
      : undefined;
  const skipStalled =
    stalledAt !== undefined &&
    Date.parse(stalledAt) < readStartedAt - (RESUME_OVERLAP_SECONDS + 1) * 1000;
  // Context belongs AFTER the authenticated delivered frontier, never before the
  // fetched overlap. Hashes and equal timestamps cannot prove a new closing line.
  const pemPrior =
    sameStream && !replacedDuringRead && prior.pemOpen !== undefined ? prior : undefined;
  // Locate the consumed prefix by the actual subsequence retained above, not by
  // hashes. Validate ordering only through the last delivered line: future fetched
  // lines must neither close context nor advance its persistent frontier.
  let nextDelivered = 0;
  let prefixEnd = 0;
  for (const [index, line] of completeLines.entries()) {
    if (nextDelivered < delivered.length && line === delivered[nextDelivered]) {
      nextDelivered += 1;
      prefixEnd = index + 1;
    }
  }
  const prefix = completeLines.slice(0, prefixEnd);
  const ordered = prefix.every(
    (line, index) =>
      validRuntimeLogFrontierTime(line.time) &&
      (index === 0 || compareRuntimeLogTime(line.time, prefix[index - 1]!.time!) >= 0),
  );
  // Uncertain chronology also applies when BEGIN is first observed in this page.
  // Without this guard, an older/null-time END could close it before any signed
  // context exists, leaving a false closed state that later polls cannot repair.
  const canClose = !ordered
    ? delivered.map(() => false)
    : pemPrior === undefined
      ? undefined
      : delivered.map(
          (line) =>
            pemPrior.pemAfterTime != null &&
            line.time !== null &&
            compareRuntimeLogTime(line.time, pemPrior.pemAfterTime) > 0,
        );
  const sanitized = sanitizeRuntimeLogChunk(
    {
      stream: observedStream,
      lines: delivered,
      truncated: false,
    },
    { open: pemPrior?.pemOpen, canClose },
  );
  let pemAfterTime = pemPrior?.pemAfterTime ?? null;
  if (delivered.length > 0) {
    if (!ordered || (pemPrior !== undefined && pemPrior.pemAfterTime === null)) {
      // A later timestamped page cannot reconstruct an unknown boundary.
      pemAfterTime = null;
    } else {
      const deliveredTime = delivered.at(-1)!.time!;
      if (pemAfterTime === null || compareRuntimeLogTime(deliveredTime, pemAfterTime) > 0) {
        pemAfterTime = deliveredTime;
      }
    }
  }
  if (skipStalled) {
    pemAfterTime = null;
  }
  const truncated = chunk.truncated || pageCut;
  const records = [
    // The skip's own gap replaces a window_exceeded gap dated at the same cut line.
    ...(skipStalled
      ? leading.filter((record) => record.type !== "gap" || record.reason !== "window_exceeded")
      : leading),
    ...sanitized.records,
    ...(skipStalled
      ? [runtimeLogGap("window_exceeded", observedStream, stalledAt, true)]
      : truncated
        ? [
            runtimeLogGap(
              "truncated",
              observedStream,
              delivered.at(-1)?.time ?? null,
              stalledAt !== undefined,
            ),
          ]
        : []),
  ];
  const last = [...delivered].reverse().find((line) => line.time !== null);
  const kept = resume !== undefined && !replacedDuringRead && !skipStalled;
  let lastTime = kept ? resume.lastTime : null;
  let lastHashes = kept ? [...resume.lastHashes] : [];
  if (last !== undefined) {
    if (lastTime === null || compareRuntimeLogTime(last.time!, lastTime) !== 0) {
      lastHashes = [];
    }
    lastTime = last.time;
    for (const line of delivered) {
      if (line.time !== null && compareRuntimeLogTime(line.time, lastTime!) === 0) {
        lastHashes.push(runtimeLogLineHash(line.raw));
      }
    }
  }
  const position: RuntimeLogCursorPosition = {
    viewId,
    pod: pod.name,
    podUid: observedStream.podUid!,
    restartCount: observedStream.restartCount!,
    previous: query.previous,
    lastTime,
    lastHashes: lastHashes.slice(-16),
    ...(sanitized.pemOpen === undefined ? {} : { pemOpen: sanitized.pemOpen, pemAfterTime }),
    issuedAt: readStartedAt,
  };
  return Object.freeze({
    revisionId: description.revisionId,
    source: query.source,
    stream: Object.freeze(observedStream),
    observedAt,
    records: Object.freeze(records),
    withheld: sanitized.withheld,
    truncated,
    cursor: codec.encode(binding, position),
  });
}
