import assert from "node:assert/strict";
import test from "node:test";
import { buildControllerTopologyManifests } from "../helpers/topology-controller-manifests.ts";

test("controller topology keeps API-only fixture inputs separate from the worker", () => {
  const labels = {
    "app.kubernetes.io/name": "controller-test",
    "app.kubernetes.io/component": "api",
  };
  const { manifests, apiPodSpec, apiContainer, workerName, workerLabels } =
    buildControllerTopologyManifests({
      apiConfiguration: {},
      authBaseURL: "https://auth.example.invalid",
      authSecret: "inert-fixture",
      controller: { apiAccount: "controller-api", account: "controller-worker" },
      controllerImage: "example.invalid/controller:test",
      databaseAddress: "192.0.2.11",
      databaseServiceName: "topology-db",
      inClusterDatabaseUrl: new URL("postgresql://topology-db:5432/fixture"),
      kubernetesAddress: "192.0.2.12",
      kubernetesPort: 6443,
      labels,
      name: "controller",
      configurationSecret: "topology-installation",
      databaseSecret: "topology-database",
      authSecretName: "topology-auth",
      probeConfigMap: "topology-probe",
      probeSource: "",
      nativeAdminDomain: "agents.example.invalid",
      nativeAdminEnabled: true,
      platformNamespace: "controller-topology",
      workerOptions: {
        pollIntervalMs: 20,
        leaseDurationMs: 5000,
        maxAttempts: 3,
        convergenceTimeoutMs: 10000,
      },
      workspaceGateway: { apiKeySecretName: "gateway-key", caSecretName: "gateway-ca" },
    });

  const apiDeployment = manifests.items.find(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name === "controller",
  );
  const workerDeployment = manifests.items.find(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name === workerName,
  );
  assert.ok(apiDeployment?.spec && "template" in apiDeployment.spec);
  assert.ok(workerDeployment?.spec && "template" in workerDeployment.spec);
  const workerPod = workerDeployment.spec.template.spec;
  const [worker] = workerPod.containers;
  assert.ok(worker);
  assert.equal(apiDeployment.spec.template.spec, apiPodSpec);
  assert.equal(apiPodSpec.containers[0], apiContainer);
  assert.deepEqual(
    apiPodSpec.containers.map(({ name }) => name),
    ["api", "loopback-forwarder"],
  );
  assert.deepEqual(
    workerPod.containers.map(({ name }) => name),
    ["worker"],
  );
  assert.equal(apiPodSpec.serviceAccountName, "controller-api");
  assert.equal(workerPod.serviceAccountName, "controller-worker");
  assert.equal(apiDeployment.spec.selector.matchLabels, labels);
  assert.equal(workerDeployment.spec.selector.matchLabels, workerLabels);
  assert.notEqual(workerLabels, labels);

  assert.ok(apiContainer.env.some(({ name }) => name === "OCC_AUTH_BASE_URL"));
  assert.deepEqual(
    worker.env.map(({ name }) => name),
    [
      "NODE_ENV",
      "OCC_CONFIG_PATH",
      "OCC_DATABASE_URL",
      "OCC_GATEWAY_API_KEY_PATH",
      "NODE_EXTRA_CA_CERTS",
      "OCC_WORKER_READINESS_PATH",
      "OCC_WORKER_LIVENESS_PATH",
      "OCC_WORKER_POLL_INTERVAL_MS",
      "OCC_WORKER_LEASE_DURATION_MS",
      "OCC_WORKER_MAX_ATTEMPTS",
      "OCC_WORKER_CONVERGENCE_TIMEOUT_MS",
    ],
  );
  assert.deepEqual(
    workerPod.volumes.map(({ name }) => name),
    ["installation", "gateway-api-key", "gateway-ca", "worker-readiness"],
  );

  const extraEnvironment = { name: "TOPOLOGY_API_ONLY", value: "inert" };
  apiContainer.env.push(extraEnvironment);
  assert.equal(apiDeployment.spec.template.spec.containers[0]?.env.at(-1), extraEnvironment);
  assert.ok(worker.env.every((entry) => entry !== extraEnvironment));

  const apiPolicy = manifests.items.find(
    ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === "controller-isolation",
  );
  const workerPolicy = manifests.items.find(
    ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === `${workerName}-isolation`,
  );
  assert.ok(apiPolicy?.spec && "egress" in apiPolicy.spec && apiPolicy.spec.egress);
  assert.ok(workerPolicy?.spec && "egress" in workerPolicy.spec && workerPolicy.spec.egress);
  assert.deepEqual(workerPolicy.spec.egress, apiPolicy.spec.egress);
  assert.notEqual(workerPolicy.spec.egress, apiPolicy.spec.egress);
  assert.notEqual(workerPolicy.spec.egress[0], apiPolicy.spec.egress[0]);
});
