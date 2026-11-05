import type { AgentRuntimeLogsQuery } from "@openclaw-enterprise/contracts";
import {
  RUNTIME_LOG_DEFAULT_TAIL_LINES,
  RUNTIME_LOG_MAX_TAIL_LINES,
  RuntimeLogsError,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type SanitizedRuntimeLogRecord,
} from "@openclaw-enterprise/occ";

import { RequestRateLimiter } from "./request-rate-limiter.ts";

/** Operator switch and cursor key for the runtime status and log routes. */
export interface AgentRuntimeLogsConfig {
  readonly enabled: boolean;
  /** The auth secret; cursors are HMAC-signed with it. */
  readonly cursorSecret: string;
}

const RATE_PER_SECOND = 2;
const RATE_BURST = 10;
const MAX_CONCURRENT_READS = 16;

/**
 * Replica-local limits: a token bucket per principal per Agent (2 requests per second,
 * burst 10) and at most 16 concurrent Driver reads per API replica.
 */
export class RuntimeLogLimiter {
  private readonly rateLimit: RequestRateLimiter;
  private active = 0;

  constructor(now: () => number = () => performance.now()) {
    this.rateLimit = new RequestRateLimiter(RATE_BURST, RATE_PER_SECOND, now);
  }

  admit(principalId: string, agentId: string): void {
    const key = `${principalId}\0${agentId}`;
    const retryAfter = this.rateLimit.consume(key);
    if (retryAfter !== undefined) {
      throw new RuntimeLogsError("RUNTIME_LOGS_RATE_LIMITED", retryAfter);
    }
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
    ...(query.container === undefined ? {} : { container: query.container }),
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
export function runtimeLogDownloadBody(
  page: RuntimeLogPage,
  agentId: string,
  previous: boolean,
): string {
  const stream = page.stream;
  const header = [
    `# agent=${agentId} revision=${page.revisionId} source=${page.source}`,
    stream?.pod === undefined ? "" : ` pod=${stream.pod}`,
    stream?.container === undefined ? "" : ` container=${stream.container}`,
    stream?.restartCount === undefined ? "" : ` restartCount=${stream.restartCount}`,
    stream?.sandbox === undefined ? "" : ` sandbox=${stream.sandbox}`,
    page.source === "sandbox" ? "" : ` instance=${previous ? "previous" : "current"}`,
    ` observedAt=${page.observedAt} withheld=${page.withheld}`,
  ].join("");
  const lines = serializedRecords(page.records).map(recordText);
  return `${[header, ...lines].join("\n")}\n`;
}

/** Previous container instances append `-previous`; names use OCC or Kubernetes identifiers. */
export function runtimeLogDownloadFileName(
  page: RuntimeLogPage,
  agentId: string,
  previous: boolean,
): string {
  const name = [
    agentId,
    page.revisionId,
    page.source,
    page.stream?.pod ?? page.stream?.sandbox ?? "no-pod",
  ].join("-");
  const suffix = page.source !== "sandbox" && previous ? "-previous" : "";
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}${suffix}.log`;
}
