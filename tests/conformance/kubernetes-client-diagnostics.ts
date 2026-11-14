import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { TestContext } from "node:test";

import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { ComputeAgentRevisionBinding } from "../../packages/contracts/src/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { kubernetesList } from "../helpers/kubernetes-sdk-api.ts";
import { recordingApiServer, writeKubeconfig } from "./kubernetes-client-fixture.ts";

const NAMESPACE_ID = "ns_00000000-0000-4000-8000-000000000001";
const namespaceName = kubernetesNamespaceName(NAMESPACE_ID);
const namespacePath = `/api/v1/namespaces/${namespaceName}`;
const revisionId = "revision-1";
const agentId = "agent-1";
const podName = "gateway-pod";
const podUid = "gateway-uid";
const proxyPath = `${namespacePath}/pods/${podName}%3A18791/proxy/openclaw%2Fruntime%2F`;
const CHECKED_AT = "2026-09-19T12:00:00.000Z";

const namespace = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: namespaceName,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": NAMESPACE_ID,
    },
    annotations: { "openclaw.dev/namespace-id": NAMESPACE_ID },
  },
  status: { phase: "Active" },
};

const gatewayPod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: podName,
    namespace: namespaceName,
    uid: podUid,
    labels: {
      "openclaw.dev/agent": agentId,
      "openclaw.dev/revision": revisionId,
      "openclaw.dev/workload-role": "gateway",
    },
  },
  status: { phase: "Running", podIP: "10.42.0.7" },
};

function answerJson(response: ServerResponse, body: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function acquireRuntimeDiagnostics(t: TestContext, directory: string) {
  let statusAttempts = 0;
  const runtime = { revisionId, container: "gateway", podUid };
  const api = await recordingApiServer(t, directory, (request, response) => {
    assert.ok(request.url);
    const url = new URL(request.url, "https://127.0.0.1");
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    switch (url.pathname) {
      case "/api/v1/namespaces":
        assert.equal(
          url.searchParams.get("labelSelector"),
          `openclaw.dev/namespace=${NAMESPACE_ID}`,
        );
        answerJson(response, kubernetesList("v1", "Namespace", [namespace]));
        break;
      case namespacePath:
        answerJson(response, namespace);
        break;
      case `${namespacePath}/pods`: {
        const labels = gatewayPod.metadata.labels;
        const selector = url.searchParams.get("labelSelector");
        assert.deepEqual(
          selector?.split(",").sort(),
          Object.entries(labels)
            .map(([key, value]) => `${key}=${value}`)
            .sort(),
        );
        answerJson(response, kubernetesList("v1", "Pod", [gatewayPod]));
        break;
      }
      case `${proxyPath}diagnostics`:
        answerJson(response, { ...runtime, observedAt: CHECKED_AT, checks: [] });
        break;
      case `${proxyPath}status`:
        statusAttempts += 1;
        if (statusAttempts === 1) {
          // An API restart can drop the connection before answering the read.
          request.socket.destroy();
        } else {
          answerJson(response, {
            ...runtime,
            runtimeFailure: {
              component: "gateway",
              check: "peer-bridge-record",
              checkedAt: CHECKED_AT,
              code: "UNAVAILABLE",
            },
          });
        }
        break;
      default:
        assert.fail(`Unexpected Kubernetes API request ${request.url}`);
    }
  });

  const driver = new KubernetesComputeDriver({
    ...conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
    authentication: await writeKubeconfig(directory, api, "fixture-token"),
  });
  const binding: ComputeAgentRevisionBinding = {
    namespace: {
      id: NAMESPACE_ID,
      name: "Conformance tenant",
      status: "ready",
      createdAt: CHECKED_AT,
    },
    agent: {
      id: agentId,
      namespaceId: NAMESPACE_ID,
      name: "Transport conformance Agent",
      configurationId: "config-1",
      backendId: null,
      harnessAuth: null,
      gatewayManagedMode: true,
      desiredRuntimeState: "running",
      status: "active",
      executionMode: "embedded",
      servicePrincipalId: "principal-1",
      createdAt: CHECKED_AT,
    },
    revision: {
      id: revisionId,
      namespaceId: NAMESPACE_ID,
      agentId,
      revision: 1,
      configurationId: "config-1",
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: { agents: { defaults: { model: "openai/gpt-5" } } },
      backendId: null,
      gatewayManagedMode: true,
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      harnessAuth: { method: "runtime" },
      compute: { id: driver.id, implementation: driver.implementation },
      executionAdmission: { version: 2, mode: "unprotected" },
      servicePrincipalId: "principal-1",
      createdAt: CHECKED_AT,
    },
  };
  const admission = driver.admitRevision(binding.revision);
  const diagnostics = await driver.diagnoseAgentDeployment({
    ...binding,
    revision: {
      ...binding.revision,
      compute: {
        ...binding.revision.compute,
        ...(admission === undefined ? {} : { admission }),
      },
    },
  });
  const podLists = api.requests.filter(({ path }) => path.startsWith(`${namespacePath}/pods?`));
  return { diagnostics, statusAttempts, podLists };
}
