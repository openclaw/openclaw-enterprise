import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { aborted, isDeepStrictEqual } from "node:util";
import {
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  registerClient,
  resourceUrlFromServerUrl,
  type FetchLike,
} from "@modelcontextprotocol/client";
import type { McpAuthorizationMetadata } from "@openclaw-enterprise/contracts";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  mcpCredentialEndpoint,
  mcpHttpsEndpoint,
} from "@openclaw-enterprise/occ";
import { isOAuthEndpointUrl } from "@openclaw-enterprise/utils";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

type ResolveHost = (host: string) => Promise<LookupAddress[]>;

type McpRequest = (
  url: string | URL,
  options?: RequestInit,
  headersOnly?: boolean,
) => Promise<Response>;
interface McpTransport {
  fetch: McpRequest;
  pinEndpoint: (value: string | URL) => Promise<URL>;
}
interface TransportOptions {
  fetchMetadata?: FetchLike;
  resolveHost?: ResolveHost;
}

const registrationGrantTypes = ["authorization_code", "refresh_token"];

function supportsRegistrationGrants(supported?: readonly string[]): boolean {
  return (
    supported === undefined || registrationGrantTypes.every((type) => supported.includes(type))
  );
}

// Match the template's persisted OAuth URL formats before offering issuer-side registration.
function isTemplateOAuthUrl(value: string, allowQuery = false): boolean {
  return (
    value.length <= 2048 &&
    /^https:\/\/[^/?#@\s]+(?:\/[^#\s]*)?$/u.test(value) &&
    (allowQuery || !value.includes("?"))
  );
}

const mcpUnavailable = () =>
  new DependencyUnavailableError("OCC could not reach the MCP OAuth endpoint.");

async function withMcpTransport<T>(
  operation: (transport: McpTransport) => Promise<T>,
  invalidResponseCode: string,
  signal?: AbortSignal,
  { fetchMetadata, resolveHost = (host) => lookup(host, { all: true }) }: TransportOptions = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (deadline.aborted) {
    throw mcpUnavailable();
  }

  const approved = new Map<string, LookupAddress[]>();
  async function pinEndpoint(value: string | URL) {
    const url = mcpHttpsEndpoint(value);
    if (!approved.has(url.hostname)) {
      const addresses = await resolveHost(url.hostname).catch(() => {
        throw mcpUnavailable();
      });
      deadline.throwIfAborted();
      if (
        !addresses.length ||
        addresses.some(({ address }) => {
          const ip = ipaddr.parse(address);
          return (
            ip.range() !== "unicast" ||
            (ip.kind() === "ipv6" && !ip.match(ipaddr.parse("2000::"), 3))
          );
        })
      ) {
        throw new BrowserAuthorizationError("mcp_endpoint_not_public", "fix_configuration");
      }
      approved.set(url.hostname, addresses);
    }
    return url;
  }

  // TLS still verifies the requested hostname. Connect only to the IPs checked for this
  // operation, even if the authoritative DNS server changes its answer between requests.
  const dispatcher = new Agent({
    allowH2: false,
    maxResponseSize: 256 * 1024,
    connect: {
      lookup(host, options, callback) {
        const addresses = approved.get(host);
        const first = addresses?.[0];
        if (!addresses || !first) {
          return callback(new Error("Unapproved MCP OAuth host."), "");
        }
        if (options.all) {
          return callback(null, addresses);
        }
        callback(null, first.address, first.family);
      },
    },
  });
  const fetch: McpRequest = async (value, options, headersOnly = false) => {
    const url = await pinEndpoint(value);
    const headers = new Headers(options?.headers);
    headers.set("Accept-Encoding", "identity");
    const request = {
      method: options?.method ?? "GET",
      ...(typeof options?.body === "string" ? { body: options.body } : {}),
      headers,
      dispatcher,
      signal: deadline,
      redirect: "manual" as const,
      credentials: "omit" as const,
    };
    const response = await (
      fetchMetadata
        ? fetchMetadata(url, request)
        : undiciFetch(url, { ...request, headers: Object.fromEntries(headers) })
    ).catch(() => {
      throw mcpUnavailable();
    });
    const encoding = response.headers.get("content-encoding");
    if (
      (encoding && encoding !== "identity") ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw new BrowserAuthorizationError("unsupported_mcp_metadata_response", "fix_configuration");
    }
    if (headersOnly || !response.ok) {
      await response.body?.cancel();
    }
    if (response.status >= 500) {
      throw mcpUnavailable();
    }
    const body =
      headersOnly || !response.ok || !response.body ? null : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };

  try {
    // System DNS lookup itself has no AbortSignal. Bound the entire operation including DNS.
    return await Promise.race([
      operation({ fetch, pinEndpoint }),
      aborted(deadline, approved).then((): never => {
        throw deadline.reason;
      }),
    ]);
  } catch (error) {
    if (deadline.aborted) {
      throw mcpUnavailable();
    }
    if (error instanceof BrowserAuthorizationError || error instanceof DependencyUnavailableError) {
      throw error;
    }
    // SDK, JSON and URL parser errors can include untrusted document values.
    throw new BrowserAuthorizationError(invalidResponseCode, "fix_configuration");
  } finally {
    await dispatcher.destroy();
  }
}

export async function discoverMcpAuthorization(
  serverUrl: string,
  signal?: AbortSignal,
  options?: TransportOptions,
): Promise<McpAuthorizationMetadata> {
  async function discover({ fetch: readMetadata, pinEndpoint }: McpTransport) {
    const server = new URL(serverUrl);
    mcpCredentialEndpoint(server);
    const initial = await readMetadata(
      server,
      { headers: { Accept: "application/json, text/event-stream" } },
      true,
    );
    const { resourceMetadataUrl, scope } =
      initial.status === 401 ? extractWWWAuthenticateParams(initial) : {};
    const resource = await discoverOAuthProtectedResourceMetadata(
      server,
      resourceMetadataUrl ? { resourceMetadataUrl } : {},
      readMetadata,
    );
    if (
      !checkResourceAllowed({
        requestedResource: resourceUrlFromServerUrl(server),
        configuredResource: mcpHttpsEndpoint(resource.resource),
      })
    ) {
      throw new BrowserAuthorizationError("mcp_resource_mismatch", "fix_configuration");
    }
    const issuers = resource.authorization_servers ?? [];
    if (issuers.length !== 1 || !issuers[0]) {
      throw new BrowserAuthorizationError("mcp_requires_one_issuer", "fix_configuration");
    }
    const issuer = issuers[0];
    if (!isTemplateOAuthUrl(issuer)) {
      throw new BrowserAuthorizationError("invalid_mcp_metadata", "fix_configuration");
    }
    await pinEndpoint(issuer);
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: readMetadata });
    if (
      !metadata?.authorization_endpoint ||
      !metadata.token_endpoint ||
      metadata.issuer !== issuer ||
      !isTemplateOAuthUrl(metadata.authorization_endpoint, true) ||
      metadata.token_endpoint.length > 2048 ||
      !isOAuthEndpointUrl(metadata.token_endpoint) ||
      !metadata.response_types_supported.includes("code") ||
      (metadata.code_challenge_methods_supported &&
        !metadata.code_challenge_methods_supported.includes("S256"))
    ) {
      throw new BrowserAuthorizationError("invalid_mcp_metadata", "fix_configuration");
    }
    const { authorization_endpoint: authorizationUrl, token_endpoint: tokenUrl } = metadata;
    await pinEndpoint(authorizationUrl);
    await pinEndpoint(tokenUrl);
    const registrationUrl =
      metadata.token_endpoint_auth_methods_supported?.includes("client_secret_post") &&
      supportsRegistrationGrants(metadata.grant_types_supported)
        ? metadata.registration_endpoint
        : undefined;
    const revocationUrl =
      "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
    if (registrationUrl) {
      await pinEndpoint(registrationUrl);
    }
    if (revocationUrl) {
      await pinEndpoint(revocationUrl);
    }
    return {
      ...(registrationUrl ? { registrationUrl } : {}),
      ...(revocationUrl ? { revocationUrl } : {}),
      serverUrl: server.href,
      resource: resource.resource,
      issuer: metadata.issuer,
      authorizationUrl,
      tokenUrl,
      scopes: [...new Set(scope?.split(/\s+/u).filter(Boolean) ?? resource.scopes_supported ?? [])],
    };
  }
  return withMcpTransport(discover, "invalid_mcp_metadata", signal, options);
}

/** Register only after the administrator approved the freshly verified issuer and endpoint. */
export async function registerMcpOAuthClient(
  metadata: McpAuthorizationMetadata,
  redirectUri: string,
  scopes: readonly string[],
  signal?: AbortSignal,
  options?: TransportOptions,
): Promise<{ clientId: string; clientSecret: string }> {
  const registrationUrl = metadata.registrationUrl;
  if (!registrationUrl) {
    throw new BrowserAuthorizationError("mcp_registration_unavailable", "fix_configuration");
  }
  return withMcpTransport(
    async ({ fetch }) => {
      const result = await registerClient(metadata.issuer, {
        metadata: {
          issuer: metadata.issuer,
          authorization_endpoint: metadata.authorizationUrl,
          token_endpoint: metadata.tokenUrl,
          response_types_supported: ["code"],
          registration_endpoint: registrationUrl,
        },
        clientMetadata: {
          client_name: "OpenClaw Enterprise",
          redirect_uris: [redirectUri],
          response_types: ["code"],
          grant_types: registrationGrantTypes,
          token_endpoint_auth_method: "client_secret_post",
        },
        scope: scopes.join(" "),
        fetchFn: fetch,
      });
      if (
        !/^[!-~]{1,256}$/u.test(result.client_id) ||
        !result.client_secret?.trim() ||
        result.client_secret.length > 4096 ||
        (result.scope !== undefined &&
          !isDeepStrictEqual(new Set(result.scope.split(" ")), new Set(scopes))) ||
        result.token_endpoint_auth_method !== "client_secret_post" ||
        (result.response_types && !result.response_types.includes("code")) ||
        !supportsRegistrationGrants(result.grant_types) ||
        (result.client_secret_expires_at && result.client_secret_expires_at <= Date.now() / 1000) ||
        result.redirect_uris.length !== 1 ||
        result.redirect_uris[0] !== redirectUri
      ) {
        throw new BrowserAuthorizationError("invalid_mcp_registration", "fix_configuration");
      }
      return { clientId: result.client_id, clientSecret: result.client_secret };
    },
    "invalid_mcp_registration",
    signal,
    options,
  );
}
