import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Namespace, NamespaceLifecycleHooks } from "@openclaw-enterprise/contracts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { captureNamespaceHint } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import {
  reconcileNamespaceLifecycle,
  selectedNamespaceLifecycle,
} from "../../packages/occ/src/namespace-lifecycle.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { gatewayRouting, routedOptions } from "../helpers/kubernetes-routed-options.ts";
import { routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  kubernetesList,
  kubernetesNotFound,
  startKubernetesSdkApi,
  type KubernetesSdkResponse,
} from "../helpers/kubernetes-sdk-api.ts";

const namespace: Namespace = {
  id: "namespace-a",
  name: "support",
  status: "provisioning",
  createdAt: "2026-11-06T00:00:00Z",
};
const signal = () => new AbortController().signal;

function owner(id: string, namespaceLifecycleHooks: NamespaceLifecycleHooks) {
  return {
    id,
    implementation: "lifecycle-contract-fixture",
    capability: "configuration" as const,
    namespaceLifecycleHooks,
  };
}

test("Namespace reconciliation stops at pending Compute and retries participants in registration order", async () => {
  const effects: string[] = [];
  let infrastructureReady = false;
  let providerReady = false;
  const compute = createReadyComputeDriver("compute", {
    async ensureNamespace() {
      return { namespaceId: namespace.id, namespaceReady: infrastructureReady };
    },
  });
  const first = owner("a", {
    async ensureNamespace() {
      effects.push("a");
      return { namespaceId: namespace.id, namespaceReady: providerReady };
    },
  });
  const last = owner("z", {
    async ensureNamespace() {
      effects.push("z");
      return { namespaceId: namespace.id, namespaceReady: true };
    },
  });
  const participants = selectedNamespaceLifecycle([last, first, first]);
  const run = () =>
    reconcileNamespaceLifecycle(compute, participants, namespace, "ready", signal(), () => {});
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: false });
  assert.deepEqual(effects, []);
  infrastructureReady = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: false });
  assert.deepEqual(effects, ["a"]);
  providerReady = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: true });
  assert.deepEqual(effects, ["a", "a", "z"]);
});

test("Namespace hooks cannot change scope or expose thrown provider details", async () => {
  const compute = createReadyComputeDriver("compute");
  for (const ensureNamespace of [
    async () => ({ namespaceId: "foreign", namespaceReady: true }),
    async () => ({ namespaceId: namespace.id, namespaceReady: true, namespaceDeleted: true }),
    async () => ({ namespaceId: namespace.id, installationId: "foreign", namespaceReady: true }),
  ]) {
    const result = await reconcileNamespaceLifecycle(
      compute,
      selectedNamespaceLifecycle([owner("provider", { ensureNamespace })]),
      namespace,
      "ready",
      signal(),
      () => {},
    );
    assert.deepEqual(result, {
      namespaceId: namespace.id,
      namespaceReady: false,
      failure: "permanent",
    });
  }
  const mutable = structuredClone(namespace);
  const result = await reconcileNamespaceLifecycle(
    compute,
    selectedNamespaceLifecycle([
      owner("provider", {
        async ensureNamespace({ namespace: snapshot }) {
          assert.throws(() => Object.assign(snapshot, { id: "foreign" }), TypeError);
          throw new Error("provider response must stay private");
        },
      }),
    ]),
    mutable,
    "ready",
    signal(),
    () => {},
  );
  assert.deepEqual(result, {
    namespaceId: namespace.id,
    namespaceReady: false,
    failure: "retryable",
  });
  assert.deepEqual(mutable, namespace);
});

test("lost Namespace claims start no later hooks and perform no compensation", async () => {
  const abort = new AbortController();
  const effects: string[] = [];
  const participants = selectedNamespaceLifecycle([
    owner("a", {
      async ensureNamespace({ signal: supplied }) {
        assert.equal(supplied, abort.signal);
        effects.push("prepared");
        abort.abort();
        return { namespaceId: namespace.id, namespaceReady: true };
      },
      async deleteNamespace() {
        effects.push("compensated");
        return { namespaceId: namespace.id, namespaceDeleted: true };
      },
    }),
    owner("b", {
      async ensureNamespace() {
        effects.push("late");
        return { namespaceId: namespace.id, namespaceReady: true };
      },
    }),
  ]);
  await assert.rejects(
    reconcileNamespaceLifecycle(
      createReadyComputeDriver("compute"),
      participants,
      namespace,
      "ready",
      abort.signal,
      () => {},
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(effects, ["prepared"]);
});

test("Namespace deletion checks eligibility before reverse cleanup and infrastructure removal", async () => {
  const effects: string[] = [];
  let allowed = false;
  let complete = false;
  let unclaimed = false;
  const compute = createReadyComputeDriver("compute", {
    async checkNamespaceDeletion() {
      return {
        namespaceId: namespace.id,
        deletionAllowed: allowed,
        ...(unclaimed ? { skipParticipantCleanup: true as const } : {}),
        ...(allowed ? {} : { failure: "permanent" as const }),
      };
    },
    async deleteNamespace() {
      effects.push("infrastructure");
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
  });
  const participants = selectedNamespaceLifecycle(
    ["a", "z"].map((id) =>
      owner(id, {
        async ensureNamespace() {
          return { namespaceId: namespace.id, namespaceReady: true };
        },
        async deleteNamespace() {
          effects.push(id);
          return { namespaceId: namespace.id, namespaceDeleted: complete };
        },
      }),
    ),
  );
  const run = () =>
    reconcileNamespaceLifecycle(compute, participants, namespace, "deleted", signal(), () => {});
  assert.deepEqual(await run(), {
    namespaceId: namespace.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
  assert.deepEqual(effects, []);
  allowed = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: false });
  assert.deepEqual(effects, ["z"]);
  complete = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: true });
  assert.deepEqual(effects, ["z", "z", "a", "infrastructure"]);
  // An unclaimed external namespace cannot be passed to provider cleanup.
  unclaimed = true;
  effects.length = 0;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: true });
  assert.deepEqual(effects, ["infrastructure"]);
});

const backingName = kubernetesNamespaceName(tenant.id);
const absent = kubernetesNotFound("namespaces", backingName);
const forbidden = {
  status: 403,
  body: { apiVersion: "v1", kind: "Status", status: "Failure", reason: "Forbidden", code: 403 },
};

async function strandsDeletion(t: TestContext) {
  const backing = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: backingName,
      uid: "tenant-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    status: { phase: "Active" },
  };
  const state = {
    phase: "active" as "active" | "terminating" | "absent",
    listFailure: undefined as KubernetesSdkResponse | undefined,
    afterDeniedList: undefined as KubernetesSdkResponse | undefined,
    deletions: 0,
  };
  const resources = [
    ["v1", "Namespace", "namespaces"],
    ["v1", "Service", "services"],
    ["v1", "ConfigMap", "configmaps"],
    ["apps/v1", "Deployment", "deployments"],
    ["networking.k8s.io/v1", "NetworkPolicy", "networkpolicies"],
  ] as const;
  const prefix = (version: string) => (version === "v1" ? "/api/v1" : `/apis/${version}`);
  const path = `/api/v1/namespaces/${backingName}`;
  let deniedList = false;
  const api = await startKubernetesSdkApi(t, {
    name: "strands-deletion",
    respond({ method, pathname, body }) {
      if (method === "DELETE" && pathname === path) {
        assert.equal(state.phase, "active");
        assert.deepEqual(body, { preconditions: { uid: backing.metadata.uid } });
        state.deletions++;
        state.phase = "terminating";
        return { body: { ...backing, status: { phase: "Terminating" } } };
      }
      if (method !== "GET") {
        return undefined;
      }
      const current =
        state.phase === "terminating" ? { ...backing, status: { phase: "Terminating" } } : backing;
      if (pathname === "/api/v1/namespaces") {
        return {
          body: kubernetesList("v1", "Namespace", state.phase === "absent" ? [] : [current]),
        };
      }
      if (pathname === path) {
        if (deniedList && state.afterDeniedList) {
          return state.afterDeniedList;
        }
        return state.phase === "absent" ? absent : { body: current };
      }
      if (
        state.phase === "absent" &&
        pathname.startsWith(`/apis/apps/v1/namespaces/${backingName}/deployments/`)
      ) {
        return forbidden;
      }
      const discovery = resources.filter(([version]) => pathname === prefix(version));
      if (discovery.length) {
        return {
          body: {
            apiVersion: "v1",
            kind: "APIResourceList",
            groupVersion: discovery[0]![0],
            resources: discovery.map(([, kind, name]) => ({
              kind,
              name,
              singularName: kind.toLowerCase(),
              namespaced: kind !== "Namespace",
              verbs: ["get", "list"],
            })),
          },
        };
      }
      for (const [version, kind, name] of resources) {
        if (
          kind !== "Namespace" &&
          pathname === `${prefix(version)}/namespaces/${backingName}/${name}`
        ) {
          // Deleting the namespace also deletes the worker's tenant RoleBindings.
          if (state.listFailure || state.phase === "absent") {
            deniedList = true;
            return state.listFailure ?? forbidden;
          }
          return { body: kubernetesList(version, kind, []) };
        }
      }
      return undefined;
    },
  });
  const options = routedOptions({ authentication: api.authentication });
  const sandbox = new StrandsBoxSandboxDriver(
    {
      kubernetes: {
        seccompProfile: "strands.json",
        nodeSelector: { "kubernetes.io/arch": "arm64" },
        controlPlanePeer: { namespace: "controller", podLabels: { app: "controller" } },
      },
      policy: { network: { endpoints: [] } },
    },
    {
      id: "strands",
      authentication: api.authentication,
      dns: options.network.dns,
      routing: gatewayRouting,
    },
  );
  const compute = new KubernetesComputeDriver(options, { sandboxDriver: sandbox });
  const external = owner("external", {
    async ensureNamespace() {
      return { namespaceId: tenant.id, namespaceReady: true };
    },
    async deleteNamespace() {
      return { namespaceId: tenant.id, namespaceDeleted: true };
    },
  });
  const participants = selectedNamespaceLifecycle(
    [external, sandbox],
    [sandboxNamespaceLifecycleBinding(compute, sandbox)],
  );
  const outcomes: string[] = [];
  const run = () => {
    deniedList = false;
    outcomes.length = 0;
    return captureNamespaceHint(() =>
      reconcileNamespaceLifecycle(
        compute,
        participants,
        { ...tenant, status: "deleting" },
        "deleted",
        signal(),
        ({ registrationId, outcome }) => {
          outcomes.push(`${registrationId} ${outcome}`);
        },
      ),
    );
  };
  return { state, outcomes, run, compute, sandbox };
}

test("Strands cleanup lets other participants and Compute finish after Kubernetes deletes the tenant namespace", async (t) => {
  const { state, run, outcomes, compute } = await strandsDeletion(t);
  assert.deepEqual(await run(), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false },
  });
  assert.deepEqual(outcomes, ["strands complete", "external complete", `${compute.id} pending`]);
  assert.equal(state.phase, "terminating");

  state.phase = "absent";
  assert.deepEqual(await run(), {
    observation: { namespaceId: tenant.id, namespaceDeleted: true },
  });
  assert.deepEqual(outcomes, ["strands complete", "external complete", `${compute.id} complete`]);
  assert.equal(state.deletions, 1);
});

test("Strands cleanup stays blocked unless the exact tenant namespace is confirmed absent", async (t) => {
  const { state, run, outcomes } = await strandsDeletion(t);
  state.listFailure = forbidden;
  assert.deepEqual(await run(), {
    observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
    hintCode: "KUBERNETES_TENANT_ACCESS_DENIED",
  });
  assert.deepEqual(outcomes, ["strands permanent"]);
  state.listFailure = kubernetesNotFound("deployments", "other", "apps");
  assert.deepEqual((await run()).observation, {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });

  // Eligibility saw the namespace. A later failed list cannot establish what happened to it.
  state.listFailure = forbidden;
  for (const response of [
    forbidden,
    kubernetesNotFound("namespaces", "another-tenant"),
    kubernetesNotFound("deployments", backingName, "apps"),
    kubernetesNotFound("namespaces", backingName, "other.example"),
    { status: 404, body: { ...absent.body, details: { kind: "namespaces" } } },
    { status: 404, body: { ...absent.body, status: "Success" } },
    { status: 404, body: { ...absent.body, reason: "Forbidden" } },
    { status: 404, body: { ...absent.body, code: 403 } },
    { status: 404, body: {} },
    { status: 403, body: absent.body },
  ]) {
    state.afterDeniedList = response;
    assert.deepEqual(await run(), {
      observation: { namespaceId: tenant.id, namespaceDeleted: false, failure: "permanent" },
      hintCode: "KUBERNETES_TENANT_ACCESS_DENIED",
    });
    assert.deepEqual(outcomes, ["strands permanent"]);
  }
  assert.equal(state.deletions, 0);
});

test("Strands revision cleanup still reports a forbidden Deployment read after namespace deletion", async (t) => {
  const { state, compute, sandbox } = await strandsDeletion(t);
  state.phase = "absent";
  const context = await compute.resolveSandboxNamespaceContext(
    { ...tenant, status: "ready" },
    signal(),
  );
  const revision = routedRevision(
    { id: compute.id, implementation: compute.implementation },
    { sandboxDriverId: sandbox.id },
  );
  await assert.rejects(sandbox.cleanup({ ...context, revision }), { code: 403 });
});
