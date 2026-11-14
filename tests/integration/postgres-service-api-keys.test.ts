import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import {
  betterAuthIssuer,
  type ControllerAuth,
  type PostgresControllerAuthOptions,
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
type ServiceKeyVerification = Awaited<ReturnType<ControllerAuth["admissionVerifier"]["verify"]>>;

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

async function blockedKeyUpdate(
  pool: pg.Pool,
  applicationName: string,
  blockerPid: number,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1
         AND state = 'active' AND wait_event_type = 'Lock'
         AND $2::integer = ANY(pg_blocking_pids(pid))
         AND query LIKE 'update "occ"."apikey"%'`,
      [applicationName, blockerPid],
    );
    if (result.rows.length === 1) {
      return result.rows[0]!.pid;
    }
    await delay(10);
  }
  assert.fail("the real key-use update must wait for its owned deletion transaction");
}

// Storage/admission integration only: the HTTP suite separately proves IAM
// authorization. These server-only operations model an already authorized key
// manager; referenceId can belong to an external IAM Driver, not a local user.
test(
  "PostgreSQL Better Auth keys remain hashed, scoped, and revocable across instances",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    const authApplicationName = `service-key-revocation-${randomUUID()}`;
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: authApplicationName,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    const lockPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    const cleanup: { key?: IssuedServiceKey } = {};
    t.after(async () => {
      try {
        if (cleanup.key) {
          await issuer.revokeServiceKey(cleanup.key);
        }
      } finally {
        await Promise.all([pool.end(), lockPool.end()]);
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

    // Ordinary server-managed revocation removes the credential across instances.
    await issuer.revokeServiceKey(key);
    assert.equal(
      (await pool.query("SELECT id FROM occ.apikey WHERE id = $1", [key.id])).rowCount,
      0,
    );
    await assert.rejects(verifier.admissionVerifier.verify(request), { status: 401 });
    assert.ok(
      (await verifier.getServiceKey(key.id)) === undefined,
      "revoked key must not be readable",
    );

    const racingKey = await issuer.createServiceKey({ principal, name: "revocation-race" });
    cleanup.key = racingKey;
    const racingRequest = {
      ...request,
      requestId: `req_${randomUUID()}`,
      headers: { "x-api-key": racingKey.key },
    };
    const racingControl = await verifier.admissionVerifier.verify(racingRequest);
    assert.ok(racingControl.method === "api_key");
    assert.equal(racingControl.serviceKeyId, racingKey.id);
    assert.equal(racingControl.externalIdentity.subject, principal.id);

    // An uncommitted DELETE leaves the old row visible to the verifier's MVCC
    // read, then holds its real usage UPDATE. Commit only after PostgreSQL proves
    // that UPDATE is waiting on this transaction, so it settles against deletion.
    const deletion = await lockPool.connect();
    let deletionTransactionOpen = false;
    let verificationSettled = false;
    let inFlight: Promise<PromiseSettledResult<ServiceKeyVerification>> | undefined;
    try {
      await deletion.query("BEGIN");
      deletionTransactionOpen = true;
      const blocker = await deletion.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const removed = await deletion.query("DELETE FROM occ.apikey WHERE id = $1", [racingKey.id]);
      assert.equal(removed.rowCount, 1, "the owned transaction must delete the live key");
      inFlight = verifier.admissionVerifier.verify(racingRequest).then(
        (value) => {
          verificationSettled = true;
          return { status: "fulfilled" as const, value };
        },
        (reason: unknown) => {
          verificationSettled = true;
          return { status: "rejected" as const, reason };
        },
      );
      const blockedPid = await blockedKeyUpdate(
        lockPool,
        authApplicationName,
        blocker.rows[0]!.pid,
      );
      assert.notEqual(blockedPid, blocker.rows[0]!.pid);
      assert.equal(verificationSettled, false, "verification must still await its usage update");
      await deletion.query("COMMIT");
      deletionTransactionOpen = false;
    } finally {
      try {
        if (deletionTransactionOpen) {
          await deletion.query("ROLLBACK");
          deletionTransactionOpen = false;
        }
      } finally {
        // Destroy the connection if rollback failed, then drain the verification
        // after releasing its blocker. Both pools have bounded SQL waits.
        deletion.release(deletionTransactionOpen);
        if (inFlight !== undefined) {
          await inFlight;
        }
      }
    }
    assert.ok(inFlight);
    const outcome = await inFlight;
    if (outcome.status === "rejected") {
      assert.equal(record(outcome.reason).status, 401, "stale verification may reject with 401");
    } else {
      assert.ok(outcome.value.method === "api_key");
      assert.equal(outcome.value.serviceKeyId, racingKey.id);
      assert.equal(outcome.value.externalIdentity.subject, principal.id);
      assert.deepEqual(outcome.value.admittedScope, { installationId, namespaceId });
    }
    assert.equal(
      (await pool.query("SELECT id FROM occ.apikey WHERE id = $1", [racingKey.id])).rowCount,
      0,
      "the stale usage update must not restore the deleted key",
    );
    await assert.rejects(verifier.admissionVerifier.verify(racingRequest), { status: 401 });
    assert.equal(await verifier.getServiceKey(racingKey.id), undefined);
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
    const installation = await admin("GET", "/installation");
    assert.equal(installation.statusCode, 200);
    const installationId = id(installation);
    const activeSession = await admin("GET", "/api/auth/session");
    assert.equal(activeSession.statusCode, 200);
    const adminIdentity = await observer.query<Record<string, unknown>>(
      `SELECT id AS principal_id FROM occ.iam_identities
       WHERE kind = 'principal' AND issuer = $1 AND subject = $2`,
      [betterAuthIssuer(installationId), stringField(record(data(activeSession)).user, "id")],
    );
    assert.equal(adminIdentity.rowCount, 1);
    const adminPrincipalId = stringField(adminIdentity.rows[0], "principal_id");
    const servicePrincipalEffects = async (namespaceId: string) => ({
      identities: (
        await observer.query<Record<string, unknown>>(
          `SELECT id FROM occ.iam_identities
           WHERE kind = 'service_principal' AND namespace_id = $1 ORDER BY id`,
          [namespaceId],
        )
      ).rows,
      successAudits: (
        await observer.query<Record<string, unknown>>(
          `SELECT id FROM occ.audit_events
           WHERE action = 'openclaw.iam.service_principals.create'
             AND namespace_id = $1 AND outcome = 'success' ORDER BY id`,
          [namespaceId],
        )
      ).rows,
    });
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
    assert.ok(teamId);
    assert.ok(otherId);
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
    assert.deepEqual(
      (
        await observer.query<Record<string, unknown>>(
          "SELECT id FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
          [principalId],
        )
      ).rows,
      [],
    );
    const audit = await observer.query<Record<string, unknown>>(
      `SELECT actor_id, namespace_id, resource_kind, resource_id, outcome FROM occ.audit_events
       WHERE action = 'openclaw.iam.service_principals.create'
         AND details->>'servicePrincipalId' = $1`,
      [principalId],
    );
    assert.deepEqual(audit.rows, [
      {
        actor_id: adminPrincipalId,
        namespace_id: teamId,
        resource_kind: "namespace",
        resource_id: teamId,
        outcome: "success",
      },
    ]);

    // A genuine Agent owns another ServicePrincipal in the same Namespace. Ordinary
    // policy discovery must exclude that workload identity, even when its ID is known.
    const agentConfiguration = await admin("POST", `/namespaces/${teamId}/configurations`, {
      kind: "agent",
      values: {},
    });
    assert.equal(agentConfiguration.statusCode, 201);
    const agent = await admin("POST", `/namespaces/${teamId}/agents`, {
      name: `sp-agent-${randomUUID().slice(0, 8)}`,
      configurationId: id(agentConfiguration),
    });
    assert.equal(agent.statusCode, 201);
    const agentPrincipalId = stringField(data(agent), "servicePrincipalId");
    assert.deepEqual(
      (
        await observer.query<Record<string, unknown>>(
          "SELECT kind, namespace_id, agent_id FROM occ.iam_identities WHERE id = $1",
          [agentPrincipalId],
        )
      ).rows,
      [{ kind: "service_principal", namespace_id: teamId, agent_id: id(agent) }],
    );

    const listed = await admin("GET", base);
    assert.equal(listed.statusCode, 200);
    assert.ok(
      isDeepStrictEqual(data(listed), [principal]),
      "listing must contain the created principal",
    );
    const found = await admin("GET", `${base}/${principalId}`);
    assert.equal(found.statusCode, 200);
    assert.ok(
      isDeepStrictEqual(data(found), principal),
      "lookup must return the created principal",
    );
    const agentPrincipal = await admin("GET", `${base}/${agentPrincipalId}`);
    assert.equal(agentPrincipal.statusCode, 404);
    // The principal belongs only to its own Namespace.
    const siblingList = await admin("GET", `/namespaces/${otherId}/iam/service-principals`);
    assert.equal(siblingList.statusCode, 200);
    assert.ok(
      isDeepStrictEqual(data(siblingList), []),
      "sibling namespace must have no principals",
    );
    assert.equal(
      (await admin("GET", `/namespaces/${otherId}/iam/service-principals/${principalId}`))
        .statusCode,
      404,
    );
    assert.equal((await admin("POST", base, { name: "unsupported" })).statusCode, 400);

    // Seed an Installation-scoped automation identity with only administer on the
    // Installation and read on the sibling Namespace. A real key must not turn the
    // Installation grant into read access to every Namespace.
    const policyAdminId = `spn_${randomUUID()}`;
    const policyAdminRoleId = `role_${randomUUID()}`;
    await observer.query(
      "INSERT INTO occ.iam_identities (id, kind) VALUES ($1, 'service_principal')",
      [policyAdminId],
    );
    await observer.query("INSERT INTO occ.iam_roles (id, permissions) VALUES ($1, $2::jsonb)", [
      policyAdminRoleId,
      JSON.stringify([
        { action: "administer", resourceKind: "installation" },
        { action: "read", resourceKind: "namespace" },
      ]),
    ]);
    await observer.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, NULL, $3, $4, 'installation', $5), ($2, $6, $3, $4, 'namespace', $6)`,
      [
        `binding_${randomUUID()}`,
        `binding_${randomUUID()}`,
        policyAdminId,
        policyAdminRoleId,
        installationId,
        otherId,
      ],
    );
    const policyAdminKey = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: policyAdminId,
      name: "namespace-policy-administrator",
    });
    assert.equal(policyAdminKey.statusCode, 201);
    const policyKeyId = id(policyAdminKey);
    const policyKey = stringField(data(policyAdminKey), "key");
    const effectsBeforePolicyDenials = await servicePrincipalEffects(teamId);
    for (const [method, url, payload] of [
      ["GET", base],
      ["GET", `${base}/${principalId}`],
      ["POST", base, {}],
    ] satisfies Array<[string, string, unknown?]>) {
      const denied = await withKey(policyKey, method, url, payload);
      assert.equal(denied.statusCode, 403, `${method} ${url}`);
      assert.equal(stringField(record(parseJson(denied.body)).error, "code"), "FORBIDDEN");
    }
    assert.deepEqual(await servicePrincipalEffects(teamId), effectsBeforePolicyDenials);
    const policyDenials = await observer.query<Record<string, unknown>>(
      `SELECT actor_id, action, namespace_id, resource_kind, resource_id, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events
       WHERE kind = 'authorization_denial' AND details->>'actorServiceKeyId' = $1
       ORDER BY action`,
      [policyKeyId],
    );
    assert.deepEqual(
      policyDenials.rows,
      ["create", "list", "read"].map((operation) => ({
        actor_id: policyAdminId,
        action: `openclaw.iam.service_principals.${operation}`,
        namespace_id: teamId,
        resource_kind: "namespace",
        resource_id: teamId,
        outcome: "denied",
        authorization: {
          principalId: policyAdminId,
          action: "read",
          resource: { kind: "namespace", id: teamId, namespaceId: teamId },
        },
      })),
    );

    // The same grants and key permit all three operations in the readable Namespace.
    const otherBase = `/namespaces/${otherId}/iam/service-principals`;
    const otherPrincipal = await withKey(policyKey, "POST", otherBase, {});
    assert.equal(otherPrincipal.statusCode, 201);
    const otherPrincipalData = data(otherPrincipal);
    const otherPrincipals = await withKey(policyKey, "GET", otherBase);
    assert.equal(otherPrincipals.statusCode, 200);
    assert.deepEqual(data(otherPrincipals), [otherPrincipalData]);
    const otherPrincipalRead = await withKey(
      policyKey,
      "GET",
      `${otherBase}/${id(otherPrincipal)}`,
    );
    assert.equal(otherPrincipalRead.statusCode, 200);
    assert.deepEqual(data(otherPrincipalRead), otherPrincipalData);
    assert.equal((await admin("DELETE", `/api/auth/service-keys/${policyKeyId}`)).statusCode, 200);

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
    // The audit permission in this mixed Role applies only to human readers. The administrator
    // needs the ordinary Agent read grant to issue or revoke the key for this ServicePrincipal.
    const agentReader = await admin("POST", `/namespaces/${teamId}/iam/roles`, {
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "read_audit", resourceKind: "agent" },
      ],
    });
    assert.equal(agentReader.statusCode, 201);
    const agentReaderBinding = await admin("POST", `/namespaces/${teamId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principalId,
      roleId: id(agentReader),
      resourceKind: "agent",
      resourceId: id(agent),
    });
    assert.equal(agentReaderBinding.statusCode, 201);
    const second = await admin("POST", "/api/auth/service-keys", {
      servicePrincipalId: principalId,
      namespaceId: teamId,
      name: "member-cli-2",
    });
    assert.equal(second.statusCode, 201, second.body);
    const secondKey = issuedKey(second);
    assert.equal((await withKey(secondKey.key, "GET", `/namespaces/${teamId}`)).statusCode, 200);
    const agentPath = `/namespaces/${teamId}/agents/${id(agent)}`;
    assert.equal((await withKey(secondKey.key, "GET", agentPath)).statusCode, 200);
    assert.equal(
      (await withKey(secondKey.key, "GET", `${agentPath}/audit-events`)).statusCode,
      401,
    );
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
    const effectsBeforeKeyDenials = await servicePrincipalEffects(teamId);
    for (const [method, url, payload] of [
      ["GET", `/namespaces/${otherId}`],
      ["GET", "/installation"],
      ["POST", base, {}],
      ["GET", base],
      ["GET", `${base}/${principalId}`],
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
    assert.deepEqual(await servicePrincipalEffects(teamId), effectsBeforeKeyDenials);
    assert.deepEqual(
      (
        await observer.query<Record<string, unknown>>(
          `SELECT actor_id, namespace_id, resource_kind, resource_id, outcome,
                  details->'__occAuditMetadata'->'authorization' AS authorization
           FROM occ.audit_events
           WHERE kind = 'authorization_denial'
             AND action = 'openclaw.iam.service_principals.read'
             AND details->>'actorServiceKeyId' = $1`,
          [key.id],
        )
      ).rows,
      [
        {
          actor_id: principalId,
          namespace_id: teamId,
          resource_kind: "namespace",
          resource_id: teamId,
          outcome: "denied",
          authorization: {
            principalId,
            action: "administer",
            resource: { kind: "installation", id: installationId },
          },
        },
      ],
    );

    // An unknown Namespace gets no principal.
    assert.equal(
      (await admin("POST", `/namespaces/ns_${randomUUID()}/iam/service-principals`, {})).statusCode,
      404,
    );

    const revoked = await admin("DELETE", `/api/auth/service-keys/${key.id}`);
    assert.equal(revoked.statusCode, 200);
    assert.equal((await withKey(key.key, "GET", `/namespaces/${teamId}`)).statusCode, 401);

    // Each of the key's eight refusals above (the read before its binding and the seven
    // out-of-scope requests) names the key; issuance and revocation by the session name the
    // key acted on and its name, with no acting key. No row holds the credential.
    const denials = await observer.query<Record<string, unknown>>(
      `SELECT actor_id FROM occ.audit_events
       WHERE kind = 'authorization_denial' AND details->>'actorServiceKeyId' = $1`,
      [key.id],
    );
    assert.equal(denials.rowCount, 8);
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
