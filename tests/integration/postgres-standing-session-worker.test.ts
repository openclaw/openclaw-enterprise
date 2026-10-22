import assert from "node:assert/strict";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  observationGateway,
  setupStandingWorkerAuthority,
  setupStandingWorkerDatabase,
} from "../helpers/postgres-standing-worker-fixture.ts";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  SandboxHarnessObservation,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";

// Real queue, worker, State and prepared native sender; Compute is a controlled
// observation adapter. This does not prove an OpenShell process or actual chat.
test(
  "standing maintenance supervises missing Git evidence across restart and still withdraws model authority",
  { ...requiresPostgres, timeout: 240_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    try {
      const { credentials, driver, sender, owner, modelSourceId, revision, execution } =
        await setupStandingWorkerAuthority(t, f);
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
