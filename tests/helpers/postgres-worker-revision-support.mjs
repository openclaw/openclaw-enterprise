import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import { RepositoryReceiptStore } from "../../apps/controller/src/backends/repository-credentials/receipt-store.ts";
import { waitFor } from "./wait-for.mjs";

// Helpers shared by the PostgreSQL worker integration tests.

// The worker emits worker.completed after its queue transaction commits, so another
// connection can see the committed Work state first. Wait for the event instead of
// reading the event list once.
export function completion(events, description, predicate) {
  return waitFor(description, async () => events.find(predicate));
}

// The database can say a work item ended before its worker.completed event arrives (finding
// 1607). Wait for the work's first pass with `outcome`, check it is the last pass observed, and
// return every pass of the work. A revision pass whose pointer commit lost a race logs the
// retry it committed (`ACTIVE_REVISION_CHANGED`, finding 1611), so its later pass is the end.
export async function completedPasses(events, work, outcome = "success") {
  const ended = await completion(
    events,
    `work ${work.idempotencyKey} to end with outcome ${outcome}`,
    (event) =>
      event.event === "worker.completed" &&
      event.workId === work.idempotencyKey &&
      event.outcome === outcome,
  );
  const passes = events.filter(
    ({ event, workId }) => event === "worker.completed" && workId === work.idempotencyKey,
  );
  assert.equal(passes.at(-1), ended);
  return passes;
}

// Model the next cleanup interval without waiting an hour for the boundary
// Driver. Change only this revision's queued due times; claims remain real.
export async function advanceCleanupRetries(fixture, revision) {
  await fixture.observerPool.query(
    `UPDATE occ.controller_work SET available_at = clock_timestamp()
     WHERE state = 'queued' AND idempotency_key LIKE $1`,
    [`agent_revision:${revision.id}:repository_cleanup:%`],
  );
}

// Make this revision's queued maintenance and cleanup passes due now, for tests that wait on
// a pass but not on its cadence. The worker still claims and runs each pass. A pass that runs
// early schedules the next one a full interval later, so later waits on these cadences must
// advance them too.
export async function advanceRevisionQueue(fixture, revision) {
  await fixture.advanceMaintenance(revision);
  await advanceCleanupRetries(fixture, revision);
}

// Polls like waitFor, making this revision's queued passes due after each miss.
export function waitForRevisionPass(description, fixture, revision, read, options) {
  return waitFor(
    description,
    async () => {
      const value = await read();
      if (value === undefined) {
        await advanceRevisionQueue(fixture, revision);
      }
      return value;
    },
    options,
  );
}

// Only after every fixture worker has stopped: a pass that stop interrupted keeps its claim
// until the lease ends. Expire this revision's claims instead of waiting out the lease.
export async function expireStoppedClaims(fixture, revision) {
  await fixture.observerPool.query(
    `UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE state = 'claimed' AND revision_id = $1`,
    [revision.id],
  );
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
