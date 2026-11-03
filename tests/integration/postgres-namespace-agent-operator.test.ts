import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { composeProduction } from "../helpers/password-hasher.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  consoleOrigin as origin,
  githubSignIn,
  githubUpgradeSettings,
  googleUpgradeSettings,
  productionSignInConfiguration,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

const clientId = "agent-operator-fixture";
const providerId = `github:${createHash("sha256").update(clientId).digest("hex")}`;
const team = { organizationId: "81011", teamId: "81012" };
const newStage = { ...team, expectedGeneration: null, acknowledgeAllAgents: true };

interface FixtureAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

test(
  "Agent Operator staging uses the human admin's exact Namespace and original PostgreSQL transaction",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    assert.ok(databaseUrl);
    let app: Awaited<ReturnType<typeof fixture.composeApp>>;
    const secrets = {
      "occ-auth/secret": "agent-operator-fixture-cookie-secret",
      "occ-github-login/client-id": clientId,
      "occ-github-login/client-secret": "agent-operator-fixture-client-secret",
      "occ-google-login/client-id": "agent-operator-fixture-google-client-id",
      "occ-google-login/client-secret": "agent-operator-fixture-google-client-secret",
    };
    const fixture = await preparePostgresSignInInstallation(t, () => [app], {
      email: "agent-operator-admin@example.test",
      password: "agent-operator-fixture-password",
      secrets,
    });
    const { pool, state, github } = fixture;
    const onboarded = await fixture.onboard({
      accounts: {
        first: { email: "agent-operator-first@example.test" },
        second: { email: "agent-operator-second@example.test" },
      },
    });
    const admin = onboarded.admin as FixtureAccount;
    const accounts = onboarded.accounts as Record<"first" | "second", FixtureAccount>;
    assert.ok(github);
    const {
      rows: [databaseRole],
    } = await pool.query(
      `SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
         has_schema_privilege(current_user, 'occ', 'CREATE') AS schema_create,
         has_table_privilege(current_user, 'occ.namespace_agent_operator_profiles', 'DELETE') AS profile_delete,
         has_column_privilege(current_user, 'occ.namespace_agent_operator_profiles', 'namespace_id', 'UPDATE') AS profile_move
       FROM pg_roles WHERE rolname = current_user`,
    );
    assert.deepEqual(databaseRole, {
      name: "occ_app",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      schema_create: false,
      profile_delete: false,
      profile_move: false,
    });

    const namespace = `ns_${randomUUID()}`;
    const unrelated = `ns_${randomUUID()}`;
    const unreadable = `ns_${randomUUID()}`;
    const expiring = `ns_${randomUUID()}`;
    await state.transact(async (unit) => {
      // Seed ready Namespaces because this test does not run a compute reconciler.
      for (const [id, name] of [
        [namespace, "agent-operator"],
        [unrelated, "agent-operator-unrelated"],
        [unreadable, "agent-operator-unreadable"],
        [expiring, "agent-operator-expiring"],
      ] as const) {
        await unit.namespaces.createNamespace({
          id,
          name,
          status: "ready",
          createdAt: new Date().toISOString(),
        });
      }
    });
    // Installation administer does not override a Restriction on this exact Namespace.
    await pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
       VALUES ($1, $2, 'read', 'namespace', $2)`,
      [`restriction-${randomUUID()}`, unreadable],
    );

    app = await fixture.composeApp(githubUpgradeSettings(admin.id));
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const adminPrincipalId = await accountPrincipalId(pool, admin.id);
    const firstSubject = 8_101_001;
    const secondSubject = 8_101_002;
    await assertProviderAttached(
      app,
      adminHeaders,
      accounts.first.id,
      "github",
      String(firstSubject),
    );
    await assertProviderAttached(
      app,
      adminHeaders,
      accounts.second.id,
      "github",
      String(secondSubject),
    );
    const first = await githubSignIn(app, origin, firstSubject);
    const second = await githubSignIn(app, origin, secondSubject);
    const firstCookie = await assertConsoleSignIn(app, first.callback, accounts.first.id);
    const secondCookie = await assertConsoleSignIn(app, second.callback, accounts.second.id);
    assert.deepEqual(
      github.paths,
      ["/login/oauth/access_token", "/user", "/login/oauth/access_token", "/user"],
      "attached sign-in produced no team membership evidence",
    );
    let endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const profile = (id: string) => `/namespaces/${id}/iam/agent-operator`;
    async function request(
      method: string,
      path: string,
      payload?: object,
      headers: HeadersInit = adminHeaders,
    ) {
      const outgoing = new Headers(headers);
      if (payload !== undefined) {
        outgoing.set("content-type", "application/json");
      }
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: outgoing,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.json() };
    }
    async function expectOff(id: string) {
      const result = await request("GET", profile(id));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.data, { namespaceId: id, generation: null, status: "off" });
    }
    const policyChanges = async () =>
      (await state.transact((unit) => unit.audit.list())).filter(
        (event) =>
          event.kind === "mutation" &&
          event.outcome === "success" &&
          event.action.startsWith("openclaw.iam.agent_operator."),
      );

    await expectOff(namespace);
    const badBodies = [
      { ...newStage, acknowledgeAllAgents: false },
      { ...newStage, teamId: "team-slug" },
      { ...newStage, providerId },
      { ...newStage, membership: { state: "active", subject: String(firstSubject) } },
    ];
    for (const body of badBodies) {
      assert.equal((await request("PUT", profile(namespace), body)).status, 400);
    }
    await expectOff(namespace);
    assert.equal((await request("GET", profile(unreadable))).status, 403);
    assert.equal((await request("PUT", profile(unreadable), newStage)).status, 403);
    const firstHeaders = { cookie: firstCookie, origin };
    const secondHeaders = { cookie: secondCookie, origin };
    assert.equal((await request("GET", profile(namespace), undefined, firstHeaders)).status, 403);
    assert.equal((await request("PUT", profile(namespace), newStage, firstHeaders)).status, 403);

    const {
      rows: [service],
    } = await pool.query(
      "SELECT id FROM occ.iam_identities WHERE kind = 'service_principal' AND namespace_id IS NULL",
    );
    const key = await request("POST", "/api/auth/service-keys", {
      servicePrincipalId: service.id,
      name: "profile proof",
    });
    assert.equal(key.status, 201, JSON.stringify(key.body.error));
    const serviceHeaders = { "x-api-key": key.body.data.key };
    assert.equal((await request("GET", "/installation", undefined, serviceHeaders)).status, 200);
    const serviceAttempt = await request("PUT", profile(namespace), newStage, serviceHeaders);
    assert.equal(serviceAttempt.status, 403);
    assert.match(serviceAttempt.body.error.message, /current human session/);
    assert.deepEqual(await policyChanges(), []);

    // Separate sessions contend on the Namespace row, rather than one session's row.
    const concurrentAdminHeaders = await signedInHeaders(app, origin, admin, "192.0.2.11");
    const concurrent = await Promise.all([
      request("PUT", profile(namespace), newStage),
      request("PUT", profile(namespace), { ...newStage, teamId: "81013" }, concurrentAdminHeaders),
    ]);
    assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
    const winningIndex = concurrent.findIndex(({ status }) => status === 200);
    const staged = concurrent[winningIndex]!.body.data;
    assert.equal(staged.status, "staged");
    assert.equal(staged.namespaceId, namespace);
    assert.deepEqual(staged.team, {
      ...team,
      teamId: winningIndex === 0 ? team.teamId : "81013",
      providerId,
    });
    assert.equal(typeof staged.generation, "string");
    assert.deepEqual((await request("GET", profile(namespace))).body.data, staged);
    assert.equal(
      (
        await request("POST", `${profile(unrelated)}/withdraw`, {
          expectedGeneration: staged.generation,
        })
      ).status,
      409,
    );
    await expectOff(unrelated);

    // Establish valid ordinary draft requests using the administrator, then send the
    // same shapes with two authenticated nonadmin sessions. Neither gets a profile grant.
    const configurationPath = `/namespaces/${namespace}/configurations`;
    const configuration = { kind: "agent", values: {} };
    const createdConfiguration = await request("POST", configurationPath, configuration);
    assert.equal(createdConfiguration.status, 201, JSON.stringify(createdConfiguration.body));
    const agentPath = `/namespaces/${namespace}/agents`;
    const agent = { name: "Admin draft", configurationId: createdConfiguration.body.data.id };
    const createdAgent = await request("POST", agentPath, agent);
    assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent.body));
    for (const [index, headers] of [firstHeaders, secondHeaders].entries()) {
      assert.equal((await request("POST", configurationPath, configuration, headers)).status, 403);
      assert.equal(
        (await request("POST", agentPath, { ...agent, name: `Nonadmin draft ${index}` }, headers))
          .status,
        403,
      );
    }
    assert.deepEqual(
      (await pool.query("SELECT id FROM occ.agents WHERE namespace_id = $1", [namespace])).rows,
      [{ id: createdAgent.body.data.id }],
    );
    assert.deepEqual(
      (await pool.query("SELECT id FROM occ.configurations WHERE namespace_id = $1", [namespace]))
        .rows,
      [{ id: createdConfiguration.body.data.id }],
    );

    const expiredHeaders = await signedInHeaders(app, origin, admin, "192.0.2.12");
    const blocker = await pool.connect();
    let blockedWrite: ReturnType<typeof request> | undefined;
    try {
      const {
        rows: [session],
      } = await pool.query(
        `UPDATE occ.session SET expires_at = clock_timestamp() + interval '4 seconds'
         WHERE id = (SELECT id FROM occ.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)
         RETURNING expires_at`,
        [admin.id],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [expiring]);
      blockedWrite = request("PUT", profile(expiring), newStage, expiredHeaders);
      // Observe the write waiting on its Namespace lock after the initial session hold.
      let waiting = false;
      const until = Date.now() + 3_000;
      while (!waiting && Date.now() < until) {
        const {
          rows: [status],
        } = await pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%') AS waiting`,
        );
        waiting = status.waiting;
        if (!waiting) {
          await setTimeout(25);
        }
      }
      assert.equal(waiting, true, "the protected write reached its original-state lock");
      await setTimeout(Math.max(1, session.expires_at.getTime() - Date.now() + 50));
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await blockedWrite?.catch(() => undefined);
    }
    const expired = await blockedWrite;
    assert.ok(expired);
    assert.equal(expired.status, 403, JSON.stringify(expired.body));
    await expectOff(expiring);
    assert.equal(
      (await policyChanges()).length,
      1,
      "the expired write did not commit success audit",
    );

    // Keep the guarded Auth profile active with Google, then inspect and withdraw the
    // assignment without configuring the GitHub provider or contacting either provider.
    await app.close();
    const googleConfig = await productionSignInConfiguration(t, {
      databaseUrl,
      settings: googleUpgradeSettings(admin.id),
      secrets,
      logger: undefined,
      metrics: undefined,
      passwordSlowLaneFloors: undefined,
    });
    // Use the same sign-in fixture Drivers, with the production pool limited to one client.
    app = await composeProduction({ ...googleConfig, poolMax: 1 });
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    Object.assign(adminHeaders, await signedInHeaders(app, origin, admin));
    // The read must complete with one pool connection and still enforce exact Namespace read.
    const inspected = await request("GET", profile(namespace));
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.deepEqual(inspected.body.data, staged);
    assert.equal((await request("GET", profile(unreadable))).status, 403);
    assert.equal((await request("PUT", profile(unrelated), newStage)).status, 503);
    const withdraw = await request("POST", `${profile(namespace)}/withdraw`, {
      expectedGeneration: staged.generation,
    });
    assert.equal(withdraw.status, 200, JSON.stringify(withdraw.body));
    const withdrawn = withdraw.body.data;
    assert.equal(withdrawn.status, "withdrawn");
    assert.notEqual(withdrawn.generation, staged.generation);
    assert.deepEqual(withdrawn.team, staged.team);
    assert.deepEqual((await request("GET", profile(namespace))).body.data, withdrawn);
    assert.equal(
      (
        await request("POST", `${profile(namespace)}/withdraw`, {
          expectedGeneration: staged.generation,
        })
      ).status,
      409,
    );
    const changes = await policyChanges();
    assert.deepEqual(
      changes.map(({ action, actorId, resource, details }) => ({
        action,
        actorId,
        resource,
        generation: details?.generation,
        status: details?.status,
        team: details?.team,
      })),
      [staged, withdrawn].map((change) => ({
        action: `openclaw.iam.agent_operator.${change.status === "staged" ? "stage" : "withdraw"}`,
        actorId: adminPrincipalId,
        resource: { kind: "namespace", id: namespace, namespaceId: namespace },
        generation: change.generation,
        status: change.status,
        team: change.team,
      })),
    );

    // Returning to the configured provider cannot replay a request from before withdrawal.
    await app.close();
    app = await fixture.composeApp(githubUpgradeSettings(admin.id));
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    Object.assign(adminHeaders, await signedInHeaders(app, origin, admin));
    assert.equal((await request("PUT", profile(namespace), newStage)).status, 409);
    assert.equal(
      (
        await request("PUT", profile(namespace), {
          ...newStage,
          expectedGeneration: staged.generation,
        })
      ).status,
      409,
    );
    assert.deepEqual((await request("GET", profile(namespace))).body.data, withdrawn);
    const restaged = await request("PUT", profile(namespace), {
      ...newStage,
      expectedGeneration: withdrawn.generation,
    });
    assert.equal(restaged.status, 200, JSON.stringify(restaged.body));
    assert.equal(restaged.body.data.status, "staged");
    assert.notEqual(restaged.body.data.generation, withdrawn.generation);
  },
);
