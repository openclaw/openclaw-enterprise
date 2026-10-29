import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { aborted } from "node:util";
import {
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  resourceUrlFromServerUrl,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  mcpCredentialEndpoint,
  mcpHttpsEndpoint,
} from "@openclaw-enterprise/occ";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

type ResolveHost = (host: string) => Promise<LookupAddress[]>;

const discoveryUnavailable = () =>
  new DependencyUnavailableError("OCC could not reach the MCP OAuth discovery endpoint.");

export async function discoverMcpAuthorization(
  serverUrl: string,
  signal?: AbortSignal,
  {
    fetchMetadata,
    resolveHost = (host) => lookup(host, { all: true }),
  }: {
    fetchMetadata?: FetchLike;
    resolveHost?: ResolveHost;
  } = {},
) {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (deadline.aborted) throw discoveryUnavailable();

  const approved = new Map<string, LookupAddress[]>();
  async function pinEndpoint(value: string | URL) {
    const url = mcpHttpsEndpoint(value);
    if (!approved.has(url.hostname)) {
      const addresses = await resolveHost(url.hostname).catch(() => {
        throw discoveryUnavailable();
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
  // discovery, even if the authoritative DNS server changes its answer between requests.
  const dispatcher = new Agent({
    allowH2: false,
    maxResponseSize: 256 * 1024,
    connect: {
      lookup(host, options, callback) {
        const addresses = approved.get(host);
        const first = addresses?.[0];
        if (!addresses || !first) return callback(new Error("Unapproved MCP discovery host."), "");
        if (options.all) return callback(null, addresses);
        callback(null, first.address, first.family);
      },
    },
  });
  const readMetadata = async (value: string | URL, options?: RequestInit, headersOnly = false) => {
    const url = await pinEndpoint(value);
    const headers = new Headers(options?.headers);
    headers.set("Accept-Encoding", "identity");
    const request = {
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
      throw discoveryUnavailable();
    });
    const encoding = response.headers.get("content-encoding");
    if (
      (encoding && encoding !== "identity") ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw new BrowserAuthorizationError("unsupported_mcp_metadata_response", "fix_configuration");
    }
    if (headersOnly || !response.ok) await response.body?.cancel();
    if (response.status >= 500) throw discoveryUnavailable();
    const body =
      headersOnly || !response.ok || !response.body ? null : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };

  async function discover() {
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
    await pinEndpoint(issuer);
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: readMetadata });
    if (
      !metadata?.authorization_endpoint ||
      !metadata.token_endpoint ||
      metadata.issuer !== issuer ||
      !metadata.response_types_supported.includes("code") ||
      (metadata.code_challenge_methods_supported &&
        !metadata.code_challenge_methods_supported.includes("S256"))
    ) {
      throw new BrowserAuthorizationError("invalid_mcp_metadata", "fix_configuration");
    }
    const { authorization_endpoint: authorizationUrl, token_endpoint: tokenUrl } = metadata;
    await pinEndpoint(authorizationUrl);
    await pinEndpoint(tokenUrl);
    return {
      serverUrl: server.href,
      resource: resource.resource,
      issuer: metadata.issuer,
      authorizationUrl,
      tokenUrl,
      scopes: [...new Set(scope?.split(/\s+/u).filter(Boolean) ?? resource.scopes_supported ?? [])],
    };
  }
  try {
    // System DNS lookup itself has no AbortSignal. Bound the entire operation including DNS.
    return await Promise.race([
      discover(),
      aborted(deadline, approved).then((): never => {
        throw deadline.reason;
      }),
    ]);
  } catch (error) {
    if (deadline.aborted) throw discoveryUnavailable();
    if (error instanceof BrowserAuthorizationError || error instanceof DependencyUnavailableError)
      throw error;
    // SDK, JSON and URL parser errors can include untrusted document values.
    throw new BrowserAuthorizationError("invalid_mcp_metadata", "fix_configuration");
  } finally {
    await dispatcher.destroy();
  }
}
