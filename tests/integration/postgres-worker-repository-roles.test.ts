import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

for (const role of ["repositoryPolicy", "nativeRepositorySender"] as const) {
  for (const field of ["id", "implementation", "absent"] as const) {
    test(
      `worker refuses repository credentials when ${role} is ${field === "absent" ? "absent" : `present with the wrong ${field}`}`,
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        // Keep retries available so a first-pass refusal is observable.
        const options = { repoDriver: repository.driver, maxAttempts: 2 };
        const fixture = await setup(context, options);
        const { owner, candidate } = await fixture.admitInitialRevision("repository-role", {
          revision: { repositoryCredentials: repository.snapshot },
        });
        let preparations = 0;
        let policyChecks = 0;
        await fixture.start(
          {
            ...fixture.compute,
            async prepareRevision(...args: Parameters<typeof fixture.compute.prepareRevision>) {
              preparations++;
              return fixture.compute.prepareRevision(...args);
            },
          },
          {
            transformDrivers(drivers: InstallationRuntimeDrivers) {
              const { repositoryPolicy, nativeRepositorySender } = drivers;
              assert.ok(repositoryPolicy && nativeRepositorySender);
              assert.equal("open" in repositoryPolicy, false);
              assert.equal("resolve" in nativeRepositorySender, false);
              assert.deepEqual(
                repositoryPolicy.resolve({
                  namespaceId: fixture.namespace.id,
                  bindings: repository.snapshot.bindings.map(({ repositoryRef, profile }) => ({
                    repositoryRef,
                    profile,
                  })),
                }).bindings,
                repository.snapshot.bindings,
              );
              const installed = {
                ...drivers,
                repositoryPolicy: {
                  ...repositoryPolicy,
                  resolve(input: Parameters<typeof repositoryPolicy.resolve>[0]) {
                    policyChecks++;
                    return repositoryPolicy.resolve(input);
                  },
                },
              };
              if (field === "absent") {
                const { [role]: removed, ...others } = installed;
                assert.ok(removed);
                return others;
              }
              return {
                ...installed,
                [role]: { ...installed[role], [field]: `unselected-${field}` },
              };
            },
          },
        );
        const work = await fixture.work(candidate, "failed_permanent", 15_000);
        assert.equal(work.attempt_count, 1);
        assert.equal(
          (await fixture.workResult(candidate)).rows[0]?.reason_code,
          "REPOSITORY_DRIVER_MISMATCH",
        );
        if (role === "nativeRepositorySender") {
          assert.ok(policyChecks > 0, "the worker revalidated the admitted grant");
        }
        assert.deepEqual(repository.calls, []);
        assert.deepEqual(await repositoryAttempts(fixture, candidate), []);
        assert.equal(preparations, 0);
        assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
      },
    );
  }
}

test(
  "live repository cleanup uses the persisted owner with revision identity only",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const queueOptions = { leaseDurationMs: 30_000 };
    const fixtureOptions = { ...queueOptions, repoDriver: repository.driver };
    const fixture = await setup(context, fixtureOptions);
    const { candidate } = await fixture.admitInitialRevision("repository-cleanup-owner", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, queueOptions);
    const claim = await queue.claim();
    assert.ok(claim);
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    const binding = repository.snapshot.bindings[0]!;
    const attempt = await fixture.state.transact((unit) =>
      unit.repositorySessions.createAttempt({
        namespaceId: candidate.namespaceId,
        agentId: candidate.agentId,
        revisionId: candidate.id,
        repositoryRef: binding.repositoryRef,
        admissionId: `${Date.now()}-${randomUUID()}`,
        durationSeconds: 60,
        deadlineWallMs: repository.snapshot.deadlineWallMs,
        createdAt: new Date().toISOString(),
        brokerProtocol: 3,
      }),
    );
    const input = {
      namespaceId: candidate.namespaceId,
      admissionId: attempt.admissionId,
      binding,
      durationSeconds: attempt.durationSeconds,
      deadlineWallMs: attempt.deadlineWallMs,
      preparedOnly: true as const,
    };
    // The broker committed its receipt, but the worker lost the open response before
    // saving a session ID. Cleanup must recover that admission, never create a replacement.
    const opened = await repository.driver.open(input, AbortSignal.timeout(5_000));
    assert.equal(opened.kind, "created");
    assert.ok(opened.session);
    const sessionId = opened.session.sessionId;
    const lifecycle = (implementation: string) =>
      new RepositoryCredentialLifecycle({
        state: fixture.state,
        queueOptions,
        driver: undefined,
        nativeSender: {
          ...repository.driver,
          implementation,
          durableBrokerReceipts: true,
          async open(input, signal) {
            const result = await repository.driver.open(input, signal);
            assert.equal(result.kind, "recovered");
            assert.ok(result.status);
            return { kind: "recovered", status: result.status };
          },
        },
        authorize: async () => assert.fail("cleanup must not authorize fresh admission"),
        effect: async (_claim, operation) => operation(AbortSignal.timeout(5_000)),
      });
    const original = lifecycle(repository.driver.implementation);
    const revision = await fixture.state.read((view) =>
      view.revisions.findRevision(candidate.namespaceId, candidate.agentId, candidate.id),
    );
    assert.ok(revision);
    await original.closeRevision(claim, revision, { awaitCleanup: false });
    const [closing] = await repositoryAttempts(fixture, candidate);
    assert.equal(closing?.phase, "closing");
    assert.equal(closing.sessionId, undefined);
    const identity = {
      id: candidate.id,
      namespaceId: candidate.namespaceId,
      agentId: candidate.agentId,
    };
    const wrong = lifecycle("different-implementation");
    assert.deepEqual(await wrong.cleanup(claim, identity), {
      settled: false,
      cause: "REPOSITORY_DRIVER_MISMATCH",
    });
    assert.equal(repository.calls.length, 1);
    assert.deepEqual(await repositoryAttempts(fixture, candidate), [closing]);

    assert.deepEqual(await original.cleanup(claim, identity), { settled: true });
    assert.deepEqual(
      repository.calls.map(({ operation }) => operation),
      ["open", "recover", "close"],
    );
    assert.deepEqual(repository.calls[1]?.input, { ...input, recoverOnly: true });
    assert.equal(repository.calls[2]?.sessionId, sessionId);
    const [disposed] = await repositoryAttempts(fixture, candidate);
    assert.equal(disposed?.admissionId, attempt.admissionId);
    assert.equal(disposed.sessionId, sessionId);
    assert.equal(disposed.phase, "disposed");
  },
);
