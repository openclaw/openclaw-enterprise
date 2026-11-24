import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { createRepositorySourceCustody } from "../../apps/controller/src/backends/repository-credentials/source-custody.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { MaterialWriteHold } from "../../apps/controller/src/drivers/repo/access/material-hold.ts";
import { PreparedGitHubPostgres } from "../../apps/controller/src/drivers/repo/github/access/prepared-postgres.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type {
  InstallationSecretRef,
  InstallationSecretStore,
} from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState, type PostgresClient } from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

// The Source row hold that native Git takes while it lends a repository token Source, against
// the real TokenService replacement and OCC retirement. The Worker's reactions to a lost session
// are pinned with a fake client in tests/conformance/repository-source-custody.test.ts.

// Fake values are built from parts so that no scanner reads them as tokens.
const fineGrained = (suffix: string) =>
  ["github", "pat", `fixture${suffix}`.padEnd(30, "x")].join("_");

function memorySecrets(): InstallationSecretStore {
  const values = new Map<string, string>();
  const key = (ref: InstallationSecretRef) => `${ref.installationId}/${ref.id}`;
  return {
    async create(ref, value) {
      values.set(key(ref), value);
    },
    async update(ref, value) {
      assert.ok(values.has(key(ref)));
      values.set(key(ref), value);
    },
    async withValue(ref, use) {
      const value = values.get(key(ref));
      assert.ok(value !== undefined);
      return use(value);
    },
    async delete(ref) {
      values.delete(key(ref));
    },
  };
}

/** A ready github Source owned by the Installation's TokenService instance. */
async function fixture(t: TestContext) {
  assert.ok(databaseUrl);
  const pool = testPool(t, { connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const { revision } = await seedSessionRevision(state);
  const { namespaceId, agentId } = revision;
  const installationId = (await pool.query("SELECT id FROM occ.installation")).rows[0]?.id as
    string | undefined;
  assert.ok(installationId, "the prepared database has an Installation");
  let instance = (
    await pool.query(
      "SELECT id, driver_id FROM occ.token_service_instances WHERE installation_id = $1",
      [installationId],
    )
  ).rows[0] as { id: string; driver_id: string } | undefined;
  if (!instance) {
    instance = { id: randomUUID(), driver_id: "occ-token-service" };
    await pool.query(
      `INSERT INTO occ.token_service_instances(installation_id, id, driver_id, store_identity)
       VALUES ($1, $2, $3, 'fixture-store')`,
      [installationId, instance.id, instance.driver_id],
    );
  }
  const tokenService = new OCCTokenServiceDriver(
    instance.driver_id,
    installationId,
    memorySecrets(),
    instance.id,
    state,
  );
  const signal = AbortSignal.timeout(30_000);
  const created = await tokenService.createSource(
    {
      namespaceId,
      name: `repository-token-${randomUUID().slice(0, 8)}`,
      secret: { token: fineGrained("1") },
      lifecycleConfig: { type: "static", settings: {} },
      config: { provider_preset: "github", repositories: "fixture/a:write" },
    },
    signal,
  );
  const ref = { namespaceId, sourceId: created.id };
  const instanceRef = {
    sourceRef: { kind: "credential_source" as const, namespaceId, id: created.id },
    tokenServiceInstanceId: instance.id,
  };
  // As the Worker's pools do, a terminated idle connection is logged, not thrown.
  const quiet = (created: pg.Pool) => {
    created.on("error", () => {});
    return created;
  };
  const custody = (options: { holdLimitMs?: number; tokenServiceDriverId?: string } = {}) =>
    createRepositorySourceCustody({
      lockPool: quiet(testPool(t, { connectionString: databaseUrl, max: 4 })),
      state,
      tokenServiceDriverId: options.tokenServiceDriverId ?? instance.driver_id,
      tokenService: () => tokenService,
      iam: { authorize: async () => ({ allowed: true }) as never },
      ...(options.holdLimitMs !== undefined && { holdLimitMs: options.holdLimitMs }),
    });
  // Another session of the same database, as a concurrent writer or an operator sees it.
  const other = quiet(testPool(t, { connectionString: databaseUrl, max: 2 }));
  return {
    pool,
    state,
    other,
    quiet,
    tokenService,
    ref,
    instanceRef,
    custody,
    agentId,
    revisionId: revision.id,
    signal,
  };
}

// Each case takes a few seconds; a hang fails it here, not at the lane deadline.
const caseTimeoutMs = 20_000;

/** Whether a promise settles within `ms`, without consuming its rejection. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await delay(ms);
  return settled;
}

test(
  "a held Source row makes TokenService replacement and OCC retirement wait until it is released",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const custody = f.custody();

    // Replacement waits for the hold, then commits a new custody version.
    const first = await custody.lock(f.ref);
    assert.ok(first?.source);
    assert.equal(first.source.state, "ready");
    assert.equal(first.source.owned, true);
    assert.equal(first.source.preset, "github");
    assert.equal(first.source.repositories, "fixture/a:write");
    const before = await custody.resolve(f.ref, first.source);
    assert.equal(before.credential, fineGrained("1"));
    const replacing = f.tokenService.updateSource(
      f.instanceRef,
      { secret: { token: fineGrained("2") } },
      f.signal,
    );
    assert.equal(await settlesWithin(replacing, 750), false, "replacement waits for the hold");
    assert.equal(await first.hold.confirm(), true, "the holding session is alive");
    await first.hold.release();
    await replacing;
    const second = await custody.lock(f.ref);
    assert.ok(second?.source);
    const after = await custody.resolve(f.ref, second.source);
    assert.equal(after.credential, fineGrained("2"));
    assert.notEqual(after.version, before.version);

    // Retirement waits as well; a retired Source is no longer `ready` at the next lock.
    const retiring = f.state.transact(({ credentialSources }) =>
      credentialSources.markCredentialSourceDeleting(f.ref.namespaceId, f.ref.sourceId),
    );
    assert.equal(await settlesWithin(retiring, 750), false, "retirement waits for the hold");
    await second.hold.release();
    assert.equal((await retiring)?.state, "deleting");
    const third = await custody.lock(f.ref);
    assert.equal(third?.source?.state, "deleting");
    await third?.hold.release();
  },
);

test(
  "a Source lock gives up after its bounded wait while a replacement holds the row",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const custody = f.custody();
    const writer = await f.other.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT 1 FROM occ.credential_sources WHERE namespace_id = $1 AND id = $2 FOR UPDATE",
        [f.ref.namespaceId, f.ref.sourceId],
      );
      const started = performance.now();
      assert.equal(await custody.lock(f.ref), undefined, "an ended lock wait is not a failure");
      const waited = performance.now() - started;
      assert.ok(waited >= 1500 && waited < 5000, `waited ${Math.round(waited)} ms`);
      await writer.query("ROLLBACK");
    } finally {
      writer.release();
    }
    const locked = await custody.lock(f.ref);
    assert.ok(locked?.source);
    await locked.hold.release();
  },
);

test(
  "PostgreSQL ends a Source hold its frozen Worker abandoned, and the resumed Worker writes nothing",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const holdLimitMs = 1000;
    const custody = f.custody({ holdLimitMs });
    // Released here, not in an after hook: the pool's own hook waits for its clients.
    const writer: pg.PoolClient = await f.other.connect();
    try {
      const serverNow = async () =>
        Date.parse(
          (
            (await writer.query("SELECT clock_timestamp() AS at")).rows[0] as { at: Date }
          ).at.toISOString(),
        );
      const taken = await serverNow();
      const locked = await custody.lock(f.ref);
      assert.ok(locked?.source);
      const { hold } = locked;
      // A retirement starts while the Worker holds the row... Its time is read in an outer
      // query: in the locking query's own select list it is computed before the lock is granted.
      const retiring = writer.query(
        `WITH locked AS MATERIALIZED (
           SELECT 1 FROM occ.credential_sources
           WHERE namespace_id = $1 AND id = $2 FOR UPDATE
         )
         SELECT clock_timestamp() AS at FROM locked`,
        [f.ref.namespaceId, f.ref.sourceId],
      );
      // ...and the Worker freezes: no timer, no I/O, nothing of its own runs.
      const frozenUntil = performance.now() + 3 * holdLimitMs;
      while (performance.now() < frozenUntil) {
        // Spin without yielding to the event loop.
      }
      assert.equal(hold.held(), false, "past its limit the hold answers false at once");
      const granted = Date.parse(((await retiring).rows[0] as { at: Date }).at.toISOString());
      const waited = granted - taken;
      assert.ok(
        waited >= holdLimitMs - 100 && waited < 2.5 * holdLimitMs,
        `the row was free ${waited} ms after the hold was taken, while the Worker was frozen`,
      );
      assert.equal(await hold.confirm(), false, "the resumed Worker learns the hold is gone");
      await hold.release();
    } finally {
      writer.release(true);
    }
    // The lock pool lost nothing: the next loan locks the row again.
    const next = await custody.lock(f.ref);
    assert.ok(next?.source);
    assert.equal(await next.hold.confirm(), true);
    await next.hold.release();
  },
);

/** The native store's transaction, in which the Worker reads a loan. */
class StoreTransactions extends PreparedGitHubPostgres {
  run<T>(work: (c: PostgresClient, limitIdle: (ms: number) => Promise<void>) => Promise<T>) {
    return this.transaction(work);
  }
}

test(
  "a frozen Worker's store transaction around a loan frees the Namespace for retirement at the hold limit",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const holdLimitMs = 1000;
    const custody = f.custody({ holdLimitMs });
    const store = new StoreTransactions(
      f.quiet(testPool(t, { connectionString: databaseUrl, max: 2 })),
      Buffer.alloc(32),
      "fixture-authority",
    );
    const writer: pg.PoolClient = await f.other.connect();
    try {
      // Without the limit the writer would wait for the frozen transaction; end it here instead.
      await writer.query("SET statement_timeout = '8s'");
      const serverNow = async () =>
        Date.parse(
          (
            (await writer.query("SELECT clock_timestamp() AS at")).rows[0] as { at: Date }
          ).at.toISOString(),
        );
      const taken = await serverNow();
      let hold: MaterialWriteHold | undefined;
      let retiring: Promise<pg.QueryResult> | undefined;
      const reading = store.run(async (c, limitIdle) => {
        // As lockLiveSession does: the session's Namespace row is held FOR SHARE.
        await c.query("SELECT 1 FROM occ.namespaces WHERE id = $1 FOR SHARE", [f.ref.namespaceId]);
        const locked = await custody.lock(f.ref, { limitIdle });
        assert.ok(locked?.source);
        hold = locked.hold;
        // Retirement locks the Namespace, then the Source row; its time is read after both.
        retiring = writer.query(
          `WITH namespace AS MATERIALIZED (
             SELECT 1 FROM occ.namespaces WHERE id = $1 FOR UPDATE
           ), source AS MATERIALIZED (
             SELECT 1 FROM occ.credential_sources, namespace
             WHERE namespace_id = $1 AND id = $2 FOR UPDATE OF credential_sources
           )
           SELECT clock_timestamp() AS at FROM source`,
          [f.ref.namespaceId, f.ref.sourceId],
        );
        // The Worker freezes inside the store transaction: nothing of its own runs.
        const frozenUntil = performance.now() + 3 * holdLimitMs;
        while (performance.now() < frozenUntil) {
          // Spin without yielding to the event loop.
        }
      });
      // The resumed transaction learns that PostgreSQL ended it; the process carries on.
      await assert.rejects(reading, /did not complete/);
      assert.ok(retiring);
      const granted = Date.parse(((await retiring).rows[0] as { at: Date }).at.toISOString());
      const waited = granted - taken;
      assert.ok(
        waited >= holdLimitMs - 100 && waited < 2.5 * holdLimitMs,
        `retirement had the Namespace and the Source ${waited} ms after the loan began, while the Worker was frozen`,
      );
      assert.ok(hold);
      assert.equal(await hold.confirm(), false, "the resumed Worker writes nothing");
      await hold.release();
    } finally {
      writer.release(true);
    }
    // The store's pool lost nothing: the next transaction runs.
    assert.equal(await store.run(async (c) => (await c.query("SELECT 1 AS one")).rows.length), 1);
  },
);

test(
  "a Source hold whose session was terminated releases cleanly and lets writers through",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const custody = f.custody();
    const locked = await custody.lock(f.ref);
    assert.ok(locked?.source);
    const holders = (
      await f.other.query(
        `SELECT pid FROM pg_locks
         WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND relation = 'occ.credential_sources'::regclass AND mode = 'RowShareLock'
           AND pid <> pg_backend_pid()`,
      )
    ).rows as { pid: number }[];
    assert.equal(holders.length, 1, "one session holds the Source row");
    // A failover or an operator ends the session: its COMMIT can no longer succeed.
    await f.other.query("SELECT pg_terminate_backend($1)", [holders[0]!.pid]);
    await locked.hold.release();
    assert.equal(locked.hold.held(), false);
    assert.equal(await locked.hold.confirm(), false);
    const retired = await f.state.transact(({ credentialSources }) =>
      credentialSources.markCredentialSourceDeleting(f.ref.namespaceId, f.ref.sourceId),
    );
    assert.equal(retired?.state, "deleting");
  },
);

test(
  "a Source lock reads ownership from the selected TokenService only, and the deployed access from the revision",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const foreign = await f.custody({ tokenServiceDriverId: "another-token-service" }).lock(f.ref);
    assert.ok(foreign?.source);
    assert.equal(foreign.source.owned, false, "another TokenService driver does not own it");
    assert.equal(foreign.source.custody, undefined);
    await foreign.hold.release();

    const custody = f.custody();
    const missing = await custody.lock({ namespaceId: f.ref.namespaceId, sourceId: "cs_missing" });
    assert.ok(missing);
    assert.equal(missing.source, undefined);
    await missing.hold.release();

    // The seeded revision was deployed without a saved repository policy.
    const session = {
      namespaceId: f.ref.namespaceId,
      agentId: f.agentId,
      revisionId: f.revisionId,
    };
    assert.equal(await custody.admitted(session), undefined);
    assert.equal(
      await custody.admitted({ ...session, revisionId: `rev_${randomUUID()}` }),
      undefined,
    );
  },
);

test(
  "a Source lock lends only for a revision whose installed copy is recorded and not retired",
  { ...requiresPostgres, timeout: caseTimeoutMs },
  async (t) => {
    const f = await fixture(t);
    const custody = f.custody();
    const unrecorded = await custody.lock(f.ref);
    assert.ok(unrecorded?.source);
    // No row: a revision deployed without its record (none exists on a released version).
    assert.equal(await unrecorded.recorded(f.revisionId), false);
    await unrecorded.hold.release();
    await assert.rejects(unrecorded.recorded(f.revisionId), /no longer held/);

    await f.state.transact((unit) =>
      unit.credentialSources.recordRepositorySourceCopy({
        namespaceId: f.ref.namespaceId,
        credentialSourceId: f.ref.sourceId,
        tokenServiceInstanceId: f.instanceRef.tokenServiceInstanceId,
        agentId: f.agentId,
        revisionId: f.revisionId,
      }),
    );
    const recorded = await custody.lock(f.ref);
    assert.ok(recorded);
    assert.equal(await recorded.recorded(f.revisionId), true);
    assert.equal(await recorded.recorded(`rev_${randomUUID()}`), false, "another revision");
    await recorded.hold.release();
    const otherSource = await custody.lock({ ...f.ref, sourceId: "cs_missing" });
    assert.ok(otherSource);
    assert.equal(await otherSource.recorded(f.revisionId), false, "another Source");
    await otherSource.hold.release();

    // Retired after the read-back: the revision is never lent the value again.
    assert.equal(
      await new PostgresOpenShellGitRouteStore(f.pool).retireSourceCopy(f.revisionId),
      true,
    );
    const retired = await custody.lock(f.ref);
    assert.ok(retired);
    assert.equal(await retired.recorded(f.revisionId), false);
    await retired.hold.release();
  },
);
