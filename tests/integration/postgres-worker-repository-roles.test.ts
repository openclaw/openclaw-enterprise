import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { OpenClawController, validateRepositoryAdmission } from "../../packages/occ/src/index.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
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

const repositoryRoleFailure = {
  id: "has the wrong id",
  implementation: "has the wrong implementation",
  absent: "is absent",
  substituted: "is substituted with an unsealed runtime",
} as const;

for (const [role, fields] of [
  ["repositoryAdmission", ["id", "implementation", "absent", "substituted"]],
  ["nativeRepositorySender", ["id", "implementation", "absent"]],
] as const) {
  for (const field of fields) {
    test(
      `worker refuses repository credentials when ${role} ${repositoryRoleFailure[field]}`,
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
        const start = () =>
          fixture.start(
            {
              ...fixture.compute,
              async prepareRevision(...args: Parameters<typeof fixture.compute.prepareRevision>) {
                preparations++;
                return fixture.compute.prepareRevision(...args);
              },
            },
            {
              transformDrivers(drivers: InstallationRuntimeDrivers) {
                const { admission: repositoryAdmission, nativeSender: nativeRepositorySender } =
                  drivers.repositoryRuntime!;
                assert.ok(repositoryAdmission && nativeRepositorySender);
                const { policy } = repositoryAdmission;
                assert.equal("open" in policy, false);
                assert.equal("resolveBindings" in nativeRepositorySender, false);
                if (field === "absent") {
                  const { repositoryRuntime: _runtime, ...others } = drivers;
                  if (role === "repositoryAdmission") {
                    return others;
                  }
                  const { repository: _repository, ...installation } = others.installation;
                  return {
                    ...others,
                    installation: {
                      ...installation,
                      backend: (installation.backend ?? []).filter(
                        (backend) => backend.type !== "github",
                      ),
                    },
                  };
                }
                const identityChange = { [field]: `unselected-${field}` };
                const observedPolicy = {
                  ...policy,
                  resolveBindings(input: Parameters<typeof policy.resolveBindings>[0]) {
                    policyChecks++;
                    return policy.resolveBindings(input);
                  },
                };
                if (role === "repositoryAdmission") {
                  return {
                    ...drivers,
                    repositoryRuntime: {
                      ...drivers.repositoryRuntime,
                      admission: {
                        ...repositoryAdmission,
                        policy:
                          field === "substituted"
                            ? observedPolicy
                            : Object.assign(observedPolicy, identityChange),
                      },
                    },
                  };
                }
                // Simulate a sender whose reported identity no longer matches its receipt owner.
                Object.assign(nativeRepositorySender, identityChange);
                return drivers;
              },
            },
          );
        if (role === "repositoryAdmission") {
          await assert.rejects(
            async () => start(),
            /built-in repository admission|selected repository runtime/,
          );
          assert.equal(policyChecks, 0);
          assert.deepEqual(repository.calls, []);
          assert.deepEqual(await repositoryAttempts(fixture, candidate), []);
          assert.equal(preparations, 0);
          return;
        }
        await start();
        const work = await fixture.work(candidate, "failed_permanent", 15_000);
        assert.equal(work.attempt_count, 1);
        assert.equal(
          (await fixture.workResult(candidate)).rows[0]?.reason_code,
          "REPOSITORY_DRIVER_MISMATCH",
        );
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
    for (const mode of ["bound", "retired-role", "retired-mode"] as const) {
      await t.test(mode, async (context) => {
        const repository = repositoryBoundary({ sessionDurationSeconds: 300 });
        const fixture = await setup(context, { repoDriver: repository.driver });
        const admission = fixture.repositoryAdmission;
        assert.ok(admission);
        const policy = admission.policy;
        const input = {
          namespaceId: fixture.namespace.id,
          bindings: [
            { repositoryRef: repository.snapshot.bindings[0]!.repositoryRef, profile: "git-read" },
          ],
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
              if (mode === "retired-role") {
                return { ...drivers, repositoryPolicy: policy };
              }
              if (mode === "retired-mode") {
                const runtime = drivers.repositoryRuntime!;
                return {
                  ...drivers,
                  repositoryRuntime: {
                    ...runtime,
                    admission: { ...runtime.admission, policyMode: "built-in" },
                  },
                };
              }
              return drivers;
            },
          });
        if (mode !== "bound") {
          await assert.rejects(async () => start(), {
            name: "Error",
            message:
              mode === "retired-role"
                ? "Repository Driver selection and policy modes are retired."
                : "Startup requires the selected repository runtime and its delivery Drivers.",
          });
          assert.equal(provisioning.mock.callCount(), 0);
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
        const prepared = await completion(
          preparations,
          "the original finite repository revision to reach Compute",
          (args: Parameters<ComputeDriver["prepareRevision"]>) => args[0].id === candidate.id,
        );
        await fixture.stop();
        assert.deepEqual(prepared[0].repositoryCredentials, snapshot);
        assert.ok(prepared[1]);
        assert.ok(prepared[1].repositoryCredentials);
        const opened = repository.calls.filter(({ operation }) => operation === "open");
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
  policy: NonNullable<InstallationRuntimeDrivers["repositoryRuntime"]>["admission"]["policy"],
) {
  // Seed only ordinary resources; the actual Worker controller saves and admits them.
  const owner = await fixture.agent("legacy-repository-restart");
  const configuration = await legacy.createConfiguration(fixture.actor.id, {
    namespaceId: fixture.namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("openclaw", "gpt-4.1"),
  });
  const bindings = [
    { repositoryRef: repository.snapshot.bindings[0]!.repositoryRef, profile: "git-read" },
  ];
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
  const originalOpen = repository.calls.find(({ operation }) => operation === "open");
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
    assert.equal(typeof pending.workId, "string");
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
    assert.equal(closing.phase, "closing");
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
  "Worker restart settles retained admission through the original repository sender",
  requiresPostgres,
  async (t) => {
    for (const wrongSender of [false, true]) {
      await t.test(
        wrongSender ? "wrong sender then original sender" : "original sender",
        async (context) => {
          const repository = repositoryBoundary({ sessionDurationSeconds: 300 });
          const fixture = await setup(context, { repoDriver: repository.driver });
          const admissionBinding = fixture.repositoryAdmission;
          assert.ok(admissionBinding);
          const policy = admissionBinding.policy;
          const provisioning = context.mock.method(OpenClawController, "forInstallation");
          const events: Record<string, unknown>[] = [];
          async function start(mismatchedSender = false) {
            const originalId = repository.driver.id;
            try {
              if (mismatchedSender) {
                repository.driver.id = "replacement-sender";
              }
              await fixture.start(fixture.compute, {
                emit: (event: Record<string, unknown>) => events.push(event),
              });
            } finally {
              repository.driver.id = originalId;
            }
            const controller = provisioning.mock.calls.at(-1)!.result;
            assert.ok(controller);
            await controller.validateBackendConfiguration();
            return controller;
          }
          const legacy = await start();
          const admission = await admitLegacyRepositorySession(fixture, repository, legacy, policy);
          const { owner, revision, candidate, snapshot, opened } = admission;
          const { stop, cleanupWork, closing } = await deferLegacyRepositoryCleanup(
            fixture,
            repository,
            admission,
            events,
          );
          const callsBeforeRestart = repository.calls.length;
          if (wrongSender) {
            events.length = 0;
            await start(true);
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
            assert.equal(repository.calls.length, callsBeforeRestart);
            assert.deepEqual(await repositoryAttempts(fixture, candidate), [closing]);
          }
          events.length = 0;
          await start();
          await advanceCleanupRetries(fixture, candidate);
          await fixture.work(cleanupWork, "succeeded");
          await fixture.work(stop, "succeeded");
          await fixture.stop();
          const [disposed] = await repositoryAttempts(fixture, candidate);
          assert.equal(disposed.phase, "disposed");
          assert.equal(disposed.brokerProtocol, 3);
          assert.equal(disposed.admissionId, opened.admissionId);
          assert.equal(disposed.sessionId, opened.sessionId);
          assert.deepEqual(disposed.cleanupContext, closing.cleanupContext);
          assert.deepEqual(repository.calls.slice(callsBeforeRestart), [
            { operation: "close", sessionId: opened.sessionId },
          ]);
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
  "live repository lifecycle refuses resolution identity drift and cleanup uses the persisted owner",
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
    const revision = await fixture.state.read((view) =>
      view.revisions.findRevision(candidate.namespaceId, candidate.agentId, candidate.id),
    );
    assert.ok(revision);
    const admission = fixture.repositoryAdmission;
    assert.ok(admission);
    // Exercise the lifecycle directly: startup correctly refuses substituted runtimes
    // before their resolver can run. Delegate resolution to the real selected policy.
    const authorizationReached = new Error("original owner reached authorization");
    for (const field of [undefined, "id", "implementation"] as const) {
      let resolutions = 0;
      const policy = {
        id: String(admission.policy.id),
        implementation: String(admission.policy.implementation),
        listCatalog: admission.policy.listCatalog.bind(admission.policy),
        allowsStandingApproval: admission.policy.allowsStandingApproval.bind(admission.policy),
        standingApprovalScope: admission.policy.standingApprovalScope.bind(admission.policy),
        resolveBindings(input: Parameters<typeof admission.policy.resolveBindings>[0]) {
          const resolved = admission.policy.resolveBindings(input);
          resolutions++;
          if (field !== undefined) {
            policy[field] = `changed-${field}`;
          }
          return resolved;
        },
      };
      const validated = validateRepositoryAdmission({ ...admission, policy }, [
        {
          id: admission.backendId,
          type: "github",
          configuration: { registryPath: "/unused/registry.json" },
        },
      ]);
      assert.ok(validated);
      assert.equal(validated.hasCurrentIdentity(), true);
      const lifecycle = new RepositoryCredentialLifecycle({
        state: fixture.state,
        queueOptions,
        repository: validated,
        nativeSender: {
          ...repository.driver,
          durableBrokerReceipts: true,
          async open() {
            assert.fail("resolution control must not open a session");
          },
        },
        authorize: async () => {
          throw authorizationReached;
        },
        effect: async () => assert.fail("identity drift must precede sender effects"),
      });
      await assert.rejects(
        lifecycle.prepare(claim, revision),
        field === undefined
          ? (error) => error === authorizationReached
          : { code: "REPOSITORY_DRIVER_MISMATCH" },
      );
      assert.equal(resolutions, 1);
      assert.equal(validated.hasCurrentIdentity(), field === undefined);
      assert.deepEqual(repository.calls, []);
      assert.deepEqual(await repositoryAttempts(fixture, candidate), []);
    }
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
