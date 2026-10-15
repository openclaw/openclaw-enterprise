import { randomUUID } from "node:crypto";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import { waitFor } from "./wait-for.mjs";

// Helpers shared by the postgres-worker-agent-revision*.test.mjs files.

// The worker emits worker.completed after its queue transaction commits, so another
// connection can see the committed Work state first. Wait for the event instead of
// reading the event list once.
export function completion(events, description, predicate) {
  return waitFor(description, async () => events.find(predicate));
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

// This boundary Driver supplies protocol observations. The real worker, native
// IAM, State, and PostgreSQL queue own every lifecycle decision asserted below;
// these cases do not qualify the concrete credential service or Compute runtime.
export function repositoryBoundary({ count = 1, deadlineWallMs = Date.now() + 120_000 } = {}) {
  const bindings = Array.from({ length: count }, (_, index) => ({
    repositoryRef: `repository-${index}-${randomUUID()}`,
    profile: "read",
    backendId: "repository-provider",
    grant: {
      providerInstanceId: "repository-provider-instance",
      repositoryId: `repository-${index}`,
      grantId: `grant-${index}`,
    },
  }));
  const admissions = new Map();
  const sessions = new Map();
  const calls = [];
  const driver = {
    id: "repository-worker-boundary",
    implementation: "repository-worker-boundary",
    capability: "repo",
    maintenanceIntervalMs: 3_600_000,
    async listOptions() {
      return { options: [], descriptionsPending: false };
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
      if (input.recoverOnly) {
        return { kind: "missing" };
      }
      const session = {
        sessionId: `session_${randomUUID()}`,
        state: "OPEN",
        deadlineWallMs: Math.min(Date.now() + input.durationSeconds * 1000, input.deadlineWallMs),
        binding: input.binding.grant,
      };
      admissions.set(input.admissionId, session);
      sessions.set(session.sessionId, session);
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
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return undefined;
      }
      const disposed = { ...session, state: "DISPOSED" };
      sessions.set(sessionId, disposed);
      for (const [admissionId, admitted] of admissions) {
        if (admitted.sessionId === sessionId) {
          admissions.set(admissionId, disposed);
        }
      }
      return disposed;
    },
  };
  return {
    driver,
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
