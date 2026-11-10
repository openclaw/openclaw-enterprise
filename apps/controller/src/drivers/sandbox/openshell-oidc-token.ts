import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as tls from "node:tls";
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
  /**
   * Optional PEM bundle added to the token request's TLS trust, beside the system
   * roots: the Backend's rootCertificatePath file, which for a private-CA gateway
   * also carries the issuer's CA.
   */
  readonly caPath?: string;
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
  private caBundle: Promise<readonly string[]> | undefined;
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
    if (options.caPath !== undefined && !isAbsolute(options.caPath)) {
      throw new OpenShellGatewayFailure("OpenShell OIDC token CA path must be absolute.");
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
    let response: TokenHttpResponse;
    try {
      response = await postTokenRequest(
        this.options.tokenUrl,
        headers,
        body,
        this.requestTimeoutMs,
        await this.trustedCertificates(),
      );
    } catch (error) {
      // A network error or timeout clears without a configuration change; the
      // underlying code (for example ECONNREFUSED or a certificate failure) is
      // the part an operator can act on, because fetch reports only "fetch failed".
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const cause =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
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
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      throw new OpenShellGatewayFailure(
        `OpenShell OIDC token endpoint redirected${location === undefined ? "" : ` to ${location}`}; redirects are not followed.`,
      );
    }
    if (!(response.status >= 200 && response.status < 300)) {
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
    const bodyText = await response.text();
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

  /** The selected CA bundle to add beside the compiled-in roots; empty keeps system trust. */
  private trustedCertificates(): Promise<readonly string[]> {
    this.caBundle ??= (async () => {
      if (this.options.caPath === undefined) {
        return [];
      }
      const bundle = await readFile(this.options.caPath, "utf8");
      if (bundle.trim().length === 0) {
        throw new OpenShellGatewayFailure("OpenShell OIDC token CA bundle is empty.");
      }
      return [bundle];
    })();
    return this.caBundle;
  }
}

/** One token-endpoint response: a status, headers, and a size-bounded body read. */
interface TokenHttpResponse {
  readonly status: number;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly text: () => Promise<string>;
}

async function postTokenRequest(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams,
  timeoutMs: number,
  certificateAuthorities: readonly string[],
): Promise<TokenHttpResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  // Providing ca replaces the roots, so the compiled-in list always stays beside
  // the selected bundle; public-CA issuers keep verifying either way.
  const authority =
    certificateAuthorities.length === 0
      ? {}
      : { ca: [...certificateAuthorities, ...tls.rootCertificates] };
  return new Promise<TokenHttpResponse>((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(body.toString().length) },
        timeout: timeoutMs,
        ...authority,
      },
      (message) => {
        resolve({
          status: message.statusCode ?? 0,
          headers: message.headers,
          text: () =>
            readBounded(message as import("node:stream").Readable & NodeJS.ReadableStream),
        });
      },
    );
    request.on("timeout", () => {
      const error = new Error("OpenShell OIDC token request timed out.");
      error.name = "TimeoutError";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end(body.toString());
  });
}

/** Reads one response body, bounded before it can exhaust memory. */
function readBounded(
  message: import("node:stream").Readable & NodeJS.ReadableStream,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    message.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_TOKEN_RESPONSE_BYTES) {
        reject(new OpenShellGatewayFailure("OpenShell OIDC token endpoint response is too large."));
        message.destroy();
        return;
      }
      chunks.push(chunk);
    });
    message.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    message.on("error", reject);
  });
}

function headerValue(headers: NodeJS.Dict<string | string[]>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Strict application/x-www-form-urlencoded encoding: encodeURIComponent leaves
// !'()* unescaped, while the form ruleset a token endpoint applies escapes them.
function formUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function errorDetail(response: TokenHttpResponse): Promise<string> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
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
