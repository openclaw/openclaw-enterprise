import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readPrivateBootstrapOutput } from "../helpers/bootstrap-output.ts";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import {
  first,
  record,
  recordData,
  response,
  text,
  type InjectedResponse,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { accountProvisioning } from "./postgres-auth-account-provisioning-cases.ts";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { injectJson as injectJsonRequest } from "../helpers/inject-json.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authBaseURL = "https://console.oce.localhost";

type App = Awaited<ReturnType<typeof composePostgresDevelopment>>;

async function injectJson(
  app: App,
  method: string,
  url: string,
  options: Parameters<typeof injectJsonRequest>[3] = {},
): Promise<InjectedResponse> {
  const result = response(
    await injectJsonRequest(app, method, url, { host: "console.oce.localhost", ...options }),
  );
  return {
    statusCode: result.statusCode,
    headers: result.headers,
    body: result.body,
    json: () => parseJson(result.body),
  };
}

function assertApiError(
  result: InjectedResponse,
  status: number,
  code: string,
  label = "API error response",
): void {
  assert.equal(result.statusCode, status, label);
  assert.ok(text(record(record(result.json()).error).code) === code, label);
}

async function signIn(app: App, credentials: { email: string; password: string }) {
  let status: string | undefined;
  try {
    return await signInToControllerApp(app, credentials);
  } catch (error: unknown) {
    status = error instanceof Error ? /HTTP (\d{3})/.exec(error.message)?.[1] : undefined;
  }
  throw new Error(
    status === undefined
      ? "Controller sign-in failed"
      : `Controller sign-in failed with HTTP ${status}`,
  );
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw new Error("Expected valid JSON");
  }
}

function installationPrincipal(state: NativeIAMState) {
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

test(
  "fresh PostgreSQL development bootstrap writes a usable administrator service key",
  requiresPostgres,
  async (context) => {
    assert.ok(databaseUrl, "PostgreSQL test database URL is required");
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    let app: App | undefined;
    context.after(async () => {
      if (app !== undefined) {
        await app.close();
      }
      await observerPool.end();
    });
    // Registered after the hook above, so it is removed after the app closes.
    const outputDirectory = await temporaryDirectory(
      context,
      "openclaw-development-bootstrap-key-",
    );

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
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    let rejectedStartup = false;
    try {
      app = await composePostgresDevelopment(config, {
        computeDriver: createDevelopmentComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
      });
    } catch (error: unknown) {
      rejectedStartup =
        error instanceof Error &&
        /must be bootstrapped before development startup/.test(error.message);
    }
    assert.ok(rejectedStartup, "development startup must require an existing Installation");
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "rejected development startup must not create an Installation",
    );
    const rejectedStartupAuthRows = await observerPool.query<Record<string, unknown>>(`
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

    const output = record(parseJson(await readPrivateBootstrapOutput(bootstrapServiceKeyFile)));
    const outputMeta = record(output.meta);
    const outputData = record(output.data);
    const outputId = text(outputData.id);
    const outputKey = text(outputData.key);
    assert.ok(outputMeta.installationId === installation.id, "bootstrap Installation must match");
    assert.ok(
      outputData.servicePrincipalId === servicePrincipal.id,
      "bootstrap Principal must match",
    );
    assert.ok(outputData.name === "bootstrap-admin", "bootstrap key name must match");
    assert.ok(
      outputKey.startsWith("occ_") && outputKey.length > "occ_".length && !/[^!-~]/.test(outputKey),
      "invalid bootstrap service-key format",
    );
    const stored = await observerPool.query<Record<string, unknown>>(
      "SELECT key, reference_id, metadata FROM occ.apikey WHERE id = $1",
      [outputId],
    );
    assert.equal(stored.rowCount, 1);
    assert.ok(
      text(first(stored.rows).key) !== outputKey,
      "stored key must differ from the issued key",
    );
    assert.equal(first(stored.rows).reference_id, servicePrincipal.id);
    const metadata = record(parseJson(text(first(stored.rows).metadata)));
    assert.ok(Object.keys(metadata).length === 1 && metadata.installationId === installation.id);

    const authorized = await injectJson(app, "GET", "/installation", { key: outputKey });
    assert.equal(authorized.statusCode, 200);
    assert.ok(
      recordData(parseJson(authorized.body)).id === installation.id,
      "bootstrap key must authorize the installed Installation",
    );
    const defaultNamespace = await observerPool.query<Record<string, unknown>>(
      `SELECT namespace.id, namespace.name, namespace.status, work.idempotency_key
       FROM occ.namespaces AS namespace
       JOIN occ.controller_work AS work ON work.namespace_id = namespace.id
       WHERE namespace.name = $1`,
      [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
    );
    assert.equal(defaultNamespace.rows.length, 1);
    const namespaceId = text(first(defaultNamespace.rows).id);
    assert.match(namespaceId, /^ns_/);
    assert.equal(first(defaultNamespace.rows).name, BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
    assert.equal(first(defaultNamespace.rows).status, "provisioning");
    assert.equal(
      first(defaultNamespace.rows).idempotency_key,
      `namespace:${namespaceId}:reconcile:ready`,
    );

    const session = await signIn(app, {
      email: adminEmail,
      password: adminPassword,
    });
    const humanAuthorized = await injectJson(app, "GET", "/installation", { session });
    assert.equal(humanAuthorized.statusCode, 200);
  },
);

test(
  "PostgreSQL auth account provisioning is visible to another controller without rebuilding IAM Driver",
  requiresPostgres,
  (context) =>
    accountProvisioning(context, {
      adminEmail,
      adminPassword,
      authBaseURL,
      assertApiError,
      injectJson,
      installationPrincipal,
      signIn,
    }),
);

test(
  "PostgreSQL auth account audit failure rolls back IAM and Better Auth account state",
  requiresPostgres,
  async (context) => {
    const auditId = `aud_${randomUUID()}`;
    assert.ok(databaseUrl, "PostgreSQL test database URL is required");
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const resources: { app?: App } = {};
    context.after(async () => {
      await resources.app?.close();
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
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
    const app = await composePostgresDevelopment(config, {
      auditEventFactory: new AuditEventFactory({ idGenerator: () => auditId }),
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });

    resources.app = app;
    const session = await signIn(app, {
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
    await observerPool.query<Record<string, unknown>>(
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
    const response = await injectJson(app, "POST", "/api/auth/accounts", {
      session,
      body: { email, password, name: "Postgres Audit Rollback", roleId: role.id },
    });
    assertApiError(response, 503, "DEPENDENCY_UNAVAILABLE");

    await assert.rejects(signIn(app, { email, password }), /HTTP 401/);
    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length);
    assert.deepEqual(
      iamAfter.identities.map(({ id }) => id).sort(),
      iamBefore.identities.map(({ id }) => id).sort(),
    );
    const persistedUser = await observerPool.query<Record<string, unknown>>(
      `SELECT id FROM occ."user" WHERE email = $1`,
      [email],
    );
    assert.deepEqual(persistedUser.rows, []);
    const duplicateAuditRows = await observerPool.query<Record<string, unknown>>(
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
    assert.ok(databaseUrl, "PostgreSQL test database URL is required");
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const apps: App[] = [];
    const resources: { proxy?: Awaited<ReturnType<typeof commitAckProxy>> } = {};
    context.after(async () => {
      for (const app of apps.reverse()) {
        await app.close();
      }
      await resources.proxy?.close();
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
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
    const proxy = await commitAckProxy(databaseUrl);
    resources.proxy = proxy;
    const faulted = await composePostgresDevelopment(
      { ...config, databaseUrl: proxy.url },
      drivers(),
    );
    apps.push(faulted);
    await faulted.ready();

    const session = await signIn(ordinary, {
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
      const { rows } = await observerPool.query<Record<string, unknown>>(
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
    const unknown = await injectJson(faulted, "POST", "/api/auth/accounts", {
      session,
      body: payload,
    });
    assert.equal(proxy.observedCommit, true);
    assertApiError(unknown, 503, "DEPENDENCY_UNAVAILABLE");
    assert.ok(/outcome is unknown/i.test(text(record(record(unknown.json()).error).message)));

    // Nothing was compensated: the login and its Principal committed together.
    const committed = await persisted();
    assert.equal(committed.length, 1);
    assert.ok(first(committed).principal_id);
    assert.deepEqual(
      {
        passwords: first(committed).passwords,
        principals: first(committed).principals,
        bindings: first(committed).bindings,
        audits: first(committed).audits,
      },
      { passwords: 1, principals: 1, bindings: 1, audits: 1 },
    );
    const provisionedSession = await signIn(ordinary, { email, password });
    const authorized = await injectJson(ordinary, "GET", "/installation", {
      session: provisionedSession,
    });
    assert.equal(authorized.statusCode, 200);

    // A deliberate retry of the same request converges on the committed account:
    // the email conflicts and no second login, Principal or audit event appears.
    const retry = await injectJson(ordinary, "POST", "/api/auth/accounts", {
      session,
      body: payload,
    });
    assertApiError(retry, 409, "RESOURCE_CONFLICT");
    assert.deepEqual(await persisted(), committed);
    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length + 1);
  },
);

test(
  "password-only logout waits for persisted revocation before clearing the session",
  requiresPostgres,
  async (context) => {
    assert.ok(databaseUrl, "PostgreSQL test database URL is required");
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const blocker = await observerPool.connect();
    const resources: { app?: App } = {};
    context.after(async () => {
      await blocker.query<Record<string, unknown>>("ROLLBACK");
      blocker.release();
      await resources.app?.close();
      await observerPool.end();
    });
    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminEmail,
      password: adminPassword,
      authSecret: config.authSecret,
      authBaseURL: config.authBaseURL,
      installationName: "PostgreSQL password logout",
    });
    const boundedDatabase = new URL(databaseUrl);
    boundedDatabase.searchParams.set("options", "-c lock_timeout=100ms");
    const app = await composePostgresDevelopment(
      { ...config, databaseUrl: boundedDatabase.toString() },
      {
        computeDriver: createDevelopmentComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
      },
    );
    resources.app = app;
    const session = await signIn(app, {
      email: adminEmail,
      password: adminPassword,
    });

    // The real database still permits session reads, but cannot complete deletion
    // while another transaction holds its row. No authentication adapter is replaced.
    await blocker.query<Record<string, unknown>>("BEGIN");
    const locked = await blocker.query<Record<string, unknown>>(
      `SELECT s.id FROM occ.session s JOIN occ."user" u ON u.id = s.user_id
       WHERE u.email = $1 FOR UPDATE OF s`,
      [adminEmail],
    );
    assert.ok((locked.rowCount ?? 0) > 0);
    const refused = await injectJson(app, "POST", "/api/auth/sign-out", { session });
    assertApiError(refused, 503, "DEPENDENCY_UNAVAILABLE");
    assert.ok(refused.headers["set-cookie"] === undefined, "failed logout must retain the session");
    const retained = await injectJson(app, "GET", "/installation", { session });
    assert.equal(retained.statusCode, 200);

    // A deliberate retry after storage recovers revokes the persisted session.
    await blocker.query<Record<string, unknown>>("ROLLBACK");
    const completed = await injectJson(app, "POST", "/api/auth/sign-out", { session });
    assert.equal(completed.statusCode, 200);
    assert.ok(completed.headers["set-cookie"]);
    const revoked = await injectJson(app, "GET", "/installation", { session });
    assertApiError(revoked, 401, "UNAUTHENTICATED");
  },
);
