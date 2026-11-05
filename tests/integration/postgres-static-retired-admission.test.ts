import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  InstalledDriver,
  OpenClawController,
  PostgresWorkQueue,
  type DriverConfigurationRegistration,
} from "../../packages/occ/src/index.ts";
import { createBackendWorkerDrivers } from "../helpers/postgres-backend-state.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const refusal =
  "The selected Driver has retired new uses of this protected static credential provider.";

test(
  "a fresh retired owner preserves admitted state but refuses re-admission and deploy",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    let registrations: readonly DriverConfigurationRegistration[] | undefined;
    let bootstrapJobs: readonly { idempotency_key: string }[] = [];
    let application: Awaited<ReturnType<typeof postgresApp>> | undefined;
    const f = await staticEgressFixture(t, {
      appFactory: async (
        context,
        options?: { readonly driverConfigurations?: readonly DriverConfigurationRegistration[] },
      ) => {
        assert.ok(options);
        registrations = options.driverConfigurations;
        application = await postgresApp(context, {
          ...options,
          recordOperations: true,
        });
        // Capture only work created by the normal bootstrap in this disposable database.
        bootstrapJobs = (
          await application.pool.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM occ.controller_work
           WHERE state IN ('queued', 'claimed') ORDER BY idempotency_key`,
          )
        ).rows;
        assert.ok(bootstrapJobs.length <= 1);
        assert.ok(
          bootstrapJobs.every(({ idempotency_key }) =>
            /^namespace:ns_[0-9a-f-]+:reconcile:ready$/.test(idempotency_key),
          ),
        );
        return application;
      },
    });
    assert.ok(application);
    const registered = registrations;
    assert.ok(registered);
    const p = application;
    assert.equal(p.controller, f.controller);
    const sandbox = f.controller.selectedDriver("sandbox");
    const proxy = f.controller.selectedDriver("credential_proxy");
    assert.equal(sandbox, f.installedDriver.require("sandbox"));
    assert.equal(proxy, f.installedDriver.require("credential_proxy"));

    // Resolve the catalog ref so the unmarked baseline reaches a behavioral failure.
    const openAi = proxy.sourceControl.providers.find(
      (entry) => entry.sourceType.type === "openai",
    );
    assert.ok(openAi);
    const openAiStaticProviderRef = openAi.ref;
    assert.deepEqual(openAiStaticProviderRef, {
      id: "openai-static-https",
      generation: 3,
    });
    const originalControl = proxy.sourceControl;
    const originalAvailability = originalControl.assertAvailable;
    const originalBackend = originalControl.backend;

    const installation = await p.state.loadInstallation();
    assert.ok(installation);
    const consent = { adoption: "live", authorityScope: "execution" };
    const replacement = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
      body: {
        name: "readmission-replacement",
        value: "synthetic-key-replacement",
      },
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    const secretUpdate = { secrets: { api_key: replacement.data.ref } };

    const created = await f.request("POST", f.path, {
      body: {
        name: "fresh-owner-unbound-control",
        type: "openai",
        config: { authorized_base_url: f.modelProvider.baseUrl },
        secrets: { api_key: f.secret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const unboundId: unknown = created.data.id;
    assert.ok(typeof unboundId === "string");
    assert.equal(
      await p.state.transact((view) =>
        view.credentialSources.hasReferences(f.namespace.id, unboundId),
      ),
      false,
    );
    const unboundBefore = await p.state.read((view) =>
      view.credentialSources.findCredentialSource(f.namespace.id, unboundId),
    );
    assert.ok(unboundBefore?.egress);
    assert.equal(unboundBefore.egress.adoption, "live");
    const accepted = await f.request("PATCH", `${f.path}/${unboundId}`, {
      body: consent,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const unboundAfter = await p.state.read((view) =>
      view.credentialSources.findCredentialSource(f.namespace.id, unboundId),
    );
    assert.ok(unboundAfter?.egress);
    assert.equal(
      unboundAfter.egress.key.source.generation,
      unboundBefore.egress.key.source.generation + 1,
    );
    // Both explicit re-admission and a Secret-only PATCH work for the unmarked owner.
    const updated = await f.request("PATCH", `${f.path}/${unboundId}`, {
      body: secretUpdate,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const stored = await p.state.read((view) =>
      view.credentialSources.findCredentialSource(f.namespace.id, unboundId),
    );
    assert.ok(stored?.egress);
    assert.deepEqual(stored.egress.key.provider, openAiStaticProviderRef);
    assert.deepEqual(stored.secrets, secretUpdate.secrets);
    assert.equal(f.providerRequests.length, 0);

    const selected = new OpenClawController(installation, {
      state: p.state,
      driverConfigurations: registered,
      recordOperations: false,
    });
    for (const capability of [
      "iam",
      "compute",
      "configuration",
      "secret",
      "credential_gateway",
    ] as const) {
      const driver = f.controller.selectedDriver(capability);
      selected.registerDriver(driver);
      selected.selectDriver(capability, driver.id);
    }
    // A fresh application owner shares the real capabilities and durable PostgreSQL state.
    const retiredStaticProviderRefs = [openAiStaticProviderRef];
    const selection = {
      id: sandbox.id,
      implementation: sandbox.implementation,
      configuration: {
        middlewareName: "oce-authority",
        authorityScope: "execution",
      },
      retiredStaticProviderRefs,
    };
    const owner = new InstalledDriver(
      selection,
      { capabilities: { sandbox, credential_proxy: proxy } },
      { sandbox: sandbox.id, credential_proxy: proxy.id },
    );
    assert.deepEqual(
      owner.ref,
      f.installedDriver.ref,
      "policy must not change the configuration hash",
    );
    assert.ok(Object.isFrozen(owner));
    // Caller mutation must not undo the owner's private retirement policy.
    retiredStaticProviderRefs.length = 0;
    selected.installDriver(owner, ["sandbox", "credential_proxy"]);
    assert.equal(selected.selectedDriver("sandbox"), sandbox);
    assert.equal(selected.selectedDriver("credential_proxy"), proxy);
    const app = p.createApp(selected);

    await t.test("the retired owner recovers the original active revision", async () => {
      const workQueue = new PostgresWorkQueue(p.pool);
      const key = `agent_revision:${f.revision.id}:reconcile`;
      assert.equal((await workQueue.findWork(key))?.state, "queued");
      const otherJobs = await p.pool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE state IN ('queued', 'claimed') AND namespace_id <> $1 ORDER BY idempotency_key`,
        [f.namespace.id],
      );
      assert.deepEqual(otherJobs.rows, bootstrapJobs, "no foreign work may be claimed");

      const base: ComputeDriver = f.controller.selectedDriver("compute");
      const gateway = f.controller.selectedDriver("credential_gateway");
      const sandboxConfig = registered.find(({ capability }) => capability === "sandbox");
      assert.ok(sandboxConfig);
      const calls: Parameters<typeof base.prepareRevision>[] = [];
      const compute = {
        ...base,
        async prepareRevision(...args: Parameters<typeof base.prepareRevision>) {
          calls.push(args);
          return base.prepareRevision(...args);
        },
      };
      const workerInputs = createBackendWorkerDrivers(compute, [], {
        secretDriver: f.controller.selectedDriver("secret"),
      });
      const fixtureDrivers = workerInputs.installation.drivers;
      const worker = new ControllerWorker({
        pool: p.pool,
        drivers: {
          ...workerInputs,
          computeDriver: compute,
          configurationDriver: { ...workerInputs.configurationDriver, capability: "configuration" },
          secretDriver: f.controller.selectedDriver("secret"),
          installation: {
            ...workerInputs.installation,
            backend: [],
            logging: { level: "info" },
            drivers: {
              configuration: {
                ...fixtureDrivers.configuration,
                implementation: workerInputs.configurationDriver.implementation,
                definition: KubernetesConfigurationDriver,
              },
              iam: {
                ...fixtureDrivers.iam,
                implementation: "native",
                definition: NativeIAMDriver,
              },
              compute: {
                ...fixtureDrivers.compute,
                implementation: compute.implementation,
                definition: KubernetesComputeDriver,
              },
              secret: {
                ...fixtureDrivers.secret,
                implementation: f.controller.selectedDriver("secret").implementation,
                definition: KubernetesSecretDriver,
              },
              sandbox: {
                id: sandboxConfig.driverId,
                implementation: sandboxConfig.implementation,
                definition: sandboxConfig.definition,
                configuration: {},
              },
              credential_gateway: {
                id: gateway.id,
                implementation: gateway.implementation,
                definition: OpenShellCredentialGatewayDriver,
                configuration: {},
              },
            },
          },
          protectedDriver: owner,
          sandboxDriver: sandbox,
          credentialGatewayDriver: gateway,
        },
        pollIntervalMs: 20,
        maxAttempts: 1,
        emit: () => {},
      });
      const secretReads = f.secretReads;
      try {
        await worker.start();
        const result = await waitFor("original reconcile to settle", async () => {
          const job = await workQueue.findWork(key);
          return job && ["succeeded", "failed_permanent"].includes(job.state) ? job : undefined;
        });
        assert.equal(result.state, "succeeded");
        assert.equal(result.attemptCount, 1);
        assert.equal((await workQueue.findWorkAttempt(key))?.code, "REVISION_ALREADY_ACTIVE");
      } finally {
        // Drain the Worker; the fixture owns the shared database pool and Gateway.
        await worker.stopLoop();
      }
      assert.equal(calls.length, 1);
      const [revision, context] = calls[0]!;
      assert.deepEqual(revision, f.revision);
      assert.ok(context);
      assert.equal(context.harnessAuth.method, "credential_source");
      if (context.harnessAuth.method !== "credential_source") {
        assert.fail("source required");
      }
      assert.equal(context.harnessAuth.source.id, f.source.id);
      assert.equal(context.harnessAuth.source.config.authorized_base_url, f.modelProvider.baseUrl);
      assert.equal(f.secretReads, secretReads);
      assert.deepEqual(f.providerRequests, []);
    });

    const snapshot = async () => {
      const persisted = await p.state.read(async (view) => ({
        sources: await view.credentialSources.listCredentialSources(f.namespace.id),
        agents: await view.agents.listAgents(f.namespace.id),
        revisions: await view.revisions.listRevisions(f.namespace.id, f.agent.id),
        originalRevision: await view.revisions.findRevision(
          f.namespace.id,
          f.agent.id,
          f.revision.id,
        ),
        installed: await view.credentialSources.findEgressInstallation(
          proxy.sourceControl.sender.id,
          f.installation.sandboxId,
        ),
        operations: (await view.operations.list()).filter(
          (operation) => operation.namespaceId === f.namespace.id,
        ),
      }));
      return structuredClone({
        ...persisted,
        secretReads: f.secretReads,
        providers: [...f.providers.entries()],
        gatewayEffects: [...f.gatewayEffects],
        sandbox: f.observed.sandbox,
        policy: f.observed.policy,
        deleted: f.observed.deleted,
      });
    };
    const retained = await snapshot();
    const originalSource = retained.sources.find((source) => source.id === f.source.id);
    assert.ok(originalSource?.egress);
    assert.equal(originalSource.state, "ready");
    assert.equal(originalSource.config.authorized_base_url, f.modelProvider.baseUrl);
    assert.equal(originalSource.egress.adoption, "live");
    assert.deepEqual(originalSource.egress.key.provider, openAiStaticProviderRef);
    assert.deepEqual(originalSource.egress.key.backend, originalBackend);
    assert.equal(
      retained.agents.find((agent) => agent.id === f.agent.id)?.activeRevisionId,
      f.revision.id,
    );
    assert.deepEqual(retained.originalRevision, f.revision);
    assert.equal(retained.revisions.length, 1);
    assert.ok(retained.installed);

    const cases = [
      {
        name: "unbound protected source re-admission PATCH",
        method: "PATCH",
        url: `${f.path}/${unboundId}`,
        body: consent,
      },
      {
        name: "stored-provider Secret-only PATCH without adoption consent",
        method: "PATCH",
        url: `${f.path}/${unboundId}`,
        body: { secrets: { api_key: f.secret.ref } },
      },
      {
        name: "deploy with the retained protected source",
        method: "POST",
        url: `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
        body: undefined,
      },
    ] as const;
    for (const request of cases) {
      await t.test(request.name, async () => {
        assert.equal(
          await p.state.transact((view) =>
            view.credentialSources.hasReferences(f.namespace.id, unboundId),
          ),
          false,
        );
        const response = await p.inject(request.method, request.url, request.body, app);
        assert.equal(response.statusCode, 409, response.body);
        const body: unknown = response.json();
        assert.ok(typeof body === "object" && body !== null && "error" in body);
        const error = body.error;
        assert.deepEqual(error, {
          code: "RESOURCE_CONFLICT",
          message: refusal,
        });
        assert.deepEqual(
          await snapshot(),
          retained,
          "refusal must preserve sources, revisions and observed effects",
        );
        assert.equal(f.providerRequests.length, 0, "no inference request may reach the provider");
        assert.equal(proxy.sourceControl, originalControl);
        assert.equal(proxy.sourceControl.assertAvailable, originalAvailability);
        assert.equal(proxy.sourceControl.backend, originalBackend);
        assert.equal(
          proxy.sourceControl.providers.find((entry) => entry.sourceType.type === "openai"),
          openAi,
        );
      });
    }
  },
);
