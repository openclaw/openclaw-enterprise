import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

import { databaseUrl } from "../helpers/postgres-platform-state.ts";
import { ensureInstallation } from "../helpers/postgres-state-installation.ts";

export async function acceptCanonicalObserverTimestamp(context: TestContext): Promise<void> {
  const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
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
  const created = await state.transact((unit) =>
    unit.observer.create(
      {
        workId,
        namespaceId,
        agentId,
        revisionId,
        actorId,
        requestId,
        requestFingerprint: "b".repeat(64),
        targetRole: "agent",
        plan: {
          backendVersion: qualification.backendVersion,
          image: {
            reference: "observer.test/runtime@" + digest,
            digest,
            qualificationId: qualification.imageQualificationId,
          },
          observationScope: {
            kind: "dns",
            interfaceName: "eth0",
            filterIdentity: "dns-filter-v1",
          },
          limits: {
            maximumDurationMs: 60_000,
            maximumCapturedRecords: 100,
            maximumEncodedOutputBytes: 100_000,
          },
          cancellation: { kind: "claim_abort", gracePeriodMs: 5_000 },
          evidenceDestination: {
            contractId: qualification.evidenceContractId,
            destinationId: "observer-evidence-destination-v1",
          },
          cleanupPolicy: "observer_first",
          securityProfile: {
            profileId: qualification.securityProfileId,
            capabilities: [],
            privileged: false,
          },
        },
      },
      qualification,
    ),
  );
  assert.equal(created.replayed, false);
  assert.equal(created.record.completedPhase, "admitted");

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
