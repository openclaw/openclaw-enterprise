import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  EgressInstallation,
} from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState, type OpenClawController } from "../../packages/occ/src/index.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ComputeStopYieldedError } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createBackendWorkerDrivers } from "../helpers/postgres-backend-state.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres, databaseUrl } from "../helpers/postgres-database.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { makeWorkDue } from "../helpers/postgres-worker-revision-support.mjs";
import { denyDeploy } from "../helpers/postgres-worker-refused-candidate.ts";
import { waitFor } from "../helpers/wait-for.ts";

for (const scenario of ["retained", "separate", "explicit Stop", "refused replacement"] as const) {
  const retained = scenario !== "separate";
  const stopDuringCompletion = scenario === "explicit Stop";
  const finishRefusedReplacement = scenario === "refused replacement";
  test(
    scenario === "retained" || scenario === "separate"
      ? `worker replaces protected enrollment with ${retained ? "a retained Sandbox" : "separate Sandboxes"} (PostgreSQL)`
      : stopDuringCompletion
        ? "explicit Stop retains protected enrollment until a yielded drain resumes and stops (PostgreSQL)"
        : "a refused replacement retires protected predecessor enrollment after its full drain (PostgreSQL)",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      let app!: Awaited<ReturnType<typeof postgresApp>>;
      const f = await staticEgressFixture(t, {
        recordInstallation: false,
        appFactory: async (context: TestContext, options = {}) => {
          const configured = "computeDriver" in options ? options.computeDriver : undefined;
          const admissionCompute =
            configured !== null && typeof configured === "object" ? configured : undefined;
          assert.ok(!stopDuringCompletion || admissionCompute, "missing deployment Compute");
          app = await postgresApp(context, {
            ...options,
            recordOperations: true,
            ...(stopDuringCompletion && {
              // The normal Deploy admission records the pre-stop boundary for exclusive Compute.
              computeDriver: {
                ...admissionCompute,
                requiresStoppedPredecessors: () => true,
              },
            }),
          });
          return app;
        },
      });
      assert.ok("installation" in f && "revision" in f);
      const receipts = new Map<string, EgressInstallation>();
      const contexts = new Map<string, ComputeRevisionContext>();
      const events: Readonly<Record<string, unknown>>[] = [];
      const preparations = new Set<string>();
      const stopped = new Set<string>();
      const retryStop = Promise.withResolvers<void>();
      let failStop = false;
      let predecessorStops = 0;
      // Compute simulates runtime observations; the real worker, API and PostgreSQL own
      // admission, enrollment custody, activation and retirement. This is not OpenShell proof.
      const compute: ComputeDriver = {
        ...app.controller.selectedDriver("compute"),
        requiresStoppedPredecessors: () => retained,
        ...(stopDuringCompletion && {
          canWaitForPredecessorCompletion: () => true,
          waitForPredecessorCompletion: async () => "waiting" as const,
        }),
        async prepareRevision(revision, context) {
          assert.ok(context?.recordEgressInstallation);
          assert.ok(revision.egressPlan);
          preparations.add(revision.id);
          contexts.set(revision.id, context);
          let receipt = receipts.get(revision.id);
          if (!receipt) {
            receipt = {
              ...f.installation,
              sandboxId:
                revision.id === f.revision.id || (retained && revision.agentId === f.agent.id)
                  ? f.installation.sandboxId
                  : randomUUID(),
              plan: revision.egressPlan,
              enforcement: {
                ...f.installation.enforcement,
                instanceId:
                  revision.id === f.revision.id
                    ? f.installation.enforcement.instanceId
                    : randomUUID(),
              },
            };
            receipts.set(revision.id, receipt);
          }
          if (revision.agentId === f.agent.id && revision.id !== f.revision.id) {
            const predecessor = await current(f.installation);
            assert.equal(
              predecessor?.plan.execution.revisionId,
              retained ? undefined : f.revision.id,
              "reuse requires retirement; separate Sandboxes may overlap before activation",
            );
          }
          await context.recordEgressInstallation(receipt);
          await context.recordEgressInstallation({
            ...receipt,
            installedAt: new Date().toISOString(),
          });
          return {
            namespaceId: revision.namespaceId,
            agentId: revision.agentId,
            revisionId: revision.id,
            ready: true,
          };
        },
        async stopRevision(revision) {
          if ((stopDuringCompletion || finishRefusedReplacement) && revision.id === f.revision.id) {
            predecessorStops += 1;
            if (predecessorStops === 1) {
              if (finishRefusedReplacement) {
                // The next deployment pass is refused before its usual predecessor sweep.
                await denyDeploy({ observerPool: app.pool, namespace: f.namespace }, f.agent);
              }
              throw new ComputeStopYieldedError("predecessor drain yielded");
            }
            await retryStop.promise;
          }
          if (failStop) {
            throw new Error("Simulated stop failure");
          }
          stopped.add(revision.id);
        },
        async retireRevision() {},
      };
      const base = createBackendWorkerDrivers(compute, [], {
        secretDriver: app.controller.selectedDriver("secret"),
      }) as unknown as InstallationRuntimeDrivers;
      const gateway = app.controller.selectedDriver("credential_gateway");
      const drivers = {
        ...base,
        installation: {
          ...base.installation,
          drivers: {
            ...base.installation.drivers,
            configuration: {
              id: app.controller.selectedDriver("configuration").id,
            },
            sandbox: {
              id: f.sandboxDriver.id,
              implementation: f.sandboxDriver.implementation,
              configuration: {},
              definition: OpenShellSandboxDriver,
            },
            credential_gateway: { id: gateway.id },
          },
        },
        configurationDriver: app.controller.selectedDriver("configuration"),
        sandboxDriver: f.sandboxDriver,
        namespaceLifecycleBindings: [
          sandboxNamespaceLifecycleBinding(compute, f.sandboxDriver, f.installedDriver),
        ],
        credentialGatewayDriver: gateway,
        proxyDriver: f.egress,
        protectedDriver: f.installedDriver,
      };
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
      const worker = createControllerWorker({
        pool,
        drivers: drivers as unknown as InstallationRuntimeDrivers,
        pollIntervalMs: 15,
        leaseDurationMs: 5_000,
        emit: (event) => events.push(event),
      });
      t.after(() => worker.stop());
      const current = (receipt: EgressInstallation) =>
        app.state.read((view) =>
          view.credentialSources.findEgressInstallation(receipt.sender.id, receipt.sandboxId),
        );
      const completed = (id: string) =>
        waitFor(
          "revision enrollment and activation",
          async () => {
            const event = events.find(
              (event) =>
                event.event === "worker.completed" &&
                event.revisionId === id &&
                (event.outcome === "success" || event.outcome === "permanent"),
            );
            if (event) {
              assert.equal(event.outcome, "success", JSON.stringify(event));
            }
            return event;
          },
          20_000,
        ).catch((error) => {
          t.diagnostic(
            JSON.stringify(
              events
                .filter((event) => event.revisionId === id)
                .map(({ event, outcome, code, step }) => ({
                  event,
                  outcome,
                  code,
                  step,
                })),
            ),
          );
          throw error;
        });
      const waitForEvent = (description: string, match: Record<string, unknown>) =>
        waitFor(
          () =>
            `${description} (observed ${JSON.stringify(
              events.map(({ event, outcome, code }) => ({ event, outcome, code })),
            )})`,
          () =>
            events.find(
              (event) =>
                event.event === "worker.completed" &&
                Object.entries(match).every(([key, value]) => event[key] === value),
            ),
        );
      await worker.start();
      await completed(f.revision.id);
      const old = receipts.get(f.revision.id)!;
      assert.deepEqual(await current(old), old);
      const captured = f.capture();
      const ready = (await f.resolve(captured)).ready;
      assert.ok(ready, "the current receipt must authorize credential selection");

      if (stopDuringCompletion) {
        assert.ok(f.source);
        const namespacePath = `/namespaces/${f.namespace.id}`;
        const unrelated = await app.request("POST", `${namespacePath}/agents`, {
          body: {
            name: "unrelated-agent",
            configurationId: f.agent.configurationId,
            executionMode: "dedicated",
            harnessAuth: { method: "credential_source", sourceId: f.source.id },
            credentialSources: [{ sourceId: f.source.id }],
          },
        });
        assert.equal(unrelated.status, 201);
        const role = await app.request("POST", `${namespacePath}/iam/roles`, {
          body: {
            name: "unrelated-inference-use",
            permissions: [{ action: "operate", resourceKind: "credential_source" }],
          },
        });
        assert.equal(role.status, 201);
        const unrelatedGrant = await app.request("POST", `${namespacePath}/iam/access-bindings`, {
          body: {
            subjectKind: "identity",
            subjectId: unrelated.data.servicePrincipalId,
            roleId: role.data.id,
            resourceKind: "credential_source",
            resourceId: f.source.id,
          },
        });
        assert.equal(unrelatedGrant.status, 201);
        const unrelatedRevision = await app.deployAgent(f.namespace.id, unrelated.data.id);
        await completed(unrelatedRevision.id);
        const unrelatedReceipt = receipts.get(unrelatedRevision.id)!;
        assert.deepEqual(await current(unrelatedReceipt), unrelatedReceipt);

        const candidate = await app.deployAgent(f.namespace.id, f.agent.id);
        try {
          await waitForEvent("committed completion deferral before Stop", {
            revisionId: candidate.id,
            outcome: "pending",
            code: "PREDECESSOR_COMPLETION_WAITING",
          });
          assert.deepEqual(await current(old), old, "completion waiting keeps enrollment current");
          assert.equal(
            predecessorStops,
            0,
            "completion waiting must leave the predecessor running",
          );

          await app.controller.stopAgent(app.principal.id, f.namespace.id, f.agent.id);
          await waitForEvent("committed Stop yield", {
            agentId: f.agent.id,
            revisionId: f.revision.id,
            outcome: "pending",
            code: "AGENT_STOP_YIELDED",
          });
          assert.deepEqual(await current(old), old, "a yielded stop cannot retire enrollment");
          assert.equal(preparations.has(candidate.id), false);
        } finally {
          retryStop.resolve();
        }
        await waitForEvent("confirmed Stop", {
          agentId: f.agent.id,
          revisionId: f.revision.id,
          outcome: "success",
          code: "AGENT_STOPPED",
        });
        assert.equal(predecessorStops, 2);
        assert.ok(stopped.has(f.revision.id));
        assert.equal(
          await current(old),
          undefined,
          "confirmed Stop retires predecessor enrollment",
        );
        assert.deepEqual(
          await app.state.read((view) =>
            view.credentialSources.findRevisionEgressInstallation(f.namespace.id, f.revision.id),
          ),
          old,
          "retirement retains the predecessor's historical receipt",
        );
        await waitForEvent("stopped Agent's candidate reaches its terminal Work result", {
          workId: `agent_revision:${candidate.id}:reconcile`,
          outcome: "success",
        });
        assert.equal(preparations.has(candidate.id), false);
        const stoppedAgent = await app.state.read((view) =>
          view.agents.findAgent(f.namespace.id, f.agent.id),
        );
        assert.equal(stoppedAgent?.desiredRuntimeState, "stopped");
        assert.equal(stoppedAgent?.activeRevisionId, undefined);
        assert.equal(stopped.has(unrelatedRevision.id), false);
        assert.deepEqual(await current(unrelatedReceipt), unrelatedReceipt);
        const stillActive = await app.state.read((view) =>
          view.agents.findAgent(f.namespace.id, unrelated.data.id),
        );
        assert.equal(stillActive?.activeRevisionId, unrelatedRevision.id);
        assert.equal(stillActive?.desiredRuntimeState, "running");
        return;
      }

      if (finishRefusedReplacement) {
        const candidate = await app.deployAgent(f.namespace.id, f.agent.id);
        try {
          await waitForEvent("replacement yielded its predecessor stop", {
            revisionId: candidate.id,
            outcome: "pending",
            code: "PREDECESSOR_STOP_YIELDED",
          });
          assert.deepEqual(await current(old), old, "yielded replacement retains enrollment");
          assert.equal(preparations.has(candidate.id), false);
          await makeWorkDue(app.pool, `agent_revision:${candidate.id}:reconcile`);
          await waitFor("refusal resumes the predecessor drain", () =>
            predecessorStops === 2 ? true : undefined,
          );
          assert.deepEqual(await current(old), old, "full drain is still awaiting confirmation");
        } finally {
          retryStop.resolve();
        }
        await waitForEvent("replacement refusal after predecessor drain", {
          revisionId: candidate.id,
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
        });
        assert.ok(stopped.has(f.revision.id));
        assert.equal(await current(old), undefined, "confirmed full drain retires enrollment");
        assert.equal(preparations.has(candidate.id), false);
        return;
      }

      failStop = retained;
      const nextMetadata = await app.deployAgent(f.namespace.id, f.agent.id);
      if (retained) {
        await waitFor("failed predecessor stop", async () =>
          events.find(
            (event) =>
              event.event === "worker.completed" &&
              event.revisionId === nextMetadata.id &&
              event.outcome === "retry",
          ),
        );
        assert.deepEqual(
          await current(old),
          old,
          "an unconfirmed stop must not release enrollment",
        );
        assert.equal(receipts.has(nextMetadata.id), false);
        const candidate = await app.state.read((view) =>
          view.revisions.findRevision(f.namespace.id, f.agent.id, nextMetadata.id),
        );
        assert.ok(candidate?.egressPlan);
        // The storage constraint itself must also refuse two current enrollments.
        await assert.rejects(
          app.state.transact((unit) =>
            unit.credentialSources.recordEgressInstallation({
              ...old,
              plan: candidate.egressPlan!,
            }),
          ),
          { name: "ResourceStateConflictError" },
        );
        failStop = false;
        await makeWorkDue(app.pool, `agent_revision:${nextMetadata.id}:reconcile`);
      }
      await completed(nextMetadata.id);
      const next = receipts.get(nextMetadata.id)!;
      const restarted = new PostgresPlatformState(app.pool);
      assert.deepEqual(
        await restarted.read((view) =>
          view.credentialSources.findEgressInstallation(next.sender.id, next.sandboxId),
        ),
        next,
      );
      assert.deepEqual(
        await restarted.read((view) =>
          view.credentialSources.findRevisionEgressInstallation(f.namespace.id, f.revision.id),
        ),
        old,
        "retirement preserves revision-owned evidence",
      );
      assert.equal(
        (await current(old))?.plan.execution.revisionId,
        retained ? nextMetadata.id : undefined,
      );

      // A delayed callback and repeated predecessor cleanup cannot restore old authority or
      // retire the successor, even when both receipts name the same Sandbox.
      await assert.rejects(contexts.get(f.revision.id)!.recordEgressInstallation!(old), {
        message: "Egress receipt does not match the current admitted policy.",
      });
      await app.state.transact((unit) =>
        unit.credentialSources.retireEgressInstallation(f.namespace.id, f.revision.id),
      );
      await assert.rejects(
        app.state.transact((unit) => unit.credentialSources.recordEgressInstallation(old)),
        { name: "ResourceStateConflictError" },
      );
      assert.deepEqual(await current(next), next);
      assert.ok(
        (await f.authorize(f.permitRequest(captured, ready))).refused,
        "a request captured before replacement cannot use the retired receipt",
      );
      assert.equal(await contexts.get(f.revision.id)!.currentEgressInstallation!(), undefined);
      assert.deepEqual(await contexts.get(nextMetadata.id)!.currentEgressInstallation!(), next);
    },
  );
}

test("memory enrollment custody permits replacement only after retiring the predecessor", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("installation" in f && "revision" in f);
  const controller: OpenClawController = f.controller;
  const nextMetadata = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, nextMetadata.id),
  );
  assert.ok(revision?.egressPlan);
  // Supplier receipts are controlled here; the supported API admits both revision plans.
  const next = { ...f.installation, plan: revision.egressPlan };
  const record = (receipt: EgressInstallation) =>
    controller.transact((unit) => unit.credentialSources.recordEgressInstallation(receipt));
  await assert.rejects(record(next), { name: "ResourceStateConflictError" });
  await controller.transact((unit) =>
    unit.credentialSources.retireEgressInstallation(f.namespace.id, f.revision.id),
  );
  await record(next);
  await assert.rejects(record(f.installation), {
    name: "ResourceStateConflictError",
  });
  assert.deepEqual(
    await controller.transact((unit) =>
      unit.credentialSources.findEgressInstallation(next.sender.id, next.sandboxId),
    ),
    next,
  );
  assert.deepEqual(
    await controller.transact((unit) =>
      unit.credentialSources.findRevisionEgressInstallation(f.namespace.id, f.revision.id),
    ),
    f.installation,
  );
});
