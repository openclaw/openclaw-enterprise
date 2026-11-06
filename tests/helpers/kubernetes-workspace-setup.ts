import assert from "node:assert/strict";
import {
  KubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  tenant,
  authContext,
  options,
  digest,
  routedOptions,
  routedRevision,
  labelSelectorLabels,
} from "./kubernetes-routed-scenarios.mjs";

type FixtureObject = {
  apiVersion?: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  stringData?: Record<string, string>;
  data?: Record<string, string>;
  status?: unknown;
  [key: string]: unknown;
};
type Address = { name: string; namespace?: string | undefined };
type DeleteRequest = Address & { body: { preconditions: { uid: string } } };
type PodRequest = { namespace: string; labelSelector?: string };
// This view exposes only the existing transport seam used by the fixture.
export type FixtureDriver = Omit<KubernetesComputeDriver, never> & {
  options: KubernetesComputeDriver["options"];
  manifest: KubernetesComputeDriver["manifest"];
  gatewayNamespaceManifest: KubernetesComputeDriver["gatewayNamespaceManifest"];
  networkPolicies: KubernetesComputeDriver["networkPolicies"];
  apiClients: Promise<ReturnType<typeof workspaceSetupFixture>["clients"]>;
  nodeEnrollment: NonNullable<KubernetesComputeDriver["nodeEnrollment"]>;
};
// These fixtures substitute Kubernetes transport only. Preparation, ownership, private delivery,
// redaction, readiness, and completed-payload retention run through the production driver.
export function workspaceSetupFixture(
  embedded: boolean,
  runtime = true,
  network: Record<string, unknown> | undefined = undefined,
  computeOptions: Record<string, unknown> = {},
  driverDependencies = {},
  { adopted = false } = {},
) {
  const state: {
    ready: boolean;
    secretFailure: boolean;
    failedInitializer: boolean;
    jobFailure?: string;
    jobPods?: unknown[];
    initializerExitCode?: number;
  } = {
    ready: false,
    secretFailure: false,
    failedInitializer: false,
  };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      ...(network === undefined ? {} : { network }),
      resources: {
        gateway: {
          requests: { cpu: "200m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
        agent: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
        namespace: options().resources.namespace,
      },
      ...(runtime
        ? { runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" } }
        : {}),
      ...computeOptions,
    }) as ConstructorParameters<typeof KubernetesComputeDriver>[0],
    {
      ...driverDependencies,
      nodeEnrollment: {
        async createSetup() {
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup() {
          return state.ready
            ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
            : undefined;
        },
        async isConnected() {
          return state.ready;
        },
      },
    },
  ) as unknown as FixtureDriver;
  const revision = routedRevision(driver, {
    configuration: {
      gateway: routedRevision(driver).configuration.gateway,
      agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } },
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  // An adopted Installation keeps its released storage namespace as the tenant namespace.
  const namespace = adopted
    ? kubernetesGatewayNamespaceName(tenant.id)
    : kubernetesNamespaceName(tenant.id);
  const control =
    computeOptions.executionCluster === undefined
      ? namespace
      : kubernetesGatewayNamespaceName(tenant.id);
  const objects = new Map<string, FixtureObject>();
  const records: FixtureObject[] = [];
  const key = (kind: string, name: string, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (body: FixtureObject) => {
    const existing = objects.get(key(body.kind, body.metadata.name, body.metadata.namespace));
    const object = structuredClone(body);
    if (object.stringData) {
      object.data = Object.fromEntries(
        Object.entries(object.stringData).map(([key, value]) => [
          key,
          Buffer.from(value).toString("base64"),
        ]),
      );
      delete object.stringData;
    }
    object.metadata = {
      ...object.metadata,
      uid: existing?.metadata.uid ?? body.metadata.uid ?? `${body.metadata.name}-uid`,
      resourceVersion: String(Number(existing?.metadata.resourceVersion ?? 0) + 1),
      generation: 1,
    };
    objects.set(key(body.kind, body.metadata.name, body.metadata.namespace), object);
    return object;
  };
  const tenantNamespace = driver.manifest("v1", "Namespace", namespace, {
    namespaceId: tenant.id,
  });
  if (adopted) {
    tenantNamespace.metadata.labels!["openclaw.dev/gateway-namespace"] = tenant.id;
  }
  save({ ...tenantNamespace, status: { phase: "Active" } });
  if (!adopted) {
    save({
      ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
      status: { phase: "Active" },
    });
  }
  save({
    ...driver.manifest(
      "v1",
      "Secret",
      `transport-${digest(revision.agentId)}`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: embedded ? namespace : control, plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver.manifest(
        "v1",
        "Secret",
        `transport-${digest(revision.agentId)}`,
        { namespaceId: tenant.id, agentId: revision.agentId },
        {
          name: embedded ? namespace : control,
          plane: "control",
        },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
      ...(embedded ? { "gateway-password": Buffer.from("test-password").toString("base64") } : {}),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: control,
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: control, plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  const read =
    (kind: string) =>
    async ({ name, namespace: target }: Address) => {
      const object = objects.get(key(kind, name, target));
      if (object === undefined) {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      }
      const observed = structuredClone(object);
      if (kind === "Deployment" && state.ready) {
        observed.status = {
          observedGeneration: 1,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
        };
      }
      if (kind === "Job") {
        observed.status = {
          conditions: state.jobFailure
            ? [{ type: "Failed", status: "True", reason: state.jobFailure }]
            : state.ready
              ? [{ type: "Complete", status: "True" }]
              : [],
        };
      }
      return observed;
    };
  const write = async ({ body }: { body: FixtureObject }) => {
    if (body.kind === "Secret" && state.secretFailure) {
      throw Object.assign(new Error(`Rejected ${JSON.stringify(body)}`), { statusCode: 403 });
    }
    records.push(structuredClone(body));
    return save(body);
  };
  const remove =
    (kind: string) =>
    async ({ name, namespace: target, body }: DeleteRequest) => {
      const existing = objects.get(key(kind, name, target));
      assert.ok(existing);
      assert.equal(body.preconditions.uid, existing.metadata.uid);
      objects.delete(key(kind, name, target));
    };
  const core = {
    async listNamespace() {
      // Without a labelled namespace the resolver falls back to the canonical tenant name.
      return { items: adopted ? [structuredClone(objects.get(key("Namespace", namespace)))] : [] };
    },
    readNamespace: read("Namespace"),
    async listNamespacedPod({ namespace: target, labelSelector }: PodRequest) {
      const labels = labelSelectorLabels(labelSelector);
      const gateway = objects.get(key("Deployment", `gateway-${digest(revision.agentId)}`, target));
      const revisionId = labels["openclaw.dev/revision"];
      if (
        !embedded &&
        labels["openclaw.dev/workload-role"] === "gateway" &&
        gateway?.metadata.annotations?.["openclaw.dev/agent-revision-id"] === revisionId
      ) {
        // The running dedicated Gateway; its wrapper reports the applied node.
        return {
          items: [
            {
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                name: `gateway-pod-${revisionId}`,
                namespace: target,
                uid: `gateway-uid-${revisionId}`,
                labels,
              },
              status: { phase: "Running", podIP: "10.42.0.14" },
            },
          ],
        };
      }
      if (state.jobPods !== undefined && labels["openclaw.dev/namespace"] === undefined) {
        // Job-owned pods; the termination wait (namespace-labelled selector) sees none.
        return { items: structuredClone(state.jobPods) };
      }
      return {
        items:
          state.failedInitializer &&
          labels["openclaw.dev/workload-role"] === (embedded ? "gateway" : "agent")
            ? [
                {
                  apiVersion: "v1",
                  kind: "Pod",
                  metadata: {
                    name: "failed-initializer",
                    namespace,
                    labels,
                  },
                  status: {
                    initContainerStatuses: [
                      {
                        name: "initialize-workspace",
                        state: {
                          terminated: {
                            exitCode: state.initializerExitCode ?? 1,
                            finishedAt: "2026-09-22T00:00:00Z",
                            message: "private-content-must-not-escape",
                          },
                        },
                      },
                    ],
                  },
                },
              ]
            : [],
      };
    },
    async deleteNamespacedSecret({ name, body }: DeleteRequest) {
      const existing = objects.get(key("Secret", name));
      assert.ok(existing);
      assert.equal(body.preconditions.uid, existing.metadata.uid);
      objects.delete(key("Secret", name));
    },
    async patchNamespacedPod({ body }: { body: FixtureObject }) {
      return body;
    },
    async connectGetNamespacedPodProxyWithPath({ name, path }: { name: string; path: string }) {
      const revisionId = name.replace(/^gateway-pod-/u, "").replace(/:\d+$/u, "");
      if (path !== "openclaw/runtime/status") {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return {
        revisionId,
        container: "gateway",
        podUid: `gateway-uid-${revisionId}`,
        workspaceNodeId: "node-1",
      };
    },
  };
  for (const kind of [
    "ConfigMap",
    "ServiceAccount",
    "Service",
    "PersistentVolumeClaim",
    "Secret",
  ]) {
    Object.assign(core, { [`readNamespaced${kind}`]: read(kind) });
    Object.assign(core, { [`patchNamespaced${kind}`]: write });
    Object.assign(core, { [`deleteNamespaced${kind}`]: remove(kind) });
  }
  Object.assign(core, { createNamespacedSecret: write });
  Object.assign(core, { replaceNamespacedSecret: write });
  const clients = {
    core,
    apps: {
      readNamespacedDeployment: read("Deployment"),
      patchNamespacedDeployment: write,
      deleteNamespacedDeployment: remove("Deployment"),
    },
    batch: {
      readNamespacedJob: read("Job"),
      createNamespacedJob: write,
      deleteNamespacedJob: remove("Job"),
    },
    objects: {
      read: async (object: FixtureObject) =>
        read(object.kind)({ name: object.metadata.name, namespace: object.metadata.namespace }),
      patch: async (body: FixtureObject) => write({ body }),
      delete: async (
        object: FixtureObject,
        _pretty: unknown,
        _dryRun: unknown,
        _grace: unknown,
        _orphan: unknown,
        _propagation: unknown,
        body: DeleteRequest["body"],
      ) =>
        remove(object.kind)({
          name: object.metadata.name,
          namespace: object.metadata.namespace,
          body,
        }),
    },
    networking: {
      readNamespacedNetworkPolicy: read("NetworkPolicy"),
      patchNamespacedNetworkPolicy: write,
      deleteNamespacedNetworkPolicy: remove("NetworkPolicy"),
    },
    discovery: {
      async listNamespacedEndpointSlice({ labelSelector }: { labelSelector: string }) {
        const name = labelSelector.split("=")[1];
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": name },
                ownerReferences: [{ kind: "Service", name, uid: `${name}-uid` }],
              },
              endpoints: [{ conditions: { ready: state.ready } }],
            },
          ],
        };
      },
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve(clients) });
  const setup = {
    id: "setup-private",
    namespaceId: tenant.id,
    agentId: revision.agentId,
    files: { "AGENTS.md": "private-create-documents", "USER.md": "" },
    completed: false,
  };
  const context = { ...authContext(revision, control), workspaceSetup: setup };
  return { driver, revision, namespace, objects, records, state, setup, context, clients };
}
