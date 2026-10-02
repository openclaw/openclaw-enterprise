import { createPublicKey, verify } from "node:crypto";

// OpenID Connect ID-token checks shared by Google and generic OIDC sign-in. The signing
// key comes only from the provider's JWKS fetched for this callback; nothing in the token
// chooses it beyond its `kid`.

export interface IdTokenExpectation {
  // Exact `iss` strings, compared byte for byte.
  readonly issuers: ReadonlySet<string>;
  readonly clientId: string;
  readonly nonce: string;
  readonly jwks: unknown;
  // Milliseconds since the epoch.
  readonly now: number;
}

const segmentPattern = /^[A-Za-z0-9_-]+$/;
export const subjectPattern = /^[\x21-\x7E]{1,255}$/;
// RSA keys below this modulus size are refused, whatever the JWKS offers.
const minimumModulusBits = 2048;
// The allowance for a provider clock ahead of ours, for `iat` and `nbf`.
const clockAllowanceSeconds = 60;
// Header members that carry or locate a key, or demand extensions we do not implement.
const refusedHeaderMembers = ["jwk", "jku", "x5c", "x5u", "crit"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function segmentJSON(segment: string): Record<string, unknown> | undefined {
  return record(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
}

function signingKey(jwks: unknown, kid: string): { kty: "RSA"; n: string; e: string } | undefined {
  const keys = record(jwks)?.keys;
  if (!Array.isArray(keys)) {
    return undefined;
  }
  for (const candidate of keys) {
    const key = record(candidate);
    if (
      key?.kid === kid &&
      key.kty === "RSA" &&
      (key.alg === undefined || key.alg === "RS256") &&
      (key.use === undefined || key.use === "sig") &&
      typeof key.n === "string" &&
      typeof key.e === "string"
    ) {
      return { kty: "RSA", n: key.n, e: key.e };
    }
  }
  return undefined;
}

/**
 * Returns the claims of a valid RS256 ID token, or undefined. Valid means: signed by an RSA
 * key of at least 2,048 bits named by `kid` in `jwks`; `iss` one of `issuers`; `aud`
 * exactly the client ID (a string, or a list naming only it), `azp` equal to it when present;
 * the expected nonce; `exp` in the future with no leeway; `iat` within the last hour and at
 * most 60 s ahead; `nbf`, when present, at most 60 s ahead; and a bounded printable `sub`.
 */
export function verifyIdToken(
  token: string,
  expected: IdTokenExpectation,
): Record<string, unknown> | undefined {
  try {
    const segments = token.split(".");
    if (segments.length !== 3 || !segments.every((segment) => segmentPattern.test(segment))) {
      return undefined;
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = segmentJSON(encodedHeader);
    if (
      header?.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      refusedHeaderMembers.some((member) => Object.hasOwn(header, member))
    ) {
      return undefined;
    }
    const jwk = signingKey(expected.jwks, header.kid);
    if (!jwk) {
      return undefined;
    }
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < minimumModulusBits ||
      !verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key,
        Buffer.from(encodedSignature, "base64url"),
      )
    ) {
      return undefined;
    }
    const claims = segmentJSON(encodedPayload);
    if (!claims || typeof claims.iss !== "string" || !expected.issuers.has(claims.iss)) {
      return undefined;
    }
    const { clientId } = expected;
    // The configured client is the only trusted audience (OIDC Core 3.1.3.7 step 3): a list
    // is accepted only when it names the client alone, so any extra audience is refused.
    const audience =
      Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
    if (audience !== clientId) {
      return undefined;
    }
    if (claims.azp !== undefined && claims.azp !== clientId) {
      return undefined;
    }
    const now = Math.floor(expected.now / 1000);
    if (
      typeof claims.exp !== "number" ||
      !(claims.exp > now) ||
      typeof claims.iat !== "number" ||
      claims.iat > now + clockAllowanceSeconds ||
      claims.iat < now - 3600 ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || claims.nbf > now + clockAllowanceSeconds))
    ) {
      return undefined;
    }
    if (expected.nonce.length === 0 || claims.nonce !== expected.nonce) {
      return undefined;
    }
    if (typeof claims.sub !== "string" || !subjectPattern.test(claims.sub)) {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}
