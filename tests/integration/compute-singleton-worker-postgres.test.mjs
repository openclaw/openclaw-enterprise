import assert from "node:assert/strict";
import test from "node:test";
import {
  requiresPostgres,
  setup,
  waitFor,
  hasCutover,
  queuedCutover,
  assertCutoverCleared,
  sshDrivers,
  revisionEffect,
} from "../helpers/compute-singleton-worker.mjs";

test(
  "a worker binds persisted Namespace, Agent, and service principal before provider effects",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    const effects = [];

    await fixture.startWith({
      activationOrder: "beforeCommit",
      async bindAgent(binding) {
        effects.push({
          action: "bind",
          namespaceId: binding.namespace.id,
          namespaceName: binding.namespace.name,
          agentId: binding.agent.id,
          agentName: binding.agent.name,
          servicePrincipalId: binding.agent.servicePrincipalId,
        });
      },
      async prepareRevision(revision) {
        effects.push({ action: "prepare", revisionId: revision.id });
        return fixture.compute.prepareRevision(revision);
      },
      async activateRevision(revision) {
        effects.push({ action: "activate", revisionId: revision.id });
      },
    });

    assert.equal((await fixture.work(candidate)).attempt_count, 1);
    assert.deepEqual(effects, [
      {
        action: "bind",
        namespaceId: fixture.namespace.id,
        namespaceName: fixture.namespace.name,
        agentId: owner.id,
        agentName: owner.name,
        servicePrincipalId: owner.servicePrincipalId,
      },
      { action: "prepare", revisionId: candidate.id },
      { action: "activate", revisionId: candidate.id },
    ]);
  },
);

test(
  "a production singleton driver activates under its claim heartbeat before CAS and retires only after CAS",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);

    const { driver, effects } = fixture.recordEffects(owner, {
      activationOrder: "beforeCommit",
      async activateRevision(candidate) {
        if (candidate.id === first.id) {
          const original = await fixture.observerPool.query(
            `SELECT claim_token, lease_expires_at::text AS expires_at
               FROM occ.controller_work WHERE idempotency_key = $1`,
            [first.idempotencyKey],
          );
          assert.equal(original.rowCount, 1);
          const claim = original.rows[0];
          assert.ok(claim.claim_token);
          assert.ok(claim.expires_at);

          // Keep activation open beyond its initial lease: the same claim must
          // remain live because the real worker renewed it before publication.
          await waitFor("the original activation claim to outlive its lease", async () => {
            const current = await fixture.observerPool.query(
              `SELECT state, claim_token, attempt_count,
                        lease_expires_at > clock_timestamp() AS live,
                        clock_timestamp() > $2::timestamptz AS original_expired,
                        lease_expires_at > $2::timestamptz AS renewed
                 FROM occ.controller_work WHERE idempotency_key = $1`,
              [first.idempotencyKey, claim.expires_at],
            );
            assert.equal(current.rowCount, 1);
            const work = current.rows[0];
            assert.equal(work.state, "claimed");
            assert.equal(work.claim_token, claim.claim_token);
            assert.equal(work.attempt_count, 1);
            assert.equal(work.live, true, "the original claim must remain live during activation");
            return work.original_expired && work.renewed ? work : undefined;
          });
        }
      },
      async deactivateRevision() {},
    });
    await fixture.start(driver, 5_000);
    assert.equal((await fixture.work(first)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), first.id);

    const second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      revisionEffect("prepare", first, null),
      revisionEffect("activate", first, null),
      revisionEffect("prepare", second, first),
      revisionEffect("activate", second, first),
      revisionEffect("retire", first, second),
    ]);

    const activation = await fixture.observerPool.query(
      `SELECT resource_id, details->>'previousRevisionId' AS previous
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [
      { resource_id: first.id, previous: null },
      { resource_id: second.id, previous: first.id },
    ]);
  },
);

for (const { name, compute, attemptCount, failureReasons } of [
  {
    name: "failed singleton activation retries without publishing or retiring the previous revision",
    compute: { activationOrder: "beforeCommit" },
    attemptCount: 2,
    failureReasons: ["DEPENDENCY_UNAVAILABLE"],
  },
  {
    name: "failed route-before-CAS cutover retries without committing or retiring the predecessor",
    compute: { async deactivateRevision() {} },
    // Durable cutover recovery defers its claim instead of spending another attempt.
    attemptCount: 1,
    failureReasons: [],
  },
]) {
  test(name, requiresPostgres, async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let failed = false;
    const { driver, effects } = fixture.recordEffects(owner, {
      ...compute,
      async activateRevision(candidate) {
        if (candidate.revision === 2 && !failed) {
          failed = true;
          throw new Error("provider readiness verification failed");
        }
      },
    });
    await fixture.start(driver);
    await fixture.work(first);
    assert.equal(await fixture.activeRevision(owner), first.id);

    const second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second, "succeeded", 30_000)).attempt_count, attemptCount);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(
      effects.filter(({ action }) => action === "activate"),
      [
        revisionEffect("activate", first, null),
        revisionEffect("activate", second, first),
        revisionEffect("activate", second, first),
      ],
    );
    assert.deepEqual(
      effects.filter(({ action }) => action === "retire"),
      [revisionEffect("retire", first, second)],
    );
    assert.deepEqual(await fixture.reconcileReasons(second, "failure"), failureReasons);
  });
}

for (const scenario of [
  { executionMode: "dedicated", initialDeactivatesCandidate: true },
  { executionMode: "embedded", initialDeactivatesCandidate: false },
]) {
  test(
    `default production ${scenario.executionMode} Drivers publish the route before active revision`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(scenario.executionMode);
      const first = await fixture.revision(owner, 1);

      const { driver, effects } = fixture.recordEffects(owner, {
        async deactivateRevision() {},
        async activateRevision() {},
      });
      await fixture.start(driver);
      await fixture.work(first);
      const second = await fixture.revision(owner, 2);
      await fixture.work(second);

      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(effects, [
        revisionEffect("prepare", first, null),
        ...(scenario.initialDeactivatesCandidate
          ? [revisionEffect("deactivate", first, null)]
          : []),
        revisionEffect("activate", first, null),
        revisionEffect("prepare", second, first),
        revisionEffect("activate", second, first),
        revisionEffect("retire", first, second),
      ]);
      const completed = await fixture.work(second);
      assertCutoverCleared(completed);
    },
  );
}

test(
  "lost claim after route switch recovers before recording the active revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const activations = [];
    let stoleFirstSecondClaim = false;
    let second;

    await fixture.startWith({
      async deactivateRevision() {},
      async activateRevision(candidate) {
        activations.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (second !== undefined && candidate.id === second.id && !stoleFirstSecondClaim) {
          stoleFirstSecondClaim = true;
          await fixture.observerPool.query(
            `UPDATE occ.controller_work
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE idempotency_key = $1 AND state = 'claimed'`,
            [second.idempotencyKey],
          );
        }
      },
      async retireRevision(candidate) {
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.work(second);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(activations, [
      { revisionId: first.id, activeRevisionId: null },
      { revisionId: second.id, activeRevisionId: first.id },
      { revisionId: second.id, activeRevisionId: first.id },
    ]);
  },
);

test(
  "revoked route-before-CAS cutover rolls back before permanent failure",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    const effects = [];
    let second;

    await fixture.startWith({
      async deactivateRevision(candidate) {
        effects.push({ action: "deactivate", revisionId: candidate.id });
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        effects.push({
          action: "activate",
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id) {
          throw new Error("lost confirmation after route switch");
        }
      },
    });

    await fixture.work(first);
    assert.equal(servingRevisionId, first.id);
    second = await fixture.revision(owner, 2);
    await fixture.waitForWork(second, hasCutover);
    await fixture.revokeDeploy(owner);

    const failed = await fixture.work(second, "failed_permanent");
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, first.id);
    assert.equal(failed.cutover_started_at, null);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === second.id),
      [revisionEffect("activate", second, first), { action: "deactivate", revisionId: second.id }],
    );
    assert.ok(
      effects.some(
        ({ action, revisionId, activeRevisionId }) =>
          action === "activate" && revisionId === first.id && activeRevisionId === first.id,
      ),
    );
  },
);

test(
  "expired route-before-CAS cutover restores the predecessor before terminal failure",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    let second;

    await fixture.startWith({
      async deactivateRevision(candidate) {
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.waitForWork(second, queuedCutover);
    await fixture.stop();

    await fixture.startWith(
      {
        async deactivateRevision(candidate) {
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );

    const failed = await fixture.work(second, "failed_permanent");
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, first.id);
    assert.equal(failed.cutover_started_at, null);
  },
);

test(
  "failed deadline compensation keeps unresolved cutover queued",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    let second;

    await fixture.startWith({
      async deactivateRevision(candidate) {
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.waitForWork(second, queuedCutover);
    await fixture.stop();

    let compensationAttempts = 0;
    await fixture.startWith(
      {
        async deactivateRevision(candidate) {
          if (candidate.id === second.id) compensationAttempts += 1;
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          if (candidate.id === first.id) throw new Error("predecessor restore unavailable");
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );

    await fixture.waitForWork(
      second,
      async (work) =>
        compensationAttempts > 0 &&
        queuedCutover(work) &&
        (await fixture.reconcileReasons(second)).includes(
          "REVISION_CUTOVER_COMPENSATION_INCOMPLETE",
        ),
    );
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, undefined);

    await fixture.stop();
    await fixture.startWith(
      {
        async deactivateRevision(candidate) {
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );
    await fixture.work(second, "failed_permanent");
  },
);

test(
  "mismatched Drivers preserve marked route-before-CAS cutovers",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;
    const deactivations = [];

    await fixture.startWith({
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision(candidate) {
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.waitForWork(second, queuedCutover);
    await fixture.stop();

    await fixture.startWith({
      id: `${fixture.compute.id}-other`,
      activationOrder: "beforeCommit",
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
    });

    await fixture.waitForWork(
      second,
      async (work) =>
        queuedCutover(work) &&
        (await fixture.reconcileReasons(second)).includes("COMPUTE_DRIVER_MISMATCH"),
    );
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.ok(!deactivations.includes(second.id));

    await fixture.stop();
    await fixture.startWith({
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
    });
    await fixture.work(second);
  },
);

test(
  "post-CAS cleanup finishes without reauthorizing a new deployment",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let allowRetirement = false;
    const retirements = [];

    await fixture.startWith({
      async deactivateRevision() {},
      async activateRevision() {},
      async retireRevision(candidate) {
        retirements.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (candidate.id === first.id && !allowRetirement) {
          throw new Error("retirement dependency unavailable");
        }
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    const second = await fixture.revision(owner, 2);
    await fixture.waitForWork(
      second,
      async (work) =>
        queuedCutover(work) &&
        retirements.length === 1 &&
        (await fixture.activeRevision(owner)) === second.id,
    );
    await fixture.revokeDeploy(owner);
    allowRetirement = true;

    await waitFor("the post-CAS cleanup retry to retire the predecessor", async () =>
      retirements.length === 2 ? retirements : undefined,
    );
    await fixture.work(second);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(retirements, [
      { revisionId: first.id, activeRevisionId: second.id },
      { revisionId: first.id, activeRevisionId: second.id },
    ]);
  },
);

test(
  "compensation guard preserves a DB-active route for an invalid marked cutover",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;
    let allowRetirement = false;
    const deactivations = [];
    let retirementAttempts = 0;

    await fixture.startWith({
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
      async retireRevision(candidate) {
        if (candidate.id === first.id) retirementAttempts += 1;
        if (candidate.id === first.id && !allowRetirement) {
          throw new Error("retirement dependency unavailable");
        }
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.waitForWork(
      second,
      async (work) =>
        queuedCutover(work) &&
        retirementAttempts === 1 &&
        (await fixture.activeRevision(owner)) === second.id,
    );

    await fixture.stop();
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const claim = await waitFor(
      "the retained cutover claim to become available",
      () => queue.claim(),
      30_000,
    );
    assert.equal(claim.idempotencyKey, second.idempotencyKey);
    const boundaryWorker = fixture.createWorker(
      fixture.driver({
        async deactivateRevision(candidate) {
          deactivations.push(candidate.id);
        },
        async activateRevision() {},
        async retireRevision(candidate) {
          if (candidate.id === first.id && !allowRetirement) {
            throw new Error("retirement dependency unavailable");
          }
          return fixture.compute.retireRevision(candidate);
        },
      }),
    );
    try {
      await boundaryWorker.compensateRevisionCutover(claim, second, second, {
        outcome: "permanent",
        code: "HARNESS_DESCRIPTOR_MISMATCH",
      });
    } finally {
      await boundaryWorker.stop();
    }

    const guarded = await fixture.readWork(second);
    assert.equal(guarded?.state, "queued");
    assert.notEqual(guarded?.cutover_started_at, null);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.ok(!deactivations.includes(second.id));
    allowRetirement = true;
    await fixture.startWith({
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
      async retireRevision(candidate) {
        return fixture.compute.retireRevision(candidate);
      },
    });
    await fixture.work(second);
  },
);

test(
  "queue recovery completes exhausted cutovers before same-Agent successors with the same retry cap",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const staleOwner = await fixture.agent();
    const queuedOwner = await fixture.agent();
    const stale = await fixture.revision(staleOwner, 1);
    const queued = await fixture.revision(queuedOwner, 1);
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const claimedStale = await queue.claim();
    assert.equal(claimedStale.idempotencyKey, stale.idempotencyKey);
    await queue.startRevisionCutover(claimedStale, undefined);
    await assert.rejects(
      () => queue.fail(claimedStale, { code: "SHOULD_NOT_CLEAR_MARKER" }),
      /controller work claim is missing, expired, or owned by another worker/,
    );
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET attempt_count = 5,
           lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1`,
      [stale.idempotencyKey],
    );
    const claimedQueued = await queue.claim();
    assert.equal(claimedQueued.idempotencyKey, queued.idempotencyKey);
    await queue.startRevisionCutover(claimedQueued, undefined);
    await queue.defer(claimedQueued, { code: "TEST_QUEUED_CUTOVER" });
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET attempt_count = 5
       WHERE idempotency_key = $1`,
      [queued.idempotencyKey],
    );

    const recovery = await queue.recoverStale();
    assert.equal(recovery.failedPermanent, 0);
    assert.equal(recovery.exhaustedQueued, 0);

    const states = await fixture.observerPool.query(
      `SELECT idempotency_key, state, completed_at IS NOT NULL AS completed,
              cutover_started_at IS NOT NULL AS cutover_started
       FROM occ.controller_work
       WHERE idempotency_key = ANY($1::text[])
       ORDER BY idempotency_key`,
      [[queued.idempotencyKey, stale.idempotencyKey]],
    );
    assert.deepEqual(
      states.rows.map(({ state, completed, cutover_started }) => ({
        state,
        completed,
        cutover_started,
      })),
      [
        { state: "queued", completed: false, cutover_started: true },
        { state: "queued", completed: false, cutover_started: true },
      ],
    );

    // Earlier availability must not let a successor bypass its Agent's retained
    // cutover. Recovery uses the original limit, including after a final-attempt crash.
    const staleSuccessor = await fixture.revision(staleOwner, 2);
    const queuedSuccessor = await fixture.revision(queuedOwner, 2);
    const unresolved = new Set([queued.idempotencyKey, stale.idempotencyKey]);
    const recoveredClaims = [];
    for (const _ of Array.from(unresolved)) {
      const recovered = await queue.claim();
      assert.ok(recovered, "an exhausted cutover must remain claimable with maxAttempts=5");
      assert.ok(unresolved.delete(recovered.idempotencyKey));
      assert.equal(recovered.attemptCount, 6);
      assert.ok(recovered.cutoverStartedAt);
      recoveredClaims.push(recovered);
    }
    assert.equal(unresolved.size, 0);
    assert.equal(await queue.claim(), undefined);

    // Give the actual worker the retained, still-exhausted rows; queue.defer
    // refunds this inspection claim, so both rows remain at the original cap.
    for (const recovered of recoveredClaims) {
      await queue.defer(recovered, { code: "TEST_RESUME_CUTOVER" });
    }
    const activations = [];
    let dependencyFailed = false;
    await fixture.startWith({
      async prepareRevision(candidate) {
        // Recovery can hit an ordinary dependency failure after exhausting the
        // retry budget; the cutover must requeue without waiting for lease expiry.
        if (candidate.id === queued.id && !dependencyFailed) {
          dependencyFailed = true;
          throw new Error("temporary preparation dependency failure");
        }
        return fixture.compute.prepareRevision(candidate);
      },
      async deactivateRevision() {},
      async activateRevision(candidate) {
        activations.push(candidate.id);
      },
    });
    const retryEvidence = await waitFor(
      "the exhausted cutover to record its dependency retry",
      async () => {
        const reasons = await fixture.reconcileReasons(queued, "failure");
        return reasons.length > 0 ? reasons : undefined;
      },
    );
    assert.deepEqual(retryEvidence, ["DEPENDENCY_UNAVAILABLE"]);

    // The real retry already persisted its transition and evidence. Advance its
    // randomized backoff so this case measures recovery, not scheduler delay.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE idempotency_key = $1 AND state = 'queued'`,
      [queued.idempotencyKey],
    );
    for (const candidate of [stale, queued, staleSuccessor, queuedSuccessor]) {
      const completed = await fixture.work(candidate);
      assertCutoverCleared(completed);
    }
    assert.equal(await fixture.activeRevision(staleOwner), staleSuccessor.id);
    assert.equal(await fixture.activeRevision(queuedOwner), queuedSuccessor.id);
    assert.ok(
      !(await fixture.reconcileReasons(queued)).includes("LEASE_EXPIRED"),
      "a dependency retry must not require lease expiry",
    );
    for (const [candidate, successor] of [
      [stale, staleSuccessor],
      [queued, queuedSuccessor],
    ]) {
      assert.deepEqual(
        activations.filter((id) => id === candidate.id || id === successor.id),
        [candidate.id, successor.id],
      );
    }
  },
);

test(
  "an opted-in active runtime continuously repairs under its original authorized actor",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    const preparations = [];
    const activations = [];

    await fixture.startWith({
      activationOrder: "beforeCommit",
      maintenanceIntervalMs: 75,
      async prepareRevision(revision) {
        preparations.push({
          revisionId: revision.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        return fixture.compute.prepareRevision(revision);
      },
      async activateRevision(revision) {
        activations.push({
          revisionId: revision.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
      },
    });
    await fixture.work(candidate);

    const maintained = await waitFor("a durable authorized maintenance pass", async () => {
      const work = await fixture.observerPool.query(
        `SELECT actor_id, namespace_id, agent_id, revision_id, state
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'succeeded'
         ORDER BY completed_at DESC
         LIMIT 1`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return work.rows[0];
    });
    await fixture.stop();

    assert.deepEqual(maintained, {
      actor_id: fixture.actor.id,
      namespace_id: fixture.namespace.id,
      agent_id: owner.id,
      revision_id: candidate.id,
      state: "succeeded",
    });
    assert.equal(await fixture.activeRevision(owner), candidate.id);
    assert.deepEqual(preparations.slice(0, 2), [
      { revisionId: candidate.id, activeRevisionId: null },
      { revisionId: candidate.id, activeRevisionId: candidate.id },
    ]);
    assert.deepEqual(activations.slice(0, 2), [
      { revisionId: candidate.id, activeRevisionId: null },
      { revisionId: candidate.id, activeRevisionId: candidate.id },
    ]);

    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'succeeded', completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE namespace_id = $1 AND state = 'queued'
         AND idempotency_key LIKE $2`,
      [fixture.namespace.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
  },
);

test(
  "active maintenance recovers after its convergence deadline and stops when its actor is denied",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    let available = false;
    let maintenanceAttempts = 0;

    await fixture.startWith(
      {
        activationOrder: "beforeCommit",
        maintenanceIntervalMs: 75,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          if ((await fixture.activeRevision(owner)) === revision.id) {
            maintenanceAttempts += 1;
            if (!available) return { ...observation, ready: false };
          }
          return observation;
        },
        async activateRevision() {},
      },
      30_000,
      40,
    );
    await fixture.work(candidate);

    // Each failed maintenance observation must schedule another exact-Agent
    // pass even though the original deployment convergence deadline elapsed.
    await waitFor("multiple failed but rescheduled maintenance passes", async () => {
      const result = await fixture.observerPool.query(
        `SELECT COUNT(*)::integer AS failures
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'failed_permanent'`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0].failures >= 2 ? result.rows[0] : undefined;
    });
    available = true;

    await waitFor("active runtime recovery after a prolonged provider outage", async () => {
      const result = await fixture.observerPool.query(
        `SELECT actor_id, state
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'succeeded'
         ORDER BY completed_at DESC LIMIT 1`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0];
    });
    assert.equal(await fixture.activeRevision(owner), candidate.id);

    // Revoking the original actor must halt the chain before another provider
    // effect; maintenance never grants an Agent permission to deploy itself.
    await fixture.revokeDeploy(owner);
    const effectsBeforeDenial = maintenanceAttempts;
    await waitFor("the denied maintenance pass to stop without a successor", async () => {
      const result = await fixture.observerPool.query(
        `SELECT COUNT(*)::integer AS pending
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state IN ('queued', 'claimed')`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0].pending === 0 ? result.rows[0] : undefined;
    });
    assert.equal(maintenanceAttempts, effectsBeforeDenial);
  },
);

test(
  "development after-commit Drivers activate after CAS and retry before retiring the previous revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;

    let secondActivationAttempts = 0;
    let retryStarted = false;
    let releaseRetry;
    const retryRelease = new Promise((resolve) => {
      releaseRetry = resolve;
    });

    const { driver, effects } = fixture.recordEffects(owner, {
      async activateRevision(candidate) {
        if (candidate.id === second?.id) {
          secondActivationAttempts += 1;
          if (secondActivationAttempts === 1) {
            throw new Error("development gateway did not start");
          }
          retryStarted = true;
          await retryRelease;
        }
      },
    });
    await fixture.start(driver, 30_000, 900_000, "development");
    await fixture.work(first);

    try {
      second = await fixture.revision(owner, 2);
      await waitFor("activation retry", async () => (retryStarted ? true : undefined));
      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(
        effects.filter(({ action }) => action === "retire"),
        [],
      );
    } finally {
      // Release paused activation before fixture cleanup waits for the worker to stop.
      releaseRetry();
    }

    // Pending finalization restores the retry budget despite making two activation calls.
    assert.equal((await fixture.work(second)).attempt_count, 1);
    assert.equal(secondActivationAttempts, 2);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      revisionEffect("prepare", first, null),
      revisionEffect("activate", first, first),
      revisionEffect("prepare", second, first),
      revisionEffect("activate", second, second),
      revisionEffect("activate", second, second),
      revisionEffect("retire", first, second),
    ]);
  },
);

// The real SSH Driver owns binding validation; only its remote process protocol
// is substituted. PostgreSQL, IAM, claims, CAS, and the worker run unchanged.
for (const phase of ["post-CAS", "revoked pre-CAS"]) {
  test(
    `a cold SSH worker recovers ${phase} cutover with persisted bindings`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { id: "compute-ssh", implementation: "occ/ssh" });
      const owner = await fixture.agent("embedded");
      let interrupted = false;
      let recovering = false;
      let second;
      const { operations, createDriver } = await sshDrivers(
        context,
        fixture.namespace,
        async (operation) => {
          if (
            !recovering &&
            second !== undefined &&
            ((phase === "post-CAS" && operation.operation === "retire-revision") ||
              (phase === "revoked pre-CAS" &&
                operation.operation === "activate-revision" &&
                operation.revision.id === second.id))
          ) {
            interrupted = true;
            throw new Error("lost remote operation confirmation");
          }
        },
      );
      const first = await fixture.revision(owner, 1);
      await fixture.start(createDriver());
      await fixture.work(first);
      second = await fixture.revision(owner, 2);
      await fixture.waitForWork(second, (work) => interrupted && queuedCutover(work));
      await fixture.stop();
      const activeId = phase === "post-CAS" ? second.id : first.id;
      assert.equal(await fixture.activeRevision(owner), activeId);

      // Revocation forbids a new deployment, but cannot abandon committed cleanup
      // or compensation for the already authorized durable attempt.
      await fixture.revokeDeploy(owner);
      operations.length = 0;
      recovering = true;
      await fixture.start(createDriver());
      const completed = await fixture.work(
        second,
        phase === "post-CAS" ? "succeeded" : "failed_permanent",
      );
      assertCutoverCleared(completed);
      assert.equal(await fixture.activeRevision(owner), activeId);
      assert.deepEqual(
        operations
          .filter(({ operation }) => operation !== "probe")
          .map(({ operation, revision, rollbackFromRevisionId }) => ({
            operation,
            revisionId: revision.id,
            rollbackFromRevisionId,
          })),
        phase === "post-CAS"
          ? [
              {
                operation: "retire-revision",
                revisionId: first.id,
                rollbackFromRevisionId: undefined,
              },
            ]
          : [
              {
                operation: "deactivate-revision",
                revisionId: second.id,
                rollbackFromRevisionId: undefined,
              },
              {
                operation: "activate-revision",
                revisionId: first.id,
                rollbackFromRevisionId: second.id,
              },
            ],
      );
    },
  );
}

for (const phase of ["activation", "recovery", "revoked recovery", "retirement"]) {
  test(`production SSH cutover honors stop during ${phase}`, requiresPostgres, async (context) => {
    const fixture = await setup(context, { id: "compute-ssh", implementation: "occ/ssh" });
    const owner = await fixture.agent("embedded");
    let second;
    let stop;
    let interrupted = false;
    let recovering = false;
    const { operations, createDriver } = await sshDrivers(
      context,
      fixture.namespace,
      async (operation) => {
        const boundary =
          phase === "retirement"
            ? operation.operation === "retire-revision"
            : operation.operation === "activate-revision" && operation.revision.id === second?.id;
        if (second !== undefined && !recovering && boundary) {
          if (phase === "activation") {
            // Admission commits while provider activation is in flight, before
            // the worker can lock the Agent and publish its candidate.
            stop = await fixture.requestStop(owner);
          } else {
            interrupted = true;
            throw new Error("interrupted SSH cutover confirmation");
          }
        }
      },
    );
    const first = await fixture.revision(owner, 1);
    await fixture.start(createDriver());
    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    if (phase !== "activation") {
      await fixture.waitForWork(second, (work) => interrupted && queuedCutover(work));
      await fixture.stop();
      stop = await fixture.requestStop(owner);
      if (phase === "revoked recovery") {
        await fixture.revokeDeploy(owner);
      }
      operations.length = 0;
      recovering = true;
      // A fresh Driver must restore its persisted binding before the cutover
      // releases the same-Agent fence and the authorized stop claim proceeds.
      await fixture.start(createDriver());
    }
    const completed = await fixture.work(
      second,
      phase === "revoked recovery" ? "failed_permanent" : "succeeded",
    );
    assert.ok(stop);
    const stopped = await fixture.work(stop);
    assertCutoverCleared(completed);
    assertCutoverCleared(stopped);
    assert.equal(await fixture.activeRevision(owner), null);
    const state = await fixture.observerPool.query(
      "SELECT desired_runtime_state FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(state.rows[0].desired_runtime_state, "stopped");
    const effects = operations.filter(({ operation }) => operation !== "probe");
    if (phase !== "activation") {
      assert.equal(
        effects.some(({ operation }) => operation === "activate-revision"),
        false,
      );
    }
    assert.ok(effects.some(({ operation }) => operation === "stop-revision"));
    if (phase === "retirement") {
      assert.ok(
        effects.some(
          ({ operation, revision }) => operation === "retire-revision" && revision.id === first.id,
        ),
      );
    } else {
      const published = await fixture.observerPool.query(
        `SELECT id FROM occ.audit_events WHERE namespace_id = $1 AND resource_id = $2
           AND action = 'openclaw.agents.lifecycle.activate'`,
        [fixture.namespace.id, second.id],
      );
      assert.equal(published.rowCount, 0);
    }
  });
}
