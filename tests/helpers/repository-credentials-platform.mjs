import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signInWithEmailPassword, authenticatedHeaders } from "./auth-session.mjs";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  kubectlArguments,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { startControlResponseRelay } from "../fixtures/repository-credentials/control-relay.mjs";
import { startRepositoryPlatformWorker } from "./repository-credentials-platform-worker.mjs";
import { startRepositoryPlatformService } from "./repository-credentials-platform-service.mjs";

export const repositoryPlatformSelected =
  process.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM === "1";

const toolScript = String.raw`
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  const result = spawnSync(request.command, request.args, {
    cwd: request.cwd, env: process.env, encoding: "utf8", timeout: 45000,
    maxBuffer: 1048576,
  });
  process.stdout.write(JSON.stringify({code: result.status, stdout: result.stdout ?? ""}));
`;

const materialScript = String.raw`
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("/run/oce/repository-credentials/manifest.json", "utf8"));
  const bindings = manifest.bindings.map((binding) => {
    const names = ["bearer", "client.json", "gitconfig", "gh/hosts.yml", "gh/config.yml", "ca.pem"];
    const files = names.map((name) => {
      const stat = fs.lstatSync(binding.directory + "/" + name);
      return {name, regular: stat.isFile(), symbolicLink: stat.isSymbolicLink(), mode: stat.mode & 511};
    });
    const stat = fs.lstatSync(binding.directory);
    return {repositoryRef:binding.repositoryRef, sessionId:binding.sessionId,
      deadlineWallMs:binding.deadlineWallMs, directoryMode:stat.mode & 511, files};
  });
  console.log(JSON.stringify({generation:manifest.generation, bindings}));
`;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function gatewayTls(directory, host, execute) {
  const keyFile = join(directory, "gateway.key");
  const certFile = join(directory, "gateway.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "2",
    "-subj",
    "/CN=repository-credentials",
    "-addext",
    `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
  ]);
  await chmod(keyFile, 0o600);
  await chmod(certFile, 0o644);
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  return { key, cert, ca: cert, keyFile, certFile };
}

function schedulingFailureClasses(message) {
  if (typeof message !== "string") {
    return ["other"];
  }
  // Classify scheduler text without retaining node names, taint values, or messages.
  const patterns = [
    ["disk-pressure", /\bnode\.kubernetes\.io\/disk-pressure(?:[:\s},]|$)/i],
    ["memory-pressure", /\bnode\.kubernetes\.io\/memory-pressure(?:[:\s},]|$)/i],
    ["pid-pressure", /\bnode\.kubernetes\.io\/pid-pressure(?:[:\s},]|$)/i],
    ["not-ready", /\bnode\.kubernetes\.io\/not-ready(?:[:\s},]|$)/i],
    ["unreachable", /\bnode\.kubernetes\.io\/unreachable(?:[:\s},]|$)/i],
    [
      "cordoned",
      /\bnode\.kubernetes\.io\/unschedulable(?:[:\s},]|$)|\bnode\(s\) were unschedulable\b/i,
    ],
    ["control-plane", /\bnode-role\.kubernetes\.io\/(?:control-plane|master)(?:[:\s},]|$)/i],
    ["insufficient-cpu", /\bInsufficient cpu\b/i],
    ["insufficient-memory", /\bInsufficient memory\b/i],
    ["insufficient-ephemeral-storage", /\bInsufficient ephemeral-storage\b/i],
    ["insufficient-pods", /\b(?:Too many pods|Insufficient pods)\b/i],
    ["untolerated-taint", /\buntolerated taint\b/i],
  ];
  const classes = patterns.filter(([, pattern]) => pattern.test(message)).map(([name]) => name);
  return classes.length > 0 ? classes : ["other"];
}

function relayPodDiagnostic(pod) {
  const status = pod?.status;
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const scheduled = conditions.find((condition) => condition?.type === "PodScheduled");
  const containers = Array.isArray(status?.containerStatuses) ? status.containerStatuses : [];
  const relay = containers.find((container) => container?.name === "relay");
  const state = relay?.state;
  const terminated = state?.terminated ?? relay?.lastState?.terminated;
  const closed = (value, allowed) => (allowed.includes(value) ? value : "other");
  const integer = (value, maximum) =>
    Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
  const present = (value) => typeof value === "string" && value.length > 0;
  return {
    lookup: "found",
    phase: closed(status?.phase, ["Pending", "Running", "Succeeded", "Failed", "Unknown"]),
    scheduled: closed(scheduled?.status, ["True", "False", "Unknown"]),
    scheduledReason: closed(scheduled?.reason, ["Unschedulable", "SchedulingGated"]),
    schedulingFailures: schedulingFailureClasses(scheduled?.message),
    ready: closed(conditions.find(({ type }) => type === "Ready")?.status, [
      "True",
      "False",
      "Unknown",
    ]),
    containerState: ["waiting", "running", "terminated"].find((name) => state?.[name]) ?? "other",
    waitingReason: closed(state?.waiting?.reason, [
      "ContainerCreating",
      "PodInitializing",
      "ImagePullBackOff",
      "ErrImagePull",
      "InvalidImageName",
      "CreateContainerConfigError",
      "CreateContainerError",
      "RunContainerError",
      "CrashLoopBackOff",
    ]),
    terminationReason: closed(terminated?.reason, [
      "Completed",
      "Error",
      "OOMKilled",
      "ContainerCannotRun",
    ]),
    exitCode: integer(terminated?.exitCode, 255),
    restartCount: integer(relay?.restartCount, 2 ** 31 - 1),
    nodeAssigned: present(pod?.spec?.nodeName),
    imageIdPresent: present(relay?.imageID),
    containerIdPresent: present(relay?.containerID),
  };
}

function filesystemCounters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const integer = (field) => (Number.isSafeInteger(field) && field >= 0 ? field : undefined);
  return {
    availableBytes: integer(value.availableBytes),
    capacityBytes: integer(value.capacityBytes),
    inodesFree: integer(value.inodesFree),
    inodes: integer(value.inodes),
  };
}

function relayNodeDiagnostic(node) {
  const conditions = Array.isArray(node.status?.conditions) ? node.status.conditions : [];
  const condition = (type) => {
    const status = conditions.find((entry) => entry?.type === type)?.status;
    return ["True", "False", "Unknown"].includes(status) ? status : "other";
  };
  const categories = new Map([
    ["node.kubernetes.io/disk-pressure", "disk-pressure"],
    ["node.kubernetes.io/memory-pressure", "memory-pressure"],
    ["node.kubernetes.io/pid-pressure", "pid-pressure"],
    ["node.kubernetes.io/not-ready", "not-ready"],
    ["node.kubernetes.io/unreachable", "unreachable"],
    ["node.kubernetes.io/unschedulable", "cordoned"],
    ["node.kubernetes.io/network-unavailable", "network-unavailable"],
    ["node-role.kubernetes.io/control-plane", "control-plane"],
    ["node-role.kubernetes.io/master", "control-plane"],
    ["node.cloudprovider.kubernetes.io/uninitialized", "cloud-provider-uninitialized"],
    ["node.kubernetes.io/out-of-service", "out-of-service"],
    ["CriticalAddonsOnly", "critical-addons"],
  ]);
  const rawTaints = Array.isArray(node.spec?.taints) ? node.spec.taints : [];
  const taints = new Map();
  let unrecognizedTaintCount = 0;
  for (const taint of rawTaints) {
    const category = categories.get(taint?.key) ?? "other";
    const effect = ["NoSchedule", "NoExecute", "PreferNoSchedule"].includes(taint?.effect)
      ? taint.effect
      : "other";
    if (category === "other") {
      unrecognizedTaintCount += 1;
    }
    taints.set(`${category}/${effect}`, { category, effect });
  }
  return {
    lookup: "found",
    conditions: {
      ready: condition("Ready"),
      diskPressure: condition("DiskPressure"),
      memoryPressure: condition("MemoryPressure"),
      pidPressure: condition("PIDPressure"),
      networkUnavailable: condition("NetworkUnavailable"),
    },
    unschedulable: node.spec?.unschedulable === true,
    taints: [...taints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    taintCount: rawTaints.length,
    unrecognizedTaintCount,
  };
}

async function captureRelayNodeDiagnostic(execute, selection) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 9_000);
  const read = async (path) => {
    const { stdout } = await execute(
      "kubectl",
      kubectlArguments(selection, ["get", `--raw=${path}`, "--request-timeout=3s"]),
      { timeout: 4_000, signal: deadline.signal },
    );
    return JSON.parse(stdout);
  };
  try {
    // One response only: never select a node from a larger or paginated cluster.
    const list = await read("/api/v1/nodes?limit=2");
    if (
      !Array.isArray(list?.items) ||
      list.items.length !== 1 ||
      (list.metadata?.continue !== undefined && list.metadata.continue !== "")
    ) {
      return { lookup: "unavailable" };
    }
    const node = list.items[0];
    const name = node?.metadata?.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 253) {
      return { lookup: "unavailable" };
    }
    const diagnostic = relayNodeDiagnostic(node);
    if (
      diagnostic.conditions.diskPressure === "True" ||
      diagnostic.taints.some(({ category }) => category === "disk-pressure")
    ) {
      diagnostic.filesystems = { lookup: "unavailable" };
      try {
        // The node name and the summary's workload details stay inside this read.
        const summary = await read(`/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`);
        diagnostic.filesystems = {
          lookup: "found",
          nodeFs: filesystemCounters(summary?.node?.fs),
          imageFs: filesystemCounters(summary?.node?.runtime?.imageFs),
        };
      } catch {
        // Retain the node snapshot even when optional filesystem counters fail.
      }
    }
    return diagnostic;
  } catch {
    return { lookup: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function createRepositoryPlatformFixture(context) {
  const diagnostic = { kind: "repository-platform-setup", stage: "selection" };
  try {
    return await setupRepositoryPlatformFixture(context, diagnostic);
  } catch (cause) {
    const error = new Error("Repository platform setup failed.", { cause });
    error.openclawCiDiagnostic = diagnostic;
    throw error;
  }
}

async function setupRepositoryPlatformFixture(context, diagnostic) {
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  const image = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE;
  assert.match(
    image ?? "",
    /^\S+@sha256:[a-f0-9]{64}$/,
    "Select the immutable fixture-Harness image derived from the final runtime.",
  );
  const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
  assert.ok(databaseUrl, "OCC_TEST_DATABASE_URL is required for the actual PostgreSQL Work queue.");
  const database = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  assert.match(database.pathname, /^\/openclaw_k8s_[a-z0-9_]+$/);
  const relayHost = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS;
  assert.ok(isIPv4(relayHost ?? ""), "Select the owned k3d network's explicit host IPv4 address.");
  assert.match(
    relayHost,
    /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/,
    "The fixed fixture relay must target the private owned cluster network.",
  );

  const scope = createResourceScope({ cleanupTimeoutMs: 300_000 });
  context.after(() => scope.close());
  diagnostic.stage = "kubernetes-setup";
  const suffix = randomBytes(5).toString("hex");
  const system = `oce-repository-fixture-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-repository-platform-"));
  scope.after(() => rm(directory, { recursive: true, force: true }));
  const execute = (command, args, options = {}) =>
    run(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      timeout: 180_000,
      ...options,
    });
  const kubectl = async (...args) =>
    (await execute("kubectl", kubectlArguments(selection, args))).stdout;
  const kube = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 180_000,
    waitIntervalMs: 500,
  });
  const apply = (object) =>
    execute("kubectl", kubectlArguments(selection, ["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const ownedNamespaces = [system];
  const namespaceRole = `oce-repository-namespaces-${suffix}`;
  const tenantRole = `oce-repository-tenant-${suffix}`;
  scope.after(async () => {
    const cleanup = await Promise.allSettled([
      ...ownedNamespaces.map((name) =>
        kubectl("delete", "namespace", name, "--ignore-not-found", "--wait=true", "--timeout=120s"),
      ),
      kubectl("delete", "clusterrolebinding", namespaceRole, "--ignore-not-found"),
      kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found"),
    ]);
    const failures = cleanup.filter(({ status }) => status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "owned Kubernetes fixture cleanup failed",
      );
    }
  });
  await apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: system } });
  await apply({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "controller", namespace: system },
  });
  await apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name: namespaceRole },
    rules: [
      {
        apiGroups: [""],
        resources: ["namespaces"],
        verbs: ["get", "list", "create", "patch", "update", "delete"],
      },
    ],
  });
  await apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name: namespaceRole },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: namespaceRole },
    subjects: [{ kind: "ServiceAccount", name: "controller", namespace: system }],
  });
  await apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name: tenantRole },
    rules: [
      {
        apiGroups: [""],
        resources: [
          "pods",
          "services",
          "serviceaccounts",
          "configmaps",
          "secrets",
          "persistentvolumeclaims",
          "resourcequotas",
          "limitranges",
        ],
        verbs: ["get", "list", "create", "patch", "update", "delete"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        verbs: ["get", "list", "create", "patch", "update", "delete"],
      },
      {
        apiGroups: ["networking.k8s.io"],
        resources: ["networkpolicies"],
        verbs: ["get", "list", "create", "patch", "update", "delete"],
      },
      {
        apiGroups: ["discovery.k8s.io"],
        resources: ["endpointslices"],
        verbs: ["get", "list", "create", "patch", "update", "delete"],
      },
    ],
  });
  const cluster = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const token = (
    await kubectl("create", "token", "controller", "-n", system, "--duration=1h")
  ).trim();
  const controllerKubeconfig = join(directory, "controller-kubeconfig.json");
  await writeFile(
    controllerKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: cluster.clusters,
      users: [{ name: "controller", user: { token } }],
      contexts: [
        { name: "fixture", context: { cluster: cluster.clusters[0].name, user: "controller" } },
      ],
      "current-context": "fixture",
    }),
    { mode: 0o600 },
  );
  const authentication = {
    mode: "kubeconfig",
    kubeconfigPath: controllerKubeconfig,
    context: "fixture",
  };
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace: system,
    gatewayImage: image,
    codexImage: image,
    cluster: `repository-platform-${suffix}`,
  });
  const configFile = join(directory, "installation.json");
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
  const credentials = {
    email: "repository-platform@example.test",
    password: "repository-platform-fixture-password",
  };
  const authSecret = "repository-platform-auth-secret-minimum-thirty-two-bytes";
  const authBaseURL = "http://127.0.0.1";
  diagnostic.stage = "database-bootstrap";
  const [
    { default: pg },
    { loadInstallationConfiguration },
    { composeProduction },
    { kubernetesNamespaceName, kubernetesGatewayNamespaceName },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
  ]);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  scope.after(() => pool.end());
  assert.equal(
    (await pool.query("SELECT count(*)::integer AS count FROM occ.installation")).rows[0].count,
    0,
    "Select a freshly migrated disposable database without an Installation.",
  );
  await ensureDevelopmentBootstrap(scope, {
    databaseUrl,
    ...credentials,
    authSecret,
    authBaseURL,
    installationName: "Repository platform integration",
    environment: { PATH: process.env.PATH },
  });
  const bootstrapNamespaces = (await pool.query("SELECT id FROM occ.namespaces")).rows.flatMap(
    ({ id }) => [kubernetesNamespaceName(id), kubernetesGatewayNamespaceName(id)],
  );
  ownedNamespaces.push(...bootstrapNamespaces);
  let app;
  let worker;
  let endpoint;
  let session;
  const events = [];
  async function stopProcesses() {
    const currentWorker = worker;
    const currentApp = app;
    worker = undefined;
    app = undefined;
    const outcomes = await Promise.allSettled([currentWorker?.stop(), currentApp?.close()]);
    const failures = outcomes.filter(({ status }) => status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "platform process cleanup failed",
      );
    }
  }
  scope.after(stopProcesses);
  async function startWorker() {
    assert.equal(worker, undefined, "join the previous worker before replacement");
    worker = await startRepositoryPlatformWorker({ databaseUrl, configFile, events });
  }
  async function startProcesses() {
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: configFile },
    });
    app = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      drivers,
    });
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    session = await signInWithEmailPassword({ origin: endpoint, ...credentials });
    await startWorker();
  }
  async function request(method, path, payload, expected = 200) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: authenticatedHeaders(session, {
        origin: authBaseURL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      }),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = response.status === 204 ? undefined : await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path} returned ${response.status}: ${body?.error?.code ?? ""}`,
    );
    return body?.data;
  }
  diagnostic.stage = "controller-startup";
  await startProcesses();
  diagnostic.stage = "namespace-create";
  const namespace = await request(
    "POST",
    "/namespaces",
    { name: `repository-fixture-${suffix}` },
    201,
  );
  const placement = kubernetesNamespaceName(namespace.id);
  const controlPlacement = kubernetesGatewayNamespaceName(namespace.id);
  ownedNamespaces.push(placement, controlPlacement);
  diagnostic.stage = "namespace-provisioning";
  for (const tenant of [...bootstrapNamespaces, placement, controlPlacement]) {
    await kube.waitFor("worker-created tenant Namespace", async () => {
      const namespaces = JSON.parse(await kubectl("get", "namespaces", "-o", "json")).items;
      return namespaces.find(({ metadata }) => metadata.name === tenant);
    });
    await apply({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "controller", namespace: tenant },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: tenantRole },
      subjects: [{ kind: "ServiceAccount", name: "controller", namespace: system }],
    });
  }
  diagnostic.stage = "namespace-reconciliation";
  await kube.waitFor(
    "actual worker Namespace reconciliation",
    async () => (await request("GET", `/namespaces/${namespace.id}`)).status === "ready",
  );
  diagnostic.stage = "controller-stop";
  await stopProcesses();

  diagnostic.stage = "credential-service-startup";
  const gatewayHost = `repository-credentials.${system}.svc.cluster.local`;
  const tls = await gatewayTls(directory, gatewayHost, execute);
  const gatewayPort = await availablePort();
  const credentialsFixture = await startRepositoryPlatformService(scope, {
    namespaceId: namespace.id,
    signal: context.signal,
    tls,
    gateway: { publicOrigin: `https://${gatewayHost}`, listen: `0.0.0.0:${gatewayPort}` },
  });
  diagnostic.stage = "control-relay-startup";
  const control = await startControlResponseRelay(scope, {
    directory,
    target: credentialsFixture.config.gateway.controlSocket,
  });
  scope.after(stopProcesses);
  // This fixed relay only carries TLS bytes to this run's controlled service.
  // It has no client-selected destination and replaces no credential behavior.
  diagnostic.stage = "relay-creation";
  const relayLabels = { "app.kubernetes.io/name": `repository-relay-${suffix}` };
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "repository-relay", namespace: system, labels: relayLabels },
    spec: {
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
      containers: [
        {
          name: "relay",
          image,
          imagePullPolicy: "IfNotPresent",
          command: [
            "node",
            "-e",
            `const net=require('node:net');const server=net.createServer(client=>{const upstream=net.connect({host:${JSON.stringify(relayHost)},port:${gatewayPort}});client.pipe(upstream).pipe(client);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());});server.listen(8443,'0.0.0.0');process.on('SIGTERM',()=>server.close());`,
          ],
          ports: [{ containerPort: 8443 }],
          readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 1 },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "20m", memory: "32Mi" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
        },
      ],
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "repository-credentials", namespace: system },
    spec: { selector: relayLabels, ports: [{ port: 443, targetPort: 8443 }] },
  });
  diagnostic.stage = "relay-readiness";
  try {
    await kubectl(
      "wait",
      "--for=condition=Ready",
      "pod/repository-relay",
      "-n",
      system,
      "--timeout=120s",
    );
  } catch (error) {
    diagnostic.relayPod = { lookup: "unavailable" };
    try {
      // Capture only closed status fields before teardown removes this owned Pod.
      const { stdout } = await execute(
        "kubectl",
        kubectlArguments(selection, [
          "get",
          "pod",
          "repository-relay",
          "-n",
          system,
          "-o",
          "json",
          "--request-timeout=5s",
        ]),
        { timeout: 6_000 },
      );
      diagnostic.relayPod = relayPodDiagnostic(JSON.parse(stdout));
    } catch {
      // Best-effort diagnostics must preserve the original readiness failure.
    }
    diagnostic.relayNode = await captureRelayNodeDiagnostic(execute, selection);
    throw error;
  }
  diagnostic.stage = "controller-restart";
  configuration.provider = [
    {
      id: credentialsFixture.providerId,
      type: "github",
      configuration: { registryPath: credentialsFixture.registryFile },
      drivers: { repo: "repository-credentials" },
    },
  ];
  configuration.drivers.repo = {
    id: "repository-credentials",
    configuration: {
      controlSocket: control.socketPath,
      sessionDurationSeconds: 86400,
      publicCaPath: tls.certFile,
    },
  };
  configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: system,
    podLabels: relayLabels,
    port: 8443,
  };
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
  await startProcesses();

  const agents = [];
  scope.after(async () => {
    if (app === undefined) {
      return;
    }
    for (const agent of agents) {
      await request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, undefined, 202);
    }
    await kube.waitFor("all credential attempts to settle before fixture teardown", async () => {
      const result = await pool.query(
        "SELECT count(*)::integer AS count FROM occ.repository_session_attempts WHERE namespace_id=$1 AND phase IN ('opening','open','closing')",
        [namespace.id],
      );
      return result.rows[0].count === 0;
    });
  });
  async function createAgent(bindings) {
    const modelSecret = await request(
      "POST",
      `/namespaces/${namespace.id}/secrets`,
      { name: `model-${agents.length}`, value: "repository-platform-fixture-key" },
      201,
    );
    const configured = await request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      { kind: "agent", values: createHarnessConfiguration("openclaw", "repository-fixture") },
      201,
    );
    const agent = await request(
      "POST",
      `/namespaces/${namespace.id}/agents`,
      {
        name: `repository-agent-${agents.length}`,
        configurationId: configured.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
        repositoryBindings: bindings,
      },
      201,
    );
    agents.push(agent);
    await grantAgentSecretOperate(pool, agent, modelSecret.ref.id);
    await request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`, {});
    return agent;
  }
  async function readyPod(agent, revision, previousUid) {
    await kube.waitFor(
      "exact active AgentRevision",
      async () =>
        (await request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
          .activeRevisionId === revision.id,
    );
    return kube.waitFor("Ready Pod with current immutable revision and material", async () => {
      const pods = await kube.resources(
        "pods",
        placement,
        "-l",
        `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
      );
      const matches = pods.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.metadata.uid !== previousUid &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ) &&
          pod.spec.volumes.some(
            (volume) =>
              volume.configMap?.name ===
              `gateway-${kubernetesHash(agent.id)}-rev-${kubernetesHash(revision.id)}`,
          ),
      );
      assert.ok(matches.length <= 1, "exact revision has multiple Ready gateway Pods");
      return matches[0];
    });
  }
  async function podNode(pod, script, input) {
    return execute(
      "kubectl",
      kubectlArguments(selection, [
        "exec",
        "-i",
        "-n",
        placement,
        pod.metadata.name,
        "-c",
        "gateway",
        "--",
        "env",
        "-u",
        "OPENAI_API_KEY",
        "node",
        "-e",
        script,
      ]),
      { input, timeout: 90_000 },
    );
  }
  async function tool(
    pod,
    command,
    args,
    { cwd = "/home/node/.openclaw/workspace", expected = 0 } = {},
  ) {
    const result = JSON.parse(
      (await podNode(pod, toolScript, JSON.stringify({ command, args, cwd }))).stdout,
    );
    assert.ok(Number.isInteger(result.code), `${command} did not exit normally`);
    if (expected === "failure") {
      assert.notEqual(result.code, 0, `${command} unexpectedly succeeded`);
    } else {
      assert.equal(result.code, expected, `${command} returned an unexpected exit status`);
    }
    return result.stdout;
  }
  const material = async (pod) => JSON.parse((await podNode(pod, materialScript)).stdout);
  async function retainBearerProbe(pod, repositoryRef) {
    const snapshot = `/home/node/.openclaw/workspace/.credential-crash-${randomBytes(8).toString("hex")}`;
    const remove = `require("node:fs").rmSync(${JSON.stringify(snapshot)}, {recursive:true, force:true});`;
    let removed = false;
    scope.after(async () => {
      if (removed) {
        return;
      }
      const pods = await kube.resources(
        "pods",
        placement,
        "-l",
        `openclaw.dev/agent=${pod.metadata.labels["openclaw.dev/agent"]}`,
      );
      const running = pods.find(
        (entry) =>
          !entry.metadata.deletionTimestamp &&
          entry.status.containerStatuses?.some(
            (container) => container.name === "gateway" && container.state?.running,
          ),
      );
      if (running) {
        await podNode(running, remove);
      }
      // With no live Pod, the fixture's namespace/PVC cleanup owns this snapshot.
    });
    // The private snapshot survives Pod replacement on the owned workspace PVC.
    // Neither capture nor the later HTTPS probe returns the bearer to the parent.
    await podNode(
      pod,
      `
      const fs = require("node:fs");
      const manifest = JSON.parse(fs.readFileSync("/run/oce/repository-credentials/manifest.json", "utf8"));
      const binding = manifest.bindings.find(entry => entry.repositoryRef === ${JSON.stringify(repositoryRef)});
      fs.mkdirSync(${JSON.stringify(snapshot)}, {mode:0o700});
      fs.writeFileSync(${JSON.stringify(`${snapshot}/request.json`)}, JSON.stringify({
        bearer:fs.readFileSync(binding.directory + "/bearer", "utf8").trim(),
        client:JSON.parse(fs.readFileSync(binding.directory + "/client.json", "utf8")).client,
        ca:fs.readFileSync(binding.directory + "/ca.pem", "utf8")
      }), {mode:0o600, flag:"wx"});
    `,
    );
    return async (currentPod) => {
      const result = await podNode(
        currentPod,
        `
        const fs = require("node:fs");
        const https = require("node:https");
        (async () => {
          try {
            const saved = JSON.parse(fs.readFileSync(${JSON.stringify(`${snapshot}/request.json`)}, "utf8"));
            const result = await new Promise((resolve, reject) => {
              const request = https.request(saved.client.gatewayOrigin + "/repos/" + saved.client.repository,
                {ca:saved.ca, agent:false, signal:AbortSignal.timeout(5000),
                 headers:{authorization:"Bearer " + saved.bearer}}, response => {
                  let body = "";
                  response.on("data", chunk => {
                    body += chunk;
                    if (body.length > 4096) response.destroy(new Error("probe response limit"));
                  });
                  response.once("error", reject);
                  response.once("end", () => {
                    try {
                      if (!response.complete) throw new Error("incomplete probe");
                      resolve({status:response.statusCode, code:JSON.parse(body).error?.code});
                    } catch { reject(new Error("invalid probe response")); }
                  });
                });
              request.once("error", () => reject(new Error("probe transport failed")));
              request.end();
            });
            process.stdout.write(JSON.stringify(result));
          } finally { ${remove} }
        })().catch(() => {process.exitCode=1;});
      `,
      );
      removed = true;
      return JSON.parse(result.stdout);
    };
  }
  async function runningPodContainers(pod) {
    const node = pod.spec.nodeName;
    assert.ok(
      node.startsWith(`${selection.kubernetesContext}-`),
      "inspect only the selected k3d node",
    );
    const { stdout } = await execute("docker", ["exec", node, "crictl", "ps", "-o", "json"], {
      timeout: 15_000,
    });
    return JSON.parse(stdout)
      .containers.filter(
        (container) => container.labels["io.kubernetes.pod.uid"] === pod.metadata.uid,
      )
      .map(({ id }) => id)
      .sort();
  }
  async function workspaceVolume(pod, path) {
    const container = pod.spec.containers.find(({ name }) => name === "gateway");
    const mount = container.volumeMounts.find(({ mountPath }) => mountPath === path);
    assert.ok(mount, "the workspace must have its own persistent mount");
    const volume = pod.spec.volumes.find(({ name }) => name === mount.name);
    const claimName = volume.persistentVolumeClaim.claimName;
    const claims = await kube.resources("persistentvolumeclaims", placement);
    const claim = claims.find(({ metadata }) => metadata.name === claimName);
    assert.equal(claim.status.phase, "Bound");
    assert.ok(claim.metadata.uid);
    assert.ok(claim.spec.volumeName);
    return {
      name: claimName,
      uid: claim.metadata.uid,
      volume: claim.spec.volumeName,
      subPath: mount.subPath,
    };
  }
  const attempts = async (revision) =>
    (
      await pool.query(
        "SELECT namespace_id, agent_id, revision_id, repository_ref, admission_id, session_id, phase, deadline_wall_ms, live_revision_id, cleanup_context FROM occ.repository_session_attempts WHERE revision_id=$1 ORDER BY created_at, admission_id",
        [revision.id],
      )
    ).rows;
  return {
    namespace,
    placement,
    system,
    image,
    pool,
    kube,
    request,
    createAgent,
    readyPod,
    tool,
    podNode,
    material,
    retainBearerProbe,
    runningPodContainers,
    workspaceVolume,
    attempts,
    credentials: credentialsFixture,
    control,
    events,
    get workerPid() {
      return worker?.pid;
    },
    get endpoint() {
      return endpoint;
    },
    startWorker,
    killWorker: async () => {
      const receipt = await worker.kill();
      worker = undefined;
      return receipt;
    },
  };
}
