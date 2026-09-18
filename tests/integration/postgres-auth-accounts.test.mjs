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

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

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

    const iamBefore = await state.loadNativeIAMState(installation.id);
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
