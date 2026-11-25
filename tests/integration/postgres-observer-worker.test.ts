import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ObserverExecutor } from "../../packages/contracts/src/index.ts";
import {
  createBackendController,
  createBackendFixture,
  requiresPostgres,
} from "../helpers/postgres-backend-state.mjs";
import { claimIsolatedWork } from "../helpers/postgres-work-claim.ts";

type BackendFixture = Awaited<ReturnType<typeof createBackendFixture>>;

function createTargetResolutionExecutor(): ObserverExecutor {
  return {
    backendVersion: "docker-observer-container-v1",
    async resolveTarget(context) {
      return Object.freeze({
        targetContainerId: "c".repeat(64),
        namespaceNetworkId: "d".repeat(64),
        targetIdentity: context.targetRole + "-runtime-v1",
        observedAt: "2026-11-22T17:00:00.000Z",
      });
    },
    async createObserver() {
      return assert.fail("Target-resolution test must not create an observer.");
    },
    async reconcileObserverCreation() {
      return assert.fail("Target-resolution test must not reconcile observer creation.");
    },
    async awaitReadiness() {
      return assert.fail("Target-resolution test must not await observer readiness.");
    },
    async observe() {
      return assert.fail("Target-resolution test must not observe traffic.");
    },
    async cleanup() {
      return assert.fail("Target-resolution test must not perform observer cleanup.");
    },
  };
}

function createObserverCreationExecutor(reconciliation: "created" | "unresolved" = "created") {
  const calls: string[] = [];
  const executor: ObserverExecutor = {
    backendVersion: "docker-observer-container-v1",
    async resolveTarget(context) {
      calls.push("resolveTarget");
      return Object.freeze({
        targetContainerId: "c".repeat(64),
        namespaceNetworkId: "d".repeat(64),
        targetIdentity: context.targetRole + "-runtime-v1",
        observedAt: "2026-11-22T17:00:00.000Z",
      });
    },
    async createObserver() {
      calls.push("createObserver");
      return assert.fail("Observer creation must not be replayed after durable dispatch.");
    },
    async reconcileObserverCreation() {
      calls.push("reconcileObserverCreation");
      if (reconciliation === "unresolved") {
        return Object.freeze({ outcome: "unresolved" as const });
      }
      return Object.freeze({
        outcome: "created" as const,
        observer: Object.freeze({
          observerContainerId: "e".repeat(64),
          createdAt: "2026-11-22T17:00:01.000Z",
        }),
      });
    },
    async awaitReadiness(_context, target) {
      calls.push("awaitReadiness");
      return Object.freeze({
        targetContainerId: target.targetContainerId,
        interfaceName: "eth0",
        filterIdentity: "dns-filter-v1",
        readyAt: "2026-11-22T17:00:02.000Z",
      });
    },
    async observe() {
      calls.push("observe");
      return Object.freeze({
        startedAt: "2026-11-22T17:00:02.000Z",
        captureDeadlineAt: "2026-11-22T17:01:02.000Z",
        captureStoppedAt: "2026-11-22T17:00:03.000Z",
        terminalCompletedAt: "2026-11-22T17:00:04.000Z",
        startOutcome: "succeeded",
        stopOutcome: "succeeded",
        boundsReached: [],
        capturedRecordCount: 1,
        encodedOutputBytes: 100,
      });
    },
    async cleanup() {
      calls.push("cleanup");
      return Object.freeze({
        terminationRequestedAt: "2026-11-22T17:00:04.000Z",
        graceDeadline: "2026-11-22T17:00:09.000Z",
        forceRemovalOutcome: "not_required",
        absenceVerifiedAt: "2026-11-22T17:00:09.000Z",
        targetTeardownAuthorized: true,
      });
    },
  };
  return Object.freeze({ executor, calls });
}

async function admitObserverInvocation(
  fixture: BackendFixture,
  target: Readonly<{ namespaceId: string; agentId: string; revisionId: string }>,
) {
  const workId = "observer:" + randomUUID();
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
  const created = await fixture.state.transact((unit) =>
    unit.observer.create(
      {
        workId,
        namespaceId: target.namespaceId,
        agentId: target.agentId,
        revisionId: target.revisionId,
        actorId: fixture.actor.id,
        requestId: "request-" + randomUUID(),
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
  return workId;
}

async function createObserverTarget(fixture: BackendFixture) {
  const createdAt = new Date().toISOString();
  const namespaceId = "ns_" + randomUUID();
  const configurationId = "cfg_" + randomUUID();
  const agentId = "agt_" + randomUUID();
  const revisionId = "rev_" + randomUUID();

  await fixture.state.transact(async (unit) => {
    await unit.namespaces.createNamespace({
      id: namespaceId,
      name: "observer-worker-" + randomUUID(),
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
      name: "Observer worker target",
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
      compute: { id: "compute-observer-worker", implementation: "deterministic-test" },
      executionAdmission: { version: 2, mode: "unprotected" },
      harnessAuth: { method: "runtime" },
      servicePrincipalId: "service-agent-" + agentId,
      createdAt,
    });
  });

  const namespace = { id: namespaceId };
  fixture.track(namespace);
  return Object.freeze({ namespaceId, agentId, revisionId });
}

test(
  "PostgreSQL observer worker fixture persists an exact owned target revision",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const target = await createObserverTarget(fixture);
    const revision = await fixture.state.read((unit) =>
      unit.revisions.findRevision(target.namespaceId, target.agentId, target.revisionId),
    );
    assert.ok(revision);
    assert.equal(revision.id, target.revisionId);
    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker advances exactly one admitted invocation through target resolution",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const outcome = await controller.processObserverInvocation(claim, {
      executor: createTargetResolutionExecutor(),
    });
    assert.deepEqual(outcome, {
      outcome: "pending",
      code: "OBSERVER_TARGET_RESOLVED",
    });

    const resolved = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(resolved);
    assert.equal(resolved.completedPhase, "target_resolved");
    assert.equal(resolved.status, "running");
    assert.deepEqual(resolved.progress.targetResolution, {
      targetContainerId: "c".repeat(64),
      namespaceNetworkId: "d".repeat(64),
      targetIdentity: "agent-runtime-v1",
      observedAt: "2026-11-22T17:00:00.000Z",
    });
    assert.equal(resolved.progress.observer, undefined);
    assert.equal(resolved.progress.readiness, undefined);
    assert.equal(resolved.progress.terminal, undefined);
    assert.equal(resolved.progress.cleanup, undefined);

    await fixture.state.transact((unit) =>
      unit.observer.cancel(
        claim,
        {
          completedPhase: "cleanup",
          status: "cancelled",
          progress: {
            ...resolved.progress,
            observerAbsence: {
              reason: "observer_not_created",
              absenceVerifiedAt: new Date().toISOString(),
              targetTeardownAuthorized: true,
            },
          },
        },
        {
          code: "OBSERVER_TEST_SETTLED_AFTER_TARGET_RESOLUTION",
          message: "The inert target-resolution test created no observer.",
        },
      ),
    );

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker persists uncertain creation before any create effect and never replays it",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    const inert = createObserverCreationExecutor("unresolved");
    const resolved = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(resolved, { outcome: "pending", code: "OBSERVER_TARGET_RESOLVED" });
    const dispatched = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(dispatched, {
      outcome: "pending",
      code: "OBSERVER_CREATION_DISPATCH_RECORDED",
    });
    const persisted = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(persisted);
    assert.equal(persisted.completedPhase, "target_resolved");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.progress.observerCreateDispatch?.invocationId, workId);
    assert.match(persisted.progress.observerCreateDispatch?.dispatchedAt ?? "", /Z$/);
    assert.deepEqual(persisted.progress.retryResume, {
      failedPhase: "observer_created",
      resumeFrom: "observer_creation_reconciliation",
    });
    assert.equal(persisted.progress.observer, undefined);
    assert.deepEqual(inert.calls, ["resolveTarget"]);
    const reconciliation = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(reconciliation, {
      outcome: "pending",
      code: "OBSERVER_CREATION_RECONCILIATION_REQUIRED",
    });
    assert.deepEqual(inert.calls, ["resolveTarget", "reconcileObserverCreation"]);
    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker advances exactly one target-resolved invocation through observer creation",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    const resolvedOutcome = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(resolvedOutcome, {
      outcome: "pending",
      code: "OBSERVER_TARGET_RESOLVED",
    });

    const dispatchedOutcome = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(dispatchedOutcome, {
      outcome: "pending",
      code: "OBSERVER_CREATION_DISPATCH_RECORDED",
    });

    const createdOutcome = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(createdOutcome, {
      outcome: "pending",
      code: "OBSERVER_CREATED",
    });

    const created = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(created);
    assert.equal(created.completedPhase, "observer_created");
    assert.equal(created.status, "running");
    assert.deepEqual(created.progress.observer, {
      observerContainerId: "e".repeat(64),
      createdAt: "2026-11-22T17:00:01.000Z",
    });
    assert.equal(created.progress.readiness, undefined);
    assert.equal(created.progress.terminal, undefined);
    assert.equal(created.progress.cleanup, undefined);
    assert.deepEqual(inert.calls, ["resolveTarget", "reconcileObserverCreation"]);

    for (const expectedCode of ["OBSERVER_READY", "OBSERVER_TERMINAL"]) {
      const outcome = await controller.processObserverInvocation(claim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const completed = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });

    const settled = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(settled);
    assert.equal(settled.completedPhase, "cleanup");
    assert.equal(settled.status, "succeeded");
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker advances exactly one observer-created invocation through readiness",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    for (const expectedCode of [
      "OBSERVER_TARGET_RESOLVED",
      "OBSERVER_CREATION_DISPATCH_RECORDED",
      "OBSERVER_CREATED",
      "OBSERVER_READY",
    ]) {
      const outcome = await controller.processObserverInvocation(claim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const ready = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(ready);
    assert.equal(ready.completedPhase, "ready");
    assert.equal(ready.status, "running");
    assert.deepEqual(ready.progress.readiness, {
      targetContainerId: "c".repeat(64),
      interfaceName: "eth0",
      filterIdentity: "dns-filter-v1",
      readyAt: "2026-11-22T17:00:02.000Z",
    });
    assert.equal(ready.progress.terminal, undefined);
    assert.equal(ready.progress.cleanup, undefined);
    assert.deepEqual(inert.calls, ["resolveTarget", "reconcileObserverCreation", "awaitReadiness"]);

    const terminalOutcome = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(terminalOutcome, {
      outcome: "pending",
      code: "OBSERVER_TERMINAL",
    });

    const completed = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });

    const settled = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(settled);
    assert.equal(settled.completedPhase, "cleanup");
    assert.equal(settled.status, "succeeded");
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker advances exactly one ready invocation through terminal observation",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    for (const expectedCode of [
      "OBSERVER_TARGET_RESOLVED",
      "OBSERVER_CREATION_DISPATCH_RECORDED",

      "OBSERVER_CREATED",
      "OBSERVER_READY",
      "OBSERVER_TERMINAL",
    ]) {
      const outcome = await controller.processObserverInvocation(claim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const terminal = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(terminal);
    assert.equal(terminal.completedPhase, "terminal");
    assert.equal(terminal.status, "running");
    assert.deepEqual(terminal.progress.terminal, {
      startedAt: "2026-11-22T17:00:02.000Z",
      captureDeadlineAt: "2026-11-22T17:01:02.000Z",
      captureStoppedAt: "2026-11-22T17:00:03.000Z",
      terminalCompletedAt: "2026-11-22T17:00:04.000Z",
      startOutcome: "succeeded",
      stopOutcome: "succeeded",
      boundsReached: [],
      capturedRecordCount: 1,
      encodedOutputBytes: 100,
    });
    assert.equal(terminal.progress.cleanup, undefined);
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
    ]);

    const completed = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });

    const settled = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(settled);
    assert.equal(settled.completedPhase, "cleanup");
    assert.equal(settled.status, "succeeded");
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer worker settles exactly one terminal invocation through ordinary cleanup",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    for (const expectedCode of [
      "OBSERVER_TARGET_RESOLVED",
      "OBSERVER_CREATION_DISPATCH_RECORDED",

      "OBSERVER_CREATED",
      "OBSERVER_READY",
      "OBSERVER_TERMINAL",
    ]) {
      const outcome = await controller.processObserverInvocation(claim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const terminal = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(terminal);
    assert.equal(terminal.completedPhase, "terminal");
    assert.equal(terminal.status, "running");
    assert.equal(terminal.progress.cleanup, undefined);
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
    ]);

    const completed = await controller.processObserverInvocation(claim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });

    const cleaned = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(cleaned);
    assert.equal(cleaned.completedPhase, "cleanup");
    assert.equal(cleaned.status, "succeeded");
    assert.deepEqual(cleaned.progress.cleanup, {
      terminationRequestedAt: "2026-11-22T17:00:04.000Z",
      graceDeadline: "2026-11-22T17:00:09.000Z",
      forceRemovalOutcome: "not_required",
      absenceVerifiedAt: "2026-11-22T17:00:09.000Z",
      targetTeardownAuthorized: true,
    });
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer invocation cancels before observer creation with verified absence only",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const cancelled = await fixture.state.transact((unit) =>
      unit.observer.cancel(
        claim,
        {
          completedPhase: "cleanup",
          status: "cancelled",
          progress: {
            observerAbsence: {
              reason: "observer_not_created",
              absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
              targetTeardownAuthorized: true,
            },
          },
        },
        {
          code: "OBSERVER_CANCELLED_BEFORE_CREATION",
          message: "Observer was not created.",
        },
      ),
    );

    assert.equal(cancelled.completedPhase, "cleanup");
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.progress.observerAbsence, {
      reason: "observer_not_created",
      absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
      targetTeardownAuthorized: true,
    });
    assert.equal(cancelled.progress.targetResolution, undefined);
    assert.equal(cancelled.progress.observer, undefined);
    assert.equal(cancelled.progress.readiness, undefined);
    assert.equal(cancelled.progress.terminal, undefined);
    assert.equal(cancelled.progress.cleanup, undefined);
    assert.equal(cancelled.progress.retryResume, undefined);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer invocation fails permanently before observer creation with verified absence only",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const failed = await fixture.state.transact((unit) =>
      unit.observer.recordFailure(
        claim,
        {
          completedPhase: "cleanup",
          status: "failed",
          progress: {
            observerAbsence: {
              reason: "observer_not_created",
              absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
              targetTeardownAuthorized: true,
            },
          },
        },
        {
          disposition: "permanent",
          code: "OBSERVER_FAILED_BEFORE_CREATION",
          message: "Observer creation did not occur.",
        },
      ),
    );

    assert.equal(failed.completedPhase, "cleanup");
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.observerAbsence, {
      reason: "observer_not_created",
      absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
      targetTeardownAuthorized: true,
    });
    assert.equal(failed.progress.targetResolution, undefined);
    assert.equal(failed.progress.observer, undefined);
    assert.equal(failed.progress.readiness, undefined);
    assert.equal(failed.progress.terminal, undefined);
    assert.equal(failed.progress.cleanup, undefined);
    assert.equal(failed.progress.retryResume, undefined);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer invocation retries from verified pre-creation absence to target resolution",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const retried = await fixture.state.transact((unit) =>
      unit.observer.recordFailure(
        claim,
        {
          completedPhase: "cleanup",
          status: "running",
          progress: {
            observerAbsence: {
              reason: "observer_not_created",
              absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
              targetTeardownAuthorized: true,
            },
            retryResume: {
              failedPhase: "admitted",
              resumeFrom: "target_resolution",
            },
          },
        },
        {
          disposition: "retry",
          code: "OBSERVER_RETRY_BEFORE_CREATION",
          message: "Retry observer execution after verified absence.",
        },
      ),
    );

    assert.equal(retried.completedPhase, "cleanup");
    assert.equal(retried.status, "running");
    assert.deepEqual(retried.progress.observerAbsence, {
      reason: "observer_not_created",
      absenceVerifiedAt: "2026-11-22T17:00:00.000Z",
      targetTeardownAuthorized: true,
    });
    assert.deepEqual(retried.progress.retryResume, {
      failedPhase: "admitted",
      resumeFrom: "target_resolution",
    });
    assert.equal(retried.progress.targetResolution, undefined);
    assert.equal(retried.progress.observer, undefined);
    assert.equal(retried.progress.readiness, undefined);
    assert.equal(retried.progress.terminal, undefined);
    assert.equal(retried.progress.cleanup, undefined);

    await fixture.pool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp(), updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $2 AND state = $3",
      [workId, "observer", "queued"],
    );

    const resumedClaim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(resumedClaim, "the retryable observer invocation must return to the queue");
    assert.equal(resumedClaim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    const resumed = await controller.processObserverInvocation(resumedClaim, {
      executor: inert.executor,
    });
    assert.deepEqual(resumed, {
      outcome: "pending",
      code: "OBSERVER_TARGET_RESOLVED",
    });

    const reset = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(reset);
    assert.equal(reset.completedPhase, "target_resolved");
    assert.equal(reset.status, "running");
    assert.deepEqual(reset.progress, {
      targetResolution: {
        targetContainerId: "c".repeat(64),
        namespaceNetworkId: "d".repeat(64),
        targetIdentity: "agent-runtime-v1",
        observedAt: "2026-11-22T17:00:00.000Z",
      },
    });
    assert.deepEqual(inert.calls, ["resolveTarget"]);

    for (const expectedCode of [
      "OBSERVER_CREATION_DISPATCH_RECORDED",
      "OBSERVER_CREATED",
      "OBSERVER_READY",
      "OBSERVER_TERMINAL",
    ]) {
      const outcome = await controller.processObserverInvocation(resumedClaim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const completed = await controller.processObserverInvocation(resumedClaim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);

test(
  "PostgreSQL observer invocation defers failed cleanup and resumes cleanup only",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const inert = createObserverCreationExecutor();
    for (const expectedCode of [
      "OBSERVER_TARGET_RESOLVED",
      "OBSERVER_CREATION_DISPATCH_RECORDED",

      "OBSERVER_CREATED",
      "OBSERVER_READY",
      "OBSERVER_TERMINAL",
    ]) {
      const outcome = await controller.processObserverInvocation(claim, {
        executor: inert.executor,
      });
      assert.deepEqual(outcome, { outcome: "pending", code: expectedCode });
    }

    const terminal = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(terminal);
    assert.equal(terminal.completedPhase, "terminal");
    assert.equal(terminal.status, "running");
    assert.equal(terminal.progress.cleanup, undefined);

    const deferred = await fixture.state.transact((unit) =>
      unit.observer.recordFailure(
        claim,
        {
          completedPhase: "terminal",
          status: "running",
          progress: {
            ...terminal.progress,
            retryResume: {
              failedPhase: "cleanup",
              resumeFrom: "cleanup",
            },
          },
        },
        {
          disposition: "defer",
          code: "OBSERVER_CLEANUP_DEFERRED",
          message: "Observer cleanup remains pending.",
          delayMs: 1,
        },
      ),
    );

    assert.equal(deferred.completedPhase, "terminal");
    assert.equal(deferred.status, "running");
    assert.deepEqual(deferred.progress.retryResume, {
      failedPhase: "cleanup",
      resumeFrom: "cleanup",
    });
    assert.equal(deferred.progress.cleanup, undefined);
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
    ]);

    await fixture.pool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp(), updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $2 AND state = $3",
      [workId, "observer", "queued"],
    );

    const resumedClaim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(resumedClaim, "the deferred observer cleanup must return to the queue");
    assert.equal(resumedClaim.idempotencyKey, workId);

    const completed = await controller.processObserverInvocation(resumedClaim, {
      executor: inert.executor,
    });
    assert.deepEqual(completed, { outcome: "succeeded" });

    const cleaned = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));
    assert.ok(cleaned);
    assert.equal(cleaned.completedPhase, "cleanup");
    assert.equal(cleaned.status, "succeeded");
    assert.deepEqual(inert.calls, [
      "resolveTarget",
      "reconcileObserverCreation",
      "awaitReadiness",
      "observe",
      "cleanup",
    ]);

    await fixture.cleanup({ id: target.namespaceId });
  },
);
test(
  "PostgreSQL observer worker rejects an expired claim before any executor effect",
  requiresPostgres,
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, {
      nativeWorkerSupport: "custom-image",
    });
    const target = await createObserverTarget(fixture);
    const workId = await admitObserverInvocation(fixture, target);
    const claim = await claimIsolatedWork(fixture.pool, { workId });

    assert.ok(claim, "the admitted observer invocation must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);

    const expired = await fixture.pool.query(
      "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second', updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $2 AND state = $3 AND claim_token = $4::uuid",
      [workId, "observer", "claimed", claim.claimToken],
    );
    assert.equal(expired.rowCount, 1, "test must expire exactly its observer claim");

    const calls: string[] = [];
    const executor: ObserverExecutor = {
      backendVersion: "docker-observer-container-v1",

      async resolveTarget() {
        calls.push("resolveTarget");
        return assert.fail("expired observer claim must not resolve a target");
      },

      async createObserver() {
        calls.push("createObserver");
        return assert.fail("expired observer claim must not create an observer");
      },
      async reconcileObserverCreation() {
        calls.push("reconcileObserverCreation");
        return assert.fail("expired observer claim must not reconcile observer creation");
      },
      async awaitReadiness() {
        calls.push("awaitReadiness");
        return assert.fail("expired observer claim must not await readiness");
      },

      async observe() {
        calls.push("observe");
        return assert.fail("expired observer claim must not observe traffic");
      },

      async cleanup() {
        calls.push("cleanup");
        return assert.fail("expired observer claim must not perform cleanup");
      },
    };

    await assert.rejects(
      controller.processObserverInvocation(claim, { executor }),
      /exact persisted controller work/,
    );

    assert.deepEqual(calls, []);

    const unchanged = await fixture.state.read((unit) => unit.observer.findByWorkId(workId));

    assert.ok(unchanged);
    assert.equal(unchanged.completedPhase, "admitted");
    assert.equal(unchanged.status, "queued");
    assert.deepEqual(unchanged.progress, {});

    const restored = await fixture.pool.query(
      "UPDATE occ.controller_work SET state = $2, claim_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE idempotency_key = $1 AND work_kind = $3 AND state = $4 AND claim_token = $5::uuid",
      [workId, "queued", "observer", "claimed", claim.claimToken],
    );

    assert.equal(restored.rowCount, 1, "test must restore exactly its observer work item");

    await fixture.cleanup({ id: target.namespaceId });
  },
);
