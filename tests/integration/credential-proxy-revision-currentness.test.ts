import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenClawController,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

test("deployment validates Harness authentication with the source descriptor that supplied its login mode", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  const controller: OpenClawController = f.controller;
  const gateway = controller.selectedDriver("credential_gateway");
  const compute = createTestKubernetesComputeDriver("admission-compute", {
    gatewayRuntime: true,
    sandboxDriver: controller.selectedDriver("sandbox"),
    credentialGatewayDriver: gateway,
  });
  // Use real Compute auth validation; the fixture keeps runtime placement and effects simulated.
  controller.selectedDriver("compute").validateHarnessAuth =
    compute.validateHarnessAuth.bind(compute);
  assert.equal(f.source.ownerCapability, "credential_gateway");
  const offered = await gateway.listSourceTypes({ signal: AbortSignal.timeout(5_000) });
  const original = offered.find((entry) => entry.type === f.source.type);
  const harnessAuth = original?.harnessAuth;
  assert.ok(harnessAuth);
  assert.equal(harnessAuth.loginMode, "api_key");
  const changed = offered.map((entry) =>
    entry === original
      ? { ...entry, harnessAuth: { ...harnessAuth, loginMode: "codex_pat" as const } }
      : entry,
  );
  // The catalog changes after Harness admission; the independent listed-source check still runs.
  let calls = 0;
  const catalog = t.mock.method(gateway, "listSourceTypes", async () =>
    ++calls === 1 ? offered : changed,
  );
  const deploy = () =>
    f.request("POST", `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`);
  const admitted = await deploy();
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
  catalog.mock.mockImplementation(async () =>
    offered.map((entry) =>
      entry === original
        ? { ...entry, harnessAuth: { ...harnessAuth, modelProvider: "anthropic" } }
        : entry,
    ),
  );
  assert.equal((await deploy()).status, 409);
  assert.equal(catalog.mock.callCount(), 4);
  assert.deepEqual(await revisions(), saved);
});

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
