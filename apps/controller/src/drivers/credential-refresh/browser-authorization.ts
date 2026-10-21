import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  CredentialBrowserAuthorizationCallback,
  CredentialBrowserAuthorizationRequest,
  CredentialSourceBrowserAuthorization,
} from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

/** Parameters the flow sets itself; a connection template cannot replace them. */
const RESERVED_PARAMETERS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

interface BrowserAuthorizationState {
  readonly version: 1;
  readonly sourceId: string;
  readonly clientRegistrationId: string;
  readonly clientId: string;
  readonly tokenUrl: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly verifier: string;
  /** Fixed per session, so replaying a completed step applies nothing new. */
  readonly configureRequestId: string;
  readonly rotateRequestId: string;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Builds the S256 PKCE consent URL; the verifier and `state` stay in `privateState`. */
export function startBrowserAuthorization(
  sourceId: string,
  request: CredentialBrowserAuthorizationRequest,
): CredentialSourceBrowserAuthorization {
  const state = randomToken();
  const verifier = randomToken();
  const scope = request.scopes.join(" ");
  const url = new URL(request.authorizationUrl);
  for (const [key, value] of Object.entries(request.authorizationParameters)) {
    if (RESERVED_PARAMETERS.has(key)) {
      throw new BrowserAuthorizationError("reserved_authorization_parameter", "fix_configuration");
    }
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest().toString("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  const privateState: BrowserAuthorizationState = {
    version: 1,
    sourceId,
    clientRegistrationId: request.clientRegistrationId,
    clientId: request.clientId,
    tokenUrl: request.tokenUrl,
    redirectUri: request.redirectUri,
    scope,
    state,
    verifier,
    configureRequestId: randomUUID(),
    rotateRequestId: randomUUID(),
  };
  return { authorizationUrl: url.toString(), state, privateState: JSON.stringify(privateState) };
}

/** Parses the stored state and proves the callback's `state` matches it. */
export function browserAuthorizationState(
  sourceId: string,
  privateState: string,
  callback: CredentialBrowserAuthorizationCallback,
): BrowserAuthorizationState {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(privateState));
  } catch {
    parsed = undefined;
  }
  const fields = [
    "sourceId",
    "clientRegistrationId",
    "clientId",
    "tokenUrl",
    "redirectUri",
    "scope",
    "state",
    "verifier",
    "configureRequestId",
    "rotateRequestId",
  ] as const;
  if (
    parsed?.version !== 1 ||
    !fields.every((field) => isNonEmptyString(parsed[field])) ||
    parsed.sourceId !== sourceId
  ) {
    throw new BrowserAuthorizationError("invalid_session", "retry");
  }
  const expected = Buffer.from(parsed.state as string);
  const received = Buffer.from(callback.state);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new BrowserAuthorizationError("state_mismatch", "retry");
  }
  return parsed as unknown as BrowserAuthorizationState;
}

/**
 * Exchanges the code once, without following redirects. Any outcome after the request is sent
 * is uncertain to the issuer, so a failure here is never retried with the same code.
 */
export async function exchangeAuthorizationCode(
  state: BrowserAuthorizationState,
  code: string,
  clientSecret: string,
  signal: AbortSignal,
): Promise<{ readonly refreshToken: string }> {
  if (!isNonEmptyString(code)) {
    throw new BrowserAuthorizationError("missing_code", "retry");
  }
  let response: Response;
  try {
    response = await fetch(state.tokenUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: state.redirectUri,
        client_id: state.clientId,
        client_secret: clientSecret,
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
    });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(await response.json());
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    // RFC 6749 §5.2: a refused grant or client is a definite outcome; carry only its code.
    const error = typeof body?.error === "string" ? body.error : undefined;
    if (error === "invalid_grant" || error === "access_denied") {
      throw new BrowserAuthorizationError("grant_refused", "retry");
    }
    if (error === "invalid_client" || error === "unauthorized_client") {
      throw new BrowserAuthorizationError("client_refused", "fix_configuration");
    }
    throw new BrowserAuthorizationError(
      response.status >= 500 ? "issuer_unavailable" : "exchange_refused",
      response.status >= 500 ? "retry" : "fix_configuration",
    );
  }
  if (!isNonEmptyString(body?.refresh_token)) {
    // Google returns no refresh token without offline access and fresh consent.
    throw new BrowserAuthorizationError("no_refresh_token", "fix_configuration");
  }
  return { refreshToken: body.refresh_token };
}
