import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// Storage/admission integration only: the HTTP suite separately proves IAM
// authorization. These server-only operations model an already authorized key
// manager; referenceId can belong to an external IAM Driver, not a local user.
test(
  "PostgreSQL Better Auth keys remain hashed, scoped, and revocable across instances",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    let key;
    t.after(async () => {
      try {
        if (key) {
          await issuer.revokeServiceKey(key);
        }
      } finally {
        await pool.end();
      }
    });
    const installationId = `ins_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    const options = {
      pool,
      installationId,
      mode: "development",
      baseURL: "http://127.0.0.1",
      secret: `storage-test-${randomUUID()}`,
      secureCookies: false,
    };
    const issuer = await createPostgresControllerAuth(options);
    const verifier = await createPostgresControllerAuth(options);
    const principal = {
      kind: "service_principal",
      id: `external-automation-${randomUUID()}`,
      namespaceId,
    };
    key = await issuer.createServiceKey({ principal, name: "storage-proof" });
    const stored = await pool.query(
      "SELECT key, reference_id, metadata FROM occ.apikey WHERE id = $1",
      [key.id],
    );
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].key, key.key);
    assert.equal(stored.rows[0].reference_id, principal.id);
    assert.deepEqual(JSON.parse(stored.rows[0].metadata), { installationId, namespaceId });
    const request = {
      requestId: `req_${randomUUID()}`,
      method: "GET",
      routeId: "getNamespace",
      requestedScope: { installationId, namespaceId },
      transport: { remoteAddress: "127.0.0.1" },
      headers: { "x-api-key": key.key },
    };
    const admitted = await verifier.admissionVerifier.verify(request);
    assert.equal(admitted.method, "api_key");
    assert.equal(admitted.externalIdentity.subject, principal.id);
    assert.deepEqual(admitted.admittedScope, { installationId, namespaceId });
    assert.equal((await verifier.getServiceKey(key.id)).id, key.id);
    await assert.rejects(
      verifier.admissionVerifier.verify({ ...request, headers: { "x-api-key": "forged" } }),
      { status: 401 },
    );

    // Sharing a physical auth store must not admit a key under another Installation.
    const foreignInstallation = `ins_${randomUUID()}`;
    const foreign = await createPostgresControllerAuth({
      ...options,
      installationId: foreignInstallation,
    });
    await assert.rejects(
      foreign.admissionVerifier.verify({
        ...request,
        requestedScope: { installationId: foreignInstallation, namespaceId },
      }),
      { status: 401 },
    );
    assert.equal(await foreign.getServiceKey(key.id), undefined);

    // Deletion cannot be undone by the plugin's concurrent verification updates.
    const inFlight = Array.from({ length: 4 }, () =>
      verifier.admissionVerifier.verify(request).catch((error) => {
        assert.equal(error.status, 401);
      }),
    );
    await issuer.revokeServiceKey(key);
    await Promise.all(inFlight);
    assert.equal(
      (await pool.query("SELECT id FROM occ.apikey WHERE id = $1", [key.id])).rowCount,
      0,
    );
    await assert.rejects(verifier.admissionVerifier.verify(request), { status: 401 });
    assert.equal(await verifier.getServiceKey(key.id), undefined);
  },
);

async function fetchFromInjectedApp(app, request) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host = url.host;
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const result = await app.inject({
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  const convertedHeaders = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) {
        convertedHeaders.append(name, String(entry));
      }
    }
  }
  return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
    status: result.statusCode,
    headers: convertedHeaders,
  });
}

// Real PostgreSQL development composition: Fastify, Better Auth storage, OCC state, and
// the native IAM Driver reading live policy rows. An administrator gives automation (or a
// member's CLI) access to one Namespace without sharing an Installation-wide credential.
test(
  "a Namespace ServicePrincipal created through the policy API carries only its bound access",
  requiresPostgres,
  async (t) => {
    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    const email = "service-principal-admin@openclaw.local";
    const password = "service-principal-development-password";
    const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    let app;
    t.after(async () => {
      await app?.close();
      await observer.end();
    });
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "Namespace ServicePrincipal keys",
    });
    app = await composePostgresDevelopment(config, {
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(app, request),
      email,
      password,
    });
    const admin = (method, url, payload) =>
      app.inject({
        method,
        url,
        headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
        ...(payload === undefined ? {} : { payload }),
      });
    const withKey = (key, method, url, payload) =>
      app.inject({
        method,
        url,
        headers: { host: "127.0.0.1", "x-api-key": key },
        ...(payload === undefined ? {} : { payload }),
      });
    const namespaceIds = [];
    for (const name of [
      `sp-team-${randomUUID().slice(0, 8)}`,
      `sp-other-${randomUUID().slice(0, 8)}`,
    ]) {
      const created = await admin("POST", "/namespaces", { name });
      assert.equal(created.statusCode, 201, created.body);
      namespaceIds.push(created.json().data.id);
    }
    const [teamId, otherId] = namespaceIds;
    const base = `/namespaces/${teamId}/iam/service-principals`;

    const created = await admin("POST", base, {});
    assert.equal(created.statusCode, 201, created.body);
    const principal = created.json().data;
    assert.match(principal.id, /^spn_/);
    assert.deepEqual(principal, { id: principal.id, namespaceId: teamId });
    // The identity row is a non-Agent ServicePrincipal of this Namespace, and its creation
    // is audited in the same transaction.
    assert.deepEqual(
      (
        await observer.query(
          "SELECT kind, namespace_id, agent_id FROM occ.iam_identities WHERE id = $1",
          [principal.id],
        )
      ).rows,
      [{ kind: "service_principal", namespace_id: teamId, agent_id: null }],
    );
    const audit = await observer.query(
      `SELECT outcome, details FROM occ.audit_events
       WHERE action = 'openclaw.iam.service_principals.create'
         AND details->>'servicePrincipalId' = $1`,
      [principal.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].outcome, "success");

    const listed = await admin("GET", base);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().data, [principal]);
    assert.deepEqual((await admin("GET", `${base}/${principal.id}`)).json().data, principal);
    // The principal belongs only to its own Namespace.
    assert.deepEqual(
      (await admin("GET", `/namespaces/${otherId}/iam/service-principals`)).json().data,
      [],
    );
    assert.equal(
      (await admin("GET", `/namespaces/${otherId}/iam/service-principals/${principal.id}`))
        .statusCode,
      404,
    );
    assert.equal((await admin("POST", base, { name: "unsupported" })).statusCode, 400);

    // The key route already issues Namespace keys; it now has a principal to target.
    const issued = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: principal.id,
      namespaceId: teamId,
      name: "member-cli",
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const key = issued.json().data;
    assert.equal(key.namespaceId, teamId);
    // A new principal holds no grant, so its key reads nothing yet.
    assert.equal((await withKey(key.key, "GET", `/namespaces/${teamId}`)).statusCode, 403);

    const role = await admin("POST", `/namespaces/${teamId}/iam/roles`, {
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const binding = await admin("POST", `/namespaces/${teamId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.json().data.id,
      resourceKind: "namespace",
      resourceId: teamId,
    });
    assert.equal(binding.statusCode, 201, binding.body);
    // Current policy decides the next request: the binding takes effect without reissuing.
    const read = await withKey(key.key, "GET", `/namespaces/${teamId}`);
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().data.id, teamId);
    // A mutation by the key is attributed to its principal and names the key that acted.
    const configuration = await admin("POST", `/namespaces/${teamId}/configurations`, {
      kind: "agent",
      values: {},
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const configurationId = configuration.json().data.id;
    const deleter = await admin("POST", `/namespaces/${teamId}/iam/roles`, {
      permissions: [{ action: "delete", resourceKind: "configuration" }],
    });
    assert.equal(deleter.statusCode, 201, deleter.body);
    const deleterBinding = await admin("POST", `/namespaces/${teamId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: deleter.json().data.id,
      resourceKind: "configuration",
      resourceId: configurationId,
    });
    assert.equal(deleterBinding.statusCode, 201, deleterBinding.body);
    const removed = await withKey(
      key.key,
      "DELETE",
      `/namespaces/${teamId}/configurations/${configurationId}`,
    );
    assert.equal(removed.statusCode, 204, removed.body);
    assert.deepEqual(
      (
        await observer.query(
          `SELECT actor_id, details->>'actorServiceKeyId' AS key_id FROM occ.audit_events
           WHERE action = 'openclaw.configurations.delete' AND resource_id = $1`,
          [configurationId],
        )
      ).rows,
      [{ actor_id: principal.id, key_id: key.id }],
    );
    // The documented order (create, bind, then issue) passes the coverage check because the
    // administrator holds every grant now bound to the principal.
    const second = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: principal.id,
      namespaceId: teamId,
      name: "member-cli-2",
    });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(
      (await withKey(second.json().data.key, "GET", `/namespaces/${teamId}`)).statusCode,
      200,
    );
    assert.equal(
      (await admin("DELETE", `/api/auth/service-keys/${second.json().data.id}`)).statusCode,
      200,
    );
    // The principal cannot be bound in another Namespace, and its key is issued only in its
    // own Namespace scope, never Installation-wide or for a sibling.
    const foreignRole = await admin("POST", `/namespaces/${otherId}/iam/roles`, {
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(foreignRole.statusCode, 201, foreignRole.body);
    const foreignBinding = await admin("POST", `/namespaces/${otherId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: foreignRole.json().data.id,
      resourceKind: "namespace",
      resourceId: otherId,
    });
    assert.equal(foreignBinding.statusCode, 400, foreignBinding.body);
    assert.equal(foreignBinding.json().error.details[0].path, "/subjectId");
    for (const scope of [{}, { namespaceId: otherId }]) {
      const misScoped = await admin("POST", "/api/auth/service-keys", {
        servicePrincipalId: principal.id,
        name: "mis-scoped",
        ...scope,
      });
      assert.equal(misScoped.statusCode, 400, misScoped.body);
    }

    // The key cannot reach another Namespace, Installation operations, policy management,
    // or credential issuance, including minting principals or keys for itself.
    for (const [method, url, payload] of [
      ["GET", `/namespaces/${otherId}`],
      ["GET", "/installation"],
      ["POST", base, {}],
      ["GET", base],
      [
        "POST",
        `/namespaces/${teamId}/iam/roles`,
        {
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
      ],
      [
        "POST",
        "/api/auth/service-keys",
        {
          servicePrincipalId: principal.id,
          namespaceId: teamId,
          name: "self-issued",
        },
      ],
    ]) {
      const denied = await withKey(key.key, method, url, payload);
      assert.equal(denied.statusCode, 403, `${method} ${url}: ${denied.body}`);
    }
    assert.equal(
      (await observer.query("SELECT 1 FROM occ.iam_identities WHERE namespace_id = $1", [teamId]))
        .rowCount,
      1,
    );

    // An unknown Namespace gets no principal.
    assert.equal(
      (await admin("POST", `/namespaces/ns_${randomUUID()}/iam/service-principals`, {})).statusCode,
      404,
    );

    const revoked = await admin("DELETE", `/api/auth/service-keys/${key.id}`);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await withKey(key.key, "GET", `/namespaces/${teamId}`)).statusCode, 401);

    // Each of the key's seven refusals above (the read before its binding and the six
    // out-of-scope requests) names the key; issuance and revocation by the session name the
    // key acted on and its name, with no acting key. No row holds the credential.
    const denials = await observer.query(
      `SELECT actor_id FROM occ.audit_events
       WHERE kind = 'authorization_denial' AND details->>'actorServiceKeyId' = $1`,
      [key.id],
    );
    assert.equal(denials.rowCount, 7);
    assert.ok(denials.rows.every((row) => row.actor_id === principal.id));
    const managed = await observer.query(
      `SELECT action, details->>'serviceKeyName' AS name, details ? 'actorServiceKeyId' AS keyed
       FROM occ.audit_events
       WHERE action LIKE 'openclaw.auth.service-keys.%' AND details->>'serviceKeyId' = $1
       ORDER BY occurred_at`,
      [key.id],
    );
    assert.deepEqual(managed.rows, [
      { action: "openclaw.auth.service-keys.create", name: "member-cli", keyed: false },
      { action: "openclaw.auth.service-keys.revoke", name: "member-cli", keyed: false },
    ]);
    assert.equal(
      (
        await observer.query("SELECT 1 FROM occ.audit_events WHERE strpos(details::text, $1) > 0", [
          key.key,
        ])
      ).rowCount,
      0,
    );
  },
);
