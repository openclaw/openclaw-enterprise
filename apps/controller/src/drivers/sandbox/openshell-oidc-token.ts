import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
}

const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
// Refresh this long before expiry, never more than half the token's lifetime.
const REFRESH_MARGIN_MS = 30_000;

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
    return this.refreshing;
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
      const encoded = `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(secret)}`;
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
      throw new OpenShellGatewayFailure(
        `OpenShell OIDC token request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new OpenShellGatewayFailure(
        `OpenShell OIDC token endpoint returned ${response.status}${detail}.`,
      );
    }
    const payload: unknown = await response.json().catch(() => undefined);
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
    return { accessToken, refreshAfterMs: Date.now() + lifetimeMs - margin };
  }
}

async function errorDetail(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) {
      return ` (${error})`;
    }
  }
  return "";
}
