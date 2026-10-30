import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserAuthorizationError,
  DependencyUnavailableError,
  mcpCredentialEndpoint,
} from "../../packages/occ/src/index.ts";
import {
  discoverMcpAuthorization,
  registerMcpOAuthClient,
} from "../../apps/controller/src/connections/mcp-discovery.ts";

const server = "https://mcp.example.test/mcp";
const resource = "https://mcp.example.test";
const metadataUrl = resource + "/resource-metadata";
const issuer = "https://issuer.example.test";
const authorizationUrl = "https://login.example.test/authorize";
const tokenUrl = "https://login.example.test/token";
const scopes = ["channels:read", "chat:write"];

const registrationUrl = issuer + "/clients";
const revocationUrl = issuer + "/revoke";
const redirectUri = "https://console.example.test/oauth/callback";

function discoveryFixture(
  challengeScope?: string,
  issuers = [issuer],
  authMetadata: Record<string, unknown> = {},
) {
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
      ...authMetadata,
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

test("MCP setup offers only compatible registration and performs DCR only on explicit request", async () => {
  const metadata = { registration_endpoint: registrationUrl, revocation_endpoint: revocationUrl };
  const preregistered = discoveryFixture(undefined, [issuer], metadata);
  const preview = await discoverMcpAuthorization(server, undefined, preregistered);
  assert.equal(preview.registrationUrl, undefined);
  assert.equal(preview.revocationUrl, revocationUrl);
  const fixture = discoveryFixture(undefined, [issuer], {
    ...metadata,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
  const discovered = await discoverMcpAuthorization(server, undefined, fixture);
  assert.equal(discovered.registrationUrl, registrationUrl);
  assert.equal(fixture.requests.includes(registrationUrl), false);

  const approvedScope = scopes[0]!;
  const credentials = await registerMcpOAuthClient(
    discovered,
    redirectUri,
    [approvedScope],
    undefined,
    {
      resolveHost: fixture.resolveHost,
      fetchMetadata: async (url, init) => {
        assert.equal(url.toString(), registrationUrl);
        assert.equal(init?.method, "POST");
        assert.equal(init.redirect, "manual");
        assert.equal(init.credentials, "omit");
        assert.equal(new Headers(init.headers).has("authorization"), false);
        const posted = JSON.parse(String(init.body));
        assert.deepEqual(posted, {
          client_name: "OpenClaw Enterprise",
          redirect_uris: [redirectUri],
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "client_secret_post",
          scope: approvedScope,
        });
        return Response.json(
          {
            ...posted,
            client_id: "new-client",
            client_secret: "test-secret",
            registration_access_token: "test-management-token",
          },
          { status: 201 },
        );
      },
    },
  );
  assert.deepEqual(credentials, { clientId: "new-client", clientSecret: "test-secret" });
});

test("discovery only offers DCR for OAuth URLs the template version can persist", async () => {
  const dcr = {
    registration_endpoint: registrationUrl,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
  const authorizationWithQuery = authorizationUrl + "?tenant=work";
  const supported = discoveryFixture(undefined, [issuer], {
    ...dcr,
    authorization_endpoint: authorizationWithQuery,
  });
  assert.equal(
    (await discoverMcpAuthorization(server, undefined, supported)).authorizationUrl,
    authorizationWithQuery,
  );

  for (const [issuerUrl, endpoints] of [
    [issuer + "?", {}],
    [issuer, { token_endpoint: tokenUrl + "?tenant=work" }],
    [issuer, { token_endpoint: tokenUrl + "?" }],
    [issuer, { authorization_endpoint: "https://login.example.test?tenant=work" }],
    [issuer, { authorization_endpoint: authorizationUrl + "/".repeat(2048) }],
  ] as const) {
    const fixture = discoveryFixture(undefined, [issuerUrl], { ...dcr, ...endpoints });
    await assert.rejects(
      discoverMcpAuthorization(server, undefined, fixture),
      (e) => e instanceof BrowserAuthorizationError && e.code === "invalid_mcp_metadata",
    );
    assert.equal(fixture.requests.includes(registrationUrl), false);
    if (issuerUrl !== issuer) {
      assert.deepEqual(fixture.requests, [server, metadataUrl]);
    }
  }
});

test("MCP registration rechecks destination DNS and refuses redirects before forwarding the request", async () => {
  const fixture = discoveryFixture(undefined, [issuer], {
    registration_endpoint: registrationUrl,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
  const metadata = await discoverMcpAuthorization(server, undefined, fixture);
  let calls = 0;
  const fetchMetadata = async (url: string | URL) => {
    calls++;
    assert.equal(url.toString(), registrationUrl);
    return Response.redirect("https://other.example.test/register", 307);
  };
  await assert.rejects(
    registerMcpOAuthClient(metadata, redirectUri, scopes, undefined, {
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchMetadata,
    }),
    (e) => e instanceof BrowserAuthorizationError && e.code === "mcp_endpoint_not_public",
  );
  assert.equal(calls, 0);
  await assert.rejects(
    registerMcpOAuthClient(metadata, redirectUri, scopes, undefined, {
      resolveHost: fixture.resolveHost,
      fetchMetadata,
    }),
    (e) => e instanceof BrowserAuthorizationError && e.code === "unsupported_mcp_metadata_response",
  );
  assert.equal(calls, 1);
});

test("MCP registration rejects a refused or unusable client without returning provider details", async () => {
  const result = {
    redirect_uris: [redirectUri],
    client_id: "client",
    client_secret: "test-secret",
    token_endpoint_auth_method: "client_secret_post",
  };
  const register = (response: Response) =>
    registerMcpOAuthClient(
      {
        serverUrl: server,
        resource,
        issuer,
        authorizationUrl,
        tokenUrl,
        registrationUrl,
        scopes,
      },
      redirectUri,
      scopes,
      undefined,
      {
        resolveHost: discoveryFixture().resolveHost,
        fetchMetadata: async () => response,
      },
    );
  const credentials = { clientId: result.client_id, clientSecret: result.client_secret };
  assert.deepEqual(await register(Response.json(result)), credentials);
  assert.deepEqual(
    await register(Response.json({ ...result, scope: [...scopes].reverse().join(" ") })),
    credentials,
  );
  for (const response of [
    Response.json({ error: "provider-secret-detail" }, { status: 403 }),
    Response.json({ ...result, client_secret: "" }),
    Response.json({ ...result, client_id: "x".repeat(257) }),
    Response.json({ ...result, client_id: "invalid client" }),
    Response.json({ ...result, client_secret: "x".repeat(4097) }),
    Response.json({ ...result, scope: scopes[0] }),
    Response.json({ ...result, scope: [...scopes, "admin"].join(" ") }),
    Response.json({ ...result, grant_types: ["client_credentials"] }),
    Response.json({ ...result, client_secret_expires_at: 1 }),
    Response.json({ ...result, token_endpoint_auth_method: "none" }),
    Response.json({
      ...result,
      redirect_uris: [redirectUri, "https://other.example.test/callback"],
    }),
  ]) {
    await assert.rejects(
      register(response),
      (error) =>
        error instanceof BrowserAuthorizationError &&
        error.code === "invalid_mcp_registration" &&
        !error.message.includes("provider-secret-detail"),
    );
  }
});
