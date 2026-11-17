import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
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
import {
  fixtureInstallationId,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";
import { clockBehind } from "../helpers/prepared-standing-git-peer.ts";

// Refusal must come from the durable admission guard, before any issuer or retirement call.
async function assertUseGuarded(f) {
  const calls = f.gh.trace.length;
  const request = f.request();
  assert.ok(Date.parse(request.deadlineAt) > Date.now());
  await assert.rejects(f.owner.use(request), {
    message: "Prepared GitHub custody transaction did not complete (guard).",
  });
  assert.equal(f.gh.trace.length, calls, "denied use contacted the provider");
}

async function nativeReceipts(f) {
  return (
    await f.pool.query(
      `SELECT admission_id, exchange_id, attempt_id, material_version, operation,
              request_digest_sha256, send_start_by FROM occ.prepared_repository_git_uses
       WHERE admission_id=$1`,
      [f.admissionId],
    )
  ).rows;
}

// Capture the expected version before use, without opening custody or authorizing an exchange.
async function currentNativeMetadata(f, { draftPull = false } = {}) {
  const { rows } = await f.pool.query(
    `SELECT a.id, a.material_version, a.usable_until, a.admission, f.source
     FROM occ.prepared_github_attempts a
     JOIN occ.prepared_github_families f USING (source_id)
     WHERE a.source_id=$1 AND a.state='committed' AND a.custody='current'
       AND f.enabled AND a.admission=f.admission`,
    [f.familyId],
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.source.session.sessionId, f.sessionId);
  assert.equal(row.source.session.admissionId, f.admissionId);
  assert.deepEqual(row.source.session.binding.grant, f.binding.grant);
  assert.equal(row.admission.grant.repository, fixtureRepository);
  assert.equal(row.admission.grant.pushRef, "refs/heads/prepared-fixture");
  if (draftPull) {
    assert.equal(row.admission.grant.pullRequestBase, "main");
  }
  return {
    preparationAttemptId: row.id,
    materialVersion: row.material_version,
    expiresAt: row.usable_until.toISOString(),
  };
}

async function assertNativeReceipt(f, request, material, used) {
  assert.equal(typeof used.value, "string");
  assert.ok(used.value.length > 0);
  assert.equal(used.exchangeId, request.exchangeId);
  assert.equal(used.preparationAttemptId, material.preparationAttemptId);
  assert.equal(used.materialVersion, material.materialVersion);
  const deadline = Date.parse(used.sendStartBy);
  assert.ok(deadline > Date.now());
  assert.ok(
    deadline <=
      Math.min(Date.parse(request.deadlineAt), f.deadlineWallMs, Date.parse(material.expiresAt)),
  );
  const expected = [
    {
      admission_id: f.admissionId,
      exchange_id: request.exchangeId,
      attempt_id: material.preparationAttemptId,
      material_version: material.materialVersion,
      operation: request.operation,
      request_digest_sha256: request.requestDigestSha256,
      send_start_by: new Date(used.sendStartBy),
    },
  ];
  assert.deepEqual(await nativeReceipts(f), expected);
  return expected;
}

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
    const prepared = await currentNativeMetadata(f);
    // An already-aborted request leaves this fresh exchange available for its first use.
    await assert.rejects(f.owner.use(request, AbortSignal.abort()), {
      message: "Prepared GitHub custody transaction did not complete (guard).",
    });
    assert.deepEqual(await nativeReceipts(f), [], "aborted use must not record authorization");
    assert.deepEqual(await currentNativeMetadata(f), prepared);
    assert.equal(f.gh.issuesOfTokens.length, 1, "aborted use must not rotate material");
    assert.equal(f.gh.trace.length, beforeUse, "aborted use must not contact the provider");
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
      const material = await currentNativeMetadata(f);
      const request = f.request();
      const beforeUse = f.gh.trace.length;
      const installed = await f.owner.use(request);
      const expected = await assertNativeReceipt(f, request, material, installed);
      assert.equal(f.gh.trace.length, beforeUse, "native use must not contact the provider");
      assert.equal(f.gh.issuesOfTokens.length, 1);
      assert.equal(await f.providerStatus(installed.value), 200);
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
      assert.deepEqual(await nativeReceipts(f), expected, "denial must preserve the use receipt");
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
      assert.equal(f.gh.issuesOfTokens.length, 1, "denial must not issue a replacement");
      await f.owner.maintain();
      await assertUseGuarded(f);
      assert.deepEqual(
        await nativeReceipts(f),
        expected,
        "maintenance must preserve the use receipt",
      );
      const family = await f.pool.query(
        "SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1",
        [f.familyId],
      );
      assert.equal(f.gh.issuesOfTokens.length, 1, "maintenance must not replace the old token");
      assert.equal(
        family.rows[0].enabled,
        false,
        "withdrawal must fence the old family, not re-arm it",
      );
    },
  );
}

for (const draftPullLimit of [undefined, "none"]) {
  test(
    `native draft authorization spends one allowance and preserves recorded replay${draftPullLimit === "none" ? " with draftPullLimit none" : ""}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, { draftPull: true, draftPullLimit });
      await prepare(f);
      if (draftPullLimit === "none") {
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT source->>'draftPullLimit' AS draft_pull_limit FROM occ.prepared_github_families WHERE source_id=$1",
              [f.familyId],
            )
          ).rows,
          [{ draft_pull_limit: "none" }],
        );
      }
      const material = await currentNativeMetadata(f, { draftPull: true });
      const request = f.request({
        operation: "create-draft-pull",
        pull: {
          operationId: randomUUID(),
          apiOrigin: f.gh.origin,
          repository: fixtureRepository,
          head: "prepared-fixture",
          base: "main",
        },
      });
      const before = f.gh.trace.length;
      const used = await f.owner.use(request, t.signal);
      const expectedUses = await assertNativeReceipt(f, request, material, used);
      const claims = async () =>
        (
          await f.pool.query(
            `SELECT receipt_id, operation_id, admission_id, attempt_id, material_version,
                request_digest_sha256, send_start_by, outcome, settled_at, projection
         FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1`,
            [request.grantId],
          )
        ).rows;
      const receipt = await claims();
      const deadline = new Date(used.sendStartBy);
      assert.deepEqual(receipt, [
        {
          receipt_id: request.exchangeId,
          operation_id: request.pull.operationId,
          admission_id: f.admissionId,
          attempt_id: material.preparationAttemptId,
          material_version: material.materialVersion,
          request_digest_sha256: request.requestDigestSha256,
          send_start_by: deadline,
          outcome: "outcome_unknown",
          settled_at: null,
          projection: null,
        },
      ]);
      for (const retry of [request, { ...request, exchangeId: randomUUID() }]) {
        assert.deepEqual(await f.owner.use(retry), {
          kind: "recorded",
          status: 409,
          body: {
            operationId: request.pull.operationId,
            receiptId: request.exchangeId,
            error: "outcome_unknown",
          },
        });
      }
      for (const retry of [
        {
          ...request,
          exchangeId: randomUUID(),
          pull: { ...request.pull, operationId: randomUUID() },
        },
        {
          ...request,
          exchangeId: randomUUID(),
          requestDigestSha256:
            (request.requestDigestSha256[0] === "0" ? "1" : "0") +
            request.requestDigestSha256.slice(1),
        },
      ]) {
        assert.deepEqual(await f.owner.use(retry), {
          kind: "recorded",
          status: 409,
          body: { error: "operation_conflict" },
        });
      }
      assert.deepEqual(await claims(), receipt, "replay cannot claim a second draft");
      assert.deepEqual(await nativeReceipts(f), expectedUses);
      assert.equal(f.gh.trace.length, before, "native draft use must not contact the provider");
      assert.equal(f.gh.issuesOfTokens.length, 1, "replay must not issue again");
      assert.equal(await f.providerStatus(used.value), 200);
      // This proves provider acceptance, not a Git subprocess push or a draft creation.
    },
  );
}

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

test(
  "a native revision's token state stays pending until GitHub issues it and quarantined after a refusal",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Finding 2415: maintenance issues a version's first token only once its active pointer is
    // published, so a deployment reads this state before it reports success. A version whose
    // token GitHub refused is never prepared again, so its deployment can fail at once.
    const issued = await fixture(t);
    assert.equal(await issued.owner.revisionMaterial(issued.revision.id), "pending");
    await prepare(issued);
    assert.equal(await issued.owner.revisionMaterial(issued.revision.id), "ready");
    const prepared = await currentNativeMetadata(issued);
    const calls = issued.gh.trace.length;
    const tokens = issued.gh.issuesOfTokens.length;
    assert.equal(await issued.owner.revisionMaterial(issued.revision.id), "ready");
    // Another revision has no open session of this owner: nothing is ready for it.
    assert.equal(await issued.owner.revisionMaterial("rev_" + randomUUID()), "pending");
    assert.deepEqual(await currentNativeMetadata(issued), prepared);
    assert.equal(issued.gh.trace.length, calls, "status must not contact the provider");
    assert.equal(issued.gh.issuesOfTokens.length, tokens, "status must not rotate material");
    assert.deepEqual(await nativeReceipts(issued), [], "status must not authorize use");

    // A rejected App key: GitHub answers 401 and mints nothing.
    const refused = await fixture(t);
    refused.gh.setIssueStatus(401);
    // Discovery and issuance may be separate passes.
    await refused.owner.maintain();
    await refused.owner.maintain();
    assert.equal(await refused.owner.revisionMaterial(refused.revision.id), "quarantined");
    // Restoring the key does not reopen this version's preparation; only a new version does.
    refused.gh.setIssueStatus(201);
    await refused.owner.maintain();
    assert.equal(await refused.owner.revisionMaterial(refused.revision.id), "quarantined");
    assert.equal(refused.gh.issuesOfTokens.length, 0);
    assert.deepEqual(refused.gh.errors, []);
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
      const read = () => owner.protectedGit.online.readMaterial(second.route, t.signal);
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
