import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  harnessWorkspacePreparationScript,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  requireConfiguration,
  ConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import {
  podTemplate,
  resourceRecord,
  resourceRecords,
} from "../helpers/kubernetes-rendered-resources.ts";
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
  ] satisfies [KubernetesComputeDriverOptions["resources"], string][]) {
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
    // Kubernetes rounds a nonzero sub-Nano quantity away from zero.
    ["requests.cpu", "-0.00000000001", /must be a non-negative Kubernetes quantity string/],
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

function optionsWithRuntime(
  overrides: Partial<
    Pick<
      NonNullable<KubernetesComputeDriverOptions["runtime"]>,
      "transportSecretPrefix" | "gatewayStorageClassName" | "gatewayStorageSizeGiB"
    >
  >,
) {
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
    const configured =
      gatewayStorageClassName === undefined
        ? optionsWithRuntime({})
        : optionsWithRuntime({ gatewayStorageClassName });
    if (gatewayStorageClassName === undefined) {
      assert.ok(
        Reflect.set(configured, "runtime", { ...configured.runtime, gatewayStorageClassName }),
      );
    }
    assert.throws(() => createKubernetesComputeDriver(configured), ConfigurationValidationError);
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
    const configured =
      typeof gatewayStorageSizeGiB === "number"
        ? optionsWithRuntime({ gatewayStorageSizeGiB })
        : optionsWithRuntime({});
    if (typeof gatewayStorageSizeGiB !== "number") {
      assert.ok(
        Reflect.set(configured, "runtime", { ...configured.runtime, gatewayStorageSizeGiB }),
      );
    }
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

function storagePod(workload: Parameters<typeof podTemplate>[0]) {
  const pod = resourceRecord(podTemplate(workload).spec, "pod spec");
  const [container] = resourceRecords(pod.containers, "containers");
  const [init] = resourceRecords(pod.initContainers, "initContainers");
  assert.ok(container && init);
  const args = init.args;
  assert.ok(Array.isArray(args) && typeof args[0] === "string");
  const initialization: string = args[0];
  return {
    pod,
    init,
    initialization,
    security: resourceRecord(pod.securityContext, "securityContext"),
    volumes: resourceRecords(pod.volumes, "volumes"),
    mounts: resourceRecords(container.volumeMounts, "volumeMounts"),
    cacheEnv: resourceRecords(container.env, "env").filter(
      ({ name }) => name === "NODE_DISABLE_COMPILE_CACHE",
    ),
  };
}

function writableDirectories(name: string, paths: readonly (readonly [string, string])[]) {
  return paths.map(([mountPath, subPath]) => ({ name, mountPath, subPath, readOnly: false }));
}

function checkPrivateStatePreparation(
  { mounts, init, security, initialization }: ReturnType<typeof storagePod>,
  privateMount: { name: string; mountPath: string },
) {
  assert.deepEqual(init.volumeMounts, [
    { name: "runtime-state", mountPath: "/runtime-state" },
    { name: "runtime-temporary", mountPath: "/runtime-temporary" },
    privateMount,
  ]);
  for (const [name, mountPath, subPath] of [
    ["runtime-state", "/home/node", "home"],
    ["runtime-temporary", "/tmp", "tmp"],
  ] as const) {
    assert.deepEqual(
      mounts.filter((mount) => mount.mountPath === mountPath),
      [{ name, mountPath, subPath }],
    );
    assert.ok(initialization.includes(`/${name}/${subPath}`));
  }
  if (privateMount.mountPath === "/gateway-state") {
    assert.ok(initialization.includes("/gateway-state/skill-library"));
  }
  // Avoid recursively changing ownership of retained data on every start.
  assert.equal(security.fsGroup, 1000);
  assert.equal(security.fsGroupChangePolicy, "OnRootMismatch");
}

export function checkGatewayAndHarnessStorage() {
  const driver = createKubernetesComputeDriver(optionsWithRuntime({}));
  const agentId = "agent-private-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const name = kubernetesNamespaceName(tenant.id);
  const namespace = { name, plane: "execution" } as const;
  const claim = driver["gatewayPrivateStateClaim"](agentId, ownership, namespace);
  const workspaceClaim = driver["harnessWorkspaceClaim"](agentId, ownership, namespace).metadata
    .name;
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "local-path",
    resources: { requests: { storage: "10Gi" } },
  });
  const { annotations } = claim.metadata;
  assert.ok(annotations && claim.metadata.name && workspaceClaim);
  assert.equal(annotations["openclaw.dev/agent-id"], agentId);
  assert.equal(annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(annotations["openclaw.dev/revision-id"], undefined);
  assert.notEqual(claim.metadata.name, workspaceClaim);
  assert.notEqual(
    claim.metadata.name,
    driver["gatewayPrivateStateClaim"](
      "another-agent",
      { ...ownership, agentId: "another-agent" },
      namespace,
    ).metadata.name,
  );

  const gatewayState = "openclaw-gateway-state";
  const config = driver["gatewayConfiguration"](
    routedRevision(driver, { agentId }),
    undefined,
    namespace,
  );
  const workspaceSetup = driver["options"].images.gateway;
  const gatewayDeployment = (embedded: boolean, configuration = config) =>
    driver["deployment"](
      "gateway",
      ownership,
      namespace,
      { runtime: "gateway:local", workspaceSetup },
      "gateway",
      "gateway",
      {},
      "info",
      configuration,
      embedded,
      undefined,
      preparedAuth(driver, name, embedded),
    );
  for (const embedded of [false, true]) {
    const gateway = gatewayDeployment(embedded);
    const rendered = storagePod(gateway);
    const { pod, mounts, cacheEnv, volumes, security, init } = rendered;
    assert.equal(pod.terminationGracePeriodSeconds, 330);
    assert.deepEqual(
      cacheEnv,
      embedded ? [] : [{ name: "NODE_DISABLE_COMPILE_CACHE", value: "1" }],
    );
    assert.deepEqual(pod.nodeSelector, embedded ? undefined : { "oce-role": "control-plane" });
    const privateVolumes = volumes.filter(({ name }) => name === gatewayState);
    assert.equal(privateVolumes.length, 1);
    assert.deepEqual(privateVolumes[0]?.persistentVolumeClaim, { claimName: claim.metadata.name });
    assert.ok(!volumes.some(({ name }) => name === "openclaw-workspace"));

    // Retain whole directories so SQLite WAL and SHM siblings survive replacement.
    const home = "/home/node/.openclaw";
    assert.deepEqual(
      mounts.filter(({ name }) => name === gatewayState),
      writableDirectories(gatewayState, [
        [`${home}/state`, "state"],
        [`${home}/client`, "client"],
        [`${home}/agents/main/agent`, "agent"],
        [`${home}/media`, "media"],
        [`${home}/worktrees`, "worktrees"],
        [`${home}/worktree-sources`, "worktree-sources"],
        [`${home}/skill-library`, "skill-library"],
        embedded
          ? [`${home}/workspace`, "workspace"]
          : [`${home}/agents/main/sessions`, "sessions"],
      ]),
    );
    if (embedded) {
      const replacement = storagePod(
        gatewayDeployment(true, {
          name: "configuration-2",
          annotations: {},
          loggingLevel: "info",
          usesGatewayPasswordEnv: false,
          usesWritableNativeAdminConfig: false,
          workspace: undefined,
          revision: 2,
          revisionId: "revision-2",
          gatewayManagedMode: false,
        }),
      );
      assert.deepEqual(
        replacement.volumes.filter(({ name }) => name === gatewayState),
        privateVolumes,
      );
      assert.deepEqual(
        replacement.mounts.filter(({ subPath }) => subPath === "workspace"),
        mounts.filter(({ subPath }) => subPath === "workspace"),
      );
    }

    // Codex home overlays the persistent Agent directory. Its backing store must die with the Pod.
    const codexHome = `${home}/agents/main/agent/codex-home`;
    assert.deepEqual(
      mounts.filter(({ mountPath }) => mountPath === codexHome),
      [{ name: "runtime-state", mountPath: codexHome, subPath: "home/gateway-codex-home" }],
    );
    assert.deepEqual(
      volumes.filter(({ name }) => name === "runtime-state"),
      [{ name: "runtime-state", emptyDir: { sizeLimit: "1Gi" } }],
      "Gateway Codex home must be backed by a bounded emptyDir",
    );
    checkPrivateStatePreparation(rendered, { name: gatewayState, mountPath: "/gateway-state" });
    assert.equal(init.env, undefined);
    assert.equal(security.runAsUser, 1000);
    assert.equal(resourceRecord(gateway.spec?.strategy, "strategy").type, "Recreate");
  }

  const harness = driver["deployment"](
    "agent",
    { ...ownership, revisionId: "revision-render" },
    namespace,
    { runtime: "agent:local", workspaceSetup },
    "agent",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, name, false),
  );
  const rendered = storagePod(harness);
  assert.deepEqual(rendered.cacheEnv, []);
  assert.ok(!JSON.stringify(harness).includes(claim.metadata.name));
  assert.ok(!JSON.stringify(harness).includes(gatewayState));
  const workspace = "openclaw-workspace";
  // The Harness keeps task files and Codex rollouts but never mounts Gateway transcripts.
  assert.deepEqual(
    rendered.mounts.filter(({ name }) => name === workspace),
    writableDirectories(workspace, [
      ["/home/node/workspace", "workspace"],
      ["/home/node/.codex/generated_images", "generated-images"],
      ["/home/node/.codex/sessions", "codex-sessions"],
    ]),
  );
  checkPrivateStatePreparation(rendered, {
    name: workspace,
    mountPath: "/harness-workspace-state",
  });
  assert.ok(
    rendered.initialization.includes(
      harnessWorkspacePreparationScript(
        ["workspace", "generated-images", "codex-sessions"].map(
          (dir) => `/harness-workspace-state/${dir}`,
        ),
      ),
    ),
  );

  // Node credentials survive Pod and revision changes, isolated by Harness on the same claim.
  const revision = routedRevision(driver, {
    agentId,
    id: "revision-node-state",
    configuration: {},
    harness: { id: "openclaw", mode: "dedicated" },
  });
  const withNode = (candidate: typeof revision) => {
    const workload = structuredClone(harness);
    const nodeName = driver["workspaceNodeName"](candidate);
    driver["addWorkspaceNode"](workload, nodeName, undefined, candidate, false);
    const { security, initialization, volumes, mounts } = storagePod(workload);
    assert.deepEqual(security, rendered.security);
    assert.match(initialization, /chmodSync\(path, 0o700\)/);
    assert.ok(initialization.includes(`/harness-workspace-state/${nodeName}`));
    const sandboxMounts = mounts.filter(({ name }) => name === workspace);
    const persistentVolume = volumes.find(({ name }) => name === workspace);
    assert.deepEqual(persistentVolume?.persistentVolumeClaim, { claimName: workspaceClaim });
    const node = sandboxMounts.at(-1);
    assert.ok(node && node.mountPath === "/home/node/.openclaw-node");
    assert.equal(node.readOnly, false);
    assert.ok(typeof node.subPath === "string" && !node.subPath.includes("/"));
    return { mounts: sandboxMounts, node };
  };
  const original = withNode(revision);
  assert.deepEqual(withNode(revision), original);
  assert.deepEqual(withNode({ ...revision, id: "replacement-node-state" }), original);
  const other = withNode({ ...revision, harness: { ...revision.harness, id: "codex" } });
  assert.notEqual(other.node.subPath, original.node.subPath);
  assert.deepEqual(other.mounts.slice(0, -1), original.mounts.slice(0, -1));
}
