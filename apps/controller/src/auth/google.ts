import { createHmac, createPublicKey, verify } from "node:crypto";
import { authorizationCodeRequest, createAuthorizationURL } from "better-auth/oauth2";
import {
  providerExchangeFailure,
  providerJSON,
  rejected,
  type ProviderExchange,
} from "./provider-transport.ts";

// Google OpenID Connect, fixed endpoints (no runtime discovery):
// https://accounts.google.com/.well-known/openid-configuration
export const googleAuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const certsEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const issuers = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleLoginConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  // Lowercased hosted domains. Empty means no hosted-domain restriction.
  readonly allowedDomains: readonly string[];
}

const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function googleLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): GoogleLoginConfiguration | undefined {
  const clientId = environment.OCC_AUTH_GOOGLE_CLIENT_ID;
  const clientSecret = environment.OCC_AUTH_GOOGLE_CLIENT_SECRET;
  const domains = environment.OCC_AUTH_GOOGLE_ALLOWED_DOMAINS;
  if (clientId === undefined && clientSecret === undefined && domains === undefined) {
    return undefined;
  }
  if (
    typeof clientId !== "string" ||
    clientId.trim().length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.trim().length === 0
  ) {
    throw new Error("Google sign-in requires both client ID and client secret.");
  }
  const allowedDomains =
    domains === undefined ? [] : domains.split(",").map((domain) => domain.trim().toLowerCase());
  if (allowedDomains.some((domain) => !domainPattern.test(domain))) {
    throw new Error(
      "OCC_AUTH_GOOGLE_ALLOWED_DOMAINS must be a comma-separated list of DNS domain names.",
    );
  }
  return { clientId, clientSecret, allowedDomains };
}

// Google sign-in's configuration as the controller receives it: the guarded profile's
// recovery user ID travels with each configured provider.
export interface GoogleSignInConfiguration extends GoogleLoginConfiguration {
  readonly recoveryUserId: string;
}

// Builds the authorization request directly: Better Auth's Google provider treats
// nonce as a reserved additional parameter and would drop it.
export async function googleAuthorizationURL(
  config: GoogleLoginConfiguration,
  state: string,
  codeVerifier: string,
  redirectURI: string,
  nonce: string,
): Promise<URL> {
  return createAuthorizationURL({
    id: "google",
    options: { clientId: config.clientId, clientSecret: config.clientSecret },
    authorizationEndpoint: googleAuthorizationEndpoint,
    scopes: ["openid", "email"],
    state,
    codeVerifier,
    redirectURI,
    nonce,
  });
}

// The OIDC nonce is derived from the one-use, browser-bound attempt state, so it
// needs no storage and binds the ID token to exactly that attempt.
export function googleNonce(secret: string, state: string): string {
  return createHmac("sha256", secret).update(`oce-google-nonce\0${state}`).digest("base64url");
}

export interface GoogleIdTokenExpectation {
  readonly clientId: string;
  readonly nonce: string;
  readonly allowedDomains: readonly string[];
  readonly jwks: unknown;
  // Milliseconds since the epoch.
  readonly now: number;
}

const segmentPattern = /^[A-Za-z0-9_-]+$/;
const subjectPattern = /^[\x21-\x7E]{1,255}$/;

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

// Returns the Google subject ("sub") of a valid ID token, or undefined. The email
// is never an identity; token contents are never returned otherwise.
export function verifyGoogleIdToken(
  token: string,
  expected: GoogleIdTokenExpectation,
): string | undefined {
  try {
    const segments = token.split(".");
    if (segments.length !== 3 || !segments.every((segment) => segmentPattern.test(segment))) {
      return undefined;
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = segmentJSON(encodedHeader);
    if (header?.alg !== "RS256" || typeof header.kid !== "string") {
      return undefined;
    }
    const jwk = signingKey(expected.jwks, header.kid);
    if (!jwk) {
      return undefined;
    }
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (
      key.asymmetricKeyType !== "rsa" ||
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
    if (!claims || typeof claims.iss !== "string" || !issuers.has(claims.iss)) {
      return undefined;
    }
    const { clientId } = expected;
    if (Array.isArray(claims.aud)) {
      if (!claims.aud.includes(clientId) || claims.azp !== clientId) {
        return undefined;
      }
    } else if (claims.aud !== clientId) {
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
      claims.iat > now + 60 ||
      claims.iat < now - 3600
    ) {
      return undefined;
    }
    if (expected.nonce.length === 0 || claims.nonce !== expected.nonce) {
      return undefined;
    }
    if (typeof claims.sub !== "string" || !subjectPattern.test(claims.sub)) {
      return undefined;
    }
    if (
      expected.allowedDomains.length > 0 &&
      (typeof claims.hd !== "string" ||
        !expected.allowedDomains.includes(claims.hd.toLowerCase()) ||
        claims.email_verified !== true)
    ) {
      return undefined;
    }
    return claims.sub;
  } catch {
    return undefined;
  }
}

export async function exchangeGoogleSubject(
  config: GoogleLoginConfiguration,
  code: string,
  codeVerifier: string,
  redirectURI: string,
  nonce: string,
): Promise<ProviderExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();
  try {
    const request = await authorizationCodeRequest({
      code,
      codeVerifier,
      redirectURI,
      options: { clientId: config.clientId, clientSecret: config.clientSecret },
      tokenEndpoint,
    });
    const data = await providerJSON(
      tokenEndpoint,
      { method: "POST", ...request },
      controller.signal,
    );
    if ("error" in data || typeof data.id_token !== "string" || !data.id_token) {
      throw rejected();
    }
    const jwks = await providerJSON(certsEndpoint, {}, controller.signal);
    controller.signal.throwIfAborted();
    const subject = verifyGoogleIdToken(data.id_token, {
      clientId: config.clientId,
      nonce,
      allowedDomains: config.allowedDomains,
      jwks,
      now: Date.now(),
    });
    return subject === undefined ? { denial: "EXTERNAL_IDENTITY_REJECTED" } : { subject };
  } catch (error) {
    // Never expose provider response bodies, token values or request credentials.
    return providerExchangeFailure(error, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
