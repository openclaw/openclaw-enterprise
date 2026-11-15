import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Agent, ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { removeAccessBindings } from "../helpers/postgres-worker-revision-support.mjs";
import { completion, deferWork } from "../helpers/postgres-worker-revision-queue.ts";

import {
  counter,
  readRows,
  readWork,
  readWorkResult,
  required,
} from "./postgres-worker-credential-observations.ts";

import {
  admitInitialRevisionWithHarnessSource,
  agentWithHarnessAndToolSources,
  assertCredentialSourceAgent,
  findWithdrawal,
  findWithdrawals,
  makeMaintenancePassDue,
  recordPendingWithdrawal,
  removeSourceGrant,
  requestWithdrawal,
  runMaintenancePass,
  startWithGateway,
  toolSources,
  waitForMaintenancePass,
  withCredentialGateway,
  withdrawalAttempts,
  withdrawalRequest,
  type FixtureRevision,
  type WithdrawalCall,
  type CredentialSourceRevisionCases,
} from "./postgres-worker-credential-scenarios.ts";

export function registerWithdrawalMaintenanceCases({
  setup,
  revisionTest,
}: CredentialSourceRevisionCases) {
  revisionTest(
    "maintenance re-queues an exhausted non-model withdrawal and keeps repairing the revision",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-tool-maintenance", 2);
      const active = await fixture.revision(owner, 1);
      const [toolSourceId, remainingToolSourceId] = toolSources(owner).map(
        ({ sourceId }) => sourceId,
      );
      assert.ok(toolSourceId, "missing tool source");
      assert.ok(remainingToolSourceId, "missing tool source");
      const dispatched: string[][] = [];
      let revoke = false;
      await startWithGateway(fixture, {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          if (revision.id === active.id) {
            dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      });
      await fixture.work(active, "succeeded");
      assert.deepEqual(dispatched, [[toolSourceId, remainingToolSourceId]]);

      // A pending tool-source withdrawal with no attempt outstanding, as an outage that
      // exhausted every attempt leaves it.
      await recordPendingWithdrawal(fixture, owner, active, toolSourceId);

      // Maintenance queues a withdrawal attempt and still repairs the revision, without the tool.
      await runMaintenancePass(fixture, active);
      const [queued] = await withdrawalAttempts(fixture, active);
      assert.ok(queued, "maintenance must queue the pending withdrawal again");
      assert.deepEqual(dispatched.at(-1), [remainingToolSourceId]);

      // After the gateway recovers, that attempt revokes the source and the chain continues.
      revoke = true;
      await fixture.work(queued, "succeeded");
      const recorded = required(
        await findWithdrawal(fixture, active, toolSourceId),
        "withdrawal must be persisted",
      );
      assert.equal(recorded.state, "revoked");
      await runMaintenancePass(fixture, active);
      assert.equal(
        (await withdrawalAttempts(fixture, active)).length,
        1,
        "a revoked withdrawal is not queued again",
      );

      // A revoked model source must stop preparation, but an exhausted tool withdrawal still
      // needs maintenance to recover after a gateway outage.
      const modelWithdrawal = await requestWithdrawal(
        fixture,
        owner,
        owner.harnessAuth.sourceId,
        fixture.actor.id,
      );
      await waitFor("model source withdrawal to be revoked", async () => {
        const withdrawal = await modelWithdrawal.read(fixture.actor.id);
        return withdrawal.state === "revoked" ? withdrawal : undefined;
      });
      assert.equal(modelWithdrawal.initial.state, "pending");
      const preparedBeforeWithdrawalRecovery = dispatched.length;
      await fixture.stop();
      await recordPendingWithdrawal(fixture, owner, active, remainingToolSourceId);
      revoke = false;
      await startWithGateway(fixture, {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      });
      await runMaintenancePass(fixture, active);
      const recovered = (await withdrawalAttempts(fixture, active)).at(-1);
      assert.ok(recovered, "missing latest withdrawal work");
      assert.equal(
        (await withdrawalAttempts(fixture, active)).length,
        3,
        "maintenance must recover the remaining tool withdrawal",
      );
      assert.equal(
        dispatched.length,
        preparedBeforeWithdrawalRecovery,
        "a model-withdrawn revision must not be prepared",
      );
      revoke = true;
      await fixture.work(recovered, "succeeded");
      await runMaintenancePass(fixture, active);
      assert.equal(
        (await withdrawalAttempts(fixture, active)).length,
        3,
        "revoked tool sources must not be queued again",
      );
      assert.equal(dispatched.length, preparedBeforeWithdrawalRecovery);
      const maintenance = await readRows(
        fixture.observerPool,
        counter,
        `SELECT count(*)::integer AS count FROM occ.controller_work
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
        [active.id, `agent_revision:${active.id}:maintenance:%`],
      );
      assert.equal(
        required(maintenance[0], "missing maintenance count").count,
        0,
        "maintenance stops only after all withdrawals are revoked",
      );
    },
  );

  test(
    "maintenance re-queues a withdrawal past one awaiting a replay, and never beside an outstanding attempt",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(
        fixture,
        "withdraw-maintenance-preference",
        2,
      );
      // Withdrawals are listed by source ID, so the one that will await a replay comes first.
      const [denied, outage] = toolSources(owner)
        .map(({ sourceId }) => sourceId)
        .sort();
      assert.ok(denied, "missing tool source");
      assert.ok(outage, "missing tool source");
      let revoke = false;
      const compute: ComputeDriver = {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      };
      const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
      const active = await fixture.revision(owner, 1);
      await fixture.start(compute, options);
      await fixture.work(active, "succeeded");
      await fixture.stop();

      // An operator who is offboarded before the worker runs requests the first withdrawal. Its
      // attempt is held back, so the second request queues none.
      const requester = `withdraw-preference-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester);
      await fixture.controller.withdrawAgentCredentialSource(
        requester,
        withdrawalRequest(fixture, owner, denied),
      );
      await removeAccessBindings(fixture, requester);
      const [held] = await withdrawalAttempts(fixture, active);
      assert.ok(held, "missing withdrawal work");
      const holdUntil = (interval: string) =>
        deferWork(fixture.observerPool, held.idempotencyKey, interval);
      await holdUntil("1 day");
      await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, outage),
      );
      const listed = await fixture.state.read((view) =>
        view.credentialSources.listCredentialWithdrawals(fixture.namespace.id, active.id),
      );
      assert.deepEqual(
        listed.map(({ credentialSourceId }) => credentialSourceId),
        [denied, outage],
      );
      await fixture.start(compute, options);

      // While an attempt is outstanding, maintenance queues no other.
      await runMaintenancePass(fixture, active);
      assert.equal(
        (await withdrawalAttempts(fixture, active)).length,
        1,
        "maintenance must not queue an attempt beside an outstanding one",
      );

      // The attempts are denied for the first withdrawal, which then awaits a replay, and run out
      // during the gateway outage for the second. Maintenance still re-queues the second.
      await holdUntil("0 seconds");
      await fixture.work(held, "failed_permanent", 30_000);
      assert.equal(
        required(await findWithdrawal(fixture, active, denied), "missing withdrawal").lastReason,
        "AUTHORIZATION_DENIED",
      );
      revoke = true;
      await runMaintenancePass(fixture, active);
      const attempts = await withdrawalAttempts(fixture, active);
      assert.equal(
        attempts.length,
        2,
        "maintenance must re-queue the withdrawal not awaiting a replay",
      );
      // That attempt revokes the second; the first still awaits an authorized replay.
      await fixture.work(required(attempts[1], "missing retried withdrawal"), "failed_permanent");
      const waiting = await findWithdrawal(fixture, active, denied);
      assert.ok(waiting, "missing pending withdrawal");
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.lastReason, "AUTHORIZATION_DENIED");
      assert.equal(
        required(await findWithdrawal(fixture, active, outage), "missing withdrawal").state,
        "revoked",
      );
    },
  );

  test(
    "a source withdrawn before a lost repair's accepted Sandbox create lands is detached by the next pass",
    requiresPostgres,
    async (context) => {
      // A short lease, so the worker notices the expired claim on its next renewal.
      const fixture = await setup(context, { leaseDurationMs: 3_000 });
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-late-create", 1);
      const active = await fixture.revision(owner, 1);
      const [toolSourceId] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(toolSourceId, "missing tool source for toolSourceId");
      // The tool sources OpenShell lists on the revision's Sandbox; undefined while none exists.
      let sandbox: Set<string> | undefined;
      let holdCreate = false;
      let accepted: string[] | undefined;
      const attachedAtPrepare: string[][] = [];
      const withdrawals: { sourceId: string; recheck: boolean; listed?: boolean }[] = [];
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          maintenanceIntervalMs: 3_600_000,
          async prepareRevision(revision, revisionContext) {
            if (revision.id === active.id) {
              const requested = (revisionContext?.credentialSources ?? []).map(({ id }) => id);
              if (sandbox === undefined && holdCreate) {
                // OpenShell accepts this create, but the worker loses its claim before the answer.
                holdCreate = false;
                accepted = requested;
                const signal = required(
                  currentComputeAbortSignal(),
                  "repair must own an abort signal",
                );
                await new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => resolve(), { once: true });
                });
                throw signal.reason;
              }
              sandbox ??= new Set(requested);
              attachedAtPrepare.push([...sandbox]);
              // Like the OpenShell Sandbox Driver, adopt only a Sandbox with the requested providers.
              const observed = sandbox;
              if (observed.size !== requested.length || requested.some((id) => !observed.has(id))) {
                throw new Error("Refusing a Sandbox without the revision's exact providers.");
              }
            }
            return fixture.compute.prepareRevision(revision, revisionContext);
          },
          async withdrawCredentialSource(_revision, source, _signal, options = {}) {
            withdrawals.push({ sourceId: source.id, recheck: options.recheck === true });
            if (sandbox === undefined) {
              // The withdrawal finds no Sandbox. The accepted create lands right after.
              sandbox = new Set(required(accepted, "missing accepted providers"));
              return { sourceId: source.id, state: "absent" };
            }
            const listed = sandbox.delete(source.id);
            if (options.recheck === true) {
              required(withdrawals.at(-1), "missing gateway withdrawal").listed = listed;
              // OpenShell confirms a fresh detach only once the supervisor applies it.
              return { sourceId: source.id, state: listed ? "pending" : "revoked" };
            }
            return { sourceId: source.id, state: "revoked" };
          },
        },
        {
          convergenceTimeoutMs: 50,
          transformDrivers: withCredentialGateway,
          emit: (event) => events.push(event),
        },
      );
      await fixture.work(active, "succeeded");
      assert.deepEqual([...required(sandbox, "missing prepared Sandbox")], [toolSourceId]);
      const prepared = attachedAtPrepare.length;

      // The Sandbox is lost; the maintenance repair's create is accepted but its claim then lapses.
      sandbox = undefined;
      holdCreate = true;
      const repair = await makeMaintenancePassDue(fixture, active);
      await waitFor("the repair's create to be accepted", async () => accepted);
      assert.deepEqual(accepted, [toolSourceId]);
      const claimed = await readWork(fixture, repair, "claimed");

      // The withdrawal is queued while the repair still holds the Agent, so it runs first once
      // the expired claim is recovered.
      await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, toolSourceId),
      );
      assert.ok(claimed.claim_token, "claimed repair must own its lease");
      assert.equal((await fixture.expireClaim(repair, claimed.claim_token)).rowCount, 1);
      await waitFor("the repair to lose its claim", async () =>
        events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
      );
      const withdrawal = await waitFor("the withdrawal to record the source revoked", async () => {
        const found = await findWithdrawal(fixture, active, toolSourceId);
        return found?.state === "revoked" ? found : undefined;
      });
      assert.equal(withdrawal.lastReason, "CREDENTIALS_WITHDRAWN");

      // The late create brought the withdrawn source back. The recovered repair must detach it
      // again before it prepares, or the withdrawn credential stays usable in the Sandbox.
      await waitFor("the recovered repair to prepare", async () =>
        attachedAtPrepare.length > prepared ? true : undefined,
      );
      assert.deepEqual(attachedAtPrepare.at(-1), [], "the withdrawn source is still attached");
      assert.deepEqual(withdrawals, [
        { sourceId: toolSourceId, recheck: false },
        { sourceId: toolSourceId, recheck: true, listed: true },
      ]);
      const settled = await waitForMaintenancePass(fixture, repair);
      assert.equal(settled.state, "succeeded", `maintenance ended ${settled.reason_code}`);
      // The row stays revoked and no new withdrawal attempt is queued.
      assert.equal(
        required(await findWithdrawal(fixture, active, toolSourceId), "missing withdrawal").state,
        "revoked",
      );
      assert.deepEqual(
        (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
        ["succeeded"],
      );
    },
  );

  revisionTest(
    "a model-withdrawn revision's maintenance rechecks every revoked source, and a failed recheck keeps the chain",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-model-recheck", 1);
      const active = await fixture.revision(owner, 1);
      const modelSourceId = owner.harnessAuth.sourceId;
      const [toolSourceId] = toolSources(owner).map(({ sourceId }) => sourceId);
      assert.ok(toolSourceId, "missing tool source for toolSourceId");
      const rechecked: WithdrawalCall[] = [];
      let recheckFailure: Error | undefined;
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          maintenanceIntervalMs: 3_600_000,
          async withdrawCredentialSource(revision, source, _signal, options = {}) {
            if (options.recheck === true) {
              rechecked.push([revision.id, source.id]);
              if (recheckFailure !== undefined) {
                throw recheckFailure;
              }
            }
            return { sourceId: source.id, state: "revoked" };
          },
        },
        {
          convergenceTimeoutMs: 50,
          transformDrivers: withCredentialGateway,
          emit: (event) => events.push(event),
        },
      );
      await fixture.work(active, "succeeded");
      for (const credentialSourceId of [toolSourceId, modelSourceId]) {
        const requestedWithdrawal = await requestWithdrawal(
          fixture,
          owner,
          credentialSourceId,
          fixture.actor.id,
        );
        await waitFor(`withdrawal of ${credentialSourceId} to be revoked`, async () => {
          const withdrawal = await requestedWithdrawal.read(fixture.actor.id);
          return withdrawal.state === "revoked" ? withdrawal : undefined;
        });
      }

      // A gateway outage during the recheck ends only this pass, as REVISION_FINALIZATION_INCOMPLETE
      // (DependencyUnavailableError carries no dependency code); the chain queues the next pass
      // instead of stopping with a revoked source maybe still attached.
      recheckFailure = new DependencyUnavailableError("The Credential Gateway did not answer.");
      rechecked.length = 0;
      const failed = await makeMaintenancePassDue(fixture, active);
      const pending = await completion(
        events,
        "the failed recheck's pass to end pending",
        (event) =>
          event.event === "worker.completed" &&
          event.workId === failed.idempotencyKey &&
          event.outcome === "pending",
      );
      assert.equal(pending.code, "REVISION_FINALIZATION_INCOMPLETE");
      assert.deepEqual(rechecked, [[active.id, modelSourceId]]);

      // The next pass rechecks every revoked source in admission order, then the chain stops:
      // all withdrawals are revoked.
      recheckFailure = undefined;
      rechecked.length = 0;
      await runMaintenancePass(fixture, active);
      assert.deepEqual(rechecked, [
        [active.id, modelSourceId],
        [active.id, toolSourceId],
      ]);
      assert.equal((await fixture.advanceMaintenance(active)).rowCount, 0);
    },
  );

  revisionTest(
    "maintenance keeps re-queuing withdrawals after a withdrawn source loses its Agent grant",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-grant-revoked", 1);
      const active = await fixture.revision(owner, 1);
      const toolSourceId = required(toolSources(owner)[0], "missing tool source").sourceId;
      const modelSourceId = owner.harnessAuth.sourceId;
      const dispatched: string[][] = [];
      await startWithGateway(fixture, {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          if (revision.id === active.id) {
            dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: "revoked" };
        },
      });
      await fixture.work(active, "succeeded");
      assert.deepEqual(dispatched, [[toolSourceId]]);

      // A pending withdrawal whose attempts ran out, after which the Agent principal's grant on
      // the withdrawn source is removed. The source never attaches again either way.
      const strandWithdrawal = async (credentialSourceId: string) => {
        await recordPendingWithdrawal(fixture, owner, active, credentialSourceId);
        await removeSourceGrant(fixture, owner, credentialSourceId);
      };
      const withdrawalState = async (credentialSourceId: string) =>
        required(await findWithdrawal(fixture, active, credentialSourceId), "missing withdrawal")
          .state;

      // A tool source: maintenance re-queues its withdrawal and repairs the revision without it.
      await strandWithdrawal(toolSourceId);
      await runMaintenancePass(fixture, active);
      const [toolWithdrawal, ...extra] = await withdrawalAttempts(fixture, active);
      assert.ok(toolWithdrawal, "maintenance must queue the pending tool withdrawal again");
      assert.deepEqual(extra, []);
      assert.deepEqual(dispatched.at(-1), []);
      await fixture.work(toolWithdrawal, "succeeded");
      assert.equal(await withdrawalState(toolSourceId), "revoked");

      // The model source: maintenance re-queues its withdrawal without preparing the revision.
      await strandWithdrawal(modelSourceId);
      const prepared = dispatched.length;
      await runMaintenancePass(fixture, active);
      const work = await withdrawalAttempts(fixture, active);
      assert.equal(work.length, 2, "maintenance must queue the pending model withdrawal again");
      const modelWithdrawal = required(work[1], "missing model withdrawal work");
      await fixture.work(modelWithdrawal, "succeeded");
      assert.equal(await withdrawalState(modelSourceId), "revoked");
      await runMaintenancePass(fixture, active);
      assert.equal(dispatched.length, prepared, "a model-withdrawn revision must not be prepared");
    },
  );

  revisionTest(
    "an Agent that loses operate on a non-model source after admission never attaches it",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "tool-grant-revoked", 1);
      const toolSourceId = required(toolSources(owner)[0], "missing tool source").sourceId;
      const active = await fixture.revision(owner, 1);
      // The Agent principal's exact grant is removed between admission and dispatch.
      await removeSourceGrant(fixture, owner, toolSourceId);
      const prepared: string[] = [];
      await startWithGateway(fixture, {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      });
      await fixture.work(active, "failed_permanent");
      const failed = await readWorkResult(fixture, active);
      assert.equal(failed.reason_code, "AUTHORIZATION_DENIED");
      // Compute never prepared the revision, so the gateway never attached the source.
      assert.deepEqual(prepared, []);
    },
  );

  revisionTest(
    "maintenance still rechecks the grants on every source that is not withdrawn",
    async (fixture) => {
      const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-other-grant", 1);
      const active = await fixture.revision(owner, 1);
      const toolSourceId = required(toolSources(owner)[0], "missing tool source").sourceId;
      const modelSourceId = owner.harnessAuth.sourceId;
      await startWithGateway(fixture, {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: "revoked" };
        },
      });
      await fixture.work(active, "succeeded");

      // The tool source has a pending withdrawal. The Agent principal then loses its grant on the
      // model source, which is not withdrawn and still attaches, so maintenance must refuse.
      await recordPendingWithdrawal(fixture, owner, active, toolSourceId);
      await removeSourceGrant(fixture, owner, modelSourceId);
      const pass = await makeMaintenancePassDue(fixture, active);
      const settled = await waitForMaintenancePass(fixture, pass);
      assert.deepEqual(settled, { state: "failed_permanent", reason_code: "AUTHORIZATION_DENIED" });
    },
  );

  revisionTest(
    "a withdrawal finds a Harness source on a revision admitted before credential source lists",
    async (fixture) => {
      // Revisions admitted before migration 0050 hold their Harness credential source only as
      // harnessAuth: their admitted spec has no credential_sources key, and 0050 backfilled only
      // Agents. Withdrawal must still find the source there.
      const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-legacy", 0);
      const sourceId = owner.harnessAuth.sourceId;
      const listed = await fixture.revision(owner, 1);
      const legacyRevision = async (number: number) => {
        const id = `rev_${randomUUID()}`;
        await fixture.observerPool.query(
          `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, $3, backend_id, admitted_spec - 'credential_sources',
                clock_timestamp()
         FROM occ.agent_revisions WHERE id = $1`,
          [listed.id, id, number],
        );
        const revision = await fixture.state.read((view) =>
          view.revisions.findRevision(fixture.namespace.id, owner.id, id),
        );
        assert.ok(revision?.harnessAuth.method === "credential_source");
        assert.equal(revision.harnessAuth.sourceId, sourceId);
        assert.equal(revision.credentialSources, undefined);
        return revision;
      };
      const legacy = await legacyRevision(2);
      const successor = await legacyRevision(3);
      assert.ok(
        await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            fixture.namespace.id,
            owner.id,
            undefined,
            legacy.id,
          ),
        ),
        "the fixture Agent must have no active revision yet",
      );

      const requested = await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, sourceId),
      );
      assert.equal(requested.revisionId, legacy.id);
      assert.equal(requested.state, "pending");
      // The admitted legacy successor gets its own withdrawal too. So does the older revision:
      // no deployment has activated the legacy revision yet, so nothing has retired it.
      const recorded = await findWithdrawals(fixture, [listed, legacy, successor], sourceId);
      assert.deepEqual(
        recorded.map((withdrawal) => withdrawal?.state),
        ["pending", "pending", "pending"],
      );
    },
  );

  revisionTest(
    "a revision whose Harness or listed credential source is no longer ready fails with a fixed status message",
    async (fixture) => {
      // Admission saw ready sources; each was marked deleting before dispatch, so the worker fails
      // the revision without preparing it. The status names the cause and the fix, without IDs,
      // instead of the generic "Deployment reconciliation failed." (D549).
      const harness = await admitInitialRevisionWithHarnessSource(
        fixture,
        "harness-source-deleting",
      );
      const listed = await fixture.admitInitialRevision("listed-source-deleting", {
        agent: { auth: "credential_source", nonModelSources: 1 },
      });
      assertCredentialSourceAgent(listed.owner);
      const tool = required(toolSources(listed.owner)[0], "missing listed tool source");
      await fixture.state.transact(async (unit) => {
        for (const sourceId of [harness.owner.harnessAuth.sourceId, tool.sourceId]) {
          assert.ok(
            await unit.credentialSources.markCredentialSourceDeleting(
              fixture.namespace.id,
              sourceId,
            ),
          );
        }
      });
      const prepared: string[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, revisionContext) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, revisionContext);
          },
        },
        { transformDrivers: withCredentialGateway },
      );
      await fixture.work(harness.candidate, "failed_permanent");
      await fixture.work(listed.candidate, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(prepared, []);
      const failures: [
        { owner: Readonly<Agent>; candidate: FixtureRevision },
        { code: string; message: string },
      ][] = [
        [
          harness,
          {
            code: "HARNESS_AUTH_SOURCE_UNAVAILABLE",
            message:
              "The Harness authentication source this revision was admitted with is missing, being deleted, or changed since admission. Bind an available source, then deploy again.",
          },
        ],
        [
          listed,
          {
            code: "CREDENTIAL_SOURCE_UNAVAILABLE",
            message:
              "A credential source this revision lists is missing, being deleted, or changed since admission. Bind available sources, then deploy again.",
          },
        ],
      ];
      for (const [{ owner, candidate }, error] of failures) {
        const status = await fixture.deploymentStatus(owner, candidate);
        assert.equal(status.status, "failed", error.code);
        assert.deepEqual(status.error, error);
      }
    },
  );

  // Keep a real admitted Git session and its attachment through the deadline. This joins the
  // actual worker, PostgreSQL, Git supplier and gateway client. The gateway, workload, issuer and
  // middleware caller are fixtures: the model READY below is not a model turn or a Kubernetes run.
}
