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

/**
 * The operator-configured claim that vouches for realm members: a verified ID token whose
 * `name` claim equals `value` authenticates an otherwise unknown subject, which is then
 * enrolled just-in-time with no grant. Both parts are required together.
 * `emailClaim` names the claim the same token may carry as the enrolled account's email
 * address (default `email`); without a usable value the enrolment falls back to the
 * deterministic placeholder address.
 */
export interface OidcTrustClaim {
  readonly name: string;
  readonly value: string;
  readonly emailClaim: string;
}

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
  readonly trustClaim?: OidcTrustClaim;
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
const optionalVariables = [
  "OCC_AUTH_OIDC_TOKEN_AUTH",
  "OCC_AUTH_OIDC_DISPLAY_NAME",
  "OCC_AUTH_OIDC_TRUST_CLAIM",
  "OCC_AUTH_OIDC_TRUST_VALUE",
  "OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM",
] as const;

const dnsName =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Printable text: no control, format, separator-other or unassigned characters.
const displayNamePattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u;
// A JWT claim name (letters, digits, `_`, `-`, `:`), and a printable ASCII claim value.
const trustClaimNamePattern = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const trustClaimValuePattern = /^[\x21-\x7E]{1,256}$/;

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
  const trustClaimName = environment.OCC_AUTH_OIDC_TRUST_CLAIM?.trim();
  const trustClaimValue = environment.OCC_AUTH_OIDC_TRUST_VALUE?.trim();
  const trustEmailClaimName = environment.OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM?.trim();
  if (
    (trustClaimName === undefined || trustClaimName.length === 0) !==
    (trustClaimValue === undefined || trustClaimValue.length === 0)
  ) {
    throw new Error(
      "OCC_AUTH_OIDC_TRUST_CLAIM and OCC_AUTH_OIDC_TRUST_VALUE must be configured together.",
    );
  }
  const trustConfigured = trustClaimName !== undefined && trustClaimName.length > 0;
  if (!trustConfigured && trustEmailClaimName !== undefined && trustEmailClaimName.length > 0) {
    throw new Error(
      "OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM requires OCC_AUTH_OIDC_TRUST_CLAIM and OCC_AUTH_OIDC_TRUST_VALUE.",
    );
  }
  let trustClaim: OidcTrustClaim | undefined;
  if (trustClaimName !== undefined && trustClaimName.length > 0 && trustClaimValue !== undefined) {
    if (!trustClaimNamePattern.test(trustClaimName)) {
      throw new Error(
        "OCC_AUTH_OIDC_TRUST_CLAIM must be a claim name of 1 to 64 letters, digits, underscore, hyphen or colon.",
      );
    }
    if (!trustClaimValuePattern.test(trustClaimValue)) {
      throw new Error("OCC_AUTH_OIDC_TRUST_VALUE must be 1 to 256 printable characters.");
    }
    if (trustEmailClaimName !== undefined && !trustClaimNamePattern.test(trustEmailClaimName)) {
      throw new Error(
        "OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM must be a claim name of 1 to 64 letters, digits, underscore, hyphen or colon.",
      );
    }
    trustClaim = {
      name: trustClaimName,
      value: trustClaimValue,
      emailClaim:
        trustEmailClaimName === undefined || trustEmailClaimName.length === 0
          ? "email"
          : trustEmailClaimName,
    };
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
    ...(trustClaim === undefined ? {} : { trustClaim }),
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
    // The subject and, when configured, the trust claim are used; email and profile are
    // never requested or read. The trust claim must therefore be issued into the ID token
    // without any additional scope.
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

// The email a trusted token carries for the identity it enrolls, when the configured email
// claim holds a usable address: normalized to the `occ."user"` email invariant
// (lower-cased, trimmed, 3 to 320 characters, one `@` with non-empty sides) because the
// enrolment inserts it directly. Any other value falls back to the caller's deterministic
// placeholder address. `email_verified` is honored only when the token asserts exactly
// true; the claim name for it is always the standard one, whatever the email claim is.
function trustedEmail(
  claims: Readonly<Record<string, unknown>>,
  emailClaim: string,
): { email?: string; emailVerified?: true } {
  const value = claims[emailClaim];
  if (typeof value !== "string") {
    return {};
  }
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return {};
  }
  return claims.email_verified === true ? { email, emailVerified: true } : { email };
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
      : config.trustClaim !== undefined &&
          claims[config.trustClaim.name] === config.trustClaim.value
        ? {
            subject: claims.sub as string,
            trusted: true,
            ...trustedEmail(claims, config.trustClaim.emailClaim),
          }
        : { subject: claims.sub as string };
  } catch (error) {
    // Never expose provider response bodies, token values or request credentials.
    return providerExchangeFailure(error, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
