import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RuntimeLogSourceId } from "@openclaw-enterprise/contracts";

const PURPOSE = "occ-runtime-logs-cursor";
export const RUNTIME_LOG_CURSOR_TTL_MS = 60 * 60 * 1000;
const MAX_HASHES = 48;

/** Identity a cursor is bound to; a cursor never crosses principals, Agents or revisions. */
export interface RuntimeLogCursorBinding {
  readonly principalId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly source: RuntimeLogSourceId;
}

export interface SandboxLogWindowCheckpoint {
  readonly since: string | null;
  readonly tailLines: number;
  readonly count: number;
  readonly seen: number;
  readonly hash: string;
  readonly total: number;
}

export interface ContainerLogWindowCheckpoint {
  readonly sinceTime: string | null;
  readonly tailLines: number;
  readonly count: number;
  readonly seen: number;
  readonly hash: string;
  readonly truncated: boolean;
  readonly baseTime: string | null;
  readonly baseHashes: readonly string[];
  readonly baseComplete: boolean;
  readonly basePositional?: boolean;
  readonly baseCount?: number;
}

export interface RuntimeLogCursorPosition {
  readonly viewId: string;
  readonly pod: string;
  readonly podUid: string;
  readonly restartCount: number;
  readonly previous: boolean;
  /**
   * Kubelet time of the newest line delivered, or null before any line. The sandbox
   * source stores its resume time here instead, which trails the newest line.
   */
  readonly lastTime: string | null;
  /**
   * Hashes of the raw lines delivered at `lastTime` (sandbox: at or after it, one per
   * occurrence), for overlap de-duplication.
   */
  readonly lastHashes: readonly string[];
  /** The fetched tail did not omit earlier occurrences at the delivered frontier. */
  readonly frontierComplete?: boolean;
  /**
   * Container lines delivered at `lastTime`, including those whose hashes no longer
   * fit in `lastHashes`; absent on legacy cursors.
   */
  readonly frontierCount?: number;
  /** Container PEM context; absent on legacy cursors and unknown initial tails. */
  readonly pemOpen?: boolean;
  /** Conservative delivered-time frontier; null cannot establish forward chronology. */
  readonly pemAfterTime?: string | null;
  /** Authenticated value-prefix progress while a Sandbox response is byte-cut. */
  readonly sandboxWindow?: SandboxLogWindowCheckpoint;
  /** Authenticated raw-window progress while a container response is byte-cut. */
  readonly containerWindow?: ContainerLogWindowCheckpoint;
  readonly issuedAt: number;
}

export type RuntimeLogCursorDecode =
  | { readonly status: "valid"; readonly position: RuntimeLogCursorPosition }
  | { readonly status: "expired"; readonly position: RuntimeLogCursorPosition }
  | { readonly status: "invalid" };

export interface RuntimeLogCursorCodec {
  encode(binding: RuntimeLogCursorBinding, position: RuntimeLogCursorPosition): string;
  decode(token: string, binding: RuntimeLogCursorBinding, now?: number): RuntimeLogCursorDecode;
}

export function runtimeLogLineHash(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url").slice(0, 16);
}

export function newRuntimeLogViewId(): string {
  return `rlv_${randomUUID()}`;
}

function bindingHash(binding: RuntimeLogCursorBinding): string {
  return createHash("sha256")
    .update([binding.principalId, binding.agentId, binding.revisionId, binding.source].join("\0"))
    .digest("base64url")
    .slice(0, 22);
}

function mac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}\0${value}`).digest("base64url");
}

function sameMac(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Kubelet UTC timestamp, with its original nanosecond precision retained. */
export function validRuntimeLogFrontierTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

/** Kubelet RFC 3339 times trim trailing zeros; pad the fraction before comparing. */
export function runtimeLogTimeKey(value: string): string {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  return match === null ? value : `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}

function sandboxWindow(value: unknown): SandboxLogWindowCheckpoint | undefined {
  if (!Array.isArray(value) || value.length !== 6) {
    return undefined;
  }
  const [since, tailLines, count, seen, hash, total] = value as unknown[];
  if (
    (since !== null && !validRuntimeLogFrontierTime(since)) ||
    !Number.isSafeInteger(tailLines) ||
    (tailLines as number) < 1 ||
    (tailLines as number) > 1000 ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    !Number.isSafeInteger(seen) ||
    (seen as number) < (count as number) ||
    (seen as number) > (tailLines as number) ||
    typeof hash !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(hash) ||
    !Number.isSafeInteger(total) ||
    (total as number) < (seen as number)
  ) {
    return undefined;
  }
  return {
    since: since as string | null,
    tailLines: tailLines as number,
    count: count as number,
    seen: seen as number,
    hash,
    total: total as number,
  };
}

function containerWindow(value: unknown): ContainerLogWindowCheckpoint | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const window: Record<string, unknown> = Array.isArray(value)
    ? value.length === 10 || value.length === 11
      ? {
          sinceTime: value[0],
          tailLines: value[1],
          count: value[2],
          seen: value[3],
          hash: value[4],
          truncated: value[5],
          baseTime: value[6],
          baseHashes:
            typeof value[7] === "string" && /^(?:[A-Za-z0-9_-]{16}){0,16}$/.test(value[7])
              ? (value[7].match(/.{16}/g) ?? [])
              : undefined,
          baseComplete: value[8],
          ...(value.length === 10
            ? {}
            : { basePositional: value[10] === 0 || value[10] === 1 ? value[10] === 1 : value[10] }),
          ...(value[9] === null ? {} : { baseCount: value[9] }),
        }
      : {}
    : (value as Record<string, unknown>);
  if (
    (window.sinceTime !== null && !validRuntimeLogFrontierTime(window.sinceTime)) ||
    (window.baseTime !== null && !validRuntimeLogFrontierTime(window.baseTime)) ||
    !Number.isSafeInteger(window.tailLines) ||
    (window.tailLines as number) < 1 ||
    (window.tailLines as number) > 1000 ||
    !Number.isSafeInteger(window.count) ||
    (window.count as number) < 0 ||
    !Number.isSafeInteger(window.seen) ||
    (window.seen as number) < (window.count as number) ||
    (window.seen as number) > 1001 ||
    typeof window.hash !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(window.hash) ||
    typeof window.truncated !== "boolean" ||
    typeof window.baseComplete !== "boolean" ||
    (window.basePositional !== undefined && typeof window.basePositional !== "boolean") ||
    !Array.isArray(window.baseHashes) ||
    window.baseHashes.length > 16 ||
    !window.baseHashes.every(
      (hash) => typeof hash === "string" && /^[A-Za-z0-9_-]{16}$/.test(hash),
    ) ||
    (window.baseCount !== undefined &&
      (!Number.isSafeInteger(window.baseCount) ||
        (window.baseCount as number) < window.baseHashes.length ||
        (window.baseTime === null && window.baseCount !== 0)))
  ) {
    return undefined;
  }
  return {
    sinceTime: window.sinceTime as string | null,
    tailLines: window.tailLines as number,
    count: window.count as number,
    seen: window.seen as number,
    hash: window.hash,
    truncated: window.truncated,
    baseTime: window.baseTime as string | null,
    baseHashes: window.baseHashes as string[],
    baseComplete: window.baseComplete,
    ...(window.basePositional === undefined ? {} : { basePositional: window.basePositional }),
    ...(window.baseCount === undefined ? {} : { baseCount: window.baseCount as number }),
  };
}

function position(value: unknown): RuntimeLogCursorPosition | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.h === "string" && !/^(?:[A-Za-z0-9_-]{16}){0,48}$/.test(record.h)) {
    return undefined;
  }
  const hashes = typeof record.h === "string" ? (record.h.match(/.{16}/g) ?? []) : record.h;
  const window = record.w === undefined ? undefined : sandboxWindow(record.w);
  const container = record.cw === undefined ? undefined : containerWindow(record.cw);
  const hasPem = Object.hasOwn(record, "po") || Object.hasOwn(record, "pt");
  if (
    (record.w !== undefined && window === undefined) ||
    (record.cw !== undefined && container === undefined) ||
    typeof record.v !== "string" ||
    typeof record.p !== "string" ||
    typeof record.u !== "string" ||
    !Number.isSafeInteger(record.r) ||
    (record.r as number) < 0 ||
    typeof record.pr !== "boolean" ||
    (record.t !== null && typeof record.t !== "string") ||
    !Array.isArray(hashes) ||
    hashes.length > MAX_HASHES ||
    !hashes.every((hash) => typeof hash === "string" && /^[A-Za-z0-9_-]{16}$/.test(hash)) ||
    !Number.isSafeInteger(record.i) ||
    (record.fc !== undefined && typeof record.fc !== "boolean") ||
    (record.fn !== undefined &&
      (!Number.isSafeInteger(record.fn) ||
        (record.fn as number) < hashes.length ||
        (record.t === null && record.fn !== 0))) ||
    (hasPem &&
      (typeof record.po !== "boolean" ||
        (record.pt !== null &&
          (!validRuntimeLogFrontierTime(record.pt) ||
            !validRuntimeLogFrontierTime(record.t) ||
            runtimeLogTimeKey(record.pt) !== runtimeLogTimeKey(record.t)))))
  ) {
    return undefined;
  }
  return {
    viewId: record.v,
    pod: record.p,
    podUid: record.u,
    restartCount: record.r as number,
    previous: record.pr,
    lastTime: record.t as string | null,
    lastHashes: hashes as string[],
    issuedAt: record.i as number,
    ...(window === undefined ? {} : { sandboxWindow: window }),
    ...(container === undefined ? {} : { containerWindow: container }),
    ...(record.fc === undefined ? {} : { frontierComplete: record.fc as boolean }),
    ...(record.fn === undefined ? {} : { frontierCount: record.fn as number }),
    ...(hasPem ? { pemOpen: record.po as boolean, pemAfterTime: record.pt as string | null } : {}),
  };
}

/** HMAC-signed with the auth secret, the same construction as session binding. */
export function createRuntimeLogCursorCodec(secret: string): RuntimeLogCursorCodec {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("The runtime log cursor secret must be at least 32 characters.");
  }
  return Object.freeze({
    encode(binding: RuntimeLogCursorBinding, value: RuntimeLogCursorPosition): string {
      const payload = Buffer.from(
        JSON.stringify({
          b: bindingHash(binding),
          v: value.viewId,
          p: value.pod,
          u: value.podUid,
          r: value.restartCount,
          pr: value.previous,
          t: value.lastTime,
          // Fixed-width hashes retain every ordered occurrence without punctuation.
          h: value.lastHashes.slice(-MAX_HASHES).join(""),
          i: value.issuedAt,
          fc: value.frontierComplete,
          fn: value.frontierCount,
          po: value.pemOpen,
          pt: value.pemAfterTime,
          // The outer t/h hold the positional baseline or advanced timed overlap.
          // Compact the additional window witness without dropping hashes.
          w:
            value.sandboxWindow === undefined
              ? undefined
              : [
                  value.sandboxWindow.since,
                  value.sandboxWindow.tailLines,
                  value.sandboxWindow.count,
                  value.sandboxWindow.seen,
                  value.sandboxWindow.hash,
                  value.sandboxWindow.total,
                ],
          cw:
            value.containerWindow === undefined
              ? undefined
              : [
                  value.containerWindow.sinceTime,
                  value.containerWindow.tailLines,
                  value.containerWindow.count,
                  value.containerWindow.seen,
                  value.containerWindow.hash,
                  value.containerWindow.truncated,
                  value.containerWindow.baseTime,
                  value.containerWindow.baseHashes.join(""),
                  value.containerWindow.baseComplete,
                  value.containerWindow.baseCount ?? null,
                  value.containerWindow.basePositional === true ? 1 : 0,
                ],
        }),
      ).toString("base64url");
      return `v1.${payload}.${mac(secret, payload)}`;
    },
    decode(token: string, binding: RuntimeLogCursorBinding, now = Date.now()) {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "v1" || !sameMac(parts[2]!, mac(secret, parts[1]!))) {
        return { status: "invalid" } as const;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      } catch {
        return { status: "invalid" } as const;
      }
      const decoded = position(parsed);
      if (
        decoded === undefined ||
        (parsed as { b?: unknown }).b !== bindingHash(binding) ||
        decoded.issuedAt > now + 60_000
      ) {
        return { status: "invalid" } as const;
      }
      return now - decoded.issuedAt > RUNTIME_LOG_CURSOR_TTL_MS
        ? ({ status: "expired", position: decoded } as const)
        : ({ status: "valid", position: decoded } as const);
    },
  });
}
