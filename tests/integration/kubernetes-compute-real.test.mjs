import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import {
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesFixtureHarnessAuth,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const execute = promisify(execFile);
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requested = [kubeconfigPath, kubernetesContext, fixtureImage].some(Boolean);
const requiresKubernetes = {
  skip: requested
    ? false
    : "Set OCC_TEST_KUBERNETES_KUBECONFIG, OCC_TEST_KUBERNETES_CONTEXT to a k3d-* context, and OCC_TEST_KUBERNETES_IMAGE to run real Kubernetes integration tests.",
};
const requiresKubernetesAndPostgres = {
  skip: !requested
    ? requiresKubernetes.skip
    : databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a dedicated openclaw_k8s_* database to run Kubernetes API and worker integration.",
};
const driverPath = "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
const configurationIds = new Map();
const harnessAuthentication = new Map();
const sharedWorkspaceSize = "40Gi";

function hash(value, length = 12) {
  return sha256Hex(value, length);
}

async function kubectl(...args) {
  const { stdout } = await execute(
    "kubectl",
    ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

async function resource(kind, name, namespace) {
  const args = ["get", kind, name, "-o", "json"];
  if (namespace !== undefined) {
    args.push("--namespace", namespace);
  }
  return JSON.parse(await kubectl(...args));
}

async function resources(kind, namespace) {
  return JSON.parse(await kubectl("get", kind, "--namespace", namespace, "-o", "json")).items;
}

async function missing(kind, name, namespace) {
  try {
    await resource(kind, name, namespace);
    return false;
  } catch (error) {
    if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
      return true;
    }
    throw error;
  }
}

async function waitFor(description, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined && result !== false) {
      return result;
    }
    await delay(500);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function assertKubernetesFixtureAvailable() {
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
}

function namespace(label) {
  const id = `ns_${label}_${randomUUID()}`;
  return {
    id,
    name: label,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

async function provisionFixtureAuth(owner) {
  const auth = await createKubernetesFixtureHarnessAuth({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    namespaceId: owner.id,
  });
  harnessAuthentication.set(owner.id, auth);
}

function revisionContext(candidate) {
  const auth = harnessAuthentication.get(candidate.namespaceId);
  assert.ok(auth, "the ready Namespace must have its fixture authentication provisioned");
  return auth.context;
}

function revision(driver, owner, agentId, number) {
  const identity = `${owner.id}:${agentId}`;
  let configurationId = configurationIds.get(identity);
  if (configurationId === undefined) {
    configurationId = `cfg_${randomUUID()}`;
    configurationIds.set(identity, configurationId);
  }
  const loggingLevel = number === 1 ? "info" : "debug";
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    configurationId,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      {
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: "codex/gpt-5" } },
        logging: { level: loggingLevel },
      },
      loggingLevel,
    ),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: harnessAuthentication.get(owner.id).snapshot,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

function agentName(agentId) {
  return `agent-${hash(agentId)}`;
}

function gatewayName(agentId) {
  return `gateway-${hash(agentId)}`;
}

function sharedWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

function revisionName(candidate) {
  return `${agentName(candidate.agentId)}-rev-${hash(candidate.id)}`;
}

async function assertReadyGateway(namespaceName, agentId, namespaceId, snapshot) {
  const name = gatewayName(agentId);
  const deployment = await resource("deployment", name, namespaceName);
  assert.equal(deployment.spec.replicas, 1, "each Agent gateway must have exactly one replica");
  assert.equal(
    deployment.spec.strategy?.type,
    "Recreate",
    "gateway updates must stop the old Pod before starting its replacement",
  );
  assert.ok(deployment.status.observedGeneration >= deployment.metadata.generation);
  assert.equal(
    deployment.status.readyReplicas,
    1,
    "each Agent gateway must have one ready replica",
  );
  assert.equal(deployment.metadata.annotations["openclaw.dev/agent-id"], agentId);
  if (namespaceId !== undefined) {
    assert.equal(deployment.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
  }
  assert.equal(
    Object.hasOwn(deployment.metadata.annotations, "openclaw.dev/revision-id"),
    false,
    "Agent gateway identity must remain stable across immutable revisions",
  );
  if (snapshot !== undefined) {
    const document = JSON.stringify(snapshot.configuration);
    for (const metadata of [deployment.metadata, deployment.spec.template.metadata]) {
      assert.equal(metadata.annotations["openclaw.dev/configuration-id"], snapshot.configurationId);
      assert.equal(metadata.annotations["openclaw.dev/configuration-kind"], "agent");
      assert.equal(
        metadata.annotations["openclaw.dev/configuration-generation"],
        String(snapshot.configurationGeneration),
      );
      assert.equal(
        Object.values(metadata.annotations).includes(document),
        false,
        "gateway metadata must bind the immutable snapshot without exposing its native document",
      );
    }

    const volume = deployment.spec.template.spec.volumes.find(
      ({ name }) => name === "openclaw-configuration",
    );
    assert.equal(volume.configMap.name, `${gatewayName(agentId)}-rev-${hash(snapshot.id)}`);
    const configuration = await resource("configmap", volume.configMap.name, namespaceName);
    assert.equal(configuration.immutable, true);
    assert.deepEqual(Object.keys(configuration.data), ["openclaw.json"]);
    assert.deepEqual(
      JSON.parse(configuration.data["openclaw.json"]),
      snapshot.configuration,
      "the immutable native document must preserve every value regardless of PostgreSQL JSON key ordering",
    );
    assert.equal(configuration.metadata.annotations["openclaw.dev/agent-id"], agentId);
    if (namespaceId !== undefined) {
      assert.equal(configuration.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
    }
    assert.equal(
      configuration.metadata.annotations["openclaw.dev/configuration-id"],
      snapshot.configurationId,
    );
    assert.equal(
      configuration.metadata.annotations["openclaw.dev/configuration-generation"],
      String(snapshot.configurationGeneration),
    );
    assert.deepEqual(volume.configMap, {
      defaultMode: 0o644,
      name: configuration.metadata.name,
      items: [{ key: "openclaw.json", path: "openclaw.json" }],
      optional: false,
    });
    const container = deployment.spec.template.spec.containers[0];
    assert.deepEqual(
      container.volumeMounts.find(({ name }) => name === "openclaw-configuration"),
      { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
    );
    assert.equal(
      container.env.some(
        ({ name, value }) =>
          name === "OPENCLAW_CONFIG_PATH" && value === "/etc/openclaw/openclaw.json",
      ),
      true,
    );
    assert.equal(
      container.env.some(({ value }) => value === document),
      false,
      "the gateway receives its exact admitted document through a read-only file, never its environment",
    );
  }

  const gatewayPods = (await resources("pods", namespaceName)).filter(
    ({ metadata }) =>
      metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      metadata.labels?.["app.kubernetes.io/name"] === name,
  );
  assert.equal(gatewayPods.length, 1, "each Agent must have exactly one owned gateway Pod");
  assert.equal(
    gatewayPods[0].status.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    ),
    true,
    "the Agent's single gateway Pod must be ready",
  );
  if (snapshot !== undefined) {
    const mountedDocument = await kubectl(
      "exec",
      gatewayPods[0].metadata.name,
      "--namespace",
      namespaceName,
      "--",
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'))",
    );
    assert.deepEqual(
      JSON.parse(mountedDocument),
      snapshot.configuration,
      "the running owner gateway must read the exact immutable native AgentRevision document",
    );
  }

  const service = await resource("service", name, namespaceName);
  assert.equal(service.spec.type, "ClusterIP");
  assert.equal(service.metadata.annotations["openclaw.dev/agent-id"], agentId);
  const accountName = snapshot?.harness?.mode === "embedded" ? agentName(agentId) : name;
  const account = await resource("serviceaccount", accountName, namespaceName);
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(account.metadata.annotations["openclaw.dev/agent-id"], agentId);
  const slices = await resources("endpointslices", namespaceName);
  assert.ok(
    slices.some(
      (slice) =>
        slice.metadata.labels?.["kubernetes.io/service-name"] === name &&
        slice.endpoints.some((endpoint) => endpoint.conditions?.ready === true),
    ),
    "the gateway Service must have at least one actually ready EndpointSlice endpoint",
  );
  return deployment;
}

async function assertSharedWorkspaceClaim(namespaceName, namespaceId, agentId, expectedUid) {
  const claim = await resource(
    "persistentvolumeclaim",
    sharedWorkspaceClaimName(agentId),
    namespaceName,
  );
  assert.equal(claim.metadata.namespace, namespaceName);
  assert.equal(claim.metadata.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
  assert.equal(claim.metadata.labels["openclaw.dev/namespace"], namespaceId);
  assert.equal(claim.metadata.labels["openclaw.dev/agent"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteMany"]);
  assert.equal(claim.spec.resources.requests.storage, sharedWorkspaceSize);
  assert.equal(claim.spec.storageClassName, "local-path");
  assert.equal(claim.status.phase, "Bound");
  assert.equal(claim.status.capacity.storage, sharedWorkspaceSize);
  if (expectedUid !== undefined) {
    assert.equal(
      claim.metadata.uid,
      expectedUid,
      "Agent-owned shared workspace claim must be reused",
    );
  }
  return claim;
}

async function assertNonservingAgentService(name, agentId) {
  const service = await resource("service", agentName(agentId), name);
  const slices = await resources("endpointslices", name);
  const ready = slices.flatMap((slice) =>
    slice.metadata.labels?.["kubernetes.io/service-name"] === service.metadata.name
      ? (slice.endpoints ?? []).filter((endpoint) => endpoint.conditions?.ready === true)
      : [],
  );
  assert.equal(ready.length, 0, "an unactivated candidate must not become routable");
  return service;
}

function fixtureComputeConfiguration(overrides = {}) {
  const workloadResources = {
    requests: { cpu: "25m", memory: "48Mi" },
    limits: { cpu: "250m", memory: "192Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    images: { gateway: fixtureImage, agent: fixtureImage, requireImmutableDigest: false },
    resources: {
      gateway: workloadResources,
      agent: workloadResources,
      namespace: {
        quota: {
          pods: "20",
          "requests.cpu": "1",
          "requests.memory": "1Gi",
          "limits.cpu": "4",
          "limits.memory": "3Gi",
        },
        containerDefaults: workloadResources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayClients: [
        { namespace: "default", podLabels: { "app.kubernetes.io/name": "platform-probe" } },
      ],
    },
    servicePrincipalCredentials: {
      mode: "projectedServiceAccountToken",
      audience: "openclaw-enterprise",
      expirationSeconds: 3_600,
    },
    ...overrides,
  };
}

async function createDriver(overrides = {}, selection = {}) {
  const { KubernetesComputeDriver, kubernetesNamespaceName } = await import(driverPath);
  return {
    driver: new KubernetesComputeDriver(fixtureComputeConfiguration(overrides), selection),
    kubernetesNamespaceName,
  };
}

async function workloadPod(namespaceName, selector) {
  const pods = JSON.parse(
    await kubectl(
      "get",
      "pods",
      "--namespace",
      namespaceName,
      "--selector",
      selector,
      "-o",
      "json",
    ),
  ).items;
  return pods.find((pod) => pod.status.phase === "Running" && pod.status.podIP !== undefined);
}

async function probe(namespaceName, podName, operation, target, port) {
  return kubectl(
    "exec",
    podName,
    "--namespace",
    namespaceName,
    "--",
    "node",
    "/fixture/probe.mjs",
    operation,
    target,
    ...(port === undefined ? [] : [String(port)]),
  );
}

async function assertDeniedTraffic(description, namespaceName, podName, operation, target, port) {
  try {
    await probe(namespaceName, podName, operation, target, port);
    assert.fail(`${description} unexpectedly succeeded`);
  } catch (error) {
    if (error.code === "ERR_ASSERTION") {
      throw error;
    }
    assert.equal(error.code, 1, `${description} must be denied by enforced NetworkPolicies`);
  }
}

async function authorized(namespaceName, actor, verb, kind) {
  const output = await kubectl(
    "auth",
    "can-i",
    verb,
    kind,
    "--namespace",
    namespaceName,
    `--as=${actor}`,
  ).catch(({ stdout }) => stdout);
  return output.trim() === "yes";
}

async function createScopedController(context, installationId, platformNamespace) {
  const identifier = hash(installationId);
  const account = "openclaw-controller";
  const namespaceRole = `oce-namespaces-${identifier}`;
  const tenantRole = `oce-tenant-${identifier}`;
  const binding = `oce-controller-${identifier}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-controller-"));
  context.after(async () => {
    await kubectl("delete", "clusterrolebinding", binding, "--ignore-not-found=true");
    await kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found=true");
    await rm(directory, { force: true, recursive: true });
  });

  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "patch",
    "clusterrole",
    namespaceRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: { nonResourceURLs: ["/version"], verbs: ["get"] },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrole",
    tenantRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges",
  );
  await kubectl(
    "patch",
    "clusterrole",
    tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["pods"],
          verbs: ["get", "list", "watch"],
        },
      },
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "create", "patch", "delete"],
        },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrolebinding",
    binding,
    `--clusterrole=${namespaceRole}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );

  const token = (
    await kubectl("create", "token", account, "--namespace", platformNamespace)
  ).trim();
  const current = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const scopedContext = `scoped-${identifier}`;
  const scopedKubeconfig = join(directory, "kubeconfig.json");
  await writeFile(
    scopedKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "local", cluster: current.clusters[0].cluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name: scopedContext, context: { cluster: "local", user: account } }],
      "current-context": scopedContext,
    }),
    { mode: 0o600 },
  );

  return {
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: scopedKubeconfig,
      context: scopedContext,
    },
    account,
    tenantRole,
  };
}

test(
  "real Kubernetes Compute Driver owns isolated Agent gateways, identities, revisions, and deletion",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      await kubectl(
        "delete",
        "namespace",
        platformNamespace,
        "--ignore-not-found=true",
        "--wait=true",
      );
    });
    const controller = await createScopedController(context, installationId, platformNamespace);
    const platformPeer = {
      namespace: platformNamespace,
      podLabels: { "app.kubernetes.io/name": "platform-probe" },
    };
    await kubectl(
      "run",
      "platform-probe",
      "--namespace",
      platformNamespace,
      `--image=${fixtureImage}`,
      "--image-pull-policy=IfNotPresent",
      "--restart=Never",
      "--labels=app.kubernetes.io/name=platform-probe",
    );
    await kubectl(
      "wait",
      "--namespace",
      platformNamespace,
      "--for=condition=Ready",
      "pod/platform-probe",
      "--timeout=120s",
    );

    const { driver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
      network: {
        dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
        gatewayPort: 8080,
        gatewayClients: [platformPeer],
      },
    });
    assert.equal(driver.id, "compute-kubernetes-local");
    assert.equal(driver.implementation, "kubernetes-local");
    // The production preflight must observe the real API server through the same scoped identity
    // used for Namespace lifecycle without reporting the CI-supported 1.35 family as advisory.
    assert.deepEqual(await driver.preflight(), { warnings: [] });

    const first = namespace("first");
    const second = namespace("second");
    const empty = namespace("empty");
    const foreign = namespace("foreign");
    const owned = [first, second, empty].map(({ id }) => kubernetesNamespaceName(id));
    const foreignName = kubernetesNamespaceName(foreign.id);
    context.after(async () => {
      await Promise.all(
        [...owned, foreignName].map((name) =>
          kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=true"),
        ),
      );
    });

    assert.notEqual(owned[0], owned[1], "tenant IDs must map to distinct Kubernetes namespaces");
    for (const owner of [first, second, empty]) {
      const pending = await driver.ensureNamespace(owner);
      // A Namespace cannot be ready until its exact tenant-scoped RBAC admits backing resources.
      assert.equal(pending.namespaceReady, false);
      assert.equal(
        Object.hasOwn(pending, "failure"),
        false,
        "an expected operator-owned tenant RoleBinding must remain pending rather than fail permanently",
      );
      assert.equal(Object.hasOwn(pending, "gatewayReady"), false);
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        kubernetesNamespaceName(owner.id),
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }
    await Promise.all(
      [first, second, empty].map((owner) =>
        waitFor(`Namespace ${owner.id} backing infrastructure to become ready`, async () => {
          const observation = await driver.ensureNamespace(owner);
          assert.equal(observation.namespaceId, owner.id);
          assert.notEqual(observation.failure, "permanent");
          return observation.namespaceReady ? observation : undefined;
        }),
      ),
    );

    for (const [index, owner] of [first, second].entries()) {
      const name = owned[index];
      const backing = await resource("namespace", name);
      assert.equal(backing.status.phase, "Active");
      assert.equal(backing.metadata.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
      assert.equal(backing.metadata.labels["openclaw.dev/namespace"], owner.id);
      for (const mode of ["enforce", "audit", "warn"]) {
        assert.equal(backing.metadata.labels[`pod-security.kubernetes.io/${mode}`], "restricted");
      }

      const policyNames = (await resources("networkpolicies", name))
        .map(({ metadata }) => metadata.name)
        .sort();
      assert.deepEqual(policyNames, ["allow-dns", "allow-gateway-ingress", "default-deny"]);
      await resource("resourcequota", "openclaw-quota", name);
      await resource("limitrange", "openclaw-limits", name);
      await driver.ensureNamespace(owner);
      assert.equal(
        (await resources("deployments", name)).length,
        0,
        "Namespace preparation must not create a gateway before an Agent is deployed",
      );
    }

    await Promise.all([first, second].map(provisionFixtureAuth));

    const primaryAgent = `agt_${randomUUID()}`;
    const secondaryAgent = `agt_${randomUUID()}`;
    const crossTenantAgent = `agt_${randomUUID()}`;
    const firstRevision = revision(driver, first, primaryAgent, 1);
    const secondRevision = revision(driver, first, primaryAgent, 2);
    const separateAgentRevision = revision(driver, first, secondaryAgent, 1);
    const crossTenantRevision = revision(driver, second, crossTenantAgent, 1);
    const candidates = [firstRevision, secondRevision, separateAgentRevision, crossTenantRevision];
    const foreignCompute = { id: "different-driver", implementation: "different-implementation" };
    const unreadyFirstRevision = {
      namespaceId: firstRevision.namespaceId,
      agentId: firstRevision.agentId,
      revisionId: firstRevision.id,
      ready: false,
    };

    // Revisions pinned to another driver must never create actual tenant resources.
    assert.deepEqual(
      await driver.prepareRevision(
        { ...firstRevision, compute: foreignCompute },
        revisionContext(firstRevision),
      ),
      unreadyFirstRevision,
    );
    assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
    assert.equal(await missing("service", agentName(primaryAgent), owned[0]), true);
    assert.equal(await missing("serviceaccount", agentName(primaryAgent), owned[0]), true);
    assert.equal(await missing("deployment", gatewayName(primaryAgent), owned[0]), true);

    const invalidClaimDirectory = await mkdtemp(join(tmpdir(), "openclaw-invalid-pvc-"));
    const invalidClaimPath = join(invalidClaimDirectory, "workspace-pvc.json");
    await writeFile(
      invalidClaimPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: sharedWorkspaceClaimName(primaryAgent),
          namespace: owned[0],
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": first.id,
            "openclaw.dev/agent": primaryAgent,
          },
          annotations: {
            "openclaw.dev/namespace-id": first.id,
            "openclaw.dev/agent-id": primaryAgent,
          },
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("apply", "--filename", invalidClaimPath);
    try {
      await assert.rejects(
        driver.prepareRevision(firstRevision, revisionContext(firstRevision)),
        /invalid PersistentVolumeClaim workspace-/i,
      );
      assert.equal(await missing("deployment", gatewayName(primaryAgent), owned[0]), true);
      assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
      const rejectedClaim = await resource(
        "persistentvolumeclaim",
        sharedWorkspaceClaimName(primaryAgent),
        owned[0],
      );
      assert.deepEqual(rejectedClaim.spec.accessModes, ["ReadWriteOnce"]);
      assert.equal(rejectedClaim.spec.resources.requests.storage, "1Gi");
    } finally {
      await rm(invalidClaimDirectory, { recursive: true, force: true });
      await kubectl(
        "delete",
        "persistentvolumeclaim",
        sharedWorkspaceClaimName(primaryAgent),
        "--namespace",
        owned[0],
        "--wait=true",
      );
    }

    const gatewayIdentities = new Map();
    const sharedWorkspaceIdentities = new Map();
    for (const candidate of candidates) {
      await waitFor(`AgentRevision ${candidate.id} to become ready`, async () => {
        const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
        assert.deepEqual(
          {
            namespaceId: observation.namespaceId,
            agentId: observation.agentId,
            revisionId: observation.revisionId,
          },
          {
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
          },
        );
        return observation.ready ? observation : undefined;
      });
      const placement = kubernetesNamespaceName(candidate.namespaceId);
      const gateway = await assertReadyGateway(
        placement,
        candidate.agentId,
        candidate.namespaceId,
        candidate,
      );
      const identityKey = `${candidate.namespaceId}:${candidate.agentId}`;
      if (gatewayIdentities.has(identityKey)) {
        assert.equal(
          gateway.metadata.uid,
          gatewayIdentities.get(identityKey),
          "replacement revisions must reuse their Agent's existing gateway",
        );
      } else {
        gatewayIdentities.set(identityKey, gateway.metadata.uid);
      }
      const deployment = await resource("deployment", revisionName(candidate), placement);
      const sharedClaim = await assertSharedWorkspaceClaim(
        placement,
        candidate.namespaceId,
        candidate.agentId,
        sharedWorkspaceIdentities.get(identityKey),
      );
      sharedWorkspaceIdentities.set(identityKey, sharedClaim.metadata.uid);
      for (const workload of [gateway, deployment]) {
        assert.deepEqual(
          workload.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
          {
            name: "openclaw-workspace",
            persistentVolumeClaim: { claimName: sharedWorkspaceClaimName(candidate.agentId) },
          },
        );
      }
      assert.equal(deployment.spec.template.spec.serviceAccountName, agentName(candidate.agentId));
      assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
      assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
      assert.equal(
        deployment.spec.template.spec.securityContext.seccompProfile.type,
        "RuntimeDefault",
      );
      const container = deployment.spec.template.spec.containers[0];
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
      assert.deepEqual(container.resources.requests, { cpu: "25m", memory: "48Mi" });
      assert.equal(deployment.status.readyReplicas, 1);
      const account = await resource("serviceaccount", agentName(candidate.agentId), placement);
      assert.equal(account.automountServiceAccountToken, false);
      assert.equal(
        account.metadata.annotations["openclaw.dev/service-principal-id"],
        candidate.servicePrincipalId,
      );
      const projection = deployment.spec.template.spec.volumes.find(
        ({ projected }) => projected !== undefined,
      );
      assert.equal(
        projection.projected.sources[0].serviceAccountToken.audience,
        "openclaw-enterprise",
      );
      assert.equal(projection.projected.sources[0].serviceAccountToken.expirationSeconds, 3_600);
      await assertNonservingAgentService(placement, candidate.agentId);
    }

    assert.equal(
      (await resources("deployments", owned[0])).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      2,
      "two Agents in the same Namespace must own two independent gateway Deployments",
    );
    assert.equal(
      (await resources("deployments", owned[1])).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      1,
      "a separate Namespace must own only its deployed Agent's gateway",
    );
    assert.equal(
      (await resources("deployments", owned[2])).length,
      0,
      "an Agent-free Namespace must remain ready without a gateway",
    );

    assert.deepEqual(
      await driver.prepareRevision(firstRevision, revisionContext(firstRevision)),
      unreadyFirstRevision,
      "a stale previous revision cannot replace the newer live owner gateway",
    );

    const scaledRevision = revision(driver, first, primaryAgent, 3);
    await kubectl(
      "scale",
      `deployment/${gatewayName(primaryAgent)}`,
      "--namespace",
      owned[0],
      "--replicas=2",
    );
    try {
      // An externally scaled owner gateway must not start another revision or affect its sibling.
      assert.deepEqual(
        await driver.prepareRevision(scaledRevision, revisionContext(scaledRevision)),
        {
          namespaceId: first.id,
          agentId: primaryAgent,
          revisionId: scaledRevision.id,
          ready: false,
        },
      );
      assert.equal(await missing("deployment", revisionName(scaledRevision), owned[0]), true);
      await assertReadyGateway(owned[0], secondaryAgent, first.id);
    } finally {
      await kubectl(
        "scale",
        `deployment/${gatewayName(primaryAgent)}`,
        "--namespace",
        owned[0],
        "--replicas=1",
      );
    }
    await waitFor(
      "the externally scaled Agent gateway to return to one ready replica",
      async () => {
        const observation = await driver.prepareRevision(
          secondRevision,
          revisionContext(secondRevision),
        );
        return observation.ready ? observation : undefined;
      },
    );

    const firstPod = await workloadPod(
      owned[0],
      `app.kubernetes.io/name=${revisionName(firstRevision)}`,
    );
    const siblingPod = await workloadPod(
      owned[0],
      `app.kubernetes.io/name=${revisionName(separateAgentRevision)}`,
    );
    const foreignPod = await workloadPod(
      owned[1],
      `app.kubernetes.io/name=${revisionName(crossTenantRevision)}`,
    );
    const gatewayPod = await workloadPod(
      owned[0],
      `app.kubernetes.io/name=${gatewayName(primaryAgent)}`,
    );
    const platformProbe = await resource("pod", "platform-probe", platformNamespace);
    assert.ok(firstPod && siblingPod && foreignPod && gatewayPod);

    const gatewayUrl = `http://${gatewayName(primaryAgent)}.${owned[0]}.svc.cluster.local:8080/readyz`;
    assert.equal(
      JSON.parse(await probe(platformNamespace, "platform-probe", "http", gatewayUrl)).status,
      200,
      "an explicitly approved platform client must reach the exact Agent's owned gateway",
    );
    assert.ok(
      JSON.parse(
        await probe(
          owned[0],
          firstPod.metadata.name,
          "dns",
          "kubernetes.default.svc.cluster.local",
        ),
      ).address,
      "Agent DNS traffic must remain explicitly allowed",
    );
    await assertDeniedTraffic(
      "Agent outbound platform traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      platformProbe.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "Agent outbound Kubernetes API traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      "kubernetes.default.svc.cluster.local",
      443,
    );
    await assertDeniedTraffic(
      "Agent outbound cloud metadata traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      "169.254.169.254",
      80,
    );
    const projectedIdentity = JSON.parse(
      await probe(
        owned[0],
        firstPod.metadata.name,
        "token",
        "/var/run/secrets/openclaw/service-principal/token",
      ),
    );
    assert.deepEqual(
      projectedIdentity.audience,
      ["openclaw-enterprise"],
      "projected credentials must carry the configured non-Kubernetes ServicePrincipal audience",
    );
    assert.equal(
      projectedIdentity.subject,
      `system:serviceaccount:${owned[0]}:${agentName(primaryAgent)}`,
      "projected ServicePrincipal credentials must belong only to the exact Agent ServiceAccount",
    );

    await assertDeniedTraffic(
      "cross-tenant Agent traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      foreignPod.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "same-tenant Agent-to-Agent traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      siblingPod.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "gateway-to-candidate Agent traffic",
      owned[0],
      gatewayPod.metadata.name,
      "tcp",
      firstPod.status.podIP,
      8080,
    );

    const controllerActor = `system:serviceaccount:${platformNamespace}:${controller.account}`;
    assert.equal(
      await authorized(owned[0], controllerActor, "get", "secrets"),
      false,
      "the controller must not receive broad Secret access",
    );
    assert.equal(
      await authorized(
        owned[0],
        `system:serviceaccount:${owned[0]}:${agentName(primaryAgent)}`,
        "get",
        "secrets",
      ),
      false,
      "Agent ServiceAccounts must not acquire Kubernetes API privileges",
    );

    const firstAgentAccount = await resource("serviceaccount", agentName(primaryAgent), owned[0]);
    const secondAgentAccount = await resource(
      "serviceaccount",
      agentName(secondaryAgent),
      owned[0],
    );
    assert.notEqual(firstAgentAccount.metadata.uid, secondAgentAccount.metadata.uid);
    assert.equal(
      (await resources("deployments", owned[0])).filter(
        ({ spec }) => spec.template.spec.serviceAccountName === agentName(primaryAgent),
      ).length,
      2,
      "revisions of the same Agent share its identity but retain independent Deployments",
    );

    const siblingGatewayService = await resource("service", gatewayName(secondaryAgent), owned[0]);
    await kubectl(
      "delete",
      "service",
      gatewayName(primaryAgent),
      "--namespace",
      owned[0],
      "--wait=true",
    );
    await waitFor(
      "the controller to repair only the Agent's missing owned gateway Service",
      async () => {
        const observation = await driver.prepareRevision(
          secondRevision,
          revisionContext(secondRevision),
        );
        return observation.ready ? observation : undefined;
      },
    );
    await assertReadyGateway(owned[0], primaryAgent, first.id);
    assert.equal(
      (await resource("service", gatewayName(secondaryAgent), owned[0])).metadata.uid,
      siblingGatewayService.metadata.uid,
      "repairing one Agent gateway must not replace a sibling Agent's gateway resources",
    );

    await kubectl("create", "namespace", foreignName);
    assert.equal(
      await authorized(foreignName, controllerActor, "get", "serviceaccounts"),
      false,
      "a namespace-only controller cluster grant must not leak namespaced access across tenants",
    );
    const denied = await driver.ensureNamespace(foreign);
    assert.deepEqual(denied, {
      namespaceId: foreign.id,
      namespaceReady: false,
      failure: "permanent",
    });
    const foreignLabels = (await resource("namespace", foreignName)).metadata.labels ?? {};
    assert.equal(
      foreignLabels["app.kubernetes.io/managed-by"],
      undefined,
      "a foreign namespace must not be relabeled as managed after ownership denial",
    );
    assert.equal(
      foreignLabels["openclaw.dev/namespace"],
      undefined,
      "a foreign namespace must not be labeled with a tenant owner after ownership denial",
    );

    await assert.rejects(
      driver.retireRevision({ ...firstRevision, compute: foreignCompute }),
      /another Compute Driver/i,
    );
    await resource("deployment", revisionName(firstRevision), owned[0]);

    await driver.retireRevision(firstRevision);
    assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
    await assertSharedWorkspaceClaim(
      owned[0],
      first.id,
      primaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${primaryAgent}`),
    );
    await resource("deployment", revisionName(secondRevision), owned[0]);
    await resource("deployment", revisionName(separateAgentRevision), owned[0]);
    await resource("deployment", revisionName(crossTenantRevision), owned[1]);
    await resource("serviceaccount", agentName(primaryAgent), owned[0]);
    await assertReadyGateway(owned[0], primaryAgent, first.id);
    await assertReadyGateway(owned[0], secondaryAgent, first.id);

    const embeddedAgent = `agt_${randomUUID()}`;
    const embeddedRevision = {
      ...revision(driver, first, embeddedAgent, 1),
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    };
    embeddedRevision.configuration.agents.defaults.model = "openai/gpt-5";
    await waitFor(`embedded AgentRevision ${embeddedRevision.id} to become ready`, async () => {
      const observation = await driver.prepareRevision(
        embeddedRevision,
        revisionContext(embeddedRevision),
      );
      return observation.ready ? observation : undefined;
    });
    await assertReadyGateway(owned[0], embeddedAgent, first.id, embeddedRevision);
    assert.equal(
      await missing("persistentvolumeclaim", sharedWorkspaceClaimName(embeddedAgent), owned[0]),
      true,
      "embedded Agents must remain unchanged and create no shared workspace claim",
    );

    await driver.retireRevision(secondRevision);
    await waitFor(
      `shared workspace claim ${sharedWorkspaceClaimName(primaryAgent)} to be deleted`,
      () => missing("persistentvolumeclaim", sharedWorkspaceClaimName(primaryAgent), owned[0]),
    );
    await assertSharedWorkspaceClaim(
      owned[0],
      first.id,
      secondaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${secondaryAgent}`),
    );
    await assertReadyGateway(owned[0], secondaryAgent, first.id);

    await waitFor(`empty Namespace ${empty.id} to be completely deleted`, async () => {
      const observation = await driver.deleteNamespace(empty);
      assert.equal(observation.namespaceId, empty.id);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceDeleted ? observation : undefined;
    });
    assert.equal(await missing("namespace", owned[2]), true);
    assert.deepEqual(await driver.deleteNamespace(empty), {
      namespaceId: empty.id,
      namespaceDeleted: true,
    });
  },
);

test(
  "real Kubernetes Drivers safely use and preserve an externally managed tenant namespace",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    const directory = await mkdtemp(join(tmpdir(), "openclaw-existing-namespace-"));
    const existingName = `oce-existing-${hash(randomUUID())}`;
    const cleanupName = `oce-existing-${hash(randomUUID())}`;
    const duplicateName = `oce-duplicate-${hash(randomUUID())}`;
    const unclaimedName = `oce-unclaimed-${hash(randomUUID())}`;
    const owner = {
      ...namespace("existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: existingName,
    };
    const cleanupOwner = {
      ...namespace("empty-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: cleanupName,
    };

    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      await Promise.all(
        [platformNamespace, existingName, cleanupName, duplicateName, unclaimedName].map((name) =>
          kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=true"),
        ),
      );
      await rm(directory, { force: true, recursive: true });
    });
    const controller = await createScopedController(context, installationId, platformNamespace);
    const { driver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
    });
    const { KubernetesConfigurationDriver, kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const configurationDriver = new KubernetesConfigurationDriver({
      authentication: controller.authentication,
    });

    // Operators prepare arbitrary names before the API generates a platform Namespace identity.
    async function createExistingNamespace(name) {
      await kubectl("create", "namespace", name);
      await kubectl(
        "label",
        "namespace",
        name,
        "app.kubernetes.io/managed-by=Helm",
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/audit=restricted",
        "pod-security.kubernetes.io/warn=restricted",
      );
      await kubectl("annotate", "namespace", name, "openclaw.dev/namespace-lifecycle=external");
    }

    async function grantTenantAccess(name) {
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        name,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }

    async function assertPermanentlyRejected(tenant = owner) {
      assert.deepEqual(await driver.ensureNamespace(tenant), {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
      });
    }

    // Explicit selection never creates the requested namespace or silently falls back to a new one.
    const missingOwner = {
      ...namespace("missing-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: `oce-missing-${hash(randomUUID())}`,
    };
    await assertPermanentlyRejected(missingOwner);
    assert.equal(await missing("namespace", missingOwner.existingNamespace), true);
    assert.equal(await missing("namespace", kubernetesNamespaceName(missingOwner.id)), true);

    // Failed provisioning may be deleted without adopting or mutating an unclaimed operator namespace.
    await createExistingNamespace(unclaimedName);
    const unclaimedOwner = {
      ...namespace("failed-existing"),
      id: `ns_${randomUUID()}`,
      status: "deleting",
      existingNamespace: unclaimedName,
    };
    const untouchedNamespace = await resource("namespace", unclaimedName);
    assert.deepEqual(await driver.deleteNamespace(unclaimedOwner), {
      namespaceId: unclaimedOwner.id,
      namespaceDeleted: true,
    });
    assert.deepEqual(await resource("namespace", unclaimedName), untouchedNamespace);

    await createExistingNamespace(existingName);
    assert.notEqual(existingName, kubernetesNamespaceName(owner.id));
    const originalNamespace = await resource("namespace", existingName);
    assert.equal(Object.hasOwn(originalNamespace.metadata.labels, "openclaw.dev/namespace"), false);
    assert.equal(
      Object.hasOwn(originalNamespace.metadata.annotations, "openclaw.dev/namespace-id"),
      false,
    );

    // Existing foreign identity, missing external consent, and unsafe Pod Security fail closed.
    for (const [operation, key, rejectedValue, restoredValue] of [
      ["label", "openclaw.dev/namespace", randomUUID(), undefined],
      ["annotate", "openclaw.dev/namespace-id", `ns_${randomUUID()}`, undefined],
      ["annotate", "openclaw.dev/namespace-lifecycle", undefined, "external"],
      ["label", "pod-security.kubernetes.io/enforce", "baseline", "restricted"],
    ]) {
      await kubectl(
        operation,
        "namespace",
        existingName,
        rejectedValue === undefined ? `${key}-` : `${key}=${rejectedValue}`,
        "--overwrite",
      );
      const rejectedNamespace = await resource("namespace", existingName);
      await assertPermanentlyRejected();
      assert.deepEqual(await resource("namespace", existingName), rejectedNamespace);
      await kubectl(
        operation,
        "namespace",
        existingName,
        restoredValue === undefined ? `${key}-` : `${key}=${restoredValue}`,
        "--overwrite",
      );
    }

    // Listing tenant NetworkPolicies is scoped RBAC: absent permission remains retryable and inert.
    const namespaceBeforeAuthorization = await resource("namespace", existingName);
    assert.deepEqual(await driver.ensureNamespace(owner), {
      namespaceId: owner.id,
      namespaceReady: false,
    });
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeAuthorization);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await grantTenantAccess(existingName);

    // An already-bound tenant cannot claim a second physical namespace through explicit selection.
    await createExistingNamespace(duplicateName);
    await kubectl("label", "namespace", duplicateName, `openclaw.dev/namespace=${owner.id}`);
    await kubectl("annotate", "namespace", duplicateName, `openclaw.dev/namespace-id=${owner.id}`);
    const namespaceBeforeDuplicateRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected();
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeDuplicateRejection);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl("delete", "namespace", duplicateName, "--wait=true");

    // Additive foreign allow-all policy would defeat default-deny, so reject before any OCC mutation.
    const foreignPolicyPath = join(directory, "foreign-allow-all.json");
    await writeFile(
      foreignPolicyPath,
      JSON.stringify({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "operator-allow-all", namespace: existingName },
        spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [{}], egress: [{}] },
      }),
    );
    await kubectl("create", "-f", foreignPolicyPath);
    const originalForeignPolicy = await resource(
      "networkpolicy",
      "operator-allow-all",
      existingName,
    );
    const namespaceBeforePolicyRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected();
    assert.deepEqual(
      await resource("namespace", existingName),
      namespaceBeforePolicyRejection,
      "foreign NetworkPolicies must be rejected before binding tenant ownership metadata",
    );
    assert.deepEqual(
      await resource("networkpolicy", "operator-allow-all", existingName),
      originalForeignPolicy,
      "a foreign allow-all policy must remain entirely unchanged after rejection",
    );
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl(
      "delete",
      "networkpolicy",
      "operator-allow-all",
      "--namespace",
      existingName,
      "--wait=true",
    );

    await waitFor("explicitly selected existing tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(owner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const preparedNamespace = await resource("namespace", existingName);
    assert.equal(preparedNamespace.metadata.uid, originalNamespace.metadata.uid);
    assert.deepEqual(preparedNamespace.metadata.labels, {
      ...originalNamespace.metadata.labels,
      "openclaw.dev/namespace": owner.id,
    });
    assert.deepEqual(preparedNamespace.metadata.annotations, {
      ...originalNamespace.metadata.annotations,
      "openclaw.dev/namespace-id": owner.id,
    });
    assert.equal(preparedNamespace.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(
      preparedNamespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(owner.id)), true);
    assert.deepEqual(
      (await resources("networkpolicies", existingName))
        .map(({ metadata }) => metadata.name)
        .sort(),
      ["allow-dns", "allow-gateway-ingress", "default-deny"],
    );
    await resource("resourcequota", "openclaw-quota", existingName);
    await resource("limitrange", "openclaw-limits", existingName);
    const readyOwner = { ...owner, status: "ready" };
    await provisionFixtureAuth(readyOwner);

    // Configuration discovers ownership the Compute Driver bound to the selected namespace.
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: owner.id,
      kind: "agent",
      generation: 1,
      values: { gateway: { controlUi: { enabled: false } }, logging: { level: "info" } },
      createdAt: new Date().toISOString(),
    };
    const reference = { id: configuration.id, namespaceId: owner.id };
    const configurationName = kubernetesConfigurationName(configuration.id);
    assert.deepEqual(await configurationDriver.create(configuration), configuration);
    assert.equal(
      (await resource("configmap", configurationName, existingName)).metadata.namespace,
      existingName,
    );
    assert.deepEqual(await configurationDriver.read(reference), configuration);
    const updatedConfiguration = {
      ...configuration,
      generation: 2,
      values: { ...configuration.values, logging: { level: "debug" } },
    };
    assert.deepEqual(await configurationDriver.update(updatedConfiguration), updatedConfiguration);
    assert.deepEqual(await configurationDriver.read(reference), updatedConfiguration);
    await configurationDriver.delete(reference);
    assert.equal(await missing("configmap", configurationName, existingName), true);

    // Dedicated workloads and their Agent-owned shared drive must remain inside the exact tenant.
    const agentId = `agt_${randomUUID()}`;
    const candidate = revision(driver, readyOwner, agentId, 1);
    await waitFor("discovered Agent gateway and immutable revision to become ready", async () => {
      const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
      assert.equal(observation.namespaceId, owner.id);
      return observation.ready ? observation : undefined;
    });
    const gateway = await assertReadyGateway(existingName, agentId, owner.id, candidate);
    const workload = await resource("deployment", revisionName(candidate), existingName);
    const sharedClaim = await assertSharedWorkspaceClaim(existingName, owner.id, agentId);
    for (const deployment of [gateway, workload]) {
      assert.deepEqual(
        deployment.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
        {
          name: "openclaw-workspace",
          persistentVolumeClaim: { claimName: sharedClaim.metadata.name },
        },
      );
    }
    await driver.stopRevision(candidate);
    assert.equal(await missing("deployment", revisionName(candidate), existingName), true);
    assert.equal(await missing("deployment", gatewayName(agentId), existingName), true);
    assert.deepEqual(
      (await resources("pods", existingName)).filter(
        ({ metadata }) =>
          metadata.labels?.["openclaw.dev/agent"] === agentId &&
          metadata.labels?.["openclaw.dev/revision"] === candidate.id,
      ),
      [],
      "stop must not return while an exact revision Pod can still execute",
    );
    assert.equal(
      (await resource("persistentvolumeclaim", sharedClaim.metadata.name, existingName)).metadata
        .uid,
      sharedClaim.metadata.uid,
      "stop must preserve the Agent-owned shared workspace claim",
    );

    // Namespace deletion is legal only for an owner with no Agents or Configurations.
    await createExistingNamespace(cleanupName);
    await grantTenantAccess(cleanupName);
    await waitFor("empty external tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(cleanupOwner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const originalCleanupNamespace = await resource("namespace", cleanupName);
    const originalRoleBinding = await resource("rolebinding", "openclaw-controller", cleanupName);
    for (const kind of ["configmap", "secret"]) {
      await kubectl(
        "create",
        kind,
        ...(kind === "secret" ? ["generic"] : []),
        "operator-sentinel",
        "--namespace",
        cleanupName,
        "--from-literal=owner=operator",
      );
    }
    const originalOperatorConfigMap = await resource("configmap", "operator-sentinel", cleanupName);
    const originalOperatorSecret = await resource("secret", "operator-sentinel", cleanupName);

    // Valid deletion removes fixed OCC infrastructure without touching the operator's namespace.
    const deletingOwner = { ...cleanupOwner, status: "deleting" };
    await waitFor(
      "empty tenant infrastructure to be deleted without deleting its namespace",
      async () => {
        const observation = await driver.deleteNamespace(deletingOwner);
        assert.notEqual(observation.failure, "permanent");
        return observation.namespaceDeleted ? observation : undefined;
      },
    );
    for (const kind of ["networkpolicies", "resourcequotas", "limitranges"]) {
      assert.deepEqual(await resources(kind, cleanupName), []);
    }
    const preservedNamespace = await resource("namespace", cleanupName);
    assert.equal(preservedNamespace.metadata.uid, originalCleanupNamespace.metadata.uid);
    assert.deepEqual(preservedNamespace.metadata.labels, originalCleanupNamespace.metadata.labels);
    assert.deepEqual(
      preservedNamespace.metadata.annotations,
      originalCleanupNamespace.metadata.annotations,
    );
    assert.equal(
      (await resource("rolebinding", "openclaw-controller", cleanupName)).metadata.uid,
      originalRoleBinding.metadata.uid,
    );
    assert.equal(
      (await resource("configmap", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorConfigMap.metadata.uid,
    );
    assert.equal(
      (await resource("secret", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorSecret.metadata.uid,
    );
    assert.deepEqual(await driver.deleteNamespace(deletingOwner), {
      namespaceId: cleanupOwner.id,
      namespaceDeleted: true,
    });
  },
);

test(
  "authenticated PostgreSQL OCC API and worker deploy real Agent-owned gateways and revisions",
  { ...requiresKubernetesAndPostgres, timeout: 360_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const database = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname),
      "the real-cluster end-to-end test requires a loopback PostgreSQL instance",
    );
    assert.match(
      database.pathname,
      /^\/openclaw_k8s_[a-z0-9_]+$/,
      "refusing to modify a database that is not explicitly dedicated to disposable Kubernetes integration",
    );

    const [
      { default: pg },
      { PostgresPlatformState },
      { composePostgresDevelopment },
      { loadInstallationConfiguration },
      { createControllerWorker },
      { authenticatedHeaders, signInToControllerApp },
    ] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../apps/controller/src/composition/development-postgres.ts"),
      import("../../apps/controller/src/composition/installation-config.ts"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/auth-session.mjs"),
    ]);

    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const state = new PostgresPlatformState(observerPool);
    const previous = await state.loadInstallation();
    if (previous !== undefined) {
      assert.equal(
        previous.name,
        "OpenClaw Kubernetes integration",
        "refusing to alter a preexisting database Installation not owned by this test",
      );
    }

    const { kubernetesNamespaceName } = await import(driverPath);
    const { kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const configuration = createInstallationDriverConfiguration();
    configuration.drivers.compute.configuration = fixtureComputeConfiguration();
    for (const capability of ["configuration", "secret"]) {
      configuration.drivers[capability].configuration.authentication = {
        mode: "kubeconfig",
        kubeconfigPath,
        context: kubernetesContext,
      };
    }
    const drivers = await loadInstallationConfiguration({
      mode: "development",
      environment: {},
      startupConfiguration: { configuration, logging: { level: "info" } },
    });
    assert.ok(drivers);
    const driver = drivers.computeDriver;
    const adminCredentials = {
      email: "admin-kubernetes-integration@example.test",
      password: "kubernetes-integration-admin-password",
    };
    const namespaceIds = [];
    const placements = new Map();
    const existingName = `oce-api-existing-${hash(randomUUID())}`;
    let app;
    let worker;
    let workerPool;
    context.after(async () => {
      if (worker !== undefined) {
        await worker.stop();
      } else if (workerPool !== undefined) {
        await workerPool.end();
      }
      if (app !== undefined) {
        await app.close();
      }
      await observerPool.end();
      await Promise.all(
        [...new Set([existingName, ...placements.values()])].map((name) =>
          kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=true"),
        ),
      );
    });

    const authSecret = "kubernetes-integration-auth-secret-32-bytes";
    const authBaseURL = "http://127.0.0.1";
    if (previous === undefined) {
      await ensureDevelopmentBootstrap(context, {
        databaseUrl,
        email: adminCredentials.email,
        password: adminCredentials.password,
        authSecret,
        authBaseURL,
        installationName: "OpenClaw Kubernetes integration",
      });
    }

    app = await composePostgresDevelopment(
      {
        mode: "development",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
      },
      drivers,
    );
    const session = await signInToControllerApp(app, adminCredentials);

    async function request(method, url, payload, options = {}) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(options.session === false ? {} : authenticatedHeaders(options.session ?? session)),
          ...options.headers,
          host: "127.0.0.1",
        },
        ...(payload === undefined ? {} : { payload }),
      });
      return { status: response.statusCode, ...response.json() };
    }

    async function startWorker() {
      workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
      worker = createControllerWorker({
        pool: workerPool,
        drivers,
        pollIntervalMs: 25,
        leaseDurationMs: 30_000,
        maxAttempts: 20,
        emit: () => {},
      });
      await worker.start();
    }

    // External consent and restricted security can be prepared before its platform ID exists.
    await kubectl("create", "namespace", existingName);
    await kubectl(
      "label",
      "namespace",
      existingName,
      "app.kubernetes.io/managed-by=Helm",
      "pod-security.kubernetes.io/enforce=restricted",
      "pod-security.kubernetes.io/audit=restricted",
      "pod-security.kubernetes.io/warn=restricted",
    );
    await kubectl(
      "annotate",
      "namespace",
      existingName,
      "openclaw.dev/namespace-lifecycle=external",
    );
    const unclaimedExistingNamespace = await resource("namespace", existingName);
    assert.equal(
      Object.hasOwn(unclaimedExistingNamespace.metadata.labels, "openclaw.dev/namespace"),
      false,
    );
    assert.equal(
      Object.hasOwn(unclaimedExistingNamespace.metadata.annotations, "openclaw.dev/namespace-id"),
      false,
    );

    // Keep the shared worker running throughout Namespace creation and external namespace adoption.
    await startWorker();
    const unauthorized = await request(
      "POST",
      "/namespaces",
      { name: "unauthorized" },
      { session: false, headers: { authorization: "Bearer denied" } },
    );
    assert.ok([401, 403].includes(unauthorized.status));

    for (const label of ["primary", "secondary"]) {
      const created = await request("POST", "/namespaces", {
        name: `kubernetes-${label}-${randomUUID()}`,
      });
      assert.equal(created.status, 201);
      namespaceIds.push(created.data.id);
      placements.set(created.data.id, kubernetesNamespaceName(created.data.id));
    }

    const adopted = await request("POST", "/namespaces", {
      name: `kubernetes-adopted-${randomUUID()}`,
      existingNamespace: existingName,
    });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.error));
    assert.equal(adopted.data.existingNamespace, existingName);
    namespaceIds.push(adopted.data.id);
    placements.set(adopted.data.id, existingName);

    await Promise.all(
      namespaceIds.map((id) =>
        waitFor(`API Namespace ${id} to become ready`, async () => {
          const current = await request("GET", `/namespaces/${id}`);
          assert.equal(current.status, 200);
          return current.data.status === "ready" ? current.data : undefined;
        }),
      ),
    );
    for (const id of namespaceIds) {
      assert.equal(
        (await resources("deployments", placements.get(id))).length,
        0,
        "a ready Namespace must not have a gateway until an Agent is deployed",
      );
    }
    const adoptedBacking = await resource("namespace", existingName);
    assert.equal(adoptedBacking.metadata.uid, unclaimedExistingNamespace.metadata.uid);
    assert.equal(adoptedBacking.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(adoptedBacking.metadata.labels["openclaw.dev/namespace"], adopted.data.id);
    assert.equal(adoptedBacking.metadata.annotations["openclaw.dev/namespace-id"], adopted.data.id);
    assert.equal(
      adoptedBacking.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(adopted.data.id)), true);
    assert.equal(
      (await state.read((view) => view.namespaces.findNamespace(adopted.data.id)))
        .existingNamespace,
      existingName,
      "the real worker must recover explicit namespace selection from PostgreSQL",
    );

    async function createAgent(namespaceId, label) {
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        kind: "agent",
        values: {
          gateway: { controlUi: { enabled: false } },
          logging: { level: "info" },
          agents: {
            defaults: {
              model: "codex/gpt-4.1",
              models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
            },
          },
        },
      });
      assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
      const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
        name: `${label} fixture model key`,
        value: `fixture-only-${randomUUID()}`,
      });
      assert.equal(secret.status, 201, JSON.stringify(secret.error));
      const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: `${label}-${randomUUID()}`,
        configurationId: configuration.data.id,
        executionMode: "dedicated",
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId, id: secret.data.id },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.error));
      assert.equal(Object.hasOwn(created.data, "servicePrincipalId"), false);
      await grantAgentSecretOperate(observerPool, created.data, secret.data.id);
      return created.data;
    }

    async function deploy(namespaceId, agentId) {
      const result = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
      assert.equal(result.status, 202, JSON.stringify(result.error));
      assert.deepEqual(result.data.compute, {
        id: driver.id,
        implementation: driver.implementation,
      });
      assert.equal(Object.hasOwn(result.data, "servicePrincipalId"), false);
      return result.data;
    }

    async function waitForActive(namespaceId, agentId, revisionId) {
      return waitFor(`Agent ${agentId} to activate revision ${revisionId}`, async () => {
        const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === revisionId ? current.data : undefined;
      });
    }

    const first = await createAgent(namespaceIds[0], "first");
    const second = await createAgent(namespaceIds[0], "second");
    const separateTenant = await createAgent(namespaceIds[1], "separate-tenant");
    const adoptedTenant = await createAgent(namespaceIds[2], "adopted-tenant");
    const admitted = await Promise.all([
      deploy(namespaceIds[0], first.id),
      deploy(namespaceIds[0], second.id),
      deploy(namespaceIds[1], separateTenant.id),
      deploy(namespaceIds[2], adoptedTenant.id),
    ]);

    await Promise.all(
      [
        [namespaceIds[0], first, admitted[0]],
        [namespaceIds[0], second, admitted[1]],
        [namespaceIds[1], separateTenant, admitted[2]],
        [namespaceIds[2], adoptedTenant, admitted[3]],
      ].map(async ([namespaceId, agent, candidate]) => {
        await waitForActive(namespaceId, agent.id, candidate.id);
        const placement = placements.get(namespaceId);
        await assertReadyGateway(placement, agent.id, namespaceId, candidate);
        const deployment = await resource("deployment", revisionName(candidate), placement);
        assert.equal(deployment.spec.template.spec.serviceAccountName, agentName(agent.id));
        const storedAgent = await state.read((view) =>
          view.agents.findAgent(namespaceId, agent.id),
        );
        const storedRevision = await state.read((view) =>
          view.revisions.findRevision(namespaceId, agent.id, candidate.id),
        );
        assert.equal(storedAgent.servicePrincipalId, `service-agent-${agent.id}`);
        assert.equal(storedRevision.servicePrincipalId, storedAgent.servicePrincipalId);
        const account = await resource("serviceaccount", agentName(agent.id), placement);
        assert.equal(
          account.metadata.annotations["openclaw.dev/service-principal-id"],
          storedAgent.servicePrincipalId,
        );
        await assertNonservingAgentService(placement, agent.id);
      }),
    );
    const adoptedWorkspace = await assertSharedWorkspaceClaim(
      existingName,
      adopted.data.id,
      adoptedTenant.id,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      existingName,
    );

    const retainedFile = `stop-state-${randomUUID()}.txt`;
    const retainedValue = `retained-${randomUUID()}`;
    const adoptedRevisionPod = await waitFor(
      "adopted Agent revision Pod to become ready",
      async () =>
        (await resources("pods", existingName)).find(
          ({ metadata, status }) =>
            metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id &&
            metadata.labels?.["openclaw.dev/revision"] === admitted[3].id &&
            status.conditions?.some(
              ({ type, status: conditionStatus }) => type === "Ready" && conditionStatus === "True",
            ),
        ),
    );
    await kubectl(
      "exec",
      adoptedRevisionPod.metadata.name,
      "--namespace",
      existingName,
      "--",
      "node",
      "-e",
      `require('node:fs').writeFileSync('/home/node/workspace/${retainedFile}', ${JSON.stringify(retainedValue)})`,
    );
    const stopped = await request(
      "POST",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}/stop`,
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
    assert.equal(stopped.data.desiredRuntimeState, "stopped");
    await waitFor("the stopped Agent pointer and real runtime to be cleared", async () => {
      const current = await request(
        "GET",
        `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
      );
      assert.equal(current.status, 200);
      if (current.data.activeRevisionId !== undefined) {
        return undefined;
      }
      if (!(await missing("deployment", revisionName(admitted[3]), existingName))) {
        return undefined;
      }
      if (!(await missing("deployment", gatewayName(adoptedTenant.id), existingName))) {
        return undefined;
      }
      const ownedPods = (await resources("pods", existingName)).filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id,
      );
      return ownedPods.length === 0 ? current.data : undefined;
    });
    assert.equal(
      (await resource("persistentvolumeclaim", adoptedWorkspace.metadata.name, existingName))
        .metadata.uid,
      adoptedWorkspace.metadata.uid,
      "API stop must retain the exact Agent workspace claim",
    );
    assert.equal(
      (
        await state.read((view) =>
          view.revisions.findRevision(adopted.data.id, adoptedTenant.id, admitted[3].id),
        )
      ).id,
      admitted[3].id,
      "API stop must retain immutable revision history",
    );

    const restarted = await deploy(adopted.data.id, adoptedTenant.id);
    assert.notEqual(restarted.id, admitted[3].id);
    await waitForActive(adopted.data.id, adoptedTenant.id, restarted.id);
    await assertReadyGateway(existingName, adoptedTenant.id, adopted.data.id, restarted);
    const restartedPod = await waitFor("redeployed Agent revision Pod to become ready", async () =>
      (await resources("pods", existingName)).find(
        ({ metadata, status }) =>
          metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id &&
          metadata.labels?.["openclaw.dev/revision"] === restarted.id &&
          status.conditions?.some(
            ({ type, status: conditionStatus }) => type === "Ready" && conditionStatus === "True",
          ),
      ),
    );
    assert.equal(
      await kubectl(
        "exec",
        restartedPod.metadata.name,
        "--namespace",
        existingName,
        "--",
        "node",
        "-e",
        `process.stdout.write(require('node:fs').readFileSync('/home/node/workspace/${retainedFile}', 'utf8'))`,
      ),
      retainedValue,
      "redeployment must mount the exact persistent data retained by stop",
    );
    assert.equal(
      (await assertSharedWorkspaceClaim(existingName, adopted.data.id, adoptedTenant.id)).metadata
        .uid,
      adoptedWorkspace.metadata.uid,
    );

    await worker.stop();
    worker = undefined;
    workerPool = undefined;
    const replacement = await deploy(namespaceIds[0], first.id);
    await startWorker();
    await waitForActive(namespaceIds[0], first.id, replacement.id);
    const placement = kubernetesNamespaceName(namespaceIds[0]);
    await waitFor(`old revision deployment ${revisionName(admitted[0])} to be deleted`, () =>
      missing("deployment", revisionName(admitted[0]), placement),
    );
    await resource("deployment", revisionName(replacement), placement);
    await resource("deployment", revisionName(admitted[1]), placement);
    await resource("serviceaccount", agentName(first.id), placement);
    await assertReadyGateway(placement, first.id, namespaceIds[0]);
    await assertReadyGateway(placement, second.id, namespaceIds[0]);
    assert.equal(
      (await resources("deployments", placement)).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      2,
      "worker restart and replacement revisions must preserve one gateway for each Agent",
    );
  },
);
