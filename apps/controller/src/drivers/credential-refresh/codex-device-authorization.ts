import type {
  CredentialSourceDeviceAuthorization,
  ExternalChatgptAuth,
} from "@openclaw-enterprise/contracts";
import { randomUUID } from "node:crypto";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export const CODEX_OAUTH_TYPE = "codex-oauth";
export const CODEX_PROFILE_ID = "oce-codex-oauth";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_ACCESS_TOKEN_ENV = "CODEX_ACCESS_TOKEN";
// Login-time metadata is separate from rotating credentials. The PoC does not
// update this snapshot on refresh; account/plan changes require reconnecting.
export const CODEX_ACCOUNT_CONFIG = "oce.codex.account";

type AccountMetadata = Omit<ExternalChatgptAuth, "accessTokenPlaceholder"> & {
  readonly accountUserId?: string;
};

interface DeviceTokens {
  readonly refreshToken: string;
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

export async function startCodexDeviceAuthorization(
  sourceId: string,
  signal: AbortSignal,
): Promise<CredentialSourceDeviceAuthorization> {
  const response = await responseRecord(
    await fetch("https://auth.openai.com/api/accounts/deviceauth/usercode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      signal,
    }),
  );
  const deviceAuthId = required(response.device_auth_id);
  const userCode = required(response.user_code);
  const interval = Number(response.interval ?? 5);
  return {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    intervalSeconds: Number.isFinite(interval) ? Math.max(1, interval) : 5,
    privateState: JSON.stringify({
      sourceId,
      deviceAuthId,
      userCode,
      configureRequestId: randomUUID(),
      rotateRequestId: randomUUID(),
    }),
  };
}

export function codexDeviceAuthorizationState(sourceId: string, privateState: string) {
  const state = asRecord(JSON.parse(privateState));
  if (state?.sourceId !== sourceId) {
    throw new Error("Codex device authorization belongs to another credential source.");
  }
  return {
    deviceAuthId: required(state.deviceAuthId),
    userCode: required(state.userCode),
    configureRequestId: required(state.configureRequestId),
    rotateRequestId: required(state.rotateRequestId),
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
    response = await fetch("https://auth.openai.com/api/accounts/deviceauth/token", {
      method: "POST",
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
    await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CLIENT_ID,
        code: required(authorization.authorization_code),
        code_verifier: required(authorization.code_verifier),
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      }),
      signal,
    }),
  );
  const accessToken = required(token.access_token);
  const accessClaims = claims(accessToken);
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
  const expiry = Number(accessClaims.exp) * 1000;
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("Codex OAuth returned an expired access token or no expiry.");
  }
  return {
    refreshToken: required(token.refresh_token),
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

export function codexAccountMetadata(config: Readonly<Record<string, string>>): AccountMetadata {
  const value = asRecord(JSON.parse(required(config[CODEX_ACCOUNT_CONFIG])));
  if (!value || !isNonEmptyString(value.accountId) || !isNonEmptyString(value.planType)) {
    throw new Error("OpenShell has no completed Codex OAuth account metadata.");
  }
  return value as unknown as AccountMetadata;
}
