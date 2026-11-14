import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  ComputeAgentBinding,
  ComputeRevisionContext,
  HarnessExecutionMode,
  LoggingLevel,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

export const namespace = Object.freeze({
  id: "ns_runtime_00000000-0000-4000-8000-000000000001",
  name: "Runtime credential tenant",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
} satisfies ComputeAgentBinding["namespace"]);
export const agent = Object.freeze({
  id: "agt_runtime_00000000-0000-4000-8000-000000000001",
  namespaceId: namespace.id,
  name: "Runtime credential Agent",
  configurationId: "cfg_runtime_00000000-0000-4000-8000-000000000001",
  backendId: null,
  desiredRuntimeState: "stopped",
  status: "active",
  harnessAuth: null,
  gatewayManagedMode: true,
  executionMode: "dedicated",
  servicePrincipalId: "sp_runtime_00000000-0000-4000-8000-000000000001",
  createdAt: namespace.createdAt,
} satisfies ComputeAgentBinding["agent"]);

export const executionModes = [
  "dedicated",
  "embedded",
] as const satisfies readonly HarnessExecutionMode[];

export const embeddedFirstModes = [executionModes[1], executionModes[0]] as const;

type Ownership = { namespaceId: string; agentId?: string };

export type NamespaceTarget = { name: string; plane: "control" | "execution" };

type FixtureMetadata = {
  name: string;
  namespace?: string;
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
};

type FixtureObject = {
  apiVersion: string;
  kind: string;
  metadata: FixtureMetadata;
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
};

export type StoredSecret = FixtureObject & { type?: string; stringData?: Record<string, string> };
type ConfirmableSecret = StoredSecret & { data: Record<string, string> };

type NamespaceList = { labelSelector: string };
type ReadName = { name: string };
type NamespacedName = ReadName & { namespace: string };
type DeploymentList = NamespaceList & { namespace: string };
type DeleteRequest = NamespacedName & { body?: { preconditions?: { uid?: string } } };
type CreateRequest = { namespace: string; body: StoredSecret };
type CreateSecret = (request: CreateRequest) => Promise<StoredSecret>;

type NamedCallKind =
  | "readClaim"
  | "deleteClaim"
  | "readConfigMap"
  | "deleteConfigMap"
  | "readSecret"
  | "createSecret"
  | "deleteSecret";

type ObservedCall =
  | { kind: "listNamespace"; request: NamespaceList }
  | { kind: "readNamespace"; request: ReadName }
  | { kind: "listDeployments"; request: DeploymentList }
  | { [Kind in NamedCallKind]: { kind: Kind; name: string } }[NamedCallKind];

type FixtureOptions = {
  secrets?: Record<string, StoredSecret>;
  deployments?: FixtureObject[];
  claims?: Record<string, FixtureObject>;
  configMaps?: Record<string, FixtureObject>;
  runtime?: boolean;
  namespaceReadStatus?: number;
  twoCluster?: boolean;
  secretReadStatus?: number;
  secretCreateStatus?: number;
  observeCreatedSecret?: (secret: ConfirmableSecret) => ConfirmableSecret;
  createSecret?: (request: CreateRequest, store: CreateSecret) => Promise<StoredSecret>;
  deploymentListStatus?: number;
};

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

export function binding(): ComputeAgentBinding {
  return { namespace, agent };
}

function isStringMap(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((item) => typeof item === "string");
}

function isFixtureObject(value: unknown): value is FixtureObject {
  const resource = asRecord(value);
  const metadata = asRecord(resource?.metadata);
  return (
    typeof resource?.apiVersion === "string" &&
    typeof resource.kind === "string" &&
    typeof metadata?.name === "string" &&
    (metadata.namespace === undefined || typeof metadata.namespace === "string") &&
    (metadata.uid === undefined || typeof metadata.uid === "string") &&
    isStringMap(metadata.labels) &&
    isStringMap(metadata.annotations) &&
    (resource.data === undefined || isStringMap(resource.data)) &&
    (resource.spec === undefined || asRecord(resource.spec) !== undefined)
  );
}

type ManifestKind = "Namespace" | "Secret" | "ConfigMap" | "Deployment";

type PrivateMethods = {
  manifest: [
    apiVersion: string,
    kind: ManifestKind,
    name: string,
    ownership: Ownership,
    target?: NamespaceTarget,
  ];
  gatewayNamespaceManifest: [ownership: Ownership];
  harnessWorkspaceClaim: [agentId: string, ownership: Ownership, target: NamespaceTarget];
  gatewayPrivateStateClaim: [agentId: string, ownership: Ownership, target: NamespaceTarget];
  ensureLegacyGatewayPassword: [
    ownership: Pick<AgentRevision, "namespaceId" | "agentId">,
    target: NamespaceTarget,
  ];
  gatewayConfiguration: [revision: AgentRevision];
  harnessAuthForRevision: [
    revision: AgentRevision,
    context: ComputeRevisionContext,
    target: NamespaceTarget,
  ];
  deployment: [
    name: string,
    ownership: Ownership,
    target: NamespaceTarget,
    image: string,
    serviceAccount: string,
    role: "gateway",
    environment: Readonly<Record<string, string>>,
    loggingLevel: LoggingLevel,
    snapshot: unknown,
    embedded: true,
    servicePrincipalId: string,
    auth: unknown,
  ];
};

// The Driver's private builders are erased from its declarations. Keep the
// fixture arguments typed and check the returned fields where they are used.
export function callKubernetesFixtureMethod<Method extends keyof PrivateMethods>(
  driver: KubernetesComputeDriver,
  method: Method,
  args: PrivateMethods[Method],
): unknown {
  const invoke: unknown = Reflect.get(driver, method);
  assert.ok(typeof invoke === "function", method);
  const result: unknown = Reflect.apply(invoke, driver, args);
  return result;
}

type ResourceBuilder =
  "manifest" | "gatewayNamespaceManifest" | "harnessWorkspaceClaim" | "gatewayPrivateStateClaim";

function fixtureObject<Method extends ResourceBuilder>(
  driver: KubernetesComputeDriver,
  method: Method,
  args: PrivateMethods[Method],
): FixtureObject {
  const object = callKubernetesFixtureMethod(driver, method, args);
  assert.ok(isFixtureObject(object), method);
  return object;
}

function fixtureDriver(driver: KubernetesComputeDriver) {
  return {
    manifest: (...args: PrivateMethods["manifest"]) => fixtureObject(driver, "manifest", args),
    harnessWorkspaceClaim: (...args: PrivateMethods["harnessWorkspaceClaim"]) =>
      fixtureObject(driver, "harnessWorkspaceClaim", args),
    gatewayPrivateStateClaim: (...args: PrivateMethods["gatewayPrivateStateClaim"]) =>
      fixtureObject(driver, "gatewayPrivateStateClaim", args),
    async ensureLegacyGatewayPassword(
      ...args: PrivateMethods["ensureLegacyGatewayPassword"]
    ): Promise<void> {
      await callKubernetesFixtureMethod(driver, "ensureLegacyGatewayPassword", args);
    },
  };
}

function options(runtime: boolean, twoCluster: boolean): KubernetesComputeDriverOptions {
  const configured = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
    ...(runtime
      ? {
          runtime: {
            transportSecretPrefix: "transport",
            gatewayStorageClassName: "local-path",
            channels: { proxyUrl: "http://10.42.0.15:3128" },
          },
        }
      : {}),
  });
  if (!twoCluster) {
    return configured;
  }
  const { gatewayClients: _gatewayClients, ...network } = configured.network;
  const gatewayRouting = {
    hostname: "gateway.example.test",
    gatewayName: "gateway",
    gatewayNamespace: "system",
    envoyNamespace: "envoy",
  };
  return {
    ...configured,
    network,
    gatewayRouting,
    executionCluster: {
      authentication: { ...configured.authentication, context: "execution" },
      harnessRouting: { ...gatewayRouting, hostname: "harness.example.test" },
      network: {
        dns: network.dns,
        harnessEndpointCidrs: ["192.0.2.2/32"],
        gatewayEndpointCidrs: ["192.0.2.1/32"],
        pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
      },
    },
  };
}

export function credentialFixture({
  secrets = {},
  deployments = [],
  claims = {},
  configMaps = {},
  runtime = true,
  namespaceReadStatus = 200,
  twoCluster = false,
  secretReadStatus,
  secretCreateStatus,
  observeCreatedSecret = (secret) => secret,
  createSecret,
  deploymentListStatus,
}: FixtureOptions = {}) {
  const driver = createKubernetesComputeDriver(options(runtime, twoCluster));
  const resources = fixtureDriver(driver);
  const namespaceName = kubernetesNamespaceName(namespace.id);
  const namespaceObject = {
    ...resources.manifest("v1", "Namespace", namespaceName, { namespaceId: namespace.id }),
    status: { phase: "Active" },
  };
  const controlNamespace = twoCluster
    ? {
        ...fixtureObject(driver, "gatewayNamespaceManifest", [
          { namespaceId: namespace.id } satisfies Ownership,
        ]),
        status: { phase: "Active" },
      }
    : undefined;
  const calls: ObservedCall[] = [];
  const created: StoredSecret[] = [];
  const deleted: string[] = [];
  const locate = <Resource extends FixtureObject>(
    resources: Record<string, Resource>,
    request: NamespacedName,
  ) =>
    Object.entries(resources).find(
      ([, value]) =>
        value.metadata.name === request.name && value.metadata.namespace === request.namespace,
    );
  const storeSecret: CreateSecret = async (request) => {
    calls.push({ kind: "createSecret", name: request.body.metadata.name });
    if (secretCreateStatus !== undefined) {
      throw httpError(secretCreateStatus);
    }
    assert.equal(request.namespace, controlNamespace?.metadata.name ?? namespaceName);
    created.push(structuredClone(request.body));
    const observed = observeCreatedSecret({
      ...request.body,
      metadata: { ...request.body.metadata, uid: `${request.body.metadata.name}-uid` },
      data:
        request.body.data ??
        Object.fromEntries(
          Object.entries(request.body.stringData ?? {}).map(([key, value]) => [key, encode(value)]),
        ),
    });
    secrets[observed.metadata.name] = observed;
    return structuredClone(observed);
  };
  const core = {
    async listNamespace(request: NamespaceList) {
      calls.push({ kind: "listNamespace", request: structuredClone(request) });
      const [label, owner] = request.labelSelector.split("=");
      assert.ok(label !== undefined);
      return {
        items: [namespaceReadStatus === 404 ? undefined : namespaceObject, controlNamespace]
          .filter((value) => value !== undefined && value.metadata.labels[label] === owner)
          .map((value) => structuredClone(value)),
      };
    },
    async readNamespace(request: ReadName) {
      calls.push({ kind: "readNamespace", request: structuredClone(request) });
      if (controlNamespace !== undefined && request.name === controlNamespace.metadata.name) {
        return structuredClone(controlNamespace);
      }
      assert.equal(request.name, namespaceName);
      if (namespaceReadStatus !== 200) {
        throw httpError(namespaceReadStatus);
      }
      return structuredClone(namespaceObject);
    },
    async readNamespacedPersistentVolumeClaim(request: NamespacedName) {
      calls.push({ kind: "readClaim", name: request.name });
      const claim = locate(claims, request)?.[1];
      if (claim === undefined) {
        throw httpError(404);
      }
      return structuredClone(claim);
    },
    async deleteNamespacedPersistentVolumeClaim(request: DeleteRequest) {
      const entry = locate(claims, request);
      assert.ok(entry);
      const [key, claim] = entry;
      assert.equal(request.namespace, claim.metadata.namespace);
      assert.equal(request.body?.preconditions?.uid, claim.metadata.uid);
      calls.push({ kind: "deleteClaim", name: request.name });
      delete claims[key];
      return {};
    },
    async readNamespacedConfigMap(request: NamespacedName) {
      calls.push({ kind: "readConfigMap", name: request.name });
      const configMap = locate(configMaps, request)?.[1];
      if (configMap === undefined) {
        throw httpError(404);
      }
      return structuredClone(configMap);
    },
    async deleteNamespacedConfigMap(request: DeleteRequest) {
      const entry = locate(configMaps, request);
      assert.ok(entry);
      const [key, configMap] = entry;
      assert.equal(request.body?.preconditions?.uid, configMap.metadata.uid);
      calls.push({ kind: "deleteConfigMap", name: request.name });
      delete configMaps[key];
      return {};
    },
    async readNamespacedSecret(request: NamespacedName) {
      calls.push({ kind: "readSecret", name: request.name });
      if (secretReadStatus !== undefined) {
        throw httpError(secretReadStatus);
      }
      const secret = locate(secrets, request)?.[1];
      if (secret === undefined) {
        throw httpError(404);
      }
      return structuredClone(secret);
    },
    createNamespacedSecret(request: CreateRequest) {
      return createSecret === undefined ? storeSecret(request) : createSecret(request, storeSecret);
    },
    async deleteNamespacedSecret(request: DeleteRequest) {
      calls.push({ kind: "deleteSecret", name: request.name });
      const entry = locate(secrets, request);
      if (entry === undefined) {
        throw httpError(404);
      }
      const [key, secret] = entry;
      if (secret.metadata.uid !== undefined) {
        assert.equal(request.body?.preconditions?.uid, secret.metadata.uid);
      }
      deleted.push(request.name);
      delete secrets[key];
      return {};
    },
  };
  const apps = {
    async listNamespacedDeployment(request: DeploymentList) {
      calls.push({ kind: "listDeployments", request: structuredClone(request) });
      if (deploymentListStatus !== undefined && request.namespace === namespaceName) {
        throw httpError(deploymentListStatus);
      }
      assert.ok([namespaceName, controlNamespace?.metadata.name].includes(request.namespace));
      assert.equal(
        request.labelSelector,
        `openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id}`,
      );
      return {
        items: deployments
          .filter((deployment) => deployment.metadata.namespace === request.namespace)
          .map((deployment) => structuredClone(deployment)),
      };
    },
  };
  const clients = Promise.resolve({ core, apps });
  assert.ok(Reflect.set(driver, "apiClients", clients));
  assert.ok(Reflect.set(driver, "executionApiClients", clients));
  return { driver, resources, namespaceName, calls, created, deleted };
}

export function runtimeSecret(
  resources: ReturnType<typeof fixtureDriver>,
  prefix: string,
  data: Record<string, string>,
  overrides: { uid?: string; data?: Record<string, string> } = {},
) {
  const secret = resources.manifest(
    "v1",
    "Secret",
    `${prefix}-${digest(agent.id)}`,
    { namespaceId: namespace.id, agentId: agent.id },
    { name: kubernetesNamespaceName(namespace.id), plane: "control" },
  );
  if (overrides.uid !== undefined) {
    secret.metadata.uid = overrides.uid;
  }
  return {
    ...secret,
    type: "Opaque",
    data:
      overrides.data ??
      Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
  };
}
