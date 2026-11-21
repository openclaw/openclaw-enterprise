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
  ConnectionTemplateValidationError,
  type McpAuthorizationMetadata,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { isIP } from "node:net";
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

function mcpHttpsEndpoint(value: string | URL): URL {
  const url = new URL(value);
  // The management path supports DNS names. A literal IP would bypass the socket lookup hook.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("#") ||
    url.port === "0" ||
    url.hostname.includes("*") ||
    !url.hostname.includes(".") ||
    isIP(url.hostname) ||
    url.hostname.startsWith("[")
  ) {
    throw new ConnectionTemplateValidationError(
      "serverUrl",
      "Use a public HTTPS MCP endpoint without credentials or a fragment.",
    );
  }
  return url;
}

/** The MCP transport URL determines where a worker may present a credential. */
function mcpCredentialEndpoint(serverUrl: string | URL) {
  const server = mcpHttpsEndpoint(serverUrl);
  // OpenShell represents the path as a glob without a query. It must match literally.
  if (server.href.includes("?") || !/^\/[A-Za-z0-9/._~-]{0,255}$/u.test(server.pathname)) {
    throw new ConnectionTemplateValidationError(
      "serverUrl",
      "Use an exact MCP server path without wildcards or a query.",
    );
  }
  return { host: server.hostname, port: Number(server.port || 443), path: server.pathname };
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
        throw new ConnectionTemplateValidationError(
          "serverUrl",
          "The MCP endpoint must resolve only to public addresses.",
        );
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
      throw new ConnectionTemplateValidationError(
        "serverUrl",
        "The MCP server returned an unsupported metadata response.",
      );
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
    if (
      error instanceof ConnectionTemplateValidationError ||
      error instanceof DependencyUnavailableError
    ) {
      throw error;
    }
    // SDK, JSON and URL parser errors can include untrusted document values.
    throw new ConnectionTemplateValidationError("serverUrl", invalidResponseCode);
  } finally {
    await dispatcher.destroy();
  }
}

export async function discoverMcpAuthorization(
  serverUrl: string,
  selectedIssuer?: string,
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
      throw new ConnectionTemplateValidationError(
        "serverUrl",
        "The advertised resource does not protect this MCP URL.",
      );
    }
    const issuers = [...new Set(resource.authorization_servers ?? [])];
    if (!issuers.length || issuers.length > 32 || issuers.some((url) => !isTemplateOAuthUrl(url))) {
      throw new ConnectionTemplateValidationError(
        "issuer",
        "The resource must advertise valid HTTPS authorization servers.",
      );
    }
    const observed = {
      serverUrl: server.href,
      resource: resource.resource,
      issuers,
      requestedScopes: [...new Set(scope?.split(/\s+/u).filter(Boolean) ?? [])],
      ...(resource.scopes_supported && { resourceScopes: resource.scopes_supported }),
    };
    if (selectedIssuer === undefined && issuers.length > 1) {
      return observed;
    }
    const issuer = selectedIssuer ?? issuers[0]!;
    if (!issuers.includes(issuer)) {
      throw new ConnectionTemplateValidationError(
        "issuer",
        "Choose an issuer advertised by this protected resource.",
      );
    }
    await pinEndpoint(issuer);
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: readMetadata });
    if (
      !metadata?.authorization_endpoint ||
      !metadata.token_endpoint ||
      metadata.issuer !== issuer ||
      !isTemplateOAuthUrl(metadata.authorization_endpoint, true) ||
      metadata.token_endpoint.length > 2048 ||
      !isTemplateOAuthUrl(metadata.token_endpoint, true) ||
      !metadata.response_types_supported.includes("code") ||
      (metadata.code_challenge_methods_supported &&
        !metadata.code_challenge_methods_supported.includes("S256"))
    ) {
      throw new ConnectionTemplateValidationError(
        "issuer",
        "The selected issuer returned invalid OAuth metadata.",
      );
    }
    const { authorization_endpoint: authorizationUrl, token_endpoint: tokenUrl } = metadata;
    await pinEndpoint(authorizationUrl);
    await pinEndpoint(tokenUrl);
    const registrationUrl = metadata.registration_endpoint;
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
      ...observed,
      issuer: metadata.issuer,
      authorizationUrl,
      tokenUrl,
      ...(metadata.scopes_supported && { supportedScopes: metadata.scopes_supported }),
      ...(metadata.token_endpoint_auth_methods_supported && {
        tokenEndpointAuthMethods: metadata.token_endpoint_auth_methods_supported,
      }),
    };
  }
  return withMcpTransport(discover, "The MCP metadata is invalid.", signal, options);
}
