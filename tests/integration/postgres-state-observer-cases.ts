import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

import { databaseUrl } from "../helpers/postgres-platform-state.ts";
import { ensureInstallation } from "../helpers/postgres-state-installation.ts";

export async function acceptCanonicalObserverTimestamp(context: TestContext): Promise<void> {
  const [{ Pool }, { PostgresPlatformState, PostgresWorkQueue }] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/index.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  await ensureInstallation(state, "observer-canonical-timestamp");

  const createdAt = new Date().toISOString();
  const namespaceId = "ns_" + randomUUID();
  const configurationId = "cfg_" + randomUUID();
  const agentId = "agt_" + randomUUID();
  const revisionId = "rev_" + randomUUID();
  const actorId = "principal-observer-" + randomUUID();
  const workId = "observer:" + randomUUID();
  const requestId = "request-" + randomUUID();

  await state.transact(async (unit) => {
    await unit.namespaces.createNamespace({
      id: namespaceId,
      name: "observer-timestamp-" + randomUUID(),
      status: "ready",
      createdAt,
    });
    await unit.configurations.createConfiguration({
      id: configurationId,
      namespaceId,
      kind: "agent",
      generation: 1,
      createdAt,
    });
    const agent = await unit.agents.createAgent({
      id: agentId,
      namespaceId,
      name: "Observer timestamp",
      configurationId,
      backendId: null,
      harnessAuth: { method: "runtime" },
      executionMode: "embedded",
      servicePrincipalId: "service-agent-" + agentId,
      desiredRuntimeState: "stopped",
      status: "active",
      createdAt,
    });
    await unit.revisions.createRevision({
      id: revisionId,
      namespaceId,
      agentId,
      revision: 1,
      backendId: null,
      gatewayManagedMode: agent.gatewayManagedMode,
      configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: { agents: { defaults: { model: "test/model" } } },
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      compute: { id: "compute-observer-timestamp", implementation: "deterministic-test" },
      executionAdmission: { version: 2, mode: "unprotected" },
      harnessAuth: { method: "runtime" },
      servicePrincipalId: "service-agent-" + agentId,
      createdAt,
    });
  });

  const qualification = {
    qualificationId: "qualification-v1",
    backendVersion: "docker-observer-container-v1",
    imageQualificationId: "observer-image-v1",
    evidenceContractId: "observer-evidence-v1",
    securityProfileId: "observer-security-v1",
    maximumDurationMs: 60_000,
    maximumCapturedRecords: 100,
    maximumEncodedOutputBytes: 100_000,
    maximumCancellationGraceMs: 5_000,
  };
  const digest = "sha256:" + "a".repeat(64);
  const createInput = {
    workId,
    namespaceId,
    agentId,
    revisionId,
    actorId,
    requestId,
    requestFingerprint: "b".repeat(64),
    targetRole: "agent" as const,
    plan: {
      backendVersion: qualification.backendVersion,
      image: {
        reference: "observer.test/runtime@" + digest,
        digest,
        qualificationId: qualification.imageQualificationId,
      },
      observationScope: {
        kind: "dns" as const,
        interfaceName: "eth0",
        filterIdentity: "dns-filter-v1",
      },
      limits: {
        maximumDurationMs: 60_000,
        maximumCapturedRecords: 100,
        maximumEncodedOutputBytes: 100_000,
      },
      cancellation: { kind: "claim_abort" as const, gracePeriodMs: 5_000 },
      evidenceDestination: {
        contractId: qualification.evidenceContractId,
        destinationId: "observer-evidence-destination-v1",
      },
      cleanupPolicy: "observer_first" as const,
      securityProfile: {
        profileId: qualification.securityProfileId,
        capabilities: [] as const,
        privileged: false as const,
      },
    },
  };
  const controllerQueue = new PostgresWorkQueue(pool, {
    workKind: "controller",
    maxAttempts: 1,
    random: () => 0,
  });
  const controllerPendingBefore = await controllerQueue.pending();
  const controllerWaitingBefore = await controllerQueue.claimableWorkWaiting();

  const created = await state.transact((unit) => unit.observer.create(createInput, qualification));
  assert.equal(created.replayed, false);
  assert.equal(created.record.completedPhase, "admitted");

  const replayWorkId = "observer:" + randomUUID();
  const replayed = await state.transact((unit) =>
    unit.observer.create({ ...createInput, workId: replayWorkId }, qualification),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.record.workId, workId);
  assert.deepEqual(replayed.record, created.record);
  const [byRequest, byWorkId] = await state.read((unit) =>
    Promise.all([
      unit.observer.findByRequest(namespaceId, actorId, requestId),
      unit.observer.findByWorkId(workId),
    ]),
  );
  assert.deepEqual(byRequest, created.record);
  assert.deepEqual(byWorkId, created.record);

  const conflictingWorkId = "observer:" + randomUUID();
  await assert.rejects(
    state.transact((unit) =>
      unit.observer.create(
        {
          ...createInput,
          workId: conflictingWorkId,
          requestFingerprint: "c".repeat(64),
        },
        qualification,
      ),
    ),
    { name: "ResourceConflictError" },
  );
  const persistedReplayState = await pool.query(
    "SELECT (SELECT count(*)::integer FROM occ.observer_invocations WHERE namespace_id = $1 AND actor_id = $2 AND request_id = $3) AS invocations, (SELECT count(*)::integer FROM occ.controller_work WHERE work_kind = $4 AND namespace_id = $1 AND agent_id = $5 AND revision_id = $6 AND actor_id = $2) AS work, (SELECT count(*)::integer FROM occ.controller_work WHERE idempotency_key = ANY($7::text[])) AS candidate_work",
    [
      namespaceId,
      actorId,
      requestId,
      "observer",
      agentId,
      revisionId,
      [replayWorkId, conflictingWorkId],
    ],
  );
  assert.deepEqual(persistedReplayState.rows, [{ invocations: 1, work: 1, candidate_work: 0 }]);

  assert.equal(await controllerQueue.pending(), controllerPendingBefore);
  assert.equal(await controllerQueue.claimableWorkWaiting(), controllerWaitingBefore);

  const staleClaimToken = randomUUID();
  const madeStale = await pool.query(
    "UPDATE occ.controller_work SET state = $2, attempt_count = 1, claim_token = $3::uuid, lease_expires_at = clock_timestamp() - interval '1 second', updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $4 AND state = $5",
    [workId, "claimed", staleClaimToken, "observer", "queued"],
  );
  assert.equal(madeStale.rowCount, 1, "test must create one expired observer claim");
  await controllerQueue.recoverStale();
  const untouchedObserverClaim = await pool.query(
    "SELECT state, attempt_count, claim_token FROM occ.controller_work WHERE idempotency_key = $1",
    [workId],
  );
  assert.deepEqual(untouchedObserverClaim.rows, [
    { state: "claimed", attempt_count: 1, claim_token: staleClaimToken },
  ]);
  const restoredObserverWork = await pool.query(
    "UPDATE occ.controller_work SET state = $2, attempt_count = 0, claim_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $3 AND state = $4 AND claim_token = $5::uuid",
    [workId, "queued", "observer", "claimed", staleClaimToken],
  );
  assert.equal(restoredObserverWork.rowCount, 1, "test must restore the exact observer work item");

  const claimToken = randomUUID();
  const claimed = await pool.query(
    "UPDATE occ.controller_work SET state = $2, attempt_count = attempt_count + 1, claim_token = $3::uuid, lease_expires_at = clock_timestamp() + $4::interval, updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $5 AND state = $6 RETURNING idempotency_key",
    [workId, "claimed", claimToken, "10 minutes", "observer", "queued"],
  );
  assert.equal(claimed.rowCount, 1, "test must claim the exact observer work item");
  const claim = { idempotencyKey: workId, claimToken };
  const targetResolution = {
    targetContainerId: "c".repeat(64),
    namespaceNetworkId: "d".repeat(64),
    targetIdentity: "agent-runtime-v1",
    observedAt: "2026-11-15T17:00:00.000Z",
  };

  await assert.rejects(
    state.transact((unit) =>
      unit.observer.checkpoint(claim, {
        completedPhase: "target_resolved",
        status: "running",
        progress: {
          targetResolution: {
            ...targetResolution,
            observedAt: "2026-11-15T17:00:00Z",
          },
        },
      }),
    ),
    { name: "ScopeViolationError" },
  );
  const unchanged = await state.read((unit) => unit.observer.findByWorkId(workId));
  assert.ok(unchanged);
  assert.equal(unchanged.completedPhase, "admitted");
  assert.deepEqual(unchanged.progress, {});

  const checkpointed = await state.transact((unit) =>
    unit.observer.checkpoint(claim, {
      completedPhase: "target_resolved",
      status: "running",
      progress: { targetResolution },
    }),
  );
  assert.equal(checkpointed.completedPhase, "target_resolved");
  assert.equal(checkpointed.status, "running");
  assert.equal(checkpointed.progress.targetResolution?.observedAt, targetResolution.observedAt);

  const persisted = await pool.query(
    "SELECT progress #>> ARRAY[$2, $3] AS observed_at FROM occ.observer_invocations WHERE work_id = $1",
    [workId, "targetResolution", "observedAt"],
  );
  assert.deepEqual(persisted.rows, [{ observed_at: targetResolution.observedAt }]);
}
