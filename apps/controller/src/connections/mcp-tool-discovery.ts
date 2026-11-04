import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { aborted } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { PluginDiscoveryError } from "@openclaw-enterprise/occ";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

interface DiscoveryTransport {
  readonly resolveHost?: (host: string) => Promise<LookupAddress[]>;
  readonly fetch?: FetchLike;
}

/** Reads tool names at the reviewed endpoint selected by the Plugin Driver. */
export async function listManagedMcpToolNames(
  endpoint: string,
  accessToken: string,
  signal?: AbortSignal,
  { resolveHost = (host) => lookup(host, { all: true }), fetch }: DiscoveryTransport = {},
): Promise<ReadonlySet<string>> {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-z0-9._~+/-]+=*$/iu.test(accessToken)
  ) {
    throw new PluginDiscoveryError("invalid_response");
  }
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const client = new Client(
    { name: "OpenClaw Enterprise", version: "1.0.0" },
    { listMaxPages: 16 },
  );
  let dispatcher: Agent | undefined;

  async function discover() {
    const addresses = await resolveHost(url.hostname);
    deadline.throwIfAborted();
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => {
        const ip = ipaddr.parse(address);
        return (
          ip.range() !== "unicast" || (ip.kind() === "ipv6" && !ip.match(ipaddr.parse("2000::"), 3))
        );
      })
    ) {
      throw new PluginDiscoveryError("unavailable");
    }

    // Pin DNS for this operation. TLS still verifies the reviewed hostname.
    const pinned = new Agent({
      maxResponseSize: 256 * 1024,
      connect: {
        lookup(host, options, callback) {
          const first = addresses[0];
          if (host !== url.hostname || !first) {
            return callback(new Error("Unapproved MCP discovery host."), "");
          }
          if (options.all) {
            return callback(null, addresses);
          }
          callback(null, first.address, first.family);
        },
      },
    });
    dispatcher = pinned;
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (target, init) => {
        // The SDK owns the MCP session. Every outbound request still goes to the same resource.
        if (String(target) !== url.href) {
          throw new PluginDiscoveryError("invalid_response");
        }
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${accessToken}`);
        headers.set("Accept-Encoding", "identity");
        const request = {
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          headers: Object.fromEntries(headers),
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
          dispatcher: pinned,
          redirect: "error" as const,
          credentials: "omit" as const,
        };
        const response = await (fetch ? fetch(url, request) : undiciFetch(url, request)).catch(
          () => {
            throw new PluginDiscoveryError("unavailable");
          },
        );
        const encoding = response.headers.get("content-encoding");
        if (
          (encoding && encoding !== "identity") ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel();
          throw new PluginDiscoveryError("invalid_response");
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          await response.body?.cancel();
          throw new PluginDiscoveryError(
            response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "unavailable"
                : "credentials_rejected",
          );
        }
        return response as Response;
      },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools(undefined, { signal: deadline });
      return new Set(tools.map(({ name }) => name));
    } finally {
      if (transport.sessionId && !deadline.aborted) {
        await transport.terminateSession().catch(() => {});
      }
    }
  }

  try {
    deadline.throwIfAborted();
    // Bound DNS as well as the HTTP session, including when the caller disconnects.
    return await Promise.race([
      discover(),
      aborted(deadline, client).then(() => {
        deadline.throwIfAborted();
        throw new PluginDiscoveryError("unavailable");
      }),
    ]);
  } catch (error) {
    if (error instanceof PluginDiscoveryError) {
      throw error;
    }
    throw new PluginDiscoveryError(deadline.aborted ? "unavailable" : "invalid_response");
  } finally {
    await client.close();
    await dispatcher?.destroy();
  }
}
