import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { failureSecrets, redactLogLine } from "../../scripts/ci/failure-redaction.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
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
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  createOpenShellServiceLoopbackLookup,
  OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY,
  openShellAgentName,
  openShellGatewayName,
  openshellHash as hash,
} from "../helpers/openshell-kubernetes-real.mjs";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "../helpers/envoy-workspace-gateway.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import {
  defaultKeycloakImage,
  keycloakServiceClient,
  keycloakUserClient,
  startKeycloak,
} from "../helpers/keycloak-real.mjs";

const executeFile = promisify(execFile);

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
const openShellChartVersion = process.env.OCC_TEST_OPENSHELL_CHART_VERSION ?? "0.1.3-pre.2";
const openShellRuntimeClass = process.env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox";
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);
const openShellModelBaseUrl = process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim() || undefined;
const openShellModelAuthHeader = process.env.OCC_TEST_OPENSHELL_MODEL_AUTH_HEADER;
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
    openShellModelAuthHeader,
    openShellHelmPath,
    openShellHelmChart,
    openShellWorkspaceHelmChart,
    openShellModelBaseUrl,
  ].some(Boolean);
const requiresOpenShellK3d = {
  skip: selected
    ? false
    : "Set OCC_TEST_OPENSHELL_K3D_REAL=1 with explicit k3d, PostgreSQL, OpenShell, real image, and OPENAI_API_KEY prerequisites.",
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
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
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
  return { ...identity, tenantRole, apiSecretRole, apiIdentity };
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
  configuration.tools = {
    allow: ["read", "write", "edit", "exec"],
    fs: { workspaceOnly: true },
  };
  return configuration;
}

function nativeOpenClawConfiguration(gatewayAuth, controlUiOrigins = []) {
  const configuration = createHarnessConfiguration("openclaw", providerModel);
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
  context.after(async () => {
    dns.lookup = originalLookup;
    await Promise.allSettled([
      forwarding.stop(),
      executeFile(containerEngine, ["stop", "--timeout", "2", relayName]),
    ]);
  });
  await waitForLoopbackPort(endpointPort);
  await waitForWorkspaceGatewayTls(gatewayHostname, endpointPort);
  return endpointPort;
}

function summarizeWorkerEvent(event) {
  return Object.fromEntries(
    ["event", "operation", "revisionId", "outcome", "code", "attempt"]
      .map((key) => [key, event[key]])
      .filter(([, value]) => typeof value === "string" || typeof value === "number"),
  );
}

function summarizeWorkerEvents(events, revisionId) {
  return events
    .map(summarizeWorkerEvent)
    .filter(
      (event) =>
        event.revisionId === revisionId ||
        event.event === "worker.completed" ||
        event.event === "worker.error",
    )
    .slice(-40);
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

async function writeWorkerCompletionDiagnostics(options) {
  let persisted;
  try {
    persisted = await readWorkerRevisionState(options.pool, options);
  } catch (error) {
    persisted = { readError: error?.name ?? "Error" };
  }
  process.stderr.write(
    `OpenShell worker completion diagnostic: ${JSON.stringify({
      operation: "agent_revision.reconcile",
      revisionId: options.revisionId,
      events: summarizeWorkerEvents(options.events, options.revisionId),
      persisted,
    })}\n`,
  );
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
  const nodeSetupCode = optionalSecretEnvironment(context.requirements, "OPENCLAW_NODE_SETUP_CODE");
  const nodeCa = literalEnvironment(context.requirements, "OPENCLAW_NODE_CA_PEM");
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
                  'printf "%s" "$OPENCLAW_NODE_CA_PEM" > /bootstrap/openclaw-node-ca.pem',
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
                  "chmod 0444 /bootstrap/openclaw-node-ca.pem",
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
                nodeCa,
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
    context.requirements.environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
    "Compute must not project OPENAI_API_KEY when a credential source authenticates the Harness.",
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
    ...(nodeSetupCode === undefined
      ? []
      : [
          `process.env.OPENCLAW_NODE_SETUP_CODE = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-setup-code", "utf8");`,
        ]),
    `process.env.OPENCLAW_NODE_CA_PEM = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-ca.pem", "utf8");`,
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
        !["APP_SERVER_TOKEN", "OPENCLAW_NODE_SETUP_CODE", "OPENCLAW_NODE_CA_PEM"].includes(name),
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
      { claimName, subPath, mountPath: credentialMountPath, readOnly: true },
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
    '    if (variable.startsWith("OPENAI_API_KEY=")) values.push(variable.slice(15));',
    "  }",
    "}",
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
  assert.equal(observed.placeholders, true, "OPENAI_API_KEY must be an OpenShell placeholder.");
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
  for (const name of ["APP_SERVER_TOKEN", "OPENAI_API_KEY"]) {
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
  assert.ok(nativeInference.models.providers.openai.models.length > 0);
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
            return await value.apply(target, args);
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
      context.requirements.workloadIdentity?.serviceAccountName ??
      openShellAgentName(context.revision.agentId)
    );
  }

  async function endpointForNamespace(context, { sandboxServiceAccountName } = {}) {
    const namespaceName = context.namespace.name;
    throwOpenShellAbortReason(context.signal);
    const prior = gatewayState.get(namespaceName);
    if (prior !== undefined && prior.sandboxServiceAccountName === sandboxServiceAccountName) {
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
      context.signal.removeEventListener("abort", stopOwnedForward);
      throw error;
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
      return new OpenShellSandboxDriver(optionsFor(requirements, namespaceName), {
        id: selection.id,
        implementation: "openshell",
        backend: backendFor(gatewayClient),
      });
    }

    return {
      id: selection.id,
      capability: "sandbox",
      implementation: selection.implementation,
      facets: Object.freeze(["networking", "filesystem", "process"]),
      configureAgent(configuration, harness) {
        // Configuration admission performs no gateway I/O.
        return new OpenShellSandboxDriver(selection.configuration, {
          id: selection.id,
          implementation: "openshell",
          backend: backendFor(undefined),
        }).configureAgent(configuration, harness);
      },
      harnessResource(context) {
        // The bridge provisions through the real Driver, so its Sandbox identity is the same.
        return new OpenShellSandboxDriver(selection.configuration, {
          id: selection.id,
          implementation: "openshell",
          backend: backendFor(undefined),
        }).harnessResource(context);
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
      // Compute asks for the OpenShell-exposed Codex endpoint and points the Agent Gateway at it.
      // The real Driver supports this only for dedicated Codex, so the bridge proof omits it.
      ...(enableCompatibilityBridges
        ? {}
        : {
            async harnessEndpoint(context) {
              const endpoint = await endpointForNamespace(context, {
                sandboxServiceAccountName: agentSandboxServiceAccount(context),
              });
              return await delegate(
                context.requirements,
                context.namespace.name,
                endpoint,
                context,
              ).harnessEndpoint(context);
            },
            // Compute activates only a Harness that completes the authenticated handshake.
            async harnessStatus(context) {
              const endpoint = await endpointForNamespace(context, {
                sandboxServiceAccountName: agentSandboxServiceAccount(context),
              });
              return await delegate(
                context.requirements,
                context.namespace.name,
                endpoint,
                context,
              ).harnessStatus(context);
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
  createDriver.createBackend = createBackend;
  // An independent read of the Namespace gateway's own state, for assertions.
  createDriver.gatewayClientForNamespace = (namespaceName) => {
    const state = gatewayState.get(namespaceName);
    assert.ok(state, `OpenShell gateway for namespace ${namespaceName} was not initialized.`);
    return clientForEndpoint(state.endpoint);
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

async function prepareProductionInstallation(
  context,
  { harnessId = "codex", controllerPort } = {},
) {
  const kubeconfig = await validateOpenShellPrerequisites();
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
    // Automatic enrollment egress belongs to the Driver's Codex runtime provider. The native
    // verification bridge must admit only its Node executable and exact Gateway endpoint.
    configuration.drivers.sandbox.configuration.policy.networkPolicies.push({
      name: "workspace-node-enrollment",
      binaries: [{ path: "/usr/local/bin/node" }],
      endpoints: [
        {
          host: workspaceGateway.routing.hostname,
          ports: [workspaceGateway.routing.endpointPort],
          tls: "skip",
          enforcement: "enforce",
        },
      ],
    });
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
        })
      : undefined;
  // A cluster-internal echo service stands in for a protected non-model API. Only curl may
  // carry a non-model source's credential to it. It verifies Keycloak's signatures, so a
  // delivered OAuth2 token is proved genuine without the token reaching test output.
  const tokenEcho =
    harnessId === "codex" ? await startTokenEcho(context, keycloak?.jwks) : undefined;
  if (tokenEcho !== undefined) {
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
  // For Codex, the Sandbox Driver adds the workspace node's Gateway egress rule itself
  // (`workspace-node-enrollment`); a second rule for the same host and port is ambiguous.
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
        computeDriver: withFirstPrepareRevisionFailureDiagnostic(loaded.computeDriver),
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
  let workerPool;
  let worker;
  let productionApp;
  let controllerUrl;
  let placement;
  let gatewayPlacement;
  context.after(async () => {
    const cleanupFailures = [];
    const cleanupStep = async (description, operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(new Error(`${description}: ${error.message}`, { cause: error }));
      }
    };

    await cleanupStep("controller worker", async () => {
      if (worker !== undefined) {
        await worker.stop();
      } else if (workerPool !== undefined) {
        await workerPool.end();
      }
    });
    await cleanupStep("OpenShell management port-forwards", async () => {
      await createSandboxDriver.disposeGatewayForwards();
    });
    await cleanupStep("production app", async () => {
      if (productionApp !== undefined) {
        await productionApp.close();
      }
    });
    await cleanupStep("observer pool", async () => {
      await observerPool.end();
    });
    await cleanupStep("Kubernetes namespace", async () => {
      if (placement !== undefined) {
        await kubectl(
          "delete",
          "namespace",
          placement,
          "--ignore-not-found=true",
          "--wait=true",
          "--timeout=120s",
        );
      }
    });
    await cleanupStep("temporary directory", async () => {
      await rm(directory, { recursive: true, force: true });
    });
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        `OpenShell integration cleanup reported ${cleanupFailures.length} failure(s).`,
      );
    }
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
      emit: (event) => events.push(event),
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
    value: process.env.OPENAI_API_KEY,
  });
  assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.error));
  assert.equal(JSON.stringify(modelSecret).includes(process.env.OPENAI_API_KEY), false);
  // Registration copies the Secret value into the Namespace's OpenShell gateway through the
  // regular API. The Secret stays the source of record; the Harness never receives it.
  const modelSource = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    name: `openshell-openai-${randomUUID()}`,
    type: "openai",
    config: {
      ...(openShellModelBaseUrl === undefined ? {} : { base_url: openShellModelBaseUrl }),
      ...(openShellModelAuthHeader === undefined ? {} : { auth_header: openShellModelAuthHeader }),
    },
    secrets: { api_key: modelSecret.data.ref },
  });
  assert.equal(modelSource.status, 201, JSON.stringify(modelSource.error));
  assert.equal(modelSource.data.state, "ready");
  assert.deepEqual(modelSource.data.status, { state: "ready" });
  assert.equal(JSON.stringify(modelSource).includes(process.env.OPENAI_API_KEY), false);
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
          await registerToolSource(request, namespaceId, tokenEcho, "TOOL_A_TOKEN", "/echo-a"),
          await registerToolSource(request, namespaceId, tokenEcho, "TOOL_B_TOKEN", "/echo-b"),
        ];
  const refreshSources =
    keycloak === undefined
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
    // The list holds every bound source; harnessAuth names the model source within it.
    credentialSources: [
      { sourceId: modelSource.data.id },
      ...(toolSources ?? []).map(({ id }) => ({ sourceId: id })),
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
  for (const toolSource of [...(toolSources ?? []), ...(refreshSources?.bound ?? [])]) {
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
      "OCC must freeze OpenShell-selected Codex revisions with the inner sandbox disabled.",
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
    for (const namespace of new Set([placement, gatewayPlacement])) {
      try {
        for (const pod of await resources("pods", namespace)) {
          for (const container of pod.spec.containers) {
            if (!["agent", "gateway", "supervisor"].includes(container.name)) {
              continue;
            }
            const logs = await kubectl(
              "logs",
              pod.metadata.name,
              "--namespace",
              namespace,
              "--container",
              container.name,
              "--tail=80",
            ).catch(() => "Pod logs unavailable");
            const lines = logs
              .split("\n")
              .filter((line) => /error|fail|denied|refus|startup|NET:/iu.test(line))
              .slice(-12);
            for (const line of lines) {
              process.stderr.write(
                `OpenShell startup ${pod.metadata.name}/${container.name}: ${redactLogLine(line, secrets, 800)}\n`,
              );
            }
          }
        }
      } catch {
        process.stderr.write("OpenShell startup Pod diagnostics unavailable\n");
      }
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
  await assertNoSecretBytes(placement, [process.env.OPENAI_API_KEY, transport.appServerToken]);
  await assertModelKeyIsPlaceholderOnly(placement, harnessPod, process.env.OPENAI_API_KEY);
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
    controllerUrl,
    credentials: adminCredentials,
    ...(toolSources === undefined ? {} : { toolSources }),
    ...(refreshSources === undefined ? {} : { refreshSources, keycloak }),
    gatewayClient: () => createSandboxDriver.gatewayClientForNamespace(placement),
    observerPool,
    pauseWorker,
    resumeWorker: startWorker,
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
  const program = [
    'const { createHash, createPublicKey, verify } = require("node:crypto");',
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
    'require("node:http").createServer((request, response) => {',
    '  const authorization = request.headers.authorization ?? "";',
    '  response.setHeader("content-type", "application/json");',
    "  response.end(JSON.stringify({",
    "    path: request.url,",
    '    digest: createHash("sha256").update(authorization).digest("hex"),',
    '    placeholder: authorization.includes("openshell:resolve:"),',
    "    jwt: jwt(authorization),",
    "  }));",
    '}).listen(8080, "0.0.0.0");',
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
  return { host: `token-echo.${namespace}.svc.cluster.local`, port: 8080 };
}

// A redeploy rolls the Agent Gateway Deployment, so later turns use the Pod running now.
async function currentGatewayPod(topology) {
  return await waitFor("one running Agent Gateway Pod", async () => {
    const pods = (await resources("pods", topology.gatewayPlacement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
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
  // with the not-found response it gives every invalid catalog field.
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
  assert.equal(plain.status, 404, JSON.stringify(plain.error ?? plain.data));
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
    const echoed = (source) => {
      const echo = commands.find(({ command }) => String(command).includes(source.url));
      assert.ok(echo, `the Harness must call ${source.url}`);
      try {
        return JSON.parse(String(echo.aggregatedOutput ?? "").trim());
      } catch {
        return undefined;
      }
    };
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
    assert.equal(observed?.placeholder, false, `${source.type} must arrive substituted`);
    assert.equal(observed?.jwt?.valid, true, `${source.type} must carry a valid Keycloak token`);
    assert.equal(observed.jwt.iss, keycloak.issuer);
    assert.equal(observed.jwt.azp, source.clientId);
  };

  // The Harness holds only placeholders; OpenShell substitutes tokens it minted itself.
  const first = await call();
  assertIssued(first.cc, clientCredentials);
  assertIssued(first.rt, refreshToken);

  // Without any OCC call, the gateway re-mints before expiry. The same running Harness, with
  // the same placeholder, then presents the new token.
  const minted = await readRefresh(clientCredentials);
  assert.equal(minted.state, "ready");
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

/**
 * The running Codex Harness calls the echo service with each tool placeholder. OpenShell
 * substitutes a token only at its own source's endpoint. The phase then proves, through the
 * real worker, Compute and OpenShell gateway, that:
 * - a withdrawal is executed only on its own requester's authority, even on a shared claim;
 * - an Agent that loses a source grant after admission never has the revision provisioned;
 * - admission refuses a redeploy without the grant.
 * The model source keeps working throughout.
 */
async function assertNonModelCredentialSource(topology) {
  const { request, namespaceId, toolSources, observerPool } = topology;
  const [toolA, toolB] = toolSources;
  const agentId = topology.agent.id;
  const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const revision = { id: current.data.activeRevisionId, agentId };
  assert.ok(revision.id, "the Agent must have an active revision");
  await waitForProviderHarnessPod(topology.placement, revision);
  // The dedicated Harness holds only the app-server token's digest, so each turn goes through the
  // Agent Gateway.
  const call = async () => {
    const nonce = `OCC-OPENSHELL-TOOL-${randomUUID()}`;
    const result = await requestCodexTurnFromGatewayPod({
      namespace: topology.gatewayPlacement,
      gatewayPod: await currentGatewayPod(topology),
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
    const digest = (tool) => {
      const echo = commands.find(({ command }) => String(command).includes(tool.url));
      assert.ok(echo, `the Harness must call ${tool.url}`);
      try {
        return JSON.parse(String(echo.aggregatedOutput ?? "").trim()).digest;
      } catch {
        return undefined;
      }
    };
    return {
      placeholder: String(environment.aggregatedOutput ?? "").trim(),
      a: digest(toolA),
      b: digest(toolB),
    };
  };
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
  assert.equal(before.a, toolA.digest, "OpenShell must substitute tool A's token");
  assert.equal(before.b, toolB.digest, "OpenShell must substitute tool B's token");

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
  assert.notEqual(after.a, toolA.digest, "a withdrawn token must not be delivered");
  assert.equal(after.b, toolB.digest, "a denied withdrawal must not detach its source");
  const unchanged = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
  assert.equal(unchanged.data.activeRevisionId, revision.id, "withdrawal must not redeploy");

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
    value: process.env.OPENAI_API_KEY,
  });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.error));
  const replaced = await request(
    "PATCH",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}`,
    { secrets: { api_key: replacement.data.ref } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.error));
  assert.deepEqual(replaced.data.secrets, { api_key: replacement.data.ref });
  assert.equal(JSON.stringify(replaced).includes(process.env.OPENAI_API_KEY), false);

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
    String(observation).includes(process.env.OPENAI_API_KEY),
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

async function nativeOpenClawTurnFailureDiagnostic(topology, gatewayPassword) {
  const redactions = [process.env.OPENAI_API_KEY, gatewayPassword, topology.appServerToken].filter(
    (secret) => typeof secret === "string" && secret.length > 0,
  );
  const sections = [];
  for (const source of [
    {
      label: "Gateway",
      name: topology.gatewayPod.metadata.name,
      namespace: topology.gatewayPlacement,
      containerArguments: [],
    },
    {
      label: "Harness",
      name: topology.harnessPod.metadata.name,
      namespace: topology.placement,
      containerArguments: ["--container", "agent"],
    },
  ]) {
    try {
      let logs = await kubectl(
        "logs",
        source.name,
        "--namespace",
        source.namespace,
        ...source.containerArguments,
        "--tail=300",
      );
      for (const secret of redactions) {
        logs = logs.replaceAll(secret, "[REDACTED]");
      }
      const relevant = logs
        .split("\n")
        .filter((line) =>
          /error|warn|workspace|model|openai|worker|node host|inference|turn|fetch|network|policy/iu.test(
            line,
          ),
        )
        .slice(-80)
        .join("\n");
      sections.push(`${source.label} diagnostics:\n${relevant}`);
    } catch (error) {
      sections.push(`${source.label} diagnostics unavailable: ${error?.message ?? String(error)}`);
    }
  }
  try {
    const pod = await resource("pod", topology.harnessPod.metadata.name, topology.placement);
    const containers = (pod.status?.containerStatuses ?? []).map((status) => ({
      name: status.name,
      state: status.state,
      restartCount: status.restartCount,
    }));
    sections.push(`Harness Pod: ${JSON.stringify({ phase: pod.status?.phase, containers })}`);
  } catch (error) {
    sections.push(`Harness Pod status unavailable: ${error?.message ?? String(error)}`);
  }
  return `\n${sections.join("\n")}`;
}

async function requestNativeOpenClawTurns(context, topology) {
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
  const requestTurn = async () => {
    const nonce = `OCC-OPENSHELL-NATIVE-${randomUUID()}`;
    let response;
    try {
      response = await fetch(`${forwarding.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayPassword}`,
          "content-type": "application/json",
          "x-openclaw-session-key": `openshell-native-${randomUUID()}`,
        },
        body: JSON.stringify({
          model: "openclaw/default",
          stream: false,
          messages: [{ role: "user", content: `Reply with exactly ${nonce}.` }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      const diagnostic = await nativeOpenClawTurnFailureDiagnostic(topology, gatewayPassword);
      assert.fail(
        `Native OpenClaw turn request failed: ${error?.message ?? String(error)}${diagnostic}`,
      );
    }
    const body = await response.text();
    assert.equal(body.includes(process.env.OPENAI_API_KEY), false);
    assert.equal(body.includes(gatewayPassword), false);
    const failureDiagnostic =
      response.status === 200
        ? ""
        : await nativeOpenClawTurnFailureDiagnostic(topology, gatewayPassword);
    assert.equal(response.status, 200, `${body}${failureDiagnostic}`);
    assert.match(JSON.parse(body).choices?.[0]?.message?.content ?? "", new RegExp(nonce));
  };

  // The first session's retained worker keeps its slot after the turn. A second session therefore
  // proves that the same AgentRevision Sandbox admits more than one session-owned worker.
  await requestTurn();
  await requestTurn();
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
  const providerWorkspace = providerWorkspaceVariable.value;
  const harnessWorkspaceVariable = topology.harnessPod.spec.containers
    .flatMap(({ env = [] }) => env)
    .find(({ name }) => name === "OPENCLAW_WORKSPACE_DIR");
  assert.equal(
    harnessWorkspaceVariable?.value,
    providerWorkspace,
    "the OpenShell Harness and Agent Gateway must use the same workspace root.",
  );
  const writablePath = `${providerWorkspace}/${nonce}.txt`;
  // OpenShell serves provider-profile files only when they are opened; access(2) reports them
  // missing. Reading proves the projected config is readable, and a write open is refused.
  const approvedPath = '"$OPENCLAW_PLUGIN_CODEX_CONFIG_TOML"';
  const approvedRead = `head -c 1 ${approvedPath} > /dev/null`;
  const readonlyPath = approvedPath;
  const escapedPath = `${providerWorkspace}/../${nonce}-escape.txt`;
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
      `(6) curl -fsSI --max-time 10 https://acme.com. ` +
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
  assert.match(result.assistant, new RegExp(nonce));
  assert.match(result.assistant, /WORKSPACE_WRITABLE/);
  assert.match(result.assistant, /APPROVED_PATH_READABLE/);
  assert.match(result.assistant, /READONLY_DENIED/);
  assert.match(result.assistant, /ESCAPE_DENIED/);
  assert.match(result.assistant, /OPENCLAW_ALLOWED/);
  assert.match(result.assistant, /ACME_DENIED/);
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
  try {
    await waitFor(`replacement OpenShell revision ${redeployed.data.id} activation`, async () => {
      const observed = await topology.request(
        "GET",
        `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.activeRevisionId === redeployed.data.id ? observed.data : undefined;
    });
  } catch (error) {
    await topology.diagnoseRevision(redeployed.data.id);
    throw error;
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
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(
    deployed.status,
    404,
    "OpenShell-selected installations must reject embedded Agents before provisioning.",
  );
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
assert.match(
  selectedHarness,
  /^(?:codex|openclaw)$/,
  "OCC_TEST_OPENSHELL_HARNESS must be codex or openclaw.",
);
if (openShellModelAuthHeader !== undefined) {
  assert.ok(
    ["authorization", "x-api-key"].includes(openShellModelAuthHeader),
    "OCC_TEST_OPENSHELL_MODEL_AUTH_HEADER must be authorization or x-api-key.",
  );
  if (openShellModelAuthHeader === "x-api-key") {
    assert.equal(selectedHarness, "codex", "raw-header proof requires dedicated Codex.");
    assert.ok(openShellModelBaseUrl, "raw-header proof requires its authorized model endpoint.");
  }
}
if (demoStatePath !== undefined) {
  assert.equal(selectedHarness, "openclaw", "the OpenShell browser demo requires openclaw.");
}

test(
  "OpenShell enforces provider delivery and authenticated Codex exposure",
  {
    ...requiresOpenShellK3d,
    ...(demoStatePath === undefined ? { timeout: 1_500_000 } : {}),
  },
  async (context) => {
    if (demoStatePath !== undefined) {
      context.after(() => {
        process.removeListener("SIGINT", resolveDemoStop);
        process.removeListener("SIGTERM", resolveDemoStop);
      });
    }
    {
      process.stderr.write("OpenShell integration: selected real provider-delivery proof.\n");
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
        assert.equal(
          topology.harnessServiceUrl,
          undefined,
          "native OpenClaw must not request an inbound OpenShell service exposure.",
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
          process.stderr.write(
            "OpenShell integration: starting successive native worker sessions through Gateway.\n",
          );
          await requestNativeOpenClawTurns(context, topology);
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
      process.stderr.write(
        "OpenShell integration: create-time route reached protected Harness; starting authenticated real in-Sandbox model turn.\n",
      );
      const nonce = `OCC-OPENSHELL-${randomUUID()}`;
      const modelTurn = await requestCodexTurnFromGatewayPod({
        namespace: topology.gatewayPlacement,
        gatewayPod: topology.gatewayPod.metadata.name,
        providerModel,
        prompt: `Reply with exactly ${nonce}.`,
      });
      assert.match(modelTurn.assistant, new RegExp(nonce));
      assert.equal(JSON.stringify(modelTurn).includes(process.env.OPENAI_API_KEY), false);
      process.stderr.write(
        "OpenShell integration: real in-Sandbox model turn passed; testing actual filesystem and network enforcement.\n",
      );
      await assertOpenShellToolFilesystemAndNetworkEnforcement(topology);
      process.stderr.write(
        "OpenShell integration: tool filesystem and egress verified; testing Pod-absent replacement and cleanup.\n",
      );
      await assertDuplicateReconciliationDoesNotDuplicateOpenShell(topology);
      process.stderr.write(
        "OpenShell integration: replacement verified; testing OAuth2 refresh credential sources.\n",
      );
      await assertRefreshCredentialSources(topology);
      process.stderr.write(
        "OpenShell integration: refresh sources verified; testing a non-model credential source.\n",
      );
      await assertNonModelCredentialSource(topology);
      process.stderr.write(
        "OpenShell integration: non-model source verified; testing credential source update and live withdrawal.\n",
      );
      await assertCredentialSourceUpdateAndLiveWithdrawal(topology);
      process.stderr.write(
        "OpenShell integration: withdrawal recorded and post-withdrawal turn did not complete; testing embedded fail-closed.\n",
      );
      await assertEmbeddedOpenShellFailsClosed(topology);
      return;
    }
  },
);
