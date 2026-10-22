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
    const material = await f.owner.readOpenShellMaterial(f.revision.id, signal);
    assert.ok(material && !("absent" in material));
    const identity = {
      preparationAttemptId: material.preparationAttemptId,
      materialVersion: material.materialVersion,
    };
    const request = () => ({ ...f.request(), operation: "upload-pack" as const });
    assert.equal(await f.owner.authorizeOpenShellRequest(request(), identity, signal), true);
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
    assert.equal(
      await f.owner.authorizeOpenShellRequest(request(), identity, signal),
      "access_withdrawn",
    );
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
    const owner = await f.startOwner({});
    await owner.maintain();
    assert.deepEqual(await owner.readOpenShellMaterial(f.revision.id, signal), {
      absent: "withdrawn",
    });
    assert.equal(
      await owner.authorizeOpenShellRequest(request(), identity, signal),
      "access_withdrawn",
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
