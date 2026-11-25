import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type {
  AppsV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  NetworkingV1Api,
  V1Container,
  V1DeleteOptions,
  V1DeploymentStatus,
  V1EndpointSlice,
  V1NetworkPolicySpec,
  V1ObjectMeta,
  V1PodSpec,
  V1PodStatus,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";

const coreKinds = [
  "Secret",
  "ConfigMap",
  "ServiceAccount",
  "Service",
  "PersistentVolumeClaim",
  "ResourceQuota",
  "LimitRange",
] as const;
type CoreKind = (typeof coreKinds)[number];
type ResourceKind = CoreKind | "Deployment" | "NetworkPolicy";

type FixtureMetadata = Omit<V1ObjectMeta, "deletionTimestamp"> & {
  name: string;
  deletionTimestamp?: string;
};

interface FixtureObject {
  kind: string;
  apiVersion?: string;
  metadata: FixtureMetadata;
  spec?: object;
  status?: object;
  type?: string;
  immutable?: boolean;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
}

export interface FixtureSecret extends FixtureObject {
  kind: "Secret";
  data: Record<string, string>;
}

type FixtureContainer = V1Container & {
  env: NonNullable<V1Container["env"]>;
  volumeMounts: NonNullable<V1Container["volumeMounts"]>;
};

type FixturePodSpec = Omit<V1PodSpec, "containers" | "initContainers"> & {
  containers: [FixtureContainer, ...FixtureContainer[]];
  initContainers: FixtureContainer[];
  volumes: NonNullable<V1PodSpec["volumes"]>;
};

export interface FixtureDeployment extends FixtureObject {
  kind: "Deployment";
  metadata: FixtureMetadata & {
    namespace: string;
    generation: number;
    annotations: Record<string, string>;
  };
  spec: {
    template: {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: FixturePodSpec;
    };
  };
  status?: V1DeploymentStatus;
}

export interface FixturePod extends FixtureObject {
  kind: "Pod";
  spec: FixturePodSpec;
  status?: V1PodStatus;
}

export interface FixtureNetworkPolicy extends FixtureObject {
  kind: "NetworkPolicy";
  spec: V1NetworkPolicySpec & { podSelector: { matchLabels: Record<string, string> } };
}

export type MaterialApiCall =
  | { operation: "write" | "delete"; kind: ResourceKind; name: string }
  | { operation: "patchPod"; kind?: never; name: string; namespace: string }
  | { operation: "listPods"; kind?: never; name?: never };

type ResourceReadRequest = Parameters<CoreV1Api["readNamespacedSecret"]>[0];
type ResourceListRequest = Parameters<CoreV1Api["listNamespacedSecret"]>[0];
type ResourceDeleteRequest = Parameters<CoreV1Api["deleteNamespacedSecret"]>[0];
type ResourceWriteRequest = { namespace?: string; body: FixtureObject };
type MaterialPolicyWriteRequest = Omit<
  Parameters<NetworkingV1Api["replaceNamespacedNetworkPolicy"]>[0],
  "body"
> & { body: FixtureNetworkPolicy };
type MaterialSecretCreateRequest = Omit<
  Parameters<CoreV1Api["createNamespacedSecret"]>[0],
  "body"
> & { body: FixtureObject & { kind: "Secret" } };
type CoreMethodRequest<Name extends keyof CoreV1Api> = NonNullable<
  CoreV1Api[Name] extends (request: infer Request, ...rest: never[]) => unknown ? Request : never
>;

type PodProxy = (
  request: CoreMethodRequest<"connectGetNamespacedPodProxyWithPath">,
) => Promise<unknown>;

export interface KubernetesMaterialClients {
  core: {
    listNamespace: (
      request: CoreMethodRequest<"listNamespace">,
    ) => Promise<{ items: FixtureObject[] }>;
    readNamespace: (request: CoreMethodRequest<"readNamespace">) => Promise<FixtureObject>;
    createNamespace: (request: { body: FixtureObject }) => Promise<FixtureObject>;
    deleteNamespace: (request: CoreMethodRequest<"deleteNamespace">) => Promise<object>;
    patchNamespace: (request: { body: FixtureObject }) => Promise<void>;
    listNamespacedPod: (
      request: CoreMethodRequest<"listNamespacedPod">,
    ) => Promise<{ items: FixturePod[]; metadata?: { continue: string } }>;
    patchNamespacedPod: (request: CoreMethodRequest<"patchNamespacedPod">) => Promise<object>;
    connectGetNamespacedPodProxyWithPath?: PodProxy;
    createNamespacedSecret: (request: MaterialSecretCreateRequest) => Promise<FixtureObject>;
    listNamespacedSecret: (request: ResourceListRequest) => Promise<{ items: FixtureObject[] }>;
  };
  apps: {
    readNamespacedDeployment: (
      request: Parameters<AppsV1Api["readNamespacedDeployment"]>[0],
    ) => Promise<FixtureObject>;
    deleteNamespacedDeployment: (
      request: Parameters<AppsV1Api["deleteNamespacedDeployment"]>[0],
    ) => Promise<void>;
  };
  networking: {
    readNamespacedNetworkPolicy: (
      request: Parameters<NetworkingV1Api["readNamespacedNetworkPolicy"]>[0],
    ) => Promise<FixtureNetworkPolicy>;
    patchNamespacedNetworkPolicy: (request: ResourceWriteRequest) => Promise<FixtureObject>;
    replaceNamespacedNetworkPolicy: (request: MaterialPolicyWriteRequest) => Promise<FixtureObject>;
  };
  discovery: {
    listNamespacedEndpointSlice: (
      request: Parameters<DiscoveryV1Api["listNamespacedEndpointSlice"]>[0],
    ) => Promise<{
      items: Array<{
        metadata: {
          labels: Record<string, string>;
          ownerReferences: Array<{ kind: string; name: string; uid: string | undefined }>;
        };
        endpoints: Array<Pick<NonNullable<V1EndpointSlice["endpoints"]>[number], "conditions">>;
      }>;
    }>;
  };
  objects: {
    read: (request: FixtureObject) => Promise<FixtureObject>;
    patch: (request: FixtureObject) => Promise<FixtureObject>;
    delete: (
      request: FixtureObject,
      pretty?: string,
      dryRun?: string,
      grace?: number,
      orphan?: boolean,
      propagation?: string,
      body?: V1DeleteOptions,
    ) => Promise<void>;
  };
}

export function isFixtureDeployment(object: FixtureObject): object is FixtureDeployment {
  return object.kind === "Deployment";
}

export function isFixtureNetworkPolicy(object: FixtureObject): object is FixtureNetworkPolicy {
  return object.kind === "NetworkPolicy";
}

export function createKubernetesMaterialFixture(namespace: string, repositoryBroker?: boolean) {
  const objects = new Map<string, FixtureObject>();
  const calls: MaterialApiCall[] = [];
  const apiCalls: string[] = [];
  let pods: FixturePod[] = [];
  let observePods: (() => void | Promise<void>) | undefined;
  const key = (kind: string, name: string, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const failure = (statusCode: number) =>
    Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  const matching = (object: { metadata: FixtureMetadata }, selector?: string) =>
    (selector ?? "")
      .split(",")
      .filter(Boolean)
      .every((item) => {
        const [name, value] = item.split("=");
        return name !== undefined && object.metadata.labels?.[name] === value;
      });
  const save = (object: FixtureObject) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const objectsApi: KubernetesMaterialClients["objects"] = {
    read: async ({ kind, metadata }) => {
      const object = objects.get(key(kind, metadata.name));
      if (!object) {
        throw failure(404);
      }
      return structuredClone(object);
    },
    patch: async (object) => {
      const previous = objects.get(key(object.kind, object.metadata.name));
      const stored = structuredClone(object);
      stored.metadata.uid = previous?.metadata.uid ?? `${object.kind}-${object.metadata.name}-uid`;
      stored.metadata.resourceVersion = String(Number(previous?.metadata.resourceVersion ?? 0) + 1);
      save(stored);
      return structuredClone(stored);
    },
    delete: async (object, _pretty, _dryRun, _grace, _orphan, _propagation, body) => {
      const existing = objects.get(key(object.kind, object.metadata.name));
      if (!existing) {
        throw failure(404);
      }
      assert.ok(body?.preconditions);
      if (
        existing.metadata.uid !== body.preconditions.uid ||
        existing.metadata.resourceVersion !== body.preconditions.resourceVersion
      ) {
        throw failure(409);
      }
      objects.delete(key(object.kind, object.metadata.name));
    },
  };
  function resourceMethods(kind: ResourceKind) {
    const read = async ({ name, namespace: target }: ResourceReadRequest) => {
      const object = objects.get(key(kind, name, target));
      if (!object) {
        throw failure(404);
      }
      return structuredClone(object);
    };
    const list = async ({ labelSelector, namespace: target }: ResourceListRequest) => ({
      items: structuredClone(
        [...objects.values()].filter(
          (object) =>
            object.kind === kind &&
            object.metadata.namespace === target &&
            matching(object, labelSelector),
        ),
      ),
    });
    const write = async ({ body }: ResourceWriteRequest) => {
      calls.push({ operation: "write", kind, name: body.metadata.name });
      const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
      const object = structuredClone(body);
      if (object.stringData) {
        object.data = Object.fromEntries(
          Object.entries(object.stringData).map(([name, value]) => [
            name,
            Buffer.from(value).toString("base64"),
          ]),
        );
        delete object.stringData;
      }
      object.metadata.uid = previous?.metadata.uid ?? `${kind}-${body.metadata.name}-uid`;
      object.metadata.generation =
        (previous?.metadata.generation ?? 0) +
        (previous && isDeepStrictEqual(previous.spec, object.spec) ? 0 : 1);
      if (previous?.status) {
        object.status = structuredClone(previous.status);
      }
      object.metadata.resourceVersion = String(object.metadata.generation);
      save(object);
      return structuredClone(object);
    };
    const create = async (request: ResourceWriteRequest) => {
      if (objects.has(key(kind, request.body.metadata.name, request.namespace))) {
        throw failure(409);
      }
      return write(request);
    };
    const remove = async ({ name, body, namespace: target }: ResourceDeleteRequest) => {
      const object = objects.get(key(kind, name, target));
      if (!object) {
        throw failure(404);
      }
      if (body?.preconditions?.uid && body.preconditions.uid !== object.metadata.uid) {
        throw failure(409);
      }
      calls.push({ operation: "delete", kind, name });
      objects.delete(key(kind, name, target));
    };
    return { read, list, create, write, remove };
  }

  function additionalResourceMethods(
    kind: ResourceKind,
    methods: ReturnType<typeof resourceMethods>,
  ) {
    return {
      [`readNamespaced${kind}`]: methods.read,
      [`listNamespaced${kind}`]: methods.list,
      [`replaceNamespaced${kind}`]: methods.write,
      [`patchNamespaced${kind}`]: methods.write,
      [`createNamespaced${kind}`]: methods.create,
      [`deleteNamespaced${kind}`]: methods.remove,
    };
  }
  const secret = resourceMethods("Secret");
  const deployment = resourceMethods("Deployment");
  const policy = resourceMethods("NetworkPolicy");
  const core: KubernetesMaterialClients["core"] = {
    listNamespace: async ({ labelSelector }) => ({
      items: [...objects.values()].filter(
        (object) => object.kind === "Namespace" && matching(object, labelSelector),
      ),
    }),
    readNamespace: async ({ name }) => {
      const observed = objects.get(key("Namespace", name));
      if (!observed) {
        throw failure(404);
      }
      return structuredClone(observed);
    },
    createNamespace: async ({ body }) => {
      const observed = {
        ...body,
        metadata: { ...body.metadata, uid: `${body.metadata.name}-uid` },
        status: { phase: "Active" },
      };
      save(observed);
      return observed;
    },
    deleteNamespace: async ({ name, body }) => {
      const existing = objects.get(key("Namespace", name));
      assert.ok(existing && body?.preconditions);
      assert.equal(body.preconditions.uid, existing.metadata.uid);
      objects.delete(key("Namespace", name));
      for (const [id, object] of objects) {
        if (object.metadata.namespace === name) {
          objects.delete(id);
        }
      }
      return {};
    },
    patchNamespace: async ({ body }) => {
      const previous = objects.get(key("Namespace", body.metadata.name));
      assert.ok(previous);
      save({ ...previous, ...body, metadata: { ...previous.metadata, ...body.metadata } });
    },
    listNamespacedPod: async ({ labelSelector, namespace: target }) => {
      calls.push({ operation: "listPods" });
      if (observePods) {
        await observePods();
      }
      return {
        items: structuredClone(
          pods.filter((pod) => pod.metadata.namespace === target && matching(pod, labelSelector)),
        ),
      };
    },
    // Annotation patches that sync a running Harness after its node setup is written.
    patchNamespacedPod: async ({ name, namespace: target }) => {
      calls.push({ operation: "patchPod", name, namespace: target });
      return {};
    },
    createNamespacedSecret: secret.create,
    listNamespacedSecret: secret.list,
  };
  for (const kind of coreKinds) {
    Object.assign(
      core,
      additionalResourceMethods(kind, kind === "Secret" ? secret : resourceMethods(kind)),
    );
  }
  if (repositoryBroker === false) {
    // Without that endpoint the chart grants the worker no Secret list (rbac.yaml).
    core.listNamespacedSecret = async () => {
      throw failure(403);
    };
  }
  const apps = {
    ...additionalResourceMethods("Deployment", deployment),
    readNamespacedDeployment: deployment.read,
    deleteNamespacedDeployment: deployment.remove,
  };
  const networking = {
    ...additionalResourceMethods("NetworkPolicy", policy),
    async readNamespacedNetworkPolicy(
      request: Parameters<
        KubernetesMaterialClients["networking"]["readNamespacedNetworkPolicy"]
      >[0],
    ) {
      const object = await policy.read(request);
      assert.ok(isFixtureNetworkPolicy(object));
      return object;
    },
    replaceNamespacedNetworkPolicy: policy.write,
    patchNamespacedNetworkPolicy: policy.write,
  };
  const discovery: KubernetesMaterialClients["discovery"] = {
    async listNamespacedEndpointSlice({ labelSelector, namespace: target }) {
      const name = labelSelector?.split("=")[1];
      assert.ok(typeof name === "string");
      const service = objects.get(key("Service", name, target));
      assert.ok(service);
      return {
        items: [
          {
            metadata: {
              labels: { "kubernetes.io/service-name": name },
              ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
            },
            endpoints: [{ conditions: { ready: true } }],
          },
        ],
      };
    },
  };
  const clients: KubernetesMaterialClients = {
    core,
    apps,
    networking,
    discovery,
    objects: objectsApi,
  };

  function traceMethods<T extends object>(group: string, api: T) {
    for (const method of Object.keys(api) as (keyof T)[]) {
      const invoke: unknown = api[method];
      assert.ok(typeof invoke === "function");
      // Each existing method is wrapped with its original argument list.
      api[method] = ((...args: unknown[]) => {
        apiCalls.push(`${group}.${String(method)}`);
        return (invoke as (...args: unknown[]) => unknown)(...args);
      }) as T[keyof T];
    }
  }

  function startTracing() {
    calls.length = 0;
    traceMethods("core", clients.core);
    traceMethods("apps", clients.apps);
    traceMethods("networking", clients.networking);
    traceMethods("discovery", clients.discovery);
    traceMethods("objects", clients.objects);
  }
  return {
    objects,
    calls,
    apiCalls,
    save,
    clients,
    startTracing,
    deployments: () => [...objects.values()].filter(isFixtureDeployment),
    setPods(value: FixturePod[]) {
      pods = value;
    },
    observePods(value: (() => void | Promise<void>) | undefined) {
      observePods = value;
    },
  };
}
