import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  repositoryAttempts,
  repositoryBoundary,
  makeWorkDue,
} from "../helpers/postgres-worker-revision-support.mjs";

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

for (const scenario of [
  "ready",
  "changed material",
  "revoked deployer",
  "deployer revoked during observation",
  "invalidated history",
] as const) {
  test(
    `finite native Git withdrawal: ${scenario}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      let closeNative = async () => {};
      // Broker shutdown writes final receipts; run it before the fixture closes PostgreSQL.
      t.after(() => closeNative());
      const f = await setup(t);
      const credentials = await startRegistryCredentialServiceFixture(t, {
        namespaceId: f.namespace.id,
        autoOpen: false,
        clock: createSystemClock(),
        gateway: {
          listen: "127.0.0.1:0",
          publicOrigin: "https://repository.repository-service.svc",
        },
      });
      assert.ok(credentials);
      closeNative = async () => {
        await f.stop();
        await credentials.close();
      };
      const backend = {
        id: credentials.backendId,
        drivers: { repo: "repository-credentials" },
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
      };
      const policy = new GitHubRepositoryPolicy(
        { driverId: backend.drivers.repo, backendId: backend.id },
        credentials.registry,
        { sessionDurationSeconds: 600 },
      );
      const sender = new GitHubNativeRepositorySender(backend, { publicCa: credentials.tls.ca });
      const receiptServer = await startRepositoryReceiptServer({
        state: f.state,
        controlSocket: credentials.config.gateway.controlSocket,
        driverId: policy.id,
        implementation: policy.implementation,
        backendId: backend.id,
      });
      closeNative = async () => {
        await f.stop();
        await credentials.close();
        await receiptServer.close();
      };
      const owner = await f.agent("finite-native-withdrawal", { executionMode: "dedicated" });
      assert.ok(owner.harnessAuth && "source" in owner.harnessAuth);
      const selected = [{ repositoryRef: "repo-a", profile: "git-write" as const }];
      const binding = policy.resolve({ namespaceId: f.namespace.id, bindings: selected })
        .bindings[0]!;
      const deadlineWallMs = Date.now() + 600_000;
      const runtime = workspaceSetupFixture(
        false,
        true,
        {
          repositoryCredentials: {
            namespace: "repository-service",
            podLabels: { "app.kubernetes.io/component": "worker" },
            port: 8443,
          },
        },
        {},
        { preparedRepositoryIngress: true },
        {
          observedRuntimePods: true,
          revisionOverrides: {
            id: `rev_${randomUUID()}`,
            namespaceId: f.namespace.id,
            agentId: owner.id,
            configurationId: owner.configurationId,
            servicePrincipalId: owner.servicePrincipalId,
            harnessAuth: {
              method: "api_key",
              source: {
                kind: "secret",
                namespaceId: f.namespace.id,
                id: owner.harnessAuth.source.id,
              },
              secretDriverId: f.secretDriver.id,
            },
            repositoryCredentials: {
              driver: { id: policy.id, implementation: policy.implementation },
              bindings: [binding],
              deadlineWallMs,
            },
            createdAt: new Date().toISOString(),
          },
        },
      );
      const { driver: compute, revision } = runtime;
      // Helm owns the initially closed broker ingress policy and its internal Service.
      // Compute must admit this exact Harness through its normal reconciliation path.
      const brokerLabels = { "app.kubernetes.io/component": "worker" };
      await runtime.clients.objects.patch({
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: "repository",
          namespace: "repository-service",
          annotations: {
            "openclaw.dev/repository-credentials-hostname": "repository.repository-service.svc",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: brokerLabels,
          ports: [{ port: 443, targetPort: 8443, protocol: "TCP" }],
        },
      });
      await runtime.clients.objects.patch({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: {
          name: "openclaw-enterprise-prepared-repository-ingress",
          namespace: "repository-service",
        },
        spec: { podSelector: { matchLabels: brokerLabels }, policyTypes: ["Ingress"], ingress: [] },
      });
      const originalKey = `agent_revision:${revision.id}:reconcile`;
      // Seed the admitted, running revision through State and queue transitions. Its native
      // session and Kubernetes workloads below are created by their real implementations.
      await f.state.transactWithQueue(async (unit, queue) => {
        await unit.namespaces.lockNamespace(f.namespace.id);
        await unit.agents.lockAgent(f.namespace.id, owner.id);
        await unit.agents.updateConfiguration(
          f.namespace.id,
          owner.id,
          owner.configurationId,
          undefined,
          undefined,
          undefined,
          undefined,
          selected,
        );
        const admitted = await unit.revisions.createRevision(revision);
        Object.assign(revision, { createdAt: admitted.createdAt });
        await unit.agents.transitionAgentDesiredRuntimeState(
          f.namespace.id,
          owner.id,
          "stopped",
          "running",
        );
        await queue.enqueue({
          idempotencyKey: originalKey,
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
          actorId: f.actor.id,
          availableAt: new Date(0),
        });
      });
      const queue = new f.PostgresWorkQueue(f.observerPool, { leaseDurationMs: 30_000 });
      const claim = await queue.claim();
      assert.ok(claim);
      assert.equal(claim.idempotencyKey, originalKey);
      if (scenario === "invalidated history") {
        // A worker stopped after recording its opening attempt but before sending it.
        // Real broker recovery must retain that missing correlation as terminal uncertainty.
        const prior = await f.state.transact((unit) =>
          unit.repositorySessions.createAttempt({
            namespaceId: f.namespace.id,
            agentId: owner.id,
            revisionId: revision.id,
            repositoryRef: binding.repositoryRef,
            admissionId: `${Date.now()}-${randomUUID()}`,
            durationSeconds: 600,
            deadlineWallMs,
            brokerProtocol: 3,
            createdAt: new Date().toISOString(),
          }),
        );
        const lifecycle = new RepositoryCredentialLifecycle({
          state: f.state,
          queueOptions: { leaseDurationMs: 30_000 },
          nativeSender: sender,
          authorize: async () => assert.fail("recovery must not authorize a new session"),
          effect: async (_claim, operation) => operation(AbortSignal.timeout(5_000)),
        });
        assert.equal(
          (await lifecycle.cleanup(claim, revision, { closeLiveSessions: true })).settled,
          false,
        );
        const [recovered] = await repositoryAttempts(f, revision);
        assert.equal(recovered?.admissionId, prior.admissionId);
        assert.equal(recovered.phase, "invalidated");
        assert.equal(recovered.sessionId, undefined);
      }
      const attempt = await f.state.transact((unit) =>
        unit.repositorySessions.createAttempt({
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
          repositoryRef: binding.repositoryRef,
          admissionId: `${Date.now()}-${randomUUID()}`,
          durationSeconds: 600,
          deadlineWallMs,
          brokerProtocol: 3,
          createdAt: new Date().toISOString(),
        }),
      );
      const opened = await sender.open(
        {
          namespaceId: f.namespace.id,
          admissionId: attempt.admissionId,
          binding,
          durationSeconds: 600,
          deadlineWallMs,
          preparedOnly: true,
        },
        AbortSignal.timeout(5_000),
      );
      assert.equal(opened.kind, "created");
      assert.ok(opened.kind === "created");
      assert.ok(
        await f.state.transact((unit) =>
          unit.repositorySessions.advanceAttempt({
            admissionId: attempt.admissionId,
            expectedPhase: "opening",
            phase: "open",
            sessionId: opened.session.sessionId,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
      runtime.state.ready = true;
      const computeContext = {
        ...runtime.context,
        secretEnvironment: [],
        repositoryCredentials: [
          {
            kind: "new" as const,
            repositoryRef: binding.repositoryRef,
            admissionId: attempt.admissionId,
            sessionId: opened.session.sessionId,
            deadlineWallMs: opened.session.deadlineWallMs,
            files: opened.files,
          },
        ],
      };
      assert.equal((await compute.prepareRevision(revision, computeContext)).ready, true);
      await compute.activateRevision(revision, computeContext);
      await f.state.transactWithQueue(async (unit, work) => {
        await unit.namespaces.lockNamespace(f.namespace.id);
        await unit.agents.lockAgent(f.namespace.id, owner.id);
        assert.ok(
          await unit.agents.compareAndSetActiveRevision(
            f.namespace.id,
            owner.id,
            undefined,
            revision.id,
          ),
        );
        await work.complete(claim);
      });
      const resources = structuredClone([...runtime.objects]);
      const writes = runtime.records.length;

      // Exercise the supported HTTP removal. It must revoke Git while leaving independently
      // authorized inference on its original revision; this fixture does not run a model.
      const auth = await createTestAuthPrincipal({ installationId: f.installation.id });
      const iam = new NativeIAMDriver({
        async loadNativeIAMState() {
          return {
            identities: [auth.seed.principal],
            groups: [],
            memberships: [],
            roles: [...auth.seed.roles],
            bindings: [...auth.seed.bindings],
            restrictions: [],
          };
        },
      });
      const controller = new OpenClawController(f.installation, { state: f.state });
      controller.registerDriver(iam);
      controller.selectDriver(iam.capability, iam.id);
      const app = createFastifyApp({
        controller,
        iamDriver: iam,
        auditSink: new InMemoryAuditSink(),
        auth: auth.auth,
        resolveHarness: () => assert.fail("binding withdrawal must not select a new Harness"),
        development: { enabled: true, installationId: f.installation.id },
      });
      t.after(() => app.close());
      const api = await createAuthenticatedControllerRequest(app, auth);
      const removed = await api("PATCH", `/namespaces/${f.namespace.id}/agents/${owner.id}`, {
        configurationId: owner.configurationId,
        repositoryBindings: [],
      });
      assert.equal(removed.status, 200);
      const removal = { idempotencyKey: repositoryRemovalWorkKey(revision.id) };
      const agentDeployment = [...runtime.objects.entries()].find(
        ([, object]) => object.kind === "Deployment" && object.metadata.name.startsWith("agent-"),
      )!;
      if (scenario === "changed material") {
        // An external replacement changed the mounted generation. Disposal alone cannot
        // prove that this is still the runtime to which the closed session was delivered.
        runtime.objects.set(agentDeployment[0], {
          ...agentDeployment[1],
          metadata: {
            ...agentDeployment[1].metadata,
            annotations: {
              ...agentDeployment[1].metadata.annotations,
              "openclaw.dev/repository-material-generation": "different-generation",
            },
          },
        });
      }
      const revokeDeployer = () =>
        f.observerPool.query("DELETE FROM occ.iam_access_bindings WHERE identity_subject_id=$1", [
          f.actor.id,
        ]);
      if (scenario === "revoked deployer") {
        await revokeDeployer();
      }
      let revokedDuringObservation = false;
      if (scenario === "deployer revoked during observation") {
        // Authority can change while the authenticated node observation is in flight.
        // Keep the real connectivity result; change only the actual persisted IAM grant.
        const connected = compute.nodeEnrollment.isConnected.bind(compute.nodeEnrollment);
        compute.nodeEnrollment.isConnected = async (...args: Parameters<typeof connected>) => {
          await revokeDeployer();
          revokedDuringObservation = true;
          return connected(...args);
        };
      }
      const events: { code?: unknown; revisionId?: unknown }[] = [];
      const start = () =>
        f.start(compute, {
          emit: (event) => {
            if (event) {
              events.push(event);
            }
          },
          transformDrivers: (drivers: InstallationRuntimeDrivers): InstallationRuntimeDrivers => ({
            ...drivers,
            repositoryPolicy: policy,
            nativeRepositorySender: sender,
            observeRepositoryWithdrawal: (selectedRevision, disposedSessions, signal) =>
              compute.observeRepositoryWithdrawal(selectedRevision, disposedSessions, signal),
          }),
        });
      await start();
      if (scenario === "changed material" || scenario === "invalidated history") {
        await waitFor("native withdrawal remains unverified", async () =>
          events.find(
            (event) =>
              event.revisionId === revision.id && event.code === "REPOSITORY_CLEANUP_PENDING",
          ),
        );
        await f.stop();
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
        assert.equal(
          runtime.records.length,
          writes,
          "unknown evidence cannot prepare or retire the runtime",
        );
        assert.ok(!events.some((event) => event.code === "REPOSITORY_ACCESS_WITHDRAWN"));
        if (scenario === "invalidated history") {
          const attempts = await repositoryAttempts(f, revision);
          assert.equal(attempts.length, 2);
          assert.ok(attempts.some((attempt: { phase: string }) => attempt.phase === "invalidated"));
          assert.ok(attempts.some((attempt: { phase: string }) => attempt.phase === "disposed"));
          assert.deepEqual([...runtime.objects], resources);
          return;
        }
        runtime.objects.set(...agentDeployment);
        // A new worker must recover from durable disposal evidence without reopening Git.
        await makeWorkDue(f.observerPool, { state: "queued", key: removal.idempotencyKey });
        await start();
      }
      await f.work(removal, "succeeded");
      await f.stop();
      const result = await f.workResult(removal);
      if (scenario === "revoked deployer" || scenario === "deployer revoked during observation") {
        if (scenario === "deployer revoked during observation") {
          assert.equal(revokedDuringObservation, true);
        }
        assert.equal(result.rows[0]?.reason_code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
        assert.ok(!events.some((event) => event.code === "REPOSITORY_ACCESS_WITHDRAWN"));
        return;
      }
      assert.equal(result.rows[0]?.reason_code, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      const attempts = await repositoryAttempts(f, revision);
      assert.equal(attempts.length, 1, "withdrawal never admits a replacement session");
      assert.equal(attempts[0]?.phase, "disposed");
      assert.equal(
        (await sender.status(opened.session.sessionId, AbortSignal.timeout(5_000)))?.state,
        "DISPOSED",
      );
      assert.deepEqual(
        [...runtime.objects],
        resources,
        "withdrawal preserves workload identities and settings",
      );
      assert.equal(
        runtime.records.length,
        writes,
        "withdrawal does not prepare or replace the runtime",
      );
      assert.equal(credentials.repositories[0].github.issuesOfTokens.length, 0);
    },
  );
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
