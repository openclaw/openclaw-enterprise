import { buildDiscoveryUrls } from "@modelcontextprotocol/client";
import {
  ConnectionTemplateValidationError,
  type McpAuthorizationMetadata,
  type OAuthClientAuthMethod,
} from "@openclaw-enterprise/contracts";
import {
  withOAuthTransport,
  type OAuthTransport,
  type OAuthTransportMode,
  type OAuthTransportOptions,
} from "./mcp-discovery.ts";

export interface OAuthIssuerEndpoint {
  readonly mode: "manual" | "mcp_discovery";
  readonly issuer: string;
  readonly tokenUrl: string;
}

function transportMode(mode: OAuthIssuerEndpoint["mode"]): OAuthTransportMode {
  if (mode === "mcp_discovery") {
    return "mcp";
  }
  if (mode === "manual") {
    return "manual";
  }
  return invalidIssuer();
}

export interface OAuthTemplateIssuer extends OAuthIssuerEndpoint {
  readonly authorizationUrl: string;
  readonly revocationUrl?: string;
  readonly mcp?: { readonly serverUrl: string; readonly resource: string };
  readonly observed?: McpAuthorizationMetadata;
}

export interface OAuthIssuerVerification {
  readonly tokenEndpointAuthMethods: readonly OAuthClientAuthMethod[];
}

const supportedMethods = new Set<OAuthClientAuthMethod>([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

function invalidIssuer(): never {
  throw new ConnectionTemplateValidationError(
    "issuer",
    "The issuer returned invalid OAuth metadata.",
  );
}

function normalizeTokenEndpointAuthMethods(value: unknown): readonly OAuthClientAuthMethod[] {
  const advertised = value ?? ["client_secret_basic"];
  if (!Array.isArray(advertised) || !advertised.every((method) => typeof method === "string")) {
    return invalidIssuer();
  }
  return [...new Set(advertised)].filter((method): method is OAuthClientAuthMethod =>
    supportedMethods.has(method as OAuthClientAuthMethod),
  );
}

function metadataIncludes(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    value.includes(expected)
  );
}

async function issuerMetadata(input: OAuthIssuerEndpoint, transport: OAuthTransport) {
  const issuer = await transport.pinEndpoint(input.issuer);
  if (issuer.search || issuer.hash || input.issuer.length > 2048) {
    invalidIssuer();
  }
  let metadata: Record<string, unknown> | undefined;
  for (const { url } of buildDiscoveryUrls(input.issuer)) {
    const response = await transport.fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      continue;
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      invalidIssuer();
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalidIssuer();
    }
    metadata = value as Record<string, unknown>;
    break;
  }
  if (
    !metadata ||
    metadata.issuer !== input.issuer ||
    metadata.token_endpoint !== input.tokenUrl ||
    input.tokenUrl.length > 2048
  ) {
    invalidIssuer();
  }
  await transport.pinEndpoint(input.tokenUrl);
  const tokenEndpointAuthMethods = normalizeTokenEndpointAuthMethods(
    metadata.token_endpoint_auth_methods_supported,
  );
  return { metadata, tokenEndpointAuthMethods };
}

/** Call only after installation administration has authorized the proposed Template. */
export async function verifyOAuthTemplateIssuer(
  input: OAuthTemplateIssuer,
  signal?: AbortSignal,
  options?: OAuthTransportOptions,
): Promise<OAuthIssuerVerification> {
  if (input.mode === "mcp_discovery") {
    // The Template owner obtains this observation from production MCP discovery, not API input.
    signal?.throwIfAborted();
    const { observed, mcp } = input;
    if (
      !observed ||
      !mcp ||
      observed.serverUrl !== mcp.serverUrl ||
      observed.resource !== mcp.resource ||
      !observed.issuers.includes(input.issuer) ||
      observed.issuer !== input.issuer ||
      observed.authorizationUrl !== input.authorizationUrl ||
      observed.tokenUrl !== input.tokenUrl ||
      observed.revocationUrl !== input.revocationUrl
    ) {
      invalidIssuer();
    }
    return {
      tokenEndpointAuthMethods: normalizeTokenEndpointAuthMethods(
        observed.tokenEndpointAuthMethods,
      ),
    };
  }
  return withOAuthTransport(
    transportMode(input.mode),
    "metadata",
    async (transport) => {
      const { metadata, tokenEndpointAuthMethods } = await issuerMetadata(input, transport);
      if (
        !metadataIncludes(metadata.response_types_supported, "code") ||
        (metadata.grant_types_supported !== undefined &&
          !metadataIncludes(metadata.grant_types_supported, "authorization_code")) ||
        (metadata.code_challenge_methods_supported !== undefined &&
          !metadataIncludes(metadata.code_challenge_methods_supported, "S256")) ||
        metadata.authorization_endpoint !== input.authorizationUrl ||
        input.authorizationUrl.length > 2048
      ) {
        invalidIssuer();
      }
      await transport.pinEndpoint(input.authorizationUrl);
      if (input.revocationUrl !== undefined) {
        if (
          metadata.revocation_endpoint !== input.revocationUrl ||
          input.revocationUrl.length > 2048
        ) {
          invalidIssuer();
        }
        await transport.pinEndpoint(input.revocationUrl);
      }
      return { tokenEndpointAuthMethods };
    },
    "The issuer returned invalid OAuth metadata.",
    signal,
    options,
  );
}

/** Revalidate the saved version before resolving confidential material or sending a grant. */
export function revalidateOAuthTokenEndpoint(
  input: OAuthIssuerEndpoint & { readonly tokenEndpointAuthMethod?: OAuthClientAuthMethod },
  signal?: AbortSignal,
  options?: OAuthTransportOptions,
): Promise<void> {
  return withOAuthTransport(
    transportMode(input.mode),
    "metadata",
    async (transport) => {
      const { tokenEndpointAuthMethods } = await issuerMetadata(input, transport);
      if (
        input.tokenEndpointAuthMethod !== undefined &&
        !tokenEndpointAuthMethods.includes(input.tokenEndpointAuthMethod)
      ) {
        invalidIssuer();
      }
    },
    "The issuer returned invalid OAuth metadata.",
    signal,
    options,
  );
}

/** The caller supplies the exact token URL and mode from the verified immutable Template. */
export function fetchOAuthTokenEndpoint(
  endpoint: Pick<OAuthIssuerEndpoint, "mode" | "tokenUrl">,
  init: RequestInit,
  options?: OAuthTransportOptions,
): Promise<Response> {
  if (
    init.method?.toUpperCase() !== "POST" ||
    !(typeof init.body === "string" || init.body instanceof URLSearchParams)
  ) {
    throw new Error("Invalid OAuth token request.");
  }
  return withOAuthTransport(
    transportMode(endpoint.mode),
    "token",
    ({ fetch }) => fetch(endpoint.tokenUrl, init),
    "The OAuth token endpoint returned an invalid response.",
    init.signal ?? undefined,
    options,
  );
}

export const oauthIssuerOperations = {
  verifyTemplate: verifyOAuthTemplateIssuer,
  revalidate: revalidateOAuthTokenEndpoint,
  fetchToken: fetchOAuthTokenEndpoint,
};
