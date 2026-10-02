import type {
  HarnessDeviceAuthorization,
  HarnessDeviceAuthorizationResult,
} from "@openclaw-enterprise/contracts";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_AUTH_DURATION_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider response.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new Error("Invalid provider response.");
  }
  return value;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Provider request failed.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("Invalid provider response.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("Invalid provider response.");
      }
      chunks.push(chunk.value);
    }
    return record(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function post(
  path: string,
  body: Record<string, string> | URLSearchParams,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(10_000);
  const form = body instanceof URLSearchParams;
  return fetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: form ? body.toString() : JSON.stringify(body),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    redirect: "error",
  });
}

/** Begin the supported Codex device flow without exposing provider authorization state. */
export async function startHarnessDeviceAuthorization(
  harnessId: string,
  signal?: AbortSignal,
): Promise<HarnessDeviceAuthorization> {
  if (harnessId !== "codex") {
    throw new Error("Device authorization is not supported for this Harness.");
  }
  try {
    const startedAt = Date.now();
    const response = await readResponse(
      await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID }, signal),
    );
    const deviceAuthId = text(response.device_auth_id);
    const userCode = text(response.user_code ?? response.usercode);
    const interval = text(response.interval);
    if (!/^\d+$/.test(interval)) {
      throw new Error("Invalid provider polling interval.");
    }
    const intervalSeconds = Number(interval);
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("Invalid provider polling interval.");
    }
    const providerExpiry =
      response.expires_at === undefined
        ? startedAt + DEVICE_AUTH_DURATION_MS
        : Date.parse(text(response.expires_at));
    const expiresAtMs = Math.min(providerExpiry, startedAt + DEVICE_AUTH_DURATION_MS);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("Invalid provider authorization expiry.");
    }
    const expiresAt = new Date(expiresAtMs).toISOString();
    return {
      verificationUrl: `${ISSUER}/codex/device`,
      userCode,
      expiresAt,
      intervalSeconds,
      privateState: JSON.stringify({
        version: 1,
        provider: "codex",
        state: "pending",
        deviceAuthId,
        userCode,
        expiresAt,
      }),
    };
  } catch {
    throw new Error("Could not start device authorization. Start sign-in again.");
  }
}

/** Poll once; OCC owns scheduling, exact session authority, and credential custody. */
export async function pollHarnessDeviceAuthorization(
  privateState: string,
  signal?: AbortSignal,
): Promise<HarnessDeviceAuthorizationResult> {
  try {
    const state = record(JSON.parse(privateState));
    if (state.version !== 1 || state.provider !== "codex" || state.state !== "pending") {
      throw new Error("Invalid device authorization state.");
    }
    const expiresAt = Date.parse(text(state.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("Device authorization expired.");
    }
    const response = await post(
      "/api/accounts/deviceauth/token",
      { device_auth_id: text(state.deviceAuthId), user_code: text(state.userCode) },
      signal,
    );
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return { status: "pending" };
    }
    const authorization = await readResponse(response);
    // A token POST can consume its one-time code even when the response is lost. Never retry it.
    const tokens = await readResponse(
      await post(
        "/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          code: text(authorization.authorization_code),
          code_verifier: text(authorization.code_verifier),
        }),
        signal,
      ),
    );
    const idToken = text(tokens.id_token);
    const segments = idToken.split(".");
    if (segments.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(segments[1]!)) {
      throw new Error("Invalid provider identity token.");
    }
    // Preserve the native identity token; this extracts display/routing metadata, not authority.
    const claims = record(JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")));
    const authClaims =
      claims["https://api.openai.com/auth"] === undefined
        ? undefined
        : record(claims["https://api.openai.com/auth"]);
    const accountId = authClaims?.chatgpt_account_id;
    return {
      status: "ready",
      credential: JSON.stringify({
        version: 1,
        provider: "codex",
        state: "ready",
        auth: {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: idToken,
            access_token: text(tokens.access_token),
            refresh_token: text(tokens.refresh_token),
            account_id: accountId === undefined ? null : text(accountId),
          },
          last_refresh: new Date().toISOString(),
        },
      }),
    };
  } catch {
    // Provider bodies, transport failures, and parser errors may contain authorization material.
    throw new Error("Could not complete device authorization. Start sign-in again.");
  }
}
