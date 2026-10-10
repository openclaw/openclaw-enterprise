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

function position(value: unknown): RuntimeLogCursorPosition | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const hashes = record.h;
  const hasPem = Object.hasOwn(record, "po") || Object.hasOwn(record, "pt");
  if (
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
          h: value.lastHashes.slice(-MAX_HASHES),
          i: value.issuedAt,
          fc: value.frontierComplete,
          fn: value.frontierCount,
          po: value.pemOpen,
          pt: value.pemAfterTime,
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
