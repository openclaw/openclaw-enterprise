import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ConnectionTemplate } from "../../packages/contracts/src/index.ts";
import { ResourceConflictError } from "../../packages/occ/src/index.ts";
import { discoverMcpAuthorization } from "../../apps/controller/src/connections/mcp-discovery.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import { signedInHeaders } from "../helpers/production-sign-in.mjs";
import {
  createBackendController,
  createBackendFixture,
} from "../helpers/postgres-backend-state.mjs";
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
  tokenEndpointAuthMethod: "client_secret_basic" as const,
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
  destinations: [{ host: "mail.example.test", path: "/v1/**" }],
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
  "the Installation starts with an editable Google OAuth template and preserves saved destination versions",
  requiresPostgres,
  async (t) => {
    const { inject, state, pool } = await createPostgresAgentApp(t, options);
    const list = await inject("GET", "/connection-templates");
    assert.equal(list.statusCode, 200, list.body);
    const templates: ConnectionTemplate[] = list.json().data;
    const shipped = templates.filter(
      (template) => template.namespaceId === undefined && template.displayName === "Google OAuth",
    );
    assert.equal(shipped.length, 1);
    const [seed] = shipped;
    assert.ok(seed);
    const version = seed.current;
    assert.equal(version.mode, "manual");
    assert.equal(version.issuer, "https://accounts.google.com");
    assert.equal(version.oauthClientId, undefined);
    assert.deepEqual(version.scopes, []);
    assert.deepEqual(version.authorizationParameters, {
      access_type: "offline",
      prompt: "consent",
    });
    const defaults = version.destinations;
    assert.ok(
      defaults.some((row) => row.host === "gmail.googleapis.com" && row.path === "/gmail/**"),
    );
    assert.deepEqual(
      defaults.filter((row) => row.host === "www.googleapis.com"),
      [
        { host: "www.googleapis.com", port: 443, path: "/calendar/**" },
        { host: "www.googleapis.com", port: 443, path: "/drive/**" },
      ],
    );
    // Run the destructive version checks on a Namespace copy so this database stays reusable.
    const ns = await inject("POST", "/namespaces", { name: "Google API test " + randomUUID() });
    assert.equal(ns.statusCode, 201, ns.body);
    const google = {
      displayName: "Google Workspace account",
      mode: version.mode,
      issuer: version.issuer,
      authorizationUrl: version.authorizationUrl,
      tokenUrl: version.tokenUrl,
      revocationUrl: version.revocationUrl,
      scopes: version.scopes,
      authorizationParameters: version.authorizationParameters,
    };
    const created = await inject("POST", "/connection-templates", {
      ...google,
      namespaceId: ns.json().data.id,
      destinations: defaults,
    });
    assert.equal(created.statusCode, 201, created.body);
    const template = created.json().data;
    const url = "/connection-templates/" + template.id;
    // The admin can keep two paths on a shared host and approve a separate host/port pair.
    const expected = [
      { host: "api.example.test", port: 443, path: "/**" },
      { host: "api.example.test", port: 443, path: "/v2" },
      { host: "files.example.test", port: 8443, path: "/v2/**" },
    ];
    const edited = await inject("PATCH", url, {
      ...google,
      destinations: [expected[2], { host: "API.example.test" }, expected[1], expected[0]],
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().data.current.version, 2);
    assert.deepEqual(edited.json().data.current.destinations, expected);
    const reordered = await inject("PATCH", url, {
      ...google,
      destinations: [...expected].reverse(),
    });
    assert.equal(reordered.statusCode, 200, reordered.body);
    assert.equal(reordered.json().data.current.version, 2);
    const pinned = await state.read((tx) =>
      tx.connectionTemplates.findOAuthConnectionTemplateVersion(template.id, 1),
    );
    assert.deepEqual(pinned?.destinations, defaults);
    for (const bad of [
      [],
      [{ host: "*.example.test" }],
      [{ host: "api.example.test", path: "/v1?token" }],
    ]) {
      assert.equal((await inject("PATCH", url, { ...google, destinations: bad })).statusCode, 400);
    }
    // A caller bypassing normal HTTP writes still cannot insert duplicate routes in a version.
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.oauth_connection_template_versions
        (template_id, version, issuer, mode, authorization_url, token_url, scopes, authorization_parameters, destinations, created_at)
       SELECT template_id, 3, issuer, mode, authorization_url, token_url, scopes, authorization_parameters, $2, now()
       FROM occ.oauth_connection_template_versions WHERE template_id=$1 AND version=2`,
        [template.id, JSON.stringify([expected[0], expected[0]])],
      ),
      { code: "23514", constraint: "oauth_connection_template_versions_destinations_valid" },
    );
  },
);

test(
  "an administrator registers OAuth clients against a pinned template and its availability",
  requiresPostgres,
  async (t) => {
    const { app, controller, inject, pool, state } = await createPostgresAgentApp(t, options);
    const { core, driver } = useInstallationSecretDriver(controller);
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
      baseURL: "https://console.oce.localhost",
      agentDomain: "agents.oce.localhost",
      secret: options.authSecret,
      pool,
    });
    const reader = await auth.createAccount({ ...member, name: "Template reader" });
    await state.appendNativeIAMPrincipal(auth.principalSeed(reader, { grant: "none" }));
    const session = await signedInHeaders(app, "https://console.oce.localhost", member);
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
    assert.equal(core.calls.createNamespacedSecret, 0);
    const created = await inject("POST", "/oauth-clients", client);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.body.includes(client.clientSecret), false);
    const registration = created.json().data;
    const globalId = registration.id;
    assert.equal(registration.issuer, issuer);
    assert.equal(registration.tokenUrl, tokenUrl);
    assert.equal(registration.revocationUrl, manual.revocationUrl);
    assert.equal(registration.namespaceId, undefined);
    assert.ok(!created.body.includes(driver.id));
    assert.ok(
      await controller.withOAuthClientSecret(
        registration,
        async (value) => value === client.clientSecret,
      ),
    );
    const read = () => inject("GET", `/connection-templates/${templateId}`);
    const selected = (await read()).json().data.current;
    assert.equal(selected.version, 2);
    assert.equal(selected.oauthClientId, globalId);
    const stale = await inject("POST", "/oauth-clients", {
      ...client,
      clientId: randomUUID(),
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      core.calls.createNamespacedSecret,
      1,
      "a stale version must not stage private material",
    );
    const scopedDraft = await createManualDraft(inject, namespaceId);
    const scoped = await inject("POST", "/oauth-clients", {
      ...client,
      connectionTemplateId: scopedDraft,
    });
    assert.equal(scoped.statusCode, 201, scoped.body);
    assert.equal(scoped.json().data.namespaceId, namespaceId);
    const secrets = await inject("GET", `/namespaces/${namespaceId}/secrets`);
    assert.equal(secrets.statusCode, 200, secrets.body);
    assert.deepEqual(
      secrets.json().data,
      [],
      "a Namespace registration never exposes a tenant Secret",
    );
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
    assert.equal(
      await controller.withOAuthClientSecret(pub.json().data, async (value) => value),
      undefined,
    );
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
    const listing = await inject("GET", "/oauth-clients", undefined);
    assert.equal(listing.statusCode, 200, listing.body);
    assert.equal(listing.body.includes(client.clientSecret), false);
    assert.equal(listing.body.includes(driver.id), false);
    const clients = listing.json().data;
    assert.deepEqual(
      clients
        .filter((item: { clientId: string }) => item.clientId === client.clientId)
        .map((item: { id: string }) => item.id)
        .sort(),
      [globalId, scoped.json().data.id].sort(),
    );
    assert.equal(core.secrets.size, 2);
  },
);

test(
  "OAuth client secret mutations refuse an enclosing controller transaction",
  requiresPostgres,
  async (t) => {
    for (const operation of ["create", "rotate"] as const) {
      await t.test(operation, async (t) => {
        const { controller, inject, pool, principal, state } = await createPostgresAgentApp(
          t,
          options,
        );
        const { core } = useInstallationSecretDriver(controller);
        const templateId = await createManualDraft(inject);
        const input = clientInput(templateId);
        const original = await inject("POST", "/oauth-clients", input);
        assert.equal(original.statusCode, 201, original.body);
        const client = original.json().data;
        const installation = await state.loadInstallation();
        assert.ok(installation);
        const probe = randomUUID();
        const next = {
          ...input,
          connectionTemplateVersion: 2,
          clientId: randomUUID(),
          clientSecret: randomUUID(),
        };
        const privateNames = [...core.secrets.keys()];
        const audit = (id: string) => ({
          id: randomUUID(),
          installationId: installation.id,
          occurredAt: new Date().toISOString(),
          kind: "mutation" as const,
          actorId: principal.id,
          action:
            operation === "create"
              ? "openclaw.oauth_clients.create"
              : "openclaw.oauth_clients.rotate_secret",
          resource: { kind: "installation" as const, id: installation.id },
          outcome: "success" as const,
          details: { oauthClientId: id, transactionProbe: probe },
        });

        // The public composition API must refuse before a private write. Otherwise an
        // outer failure can discard the cleanup reservation or the rotation request audit.
        const failure = await controller
          .transact(async () => {
            if (operation === "create") {
              await controller.createOAuthClient(principal.id, next, audit);
            } else {
              await controller.rotateOAuthClientSecret(
                principal.id,
                client.id,
                next.clientSecret,
                audit(client.id),
              );
            }
            throw new Error("The surrounding resource mutation failed.");
          })
          .catch((error: unknown) => error);

        assert.deepEqual(
          [...core.secrets.keys()],
          privateNames,
          "rollback must not leave an untracked private secret",
        );
        assert.equal(
          await controller.withOAuthClientSecret(
            client,
            async (value) => value === input.clientSecret,
          ),
          true,
          "rollback must not leave a rotated value without its request audit",
        );
        assert.equal(
          (await pool.query("SELECT id FROM occ.oauth_clients WHERE client_id=$1", [next.clientId]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT id FROM occ.audit_events WHERE details->>'transactionProbe'=$1",
              [probe],
            )
          ).rowCount,
          0,
        );
        assert.ok(failure instanceof ResourceConflictError);
        assert.match(failure.message, /cannot run in a controller transaction/);
      });
    }
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
    const { core } = useInstallationSecretDriver(controller);
    const templateId = await createManualDraft(inject);
    const input = clientInput(templateId);
    const original = await inject("POST", "/oauth-clients", input);
    assert.equal(original.statusCode, 201, original.body);
    const client = original.json().data;
    const next = randomUUID();
    const secretNames = [...core.secrets.keys()];
    const replace = core.replaceNamespacedSecret.bind(core);
    t.mock.method(
      core,
      "replaceNamespacedSecret",
      async (request: Parameters<typeof core.replaceNamespacedSecret>[0]) => {
        const updated = await replace(request);
        proxy.arm();
        return updated;
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
    assert.deepEqual([...core.secrets.keys()], secretNames);
    await controller.cleanupOAuthClients();
    assert.equal(core.secrets.size, 1);
    assert.equal(
      await controller.withOAuthClientSecret(client, async (value) => value === next),
      true,
      "existing registrations must resolve the rotated value",
    );
    assert.equal(
      (await inject("DELETE", `/connection-templates/${templateId}`, undefined)).statusCode,
      204,
    );
    assert.equal(
      (await inject("DELETE", `/oauth-clients/${client.id}`, undefined)).statusCode,
      204,
    );
    // A failed private deletion leaves a hidden client that the worker can still identify and retry.
    core.failureCodes.deleteNamespacedSecret.push(403);
    await controller.cleanupOAuthClients();
    assert.equal(core.secrets.size, 1);
    const hidden = await inject("GET", "/oauth-clients");
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.ok(!hidden.json().data.some((row: { id: string }) => row.id === client.id));
    const due = await pool.query(
      "UPDATE occ.oauth_clients SET cleanup_after=now() WHERE id=$1 AND cleanup_after IS NOT NULL",
      [client.id],
    );
    assert.equal(due.rowCount, 1);
    await controller.cleanupOAuthClients();
    assert.equal(core.secrets.size, 0);
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
    const recovery = await createBackendFixture(t);
    const { pool } = recovery;
    const recovered = createBackendController(recovery, { backends: [] });
    const { core, driver } = useInstallationSecretDriver(controller);
    recovered.registerDriver(driver);
    recovered.selectDriver("secret", driver.id);
    const templateId = await createManualDraft(inject);
    const input = clientInput(templateId);
    const original = await inject("POST", "/oauth-clients", input);
    assert.equal(original.statusCode, 201, original.body);
    const stage = core.createNamespacedSecret.bind(core);
    const stagedClientId = randomUUID();
    t.mock.method(
      core,
      "createNamespacedSecret",
      async (request: Parameters<typeof core.createNamespacedSecret>[0]) => {
        const created = await stage(request);
        proxy.arm({ pauseCommit: true });
        return created;
      },
      { times: 1 },
    );
    const response = inject("POST", "/oauth-clients", {
      ...input,
      connectionTemplateVersion: 2,
      clientId: stagedClientId,
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
    assert.equal(core.secrets.size, 2);
    // The worker has a Secret Driver and no Credential Gateway or Refresh Driver.
    const expired = await pool.query(
      "UPDATE occ.oauth_clients SET cleanup_after=now() WHERE client_id=$1 AND cleanup_after IS NOT NULL RETURNING id",
      [stagedClientId],
    );
    assert.equal(expired.rowCount, 1);
    const { worker } = recovery.startWorker({ backends: [], secretDriver: driver });
    await worker.start();
    await waitFor("the worker to retire the hidden registration", async () => {
      const remaining = await pool.query("SELECT id FROM occ.oauth_clients WHERE id=$1", [
        expired.rows[0].id,
      ]);
      return remaining.rowCount === 0 ? true : undefined;
    });
    assert.equal(core.secrets.size, 1);
    assert.equal(
      await recovered.withOAuthClientSecret(
        original.json().data,
        async (value) => value === input.clientSecret,
      ),
      true,
      "cleaning an expired reservation preserves the published client",
    );
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
    assert.deepEqual(current.destinations, [{ host: "mcp.example.test", port: 443, path: "/mcp" }]);
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
    const { core } = useInstallationSecretDriver(controller);
    const client = await inject(
      "POST",
      "/oauth-clients",
      clientInput(await createManualDraft(inject)),
    );
    assert.equal(client.statusCode, 201, client.body);
    assert.equal(core.calls.createNamespacedSecret, 1);
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
      core.calls.replaceNamespacedSecret,
      0,
      "logout must win before any write of the replacement secret",
    );
  },
);
