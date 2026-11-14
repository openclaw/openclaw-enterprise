import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  requireConfiguration,
  ConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import {
  options,
  preparedAuth,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

export function checkRequiredResourceFields() {
  const configured = options().resources;

  for (const [resources, path] of [
    [
      { ...configured, gateway: { limits: { cpu: "250m", memory: "128Mi" } } },
      "/resources/gateway/requests",
    ],
    [
      {
        ...configured,
        agent: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "250m" } },
      },
      "/resources/agent/limits/memory",
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
      "/resources/namespace/containerDefaults/requests/memory",
    ],
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ resources })),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(
          error.error.details.map(({ path, code }) => ({ path, code })),
          [{ path, code: "REQUIRED" }],
        );
        return true;
      },
    );
  }
}

function separateResources() {
  const configured = options();
  const { gateway, agent, namespace } = configured.resources;
  const quota: Record<string, string> = structuredClone(namespace.quota);
  return {
    ...configured,
    resources: {
      gateway: structuredClone(gateway),
      agent: structuredClone(agent),
      namespace: { quota, containerDefaults: structuredClone(namespace.containerDefaults) },
    },
  };
}

export function checkSignedResourceQuantities() {
  // A negative request can be below a valid limit; ordering alone does not make it valid.
  // Exercise each workload role, both quantity fields, and signed zero separately.
  for (const role of ["gateway", "agent", "defaults"] as const) {
    for (const field of ["cpu", "memory"] as const) {
      for (const kind of ["requests", "limits"] as const) {
        const configured = separateResources();
        const resources =
          role === "defaults"
            ? configured.resources.namespace.containerDefaults
            : configured.resources[role];
        resources[kind][field] = "-1";
        if (kind === "limits") {
          resources.requests[field] = "0";
        }
        assert.throws(
          () => requireConfiguration(KubernetesComputeDriver, configured),
          (error) => {
            assert.ok(error instanceof ConfigurationValidationError);
            const prefix = role === "defaults" ? "namespace/containerDefaults" : role;
            assert.ok(
              error.error.details.some(
                (detail) =>
                  detail.path === `/resources/${prefix}/${kind}/${field}` &&
                  /non-negative Kubernetes quantity/.test(detail.message ?? ""),
              ),
            );
            return true;
          },
        );
      }
      const zero = separateResources();
      const resources =
        role === "defaults" ? zero.resources.namespace.containerDefaults : zero.resources[role];
      resources.requests[field] = "-0";
      resources.limits[field] = "0";
      assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, zero));
    }
  }
}

export function checkResourceQuantityDiagnostics() {
  for (const [role, kind, field, value] of [
    ["gateway", "limits", "cpu", 4],
    ["agent", "limits", "cpu", 1],
    ["agent", "requests", "cpu", 0.5],
  ] as const) {
    const configured = separateResources();
    Object.assign(configured.resources[role][kind], { [field]: value });
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, configured),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.ok(
          error.error.details.some(({ path }) => path === `/resources/${role}/${kind}/${field}`),
        );
        return true;
      },
    );
  }
  const defaults = separateResources();
  Object.assign(defaults.resources.namespace.containerDefaults.limits, { cpu: 4 });
  assert.throws(
    () => requireConfiguration(KubernetesComputeDriver, defaults),
    ConfigurationValidationError,
  );
  const quota = separateResources();
  Object.assign(quota.resources.namespace.quota, { pods: 10 });
  assert.throws(
    () => requireConfiguration(KubernetesComputeDriver, quota),
    ConfigurationValidationError,
  );
  // The API server refuses the Namespace's ResourceQuota at the first deployment otherwise
  // (finding 2357): resource names are qualified names, and a name without a prefix is a
  // standard quota resource; values are non-negative quantities.
  for (const [resource, value, message] of [
    ["bad key", "1", /Namespace quota resource "bad key" must be a Kubernetes resource name/],
    ["https://kubernetes.io/pods", "1", /must be a Kubernetes resource name/],
    ["count/", "1", /must be a Kubernetes resource name/],
    ["Example.com/gpu", "1", /must be a Kubernetes resource name/],
    ["podz", "1", /Namespace quota resource "podz" must be a Kubernetes resource name/],
    // A standard name must match whole: the API server refuses a longer one.
    ["podsx", "1", /Namespace quota resource "podsx" must be a Kubernetes resource name/],
    [
      "pods",
      "ten",
      /Namespace quota resource pods must be a non-negative Kubernetes quantity string/,
    ],
    ["limits.memory", "8 Gi", /must be a non-negative Kubernetes quantity string/],
    ["requests.cpu", "-1", /must be a non-negative Kubernetes quantity string/],
  ] as const) {
    const configured = separateResources();
    configured.resources.namespace.quota[resource] = value;
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, configured),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.match(error.error.details.map((detail) => detail.message).join("\n"), message);
        return true;
      },
    );
  }
  const extended = separateResources();
  Object.assign(extended.resources.namespace.quota, {
    "count/deployments.apps": "4",
    "requests.nvidia.com/gpu": "2",
    "limits.memory": "8Gi",
    "requests.storage": "100Gi",
    "services.loadbalancers": "0",
    "requests.hugepages-2Mi": "1Gi",
  });
  requireConfiguration(KubernetesComputeDriver, extended);
  // Every standard quota resource without a prefix (ValidateResourceQuotaResourceName) loads.
  for (const resource of [
    "cpu",
    "memory",
    "ephemeral-storage",
    "limits.cpu",
    "requests.ephemeral-storage",
    "limits.ephemeral-storage",
    "hugepages-1Gi",
    "services",
    "services.nodeports",
    "replicationcontrollers",
    "resourcequotas",
    "secrets",
    "configmaps",
    "persistentvolumeclaims",
  ]) {
    const standard = separateResources();
    standard.resources.namespace.quota[resource] = "1";
    requireConfiguration(KubernetesComputeDriver, standard);
  }
  // A missing value is still reported as missing, and quoted cores pass.
  const missing = separateResources();
  const { memory } = missing.resources.gateway.limits;
  const resources = {
    ...missing.resources,
    gateway: { ...missing.resources.gateway, limits: { memory } },
  };
  assert.throws(
    () => requireConfiguration(KubernetesComputeDriver, { ...missing, resources }),
    ConfigurationValidationError,
  );
  const quoted = separateResources();
  quoted.resources.gateway.limits.cpu = "4";
  requireConfiguration(KubernetesComputeDriver, quoted);
}

export function checkCountedQuotaPrecision() {
  for (const resource of [
    "pods",
    "services",
    "services.nodeports",
    "services.loadbalancers",
    "replicationcontrollers",
    "resourcequotas",
    "secrets",
    "configmaps",
    "persistentvolumeclaims",
    "count/deployments.apps",
    "example.com/gpu",
    "kubernetes.io.example/gpu",
  ]) {
    const configured = separateResources();
    configured.resources.namespace.quota = { [resource]: "1500m" };
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, configured),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, [
          {
            path: "/resources/namespace/quota",
            code: "INVALID_FORMAT",
            message: `Namespace quota resource ${resource} must satisfy Kubernetes integer precision; use a whole count such as 4.`,
          },
        ]);
        return true;
      },
    );
  }
  // Upstream ValidateResourceQuotaSpec controls: suffixes can represent whole counts;
  // its MilliValue check also retains values that round up to a whole milliscaled count.
  for (const [resource, quantity] of [
    ["pods", "0"],
    ["pods", "-0"],
    ["pods", "1000m"],
    ["pods", "1.5Ki"],
    ["pods", "1e3"],
    ["pods", "0.9999"],
    ["pods", "1.9999"],
    ["requests.cpu", "500m"],
    ["requests.memory", "1.5Gi"],
    ["requests.nvidia.com/gpu", "1500m"],
    ["example.kubernetes.io/gpu", "1500m"],
    // Native classification uses the namespace suffix, not a DNS-label boundary.
    ["notkubernetes.io/gpu", "1500m"],
  ] as const) {
    const configured = separateResources();
    configured.resources.namespace.quota = { [resource]: quantity };
    const validated = requireConfiguration(KubernetesComputeDriver, configured);
    assert.equal(validated.resources.namespace.quota[resource], quantity);
  }
}

export function checkResourceRequestLimits() {
  const pairs = [
    ["cpu", "500m", "250m", false],
    ["cpu", "0.5", "250m", false],
    ["cpu", "250m", "0.5", true],
    ["cpu", "2e-3", "1m", false],
    ["cpu", "1.00000000001", "1.000000001", true],
    ["memory", "2Gi", "1.5Gi", false],
    ["memory", "1.5Gi", "2Gi", true],
    ["memory", "1.5Ki", "1536", true],
    ["memory", "0.00000000001", "1n", true],
    ["memory", "9223372036854775808", "9223372036854775807", false],
    ["memory", "8Ei", "9223372036854775807", true],
    ["memory", "9E", "8Ei", true],
    ["memory", "\u00851Gi\u0085", "1024Mi", true],
  ] as const;
  for (const role of ["gateway", "agent", "namespace.containerDefaults"] as const) {
    for (const [resource, request, limit, accepted] of pairs) {
      const configured = separateResources();
      const selected =
        role === "namespace.containerDefaults"
          ? configured.resources.namespace.containerDefaults
          : configured.resources[role];
      selected.requests[resource] = request;
      selected.limits[resource] = limit;
      if (accepted) {
        assert.doesNotThrow(() => createKubernetesComputeDriver(configured));
      } else {
        assert.throws(
          () => createKubernetesComputeDriver(configured),
          ConfigurationValidationError,
        );
      }
    }
  }
}

function optionsWithRuntime(overrides: {
  transportSecretPrefix?: string;
  gatewayStorageClassName?: string | undefined;
  gatewayStorageSizeGiB?: number | string | null;
}) {
  return options({
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      ...overrides,
    },
  });
}

export function checkTransportSecretPrefix() {
  for (const transportSecretPrefix of ["Bad_Prefix", "bad prefix", `${"a".repeat(242)}`]) {
    assert.throws(
      () =>
        requireConfiguration(
          KubernetesComputeDriver,
          optionsWithRuntime({ transportSecretPrefix }),
        ),
      ConfigurationValidationError,
    );
  }
  requireConfiguration(
    KubernetesComputeDriver,
    optionsWithRuntime({ transportSecretPrefix: "transport" }),
  );
}

export function checkRequiredGatewayStorageClass() {
  for (const gatewayStorageClassName of [undefined, "", " "]) {
    assert.throws(
      () => createKubernetesComputeDriver(optionsWithRuntime({ gatewayStorageClassName })),
      ConfigurationValidationError,
    );
  }
}

export function checkGatewayStorageClassNames() {
  for (const gatewayStorageClassName of [
    "Bad_Class",
    "bad class",
    "-local-path",
    "a".repeat(254),
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(optionsWithRuntime({ gatewayStorageClassName })),
      ConfigurationValidationError,
    );
  }
  for (const gatewayStorageClassName of ["a".repeat(253), "gp3.encrypted"]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(optionsWithRuntime({ gatewayStorageClassName })),
    );
  }
}

export function checkGatewayStorageCapacity() {
  for (const gatewayStorageSizeGiB of [
    0,
    -1,
    1.5,
    65537,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "100",
    null,
  ]) {
    const configured = optionsWithRuntime({ gatewayStorageSizeGiB });
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, configured),
      ConfigurationValidationError,
    );
    assert.throws(() => createKubernetesComputeDriver(configured), ConfigurationValidationError);
  }
  for (const gatewayStorageSizeGiB of [1, 65536]) {
    const configured = optionsWithRuntime({ gatewayStorageSizeGiB });
    requireConfiguration(KubernetesComputeDriver, configured);
    assert.doesNotThrow(() => createKubernetesComputeDriver(configured));
  }
}

export function checkGatewayStoragePlacement() {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        nodeSelector: { "oce-role": "agents", "topology.kubernetes.io/zone": "us-east-2a" },
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const ownership = { namespaceId: tenant.id, agentId: "agent-node-selector" };
  const gateway = driver["deployment"](
    "gateway",
    ownership,
    { name: namespace, plane: "execution" },
    "gateway:local",
    "gateway",
    "gateway",
    {},
    "info",
    driver["gatewayConfiguration"](
      routedRevision(driver, {
        agentId: ownership.agentId,
      }),
      undefined,
      { name: namespace, plane: "execution" },
    ),
    false,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  const template = gateway.spec?.template;
  assert.ok(template && typeof template === "object" && "spec" in template);
  const pod = template.spec;
  assert.ok(pod && typeof pod === "object" && "nodeSelector" in pod && "initContainers" in pod);
  assert.ok(Array.isArray(pod.initContainers));

  assert.deepEqual(pod.nodeSelector, {
    "oce-role": "control-plane",
  });
  assert.equal(pod.initContainers[0].name, "prepare-private-state");
}
