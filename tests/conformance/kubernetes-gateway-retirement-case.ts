import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { options, routedOptions } from "../helpers/kubernetes-routed-options.ts";
import { digest, routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import { agent as credentialAgent } from "./kubernetes-runtime-credentials-fixture.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type Clients = {
  apps: InstanceType<KubernetesSdk["AppsV1Api"]>;
  core: InstanceType<KubernetesSdk["CoreV1Api"]>;
  objects: InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
};
type ObjectDelete = Parameters<Clients["objects"]["delete"]>;
type KubernetesObject = ObjectDelete[0];
type ObservedResource = KubernetesObject & {
  kind: string;
  metadata: { name: string };
};
type NamespacedRead = Pick<
  Parameters<Clients["apps"]["readNamespacedDeployment"]>[0],
  "name" | "namespace"
>;
type NamespacedDelete = {
  Deployment: Parameters<Clients["apps"]["deleteNamespacedDeployment"]>[0];
  Service: Parameters<Clients["core"]["deleteNamespacedService"]>[0];
  ServiceAccount: Parameters<Clients["core"]["deleteNamespacedServiceAccount"]>[0];
  PersistentVolumeClaim: Parameters<Clients["core"]["deleteNamespacedPersistentVolumeClaim"]>[0];
};
type Deletion =
  | {
      [Kind in keyof NamespacedDelete]: [kind: Kind, request: NamespacedDelete[Kind]];
    }[keyof NamespacedDelete]
  | [
      kind: "HTTPRoute" | "SecurityPolicy" | "NetworkPolicy",
      request: { spec: ObjectDelete[0]; body: ObjectDelete[6] },
    ];

function resourceKey(kind: string | undefined, namespace: string | undefined, name: string) {
  return JSON.stringify([kind, namespace, name]);
}

function observedResources(
  key = resourceKey,
  missingMessage: (kind: string | undefined, name: string) => string = () => "Not found",
) {
  const resources = new Map<string, ObservedResource>();

  function observe(resource: ObservedResource) {
    const { kind, metadata } = resource;
    resources.set(key(kind, metadata.namespace, metadata.name), structuredClone(resource));
  }

  function read(kind: string | undefined, target: string | undefined, name: string) {
    const resource = resources.get(key(kind, target, name));
    if (resource === undefined) {
      throw Object.assign(new Error(missingMessage(kind, name)), { code: 404 });
    }
    return structuredClone(resource);
  }

  function readNamespaced(kind: string) {
    return async ({ name, namespace: target }: NamespacedRead) => read(kind, target, name);
  }

  return { resources, observe, read, readNamespaced };
}

function retirementFixture(
  driver: KubernetesComputeDriver,
  namespace: string,
  gatewayName: string,
  nodeName: string,
) {
  const { resources, observe, read, readNamespaced } = observedResources();
  const deletions: Deletion[] = [];
  let failServiceDelete = false;

  function reset(...snapshot: ObservedResource[]) {
    resources.clear();
    for (const resource of snapshot) {
      observe(resource);
    }
  }

  function nodeResources() {
    const nodes = new Map<string, ObservedResource>();
    for (const resource of resources.values()) {
      if (resource.metadata.namespace === namespace && resource.metadata.name === nodeName) {
        nodes.set(resource.kind, structuredClone(resource));
      }
    }
    return nodes;
  }

  function clearNodeResources() {
    for (const resource of nodeResources().values()) {
      resources.delete(resourceKey(resource.kind, namespace, nodeName));
    }
  }

  // Delete attempts are recorded independently of the observed snapshots. This
  // lets the retry exercise a Deployment that still exists after the failure.
  Object.assign(driver, {
    apiClients: Promise.resolve({
      apps: {
        readNamespacedDeployment: readNamespaced("Deployment"),
        async deleteNamespacedDeployment(request: NamespacedDelete["Deployment"]) {
          deletions.push(["Deployment", request]);
        },
      },
      core: {
        async listNamespacedPod() {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        },
        readNamespacedConfigMap: readNamespaced("ConfigMap"),
        readNamespacedSecret: readNamespaced("Secret"),
        readNamespacedPersistentVolumeClaim: readNamespaced("PersistentVolumeClaim"),
        async deleteNamespacedPersistentVolumeClaim(
          request: NamespacedDelete["PersistentVolumeClaim"],
        ) {
          deletions.push(["PersistentVolumeClaim", request]);
        },
        readNamespacedService: readNamespaced("Service"),
        async patchNamespacedService({
          name,
          body,
        }: Parameters<Clients["core"]["patchNamespacedService"]>[0]) {
          const service = body as ObservedResource;
          assert.equal(service.kind, "Service");
          assert.equal(service.metadata.name, name);
          assert.equal(service.metadata.namespace, namespace);
          observe({
            ...service,
            metadata: { ...service.metadata, uid: name + "-service-uid", resourceVersion: "1" },
          });
        },
        async deleteNamespacedService(request: NamespacedDelete["Service"]) {
          deletions.push(["Service", request]);
          if (failServiceDelete) {
            throw new Error("service delete failed");
          }
        },
        readNamespacedServiceAccount: readNamespaced("ServiceAccount"),
        async deleteNamespacedServiceAccount(request: NamespacedDelete["ServiceAccount"]) {
          deletions.push(["ServiceAccount", request]);
        },
      },
      networking: {
        readNamespacedNetworkPolicy: readNamespaced("NetworkPolicy"),
      },
      objects: {
        async read({ kind, metadata }: Parameters<Clients["objects"]["read"]>[0]) {
          return read(kind, metadata.namespace, metadata.name);
        },
        async patch(body: Parameters<Clients["objects"]["patch"]>[0]) {
          const { kind, metadata } = body;
          assert.ok(metadata?.name);
          assert.equal(metadata.namespace, namespace);
          assert.ok(kind === "HTTPRoute" || kind === "SecurityPolicy");
          if (kind === "SecurityPolicy") {
            assert.equal(metadata.name, nodeName);
          } else {
            assert.ok(
              metadata.name === gatewayName ||
                metadata.name === nodeName ||
                /^chat-[a-f0-9]{12}-rev-[a-f0-9]{12}$/.test(metadata.name),
            );
          }
          let uid = kind + "-node-uid";
          if (metadata.name === gatewayName) {
            uid = "route-uid";
          }
          if (metadata.name.startsWith("chat-")) {
            uid = metadata.name + "-route-uid";
          }
          observe({
            ...body,
            kind,
            metadata: {
              ...metadata,
              name: metadata.name,
              uid,
              resourceVersion: "1",
            },
          });
        },
        async delete(...args: ObjectDelete) {
          const [spec, , , , , , body] = args;
          const { kind } = spec;
          assert.ok(kind === "HTTPRoute" || kind === "SecurityPolicy" || kind === "NetworkPolicy");
          deletions.push([kind, { spec, body }]);
        },
      },
    }),
  });

  return {
    observe,
    reset,
    nodeResources,
    clearNodeResources,
    deletions,
    setServiceDeleteFailure(value: boolean) {
      failServiceDelete = value;
    },
  };
}

export async function checkGatewayRetirement() {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-revision-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const target = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const namespace = target.name;
  const gatewayName = "gateway-" + digest(agentId);
  const nodeName = gatewayName + "-node";
  const agentName = "agent-" + digest(agentId);
  const agentOwnership = { ...ownership, servicePrincipalId: "service-agent-revision-storage" };
  const revision = { id: "revision-2", revision: 2, agentId };
  const routeRevision = routedRevision(driver, revision);
  const active: AgentRevision = routedRevision(driver, {
    ...revision,
    servicePrincipalId: agentOwnership.servicePrincipalId,
  });
  const predecessor = { ...active, id: "revision-1", revision: 1 };
  const candidate = { ...active, id: "revision-3", revision: 3 };

  const gateway = driver["manifest"]("apps/v1", "Deployment", gatewayName, ownership, target);
  gateway.metadata.uid = "gateway-uid";
  assert.ok(gateway.metadata.annotations);
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  const gatewayService = driver["service"](gatewayName, ownership, target, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  const gatewayAccount = driver["manifest"]("v1", "ServiceAccount", gatewayName, ownership, target);
  gatewayAccount.metadata.uid = "gateway-account-uid";
  const agentService = driver["service"](agentName, agentOwnership, target, {
    "openclaw.dev/agent": agentId,
    "openclaw.dev/revision": "revision-2",
    "openclaw.dev/workload-role": "agent",
  });
  agentService.metadata.uid = "agent-service-uid";
  const agentAccount = driver["manifest"](
    "v1",
    "ServiceAccount",
    agentName,
    agentOwnership,
    target,
  );
  agentAccount.metadata.uid = "agent-account-uid";
  const route = driver["gatewayRoute"](routeRevision, ownership, target, gatewayService);
  assert.ok(route);
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "route-version-2";
  const claims = [
    driver["gatewayPrivateStateClaim"](agentId, ownership, target),
    driver["harnessWorkspaceClaim"](agentId, ownership, target),
  ];
  for (const claim of claims) {
    claim.metadata.uid = claim.metadata.name + "-uid";
  }

  const fixture = retirementFixture(driver, namespace, gatewayName, nodeName);
  const { deletions } = fixture;
  const survivingResources = [
    gatewayService,
    gatewayAccount,
    agentService,
    agentAccount,
    route,
    ...claims,
  ];
  fixture.reset(gateway, ...survivingResources);

  const gatewayDeletes: Deletion[] = [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid", resourceVersion: "route-version-2" } },
      },
    ],
    [
      "Service",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-account-uid" } } },
    ],
  ];
  const harnessDeletes: Deletion[] = [
    [
      "Service",
      { name: agentName, namespace, body: { preconditions: { uid: "agent-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: agentName, namespace, body: { preconditions: { uid: "agent-account-uid" } } },
    ],
  ];

  await driver["removeRetiredGateway"](predecessor, target);
  assert.equal(deletions.length, 0);

  fixture.setServiceDeleteFailure(true);
  await assert.rejects(driver["removeRetiredGateway"](active, target), /service delete failed/);
  assert.deepEqual(deletions, gatewayDeletes.slice(0, 2));
  assert.equal(
    deletions.some(([kind]) => kind === "Deployment"),
    false,
    "Deployment must remain as the retry witness until Service deletion succeeds",
  );

  deletions.length = 0;
  fixture.setServiceDeleteFailure(false);
  await driver["removeRetiredGateway"](active, target);
  assert.deepEqual(deletions, [
    ...gatewayDeletes,
    [
      "Deployment",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-uid" } } },
    ],
    ...harnessDeletes,
  ]);

  // With the Deployment absent, the surviving route still identifies its owner.
  deletions.length = 0;
  fixture.reset(...survivingResources);
  await driver["removeRetiredGateway"](active, target);
  assert.deepEqual(deletions, [...gatewayDeletes, ...harnessDeletes]);
  assert.equal(
    deletions.some(([kind]) => kind === "PersistentVolumeClaim"),
    false,
  );

  deletions.length = 0;
  fixture.observe({
    ...route,
    metadata: {
      ...route.metadata,
      annotations: {
        ...route.metadata.annotations,
        "openclaw.dev/agent-revision-id": "revision-3",
      },
    },
  });
  await driver["removeRetiredGateway"](active, target);
  assert.equal(deletions.length, 0);

  function observeGateway(revision: Pick<typeof active, "id" | "revision">) {
    fixture.observe({
      ...gateway,
      metadata: {
        ...gateway.metadata,
        annotations: {
          ...gateway.metadata.annotations,
          "openclaw.dev/agent-revision-id": revision.id,
          "openclaw.dev/agent-revision": String(revision.revision),
        },
      },
    });
  }

  function expectChatRetirement(revision: AgentRevision) {
    const name = `chat-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
    assert.deepEqual(deletions, [
      [
        "HTTPRoute",
        {
          spec: {
            apiVersion: "gateway.networking.k8s.io/v1",
            kind: "HTTPRoute",
            metadata: { name, namespace },
          },
          body: { preconditions: { uid: name + "-route-uid", resourceVersion: "1" } },
        },
      ],
      ["Service", { name, namespace, body: { preconditions: { uid: name + "-service-uid" } } }],
    ]);
    deletions.length = 0;
  }

  // Preparation can run while the previous Gateway still serves requests. A
  // failed candidate must not acquire and then delete that Gateway's node route.
  observeGateway(active);
  await driver["reconcileGatewayRoute"](active, ownership, target);
  const activeNodeResources = fixture.nodeResources();
  assert.equal(activeNodeResources.size, 2);
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  assert.deepEqual(fixture.nodeResources(), activeNodeResources);

  // A serving Gateway predating node enrollment may have no node endpoint.
  // Preparing its successor must create one under the serving revision, or
  // node readiness would wait for activation while activation waits for it.
  fixture.clearNodeResources();
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  assert.deepEqual(fixture.nodeResources(), activeNodeResources);
  await driver["removeRetiredGateway"](candidate, target);
  expectChatRetirement(candidate);

  // Once activation replaces the Gateway, the same endpoint belongs to the new
  // revision. Retiring the predecessor must leave it usable by the new node.
  observeGateway(candidate);
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  const candidateNodes = fixture.nodeResources();
  for (const resource of candidateNodes.values()) {
    assert.equal(resource.metadata.annotations?.["openclaw.dev/agent-revision-id"], candidate.id);
  }
  await driver["removeRetiredGateway"](active, target);
  expectChatRetirement(active);
  await driver["removeRetiredGateway"](candidate, target);
  assert.deepEqual(deletions.slice(0, 2), [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: nodeName, namespace },
        },
        body: { preconditions: { uid: "HTTPRoute-node-uid", resourceVersion: "1" } },
      },
    ],
    [
      "SecurityPolicy",
      {
        spec: {
          apiVersion: "gateway.envoyproxy.io/v1alpha1",
          kind: "SecurityPolicy",
          metadata: { name: nodeName, namespace },
        },
        body: { preconditions: { uid: "SecurityPolicy-node-uid", resourceVersion: "1" } },
      },
    ],
  ]);
  assert.equal(
    deletions.some(([kind]) => kind === "PersistentVolumeClaim"),
    false,
  );

  // The same name and revision do not authorize deletion of another Agent's route.
  deletions.length = 0;
  const candidateRoute = candidateNodes.get("HTTPRoute");
  assert.ok(candidateRoute);
  fixture.observe({
    ...candidateRoute,
    metadata: {
      ...candidateRoute.metadata,
      labels: { ...candidateRoute.metadata.labels, "openclaw.dev/agent": "foreign-agent" },
      annotations: {
        ...candidateRoute.metadata.annotations,
        "openclaw.dev/agent-id": "foreign-agent",
      },
    },
  });
  await assert.rejects(driver["removeRetiredGateway"](candidate, target), {
    message: "Refusing unowned Kubernetes HTTPRoute " + nodeName + ".",
  });
  assert.equal(deletions.length, 0);
}

export async function checkEmbeddedGatewayRetirement() {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const revision: AgentRevision = routedRevision(driver, {
    id: "revision-embedded-deletion",
    agentId: "agent-embedded-deletion",
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    configuration: {
      agents: { defaults: { model: "openai/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
    },
    plugins: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } } },
    },
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const target = { name: namespace, plane: "execution" } as const;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}`;
  const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const agentOwnership = {
    ...gatewayOwnership,
    servicePrincipalId: revision.servicePrincipalId,
  };
  const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
  const configurationName = `${gatewayName}-rev-${digest(revision.id)}`;
  const pluginName = `plugin-runtime-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const key = (kind: string | undefined, name: string) => `${kind}:${name}`;
  const { resources, observe, read, readNamespaced } = observedResources(
    (kind, _namespace, name) => key(kind, name),
    (kind, name) => `${kind} ${name} not found`,
  );
  function save<T extends ObservedResource>(object: T) {
    object.metadata.uid ??= `${object.metadata.name}-uid`;
    observe(object);
  }

  save({
    ...driver["manifest"]("v1", "Namespace", namespace, { namespaceId: revision.namespaceId }),
    status: { phase: "Active" },
  });
  const gateway = driver["manifest"](
    "apps/v1",
    "Deployment",
    gatewayName,
    gatewayOwnership,
    target,
  );
  assert.ok(gateway.metadata.annotations);
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
  save(gateway);
  save(
    driver["service"](gatewayName, gatewayOwnership, target, {
      "app.kubernetes.io/name": gatewayName,
    }),
  );
  save(driver["manifest"]("v1", "ServiceAccount", agentName, agentOwnership, target));
  save(driver["gatewayPrivateStateClaim"](revision.agentId, gatewayOwnership, target));
  save(driver["manifest"]("v1", "ConfigMap", configurationName, gatewayOwnership, target));
  save(driver["manifest"]("v1", "ConfigMap", pluginName, revisionOwnership, target));
  const agentPolicies: { resource: ObservedResource }[] = driver["agentNetworkPolicies"](
    revision,
    target,
  );
  const policies: ObservedResource[] = [...agentPolicies.map(({ resource }) => resource)];
  for (const policy of policies) {
    save(policy);
  }
  const sibling = driver["manifest"](
    "v1",
    "ConfigMap",
    "sibling-agent-artifact",
    { namespaceId: revision.namespaceId, agentId: "agent-sibling" },
    target,
  );
  save(sibling);

  const terminatingPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "terminating-embedded-gateway",
      namespace,
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  const deletions: { kind: string; name: string }[] = [];
  let podObservations = 0;
  const removeArtifact =
    (kind: string) => async (request: Pick<NamespacedDelete["Deployment"], "name" | "body">) => {
      const current = read(kind, namespace, request.name);
      assert.equal(request.body?.preconditions?.uid, current.metadata.uid);
      deletions.push({ kind, name: request.name });
      resources.delete(key(kind, request.name));
      return {};
    };
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async listNamespace() {
          return { apiVersion: "v1", kind: "NamespaceList", items: [] };
        },
        async readNamespace({ name }: Parameters<Clients["core"]["readNamespace"]>[0]) {
          return read("Namespace", undefined, name);
        },
        async listNamespacedPod({
          namespace: requestedNamespace,
          labelSelector,
        }: Parameters<Clients["core"]["listNamespacedPod"]>[0]) {
          assert.equal(requestedNamespace, namespace);
          assert.ok(labelSelector);
          assert.match(labelSelector, /openclaw\.dev\/workload-role=gateway/);
          podObservations += 1;
          deletions.push({ kind: "PodList", name: revision.id });
          return {
            apiVersion: "v1",
            kind: "PodList",
            items: podObservations === 1 ? [terminatingPod] : [],
          };
        },
        readNamespacedSecret: readNamespaced("Secret"),
        readNamespacedConfigMap: readNamespaced("ConfigMap"),
        deleteNamespacedConfigMap: removeArtifact("ConfigMap"),
        readNamespacedServiceAccount: readNamespaced("ServiceAccount"),
        deleteNamespacedServiceAccount: removeArtifact("ServiceAccount"),
        readNamespacedService: readNamespaced("Service"),
        deleteNamespacedService: removeArtifact("Service"),
        readNamespacedPersistentVolumeClaim: readNamespaced("PersistentVolumeClaim"),
        deleteNamespacedPersistentVolumeClaim: removeArtifact("PersistentVolumeClaim"),
      },
      apps: {
        readNamespacedDeployment: readNamespaced("Deployment"),
        deleteNamespacedDeployment: removeArtifact("Deployment"),
      },
      networking: {
        readNamespacedNetworkPolicy: readNamespaced("NetworkPolicy"),
        deleteNamespacedNetworkPolicy: removeArtifact("NetworkPolicy"),
      },
      objects: {
        async read({ metadata }: Parameters<Clients["objects"]["read"]>[0]) {
          return read("HTTPRoute", namespace, metadata.name);
        },
      },
    }),
  });

  await driver.retireRevision(revision);

  assert.equal(podObservations, 2);
  const claimName = driver["gatewayPrivateStateClaimName"](revision.agentId);
  const podWait = deletions.findIndex(({ kind }) => kind === "PodList");
  assert.ok(podWait > deletions.findIndex(({ kind }) => kind === "Deployment"));
  assert.equal(
    resources.has(key("PersistentVolumeClaim", claimName)),
    true,
    "revision retirement must preserve Agent-owned native state",
  );

  // The worker invokes final Agent cleanup only after every revision has retired.
  await driver.deleteAgentRuntimeCredentials({
    namespace: { ...tenant, status: "ready" },
    agent: {
      ...credentialAgent,
      id: revision.agentId,
      namespaceId: tenant.id,
      executionMode: revision.harness.mode,
      configurationId: revision.configurationId,
      createdAt: revision.createdAt,
      servicePrincipalId: revision.servicePrincipalId,
      status: "deleting",
    },
  });
  assert.ok(
    podWait < deletions.findIndex(({ kind }) => kind === "PersistentVolumeClaim"),
    "Agent storage cleanup must follow terminated gateway Pods",
  );
  const expectedRemovals: [string, string][] = [
    ["Deployment", gatewayName],
    ["Service", gatewayName],
    ["ServiceAccount", agentName],
    ["PersistentVolumeClaim", claimName],
    ["ConfigMap", configurationName],
    ["ConfigMap", pluginName],
    ...policies.map((policy): [string, string] => ["NetworkPolicy", policy.metadata.name]),
  ];
  for (const [kind, name] of expectedRemovals) {
    assert.equal(resources.has(key(kind, name)), false, `${kind} ${name} must be deleted`);
  }
  assert.deepEqual(resources.get(key("ConfigMap", sibling.metadata.name)), sibling);
}
