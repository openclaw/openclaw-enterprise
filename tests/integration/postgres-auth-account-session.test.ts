import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import {
  betterAuthIssuer,
  createPostgresAuthAccountProvisioner,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { sessionBindingKey } from "../../apps/controller/src/auth/session-binding.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

const origin = "https://console.oce.localhost";
const runtimeImage =
  "openclaw-enterprise-runtime@sha256:0bac3ab63d046fa98aa9bf7d638795b136bf98a0a77114fd5e809e9f36654f52";
type App = Awaited<ReturnType<typeof composePostgresDevelopment>>;
type Session = { cookie: string; origin?: string };
type Account = { email: string; password: string; name: string; roleId?: string };

async function waitFor<T>(name: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

test(
  "PostgreSQL account creation retains assigning authority through COMMIT",
  { ...requiresPostgres, timeout: 180_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-account-authority-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pool = testPool(t, { connectionString: databaseUrl, max: 6 }) as Pool;
    // The normal lane must exercise application privileges, never the migration owner.
    const databaseRole = await pool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
       has_schema_privilege(current_user, 'occ', 'CREATE') AS can_create_objects
       FROM pg_roles WHERE rolname=current_user`,
    );
    assert.deepEqual(databaseRole.rows, [
      {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        can_create_objects: false,
      },
    ]);
    const authSecret = `account-authority-${randomUUID()}-${randomUUID()}`;
    const administrator = {
      email: `account-authority-${randomUUID()}@example.test`,
      password: `account-authority-password-${randomUUID()}`,
    };
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      directory,
      ...administrator,
      authSecret,
      authBaseURL: origin,
      installationName: "account-authority",
      inProcess: true,
      environment: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    const installationId = (await pool.query("SELECT id FROM occ.installation")).rows[0]
      .id as string;
    const issuer = betterAuthIssuer(installationId);
    const administratorRow = (
      await pool.query(
        `SELECT u.id AS user_id, p.id AS principal_id, b.role_id
         FROM occ."user" u JOIN occ.iam_identities p ON p.issuer=$1 AND p.subject=u.id
         JOIN occ.iam_access_bindings b ON b.identity_subject_id=p.id
         JOIN occ.iam_roles r ON r.id=b.role_id
         WHERE u.email=$2 AND r.namespace_id IS NULL AND r.id LIKE 'role_admin_%'`,
        [issuer, administrator.email],
      )
    ).rows;
    assert.equal(administratorRow.length, 1);
    const admin = administratorRow[0] as {
      user_id: string;
      principal_id: string;
      role_id: string;
    };
    const apps = new Set<App>();
    t.after(async () => {
      await Promise.all([...apps].map((app) => app.close()));
    });
    async function appFor(profile: "password" | "guarded", url = databaseUrl!): Promise<App> {
      const app = await composePostgresDevelopment(
        {
          mode: "development",
          host: "127.0.0.1",
          databaseUrl: url,
          authSecret,
          authBaseURL: origin,
          nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
          ...(profile === "password"
            ? {}
            : {
                google: {
                  clientId: "account-authority-fixture",
                  clientSecret: "account-authority-fixture-secret",
                  allowedDomains: [],
                  recoveryUserId: admin.user_id,
                },
              }),
        },
        {
          computeDriver: new DockerComputeDriver({
            images: { gateway: runtimeImage, agent: runtimeImage },
          }),
          configurationDriver: new FilesystemConfigurationDriver(join(directory, "configuration")),
        },
      );
      apps.add(app);
      await app.ready();
      return app;
    }
    async function closeApp(app: App): Promise<void> {
      await app.close();
      apps.delete(app);
    }
    const send = (
      app: App,
      method: "GET" | "POST",
      url: string,
      session: Session,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method,
        url,
        remoteAddress: "127.0.0.1",
        headers: { ...authenticatedHeaders(session), host: new URL(origin).host, origin },
        ...(payload === undefined ? {} : { payload }),
      });
    const signIn = (app: App, credentials = administrator) =>
      signInToControllerApp(app, credentials, { origin });
    const fresh = (label: string, roleId: string | undefined = admin.role_id): Account => ({
      email: `${label}-${randomUUID()}@example.test`,
      password: `account-password-${randomUUID()}`,
      name: label,
      ...(roleId === undefined ? {} : { roleId }),
    });
    const create = (app: App, session: Session, account: Account) =>
      send(app, "POST", "/api/auth/accounts", session, account);
    async function exactSession(app: App, session: Session) {
      const response = await send(app, "GET", "/api/auth/session", session);
      assert.equal(response.statusCode, 200, response.body);
      const data = response.json().data;
      assert.equal(data.authenticated, true);
      const rows = (await pool.query("SELECT id FROM occ.session WHERE user_id=$1", [data.user.id]))
        .rows;
      const exact = rows.filter((row) => sessionBindingKey(authSecret, row.id) === data.sessionKey);
      assert.equal(exact.length, 1);
      return { id: exact[0].id as string, userId: data.user.id as string };
    }
    async function persisted(email: string) {
      return (
        await pool.query(
          `SELECT u.id AS user_id, h.principal_id, h.installation_id, h.disabled,
           p.kind AS principal_kind, p.issuer, p.subject,
           (SELECT count(*)::int FROM occ.account a WHERE a.user_id=u.id AND a.provider_id='credential'
             AND a.password IS NOT NULL AND a.password <> '' AND a.password NOT LIKE 'test-sha256:%') AS password_methods,
           (SELECT count(*)::int FROM occ.iam_access_bindings b WHERE b.identity_subject_id=h.principal_id) AS bindings,
           (SELECT count(*)::int FROM occ.iam_access_bindings b WHERE b.identity_subject_id=h.principal_id
             AND b.role_id=$2 AND b.resource_kind='installation' AND b.resource_id=$3) AS admin_bindings,
           (SELECT count(*)::int FROM occ.iam_group_memberships m WHERE m.principal_id=h.principal_id) AS memberships,
           (SELECT count(*)::int FROM occ.audit_events e WHERE e.kind='mutation' AND e.outcome='success'
             AND e.actor_id=$4 AND e.details->>'principalId'=h.principal_id) AS success_audits
           FROM occ."user" u LEFT JOIN occ.human_authentication_accounts h ON h.user_id=u.id
           LEFT JOIN occ.iam_identities p ON p.id=h.principal_id WHERE u.email=$1`,
          [email, admin.role_id, installationId, admin.principal_id],
        )
      ).rows;
    }
    async function assertCreated(
      app: App,
      response: Awaited<ReturnType<typeof create>>,
      account: Account,
    ) {
      assert.equal(response.statusCode, 201, response.body);
      const data = response.json().data;
      const rows = await persisted(account.email);
      assert.deepEqual(rows, [
        {
          user_id: data.id,
          principal_id: data.principalId,
          installation_id: installationId,
          disabled: false,
          principal_kind: "principal",
          issuer,
          subject: data.id,
          password_methods: 1,
          bindings: account.roleId === undefined ? 0 : 1,
          admin_bindings: account.roleId === undefined ? 0 : 1,
          memberships: 0,
          success_audits: 1,
        },
      ]);
      const session = await signIn(app, account);
      const read = await send(app, "GET", "/installation", session);
      assert.equal(read.statusCode, account.roleId === undefined ? 403 : 200, read.body);
      assert.equal((await send(app, "POST", "/api/auth/sign-out", session)).statusCode, 200);
      return data as { id: string; principalId: string };
    }
    async function assertDenied(
      response: Awaited<ReturnType<typeof create>>,
      account: Account,
      status = 403,
      actorId = admin.principal_id,
    ) {
      assert.equal(response.statusCode, status, response.body);
      assert.deepEqual(await persisted(account.email), []);
      // User-owned credential/enrollment rows and IAM binding/membership rows have foreign
      // keys. Check the independent Principal and audit roots too, so rollback cannot leave
      // authority behind after the target user has disappeared.
      const remnants = await pool.query(
        `SELECT
         (SELECT count(*)::int FROM occ.iam_identities p
          WHERE p.kind='principal' AND p.issuer=$1
            AND NOT EXISTS (SELECT 1 FROM occ."user" u WHERE u.id=p.subject)) AS orphan_principals,
         (SELECT count(*)::int FROM occ.audit_events e
          WHERE e.kind='mutation' AND e.outcome='success'
            AND e.action='openclaw.auth.accounts.create'
            AND e.details->'__occAuditMetadata'->>'requestId'=$2) AS success_audits`,
        [issuer, response.json().meta.requestId],
      );
      assert.deepEqual(remnants.rows, [{ orphan_principals: 0, success_audits: 0 }]);
      if (status === 403) {
        const denied = await pool.query(
          `SELECT actor_id FROM occ.audit_events
           WHERE kind='authorization_denial' AND outcome='denied'
             AND details->'__occAuditMetadata'->>'requestId'=$1`,
          [response.json().meta.requestId],
        );
        assert.equal(
          denied.rowCount,
          1,
          "the rolled-back request has attributable denial evidence",
        );
        assert.equal(denied.rows[0].actor_id, actorId);
      }
    }
    async function waiting(sql: string, blockerPid: number) {
      return waitFor(sql, async () => {
        const result = await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user
           AND state='active' AND wait_event_type='Lock' AND position(lower($1) in lower(query))>0
           AND $2::int=ANY(pg_blocking_pids(pid))`,
          [sql, blockerPid],
        );
        return result.rows[0]?.pid as number | undefined;
      });
    }
    async function transaction() {
      const client = await pool.connect();
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      return { client, pid };
    }

    for (const profile of ["password", "guarded"] as const) {
      await t.test(`${profile} profile`, async (t) => {
        const app = await appFor(profile);
        const peer = await appFor(profile);
        t.after(async () => {
          await closeApp(peer);
          await closeApp(app);
        });
        await t.test("allows an administrator and preserves zero-grant accounts", async () => {
          const session = await signIn(app);
          const account = fresh(`${profile}-allowed`);
          await assertCreated(app, await create(app, session, account), account);
          const unassigned = fresh(`${profile}-unassigned`);
          delete unassigned.roleId;
          await assertCreated(app, await create(app, session, unassigned), unassigned);
          const revoked = await signIn(app);
          assert.equal((await send(peer, "POST", "/api/auth/sign-out", revoked)).statusCode, 200);
          const denied = fresh(`${profile}-already-revoked`);
          await assertDenied(await create(app, revoked, denied), denied, 401);
          assert.equal((await send(app, "POST", "/api/auth/sign-out", session)).statusCode, 200);
        });

        await t.test("logout that obtains the session first prevents the account", async () => {
          const session = await signIn(app);
          const exact = await exactSession(app, session);
          const account = fresh(`${profile}-logout-first`);
          const { client, pid } = await transaction();
          let logout: ReturnType<typeof send> | undefined;
          let creation: ReturnType<typeof create> | undefined;
          try {
            // The ordinary peer logout queues on this session row first. Admission can
            // still see the committed session; the final State hold must observe its deletion.
            await client.query("SELECT id FROM occ.session WHERE id=$1 FOR UPDATE", [exact.id]);
            logout = send(peer, "POST", "/api/auth/sign-out", session);
            const logoutPid = await waiting("DELETE FROM", pid);
            creation = create(app, session, account);
            await waitFor("account authority waiting behind logout", async () => {
              const row = await pool.query(
                `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user
                 AND state='active' AND wait_event_type='Lock'
                 AND (position('FOR SHARE' in query)>0 OR position('UPDATE occ.session' in query)>0)
                 AND ($1::int=ANY(pg_blocking_pids(pid)) OR $2::int=ANY(pg_blocking_pids(pid)))`,
                [pid, logoutPid],
              );
              return row.rows[0]?.pid as number | undefined;
            });
            await client.query("COMMIT");
            assert.equal((await logout).statusCode, 200);
            await assertDenied(await creation, account);
            assert.equal(
              (await pool.query("SELECT id FROM occ.session WHERE id=$1", [exact.id])).rowCount,
              0,
            );
          } finally {
            await client.query("ROLLBACK");
            client.release();
            await Promise.allSettled([logout, creation]);
          }
        });

        await t.test("an account that holds authority commits before peer logout", async () => {
          const session = await signIn(app);
          const account = fresh(`${profile}-account-first`);
          const { client, pid } = await transaction();
          let creation: ReturnType<typeof create> | undefined;
          let logout: ReturnType<typeof send> | undefined;
          try {
            await client.query('LOCK TABLE occ."user" IN SHARE MODE');
            creation = create(app, session, account);
            const createPid = await waiting('INSERT INTO occ."user"', pid);
            logout = send(peer, "POST", "/api/auth/sign-out", session);
            await waiting(profile === "password" ? "DELETE FROM" : "FOR UPDATE", createPid);
            await client.query("COMMIT");
            await assertCreated(app, await creation, account);
            assert.equal((await logout).statusCode, 200);
            assert.equal((await send(app, "GET", "/installation", session)).statusCode, 401);
          } finally {
            await client.query("ROLLBACK");
            client.release();
            await Promise.allSettled([creation, logout]);
          }
        });

        await t.test(
          "COMMIT checks the real session expiry and rolls back every write",
          async () => {
            const proxy = await commitAckProxy(databaseUrl!);
            const delayed = await appFor(profile, proxy.url);
            const session = await signIn(delayed);
            const exact = await exactSession(delayed, session);
            const account = fresh(`${profile}-commit-expiry`);
            const { client, pid } = await transaction();
            let creation: ReturnType<typeof create> | undefined;
            try {
              await pool.query(
                "UPDATE occ.session SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",
                [exact.id],
              );
              await client.query('LOCK TABLE occ."user" IN SHARE MODE');
              creation = create(delayed, session, account);
              await waiting('INSERT INTO occ."user"', pid);
              // Arm only after the account transaction reaches its INSERT, so the wire
              // proxy delays this transaction's actual COMMIT, not an admission read.
              proxy.arm({ pauseCommit: true });
              await client.query("COMMIT");
              await waitFor("account COMMIT held on the wire", async () =>
                proxy.commitPaused ? true : undefined,
              );
              await waitFor("the PostgreSQL clock to pass the held expiry", async () => {
                const row = await pool.query(
                  "SELECT expires_at <= clock_timestamp() AS expired FROM occ.session WHERE id=$1",
                  [exact.id],
                );
                return row.rows[0]?.expired === true ? true : undefined;
              });
              proxy.resumeCommit();
              await assertDenied(await creation, account);
            } finally {
              await client.query("ROLLBACK");
              client.release();
              if (proxy.commitPaused) {
                proxy.resumeCommit();
              }
              await Promise.allSettled([creation]);
              await closeApp(delayed);
              await proxy.close();
            }
          },
        );

        await t.test("policy revoked before the final decision denies the account", async () => {
          const assigning = fresh(`${profile}-policy-actor`);
          const adminSession = await signIn(app);
          const actor = await assertCreated(
            app,
            await create(app, adminSession, assigning),
            assigning,
          );
          const session = await signIn(app, assigning);
          const account = fresh(`${profile}-policy-denied`);
          const { client, pid } = await transaction();
          let creation: ReturnType<typeof create> | undefined;
          try {
            // The existing configuration barrier orders this committed policy change
            // before the route's selected Native IAM decision on its original State unit.
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
              "occ:iam-configuration",
            ]);
            creation = create(app, session, account);
            await waiting("pg_advisory_xact_lock_shared", pid);
            await client.query("DELETE FROM occ.iam_access_bindings WHERE identity_subject_id=$1", [
              actor.principalId,
            ]);
            await client.query("COMMIT");
            await assertDenied(await creation, account, 403, actor.principalId);
          } finally {
            await client.query("ROLLBACK");
            client.release();
            await Promise.allSettled([creation]);
          }
        });

        await t.test("a lost real COMMIT acknowledgement keeps the committed account", async () => {
          const proxy = await commitAckProxy(databaseUrl!);
          const uncertain = await appFor(profile, proxy.url);
          const session = await signIn(uncertain);
          const account = fresh(`${profile}-unknown-commit`);
          const { client, pid } = await transaction();
          let creation: ReturnType<typeof create> | undefined;
          try {
            await client.query('LOCK TABLE occ."user" IN SHARE MODE');
            creation = create(uncertain, session, account);
            await waiting('INSERT INTO occ."user"', pid);
            proxy.arm();
            await client.query("COMMIT");
            const response = await creation;
            assert.equal(proxy.observedCommit, true);
            assert.equal(response.statusCode, 503, response.body);
            assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
            assert.match(response.json().error.message, /outcome is unknown/);
            const rows = await persisted(account.email);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].password_methods, 1);
            assert.equal(rows[0].admin_bindings, 1);
            assert.equal(
              rows[0].success_audits,
              1,
              "an uncertain account mutation is never replayed",
            );
            const signedIn = await signIn(peer, account);
            assert.equal((await send(peer, "GET", "/installation", signedIn)).statusCode, 200);
          } finally {
            await client.query("ROLLBACK");
            client.release();
            await Promise.allSettled([creation]);
            await closeApp(uncertain);
            await proxy.close();
          }
        });
      });
    }

    await t.test(
      "configured default Groups remain effective without an explicit Role",
      async () => {
        // Use the public composition primitives and the same production account provisioner.
        // Applying this actual IAM configuration creates its real Group, Role and binding.
        const state = new PostgresPlatformState(pool);
        const installation = await state.loadInstallation();
        assert.ok(installation);
        const iamDriver = new NativeIAMDriver(state, {
          id: "native-iam",
          implementation: "native",
        });
        const controller = new OpenClawController(installation, {
          state,
          iamConfiguration: {
            roles: [
              {
                id: "account-reader",
                permissions: [{ resourceKind: "namespace", action: "read" }],
              },
            ],
            defaultUserGroups: ["account-reader"],
            roleBindings: [
              { group: "account-reader", role: "account-reader", scope: "installation" },
            ],
          },
        });
        controller.registerDriver(iamDriver);
        controller.selectDriver("iam", iamDriver.id);
        await controller.applyIAMConfiguration();
        const auth = await createPostgresControllerAuth({
          mode: "development",
          installationId,
          secret: authSecret,
          baseURL: origin,
          agentDomain: "agents.oce.localhost",
          pool,
          state,
          iamDriver,
          google: {
            clientId: "account-authority-fixture",
            clientSecret: "account-authority-fixture-secret",
            allowedDomains: [],
            recoveryUserId: admin.user_id,
          },
        });
        const configured = createFastifyApp({
          controller,
          iamDriver,
          resolveHarness: resolveApprovedHarness,
          auditSink: state.auditSink,
          auth,
          publicOrigin: origin,
          development: { enabled: true, installationId, browserOrigin: origin },
          provisionAuthAccount: createPostgresAuthAccountProvisioner({ state, installationId }),
        });
        apps.add(configured);
        try {
          await configured.ready();
          const session = await signIn(configured);
          const namespaceResponse = await send(configured, "POST", "/namespaces", session, {
            name: `account-reader-${randomUUID()}`,
          });
          assert.equal(namespaceResponse.statusCode, 201, namespaceResponse.body);
          const namespaceId = namespaceResponse.json().data.id;
          const account = fresh("configured-group");
          delete account.roleId;
          const response = await create(configured, session, account);
          assert.equal(response.statusCode, 201, response.body);
          const created = response.json().data;
          const rows = await persisted(account.email);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].bindings, 0);
          assert.equal(rows[0].memberships, 1);
          assert.equal(rows[0].success_audits, 1);
          assert.deepEqual(
            (
              await pool.query(
                "SELECT group_id FROM occ.iam_group_memberships WHERE principal_id=$1",
                [created.principalId],
              )
            ).rows,
            [{ group_id: "group_config_account-reader" }],
          );
          const member = await signIn(configured, account);
          assert.equal(
            (await send(configured, "GET", `/namespaces/${namespaceId}`, member)).statusCode,
            200,
          );
          const refused = fresh("group-cannot-appoint");
          await assertDenied(
            await create(configured, member, refused),
            refused,
            403,
            created.principalId,
          );
        } finally {
          await closeApp(configured);
        }
      },
    );
  },
);
