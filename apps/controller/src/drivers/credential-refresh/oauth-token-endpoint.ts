import type { OAuthConnectionGrant } from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";

const OAUTH_EXCHANGE_TIMEOUT_MS = 15_000;

async function readResponse(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 64 * 1024) {
        await reader.cancel();
        throw new Error("OAuth token response exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return asRecord(JSON.parse(Buffer.concat(chunks, length).toString("utf8")));
  } catch {
    return undefined;
  }
}

/** The caller pins the endpoint, client and requested scope before sending any credential. */
export async function requestOAuthTokens(
  tokenUrl: string,
  parameters: URLSearchParams,
  requestedScope: string,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  const response = await fetch(tokenUrl, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: parameters,
    signal: AbortSignal.any([signal, AbortSignal.timeout(OAUTH_EXCHANGE_TIMEOUT_MS)]),
  });
  if (response.status >= 500 || response.status === 429) {
    await response.body?.cancel();
    // A proxy failure does not establish whether the issuer consumed the one-use grant.
    throw new Error("The outcome of the OAuth token exchange is unknown.");
  }
  const body = await readResponse(response);
  if (!response.ok) {
    // Never include the issuer's text, credential bytes or endpoint in errors or audit.
    if (body?.error === "invalid_grant" || body?.error === "access_denied") {
      throw new BrowserAuthorizationError("grant_refused", "retry");
    }
    if (body?.error === "invalid_client" || body?.error === "unauthorized_client") {
      throw new BrowserAuthorizationError("client_refused", "fix_configuration");
    }
    throw new BrowserAuthorizationError("exchange_refused", "fix_configuration");
  }
  if (
    !isNonEmptyString(body?.access_token) ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) ||
    typeof body.token_type !== "string" ||
    body.token_type.toLowerCase() !== "bearer" ||
    !isPositiveSafeInteger(body.expires_in)
  ) {
    throw new BrowserAuthorizationError("invalid_access_token", "fix_configuration");
  }
  const expiresAt = new Date(startedAt + body.expires_in * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new BrowserAuthorizationError("invalid_token_expiry", "fix_configuration");
  }
  const refreshToken = body.refresh_token;
  if (refreshToken !== undefined && !isNonEmptyString(refreshToken)) {
    throw new BrowserAuthorizationError("invalid_refresh_token", "fix_configuration");
  }
  // RFC 6749 sections 5.1 and 6: omission means the requested scope; a refresh may narrow it.
  const scope = body.scope === undefined ? requestedScope : body.scope;
  const requested = new Set(requestedScope.split(" "));
  if (
    !isNonEmptyString(scope) ||
    scope.split(" ").some((token) => !token || !requested.has(token))
  ) {
    throw new BrowserAuthorizationError("grant_scope_mismatch", "fix_configuration");
  }
  return {
    accessToken: body.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    scope,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Refresh one previously approved grant at the endpoint and scope pinned during consent. */
export function refreshPinnedOAuthGrant(
  grant: Pick<
    OAuthConnectionGrant,
    "tokenUrl" | "refreshToken" | "clientId" | "clientSecret" | "scope"
  >,
  signal: AbortSignal,
) {
  return requestOAuthTokens(
    grant.tokenUrl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: grant.clientId,
      client_secret: grant.clientSecret,
      scope: grant.scope,
    }),
    grant.scope,
    signal,
  );
}
