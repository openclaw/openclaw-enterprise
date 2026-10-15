import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { authorizationCodeRequest, createAuthorizationURL } from "better-auth/oauth2";
import {
  providerExchangeFailure,
  providerJSON,
  rejected,
  type PinnedEndpoint,
  type ProviderExchange,
} from "./provider-transport.ts";
import { verifyIdToken } from "./id-token.ts";

// Generic OpenID Connect sign-in against one operator-configured issuer. The four URLs are
// configuration copied from the IdP's discovery document; the controller never runs
// discovery, so nothing at request time chooses what it fetches.

export type OidcTokenAuth = "client_secret_post" | "client_secret_basic";

export interface OidcLoginConfiguration {
  // The exact `iss` value, compared byte for byte.
  readonly issuer: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: PinnedEndpoint;
  readonly jwksUrl: PinnedEndpoint;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenAuth: OidcTokenAuth;
  // The Console button label: "Continue with <displayName>".
  readonly displayName: string;
}

// OIDC sign-in's configuration as the controller receives it: the guarded profile's
// recovery user ID travels with each configured provider.
export interface OidcSignInConfiguration extends OidcLoginConfiguration {
  readonly recoveryUserId: string;
}

export const OIDC_DEFAULT_DISPLAY_NAME = "single sign-on";

const requiredVariables = [
  "OCC_AUTH_OIDC_ISSUER",
  "OCC_AUTH_OIDC_AUTHORIZATION_URL",
  "OCC_AUTH_OIDC_TOKEN_URL",
  "OCC_AUTH_OIDC_JWKS_URL",
  "OCC_AUTH_OIDC_CLIENT_ID",
  "OCC_AUTH_OIDC_CLIENT_SECRET",
] as const;
const optionalVariables = ["OCC_AUTH_OIDC_TOKEN_AUTH", "OCC_AUTH_OIDC_DISPLAY_NAME"] as const;

const dnsName =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Printable text: no control, format, separator-other or unassigned characters.
const displayNamePattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u;

// An `https:` URL on the default port with a DNS host and no userinfo, query or fragment.
// Returns the parsed URL, or undefined.
function endpointURL(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    !dnsName.test(url.hostname)
  ) {
    return undefined;
  }
  return url;
}

export function oidcLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): OidcLoginConfiguration | undefined {
  if (
    [...requiredVariables, ...optionalVariables].every((name) => environment[name] === undefined)
  ) {
    return undefined;
  }
  const values = Object.fromEntries(
    requiredVariables.map((name) => [name, environment[name]?.trim() ?? ""]),
  ) as Record<(typeof requiredVariables)[number], string>;
  if (Object.values(values).some((value) => value.length === 0)) {
    throw new Error(
      "OIDC sign-in requires issuer, authorization URL, token URL, JWKS URL, client ID and client secret.",
    );
  }
  const issuer = endpointURL(values.OCC_AUTH_OIDC_ISSUER);
  // `iss` is compared with the configured string, so an explicit port (even `:443`, which the
  // URL parser drops) would never match a token; refuse it here rather than at every callback.
  if (issuer === undefined || /^https:\/\/[^/]*:/i.test(values.OCC_AUTH_OIDC_ISSUER)) {
    throw new Error(
      "OCC_AUTH_OIDC_ISSUER must be an https URL on port 443 with a DNS host name and no query or fragment, written without a port.",
    );
  }
  const endpoints = {} as Record<"authorization" | "token" | "jwks", string>;
  for (const [name, variable] of [
    ["authorization", "OCC_AUTH_OIDC_AUTHORIZATION_URL"],
    ["token", "OCC_AUTH_OIDC_TOKEN_URL"],
    ["jwks", "OCC_AUTH_OIDC_JWKS_URL"],
  ] as const) {
    const url = endpointURL(values[variable]);
    if (url === undefined || url.hostname !== issuer.hostname) {
      throw new Error(
        `${variable} must be an https URL on port 443 on the issuer's host, with no query or fragment.`,
      );
    }
    endpoints[name] = url.href;
  }
  const tokenAuth = environment.OCC_AUTH_OIDC_TOKEN_AUTH?.trim() || "client_secret_post";
  if (tokenAuth !== "client_secret_post" && tokenAuth !== "client_secret_basic") {
    throw new Error("OCC_AUTH_OIDC_TOKEN_AUTH must be client_secret_post or client_secret_basic.");
  }
  const displayName = environment.OCC_AUTH_OIDC_DISPLAY_NAME?.trim() || OIDC_DEFAULT_DISPLAY_NAME;
  if (!displayNamePattern.test(displayName)) {
    throw new Error("OCC_AUTH_OIDC_DISPLAY_NAME must be 1 to 40 printable characters.");
  }
  return {
    // The configured string itself: `iss` must match it exactly, trailing slash included.
    issuer: values.OCC_AUTH_OIDC_ISSUER,
    authorizationUrl: endpoints.authorization,
    // Checked above: HTTPS on 443 on the issuer's DNS host. This is the only place a
    // PinnedEndpoint is constructed.
    tokenUrl: endpoints.token as PinnedEndpoint,
    jwksUrl: endpoints.jwks as PinnedEndpoint,
    clientId: values.OCC_AUTH_OIDC_CLIENT_ID,
    clientSecret: values.OCC_AUTH_OIDC_CLIENT_SECRET,
    tokenAuth,
    displayName,
  };
}

/**
 * The provider instance for an issuer and client: each attached method is then an exact
 * `(iss, sub)` pair for that client. Changing either makes a new instance.
 */
export function oidcProviderId(
  config: Pick<OidcLoginConfiguration, "issuer" | "clientId">,
): string {
  return `oidc:${createHash("sha256").update(`${config.issuer}\0${config.clientId}`).digest("hex")}`;
}

export async function oidcAuthorizationURL(
  config: OidcLoginConfiguration,
  state: string,
  codeVerifier: string,
  redirectURI: string,
  nonce: string,
): Promise<URL> {
  return createAuthorizationURL({
    id: "oidc",
    options: { clientId: config.clientId, clientSecret: config.clientSecret },
    authorizationEndpoint: config.authorizationUrl,
    // Only the subject is used; email and profile are never requested or read.
    scopes: ["openid"],
    state,
    codeVerifier,
    redirectURI,
    nonce,
  });
}

// As for Google, the nonce is derived from the one-use, browser-bound attempt state.
export function oidcNonce(secret: string, state: string): string {
  return createHmac("sha256", secret).update(`oce-oidc-nonce\0${state}`).digest("base64url");
}

export async function exchangeOidcSubject(
  config: OidcLoginConfiguration,
  code: string,
  codeVerifier: string,
  redirectURI: string,
  nonce: string,
  deadlineMs = 10_000,
): Promise<ProviderExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref();
  try {
    const request = await authorizationCodeRequest({
      code,
      codeVerifier,
      redirectURI,
      options: { clientId: config.clientId, clientSecret: config.clientSecret },
      tokenEndpoint: config.tokenUrl,
      authentication: config.tokenAuth === "client_secret_basic" ? "basic" : "post",
    });
    const data = await providerJSON(
      config.tokenUrl,
      { method: "POST", ...request },
      controller.signal,
      "token",
    );
    if ("error" in data || typeof data.id_token !== "string" || !data.id_token) {
      throw rejected();
    }
    // Fetched for every callback, uncached: key rotation needs no restart, and an
    // unreachable JWKS fails sign-in closed.
    const jwks = await providerJSON(config.jwksUrl, {}, controller.signal, "jwks");
    controller.signal.throwIfAborted();
    const claims = verifyIdToken(data.id_token, {
      issuers: new Set([config.issuer]),
      clientId: config.clientId,
      nonce,
      jwks,
      now: Date.now(),
    });
    return claims === undefined
      ? { denial: "EXTERNAL_IDENTITY_REJECTED" }
      : { subject: claims.sub as string };
  } catch (error) {
    // Never expose provider response bodies, token values or request credentials.
    return providerExchangeFailure(error, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
