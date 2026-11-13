import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/access/client/config.ts";
import { RepositoryReceiptStore } from "../../apps/controller/src/backends/repository-credentials/receipt-store.ts";
import {
  advanceCleanupRetries,
  advanceRevisionQueue,
  completedPasses,
  completion,
  deferWork,
  expireStoppedClaims,
  expireWorkLease,
  makeQueuedWorkDue,
  makeWorkDue,
  nextMaintenancePass,
  settleRevisionMaintenance,
  waitForRevisionPass,
  waitForWorkPass,
  waitForWorkStateDue,
} from "./postgres-worker-revision-queue.ts";

// Helpers shared by the PostgreSQL worker integration tests.

export {
  advanceCleanupRetries,
  advanceRevisionQueue,
  completedPasses,
  completion,
  deferWork,
  expireStoppedClaims,
  expireWorkLease,
  makeQueuedWorkDue,
  makeWorkDue,
  nextMaintenancePass,
  settleRevisionMaintenance,
  waitForRevisionPass,
  waitForWorkPass,
  waitForWorkStateDue,
};

// A `transformDrivers` for fixture.start whose IAM Driver throws a plain Error while
// `unavailable()` is true, as an IAM outage does. The worker retries that pass.
export function withUnavailableIAM(unavailable) {
  return (drivers) => {
    const createIAMDriver = drivers.createIAMDriver;
    return {
      ...drivers,
      createIAMDriver(state) {
        const iam = createIAMDriver(state);
        return {
          id: iam.id,
          implementation: iam.implementation,
          capability: iam.capability,
          lookupIdentity: iam.lookupIdentity.bind(iam),
          async authorize(request) {
            if (unavailable()) {
              throw new Error("IAM is temporarily unavailable");
            }
            return iam.authorize(request);
          },
        };
      },
    };
  };
}

// This boundary Driver supplies synthetic sessions backed by the actual receipt
// owner. The real worker, IAM, State, and PostgreSQL queue own the lifecycle
// decisions; these cases do not qualify the concrete credential service or Compute.
export function repositoryBoundary({
  count = 1,
  backendId = "repository-provider",
  deadlineWallMs = Date.now() + 120_000,
} = {}) {
  const bindings = Array.from({ length: count }, (_, index) => ({
    repositoryRef: `repository-${index}-${randomUUID()}`,
    profile: "read",
    backendId,
    grant: {
      providerInstanceId: "repository-provider-instance",
      repositoryId: `repository-${index}`,
      grantId: `grant-${index}`,
    },
  }));
  const admissions = new Map();
  const sessions = new Map();
  const ownership = new Map();
  const calls = [];
  const generation = randomUUID();
  let receipts;
  const dispose = async (sessionId) => {
    const session = sessions.get(sessionId);
    const owned = ownership.get(sessionId);
    if (session === undefined || owned === undefined) {
      return undefined;
    }
    if (session.state === "DISPOSED") {
      return session;
    }
    const disposed = { ...session, state: "DISPOSED" };
    await receipts.dispose(owned.admissionId, owned.input, generation, {
      ...disposed,
      activeUses: 0,
      cleanup: {
        active: 0,
        pending: 0,
        uncertain: 0,
        auxiliaryPending: false,
        revoked: 0,
        expired: 0,
      },
    });
    sessions.set(sessionId, disposed);
    admissions.set(owned.admissionId, disposed);
    return disposed;
  };
  const driver = {
    id: "repository-worker-boundary",
    implementation: "repository-worker-boundary",
    capability: "repo",
    maintenanceIntervalMs: 3_600_000,
    durableBrokerReceipts: true,
    bindReceiptState(state) {
      receipts = new RepositoryReceiptStore(state, {
        driverId: driver.id,
        implementation: driver.implementation,
        backendId,
      });
    },
    async checkAdmissionReady() {
      assert.ok(receipts, "repository boundary requires its fixture's receipt state");
    },
    async listOptions() {
      return { options: [] };
    },
    resolve() {
      return { bindings, sessionDurationSeconds: 60 };
    },
    async open(input, signal) {
      calls.push({ operation: input.recoverOnly ? "recover" : "open", input, signal });
      const existing = admissions.get(input.admissionId);
      if (existing !== undefined) {
        return { kind: "recovered", status: existing };
      }
      const bound = {
        namespaceId: input.namespaceId,
        repositoryRef: input.binding.repositoryRef,
        profile: input.binding.profile,
        expectedBinding: input.binding.grant,
        durationSeconds: input.durationSeconds,
        deadlineWallMs: input.deadlineWallMs,
        preparedOnly: input.preparedOnly,
      };
      const admission = await receipts.admission(
        input.admissionId,
        bound,
        generation,
        input.recoverOnly === true,
      );
      if (admission.kind === "missing") {
        return { kind: "missing" };
      }
      assert.equal(admission.kind, "reserved");
      const session = {
        sessionId: `session_${randomUUID()}`,
        state: "OPEN",
        deadlineWallMs: Math.min(Date.now() + input.durationSeconds * 1000, input.deadlineWallMs),
        binding: input.binding.grant,
      };
      await receipts.bind(input.admissionId, bound, generation, session);
      admissions.set(input.admissionId, session);
      sessions.set(session.sessionId, session);
      ownership.set(session.sessionId, { admissionId: input.admissionId, input: bound });
      return {
        kind: "created",
        session,
        files: encodeRepositoryCredentialSessionFiles({
          session,
          bearer: `worker_boundary_bearer_${randomUUID().replaceAll("-", "")}`,
          client: {
            gatewayOrigin: "https://repository-gateway.example.test",
            gitRemote: "https://repository-gateway.example.test/organization/repository.git",
            gitUsername: "repository-session",
            canonicalApiHost: "api.example.test",
            apiHost: "repository-gateway.example.test",
            repository: "organization/repository",
          },
        }),
      };
    },
    async status(sessionId) {
      calls.push({ operation: "status", sessionId });
      return sessions.get(sessionId);
    },
    async close(sessionId) {
      calls.push({ operation: "close", sessionId });
      return dispose(sessionId);
    },
  };
  return {
    driver,
    dispose,
    calls,
    snapshot: {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs,
      bindings,
    },
  };
}

export function repositoryAttempts(fixture, revision) {
  return fixture.state.read((view) =>
    view.repositorySessions.listRevisionAttempts({
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    }),
  );
}

// Offboards an operator: it keeps its identity but loses every access binding.
export function removeAccessBindings(fixture, subjectId) {
  return fixture.observerPool.query(
    `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
    [subjectId],
  );
}
