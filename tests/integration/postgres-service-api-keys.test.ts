import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import type {
  ControllerAuth,
  PostgresControllerAuthOptions,
} from "../../apps/controller/src/auth/index.ts";
import type {
  composePostgresDevelopment as composePostgresDevelopmentApp,
  PostgresDevelopmentConfig,
} from "../../apps/controller/src/composition/development-postgres.ts";
import {
  composePostgresDevelopment,
  createPostgresControllerAuth,
} from "../helpers/password-hasher.mjs";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { injectJson } from "../helpers/inject-json.mjs";
import {
  record,
  response,
  text,
  type InjectedResponse,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

type DevelopmentApp = Awaited<ReturnType<typeof composePostgresDevelopmentApp>>;
type IssuedServiceKey = Awaited<ReturnType<ControllerAuth["createServiceKey"]>>;

function stringField(value: unknown, field: string): string {
  return text(record(value)[field]);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("expected valid JSON");
  }
}

function data(response: InjectedResponse): unknown {
  return record(parseJson(response.body)).data;
}

function id(response: InjectedResponse): string {
  return stringField(data(response), "id");
}

function issuedKey(response: InjectedResponse): { id: string; key: string; namespaceId: string } {
  const value = data(response);
  return {
    id: stringField(value, "id"),
    key: stringField(value, "key"),
    namespaceId: stringField(value, "namespaceId"),
  };
}

// Storage/admission integration only: the HTTP suite separately proves IAM
// authorization. These server-only operations model an already authorized key
// manager; referenceId can belong to an external IAM Driver, not a local user.
test(
  "PostgreSQL Better Auth keys remain hashed, scoped, and revocable across instances",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const cleanup: { key?: IssuedServiceKey } = {};
    t.after(async () => {
      try {
        if (cleanup.key) {
          await issuer.revokeServiceKey(cleanup.key);
        }
      } finally {
        await pool.end();
      }
    });
    const installationId = `ins_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    const options: PostgresControllerAuthOptions = {
      pool,
      installationId,
      mode: "development",
      baseURL: "https://console.oce.localhost",
      agentDomain: "agents.oce.localhost",
      secret: `storage-test-${randomUUID()}`,
    };
    const issuer = await createPostgresControllerAuth(options);
    const verifier = await createPostgresControllerAuth(options);
    const principal: Parameters<ControllerAuth["createServiceKey"]>[0]["principal"] = {
      kind: "service_principal",
      id: `external-automation-${randomUUID()}`,
      namespaceId,
    };
    const key = await issuer.createServiceKey({ principal, name: "storage-proof" });
    cleanup.key = key;
    const stored = await pool.query<Record<string, unknown>>(
      "SELECT key, reference_id, metadata FROM occ.apikey WHERE id = $1",
      [key.id],
    );
    assert.equal(stored.rowCount, 1);
    const storedRow = stored.rows[0];
    assert.ok(
      stringField(storedRow, "key") !== key.key,
      "stored key must differ from the issued credential",
    );
    assert.equal(stringField(storedRow, "reference_id"), principal.id);
    assert.ok(
      isDeepStrictEqual(parseJson(stringField(storedRow, "metadata")), {
        installationId,
        namespaceId,
      }),
      "stored key metadata must match its scope",
    );
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
    assert.equal((await verifier.getServiceKey(key.id))?.id, key.id);
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
    assert.ok(
      (await foreign.getServiceKey(key.id)) === undefined,
      "foreign installation must not read the key",
    );

    // Deletion cannot be undone by the plugin's concurrent verification updates.
    const inFlight = Array.from({ length: 4 }, () =>
      verifier.admissionVerifier.verify(request).catch((error: unknown) => {
        assert.ok(record(error).status === 401, "concurrent verification must reject with 401");
      }),
    );
    await issuer.revokeServiceKey(key);
    await Promise.all(inFlight);
    assert.equal(
      (await pool.query("SELECT id FROM occ.apikey WHERE id = $1", [key.id])).rowCount,
      0,
    );
    await assert.rejects(verifier.admissionVerifier.verify(request), { status: 401 });
    assert.ok(
      (await verifier.getServiceKey(key.id)) === undefined,
      "revoked key must not be readable",
    );
  },
);

// Real PostgreSQL development composition: Fastify, Better Auth storage, OCC state, and
// the native IAM Driver reading live policy rows. An administrator gives automation (or a
// member's CLI) access to one Namespace without sharing an Installation-wide credential.
test(
  "a Namespace ServicePrincipal created through the policy API carries only its bound access",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl, "PostgreSQL database URL is required");
    const config: PostgresDevelopmentConfig = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "https://console.oce.localhost",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    };
    const email = "service-principal-admin@openclaw.local";
    const password = "service-principal-development-password";
    const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const cleanup: { app?: DevelopmentApp } = {};
    t.after(async () => {
      await cleanup.app?.close();
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
    const app: DevelopmentApp = await composePostgresDevelopment(config, {
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    cleanup.app = app;
    const session = await signInToControllerApp(app, { email, password });
    const host = new URL(config.authBaseURL).host;
    const admin = async (method: string, url: string, body?: unknown): Promise<InjectedResponse> =>
      response(await injectJson(app, method, url, { session, body, host }));
    const withKey = async (
      key: string,
      method: string,
      url: string,
      body?: unknown,
    ): Promise<InjectedResponse> =>
      response(await injectJson(app, method, url, { key, body, host }));
    const namespaceIds = [];
    for (const name of [
      `sp-team-${randomUUID().slice(0, 8)}`,
      `sp-other-${randomUUID().slice(0, 8)}`,
    ]) {
      const created = await admin("POST", "/namespaces", { name });
      assert.equal(created.statusCode, 201);
      namespaceIds.push(id(created));
    }
    const [teamId, otherId] = namespaceIds;
    const base = `/namespaces/${teamId}/iam/service-principals`;

    const created = await admin("POST", base, {});
    assert.equal(created.statusCode, 201);
    const principal = record(data(created));
    const principalId = stringField(principal, "id");
    assert.match(principalId, /^spn_/);
    assert.ok(
      isDeepStrictEqual(principal, { id: principalId, namespaceId: teamId }),
      "principal must contain only its identifier and namespace",
    );
    // The identity row is a non-Agent ServicePrincipal of this Namespace, and its creation
    // is audited in the same transaction.
    assert.deepEqual(
      (
        await observer.query<Record<string, unknown>>(
          "SELECT kind, namespace_id, agent_id FROM occ.iam_identities WHERE id = $1",
          [principalId],
        )
      ).rows,
      [{ kind: "service_principal", namespace_id: teamId, agent_id: null }],
    );
    const audit = await observer.query<Record<string, unknown>>(
      `SELECT outcome, details FROM occ.audit_events
       WHERE action = 'openclaw.iam.service_principals.create'
         AND details->>'servicePrincipalId' = $1`,
      [principalId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(stringField(audit.rows[0], "outcome"), "success");

    const listed = await admin("GET", base);
    assert.equal(listed.statusCode, 200);
    assert.ok(
      isDeepStrictEqual(data(listed), [principal]),
      "listing must contain the created principal",
    );
    assert.ok(
      isDeepStrictEqual(data(await admin("GET", `${base}/${principalId}`)), principal),
      "lookup must return the created principal",
    );
    // The principal belongs only to its own Namespace.
    assert.ok(
      isDeepStrictEqual(
        data(await admin("GET", `/namespaces/${otherId}/iam/service-principals`)),
        [],
      ),
      "sibling namespace must have no principals",
    );
    assert.equal(
      (await admin("GET", `/namespaces/${otherId}/iam/service-principals/${principalId}`))
        .statusCode,
      404,
    );
    assert.equal((await admin("POST", base, { name: "unsupported" })).statusCode, 400);

    // The key route already issues Namespace keys; it now has a principal to target.
    const issued = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: principalId,
      namespaceId: teamId,
      name: "member-cli",
    });
    assert.equal(issued.statusCode, 201);
    const key = issuedKey(issued);
    assert.equal(key.namespaceId, teamId);
    // A new principal holds no grant, so its key reads nothing yet.
    assert.equal((await withKey(key.key, "GET", `/namespaces/${teamId}`)).statusCode, 403);

    const role = await admin("POST", `/namespaces/${teamId}/iam/roles`, {
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(role.statusCode, 201);
    const binding = await admin("POST", `/namespaces/${teamId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principalId,
      roleId: id(role),
      resourceKind: "namespace",
      resourceId: teamId,
    });
    assert.equal(binding.statusCode, 201);
    // Current policy decides the next request: the binding takes effect without reissuing.
    const read = await withKey(key.key, "GET", `/namespaces/${teamId}`);
    assert.equal(read.statusCode, 200);
    assert.equal(id(read), teamId);
    // A mutation by the key is attributed to its principal and names the key that acted.
    const configuration = await admin("POST", `/namespaces/${teamId}/configurations`, {
      kind: "agent",
      values: {},
    });
    assert.equal(configuration.statusCode, 201);
    const configurationId = id(configuration);
    const deleter = await admin("POST", `/namespaces/${teamId}/iam/roles`, {
      permissions: [{ action: "delete", resourceKind: "configuration" }],
    });
    assert.equal(deleter.statusCode, 201);
    const deleterBinding = await admin("POST", `/namespaces/${teamId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principalId,
      roleId: id(deleter),
      resourceKind: "configuration",
      resourceId: configurationId,
    });
    assert.equal(deleterBinding.statusCode, 201);
    const removed = await withKey(
      key.key,
      "DELETE",
      `/namespaces/${teamId}/configurations/${configurationId}`,
    );
    assert.equal(removed.statusCode, 204);
    assert.deepEqual(
      (
        await observer.query<Record<string, unknown>>(
          `SELECT actor_id, details->>'actorServiceKeyId' AS key_id FROM occ.audit_events
           WHERE action = 'openclaw.configurations.delete' AND resource_id = $1`,
          [configurationId],
        )
      ).rows,
      [{ actor_id: principalId, key_id: key.id }],
    );
    // The documented order (create, bind, then issue) passes the coverage check because the
    // administrator holds every grant now bound to the principal.
    const second = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: principalId,
      namespaceId: teamId,
      name: "member-cli-2",
    });
    assert.equal(second.statusCode, 201);
    const secondKey = issuedKey(second);
    assert.equal((await withKey(secondKey.key, "GET", `/namespaces/${teamId}`)).statusCode, 200);
    assert.equal((await admin("DELETE", `/api/auth/service-keys/${secondKey.id}`)).statusCode, 200);
    // The principal cannot be bound in another Namespace, and its key is issued only in its
    // own Namespace scope, never Installation-wide or for a sibling.
    const foreignRole = await admin("POST", `/namespaces/${otherId}/iam/roles`, {
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(foreignRole.statusCode, 201);
    const foreignBinding = await admin("POST", `/namespaces/${otherId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principalId,
      roleId: id(foreignRole),
      resourceKind: "namespace",
      resourceId: otherId,
    });
    assert.equal(foreignBinding.statusCode, 400);
    const details = record(record(parseJson(foreignBinding.body)).error).details;
    assert.ok(Array.isArray(details), "expected error details");
    assert.equal(stringField(details[0] as unknown, "path"), "/subjectId");
    for (const scope of [{}, { namespaceId: otherId }]) {
      const misScoped = await admin("POST", "/api/auth/service-keys", {
        servicePrincipalId: principalId,
        name: "mis-scoped",
        ...scope,
      });
      assert.equal(misScoped.statusCode, 400);
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
          servicePrincipalId: principalId,
          namespaceId: teamId,
          name: "self-issued",
        },
      ],
    ] satisfies Array<[string, string, unknown?]>) {
      const denied = await withKey(key.key, method, url, payload);
      assert.equal(denied.statusCode, 403, `${method} ${url}`);
    }
    assert.equal(
      (
        await observer.query<Record<string, unknown>>(
          "SELECT 1 FROM occ.iam_identities WHERE namespace_id = $1",
          [teamId],
        )
      ).rowCount,
      1,
    );

    // An unknown Namespace gets no principal.
    assert.equal(
      (await admin("POST", `/namespaces/ns_${randomUUID()}/iam/service-principals`, {})).statusCode,
      404,
    );

    const revoked = await admin("DELETE", `/api/auth/service-keys/${key.id}`);
    assert.equal(revoked.statusCode, 200);
    assert.equal((await withKey(key.key, "GET", `/namespaces/${teamId}`)).statusCode, 401);

    // Each of the key's seven refusals above (the read before its binding and the six
    // out-of-scope requests) names the key; issuance and revocation by the session name the
    // key acted on and its name, with no acting key. No row holds the credential.
    const denials = await observer.query<Record<string, unknown>>(
      `SELECT actor_id FROM occ.audit_events
       WHERE kind = 'authorization_denial' AND details->>'actorServiceKeyId' = $1`,
      [key.id],
    );
    assert.equal(denials.rowCount, 7);
    assert.ok(denials.rows.every((row) => stringField(row, "actor_id") === principalId));
    const managed = await observer.query<Record<string, unknown>>(
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
        await observer.query<Record<string, unknown>>(
          "SELECT 1 FROM occ.audit_events WHERE strpos(details::text, $1) > 0",
          [key.key],
        )
      ).rowCount,
      0,
    );
  },
);
