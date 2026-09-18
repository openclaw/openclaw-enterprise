import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  resolveKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Conformance tenant",
  status: "ready",
  createdAt: "2026-08-18T00:00:00.000Z",
};

const apiKeyAuth = {
  method: "api_key",
  source: {
    kind: "secret",
    namespaceId: tenant.id,
    id: "sec_00000000-0000-4000-8000-000000000001",
  },
  secretDriverId: "kubernetes-secret",
};

function authContext(revision, namespace = kubernetesNamespaceName(tenant.id)) {
  return {
    harnessAuth:
      revision.harnessAuth.method === "api_key"
        ? {
            ...revision.harnessAuth,
            backendRef: {
              namespaceName: namespace,
              name: "occ-model-key",
              key: "value",
              uid: "model-secret-uid",
            },
          }
        : revision.harnessAuth,
  };
}

function preparedAuth(driver, namespace, embedded = false, harnessAuth = apiKeyAuth) {
  const revision = {
    namespaceId: tenant.id,
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth,
    configuration: { agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } } },
  };
  return driver.harnessAuthForRevision(revision, authContext(revision, namespace), namespace);
}

function options(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    ...overrides,
  };
}

function digest(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function defaultGatewayHostname(routing) {
  return `occ-gateway-${digest(`${routing.gatewayNamespace}/${routing.gatewayName}`)}.${routing.envoyNamespace}.svc`;
}

const gatewayRouting = {
  hostname: "agents.example.internal",
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
};

function routedOptions(overrides = {}) {
  const configured = options();
  const { gatewayClients, ...network } = configured.network;
  return options({
    ...overrides,
    gatewayRouting: overrides.gatewayRouting ?? gatewayRouting,
    network: {
      ...network,
      ...(overrides.network ?? {}),
    },
  });
}

function routedRevision(driver, overrides = {}) {
  return {
    id: "revision-routed-1",
    namespaceId: tenant.id,
    agentId: "agent-routed",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000009",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
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
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-routed",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

test("Kubernetes namespace names are deterministic, DNS-safe, distinct, and bounded", () => {
  for (const id of ["Namespace_With.UPPERCASE!punctuation", "x".repeat(250), "---"]) {
    const name = kubernetesNamespaceName(id);
    const suffix = createHash("sha256").update(id).digest("hex").slice(0, 12);

    assert.equal(name, kubernetesNamespaceName(id));
    assert.match(name, /^oce-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(name.length <= 63);
    assert.ok(name.endsWith(suffix));
  }

  // Distinct tenant identifiers must not collide when their readable names normalize equally.
  assert.notEqual(kubernetesNamespaceName("Team A"), kubernetesNamespaceName("Team-A"));
});

test("namespace resolver selects exact, secure external ownership using a transport-only fixture", async () => {
  const external = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-id": tenant.id,
        "openclaw.dev/namespace-lifecycle": "external",
      },
    },
    status: { phase: "Active" },
  };
  // The fixture supplies Kubernetes response data only; the actual resolver makes every decision.
  const discover = (items) =>
    resolveKubernetesNamespace(
      {
        async listNamespace(request) {
          assert.equal(request.labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { apiVersion: "v1", kind: "NamespaceList", items };
        },
      },
      tenant.id,
    );

  assert.deepEqual(await discover([external]), { name: "customer-support", external: true });
  assert.deepEqual(await discover([]), {
    name: kubernetesNamespaceName(tenant.id),
    external: false,
  });

  const managed = structuredClone(external);
  managed.metadata.name = kubernetesNamespaceName(tenant.id);
  managed.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
  delete managed.metadata.annotations["openclaw.dev/namespace-lifecycle"];
  assert.deepEqual(await discover([managed]), { name: managed.metadata.name, external: false });

  await assert.rejects(discover([external, structuredClone(external)]), /multiple/i);
  for (const [mutate, expected] of [
    [(item) => (item.metadata.name = ""), /unowned/i],
    [
      (item) => (item.metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant"),
      /unowned/i,
    ],
    [
      (item) => delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      /external ownership/i,
    ],
    [
      (item) => (item.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      /restricted/i,
    ],
    [(item) => (item.status.phase = "Pending"), /active/i],
    [(item) => (item.metadata.deletionTimestamp = "2026-08-25T00:00:00Z"), /active/i],
  ]) {
    // Each rejection exercises the real resolver against malformed, ambiguous, or unsafe ownership.
    const invalid = structuredClone(external);
    mutate(invalid);
    await assert.rejects(discover([invalid]), expected);
  }
});

test("explicit existing namespace adoption claims tenant identity only after security checks", async () => {
  const selection = { ...tenant, status: "provisioning", existingNamespace: "customer-support" };
  const prepared = () => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: selection.existingNamespace,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external", "example.dev/keep": "yes" },
    },
    status: { phase: "Active" },
  });
  const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const run = async ({
    mutate,
    policies,
    conflict,
    forbiddenPolicies,
    claims,
    deleting,
    unselected,
  } = {}) => {
    let observed = prepared();
    mutate?.(observed);
    const patches = [];
    const driver = createKubernetesComputeDriver(options());
    // The fixture supplies transport responses only; adoption, validation, and mutation order
    // are exercised through the production driver's real ensureNamespace implementation.
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace({ labelSelector }) {
          assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { items: claims ?? [] };
        },
        async readNamespace({ name }) {
          assert.equal(name, selection.existingNamespace);
          if (observed === undefined) {
            throw httpError(404);
          }
          return structuredClone(observed);
        },
        async patchNamespace(request) {
          patches.push(structuredClone(request));
          if (conflict !== undefined) {
            conflict(observed);
            throw httpError(409);
          }
          const metadata = request.body.metadata;
          observed.metadata = {
            ...observed.metadata,
            labels: { ...observed.metadata.labels, ...metadata.labels },
            annotations: { ...observed.metadata.annotations, ...metadata.annotations },
          };
        },
        async readNamespacedResourceQuota() {
          // Stop at the first namespaced infrastructure request after successful adoption.
          throw httpError(403);
        },
      },
      networking: {
        async listNamespacedNetworkPolicy({ namespace }) {
          assert.equal(namespace, selection.existingNamespace);
          if (forbiddenPolicies) {
            throw httpError(403);
          }
          return { items: policies ?? [] };
        },
      },
    });
    if (mutate === null) {
      observed = undefined;
    }
    const result = deleting
      ? await driver.deleteNamespace({ ...selection, status: "deleting" })
      : await driver.ensureNamespace(
          unselected ? { ...tenant, status: "provisioning" } : selection,
        );
    return { result, observed, patches };
  };

  const adopted = await run();
  assert.deepEqual(adopted.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(adopted.patches, [
    {
      name: selection.existingNamespace,
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: selection.existingNamespace,
          resourceVersion: "7",
          labels: { "openclaw.dev/namespace": tenant.id },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      fieldManager: "openclaw-enterprise-compute",
      force: false,
    },
  ]);
  assert.equal(adopted.observed.metadata.labels["app.kubernetes.io/managed-by"], "helm");
  assert.equal(adopted.observed.metadata.annotations["example.dev/keep"], "yes");
  assert.equal(
    adopted.observed.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    "external",
  );

  const neverAdopted = await run({ deleting: true });
  assert.deepEqual(neverAdopted.result, { namespaceId: tenant.id, namespaceDeleted: true });
  assert.deepEqual(neverAdopted.patches, []);

  for (const mutate of [
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
  ]) {
    const ambiguous = await run({ mutate, deleting: true });
    assert.deepEqual(ambiguous.result, {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.deepEqual(ambiguous.patches, []);
  }

  const duplicateClaim = await run({ claims: [{ metadata: { name: "another-namespace" } }] });
  assert.equal(duplicateClaim.result.failure, "permanent");
  assert.deepEqual(duplicateClaim.patches, []);

  const implicitlyClaimedNamespace = prepared();
  implicitlyClaimedNamespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
  implicitlyClaimedNamespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
  const implicitAdoption = await run({ claims: [implicitlyClaimedNamespace], unselected: true });
  assert.deepEqual(implicitAdoption.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.deepEqual(implicitAdoption.patches, []);

  for (const mutate of [
    null,
    (namespace) => delete namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    (namespace) => (namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = "other-tenant"),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
    (namespace) => (namespace.status.phase = "Terminating"),
    (namespace) => (namespace.metadata.deletionTimestamp = "2026-08-26T00:00:00.000Z"),
    (namespace) => delete namespace.metadata.resourceVersion,
  ]) {
    const rejected = await run({ mutate });
    assert.deepEqual(rejected.result, {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: "permanent",
    });
    assert.deepEqual(rejected.patches, []);
  }

  const foreignPolicies = await run({
    policies: [
      {
        kind: "NetworkPolicy",
        metadata: { name: "foreign", namespace: selection.existingNamespace },
      },
    ],
  });
  assert.equal(foreignPolicies.result.failure, "permanent");
  assert.deepEqual(foreignPolicies.patches, []);

  const inaccessible = await run({ forbiddenPolicies: true });
  assert.deepEqual(inaccessible.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(inaccessible.patches, []);

  const competingTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_another";
    },
  });
  assert.equal(competingTenant.result.failure, "permanent");
  assert.equal(competingTenant.patches.length, 1);

  const sameTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
    },
  });
  assert.deepEqual(sameTenant.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.equal(sameTenant.patches.length, 1);
});

test("dedicated Agent shared claims retain ownership inside an existing tenant namespace", () => {
  const driver = createKubernetesComputeDriver(options());
  const agentId = "agt_00000000-0000-4000-8000-000000000001";
  const ownership = { namespaceId: tenant.id, agentId };

  // Exercise the real PVC serializer against discovered placement, not a simulated cluster.
  const claim = driver.sharedWorkspaceClaim(agentId, ownership, "customer-support");
  assert.equal(claim.metadata.namespace, "customer-support");
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteMany"]);
  assert.equal(claim.spec.resources.requests.storage, "40Gi");
});

test("gateway routing derives stable endpoints and exact Envoy HTTPRoutes", async () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const name = `gateway-${digest(revision.agentId)}`;
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const service = driver.service(name, ownership, namespace, {
    "app.kubernetes.io/name": name,
  });
  service.metadata.uid = "gateway-service-uid";

  assert.equal(
    driver.getGatewayEndpoint(revision),
    `wss://${gatewayRouting.hostname}/namespaces/${tenant.id}/agents/${revision.agentId}`,
  );

  const route = driver.gatewayRoute(revision, ownership, namespace, service);
  assert.equal(route.apiVersion, "gateway.networking.k8s.io/v1");
  assert.equal(route.kind, "HTTPRoute");
  assert.equal(route.metadata.name, name);
  assert.equal(route.metadata.namespace, namespace);
  assert.equal(route.metadata.labels["openclaw.dev/agent"], revision.agentId);
  assert.equal(
    route.metadata.annotations["openclaw.dev/agent-revision"],
    String(revision.revision),
  );
  assert.equal(route.metadata.annotations["openclaw.dev/agent-revision-id"], revision.id);
  assert.deepEqual(route.metadata.ownerReferences, [
    {
      apiVersion: "v1",
      kind: "Service",
      name,
      uid: "gateway-service-uid",
      controller: false,
      blockOwnerDeletion: false,
    },
  ]);
  assert.deepEqual(route.spec.hostnames, [gatewayRouting.hostname]);
  assert.deepEqual(route.spec.parentRefs, [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      namespace: gatewayRouting.gatewayNamespace,
      name: gatewayRouting.gatewayName,
      sectionName: "https",
    },
  ]);
  assert.deepEqual(route.spec.rules[0].matches, [
    { path: { type: "Exact", value: `/namespaces/${tenant.id}/agents/${revision.agentId}` } },
  ]);
  assert.deepEqual(route.spec.rules[0].backendRefs, [
    { group: "", kind: "Service", name, port: 8080 },
  ]);
  assert.deepEqual(route.spec.rules[0].filters, [
    {
      type: "URLRewrite",
      urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
    },
    {
      type: "RequestHeaderModifier",
      requestHeaderModifier: {
        set: [
          { name: "x-occ-identity", value: "occ-workspace-files" },
          { name: "x-real-ip", value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%" },
        ],
        remove: ["x-forwarded-for", "forwarded", "x-openclaw-scopes"],
      },
    },
  ]);

  const ingress = driver
    .networkPolicies(ownership, namespace)
    .find(({ metadata }) => metadata.name === "allow-gateway-ingress");
  assert.deepEqual(ingress.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": gatewayRouting.envoyNamespace },
          },
          podSelector: {
            matchLabels: {
              "gateway.envoyproxy.io/owning-gateway-namespace": gatewayRouting.gatewayNamespace,
              "gateway.envoyproxy.io/owning-gateway-name": gatewayRouting.gatewayName,
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);

  const omittedHostnameRouting = {
    gatewayName: gatewayRouting.gatewayName,
    gatewayNamespace: gatewayRouting.gatewayNamespace,
    envoyNamespace: gatewayRouting.envoyNamespace,
  };
  const emptyHostnameRouting = { ...gatewayRouting, hostname: "" };
  const alternateNamespaceRouting = {
    ...omittedHostnameRouting,
    gatewayNamespace: "openclaw-alt",
  };
  const derivedOutputs = [];
  for (const routing of [omittedHostnameRouting, emptyHostnameRouting, alternateNamespaceRouting]) {
    const derivedDriver = createKubernetesComputeDriver(routedOptions({ gatewayRouting: routing }));
    const derivedRevision = routedRevision(derivedDriver);
    const expectedHostname = defaultGatewayHostname(routing);
    const endpoint = derivedDriver.getGatewayEndpoint(derivedRevision);
    const hostnames = derivedDriver.gatewayRoute(derivedRevision, ownership, namespace, service)
      .spec.hostnames;
    assert.equal(
      endpoint,
      `wss://${expectedHostname}/namespaces/${tenant.id}/agents/${derivedRevision.agentId}`,
    );
    assert.deepEqual(hostnames, [expectedHostname]);
    derivedOutputs.push({ endpoint, hostnames });
  }
  assert.notEqual(derivedOutputs[0].endpoint, derivedOutputs[2].endpoint);
  assert.notDeepEqual(derivedOutputs[0].hostnames, derivedOutputs[2].hostnames);

  for (const [configuration, expected] of [
    [
      { gateway: { allowRealIpFallback: true, trustedProxies: ["10.42.0.0/16"] } },
      /trusted-proxy/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            token: "legacy-token",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /auth\.token/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-openclaw-operator",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /userHeader/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["another-user"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowUsers/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /identityScopes/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowRealIpFallback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: [],
        },
      },
      /trustedProxies/i,
    ],
  ]) {
    // Routed native access must be admitted by immutable native configuration, not patched in.
    await assert.rejects(driver.prepareRevision({ ...revision, configuration }), expected);
  }
});

test("gateway routing startup validation and namespace membership fail closed", async () => {
  for (const gatewayRouting of [
    {
      hostname: "agents.example.internal:443",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "https://agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: " ",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: 42,
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "OCE",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw/system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy/system",
    },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(routedOptions({ gatewayRouting })),
      /Gateway routing/i,
    );
  }

  assert.throws(
    () => createKubernetesComputeDriver(options({ gatewayRouting })),
    /do not configure network\.gatewayClients/i,
  );

  const driver = createKubernetesComputeDriver(routedOptions());
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      resourceVersion: "7",
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external" },
    },
    status: { phase: "Active" },
  };
  const patches = [];
  driver.apiClients = Promise.resolve({
    core: {
      async patchNamespace(request) {
        patches.push(structuredClone(request));
        namespace.metadata.labels = {
          ...namespace.metadata.labels,
          ...request.body.metadata.labels,
        };
        namespace.metadata.annotations = {
          ...namespace.metadata.annotations,
          ...request.body.metadata.annotations,
        };
      },
      async readNamespace() {
        return structuredClone(namespace);
      },
    },
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].fieldManager, "openclaw-enterprise-compute");
  assert.deepEqual(patches[0].body.metadata.labels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw-enterprise.io/gateway": digest(
      `${gatewayRouting.gatewayNamespace}/${gatewayRouting.gatewayName}`,
    ),
  });
  assert.deepEqual(patches[0].body.metadata.annotations, {
    "openclaw.dev/namespace-id": tenant.id,
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
});

test("Kubernetes drivers require explicit authentication, images, and production policy", () => {
  for (const [invalid, expected] of [
    [{ authentication: undefined }, /authentication|credential/i],
    [{ authentication: { mode: "kubeconfig", kubeconfigPath, context: "" } }, /context/i],
    [
      {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: "relative/config",
          context: contextName,
        },
      },
      /absolute/i,
    ],
    [{ authentication: { mode: "ambient" } }, /authentication|mode|credential/i],
    [{ images: { gateway: "", agent: "agent:local", requireImmutableDigest: false } }, /gateway/i],
    [{ images: { gateway: "gateway:local", agent: "", requireImmutableDigest: false } }, /agent/i],
    [{ resources: undefined }, /resource/i],
    [{ network: undefined }, /network/i],
    [{ servicePrincipalCredentials: undefined }, /credential|projection/i],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options(invalid)), expected);
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(options({ authentication: { mode: "inCluster" } })),
  );
});

test("the canonical Kubernetes runtime isolates transport and channel Secrets", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  assert.doesNotThrow(() => createKubernetesComputeDriver(options({ runtime })));
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            channels: { secretPrefix: "transport", proxyUrl: "http://10.42.0.15:3128" },
          },
        }),
      ),
    /credentials must remain separate/i,
  );

  for (const proxyUrl of ["http://10.42.0.15:3128", "https://[2001:db8::15]:8443"]) {
    const channels = { secretPrefix: "channel", proxyUrl };
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
    );
  }
  for (const proxyUrl of [
    "http://proxy.internal:3128",
    "https://192.0.2.15",
    "https://operator:secret@10.42.0.15:3128",
    "socks5://10.42.0.15:3128",
    "http://10.42.0.15:3128/unreviewed",
    "http://10.42.0.15:3128?token=secret",
  ]) {
    const channels = { secretPrefix: "channel", proxyUrl };
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      /HTTP\(S\) IP endpoint/i,
    );
  }

  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            channels: { secretPrefix: " ", proxyUrl: "http://10.42.0.15:3128" },
          },
        }),
      ),
    /channel Secret name prefix/i,
  );
});

test("dedicated Codex localhost seccomp profile is validated and rendered only on the Agent container", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const profile = "profiles/codex-0.152.1.json";
  const driver = createKubernetesComputeDriver(
    options({ runtime: { ...runtime, codexSeccompProfile: profile } }),
  );
  const defaultDriver = createKubernetesComputeDriver(options({ runtime }));
  const ownership = { namespaceId: tenant.id, agentId: "agent-seccomp" };
  const namespace = kubernetesNamespaceName(tenant.id);
  const workload = (computeDriver, role, embedded = false) =>
    computeDriver.deployment(
      role,
      ownership,
      namespace,
      `${role}:local`,
      role,
      role,
      {},
      "info",
      undefined,
      embedded,
      undefined,
      preparedAuth(computeDriver, namespace, embedded),
    ).spec.template.spec;

  const agent = workload(driver, "agent");
  assert.deepEqual(agent.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.deepEqual(agent.containers[0].securityContext.seccompProfile, {
    type: "Localhost",
    localhostProfile: profile,
  });

  for (const pod of [
    workload(driver, "gateway"),
    workload(driver, "gateway", true),
    workload(defaultDriver, "agent"),
  ]) {
    assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
    assert.equal(pod.containers[0].securityContext.seccompProfile, undefined);
  }

  for (const codexSeccompProfile of [
    "",
    " ",
    "/profiles/codex.json",
    "../codex.json",
    "profiles/../codex.json",
    "profiles//codex.json",
    "unconfined",
    "profiles/unconfined",
    { type: "Unconfined" },
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, codexSeccompProfile } })),
      /Codex seccomp localhost profile/i,
    );
  }

  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            securityContext: { seccompProfile: { type: "Unconfined" } },
          },
        }),
      ),
    /unsupported option securityContext/i,
  );
});

test("account-owned Kubernetes Secrets reject invalid or foreign credentials before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;

  for (const invalid of [
    { namespaceId: "", serviceAccountId, accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId: "", accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "token", workspaceId: "" },
  ]) {
    // Incomplete account credentials cannot trigger Kubernetes requests or Secret mutations.
    await assert.rejects(driver.storeServiceAccountCredential(invalid), /must be explicitly/i);
  }

  for (const secretRef of [
    { name: "another-account-secret", key: "token" },
    { name: secretName, key: "another-key" },
  ]) {
    // Rollback and deletion are restricted to the deterministic Secret owned by this account.
    await assert.rejects(
      driver.deleteServiceAccountCredential({
        namespaceId: tenant.id,
        serviceAccountId,
        secretRef,
      }),
      /another ServiceAccount/i,
    );
  }
});

test("dedicated Codex projects the account-owned token and workspace without exposing either to its gateway", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const agentId = "agent-service-account";
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const account = {
    method: "chatgpt_service_account",
    serviceAccountId,
    providerBinding: {
      providerId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: { kind: "access_token", secretRef: { name: secretName, key: "token" } },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const ownership = { namespaceId: tenant.id, agentId };
  const workload = driver.deployment(
    "codex-agent",
    ownership,
    namespace,
    "agent:local",
    "codex-agent",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    preparedAuth(driver, namespace, false, account),
  );
  const agentEnvironment = Object.fromEntries(
    workload.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // Both values come from the one immutable account-owned reference; no Agent copy is created.
  assert.deepEqual(agentEnvironment.CODEX_ACCESS_TOKEN.valueFrom.secretKeyRef, {
    name: secretName,
    key: "token",
  });
  assert.deepEqual(agentEnvironment.CODEX_CHATGPT_WORKSPACE_ID.valueFrom.secretKeyRef, {
    name: secretName,
    key: "workspace-id",
  });
  assert.equal(agentEnvironment.CODEX_LOGIN_MODE.value, "chatgpt_service_account");
  assert.equal(agentEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(agentEnvironment.SLACK_APP_TOKEN, undefined);
  assert.equal(agentEnvironment.SLACK_BOT_TOKEN, undefined);
  assert.equal(agentEnvironment.MSTEAMS_APP_PASSWORD, undefined);

  const channels = driver.enabledChannels({
    configuration: { channels: { slack: {}, msteams: {} } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
  });

  const gateway = driver.deployment(
    "codex-gateway",
    ownership,
    namespace,
    "gateway:local",
    "codex-gateway",
    "gateway",
    {},
    "info",
    undefined,
    false,
    undefined,
    undefined,
    channels,
  );
  const gatewayEnvironment = new Set(
    gateway.spec.template.spec.containers[0].env.map(({ name }) => name),
  );
  assert.equal(gatewayEnvironment.has("CODEX_ACCESS_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("CODEX_CHATGPT_WORKSPACE_ID"), false);
  assert.equal(gatewayEnvironment.has("OPENAI_API_KEY"), false);
  assert.equal(gatewayEnvironment.has("SLACK_APP_TOKEN"), true);
  assert.equal(gatewayEnvironment.has("SLACK_BOT_TOKEN"), true);
  assert.equal(gatewayEnvironment.has("MSTEAMS_APP_PASSWORD"), true);
});

test("account-token authentication grants only the exact Codex revision outbound HTTPS", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const revision = {
    id: "revision-account-token-1",
    namespaceId: tenant.id,
    agentId: "agent-account-token",
    servicePrincipalId: "service-principal-account-token",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const digest = (value, length = 32) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const policy = driver.agentAuthenticationNetworkPolicy(revision, namespace);

  // Login needs public HTTPS before readiness; candidate transport must remain closed until activation.
  assert.equal(policy.metadata.name, `allow-agent-auth-${digest(revision.agentId, 12)}`);
  assert.equal(
    policy.metadata.annotations["openclaw.dev/service-principal-id"],
    revision.servicePrincipalId,
  );
  assert.deepEqual(policy.spec.podSelector.matchLabels, {
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
  });
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.equal(policy.spec.ingress, undefined);
  assert.deepEqual(
    policy.spec.egress,
    driver.agentNetworkPolicies(revision, namespace)[1].spec.egress,
  );
  assert.deepEqual(policy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
  assert.deepEqual(policy.spec.egress[0].to[0].ipBlock.except, [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]);

  const successor = driver.agentAuthenticationNetworkPolicy(
    { ...revision, id: "revision-account-token-2" },
    namespace,
  );
  // One Agent-owned policy moves between candidates without leaving stale-revision egress behind.
  assert.equal(successor.metadata.name, policy.metadata.name);
  assert.notDeepEqual(successor.spec.podSelector, policy.spec.podSelector);
});

test("native channel providers supply only owning gateway secrets and reviewed proxy egress", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-a";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  for (const [channels, expectedSecrets] of [
    [{ slack: {} }, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]],
    [{ msteams: { enabled: true } }, ["MSTEAMS_APP_PASSWORD"]],
    [
      { slack: { enabled: true }, msteams: { enabled: true } },
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MSTEAMS_APP_PASSWORD"],
    ],
    [
      {
        defaults: { groupPolicy: "allowlist" },
        modelByChannel: { "slack:channel-a": "codex/model" },
        slack: { enabled: false },
        msteams: { enabled: false },
        unsupported: { enabled: false },
      },
      [],
    ],
    [{ defaults: {}, modelByChannel: {} }, []],
  ]) {
    const configuredRevision = {
      ...revision,
      configuration: { ...revision.configuration, channels },
    };
    const enabled = driver.enabledChannels(configuredRevision);
    const gateway = driver.deployment(
      `gateway-${suffix}`,
      { namespaceId: tenant.id, agentId },
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      `gateway-${suffix}`,
      "gateway",
      {},
      "info",
      undefined,
      false,
      undefined,
      undefined,
      enabled,
    );
    const environment = gateway.spec.template.spec.containers[0].env;

    // Native Teams IDs are ordinary configuration values; only its password is a Secret.
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "MSTEAMS_APP_PASSWORD",
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
    ]) {
      const variable = environment.find(({ name }) => name === key);
      if (expectedSecrets.includes(key)) {
        assert.deepEqual(variable.valueFrom.secretKeyRef, { name: `channel-${suffix}`, key });
        assert.equal(environment.filter(({ name }) => name === key).length, 1);
      } else {
        assert.equal(variable, undefined);
      }
    }
    const proxy = environment.filter(({ name }) => name === "HTTPS_PROXY");
    assert.deepEqual(
      proxy,
      expectedSecrets.length === 0
        ? []
        : [{ name: "HTTPS_PROXY", value: "http://10.42.0.15:3128" }],
    );

    const policy = driver.channelNetworkPolicy(configuredRevision, enabled, namespace);
    assert.deepEqual(
      policy.spec.egress,
      expectedSecrets.length === 0
        ? []
        : [
            {
              to: [{ ipBlock: { cidr: "10.42.0.15/32" } }],
              ports: [{ protocol: "TCP", port: 3128 }],
            },
          ],
    );

    // Dedicated Agents never receive gateway-owned channel credentials or their network proxy.
    const agent = driver.deployment(
      `agent-${suffix}`,
      { namespaceId: tenant.id, agentId, servicePrincipalId: revision.servicePrincipalId },
      namespace,
      "openclaw-enterprise/agent-fixture:local",
      `agent-${suffix}`,
      "agent",
      {},
      "info",
      undefined,
      undefined,
      undefined,
      preparedAuth(driver, namespace, false),
    );
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of [...expectedSecrets, "HTTPS_PROXY"]) {
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
    }
  }

  // Removing channel runtime must revoke the exact existing grant without needing its old proxy.
  const activeRevision = {
    ...revision,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { slack: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const previouslyGranted = driver.channelNetworkPolicy(
    activeRevision,
    driver.enabledChannels(activeRevision),
    namespace,
  );
  for (const runtime of [
    {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
    },
    undefined,
  ]) {
    const removed = createKubernetesComputeDriver(options({ runtime }));
    const disabledRevision = {
      ...revision,
      compute: { id: removed.id, implementation: removed.implementation },
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { slack: { enabled: false } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    };
    const revoked = removed.channelNetworkPolicy(
      disabledRevision,
      removed.enabledChannels(disabledRevision),
      namespace,
    );
    assert.equal(revoked.metadata.name, previouslyGranted.metadata.name);
    assert.deepEqual(revoked.metadata.labels, previouslyGranted.metadata.labels);
    assert.deepEqual(revoked.metadata.annotations, previouslyGranted.metadata.annotations);
    assert.deepEqual(revoked.spec.podSelector, previouslyGranted.spec.podSelector);
    assert.deepEqual(revoked.spec.policyTypes, ["Egress"]);
    assert.deepEqual(revoked.spec.egress, []);
  }

  await assert.rejects(
    driver.prepareRevision({
      ...revision,
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { discord: { enabled: true } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    }),
    /Unsupported OpenClaw channel provider "discord"\./,
  );

  const ipv6 = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { secretPrefix: "channel", proxyUrl: "https://[2001:db8::15]:8443" },
      },
    }),
  );
  const teamsRevision = {
    ...revision,
    compute: { id: ipv6.id, implementation: ipv6.implementation },
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { msteams: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const ipv6Policy = ipv6.channelNetworkPolicy(
    teamsRevision,
    ipv6.enabledChannels(teamsRevision),
    namespace,
  );
  assert.deepEqual(ipv6Policy.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "2001:db8::15/128" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    },
  ]);
});

test("embedded replacement cuts over an unready shared gateway and waits for actual startup readiness", async () => {
  const driver = createKubernetesComputeDriver(
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
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-embedded-recovery";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const base = {
    namespaceId: tenant.id,
    agentId,
    configurationId: "cfg_00000000-0000-4000-8000-000000000077",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-embedded-recovery",
    createdAt: tenant.createdAt,
  };
  const oldRevision = {
    ...base,
    id: "revision-embedded-recovery-bad",
    revision: 7,
    configuration: {
      agents: { defaults: { model: "openai/gpt-5" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
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
    },
  };
  const replacement = {
    ...base,
    id: "revision-embedded-recovery-restored",
    revision: 8,
    configuration: {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          models: { "openai/gpt-5": { alias: "Selected model", params: { temperature: 0.2 } } },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: "${OPENAI_API_KEY}",
            models: [{ id: "gpt-5", name: "Selected GPT", contextWindow: 128000, maxTokens: 8192 }],
          },
        },
      },
      channels: { slack: { enabled: false, botToken: "${SLACK_BOT_TOKEN}" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
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
    },
  };
  const tenantOwnership = { namespaceId: tenant.id };
  const gatewayOwnership = { namespaceId: tenant.id, agentId };
  const agentOwnership = {
    namespaceId: tenant.id,
    agentId,
    servicePrincipalId: replacement.servicePrincipalId,
  };
  const gatewayName = `gateway-${suffix}`;
  const agentName = `agent-${suffix}`;
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  const missing = (name) => Object.assign(new Error(`${name} not found`), { statusCode: 404 });

  save({
    ...driver.manifest("v1", "Namespace", namespace, tenantOwnership),
    status: { phase: "Active" },
  });
  for (const policy of driver.networkPolicies(tenantOwnership, namespace)) {
    save(policy);
  }
  save({
    ...driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
    automountServiceAccountToken: false,
  });
  save({
    ...driver.deployment(
      gatewayName,
      gatewayOwnership,
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      agentName,
      "gateway",
      {},
      driver.gatewayConfiguration(oldRevision).loggingLevel,
      driver.gatewayConfiguration(oldRevision),
      true,
      oldRevision.servicePrincipalId,
      preparedAuth(driver, namespace, true),
    ),
    metadata: {
      ...driver.deployment(
        gatewayName,
        gatewayOwnership,
        namespace,
        "openclaw-enterprise/gateway-fixture:local",
        agentName,
        "gateway",
        {},
        driver.gatewayConfiguration(oldRevision).loggingLevel,
        driver.gatewayConfiguration(oldRevision),
        true,
        oldRevision.servicePrincipalId,
        preparedAuth(driver, namespace, true),
      ).metadata,
      generation: 2,
    },
    status: { observedGeneration: 2, readyReplicas: 0 },
  });
  const gatewayService = driver.service(gatewayName, gatewayOwnership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  save(gatewayService);
  const activeRoute = driver.gatewayRoute(oldRevision, gatewayOwnership, namespace, gatewayService);
  activeRoute.metadata.uid = "route-uid";
  save(activeRoute);
  const predecessor = structuredClone(objects.get(key("Deployment", gatewayName)));

  const patches = [];
  const readyDeployments = new Set();
  let replacementDeploymentPatched = false;
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespacedPod() {
        return { items: [] };
      },
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        return { items: [] };
      },
      async readNamespace({ name }) {
        return structuredClone(objects.get(key("Namespace", name)) ?? missing(name));
      },
      async readNamespacedConfigMap({ name }) {
        const current = objects.get(key("ConfigMap", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedConfigMap({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedServiceAccount({ name }) {
        const current = objects.get(key("ServiceAccount", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedServiceAccount({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedService({ name }) {
        const current = objects.get(key("Service", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedService({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        const current = objects.get(key("PersistentVolumeClaim", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedPersistentVolumeClaim({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        const current = objects.get(key("Deployment", name));
        if (current === undefined) {
          throw missing(name);
        }
        const observed = structuredClone(current);
        // Readiness is an explicit transport observation, never inferred from a successful write.
        if (readyDeployments.has(name)) {
          observed.status = {
            observedGeneration: observed.metadata.generation,
            readyReplicas: 1,
          };
        }
        return observed;
      },
      async patchNamespacedDeployment({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        if (body.metadata.name === gatewayName) {
          replacementDeploymentPatched = true;
        }
        const previous = objects.get(key("Deployment", body.metadata.name));
        save({
          ...previous,
          ...body,
          metadata: {
            ...body.metadata,
            generation: previous?.metadata.generation ?? 1,
            uid: previous?.metadata.uid ?? `${body.metadata.name}-uid`,
          },
        });
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        assert.equal(
          replacementDeploymentPatched,
          true,
          "replacement preparation must not wait on the unready previous gateway",
        );
        return {
          items: [
            {
              metadata: { labels: { "kubernetes.io/service-name": gatewayName } },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        const current = objects.get(key("NetworkPolicy", name));
        if (current === undefined) {
          throw missing(name);
        }
        return structuredClone(current);
      },
      async patchNamespacedNetworkPolicy({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
    objects: {
      async read({ metadata }) {
        const current = objects.get(key("HTTPRoute", metadata.name));
        if (current === undefined) {
          throw missing(metadata.name);
        }
        return structuredClone(current);
      },
      async patch(body) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save({ ...body, metadata: { ...body.metadata, uid: "route-uid" } });
      },
    },
  });

  const expected = { namespaceId: tenant.id, agentId, revisionId: replacement.id };
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: true,
  });
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), predecessor);
  assert.deepEqual(objects.get(key("HTTPRoute", gatewayName)), activeRoute);
  assert.equal(
    patches.some(({ kind }) => kind === "Deployment"),
    false,
  );

  // The guarded activation replaces the shared workload before model authentication
  // succeeds. Its failing startup may leave the Agent unavailable until redeploy.
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  const replaced = objects.get(key("Deployment", gatewayName));
  assert.equal(replaced.metadata.annotations["openclaw.dev/agent-revision-id"], replacement.id);
  assert.equal(replaced.spec.strategy.type, "Recreate");
  assert.deepEqual(
    [...objects.values()]
      .filter(({ kind }) => kind === "Deployment")
      .map(({ metadata }) => metadata.name),
    [gatewayName],
    "embedded authentication runs only inside the shared gateway",
  );
  assert.equal(
    objects.get(key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(agentId)))
      ?.metadata.annotations["openclaw.dev/agent-id"],
    agentId,
  );
  const gatewayEnvironment = Object.fromEntries(
    replaced.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_MODEL.value, "openai/gpt-5");
  assert.deepEqual(gatewayEnvironment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: "occ-model-key",
    key: "value",
  });
  const probeConfiguration = JSON.parse(gatewayEnvironment.OPENCLAW_HARNESS_PROBE_CONFIG.value);
  assert.equal(probeConfiguration.agents.defaults.model, "openai/gpt-5");
  assert.deepEqual(probeConfiguration.agents.defaults.models, {
    "openai/gpt-5": {
      alias: "Selected model",
      params: { temperature: 0.2 },
      agentRuntime: { id: "openclaw" },
    },
  });
  const { apiKey: _alias, ...expectedProvider } = replacement.configuration.models.providers.openai;
  assert.deepEqual(probeConfiguration.models.providers.openai, expectedProvider);
  for (const section of ["gateway", "channels", "plugins", "auth", "env", "secrets"]) {
    assert.equal(
      probeConfiguration[section],
      undefined,
      `${section} must not reach native validation`,
    );
  }
  const egressWrite = patches.findIndex(
    ({ kind, name }) => kind === "NetworkPolicy" && name === `allow-agent-runtime-${suffix}`,
  );
  const gatewayWrite = patches.findIndex(
    ({ kind, name }) => kind === "Deployment" && name === gatewayName,
  );
  assert.ok(egressWrite >= 0 && egressWrite < gatewayWrite);

  // Reconciliation observes readiness without replacing the Pod or retrying the
  // native model call; explicit deployment/restart owns recovery from bad auth.
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: false,
  });
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  readyDeployments.add(gatewayName);
  assert.equal((await driver.prepareRevision(replacement, authContext(replacement))).ready, true);
  await driver.activateRevision(replacement, authContext(replacement));
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);
  await assert.rejects(
    driver.activateRevision(oldRevision, authContext(oldRevision)),
    /stale AgentRevision gateway activation/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  const initial = {
    ...replacement,
    id: "initial-embedded-revision",
    agentId: "initial-embedded-agent",
    revision: 1,
  };
  assert.equal((await driver.prepareRevision(initial, authContext(initial))).ready, false);
  const initialGateway = objects.get(key("Deployment", `gateway-${digest(initial.agentId)}`));
  assert.ok(initialGateway);
  assert.deepEqual(
    initialGateway.spec.template.spec.containers[0].command,
    replaced.spec.template.spec.containers[0].command,
    "initial and replacement gateways execute the same native startup validation",
  );
});

test("SDK resource requirements still require explicit CPU and memory requests and limits", () => {
  const configured = options().resources;

  for (const [resources, expected] of [
    [
      { ...configured, gateway: { limits: { cpu: "250m", memory: "128Mi" } } },
      /Gateway requests and limits/i,
    ],
    [
      {
        ...configured,
        agent: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "250m" } },
      },
      /Agent memory limit/i,
    ],
    [
      {
        ...configured,
        namespace: {
          ...configured.namespace,
          containerDefaults: {
            requests: { cpu: "100m" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
        },
      },
      /Namespace default memory request/i,
    ],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options({ resources })), expected);
  }
});

test("production drivers reject injected clients and fail closed without their kubeconfig", async () => {
  for (const clients of [{}, undefined]) {
    assert.throws(
      () => createKubernetesComputeDriver({ ...options(), clients }),
      /client|inject|configuration/i,
    );
  }

  const inheritedClients = Object.assign(Object.create({ clients: {} }), options());
  assert.throws(() => createKubernetesComputeDriver(inheritedClients), /client|inject/i);

  const driver = createKubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-kubeconfig-${process.pid}`,
        context: contextName,
      },
    }),
  );

  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "retryable",
  });
});

test("Kubernetes lifecycle owners cannot be replaced after their first operation begins", async () => {
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: { async afterNamespacePrepared() {} },
  };
  const driver = new KubernetesComputeDriver(options(), { lifecycleDrivers: [selected] });

  // Startup composition may configure trusted owners before any tenant resource is touched.
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));

  const operation = driver.ensureNamespace(tenant);

  // Freeze ownership synchronously so an in-flight reconciliation cannot lose its revocation owner.
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
  await operation;
  assert.throws(
    () => driver.setLifecycleDrivers([selected]),
    /owners cannot change.*operations begin/i,
  );
});

test("Kubernetes lifecycle hooks never run before cluster ownership and workload identity checks", async () => {
  const calls = [];
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: {
      async afterNamespacePrepared() {
        calls.push("namespace-prepared");
      },
      async beforeWorkloadStart() {
        calls.push("workload-start");
      },
      async beforeWorkloadStop() {
        calls.push("workload-stop");
      },
      async beforeNamespaceDelete() {
        calls.push("namespace-delete");
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-lifecycle-${process.pid}`,
        context: contextName,
      },
    }),
    { lifecycleDrivers: [selected] },
  );
  const foreignRevision = {
    id: "revision-foreign-1",
    namespaceId: tenant.id,
    agentId: "agent-foreign",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: "another-driver", implementation: "another-implementation" },
    servicePrincipalId: "service-principal-agent-foreign",
    createdAt: tenant.createdAt,
  };

  // Hooks cannot prepare or revoke tenant infrastructure until its cluster ownership is verified.
  const namespacePreparation = await driver.ensureNamespace(tenant);
  assert.deepEqual(
    { ...namespacePreparation, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: undefined,
    },
  );
  assert.match(namespacePreparation.failure, /^(?:permanent|retryable)$/);
  const namespaceDeletion = await driver.deleteNamespace({ ...tenant, status: "deleting" });
  assert.deepEqual(
    { ...namespaceDeletion, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: undefined,
    },
  );
  assert.match(namespaceDeletion.failure, /^(?:permanent|retryable)$/);

  // Another Compute Driver's revision must never trigger this driver's credential lifecycle.
  assert.deepEqual(await driver.prepareRevision(foreignRevision), {
    namespaceId: tenant.id,
    agentId: foreignRevision.agentId,
    revisionId: foreignRevision.id,
    ready: false,
  });
  await assert.rejects(driver.retireRevision(foreignRevision), /another Compute Driver/i);
  assert.deepEqual(calls, []);
});

test("containment-only Sandbox cleanup retries after its Compute-owned workload is absent", async () => {
  const cleanupCalls = [];
  const deletionCalls = [];
  let deploymentPresent = true;
  const sandboxDriver = {
    id: "sandbox-containment-only",
    implementation: "test/containment-only",
    capability: "sandbox",
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-retirement",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver.deployment(
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    namespace,
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-workload-uid";
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  let gatewayReads = 0;
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });

  // Only Kubernetes transport observations are substituted; retirement and Sandbox dispatch
  // execute through the production driver against a supported containment-only extension.
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace() {
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod() {
        assert.equal(deploymentPresent, false);
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name === deploymentName && deploymentPresent) {
          return structuredClone(deployment);
        }
        if (name === gatewayName) {
          gatewayReads += 1;
        }
        throw notFound();
      },
      async deleteNamespacedDeployment(request) {
        deletionCalls.push(request);
        deploymentPresent = false;
      },
    },
    objects: {},
  });

  // The first cleanup failure occurs after workload removal and must keep retirement retryable.
  await assert.rejects(driver.retireRevision(revision), /sandbox cleanup failed/);
  assert.equal(deploymentPresent, false);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(gatewayReads, 0);

  // The absent-workload retry must run the required cleanup again instead of completing early.
  await driver.retireRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.equal(gatewayReads, 1);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
});

test("the official Kubernetes client rejects ambiguous identity and insecure API servers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-auth-conformance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const scenario of [
    { name: "unselected-context", context: "missing-context" },
    { name: "missing-credential-identity", users: [] },
    { name: "plaintext-api-endpoint", server: "http://127.0.0.1:1" },
    { name: "unverified-tls", skipTLSVerify: true },
    { name: "embedded-api-credentials", server: "https://user:password@127.0.0.1:1" },
    { name: "unexpected-api-path", server: "https://127.0.0.1:1/untrusted" },
  ]) {
    const path = join(directory, `${scenario.name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "conformance-cluster",
            cluster: {
              server: scenario.server ?? "https://127.0.0.1:1",
              ...(scenario.skipTLSVerify ? { "insecure-skip-tls-verify": true } : {}),
            },
          },
        ],
        users: scenario.users ?? [
          { name: "conformance-user", user: { token: "test-only-fixture-token" } },
        ],
        contexts: [
          {
            name: contextName,
            context: { cluster: "conformance-cluster", user: "conformance-user" },
          },
        ],
        "current-context": contextName,
      }),
    );

    const driver = createKubernetesComputeDriver(
      options({
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: path,
          context: scenario.context ?? contextName,
        },
      }),
    );

    // Unsafe cluster configuration is permanently rejected before contacting its API server.
    assert.deepEqual(
      await driver.ensureNamespace(tenant),
      {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
      },
      scenario.name,
    );
  }
});

test("immutable image policy accepts digests and rejects mutable tags", () => {
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          images: {
            gateway: "registry.example/gateway:latest",
            agent: "registry.example/agent:latest",
            requireImmutableDigest: true,
          },
        }),
      ),
    /digest|immutable/i,
  );

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        images: {
          gateway: `registry.example/gateway@sha256:${"a".repeat(64)}`,
          agent: `registry.example/agent@sha256:${"b".repeat(64)}`,
          requireImmutableDigest: true,
        },
      }),
    ),
  );
});

test("projected ServicePrincipal tokens require an audience and bounded expiration", () => {
  for (const credentials of [
    { mode: "projectedServiceAccountToken", audience: "", expirationSeconds: 900 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 599 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 86_401 },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ servicePrincipalCredentials: credentials })),
      /audience|expiration|token/i,
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        servicePrincipalCredentials: {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
      }),
    ),
  );
});

test("provider-owned Harness requirements preserve the exact projected ServicePrincipal identity", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const driver = createKubernetesComputeDriver(
    options({
      runtime,
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    revisionId: "rev_00000000-0000-4000-8000-000000000001",
    serviceAccountId: "sa_00000000-0000-4000-8000-000000000001",
    servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000001",
  };
  const workload = driver.deployment(
    "agent-projected-identity",
    ownership,
    kubernetesNamespaceName(tenant.id),
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
  );

  const requirements = driver.harnessRequirementsFromDeployment(workload, "api_key");
  assert.equal(requirements.loginMode, "api_key");
  // Provider requirements must carry readable identities unchanged into Pod labels and selectors.
  for (const [key, value] of Object.entries({
    "openclaw.dev/namespace": ownership.namespaceId,
    "openclaw.dev/agent": ownership.agentId,
    "openclaw.dev/revision": ownership.revisionId,
    "openclaw.dev/service-account": ownership.serviceAccountId,
    "openclaw.dev/service-principal": ownership.servicePrincipalId,
  })) {
    assert.equal(workload.metadata.labels[key], value);
    assert.equal(workload.spec.template.metadata.labels[key], value);
    assert.equal(requirements.labels[key], value);
  }
  assert.deepEqual(requirements.serviceAccountToken, {
    audience: "openclaw-controller",
    expirationSeconds: 900,
    mountPath: "/var/run/secrets/openclaw/service-principal",
    path: "token",
    readOnly: true,
  });

  for (const mutate of [
    (spec) => {
      spec.volumes = spec.volumes.filter(({ name }) => name !== "openclaw-service-principal");
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.audience = "another-audience";
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.expirationSeconds = 901;
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.path = "another-token";
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).readOnly = false;
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).mountPath = "/another-token-path";
    },
  ]) {
    // A provider must receive exactly the same audience, expiry, token path, and readonly mount.
    const altered = structuredClone(workload);
    mutate(altered.spec.template.spec);
    assert.throws(
      () => driver.harnessRequirementsFromDeployment(altered, "api_key"),
      /ServicePrincipal/i,
    );
  }

  const withoutProjection = createKubernetesComputeDriver(options({ runtime }));
  const unprojected = withoutProjection.deployment(
    "agent-projected-identity",
    ownership,
    kubernetesNamespaceName(tenant.id),
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(withoutProjection, kubernetesNamespaceName(tenant.id), false),
  );
  assert.throws(
    () => withoutProjection.harnessRequirementsFromDeployment(unprojected, "api_key"),
    /projected ServicePrincipal token/i,
  );
});

function providerReadinessFixture({ provisionHarness, lifecycleDrivers = [] } = {}) {
  const driver = new KubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
    {
      lifecycleDrivers,
      sandboxDriver: {
        id: "sandbox-provider",
        async provisionHarness(context) {
          if (provisionHarness !== undefined) {
            return provisionHarness(context);
          }
          assert.fail("activation must only observe the previously provisioned Harness");
        },
      },
    },
  );
  const revision = routedRevision(driver, {
    sandboxDriverId: "sandbox-provider",
    configuration: admitLoggingConfiguration(
      {
        agents: { defaults: { model: "codex/gpt-5" } },
        gateway: { controlUi: { enabled: false } },
      },
      "info",
    ),
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
    namespace,
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
  const { labels } = driver.harnessRequirementsFromDeployment(deployment, "api_key");
  const requests = [];
  let observe = () => ({ apiVersion: "v1", kind: "PodList", items: [] });
  const core = {
    async listNamespace() {
      return { items: [] };
    },
    async listNamespacedPod(request) {
      requests.push(request);
      assert.equal(request.namespace, namespace);
      assert.deepEqual(
        Object.fromEntries(request.labelSelector.split(",").map((entry) => entry.split("="))),
        {
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
          "openclaw.dev/workload-role": "agent",
        },
      );
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
    labels,
    requests,
    core,
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
      return driver.providerHarnessReady(revision, namespace, labels);
    },
  };
}

test("provider Harness readiness requires exactly one live matching Pod", async (t) => {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const unready = fixture.pod("harness-starting", "False");
  const terminating = fixture.pod("harness-terminating");
  terminating.metadata.deletionTimestamp = new Date("2026-08-25T00:00:00Z");
  const cases = [
    ["no Pods", [], false],
    ["one Ready Pod", [ready], true],
    ["one unready Pod", [unready], false],
    ["one unknown Pod", [fixture.pod("harness-unknown", "Unknown")], false],
    ["two Ready Pods", [ready, fixture.pod("harness-other")], false],
    ["Ready then unready", [ready, unready], false],
    ["unready then Ready", [unready, ready], false],
    ["two unready Pods", [unready, fixture.pod("harness-other", "False")], false],
    ["repeated Pod entry", [ready, ready], false],
    ["only terminating", [terminating], false],
    ["Ready plus terminating", [ready, terminating], true],
    ["unready plus terminating", [unready, terminating], false],
    ["all terminating", [terminating, terminating], false],
  ];
  for (const missing of ["status", "conditions"]) {
    const waiting = fixture.pod(`harness-no-${missing}`);
    if (missing === "status") {
      delete waiting.status;
    } else {
      delete waiting.status.conditions;
    }
    cases.push([`missing optional ${missing}`, [waiting], false]);
  }
  for (const [field, value] of [
    ["namespace", "another-namespace"],
    ["openclaw.dev/agent", "another-agent"],
    ["openclaw.dev/revision", "another-revision"],
    ["openclaw.dev/workload-role", "gateway"],
  ]) {
    const unrelated = fixture.pod("unrelated");
    if (field === "namespace") {
      unrelated.metadata.namespace = value;
    } else {
      unrelated.metadata.labels[field] = value;
    }
    cases.push([`wrong ${field}`, [unrelated], false]);
    cases.push([`Ready plus wrong ${field}`, [ready, unrelated], true]);
  }
  const unlabeled = fixture.pod("unlabeled");
  delete unlabeled.metadata.labels;
  cases.push(["no labels", [unlabeled], false]);
  const noTypeMetadata = fixture.pod("typed-sdk-pod");
  delete noTypeMetadata.apiVersion;
  delete noTypeMetadata.kind;
  cases.push(["optional Pod type metadata omitted", [noTypeMetadata], true]);
  const stringTimestamp = structuredClone(terminating);
  stringTimestamp.metadata.deletionTimestamp = "2026-08-25T00:00:00Z";
  cases.push(["serialized deletion timestamp", [ready, stringTimestamp], true]);

  for (const [name, items, expected] of cases) {
    await t.test(name, async () => {
      fixture.setObservation({ apiVersion: "v1", kind: "PodList", items });
      assert.equal(await fixture.ready(), expected);
    });
  }
});

test("provider Harness readiness rejects malformed or incomplete Pod observations", async (t) => {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const invalid = /invalid or incomplete provider Harness Pod list/;
  for (const [name, response] of [
    ["null response", null],
    ["missing items", {}],
    ["object items", { items: {} }],
    ["null items", { items: null }],
    ["wrong list kind", { kind: "ServiceList", items: [ready] }],
    ["wrong list version", { apiVersion: "apps/v1", items: [ready] }],
    ["malformed list metadata", { metadata: [], items: [ready] }],
    ["continuation", { metadata: { continue: "next-page" }, items: [ready] }],
    ["SDK continuation", { metadata: { _continue: "next-page" }, items: [ready] }],
    ["remaining items", { metadata: { remainingItemCount: 1 }, items: [ready] }],
  ]) {
    await t.test(name, async () => {
      fixture.setObservation(response);
      await assert.rejects(fixture.ready(), invalid);
    });
  }
  for (const [name, mutate] of [
    ["wrong kind", (pod) => (pod.kind = "Service")],
    ["wrong version", (pod) => (pod.apiVersion = "apps/v1")],
    ["missing metadata", (pod) => delete pod.metadata],
    ["array metadata", (pod) => (pod.metadata = [])],
    ["missing name", (pod) => delete pod.metadata.name],
    ["empty namespace", (pod) => (pod.metadata.namespace = "")],
    ["array labels", (pod) => (pod.metadata.labels = [])],
    ["nonstring label", (pod) => (pod.metadata.labels.extra = 1)],
    [
      "contradictory selector label",
      (pod) => (pod.metadata.labels["openclaw.dev/service-principal"] = "another-principal"),
    ],
    ["null deletion timestamp", (pod) => (pod.metadata.deletionTimestamp = null)],
    ["invalid deletion date", (pod) => (pod.metadata.deletionTimestamp = new Date(NaN))],
    ["invalid deletion string", (pod) => (pod.metadata.deletionTimestamp = "0")],
    ["null status", (pod) => (pod.status = null)],
    ["array status", (pod) => (pod.status = [])],
    ["object conditions", (pod) => (pod.status.conditions = {})],
    ["null condition", (pod) => pod.status.conditions.push(null)],
    ["nonstring condition type", (pod) => pod.status.conditions.push({ type: 1, status: "True" })],
    ["nonstring condition status", (pod) => (pod.status.conditions[0].status = true)],
    ["invalid condition status", (pod) => (pod.status.conditions[0].status = "true")],
    ["duplicate Ready", (pod) => pod.status.conditions.push({ type: "Ready", status: "True" })],
    ["conflicting Ready", (pod) => pod.status.conditions.push({ type: "Ready", status: "False" })],
  ]) {
    await t.test(name, async () => {
      const malformed = fixture.pod("harness-malformed");
      mutate(malformed);
      // A valid Ready entry must not hide invalid observations before or after it.
      for (const items of [[malformed], [ready, malformed], [malformed, ready]]) {
        fixture.setObservation({ items });
        await assert.rejects(fixture.ready(), invalid);
      }
    });
  }
  for (const malformed of [null, false, "pod", [], {}]) {
    fixture.setObservation({ items: [ready, malformed] });
    await assert.rejects(fixture.ready(), invalid);
  }
  fixture.setObservation({ metadata: { continue: "", remainingItemCount: 0 }, items: [ready] });
  assert.equal(await fixture.ready(), true);
});

test("provider Harness activation fails before routing on absent, ambiguous, or malformed Pods", async () => {
  const fixture = providerReadinessFixture();
  const context = authContext(fixture.revision);
  const resolved = context.harnessAuth;
  for (const invalidContext of [
    undefined,
    { harnessAuth: { ...resolved, source: { ...resolved.source, id: "sec_other" } } },
    { harnessAuth: { ...resolved, secretDriverId: "another-secret-driver" } },
    {
      harnessAuth: {
        ...resolved,
        backendRef: { ...resolved.backendRef, namespaceName: "another-tenant" },
      },
    },
    { harnessAuth: { ...resolved, backendRef: { ...resolved.backendRef, uid: "" } } },
  ]) {
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, invalidContext),
      /authentication.*(?:context|source)/i,
    );
  }
  assert.equal(fixture.requests.length, 0, "invalid authentication must fail before Pod readiness");
  for (const items of [
    [],
    [fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("also-ready")],
  ]) {
    fixture.setObservation({ items });
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
      /The exact AgentRevision workload is not ready/,
    );
  }
  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
    /invalid or incomplete/,
  );
  assert.equal(fixture.requests.length, 5);
});

test("provider Harness preparation preserves readiness and cleanup contracts", async () => {
  const hooks = [];
  const provisions = [];
  const fixture = providerReadinessFixture({
    async provisionHarness(context) {
      assert.ok(
        objects.has(key("NetworkPolicy", `allow-agent-auth-${digest(context.revision.agentId)}`)),
        "API-key candidates need provider egress before Sandbox startup",
      );
      provisions.push(context);
      return {
        namespaceName: context.namespace.name,
        resourceName: "provider-sandbox",
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    lifecycleDrivers: [
      {
        id: "configuration-lifecycle",
        capability: "configuration",
        implementation: "conformance-lifecycle",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {
            hooks.push("start");
          },
          async beforeWorkloadStop() {
            hooks.push("stop");
          },
        },
      },
    ],
  });
  const { driver, revision, namespace, core } = fixture;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayOwnership = { namespaceId: tenant.id, agentId: revision.agentId };
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, namespace)) {
    save(policy);
  }
  // Seed an already-ready gateway; the fixture never derives readiness from a write.
  const gateway = driver.deployment(
    gatewayName,
    gatewayOwnership,
    namespace,
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision),
  );
  gateway.metadata.generation = 1;
  gateway.status = { observedGeneration: 1, readyReplicas: 1 };
  save(gateway);
  const clients = {
    core,
    apps: {},
    networking: {},
    discovery: {
      async listNamespacedEndpointSlice() {
        return {
          items: [
            {
              metadata: { labels: { "kubernetes.io/service-name": gatewayName } },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
  };
  core.readNamespace = async ({ name }) => structuredClone(objects.get(key("Namespace", name)));
  const writes = [];
  for (const [api, kinds] of [
    [core, ["ConfigMap", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, namespace);
        const object = objects.get(key(kind, name));
        if (object === undefined) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return structuredClone(object);
      };
      api[`patchNamespaced${kind}`] = async ({ body, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, namespace);
        writes.push(structuredClone(body));
        const previous = objects.get(key(kind, body.metadata.name));
        if (kind === "Deployment") {
          assert.deepEqual(
            body.spec,
            previous?.spec,
            "fixture readiness requires an unchanged gateway",
          );
        }
        save({ ...previous, ...body, metadata: { ...previous?.metadata, ...body.metadata } });
      };
    }
  }
  driver.apiClients = Promise.resolve(clients);
  const expected = { namespaceId: tenant.id, agentId: revision.agentId, revisionId: revision.id };
  for (const [items, ready] of [
    [[], false],
    [[fixture.pod("starting", "False")], false],
    [[fixture.pod("ready"), fixture.pod("starting", "False")], false],
    [[fixture.pod("ready")], true],
  ]) {
    fixture.setObservation({ items });
    assert.deepEqual(await driver.prepareRevision(revision, authContext(revision)), {
      ...expected,
      ready,
    });
  }
  assert.deepEqual(hooks, ["start", "start", "start", "start"]);
  assert.equal(provisions.length, 4);
  assert.deepEqual(provisions[0].requirements.labels, fixture.labels);
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  assert.equal(
    objects.get(key("Service", agentServiceName)).spec.selector["app.kubernetes.io/name"],
    `${agentServiceName}-inactive`,
  );

  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    driver.prepareRevision(revision, authContext(revision)),
    /invalid or incomplete/,
  );
  assert.deepEqual(hooks.slice(-2), ["start", "stop"]);
  const writesBeforeActivation = writes.length;
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /invalid or incomplete/,
  );
  assert.equal(writes.length, writesBeforeActivation);

  fixture.setObservation({ items: [fixture.pod("ready")] });
  await driver.activateRevision(revision, authContext(revision));
  assert.deepEqual(objects.get(key("Service", agentServiceName)).spec.selector, {
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  });
});

test("provider Harness readiness preserves API errors and owner cancellation", async () => {
  const fixture = providerReadinessFixture();
  const denied = Object.assign(new Error("Pod observation denied"), { statusCode: 403 });
  fixture.setObservation(() => {
    throw denied;
  });
  await assert.rejects(fixture.ready(), (error) => error === denied);
  assert.equal(fixture.requests.length, 1);
  const unavailable = Object.assign(new Error("Pod observation unavailable"), { statusCode: 503 });
  fixture.setObservation(() => {
    throw unavailable;
  });
  await assert.rejects(fixture.ready(), (error) => error === unavailable);
  assert.equal(fixture.requests.length, 4);

  const cancellation = new Error("revision observation cancelled");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(alreadyAborted.signal, () => fixture.ready()),
    (error) => error === cancellation,
  );
  assert.equal(fixture.requests.length, 4);
  for (const lateSuccess of [false, true]) {
    const owner = new AbortController();
    let release;
    let started;
    const observing = new Promise((resolve) => {
      started = resolve;
    });
    fixture.setObservation(() => {
      const signal = currentComputeAbortSignal();
      started(signal);
      return new Promise((resolve, reject) => {
        release = () => resolve({ items: [fixture.pod("late-ready")] });
        if (!lateSuccess) {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }
      });
    });
    // Manual owner cancellation exercises the driver context; it is not database lease-loss proof.
    const readiness = withComputeAbortSignal(owner.signal, () => fixture.ready());
    const rejected = assert.rejects(readiness, (error) => error === cancellation);
    const requestSignal = await observing;
    owner.abort(cancellation);
    assert.equal(requestSignal.aborted, true);
    if (lateSuccess) {
      release();
    }
    await rejected;
  }
  assert.equal(fixture.requests.length, 6);
});

test("revision lifecycle rejects another driver or missing identity before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId: "agent-a",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  for (const provider of ["slack", "msteams"]) {
    for (const configuration of [{ enabled: true }, { accounts: { support: { enabled: true } } }]) {
      await assert.rejects(
        driver.prepareRevision({
          ...revision,
          configuration: { ...revision.configuration, channels: { [provider]: configuration } },
        }),
        /isolated credentials and a reviewed proxy/i,
      );
    }
  }

  for (const invalid of [
    { ...revision, compute: { id: "another-driver", implementation: "another-implementation" } },
    { ...revision, servicePrincipalId: undefined },
    { ...revision, servicePrincipalId: " " },
  ]) {
    assert.deepEqual(await driver.prepareRevision(invalid), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    });
  }

  for (const invalid of [
    { ...revision, configurationId: " " },
    { ...revision, configurationKind: "gateway" },
    { ...revision, revision: 0 },
    { ...revision, configurationGeneration: 0 },
    { ...revision, configurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    // Reject incompatible immutable snapshots before touching an Agent's Kubernetes resources.
    await assert.rejects(driver.prepareRevision(invalid), /Configuration/i);
  }

  for (const harness of [
    { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    { id: "codex", version: "1.0.0", mode: "embedded" },
    { id: "codex", version: "1.0.0" },
    { id: "codex", version: "1.0.0", mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), /Harness|topology/i);
  }

  const production = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const serviceAccount = {
    method: "chatgpt_service_account",
    serviceAccountId,
    providerBinding: {
      providerId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: {
      kind: "access_token",
      secretRef: {
        name: `service-account-${createHash("sha256")
          .update(serviceAccountId)
          .digest("hex")
          .slice(0, 32)}`,
        key: "token",
      },
    },
  };
  const accessTokenRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harnessAuth: serviceAccount,
  };

  // Operator credentials do not weaken either managed Kubernetes topology.
  for (const mode of ["embedded", "dedicated"]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
        harnessAuth: { method: "runtime" },
      }),
      /incompatible.*topology/i,
    );
  }
  // Unsupported access-token execution and cross-account references fail before cluster access.
  await assert.rejects(
    production.prepareRevision({
      ...accessTokenRevision,
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    }),
    /incompatible.*topology/i,
  );
  for (const secretRef of [
    { ...serviceAccount.credential.secretRef, name: "service-account-another" },
    { ...serviceAccount.credential.secretRef, key: "another-key" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harnessAuth: {
          ...serviceAccount,
          credential: { ...serviceAccount.credential, secretRef },
        },
      }),
      /admitted account/i,
    );
  }
  const embeddedRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    configuration: { ...revision.configuration, agents: { defaults: { model: "openai/gpt-5" } } },
  };
  // Admission must retain supported model choices without permitting a second credential selector.
  for (const model of ["codex/gpt-5", "openai/gpt-5"]) {
    const configuration = { agents: { defaults: { model } } };
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(revision.harness, apiKeyAuth, configuration),
    );
    assert.equal(configuration.agents.defaults.model, model);
  }
  for (const apiKey of [
    "plaintext-fixture",
    "${ANOTHER_API_KEY}",
    { source: "env", provider: "model", id: "ANOTHER_API_KEY" },
    { source: "store", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          models: { providers: { openai: { apiKey } } },
        },
      }),
      /credentials must use.*binding/i,
    );
  }
  for (const apiKey of [
    "${OPENAI_API_KEY}",
    { source: "env", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(embeddedRevision.harness, apiKeyAuth, {
        ...embeddedRevision.configuration,
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
        models: { providers: { openai: { apiKey } } },
      }),
    );
  }
  for (const transport of [
    { baseUrl: "${PROVIDER_URL}" },
    { headers: { "x-provider-feature": "${HEADER}" } },
    { headers: { "x-provider-feature": { source: "env", provider: "model", id: "HEADER" } } },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          models: { providers: { openai: { apiKey: "${OPENAI_API_KEY}", ...transport } } },
        },
      }),
      /transport configuration cannot require additional Secret or environment references/i,
    );
  }
  for (const conflicting of [
    { auth: { profiles: { alternate: { provider: "openai", mode: "api_key" } } } },
    { env: { OPENAI_API_KEY: "plaintext-fixture" } },
    { env: { vars: { OPENAI_API_KEY: "plaintext-fixture" } } },
    { models: { providers: { openai: { headers: { Authorization: "Bearer fixture" } } } } },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: { ...embeddedRevision.configuration, ...conflicting },
      }),
      /credentials must use.*binding/i,
    );
  }
  // Channel credentials must never enter the combined embedded Agent and gateway workload.
  for (const provider of ["slack", "msteams"]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          channels: { [provider]: { enabled: true } },
        },
      }),
      /channels require a dedicated Agent workload\./i,
    );
  }
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentHash = createHash("sha256").update(revision.agentId).digest("hex");
  const gateway = production.deployment(
    `gateway-${agentHash.slice(0, 12)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${agentHash.slice(0, 12)}`,
    "gateway",
    {},
    production.gatewayConfiguration(embeddedRevision).loggingLevel,
    production.gatewayConfiguration(embeddedRevision),
    true,
    revision.servicePrincipalId,
    preparedAuth(production, namespace, true),
  );
  const pod = gateway.spec.template.spec;
  const environment = Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry]));

  // The approved combined Agent workload receives only its own projected identity and model Secret.
  assert.equal(pod.serviceAccountName, `agent-${agentHash.slice(0, 12)}`);
  assert.ok(pod.volumes.some(({ name }) => name === "openclaw-service-principal"));
  assert.deepEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: "occ-model-key",
    key: "value",
  });
  assert.deepEqual(environment.OPENCLAW_GATEWAY_TOKEN.valueFrom.secretKeyRef, {
    name: `transport-${agentHash.slice(0, 12)}`,
    key: "gateway-token",
  });
  assert.equal(environment.HOME.value, "/home/node");
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.APP_SERVER_URL, undefined);

  const trustedProxyRevision = {
    ...embeddedRevision,
    id: "revision-a-embedded-trusted-proxy",
    configuration: {
      ...embeddedRevision.configuration,
      gateway: { ...embeddedRevision.configuration.gateway, auth: { mode: "trusted-proxy" } },
    },
  };
  const trustedProxyGateway = production.deployment(
    `gateway-${agentHash.slice(0, 12)}-trusted-proxy`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${agentHash.slice(0, 12)}`,
    "gateway",
    {},
    production.gatewayConfiguration(trustedProxyRevision).loggingLevel,
    production.gatewayConfiguration(trustedProxyRevision),
    true,
    revision.servicePrincipalId,
    preparedAuth(production, namespace, true),
  );
  const trustedProxyEnvironment = Object.fromEntries(
    trustedProxyGateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(trustedProxyEnvironment.OPENCLAW_GATEWAY_TOKEN, undefined);

  const policies = production.agentNetworkPolicies(embeddedRevision, namespace);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].spec.podSelector.matchLabels, {
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
  });
  assert.deepEqual(policies[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(policies[0].spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);

  await assert.rejects(
    driver.retireRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
  await assert.rejects(
    driver.stopRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
});

test("real gateways require an explicit SQLite-compatible storage class", () => {
  for (const gatewayStorageClassName of [undefined, "", " "]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName,
            },
          }),
        ),
      /SQLite-compatible gateway storage class must be explicitly configured/,
    );
  }
});

test("gateway SQLite and media mounts are private, durable, and preserve ephemeral Codex credentials", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-private-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const claim = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "local-path",
    resources: { requests: { storage: "10Gi" } },
  });
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/revision-id"], undefined);
  assert.notEqual(
    claim.metadata.name,
    driver.gatewayPrivateStateClaim(
      "another-agent",
      { ...ownership, agentId: "another-agent" },
      namespace,
    ).metadata.name,
  );
  assert.notEqual(
    claim.metadata.name,
    driver.sharedWorkspaceClaim(agentId, ownership, namespace).metadata.name,
  );

  // Whole directories retain SQLite WAL/SHM siblings; only the gateway receives the private claim.
  for (const embedded of [false, true]) {
    const gateway = driver.deployment(
      "gateway",
      ownership,
      namespace,
      "gateway:local",
      "gateway",
      "gateway",
      {},
      "info",
      undefined,
      embedded,
      undefined,
      preparedAuth(driver, namespace, embedded),
    );
    const pod = gateway.spec.template.spec;
    const privateVolume = pod.volumes.find(({ name }) => name === "openclaw-gateway-state");
    assert.deepEqual(privateVolume.persistentVolumeClaim, { claimName: claim.metadata.name });
    assert.deepEqual(
      pod.containers[0].volumeMounts.filter(({ name }) => name === privateVolume.name),
      [
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/state",
          subPath: "state",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/agents/main/agent",
          subPath: "agent",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/media",
          subPath: "media",
          readOnly: false,
        },
        ...(embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/workspace",
                subPath: "workspace",
                readOnly: false,
              },
            ]
          : []),
      ],
    );
    if (embedded) {
      // Revision replacement must reuse the attested workspace, not merely preserve its SQLite row.
      const replacement = driver.deployment(
        "gateway",
        ownership,
        namespace,
        "gateway:local",
        "gateway",
        "gateway",
        {},
        "info",
        {
          name: "configuration-2",
          revision: 2,
          revisionId: "revision-2",
          annotations: {},
          loggingLevel: "info",
        },
        true,
        undefined,
        preparedAuth(driver, namespace, true),
      ).spec.template.spec;
      assert.deepEqual(
        replacement.volumes.find(({ name }) => name === privateVolume.name),
        privateVolume,
      );
      assert.deepEqual(
        replacement.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
        pod.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
      );
    }
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) =>
        mountPath.endsWith("/agent/codex-home"),
      ),
      {
        name: "runtime-state",
        mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
        subPath: "gateway-codex-home",
      },
    );
    assert.deepEqual(pod.initContainers[0].volumeMounts, [
      { name: "runtime-state", mountPath: "/home/node" },
      { name: privateVolume.name, mountPath: "/gateway-state" },
    ]);
    assert.equal(pod.initContainers[0].env, undefined);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.fsGroup, 1000);
    assert.equal(gateway.spec.strategy.type, "Recreate");
    assert.equal(
      pod.volumes.some(({ name }) => name === "openclaw-workspace"),
      !embedded,
    );
  }
  const harness = driver.deployment(
    "agent",
    ownership,
    namespace,
    "agent:local",
    "agent",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  assert.equal(JSON.stringify(harness).includes(claim.metadata.name), false);
  assert.equal(JSON.stringify(harness).includes("openclaw-gateway-state"), false);
});

test("private gateway claim reuse and deletion verify exact ownership and storage before mutation", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-claim-ownership";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const desired = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
  let observed = {
    ...structuredClone(desired),
    metadata: { ...desired.metadata, uid: "claim-uid" },
  };
  const mutations = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedPersistentVolumeClaim() {
        if (observed === undefined) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(observed);
      },
      async patchNamespacedPersistentVolumeClaim(request) {
        mutations.push(["patch", request]);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        mutations.push(["delete", request]);
      },
    },
  });
  const valid = structuredClone(observed);
  // An already owned, compatible claim is reused without applying mutable revision state.
  await driver.reconcile(desired, ownership, namespace);
  assert.deepEqual(mutations, []);
  for (const mutate of [
    (claim) => {
      claim.metadata.labels["openclaw.dev/agent"] = "another-agent";
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/namespace-id"] = "another-namespace";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.storageClassName = "network-filesystem";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "40Gi";
    },
  ]) {
    observed = structuredClone(valid);
    mutate(observed);
    await assert.rejects(driver.reconcile(desired, ownership, namespace), /Refusing/);
    await assert.rejects(driver.deleteGatewayPrivateStateClaim(ownership, namespace), /Refusing/);
    assert.deepEqual(mutations, []);
  }
  observed = structuredClone(valid);
  delete observed.metadata.uid;
  await assert.rejects(
    driver.deleteGatewayPrivateStateClaim(ownership, namespace),
    /UID must be explicitly/,
  );
  assert.deepEqual(mutations, []);
  observed = structuredClone(valid);
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
  assert.deepEqual(mutations, [
    [
      "delete",
      {
        name: desired.metadata.name,
        namespace,
        body: { preconditions: { uid: "claim-uid" } },
      },
    ],
  ]);
  observed = undefined;
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
  assert.equal(mutations.length, 1);
});

test("stopping a Kubernetes revision removes routing and execution but retains persistent claims", async () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-stop-storage";
  const revisionId = "revision-stop-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = routedRevision(driver, {
    id: revisionId,
    agentId,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
  });
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
  };
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, namespace);
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revisionId;
  const service = driver.service(gatewayName, ownership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  service.metadata.uid = "service-uid";
  const account = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, namespace);
  account.metadata.uid = "account-uid";
  const route = driver.gatewayRoute(
    { id: revisionId, revision: 1, namespaceId: tenant.id, agentId },
    ownership,
    namespace,
    service,
  );
  route.metadata.uid = "route-uid";
  const deletions = [];
  let gatewayDeleted = false;
  let gatewayPodObservations = 0;
  const gatewayPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "stopped-gateway-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": tenant.id,
        "openclaw.dev/agent": agentId,
        "openclaw.dev/revision": revisionId,
        "openclaw.dev/workload-role": "gateway",
      },
    },
  };
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name !== gatewayName) {
          throw Object.assign(new Error("Not found"), { code: 404 });
        }
        return structuredClone(gateway);
      },
      async deleteNamespacedDeployment(request) {
        deletions.push(["Deployment", request]);
        gatewayDeleted = true;
      },
    },
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace() {
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod() {
        assert.equal(gatewayDeleted, true);
        gatewayPodObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: gatewayPodObservations === 1 ? [structuredClone(gatewayPod)] : [],
        };
      },
      async readNamespacedService() {
        return structuredClone(service);
      },
      async deleteNamespacedService(request) {
        deletions.push(["Service", request]);
      },
      async readNamespacedServiceAccount() {
        return structuredClone(account);
      },
      async deleteNamespacedServiceAccount(request) {
        deletions.push(["ServiceAccount", request]);
      },
      async readNamespacedPersistentVolumeClaim() {
        throw new Error("stop must not inspect persistent claims");
      },
      async deleteNamespacedPersistentVolumeClaim() {
        throw new Error("stop must not delete persistent claims");
      },
    },
    objects: {
      async read() {
        return structuredClone(route);
      },
      async delete(spec, _pretty, _dryRun, _grace, _orphan, _propagation, body) {
        deletions.push(["HTTPRoute", { spec, body }]);
      },
    },
  });

  await driver.stopRevision(revision);
  assert.deepEqual(
    deletions.map(([kind]) => kind),
    ["HTTPRoute", "Service", "ServiceAccount", "Deployment"],
  );
  assert.equal(gatewayPodObservations, 2);
});

test("stopping a containment-only Kubernetes revision removes its workload before Sandbox cleanup", async () => {
  const cleanupCalls = [];
  const deletionCalls = [];
  let deploymentPresent = true;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-containment-only-stop",
    implementation: "test/containment-only",
    capability: "sandbox",
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(deploymentPresent, false);
      assert.ok(podObservations >= 2, "cleanup must wait for the exact workload Pod to terminate");
      cleanupCalls.push(context);
      if (cleanupCalls.length === 1) {
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-containment-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const deploymentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const deployment = driver.deployment(
    deploymentName,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    },
    namespace,
    "agent:local",
    `agent-${digest(revision.agentId)}`,
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  deployment.metadata.uid = "containment-stop-workload-uid";
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "containment-stop-workload-pod",
      namespace,
      labels: structuredClone(deployment.spec.template.metadata.labels),
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace() {
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod(request) {
        assert.equal(request.namespace, namespace);
        const selected = Object.fromEntries(
          request.labelSelector.split(",").map((entry) => entry.split("=")),
        );
        assert.equal(selected["openclaw.dev/namespace"], revision.namespaceId);
        assert.equal(selected["openclaw.dev/agent"], revision.agentId);
        assert.equal(selected["openclaw.dev/revision"], revision.id);
        if (selected["openclaw.dev/workload-role"] === "gateway") {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        }
        assert.equal(selected["openclaw.dev/workload-role"], "agent");
        assert.equal(deploymentPresent, false);
        podObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: podObservations === 1 ? [structuredClone(pod)] : [],
        };
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        if (name === deploymentName && deploymentPresent) {
          return structuredClone(deployment);
        }
        throw notFound();
      },
      async deleteNamespacedDeployment(request) {
        deletionCalls.push(request);
        deploymentPresent = false;
      },
    },
    objects: {},
  });

  // A cleanup failure leaves stop retryable after the Compute-owned workload is gone.
  await assert.rejects(driver.stopRevision(revision), /sandbox cleanup failed/);
  assert.deepEqual(deletionCalls, [
    {
      name: deploymentName,
      namespace,
      body: { preconditions: { uid: deployment.metadata.uid } },
    },
  ]);
  assert.equal(cleanupCalls.length, 1);

  // Retrying an absent workload must still invoke the selected Sandbox cleanup.
  await driver.stopRevision(revision);
  assert.equal(deletionCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.equal(podObservations, 3);
  for (const context of cleanupCalls) {
    assert.equal(context.namespace.id, revision.namespaceId);
    assert.equal(context.namespace.name, namespace);
    assert.deepEqual(context.revision, revision);
  }
});

test("stopping a provider-owned Kubernetes revision waits for Sandbox workload termination", async () => {
  let cleanupComplete = false;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-provider-stop",
    implementation: "test/provider-owned",
    capability: "sandbox",
    facets: ["execution"],
    async provisionHarness() {
      assert.fail("stop must not provision a Harness workload");
    },
    async cleanup() {
      cleanupComplete = true;
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const revision = routedRevision(driver, {
    id: "revision-provider-stop",
    sandboxDriverId: sandboxDriver.id,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "provider-stop-workload-pod",
      namespace,
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
  };
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [namespaceResource] };
      },
      async readNamespace() {
        return structuredClone(namespaceResource);
      },
      async listNamespacedPod(request) {
        const selected = Object.fromEntries(
          request.labelSelector.split(",").map((entry) => entry.split("=")),
        );
        if (selected["openclaw.dev/workload-role"] === "gateway") {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        }
        assert.equal(cleanupComplete, true);
        podObservations += 1;
        return {
          apiVersion: "v1",
          kind: "PodList",
          items: podObservations === 1 ? [structuredClone(pod)] : [],
        };
      },
    },
    apps: {
      async readNamespacedDeployment() {
        throw notFound();
      },
    },
    objects: {},
  });

  await driver.stopRevision(revision);
  assert.equal(cleanupComplete, true);
  assert.equal(podObservations, 2);
});

test("retiring a predecessor preserves both claims and final retirement deletes exact claim UIDs", async () => {
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
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, namespace);
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  let observedGateway = gateway;
  const gatewayService = driver.service(gatewayName, ownership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  let observedService = gatewayService;
  const gatewayAccount = driver.manifest("v1", "ServiceAccount", gatewayName, ownership, namespace);
  gatewayAccount.metadata.uid = "gateway-account-uid";
  let observedServiceAccount = gatewayAccount;
  const route = driver.gatewayRoute(
    { id: "revision-2", revision: 2, namespaceId: tenant.id, agentId },
    ownership,
    namespace,
    gatewayService,
  );
  route.metadata.uid = "route-uid";
  let observedRoute = route;
  const claims = [
    driver.gatewayPrivateStateClaim(agentId, ownership, namespace),
    driver.sharedWorkspaceClaim(agentId, ownership, namespace),
  ];
  for (const claim of claims) {
    claim.metadata.uid = claim.metadata.name + "-uid";
  }
  const deletions = [];
  let failServiceDelete = false;
  const missing = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment() {
        if (observedGateway === undefined) {
          return missing();
        }
        return structuredClone(observedGateway);
      },
      async deleteNamespacedDeployment(request) {
        deletions.push(["Deployment", request]);
      },
    },
    core: {
      async readNamespacedPersistentVolumeClaim({ name }) {
        const claim = claims.find(({ metadata }) => metadata.name === name);
        if (claim === undefined) {
          return missing();
        }
        return structuredClone(claim);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        deletions.push(["PersistentVolumeClaim", request]);
      },
      async readNamespacedService() {
        if (observedService === undefined) {
          return missing();
        }
        return structuredClone(observedService);
      },
      async deleteNamespacedService(request) {
        deletions.push(["Service", request]);
        if (failServiceDelete) {
          throw new Error("service delete failed");
        }
      },
      async readNamespacedServiceAccount() {
        if (observedServiceAccount === undefined) {
          return missing();
        }
        return structuredClone(observedServiceAccount);
      },
      async deleteNamespacedServiceAccount(request) {
        deletions.push(["ServiceAccount", request]);
      },
    },
    objects: {
      async read() {
        if (observedRoute === undefined) {
          return missing();
        }
        return structuredClone(observedRoute);
      },
      async delete(
        spec,
        pretty,
        dryRun,
        gracePeriodSeconds,
        orphanDependents,
        propagationPolicy,
        body,
      ) {
        deletions.push(["HTTPRoute", { spec, body }]);
      },
    },
  });
  await driver.removeRetiredGateway(
    { id: "revision-1", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, []);
  failServiceDelete = true;
  await assert.rejects(
    driver.removeRetiredGateway(
      { id: "revision-2", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
      namespace,
    ),
    /service delete failed/,
  );
  assert.deepEqual(
    deletions.map(([kind]) => kind),
    ["PersistentVolumeClaim", "PersistentVolumeClaim", "HTTPRoute", "Service"],
  );
  assert.equal(
    deletions.some(([kind]) => kind === "Deployment"),
    false,
    "Deployment must remain as the retry witness until Service deletion succeeds",
  );

  deletions.length = 0;
  failServiceDelete = false;
  await driver.removeRetiredGateway(
    { id: "revision-2", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, [
    ...claims.map(({ metadata }) => [
      "PersistentVolumeClaim",
      { name: metadata.name, namespace, body: { preconditions: { uid: metadata.uid } } },
    ]),
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid" } },
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
    [
      "Deployment",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-uid" } } },
    ],
  ]);

  deletions.length = 0;
  observedGateway = undefined;
  observedService = gatewayService;
  observedServiceAccount = gatewayAccount;
  observedRoute = route;
  await driver.removeRetiredGateway(
    { id: "revision-2", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, [
    ...claims.map(({ metadata }) => [
      "PersistentVolumeClaim",
      { name: metadata.name, namespace, body: { preconditions: { uid: metadata.uid } } },
    ]),
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid" } },
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
  ]);

  deletions.length = 0;
  observedRoute = {
    ...route,
    metadata: {
      ...route.metadata,
      annotations: {
        ...route.metadata.annotations,
        "openclaw.dev/agent-revision-id": "revision-3",
      },
    },
  };
  await driver.removeRetiredGateway(
    { id: "revision-2", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, []);
});
