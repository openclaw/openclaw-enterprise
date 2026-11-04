import { isFlowOwnedOAuthParameter } from "@openclaw-enterprise/contracts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  CredentialBrowserAuthorizationCallback,
  CredentialBrowserAuthorizationRequest,
  CredentialSourceBrowserAuthorization,
  OAuthConnectionGrant,
} from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { requestOAuthTokens } from "./oauth-token-endpoint.ts";

/** Parameters the flow sets itself; a connection template cannot replace them. */

interface BrowserAuthorizationState {
  readonly version: 1;
  readonly sourceId: string;
  readonly state: string;
  readonly verifier: string;
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
    if (isFlowOwnedOAuthParameter(key)) {
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
    state,
    verifier,
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
  if (
    parsed?.version !== 1 ||
    !isNonEmptyString(parsed.state) ||
    !isNonEmptyString(parsed.verifier) ||
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
  request: CredentialBrowserAuthorizationRequest,
  verifier: string,
  code: string,
  clientSecret: string,
  signal: AbortSignal,
): Promise<OAuthConnectionGrant> {
  if (!isNonEmptyString(code)) {
    throw new BrowserAuthorizationError("missing_code", "retry");
  }
  const tokens = await requestOAuthTokens(
    request.tokenUrl,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
    request.scopes.join(" "),
    signal,
  );
  if (!tokens.refreshToken) {
    throw new BrowserAuthorizationError("no_refresh_token", "fix_configuration");
  }
  return {
    issuer: request.issuer,
    tokenUrl: request.tokenUrl,
    clientRegistrationId: request.clientRegistrationId,
    clientId: request.clientId,
    clientSecret,
    scope: tokens.scope,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}
