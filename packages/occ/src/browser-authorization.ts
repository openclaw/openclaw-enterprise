import { createHash, randomBytes } from "node:crypto";
import {
  isFlowOwnedOAuthParameter,
  type OAuthConnectionGrant,
  type OAuthConnectionRegistration,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { BrowserAuthorizationError } from "./errors.ts";
import { requestOAuthTokens } from "./oauth-token-endpoint.ts";

interface BrowserAuthorizationRequest extends OAuthConnectionRegistration {
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly redirectUri: string;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** OCC stores the verifier and the state hash with the signed-in user's session. */
export function startBrowserAuthorization(request: BrowserAuthorizationRequest) {
  const state = randomToken();
  const verifier = randomToken();
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
  if (request.scopes.length) {
    url.searchParams.set("scope", request.scopes.join(" "));
  }
  if (request.resource !== undefined) {
    url.searchParams.set("resource", request.resource);
  }
  url.searchParams.set("state", state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest().toString("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.toString(), state, pkceVerifier: verifier };
}

/**
 * Exchanges the code once, without following redirects. Any outcome after the request is sent
 * is uncertain to the issuer, so a failure here is never retried with the same code.
 */
export async function exchangeAuthorizationCode(
  request: BrowserAuthorizationRequest,
  verifier: string,
  code: string,
  clientSecret: string | undefined,
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
      code_verifier: verifier,
    }),
    request.scopes.length ? request.scopes : undefined,
    request,
    clientSecret,
    signal,
  );
  if (!tokens.refreshToken) {
    throw new BrowserAuthorizationError("no_refresh_token", "fix_configuration");
  }
  return {
    requestedScopes: request.scopes,
    grantedScopes: tokens.grantedScopes,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}
