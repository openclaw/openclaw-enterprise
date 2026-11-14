import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import {
  first,
  integer,
  record,
  recordData,
  text,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import type { signInToControllerApp } from "../helpers/auth-session.mjs";
import type { injectJson as injectJsonRequest } from "../helpers/inject-json.mjs";
import type { InjectedResponse } from "../helpers/postgres-sign-in-test-boundaries.ts";

type App = Awaited<ReturnType<typeof composePostgresDevelopment>>;
type AccountFixture = {
  adminEmail: string;
  adminPassword: string;
  authBaseURL: string;
  assertApiError: (result: InjectedResponse, status: number, code: string, label?: string) => void;
  injectJson: (
    app: App,
    method: string,
    url: string,
    options?: Parameters<typeof injectJsonRequest>[3],
  ) => Promise<InjectedResponse>;
  installationPrincipal: (
    state: NativeIAMState,
  ) => NativeIAMState["identities"][number] | undefined;
  signIn: (
    app: App,
    credentials: { email: string; password: string },
  ) => ReturnType<typeof signInToControllerApp>;
};

function namespaceIds(value: unknown): string[] {
  const data = record(value).data;
  assert.ok(Array.isArray(data));
  const entries: unknown[] = data;
  return entries.map((entry) => text(record(entry).id));
}

export async function accountProvisioning(
  context: TestContext,
  fixture: AccountFixture,
): Promise<void> {
  const {
    adminEmail,
    adminPassword,
    authBaseURL,
    assertApiError,
    injectJson,
    installationPrincipal,
    signIn,
  } = fixture;
  assert.ok(databaseUrl, "PostgreSQL test database URL is required");
  const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const apps: App[] = [];
  context.after(async () => {
    for (const app of apps.reverse()) {
      await app.close();
    }
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
    installationName: "PostgreSQL account provisioning",
  });
  const appA = await composePostgresDevelopment(config, {
    computeDriver: createDevelopmentComputeDriver(),
    configurationDriver: createTestConfigurationDriver(),
  });

  apps.push(appA);
  const session = await signIn(appA, {
    email: adminEmail,
    password: adminPassword,
  });
  const state = new PostgresPlatformState(observerPool);
  const installation = await state.loadInstallation();
  assert.ok(installation, "development bootstrap subprocess must initialize the Installation");

  // Controller B starts before the account exists. Its selected IAM Driver must observe
  // the later rows through live policy reads, not through a replacement from controller A.
  const appB = await composePostgresDevelopment(config, {
    computeDriver: createDevelopmentComputeDriver(),
    configurationDriver: createTestConfigurationDriver(),
  });

  apps.push(appB);
  const iamBeforeNoGrant = await state.loadNativeIAMState(installation.id);
  const adminNamespaces = await injectJson(appA, "GET", "/namespaces", { session });
  assert.equal(adminNamespaces.statusCode, 200);
  const deniedNamespaceId = namespaceIds(adminNamespaces.json())[0];
  assert.ok(deniedNamespaceId);
  const noGrantAuditBefore = await observerPool.query<Record<string, unknown>>(
    `SELECT id FROM occ.audit_events WHERE action = 'openclaw.auth.accounts.create'`,
  );
  const noGrantEmail = `postgres-no-grant-${randomUUID()}@example.com`;
  const noGrantPassword = `generated-password-${randomUUID()}`;
  const noGrant = await injectJson(appA, "POST", "/api/auth/accounts", {
    session,
    body: { email: noGrantEmail, password: noGrantPassword, name: "Postgres No Grant" },
  });
  assert.equal(noGrant.statusCode, 201);
  const noGrantPrincipalId = text(recordData(noGrant.json()).principalId);
  const noGrantSession = await signIn(appB, {
    email: noGrantEmail,
    password: noGrantPassword,
  });
  const noGrantInstallation = await injectJson(appB, "GET", "/installation", {
    session: noGrantSession,
  });
  assert.equal(noGrantInstallation.statusCode, 403);
  // The zero-grant create is audited exactly once as an administrator mutation.
  const noGrantAudit = await observerPool.query<Record<string, unknown>>(
    `SELECT id, kind, actor_id, resource_kind, resource_id, outcome, details
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create' AND NOT (id = ANY($1::text[]))`,
    [noGrantAuditBefore.rows.map(({ id }) => text(id))],
  );
  assert.equal(noGrantAudit.rows.length, 1);
  const noGrantDetails = record(first(noGrantAudit.rows).details);
  assert.ok(noGrantDetails.principalId === noGrantPrincipalId);
  assert.equal(noGrantDetails.grant, "none");
  assert.equal(noGrantDetails.roleId, undefined);
  assert.ok(!JSON.stringify(noGrantDetails).includes(noGrantEmail));
  assert.ok(!JSON.stringify(noGrantDetails).includes(noGrantPassword));
  const administrator = installationPrincipal(iamBeforeNoGrant);
  assert.ok(administrator);
  assert.deepEqual(
    {
      kind: first(noGrantAudit.rows).kind,
      actorId: first(noGrantAudit.rows).actor_id,
      resourceKind: first(noGrantAudit.rows).resource_kind,
      resourceId: first(noGrantAudit.rows).resource_id,
      outcome: first(noGrantAudit.rows).outcome,
    },
    {
      kind: "mutation",
      actorId: administrator.id,
      resourceKind: "installation",
      resourceId: installation.id,
      outcome: "success",
    },
  );
  // Before any grant the human sees an empty Namespace list and is denied everywhere else.
  const noGrantNamespaces = await injectJson(appB, "GET", "/namespaces", {
    session: noGrantSession,
  });
  assert.equal(noGrantNamespaces.statusCode, 200);
  assert.equal(namespaceIds(noGrantNamespaces.json()).length, 0);
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
  ] as const) {
    const denied = await injectJson(appB, method, url, {
      session: noGrantSession,
      body: payload,
    });
    assertApiError(denied, 403, "FORBIDDEN", `${method} ${url}`);
  }
  const iamBefore = await state.loadNativeIAMState(installation.id);
  assert.equal(iamBefore.identities.length, iamBeforeNoGrant.identities.length + 1);
  assert.equal(iamBefore.bindings.length, iamBeforeNoGrant.bindings.length);
  assert.ok(iamBefore.identities.some(({ id }) => id === noGrantPrincipalId));

  const role = iamBefore.roles.find((candidate) =>
    candidate.permissions.some(
      (permission) => permission.action === "read" && permission.resourceKind === "installation",
    ),
  );
  assert.ok(role, "the persisted Installation must have an account-bindable Role");

  const email = `postgres-account-${randomUUID()}@example.com`;
  const password = `generated-password-${randomUUID()}`;
  const beforeAudit = await observerPool.query<Record<string, unknown>>(
    `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
  );

  const created = await injectJson(appA, "POST", "/api/auth/accounts", {
    session,
    body: { email, password, name: "Postgres Provisioned Operator", roleId: role.id },
  });
  assert.equal(created.statusCode, 201);
  const createdAccount = recordData(created.json());
  const createdAccountId = text(createdAccount.id);
  const principalId = text(createdAccount.principalId);

  // Server-side provisioning must not silently sign in the newly created operator.
  const accountSessions = await observerPool.query<Record<string, unknown>>(
    "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
    [createdAccountId],
  );
  assert.equal(integer(first(accountSessions.rows).count), 0);

  // A duplicate email is a conflict, never a synthetic identity or hidden active session.
  const duplicate = await injectJson(appA, "POST", "/api/auth/accounts", {
    session,
    body: { email, password, name: "Duplicate Operator", roleId: role.id },
  });
  assert.equal(duplicate.statusCode, 409);
  const iamAfterDuplicate = await state.loadNativeIAMState(installation.id);
  assert.equal(iamAfterDuplicate.identities.length, iamBefore.identities.length + 1);
  assert.equal(iamAfterDuplicate.bindings.length, iamBefore.bindings.length + 1);
  const sessionsAfterDuplicate = await observerPool.query<Record<string, unknown>>(
    "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
    [createdAccountId],
  );
  assert.equal(integer(first(sessionsAfterDuplicate.rows).count), 0);

  const provisionedSession = await signIn(appB, { email, password });
  const authorized = await injectJson(appB, "GET", "/installation", {
    session: provisionedSession,
  });
  assert.equal(authorized.statusCode, 200);
  assert.ok(recordData(authorized.json()).id === installation.id);

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
  const persistedUser = await observerPool.query<Record<string, unknown>>(
    `SELECT id, email FROM occ."user" WHERE email = $1`,
    [email],
  );
  assert.equal(persistedUser.rows.length, 1);
  assert.ok(first(persistedUser.rows).id === createdAccountId);
  assert.ok(first(persistedUser.rows).email === email, "persisted account email must match");
  const afterAudit = await observerPool.query<Record<string, unknown>>(
    `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
  );
  assert.equal(integer(first(afterAudit.rows).count), integer(first(beforeAudit.rows).count) + 1);
  const createdAudit = await observerPool.query<Record<string, unknown>>(
    `SELECT details FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create' AND details->>'principalId' = $1`,
    [principalId],
  );
  assert.equal(createdAudit.rows.length, 1);
  const createdAuditDetails = record(first(createdAudit.rows).details);
  assert.equal(createdAuditDetails.roleId, role.id);
  assert.equal(createdAuditDetails.grant, undefined);
  assert.ok(!JSON.stringify(createdAuditDetails).includes(email));

  // Grant the existing human exact Namespace access through the public policy API.
  // The second controller must observe it without gaining Installation or sibling access.
  const namespaces = await injectJson(appA, "GET", "/namespaces", { session });
  assert.equal(namespaces.statusCode, 200);
  const namespaceId = namespaceIds(namespaces.json())[0];
  assert.ok(namespaceId);
  const namespaceRole = await injectJson(appA, "POST", `/namespaces/${namespaceId}/iam/roles`, {
    session,
    body: { permissions: [{ action: "read", resourceKind: "namespace" }] },
  });
  assert.equal(namespaceRole.statusCode, 201);
  const namespaceRoleId = text(recordData(namespaceRole.json()).id);
  // A Namespace-scoped Role cannot back an account's Installation binding: 400, no writes.
  const namespaceRoleEmail = `postgres-namespace-role-${randomUUID()}@example.com`;
  const auditBeforeNamespaceRole = await observerPool.query<Record<string, unknown>>(
    `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
  );
  const namespaceRoleAccount = await injectJson(appA, "POST", "/api/auth/accounts", {
    session,
    body: {
      email: namespaceRoleEmail,
      password: `generated-password-${randomUUID()}`,
      roleId: namespaceRoleId,
    },
  });
  assertApiError(namespaceRoleAccount, 400, "INVALID_REQUEST");
  assert.deepEqual(
    (
      await observerPool.query<Record<string, unknown>>(
        `SELECT id FROM occ."user" WHERE email = $1`,
        [namespaceRoleEmail],
      )
    ).rows,
    [],
  );
  assert.deepEqual(
    (
      await observerPool.query<Record<string, unknown>>(
        `SELECT count(*)::integer AS count FROM occ.audit_events
           WHERE action = 'openclaw.auth.accounts.create'`,
      )
    ).rows,
    auditBeforeNamespaceRole.rows,
  );
  const binding = await injectJson(appA, "POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    session,
    body: {
      subjectKind: "identity",
      subjectId: noGrantPrincipalId,
      roleId: namespaceRoleId,
      resourceKind: "namespace",
      resourceId: namespaceId,
    },
  });
  assert.equal(binding.statusCode, 201);
  const visibleNamespaces = await injectJson(appB, "GET", "/namespaces", {
    session: noGrantSession,
  });
  assert.equal(visibleNamespaces.statusCode, 200);
  const visibleNamespaceIds = namespaceIds(visibleNamespaces.json());
  assert.ok(visibleNamespaceIds.length === 1 && visibleNamespaceIds[0] === namespaceId);
  const stillDenied = await injectJson(appB, "GET", "/installation", { session: noGrantSession });
  assert.equal(stillDenied.statusCode, 403);

  await context.test("account creation throttles hashing without writing an account", async () => {
    // Controller B has a fresh per-administrator budget. Duplicate requests still hash
    // passwords, so they must consume it even though their transactions cannot create users.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const duplicate = await injectJson(appB, "POST", "/api/auth/accounts", {
        session,
        body: { email, password },
      });
      assertApiError(duplicate, 409, "RESOURCE_CONFLICT");
    }
    const limitedEmail = `limited-${randomUUID()}@example.test`;
    const limited = await injectJson(appB, "POST", "/api/auth/accounts", {
      session,
      body: { email: limitedEmail, password },
    });
    assertApiError(limited, 429, "RATE_LIMITED");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.deepEqual(
      (
        await observerPool.query<Record<string, unknown>>(
          'SELECT id FROM occ."user" WHERE email=$1',
          [limitedEmail],
        )
      ).rows,
      [],
    );
    // A caller cannot reset the budget by signing in again under the same Principal.
    const nextSession = await signIn(appB, {
      email: adminEmail,
      password: adminPassword,
    });
    const stillLimited = await injectJson(appB, "POST", "/api/auth/accounts", {
      session: nextSession,
      body: { email: limitedEmail, password },
    });
    assertApiError(stillLimited, 429, "RATE_LIMITED");
  });
}
