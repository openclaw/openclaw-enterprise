import { createHmac, timingSafeEqual } from "node:crypto";

// Session binding lets one browser tab pin the exact cookie session it created.
// Every value is derived from the auth secret; none of them can authenticate alone.
export const OCC_SESSION_KEY_HEADER = "x-occ-session-key";
export const LOGIN_RECEIPT_LIFETIME_SECONDS = 120;

const bindingValue = /^[A-Za-z0-9_-]{43}$/;

function mac(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isBindingValue(value: unknown): value is string {
  return typeof value === "string" && bindingValue.test(value);
}

/** Stable, noncredential key for one session record. */
export function sessionBindingKey(secret: string, sessionId: string): string {
  return mac(secret, "occ-session-key", sessionId);
}

/** Public identifier for one GitHub login attempt, derived from its private state. */
export function loginAttemptId(secret: string, stateHash: string): string {
  return mac(secret, "occ-login-attempt", stateHash);
}

/**
 * Reads the optional narrowing header. `undefined` means absent; `null` means
 * duplicated or malformed (Node joins repeated custom headers with ", ").
 */
export function sessionKeyHeader(headers: Headers): string | null | undefined {
  const value = headers.get(OCC_SESSION_KEY_HEADER);
  if (value === null) {
    return undefined;
  }
  return isBindingValue(value) ? value : null;
}

/** True when the key belongs to the session. The header can only narrow, never select. */
export function sessionKeyMatches(secret: string, sessionId: string, key: string): boolean {
  return equal(sessionBindingKey(secret, sessionId), key);
}

export interface LoginReceipt {
  readonly providerId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly expiresAt: number;
}

export function signLoginReceipt(secret: string, receipt: LoginReceipt): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      p: receipt.providerId,
      s: receipt.sessionId,
      a: receipt.attemptId,
      e: receipt.expiresAt,
    }),
  ).toString("base64url");
  return `${payload}.${mac(secret, "occ-login-receipt", payload)}`;
}

export function verifyLoginReceipt(
  secret: string,
  value: string | null | undefined,
  expectedProviderId: string,
  now: number,
): LoginReceipt | undefined {
  if (typeof value !== "string" || value.length > 1024) {
    return undefined;
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return undefined;
  }
  if (!equal(mac(secret, "occ-login-receipt", payload), signature)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const { v, p, s, a, e } = (parsed ?? {}) as Record<string, unknown>;
  if (
    v !== 2 ||
    typeof p !== "string" ||
    p.length === 0 ||
    p !== expectedProviderId ||
    typeof s !== "string" ||
    s.length === 0 ||
    !isBindingValue(a) ||
    typeof e !== "number" ||
    !Number.isSafeInteger(e) ||
    e <= now
  ) {
    return undefined;
  }
  return { providerId: p, sessionId: s, attemptId: a, expiresAt: e };
}

/**
 * Remembers exchanged receipts until they expire, so a copied receipt cannot be
 * exchanged twice. Capacity is bounded by successful GitHub callbacks, which are
 * themselves admission-limited; the Helm chart runs one controller replica.
 */
export function receiptLedger() {
  const consumed = new Map<string, number>();
  return {
    consume(receipt: LoginReceipt, now: number): boolean {
      for (const [attemptId, expiresAt] of consumed) {
        if (expiresAt <= now) {
          consumed.delete(attemptId);
        }
      }
      if (consumed.has(receipt.attemptId)) {
        return false;
      }
      consumed.set(receipt.attemptId, receipt.expiresAt);
      return true;
    },
  };
}
