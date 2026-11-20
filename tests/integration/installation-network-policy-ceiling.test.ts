import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { localMigratorDatabaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const path = "/installation/sandbox-network-policy-ceiling";
const rule = {
  id: "docs",
  binary: "/usr/bin/python3",
  host: "example.org",
  ports: [{ from: 443, to: 443 }],
};

// This serial CI file changes the singleton Installation setting. All assertions use the
// real Fastify routes, Native IAM and PostgreSQL, including seed-only startup.
test(
  "Installation ceiling owner API preserves empty state and rejects stale saves",
  requiresPostgres,
  async (t) => {
    const fixture = await createPostgresAgentApp(t, {
      label: "ceiling",
      authSecret: "ceiling-integration-session-secret-32-characters",
    });
    const { controller, pool, state, principal, databaseUrl: fixtureDatabaseUrl } = fixture;
    const request = async (method: string, body?: unknown) => {
      const response = await fixture.inject(method, path, body);
      return { status: response.statusCode, body: response.json(), data: response.json().data };
    };
    const restarted = (rules?: (typeof rule)[]) =>
      new OpenClawController(controller.installation, {
        state,
        ...(rules === undefined ? {} : { sandboxNetworkPolicyCeiling: rules }),
      });
    await t.test("concurrent startup seeds once with attributable atomic audit", async () => {
      const migrator = new pg.Pool({
        connectionString: localMigratorDatabaseUrl(fixtureDatabaseUrl),
        max: 1,
      });
      try {
        // Recreate the supported post-bootstrap, pre-API state in this disposable database.
        await migrator.query("DELETE FROM occ.installation_network_policy_ceiling");
        const auditCount = async () =>
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.initialize'",
            )
          ).rows[0].count;
        const before = await auditCount();
        const candidate = restarted([rule]);
        await assert.rejects(
          candidate.transact(async () => {
            await candidate.initializeSandboxNetworkPolicyCeiling();
            throw new Error("interrupt seed transaction");
          }),
          /interrupt seed transaction/,
        );
        assert.equal(
          await state.read((view) => view.installations.getSandboxNetworkPolicyCeiling()),
          undefined,
        );
        assert.equal(await auditCount(), before, "seed and audit roll back together");

        const blocker = await pool.connect();
        let startups: Promise<{ seedIgnored: boolean }[]> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('occ.installation.sandbox-network-policy-ceiling', 0))",
          );
          // Different replicas may offer different seeds. Only the first lock holder creates
          // state; the waiter must observe that committed value under READ COMMITTED.
          startups = Promise.all([
            candidate.initializeSandboxNetworkPolicyCeiling(),
            restarted([]).initializeSandboxNetworkPolicyCeiling(),
          ]);
          await waitFor("both initializers wait on the exclusive ceiling lock", async () => {
            const waiting = await pool.query(
              "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended(%sandbox-network-policy-ceiling%'",
            );
            return waiting.rows[0].count === 2 ? true : undefined;
          });
          await blocker.query("COMMIT");
          const initialized = await startups;
          assert.deepEqual(initialized.map(({ seedIgnored }) => seedIgnored).sort(), [false, true]);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await startups;
        }
        const seeded = (await request("GET")).data;
        assert.equal(seeded.version, 1);
        assert.ok(
          seeded.rules.length === 0 || JSON.stringify(seeded.rules) === JSON.stringify([rule]),
        );
        assert.equal(await auditCount(), before + 1, "only one seed is audited");
        const evidence = await pool.query(
          "SELECT actor_id, resource_id, details FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.initialize' ORDER BY occurred_at DESC, id DESC LIMIT 1",
        );
        assert.equal(evidence.rows[0].actor_id, seeded.updatedBy);
        assert.equal(evidence.rows[0].resource_id, controller.installation.id);
        assert.deepEqual(evidence.rows[0].details.rules, seeded.rules);
        assert.equal(
          seeded.updatedBy,
          await state.read((view) => view.installations.getBootstrapActor()),
        );
      } finally {
        await migrator.end();
      }
    });
    let read = await request("GET");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    // Start from saved empty state without relying on a constructor seed to reset a live DB.
    if (read.data.rules.length > 0) {
      assert.equal(
        (await request("PUT", { expectedVersion: read.data.version, rules: [] })).status,
        200,
      );
      read = await request("GET");
    }
    await t.test(
      "review validates the draft without changing saved rules or audit history",
      async () => {
        const before = (await request("GET")).data;
        const auditCount = async () =>
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM occ.audit_events WHERE kind = 'mutation' AND resource_id = $1",
              [controller.installation.id],
            )
          ).rows[0].count;
        const count = await auditCount();
        const review = await fixture.inject("POST", `${path}/validate`, {
          expectedVersion: before.version,
          rules: [rule],
        });
        assert.equal(review.statusCode, 200, review.body);
        assert.deepEqual(review.json().data, { success: true, data: { rules: [rule] } });
        // These values pass the field shape but fail shared semantic checks.
        const invalid = await fixture.inject("POST", `${path}/validate`, {
          expectedVersion: before.version,
          rules: [
            {
              ...rule,
              binary: "/usr/../bin/python3",
              host: "bad..example.org",
              ports: [{ from: 443, to: 80 }],
            },
            rule,
          ],
        });
        assert.equal(invalid.statusCode, 200, invalid.body);
        assert.equal(invalid.json().data.success, false);
        const fields = invalid
          .json()
          .data.error.details.map((detail: { path: string }) => detail.path);
        for (const field of [
          "/rules/0/binary",
          "/rules/0/host",
          "/rules/0/ports/0/to",
          "/rules/1/id",
        ]) {
          assert.ok(fields.includes(field), field);
        }
        const malformed = await fixture.inject("POST", `${path}/validate`, {
          expectedVersion: before.version,
          rules: [{ ...rule, ports: [] }],
        });
        assert.equal(malformed.statusCode, 200);
        assert.equal(malformed.json().data.success, false);
        const stale = await fixture.inject("POST", `${path}/validate`, {
          expectedVersion: before.version + 1,
          rules: [rule],
        });
        assert.equal(stale.statusCode, 409);
        assert.deepEqual((await request("GET")).data, before);
        assert.equal(await auditCount(), count);
      },
    );
    const initialVersion = read.data.version;
    const saved = await request("PUT", { expectedVersion: initialVersion, rules: [rule] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.version, initialVersion + 1);
    assert.equal(saved.data.updatedBy, principal.id);
    const stale = await request("PUT", { expectedVersion: initialVersion, rules: [] });
    assert.equal(stale.status, 409);
    const cleared = await request("PUT", { expectedVersion: saved.data.version, rules: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.rules, []);

    await t.test(
      "restart preserves deliberately empty state and unchanged saves preserve attribution",
      async () => {
        assert.deepEqual(await restarted([rule]).initializeSandboxNetworkPolicyCeiling(), {
          seedIgnored: true,
        });
        assert.deepEqual((await request("GET")).data, cleared.data);
        const unchanged = await request("PUT", {
          expectedVersion: cleared.data.version,
          rules: [],
        });
        assert.equal(unchanged.status, 200);
        assert.deepEqual(unchanged.data, cleared.data);
      },
    );

    await t.test(
      "invalid rules return field details and concurrent editors commit only once",
      async () => {
        const before = (await request("GET")).data;
        const invalid = await request("PUT", {
          expectedVersion: before.version,
          rules: [{ ...rule, ports: [{ from: 443, to: 80 }] }],
        });
        assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
        assert.ok(
          invalid.body.error.details.some((detail: { path: string }) =>
            detail.path.startsWith("/rules/0/ports"),
          ),
        );
        const results = await Promise.all([
          request("PUT", { expectedVersion: before.version, rules: [rule] }),
          request("PUT", {
            expectedVersion: before.version,
            rules: [{ ...rule, host: "other.example.org" }],
          }),
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
        assert.equal((await request("GET")).data.version, before.version + 1);
      },
    );

    await t.test("audit and ceiling roll back together on failed commit work", async () => {
      const before = (await request("GET")).data;
      const count = async () =>
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.update'",
          )
        ).rows[0].count;
      const auditCount = await count();
      await assert.rejects(
        controller.transact(async () => {
          await controller.updateInstallationSandboxNetworkPolicyCeiling(
            principal.id,
            before.version,
            [],
          );
          throw new Error("interrupt the owner transaction");
        }),
        /interrupt the owner transaction/,
      );
      assert.deepEqual((await request("GET")).data, before);
      assert.equal(await count(), auditCount);
    });

    await t.test(
      "exact Installation administer denials persist attributable evidence",
      async () => {
        const migrator = new pg.Pool({
          connectionString: localMigratorDatabaseUrl(fixtureDatabaseUrl),
          max: 1,
        });
        const restriction = `ceiling-denial-${randomUUID()}`;
        const before = (await request("GET")).data;
        await migrator.query(
          "INSERT INTO occ.iam_restrictions (id, action, resource_kind, resource_id, effect) VALUES ($1, 'administer', 'installation', $2, 'deny')",
          [restriction, controller.installation.id],
        );
        try {
          assert.equal((await request("GET")).status, 403);
          assert.equal(
            (
              await fixture.inject("POST", `${path}/validate`, {
                expectedVersion: before.version,
                rules: [],
              })
            ).statusCode,
            403,
          );

          assert.equal(
            (await request("PUT", { expectedVersion: before.version, rules: [] })).status,
            403,
          );
          const denial = await pool.query(
            "SELECT actor_id, resource_id FROM occ.audit_events WHERE kind = 'authorization_denial' AND action = 'openclaw.installation.sandbox_network_policy_ceiling.update' ORDER BY occurred_at DESC LIMIT 1",
          );
          assert.equal(denial.rows[0].actor_id, principal.id);
          assert.equal(denial.rows[0].resource_id, controller.installation.id);
        } finally {
          await migrator.query("DELETE FROM occ.iam_restrictions WHERE id = $1", [restriction]);
          await migrator.end();
        }
        assert.deepEqual((await request("GET")).data, before);
      },
    );

    await t.test(
      "ceiling saves retain their session authority through a concurrent sign-out",
      async (sessionTest) => {
        const applicationName = `ceiling-session-${randomUUID()}`;
        const authenticated = await createPostgresAgentApp(sessionTest, {
          label: "ceiling-session",
          authSecret: "ceiling-session-authority-secret-32-characters",
          poolOptions: { application_name: applicationName },
        });
        const initial = (await authenticated.inject("GET", path)).json().data;
        const rules = initial.rules.length === 0 ? [rule] : [];
        const mutationCount = async () =>
          (
            await authenticated.pool.query(
              "SELECT count(*)::integer AS count FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.update' AND resource_id = $1",
              [authenticated.controller.installation.id],
            )
          ).rows[0].count;
        const initialAuditCount = await mutationCount();
        const blocker = await authenticated.pool.connect();
        let pendingSave: ReturnType<typeof authenticated.inject> | undefined;
        let pendingSignOut: ReturnType<typeof authenticated.inject> | undefined;
        let signOutCompleted = false;
        try {
          await blocker.query("BEGIN");
          const blocking = await blocker.query("SELECT pg_backend_pid() AS pid");
          await blocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('occ.installation.sandbox-network-policy-ceiling', 0))",
          );
          pendingSave = authenticated.inject("PUT", path, {
            expectedVersion: initial.version,
            rules,
          });
          // Establish that the authenticated write reached its ceiling lock before revocation.
          const writingPid = await waitFor(
            "the ceiling save to wait on its owner lock",
            async () => {
              const waiting = await authenticated.pool.query(
                "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND $2::integer = ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%'",
                [applicationName, blocking.rows[0].pid],
              );
              return waiting.rows[0]?.pid;
            },
          );
          pendingSignOut = authenticated
            .inject("POST", "/api/auth/sign-out", {})
            .then((response) => {
              signOutCompleted = true;
              return response;
            });
          // A valid authority fence makes sign-out wait on this write's session/account hold.
          // If revocation commits first instead, the blocked save must publish nothing.
          const revocationOrder = await waitFor(
            "sign-out to commit or wait for the authorized write",
            async () => {
              if (signOutCompleted) {
                return "revoked" as const;
              }
              const waiting = await authenticated.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND $2::integer = ANY(pg_blocking_pids(pid))",
                [applicationName, writingPid],
              );
              return waiting.rowCount === 1 ? ("waiting" as const) : undefined;
            },
          );
          await blocker.query("COMMIT");
          const [saved, signedOut] = await Promise.all([pendingSave, pendingSignOut]);
          assert.equal(signedOut.statusCode, 200, signedOut.body);
          const current = await authenticated.controller.getInstallationSandboxNetworkPolicyCeiling(
            authenticated.principal.id,
          );
          if (revocationOrder === "revoked") {
            assert.ok(
              [401, 403].includes(saved.statusCode),
              "a ceiling save cannot commit after its session revocation has committed",
            );
            assert.deepEqual(current, initial);
            assert.equal(await mutationCount(), initialAuditCount);
          } else {
            assert.equal(saved.statusCode, 200, saved.body);
            assert.equal(current.version, initial.version + 1);
            assert.deepEqual(current.rules, rules);
            assert.equal(await mutationCount(), initialAuditCount + 1);
          }
          assert.equal((await authenticated.inject("GET", path)).statusCode, 401);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await Promise.allSettled([pendingSave, pendingSignOut]);
          const current = await authenticated.controller.getInstallationSandboxNetworkPolicyCeiling(
            authenticated.principal.id,
          );
          if (JSON.stringify(current.rules) !== JSON.stringify(initial.rules)) {
            await authenticated.controller.updateInstallationSandboxNetworkPolicyCeiling(
              authenticated.principal.id,
              current.version,
              initial.rules,
            );
          }
        }
      },
    );

    await t.test(
      "missing state fails closed until trusted initialization seeds exactly once",
      async () => {
        // Only the migrator can delete this state. The application role cannot manufacture absence.
        const migrator = new pg.Pool({
          connectionString: localMigratorDatabaseUrl(fixtureDatabaseUrl),
          max: 1,
        });
        try {
          await migrator.query(
            "DELETE FROM occ.installation_network_policy_ceiling WHERE installation_id = $1",
            [controller.installation.id],
          );
          assert.equal((await request("GET")).status, 503);
          const worker = createControllerWorker({
            pool: new pg.Pool({ connectionString: fixtureDatabaseUrl }),
            computeDriver: createDevelopmentComputeDriver(),
            emit() {},
          });
          try {
            await assert.rejects(worker.start(), /initialized by API startup/);
          } finally {
            await worker.stop();
          }
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM occ.installation_network_policy_ceiling",
              )
            ).rows[0].count,
            0,
            "a worker must not seed missing ceiling state",
          );
          const initialization = restarted([rule]);
          const initializationCount = async () =>
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.initialize'",
              )
            ).rows[0].count;
          const beforeFailedStartup = await initializationCount();
          await assert.rejects(
            initialization.transact(async () => {
              await initialization.initializeSandboxNetworkPolicyCeiling();
              throw new Error("startup transaction failed before publication");
            }),
            /startup transaction failed/,
          );
          assert.equal(
            (await request("GET")).status,
            503,
            "failed initialization cannot publish its seed",
          );
          assert.equal(
            await initializationCount(),
            beforeFailedStartup,
            "failed initialization cannot publish audit evidence alone",
          );
          await Promise.all([
            initialization.initializeSandboxNetworkPolicyCeiling(),
            initialization.initializeSandboxNetworkPolicyCeiling(),
          ]);
          const initialized = (await request("GET")).data;
          assert.equal(initialized.version, 1);
          assert.deepEqual(initialized.rules, [rule]);
          const evidence = await pool.query(
            "SELECT actor_id FROM occ.audit_events WHERE action = 'openclaw.installation.sandbox_network_policy_ceiling.initialize' ORDER BY occurred_at DESC LIMIT 1",
          );
          assert.equal(initialized.updatedBy, evidence.rows[0].actor_id);
        } finally {
          await migrator.end();
        }
      },
    );
  },
);
