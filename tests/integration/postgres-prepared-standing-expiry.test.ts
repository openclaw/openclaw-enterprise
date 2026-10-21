import assert from "node:assert/strict";
import test from "node:test";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { fixtureInstallationId } from "../fixtures/repository-credentials/github.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// Exercise the real prepared owner with isolated rows at the clock boundary. Only these
// controls move stored test timestamps; the standing OpenShell transfer test waits for expiry.
const cases = ["skew", "refused", "response lost", "other issuer", "finite"] as const;
for (const boundary of cases) {
  test(
    "prepared standing Git retirement preserves the " + boundary + " boundary",
    requiresPostgres,
    async (t) => {
      const standingApproval = boundary !== "finite";
      const f = await fixture(t, { standingApproval });
      await prepare(f);
      await f.withdraw();
      const table = "occ.prepared_github_attempts";
      const key = [f.familyId];
      const status = async () =>
        (
          await f.pool.query(
            "select custody, sealed is null as erased from " + table + " where source_id=$1",
            key,
          )
        ).rows;
      const deletes = () => f.gh.trace.filter((x) => x.method === "DELETE").length;
      // The fixture moves both verified expiry fields together. The actual provider clock is untouched.
      const age = (sec: number) =>
        f.pool.query(
          "update " +
            table +
            " set usable_until=statement_timestamp()-($2+60)*interval '1 second', " +
            "provider_expires_at=statement_timestamp()-$2*interval '1 second' where source_id=$1",
          [f.familyId, sec],
        );
      if (boundary === "refused" || boundary === "response lost") {
        if (boundary === "refused") {
          f.gh.setRevokeStatus(401);
        } else {
          f.gh.disconnectAfterMutation("DELETE", "/installation/token");
        }
        await assert.rejects(f.owner.maintain(), {
          message:
            boundary === "refused"
              ? "Prepared GitHub token revocation is unconfirmed."
              : "provider-unavailable",
        });
        assert.equal(deletes(), 1);
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(await status(), [{ custody: "unknown", erased: false }]);
        assert.equal(
          deletes(),
          1,
          "neither time nor another observation can settle an earlier unknown send",
        );
      } else if (boundary === "skew") {
        f.gh.setRevokeStatus(401);
        await age(5);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "retire", erased: false }],
          "wait out provider expiry uncertainty",
        );
        assert.equal(deletes(), 0);
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "expired", erased: true }],
          "expiry has its own outcome, with no secret left",
        );
        assert.equal(
          deletes(),
          0,
          "never asked the provider to revoke an already expired credential",
        );
      } else if (boundary === "other issuer") {
        await age(90);
        const foreign = await f.startOwner({
          apiOrigin: f.gh.origin.replace("127.0.0.1", "localhost"),
        });
        await foreign.maintain();
        assert.deepEqual(await status(), [{ custody: "retire", erased: false }]);
        assert.equal(
          deletes(),
          0,
          "a different issuing authority cannot resolve even this known expiry",
        );
      } else {
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "revoked", erased: true }],
          "the finite path still requires provider confirmation",
        );
        assert.equal(deletes(), 1);
      }
    },
  );
}

test(
  "a lost standing Git issuance remains unresolved without a verified expiry",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { standingApproval: true });
    // Observe the issuer's one real issue, but lose its response before custody can verify
    // the result. Neither a former session deadline nor an assumed provider lifetime can settle it.
    f.gh.disconnectAfterMutation(
      "POST",
      "/app/installations/" + fixtureInstallationId + "/access_tokens",
    );
    await f.owner.maintain();
    assert.equal(f.gh.issuesOfTokens.length, 1);
    await f.withdraw();
    await f.owner.maintain();
    const { rows } = await f.pool.query(
      "select id from occ.prepared_github_attempts where source_id=$1",
      [f.familyId],
    );
    assert.equal(rows.length, 1);
    const id = rows[0].id as string;
    // A restarted owner can inspect the exact attempt after withdrawal, with no token, inferred
    // expiry, or second issue. A different family cannot borrow that recovery observation.
    const restarted = await f.startOwner();
    const traceLength = f.gh.trace.length;
    assert.equal(await restarted.inspectTokenAttempt(f.familyId + "-other", id), undefined);
    assert.deepEqual(await restarted.inspectTokenAttempt(f.familyId, id), {
      state: "quarantined",
      custody: "intent",
      materialVersion: null,
      providerExpiresAt: null,
    });
    await restarted.maintain();
    assert.equal(f.gh.trace.length, traceLength);
    assert.equal(f.gh.issuesOfTokens.length, 1);
    assert.equal(f.gh.trace.filter((x) => x.method === "DELETE").length, 0);
  },
);

test(
  "a protected finite successor cannot adopt a broker receipt, unsettled token or spent draft",
  requiresPostgres,
  async (t) => {
    // Start at the real historical authority, including its possibly-spent, never-settled draft.
    // The installation below is controlled evidence: the standing transfer test exercises release.
    const f = await fixture(t, { draftPull: true });
    await prepare(f);
    const operation = {
      operation: "create-draft-pull" as const,
      pull: {
        operationId: crypto.randomUUID(),
        apiOrigin: f.gh.origin,
        repository: "example/project",
        head: "prepared-fixture",
        base: "main",
      },
    };
    const grant = (
      await f.pool.query(
        "select source->'grant' as scope from occ.prepared_github_families where source_id=$1",
        [f.familyId],
      )
    ).rows[0].scope;
    operation.pull.repository = grant.repository;
    const used = await f.owner.use(f.request(operation));
    assert.ok("exchangeId" in used);
    assert.equal(
      (
        await f.pool.query(
          "select outcome from occ.prepared_repository_draft_pulls where receipt_id=$1",
          [used.exchangeId],
        )
      ).rows[0].outcome,
      "outcome_unknown",
    );
    const { namespaceId, agentId, servicePrincipalId, repositoryCredentials } = f.revision;
    const owner = await f.startOwner({ controlSocket: undefined });
    const signal = t.signal;
    assert.deepEqual(
      await owner.readOpenShellMaterial(f.revision.id, signal),
      { absent: "withdrawn" },
      "a live protocol-1 broker receipt does not authorize protected Git",
    );
    assert.equal(f.gh.issuesOfTokens.length, 1);
    const revisionId = "rev_" + crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const admissionId = crypto.randomUUID();
    const executionId = crypto.randomUUID().replaceAll("-", "");
    const plan = {
      id: "migration-proof",
      generation: 1,
      driver: { id: "controlled", implementation: "openshell", configurationId: "d".repeat(64) },
      execution: {
        namespaceId,
        agentId,
        servicePrincipalId,
        revisionId,
        executionId,
        installationId: "test",
      },
      sandboxDriverId: "controlled",
      egressDriverId: "controlled",
      routes: [],
      repositoryGit: repositoryCredentials!,
    };
    const attempt = {
      namespaceId,
      agentId,
      revisionId,
      admissionId,
      repositoryRef: "source",
      durationSeconds: 3600,
      deadlineWallMs: f.deadlineWallMs,
      createdAt: new Date().toISOString(),
      brokerProtocol: 2 as const,
    };
    await f.state.transact(async (u) => {
      await u.revisions.createRevision({
        ...(f.revision as import("../../packages/contracts/src/index.ts").AgentRevision),
        id: revisionId,
        revision: f.revision.revision + 1,
        executionAdmission: { version: 4, mode: "protected" },
        egressPlan: plan,
      });
      assert.ok(
        await u.agents.compareAndSetActiveRevision(namespaceId, agentId, f.revision.id, revisionId),
      );
      await u.repositorySessions.createAttempt(attempt);
      await u.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "opening",
        phase: "open",
        sessionId,
        updatedAt: attempt.createdAt,
      });
    });
    const providerId = "controlled-provider";
    const policyHash = "controlled-policy";
    const sandboxId = "controlled-box";
    const observed = {
      workspace: "w",
      sandbox: "s",
      sandboxId,
      executionId: revisionId,
      provider: "p",
      providerId,
      providerResourceVersion: "1",
      profileVersion: "1",
      credentialState: "active",
      attachmentEpoch: "e",
      providerEnvRevision: "1",
      configRevision: "1",
      policyHash,
      supervisorSessionId: "s",
      processInstanceId: "p",
      networkInstanceId: "n",
    };
    const route = { revisionId, fence: 1, observed };
    await f.state.transact((u) =>
      u.credentialSources.recordEgressInstallation({
        plan,
        sandboxId,
        sender: { id: "sender", generation: 1 },
        installedAt: attempt.createdAt,
        enforcement: {
          policyHash,
          instanceId: "p",
          configurationId: "c",
          authorityScope: "execution",
          peerKeyId: "fixture",
        },
      }),
    );
    await f.pool.query(
      `insert into occ.openshell_git_routes
    (revision_id,namespace_id,agent_id,workspace,sandbox,binding_id,worker_instance,credential_state,provider_id,profile_version,provider_resource_version,observed)
    values($1,$2,$3,'w','s',$4,$5,'bootstrap',$6,'1','1',$7)`,
      [
        revisionId,
        namespaceId,
        agentId,
        executionId,
        crypto.randomUUID(),
        providerId,
        JSON.stringify(observed),
      ],
    );
    const read = () => owner.readOpenShellMaterial(revisionId, signal, route);
    await owner.maintain();
    assert.equal(f.gh.issuesOfTokens.length, 1, "a live broker predecessor prevents new issuance");
    await f.withdraw();
    const oldTime = { admissionId: f.admissionId, updatedAt: attempt.createdAt };
    await f.state.transact(async (u) => {
      const sessions = u.repositorySessions;
      const receipt = (await sessions.findBrokerReceipt(f.admissionId))!;
      await sessions.advanceBrokerReceipt({
        ...oldTime,
        generation: receipt.generation!,
        sessionId: f.sessionId,
        deadlineWallMs: f.deadlineWallMs,
        revoked: 0,
        expired: 0,
        expectedState: "active",
        state: "disposed",
      });
      await sessions.advanceAttempt({ ...oldTime, expectedPhase: "closing", phase: "disposed" });
    });
    await owner.maintain();
    assert.equal(
      f.gh.issuesOfTokens.length,
      1,
      "closing the broker without settling its token cannot authorize new issuance",
    );
    await f.owner.maintain(); // the previous issuer owns its retirement
    await owner.maintain();
    const material = await read();
    assert.ok(material && "value" in material);
    assert.equal(f.gh.issuesOfTokens.length, 2);
    const installed = {
      route,
      materialVersion: material.materialVersion,
      preparationAttemptId: material.preparationAttemptId,
    };
    const request = () =>
      f.request({
        sessionId,
      }) as import("../../packages/contracts/src/index.ts").PreparedGitHubUseRequest;
    assert.equal(
      await owner.authorizeOpenShellRequest(request(), installed, signal),
      false,
      "not installed yet",
    );
    await f.pool.query(
      `update occ.openshell_git_routes set credential_state='active',material_expires_at=$2,
    preparation_attempt_id=$3,material_version=$4 where revision_id=$1`,
      [revisionId, material.expiresAt, installed.preparationAttemptId, installed.materialVersion],
    );
    assert.equal(await owner.authorizeOpenShellRequest(request(), installed, signal), true);
    await assert.rejects(
      owner.use(request()),
      { message: "Prepared GitHub custody transaction did not complete (guard)." },
      "no conversion to token-returning native authority",
    );
    assert.equal(
      await owner.authorizeOpenShellRequest({ ...request(), ...operation }, installed, signal),
      "draft_already_opened",
      "the predecessor's outcome_unknown consumed the grant, not just its session",
    );
    await assert.rejects(
      f.state.transact((u) =>
        u.repositorySessions.createAttempt({
          ...attempt,
          admissionId: crypto.randomUUID(),
          predecessorAdmissionId: admissionId,
          executionFingerprint: "c".repeat(64),
        }),
      ),
      /exact platform ownership or state/i,
    );
    // Hold withdrawal uncommitted. Prove both contenders reached its lock, then commit.
    // The conditional installer must get no material and authorization must record no possible use.
    const withdraw = await f.pool.connect();
    const racing = request();
    try {
      await withdraw.query("BEGIN");
      const id = (await withdraw.query("select pg_backend_pid() id")).rows[0].id;
      await withdraw.query("select from occ.namespaces where id=$1 for update", [namespaceId]);
      await withdraw.query(
        "update occ.repository_session_attempts set phase='closing' where admission_id=$1",
        [admissionId],
      );
      const both = Promise.all([
        read(),
        owner.authorizeOpenShellRequest(racing, installed, signal),
      ]);
      const limit = performance.now() + 900;
      for (;;) {
        const waiters = (
          await f.pool.query(
            "select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))",
            [id],
          )
        ).rowCount;
        if (waiters === 2) {
          break;
        }
        assert.ok(
          performance.now() < limit,
          "installer and authorizer must meet the withdrawal transaction",
        );
      }
      await withdraw.query("COMMIT");
      assert.deepEqual(await both, [{ absent: "withdrawn" }, "access_withdrawn"]);
      assert.equal(
        (
          await f.pool.query("select from occ.prepared_repository_git_uses where exchange_id=$1", [
            racing.exchangeId,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await withdraw.query("ROLLBACK");
      withdraw.release();
    }
  },
);
