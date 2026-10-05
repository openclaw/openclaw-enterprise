import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import {
  assertProbeDenied,
  createKubernetesFixtureHarnessAuth,
  inlineProbeCommand,
  retryKubectlRead,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

export const execute = promisify(execFile);
export const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
export const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
export const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
export const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requested = [kubeconfigPath, kubernetesContext, fixtureImage].some(Boolean);
export const requiresKubernetes = {
  skip: requested
    ? false
    : "Set OCC_TEST_KUBERNETES_KUBECONFIG, OCC_TEST_KUBERNETES_CONTEXT to a k3d-* context, and OCC_TEST_KUBERNETES_IMAGE to run real Kubernetes integration tests.",
};
export const requiresKubernetesAndPostgres = {
  skip: !requested
    ? requiresKubernetes.skip
    : databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a dedicated openclaw_k8s_* database to run Kubernetes API and worker integration.",
};
export const { kubernetesGatewayNamespaceName } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");

export const driverPath = "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
const configurationIds = new Map();
export const probeSource = await readFile(
  new URL("../fixtures/kubernetes/probe.mjs", import.meta.url),
  "utf8",
);
const harnessAuthentication = new Map();
const sharedWorkspaceSize = "40Gi";

export function hash(value, length = 12) {
  return sha256Hex(value, length);
}

export async function kubectl(...args) {
  const { stdout } = await execute(
    "kubectl",
    ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

// A get, or an exec that only reads, survives a dropped API server or kubelet
// stream (finding 308: an exec into a Ready gateway Pod failed with
// "error: EOF"). Commands that change state stay single-shot.
export function kubectlRead(...args) {
  return retryKubectlRead(() => kubectl(...args));
}

export async function resource(kind, name, namespace) {
  const args = ["get", kind, name, "-o", "json"];
  if (namespace !== undefined) {
    args.push("--namespace", namespace);
  }
  return JSON.parse(await kubectlRead(...args));
}

export async function resources(kind, namespace) {
  return JSON.parse(await kubectlRead("get", kind, "--namespace", namespace, "-o", "json")).items;
}

export async function missing(kind, name, namespace) {
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

export async function waitFor(description, operation, timeoutMs = 120_000) {
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

export function provisioningRequestBody({
  modelSecretRef,
  slackBotSecretRef,
  authMethod = "api_key",
}) {
  const model = "codex/gpt-6-astra";
  return {
    requestId: `req_${randomUUID()}`,
    name: `Kubernetes provisioned ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: {
        gateway: { controlUi: { enabled: false } },
        agents: {
          defaults: {
            model,
            models: { [model]: { agentRuntime: { id: "codex" } } },
          },
        },
        channels: {
          slack: {
            enabled: true,
            mode: "http",
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          },
        },
      },
      secretBindings: {
        SLACK_BOT_TOKEN: {
          source: slackBotSecretRef,
          delivery: { type: "env" },
        },
      },
    },
    harnessAuth: {
      method: authMethod,
      source: modelSecretRef,
    },
  };
}

function runtimeDrivers({ computeDriver, configurationDriver, secretDriver }) {
  return {
    installation: {
      occ: { cluster: "kubernetes-agent-provisioning" },
      logging: {},
      backend: [],
      drivers: {
        iam: { id: "native-iam", implementation: "native", configuration: {} },
        compute: {
          id: computeDriver.id,
          implementation: computeDriver.implementation,
          configuration: {},
        },
        configuration: {
          id: configurationDriver.id,
          implementation: configurationDriver.implementation,
          configuration: {},
        },
        secret: {
          id: secretDriver.id,
          implementation: secretDriver.implementation,
          configuration: {},
        },
      },
    },
    computeDriver,
    configurationDriver,
    secretDriver,
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

async function privateBootstrapDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-provisioning-bootstrap-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function createProvisioningApiFixture(context, computeDriver, authentication) {
  // Exercise real admission with Kubernetes Secrets; fixture credentials never reach Slack.
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === "https://slack.com/api/auth.test") {
      assert.match(init.headers.authorization, /^Bearer xoxb-/);
      return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
    }
    return originalFetch(url, init);
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  let workerPool;
  const state = new PostgresPlatformState(pool);
  const existingInstallation = await state.loadInstallation();
  const authSecret = "kubernetes-integration-auth-secret-32-bytes";
  const authBaseURL = "http://127.0.0.1";
  const credentials = {
    email: "admin-kubernetes-integration@example.test",
    password: "kubernetes-integration-admin-password",
  };
  if (existingInstallation === undefined) {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      directory: await privateBootstrapDirectory(context),
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL,
      installationName: "OpenClaw Kubernetes integration",
      environment: { PATH: process.env.PATH },
    });
  }
  const bootstrapNamespaceIds = (await state.read((view) => view.namespaces.listNamespaces())).map(
    ({ id }) => id,
  );
  const configurationDriver = new KubernetesConfigurationDriver(
    { authentication },
    { id: "configuration-kubernetes-provisioning" },
  );
  const secretDriver = new KubernetesSecretDriver(
    { authentication },
    { id: "secret-kubernetes-provisioning" },
  );
  let worker;
  const drivers = {
    ...runtimeDrivers({ computeDriver, configurationDriver, secretDriver }),
    pluginDriver: new CodexPluginDriver(),
  };
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
    },
    drivers,
  );
  const session = await signInToControllerApp(app, credentials);
  context.after(async () => {
    await stopWorker();
    await app.close?.();
    if (workerPool !== undefined) {
      await workerPool.end();
      workerPool = undefined;
    }
    await pool.end();
  });

  async function request(method, path, body) {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...authenticatedHeaders(session),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin: "http://127.0.0.1" }),
        host: "127.0.0.1",
      },
      remoteAddress: "127.0.0.1",
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const text = response.body;
    const payload = text.length === 0 ? undefined : JSON.parse(text);
    return {
      status: response.statusCode,
      body: payload,
      data: payload?.data,
      error: payload?.error,
    };
  }

  async function startWorker() {
    assert.equal(worker, undefined, "the fixture worker is already running");
    assert.equal(workerPool, undefined, "the fixture worker pool is already open");
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    worker = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 25,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      emit: () => {},
    });
    await worker.start();
  }

  async function stopWorker() {
    if (worker === undefined) {
      return;
    }
    const current = worker;
    worker = undefined;
    workerPool = undefined;
    await current.stop();
  }

  return {
    bootstrapNamespaceIds,
    async readWork(idempotencyKey) {
      const result = await pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      return result.rows[0];
    },
    request,
    startWorker,
    stopWorker,
  };
}

export async function assertKubernetesFixtureAvailable() {
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
}

export function namespace(label) {
  const id = `ns_${label}_${randomUUID()}`;
  return {
    id,
    name: label,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

export async function provisionFixtureAuth(owner) {
  const auth = await createKubernetesFixtureHarnessAuth({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    namespaceId: owner.id,
  });
  harnessAuthentication.set(owner.id, auth);
}

export function revisionContext(candidate) {
  const auth = harnessAuthentication.get(candidate.namespaceId);
  assert.ok(auth, "the ready Namespace must have its fixture authentication provisioned");
  return auth.context;
}

export function revision(driver, owner, agentId, number) {
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

export function agentName(agentId) {
  return `agent-${hash(agentId)}`;
}

export function gatewayName(agentId) {
  return `gateway-${hash(agentId)}`;
}

export function harnessWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

export function revisionName(candidate) {
  return `${agentName(candidate.agentId)}-rev-${hash(candidate.id)}`;
}

export async function assertReadyGateway(namespaceName, agentId, namespaceId, snapshot) {
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
  const expectedNativeDocument =
    snapshot === undefined
      ? undefined
      : {
          ...snapshot.configuration,
          gateway: {
            ...snapshot.configuration.gateway,
            trustedProxies: ["127.0.0.1/32"],
            allowRealIpFallback: true,
            auth: {
              ...snapshot.configuration.gateway?.auth,
              mode: "trusted-proxy",
              trustedProxy: {
                userHeader: "x-occ-identity",
                allowUsers: ["occ-workspace-files"],
              },
              identityScopes: { "occ-workspace-files": ["operator.admin"] },
            },
          },
        };
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
      expectedNativeDocument,
      "the immutable native document must preserve revision values and render the fixture Installation's gateway authentication",
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

  const gatewayPods = await waitFor(`Agent ${agentId} to own exactly one gateway Pod`, async () => {
    const owned = (await resources("pods", namespaceName)).filter(
      ({ metadata }) =>
        metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        metadata.labels?.["app.kubernetes.io/name"] === name,
    );
    return owned.length === 1 ? owned : undefined;
  });
  assert.equal(
    gatewayPods[0].status.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    ),
    true,
    "the Agent's single gateway Pod must be ready",
  );
  if (snapshot !== undefined) {
    const mountedDocument = await kubectlRead(
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
      expectedNativeDocument,
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

export async function assertHarnessWorkspaceClaim(
  namespaceName,
  namespaceId,
  agentId,
  expectedUid,
) {
  const claim = await resource(
    "persistentvolumeclaim",
    harnessWorkspaceClaimName(agentId),
    namespaceName,
  );
  assert.equal(claim.metadata.namespace, namespaceName);
  assert.equal(claim.metadata.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
  assert.equal(claim.metadata.labels["openclaw.dev/namespace"], namespaceId);
  assert.equal(claim.metadata.labels["openclaw.dev/agent"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(claim.spec.resources.requests.storage, sharedWorkspaceSize);
  assert.equal(claim.spec.storageClassName, "local-path");
  assert.equal(claim.status.phase, "Bound");
  assert.equal(claim.status.capacity.storage, sharedWorkspaceSize);
  if (expectedUid !== undefined) {
    assert.equal(
      claim.metadata.uid,
      expectedUid,
      "Agent-owned Harness workspace claim must be reused",
    );
  }
  return claim;
}

export async function assertAgentServiceEndpointCount(name, agentId, expected, message) {
  const observe = async () => {
    const service = await resource("service", agentName(agentId), name);
    const slices = await resources("endpointslices", name);
    const ready = slices.flatMap((slice) =>
      slice.metadata.labels?.["kubernetes.io/service-name"] === service.metadata.name
        ? (slice.endpoints ?? []).filter((endpoint) => endpoint.conditions?.ready === true)
        : [],
    );
    return { service, ready };
  };
  if (expected === 0) {
    const { service, ready } = await observe();
    assert.equal(ready.length, expected, message);
    return service;
  }
  return waitFor(message, async () => {
    const { service, ready } = await observe();
    return ready.length === expected ? service : undefined;
  });
}

export function fixtureComputeConfiguration(overrides = {}) {
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
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
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

export async function createDriver(overrides = {}, selection = {}) {
  const { KubernetesComputeDriver, kubernetesNamespaceName } = await import(driverPath);
  return {
    driver: new KubernetesComputeDriver(fixtureComputeConfiguration(overrides), selection),
    kubernetesNamespaceName,
  };
}

export async function workloadPod(namespaceName, selector) {
  const pods = JSON.parse(
    await kubectlRead(
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

function probeArguments(namespaceName, podName, operation, target, port) {
  return [
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
  ];
}

// Every probe only reads, so a dropped exec stream is retried. A probe that
// ran and failed (including a denial) is thrown to the caller.
export async function probe(namespaceName, podName, operation, target, port) {
  return kubectlRead(...probeArguments(namespaceName, podName, operation, target, port));
}

// Passes only when the probe itself reports a refused, unreachable, or
// unanswered connection (finding 334): a dropped exec stream, a missing probe
// script, or a DNS failure is not proof that a NetworkPolicy denied traffic.
export async function assertDeniedTraffic(
  description,
  namespaceName,
  podName,
  operation,
  target,
  port,
) {
  await assertExecDenied(
    description,
    probeArguments(namespaceName, podName, operation, target, port),
  );
}

// Runs one `kubectl exec` of the probe that a NetworkPolicy must block.
export async function assertExecDenied(description, execArguments) {
  try {
    await assertProbeDenied(description, () => kubectl(...execArguments));
  } catch (error) {
    if (error.code === "ERR_ASSERTION") {
      error.openclawCiDiagnostic = { kind: "network-policy", stage: description };
    }
    throw error;
  }
}

export async function createDnsTrafficFixture(context, peer) {
  const namespace = peer.namespace;
  const name = `dns-traffic-${hash(randomUUID())}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-dns-traffic-"));
  const manifestPath = join(directory, "resources.json");
  const image = (await resource("deployment", "coredns", "kube-system")).spec.template.spec
    .containers[0].image;
  const dnsService = await resource("service", "kube-dns", namespace);
  assert.equal(dnsService.spec.publishNotReadyAddresses ?? false, false);
  const items = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, namespace },
      data: {
        Corefile: [5353, 5354]
          .map(
            (port) => `.:${port} {\n  hosts {\n    192.0.2.53 openshift-dns.example.test\n  }\n}`,
          )
          .join("\n"),
      },
    },
    ...["selected", "unselected", "control"].map((role) => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `${name}-${role}`,
        namespace,
        labels: role === "selected" ? peer.podLabels : { "app.kubernetes.io/name": name },
      },
      spec: {
        automountServiceAccountToken: false,
        // The control container runs `node` as PID 1, which ignores SIGTERM, so cleanup
        // would otherwise wait out the default 30 s grace period.
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        ...(role === "control"
          ? {}
          : {
              // Keep these selected DNS peers out of the cluster DNS Service's ready endpoints.
              // Their container readiness still verifies that the DNS listener is available.
              readinessGates: [{ conditionType: "openclaw.dev/dns-fixture" }],
              volumes: [{ name: "config", configMap: { name } }],
            }),
        containers: [
          {
            name: role,
            image: role === "control" ? fixtureImage : image,
            command:
              role === "control"
                ? ["node", "-e", "setInterval(() => {}, 1000)"]
                : ["/coredns", "-conf", "/config/Corefile"],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: {
                drop: ["ALL"],
                // CoreDNS's binary has this file capability even when listening above port 1024.
                ...(role === "control" ? {} : { add: ["NET_BIND_SERVICE"] }),
              },
            },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
            ...(role === "control"
              ? {}
              : {
                  volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
                  readinessProbe: { tcpSocket: { port: 5353 }, periodSeconds: 1 },
                }),
          },
        ],
      },
    })),
  ];
  await writeFile(manifestPath, JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  context.after(async () => {
    try {
      await kubectl("delete", "-f", manifestPath, "--ignore-not-found=true", "--wait=true");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await kubectl("create", "-f", manifestPath);
  const [selected, unselected, control] = await Promise.all(
    ["selected", "unselected", "control"].map((role) =>
      waitFor(`DNS ${role} fixture listener`, async () => {
        const pod = await resource("pod", `${name}-${role}`, namespace);
        return pod.status.podIP !== undefined && pod.status.containerStatuses?.[0].ready
          ? pod
          : undefined;
      }),
    ),
  );
  const queryArguments = (source, target, protocol, port) => [
    "exec",
    source.metadata.name,
    "-n",
    source.metadata.namespace,
    "--",
    ...inlineProbeCommand(
      probeSource,
      `dns-${protocol}`,
      target.status.podIP,
      port,
      "openshift-dns.example.test",
    ),
  ];
  const query = (source, target, protocol, port) =>
    kubectlRead(...queryArguments(source, target, protocol, port));
  const assertQueryDenied = (description, source, target, protocol, port) =>
    assertProbeDenied(description, () =>
      kubectl(...queryArguments(source, target, protocol, port)),
    );
  return { selected, unselected, control, query, assertQueryDenied };
}

export async function assertExplicitNetworkProfile(context, namespaceName, sourcePod) {
  const profileLabel = "openclaw.dev/network-profile";
  assert.equal(sourcePod.metadata.labels[profileLabel], "broad-egress-v1");
  const name = `network-profile-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-network-profile-"));
  const manifestPath = join(directory, "pod.json");
  // Preserve the rendered role/Agent labels and security settings. A unique app
  // name keeps this probe outside the workload's ReplicaSet and Service selectors.
  const spec = structuredClone(sourcePod.spec);
  delete spec.nodeName;
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: namespaceName,
        labels: { ...sourcePod.metadata.labels, "app.kubernetes.io/name": name },
      },
      spec,
    }),
  );
  context.after(async () => {
    await kubectl("delete", "pod", name, "--namespace", namespaceName, "--ignore-not-found=true");
    await rm(directory, { recursive: true, force: true });
  });
  try {
    await kubectl("create", "-f", manifestPath);
    await kubectl(
      "wait",
      "--namespace",
      namespaceName,
      "--for=condition=Ready",
      `pod/${name}`,
      "--timeout=120s",
    );
    const dnsOutcome = async () =>
      JSON.parse(
        await kubectl(
          "exec",
          name,
          "--namespace",
          namespaceName,
          "--",
          "node",
          "-e",
          `
        const dns = require("node:dns");
        const timer = setTimeout(() => { console.log(JSON.stringify({ resolved: false, reason: "timeout" })); process.exit(0); }, 2000);
        dns.resolve4("kubernetes.default.svc.cluster.local", (error, addresses) => {
          clearTimeout(timer);
          if (error) { console.log(JSON.stringify({ resolved: false, reason: error.code })); }
          else { console.log(JSON.stringify({ resolved: true, addresses })); }
        });
      `,
        ),
      );
    const assertAllowed = () =>
      waitFor("explicit broad profile DNS access", async () => (await dnsOutcome()).resolved);
    await assertAllowed();
    for (const profile of [undefined, "", "unrecognized-v1"]) {
      await kubectl(
        "label",
        "pod",
        name,
        "--namespace",
        namespaceName,
        profile === undefined ? `${profileLabel}-` : `${profileLabel}=${profile}`,
        "--overwrite",
      );
      // Policy reconciliation is asynchronous. Require a real DNS denial between
      // successful controls on the same Pod so unavailable DNS cannot satisfy it.
      const denied = await waitFor(`DNS denial for profile ${String(profile)}`, async () => {
        const outcome = await dnsOutcome();
        return outcome.resolved ? undefined : outcome;
      });
      assert.ok(
        ["timeout", "ETIMEOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(denied.reason),
        JSON.stringify(denied),
      );
      await kubectl(
        "label",
        "pod",
        name,
        "--namespace",
        namespaceName,
        `${profileLabel}=broad-egress-v1`,
        "--overwrite",
      );
      await assertAllowed();
    }
  } finally {
    await kubectl("delete", "pod", name, "--namespace", namespaceName, "--ignore-not-found=true");
    await rm(directory, { recursive: true, force: true });
  }
}

export async function authorized(namespaceName, actor, verb, kind) {
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

export async function createScopedController(context, installationId, platformNamespace) {
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
          resources: ["secrets"],
          verbs: ["get", "create", "update", "delete"],
        },
      },
    ]),
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
          verbs: ["get", "list", "watch", "patch"],
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
