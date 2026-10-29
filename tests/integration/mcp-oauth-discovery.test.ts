import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  mcpCredentialEndpoint,
} from "../../packages/occ/src/index.ts";
import { discoverMcpAuthorization } from "../../apps/controller/src/drivers/credential-refresh/mcp-discovery.ts";

const server = "https://mcp.example.test/mcp";
const resource = "https://mcp.example.test";
const metadataUrl = resource + "/resource-metadata";
const issuer = "https://issuer.example.test";
const authorizationUrl = "https://login.example.test/authorize";
const tokenUrl = "https://login.example.test/token";
const scopes = ["channels:read", "chat:write"];

function discoveryFixture(challengeScope?: string, issuers = [issuer]) {
  const requests: string[] = [];
  async function fetchMetadata(value: string | URL, init?: RequestInit) {
    const url = value.toString();
    requests.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (url === server) {
      const scope = challengeScope ? `, scope="${challengeScope}"` : "";
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"${scope}` },
      });
    }
    if (url === metadataUrl) {
      return Response.json({ resource, authorization_servers: issuers, scopes_supported: scopes });
    }
    assert.equal(url, issuer + "/.well-known/oauth-authorization-server");
    return Response.json({
      issuer,
      authorization_endpoint: authorizationUrl,
      token_endpoint: tokenUrl,
      response_types_supported: ["code"],
    });
  }
  const resolveHost = async () => [{ address: "1.1.1.1", family: 4 }];
  return { requests, fetchMetadata, resolveHost };
}

test("discovery follows the protected resource challenge, binds the issuer, and proposes the server's scopes", async () => {
  for (const challenge of [undefined, "channels:read"]) {
    const fixture = discoveryFixture(challenge);
    const discovered = await discoverMcpAuthorization(
      "https://MCP.example.test:443/mcp",
      undefined,
      fixture,
    );
    assert.deepEqual(discovered, {
      serverUrl: server,
      resource,
      issuer,
      authorizationUrl,
      tokenUrl,
      scopes: challenge ? [challenge] : scopes,
    });
    assert.deepEqual(fixture.requests, [
      server,
      metadataUrl,
      issuer + "/.well-known/oauth-authorization-server",
    ]);
  }
});

test("each MCP credential endpoint keeps the server's exact host, port, and path", () => {
  assert.deepEqual(mcpCredentialEndpoint("https://MCP.example.test:443/mcp"), {
    host: "mcp.example.test",
    port: 443,
    path: "/mcp",
  });
  assert.deepEqual(mcpCredentialEndpoint("https://tools.other.test:8443/tenant/toolset-v2"), {
    host: "tools.other.test",
    port: 8443,
    path: "/tenant/toolset-v2",
  });
});

test("discovery refuses ambiguous issuers before contacting either one", async () => {
  const fixture = discoveryFixture(undefined, [issuer, "https://second.example.test"]);
  await assert.rejects(
    discoverMcpAuthorization(server, undefined, fixture),
    (err) => err instanceof BrowserAuthorizationError && err.code === "mcp_requires_one_issuer",
  );
  assert.deepEqual(fixture.requests, [server, metadataUrl]);
});

test("discovery refuses a host with mixed public and private DNS records before any request to it", async () => {
  const fixture = discoveryFixture();
  const resolveHost = async (host: string) =>
    host === new URL(issuer).hostname
      ? [
          { address: "1.1.1.1", family: 4 },
          { address: "::ffff:169.254.169.254", family: 6 },
        ]
      : fixture.resolveHost();
  await assert.rejects(
    discoverMcpAuthorization(server, undefined, { ...fixture, resolveHost }),
    (err) => err instanceof BrowserAuthorizationError && err.code === "mcp_endpoint_not_public",
  );
  assert.deepEqual(fixture.requests, [server, metadataUrl]);
});

test("discovery rejects server URLs that cannot become an exact protected egress rule", async () => {
  const fixture = discoveryFixture();
  for (const suffix of ["/*", "/%2A", "?token=example", "?"]) {
    await assert.rejects(
      discoverMcpAuthorization(server + suffix, undefined, fixture),
      (error) =>
        error instanceof BrowserAuthorizationError && error.code === "invalid_mcp_server_path",
    );
  }
  assert.deepEqual(fixture.requests, []);
});

test("discovery rejects a different issuer in authorization server metadata without exposing provider text", async () => {
  const fixture = discoveryFixture();
  const fetchMetadata = async (url: string | URL, init?: RequestInit) => {
    const response = await fixture.fetchMetadata(url, init);
    if (!url.toString().includes("oauth-authorization-server")) {
      return response;
    }
    return Response.json({ ...(await response.json()), issuer: "https://unexpected.example.test" });
  };
  await assert.rejects(
    discoverMcpAuthorization(server, undefined, { ...fixture, fetchMetadata }),
    (error) =>
      error instanceof BrowserAuthorizationError &&
      error.code === "invalid_mcp_metadata" &&
      !error.message.includes("unexpected"),
  );
});

test("an unreachable metadata host produces a safe dependency error", async () => {
  await assert.rejects(
    discoverMcpAuthorization(server, undefined, {
      ...discoveryFixture(),
      resolveHost: async () => {
        throw new Error("private-dns-diagnostic");
      },
    }),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !error.message.includes("private-dns-diagnostic"),
  );
});
