import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { discoverMcpAuthorization } from "../../apps/controller/src/connections/mcp-discovery.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import { signedInHeaders } from "../helpers/production-sign-in.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const options = {
  label: "connection-templates",
  authSecret: "connection-templates-test-session-secret",
};
const issuer = "https://accounts.example.test";
const tokenUrl = issuer + "/token";
const clientInput = (connectionTemplateId: string, connectionTemplateVersion = 1) => ({
  connectionTemplateId,
  connectionTemplateVersion,
  displayName: "Example OAuth application",
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
  revocationUrl: issuer + "/revoke",
  scopes: ["mail.read"],
  recipient: { host: "mail.example.test", path: "/v1/**" },
};

async function createManualDraft(
  inject: Awaited<ReturnType<typeof createPostgresAgentApp>>["inject"],
  namespaceId?: string,
): Promise<string> {
  const draft = await inject("POST", "/connection-templates", {
    ...manual,
    namespaceId,
  });
  assert.equal(draft.statusCode, 201, draft.body);
  assert.equal(draft.json().data.current.oauthClientId, undefined);
  return draft.json().data.id;
}

test(
  "a Google API recipient pins the provider and can be narrowed in a new template version",
  requiresPostgres,
  async (t) => {
    const { inject, state } = await createPostgresAgentApp(t, options);
    const google = {
      ...manual,
      issuer: "https://accounts.google.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      recipient: { kind: "google_apis" },
    };
    const created = await inject("POST", "/connection-templates", google);
    assert.equal(created.statusCode, 201, created.body);
    const template = created.json().data;
    assert.deepEqual(template.current.recipient, { kind: "google_apis" });
    assert.equal(template.current.oauthClientId, undefined);
    // The family is reserved for Google's OAuth flow, even when creating a draft without a client.
    for (const field of ["issuer", "authorizationUrl", "tokenUrl", "revocationUrl"]) {
      const mismatch = await inject("PATCH", "/connection-templates/" + template.id, {
        ...google,
        [field]: issuer,
      });
      assert.equal(mismatch.statusCode, 400, mismatch.body);
    }
    const endpoint = { host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/**" };
    const narrowed = await inject("PATCH", "/connection-templates/" + template.id, {
      ...google,
      recipient: endpoint,
    });
    assert.equal(narrowed.statusCode, 200, narrowed.body);
    assert.equal(narrowed.json().data.current.version, 2);
    assert.deepEqual(narrowed.json().data.current.recipient, endpoint);
    const pinned = await state.read((tx) =>
      tx.connectionTemplates.findOAuthConnectionTemplateVersion(template.id, 1),
    );
    assert.deepEqual(pinned?.recipient, { kind: "google_apis" });
  },
);

test(
  "an administrator registers OAuth clients against a pinned template and its availability",
  requiresPostgres,
  async (t) => {
    const { app, controller, inject, pool, state } = await createPostgresAgentApp(t, options);
    const { providers, createdProviders } = selectTemplateDrivers(controller);
    // A resource hidden in a configured URL must not bypass the version's effective audience.
    const override = await inject("POST", "/connection-templates", {
      ...manual,
      authorizationUrl: issuer + "/authorize?resource=unapproved",
    });
    assert.equal(override.statusCode, 400, override.body);
    const ns = await inject("POST", "/namespaces", {
      name: `Template scope ${randomUUID()}`,
    });
    assert.equal(ns.statusCode, 201, ns.body);
    const namespaceId = ns.json().data.id;
    for (const invalid of [
      { issuer: "https://[broken" },
      { authorizationParameters: { state: "custom" } },
    ]) {
      assert.equal(
        (
          await inject("POST", "/connection-templates", {
            ...manual,
            ...invalid,
          })
        ).statusCode,
        400,
      );
    }
    const templateId = await createManualDraft(inject);
    const client = clientInput(templateId);
    // Only template admins can use the pinned provider registration, even for a known template ID.
    const member = {
      email: `reader-${randomUUID()}@example.test`,
      password: randomUUID(),
    };
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: controller.installation.id,
      baseURL: "http://127.0.0.1",
      secret: options.authSecret,
      pool,
    });
    const reader = await auth.createAccount({ ...member, name: "Template reader" });
    await state.appendNativeIAMPrincipal(auth.principalSeed(reader, { grant: "none" }));
    const session = await signedInHeaders(app, "http://127.0.0.1", member);
    const denied = await app.inject({
      method: "POST",
      url: "/oauth-clients",
      headers: session,
      payload: client,
    });
    assert.equal(denied.statusCode, 403, denied.body);
    for (const fields of [
      { tokenEndpointAuthMethod: "private_key_jwt" },
      { issuer: issuer + "/other" },
      { tokenUrl: issuer + "/other" },
      { revocationUrl: issuer + "/other" },
      { namespaceId },
    ]) {
      const refused = await inject("POST", "/oauth-clients", {
        ...client,
        ...fields,
      });
      assert.equal(refused.statusCode, 400, refused.body);
    }
    assert.equal(createdProviders.length, 0);
    const created = await inject("POST", "/oauth-clients", client);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.body.includes(client.clientSecret), false);
    const registration = created.json().data;
    const globalId = registration.id;
    assert.equal(registration.issuer, issuer);
    assert.equal(registration.tokenUrl, tokenUrl);
    assert.equal(registration.revocationUrl, manual.revocationUrl);
    assert.equal(registration.namespaceId, undefined);
    const read = () => inject("GET", `/connection-templates/${templateId}`);
    const selected = (await read()).json().data.current;
    assert.equal(selected.version, 2);
    assert.equal(selected.oauthClientId, globalId);
    const stale = await inject("POST", "/oauth-clients", {
      ...client,
      clientId: randomUUID(),
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(createdProviders.length, 1, "a stale version must not stage private material");
    const scopedDraft = await createManualDraft(inject, namespaceId);
    const scoped = await inject("POST", "/oauth-clients", {
      ...client,
      connectionTemplateId: scopedDraft,
    });
    assert.equal(scoped.statusCode, 201, scoped.body);
    assert.equal(scoped.json().data.namespaceId, namespaceId);
    assert.equal((await inject("DELETE", `/namespaces/${namespaceId}`, undefined)).statusCode, 409);
    assert.equal(
      (
        await inject("PATCH", `/connection-templates/${templateId}`, {
          ...manual,
          oauthClientId: scoped.json().data.id,
        })
      ).statusCode,
      409,
    );
    // Even an Installation client does not permit sending its secret to another destination.
    assert.equal(
      (
        await inject("PATCH", `/connection-templates/${templateId}`, {
          ...manual,
          tokenUrl: issuer + "/different",
          oauthClientId: globalId,
        })
      ).statusCode,
      409,
    );
    const pub = await inject("POST", "/oauth-clients", {
      connectionTemplateId: templateId,
      connectionTemplateVersion: selected.version,
      displayName: "Public client",
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(pub.statusCode, 201, pub.body);
    assert.deepEqual(
      (await read()).json().data.current,
      selected,
      "registering another client preserves the template's selection and version",
    );
    assert.equal(
      (
        await inject("POST", `/oauth-clients/${pub.json().data.id}/rotate-secret`, {
          clientSecret: randomUUID(),
        })
      ).statusCode,
      409,
    );
    const renamed = await inject("PATCH", `/connection-templates/${templateId}`, {
      displayName: "Mail",
    });
    assert.equal(renamed.json().data.current.version, 2);
    assert.equal((await inject("DELETE", `/oauth-clients/${globalId}`, undefined)).statusCode, 409);
    const manyScopes = Array.from({ length: 40 }, (_, i) => `mail.permission.${i}`);
    const local = await inject("POST", "/connection-templates", {
      ...manual,
      scopes: manyScopes,
      namespaceId,
      oauthClientId: globalId,
    });
    assert.equal(local.statusCode, 201, local.body);
    assert.deepEqual(local.json().data.current.scopes, manyScopes);
    await inject("DELETE", `/connection-templates/${templateId}`, undefined);
    await inject("DELETE", `/connection-templates/${local.json().data.id}`, undefined);
    const clients = (await inject("GET", "/oauth-clients", undefined)).json().data;
    assert.deepEqual(
      clients
        .filter((item: { clientId: string }) => item.clientId === client.clientId)
        .map((item: { id: string }) => item.id)
        .sort(),
      [globalId, scoped.json().data.id].sort(),
    );
    assert.equal(providers.size, 2);
  },
);

test(
  "OAuth client rotation updates its stable private reference across an unknown commit",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const proxy = await commitAckProxy(databaseUrl);
    t.after(() => proxy.close());
    const { controller, inject, pool } = await createPostgresAgentApp(t, {
      ...options,
      transportDatabaseUrl: proxy.url,
    });
    const { refresh, providers } = selectTemplateDrivers(controller);
    const templateId = await createManualDraft(inject);
    const input = clientInput(templateId);
    const original = await inject("POST", "/oauth-clients", input);
    assert.equal(original.statusCode, 201, original.body);
    const client = original.json().data;
    const next = randomUUID();
    const providerNames = [...providers.keys()];
    const rotate = refresh.rotateClientSecret.bind(refresh);
    t.mock.method(
      refresh,
      "rotateClientSecret",
      async (...args: Parameters<typeof rotate>) => {
        await rotate(...args);
        proxy.arm();
      },
      { times: 1 },
    );
    const response = await inject("POST", `/oauth-clients/${client.id}/rotate-secret`, {
      clientSecret: next,
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.ok(proxy.observedCommit);
    const audit = await pool.query(
      `SELECT attempted.actor_id AS requester, completed.actor_id AS writer
       FROM occ.audit_events attempted JOIN occ.audit_events completed
         ON attempted.details->'__occAuditMetadata'->>'requestId'=completed.details->'__occAuditMetadata'->>'requestId'
       WHERE attempted.details->>'oauthClientId'=$1 AND attempted.details->>'phase'='requested'
         AND completed.details->>'oauthClientId'=$1 AND completed.details->>'phase' IS NULL AND completed.outcome='success'`,
      [client.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].requester, audit.rows[0].writer);

    // An unknown audit commit cannot switch references or retire material still used by the client.
    assert.deepEqual([...providers.keys()], providerNames);
    await controller.cleanupOAuthClients();
    assert.equal(providers.size, 1);
    assert.ok(JSON.stringify([...providers.values()]).includes(next));
    assert.ok(!JSON.stringify([...providers.values()]).includes(input.clientSecret));
    assert.equal(
      (await inject("DELETE", `/connection-templates/${templateId}`, undefined)).statusCode,
      204,
    );
    assert.equal(
      (await inject("DELETE", `/oauth-clients/${client.id}`, undefined)).statusCode,
      204,
    );
    // A failed private deletion leaves a hidden client that the worker can still identify and retry.
    t.mock.method(
      refresh,
      "removeClient",
      async () => {
        throw new Error("Private store unavailable");
      },
      { times: 1 },
    );
    await controller.cleanupOAuthClients();
    assert.equal(providers.size, 1);
    const hidden = await inject("GET", "/oauth-clients");
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.ok(!hidden.json().data.some((row: { id: string }) => row.id === client.id));
    const due = await pool.query(
      "UPDATE occ.oauth_clients SET cleanup_after=now() WHERE id=$1 AND cleanup_after IS NOT NULL",
      [client.id],
    );
    assert.equal(due.rowCount, 1);
    await controller.cleanupOAuthClients();
    assert.equal(providers.size, 0);
  },
);

test(
  "the worker removes an unpublished OAuth client after interrupted creation",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const proxy = await commitAckProxy(databaseUrl);
    let closed = false;
    t.after(async () => {
      if (!closed) {
        await proxy.close();
      }
    });
    const { controller, inject } = await createPostgresAgentApp(t, {
      ...options,
      transportDatabaseUrl: proxy.url,
    });
    const { pool, controller: recovered } = await createPostgresAgentApp(t, options);
    const { refresh, providers } = selectTemplateDrivers(controller);
    recovered.registerDriver(refresh);
    recovered.selectDriver("credential_refresh", refresh.id);
    const templateId = await createManualDraft(inject);
    const input = clientInput(templateId);
    const original = await inject("POST", "/oauth-clients", input);
    assert.equal(original.statusCode, 201, original.body);
    const stage = refresh.registerClient.bind(refresh);
    let stagedId = "";
    t.mock.method(
      refresh,
      "registerClient",
      async (...args: Parameters<typeof stage>) => {
        await stage(...args);
        stagedId = args[0].registrationId;
        proxy.arm({ pauseCommit: true });
      },
      { times: 1 },
    );
    const response = inject("POST", "/oauth-clients", {
      ...input,
      connectionTemplateVersion: 2,
      clientId: randomUUID(),
      clientSecret: randomUUID(),
    });
    await waitFor(
      "the Driver staged the secret and PostgreSQL has not received COMMIT",
      async () => proxy.commitPaused || undefined,
    );
    // Dropping this socket rolls the transaction back on the server. OCC cannot know its outcome.
    await proxy.close();
    closed = true;
    assert.equal((await response).statusCode, 503);
    assert.equal(providers.size, 2);
    // Advance just this reservation to its due time, then run maintenance under a new controller.
    const expired = await pool.query(
      "UPDATE occ.oauth_clients SET cleanup_after=now() WHERE id=$1 AND cleanup_after IS NOT NULL RETURNING id",
      [stagedId],
    );
    assert.equal(expired.rowCount, 1);
    await recovered.cleanupOAuthClients();
    assert.equal(providers.size, 1);
    assert.ok(JSON.stringify([...providers.values()]).includes(input.clientSecret));
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
    const unrestricted = await inject("PATCH", `/connection-templates/${result.json().data.id}`, {
      ...config,
      scopes: [],
    });
    assert.equal(unrestricted.statusCode, 200, unrestricted.body);
    assert.deepEqual(unrestricted.json().data.current.scopes, []);
    assert.deepEqual(unrestricted.json().data.current.observed.requestedScopes, ["messages.read"]);
    const { current } = result.json().data;
    assert.deepEqual(current.scopes, ["messages.read"]);
    assert.deepEqual(current.observed.resourceScopes, ["messages.read", "messages.write"]);
    assert.deepEqual(current.recipient, {
      host: "mcp.example.test",
      port: 443,
      path: "/mcp",
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
    const client = await inject(
      "POST",
      "/oauth-clients",
      clientInput(await createManualDraft(inject)),
    );
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
