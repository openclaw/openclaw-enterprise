import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  admitLoggingConfiguration,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/index.ts";
import {
  KubernetesConfigurationDriver,
  kubernetesConfigurationName,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import {
  createKubernetesFixtureHarnessAuth,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const execute = promisify(execFile);
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
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
const { kubernetesGatewayNamespaceName } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");

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

function provisioningRequestBody({ modelSecretRef, slackBotSecretRef, authMethod = "api_key" }) {
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

async function createProvisioningApiFixture(context, computeDriver, authentication) {
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

function harnessWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

function revisionName(candidate) {
  return `${agentName(candidate.agentId)}-rev-${hash(candidate.id)}`;
}

async function assertReadyGateway(namespaceName, agentId, namespaceId, snapshot) {
  if (snapshot?.harness?.mode !== "embedded") {
    const target = kubernetesGatewayNamespaceName(namespaceId);
    assert.notEqual(target, namespaceName, "dedicated Gateway must leave the Harness namespace");
    assert.equal(await missing("deployment", gatewayName(agentId), namespaceName), true);
    namespaceName = target;
  }
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

async function assertHarnessWorkspaceClaim(namespaceName, namespaceId, agentId, expectedUid) {
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

async function assertAgentServiceEndpointCount(name, agentId, expected, message) {
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
      error.openclawCiDiagnostic = { kind: "network-policy", stage: description };
      throw error;
    }
    assert.equal(error.code, 1, `${description} must be denied by enforced NetworkPolicies`);
  }
}

async function createDnsTrafficFixture(context, peer) {
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
  const script = await readFile(
    new URL("../fixtures/kubernetes/probe.mjs", import.meta.url),
    "utf8",
  );
  const query = (source, target, protocol, port) =>
    kubectl(
      "exec",
      source.metadata.name,
      "-n",
      source.metadata.namespace,
      "--",
      "node",
      "--input-type=module",
      "-e",
      script,
      "probe.mjs",
      `dns-${protocol}`,
      target.status.podIP,
      String(port),
      "openshift-dns.example.test",
    );
  return { selected, unselected, control, query };
}

async function assertExplicitNetworkProfile(context, namespaceName, sourcePod) {
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

test(
  "real Kubernetes Compute Driver owns isolated Agent gateways, identities, revisions, and deletion",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
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
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
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
    const gatewayTargets = [first, second, empty].map(({ id }) =>
      kubernetesGatewayNamespaceName(id),
    );
    const foreignName = kubernetesNamespaceName(foreign.id);
    context.after(async () => {
      await Promise.all(
        [...owned, ...gatewayTargets, foreignName].map((name) =>
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
      assert.equal((await driver.ensureNamespace(owner)).namespaceReady, false);
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        kubernetesGatewayNamespaceName(owner.id),
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
          name: harnessWorkspaceClaimName(primaryAgent),
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
        harnessWorkspaceClaimName(primaryAgent),
        owned[0],
      );
      assert.deepEqual(rejectedClaim.spec.accessModes, ["ReadWriteOnce"]);
      assert.equal(rejectedClaim.spec.resources.requests.storage, "1Gi");
    } finally {
      await rm(invalidClaimDirectory, { recursive: true, force: true });
      await kubectl(
        "delete",
        "persistentvolumeclaim",
        harnessWorkspaceClaimName(primaryAgent),
        "--namespace",
        owned[0],
        "--wait=true",
      );
    }

    const gatewayIdentities = new Map();
    const sharedWorkspaceIdentities = new Map();
    for (const candidate of candidates) {
      if (driver.requiresStoppedPredecessors(candidate)) {
        for (const previous of candidates.filter(
          (entry) => entry.agentId === candidate.agentId && entry.revision < candidate.revision,
        )) {
          await driver.stopRevision(previous);
          assert.equal(await missing("deployment", revisionName(previous), owned[0]), true);
        }
      }
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
        assert.notEqual(
          gateway.metadata.uid,
          gatewayIdentities.get(identityKey),
          "exclusive replacement stops the predecessor before creating its successor",
        );
      } else {
        gatewayIdentities.set(identityKey, gateway.metadata.uid);
      }
      const deployment = await resource("deployment", revisionName(candidate), placement);
      const harnessClaim = await assertHarnessWorkspaceClaim(
        placement,
        candidate.namespaceId,
        candidate.agentId,
        sharedWorkspaceIdentities.get(identityKey),
      );
      sharedWorkspaceIdentities.set(identityKey, harnessClaim.metadata.uid);
      assert.equal(
        gateway.spec.template.spec.volumes.some(
          ({ persistentVolumeClaim }) =>
            persistentVolumeClaim?.claimName === harnessClaim.metadata.name,
        ),
        false,
        "Gateway must not mount the Harness workspace claim",
      );
      assert.deepEqual(
        deployment.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
        {
          name: "openclaw-workspace",
          persistentVolumeClaim: { claimName: harnessClaim.metadata.name },
        },
      );
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
      await assertAgentServiceEndpointCount(
        placement,
        candidate.agentId,
        0,
        "an unactivated candidate must not become routable",
      );
    }

    assert.equal(
      (await resources("deployments", gatewayTargets[0])).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      2,
      "two Agents in the same Namespace must own two independent gateway Deployments",
    );
    assert.equal(
      (await resources("deployments", gatewayTargets[1])).filter(
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
      gatewayTargets[0],
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
        gatewayTargets[0],
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
      `app.kubernetes.io/name=${revisionName(secondRevision)}`,
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
      gatewayTargets[0],
      `app.kubernetes.io/name=${gatewayName(primaryAgent)}`,
    );
    const platformProbe = await resource("pod", "platform-probe", platformNamespace);
    assert.ok(firstPod && siblingPod && foreignPod && gatewayPod);
    await assertExplicitNetworkProfile(context, owned[0], firstPod);

    const gatewayUrl = `http://${gatewayName(primaryAgent)}.${gatewayTargets[0]}.svc.cluster.local:8080/readyz`;
    let lastApprovedGatewayError;
    try {
      await waitFor(
        "the approved platform client to reach the exact Agent's owned gateway through Service DNS",
        async () => {
          try {
            // Pod and EndpointSlice readiness can precede cross-Pod Service DNS reachability.
            assert.equal(
              JSON.parse(await probe(platformNamespace, "platform-probe", "http", gatewayUrl))
                .status,
              200,
              "an explicitly approved platform client must reach the exact Agent's owned gateway",
            );
            return true;
          } catch (error) {
            lastApprovedGatewayError = error;
            return false;
          }
        },
        60_000,
      );
    } catch (error) {
      throw lastApprovedGatewayError ?? error;
    }
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
      gatewayTargets[0],
      gatewayPod.metadata.name,
      "tcp",
      firstPod.status.podIP,
      8080,
    );

    const controllerActor = `system:serviceaccount:${platformNamespace}:${controller.account}`;
    for (const target of [owned[0], gatewayTargets[0]]) {
      assert.equal(
        await authorized(target, controllerActor, "get", "secrets"),
        true,
        "the controller needs exact-target access to canonical and delivered Secrets",
      );
      for (const [namespace, pod] of [
        [owned[0], firstPod],
        [gatewayTargets[0], gatewayPod],
      ]) {
        assert.equal(
          await authorized(
            target,
            `system:serviceaccount:${namespace}:${pod.spec.serviceAccountName}`,
            "get",
            "secrets",
          ),
          false,
          "neither Harness nor Gateway identities may read Kubernetes Secrets in either target",
        );
      }
    }

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
      1,
      "only one revision of an Agent may hold its durable workspace",
    );

    const siblingGatewayService = await resource(
      "service",
      gatewayName(secondaryAgent),
      gatewayTargets[0],
    );
    await kubectl(
      "delete",
      "service",
      gatewayName(primaryAgent),
      "--namespace",
      gatewayTargets[0],
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
      (await resource("service", gatewayName(secondaryAgent), gatewayTargets[0])).metadata.uid,
      siblingGatewayService.metadata.uid,
      "repairing one Agent gateway must not replace a sibling Agent's gateway resources",
    );

    await kubectl("create", "namespace", foreignName);
    assert.equal(
      await authorized(foreignName, controllerActor, "get", "serviceaccounts"),
      false,
      "a namespace-only controller cluster grant must not leak namespaced access across tenants",
    );
    assert.equal(
      await authorized(foreignName, controllerActor, "get", "secrets"),
      false,
      "controller Secret access must not extend to a namespace without an explicit grant",
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
    await resource("deployment", revisionName(secondRevision), owned[0]);

    await driver.retireRevision(firstRevision);
    assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
    await assertHarnessWorkspaceClaim(
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
      await missing("persistentvolumeclaim", harnessWorkspaceClaimName(embeddedAgent), owned[0]),
      true,
      "embedded Agents must remain unchanged and create no Harness workspace claim",
    );

    await driver.retireRevision(secondRevision);
    await assertHarnessWorkspaceClaim(
      owned[0],
      first.id,
      primaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${primaryAgent}`),
    );
    // Revision cleanup preserves the Agent workspace; only final Agent deletion removes it.
    await driver.deleteAgentRuntimeCredentials({
      namespace: first,
      agent: { id: primaryAgent, namespaceId: first.id },
    });
    await waitFor(
      `Harness workspace claim ${harnessWorkspaceClaimName(primaryAgent)} to be deleted`,
      () => missing("persistentvolumeclaim", harnessWorkspaceClaimName(primaryAgent), owned[0]),
    );
    await assertHarnessWorkspaceClaim(
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
    assert.equal(await missing("namespace", gatewayTargets[2]), true);
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
        [
          platformNamespace,
          existingName,
          cleanupName,
          duplicateName,
          unclaimedName,
          kubernetesGatewayNamespaceName(owner.id),
          kubernetesGatewayNamespaceName(cleanupOwner.id),
        ].map((name) =>
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

    await driver.ensureNamespace(owner);
    await grantTenantAccess(kubernetesGatewayNamespaceName(owner.id));
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

    // Canonical Configuration stays in the control plane even for an adopted data namespace.
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
      (await resource("configmap", configurationName, kubernetesGatewayNamespaceName(owner.id)))
        .metadata.namespace,
      kubernetesGatewayNamespaceName(owner.id),
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
    assert.equal(
      await missing("configmap", configurationName, kubernetesGatewayNamespaceName(owner.id)),
      true,
    );

    // Dedicated workloads and the Harness workspace must remain inside the exact tenant.
    const agentId = `agt_${randomUUID()}`;
    const candidate = revision(driver, readyOwner, agentId, 1);
    await waitFor("discovered Agent gateway and immutable revision to become ready", async () => {
      const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
      assert.equal(observation.namespaceId, owner.id);
      return observation.ready ? observation : undefined;
    });
    const gateway = await assertReadyGateway(existingName, agentId, owner.id, candidate);
    const workload = await resource("deployment", revisionName(candidate), existingName);
    const harnessClaim = await assertHarnessWorkspaceClaim(existingName, owner.id, agentId);
    assert.equal(
      gateway.spec.template.spec.volumes.some(
        ({ persistentVolumeClaim }) =>
          persistentVolumeClaim?.claimName === harnessClaim.metadata.name,
      ),
      false,
      "Gateway must not mount the Harness workspace claim",
    );
    assert.deepEqual(
      workload.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
      {
        name: "openclaw-workspace",
        persistentVolumeClaim: { claimName: harnessClaim.metadata.name },
      },
    );
    await driver.stopRevision(candidate);
    assert.equal(await missing("deployment", revisionName(candidate), existingName), true);
    assert.equal(
      await missing("deployment", gatewayName(agentId), kubernetesGatewayNamespaceName(owner.id)),
      true,
    );
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
      (await resource("persistentvolumeclaim", harnessClaim.metadata.name, existingName)).metadata
        .uid,
      harnessClaim.metadata.uid,
      "stop must preserve the Agent-owned Harness workspace claim",
    );

    // Namespace deletion is legal only for an owner with no Agents or Configurations.
    await createExistingNamespace(cleanupName);
    await grantTenantAccess(cleanupName);
    await driver.ensureNamespace(cleanupOwner);
    await grantTenantAccess(kubernetesGatewayNamespaceName(cleanupOwner.id));
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
  "provisioning API and worker hand off a dedicated Agent with real Kubernetes fixture storage",
  { ...requiresKubernetesAndPostgres, timeout: 360_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-provisioning-${hash(installationId)}`;
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
    await kubectl(
      "patch",
      "clusterrole",
      controller.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [""],
            resources: ["secrets"],
            verbs: ["get", "list", "create", "patch", "update", "delete"],
          },
        },
        // Final deletion checks routes even when deployment failed before creating them.
        ...[
          ["gateway.networking.k8s.io", "httproutes"],
          ["gateway.envoyproxy.io", "securitypolicies"],
        ].map(([group, resource]) => ({
          op: "add",
          path: "/rules/-",
          value: { apiGroups: [group], resources: [resource], verbs: ["get", "delete"] },
        })),
      ]),
    );
    const gatewayRouting = {
      gatewayName: `oce-agent-gateways-${hash(installationId, 8)}`,
      gatewayNamespace: platformNamespace,
      envoyNamespace: platformNamespace,
    };
    const nodeEnrollment = createGatewayNodeEnrollment(
      async () => "fixture-node-enrollment-api-key",
    );
    const { driver, kubernetesNamespaceName } = await createDriver(
      {
        authentication: controller.authentication,
        gatewayRouting,
        network: {
          dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
          gatewayPort: 8080,
          gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        },
        runtime: {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
          gatewayNodeSelector: {
            "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
              .items[0].metadata.name,
          },
        },
      },
      { nodeEnrollment },
    );
    const fixture = await createProvisioningApiFixture(context, driver, controller.authentication);
    context.after(async () => {
      await Promise.all(
        fixture.bootstrapNamespaceIds.map((namespaceId) =>
          kubectl(
            "delete",
            "namespace",
            kubernetesNamespaceName(namespaceId),
            kubernetesGatewayNamespaceName(namespaceId),
            "--ignore-not-found=true",
            "--wait=true",
          ),
        ),
      );
    });
    const namespaceResponse = await fixture.request("POST", "/namespaces", {
      name: `k8s-provision-${randomUUID().slice(0, 8)}`,
    });
    assert.equal(namespaceResponse.status, 201, JSON.stringify(namespaceResponse.body));
    const namespaceOwner = namespaceResponse.data;
    const placement = kubernetesNamespaceName(namespaceOwner.id);
    const gatewayPlacement = kubernetesGatewayNamespaceName(namespaceOwner.id);
    context.after(async () => {
      await kubectl(
        "delete",
        "namespace",
        placement,
        gatewayPlacement,
        "--ignore-not-found=true",
        "--wait=true",
      );
    });

    await fixture.startWorker();
    for (const target of [placement, gatewayPlacement]) {
      await waitFor(`worker to create provisioning namespace ${target}`, async () =>
        (await missing("namespace", target)) ? undefined : true,
      );
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        target,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }
    await waitFor("provisioning tenant Namespace to become ready", async () => {
      const observed = await fixture.request("GET", `/namespaces/${namespaceOwner.id}`);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "ready" ? observed.data : undefined;
    });
    await fixture.stopWorker();

    const discoveryPat = `at-kubernetes-fixture-${randomUUID()}`;
    const rotatedPat = `at-kubernetes-rotated-${randomUUID()}`;
    const modelSecret = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/secrets`, {
      name: `Provisioning model key ${randomUUID().slice(0, 8)}`,
      value: discoveryPat,
    });
    assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.body));
    const slackBotSecret = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/secrets`,
      {
        name: `Provisioning Slack bot token ${randomUUID().slice(0, 8)}`,
        value: `xoxb-${randomUUID()}`,
      },
    );
    assert.equal(slackBotSecret.status, 201, JSON.stringify(slackBotSecret.body));

    // Before creating the Agent, use the actual Kubernetes-backed PAT through the
    // real discovery Driver; only the external provider responses are controlled.
    const originalFetch = globalThis.fetch;
    const observedTokens = [];
    const provider = context.mock.method(globalThis, "fetch", async (url, init) => {
      const address = String(url);
      if (
        !address.startsWith("https://auth.openai.com/") &&
        !address.startsWith("https://chatgpt.com/backend-api/ps/")
      ) {
        return originalFetch(url, init);
      }
      observedTokens.push(init.headers.Authorization.slice("Bearer ".length));
      if (address.includes("/whoami")) {
        return Response.json({
          chatgpt_account_id: "fixture-account",
          chatgpt_account_is_fedramp: false,
        });
      }
      assert.equal(init.headers["ChatGPT-Account-ID"], "fixture-account");
      const plugin = {
        id: "fixture-plugin",
        name: "fixture",
        scope: "GLOBAL",
        status: "ENABLED",
        installation_policy: "AVAILABLE",
        release: {
          display_name: "Fixture",
          interface: {},
          requires_local_executor: false,
          app_ids: ["fixture-app"],
          app_manifest: null,
          skills: [],
          mcp_servers: [],
        },
      };
      if (address.includes("plugins/list")) {
        return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
      }
      if (address.includes("plugins/fixture-plugin")) {
        return Response.json(plugin);
      }
      assert.ok(address.endsWith("apps/batch"));
      return Response.json({
        apps: [{ id: "fixture-app", status: "ENABLED", tools: [{ name: "search" }] }],
      });
    });
    const discoveryPath = `/namespaces/${namespaceOwner.id}/agents/plugins`;
    const catalog = await fixture.request("POST", discoveryPath, {
      secretRef: modelSecret.data.ref,
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.plugins[0].remoteId, "fixture-plugin");
    const detail = await fixture.request("POST", `${discoveryPath}/details`, {
      secretRef: modelSecret.data.ref,
      pluginId: "fixture-plugin",
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.tools[0].id, "fixture-app/search");
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === discoveryPat));
    assert.equal(
      (
        await fixture.request(
          "PATCH",
          `/namespaces/${namespaceOwner.id}/secrets/${modelSecret.data.id}`,
          { value: rotatedPat },
        )
      ).status,
      200,
    );
    observedTokens.length = 0;
    assert.equal(
      (await fixture.request("POST", discoveryPath, { secretRef: modelSecret.data.ref })).status,
      200,
    );
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === rotatedPat));
    assert.doesNotMatch(
      JSON.stringify([catalog.body, detail.body]),
      /at-kubernetes-(fixture|rotated)-/,
    );
    provider.mock.restore();

    const body = provisioningRequestBody({
      modelSecretRef: modelSecret.data.ref,
      slackBotSecretRef: slackBotSecret.data.ref,
      authMethod: "codex_pat",
    });
    assert.equal(
      JSON.stringify(body).includes(rotatedPat),
      false,
      "provisioning must carry only saved Secret references, not Secret values",
    );
    assert.equal(
      JSON.stringify(body).includes("xoxb-"),
      false,
      "provisioning must carry only saved Secret references, not Slack token values",
    );
    const admitted = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/agents/provision`,
      body,
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.data.agent, undefined);
    assert.equal(typeof admitted.data.provisioning.workId, "string");
    assert.match(admitted.data.provisioning.url, /^\/namespaces\//);
    await fixture.startWorker();
    const provisioned = await waitFor("Kubernetes provisioning handoff to succeed", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    await fixture.stopWorker();
    assert.equal(typeof provisioned.agentId, "string");
    assert.equal(typeof provisioned.configurationId, "string");
    assert.equal(typeof provisioned.revisionId, "string");

    const revisions = await fixture.request(
      "GET",
      `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}/revisions`,
    );
    assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
    assert.equal(revisions.data.length, 1);
    assert.equal(revisions.data[0].id, provisioned.revisionId);
    assert.equal(revisions.data[0].compute.id, driver.id);
    assert.equal(revisions.data[0].compute.implementation, driver.implementation);

    const configuration = await resource(
      "configmap",
      kubernetesConfigurationName(revisions.data[0].configurationId),
      gatewayPlacement,
    );
    assert.equal(
      configuration.metadata.annotations["openclaw.dev/configuration-id"],
      revisions.data[0].configurationId,
    );
    assert.equal(configuration.metadata.annotations["openclaw.dev/configuration-generation"], "1");

    const provisionedSecrets = (await resources("secrets", gatewayPlacement)).filter(
      ({ metadata }) =>
        metadata.labels?.["app.kubernetes.io/managed-by"] === "openclaw-enterprise" &&
        metadata.labels?.["openclaw.dev/namespace"] === namespaceOwner.id &&
        metadata.labels?.["openclaw.dev/secret"] !== undefined,
    );
    assert.equal(
      provisionedSecrets.length,
      2,
      "Console-saved Secrets must be stored through the real Kubernetes Secret Driver",
    );
    const transportName = `transport-${hash(provisioned.agentId)}`;
    const passwordName = `gateway-password-${hash(provisioned.agentId)}`;
    const transport = await resource("secret", transportName, gatewayPlacement);
    const password = await resource("secret", passwordName, gatewayPlacement);
    assert.deepEqual(
      Object.keys(transport.data),
      ["app-server-token"],
      "the canonical app-server credential must be generated in CP before provisioning handoff",
    );
    assert.deepEqual(
      Object.keys(password.data),
      ["gateway-password"],
      "the Gateway password must be a separate CP credential",
    );
    for (const name of [
      transportName,
      passwordName,
      ...provisionedSecrets.map(({ metadata }) => metadata.name),
    ]) {
      assert.equal(
        await missing("secret", name, placement),
        true,
        "canonical credentials must not be stored in the Harness namespace",
      );
    }

    // Seed an owned pre-upgrade RWX workspace without altering any supported Agent.
    // No RWX provisioner is needed: rejection must happen before mounting the claim.
    const legacyConfiguration = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/configurations`,
      {
        kind: "agent",
        values: {
          gateway: body.configuration.values.gateway,
          agents: body.configuration.values.agents,
        },
      },
    );
    assert.equal(legacyConfiguration.status, 201, JSON.stringify(legacyConfiguration.body));
    const legacy = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/agents`, {
      name: `legacy-rwx-${randomUUID()}`,
      configurationId: legacyConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: body.harnessAuth,
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    const legacyPath = `/namespaces/${namespaceOwner.id}/agents/${legacy.data.id}`;
    const role = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/iam/roles`, {
      name: `legacy-rwx-secrets-${randomUUID()}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    for (const secret of [modelSecret]) {
      const grant = await fixture.request(
        "POST",
        `/namespaces/${namespaceOwner.id}/iam/access-bindings`,
        {
          subjectKind: "identity",
          subjectId: legacy.data.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "secret",
          resourceId: secret.data.id,
        },
      );
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
    }
    const credentials = await fixture.request("POST", `${legacyPath}/runtime-credentials`, {});
    assert.equal(credentials.status, 200, JSON.stringify(credentials.body));
    const workspaceName = harnessWorkspaceClaimName(legacy.data.id);
    const gatewayStateName = `gateway-state-${hash(legacy.data.id)}`;
    const claimDirectory = await mkdtemp(join(tmpdir(), "openclaw-legacy-rwx-"));
    context.after(() => rm(claimDirectory, { recursive: true, force: true }));
    for (const [name, namespace, accessMode, storage] of [
      [workspaceName, placement, "ReadWriteMany", "40Gi"],
      [gatewayStateName, gatewayPlacement, "ReadWriteOnce", "10Gi"],
    ]) {
      const claimPath = join(claimDirectory, `${name}.json`);
      await writeFile(
        claimPath,
        JSON.stringify({
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace": namespaceOwner.id,
              "openclaw.dev/agent": legacy.data.id,
            },
            annotations: {
              "openclaw.dev/namespace-id": namespaceOwner.id,
              "openclaw.dev/agent-id": legacy.data.id,
            },
          },
          spec: {
            accessModes: [accessMode],
            volumeMode: "Filesystem",
            storageClassName: "local-path",
            resources: { requests: { storage } },
          },
        }),
        { mode: 0o600 },
      );
      await kubectl("apply", "--filename", claimPath);
    }
    const originalWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    const originalGatewayState = await resource(
      "persistentvolumeclaim",
      gatewayStateName,
      gatewayPlacement,
    );
    // Observe the real Driver failure without replacing its Kubernetes client or behavior.
    // A generic worker failure alone could otherwise pass for an unrelated configuration error.
    const prepareRevision = driver.prepareRevision.bind(driver);
    const preparationFailures = [];
    const preparation = context.mock.method(driver, "prepareRevision", async (...args) => {
      try {
        return await prepareRevision(...args);
      } catch (error) {
        if (args[0].agentId === legacy.data.id) {
          preparationFailures.push(error.message);
        }
        throw error;
      }
    });
    const deployment = await fixture.request("POST", `${legacyPath}/deploy`);
    assert.equal(deployment.status, 202, JSON.stringify(deployment.body));
    await fixture.startWorker();
    const failedDeployment = await waitFor("legacy RWX deployment to fail", async () => {
      const work = await fixture.readWork(`agent_revision:${deployment.data.id}:reconcile`);
      return work?.state === "failed_permanent" ? work : undefined;
    });
    preparation.mock.restore();
    assert.deepEqual(
      new Set(preparationFailures),
      new Set([`Refusing invalid PersistentVolumeClaim ${workspaceName}.`]),
    );
    assert.equal(failedDeployment.reason_code, "DEPENDENCY_UNAVAILABLE");
    const undeployed = await fixture.request("GET", legacyPath);
    assert.equal(undeployed.status, 200, JSON.stringify(undeployed.body));
    assert.equal(undeployed.data.activeRevisionId, undefined);
    assert.equal(await missing("deployment", revisionName(deployment.data), placement), true);
    assert.equal(await missing("deployment", gatewayName(legacy.data.id), gatewayPlacement), true);
    assert.equal(
      (await resource("persistentvolumeclaim", gatewayStateName, gatewayPlacement)).metadata.uid,
      originalGatewayState.metadata.uid,
    );
    const beforeDelete = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(beforeDelete.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(beforeDelete.spec, originalWorkspace.spec);

    const deleting = await fixture.request("DELETE", legacyPath);
    assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
    const failedDeletion = await waitFor(
      "legacy RWX deletion to exhaust its retry budget",
      async () => {
        const work = await fixture.readWork(`agent:${legacy.data.id}:reconcile:deleted`);
        return work?.state === "failed_permanent" ? work : undefined;
      },
    );
    assert.equal(failedDeletion.reason_code, "DEPENDENCY_UNAVAILABLE");
    await fixture.stopWorker();
    const retained = await fixture.request("GET", legacyPath);
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.equal(retained.data.status, "deleting");
    assert.equal(retained.data.desiredRuntimeState, "stopped");
    const rejectedWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(rejectedWorkspace.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(rejectedWorkspace.spec, originalWorkspace.spec);
    assert.equal(rejectedWorkspace.metadata.deletionTimestamp, undefined);
    // Final deletion is not atomic: CP state is removed before Harness validation.
    // This is why the legacy Agent must be discarded with a compatible release.
    assert.equal(
      await missing("persistentvolumeclaim", gatewayStateName, gatewayPlacement),
      true,
      "Gateway state is removed before final deletion rejects the RWX claim",
    );
    assert.equal(
      await missing("secret", `transport-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    assert.equal(
      await missing("secret", `gateway-password-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    // The unrelated Agent and its canonical credentials are not deleted.
    assert.equal(
      (
        await fixture.request(
          "GET",
          `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await resource("secret", transportName, gatewayPlacement)).metadata.uid,
      transport.metadata.uid,
    );
  },
);

test(
  "authenticated PostgreSQL OCC API and worker deploy real Agent-owned gateways, Secret bindings, and revisions",
  { ...requiresKubernetesAndPostgres, timeout: runtimeImage === undefined ? 360_000 : 600_000 },
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
    configuration.drivers.compute.configuration = fixtureComputeConfiguration(
      runtimeImage === undefined
        ? {}
        : {
            images: {
              gateway: runtimeImage,
              agent: runtimeImage,
              requireImmutableDigest: true,
            },
            resources: {
              gateway: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "768Mi" },
              },
              agent: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "768Mi" },
              },
              namespace: {
                quota: {
                  pods: "20",
                  "requests.cpu": "2",
                  "requests.memory": "4Gi",
                  "limits.cpu": "8",
                  "limits.memory": "8Gi",
                },
                containerDefaults: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "768Mi" },
                },
              },
            },
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              gatewayNodeSelector: {
                "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
                  .items[0].metadata.name,
              },
              channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
            },
          },
    );
    const proxyCidrs = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS?.split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean);
    assert.ok(
      proxyCidrs?.length,
      "the real diagnostics route requires the k3d API server Pod proxy source CIDR",
    );
    configuration.drivers.compute.configuration.network.pluginStatusProxySourceCidrs = proxyCidrs;
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
    let workerDrivers = drivers;
    let workerStarts = 0;
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
        [
          ...new Set([
            existingName,
            ...placements.values(),
            ...namespaceIds.map(kubernetesGatewayNamespaceName),
          ]),
        ].map((name) =>
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
      const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(options.session === false ? {} : authenticatedHeaders(options.session ?? session)),
          ...(mutation ? { origin: authBaseURL } : {}),
          ...options.headers,
          host: "127.0.0.1",
        },
        ...(payload === undefined ? {} : { payload }),
      });
      return { status: response.statusCode, ...response.json() };
    }

    async function startWorker({ convergenceTimeoutMs } = {}) {
      workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
      if (workerStarts > 0) {
        workerDrivers = await loadInstallationConfiguration({
          mode: "development",
          environment: {},
          startupConfiguration: { configuration, logging: { level: "info" } },
        });
        assert.ok(workerDrivers);
      }
      workerStarts += 1;
      worker = createControllerWorker({
        pool: workerPool,
        drivers: workerDrivers,
        pollIntervalMs: 25,
        leaseDurationMs: 30_000,
        maxAttempts: 20,
        ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
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

    async function grantSecretOperate(namespaceId, servicePrincipalId, secretId, label) {
      const role = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
        name: `${label} Secret operate ${randomUUID()}`,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
      assert.equal(role.status, 201, JSON.stringify(role.error));
      const binding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: secretId,
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.error));
      return { role: role.data, binding: binding.data };
    }

    async function assertDeployDenied(namespaceId, agentId, label) {
      const denied = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
      assert.equal(denied.status, 403, `${label}: ${JSON.stringify(denied.error)}`);
    }

    const initialWorkspaceFilesByAgent = new Map();
    async function assertInitialWorkspace(
      namespaceId,
      agentId,
      expectedFiles,
      candidate,
      executionMode = "dedicated",
    ) {
      const placement = placements.get(namespaceId);
      const output = await kubectl(
        "exec",
        `deployment/${executionMode === "embedded" ? gatewayName(agentId) : revisionName(candidate)}`,
        "--namespace",
        placement,
        "-c",
        executionMode === "embedded" ? "gateway" : "agent",
        "--",
        "node",
        "-e",
        `const fs = require('node:fs'); process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expectedFiles))}.map(name => [name, fs.readFileSync(${JSON.stringify(executionMode === "embedded" ? "/home/node/.openclaw/workspace/" : "/home/node/workspace/")} + name, 'utf8')]))));`,
      );
      assert.deepEqual(JSON.parse(output), expectedFiles);
      const completed = await state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
      assert.equal(completed.completed, true);
      assert.equal(completed.files, undefined, "activation removes staged document bytes");
      const delivered = await resource("secret", `workspace-setup-${hash(agentId)}`, placement);
      const payload = JSON.parse(
        Buffer.from(delivered.data["setup.json"], "base64").toString("utf8"),
      );
      assert.equal(payload.completed, true);
      assert.equal(payload.files, undefined, "runtime delivery retains only its restart guard");
    }

    async function createAgent(namespaceId, label, options = {}) {
      const executionMode = options.executionMode ?? "dedicated";
      const model = executionMode === "embedded" ? "openai/gpt-4.1" : "codex/gpt-4.1";
      const agentRuntime = executionMode === "embedded" ? "openclaw" : "codex";
      const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
        name: `${label} fixture model key`,
        value: `fixture-only-${randomUUID()}`,
      });
      assert.equal(secret.status, 201, JSON.stringify(secret.error));
      let boundSecret;
      let boundSecretValue;
      if (options.boundSecret === true) {
        boundSecretValue = `bound-secret-${randomUUID()}`;
        boundSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
          name: `${label} bound sentinel`,
          value: boundSecretValue,
        });
        assert.equal(boundSecret.status, 201, JSON.stringify(boundSecret.error));
      }
      const baseValues = {
        gateway: {
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth: {
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
        logging: { level: "info" },
        agents: {
          defaults: {
            skipBootstrap: true,
            model,
            models: { [model]: { agentRuntime: { id: agentRuntime } } },
          },
        },
      };
      const missingChannelBindingValues = {
        ...baseValues,
        plugins: { allow: ["slack"], entries: { slack: { enabled: true } } },
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            dmPolicy: "allowlist",
            allowFrom: ["U0123456789"],
            channels: {
              C0123456789: { requireMention: true, allowBots: "mentions" },
            },
          },
        },
      };
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        kind: "agent",
        values: baseValues,
      });
      assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
      const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: `${label}-${randomUUID()}`,
        configurationId: configuration.data.id,
        ...(runtimeImage === undefined
          ? {}
          : {
              initialWorkspaceFiles: {
                "USER.md": `Initial ${label} user directives\n`,
                "SOUL.md": "",
              },
              workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
            }),
        executionMode,
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId, id: secret.data.id },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.error));
      assert.equal(typeof created.data.servicePrincipalId, "string");
      assert.notEqual(created.data.servicePrincipalId.trim(), "");
      if (runtimeImage !== undefined) {
        initialWorkspaceFilesByAgent.set(created.data.id, {
          "USER.md": `Initial ${label} user directives\n`,
          "SOUL.md": "",
        });
        assert.equal(
          JSON.stringify(created.data).includes(`Initial ${label} user directives`),
          false,
        );
      }
      await assertDeployDenied(namespaceId, created.data.id, `${label} before model Secret grant`);
      await grantSecretOperate(namespaceId, created.data.servicePrincipalId, secret.data.id, label);
      if (boundSecret !== undefined) {
        // Isolate missing channel credentials from the model permission denial above.
        const missingConfiguration = await request(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          { values: missingChannelBindingValues },
        );
        assert.equal(missingConfiguration.status, 200, JSON.stringify(missingConfiguration.error));
        const missingBindings = await request(
          "POST",
          `/namespaces/${namespaceId}/agents/${created.data.id}/deploy`,
        );
        assert.equal(
          missingBindings.status,
          400,
          `${label} before channel Secret bindings: ${JSON.stringify(missingBindings.error)}`,
        );
        assert.equal(missingBindings.error.code, "CHANNEL_CREDENTIAL_BINDING_REQUIRED");
        // This k3d fixture has no runtime.channels proxy and uses the fixture image,
        // so successful deployment proves generic API/IAM/admission/gateway Secret
        // projection. Real Slack channel runtime proof belongs to the real-runtime suite.
        const updated = await request(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          {
            values: baseValues,
            secretBindings: {
              BOUND_SENTINEL: {
                source: boundSecret.data.ref,
                delivery: { type: "env" },
              },
            },
          },
        );
        assert.equal(updated.status, 200, JSON.stringify(updated.error));
        await assertDeployDenied(
          namespaceId,
          created.data.id,
          `${label} before bound Secret grant`,
        );
        await grantSecretOperate(
          namespaceId,
          created.data.servicePrincipalId,
          boundSecret.data.id,
          `${label} bound`,
        );
      }
      return {
        ...created.data,
        ...(boundSecret === undefined
          ? {}
          : { boundSecretId: boundSecret.data.id, boundSecretValue }),
      };
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
      return waitFor(
        `Agent ${agentId} to activate revision ${revisionId}`,
        async () => {
          const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
          assert.equal(current.status, 200);
          return current.data.activeRevisionId === revisionId ? current.data : undefined;
        },
        runtimeImage === undefined ? 120_000 : 240_000,
      );
    }

    const first = await createAgent(namespaceIds[0], "first");
    const second = await createAgent(namespaceIds[0], "second");
    const boundSecretAgent = await createAgent(namespaceIds[0], "bound-secret", {
      boundSecret: true,
    });
    const separateTenant = await createAgent(namespaceIds[1], "separate-tenant");
    const embeddedDelete = await createAgent(namespaceIds[1], "embedded-delete", {
      executionMode: "embedded",
    });
    const adoptedTenant = await createAgent(namespaceIds[2], "adopted-tenant");
    if (runtimeImage !== undefined) {
      const firstCredentialsPath = `/namespaces/${namespaceIds[0]}/agents/${first.id}/runtime-credentials`;
      const beforeDeploy = await request("GET", firstCredentialsPath);
      assert.equal(beforeDeploy.status, 200, JSON.stringify(beforeDeploy.error));
      assert.deepEqual(beforeDeploy.data, { transportConfigured: false });
      for (const [namespaceId, agent] of [
        [namespaceIds[0], second],
        [namespaceIds[0], boundSecretAgent],
        [namespaceIds[1], separateTenant],
        [namespaceIds[1], embeddedDelete],
        [adopted.data.id, adoptedTenant],
      ]) {
        const provisioned = await request(
          "POST",
          `/namespaces/${namespaceId}/agents/${agent.id}/runtime-credentials`,
          {},
        );
        assert.equal(provisioned.status, 200, JSON.stringify(provisioned.error));
        assert.deepEqual(provisioned.data, {
          transportConfigured: true,
        });
      }
    }
    const adoptedCredentialSecrets =
      runtimeImage === undefined
        ? []
        : ["transport"].map((prefix) => `${prefix}-${hash(adoptedTenant.id)}`);
    const embeddedCredentialSecrets =
      runtimeImage === undefined
        ? []
        : ["transport"].map((prefix) => `${prefix}-${hash(embeddedDelete.id)}`);
    for (const name of adoptedCredentialSecrets) {
      await resource("secret", name, kubernetesGatewayNamespaceName(adopted.data.id));
    }
    for (const name of embeddedCredentialSecrets) {
      await resource("secret", name, placements.get(namespaceIds[1]));
    }
    const admitted = await Promise.all([
      deploy(namespaceIds[0], first.id),
      deploy(namespaceIds[0], second.id),
      deploy(namespaceIds[1], separateTenant.id),
      deploy(namespaceIds[1], embeddedDelete.id),
      deploy(namespaceIds[2], adoptedTenant.id),
      deploy(namespaceIds[0], boundSecretAgent.id),
    ]);
    if (runtimeImage !== undefined) {
      const afterDeploy = await request(
        "GET",
        `/namespaces/${namespaceIds[0]}/agents/${first.id}/runtime-credentials`,
      );
      assert.equal(afterDeploy.status, 200, JSON.stringify(afterDeploy.error));
      assert.deepEqual(afterDeploy.data, { transportConfigured: true });
      await resource(
        "secret",
        `transport-${hash(first.id)}`,
        kubernetesGatewayNamespaceName(namespaceIds[0]),
      );
    }

    await Promise.all(
      [
        [namespaceIds[0], first, admitted[0]],
        [namespaceIds[0], second, admitted[1]],
        [namespaceIds[0], boundSecretAgent, admitted[5]],
        [namespaceIds[1], separateTenant, admitted[2]],
        [namespaceIds[1], embeddedDelete, admitted[3], "embedded"],
        [namespaceIds[2], adoptedTenant, admitted[4], "dedicated"],
      ].map(async ([namespaceId, agent, candidate, executionMode = "dedicated"]) => {
        await waitForActive(namespaceId, agent.id, candidate.id);
        const placement = placements.get(namespaceId);
        await assertReadyGateway(placement, agent.id, namespaceId, candidate);
        const imagePath = `/namespaces/${namespaceId}/agents/${agent.id}/runtime-images`;
        const imageRead = await request("GET", imagePath);
        assert.equal(imageRead.status, 200, JSON.stringify(imageRead.error));
        assert.equal(imageRead.data.status, "observed");
        const observedPods = (
          await Promise.all(
            [...new Set([placement, kubernetesGatewayNamespaceName(namespaceId)])].map(
              (namespace) => resources("pods", namespace),
            ),
          )
        )
          .flat()
          .filter(
            (pod) =>
              pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
              pod.metadata.labels?.["openclaw.dev/revision"] === candidate.id &&
              !pod.metadata.deletionTimestamp,
          );
        const expectedImages = observedPods.flatMap((pod) =>
          [
            [pod.spec.containers, pod.status.containerStatuses],
            [pod.spec.initContainers, pod.status.initContainerStatuses],
            [pod.spec.ephemeralContainers, pod.status.ephemeralContainerStatuses],
          ].flatMap(([containers = [], statuses = []]) =>
            containers.map((container) => ({
              workload: `${pod.metadata.namespace}/${pod.metadata.name}`,
              container: container.name,
              image: container.image,
              imageId: statuses.find((state) => state.name === container.name)?.imageID ?? null,
            })),
          ),
        );
        assert.ok(expectedImages.length > 0);
        const byContainer = (a, b) =>
          `${a.workload}/${a.container}`.localeCompare(`${b.workload}/${b.container}`);
        assert.deepEqual(
          imageRead.data.images
            .map(({ commit, openclawCommit, ...identity }) => {
              assert.ok(commit === null || /^[a-f0-9]{40}$/.test(commit));
              assert.ok(openclawCommit === null || /^[a-f0-9]{40}$/.test(openclawCommit));
              return identity;
            })
            .sort(byContainer),
          expectedImages.sort(byContainer),
        );
        assert.equal((await request("GET", imagePath, undefined, { session: false })).status, 401);
        if (runtimeImage !== undefined) {
          // These bytes came through normal HTTP creation, PostgreSQL and the worker;
          // readiness cannot be reported before native setup and private delivery cleanup.
          await assertInitialWorkspace(
            namespaceId,
            agent.id,
            initialWorkspaceFilesByAgent.get(agent.id),
            candidate,
            executionMode,
          );
        }
        if (executionMode === "dedicated") {
          const deployment = await resource("deployment", revisionName(candidate), placement);
          assert.equal(deployment.spec.template.spec.serviceAccountName, agentName(agent.id));
          if (agent.boundSecretValue !== undefined) {
            assert.deepEqual(Object.keys(candidate.secretBindings), ["BOUND_SENTINEL"]);
            const harnessContainer = deployment.spec.template.spec.containers[0];
            assert.equal(
              harnessContainer.env.some((entry) => entry.name === "BOUND_SENTINEL"),
              false,
              "dedicated Harness must not receive gateway Secret bindings",
            );
            const gatewayDeployment = await resource(
              "deployment",
              gatewayName(agent.id),
              kubernetesGatewayNamespaceName(namespaceId),
            );
            const gatewayContainer = gatewayDeployment.spec.template.spec.containers[0];
            const projection = gatewayContainer.env.find(
              (entry) => entry.name === "BOUND_SENTINEL",
            );
            assert.equal(projection.valueFrom.secretKeyRef.optional ?? false, false);
            assert.ok(
              projection.valueFrom.secretKeyRef.name,
              "Configuration Secret bindings must render a concrete Kubernetes Secret name",
            );
            const pod = await waitFor(`bound Secret gateway ${agent.id} Pod`, async () =>
              (await resources("pods", kubernetesGatewayNamespaceName(namespaceId))).find(
                ({ metadata, status }) =>
                  metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
                  metadata.labels?.["app.kubernetes.io/name"] === gatewayName(agent.id) &&
                  status.conditions?.some(
                    ({ type, status: conditionStatus }) =>
                      type === "Ready" && conditionStatus === "True",
                  ),
              ),
            );
            const script = `const expected=${JSON.stringify(agent.boundSecretValue)};process.stdout.write(process.env.BOUND_SENTINEL===expected?"matched":"missing")`;
            const observedSecret = await kubectl(
              "exec",
              pod.metadata.name,
              "--namespace",
              kubernetesGatewayNamespaceName(namespaceId),
              "--",
              "node",
              "-e",
              script,
            );
            assert.equal(observedSecret, "matched");
          }
        } else {
          assert.equal(await missing("deployment", revisionName(candidate), placement), true);
          assert.equal(await missing("service", agentName(agent.id), placement), true);
        }
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
        // Fixture mode stages workloads without live routing; the optional real runtime must
        // activate the exact revision and publish one ready Service endpoint.
        if (executionMode === "dedicated") {
          await assertAgentServiceEndpointCount(
            placement,
            agent.id,
            runtimeImage === undefined ? 0 : 1,
            runtimeImage === undefined
              ? "the HTTP fixture Agent Service must remain nonserving"
              : "the exact active revision must become routable",
          );
        }
      }),
    );

    // Use the API-deployed embedded runtime, dedicated Harness, and dedicated Gateway.
    // Reachable CoreDNS listeners outside the peer/port grant distinguish CNI denial from an absent server.
    const dns = await createDnsTrafficFixture(
      context,
      configuration.drivers.compute.configuration.network.dns,
    );
    const dnsSources = await Promise.all([
      workloadPod(
        placements.get(namespaceIds[0]),
        `app.kubernetes.io/name=${revisionName(admitted[0])}`,
      ),
      workloadPod(
        kubernetesGatewayNamespaceName(namespaceIds[0]),
        `app.kubernetes.io/name=${gatewayName(first.id)}`,
      ),
      workloadPod(
        placements.get(namespaceIds[1]),
        `app.kubernetes.io/name=${gatewayName(embeddedDelete.id)}`,
      ),
    ]);
    assert.ok(dnsSources.every(Boolean), "all API-deployed DNS source Pods must be running");
    for (const protocol of ["udp", "tcp"]) {
      for (const [target, port] of [
        [dns.selected, 5353],
        [dns.selected, 5354],
        [dns.unselected, 5353],
      ]) {
        assert.equal(
          JSON.parse(await dns.query(dns.control, target, protocol, port)).address,
          "192.0.2.53",
        );
      }
    }
    for (const protocol of ["udp", "tcp"]) {
      for (const source of dnsSources) {
        assert.equal(
          JSON.parse(await dns.query(source, dns.selected, protocol, 5353)).address,
          "192.0.2.53",
          `${source.metadata.name} must resolve over ${protocol} port 5353`,
        );
        for (const [target, port] of [
          [dns.selected, 5354],
          [dns.unselected, 5353],
        ]) {
          await assert.rejects(
            dns.query(source, target, protocol, port),
            (error) => {
              assert.equal(error.code, 1);
              assert.match(error.stderr, /ETIMEOUT|ETIMEDOUT|timed out|ECONNREFUSED/);
              return true;
            },
            `${source.metadata.name} must not reach ${target.metadata.name} over ${protocol} port ${port}`,
          );
        }
        assert.equal(
          JSON.parse(await dns.query(source, dns.selected, protocol, 5353)).address,
          "192.0.2.53",
          "the allowed DNS control must still work after denied queries",
        );
      }
    }

    const deploymentPath = `/namespaces/${namespaceIds[0]}/agents/${first.id}/deployments/${admitted[0].id}`;
    const persistedBefore = await waitFor("first revision deployment to settle", async () => {
      const observed = await request("GET", deploymentPath);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    const diagnosticsPath = `${deploymentPath}/diagnostics`;
    const diagnostics = await request("POST", diagnosticsPath);
    assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.error));
    assert.equal(diagnostics.data.revisionId, admitted[0].id);
    assert.equal(new Date(diagnostics.data.observedAt).toISOString(), diagnostics.data.observedAt);
    assert.ok(diagnostics.data.checks.length <= 32);
    if (runtimeImage === undefined) {
      assert.deepEqual(
        diagnostics.data.checks,
        ["agent", "gateway"].map((component) => ({
          component,
          check: "runtime-status",
          state: "unknown",
          checkedAt: null,
          code: "UNAVAILABLE",
        })),
        "the fixture image cannot provide current runtime checks",
      );
    } else {
      const gatewayConfiguration = diagnostics.data.checks.find(
        ({ component, check }) => component === "gateway" && check === "configuration",
      );
      assert.ok(gatewayConfiguration, "the real Gateway must answer its native Slack check");
      assert.equal(
        new Date(gatewayConfiguration.checkedAt).toISOString(),
        gatewayConfiguration.checkedAt,
      );
    }
    assert.equal(
      (await request("POST", diagnosticsPath, undefined, { session: false })).status,
      401,
    );
    const persistedAfter = await request("GET", deploymentPath);
    assert.equal(persistedAfter.status, 200, JSON.stringify(persistedAfter.error));
    assert.deepEqual(persistedAfter.data, persistedBefore);

    // Runtime status and container logs for the same exact revision, read through the
    // regular API with the Installation's Kubernetes credentials. Only Pods carrying
    // this Agent's and revision's labels are listed and read.
    const runtimePath = `${deploymentPath}/runtime`;
    const runningGateway = (observed) => {
      const source = observed.data?.sources.find(({ id }) => id === "gateway");
      return source?.pods.find(({ uid }) =>
        observed.data.pods.some(
          (pod) =>
            pod.uid === uid &&
            pod.containers.some(({ name, state }) => name === "gateway" && state === "running"),
        ),
      );
    };
    const gatewayPod = await waitFor("a running Gateway container in runtime status", async () => {
      const observed = await request("GET", runtimePath);
      return observed.status === 200 ? runningGateway(observed) : undefined;
    });
    const runtimeStatus = await request("GET", runtimePath);
    assert.equal(runtimeStatus.data.revisionId, admitted[0].id);
    assert.ok(runtimeStatus.data.pods.every(({ name }) => name.length > 0));
    const logsPath = `${runtimePath}/logs?source=gateway&tailLines=100`;
    const firstPage = await request("GET", logsPath);
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.error));
    assert.equal(firstPage.data.stream.pod, gatewayPod.name);
    assert.equal(typeof firstPage.data.cursor, "string");
    assert.ok(
      firstPage.data.records.every(
        (record) => record.type !== "line" || record.contentClass === "operational",
      ),
    );
    const followPage = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(firstPage.data.cursor)}`,
    );
    assert.equal(followPage.status, 200, JSON.stringify(followPage.error));
    // One audited view for the first page; the cursor poll is not re-audited.
    const views = await observerPool.query(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE action = 'openclaw.agents.runtime_logs.view' AND resource_id = $1`,
      [first.id],
    );
    assert.equal(views.rows[0].count, 1);
    // Replacing the Pod ends the cursor's instance; the next poll labels it.
    const gatewayNamespace = JSON.parse(
      await kubectl(
        "get",
        "pods",
        "--all-namespaces",
        "-l",
        `openclaw.dev/revision=${admitted[0].id},openclaw.dev/workload-role=gateway`,
        "-o",
        "json",
      ),
    ).items.find(({ metadata }) => metadata.uid === gatewayPod.uid).metadata.namespace;
    await kubectl("delete", "pod", gatewayPod.name, "-n", gatewayNamespace, "--wait=false");
    const replacementGateway = await waitFor(
      "a replacement Gateway Pod in runtime status",
      async () => {
        const observed = await request("GET", runtimePath);
        const pod = observed.status === 200 ? runningGateway(observed) : undefined;
        return pod !== undefined && pod.uid !== gatewayPod.uid ? pod : undefined;
      },
      180_000,
    );
    const replaced = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(followPage.data.cursor)}`,
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.error));
    assert.equal(replaced.data.records[0].type, "gap");
    assert.equal(replaced.data.records[0].reason, "stream_replaced");
    assert.equal(replaced.data.stream.pod, replacementGateway.name);
    const previousInstance = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&pod=${replacementGateway.name}&previous=true`,
    );
    assert.equal(previousInstance.status, 200, JSON.stringify(previousInstance.error));
    assert.equal((await request("GET", runtimePath, undefined, { session: false })).status, 401);

    if (runtimeImage !== undefined) {
      const gatewayTarget = kubernetesGatewayNamespaceName(namespaceIds[0]);
      const dataTarget = placements.get(namespaceIds[0]);
      const firstGateway = await resource("deployment", gatewayName(first.id), gatewayTarget);
      assert.equal(firstGateway.spec.template.spec.automountServiceAccountToken, false);
      const env = firstGateway.spec.template.spec.containers[0].env;
      const transportUrl = env.find(({ name }) => name === "APP_SERVER_URL").value;
      assert.equal(new URL(transportUrl).hostname, `${agentName(first.id)}.${dataTarget}.svc`);
      async function connectFromGateway(target) {
        return kubectl(
          "exec",
          `deployment/${gatewayName(first.id)}`,
          "--namespace",
          gatewayTarget,
          "-c",
          "gateway",
          "--",
          "node",
          "-e",
          `const net=require('node:net'); const s=net.connect({host:${JSON.stringify(target)},port:18790}); s.setTimeout(3000); s.on('connect',()=>{s.destroy();process.exit(0)}); s.on('timeout',()=>process.exit(1)); s.on('error',()=>process.exit(1));`,
        );
      }
      await connectFromGateway(new URL(transportUrl).hostname);
      for (const forbidden of [
        `${agentName(second.id)}.${dataTarget}.svc`,
        `${agentName(separateTenant.id)}.${placements.get(namespaceIds[1])}.svc`,
      ]) {
        await assert.rejects(connectFromGateway(forbidden), (error) => error.code === 1);
      }
    }

    async function ownedComputeResources(namespaceName, agentId, namespaceId, dedicated = false) {
      const kinds = [
        ["deployment", "deployments"],
        ["service", "services"],
        ["serviceaccount", "serviceaccounts"],
        ["configmap", "configmaps"],
        ["networkpolicy", "networkpolicies"],
        ["persistentvolumeclaim", "persistentvolumeclaims"],
        ["secret", "secrets"],
      ];
      const owned = [];
      for (const target of dedicated
        ? [namespaceName, kubernetesGatewayNamespaceName(namespaceId)]
        : [namespaceName]) {
        for (const [kind, plural] of kinds) {
          for (const object of await resources(plural, target)) {
            if (object.metadata.labels?.["openclaw.dev/agent"] === agentId) {
              owned.push({ kind, name: object.metadata.name, namespace: target });
            }
          }
        }
      }
      return owned;
    }

    const embeddedPlacement = placements.get(namespaceIds[1]);
    const embeddedOwned = await ownedComputeResources(embeddedPlacement, embeddedDelete.id);
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) => kind === "deployment" && name === gatewayName(embeddedDelete.id),
      ),
    );
    if (runtimeImage !== undefined) {
      assert.ok(embeddedOwned.some(({ kind }) => kind === "networkpolicy"));
      assert.ok(embeddedOwned.some(({ kind }) => kind === "persistentvolumeclaim"));
    }
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) => kind === "serviceaccount" && name === agentName(embeddedDelete.id),
      ),
    );
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `gateway-${hash(embeddedDelete.id)}-rev-${hash(admitted[3].id)}`,
      ),
    );

    // Editing the draft mode does not move the deployed revision or its private storage.
    const updatedEmbedded = await request(
      "PATCH",
      `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
      { configurationId: embeddedDelete.configurationId, executionMode: "dedicated" },
    );
    assert.equal(updatedEmbedded.status, 200, JSON.stringify(updatedEmbedded.error));
    // Deleting an active embedded Agent must not finalize until its gateway Pod is gone.
    const deletingEmbedded = await request(
      "DELETE",
      `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
    );
    assert.equal(deletingEmbedded.status, 202, JSON.stringify(deletingEmbedded.error));
    await waitFor("running embedded Agent deletion to finalize after Pod termination", async () => {
      const current = await request(
        "GET",
        `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
      );
      const ownedPods = (await resources("pods", embeddedPlacement)).filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === embeddedDelete.id,
      );
      return current.status === 404 && ownedPods.length === 0 ? true : undefined;
    });
    for (const { kind, name } of embeddedOwned) {
      assert.equal(await missing(kind, name, embeddedPlacement), true, `${kind} ${name} remains`);
    }
    for (const name of embeddedCredentialSecrets) {
      assert.equal(await missing("secret", name, embeddedPlacement), true);
    }
    await assertReadyGateway(embeddedPlacement, separateTenant.id, namespaceIds[1]);
    const adoptedWorkspace = await assertHarnessWorkspaceClaim(
      existingName,
      adopted.data.id,
      adoptedTenant.id,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      kubernetesGatewayNamespaceName(adopted.data.id),
    );

    const retainedFile = `stop-state-${randomUUID()}.txt`;
    const retainedValue = `retained-${randomUUID()}`;
    const adoptedRevisionPod = await waitFor(
      "adopted Agent revision Pod to become ready",
      async () =>
        (await resources("pods", existingName)).find(
          ({ metadata, status }) =>
            metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id &&
            metadata.labels?.["openclaw.dev/revision"] === admitted[4].id &&
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
    const editedWorkspaceFiles = {
      "USER.md": "User edit retained across stop and redeploy\n",
      "SOUL.md": "",
    };
    if (runtimeImage !== undefined) {
      // A real edit to the live durable files must survive a later admitted revision.
      await kubectl(
        "exec",
        `deployment/${revisionName(admitted[4])}`,
        "--namespace",
        existingName,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        `require('node:fs').writeFileSync('/home/node/workspace/USER.md', ${JSON.stringify(editedWorkspaceFiles["USER.md"])})`,
      );
    }
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
      if (!(await missing("deployment", revisionName(admitted[4]), existingName))) {
        return undefined;
      }
      if (
        !(await missing(
          "deployment",
          gatewayName(adoptedTenant.id),
          kubernetesGatewayNamespaceName(adopted.data.id),
        ))
      ) {
        return undefined;
      }
      const ownedPods = (
        await Promise.all(
          [existingName, kubernetesGatewayNamespaceName(adopted.data.id)].map((target) =>
            resources("pods", target),
          ),
        )
      )
        .flat()
        .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id);
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
          view.revisions.findRevision(adopted.data.id, adoptedTenant.id, admitted[4].id),
        )
      ).id,
      admitted[4].id,
      "API stop must retain immutable revision history",
    );

    const restarted = await deploy(adopted.data.id, adoptedTenant.id);
    assert.notEqual(restarted.id, admitted[4].id);
    await waitForActive(adopted.data.id, adoptedTenant.id, restarted.id);
    await assertReadyGateway(existingName, adoptedTenant.id, adopted.data.id, restarted);
    if (runtimeImage !== undefined) {
      await assertInitialWorkspace(
        adopted.data.id,
        adoptedTenant.id,
        editedWorkspaceFiles,
        restarted,
      );
    }
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
      (await assertHarnessWorkspaceClaim(existingName, adopted.data.id, adoptedTenant.id)).metadata
        .uid,
      adoptedWorkspace.metadata.uid,
    );

    await worker.stop();
    worker = undefined;
    workerPool = undefined;
    const replacementPlacement = kubernetesNamespaceName(namespaceIds[0]);
    // A controller upgrade leaves ready Namespaces and their old DNS grants in place.
    // Preparing one replacement must add backend ports without narrowing access for other Agents.
    const readyNamespace = await request("GET", `/namespaces/${namespaceIds[0]}`);
    assert.equal(readyNamespace.data.status, "ready");
    const legacyDnsPolicies = [];
    for (const target of [replacementPlacement, kubernetesGatewayNamespaceName(namespaceIds[0])]) {
      await kubectl(
        "patch",
        "networkpolicy",
        "allow-dns",
        "-n",
        target,
        "--type=json",
        "-p",
        JSON.stringify([
          { op: "replace", path: "/spec/podSelector", value: {} },
          {
            op: "replace",
            path: "/spec/egress/0/ports",
            value: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ]),
      );
      legacyDnsPolicies.push(await resource("networkpolicy", "allow-dns", target));
    }
    const otherAgentPods = (await resources("pods", replacementPlacement))
      .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === second.id)
      .map(({ metadata }) => metadata.uid)
      .sort();
    const replacementClaim = await assertHarnessWorkspaceClaim(
      replacementPlacement,
      namespaceIds[0],
      first.id,
    );
    await kubectl(
      "exec",
      `deployment/${revisionName(admitted[0])}`,
      "-n",
      replacementPlacement,
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      "require('node:fs').writeFileSync('/home/node/workspace/replacement-proof.txt', 'retain across replacement')",
    );
    const replacement = await deploy(namespaceIds[0], first.id);
    await startWorker();
    await waitForActive(namespaceIds[0], first.id, replacement.id);
    for (const previous of legacyDnsPolicies) {
      const current = await resource("networkpolicy", "allow-dns", previous.metadata.namespace);
      const expected = structuredClone(previous.spec);
      expected.egress[0].ports.push(
        { protocol: "UDP", port: 5353 },
        { protocol: "TCP", port: 5353 },
      );
      assert.equal(current.metadata.uid, previous.metadata.uid);
      assert.deepEqual(
        current.spec,
        expected,
        "DNS upgrade must preserve the old selectors and other rules",
      );
    }
    assert.deepEqual(
      (await resources("pods", replacementPlacement))
        .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === second.id)
        .map(({ metadata }) => metadata.uid)
        .sort(),
      otherAgentPods,
      "preparing one Agent must not restart another Agent's Pods",
    );
    const placement = kubernetesNamespaceName(namespaceIds[0]);
    await waitFor(`old revision deployment ${revisionName(admitted[0])} to be deleted`, () =>
      missing("deployment", revisionName(admitted[0]), placement),
    );
    await resource("deployment", revisionName(replacement), placement);
    await assertHarnessWorkspaceClaim(
      placement,
      namespaceIds[0],
      first.id,
      replacementClaim.metadata.uid,
    );
    assert.equal(
      await kubectl(
        "exec",
        `deployment/${revisionName(replacement)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('/home/node/workspace/replacement-proof.txt', 'utf8'))",
      ),
      "retain across replacement",
    );
    await resource("deployment", revisionName(admitted[1]), placement);
    await resource("deployment", revisionName(admitted[5]), placement);
    await resource("serviceaccount", agentName(first.id), placement);
    await assertReadyGateway(placement, first.id, namespaceIds[0]);
    await assertReadyGateway(placement, second.id, namespaceIds[0]);
    await assertReadyGateway(placement, boundSecretAgent.id, namespaceIds[0]);
    assert.equal(
      (await resources("deployments", kubernetesGatewayNamespaceName(namespaceIds[0]))).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      3,
      "worker restart and replacement revisions must preserve one gateway for each running Agent",
    );

    if (runtimeImage === undefined) {
      // Block the fixture's native readiness using the retained workspace, then
      // prove a failed candidate and recovery both keep the same volume and data.
      await worker.stop();
      worker = undefined;
      workerPool = undefined;
      await kubectl(
        "exec",
        `deployment/${revisionName(replacement)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "require('node:fs').writeFileSync('/home/node/workspace/.fixture-unready', 'blocked')",
      );
      const failed = await deploy(namespaceIds[0], first.id);
      await startWorker({ convergenceTimeoutMs: 20_000 });
      const failedWork = await waitFor(
        "replacement to fail native readiness",
        async () => {
          const work = await observerPool.query(
            "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
            [`agent_revision:${failed.id}:reconcile`],
          );
          return work.rows[0]?.state === "failed_permanent" ? work.rows[0] : undefined;
        },
        60_000,
      );
      assert.equal(failedWork.reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
      assert.equal(await missing("deployment", revisionName(replacement), placement), true);
      await assertHarnessWorkspaceClaim(
        placement,
        namespaceIds[0],
        first.id,
        replacementClaim.metadata.uid,
      );
      await kubectl(
        "exec",
        `deployment/${revisionName(failed)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "const fs=require('node:fs'); fs.writeFileSync('/home/node/workspace/failed-candidate.txt', 'preserved'); fs.unlinkSync('/home/node/workspace/.fixture-unready')",
      );
      const recovered = await deploy(namespaceIds[0], first.id);
      await waitForActive(namespaceIds[0], first.id, recovered.id);
      await waitFor("failed candidate to release its workspace", () =>
        missing("deployment", revisionName(failed), placement),
      );
      await assertHarnessWorkspaceClaim(
        placement,
        namespaceIds[0],
        first.id,
        replacementClaim.metadata.uid,
      );
      assert.equal(
        await kubectl(
          "exec",
          `deployment/${revisionName(recovered)}`,
          "-n",
          placement,
          "-c",
          "agent",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs'); process.stdout.write(fs.readFileSync('/home/node/workspace/replacement-proof.txt', 'utf8') + ':' + fs.readFileSync('/home/node/workspace/failed-candidate.txt', 'utf8'))",
        ),
        "retain across replacement:preserved",
      );
    }

    const adoptedOwned = await ownedComputeResources(
      existingName,
      adoptedTenant.id,
      adopted.data.id,
      true,
    );
    assert.ok(
      adoptedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `gateway-${hash(adoptedTenant.id)}-rev-${hash(restarted.id)}`,
      ),
    );
    if (runtimeImage !== undefined) {
      assert.ok(adoptedOwned.some(({ kind }) => kind === "networkpolicy"));
      assert.ok(adoptedOwned.some(({ kind }) => kind === "persistentvolumeclaim"));
    }
    assert.ok(
      adoptedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `plugin-runtime-${hash(adoptedTenant.id)}-rev-${hash(restarted.id)}`,
      ),
    );

    const updatedDedicated = await request(
      "PATCH",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
      { configurationId: adoptedTenant.configurationId, executionMode: "embedded" },
    );
    assert.equal(updatedDedicated.status, 200, JSON.stringify(updatedDedicated.error));
    // Public deletion of an active dedicated Agent must remove persisted ownership only after
    // every real Agent-owned Kubernetes effect, including its live Pods, has been removed.
    const deleting = await request(
      "DELETE",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
    );
    assert.equal(deleting.status, 202, JSON.stringify(deleting.error));
    assert.equal(deleting.data.status, "deleting");
    await waitFor(
      "running dedicated Agent deletion to finalize after Pod termination",
      async () => {
        const current = await request(
          "GET",
          `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
        );
        const ownedPods = (
          await Promise.all(
            [existingName, kubernetesGatewayNamespaceName(adopted.data.id)].map((target) =>
              resources("pods", target),
            ),
          )
        )
          .flat()
          .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id);
        return current.status === 404 && ownedPods.length === 0 ? true : undefined;
      },
    );
    for (const name of adoptedCredentialSecrets) {
      assert.equal(
        await missing("secret", name, kubernetesGatewayNamespaceName(adopted.data.id)),
        true,
      );
    }
    const deletedClaims = [adoptedWorkspace.metadata.name];
    if (runtimeImage !== undefined) {
      deletedClaims.push(`gateway-state-${hash(adoptedTenant.id)}`);
    }
    for (const name of deletedClaims) {
      assert.equal(
        await missing(
          "persistentvolumeclaim",
          name,
          name.startsWith("gateway-state-")
            ? kubernetesGatewayNamespaceName(adopted.data.id)
            : existingName,
        ),
        true,
      );
    }
    assert.equal(
      await missing(
        "deployment",
        gatewayName(adoptedTenant.id),
        kubernetesGatewayNamespaceName(adopted.data.id),
      ),
      true,
    );
    assert.equal(
      await missing(
        "service",
        gatewayName(adoptedTenant.id),
        kubernetesGatewayNamespaceName(adopted.data.id),
      ),
      true,
    );
    assert.equal(await missing("service", agentName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("serviceaccount", agentName(adoptedTenant.id), existingName), true);
    for (const { kind, name, namespace: target } of adoptedOwned) {
      assert.equal(await missing(kind, name, target), true, `${kind} ${name} remains`);
    }
    assert.equal(
      await state.read((view) =>
        view.revisions.findRevision(adopted.data.id, adoptedTenant.id, restarted.id),
      ),
      undefined,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      kubernetesGatewayNamespaceName(adopted.data.id),
    );
    await resource("namespace", existingName);
    await assertReadyGateway(placement, second.id, namespaceIds[0]);
  },
);
