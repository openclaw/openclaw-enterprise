import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bindGithubTeamMappings } from "../../apps/controller/src/auth/github-team-mappings.ts";
import { startGithubRosterWorker } from "../../apps/controller/src/worker/github-roster.ts";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  consoleOrigin,
  githubUpgradeSettings,
  signedInHeaders,
  assertProviderAttached,
  startFakeGitHub,
  composeProductionSignIn,
} from "../helpers/production-sign-in.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test(
  "mapped GitHub sign-in and the roster worker change access on a live session",
  requiresPostgres,
  async (t) => {
    const subject = 7110001;
    const login = `fixture-${subject}`;
    const clientId = "roster-client";
    const serviceToken = `ghs_${"rosterfixture"}`;
    const githubTeamMappings = [
      { id: "support", organizationId: "17", teamId: "23", group: "support" },
      { id: "other", organizationId: "17", teamId: "24", group: "support" },
    ];
    const iam = {
      roles: [
        { id: "team_reader", permissions: ["namespace:read", "namespace:create", "secret:update"] },
      ],
      ownerRole: "team_reader",
      roleBindings: [
        { group: "support", role: "team_reader", scope: "installation" },
        { group: "support", role: "team_reader", scope: { namespace: "default" } },
      ],
      githubTeamMappings,
    };
    const apps: Awaited<ReturnType<typeof composeProductionSignIn>>[] = [];
    const setup = await preparePostgresSignInInstallation(t, () => apps, {
      email: "roster-admin@example.test",
      password: "roster-member-test-password",
      github: false,
      secrets: {
        "occ-auth/secret": "roster-test-sign-in-secret-with-32-characters",
        "occ-github-login/client-id": clientId,
        "occ-github-login/client-secret": "roster-client-fixture",
      },
    });
    let present = true;
    let hiddenUserTeam = false;
    let unavailableReader = true;
    const callerTypes = new Set<string>();
    await startFakeGitHub(t, (request, response, body) => {
      const credential = request.headers.authorization;
      if (
        credential !== `Bearer ghu_fixture_${subject}` &&
        credential !== `Bearer ${serviceToken}`
      ) {
        response.writeHead(401).end();
        return;
      }
      const caller = credential === `Bearer ${serviceToken}` ? "worker" : "sign-in";
      callerTypes.add(caller);
      if (caller === "worker" && unavailableReader) {
        response.writeHead(503).end();
        return;
      }
      if (
        request.url === "/organizations/17/team/23" ||
        request.url === "/organizations/17/team/24"
      ) {
        const id = request.url.endsWith("/23") ? 23 : 24;
        if (id === 24 && caller === "sign-in" && hiddenUserTeam) {
          response.writeHead(404).end();
          return;
        }
        response.end(
          JSON.stringify({ id, node_id: "T_" + id, privacy: "closed", organization: { id: 17 } }),
        );
        return;
      }
      if (request.url === `/user/${subject}`) {
        response.end(JSON.stringify({ id: subject, login, type: "User" }));
        return;
      }
      const query = JSON.parse(body || "{}") as {
        variables?: { team?: string; login?: string; signIn?: boolean };
      };
      if (
        request.url !== "/graphql" ||
        !["T_23", "T_24"].includes(query.variables?.team ?? "") ||
        (query.variables?.login !== undefined &&
          (query.variables.login !== login || query.variables.signIn !== (caller === "sign-in")))
      ) {
        response.writeHead(400).end();
        return;
      }
      const teamId = query.variables?.team === "T_23" ? 23 : 24;
      const member = teamId === 23 && present;
      const nodes = member ? [{ databaseId: subject }] : [];
      response.end(
        JSON.stringify({
          data: {
            team: {
              id: "T_" + teamId,
              databaseId: teamId,
              organization: {
                databaseId: 17,
                subjectTeams: {
                  nodes: present ? [{ databaseId: 23 }] : [],
                  totalCount: present ? 1 : 0,
                  pageInfo: { hasNextPage: false },
                },
              },
              members: {
                nodes,
                totalCount: nodes.length,
                pageInfo: { hasNextPage: false, endCursor: member ? "member" : null },
              },
            },
            subject: { login, databaseId: subject },
            viewer: { databaseId: subject },
          },
        }),
      );
    });
    const { admin, accounts } = await setup.onboard({
      accounts: {
        person: { email: "roster-member@example.test" },
        operator: { email: "roster-operator@example.test", role: "admin" },
      },
    });
    const { person, operator } = accounts as { person: { id: string }; operator: { id: string } };
    for (const [field, value, reason] of [
      ["organizationId", "18", /one GitHub organization/],
      ["teamId", "9007199254740992", /positive decimal/],
    ] as const) {
      await assert.rejects(
        setup.composeApp(githubUpgradeSettings(admin.id), {
          iam: {
            ...iam,
            githubTeamMappings: [
              githubTeamMappings[0],
              { ...githubTeamMappings[1], [field]: value },
            ],
          },
        }),
        reason,
      );
    }
    const secretDriver = createTestSecretDriver({
      id: createInstallationDriverConfiguration().drivers.secret.id,
    });
    const server = await setup.composeApp(githubUpgradeSettings(admin.id), { iam, secretDriver });
    apps.push(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const adminHeaders = await signedInHeaders(server, consoleOrigin, admin);
    await assertProviderAttached(server, adminHeaders, person.id, "github", String(subject));

    async function signIn() {
      const start = await fetch(address + "/api/auth/providers/github/start", {
        method: "POST",
        headers: { origin: consoleOrigin },
      });
      assert.equal(start.status, 200);
      const { data } = (await start.json()) as { data: { url: string } };
      const state = new URL(data.url).searchParams.get("state");
      return fetch(
        address + `/api/auth/providers/github/callback?state=${state}&code=subject-${subject}`,
        {
          redirect: "manual",
          headers: { cookie: cookieHeaderFromSetCookie(start.headers.getSetCookie()) },
        },
      );
    }
    const installation = await setup.state.loadInstallation();
    assert.ok(installation);
    const directory = await temporaryDirectory(t, "oce-roster-worker-");
    const file = join(directory, "token");
    await writeFile(file, serviceToken, { mode: 0o600 });
    const waitUntil = async (check: () => Promise<boolean>, reason: string) => {
      const end = Date.now() + 10000;
      while (!(await check())) {
        assert.ok(Date.now() < end, reason);
        await delay(25);
      }
    };
    const forceDue = () =>
      setup.pool.query(
        "UPDATE occ.github_roster_mappings SET next_refresh_at=clock_timestamp() WHERE generation IS NOT NULL",
      );
    // Move only the database due time between passes. Each observation and its commit go
    // through the normal worker with the token file and restricted application role.
    const auditCount = async () =>
      (
        await setup.pool.query(
          "SELECT count(*)::int AS n FROM occ.audit_events WHERE action='iam.github_roster.refresh'",
        )
      ).rows[0].n as number;
    async function runWorkerPass(expectUnavailable: boolean) {
      const before = await auditCount();
      await forceDue();
      const warnings: string[] = [];
      const worker = startGithubRosterWorker(
        setup.state,
        installation!.id,
        bindGithubTeamMappings(
          { roles: [], defaultUserGroups: [], roleBindings: [], githubTeamMappings },
          clientId,
        ),
        file,
        (id) => warnings.push(id),
      );
      try {
        await waitUntil(
          async () => (await auditCount()) === before + githubTeamMappings.length,
          "worker must settle every due mapping",
        );
      } finally {
        await worker.close();
      }
      assert.deepEqual(warnings.sort(), expectUnavailable ? ["other", "support"] : []);
    }
    const unavailableLocation = "/console/?authError=github&authReason=membership-unavailable";
    assert.equal(
      (await signIn()).headers.get("location"),
      unavailableLocation,
      "pending generation cannot authorize a new account",
    );
    await runWorkerPass(true);
    assert.equal(
      (await signIn()).headers.get("location"),
      unavailableLocation,
      "a permanently unreadable generation has no authority",
    );
    unavailableReader = false;
    await runWorkerPass(false);
    const first = await signIn();
    assert.equal(first.headers.get("location"), "/console/");
    const cookie = cookieHeaderFromSetCookie(first.headers.getSetCookie());
    const namespace = (await setup.pool.query("SELECT id FROM occ.namespaces WHERE name='default'"))
      .rows[0].id;
    const access = async () => {
      const response = await fetch(address + `/namespaces/${namespace}`, { headers: { cookie } });
      await response.arrayBuffer();
      return response.status;
    };
    assert.equal(await access(), 200);
    unavailableReader = true;
    await runWorkerPass(true);
    assert.equal(await access(), 200, "later background failure retains verified authority");
    hiddenUserTeam = true;
    assert.equal(
      (await signIn()).headers.get("location"),
      "/console/?authError=github&authReason=membership-unavailable",
    );
    assert.equal(
      await access(),
      200,
      "a failed fresh sign-in retains an existing session's verified membership",
    );
    hiddenUserTeam = false;
    unavailableReader = false;
    present = false;
    // As in the Default users create/configuration race, hold the account's row so the
    // HTTP request reaches its final session fence while the mapping still grants create.
    async function lockAccount(userId: string) {
      const locker = await setup.pool.connect();
      await locker.query("BEGIN");
      const {
        rows: [held],
      } = await locker.query(
        'SELECT pg_backend_pid() AS pid FROM occ."user" WHERE id=$1 FOR UPDATE',
        [userId],
      );
      let released = false;
      const release = async () => {
        if (!released) {
          await locker.query("ROLLBACK");
          locker.release();
          released = true;
        }
      };
      t.after(release);
      const waitForCaller = (count = 1) =>
        waitUntil(
          async () =>
            (
              await setup.pool.query(
                `WITH RECURSIVE blocked(pid) AS (SELECT $1::integer UNION
                   SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
                   WHERE a.datname=current_database())
                  SELECT count(*)-1 >= $2 AS blocked FROM blocked`,
                [held.pid, count],
              )
            ).rows[0].blocked,
          "request must reach the exact account lock",
        );
      return { release, waitForCaller };
    }
    // The sign-in fixture uses passive Compute. Establish its completed Namespace
    // provisioning prerequisite in State before exercising the real Secret API/Driver.
    await setup.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace, "provisioning", "ready"),
    );
    const secretCreated = await fetch(address + `/namespaces/${namespace}/secrets`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "mapped mutation", value: "initial fixture value" }),
    });
    assert.equal(secretCreated.status, 201);
    const { data: created } = (await secretCreated.json()) as { data: { ref: { id: string } } };
    const patch = () =>
      fetch(address + `/namespaces/${namespace}/secrets/${created.ref.id}`, {
        method: "PATCH",
        headers: { cookie, origin: consoleOrigin, "content-type": "application/json" },
        body: JSON.stringify({ value: "updated fixture value" }),
      });
    const initialPatch = await patch();
    assert.equal(initialPatch.status, 200, await initialPatch.text());
    const updates = () => secretDriver.calls.filter((call) => call.operation === "update").length;
    assert.equal(updates(), 1, "positive PATCH reached the Secret Driver");
    const userLock = await lockAccount(person.id);
    const create = fetch(address + "/namespaces", {
      method: "POST",
      headers: { cookie, origin: consoleOrigin, "content-type": "application/json" },
      body: JSON.stringify({ name: "roster-fenced-create" }),
    });
    const queuedPatch = patch();
    await userLock.waitForCaller(2);
    try {
      await runWorkerPass(false);
    } finally {
      await userLock.release();
    }
    const deniedPatch = await queuedPatch;
    assert.equal(deniedPatch.status, 403, await deniedPatch.text());
    assert.equal(updates(), 1, "withdrawn PATCH never reached the Secret Driver");
    const refused = await create;
    assert.equal(refused.status, 403, await refused.text());
    assert.equal(
      (await setup.pool.query("SELECT id FROM occ.namespaces WHERE name='roster-fenced-create'"))
        .rowCount,
      0,
    );
    assert.equal(
      await access(),
      403,
      "the same session loses the withdrawn Group's read permission",
    );
    assert.deepEqual([...callerTypes].sort(), ["sign-in", "worker"]);
    present = true;
    assert.equal(await access(), 403);
    assert.equal((await signIn()).headers.get("location"), "/console/");
    assert.equal(await access(), 200, "a new verified sign-in restores the mapping");

    async function overrideDecision() {
      const read = await fetch(address + `/api/auth/accounts/${person.id}`, {
        headers: adminHeaders,
      });
      assert.equal(read.status, 200);
      const { data } = (await read.json()) as {
        data: {
          version: number;
          methods: { methodId: string; subject: string }[];
          githubTeamRefresh: {
            mappingId: string;
            status: string;
            lastSuccessfulAt: string | null;
          }[];
        };
      };
      assert.ok(data.githubTeamRefresh.every((rule) => rule.status === "complete"));
      assert.ok(data.githubTeamRefresh[0]?.lastSuccessfulAt);
      const method = data.methods.find((m) => m.subject === String(subject));
      assert.ok(method);
      const url =
        address +
        `/api/auth/accounts/${person.id}/methods/${method.methodId}/github-team-mappings/support/override`;
      const current = await fetch(url, { headers: adminHeaders });
      assert.equal(current.status, 200);
      const { data: decision } = (await current.json()) as {
        data: { version: string; accountVersion: number };
      };
      return { url, decision };
    }
    async function updateOverride(
      withdrawn: boolean,
      headers: Record<string, string>,
      { url, decision }: Awaited<ReturnType<typeof overrideDecision>>,
    ) {
      return fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          withdrawn,
          expectedVersion: decision.accountVersion,
          expectedOverrideVersion: decision.version,
        }),
      });
    }
    async function override(withdrawn: boolean) {
      const result = await updateOverride(withdrawn, adminHeaders, await overrideDecision());
      assert.equal(result.status, 200, await result.text());
    }
    await override(true);
    assert.equal(await access(), 403);
    assert.equal((await signIn()).headers.get("location"), "/console/");
    assert.equal(await access(), 403, "an administrator's override survives verified sign-in");
    // The second administrator passes HTTP admission while both accounts have only
    // Installation-scoped grants. Revoke that administrator before the mutation locks
    // their session and policy. The already-admitted POST must still leave the denial intact.
    const operatorHeaders = await signedInHeaders(server, consoleOrigin, {
      email: "roster-operator@example.test",
      password: "roster-member-test-password",
    });
    const observed = await overrideDecision();
    const accepted = await fetch(observed.url, { headers: operatorHeaders });
    assert.equal(accepted.status, 200, await accepted.text());
    const operatorLock = await lockAccount(operator.id);
    const queuedClear = updateOverride(false, operatorHeaders, observed);
    try {
      await operatorLock.waitForCaller();
      const removed = await setup.pool.query(
        `DELETE FROM occ.iam_access_bindings b USING occ.iam_identities i
        WHERE i.subject=$1 AND i.id=b.identity_subject_id AND b.resource_kind='installation'`,
        [operator.id],
      );
      assert.equal(removed.rowCount, 1);
    } finally {
      await operatorLock.release();
    }
    const denied = await queuedClear;
    assert.equal(denied.status, 403, await denied.text());
    assert.deepEqual(
      (await overrideDecision()).decision,
      observed.decision,
      "refused override writes nothing",
    );
    await override(false);
    assert.equal(await access(), 403, "clearing the override cannot restore authority");
    assert.equal((await signIn()).headers.get("location"), "/console/");
    assert.equal(await access(), 200);
  },
);
