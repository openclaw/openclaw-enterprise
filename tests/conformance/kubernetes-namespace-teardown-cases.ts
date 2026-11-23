import assert from "node:assert/strict";
import { createRequire } from "node:module";

import type { Namespace, SandboxDriver } from "@openclaw-enterprise/contracts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { captureNamespaceHint } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { reconcileNamespaceLifecycle } from "../../packages/occ/src/namespace-lifecycle.ts";
import { conformanceKubeconfig } from "../helpers/kubernetes-compute.ts";
import {
  digest,
  gatewayRouting,
  labelSelectorLabels,
  options,
  selectorMatches,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { twoClusterOptions } from "./kubernetes-gateway-routing-cases.ts";
import {
  namespaceListClient,
  previousTenantNamespaceName,
} from "./kubernetes-namespace-placement-cases.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];

function forbidden() {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { ApiException }: Pick<KubernetesSdk, "ApiException"> = require("@kubernetes/client-node");
  return new ApiException(403, "Forbidden", JSON.stringify({ code: 403 }), {});
}

function repositoryTeardownOptions() {
  return options({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      ...options().network,
      repositoryCredentials: {
        namespace: "repository-service",
        podLabels: { app: "repository" },
        port: 8443,
      },
    },
  });
}

function sandboxDeletion(
  driver: KubernetesComputeDriver,
  sandbox: SandboxDriver,
  namespace: Namespace,
) {
  const { hooks } = sandboxNamespaceLifecycleBinding(driver, sandbox);
  return () =>
    reconcileNamespaceLifecycle(
      driver,
      [{ id: sandbox.id, hooks }],
      namespace,
      "deleted",
      new AbortController().signal,
      () => {},
    );
}

export async function checkSandboxCleanupBeforeNamespaceDeletion() {
  const calls: string[] = [];
  let cleanupAttempts = 0;
  let present = true;
  const namespaceName = previousTenantNamespaceName;
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      uid: "namespace-cleanup-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    status: { phase: "Active" },
  };
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-namespace-cleanup",
    implementation: "test/namespace-cleanup",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(context.revision, undefined);
      calls.push("sandbox-cleanup");
      assert.equal(context.namespace.id, tenant.id);
      assert.equal(context.namespace.name, namespaceName);
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) {
        throw new Error("workspace remains nonempty");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  const clients = {
    core: {
      async listNamespace() {
        return { items: present ? [structuredClone(namespaceResource)] : [] };
      },
      async readNamespace({ name }: { name: string }) {
        if (!present || name !== namespaceName) {
          throw notFound();
        }
        return structuredClone(namespaceResource);
      },
      async deleteNamespace(request: unknown) {
        calls.push("kubernetes-delete");
        assert.equal(cleanupAttempts, 2);
        assert.deepEqual(request, {
          name: namespaceName,
          body: { preconditions: { uid: namespaceResource.metadata.uid } },
        });
        present = false;
      },
    },
    objects: {},
  };
  Object.assign(driver, { apiClients: Promise.resolve(clients) });

  const remove = sandboxDeletion(driver, sandboxDriver, { ...tenant, status: "deleting" });

  // A provider cleanup failure must leave the Kubernetes Namespace intact for a safe retry.
  assert.deepEqual(await remove(), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });
  assert.equal(present, true);
  assert.deepEqual(calls, ["sandbox-cleanup"]);

  assert.deepEqual(await remove(), {
    namespaceId: tenant.id,
    namespaceDeleted: true,
  });
  assert.deepEqual(calls, ["sandbox-cleanup", "sandbox-cleanup", "kubernetes-delete"]);
}

export async function checkNamespaceDeletionPermissionHint() {
  const deleteWith = (cleanupError: Error) => {
    const fixture = adoptedNamespaceTeardownFixture();
    fixture.state.fail["delete ResourceQuota"] = cleanupError;
    return captureNamespaceHint(() => fixture.teardown());
  };

  // RBAC is checked before existence, so a Namespace that never received its tenant
  // RoleBindings cannot clean up and needs a hint naming the missing grant.
  assert.deepEqual(await deleteWith(forbidden()), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
    hintCode: "KUBERNETES_TENANT_ACCESS_DENIED",
  });
  // Any other failure keeps the plain observation, so the hint never hides a different cause.
  assert.deepEqual(await deleteWith(Object.assign(new Error("unavailable"), { statusCode: 503 })), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "retryable" },
  });

  // The Sandbox cleans its tenant resources before Compute deletes anything, so its denial needs the hint too.
  const sandboxDeleteWith = (cleanupError: Error) => {
    const { driver, deleting, state } = adoptedNamespaceTeardownFixture();
    const sandboxDriver: SandboxDriver = {
      id: "sandbox-denied-cleanup",
      implementation: "test/denied-cleanup",
      capability: "sandbox",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking"],
      async cleanup() {
        throw cleanupError;
      },
    };
    const remove = sandboxDeletion(driver, sandboxDriver, deleting);
    return captureNamespaceHint(async () => {
      const result = await remove();
      assert.ok(!state.calls.some((call) => call.startsWith("delete ")), "Compute never ran");
      return result;
    });
  };
  assert.deepEqual(await sandboxDeleteWith(forbidden()), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
    hintCode: "KUBERNETES_TENANT_ACCESS_DENIED",
  });
  assert.deepEqual(
    await sandboxDeleteWith(Object.assign(new Error("unavailable"), { statusCode: 503 })),
    { observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "retryable" } },
  );

  // Tenant RoleBindings cannot authorize the control-plane Gateway namespace, so its denial stays unhinted.
  const twoCluster = new KubernetesComputeDriver(twoClusterOptions());
  const gatewayNamespace = {
    ...twoCluster["gatewayNamespaceManifest"]({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  };
  gatewayNamespace.metadata.uid = "gateway-denied-uid";
  const executionApiClients = {
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async readNamespace() {
        throw Object.assign(new Error("Not found"), { code: 404 });
      },
    },
    objects: {},
  };
  Object.assign(twoCluster, { executionApiClients: Promise.resolve(executionApiClients) });
  const apiClients = {
    core: {
      async readNamespace() {
        return structuredClone(gatewayNamespace);
      },
      async deleteNamespace() {
        throw forbidden();
      },
    },
    objects: {},
  };
  Object.assign(twoCluster, { apiClients: Promise.resolve(apiClients) });
  assert.deepEqual(
    await captureNamespaceHint(() => twoCluster.deleteNamespace({ ...tenant, status: "deleting" })),
    { observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" } },
  );
}

export async function checkRepositoryWorkloadPermissionHint() {
  const fixture = adoptedNamespaceTeardownFixture(repositoryTeardownOptions());
  // Teardown lists tenant Pods before it removes repository material, so that LIST needs the hint too.
  fixture.core.listNamespacedPod = async () => {
    throw forbidden();
  };
  assert.deepEqual(await captureNamespaceHint(() => fixture.teardown()), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
    hintCode: "KUBERNETES_TENANT_ACCESS_DENIED",
  });
}

export async function checkBrokerIngressDenialHasNoTenantHint() {
  const fixture = adoptedNamespaceTeardownFixture();
  fixture.driver["reconcileRepositoryIngress"] = async () => {
    throw forbidden();
  };
  assert.deepEqual(await captureNamespaceHint(() => fixture.teardown()), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
  });
}

interface AdoptionNamespace {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    resourceVersion?: string;
    deletionTimestamp?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  status: { phase: string };
}

type MutateNamespace = (namespace: AdoptionNamespace) => void;
interface AdoptionScenario {
  mutate?: MutateNamespace | null;
  conflict?: MutateNamespace;
  policies?: { kind: string; metadata: { name: string; namespace: string } }[];
  claims?: { metadata: { name: string } }[];
  forbiddenPolicies?: boolean;
  deleting?: boolean;
  unselected?: boolean;
  computeOptions?: KubernetesComputeDriverOptions;
}

interface AdoptionPatch {
  body: { metadata: Pick<AdoptionNamespace["metadata"], "labels" | "annotations"> };
}

export async function checkExistingNamespaceAdoption() {
  const selection = {
    ...tenant,
    status: "provisioning",
    existingNamespace: "customer-support",
  } satisfies Namespace;
  const prepared = (): AdoptionNamespace => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: selection.existingNamespace,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external", "example.dev/keep": "yes" },
    },
    status: { phase: "Active" },
  });
  const httpError = (statusCode: number) =>
    Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const run = async ({
    mutate,
    policies,
    conflict,
    forbiddenPolicies,
    claims,
    deleting,
    unselected,
    computeOptions = options(),
  }: AdoptionScenario = {}) => {
    const observed = mutate === null ? undefined : prepared();
    if (observed) {
      mutate?.(observed);
    }
    const patches: AdoptionPatch[] = [];
    const driver = createKubernetesComputeDriver(computeOptions);
    // The fixture supplies transport responses only; adoption, validation, and mutation order
    // are exercised through the production driver's real ensureNamespace implementation.
    const clients = {
      core: {
        async listNamespace({ labelSelector }: { labelSelector: string }) {
          assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { items: claims ?? [] };
        },
        async readNamespace({ name }: { name: string }) {
          if (name === kubernetesNamespaceName(tenant.id)) {
            throw httpError(404);
          }
          assert.equal(name, selection.existingNamespace);
          if (observed === undefined) {
            throw httpError(404);
          }
          return structuredClone(observed);
        },
        async patchNamespace(request: AdoptionPatch) {
          patches.push(structuredClone(request));
          assert.ok(observed);
          if (conflict !== undefined) {
            conflict(observed);
            throw httpError(409);
          }
          const metadata = request.body.metadata;
          observed.metadata = {
            ...observed.metadata,
            labels: { ...observed.metadata.labels, ...metadata.labels },
            annotations: { ...observed.metadata.annotations, ...metadata.annotations },
          };
        },
        async readNamespacedResourceQuota() {
          // Stop at the first namespaced infrastructure request after successful adoption.
          throw httpError(403);
        },
      },
      networking: {
        async listNamespacedNetworkPolicy({ namespace }: { namespace: string }) {
          assert.equal(namespace, selection.existingNamespace);
          if (forbiddenPolicies) {
            throw httpError(403);
          }
          return { items: policies ?? [] };
        },
      },
    };
    const apiClients = Promise.resolve(clients);
    Object.assign(driver, { apiClients, executionApiClients: apiClients });
    const result = deleting
      ? await driver.deleteNamespace({ ...selection, status: "deleting" })
      : await driver.ensureNamespace(
          unselected ? { ...tenant, status: "provisioning" } : selection,
        );
    return { result, observed, patches };
  };

  const dualCluster = twoClusterOptions();
  dualCluster.executionCluster = {
    ...dualCluster.executionCluster,
    authentication: { mode: "kubeconfig", ...conformanceKubeconfig },
  };
  const dual = await run({ computeOptions: dualCluster });
  assert.ok(dual.observed);
  assert.equal(
    dual.observed.metadata.labels["openclaw-enterprise.io/gateway"],
    digest(`${gatewayRouting.gatewayNamespace}/harnesses`),
  );
  const adopted = await run();
  assert.deepEqual(adopted.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(adopted.patches, [
    {
      name: selection.existingNamespace,
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: selection.existingNamespace,
          resourceVersion: "7",
          labels: {
            "openclaw.dev/namespace": tenant.id,
            "openclaw.dev/gateway-namespace": tenant.id,
          },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      fieldManager: "openclaw-enterprise-compute",
      force: false,
    },
  ]);
  assert.ok(adopted.observed);
  assert.equal(adopted.observed.metadata.labels["app.kubernetes.io/managed-by"], "helm");
  assert.equal(adopted.observed.metadata.annotations["example.dev/keep"], "yes");
  assert.equal(
    adopted.observed.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    "external",
  );

  const neverAdopted = await run({ deleting: true });
  assert.deepEqual(neverAdopted.result, { namespaceId: tenant.id, namespaceDeleted: true });
  assert.deepEqual(neverAdopted.patches, []);

  for (const mutate of [
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
  ] satisfies MutateNamespace[]) {
    const ambiguous = await run({ mutate, deleting: true });
    assert.deepEqual(ambiguous.result, {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.deepEqual(ambiguous.patches, []);
  }

  const duplicateClaim = await run({ claims: [{ metadata: { name: "another-namespace" } }] });
  assert.equal(duplicateClaim.result.failure, "permanent");
  // The competing Kubernetes namespace stays unnamed; the tenant ID is this Namespace's own.
  assert.ok("reason" in duplicateClaim.result);
  assert.equal(
    duplicateClaim.result.reason,
    `Another Kubernetes namespace already claims tenant ${tenant.id}.`,
  );
  assert.deepEqual(duplicateClaim.patches, []);

  const implicitlyClaimedNamespace = prepared();
  implicitlyClaimedNamespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
  implicitlyClaimedNamespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
  const implicitAdoption = await run({ claims: [implicitlyClaimedNamespace], unselected: true });
  assert.deepEqual(implicitAdoption.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
    reason: "Existing Kubernetes namespace customer-support was not explicitly selected.",
  });
  assert.deepEqual(implicitAdoption.patches, []);

  // Each refusal carries its reason for the worker log. A foreign tenant marker is named by
  // its key; its value, another tenant's ID, never appears.
  const existing = "Existing Kubernetes namespace customer-support";
  for (const [mutate, reason] of [
    [null, `${existing} does not exist.`],
    [
      (namespace) => delete namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      `${existing} requires external ownership.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      `${existing} requires restricted Pod Security.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = "other-tenant"),
      `${existing} belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["openclaw.dev/gateway-namespace"] = "other-tenant"),
      `${existing} belongs to another tenant: its openclaw.dev/gateway-namespace label names a different Namespace.`,
    ],
    [
      (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
      `${existing} belongs to another tenant: its openclaw.dev/namespace-id annotation names a different Namespace.`,
    ],
    [(namespace) => (namespace.status.phase = "Terminating"), `${existing} must be active.`],
    [
      (namespace) => (namespace.metadata.deletionTimestamp = "2026-08-26T00:00:00.000Z"),
      `${existing} must be active.`,
    ],
    [
      (namespace) => delete namespace.metadata.resourceVersion,
      `${existing} requires a resource version.`,
    ],
  ] satisfies [MutateNamespace | null, string][]) {
    const rejected = await run({ mutate });
    assert.deepEqual(rejected.result, {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: "permanent",
      reason,
    });
    assert.deepEqual(rejected.patches, []);
  }

  // A NetworkPolicy left by another tenant is named after that tenant's Agents: the reason
  // omits its name.
  const foreignPolicies = await run({
    policies: [
      {
        kind: "NetworkPolicy",
        metadata: { name: "allow-agent-auth-0123456789ab", namespace: selection.existingNamespace },
      },
    ],
  });
  assert.deepEqual(foreignPolicies.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
    reason:
      "The existing Kubernetes namespace customer-support has a NetworkPolicy that this Namespace does not own.",
  });
  assert.deepEqual(foreignPolicies.patches, []);

  const inaccessible = await run({ forbiddenPolicies: true });
  assert.deepEqual(inaccessible.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(inaccessible.patches, []);

  const competingTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_another";
    },
  });
  assert.equal(competingTenant.result.failure, "permanent");
  assert.ok("reason" in competingTenant.result);
  assert.equal(
    competingTenant.result.reason,
    `${existing} belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.`,
  );
  assert.equal(competingTenant.patches.length, 1);

  const sameTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
      namespace.metadata.labels["openclaw.dev/gateway-namespace"] = tenant.id;
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
    },
  });
  assert.deepEqual(sameTenant.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.equal(sameTenant.patches.length, 1);
}

type SweepKind =
  "ResourceQuota" | "LimitRange" | "NetworkPolicy" | "ConfigMap" | "Secret" | "ServiceAccount";

interface SweepObject {
  kind: string;
  apiVersion: string;
  metadata: {
    name: string;
    uid?: string;
    namespace?: string;
    labels?: Record<string, string>;
    deletionTimestamp?: Date | string;
  };
}

type NamedResourceRequest = { name: string; namespace: string };

interface SweepState {
  calls: string[];
  fail: Record<string, Error>;
  finalizer?: string;
  vanished?: string;
  unselected: SweepObject[];
}

// An adopted namespace whose OCC Namespace is being deleted: a transport-only fake of the
// requests teardown makes, with label-selector lists and UID-fenced deletes.
function adoptedNamespaceTeardownFixture(
  computeOptions: KubernetesComputeDriverOptions = options(),
) {
  const name = "customer-support";
  const target = { name, plane: "execution" } as const;
  const ownership = { namespaceId: tenant.id };
  const driver = createKubernetesComputeDriver(computeOptions);
  driver["waitBeforeRetry"] = async () => {};
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid: "customer-support-uid",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "openclaw.dev/gateway-namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-lifecycle": "external",
        "openclaw.dev/namespace-id": tenant.id,
      },
    },
    status: { phase: "Active" },
  };
  const objects = new Map<string, SweepObject>();
  const save = (object: SweepObject) =>
    objects.set(`${object.kind}:${object.metadata.name}`, {
      ...structuredClone(object),
      metadata: { uid: `${object.metadata.name}-uid`, ...structuredClone(object.metadata) },
    });
  const owned = (
    kind: SweepKind,
    objectName: string,
    owner: Parameters<KubernetesComputeDriver["manifest"]>[3] = ownership,
  ) => save(driver["manifest"]("v1", kind, objectName, owner, target));
  owned("ResourceQuota", "openclaw-quota");
  owned("LimitRange", "openclaw-limits");
  for (const policy of driver["networkPolicies"](ownership, target)) {
    save(policy);
  }
  // Orphans of a create whose OCC transaction failed: a Secret driver Secret, a Configuration
  // ConfigMap and an Agent ServiceAccount, each with this Namespace's full ownership metadata.
  owned("Secret", "secret-orphan");
  owned("ConfigMap", "configuration-orphan");
  owned("ServiceAccount", "agent-orphan", { ...ownership, agentId: "agt_orphan" });
  // The operator's own objects, another tenant's, and one that copies OCE's labels without the
  // Namespace-ID annotation OCE always writes, all stay.
  const kept: string[] = [];
  for (const kind of ["ConfigMap", "Secret", "ServiceAccount"] as const) {
    const plain = {
      apiVersion: "v1",
      kind,
      metadata: { name: `operator-${kind}`, namespace: name },
    };
    save(plain);
    owned(kind, `other-tenant-${kind}`, { namespaceId: "ns_other" });
    const lookalike = driver["manifest"]("v1", kind, `lookalike-${kind}`, ownership, target);
    delete lookalike.metadata.annotations;
    save(lookalike);
    kept.push(
      `${kind}:operator-${kind}`,
      `${kind}:other-tenant-${kind}`,
      `${kind}:lookalike-${kind}`,
    );
  }
  // fail: errors by request; finalizer: an object that stays terminating; vanished: an object
  // another actor deletes during the request; unselected: an object a list returns although its
  // labels do not match the selector.
  const state: SweepState = { calls: [], fail: {}, unselected: [] };
  const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
  const api = (kind: SweepKind) => ({
    async [`readNamespaced${kind}`]({
      name: objectName,
      namespace: requested,
    }: NamedResourceRequest) {
      assert.equal(requested, name);
      const object = objects.get(`${kind}:${objectName}`);
      if (object === undefined) {
        throw notFound();
      }
      return structuredClone(object);
    },
    async [`listNamespaced${kind}`]({
      namespace: requested,
      labelSelector,
    }: {
      namespace: string;
      labelSelector: string;
    }) {
      assert.equal(requested, name);
      state.calls.push(`list ${kind}`);
      // Repository material cleanup lists its own session Secrets first; fail only the sweep.
      if (
        state.fail[`list ${kind}`] !== undefined &&
        !labelSelector.includes("openclaw.dev/repository-material")
      ) {
        throw state.fail[`list ${kind}`];
      }
      return {
        apiVersion: "v1",
        kind: `${kind}List`,
        metadata: {},
        items: [...objects.values()]
          .filter(
            (object) =>
              object.kind === kind &&
              selectorMatches(
                { matchLabels: labelSelectorLabels(labelSelector) },
                object.metadata.labels ?? {},
              ),
          )
          .concat(state.unselected.filter((object) => object.kind === kind))
          .map((object) => structuredClone(object)),
      };
    },
    async [`deleteNamespaced${kind}`]({
      name: objectName,
      namespace: requested,
      body,
    }: NamedResourceRequest & { body: { preconditions: { uid: string } } }) {
      assert.equal(requested, name);
      state.calls.push(`delete ${kind}:${objectName}`);
      if (state.fail[`delete ${kind}`] !== undefined) {
        throw state.fail[`delete ${kind}`];
      }
      const object = objects.get(`${kind}:${objectName}`);
      if (object === undefined) {
        throw notFound();
      }
      assert.equal(body.preconditions.uid, object.metadata.uid);
      if (state.vanished === `${kind}:${objectName}`) {
        objects.delete(`${kind}:${objectName}`);
        throw notFound();
      }
      if (state.finalizer === `${kind}:${objectName}`) {
        object.metadata.deletionTimestamp = "2026-10-23T00:00:00Z";
        return;
      }
      objects.delete(`${kind}:${objectName}`);
    },
  });
  const clients = {
    core: {
      ...namespaceListClient([namespace]),
      async readNamespace({ name: requested }: { name: string }) {
        if (requested !== name) {
          throw notFound();
        }
        return structuredClone(namespace);
      },
      async deleteNamespace() {
        assert.fail("an existing namespace must outlive its OCC Namespace");
      },
      // Repository material cleanup finds no workloads and no session material.
      async listNamespacedPod() {
        return { items: [] };
      },
      ...api("ConfigMap"),
      ...api("Secret"),
      ...api("ServiceAccount"),
      ...api("ResourceQuota"),
      ...api("LimitRange"),
    },
    apps: {
      async listNamespacedDeployment() {
        return { items: [] };
      },
    },
    networking: api("NetworkPolicy"),
    objects: {},
  };
  const apiClients = Promise.resolve(clients);
  Object.assign(driver, { apiClients, executionApiClients: apiClients });
  const deleting: Namespace = { ...tenant, status: "deleting", existingNamespace: name };
  const teardown = () => driver.deleteNamespace(deleting);
  const remaining = () => [...objects.keys()].sort();
  return { driver, core: clients.core, deleting, objects, state, kept, teardown, remaining };
}

// Finding 1400: an existing namespace outlives its OCC Namespace, so teardown removes the
// orphans a failed create left there, matched by this Namespace's full ownership only.
export async function checkAdoptedNamespaceOrphanTeardown() {
  const deleted = { namespaceId: tenant.id, namespaceDeleted: true };
  const swept = adoptedNamespaceTeardownFixture();
  assert.deepEqual(await swept.teardown(), deleted);
  // Without repository credentials the worker may not list Secrets (finding 2201), so the
  // Secret orphan stays: the documented gap. ConfigMaps and ServiceAccounts are swept.
  assert.deepEqual(swept.remaining(), [...swept.kept, "Secret:secret-orphan"].sort());
  assert.ok(!swept.state.calls.includes("list Secret"));

  const repositoryOptions = repositoryTeardownOptions();
  const all = adoptedNamespaceTeardownFixture(repositoryOptions);
  assert.deepEqual(await all.teardown(), deleted);
  assert.deepEqual(all.remaining(), [...all.kept].sort());
  // Only the orphans and OCE's fixed infrastructure were deleted.
  assert.deepEqual(all.state.calls.filter((call) => call.startsWith("delete ")).sort(), [
    "delete ConfigMap:configuration-orphan",
    "delete LimitRange:openclaw-limits",
    "delete NetworkPolicy:allow-dns",
    "delete NetworkPolicy:allow-gateway-ingress",
    "delete NetworkPolicy:default-deny",
    "delete ResourceQuota:openclaw-quota",
    "delete Secret:secret-orphan",
    "delete ServiceAccount:agent-orphan",
  ]);

  // A refused list or a failed delete is a failed teardown, never a clean one, and OCE's
  // infrastructure stays until a retry finishes the sweep.
  for (const [step, error, failure] of [
    ["list Secret", Object.assign(new Error("forbidden"), { statusCode: 403 }), "permanent"],
    ["list ConfigMap", Object.assign(new Error("unavailable"), { statusCode: 503 }), "retryable"],
    ["delete ServiceAccount", Object.assign(new Error("failed"), { statusCode: 500 }), "retryable"],
  ] as const) {
    const failed = adoptedNamespaceTeardownFixture(repositoryOptions);
    failed.state.fail[step] = error;
    const result = await failed.teardown();
    assert.equal(result.namespaceDeleted, false, step);
    assert.equal(result.failure, failure, step);
    assert.ok(failed.objects.has("ResourceQuota:openclaw-quota"), step);
    delete failed.state.fail[step];
    assert.deepEqual(await failed.teardown(), deleted, step);
    assert.deepEqual(failed.remaining(), [...failed.kept].sort(), step);
  }

  // An orphan another actor deletes first is gone all the same.
  const vanished = adoptedNamespaceTeardownFixture();
  vanished.state.vanished = "ConfigMap:configuration-orphan";
  assert.deepEqual(await vanished.teardown(), deleted);
  assert.ok(!vanished.objects.has("ConfigMap:configuration-orphan"));

  // A list answer with an object outside the selector is refused before anything is deleted.
  const unselected = adoptedNamespaceTeardownFixture();
  unselected.state.unselected.push({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "operator-unlabelled", namespace: "customer-support", uid: "foreign-uid" },
  });
  assert.deepEqual(await unselected.teardown(), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
  assert.ok(!unselected.state.calls.some((call) => call.startsWith("delete ServiceAccount")));
  assert.ok(unselected.objects.has("ServiceAccount:agent-orphan"));
  assert.ok(unselected.objects.has("ResourceQuota:openclaw-quota"));

  // An orphan that is still terminating (a finalizer) keeps the teardown pending.
  const pending = adoptedNamespaceTeardownFixture();
  pending.state.finalizer = "ConfigMap:configuration-orphan";
  assert.deepEqual(await pending.teardown(), { namespaceId: tenant.id, namespaceDeleted: false });
  assert.ok(pending.objects.has("ResourceQuota:openclaw-quota"));
}
