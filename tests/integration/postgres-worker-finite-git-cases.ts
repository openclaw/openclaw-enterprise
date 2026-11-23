import assert from "node:assert/strict";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputeDriver, WorkspaceSetup } from "../../packages/contracts/src/index.ts";
import type { WorkIdentity } from "../helpers/postgres-worker-refused-candidate.ts";
import { type ClaimedWork } from "../../packages/occ/src/index.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  removeAccessBindings,
  repositoryAttempts,
} from "../helpers/postgres-worker-revision-support.mjs";
import {
  advanceCleanupRetries,
  completion,
  deferWork,
  makeWorkDue,
} from "../helpers/postgres-worker-revision-queue.ts";

import {
  readEgressInstallation,
  readGitFetchCommands,
  readGitDecision,
  readGitWorld,
  readMaintenanceResult,
  readRows,
  readWorkResult,
  required,
  stopActorBinding,
  workKey,
  workKeyAndState,
  workKeyStateAndAttempts,
  workState,
  workStateAndActor,
} from "./postgres-worker-credential-observations.ts";
import { createNarrowOnlineGitStartup } from "../helpers/postgres-repository-set-journey.ts";

import {
  admitHeldRevision,
  assertCredentialSourceAgent,
  currentAgent,
  type FixtureRevision,
} from "./postgres-worker-credential-scenarios.ts";

export function registerFiniteGitCases(testFile: string) {
  test(
    "attached Git expires under ordinary maintenance; a moving Sandbox version and lost detach reply preserve the Agent",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, { newHost: "inference.example.test" }),
  );
  test(
    "attached Git expires; a retained model profile that now covers GitHub retires the revision",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, { newHost: "uploads.github.com" }),
  );

  test(
    "attached Git expires; an overlapping platform profile behind a benign workspace namesake retires the revision",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, { newHost: "uploads.github.com", platformProfile: true }),
  );
  test(
    "attached Git expires; a safe platform profile preserves the Agent until ordinary maintenance loses permission to read it",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, { newHost: "service-2.example.test", platformProfile: true }),
  );

  test(
    "removing finite Git access before its deadline preserves the Agent through a lost detach reply and cold recovery",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, { newHost: "inference.example.test", removal: true }),
  );

  test(
    "finite Git removal retires the revision when its original deploy actor loses authority",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      revokeActor: true,
    }),
  );

  test(
    "removal after acknowledged activation and prior revision retirement preserves deployment completion",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      removalDuringFinalization: true,
    }),
  );

  test(
    "finite Git removal and Stop before activation acknowledgment preserve completion without routine maintenance",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      removalDuringFinalization: true,
      stopDuringFinalization: true,
    }),
  );

  test(
    "unacknowledged activation with finite Git removal retains verified execution without completing deployment or setup",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      unacknowledgedActivation: true,
    }),
  );

  test(
    "unacknowledged activation with finite Git removal retires unsafe execution without completing setup",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "uploads.github.com",
      removal: true,
      unacknowledgedActivation: true,
    }),
  );

  test(
    "finite removal and readdition during maintenance cannot open another repository session",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      removalDuringPreparation: true,
    }),
  );

  test(
    "finite removal during Stop remains withdrawn after a failed deployment supersedes Stop",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      removalDuringPreparation: true,
      removalDuringStop: true,
    }),
  );

  test(
    "finite removal cleanup yields to a supersedable Stop without retiring the original runtime",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      cleanupDuringStop: true,
    }),
  );

  test(
    "finite removal cleanup preserves retirement when the outstanding Stop wins",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      cleanupDuringStop: true,
      stopWins: true,
    }),
  );

  test(
    "finite removal settles provider detachment after a separately authorized Stop is denied",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      cleanupDuringStop: true,
      deniedStop: true,
    }),
  );

  test(
    "finite removal lease recovery preserves the runtime when deferred Stop is superseded",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      cleanupDuringStop: true,
      leaseDuringStop: true,
    }),
  );

  test(
    "finite removal lease recovery preserves retirement when deferred Stop wins",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      cleanupDuringStop: true,
      leaseDuringStop: true,
      stopWins: true,
    }),
  );

  test(
    "finite Git removal maintenance survives exhausted original reconciliation",
    { ...requiresPostgres, timeout: 60_000 },
    attachedGitExpires(testFile, {
      newHost: "inference.example.test",
      removal: true,
      unacknowledgedActivation: true,
      leaseExhaustion: true,
    }),
  );
}

interface FiniteGitOptions {
  newHost: string;
  platformProfile?: boolean;
  removal?: boolean;
  revokeActor?: boolean;
  removalDuringFinalization?: boolean;
  stopDuringFinalization?: boolean;
  unacknowledgedActivation?: boolean;
  removalDuringPreparation?: boolean;
  removalDuringStop?: boolean;
  cleanupDuringStop?: boolean;
  leaseDuringStop?: boolean;
  deniedStop?: boolean;
  stopWins?: boolean;
  leaseExhaustion?: boolean;
}

function attachedGitExpires(
  testFile: string,
  {
    newHost,
    platformProfile = false,
    removal = false,
    revokeActor = false,
    removalDuringFinalization = false,
    stopDuringFinalization = false,
    unacknowledgedActivation = false,
    removalDuringPreparation = false,
    removalDuringStop = false,
    cleanupDuringStop = false,
    leaseDuringStop = false,
    deniedStop = false,
    stopWins = false,
    leaseExhaustion = false,
  }: FiniteGitOptions,
) {
  return async (t: TestContext) => {
    let withdrawalCommitted = false;
    const finalization: {
      stop?: WorkIdentity;
      removal?: { idempotency_key: string };
      unacknowledgedStop?: Promise<void>;
    } = {};
    const stopWork: string[] = [];
    let activationCalls = 0;
    let prepareCalls = 0;
    let pauseBeforePreparation = false;
    let preparing = false;
    const resumePreparation = Promise.withResolvers<void>();
    t.after(() => resumePreparation.resolve());
    let retainedObservations = 0;
    let pendingSetup: Readonly<WorkspaceSetup> | undefined;
    let previous: FixtureRevision | undefined;
    const retired: string[] = [];
    const startup = await createNarrowOnlineGitStartup(t, testFile, {
      draftPull: false,
      sessionDurationSeconds: removal ? 120 : 15,
      platformProfile,
      ...(leaseExhaustion && { maxAttempts: 1 }),
      async beforeAdmission({ fixture, agent: admittedAgent, configuration }) {
        const owner = { ...admittedAgent, configurationId: configuration.id };
        pendingSetup = unacknowledgedActivation
          ? await fixture.state.transact((unit) =>
              unit.workspaceSetups.create({
                id: randomUUID(),
                namespaceId: fixture.namespace.id,
                agentId: owner.id,
                files: { "AGENTS.md": "# Pending workspace instructions" },
                completed: false,
              }),
            )
          : undefined;
        // Admit a held predecessor through the same fixture before the selected revision.
        previous =
          removalDuringFinalization || unacknowledgedActivation
            ? await admitHeldRevision(fixture, owner, 1)
            : undefined;
      },
      configure(methods, gatewayWorld) {
        if (!removal) {
          return;
        }
        const observe = methods.GetSandboxProviderStatus;
        methods.GetSandboxProviderStatus = (request) => {
          const result = observe(request);
          // Removal exercises the concurrent Gateway update before natural expiry.
          if (withdrawalCommitted && gatewayWorld.version === 13) {
            gatewayWorld.version = 14;
          }
          return result;
        };
      },
    });
    const { fixture: f, binding, peer, events, continuity } = startup;
    const world = readGitWorld(startup.world);
    const stopped: string[] = startup.stopped;
    function assertRuntimeStillRunning(message?: string) {
      assert.deepEqual(stopped, [], message ?? "Compute must retain the running revision");
    }
    const idempotencyKey: unknown = startup.work.idempotencyKey;
    assert.ok(typeof idempotencyKey === "string", "queued revision work needs a text key");
    const revision = { ...startup.revision, idempotencyKey };
    const agent = { ...startup.agent, configurationId: startup.configuration.id };
    const namespaceId = f.namespace.id;
    const { client, workspace, sandbox } = startup;
    assertCredentialSourceAgent(agent);
    const model = agent.harnessAuth.sourceId;
    const git = required(revision.repositoryCredentials, "missing admitted repository credentials");
    const egress = required(revision.egressPlan, "missing admitted egress plan");
    const deadlineWallMs = required(git.deadlineWallMs, "missing finite Git deadline");
    let runtime = startup.getRuntime();
    let sessionId: string | undefined;
    const bodies = await readGitFetchCommands(t, "refs/heads/review");
    const originalCompute = startup.compute;
    assert.deepEqual(revision.executionAdmission, { version: 5, mode: "protected" });
    assert.equal(egress.repositoryGitAuthorization, "online-request");
    assert.deepEqual(egress.repositoryGit, git);
    assert.equal(git.standingApprovalId, undefined);
    assert.deepEqual(egress.harnessCredentialSource, revision.harnessAuth);
    const compute = {
      ...originalCompute,
      ...(unacknowledgedActivation && { supportsWorkspaceSetup: true }),
      ...(removalDuringPreparation && {
        async bindAgent(context) {
          // This real Driver call occurs after the worker read the withdrawal marker,
          // but before repository preparation enters its locked session transaction.
          if (pauseBeforePreparation) {
            pauseBeforePreparation = false;
            preparing = true;
            await resumePreparation.promise;
          }
          await originalCompute.bindAgent?.(context);
        },
      }),
      async prepareRevision(r, context) {
        prepareCalls++;
        assert.ok(context, "preparation must have a revision context");
        assert.equal(r.id, revision.id);
        if (unacknowledgedActivation) {
          assert.deepEqual(context.workspaceSetup, pendingSetup);
        }
        assert.equal(r.agentId, agent.id);
        assert.ok(r.harnessAuth.method === "credential_source");
        assert.equal(r.harnessAuth.sourceId, model);
        assert.ok(context.harnessAuth.method === "credential_source");
        assert.ok(context.harnessAuth.source);
        assert.equal(context.harnessAuth.source.id, model);
        assert.equal(
          world.id,
          undefined,
          "the worker must not prepare or replace the running revision after Git withdrawal",
        );
        const [open] = await repositoryAttempts(f, r);
        assert.ok(open, "missing open repository attempt");
        assert.equal(open.phase, "open");
        sessionId = required(open.sessionId, "missing repository session");
        return originalCompute.prepareRevision(r, context);
      },
      ...((removalDuringFinalization || unacknowledgedActivation) && {
        async activateRevision(r) {
          activationCalls++;
          assert.equal(activationCalls, 1, "withdrawal recovery must not reactivate Git");
          assert.equal((await currentAgent(f, agent)).activeRevisionId, r.id);
          await useInitialGit();
          if (unacknowledgedActivation) {
            await commitRemoval();
            // Hold the independent cleanup's due time so original reconciliation itself
            // must recover withdrawal. No activation or workspace delivery is acknowledged.
            await deferWork(
              f.observerPool,
              {
                revisionId: revision.id,
                state: "queued",
                keyLike: "%:repository_cleanup:%",
              },
              "1 day",
            );
            throw new Error("Controlled activation acknowledgment lost");
          }
        },
        async retireRevision(r) {
          assert.equal(unacknowledgedActivation, false, "cleanup cannot retire a predecessor");
          assert.equal(r.id, required(previous, "missing predecessor").id);
          assert.equal(activationCalls, 1);
          await f.compute.retireRevision(r);
          retired.push(r.id);
          // Commit removal only after activation and the actual earlier-revision
          // retirement callback have both returned, before final completion is recorded.
          await commitRemoval();
          if (stopDuringFinalization) {
            // OCC admissions commit while this original deployment still owns the
            // claim; returning from this Driver call acknowledges its final effect.
            const stop = await f.requestStop(agent);
            finalization.stop = stop;
            const held = await readRows(
              f.observerPool,
              workKeyAndState,
              `SELECT idempotency_key, state FROM occ.controller_work
               WHERE agent_id=$1 AND (idempotency_key=$2 OR idempotency_key=$3
                 OR idempotency_key=$4)`,
              [
                agent.id,
                revision.idempotencyKey,
                stop.idempotencyKey,
                repositoryRemovalWorkKey(revision.id),
              ],
            );
            const removal = held.find(
              (row) => row.idempotency_key === repositoryRemovalWorkKey(revision.id),
            );
            assert.ok(removal, "removal retains its own durable cleanup obligation");
            finalization.removal = removal;
            assert.equal(removal.state, "queued");
            assert.equal(
              held.find((row) => row.idempotency_key === revision.idempotencyKey)?.state,
              "claimed",
            );
            assert.equal(
              held.find((row) => row.idempotency_key === stop.idempotencyKey)?.state,
              "queued",
              "Stop waits for the original deployment's acknowledgment",
            );
          }
        },
      }),
      retireExpiredRepositoryAccess: (r, signal) => {
        retainedObservations++;
        return runtime.retireExpiredRepositoryAccess(
          r,
          client,
          workspace,
          sandbox,
          continuity,
          signal,
        );
      },
      async stopRevision(r) {
        stopped.push(r.id);
        if (stopDuringFinalization) {
          const claimed = await readRows(
            f.observerPool,
            workKey,
            `SELECT idempotency_key FROM occ.controller_work
             WHERE agent_id=$1 AND state='claimed'`,
            [agent.id],
          );
          assert.equal(claimed.length, 1);
          stopWork.push(required(claimed[0], "missing claimed Stop").idempotency_key);
        }
        return f.compute.stopRevision(r);
      },
    } satisfies ComputeDriver;
    const readMaintenance = async () =>
      await readRows(
        f.observerPool,
        workKeyStateAndAttempts,
        "SELECT idempotency_key,state,attempt_count FROM occ.controller_work WHERE revision_id=$1 AND idempotency_key LIKE $2 ORDER BY idempotency_key",
        [revision.id, `agent_revision:${revision.id}:maintenance:%`],
      );
    let stoppedMaintenance: Awaited<ReturnType<typeof readMaintenance>> | undefined;
    const start = () =>
      startup.start(compute, (e) => {
        if (
          unacknowledgedActivation &&
          e.event === "worker.completed" &&
          e.workId === revision.idempotencyKey &&
          e.code === "REVISION_FINALIZATION_INCOMPLETE"
        ) {
          // Stop after the completed pass, before a later claim can own the lease.
          finalization.unacknowledgedStop = f.stop();
        }
      });
    let originRequests = 0;
    let originBytes = 0;
    async function fetchFromPrivateOrigin() {
      const result = readGitDecision(
        await startup.evaluate({
          target: {
            scheme: "https",
            host: "github.com",
            port: 443,
            method: "POST",
            path: "/fixture/repository.git/git-upload-pack",
          },
          headers: [{ name: "content-type", value: "application/x-git-upload-pack-request" }],
          body: bodies.fetch,
        }),
      );
      if (result.decision !== 1) {
        return result;
      }
      originRequests++;
      originBytes += bodies.fetch.length;
      assert.ok(
        bodies.uploadPack(bodies.fetch).includes(Buffer.from("PACK")),
        "Git returned the requested pack",
      );
      return result;
    }
    async function useInitialGit() {
      await startup.readyGit();
      assert.deepEqual(await fetchFromPrivateOrigin(), { decision: 1 });
    }
    async function admitReplacement(actorId: string) {
      // Keep this intentionally unprotected queued candidate on the selected Compute;
      // its revoked actor must fail real IAM without preparing another Git runtime.
      return f.revision(agent, revision.revision + 1, {
        actorId,
        compute: revision.compute,
      });
    }
    async function activationAuditCount() {
      const rows = await readRows(
        f.observerPool,
        Type.Object({ total: Type.Integer({ minimum: 0 }) }),
        `SELECT count(*)::int AS total FROM occ.audit_events
         WHERE resource_id=$1 AND action='openclaw.agents.lifecycle.activate'`,
        [revision.id],
      );
      return required(rows[0], "missing activation audit count").total;
    }
    async function commitRemoval() {
      const queue = new f.PostgresWorkQueue(f.observerPool);
      const owner = {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
      };
      assert.equal(await queue.repositoryExpiryState(owner), undefined);
      assert.equal(
        await runtime.retireExpiredRepositoryAccess(
          revision,
          client,
          workspace,
          sandbox,
          continuity,
          AbortSignal.timeout(4000),
        ),
        "retire-runtime",
        "a finite deadline that has not elapsed is not withdrawal authority",
      );
      assert.deepEqual(world.detaches, []);
      await f.controller.updateAgent(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        repositoryBindings: [],
      });
      assert.equal(await queue.repositoryExpiryState(owner), "removal");
      assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
      withdrawalCommitted = true;
    }
    async function assertUnacknowledged() {
      assert.equal(activationCalls, 1, "cleanup never retries activation");
      assert.equal(await activationAuditCount(), 0);
      assert.notEqual((await f.deploymentStatus(agent, revision)).status, "succeeded");
      assert.deepEqual(retired, [], "unacknowledged activation cannot retire its predecessor");
      assert.deepEqual(
        await f.state.read((unit) => unit.workspaceSetups.find(namespaceId, agent.id)),
        pendingSetup,
      );
    }
    await start();
    if (unacknowledgedActivation) {
      const unacknowledged = await completion(
        events,
        "activation acknowledgment lost",
        (e) => e.event === "worker.completed" && e.workId === revision.idempotencyKey,
      );
      await required(
        finalization.unacknowledgedStop,
        "missing stop after unacknowledged activation",
      );
      assert.equal(unacknowledged.code, "REVISION_FINALIZATION_INCOMPLETE");
      assert.equal(unacknowledged.outcome, "pending");
      await assertUnacknowledged();
      events.length = 0;
      if (leaseExhaustion) {
        const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
        // Simulate two lost workers through real claims and queue recovery. Only
        // lease timestamps move; recovery owns the allowance, failure and audit.
        for (let lost = 0; lost < 2; lost++) {
          await makeWorkDue(f.observerPool, { key: revision.idempotencyKey, state: "queued" });
          const claim = required(await queue.claim(), "missing activation claim");
          assert.equal(claim.idempotencyKey, revision.idempotencyKey);
          assert.equal(claim.attemptCount, 1);
          assert.equal((await f.expireClaim(revision, claim.claimToken)).rowCount, 1);
          const recovered = await queue.recoverStale();
          assert.equal(recovered.recovered, 1);
          assert.equal(recovered.failedPermanent, lost);
          assert.ok(
            await queue.findWorkAttempt(revision.idempotencyKey, "ACTIVE_REVISION_RECOVERY"),
          );
        }
        const failed = required(
          await queue.findWork(revision.idempotencyKey),
          "missing expired activation",
        );
        assert.equal(failed.state, "failed_permanent");
        assert.equal(failed.reasonCode, "LEASE_EXPIRED");
        assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
        await assertUnacknowledged();
      }
    } else {
      await f.work(revision, "succeeded").catch(async (cause: unknown) => {
        const work = await readWorkResult(f, revision);
        throw Error("Git-enabled revision did not activate: " + work.reason_code, { cause });
      });
    }
    if (removalDuringFinalization) {
      assert.equal((await readWorkResult(f, revision)).reason_code, "REVISION_ACTIVATED");
      assert.equal((await f.deploymentStatus(agent, revision)).status, "succeeded");
      assert.equal(await activationAuditCount(), 1);
      assert.deepEqual(retired, [required(previous, "missing predecessor").id]);
      assert.equal(world.detaches.length, 0, "activation completes before Git withdrawal settles");
    }
    if (stopDuringFinalization) {
      const finalizationStop = required(finalization.stop, "missing Stop during finalization");
      const finalizationRemoval = required(
        finalization.removal,
        "missing removal during finalization",
      );
      await f.work(finalizationStop, "succeeded");
      // Advance only existing work. Terminal Git cleanup may legitimately stop the
      // exact runtime again; a newly scheduled routine observation must not do so.
      await waitFor("removal and terminal cleanup settle after Stop", async () => {
        await advanceCleanupRetries(f, revision);
        await f.advanceMaintenance(revision);
        const cleanup = await readRows(
          f.observerPool,
          workKeyAndState,
          `SELECT idempotency_key, state FROM occ.controller_work
           WHERE revision_id=$1 AND idempotency_key LIKE $2`,
          [revision.id, `agent_revision:${revision.id}:repository_cleanup:%`],
        );
        const routine = await readRows(
          f.observerPool,
          Type.Object({ state: workState }),
          `SELECT state FROM occ.controller_work
           WHERE revision_id=$1 AND idempotency_key LIKE $2`,
          [revision.id, `agent_revision:${revision.id}:maintenance:%`],
        );
        return cleanup.some((row) => row.idempotency_key === finalizationRemoval.idempotency_key) &&
          cleanup.every((row) => row.state === "succeeded") &&
          routine.every((row) => row.state === "succeeded")
          ? true
          : undefined;
      });
      await f.stop();
      const stoppedAgent = await currentAgent(f, agent);
      assert.equal(stoppedAgent.desiredRuntimeState, "stopped");
      assert.equal(stoppedAgent.activeRevisionId, undefined);
      assert.equal((await readWorkResult(f, revision)).reason_code, "REVISION_ACTIVATED");
      assert.equal((await f.deploymentStatus(agent, revision)).status, "succeeded");
      assert.equal(await activationAuditCount(), 1);
      assert.equal(activationCalls, 1);
      assert.deepEqual(retired, [required(previous, "missing predecessor").id]);
      // This controlled Compute does not remove a physical Sandbox. Prove the
      // durable Git fence through disposed admission, not its cached sender.
      assert.deepEqual(
        [originRequests, originBytes, peer.gh.issuesOfTokens.length, world.writes],
        [1, bodies.fetch.length, 1, 1],
      );
      assert.deepEqual(
        (await repositoryAttempts(f, revision)).map((attempt) => [
          attempt.phase,
          attempt.sessionId,
        ]),
        [["disposed", sessionId]],
      );
      assert.ok(
        stopWork.includes(finalizationStop.idempotencyKey),
        "authorized Stop reached Compute",
      );
      const routine = await readRows(
        f.observerPool,
        workKey,
        `SELECT idempotency_key FROM occ.controller_work
         WHERE revision_id=$1 AND idempotency_key LIKE $2`,
        [revision.id, `agent_revision:${revision.id}:maintenance:%`],
      );
      assert.deepEqual(
        routine,
        [],
        "activation acknowledgment must not enqueue routine maintenance after Stop admission",
      );
      assert.ok(
        stopWork.every(
          (key) => key === finalizationStop.idempotencyKey || key.includes(":repository_cleanup:"),
        ),
        "only authorized Stop or terminal repository cleanup may stop this runtime",
      );
      return;
    }
    const installation = await readEgressInstallation(f, revision.id);
    assert.deepEqual(installation.plan, revision.egressPlan);
    assert.equal(installation.sandboxId, world.id);
    if (!removalDuringFinalization && !unacknowledgedActivation) {
      await useInitialGit();
    }
    assert.equal(peer.gh.issuesOfTokens.length, 1);
    const remaining = deadlineWallMs - Date.now();
    assert.ok(remaining > 0, "use Git before its legitimately admitted deadline");
    if (removalDuringPreparation) {
      const original = required(
        (await repositoryAttempts(f, revision))[0],
        "missing initial repository attempt",
      );
      await f.stop();
      pauseBeforePreparation = true;
      const due = await f.advanceMaintenance(revision);
      assert.equal(due.rowCount, 1);
      const initialMaintenance = readMaintenanceResult(due.rows[0]);
      const maintenanceKey = initialMaintenance.idempotency_key;
      let supersededStop: WorkIdentity | undefined;
      let refusedDeployment: FixtureRevision | undefined;
      await start();
      try {
        await waitFor(
          "maintenance to enter Compute binding before repository preparation",
          async () => preparing || undefined,
        );
        if (removalDuringStop) {
          // Stop publishes intent before its work owns Compute. The in-flight
          // maintenance claim keeps that Stop queued while the editor removes Git.
          supersededStop = await f.requestStop(agent);
          assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "stopped");
        }
        await commitRemoval();
        // Readding the same desired binding cannot revive the withdrawn admitted revision.
        await f.controller.updateAgent(f.actor.id, {
          namespaceId,
          agentId: agent.id,
          configurationId: agent.configurationId,
          repositoryBindings: [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
        });
        if (removalDuringStop) {
          const replacementActor = `replacement-actor-${randomUUID()}`;
          await f.copyActorGrants(replacementActor);
          refusedDeployment = await admitReplacement(replacementActor);
          await removeAccessBindings(f, replacementActor);
          assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "running");
        }
        // Let the in-flight pass finish first; only this real cleanup work's due time moves.
        await deferWork(
          f.observerPool,
          {
            revisionId: revision.id,
            state: "queued",
            keyLike: "%:repository_cleanup:%",
          },
          "1 day",
        );
        events.length = 0;
      } finally {
        resumePreparation.resolve();
      }
      const completed = await completion(
        events,
        "in-flight maintenance to finish",
        (e) => e.event === "worker.completed" && e.workId === maintenanceKey,
      );
      await f.stop();
      assert.deepEqual(
        [completed.outcome, completed.code],
        ["pending", "REPOSITORY_CLEANUP_PENDING"],
      );
      assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
      assertRuntimeStillRunning(
        "withdrawal admission refusal must not retire the running revision",
      );
      const pending = await readRows(
        f.observerPool,
        workStateAndActor,
        "SELECT state, actor_id, attempt_count FROM occ.controller_work WHERE idempotency_key=$1",
        [maintenanceKey],
      );
      assert.deepEqual(
        pending,
        [
          {
            state: "queued",
            actor_id: initialMaintenance.actor_id,
            attempt_count: initialMaintenance.attempt_count,
          },
        ],
        "the same maintenance work retains its actor and retry budget",
      );
      const attempts = await repositoryAttempts(f, revision);
      assert.deepEqual(
        attempts.map((a) => a.admissionId),
        [original.admissionId],
        "committed finite withdrawal must fence session creation even after binding readdition",
      );
      assert.equal(prepareCalls, 1, "stale maintenance must not reprepare the withdrawn revision");
      if (removalDuringStop) {
        assert.ok(supersededStop && refusedDeployment, "missing Stop and replacement work");
        // Let the real queued Stop and refused successor settle without dispatching
        // the independently retained withdrawal obligation in this race assertion.
        await deferWork(
          f.observerPool,
          { revisionId: revision.id, state: "queued", keyLike: "%:maintenance:%" },
          "1 day",
        );
        await start();
        await f.work(supersededStop, "succeeded");
        await f.work(refusedDeployment, "failed_permanent");
        await f.stop();
        assert.equal(
          (await readWorkResult(f, refusedDeployment)).reason_code,
          "AUTHORIZATION_DENIED",
        );
        assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
        assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "running");
        assertRuntimeStillRunning("superseded Stop must not stop the retained runtime");
        assert.deepEqual(
          (await repositoryAttempts(f, revision)).map((a) => a.admissionId),
          [original.admissionId],
        );
        assert.equal(world.writes, 1, "readdition cannot install another credential");
      }
      return;
    }
    if (removal && !removalDuringFinalization && !unacknowledgedActivation) {
      await f.stop();
      // Only the committed OCC mutation may authorize predeadline subtraction. Stop the
      // worker first so its next pass cannot conceal a missing transactional handoff.
      let outstandingStop: WorkIdentity | undefined;
      let lostMaintenance: ClaimedWork | undefined;
      const recoveryQueue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
      if (leaseDuringStop) {
        // A real last-attempt maintenance claim is lost while Stop waits. Recovery
        // must transfer the committed removal without making Stop irrevocable.
        const due = await f.advanceMaintenance(revision);
        assert.equal(due.rowCount, 1);
        lostMaintenance = required(
          await recoveryQueue.claim(),
          "missing last-attempt maintenance claim",
        );
        assert.equal(
          lostMaintenance.idempotencyKey,
          readMaintenanceResult(due.rows[0]).idempotency_key,
        );
        assert.equal(lostMaintenance.attemptCount, 1);
      }
      if (cleanupDuringStop) {
        if (deniedStop) {
          const stopActor = `stop-actor-${randomUUID()}`;
          await f.copyActorGrants(stopActor);
          await f.controller.stopAgent(stopActor, namespaceId, agent.id);
          const [stop] = await readRows(
            f.observerPool,
            workKey,
            "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND actor_id=$3 AND agent_target='stopped'",
            [namespaceId, agent.id, stopActor],
          );
          assert.ok(stop);
          outstandingStop = { id: agent.id, idempotencyKey: stop.idempotency_key };
          // Revoke only this actor's operate permission after Stop admission.
          // The original deployment actor and independently required model stay authorized.
          const bindings = await readRows(
            f.observerPool,
            stopActorBinding,
            "SELECT b.*, r.permissions FROM occ.iam_access_bindings b JOIN occ.iam_roles r ON r.id=b.role_id WHERE b.identity_subject_id=$1",
            [stopActor],
          );
          for (const binding of bindings) {
            const role = `role-${randomUUID()}`;
            await f.observerPool.query(
              "INSERT INTO occ.iam_roles(id, permissions) VALUES($1,$2::jsonb)",
              [
                role,
                JSON.stringify(binding.permissions.filter(({ action }) => action !== "operate")),
              ],
            );
            await f.observerPool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [
              binding.id,
            ]);
            await f.observerPool.query(
              "INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) VALUES($1,$2,$3,$4,$5,$6)",
              [
                binding.id,
                binding.namespace_id,
                stopActor,
                role,
                binding.resource_kind,
                binding.resource_id,
              ],
            );
          }
          await start();
          await f.work(outstandingStop, "failed_permanent");
          await f.stop();
          assert.equal(
            (await readWorkResult(f, outstandingStop)).reason_code,
            "AUTHORIZATION_DENIED",
          );
          assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "stopped");
          assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
          assertRuntimeStillRunning();
          stoppedMaintenance = await readMaintenance();
          events.length = 0;
        } else {
          outstandingStop = await f.requestStop(agent);
          await deferWork(
            f.observerPool,
            { keyLike: outstandingStop.idempotencyKey, state: "queued" },
            "1 day",
          );
        }
      }
      await commitRemoval();
      if (leaseDuringStop) {
        assert.ok(lostMaintenance, "missing last-attempt maintenance claim");
        assert.equal(
          (await f.expireClaim(lostMaintenance, lostMaintenance.claimToken)).rowCount,
          1,
        );
        const recovered = await recoveryQueue.recoverStale();
        assert.equal(recovered.recovered, 1);
        assert.equal(recovered.failedPermanent, 1);
        assert.equal(
          (await recoveryQueue.findWork(lostMaintenance.idempotencyKey))?.reasonCode,
          "LEASE_EXPIRED",
        );
        assert.equal(
          await recoveryQueue.repositoryExpiryState({
            namespaceId,
            agentId: agent.id,
            revisionId: revision.id,
          }),
          "removal",
          "lease recovery must not promote pending Stop to terminal runtime retirement",
        );
      }
      if (cleanupDuringStop && !deniedStop) {
        assert.ok(outstandingStop, "missing admitted Stop");
        events.length = 0;
        await start();
        const firstCleanup = await completion(
          events,
          "removal cleanup before outstanding Stop",
          (e) =>
            e.event === "worker.completed" && e.workId === repositoryRemovalWorkKey(revision.id),
        );
        await f.stop();
        await deferWork(
          f.observerPool,
          { keyLike: repositoryRemovalWorkKey(revision.id), state: "queued" },
          "1 day",
        );
        assert.equal(world.version, 14, "pending Stop does not strand the committed Git effect");
        assert.deepEqual(world.detaches, []);
        assert.equal(
          firstCleanup.code,
          "REPOSITORY_CLEANUP_PENDING",
          "stopped intent alone cannot make runtime retirement irrevocable",
        );
        assertRuntimeStillRunning();
        assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
        assert.deepEqual(
          (await repositoryAttempts(f, revision)).map((attempt) => attempt.phase),
          ["disposed"],
        );
        // The controlled sender below observes revocation only through the provider
        // withdrawal call. Verify durable custody now and its signed denial after that call.
        if (stopWins) {
          await makeWorkDue(f.observerPool, {
            key: outstandingStop.idempotencyKey,
            state: "queued",
          });
          await start();
          await f.work(outstandingStop, "succeeded");
          assert.equal((await currentAgent(f, agent)).activeRevisionId, undefined);
          assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "stopped");
          assert.ok(stopped.includes(revision.id), "the authorized Stop still owns retirement");
          assert.equal(world.writes, 1);
          return;
        }
        // A later deployment may supersede Stop without ever replacing this runtime.
        await f.controller.updateAgent(f.actor.id, {
          namespaceId,
          agentId: agent.id,
          configurationId: agent.configurationId,
          repositoryBindings: [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
        });
        const replacementActor = `replacement-actor-${randomUUID()}`;
        await f.copyActorGrants(replacementActor);
        const replacement = await admitReplacement(replacementActor);
        await removeAccessBindings(f, replacementActor);
        await makeWorkDue(f.observerPool, { key: outstandingStop.idempotencyKey, state: "queued" });
        events.length = 0;
        await start();
        await f.work(outstandingStop, "succeeded");
        await f.work(replacement, "failed_permanent");
        assert.equal((await readWorkResult(f, replacement)).reason_code, "AUTHORIZATION_DENIED");
        assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
        assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "running");
        assertRuntimeStillRunning();
      }

      if (revokeActor) {
        // A Git-only reduction cannot preserve execution after the original deployer's
        // real IAM grant is revoked, even though its removal obligation remains valid.
        await removeAccessBindings(f, f.actor.id);
      }
      if (!cleanupDuringStop || deniedStop) {
        await start();
      }
      if (revokeActor) {
        await waitFor("revoked deploy authority retires the finite removal owner", async () =>
          (await currentAgent(f, agent)).activeRevisionId === undefined ? true : undefined,
        );
        assert.deepEqual(stopped, [revision.id]);
        assert.deepEqual(world.detaches, [], "authority loss does not retain a reduced runtime");
        assert.equal(world.writes, 1, "no replacement Git credential was installed");
        assert.ok(Date.now() < deadlineWallMs, "authority loss precedes natural Git expiry");
        return;
      }
    } else if (!removal) {
      // Await the real grant deadline; move only queue due times. Neither the binding nor its
      // live session is removed by the test, and no expiry or cleanup work is inserted by it.
      await delay(remaining + 10);
    }
    const nextExpiry = async (code: string) => {
      const event = await completion(
        events,
        code,
        (e) =>
          e.event === "worker.completed" &&
          e.revisionId === revision.id &&
          (unacknowledgedActivation && !leaseExhaustion
            ? e.workId === revision.idempotencyKey
            : removal
              ? e.workId === repositoryRemovalWorkKey(revision.id)
              : typeof e.workId === "string" && e.workId.includes(":repository_cleanup:")),
      );
      assert.equal(event.code, code);
      if (code !== "REPOSITORY_RUNTIME_RETIREMENT_QUEUED") {
        assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
        assertRuntimeStillRunning();
      }
      events.length = 0;
    };
    const advanceWithdrawal = () =>
      unacknowledgedActivation && !leaseExhaustion
        ? makeWorkDue(f.observerPool, { key: revision.idempotencyKey, state: "queued" })
        : advanceCleanupRetries(f, revision);
    if (unacknowledgedActivation) {
      await advanceWithdrawal();
      await start();
    } else if (!removal) {
      assert.equal((await f.advanceMaintenance(revision)).rowCount, 1);
    }
    if (!cleanupDuringStop || deniedStop) {
      await nextExpiry("REPOSITORY_CLEANUP_PENDING");
    }
    assert.equal(world.version, 14);
    assert.deepEqual(world.detaches, [], "no detach at the stale resource version");
    const refused = await fetchFromPrivateOrigin();
    assert.deepEqual(refused, { decision: 2, reason_code: "access_withdrawn" });
    assert.deepEqual(
      [originRequests, originBytes, peer.gh.issuesOfTokens.length, world.writes],
      [1, bodies.fetch.length, 1, 1],
    );
    const attempts = await repositoryAttempts(f, revision);
    assert.deepEqual(
      attempts.map((a) => [a.phase, a.sessionId]),
      [["disposed", sessionId]],
    );
    const originalAdmission = required(
      attempts[0],
      "missing initial repository attempt",
    ).admissionId;
    assert.ok(originalAdmission);
    const assertOriginalSession = async () => {
      assert.deepEqual(
        (await repositoryAttempts(f, revision)).map(({ admissionId, sessionId, phase }) => [
          admissionId,
          sessionId,
          phase,
        ]),
        [[originalAdmission, sessionId, "disposed"]],
        "settlement never creates a second durable admission",
      );
      assert.equal(peer.gh.issuesOfTokens.length, 1, "settlement issues no replacement credential");
    };
    if (unacknowledgedActivation) {
      await assertUnacknowledged();
    }
    await advanceWithdrawal();
    await nextExpiry("REPOSITORY_CLEANUP_PENDING");
    assert.equal(
      world.detaches.length,
      1,
      "one conditional detach committed, but its reply was lost",
    );
    await f.stop();
    world.addRetainedEndpoint(newHost);
    await startup.replaceRuntime(); // fresh sender and authority, same PostgreSQL and Gateway
    runtime = startup.getRuntime();
    await advanceWithdrawal();
    await start();
    const coldRefusal = { decision: 2, reason_code: "online_authorization_denied" };
    if (newHost === "uploads.github.com") {
      await nextExpiry("REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
      if (platformProfile) {
        assert.deepEqual(
          world.profileReads,
          ["platform"],
          "read the effective profile, not its workspace namesake",
        );
      }
      await waitFor("retained GitHub endpoint retires the exact revision", async () =>
        (await currentAgent(f, agent)).activeRevisionId === undefined ? true : undefined,
      );
      assert.deepEqual(stopped, [revision.id]);
      assert.deepEqual(await fetchFromPrivateOrigin(), coldRefusal);
      assert.deepEqual(
        [originRequests, originBytes, peer.gh.issuesOfTokens.length],
        [1, bodies.fetch.length, 1],
      );
      assert.deepEqual([world.detaches.length, world.writes], [1, 1], "no replay or replacement");
      await assertOriginalSession();
      if (unacknowledgedActivation) {
        await assertUnacknowledged();
        assert.equal((await f.deploymentStatus(agent, revision)).status, "failed");
      }
      return;
    }
    await nextExpiry(deniedStop ? "REPOSITORY_CLEANUP_PENDING" : "REPOSITORY_ACCESS_WITHDRAWN");
    if (unacknowledgedActivation && !leaseExhaustion) {
      await assertUnacknowledgedCompletion();
      // The separate durable removal work must converge on the same maintenance chain.
      await advanceCleanupRetries(f, revision);
      await completion(
        events,
        "independent removal settles",
        (e) =>
          e.event === "worker.completed" &&
          e.revisionId === revision.id &&
          typeof e.workId === "string" &&
          e.workId.includes(":repository_cleanup:") &&
          e.code === "REPOSITORY_ACCESS_WITHDRAWN",
      );
      await assertUnacknowledgedCompletion();
    }
    async function assertUnacknowledgedCompletion() {
      await assertUnacknowledged();
      assert.equal((await readWorkResult(f, revision)).reason_code, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal((await f.deploymentStatus(agent, revision)).status, "failed");
    }
    if (removalDuringFinalization) {
      // The independently owned cleanup cannot rewrite deployment completion or emit
      // another activation after the acknowledged activation's original bookkeeping.
      assert.equal((await readWorkResult(f, revision)).reason_code, "REVISION_ACTIVATED");
      const deployment = await f.deploymentStatus(agent, revision);
      assert.equal(deployment.status, "succeeded");
      assert.equal(deployment.error, null);
      assert.equal(activationCalls, 1);
      assert.equal(await activationAuditCount(), 1);
      assert.deepEqual(
        retired,
        [required(previous, "missing predecessor").id],
        "cleanup must not repeat predecessor retirement",
      );
    }
    if (removal) {
      assert.ok(Date.now() < deadlineWallMs, "cold recovery completes before natural expiry");
    }
    assert.deepEqual(
      world.reports.slice(-2).map(([, state, receipt]) => [state, receipt]),
      [
        ["REVOKED", "OBSERVE"],
        ["READY", "OBSERVE"],
      ],
    );
    if (deniedStop) {
      assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "stopped");
      assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
      assert.deepEqual(stopped, [], "a denied Stop cannot authorize runtime retirement");
      assert.deepEqual(
        await readMaintenance(),
        stoppedMaintenance,
        "stopped cleanup neither runs nor schedules ordinary maintenance",
      );
      assert.deepEqual(await fetchFromPrivateOrigin(), coldRefusal);
      assert.equal(originRequests, 1);
      await assertOriginalSession();
      assert.deepEqual([world.detaches.length, world.writes], [1, 1]);
      const removalWork = await new f.PostgresWorkQueue(f.observerPool).findWork(
        repositoryRemovalWorkKey(revision.id),
      );
      assert.equal(
        removalWork?.state,
        "queued",
        "cleanup retains responsibility for stopped intent",
      );
      await f.stop();
      // No new Stop is issued. A later denied deployment restores running intent,
      // and the same cleanup must resume the original actor's one maintenance chain.
      const replacementActor = `replacement-actor-${randomUUID()}`;
      await f.copyActorGrants(replacementActor);
      const replacement = await admitReplacement(replacementActor);
      await removeAccessBindings(f, replacementActor);
      await start();
      await f.work(replacement, "failed_permanent");
      assert.equal((await readWorkResult(f, replacement)).reason_code, "AUTHORIZATION_DENIED");
      assert.equal((await currentAgent(f, agent)).desiredRuntimeState, "running");
      events.length = 0;
      await advanceWithdrawal();
      await nextExpiry("REPOSITORY_ACCESS_WITHDRAWN");
      assert.deepEqual(
        [world.detaches.length, world.writes],
        [1, 1],
        "settlement observes without redispatch",
      );
    }
    const observationsBeforeMaintenance = retainedObservations;
    const advanced = await f.advanceMaintenance(revision);
    assert.equal(advanced.rowCount, 1, "withdrawal has one maintenance successor");
    const next = readMaintenanceResult(advanced.rows[0]);
    assert.equal(next.actor_id, f.actor.id, "maintenance retains original deployment authority");
    const maintenance = { ...revision, idempotencyKey: next.idempotency_key };
    if (leaseExhaustion) {
      const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
      const completed = await waitFor(
        "maintenance after exhausted original reconciliation",
        async () => {
          const work = await queue.findWork(maintenance.idempotencyKey);
          return work?.state === "succeeded" || work?.state === "failed_permanent"
            ? work
            : undefined;
        },
      );
      assert.equal(
        completed.state,
        "succeeded",
        `maintenance rejected before retained observation: ${completed.reasonCode}`,
      );
      assert.equal(
        retainedObservations,
        observationsBeforeMaintenance + 1,
        "maintenance observes the retained runtime once",
      );
      await f.stop();
      assert.equal((await readWorkResult(f, revision)).reason_code, "LEASE_EXPIRED");
      await assertUnacknowledged();
      const successors = await f.advanceMaintenance(revision);
      assert.equal(successors.rowCount, 1, "one retained maintenance successor remains");
      assert.notEqual(
        readMaintenanceResult(successors.rows[0]).idempotency_key,
        maintenance.idempotencyKey,
      );
    } else {
      await f.work(maintenance, "succeeded");
    }
    assert.equal((await readWorkResult(f, maintenance)).reason_code, "REPOSITORY_ACCESS_WITHDRAWN");
    assert.equal((await currentAgent(f, agent)).activeRevisionId, revision.id);
    assertRuntimeStillRunning();
    // The fresh sender remains fenced, and the cold worker cannot supply a replacement.
    assert.deepEqual(await fetchFromPrivateOrigin(), coldRefusal);
    assert.equal(originBytes, bodies.fetch.length, "neither late fetch reached the Git origin");
    assert.equal(peer.gh.issuesOfTokens.length, 1);
    await assertOriginalSession();
    assert.deepEqual(
      [world.detaches.length, world.writes],
      [1, 1],
      "no replay or replacement Git material",
    );
    if (leaseExhaustion) {
      return;
    }
    // Losing the evidence for safe retention on the next ordinary maintenance retires this revision.
    if (platformProfile) {
      assert.deepEqual(
        world.profileReads,
        ["platform", "platform"],
        "rechecked after confirming withdrawal",
      );
      world.profileReads.length = 0;
      world.denyPlatformProfile = true;
    } else {
      world.modelFailed = true;
    }
    await f.advanceMaintenance(revision);
    await waitFor("loss of verified provider access retires the revision", async () =>
      (await currentAgent(f, agent)).activeRevisionId === undefined ? true : undefined,
    );
    assert.deepEqual(stopped, [revision.id]);
    if (platformProfile) {
      assert.deepEqual(
        world.profileReads,
        ["platform"],
        "permission denied; never try the workspace namesake",
      );
      assert.equal((await fetchFromPrivateOrigin()).decision, 2);
      assert.deepEqual([originRequests, world.detaches.length, world.writes], [1, 1, 1]);
      assert.equal(peer.gh.issuesOfTokens.length, 1);
      await assertOriginalSession();
    }
  };
}
