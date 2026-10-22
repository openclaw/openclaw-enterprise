import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "../helpers/postgres-worker-revision-fixture.mjs";
import { requiresPostgres, databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  CredentialGatewayDriver,
  SandboxHarnessObservation,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type { Pool } from "pg";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";

// The worker reaches model withdrawal through Compute. This registration supplies only
// the paired gateway identity; the test does not claim real provider attachment or chat.
function observationGateway(): CredentialGatewayDriver {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected direct gateway effect");
  };
  return {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    implementation: "credential-gateway-worker-fixture",
    capability: "credential_gateway",
    validateSourceConfig() {},
    listSourceTypes: async () => [],
    registerSource: unused,
    updateSource: unused,
    sourceStatus: unused,
    removeSource: unused,
    attachForRevision: unused,
    attachmentStatus: unused,
    withdraw: unused,
  };
}

// Real queue, worker, State and prepared native sender; Compute is a controlled
// observation adapter. This does not prove an OpenShell process or actual chat.
test(
  "standing maintenance supervises missing Git evidence across restart and still withdraws model authority",
  { ...requiresPostgres, timeout: 240_000 },
  async (t) => {
    await ensurePostgresAgentBootstrap(t, {
      label: "standing-worker-missing",
      authSecret: "standing-worker-fixture-auth-secret-32",
    });
    const database = {
      url: databaseUrl!,
      pools: new Set<Pool>(),
      workers: new Set<ControllerWorker>(),
    };
    // Close database pools after broker shutdown has persisted its final receipts.
    t.after(() =>
      t.after(async () => {
        for (const worker of database.workers) {
          await worker.stop();
        }
        for (const pool of database.pools) {
          if (!("ending" in pool && pool.ending)) {
            await pool.end();
          }
        }
      }),
    );
    const setupOptions = { database, leaseDurationMs: 30_000 };
    const f = await createWorkerRevisionFixtures(import.meta.url).setup(t, setupOptions);
    try {
      const credentials = await startRegistryCredentialServiceFixture(t, {
        namespaceId: f.namespace.id,
        autoOpen: false,
        clock: createSystemClock(),
        limits: { exchangeMs: 5_000, credentialMarginMs: 1_000 },
        gateway: { listen: "127.0.0.1:0" },
      });
      assert.ok(credentials);
      const registry = structuredClone(credentials.registry);
      registry.allowStandingApprovals = true;
      for (const r of registry.repositories) {
        for (const p of r.namespaces) {
          p.allowStandingApproval = true;
        }
      }
      const backend = {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
        drivers: { repo: "repository-credentials" },
      };
      const driver = new GitHubRepositoryPolicy(backend, registry, { sessionDurationSeconds: 90 });
      const sender = new GitHubNativeRepositorySender(backend, { publicCa: credentials.tls.ca });
      const receipt = await startRepositoryReceiptServer({
        state: f.state,
        controlSocket: credentials.config.gateway.controlSocket,
        driverId: driver.id,
        implementation: driver.implementation,
        backendId: credentials.backendId,
      });
      t.after(() => receipt.close());
      const owner = await f.agent("standing-runtime", { auth: "credential_source" });
      const modelSourceId =
        owner.harnessAuth?.method === "credential_source" ? owner.harnessAuth.sourceId : undefined;
      const [selected] = driver.resolve({
        namespaceId: f.namespace.id,
        bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
      }).bindings;
      const binding = selected!;
      await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
        JSON.stringify([{ repositoryRef: binding.repositoryRef, profile: binding.profile }]),
        owner.id,
      ]);
      const scope = driver.standingApprovalScope({ namespaceId: f.namespace.id, binding })!;
      const fingerprint = repositoryApprovalFingerprint({
        namespaceId: f.namespace.id,
        agentId: owner.id,
        binding,
        scope,
      });
      const approval = await f.state.transact((u) =>
        u.repositorySessions.approveStanding({
          id: randomUUID(),
          namespaceId: f.namespace.id,
          agentId: owner.id,
          binding,
          scope,
          scopeFingerprint: fingerprint,
          approvedBy: f.actor.id,
          createdAt: new Date().toISOString(),
        }),
      );
      const originalBoundary = Date.now() + 90_000;
      const revisionOptions = {
        actorId: f.actor.id,
        repositoryCredentials: {
          driver: { id: driver.id, implementation: driver.implementation },
          bindings: [binding],
          deadlineWallMs: originalBoundary,
          standingApprovalId: approval.id,
          standingApprovalGeneration: approval.generation,
          standingApprovalScopeFingerprint: fingerprint,
        },
      };
      const revision = await f.revision(owner, 1, revisionOptions);
      const execution = {
        executionId: randomUUID(),
        fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      };
      type Delivered = Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>;
      const deliveries: Delivered[] = [];
      type WorkerEvent = {
        event?: string;
        revisionId?: string;
        code?: string;
        outcome?: string;
        harnessState?: SandboxHarnessObservation["state"];
      };
      const events: WorkerEvent[] = [];
      let created = false;
      let executionCreates = 0;
      let stopped = 0;
      let evidenceMissing = false;
      let prepares = 0;
      let activations = 0;
      let observations = 0;
      let modelWithdrawals = 0;
      let harness: SandboxHarnessObservation = { state: "running" };
      const compute = {
        ...f.compute,
        validateRepositoryCredentials() {},
        async prepareRevision(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          context?: ComputeRevisionContext,
        ) {
          prepares++;
          if (!created) {
            created = true;
            executionCreates++;
          }
          for (const value of context?.repositoryCredentials ?? []) {
            if (value.kind === "new") {
              deliveries.push(value);
            }
          }
          return f.compute.prepareRevision(r);
        },
        async verifyRepositoryExecution(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          return !evidenceMissing && created && r.id === revision.id ? execution : undefined;
        },
        async observeRevision(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          observations++;
          return harness;
        },
        async activateRevision() {
          activations++;
        },
        async withdrawCredentialSource(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          source: { id: string },
        ) {
          assert.equal(r.id, revision.id);
          assert.equal(source.id, modelSourceId);
          modelWithdrawals++;
          return { sourceId: source.id, state: "revoked" as const };
        },
        async retireExpiredRepositoryAccess(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          return "withdrawn" as const;
        },
        async stopRevision(r: Parameters<ComputeDriver["stopRevision"]>[0]) {
          assert.equal(
            r.id,
            revision.id,
            "stopping a different revision cannot change this execution",
          );
          stopped++;
          created = false;
        },
      };
      const start = () =>
        f.start(compute, {
          emit: (e?: WorkerEvent) => {
            if (e) {
              events.push(e);
            }
          },
          transformDrivers: (d: { installation: { drivers: object } }) => {
            const gateway = observationGateway();
            const sandbox = {
              id: "sandbox-worker-fixture",
              capability: "sandbox" as const,
              implementation: "sandbox-worker-fixture",
              facets: ["networking"],
              async cleanup() {},
            };
            return {
              ...d,
              repositoryPolicy: driver,
              nativeRepositorySender: sender,
              credentialGatewayDriver: gateway,
              sandboxDriver: sandbox,
              installation: {
                ...d.installation,
                drivers: {
                  ...d.installation.drivers,
                  sandbox: { id: sandbox.id, configuration: {} },
                  credential_gateway: { id: gateway.id, configuration: {} },
                },
              },
            };
          },
        });
      await start();
      await f.work(revision, "succeeded");
      await waitFor(
        "durable execution observation",
        () =>
          f.state.read((v) =>
            v.repositorySessions.findStandingExecution({
              namespaceId: f.namespace.id,
              agentId: owner.id,
              revisionId: revision.id,
            }),
          ),
        15_000,
      );
      const provider = credentials.repositories[0]!.github;
      assert.ok(modelSourceId);
      // The first observation can precede completion of the claim that schedules maintenance.
      await waitFor("active maintenance established", async () =>
        events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
      );
      await f.stop();
      const before = { prepares, activations, deliveries: deliveries.length };
      const ownerRef = {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        revisionId: revision.id,
      };
      const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
      const key = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
      evidenceMissing = true;
      for (const state of ["running", "unknown"] as const) {
        // The Driver may return fields outside its declared type; they must not enter logs.
        harness = { state, ...{ diagnostic: "driver-only-observation-data" } };
        events.length = 0;
        // Only advance queue due time. Keep the real approval, session, execution and
        // model source unchanged; restart creates a fresh worker and database pool.
        await f.advanceMaintenance(revision);
        await start();
        await waitFor("pending Git evidence observation", async () =>
          events.find(
            (e) => e.revisionId === revision.id && e.code === "REPOSITORY_EXECUTION_UNVERIFIED",
          ),
        );
        await f.stop();
        const pending = await queue.findWork(key);
        assert.equal(pending?.state, "queued");
        assert.equal(pending?.attemptCount, 0, "missing evidence does not spend retry budget");
        assert.ok(pending!.availableAt.getTime() <= Date.now() + 5_000);
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
        assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, before);
        assert.equal(provider.issuesOfTokens.length, 0);
        assert.equal(stopped, 0);
        assert.ok(events.some((e) => e.outcome === "pending" && e.harnessState === state));
        assert.ok(!JSON.stringify(events).includes("driver-only-observation-data"));
        assert.ok(!events.some((e) => e.code === "REVISION_ALREADY_ACTIVE"));
      }
      assert.equal(observations, 2);
      // Genuine evidence recovery may enter ordinary preparation again. It must not be
      // reported by either unknown pass, nor require a replacement Agent execution.
      evidenceMissing = false;
      await f.advanceMaintenance(revision);
      await start();
      await waitFor("verified execution recovered", async () =>
        events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
      );
      await f.stop();
      assert.ok(prepares > before.prepares);
      assert.equal(executionCreates, 1);
      evidenceMissing = true;
      const recoveredPrepares = prepares;
      const recoveredActivations = activations;
      // The normal API records model withdrawal while Git evidence is missing. The next
      // worker must deliver that withdrawal, never prepare the Agent to observe it.
      await f.controller.withdrawAgentCredentialSource(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        credentialSourceId: modelSourceId,
      });
      await f.advanceMaintenance(revision);
      await start();
      await waitFor("model withdrawal acknowledged", async () => {
        const row = await f.state.read((v) =>
          v.credentialSources.findCredentialWithdrawal(f.namespace.id, revision.id, modelSourceId),
        );
        return row?.state === "revoked" ? row : undefined;
      });
      await f.stop();
      assert.ok(modelWithdrawals > 0);
      assert.equal(prepares, recoveredPrepares);
      assert.equal(activations, recoveredActivations);
      assert.equal(provider.issuesOfTokens.length, 0);
    } catch (error) {
      t.diagnostic("registered standing session proof stopped before all assertions completed");
      throw error;
    }
  },
);
