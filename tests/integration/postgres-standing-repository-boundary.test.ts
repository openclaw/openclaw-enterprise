import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { sessionAttempt } from "../conformance/repository-sessions.contract.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// Contract prerequisite, not an implementation of standing approval. Exercises the real
// State, prepared owner and provider fixture after the original admission expires.
test(
  "expired finite admission cannot become standing through replacement or owner restart",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, { sessionLifetimeMs: 8000 });
    const signal = new AbortController().signal;
    await prepare(f);
    // Observe committed metadata independently, without opening custody or recording use.
    const { rows } = await f.pool.query(
      `SELECT a.id, a.material_version, a.usable_until
       FROM occ.prepared_github_attempts a
       JOIN occ.prepared_github_families f USING (source_id)
       WHERE a.source_id=$1 AND a.state='committed' AND a.custody='current'
         AND f.enabled AND a.admission=f.admission`,
      [f.familyId],
    );
    assert.equal(rows.length, 1);
    const [material] = rows;
    const allowedUntil = Math.min(material.usable_until.getTime(), f.deadlineWallMs);
    const request = () => ({ ...f.request(), operation: "upload-pack" as const });
    const first = request();
    const used = await f.owner.use(first, signal);
    assert.ok("value" in used, "native use must return material, not just a receipt");
    assert.equal(used.exchangeId, first.exchangeId);
    assert.equal(used.preparationAttemptId, material.id);
    assert.equal(used.materialVersion, material.material_version);
    assert.ok(new Date(used.sendStartBy).getTime() <= allowedUntil);
    assert.equal(await f.providerStatus(used.value), 200);
    const refusal = { message: "Prepared GitHub custody transaction did not complete (guard)." };
    const snapshot = async () =>
      (
        await f.pool.query(`SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1`, [
          f.revision.id,
        ])
      ).rows[0].admitted_spec;
    const original = await snapshot();
    const unknownId = randomUUID();
    // Durable intent with no provider result models the ambiguous crash boundary.
    await f.pool.query(
      `INSERT INTO occ.prepared_github_attempts(id,source_id,admission,state)
       SELECT $2,source_id,admission,'issuing'
       FROM occ.prepared_github_families WHERE source_id=$1`,
      [f.familyId, unknownId],
    );
    await f.pool.query(
      "SELECT pg_sleep(greatest(0, $1::numeric/1000-extract(epoch FROM clock_timestamp())))",
      [f.deadlineWallMs],
    );
    const beforeDenials = f.gh.trace.length;
    await assert.rejects(f.owner.use(request(), signal), refusal);
    await f.withdraw();
    // Closing the old session removes the active-binding uniqueness conflict. The
    // remaining refusal is specifically the admitted deadline, not a duplicate key.
    await assert.rejects(
      f.state.transact((unit) =>
        unit.repositorySessions.createAttempt(
          sessionAttempt(f.revision, {
            deadlineWallMs: f.deadlineWallMs + 3_600_000,
            durationSeconds: 3600,
            brokerProtocol: 3,
          }),
        ),
      ),
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      f.pool.query(
        `UPDATE occ.repository_session_attempts SET deadline_wall_ms=deadline_wall_ms+3600000
         WHERE admission_id=$1`,
        [f.admissionId],
      ),
      { code: "42501" },
    );
    assert.equal(
      f.gh.trace.length,
      beforeDenials,
      "expired use and refused renewal must not contact the provider",
    );
    const owner = await f.startOwner({});
    await owner.maintain();
    const beforeRestartDenial = f.gh.trace.length;
    await assert.rejects(owner.use(request(), signal), refusal);
    assert.equal(
      f.gh.trace.length,
      beforeRestartDenial,
      "replacement-owner denial must not contact the provider",
    );
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
          [f.admissionId],
        )
      ).rows,
      [{ exchange_id: first.exchangeId }],
      "expired and replacement-owner requests must leave no extra receipt",
    );
    assert.equal(f.gh.issuesOfTokens.length, 1, "new owner must not remint an expired grant");
    assert.deepEqual(
      (
        await f.pool.query("SELECT state,sealed FROM occ.prepared_github_attempts WHERE id=$1", [
          unknownId,
        ])
      ).rows,
      [{ state: "issuing", sealed: null }],
    );
    assert.deepEqual(await snapshot(), original);
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT deadline_wall_ms FROM occ.repository_session_attempts WHERE revision_id=$1",
          [f.revision.id],
        )
      ).rows,
      [{ deadline_wall_ms: String(f.deadlineWallMs) }],
    );
    assert.deepEqual(f.gh.errors, []);
  },
);
