import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { openShellGitRecipientEvidence } from "../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts";
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

for (const draftPullLimit of [undefined, "none"] as const) {
  test(
    "a protected successor binds the released Git recipient and preserves draft custody, limit " +
      (draftPullLimit ?? "one per grant"),
    requiresPostgres,
    protectedSuccessor(draftPullLimit),
  );
}

function protectedSuccessor(draftPullLimit: "none" | undefined) {
  return async (t: TestContext) => {
    // Start at the real historical authority, including its possibly-spent, never-settled draft.
    // The installation below is controlled evidence: the standing transfer test exercises release.
    const f = await fixture(t, { draftPull: true, draftPullLimit });
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
    if (!draftPullLimit) {
      const brokerRequest =
        f.request() as import("../../packages/contracts/src/index.ts").PreparedGitHubUseRequest;
      assert.equal(
        await f.owner.authorizeOpenShellRequest(brokerRequest, used, t.signal),
        true,
        "the explicitly selected protocol-1 broker retains its original decision",
      );
    }
    const driver = {
      id: "controlled",
      implementation: "openshell",
      configurationId: "d".repeat(64),
    };
    const start = (overrides = {}) =>
      f.startOwner({
        controlSocket: undefined,
        protectedGitDriver: driver,
        protectedGitEvidence: openShellGitRecipientEvidence,
        ...overrides,
      });
    const owner = await start();
    const signal = t.signal;
    assert.deepEqual(
      await owner.protectedGit!.readMaterial(
        { revisionId: f.revision.id, fence: 1, observed: {} },
        signal,
      ),
      { absent: "unprepared" },
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
      driver,
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
    const sandboxId = "controlled-box-" + crypto.randomUUID();
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
          instanceId: "released-supervisor-A",
          repositoryGitRecipient: {
            providerId,
            attachmentEpoch: observed.attachmentEpoch,
            processInstanceId: observed.processInstanceId,
            networkInstanceId: observed.networkInstanceId,
          },
          configurationId: "c",
          authorityScope: "execution",
          peerKeyId: "fixture",
        },
      }),
    );
    // Match the OpenShell delivery owner's snapshot receipt, tied to this live revision.
    await f.pool.query(
      `insert into occ.credential_deliveries
    (revision_id,live_revision_id,settlement,namespace_id,agent_id,target,binding_id,worker_instance,desired,observed)
    values($1,$1,'snapshot',$2,$3,'{"transport":"openshell-repository-git/v1","workspace":"w","sandbox":"s"}',$4,$5,
      jsonb_build_object('credentialState','bootstrap','providerId',$6::text,'profileVersion','1','resourceVersion','1','expiresAt',''),$7)`,
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
    const exact = owner.protectedGit!;
    const read = () => exact.readMaterial(route, signal);
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
    const recordObserved = (value: typeof observed) =>
      f.pool.query("update occ.credential_deliveries set observed=$2 where revision_id=$1", [
        revisionId,
        JSON.stringify(value),
      ]);
    if (!draftPullLimit) {
      // Plan, Sandbox and policy still match, but this recipient was not bound to the release.
      const other = { ...observed, processInstanceId: "route-supervisor-B" };
      await recordObserved(other);
      await owner.maintain();
      const denied = await exact.readMaterial({ ...route, observed: other }, signal);
      assert.ok(denied && "absent" in denied, "another recipient must receive no material");
      assert.equal(f.gh.issuesOfTokens.length, 1, "must not prepare for an unassociated recipient");
      await recordObserved(observed);
    }
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
    const unavailable = { kind: "denied", reason: "unavailable" };
    const anotherBinding = "z".repeat(32);
    if (!draftPullLimit) {
      // Another binding can observe the same execution. Its installation receipt must not
      // satisfy the Git binding's proof that this material was installed.
      await f.pool.query(
        `insert into occ.credential_deliveries
           (revision_id,live_revision_id,settlement,namespace_id,agent_id,target,binding_id,worker_instance,desired,observed,material_version,preparation_attempt_id)
         select revision_id,live_revision_id,settlement,namespace_id,agent_id,target || '{"sandbox":"another-sandbox"}'::jsonb,$5,worker_instance,desired,observed,$3,$4
         from occ.credential_deliveries where revision_id=$1 and binding_id=$2`,
        [
          revisionId,
          executionId,
          installed.materialVersion,
          installed.preparationAttemptId,
          anotherBinding,
        ],
      );
    }
    assert.deepEqual(
      await exact.authorize(request(), installed, signal),
      unavailable,
      "not installed yet",
    );
    if (!draftPullLimit) {
      await f.pool.query(
        "update occ.credential_deliveries set blocked='withdrawn' where revision_id=$1 and binding_id=$2",
        [revisionId, anotherBinding],
      );
    }
    await f.pool.query(
      `update occ.credential_deliveries set desired=desired || jsonb_build_object('credentialState','active','expiresAt',$2::text),
    preparation_attempt_id=$3,material_version=$4 where revision_id=$1 and binding_id=$5`,
      [
        revisionId,
        material.expiresAt,
        installed.preparationAttemptId,
        installed.materialVersion,
        executionId,
      ],
    );
    const first = request();
    const permit = await exact.authorize(first, installed, signal);
    assert.equal(permit.kind, "permit", "v4 requires the exact send-start deadline");
    assert.deepEqual(await exact.online.authorize(request(), installed, signal), unavailable);
    await assert.rejects(
      owner.use(request()),
      { message: "Prepared GitHub custody transaction did not complete (guard)." },
      "no conversion to token-returning native authority",
    );
    // The historical possibly-spent draft is immutable. A limited grant cannot spend it again.
    // An unlimited grant records a distinct possible use for each new exchange, never a send.
    const draft = () => ({
      ...request(),
      ...operation,
      pull: { ...operation.pull, operationId: crypto.randomUUID() },
    });
    if (draftPullLimit === "none") {
      for (let i = 0; i < 2; i++) {
        const q = draft();
        assert.equal((await exact.authorize(q, installed, signal)).kind, "permit");
        assert.deepEqual(
          (
            await f.pool.query(
              `select admission_id,attempt_id,material_version,operation,request_digest_sha256
           from occ.prepared_repository_git_uses where exchange_id=$1`,
              [q.exchangeId],
            )
          ).rows,
          [
            {
              admission_id: admissionId,
              attempt_id: installed.preparationAttemptId,
              material_version: installed.materialVersion,
              operation: operation.operation,
              request_digest_sha256: q.requestDigestSha256,
            },
          ],
          "the possible-use receipt committed before allow",
        );
        assert.deepEqual(
          await exact.authorize(q, installed, signal),
          unavailable,
          "an existing possible use is not permission to repeat an exchange",
        );
      }
    } else {
      assert.deepEqual(await exact.authorize(draft(), installed, signal), {
        kind: "denied",
        reason: "draft_already_opened",
      });
    }
    assert.deepEqual(
      (
        await f.pool.query(
          "select receipt_id,outcome,settled_at from occ.prepared_repository_draft_pulls where grant_id=$1",
          [f.binding.grant.grantId],
        )
      ).rows,
      [{ receipt_id: used.exchangeId, outcome: "outcome_unknown", settled_at: null }],
    );
    // A cold owner can recover the committed version for the released recipient. A substituted
    // recipient at the same policy and fence cannot fetch that version, authorize it, or leave a use.
    const cold = (await start()).protectedGit!;
    const recovered = await cold.readMaterial(route, signal);
    assert.ok(recovered && "materialVersion" in recovered);
    assert.equal(recovered.materialVersion, installed.materialVersion);
    for (const key of ["processInstanceId", "networkInstanceId", "attachmentEpoch"] as const) {
      const other = { ...observed, [key]: "replacement" };
      const replaced = { ...route, observed: other };
      await recordObserved(other);
      const denied = await cold.readMaterial(replaced, signal);
      assert.ok(denied && "absent" in denied, `changed ${key} must not receive committed material`);
      const q = request();
      assert.deepEqual(
        await cold.authorize(q, { ...installed, route: replaced }, signal),
        unavailable,
      );
      assert.equal(
        (
          await f.pool.query("select from occ.prepared_repository_git_uses where exchange_id=$1", [
            q.exchangeId,
          ])
        ).rowCount,
        0,
      );
    }
    await recordObserved(observed);
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
      const both = Promise.all([read(), exact.authorize(racing, installed, signal)]);
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
      assert.deepEqual(await both, [
        { absent: "withdrawn" },
        { kind: "denied", reason: "access_withdrawn" },
      ]);
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
  };
}
