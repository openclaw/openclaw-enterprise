import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import {
  type KubernetesSdkRequest,
  kubernetesList,
  kubernetesNotFound,
  startKubernetesSdkApi,
} from "../helpers/kubernetes-sdk-api.ts";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const agentId = "agt_00000000-0000-4000-8000-000000000001";
const revisionId = "rev_00000000-0000-4000-8000-000000000001";
const replacementId = "rev_00000000-0000-4000-8000-000000000002";
const servicePrincipalId = `service-agent-${agentId}`;
const namespace = kubernetesNamespaceName(namespaceId);
const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);
const agentSuffix = hash(agentId);
const revisionSuffix = hash(revisionId);
const agentName = `agent-${agentSuffix}`;
const gatewayName = `gateway-${agentSuffix}`;
const deploymentName = `${agentName}-rev-${revisionSuffix}`;
const namespacePath = "/api/v1/namespaces";
const tenantPath = `${namespacePath}/${namespace}`;
const deploymentsPath = `/apis/apps/v1/namespaces/${namespace}/deployments`;
const deploymentPath = `${deploymentsPath}/${deploymentName}`;
const servicePath = `${tenantPath}/services/${agentName}`;
const namespaceLabels = {
  "app.kubernetes.io/managed-by": "openclaw-enterprise",
  "openclaw.dev/namespace": namespaceId,
};
const namespaceAnnotations = { "openclaw.dev/namespace-id": namespaceId };
const agentLabels = { ...namespaceLabels, "openclaw.dev/agent": agentId };
const agentAnnotations = { ...namespaceAnnotations, "openclaw.dev/agent-id": agentId };
const principalLabels = { ...agentLabels, "openclaw.dev/service-principal": servicePrincipalId };
const principalAnnotations = {
  ...agentAnnotations,
  "openclaw.dev/service-principal-id": servicePrincipalId,
};
const deploymentLabels = { ...principalLabels, "openclaw.dev/revision": revisionId };
const deploymentAnnotations = { ...principalAnnotations, "openclaw.dev/revision-id": revisionId };
const tenant = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: namespace,
    labels: namespaceLabels,
    annotations: namespaceAnnotations,
    uid: "00000000-0000-4000-8000-000000000005",
    resourceVersion: "10",
  },
  status: { phase: "Active" },
};
function deploymentSpec(name: string, container: string, image: string) {
  const matchLabels = { "app.kubernetes.io/name": name };
  return {
    replicas: 1,
    selector: { matchLabels },
    template: {
      metadata: { labels: matchLabels },
      spec: { containers: [{ name: container, image }] },
    },
  };
}

const replacementGateway = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: gatewayName,
    namespace,
    labels: { ...agentLabels, "openclaw.dev/revision": replacementId },
    annotations: {
      ...agentAnnotations,
      "openclaw.dev/agent-revision": "2",
      "openclaw.dev/agent-revision-id": replacementId,
    },
    uid: "00000000-0000-4000-8000-000000000006",
    generation: 2,
    resourceVersion: "11",
  },
  spec: deploymentSpec(gatewayName, "gateway", "gateway:local"),
  status: { observedGeneration: 2, replicas: 1, readyReplicas: 1 },
};
const ownedDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: deploymentName,
    namespace,
    labels: deploymentLabels,
    annotations: deploymentAnnotations,
    uid: "00000000-0000-4000-8000-000000000003",
    resourceVersion: "12",
  },
  spec: deploymentSpec(deploymentName, "agent", "agent:local"),
};
const serviceIdentity = {
  apiVersion: "v1",
  kind: "Service",
  metadata: {
    name: agentName,
    namespace,
    labels: principalLabels,
    annotations: principalAnnotations,
  },
};
const servicePorts = [
  { name: "websocket", port: 18790, targetPort: 18790 },
  { name: "plugin-status", port: 18791, targetPort: 18791 },
];
const exactSelector = {
  "app.kubernetes.io/name": deploymentName,
  "openclaw.dev/network-profile": "broad-egress-v1",
  "openclaw.dev/namespace": namespaceId,
  "openclaw.dev/agent": agentId,
  "openclaw.dev/revision": revisionId,
  "openclaw.dev/workload-role": "agent",
};
const ownedService = {
  ...serviceIdentity,
  metadata: {
    ...serviceIdentity.metadata,
    uid: "00000000-0000-4000-8000-000000000004",
    resourceVersion: "13",
  },
  spec: {
    type: "ClusterIP",
    selector: exactSelector,
    ports: servicePorts,
    clusterIP: "10.96.0.42",
  },
};
const inactiveService = {
  ...serviceIdentity,
  spec: {
    type: "ClusterIP",
    selector: { "app.kubernetes.io/name": `${agentName}-inactive` },
    ports: servicePorts,
  },
};

function createDriver(
  authentication: KubernetesComputeDriverOptions["authentication"],
  routed: boolean,
): KubernetesComputeDriver {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return new KubernetesComputeDriver(
    {
      authentication,
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        ...(routed
          ? {}
          : { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }),
      },
      servicePrincipalCredentials: { mode: "disabled" },
      ...(routed
        ? {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              gatewayNodeSelector: { "oce-role": "control" },
            },
          }
        : {}),
    },
    {
      id: "ownership-conformance",
      ...(routed
        ? {
            nodeEnrollment: createGatewayNodeEnrollment(async () => {
              assert.fail("Deactivation must not request a Gateway enrollment credential.");
            }),
          }
        : {}),
    },
  );
}

function admittedRevision(driver: KubernetesComputeDriver, routed: boolean): AgentRevision {
  const candidate: AgentRevision = {
    id: revisionId,
    agentId,
    namespaceId,
    revision: 1,
    backendId: null,
    executionAdmission: { version: 2, mode: "unprotected" },
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: routed,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      ...(routed
        ? {
            gateway: {
              trustedProxies: ["127.0.0.1/32"],
              allowRealIpFallback: true,
              auth: {
                mode: "trusted-proxy",
                trustedProxy: {
                  userHeader: "x-occ-identity",
                  allowUsers: ["occ-workspace-files"],
                },
                identityScopes: { "occ-workspace-files": ["operator.admin"] },
              },
            },
          }
        : {}),
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    harnessAuth: {
      method: "api_key",
      source: {
        kind: "secret",
        namespaceId,
        id: "sec_00000000-0000-4000-8000-000000000001",
      },
      secretDriverId: "kubernetes-secret",
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId,
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const resolved: AgentRevision = {
    ...candidate,
    harness: {
      ...candidate.harness,
      configuration: driver.resolveHarnessConfiguration(
        candidate.harness,
        candidate.harnessAuth,
        candidate.configuration,
      ),
    },
  };
  const admission = driver.admitRevision(resolved);
  return admission === undefined
    ? resolved
    : { ...resolved, compute: { ...resolved.compute, admission } };
}

function callsAfter(requests: readonly KubernetesSdkRequest[], mark: number) {
  return requests.slice(mark).map(({ method, pathname }) => [method, pathname]);
}

// Loopback responses exercise SDK transport and Driver behavior. A live cluster provides
// separate admission, rollout, and networking proof.
export function registerKubernetesOwnershipRoutingCases(): void {
  test("owned reads preserve missing resources and reject mismatched workload identity", async (t) => {
    let observed: typeof ownedDeployment | undefined;
    const absentArtifacts = new Map([
      [`${tenantPath}/configmaps/harness-trust-${agentSuffix}-rev-${revisionSuffix}`, "configmaps"],
      [`${tenantPath}/configmaps/${gatewayName}-rev-${revisionSuffix}`, "configmaps"],
      [
        `${tenantPath}/configmaps/plugin-runtime-${agentSuffix}-rev-${revisionSuffix}`,
        "configmaps",
      ],
      [`${tenantPath}/secrets/harness-secrets-${agentSuffix}-${revisionSuffix}`, "secrets"],
      [`${tenantPath}/secrets/gateway-secrets-${agentSuffix}-${revisionSuffix}`, "secrets"],
    ]);
    const api = await startKubernetesSdkApi(t, {
      name: "ownership-workload",
      respond({ method, pathname, searchParams }) {
        if (method === "GET" && pathname === namespacePath) {
          assert.equal(searchParams.get("labelSelector"), `openclaw.dev/namespace=${namespaceId}`);
          return { body: kubernetesList("v1", "Namespace", [tenant]) };
        }
        if (method === "GET" && pathname === tenantPath) {
          return { body: tenant };
        }
        if (method === "GET" && pathname === deploymentPath) {
          return observed === undefined
            ? kubernetesNotFound("deployments", deploymentName, "apps")
            : { body: observed };
        }
        if (method === "GET" && pathname === `${deploymentsPath}/${gatewayName}`) {
          // The replacement is serving. Retirement only removes predecessor-owned resources.
          return { body: replacementGateway };
        }
        if (method === "GET" && pathname === `${tenantPath}/pods`) {
          const labels = searchParams.get("labelSelector");
          assert.ok(labels?.split(",").includes(`openclaw.dev/revision=${revisionId}`));
          return { body: kubernetesList("v1", "Pod", []) };
        }
        const absentKind = absentArtifacts.get(pathname);
        if (method === "GET" && absentKind !== undefined) {
          return kubernetesNotFound(absentKind, pathname.split("/").at(-1) ?? "");
        }
        if (method === "DELETE" && pathname === deploymentPath) {
          observed = undefined;
          return { body: { apiVersion: "v1", kind: "Status", status: "Success", code: 200 } };
        }
        return undefined;
      },
    });
    const driver = createDriver(api.authentication, false);
    const revision = admittedRevision(driver, false);
    const readsBeforeOwnershipCheck = [
      ["GET", namespacePath],
      ["GET", tenantPath],
      ["GET", deploymentPath],
    ];
    const cleanupReads = [
      ["GET", `${tenantPath}/pods`],
      ["GET", `${deploymentsPath}/${gatewayName}`],
      ["GET", `${tenantPath}/pods`],
      ...Array.from(absentArtifacts.keys(), (path) => ["GET", path]),
    ];

    await driver.retireRevision(revision);
    assert.deepEqual(callsAfter(api.requests, 0), [...readsBeforeOwnershipCheck, ...cleanupReads]);
    observed = ownedDeployment;
    const mark = api.requests.length;
    await driver.retireRevision(revision);
    assert.deepEqual(callsAfter(api.requests, mark), [
      ...readsBeforeOwnershipCheck,
      ["DELETE", deploymentPath],
      ...cleanupReads,
    ]);
    const deletion = api.requests.slice(mark).find(({ method }) => method === "DELETE");
    assert.ok(deletion);
    assert.deepEqual(deletion.body, { preconditions: { uid: ownedDeployment.metadata.uid } });

    // Each independently specified owner marker is required even when the resource name matches.
    for (const field of ["labels", "annotations"] as const) {
      for (const key of Object.keys(ownedDeployment.metadata[field])) {
        observed = {
          ...ownedDeployment,
          metadata: {
            ...ownedDeployment.metadata,
            [field]: { ...ownedDeployment.metadata[field], [key]: "foreign-owner" },
          },
        };
        const start = api.requests.length;
        await assert.rejects(
          driver.retireRevision(revision),
          {
            message: `Refusing unowned Kubernetes Deployment ${deploymentName}.`,
          },
          `${field}.${key}`,
        );
        assert.deepEqual(
          callsAfter(api.requests, start),
          readsBeforeOwnershipCheck,
          `${field}.${key}`,
        );
      }
    }
  });

  test("reconcile checks ownership before patching and preserves revision routing preconditions", async (t) => {
    let observed: typeof ownedService | undefined;
    const api = await startKubernetesSdkApi(t, {
      name: "ownership-routing",
      respond({ method, pathname, searchParams }) {
        if (method === "GET" && pathname === namespacePath) {
          assert.equal(searchParams.get("labelSelector"), `openclaw.dev/namespace=${namespaceId}`);
          return { body: kubernetesList("v1", "Namespace", [tenant]) };
        }
        if (method === "GET" && pathname === servicePath) {
          return observed === undefined
            ? kubernetesNotFound("services", agentName)
            : { body: observed };
        }
        if (method === "PATCH" && pathname === servicePath) {
          return {
            body: {
              ...ownedService,
              metadata: { ...ownedService.metadata, resourceVersion: "14" },
              spec: { ...ownedService.spec, selector: inactiveService.spec.selector },
            },
          };
        }
        return undefined;
      },
    });
    const driver = createDriver(api.authentication, true);
    const revision = admittedRevision(driver, true);
    const readPaths = [
      ["GET", namespacePath],
      ["GET", servicePath],
    ];

    await driver.deactivateRevision(revision);
    assert.deepEqual(callsAfter(api.requests, 0), readPaths);

    observed = {
      ...ownedService,
      metadata: {
        ...ownedService.metadata,
        annotations: { ...principalAnnotations, "openclaw.dev/agent-id": "foreign-agent" },
      },
    };
    const foreign = api.requests.length;
    await assert.rejects(driver.deactivateRevision(revision), {
      message: `Refusing unowned Kubernetes Service ${agentName}.`,
    });
    assert.deepEqual(callsAfter(api.requests, foreign), readPaths);

    // A same-named response from another tenant, or with another resource identity, must fail closed.
    for (const wrongResource of [
      { ...ownedService, kind: "ConfigMap" },
      { ...ownedService, metadata: { ...ownedService.metadata, name: `${agentName}-other` } },
      { ...ownedService, metadata: { ...ownedService.metadata, namespace: "foreign-namespace" } },
    ]) {
      observed = wrongResource;
      const wrongTarget = api.requests.length;
      await assert.rejects(driver.deactivateRevision(revision), {
        message: `The Kubernetes client returned an invalid or ambiguous Service ${agentName}.`,
      });
      assert.deepEqual(callsAfter(api.requests, wrongTarget), readPaths);
    }

    // Ownership of the stable Service does not authorize disabling a replacement revision.
    for (const [key, value] of [
      ["openclaw.dev/agent", "other-agent"],
      ["openclaw.dev/revision", replacementId],
      ["openclaw.dev/workload-role", "gateway"],
    ] as const) {
      observed = {
        ...ownedService,
        spec: { ...ownedService.spec, selector: { ...exactSelector, [key]: value } },
      };
      const stale = api.requests.length;
      await driver.deactivateRevision(revision);
      assert.deepEqual(callsAfter(api.requests, stale), readPaths, key);
    }

    observed = ownedService;
    const exact = api.requests.length;
    await driver.deactivateRevision(revision);
    assert.deepEqual(callsAfter(api.requests, exact), [...readPaths, ["PATCH", servicePath]]);
    const patch = api.requests.at(-1);
    assert.ok(patch);
    assert.deepEqual(Object.fromEntries(patch.searchParams), {
      fieldManager: "openclaw-enterprise-compute",
      force: "false",
    });
    assert.equal(patch.headers["content-type"], "application/apply-patch+yaml");
    assert.deepEqual(patch.body, inactiveService);
  });
}
