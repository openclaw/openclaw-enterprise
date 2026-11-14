import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { GatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import type {
  HarnessAuthSnapshot,
  RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { writeSafeKubeconfig } from "../helpers/unsafe-kubeconfigs.mjs";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
  resolveKubernetesControlNamespace,
  resolveKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { DEDICATED_STORAGE_ROUTING_REQUIRED } from "../helpers/refusal-text.mjs";
import {
  tenant,
  apiKeyAuth,
  options,
  routedOptions,
  routedRevision,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type CoreApi = Parameters<typeof resolveKubernetesNamespace>[0];
type NamespaceList = Awaited<ReturnType<CoreApi["listNamespace"]>>;
type NamespaceRecord = NamespaceList["items"][number] & {
  metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> };
  status: { phase: string };
};

async function namespaceCore(t: TestContext, listNamespace: CoreApi["listNamespace"]) {
  const { kubeconfigPath, context }: { kubeconfigPath: string; context: unknown } =
    await writeSafeKubeconfig(t);
  assert.ok(typeof context === "string");
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    { mode: "kubeconfig", kubeconfigPath, context },
    (message) => new Error(message),
  );
  return Object.assign(new sdk.CoreV1Api(clientConfiguration), { listNamespace });
}

export const previousTenantNamespaceName =
  "oce-ns-00000000-0000-4000-8000-000000000001-89d99db2f971";

const previousPunctuatedNamespace = {
  id: "Very_Long.Namespace/With Mixed_CASE_and punctuation that truncates before hash suffix 1234567890",
  name: "oce-very-long-namespace-with-mixed-case-and-punctu-13352a1af7c0",
};

export function checkNamespaceNames() {
  for (const id of ["Namespace_With.UPPERCASE!punctuation", "x".repeat(250), "---"]) {
    const name = kubernetesNamespaceName(id);
    const suffix = createHash("sha256").update(id).digest("hex").slice(0, 15);

    assert.equal(name, kubernetesNamespaceName(id));
    assert.equal(name, `oce-${suffix}`);
  }

  // Distinct tenant identifiers retain distinct opaque placements.
  assert.notEqual(kubernetesNamespaceName("Team A"), kubernetesNamespaceName("Team-A"));
}

// Admission may inspect whether node enrollment is available, but it must not start enrollment.
export function unexpectedNodeEnrollment(): GatewayNodeEnrollment {
  async function unexpected(): Promise<never> {
    assert.fail("unexpected node enrollment");
  }
  return { createSetup: unexpected, observeSetup: unexpected, isConnected: unexpected };
}

export async function checkDedicatedRuntimeWorkspaceTransport() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  for (const [configuration, selection] of [
    [options({ runtime }), { nodeEnrollment: unexpectedNodeEnrollment() }],
    [routedOptions({ runtime }), {}],
  ] as const) {
    const driver = new KubernetesComputeDriver(configuration, selection);
    const revision = routedRevision(driver);
    let clusterReads = 0;
    driver["clients"] = async () => {
      clusterReads++;
      assert.fail("unexpected cluster access");
    };
    for (const operation of ["prepareRevision", "activateRevision"] as const) {
      await assert.rejects(driver[operation](revision), {
        message: DEDICATED_STORAGE_ROUTING_REQUIRED,
      });
    }
    assert.equal(clusterReads, 0);
  }
}

// Preparation refused these Installation settings only after a dedicated deployment stopped
// its predecessors (finding 2349). Embedded and channel-runtime Installations need none of
// them, so startup accepts them and deployment admission names the setting.
export function checkDedicatedHarnessPlacementAdmission() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  const codex: RevisionHarnessDescriptor = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const native: RevisionHarnessDescriptor = { id: "openclaw", version: "1.0.0", mode: "dedicated" };
  const embedded: RevisionHarnessDescriptor = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  };
  const authentication: HarnessAuthSnapshot = {
    ...apiKeyAuth,
    method: "api_key",
    source: { ...apiKeyAuth.source, kind: "secret" },
  };
  const codexConfiguration = createHarnessConfiguration("codex", "gpt-5");
  const nativeConfiguration = createHarnessConfiguration("openclaw", "gpt-4o-mini");
  const embeddedConfiguration = { agents: { defaults: { model: "openai/gpt-5" } } };
  // Only OpenClaw has an embedded mode, so a Codex Agent is told to change its harness
  // (finding 2391).
  const named = (setting: string) =>
    new RegExp(
      `^Dedicated Agents need ${setting} in this Installation's Kubernetes Compute configuration\\. Codex runs only as a Dedicated Agent: select Embedded OpenClaw, or ask an operator to configure it\\.$`,
    );
  const nativeMessage =
    "Dedicated Agents need gatewayRouting in this Installation's Kubernetes Compute configuration. Select Embedded OpenClaw, or ask an operator to configure it.";
  // Composition always supplies node enrollment, so gatewayRouting is the setting to name.
  const routing = named("gatewayRouting");
  const storage = named("gateway routing and node enrollment");
  const selector = named("runtime\\.gatewayNodeSelector");
  const withoutSelector = { ...routedOptions({ runtime }), runtime };
  for (const [driver, message] of [
    [
      new KubernetesComputeDriver(options({ runtime }), {
        nodeEnrollment: unexpectedNodeEnrollment(),
      }),
      routing,
    ],
    [new KubernetesComputeDriver(routedOptions({ runtime })), storage],
    [
      new KubernetesComputeDriver(withoutSelector, { nodeEnrollment: unexpectedNodeEnrollment() }),
      selector,
    ],
    [
      new KubernetesComputeDriver(
        routedOptions({ runtime: { ...runtime, gatewayNodeSelector: {} } }),
        { nodeEnrollment: unexpectedNodeEnrollment() },
      ),
      selector,
    ],
  ] as const) {
    assert.throws(
      () => driver.validateHarnessAuth(codex, authentication, codexConfiguration, {}),
      (error) => error instanceof ConfigurationHarnessError && message.test(error.message),
    );
    // Agent save (null bindings) refuses it too: the execution mode is the Agent's (finding 2376).
    assert.throws(
      () => driver.validateHarnessAuth(codex, authentication, codexConfiguration, null),
      (error) => error instanceof ConfigurationHarnessError && message.test(error.message),
    );
    // Embedded Agents need none of these.
    driver.validateHarnessAuth(embedded, authentication, embeddedConfiguration, {});
    driver.validateHarnessAuth(embedded, authentication, embeddedConfiguration, null);
  }
  // A Dedicated OpenClaw Agent can switch to Embedded execution. Agent save checks it; deployment
  // refuses it without a Sandbox Driver first.
  assert.throws(
    () =>
      new KubernetesComputeDriver(options({ runtime }), {
        nodeEnrollment: unexpectedNodeEnrollment(),
      }).validateHarnessAuth(native, authentication, nativeConfiguration, null),
    { name: "ConfigurationHarnessError", message: nativeMessage },
  );
  new KubernetesComputeDriver(routedOptions({ runtime }), {
    nodeEnrollment: unexpectedNodeEnrollment(),
  }).validateHarnessAuth(codex, authentication, codexConfiguration, {});
  // Without runtime storage nothing is rendered that needs them.
  new KubernetesComputeDriver(options()).validateHarnessAuth(
    codex,
    authentication,
    codexConfiguration,
    {},
  );
}

export async function checkExternalNamespaceOwnership(t: TestContext) {
  const external: NamespaceRecord = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-id": tenant.id,
        "openclaw.dev/namespace-lifecycle": "external",
      },
    },
    status: { phase: "Active" },
  };
  // The fixture supplies Kubernetes response data only; the actual resolver makes every decision.
  let items: NamespaceList["items"];
  let expectedNamespaceId: string;
  const core = await namespaceCore(t, async (request) => {
    assert.equal(request?.labelSelector, `openclaw.dev/namespace=${expectedNamespaceId}`);
    return { apiVersion: "v1", kind: "NamespaceList", items };
  });
  function discover(observed: NamespaceList["items"], namespaceId = tenant.id) {
    items = observed;
    expectedNamespaceId = namespaceId;
    return resolveKubernetesNamespace(core, namespaceId);
  }

  assert.deepEqual(await discover([external]), { name: "customer-support", external: true });
  assert.deepEqual(await discover([]), {
    name: kubernetesNamespaceName(tenant.id),
    external: false,
  });

  const managed = structuredClone(external);
  managed.metadata.name = kubernetesNamespaceName(tenant.id);
  managed.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
  delete managed.metadata.annotations["openclaw.dev/namespace-lifecycle"];
  assert.deepEqual(await discover([managed]), { name: managed.metadata.name, external: false });

  const upgraded = structuredClone(managed);
  upgraded.metadata.name = previousTenantNamespaceName;
  assert.deepEqual(await discover([upgraded]), { name: upgraded.metadata.name, external: false });

  const upgradedPunctuated = structuredClone(managed);
  upgradedPunctuated.metadata.name = previousPunctuatedNamespace.name;
  upgradedPunctuated.metadata.labels["openclaw.dev/namespace"] = previousPunctuatedNamespace.id;
  upgradedPunctuated.metadata.annotations["openclaw.dev/namespace-id"] =
    previousPunctuatedNamespace.id;
  assert.deepEqual(await discover([upgradedPunctuated], previousPunctuatedNamespace.id), {
    name: previousPunctuatedNamespace.name,
    external: false,
  });

  await assert.rejects(discover([external, structuredClone(external)]), /multiple/i);
  const refusals: readonly [mutate: (item: NamespaceRecord) => void, expected: RegExp][] = [
    [(item) => (item.metadata.name = ""), /unowned/i],
    [
      (item) => (item.metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant"),
      /unowned/i,
    ],
    [
      (item) => delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      /external ownership/i,
    ],
    [
      (item) => {
        delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"];
        item.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
        item.metadata.name = "oce-wrong-managed-name";
      },
      /external ownership/i,
    ],
    [
      (item) => {
        delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"];
        item.metadata.name = previousTenantNamespaceName;
      },
      /external ownership/i,
    ],
    [
      (item) => (item.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      /restricted/i,
    ],
    [(item) => (item.status.phase = "Pending"), /active/i],
    [(item) => (item.metadata.deletionTimestamp = new Date("2026-08-25T00:00:00Z")), /active/i],
  ];
  for (const [mutate, expected] of refusals) {
    // Each rejection exercises the real resolver against malformed, ambiguous, or unsafe ownership.
    const invalid = structuredClone(external);
    mutate(invalid);
    await assert.rejects(discover([invalid]), expected);
  }
}

// A released split-layout Installation adopts each `oce-gateways-<hash>` storage namespace as
// its tenant namespace in place (scripts/split-layout-adopt.ts): the storage namespace gains
// the tenant label and the old Harness namespace loses it. Canonical Secrets, Configurations
// and Gateway state keep their namespace and UIDs, so both resolvers must accept the adopted
// name, but only while it still carries its own storage label.
export function adoptedSplitLayoutNamespaces() {
  const adopted: NamespaceRecord = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: kubernetesGatewayNamespaceName(tenant.id),
      uid: "adopted-storage-namespace-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/gateway-namespace": tenant.id,
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    status: { phase: "Active" },
  };
  const released = structuredClone(adopted);
  released.metadata.name = kubernetesNamespaceName(tenant.id);
  released.metadata.uid = "released-harness-namespace-uid";
  delete released.metadata.labels["openclaw.dev/gateway-namespace"];
  // The adopt steps remove the tenant label from the released Harness namespace last.
  const relabelled = structuredClone(released);
  delete relabelled.metadata.labels["openclaw.dev/namespace"];
  return { adopted, released, relabelled };
}

export function namespaceListClient(
  items: readonly NamespaceList["items"][number][],
): Pick<CoreApi, "listNamespace"> {
  return {
    async listNamespace(request) {
      const labelSelector = request?.labelSelector;
      assert.ok(labelSelector);
      const [key, value] = labelSelector.split("=");
      assert.ok(key);
      return {
        apiVersion: "v1",
        kind: "NamespaceList",
        items: items
          .filter(({ metadata }) => metadata?.labels?.[key] === value)
          .map((item) => structuredClone(item)),
      };
    },
  };
}

export async function checkAdoptedSplitLayoutResolution(t: TestContext) {
  const { adopted, released, relabelled } = adoptedSplitLayoutNamespaces();
  const client = await namespaceCore(t, namespaceListClient([adopted, relabelled]).listNamespace);
  assert.deepEqual(await resolveKubernetesNamespace(client, tenant.id), {
    name: adopted.metadata.name,
    external: false,
  });
  // The Secret and Configuration Drivers keep the canonical rows they pinned to this namespace.
  assert.deepEqual(await resolveKubernetesControlNamespace(client, tenant.id), {
    name: adopted.metadata.name,
  });

  // Halfway through the relabel both namespaces claim the tenant; nothing may pick one.
  client.listNamespace = namespaceListClient([adopted, released]).listNamespace;
  await assert.rejects(
    resolveKubernetesNamespace(client, tenant.id),
    /Multiple Kubernetes namespaces claim tenant/,
  );
  // The storage name alone is not ownership: without its storage label the namespace is refused.
  const unlabelled = structuredClone(adopted);
  delete unlabelled.metadata.labels["openclaw.dev/gateway-namespace"];
  client.listNamespace = namespaceListClient([unlabelled]).listNamespace;
  await assert.rejects(resolveKubernetesNamespace(client, tenant.id), /without external ownership/);
  // Another tenant's storage label does not admit this tenant's storage name.
  const foreign = structuredClone(adopted);
  foreign.metadata.labels["openclaw.dev/gateway-namespace"] = "ns_other";
  client.listNamespace = namespaceListClient([foreign]).listNamespace;
  await assert.rejects(resolveKubernetesNamespace(client, tenant.id), /without external ownership/);
}

export function checkSharedWorkspaceClaimOwnership() {
  const driver = createKubernetesComputeDriver(options());
  const agentId = "agt_00000000-0000-4000-8000-000000000001";
  const ownership = { namespaceId: tenant.id, agentId };

  // Exercise the real PVC serializer against discovered placement, not a simulated cluster.
  const claim = driver["harnessWorkspaceClaim"](agentId, ownership, {
    name: "customer-support",
    plane: "execution",
  });
  assert.equal(claim.metadata.namespace, "customer-support");
  assert.equal(claim.metadata.annotations?.["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations?.["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec?.accessModes, ["ReadWriteOnce"]);
  assert.equal(asRecord(asRecord(claim.spec?.resources)?.requests)?.storage, "40Gi");
}

export async function checkAdoptedSplitLayoutPlacement(embedded: boolean) {
  const { driver, revision, namespace, objects, state, context } = workspaceSetupFixture(
    embedded,
    true,
    undefined,
    {},
    {},
    { adopted: true },
  );
  assert.equal(namespace, kubernetesGatewayNamespaceName(tenant.id));
  assert.equal(
    (await driver.prepareRevision(revision, { ...context, secretEnvironment: [] })).ready,
    false,
  );
  const placed = (kind: string, prefix: string) =>
    [...objects.values()]
      .filter((object) => object.kind === kind && object.metadata.name.startsWith(prefix))
      .map((object) => object.metadata.namespace);
  // Every runtime object lands beside the adopted Gateway state and canonical Secrets.
  assert.deepEqual(placed("Deployment", "gateway-"), [namespace]);
  assert.deepEqual(placed("Deployment", "agent-"), embedded ? [] : [namespace]);
  assert.deepEqual(placed("PersistentVolumeClaim", "gateway-state-"), [namespace]);
  assert.equal(
    [...objects.values()].some(
      ({ kind, metadata }) =>
        kind !== "Namespace" && metadata.namespace === kubernetesNamespaceName(tenant.id),
    ),
    false,
  );
  state.ready = true;
  assert.equal(
    (await driver.prepareRevision(revision, { ...context, secretEnvironment: [] })).ready,
    true,
  );
}

export async function checkSharedTenantPreparationOwnership() {
  for (const foreign of [false, true]) {
    const { driver, revision, context, objects, records } = workspaceSetupFixture(false);
    const key = `Namespace::${kubernetesNamespaceName(tenant.id)}`;
    if (foreign) {
      const annotations = objects.get(key)?.metadata.annotations;
      assert.ok(annotations);
      annotations["openclaw.dev/namespace-id"] = "another-tenant";
      await assert.rejects(
        driver.prepareRevision(revision, { ...context, secretEnvironment: [] }),
        /Refusing/,
      );
    } else {
      objects.delete(key);
      assert.equal(
        (await driver.prepareRevision(revision, { ...context, secretEnvironment: [] })).ready,
        false,
      );
    }
    assert.equal(records.length, 0);
  }
}
