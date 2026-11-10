import assert from "node:assert/strict";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  tenant,
  digest,
  preparedAuth,
  routedOptions,
  routedRevision,
  labelSelectorLabels,
} from "../helpers/kubernetes-routed-scenarios.mjs";

/** What an OpenShell-like Driver labels a revision's workspace-node relay Pod with. */
export function supervisorPeerLabels(revisionId) {
  return {
    "openshell.ai/sandbox-id": `sandbox-${digest(revisionId)}`,
    "openshell.ai/boundary-role": "supervisor",
  };
}

export function providerReadinessFixture({
  provisionHarness,
  harnessEndpoint,
  providerNetwork = {
    namespace: "openshell-system",
    podLabels: { app: "openshell-gateway" },
    address: "10.43.0.50",
    port: 8080,
  },
  revisionOverrides = {},
  lifecycleDrivers = [],
  nodeEnrollment,
  workspaceNodePeerLabels = async ({ revision }) => supervisorPeerLabels(revision.id),
} = {}) {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
      ...(harnessEndpoint === undefined
        ? {}
        : {
            network: {
              providerHarness: providerNetwork,
            },
          }),
    }),
    {
      lifecycleDrivers,
      nodeEnrollment: nodeEnrollment ?? {
        async isConnected() {
          return true;
        },
      },
      sandboxDriver: {
        id: "sandbox-provider",
        implementation: "openshell",
        async provisionHarness(context) {
          if (provisionHarness !== undefined) {
            return provisionHarness(context);
          }
          assert.fail("activation must only observe the previously provisioned Harness");
        },
        ...(harnessEndpoint === undefined ? {} : { harnessEndpoint }),
        workspaceNodePeerLabels,
      },
    },
  );
  const revision = routedRevision(driver, {
    sandboxDriverId: "sandbox-provider",
    configuration: admitLoggingConfiguration(
      {
        agents: { defaults: { model: "codex/gpt-5" } },
        gateway: { ...routedRevision(driver).configuration.gateway, controlUi: { enabled: false } },
      },
      "info",
    ),
    ...revisionOverrides,
  });
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentName = `agent-${digest(revision.agentId)}`;
  const deployment = driver.deployment(
    `${agentName}-rev-${digest(revision.id)}`,
    {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      servicePrincipalId: revision.servicePrincipalId,
    },
    { name: namespace, plane: "execution" },
    "agent:local",
    agentName,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  const { labels } = driver.harnessRequirementsFromDeployment(deployment, "api_key", false);
  const requests = [];
  let observe = () => ({ apiVersion: "v1", kind: "PodList", items: [] });
  const core = {
    async readNamespace() {
      return {
        ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
        status: { phase: "Active" },
      };
    },
    async readNamespacedSecret({ name }) {
      if (name === "occ-model-key") {
        return {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name,
            namespace: kubernetesNamespaceName(tenant.id),
            uid: "model-secret-uid",
          },
          type: "Opaque",
          data: { value: Buffer.from("model-key").toString("base64") },
        };
      }
      const transportName = `transport-${digest(revision.agentId)}`;
      if (name === transportName) {
        const secret = driver.manifest(
          "v1",
          "Secret",
          name,
          { namespaceId: tenant.id, agentId: revision.agentId },
          { name: kubernetesNamespaceName(tenant.id), plane: "control" },
        );
        secret.metadata.uid = "transport-secret-uid";
        return {
          ...secret,
          type: "Opaque",
          data: { "app-server-token": Buffer.from("transport-token").toString("base64") },
        };
      }
      assert.equal(name, driver.workspaceNodeName(revision));
      const nodeSecret = driver.manifest(
        "v1",
        "Secret",
        name,
        driver.pluginRuntimeOwnership(revision),
        { name: namespace, plane: "execution" },
      );
      // Like the API server, the stored object carries a resource version.
      nodeSecret.metadata.uid = "workspace-node-secret-uid";
      nodeSecret.metadata.resourceVersion = "1";
      return {
        ...nodeSecret,
        data: {
          deviceId: Buffer.from("provider-node").toString("base64"),
          // A current setup code, as preparation keeps renewing it.
          expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
        },
      };
    },
    async listNamespace() {
      return { items: [] };
    },
    // The connected readiness check records the enrolled revision in the node Secret.
    async replaceNamespacedSecret({ body }) {
      return body;
    },
    async listNamespacedPod(request) {
      if (request.labelSelector.includes("openclaw.dev/workload-role=gateway")) {
        // The workspace node binding nudge: the Gateway Pod is not modeled here.
        assert.equal(request.namespace, kubernetesNamespaceName(tenant.id));
        return { items: [] };
      }
      requests.push(request);
      assert.equal(request.namespace, namespace);
      assert.deepEqual(labelSelectorLabels(request.labelSelector), {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      });
      assert.equal(request.timeoutSeconds, 10);
      return observe();
    },
  };
  // Only the Kubernetes transport returns fixture data. Candidate selection, validation,
  // request cancellation, and revision activation all execute the production driver.
  driver.apiClients = Promise.resolve({ core });
  return {
    driver,
    revision,
    namespace,
    deployment,
    labels,
    requests,
    core,
    // The Sandbox Driver Compute holds, so a test can add an optional method later.
    sandbox: driver.sandboxDriver,
    pod(name, ready = "True") {
      return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace, labels: { ...labels } },
        status: { conditions: [{ type: "Ready", status: ready }] },
      };
    },
    setObservation(value) {
      observe = typeof value === "function" ? value : () => structuredClone(value);
    },
    ready() {
      return driver.providerHarnessReady(revision, { name: namespace, plane: "execution" }, labels);
    },
  };
}
