import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  kubernetesNamespaceName,
  PreprovisionedKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { ObjectSerializer } = controllerRequire("@kubernetes/client-node/dist/serializer.js");

const namespace = "ownership-conformance";
const ownership = {
  namespaceId: "ns_00000000-0000-4000-8000-000000000001",
  agentId: "agt_00000000-0000-4000-8000-000000000001",
};

// Transport-only fixtures below exercise the actual read, ownership, readiness,
// reconcile, and deletion logic; they do not establish live Kubernetes enforcement.
test("owned reads preserve missing resources and reject mismatched workload identity", async () => {
  const driver = createTestKubernetesComputeDriver();
  const revisionOwnership = {
    ...ownership,
    revisionId: "rev_00000000-0000-4000-8000-000000000001",
    servicePrincipalId: `service-agent-${ownership.agentId}`,
  };
  const workload = driver.manifest("apps/v1", "Deployment", "harness", revisionOwnership, {
    name: namespace,
    plane: "execution",
  });
  let observed;
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment() {
        if (observed === undefined) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(observed);
      },
    },
  });

  assert.equal(
    await driver.getOwned(
      "Deployment",
      "harness",
      { name: namespace, plane: "execution" },
      revisionOwnership,
    ),
    undefined,
  );
  observed = workload;
  assert.deepEqual(
    await driver.getOwned(
      "Deployment",
      "harness",
      { name: namespace, plane: "execution" },
      revisionOwnership,
    ),
    workload,
  );

  // A matching object name is insufficient: every expected ownership marker must match.
  for (const field of ["labels", "annotations"]) {
    for (const key of Object.keys(workload.metadata[field])) {
      observed = structuredClone(workload);
      observed.metadata[field][key] = "foreign-owner";
      await assert.rejects(
        driver.getOwned(
          "Deployment",
          "harness",
          { name: namespace, plane: "execution" },
          revisionOwnership,
        ),
        /Refusing unowned Kubernetes Deployment harness/,
      );
    }
  }
});

test("reconcile checks ownership before patching and preserves revision routing preconditions", async () => {
  const driver = createTestKubernetesComputeDriver();
  const desired = driver.service(
    "gateway",
    ownership,
    { name: namespace, plane: "execution" },
    { app: "inactive" },
  );
  let observed = structuredClone(desired);
  const patches = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedService() {
        return structuredClone(observed);
      },
      async patchNamespacedService(request) {
        patches.push(request);
      },
    },
  });

  // Foreign Services must not be adopted even though the API permits a patch by name.
  observed.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
  await assert.rejects(
    driver.reconcile(desired, ownership, { name: namespace, plane: "execution" }),
    /Refusing unowned/,
  );
  assert.equal(patches.length, 0);

  observed = structuredClone(desired);
  observed.spec.selector = { "openclaw.dev/revision": "new-revision" };
  await driver.reconcile(
    desired,
    ownership,
    { name: namespace, plane: "execution" },
    {
      serviceSelector: { "openclaw.dev/revision": "old-revision" },
    },
  );
  assert.equal(patches.length, 0, "a stale revision must not deactivate its replacement");

  await driver.reconcile(
    desired,
    ownership,
    { name: namespace, plane: "execution" },
    {
      serviceSelector: { "openclaw.dev/revision": "new-revision" },
    },
  );
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, desired);
});

test("gateway readiness rejects a foreign Service before accepting endpoint readiness", async () => {
  const driver = createTestKubernetesComputeDriver();
  const deployment = driver.deployment(
    "gateway",
    ownership,
    { name: namespace, plane: "execution" },
    "gateway:local",
    "gateway",
    "gateway",
    {},
    "info",
  );
  deployment.metadata.generation = 1;
  deployment.status = { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1 };
  const service = driver.service(
    "gateway",
    ownership,
    { name: namespace, plane: "execution" },
    { app: "gateway" },
  );
  service.metadata.labels["openclaw.dev/agent"] = "another-agent";
  let endpointReads = 0;
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment() {
        return deployment;
      },
    },
    core: {
      async readNamespacedService() {
        return service;
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        endpointReads += 1;
        return { items: [] };
      },
    },
  });

  await assert.rejects(
    driver.gatewayReady(ownership, "gateway", { name: namespace, plane: "execution" }),
    /Refusing unowned/,
  );
  assert.equal(endpointReads, 0);
});

test("runtime resource deletion rejects foreign resources and retains exact UID preconditions", async () => {
  const driver = createTestKubernetesComputeDriver();
  const service = driver.service(
    "gateway",
    ownership,
    { name: namespace, plane: "execution" },
    { app: "gateway" },
  );
  service.metadata.uid = "service-uid";
  let observed = structuredClone(service);
  const deletions = [];
  const missing = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  driver.apiClients = Promise.resolve({
    apps: { readNamespacedDeployment: missing },
    core: {
      async readNamespacedService() {
        return structuredClone(observed);
      },
      readNamespacedServiceAccount: missing,
      async deleteNamespacedService(request) {
        deletions.push(request);
      },
    },
  });

  observed.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
  await assert.rejects(
    driver.deleteNamedRuntimeResources("gateway", ownership, {
      name: namespace,
      plane: "execution",
    }),
    /Refusing unowned/,
  );
  assert.equal(deletions.length, 0);

  observed = service;
  await driver.deleteNamedRuntimeResources("gateway", ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(deletions, [
    { name: "gateway", namespace, body: { preconditions: { uid: "service-uid" } } },
  ]);
});

test("sealed Namespace compares SDK-deserialized ingress exactly", async () => {
  const driver = createTestKubernetesComputeDriver();
  const target = { name: kubernetesNamespaceName(ownership.namespaceId), plane: "execution" };
  const policy = {
    ...driver.manifest(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      "operator-ingress",
      ownership,
      target,
    ),
    spec: {
      podSelector: { matchLabels: { app: "gateway" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: "worker" } } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    },
  };
  driver.preprovisionedNamespace = new PreprovisionedKubernetesNamespace(
    JSON.stringify({
      namespaceId: ownership.namespaceId,
      uid: "00000000-0000-4000-8000-000000000001",
    }),
    { gatewayNamespace: "controller", gatewayName: "gateway" },
    [{ ...policy, metadata: { name: policy.metadata.name } }],
  );
  let wire = structuredClone(policy);
  let extra;
  driver.apiClients = Promise.resolve({
    networking: {
      async listNamespacedNetworkPolicy() {
        // Use the same SDK deserializer as NetworkingV1Api's response processor.
        const result = ObjectSerializer.deserialize({ items: [wire] }, "V1NetworkPolicyList");
        assert.deepEqual(
          JSON.parse(JSON.stringify(result.items[0].spec.ingress[0]._from ?? null)),
          wire.spec.ingress[0].from ?? null,
        );
        extra?.(result.items[0].spec);
        return result;
      },
    },
  });

  await driver.verifyExistingNetworkPolicies(target, ownership);
  assert.ok(policy.spec.ingress[0].from);
  assert.equal(policy.spec.ingress[0]._from, undefined);

  // Additive policies and changes to either peers or ports must still fail closed.
  for (const mutate of [
    (value) => {
      value.metadata.name = "undeclared-allow-all";
      value.spec.podSelector = {};
      value.spec.ingress = [{}];
    },
    (value) => {
      value.spec.ingress[0].from = [{}];
    },
    (value) => {
      value.spec.ingress[0].ports[0].port = 9090;
    },
  ]) {
    wire = structuredClone(policy);
    mutate(wire);
    await assert.rejects(
      driver.verifyExistingNetworkPolicies(target, ownership),
      /undeclared or changed NetworkPolicy/,
    );
  }
  wire = structuredClone(policy);
  // Unknown fields surviving transport must not disappear during projection.
  for (const add of [
    (spec) => {
      spec.unexpected = true;
    },
    (spec) => {
      spec.ingress[0].unexpected = true;
    },
    (spec) => {
      spec.ingress[0].from = [{}];
    },
    (spec) => {
      // Plain objects carrying SDK aliases are not SDK ingress models.
      spec.ingress[0] = { ...spec.ingress[0] };
    },
  ]) {
    extra = add;
    await assert.rejects(
      driver.verifyExistingNetworkPolicies(target, ownership),
      /undeclared or changed NetworkPolicy/,
    );
  }
});
