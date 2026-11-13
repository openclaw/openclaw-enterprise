import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { testPool } from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import type { BarrierFixture } from "./postgres-native-iam-policy-barrier-fixture.ts";

interface BackendSettings {
  pid: number;
  role: string;
  lock_timeout: string;
  statement_timeout: string;
  search_path: string;
}

interface RelationLock {
  name: string;
  mode: string;
}

interface AdvisoryLockProbe {
  held: boolean;
}

interface LockWaitProbe {
  waiting: boolean;
}

type BarrierIntent = Parameters<PostgresPlatformState["transactWithNativeIAMAuthority"]>[1];
type LockTimeout = "0" | "1min" | "250ms";

function isBackendSettings(row: unknown): row is BackendSettings {
  return (
    typeof row === "object" &&
    row !== null &&
    "pid" in row &&
    typeof row.pid === "number" &&
    "role" in row &&
    typeof row.role === "string" &&
    "lock_timeout" in row &&
    typeof row.lock_timeout === "string" &&
    "statement_timeout" in row &&
    typeof row.statement_timeout === "string" &&
    "search_path" in row &&
    typeof row.search_path === "string"
  );
}

export function readBackendSettings(row: unknown): BackendSettings {
  assert.ok(isBackendSettings(row), "expected settings from the original State backend");
  return row;
}

export async function createBarrierLockHarness(
  context: TestContext,
  { app, tables }: Pick<BarrierFixture, "app" | "tables">,
  appUrl: string,
  key: string,
) {
  // One real State backend makes restoration and pool reuse observable; a
  // different connection must not hide a leaked setting or failed transaction.
  const boundedPool: Pool = testPool(context, {
    connectionString: appUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  const boundedState = new PostgresPlatformState(boundedPool);
  const contender = await app.connect();
  const settingsSQL = `SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
    pg_catalog.current_setting('lock_timeout') AS lock_timeout,
    pg_catalog.current_setting('statement_timeout') AS statement_timeout,
    pg_catalog.current_setting('search_path') AS search_path`;
  const readPoolSettings = async () => {
    const [settings] = (await boundedPool.query<BackendSettings>(settingsSQL)).rows;
    assert.ok(settings, "expected settings from the bounded State pool");
    return settings;
  };
  const configureTimeout = async (lockTimeout: LockTimeout) => {
    // The separate statement fuse distinguishes an unbounded/overlong lock
    // wait (57014) from the required lock timeout (55P03), without timing guesses.
    await boundedPool.query(
      `SELECT pg_catalog.set_config('lock_timeout', $1, false),
        pg_catalog.set_config('statement_timeout', $2, false)`,
      [lockTimeout, lockTimeout === "250ms" ? "1s" : "8s"],
    );
    return readPoolSettings();
  };
  const policyLocks = async (pid: number) =>
    (
      await contender.query<RelationLock>(
        `SELECT c.relname AS name, l.mode FROM pg_catalog.pg_locks AS l
          JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE l.pid = $1 AND l.granted AND n.nspname = 'occ'
            AND c.relname = ANY($2::text[])
            AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock')
          ORDER BY c.relname`,
        [pid, tables],
      )
    ).rows;
  const expectedLocks = (intent: BarrierIntent) =>
    [...tables].sort().map((name) => ({
      name,
      mode: intent === "read" ? "ShareLock" : "ShareRowExclusiveLock",
    }));
  const authorityAvailable = async () => {
    const [row] = (
      await contender.query<AdvisoryLockProbe>(
        "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS held",
        [key],
      )
    ).rows;
    assert.ok(row, "expected an advisory lock probe result");
    return row.held;
  };
  const holdLastPolicyTable = async () => {
    await contender.query("BEGIN");
    await contender.query("SET LOCAL lock_timeout = '1s'");
    // Real DML retains RowExclusiveLock without altering the fixture policy.
    // The last table exposes partial acquisition of the preceding five locks.
    await contender.query(
      "INSERT INTO occ.iam_restrictions SELECT * FROM occ.iam_restrictions WHERE FALSE",
    );
  };
  const waitForBarrier = (pid: number, intent: BarrierIntent) =>
    waitUntil(
      "the original State backend to reach the conflicting policy table",
      async () => {
        const [row] = (
          await contender.query<LockWaitProbe>(
            `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
          WHERE pid = $1 AND NOT granted
            AND relation = 'occ.iam_restrictions'::pg_catalog.regclass AND mode = $2
            AND pg_catalog.pg_backend_pid() = ANY(pg_catalog.pg_blocking_pids($1))) AS waiting`,
            [pid, intent === "read" ? "ShareLock" : "ShareRowExclusiveLock"],
          )
        ).rows;
        assert.ok(row, "expected a PostgreSQL lock-wait probe result");
        return row.waiting;
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );
  const resourceLocks = async (pid: number) =>
    (
      await contender.query<RelationLock>(
        `SELECT c.relname AS name, l.mode FROM pg_catalog.pg_locks AS l
          JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE l.pid = $1 AND n.nspname = 'occ'
            AND c.relkind IN ('r', 'p') AND c.relname <> ALL($2::text[])
          ORDER BY c.relname, l.mode`,
        [pid, ["installation", ...tables]],
      )
    ).rows;
  const waitForAdvisoryLock = (pid: number) =>
    waitUntil(
      "the original State backend to wait for the independent lock holder",
      async () => {
        const [row] = (
          await contender.query<LockWaitProbe>(
            `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
          WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
            AND pg_catalog.pg_backend_pid() = ANY(pg_catalog.pg_blocking_pids($1))) AS waiting`,
            [pid],
          )
        ).rows;
        assert.ok(row, "expected a PostgreSQL lock-wait probe result");
        return row.waiting;
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );

  const releaseContender = async () => {
    try {
      await contender.query("ROLLBACK");
    } finally {
      contender.release(true);
    }
  };
  return {
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
  };
}
