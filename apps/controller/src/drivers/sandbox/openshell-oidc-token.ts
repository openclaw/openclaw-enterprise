import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TransientDependencyError } from "@openclaw-enterprise/occ";
import { OpenShellGatewayFailure } from "./openshell-gateway-errors.ts";

/**
 * OIDC client-credentials grant for one OpenShell Backend connection. The client secret is
 * re-read from its file on every refresh so rotation applies without a restart, matching the
 * bearerTokenFile behavior. Concurrent callers share one in-flight refresh.
 */
export interface OpenShellOidcClientCredentialsOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecretPath: string;
  readonly tokenAuth?: "client_secret_post" | "client_secret_basic";
  /** The gateway resource server's expected audience, not the client ID. */
  readonly audience?: string;
  readonly scope?: string;
  readonly requestTimeoutMs?: number;
}

interface CachedToken {
  readonly accessToken: string;
  /** Unix epoch milliseconds after which the token must be refreshed. */
  readonly refreshAfterMs: number;
  /** Unix epoch milliseconds after which the token is no longer valid. */
  readonly expiresAtMs: number;
}

const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
// Refresh this long before expiry, never more than half the token's lifetime.
const REFRESH_MARGIN_MS = 30_000;
// A token endpoint response larger than this is not a token response.
const MAX_TOKEN_RESPONSE_BYTES = 1_048_576;

export class OpenShellOidcTokenSource {
  private readonly options: OpenShellOidcClientCredentialsOptions;
  private readonly requestTimeoutMs: number;
  private cached: CachedToken | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(options: OpenShellOidcClientCredentialsOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
    if (!isAbsolute(options.clientSecretPath)) {
      throw new OpenShellGatewayFailure("OpenShell OIDC client secret path must be absolute.");
    }
    let url: URL;
    try {
      url = new URL(options.tokenUrl);
    } catch {
      throw new OpenShellGatewayFailure("OpenShell OIDC token URL is invalid.");
    }
    // The parser admits https, or cleartext to a numeric loopback address only; the same
    // rule holds here so a directly constructed client cannot weaken it.
    if (
      (url.protocol === "https:" && url.username === "" && url.password === "") ||
      (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]"))
    ) {
      return;
    }
    throw new OpenShellGatewayFailure(
      "OpenShell OIDC token URL must be https, or http to a numeric loopback address.",
    );
  }

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached !== undefined && now < this.cached.refreshAfterMs) {
      return this.cached.accessToken;
    }
    this.refreshing ??= this.fetchToken()
      .then((token) => {
        this.cached = token;
        return token.accessToken;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    try {
      return await this.refreshing;
    } catch (error) {
      // A failed refresh keeps a token that is still valid until its real expiry,
      // so a briefly unreachable issuer does not fail calls that could succeed.
      if (this.cached !== undefined && Date.now() < this.cached.expiresAtMs) {
        return this.cached.accessToken;
      }
      throw error;
    }
  }

  /** Drops the cached token after the gateway refused it, so the next call re-fetches. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<CachedToken> {
    // Re-read on every refresh so secret rotation applies without a process restart.
    const secret = (await readFile(this.options.clientSecretPath, "utf8")).trim();
    if (secret.length === 0) {
      throw new OpenShellGatewayFailure("OpenShell OIDC client secret file is empty.");
    }
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (this.options.tokenAuth === "client_secret_basic") {
      // RFC 6749 2.3.1: form-urlencode both credentials before the base64 pair.
      const encoded = `${formUrlEncode(this.options.clientId)}:${formUrlEncode(secret)}`;
      headers.authorization = `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
      body.set("client_id", this.options.clientId);
    } else {
      body.set("client_id", this.options.clientId);
      body.set("client_secret", secret);
    }
    if (this.options.audience !== undefined) {
      body.set("audience", this.options.audience);
    }
    if (this.options.scope !== undefined) {
      body.set("scope", this.options.scope);
    }
    let response: Response;
    try {
      response = await fetch(this.options.tokenUrl, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      // A network error or timeout clears without a configuration change; the
      // underlying code (for example ECONNREFUSED or a certificate failure) is
      // the part an operator can act on, because fetch reports only "fetch failed".
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const cause =
        typeof error === "object" && error !== null && "cause" in error
          ? (error as { readonly cause?: { readonly code?: unknown } }).cause?.code
          : undefined;
      const detail =
        typeof cause === "string"
          ? ` (${cause})`
          : error instanceof Error
            ? ` (${error.name})`
            : "";
      throw new TransientDependencyError(
        "sandbox_gateway",
        timedOut ? "timeout" : "unreachable",
        `OpenShell OIDC token request failed${detail}.`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      // 5xx clears without a change; a rejected client is a configuration error.
      if (response.status >= 500) {
        throw new TransientDependencyError(
          "sandbox_gateway",
          "unavailable",
          `OpenShell OIDC token endpoint returned ${response.status}${detail}.`,
        );
      }
      if (response.status === 401 || response.status === 400) {
        throw new OpenShellGatewayFailure(
          `OpenShell OIDC token endpoint rejected the client credentials (HTTP ${response.status}${detail}); check the client ID, secret, and issuer configuration.`,
        );
      }
      throw new OpenShellGatewayFailure(
        `OpenShell OIDC token endpoint returned ${response.status}${detail}.`,
      );
    }
    const bodyText = await readBounded(response);
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch {
      payload = undefined;
    }
    const record =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const accessToken = record.access_token;
    const expiresIn = record.expires_in;
    const tokenType = record.token_type;
    if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
      throw new OpenShellGatewayFailure("OpenShell OIDC token endpoint returned no access token.");
    }
    if (
      !Number.isSafeInteger(expiresIn) ||
      (expiresIn as number) <= 0 ||
      (expiresIn as number) > 2_147_483_647
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell OIDC token endpoint returned an invalid expires_in.",
      );
    }
    if (tokenType !== undefined && typeof tokenType !== "string") {
      throw new OpenShellGatewayFailure(
        "OpenShell OIDC token endpoint returned an invalid token_type.",
      );
    }
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new OpenShellGatewayFailure(
        `OpenShell OIDC token endpoint returned unsupported token_type ${tokenType}.`,
      );
    }
    const lifetimeMs = (expiresIn as number) * 1000;
    const margin = Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2);
    const now = Date.now();
    return {
      accessToken,
      refreshAfterMs: now + lifetimeMs - margin,
      expiresAtMs: now + lifetimeMs,
    };
  }
}

// Strict application/x-www-form-urlencoded encoding: encodeURIComponent leaves
// !'()* unescaped, while the form ruleset a token endpoint applies escapes them.
function formUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_TOKEN_RESPONSE_BYTES) {
    throw new OpenShellGatewayFailure("OpenShell OIDC token endpoint response is too large.");
  }
  const text = await response.text();
  if (text.length > MAX_TOKEN_RESPONSE_BYTES) {
    throw new OpenShellGatewayFailure("OpenShell OIDC token endpoint response is too large.");
  }
  return text;
}

async function errorDetail(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBounded(response));
  } catch {
    return "";
  }
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) {
      return ` (${error})`;
    }
  }
  return "";
}
