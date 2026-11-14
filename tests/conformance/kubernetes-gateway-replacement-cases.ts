import assert from "node:assert/strict";

import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { AgentRevision, ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  admitRevisionHarness,
  authContext,
  digest,
  labelSelectorLabels,
  options,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type AppsApi = InstanceType<KubernetesSdk["AppsV1Api"]>;
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type ObjectApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
type NamespacedRead = Parameters<AppsApi["readNamespacedDeployment"]>[0];
type NamespaceRead = Parameters<CoreApi["readNamespace"]>[0];
type ListPods = Parameters<CoreApi["listNamespacedPod"]>[0];
type PatchPod = Parameters<CoreApi["patchNamespacedPod"]>[0];

type ObservedResource = {
  kind: string;
  apiVersion?: string;
  metadata: {
    name: string;
    namespace?: string | undefined;
    generation?: number;
    uid?: string;
    resourceVersion?: string;
    annotations?: Record<string, string>;
    deletionTimestamp?: Date | string;
  };
  spec?: object;
  status?: object;
  stringData?: Record<string, string>;
  data?: Record<string, string>;
  type?: string;
};

function computeAuthContext(revision: AgentRevision): ComputeRevisionContext {
  return { ...authContext(revision), secretEnvironment: [] };
}

export async function checkGatewayRolloutReadiness() {
  const driver = new KubernetesComputeDriver(options());
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const ownership = { namespaceId: tenant.id, agentId: "agent-rollout" };
  const name = `gateway-${digest(ownership.agentId)}`;
  const deployment = driver["deployment"](
    name,
    ownership,
    namespace,
    options().images.gateway,
    name,
    "gateway",
    {},
    "info",
  );
  deployment.metadata.generation = 2;
  const status = {
    observedGeneration: 2,
    replicas: 2,
    updatedReplicas: 1,
    readyReplicas: 1,
  };
  const service = driver["service"](name, ownership, namespace, {
    "app.kubernetes.io/name": name,
  });
  Object.assign(driver, {
    apiClients: Promise.resolve({
      apps: { readNamespacedDeployment: async () => structuredClone({ ...deployment, status }) },
      core: { readNamespacedService: async () => structuredClone(service) },
      discovery: {
        listNamespacedEndpointSlice: async () => ({
          items: [
            {
              metadata: { labels: { "kubernetes.io/service-name": name } },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        }),
      },
    }),
  });

  assert.equal(await driver["gatewayReady"](ownership, name, namespace), false);
  status.replicas = 1;
  status.observedGeneration = 1;
  assert.equal(await driver["gatewayReady"](ownership, name, namespace), false);
  status.observedGeneration = 2;
  assert.equal(await driver["gatewayReady"](ownership, name, namespace), true);
}

export async function checkCandidateGatewayReplacement() {
  let setupCalls = 0;
  let connected = false;
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
    {
      nodeEnrollment: {
        async createSetup() {
          setupCalls++;
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup() {
          const activeGateway = read("Deployment", gatewayName, gatewayNamespace);
          if (
            !gatewayEndpointsReady &&
            activeGateway.metadata.annotations?.["openclaw.dev/agent-revision-id"] ===
              oldRevision.id
          ) {
            throw new Error("gateway connection unavailable");
          }
          return connected
            ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
            : undefined;
        },
        async isConnected() {
          return connected;
        },
      },
    },
  );
  const oldRevision = routedRevision(driver, { id: "revision-routed-1", revision: 1 });
  const replacement = routedRevision(driver, { id: "revision-routed-2", revision: 2 });
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = `gateway-${digest(replacement.agentId)}`;
  const agentName = `agent-${digest(replacement.agentId)}-rev-${digest(replacement.id)}`;
  const gatewayOwnership = { namespaceId: tenant.id, agentId: replacement.agentId };
  const objects = new Map<string, ObservedResource>();
  const key = (kind: string, name: string, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object: ObservedResource) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind: string, name: string, target = namespace) => {
    const value = objects.get(key(kind, name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };
  save({
    ...driver["manifest"]("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver["gatewayNamespaceManifest"]({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver["manifest"](
      "v1",
      "Secret",
      `transport-${digest(replacement.agentId)}`,
      gatewayOwnership,
      { name: gatewayNamespace, plane: "control" },
    ),
    type: "Opaque",
    metadata: {
      ...driver["manifest"](
        "v1",
        "Secret",
        `transport-${digest(replacement.agentId)}`,
        gatewayOwnership,
        { name: gatewayNamespace, plane: "control" },
      ).metadata,
      uid: "transport-uid",
      resourceVersion: "1",
    },
    data: {
      "app-server-token": Buffer.from("test-transport").toString("base64"),
    },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: gatewayNamespace,
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesNamespaceName(tenant.id), plane: "control" },
  ] as const) {
    for (const policy of driver["networkPolicies"]({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  const predecessor = driver["deployment"](
    gatewayName,
    gatewayOwnership,
    { name: gatewayNamespace, plane: "control" },
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver["gatewayConfiguration"](oldRevision, "previous-node", {
      name: namespace,
      plane: "execution",
    }),
  );
  assert.ok(predecessor.metadata.annotations);
  predecessor.metadata.annotations["openclaw.dev/agent-revision"] = String(oldRevision.revision);
  predecessor.metadata.annotations["openclaw.dev/agent-revision-id"] = oldRevision.id;
  predecessor.metadata.generation = 1;
  predecessor.metadata.uid = `${gatewayName}-uid`;
  save({
    ...predecessor,
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
    },
  });

  let gatewayEndpointsReady = true;
  let candidateGatewayStarted = false;
  function resourceTransport(...kinds: string[]) {
    const operations: Record<
      string,
      | ((request: NamespacedRead) => Promise<ObservedResource>)
      | ((request: { body: ObservedResource }) => Promise<ObservedResource>)
    > = {};
    for (const kind of kinds) {
      operations[`readNamespaced${kind}`] = async ({ name, namespace: target }: NamespacedRead) =>
        read(kind, name, target);
      const write = async ({ body }: { body: ObservedResource }) => {
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        const changed =
          kind === "Deployment" && JSON.stringify(previous?.spec) !== JSON.stringify(body.spec);
        const value: ObservedResource = {
          ...previous,
          ...structuredClone(body),
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            uid: `${body.metadata.name}-uid`,
            resourceVersion: "1",
          },
        };
        if (kind === "Deployment") {
          value.metadata.generation = (previous?.metadata.generation ?? 0) + Number(changed);
          if (changed) {
            delete value.status;
          }
          if (
            body.metadata.name === gatewayName &&
            body.metadata.annotations?.["openclaw.dev/agent-revision-id"] === replacement.id
          ) {
            candidateGatewayStarted = true;
          }
        }
        if (body.stringData) {
          value.data = Object.fromEntries(
            Object.entries(body.stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          );
        }
        save(value);
        return value;
      };
      operations[`patchNamespaced${kind}`] = write;
      operations[`createNamespaced${kind}`] = write;
      operations[`replaceNamespaced${kind}`] = write;
    }
    return operations;
  }

  const podPatches: string[] = [];
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        ...resourceTransport(
          "ConfigMap",
          "Secret",
          "Service",
          "ServiceAccount",
          "PersistentVolumeClaim",
        ),
        async listNamespace() {
          return { items: [] };
        },
        async readNamespace({ name }: NamespaceRead) {
          return read("Namespace", name);
        },
        // The candidate Harness has no Pod until its Deployment exists. Setup
        // written before then reaches the Pod when it mounts the volume.
        async listNamespacedPod({ namespace: target, labelSelector }: ListPods) {
          assert.ok(labelSelector);
          return {
            items: objects.has(key("Deployment", agentName))
              ? [
                  {
                    metadata: {
                      name: "candidate-harness",
                      namespace: target,
                      labels: labelSelectorLabels(labelSelector),
                    },
                  },
                ]
              : [],
          };
        },
        async patchNamespacedPod({ name }: PatchPod) {
          podPatches.push(name);
          return {};
        },
      },
      apps: resourceTransport("Deployment"),
      networking: resourceTransport("NetworkPolicy"),
      objects: {
        async read({ kind, metadata }: Parameters<ObjectApi["read"]>[0]) {
          assert.ok(kind);
          return read(kind, metadata.name, metadata.namespace);
        },
        async patch(object: Parameters<ObjectApi["patch"]>[0]) {
          assert.ok(object.kind && object.metadata?.name);
          save({
            ...object,
            kind: object.kind,
            metadata: { ...object.metadata, name: object.metadata.name },
          });
          return object;
        },
      },
      discovery: {
        async listNamespacedEndpointSlice() {
          return {
            items: gatewayEndpointsReady
              ? [
                  {
                    metadata: {
                      labels: { "kubernetes.io/service-name": gatewayName },
                      ownerReferences: [
                        { kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` },
                      ],
                    },
                    endpoints: [{ conditions: { ready: true } }],
                  },
                ]
              : [],
          };
        },
      },
    }),
  });

  const prepare = () => driver.prepareRevision(replacement, computeAuthContext(replacement));
  const markReady = (name: string) => {
    const target = name === gatewayName ? gatewayNamespace : namespace;
    const object = read("Deployment", name, target);
    object.status = {
      observedGeneration: object.metadata.generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
    };
    save(object);
  };

  assert.equal((await prepare()).ready, false);
  assert.equal(candidateGatewayStarted, false);
  assert.equal(setupCalls, 1);
  assert.deepEqual(podPatches, [], "the setup was written before the candidate Harness existed");
  const initiallyPreparedAgent = read("Deployment", agentName);
  const harnessTemplate = asRecord(asRecord(initiallyPreparedAgent.spec)?.template);
  const containers = asRecord(harnessTemplate?.spec)?.containers;
  assert.ok(Array.isArray(containers));
  const environment = asRecord(containers[0])?.env;
  assert.ok(
    Array.isArray(environment) &&
      environment.some((variable) => asRecord(variable)?.name === "OPENCLAW_NODE_SETUP_PATH"),
  );
  markReady(agentName);

  assert.equal((await prepare()).ready, false);
  assert.equal(
    read("Deployment", gatewayName, gatewayNamespace).metadata.annotations?.[
      "openclaw.dev/agent-revision-id"
    ],
    oldRevision.id,
    "healthy predecessor keeps serving workspace-node enrollment while setup is pending",
  );
  assert.equal(candidateGatewayStarted, false);

  gatewayEndpointsReady = false;
  assert.equal((await prepare()).ready, false);
  assert.equal(
    read("Deployment", gatewayName, gatewayNamespace).metadata.annotations?.[
      "openclaw.dev/agent-revision-id"
    ],
    replacement.id,
  );
  markReady(gatewayName);
  gatewayEndpointsReady = true;

  assert.equal((await prepare()).ready, false);
  assert.equal(setupCalls, 1);
  // A candidate Gateway does not change the Harness it enrolls.
  assert.deepEqual(asRecord(read("Deployment", agentName).spec)?.template, harnessTemplate);
  connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(setupCalls, 1);
}

export async function checkDedicatedHarnessServiceCutover() {
  const fixture = workspaceSetupFixture(false);
  const { driver, revision, namespace, objects, state } = fixture;
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  const serviceName = `agent-${digest(revision.agentId)}`;
  const serviceKey = `Service:${namespace}:${serviceName}`;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayServiceKey = `Service:${gatewayNamespace}:${gatewayName}`;
  const policyKey = (selectedRevision: AgentRevision) =>
    `NetworkPolicy:${gatewayNamespace}:allow-gateway-agent-${digest(selectedRevision.agentId)}`;
  const serviceSelector = (key: string) => {
    const selector = asRecord(asRecord(objects.get(key)?.spec)?.selector);
    assert.ok(selector, `missing Service selector for ${key}`);
    return selector;
  };
  const gatewayPeer = (selectedRevision: AgentRevision) => {
    const egress = asRecord(objects.get(policyKey(selectedRevision))?.spec)?.egress;
    assert.ok(Array.isArray(egress));
    const peers = asRecord(egress[0])?.to;
    assert.ok(Array.isArray(peers));
    const peer = asRecord(peers[0]);
    assert.ok(peer);
    return peer;
  };
  const gatewayTargetSelector = (selectedRevision: AgentRevision) => {
    const labels = asRecord(asRecord(gatewayPeer(selectedRevision).podSelector)?.matchLabels);
    assert.ok(labels);
    return labels;
  };
  const storeTransportSecret = (selectedRevision: AgentRevision) => {
    const name = `transport-${digest(selectedRevision.agentId)}`;
    objects.set(`Secret:${gatewayNamespace}:${name}`, {
      ...driver["manifest"](
        "v1",
        "Secret",
        name,
        { namespaceId: selectedRevision.namespaceId, agentId: selectedRevision.agentId },
        { name: gatewayNamespace, plane: "control" },
      ),
      type: "Opaque",
      metadata: {
        ...driver["manifest"](
          "v1",
          "Secret",
          name,
          { namespaceId: selectedRevision.namespaceId, agentId: selectedRevision.agentId },
          { name: gatewayNamespace, plane: "control" },
        ).metadata,
        uid: `${name}-uid`,
        resourceVersion: "1",
      },
      data: { "app-server-token": Buffer.from("test-transport").toString("base64") },
    });
  };
  const assertServiceSatisfiesGatewayPolicy = (selectedRevision: AgentRevision) => {
    const selector = serviceSelector(serviceKey);
    const target = gatewayTargetSelector(selectedRevision);
    assert.deepEqual(asRecord(gatewayPeer(selectedRevision).namespaceSelector)?.matchLabels, {
      "kubernetes.io/metadata.name": namespace,
    });
    // EKS resolves policy peers before destination translation, so the Service
    // must include every peer label, including the Harness network profile.
    assert.equal(target["openclaw.dev/network-profile"], "broad-egress-v1");
    for (const [name, value] of Object.entries(target)) {
      assert.equal(selector[name], value, `${name} must match the gateway egress selector`);
    }
    assert.equal(
      selector["app.kubernetes.io/name"],
      `${serviceName}-rev-${digest(selectedRevision.id)}`,
    );
    assert.equal(selector["openclaw.dev/namespace"], selectedRevision.namespaceId);
    assert.equal(selector["openclaw.dev/agent"], selectedRevision.agentId);
    assert.equal(selector["openclaw.dev/revision"], selectedRevision.id);
    assert.equal(selector["openclaw.dev/workload-role"], "agent");
  };
  const assertGatewayServiceSatisfiesIngressPolicy = (selectedRevision: AgentRevision) => {
    const selector = serviceSelector(gatewayServiceKey);
    const policies: { metadata: { name: string }; spec?: Record<string, unknown> }[] =
      driver.networkPolicies(
        { namespaceId: selectedRevision.namespaceId },
        { name: gatewayNamespace, plane: "control" },
      );
    const ingressPolicy = policies.find(
      ({ metadata }) => metadata.name === "allow-gateway-ingress",
    );
    const target = asRecord(asRecord(ingressPolicy?.spec?.podSelector)?.matchLabels);
    assert.ok(target);
    // Service selectors intentionally stay profile-free; the policy selector carries it.
    assert.equal(target["openclaw.dev/network-profile"], "broad-egress-v1");
    for (const [name, value] of Object.entries(target)) {
      if (name === "openclaw.dev/network-profile") {
        continue;
      }
      assert.equal(selector[name], value, `${name} must match the gateway ingress selector`);
    }
    assert.equal(selector["app.kubernetes.io/name"], gatewayName);
    assert.equal(selector["openclaw.dev/namespace"], selectedRevision.namespaceId);
    assert.equal(selector["openclaw.dev/agent"], selectedRevision.agentId);
    assert.equal(selector["openclaw.dev/workload-role"], "gateway");
    assert.equal(selector["openclaw.dev/revision"], undefined);
  };

  state.ready = true;
  assert.equal((await driver.prepareRevision(revision, computeAuthContext(revision))).ready, true);
  await driver.activateRevision(revision, computeAuthContext(revision));
  assertServiceSatisfiesGatewayPolicy(revision);
  assertGatewayServiceSatisfiesIngressPolicy(revision);

  const successor = {
    ...revision,
    id: "revision-selector-successor",
    revision: revision.revision + 1,
  };
  assert.equal(
    (await driver.prepareRevision(successor, computeAuthContext(successor))).ready,
    true,
  );
  assert.equal(serviceSelector(serviceKey)["openclaw.dev/revision"], revision.id);

  await driver.activateRevision(successor, computeAuthContext(successor));
  assertServiceSatisfiesGatewayPolicy(successor);
  assertGatewayServiceSatisfiesIngressPolicy(successor);

  const sibling = {
    ...revision,
    agentId: "agent-selector-sibling",
    id: "revision-selector-sibling",
    servicePrincipalId: "service-principal-selector-sibling",
  };
  storeTransportSecret(sibling);
  assert.equal((await driver.prepareRevision(sibling, computeAuthContext(sibling))).ready, true);
  await driver.activateRevision(sibling, computeAuthContext(sibling));
  const siblingSelector = serviceSelector(`Service:${namespace}:agent-${digest(sibling.agentId)}`);
  assert.equal(siblingSelector["openclaw.dev/namespace"], sibling.namespaceId);
  assert.equal(siblingSelector["openclaw.dev/agent"], sibling.agentId);
  assert.equal(siblingSelector["openclaw.dev/revision"], sibling.id);
  assert.notEqual(
    siblingSelector["openclaw.dev/agent"],
    gatewayTargetSelector(successor)["openclaw.dev/agent"],
  );
  assert.notEqual(
    siblingSelector["openclaw.dev/revision"],
    gatewayTargetSelector(successor)["openclaw.dev/revision"],
  );

  await driver.deactivateRevision(successor);
  assert.deepEqual(serviceSelector(serviceKey), {
    "app.kubernetes.io/name": `${serviceName}-inactive`,
  });
}

export async function checkLegacyHarnessServiceDeactivation() {
  const fixture = workspaceSetupFixture(false);
  const { driver, revision, namespace, objects, state } = fixture;
  const serviceName = `agent-${digest(revision.agentId)}`;
  const serviceKey = `Service:${namespace}:${serviceName}`;

  state.ready = true;
  assert.equal((await driver.prepareRevision(revision, computeAuthContext(revision))).ready, true);
  await driver.activateRevision(revision, computeAuthContext(revision));

  const selector = asRecord(asRecord(objects.get(serviceKey)?.spec)?.selector);
  assert.ok(selector);
  delete selector["openclaw.dev/namespace"];
  await driver.deactivateRevision(revision);
  assert.deepEqual(asRecord(objects.get(serviceKey)?.spec)?.selector, {
    "app.kubernetes.io/name": `${serviceName}-inactive`,
  });
}

export async function checkSurvivingDedicatedPredecessor(
  predecessorRuntime: "Deployment" | "terminating Pod",
) {
  const { driver, revision, namespace, objects, state } = workspaceSetupFixture(false);
  state.ready = true;
  await driver.prepareRevision(revision, computeAuthContext(revision));
  const suffix = digest(revision.agentId);
  const harnessName = `agent-${suffix}-rev-${digest(revision.id)}`;
  const harnessKey = `Deployment:${namespace}:${harnessName}`;
  const harness = objects.get(harnessKey);
  assert.ok(harness, "the predecessor must have a real rendered dedicated Harness");
  const successor: AgentRevision = {
    ...revision,
    id: "embedded-mode-successor",
    revision: revision.revision + 1,
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    configuration: workspaceSetupFixture(true).revision.configuration,
  };
  admitRevisionHarness(driver, successor);
  let survivingPod: ObservedResource | undefined;
  if (predecessorRuntime === "terminating Pod") {
    // Kubernetes may retain a terminating Pod after its Deployment is gone.
    objects.delete(harnessKey);
    const template = asRecord(asRecord(harness.spec)?.template);
    const spec = asRecord(template?.spec);
    assert.ok(spec);
    survivingPod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...asRecord(template?.metadata),
        name: "terminating-predecessor",
        namespace,
        uid: "terminating-predecessor-uid",
        deletionTimestamp: new Date().toISOString(),
      },
      spec,
    };
    const clients = await driver.apiClients;
    const listPods = clients.core.listNamespacedPod;
    clients.core.listNamespacedPod = async (request) => {
      const labels = labelSelectorLabels(request.labelSelector);
      return survivingPod !== undefined &&
        request.namespace === namespace &&
        labels["openclaw.dev/revision"] === revision.id &&
        labels["openclaw.dev/workload-role"] === "agent"
        ? { items: [survivingPod] }
        : listPods(request);
    };
  }
  const projectionKey = (selected: AgentRevision) =>
    `Secret:${namespace}:harness-secrets-${suffix}-${digest(selected.id)}`;
  const predecessorProjection = structuredClone(objects.get(projectionKey(revision)));
  assert.ok(predecessorProjection);
  await driver.prepareRevision(successor, computeAuthContext(successor));
  await driver.activateRevision(successor, computeAuthContext(successor));
  assert.deepEqual(
    objects.get(projectionKey(revision)),
    predecessorProjection,
    "cutover must not delete credentials still referenced by the dedicated predecessor",
  );
  survivingPod = undefined;
  await driver.retireRevision(revision);
  assert.equal(
    objects.has(projectionKey(revision)),
    false,
    "normal retirement removes the predecessor projection after runtime termination",
  );
  assert.ok(objects.has(projectionKey(successor)));
  assert.equal(
    objects.get(`Deployment:${namespace}:gateway-${suffix}`)?.metadata.annotations?.[
      "openclaw.dev/agent-revision-id"
    ],
    successor.id,
  );
}

export async function checkOtherModeRuntimeRetirement(
  embedded: boolean,
  surviving: "Deployment" | "HTTPRoute",
) {
  const { driver, revision, namespace, objects } = workspaceSetupFixture(embedded);
  const successorId = "successor-revision";
  const control = kubernetesNamespaceName(revision.namespaceId);
  const oldTarget = embedded ? namespace : control;
  const nextTarget = embedded ? control : namespace;
  const suffix = digest(revision.agentId);
  const gatewayName = `gateway-${suffix}`;
  const agentName = `agent-${suffix}`;
  const owner = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const save = (
    kind: "Deployment" | "HTTPRoute" | "Service" | "ServiceAccount" | "NetworkPolicy",
    name: string,
    target: string,
    revisionId?: string,
    principal = false,
  ) => {
    const resource = driver["manifest"](
      kind === "Deployment" ? "apps/v1" : "v1",
      kind,
      name,
      {
        ...owner,
        ...(principal ? { servicePrincipalId: revision.servicePrincipalId } : {}),
        ...(revisionId === undefined ? {} : { revisionId }),
      },
      { name: target, plane: "execution" },
    );
    resource.metadata.uid = `${target}-${name}-uid`;
    resource.metadata.resourceVersion = "1";
    if (revisionId !== undefined) {
      assert.ok(resource.metadata.annotations);
      resource.metadata.annotations["openclaw.dev/agent-revision-id"] = revisionId;
    }
    objects.set(`${kind}:${target}:${name}`, resource);
    return resource;
  };
  save("Deployment", gatewayName, oldTarget, revision.id);
  save("Service", gatewayName, oldTarget);
  save("ServiceAccount", gatewayName, oldTarget);
  save(surviving, gatewayName, nextTarget, successorId);
  save("Service", agentName, namespace, undefined, true);
  save("ServiceAccount", agentName, namespace, undefined, true);
  for (const name of [
    "allow-agent-runtime",
    "allow-agent-auth",
    "allow-plugin-status-proxy",
    "allow-plugin-status-agent",
  ]) {
    save("NetworkPolicy", `${name}-${suffix}`, namespace, undefined, name === "allow-agent-auth");
  }
  for (const name of [
    "allow-gateway-agent",
    "allow-gateway-channels",
    "allow-plugin-status-gateway",
  ]) {
    save("NetworkPolicy", `${name}-${suffix}`, oldTarget);
  }
  const preserved = new Map(
    [...objects]
      .filter(
        ([key]) =>
          key === `${surviving}:${nextTarget}:${gatewayName}` ||
          key === `Service:${namespace}:${agentName}` ||
          key === `ServiceAccount:${namespace}:${agentName}` ||
          key.startsWith(`NetworkPolicy:${namespace}:allow-agent-`) ||
          key === `NetworkPolicy:${namespace}:allow-plugin-status-proxy-${suffix}` ||
          key === `NetworkPolicy:${namespace}:allow-plugin-status-agent-${suffix}`,
      )
      .map(([key, value]) => [key, structuredClone(value)]),
  );
  await driver.retireRevision(revision);
  await driver.retireRevision(revision);
  for (const [key, value] of preserved) {
    assert.deepEqual(objects.get(key), value, key);
  }
  for (const kind of ["Deployment", "Service", "ServiceAccount"]) {
    assert.equal(objects.has(`${kind}:${oldTarget}:${gatewayName}`), surviving === "Deployment");
  }
  for (const name of [
    "allow-gateway-agent",
    "allow-gateway-channels",
    "allow-plugin-status-gateway",
  ]) {
    assert.equal(
      objects.has(`NetworkPolicy:${oldTarget}:${name}-${suffix}`),
      surviving === "Deployment",
    );
  }
}
