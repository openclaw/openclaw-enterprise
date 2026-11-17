import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  HarnessAuthSnapshot,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import {
  kubernetesList,
  kubernetesNotFound,
  persistedKubernetesObject,
  startKubernetesSdkApi,
  type KubernetesSdkResponse,
} from "../helpers/kubernetes-sdk-api.ts";
import {
  readyServiceEndpointSliceList,
  singleReplicaReadyDeploymentStatus,
} from "./kubernetes-gateway-readiness-fixture.ts";

import { registerSealedNamespacePolicyCase } from "./kubernetes-namespace-policy-case.ts";
import { registerKubernetesOwnershipRoutingCases } from "./kubernetes-ownership-routing-cases.ts";

type LifecyclePhase = "ensure" | "prepare" | "stop";
type ResourceMethod = "GET" | "PATCH" | "DELETE";
type FixtureResource = {
  kind: string;
  methods: Partial<Record<LifecyclePhase, readonly ResourceMethod[]>>;
};

type WireRecord = Record<string, unknown>;
type StoredResource = WireRecord & {
  metadata: WireRecord & { name: string; uid: string; resourceVersion: string };
};

const tenant: Namespace = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Ownership conformance",
  status: "provisioning",
  createdAt: "2026-08-18T00:00:00.000Z",
};
const agentId = "agt_00000000-0000-4000-8000-000000000001";
const revisionId = "rev_00000000-0000-4000-8000-000000000001";
const agentDigest = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
const revisionDigest = createHash("sha256").update(revisionId).digest("hex").slice(0, 12);
const gatewayName = `gateway-${agentDigest}`;
const namespace = kubernetesNamespaceName(tenant.id);
const namespacePath = `/api/v1/namespaces/${namespace}`;
const appPaths = `/apis/apps/v1/namespaces/${namespace}`;
const policyPaths = `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`;
const endpointsPath = `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`;
const deploymentPath = `${appPaths}/deployments/${gatewayName}`;
const servicePath = `${namespacePath}/services/${gatewayName}`;
const configMapPath = `${namespacePath}/configmaps/${gatewayName}-rev-${revisionDigest}`;
const secretsPath = `${namespacePath}/secrets`;
const harnessSecretName = `harness-secrets-${agentDigest}-${revisionDigest}`;
const harnessSecretPath = `${secretsPath}/${harnessSecretName}`;
const sourceSecretName = "occ-model-key";
const sourceSecretPath = `${secretsPath}/${sourceSecretName}`;
const gatewayImage = "openclaw-enterprise/gateway-fixture:local";

function asRecord(value: unknown): WireRecord {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as WireRecord;
}

function wireWrite(value: WireRecord, path: string, previous?: StoredResource): StoredResource {
  const metadata = asRecord(value.metadata);
  const name = path.split("/").at(-1);
  assert.ok(name);
  assert.equal(metadata.name, name);
  if (path !== namespacePath) {
    assert.equal(metadata.namespace, namespace);
  }
  return persistedKubernetesObject(
    { ...value, metadata: { ...metadata, name } },
    previous?.metadata.uid ?? randomUUID(),
    String(Number(previous?.metadata.resourceVersion ?? "0") + 1),
  );
}

function withForeignAgent(
  resource: StoredResource,
  field: "labels" | "annotations",
  key: string,
): StoredResource {
  return {
    ...resource,
    metadata: {
      ...resource.metadata,
      [field]: { ...asRecord(resource.metadata[field]), [key]: "foreign-agent" },
    },
  };
}

function admittedRevision(driver: KubernetesComputeDriver): {
  revision: AgentRevision;
  context: ComputeRevisionContext;
} {
  const harnessAuth = {
    method: "api_key",
    source: {
      kind: "secret",
      namespaceId: tenant.id,
      id: "sec_00000000-0000-4000-8000-000000000001",
    },
    secretDriverId: "kubernetes-secret",
  } satisfies HarnessAuthSnapshot;
  const context: ComputeRevisionContext = {
    harnessAuth: {
      ...harnessAuth,
      backendRef: {
        namespaceName: namespace,
        name: sourceSecretName,
        key: "value",
        uid: "model-key-uid",
      },
    },
    secretEnvironment: [],
  };
  const configuration = {
    agents: { defaults: { model: "openai/fixture-model" } },
    logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
    diagnostics: { otel: { logs: false } },
    gateway: {
      trustedProxies: ["10.42.0.0/16"],
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
  };
  const harness = { id: "openclaw", version: "1.0.0", mode: "embedded", overrides: {} } as const;
  const revision: AgentRevision = {
    id: revisionId,
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    backendId: null,
    configurationId: "cfg_00000000-0000-4000-8000-000000000009",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration,
    gatewayManagedMode: false,
    harness: {
      ...harness,
      configuration: driver.resolveHarnessConfiguration(harness, harnessAuth, configuration),
    },
    harnessAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: "service-principal-ownership",
    createdAt: tenant.createdAt,
  };
  const admission = driver.admitRevision(revision);
  return {
    revision: {
      ...revision,
      compute: { ...revision.compute, ...(admission === undefined ? {} : { admission }) },
    },
    context,
  };
}

// The test owns the HTTPS origin and the wire observations. The actual Kubernetes
// SDK reads and writes them through the Driver's configured kubeconfig.
async function ownershipLifecycleFixture(t: TestContext, name: string) {
  const objects = new Map<string, StoredResource>();
  let serviceReadinessLabel: "owned" | "foreign" = "owned";
  let serviceApplied = false;
  let phase: LifecyclePhase = "ensure";
  const namespacePolicy = {
    kind: "NetworkPolicy",
    methods: { ensure: ["GET", "PATCH"], prepare: ["GET"] },
  } satisfies FixtureResource;
  const resources = new Map<string, FixtureResource>([
    [
      namespacePath,
      {
        kind: "Namespace",
        methods: { ensure: ["GET", "PATCH"], prepare: ["GET"], stop: ["GET"] },
      },
    ],
    [
      `${namespacePath}/resourcequotas/openclaw-quota`,
      { kind: "ResourceQuota", methods: { ensure: ["GET", "PATCH"] } },
    ],
    [
      `${namespacePath}/limitranges/openclaw-limits`,
      { kind: "LimitRange", methods: { ensure: ["GET", "PATCH"] } },
    ],
    [`${policyPaths}/default-deny`, namespacePolicy],
    [`${policyPaths}/allow-dns`, namespacePolicy],
    [`${policyPaths}/allow-gateway-ingress`, namespacePolicy],
    [
      `${policyPaths}/allow-gateway-channels-${agentDigest}`,
      { kind: "NetworkPolicy", methods: { prepare: ["GET"] } },
    ],
    [
      `${namespacePath}/serviceaccounts/agent-${agentDigest}`,
      { kind: "ServiceAccount", methods: { prepare: ["GET", "PATCH"] } },
    ],
    [
      `${namespacePath}/serviceaccounts/${gatewayName}`,
      { kind: "ServiceAccount", methods: { stop: ["GET"] } },
    ],
    [
      `${namespacePath}/configmaps/harness-trust-${agentDigest}-rev-${revisionDigest}`,
      { kind: "ConfigMap", methods: { stop: ["GET"] } },
    ],
    [
      `${namespacePath}/configmaps/plugin-runtime-${agentDigest}-rev-${revisionDigest}`,
      { kind: "ConfigMap", methods: { stop: ["GET"] } },
    ],
    [
      configMapPath,
      { kind: "ConfigMap", methods: { prepare: ["GET", "PATCH"], stop: ["GET", "DELETE"] } },
    ],
    [
      deploymentPath,
      { kind: "Deployment", methods: { prepare: ["GET", "PATCH"], stop: ["GET", "DELETE"] } },
    ],
    [
      servicePath,
      { kind: "Service", methods: { prepare: ["GET", "PATCH"], stop: ["GET", "DELETE"] } },
    ],
    // The canonical credential is read during preparation. Only the projection is created.
    [sourceSecretPath, { kind: "Secret", methods: { prepare: ["GET"] } }],
    [harnessSecretPath, { kind: "Secret", methods: { prepare: ["GET"], stop: ["GET", "DELETE"] } }],
    [
      `${secretsPath}/gateway-secrets-${agentDigest}-${revisionDigest}`,
      { kind: "Secret", methods: { stop: ["GET"] } },
    ],
  ]);
  const observed = (path: string) => {
    const resource = objects.get(path);
    assert.ok(resource, `Missing fixture resource ${path}`);
    return resource;
  };

  objects.set(
    sourceSecretPath,
    persistedKubernetesObject(
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: sourceSecretName, namespace },
        type: "Opaque",
        data: { value: Buffer.from("fixture-model-credential").toString("base64") },
      },
      "model-key-uid",
    ),
  );
  const api = await startKubernetesSdkApi(t, {
    name,
    respond(request): KubernetesSdkResponse | undefined {
      const { method, pathname, searchParams } = request;
      if (method === "GET" && pathname === "/api/v1/namespaces") {
        assert.equal(searchParams.get("labelSelector"), `openclaw.dev/namespace=${tenant.id}`);
        const found = objects.get(namespacePath);
        return { body: kubernetesList("v1", "Namespace", found === undefined ? [] : [found]) };
      }
      if (method === "GET" && phase === "stop" && pathname === `${namespacePath}/pods`) {
        assert.deepEqual(
          new Set(searchParams.get("labelSelector")?.split(",")),
          new Set([
            `openclaw.dev/namespace=${tenant.id}`,
            `openclaw.dev/agent=${agentId}`,
            `openclaw.dev/revision=${revisionId}`,
            "openclaw.dev/workload-role=gateway",
          ]),
        );
        return { body: kubernetesList("v1", "Pod", []) };
      }
      if (method === "GET" && phase === "prepare" && pathname === endpointsPath) {
        assert.equal(
          searchParams.get("labelSelector"),
          `kubernetes.io/service-name=${gatewayName}`,
        );
        const { items } = readyServiceEndpointSliceList(gatewayName);
        return {
          body: kubernetesList(
            "discovery.k8s.io/v1",
            "EndpointSlice",
            items.map((slice) => ({
              ...slice,
              apiVersion: "discovery.k8s.io/v1",
              kind: "EndpointSlice",
              addressType: "IPv4",
              metadata: {
                ...slice.metadata,
                name: `${gatewayName}-fixture`,
                namespace,
                ownerReferences: slice.metadata.ownerReferences.map((owner) => ({
                  ...owner,
                  apiVersion: "v1",
                  uid: observed(servicePath).metadata.uid,
                })),
              },
              endpoints: slice.endpoints.map((endpoint) => ({
                ...endpoint,
                addresses: ["10.0.0.1"],
              })),
            })),
          ),
        };
      }
      if (method === "POST" && phase === "prepare" && pathname === secretsPath) {
        const body = asRecord(request.body);
        const metadata = asRecord(body.metadata);
        if (
          body.apiVersion !== "v1" ||
          body.kind !== "Secret" ||
          metadata.namespace !== namespace ||
          metadata.name !== harnessSecretName
        ) {
          return undefined;
        }
        if (objects.has(harnessSecretPath)) {
          return {
            status: 409,
            body: {
              apiVersion: "v1",
              kind: "Status",
              status: "Failure",
              reason: "AlreadyExists",
              code: 409,
              message: `secrets "${harnessSecretName}" already exists`,
              details: { name: harnessSecretName, kind: "secrets" },
            },
          };
        }
        const stored = wireWrite(body, harnessSecretPath);
        objects.set(harnessSecretPath, stored);
        return { status: 201, body: stored };
      }
      if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
        return undefined;
      }
      const target = resources.get(pathname);
      if (!target?.methods[phase]?.includes(method)) {
        return undefined;
      }
      if (method === "GET") {
        const resource = objects.get(pathname);
        if (resource === undefined) {
          return kubernetesNotFound(target.kind, pathname.split("/").at(-1) ?? pathname);
        }
        if (pathname === servicePath && serviceApplied && serviceReadinessLabel === "foreign") {
          const foreign = withForeignAgent(resource, "labels", "openclaw.dev/agent");
          objects.set(pathname, foreign);
          return { body: foreign };
        }
        if (pathname === deploymentPath && phase === "prepare") {
          const generation = resource.metadata.generation;
          assert.ok(typeof generation === "number");
          return {
            body: {
              ...resource,
              status: singleReplicaReadyDeploymentStatus(generation),
            },
          };
        }
        return { body: resource };
      }
      if (method === "PATCH") {
        const previous = objects.get(pathname);
        const stored = wireWrite(asRecord(request.body), pathname, previous);
        assert.equal(stored.kind, target.kind);
        if (pathname === namespacePath) {
          stored.status = { phase: "Active" };
        }
        if (pathname === deploymentPath) {
          stored.metadata.generation = Number(previous?.metadata.generation ?? 0) + 1;
        }
        if (pathname === servicePath) {
          serviceApplied = true;
        }
        objects.set(pathname, stored);
        return { body: stored };
      }
      // Record any delete the Driver sends. Assertions below inspect the exact
      // UID and resourceVersion transmitted in the SDK's HTTP body.
      objects.delete(pathname);
      return { body: { apiVersion: "v1", kind: "Status", status: "Success", code: 200 } };
    },
  });
  const resourcesForContainer = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const options: KubernetesComputeDriverOptions = {
    authentication: api.authentication,
    images: {
      gateway: gatewayImage,
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resourcesForContainer,
      agent: resourcesForContainer,
      namespace: { quota: { pods: "10" }, containerDefaults: resourcesForContainer },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
  };
  const driver = new KubernetesComputeDriver(options);
  const { revision, context } = admittedRevision(driver);
  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: true,
  });
  return {
    requests: api.requests,
    observed,
    async prepare(service: "owned" | "foreign" = "owned") {
      phase = "prepare";
      serviceReadinessLabel = service;
      serviceApplied = false;
      return driver.prepareRevision(revision, context);
    },
    setAbsentDeployment() {
      assert.ok(objects.delete(deploymentPath));
    },
    changeAgentAnnotation(path: string) {
      objects.set(path, withForeignAgent(observed(path), "annotations", "openclaw.dev/agent-id"));
    },
    async stop() {
      phase = "stop";
      await driver.stopRevision(revision);
    },
    has(path: string) {
      return objects.has(path);
    },
  };
}

const readyRevision = { namespaceId: tenant.id, agentId, revisionId, ready: true };

registerKubernetesOwnershipRoutingCases();

test("gateway readiness rejects a foreign Service before accepting endpoint readiness", async (t) => {
  for (const service of ["foreign", "owned"] as const) {
    await t.test(service, async (subtest) => {
      const fixture = await ownershipLifecycleFixture(subtest, `readiness-${service}`);
      assert.deepEqual(await fixture.prepare(), readyRevision);
      const prepareAt = fixture.requests.length;
      if (service === "foreign") {
        await assert.rejects(
          fixture.prepare(service),
          /Refusing unowned Kubernetes Service gateway-/,
        );
      } else {
        assert.deepEqual(await fixture.prepare(service), readyRevision);
      }
      const deployment = fixture.observed(deploymentPath);
      const spec = asRecord(asRecord(asRecord(deployment.spec).template).spec);
      const containers = spec.containers;
      assert.partialDeepStrictEqual(containers, [{ name: "gateway", image: gatewayImage }]);
      assert.equal(
        asRecord(fixture.observed(servicePath).metadata.labels)["openclaw.dev/agent"],
        service === "foreign" ? "foreign-agent" : agentId,
      );

      // Reconciliation already succeeded. Only the Service observation after
      // the ready Deployment read differs between these two runs.
      const preparation = fixture.requests.slice(prepareAt);
      const serviceAppliedAt = preparation.findIndex(
        ({ method, pathname }) => method === "PATCH" && pathname === servicePath,
      );
      assert.ok(serviceAppliedAt >= 0);
      assert.deepEqual(
        preparation.slice(serviceAppliedAt + 1).map(({ method, pathname }) => [method, pathname]),
        [
          ["GET", deploymentPath],
          ["GET", servicePath],
          ...(service === "owned" ? [["GET", endpointsPath]] : []),
        ],
      );
    });
  }
});

test("runtime resource deletion rejects foreign resources and retains exact UID preconditions", async (t) => {
  const candidates = [
    { name: "foreign-service", foreign: servicePath, deploymentMissing: true },
    { name: "foreign-config-map", foreign: configMapPath, deploymentMissing: true },
    { name: "foreign-secret", foreign: harnessSecretPath, deploymentMissing: true },
    { name: "owned", foreign: undefined, deploymentMissing: true },
    { name: "owned-deployment", foreign: undefined, deploymentMissing: false },
  ];
  for (const { name, foreign, deploymentMissing } of candidates) {
    await t.test(name, async (subtest) => {
      const fixture = await ownershipLifecycleFixture(subtest, name);
      assert.deepEqual(await fixture.prepare(), readyRevision);
      const orderedDeletes = [
        ...(deploymentMissing ? [] : [deploymentPath]),
        servicePath,
        configMapPath,
        harnessSecretPath,
      ];
      const expectedDeletes = orderedDeletes
        .slice(0, foreign === undefined ? undefined : orderedDeletes.indexOf(foreign))
        .map((pathname) => {
          const { uid, resourceVersion } = fixture.observed(pathname).metadata;
          return {
            pathname,
            body: {
              preconditions: { uid, ...(pathname === deploymentPath ? { resourceVersion } : {}) },
            },
          };
        });
      if (deploymentMissing) {
        // Stop may be retried after the Gateway Deployment has already disappeared.
        fixture.setAbsentDeployment();
      }
      const stopAt = fixture.requests.length;
      if (foreign === undefined) {
        await fixture.stop();
      } else {
        fixture.changeAgentAnnotation(foreign);
        const resource = fixture.observed(foreign);
        await assert.rejects(fixture.stop(), {
          message: `Refusing unowned Kubernetes ${resource.kind} ${resource.metadata.name}.`,
        });
        assert.ok(fixture.has(foreign));
        assert.ok(
          fixture.requests
            .slice(stopAt)
            .some(({ method, pathname }) => method === "GET" && pathname === foreign),
        );
      }
      assert.deepEqual(
        fixture.requests
          .slice(stopAt)
          .filter(({ method }) => method !== "GET")
          .map(({ method, pathname, body }) => ({ method, pathname, body })),
        expectedDeletes.map(({ pathname, body }) => ({ method: "DELETE", pathname, body })),
      );
      assert.ok(fixture.has(sourceSecretPath));
      for (const { pathname } of expectedDeletes) {
        assert.equal(fixture.has(pathname), false);
      }
    });
  }
});

registerSealedNamespacePolicyCase();
