import { APIError } from "better-auth";

// Bounded HTTP transport shared by the GitHub, Google and OIDC sign-in providers.

export function rejected(): APIError {
  return APIError.fromStatus("UNAUTHORIZED", { message: "Authentication was not accepted." });
}

const providerResponseLimit = 64 * 1024;

// The provider step a failure happened at. `authorization` is the provider's own error
// redirect to the callback; `profile` is GitHub's user lookup.
export type ProviderStep = "authorization" | "token" | "jwks" | "profile";

/**
 * Why a provider gave no well-formed answer, from a fixed vocabulary. It is logged for
 * operators, so it never carries provider bodies, URLs, codes, tokens or user data.
 */
export type ProviderFailureCause =
  | "connect_refused"
  | "dns"
  | "timeout"
  | "tls"
  | "connection_reset"
  | "network"
  | "redirect"
  | "http_status"
  | "oversized_response"
  | "malformed_response"
  | "provider_error"
  | "client_rejected";

/** The bounded, loggable detail of a provider outage. */
export interface ProviderFailure {
  readonly step?: ProviderStep;
  readonly cause: ProviderFailureCause;
  /** The provider's HTTP status, for `http_status`. */
  readonly status?: number;
  /** The transport's error code (for example `ECONNREFUSED`), when it has one. */
  readonly code?: string;
}

// The provider gave no well-formed answer (transport failure, deadline, redirect,
// 429 or 5xx status, an oversized or malformed body) or refused this Installation's OAuth
// client. Audited apart from rejection.
export class ProviderUnavailableError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure = { cause: "network" }) {
    super("The sign-in provider is unavailable.");
    this.failure = failure;
  }
}

export type ProviderDenial = "EXTERNAL_IDENTITY_REJECTED" | "PROVIDER_UNAVAILABLE";

// A code exchange yields the provider subject or the audited reason it did not. An
// unavailable provider also says why, for the operator log.
export type ProviderExchange =
  | { readonly subject: string }
  | { readonly denial: "EXTERNAL_IDENTITY_REJECTED" }
  | { readonly denial: "PROVIDER_UNAVAILABLE"; readonly failure?: ProviderFailure };

export function providerExchangeFailure(error: unknown, signal: AbortSignal): ProviderExchange {
  if (error instanceof ProviderUnavailableError) {
    return { denial: "PROVIDER_UNAVAILABLE", failure: error.failure };
  }
  if (signal.aborted) {
    return { denial: "PROVIDER_UNAVAILABLE", failure: { cause: "timeout" } };
  }
  return { denial: "EXTERNAL_IDENTITY_REJECTED" };
}

const transportCode = /^[A-Z][A-Z0-9_]{1,63}$/;
const refusedCodes = new Set(["ECONNREFUSED"]);
const dnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const timeoutCodes = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const resetCodes = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const tlsCodes = new Set([
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Classifies a fetch failure by error name and code only; messages can carry URLs.
function transportFailure(error: unknown, step: ProviderStep): ProviderFailure {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < 4;) {
    chain.push(current);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  for (const entry of chain) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") {
      return { step, cause: "timeout" };
    }
    const raw = (entry as { code?: unknown }).code;
    const code = typeof raw === "string" && transportCode.test(raw) ? raw : undefined;
    if (code === undefined) {
      continue;
    }
    const cause: ProviderFailureCause = refusedCodes.has(code)
      ? "connect_refused"
      : dnsCodes.has(code)
        ? "dns"
        : timeoutCodes.has(code)
          ? "timeout"
          : resetCodes.has(code)
            ? "connection_reset"
            : tlsCodes.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")
              ? "tls"
              : "network";
    return { step, cause, code };
  }
  // Undici reports a refused redirect (redirect: "error") without a code.
  const last = chain.at(-1);
  if (last instanceof Error && last.message === "unexpected redirect") {
    return { step, cause: "redirect" };
  }
  return { step, cause: "network" };
}

// Every fixed provider endpoint the controller may call. Nothing else is fetchable.
export type ProviderEndpoint =
  | "https://github.com/login/oauth/access_token"
  | "https://api.github.com/user"
  | "https://oauth2.googleapis.com/token"
  | "https://www.googleapis.com/oauth2/v3/certs";

declare const pinnedEndpoint: unique symbol;
/**
 * An operator-configured OIDC endpoint that passed the startup checks in oidc.ts (HTTPS on
 * 443, the issuer's DNS host, no userinfo, query or fragment). Only that parser constructs
 * one; request input never chooses what the controller fetches.
 */
export type PinnedEndpoint = string & { readonly [pinnedEndpoint]: true };

// A provider's fixed requests share a deadline, including streaming body reads.
// A well-formed 4xx answer is a rejection unless it refuses this client; every other failure
// is unavailability.
export async function providerJSON(
  endpoint: ProviderEndpoint | PinnedEndpoint,
  init: RequestInit,
  signal: AbortSignal,
  step: ProviderStep,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(endpoint, { ...init, signal, redirect: "error" });
  } catch (error) {
    throw new ProviderUnavailableError(transportFailure(error, step));
  }
  try {
    return await readProviderJSON(response, signal, step);
  } catch (error) {
    if (error instanceof APIError || error instanceof ProviderUnavailableError) {
      throw error;
    }
    throw new ProviderUnavailableError(
      error instanceof SyntaxError
        ? { step, cause: "malformed_response" }
        : transportFailure(error, step),
    );
  }
}

// Token errors that refuse this Installation's OAuth client rather than the person: RFC 6749
// section 5.2's invalid_client, unauthorized_client and unsupported_grant_type (the controller
// always sends authorization_code), and GitHub's own codes for a wrong client secret or callback
// registration (GitHub answers them with HTTP 200). Every sign-in fails until the operator fixes
// the client configuration, so they are logged, not rejected.
const refusedClientErrors = new Set([
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
]);

function refusesClient(step: ProviderStep, data: Record<string, unknown>): boolean {
  return step === "token" && typeof data.error === "string" && refusedClientErrors.has(data.error);
}

async function readProviderJSON(
  response: Response,
  signal: AbortSignal,
  step: ProviderStep,
): Promise<Record<string, unknown>> {
  if (response.ok && response.body) {
    const data = await readBoundedJSON(response, response.body, signal, step);
    if (refusesClient(step, data)) {
      throw new ProviderUnavailableError({ step, cause: "client_rejected" });
    }
    return data;
  }
  if (step === "token" && (response.status === 400 || response.status === 401) && response.body) {
    // A token error body is read only to tell a refused client from a refused code.
    let data: Record<string, unknown>;
    try {
      data = await readBoundedJSON(response, response.body, signal, step);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw rejected();
    }
    throw refusesClient(step, data)
      ? new ProviderUnavailableError({ step, cause: "client_rejected" })
      : rejected();
  }
  await response.body?.cancel();
  throw response.status === 429 || response.status >= 500 || response.ok
    ? new ProviderUnavailableError(
        response.ok
          ? { step, cause: "malformed_response" }
          : { step, cause: "http_status", status: response.status },
      )
    : rejected();
}

async function readBoundedJSON(
  response: Response,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  step: ProviderStep,
): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  try {
    if (Number(response.headers.get("content-length")) > providerResponseLimit) {
      await reader.cancel();
      throw new ProviderUnavailableError({ step, cause: "oversized_response" });
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > providerResponseLimit) {
        await reader.cancel();
        throw new ProviderUnavailableError({ step, cause: "oversized_response" });
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ProviderUnavailableError({ step, cause: "malformed_response" });
    }
    return data as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}
