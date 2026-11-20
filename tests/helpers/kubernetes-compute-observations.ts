import assert from "node:assert/strict";
import type { AgentRevision, AgentRevisionResponse } from "../../packages/contracts/src/index.ts";
import {
  agentName,
  gatewayName,
  harnessWorkspaceClaimName,
  hash,
  kubectlRead,
  resource,
  resources,
  waitFor,
} from "./kubernetes-compute-real.mjs";

type WireObject = Record<string, unknown>;
type GatewaySnapshot = Pick<
  AgentRevision | AgentRevisionResponse["data"],
  "id" | "configurationId" | "configurationGeneration" | "configuration" | "harness"
> & { gatewayManagedMode?: boolean };
type DeploymentObservation = {
  metadata: { annotations: WireObject; generation?: unknown; uid?: unknown };
  spec: { replicas?: unknown; strategy?: unknown; template?: unknown };
  status: { observedGeneration?: unknown; readyReplicas?: unknown };
};
type SnapshotDeploymentObservation = DeploymentObservation & {
  spec: DeploymentObservation["spec"] & {
    template: { spec: { volumes: unknown[]; containers?: unknown } };
  };
};
type ClaimObservation = {
  metadata: {
    namespace?: unknown;
    labels?: unknown;
    annotations?: unknown;
    name: string;
    uid: string;
  };
  spec: { accessModes?: unknown; resources?: unknown; storageClassName?: unknown };
  status: { phase?: unknown; capacity?: unknown };
};

const sharedWorkspaceSize = "40Gi";

function isObject(value: unknown): value is WireObject {
  return value !== null && typeof value === "object";
}

function object(value: unknown): WireObject {
  if (!isObject(value)) {
    throw new TypeError("Expected a Kubernetes or configuration object");
  }
  return value;
}

function objectMember<T extends object, K extends string>(
  value: T,
  key: K,
): asserts value is T & Record<K, WireObject> {
  object(field(value, key));
}

function arrayMember<T extends object, K extends string>(
  value: T,
  key: K,
): asserts value is T & Record<K, unknown[]> {
  array(field(value, key));
}

function assertResourceName(
  resource: unknown,
  expected: string,
  description: string,
): asserts resource is { metadata: { name: string } } {
  const observed = optionalField(optionalField(resource, "metadata"), "name");
  assert.ok(observed === expected, `${description} must have the requested name`);
}

export function assertResourceUid(
  resource: { metadata: WireObject },
  description: string,
): asserts resource is { metadata: WireObject & { uid: string } } {
  const { uid } = resource.metadata;
  assert.ok(typeof uid === "string" && uid.trim().length > 0, `${description} must have a UID`);
}

function assertString(value: unknown, message?: string): asserts value is string {
  if (message === undefined) {
    assert.equal(typeof value, "string");
  } else {
    assert.equal(typeof value, "string", message);
  }
}

function observeGatewayMetadata<T extends { metadata: WireObject }>(
  deployment: T,
): asserts deployment is T & { metadata: WireObject & { annotations: WireObject } } {
  objectMember(deployment.metadata, "annotations");
}

function observeGatewayVolumes(
  deployment: DeploymentObservation,
): asserts deployment is SnapshotDeploymentObservation {
  objectMember(deployment.spec, "template");
  objectMember(deployment.spec.template, "spec");
  arrayMember(deployment.spec.template.spec, "volumes");
}

// Property reads preserve JavaScript's boxing and nullish failures without claiming
// that the rest of a kubectl object or native configuration has been validated.
function field(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read ${key} from a nullish value`);
  }
  const target: object = Object(value);
  const result: unknown = Reflect.get(target, key);
  return result;
}

function optionalField(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : field(value, key);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected an array");
  }
  return value;
}

function spread(value: unknown): WireObject {
  if (value === null || value === undefined) {
    return {};
  }
  const target: object = Object(value);
  return { ...target };
}

function entries(value: unknown): [string, unknown][] {
  if (value === null || value === undefined) {
    throw new TypeError("Cannot convert a nullish value to an object");
  }
  const target: object = Object(value);
  return Object.entries(target);
}

function atLeast(left: unknown, right: unknown): boolean {
  // The old JavaScript assertion used >=, including its string comparison and
  // numeric coercion for values received from kubectl JSON.
  const leftPrimitive = left !== null && typeof left === "object" ? String(left) : left;
  const rightPrimitive = right !== null && typeof right === "object" ? String(right) : right;
  return typeof leftPrimitive === "string" && typeof rightPrimitive === "string"
    ? leftPrimitive >= rightPrimitive
    : Number(leftPrimitive) >= Number(rightPrimitive);
}

function expectedGatewayDocument(snapshot: GatewaySnapshot): WireObject {
  const configuration = snapshot.configuration;
  const configuredGateway = field(configuration, "gateway");
  const configuredAuth = optionalField(configuredGateway, "auth");
  const configuredProxy = optionalField(configuredAuth, "trustedProxy");
  const allowUsers = optionalField(configuredProxy, "allowUsers") ?? [];
  const requiresScopes = array(allowUsers).some((user) => user !== "occ-workspace-files");
  const configuredAgents = field(configuration, "agents");
  const configuredDefaults = optionalField(configuredAgents, "defaults");
  const configuredEntries = optionalField(configuredAgents, "entries");
  const configuredMain = optionalField(configuredEntries, "main");
  const document: WireObject = {
    ...spread(configuration),
    ...(snapshot.harness.id === "codex" && snapshot.harness.mode === "dedicated"
      ? {
          // The paired Harness owns the real filesystem; the Gateway keeps a
          // writable local key for native chat preparation and the main Agent.
          agents: {
            ...spread(configuredAgents),
            defaults: { ...spread(configuredDefaults), workspace: "/home/node/workspace" },
            ...(configuredMain === undefined
              ? {}
              : {
                  entries: {
                    ...spread(configuredEntries),
                    main: { ...spread(configuredMain), workspace: "/home/node/workspace" },
                  },
                }),
          },
        }
      : {}),
    gateway: {
      ...spread(configuredGateway),
      // Compute renders an all-interfaces listener for an omitted or auto bind.
      bind: "lan",
      trustedProxies: ["127.0.0.1/32"],
      allowRealIpFallback: true,
      auth: {
        ...spread(configuredAuth),
        mode: "trusted-proxy",
        trustedProxy: {
          ...spread(configuredProxy),
          ...(requiresScopes
            ? {
                // Human identities require the scopes header; machine-only access does not.
                requiredHeaders: [
                  ...array(optionalField(configuredProxy, "requiredHeaders") ?? []),
                  ...(array(optionalField(configuredProxy, "requiredHeaders") ?? []).some(
                    (header) => {
                      if (typeof header !== "string") {
                        throw new TypeError("header.toLowerCase is not a function");
                      }
                      return header.toLowerCase() === "x-openclaw-scopes";
                    },
                  )
                    ? []
                    : ["x-openclaw-scopes"]),
                ],
              }
            : {}),
          userHeader: "x-occ-identity",
          allowUsers: optionalField(configuredProxy, "allowUsers") ?? ["occ-workspace-files"],
        },
        identityScopes: optionalField(configuredAuth, "identityScopes") ?? {
          "occ-workspace-files": ["operator.admin"],
        },
      },
    },
  };
  const provider = field(snapshot.harness.configuration, "modelProvider");
  if (snapshot.harness.id === "openclaw" && provider !== undefined) {
    const models = document.models;
    const providers = optionalField(models, "providers");
    document.models = {
      ...spread(models),
      providers: {
        ...spread(providers),
        openai: {
          ...spread(optionalField(providers, "openai")),
          api:
            field(provider, "protocol") === "openai-responses"
              ? "openai-responses"
              : "openai-completions",
          baseUrl: field(provider, "baseUrl"),
        },
      },
    };
  }
  if (snapshot.harness.id === "codex" && provider !== undefined) {
    // Only the paired Harness receives the provider credential and makes model requests.
    const model = field(field(field(configuration, "agents"), "defaults"), "model");
    assertString(model, "these cluster fixtures select one primary model");
    assert.ok(model.startsWith("codex/"));
    const id = model.slice("codex/".length);
    const rendered = `codex/openai-compatible/${id}`;
    const defaults = object(field(field(document, "agents"), "defaults"));
    defaults.model = rendered;
    const policies = defaults.models;
    if (policies !== undefined) {
      defaults.models = Object.fromEntries(
        entries(policies).map(([ref, policy]) => [ref === model ? rendered : ref, policy]),
      );
    }
    const models = document.models;
    document.models = {
      ...spread(models),
      providers: {
        ...spread(optionalField(models, "providers")),
        codex: { models: [{ id: `openai-compatible/${id}`, name: id }] },
      },
    };
  }
  return document;
}

export function assertReadyGateway(
  namespaceName: string,
  agentId: string,
  namespaceId: string | undefined,
  snapshot: GatewaySnapshot,
): Promise<SnapshotDeploymentObservation>;
export function assertReadyGateway(
  namespaceName: string,
  agentId: string,
  namespaceId?: string,
  snapshot?: undefined,
): Promise<DeploymentObservation>;
export async function assertReadyGateway(
  namespaceName: string,
  agentId: string,
  namespaceId?: string,
  snapshot?: GatewaySnapshot,
): Promise<DeploymentObservation | SnapshotDeploymentObservation> {
  let observedSnapshot: SnapshotDeploymentObservation | undefined;
  const name = gatewayName(agentId);
  const raw: unknown = await resource("deployment", name, namespaceName);
  const deployment = object(raw);
  assert.equal(
    field(deployment.spec, "replicas"),
    1,
    "each Agent gateway must have exactly one replica",
  );
  objectMember(deployment, "spec");
  assert.equal(
    optionalField(deployment.spec.strategy, "type"),
    "Recreate",
    "gateway updates must stop the old Pod before starting its replacement",
  );
  const observedGeneration = field(deployment.status, "observedGeneration");
  const generation = field(deployment.metadata, "generation");
  assert.ok(atLeast(observedGeneration, generation));
  objectMember(deployment, "status");
  assert.equal(
    deployment.status.readyReplicas,
    1,
    "each Agent gateway must have one ready replica",
  );
  objectMember(deployment, "metadata");
  assert.equal(field(deployment.metadata.annotations, "openclaw.dev/agent-id"), agentId);
  observeGatewayMetadata(deployment);
  if (namespaceId !== undefined) {
    assert.equal(deployment.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
  }
  assert.equal(
    Object.hasOwn(deployment.metadata.annotations, "openclaw.dev/revision-id"),
    false,
    "Agent gateway identity must remain stable across immutable revisions",
  );
  assertResourceName(deployment, name, "the gateway Deployment");
  const expectedNativeDocument =
    snapshot === undefined ? undefined : expectedGatewayDocument(snapshot);
  if (snapshot !== undefined) {
    const document = JSON.stringify(snapshot.configuration);
    const template = deployment.spec.template;
    for (const metadata of [deployment.metadata, field(template, "metadata")]) {
      const annotations = field(metadata, "annotations");
      assert.equal(field(annotations, "openclaw.dev/configuration-id"), snapshot.configurationId);
      assert.equal(field(annotations, "openclaw.dev/configuration-kind"), "agent");
      assert.equal(
        field(annotations, "openclaw.dev/configuration-generation"),
        String(snapshot.configurationGeneration),
      );
      assert.equal(
        Object.values(object(annotations)).includes(document),
        false,
        "gateway metadata must bind the immutable snapshot without exposing its native document",
      );
    }
    observeGatewayVolumes(deployment);
    const podSpec = deployment.spec.template.spec;
    observedSnapshot = deployment;
    const volume = podSpec.volumes.find(
      (entry) => field(entry, "name") === "openclaw-configuration",
    );
    const configMap = field(volume, "configMap");
    const configMapName = field(configMap, "name");
    const expectedConfigMapName = `${name}-rev-${hash(snapshot.id)}`;
    assert.equal(configMapName, expectedConfigMapName);
    const configuration: unknown = await resource(
      "configmap",
      expectedConfigMapName,
      namespaceName,
    );
    assert.equal(field(configuration, "immutable"), true);
    const data = field(configuration, "data");
    if (data === null || data === undefined) {
      throw new TypeError("Expected ConfigMap data");
    }
    assert.deepEqual(Object.keys(data), ["openclaw.json"]);
    assert.deepEqual(
      JSON.parse(String(field(data, "openclaw.json"))),
      expectedNativeDocument,
      "the immutable native document must preserve revision values and render the fixture Installation's gateway authentication",
    );
    const configurationMetadata = field(configuration, "metadata");
    const annotations = field(configurationMetadata, "annotations");
    assert.equal(field(annotations, "openclaw.dev/agent-id"), agentId);
    if (namespaceId !== undefined) {
      assert.equal(field(annotations, "openclaw.dev/namespace-id"), namespaceId);
    }
    assert.equal(field(annotations, "openclaw.dev/configuration-id"), snapshot.configurationId);
    assert.equal(
      field(annotations, "openclaw.dev/configuration-generation"),
      String(snapshot.configurationGeneration),
    );
    assert.deepEqual(configMap, {
      defaultMode: 0o644,
      name: field(configurationMetadata, "name"),
      items: [{ key: "openclaw.json", path: "openclaw.json" }],
      optional: false,
    });
    const container = field(podSpec.containers, "0");
    const unmanaged = snapshot.gatewayManagedMode === false;
    assert.deepEqual(
      array(field(container, "volumeMounts")).find(
        (entry) => field(entry, "name") === "openclaw-configuration",
      ),
      {
        name: "openclaw-configuration",
        mountPath: unmanaged ? "/etc/openclaw-managed" : "/etc/openclaw",
        readOnly: true,
      },
    );
    const env = array(field(container, "env"));
    assert.equal(
      optionalField(
        env.find((entry) => field(entry, "name") === "OPENCLAW_CONFIG_PATH"),
        "value",
      ),
      unmanaged ? "/home/node/.openclaw/openclaw.json" : "/etc/openclaw/openclaw.json",
    );
    assert.equal(
      env.some((entry) => field(entry, "value") === document),
      false,
      "the gateway receives its exact admitted document through a read-only file, never its environment",
    );
  }
  const gatewayPods = await waitFor(`Agent ${agentId} to own exactly one gateway Pod`, async () => {
    const rawPods: unknown = await resources("pods", namespaceName);
    const owned = array(rawPods).filter((pod) => {
      const labels = field(field(pod, "metadata"), "labels");
      return (
        optionalField(labels, "openclaw.dev/workload-role") === "gateway" &&
        optionalField(labels, "app.kubernetes.io/name") === name
      );
    });
    return owned.length === 1 ? owned : undefined;
  });
  const gatewayPod = gatewayPods[0];
  const conditions = field(field(gatewayPod, "status"), "conditions");
  assert.equal(
    conditions === null || conditions === undefined
      ? undefined
      : array(conditions).some(
          (condition) =>
            field(condition, "type") === "Ready" && field(condition, "status") === "True",
        ),
    true,
    "the Agent's single gateway Pod must be ready",
  );
  if (snapshot !== undefined) {
    const podName = field(field(gatewayPod, "metadata"), "name");
    assert.ok(
      typeof podName === "string",
      "the gateway Pod must have a string name before reading its mounted configuration",
    );
    // Pod names are DNS subdomains. kubectl exec interprets a slash as a resource selector.
    const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
    assert.ok(
      podName.length <= 253 && podName.split(".").every((label) => dnsLabel.test(label)),
      "the gateway Pod must have a valid Kubernetes name before reading its mounted configuration",
    );
    const mountedDocument = await kubectlRead(
      "exec",
      podName,
      "--namespace",
      namespaceName,
      "--",
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'))",
    );
    assert.deepEqual(
      JSON.parse(mountedDocument),
      expectedNativeDocument,
      "the running owner gateway must read the exact immutable native AgentRevision document",
    );
  }
  const service: unknown = await resource("service", name, namespaceName);
  assert.equal(field(field(service, "spec"), "type"), "ClusterIP");
  assert.equal(
    field(field(field(service, "metadata"), "annotations"), "openclaw.dev/agent-id"),
    agentId,
  );
  assertResourceName(service, name, "the gateway Service");
  const accountName = snapshot?.harness?.mode === "embedded" ? agentName(agentId) : name;
  const account: unknown = await resource("serviceaccount", accountName, namespaceName);
  assert.equal(field(account, "automountServiceAccountToken"), false);
  assert.equal(
    field(field(field(account, "metadata"), "annotations"), "openclaw.dev/agent-id"),
    agentId,
  );
  assertResourceName(account, accountName, "the gateway ServiceAccount");
  const rawSlices: unknown = await resources("endpointslices", namespaceName);
  assert.ok(
    array(rawSlices).some(
      (slice) =>
        optionalField(field(field(slice, "metadata"), "labels"), "kubernetes.io/service-name") ===
          name &&
        array(field(slice, "endpoints")).some(
          (endpoint) => optionalField(field(endpoint, "conditions"), "ready") === true,
        ),
    ),
    "the gateway Service must have at least one actually ready EndpointSlice endpoint",
  );
  return observedSnapshot ?? deployment;
}

export async function assertHarnessWorkspaceClaim(
  namespaceName: string,
  namespaceId: string,
  agentId: string,
  expectedUid?: string,
): Promise<ClaimObservation> {
  const name = harnessWorkspaceClaimName(agentId);
  const raw: unknown = await resource("persistentvolumeclaim", name, namespaceName);
  const claim = object(raw);
  assert.equal(field(claim.metadata, "namespace"), namespaceName);
  objectMember(claim, "metadata");
  const labels = field(claim.metadata, "labels");
  assert.equal(field(labels, "app.kubernetes.io/managed-by"), "openclaw-enterprise");
  assert.equal(field(labels, "openclaw.dev/namespace"), namespaceId);
  assert.equal(field(labels, "openclaw.dev/agent"), agentId);
  const annotations = field(claim.metadata, "annotations");
  assert.equal(field(annotations, "openclaw.dev/namespace-id"), namespaceId);
  assert.equal(field(annotations, "openclaw.dev/agent-id"), agentId);
  assert.deepEqual(field(claim.spec, "accessModes"), ["ReadWriteOnce"]);
  objectMember(claim, "spec");
  assert.equal(field(field(claim.spec.resources, "requests"), "storage"), sharedWorkspaceSize);
  assert.equal(claim.spec.storageClassName, "local-path");
  assert.equal(field(claim.status, "phase"), "Bound");
  objectMember(claim, "status");
  assert.equal(field(claim.status.capacity, "storage"), sharedWorkspaceSize);
  if (expectedUid !== undefined) {
    assert.equal(
      claim.metadata.uid,
      expectedUid,
      "Agent-owned Harness workspace claim must be reused",
    );
  }
  assertResourceName(claim, name, "the Agent-owned Harness workspace claim");
  assertResourceUid(claim, "the Agent-owned Harness workspace claim");
  return claim;
}

export function assertHarnessWorkspaceMounts(
  gateway: SnapshotDeploymentObservation,
  workload: unknown,
  workloadName: string,
  claimName: string,
): void {
  assert.equal(
    gateway.spec.template.spec.volumes.some(
      (volume) => optionalField(field(volume, "persistentVolumeClaim"), "claimName") === claimName,
    ),
    false,
    "Gateway must not mount the Harness workspace claim",
  );
  assertResourceName(workload, workloadName, "the revision Deployment");
  const template = field(field(workload, "spec"), "template");
  const volumes = field(field(template, "spec"), "volumes");
  assert.deepEqual(
    array(volumes).find((volume) => field(volume, "name") === "openclaw-workspace"),
    { name: "openclaw-workspace", persistentVolumeClaim: { claimName } },
  );
}

export async function assertRetainedHarnessWorkspaceClaim(
  namespaceName: string,
  name: string,
  uid: string,
  message: string,
): Promise<void> {
  const retained: unknown = await resource("persistentvolumeclaim", name, namespaceName);
  assertResourceName(retained, name, "the retained Harness workspace claim");
  assert.equal(field(retained.metadata, "uid"), uid, message);
}

export async function assertAgentServiceEndpointCount(
  namespaceName: string,
  agentId: string,
  expected: number,
  message: string,
): Promise<unknown> {
  const serviceName = agentName(agentId);
  const observe = async () => {
    const service: unknown = await resource("service", serviceName, namespaceName);
    const rawSlices: unknown = await resources("endpointslices", namespaceName);
    assertResourceName(service, serviceName, "the Agent Service");
    const ready = array(rawSlices).flatMap((slice) => {
      const labels = field(field(slice, "metadata"), "labels");
      if (optionalField(labels, "kubernetes.io/service-name") !== serviceName) {
        return [];
      }
      return array(field(slice, "endpoints") ?? []).filter(
        (endpoint) => optionalField(field(endpoint, "conditions"), "ready") === true,
      );
    });
    return { service, ready };
  };
  if (expected === 0) {
    const { service, ready } = await observe();
    assert.equal(ready.length, expected, message);
    return service;
  }
  return waitFor(message, async () => {
    const { service, ready } = await observe();
    return ready.length === expected ? service : undefined;
  });
}
