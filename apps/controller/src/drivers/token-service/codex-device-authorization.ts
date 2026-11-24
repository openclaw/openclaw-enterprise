import type {
  CredentialSourceDeviceAuthorization,
  OAuthConnectionGrant,
  OAuthBuiltinCodexSourceConsent,
} from "@openclaw-enterprise/contracts";
import { BUILTIN_CODEX_OAUTH_PRESET } from "../../backends/token-service/codex-oauth-preset.ts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  BrowserAuthorizationError,
  DeviceAuthorizationStartError,
  parseOAuthGrantedScopes,
  readOAuthTokenResponse,
} from "@openclaw-enterprise/occ";

type AccountMetadata = OAuthBuiltinCodexSourceConsent["account"];

interface DeviceTokens extends OAuthConnectionGrant {
  readonly account: AccountMetadata;
}

function required(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error("Codex OAuth returned incomplete credentials or account metadata.");
  }
  return value;
}

function claims(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const value = asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
      if (value) {
        return value;
      }
    }
  } catch {
    // Provider responses must never become error messages or log fields.
  }
  throw new Error("Codex OAuth returned an invalid token payload.");
}

function accessTokenGrant(token: Record<string, unknown>) {
  if (
    token.token_type !== undefined &&
    (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer")
  ) {
    throw new Error("Codex OAuth returned an unsupported token type.");
  }
  const accessToken = required(token.access_token);
  const accessClaims = claims(accessToken);
  const expiry = new Date(Number(accessClaims.exp) * 1000);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new Error("Codex OAuth returned an expired access token or no expiry.");
  }
  return { accessToken, accessClaims, expiresAt: expiry.toISOString() };
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`Codex OAuth request failed with status ${response.status}.`);
  }
  try {
    const record = asRecord(await response.json());
    if (record) {
      return record;
    }
  } catch {
    // JSON parser diagnostics may contain provider response fragments.
  }
  throw new Error("Codex OAuth returned an invalid response.");
}

// A connection code or timeout means the issuer could not answer. A refused
// redirect reached it; retain no messages, addresses, provider text, or causes.
function unreachable(error: unknown): DeviceAuthorizationStartError {
  if (error instanceof Error && error.name === "AbortError") {
    return new DeviceAuthorizationStartError("unavailable", "AbortError");
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new DeviceAuthorizationStartError("unreachable", "TimeoutError");
  }
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string"
    ? new DeviceAuthorizationStartError("unreachable", cause.code)
    : new DeviceAuthorizationStartError("unavailable", "fetch_failed");
}

export async function startCodexDeviceAuthorization(
  signal: AbortSignal,
): Promise<CredentialSourceDeviceAuthorization> {
  let reply: Response;
  try {
    reply = await fetch(`${BUILTIN_CODEX_OAUTH_PRESET.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: BUILTIN_CODEX_OAUTH_PRESET.clientId }),
      signal,
    });
  } catch (error) {
    throw unreachable(error);
  }
  if (!reply.ok) {
    await reply.body?.cancel().catch(() => {});
    throw new DeviceAuthorizationStartError("unavailable", `HTTP_${reply.status}`);
  }
  try {
    const response = await responseRecord(reply);
    const deviceAuthId = required(response.device_auth_id);
    const userCode = required(response.user_code);
    const interval = Number(response.interval ?? 5);
    return {
      verificationUrl: `${BUILTIN_CODEX_OAUTH_PRESET.issuer}/codex/device`,
      userCode,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      intervalSeconds: Number.isFinite(interval) ? Math.max(1, interval) : 5,
      privateState: JSON.stringify({
        deviceAuthId,
        userCode,
      }),
    };
  } catch {
    throw new DeviceAuthorizationStartError("unavailable", "invalid_response");
  }
}

export function codexDeviceAuthorizationState(privateState: string) {
  let state: Record<string, unknown> | undefined;
  try {
    state = asRecord(JSON.parse(privateState));
  } catch {
    throw new Error("Codex device authorization state is invalid.");
  }
  return {
    deviceAuthId: required(state?.deviceAuthId),
    userCode: required(state?.userCode),
  };
}

export async function pollCodexDeviceAuthorization(
  state: ReturnType<typeof codexDeviceAuthorizationState>,
  signal: AbortSignal,
): Promise<DeviceTokens | undefined> {
  const body = JSON.stringify({
    device_auth_id: required(state.deviceAuthId),
    user_code: required(state.userCode),
  });
  let response: Response;
  try {
    response = await fetch(`${BUILTIN_CODEX_OAUTH_PRESET.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof TypeError)) {
      throw error;
    }
    // Fetch failed before acquiring a code. OCC retains the handle and schedules the next poll.
    return undefined;
  }
  signal.throwIfAborted();
  if (
    response.status === 403 ||
    response.status === 404 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    return undefined;
  }
  const authorization = await responseRecord(response);
  // From code acquisition onward, errors remain uncertain: never retry a consumed grant.
  const token = await responseRecord(
    await fetch(BUILTIN_CODEX_OAUTH_PRESET.tokenUrl, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: BUILTIN_CODEX_OAUTH_PRESET.clientId,
        code: required(authorization.authorization_code),
        code_verifier: required(authorization.code_verifier),
        redirect_uri: `${BUILTIN_CODEX_OAUTH_PRESET.issuer}/deviceauth/callback`,
      }),
      signal,
    }),
  );
  const { accessToken, accessClaims, expiresAt } = accessTokenGrant(token);
  const identityClaims = claims(required(token.id_token));
  const identity = asRecord(identityClaims["https://api.openai.com/auth"]) ?? {};
  const access = asRecord(accessClaims["https://api.openai.com/auth"]) ?? {};
  const accountId = required(identity.chatgpt_account_id ?? access.chatgpt_account_id);
  const planType = required(identity.chatgpt_plan_type ?? access.chatgpt_plan_type);
  const userId =
    identity.chatgpt_user_id ?? identity.user_id ?? access.chatgpt_user_id ?? access.user_id;
  const email =
    identityClaims.email ?? asRecord(identityClaims["https://api.openai.com/profile"])?.email;
  const accountUserId =
    access.chatgpt_account_id === accountId ? access.chatgpt_account_user_id : undefined;
  return {
    accessToken,
    expiresAt,
    refreshToken: required(token.refresh_token),
    requestedScopes: [],
    grantedScopes: parseOAuthGrantedScopes(token.scope, undefined),
    account: {
      accountId,
      planType,
      ...(isNonEmptyString(userId) ? { userId } : {}),
      ...(isNonEmptyString(email) ? { email } : {}),
      ...(isNonEmptyString(accountUserId) ? { accountUserId } : {}),
      isFedramp:
        identity.chatgpt_account_is_fedramp === true || access.chatgpt_account_is_fedramp === true,
    },
  };
}

/** Renew only the server-owned Codex grant; OAuth Templates continue to use their pinned client. */
export async function refreshCodexOAuthGrant(
  grant: Pick<OAuthConnectionGrant, "refreshToken" | "grantedScopes">,
  signal: AbortSignal,
) {
  const response = await fetch(BUILTIN_CODEX_OAUTH_PRESET.tokenUrl, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: BUILTIN_CODEX_OAUTH_PRESET.clientId,
      refresh_token: grant.refreshToken,
    }),
    signal,
  });
  if (response.status >= 500 || response.status === 429) {
    await response.body?.cancel();
    throw new Error("The outcome of the Codex token exchange is unknown.");
  }
  const token = await readOAuthTokenResponse(response);
  if (!response.ok) {
    const error = typeof token?.error === "string" ? token.error : asRecord(token?.error)?.code;
    const code = typeof error === "string" ? error.toLowerCase() : undefined;
    if (
      response.status === 401 ||
      code === "invalid_grant" ||
      code === "access_denied" ||
      code === "refresh_token_expired" ||
      code === "refresh_token_reused" ||
      code === "refresh_token_invalidated"
    ) {
      throw new BrowserAuthorizationError("grant_refused", "retry");
    }
    if (code === "invalid_client" || code === "unauthorized_client") {
      throw new BrowserAuthorizationError("client_refused", "fix_configuration");
    }
    throw new BrowserAuthorizationError("exchange_refused", "fix_configuration");
  }
  const refreshToken = token?.refresh_token;
  if (refreshToken !== undefined && !isNonEmptyString(refreshToken)) {
    throw new BrowserAuthorizationError("invalid_refresh_token", "fix_configuration");
  }
  const grantedScopes = parseOAuthGrantedScopes(token?.scope, grant.grantedScopes);
  if (token?.access_token === undefined) {
    if (refreshToken === undefined && !isNonEmptyString(token?.id_token)) {
      throw new BrowserAuthorizationError("invalid_access_token", "fix_configuration");
    }
    return { refreshToken: refreshToken ?? grant.refreshToken, grantedScopes };
  }
  let access;
  try {
    access = accessTokenGrant(token);
  } catch {
    throw new BrowserAuthorizationError("invalid_access_token", "fix_configuration");
  }
  return {
    accessToken: access.accessToken,
    expiresAt: access.expiresAt,
    grantedScopes,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}
