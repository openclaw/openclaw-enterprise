import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { composeProduction } from "../helpers/password-hasher.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  accountPrincipalId,
  consoleOrigin as origin,
  defaultInstallSettings,
  productionSignInConfiguration,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

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
    };
    const fixture = await preparePostgresSignInInstallation(t, () => [app], {
      email: "agent-operator-admin@example.test",
      password: "agent-operator-fixture-password",
      secrets,
      github: false,
    });
    const { pool, state } = fixture;
    const onboarded = await fixture.onboard({
      accounts: {
        first: { email: "agent-operator-first@example.test" },
        second: { email: "agent-operator-second@example.test" },
      },
    });
    const admin = onboarded.admin as FixtureAccount;
    const accounts = onboarded.accounts as Record<"first" | "second", FixtureAccount>;
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

    const groupId = `group-${randomUUID()}`;
    const alternate = `group-${randomUUID()}`;
    const otherGroup = `group-${randomUUID()}`;
    const expiringGroup = `group-${randomUUID()}`;
    const installationGroup = `group-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_groups (id, namespace_id, name)
       VALUES ($1, $5, 'Operators'), ($2, $5, 'Alternate'), ($3, $6, 'Operators'), ($4, NULL, 'Operators'), ($7, $8, 'Operators')`,
      [
        groupId,
        alternate,
        otherGroup,
        installationGroup,
        namespace,
        unrelated,
        expiringGroup,
        expiring,
      ],
    );
    // Whichever contender wins, the first account is a member and the second is not.
    const member = await accountPrincipalId(pool, accounts.first.id);
    await pool.query(
      `INSERT INTO occ.iam_group_memberships (namespace_id, group_id, principal_id)
       VALUES ($1, $2, $4), ($1, $3, $4)`,
      [namespace, groupId, alternate, member],
    );
    const newStage = { groupId, expectedGeneration: null, acknowledgeAllAgents: true };
    app = await fixture.composeApp(defaultInstallSettings);
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const {
      rows: [adminPrincipal],
    } = await pool.query(
      "SELECT id FROM occ.iam_identities WHERE kind = 'principal' AND subject = $1",
      [admin.id],
    );
    const firstHeaders = await signedInHeaders(app, origin, accounts.first, "192.0.2.21");
    const secondHeaders = await signedInHeaders(app, origin, accounts.second, "192.0.2.22");
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
      { ...newStage, groupId: "" },
      { ...newStage, organizationId: "81011", teamId: "81012" },
      { ...newStage, providerId: "github" },
      { ...newStage, membership: { state: "active" } },
    ];
    for (const body of badBodies) {
      assert.equal((await request("PUT", profile(namespace), body)).status, 400);
    }
    await expectOff(namespace);
    assert.equal((await request("GET", profile(unreadable))).status, 403);
    assert.equal((await request("PUT", profile(unreadable), newStage)).status, 403);
    for (const invalid of [`group-${randomUUID()}`, otherGroup, installationGroup]) {
      const result = await request("PUT", profile(namespace), { ...newStage, groupId: invalid });
      assert.equal(result.status, 404, JSON.stringify(result.body));
    }
    await expectOff(namespace);
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
      request(
        "PUT",
        profile(namespace),
        { ...newStage, groupId: alternate },
        concurrentAdminHeaders,
      ),
    ]);
    assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
    const winningIndex = concurrent.findIndex(({ status }) => status === 200);
    const staged = concurrent[winningIndex]!.body.data;
    assert.equal(staged.status, "staged");
    assert.equal(staged.namespaceId, namespace);
    assert.equal(staged.groupId, winningIndex === 0 ? groupId : alternate);
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
      blockedWrite = request(
        "PUT",
        profile(expiring),
        { ...newStage, groupId: expiringGroup },
        expiredHeaders,
      );
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

    // Reopen with one pool connection to exercise the exact Namespace read.
    await app.close();
    const config = await productionSignInConfiguration(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
      logger: undefined,
      metrics: undefined,
      passwordSlowLaneFloors: undefined,
    });
    // Use the same sign-in fixture Drivers, with the production pool limited to one client.
    app = await composeProduction({ ...config, poolMax: 1 });
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    Object.assign(adminHeaders, await signedInHeaders(app, origin, admin));
    // The read must complete with one pool connection and still enforce exact Namespace read.
    const inspected = await request("GET", profile(namespace));
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.deepEqual(inspected.body.data, staged);
    assert.equal((await request("GET", profile(unreadable))).status, 403);
    assert.equal((await request("PUT", profile(unrelated), newStage)).status, 404);
    const withdraw = await request("POST", `${profile(namespace)}/withdraw`, {
      expectedGeneration: staged.generation,
    });
    assert.equal(withdraw.status, 200, JSON.stringify(withdraw.body));
    const withdrawn = withdraw.body.data;
    assert.equal(withdrawn.status, "withdrawn");
    assert.notEqual(withdrawn.generation, staged.generation);
    assert.equal(withdrawn.groupId, null);
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
        groupId: details?.groupId,
        previousGeneration: details?.previousGeneration,
      })),
      [staged, withdrawn].map((change) => ({
        action: `openclaw.iam.agent_operator.${change.status === "staged" ? "stage" : "withdraw"}`,
        actorId: adminPrincipal.id,
        resource: { kind: "namespace", id: namespace, namespaceId: namespace },
        generation: change.generation,
        status: change.status,
        groupId: change.groupId,
        previousGeneration: change.status === "withdrawn" ? staged.generation : undefined,
      })),
    );

    // A stale request cannot reinstate a withdrawn selection.
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
    assert.deepEqual(
      (
        await pool.query(
          "SELECT group_id, principal_id FROM occ.iam_group_memberships WHERE namespace_id = $1 ORDER BY group_id",
          [namespace],
        )
      ).rows,
      [groupId, alternate].sort().map((id) => ({ group_id: id, principal_id: member })),
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id FROM occ.iam_access_bindings WHERE namespace_id = $1 AND group_subject_id IS NOT NULL",
          [namespace],
        )
      ).rows,
      [],
    );
  },
);
