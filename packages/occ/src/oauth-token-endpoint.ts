import {
  isOAuthScopeToken,
  type OAuthConnectionGrant,
  type OAuthConnectionRegistration,
} from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "./errors.ts";
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
  scopeLimit: readonly string[] | undefined,
  client: Pick<OAuthConnectionRegistration, "clientId" | "tokenEndpointAuthMethod" | "resource">,
  clientSecret: string | undefined,
  signal: AbortSignal,
) {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });
  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!clientSecret) {
      throw new BrowserAuthorizationError("client_refused", "fix_configuration");
    }
    // RFC 6749 section 2.3.1 encodes both components before constructing the Basic value.
    const encode = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);
    headers.set(
      "authorization",
      "Basic " +
        Buffer.from(encode(client.clientId) + ":" + encode(clientSecret)).toString("base64"),
    );
  } else {
    parameters.set("client_id", client.clientId);
    if (client.tokenEndpointAuthMethod === "client_secret_post") {
      if (!clientSecret) {
        throw new BrowserAuthorizationError("client_refused", "fix_configuration");
      }
      parameters.set("client_secret", clientSecret);
    }
  }
  if (client.resource !== undefined) {
    parameters.set("resource", client.resource);
  }
  const startedAt = Date.now();
  const response = await fetch(tokenUrl, {
    method: "POST",
    redirect: "error",
    headers,
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
  // Only the first exchange with no explicit scopes can accept issuer-chosen defaults.
  // On refresh, even an empty list is a ceiling: no reported scopes can gain authority.
  let grantedScopes = scopeLimit ?? [];
  if (body.scope !== undefined) {
    const reported = typeof body.scope === "string" ? body.scope.split(" ") : [];
    const allowed = scopeLimit && new Set(scopeLimit);
    if (
      !reported.length ||
      reported.some((scope) => !isOAuthScopeToken(scope) || (allowed && !allowed.has(scope)))
    ) {
      throw new BrowserAuthorizationError("grant_scope_mismatch", "fix_configuration");
    }
    grantedScopes = [...new Set(reported)];
  }
  return {
    accessToken: body.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    grantedScopes,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Refresh one previously approved grant at the endpoint and scope pinned during consent. */
export function refreshPinnedOAuthGrant(
  grant: Pick<
    OAuthConnectionGrant & OAuthConnectionRegistration,
    | "tokenUrl"
    | "refreshToken"
    | "clientId"
    | "tokenEndpointAuthMethod"
    | "resource"
    | "grantedScopes"
  >,
  signal: AbortSignal,
  clientSecret: string | undefined,
) {
  return requestOAuthTokens(
    grant.tokenUrl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      ...(grant.grantedScopes.length ? { scope: grant.grantedScopes.join(" ") } : {}),
    }),
    grant.grantedScopes,
    grant,
    clientSecret,
    signal,
  );
}
