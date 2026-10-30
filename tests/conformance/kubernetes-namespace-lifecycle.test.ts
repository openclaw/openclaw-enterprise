import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { repositoryMaterialSecretName } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import test from "node:test";
import {
  KubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  options,
  routedOptions,
  gatewayRouting,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import type { NamespaceLifecycleContext } from "../../packages/contracts/src/index.ts";

// This callback fixture exercises Compute's protocol and effects only. PostgreSQL
// durability and real-worker claim fencing are covered by postgres-namespace-lifecycle.
function lifecycle(target: "ready" | "deleted") {
  let revision = 0;
  let data: Readonly<Record<string, unknown>> = {};
  const context: NamespaceLifecycleContext = {
    lifecycleId: "00000000-0000-4000-8000-000000000099",
    target,
    signal: new AbortController().signal,
    async read() {
      return { revision, data: structuredClone(data) };
    },
    async checkpoint(expected, next) {
      assert.equal(expected, revision);
      data = structuredClone(next);
      revision += 1;
      return { revision, data: structuredClone(data) };
    },
  };
  return context;
}

test("Kubernetes cancellation before first ensure does not dispatch provider cleanup", async () => {
  let cleanupCalls = 0;
  const driver = new KubernetesComputeDriver(options() as KubernetesComputeDriverOptions, {
    sandboxDriver: {
      id: "sandbox",
      implementation: "protocol-fixture",
      capability: "sandbox",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: [],
      async cleanup() {
        cleanupCalls += 1;
        throw new Error("No provider stage was attempted.");
      },
    },
  });
  const clients = {
    server: "https://cluster.example.test",
    lifecycleTarget: { server: "https://cluster.example.test", trust: "fixture-trust" },
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async readNamespace() {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      },
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve(clients) });
  const result = await driver.deleteNamespace(
    { ...tenant, status: "deleting" },
    lifecycle("deleted"),
  );
  assert.equal(result.namespaceDeleted, true);
  assert.equal(cleanupCalls, 0);
});

interface FixtureResource {
  readonly kind: string;
  readonly metadata: {
    name: string;
    namespace?: string;
    uid: string;
    resourceVersion: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  readonly [key: string]: unknown;
}
interface FixtureDelete {
  readonly name: string;
  readonly namespace?: string;
  readonly body: {
    readonly preconditions: { readonly uid?: string; readonly resourceVersion?: string };
  };
}
interface FixturePatch {
  readonly name: string;
  readonly body: {
    readonly metadata: {
      readonly uid?: string;
      readonly resourceVersion?: string;
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    };
  };
}

function fixture(
  external = false,
  selection: ConstructorParameters<typeof KubernetesComputeDriver>[1] = {},
  configuration = options() as KubernetesComputeDriverOptions,
) {
  const objects = new Map<string, FixtureResource>();
  const effects: string[] = [];
  let nextUid = 0;
  let releaseReplyLost = false;
  let denyQuota = false;
  let denyNamespace = false;
  let loseNamespaceReply = false;
  let loseQuotaReply = false;
  let quotaReadsToReplacement = 0;
  const missing = () => Object.assign(new Error("Not found"), { statusCode: 404 });
  const key = (kind: string, name: string, namespace = "") => `${kind}:${namespace}:${name}`;
  const read = (kind: string, name: string, namespace = "") => {
    const current = objects.get(key(kind, name, namespace));
    if (current === undefined) {
      throw missing();
    }
    return structuredClone(current);
  };
  const write = (kind: string, input: object, namespace = "") => {
    const body = input as FixtureResource;
    const storage = key(kind, body.metadata.name, namespace);
    const previous = objects.get(storage);
    const observed = {
      ...structuredClone(body),
      kind,
      metadata: {
        ...body.metadata,
        labels: { ...body.metadata.labels },
        annotations: { ...body.metadata.annotations },
        ...(namespace ? { namespace } : {}),
        uid: previous?.metadata.uid ?? `uid-${++nextUid}`,
        resourceVersion: String(Number(previous?.metadata.resourceVersion ?? 0) + 1),
      },
      ...(kind === "Namespace" ? { status: { phase: "Active" } } : {}),
    };
    objects.set(storage, observed);
    return structuredClone(observed);
  };
  const patch =
    (kind: string) =>
    async ({ body, namespace }: { readonly body: object; readonly namespace?: string }) => {
      if (kind === "ResourceQuota" && loseQuotaReply) {
        loseQuotaReply = false;
        throw Object.assign(new Error("Quota write outcome unknown"), { code: "ETIMEDOUT" });
      }
      if (kind === "ResourceQuota" && denyQuota) {
        throw Object.assign(new Error("Quota creation is forbidden"), { statusCode: 403 });
      }
      return write(kind, body, namespace);
    };
  const remove =
    (kind: string) =>
    async ({ name, namespace, body }: FixtureDelete) => {
      const current = read(kind, name, namespace);
      assert.equal(body.preconditions.uid, current.metadata.uid);
      assert.equal(body.preconditions.resourceVersion, current.metadata.resourceVersion);
      effects.push(`delete:${kind}:${name}`);
      objects.delete(key(kind, name, namespace));
    };
  const clients = {
    server: "https://cluster.example.test",
    lifecycleTarget: { server: "https://cluster.example.test", trust: "fixture-trust" },
    core: {
      async listNamespace() {
        return {
          items: [...objects.values()].filter(
            (value) =>
              value.kind === "Namespace" &&
              value.metadata.labels?.["openclaw.dev/namespace"] === tenant.id,
          ),
        };
      },
      async readNamespace({ name }: { name: string }) {
        return read("Namespace", name);
      },
      async createNamespace({ body }: { readonly body: object }) {
        if (loseNamespaceReply) {
          loseNamespaceReply = false;
          throw Object.assign(new Error("Namespace creation outcome unknown"), {
            code: "ETIMEDOUT",
          });
        }
        if (denyNamespace) {
          throw Object.assign(new Error("Namespace creation is forbidden"), { statusCode: 403 });
        }
        effects.push("create:Namespace");
        return write("Namespace", body);
      },
      async patchNamespace({ name, body }: FixturePatch) {
        const current = read("Namespace", name);
        assert.equal(body.metadata.resourceVersion, current.metadata.resourceVersion);
        assert.equal(body.metadata.uid, current.metadata.uid);
        for (const field of ["labels", "annotations"] as const) {
          current.metadata[field] ??= {};
          for (const [key, value] of Object.entries(body.metadata[field] ?? {})) {
            if (value === null) {
              delete current.metadata[field][key];
            } else {
              current.metadata[field][key] = value;
            }
          }
        }
        effects.push("patch:Namespace");
        const saved = write("Namespace", current);
        if (releaseReplyLost && body.metadata.annotations?.["openclaw.dev/released-lifecycle"]) {
          releaseReplyLost = false;
          throw new Error("Namespace patch reply was lost");
        }
        return saved;
      },
      deleteNamespace: remove("Namespace"),
      async readNamespacedResourceQuota({
        name,
        namespace,
      }: {
        readonly name: string;
        readonly namespace?: string;
      }) {
        if (quotaReadsToReplacement > 0 && --quotaReadsToReplacement === 0) {
          objects.get(key("ResourceQuota", name, namespace))!.metadata.uid =
            "reassigned-between-reads";
        }
        return read("ResourceQuota", name, namespace);
      },
      async readNamespacedLimitRange({
        name,
        namespace,
      }: {
        readonly name: string;
        readonly namespace?: string;
      }) {
        return read("LimitRange", name, namespace);
      },
      patchNamespacedResourceQuota: patch("ResourceQuota"),
      patchNamespacedLimitRange: patch("LimitRange"),
      deleteNamespacedResourceQuota: remove("ResourceQuota"),
      deleteNamespacedLimitRange: remove("LimitRange"),
      async listNamespacedConfigMap() {
        return { items: [] };
      },
      async listNamespacedServiceAccount() {
        return {
          items: [...objects.values()]
            .filter((resource) => resource.kind === "ServiceAccount")
            .map((resource) => structuredClone(resource)),
        };
      },
      deleteNamespacedServiceAccount: remove("ServiceAccount"),
    },
    objects: {
      async read(reference: {
        readonly kind: string;
        readonly metadata: { readonly name: string; readonly namespace?: string };
      }) {
        return read(reference.kind, reference.metadata.name, reference.metadata.namespace);
      },
    },
    networking: {
      async listNamespacedNetworkPolicy() {
        return { items: [] };
      },
      async readNamespacedNetworkPolicy({
        name,
        namespace,
      }: {
        readonly name: string;
        readonly namespace?: string;
      }) {
        return read("NetworkPolicy", name, namespace);
      },
      patchNamespacedNetworkPolicy: patch("NetworkPolicy"),
      deleteNamespacedNetworkPolicy: remove("NetworkPolicy"),
    },
  };
  const namespace = {
    ...tenant,
    status: "provisioning" as const,
    ...(external ? { existingNamespace: "retained-tenant" } : {}),
  };
  if (external) {
    write("Namespace", {
      apiVersion: "v1",
      metadata: {
        name: namespace.existingNamespace,
        labels: {
          "kubernetes.io/metadata.name": namespace.existingNamespace,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
        annotations: { "openclaw.dev/namespace-lifecycle": "external" },
      },
    });
  }
  const driver = new KubernetesComputeDriver(configuration, selection);
  Object.assign(driver, {
    apiClients: Promise.resolve(clients),
    ...(configuration.executionCluster === undefined
      ? {}
      : {
          executionApiClients: Promise.resolve({
            ...clients,
            lifecycleTarget: { server: "https://execution.example.test", trust: "execution-trust" },
          }),
        }),
  });
  const ready = lifecycle("ready");
  const deleted = { ...ready, target: "deleted" as const };
  return {
    driver,
    clients,
    namespace,
    ready,
    deleted,
    objects,
    effects,
    put: write,
    loseReleaseReply() {
      releaseReplyLost = true;
    },
    denyQuota() {
      denyQuota = true;
    },
    denyNamespace() {
      denyNamespace = true;
    },
    loseNamespaceReply() {
      loseNamespaceReply = true;
    },
    loseQuotaReply() {
      loseQuotaReply = true;
    },
    replaceQuotaOnTailRead() {
      quotaReadsToReplacement = 3;
    },
  };
}

test("Kubernetes Namespace cleanup refuses a same-name replacement before deleting it", async () => {
  const current = fixture();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const physical = [...current.objects.values()].find((value) => value.kind === "Namespace");
  assert.ok(physical);
  physical.metadata.uid = "replacement-uid";
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
  assert.equal(physical.metadata.uid, "replacement-uid");
});

test("Kubernetes external claim release survives a lost reply and refuses a later foreign claim", async () => {
  const current = fixture(true);
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  current.loseReleaseReply();
  const deleting = { ...current.namespace, status: "deleting" as const };
  const lost = await current.driver.deleteNamespace(deleting, current.deleted);
  assert.equal(lost.namespaceDeleted, false);
  assert.equal(lost.failure, "retryable");
  const physical = [...current.objects.values()].find((value) => value.kind === "Namespace");
  assert.ok(physical);
  assert.equal(physical.metadata.labels["openclaw.dev/namespace"], undefined);
  assert.equal(
    physical.metadata.annotations["openclaw.dev/released-lifecycle"],
    current.ready.lifecycleId,
  );
  const effects = current.effects.length;
  assert.equal(
    (await current.driver.deleteNamespace(deleting, current.deleted)).namespaceDeleted,
    true,
  );
  assert.equal(current.effects.length, effects);
  // A saved release receipt never grants authority over a later claim, even if
  // the physical Namespace UID and the old release witness remain unchanged.
  physical.metadata.labels["openclaw.dev/namespace"] = "ns_foreign";
  const refused = await current.driver.deleteNamespace(deleting, current.deleted);
  assert.equal(refused.namespaceDeleted, false);
  assert.equal(refused.failure, "permanent");
  assert.equal(current.effects.length, effects);
});

test("Kubernetes cleanup after an authoritative preparation refusal needs no nonexistent resource UID", async () => {
  const current = fixture();
  current.denyQuota();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  assert.equal(
    [...current.objects.values()].filter((value) => value.kind === "ResourceQuota").length,
    0,
  );
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, true);
  assert.equal(
    [...current.objects.values()].filter((value) => value.kind === "Namespace").length,
    0,
  );
});

test("Kubernetes Namespace cleanup refuses reassigned preparation resources before deletion", async () => {
  const current = fixture(true);
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const quota = [...current.objects.values()].find((value) => value.kind === "ResourceQuota");
  assert.ok(quota);
  quota.metadata.uid = "reassigned-quota-uid";
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
  assert.equal(quota.metadata.uid, "reassigned-quota-uid");
});

test("Kubernetes later creation refusal cannot clear an earlier unknown resource attempt", async () => {
  const current = fixture(true);
  current.loseQuotaReply();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  current.denyQuota();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
  assert.equal(
    [...current.objects.values()].filter((value) => value.kind === "Namespace").length,
    1,
  );
});

test("Kubernetes cleanup rechecks the saved resource UID in its deletion snapshot", async () => {
  const current = fixture(true);
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  // A replacement keeps the ownership metadata but receives a new UID between
  // preflight and the snapshot whose RV will be used for the deletion request.
  current.replaceQuotaOnTailRead();
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
  const quota = [...current.objects.values()].find((value) => value.kind === "ResourceQuota");
  assert.ok(quota);
  assert.equal(quota.metadata.uid, "reassigned-between-reads");
});

test("Kubernetes cancellation after a definitive Namespace create refusal does not require an absent UID", async () => {
  const current = fixture();
  current.denyNamespace();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
    "permanent",
  );
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, true);
  assert.deepEqual(current.effects, []);
});

test("Kubernetes later Namespace create refusal cannot settle an unknown original create", async () => {
  const current = fixture();
  current.loseNamespaceReply();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
    "retryable",
  );
  current.denyNamespace();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
    "permanent",
  );
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.deepEqual(current.effects, []);
});

function sandboxCleanupFixture(state: "absent" | "retained", external = true) {
  let original: FixtureResource;
  const name = "sandbox-bootstrap";
  const sandboxDriver = {
    id: "sandbox-resource-owner",
    implementation: "conformance/resource-owner",
    capability: "sandbox" as const,
    facets: [],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    async ensureNamespace() {
      // This selected component fixture supplies ownership facts only. The actual
      // Compute and SDK sweep are under test; it is not OpenShell/provider proof.
      const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
      const body = {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          name,
          namespace: physical.metadata.name,
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": tenant.id,
          },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      };
      original = current.put("ServiceAccount", body, physical.metadata.name);
    },
    async cleanup() {
      if (state === "absent") {
        current.objects.delete(`ServiceAccount:${original.metadata.namespace}:${name}`);
      }
      const reference = {
        apiVersion: "v1",
        kind: "ServiceAccount",
        namespace: original.metadata.namespace!,
        name,
      };
      return {
        kubernetesResources: [
          state === "absent"
            ? { ...reference, state: "absent" as const }
            : { ...reference, state: "retained" as const, uid: original.metadata.uid },
        ],
      };
    },
  };
  const current = fixture(external, { sandboxDriver });
  return { current, original: () => original, name, sandboxDriver };
}

test("Kubernetes parent sweep refuses a resource that reappears after Sandbox cleanup", async () => {
  const { current, original } = sandboxCleanupFixture("absent");
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const clients = current.clients;
  let inserted = false;
  const list = clients.core.listNamespacedServiceAccount.bind(clients.core);
  clients.core.listNamespacedServiceAccount = async () => {
    if (!inserted) {
      inserted = true;
      const replacement = structuredClone(original());
      replacement.metadata.uid = "replacement-after-child-cleanup";
      current.objects.set(
        `ServiceAccount:${replacement.metadata.namespace}:${replacement.metadata.name}`,
        replacement,
      );
    }
    return list();
  };
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(
    current.effects.some((effect) => effect === "delete:ServiceAccount:sandbox-bootstrap"),
    false,
  );
  assert.equal(
    current.objects.get(`ServiceAccount:${original().metadata.namespace}:sandbox-bootstrap`)
      ?.metadata.uid,
    "replacement-after-child-cleanup",
  );
});

test("Kubernetes parent sweep keeps only the intentionally retained original Sandbox resource", async () => {
  const { current, original } = sandboxCleanupFixture("retained");
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  // This is component coverage of the generic retained-result contract. Production
  // OpenShell operator-owned mode uses preprovisioned Namespace teardown refusal.
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, true);
  assert.equal(
    current.objects.get(`ServiceAccount:${original().metadata.namespace}:sandbox-bootstrap`)
      ?.metadata.uid,
    original().metadata.uid,
  );
  assert.equal(
    current.effects.some((effect) => effect === "delete:ServiceAccount:sandbox-bootstrap"),
    false,
  );
});

test("Kubernetes parent sweep refuses replacement of a retained Sandbox resource", async () => {
  const { current, original } = sandboxCleanupFixture("retained");
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const clients = current.clients;
  const list = clients.core.listNamespacedServiceAccount.bind(clients.core);
  clients.core.listNamespacedServiceAccount = async () => {
    const replacement = structuredClone(original());
    replacement.metadata.uid = "replacement-retained-resource";
    current.objects.set(
      `ServiceAccount:${replacement.metadata.namespace}:${replacement.metadata.name}`,
      replacement,
    );
    return list();
  };
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(
    current.effects.some((effect) => effect === "delete:ServiceAccount:sandbox-bootstrap"),
    false,
  );
});

for (const invalid of [
  "missing",
  "foreign Namespace",
  "duplicate",
  "missing retained UID",
] as const) {
  test(`Kubernetes refuses ${invalid} Sandbox cleanup ownership before parent teardown`, async () => {
    const { current, original, sandboxDriver } = sandboxCleanupFixture("absent");
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
      true,
    );
    const owned = {
      apiVersion: "v1",
      kind: "ServiceAccount",
      namespace: original().metadata.namespace!,
      name: original().metadata.name,
      state: "absent",
    };
    Object.assign(sandboxDriver, {
      async cleanup() {
        if (invalid === "missing") {
          return;
        }
        return {
          kubernetesResources:
            invalid === "foreign Namespace"
              ? [{ ...owned, namespace: "another-tenant" }]
              : invalid === "duplicate"
                ? [owned, owned]
                : [{ ...owned, state: "retained" }],
        };
      },
    });
    const before = current.effects.length;
    const result = await current.driver.deleteNamespace(
      { ...current.namespace, status: "deleting" },
      current.deleted,
    );
    assert.equal(result.namespaceDeleted, false);
    assert.equal(result.failure, "permanent");
    assert.equal(current.effects.length, before);
  });
}

test("Kubernetes parent teardown waits for the cleanup result checkpoint acknowledgment", async () => {
  const { current } = sandboxCleanupFixture("absent");
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const before = current.effects.length;
  const checkpoint = current.deleted.checkpoint;
  Object.assign(current.deleted, {
    checkpoint: async (expected: number, data: Readonly<Record<string, unknown>>) => {
      if (data.cleanup !== undefined) {
        throw new Error("Checkpoint commit outcome unknown");
      }
      return checkpoint(expected, data);
    },
  });
  const refused = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(refused.namespaceDeleted, false);
  assert.equal(current.effects.length, before);
  Object.assign(current.deleted, { checkpoint });
  assert.equal(
    (
      await current.driver.deleteNamespace(
        { ...current.namespace, status: "deleting" },
        current.deleted,
      )
    ).namespaceDeleted,
    true,
  );
});

test("Kubernetes orphan sweep refuses a Namespace replaced during enumeration", async () => {
  const current = fixture(true);
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
  const name = "orphan-in-replacement";
  const list = current.clients.core.listNamespacedServiceAccount;
  current.clients.core.listNamespacedServiceAccount = async () => {
    physical.metadata.uid = "copied-namespace-uid";
    current.put(
      "ServiceAccount",
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          name,
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": tenant.id,
          },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      physical.metadata.name,
    );
    return list();
  };
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(current.effects.includes(`delete:ServiceAccount:${name}`), false);
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.ok(current.objects.has(`ServiceAccount:${physical.metadata.name}:${name}`));
});

test("Kubernetes retained Sandbox identity permits authorized absence without inventing deletion", async () => {
  const { current, original } = sandboxCleanupFixture("retained");
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  current.objects.delete(
    `ServiceAccount:${original().metadata.namespace}:${original().metadata.name}`,
  );
  assert.equal(
    (
      await current.driver.deleteNamespace(
        { ...current.namespace, status: "deleting" },
        current.deleted,
      )
    ).namespaceDeleted,
    true,
  );
  assert.equal(
    current.effects.includes(`delete:ServiceAccount:${original().metadata.name}`),
    false,
  );
});

test("Kubernetes refuses managed Namespace cascade deletion of a retained Sandbox resource", async () => {
  const { current } = sandboxCleanupFixture("retained", false);
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    true,
  );
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
});

for (const rejectedBy of ["Pod Security", "NetworkPolicy"] as const) {
  test(`Kubernetes cancels a never-claimed external selection rejected by ${rejectedBy}`, async () => {
    const current = fixture(true);
    const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
    if (rejectedBy === "Pod Security") {
      physical.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline";
    } else {
      Object.assign(current.clients.networking, {
        async listNamespacedNetworkPolicy() {
          return {
            items: [
              {
                apiVersion: "networking.k8s.io/v1",
                kind: "NetworkPolicy",
                metadata: {
                  name: "operator-policy",
                  namespace: physical.metadata.name,
                  uid: "operator-policy-uid",
                  resourceVersion: "1",
                },
              },
            ],
          };
        },
      });
    }
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
      "permanent",
    );
    assert.equal(physical.metadata.labels["openclaw.dev/namespace"], undefined);
    const before = structuredClone(physical);
    const result = await current.driver.deleteNamespace(
      { ...current.namespace, status: "deleting" },
      current.deleted,
    );
    assert.equal(result.namespaceDeleted, true);
    assert.deepEqual(physical, before);
    assert.deepEqual(current.effects, []);
  });
}

test("Kubernetes does not mistake an unknown external claim for a never-attempted claim", async () => {
  const current = fixture(true);
  Object.assign(current.clients.core, {
    async patchNamespace() {
      throw Object.assign(new Error("Claim response lost"), { code: "ETIMEDOUT" });
    },
  });
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.deepEqual(current.effects, []);
});

test("Kubernetes deletion recovers an infrastructure UID whose binding checkpoint did not commit", async () => {
  const current = fixture(true);
  const checkpoint = current.ready.checkpoint;
  Object.assign(current.ready, {
    checkpoint: async (expected: number, data: Readonly<Record<string, unknown>>) => {
      const resources = data.infrastructure as readonly { readonly uid?: string }[] | undefined;
      if (resources?.some((resource) => resource.uid !== undefined)) {
        throw new Error("UID checkpoint did not commit");
      }
      return checkpoint(expected, data);
    },
  });
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  const quota = [...current.objects.values()].find((value) => value.kind === "ResourceQuota");
  assert.ok(quota);
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, true);
  assert.equal(
    current.objects.has(`ResourceQuota:${quota.metadata.namespace}:${quota.metadata.name}`),
    false,
  );
});

async function repositoryCleanupFixture() {
  const provisioning = fixture(
    true,
    {},
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      network: {
        ...options().network,
        repositoryCredentials: {
          namespace: "repository-service",
          podLabels: { app: "repository" },
          port: 8443,
        },
      },
    }) as KubernetesComputeDriverOptions,
  );
  assert.equal(
    (await provisioning.driver.ensureNamespace(provisioning.namespace, provisioning.ready))
      .namespaceReady,
    true,
  );
  // Material belongs to a previous ready/Agent phase. Namespace teardown starts
  // only after that workflow removed its logical contents, leaving this orphan.
  const current = {
    ...provisioning,
    namespace: { ...provisioning.namespace, status: "ready" as const },
  };
  const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
  const revision = {
    namespaceId: tenant.id,
    agentId: "agt_00000000-0000-4000-8000-000000000019",
    id: "avr_00000000-0000-4000-8000-000000000019",
  };
  const binding = { repositoryRef: "checkout", sessionId: "session_cleanup" };
  const name = repositoryMaterialSecretName(revision, binding);
  // Use the real producer's name and complete session ownership metadata. No
  // credential contents are needed to exercise the actual material Store cleanup.
  const secret = current.put(
    "Secret",
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/repository-material": "session",
          "openclaw.dev/namespace": revision.namespaceId,
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
        },
        annotations: {
          "openclaw.dev/namespace-id": revision.namespaceId,
          "openclaw.dev/agent-id": revision.agentId,
          "openclaw.dev/revision-id": revision.id,
          "openclaw.dev/repository-ref": binding.repositoryRef,
          "openclaw.dev/repository-session-id": binding.sessionId,
          "openclaw.dev/repository-deadline": String(Date.now() + 60000),
        },
      },
    },
    physical.metadata.name,
  );
  const key = `Secret:${physical.metadata.name}:${name}`;
  const missing = () => Object.assign(new Error("Not found"), { statusCode: 404 });
  const material = {
    async listNamespacedPod() {
      return { items: [] };
    },
    async listNamespacedSecret() {
      return {
        items: current.objects.has(key) ? [structuredClone(current.objects.get(key)!)] : [],
      };
    },
    async readNamespacedSecret() {
      const value = current.objects.get(key);
      if (value === undefined) {
        throw missing();
      }
      return structuredClone(value);
    },
    async deleteNamespacedSecret(request: FixtureDelete) {
      current.effects.push(`delete:Secret:${name}`);
      const value = current.objects.get(key);
      if (value === undefined) {
        throw missing();
      }
      assert.equal(request.body.preconditions.uid, value.metadata.uid);
      if (request.body.preconditions.resourceVersion !== undefined) {
        assert.equal(request.body.preconditions.resourceVersion, value.metadata.resourceVersion);
      }
      current.objects.delete(key);
    },
  };
  Object.assign(current.clients.core, material);
  Object.assign(current.clients, {
    apps: {
      async listNamespacedDeployment() {
        return { items: [] };
      },
    },
  });
  return { current, physical, secret, key, material };
}

test("Kubernetes Namespace cleanup refuses replacement placement after repository material LIST", async () => {
  const { current, physical, key, material } = await repositoryCleanupFixture();
  Object.assign(current.clients.core, {
    listNamespacedSecret: async () => {
      physical.metadata.uid = "replacement-namespace-at-material-list";
      current.objects.get(key)!.metadata.uid = "replacement-material-uid";
      return material.listNamespacedSecret();
    },
  });
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(
    current.effects.some((effect) => effect.startsWith("delete:Secret:")),
    false,
  );
  assert.equal(current.objects.get(key)?.metadata.uid, "replacement-material-uid");
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
});

test("Kubernetes Namespace material cleanup deletes the unchanged UID and resourceVersion", async () => {
  const { current, secret, material } = await repositoryCleanupFixture();
  Object.assign(current.clients.core, {
    deleteNamespacedSecret: async (request: FixtureDelete) => {
      assert.equal(request.body.preconditions.resourceVersion, secret.metadata.resourceVersion);
      return material.deleteNamespacedSecret(request);
    },
  });
  assert.equal(
    (
      await current.driver.deleteNamespace(
        { ...current.namespace, status: "deleting" },
        current.deleted,
      )
    ).namespaceDeleted,
    true,
  );
});

test("Kubernetes Namespace cleanup discards material snapshots after placement disappearance", async () => {
  const { current, physical, key, material } = await repositoryCleanupFixture();
  Object.assign(current.clients.core, {
    listNamespacedSecret: async () => {
      const snapshot = await material.listNamespacedSecret();
      current.objects.delete(`Namespace::${physical.metadata.name}`);
      current.objects.delete(key);
      return snapshot;
    },
  });
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(
    current.effects.some((effect) => effect.startsWith("delete:Secret:")),
    false,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, undefined);
});

test("Kubernetes unclaimed cancellation refuses a changed or foreign external Namespace", async () => {
  for (const reassigned of ["UID", "claim"] as const) {
    const current = fixture(true);
    const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
    physical.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline";
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
      "permanent",
    );
    if (reassigned === "UID") {
      physical.metadata.uid = "replacement-before-claim";
    } else {
      physical.metadata.labels["openclaw.dev/namespace"] = "ns_other";
    }
    const result = await current.driver.deleteNamespace(
      { ...current.namespace, status: "deleting" },
      current.deleted,
    );
    assert.equal(result.namespaceDeleted, false);
    assert.equal(result.failure, "permanent");
    assert.deepEqual(current.effects, []);
  }
});

test("Kubernetes attempted infrastructure recovery refuses a missing creation marker", async () => {
  const current = fixture(true);
  current.loseQuotaReply();
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  const physical = [...current.objects.values()].find((value) => value.kind === "Namespace")!;
  const quota = current.put(
    "ResourceQuota",
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: {
        name: "openclaw-quota",
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace": tenant.id,
        },
        annotations: { "openclaw.dev/namespace-id": tenant.id },
      },
    },
    physical.metadata.name,
  );
  const before = current.effects.length;
  const result = await current.driver.deleteNamespace(
    { ...current.namespace, status: "deleting" },
    current.deleted,
  );
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
  assert.equal(current.effects.length, before);
  assert.equal(
    current.objects.get(`ResourceQuota:${physical.metadata.name}:${quota.metadata.name}`)?.metadata
      .uid,
    quota.metadata.uid,
  );
});

for (const scope of ["tenant Namespace", "Gateway Namespace", "infrastructure"] as const) {
  test(`Kubernetes does not replay unknown ${scope} creation and can bind late original readback`, async () => {
    const base = options();
    const configuration =
      scope === "Gateway Namespace"
        ? routedOptions({
            runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
            executionCluster: {
              authentication: { ...base.authentication, context: "execution-cluster" },
              harnessRouting: {
                ...gatewayRouting,
                gatewayName: "harnesses",
                hostname: "harness.example.test",
              },
              network: {
                dns: base.network.dns,
                harnessEndpointCidrs: ["192.0.2.2/32"],
                gatewayEndpointCidrs: ["192.0.2.1/32"],
                pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
              },
            },
          })
        : base;
    const current = fixture(false, {}, configuration as KubernetesComputeDriverOptions);
    let requests = 0;
    let pending: FixtureResource | undefined;
    if (scope === "infrastructure") {
      const apply = current.clients.core.patchNamespacedResourceQuota;
      current.clients.core.patchNamespacedResourceQuota = async (request) => {
        requests++;
        if (requests === 1) {
          pending = structuredClone(request.body) as FixtureResource;
          throw Object.assign(new Error("Create response unknown"), { code: "ETIMEDOUT" });
        }
        const body = request.body as FixtureResource;
        const original = current.objects.get(
          `ResourceQuota:${body.metadata.namespace}:${body.metadata.name}`,
        );
        assert.ok(original);
        assert.equal(body.metadata.uid, original.metadata.uid);
        assert.equal(body.metadata.resourceVersion, original.metadata.resourceVersion);
        return apply(request);
      };
    } else {
      const create = current.clients.core.createNamespace;
      current.clients.core.createNamespace = async (request) => {
        const body = request.body as FixtureResource;
        const selected =
          scope === "tenant Namespace" ||
          body.metadata.name === kubernetesGatewayNamespaceName(tenant.id);
        if (selected) {
          requests++;
          if (requests === 1) {
            pending = structuredClone(body);
            throw Object.assign(new Error("Create response unknown"), { code: "ETIMEDOUT" });
          }
        }
        return create(request);
      };
    }
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
      false,
    );
    assert.equal(requests, 1);
    const retry = await current.driver.ensureNamespace(current.namespace, current.ready);
    assert.equal(requests, 1, "an unknown request must not be resubmitted on an absent read");
    assert.equal(retry.namespaceReady, false);
    assert.ok(pending);
    // The original request eventually becomes visible. Its saved creation marker
    // authorizes original readback, unlike creating another resource while unknown.
    const original = current.put(pending.kind, pending, pending.metadata.namespace);
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
      true,
    );
    const saved = await current.ready.read();
    const recorded = {
      "tenant Namespace": () => (saved.data.namespace as { uid: string }).uid,
      "Gateway Namespace": () => (saved.data.gateway as { uid: string }).uid,
      infrastructure: () =>
        (saved.data.infrastructure as { name: string; uid: string }[]).find(
          (item) => item.name === pending!.metadata.name,
        )?.uid,
    }[scope]();
    assert.equal(recorded, original.metadata.uid);
  });
}

for (const boundary of [
  "first PATCH refusal",
  "unknown then PATCH refusal",
  "verification GET refusal",
] as const) {
  test(`Kubernetes external claim preserves ${boundary} evidence during cancellation`, async () => {
    const current = fixture(true);
    const patch = current.clients.core.patchNamespace;
    const read = current.clients.core.readNamespace;
    let calls = 0;
    let denyRead = false;
    current.clients.core.patchNamespace = async (request) => {
      calls++;
      if (boundary === "unknown then PATCH refusal" && calls === 1) {
        throw Object.assign(new Error("Claim outcome unknown"), { code: "ETIMEDOUT" });
      }
      if (boundary !== "verification GET refusal") {
        throw Object.assign(new Error("Claim forbidden"), { statusCode: 403 });
      }
      const response = await patch(request);
      denyRead = true;
      return response;
    };
    current.clients.core.readNamespace = async (request) => {
      if (denyRead) {
        throw Object.assign(new Error("Verification forbidden"), { statusCode: 403 });
      }
      return read(request);
    };
    assert.equal(
      (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
      false,
    );
    if (boundary === "unknown then PATCH refusal") {
      assert.equal(
        (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
        false,
      );
      assert.equal(calls, 2);
    }
    denyRead = false;
    current.clients.core.patchNamespace = patch;
    const journal = await current.ready.read();
    const phase = (journal.data.namespace as { claim: string }).claim;
    assert.equal(phase, boundary === "first PATCH refusal" ? "refused" : "attempted");
    const result = await current.driver.deleteNamespace(
      { ...current.namespace, status: "deleting" },
      current.deleted,
    );
    if (boundary === "unknown then PATCH refusal") {
      assert.equal(result.namespaceDeleted, false);
      assert.equal(result.failure, "permanent");
    } else {
      assert.equal(result.namespaceDeleted, true);
    }
  });
}

test("Kubernetes never adopts a Namespace appearing after a definitive create refusal", async () => {
  const current = fixture();
  let refused: FixtureResource | undefined;
  const create = current.clients.core.createNamespace;
  current.clients.core.createNamespace = async (request) => {
    refused = structuredClone(request.body) as FixtureResource;
    throw Object.assign(new Error("Creation forbidden"), { statusCode: 403 });
  };
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).failure,
    "permanent",
  );
  assert.ok(refused);
  const unexpected = current.put("Namespace", refused);
  current.clients.core.createNamespace = create;
  // The denied request created nothing. Even matching copied intent metadata
  // cannot make this new server UID the resource that request did not create.
  assert.equal(
    (await current.driver.ensureNamespace(current.namespace, current.ready)).namespaceReady,
    false,
  );
  const saved = await current.ready.read();
  assert.equal((saved.data.namespace as { uid?: string }).uid, undefined);
  assert.equal(
    [...current.objects.values()].find((value) => value.kind === "Namespace")?.metadata.uid,
    unexpected.metadata.uid,
  );
});
