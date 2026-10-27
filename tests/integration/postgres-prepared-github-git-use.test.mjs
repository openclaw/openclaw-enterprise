import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { PreparedRepositoryGitStore } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-repository-git.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  admitProtectedVersion,
  disposeBrokerSession,
  disposeProtectedSession,
  fixture,
  prepare,
  startProtectedOwner,
} from "../fixtures/prepared-repository-git.mjs";
import { fixtureInstallationId } from "../fixtures/repository-credentials/github.mjs";
import { clockBehind } from "../helpers/prepared-standing-git-peer.ts";

// Refusal must come from the durable admission guard, before any issuer or retirement call.
async function assertUseGuarded(f) {
  const calls = f.gh.trace.length;
  await assert.rejects(f.owner.use(f.request()), /custody transaction did not complete \(guard\)/);
  assert.equal(f.gh.trace.length, calls, "denied use contacted the provider");
}

test(
  "OpenShell material delivery reads only an existing live revision token without issuing or authorizing use",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, { draftPull: true, sessionLifetimeMs: 120_000 });
    const signal = new AbortController().signal;
    const read = (revisionId = f.revision.id) => f.owner.readOpenShellMaterial(revisionId, signal);
    // Absent material says why (finding 2149): a live session with nothing prepared yet.
    assert.deepEqual(await read(), { absent: "unprepared" });
    assert.equal(f.gh.issuesOfTokens.length, 0, "cold material reads must not issue");
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT source_id FROM occ.prepared_github_families WHERE source_id=$1",
          [f.familyId],
        )
      ).rows,
      [],
      "cold material reads must not enroll a family",
    );
    await prepare(f);
    const before = f.gh.trace.length;
    assert.deepEqual(await read("rev_" + randomUUID()), { absent: "withdrawn" });
    await assert.rejects(f.owner.readOpenShellMaterial(f.revision.id, AbortSignal.abort()), {
      name: "AbortError",
    });
    const material = await read();
    assert.ok(material?.value);
    assert.equal(material.sessionId, f.sessionId);
    for (const key of ["providerInstanceId", "repositoryId", "grantId"]) {
      assert.equal(material[key], f.binding.grant[key]);
    }
    assert.equal(material.pushRef, f.request().pushRef);
    assert.equal(material.pullRequestBase, "main");
    assert.equal(material.apiOrigin, f.gh.origin);
    assert.equal(Date.parse(material.expiresAt), f.deadlineWallMs);
    const {
      rows: [row],
    } = await f.pool.query(
      "SELECT id, material_version, admission FROM occ.prepared_github_attempts WHERE source_id=$1 AND custody='current'",
      [f.familyId],
    );
    assert.equal(material.preparationAttemptId, row.id);
    assert.equal(material.materialVersion, row.material_version);
    assert.equal(material.repository, row.admission.grant.repository);
    assert.deepEqual(await read(), material, "reading does not rotate material");
    assert.equal(f.gh.trace.length, before, "material read must not contact the provider");
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::integer AS count FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
          [f.admissionId],
        )
      ).rows[0].count,
      0,
      "material delivery is not request authorization",
    );
    assert.equal(await f.providerStatus(material.value), 200);
    assert.equal(await f.owner.authorizeOpenShellRequest(f.request(), material, signal), true);
    await f.withdraw();
    assert.deepEqual(
      await read(),
      { absent: "withdrawn" },
      "withdrawal denies before background retirement",
    );
    assert.equal(await f.providerStatus(material.value), 200);
  },
);

test(
  "prepared Git use binds durable admission, exact ref, session and one exchange before retirement",
  {
    ...requiresPostgres,
    timeout: 60_000,
  },
  async (t) => {
    const f = await fixture(t);
    const familyRows = () =>
      f.pool.query("SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1", [
        f.familyId,
      ]);
    assert.deepEqual((await familyRows()).rows, []);
    await assertUseGuarded(f);
    assert.equal(f.gh.issuesOfTokens.length, 0);
    assert.deepEqual((await familyRows()).rows, [], "cold use must not enroll a family");

    await prepare(f);
    const request = f.request({ operation: "receive-pack" });
    const beforeUse = f.gh.trace.length;
    const used = await f.owner.use(request);
    assert.equal(used.exchangeId, request.exchangeId);
    assert.equal(typeof used.value, "string");
    assert.ok(used.value.length > 0);
    assert.ok(used.preparationAttemptId);
    assert.ok(used.materialVersion);
    const receipt = (
      await f.pool.query(
        `SELECT admission_id, attempt_id, material_version, operation, request_digest_sha256
       FROM occ.prepared_repository_git_uses WHERE exchange_id=$1`,
        [request.exchangeId],
      )
    ).rows;
    assert.deepEqual(receipt, [
      {
        admission_id: f.admissionId,
        attempt_id: used.preparationAttemptId,
        material_version: used.materialVersion,
        operation: request.operation,
        request_digest_sha256: request.requestDigestSha256,
      },
    ]);
    const material = (
      await f.pool.query("SELECT sealed FROM occ.prepared_github_attempts WHERE id=$1", [
        used.preparationAttemptId,
      ])
    ).rows[0];
    assert.ok(material.sealed instanceof Uint8Array);
    assert.equal(
      material.sealed.includes(Buffer.from(used.value)),
      false,
      "custody must not persist plaintext bearer",
    );
    const sendStartBy = Date.parse(used.sendStartBy);
    assert.ok(sendStartBy > Date.now() && sendStartBy <= Date.parse(request.deadlineAt));
    assert.equal(f.gh.trace.length, beforeUse, "warm use must not contact the issuer");

    for (const [name, rejected, code] of [
      ["cross ref", f.request({ operation: "receive-pack", pushRef: "refs/heads/other" }), "guard"],
      ["cross session", f.request({ sessionId: `session-${randomUUID()}` }), "guard"],
      ["duplicate exchange", request, "23505"],
    ]) {
      await t.test(name, async () =>
        assert.rejects(f.owner.use(rejected), {
          message: `Prepared GitHub custody transaction did not complete (${code}).`,
        }),
      );
    }
    assert.equal(f.gh.trace.length, beforeUse, "denials must not issue or retire provider tokens");
    assert.equal(
      await f.providerStatus(used.value),
      200,
      "returned material is an actual issued token",
    );

    // Closing the authoritative attempt denies immediately, before the periodic worker runs.
    await f.withdraw();
    await assertUseGuarded(f);
    await f.owner.maintain();
    assert.equal(await f.providerStatus(used.value), 401, "withdrawal retires the provider token");
    assert.equal(f.gh.issuesOfTokens.length, 1, "withdrawal must never replace the token");
    assert.deepEqual(f.gh.errors, []);
  },
);

for (const outcome of ["refused", "lost"]) {
  test(
    "prepared Git retirement with a " + outcome + " response never restores use or repeats",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t);
      await prepare(f);
      const used = await f.owner.use(f.request());
      await f.withdraw();
      if (outcome === "refused") {
        f.gh.setRevokeStatus(503);
      } else {
        // GitHub commits DELETE, then drops its response. The owner cannot confirm revocation.
        f.gh.disconnectAfterMutation("DELETE", "/installation/token");
      }
      const revocations = () =>
        f.gh.trace.filter(
          (entry) => entry.method === "DELETE" && entry.target === "/installation/token",
        ).length;
      await assert.rejects(f.owner.maintain(), {
        message: /provider-unavailable|revocation is unconfirmed/,
      });
      const retained = () =>
        f.pool.query(
          "SELECT custody, sealed IS NOT NULL AS retained FROM occ.prepared_github_attempts WHERE id=$1",
          [used.preparationAttemptId],
        );
      assert.deepEqual((await retained()).rows, [{ custody: "unknown", retained: true }]);
      assert.equal(revocations(), 1, "the original retirement attempted one provider revoke");
      assert.equal(await f.providerStatus(used.value), outcome === "refused" ? 200 : 401);
      await assertUseGuarded(f);
      await f.owner.maintain();
      assert.deepEqual((await retained()).rows, [{ custody: "unknown", retained: true }]);
      assert.equal(revocations(), 1, "an unconfirmed revocation is never replayed");
      await assertUseGuarded(f);
      assert.equal(
        f.gh.issuesOfTokens.length,
        1,
        "ambiguous retirement cannot authorize replacement issuance",
      );
      assert.deepEqual(f.gh.errors, []);
    },
  );
}

for (const change of ["repository binding withdrawn", "revision superseded", "session expired"]) {
  test(
    "prepared Git refuses the same open broker session after " + change,
    requiresPostgres,
    async (t) => {
      const f = await fixture(t, change === "session expired" ? { sessionLifetimeMs: 4200 } : {});
      await prepare(f);
      const installed = await f.owner.use(f.request());
      const { store } = await openShellStore(f);
      assert.equal(
        await store.authorizeOpenShellRequest(f.request(), installed, new AbortController().signal),
        true,
      );
      const { agent, revision, sessionId } = f;
      if (change === "session expired") {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, f.deadlineWallMs + 25 - Date.now())),
        );
      } else {
        await f.state.transact(async (unit) => {
          if (change === "revision superseded") {
            const id = "rev_" + randomUUID();
            await unit.revisions.createRevision({ ...revision, id, revision: 2 });
            assert.ok(
              await unit.agents.compareAndSetActiveRevision(
                agent.namespaceId,
                agent.id,
                revision.id,
                id,
              ),
            );
          } else {
            // The State update made by PATCH Agent with its existing configurationId and repositoryBindings: [].
            // Do not close the broker, redeploy, or wait for background reconciliation to obtain this denial.
            const updated = await unit.agents.updateConfiguration(
              agent.namespaceId,
              agent.id,
              agent.configurationId,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
            );
            assert.equal(updated.activeRevisionId, revision.id);
            assert.deepEqual(updated.repositoryBindings ?? [], []);
          }
        });
      }
      await assertUseGuarded(f);
      // The OpenShell route tells the Agent its access ended (finding 2149).
      assert.deepEqual(
        await f.owner.readOpenShellMaterial(f.revision.id, new AbortController().signal),
        { absent: "withdrawn" },
      );
      assert.equal(
        await store.authorizeOpenShellRequest(f.request(), installed, new AbortController().signal),
        "access_withdrawn",
      );
      assert.equal(
        await f.providerStatus(installed.value),
        200,
        "the online denial precedes provider retirement",
      );
      const receipt = await f.pool.query(
        "SELECT state FROM occ.repository_broker_receipts WHERE session_id=$1",
        [sessionId],
      );
      assert.equal(receipt.rows[0].state, "active");
      await f.owner.maintain();
      await assertUseGuarded(f);
      const family = await f.pool.query(
        "SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1",
        [f.familyId],
      );
      assert.equal(
        family.rows[0].enabled,
        false,
        "withdrawal must fence the old family, not re-arm it",
      );
    },
  );
}

// Storage-boundary proof: use the production owner's admitted source, with an exact
// immutable session match. This does not establish supervisor authentication or sending.
async function openShellStore(f, pool = f.pool) {
  const {
    rows: [family],
  } = await f.pool.query(
    "SELECT source, admission FROM occ.prepared_github_families WHERE source_id=$1",
    [f.familyId],
  );
  const source = family.source;
  return {
    source,
    // An unrelated custody key makes accidental unsealing fail; authorization needs no key bytes.
    store: new PreparedRepositoryGitStore(
      pool,
      Buffer.alloc(32),
      family.admission.issuerAuthority,
      (session) => (isDeepStrictEqual(session, source.session) ? source : undefined),
    ),
  };
}

test(
  "OpenShell prepared Git authorization pins installed material before recording and denies withdrawal while the token is valid",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await prepare(f);
    const installed = await f.owner.use(f.request());
    const { store } = await openShellStore(f);
    const signal = new AbortController().signal;
    const request = f.request({ operation: "receive-pack" });
    const receipts = () =>
      f.pool.query(
        "SELECT attempt_id, material_version, request_digest_sha256 FROM occ.prepared_repository_git_uses WHERE exchange_id=$1",
        [request.exchangeId],
      );
    const before = f.gh.trace.length;
    for (const wrong of [
      { ...installed, materialVersion: randomUUID() },
      { ...installed, preparationAttemptId: randomUUID() },
    ]) {
      assert.equal(await store.authorizeOpenShellRequest(request, wrong, signal), false);
      assert.deepEqual(
        (await receipts()).rows,
        [],
        "a mismatched installation must not consume an exchange",
      );
    }
    // A session that is not live reads as withdrawn access (finding 2149).
    assert.equal(
      await store.authorizeOpenShellRequest(
        f.request({ sessionId: `session-${randomUUID()}` }),
        installed,
        signal,
      ),
      "access_withdrawn",
    );
    for (const changes of [
      { pushRef: "refs/heads/forbidden" },
      { repositoryId: "other-repository" },
      { providerInstanceId: "other-provider" },
      { grantId: "other-grant" },
      { deadlineAt: new Date(Date.now() - 1).toISOString() },
      { deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      assert.equal(
        await store.authorizeOpenShellRequest(f.request(changes), installed, signal),
        false,
      );
    }
    assert.equal(
      await store.authorizeOpenShellRequest(request, installed, AbortSignal.abort()),
      false,
    );
    assert.equal(await store.authorizeOpenShellRequest(request, installed, signal), true);
    assert.deepEqual((await receipts()).rows, [
      {
        attempt_id: installed.preparationAttemptId,
        material_version: installed.materialVersion,
        request_digest_sha256: request.requestDigestSha256,
      },
    ]);
    assert.equal(await store.authorizeOpenShellRequest(request, installed, signal), false);
    assert.equal(
      f.gh.trace.length,
      before,
      "authorization must not contact the issuer or provider",
    );
    await f.withdraw();
    assert.equal(
      await store.authorizeOpenShellRequest(f.request(), installed, signal),
      "access_withdrawn",
    );
    assert.equal(
      await f.providerStatus(installed.value),
      200,
      "withdrawing OCE authority does not depend on revocation",
    );
    assert.equal(f.gh.issuesOfTokens.length, 1);
  },
);

test(
  "OpenShell prepared Git rejects expired and superseded material while renewal keeps the old provider token valid",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await prepare(f);
    const installed = await f.owner.use(f.request());
    const { store } = await openShellStore(f);
    const signal = new AbortController().signal;
    // Move current material into the renewal window while it remains usable.
    // This distinguishes supersession from expiry and provider retirement.
    await f.pool.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",
      [installed.preparationAttemptId],
    );
    assert.equal(await store.authorizeOpenShellRequest(f.request(), installed, signal), true);
    await f.pool.query(
      "UPDATE occ.prepared_github_families SET next_check_at=clock_timestamp() WHERE source_id=$1",
      [f.familyId],
    );
    await f.owner.maintain();
    const replacement = await f.owner.use(f.request());
    const delivered = await f.owner.readOpenShellMaterial(f.revision.id, signal);
    assert.equal(delivered?.preparationAttemptId, replacement.preparationAttemptId);
    assert.equal(delivered?.value, replacement.value);
    assert.notEqual(replacement.preparationAttemptId, installed.preparationAttemptId);
    assert.notEqual(replacement.materialVersion, installed.materialVersion);
    assert.equal(await store.authorizeOpenShellRequest(f.request(), installed, signal), false);
    assert.equal(await store.authorizeOpenShellRequest(f.request(), replacement, signal), true);
    assert.equal(
      await f.providerStatus(installed.value),
      200,
      "supersession is enforced before provider retirement",
    );
    assert.equal(f.gh.issuesOfTokens.length, 2);
    // Expiry independently denies the newly current material with no worker pass.
    await f.pool.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [replacement.preparationAttemptId],
    );
    assert.equal(await store.authorizeOpenShellRequest(f.request(), replacement, signal), false);
    assert.deepEqual(await f.owner.readOpenShellMaterial(f.revision.id, signal), {
      absent: "unprepared",
    });
  },
);

for (const loseCommitAcknowledgment of [false, true]) {
  test(
    `OpenShell draft authorization preserves one unknown receipt${loseCommitAcknowledgment ? " after a lost commit acknowledgment" : ""}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, { draftPull: true });
      await prepare(f);
      const installed = await f.owner.use(f.request());
      // Commit on real PostgreSQL, then fault only the client's acknowledgment. This
      // proves durable uncertainty handling, not a genuine PostgreSQL network outage.
      let lose = loseCommitAcknowledgment;
      const pool = loseCommitAcknowledgment
        ? {
            async connect() {
              const client = await f.pool.connect();
              return {
                async query(...args) {
                  const result = await client.query(...args);
                  if (args[0] === "COMMIT" && lose) {
                    lose = false;
                    throw Object.assign(new Error("commit acknowledgment lost"), { code: "08007" });
                  }
                  return result;
                },
                release: (discard) => client.release(discard),
              };
            },
          }
        : f.pool;
      const { store, source } = await openShellStore(f, pool);
      const request = f.request({
        operation: "create-draft-pull",
        pull: {
          operationId: randomUUID(),
          apiOrigin: f.gh.origin,
          repository: source.grant.repository,
          head: source.grant.pushRef.slice("refs/heads/".length),
          base: source.grant.pullRequestBase,
        },
      });
      const signal = new AbortController().signal;
      assert.equal(
        await store.authorizeOpenShellRequest(
          request,
          { ...installed, materialVersion: randomUUID() },
          signal,
        ),
        false,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT receipt_id FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
            [request.grantId],
          )
        ).rows,
        [],
      );
      assert.equal(
        await store.authorizeOpenShellRequest(request, installed, signal),
        !loseCommitAcknowledgment,
      );
      const receipt = (
        await f.pool.query(
          "SELECT receipt_id, attempt_id, material_version, outcome, settled_at, projection FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
          [request.grantId],
        )
      ).rows;
      assert.deepEqual(receipt, [
        {
          receipt_id: request.exchangeId,
          attempt_id: installed.preparationAttemptId,
          material_version: installed.materialVersion,
          outcome: "outcome_unknown",
          settled_at: null,
          projection: null,
        },
      ]);
      // A repeated decision, a new request ID, or a new operation cannot cause a second create.
      // The refusal names the spent draft so the helper can say so (finding 2147).
      for (const retry of [
        request,
        { ...request, exchangeId: randomUUID() },
        {
          ...request,
          exchangeId: randomUUID(),
          pull: { ...request.pull, operationId: randomUUID() },
        },
      ]) {
        assert.equal(
          await store.authorizeOpenShellRequest(retry, installed, signal),
          "draft_already_opened",
        );
      }
      const native = await f.owner.use(request);
      assert.equal(native.kind, "recorded");
      assert.equal(native.body.error, "outcome_unknown");
      await store.finishPull(request.exchangeId, "not-submitted");
      assert.equal(
        await store.authorizeOpenShellRequest(
          { ...request, exchangeId: randomUUID() },
          installed,
          signal,
        ),
        "draft_already_opened",
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::integer AS count FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
            [request.grantId],
          )
        ).rows[0].count,
        1,
      );
    },
  );
}

test(
  "an operator's opt-out records every OpenShell draft use without spending a one-draft allowance",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Finding 2147 (owner 10-20): with draftPullLimit "none" the OpenShell route admits each
    // draft create its live session, grant and material authorize; the draft-only, head and base
    // checks are unchanged. The broker route keeps its one replayable receipt per grant.
    const f = await fixture(t, { draftPull: true, draftPullLimit: "none" });
    await prepare(f);
    const installed = await f.owner.use(f.request());
    const { store, source } = await openShellStore(f);
    assert.equal(source.draftPullLimit, "none");
    const signal = new AbortController().signal;
    const create = () =>
      f.request({
        operation: "create-draft-pull",
        pull: {
          operationId: randomUUID(),
          apiOrigin: f.gh.origin,
          repository: source.grant.repository,
          head: source.grant.pushRef.slice("refs/heads/".length),
          base: source.grant.pullRequestBase,
        },
      });
    const rows = async (grantId) =>
      (
        await f.pool.query(
          "SELECT receipt_id, outcome, settled_at FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
          [grantId],
        )
      ).rows;
    const first = create();
    assert.equal(await store.authorizeOpenShellRequest(first, installed, signal), true);
    const second = create();
    assert.equal(await store.authorizeOpenShellRequest(second, installed, signal), true);
    assert.deepEqual(await rows(second.grantId), []);
    const uses = async () =>
      (
        await f.pool.query(
          "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1 AND operation='create-draft-pull'",
          [f.admissionId],
        )
      ).rows
        .map(({ exchange_id }) => exchange_id)
        .sort();
    const allowed = [first.exchangeId, second.exchangeId].sort();
    assert.deepEqual(await uses(), allowed);
    assert.equal(await store.authorizeOpenShellRequest(second, installed, signal), false);
    // The other checks still hold: another base or a stale material is refused, writing nothing.
    const otherBase = create();
    otherBase.pull = { ...otherBase.pull, base: "release" };
    assert.equal(await store.authorizeOpenShellRequest(otherBase, installed, signal), false);
    assert.equal(
      await store.authorizeOpenShellRequest(
        create(),
        { ...installed, materialVersion: randomUUID() },
        signal,
      ),
      false,
    );
    assert.deepEqual(await uses(), allowed);
    // The native grant still permits just one draft, independently of those possible uses.
    const once = await f.owner.use(create());
    assert.ok(once.exchangeId);
    const native = await f.owner.use(create());
    assert.equal(native.kind, "recorded");
    assert.equal(native.status, 409);
  },
);

test(
  "discovery retires a replaced version's family from an earlier issuer authority without revoking it elsewhere",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Finding 2150: after the registry moved to another GitHub App origin or CA, the previous
    // authority's family for a replaced version stayed enabled with its token current forever.
    // Discovery under the new authority now retires it; revocation still never sends a token
    // to an authority other than the one that issued it, so the operator is told instead.
    const f = await fixture(t, { dnsIssuer: true });
    await prepare(f);
    const used = await f.owner.use(f.request());
    const reports = [];
    // The same fixture provider under another origin spelling: another issuer authority.
    const next = await f.startOwner({
      apiOrigin: f.gh.origin,
      report: (code, context) => reports.push({ code, ...context }),
    });
    const state = async () =>
      (
        await f.pool.query(
          `SELECT f.enabled, a.custody, a.sealed IS NOT NULL AS sealed
           FROM occ.prepared_github_families f JOIN occ.prepared_github_attempts a USING (source_id)
           WHERE f.source_id=$1`,
          [f.familyId],
        )
      ).rows;
    // While the version is live, its earlier-authority family is left alone: it cannot be
    // used under the new authority, and an overlapping earlier worker may still serve it.
    await next.maintain();
    assert.deepEqual(await state(), [{ enabled: true, custody: "current", sealed: true }]);
    assert.deepEqual(reports, []);
    const issued = f.gh.issuesOfTokens.length;
    // A new version replaces it.
    await f.state.transact(async (unit) => {
      const id = "rev_" + randomUUID();
      await unit.revisions.createRevision({ ...f.revision, id, revision: 2 });
      assert.ok(
        await unit.agents.compareAndSetActiveRevision(
          f.agent.namespaceId,
          f.agent.id,
          f.revision.id,
          id,
        ),
      );
    });
    const before = f.gh.trace.length;
    await next.maintain();
    assert.deepEqual(await state(), [{ enabled: false, custody: "retire", sealed: true }]);
    const {
      rows: [{ provider_expires_at: expires }],
    } = await f.pool.query(
      "SELECT provider_expires_at FROM occ.prepared_github_attempts WHERE id=$1",
      [used.preparationAttemptId],
    );
    assert.deepEqual(reports, [
      {
        code: "PREPARED_GITHUB_RETIRED_UNREVOKED",
        reason: "issuer_authority_changed",
        namespaceId: f.agent.namespaceId,
        revisionId: f.revision.id,
        repositoryRef: f.binding.repositoryRef,
        providerExpiresAt: expires.toISOString(),
      },
    ]);
    assert.equal(f.gh.trace.length, before, "the new authority never sends the old token");
    // Reported once: a later pass finds nothing new to retire and still sends nothing.
    await next.maintain();
    assert.equal(reports.length, 1);
    assert.equal(f.gh.trace.length, before);
    assert.equal(await f.providerStatus(used.value), 200, "retired, not revoked");
    // The issuing authority, if it comes back, revokes it as usual.
    await f.owner.maintain();
    assert.equal(await f.providerStatus(used.value), 401);
    assert.deepEqual(await state(), [{ enabled: false, custody: "revoked", sealed: false }]);
    assert.equal(f.gh.issuesOfTokens.length, issued, "retirement never issues");
    assert.deepEqual(f.gh.errors, []);
  },
);

test(
  "a worker whose App key goes bad after startup names the refusal in its maintenance report",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // A rotated Secret with an unusable key used to log only PREPARED_GITHUB_MAINTENANCE_FAILED
    // on each pass. The pass now reports the startup refusal's code and fixed reason.
    const f = await fixture(t);
    const directory = await temporaryDirectory(t, "pgit-key-");
    const privateKeyPath = join(directory, "rotated.pem");
    await writeFile(privateKeyPath, f.gh.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    // The real maintenance loop, started by hand once the key is replaced.
    let loop;
    const tokenService = new (class extends TokenService {
      ownFamilies(families) {
        return (loop = super.ownFamilies(families));
      }
    })();
    const reports = [];
    let reported;
    const firstReport = new Promise((resolve) => (reported = resolve));
    await f.startOwner({
      privateKeyPath,
      tokenService,
      startWorker: false,
      report: (code, context) => {
        reports.push({ code, ...context });
        reported();
      },
    });
    // A public key cannot sign. The admitted session still needs a token, so the pass reads it.
    await writeFile(
      privateKeyPath,
      createPublicKey(f.gh.privateKey).export({ type: "spki", format: "pem" }),
    );
    loop.start();
    // A pass that finds no source yet retries after 5 s; the test timeout bounds the wait.
    await firstReport;
    assert.deepEqual(reports[0], {
      code: "PREPARED_GITHUB_APP_KEY_INVALID",
      reason: "app_key_unparsable",
    });
    assert.equal(f.gh.issuesOfTokens.length, 0, "an unusable key never reaches the issuer");
    assert.deepEqual(f.gh.errors, []);
  },
);

for (const outcome of ["refused", "response lost"]) {
  test(
    "a new protected version gets Git material once its predecessor's " +
      outcome +
      " issuance has settled",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      // Findings 2207/2208: an issue attempt that never settled hid every later session of the
      // Agent for the same repository, so the runbook recovery (fix the App key, deploy a new
      // version) waited at REPOSITORY_GIT_MATERIAL_PENDING forever.
      const f = await fixture(t);
      await disposeBrokerSession(f);
      const owner = await startProtectedOwner(f);
      const first = await admitProtectedVersion(f);
      if (outcome === "refused") {
        // A rejected App key: GitHub answers 401 and mints nothing.
        f.gh.setIssueStatus(401);
      } else {
        // GitHub mints the token, then its answer is lost.
        f.gh.disconnectAfterMutation(
          "POST",
          `/app/installations/${fixtureInstallationId}/access_tokens`,
        );
      }
      await owner.maintain();
      const attempts = async (familyId) =>
        (
          await f.pool.query(
            "SELECT state, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
            [familyId],
          )
        ).rows;
      // Only a complete refusal with no token is terminal at once. A lost answer stays uncertain.
      assert.deepEqual(await attempts(first.familyId), [
        { state: "quarantined", custody: outcome === "refused" ? "not_issued" : "intent" },
      ]);
      const issued = outcome === "refused" ? 0 : 1;
      assert.equal(f.gh.issuesOfTokens.length, issued);
      f.gh.setIssueStatus(201);

      // The operator restores the key and deploys a new version; the old session ends.
      const second = await admitProtectedVersion(f, first.revision);
      await disposeProtectedSession(f, first);
      const read = () => owner.protectedGit.readMaterial(second.route, t.signal);
      if (outcome === "response lost") {
        // The lost token may be live for GitHub's maximum lifetime: the successor waits.
        await owner.maintain();
        assert.deepEqual(await read(), { absent: "unprepared" });
        assert.equal(f.gh.issuesOfTokens.length, issued);
        // Stand for the elapsed time: just inside the bound, it still waits.
        const age = (minutes) =>
          f.pool.query(
            "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-$2*interval '1 minute' WHERE source_id=$1",
            [first.familyId, minutes],
          );
        await age(71);
        await owner.maintain();
        assert.deepEqual(await read(), { absent: "unprepared" });
        // The one-minute dispatch window, ten minutes for GitHub to accept the attempt's JWT, one
        // hour of token life and the one-minute skew have passed: no token from it can be valid.
        await age(73);
      }
      await owner.maintain();
      assert.equal(f.gh.issuesOfTokens.length, issued + 1);
      const material = await read();
      assert.ok(material && "value" in material, "the successor received material");
      assert.equal(await f.providerStatus(material.value), 200);
      // The predecessor's attempt keeps its recorded outcome; settlement is never a rewrite.
      assert.deepEqual(await attempts(first.familyId), [
        { state: "quarantined", custody: outcome === "refused" ? "not_issued" : "intent" },
      ]);
      assert.deepEqual(f.gh.errors, []);
    },
  );
}

test(
  "the worker's prepared owner measures a token's remaining validity by the system clock",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // The worker starts the owner without a clock. GitHub answers with a 100 s token: by the
    // system clock 40 s remain after the 60 s skew allowance, less than the 60 s minimum, so the
    // owner keeps the token only to retire it. An owner whose wall clock reads 50 s behind (the
    // seam the standing Git transfer test uses) finds 90 s and installs it. Only the clock
    // differs, so the refusal proves that the default clock is the system clock.
    const attempts = async (ownerClock) => {
      const f = await fixture(t, { tokenLifetimeMs: 100_000, ownerClock });
      await prepare(f);
      return (
        await f.pool.query(
          "SELECT state, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
          [f.familyId],
        )
      ).rows;
    };
    assert.deepEqual(await attempts(undefined), [{ state: "quarantined", custody: "retire" }]);
    assert.deepEqual(await attempts(clockBehind(50_000)), [
      { state: "committed", custody: "current" },
    ]);
  },
);
