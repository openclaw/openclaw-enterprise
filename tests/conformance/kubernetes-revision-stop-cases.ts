import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  KubernetesComputeDriver,
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  ComputeStopYieldedError,
  withComputeWorkWaiting,
  withYieldingComputeStop,
  withYieldingGatewayDrain,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import { SandboxGatewayUnavailableError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  apiKeyAuth,
  digest,
  labelSelectorLabels,
  options,
  preparedAuth,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type AppsApi = InstanceType<KubernetesSdk["AppsV1Api"]>;
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type ObjectApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
type ReadNamespace = Parameters<CoreApi["readNamespace"]>[0];
type ReadDeployment = Parameters<AppsApi["readNamespacedDeployment"]>[0];
type DeleteDeployment = Parameters<AppsApi["deleteNamespacedDeployment"]>[0];
type DeleteService = Parameters<CoreApi["deleteNamespacedService"]>[0];
type DeleteServiceAccount = Parameters<CoreApi["deleteNamespacedServiceAccount"]>[0];
type DeleteClaim = Parameters<CoreApi["deleteNamespacedPersistentVolumeClaim"]>[0];
type DeleteObject = Parameters<ObjectApi["delete"]>;
type ReadObject = Parameters<ObjectApi["read"]>[0];
type ListPods = Parameters<CoreApi["listNamespacedPod"]>[0];
type SandboxCleanup = NonNullable<SandboxDriver["cleanup"]>;

export function lifecycleNamespaceReads(
  driver: KubernetesComputeDriver,
  namespace: string,
  namespaceId: string,
) {
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": namespaceId },
    },
  };
  return {
    async listNamespace() {
      return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
    },
    async readNamespace({ name }: ReadNamespace) {
      if (name === kubernetesNamespaceName(tenant.id)) {
        return {
          ...driver["gatewayNamespaceManifest"]({ namespaceId: tenant.id }),
          status: { phase: "Active" },
        };
      }
      return structuredClone(namespaceResource);
    },
  };
}

export async function checkContainmentRetirementRetry() {
  const cleanupCalls: Parameters<SandboxCleanup>[0][] = [];
  const deletionCalls: DeleteDeployment[] = [];
  let deploymentPresent = true;
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-containment-only",
    implementation: "test/containment-only",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-retirement",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, revision.namespaceId);
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver["deployment"](
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-workload-uid";
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  let gatewayReads = 0;
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });

  // Only Kubernetes transport observations are substituted; retirement and Sandbox dispatch
  // execute through the production driver against a supported containment-only extension.
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedSecret() {
          throw notFound();
        },
        ...namespaceReads,
        async listNamespacedPod() {
          assert.equal(deploymentPresent, false);
          return { apiVersion: "v1", kind: "PodList", items: [] };
        },
        async readNamespacedPersistentVolumeClaim() {
          throw notFound();
        },
        async readNamespacedConfigMap() {
          throw notFound();
        },
        async readNamespacedService() {
          throw notFound();
        },
        async readNamespacedServiceAccount() {
          throw notFound();
        },
      },
      apps: {
        async readNamespacedDeployment({ name }: ReadDeployment) {
          if (name === deploymentName && deploymentPresent) {
            return structuredClone(deployment);
          }
          if (name === gatewayName) {
            gatewayReads += 1;
          }
          throw notFound();
        },
        async deleteNamespacedDeployment(request: DeleteDeployment) {
          deletionCalls.push(request);
          deploymentPresent = false;
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          throw notFound();
        },
      },
      objects: {
        async read() {
          throw notFound();
        },
      },
    }),
  });

  // The first cleanup failure occurs after workload removal and must keep retirement retryable.
  await assert.rejects(driver.retireRevision(revision), /sandbox cleanup failed/);
  assert.equal(deploymentPresent, false);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(gatewayReads, 0);

  // The absent-workload retry must run the required cleanup again instead of completing early.
  await driver.retireRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.ok(gatewayReads >= 1);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
}

export async function checkStopRetainsAgentStorage() {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-stop-storage";
  const revisionId = "revision-stop-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = routedRevision(driver, {
    id: revisionId,
    revision: 2,
    agentId,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
  });
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, tenant.id);
  const gateway = driver["manifest"]("apps/v1", "Deployment", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.resourceVersion = "1";
  assert.ok(gateway.metadata.annotations);
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revisionId;
  const service = driver["service"](
    gatewayName,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": gatewayName,
    },
  );
  service.metadata.uid = "service-uid";
  const account = driver["manifest"]("v1", "ServiceAccount", gatewayName, ownership, {
    name: namespace,
    plane: "execution",
  });
  account.metadata.uid = "account-uid";
  const route = driver["gatewayRoute"](
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
  );
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "1";
  const privateClaim = driver["gatewayPrivateStateClaim"](agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  privateClaim.metadata.uid = "private-state-uid";
  const deletions: (
    | ["Deployment", DeleteDeployment]
    | ["Service", DeleteService]
    | ["ServiceAccount", DeleteServiceAccount]
    | ["PersistentVolumeClaim", DeleteClaim]
    | ["HTTPRoute", { spec: DeleteObject[0]; body: DeleteObject[6] }]
  )[] = [];
  let privateClaimDeleted = false;
  let serviceDeleted = false;
  let accountDeleted = false;
  let gatewayDeleted = false;
  let routeDeleted = false;
  let failServiceDelete = true;
  let gatewayPodObservations = 0;
  const gatewayPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "stopped-gateway-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": tenant.id,
        "openclaw.dev/agent": agentId,
        "openclaw.dev/revision": revisionId,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  Object.assign(driver, {
    apiClients: Promise.resolve({
      apps: {
        async readNamespacedDeployment({ name }: ReadDeployment) {
          if (name !== gatewayName || gatewayDeleted) {
            throw Object.assign(new Error("Not found"), { code: 404 });
          }
          return structuredClone(gateway);
        },
        async deleteNamespacedDeployment(request: DeleteDeployment) {
          deletions.push(["Deployment", request]);
          gatewayDeleted = true;
        },
      },
      core: {
        async readNamespacedSecret() {
          throw Object.assign(new Error("Not found"), { statusCode: 404 });
        },
        ...namespaceReads,
        async listNamespacedPod() {
          assert.equal(gatewayDeleted, true);
          gatewayPodObservations += 1;
          return {
            apiVersion: "v1",
            kind: "PodList",
            items: gatewayPodObservations === 1 ? [structuredClone(gatewayPod)] : [],
          };
        },
        async readNamespacedService({ name }: ReadDeployment) {
          if (name !== gatewayName || serviceDeleted) {
            throw Object.assign(new Error("Not found"), { code: 404 });
          }
          return structuredClone(service);
        },
        async deleteNamespacedService(request: DeleteService) {
          deletions.push(["Service", request]);
          if (failServiceDelete) {
            failServiceDelete = false;
            throw new Error("service delete failed");
          }
          serviceDeleted = true;
        },
        async readNamespacedServiceAccount({ name }: ReadDeployment) {
          if (name !== gatewayName || accountDeleted) {
            throw Object.assign(new Error("Not found"), { code: 404 });
          }
          return structuredClone(account);
        },
        async deleteNamespacedServiceAccount(request: DeleteServiceAccount) {
          deletions.push(["ServiceAccount", request]);
          accountDeleted = true;
        },
        async readNamespacedPersistentVolumeClaim({ name }: ReadDeployment) {
          assert.equal(name, privateClaim.metadata.name);
          return structuredClone(privateClaim);
        },
        async deleteNamespacedPersistentVolumeClaim(request: DeleteClaim) {
          deletions.push(["PersistentVolumeClaim", request]);
          privateClaimDeleted = true;
        },
        async readNamespacedConfigMap() {
          throw Object.assign(new Error("Not found"), { code: 404 });
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          throw Object.assign(new Error("Not found"), { code: 404 });
        },
      },
      objects: {
        async read({ kind, metadata }: ReadObject) {
          if (routeDeleted || kind !== route.kind || metadata.name !== route.metadata.name) {
            throw Object.assign(new Error("Not found"), { code: 404 });
          }
          return structuredClone(route);
        },
        async delete(...[spec, , , , , , body]: DeleteObject) {
          deletions.push(["HTTPRoute", { spec, body }]);
          routeDeleted = true;
        },
      },
    }),
  });

  // A failed shared cleanup must retry after the exact route and Deployment are absent.
  await assert.rejects(driver.stopRevision(revision), /service delete failed/);
  await driver.stopRevision(revision);
  assert.deepEqual(
    deletions.map(([kind]) => kind),
    ["HTTPRoute", "Deployment", "Service", "Service", "ServiceAccount"],
  );
  assert.equal(gatewayPodObservations, 2);

  // The worker stops the published revision before retiring predecessors. A missing
  // gateway after stop does not make Agent-owned durable state revision garbage.
  const predecessor = { ...revision, id: "revision-stop-storage-predecessor", revision: 1 };
  await driver.retireRevision(predecessor);
  assert.equal(privateClaimDeleted, false, "stopping and retiring must retain native Agent state");
}

export async function checkStopPreservesReplacement(
  cutover: "already deployed" | "during Deployment deletion" | "during route deletion",
) {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver, {
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const name = `gateway-${digest(revision.agentId)}`;
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const namespaceResource = driver["manifest"]("v1", "Namespace", namespace, {
    namespaceId: tenant.id,
  });
  const gateway = driver["manifest"]("apps/v1", "Deployment", name, ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.ok(gateway.metadata.annotations);
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
  const service = driver["service"](
    name,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": name,
    },
  );
  const account = driver["manifest"]("v1", "ServiceAccount", name, ownership, {
    name: namespace,
    plane: "execution",
  });
  const route = driver["gatewayRoute"](
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
  );
  const resources = new Map<string, ReturnType<KubernetesComputeDriver["manifest"]>>();
  for (const resource of [gateway, service, account, route]) {
    resource.metadata.uid = `${resource.kind}-uid`;
    resource.metadata.resourceVersion = "1";
    resources.set(resource.kind, resource);
  }
  const advance = (resource: ReturnType<KubernetesComputeDriver["manifest"]>) => {
    assert.ok(resource.metadata.annotations);
    resource.metadata.annotations["openclaw.dev/agent-revision-id"] = "replacement-revision";
    resource.metadata.resourceVersion = "2";
  };
  if (cutover === "already deployed") {
    // Activation applies the replacement Deployment before replacing the old route.
    advance(gateway);
  }
  let raced = false;
  const deletions: string[] = [];
  const missing = () => Object.assign(new Error("Not found"), { code: 404 });
  const read = (kind: string) => {
    const resource = resources.get(kind);
    if (resource === undefined) {
      throw missing();
    }
    return structuredClone(resource);
  };
  const remove = (kind: string, body: DeleteDeployment["body"]) => {
    if (!raced && cutover === `during ${kind === "HTTPRoute" ? "route" : kind} deletion`) {
      // Server-side apply updates the revision without changing the object's UID.
      advance(gateway);
      if (kind === "HTTPRoute") {
        advance(route);
      }
      raced = true;
    }
    const resource = resources.get(kind);
    if (resource === undefined) {
      throw missing();
    }
    for (const field of ["uid", "resourceVersion"] as const) {
      if (
        body?.preconditions?.[field] !== undefined &&
        body.preconditions[field] !== resource.metadata[field]
      ) {
        throw Object.assign(new Error("Deletion precondition conflict"), { code: 409 });
      }
    }
    resources.delete(kind);
    deletions.push(kind);
  };
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async listNamespace() {
          return { items: [namespaceResource] };
        },
        async readNamespace() {
          return structuredClone(namespaceResource);
        },
        async listNamespacedPod() {
          return { items: [] };
        },
        async readNamespacedService() {
          return read("Service");
        },
        async readNamespacedServiceAccount() {
          return read("ServiceAccount");
        },
        async readNamespacedConfigMap() {
          throw missing();
        },
        async readNamespacedSecret() {
          throw missing();
        },
        async deleteNamespacedService({ body }: DeleteService) {
          remove("Service", body);
        },
        async deleteNamespacedServiceAccount({ body }: DeleteServiceAccount) {
          remove("ServiceAccount", body);
        },
      },
      apps: {
        async readNamespacedDeployment() {
          return read("Deployment");
        },
        async deleteNamespacedDeployment({ body }: DeleteDeployment) {
          remove("Deployment", body);
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          return read("NetworkPolicy");
        },
      },
      objects: {
        async read({ kind, metadata }: ReadObject) {
          if (kind !== route.kind || metadata.name !== route.metadata.name) {
            throw missing();
          }
          return read("HTTPRoute");
        },
        async delete(...[, , , , , , body]: DeleteObject) {
          remove("HTTPRoute", body);
        },
      },
    }),
  });

  if (cutover !== "already deployed") {
    await assert.rejects(driver.stopRevision(revision), { code: 409 });
    assert.equal(raced, true);
  }
  await driver.stopRevision(revision);
  assert.equal(resources.get("Deployment"), gateway);
  assert.equal(resources.get("Service"), service);
  assert.equal(resources.get("ServiceAccount"), account);
  assert.equal(
    gateway.metadata.annotations["openclaw.dev/agent-revision-id"],
    "replacement-revision",
  );
  assert.deepEqual(deletions, cutover === "during route deletion" ? [] : ["HTTPRoute"]);
  assert.equal(resources.has("HTTPRoute"), cutover === "during route deletion");
}

export async function checkContainmentStopOrder() {
  const cleanupCalls: Parameters<SandboxCleanup>[0][] = [];
  const deletionCalls: DeleteDeployment[] = [];
  let deploymentPresent = true;
  let podObservations = 0;
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-containment-only-stop",
    implementation: "test/containment-only",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      assert.ok(podObservations >= 2, "cleanup must wait for the exact workload Pod to terminate");
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, revision.namespaceId);
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver["deployment"](
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-stop-workload-uid";
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "containment-stop-workload-pod",
      namespace,
      labels: structuredClone(asRecord(asRecord(deployment.spec?.template)?.metadata)?.labels),
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedConfigMap() {
          throw notFound();
        },
        async readNamespacedSecret() {
          throw notFound();
        },
        async readNamespacedService() {
          throw notFound();
        },
        async readNamespacedServiceAccount() {
          throw notFound();
        },
        ...namespaceReads,
        async listNamespacedPod(request: ListPods) {
          assert.ok(request.labelSelector);
          const selected = labelSelectorLabels(request.labelSelector);
          assert.equal(selected["openclaw.dev/namespace"], revision.namespaceId);
          assert.equal(selected["openclaw.dev/agent"], revision.agentId);
          assert.equal(selected["openclaw.dev/revision"], revision.id);
          if (selected["openclaw.dev/workload-role"] === "gateway") {
            return { apiVersion: "v1", kind: "PodList", items: [] };
          }
          assert.equal(selected["openclaw.dev/workload-role"], "agent");
          assert.equal(deploymentPresent, false);
          podObservations += 1;
          return {
            apiVersion: "v1",
            kind: "PodList",
            items: podObservations === 1 ? [structuredClone(pod)] : [],
          };
        },
      },
      apps: {
        async readNamespacedDeployment({ name }: ReadDeployment) {
          if (name === deploymentName && deploymentPresent) {
            return structuredClone(deployment);
          }
          throw notFound();
        },
        async deleteNamespacedDeployment(request: DeleteDeployment) {
          deletionCalls.push(request);
          deploymentPresent = false;
        },
      },
      objects: {},
    }),
  });

  // A cleanup failure leaves stop retryable after the Compute-owned workload is gone.
  await assert.rejects(driver.stopRevision(revision), /sandbox cleanup failed/);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);

  // Retrying an absent workload must still invoke the selected Sandbox cleanup.
  await driver.stopRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.equal(podObservations, 3);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
}

function stopResourceNotFound() {
  return Object.assign(new Error("Not found"), { code: 404 });
}

async function readAbsentStopResource() {
  throw stopResourceNotFound();
}

const absentStopResourceReads = {
  readNamespacedConfigMap: readAbsentStopResource,
  readNamespacedSecret: readAbsentStopResource,
  readNamespacedService: readAbsentStopResource,
  readNamespacedServiceAccount: readAbsentStopResource,
};

// A dedicated revision whose Gateway and Agent Pods stay for `gatewayPodsLeft` and
function stopOrderFixture(id: string) {
  const driver = new KubernetesComputeDriver(options());
  const revision = routedRevision(driver, { id });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, revision.namespaceId);
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver["deployment"](
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "refused-stop-order-agent-uid";
  const gatewayPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "refused-stop-order-gateway-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  const agentPod = structuredClone(gatewayPod);
  agentPod.metadata.name = "refused-stop-order-agent-pod";
  agentPod.metadata.labels["openclaw.dev/workload-role"] = "agent";
  const events: string[] = [];
  const fixture = {
    events,
    deploymentPresent: true,
    gatewayPodsLeft: 0,
    agentPodsLeft: 0,
    otherRevisionPod: false,
    gatewayReads: 0,
  };
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        ...absentStopResourceReads,
        ...namespaceReads,
        async listNamespacedPod(request: ListPods) {
          const role = labelSelectorLabels(request.labelSelector ?? "")[
            "openclaw.dev/workload-role"
          ];
          fixture.events.push(`list ${role} Pods`);
          if (role === "gateway" && fixture.gatewayPodsLeft > 0) {
            fixture.gatewayPodsLeft -= 1;
            return { apiVersion: "v1", kind: "PodList", items: [structuredClone(gatewayPod)] };
          }
          if (role === "agent" && fixture.agentPodsLeft > 0) {
            fixture.agentPodsLeft -= 1;
            const pod = structuredClone(agentPod);
            if (fixture.otherRevisionPod) {
              pod.metadata.labels["openclaw.dev/revision"] = "another-revision";
            }
            return { apiVersion: "v1", kind: "PodList", items: [pod] };
          }
          return { apiVersion: "v1", kind: "PodList", items: [] };
        },
      },
      apps: {
        async readNamespacedDeployment({ name }: ReadDeployment) {
          if (name.startsWith("gateway-")) {
            fixture.gatewayReads += 1;
          }
          if (name === deploymentName && fixture.deploymentPresent) {
            return structuredClone(deployment);
          }
          throw stopResourceNotFound();
        },
        async deleteNamespacedDeployment({ name }: DeleteDeployment) {
          assert.equal(name, deploymentName);
          fixture.events.push("delete Agent Deployment");
          fixture.deploymentPresent = false;
        },
      },
      objects: {},
    }),
  });

  return Object.assign(fixture, { driver, revision });
}

// The termination wait refuses a listed Pod outside its selector at once instead of waiting
export async function checkForeignWorkloadPodRefusal() {
  const fixture = stopOrderFixture("revision-other-revision-pod");
  const { driver, revision } = fixture;
  fixture.agentPodsLeft = 2;
  fixture.otherRevisionPod = true;
  await assert.rejects(
    driver.stopRevision(revision),
    /Refusing an ambiguous AgentRevision workload Pod\./u,
  );
  assert.deepEqual(fixture.events, [
    "list gateway Pods",
    "delete Agent Deployment",
    "list agent Pods",
  ]);
}

export async function checkRefusedCandidateStopOrder() {
  // Finding 1025: a yielding (refused-candidate) stop deletes the Agent Deployment before it
  // waits for the Gateway's Pods, so a yield there leaves no Harness running until the retry.
  // Any other stop drains the Gateway into the running Harness first.
  const fixture = stopOrderFixture("revision-refused-stop-order");
  const { driver, revision } = fixture;
  // Other Work is waiting, so the refused candidate's stop yields at the Gateway wait, after
  // the Harness's deletion was issued.
  fixture.gatewayPodsLeft = 1;
  await assert.rejects(
    withComputeWorkWaiting(
      async () => true,
      () => withYieldingComputeStop(() => driver.stopRevision(revision)),
    ),
    (error) => error instanceof ComputeStopYieldedError && /still terminating/u.test(error.message),
  );
  assert.deepEqual(fixture.events, [
    "delete Agent Deployment",
    "list agent Pods",
    "list gateway Pods",
  ]);
  assert.equal(fixture.deploymentPresent, false);

  // Any other stop drains the Gateway before it deletes the Harness, and does not yield.
  fixture.events = [];
  fixture.deploymentPresent = true;
  fixture.gatewayPodsLeft = 1;
  await withComputeWorkWaiting(
    async () => true,
    () => driver.stopRevision(revision),
  );
  assert.deepEqual(fixture.events, [
    "list gateway Pods",
    "list gateway Pods",
    "delete Agent Deployment",
    "list agent Pods",
  ]);
}

export async function checkGatewayDrainYield() {
  // Finding 1088: an ordinary stop held the serial worker for the Gateway's whole drain (up to
  // about 340 s). Under withYieldingGatewayDrain only that wait yields; the stop keeps its order,
  // so the Harness the Gateway drains into runs until a retry sees the Gateway's Pods gone.
  const fixture = stopOrderFixture("revision-ordinary-stop-yield");
  const { driver, revision } = fixture;
  const stop = (waiting: boolean) =>
    withComputeWorkWaiting(
      async () => waiting,
      () => withYieldingGatewayDrain(() => driver.stopRevision(revision)),
    );
  const yielded = (error: unknown) =>
    error instanceof ComputeStopYieldedError && /still terminating/u.test(error.message);

  // Other Work is waiting: the Gateway is removed, one observation still lists its Pod, and the
  // stop yields before it touches the Harness.
  fixture.gatewayPodsLeft = 2;
  await assert.rejects(stop(true), yielded);
  assert.deepEqual(fixture.events, ["list gateway Pods"]);
  assert.equal(fixture.deploymentPresent, true);
  const firstReads = fixture.gatewayReads;
  assert.ok(firstReads > 0, "the stop removes the Gateway");

  // A retry repeats the idempotent removal and yields again while the Gateway still drains.
  fixture.events = [];
  await assert.rejects(stop(true), yielded);
  assert.deepEqual(fixture.events, ["list gateway Pods"]);
  assert.equal(fixture.gatewayReads, 2 * firstReads);
  assert.equal(fixture.deploymentPresent, true);

  // Once the Gateway's Pods are gone the retry deletes the Harness. Its own wait never yields,
  // even with Work waiting, so the stop completes.
  fixture.events = [];
  fixture.agentPodsLeft = 1;
  await stop(true);
  assert.deepEqual(fixture.events, [
    "list gateway Pods",
    "delete Agent Deployment",
    "list agent Pods",
    "list agent Pods",
  ]);
  assert.equal(fixture.deploymentPresent, false);

  // With nothing waiting, the drain is awaited in the same pass, as before.
  fixture.events = [];
  fixture.deploymentPresent = true;
  fixture.gatewayPodsLeft = 1;
  await stop(false);
  assert.deepEqual(fixture.events, [
    "list gateway Pods",
    "list gateway Pods",
    "delete Agent Deployment",
    "list agent Pods",
  ]);

  // A refused candidate's stop still yields on its Harness's wait too.
  fixture.events = [];
  fixture.deploymentPresent = true;
  fixture.agentPodsLeft = 1;
  await assert.rejects(
    withComputeWorkWaiting(
      async () => true,
      () => withYieldingComputeStop(() => driver.stopRevision(revision)),
    ),
    yielded,
  );
  assert.deepEqual(fixture.events, ["delete Agent Deployment", "list agent Pods"]);
}

export async function checkProviderStopTermination() {
  let cleanupComplete = false;
  let podObservations = 0;
  let failCleanup = false;
  const cleanupFailure = new SandboxGatewayUnavailableError(
    "OpenShell GetSandbox failed with gRPC status 14.",
  );
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-provider-stop",
    implementation: "test/provider-owned",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["process"],
    async provisionHarness() {
      assert.fail("stop must not provision a Harness workload");
    },
    async cleanup() {
      if (failCleanup) {
        throw cleanupFailure;
      }
      cleanupComplete = true;
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-provider-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, revision.namespaceId);
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "provider-stop-workload-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
  };
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        ...absentStopResourceReads,
        ...namespaceReads,
        async listNamespacedPod(request: ListPods) {
          assert.ok(request.labelSelector);
          const selected = labelSelectorLabels(request.labelSelector);
          if (selected["openclaw.dev/workload-role"] === "gateway") {
            return { apiVersion: "v1", kind: "PodList", items: [] };
          }
          assert.equal(cleanupComplete, true);
          podObservations += 1;
          return {
            apiVersion: "v1",
            kind: "PodList",
            items: podObservations === 1 ? [structuredClone(pod)] : [],
          };
        },
      },
      apps: {
        async readNamespacedDeployment() {
          throw stopResourceNotFound();
        },
      },
      objects: {},
    }),
  });

  await driver.stopRevision(revision);
  assert.equal(cleanupComplete, true);
  assert.equal(podObservations, 2);

  // Other Work waiting ends a yielding stop's wait after one observation of a live Pod; the
  // caller retries the stop (finding 1022). Any other stop keeps waiting for termination.
  const waiting = async () => true;
  podObservations = 0;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () =>
      withYieldingComputeStop(() => driver.stopRevision(revision)),
    ),
    (error) => error instanceof ComputeStopYieldedError && /still terminating/u.test(error.message),
  );
  assert.equal(podObservations, 1);
  podObservations = 0;
  await withComputeWorkWaiting(waiting, () => driver.stopRevision(revision));
  assert.equal(podObservations, 2);
  // With nothing waiting, a yielding stop waits too.
  podObservations = 0;
  await withComputeWorkWaiting(
    async () => false,
    () => withYieldingComputeStop(() => driver.stopRevision(revision)),
  );
  assert.equal(podObservations, 2);

  // Finding 2040: a gateway that does not answer the Sandbox cleanup reaches the worker as the
  // same error, so an exclusive predecessor's stop waits for the gateway in the revision pass.
  cleanupComplete = false;
  failCleanup = true;
  await assert.rejects(driver.stopRevision(revision), (error) => error === cleanupFailure);
  assert.equal(cleanupComplete, false);
}
