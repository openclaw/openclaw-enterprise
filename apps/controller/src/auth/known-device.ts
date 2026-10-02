import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Known-device cookie (OWASP "device cookie"). A successful sign-in marks the browser as a
 * known device for that account's email. On a later password attempt for the same email,
 * a valid entry moves the attempt from the shared per-email budget to the device's own
 * budget, so strangers spending the email's budget cannot keep the account's own browser
 * out. The cookie never authenticates and never selects an account: it only chooses which
 * admission lane an attempt for the email it names spends.
 *
 * Each entry is `v2.<keyId>.<issuedAt seconds>.<nonce>.<mac>.<binding>`. The MAC is keyed by
 * the auth secret and covers a hash of the normalized email, the issue time and a random
 * per-issue nonce (so two browsers signing in to one account in the same second still get
 * distinct entries and lanes); `keyId` is a short, non-reversible fingerprint of that
 * secret. The binding is a second MAC over the entry's MAC and the account's sign-in state
 * when it was issued: the user, its password method and that method's version and, with an
 * external provider, whether the account is enabled (not the account's version, so attaching
 * or detaching an external identity keeps the password fallback). Resetting the password or
 * deleting and recreating the account changes that state, so every entry issued before stops
 * verifying; a disabled account has no state, so its entries verify nothing until it is
 * enabled again. No entry carries the email or the state.
 *
 * Verification reads the account's state only after the MAC shows the entry was issued for
 * this exact email under this secret, which only a browser that signed in to the account can
 * present; forged, foreign or malformed entries never reach the account, so they add no
 * timing signal about whether an email exists. Rotating the auth secret invalidates every
 * entry: browsers fall back to the shared lane until their next successful sign-in, which
 * issues a fresh entry under the new secret and drops the entries the old secret signed.
 * Up to three entries (the most recent accounts signed in from the browser) are joined
 * with `~`.
 */
export const KNOWN_DEVICE_LIFETIME_SECONDS = 90 * 86_400;

const maxEntries = 3;
const maxCookieLength = 512;
// Entries issued slightly ahead of this controller's clock (another replica, clock steps)
// are still accepted; anything further ahead is not.
const futureSkewSeconds = 300;
const nonceBytes = 12;
const entryPattern =
  /^v2\.([A-Za-z0-9_-]{8})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

/**
 * The account's current sign-in state for `email` (normalized), as an opaque string that
 * changes whenever a known-device entry must stop verifying, or undefined when the email has
 * no account that can sign in with a password (missing, disabled, or without a password).
 */
export type KnownDeviceAccountState = (email: string) => Promise<string | undefined>;

export function knownDeviceCookieName(secure: boolean): string {
  // __Host- requires Secure, Path=/ and no Domain, so a sibling host cannot plant one.
  return secure ? "__Host-occ_known_device" : "occ_known_device";
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function keyId(secret: string): string {
  return createHmac("sha256", secret)
    .update("occ-known-device-key")
    .digest("base64url")
    .slice(0, 8);
}

function entryMac(secret: string, email: string, issuedAt: number, nonce: string): string {
  const emailHash = createHash("sha256").update(normalizedEmail(email)).digest("hex");
  return createHmac("sha256", secret)
    .update(`occ-known-device\0${emailHash}\0${issuedAt}\0${nonce}`)
    .digest("base64url");
}

function entryBinding(secret: string, mac: string, accountState: string): string {
  return createHmac("sha256", secret)
    .update(`occ-known-device-account\0${mac}\0${accountState}`)
    .digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Entry {
  readonly raw: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly mac: string;
  readonly binding: string;
}

function currentEntries(value: string | undefined, now: number): Entry[] {
  if (value === undefined || value.length === 0 || value.length > maxCookieLength) {
    return [];
  }
  const nowSeconds = Math.floor(now / 1000);
  const entries: Entry[] = [];
  for (const raw of value.split("~").slice(0, maxEntries)) {
    const match = entryPattern.exec(raw);
    if (match === null) {
      continue;
    }
    const issuedAt = Number(match[2]);
    if (
      issuedAt > nowSeconds + futureSkewSeconds ||
      nowSeconds - issuedAt >= KNOWN_DEVICE_LIFETIME_SECONDS
    ) {
      continue;
    }
    entries.push({
      raw,
      keyId: match[1]!,
      issuedAt,
      nonce: match[3]!,
      mac: match[4]!,
      binding: match[5]!,
    });
  }
  return entries;
}

function matches(secret: string, email: string, entry: Entry): boolean {
  return (
    entry.keyId === keyId(secret) &&
    equal(entryMac(secret, email, entry.issuedAt, entry.nonce), entry.mac)
  );
}

/**
 * The known-device identity for `email`, or undefined when the cookie holds no current,
 * untampered entry issued for that email under this secret and bound to the account's
 * current sign-in state. `deviceKey` is opaque and distinct per issued entry (the MAC covers
 * a random nonce); admission hashes it before use. One request selects at most one lane: the
 * first entry that verifies.
 *
 * `accountState` is read at most once, and only when an entry's MAC matches this email. A
 * failed or refused read returns undefined, never a verified exemption. The controller
 * bounds the read with `admitStateRead` and retains its signed keys as additional shared-
 * lane constraints, so losing proof cannot reopen an already-spent device allowance.
 * Signed keys alone constrain resource use; only fresh state verifies the exemption.
 */
export async function verifyKnownDevice(
  secret: string,
  email: string,
  cookieValue: string | undefined,
  now: number,
  accountState: KnownDeviceAccountState,
  admitStateRead?: (
    signedEntryKeys: readonly string[],
    read: () => Promise<string | undefined>,
  ) => Promise<string | undefined>,
): Promise<{ readonly deviceKey: string } | undefined> {
  const candidates = currentEntries(cookieValue, now).filter((entry) =>
    matches(secret, email, entry),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  let state: string | undefined;
  try {
    const read = () => accountState(normalizedEmail(email));
    state = await (admitStateRead === undefined
      ? read()
      : admitStateRead([...new Set(candidates.map((entry) => entry.mac))], read));
  } catch {
    return undefined;
  }
  if (state === undefined) {
    return undefined;
  }
  for (const entry of candidates) {
    if (equal(entryBinding(secret, entry.mac, state), entry.binding)) {
      return { deviceKey: entry.mac };
    }
  }
  return undefined;
}

/**
 * The cookie value after a successful sign-in for `email`, whose account is in
 * `accountState`: a fresh entry first, then up to two current entries for other accounts
 * from the existing value. Entries for this email are replaced, never duplicated; entries
 * signed under a rotated-out secret are dropped.
 */
export function issueKnownDevice(
  secret: string,
  email: string,
  accountState: string,
  now: number,
  existing?: string,
): string {
  const issuedAt = Math.floor(now / 1000);
  const currentKey = keyId(secret);
  const nonce = randomBytes(nonceBytes).toString("base64url");
  const mac = entryMac(secret, email, issuedAt, nonce);
  const fresh = `v2.${currentKey}.${issuedAt}.${nonce}.${mac}.${entryBinding(secret, mac, accountState)}`;
  const others = currentEntries(existing, now)
    .filter((entry) => entry.keyId === currentKey && !matches(secret, email, entry))
    .map((entry) => entry.raw);
  return [fresh, ...others].slice(0, maxEntries).join("~");
}

/** Cookie attributes shared by both sign-in profiles. */
export function knownDeviceCookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: KNOWN_DEVICE_LIFETIME_SECONDS,
  };
}

/** A complete Set-Cookie header value for the password-only profile's Fastify route. */
export function knownDeviceSetCookie(secure: boolean, value: string): string {
  const attributes = knownDeviceCookieAttributes(secure);
  return [
    `${knownDeviceCookieName(secure)}=${value}`,
    `Max-Age=${attributes.maxAge}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ].join("; ");
}

/**
 * Reads the known-device cookie from a Cookie header. A missing, duplicated, or oversized
 * cookie reads as absent, so ambiguity only ever returns an attempt to the shared lane.
 */
export function knownDeviceFromCookieHeader(
  header: string | readonly string[] | null | undefined,
  secure: boolean,
): string | undefined {
  const name = knownDeviceCookieName(secure);
  const joined = typeof header === "string" ? header : (header ?? []).join("; ");
  let found: string | undefined;
  for (const part of joined.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = part.slice(separator + 1).trim();
  }
  return found !== undefined && found.length <= maxCookieLength ? found : undefined;
}
