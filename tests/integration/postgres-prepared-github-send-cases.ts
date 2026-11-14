import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import pg from "pg";
import type {
  AuthorizedSend,
  CredentialReadLifetime,
  PreparedTokenEvidence,
  PreparedTokenSelection,
} from "../../packages/contracts/src/index.ts";
import type { SendAttempt } from "../../packages/occ/src/egress-send-receipts.ts";
import { postgresEgressSendReceipts } from "../../packages/occ/src/state/egress-send-receipts.ts";
import {
  captureMetadata,
  wireTime,
  type LifecycleEgress,
} from "./postgres-prepared-github-wire.ts";
import type { LifecycleFixture } from "./postgres-prepared-github-fixture.ts";
import {
  connectedRepository,
  readWarm,
  mockPgQuery,
  containsSealedRow,
  observeTransaction,
} from "./postgres-prepared-github-observation.ts";

export async function checkCurrentProof(
  t: TestContext,
  { f, source, lifecycle }: LifecycleFixture,
  old: PreparedTokenSelection,
  evidence: PreparedTokenEvidence,
  readWindow: () => CredentialReadLifetime,
  proveCurrent: (selected: PreparedTokenEvidence) => Promise<boolean>,
) {
  const { signal } = readWindow();
  await t.test(
    "current proof preserves caller SQL limits and restores them in its unit",
    async (t) => {
      let observed: unknown[] | undefined;
      let expireAfterLookup = false;
      let deadline: number;
      // Observe real server settings on the proof's actual connection; the lookup itself
      // still executes unchanged against PostgreSQL, including every evidence predicate.
      mockPgQuery(t, pg.Client.prototype, async (sql, args, query) => {
        if (!sql.startsWith("SELECT f.admission,id,")) {
          return query(sql, args);
        }
        observed = (
          await query(
            "SELECT name, setting FROM pg_catalog.pg_settings WHERE name IN ('statement_timeout', 'lock_timeout') ORDER BY name",
          )
        ).rows;
        const result = await query(sql, args);
        if (expireAfterLookup) {
          t.mock.timers.enable({ apis: ["Date"], now: deadline + 1 });
        }
        return result;
      });
      for (const [statement, lock] of [
        ["250ms", "100ms"],
        ["8s", "3s"],
        ["0", "0"],
      ]) {
        for (const outcome of ["current", "wrong material", "expired after lookup"]) {
          await f.state.transact(async (unit) => {
            const sql = (text: string, values?: readonly unknown[]) =>
              f.state.queryInTransaction(unit, text, values);
            await sql(
              "SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)",
              [statement, lock],
            );
            const settings = () =>
              sql(
                "SELECT pg_catalog.current_setting('statement_timeout') AS statement, pg_catalog.current_setting('lock_timeout') AS lock",
              );
            const original = (await settings()).rows;
            deadline = Date.now() + 20_000;
            expireAfterLookup = outcome === "expired after lookup";
            observed = undefined;
            try {
              assert.equal(
                await unit.preparedTokenProof.current(
                  source,
                  outcome === "wrong material"
                    ? { ...evidence, materialVersion: "different" }
                    : evidence,
                  lifecycle.issuerAuthority,
                  { signal, deadlineAt: new Date(deadline).toISOString() },
                ),
                outcome === "current",
              );
              assert.deepEqual(observed, [
                { name: "lock_timeout", setting: lock === "100ms" ? "100" : "1000" },
                { name: "statement_timeout", setting: statement === "250ms" ? "250" : "4000" },
              ]);
              assert.deepEqual(
                (await settings()).rows,
                original,
                "later work retains exact caller settings",
              );
              assert.deepEqual((await sql("SELECT 1 AS ok")).rows[0], { ok: 1 });
            } finally {
              t.mock.timers.reset();
            }
          });
        }
      }
      // Every part of the selected evidence must still match the authoritative row.
      for (const changed of [
        { family: { ...evidence.family, id: "different" } },
        { family: { ...evidence.family, generation: evidence.family.generation + 1 } },
        { ownerEpoch: evidence.ownerEpoch + 1 },
        { inputVersion: "different" },
        { grantHash: "different" },
        { isolationId: "different" },
        { preparationAttemptId: "different" },
        { materialId: "different" },
        { materialVersion: "different" },
        { providerExpiresAt: new Date(0).toISOString() },
        { usableUntil: new Date(Date.parse(old.usableUntil) + 1).toISOString() },
      ]) {
        expireAfterLookup = false;
        assert.equal(await proveCurrent({ ...evidence, ...changed }), false);
      }
    },
  );
}

export async function selectSend(f: LifecycleEgress, captured = captureMetadata(f)) {
  const { ready } = await f.resolve(captured);
  assert.ok(ready, "select prepared material before changing its authority");
  const permit = f.permitRequest(captured, ready);
  return { evidence: ready.evidence, authorize: () => f.authorize(permit) };
}

export async function checkSendDeadlines(
  t: TestContext,
  { f, gh, lifecycle, source }: LifecycleFixture,
  old: PreparedTokenSelection,
  readWindow: () => CredentialReadLifetime,
  assertPoolIdle: () => Promise<void>,
) {
  await t.test(
    "signed access and material expiry bound ciphertext selection, projection and decryption",
    async (t) => {
      const repo = connectedRepository(lifecycle);
      const open = t.mock.method(repo, "open");
      let deadline: number;
      let arm: string;
      let holdWallBeforeDeadline: boolean;
      const pastDeadline = () => delay(Math.max(0, deadline - Date.now() + 100));
      let projected: boolean | undefined;
      let queryInTime: boolean | undefined;
      let completedQuery: PromiseWithResolvers<void> | undefined;
      // Delay real PostgreSQL at three distinct boundaries. Record presence, never the bytes.
      observeTransaction(t, repo, async (client, sql, args) => {
        const material = sql.includes("END AS sealed");
        const delayed =
          (material && ["before projection", "after projection"].includes(arm)) ||
          (arm === "after metadata" && sql.startsWith("SELECT f.admission,id,"));
        if (delayed) {
          completedQuery = Promise.withResolvers<void>();
        }
        if (material) {
          queryInTime = Date.now() < deadline;
          if (arm === "before projection") {
            await pastDeadline();
          }
        }
        const result = await client.query(sql, args);
        if (material) {
          projected = containsSealedRow(result.rows);
          if (arm === "after projection") {
            await pastDeadline();
          }
        } else if (arm === "after metadata" && sql.startsWith("SELECT f.admission,id,")) {
          const elapsed = pastDeadline();
          if (holdWallBeforeDeadline) {
            // Let the relative timer wake while the signed wall-clock deadline is still
            // one tick away. That wake must not classify a blocked read as missing material.
            const beforeWake = performance.now();
            const elapsedClock = t.mock.method(performance, "now", () => beforeWake);
            t.mock.timers.enable({ apis: ["Date"], now: deadline - 1 });
            try {
              await elapsed;
            } finally {
              elapsedClock.mock.restore();
              t.mock.timers.reset();
            }
          } else {
            await elapsed;
          }
        }
        if (delayed) {
          completedQuery?.resolve();
        }
        return result;
      });
      for (const bound of ["signed deadline", "material expiry"]) {
        for (const boundary of [
          "control",
          "after metadata",
          "before projection",
          "after projection",
        ]) {
          await t.test(`${bound}: ${boundary}`, async () => {
            arm = boundary;
            holdWallBeforeDeadline = bound === "signed deadline";
            const request = captureMetadata(f);
            deadline = Date.now() + 1300;
            request.deadline = wireTime(
              bound === "signed deadline" ? deadline : Date.now() + 20_000,
            );
            queryInTime = projected = completedQuery = undefined;
            open.mock.resetCalls();
            const issues = gh.issuesOfTokens.length;
            const reads = f.secretReads;
            try {
              if (bound === "material expiry") {
                // Shorten the real committed row before selection. Both reads see this same
                // bound; the gate then lets time expire on the designated side of projection.
                await f.pool.query<Record<string, unknown>>(
                  "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
                  [new Date(deadline), old.materialVersion],
                );
              }
              // The proxy requires material to outlive its signed request. Exercise an
              // earlier material expiry separately at the real custody-read boundary.
              const signed = bound === "signed deadline";
              const result = signed ? await f.resolve(request) : undefined;
              const material = signed
                ? result?.ready
                : await readWarm(lifecycle, source, readWindow());
              // A deadline can release the sender before an already-started SQL read settles.
              // Observe the real projection and decryption only after the held query returns.
              const waitForQuery = () => completedQuery?.promise;
              await waitForQuery();
              if (arm === "control") {
                assert.ok(material && queryInTime && projected, "unexpired material is usable");
                assert.equal(open.mock.callCount(), 1);
              } else {
                assert.equal(material, undefined, "no material after expiry");
                if (signed) {
                  assert.equal(result?.refused?.code, f.refusalCode("DEADLINE_EXCEEDED"));
                }
                const queried = arm !== "after metadata";
                assert.deepEqual(
                  { queryInTime, projected, opens: open.mock.callCount() },
                  {
                    queryInTime: queried ? true : undefined,
                    projected: queried ? arm === "after projection" : undefined,
                    opens: 0,
                  },
                  arm + ": no late ciphertext access or decryption",
                );
              }
              assert.equal(gh.issuesOfTokens.length, issues, "request must not issue");
              assert.equal(f.secretReads, reads, "request must not read issuer Secret");
            } finally {
              if (bound === "material expiry") {
                await f.pool.query<Record<string, unknown>>(
                  "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
                  [new Date(old.usableUntil), old.materialVersion],
                );
              }
            }
          });
        }
      }
    },
  );
  await t.test(
    "before-send bounds a real PostgreSQL lock wait and refuses late permission",
    async () => {
      const request = captureMetadata(f);
      request.deadline = wireTime(Date.now() + 3000);
      const selected = await selectSend(f, request);
      // A separate application-role actor locks the selected row. Authority and custody still
      // use the exact same max=1 pool; this connection never serves an application read.
      const blocker = new pg.Client({ connectionString: f.pool.options.connectionString });
      await blocker.connect();
      try {
        await blocker.query<Record<string, unknown>>("BEGIN");
        const { rows: locked } = await blocker.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid FROM occ.prepared_github_attempts WHERE material_version=$1 FOR UPDATE",
          [old.materialVersion],
        );
        assert.equal(locked.length, 1);
        const lockOwner = locked[0];
        assert.ok(lockOwner);
        const pending = selected.authorize();
        let waited = false;
        for (let i = 0; i < 50; i += 1) {
          const { rows } = await blocker.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
            [lockOwner.pid],
          );
          if (rows[0]?.waiting) {
            waited = true;
            break;
          }
          await delay(10);
        }
        const decision = await pending;
        assert.equal(waited, true, "the real currentness query must encounter contention");
        assert.ok(decision.refused, "a timed-out proof must never grant a send");
      } finally {
        await blocker.query<Record<string, unknown>>("ROLLBACK");
        await blocker.end();
      }
      await assertPoolIdle();
    },
  );
  await t.test("before-send refuses expired material and an elapsed signed deadline", async (t) => {
    const request = captureMetadata(f);
    const selected = await selectSend(f, request);
    await f.pool.query<Record<string, unknown>>(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp() - interval '1 second' WHERE material_version=$1",
      [old.materialVersion],
    );
    try {
      assert.equal((await selected.authorize()).refused?.code, f.refusalCode("DENIED"));
    } finally {
      await f.pool.query<Record<string, unknown>>(
        "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
        [new Date(old.usableUntil), old.materialVersion],
      );
    }
    const late = captureMetadata(f);
    const lateDeadline = Date.now() + 20_000;
    late.deadline = wireTime(lateDeadline);
    const expiring = await selectSend(f, late);
    // Preparation completes with real time; advance only Date after that checkpoint.
    t.mock.timers.enable({ apis: ["Date"], now: lateDeadline + 1 });
    try {
      assert.equal((await expiring.authorize()).refused?.code, f.refusalCode("DENIED"));
    } finally {
      t.mock.timers.reset();
    }
    assert.equal(f.pool.waitingCount, 0);
  });
}

// Start with the signed dispatch above, whose material, peer, custody and policy all agreed.
// The repository issues SQL directly; no caller-side parser can satisfy these negative cases.
export async function assertPreparedDispatchConstraints(pool: pg.Pool, useId: string) {
  const { rows } = await pool.query<{
    binding: SendAttempt;
    authorized_dispatch: AuthorizedSend | null;
  }>("SELECT binding, authorized_dispatch FROM occ.egress_send_receipts WHERE use_id=$1", [useId]);
  assert.equal(rows.length, 1, "the signed dispatch produced one receipt");
  const row = rows[0];
  assert.ok(row);
  const { binding, authorized_dispatch: auth } = row;
  assert.ok(auth, "the signed dispatch was durably authorized");
  const { material } = binding;
  assert.ok(material);
  assert.ok(material.kind === "prepared_github");
  const {
    association: { execution, installation },
  } = auth;
  const repo = postgresEgressSendReceipts(pool);
  const reserve = async (material: PreparedTokenEvidence) => {
    const attempt = { ...binding, material, attemptId: randomUUID() };
    assert.equal(await repo.insert(attempt), true);
    return attempt;
  };
  const control = await reserve(material);
  assert.equal(await repo.authorize(control, auth), true);
  assert.equal(await repo.authorize(control, auth), false, "no replay of acknowledged dispatch");
  assert.deepEqual((await repo.find(control))?.authorization, auth);

  const afterExpiry = new Date(Date.parse(material.providerExpiresAt) + 1).toISOString();
  const malformed: ReadonlyArray<
    readonly [PreparedTokenEvidence & { extra?: string }, Record<string, unknown>]
  > = [
    [material, { execution: { ...execution, agentId: "agt_" + randomUUID() } }],
    [material, { custodyId: randomUUID() }],
    ...[
      { peerKeyId: "not an enrolled key" },
      { authorityScope: undefined },
      { authorityScope: "connector" },
      { policyHash: "loaded" },
    ].map((changed) => [material, { installation: { ...installation, ...changed } }] as const),
    [{ ...material, extra: "forbidden evidence" }, {}],
    [{ ...material, usableUntil: afterExpiry }, {}],
  ];
  for (const [evidence, association] of malformed) {
    const attempt = await reserve(evidence);
    const changed = { ...auth, association: { ...auth.association, ...association } };
    await assert.rejects(repo.authorize(attempt, changed), {
      code: "23514",
      constraint: "egress_send_receipts_check_17",
    });
  }
}
