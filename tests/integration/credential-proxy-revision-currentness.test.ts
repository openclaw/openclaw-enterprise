import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { ConfigurationDriver } from "../../packages/contracts/src/index.ts";
import type {
  OpenClawController,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

/**
 * Gives the fixture real Kubernetes Compute auth validation, then makes the Gateway catalog
 * change the source type's login mode after its first read. Admission reads that entry once, so
 * validating against a later read would refuse the descriptor that supplied the login mode.
 */
async function catalogChangingAfterAdmission(
  t: TestContext,
  controller: OpenClawController,
  sourceType: string,
) {
  const gateway = controller.selectedDriver("credential_gateway");
  const compute = createTestKubernetesComputeDriver("admission-compute", {
    gatewayRuntime: true,
    sandboxDriver: controller.selectedDriver("sandbox"),
    credentialGatewayDriver: gateway,
  });
  // Use real Compute auth validation; the fixture keeps runtime placement and effects simulated.
  controller.selectedDriver("compute").validateHarnessAuth =
    compute.validateHarnessAuth.bind(compute);
  const offered = await gateway.listSourceTypes({ signal: AbortSignal.timeout(5_000) });
  const original = offered.find((entry) => entry.type === sourceType);
  const harnessAuth = original?.harnessAuth;
  assert.ok(harnessAuth);
  assert.equal(harnessAuth.loginMode, "api_key");
  const changed = offered.map((entry) =>
    entry === original
      ? { ...entry, harnessAuth: { ...harnessAuth, loginMode: "codex_pat" as const } }
      : entry,
  );
  let calls = 0;
  const catalog = t.mock.method(gateway, "listSourceTypes", async () =>
    ++calls === 1 ? offered : changed,
  );
  /** The same catalog, but Compute refuses the source's model provider. */
  const refuseProvider = () =>
    catalog.mock.mockImplementation(async () =>
      offered.map((entry) =>
        entry === original
          ? { ...entry, harnessAuth: { ...harnessAuth, modelProvider: "anthropic" } }
          : entry,
      ),
    );
  return { compute, gateway, catalog, refuseProvider };
}

test("deployment validates Harness authentication with the source descriptor that supplied its login mode", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  const controller: OpenClawController = f.controller;
  assert.equal(f.source.ownerCapability, "credential_gateway");
  // The catalog changes after Harness admission; the independent listed-source check still runs.
  const { gateway, catalog, refuseProvider } = await catalogChangingAfterAdmission(
    t,
    controller,
    f.source.type,
  );
  const deploy = () =>
    f.request("POST", `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`);
  const admitted = await deploy();
  const calls = catalog.mock.callCount();
  assert.equal(admitted.status, 202, JSON.stringify({ response: admitted.body, calls }));
  assert.equal(calls, 2);
  const revisions = () =>
    controller.transact((state) => state.revisions.listRevisions(f.namespace.id, f.agent.id));
  const saved = await revisions();
  assert.deepEqual(saved[0]?.harnessAuth, {
    method: "credential_source",
    sourceId: f.source.id,
    credentialGatewayId: gateway.id,
    sourceType: f.source.type,
    loginMode: "api_key",
  });

  // Another admission must resolve its own descriptor and still let Compute reject its provider.
  refuseProvider();
  assert.equal((await deploy()).status, 409);
  assert.equal(catalog.mock.callCount(), 4);
  assert.deepEqual(await revisions(), saved);
});

test(
  "provisioning validates Harness authentication with the source descriptor that supplied its login mode (PostgreSQL)",
  requiresPostgres,
  async (t) => {
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      // Provisioning keeps its job in PostgreSQL and needs exact Configuration create and inspect.
      appFactory: async (context: TestContext, options: object = {}) => {
        const app = await postgresApp(context, options);
        const configuration: ConfigurationDriver = {
          ...createTestConfigurationDriver({ id: "provisioning-configuration", exact: true }),
          capability: "configuration",
        };
        app.controller.registerDriver(configuration);
        app.controller.selectDriver(configuration.capability, configuration.id);
        return app as unknown as Awaited<ReturnType<typeof createConsoleAppFixture>>;
      },
    });
    const controller: OpenClawController = f.controller;
    const { compute, catalog, refuseProvider } = await catalogChangingAfterAdmission(
      t,
      controller,
      f.source.type,
    );
    // Real Kubernetes provisioning admission. No provisioning worker runs here, so the runtime
    // credential members are only the capability the request requires; they are never called.
    Object.assign(controller.selectedDriver("compute"), {
      agentProvisioning: compute.agentProvisioning,
      validateAgentProvisioning: compute.validateAgentProvisioning.bind(compute),
      getAgentRuntimeCredentialStatus: compute.getAgentRuntimeCredentialStatus.bind(compute),
      provisionAgentRuntimeCredentials: compute.provisionAgentRuntimeCredentials.bind(compute),
    });
    const provision = (name: string, requestId: string) =>
      f.request("POST", `/namespaces/${f.namespace.id}/agents/provision`, {
        body: {
          requestId,
          name,
          executionMode: "dedicated",
          configuration: {
            kind: "agent",
            values: {
              agents: {
                defaults: {
                  model: { primary: "codex/fixture-model" },
                  models: { "codex/fixture-model": { agentRuntime: { id: "codex" } } },
                },
              },
            },
          },
          harnessAuth: { method: "credential_source", sourceId: f.source.id },
        },
      });
    // Provisioning admission reads the catalog once and validates against that entry.
    const admitted = await provision("provisioned-agent", `req_${randomUUID()}`);
    const calls = catalog.mock.callCount();
    assert.equal(admitted.status, 202, JSON.stringify({ response: admitted.body, calls }));
    assert.equal(calls, 1);
    const queued = await controller.transact((state) =>
      state.provisioning.findByWorkId(admitted.body.data.provisioning.workId),
    );
    assert.ok(queued);
    assert.equal(queued.status, "queued");

    // Another request resolves its own descriptor, and Compute still refuses its provider. The
    // refusal comes after the job row is written, so the transaction must not keep it.
    refuseProvider();
    const refusedRequest = `req_${randomUUID()}`;
    assert.equal((await provision("refused-agent", refusedRequest)).status, 409);
    assert.equal(catalog.mock.callCount(), 2);
    assert.equal(
      await controller.transact((state) =>
        state.provisioning.findByRequest(f.namespace.id, queued.actorId, refusedRequest),
      ),
      undefined,
    );
  },
);

test("credential exchange consults revision history only for inactive executions", async (t) => {
  let revisionListings = 0;
  const f = await staticEgressFixture(t, {
    recordInstallation: false,
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) => state.read(work),
          transact: (work) =>
            state.transact((unit) =>
              work({
                ...unit,
                revisions: {
                  ...unit.revisions,
                  listRevisionMetadata: (...args) => {
                    revisionListings += 1;
                    return unit.revisions.listRevisionMetadata(...args);
                  },
                },
              }),
            ),
        }),
      }),
  });
  assert.ok("revision" in f);
  await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.recordEgressInstallation(f.installation),
  );

  // A newly provisioned execution can probe before the Agent activates it.
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 1);

  await f.activateRevision(f.namespace.id, f.agent.id, f.revision.id);
  const successor = await f.deployAgent(f.namespace.id, f.agent.id);
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 0, "the active execution needs no revision-history lookup");

  // Once its successor activates, the older installed execution must be refused.
  await f.activateRevision(f.namespace.id, f.agent.id, successor.id, f.revision.id);
  revisionListings = 0;
  assert.equal((await f.resolve(f.capture())).refused?.code, f.refusalCode("DENIED"));
  assert.equal(revisionListings, 1);
});
