import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { requiresPostgres, setup, waitFor } from "../helpers/compute-singleton-worker.mjs";

test(
  "production worker emits Compute preflight warnings before worker.started and continues startup",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const events = [];

    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {
          return {
            warnings: [
              {
                code: "KUBERNETES_VERSION_BELOW_MINIMUM",
                message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
              },
            ],
          };
        },
      },
      30_000,
      900_000,
      "production",
      (event) => events.push(event),
    );

    assert.deepEqual(events.slice(0, 2), [
      {
        event: "compute.preflight-warning",
        computeDriverId: fixture.compute.id,
        code: "KUBERNETES_VERSION_BELOW_MINIMUM",
        message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
      },
      { event: "worker.started", computeDriverId: fixture.compute.id },
    ]);
  },
);

test(
  "a worker binds persisted Namespace, Agent, and service principal before provider effects",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    const effects = [];

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async preflight() {},
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
    const effects = [];

    async function record(action, candidate) {
      effects.push({
        action,
        revisionId: candidate.id,
        activeRevisionId: await fixture.activeRevision(owner),
      });
    }

    await fixture.start(
      {
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
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
              assert.equal(
                work.live,
                true,
                "the original claim must remain live during activation",
              );
              return work.original_expired && work.renewed ? work : undefined;
            });
          }
        },
        async deactivateRevision(candidate) {
          await record("deactivate", candidate);
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      },
      5_000,
    );
    assert.equal((await fixture.work(first)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), first.id);

    const second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: first.id, activeRevisionId: null },
      { action: "activate", revisionId: first.id, activeRevisionId: null },
      { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
      { action: "activate", revisionId: second.id, activeRevisionId: first.id },
      { action: "retire", revisionId: first.id, activeRevisionId: second.id },
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

test(
  "failed singleton activation retries without publishing or retiring the previous revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const activations = [];
    const retirements = [];
    let failed = false;

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async preflight() {},
      async activateRevision(candidate) {
        activations.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (candidate.revision === 2 && !failed) {
          failed = true;
          throw new Error("provider readiness verification failed");
        }
      },
      async retireRevision(candidate) {
        retirements.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        return fixture.compute.retireRevision(candidate);
      },
    });
    await fixture.work(first);

    const second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second)).attempt_count, 2);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(activations, [
      { revisionId: first.id, activeRevisionId: null },
      { revisionId: second.id, activeRevisionId: first.id },
      { revisionId: second.id, activeRevisionId: first.id },
    ]);
    assert.deepEqual(retirements, [{ revisionId: first.id, activeRevisionId: second.id }]);

    const failure = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [second.id],
    );
    assert.deepEqual(failure.rows, [{ reason: "DEPENDENCY_UNAVAILABLE" }]);
  },
);

test(
  "production Drivers without an activation preference retain after-commit Kubernetes ordering",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const effects = [];

    async function record(action, candidate) {
      effects.push({
        action,
        revisionId: candidate.id,
        activeRevisionId: await fixture.activeRevision(owner),
      });
    }

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async prepareRevision(candidate) {
        await record("prepare", candidate);
        return fixture.compute.prepareRevision(candidate);
      },
      async deactivateRevision(candidate) {
        await record("deactivate", candidate);
      },
      async activateRevision(candidate) {
        await record("activate", candidate);
      },
      async retireRevision(candidate) {
        await record("retire", candidate);
        return fixture.compute.retireRevision(candidate);
      },
    });
    await fixture.work(first);
    const second = await fixture.revision(owner, 2);
    await fixture.work(second);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: first.id, activeRevisionId: null },
      { action: "deactivate", revisionId: first.id, activeRevisionId: null },
      { action: "activate", revisionId: first.id, activeRevisionId: first.id },
      { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
      { action: "activate", revisionId: second.id, activeRevisionId: second.id },
      { action: "retire", revisionId: first.id, activeRevisionId: second.id },
    ]);
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
    const effects = [];
    let secondActivationAttempts = 0;
    let retryStarted = false;
    let releaseRetry;
    const retryRelease = new Promise((resolve) => {
      releaseRetry = resolve;
    });

    async function record(action, candidate) {
      effects.push({
        action,
        revisionId: candidate.id,
        activeRevisionId: await fixture.activeRevision(owner),
      });
    }

    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
          if (candidate.id === second?.id) {
            secondActivationAttempts += 1;
            if (secondActivationAttempts === 1) {
              throw new Error("development gateway did not start");
            }
            retryStarted = true;
            await retryRelease;
          }
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      },
      30_000,
      900_000,
      "development",
    );
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
    // Recovery reobserves the published candidate before retrying activation so
    // current readiness is checked even after the active pointer moves.
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: first.id, activeRevisionId: null },
      { action: "activate", revisionId: first.id, activeRevisionId: first.id },
      { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
      { action: "activate", revisionId: second.id, activeRevisionId: second.id },
      { action: "prepare", revisionId: second.id, activeRevisionId: second.id },
      { action: "activate", revisionId: second.id, activeRevisionId: second.id },
      { action: "retire", revisionId: first.id, activeRevisionId: second.id },
    ]);
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

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      maintenanceIntervalMs: 75,
      async preflight() {},
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
       SET state = 'succeeded',
           completed_at = clock_timestamp(),
           reason_code = 'REVISION_MAINTENANCE_SUPERSEDED',
           updated_at = clock_timestamp()
       WHERE namespace_id = $1 AND state = 'queued'
         AND idempotency_key LIKE $2`,
      [fixture.namespace.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
  },
);

for (const failure of ["observation", "binding"]) {
  test(
    `active maintenance recovers from ${failure} failures beyond its retry budget and stops when its actor is denied`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent();
      const candidate = await fixture.revision(owner, 1);
      let available = false;
      let maintenanceAttempts = 0;
      let bindingAttempts = 0;

      await fixture.start(
        {
          ...fixture.compute,
          activationOrder: "beforeCommit",
          maintenanceIntervalMs: 75,
          async preflight() {},
          async bindAgent() {
            if ((await fixture.activeRevision(owner)) === candidate.id) {
              bindingAttempts += 1;
              if (failure === "binding" && !available) {
                throw new Error("Binding lookup unavailable");
              }
            }
          },
          async prepareRevision(revision) {
            const observation = await fixture.compute.prepareRevision(revision);
            if ((await fixture.activeRevision(owner)) === revision.id) {
              maintenanceAttempts += 1;
              if (!available) {
                return { ...observation, ready: false };
              }
            }
            return observation;
          },
          async activateRevision() {},
        },
        30_000,
        40,
      );
      await fixture.work(candidate);

      // Six failed passes exceed the worker's ordinary five-attempt budget.
      // Active maintenance must survive both binding and observation outages;
      // neither the queue nor the worker recovery logic is replaced by the fixture.
      await waitFor("multiple failed but rescheduled maintenance passes", async () => {
        const result = await fixture.observerPool.query(
          `SELECT COUNT(*)::integer AS failures
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'failed_permanent'`,
          [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
        );
        return result.rows[0].failures >= 6 ? result.rows[0] : undefined;
      });
      if (failure === "binding") {
        assert.equal(maintenanceAttempts, 0);
      }
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
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
      );
      const effectsBeforeDenial = maintenanceAttempts;
      const bindingsBeforeDenial = bindingAttempts;
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
      assert.equal(bindingAttempts, bindingsBeforeDenial);
    },
  );
}
