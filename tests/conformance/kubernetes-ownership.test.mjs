import assert from "node:assert/strict";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

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
  const workload = driver.manifest(
    "apps/v1",
    "Deployment",
    "harness",
    revisionOwnership,
    namespace,
  );
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
    await driver.getOwned("Deployment", "harness", namespace, revisionOwnership),
    undefined,
  );
  observed = workload;
  assert.deepEqual(
    await driver.getOwned("Deployment", "harness", namespace, revisionOwnership),
    workload,
  );

  // A matching object name is insufficient: every expected ownership marker must match.
  for (const field of ["labels", "annotations"]) {
    for (const key of Object.keys(workload.metadata[field])) {
      observed = structuredClone(workload);
      observed.metadata[field][key] = "foreign-owner";
      await assert.rejects(
        driver.getOwned("Deployment", "harness", namespace, revisionOwnership),
        /Refusing unowned Kubernetes Deployment harness/,
      );
    }
  }
});

test("reconcile checks ownership before patching and preserves revision routing preconditions", async () => {
  const driver = createTestKubernetesComputeDriver();
  const desired = driver.service("gateway", ownership, namespace, { app: "inactive" });
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
  await assert.rejects(driver.reconcile(desired, ownership, namespace), /Refusing unowned/);
  assert.equal(patches.length, 0);

  observed = structuredClone(desired);
  observed.spec.selector = { "openclaw.dev/revision": "new-revision" };
  await driver.reconcile(desired, ownership, namespace, {
    serviceSelector: { "openclaw.dev/revision": "old-revision" },
  });
  assert.equal(patches.length, 0, "a stale revision must not deactivate its replacement");

  await driver.reconcile(desired, ownership, namespace, {
    serviceSelector: { "openclaw.dev/revision": "new-revision" },
  });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, desired);
});

test("gateway readiness rejects a foreign Service before accepting endpoint readiness", async () => {
  const driver = createTestKubernetesComputeDriver();
  const deployment = driver.manifest("apps/v1", "Deployment", "gateway", ownership, namespace);
  deployment.metadata.generation = 1;
  deployment.spec = { replicas: 1 };
  deployment.status = { observedGeneration: 1, readyReplicas: 1 };
  const service = driver.service("gateway", ownership, namespace, { app: "gateway" });
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

  await assert.rejects(driver.gatewayReady(ownership, "gateway", namespace), /Refusing unowned/);
  assert.equal(endpointReads, 0);
});

test("gateway deletion rejects foreign resources and retains exact UID preconditions", async () => {
  const driver = createTestKubernetesComputeDriver();
  const service = driver.service("gateway", ownership, namespace, { app: "gateway" });
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
  await assert.rejects(driver.deleteGateway("gateway", ownership, namespace), /Refusing unowned/);
  assert.equal(deletions.length, 0);

  observed = service;
  await driver.deleteGateway("gateway", ownership, namespace);
  assert.deepEqual(deletions, [
    { name: "gateway", namespace, body: { preconditions: { uid: "service-uid" } } },
  ]);
});
