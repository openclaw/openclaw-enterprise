import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { normalizeOpenAiBaseUrl } from "../../apps/controller/src/drivers/openai-endpoint.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import {
  failureSecrets,
  maskPrivateKeyLines,
  newestMatchingLogLines,
  redactLogLine,
} from "../../scripts/ci/failure-redaction.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { connect, isIP, isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertExposedCodexInitializes,
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  createOpenShellServiceLoopbackLookup,
  OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY,
  openShellAgentName,
  openShellGatewayName,
  openshellHash as hash,
  failedRecoveryDiagnostic,
  outageAttemptRead,
  registerOpenShellInstallationCleanups,
} from "../helpers/openshell-kubernetes-real.mjs";
import {
  boundedTeardown,
  deleteNamespaceExplained,
  diagnosticDeadlineMs,
  diagnosticDeadlinePassed,
  diagnosticRequestTimeout,
  retryKubectlRead,
  withinDiagnosticDeadline,
} from "../helpers/kubernetes-real.mjs";
import {
  observeSandboxProbe,
  tokenEchoDigest,
  tokenEchoReply,
} from "../helpers/k3d-failure-diagnostics.mjs";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "../helpers/envoy-workspace-gateway.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import {
  defaultKeycloakImage,
  issueServingCertificate,
  keycloakServiceClient,
  keycloakUserClient,
  startKeycloak,
} from "../helpers/keycloak-real.mjs";

const executeFile = promisify(execFile);
const selectedScenario = process.env.OCC_TEST_OPENSHELL_SCENARIO ?? "full";
assert.ok(["full", "network-policy"].includes(selectedScenario), "Unknown OpenShell scenario.");
const networkPolicyOnly = selectedScenario === "network-policy";

const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? runtimeImage;
const codexImage =
  process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
  process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
  runtimeImage;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const openShellGatewayImage = process.env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE;
const openShellSandboxImage = process.env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE;
const openShellSupervisorImage = process.env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE;
const openShellHelmPath = process.env.OCC_TEST_OPENSHELL_HELM;
const openShellHelmChart = process.env.OCC_TEST_OPENSHELL_HELM_CHART;
const openShellWorkspaceHelmChart = process.env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART;
const openShellChartVersion = process.env.OCC_TEST_OPENSHELL_CHART_VERSION ?? "0.1.5";
const openShellRuntimeClass = process.env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox";
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);
const openShellModelBaseUrl = process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim() || undefined;
const modelCredentialVariable =
  process.env.OCC_TEST_OPENSHELL_HARNESS === "openclaw" || openShellModelBaseUrl !== undefined
    ? "OPENAI_API_KEY"
    : "CODEX_ACCESS_TOKEN";
const modelCredential = process.env[modelCredentialVariable];
const modelSourceType = modelCredentialVariable === "CODEX_ACCESS_TOKEN" ? "codex-pat" : "openai";
const modelSecretField =
  modelCredentialVariable === "CODEX_ACCESS_TOKEN" ? "access_token" : "api_key";
// The model source's endpoint, which bounds where OpenShell inserts the model key.
const modelBaseUrl = (
  openShellModelBaseUrl ??
  (modelSourceType === "codex-pat"
    ? "https://chatgpt.com/backend-api/codex"
    : "https://api.openai.com/v1")
).replace(/\/$/u, "");
const modelEndpoint = new URL(modelBaseUrl);
const modelPort = Number(modelEndpoint.port || 443);
// Codex hands a long command back to the model, which may reply and end the turn before the
// command ends. The tool upstream probe bounds its curl, and every turn waits for a command
// still running at turn end up to that bound plus a margin (finding 1630: a 20 s curl outlived
// a fixed 5 s wait). The grace is sized for that probe only; longer commands elsewhere in this
// suite can still outlive it and report an unknown outcome.
const toolProbeCurlMaxSeconds = 8;
const toolAEchoPath = "/echo-a";
const codexCommandGraceMs = (toolProbeCurlMaxSeconds + 6) * 1_000;
const selected =
  process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1" ||
  [
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl,
    openShellGatewayImage,
    openShellSandboxImage,
    openShellSupervisorImage,
    openShellHelmPath,
    openShellHelmChart,
    openShellWorkspaceHelmChart,
    openShellModelBaseUrl,
  ].some(Boolean);
const requiresOpenShellK3d = {
  skip: selected
    ? false
    : "Set OCC_TEST_OPENSHELL_K3D_REAL=1 with explicit k3d, PostgreSQL, OpenShell, real image, and model credential prerequisites.",
};
const installationName = "OpenClaw OpenShell SandboxDriver integration";
const authSecret = "openshell-sandbox-driver-auth-secret-32";
const authBaseURL = "http://127.0.0.1";
const adminCredentials = Object.freeze({
  email: "admin-openshell-sandboxdriver@example.test",
  password: "openshell-sandboxdriver-admin-password",
});
const credentialMountPath = "/run/enterprise-credentials";
const pluginRuntimeMountPath = "/etc/openclaw/plugin-runtime";
const runtimeAssetsMountPath = "/home/node/openclaw-runtime-assets";
const nativeTemporaryMountPath = "/tmp/openclaw-native-worker";
const nodeStateMountPath = "/home/node/.openclaw-node";
// Kubernetes Compute backs all of /home/node with an emptyDir; stock OpenShell has no equivalent,
// so the bridge stages the native state root where the Agent entrypoint publishes plugin skills.
const openclawHomeMountPath = "/home/node/.openclaw";
const bridgedNodeStateMountPath = "/openclaw-node-state";
const workspaceMountPath = "/home/node/workspace";
const bridgedWorkspaceSubPath = "workspace/openshell-home";
const demoStatePath = process.env.OCC_K3D_DEMO_STATE?.trim() || undefined;
const demoControlUiPort = 18_888;
const demoConsolePort = 18_889;
let resolveDemoStop;
const demoStopping = new Promise((resolve) => {
  resolveDemoStop = resolve;
});
if (demoStatePath !== undefined) {
  process.once("SIGINT", resolveDemoStop);
  process.once("SIGTERM", resolveDemoStop);
}
const portableCommandArgumentBytes = 30 * 1024;
const diagnosticQueryTimeoutMs = 3_000;
const observerPoolConnectionTimeoutMs = 5_000;
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

const fixture = createOpenShellKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
  openShellGatewayImage,
  openShellSandboxImage,
  openShellSupervisorImage,
  openShellRuntimeClass,
  openShellHelmPath,
  openShellHelmChart,
  openShellWorkspaceHelmChart,
  openShellChartVersion,
  codexCommandGraceMs,
});
const {
  kubectl,
  resource,
  resources,
  createControllerIdentity,
  waitFor,
  validateOpenShellPrerequisites,
  readAgentTransportCredentials,
  waitForOpenShellGateway,
  installOpenShellGateway,
  startOpenShellGatewayPortForward,
  waitForSandbox,
  waitForProviderHarnessPod,
  assertProviderOwnedHarness,
  assertWorkspaceMounts,
  assertApprovedOpenShellPrivileges,
  assertGatewayBootstrapPolicies,
  assertNoSecretBytes,
  requestCodexTurnFromGatewayPod,
  startGatewayPortForward,
} = fixture;

/**
 * The Kubernetes API server's Pod proxy source, which Compute admits to each workload's private
 * status port for deployment diagnostics and startup evidence. The lane runs one k3s server,
 * whose API server reaches a local Pod over the cni0 bridge, so the source is that bridge's
 * address, as `occ dev up` derives it. A configured lane value takes precedence.
 */
async function apiServerPodProxySourceCidrs() {
  const configured = (process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS ?? "")
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured;
  }
  const nodes = JSON.parse(await kubectl("get", "nodes", "-o", "json")).items;
  assert.equal(nodes.length, 1, "the OpenShell lane must run on one k3s server");
  const [network] = String(nodes[0].spec?.podCIDR ?? "").split("/");
  assert.ok(isIPv4(network), "the k3s server must have an IPv4 Pod CIDR");
  // Any Pod address on the node routes through the bridge; skip the network and bridge
  // addresses, which the kernel reports as local.
  const octets = network.split(".").map(Number);
  octets[3] += 2;
  const { stdout } = await executeFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "exec",
    nodes[0].metadata.name,
    "ip",
    "route",
    "get",
    octets.join("."),
  ]);
  const source = /\bdev\s+cni0\b.*\bsrc\s+(\S+)/u.exec(stdout)?.[1];
  assert.ok(isIPv4(source ?? ""), "the API server must reach local Pods over the cni0 bridge");
  return [`${source}/32`];
}

async function createScopedController(context, identifier, platformNamespace, kubeconfig) {
  const suffix = hash(identifier);
  const account = "openclaw-production-controller";
  const namespaceRole = `oce-openshell-namespaces-${suffix}`;
  const tenantRole = `oce-openshell-tenant-${suffix}`;
  const binding = `oce-openshell-controller-${suffix}`;
  const apiNamespaceRole = `oce-openshell-secret-namespaces-${suffix}`;
  const apiSecretRole = `oce-openshell-secrets-${suffix}`;
  const apiBinding = `oce-openshell-secret-api-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-openshell-controller-"));
  context.after(async () => {
    await kubectl("delete", "clusterrolebinding", binding, apiBinding, "--ignore-not-found=true");
    await kubectl(
      "delete",
      "clusterrole",
      namespaceRole,
      tenantRole,
      apiNamespaceRole,
      apiSecretRole,
      "--ignore-not-found=true",
    );
    await rm(directory, { recursive: true, force: true });
  });

  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    tenantRole,
    "--verb=create,get,list,patch,delete",
    "--resource=configmaps,serviceaccounts,services,resourcequotas,limitranges",
  );
  await kubectl(
    "patch",
    "clusterrole",
    tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "replace",
        path: "/rules",
        value: [
          {
            apiGroups: [""],
            resources: [
              "configmaps",
              "serviceaccounts",
              "services",
              "resourcequotas",
              "limitranges",
            ],
            verbs: ["get", "list", "create", "patch", "delete"],
          },
          // As the chart's tenant worker role: a Pod annotation syncs a running Gateway's
          // workspace node at once, and its private status port answers through the Pod proxy.
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "patch"] },
          { apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] },
          // The API's Compute Driver also runs as this identity, so it takes the runtime log
          // reads that the chart grants the API through its tenant API role.
          { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
          { apiGroups: [""], resources: ["events"], verbs: ["get", "list"] },
          {
            apiGroups: [""],
            resources: ["persistentvolumeclaims"],
            verbs: ["get", "create", "patch", "delete"],
          },
          {
            apiGroups: ["apps"],
            resources: ["deployments"],
            verbs: ["get", "list", "create", "patch", "delete"],
          },
          {
            apiGroups: ["networking.k8s.io"],
            resources: ["networkpolicies"],
            verbs: ["get", "list", "create", "patch", "delete"],
          },
          {
            apiGroups: ["discovery.k8s.io"],
            resources: ["endpointslices"],
            verbs: ["get", "list"],
          },
          {
            apiGroups: [""],
            resources: ["secrets"],
            verbs: ["get", "create", "update", "delete"],
          },
          {
            apiGroups: ["gateway.networking.k8s.io"],
            resources: ["httproutes"],
            verbs: ["get", "create", "patch", "delete"],
          },
          {
            apiGroups: ["gateway.envoyproxy.io"],
            resources: ["securitypolicies"],
            verbs: ["get", "create", "patch", "delete"],
          },
        ],
      },
    ]),
  );
  const identity = await createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account,
    clusterRole: namespaceRole,
    clusterRoleBinding: binding,
    context: `openshell-production-${suffix}`,
  });
  const tokenMintedAt = new Date().toISOString();
  await kubectl(
    "create",
    "clusterrole",
    apiNamespaceRole,
    "--verb=get,list",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    apiSecretRole,
    "--verb=get,create,patch,update,delete",
    "--resource=secrets",
  );
  const apiIdentity = await createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account: "openclaw-secret-api",
    clusterRole: apiNamespaceRole,
    clusterRoleBinding: apiBinding,
    context: `openshell-secret-api-${suffix}`,
  });
  return { ...identity, tokenMintedAt, tenantRole, apiSecretRole, apiIdentity };
}

function nativeCodexConfiguration(gatewayAuth) {
  const configuration = createHarnessConfiguration("codex", providerModel);
  if (gatewayAuth !== undefined) {
    configuration.gateway = {
      ...configuration.gateway,
      auth: {
        ...gatewayAuth.auth,
        password: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_PASSWORD",
        },
      },
      allowRealIpFallback: gatewayAuth.allowRealIpFallback,
      trustedProxies: gatewayAuth.trustedProxies,
    };
  }
  // Native Codex tools are one capability; a narrow allowlist disables that surface.
  // OpenShell supplies the filesystem and network boundaries verified below.
  configuration.tools = { profile: "full" };
  return configuration;
}

function nativeOpenClawConfiguration(gatewayAuth, controlUiOrigins = []) {
  const configuration = createHarnessConfiguration("openclaw", providerModel);
  configuration.models.providers.openai.baseUrl = modelBaseUrl;
  configuration.models.providers.openai.models[0].input = ["text", "image"];
  configuration.secrets = {
    providers: {
      model: {
        source: "env",
        allowlist: ["OPENAI_API_KEY"],
      },
    },
  };
  configuration.models.providers.openai.apiKey = {
    source: "env",
    provider: "model",
    id: "OPENAI_API_KEY",
  };
  if (gatewayAuth !== undefined) {
    configuration.gateway = {
      ...configuration.gateway,
      auth: {
        ...gatewayAuth.auth,
        password: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_PASSWORD",
        },
      },
      allowRealIpFallback: gatewayAuth.allowRealIpFallback,
      trustedProxies: gatewayAuth.trustedProxies,
      ...(controlUiOrigins.length === 0
        ? {}
        : { controlUi: { enabled: true, allowedOrigins: controlUiOrigins } }),
    };
  }
  return configuration;
}

function workspaceGatewayHostname(workspaceGateway) {
  return `occ-gateway-${hash(
    `${workspaceGateway.routing.gatewayNamespace}/${workspaceGateway.routing.gatewayName}`,
  )}.${workspaceGateway.routing.envoyNamespace}.svc.cluster.local`;
}

async function waitForLoopbackPort(port) {
  await waitFor("OpenShell host-side Gateway routing relay", async () => {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return true;
    } catch {
      return undefined;
    }
  });
}

async function waitForWorkspaceGatewayTls(hostname, port) {
  await waitFor("OpenShell host-side Gateway TLS path", async () => {
    try {
      await new Promise((resolve, reject) => {
        const socket = connectTls({ host: hostname, port, servername: hostname });
        const timeout = setTimeout(
          () => socket.destroy(new Error("Gateway TLS probe timed out.")),
          5_000,
        );
        timeout.unref();
        socket.once("secureConnect", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return true;
    } catch {
      return undefined;
    }
  });
}

async function startWorkspaceGatewayHostRelay(context, workspaceGateway) {
  const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
  // Docker Desktop and Podman Machine host networking stays in their Linux VM.
  // Publish to macOS loopback and use the engine's host alias for the port-forward.
  const usesContainerVm = process.platform === "darwin";
  const relayHost = usesContainerVm
    ? basename(containerEngine) === "podman"
      ? "host.containers.internal"
      : "host.docker.internal"
    : "127.0.0.1";
  const dockerRuntimeImage = process.env.OCC_DOCKER_RUNTIME_IMAGE;
  assert.ok(
    dockerRuntimeImage,
    "OCC_DOCKER_RUNTIME_IMAGE is required for the loopback-only Gateway routing relay.",
  );
  const gatewayHostname = workspaceGatewayHostname(workspaceGateway);
  const services = await resources(
    "services",
    workspaceGateway.routing.envoyNamespace,
    "-l",
    `gateway.envoyproxy.io/owning-gateway-namespace=${workspaceGateway.routing.gatewayNamespace},gateway.envoyproxy.io/owning-gateway-name=${workspaceGateway.routing.gatewayName}`,
  );
  const envoyService = services.find((service) =>
    service.spec?.ports?.some(({ port }) => port === 443),
  );
  assert.ok(envoyService, "the workspace Gateway must expose an Envoy HTTPS Service.");
  assert.match(
    envoyService.spec.clusterIP ?? "",
    /^(?:\d{1,3}\.){3}\d{1,3}$/,
    "the disposable k3d Gateway must expose an IPv4 ClusterIP.",
  );
  const endpointPort = usesContainerVm ? await availablePort() : 443;
  if (usesContainerVm) {
    const envoyHttpsPort = envoyService.spec.ports.find(({ port }) => port === 443);
    assert.ok(envoyHttpsPort, "the workspace Gateway Service must retain its HTTPS port.");
    await kubectl(
      "patch",
      "service",
      envoyService.metadata.name,
      "--namespace",
      workspaceGateway.routing.envoyNamespace,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/spec/ports/-",
          value: {
            name: "oce-host-relay",
            protocol: envoyHttpsPort.protocol ?? "TCP",
            port: endpointPort,
            targetPort: envoyHttpsPort.targetPort ?? envoyHttpsPort.port,
          },
        },
      ]),
    );
  }
  const relayPod = `oce-routing-relay-${hash(randomUUID())}`;
  const relayLabels = Object.entries(workspaceGateway.apiPodLabels)
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
  const inClusterRelayProgram = [
    'const net = require("node:net");',
    "const server = net.createServer((client) => {",
    `  const upstream = net.connect({ host: ${JSON.stringify(envoyService.spec.clusterIP)}, port: 443 });`,
    "  client.pipe(upstream).pipe(client);",
    '  client.on("error", () => upstream.destroy());',
    '  upstream.on("error", () => client.destroy());',
    "});",
    'server.listen(8443, "0.0.0.0");',
  ].join("\n");
  await kubectl(
    "run",
    relayPod,
    "--namespace",
    workspaceGateway.routing.gatewayNamespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    `--labels=${relayLabels}`,
    "--command",
    "--",
    "node",
    "-e",
    inClusterRelayProgram,
  );
  await kubectl(
    "wait",
    "--namespace",
    workspaceGateway.routing.gatewayNamespace,
    "--for=condition=Ready",
    `pod/${relayPod}`,
    "--timeout=180s",
  );
  const forwarding = await fixture.startPortForwardTarget(
    workspaceGateway.routing.gatewayNamespace,
    `pod/${relayPod}`,
    "0:8443",
  );
  const forwardedPort = Number(new URL(forwarding.url).port);
  const relayName = `oce-openshell-routing-${hash(randomUUID())}`;
  // Bind/startup failure must still close the forwarding process and owned relay.
  context.after(async () => {
    await Promise.allSettled([
      forwarding.stop(),
      executeFile(containerEngine, ["stop", "--timeout", "2", relayName]),
    ]);
  });
  const relayProgram = [
    'const net = require("node:net");',
    "const targetPort = Number(process.argv[1]);",
    "const server = net.createServer((client) => {",
    `  const upstream = net.connect({ host: ${JSON.stringify(relayHost)}, port: targetPort });`,
    "  client.pipe(upstream).pipe(client);",
    '  client.on("error", () => upstream.destroy());',
    '  upstream.on("error", () => client.destroy());',
    "});",
    `server.listen(443, ${JSON.stringify(usesContainerVm ? "0.0.0.0" : "127.0.0.1")});`,
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  await executeFile(containerEngine, [
    "run",
    "--rm",
    "-d",
    "--name",
    relayName,
    ...(usesContainerVm ? ["--publish", `127.0.0.1:${endpointPort}:443`] : ["--network", "host"]),
    "--user",
    "0",
    "--stop-timeout",
    "2",
    "--entrypoint",
    "node",
    dockerRuntimeImage,
    "-e",
    relayProgram,
    String(forwardedPort),
  ]);
  await delay(250);
  let relayRunning = false;
  try {
    const inspected = await executeFile(containerEngine, [
      "inspect",
      "--format={{.State.Running}}",
      relayName,
    ]);
    relayRunning = inspected.stdout.trim() === "true";
  } catch {
    // --rm removes a relay that cannot bind its loopback listener.
  }
  assert.equal(
    relayRunning,
    true,
    "the exact OpenShell host routing relay must own loopback port 443.",
  );
  const originalLookup = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (hostname !== gatewayHostname) {
      return originalLookup.call(dns, hostname, options, callback);
    }
    if (typeof options === "function") {
      return options(null, "127.0.0.1", 4);
    }
    if (options?.all === true) {
      return callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }
    return callback(null, "127.0.0.1", 4);
  };
  context.after(() => {
    dns.lookup = originalLookup;
  });
  await waitForLoopbackPort(endpointPort);
  await waitForWorkspaceGatewayTls(gatewayHostname, endpointPort);
  return endpointPort;
}

function summarizeWorkerEvent(event) {
  return Object.fromEntries(
    [
      "event",
      "operation",
      "revisionId",
      "outcome",
      "code",
      "attempt",
      "cause",
      "dependency",
      "method",
      "grpcStatus",
    ]
      .map((key) => [key, event[key]])
      .filter(([, value]) => typeof value === "string" || typeof value === "number"),
  );
}

// Identical events collapse into one entry with a count and their first and last receipt
// times, ordered by last receipt: a namespace.ensure retried every poll (finding 1532) would
// otherwise fill the list and push the persisted revision and queue state out of the message.
function summarizeWorkerEvents(events, revisionId, limit = 40) {
  const collapsed = new Map();
  for (const event of events) {
    const summary = summarizeWorkerEvent(event);
    if (
      summary.revisionId !== revisionId &&
      summary.event !== "worker.completed" &&
      summary.event !== "worker.error"
    ) {
      continue;
    }
    const key = JSON.stringify(summary);
    const previous = collapsed.get(key);
    collapsed.delete(key);
    collapsed.set(key, {
      ...summary,
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? event.observedAt,
      lastAt: event.observedAt,
    });
  }
  return [...collapsed.values()]
    .slice(-limit)
    .map(({ count, firstAt, lastAt, ...summary }) =>
      count === 1 ? { ...summary, at: lastAt } : { ...summary, count, firstAt, lastAt },
    );
}

async function diagnosticQuery(pool, text, values) {
  return pool.query({ text, values, query_timeout: diagnosticQueryTimeoutMs });
}

async function readWorkerRevisionState(pool, { namespaceId, agentId, revisionId }) {
  const [agent, revision, work] = await Promise.all([
    diagnosticQuery(
      pool,
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespaceId, agentId],
    ),
    diagnosticQuery(
      pool,
      `SELECT revision_number
       FROM occ.agent_revisions
       WHERE namespace_id = $1 AND agent_id = $2 AND id = $3`,
      [namespaceId, agentId, revisionId],
    ),
    diagnosticQuery(
      pool,
      `SELECT revision_id, namespace_target, state, attempt_count, completed_at IS NOT NULL AS completed
       FROM occ.controller_work
       WHERE namespace_id = $1 AND (revision_id = $2 OR agent_id = $3)
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 8`,
      [namespaceId, revisionId, agentId],
    ),
  ]);

  return {
    activeRevisionId: agent.rows[0]?.active_revision_id,
    revision: revision.rows[0]
      ? { revisionId, revisionNumber: revision.rows[0].revision_number }
      : undefined,
    queue: work.rows.map((row) => ({
      operation:
        row.revision_id === null
          ? row.namespace_target === null
            ? "work.reconcile"
            : `namespace.${row.namespace_target}`
          : "agent_revision.reconcile",
      revisionId: row.revision_id ?? undefined,
      state: row.state,
      attempt: row.attempt_count,
      completed: row.completed,
    })),
  };
}

// The reporter keeps 1,000 characters of each output line, so the persisted state comes before
// the event list. Returns the diagnostic for callers that also put it in a failure message.
async function writeWorkerCompletionDiagnostics(options) {
  let persisted;
  try {
    persisted = await readWorkerRevisionState(options.pool, options);
  } catch (error) {
    persisted = { readError: error?.name ?? "Error" };
  }
  const diagnostic = {
    operation: "agent_revision.reconcile",
    revisionId: options.revisionId,
    persisted,
    events: summarizeWorkerEvents(options.events, options.revisionId),
  };
  // The reporter cuts the line at 1,000 characters, so the events there run newest first.
  process.stderr.write(
    `OpenShell worker completion diagnostic: ${JSON.stringify({
      ...diagnostic,
      events: [...diagnostic.events].reverse(),
    })}\n`,
  );
  return diagnostic;
}

async function assertWorkerCompleted(options) {
  try {
    await waitFor(options.description, () =>
      options.events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === options.revisionId &&
          event.outcome === "success",
      ),
    );
  } catch (error) {
    await writeWorkerCompletionDiagnostics(options);
    throw error;
  }
}

// TODO(OpenShell native workload projections): remove this integration-only bridge once
// OpenShell can receive SecretKeyRefs, projected ServiceAccount tokens, and immutable
// plugin-runtime ConfigMaps directly from HarnessWorkloadRequirements.
function credentialJobName(revisionId) {
  return `openshell-cred-${hash(revisionId)}`;
}

function bridgedNodeStateParent(agentId) {
  return `.openclaw/openshell-bootstrap/nodes/${hash(agentId, 32)}`;
}

function pluginRuntimeConfigMapName(context) {
  return `plugin-runtime-${hash(context.revision.agentId)}-rev-${hash(context.revision.id)}`;
}

function optionalSecretEnvironment(requirements, name) {
  const variable = requirements.environment.find((entry) => entry.name === name);
  if (variable === undefined) {
    return undefined;
  }
  assert.ok(variable.valueFrom?.secretKeyRef, `${name} must come from an exact SecretKeyRef.`);
  return variable;
}

function literalEnvironment(requirements, name) {
  const variable = requirements.environment.find((entry) => entry.name === name);
  assert.equal(typeof variable?.value, "string", `${name} must be a literal environment value.`);
  assert.equal(variable.valueFrom, undefined, `${name} must not reference a Secret.`);
  return variable;
}

async function waitForCredentialJob(operatorKubernetes, context, name, namespaceName) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    const job = await operatorKubernetes.read({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { namespace: namespaceName, name },
    });
    const conditions = Array.isArray(job?.status?.conditions) ? job.status.conditions : [];
    if (
      conditions.some((condition) => condition.type === "Complete" && condition.status === "True")
    ) {
      return;
    }
    const failed = conditions.find(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );
    assert.equal(failed, undefined, `OpenShell bootstrap Job ${name} failed.`);
    await delay(750, undefined, { signal: context.signal });
  }
  assert.fail(`Timed out waiting for OpenShell bootstrap Job ${name}.`);
}

async function applyCredentialJob(operatorKubernetes, resource) {
  return operatorKubernetes.patch(
    resource,
    undefined,
    undefined,
    "openclaw-enterprise-compute",
    false,
    "application/apply-patch+yaml",
  );
}

async function deleteCredentialJob(
  operatorKubernetes,
  context,
  name,
  namespace = context.namespace.name,
) {
  await operatorKubernetes.delete({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { namespace, name },
  });
}

async function waitForCredentialJobDeletion(operatorKubernetes, context, name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    try {
      await operatorKubernetes.read({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { namespace: context.namespace.name, name },
      });
    } catch (error) {
      if (error.code === 404 || error.statusCode === 404) {
        return;
      }
      throw error;
    }
    await delay(250, undefined, { signal: context.signal });
  }
  assert.fail(`Timed out waiting for OpenShell bootstrap Job ${name} deletion.`);
}

function credentialBridgeResource(context, claimName, subPath) {
  const { uid: runtimeUser, gid: runtimeGroup } = OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY;
  const namespaceName = context.namespace.name;
  const name = credentialJobName(context.revision.id);
  const workloadIdentity = context.requirements.workloadIdentity;
  assert.ok(workloadIdentity, "the native compatibility bridge requires projected identity.");
  const servicePrincipalToken = workloadIdentity.token;
  assert.match(
    servicePrincipalToken.path,
    /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    "the OpenShell bridge requires a safe relative ServiceAccount token path.",
  );
  const tokenParent = servicePrincipalToken.path.includes("/")
    ? servicePrincipalToken.path.slice(0, servicePrincipalToken.path.lastIndexOf("/"))
    : ".";
  const appServerToken = optionalSecretEnvironment(context.requirements, "APP_SERVER_TOKEN");
  const needsPluginRuntime = context.revision.harness.id === "codex";
  const needsNativeTemporary = context.revision.harness.id === "openclaw";
  if (needsNativeTemporary) {
    assert.equal(
      literalEnvironment(context.requirements, "TMPDIR").value,
      nativeTemporaryMountPath,
    );
  }
  const nodeSetupCode = needsNativeTemporary
    ? undefined
    : optionalSecretEnvironment(context.requirements, "OPENCLAW_NODE_SETUP_CODE");
  const nodeCa = needsNativeTemporary
    ? undefined
    : literalEnvironment(context.requirements, "OPENCLAW_NODE_CA_PEM");
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: namespaceName,
      labels: {
        ...context.requirements.labels,
        "openclaw.dev/workload-role": "sandbox-bootstrap-bridge",
      },
      annotations: {
        "openclaw.dev/namespace-id": context.revision.namespaceId,
        "openclaw.dev/agent-id": context.revision.agentId,
        "openclaw.dev/revision-id": context.revision.id,
      },
    },
    spec: {
      backoffLimit: 0,
      // The copied ServiceAccount token remains bound to this completed Job's Pod.
      ttlSecondsAfterFinished: servicePrincipalToken.expirationSeconds,
      template: {
        metadata: {
          labels: {
            ...context.requirements.labels,
            "openclaw.dev/workload-role": "sandbox-bootstrap-bridge",
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: workloadIdentity.serviceAccountName,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: runtimeUser,
            runAsGroup: runtimeGroup,
            fsGroup: runtimeGroup,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "write-openshell-bootstrap",
              image: context.requirements.image,
              imagePullPolicy: "IfNotPresent",
              command: [
                "sh",
                "-ceu",
                [
                  "umask 077",
                  ...(needsPluginRuntime ? ["mkdir -p /bootstrap/plugin-runtime"] : []),
                  // Match Compute's Agent-scoped node identity so a replacement reconnects
                  // with the device already recorded by the Gateway instead of redeeming twice.
                  "mkdir -p /agent-node-state/node-state",
                  "mkdir -p /bootstrap/runtime-assets",
                  "mkdir -p /bootstrap/openclaw-home",
                  ...(needsNativeTemporary ? ["mkdir -p /bootstrap/native-tmp"] : []),
                  `mkdir -p /bootstrap/service-principal/${tokenParent}`,
                  "mkdir -p /workspace-home/openshell-home/.codex",
                  ...(needsPluginRuntime
                    ? ["chmod 0700 /bootstrap/plugin-runtime /bootstrap/service-principal"]
                    : ["chmod 0700 /bootstrap/service-principal"]),
                  "chmod 0700 /agent-node-state/node-state",
                  ...(needsNativeTemporary ? ["chmod 0700 /bootstrap/native-tmp"] : []),
                  "chmod 0600 /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem 2>/dev/null || true",
                  ...(needsPluginRuntime
                    ? [
                        "chmod 0600 /bootstrap/plugin-runtime/runtime.json /bootstrap/plugin-runtime/config.toml 2>/dev/null || true",
                      ]
                    : []),
                  `chmod 0600 /bootstrap/service-principal/${servicePrincipalToken.path} 2>/dev/null || true`,
                  ...(appServerToken === undefined
                    ? []
                    : ['printf "%s" "$APP_SERVER_TOKEN" > /bootstrap/app-server-token']),
                  ...(nodeSetupCode === undefined
                    ? []
                    : [
                        'printf "%s" "$OPENCLAW_NODE_SETUP_CODE" > /bootstrap/openclaw-node-setup-code',
                      ]),
                  ...(nodeCa === undefined
                    ? []
                    : ['printf "%s" "$OPENCLAW_NODE_CA_PEM" > /bootstrap/openclaw-node-ca.pem']),
                  ...(needsPluginRuntime
                    ? [
                        "cp /source-plugin-runtime/runtime.json /bootstrap/plugin-runtime/runtime.json",
                        "cp /source-plugin-runtime/config.toml /bootstrap/plugin-runtime/config.toml",
                      ]
                    : []),
                  `cp /source-service-principal/${servicePrincipalToken.path} /bootstrap/service-principal/${servicePrincipalToken.path}`,
                  ...(appServerToken === undefined
                    ? []
                    : ["chmod 0444 /bootstrap/app-server-token"]),
                  ...(nodeSetupCode === undefined
                    ? []
                    : ["chmod 0444 /bootstrap/openclaw-node-setup-code"]),
                  ...(nodeCa === undefined ? [] : ["chmod 0444 /bootstrap/openclaw-node-ca.pem"]),
                  ...(needsPluginRuntime
                    ? [
                        "chmod 0444 /bootstrap/plugin-runtime/runtime.json /bootstrap/plugin-runtime/config.toml",
                      ]
                    : []),
                  `chmod 0444 /bootstrap/service-principal/${servicePrincipalToken.path}`,
                  ...(needsPluginRuntime
                    ? ["chmod 0555 /bootstrap/plugin-runtime /bootstrap/service-principal"]
                    : ["chmod 0555 /bootstrap/service-principal"]),
                  "chmod 0700 /bootstrap/runtime-assets /bootstrap/openclaw-home",
                  "chmod 0700 /workspace-home/openshell-home /workspace-home/openshell-home/.codex",
                ].join("\n"),
              ],
              env: [
                ...(appServerToken === undefined ? [] : [appServerToken]),
                ...(nodeSetupCode === undefined ? [] : [nodeSetupCode]),
                ...(nodeCa === undefined ? [] : [nodeCa]),
              ],
              volumeMounts: [
                { name: "bootstrap", mountPath: "/bootstrap", subPath },
                { name: "bootstrap", mountPath: "/workspace-home", subPath: "workspace" },
                {
                  name: "node-state-bootstrap",
                  mountPath: "/agent-node-state",
                  subPath: bridgedNodeStateParent(context.revision.agentId),
                },
                ...(needsPluginRuntime
                  ? [
                      {
                        name: "plugin-runtime",
                        mountPath: "/source-plugin-runtime",
                        readOnly: true,
                      },
                    ]
                  : []),
                {
                  name: "service-principal",
                  mountPath: "/source-service-principal",
                  readOnly: true,
                },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
          volumes: [
            { name: "bootstrap", persistentVolumeClaim: { claimName } },
            { name: "node-state-bootstrap", persistentVolumeClaim: { claimName } },
            ...(needsPluginRuntime
              ? [
                  {
                    name: "plugin-runtime",
                    configMap: {
                      name: pluginRuntimeConfigMapName(context),
                      items: [
                        { key: "runtime.json", path: "runtime.json" },
                        { key: "config.toml", path: "config.toml" },
                      ],
                      optional: false,
                    },
                  },
                ]
              : []),
            {
              name: "service-principal",
              projected: {
                sources: [
                  {
                    serviceAccountToken: {
                      audience: servicePrincipalToken.audience,
                      expirationSeconds: servicePrincipalToken.expirationSeconds,
                      path: servicePrincipalToken.path,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

function inlineNodeProgramIndex(command) {
  assert.deepEqual(
    command.slice(0, RUNTIME_WRAPPER_COMMAND.length),
    [...RUNTIME_WRAPPER_COMMAND],
    "the OpenShell bridge expects the Compute runtime wrapper command.",
  );
  return RUNTIME_WRAPPER_COMMAND.length;
}

function assertNoProjectedAgentIdentity(pod) {
  const container = pod.spec.containers.find(({ name }) => name === "agent");
  assert.ok(container, "the OpenShell Sandbox must provide its Agent container.");
  assert.equal(
    (pod.spec.volumes ?? []).some(({ name }) => name === "openclaw-service-principal"),
    false,
    "disabled workload identity must not create an Agent token projection.",
  );
  assert.equal(
    (container.volumeMounts ?? []).some(
      ({ mountPath, name }) =>
        name === "openclaw-service-principal" ||
        mountPath === "/var/run/secrets/kubernetes.io/serviceaccount",
    ),
    false,
    "the Agent container must not receive projected or infrastructure ServiceAccount tokens.",
  );
}

function portableProgramPieces(program) {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of program) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > portableCommandArgumentBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  assert.ok(chunks.length > 0, "the OpenShell bridge requires a non-empty runtime entrypoint.");
  assert.equal(
    chunks.every((entry) => Buffer.byteLength(entry) <= portableCommandArgumentBytes),
    true,
    "every OpenShell runtime command chunk must remain below the upstream argument limit.",
  );
  return chunks;
}

function portableRuntimeCommand(command) {
  const programIndex = inlineNodeProgramIndex(command);
  const runtimeArguments = command.slice(programIndex);
  const nodeProgramLoader = nodeProgramArguments("")[0];
  if (runtimeArguments[0] === nodeProgramLoader) {
    // Preserve Compute's fixed loader while splitting the compressed payload below
    // OpenShell's smaller argument limit.
    const payload = runtimeArguments.slice(1).join("");
    return [
      ...command.slice(0, programIndex),
      runtimeArguments[0],
      ...portableProgramPieces(payload),
    ];
  }
  assert.equal(
    runtimeArguments.length,
    1,
    "the OpenShell bridge expects one inline Node program or the bounded program loader.",
  );
  return [
    ...command.slice(0, programIndex),
    'eval(process.argv.slice(1).join(""))',
    ...portableProgramPieces(runtimeArguments[0]),
  ];
}

function bridgeRequirements(context, claimName, subPath) {
  // The model key reaches Codex only through the Credential Gateway: Compute renders no model
  // Secret. The Sandbox receives the model source's attachment first, then one for each
  // other source the revision still holds; a withdrawn one is never re-attached.
  assert.equal(
    context.requirements.environment.some(({ name }) =>
      ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"].includes(name),
    ),
    false,
    "Compute must not project model credentials when a credential source authenticates the Harness.",
  );
  const attached = context.requirements.credentialAttachments.map(({ sourceId }) => sourceId);
  assert.equal(attached[0], context.revision.harnessAuth.sourceId);
  const admitted = (context.revision.credentialSources ?? [])
    .map(({ sourceId }) => sourceId)
    .filter((sourceId) => sourceId !== context.revision.harnessAuth.sourceId);
  assert.deepEqual(
    attached.slice(1),
    admitted.filter((sourceId) => attached.includes(sourceId)),
    "other attachments must follow the model source in admission order",
  );
  const workloadIdentity = context.requirements.workloadIdentity;
  assert.ok(workloadIdentity, "the native compatibility bridge requires projected identity.");
  const servicePrincipalToken = workloadIdentity.token;
  const appServerToken = optionalSecretEnvironment(context.requirements, "APP_SERVER_TOKEN");
  const needsPluginRuntime = context.revision.harness.id === "codex";
  const needsNativeTemporary = context.revision.harness.id === "openclaw";
  const effectiveNodeStateMountPath = needsNativeTemporary
    ? bridgedNodeStateMountPath
    : nodeStateMountPath;
  if (needsNativeTemporary) {
    assert.equal(
      literalEnvironment(context.requirements, "TMPDIR").value,
      nativeTemporaryMountPath,
    );
  }
  const nodeSetupCode = optionalSecretEnvironment(context.requirements, "OPENCLAW_NODE_SETUP_CODE");
  literalEnvironment(context.requirements, "OPENCLAW_NODE_CA_PEM");
  const credentialBootstrap = [
    // The Driver keeps launch-time TMPDIR at /tmp for the supervisor; after
    // launch, the native worker must use the private mount it owns.
    ...(needsNativeTemporary
      ? [`process.env.TMPDIR = ${JSON.stringify(nativeTemporaryMountPath)};`]
      : []),
    ...(appServerToken === undefined
      ? []
      : [
          `process.env.APP_SERVER_TOKEN = require("node:fs").readFileSync("${credentialMountPath}/app-server-token", "utf8");`,
        ]),
    ...(nodeSetupCode === undefined || needsNativeTemporary
      ? []
      : [
          `process.env.OPENCLAW_NODE_SETUP_CODE = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-setup-code", "utf8");`,
        ]),
    ...(needsNativeTemporary
      ? []
      : [
          `process.env.OPENCLAW_NODE_CA_PEM = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-ca.pem", "utf8");`,
        ]),
  ].join("\n");
  const runtimeCommand = structuredClone(context.requirements.command);
  const programIndex = inlineNodeProgramIndex(runtimeCommand);
  assert.equal(runtimeCommand[programIndex], nodeProgramArguments("")[0]);
  const runtimeProgram = inflateRawSync(
    Buffer.from(runtimeCommand.slice(programIndex + 1).join(""), "base64"),
  ).toString("utf8");
  // The Driver admits only the fixed loader; bootstrap belongs in its compressed program.
  runtimeCommand.splice(
    programIndex,
    runtimeCommand.length - programIndex,
    ...nodeProgramArguments(`${credentialBootstrap}\n${runtimeProgram}`),
  );
  const environment = context.requirements.environment
    .filter(
      ({ name }) =>
        name !== "APP_SERVER_TOKEN" &&
        (needsNativeTemporary ||
          !["OPENCLAW_NODE_SETUP_CODE", "OPENCLAW_NODE_CA_PEM"].includes(name)),
    )
    .map((entry) => {
      if (entry.name === "HOME") {
        return { name: "HOME", value: "/home/node/workspace" };
      }
      if (entry.name === "CODEX_HOME") {
        return { name: "CODEX_HOME", value: "/home/node/workspace/.codex" };
      }
      if (needsNativeTemporary && entry.name === "OPENCLAW_NODE_STATE_DIR") {
        // Stock OpenShell runs the Agent as 10001 while /home/node belongs to the image user.
        // A root-level mount keeps secure workspace-transfer ancestry root/current-user owned.
        return { name: entry.name, value: bridgedNodeStateMountPath };
      }
      if (needsNativeTemporary && entry.name === "NODE_COMPILE_CACHE") {
        return { name: entry.name, value: `${bridgedNodeStateMountPath}/.cache/node-compile` };
      }
      return entry;
    });
  return {
    ...context.requirements,
    workloadIdentity: undefined,
    command: portableRuntimeCommand(runtimeCommand),
    environment,
    workspaceMounts: [
      ...context.requirements.workspaceMounts.filter(
        ({ mountPath }) => mountPath !== workspaceMountPath && mountPath !== nodeStateMountPath,
      ),
      {
        claimName,
        subPath: bridgedWorkspaceSubPath,
        mountPath: workspaceMountPath,
        readOnly: false,
      },
      {
        claimName,
        subPath: `${bridgedNodeStateParent(context.revision.agentId)}/node-state`,
        mountPath: effectiveNodeStateMountPath,
        readOnly: false,
      },
      // Native enrollment uses the real Driver's provider-managed files, so it needs
      // no duplicate bootstrap mount in OpenShell's reserved /run control directory.
      ...(needsNativeTemporary
        ? []
        : [{ claimName, subPath, mountPath: credentialMountPath, readOnly: true }]),
      ...(needsPluginRuntime
        ? [
            {
              claimName,
              subPath: `${subPath}/plugin-runtime`,
              mountPath: pluginRuntimeMountPath,
              readOnly: true,
            },
          ]
        : []),
      {
        claimName,
        subPath: `${subPath}/service-principal`,
        mountPath: servicePrincipalToken.mountPath,
        readOnly: true,
      },
      {
        claimName,
        subPath: `${subPath}/runtime-assets`,
        mountPath: runtimeAssetsMountPath,
        readOnly: false,
      },
      ...(needsNativeTemporary
        ? [
            {
              claimName,
              subPath: `${subPath}/native-tmp`,
              mountPath: nativeTemporaryMountPath,
              readOnly: false,
            },
          ]
        : []),
      {
        claimName,
        subPath: `${subPath}/openclaw-home`,
        mountPath: openclawHomeMountPath,
        readOnly: false,
      },
      ...(needsPluginRuntime
        ? [
            {
              claimName,
              subPath: `${bridgedWorkspaceSubPath}/.codex`,
              mountPath: "/home/node/.codex",
              readOnly: false,
            },
          ]
        : []),
    ],
  };
}

function integrationGatewayClient(
  GrpcOpenShellGatewayClient,
  endpoint,
  context,
  { observeServiceUrl },
) {
  const gateway = new GrpcOpenShellGatewayClient({ endpoint });
  // Only Sandbox creation and service lookup are observed. Every other call, including the
  // runtime provider-profile setup the Driver performs while provisioning, reaches the real
  // gateway client unchanged.
  const observed = {
    async createSandbox(request, signal) {
      const created = await gateway.createSandbox(request, signal);
      observeServiceUrl(created.serviceUrls[""]);
      return created;
    },
    async getServiceUrl(request, signal) {
      const serviceUrl = await gateway.getServiceUrl(request, signal);
      if (serviceUrl !== undefined) {
        observeServiceUrl(serviceUrl);
      }
      return serviceUrl;
    },
  };
  return new Proxy(gateway, {
    get(target, property) {
      if (Object.hasOwn(observed, property)) {
        return observed[property];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The supervisor gives Harness processes an OpenShell placeholder and resolves it only in the
// egress proxy. Only a digest crosses into the Pod, and only shapes come back, so neither the
// command line nor a failure can expose the key.
async function assertModelKeyIsPlaceholderOnly(namespace, pod, modelKey) {
  const container = pod.spec.containers.find(({ name }) => name === "agent");
  assert.ok(container, "the OpenShell Sandbox must provide its Agent container.");
  const script = [
    'const fs = require("node:fs");',
    'const { createHash } = require("node:crypto");',
    "const keyDigest = process.argv[1];",
    'const digest = (value) => createHash("sha256").update(value).digest("hex");',
    "const values = [];",
    "let leaked = false;",
    'for (const entry of fs.readdirSync("/proc")) {',
    "  if (!/^[0-9]+$/.test(entry)) continue;",
    "  let environ;",
    '  try { environ = fs.readFileSync(`/proc/${entry}/environ`, "utf8"); } catch { continue; }',
    '  for (const variable of environ.split("\\0")) {',
    '    const separator = variable.indexOf("=");',
    "    if (separator > 0 && digest(variable.slice(separator + 1)) === keyDigest) leaked = true;",
    `    if (variable.startsWith(${JSON.stringify(modelCredentialVariable + "=")})) values.push(variable.slice(${modelCredentialVariable.length + 1}));`,
    "  }",
    "}",
    ...(modelSourceType === "codex-pat"
      ? [
          'const auth = JSON.parse(fs.readFileSync("/sandbox/.openclaw-runtime/home/.codex/auth.json", "utf8"));',
          'if (digest(auth.personal_access_token ?? "") === keyDigest) leaked = true;',
          'values.push(auth.personal_access_token ?? "");',
        ]
      : []),
    "process.stdout.write(JSON.stringify({",
    "  leaked,",
    "  count: values.length,",
    '  placeholders: values.every((value) => value.startsWith("openshell:resolve:env:")),',
    "}));",
  ].join("\n");
  const observed = JSON.parse(
    await kubectl(
      "exec",
      pod.metadata.name,
      "--namespace",
      namespace,
      "--container",
      container.name,
      "--",
      "node",
      "-e",
      script,
      createHash("sha256").update(modelKey).digest("hex"),
    ),
  );
  assert.equal(observed.leaked, false, "no Harness process environment may hold the model key.");
  assert.ok(observed.count > 0, "the Harness must receive the OpenShell credential placeholder.");
  assert.equal(
    observed.placeholders,
    true,
    "The model credential must be an OpenShell placeholder.",
  );
}

async function assertBridgedServicePrincipalToken(namespace, pod, expected) {
  const container = pod.spec.containers.find(({ name }) => name === "agent");
  assert.ok(container, "the OpenShell Sandbox must provide its Agent container.");
  const mounts = (container.volumeMounts ?? []).filter(
    ({ mountPath }) => mountPath === "/var/run/secrets/openclaw/service-principal",
  );
  assert.equal(mounts.length, 1, "the bridged Harness requires its Agent token mount.");
  assert.equal(mounts[0].readOnly, true);
  const volume = (pod.spec.volumes ?? []).find(({ name }) => name === mounts[0].name);
  assert.ok(
    volume?.persistentVolumeClaim,
    "stock OpenShell must receive the test-only ServiceAccount token through the shared PVC.",
  );

  // Validate the copied token without exposing it. This proves the bridge used the exact Agent
  // ServiceAccount and audience, but intentionally does not claim native kubelet projection.
  const script = [
    'const token = require("node:fs").readFileSync(process.argv[1], "utf8").trim();',
    'const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());',
    "process.stdout.write(JSON.stringify({ aud: claims.aud, sub: claims.sub }));",
  ].join(" ");
  const claims = JSON.parse(
    await kubectl(
      "exec",
      pod.metadata.name,
      "--namespace",
      namespace,
      "--container",
      container.name,
      "--",
      "node",
      "-e",
      script,
      "/var/run/secrets/openclaw/service-principal/token",
    ),
  );
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  assert.deepEqual(audiences, [expected.audience]);
  assert.equal(claims.sub, `system:serviceaccount:${namespace}:${pod.spec.serviceAccountName}`);
}

function bridgedHarnessContainer(pod) {
  const container = pod.spec.containers.find(({ name }) => name === "agent");
  assert.ok(container, "the provider-owned Pod must contain the OpenShell Agent container.");
  for (const name of ["APP_SERVER_TOKEN", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) {
    assert.equal(
      (container.env ?? []).some((entry) => entry.name === name),
      false,
      `${name} must not remain in the stock OpenShell Pod environment.`,
    );
  }
  return container;
}

function assertBridgedNativeStateMount(pod) {
  const container = bridgedHarnessContainer(pod);
  const environment = container.env ?? [];
  assert.equal(
    environment.find(({ name }) => name === "OPENCLAW_NODE_STATE_DIR")?.value,
    bridgedNodeStateMountPath,
    "the native bridge must keep secure state ancestry outside the image-owned home directory.",
  );
  assert.equal(
    environment.find(({ name }) => name === "NODE_COMPILE_CACHE")?.value,
    `${bridgedNodeStateMountPath}/.cache/node-compile`,
  );
  const nativeInference = JSON.parse(
    environment.find(({ name }) => name === "OPENCLAW_NATIVE_INFERENCE_CONFIG")?.value,
  );
  assert.equal(
    nativeInference.models.providers.openai.baseUrl,
    normalizeOpenAiBaseUrl(modelBaseUrl),
  );
  assert.equal(nativeInference.models.providers.openai.models[0].id, providerModel);
  assert.deepEqual(nativeInference.models.providers.openai.apiKey, {
    source: "env",
    provider: "model",
    id: "OPENAI_API_KEY",
  });
  const mounts = container.volumeMounts ?? [];
  assert.equal(
    mounts.some(
      ({ mountPath, readOnly }) => mountPath === bridgedNodeStateMountPath && readOnly !== true,
    ),
    true,
    "the native bridge requires Agent-scoped writable node state.",
  );
  assert.equal(
    mounts.some(({ mountPath }) => mountPath === nodeStateMountPath),
    false,
    "the native bridge must not retain the mixed-owner image-home state mount.",
  );
}

function throwOpenShellAbortReason(signal) {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason ?? new Error("OpenShell management port-forward operation was aborted.");
}

function createIntegrationSandboxDriverFactory(
  OpenShellSandboxDriver,
  GrpcOpenShellGatewayClient,
  OpenShellGateway,
  operatorKubernetes,
  { enableCompatibilityBridges, gatewayTrustPem },
) {
  const gatewayState = new Map();
  const endpointClients = new Map();
  const policyWrites = [];
  let policyWriteBarrier;
  let backendDrivers;

  function clientForEndpoint(endpoint) {
    const existing = endpointClients.get(endpoint);
    if (existing !== undefined) {
      return existing;
    }
    // OCC reports gateway failures only as DEPENDENCY_UNAVAILABLE. Record which call failed and
    // its gRPC status, never request contents, so a registration regression is actionable.
    const client = new GrpcOpenShellGatewayClient({ endpoint });
    const created = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args) => {
          try {
            if (property === "updatePolicy") {
              policyWrites.push({ sandbox: args[0].sandbox, requestId: args[0].requestId });
            }
            const result = await value.apply(target, args);
            if (property === "updatePolicy") {
              await policyWriteBarrier?.(args[1]);
            }
            return result;
          } catch (error) {
            process.stderr.write(
              `OpenShell gateway ${String(property)} failed: ${error?.code ?? ""} ${error?.details ?? error?.message}\n`,
            );
            throw error;
          }
        };
      },
    });
    endpointClients.set(endpoint, created);
    return created;
  }

  // Each namespace owns a disposable gateway reached through its current port-forward, so the
  // shared Backend resolves that endpoint at call time for the Credential Gateway Driver.
  const createBackend = (definition) => {
    backendDrivers = definition.drivers;
    return Object.freeze({
      id: definition.id,
      drivers: definition.drivers,
      client: {
        placement(namespaceName) {
          if (namespaceName === undefined) {
            return undefined;
          }
          // Match the real per-Namespace Helm release, preserving the Backend's host checks.
          return new OpenShellGateway({
            serviceName: `openshell-${hash(namespaceName, 10)}`,
          }).placement(namespaceName);
        },
        clientForNamespace(namespaceName) {
          const state = gatewayState.get(namespaceName);
          assert.ok(state, `OpenShell gateway for namespace ${namespaceName} was not initialized.`);
          return clientForEndpoint(state.endpoint);
        },
        close() {
          for (const client of endpointClients.values()) {
            client.close();
          }
          endpointClients.clear();
        },
      },
    });
  };
  const provisioningFailures = new Map();
  const harnessServiceUrls = new Map();
  const credentialBridges = new Map();

  async function stopGatewayForward(namespaceName, expectedState) {
    const state = gatewayState.get(namespaceName);
    if (state === undefined || (expectedState !== undefined && state !== expectedState)) {
      return;
    }
    gatewayState.delete(namespaceName);
    await state.forward.stop();
  }

  async function disposeGatewayForwards() {
    const cleanup = await Promise.allSettled(
      [...gatewayState.entries()].map(([namespaceName, state]) =>
        stopGatewayForward(namespaceName, state),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason));
    }
  }

  // TODO(OpenShell per-Sandbox ServiceAccount support): stop reconfiguring the namespace gateway
  // once the upstream gateway can bind each Sandbox to Compute's exact Agent ServiceAccount.
  function agentSandboxServiceAccount(context) {
    return (
      context.requirements?.workloadIdentity?.serviceAccountName ??
      openShellAgentName(context.revision.agentId)
    );
  }

  async function endpointForNamespace(context, { sandboxServiceAccountName, exact = false } = {}) {
    const namespaceName = context.namespace.name;
    throwOpenShellAbortReason(context.signal);
    const prior = gatewayState.get(namespaceName);
    if (prior !== undefined && prior.sandboxServiceAccountName === sandboxServiceAccountName) {
      return prior.endpoint;
    }
    // The gateway applies its one configured ServiceAccount to every Sandbox it creates. Once
    // it runs an Agent's, a later Agent without a requested workload identity shares it, as on
    // a deployed gateway; reinstalling would restart the gateway under the running Sandboxes.
    if (!exact && prior?.sandboxServiceAccountName !== undefined) {
      return prior.endpoint;
    }

    await stopGatewayForward(namespaceName, prior);
    let ownedState;
    const stopOwnedForward = () => {
      if (ownedState === undefined) {
        return;
      }
      void stopGatewayForward(namespaceName, ownedState).catch((error) => {
        process.stderr.write(
          `OpenShell management port-forward abort cleanup failed for ${namespaceName}: ${error.message}\n`,
        );
      });
    };
    context.signal.addEventListener("abort", stopOwnedForward, { once: true });
    try {
      throwOpenShellAbortReason(context.signal);
      await installOpenShellGateway(namespaceName, {
        sandboxServiceAccountName,
        ...(gatewayTrustPem === undefined ? {} : { extraTrustPem: gatewayTrustPem }),
      });
      throwOpenShellAbortReason(context.signal);
      const forward = await startOpenShellGatewayPortForward(namespaceName);
      ownedState = { endpoint: forward.url, forward, sandboxServiceAccountName };
      gatewayState.set(namespaceName, ownedState);
      if (context.signal.aborted) {
        await stopGatewayForward(namespaceName, ownedState);
        throwOpenShellAbortReason(context.signal);
      }
      return ownedState.endpoint;
    } catch (error) {
      if (ownedState !== undefined) {
        await stopGatewayForward(namespaceName, ownedState);
      }
      throw error;
    } finally {
      // Once established, the shared management connection belongs to this fixture.
      // Worker restarts cancel an operation, but the API still needs the same gateway.
      context.signal.removeEventListener("abort", stopOwnedForward);
    }
  }

  function existingEndpointForNamespace(context) {
    const namespaceName = context.namespace.name;
    const state = gatewayState.get(namespaceName);
    assert.ok(
      state,
      `OpenShell gateway endpoint for namespace ${namespaceName} was not initialized.`,
    );
    return state.endpoint;
  }

  const createDriver = (selection) => {
    function optionsFor(requirements, namespaceName) {
      const options = structuredClone(selection.configuration);
      options.gateway.readiness = {
        ...options.gateway.readiness,
        serviceName: `openshell-${hash(namespaceName, 10)}`,
      };
      if (requirements !== undefined) {
        const workspace = requirements.workspaceMounts.find(
          ({ mountPath }) => mountPath === workspaceMountPath,
        );
        assert.ok(workspace, "OpenShell requires the Agent shared workspace mount.");
        options.kubernetes.sandboxDataMount = {
          claimName: workspace.claimName,
          subPath: workspace.subPath,
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        };
      }
      return options;
    }

    function backendFor(gatewayClient) {
      assert.ok(backendDrivers, "The OpenShell Backend must be composed before its Sandbox.");
      return Object.freeze({
        id: "openshell",
        drivers: backendDrivers,
        client: new OpenShellGateway({ endpoint: "http://127.0.0.1:1" }, { gatewayClient }),
      });
    }

    function delegate(requirements, namespaceName, endpoint, context) {
      const gatewayClient =
        context === undefined
          ? clientForEndpoint(endpoint)
          : integrationGatewayClient(GrpcOpenShellGatewayClient, endpoint, context, {
              enableCompatibilityBridge: enableCompatibilityBridges,
              observeServiceUrl: (serviceUrl) => {
                harnessServiceUrls.set(context.revision.id, serviceUrl);
              },
            });
      const options = optionsFor(requirements, namespaceName);
      if (enableCompatibilityBridges && context !== undefined) {
        // The bridge removes projected-token requirements for upstream OpenShell;
        // workspace preparation must still use the existing Compute-owned identity.
        options.gateway.operatorWorkspaceResources = [
          ...(options.gateway.operatorWorkspaceResources ?? []),
          {
            apiVersion: "v1",
            kind: "ServiceAccount",
            metadata: { name: agentSandboxServiceAccount(context), namespace: namespaceName },
          },
        ];
      }
      return new OpenShellSandboxDriver(options, {
        id: selection.id,
        implementation: "openshell",
        backend: backendFor(gatewayClient),
      });
    }

    // Preserve the real Driver's HOME so Compute and the Harness agree on hook paths.
    // These configuration and identity methods perform no gateway I/O.
    const configurationDriver = new OpenShellSandboxDriver(selection.configuration, {
      id: selection.id,
      implementation: "openshell",
      backend: backendFor(undefined),
    });
    return {
      id: selection.id,
      capability: "sandbox",
      implementation: selection.implementation,
      facets: Object.freeze(["networking", "filesystem", "process"]),
      networkPolicy: { live: true, wildcards: true, portRanges: true },
      admitNetworkPolicy(additions, version, defaults) {
        return new OpenShellSandboxDriver(selection.configuration, {
          id: selection.id,
          implementation: "openshell",
          backend: backendFor(undefined),
        }).admitNetworkPolicy(additions, version, defaults);
      },
      async observeNetworkPolicy(context, snapshot) {
        return delegate(
          undefined,
          context.namespace.name,
          existingEndpointForNamespace(context),
        ).observeNetworkPolicy(context, snapshot);
      },
      async applyNetworkPolicy(context, input) {
        return delegate(
          undefined,
          context.namespace.name,
          existingEndpointForNamespace(context),
        ).applyNetworkPolicy(context, input);
      },
      async readPolicyRecommendations(context, limit) {
        return delegate(
          undefined,
          context.namespace.name,
          existingEndpointForNamespace(context),
        ).readPolicyRecommendations(context, limit);
      },
      async readSandboxLogs(context, query) {
        return delegate(
          undefined,
          context.namespace.name,
          existingEndpointForNamespace(context),
        ).readSandboxLogs(context, query);
      },
      harnessHome: configurationDriver.harnessHome,
      configureAgent(configuration, harness) {
        return configurationDriver.configureAgent(configuration, harness);
      },
      validateWorkspaceSetup(harness, configuration) {
        return configurationDriver.validateWorkspaceSetup(harness, configuration);
      },
      harnessResource(context) {
        return configurationDriver.harnessResource(context);
      },
      async ensureNamespace(context) {
        try {
          const endpoint = await endpointForNamespace(context);
          await delegate(undefined, context.namespace.name, endpoint).ensureNamespace(context);
        } catch (error) {
          process.stderr.write(
            `OpenShell namespace bootstrap failed for ${context.namespace.name}: ${error.message}\n`,
          );
          throw error;
        }
      },
      async provisionHarness(context) {
        if (
          enableCompatibilityBridges &&
          optionalSecretEnvironment(context.requirements, "OPENCLAW_NODE_SETUP_CODE") === undefined
        ) {
          throw new Error(
            "The OpenShell compatibility proof is waiting for the Gateway node setup projection.",
          );
        }
        let bridge;
        try {
          if (!enableCompatibilityBridges) {
            // The gateway binds every Sandbox to one ServiceAccount, so reconfigure it for the
            // Agent's own ServiceAccount, as the bridge path does. Without projected workload
            // identity Compute renders no identity, but the Agent ServiceAccount still exists.
            const endpoint = await endpointForNamespace(context, {
              sandboxServiceAccountName: agentSandboxServiceAccount(context),
              exact: context.requirements.workloadIdentity !== undefined,
            });
            // The production Codex proof hands the real Driver exactly what Compute rendered;
            // unsupported shapes fail closed before OpenShell creates provider resources.
            return await delegate(
              context.requirements,
              context.namespace.name,
              endpoint,
              context,
            ).provisionHarness(context);
          }

          const claimName = context.requirements.workspaceMounts[0]?.claimName;
          assert.ok(claimName, "OpenShell bootstrap requires the Agent shared workspace PVC.");
          const subPath = `.openclaw/openshell-bootstrap/${hash(context.revision.id, 32)}`;
          bridge = credentialBridgeResource(context, claimName, subPath);
          const previousBridge = credentialBridges.get(context.revision.id);
          if (previousBridge === undefined) {
            await applyCredentialJob(operatorKubernetes, bridge);
            await waitForCredentialJob(
              operatorKubernetes,
              context,
              bridge.metadata.name,
              context.namespace.name,
            );
            // Readiness retries must not revoke the token by deleting its bound Pod.
            credentialBridges.set(context.revision.id, bridge);
          }
          const requirements = bridgeRequirements(context, claimName, subPath);
          const endpoint = await endpointForNamespace(context, {
            sandboxServiceAccountName: context.requirements.workloadIdentity.serviceAccountName,
            exact: true,
          });
          const provisioning = { ...context, requirements };
          return await delegate(
            requirements,
            context.namespace.name,
            endpoint,
            provisioning,
          ).provisionHarness(provisioning);
        } catch (error) {
          if (!provisioningFailures.has(context.revision.id)) {
            process.stderr.write(
              `OpenShell first provisioning failure for ${context.revision.id}: ${error.message}\n`,
            );
            provisioningFailures.set(context.revision.id, error);
          }
          if (bridge !== undefined && !credentialBridges.has(context.revision.id)) {
            await deleteCredentialJob(operatorKubernetes, context, bridge.metadata.name).catch(
              () => undefined,
            );
            await waitForCredentialJobDeletion(
              operatorKubernetes,
              context,
              bridge.metadata.name,
            ).catch(() => undefined);
          }
          throw error;
        }
      },
      // Compute admits the workspace-node connection only from the revision's
      // supervisor Pod, which the real Driver labels from the gateway's Sandbox record.
      async workspaceNodePeerLabels(context) {
        const endpoint = existingEndpointForNamespace(context);
        return await delegate(undefined, context.namespace.name, endpoint).workspaceNodePeerLabels(
          context,
        );
      },
      // Compute activates only a Harness that completes the authenticated handshake.
      async harnessStatus(context) {
        const endpoint = await endpointForNamespace(context, {
          sandboxServiceAccountName: agentSandboxServiceAccount(context),
          exact: context.requirements.workloadIdentity !== undefined,
        });
        return await delegate(
          context.requirements,
          context.namespace.name,
          endpoint,
          context,
        ).harnessStatus(context);
      },
      // Compute drops a native worker's exposure once its node has enrolled (finding 1657).
      async withdrawHarnessExposure(context) {
        const endpoint = await endpointForNamespace(context, {
          sandboxServiceAccountName: agentSandboxServiceAccount(context),
        });
        await delegate(undefined, context.namespace.name, endpoint).withdrawHarnessExposure(
          context,
        );
      },
      // Compute asks for the OpenShell-exposed Codex endpoint and points the Agent Gateway at it.
      // The real Driver supports this only for dedicated Codex, so the bridge proof omits it.
      ...(enableCompatibilityBridges
        ? {}
        : {
            async harnessEndpoint(context) {
              const endpoint = await endpointForNamespace(context, {
                sandboxServiceAccountName: agentSandboxServiceAccount(context),
                exact: context.requirements.workloadIdentity !== undefined,
              });
              return await delegate(
                context.requirements,
                context.namespace.name,
                endpoint,
                context,
              ).harnessEndpoint(context);
            },
          }),
      async cleanup(context) {
        if (context.revision === undefined) {
          try {
            const endpoint = existingEndpointForNamespace(context);
            await delegate(undefined, context.namespace.name, endpoint).cleanup(context);
          } finally {
            await stopGatewayForward(context.namespace.name);
          }
          return;
        }
        try {
          const endpoint = existingEndpointForNamespace(context);
          await delegate(undefined, context.namespace.name, endpoint).cleanup(context);
        } finally {
          if (enableCompatibilityBridges) {
            const bridge = credentialBridges.get(context.revision.id);
            if (bridge !== undefined) {
              const cleaner = structuredClone(bridge);
              cleaner.metadata.name = `${bridge.metadata.name}-cleanup`;
              const container = cleaner.spec.template.spec.containers[0];
              container.name = "delete-openshell-bootstrap";
              container.env = [];
              // Cleanup contexts intentionally omit provisioning requirements. The bridge mount is
              // revision-scoped, so remove its bounded contents without reconstructing token paths.
              container.command = [
                "sh",
                "-ceu",
                [
                  "if [ -d /bootstrap/plugin-runtime ]; then chmod -R u+w /bootstrap/plugin-runtime; fi",
                  "chmod -R u+w /bootstrap/service-principal",
                  "rm -f /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem",
                  "rm -rf /bootstrap/plugin-runtime /bootstrap/service-principal /bootstrap/runtime-assets /bootstrap/native-tmp /bootstrap/openclaw-home",
                ].join("\n"),
              ];
              container.volumeMounts = container.volumeMounts.filter(
                ({ name }) => name === "bootstrap",
              );
              cleaner.spec.template.spec.volumes = cleaner.spec.template.spec.volumes.filter(
                ({ name }) => name === "bootstrap",
              );
              try {
                await applyCredentialJob(operatorKubernetes, cleaner);
                await waitForCredentialJob(
                  operatorKubernetes,
                  context,
                  cleaner.metadata.name,
                  context.namespace.name,
                );
              } finally {
                await deleteCredentialJob(
                  operatorKubernetes,
                  context,
                  cleaner.metadata.name,
                  context.namespace.name,
                ).catch(() => undefined);
                await deleteCredentialJob(
                  operatorKubernetes,
                  context,
                  bridge.metadata.name,
                  context.namespace.name,
                ).catch(() => undefined);
              }
              credentialBridges.delete(context.revision.id);
            }
            await deleteCredentialJob(
              operatorKubernetes,
              context,
              credentialJobName(context.revision.id),
              context.namespace.name,
            ).catch(() => undefined);
          }
        }
      },
    };
  };
  createDriver.policyWrites = policyWrites;
  createDriver.setPolicyWriteBarrier = (barrier) => {
    policyWriteBarrier = barrier;
  };
  createDriver.createBackend = createBackend;
  // An independent read of the Namespace gateway's own state, for assertions.
  createDriver.gatewayClientForNamespace = (namespaceName, auth) => {
    const state = gatewayState.get(namespaceName);
    assert.ok(state, `OpenShell gateway for namespace ${namespaceName} was not initialized.`);
    if (auth !== undefined) {
      return new GrpcOpenShellGatewayClient({ endpoint: state.endpoint, auth });
    }
    return clientForEndpoint(state.endpoint);
  };
  // After the Namespace gateway Pod is replaced, its port-forward has ended. A new one keeps the
  // gateway's Sandbox ServiceAccount; Backend clients resolve the endpoint at call time.
  createDriver.restartGatewayForward = async (namespaceName) => {
    const prior = gatewayState.get(namespaceName);
    assert.ok(prior, `OpenShell gateway for namespace ${namespaceName} was not initialized.`);
    await stopGatewayForward(namespaceName, prior);
    const forward = await startOpenShellGatewayPortForward(namespaceName);
    gatewayState.set(namespaceName, { ...prior, endpoint: forward.url, forward });
  };
  // Ends the Namespace gateway's port-forward but keeps its endpoint, so every client then finds
  // nothing listening there, as through the Service of a gateway with no Pods, until
  // restartGatewayForward replaces it.
  createDriver.closeGatewayForward = async (namespaceName) => {
    const state = gatewayState.get(namespaceName);
    assert.ok(state, `OpenShell gateway for namespace ${namespaceName} was not initialized.`);
    await state.forward.stop();
  };
  createDriver.disposeGatewayForwards = disposeGatewayForwards;
  createDriver.provisioningFailures = provisioningFailures;
  createDriver.harnessServiceUrls = harnessServiceUrls;
  return createDriver;
}

function withFirstPrepareRevisionFailureDiagnostic(computeDriver) {
  let reported = false;
  return new Proxy(computeDriver, {
    get(target, property) {
      if (property === "prepareRevision") {
        return async (...args) => {
          try {
            return await target.prepareRevision(...args);
          } catch (error) {
            if (!reported) {
              reported = true;
              const message =
                error.message ===
                "The OpenShell compatibility proof is waiting for the Gateway node setup projection."
                  ? "OpenShell integration: waiting for the Gateway node setup projection; Compute will retry."
                  : `OpenShell integration: initial Compute prepareRevision retry: ${error.message}`;
              process.stderr.write(`${message}\n`);
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The Kubernetes client's rejection of a request the API server refused to authenticate.
function isKubernetesUnauthorized(error) {
  return error?.code === 401 || /^HTTP-Code: 401$/m.test(String(error?.message));
}

// Whether the test's bounded teardown has begun, for the 401 diagnostic below.
let teardownStarted = () => false;

// Finding 1711: a 401 on prepareRevision names no credential. On the first one, `tokenSources()`
// names the credentials the call may have used, by name and kind, never a value.
function withUnauthorizedTokenSourceDiagnostic(computeDriver, tokenSources) {
  let reported = false;
  return new Proxy(computeDriver, {
    get(target, property) {
      if (property === "prepareRevision") {
        return async (...args) => {
          try {
            return await target.prepareRevision(...args);
          } catch (error) {
            if (!reported && isKubernetesUnauthorized(error)) {
              reported = true;
              process.stderr.write(
                `OpenShell integration: Compute prepareRevision got HTTP 401; token sources: ${JSON.stringify(tokenSources())}\n`,
              );
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function prepareProductionInstallation(
  context,
  { harnessId = "codex", controllerPort } = {},
) {
  const kubeconfig = await validateOpenShellPrerequisites();
  const policyFixtureUrl = process.env.OCC_TEST_OPENSHELL_POLICY_MIGRATION_DATABASE_URL;
  if (harnessId === "codex") {
    assert.ok(
      policyFixtureUrl,
      "The policy revocation fixture requires its same-database migrator URL.",
    );
    const app = new URL(databaseUrl);
    const migrator = new URL(policyFixtureUrl);
    assert.equal(migrator.host, app.host);
    assert.equal(migrator.pathname, app.pathname);
    assert.equal(migrator.username, "occ_migrator");
  }
  const identifier = randomUUID();
  const platformNamespace = `oce-openshell-${hash(identifier)}`;
  await kubectl("create", "namespace", platformNamespace);
  context.after(async () => {
    await kubectl(
      "delete",
      "namespace",
      platformNamespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    );
  });
  const gatewayHelpers = {
    kubectl,
    applyManifest: fixture.applyManifest,
    resource,
    resources,
    waitFor,
    startPortForwardTarget: fixture.startPortForwardTarget,
  };
  await ensureEnvoyGatewayControllers(gatewayHelpers);
  const workspaceGateway = await createEnvoyWorkspaceGatewayPlan(
    context,
    { platformNamespace },
    gatewayHelpers,
  );
  workspaceGateway.routing.endpointPort = await startWorkspaceGatewayHostRelay(
    context,
    workspaceGateway,
  );
  const controller = await createScopedController(
    context,
    identifier,
    platformNamespace,
    kubeconfig,
  );
  const [
    { default: pg },
    { PostgresPlatformState },
    { loadInstallationConfiguration },
    { composeProduction },
    { createControllerWorker },
    { kubernetesNamespaceName },
    { OpenShellSandboxDriver },
    { GrpcOpenShellGatewayClient },
    { OpenShellGateway },
    { KubeConfig, KubernetesObjectApi },
  ] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
    import("../../apps/controller/src/drivers/sandbox/openshell.ts"),
    import("../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts"),
    import("../../apps/controller/src/backends/openshell.ts"),
    import(controllerRequire.resolve("@kubernetes/client-node")),
  ]);

  // The positive integration owns these compatibility mutations. Production controller clients
  // remain restricted and receive no authority to patch provider-owned resources or read Secrets.
  const operatorConfiguration = new KubeConfig();
  operatorConfiguration.loadFromFile(kubeconfigPath);
  operatorConfiguration.setCurrentContext(kubernetesContext);
  const operatorKubernetes = KubernetesObjectApi.makeApiClient(operatorConfiguration);

  const directory = await mkdtemp(join(tmpdir(), "oce-openshell-sandboxdriver-"));
  const startupPath = join(directory, "installation.json");
  const configuration = createOpenShellInstallationConfiguration({
    authentication: controller.authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    openShellRuntimeClass,
    cluster: "k3d-openshell-sandboxdriver",
  });
  // The Codex scenario runs a second Agent beside the first. Each Agent holds about 7 GiB of
  // limits: its 4 GiB Gateway, its Harness and the 1 GiB OpenShell supervisor. A rolling
  // replacement of a Gateway briefly holds another 4 GiB.
  configuration.drivers.compute.configuration.resources.namespace.quota["limits.memory"] = "20Gi";
  configuration.drivers.compute.configuration.network.pluginStatusProxySourceCidrs =
    await apiServerPodProxySourceCidrs();
  if (harnessId === "openclaw") {
    // scripts/k3d builds this runtime from an OpenClaw source with native worker support.
    configuration.runtime = { nativeWorkerSupport: "custom-image" };
    configuration.drivers.compute.configuration.runtime.nativeOpenClawSessionCapacity = 2;
    // The node and two retained session workers share one container; the single-Harness
    // 2 GiB budget OOM-kills the second turn. Keep Compute and Sandbox budgets aligned.
    configuration.drivers.compute.configuration.resources.agent.limits.memory = "6Gi";
    configuration.drivers.sandbox.configuration.kubernetes.agentResources.limits.memory =
      configuration.drivers.compute.configuration.resources.agent.limits.memory;
    configuration.drivers.compute.configuration.resources.namespace.quota["limits.memory"] = "16Gi";
    configuration.drivers.credential_gateway.configuration.binaries = ["/usr/local/bin/node"];
  }
  // A disposable Keycloak issues OAuth2 tokens over HTTPS signed by a private CA. The Namespace
  // gateway is configured to trust that CA so it can mint and refresh tokens itself.
  const keycloak =
    harnessId === "codex"
      ? await startKeycloak({
          context,
          kubectl,
          waitFor,
          startPortForwardTarget: fixture.startPortForwardTarget,
          image: process.env.OCC_TEST_KEYCLOAK_IMAGE ?? defaultKeycloakImage,
          scopedClients: {
            "policy-reader": ["sandbox:read"],
            "policy-recommender": ["config:read"],
            "policy-writer": ["config:write"],
            "policy-no-scopes": [],
          },
        })
      : undefined;
  // A cluster-internal echo service stands in for a protected non-model API. Only curl may
  // carry a non-model source's credential to it. It verifies Keycloak's signatures, so a
  // delivered OAuth2 token is proved genuine without the token reaching test output.
  const tokenEcho =
    harnessId === "codex" ? await startTokenEcho(context, keycloak?.jwks) : undefined;
  // An HTTPS upstream signed by a CA nothing trusts. A tool source bound to it, and later the
  // model route, must refuse it before a request or credential reaches it.
  const untrustedTls = harnessId === "codex" ? await startUntrustedTlsObserver(context) : undefined;
  if (tokenEcho !== undefined) {
    // Startup defaults allow the control port; the adjacent port needs an Agent-owned addition.
    configuration.sandboxNetworkPolicyCeiling = [
      {
        id: "python-demo",
        binary: "/usr/bin/python3.11",
        host: tokenEcho.host,
        ports: [{ from: tokenEcho.policyPort, to: tokenEcho.policyPort }],
      },
    ];
    configuration.drivers.sandbox.configuration.policy.networkPolicies.push({
      name: "python-control",
      binaries: [{ path: "/usr/bin/python3.11" }],
      endpoints: [{ host: tokenEcho.host, ports: [8082], tls: "skip" }],
    });
    configuration.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
    // The refresh role must belong to the gateway's Backend, whose provider records it refreshes.
    configuration.backend[0].drivers.credential_refresh = "credential-refresh-openshell-kubernetes";
    configuration.drivers.credential_refresh = {
      id: "credential-refresh-openshell-kubernetes",
      configuration: {},
    };
  }
  configuration.drivers.compute.configuration.gatewayRouting = workspaceGateway.routing;
  configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs =
    workspaceGateway.nativeOptions.gatewayAuth.trustedProxies;
  delete configuration.drivers.compute.configuration.network.gatewayClients;
  configuration.drivers.sandbox.configuration.policy.filesystem.readWrite.push(
    "/home/node/.openclaw-node",
  );
  // The Sandbox Driver adds each Harness's workspace-node enrollment rule;
  // a second rule for the same host and port is ambiguous.
  configuration.drivers.secret.configuration.authentication = controller.authentication;
  const gatewayApiKeyPath = join(directory, "workspace-gateway-api-key");
  await writeFile(gatewayApiKeyPath, workspaceGateway.apiKey, { mode: 0o600 });
  const driverEnvironment = {
    OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  };
  const workerStartupPath = join(directory, "worker-installation.json");
  await writeFile(workerStartupPath, JSON.stringify(configuration), { mode: 0o600 });
  const apiConfiguration = structuredClone(configuration);
  apiConfiguration.drivers.secret.configuration.authentication =
    controller.apiIdentity.authentication;
  await writeFile(startupPath, JSON.stringify(apiConfiguration), { mode: 0o600 });
  const createSandboxDriver = createIntegrationSandboxDriverFactory(
    OpenShellSandboxDriver,
    GrpcOpenShellGatewayClient,
    OpenShellGateway,
    operatorKubernetes,
    {
      enableCompatibilityBridges: harnessId === "openclaw",
      ...(keycloak === undefined ? {} : { gatewayTrustPem: keycloak.caPem }),
    },
  );
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { ...driverEnvironment, OCC_CONFIG_PATH: startupPath },
    createOpenShellBackend: createSandboxDriver.createBackend,
    createSandboxDriver,
  });
  // Names and kinds only: no credential value reaches the log.
  const tokenSources = () => ({
    compute: {
      kubeconfigContext: controller.authentication.context,
      user: `system:serviceaccount:${platformNamespace}:${controller.account}`,
      kind: "ServiceAccount token (kubectl create token, default lifetime)",
      mintedAt: controller.tokenMintedAt,
    },
    sandboxOperator: { kubeconfigContext: kubernetesContext, kind: "test operator kubeconfig" },
    teardownStarted: teardownStarted(),
  });
  const loadWorkerDrivers = async () => {
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      environment: { ...driverEnvironment, OCC_CONFIG_PATH: workerStartupPath },
      createOpenShellBackend: createSandboxDriver.createBackend,
      createSandboxDriver,
    });
    // A worker retry intentionally exposes only DEPENDENCY_UNAVAILABLE. Preserve the first
    // underlying Compute failure so a real-runtime regression is actionable rather than a timeout.
    return {
      workerDrivers: loaded,
      diagnosticWorkerDrivers: {
        ...loaded,
        computeDriver: withUnauthorizedTokenSourceDiagnostic(
          withFirstPrepareRevisionFailureDiagnostic(loaded.computeDriver),
          tokenSources,
        ),
      },
    };
  };
  const initialWorkerDrivers = await loadWorkerDrivers();
  const { workerDrivers } = initialWorkerDrivers;
  let { diagnosticWorkerDrivers } = initialWorkerDrivers;
  assert.equal(drivers.sandboxDriver?.capability, "sandbox");
  assert.equal(drivers.sandboxDriver?.id, configuration.drivers.sandbox.id);
  assert.equal(drivers.credentialGatewayDriver?.capability, "credential_gateway");
  if (keycloak !== undefined) {
    assert.equal(drivers.credentialRefreshDriver?.capability, "credential_refresh");
  }
  assert.equal(
    workerDrivers.credentialGatewayDriver?.id,
    configuration.drivers.credential_gateway.id,
  );

  const observerPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: observerPoolConnectionTimeoutMs,
    statement_timeout: diagnosticQueryTimeoutMs,
  });
  let policyFixturePool;
  if (harnessId === "codex") {
    // IAM Restrictions have no mutation API and the application role cannot write them.
    // Only fixture setup uses the migrator; the API and worker keep the restricted role.
    policyFixturePool = new pg.Pool({
      connectionString: policyFixtureUrl,
      max: 1,
      connectionTimeoutMillis: observerPoolConnectionTimeoutMs,
      statement_timeout: diagnosticQueryTimeoutMs,
    });
    context.after(() => policyFixturePool.end());
  }
  let workerPool;
  let worker;
  let productionApp;
  let controllerUrl;
  let placement;
  let gatewayPlacement;
  registerOpenShellInstallationCleanups(context, {
    workerStop: async () => {
      if (worker !== undefined) {
        await worker.stop();
      } else if (workerPool !== undefined) {
        await workerPool.end();
      }
    },
    portForwards: () => createSandboxDriver.disposeGatewayForwards(),
    productionApp: async () => {
      if (productionApp !== undefined) {
        await productionApp.close();
      }
    },
    observerPool: () => observerPool.end(),
    workloadNamespace: async () => {
      if (placement !== undefined) {
        await deleteNamespaceExplained(kubectl, placement);
      }
    },
    temporaryDirectory: () => rm(directory, { recursive: true, force: true }),
  });

  const existing = await new PostgresPlatformState(observerPool).loadInstallation();
  const controllerAuthBaseURL =
    controllerPort === undefined ? authBaseURL : `http://127.0.0.1:${controllerPort}`;
  if (existing !== undefined) {
    assert.equal(existing.name, installationName);
  } else {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminCredentials.email,
      password: adminCredentials.password,
      authSecret,
      authBaseURL: controllerAuthBaseURL,
      installationName,
    });
  }

  productionApp = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL: controllerAuthBaseURL,
    drivers,
    gatewayApiKeyPath,
  });
  if (controllerPort !== undefined) {
    await productionApp.listen({ host: "127.0.0.1", port: controllerPort });
    controllerUrl = `http://127.0.0.1:${controllerPort}`;
  }
  const request = await createAuthenticatedControllerRequest(
    productionApp,
    adminCredentials,
    controllerAuthBaseURL,
  );
  const events = [];
  const startWorker = async () => {
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    worker = createControllerWorker({
      mode: "production",
      pool: workerPool,
      drivers: diagnosticWorkerDrivers,
      pollIntervalMs: 50,
      leaseDurationMs: 60_000,
      maxAttempts: 40,
      // The receipt time lets a failure diagnostic collapse repeated events into first/last.
      emit: (event) => events.push({ ...event, observedAt: new Date().toISOString() }),
    });
    await worker.start();
  };
  // Stopping the real worker lets a phase stage durable state before any claim reads it.
  // Stop closes the worker's pool, so a restart uses a fresh one.
  const pauseWorker = async () => {
    await worker.stop();
    worker = undefined;
    workerPool = undefined;
  };
  await startWorker();

  const createdNamespace = await request("POST", "/namespaces", {
    name: `openshell-${randomUUID()}`,
  });
  assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
  const namespaceId = createdNamespace.data.id;
  placement = kubernetesNamespaceName(namespaceId);
  gatewayPlacement = kubernetesNamespaceName(namespaceId);

  await waitFor(`worker namespace creation for ${placement}`, async () => {
    try {
      return await resource("namespace", placement);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
        return undefined;
      }
      throw error;
    }
  });
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-controller",
    "--namespace",
    placement,
    `--clusterrole=${controller.tenantRole}`,
    `--serviceaccount=${platformNamespace}:${controller.account}`,
  );
  await waitFor(`worker namespace readiness for ${placement}`, async () => {
    const observed = await request("GET", `/namespaces/${namespaceId}`);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    return observed.data.status === "ready" ? observed.data : undefined;
  });
  await waitForOpenShellGateway(placement);
  await assertGatewayBootstrapPolicies(placement);
  if (harnessId === "codex") {
    // Each test Namespace runs its own OpenShell gateway, so its address is known only now. An
    // operator configures the dedicated Agent Gateway's route to the gateway that exposes Codex
    // and restarts the worker; Compute then admits only that Pod selector, address, and port.
    const gatewayInstance = `openshell-${hash(placement, 10)}`;
    const gatewayService = await resource("service", gatewayInstance, placement);
    configuration.drivers.compute.configuration.network.providerHarness = {
      namespace: placement,
      podLabels: {
        "app.kubernetes.io/name": "openshell",
        "app.kubernetes.io/instance": gatewayInstance,
      },
      address: gatewayService.spec.clusterIP,
      port: 8080,
    };
    await writeFile(workerStartupPath, JSON.stringify(configuration), { mode: 0o600 });
    await pauseWorker();
    ({ diagnosticWorkerDrivers } = await loadWorkerDrivers());
    await startWorker();
  }
  if (keycloak !== undefined) {
    // The gateway, not the Harness, calls the token endpoint: only its Pods may reach the issuer.
    await allowGatewayIssuerEgress(placement, keycloak);
  }
  // Canonical credentials share the tenant namespace; runtime Pods retain no Secret API authority.
  await kubectl(
    "create",
    "rolebinding",
    "openshell-secret-api",
    "--namespace",
    gatewayPlacement,
    `--clusterrole=${controller.apiSecretRole}`,
    `--serviceaccount=${platformNamespace}:${controller.apiIdentity.account}`,
  );
  const modelSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name: `openshell-model-${randomUUID()}`,
    value: modelCredential,
  });
  assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.error));
  assert.equal(JSON.stringify(modelSecret).includes(modelCredential), false);
  // Registration copies the Secret value into the Namespace's OpenShell gateway through the
  // regular API. The Secret stays the source of record; the Harness never receives it.
  const modelSource = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-openai-${randomUUID()}`,
    type: modelSourceType,
    ...(openShellModelBaseUrl === undefined ? {} : { config: { base_url: openShellModelBaseUrl } }),
    secrets: { [modelSecretField]: modelSecret.data.ref },
  });
  assert.equal(modelSource.status, 201, JSON.stringify(modelSource.error));
  assert.equal(modelSource.data.state, "ready");
  assert.deepEqual(modelSource.data.status, { state: "ready" });
  assert.equal(JSON.stringify(modelSource).includes(modelCredential), false);
  const observedSource = await request(
    "GET",
    `/namespaces/${namespaceId}/credential-sources/${modelSource.data.id}`,
  );
  assert.equal(observedSource.status, 200, JSON.stringify(observedSource.error));
  assert.deepEqual(observedSource.data.status, { state: "ready" });
  // Two tool sources reach the same echo service on separate paths with separate variables.
  const toolSources =
    tokenEcho === undefined
      ? undefined
      : [
          await registerToolSource(request, namespaceId, tokenEcho, "TOOL_A_TOKEN", toolAEchoPath),
          await registerToolSource(request, namespaceId, tokenEcho, "TOOL_B_TOKEN", "/echo-b"),
        ];
  const untrustedTlsSource =
    untrustedTls === undefined
      ? undefined
      : {
          ...(await registerToolSource(
            request,
            namespaceId,
            untrustedTls,
            "TOOL_TLS_TOKEN",
            "/untrusted",
          )),
          url: `https://${untrustedTls.host}/untrusted`,
        };
  const refreshSources =
    keycloak === undefined || networkPolicyOnly
      ? undefined
      : await registerRefreshSources(request, namespaceId, tokenEcho, keycloak, placement);

  const agentConfiguration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values:
      harnessId === "openclaw"
        ? nativeOpenClawConfiguration(
            workspaceGateway.nativeOptions.gatewayAuth,
            controllerPort === undefined
              ? []
              : [`http://127.0.0.1:${demoControlUiPort}`, `http://localhost:${demoControlUiPort}`],
          )
        : nativeCodexConfiguration(workspaceGateway.nativeOptions.gatewayAuth),
  });
  assert.equal(agentConfiguration.status, 201, JSON.stringify(agentConfiguration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `openshell-${randomUUID()}`,
    configurationId: agentConfiguration.data.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.data.id },
    // Console creation includes initial files. Keep this normal setup path in the
    // real Sandbox proof so credential-only fixtures cannot hide delivery gaps.
    ...(harnessId === "codex"
      ? { initialWorkspaceFiles: { "AGENTS.md": "# Initialized OpenShell workspace\n" } }
      : {}),
    // The list holds every bound source; harnessAuth names the model source within it.
    credentialSources: [
      { sourceId: modelSource.data.id },
      ...(toolSources ?? []).map(({ id }) => ({ sourceId: id })),
      ...(untrustedTlsSource === undefined ? [] : [{ sourceId: untrustedTlsSource.id }]),
      ...(refreshSources?.bound ?? []).map(({ id }) => ({ sourceId: id })),
    ],
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));

  // Generate the durable transport Secret through the supported Agent API so
  // current Compute ownership metadata and control-plane placement are exercised.
  const runtimeCredentials = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/runtime-credentials`,
    {},
  );
  assert.equal(runtimeCredentials.status, 200, JSON.stringify(runtimeCredentials.error));
  assert.equal(runtimeCredentials.data.transportConfigured, true);
  const transport = await readAgentTransportCredentials(gatewayPlacement, agent.data.id);
  // Deployment admission and the worker both require the Agent principal to operate the
  // exact source; it receives no permission on the underlying Secret. The grant goes through
  // the Namespace IAM API so its credential_source policy support is part of the proof.
  const sourceRole = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
    name: "Exact model credential source operate",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  assert.equal(sourceRole.status, 201, JSON.stringify(sourceRole.error));
  const sourceBinding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.data.servicePrincipalId,
    roleId: sourceRole.data.id,
    resourceKind: "credential_source",
    resourceId: modelSource.data.id,
  });
  assert.equal(sourceBinding.status, 201, JSON.stringify(sourceBinding.error));
  for (const toolSource of [
    ...(toolSources ?? []),
    ...(untrustedTlsSource === undefined ? [] : [untrustedTlsSource]),
    ...(refreshSources?.bound ?? []),
  ]) {
    const toolBinding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: agent.data.servicePrincipalId,
      roleId: sourceRole.data.id,
      resourceKind: "credential_source",
      resourceId: toolSource.id,
    });
    assert.equal(toolBinding.status, 201, JSON.stringify(toolBinding.error));
    toolSource.bindingId = toolBinding.data.id;
  }
  const deployed = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  assert.equal(deployed.data.harness.mode, "dedicated");
  assert.equal(deployed.data.harness.id, harnessId);
  if (harnessId === "codex") {
    assert.equal(
      deployed.data.configuration.plugins.entries.codex.config.appServer.sandbox,
      "danger-full-access",
      "OpenShell must own isolation for both API-key and PAT sources.",
    );
  } else {
    assert.equal(
      deployed.data.configuration.plugins?.entries?.codex,
      undefined,
      "OpenShell must not inject Codex configuration into a native OpenClaw revision.",
    );
  }

  assert.deepEqual(deployed.data.harnessAuth, agent.data.harnessAuth);
  try {
    await waitFor(`OpenShell revision ${deployed.data.id} activation`, async () => {
      const observed = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.activeRevisionId === deployed.data.id ? observed.data : undefined;
    });
  } catch (error) {
    // Preserve the provider's startup error before the fixture deletes its Pods. A revision
    // timeout alone hides failures in Landlock, credential delivery, and the model probe.
    const secrets = failureSecrets([
      process.env,
      {
        APP_SERVER_TOKEN: transport.appServerToken,
        GATEWAY_API_KEY: workspaceGateway.apiKey,
      },
    ]);
    const startupDiagnostic = async () => {
      for (const namespace of new Set([placement, gatewayPlacement])) {
        try {
          for (const pod of await diagnosticResources("pods", namespace)) {
            for (const container of pod.spec.containers) {
              if (!["agent", "gateway", "supervisor"].includes(container.name)) {
                continue;
              }
              const logs = await diagnosticKubectl(
                "logs",
                pod.metadata.name,
                "--namespace",
                namespace,
                "--container",
                container.name,
                "--tail=80",
              ).catch(() => "Pod logs unavailable");
              const lines = maskPrivateKeyLines(logs.split("\n"))
                .filter((line) => /error|fail|denied|refus|startup|NET:/iu.test(line))
                .slice(-12);
              for (const line of lines) {
                if (diagnosticDeadlinePassed()) {
                  return false;
                }
                process.stderr.write(
                  `OpenShell startup ${pod.metadata.name}/${container.name}: ${redactLogLine(line, secrets, 800)}\n`,
                );
              }
            }
          }
        } catch {
          if (diagnosticDeadlinePassed()) {
            return false;
          }
          process.stderr.write("OpenShell startup Pod diagnostics unavailable\n");
        }
      }
      return false;
    };
    if (await withinDiagnosticDeadline(startupDiagnostic, { timedOut: true })) {
      process.stderr.write(
        `OpenShell startup Pod diagnostics timed out after ${diagnosticDeadlineMs / 1_000} s\n`,
      );
    }
    const provisioningFailure = createSandboxDriver.provisioningFailures.get(deployed.data.id);
    if (provisioningFailure !== undefined) {
      assert.fail(
        `${error.message}\nFirst OpenShell provisioning failure: ${provisioningFailure.message}`,
      );
    }
    throw error;
  }
  await assertWorkerCompleted({
    description: `worker completion for ${deployed.data.id}`,
    events,
    pool: observerPool,
    namespaceId,
    agentId: agent.data.id,
    revisionId: deployed.data.id,
  });

  const sandbox = await waitForSandbox(placement, deployed.data);
  if (harnessId === "codex") {
    const initialFilePath = `/namespaces/${namespaceId}/agents/${agent.data.id}/workspace/files/AGENTS.md`;
    const initialFile = await request("GET", initialFilePath);
    if (initialFile.status !== 200) {
      const secrets = failureSecrets([
        process.env,
        {
          APP_SERVER_TOKEN: transport.appServerToken,
          GATEWAY_API_KEY: workspaceGateway.apiKey,
        },
      ]);
      const detail = await withinDiagnosticDeadline(
        () =>
          workspaceReadFailureDiagnostic({
            request,
            path: initialFilePath,
            agentId: agent.data.id,
            gatewayPlacement,
            secrets,
          }),
        {
          timedOut: `\nWorkspace read diagnostic timed out after ${diagnosticDeadlineMs / 1_000} s`,
        },
      );
      assert.fail(
        `The first Workspace read answered ${initialFile.status} ${JSON.stringify(initialFile.error)}${detail}`,
      );
    }
    assert.equal(initialFile.data.content, "# Initialized OpenShell workspace\n");
  }
  const harnessPod = await waitForProviderHarnessPod(placement, deployed.data);
  process.stderr.write(
    "OpenShell integration: provider Harness ready; checking ownership and mounts.\n",
  );
  await assertProviderOwnedHarness(placement, deployed.data, sandbox, harnessPod);
  const harnessContainer = harnessPod.spec.containers.find(({ name }) => name === "agent");
  assert.ok(harnessContainer, "the OpenShell Sandbox must provide its Agent container.");
  assert.deepEqual(
    harnessContainer.resources,
    configuration.drivers.sandbox.configuration.kubernetes.agentResources,
    "the delegated Harness must retain its configured budget during worker bootstrap.",
  );
  if (harnessId === "codex") {
    // The runtime bootstrap must have linked each runtime-home path to its isolated mount
    // before Codex started, so thread rollouts and generated images reach the workspace PVC.
    for (const { path, target } of assertWorkspaceMounts(harnessPod)) {
      const resolved = await kubectl(
        "exec",
        "--namespace",
        placement,
        harnessPod.metadata.name,
        "--container",
        "agent",
        "--",
        "readlink",
        path,
      );
      assert.equal(resolved.trim(), target, `${path} must link to its isolated workspace mount.`);
    }
    // The OpenShell process identity must be able to initialize Codex state in the
    // revision-scoped mount; Landlock permission alone cannot override Unix ownership.
    await kubectl(
      "exec",
      "--namespace",
      placement,
      harnessPod.metadata.name,
      "--container",
      "agent",
      "--",
      "sh",
      "-c",
      "test -w /sandbox/.openclaw-runtime/home/.codex",
    );
    assertNoProjectedAgentIdentity(harnessPod);
    assertApprovedOpenShellPrivileges(harnessPod);
  } else {
    assertBridgedNativeStateMount(harnessPod);
    await assertBridgedServicePrincipalToken(
      placement,
      harnessPod,
      configuration.drivers.compute.configuration.servicePrincipalCredentials,
    );
    assertApprovedOpenShellPrivileges(harnessPod, { compatibilityBridge: true });
  }
  process.stderr.write(
    "OpenShell integration: approved mounts and privileges verified; checking secret exposure.\n",
  );
  await assertNoSecretBytes(placement, [modelCredential, transport.appServerToken]);
  await assertModelKeyIsPlaceholderOnly(placement, harnessPod, modelCredential);
  process.stderr.write(
    "OpenShell integration: secret exposure checks passed; verifying gateway routing.\n",
  );

  const agentServiceName = openShellAgentName(agent.data.id);
  const gatewayPods = (await resources("pods", gatewayPlacement)).filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id,
  );
  assert.equal(gatewayPods.length, 1, "the Compute-owned Agent gateway must still be separate.");
  if (harnessId === "codex") {
    const agentService = await resource("service", agentServiceName, placement);
    // OpenShell owns the Codex endpoint, so Compute parks the native Agent Service on a selector
    // that matches no Pod; the Agent Gateway can reach Codex only through the OpenShell route.
    assert.deepEqual(agentService.spec.selector, {
      "app.kubernetes.io/name": `${agentServiceName}-inactive`,
      "openclaw.dev/agent": agent.data.id,
      "openclaw.dev/namespace": namespaceId,
      "openclaw.dev/network-profile": "provider-fenced-v1",
      "openclaw.dev/revision": deployed.data.id,
      "openclaw.dev/workload-role": "agent",
    });
    const selected = (await resources("pods", placement)).filter((pod) =>
      Object.entries(agentService.spec.selector).every(
        ([key, value]) => pod.metadata.labels?.[key] === value,
      ),
    );
    assert.deepEqual(selected, [], "the parked Agent Service must not select the Harness Pod.");
  }
  return {
    request,
    placement,
    namespaceId,
    agent: agent.data,
    revision: deployed.data,
    harnessPod,
    sandbox,
    gatewayPlacement,
    gatewayPod: gatewayPods[0],
    harnessServiceUrl: createSandboxDriver.harnessServiceUrls.get(deployed.data.id),
    appServerToken: transport.appServerToken,
    modelSecretId: modelSecret.data.id,
    sourceRoleId: sourceRole.data.id,
    controllerUrl,
    credentials: adminCredentials,
    ...(toolSources === undefined ? {} : { toolSources, tokenEcho }),
    ...(untrustedTls === undefined ? {} : { untrustedTls, untrustedTlsSource }),
    ...(refreshSources === undefined ? {} : { refreshSources, keycloak }),
    policyWrites: createSandboxDriver.policyWrites,
    setPolicyWriteBarrier: createSandboxDriver.setPolicyWriteBarrier,
    gatewayClient: (auth) => createSandboxDriver.gatewayClientForNamespace(placement, auth),
    restartGatewayForward: () => createSandboxDriver.restartGatewayForward(placement),
    closeGatewayForward: () => createSandboxDriver.closeGatewayForward(placement),
    observerPool,
    policyFixturePool,
    pauseWorker,
    resumeWorker: startWorker,
    workerEvents: events,
    provisioningFailure: (revisionId) => createSandboxDriver.provisioningFailures.get(revisionId),
    diagnoseAgentRevision: (agentId, revisionId) =>
      writeWorkerCompletionDiagnostics({
        pool: observerPool,
        events,
        namespaceId,
        agentId,
        revisionId,
      }),
    diagnoseRevision: (revisionId) =>
      writeWorkerCompletionDiagnostics({
        pool: observerPool,
        events,
        namespaceId,
        agentId: agent.data.id,
        revisionId,
      }),
  };
}

/**
 * Starts a plain-HTTP echo service in its own namespace. It answers with a digest of the
 * Authorization header it received, so the substituted token never appears in test output.
 * Given an issuer's public keys, it also reports whether a bearer JWT carries a valid,
 * unexpired signature from that issuer, with its non-secret claims.
 */
async function startTokenEcho(context, issuerJwks) {
  const namespace = `oce-token-echo-${hash(randomUUID())}`;
  await kubectl("create", "namespace", namespace);
  context.after(() =>
    kubectl("delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"),
  );
  // Read the receiver's count through Pod loopback, even when its Service has no ready endpoint.
  const receiptPort = 8081;
  const program = [
    'const { createHash, createPublicKey, randomUUID, verify } = require("node:crypto");',
    'const http = require("node:http");',
    "const receipt = { instance: randomUUID(), requests: 0 };",
    `http.createServer((_, res) => res.end(JSON.stringify(receipt))).listen(${receiptPort}, "127.0.0.1");`,
    "const keys = JSON.parse(process.env.OCE_ISSUER_JWKS ?? '{\"keys\":[]}').keys;",
    "const jwt = (authorization) => {",
    "  const match = /^Bearer ([\\w-]+)\\.([\\w-]+)\\.([\\w-]+)$/.exec(authorization);",
    "  if (match === null) return undefined;",
    "  try {",
    '    const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());',
    "    const header = decode(match[1]);",
    "    const claims = decode(match[2]);",
    "    const key = keys.find((candidate) => candidate.kid === header.kid);",
    "    const valid =",
    '      header.alg === "RS256" && key !== undefined && claims.exp * 1000 > Date.now() &&',
    '      verify("RSA-SHA256", Buffer.from(`${match[1]}.${match[2]}`),',
    '        createPublicKey({ key, format: "jwk" }), Buffer.from(match[3], "base64url"));',
    "    return { valid, iss: claims.iss, azp: claims.azp, jti: claims.jti, iat: claims.iat };",
    "  } catch {",
    "    return { valid: false };",
    "  }",
    "};",
    "http.createServer((request, response) => {",
    `  if (request.url === ${JSON.stringify(toolAEchoPath)}) receipt.requests++;`,
    '  const authorization = request.headers.authorization ?? "";',
    '  response.setHeader("content-type", "application/json");',
    "  response.end(JSON.stringify({",
    "    path: request.url,",
    '    digest: createHash("sha256").update(authorization).digest("hex"),',
    '    placeholder: authorization.includes("openshell:resolve:"),',
    "    length: authorization.length,",
    "    jwt: jwt(authorization),",
    "  }));",
    '}).listen(8080, "0.0.0.0");',
    'http.createServer((request, response) => response.end(JSON.stringify({ path: request.url }))).listen(8082, "0.0.0.0");',
    // Policy additions use an uncredentialed port, independent of the tool-source TLS metadata.
    'http.createServer((request, response) => response.end(JSON.stringify({ path: request.url }))).listen(8083, "0.0.0.0");',
  ].join("\n");
  await kubectl(
    "run",
    "token-echo",
    "--namespace",
    namespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    "--labels=app=token-echo",
    "--port=8080",
    ...(issuerJwks === undefined ? [] : [`--env=OCE_ISSUER_JWKS=${JSON.stringify(issuerJwks)}`]),
    "--command",
    "--",
    "node",
    "-e",
    program,
  );
  await kubectl(
    "expose",
    "pod",
    "token-echo",
    "--namespace",
    namespace,
    "--name=token-echo",
    "--port=8080",
    "--target-port=8080",
  );
  await kubectl(
    "wait",
    "--namespace",
    namespace,
    "--for=condition=Ready",
    "pod/token-echo",
    "--timeout=180s",
  );
  await kubectl(
    "patch",
    "service",
    "token-echo",
    "--namespace",
    namespace,
    "--type=merge",
    "-p",
    JSON.stringify({
      spec: {
        ports: [
          { name: "target", port: 8080, targetPort: 8080 },
          { name: "control", port: 8082, targetPort: 8082 },
          { name: "policy", port: 8083, targetPort: 8083 },
        ],
      },
    }),
  );
  async function readToolAReceipt() {
    const output = await kubectl(
      "exec",
      "pod/token-echo",
      "--namespace",
      namespace,
      "--",
      "node",
      "-e",
      `fetch("http://127.0.0.1:${receiptPort}", { signal: AbortSignal.timeout(5000) })` +
        ".then((response) => response.text()).then((text) => process.stdout.write(text))",
    );
    const { instance, requests } = JSON.parse(output);
    assert.ok(typeof instance === "string" && instance.length > 0);
    assert.ok(Number.isSafeInteger(requests) && requests >= 0);
    return { instance, requests };
  }
  return {
    namespace,
    host: `token-echo.${namespace}.svc.cluster.local`,
    port: 8080,
    policyPort: 8083,
    readToolAReceipt,
  };
}

const untrustedCaName = "OCE untrusted upstream CA";

/**
 * Starts an HTTPS service whose certificate chains only to a fresh private CA that nothing in
 * the cluster trusts. The certificate also names the model host and the service listens on the
 * model port, so the model route can be pointed at it through cluster DNS. The service logs one
 * JSON line per TLS failure, completed handshake, or request, with the TLS server name and no
 * header values, so a route that refuses the upstream shows a failed handshake and no request.
 */
async function startUntrustedTlsObserver(context) {
  const namespace = `oce-untrusted-tls-${hash(randomUUID())}`;
  const host = `untrusted-tls.${namespace}.svc.cluster.local`;
  await kubectl("create", "namespace", namespace);
  context.after(() =>
    kubectl("delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"),
  );
  const directory = await mkdtemp(join(tmpdir(), "openshell-untrusted-tls-"));
  let certificate;
  let key;
  try {
    await issueServingCertificate(directory, host, {
      alternateHosts: [modelEndpoint.hostname],
      caName: untrustedCaName,
    });
    certificate = await readFile(join(directory, "tls.crt"), "utf8");
    key = await readFile(join(directory, "tls.key"), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const program = [
    'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
    'const server = require("node:https").createServer(',
    "  { cert: process.env.OBSERVER_CERT, key: process.env.OBSERVER_KEY },",
    "  (request, response) => {",
    "    emit({",
    '      event: "request",',
    "      path: request.url,",
    "      authorization: request.headers.authorization !== undefined,",
    "    });",
    "    response.statusCode = 204;",
    "    response.end();",
    "  },",
    ");",
    'server.on("tlsClientError", (error, socket) =>',
    '  emit({ event: "tls-error", servername: socket.servername ?? null, code: error.code ?? null }));',
    'server.on("secureConnection", (socket) =>',
    '  emit({ event: "tls-established", servername: socket.servername ?? null }));',
    'server.listen(8443, "0.0.0.0");',
  ].join("\n");
  await kubectl(
    "run",
    "untrusted-tls",
    "--namespace",
    namespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    "--labels=app=untrusted-tls",
    "--port=8443",
    `--env=OBSERVER_CERT=${certificate}`,
    `--env=OBSERVER_KEY=${key}`,
    "--command",
    "--",
    "node",
    "-e",
    program,
  );
  await kubectl(
    "create",
    "service",
    "clusterip",
    "untrusted-tls",
    "--namespace",
    namespace,
    "--tcp=443:8443",
    ...(modelPort === 443 ? [] : [`--tcp=${modelPort}:8443`]),
  );
  await kubectl(
    "wait",
    "--namespace",
    namespace,
    "--for=condition=Ready",
    "pod/untrusted-tls",
    "--timeout=180s",
  );
  const service = await resource("service", "untrusted-tls", namespace);
  return {
    namespace,
    host,
    port: 443,
    address: service.spec.clusterIP,
    events: async () =>
      (await kubectl("logs", "pod/untrusted-tls", "--namespace", namespace))
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line)),
  };
}

// A redeploy rolls the Agent Gateway Deployment, so later turns use the Pod running now.
async function currentGatewayPod(topology, agentId = topology.agent.id) {
  return await waitFor("one running Agent Gateway Pod", async () => {
    const pods = (await resources("pods", topology.gatewayPlacement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === agentId &&
        pod.metadata.deletionTimestamp === undefined &&
        pod.status?.phase === "Running",
    );
    return pods.length === 1 ? pods[0].metadata.name : undefined;
  });
}

/** Registers a static bearer token for one echo-service path as a tool credential source. */
async function registerToolSource(request, namespaceId, tokenEcho, environmentName, path) {
  const token = `oce-tool-${randomUUID()}`;
  const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name: `openshell-tool-token-${randomUUID()}`,
    value: token,
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.error));
  const config = {
    host: tokenEcho.host,
    port: String(tokenEcho.port),
    path,
    env_var: environmentName,
  };
  // A tool source may not take over the model placeholder's variable.
  const reserved = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-tool-reserved-${randomUUID()}`,
    type: "bearer-token",
    config: { ...config, env_var: "OPENAI_API_KEY" },
    secrets: { token: secret.data.ref },
  });
  assert.notEqual(reserved.status, 201, "a reserved environment variable must be refused");
  const source = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-tool-${randomUUID()}`,
    type: "bearer-token",
    config,
    secrets: { token: secret.data.ref },
  });
  assert.equal(source.status, 201, JSON.stringify(source.error));
  assert.deepEqual(source.data.status, { state: "ready" });
  return {
    id: source.data.id,
    token,
    environmentName,
    url: `http://${tokenEcho.host}:${tokenEcho.port}${path}`,
    digest: createHash("sha256").update(`Bearer ${token}`).digest("hex"),
  };
}

/** Admits the Namespace gateway's Pods, and nothing else in the Namespace, to the issuer. */
async function allowGatewayIssuerEgress(placement, keycloak) {
  const directory = await mkdtemp(join(tmpdir(), "openshell-issuer-egress-"));
  const path = join(directory, "networkpolicy.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-issuer", namespace: placement },
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "openshell",
              "app.kubernetes.io/instance": `openshell-${hash(placement, 10)}`,
            },
          },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": keycloak.namespace },
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: keycloak.port }],
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("apply", "--namespace", placement, "-f", path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Registers OAuth2 sources whose tokens the Namespace gateway mints from Keycloak. Each
 * registration returns only once the first token exists. `bound` sources go on the Agent;
 * `unbound` stays unreferenced so the phase can delete it once the registration fence passes.
 */
async function registerRefreshSources(request, namespaceId, tokenEcho, keycloak, placement) {
  // OCC reports a failed mint only as unavailable. The gateway logs why its token request
  // failed (connect, TLS, or the issuer's answer) without the URL or any value.
  const gatewayDiagnostics = async () => {
    const selector = `app.kubernetes.io/instance=openshell-${hash(placement, 10)}`;
    const logs = await kubectl(
      "logs",
      "--namespace",
      placement,
      "-l",
      selector,
      "--tail=400",
    ).catch((error) => `logs unavailable: ${error.message}`);
    const mounts = await kubectl(
      "get",
      "pods",
      "--namespace",
      placement,
      "-l",
      selector,
      "-o",
      "jsonpath={.items[*].spec.containers[*].volumeMounts}",
    ).catch((error) => `mounts unavailable: ${error.message}`);
    const relevant = String(logs)
      .split("\n")
      .filter((line) =>
        /refresh|token endpoint|oauth|tls|certificate|rustls|hyper|reqwest|dns|resolve|connect/i.test(
          line,
        ),
      )
      .filter((line) => !/bearer|secret|refresh_token=|client_secret/i.test(line))
      .slice(-80);
    // An ephemeral container shares the gateway Pod's network namespace, so its NetworkPolicy
    // applies. It separates DNS and TCP failures from the TLS ones the gateway reports alike.
    const probe = [
      'const dns = require("node:dns").promises;',
      'const net = require("node:net");',
      "const host = process.env.PROBE_HOST;",
      "const port = Number(process.env.PROBE_PORT);",
      "(async () => {",
      '  try { console.log("dns", (await dns.lookup(host)).address); }',
      '  catch (error) { console.log("dns-error", error.code); return; }',
      "  await new Promise((done) => {",
      '    const socket = net.connect(port, host, () => { console.log("tcp ok"); socket.destroy(); done(); });',
      '    socket.on("error", (error) => { console.log("tcp-error", error.code); done(); });',
      '    socket.setTimeout(5000, () => { console.log("tcp-timeout"); socket.destroy(); done(); });',
      "  });",
      "})();",
    ].join("\n");
    const gatewayPod = String(
      await kubectl(
        "get",
        "pods",
        "--namespace",
        placement,
        "-l",
        selector,
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ).catch(() => ""),
    ).trim();
    // The restricted profile needs a numeric non-root user, which the probe image does not name.
    const custom = join(await mkdtemp(join(tmpdir(), "openshell-issuer-probe-")), "custom.json");
    await writeFile(
      custom,
      JSON.stringify({
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" },
        },
      }),
    );
    const probed =
      gatewayPod.length === 0
        ? "no gateway Pod"
        : await Promise.race([
            delay(90_000).then(() => "probe timed out"),
            kubectl(
              "debug",
              "--namespace",
              placement,
              `pod/${gatewayPod}`,
              `--image=${gatewayImage}`,
              "--image-pull-policy=IfNotPresent",
              // The tenant namespace enforces the restricted Pod Security profile.
              "--profile=restricted",
              `--custom=${custom}`,
              "--attach=true",
              "--quiet",
              `--env=PROBE_HOST=${keycloak.host}`,
              `--env=PROBE_PORT=${keycloak.port}`,
              "--",
              "node",
              "-e",
              probe,
            ).catch((error) => `probe unavailable: ${String(error.stderr ?? "").slice(-600)}`),
          ]);
    process.stderr.write(
      `OpenShell gateway refresh diagnostics:\n${relevant.join("\n")}\nmounts: ${String(mounts).slice(0, 2000)}\nissuer probe from the gateway Pod: ${String(probed).slice(0, 1000)}\n`,
    );
  };
  const secret = async (value) => {
    const created = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: `openshell-oauth-${randomUUID()}`,
      value,
    });
    assert.equal(created.status, 201, JSON.stringify(created.error));
    return created.data.ref;
  };
  const register = async (type, environmentName, path, clientId, secrets) => {
    const source = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
      name: `openshell-${type}-${randomUUID()}`,
      type,
      config: {
        host: tokenEcho.host,
        port: String(tokenEcho.port),
        path,
        env_var: environmentName,
        token_url: keycloak.tokenUrl,
        client_id: clientId,
      },
      secrets,
    });
    if (source.status !== 201) {
      await gatewayDiagnostics();
    }
    assert.equal(source.status, 201, JSON.stringify(source.error));
    // A refresh source is ready only once the gateway has minted its first token.
    assert.equal(source.data.status.state, "ready");
    assert.equal(source.data.status.refresh.state, "ready", JSON.stringify(source.data.status));
    return {
      id: source.data.id,
      type,
      clientId,
      environmentName,
      url: `http://${tokenEcho.host}:${tokenEcho.port}${path}`,
    };
  };
  const clientSecret = await secret(keycloak.clientSecret);
  // OpenShell refuses a token endpoint without TLS, so OCC refuses one before any gateway call,
  // naming the invalid field.
  const plain = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-oauth-plain-${randomUUID()}`,
    type: "oauth2-client-credentials",
    config: {
      host: tokenEcho.host,
      env_var: "TOOL_PLAIN_TOKEN",
      token_url: keycloak.tokenUrl.replace(/^https:/, "http:"),
      client_id: keycloakServiceClient,
    },
    secrets: { client_secret: clientSecret },
  });
  assert.equal(plain.status, 400, JSON.stringify(plain.error ?? plain.data));
  assert.equal(plain.error.details?.[0]?.path, "/config/token_url", JSON.stringify(plain.error));
  return {
    bound: [
      await register(
        "oauth2-client-credentials",
        "TOOL_CC_TOKEN",
        "/oauth-cc",
        keycloakServiceClient,
        { client_secret: clientSecret },
      ),
      await register("oauth2-refresh-token", "TOOL_RT_TOKEN", "/oauth-rt", keycloakUserClient, {
        refresh_token: await secret(await keycloak.signInRefreshToken()),
      }),
    ],
    unbound: await register(
      "oauth2-client-credentials",
      "TOOL_SPARE_TOKEN",
      "/oauth-spare",
      keycloakServiceClient,
      { client_secret: clientSecret },
    ),
    secret,
  };
}

// Finding 1533: the client-credentials source read `failed` right after a turn that used its
// valid token, and the assertion did not say why. OpenShell records a retryable mint failure
// (token endpoint unreachable, HTTP 429 or 5xx, a lost state write) as `error`, which OCC
// reports as `failed` with recovery action `retry`, and mints again 60 seconds later. Only
// that state is waited out, for at most three minutes, and it is logged with its failure code
// either way. Any other failure fails here with the redacted refresh state in the message.
const refreshRetryWaitMs = 180_000;

async function readyClientCredentialsRefresh(topology, readRefresh) {
  const secrets = turnFailureSecrets(topology);
  const shown = (refresh) => redactLogLine(JSON.stringify(refresh), secrets, 2_000);
  const retrying = (refresh) => refresh?.state === "failed" && refresh.recoveryAction === "retry";
  let refresh = await readRefresh();
  if (retrying(refresh)) {
    process.stderr.write(
      `OpenShell integration: client-credentials refresh failed with a retry pending: ${shown(refresh)}.\n`,
    );
    const deadline = Date.now() + refreshRetryWaitMs;
    while (retrying(refresh) && Date.now() < deadline) {
      await delay(5_000);
      refresh = await readRefresh();
    }
  }
  assert.equal(
    refresh?.state,
    "ready",
    `the client-credentials source must hold a minted token: ${shown(refresh)}`,
  );
  return refresh;
}

/**
 * The running Codex Harness calls the echo service with each OAuth2 placeholder. The echo
 * verifies Keycloak's signature on whatever token OpenShell substituted. The phase proves:
 * - the gateway re-mints a token before expiry and the same running Harness uses it;
 * - a forced rotation through the API mints a new token without a redeploy;
 * - a revoked refresh token reports `reauthorize`; an update whose mint fails is a 503 that
 *   keeps the recorded Secret references, and new material restores minting;
 * - deleting an unreferenced source removes its refresh state and provider from OpenShell.
 */
async function assertRefreshCredentialSources(topology) {
  const { request, namespaceId, refreshSources, keycloak, toolSources } = topology;
  const [clientCredentials, refreshToken] = refreshSources.bound;
  const agentId = topology.agent.id;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revisionId = current.data.activeRevisionId;
  const harness = await waitForProviderHarnessPod(topology.placement, { id: revisionId, agentId });
  const sourcePath = (source) => `/namespaces/${namespaceId}/credential-sources/${source.id}`;
  const secrets = turnFailureSecrets(topology);
  const readRefresh = async (source) => {
    const read = await request("GET", sourcePath(source));
    assert.equal(read.status, 200, JSON.stringify(read.error));
    return read.data.status.refresh;
  };
  const call = async () => {
    const nonce = `OCC-OPENSHELL-OAUTH-${randomUUID()}`;
    const result = await requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: await currentGatewayPod(topology),
      providerModel,
      prompt:
        `Use the shell exec tool. Run each numbered command in a separate exec tool ` +
        `invocation, continuing after a command fails: ` +
        `(1) curl -sS --max-time 20 -H "Authorization: Bearer $${clientCredentials.environmentName}" ` +
        `${clientCredentials.url}; ` +
        `(2) curl -sS --max-time 20 -H "Authorization: Bearer $${refreshToken.environmentName}" ` +
        `${refreshToken.url}. Then reply with exactly ${nonce}.`,
    });
    assert.match(result.assistant, new RegExp(nonce), "the model source must keep working");
    const commands = result.items
      .filter(({ method }) => method === "item/completed")
      .map(({ params }) => params?.item)
      .filter((item) => item?.type === "commandExecution");
    // Output that is not the echo's JSON (finding 1883) is kept, redacted and bounded, so a
    // failed check shows what the command printed. It has no `placeholder` or `jwt`, so every
    // check below treats it as a missing token.
    const echoed = (source) => tokenEchoReply(commands, source.url, secrets);
    return { cc: echoed(clientCredentials), rt: echoed(refreshToken) };
  };
  // The Sandbox supervisor picks up a re-minted token on its provider poll, every 10 seconds by
  // default. Turns repeat, a bounded number of times, until the running Harness presents a
  // token other than `previous` for `source`.
  const callUntilNewToken = async (key, previous) => {
    await delay(20_000);
    for (let attempt = 1; ; attempt += 1) {
      const observed = await call();
      if (observed[key]?.jwt?.jti !== previous || attempt === 4) {
        return observed;
      }
      await delay(15_000);
    }
  };
  const assertIssued = (observed, source) => {
    assert.equal(
      observed?.placeholder,
      false,
      `${source.type} must arrive substituted: ${observed?.shown}`,
    );
    assert.equal(
      observed?.jwt?.valid,
      true,
      `${source.type} must carry a valid Keycloak token: ${observed?.shown}`,
    );
    assert.equal(observed.jwt.iss, keycloak.issuer);
    assert.equal(observed.jwt.azp, source.clientId);
  };

  // The Harness holds only placeholders; OpenShell substitutes tokens it minted itself.
  const first = await call();
  assertIssued(first.cc, clientCredentials);
  assertIssued(first.rt, refreshToken);

  // Without any OCC call, the gateway re-mints before expiry. The same running Harness, with
  // the same placeholder, then presents the new token.
  const minted = await readyClientCredentialsRefresh(topology, () =>
    readRefresh(clientCredentials),
  );
  await waitFor(
    "the gateway to re-mint the client-credentials token on its own",
    async () => {
      const refresh = await readRefresh(clientCredentials);
      return refresh.lastRefreshAt !== minted.lastRefreshAt ? refresh : undefined;
    },
    300_000,
  );
  const remint = await callUntilNewToken("cc", first.cc.jwt.jti);
  assertIssued(remint.cc, clientCredentials);
  assert.notEqual(remint.cc.jwt.jti, first.cc.jwt.jti, "a re-minted token must be new");

  // A forced rotation mints a new token immediately, again without a redeploy.
  const rotated = await request("POST", `${sourcePath(clientCredentials)}/rotate`);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.error));
  assert.equal(rotated.data.status.refresh.state, "ready");
  const afterRotation = await callUntilNewToken("cc", remint.cc.jwt.jti);
  assertIssued(afterRotation.cc, clientCredentials);
  assert.notEqual(afterRotation.cc.jwt.jti, remint.cc.jwt.jti, "a rotation must mint a new token");
  // A static source has no issuer; rotating it is refused.
  const staticRotation = await request("POST", `${sourcePath(toolSources[0])}/rotate`);
  assert.equal(staticRotation.status, 409, JSON.stringify(staticRotation.error));

  // Ending the user's Keycloak sessions revokes the stored refresh token, and also a second
  // token from a sign-in just before. A forced mint then fails, and the source reports that
  // the owner must authorize again.
  const staleRefreshToken = await refreshSources.secret(await keycloak.signInRefreshToken());
  await keycloak.signOutUser();
  const revoked = await request("POST", `${sourcePath(refreshToken)}/rotate`);
  assert.equal(revoked.status, 503, JSON.stringify(revoked.error ?? revoked.data));
  const reauthorize = await readRefresh(refreshToken);
  assert.equal(reauthorize.state, "failed", JSON.stringify(reauthorize));
  assert.equal(reauthorize.recoveryAction, "reauthorize");

  // An update whose mint fails is a 503. OCC keeps naming the last material that minted, and
  // the source keeps reporting the failure for the owner to act on.
  const beforeFailedUpdate = await request("GET", sourcePath(refreshToken));
  assert.equal(beforeFailedUpdate.status, 200, JSON.stringify(beforeFailedUpdate.error));
  const failedUpdate = await request("PATCH", sourcePath(refreshToken), {
    secrets: { refresh_token: staleRefreshToken },
  });
  assert.equal(failedUpdate.status, 503, JSON.stringify(failedUpdate.error ?? failedUpdate.data));
  const afterFailedUpdate = await request("GET", sourcePath(refreshToken));
  assert.equal(afterFailedUpdate.status, 200, JSON.stringify(afterFailedUpdate.error));
  assert.deepEqual(afterFailedUpdate.data.secrets, beforeFailedUpdate.data.secrets);
  assert.equal(afterFailedUpdate.data.state, "ready");
  assert.equal(afterFailedUpdate.data.status.refresh.state, "failed");
  assert.equal(afterFailedUpdate.data.status.refresh.recoveryAction, "reauthorize");

  // New material from a fresh sign-in restores minting through the regular update API.
  const reconfiguredAt = Math.floor(Date.now() / 1000);
  const resigned = await request("PATCH", sourcePath(refreshToken), {
    secrets: { refresh_token: await refreshSources.secret(await keycloak.signInRefreshToken()) },
  });
  assert.equal(resigned.status, 200, JSON.stringify(resigned.error));
  assert.equal(resigned.data.status.refresh.state, "ready");
  // Reconfiguring starts a new OpenShell authorization epoch, which revokes the running
  // Sandbox's stable handle, so the reference requires a redeploy. A token minted before the
  // update can stay cached in the Sandbox and remains a valid JWT until it expires; a token
  // issued after the update would mean the new epoch reached the old Sandbox.
  const epochDeadline = Date.now() + 420_000;
  let afterReconfigure;
  for (;;) {
    afterReconfigure = await call();
    const presented = afterReconfigure.rt?.jwt;
    if (presented?.valid !== true) {
      break;
    }
    assert.ok(
      presented.iat < reconfiguredAt - 2,
      "a token minted after reconfiguration must not reach a Sandbox admitted under the previous epoch",
    );
    assert.ok(
      Date.now() < epochDeadline,
      "the running Sandbox must lose the reconfigured source's token by the old token's expiry",
    );
    await delay(15_000);
  }
  process.stdout.write(
    `OpenShell integration: the running Harness lost the reconfigured token after ` +
      `${Math.floor(Date.now() / 1000) - reconfiguredAt} s.\n`,
  );
  assertIssued(afterReconfigure.cc, clientCredentials);

  const unchanged = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(unchanged.data.activeRevisionId, revisionId, "refresh must not redeploy");
  const sameHarness = await waitForProviderHarnessPod(topology.placement, {
    id: revisionId,
    agentId,
  });
  assert.equal(sameHarness.metadata.uid, harness.metadata.uid, "the Harness must keep running");

  // Deleting an unreferenced source removes both its refresh state and its provider.
  const spare = refreshSources.unbound;
  const deleted = await request("DELETE", sourcePath(spare));
  assert.equal(deleted.status, 204, JSON.stringify(deleted.error));
  const gateway = topology.gatewayClient();
  const signal = () => AbortSignal.timeout(10_000);
  const workspace = topology.placement;
  const provider = openShellProviderName(spare.id);
  assert.equal(await gateway.getProvider(workspace, provider, signal()), undefined);
  assert.equal(
    await gateway.getProviderRefreshStatus(workspace, provider, spare.environmentName, signal()),
    undefined,
  );
}

/** Reports why another Agent's revision did not activate, before the fixture removes it. */
async function diagnoseAdditionalAgent(topology, agentId, revisionId, deploymentPath) {
  const secrets = turnFailureSecrets(topology);
  const write = (label, value) =>
    process.stderr.write(
      `OpenShell second Agent ${label}: ${redactLogLine(JSON.stringify(value), secrets, 4000)}\n`,
    );
  await topology.diagnoseAgentRevision(agentId, revisionId);
  const failure = topology.provisioningFailure(revisionId);
  if (failure !== undefined) {
    write("provisioning failure", failure.message);
  }
  const status = await topology.request("GET", deploymentPath).catch((error) => error);
  write("deployment", status?.data ?? status?.error ?? String(status));
  for (const namespace of new Set([topology.placement, topology.gatewayPlacement])) {
    const pods = await resources("pods", namespace).catch(() => []);
    for (const pod of pods.filter(
      ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agentId,
    )) {
      write(`Pod ${pod.metadata.name}`, {
        phase: pod.status?.phase,
        conditions: pod.status?.conditions?.map(({ type, status: value, reason }) => ({
          type,
          value,
          reason,
        })),
        containers: pod.status?.containerStatuses?.map(({ name, ready, restartCount, state }) => ({
          name,
          ready,
          restartCount,
          state,
        })),
      });
    }
    const events = await resources("events", namespace).catch(() => []);
    write(
      `${namespace} warning events`,
      events
        .filter(({ type }) => type === "Warning")
        .slice(-15)
        .map(({ involvedObject, reason, message }) => ({
          object: involvedObject?.name,
          reason,
          message,
        })),
    );
  }
}

/**
 * Deploys another dedicated Codex Agent in the same Namespace through the regular API, with
 * the first Agent's configuration, the given model source and the given tool sources. Its
 * principal receives `operate` on exactly those sources, as the first Agent's does.
 */
async function deployAdditionalCredentialAgent(topology, modelSourceId, toolSources) {
  const { request, namespaceId } = topology;
  assert.equal(typeof topology.agent.configurationId, "string");
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `openshell-second-${randomUUID()}`,
    configurationId: topology.agent.configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSourceId },
    credentialSources: [
      { sourceId: modelSourceId },
      ...toolSources.map(({ id }) => ({ sourceId: id })),
    ],
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const agentPath = `/namespaces/${namespaceId}/agents/${agent.data.id}`;
  const runtimeCredentials = await request("POST", `${agentPath}/runtime-credentials`, {});
  assert.equal(runtimeCredentials.status, 200, JSON.stringify(runtimeCredentials.error));
  for (const sourceId of [modelSourceId, ...toolSources.map(({ id }) => id)]) {
    const binding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: agent.data.servicePrincipalId,
      roleId: topology.sourceRoleId,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.error));
  }
  const deployed = await request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  const deploymentPath = `${agentPath}/deployments/${deployed.data.id}`;
  try {
    await waitFor(
      `second Agent revision ${deployed.data.id} activation`,
      async () => {
        const observed = await request("GET", agentPath);
        assert.equal(observed.status, 200, JSON.stringify(observed.error));
        if (observed.data.activeRevisionId === deployed.data.id) {
          return true;
        }
        const status = await request("GET", deploymentPath);
        assert.equal(status.status, 200, JSON.stringify(status.error));
        assert.notEqual(status.data.status, "failed", JSON.stringify(status.data));
        return undefined;
      },
      300_000,
    );
  } catch (error) {
    await diagnoseAdditionalAgent(topology, agent.data.id, deployed.data.id, deploymentPath);
    throw error;
  }
  await waitForProviderHarnessPod(topology.placement, deployed.data);
  return { agent: agent.data, revision: deployed.data, path: agentPath };
}

/**
 * The running Codex Harness calls the echo service with each tool placeholder. OpenShell
 * substitutes a token only at its own source's endpoint. The phase then proves, through the
 * real worker, Compute and OpenShell gateway, that:
 * - a withdrawal is executed only on its own requester's authority, even on a shared claim;
 * - withdrawing a source from one Agent leaves another Agent's attachment of it in place;
 * - an Agent that loses a source grant after admission never has the revision provisioned;
 * - admission refuses a redeploy without the grant.
 * The model source keeps working throughout.
 */
async function assertNonModelCredentialSource(topology) {
  const { request, namespaceId, toolSources, observerPool } = topology;
  const [toolA, toolB] = toolSources;
  const secrets = turnFailureSecrets(topology);
  const agentId = topology.agent.id;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revision = { id: current.data.activeRevisionId, agentId };
  assert.ok(revision.id, "the Agent must have an active revision");
  await waitForProviderHarnessPod(topology.placement, revision);
  // The dedicated Harness holds only the app-server token's digest, so each turn goes through the
  // Agent Gateway.
  const call = async (callerId = agentId) => {
    const nonce = `OCC-OPENSHELL-TOOL-${randomUUID()}`;
    const result = await requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: await currentGatewayPod(topology, callerId),
      providerModel,
      prompt:
        `Use the shell exec tool. Run each numbered command in a separate exec tool ` +
        `invocation, continuing after a command fails: ` +
        // OpenShell refuses model requests whose body carries a placeholder, including the
        // literal placeholder prefix in command text. The command prints only the first nine
        // characters, which identify a placeholder without reproducing it.
        `(1) printf '%s\\n' "$${toolA.environmentName}" | cut -c1-9; ` +
        `(2) curl -sS --max-time 20 -H "Authorization: Bearer $${toolA.environmentName}" ` +
        `${toolA.url}; ` +
        `(3) curl -sS --max-time 20 -H "Authorization: Bearer $${toolB.environmentName}" ` +
        `${toolB.url}. Then reply with exactly ${nonce}.`,
    });
    for (const { token } of toolSources) {
      assert.equal(JSON.stringify(result).includes(token), false);
    }
    assert.match(result.assistant, new RegExp(nonce), "the model source must keep working");
    const commands = result.items
      .filter(({ method }) => method === "item/completed")
      .map(({ params }) => params?.item)
      .filter((item) => item?.type === "commandExecution");
    const environment = commands.find(({ command }) => String(command).includes("cut -c1-9"));
    assert.ok(environment, "the Harness must read its tool placeholder");
    // Each tool's echo reply carries `shown`: the command, its exit code and what it printed,
    // redacted, so a failed check names its cause (finding 2281).
    return {
      placeholder: String(environment.aggregatedOutput ?? "").trim(),
      a: tokenEchoReply(commands, toolA.url, secrets),
      b: tokenEchoReply(commands, toolB.url, secrets),
    };
  };
  // Digests are compared, never shown; `shown` says what the command printed instead. A checked
  // call whose output is not JSON fails in tokenEchoDigest.
  const assertDelivered = (observed, tool, message) =>
    assert.equal(tokenEchoDigest(observed) === tool.digest, true, `${message}: ${observed.shown}`);
  const assertWithheld = (observed, tool, message) =>
    assert.equal(tokenEchoDigest(observed) === tool.digest, false, `${message}: ${observed.shown}`);
  const withdrawalPath = (tool) =>
    `/namespaces/${namespaceId}/agents/${agentId}/credential-sources/${tool.id}`;
  const readWithdrawal = async (tool) => {
    const observed = await request("GET", `${withdrawalPath(tool)}/withdrawal`);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    return observed.data;
  };

  // The Harness holds only placeholders; each endpoint receives its own real token.
  const before = await call();
  // A real token starts with oce-tool-; only a placeholder starts with the OpenShell prefix.
  assert.equal(before.placeholder, "openshell");
  assertDelivered(before.a, toolA, "OpenShell must substitute tool A's token");
  assertDelivered(before.b, toolB, "OpenShell must substitute tool B's token");

  // A second Agent authenticates with its own model source and attaches tool A only. OpenShell
  // gives it tool A's token, and tool B's endpoint receives no token from it, because only
  // attached sources are substituted.
  const secondModelSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name: `openshell-model-second-${randomUUID()}`,
    value: modelCredential,
  });
  assert.equal(secondModelSecret.status, 201, JSON.stringify(secondModelSecret.error));
  const secondModel = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-openai-second-${randomUUID()}`,
    type: modelSourceType,
    ...(openShellModelBaseUrl === undefined ? {} : { config: { base_url: openShellModelBaseUrl } }),
    secrets: { [modelSecretField]: secondModelSecret.data.ref },
  });
  assert.equal(secondModel.status, 201, JSON.stringify(secondModel.error));
  const second = await deployAdditionalCredentialAgent(topology, secondModel.data.id, [toolA]);
  // Each model source's provider names a profile of its own; no profile is shared by name.
  const gateway = topology.gatewayClient();
  const signal = () => AbortSignal.timeout(10_000);
  const firstModelId = topology.agent.harnessAuth.sourceId;
  const ownProfile = async (sourceId) => {
    const name = openShellProviderName(sourceId);
    const provider = await gateway.getProvider(topology.placement, name, signal());
    const profile = await gateway.getProviderProfile(topology.placement, name, signal());
    return provider?.type === name && profile?.id === name;
  };
  assert.equal(await ownProfile(firstModelId), true, "the first model source owns its profile");
  assert.equal(await ownProfile(secondModel.data.id), true, "the second owns its profile");
  assert.equal(
    await gateway.getProviderProfile(topology.placement, "oce-openai", signal()),
    undefined,
    "model sources must not share a profile",
  );
  const secondBefore = await call(second.agent.id);
  assert.equal(secondBefore.placeholder, "openshell");
  assertDelivered(secondBefore.a, toolA, "the second Agent must receive tool A's token");
  assertWithheld(secondBefore.b, toolB, "an unattached source must not be delivered");

  // Two requesters withdraw different sources from the running revision, sharing one worker
  // claim. The second, operator B, held the actor's grants when the withdrawal was recorded
  // and is offboarded before the worker runs it. The real worker must detach only the source
  // whose requester still operates the Agent. B's withdrawal is recorded in the application
  // database directly because this test has no second API login; the authorization decision
  // and the gateway detach under test are the production worker's.
  await topology.pauseWorker();
  const requested = await request("POST", `${withdrawalPath(toolA)}/withdraw`);
  assert.equal(requested.status, 202, JSON.stringify(requested.error));
  const actorId = requested.data.requestedBy;
  const offboarded = `withdraw-offboarded-${randomUUID()}`;
  await observerPool.query(
    `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
     SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
    [offboarded, actorId],
  );
  await observerPool.query(
    `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id, resource_kind, resource_id
     FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
    [offboarded, actorId],
  );
  await observerPool.query(
    `INSERT INTO occ.credential_withdrawals
       (namespace_id, agent_id, revision_id, credential_source_id, state, requested_by, requested_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, now())`,
    [namespaceId, agentId, revision.id, toolB.id, offboarded],
  );
  // Operator B is offboarded after requesting and before any worker reads the withdrawal.
  const offboarding = await observerPool.query(
    "DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
    [offboarded],
  );
  assert.ok(offboarding.rowCount > 0, "operator B must have held grants to lose");
  await topology.resumeWorker();
  const revokedA = await waitFor(
    "tool A's withdrawal to be revoked on its requester's authority",
    async () => {
      const found = await readWithdrawal(toolA);
      return found.state === "revoked" ? found : undefined;
    },
    180_000,
  );
  assert.ok(revokedA.completedAt);
  const deniedB = await waitFor(
    "the offboarded requester's withdrawal to be denied",
    async () => {
      const found = await readWithdrawal(toolB);
      return found.reason === "AUTHORIZATION_DENIED" ? found : undefined;
    },
    180_000,
  );
  assert.equal(deniedB.state, "pending");
  assert.equal(deniedB.requestedBy, offboarded);

  // In the same running Harness, the gateway no longer delivers tool A's token, still
  // delivers tool B's, and model turns succeed.
  const after = await call();
  assertWithheld(after.a, toolA, "a withdrawn token must not be delivered");
  assertDelivered(after.b, toolB, "a denied withdrawal must not detach its source");
  const unchanged = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(unchanged.data.activeRevisionId, revision.id, "withdrawal must not redeploy");
  // The withdrawal detaches tool A from the first Agent's Sandbox only. The provider and the
  // second Agent's attachment stay, so its running Harness still receives the token.
  const secondAfter = await call(second.agent.id);
  assertDelivered(
    secondAfter.a,
    toolA,
    "another Agent's withdrawal must not detach the source from this Agent",
  );
  const secondWithdrawal = await request(
    "GET",
    `${second.path}/credential-sources/${toolA.id}/withdrawal`,
  );
  assert.equal(secondWithdrawal.status, 404, JSON.stringify(secondWithdrawal.data));
  // Whether each echo endpoint received the source's real token; digests compared, never shown.
  const delivered = (observedCall) => ({
    toolA: observedCall.a.digest === toolA.digest,
    toolB: observedCall.b.digest === toolB.digest,
  });
  process.stderr.write(
    `OpenShell integration: tool token delivery ${JSON.stringify({
      firstAgent: { beforeWithdrawal: delivered(before), afterWithdrawal: delivered(after) },
      secondAgent: {
        beforeWithdrawal: delivered(secondBefore),
        afterWithdrawal: delivered(secondAfter),
      },
      withdrawals: { firstAgentToolA: revokedA.state, secondAgentToolA: "none" },
    })}.\n`,
  );

  // Stop and delete the second Agent through OCC so the later phases run with one Harness.
  const stopped = await request("POST", `${second.path}/stop`);
  assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
  await waitFor(
    "the worker to remove the stopped second Agent's Sandbox",
    async () => {
      const sandboxes = await resources("sandboxes.agents.x-k8s.io", topology.placement);
      return sandboxes.some(
        (sandbox) => sandbox.metadata.labels?.["openclaw.dev/revision"] === second.revision.id,
      )
        ? undefined
        : true;
    },
    180_000,
  );
  const deletedAgent = await request("DELETE", second.path);
  assert.equal(deletedAgent.status, 202, JSON.stringify(deletedAgent.error));
  // Deletion waits for the Agent's removal and the source's registration fence, so retry.
  await waitFor(
    "the second model source's deletion",
    async () => {
      const deleted = await request(
        "DELETE",
        `/namespaces/${namespaceId}/credential-sources/${secondModel.data.id}`,
      );
      if (deleted.status === 204) {
        return true;
      }
      assert.ok([409, 503].includes(deleted.status), JSON.stringify(deleted.error));
      return undefined;
    },
    180_000,
  );
  // The removed source's profile went with it; the first model source keeps its own, and the
  // first Agent's model turns still complete through it.
  const removedProfile = await gateway.getProviderProfile(
    topology.placement,
    openShellProviderName(secondModel.data.id),
    signal(),
  );
  assert.equal(removedProfile, undefined, "a removed source's profile must be deleted");
  assert.equal(
    await ownProfile(firstModelId),
    true,
    "the remaining model source keeps its profile",
  );
  await call();
  process.stderr.write(
    `OpenShell integration: model source profiles ${JSON.stringify({
      perSource: true,
      sharedProfile: false,
      removedWithSource: true,
      remainingSourceModelTurn: true,
    })}.\n`,
  );

  // Admission accepts a redeploy, then the Agent principal loses its grant on tool B before
  // the worker dispatches it. The worker must refuse before Compute provisions anything, so
  // the gateway never attaches the source to the new revision.
  const revisionCount = async () => {
    const listed = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}/revisions`);
    assert.equal(listed.status, 200, JSON.stringify(listed.error));
    return listed.data.length;
  };
  await topology.pauseWorker();
  const redeployed = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
  assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
  const ungranted = await request(
    "DELETE",
    `/namespaces/${namespaceId}/iam/access-bindings/${toolB.bindingId}`,
  );
  assert.equal(ungranted.status, 204, JSON.stringify(ungranted.error));
  await topology.resumeWorker();
  const failed = await waitFor(
    `deployment ${redeployed.data.id} to fail its dispatch authorization`,
    async () => {
      const status = await request(
        "GET",
        `/namespaces/${namespaceId}/agents/${agentId}/deployments/${redeployed.data.id}`,
      );
      assert.equal(status.status, 200, JSON.stringify(status.error));
      return status.data.status === "failed" ? status.data : undefined;
    },
    180_000,
  );
  const reason = await observerPool.query(
    "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
    [`agent_revision:${redeployed.data.id}:reconcile`],
  );
  assert.equal(reason.rows[0]?.reason_code, "AUTHORIZATION_DENIED", JSON.stringify(failed.error));
  const sandboxes = await resources("sandboxes.agents.x-k8s.io", topology.placement);
  assert.equal(
    sandboxes.some(
      (sandbox) => sandbox.metadata.labels?.["openclaw.dev/revision"] === redeployed.data.id,
    ),
    false,
    "a refused dispatch must not provision a Sandbox for the new revision",
  );
  const kept = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(kept.data.activeRevisionId, revision.id);

  // Without the grant, admission refuses a further redeploy and admits no revision.
  const revisionsBefore = await revisionCount();
  const refused = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
  assert.equal(refused.status, 403, JSON.stringify(refused.error ?? refused.data));
  assert.equal(
    await revisionCount(),
    revisionsBefore,
    "a refused deployment must not admit a revision",
  );
}

// Bounds the Harness file stream; the workspace holds session files, not bulk data.
const HARNESS_FILE_STREAM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Streams every regular file under the given Harness paths out of the Pod. The scan runs in
 * the test, so nothing derived from a credential enters the Pod. Each file is framed by a
 * JSON line with its path and size.
 */
async function readHarnessFiles(namespace, pod, roots) {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const walk = (entry) => {",
    "  let stat;",
    "  try { stat = fs.lstatSync(entry); } catch { return; }",
    "  if (stat.isDirectory()) {",
    "    for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));",
    "  } else if (stat.isFile()) {",
    "    let content;",
    "    try { content = fs.readFileSync(entry); } catch { return; }",
    '    process.stdout.write(JSON.stringify({ path: entry, size: content.length }) + "\\n");',
    "    process.stdout.write(content);",
    "  }",
    "};",
    "for (const root of JSON.parse(process.argv[1])) walk(root);",
  ].join("\n");
  const { stdout } = await executeFile(
    "kubectl",
    [
      "--kubeconfig",
      kubeconfigPath,
      "--context",
      kubernetesContext,
      "exec",
      pod.metadata.name,
      "--namespace",
      namespace,
      "--container",
      "agent",
      "--",
      "node",
      "-e",
      script,
      JSON.stringify(roots),
    ],
    { encoding: "buffer", maxBuffer: HARNESS_FILE_STREAM_MAX_BYTES },
  );
  const files = [];
  for (let offset = 0; offset < stdout.length;) {
    const end = stdout.indexOf(0x0a, offset);
    assert.ok(end > offset, "the Harness file stream must frame every file");
    const { path, size } = JSON.parse(stdout.subarray(offset, end).toString("utf8"));
    files.push({ path, content: stdout.subarray(end + 1, end + 1 + size) });
    offset = end + 1 + size;
  }
  return files;
}

/**
 * After the model and tool turns, checks the Agent-visible material and the operator-facing
 * records for the upstream credentials and the OpenShell placeholders:
 * - no Pod of the Agent mounts or references the source's stored OCC Secret;
 * - the Pod specs, the Agent- and revision-owned Secrets and the workspace files hold no
 *   upstream credential; the stored OCC Secrets are excluded, since they hold it by design;
 * - deployment diagnostics, runtime status, runtime logs and audit events hold neither an
 *   upstream credential nor a placeholder, which is itself a usable capability.
 */
async function assertAgentVisibleMaterialExcludesCredentials(topology) {
  const { request, namespaceId, placement, gatewayPlacement, observerPool } = topology;
  const agentId = topology.agent.id;
  const credentials = [
    modelCredential,
    ...(topology.toolSources ?? []).map(({ token }) => token),
    ...(topology.untrustedTlsSource === undefined ? [] : [topology.untrustedTlsSource.token]),
    ...(topology.keycloak === undefined ? [] : [topology.keycloak.clientSecret]),
  ];
  const placeholderPrefix = "openshell:resolve:";
  const holdsCredential = (text) => credentials.some((credential) => text.includes(credential));
  const namespaces = [...new Set([placement, gatewayPlacement])];
  const listed = async (kind) =>
    (await Promise.all(namespaces.map((namespace) => resources(kind, namespace)))).flat();

  // The stored OCC Secret holds the model key by design; no Pod of the Agent may mount it,
  // take an environment value from it, or name it at all.
  const secrets = await listed("secrets");
  const stored = secrets.filter(({ metadata }) => metadata.labels?.["openclaw.dev/secret"]);
  const modelSecret = stored.filter(
    ({ metadata }) => metadata.labels["openclaw.dev/secret"] === topology.modelSecretId,
  );
  assert.equal(modelSecret.length, 1, "the model source's stored OCC Secret must be found");
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revisionId = current.data.activeRevisionId;
  const harnessPod = await waitForProviderHarnessPod(placement, { id: revisionId, agentId });
  const agentPods = (await listed("pods")).filter(
    ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agentId,
  );
  assert.ok(
    agentPods.some(({ metadata }) => metadata.uid === harnessPod.metadata.uid),
    "the scan must include the running Harness Pod",
  );
  for (const pod of agentPods) {
    const spec = JSON.stringify(pod.spec);
    for (const { metadata } of stored) {
      assert.equal(
        spec.includes(metadata.name),
        false,
        `Pod ${pod.metadata.name} must not mount or reference a stored OCC Secret`,
      );
    }
    assert.equal(holdsCredential(JSON.stringify(pod)), false, "no Pod may hold a credential");
  }

  // Every other Secret in the Agent's namespaces, including the Agent-owned transport Secret
  // and revision-owned Secrets, must hold no upstream credential. Helm release records are
  // OpenShell's installation, compressed, and owned by no Agent.
  const transportName = `openclaw-agent-transport-${hash(agentId)}`;
  const scanned = secrets.filter(
    ({ metadata }) =>
      metadata.labels?.["openclaw.dev/secret"] === undefined && metadata.labels?.owner !== "helm",
  );
  assert.ok(
    scanned.some(({ metadata }) => metadata.name === transportName),
    "the scan must include the Agent's transport Secret",
  );
  for (const secret of scanned) {
    const decoded = Object.values(secret.data ?? {})
      .map((value) => Buffer.from(value, "base64").toString("utf8"))
      .join("\n");
    assert.equal(
      holdsCredential(decoded) || holdsCredential(JSON.stringify(secret.metadata)),
      false,
      `Secret ${secret.metadata.name} must not hold an upstream credential`,
    );
  }

  // The turns above wrote Codex sessions to the workspace PVC; the PVC holds no credential.
  const container = harnessPod.spec.containers.find(({ name }) => name === "agent");
  const claims = new Set(
    (harnessPod.spec.volumes ?? [])
      .filter(({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName)
      .map(({ name }) => name),
  );
  const roots = (container.volumeMounts ?? [])
    .filter(({ name }) => claims.has(name))
    .map(({ mountPath }) => mountPath);
  assert.ok(roots.length > 0, "the Harness must mount its workspace PVC");
  const files = await readHarnessFiles(placement, harnessPod, roots);
  assert.ok(files.length > 0, "the workspace must hold the Harness's session files");
  // Only file paths are reported, never content.
  assert.deepEqual(
    files
      .filter(({ content }) => credentials.some((credential) => content.includes(credential)))
      .map(({ path }) => path),
    [],
    "no workspace file may hold an upstream credential",
  );

  // Operator-facing diagnostics and logs of the active revision.
  const revisionPath = `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`;
  const diagnostics = await request("POST", `${revisionPath}/diagnostics`);
  assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.error));
  const runtime = await request("GET", `${revisionPath}/runtime`);
  assert.equal(runtime.status, 200, JSON.stringify(runtime.error));
  const observed = [
    ["deployment diagnostics", diagnostics],
    ["runtime status", runtime],
  ];
  const sources = runtime.data.sources.filter(({ available }) => available);
  assert.ok(sources.length > 0, "the revision must have a readable log source");
  for (const { id } of sources) {
    const logs = await request("GET", `${revisionPath}/runtime/logs?source=${id}&tailLines=1000`);
    assert.equal(logs.status, 200, JSON.stringify(logs.error));
    observed.push([`${id} runtime logs`, logs]);
  }
  // Audit evidence for the whole Namespace, including registration, update and withdrawal.
  const audit = await observerPool.query(
    "SELECT row_to_json(event)::text AS event FROM occ.audit_events event WHERE namespace_id = $1",
    [namespaceId],
  );
  assert.ok(audit.rowCount > 0, "the Namespace must have audit evidence");
  observed.push(["audit events", audit.rows.map(({ event }) => event)]);
  for (const [label, value] of observed) {
    const text = JSON.stringify(value);
    assert.equal(holdsCredential(text), false, `${label} must not hold an upstream credential`);
    assert.equal(text.includes(placeholderPrefix), false, `${label} must not hold a placeholder`);
  }
  // Counts only, for the run record.
  process.stderr.write(
    `OpenShell integration: credential absence scanned ${JSON.stringify({
      credentials: credentials.length,
      pods: agentPods.length,
      storedSecretsExcluded: stored.length,
      secrets: scanned.length,
      workspaceFiles: files.length,
      workspaceBytes: files.reduce((total, { content }) => total + content.length, 0),
      logSources: sources.map(({ id }) => id),
      auditEvents: audit.rowCount,
      matches: 0,
    })}.\n`,
  );
}

/**
 * Updates the source through the API, then withdraws it from the running Agent. After the
 * worker records `revoked`, a completed turn from the same running Codex app server must
 * fail this test. A rejected turn alone does not establish the cause of rejection.
 */
async function assertCredentialSourceUpdateAndLiveWithdrawal(topology) {
  const { request, namespaceId } = topology;
  const agentId = topology.agent.id;
  const sourceId = topology.agent.harnessAuth.sourceId;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revision = { id: current.data.activeRevisionId, agentId };
  assert.ok(revision.id, "the replaced Agent must have an active revision");
  const harnessPod = await waitForProviderHarnessPod(topology.placement, revision);
  const turn = async (prompt) =>
    requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: await currentGatewayPod(topology),
      providerModel,
      prompt,
    });
  const before = `OCC-OPENSHELL-BEFORE-${randomUUID()}`;
  assert.match((await turn(`Reply with exactly ${before}.`)).assistant, new RegExp(before));
  // The same Pod and containers must serve both turns: revocation reaches the running Harness.
  const harnessProcess = async () => {
    const pod = await resource("pod", harnessPod.metadata.name, topology.placement);
    return {
      uid: pod.metadata.uid,
      restarts: (pod.status?.containerStatuses ?? []).map(({ name, restartCount }) => [
        name,
        restartCount,
      ]),
    };
  };
  const servingBefore = await harnessProcess();

  // A bare update re-sends the current Secret value; a replacement switches the source's Secret.
  const resynced = await request(
    "PATCH",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}`,
    {},
  );
  assert.equal(resynced.status, 200, JSON.stringify(resynced.error));
  assert.deepEqual(resynced.data.status, { state: "ready" });
  const replacement = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name: `openshell-model-replacement-${randomUUID()}`,
    value: modelCredential,
  });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.error));
  const replaced = await request(
    "PATCH",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}`,
    { secrets: { [modelSecretField]: replacement.data.ref } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.error));
  assert.deepEqual(replaced.data.secrets, { [modelSecretField]: replacement.data.ref });
  assert.equal(JSON.stringify(replaced).includes(modelCredential), false);

  // The API records the withdrawal; only the worker's confirmed detach makes it revoked.
  const withdrawalPath = `/namespaces/${namespaceId}/agents/${agentId}/credential-sources/${sourceId}`;
  const requested = await request("POST", `${withdrawalPath}/withdraw`);
  assert.equal(requested.status, 202, JSON.stringify(requested.error));
  assert.equal(requested.data.revisionId, revision.id);
  assert.equal(typeof requested.data.requestedBy, "string");
  const revoked = await waitFor(
    "the worker to confirm credential revocation",
    async () => {
      const observed = await request("GET", `${withdrawalPath}/withdrawal`);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.state === "revoked" ? observed.data : undefined;
    },
    180_000,
  );
  assert.ok(revoked.completedAt);
  assert.equal(revoked.requestedBy, requested.data.requestedBy);
  assert.equal(revoked.reason, "CREDENTIALS_WITHDRAWN");
  const unchanged = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(unchanged.data.activeRevisionId, revision.id, "withdrawal must not redeploy");

  // A successful turn after withdrawal violates the live-revocation boundary.
  const after = `OCC-OPENSHELL-AFTER-${randomUUID()}`;
  let observation;
  let result;
  let rejected = false;
  try {
    result = await turn(`Reply with exactly ${after}.`);
  } catch (error) {
    rejected = true;
    observation = error instanceof Error ? error.message : String(error);
  }
  if (!rejected) {
    observation = JSON.stringify(result);
  }
  assert.equal(
    String(observation).includes(modelCredential),
    false,
    "a revoked turn must not expose the model key",
  );
  assert.equal(rejected, true, "a turn must not complete after credential withdrawal");
  assert.deepEqual(
    await harnessProcess(),
    servingBefore,
    "withdrawal must revoke from the running Harness without replacing or restarting it",
  );

  // The active revision still references the source, so it cannot be deleted yet.
  const deletion = await request(
    "DELETE",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}`,
  );
  assert.equal(deletion.status, 409, JSON.stringify(deletion.error));
}

// Each section keeps its newest matching lines within its own budget, so the Harness and
// OpenShell supervisor lines still fit the 16 KiB failure message after the Gateway's.
// Workspace-node disconnects (finding 1496) need the node host's close line and the
// supervisor's connection events, so those sources keep timestamps. Every clip runs after
// redaction: a value cut in half could no longer be matched by the reporter.
const turnDiagnosticLineChars = 400;
const turnDiagnosticErrorChars = 300;
const turnDiagnosticNoise =
  /identity scope grant elevated connection identity=occ-workspace-files|authenticated user (?:connected|disconnected) .*user=occ-workspace-files/u;

function turnDiagnosticLines(logs, pattern, budget, secrets) {
  return newestMatchingLogLines(logs, secrets, {
    pattern,
    exclude: turnDiagnosticNoise,
    budget,
    lineChars: turnDiagnosticLineChars,
  });
}

// Failure diagnostics read with a request timeout, so a stalled API server or log stream
// cannot hold them (finding 1550). A read retries a dropped transport once: kubectl reports
// its own request timeout as a transient failure, and each attempt may take the whole timeout.
function diagnosticKubectl(...args) {
  return retryKubectlRead(() => kubectl(diagnosticRequestTimeout, ...args), { attempts: 2 });
}

async function diagnosticResource(kind, name, namespace) {
  return JSON.parse(
    await diagnosticKubectl("get", kind, name, "--namespace", namespace, "-o", "json"),
  );
}

async function diagnosticResources(kind, namespace) {
  return JSON.parse(await diagnosticKubectl("get", kind, "--namespace", namespace, "-o", "json"))
    .items;
}

// The network supervisor serving this Harness shares its boundary pair, as in the L7 denial
// proof below. Anything other than exactly one match reads no supervisor: another Agent's
// supervisor in the same namespace is not evidence for this Harness.
async function openShellSupervisorPod(topology) {
  if (topology.harnessPod === undefined) {
    throw new Error("no Harness Pod was found");
  }
  const boundaryPair = topology.harnessPod.metadata.labels?.["openshell.ai/boundary-pair"];
  if (!boundaryPair) {
    throw new Error("the Harness has no openshell.ai/boundary-pair label");
  }
  const supervisors = (await diagnosticResources("pods", topology.placement)).filter(
    (pod) =>
      pod.metadata.labels?.["openshell.ai/boundary-role"] === "supervisor" &&
      pod.metadata.labels?.["openshell.ai/boundary-pair"] === boundaryPair,
  );
  if (supervisors.length !== 1) {
    throw new Error(`${supervisors.length} supervisor Pods match the Harness boundary pair`);
  }
  return supervisors[0];
}

// Finding 1882: the first Workspace read once answered 503 DEPENDENCY_UNAVAILABLE right after
// the Sandbox was ready. The API keeps the cause out of its answer. The read reaches the Agent
// Gateway through the Envoy Gateway and the host relay; a failed read records the Agent Gateway
// hop (its Pods, and its log including the Workspace identity's own connect lines), then how a
// second read answered after them (still failed, or a delay that passed). The test fails either
// way: a 503 right after "ready" may be a real readiness bug, so the read is not retried.
async function workspaceReadFailureDiagnostic({
  request,
  path,
  agentId,
  gatewayPlacement,
  secrets,
}) {
  const shown = (value, limit) =>
    redactLogLine(typeof value === "string" ? value : JSON.stringify(value), secrets, limit);
  const sections = [];
  try {
    const pods = (await diagnosticResources("pods", gatewayPlacement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === agentId,
    );
    const states = pods.map((pod) => ({
      name: pod.metadata.name,
      phase: pod.status?.phase,
      deleting: pod.metadata.deletionTimestamp !== undefined,
      conditions: (pod.status?.conditions ?? []).map(({ type, status, reason }) => ({
        type,
        status,
        reason,
      })),
      containers: (pod.status?.containerStatuses ?? []).map((status) => ({
        name: status.name,
        ready: status.ready,
        restartCount: status.restartCount,
        state: status.state,
      })),
    }));
    sections.push(`Agent Gateway Pods: ${shown(states, 2_000)}`);
    for (const pod of pods.slice(0, 2)) {
      const logs = await diagnosticKubectl(
        "logs",
        pod.metadata.name,
        "--namespace",
        gatewayPlacement,
        "--tail=500",
        "--timestamps",
      );
      sections.push(
        `Agent Gateway ${pod.metadata.name} log:\n${newestMatchingLogLines(logs, secrets, {
          pattern: /error|warn|fail|workspace|ready|listen|start|connect|hello|auth|denied|close/iu,
          budget: 4_000,
          lineChars: turnDiagnosticLineChars,
        })}`,
      );
    }
  } catch (error) {
    sections.push(
      `Agent Gateway diagnostics unavailable: ${shown(error?.message ?? String(error), 300)}`,
    );
  }
  try {
    const again = await request("GET", path);
    sections.push(
      `A second read after these diagnostics answered ${again.status}` +
        (again.status === 200 ? "" : ` ${shown(again.error, 300)}`),
    );
  } catch (error) {
    sections.push(`A second read failed: ${shown(error?.message ?? String(error), 300)}`);
  }
  return `\n${sections.join("\n")}`;
}

function turnFailureSecrets(topology, gatewayPassword) {
  return failureSecrets([
    process.env,
    {
      MODEL_CREDENTIAL: modelCredential,
      GATEWAY_PASSWORD: gatewayPassword,
      APP_SERVER_TOKEN: topology.appServerToken,
    },
    Object.fromEntries(
      (topology.toolSources ?? []).map(({ token }, index) => [`TOOL_TOKEN_${index}`, token]),
    ),
  ]);
}

// `budgets` lets a caller that adds its own sections keep the whole message under 16 KiB.
// Without a Harness Pod (a replacement that never started one) only the Gateway is read.
function gatewayTurnFailureDiagnostic(topology, gatewayPassword, budgets) {
  return withinDiagnosticDeadline(
    () => readGatewayTurnFailureDiagnostic(topology, gatewayPassword, budgets),
    { timedOut: `\nGateway turn diagnostic timed out after ${diagnosticDeadlineMs / 1_000} s` },
  );
}

async function readGatewayTurnFailureDiagnostic(
  topology,
  gatewayPassword,
  { gateway = 5_000, harness = 4_000, supervisor = 4_000 } = {},
) {
  const secrets = turnFailureSecrets(topology, gatewayPassword);
  const missingHarness = new Error("no Harness Pod was found");
  const unavailable = (label, error) =>
    `${label} diagnostics unavailable: ${redactLogLine(
      error?.message ?? String(error),
      secrets,
      turnDiagnosticErrorChars,
    )}`;
  const sources = [
    {
      label: "Gateway",
      name: topology.gatewayPod.metadata.name,
      namespace: topology.gatewayPlacement,
      logArguments: ["--tail=2000"],
      budget: gateway,
      pattern:
        /error|warn|workspace|model|openai|worker|node|inference|turn|fetch|network|policy|disconnect|close|pair|reload|skill/iu,
    },
    topology.harnessPod === undefined
      ? { label: "Harness", lookupError: missingHarness }
      : {
          label: "Harness",
          name: topology.harnessPod.metadata.name,
          namespace: topology.placement,
          logArguments: ["--container", "agent", "--tail=2000", "--timestamps"],
          budget: harness,
          pattern:
            /error|warn|workspace|model|openai|worker|node host|inference|turn|fetch|network|policy|disconnect|close|reconnect|frozen|mediation/iu,
        },
  ];
  try {
    const pod = await openShellSupervisorPod(topology);
    sources.push({
      label: `OpenShell supervisor ${pod.metadata.name}`,
      name: pod.metadata.name,
      namespace: topology.placement,
      logArguments: ["--container", "supervisor", "--tail=2000", "--timestamps"],
      budget: supervisor,
      // OCSF CONFIG: lines record policy loads and changes, and a DENIED line names the refused
      // destination with its reason, such as a stale policy generation (finding 1496). Allowed
      // OCSF lines also carry `[policy:...]`, so the bare word would only add noise.
      pattern:
        /error|warn|lost|frozen|recover|reconnect|mediation|connection|disconnect|close|terminat|kill|expire|\bCONFIG:|\bDENIED\b|generation/iu,
    });
  } catch (error) {
    sources.push({ label: "OpenShell supervisor", lookupError: error });
  }
  const sections = [];
  for (const source of sources) {
    if (source.lookupError !== undefined) {
      sections.push(unavailable(source.label, source.lookupError));
      continue;
    }
    try {
      const logs = await diagnosticKubectl(
        "logs",
        source.name,
        "--namespace",
        source.namespace,
        ...source.logArguments,
      );
      sections.push(
        `${source.label} diagnostics:\n${turnDiagnosticLines(logs, source.pattern, source.budget, secrets)}`,
      );
    } catch (error) {
      sections.push(unavailable(source.label, error));
    }
  }
  try {
    if (topology.harnessPod === undefined) {
      throw missingHarness;
    }
    const pod = await diagnosticResource(
      "pod",
      topology.harnessPod.metadata.name,
      topology.placement,
    );
    const containers = (pod.status?.containerStatuses ?? []).map((status) => ({
      name: status.name,
      state: status.state,
      restartCount: status.restartCount,
    }));
    // A terminated container's message can hold 4 KB; keep the other sections in the message.
    sections.push(
      `Harness Pod: ${redactLogLine(JSON.stringify({ phase: pod.status?.phase, containers }), secrets, 1_000)}`,
    );
  } catch (error) {
    sections.push(unavailable("Harness Pod status", error));
  }
  return `\n${sections.join("\n")}`;
}

async function requestGatewayTurns(context, topology, harnessId) {
  const passwordSecret = await resource(
    "secret",
    `gateway-password-${hash(topology.agent.id)}`,
    topology.gatewayPlacement,
  );
  const gatewayPassword = Buffer.from(passwordSecret.data["gateway-password"], "base64").toString();
  const forwarding = await startGatewayPortForward(
    topology.gatewayPlacement,
    openShellGatewayName(topology.agent.id),
  );
  context.after(() => forwarding.stop());
  const sessionKey = `openshell-gateway-${randomUUID()}`;
  const nonces = [];
  const requestTurn = async () => {
    const nonce = `OCC-OPENSHELL-GATEWAY-${randomUUID()}`;
    nonces.push(nonce);
    const prompt =
      harnessId === "codex"
        ? `Use the shell exec tool to run exactly printf '%s' '${nonce}'. Reply with its output.`
        : `Reply with exactly ${nonce}.`;
    let response;
    try {
      response = await fetch(`${forwarding.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayPassword}`,
          "content-type": "application/json",
          "x-openclaw-session-key":
            harnessId === "codex" ? sessionKey : `openshell-native-${randomUUID()}`,
        },
        body: JSON.stringify({
          model: "openclaw/default",
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      const diagnostic = await gatewayTurnFailureDiagnostic(topology, gatewayPassword);
      assert.fail(
        `Agent Gateway turn request failed: ${error?.message ?? String(error)}${diagnostic}`,
      );
    }
    const body = await response.text();
    assert.equal(body.includes(modelCredential), false);
    assert.equal(body.includes(gatewayPassword), false);
    const failureDiagnostic =
      response.status === 200 ? "" : await gatewayTurnFailureDiagnostic(topology, gatewayPassword);
    assert.equal(
      response.status,
      200,
      `Gateway ${harnessId} turn ${nonces.length}: HTTP ${response.status}, expected 200.${failureDiagnostic}`,
    );
    assert.match(JSON.parse(body).choices?.[0]?.message?.content ?? "", new RegExp(nonce));
  };

  // Codex reuses the Gateway session to cover the bridge's next-turn policy. Native
  // OpenClaw uses distinct sessions to exercise its multiple retained worker slots.
  await requestTurn();
  await requestTurn();
  if (harnessId === "codex") {
    // Inspect native, durable command records, not the model's claim that it ran printf.
    // The HTTP requests above must pass through the regular OpenClaw bridge.
    const claims = new Set(
      topology.harnessPod.spec.volumes
        .filter(({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName)
        .map(({ name }) => name),
    );
    const roots = topology.harnessPod.spec.containers
      .find(({ name }) => name === "agent")
      .volumeMounts.filter(({ name }) => claims.has(name))
      .map(({ mountPath }) => mountPath);
    await waitFor(
      "successful native shell commands for both Gateway turns",
      async () => {
        const rollouts = await readHarnessFiles(topology.placement, topology.harnessPod, roots);
        // Both commands must complete in order in one native thread, not two fresh rollouts.
        return (
          rollouts.some(({ path, content }) => {
            if (!path.endsWith(".jsonl")) {
              return false;
            }
            let next = 0;
            // The writer may still be flushing its last record after the HTTP response.
            const lines = content.toString("utf8").split("\n").slice(0, -1).filter(Boolean);
            for (const line of lines) {
              const { type, payload } = JSON.parse(line);
              if (type !== "event_msg" || payload.type !== "item_completed") {
                continue;
              }
              const command = payload.item;
              const nonce = nonces[next];
              if (
                command.type === "CommandExecution" &&
                command.command.join(" ").includes(nonce) &&
                command.exit_code === 0 &&
                command.aggregated_output?.trim() === nonce
              ) {
                next += 1;
                if (next === nonces.length) {
                  return true;
                }
              }
            }
            return false;
          }) || undefined
        );
      },
      30_000,
    );
  }
}

async function assertNativeOpenClawWorkspaceFiles(topology) {
  const path = `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}/workspace/files/AGENTS.md`;
  const content = "# Dedicated native OpenClaw\n";
  const written = await topology.request("PUT", path, { content });
  assert.equal(written.status, 200, JSON.stringify(written.error));
  const read = await topology.request("GET", path);
  assert.equal(read.status, 200, JSON.stringify(read.error));
  assert.deepEqual(read.data, { name: "AGENTS.md", content });
}

async function holdNativeOpenClawDemo(context, topology) {
  assert.ok(demoStatePath, "OCC_K3D_DEMO_STATE is required for the browser demo.");
  assert.equal(topology.controllerUrl, `http://127.0.0.1:${demoConsolePort}`);
  const forwarding = await fixture.startPortForwardTarget(
    topology.gatewayPlacement,
    `service/${openShellGatewayName(topology.agent.id)}`,
    `${demoControlUiPort}:8080`,
  );
  context.after(() => forwarding.stop());
  assert.equal(forwarding.url, `http://127.0.0.1:${demoControlUiPort}`);

  const passwordSecret = await resource(
    "secret",
    `gateway-password-${hash(topology.agent.id)}`,
    topology.gatewayPlacement,
  );
  const encodedGatewayPassword = passwordSecret.data?.["gateway-password"];
  assert.ok(encodedGatewayPassword, "the demo requires a direct Control UI password.");
  const gatewayPassword = Buffer.from(encodedGatewayPassword, "base64").toString();
  const controlUiUrl = `${forwarding.url}/new`;
  const consoleUrl = `${topology.controllerUrl}/console/agents?namespace=${topology.namespaceId}`;
  context.after(() => rm(demoStatePath, { force: true }));
  await writeFile(
    demoStatePath,
    `${JSON.stringify({
      namespace: topology.placement,
      namespaceId: topology.namespaceId,
      agentId: topology.agent.id,
      processId: String(process.pid),
      controlUiUrl,
      gatewayPassword,
      consoleUrl,
      consoleUsername: topology.credentials.email,
      consolePassword: topology.credentials.password,
    })}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    [
      "",
      "OpenClaw",
      `  Control UI:  ${controlUiUrl}`,
      "  Password:    ./scripts/k3d copy openclaw-password",
      "",
      "OpenClaw Control Plane (OCC)",
      `  Console:   ${consoleUrl}`,
      `  Username:  ${topology.credentials.email}`,
      "  Password:  ./scripts/k3d copy occ-password",
      "",
      "Kubernetes",
      `  Namespace:     ${topology.placement}`,
      `  Namespace ID:  ${topology.namespaceId}`,
      `  Agent ID:      ${topology.agent.id}`,
      `  Kubeconfig:    ${process.env.OCC_TEST_KUBERNETES_KUBECONFIG}`,
      `  Context:       ${process.env.OCC_TEST_KUBERNETES_CONTEXT}`,
      "",
      "Both consoles are exposed only on loopback. Press Ctrl-C to remove the demo Agent resources.",
      "",
    ].join("\n"),
  );

  const stopForAbort = () => resolveDemoStop();
  context.signal.addEventListener("abort", stopForAbort, { once: true });
  try {
    await demoStopping;
  } finally {
    context.signal.removeEventListener("abort", stopForAbort);
  }
}

async function assertAuthenticatedNativePolicyScopes(topology) {
  const current = await topology.request(
    "GET",
    `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`,
  );
  assert.equal(current.status, 200, JSON.stringify(current.error));
  assert.ok(current.data.activeRevisionId);
  const activeSandbox = await waitForSandbox(topology.placement, {
    id: current.data.activeRevisionId,
    agentId: topology.agent.id,
  });
  const nativeRequest = {
    workspace: topology.placement,
    sandbox: activeSandbox.metadata.name,
  };
  const before = await topology
    .gatewayClient()
    .getPolicyStatus(nativeRequest, AbortSignal.timeout(10_000));
  const sandbox = await topology
    .gatewayClient()
    .getSandbox(
      { workspace: nativeRequest.workspace, name: nativeRequest.sandbox },
      AbortSignal.timeout(10_000),
    );
  assert.ok(sandbox?.resourceVersion);
  const directory = await mkdtemp(join(tmpdir(), "oce-policy-scopes-"));
  const clients = [];
  const release = `openshell-${hash(topology.placement, 10)}`;
  const originalPath = join(directory, "original-values.json");
  const authenticatedPath = join(directory, "authenticated-values.json");
  let savedValues = false;
  const configureAuthentication = async (enabled) => {
    await executeFile(
      openShellHelmPath,
      [
        "upgrade",
        release,
        openShellHelmChart,
        "--namespace",
        topology.placement,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
        "--reset-values",
        "--values",
        enabled ? authenticatedPath : originalPath,
        "--wait",
        "--timeout",
        "240s",
      ],
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
    );
    await waitForOpenShellGateway(topology.placement);
    await topology.restartGatewayForward();
  };
  await topology.pauseWorker();
  try {
    const original = await executeFile(
      openShellHelmPath,
      [
        "get",
        "values",
        release,
        "--output=json",
        "--namespace",
        topology.placement,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
      ],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(originalPath, original.stdout, { mode: 0o600 });
    savedValues = true;
    const values = JSON.parse(original.stdout);
    values.gatewayConfig = {
      ...values.gatewayConfig,
      "openshell.gateway.auth": { allow_unauthenticated_users: false },
      // Legacy chart values omit empty roles and retain OpenShell's nonempty defaults.
      "openshell.gateway.oidc": {
        issuer: topology.keycloak.issuer,
        audience: "openshell-cli",
        admin_role: "",
        user_role: "",
        scopes_claim: "oce_scopes",
      },
    };
    values.server.oidc = { ...values.server.oidc, caConfigMapName: "oce-gateway-extra-trust" };
    await writeFile(authenticatedPath, JSON.stringify(values), { mode: 0o600 });
    // Replace the unauthenticated management configuration with the real HTTPS issuer.
    // Role-free OIDC mode still enforces each RPC's independently declared scopes.
    await configureAuthentication(true);
    const scopedClient = async (name) => {
      const path = join(directory, name);
      await writeFile(path, await topology.keycloak.scopedClientToken(name), { mode: 0o600 });
      const client = topology.gatewayClient({ mode: "bearerTokenFile", path });
      clients.push(client);
      return client;
    };
    const reader = await scopedClient("policy-reader");
    const recommender = await scopedClient("policy-recommender");
    const writer = await scopedClient("policy-writer");
    const noScopes = await scopedClient("policy-no-scopes");
    const read = (client) => client.getPolicyStatus(nativeRequest, AbortSignal.timeout(10_000));
    const recommendations = (client) =>
      client.getPolicyDrafts(nativeRequest, AbortSignal.timeout(10_000));
    const update = (client) =>
      client.updatePolicy(
        {
          ...nativeRequest,
          policy: before.policy,
          expectedResourceVersion: sandbox.resourceVersion,
          requestId: randomUUID(),
        },
        AbortSignal.timeout(10_000),
      );
    await assert.rejects(read(topology.gatewayClient()), { code: 16 });
    assert.deepEqual(await read(reader), before);
    await assert.rejects(read(noScopes), { code: 7 });
    await assert.rejects(recommendations(reader), { code: 7 });
    await assert.rejects(recommendations(noScopes), { code: 7 });
    const suggested = await recommendations(recommender);
    assert.ok(Array.isArray(suggested.chunks));
    await assert.rejects(read(recommender), { code: 7 });
    await assert.rejects(update(reader), { code: 7 });
    await assert.rejects(update(noScopes), { code: 7 });
    await assert.rejects(read(writer), { code: 7 });
    assert.deepEqual(await read(reader), before, "rejected writes must preserve native state");
    // OpenShell deduplicates an unchanged loaded policy. A writer may resubmit it,
    // while the reader independently confirms that enforcement remains loaded.
    await update(writer);
    const loaded = await waitFor(
      "authenticated native policy update to load",
      async () => {
        const current = await read(reader);
        return current.version >= before.version &&
          current.activeVersion === current.version &&
          current.state === "POLICY_STATUS_LOADED"
          ? current
          : undefined;
      },
      30_000,
    );
    assert.deepEqual(loaded.policy, before.policy);
    process.stderr.write(
      "OpenShell integration: authenticated sandbox:read, config:read and config:write policy boundaries passed.\n",
    );
  } finally {
    for (const client of clients) {
      client.close();
    }
    try {
      if (savedValues) {
        await configureAuthentication(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await topology.resumeWorker();
    }
  }
}

async function assertAgentNetworkPolicyLifecycle(topology) {
  const base = `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`;
  const policyPath = `${base}/sandbox-policy/networking`;
  const installationDiscovery = await topology.request(
    "GET",
    "/installation/driver-configurations",
  );
  assert.equal(installationDiscovery.status, 200, JSON.stringify(installationDiscovery.error));
  const startup = installationDiscovery.data.configurations.find(
    (entry) => entry.capability === "sandbox",
  );
  assert.ok(startup);
  assert.equal(startup.scope, "installation");
  assert.equal(startup.key, "startup");
  assert.deepEqual(startup.actions, {});
  assert.equal(
    Object.hasOwn(startup, "configuration"),
    false,
    "discovery must not expose startup values",
  );
  const grant = {
    id: "python-demo",
    binary: "/usr/bin/python3.11",
    host: topology.tokenEcho.host,
    ports: [{ from: topology.tokenEcho.policyPort, to: topology.tokenEcho.policyPort }],
  };
  const python = async (agentId = topology.agent.id, port = topology.tokenEcho.policyPort) => {
    const pods = await resources("pods", topology.gatewayPlacement);
    const gateway = pods.find(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/agent"] === agentId &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
    );
    assert.ok(gateway);
    // HTTP error responses still prove connectivity; sandbox refusal remains an uncaught URLError.
    const command = `/usr/bin/python3.11 - <<'PYTHON'
import urllib.request, urllib.error, json
try:
    response = urllib.request.urlopen("http://${grant.host}:${port}/policy-probe", timeout=20)
except urllib.error.HTTPError as error:
    response = error
print("HTTP", response.code)
print("POLICY_PROBE", json.loads(response.read())["path"])
PYTHON`;
    const result = await requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: gateway.metadata.name,
      providerModel,
      prompt: `Run exactly this command once through the exec tool, without changing it or attempting other network tools. Report its exit status and output: ${command}`,
    });
    const executed = result.items
      .filter(({ method }) => method === "item/completed")
      .map(({ params }) => params?.item)
      .find(
        (item) => item?.type === "commandExecution" && item.command?.includes("urllib.request"),
      );
    assert.ok(executed, "the real Agent must execute the Python command");
    assert.ok(executed.command.includes("/usr/bin/python3.11"));
    assert.ok(executed.command.includes(`http://${grant.host}:${port}/policy-probe`));
    return executed;
  };
  // Prove both listeners and cluster DNS independently before interpreting a policy denial.
  const reachable = await kubectl(
    "exec",
    "pod/token-echo",
    "--namespace",
    topology.tokenEcho.namespace,
    "--",
    "node",
    "-e",
    `fetch("http://${grant.host}:${topology.tokenEcho.policyPort}/policy-probe").then(async r => { if (r.status !== 200 || (await r.json()).path !== "/policy-probe") process.exit(1); console.log("reachable"); })`,
  );
  assert.match(reachable, /reachable/);
  const control = await python(topology.agent.id, 8082);
  assert.equal(
    control.exitCode,
    0,
    "the Installation default permits the real Agent's control request",
  );
  assert.match(control.aggregatedOutput ?? "", /POLICY_PROBE \/policy-probe/);
  // Before any additions, enforcement denies the actual interpreter request.
  const denied = await python();
  assert.notEqual(denied.exitCode, 0);
  assert.match(denied.aggregatedOutput ?? "", /Permission denied|Errno 13/);
  const logs = await topology.request(
    "GET",
    `${base}/deployments/${topology.revision.id}/runtime/logs?source=sandbox&tailLines=1000`,
  );
  assert.equal(logs.status, 200, JSON.stringify(logs.error));
  const blocked = logs.data.records.find(
    ({ decision }) =>
      decision?.decision === "denied" &&
      decision.enforcement === "blocked" &&
      decision.binary === grant.binary &&
      decision.port === topology.tokenEcho.policyPort,
  );
  assert.ok(blocked, "the provider must record the exact executable and denied target port");
  // An unmapped port is logged against the synthetic policy IP. Bind it to the real DNS
  // mapping rather than treating an unrelated denial or a failed DNS lookup as enforcement.
  assert.ok(
    blocked.decision.host === grant.host ||
      logs.data.records.some(
        ({ message }) =>
          message?.includes(`Policy DNS mapped ${grant.host} `) &&
          message.includes(`synthetic=${blocked.decision.host} `),
      ),
    "the denied address must map to the requested destination",
  );
  const suggestions = await topology.request(
    "GET",
    `${base}/revisions/${topology.revision.id}/sandbox-policy/networking/recommendations`,
  );
  assert.equal(suggestions.status, 200, JSON.stringify(suggestions.error));
  const initial = await topology.request("GET", policyPath);
  assert.equal(initial.data.editingEnabled, false);
  assert.equal(
    (
      await topology.request("PUT", policyPath, {
        expectedVersion: initial.data.policy.version,
        additions: [grant],
      })
    ).status,
    409,
  );
  assert.equal(
    (await topology.request("PATCH", `${policyPath}/editing`, { enabled: true })).status,
    200,
  );
  let version = initial.data.policy.version;
  // Native state and actual dispatches are independent of OCC's application record.
  // Restrictions revoke the original caller's exact authority after admission.
  const providerPolicy = () =>
    topology
      .gatewayClient()
      .getPolicyStatus(
        { workspace: topology.placement, sandbox: topology.sandbox.metadata.name },
        AbortSignal.timeout(10_000),
      );
  for (const [action, kind, id] of [
    ["manage_policy", "agent", topology.agent.id],
    ["update", "sandbox_policy", initial.data.policy.id],
  ]) {
    const saved = await topology.request("PUT", policyPath, {
      expectedVersion: version,
      additions: [grant],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.error));
    version = saved.data.version;
    const before = await providerPolicy();
    const writes = topology.policyWrites.length;
    const restriction = `restriction-${randomUUID()}`;
    const revoke = () =>
      topology.policyFixturePool.query(
        "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,$3,$4,$5,'deny')",
        [restriction, topology.namespaceId, action, kind, id],
      );
    const restore = () =>
      topology.policyFixturePool.query("DELETE FROM occ.iam_restrictions WHERE id=$1", [
        restriction,
      ]);
    let admissionDenials;
    await topology.pauseWorker();
    try {
      await revoke();
      const forbidden = await topology.request("POST", `${policyPath}/apply`, {
        expectedVersion: version,
        revisionId: topology.revision.id,
      });
      assert.equal(forbidden.status, 403, JSON.stringify(forbidden.error));
      admissionDenials = await topology.observerPool.query(
        "SELECT id FROM occ.audit_events WHERE kind='authorization_denial' AND action='openclaw.agents.sandbox_policy.apply' AND resource_id=$1",
        [id],
      );
      await restore();
      const queued = await topology.request("POST", `${policyPath}/apply`, {
        expectedVersion: version,
        revisionId: topology.revision.id,
      });
      assert.equal(queued.status, 202, JSON.stringify(queued.error));
      await revoke();
    } finally {
      await topology.resumeWorker();
    }
    try {
      const failed = await waitFor(
        "queued policy rejected after exact authority revocation",
        async () => {
          const view = await topology.request("GET", policyPath);
          assert.equal(view.status, 200, JSON.stringify(view.error));
          return view.data.policy.application?.state === "failed"
            ? view.data.policy.application
            : undefined;
        },
        30_000,
      );
      assert.equal(failed.reason, "AUTHORIZATION_DENIED");
      assert.equal(
        topology.policyWrites.length,
        writes,
        "forbidden authority must be rejected before native UpdateConfig dispatch",
      );
      assert.deepEqual(
        await providerPolicy(),
        before,
        "native enforcement must preserve its loaded policy and version",
      );
      const denial = await topology.observerPool.query(
        "SELECT id, actor_id FROM occ.audit_events WHERE kind='authorization_denial' AND action='openclaw.agents.sandbox_policy.apply' AND resource_id=$1",
        [id],
      );
      assert.ok(
        denial.rows.some(
          (event) =>
            event.actor_id === failed.requestedBy &&
            !admissionDenials.rows.some((previous) => previous.id === event.id),
        ),
        "the worker must audit the revoked requester's exact denied authority",
      );
      process.stderr.write(
        `OpenShell integration: revoked ${kind}/${action} refused before native UpdateConfig.\n`,
      );
    } finally {
      await restore();
    }
  }
  const change = async (additions, interruptAfterWrite = false) => {
    const discovered = await topology.request("GET", `${base}/driver-configurations`);
    assert.equal(discovered.status, 200, JSON.stringify(discovered.error));
    const descriptor = discovered.data.configurations.find(
      (entry) => entry.actions.read.href === policyPath,
    );
    assert.ok(descriptor);
    assert.equal(descriptor.driverId, startup.driverId);
    const before = await topology.request("GET", policyPath);
    const preview = await topology.request(
      descriptor.actions.validate.method,
      descriptor.actions.validate.href,
      { expectedVersion: version, additions },
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.error));
    assert.deepEqual(preview.data, { success: true, data: { additions } });
    assert.deepEqual(
      (await topology.request("GET", policyPath)).data.policy,
      before.data.policy,
      "preview must not save or queue work",
    );
    const saved = await topology.request("PUT", policyPath, {
      expectedVersion: version,
      additions,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.error));
    version = saved.data.version;
    const writes = topology.policyWrites.length;
    let wrote = false;
    if (interruptAfterWrite) {
      // The real UpdateConfig has committed. Withhold its receipt until worker shutdown
      // aborts the in-flight pass; no provider behavior or policy result is replaced.
      topology.setPolicyWriteBarrier(async (signal) => {
        topology.setPolicyWriteBarrier(undefined);
        wrote = true;
        await new Promise((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
    }
    // Stage the application while the real worker is stopped, then prove durable recovery
    // through a new worker and database pool before any provider effect occurs.
    await topology.pauseWorker();
    try {
      const applied = await topology.request("POST", `${policyPath}/apply`, {
        expectedVersion: version,
        revisionId: topology.revision.id,
      });
      assert.equal(applied.status, 202, JSON.stringify(applied.error));
      assert.equal(applied.data.application.state, "pending");
    } finally {
      await topology.resumeWorker();
    }
    if (interruptAfterWrite) {
      await waitFor(
        "native UpdateConfig before interruption",
        async () => (wrote ? true : undefined),
        30_000,
      );
      await topology.pauseWorker();
      await topology.resumeWorker();
    }
    await waitFor(
      "matching loaded live network policy",
      async () => {
        const view = await topology.request("GET", policyPath);
        assert.equal(view.status, 200, JSON.stringify(view.error));
        assert.notEqual(
          view.data.policy.application?.state,
          "failed",
          JSON.stringify(view.data.policy.application),
        );
        return view.data.policy.application?.state === "applied" ? view.data : undefined;
      },
      120_000,
    );
    topology.setPolicyWriteBarrier(undefined);
    if (interruptAfterWrite) {
      assert.equal(
        topology.policyWrites.length,
        writes + 1,
        "recovery must confirm the committed native write without issuing it again",
      );
      process.stderr.write(
        "OpenShell integration: interrupted native policy write recovered without a duplicate UpdateConfig.\n",
      );
    }
  };
  await change([grant], true);
  const allowed = await python();
  assert.equal(allowed.exitCode, 0, "a confirmed grant must permit the same real Python request");
  assert.match(allowed.aggregatedOutput ?? "", /HTTP [1-5][0-9]{2}/);
  const allowedLogs = await topology.request(
    "GET",
    `${base}/deployments/${topology.revision.id}/runtime/logs?source=sandbox&tailLines=1000`,
  );
  assert.equal(allowedLogs.status, 200, JSON.stringify(allowedLogs.error));
  assert.ok(
    allowedLogs.data.records.some(
      (row) =>
        row.decision?.decision === "allowed" &&
        row.decision.host === grant.host &&
        row.decision.binary === grant.binary &&
        row.decision.port === topology.tokenEcho.policyPort,
    ),
    "the provider confirms the real connection was allowed",
  );
  const unchanged = await topology.request("GET", base);
  assert.equal(
    unchanged.data.activeRevisionId,
    topology.revision.id,
    "live application must not redeploy",
  );
  const snapshot = await topology.observerPool.query(
    "SELECT admitted_spec->'sandbox_policy' AS policy FROM occ.agent_revisions WHERE id=$1",
    [topology.revision.id],
  );
  assert.deepEqual(
    snapshot.rows[0].policy.additions,
    [],
    "live changes must preserve immutable revision evidence",
  );
  // A second ordinary Agent shares the Installation defaults but receives no addition.
  const second = await deployAdditionalCredentialAgent(
    topology,
    topology.agent.harnessAuth.sourceId,
    [],
  );
  assert.equal(
    (await python(second.agent.id, 8082)).exitCode,
    0,
    "the second Agent retains Installation-default access",
  );
  const isolated = await python(second.agent.id);
  assert.notEqual(isolated.exitCode, 0, "another Agent must remain denied");
  assert.match(isolated.aggregatedOutput ?? "", /Permission denied|Errno 13/);
  // Release the shared credential reference before the later credential-revocation scenarios.
  const deleted = await topology.request("DELETE", second.path);
  assert.equal(deleted.status, 202, JSON.stringify(deleted.error));
  await waitFor(
    "isolated policy Agent deletion",
    async () => {
      const remaining = await topology.observerPool.query(
        "SELECT 1 FROM occ.agents WHERE id = $1",
        [second.agent.id],
      );
      return remaining.rowCount === 0 ? true : undefined;
    },
    120_000,
  );
  assert.equal(
    (await topology.request("PATCH", `${policyPath}/editing`, { enabled: false })).status,
    200,
  );
  assert.equal((await python()).exitCode, 0, "disabling editing must preserve approved access");
  assert.equal(
    (await topology.request("PUT", policyPath, { expectedVersion: version, additions: [] })).status,
    409,
  );
  assert.equal(
    (await topology.request("PATCH", `${policyPath}/editing`, { enabled: true })).status,
    200,
  );
  await change([]);
  const revoked = await python();
  assert.notEqual(revoked.exitCode, 0, "explicit removal must restore enforcement");
  assert.match(revoked.aggregatedOutput ?? "", /Permission denied|Errno 13/);
  assert.equal(
    (await python(topology.agent.id, 8082)).exitCode,
    0,
    "revoking an addition must preserve Installation-default access",
  );
}

async function assertOpenShellToolFilesystemAndNetworkEnforcement(topology) {
  const nonce = `openshell-boundary-${randomUUID()}`;
  const providerWorkspaceVariable = topology.gatewayPod.spec.containers
    .flatMap(({ env = [] }) => env)
    .find(({ name }) => name === "OPENCLAW_REMOTE_WORKSPACE_ROOT");
  assert.equal(
    providerWorkspaceVariable?.value,
    "/sandbox/enterprise",
    "the Agent Gateway must receive the OpenShell provider workspace contract.",
  );
  assert.equal(
    topology.gatewayPod.spec.containers
      .flatMap(({ env = [] }) => env)
      .find(({ name }) => name === "OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE")?.value,
    ":danger-full-access",
    "OpenShell must explicitly select the native Codex permission profile.",
  );
  const providerWorkspace = providerWorkspaceVariable.value;
  const harnessWorkspaceVariable = topology.harnessPod.spec.containers
    .flatMap(({ env = [] }) => env)
    .find(({ name }) => name === "OPENCLAW_WORKSPACE_DIR");
  assert.equal(
    harnessWorkspaceVariable?.value,
    providerWorkspace,
    "the OpenShell Harness and Agent Gateway must use the same workspace root.",
  );
  const harnessHome = topology.harnessPod.spec.containers
    .flatMap(({ env = [] }) => env)
    .find(({ name }) => name === "HOME")?.value;
  // Read only the path from the configuration the real Gateway consumes, never credentials.
  const hookDirectory = JSON.parse(
    await kubectl(
      "exec",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.gatewayPlacement,
      "--container",
      "gateway",
      "--",
      "node",
      "-e",
      [
        'const fs = require("node:fs");',
        'const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));',
        "process.stdout.write(JSON.stringify(config.plugins?.entries?.codex?.config?.appServer?.nativeHookRelay?.credentialDirectory ?? null));",
      ].join("\n"),
    ),
  );
  assert.equal(
    hookDirectory,
    `${harnessHome}/.oce-native-hooks`,
    "the Gateway must deliver native hook credentials into the Harness launcher's private directory.",
  );
  assert.equal(hookDirectory.startsWith(`${providerWorkspace}/`), false);
  const writablePath = `${providerWorkspace}/${nonce}.txt`;
  // OpenShell serves provider-profile files only when they are opened; access(2) reports them
  // missing. Reading proves the projected config is readable, and a write open is refused.
  const approvedPath = '"$OPENCLAW_PLUGIN_CODEX_CONFIG_TOML"';
  const approvedRead = `head -c 1 ${approvedPath} > /dev/null`;
  const readonlyPath = approvedPath;
  const escapedPath = `${providerWorkspace}/../${nonce}-escape.txt`;
  // Use native Codex, which is allowed to reach this host, so the refusal proves
  // path enforcement rather than curl's separate binary restriction. A fresh home
  // references the same opaque auth file without reusing cached cloud configuration.
  const deniedBackend = `https://chatgpt.com/backend-api/wham/${nonce}`;
  const deniedConfigPath = `/backend-api/wham/${nonce}/wham/config/bundle`;
  // Forced deletion requests native approval even in full-access mode. Use non-forced
  // cleanup of this fresh probe directory so the command reaches the OpenShell boundary.
  const deniedConfigCommand = `probe_home=$(mktemp -d) && (trap 'rm -r -- "$probe_home"' EXIT; ln -s "$CODEX_HOME/auth.json" "$probe_home/auth.json" && CODEX_HOME="$probe_home" codex -c 'cli_auth_credentials_store="file"' -c 'chatgpt_base_url="${deniedBackend}"' features list)`;
  const result = await requestCodexTurnFromGatewayPod({
    namespace: topology.gatewayPlacement,
    gatewayPod: topology.gatewayPod.metadata.name,
    providerModel,
    prompt:
      `Use the shell exec tool from ${providerWorkspace}. Run every numbered command in a ` +
      `separate exec tool invocation, continuing after commands that are expected to fail: ` +
      `(1) printf '${nonce}' > ${writablePath}; ` +
      `(2) ${approvedRead}; ` +
      `(3) touch ${readonlyPath}; ` +
      `(4) touch ${escapedPath}; ` +
      `(5) curl -fsSI --max-time 30 https://www.openclaw.org; ` +
      `(6) curl -fsSI --max-time 10 https://acme.com; ` +
      `Commands 1, 2, and 5 must succeed; commands 3, 4, and 6 must fail. ` +
      `Reply with exactly ${nonce}, WORKSPACE_WRITABLE, APPROVED_PATH_READABLE, ` +
      `READONLY_DENIED, ESCAPE_DENIED, OPENCLAW_ALLOWED, and ACME_DENIED ` +
      `if and only if those outcomes occurred.`,
  });
  const completedCommands = result.items
    .filter(({ method }) => method === "item/completed")
    .map(({ params }) => params?.item)
    .filter(({ type }) => type === "commandExecution");
  const approvedCommand = completedCommands.find(({ command }) =>
    String(command).includes("www.openclaw.org"),
  );
  const deniedCommand = completedCommands.find(({ command }) =>
    String(command).includes("acme.com"),
  );
  const workspaceCommand = completedCommands.find(({ command }) =>
    String(command).includes(writablePath),
  );
  const approvedPathCommand = completedCommands.find(({ command }) =>
    String(command).includes(approvedRead),
  );
  const readonlyCommand = completedCommands.find(({ command }) =>
    String(command).includes(`touch ${readonlyPath}`),
  );
  const escapedCommand = completedCommands.find(({ command }) =>
    String(command).includes(escapedPath),
  );
  assert.ok(workspaceCommand, "the real Codex Harness must attempt an approved workspace write.");
  assert.ok(approvedPathCommand, "the real Codex Harness must read its projected config path.");
  assert.ok(readonlyCommand, "the real Codex Harness must attempt writing the read-only mount.");
  assert.ok(escapedCommand, "the real Codex Harness must attempt escaping its workspace.");
  assert.ok(approvedCommand, "the real Codex Harness must execute the approved curl command.");
  assert.ok(deniedCommand, "the real Codex Harness must execute the denied curl command.");
  // A declined escalation alone is not evidence of an OS-level denial: require executed commands.
  for (const command of [readonlyCommand, escapedCommand, deniedCommand]) {
    assert.ok(Number.isSafeInteger(command.exitCode), "the denied command must have executed.");
  }
  assert.equal(workspaceCommand.exitCode, 0, "OpenShell must allow approved workspace writes.");
  assert.equal(approvedPathCommand.exitCode, 0, "OpenShell must allow projected config reads.");
  assert.notEqual(
    readonlyCommand.exitCode,
    0,
    "OpenShell must deny writes to its read-only mount.",
  );
  assert.notEqual(escapedCommand.exitCode, 0, "OpenShell must deny writes outside the workspace.");
  assert.equal(approvedCommand.exitCode, 0, "OpenShell must allow the approved destination.");
  assert.notEqual(deniedCommand.exitCode, 0, "OpenShell must deny the unapproved destination.");
  if (modelSourceType === "codex-pat") {
    // The backend probe gets its own turn: as a seventh command in the turn above, the model
    // sometimes ended its turn after the sixth and never started it (finding 1682).
    const backendNonce = `openshell-backend-${randomUUID()}`;
    const requestBackendTurn = () =>
      requestCodexTurnFromGatewayPod({
        namespace: topology.gatewayPlacement,
        gatewayPod: topology.gatewayPod.metadata.name,
        providerModel,
        prompt:
          `Use the shell exec tool from ${providerWorkspace} to run exactly this one command, ` +
          `which is expected to fail: ${deniedConfigCommand}. ` +
          `Then reply with exactly ${backendNonce}.`,
      });
    const startedCommands = (turn) =>
      turn.items.filter(
        ({ method, params }) =>
          method === "item/started" && params?.item?.type === "commandExecution",
      ).length;
    const hasCommandActivity = ({ items }) => {
      // The collector validates turn/completed and can return command output without a start or
      // completion. Ignore that output only if it explicitly belongs to another thread or turn.
      const { threadId, turn } = items.find(({ method }) => method === "turn/completed").params;
      const couldMatchId = (id, expected) => typeof id !== "string" || id === "" || id === expected;
      return items.some(({ method, params }) => {
        if (method === "item/commandExecution/outputDelta") {
          return couldMatchId(params?.threadId, threadId) && couldMatchId(params?.turnId, turn.id);
        }
        return (
          method === "item/commandExecution/requestApproval" ||
          ((method === "item/started" || method === "item/completed") &&
            params?.item?.type === "commandExecution")
        );
      });
    };
    let backendTurn = await requestBackendTurn();
    const skippedTurns = [];
    // Ask once more only when the turn showed no command activity at all. A rewritten,
    // declined, approval-gated or unsettled command is still judged below.
    if (!hasCommandActivity(backendTurn)) {
      skippedTurns.push({
        items: backendTurn.items.length,
        replyHasNonce: new RegExp(backendNonce).test(backendTurn.assistant),
      });
      backendTurn = await requestBackendTurn();
    }
    const backendCommands = backendTurn.items
      .filter(({ method }) => method === "item/completed")
      .map(({ params }) => params?.item)
      .filter(({ type }) => type === "commandExecution");
    const deniedConfigRequest = backendCommands.find(({ command }) =>
      String(command).includes(deniedBackend),
    );
    // How the turn went, by label only: a missing request then shows whether the model
    // skipped it, rewrote it, or asked for approval instead.
    const commandSummary = {
      skippedTurns,
      started: startedCommands(backendTurn),
      completed: backendCommands.map((command) => ({
        label:
          command === deniedConfigRequest
            ? "codex-backend"
            : /chatgpt_base_url|features list|backend-api/.test(String(command.command))
              ? "codex-rewritten"
              : "other",
        status: command.status,
        exitCode: command.exitCode,
        durationMs: command.durationMs ?? null,
      })),
      approvalRequests: backendTurn.items.filter(
        ({ method }) => method === "item/commandExecution/requestApproval",
      ).length,
      replyHasNonce: new RegExp(backendNonce).test(backendTurn.assistant),
    };
    assert.ok(
      deniedConfigRequest,
      `the real Codex binary must attempt the unapproved backend path: ${JSON.stringify(commandSummary)}.`,
    );
    assert.ok(
      Number.isSafeInteger(deniedConfigRequest.exitCode),
      `the forbidden backend request must execute (status=${deniedConfigRequest.status}, approvalRequested=${backendTurn.items.some(
        ({ method, params }) =>
          method === "item/commandExecution/requestApproval" &&
          params?.itemId === deniedConfigRequest.id,
      )}).`,
    );
    assert.notEqual(deniedConfigRequest.exitCode, 0);
    // The network supervisor runs outside the workload Pod. Match its boundary pair
    // so this proof reads only the audit events for the Harness that executed the probe.
    const boundaryPair = topology.harnessPod.metadata.labels?.["openshell.ai/boundary-pair"];
    assert.ok(boundaryPair, "the Harness must identify its OpenShell boundary pair.");
    const supervisors = (await resources("pods", topology.placement)).filter(
      (pod) =>
        pod.metadata.labels?.["openshell.ai/boundary-role"] === "supervisor" &&
        pod.metadata.labels?.["openshell.ai/boundary-pair"] === boundaryPair,
    );
    assert.equal(supervisors.length, 1, "the Harness must have exactly one network supervisor.");
    // A provider 404 or an unrelated CLI failure is insufficient: the real supervisor
    // must record its L7 denial of this exact native-Codex request. Unmatched paths
    // use the relay reason, not the generic HTTP policy-denial response text.
    await waitFor(
      "OpenShell denial of an unrelated Codex backend path",
      async () => {
        const logs = await kubectl(
          "logs",
          supervisors[0].metadata.name,
          "--namespace",
          topology.placement,
          "--all-containers=true",
          "--tail=500",
        );
        return logs
          .split("\n")
          .some(
            (line) =>
              line.includes(`L7_REQUEST deny GET chatgpt.com:443${deniedConfigPath}`) &&
              line.includes("reason=no L7 endpoint path matched request"),
          );
      },
      30_000,
    );
    assert.match(backendTurn.assistant, new RegExp(backendNonce));
  }
  assert.match(result.assistant, new RegExp(nonce));
  assert.match(result.assistant, /WORKSPACE_WRITABLE/);
  assert.match(result.assistant, /APPROVED_PATH_READABLE/);
  assert.match(result.assistant, /READONLY_DENIED/);
  assert.match(result.assistant, /ESCAPE_DENIED/);
  assert.match(result.assistant, /OPENCLAW_ALLOWED/);
  assert.match(result.assistant, /ACME_DENIED/);
}

// Prints NAME_EXIT and NAME_OUT for one probe command; stderr is dropped.
const sandboxProbeFunction = [
  'probe() { local name=$1; shift; local out; out=$("$@" 2>/dev/null); local code=$?;',
  '  printf "%s_EXIT=%s\\n%s_OUT=%s\\n" "$name" "$code" "$name" "$out"; }',
];

// Like probe, with a host: after curl's "could not resolve host" (exit 6) only, it prints what
// the resolver returns for the host as NAME_RESOLVER and the first exit as NAME_FIRST_EXIT, then
// runs the command once more (finding 1981). Any other exit is final.
const sandboxResolvingProbeFunction = [
  "probe_resolving() { local name=$1 host=$2; shift 2; local out code answer resolved;",
  '  out=$("$@" 2>/dev/null); code=$?;',
  '  if [ "$code" -eq 6 ]; then',
  '    answer=$(getent ahosts "$host" 2>&1); resolved=$?;',
  "    answer=$(printf '%s' \"$answer\" | tr '\\n' ' ' | cut -c1-400);",
  '    printf "%s_RESOLVER=exit %s: %s\\n" "$name" "$resolved" "$answer";',
  '    printf "%s_FIRST_EXIT=%s\\n" "$name" "$code"; sleep 2; out=$("$@" 2>/dev/null); code=$?;',
  "  fi;",
  '  printf "%s_EXIT=%s\\n%s_OUT=%s\\n" "$name" "$code" "$name" "$out"; }',
];

/**
 * Writes a probe script into the shared workspace and has Codex run it, so each command is a
 * Sandbox process behind OpenShell's proxy and the model never composes a credentialed command.
 * Returns the turn and readers for the script's NAME=value output lines.
 */
async function runSandboxProbe(topology, nonce, script, harnessPod = topology.harnessPod) {
  const scriptPath = `/sandbox/enterprise/${nonce}.sh`;
  await kubectl(
    "exec",
    harnessPod.metadata.name,
    "--namespace",
    topology.placement,
    "--container",
    "agent",
    "--",
    "sh",
    "-c",
    `printf '%s' '${Buffer.from(script).toString("base64")}' | base64 -d > ${scriptPath} && ` +
      `chmod 0644 ${scriptPath}`,
  );
  // Every credential the suite holds is checked on each turn, before any of it is printed.
  const secrets = [
    modelCredential,
    ...(topology.toolSources ?? []).map(({ token }) => token),
    topology.untrustedTlsSource?.token,
  ].filter(Boolean);
  const traceSecrets = failureSecrets([
    process.env,
    Object.fromEntries(secrets.map((value, index) => [`PROBE_CREDENTIAL_${index}`, value])),
  ]);
  const { result, run, traces } = await observeSandboxProbe({
    nonce,
    traceSecrets,
    async requestTurn(attempt) {
      if (attempt > 1) {
        await delay(20_000);
      }
      const turn = await requestCodexTurnFromGatewayPod({
        namespace: topology.gatewayPlacement,
        gatewayPod: await currentGatewayPod(topology),
        providerModel,
        prompt:
          `Use the shell exec tool to run exactly this one command: bash ${scriptPath}. ` +
          `Then reply with exactly ${nonce}.`,
      });
      const serialized = JSON.stringify(turn);
      assert.equal(
        secrets.some((value) => serialized.includes(value)),
        false,
        "a probe turn must not expose a credential.",
      );
      return turn;
    },
  });
  if (run === undefined) {
    process.stderr.write(
      `OpenShell integration: turns that skipped the probe:\n${traces.join("\n")}\n`,
    );
    // Codex logs why a tool call did not run, such as a dropped model stream. Lines that could
    // carry a credential or placeholder are dropped.
    const logs = await kubectl(
      "logs",
      harnessPod.metadata.name,
      "--namespace",
      topology.placement,
      "--container",
      "agent",
      "--tail=400",
    ).catch((error) => `logs unavailable: ${error.message}`);
    const relevant = String(logs)
      .split("\n")
      .filter((line) => /error|retry|retrying|disconnect|stream|tool|exec/i.test(line))
      .filter((line) => !/bearer|eyJ|openshell:resolve/i.test(line))
      .filter((line) => secrets.every((value) => !line.includes(value)))
      .slice(-30);
    process.stderr.write(
      `OpenShell integration: Harness log after a skipped probe:\n${relevant.join("\n")}\n`,
    );
  }
  assert.ok(run, `No probe command was observed in three turns.\n${traces.join("\n")}`);
  if (traces.length > 0) {
    process.stderr.write(
      `OpenShell integration: the probe ran after these turns without a probe command:\n${traces.join("\n")}\n`,
    );
  }
  assert.match(result.assistant, new RegExp(nonce));
  const output = String(run.aggregatedOutput ?? "");
  const value = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1]?.trim() ?? null;
  const exitCode = (name) => {
    const code = value(`${name}_EXIT`);
    return code === null ? null : Number(code);
  };
  return { result, run, value, exitCode };
}

/**
 * Proves the credentialed route from inside the Sandbox and records what the network allowed.
 * The probes run as one script that Codex executes, so each curl is a Sandbox process behind
 * OpenShell's proxy and holds only placeholders. The test writes the script into the shared
 * workspace, so the model never composes a credentialed command, and the script prints no
 * header or body, because OpenShell refuses a model request whose body carries a placeholder.
 */
async function assertCredentialRouteEnforcement(topology) {
  const { untrustedTls, untrustedTlsSource, toolSources } = topology;
  const [toolA] = toolSources;
  const nonce = `openshell-route-${randomUUID()}`;
  const { address: publicAddress } = await dns.promises.lookup("www.openclaw.org", { family: 4 });
  const script = [
    "#!/bin/bash",
    `body=/tmp/${nonce}.json`,
    // Read the same opaque placeholder the Harness uses; never copy the upstream credential.
    ...(modelSourceType === "codex-pat"
      ? [
          `model=$(node -e 'const fs=require("node:fs"); const path=require("node:path"); process.stdout.write(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"auth.json"),"utf8")).personal_access_token)')`,
        ]
      : [
          'model=$(for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null |',
          "  sed -n 's/^OPENAI_API_KEY=//p'; done | head -1)",
        ]),
    'printf "PLACEHOLDER_FOUND=%s\\n" "$([ -n "$model" ] && echo yes || echo no)"',
    `printf "PLACEHOLDER_INHERITED=%s\\n" "$([ -n "$${modelCredentialVariable}" ] && echo yes || echo no)"`,
    ...sandboxProbeFunction,
    ...sandboxResolvingProbeFunction,
    // The model placeholder sent to a tool host that curl may reach.
    `probe FOREIGN curl -sS -o "$body" -w '%{http_code}' --max-time 20 ` +
      `-H "Authorization: Bearer $model" ${toolA.url}`,
    `printf 'FOREIGN_PLACEHOLDER=%s\\n' "$(grep -o '"placeholder":[a-z]*' "$body" ` +
      `2>/dev/null | cut -d: -f2)"`,
    `printf 'FOREIGN_LENGTH=%s\\n' "$(grep -o '"length":[0-9]*' "$body" 2>/dev/null | cut -d: -f2)"`,
    // OpenShell names the reason when it refuses a credential for the wrong endpoint.
    `printf 'FOREIGN_REFUSAL=%s\\n' "$(grep -o 'credential_endpoint_mismatch' "$body" ` +
      `2>/dev/null | head -1)"`,
    // Probe an authenticated source endpoint from a child command. PAT identity validation
    // avoids requiring native Codex's per-workspace request headers; its model turn runs above.
    `probe MODEL curl -sS -o /dev/null -w '%{http_code},%{http_connect}' --max-time 60 ` +
      `-H "Authorization: Bearer $model" ` +
      (modelSourceType === "codex-pat"
        ? "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami"
        : `-H 'Content-Type: application/json' ` +
          `-d '${JSON.stringify({ model: providerModel, input: "Reply with OK.", max_output_tokens: 16 })}' ` +
          `${modelBaseUrl}/responses`),
    // Direct connections that skip the proxy, by name and by address.
    // OpenShell may intercept these transparently, so a host the policy allows can still answer;
    // a host it denies must not.
    // A one-off DNS miss on this path is not the policy's answer, so each host gets a second
    // try after exit 6 (finding 1995). The bare address needs no lookup and gets one try.
    `probe_resolving BYPASS_ALLOWED www.openclaw.org ` +
      `curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 ` +
      `https://www.openclaw.org`,
    `probe_resolving BYPASS_DENIED acme.com ` +
      `curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 ` +
      `https://acme.com`,
    `probe BYPASS_ADDRESS curl --noproxy '*' -sSk -o /dev/null -w '%{http_code}' --max-time 10 ` +
      `https://${publicAddress}`,
    `probe DNS sh -c 'getent hosts www.openclaw.org > /dev/null'`,
    // A tool source whose upstream presents a certificate from an untrusted CA.
    `verbose=$(curl -sv -o /dev/null --max-time 20 ` +
      `-H "Authorization: Bearer $${untrustedTlsSource.environmentName}" ` +
      `${untrustedTlsSource.url} 2>&1); printf 'TLS_EXIT=%s\\n' "$?"`,
    `printf 'TLS_ISSUER=%s\\n' "$(printf '%s\\n' "$verbose" | sed -n 's/^\\*  *issuer: *//p' | head -1)"`,
    `printf 'TLS_HTTP=%s\\n' "$(printf '%s\\n' "$verbose" | ` +
      `sed -n 's/^< HTTP\\/[^ ]* \\([0-9]*\\).*/\\1/p' | head -1)"`,
    "",
  ].join("\n");
  const tlsEventsBefore = (await untrustedTls.events()).length;
  const { value, exitCode } = await runSandboxProbe(topology, nonce, script);
  // Pod-level NetworkPolicy governs connections made outside the Sandbox's network namespace,
  // such as the supervisor's. The provider-fenced profile grants the Pod no public egress.
  const podNetwork = JSON.parse(
    await kubectl(
      "exec",
      topology.harnessPod.metadata.name,
      "--namespace",
      topology.placement,
      "--container",
      "agent",
      "--",
      "node",
      "-e",
      [
        'const net = require("node:net");',
        "const tcp = (host) => new Promise((resolve) => {",
        "  const socket = net.connect({ host, port: 443, timeout: 5000 });",
        '  socket.once("connect", () => { socket.destroy(); resolve("connected"); });',
        '  socket.once("timeout", () => { socket.destroy(); resolve("timeout"); });',
        '  socket.once("error", (error) => resolve(error.code ?? "error"));',
        "});",
        "(async () => {",
        `  const address = await tcp(${JSON.stringify(publicAddress)});`,
        "  process.stdout.write(JSON.stringify({ address }));",
        "})();",
      ].join("\n"),
    ),
  );
  const tlsEvents = (await untrustedTls.events()).slice(tlsEventsBefore);
  const issuer = value("TLS_ISSUER");
  const [modelStatus, modelConnectStatus] = (value("MODEL_OUT") ?? "").split(",");
  // Classify what the foreign host received by the echo's placeholder flag and header length,
  // so a substituted model key is recognized without hashing or printing it. Only OpenShell's
  // own endpoint-mismatch refusal counts as refused: a transport failure or another error could
  // follow a forwarded credential, so it proves nothing and fails the check. curl prints 200 even
  // when the body then fails to arrive, so a 200 counts only with a clean exit, and an empty
  // header only when the echo reported length 0.
  const foreignReceived = (() => {
    const length = Number(value("FOREIGN_LENGTH"));
    const status = value("FOREIGN_OUT");
    if (status === "403" && value("FOREIGN_REFUSAL") === "credential_endpoint_mismatch") {
      return "refused";
    }
    if (status !== "200" || exitCode("FOREIGN") !== 0) {
      return `unverified-${status}`;
    }
    if (value("FOREIGN_PLACEHOLDER") === "true") {
      return "placeholder";
    }
    if (value("FOREIGN_LENGTH") === "0") {
      return "empty";
    }
    if (length === `Bearer ${modelCredential}`.length) {
      return "model-key-length";
    }
    return length === `Bearer ${toolA.token}`.length ? "tool-token-length" : "other";
  })();
  const observed = {
    modelPlaceholder: {
      inheritedByCommand: value("PLACEHOLDER_INHERITED") === "yes",
      readableFromHarness: value("PLACEHOLDER_FOUND") === "yes",
    },
    foreignDestination: {
      httpStatus: value("FOREIGN_OUT"),
      exitCode: exitCode("FOREIGN"),
      received: foreignReceived,
    },
    modelHostFromCurl: {
      httpStatus: modelStatus || null,
      connectStatus: modelConnectStatus || null,
      exitCode: exitCode("MODEL"),
    },
    proxyBypass: {
      allowedHostExitCode: exitCode("BYPASS_ALLOWED"),
      // Both null unless the first try could not resolve the host (exit 6).
      allowedHostFirstExitCode: exitCode("BYPASS_ALLOWED_FIRST"),
      allowedHostResolver: value("BYPASS_ALLOWED_RESOLVER"),
      deniedHostExitCode: exitCode("BYPASS_DENIED"),
      deniedHostFirstExitCode: exitCode("BYPASS_DENIED_FIRST"),
      deniedHostResolver: value("BYPASS_DENIED_RESOLVER"),
      addressExitCode: exitCode("BYPASS_ADDRESS"),
      sandboxDns: exitCode("DNS") === 0 ? "resolved" : "failed",
    },
    untrustedUpstream: {
      httpStatus: value("TLS_HTTP") || null,
      exitCode: exitCode("TLS"),
      harnessSawProxyIssuer: Boolean(issuer) && !issuer.includes(untrustedCaName),
      // Counted only for the tool source's host, so the failures belong to this request.
      tlsFailures: tlsEvents.filter(
        ({ event, servername }) => event === "tls-error" && servername === untrustedTls.host,
      ).length,
      handshakes: tlsEvents.filter(({ event }) => event === "tls-established").length,
      requests: tlsEvents.filter(({ event }) => event === "request").length,
    },
    podNetwork,
  };
  process.stderr.write(`OpenShell integration: credential route ${JSON.stringify(observed)}.\n`);
  // The model placeholder is bound only to the model endpoint. Sent anywhere else it must be refused,
  // dropped, or arrive as the placeholder; any other value means a credential was substituted.
  assert.ok(
    ["refused", "placeholder", "empty"].includes(observed.foreignDestination.received),
    "OpenShell must not substitute the model placeholder for a foreign destination.",
  );
  // OpenShell matches a profile's binaries against every ancestor of the calling process, so a
  // command Codex runs is admitted as Codex. A child that reads the Harness placeholder can
  // authenticate at the source's allowed endpoint; the foreign destination must remain refused.
  // TODO(tool isolation): once Agent tools run in their own Sandbox, outside Codex's process
  // tree, require this request to be refused and update the Credential Gateway reference.
  assert.equal(
    observed.modelPlaceholder.readableFromHarness,
    true,
    "a command must be able to read the Harness model placeholder for this check.",
  );
  assert.equal(
    observed.modelHostFromCurl.httpStatus,
    "200",
    "a command Codex runs must authenticate at the allowed source endpoint.",
  );
  // Skipping the proxy settings gains nothing: a denied host and a bare address stay unreachable.
  // The allowed host still answers, so the run has an outbound path and these failures are the
  // policy's, not a missing network.
  assert.equal(
    observed.proxyBypass.allowedHostExitCode,
    0,
    `a host the policy allows must stay reachable for the denied checks to mean anything: ${JSON.stringify(
      observed.proxyBypass,
    )}`,
  );
  // OpenShell refuses these connections, and curl reports that as exit 7 (could not connect).
  // Another failure, such as 6 (could not resolve host), may never have reached the policy, so it
  // proves nothing about it (findings 1981 and 1995). If OpenShell ever drops these connections
  // instead (curl exit 28) or refuses them during TLS setup (35), update this check deliberately.
  assert.equal(
    observed.proxyBypass.deniedHostExitCode,
    7,
    `the Sandbox must not reach a denied host by skipping its proxy: ${JSON.stringify(
      observed.proxyBypass,
    )}`,
  );
  assert.equal(
    observed.proxyBypass.addressExitCode,
    7,
    `the Sandbox must not reach a public address directly: ${JSON.stringify(observed.proxyBypass)}`,
  );
  // The provider-fenced Pod has no public egress of its own outside the Sandbox.
  assert.notEqual(podNetwork.address, "connected", "the Harness Pod must not reach the Internet.");
  // The Harness talks TLS to OpenShell's proxy, which verifies the upstream itself: an upstream
  // signed by an untrusted CA fails its handshake and never receives the request or the token.
  assert.equal(
    observed.untrustedUpstream.harnessSawProxyIssuer,
    true,
    "the Harness must see the Sandbox proxy's certificate, not the upstream's.",
  );
  assert.notEqual(
    observed.untrustedUpstream.httpStatus,
    "204",
    "a request to an untrusted upstream must not succeed.",
  );
  assert.ok(
    observed.untrustedUpstream.tlsFailures > 0,
    "OpenShell must attempt and refuse the untrusted upstream's handshake.",
  );
  assert.equal(observed.untrustedUpstream.handshakes, 0, "no upstream handshake may complete.");
  assert.equal(observed.untrustedUpstream.requests, 0, "no request may reach the upstream.");
}

const untrustedModelDnsFile = "oce-untrusted-model.server";
// The address the model host currently resolves to through the override, if any.
let modelDnsOverride;

/**
 * Points cluster DNS for the model host at `address`, or restores it when `address` is undefined,
 * and waits until cluster DNS answers accordingly. The Agent Gateway Pod uses cluster DNS
 * directly; the Harness Pod resolves only through the Sandbox's policy resolver. k3s CoreDNS
 * imports *.server files from the optional coredns-custom ConfigMap.
 */
async function setModelProviderDns(topology, address) {
  // Record the override before changing DNS, so a restore after a failed change still waits
  // for the address that change may have applied.
  const replaced = modelDnsOverride;
  modelDnsOverride = address ?? replaced;
  const directory = await mkdtemp(join(tmpdir(), "openshell-model-dns-"));
  try {
    if (address === undefined) {
      await kubectl(
        "delete",
        "configmap",
        "coredns-custom",
        "--namespace",
        "kube-system",
        "--ignore-not-found=true",
      );
    } else {
      const path = join(directory, "coredns-custom.json");
      await writeFile(
        path,
        JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "coredns-custom", namespace: "kube-system" },
          data: {
            // A short TTL keeps a cached override from outliving the check.
            [untrustedModelDnsFile]: [
              `${modelEndpoint.hostname}:53 {`,
              "    hosts {",
              `        ${address} ${modelEndpoint.hostname}`,
              "        ttl 5",
              "    }",
              "}",
              "",
            ].join("\n"),
          },
        }),
        { mode: 0o600 },
      );
      await kubectl("create", "-f", path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await kubectl("rollout", "restart", "deployment/coredns", "--namespace", "kube-system");
  await kubectl(
    "rollout",
    "status",
    "deployment/coredns",
    "--namespace",
    "kube-system",
    "--timeout=120s",
  );
  const lookup = [
    `require("node:dns").promises.lookup(${JSON.stringify(modelEndpoint.hostname)}, { family: 4 }).then(`,
    "  ({ address }) => process.stdout.write(address),",
    '  () => process.stdout.write(""));',
  ].join("\n");
  await waitFor(
    `${modelEndpoint.hostname} to resolve ${address === undefined ? "publicly" : `to ${address}`}`,
    async () => {
      const resolvers = (await resources("pods", "kube-system")).filter(
        (pod) =>
          pod.metadata.labels?.["k8s-app"] === "kube-dns" &&
          pod.metadata.deletionTimestamp === undefined,
      );
      if (resolvers.length !== 1) {
        return undefined;
      }
      const resolved = await kubectl(
        "exec",
        await currentGatewayPod(topology),
        "--namespace",
        topology.gatewayPlacement,
        "--",
        "node",
        "-e",
        lookup,
      ).catch(() => "");
      if (address === undefined) {
        return resolved !== "" && resolved !== replaced ? true : undefined;
      }
      return resolved === address ? true : undefined;
    },
    180_000,
  );
  modelDnsOverride = address;
}

/**
 * Serves the model host from an upstream signed by a CA nothing trusts. The model profile allows
 * the provider's exact host even at a cluster address, so OpenShell connects, and must refuse
 * the certificate before Codex's request, and the key OpenShell would insert, leaves the proxy.
 * It runs on a freshly replaced Harness, which holds no connection to the real provider.
 */
async function assertModelRouteRefusesUntrustedUpstream(topology) {
  // Cluster DNS cannot redirect an endpoint selected by address; report the gap instead.
  if (isIP(modelEndpoint.hostname) !== 0) {
    process.stderr.write(
      "OpenShell integration: untrusted model upstream not tested; the model endpoint is an address.\n",
    );
    return;
  }
  const { request, namespaceId, untrustedTls } = topology;
  const agentId = topology.agent.id;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const harnessPod = await waitForProviderHarnessPod(topology.placement, {
    id: current.data.activeRevisionId,
    agentId,
  });
  assert.equal(
    await fixture.maybeResource("configmap", "coredns-custom", "kube-system"),
    undefined,
    "the disposable cluster must not carry a CoreDNS override before this check.",
  );
  const eventsBefore = (await untrustedTls.events()).length;
  let rejected = false;
  let observation;
  let rejection;
  let gatewayPod;
  let failure;
  try {
    await setModelProviderDns(topology, untrustedTls.address);
    const nonce = `OCC-OPENSHELL-UNTRUSTED-${randomUUID()}`;
    try {
      gatewayPod = await currentGatewayPod(topology);
      observation = JSON.stringify(
        await requestCodexTurnFromGatewayPod({
          namespace: topology.gatewayPlacement,
          gatewayPod,
          providerModel,
          prompt: `Reply with exactly ${nonce}.`,
        }),
      );
    } catch (error) {
      rejected = true;
      observation = error instanceof Error ? error.message : String(error);
      // The kubectl error message starts with the whole probe script; its stderr says why.
      if (typeof error?.stderr === "string") {
        rejection = error.stderr.trim() || "kubectl returned no stderr; probe command omitted.";
      }
    }
  } catch (error) {
    failure = error;
  }
  // Restore DNS before any assertion; keep the first error if both steps fail.
  try {
    await setModelProviderDns(topology, undefined);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
  const events = (await untrustedTls.events()).slice(eventsBefore);
  const observed = {
    turnRejected: rejected,
    // Counted only for the model host, so the failures belong to the model route.
    tlsFailures: events.filter(
      ({ event, servername }) => event === "tls-error" && servername === modelEndpoint.hostname,
    ).length,
    handshakes: events.filter(({ event }) => event === "tls-established").length,
    requests: events.filter(({ event }) => event === "request").length,
  };
  process.stderr.write(
    `OpenShell integration: untrusted model upstream ${JSON.stringify(observed)}.\n`,
  );
  assert.equal(
    String(observation).includes(modelCredential),
    false,
    "a refused model route must not expose the model key",
  );
  assert.equal(rejected, true, "a model turn must not complete through an untrusted upstream.");
  const refused = observed.tlsFailures > 0 && observed.handshakes === 0 && observed.requests === 0;
  const detail = refused
    ? ""
    : await untrustedUpstreamFailureDetail(topology, {
        harnessPod,
        gatewayPod,
        observed,
        text: rejection ?? observation,
      });
  assert.ok(
    observed.tlsFailures > 0,
    `OpenShell must attempt and refuse the upstream handshake.${detail}`,
  );
  assert.equal(observed.handshakes, 0, `no upstream handshake may complete.${detail}`);
  assert.equal(observed.requests, 0, `no model request, or key, may reach the upstream.${detail}`);
}

// Finding 1507: a turn refused with no upstream event failed before OpenShell tried the
// untrusted upstream (the DNS override unseen, or the Gateway failing first as in 1496).
// The turn's text is redacted before it is cut, and stays small enough that the Gateway,
// Harness and supervisor sections still fit the 16 KiB failure message.
const untrustedTurnObservationChars = 1_000;

// A failure diagnostic redacts the Gateway password when it can read it, and runs without it.
async function diagnosticGatewayPassword(topology) {
  const passwordSecret = await diagnosticResource(
    "secret",
    `gateway-password-${hash(topology.agent.id)}`,
    topology.gatewayPlacement,
  ).catch(() => undefined);
  const encodedPassword = passwordSecret?.data?.["gateway-password"];
  return encodedPassword === undefined
    ? undefined
    : Buffer.from(encodedPassword, "base64").toString();
}

async function untrustedUpstreamFailureDetail(
  topology,
  { harnessPod, gatewayPod, observed, text },
) {
  const gatewayPassword = await diagnosticGatewayPassword(topology);
  const secrets = turnFailureSecrets(topology, gatewayPassword);
  const shown = redactLogLine(String(text), secrets, untrustedTurnObservationChars);
  const detail = `\nTurn observation: ${shown}`;
  if (observed.tlsFailures !== 0 || observed.handshakes !== 0 || observed.requests !== 0) {
    return detail;
  }
  if (gatewayPod === undefined) {
    // The turn never ran: finding no running Gateway Pod counted as the refusal.
    return `${detail}\nNo running Agent Gateway Pod was found for the turn.`;
  }
  // The diagnostic reads the replacement's Harness and the Gateway Pod that ran the turn.
  const diagnostic = await gatewayTurnFailureDiagnostic(
    { ...topology, harnessPod, gatewayPod: { metadata: { name: gatewayPod } } },
    gatewayPassword,
  );
  return `${detail}${diagnostic}`;
}

// Finding 1532: the replacement never became active and the worker diagnostic alone could not
// say why. The message carries the persisted revision and queue state with the collapsed
// worker events, which Harness and Gateway Pods the replacement has, and the turn diagnostic's
// Gateway, Harness and supervisor sections for them. Budgets keep it under 16 KiB. The clip
// keeps the start, so the events there run newest first.
const replacementWorkerChars = 2_500;
const replacementPodsChars = 600;

async function replacementActivationDiagnostic(topology, revision, worker) {
  const gatewayPassword = await diagnosticGatewayPassword(topology);
  const secrets = turnFailureSecrets(topology, gatewayPassword);
  const sections = [
    `Worker: ${redactLogLine(
      JSON.stringify({ ...worker, events: [...(worker?.events ?? [])].reverse() }),
      secrets,
      replacementWorkerChars,
    )}`,
  ];
  // Prefer the newest Pod that is not terminating; a rolling Gateway may have only that one.
  const newest = (pods) => {
    const byAge = [...pods].sort((a, b) =>
      String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)),
    );
    return byAge.find(({ metadata }) => metadata.deletionTimestamp === undefined) ?? byAge[0];
  };
  const describe = (pod) => ({
    name: pod.metadata.name,
    phase: pod.status?.phase,
    deleting: pod.metadata.deletionTimestamp !== undefined,
    ready: pod.status?.conditions?.find(({ type }) => type === "Ready")?.status,
  });
  let harnessPod;
  let gatewayPod;
  try {
    const agentPods = (await diagnosticResources("pods", topology.placement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === revision.agentId &&
        pod.metadata.labels?.["openclaw.dev/revision"] === revision.id,
    );
    const gatewayPods = (await diagnosticResources("pods", topology.gatewayPlacement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === revision.agentId,
    );
    harnessPod = newest(agentPods);
    gatewayPod = newest(gatewayPods);
    sections.push(
      `Replacement Pods: ${redactLogLine(
        JSON.stringify({
          harness: agentPods.map(describe),
          gateway: gatewayPods.map(describe),
        }),
        secrets,
        replacementPodsChars,
      )}`,
    );
  } catch (error) {
    sections.push(
      `Replacement Pods unavailable: ${redactLogLine(
        error?.message ?? String(error),
        secrets,
        turnDiagnosticErrorChars,
      )}`,
    );
  }
  if (gatewayPod === undefined) {
    sections.push("No Agent Gateway Pod was found for the replacement.");
    return `\n${sections.join("\n")}`;
  }
  const diagnostic = await gatewayTurnFailureDiagnostic(
    { ...topology, harnessPod, gatewayPod },
    gatewayPassword,
    { gateway: 4_000, harness: 3_000, supervisor: 4_000 },
  );
  return `\n${sections.join("\n")}${diagnostic}`;
}

/**
 * Makes the model provider unreachable: cluster DNS sends the model host to a Service with no
 * endpoints, so OpenShell's connection to it is refused. The turn must fail without exposing
 * the key, and the same running Harness must complete a turn once the provider is back.
 */
async function assertModelProviderOutageFailsClosed(topology) {
  if (isIP(modelEndpoint.hostname) !== 0) {
    process.stderr.write(
      "OpenShell integration: model provider outage not tested; the model endpoint is an address.\n",
    );
    return;
  }
  const { request, namespaceId, untrustedTls } = topology;
  const agentPath = `/namespaces/${namespaceId}/agents/${topology.agent.id}`;
  const current = await request("GET", agentPath);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revisionId = current.data.activeRevisionId;
  // `kubectl create service clusterip` selects app=<name>, which no Pod carries.
  await kubectl(
    "create",
    "service",
    "clusterip",
    "model-outage",
    "--namespace",
    untrustedTls.namespace,
    ...[...new Set([443, modelPort])].map((port) => `--tcp=${port}:${port}`),
  );
  const outage = await resource("service", "model-outage", untrustedTls.namespace);
  let rejected = false;
  let observation;
  let failure;
  try {
    await setModelProviderDns(topology, outage.spec.clusterIP);
    try {
      observation = JSON.stringify(
        await requestCodexTurnFromGatewayPod({
          namespace: topology.gatewayPlacement,
          gatewayPod: await currentGatewayPod(topology),
          providerModel,
          prompt: `Reply with exactly OCC-OPENSHELL-OUTAGE-${randomUUID()}.`,
        }),
      );
    } catch (error) {
      rejected = true;
      observation = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    failure = error;
  }
  // Restore DNS before any assertion; keep the first error if both steps fail.
  try {
    await setModelProviderDns(topology, undefined);
    await kubectl(
      "delete",
      "service",
      "model-outage",
      "--namespace",
      untrustedTls.namespace,
      "--ignore-not-found",
    );
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
  const nonce = `OCC-OPENSHELL-RECOVERED-${randomUUID()}`;
  const recovered = await requestCodexTurnFromGatewayPod({
    namespace: topology.gatewayPlacement,
    gatewayPod: await currentGatewayPod(topology),
    providerModel,
    prompt: `Reply with exactly ${nonce}.`,
  });
  const after = await request("GET", agentPath);
  const observed = {
    turnRejected: rejected,
    recoveredTurn: new RegExp(nonce).test(recovered.assistant),
    sameRevision: after.data.activeRevisionId === revisionId,
  };
  process.stderr.write(
    `OpenShell integration: model provider outage ${JSON.stringify(observed)}.\n`,
  );
  assert.equal(
    String(observation).includes(modelCredential),
    false,
    "a failed model turn must not expose the model key",
  );
  assert.equal(JSON.stringify(recovered).includes(modelCredential), false);
  assert.equal(rejected, true, "a model turn must fail while the provider is unreachable.");
  // The outage is the provider's, not the Harness's: the same revision serves the next turn.
  assert.equal(observed.recoveredTurn, true, "the running Harness must recover with the provider.");
  assert.equal(observed.sameRevision, true, "recovery must not need a redeploy.");
}

/**
 * Takes a tool source's upstream away: its Service selects no Pod, so OpenShell's connection is
 * refused or stalls. The echo must see no request during the outage, then see the recovered
 * request with the substituted token from the same running Harness.
 */
async function assertToolUpstreamOutageFailsClosed(topology) {
  const { request, namespaceId, toolSources, tokenEcho } = topology;
  const [toolA] = toolSources;
  const agentId = topology.agent.id;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const harnessPod = await waitForProviderHarnessPod(topology.placement, {
    id: current.data.activeRevisionId,
    agentId,
  });
  const probe = async (label) => {
    const nonce = `openshell-tool-${label}-${randomUUID()}`;
    const body = `/tmp/${nonce}.json`;
    const script = [
      "#!/bin/bash",
      ...sandboxProbeFunction,
      `probe TOOL curl -sS -o ${body} -w '%{http_code} %{time_total}' --connect-timeout 3 ` +
        `--max-time ${toolProbeCurlMaxSeconds} -H "Authorization: Bearer $${toolA.environmentName}" ${toolA.url}`,
      `printf 'TOOL_PLACEHOLDER=%s\\n' "$(grep -o '"placeholder":[a-z]*' ${body} ` +
        `2>/dev/null | cut -d: -f2)"`,
      `printf 'TOOL_DIGEST=%s\\n' "$(grep -o '"digest":"[0-9a-f]*"' ${body} ` +
        `2>/dev/null | cut -d'"' -f4)"`,
      "",
    ].join("\n");
    const { run, value, exitCode } = await runSandboxProbe(topology, nonce, script, harnessPod);
    const [httpStatus = null, curlSeconds = null] = (value("TOOL_OUT") ?? "").split(" ");
    // The echo answers 200 even without an Authorization header, so delivery is proved by the
    // digest of what it received, compared here and never printed.
    return {
      httpStatus: httpStatus || null,
      exitCode: exitCode("TOOL"),
      curlSeconds: curlSeconds === null ? null : Number(curlSeconds),
      commandMs: Number.isSafeInteger(run.durationMs) ? run.durationMs : null,
      placeholder: value("TOOL_PLACEHOLDER") || null,
      responseMatchedToken: value("TOOL_DIGEST") === toolA.digest,
    };
  };
  const selectPods = (app) =>
    kubectl(
      "patch",
      "service",
      "token-echo",
      "--namespace",
      tokenEcho.namespace,
      "--type=merge",
      "--patch",
      JSON.stringify({ spec: { selector: { app } } }),
    );
  const waitForEndpoints = (ready) =>
    waitFor(`token-echo endpoints ${ready ? "ready" : "removed"}`, async () => {
      const slices = (await resources("endpointslices", tokenEcho.namespace)).filter(
        (slice) => slice.metadata.labels?.["kubernetes.io/service-name"] === "token-echo",
      );
      const serving = slices.some((slice) =>
        (slice.endpoints ?? []).some((endpoint) => endpoint.conditions?.ready === true),
      );
      return serving === ready ? true : undefined;
    });
  const receiptBefore = await tokenEcho.readToolAReceipt();
  let outage;
  let receiptWhileDown;
  let failure;
  try {
    await selectPods("token-echo-outage");
    await waitForEndpoints(false);
    outage = await probe("outage");
    receiptWhileDown = await tokenEcho.readToolAReceipt();
    // Print it now: if the recovery fails, this is the only record of the outage probe.
    process.stderr.write(`OpenShell integration: tool upstream down ${JSON.stringify(outage)}.\n`);
  } catch (error) {
    failure = error;
  }
  // Restore the upstream even if the probe or receipt read failed; keep the first error.
  try {
    await selectPods("token-echo");
    await waitForEndpoints(true);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
  const recovered = await probe("recovered");
  const receiptAfter = await tokenEcho.readToolAReceipt();
  const observed = { outage, recovered };
  process.stderr.write(
    `OpenShell integration: tool upstream outage ${JSON.stringify(observed)}.\n`,
  );
  // OpenShell usually closes the client connection without a response when it cannot reach
  // the upstream (curl exit 52). If it holds the connection instead, curl gives up at its own
  // --max-time bound (exit 28). A timeout well before that bound, such as the 3 s connect
  // timeout to the proxy itself, is not an upstream outage. Any other result, a response
  // included, means the outage was not observed.
  assert.equal(outage.httpStatus, "000", "a request to an unreachable upstream gets no response.");
  const held = outage.exitCode === 28 && outage.curlSeconds >= toolProbeCurlMaxSeconds - 0.5;
  assert.ok(
    outage.exitCode === 52 || held,
    "OpenShell must end or hold a request to an unreachable upstream, not answer it " +
      `(curl exit ${outage.exitCode} after ${outage.curlSeconds} s).`,
  );
  // Curl reports the response, not whether the request arrived. Compare the receiver's count
  // before restoration, then require the same process to count exactly one request by recovery.
  assert.deepEqual(
    receiptWhileDown,
    receiptBefore,
    "the echo must see no request during the outage",
  );
  assert.equal(outage.responseMatchedToken, false);
  if (held) {
    process.stderr.write(
      "OpenShell integration: OpenShell held the request to the unreachable upstream until " +
        "curl's bound instead of closing it.\n",
    );
  }
  // Once the upstream is back, the same running Harness gets tool A's own token again.
  assert.deepEqual(
    { httpStatus: recovered.httpStatus, exitCode: recovered.exitCode },
    { httpStatus: "200", exitCode: 0 },
  );
  assert.equal(recovered.placeholder, "false", "the upstream must not receive the placeholder.");
  assert.equal(recovered.responseMatchedToken, true, "the upstream must receive tool A's token.");
  assert.deepEqual(receiptAfter, { ...receiptBefore, requests: receiptBefore.requests + 1 });
}

/**
 * Stops the Namespace's OpenShell gateway and restarts it. While it is down, the running Agent
 * cannot serve a turn, because the Agent Gateway reaches Codex through OpenShell's service
 * exposure. OCC must not report a usable source, register a source, or activate a revision.
 * Once the gateway is back, the held deployment must activate and serve a turn.
 */
async function assertOpenShellGatewayOutage(topology) {
  const { request, namespaceId, placement, observerPool, tokenEcho } = topology;
  const agentPath = `/namespaces/${namespaceId}/agents/${topology.agent.id}`;
  const sourcePath = `/namespaces/${namespaceId}/credential-sources/${topology.agent.harnessAuth.sourceId}`;
  const before = await request("GET", agentPath);
  assert.equal(before.status, 200, JSON.stringify(before.error));
  const activeRevisionId = before.data.activeRevisionId;
  const statefulSets = (await resources("statefulsets", placement)).filter(
    (statefulSet) => statefulSet.metadata.labels?.["app.kubernetes.io/name"] === "openshell",
  );
  assert.equal(statefulSets.length, 1, "the Namespace must run one OpenShell gateway.");
  const [statefulSet] = statefulSets;
  const gatewayPods = async () =>
    (await resources("pods", placement)).filter(
      (pod) =>
        pod.metadata.labels?.["app.kubernetes.io/name"] === "openshell" &&
        pod.metadata.labels?.["app.kubernetes.io/instance"] ===
          statefulSet.metadata.labels?.["app.kubernetes.io/instance"],
    );
  const scale = (replicas) =>
    kubectl(
      "scale",
      "statefulset",
      statefulSet.metadata.name,
      "--namespace",
      placement,
      `--replicas=${replicas}`,
    );
  const registrationName = `openshell-outage-${randomUUID()}`;
  const observed = {};
  let outageSecretId;
  let redeployed;
  let failure;
  const refreshSources = [
    ...(topology.refreshSources?.bound ?? []),
    ...(topology.refreshSources === undefined ? [] : [topology.refreshSources.unbound]),
  ];
  const refreshPath = (refreshSource) =>
    `/namespaces/${namespaceId}/credential-sources/${refreshSource.id}`;
  // When each OAuth2 source is next due, by the gateway's own clock, before it stops. Compared
  // with the restarted container's start, it shows whether the first startup sweep had work.
  const dueBeforeOutage = new Map();
  for (const refreshSource of refreshSources) {
    const read = await request("GET", refreshPath(refreshSource));
    dueBeforeOutage.set(refreshSource.id, read.data?.status?.refresh?.nextRefreshAt);
  }
  let gatewayRestartedAt;
  // The controller reaches this gateway through a kubectl port-forward. Once the Pod is gone,
  // kubectl still accepts one connection, closes it before the HTTP/2 handshake and only then
  // exits, so for about a second gRPC reports "Failed to connect", which the client's
  // unanswered-request allowlist (finding 2042) does not count as an outage, so a pass then spends
  // an attempt (finding 2104). A Service with no ready endpoints refuses connections; closing the
  // forward first makes this endpoint do the same.
  await topology.closeGatewayForward();
  await scale(0);
  try {
    await waitFor(
      "the OpenShell gateway Pod to stop",
      async () => ((await gatewayPods()).length === 0 ? true : undefined),
      180_000,
    );
    let downTurn;
    try {
      downTurn = await requestCodexTurnFromGatewayPod({
        namespace: topology.gatewayPlacement,
        gatewayPod: await currentGatewayPod(topology),
        providerModel,
        prompt: `Reply with exactly OCC-OPENSHELL-GATEWAY-DOWN-${randomUUID()}.`,
      });
    } catch (error) {
      assert.equal(String(error?.message).includes(modelCredential), false);
    }
    observed.runningAgentTurn = downTurn === undefined ? "failed" : "completed";
    // Checked outside the try, so a turn that completed and leaked the key cannot read as failed.
    assert.equal(JSON.stringify(downTurn ?? {}).includes(modelCredential), false);
    const source = await request("GET", sourcePath);
    observed.sourceRead = {
      httpStatus: source.status,
      state: source.data?.status?.state ?? null,
    };
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: `openshell-outage-token-${randomUUID()}`,
      value: `oce-outage-${randomUUID()}`,
    });
    assert.equal(secret.status, 201, JSON.stringify(secret.error));
    outageSecretId = secret.data.id;
    const registered = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
      name: registrationName,
      type: "bearer-token",
      config: {
        host: tokenEcho.host,
        port: String(tokenEcho.port),
        path: "/echo-outage",
        env_var: "TOOL_OUTAGE_TOKEN",
      },
      secrets: { token: secret.data.ref },
    });
    observed.registration = {
      httpStatus: registered.status,
      code: registered.error?.code ?? null,
    };
    redeployed = await request("POST", `${agentPath}/deploy`);
    assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
    // A claim marks the work `claimed` and counts an attempt; a pass that waits on the gateway
    // returns it to `queued` and gives the attempt back (finding 2040). Waiting for that while the
    // gateway is still at zero replicas proves the worker tried the revision against the stopped
    // gateway, did not activate it, and spent none of its attempt budget.
    // Recorded as they are read, so a timed-out wait still shows what the poll saw.
    const deploymentStatuses = [];
    observed.redeployDuringOutage = { deploymentStatuses };
    const { work, status } = await waitFor(
      `deployment ${redeployed.data.id} to fail an attempt while the gateway is down`,
      outageAttemptRead({
        readWork: async () =>
          (
            await observerPool.query(
              `SELECT work.state, work.reason_code, work.attempt_count, (
                 SELECT attempt.details->>'reasonCode' FROM occ.audit_events attempt
                 WHERE attempt.kind = 'mutation' AND attempt.action = 'reconcile'
                   AND attempt.resource_kind = 'agent_revision'
                   AND attempt.details->>'workId' = work.idempotency_key
                 ORDER BY attempt.occurred_at DESC, attempt.id DESC LIMIT 1
               ) AS last_attempt_code
               FROM occ.controller_work work WHERE work.idempotency_key = $1`,
              [`agent_revision:${redeployed.data.id}:reconcile`],
            )
          ).rows[0],
        readStatus: async () => {
          const deployment = await request("GET", `${agentPath}/deployments/${redeployed.data.id}`);
          const read = deployment.data?.status ?? null;
          if (deploymentStatuses.at(-1) !== read) {
            deploymentStatuses.push(read);
          }
          return read;
        },
      }),
      180_000,
    );
    const during = await request("GET", agentPath);
    observed.redeployDuringOutage = {
      status,
      deploymentStatuses,
      work,
      activeRevisionUnchanged: during.data?.activeRevisionId === activeRevisionId,
      gatewayStopped: (await gatewayPods()).length === 0,
    };
    if (work.attempt_count !== 0) {
      // Names the failure class of the pass that spent the attempt (finding 2104).
      await topology.diagnoseRevision(redeployed.data.id);
    }
  } catch (error) {
    failure = error;
  }
  // Restart the gateway before any assertion; keep the first error if both steps fail.
  try {
    await scale(1);
    await waitForOpenShellGateway(placement);
    gatewayRestartedAt = (await gatewayPods())[0]?.status?.containerStatuses?.[0]?.state?.running
      ?.startedAt;
    await topology.restartGatewayForward();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    process.stderr.write(
      `OpenShell integration: gateway outage observed before failure ${JSON.stringify(observed)}.\n`,
    );
    throw failure;
  }
  let activated = false;
  try {
    await waitFor(
      `deployment ${redeployed.data.id} to activate after the gateway outage`,
      async () => {
        const agent = await request("GET", agentPath);
        if (agent.data?.activeRevisionId === redeployed.data.id) {
          return true;
        }
        const status = await request("GET", `${agentPath}/deployments/${redeployed.data.id}`);
        return status.data?.status === "failed" ? true : undefined;
      },
      360_000,
    );
    activated = (await request("GET", agentPath)).data?.activeRevisionId === redeployed.data.id;
  } catch (error) {
    failure = error;
  }
  // Finding 2017: a held deployment that ends failed (RUNTIME_LOGIN_FAILED) says why.
  const recoveryDiagnostic = activated
    ? ""
    : await failedRecoveryDiagnostic({
        readWorker: () => topology.diagnoseRevision(redeployed.data.id),
        describe: (worker) => replacementActivationDiagnostic(topology, redeployed.data, worker),
        failure,
      });
  const work = await observerPool.query(
    "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
    [`agent_revision:${redeployed.data.id}:reconcile`],
  );
  const source = await request("GET", sourcePath);
  const listed = await request("GET", `/namespaces/${namespaceId}/credential-sources`);
  observed.recovery = {
    redeployActivated: activated,
    work: work.rows[0] ?? null,
    sourceState: source.data?.status?.state ?? null,
    registrationRecord:
      listed.data?.find(({ name }) => name === registrationName)?.state ?? "absent",
  };
  if (activated) {
    const nonce = `OCC-OPENSHELL-GATEWAY-BACK-${randomUUID()}`;
    await waitForProviderHarnessPod(placement, {
      id: redeployed.data.id,
      agentId: topology.agent.id,
    });
    const turn = await requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: await currentGatewayPod(topology),
      providerModel,
      prompt: `Reply with exactly ${nonce}.`,
    });
    assert.equal(JSON.stringify(turn).includes(modelCredential), false);
    observed.recovery.turn = new RegExp(nonce).test(turn.assistant);
  }
  // The gateway mints OAuth2 tokens itself, and its first refresh sweep runs at startup. Since
  // NVIDIA/OpenShell#4527 that sweep waits for the operator namespace listing and reports a
  // missing listing as retryable, so each source must mint again on its own, without a
  // rotation. A `refresh_configuration_invalid` failure means the startup race of #4526 is back.
  // OpenShell persists refresh status, so a `ready` read alone can describe a mint from before
  // the restart. The first post-restart `lastRefreshAt` is the baseline; only a `ready` read
  // with a strictly later one, both from the gateway's clock, proves a fresh mint. These
  // sources re-mint about every minute (Keycloak's 360 s tokens, OCC's 300 s refresh_before),
  // and a retryable failure is retried after 60 seconds, so all three share one deadline.
  observed.recovery.refresh = await Promise.all(
    refreshSources.map(async (refreshSource) => {
      const states = [];
      const dueBefore = dueBeforeOutage.get(refreshSource.id);
      let baseline;
      let fresh = false;
      try {
        await waitFor(
          `${refreshSource.type} to mint a fresh token after the gateway restart`,
          async () => {
            const read = await request("GET", refreshPath(refreshSource));
            const refresh = read.data?.status?.refresh;
            if (refresh === undefined || refresh.state === "pending") {
              return undefined;
            }
            const state = `${refresh.state}:${refresh.failureCode ?? "-"}`;
            if (states.at(-1) !== state) {
              states.push(state);
            }
            if (refresh.failureCode === "refresh_configuration_invalid") {
              return true;
            }
            if (refresh.lastRefreshAt === undefined) {
              return undefined;
            }
            baseline ??= refresh.lastRefreshAt;
            fresh =
              refresh.state === "ready" &&
              refresh.failureCode === undefined &&
              Date.parse(refresh.lastRefreshAt) > Date.parse(baseline);
            return fresh ? true : undefined;
          },
          300_000,
        );
      } catch (error) {
        failure ??= error;
      }
      return {
        type: refreshSource.type,
        states,
        fresh,
        dueAtRestart:
          dueBefore === undefined || gatewayRestartedAt === undefined
            ? null
            : Date.parse(dueBefore) <= Date.parse(gatewayRestartedAt),
      };
    }),
  );
  // A registration whose gateway call failed may stay listed as `deleting`; deleting it again
  // removes it once the gateway answers and the creation fence has passed.
  const leftover = listed.data?.find(({ name }) => name === registrationName);
  if (leftover !== undefined) {
    await waitFor(
      `outage registration ${leftover.id} deletion`,
      async () => {
        const deleted = await request(
          "DELETE",
          `/namespaces/${namespaceId}/credential-sources/${leftover.id}`,
        );
        return [204, 404].includes(deleted.status) ? true : undefined;
      },
      180_000,
    );
  }
  process.stderr.write(`OpenShell integration: gateway outage ${JSON.stringify(observed)}.\n`);
  if (failure !== undefined) {
    throw failure;
  }
  // While the gateway is down the source cannot be confirmed, and nothing new is admitted.
  assert.equal(observed.runningAgentTurn, "failed");
  assert.deepEqual(observed.sourceRead, { httpStatus: 200, state: "failed" });
  assert.deepEqual(observed.registration, { httpStatus: 503, code: "DEPENDENCY_UNAVAILABLE" });
  assert.equal(observed.redeployDuringOutage.gatewayStopped, true);
  // A started deploy reads as running between passes (finding 2456).
  assert.equal(observed.redeployDuringOutage.status, "running");
  // The outage spends no attempt: the pass waits on the gateway (finding 2040).
  assert.equal(
    observed.redeployDuringOutage.work.last_attempt_code,
    "SANDBOX_GATEWAY_UNAVAILABLE",
    JSON.stringify(observed.redeployDuringOutage),
  );
  assert.equal(observed.redeployDuringOutage.work.attempt_count, 0);
  assert.equal(observed.redeployDuringOutage.activeRevisionUnchanged, true);
  // Once the gateway is back, the held deployment proceeds without operator action.
  assert.equal(
    observed.recovery.redeployActivated,
    true,
    `${JSON.stringify(observed.recovery)}${recoveryDiagnostic}`,
  );
  assert.equal(observed.recovery.sourceState, "ready");
  assert.equal(observed.recovery.turn, true, "the new revision must serve a model turn.");
  for (const { type, states, fresh } of observed.recovery.refresh) {
    assert.equal(states.at(-1), "ready:-", `${type} refresh after the gateway restart`);
    assert.equal(fresh, true, `${type} must mint a token after the gateway restart`);
  }
  // Once the outage registration is gone, its Secret is unbound and can be deleted.
  if (outageSecretId !== undefined) {
    await waitFor(
      `outage Secret ${outageSecretId} deletion`,
      async () => {
        const removed = await request(
          "DELETE",
          `/namespaces/${namespaceId}/secrets/${outageSecretId}`,
        );
        return [204, 404].includes(removed.status) ? true : undefined;
      },
      120_000,
    );
  }
}

async function assertDuplicateReconciliationDoesNotDuplicateOpenShell(topology) {
  // Suspending the upstream Sandbox removes its Pod while retaining the provider resource.
  // Replacement must still discover and retire that Sandbox without relying on Pod observation.
  await kubectl(
    "patch",
    "sandbox",
    topology.sandbox.metadata.name,
    "--namespace",
    topology.placement,
    "--type=merge",
    "--patch",
    JSON.stringify({ spec: { operatingMode: "Suspended" } }),
  );
  await waitFor(
    `suspended OpenShell Pod ${topology.harnessPod.metadata.name} deletion`,
    async () =>
      (await fixture.maybeResource(
        "pod",
        topology.harnessPod.metadata.name,
        topology.placement,
      )) === undefined
        ? true
        : undefined,
  );
  const suspendedSandbox = await resource(
    "sandbox",
    topology.sandbox.metadata.name,
    topology.placement,
  );
  assert.equal(suspendedSandbox.spec.operatingMode, "Suspended");

  const redeployed = await topology.request(
    "POST",
    `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
  assert.notEqual(redeployed.data.id, topology.revision.id);
  const agentPath = `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`;
  const deploymentPath = `${agentPath}/deployments/${redeployed.data.id}`;
  try {
    await waitFor(`replacement OpenShell revision ${redeployed.data.id} activation`, async () => {
      const observed = await topology.request("GET", agentPath);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      if (observed.data.activeRevisionId === redeployed.data.id) {
        return observed.data;
      }
      // Finding 1532: a Harness holding a failed startup model probe fails the deployment for
      // good on its first attempt. Stop then: the error names the probe's classified cause, and
      // the diagnostic is captured near the failure, not after 240 s of Gateway reconnect noise.
      const deployment = await topology.request("GET", deploymentPath);
      // A temporary failure to read that diagnostic is not a failed replacement. Keep the
      // original activation deadline; only the Agent naming this revision can satisfy the wait.
      const { status } = deployment;
      if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
        return undefined;
      }
      assert.equal(status, 200, JSON.stringify(deployment.error));
      assert.notEqual(
        deployment.data.status,
        "failed",
        `Replacement OpenShell revision ${redeployed.data.id} failed: ${JSON.stringify(deployment.data)}`,
      );
      return undefined;
    });
  } catch (error) {
    const worker = await topology.diagnoseRevision(redeployed.data.id);
    // A diagnostic that fails or stalls itself must not replace the timeout it explains.
    const detail = await withinDiagnosticDeadline(
      () =>
        replacementActivationDiagnostic(topology, redeployed.data, worker).catch(
          (diagnosticError) =>
            `\nReplacement diagnostic unavailable: ${diagnosticError?.name ?? "Error"}`,
        ),
      { timedOut: `\nReplacement diagnostic timed out after ${diagnosticDeadlineMs / 1_000} s` },
    );
    // Keep the timeout's own stack, which names this wait, and add the evidence to its message.
    if (error instanceof Error) {
      error.message = `${error.message}${detail}`;
      throw error;
    }
    assert.fail(`${String(error)}${detail}`);
  }
  // Activation already required the replacement's workspace node to reconnect. Dedicated Codex
  // enrolls that node through OpenShell provider files, so the Pod carries no node-state mount.
  await waitForProviderHarnessPod(topology.placement, redeployed.data);
  const activeSandboxName = `os-${hash(redeployed.data.id, 16)}`;
  const retiredSandboxName = `os-${hash(topology.revision.id, 16)}`;
  // The revision becomes active before the worker finishes retiring its predecessor. Observe the
  // provider resources themselves so the assertion stays at the supported lifecycle boundary.
  // OpenShell owns the Codex endpoint, so the stable Agent Service stays parked on a selector that
  // matches no Pod while tracking the replacement revision.
  const expectedActiveSelector = {
    "app.kubernetes.io/name": `${openShellAgentName(topology.agent.id)}-inactive`,
    "openclaw.dev/agent": topology.agent.id,
    "openclaw.dev/namespace": topology.namespaceId,
    "openclaw.dev/network-profile": "provider-fenced-v1",
    "openclaw.dev/revision": redeployed.data.id,
    "openclaw.dev/workload-role": "agent",
  };
  // The API can publish the new active revision before Kubernetes reconciliation updates the
  // stable Agent Service. Wait at the routing boundary instead of sampling the old selector.
  const activeService = await waitFor(
    `OpenShell Agent Service routing to replacement revision ${redeployed.data.id}`,
    async () => {
      const observed = await resource(
        "service",
        openShellAgentName(topology.agent.id),
        topology.placement,
      );
      return Object.keys(observed.spec.selector ?? {}).length ===
        Object.keys(expectedActiveSelector).length &&
        Object.entries(expectedActiveSelector).every(
          ([name, value]) => observed.spec.selector?.[name] === value,
        )
        ? observed
        : undefined;
    },
  );
  assert.deepEqual(activeService.spec.selector, expectedActiveSelector);
  const sandboxes = await waitFor(
    `retired OpenShell Sandbox ${retiredSandboxName} deletion`,
    async () => {
      const observed = await fixture.customResources(
        "sandboxes.agents.x-k8s.io",
        topology.placement,
      );
      return observed.some(
        ({ metadata }) => metadata.labels?.["openshell.ai/sandbox-name"] === retiredSandboxName,
      )
        ? undefined
        : observed;
    },
  );
  const activeSandboxes = sandboxes.filter(
    ({ metadata }) => metadata.labels?.["openshell.ai/sandbox-name"] === activeSandboxName,
  );
  assert.equal(
    activeSandboxes.length,
    1,
    "retiring a replaced provider-owned workload must delete the old Sandbox exactly once.",
  );
  assert.equal(
    sandboxes.some(
      ({ metadata }) => metadata.labels?.["openshell.ai/sandbox-name"] === retiredSandboxName,
    ),
    false,
    "retiring the replaced revision must remove its exact provider-owned Sandbox.",
  );
  const openShellGatewayInstance = `openshell-${hash(topology.placement, 10)}`;
  const gatewayPods = (await resources("pods", topology.placement)).filter(
    (pod) =>
      pod.metadata.labels?.["app.kubernetes.io/name"] === "openshell" &&
      pod.metadata.labels?.["app.kubernetes.io/instance"] === openShellGatewayInstance,
  );
  assert.equal(
    gatewayPods.length,
    1,
    "Namespace bootstrap must converge on one OpenShell gateway.",
  );
}

async function assertEmbeddedOpenShellFailsClosed(topology) {
  const configuration = createHarnessConfiguration("openclaw", providerModel);
  const createdConfiguration = await topology.request(
    "POST",
    `/namespaces/${topology.namespaceId}/configurations`,
    { kind: "agent", values: configuration },
  );
  assert.equal(createdConfiguration.status, 201, JSON.stringify(createdConfiguration.error));
  const agent = await topology.request("POST", `/namespaces/${topology.namespaceId}/agents`, {
    name: `openshell-embedded-${randomUUID()}`,
    configurationId: createdConfiguration.data.id,
    executionMode: "embedded",
    // The Harness credential source must also be listed in the Agent's credential sources.
    credentialSources: [{ sourceId: topology.agent.harnessAuth.sourceId }],
    harnessAuth: topology.agent.harnessAuth,
  });
  // OpenShell-selected installations refuse an embedded Agent when it is saved, so nothing
  // can be deployed or provisioned for it.
  assert.equal(agent.status, 400, JSON.stringify(agent.data ?? agent.error));
  assert.match(agent.error.message, /supports only dedicated Harness execution/u);
}

async function observeExposedCodexAuthenticationBoundary(serviceUrl, appServerToken) {
  const url = new URL(serviceUrl);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const upgrade = request(url, {
      // Connect through the loopback port-forward without discarding OpenShell's Host routing key.
      lookup: createOpenShellServiceLoopbackLookup(url.hostname),
      headers: {
        ...(appServerToken === undefined ? {} : { authorization: `Bearer ${appServerToken}` }),
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    upgrade.setTimeout(2_000, () => {
      upgrade.destroy(new Error("OpenShell exposed Codex authentication probe timed out."));
    });
    upgrade.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    upgrade.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    upgrade.on("error", reject);
    upgrade.end();
  });
}

const selectedHarness = process.env.OCC_TEST_OPENSHELL_HARNESS ?? "codex";
if (networkPolicyOnly) {
  assert.equal(selectedHarness, "codex", "The network-policy scenario requires Codex.");
}
assert.match(
  selectedHarness,
  /^(?:codex|openclaw)$/,
  "OCC_TEST_OPENSHELL_HARNESS must be codex or openclaw.",
);
if (demoStatePath !== undefined) {
  assert.equal(selectedHarness, "openclaw", "the OpenShell browser demo requires openclaw.");
}

test(
  networkPolicyOnly
    ? "OpenShell Agent network policy lifecycle"
    : "OpenShell enforces provider delivery and authenticated Codex exposure",
  {
    ...requiresOpenShellK3d,
    ...(demoStatePath === undefined ? { timeout: 2_400_000 } : {}),
  },
  async (testContext) => {
    // Finding 1711: every cleanup this test registers runs, last-registered first, each bounded.
    const teardown = boundedTeardown(testContext, { label: "OpenShell integration teardown" });
    teardownStarted = () => teardown.started;
    const { context } = teardown;
    if (demoStatePath !== undefined) {
      context.after(() => {
        process.removeListener("SIGINT", resolveDemoStop);
        process.removeListener("SIGTERM", resolveDemoStop);
      });
    }
    {
      process.stderr.write(`OpenShell integration: selected real ${selectedScenario} workflow.\n`);
      const topology = await prepareProductionInstallation(context, {
        harnessId: selectedHarness,
        ...(demoStatePath === undefined ? {} : { controllerPort: demoConsolePort }),
      });
      assert.equal(
        topology.harnessPod.spec.serviceAccountName,
        openShellAgentName(topology.agent.id),
      );
      assert.ok(topology.sandbox.metadata.name);
      if (selectedHarness === "openclaw") {
        // A native worker exposes held startup failures only until its node enrolls.
        // Confirm Workspace visibility before treating an absent service as withdrawn.
        const nativeGateway = topology.gatewayClient();
        assert.ok(
          await nativeGateway.getWorkspace(topology.placement, AbortSignal.timeout(10_000)),
        );
        assert.equal(
          await nativeGateway.getService(
            topology.placement,
            topology.sandbox.metadata.name,
            "",
            AbortSignal.timeout(10_000),
          ),
          undefined,
          "native OpenClaw must withdraw its startup-failure exposure after enrollment.",
        );
        process.stderr.write(
          "OpenShell integration: verifying dedicated native workspace file access.\n",
        );
        await assertNativeOpenClawWorkspaceFiles(topology);
        if (demoStatePath !== undefined) {
          process.stderr.write(
            "OpenShell integration: native worker ready; exposing the new-session browser demo.\n",
          );
          await holdNativeOpenClawDemo(context, topology);
        } else {
          // Restarting OCC exercises its active-revision sweep, which withdraws native
          // exposure without rendered Harness requirements or a preparation pass.
          await topology.pauseWorker();
          const sweepStart = topology.workerEvents.length;
          await topology.resumeWorker();
          await waitFor("native exposure withdrawal after worker restart", () =>
            topology.workerEvents
              .slice(sweepStart)
              .some(
                (event) =>
                  event.event === "worker.harness-exposure-withdrawn" &&
                  event.revisionId === topology.revision.id &&
                  event.agentId === topology.agent.id,
              )
              ? true
              : undefined,
          );
          process.stderr.write(
            "OpenShell integration: starting successive native worker sessions through Gateway.\n",
          );
          await requestGatewayTurns(context, topology, "openclaw");
          await assertEmbeddedOpenShellFailsClosed(topology);
        }
        return;
      }
      process.stderr.write(
        "OpenShell integration: checking create-time service exposure authentication boundary.\n",
      );
      assert.match(topology.harnessServiceUrl, /^https?:\/\//);
      // OpenShell must preserve the Gateway's bearer header while Codex remains the authenticator.
      let lastServiceObservation = "no response";
      try {
        await waitFor("OpenShell create-time Harness service exposure", async () => {
          try {
            const status = await observeExposedCodexAuthenticationBoundary(
              topology.harnessServiceUrl,
              topology.appServerToken,
            );
            lastServiceObservation = `HTTP ${status}`;
            return status === 101 ? true : undefined;
          } catch (error) {
            lastServiceObservation = error instanceof Error ? error.message : String(error);
            return undefined;
          }
        });
      } catch (error) {
        throw new Error(`${error.message} Last observation: ${lastServiceObservation}.`, {
          cause: error,
        });
      }
      for (const token of [undefined, `wrong-${randomUUID()}`]) {
        const status = await observeExposedCodexAuthenticationBoundary(
          topology.harnessServiceUrl,
          token,
        );
        assert.ok(
          [401, 403].includes(status),
          `Codex must reject ${token === undefined ? "missing" : "incorrect"} bearer authentication.`,
        );
      }
      // Retry only endpoint availability above. Preserve the first protocol failure on this route.
      await assertExposedCodexInitializes(topology.harnessServiceUrl, topology.appServerToken);
      process.stderr.write(
        "OpenShell integration: exposed Codex initialized; starting real shell turns through the Agent Gateway.\n",
      );
      await requestGatewayTurns(context, topology, "codex");
      process.stderr.write("OpenShell integration: regular Gateway shell turns passed.\n");
      if (!networkPolicyOnly) {
        await assertOpenShellToolFilesystemAndNetworkEnforcement(topology);
      }
      process.stderr.write("OpenShell integration: testing Agent network policy lifecycle.\n");
      try {
        await assertAgentNetworkPolicyLifecycle(topology);
      } catch (error) {
        // Teardown may take minutes; preserve the failure before removing its resources.
        const message = redactLogLine(
          String(error?.stack ?? error?.message).replaceAll("\n", " "),
          failureSecrets([
            process.env,
            { modelCredential, appServerToken: topology.appServerToken },
          ]),
          2000,
        );
        process.stderr.write(
          `OpenShell integration: Agent network policy lifecycle failed: ${message}\n`,
        );
        throw error;
      }
      if (networkPolicyOnly) {
        process.stderr.write(
          "OpenShell integration: Installation defaults, denied endpoint, preview/save/apply, second-Agent isolation, and revocation passed.\n",
        );
        return;
      }
      process.stderr.write(
        "OpenShell integration: tool filesystem and egress verified; testing the credential route.\n",
      );
      await assertCredentialRouteEnforcement(topology);
      process.stderr.write(
        "OpenShell integration: credential route verified; testing Pod-absent replacement and cleanup.\n",
      );
      await assertDuplicateReconciliationDoesNotDuplicateOpenShell(topology);
      process.stderr.write(
        "OpenShell integration: replacement verified; testing an untrusted model upstream.\n",
      );
      await assertModelRouteRefusesUntrustedUpstream(topology);
      process.stderr.write(
        "OpenShell integration: untrusted model upstream refused; testing a tool upstream outage.\n",
      );
      await assertToolUpstreamOutageFailsClosed(topology);
      process.stderr.write(
        "OpenShell integration: tool upstream outage verified; testing a model provider outage.\n",
      );
      await assertModelProviderOutageFailsClosed(topology);
      process.stderr.write(
        "OpenShell integration: model provider outage verified; testing an OpenShell gateway outage.\n",
      );
      await assertOpenShellGatewayOutage(topology);
      process.stderr.write(
        "OpenShell integration: gateway outage verified; testing OAuth2 refresh credential sources.\n",
      );
      await assertRefreshCredentialSources(topology);
      process.stderr.write(
        "OpenShell integration: refresh sources verified; testing a non-model credential source.\n",
      );
      await assertNonModelCredentialSource(topology);
      process.stderr.write(
        "OpenShell integration: non-model source verified; checking Agent-visible material, diagnostics and audit.\n",
      );
      await assertAgentVisibleMaterialExcludesCredentials(topology);
      process.stderr.write(
        "OpenShell integration: credential absence verified; testing credential source update and live withdrawal.\n",
      );
      await assertCredentialSourceUpdateAndLiveWithdrawal(topology);
      process.stderr.write(
        "OpenShell integration: withdrawal recorded and post-withdrawal turn did not complete; testing embedded fail-closed.\n",
      );
      await assertEmbeddedOpenShellFailsClosed(topology);
      // Changing gateway authentication restarts its service router. Keep this configuration
      // boundary last so it cannot disrupt the Agent workflow whose behavior is tested above.
      process.stderr.write("OpenShell integration: testing authenticated native policy scopes.\n");
      await assertAuthenticatedNativePolicyScopes(topology);
      return;
    }
  },
);
