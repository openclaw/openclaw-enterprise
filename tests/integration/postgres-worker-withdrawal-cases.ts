import assert from "node:assert/strict";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import {
  CredentialWithdrawalRefusedError,
  ResourceStateConflictError,
  SandboxGatewayUnauthorizedError,
} from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { withNamespaceLockHeld } from "../helpers/postgres-namespace-lock.mjs";
import { removeAccessBindings } from "../helpers/postgres-worker-revision-support.mjs";

import {
  readRows,
  readWork,
  readWorkResult,
  required,
  withdrawalFields,
  workKey,
  workStateAndActor,
} from "./postgres-worker-credential-observations.ts";

import {
  admitInitialRevisionWithHarnessSource,
  agentWithHarnessAndToolSources,
  assertRetryDelay,
  credentialGatewayFixture,
  currentAgent,
  findWithdrawal,
  gatewayOutage,
  queuedWithdrawal,
  recordPendingWithdrawal,
  requestWithdrawal,
  runMaintenancePass,
  runScheduledRetryNow,
  startHarnessWithdrawal,
  startWithGateway,
  toolSources,
  withCredentialGateway,
  withdrawalAttempts,
  withdrawalAudit,
  withdrawalRequest,
  type WithdrawalCall,
  type CredentialSourceRevisionCases,
} from "./postgres-worker-credential-scenarios.ts";

export function registerWithdrawalCases({ setup, revisionTest }: CredentialSourceRevisionCases) {
  revisionTest(
    "credential withdrawal work revokes from the active revision without redeploying it",
    async (fixture) => {
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-target",
      );
      const prepared: string[] = [];
      const withdrawn: WithdrawalCall[] = [];
      let pendingOnce = true;
      await startWithGateway(fixture, {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          // The first observation is still pending, so the worker must retry, not report success.
          if (pendingOnce) {
            pendingOnce = false;
            return { sourceId: source.id, state: "pending" };
          }
          return { sourceId: source.id, state: "revoked" };
        },
      });
      await fixture.work(active, "succeeded");
      const deployments = prepared.length;

      // Record the withdrawal the way the API does: a pending row plus revision-scoped work.
      const source = { id: owner.harnessAuth.sourceId };
      const operationId = randomUUID();
      await fixture.state.transact(async (unit) => {
        await unit.credentialSources.requestCredentialWithdrawal({
          namespaceId: fixture.namespace.id,
          agentId: owner.id,
          revisionId: active.id,
          credentialSourceId: source.id,
          state: "pending",
          requestedBy: fixture.actor.id,
          requestedAt: new Date().toISOString(),
        });
        await unit.operations.append({
          kind: "agent_revision",
          action: "reconcile",
          target: "credentials_withdrawn",
          operationId,
          namespaceId: fixture.namespace.id,
          resourceId: active.id,
          actorId: fixture.actor.id,
        });
      });
      const withdrawal = {
        idempotencyKey: `agent_revision:${active.id}:reconcile:credentials_withdrawn:${operationId}`,
        id: active.id,
      };
      const completed = await readWork(fixture, withdrawal, "succeeded");
      assert.equal(completed.attempt_count, 2, "a pending revocation retries until confirmed");
      assert.deepEqual(withdrawn, [
        [active.id, source.id],
        [active.id, source.id],
      ]);

      // Withdrawal never redeploys or replaces the active revision.
      assert.equal(prepared.length, deployments);
      const [agent, recorded] = await fixture.state.read(async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, owner.id),
          view.credentialSources.findCredentialWithdrawal(
            fixture.namespace.id,
            active.id,
            source.id,
          ),
        ]),
      );
      assert.ok(agent, "the Agent must still exist");
      assert.equal(agent.activeRevisionId, active.id);
      assert.ok(recorded, "the withdrawal must be persisted");
      assert.equal(recorded.state, "revoked");
      assert.ok(recorded.completedAt);
      const deployment = await readRows(
        fixture.observerPool,
        Type.Pick(workStateAndActor, ["state", "attempt_count"]),
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [active.idempotencyKey],
      );
      assert.deepEqual(deployment[0], { state: "succeeded", attempt_count: 1 });
      const audit = await readRows(
        fixture.observerPool,
        Type.Pick(Type.Object(withdrawalFields), [
          "resource_id",
          "outcome",
          "reason_code",
          "revision_id",
          "sources",
        ]),
        `SELECT resource_id, outcome, details->>'reasonCode' AS reason_code,
              details->>'revisionId' AS revision_id, details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
        [fixture.namespace.id],
      );
      assert.deepEqual(audit, [
        {
          resource_id: owner.id,
          outcome: "success",
          reason_code: "CREDENTIALS_WITHDRAWN",
          revision_id: active.id,
          sources: [source.id],
        },
      ]);
    },
  );

  test(
    "a withdrawal that outlasts its attempts in a gateway outage is retried later and revoked without a replay",
    requiresPostgres,
    async (context) => {
      // Kubernetes Compute has no maintenance interval, and neither has this Compute double.
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-outage",
      );
      const { gateway, compute } = gatewayOutage(fixture);
      await startWithGateway(fixture, compute);
      await fixture.work(active, "succeeded");
      const sourceId = owner.harnessAuth.sourceId;
      const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
      const [first] = await withdrawalAttempts(fixture, active);
      assert.ok(first, "missing withdrawal work");
      await fixture.work(first, "failed_permanent");

      // The outage outlasted the attempt budget. The withdrawal stays pending with its reason, and
      // the failing pass already queued a retry for 30 s later, so the read still reports an
      // attempt coming rather than asking for a replay.
      const waiting = await withdrawal.read(fixture.actor.id);
      assert.ok(waiting, "missing pending withdrawal");
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.lastReason, "DEPENDENCY_UNAVAILABLE");
      assert.equal(waiting.withdrawalInProgress, true);
      const retry = await queuedWithdrawal(fixture, active);
      assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:1`);
      assertRetryDelay(retry, 30_000);
      assert.equal(gateway.withdrawn.length, 2);

      // The gateway is back. Nobody replays: the scheduled retry revokes the source.
      gateway.down = false;
      await runScheduledRetryNow(fixture, retry);
      await fixture.work(retry, "succeeded");
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.lastReason, "CREDENTIALS_WITHDRAWN");
      assert.equal(revoked.withdrawalInProgress, false);
      assert.equal(gateway.withdrawn.length, 3);
      assert.deepEqual(
        (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
        ["failed_permanent", "succeeded"],
      );
      // The audit shows the failed series and the revocation that followed it.
      assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
        { outcome: "failure", reason_code: "DEPENDENCY_UNAVAILABLE" },
        { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
      ]);
    },
  );

  test(
    "a source that only a queued withdrawal series blocks is refused with its own 409, not the redeploy advice",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-delete", 1);
      const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(tool, "missing tool source for tool");
      const { gateway: outage, compute } = gatewayOutage(fixture);
      const first = await fixture.revision(owner, 1);
      await startWithGateway(fixture, compute);
      await fixture.work(first, "succeeded");
      await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, tool),
      );
      const [attempt] = await withdrawalAttempts(fixture, first);
      assert.ok(attempt, "missing withdrawal work");
      await fixture.work(attempt, "failed_permanent");

      // Redeploy without the tool source. Its withdrawal series stays queued for the first revision.
      const withoutTool = await fixture.state.transact(async (unit) => {
        await unit.namespaces.lockNamespace(fixture.namespace.id);
        await unit.agents.lockAgent(fixture.namespace.id, owner.id);
        return unit.agents.updateConfiguration(
          fixture.namespace.id,
          owner.id,
          owner.configurationId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [{ sourceId: owner.harnessAuth.sourceId }],
        );
      });
      assert.ok(withoutTool, "the Agent must retain its Harness source");
      const second = await fixture.revision(withoutTool, 2);
      await fixture.work(second, "succeeded");
      await fixture.stop();
      assert.equal((await currentAgent(fixture, owner)).activeRevisionId, second.id);
      const retry = await queuedWithdrawal(fixture, first);

      const gateway = credentialGatewayFixture();
      fixture.controller.registerDriver(gateway);
      fixture.controller.selectDriver("credential_gateway", gateway.id);
      const deleteSource = (sourceId: string) =>
        fixture.controller.deleteCredentialSource(fixture.actor.id, fixture.namespace.id, sourceId);
      // Redeploying again cannot help, so the refusal names the wait and Agent deletion instead.
      await assert.rejects(deleteSource(tool), (error) => {
        assert.ok(error instanceof ResourceStateConflictError);
        assert.equal(error.name, "CredentialWithdrawalInProgressError");
        assert.match(error.message, /^A credential withdrawal is still queued or running/);
        return true;
      });
      // The Harness source the active revision still uses keeps the reference refusal.
      await assert.rejects(deleteSource(owner.harnessAuth.sourceId), (error) => {
        assert.ok(error instanceof ResourceStateConflictError);
        assert.equal(error.name, "ResourceStateConflictError");
        assert.match(
          error.message,
          /^An Agent, active revision, pending deployment, or provisioning request/,
        );
        return true;
      });
      const blocking = (sourceId: string) =>
        fixture.state.transact((unit) =>
          unit.credentialSources.findBlockingReference(fixture.namespace.id, sourceId),
        );
      assert.equal(await blocking(tool), "withdrawal_work");
      assert.equal(
        (
          await fixture.state.read((view) =>
            view.credentialSources.findCredentialSource(fixture.namespace.id, tool),
          )
        )?.state,
        "ready",
        "a refused deletion leaves the source as it was",
      );

      // Once the series confirms, nothing blocks the deletion.
      outage.down = false;
      await startWithGateway(fixture, compute);
      await runScheduledRetryNow(fixture, retry);
      await fixture.work(retry, "succeeded");
      await fixture.stop();
      assert.equal(await blocking(tool), undefined);
    },
  );

  test(
    "a withdrawal in a long outage backs off to 5 minutes, stops after its last retry, and a replay starts again",
    requiresPostgres,
    async (context) => {
      // One attempt per series, so each series is one gateway call.
      const fixture = await setup(context, { maxAttempts: 1 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-long-outage",
      );
      const { gateway, compute } = gatewayOutage(fixture);
      const calls = () => gateway.withdrawn.length;
      await startWithGateway(fixture, compute);
      const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);
      await fixture.work(firstAttempt, "failed_permanent");

      // A scheduled retry does not run before it is due, so a gateway that stays down is not
      // called in a loop.
      await delay(1_000);
      assert.equal(calls(), 1);
      // Each retry waits twice as long as the one before, up to 5 minutes, about an hour in all.
      const delays = [
        30_000,
        60_000,
        120_000,
        240_000,
        ...Array.from({ length: 11 }, () => 300_000),
      ];
      for (const [index, delayMs] of delays.entries()) {
        const retry = await queuedWithdrawal(fixture, active);
        assert.equal(retry.idempotencyKey, `${firstAttempt.idempotencyKey}:recovery:${index + 1}`);
        assertRetryDelay(retry, delayMs);
        assert.equal(calls(), index + 1);
        await runScheduledRetryNow(fixture, retry);
        await fixture.work(retry, "failed_permanent");
      }

      // After the last retry nothing is queued, and the read says only a replay retries it.
      assert.deepEqual(
        (await withdrawalAttempts(fixture, active)).filter(
          ({ state }) => state !== "failed_permanent",
        ),
        [],
      );
      const exhausted = await withdrawal.read(fixture.actor.id);
      assert.equal(exhausted.state, "pending");
      assert.equal(exhausted.lastReason, "DEPENDENCY_UNAVAILABLE");
      assert.equal(exhausted.withdrawalInProgress, false);
      assert.equal(calls(), delays.length + 1);
      // One failure audit per series: the record shows every retry and nothing more.
      const audit = await withdrawalAudit(fixture);
      assert.equal(audit.length, delays.length + 1);
      assert.ok(
        audit.every(
          ({ outcome, reason_code }) =>
            outcome === "failure" && reason_code === "DEPENDENCY_UNAVAILABLE",
        ),
      );

      // A replay is a new request with its own retries; with the gateway back it revokes the source.
      // The replay's series is due at once, so the worker stops first: a running worker could claim
      // it before it is read here.
      await fixture.stop();
      gateway.down = false;
      const replayed = await withdrawal.replay(fixture.actor.id);
      assert.equal(replayed.withdrawalInProgress, true);
      const replay = await queuedWithdrawal(fixture, active);
      assert.ok(!replay.idempotencyKey.startsWith(firstAttempt.idempotencyKey));
      await startWithGateway(fixture, compute);
      await fixture.work(replay, "succeeded");
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.withdrawalInProgress, false);
    },
  );

  test(
    "a withdrawal retried after an outage leaves one denied to its requester for a replay",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-outage-denied", 2);
      const active = await fixture.revision(owner, 1);
      const [allowed, deniedSource] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(allowed, "missing tool source for allowed");
      assert.ok(deniedSource, "missing tool source for deniedSource");
      const { gateway, compute } = gatewayOutage(fixture);
      await startWithGateway(fixture, compute);
      await fixture.work(active, "succeeded");
      await fixture.stop();

      // The actor withdraws one tool source, and an operator who is then offboarded the other.
      // Both share the actor's claim.
      const offboarded = `withdraw-outage-offboarded-${randomUUID()}`;
      await fixture.copyActorGrants(offboarded);
      const allowedWithdrawal = await requestWithdrawal(fixture, owner, allowed, fixture.actor.id);
      const deniedWithdrawal = await requestWithdrawal(fixture, owner, deniedSource, offboarded);
      await removeAccessBindings(fixture, offboarded);
      const [first, ...others] = await withdrawalAttempts(fixture, active);
      assert.ok(first, "missing withdrawal work");
      assert.deepEqual(others, []);

      // The authorized withdrawal runs out of attempts in the outage, so a retry is queued for it.
      await startWithGateway(fixture, compute);
      await fixture.work(first, "failed_permanent");
      const retry = await queuedWithdrawal(fixture, active);
      assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:1`);

      // With the gateway back, the retry revokes the authorized source. The denied one still never
      // reaches the gateway, and nothing queues it again: only an authorized replay can.
      gateway.down = false;
      await runScheduledRetryNow(fixture, retry);
      await fixture.work(retry, "failed_permanent");
      assert.equal((await allowedWithdrawal.read(fixture.actor.id)).state, "revoked");
      const denied = await deniedWithdrawal.read(fixture.actor.id);
      assert.equal(denied.state, "pending");
      assert.equal(denied.lastReason, "AUTHORIZATION_DENIED");
      assert.equal(denied.withdrawalInProgress, false);
      assert.deepEqual(
        (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
        ["failed_permanent", "failed_permanent"],
      );
      await fixture.stop();
      assert.ok(gateway.withdrawn.every((sourceId) => sourceId === allowed));
      // Each series audits the denial once; the outage failure and the revocation once each.
      // Events of one series share a transaction, so compare them as a set.
      const entries = (rows: readonly object[]) => rows.map((row) => JSON.stringify(row)).sort();
      assert.deepEqual(
        entries(await withdrawalAudit(fixture, "outcome", "actor_id", "sources")),
        entries([
          { outcome: "failure", actor_id: fixture.actor.id, sources: [allowed] },
          { outcome: "denied", actor_id: offboarded, sources: [deniedSource] },
          { outcome: "success", actor_id: fixture.actor.id, sources: [allowed] },
          { outcome: "denied", actor_id: offboarded, sources: [deniedSource] },
        ]),
      );
    },
  );

  test(
    "a withdrawal whose last attempt outlives its lease is retried later and revoked without a replay",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-lost-lease",
      );
      const lastAttempt = Promise.withResolvers<void>();
      const lastAttemptReleased = Promise.withResolvers<void>();
      context.after(() => lastAttemptReleased.resolve());
      const { gateway, compute } = gatewayOutage(fixture, async (calls) => {
        // The series' last gateway call hangs past the claim's lease.
        if (calls === 2) {
          lastAttempt.resolve();
          await lastAttemptReleased.promise;
        }
      });
      await startWithGateway(fixture, compute);
      const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);

      // The lease runs out during the last attempt, so stale-claim recovery fails the work, not
      // the worker's final pass. It still queues the next series.
      await lastAttempt.promise;
      const claimed = await readWork(fixture, firstAttempt, "claimed");
      assert.equal(claimed.attempt_count, 2);
      assert.ok(claimed.claim_token, "claimed withdrawal must own its lease");
      assert.equal((await fixture.expireClaim(firstAttempt, claimed.claim_token)).rowCount, 1);
      lastAttemptReleased.resolve();
      await fixture.work(firstAttempt, "failed_permanent");
      assert.equal((await readWorkResult(fixture, firstAttempt)).reason_code, "LEASE_EXPIRED");
      const retry = await waitFor("the next series after a lost lease", async () => {
        const { rowCount } = await fixture.observerPool.query(
          `SELECT 1 FROM occ.controller_work
         WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn' AND state = 'queued'`,
          [active.id],
        );
        return rowCount === 1 ? queuedWithdrawal(fixture, active) : undefined;
      });
      assert.equal(retry.idempotencyKey, `${firstAttempt.idempotencyKey}:recovery:1`);
      assertRetryDelay(retry, 30_000);
      const waiting = await withdrawal.read(fixture.actor.id);
      assert.ok(waiting, "missing pending withdrawal");
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.withdrawalInProgress, true);

      // The gateway is back. Nobody replays: the scheduled retry revokes the source.
      gateway.down = false;
      await runScheduledRetryNow(fixture, retry);
      await fixture.work(retry, "succeeded");
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.withdrawalInProgress, false);
      assert.equal(gateway.withdrawn.length, 3);
      assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
        { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
      ]);
    },
  );

  test(
    "a replay while a withdrawal series waits takes it over from a requester who lost access and runs it now",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 1 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-replay-series",
      );
      const { gateway, compute } = gatewayOutage(fixture);
      await startWithGateway(fixture, compute);
      await fixture.work(active, "succeeded");

      // An operator withdraws the source. The first series fails in a gateway outage and queues
      // the next one for 30 s later; then the operator is offboarded.
      const offboarded = `withdraw-replay-offboarded-${randomUUID()}`;
      await fixture.copyActorGrants(offboarded);
      const withdrawal = await requestWithdrawal(
        fixture,
        owner,
        owner.harnessAuth.sourceId,
        offboarded,
      );
      const [first] = await withdrawalAttempts(fixture, active);
      assert.ok(first, "missing withdrawal work");
      await fixture.work(first, "failed_permanent");
      const series = await queuedWithdrawal(fixture, active);
      assertRetryDelay(series, 30_000);
      await fixture.stop();
      await removeAccessBindings(fixture, offboarded);

      // With the gateway back, another operator replays. The replay takes the withdrawal over and
      // lets the waiting series run now, without starting a second chain, so the series is not
      // denied to the offboarded operator and no second replay is needed.
      gateway.down = false;
      const replayed = await withdrawal.replay(fixture.actor.id);
      assert.equal(replayed.requestedBy, fixture.actor.id);
      assert.equal(replayed.withdrawalInProgress, true);
      const due = await queuedWithdrawal(fixture, active);
      assert.equal(due.idempotencyKey, series.idempotencyKey);
      assert.ok(due.delayMs <= 0, `expected the series to be due now, got ${due.delayMs} ms`);
      assert.equal((await withdrawalAttempts(fixture, active)).length, 2);

      await startWithGateway(fixture, compute);
      await fixture.work(due, "succeeded");
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.requestedBy, fixture.actor.id);
      // The offboarded operator's failed series stays theirs; the revocation is the replaying
      // operator's.
      assert.deepEqual(await withdrawalAudit(fixture, "actor_id", "outcome", "reason_code"), [
        { actor_id: offboarded, outcome: "failure", reason_code: "DEPENDENCY_UNAVAILABLE" },
        { actor_id: fixture.actor.id, outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
      ]);
    },
  );

  test(
    "a replay during a running attempt takes over a withdrawal it denied, and the attempt retries instead of failing",
    requiresPostgres,
    async (context) => {
      // Registered before the fixture's cleanup so a failed assertion cannot leave the worker's
      // stop waiting on the held gateway call.
      const gatewayCall = Promise.withResolvers<void>();
      const gatewayReleased = Promise.withResolvers<void>();
      context.after(() => gatewayReleased.resolve());
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-replay-running", 2);
      const active = await fixture.revision(owner, 1);
      const [allowed, deniedSource] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(allowed, "missing tool source for allowed");
      assert.ok(deniedSource, "missing tool source for deniedSource");
      const withdrawn: string[] = [];
      const compute: ComputeDriver = {
        ...fixture.compute,
        async withdrawCredentialSource(_revision, source) {
          withdrawn.push(source.id);
          if (withdrawn.length === 1) {
            gatewayCall.resolve();
            await gatewayReleased.promise;
          }
          return { sourceId: source.id, state: "revoked" };
        },
      };
      await startWithGateway(fixture, compute);
      await fixture.work(active, "succeeded");
      await fixture.stop();

      // The actor withdraws one tool source and an operator, offboarded before the worker runs,
      // the other. Both share one claim.
      const offboarded = `withdraw-running-offboarded-${randomUUID()}`;
      await fixture.copyActorGrants(offboarded);
      await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, allowed),
      );
      const deniedWithdrawal = await requestWithdrawal(fixture, owner, deniedSource, offboarded);
      await removeAccessBindings(fixture, offboarded);
      const [work, ...others] = await withdrawalAttempts(fixture, active);
      assert.ok(work, "missing withdrawal work");
      assert.deepEqual(others, []);

      // The attempt has denied the offboarded requester and is revoking the authorized source
      // when the actor replays the denied withdrawal. The running attempt is its only work.
      await startWithGateway(fixture, compute);
      await gatewayCall.promise;
      const replayed = await deniedWithdrawal.replay(fixture.actor.id);
      assert.equal(replayed.requestedBy, fixture.actor.id);
      assert.equal(replayed.withdrawalInProgress, true);
      assert.equal((await withdrawalAttempts(fixture, active)).length, 1);

      // The denial no longer stands, so the attempt retries on the actor's authority.
      gatewayReleased.resolve();
      const completed = await readWork(fixture, work, "succeeded");
      await fixture.stop();
      assert.equal(completed.attempt_count, 2);
      assert.deepEqual(withdrawn, [allowed, deniedSource]);
      const denied = await deniedWithdrawal.read(fixture.actor.id);
      assert.equal(denied.state, "revoked");
      assert.equal(denied.requestedBy, fixture.actor.id);
      assert.deepEqual(await withdrawalAudit(fixture, "actor_id", "outcome", "sources"), [
        { actor_id: fixture.actor.id, outcome: "success", sources: [allowed] },
        { actor_id: fixture.actor.id, outcome: "success", sources: [deniedSource] },
      ]);
    },
  );

  // Each refusal runs twice. Without a maintenance interval, a permanent failure queues no
  // recovery series (only a retryable one does). With one, the refusals differ once the attempt
  // fails: an operator must correct a misconfiguration and then replay, so maintenance leaves it;
  // a gateway refusal ends once the controller identity's Workspace role is restored, so
  // maintenance queues it again (finding 1874).
  for (const { name, maintenanceName, fixtureName, createRefusal, expectedReason, requeued } of [
    {
      name: "a withdrawal Compute refuses as misconfigured fails once and queues no later series",
      maintenanceName:
        "maintenance leaves a withdrawal Compute refused as misconfigured for a replay",
      fixtureName: "withdraw-refused",
      // Simulate a SandboxDriver that cannot name the revision's Sandbox.
      createRefusal: () =>
        new CredentialWithdrawalRefusedError(
          "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
          "Credential withdrawal requires a SandboxDriver that identifies the revision's Harness.",
        ),
      expectedReason: "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
      requeued: false,
    },
    {
      name: "a withdrawal the Sandbox gateway refuses to confirm fails once with SANDBOX_GATEWAY_UNAUTHORIZED",
      maintenanceName:
        "maintenance queues a withdrawal the Sandbox gateway refused to confirm again",
      fixtureName: "withdraw-unauthorized",
      // Simulate OpenShell refusing the controller identity, making a missing Sandbox
      // indistinguishable from a hidden one (finding 1676).
      createRefusal: () =>
        new SandboxGatewayUnauthorizedError(
          "OpenShell refused the controller gateway identity in Workspace oce-test, so the credential of Sandbox sb-test cannot be confirmed withdrawn.",
        ),
      expectedReason: "SANDBOX_GATEWAY_UNAUTHORIZED",
      requeued: true,
    },
  ]) {
    for (const maintenance of [false, true]) {
      test(maintenance ? maintenanceName : name, requiresPostgres, async (context) => {
        const fixture = await setup(context, { maxAttempts: 2 });
        const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
          fixture,
          maintenance ? `${fixtureName}-maintenance` : fixtureName,
        );
        let calls = 0;
        await startWithGateway(fixture, {
          ...fixture.compute,
          ...(maintenance ? { maintenanceIntervalMs: 3_600_000 } : {}),
          async withdrawCredentialSource() {
            calls += 1;
            throw createRefusal();
          },
        });
        const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);

        // A terminal refusal cannot be fixed by retrying, and withdrawal remains unconfirmed.
        const failed = await readWork(fixture, firstAttempt, "failed_permanent");
        assert.equal(failed.attempt_count, 1);
        assert.equal(calls, 1);
        assert.equal((await readWorkResult(fixture, firstAttempt)).reason_code, expectedReason);
        assert.deepEqual(
          (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
          ["failed_permanent"],
        );
        const read = await withdrawal.read(fixture.actor.id);
        assert.equal(read.state, "pending");
        assert.equal(read.lastReason, expectedReason);
        assert.equal(read.withdrawalInProgress, false);
        assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
          { outcome: "failure", reason_code: expectedReason },
        ]);
        if (!maintenance) {
          return;
        }

        // The revision's next maintenance pass decides whether the refusal is attempted again.
        await runMaintenancePass(fixture, active);
        const attempts = await withdrawalAttempts(fixture, active);
        if (requeued) {
          assert.equal(attempts.length, 2, "maintenance must queue the refused withdrawal again");
          const retried = required(attempts[1], "missing retried withdrawal");
          assert.equal(retried.actorId, fixture.actor.id);
          await fixture.work(retried, "failed_permanent");
          assert.equal(calls, 2);
          assert.equal((await readWorkResult(fixture, retried)).reason_code, expectedReason);
        } else {
          assert.deepEqual(
            attempts.map(({ state }) => state),
            ["failed_permanent"],
            "maintenance must leave the refused withdrawal for a replay",
          );
          assert.equal(calls, 1);
          assert.equal((await withdrawal.read(fixture.actor.id)).withdrawalInProgress, false);
        }
      });
    }
  }

  // Finding 1694: OpenShell also answers UNAUTHENTICATED while the controller's token file or
  // the gateway's signing keys are between refreshes. That refusal keeps its reason but retries
  // within the attempt budget, as an outage does, and a persistent one fails with the code only
  // once the budget is spent.
  test(
    "a withdrawal refused as unauthenticated retries before it settles or fails with the code",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-unauthenticated",
      );
      const { gateway, compute } = gatewayOutage(fixture);
      const events: WorkerEvent[] = [];
      const marker = "synthetic-gateway-withdrawal-detail";
      let refusals = 1;
      await fixture.start(
        {
          ...compute,
          async withdrawCredentialSource(revision, source, signal) {
            if (refusals > 0) {
              refusals -= 1;
              throw new SandboxGatewayUnauthorizedError(
                `OpenShell refused the controller identity while withdrawing a credential: ${marker}`,
                { transient: true },
              );
            }
            return required(compute.withdrawCredentialSource, "missing fixture withdrawal")(
              revision,
              source,
              signal,
            );
          },
        },
        {
          convergenceTimeoutMs: 50,
          transformDrivers: withCredentialGateway,
          emit: (event) => events.push(event),
        },
      );
      gateway.down = false;
      const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);
      // The first attempt is refused and retried with its reason; the second revokes.
      const settled = await readWork(fixture, firstAttempt, "succeeded");
      assert.equal(settled.attempt_count, 2);
      assert.equal(gateway.withdrawn.length, 1);
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.lastReason, "CREDENTIALS_WITHDRAWN");
      const completed = events
        .filter(
          ({ event, code }) =>
            event === "worker.completed" && code === "SANDBOX_GATEWAY_UNAUTHORIZED",
        )
        .map(occLogLine);
      assert.deepEqual(
        completed.map(({ outcome, hintCode }) => [outcome, hintCode]),
        [["retry", undefined]],
      );

      // A refusal that outlasts the budget fails with the code, logged with the operator guidance,
      // and nothing is recorded revoked.
      const other = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-unauthenticated-persistent",
      );
      refusals = Number.POSITIVE_INFINITY;
      const { withdrawal: otherWithdrawal, firstAttempt: persistent } =
        await startHarnessWithdrawal(fixture, other.owner, other.candidate);
      const failed = await readWork(fixture, persistent, "failed_permanent");
      assert.equal(failed.attempt_count, 2);
      assert.equal(
        (await readWorkResult(fixture, persistent)).reason_code,
        "SANDBOX_GATEWAY_UNAUTHORIZED",
      );
      const pending = await otherWithdrawal.read(fixture.actor.id);
      assert.equal(pending.state, "pending");
      assert.equal(pending.lastReason, "SANDBOX_GATEWAY_UNAUTHORIZED");
      // Like any withdrawal that ran out of attempts, it enters the recovery series, which is why
      // one failure audit and one guidance line are enough here: the series logs its own.
      const recovery = await queuedWithdrawal(fixture, other.candidate);
      assert.equal(recovery.idempotencyKey, `${persistent.idempotencyKey}:recovery:1`);
      assertRetryDelay(recovery, 30_000);
      // Neither the raw event emitted at the failure boundary nor the production log may leak
      // the driver error's untrusted text.
      assert.ok(
        !JSON.stringify(events.map(occLogLine)).includes(marker),
        "worker logs must omit Driver text",
      );
      assert.ok(
        !JSON.stringify(events).includes(marker),
        "raw worker events must omit Driver text",
      );
      // The lines the worker log keeps (finding 2245).
      const terminal = events
        .map(occLogLine)
        .filter(
          ({ event, code, hintCode }) =>
            event === "worker.completed" &&
            code === "SANDBOX_GATEWAY_UNAUTHORIZED" &&
            hintCode !== undefined,
        );
      assert.equal(terminal.length, 1);
      const line = required(terminal[0], "missing terminal guidance");
      assert.equal(line.hintCode, "sandbox-gateway-identity");
      // The Driver's retry, the queue's permanent failure (with the recovery series queued).
      assert.deepEqual([line.attempt, line.result, line.outcome], [2, "retry", "permanent"]);
      assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
        { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
        { outcome: "failure", reason_code: "SANDBOX_GATEWAY_UNAUTHORIZED" },
      ]);
    },
  );

  test(
    "a terminally failing credential withdrawal takes the Namespace and Agent before its withdrawal rows",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-lock-order",
      );
      let calls = 0;
      const lastAttempt = Promise.withResolvers<void>();
      const lastAttemptReleased = Promise.withResolvers<void>();
      await startWithGateway(fixture, {
        ...fixture.compute,
        async withdrawCredentialSource(_revision, source) {
          // The last attempt stays pending, so the worker fails the work permanently.
          if (++calls === 2) {
            lastAttempt.resolve();
            await lastAttemptReleased.promise;
          }
          return { sourceId: source.id, state: "pending" };
        },
      });
      await fixture.work(active, "succeeded");
      const sourceId = owner.harnessAuth.sourceId;
      await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, sourceId),
      );
      const work = await withdrawalAttempts(fixture, active);
      assert.equal(work.length, 1);
      const withdrawal = required(work[0], "missing withdrawal work");

      // A withdrawal request locks the Namespace, then the Agent, then the withdrawal row. Hold
      // the Namespace until the worker's final pass waits on it; that pass must not hold the
      // withdrawal row or the Agent yet, or the two transactions deadlock.
      try {
        await lastAttempt.promise;
        await withNamespaceLockHeld(
          fixture.observerPool,
          fixture.namespace.id,
          async (lock: {
            waitForBlocked(description: string): Promise<unknown>;
            assertNotHeld(sql: string, params: string[], message: string): Promise<void>;
          }) => {
            lastAttemptReleased.resolve();
            // The worker has one connection, and its next transaction is the final pass's.
            await lock.waitForBlocked("the worker's real wait on the Namespace lock");
            await lock.assertNotHeld(
              `SELECT state FROM occ.credential_withdrawals
           WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3
           FOR UPDATE NOWAIT`,
              [fixture.namespace.id, active.id, sourceId],
              "a worker waiting for the Namespace must not already hold the withdrawal row",
            );
            await lock.assertNotHeld(
              "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
              [fixture.namespace.id, owner.id],
              "a worker waiting for the Namespace must not already hold the Agent",
            );
          },
        );
        await fixture.work(withdrawal, "failed_permanent");
      } finally {
        lastAttemptReleased.resolve();
      }
      const recorded = await findWithdrawal(fixture, active, sourceId);
      assert.ok(recorded, "the withdrawal must be persisted");
      assert.equal(recorded.state, "pending");
      assert.equal(recorded.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
    },
  );

  test(
    "maintenance of a withdrawn revision retries the withdrawal and stops once it is revoked",
    requiresPostgres,
    async (context) => {
      // Two attempts, so the withdrawal runs out after one retry backoff of at most 1 s.
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        "withdraw-maintenance",
      );
      const prepared: string[] = [];
      let revoke = false;
      await startWithGateway(fixture, {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      });
      await fixture.work(active, "succeeded");
      const deployments = prepared.length;
      const sourceId = owner.harnessAuth.sourceId;

      await recordPendingWithdrawal(fixture, owner, active, sourceId);
      const queuedWork = async (pattern: string) =>
        await readRows(
          fixture.observerPool,
          workKey,
          `SELECT idempotency_key FROM occ.controller_work
           WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
          [active.id, pattern],
        );

      // Maintenance never re-attaches the source; it queues a withdrawal attempt and keeps going.
      const first = await runMaintenancePass(fixture, active);
      const attempts = await withdrawalAttempts(fixture, active);
      assert.equal(attempts.length, 1);
      const withdrawal = required(attempts[0], "missing maintenance withdrawal");
      assert.equal(withdrawal.actorId, fixture.actor.id);
      await fixture.work(withdrawal, "failed_permanent");
      const [next] = await queuedWork(`agent_revision:${active.id}:maintenance:%`);
      assert.ok(next, "missing successor maintenance");
      assert.notEqual(next.idempotency_key, first.idempotencyKey);
      assert.equal(prepared.length, deployments);

      // The next pass queues another attempt, which is revoked; after that maintenance stops.
      revoke = true;
      await runMaintenancePass(fixture, active);
      await waitFor("the withdrawal to be revoked", async () => {
        const found = await findWithdrawal(fixture, active, sourceId);
        return found?.state === "revoked" ? found : undefined;
      });
      await runMaintenancePass(fixture, active);
      assert.deepEqual(await queuedWork(`agent_revision:${active.id}:%`), []);
      assert.equal(prepared.length, deployments);
    },
  );
}
