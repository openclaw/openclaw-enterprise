import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  AgentRevision,
  ComputeDriver,
  ComputeRevisionContext,
  CredentialSourceType,
} from "../../packages/contracts/src/index.ts";

/** Reuse the source owner's prepared synthetic Kubernetes/Sandbox workflow. */
export async function checkComputeCredentialCatalog(
  t: TestContext,
  driver: ComputeDriver,
  revision: AgentRevision,
  context: ComputeRevisionContext,
  gateway: { id: string; listSourceTypes: () => Promise<readonly CredentialSourceType[]> },
  objects: Map<string, unknown>,
  nodeSecret: { metadata: { name: string; namespace: string } },
  core: {
    listNamespacedPod(request: { labelSelector?: string }): Promise<{ items: unknown[] }>;
  },
  harnessLabels: Record<string, string>,
) {
  // Activation observes an already enrolled node, as returned by the fixture's Gateway.
  objects.set(`Secret:${nodeSecret.metadata.namespace}:${nodeSecret.metadata.name}`, {
    ...nodeSecret,
    metadata: { ...nodeSecret.metadata, uid: "catalog-node-uid", resourceVersion: "1" },
    type: "Opaque",
    data: { deviceId: Buffer.from("node-1").toString("base64") },
  });
  let activating = false;
  const listPods = core.listNamespacedPod.bind(core);
  core.listNamespacedPod = async (request) =>
    activating && request.labelSelector?.includes("openclaw.dev/workload-role=agent")
      ? {
          items: [
            {
              metadata: {
                name: "catalog-harness",
                namespace: nodeSecret.metadata.namespace,
                labels: harnessLabels,
              },
              status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
            },
          ],
        }
      : listPods(request);
  const owner = gateway.id;
  const listSourceTypes = gateway.listSourceTypes;
  const catalog = await listSourceTypes();
  assert.ok(driver.validateHarnessAuth);
  driver.validateHarnessAuth(
    revision.harness,
    revision.harnessAuth,
    revision.configuration,
    revision.secretBindings,
    catalog[0],
  );
  const refusal =
    "Credential-source Harness authentication requires paired Drivers and a matching supported OpenAI login mode.";
  const rejectsConfiguration = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.constructor.name, "ConfigurationFailure");
    assert.equal(error.message, refusal);
    return true;
  };
  for (const operation of ["prepareRevision", "activateRevision"] as const) {
    await t.test(`${operation} checks the recorded Gateway before catalog lookup`, async (t) => {
      activating = operation === "activateRevision";
      const invoke:
        | ((revision: AgentRevision, context?: ComputeRevisionContext) => Promise<unknown>)
        | undefined = driver[operation];
      assert.ok(invoke);
      const run = () => invoke.call(driver, revision, context);
      let calls = 0;
      let current = catalog;
      let unavailable = false;
      const outage = new Error("synthetic catalog unavailable");
      gateway.listSourceTypes = async () => {
        calls += 1;
        if (unavailable) {
          throw outage;
        }
        return current;
      };
      try {
        // A real admitted source reaches the public operation with its owner's catalog.
        await run();
        assert.equal(calls, 1);
        unavailable = true;
        await assert.rejects(run(), (error) => error === outage);
        assert.equal(calls, 2);
        unavailable = false;
        // The current catalog, not the saved login mode alone, determines acceptance.
        for (const entries of [
          [],
          catalog.map((entry) => ({ ...entry, type: "different-source-type" })),
          catalog.map((entry) => ({
            ...entry,
            harnessAuth: { modelProvider: "openai", loginMode: "api_key" } as const,
          })),
        ]) {
          current = entries;
          const before: number = calls;
          await assert.rejects(run(), rejectsConfiguration);
          assert.equal(calls, before + 1);
        }
        current = catalog;
        gateway.id = "replacement-credential-gateway";
        calls = 0;
        await assert.rejects(run(), rejectsConfiguration);
        t.diagnostic(`replacement Gateway catalog calls: ${calls}`);
        assert.equal(calls, 0, "a replacement Gateway must not supply the catalog");
      } finally {
        gateway.id = owner;
        gateway.listSourceTypes = listSourceTypes;
      }
    });
  }
  core.listNamespacedPod = listPods;
}
