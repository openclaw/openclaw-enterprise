import assert from "node:assert/strict";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import { CredentialWithdrawalRefusedError } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  removeAccessBindings,
  withUnavailableIAM,
} from "../helpers/postgres-worker-revision-support.mjs";
import { deferWork, makeWorkDue } from "../helpers/postgres-worker-revision-queue.ts";

import {
  counter,
  readRows,
  readWork,
  readWorkResult,
  required,
  withdrawalFields,
} from "./postgres-worker-credential-observations.ts";

import {
  admitHeldRevision,
  admitInitialRevisionWithHarnessSource,
  agentWithHarnessAndToolSources,
  currentAgent,
  findWithdrawal,
  findWithdrawals,
  queuedWithdrawal,
  requestWithdrawal,
  revokingCompute,
  runMaintenancePass,
  toolSources,
  withCredentialGateway,
  withdrawalAttempt,
  withdrawalAttempts,
  withdrawalRequest,
  type CredentialSourceAgent,
  type FixtureRevision,
  type Identified,
  type RuntimeDrivers,
  type WithdrawalCall,
  type CredentialSourceRevisionCases,
} from "./postgres-worker-credential-scenarios.ts";

export function registerDeploymentWithdrawalCases({
  setup,
  revisionTest,
}: CredentialSourceRevisionCases) {
  revisionTest(
    "a deployment retry never re-attaches a source withdrawn while it was finishing",
    async (fixture) => {
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-during-activation",
      );
      const sourceId = owner.harnessAuth.sourceId;
      const request = withdrawalRequest(fixture, owner, sourceId);
      const prepared: string[] = [];
      const withdrawn: WithdrawalCall[] = [];
      const events: WorkerEvent[] = [];
      let interruptActivation = true;
      await fixture.start(
        {
          ...fixture.compute,
          // The Harness receives the source's attachment only through a prepare.
          async prepareRevision(revision, revisionContext) {
            if (revision.namespaceId === fixture.namespace.id) {
              prepared.push(revision.id);
            }
            return fixture.compute.prepareRevision(revision, revisionContext);
          },
          async activateRevision(revision) {
            if (revision.id === active.id && interruptActivation) {
              interruptActivation = false;
              // The active pointer is already published, so admission accepts the withdrawal
              // while this deployment still has to be retried.
              await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
              throw new Error("activation interrupted");
            }
          },
          async withdrawCredentialSource(revision, source) {
            withdrawn.push([revision.id, source.id]);
            return { sourceId: source.id, state: "revoked" };
          },
        },
        { emit: (event) => events.push(event), transformDrivers: withCredentialGateway },
      );
      await waitFor(
        "the deployment retry to stop at the withdrawal",
        async () =>
          events.some(
            (event) =>
              event.event === "worker.completed" &&
              event.revisionId === active.id &&
              event.operation === "agent_revision.reconcile" &&
              event.code === "CREDENTIAL_WITHDRAWN",
          )
            ? true
            : undefined,
        30_000,
      );
      await waitFor(
        "the withdrawal to be revoked",
        async () => {
          const found = await findWithdrawal(fixture, active, sourceId);
          return found?.state === "revoked" ? found : undefined;
        },
        30_000,
      );
      await fixture.stop();

      // Only the first attempt prepared the revision; the retry stopped before re-attaching.
      assert.deepEqual(prepared, [active.id]);
      const deployment = await fixture.deploymentStatus(owner, active);
      assert.notEqual(deployment.status, "succeeded");
      assert.deepEqual(withdrawn, [[active.id, sourceId]]);
      const agent = await fixture.currentAgent(owner);
      assert.ok(agent, "the Agent must still exist");
      assert.equal(agent.activeRevisionId, active.id);
      // Keep the deferred deployment from being claimed by a later test's worker.
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'WITHDRAWN_DEPLOYMENT_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1 AND state = 'queued'`,
        [active.idempotencyKey],
      );
    },
  );

  revisionTest(
    "non-model sources reach Compute at dispatch and a retry omits the ones withdrawn meanwhile",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-tool-sources", 2);
      const active = await fixture.revision(owner, 1);
      const [first, second] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(first, "missing tool source for first");
      assert.ok(second, "missing tool source for second");
      const dispatched: string[][] = [];
      const withdrawn: WithdrawalCall[] = [];
      const rechecked: WithdrawalCall[] = [];
      let interruptActivation = true;
      await fixture.start(
        {
          ...fixture.compute,
          // Compute attaches the model source and each resolved non-model source.
          async prepareRevision(revision, revisionContext) {
            if (revision.namespaceId === fixture.namespace.id) {
              dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
            }
            return fixture.compute.prepareRevision(revision, revisionContext);
          },
          async activateRevision(revision) {
            if (revision.id === active.id && interruptActivation) {
              interruptActivation = false;
              // Withdraw both non-model sources while this deployment must still be retried. The
              // second request queues no work while the first attempt is outstanding.
              for (const credentialSourceId of [first, second]) {
                await fixture.controller.withdrawAgentCredentialSource(
                  fixture.actor.id,
                  withdrawalRequest(fixture, owner, credentialSourceId),
                );
              }
              throw new Error("activation interrupted");
            }
          },
          async withdrawCredentialSource(revision, source, _signal, options = {}) {
            (options.recheck === true ? rechecked : withdrawn).push([revision.id, source.id]);
            return { sourceId: source.id, state: "revoked" };
          },
        },
        { transformDrivers: withCredentialGateway },
      );
      await fixture.work(active, "succeeded", 30_000);
      await waitFor(
        "both withdrawals to be revoked",
        async () => {
          const found = await fixture.state.read((view) =>
            view.credentialSources.listCredentialWithdrawals(fixture.namespace.id, active.id),
          );
          return found.length === 2 && found.every(({ state }) => state === "revoked")
            ? found
            : undefined;
        },
        30_000,
      );
      await fixture.stop();

      // Unlike a withdrawn model source, withdrawn tool sources do not stop the revision: the
      // retry prepares it again without them and the deployment succeeds.
      assert.deepEqual(dispatched, [[first, second], []]);
      // One withdrawal pass revoked every pending source, in admission order.
      assert.deepEqual(withdrawn, [
        [active.id, first],
        [active.id, second],
      ]);
      // The retry rechecks both revoked sources before it prepares the Sandbox again.
      assert.deepEqual(rechecked, [
        [active.id, first],
        [active.id, second],
      ]);
      const audit = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), ["sources"]),
        `SELECT details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
         AND outcome = 'success'`,
        [fixture.namespace.id],
      );
      assert.deepEqual(audit, [{ sources: [first, second] }]);
    },
  );

  revisionTest(
    "a withdrawal reaches a deployment admitted before it, which activates without the source",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-successor", 1);
      const first = await fixture.revision(owner, 1);
      const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(tool, "missing tool source for tool");
      const dispatched: [revisionId: string, sources: string[]][] = [];
      const withdrawn: WithdrawalCall[] = [];
      const compute: ComputeDriver = {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            dispatched.push([
              revision.id,
              (revisionContext?.credentialSources ?? []).map(({ id }) => id),
            ]);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          return { sourceId: source.id, state: "revoked" };
        },
      };
      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      await fixture.work(first, "succeeded");
      await fixture.stop();

      // The next deployment was admitted with the source; the withdrawal arrives before it runs.
      const second = await fixture.revision(owner, 2);
      const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
      assert.equal(withdrawal.initial.revisionId, first.id);
      const recorded = () => findWithdrawals(fixture, [first, second], tool);
      assert.deepEqual(
        (await recorded()).map((withdrawal) => withdrawal?.state),
        ["pending", "pending"],
      );

      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      await fixture.work(second, "succeeded", 30_000);
      await waitFor(
        "both withdrawals to be revoked",
        async () => {
          const found = await recorded();
          return found.every((withdrawal) => withdrawal?.state === "revoked") ? found : undefined;
        },
        30_000,
      );
      await fixture.stop();

      // The successor was prepared without the source and is now the active revision.
      assert.deepEqual(
        dispatched.filter(([revisionId]) => revisionId === first.id),
        [[first.id, [tool]]],
      );
      const successorDispatches = dispatched.filter(([revisionId]) => revisionId === second.id);
      assert.ok(successorDispatches.length > 0);
      assert.ok(successorDispatches.every(([, sources]) => !sources.includes(tool)));
      assert.deepEqual(
        [...withdrawn].sort(),
        [
          [first.id, tool],
          [second.id, tool],
        ].sort(),
      );
      assert.equal((await currentAgent(fixture, owner)).activeRevisionId, second.id);
      // The read follows the active revision to its own withdrawal instead of answering 404.
      const read = await withdrawal.read(fixture.actor.id);
      assert.equal(read.revisionId, second.id);
      assert.equal(read.state, "revoked");
      const audit = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), ["outcome", "revision_id"]),
        `SELECT outcome, details->>'revisionId' AS revision_id
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
       ORDER BY details->>'revisionId'`,
        [fixture.namespace.id],
      );
      assert.deepEqual(
        audit,
        [first.id, second.id]
          .sort()
          .map((revisionId) => ({ outcome: "success", revision_id: revisionId })),
      );
    },
  );

  revisionTest(
    "a withdrawal reaches the predecessor that runs until its successor's deployment activates",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-predecessor", 1);
      const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(tool, "missing tool source for tool");
      const withdrawn: WithdrawalCall[] = [];
      const compute = revokingCompute(fixture, withdrawn);
      const first = await fixture.revision(owner, 1);
      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      await fixture.work(first, "succeeded");
      const second = await fixture.revision(owner, 2);
      await fixture.work(second, "succeeded", 30_000);
      await fixture.stop();

      // A worker published the third revision as active but has not yet activated it or retired
      // the second, whose Sandbox still runs with the source.
      const third = await fixture.revision(owner, 3);
      await fixture.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          fixture.namespace.id,
          owner.id,
          second.id,
          third.id,
        ),
      );
      const requested = await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, tool),
      );
      assert.equal(requested.revisionId, third.id);
      const recorded = () => findWithdrawals(fixture, [first, second, third], tool);
      // The second deployment's activation retired the first, so only the second gets a row.
      assert.deepEqual(
        (await recorded()).map((withdrawal) => withdrawal?.state),
        [undefined, "pending", "pending"],
      );

      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      await fixture.work(third, "succeeded", 30_000);
      await waitFor(
        "both withdrawals to be revoked",
        async () => {
          const found = await recorded();
          return found[1]?.state === "revoked" && found[2]?.state === "revoked" ? found : undefined;
        },
        30_000,
      );
      await fixture.stop();

      assert.deepEqual(
        [...withdrawn].sort(),
        [
          [second.id, tool],
          [third.id, tool],
        ].sort(),
      );
      assert.equal((await currentAgent(fixture, owner)).activeRevisionId, third.id);
    },
  );

  test(
    "the read reports an unretired predecessor's pending withdrawal once the active one is revoked, until its scheduled retry revokes it",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(
        fixture,
        "withdraw-predecessor-exhausted",
        1,
      );
      const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(tool, "missing tool source for tool");
      const third: { id?: string } = {};
      let revoke = false;
      const compute: ComputeDriver = {
        ...fixture.compute,
        // The published revision has no Sandbox yet. The predecessor's still runs, and the gateway
        // cannot confirm its withdrawal until the outage ends.
        async withdrawCredentialSource(revision, source) {
          return {
            sourceId: source.id,
            state: revision.id === third.id || revoke ? "revoked" : "pending",
          };
        },
      };
      const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
      const first = await fixture.revision(owner, 1);
      await fixture.start(compute, options);
      await fixture.work(first, "succeeded");
      const second = await fixture.revision(owner, 2);
      await fixture.work(second, "succeeded", 30_000);
      await fixture.stop();

      // A worker published the third revision as active; its deployment has not activated it or
      // retired the second (nor will it, if it fails), and no maintenance runs for either.
      const successor = await admitHeldRevision(fixture, owner, 3);
      third.id = successor.id;
      await fixture.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          fixture.namespace.id,
          owner.id,
          second.id,
          successor.id,
        ),
      );
      const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
      assert.equal(withdrawal.initial.revisionId, successor.id);
      assert.equal(withdrawal.initial.withdrawalInProgress, true);
      await fixture.start(compute, options);
      const [secondAttempt] = await withdrawalAttempts(fixture, second);
      assert.ok(secondAttempt, "missing withdrawal work");
      await fixture.work(secondAttempt, "failed_permanent", 30_000);
      const [thirdAttempt] = await withdrawalAttempts(fixture, successor);
      assert.ok(thirdAttempt, "missing withdrawal work");
      await fixture.work(thirdAttempt, "succeeded");

      // The active revision's withdrawal is revoked, but the second revision still runs with the
      // source, so the read reports its withdrawal instead of `revoked`, with its retry queued.
      const waiting = await withdrawal.read(fixture.actor.id);
      assert.equal(waiting.revisionId, second.id);
      assert.ok(waiting, "missing pending withdrawal");
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
      assert.equal(waiting.withdrawalInProgress, true);
      const retry = await queuedWithdrawal(fixture, second);
      assert.equal(retry.idempotencyKey, `${secondAttempt.idempotencyKey}:recovery:1`);

      // A replay while the retry is queued queues nothing more, reports it in progress, and lets
      // the retry run now instead of at its scheduled time.
      revoke = true;
      const replayed = await withdrawal.replay(fixture.actor.id);
      assert.equal(replayed.revisionId, second.id);
      assert.equal(replayed.state, "pending");
      assert.equal(replayed.withdrawalInProgress, true);
      assert.equal((await withdrawalAttempts(fixture, successor)).length, 1);
      assert.equal((await withdrawalAttempts(fixture, second)).length, 2);
      await fixture.work(retry, "succeeded");
      await fixture.stop();
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.revisionId, successor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.withdrawalInProgress, false);
    },
  );

  for (const harness of [false, true]) {
    test(
      `maintenance of the active revision re-queues an admitted successor's exhausted ${harness ? "Harness" : "tool"} source withdrawal`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { maxAttempts: 2 });
        const owner = await agentWithHarnessAndToolSources(
          fixture,
          `withdraw-successor-maintenance-${harness}`,
          1,
        );
        const sourceId = harness
          ? owner.harnessAuth.sourceId
          : required(toolSources(owner)[0], "missing tool source").sourceId;
        const second: { id?: string } = {};
        let revoke = false;
        const compute: ComputeDriver = {
          ...fixture.compute,
          maintenanceIntervalMs: 3_600_000,
          // The successor's Sandbox runs; the gateway cannot confirm its withdrawal yet.
          async withdrawCredentialSource(revision, source) {
            return {
              sourceId: source.id,
              state: revision.id !== second.id || revoke ? "revoked" : "pending",
            };
          },
        };
        const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
        const first = await fixture.revision(owner, 1);
        await fixture.start(compute, options);
        await fixture.work(first, "succeeded");
        await fixture.stop();
        const successor = await admitHeldRevision(fixture, owner, 2);
        second.id = successor.id;
        const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
        await fixture.start(compute, options);
        const [attempt] = await withdrawalAttempts(fixture, successor);
        assert.ok(attempt, "missing withdrawal work");
        await fixture.work(attempt, "failed_permanent", 30_000);
        await waitFor("the active revision's withdrawal to be revoked", async () => {
          const [work] = await withdrawalAttempts(fixture, first);
          assert.ok(work, "missing withdrawal work");
          return work?.state === "succeeded" ? work : undefined;
        });
        const exhausted = await withdrawal.read(fixture.actor.id);
        assert.equal(exhausted.revisionId, successor.id);
        assert.equal(exhausted.state, "pending");
        assert.equal(exhausted.withdrawalInProgress, false);

        // The next maintenance pass of the active revision queues the successor's attempt again.
        revoke = true;
        await runMaintenancePass(fixture, first);
        const work = await withdrawalAttempts(fixture, successor);
        assert.equal(work.length, 2, "maintenance must queue the successor's withdrawal again");
        assert.equal((await withdrawalAttempts(fixture, first)).length, 1);
        await fixture.work(required(work[1], "missing recovered withdrawal"), "succeeded");
        const revoked = await withdrawal.read(fixture.actor.id);
        assert.equal(revoked.revisionId, first.id);
        assert.equal(revoked.state, "revoked");

        // Revoked everywhere: nothing is queued again. A Harness-withdrawn revision's maintenance
        // then ends; a tool withdrawal leaves it running.
        await runMaintenancePass(fixture, first);
        if (harness) {
          assert.equal(
            (await fixture.advanceMaintenance(first)).rowCount,
            0,
            "maintenance stops once every withdrawal is revoked",
          );
        }
        await fixture.stop();
        assert.equal((await withdrawalAttempts(fixture, successor)).length, 2);
        assert.equal((await withdrawalAttempts(fixture, first)).length, 1);
      },
    );
  }

  revisionTest(
    "a candidate's withdrawal refused until it is active settles when its deployment activates it, without a replay",
    async (fixture) => {
      const owners: CredentialSourceAgent[] = [];
      for (const label of ["activates", "other-refusal", "outstanding", "active-retirement"]) {
        owners.push(
          await agentWithHarnessAndToolSources(fixture, `withdraw-activation-${label}`, 1),
        );
      }
      const firsts: FixtureRevision[] = [];
      for (const owner of owners) {
        firsts.push(await fixture.revision(owner, 1));
      }
      // Revisions whose withdrawal Compute refuses for another cause, whichever is active.
      const refusals = new Map<
        string,
        ConstructorParameters<typeof CredentialWithdrawalRefusedError>[0]
      >();
      const withdrawn: string[] = [];
      const compute: ComputeDriver = {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        // Like reduceCredentialPolicy, reduce only the Agent's active revision (finding 2235).
        async withdrawCredentialSource(revision, source) {
          withdrawn.push(revision.id);
          const agent = await fixture.state.read((view) =>
            view.agents.findAgent(revision.namespaceId, revision.agentId),
          );
          const code =
            refusals.get(revision.id) ??
            (agent?.activeRevisionId === revision.id
              ? undefined
              : "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
          if (code !== undefined) {
            throw new CredentialWithdrawalRefusedError(code, "Compute refused the withdrawal.");
          }
          return { sourceId: source.id, state: "revoked" };
        },
      };
      const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
      await fixture.start(compute, options);
      for (const first of firsts) {
        await fixture.work(first, "succeeded");
      }
      await fixture.stop();

      // The first three Agents have a later candidate still deploying when the withdrawal is
      // requested. The last one has none; its active revision refuses retirement itself.
      const seconds: FixtureRevision[] = [];
      for (const owner of owners.slice(0, 3)) {
        seconds.push(await admitHeldRevision(fixture, owner, 2));
      }
      const activating = required(seconds[0], "missing activating successor");
      const conflicting = required(seconds[1], "missing conflicting successor");
      const replaying = required(seconds[2], "missing replaying successor");
      const retiring = required(firsts[3], "missing retiring revision");
      refusals.set(conflicting.id, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
      refusals.set(retiring.id, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
      // Another operator requests the first Agent's withdrawal; its attempts run as that operator.
      const requester = `withdraw-activation-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester);
      const withdrawals: Awaited<ReturnType<typeof requestWithdrawal>>[] = [];
      for (const [index, owner] of owners.entries()) {
        const sourceId = required(toolSources(owner)[0], "missing tool source").sourceId;
        withdrawals.push(
          await requestWithdrawal(
            fixture,
            owner,
            sourceId,
            index === 0 ? requester : fixture.actor.id,
          ),
        );
      }
      const activatingWithdrawal = required(withdrawals[0], "missing activating withdrawal");
      const conflictingWithdrawal = required(withdrawals[1], "missing conflicting withdrawal");
      const replayedWithdrawal = required(withdrawals[2], "missing replayed withdrawal");
      const retiringWithdrawal = required(withdrawals[3], "missing retiring withdrawal");
      await fixture.start(compute, options);
      for (const [index, second] of seconds.entries()) {
        await fixture.work(await withdrawalAttempt(fixture, second), "failed_permanent");
        await fixture.work(
          await withdrawalAttempt(fixture, required(firsts[index], "missing predecessor")),
          "succeeded",
        );
      }
      await fixture.work(await withdrawalAttempt(fixture, retiring), "failed_permanent");
      await fixture.stop();
      const refused = await activatingWithdrawal.read(fixture.actor.id);
      assert.equal(refused.revisionId, activating.id);
      assert.equal(refused.state, "pending");
      assert.equal(refused.lastReason, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
      assert.equal(
        refused.withdrawalInProgress,
        false,
        "the refusal awaits a replay or activation",
      );

      // The third Agent's operator replays while its candidate still deploys. That attempt would
      // fail the same way; hold it, so it is still queued when the candidate activates.
      await replayedWithdrawal.replay(fixture.actor.id);
      const replay = required((await withdrawalAttempts(fixture, replaying))[1], "missing replay");
      assert.equal(replay.state, "queued");
      await deferWork(fixture.observerPool, replay.idempotencyKey, "1 day");
      for (const second of seconds) {
        await makeWorkDue(fixture.observerPool, second.idempotencyKey);
      }
      await fixture.start(compute, options);
      for (const second of seconds) {
        await fixture.work(second, "succeeded", 30_000);
      }

      // Activation queues one attempt for the refused withdrawal, as its requester, and that
      // attempt reduces the now-active revision. Nobody replayed it.
      const activated = await withdrawalAttempts(fixture, activating);
      assert.equal(activated.length, 2, "activation queues exactly one attempt");
      const activation = activated[1];
      assert.equal(
        activation?.idempotencyKey,
        `agent_revision:${activating.id}:reconcile:credentials_withdrawn:activation`,
      );
      assert.equal(activation.actorId, requester);
      await fixture.work(activation, "succeeded");
      const settled = await activatingWithdrawal.read(fixture.actor.id);
      assert.equal(settled.revisionId, activating.id);
      assert.equal(settled.state, "revoked");
      assert.equal(withdrawn.filter((id) => id === activating.id).length, 2);

      // Activation queues nothing for a refusal it does not change, nor beside an attempt that
      // is still queued; that attempt then settles the withdrawal.
      assert.equal((await withdrawalAttempts(fixture, conflicting)).length, 1);
      const other = await conflictingWithdrawal.read(fixture.actor.id);
      assert.equal(other.state, "pending");
      assert.equal(other.lastReason, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
      assert.equal((await withdrawalAttempts(fixture, replaying)).length, 2);
      await makeWorkDue(fixture.observerPool, replay.idempotencyKey);
      await fixture.work(replay, "succeeded");
      assert.equal((await replayedWithdrawal.read(fixture.actor.id)).state, "revoked");

      // An active revision's own retirement refusal still waits for a replay: its maintenance
      // passes, which complete the activated revision too, queue no attempt.
      await runMaintenancePass(fixture, retiring);
      await fixture.stop();
      assert.equal((await withdrawalAttempts(fixture, retiring)).length, 1);
      const retirement = await retiringWithdrawal.read(fixture.actor.id);
      assert.equal(retirement.state, "pending");
      assert.equal(retirement.withdrawalInProgress, false);
    },
  );

  for (const successor of [false, true]) {
    test(
      `maintenance stops re-queuing ${successor ? "an admitted successor's Harness" : "a tool"} source withdrawal denied to its requester until an authorized replay`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { maxAttempts: 2 });
        const owner = await agentWithHarnessAndToolSources(
          fixture,
          `withdraw-denied-maintenance-${successor}`,
          1,
        );
        const sourceId = successor
          ? owner.harnessAuth.sourceId
          : required(toolSources(owner)[0], "missing tool source").sourceId;
        let revoke = false;
        let iamUnavailable = false;
        const compute: ComputeDriver = {
          ...fixture.compute,
          maintenanceIntervalMs: 3_600_000,
          // The gateway cannot confirm a revocation until the outage ends.
          async withdrawCredentialSource(_revision, source) {
            return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
          },
        };
        const options = {
          convergenceTimeoutMs: 50,
          transformDrivers: (drivers: RuntimeDrivers) =>
            withUnavailableIAM(() => iamUnavailable)(withCredentialGateway(drivers)),
        };
        const first = await fixture.revision(owner, 1);
        await fixture.start(compute, options);
        await fixture.work(first, "succeeded");
        await fixture.stop();
        // The withdrawal reaches the active revision and, in the successor case, a deployment
        // admitted before it that has not run yet.
        const withdrawing = successor
          ? [first, await admitHeldRevision(fixture, owner, 2)]
          : [first];

        // Another operator requests the withdrawal and is offboarded before the worker runs it,
        // so each attempt of that request is denied.
        const requester = `withdraw-denied-requester-${randomUUID()}`;
        await fixture.copyActorGrants(requester);
        const withdrawal = await requestWithdrawal(fixture, owner, sourceId, requester);
        await removeAccessBindings(fixture, requester);
        await fixture.start(compute, options);
        for (const revision of withdrawing) {
          const [attempt] = await withdrawalAttempts(fixture, revision);
          assert.ok(attempt, "missing withdrawal work");
          await fixture.work(attempt, "failed_permanent");
        }
        const denials = async () =>
          required(
            (
              await readRows(
                fixture.observerPool,
                counter,
                `SELECT count(*)::int AS count FROM occ.audit_events
             WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
               AND kind = 'authorization_denial'`,
                [fixture.namespace.id],
              )
            )[0],
            "missing denial count",
          ).count;
        assert.equal(await denials(), withdrawing.length);
        const attemptCounts = () =>
          Promise.all(
            withdrawing.map(
              async (revision) => (await withdrawalAttempts(fixture, revision)).length,
            ),
          );

        // Only an operator who still holds operate can complete the withdrawal, so maintenance
        // queues no further denied attempt and audits no further denial, pass after pass, and
        // the read reports a withdrawal that needs a replay.
        for (let pass = 0; pass < 3; pass += 1) {
          await runMaintenancePass(fixture, first);
        }
        assert.deepEqual(
          await attemptCounts(),
          withdrawing.map(() => 1),
        );
        assert.equal(await denials(), withdrawing.length);
        const waiting = await withdrawal.read(fixture.actor.id);
        assert.ok(waiting, "missing pending withdrawal");
        assert.equal(waiting.state, "pending");
        assert.equal(waiting.withdrawalInProgress, false);
        assert.equal(waiting.requestedBy, requester);
        assert.equal(waiting.lastReason, "AUTHORIZATION_DENIED");

        // An authorized replay takes the withdrawal over. Its attempts run out while IAM is
        // unavailable; they record that outage, not the earlier denial, so the next maintenance
        // pass queues them again.
        iamUnavailable = true;
        const replayed = await withdrawal.replay(fixture.actor.id);
        assert.equal(replayed.requestedBy, fixture.actor.id);
        assert.equal(replayed.withdrawalInProgress, true);
        const exhaustAttempts = async () => {
          for (const revision of withdrawing) {
            const latest = (await withdrawalAttempts(fixture, revision)).at(-1);
            assert.ok(latest, "missing latest withdrawal work");
            await fixture.work(latest, "failed_permanent", 30_000);
          }
        };
        await exhaustAttempts();
        const iamOutage = await withdrawal.read(fixture.actor.id);
        assert.equal(iamOutage.lastReason, "DEPENDENCY_UNAVAILABLE");
        assert.equal(iamOutage.withdrawalInProgress, false);
        iamUnavailable = false;
        await runMaintenancePass(fixture, first);
        assert.deepEqual(
          await attemptCounts(),
          withdrawing.map(() => 3),
        );

        // Those attempts run out during a gateway outage, and the next pass queues them again.
        await exhaustAttempts();
        const gatewayOutage = await withdrawal.read(fixture.actor.id);
        assert.equal(gatewayOutage.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
        assert.equal(gatewayOutage.withdrawalInProgress, false);
        revoke = true;
        await runMaintenancePass(fixture, first);
        assert.deepEqual(
          await attemptCounts(),
          withdrawing.map(() => 4),
        );
        for (const revision of withdrawing) {
          const recovered = (await withdrawalAttempts(fixture, revision)).at(-1);
          assert.ok(recovered, "missing latest withdrawal work");
          await fixture.work(recovered, "succeeded");
        }
        await fixture.stop();
        const revoked = await withdrawal.read(fixture.actor.id);
        assert.equal(revoked.state, "revoked");
        assert.equal(revoked.requestedBy, fixture.actor.id);
        assert.equal(await denials(), withdrawing.length);
      },
    );
  }

  test(
    "maintenance leaves a withdrawal Compute refused for a replay after the cause is corrected",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(
        fixture,
        "withdraw-refused-maintenance",
        1,
      );
      const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(tool, "missing tool source for tool");
      let refuse = true;
      let calls = 0;
      const compute: ComputeDriver = {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        // What the Kubernetes Compute Driver throws when the gateway reports another source.
        async withdrawCredentialSource(_revision, source) {
          calls += 1;
          if (refuse) {
            throw new CredentialWithdrawalRefusedError(
              "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT",
              "The Credential Gateway withdrew another credential source.",
            );
          }
          return { sourceId: source.id, state: "revoked" };
        },
      };
      const active = await fixture.revision(owner, 1);
      await fixture.start(compute, {
        convergenceTimeoutMs: 50,
        transformDrivers: withCredentialGateway,
      });
      await fixture.work(active, "succeeded");
      const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
      const [attempt] = await withdrawalAttempts(fixture, active);
      assert.ok(attempt, "missing withdrawal work");
      await fixture.work(attempt, "failed_permanent");

      // Retrying cannot help, so maintenance queues no further attempt, pass after pass.
      for (let pass = 0; pass < 2; pass += 1) {
        await runMaintenancePass(fixture, active);
      }
      assert.equal((await withdrawalAttempts(fixture, active)).length, 1);
      assert.equal(calls, 1);
      const waiting = await withdrawal.read(fixture.actor.id);
      assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
      assert.equal(waiting.withdrawalInProgress, false);

      // Once the cause is corrected, a replay revokes the source.
      refuse = false;
      await withdrawal.replay(fixture.actor.id);
      const replay = (await withdrawalAttempts(fixture, active)).at(-1);
      assert.ok(replay, "missing latest withdrawal work");
      await fixture.work(replay, "succeeded");
      await fixture.stop();
      assert.equal((await withdrawal.read(fixture.actor.id)).state, "revoked");
    },
  );

  revisionTest(
    "a withdrawn Harness source fails a deployment admitted before the withdrawal",
    async (fixture) => {
      const { owner, candidate: first } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-harness-successor",
      );
      const sourceId = owner.harnessAuth.sourceId;
      const prepared: string[] = [];
      const compute: ComputeDriver = {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: "revoked" };
        },
      };
      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      await fixture.work(first, "succeeded");
      await fixture.stop();

      const second = await fixture.revision(owner, 2);
      const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
      await fixture.start(compute, { transformDrivers: withCredentialGateway });
      // The successor never re-attaches the model source, so its deployment cannot succeed.
      await fixture.work(second, "failed_permanent", 30_000);
      await waitFor(
        "both withdrawals to be revoked",
        async () => {
          const found = await findWithdrawals(fixture, [first, second], sourceId);
          return found.every((withdrawal) => withdrawal?.state === "revoked") ? found : undefined;
        },
        30_000,
      );
      await fixture.stop();

      assert.equal((await readWorkResult(fixture, second)).reason_code, "CREDENTIAL_WITHDRAWN");
      // The status names the withdrawal and the way out, not the generic failure text (D549).
      assert.deepEqual((await fixture.deploymentStatus(owner, second)).error, {
        code: "CREDENTIAL_WITHDRAWN",
        message:
          "The Harness credential source was withdrawn from this revision, so the revision cannot start. Bind a replacement source or another authentication method, then deploy again.",
      });
      assert.deepEqual(prepared, [first.id]);
      assert.equal((await currentAgent(fixture, owner)).activeRevisionId, first.id);
      const read = await withdrawal.read(fixture.actor.id);
      assert.equal(read.revisionId, first.id);
      assert.equal(read.state, "revoked");
    },
  );

  revisionTest(
    "a withdrawal whose requester lost Agent operate fails once with a denial, and another operator's replay completes it",
    async (fixture) => {
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-denied",
      );
      const withdrawn: WithdrawalCall[] = [];
      const compute = revokingCompute(fixture, withdrawn);
      const startWorker = () =>
        fixture.start(compute, {
          convergenceTimeoutMs: 50,
          transformDrivers: withCredentialGateway,
        });
      await startWorker();
      await fixture.work(active, "succeeded");
      await fixture.stop();

      // A second operator requests the withdrawal and is offboarded before the worker runs it.
      const requester = `withdraw-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester);
      const withdrawal = await requestWithdrawal(
        fixture,
        owner,
        owner.harnessAuth.sourceId,
        requester,
      );
      await removeAccessBindings(fixture, requester);
      const work = await withdrawalAttempts(fixture, active);
      assert.equal(work.length, 1);
      const request = required(work[0], "missing withdrawal request");
      assert.equal(request.actorId, requester);

      await startWorker();
      const failed = await readWork(fixture, request, "failed_permanent");
      // A denial is final on the first attempt and never reaches the gateway.
      assert.equal(failed.attempt_count, 1);
      assert.deepEqual(withdrawn, []);
      const recorded = await withdrawal.read(fixture.actor.id);
      assert.ok(recorded, "the withdrawal must be persisted");
      assert.equal(recorded.state, "pending");
      assert.equal(recorded.requestedBy, requester);
      assert.equal(recorded.lastReason, "AUTHORIZATION_DENIED");
      assert.ok(recorded.lastAttemptAt);
      const audit = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), ["kind", "actor_id", "outcome", "reason_code"]),
        `SELECT kind, actor_id, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
        [fixture.namespace.id],
      );
      assert.deepEqual(audit, [
        {
          kind: "authorization_denial",
          actor_id: requester,
          outcome: "denied",
          reason_code: "AUTHORIZATION_DENIED",
        },
      ]);

      // An authorized operator's replay queues the next attempt on its own authority, so the
      // offboarded requester cannot leave the source usable until a redeploy.
      await fixture.stop();
      const replayed = await withdrawal.replay(fixture.actor.id);
      assert.equal(replayed.state, "pending");
      assert.equal(replayed.requestedBy, fixture.actor.id);
      assert.equal(replayed.requestedAt, recorded.requestedAt);
      assert.equal(replayed.withdrawalInProgress, true);
      const retry = (await withdrawalAttempts(fixture, active)).filter(
        ({ state }) => state === "queued",
      );
      assert.equal(retry.length, 1);
      const retried = required(retry[0], "missing replayed withdrawal");
      assert.equal(retried.actorId, fixture.actor.id);
      await startWorker();
      await fixture.work(retried, "succeeded");
      assert.deepEqual(withdrawn, [[active.id, owner.harnessAuth.sourceId]]);
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.requestedBy, fixture.actor.id);
      const revocations = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), ["actor_id"]),
        `SELECT actor_id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
         AND kind = 'mutation' AND outcome = 'success'`,
        [fixture.namespace.id],
      );
      assert.deepEqual(revocations, [{ actor_id: fixture.actor.id }]);

      // A revoked withdrawal is final: a replay, by another operator too, returns it unchanged
      // and queues nothing.
      await fixture.stop();
      const operator = `withdraw-operator-${randomUUID()}`;
      await fixture.copyActorGrants(operator);
      for (const principalId of [operator, fixture.actor.id]) {
        const final = await withdrawal.replay(principalId);
        assert.equal(final.state, "revoked");
        assert.equal(final.requestedBy, fixture.actor.id);
        assert.equal(final.withdrawalInProgress, false);
      }
      // Only the denied attempt and the replay that completed it.
      assert.equal((await withdrawalAttempts(fixture, active)).length, 2);
    },
  );

  revisionTest(
    "each batched withdrawal is authorized by its own requester, never the claim's actor",
    async (fixture) => {
      const withdrawn: WithdrawalCall[] = [];
      const compute = revokingCompute(fixture, withdrawn);
      const startWorker = () =>
        fixture.start(compute, {
          convergenceTimeoutMs: 50,
          transformDrivers: withCredentialGateway,
        });
      // A second operator with the actor's grants, offboarded after requesting a withdrawal.
      const offboarded = `withdraw-offboarded-${randomUUID()}`;
      const owners: {
        owner: CredentialSourceAgent;
        active: FixtureRevision;
        offboardedOwnsClaim: boolean;
      }[] = [];
      for (const offboardedOwnsClaim of [true, false]) {
        const label = offboardedOwnsClaim ? "claim-by-offboarded" : "claim-by-authorized";
        const owner = await agentWithHarnessAndToolSources(fixture, label, 2);
        owners.push({ owner, active: await fixture.revision(owner, 1), offboardedOwnsClaim });
      }
      await startWorker();
      for (const { active } of owners) {
        await fixture.work(active, "succeeded");
      }
      await fixture.stop();
      // Copy the grants only now, so they include the actor's grants on both new Agents.
      await fixture.copyActorGrants(offboarded);
      // Each Agent gets one withdrawal per requester on one revision-scoped claim. The first
      // request owns the claim: the offboarded operator's for one Agent, the actor's for the other.
      const expectations: {
        owner: CredentialSourceAgent;
        active: FixtureRevision;
        work: Awaited<ReturnType<typeof withdrawalAttempt>>;
        allowed: string;
        deniedSource: string;
      }[] = [];
      for (const { owner, active, offboardedOwnsClaim } of owners) {
        const [first, second] = toolSources(owner).map(({ sourceId }) => sourceId);
        assert.ok(first, "missing tool source for first");
        assert.ok(second, "missing tool source for second");
        const order: [
          [requester: string, sourceId: string],
          [requester: string, sourceId: string],
        ] = offboardedOwnsClaim
          ? [
              [offboarded, first],
              [fixture.actor.id, second],
            ]
          : [
              [fixture.actor.id, first],
              [offboarded, second],
            ];
        for (const [requester, credentialSourceId] of order) {
          await fixture.controller.withdrawAgentCredentialSource(
            requester,
            withdrawalRequest(fixture, owner, credentialSourceId),
          );
        }
        const work = await withdrawalAttempts(fixture, active);
        assert.equal(work.length, 1, "both requests share one revision-scoped claim");
        const claim = required(work[0], "missing batched withdrawal claim");
        assert.equal(claim.actorId, order[0][0]);
        const allowed = required(
          order.find(([requester]) => requester === fixture.actor.id),
          "missing authorized request",
        )[1];
        const deniedSource = required(
          order.find(([requester]) => requester === offboarded),
          "missing offboarded request",
        )[1];
        expectations.push({ owner, active, work: claim, allowed, deniedSource });
      }
      await removeAccessBindings(fixture, offboarded);

      await startWorker();
      for (const { owner, work, allowed, deniedSource } of expectations) {
        // The denied requester fails the claim, but only after the authorized one was revoked.
        await fixture.work(work, "failed_permanent");
        const read = (credentialSourceId: string) =>
          fixture.controller.readAgentCredentialWithdrawal(
            fixture.actor.id,
            withdrawalRequest(fixture, owner, credentialSourceId),
          );
        assert.equal((await read(allowed)).state, "revoked");
        const denied = await read(deniedSource);
        assert.equal(denied.state, "pending");
        assert.equal(denied.lastReason, "AUTHORIZATION_DENIED");
      }
      await fixture.stop();
      // No claim, whoever owned it, detached the offboarded operator's source.
      assert.deepEqual(
        withdrawn,
        expectations.map(({ active, allowed }) => [active.id, allowed]),
      );
      const audit = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), [
          "kind",
          "actor_id",
          "outcome",
          "revision_id",
          "sources",
        ]),
        `SELECT kind, actor_id, outcome, details->>'revisionId' AS revision_id,
              details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
       ORDER BY kind DESC`,
        [fixture.namespace.id],
      );
      // Both events commit in one transaction and can share a timestamp, so order by kind.
      for (const { active, allowed, deniedSource } of expectations) {
        const rows = audit.filter(({ revision_id }) => revision_id === active.id);
        assert.deepEqual(
          rows.map(({ kind, actor_id, outcome, sources }) => ({
            kind,
            actor_id,
            outcome,
            sources,
          })),
          [
            {
              kind: "mutation",
              actor_id: fixture.actor.id,
              outcome: "success",
              sources: [allowed],
            },
            {
              kind: "authorization_denial",
              actor_id: offboarded,
              outcome: "denied",
              sources: [deniedSource],
            },
          ],
        );
      }
    },
  );

  revisionTest(
    "a withdrawal counts an absent credential as revoked, keeps confirmed revocations through a failure, and never withdraws through another Compute",
    async (fixture) => {
      const partial = await agentWithHarnessAndToolSources(fixture, "withdraw-partial", 2);
      const moved = await agentWithHarnessAndToolSources(fixture, "withdraw-moved", 1);
      const retirement = await agentWithHarnessAndToolSources(fixture, "withdraw-retirement", 2);
      const partialRevision = await fixture.revision(partial, 1);
      const movedRevision = await fixture.revision(moved, 1);
      const retirementRevision = await fixture.revision(retirement, 1);
      const [first, second] = toolSources(partial).map(({ sourceId }) => sourceId);
      assert.ok(first, "missing tool source for first");
      assert.ok(second, "missing tool source for second");
      const [movedSource] = toolSources(moved).map(({ sourceId }) => sourceId);
      assert.ok(movedSource, "missing tool source for movedSource");
      const [refusedSource, reducibleSource] = toolSources(retirement).map(
        ({ sourceId }) => sourceId,
      );
      assert.ok(refusedSource, "missing tool source");
      assert.ok(reducibleSource, "missing tool source");
      const withdrawn: WithdrawalCall[] = [];
      let failSecond = true;
      const compute: ComputeDriver = {
        ...fixture.compute,
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          if (source.id === refusedSource) {
            throw new CredentialWithdrawalRefusedError(
              "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
              "The selected Credential Proxy cannot verify a reduced policy.",
            );
          }
          if (source.id === second && failSecond) {
            failSecond = false;
            throw new Error("Sandbox unreachable");
          }
          // A Sandbox that no longer holds the credential reports it absent.
          return { sourceId: source.id, state: source.id === first ? "absent" : "revoked" };
        },
      };
      const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
      await fixture.start(compute, options);
      await fixture.work(partialRevision, "succeeded");
      await fixture.work(movedRevision, "succeeded");
      await fixture.work(retirementRevision, "succeeded");
      await fixture.stop();

      const withdraw = async (
        owner: Identified,
        revision: Identified,
        credentialSourceIds: string[],
      ) => {
        for (const credentialSourceId of credentialSourceIds) {
          await fixture.controller.withdrawAgentCredentialSource(
            fixture.actor.id,
            withdrawalRequest(fixture, owner, credentialSourceId),
          );
        }
        const work = await withdrawalAttempts(fixture, revision);
        assert.equal(work.length, 1);
        return required(work[0], "missing withdrawal work");
      };
      const read = (owner: Identified, credentialSourceId: string) =>
        fixture.controller.readAgentCredentialWithdrawal(
          fixture.actor.id,
          withdrawalRequest(fixture, owner, credentialSourceId),
        );

      // The first source is revoked (reported absent) before the second one fails. The retry
      // withdraws only the unconfirmed source and leaves the confirmed revocation alone.
      const partialWork = await withdraw(partial, partialRevision, [first, second]);
      await fixture.start(compute, options);
      const completed = await readWork(fixture, partialWork, "succeeded", 30_000);
      await fixture.stop();
      assert.equal(completed.attempt_count, 2);
      assert.deepEqual(withdrawn, [
        [partialRevision.id, first],
        [partialRevision.id, second],
        [partialRevision.id, second],
      ]);
      // Both sources end revoked, each with the reason of the pass that confirmed it.
      assert.deepEqual(
        [await read(partial, first), await read(partial, second)].map(({ state, lastReason }) => ({
          state,
          lastReason,
        })),
        [
          { state: "revoked", lastReason: "CREDENTIALS_WITHDRAWN" },
          { state: "revoked", lastReason: "CREDENTIALS_WITHDRAWN" },
        ],
      );

      // A worker for another Compute never withdraws, or confirms, a revision it does not run.
      const movedWork = await withdraw(moved, movedRevision, [movedSource]);
      await fixture.start({ ...compute, id: `${fixture.compute.id}-other` }, options);
      await fixture.work(movedWork, "failed_permanent", 30_000);
      await fixture.stop();
      assert.equal(withdrawn.length, 3);
      const pending = await read(moved, movedSource);
      assert.equal(pending.state, "pending");
      assert.equal(pending.lastReason, "COMPUTE_DRIVER_MISMATCH");

      // A per-source retirement refusal must not suppress a later, independently reducible source.
      const retirementWork = await withdraw(retirement, retirementRevision, [
        refusedSource,
        reducibleSource,
      ]);
      await fixture.start(compute, options);
      await fixture.work(retirementWork, "failed_permanent", 30_000);
      await fixture.stop();
      assert.deepEqual(withdrawn.slice(3), [
        [retirementRevision.id, refusedSource],
        [retirementRevision.id, reducibleSource],
      ]);
      const refused = await read(retirement, refusedSource);
      assert.equal(refused.state, "pending");
      assert.equal(refused.lastReason, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
      assert.equal((await read(retirement, reducibleSource)).state, "revoked");
    },
  );
}
