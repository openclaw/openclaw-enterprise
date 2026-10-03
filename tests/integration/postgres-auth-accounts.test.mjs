import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";

function installationPrincipal(state) {
  const administratorRoles = new Set(
    state.roles
      .filter(({ permissions }) =>
        [
          ["administer", "installation"],
          ["create", "namespace"],
          ["deploy", "agent"],
        ].every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
        ),
      )
      .map(({ id }) => id),
  );
  return state.identities.find(
    (identity) =>
      identity.kind === "principal" &&
      state.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === identity.id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          administratorRoles.has(binding.roleId),
      ),
  );
}

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
    if (Array.isArray(value)) {
      for (const entry of value) {
        convertedHeaders.append(name, entry);
      }
    } else if (value !== undefined) {
      convertedHeaders.set(name, String(value));
    }
  }
  return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
    status: result.statusCode,
    headers: convertedHeaders,
  });
}

test(
  "fresh PostgreSQL development bootstrap writes a usable administrator service key",
  requiresPostgres,
  async (context) => {
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const outputDirectory = await mkdtemp(join(tmpdir(), "openclaw-development-bootstrap-key-"));
    let app;
    context.after(async () => {
      if (app !== undefined) {
        await app.close();
      }
      await observerPool.end();
      await rm(outputDirectory, { recursive: true, force: true });
    });

    const state = new PostgresPlatformState(observerPool);
    if ((await state.loadInstallation()) !== undefined) {
      context.skip(
        "The PostgreSQL development bootstrap service-key proof requires a fresh database.",
      );
      return;
    }

    const bootstrapServiceKeyFile = join(outputDirectory, "initial-admin-service-key.json");
    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    await assert.rejects(
      composePostgresDevelopment(config, {
        computeDriver: createDevelopmentComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
      }),
      /must be bootstrapped before development startup/,
    );
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "rejected development startup must not create an Installation",
    );
    const rejectedStartupAuthRows = await observerPool.query(`
      SELECT
        (SELECT count(*)::integer FROM occ."user") AS users,
        (SELECT count(*)::integer FROM occ.account) AS accounts,
        (SELECT count(*)::integer FROM occ.session) AS sessions,
        (SELECT count(*)::integer FROM occ.apikey) AS api_keys
    `);
    assert.deepEqual(rejectedStartupAuthRows.rows[0], {
      users: 0,
      accounts: 0,
      sessions: 0,
      api_keys: 0,
    });
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      directory: outputDirectory,
      email: adminEmail,
      password: adminPassword,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "PostgreSQL development bootstrap service key",
      serviceKeyFile: "initial-admin-service-key.json",
    });
    app = await composePostgresDevelopment(config, {
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });

    const installation = await state.loadInstallation();
    assert.ok(installation, "automatic development bootstrap must commit an Installation");
    const iam = await state.loadNativeIAMState(installation.id);
    const human = installationPrincipal(iam);
    assert.ok(human, "automatic development bootstrap must retain a human administrator");
    const servicePrincipal = iam.identities.find(
      (identity) =>
        identity.kind === "service_principal" &&
        identity.namespaceId === undefined &&
        identity.agentId === undefined,
    );
    assert.ok(
      servicePrincipal,
      "automatic development bootstrap must create a service administrator",
    );
    const humanBinding = iam.bindings.find(
      (binding) => binding.subjectKind === "identity" && binding.subjectId === human.id,
    );
    const serviceBinding = iam.bindings.find(
      (binding) => binding.subjectKind === "identity" && binding.subjectId === servicePrincipal.id,
    );
    assert.ok(humanBinding);
    assert.ok(serviceBinding);
    assert.equal(serviceBinding.roleId, humanBinding.roleId);
    assert.equal(serviceBinding.namespaceId, undefined);
    assert.equal(serviceBinding.resourceKind, undefined);

    const outputStatus = await stat(bootstrapServiceKeyFile);
    assert.equal(outputStatus.mode & 0o777, 0o600);
    const output = JSON.parse(await readFile(bootstrapServiceKeyFile, "utf8"));
    assert.equal(output.meta.installationId, installation.id);
    assert.equal(output.data.servicePrincipalId, servicePrincipal.id);
    assert.equal(output.data.name, "bootstrap-admin");
    assert.match(output.data.key, /^occ_/);
    const stored = await observerPool.query(
      "SELECT key, reference_id, metadata FROM occ.apikey WHERE id = $1",
      [output.data.id],
    );
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].key, output.data.key);
    assert.equal(stored.rows[0].reference_id, servicePrincipal.id);
    assert.deepEqual(JSON.parse(stored.rows[0].metadata), { installationId: installation.id });

    const authorized = await app.inject({
      method: "GET",
      url: "/installation",
      headers: { "x-api-key": output.data.key, host: "127.0.0.1" },
    });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().data.id, installation.id);
    const defaultNamespace = await observerPool.query(
      `SELECT namespace.id, namespace.name, namespace.status, work.idempotency_key
       FROM occ.namespaces AS namespace
       JOIN occ.controller_work AS work ON work.namespace_id = namespace.id
       WHERE namespace.name = $1`,
      [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
    );
    assert.equal(defaultNamespace.rows.length, 1);
    assert.match(defaultNamespace.rows[0].id, /^ns_/);
    assert.equal(defaultNamespace.rows[0].name, BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
    assert.equal(defaultNamespace.rows[0].status, "provisioning");
    assert.equal(
      defaultNamespace.rows[0].idempotency_key,
      `namespace:${defaultNamespace.rows[0].id}:reconcile:ready`,
    );

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(app, request),
      email: adminEmail,
      password: adminPassword,
    });
    const humanAuthorized = await app.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
    });
    assert.equal(humanAuthorized.statusCode, 200, humanAuthorized.body);
  },
);

test(
  "PostgreSQL auth account provisioning is visible to another controller without rebuilding IAM Driver",
  requiresPostgres,
  async (context) => {
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    let appA;
    let appB;
    context.after(async () => {
      if (appB !== undefined) {
        await appB.close();
      }
      if (appA !== undefined) {
        await appA.close();
      }
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminEmail,
      password: adminPassword,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "PostgreSQL account provisioning",
    });
    appA = await composePostgresDevelopment(config, {
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(appA, request),
      email: adminEmail,
      password: adminPassword,
    });
    const state = new PostgresPlatformState(observerPool);
    const installation = await state.loadInstallation();
    assert.ok(installation, "development bootstrap subprocess must initialize the Installation");

    // Controller B starts before the account exists. Its selected IAM Driver must observe
    // the later rows through live policy reads, not through a replacement from controller A.
    appB = await composePostgresDevelopment(config, {
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });

    const iamBeforeNoGrant = await state.loadNativeIAMState(installation.id);
    const adminNamespaces = await appA.inject({
      method: "GET",
      url: "/namespaces",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
    });
    assert.equal(adminNamespaces.statusCode, 200, adminNamespaces.body);
    const deniedNamespaceId = adminNamespaces.json().data[0].id;
    const noGrantAuditBefore = await observerPool.query(
      `SELECT id FROM occ.audit_events WHERE action = 'openclaw.auth.accounts.create'`,
    );
    const noGrantEmail = `postgres-no-grant-${randomUUID()}@example.com`;
    const noGrantPassword = `generated-password-${randomUUID()}`;
    const noGrant = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email: noGrantEmail, password: noGrantPassword, name: "Postgres No Grant" },
    });
    assert.equal(noGrant.statusCode, 201, noGrant.body);
    const noGrantSession = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(appB, request),
      email: noGrantEmail,
      password: noGrantPassword,
    });
    const noGrantInstallation = await appB.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(noGrantSession, { host: "127.0.0.1" }),
    });
    assert.equal(noGrantInstallation.statusCode, 403, noGrantInstallation.body);
    // The zero-grant create is audited exactly once as an administrator mutation.
    const noGrantAudit = await observerPool.query(
      `SELECT id, kind, actor_id, resource_kind, resource_id, outcome, details
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create' AND NOT (id = ANY($1::text[]))`,
      [noGrantAuditBefore.rows.map(({ id }) => id)],
    );
    assert.equal(noGrantAudit.rows.length, 1);
    assert.equal(noGrantAudit.rows[0].details.principalId, noGrant.json().data.principalId);
    assert.equal(noGrantAudit.rows[0].details.grant, "none");
    assert.equal(noGrantAudit.rows[0].details.roleId, undefined);
    assert.ok(!JSON.stringify(noGrantAudit.rows[0].details).includes(noGrantEmail));
    assert.ok(!JSON.stringify(noGrantAudit.rows[0].details).includes(noGrantPassword));
    assert.deepEqual(
      {
        kind: noGrantAudit.rows[0].kind,
        actorId: noGrantAudit.rows[0].actor_id,
        resourceKind: noGrantAudit.rows[0].resource_kind,
        resourceId: noGrantAudit.rows[0].resource_id,
        outcome: noGrantAudit.rows[0].outcome,
      },
      {
        kind: "mutation",
        actorId: installationPrincipal(iamBeforeNoGrant).id,
        resourceKind: "installation",
        resourceId: installation.id,
        outcome: "success",
      },
    );
    // Before any grant the human sees an empty Namespace list and is denied everywhere else.
    const noGrantNamespaces = await appB.inject({
      method: "GET",
      url: "/namespaces",
      headers: authenticatedHeaders(noGrantSession, { host: "127.0.0.1" }),
    });
    assert.equal(noGrantNamespaces.statusCode, 200, noGrantNamespaces.body);
    assert.deepEqual(noGrantNamespaces.json().data, []);
    for (const [method, url, payload] of [
      ["POST", "/namespaces", { name: "postgres-zero-grant-namespace" }],
      ["GET", `/namespaces/${deniedNamespaceId}`],
      ["DELETE", `/namespaces/${deniedNamespaceId}`],
      ["GET", `/namespaces/${deniedNamespaceId}/agents`],
      ["GET", `/namespaces/${deniedNamespaceId}/iam/roles`],
      [
        "POST",
        `/namespaces/${deniedNamespaceId}/iam/roles`,
        { permissions: [{ action: "read", resourceKind: "namespace" }] },
      ],
      [
        "POST",
        "/api/auth/accounts",
        {
          email: `postgres-zero-grant-escalation-${randomUUID()}@example.com`,
          password: `generated-password-${randomUUID()}`,
          name: "Postgres Zero Grant Escalation",
        },
      ],
    ]) {
      const denied = await appB.inject({
        method,
        url,
        headers: authenticatedHeaders(noGrantSession, { host: "127.0.0.1" }),
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(denied.statusCode, 403, `${method} ${url}: ${denied.body}`);
      assert.equal(denied.json().error.code, "FORBIDDEN");
    }
    const iamBefore = await state.loadNativeIAMState(installation.id);
    assert.equal(iamBefore.identities.length, iamBeforeNoGrant.identities.length + 1);
    assert.equal(iamBefore.bindings.length, iamBeforeNoGrant.bindings.length);
    assert.ok(iamBefore.identities.some(({ id }) => id === noGrant.json().data.principalId));

    const role = iamBefore.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    assert.ok(role, "the persisted Installation must have an account-bindable Role");

    const email = `postgres-account-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const beforeAudit = await observerPool.query(
      `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
    );

    const created = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Postgres Provisioned Operator", roleId: role.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdAccount = created.json().data;
    const principalId = createdAccount.principalId;

    // Server-side provisioning must not silently sign in the newly created operator.
    const accountSessions = await observerPool.query(
      "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
      [createdAccount.id],
    );
    assert.equal(accountSessions.rows[0].count, 0);

    // A duplicate email is a conflict, never a synthetic identity or hidden active session.
    const duplicate = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Duplicate Operator", roleId: role.id },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const iamAfterDuplicate = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfterDuplicate.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfterDuplicate.bindings.length, iamBefore.bindings.length + 1);
    const sessionsAfterDuplicate = await observerPool.query(
      "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
      [createdAccount.id],
    );
    assert.equal(sessionsAfterDuplicate.rows[0].count, 0);

    const provisionedSession = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(appB, request),
      email,
      password,
    });
    const authorized = await appB.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(provisionedSession, { host: "127.0.0.1" }),
    });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().data.id, installation.id);

    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length + 1);
    assert.ok(iamAfter.identities.some(({ id }) => id === principalId));
    assert.ok(
      iamAfter.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === principalId &&
          binding.roleId === role.id &&
          binding.resourceKind === "installation" &&
          binding.resourceId === installation.id,
      ),
    );
    const persistedUser = await observerPool.query(
      `SELECT id, email FROM occ."user" WHERE email = $1`,
      [email],
    );
    assert.deepEqual(persistedUser.rows, [{ id: createdAccount.id, email }]);
    const afterAudit = await observerPool.query(
      `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
    );
    assert.equal(afterAudit.rows[0].count, beforeAudit.rows[0].count + 1);
    const createdAudit = await observerPool.query(
      `SELECT details FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create' AND details->>'principalId' = $1`,
      [created.json().data.principalId],
    );
    assert.equal(createdAudit.rows.length, 1);
    assert.equal(createdAudit.rows[0].details.roleId, role.id);
    assert.equal(createdAudit.rows[0].details.grant, undefined);
    assert.ok(!JSON.stringify(createdAudit.rows[0].details).includes(email));

    // Grant the existing human exact Namespace access through the public policy API.
    // The second controller must observe it without gaining Installation or sibling access.
    const namespaces = await appA.inject({
      method: "GET",
      url: "/namespaces",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
    });
    assert.equal(namespaces.statusCode, 200, namespaces.body);
    const namespaceId = namespaces.json().data[0].id;
    const namespaceRole = await appA.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/iam/roles`,
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { permissions: [{ action: "read", resourceKind: "namespace" }] },
    });
    assert.equal(namespaceRole.statusCode, 201, namespaceRole.body);
    // A Namespace-scoped Role cannot back an account's Installation binding: 400, no writes.
    const namespaceRoleEmail = `postgres-namespace-role-${randomUUID()}@example.com`;
    const auditBeforeNamespaceRole = await observerPool.query(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
    );
    const namespaceRoleAccount = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: {
        email: namespaceRoleEmail,
        password: `generated-password-${randomUUID()}`,
        roleId: namespaceRole.json().data.id,
      },
    });
    assert.equal(namespaceRoleAccount.statusCode, 400, namespaceRoleAccount.body);
    assert.equal(namespaceRoleAccount.json().error.code, "INVALID_REQUEST");
    assert.deepEqual(
      (await observerPool.query(`SELECT id FROM occ."user" WHERE email = $1`, [namespaceRoleEmail]))
        .rows,
      [],
    );
    assert.deepEqual(
      (
        await observerPool.query(
          `SELECT count(*)::integer AS count FROM occ.audit_events
           WHERE action = 'openclaw.auth.accounts.create'`,
        )
      ).rows,
      auditBeforeNamespaceRole.rows,
    );
    const binding = await appA.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/iam/access-bindings`,
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: {
        subjectKind: "identity",
        subjectId: noGrant.json().data.principalId,
        roleId: namespaceRole.json().data.id,
        resourceKind: "namespace",
        resourceId: namespaceId,
      },
    });
    assert.equal(binding.statusCode, 201, binding.body);
    const visibleNamespaces = await appB.inject({
      method: "GET",
      url: "/namespaces",
      headers: authenticatedHeaders(noGrantSession, { host: "127.0.0.1" }),
    });
    assert.equal(visibleNamespaces.statusCode, 200, visibleNamespaces.body);
    assert.deepEqual(
      visibleNamespaces.json().data.map(({ id }) => id),
      [namespaceId],
    );
    const stillDenied = await appB.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(noGrantSession, { host: "127.0.0.1" }),
    });
    assert.equal(stillDenied.statusCode, 403, stillDenied.body);
  },
);

test(
  "PostgreSQL auth account audit failure rolls back IAM and Better Auth account state",
  requiresPostgres,
  async (context) => {
    const auditId = `aud_${randomUUID()}`;
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    let app;
    context.after(async () => {
      if (app !== undefined) {
        await app.close();
      }
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminEmail,
      password: adminPassword,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "PostgreSQL account audit rollback",
    });
    app = await composePostgresDevelopment(config, {
      auditEventFactory: new AuditEventFactory({ idGenerator: () => auditId }),
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(app, request),
      email: adminEmail,
      password: adminPassword,
    });
    const state = new PostgresPlatformState(observerPool);
    const installation = await state.loadInstallation();
    assert.ok(installation, "development bootstrap subprocess must initialize the Installation");

    const iamBefore = await state.loadNativeIAMState(installation.id);
    const role = iamBefore.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    assert.ok(role, "the persisted Installation must have an account-bindable Role");
    const actor = installationPrincipal(iamBefore);
    assert.ok(actor, "the persisted Installation requires an administrator Principal");
    await observerPool.query(
      `INSERT INTO occ.audit_events
       (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
        outcome, details)
       VALUES ($1, now(), 'mutation', $2, 'test.account.audit.duplicate', NULL,
        'installation', $3, 'success', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [auditId, actor.id, installation.id],
    );

    const email = `postgres-audit-rollback-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Postgres Audit Rollback", roleId: role.id },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");

    await assert.rejects(
      signInWithEmailPassword({
        fetch: (request) => fetchFromInjectedApp(app, request),
        email,
        password,
      }),
      /HTTP 401/,
    );
    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length);
    assert.deepEqual(
      iamAfter.identities.map(({ id }) => id).sort(),
      iamBefore.identities.map(({ id }) => id).sort(),
    );
    const persistedUser = await observerPool.query(`SELECT id FROM occ."user" WHERE email = $1`, [
      email,
    ]);
    assert.deepEqual(persistedUser.rows, []);
    const duplicateAuditRows = await observerPool.query(
      `SELECT id FROM occ.audit_events WHERE id = $1`,
      [auditId],
    );
    assert.equal(duplicateAuditRows.rowCount, 1);
  },
);

test(
  "PostgreSQL auth account create with a lost COMMIT reply keeps the whole account and converges on retry",
  requiresPostgres,
  async (context) => {
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const apps = [];
    let proxy;
    context.after(async () => {
      for (const app of apps.reverse()) {
        await app.close();
      }
      await proxy?.close();
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminEmail,
      password: adminPassword,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "PostgreSQL account unknown commit",
    });
    const drivers = () => ({
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    const ordinary = await composePostgresDevelopment(config, drivers());
    apps.push(ordinary);
    proxy = await commitAckProxy(databaseUrl);
    const faulted = await composePostgresDevelopment(
      { ...config, databaseUrl: proxy.url },
      drivers(),
    );
    apps.push(faulted);
    await faulted.ready();

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(ordinary, request),
      email: adminEmail,
      password: adminPassword,
    });
    const state = new PostgresPlatformState(observerPool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const iamBefore = await state.loadNativeIAMState(installation.id);
    const role = iamBefore.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    assert.ok(role, "the persisted Installation must have an account-bindable Role");

    const email = `postgres-unknown-commit-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const payload = { email, password, name: "Postgres Unknown Commit", roleId: role.id };
    async function persisted() {
      const { rows } = await observerPool.query(
        `SELECT u.id AS user_id, h.principal_id,
           (SELECT count(*)::int FROM occ.account a
             WHERE a.user_id = u.id AND a.provider_id = 'credential') AS passwords,
           (SELECT count(*)::int FROM occ.iam_identities i WHERE i.id = h.principal_id) AS principals,
           (SELECT count(*)::int FROM occ.iam_access_bindings b
             WHERE b.identity_subject_id = h.principal_id) AS bindings,
           (SELECT count(*)::int FROM occ.audit_events e
             WHERE e.action = 'openclaw.auth.accounts.create'
               AND e.details->>'principalId' = h.principal_id) AS audits
         FROM occ."user" u
         LEFT JOIN occ.human_authentication_accounts h ON h.user_id = u.id
         WHERE u.email = $1`,
        [email],
      );
      return rows;
    }

    // The request's three earlier read transactions commit first. Drop the reply to
    // the provisioning COMMIT, after PostgreSQL has committed the account, Principal,
    // binding and audit.
    proxy.arm({ skipCommits: 3 });
    const unknown = await faulted.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload,
    });
    assert.equal(proxy.observedCommit, true);
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.match(unknown.json().error.message, /outcome is unknown/i);

    // Nothing was compensated: the login and its Principal committed together.
    const committed = await persisted();
    assert.equal(committed.length, 1);
    assert.ok(committed[0].principal_id);
    assert.deepEqual(
      {
        passwords: committed[0].passwords,
        principals: committed[0].principals,
        bindings: committed[0].bindings,
        audits: committed[0].audits,
      },
      { passwords: 1, principals: 1, bindings: 1, audits: 1 },
    );
    const provisionedSession = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(ordinary, request),
      email,
      password,
    });
    const authorized = await ordinary.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(provisionedSession, { host: "127.0.0.1" }),
    });
    assert.equal(authorized.statusCode, 200, authorized.body);

    // A deliberate retry of the same request converges on the committed account:
    // the email conflicts and no second login, Principal or audit event appears.
    const retry = await ordinary.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload,
    });
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(retry.json().error.code, "RESOURCE_CONFLICT");
    assert.deepEqual(await persisted(), committed);
    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length + 1);
  },
);
