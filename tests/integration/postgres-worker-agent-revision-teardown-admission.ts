import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryCredentialRuntimeBinding } from "../../packages/contracts/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import {
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import {
  required,
  type RevisionSetup,
  readWorkerEvent,
  type WorkerEvent,
} from "./postgres-worker-agent-revision-teardown-fixture.ts";

export function testRepositoryAdmission(setup: RevisionSetup) {
  test(
    "repository admission persists its opening request before dispatch and session ID before Compute",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { candidate } = await fixture.admitInitialRevision("repository-ordering", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const open = repository.driver.open;
      repository.driver.open = async (input, signal) => {
        const attempts = await repositoryAttempts(fixture, candidate);
        assert.equal(attempts.length, 1);
        const attempt = required(attempts[0], "admission attempt");
        assert.equal(attempt.phase, "opening");
        assert.equal(attempt.sessionId, undefined);
        assert.equal(attempt.admissionId, input.admissionId);
        assert.equal(attempt.repositoryRef, input.binding.repositoryRef);
        assert.equal(attempt.durationSeconds, input.durationSeconds);
        assert.equal(attempt.deadlineWallMs, input.deadlineWallMs);
        return open(input, signal);
      };
      const material: string[] = [];
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            const attempts = await repositoryAttempts(fixture, revision);
            assert.ok(deploymentContext?.repositoryCredentials);
            const [binding] = deploymentContext.repositoryCredentials;
            assert.ok(binding, "expected repository material");
            assert.equal(attempts.length, 1);
            const attempt = required(attempts[0], "admission attempt");
            assert.equal(attempt.phase, "open");
            assert.equal(attempt.sessionId, binding.sessionId);
            assert.equal(binding.kind, "new");
            assert.equal(
              binding.repositoryRef,
              required(repository.snapshot.bindings[0], "admitted binding").repositoryRef,
            );
            material.push(binding.files.bearer);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(readWorkerEvent(event)) },
      );
      assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
      assert.equal(material.length, 1);
      const bearer = required(material[0], "delivered bearer");
      const persisted = await fixture.observerPool.query<{ value: unknown }>(
        `SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt
         WHERE revision_id = $1
         UNION ALL SELECT to_jsonb(work) FROM occ.controller_work AS work WHERE revision_id = $1
         UNION ALL SELECT to_jsonb(audit) FROM occ.audit_events AS audit WHERE namespace_id = $2`,
        [candidate.id, candidate.namespaceId],
      );
      assert.equal(JSON.stringify(persisted.rows).includes(bearer), false);
      assert.equal(JSON.stringify(events).includes(bearer), false);
    },
  );

  for (const alreadyDisposed of [false, true]) {
    test(
      alreadyDisposed
        ? "a dropped repository-open response preserves recovered disposal after service pruning"
        : "a dropped repository-open response recovers and closes its admission before opening fresh material",
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, { repoDriver: repository.driver });
        const { candidate } = await fixture.admitInitialRevision("repository-lost-response", {
          revision: { repositoryCredentials: repository.snapshot },
        });
        const open = repository.driver.open;
        let lostSessionId: string | undefined;
        repository.driver.open = async (input, signal) => {
          const result = await open(input, signal);
          if (lostSessionId === undefined && result.kind === "created") {
            lostSessionId = result.session.sessionId;
            throw new Error("repository admission response lost after creation");
          }
          if (alreadyDisposed && result.kind === "recovered") {
            const status = await repository.dispose(result.status.sessionId);
            assert.equal(status?.state, "DISPOSED");
            return { ...result, status };
          }
          return result;
        };
        if (alreadyDisposed) {
          // The service's terminal observation is authoritative even if another
          // admission prunes that inventory before a redundant close could arrive.
          repository.driver.close = async (sessionId) => {
            repository.calls.push({ operation: "close", sessionId });
            return undefined;
          };
        }
        const material: RepositoryCredentialRuntimeBinding[] = [];
        await fixture.start({
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            assert.ok(deploymentContext?.repositoryCredentials);
            material.push(...deploymentContext.repositoryCredentials);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        });
        const completed = await fixture.work(candidate, "succeeded");
        assert.equal(completed.attempt_count, 2);
        const attempts = await repositoryAttempts(fixture, candidate);
        assert.equal(
          attempts.find(({ sessionId }) => sessionId === lostSessionId)?.phase,
          "disposed",
        );
        assert.deepEqual(
          repository.calls.map(({ operation }) => operation),
          alreadyDisposed ? ["open", "recover", "open"] : ["open", "recover", "close", "open"],
        );
        const [original, recovered] = repository.calls;
        const fresh = repository.calls.at(-1);
        assert.equal(original?.operation, "open");
        assert.equal(recovered?.operation, "recover");
        assert.equal(fresh?.operation, "open");
        assert.deepEqual(recovered.input, { ...original.input, recoverOnly: true });
        if (!alreadyDisposed) {
          const closed = repository.calls[2];
          assert.equal(closed?.operation, "close");
          assert.equal(closed.sessionId, lostSessionId);
        }
        assert.notEqual(fresh.input.admissionId, original.input.admissionId);
        assert.deepEqual(fresh.input.binding, original.input.binding);
        assert.equal(fresh.input.deadlineWallMs, original.input.deadlineWallMs);
        assert.ok(fresh.input.durationSeconds <= original.input.durationSeconds);
        assert.equal(
          attempts.find(({ admissionId }) => admissionId === fresh.input.admissionId)?.phase,
          "open",
        );
        assert.equal(material.length, 1);
        const binding = required(material[0], "replacement material");
        assert.equal(binding.kind, "new");
        assert.notEqual(binding.sessionId, lostSessionId);
      },
    );
  }

  test(
    "a missing never-delivered repository opening can recover without inventing disposal",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { candidate } = await fixture.admitInitialRevision("repository-unseen-opening", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const open = repository.driver.open;
      let undelivered: string | undefined;
      repository.driver.open = async (input, signal) => {
        if (undelivered === undefined) {
          undelivered = input.admissionId;
          throw new Error("control request did not reach the service");
        }
        return open(input, signal);
      };
      const material: RepositoryCredentialRuntimeBinding[] = [];
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          assert.ok(deploymentContext?.repositoryCredentials);
          material.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      });
      await fixture.work(candidate, "succeeded");
      const attempts = await repositoryAttempts(fixture, candidate);
      const missing = required(
        attempts.find(({ admissionId }) => admissionId === undelivered),
        "undelivered attempt",
      );
      assert.equal(missing.phase, "invalidated");
      assert.equal(missing.sessionId, undefined);
      assert.equal(missing.liveRevisionId, candidate.id);
      assert.equal(attempts.length, 2);
      assert.equal(material.length, 1);
      const opened = required(
        attempts.find(({ phase }) => phase === "open"),
        "open attempt",
      );
      assert.equal(required(material[0], "delivered material").sessionId, opened.sessionId);
      assert.deepEqual(
        repository.calls.map(({ operation }) => operation),
        ["recover", "open"],
      );
      await fixture.stop();
    },
  );
}
