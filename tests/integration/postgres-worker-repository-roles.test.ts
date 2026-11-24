import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type {
  ComputeDriver,
  GitHubRepositoryCredentialBackendDefinition,
} from "../../packages/contracts/src/index.ts";
import {
  isRepositoryCleanupWork,
  OpenClawController,
  PostgresMetricsSnapshot,
  WorkClaimLostError,
} from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

function nativeRepositoryPolicy(
  backend: GitHubRepositoryCredentialBackendDefinition,
  namespaceId: string,
) {
  return new GitHubRepositoryPolicy(
    { driverId: backend.drivers.repo, backendId: backend.id },
    validateGitHubRepositoryRegistry({
      version: 1,
      backendId: backend.id,
      providerInstanceId: "worker-github-policy",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "source",
          repositoryId: "789",
          repository: "example/source",
          namespaces: [
            {
              namespaceId,
              profiles: ["git-read"],
            },
          ],
        },
      ],
    }),
    { sessionDurationSeconds: 300 },
  );
}

function repositoryWorkerComposition(
  drivers: InstallationRuntimeDrivers,
  backend: GitHubRepositoryCredentialBackendDefinition,
  policy: GitHubRepositoryPolicy,
  mode: "built-in" | "legacy" | "conflicting" | "missing-legacy",
): InstallationRuntimeDrivers {
  const { repositoryPolicy, ...others } = drivers;
  assert.ok(repositoryPolicy && drivers.nativeRepositorySender);
  assert.equal(repositoryPolicy.id, policy.id);
  assert.equal(drivers.nativeRepositorySender.implementation, policy.implementation);
  return {
    ...others,
    installation: { ...drivers.installation, backend: [backend] },
    repositoryAdmission: {
      policy,
      backendId: backend.id,
      ...(mode === "built-in" || mode === "conflicting" ? { policyMode: "built-in" as const } : {}),
    },
    ...(mode === "legacy" ? { repositoryPolicy: policy } : {}),
    // Same ID, different object: the public policy must not be ignored.
    ...(mode === "conflicting" ? { repositoryPolicy } : {}),
  };
}

for (const brokerProtocol of [1, 3] as const) {
  for (const savedSession of [false, true]) {
    test(
      `retained protocol ${brokerProtocol} consumes committed disposal with ${savedSession ? "saved" : "lost"} session ID and no sender`,
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const queueOptions = { leaseDurationMs: 30_000 };
        const fixtureOptions = { ...queueOptions, repoDriver: repository.driver };
        const fixture = await setup(context, fixtureOptions);
        const { candidate } = await fixture.admitInitialRevision("terminal-receipt", {
          revision: { repositoryCredentials: repository.snapshot },
        });
        const queue = new fixture.PostgresWorkQueue(fixture.observerPool, queueOptions);
        const original = await queue.claim();
        assert.ok(original);
        assert.equal(original.idempotencyKey, candidate.idempotencyKey);
        const owner = {
          namespaceId: candidate.namespaceId,
          agentId: candidate.agentId,
          revisionId: candidate.id,
        };
        const admissionId = randomUUID();
        const sessionId = randomUUID();
        const generation = randomUUID();
        await fixture.state.transact(async ({ repositorySessions: sessions }) => {
          await sessions.createAttempt({
            ...owner,
            admissionId,
            repositoryRef: repository.snapshot.bindings[0]!.repositoryRef,
            durationSeconds: 60,
            deadlineWallMs: repository.snapshot.deadlineWallMs,
            createdAt: new Date().toISOString(),
            brokerProtocol,
          });
          await sessions.createBrokerReceipt({
            admissionId,
            state: "reserved",
            generation,
          });
          const observation = {
            admissionId,
            generation,
            sessionId,
            deadlineWallMs: repository.snapshot.deadlineWallMs - 1,
          };
          await sessions.advanceBrokerReceipt({
            ...observation,
            expectedState: "reserved",
            state: "active",
          });
          if (savedSession) {
            await sessions.advanceAttempt({
              admissionId,
              expectedPhase: "opening",
              phase: "open",
              sessionId,
              updatedAt: new Date().toISOString(),
            });
          }
          await sessions.advanceAttempt({
            admissionId,
            expectedPhase: savedSession ? "open" : "opening",
            phase: "closing",
            updatedAt: new Date().toISOString(),
          });
          await sessions.advanceBrokerReceipt({
            ...observation,
            expectedState: "active",
            state: "disposed",
            revoked: 2,
            expired: 1,
          });
        });
        await queue.enqueueRepositoryCleanup(original, owner);
        await queue.complete(original);
        const claim = await queue.claim();
        assert.ok(claim && isRepositoryCleanupWork(claim));
        assert.ok(await queue.heartbeat(claim));
        const [attempt] = await repositoryAttempts(fixture, candidate);
        assert.ok(attempt);
        const readReceipt = () =>
          fixture.state.read((view) => view.repositorySessions.findBrokerReceipt(admissionId));
        const receipt = await readReceipt();
        assert.ok(receipt);
        assert.equal(receipt.state, "disposed");
        assert.equal(receipt.sessionId, sessionId);
        const lifecycle = new RepositoryCredentialLifecycle({
          state: fixture.state,
          queueOptions,
          authorize: async () => assert.fail("terminal consumption cannot authorize"),
          effect: async () => assert.fail("terminal consumption cannot call a sender"),
        });
        if (savedSession) {
          assert.equal(attempt.phase, "closing");
          assert.equal(attempt.sessionId, sessionId);
          const differentSessionId = randomUUID();
          assert.notEqual(differentSessionId, sessionId);
          await assert.rejects(
            lifecycle.cleanupRetained({ ...claim, claimToken: randomUUID() }, [attempt]),
            WorkClaimLostError,
          );
          await assert.rejects(
            lifecycle.cleanupRetained(claim, [{ ...attempt, sessionId: differentSessionId }]),
            WorkClaimLostError,
          );
          assert.deepEqual(await repositoryAttempts(fixture, candidate), [attempt]);
          assert.deepEqual(await readReceipt(), receipt);
          if (brokerProtocol === 3) {
            // A committed hint cannot authorize fallback when the locked journal is unavailable.
            // Keep an otherwise usable sender so this distinguishes refusal from missing wiring.
            const guarded = new RepositoryCredentialLifecycle({
              state: fixture.state,
              queueOptions,
              nativeSender: repository.driver,
              authorize: async () => assert.fail("cleanup cannot authorize"),
              effect: async (_claim, operation) => operation(AbortSignal.timeout(5_000)),
            });
            const transact = fixture.state.transactWithQueue.bind(fixture.state);
            const lockedReadAdmissions: string[] = [];
            const readUnavailable: typeof fixture.state.transactWithQueue = async (
              operation,
              options,
            ) =>
              transact(async (unit, queue) => {
                // Keep the frozen, lifetime-bound methods intact; fault only this view's read.
                return operation(
                  {
                    ...unit,
                    repositorySessions: {
                      ...unit.repositorySessions,
                      async findBrokerReceipt(requestedAdmissionId: string) {
                        lockedReadAdmissions.push(requestedAdmissionId);
                        if (requestedAdmissionId === admissionId) {
                          return undefined;
                        }
                        return unit.repositorySessions.findBrokerReceipt(requestedAdmissionId);
                      },
                    },
                  },
                  queue,
                );
              }, options);
            const unavailable = context.mock.method(
              fixture.state,
              "transactWithQueue",
              readUnavailable,
            );
            try {
              assert.deepEqual(await guarded.cleanupRetained(claim, [attempt]), {
                settled: false,
                cause: "INVALID_REPOSITORY_DRIVER_OBSERVATION",
              });
              assert.equal(unavailable.mock.callCount(), 1);
              assert.deepEqual(lockedReadAdmissions, [admissionId]);
            } finally {
              unavailable.mock.restore();
            }
            assert.deepEqual(await repositoryAttempts(fixture, candidate), [attempt]);
            assert.deepEqual(await readReceipt(), receipt);
            assert.deepEqual(repository.calls, []);
          }
        }
        // Lost-ID cases go directly to the decisive no-sender terminal read.
        assert.deepEqual(await lifecycle.cleanupRetained(claim, [attempt]), {
          settled: true,
        });
        const [disposed] = await repositoryAttempts(fixture, candidate);
        assert.ok(disposed);
        assert.deepEqual(disposed, {
          ...attempt,
          phase: "disposed",
          sessionId,
          updatedAt: disposed.updatedAt,
        });
        assert.deepEqual(await lifecycle.cleanup(claim, candidate), { settled: true });
        assert.deepEqual(await repositoryAttempts(fixture, candidate), [disposed]);
        assert.deepEqual(await readReceipt(), receipt);
        assert.deepEqual(repository.calls, []);
      },
    );
  }
}

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
  "worker startup binds built-in repository provisioning without public registration",
  requiresPostgres,
  async (t) => {
    for (const mode of ["built-in", "legacy", "conflicting", "missing-legacy"] as const) {
      await t.test(mode, async (context) => {
        const repository = repositoryBoundary();
        // The synthetic sender's receipt owner matches the real policy from the outset.
        // No identity is changed after the finite revision has been admitted.
        repository.driver.implementation = "github";
        const backend: GitHubRepositoryCredentialBackendDefinition = {
          id: repository.snapshot.bindings[0]!.backendId,
          type: "github",
          configuration: { registryPath: "/unused/worker-repository-registry.json" },
          drivers: { repo: repository.driver.id },
        };
        const options = { repoDriver: repository.driver, backends: [backend] };
        const fixture = await setup(context, options);
        const policy = nativeRepositoryPolicy(backend, fixture.namespace.id);
        const input = {
          namespaceId: fixture.namespace.id,
          bindings: [{ repositoryRef: "source", profile: "git-read" }],
        };
        const finite = policy.resolveBindings(input);
        const snapshot = {
          driver: { id: policy.id, implementation: policy.implementation },
          deadlineWallMs: Date.now() + finite.sessionDurationSeconds * 1000,
          bindings: finite.bindings,
        };
        const { candidate } = await fixture.admitInitialRevision("bound-repository", {
          revision: { repositoryCredentials: snapshot },
        });
        const checks = context.mock.method(policy, "resolveBindings");
        const provisioning = context.mock.method(OpenClawController, "forInstallation");
        const preparations: Parameters<ComputeDriver["prepareRevision"]>[] = [];
        const compute = {
          ...fixture.compute,
          async prepareRevision(...args: Parameters<ComputeDriver["prepareRevision"]>) {
            preparations.push(args);
            return fixture.compute.prepareRevision(args[0]);
          },
        };
        const start = () =>
          fixture.start(compute, {
            transformDrivers(drivers: InstallationRuntimeDrivers) {
              return repositoryWorkerComposition(drivers, backend, policy, mode);
            },
          });
        if (mode === "conflicting" || mode === "missing-legacy") {
          await assert.rejects(async () => start(), {
            name: "Error",
            message: "The bound repository admission owner is not selected or unavailable.",
          });
          assert.equal(provisioning.mock.callCount(), 0);
          assert.equal(checks.mock.callCount(), 0);
          assert.deepEqual(preparations, []);
          assert.deepEqual(repository.calls, []);
          assert.deepEqual(await repositoryAttempts(fixture, candidate), []);
          return;
        }
        await start();
        // Observe the actual controller constructed by Worker.start, without replacing it.
        assert.equal(provisioning.mock.callCount(), 1);
        const controller = provisioning.mock.calls[0]!.result;
        assert.ok(controller);
        await controller.validateBackendConfiguration();
        if (mode === "built-in") {
          assert.throws(() => controller.selectedDriver("repo"), {
            name: "DriverSelectionError",
            message: /unavailable/,
          });
        } else {
          assert.equal(controller.selectedDriver("repo"), policy);
        }
        const prepared = await completion(
          preparations,
          "the original finite repository revision to reach Compute",
          (args: Parameters<ComputeDriver["prepareRevision"]>) => args[0].id === candidate.id,
        );
        await fixture.stop();
        assert.deepEqual(prepared[0].repositoryCredentials, snapshot);
        assert.ok(prepared[1]);
        assert.ok(prepared[1].repositoryCredentials);
        assert.ok(
          checks.mock.callCount() > 0,
          "the bound native policy rechecked current permission",
        );
        for (const call of checks.mock.calls) {
          assert.deepEqual(call.arguments, [input]);
        }
        const opened = repository.calls.filter((call) => call.operation === "open");
        assert.equal(opened.length, 1);
        assert.deepEqual(opened[0]!.input.binding, finite.bindings[0]);
        assert.equal(opened[0]!.input.deadlineWallMs, snapshot.deadlineWallMs);
        const attempts = await repositoryAttempts(fixture, candidate);
        assert.equal(attempts.length, 1);
        assert.ok(attempts[0]!.sessionId);
      });
    }
  },
);

type RevisionWorkerFixture = Awaited<ReturnType<typeof setup>>;
type RepositoryBoundary = ReturnType<typeof repositoryBoundary>;

async function admitLegacyRepositorySession(
  fixture: RevisionWorkerFixture,
  repository: RepositoryBoundary,
  legacy: OpenClawController,
  policy: GitHubRepositoryPolicy,
) {
  // Seed only ordinary resources; the actual Worker controller saves and admits them.
  const owner = await fixture.agent("legacy-repository-restart");
  const configuration = await legacy.createConfiguration(fixture.actor.id, {
    namespaceId: fixture.namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("openclaw", "gpt-4.1"),
  });
  const bindings = [{ repositoryRef: "source", profile: "git-read" }];
  await legacy.updateAgent(
    fixture.actor.id,
    {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      configurationId: configuration.id,
      repositoryBindings: bindings,
    },
    resolveApprovedHarness,
  );
  const beforeAdmission = Date.now();
  const revision = await legacy.deployAgent(
    fixture.actor.id,
    {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
    },
    resolveApprovedHarness,
  );
  const snapshot = revision.repositoryCredentials;
  assert.ok(snapshot);
  assert.deepEqual(snapshot, {
    driver: { id: policy.id, implementation: policy.implementation },
    bindings: policy.resolveBindings({ namespaceId: fixture.namespace.id, bindings }).bindings,
    deadlineWallMs: snapshot.deadlineWallMs,
  });
  assert.ok(snapshot.deadlineWallMs >= beforeAdmission + 300_000);
  assert.ok(snapshot.deadlineWallMs <= Date.now() + 300_000);
  const work = await fixture.observerPool.query(
    "SELECT idempotency_key FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key = $2",
    [revision.id, `agent_revision:${revision.id}:reconcile`],
  );
  assert.equal(work.rowCount, 1);
  const candidate = { ...revision, idempotencyKey: work.rows[0].idempotency_key };
  await fixture.work(candidate, "succeeded");
  const [opened] = await repositoryAttempts(fixture, candidate);
  assert.ok(opened?.sessionId);
  assert.equal(opened.brokerProtocol, 3);
  assert.equal(opened.phase, "open");
  const originalOpen = repository.calls.find((call) => call.operation === "open");
  assert.equal(originalOpen?.input.admissionId, opened.admissionId);
  assert.deepEqual(originalOpen?.input.binding, snapshot.bindings[0]);
  assert.equal(originalOpen?.input.deadlineWallMs, snapshot.deadlineWallMs);
  assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
  return { owner, revision, candidate, snapshot, opened };
}

async function deferLegacyRepositoryCleanup(
  fixture: RevisionWorkerFixture,
  repository: RepositoryBoundary,
  admission: Awaited<ReturnType<typeof admitLegacyRepositorySession>>,
  events: Record<string, unknown>[],
) {
  const { owner, revision, candidate, snapshot, opened } = admission;
  const close = repository.driver.close;
  repository.driver.close = async () => {
    throw new Error("repository service temporarily unavailable");
  };
  try {
    const stop = await fixture.requestStop(owner);
    const pending = await completion(
      events,
      "legacy cleanup to durably defer",
      (event: Record<string, unknown>) =>
        event.event === "worker.completed" &&
        event.revisionId === revision.id &&
        event.code === "REPOSITORY_CLEANUP_PENDING",
    );
    await fixture.stop();
    assert.ok(typeof pending.workId === "string");
    const cleanupWork = { idempotencyKey: pending.workId };
    const deferred = await fixture.observerPool.query(
      `SELECT actor_id, agent_id, revision_id, state,
       EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
     FROM occ.controller_work WHERE idempotency_key = $1`,
      [cleanupWork.idempotencyKey],
    );
    assert.equal(deferred.rowCount, 1);
    assert.equal(deferred.rows[0].state, "queued");
    assert.equal(deferred.rows[0].actor_id, fixture.actor.id);
    assert.equal(deferred.rows[0].agent_id, owner.id);
    assert.equal(deferred.rows[0].revision_id, revision.id);
    assert.ok(Number(deferred.rows[0].delay_ms) >= repository.driver.maintenanceIntervalMs - 1_000);
    const [closing] = await repositoryAttempts(fixture, candidate);
    assert.equal(closing?.phase, "closing");
    assert.equal(closing.brokerProtocol, 3);
    assert.equal(closing.admissionId, opened.admissionId);
    assert.equal(closing.sessionId, opened.sessionId);
    assert.deepEqual(closing.cleanupContext.driver, snapshot.driver);
    assert.deepEqual(closing.cleanupContext.binding, snapshot.bindings[0]);
    return { stop, cleanupWork, closing };
  } finally {
    repository.driver.close = close;
  }
}

test(
  "built-in Worker settles legacy admission through the original repository sender",
  requiresPostgres,
  async (t) => {
    for (const mode of ["original", "mismatched", "disposed"] as const) {
      await t.test(
        {
          original: "original sender",
          mismatched: "wrong sender then original sender",
          disposed: "committed disposal",
        }[mode],
        async (context) => {
          const repository = repositoryBoundary();
          repository.driver.implementation = "github";
          const backend: GitHubRepositoryCredentialBackendDefinition = {
            id: repository.snapshot.bindings[0]!.backendId,
            type: "github",
            configuration: { registryPath: "/unused/worker-repository-registry.json" },
            drivers: { repo: repository.driver.id },
          };
          const metrics =
            mode === "mismatched"
              ? createOccMetrics("worker", () =>
                  new PostgresMetricsSnapshot(fixture.observerPool).collect(),
                )
              : undefined;
          const fixture = await setup(context, {
            repoDriver: repository.driver,
            backends: [backend],
            metrics,
          });
          const successMetric =
            /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_revision"[^}]*outcome="success"[^}]*\} (\d+)(?:\n|$)/;
          const pendingMetric =
            /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_revision"[^}]*outcome="pending"[^}]*\} [1-9]\d*(?:\n|$)/;
          const errorMetric =
            /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_revision"[^}]*outcome="error"[^}]*\} [1-9]\d*(?:\n|$)/;
          const policy = nativeRepositoryPolicy(backend, fixture.namespace.id);
          const provisioning = context.mock.method(OpenClawController, "forInstallation");
          const events: Record<string, unknown>[] = [];
          async function start(mode: "legacy" | "built-in", mismatchedSender = false) {
            await fixture.start(fixture.compute, {
              emit: (event: Record<string, unknown>) => events.push(event),
              transformDrivers(drivers: InstallationRuntimeDrivers) {
                const composed = repositoryWorkerComposition(drivers, backend, policy, mode);
                assert.ok(composed.nativeRepositorySender);
                return mismatchedSender
                  ? {
                      ...composed,
                      nativeRepositorySender: {
                        ...composed.nativeRepositorySender,
                        implementation: "wrong-sender",
                      },
                    }
                  : composed;
              },
            });
            const controller = provisioning.mock.calls.at(-1)!.result;
            assert.ok(controller);
            await controller.validateBackendConfiguration();
            if (mode === "legacy") {
              assert.equal(controller.selectedDriver("repo"), policy);
            } else {
              assert.throws(() => controller.selectedDriver("repo"), {
                name: "DriverSelectionError",
                message: /unavailable/,
              });
            }
            return controller;
          }
          const legacy = await start("legacy");
          const admission = await admitLegacyRepositorySession(fixture, repository, legacy, policy);
          const { owner, revision, candidate, snapshot, opened } = admission;
          const { stop, cleanupWork, closing } = await deferLegacyRepositoryCleanup(
            fixture,
            repository,
            admission,
            events,
          );
          // The original custodian commits disposal while the Worker is stopped.
          // Restart must consume that receipt even when its configured sender cannot match.
          const committed = mode === "disposed";
          if (committed) {
            assert.ok(opened.sessionId);
            assert.equal((await repository.dispose(opened.sessionId))?.state, "DISPOSED");
          }
          const receipt = committed
            ? await fixture.state.read((view) =>
                view.repositorySessions.findBrokerReceipt(opened.admissionId),
              )
            : undefined;
          if (committed) {
            assert.equal(receipt?.state, "disposed");
            assert.deepEqual(await repositoryAttempts(fixture, candidate), [closing]);
          }
          const callsBeforeRestart = repository.calls.length;
          let successesBeforeCleanup = 0;
          if (mode === "mismatched") {
            events.length = 0;
            await start("built-in", true);
            await advanceCleanupRetries(fixture, candidate);
            await completion(
              events,
              "claimed cleanup to reject the wrong sender",
              (event: Record<string, unknown>) =>
                event.event === "worker.repository-cleanup-warning" &&
                event.workId === cleanupWork.idempotencyKey &&
                event.cause === "REPOSITORY_DRIVER_MISMATCH",
            );
            await completion(
              events,
              "wrong-sender cleanup to remain pending",
              (event: Record<string, unknown>) =>
                event.event === "worker.completed" &&
                event.workId === cleanupWork.idempotencyKey &&
                event.outcome === "pending" &&
                event.code === "REPOSITORY_CLEANUP_PENDING",
            );
            await fixture.stop();
            await fixture.work(cleanupWork, "queued");
            // Joining the Worker waits for the metrics emitted after the claim commits.
            assert.ok(metrics);
            const pending = await metrics.exposition();
            assert.match(pending, pendingMetric, "deferred cleanup must record a pending pass");
            assert.doesNotMatch(pending, errorMetric);
            successesBeforeCleanup = Number(pending.match(successMetric)?.[1] ?? 0);
            assert.equal(repository.calls.length, callsBeforeRestart);
            assert.deepEqual(await repositoryAttempts(fixture, candidate), [closing]);
          }
          events.length = 0;
          await start("built-in", committed);
          await advanceCleanupRetries(fixture, candidate);
          await fixture.work(cleanupWork, "succeeded");
          await fixture.work(stop, "succeeded");
          await fixture.stop();
          if (metrics !== undefined) {
            const completed = await metrics.exposition();
            assert.equal(
              Number(completed.match(successMetric)?.[1] ?? 0),
              successesBeforeCleanup + 1,
              "committed cleanup must add one successful revision pass",
            );
            assert.doesNotMatch(completed, errorMetric);
          }
          const [disposed] = await repositoryAttempts(fixture, candidate);
          assert.equal(disposed?.phase, "disposed");
          assert.equal(disposed.brokerProtocol, 3);
          assert.equal(disposed.admissionId, opened.admissionId);
          assert.equal(disposed.sessionId, opened.sessionId);
          assert.deepEqual(disposed.cleanupContext, closing.cleanupContext);
          assert.deepEqual(
            repository.calls.slice(callsBeforeRestart),
            committed ? [] : [{ operation: "close", sessionId: opened.sessionId }],
          );
          if (committed) {
            assert.deepEqual(
              await fixture.state.read((view) =>
                view.repositorySessions.findBrokerReceipt(opened.admissionId),
              ),
              receipt,
            );
          }
          const persisted = await fixture.state.read((view) =>
            view.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
          );
          assert.deepEqual(persisted?.repositoryCredentials, snapshot);
          assert.equal((await fixture.currentAgent(owner))?.desiredRuntimeState, "stopped");
        },
      );
    }
  },
);

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
    const [, recovered, closed] = repository.calls;
    assert.equal(recovered?.operation, "recover");
    assert.deepEqual(recovered.input, { ...input, recoverOnly: true });
    assert.equal(closed?.operation, "close");
    assert.equal(closed.sessionId, sessionId);
    const [disposed] = await repositoryAttempts(fixture, candidate);
    assert.equal(disposed?.admissionId, attempt.admissionId);
    assert.equal(disposed.sessionId, sessionId);
    assert.equal(disposed.phase, "disposed");
  },
);
