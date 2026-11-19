import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type {
  PlatformUnitOfWork,
  PostgresPlatformState,
  PostgresWorkQueue,
} from "../../packages/occ/src/index.ts";
import { tupleTransactionId } from "./postgres-native-iam-policy-barrier-admission.ts";
import type { BarrierFixture } from "./postgres-native-iam-policy-barrier-fixture.ts";
import {
  createBarrierLockHarness,
  readBackendSettings,
} from "./postgres-native-iam-policy-barrier-locks.ts";

type RetainedQueue = Pick<PostgresWorkQueue, "findWork" | "pending">;

interface BackendActivityRow {
  state: string | null;
  xact_start: Date | null;
}

function assertRejectedWithCode(outcome: PromiseSettledResult<unknown>, code: string): void {
  assert.equal(outcome.status, "rejected");
  const error: unknown = outcome.reason;
  assert.ok(error instanceof Error && "code" in error);
  assert.equal(error.code, code);
}

export async function runBarrierQueueCases(
  context: TestContext,
  fixture: BarrierFixture,
  appUrl: string,
  key: string,
): Promise<void> {
  const { installation, tables, namespaceWork, enqueueNamespace, effects } = fixture;
  const {
    boundedPool,
    boundedState,
    contender,
    settingsSQL,
    configureTimeout,
    readPoolSettings,
    policyLocks,
    expectedLocks,
    authorityAvailable,
    holdLastPolicyTable,
    waitForBarrier,
    resourceLocks,
    waitForAdvisoryLock,
    releaseContender,
  } = await createBarrierLockHarness(context, fixture, appUrl, key);
  try {
    await context.test("policy queue binds one transaction after both write barriers", async () => {
      const baseline = await configureTimeout("1min");
      const input = namespaceWork();
      let retainedUnit: PlatformUnitOfWork | undefined;
      let retainedQueue: RetainedQueue | undefined;
      const result = await boundedState.transactWithNativeIAMPolicyQueue(
        installation.id,
        async (unit, queue) => {
          retainedUnit = unit;
          retainedQueue = queue;
          // Observe the real backend before the callback touches either
          // repository: authority and all policy locks precede resource locks.
          assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
          assert.equal(await authorityAvailable(), false);
          assert.deepEqual(await resourceLocks(baseline.pid), []);
          assert.deepEqual(
            readBackendSettings((await boundedState.queryInTransaction(unit, settingsSQL)).rows[0]),
            baseline,
          );
          const [isolation] = (
            await boundedState.queryInTransaction(unit, "SHOW transaction_isolation")
          ).rows;
          assert.ok(
            typeof isolation === "object" &&
              isolation !== null &&
              "transaction_isolation" in isolation,
            "expected the transaction isolation level",
          );
          assert.equal(isolation.transaction_isolation, "read committed");
          await enqueueNamespace(unit, queue, input);
          const work = await queue.findWork(input.work.idempotencyKey);
          assert.ok(work);
          assert.equal(work.namespaceId, input.namespace.id);
          const [identity] = (
            await boundedState.queryInTransaction(
              unit,
              `SELECT pg_catalog.pg_backend_pid() AS pid,
                pg_catalog.pg_current_xact_id()::text AS xid,
                n.xmin::text AS namespace_xid, w.xmin::text AS work_xid, a.xmin::text AS audit_xid
                FROM occ.namespaces AS n, occ.controller_work AS w, occ.audit_events AS a
                WHERE n.id = $1 AND w.idempotency_key = $2 AND a.id = $3`,
              [input.namespace.id, input.work.idempotencyKey, input.audit.id],
            )
          ).rows;
          assert.ok(
            typeof identity === "object" &&
              identity !== null &&
              "pid" in identity &&
              typeof identity.pid === "number" &&
              "xid" in identity &&
              typeof identity.xid === "string" &&
              "namespace_xid" in identity &&
              typeof identity.namespace_xid === "string" &&
              "work_xid" in identity &&
              typeof identity.work_xid === "string" &&
              "audit_xid" in identity &&
              typeof identity.audit_xid === "string",
            "expected the transaction and tuple IDs for the staged namespace, Work and audit",
          );
          assert.equal(identity.pid, baseline.pid);
          const transactionId = tupleTransactionId(identity.xid);
          assert.equal(identity.namespace_xid, transactionId);
          assert.equal(identity.work_xid, transactionId);
          assert.equal(identity.audit_xid, transactionId);
          assert.deepEqual(await effects(contender, input), {
            namespaces: 0,
            work: 0,
            audit: 0,
          });
          return input.work.idempotencyKey;
        },
      );
      assert.equal(result, input.work.idempotencyKey);
      assert.deepEqual(await effects(contender, input), { namespaces: 1, work: 1, audit: 1 });
      assert.equal(await authorityAvailable(), true);
      assert.deepEqual(await policyLocks(baseline.pid), []);
      assert.deepEqual(await readPoolSettings(), baseline);
      assert.ok(retainedQueue);
      const closedUnit = retainedUnit;
      assert.ok(closedUnit);
      await assert.rejects(retainedQueue.pending(), /transaction is closed/);
      await assert.rejects(
        closedUnit.namespaces.findNamespace(input.namespace.id),
        /transaction is closed/,
      );
      assert.throws(() => boundedState.queryInTransaction(closedUnit, "SELECT 1"), /unavailable/);
      await assert.rejects(
        boundedState.guardNativeIAMPolicyInTransaction(closedUnit, installation.id, "write"),
        /unavailable/,
      );
    });

    await context.test("policy queue rolls back resource, Work and audit together", async () => {
      const baseline = await configureTimeout("1min");
      const input = namespaceWork();
      const abort = new Error("abort protected queue transaction");
      let retainedQueue: RetainedQueue | undefined;
      await assert.rejects(
        boundedState.transactWithNativeIAMPolicyQueue(installation.id, async (unit, queue) => {
          retainedQueue = queue;
          await enqueueNamespace(unit, queue, input);
          throw abort;
        }),
        (error) => error === abort,
      );
      assert.deepEqual(await effects(contender, input), { namespaces: 0, work: 0, audit: 0 });
      assert.equal(await authorityAvailable(), true);
      assert.deepEqual(await policyLocks(baseline.pid), []);
      assert.deepEqual(await readPoolSettings(), baseline);
      assert.ok(retainedQueue);
      await assert.rejects(
        retainedQueue.findWork(input.work.idempotencyKey),
        /transaction is closed/,
      );
    });

    for (const intent of ["read", "write"] as const) {
      const authoritySQL =
        intent === "read"
          ? "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))"
          : "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))";
      await context.test(
        `policy queue waits for preceding ${intent} authority to commit`,
        async () => {
          const baseline = await configureTimeout("1min");
          const input = namespaceWork();
          let called = false;
          let transaction: Promise<string> | undefined;
          await contender.query("BEGIN");
          try {
            await contender.query(authoritySQL, [key]);
            await contender.query("SELECT occ.native_iam_policy_barrier($1, $2)", [
              installation.id,
              intent === "write",
            ]);
            transaction = boundedState.transactWithNativeIAMPolicyQueue(
              installation.id,
              async (unit, queue) => {
                called = true;
                assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
                return enqueueNamespace(unit, queue, input);
              },
            );
            void transaction.catch(() => {});
            await waitForAdvisoryLock(baseline.pid);
            assert.equal(called, false);
            assert.deepEqual(await resourceLocks(baseline.pid), []);
            assert.deepEqual(await policyLocks(baseline.pid), []);
            await contender.query("COMMIT");
            assert.equal(await transaction, input.work.idempotencyKey);
            assert.equal(called, true);
            assert.deepEqual(await effects(contender, input), {
              namespaces: 1,
              work: 1,
              audit: 1,
            });
          } finally {
            await contender.query("ROLLBACK");
            if (transaction !== undefined) {
              await transaction.catch(() => {});
            }
          }
        },
      );

      await context.test(
        `policy queue excludes later ${intent} authority until commit`,
        async () => {
          const input = namespaceWork();
          await boundedState.transactWithNativeIAMPolicyQueue(
            installation.id,
            async (unit, queue) => {
              await enqueueNamespace(unit, queue, input);
              await contender.query("BEGIN");
              try {
                await contender.query("SET LOCAL lock_timeout = '100ms'");
                await assert.rejects(contender.query(authoritySQL, [key]), { code: "55P03" });
              } finally {
                await contender.query("ROLLBACK");
              }
            },
          );
          await contender.query("BEGIN");
          try {
            await contender.query("SET LOCAL lock_timeout = '100ms'");
            await contender.query(authoritySQL, [key]);
            await contender.query("SELECT occ.native_iam_policy_barrier($1, $2)", [
              installation.id,
              intent === "write",
            ]);
            assert.deepEqual(await effects(contender, input), {
              namespaces: 1,
              work: 1,
              audit: 1,
            });
            await contender.query("COMMIT");
          } finally {
            await contender.query("ROLLBACK");
          }
        },
      );
    }

    await context.test(
      "policy queue waits for its barrier before exposing the callback",
      async () => {
        const baseline = await configureTimeout("1min");
        let called = false;
        let transaction: Promise<number> | undefined;
        try {
          await holdLastPolicyTable();
          transaction = boundedState.transactWithNativeIAMPolicyQueue(
            installation.id,
            async (_unit, queue) => {
              called = true;
              assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
              return queue.pending();
            },
          );
          void transaction.catch(() => {});
          await waitForBarrier(baseline.pid, "write");
          assert.equal(called, false);
          assert.deepEqual(await resourceLocks(baseline.pid), []);
          assert.equal(await authorityAvailable(), false);
          await contender.query("ROLLBACK");
          assert.ok(Number.isInteger(await transaction));
          assert.equal(called, true);
        } finally {
          await contender.query("ROLLBACK");
          if (transaction !== undefined) {
            await transaction.catch(() => {});
          }
        }
      },
    );

    await context.test(
      "policy queue barrier timeout has no callback or durable effects",
      async () => {
        const baseline = await configureTimeout("250ms");
        const input = namespaceWork();
        let called = false;
        try {
          await holdLastPolicyTable();
          await assert.rejects(
            boundedState.transactWithNativeIAMPolicyQueue(installation.id, async (unit, queue) => {
              called = true;
              return enqueueNamespace(unit, queue, input);
            }),
            // State classifies the lock timeout (55P03) as retryable unavailability.
            { name: "DependencyUnavailableError", message: /lock timeout/ },
          );
          assert.equal(called, false);
          assert.deepEqual(await effects(contender, input), { namespaces: 0, work: 0, audit: 0 });
          assert.deepEqual(await policyLocks(baseline.pid), []);
          assert.deepEqual(await resourceLocks(baseline.pid), []);
          assert.deepEqual(await readPoolSettings(), baseline);
        } finally {
          await contender.query("ROLLBACK");
        }
        assert.equal(await authorityAvailable(), true);
      },
    );

    await context.test(
      "policy queue drains accepted work and closes callback admissions",
      async () => {
        const baseline = await configureTimeout("1min");
        const latch = `policy-queue-drain:${randomUUID()}`;
        let retainedUnit: PlatformUnitOfWork | undefined;
        let retainedQueue: RetainedQueue | undefined;
        let blocked: ReturnType<PostgresPlatformState["queryInTransaction"]> | undefined;
        let queued: Promise<number> | undefined;
        let settled = false;
        let transaction: Promise<string> | undefined;
        await contender.query("BEGIN");
        try {
          await contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [latch]);
          transaction = boundedState.transactWithNativeIAMPolicyQueue(
            installation.id,
            async (unit, queue) => {
              retainedUnit = unit;
              retainedQueue = queue;
              // Hold a real query so the callback returns while an accepted queue
              // operation remains pending on the same client. No methods are replaced.
              blocked = boundedState.queryInTransaction(
                unit,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                [latch],
              );
              queued = queue.pending();
              void blocked.catch(() => {});
              void queued.catch(() => {});
              return "drained";
            },
          );
          void transaction.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await waitForAdvisoryLock(baseline.pid);
          assert.equal(settled, false);
          assert.equal(await authorityAvailable(), false);
          assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("write"));
          assert.ok(retainedQueue);
          assert.ok(retainedUnit);
          await assert.rejects(retainedQueue.pending(), /transaction is closed/);
          await assert.rejects(retainedUnit.namespaces.listNamespaces(), /transaction is closed/);
          await contender.query("ROLLBACK");
          assert.equal(await transaction, "drained");
          assert.ok(blocked);
          assert.ok(queued);
          await blocked;
          assert.ok(Number.isInteger(await queued));
          assert.equal(await authorityAvailable(), true);
          assert.deepEqual(await readPoolSettings(), baseline);
        } finally {
          await contender.query("ROLLBACK");
          await Promise.allSettled([transaction, blocked, queued]);
        }
      },
    );

    for (const intent of ["read", "write"] as const) {
      for (const lockTimeout of ["0", "1min", "250ms"] as const) {
        await context.test(`${intent} barrier preserves lock_timeout=${lockTimeout}`, async () => {
          const baseline = await configureTimeout(lockTimeout);
          assert.equal(baseline.role, "occ_app");
          await boundedState.transactWithNativeIAMAuthority(
            installation.id,
            intent,
            async (unit) => {
              await boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, intent);
              assert.deepEqual(
                readBackendSettings(
                  (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                ),
                baseline,
              );
              assert.deepEqual(await policyLocks(baseline.pid), expectedLocks(intent));
              assert.equal(await authorityAvailable(), false);
              if (lockTimeout === "0") {
                for (const table of tables) {
                  await contender.query("BEGIN");
                  try {
                    await contender.query("SET LOCAL lock_timeout = '50ms'");
                    await assert.rejects(
                      contender.query(
                        `INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`,
                      ),
                      { code: "55P03" },
                    );
                  } finally {
                    await contender.query("ROLLBACK");
                  }
                }
              }
            },
          );
          assert.deepEqual(await readPoolSettings(), baseline);
          assert.deepEqual(await policyLocks(baseline.pid), []);
          assert.equal(await authorityAvailable(), true);
          if (lockTimeout === "0") {
            for (const table of tables) {
              assert.equal(
                (
                  await contender.query(
                    `INSERT INTO occ.${table} SELECT * FROM occ.${table} WHERE FALSE`,
                  )
                ).rowCount,
                0,
              );
            }
          }

          const namespaceId = `ns_${randomUUID()}`;
          const auditId = `aud_${randomUUID()}`;
          let protectedWorkReached = false;
          try {
            await holdLastPolicyTable();
            await assert.rejects(
              boundedState.transactWithNativeIAMAuthority(installation.id, intent, async (unit) => {
                await boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, intent);
                protectedWorkReached = true;
                await unit.namespaces.createNamespace({
                  id: namespaceId,
                  name: "Barrier timeout must prevent this mutation",
                  status: "provisioning",
                  createdAt: new Date().toISOString(),
                });
                await unit.audit.append({
                  schemaVersion: 1,
                  id: auditId,
                  installationId: installation.id,
                  occurredAt: new Date().toISOString(),
                  source: "occ",
                  kind: "mutation",
                  actorId: "barrier-timeout-test",
                  actor: { principalId: "barrier-timeout-test" },
                  action: "openclaw.namespaces.create",
                  namespaceId,
                  resource: { kind: "namespace", id: namespaceId, namespaceId },
                  outcome: "success",
                });
              }),
              { name: "DependencyUnavailableError", message: /lock timeout/ },
            );
            assert.equal(protectedWorkReached, false);
            assert.equal(
              (
                await boundedPool.query("SELECT id FROM occ.namespaces WHERE id = $1", [
                  namespaceId,
                ])
              ).rowCount,
              0,
            );
            assert.equal(
              (await boundedPool.query("SELECT id FROM occ.audit_events WHERE id = $1", [auditId]))
                .rowCount,
              0,
            );
            assert.deepEqual(await policyLocks(baseline.pid), []);
            const activity = await contender.query<BackendActivityRow>(
              "SELECT state, xact_start FROM pg_catalog.pg_stat_activity WHERE pid = $1",
              [baseline.pid],
            );
            assert.deepEqual(activity.rows, [{ state: "idle", xact_start: null }]);
            assert.deepEqual(await readPoolSettings(), baseline);
          } finally {
            await contender.query("ROLLBACK");
          }
          assert.equal(await authorityAvailable(), true);
        });
      }

      await context.test(
        `${intent} barrier restores before concurrent same-unit work`,
        async () => {
          const baseline = await configureTimeout("1min");
          try {
            await holdLastPolicyTable();
            await boundedState.transactWithNativeIAMAuthority(
              installation.id,
              intent,
              async (unit) => {
                await boundedState.queryInTransaction(unit, "SET LOCAL lock_timeout = '9s'");
                const localSettings = { ...baseline, lock_timeout: "9s" };
                await boundedState.queryInTransaction(unit, "SAVEPOINT policy_guard");
                const guard = boundedState.guardNativeIAMPolicyInTransaction(
                  unit,
                  installation.id,
                  intent,
                );
                void guard.catch(() => {});
                await waitForBarrier(baseline.pid, intent);
                // Admit this query only after the guard is waiting inside PostgreSQL.
                // A client-side restore queued after the guard would be too late.
                const concurrent = boundedState.queryInTransaction(unit, settingsSQL);
                const joined = Promise.all([guard, concurrent]);
                void joined.catch(() => {});
                await contender.query("ROLLBACK");
                const [, observed] = await joined;
                assert.deepEqual(readBackendSettings(observed.rows[0]), localSettings);
                assert.deepEqual(await policyLocks(baseline.pid), expectedLocks(intent));
                await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT policy_guard");
                assert.deepEqual(await policyLocks(baseline.pid), []);
                assert.equal(
                  await authorityAvailable(),
                  false,
                  "the original authority predates the savepoint",
                );
                assert.deepEqual(
                  readBackendSettings(
                    (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                  ),
                  localSettings,
                );
                await boundedState.queryInTransaction(unit, "RELEASE SAVEPOINT policy_guard");
              },
            );
          } finally {
            await contender.query("ROLLBACK");
          }
          assert.deepEqual(await readPoolSettings(), baseline);
          assert.equal(await authorityAvailable(), true);
        },
      );

      await context.test(`${intent} barrier error restores at the original savepoint`, async () => {
        const baseline = await configureTimeout("1min");
        try {
          await holdLastPolicyTable();
          await boundedState.transactWithNativeIAMAuthority(
            installation.id,
            intent,
            async (unit) => {
              await boundedState.queryInTransaction(unit, "SET LOCAL lock_timeout = '0'");
              const localSettings = { ...baseline, lock_timeout: "0" };
              await boundedState.queryInTransaction(unit, "SAVEPOINT policy_guard");
              const guard = boundedState.guardNativeIAMPolicyInTransaction(
                unit,
                installation.id,
                intent,
              );
              void guard.catch(() => {});
              await waitForBarrier(baseline.pid, intent);
              const concurrent = boundedState.queryInTransaction(unit, settingsSQL);
              const outcomes = await Promise.allSettled([guard, concurrent]);
              assertRejectedWithCode(outcomes[0], "55P03");
              assertRejectedWithCode(outcomes[1], "25P02");
              await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT policy_guard");
              assert.deepEqual(
                readBackendSettings(
                  (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                ),
                localSettings,
              );
              assert.deepEqual(await policyLocks(baseline.pid), []);
              assert.equal(await authorityAvailable(), false);
              await boundedState.queryInTransaction(unit, "RELEASE SAVEPOINT policy_guard");

              // A PL/pgSQL caller may catch the propagated error in its own
              // subtransaction. That must restore settings and partial locks
              // while retaining the original authority outside that scope.
              await boundedState.queryInTransaction(
                unit,
                `DO $caller$
                BEGIN
                  BEGIN
                    PERFORM occ.native_iam_policy_barrier(
                      (SELECT id FROM occ.installation), ${intent === "write"});
                    RAISE EXCEPTION 'the conflicting policy lock unexpectedly succeeded';
                  EXCEPTION WHEN lock_not_available THEN
                    NULL;
                  END;
                END;
              $caller$`,
              );
              assert.deepEqual(
                readBackendSettings(
                  (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
                ),
                localSettings,
              );
              assert.deepEqual(await policyLocks(baseline.pid), []);
              assert.equal(await authorityAvailable(), false);
            },
          );
        } finally {
          await contender.query("ROLLBACK");
        }
        assert.deepEqual(await readPoolSettings(), baseline);
        assert.equal(await authorityAvailable(), true);
      });
    }

    await context.test(
      "upgrade refusal preserves an earlier read barrier and caller settings",
      async () => {
        const baseline = await configureTimeout("1min");
        const abort = new Error("roll back the retained read barrier");
        await assert.rejects(
          boundedState.transactWithNativeIAMAuthority(installation.id, "write", async (unit) => {
            await boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, "read");
            await boundedState.queryInTransaction(unit, "SAVEPOINT refused_upgrade");
            await assert.rejects(
              boundedState.guardNativeIAMPolicyInTransaction(unit, installation.id, "write"),
              { code: "25001" },
            );
            await boundedState.queryInTransaction(unit, "ROLLBACK TO SAVEPOINT refused_upgrade");
            assert.deepEqual(
              readBackendSettings(
                (await boundedState.queryInTransaction(unit, settingsSQL)).rows[0],
              ),
              baseline,
            );
            assert.deepEqual(await policyLocks(baseline.pid), expectedLocks("read"));
            assert.equal(await authorityAvailable(), false);
            throw abort;
          }),
          (error) => error === abort,
        );
        assert.deepEqual(await readPoolSettings(), baseline);
        assert.deepEqual(await policyLocks(baseline.pid), []);
        assert.equal(await authorityAvailable(), true);
      },
    );
  } finally {
    await releaseContender();
  }
}
