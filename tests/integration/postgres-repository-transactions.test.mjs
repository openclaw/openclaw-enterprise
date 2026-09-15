import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { verifyRepositoryLifetime } from "../conformance/repository-lifetime.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
test(
  "PostgreSQL repository ownership, lifetime, and atomicity",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    (await store.loadInstallation()) ??
      (await store.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Repository tests",
          createdAt: new Date().toISOString(),
        }),
      ));
    await verifyRepositoryLifetime(t, store);
    await t.test(
      "accepted raw SQL drains and queue/query handles close before connection reuse",
      async () => {
        let retainedUnit;
        let retainedQueue;
        let accepted;
        let completed = false;
        await store.transactWithQueue(async (unit, queue) => {
          retainedUnit = unit;
          retainedQueue = queue;
          accepted = store
            .queryInTransaction(unit, "SELECT pg_sleep(0.02), 1 AS value")
            .then((result) => {
              completed = true;
              return result;
            });
        });
        assert.equal(completed, true);
        assert.equal((await accepted).rows[0].value, 1);
        await assert.rejects(retainedQueue.pending(), ScopeViolationError);
        assert.throws(
          () => store.queryInTransaction(retainedUnit, "SELECT 1"),
          DependencyUnavailableError,
        );
        assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value, 1);
      },
    );
  },
);
