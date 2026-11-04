import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { discoverMcpAuthorization } from "../../apps/controller/src/connections/mcp-discovery.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const options = {
  label: "connection-templates",
  authSecret: "connection-templates-test-session-secret",
};
const issuer = "https://accounts.example.test";
const tokenUrl = issuer + "/token";
const clientInput = () => ({
  displayName: "Example OAuth application",
  issuer,
  tokenUrl,
  clientId: randomUUID(),
  tokenEndpointAuthMethod: "client_secret_basic",
  clientSecret: randomUUID(),
});
const manual = {
  displayName: "Engineering mail",
  mode: "manual",
  issuer,
  authorizationUrl: issuer + "/authorize",
  tokenUrl,
  scopes: ["mail.read"],
  recipient: { host: "mail.example.test", path: "/v1/**", access: "read-only" },
};

test(
  "independent scoped OAuth clients can be attached to an immutable template version",
  requiresPostgres,
  async (t) => {
    const { controller, inject } = await createPostgresAgentApp(t, options);
    const { providers } = selectTemplateDrivers(controller);
    // A resource hidden in a configured URL must not bypass the version's effective audience.
    const override = await inject("POST", "/connection-templates", {
      ...manual,
      authorizationUrl: issuer + "/authorize?resource=unapproved",
    });
    assert.equal(override.statusCode, 400, override.body);
    const ns = await inject("POST", "/namespaces", { name: `Template scope ${randomUUID()}` });
    assert.equal(ns.statusCode, 201, ns.body);
    const namespaceId = ns.json().data.id;
    for (const invalid of [
      { issuer: "https://[broken" },
      { authorizationParameters: { state: "custom" } },
    ]) {
      assert.equal(
        (await inject("POST", "/connection-templates", { ...manual, ...invalid })).statusCode,
        400,
      );
    }
    const draft = await inject("POST", "/connection-templates", manual);
    assert.equal(draft.statusCode, 201, draft.body);
    const template = draft.json().data;
    assert.equal(template.current.oauthClientId, undefined);
    const client = clientInput();
    const created = await inject("POST", "/oauth-clients", client);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.body.includes(client.clientSecret), false);
    const globalId = created.json().data.id;
    const scoped = await inject("POST", "/oauth-clients", { ...client, namespaceId });
    assert.equal(scoped.statusCode, 201, scoped.body);
    assert.equal((await inject("DELETE", `/namespaces/${namespaceId}`, undefined)).statusCode, 409);
    assert.equal(
      (
        await inject("PATCH", `/connection-templates/${template.id}`, {
          ...manual,
          oauthClientId: scoped.json().data.id,
        })
      ).statusCode,
      409,
    );
    // Even an Installation client does not permit sending its secret to another destination.
    assert.equal(
      (
        await inject("PATCH", `/connection-templates/${template.id}`, {
          ...manual,
          tokenUrl: issuer + "/different",
          oauthClientId: globalId,
        })
      ).statusCode,
      409,
    );
    const associated = await inject("PATCH", `/connection-templates/${template.id}`, {
      ...manual,
      oauthClientId: globalId,
    });
    assert.equal(associated.statusCode, 200, associated.body);
    assert.equal(associated.json().data.current.version, 2);
    const renamed = await inject("PATCH", `/connection-templates/${template.id}`, {
      displayName: "Mail",
    });
    assert.equal(renamed.json().data.current.version, 2);
    assert.equal((await inject("DELETE", `/oauth-clients/${globalId}`, undefined)).statusCode, 409);
    const local = await inject("POST", "/connection-templates", {
      ...manual,
      namespaceId,
      oauthClientId: globalId,
    });
    assert.equal(local.statusCode, 201, local.body);
    await inject("DELETE", `/connection-templates/${template.id}`, undefined);
    await inject("DELETE", `/connection-templates/${local.json().data.id}`, undefined);
    const clients = (await inject("GET", "/oauth-clients", undefined)).json().data;
    assert.deepEqual(
      clients
        .filter((item: { clientId: string }) => item.clientId === client.clientId)
        .map((item: { id: string }) => item.id)
        .sort(),
      [globalId, scoped.json().data.id].sort(),
    );
    const pub = await inject("POST", "/oauth-clients", {
      displayName: "Public client",
      issuer,
      tokenUrl,
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(pub.statusCode, 201, pub.body);
    assert.equal(
      (
        await inject("POST", `/oauth-clients/${pub.json().data.id}/rotate-secret`, {
          clientSecret: randomUUID(),
        })
      ).statusCode,
      409,
    );
    assert.equal(providers.size, 2);
  },
);

test(
  "OAuth client rotation commits the new secret handle with its audit",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const proxy = await commitAckProxy(databaseUrl);
    t.after(() => proxy.close());
    const { controller, inject } = await createPostgresAgentApp(t, {
      ...options,
      transportDatabaseUrl: proxy.url,
    });
    const { refresh, providers } = selectTemplateDrivers(controller);
    const input = clientInput();
    const original = await inject("POST", "/oauth-clients", input);
    assert.equal(original.statusCode, 201, original.body);
    const client = original.json().data;
    const next = randomUUID();
    const stage = refresh.registerClient.bind(refresh);
    t.mock.method(
      refresh,
      "registerClient",
      async (...args: Parameters<typeof stage>) => {
        await stage(...args);
        proxy.arm();
      },
      { times: 1 },
    );
    const response = await inject("POST", `/oauth-clients/${client.id}/rotate-secret`, {
      clientSecret: next,
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.ok(proxy.observedCommit);
    // SQL committed before the socket closed. Replay only retires the previous secret generation.
    await controller.cleanupRetiredOAuthClientSecrets();
    assert.equal(providers.size, 1);
    assert.ok(JSON.stringify([...providers.values()]).includes(next));
    assert.ok(!JSON.stringify([...providers.values()]).includes(input.clientSecret));
    assert.equal(
      (await inject("DELETE", `/oauth-clients/${client.id}`, undefined)).statusCode,
      204,
    );
    await controller.cleanupRetiredOAuthClientSecrets();
    assert.equal(providers.size, 0);
  },
);

test(
  "MCP discovery selects one advertised issuer and saves only the administrator's approved scopes",
  requiresPostgres,
  async (t) => {
    const serverUrl = "https://mcp.example.test/mcp";
    const resource = "https://mcp.example.test";
    const second = "https://second.example.test";
    const metadataUrl = resource + "/metadata";
    const fetched: string[] = [];
    const transport = {
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      async fetchMetadata(value: string | URL) {
        const url = String(value);
        fetched.push(url);
        if (url === serverUrl) {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="messages.read"`,
            },
          });
        }
        if (url === metadataUrl) {
          return Response.json({
            resource,
            authorization_servers: [issuer, second],
            scopes_supported: ["messages.read", "messages.write"],
          });
        }
        assert.equal(url, issuer + "/.well-known/oauth-authorization-server");
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token?tenant=acme",
          response_types_supported: ["code"],
          scopes_supported: ["messages.read", "messages.write"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      },
    };
    const { inject } = await createPostgresAgentApp(t, {
      ...options,
      appOptions: {
        discoverMcpAuthorization: (url: string, choice?: string) =>
          discoverMcpAuthorization(url, choice, undefined, transport),
      },
    });
    const preview = await inject("POST", "/connection-templates/discover", { serverUrl });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().data.issuers, [issuer, second]);
    assert.deepEqual(fetched, [serverUrl, metadataUrl]);
    const choice = await inject("POST", "/connection-templates/discover", {
      serverUrl,
      issuer: "https://wrong.example.test",
    });
    assert.equal(choice.statusCode, 400, choice.body);
    const config = { mode: "mcp_discovery", displayName: "Team messaging", serverUrl, issuer };
    assert.equal(
      (await inject("POST", "/connection-templates", { ...config, scopes: ["unadvertised"] }))
        .statusCode,
      400,
    );
    const result = await inject("POST", "/connection-templates", {
      ...config,
      scopes: ["messages.read"],
    });
    assert.equal(result.statusCode, 201, result.body);
    const { current } = result.json().data;
    assert.deepEqual(current.scopes, ["messages.read"]);
    assert.deepEqual(current.observed.resourceScopes, ["messages.read", "messages.write"]);
    assert.deepEqual(current.recipient, {
      host: "mcp.example.test",
      port: 443,
      path: "/mcp",
      access: "full",
    });
    assert.deepEqual(current.mcp, { serverUrl, resource });
    assert.equal(current.tokenUrl, issuer + "/token?tenant=acme");
  },
);

test(
  "revoking a browser session while rotation waits prevents the secret from reaching its Driver",
  requiresPostgres,
  async (t) => {
    const { controller, inject, pool } = await createPostgresAgentApp(t, options);
    const { app: peer } = await createPostgresAgentApp(t, options);
    const { createdProviders } = selectTemplateDrivers(controller);
    const client = await inject("POST", "/oauth-clients", clientInput());
    assert.equal(client.statusCode, 201, client.body);
    assert.equal(createdProviders.length, 1);
    const id = client.json().data.id;
    const lock = await pool.connect();
    let rotation;
    try {
      await lock.query("BEGIN");
      const held = await lock.query(
        "SELECT pg_backend_pid() AS pid FROM occ.oauth_clients WHERE id=$1 FOR UPDATE",
        [id],
      );
      rotation = inject("POST", `/oauth-clients/${id}/rotate-secret`, {
        clientSecret: randomUUID(),
      });
      await waitForLockWaiter(
        pool,
        held.rows[0].pid,
        "rotation waiting for the selected OAuth client",
      );
      // The second API instance shares PostgreSQL and uses the original request's session cookie.
      const logout = await inject("POST", "/api/auth/sign-out", {}, peer);
      assert.equal(logout.statusCode, 200, logout.body);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    const denied = await rotation;
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(
      createdProviders.length,
      1,
      "logout must win before the Driver stages any replacement",
    );
  },
);
