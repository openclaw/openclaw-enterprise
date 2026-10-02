import type { AgentRuntimeLogsQuery } from "@openclaw-enterprise/contracts";
import {
  RUNTIME_LOG_DEFAULT_TAIL_LINES,
  RUNTIME_LOG_MAX_TAIL_LINES,
  RuntimeLogsError,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type SanitizedRuntimeLogRecord,
} from "@openclaw-enterprise/occ";

/** Operator switch and cursor key for the runtime status and log routes. */
export interface AgentRuntimeLogsConfig {
  readonly enabled: boolean;
  /** The auth secret; cursors are HMAC-signed with it. */
  readonly cursorSecret: string;
}

const RATE_PER_SECOND = 2;
const RATE_BURST = 10;
const MAX_CONCURRENT_READS = 16;
const MAX_TRACKED_BUCKETS = 10_000;

/**
 * Replica-local limits: a token bucket per principal per Agent (2 requests per second,
 * burst 10) and at most 16 concurrent Driver reads per API replica.
 */
export class RuntimeLogLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private active = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  admit(principalId: string, agentId: string): void {
    const key = `${principalId}\0${agentId}`;
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: RATE_BURST, updatedAt: now };
    bucket.tokens = Math.min(
      RATE_BURST,
      bucket.tokens + ((now - bucket.updatedAt) / 1000) * RATE_PER_SECOND,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.remember(key, bucket);
      throw new RuntimeLogsError(
        "RUNTIME_LOGS_RATE_LIMITED",
        Math.max(1, Math.ceil((1 - bucket.tokens) / RATE_PER_SECOND)),
      );
    }
    bucket.tokens -= 1;
    this.remember(key, bucket);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_READS) {
      throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }

  private remember(key: string, bucket: { tokens: number; updatedAt: number }): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > MAX_TRACKED_BUCKETS) {
      // Oldest entries are full buckets by now; dropping them only resets idle callers.
      this.buckets.delete(this.buckets.keys().next().value!);
    }
  }
}

/** Audit action for a download; views are audited as the route's own action. */
export const RUNTIME_LOG_DOWNLOAD_ACTION = "openclaw.agents.runtime_logs.download";

/** A download is one fresh page of the maximum tail; it never continues a view. */
export function isRuntimeLogDownload(query: AgentRuntimeLogsQuery): boolean {
  return query.download === "true";
}

export function runtimeLogQuery(query: AgentRuntimeLogsQuery): RuntimeLogQuery {
  const download = isRuntimeLogDownload(query);
  return {
    source: query.source,
    ...(query.pod === undefined ? {} : { pod: query.pod }),
    previous: query.previous === "true",
    tailLines: download
      ? RUNTIME_LOG_MAX_TAIL_LINES
      : query.tailLines === undefined
        ? RUNTIME_LOG_DEFAULT_TAIL_LINES
        : Number(query.tailLines),
    ...(query.sinceSeconds === undefined ? {} : { sinceSeconds: Number(query.sinceSeconds) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.minLevel === undefined ? {} : { minLevel: query.minLevel }),
  };
}

function serializedRecords(records: readonly SanitizedRuntimeLogRecord[]) {
  // `content` has no producer; seeing it means a classifier regression, never a page.
  if (records.some((record) => record.type === "line" && record.contentClass === "content")) {
    throw new Error("A runtime log record carried the reserved content class.");
  }
  return records;
}

/** The response body accepts sanitized records only. */
export function runtimeLogPageBody(page: RuntimeLogPage) {
  return {
    revisionId: page.revisionId,
    source: page.source,
    stream: page.stream,
    observedAt: page.observedAt,
    records: serializedRecords(page.records),
    withheld: page.withheld,
    truncated: page.truncated,
    cursor: page.cursor,
  };
}

function fieldText(value: string | number | boolean): string {
  const text = String(value);
  return text.length > 0 && /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
}

function recordText(record: SanitizedRuntimeLogRecord): string {
  const time = record.time ?? "-";
  switch (record.type) {
    case "gap":
      return `${time} GAP ${record.reason}: ${record.remedy}`;
    case "withheld":
      return `${time} WITHHELD ${record.count} ${record.reason}`;
    case "line": {
      const fields = Object.entries(record.fields ?? {}).map(
        ([name, value]) => ` ${name}=${fieldText(value)}`,
      );
      return [
        `${time} ${record.level.toUpperCase()} ${record.kind}`,
        record.subsystem === undefined ? "" : ` [${record.subsystem}]`,
        ` ${record.message}`,
        ...fields,
      ].join("");
    }
  }
}

/**
 * The download body: the same sanitized records as the JSON page, one per line.
 * Like the JSON serializer it accepts only branded records.
 */
export function runtimeLogDownloadBody(page: RuntimeLogPage, agentId: string): string {
  const stream = page.stream;
  const header = [
    `# agent=${agentId} revision=${page.revisionId} source=${page.source}`,
    stream?.pod === undefined ? "" : ` pod=${stream.pod}`,
    stream?.container === undefined ? "" : ` container=${stream.container}`,
    stream?.restartCount === undefined ? "" : ` restartCount=${stream.restartCount}`,
    stream?.sandbox === undefined ? "" : ` sandbox=${stream.sandbox}`,
    ` observedAt=${page.observedAt} withheld=${page.withheld}`,
  ].join("");
  const lines = serializedRecords(page.records).map(recordText);
  return `${[header, ...lines].join("\n")}\n`;
}

/** `<agent>-<revision>-<source>-<pod or sandbox>.log`; every part is an OCC or Kubernetes name. */
export function runtimeLogDownloadFileName(page: RuntimeLogPage, agentId: string): string {
  const name = [
    agentId,
    page.revisionId,
    page.source,
    page.stream?.pod ?? page.stream?.sandbox ?? "no-pod",
  ].join("-");
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
}
