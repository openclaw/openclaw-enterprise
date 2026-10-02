import { createHmac } from "node:crypto";
import { authorizationCodeRequest, createAuthorizationURL } from "better-auth/oauth2";
import {
  providerExchangeFailure,
  providerJSON,
  rejected,
  type ProviderExchange,
} from "./provider-transport.ts";
import { verifyIdToken } from "./id-token.ts";

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

// Returns the Google subject ("sub") of a valid ID token, or undefined. The email
// is never an identity; token contents are never returned otherwise.
export function verifyGoogleIdToken(
  token: string,
  expected: GoogleIdTokenExpectation,
): string | undefined {
  const claims = verifyIdToken(token, {
    issuers,
    clientId: expected.clientId,
    nonce: expected.nonce,
    jwks: expected.jwks,
    now: expected.now,
  });
  if (claims === undefined) {
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
  return claims.sub as string;
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
      "token",
    );
    if ("error" in data || typeof data.id_token !== "string" || !data.id_token) {
      throw rejected();
    }
    const jwks = await providerJSON(certsEndpoint, {}, controller.signal, "jwks");
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
