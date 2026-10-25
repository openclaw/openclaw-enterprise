import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

for (const first of ["removal", "use"] as const) {
  test(
    `standing removal orders prepared material and request authorization (${first} first)`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, { standingApproval: true });
      const approval = f.approval!;
      await prepare(f);
      const signal = new AbortController().signal;
      const material = await f.owner.readOpenShellMaterial(f.revision.id, signal);
      assert.ok(material && !("absent" in material));
      const { preparationAttemptId, materialVersion } = material;

      const receipts = async () =>
        (
          await f.pool.query(
            "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id",
            [f.admissionId],
          )
        ).rows.map((r) => r.exchange_id);
      const operations = () => {
        const q = { ...f.request(), operation: "upload-pack" as const };
        const result = Promise.all([
          f.owner.readOpenShellMaterial(f.revision.id, signal).then((m) => {
            if (!m || "absent" in m) {
              return m?.absent;
            }
            assert.ok(
              m.preparationAttemptId === preparationAttemptId &&
                m.materialVersion === materialVersion &&
                m.sessionId === material.sessionId &&
                m.value === material.value,
              "expected the same bounded material",
            );
            return "same material";
          }),
          f.owner.authorizeOpenShellRequest(q, { preparationAttemptId, materialVersion }, signal),
        ]).catch((error: unknown) => error); // assert the result after releasing the transaction barrier
        return { result, exchangeId: q.exchangeId };
      };
      const denied = ["withdrawn", "access_withdrawn"];

      // This pool has exactly one connection. Observe its actual lock waits and run the
      // removal owner's Namespace, Agent and generation-fenced State operations on it.
      const writers = testPool(t, { connectionString: databaseUrl, max: 1 });
      const state = new PostgresPlatformState(writers);
      const writer = (await writers.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const remove = (whenLocked?: () => Promise<void>) =>
        state.transact(async (u) => {
          const { namespaceId, agentId } = approval;
          assert.ok(await u.namespaces.lockNamespace(namespaceId, { includeDeleted: true }));
          assert.ok(await u.agents.lockAgent(namespaceId, agentId));
          await whenLocked?.();
          await u.repositorySessions.revokeStanding(approval, new Date().toISOString());
        });

      // Synchronize on PostgreSQL's lock graph, never on a guessed transaction duration.
      async function blocked(
        blockers: number[],
        count: number,
        waiter?: number,
      ): Promise<number[]> {
        const deadline = performance.now() + 2_000;
        for (;;) {
          const r = await f.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
             AND pg_blocking_pids(pid) && $1::int[] AND ($2::int IS NULL OR pid=$2)`,
            [blockers, waiter],
          );
          if (r.rowCount === count) {
            return r.rows.map((row) => row.pid);
          }
          assert.ok(performance.now() < deadline, "did not observe the required lock order");
        }
      }

      assert.deepEqual(await receipts(), []);
      let expectedReceipts: string[] = [];
      if (first === "removal") {
        let pending: ReturnType<typeof operations>;
        await remove(async () => {
          pending = operations();
          await blocked([writer], 2);
        });
        assert.deepEqual(await pending!.result, denied, "both waiters must see committed removal");
      } else {
        // Pause both decisions at the material row. Removal must wait for these actual
        // readers; an already committed possible-use receipt must survive that removal.
        const holder = await f.pool.connect();
        let failed = true;
        try {
          await holder.query("BEGIN");
          const locked = await holder.query(
            "SELECT pg_backend_pid() AS pid FROM occ.prepared_github_families WHERE source_id=$1 FOR UPDATE",
            [f.familyId],
          );
          assert.equal(locked.rowCount, 1);
          const pending = operations();
          const readers = await blocked([locked.rows[0].pid], 2);
          const removal = remove();
          await blocked(readers, 1, writer);
          await holder.query("ROLLBACK");
          assert.deepEqual(await pending.result, ["same material", true]);
          await removal;
          expectedReceipts = [pending.exchangeId];
          failed = false;
        } finally {
          holder.release(failed);
        }
      }
      const saved = await state.read((v) =>
        v.repositorySessions.listStandingApprovals(approval.namespaceId, approval.agentId),
      );
      assert.ok(saved[0]?.revokedAt);
      assert.equal(saved[0].generation, approval.generation + 1);
      assert.deepEqual(await receipts(), expectedReceipts);
      // No cleanup or Git dispatch. The fixture token remains unexpired across this fresh
      // decision; any earlier possible use is left intact, never repeated as a control.
      assert.deepEqual(await operations().result, denied);
      assert.ok(Date.now() < Date.parse(material.expiresAt));
      assert.deepEqual(await receipts(), expectedReceipts, "no post-removal possible use");
      assert.equal(f.gh.issuesOfTokens.length, 1);
      assert.deepEqual(f.gh.errors, []);
    },
  );
}
