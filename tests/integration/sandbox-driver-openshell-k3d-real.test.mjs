import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
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
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  createOpenShellServiceLoopbackLookup,
  openShellAgentName,
  openshellHash as hash,
} from "../helpers/openshell-kubernetes-real.mjs";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "../helpers/envoy-workspace-gateway.mjs";

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
const openShellChartVersion = process.env.OCC_TEST_OPENSHELL_CHART_VERSION ?? "0.1.0";
const openShellRuntimeClass = process.env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox";
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);
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
const nodeStateMountPath = "/home/node/.openclaw-node";
// Kubernetes Compute backs all of /home/node with an emptyDir; stock OpenShell has no equivalent,
// so the bridge stages the native state root where the Agent entrypoint publishes plugin skills.
const openclawHomeMountPath = "/home/node/.openclaw";
const workspaceMountPath = "/home/node/workspace";
const bridgedWorkspaceSubPath = "workspace/openshell-home";
const portableCommandArgumentBytes = 30 * 1024;
const requiredWorkspaceMounts = Object.freeze([
  {
    subPath: "generated-images",
    mountPath: "/home/node/.codex/generated_images",
    readOnly: false,
  },
  { subPath: bridgedWorkspaceSubPath, mountPath: workspaceMountPath, readOnly: false },
]);
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
  assertApprovedOpenShellPrivileges,
  assertGatewayBootstrapPolicies,
  assertNoSecretBytes,
  requestCodexTurnFromOpenShellHarnessPod,
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

async function waitForWorkspaceGatewayTls(hostname) {
  await waitFor("OpenShell host-side Gateway TLS path", async () => {
    try {
      await new Promise((resolve, reject) => {
        const socket = connectTls({ host: hostname, port: 443, servername: hostname });
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
    '  const upstream = net.connect({ host: "127.0.0.1", port: targetPort });',
    "  client.pipe(upstream).pipe(client);",
    '  client.on("error", () => upstream.destroy());',
    '  upstream.on("error", () => client.destroy());',
    "});",
    'server.listen(443, "127.0.0.1");',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  await executeFile(process.env.OCC_DOCKER_BIN ?? "docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    relayName,
    "--network",
    "host",
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
    const inspected = await executeFile(process.env.OCC_DOCKER_BIN ?? "docker", [
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
      executeFile(process.env.OCC_DOCKER_BIN ?? "docker", ["stop", "--timeout", "2", relayName]),
    ]);
  });
  await waitForLoopbackPort(443);
  await waitForWorkspaceGatewayTls(gatewayHostname);
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

function pluginRuntimeConfigMapName(context) {
  return `plugin-runtime-${hash(context.revision.agentId)}-rev-${hash(context.revision.id)}`;
}

function secretEnvironment(requirements, name) {
  const variable = requirements.environment.find((entry) => entry.name === name);
  assert.ok(variable?.valueFrom?.secretKeyRef, `${name} must come from an exact SecretKeyRef.`);
  return variable;
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
  const namespaceName = context.namespace.name;
  const name = credentialJobName(context.revision.id);
  const servicePrincipalToken = context.requirements.serviceAccountToken;
  assert.match(
    servicePrincipalToken.path,
    /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    "the OpenShell bridge requires a safe relative ServiceAccount token path.",
  );
  const tokenParent = servicePrincipalToken.path.includes("/")
    ? servicePrincipalToken.path.slice(0, servicePrincipalToken.path.lastIndexOf("/"))
    : ".";
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
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            ...context.requirements.labels,
            "openclaw.dev/workload-role": "sandbox-bootstrap-bridge",
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: context.requirements.serviceAccountName,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
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
                  "mkdir -p /bootstrap/plugin-runtime",
                  "mkdir -p /bootstrap/node-state",
                  "mkdir -p /bootstrap/runtime-assets",
                  "mkdir -p /bootstrap/openclaw-home",
                  `mkdir -p /bootstrap/service-principal/${tokenParent}`,
                  "mkdir -p /workspace-home/openshell-home/.codex",
                  "chmod 0700 /bootstrap/plugin-runtime /bootstrap/service-principal",
                  "chmod 0700 /bootstrap/node-state",
                  "chmod 0600 /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem 2>/dev/null || true",
                  "chmod 0600 /bootstrap/plugin-runtime/runtime.json /bootstrap/plugin-runtime/config.toml 2>/dev/null || true",
                  `chmod 0600 /bootstrap/service-principal/${servicePrincipalToken.path} 2>/dev/null || true`,
                  'printf "%s" "$APP_SERVER_TOKEN" > /bootstrap/app-server-token',
                  ...(nodeSetupCode === undefined
                    ? []
                    : [
                        'printf "%s" "$OPENCLAW_NODE_SETUP_CODE" > /bootstrap/openclaw-node-setup-code',
                      ]),
                  'printf "%s" "$OPENCLAW_NODE_CA_PEM" > /bootstrap/openclaw-node-ca.pem',
                  "cp /source-plugin-runtime/runtime.json /bootstrap/plugin-runtime/runtime.json",
                  "cp /source-plugin-runtime/config.toml /bootstrap/plugin-runtime/config.toml",
                  `cp /source-service-principal/${servicePrincipalToken.path} /bootstrap/service-principal/${servicePrincipalToken.path}`,
                  "chmod 0444 /bootstrap/app-server-token",
                  ...(nodeSetupCode === undefined
                    ? []
                    : ["chmod 0444 /bootstrap/openclaw-node-setup-code"]),
                  "chmod 0444 /bootstrap/openclaw-node-ca.pem",
                  "chmod 0444 /bootstrap/plugin-runtime/runtime.json /bootstrap/plugin-runtime/config.toml",
                  `chmod 0444 /bootstrap/service-principal/${servicePrincipalToken.path}`,
                  "chmod 0555 /bootstrap/plugin-runtime /bootstrap/service-principal",
                  "chmod 0700 /bootstrap/runtime-assets /bootstrap/openclaw-home",
                  "chmod 0700 /workspace-home/openshell-home /workspace-home/openshell-home/.codex",
                ].join("\n"),
              ],
              env: [
                secretEnvironment(context.requirements, "APP_SERVER_TOKEN"),
                ...(nodeSetupCode === undefined ? [] : [nodeSetupCode]),
                nodeCa,
              ],
              volumeMounts: [
                { name: "bootstrap", mountPath: "/bootstrap", subPath },
                { name: "bootstrap", mountPath: "/workspace-home", subPath: "workspace" },
                {
                  name: "plugin-runtime",
                  mountPath: "/source-plugin-runtime",
                  readOnly: true,
                },
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
  if (command[0] === "node" && command[1] === "-e" && command.length === 3) {
    return 2;
  }
  assert.deepEqual(
    command.slice(0, 5),
    ["/usr/bin/tini", "-s", "--", "node", "-e"],
    "the OpenShell bridge expects the native Node entrypoint with its optional tini wrapper.",
  );
  assert.equal(command.length, 6, "the OpenShell bridge expects one inline Node program.");
  return 5;
}

function portableRuntimeCommand(command) {
  const programIndex = inlineNodeProgramIndex(command);
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of command[programIndex]) {
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
  return [...command.slice(0, programIndex), 'eval(process.argv.slice(1).join(""))', ...chunks];
}

function bridgeRequirements(context, claimName, subPath) {
  // The model key reaches Codex only through the Credential Gateway: Compute renders no model
  // Secret, and the Sandbox receives exactly one attachment for the Agent's credential source.
  assert.equal(
    context.requirements.environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
    "Compute must not project OPENAI_API_KEY when a credential source authenticates the Harness.",
  );
  assert.equal(context.requirements.credentialAttachments.length, 1);
  const servicePrincipalToken = context.requirements.serviceAccountToken;
  const nodeSetupCode = optionalSecretEnvironment(context.requirements, "OPENCLAW_NODE_SETUP_CODE");
  literalEnvironment(context.requirements, "OPENCLAW_NODE_CA_PEM");
  const credentialBootstrap = [
    `process.env.APP_SERVER_TOKEN = require("node:fs").readFileSync("${credentialMountPath}/app-server-token", "utf8");`,
    ...(nodeSetupCode === undefined
      ? []
      : [
          `process.env.OPENCLAW_NODE_SETUP_CODE = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-setup-code", "utf8");`,
        ]),
    `process.env.OPENCLAW_NODE_CA_PEM = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-ca.pem", "utf8");`,
  ].join("\n");
  const runtimeCommand = structuredClone(context.requirements.command);
  const programIndex = inlineNodeProgramIndex(runtimeCommand);
  runtimeCommand[programIndex] = `${credentialBootstrap}
${runtimeCommand[programIndex]}`;
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
      return entry;
    });
  return {
    ...context.requirements,
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
        subPath: `${subPath}/node-state`,
        mountPath: nodeStateMountPath,
        readOnly: false,
      },
      { claimName, subPath, mountPath: credentialMountPath, readOnly: true },
      {
        claimName,
        subPath: `${subPath}/plugin-runtime`,
        mountPath: pluginRuntimeMountPath,
        readOnly: true,
      },
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
      {
        claimName,
        subPath: `${subPath}/openclaw-home`,
        mountPath: openclawHomeMountPath,
        readOnly: false,
      },
      {
        claimName,
        subPath: `${bridgedWorkspaceSubPath}/.codex`,
        mountPath: "/home/node/.codex",
        readOnly: false,
      },
    ],
  };
}

function protobufValue(value) {
  if (value.structValue !== undefined) {
    return Object.fromEntries(
      Object.entries(value.structValue.fields).map(([name, entry]) => [name, protobufValue(entry)]),
    );
  }
  if (value.listValue !== undefined) {
    return value.listValue.values.map(protobufValue);
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.numberValue !== undefined) {
    return value.numberValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.nullValue !== undefined) {
    return null;
  }
  assert.fail("OpenShell driver_config contains an unsupported protobuf Struct value.");
}

function removeStockUnsupportedTokenProjection(request, requirements) {
  const compatible = structuredClone(request);
  const kubernetes = compatible.spec.template.driver_config.fields.kubernetes.structValue.fields;
  const volumes = kubernetes.volumes.listValue.values;
  const volumeIndex = volumes.findIndex(
    (volume) => volume.structValue.fields.name.stringValue === "openclaw-service-principal",
  );
  assert.notEqual(volumeIndex, -1, "production OpenShell request must include the Agent token.");
  assert.deepEqual(protobufValue(volumes[volumeIndex]), {
    name: "openclaw-service-principal",
    projected: {
      sources: [
        {
          service_account_token: {
            audience: requirements.serviceAccountToken.audience,
            expiration_seconds: requirements.serviceAccountToken.expirationSeconds,
            path: requirements.serviceAccountToken.path,
          },
        },
      ],
    },
  });
  volumes.splice(volumeIndex, 1);

  const mounts =
    kubernetes.containers.structValue.fields.agent.structValue.fields.volume_mounts.listValue
      .values;
  const mountIndex = mounts.findIndex(
    (mount) => mount.structValue.fields.name.stringValue === "openclaw-service-principal",
  );
  assert.notEqual(mountIndex, -1, "production OpenShell request must mount the Agent token.");
  assert.deepEqual(protobufValue(mounts[mountIndex]), {
    name: "openclaw-service-principal",
    mount_path: requirements.serviceAccountToken.mountPath,
    read_only: true,
  });
  mounts.splice(mountIndex, 1);
  return compatible;
}

function integrationGatewayClient(
  GrpcOpenShellGatewayClient,
  endpoint,
  context,
  { enableCompatibilityBridge, observeServiceUrl },
) {
  const gateway = new GrpcOpenShellGatewayClient({ endpoint });
  return {
    health(signal) {
      return gateway.health(signal);
    },
    getWorkspace(name, signal) {
      return gateway.getWorkspace(name, signal);
    },
    createWorkspace(name, labels, signal) {
      return gateway.createWorkspace(name, labels, signal);
    },
    deleteWorkspace(name, signal) {
      return gateway.deleteWorkspace(name, signal);
    },
    async createSandbox(request, signal) {
      const compatible = enableCompatibilityBridge
        ? removeStockUnsupportedTokenProjection(request, context.requirements)
        : request;
      const created = await gateway.createSandbox(compatible, signal);
      observeServiceUrl(created.serviceUrls[""]);
      return created;
    },
    deleteSandbox(request, signal) {
      return gateway.deleteSandbox(request, signal);
    },
    close() {
      gateway.close();
    },
  };
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

function assertBridgedWorkspaceMounts(pod) {
  const container = bridgedHarnessContainer(pod);
  const workspaceVolumes = new Set(
    (pod.spec.volumes ?? [])
      .filter(({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName)
      .map(({ name }) => name),
  );
  const mounts = (container.volumeMounts ?? [])
    .filter(({ name }) => workspaceVolumes.has(name))
    .map(({ mountPath, readOnly = false, subPath }) => ({ mountPath, readOnly, subPath }));
  for (const expected of requiredWorkspaceMounts) {
    assert.equal(
      mounts.some(
        ({ mountPath, readOnly, subPath }) =>
          mountPath === expected.mountPath &&
          readOnly === expected.readOnly &&
          subPath === expected.subPath,
      ),
      true,
      `the bridged Harness requires its ${expected.subPath} workspace mount.`,
    );
  }
  assert.equal(
    mounts.some(({ subPath, mountPath }) => subPath === "" || mountPath === "/"),
    false,
    "the Harness must never mount the PVC root.",
  );
  for (const expected of [credentialMountPath, pluginRuntimeMountPath]) {
    assert.equal(
      mounts.some(({ mountPath, readOnly }) => mountPath === expected && readOnly === true),
      true,
      `the stock OpenShell bridge requires a read-only ${expected} mount.`,
    );
  }
  assert.equal(
    mounts.some(
      ({ mountPath, readOnly, subPath }) =>
        mountPath === runtimeAssetsMountPath &&
        readOnly === false &&
        subPath.startsWith(".openclaw/openshell-bootstrap/") &&
        subPath.endsWith("/runtime-assets"),
    ),
    true,
    "the stock OpenShell bridge requires revision-scoped writable runtime assets.",
  );
  assert.equal(
    mounts.some(
      ({ mountPath, readOnly, subPath }) =>
        mountPath === nodeStateMountPath &&
        readOnly === false &&
        subPath.startsWith(".openclaw/openshell-bootstrap/") &&
        subPath.endsWith("/node-state"),
    ),
    true,
    "the stock OpenShell bridge requires revision-scoped writable node state.",
  );
  assert.equal(
    mounts.some(
      ({ mountPath, readOnly, subPath }) =>
        mountPath === openclawHomeMountPath &&
        readOnly === false &&
        subPath.startsWith(".openclaw/openshell-bootstrap/") &&
        subPath.endsWith("/openclaw-home"),
    ),
    true,
    "the stock OpenShell bridge requires a revision-scoped writable native state root.",
  );
  assert.equal(
    mounts.some(
      ({ mountPath, readOnly, subPath }) =>
        mountPath === "/home/node/.codex" &&
        readOnly === false &&
        subPath === `${bridgedWorkspaceSubPath}/.codex`,
    ),
    true,
    "the stock OpenShell bridge requires a writable Codex home alias.",
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
  { enableCompatibilityBridges },
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
      await installOpenShellGateway(namespaceName, { sandboxServiceAccountName });
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
      configureAgent(configuration) {
        // Configuration admission performs no gateway I/O.
        return new OpenShellSandboxDriver(selection.configuration, {
          id: selection.id,
          implementation: "openshell",
          backend: backendFor(undefined),
        }).configureAgent(configuration);
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
            const endpoint = await endpointForNamespace(context, {
              sandboxServiceAccountName: context.requirements.serviceAccountName,
            });
            // The stock proof hands the real Driver exactly what Compute rendered so unsupported
            // projection shapes fail closed before OpenShell creates provider resources.
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
          if (previousBridge !== undefined) {
            await deleteCredentialJob(operatorKubernetes, context, previousBridge.metadata.name);
            await waitForCredentialJobDeletion(
              operatorKubernetes,
              context,
              previousBridge.metadata.name,
            );
          }
          credentialBridges.set(context.revision.id, bridge);
          await applyCredentialJob(operatorKubernetes, bridge);
          await waitForCredentialJob(
            operatorKubernetes,
            context,
            bridge.metadata.name,
            context.namespace.name,
          );
          const requirements = bridgeRequirements(context, claimName, subPath);
          const endpoint = await endpointForNamespace(context, {
            sandboxServiceAccountName: requirements.serviceAccountName,
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
          }
          provisioningFailures.set(context.revision.id, error);
          if (bridge !== undefined) {
            await deleteCredentialJob(operatorKubernetes, context, bridge.metadata.name).catch(
              () => undefined,
            );
          }
          throw error;
        }
      },
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
                  "chmod -R u+w /bootstrap/plugin-runtime /bootstrap/service-principal",
                  "rm -f /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem",
                  "rm -rf /bootstrap/plugin-runtime /bootstrap/service-principal /bootstrap/node-state /bootstrap/runtime-assets /bootstrap/openclaw-home",
                ].join("\n"),
              ];
              container.volumeMounts = container.volumeMounts.filter(
                ({ name }) => name === "bootstrap",
              );
              cleaner.spec.template.spec.volumes = cleaner.spec.template.spec.volumes.filter(
                ({ name }) => name === "bootstrap",
              );
              await applyCredentialJob(operatorKubernetes, cleaner);
              await waitForCredentialJob(
                operatorKubernetes,
                context,
                cleaner.metadata.name,
                context.namespace.name,
              );
              await deleteCredentialJob(
                operatorKubernetes,
                context,
                cleaner.metadata.name,
                context.namespace.name,
              );
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
              process.stderr.write(
                `OpenShell first Compute prepareRevision failure: ${error.message}\n`,
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
  { expectUnsupportedProjection = false } = {},
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
  await startWorkspaceGatewayHostRelay(context, workspaceGateway);
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
    { kubernetesGatewayNamespaceName, kubernetesNamespaceName },
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
  configuration.drivers.compute.configuration.gatewayRouting = workspaceGateway.routing;
  configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs =
    workspaceGateway.nativeOptions.gatewayAuth.trustedProxies;
  delete configuration.drivers.compute.configuration.network.gatewayClients;
  configuration.drivers.sandbox.configuration.policy.filesystem.readWrite.push(
    "/home/node/.openclaw-node",
  );
  configuration.drivers.sandbox.configuration.policy.networkPolicies.push({
    name: "workspace-gateway",
    endpoints: [{ host: workspaceGatewayHostname(workspaceGateway), ports: [443], tls: "skip" }],
    binaries: [{ path: "/usr/local/bin/node" }],
  });
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
    { enableCompatibilityBridges: !expectUnsupportedProjection },
  );
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { ...driverEnvironment, OCC_CONFIG_PATH: startupPath },
    createOpenShellBackend: createSandboxDriver.createBackend,
    createSandboxDriver,
  });
  const workerDrivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { ...driverEnvironment, OCC_CONFIG_PATH: workerStartupPath },
    createOpenShellBackend: createSandboxDriver.createBackend,
    createSandboxDriver,
  });
  // A worker retry intentionally exposes only DEPENDENCY_UNAVAILABLE. Preserve the first
  // underlying Compute failure so a real-runtime regression is actionable rather than a timeout.
  const diagnosticWorkerDrivers = {
    ...workerDrivers,
    computeDriver: withFirstPrepareRevisionFailureDiagnostic(workerDrivers.computeDriver),
  };
  assert.equal(drivers.sandboxDriver?.capability, "sandbox");
  assert.equal(drivers.sandboxDriver?.id, configuration.drivers.sandbox.id);
  assert.equal(drivers.credentialGatewayDriver?.capability, "credential_gateway");
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
          ...(gatewayPlacement === undefined ? [] : [gatewayPlacement]),
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
  if (existing !== undefined) {
    assert.equal(existing.name, installationName);
  } else {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: adminCredentials.email,
      password: adminCredentials.password,
      authSecret,
      authBaseURL,
      installationName,
    });
  }

  productionApp = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL,
    drivers,
  });
  const request = await createAuthenticatedControllerRequest(
    productionApp,
    adminCredentials,
    authBaseURL,
  );
  const events = [];
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

  const createdNamespace = await request("POST", "/namespaces", {
    name: `openshell-${randomUUID()}`,
  });
  assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
  const namespaceId = createdNamespace.data.id;
  placement = kubernetesNamespaceName(namespaceId);
  gatewayPlacement = kubernetesGatewayNamespaceName(namespaceId);

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
  // Dedicated Gateways now live in a separate control-plane Namespace. Wait
  // for Compute to claim it, then grant the same exact scoped controller role
  // so reconciliation can prepare both sides of the supported topology.
  await waitFor(`worker gateway namespace creation for ${gatewayPlacement}`, async () => {
    try {
      return await resource("namespace", gatewayPlacement);
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
    gatewayPlacement,
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
  // Agent-owned model credentials follow the control-plane Gateway namespace;
  // the API identity must not receive Secret authority in the Harness namespace.
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

  const agentConfiguration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: nativeCodexConfiguration(workspaceGateway.nativeOptions.gatewayAuth),
  });
  assert.equal(agentConfiguration.status, 201, JSON.stringify(agentConfiguration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `openshell-${randomUUID()}`,
    configurationId: agentConfiguration.data.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.data.id },
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
  const deployed = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  assert.equal(deployed.data.harness.mode, "dedicated");
  assert.equal(
    deployed.data.configuration.plugins.entries.codex.config.appServer.sandbox,
    "danger-full-access",
    "OCC must freeze OpenShell-selected Codex revisions with the inner sandbox disabled.",
  );

  assert.deepEqual(deployed.data.harnessAuth, agent.data.harnessAuth);
  if (expectUnsupportedProjection) {
    const failure = await waitFor("stock OpenShell to explicitly reject Secret projection", () =>
      createSandboxDriver.provisioningFailures.get(deployed.data.id),
    );
    // The model key no longer needs projection; the app-server token is the first remaining
    // stock OpenShell blocker.
    assert.match(
      failure.message,
      /cannot receive secretKeyRef environment APP_SERVER_TOKEN; upstream Secret projection support is required/,
    );
    await waitFor("failed Sandbox provisioning worker observation", () =>
      events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === deployed.data.id &&
          event.outcome !== "success",
      ),
    );
    const observed = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(observed.status, 200);
    assert.notEqual(observed.data.activeRevisionId, deployed.data.id);
    assert.equal((await resources("sandboxes.agents.x-k8s.io", placement)).length, 0);
    assert.equal(
      (await resources("pods", placement)).some(
        (pod) => pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent",
      ),
      false,
    );
    for (const pod of await resources("pods", gatewayPlacement)) {
      if (pod.metadata.labels?.["openclaw.dev/workload-role"] !== "gateway") {
        continue;
      }
      assert.equal(
        pod.spec.containers.some((container) =>
          (container.env ?? []).some(({ name }) => name === "OPENAI_API_KEY"),
        ),
        false,
      );
    }
    await assertNoSecretBytes(placement, [process.env.OPENAI_API_KEY, transport.appServerToken]);
    return { request, namespaceId, agent: agent.data };
  }

  await waitFor(`OpenShell revision ${deployed.data.id} activation`, async () => {
    const observed = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    return observed.data.activeRevisionId === deployed.data.id ? observed.data : undefined;
  });
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
  assertBridgedWorkspaceMounts(harnessPod);
  await assertBridgedServicePrincipalToken(
    placement,
    harnessPod,
    configuration.drivers.compute.configuration.servicePrincipalCredentials,
  );
  assertApprovedOpenShellPrivileges(harnessPod, { compatibilityBridge: true });
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
  const agentService = await resource("service", agentServiceName, placement);
  assert.deepEqual(agentService.spec.selector, {
    "openclaw.dev/agent": agent.data.id,
    "openclaw.dev/namespace": namespaceId,
    "openclaw.dev/revision": deployed.data.id,
    "openclaw.dev/workload-role": "agent",
  });
  return {
    request,
    placement,
    namespaceId,
    agent: agent.data,
    revision: deployed.data,
    harnessPod,
    sandbox,
    harnessServiceUrl: createSandboxDriver.harnessServiceUrls.get(deployed.data.id),
    appServerToken: transport.appServerToken,
  };
}

async function assertOpenShellToolFilesystemAndNetworkEnforcement(topology) {
  const nonce = `openshell-boundary-${randomUUID()}`;
  const writablePath = `/home/node/workspace/${nonce}.txt`;
  const approvedPath = pluginRuntimeMountPath;
  const readonlyPath = `${approvedPath}/${nonce}.txt`;
  const escapedPath = `/home/node/workspace/../${nonce}-escape.txt`;
  const result = await requestCodexTurnFromOpenShellHarnessPod({
    namespace: topology.placement,
    harnessPod: topology.harnessPod.metadata.name,
    providerModel,
    appServerTokenPath: `${credentialMountPath}/app-server-token`,
    prompt:
      `Use the shell exec tool from /home/node/workspace. Run every numbered command in a ` +
      `separate exec tool invocation, continuing after commands that are expected to fail: ` +
      `(1) printf '${nonce}' > ${writablePath}; ` +
      `(2) test -r ${approvedPath}; ` +
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
    String(command).includes(`test -r ${approvedPath}`),
  );
  const readonlyCommand = completedCommands.find(({ command }) =>
    String(command).includes(readonlyPath),
  );
  const escapedCommand = completedCommands.find(({ command }) =>
    String(command).includes(escapedPath),
  );
  assert.ok(workspaceCommand, "the real Codex Harness must attempt an approved workspace write.");
  assert.ok(approvedPathCommand, "the real Codex Harness must read its approved skills path.");
  assert.ok(readonlyCommand, "the real Codex Harness must attempt writing the read-only mount.");
  assert.ok(escapedCommand, "the real Codex Harness must attempt escaping its workspace.");
  assert.ok(approvedCommand, "the real Codex Harness must execute the approved curl command.");
  assert.ok(deniedCommand, "the real Codex Harness must execute the denied curl command.");
  assert.equal(workspaceCommand.exitCode, 0, "OpenShell must allow approved workspace writes.");
  assert.equal(approvedPathCommand.exitCode, 0, "OpenShell must allow approved skills reads.");
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
  await waitFor(`replacement OpenShell revision ${redeployed.data.id} activation`, async () => {
    const observed = await topology.request(
      "GET",
      `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    return observed.data.activeRevisionId === redeployed.data.id ? observed.data : undefined;
  });
  const activeSandboxName = `os-${hash(redeployed.data.id, 16)}`;
  const retiredSandboxName = `os-${hash(topology.revision.id, 16)}`;
  // The revision becomes active before the worker finishes retiring its predecessor. Observe the
  // provider resources themselves so the assertion stays at the supported lifecycle boundary.
  const expectedActiveSelector = {
    "openclaw.dev/agent": topology.agent.id,
    "openclaw.dev/namespace": topology.namespaceId,
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
        authorization: `Bearer ${appServerToken}`,
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

const secretProjectionMode = process.env.OCC_TEST_OPENSHELL_SECRET_PROJECTION ?? "0";
assert.match(
  secretProjectionMode,
  /^(?:0|1)$/,
  "OCC_TEST_OPENSHELL_SECRET_PROJECTION must be 0 or 1.",
);

test(
  "OpenShell enforces the selected Secret projection contract",
  { ...requiresOpenShellK3d, timeout: 900_000 },
  async (context) => {
    if (secretProjectionMode === "1") {
      process.stderr.write("OpenShell integration: selected positive projection proof.\n");
      const topology = await prepareProductionInstallation(context);
      assert.equal(
        topology.harnessPod.spec.serviceAccountName,
        openShellAgentName(topology.agent.id),
      );
      assert.ok(topology.sandbox.metadata.name);
      process.stderr.write(
        "OpenShell integration: checking create-time service exposure authentication boundary.\n",
      );
      assert.match(topology.harnessServiceUrl, /^https?:\/\//);
      // OpenShell v0.1.0 consumes gateway Authorization and strips it before proxying. An
      // authentication rejection from the protected Codex endpoint proves the route reaches the
      // real app server without weakening its bearer-token requirement or accepting a gateway 5xx.
      let lastServiceObservation = "no response";
      try {
        await waitFor("OpenShell create-time Harness service exposure", async () => {
          try {
            const status = await observeExposedCodexAuthenticationBoundary(
              topology.harnessServiceUrl,
              topology.appServerToken,
            );
            lastServiceObservation = `HTTP ${status}`;
            return [401, 403].includes(status) ? true : undefined;
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
      process.stderr.write(
        "OpenShell integration: create-time route reached protected Harness; starting authenticated real in-Sandbox model turn.\n",
      );
      const nonce = `OCC-OPENSHELL-${randomUUID()}`;
      const modelTurn = await requestCodexTurnFromOpenShellHarnessPod({
        namespace: topology.placement,
        harnessPod: topology.harnessPod.metadata.name,
        providerModel,
        appServerTokenPath: `${credentialMountPath}/app-server-token`,
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
      await assertEmbeddedOpenShellFailsClosed(topology);
      return;
    }

    process.stderr.write("OpenShell integration: selected stock fail-closed projection proof.\n");
    const topology = await prepareProductionInstallation(context, {
      expectUnsupportedProjection: true,
    });
    await assertEmbeddedOpenShellFailsClosed(topology);
  },
);
