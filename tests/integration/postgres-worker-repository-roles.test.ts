import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type {
  ComputeDriver,
  GitHubRepositoryCredentialBackendDefinition,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  completion,
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
        const policy = new GitHubRepositoryPolicy(
          { driverId: repository.driver.id, backendId: backend.id },
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
                    namespaceId: fixture.namespace.id,
                    profiles: ["git-read"],
                  },
                ],
              },
            ],
          }),
          { sessionDurationSeconds: 300 },
        );
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
                  ...(mode === "built-in" || mode === "conflicting"
                    ? { policyMode: "built-in" as const }
                    : {}),
                },
                ...(mode === "legacy" ? { repositoryPolicy: policy } : {}),
                // Same ID, different object: the public policy must not be ignored.
                ...(mode === "conflicting" ? { repositoryPolicy } : {}),
              };
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
        assert.ok(prepared[1].repositoryCredentials);
        assert.ok(
          checks.mock.callCount() > 0,
          "the bound native policy rechecked current permission",
        );
        for (const call of checks.mock.calls) {
          assert.deepEqual(call.arguments, [input]);
        }
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
    assert.deepEqual(repository.calls[1]?.input, { ...input, recoverOnly: true });
    assert.equal(repository.calls[2]?.sessionId, sessionId);
    const [disposed] = await repositoryAttempts(fixture, candidate);
    assert.equal(disposed?.admissionId, attempt.admissionId);
    assert.equal(disposed.sessionId, sessionId);
    assert.equal(disposed.phase, "disposed");
  },
);
