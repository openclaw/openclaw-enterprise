import { kubernetesGatewayNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { renderPresetTemplate } from "../../packages/contracts/src/index.ts";
import {
  authenticatedHeaders,
  createAuthenticatedControllerRequest,
  signInWithEmailPassword,
} from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertGatewayModelTurn,
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  kubernetesHash as hash,
} from "../helpers/kubernetes-real.mjs";
import {
  ensureEnvoyGatewayControllers,
  createEnvoyWorkspaceGatewayPlan,
} from "../helpers/envoy-workspace-gateway.mjs";
import {
  assertKubernetesRuntimeOtelSettings,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "../helpers/logging-otel-observation.mjs";

const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const controllerImage = process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? runtimeImage;
const codexImage =
  process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
  process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
  runtimeImage;
const codexSeccompProfile = process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);
const slackSelected = process.env.OCC_TEST_SLACK_LIVE === "1";
const selected =
  !slackSelected &&
  (process.env.OCC_TEST_HARNESS_K3D_REAL === "1" ||
    process.env.OCC_TEST_GATEWAY_ROUTING_REAL === "1" ||
    [runtimeImage, gatewayImage, codexImage].some(Boolean));
const requiresProductionCluster = {
  skip: selected
    ? false
    : "Set an explicit k3d kubeconfig/context, immutable real OpenClaw/Codex runtime image references, a dedicated openclaw_k8s_* PostgreSQL database, and OPENAI_API_KEY for production model-turn proof.",
};
const requiresProductionClusterOtelLogs = {
  skip:
    selected && process.env.OCC_TEST_OTEL_LOGS === "1"
      ? false
      : "Set OCC_TEST_OTEL_LOGS=1 plus the explicit k3d kubeconfig/context, immutable real OpenClaw/Codex runtime image references, dedicated openclaw_k8s_* PostgreSQL database, OPENAI_API_KEY, and an OTLP observation source for production runtime log proof.",
};
const requiresGatewayRouting = {
  skip:
    process.env.OCC_TEST_GATEWAY_ROUTING_REAL === "1"
      ? requiresProductionCluster.skip
      : "Set OCC_TEST_GATEWAY_ROUTING_REAL=1 with Envoy Gateway, cert-manager, and an imported controller image for private routing proof.",
};
const requiresNativeAdminRouting = {
  skip:
    process.env.OCC_TEST_NATIVE_ADMIN_REAL === "1"
      ? requiresGatewayRouting.skip
      : "Set OCC_TEST_NATIVE_ADMIN_REAL=1 with the gateway-routing prerequisites, Playwright Chromium, and a dedicated native-admin Agent domain such as native.localhost.",
};
const requiresLiveSlack = {
  skip: slackSelected
    ? false
    : "Set OCC_TEST_SLACK_LIVE=1 with the production k3d prerequisites, an approved exact Slack proxy, Slack app/bot credentials, a distinct sender bot token, and a shared test channel.",
};
const installationName = "OpenClaw Kubernetes harness topology integration";
const authSecret = "kubernetes-harness-topology-auth-secret-32-bytes";
const authBaseURL = "http://127.0.0.1";
const modelPrefix = "openclaw-agent-model";
const secretRotationProbe = "SECRET_ROTATION_PROBE";
const peerSecretRotationProbe = "SECRET_ROTATION_PEER_PROBE";
const sharedSecretRotationProbe = "SECRET_ROTATION_SHARED_PROBE";
const startupFailurePluginId = "codex-plugin:linear@openai-curated-remote";
const deniedPort = 18791;
const sharedWorkspaceVolumeName = "openclaw-workspace";
const harnessWorkspaceClaimSize = "40Gi";
const harnessWorkspaceSubPaths = Object.freeze(["generated-images", "workspace"]);
const executeFile = promisify(execFile);
const {
  kubectl,
  kubectlArguments,
  applyManifest,
  resource,
  resources,
  createControllerIdentity,
  waitFor,
  validatePrerequisites: validateKubernetesPrerequisites,
  provisionAgentTransportSecret,
  startPortForward,
  startPortForwardTarget,
} = createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
});

async function slackApi(method, token, body = {}) {
  const writesMessage = method === "chat.postMessage";
  const url = new URL(`https://slack.com/api/${method}`);
  if (!writesMessage) {
    for (const [key, value] of Object.entries(body)) {
      url.searchParams.set(key, String(value));
    }
  }
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, {
        method: writesMessage ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(writesMessage ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(writesMessage ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const transient =
        error?.name === "TimeoutError" ||
        error?.message === "fetch failed" ||
        ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
          error?.cause?.code ?? error?.code,
        );
      if (writesMessage || attempt === 2 || !transient) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
      continue;
    }
    if (writesMessage || attempt === 2 || (response.status !== 429 && response.status < 500)) {
      break;
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryDelay =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1_000, 5_000)
        : 250 * 2 ** attempt;
    await delay(retryDelay);
  }
  assert.equal(response.status, 200, `Slack ${method} returned HTTP ${response.status}.`);
  const result = await response.json();
  assert.equal(result.ok, true, `Slack ${method} failed: ${result.error ?? "unknown_error"}.`);
  return result;
}

async function validatePrerequisites() {
  assert.ok(
    process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY is required: an actual production provider turn cannot be mocked or skipped.",
  );
  if (process.env.OCC_TEST_GATEWAY_ROUTING_REAL === "1") {
    assert.match(
      controllerImage ?? "",
      /^\S+@sha256:[a-f0-9]{64}$/i,
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE must select the imported controller image for routing proof.",
    );
  }
  const kubeconfig = await validateKubernetesPrerequisites();
  return kubeconfig;
}

async function createAuthenticatedControllerUrlRequest(origin, credentials, requestOrigin) {
  const session = await signInWithEmailPassword({
    origin,
    email: credentials.email,
    password: credentials.password,
  });
  return async (method, pathname, payload) => {
    const response = await fetch(new URL(pathname, origin), {
      method,
      headers: {
        ...authenticatedHeaders(session),
        origin: requestOrigin,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.text();
    return { status: response.status, ...(body.length === 0 ? {} : JSON.parse(body)) };
  };
}

async function attachPostgresToK3d(context) {
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  const containerBin = process.env.OCC_DOCKER_BIN ?? "docker";
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OCC");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const cluster = state.resources?.find(
    ({ kind, status }) => kind === "k3d-cluster" && status === "ready",
  );
  const postgres = state.resources?.find(
    ({ kind, status }) => kind === "compose-postgres" && status === "ready",
  );
  assert.ok(cluster?.name, "prepared state must identify the owned k3d cluster");
  assert.ok(postgres?.name, "prepared state must identify the owned PostgreSQL service");
  const { stdout: containerOutput } = await executeFile(containerBin, [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${postgres.name}`,
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--format",
    "{{.Names}}",
  ]);
  const containers = containerOutput.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(containers.length, 1, "prepared PostgreSQL must have exactly one container");
  const postgresContainer = containers[0];
  const serverContainer = `k3d-${cluster.name}-server-0`;
  const { stdout: serverNetworksOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    serverContainer,
  ]);
  const serverNetworks = JSON.parse(serverNetworksOutput);
  const network = Object.keys(serverNetworks).find((name) =>
    name.startsWith(`k3d-${cluster.name}`),
  );
  assert.ok(network, "owned k3d server network must be inspectable");
  const { stdout: postgresNetworksOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    postgresContainer,
  ]);
  const alreadyAttached = Object.hasOwn(JSON.parse(postgresNetworksOutput), network);
  if (!alreadyAttached) {
    await executeFile(containerBin, ["network", "connect", network, postgresContainer]);
  }
  context.after(async () => {
    if (!alreadyAttached) {
      await executeFile(containerBin, [
        "network",
        "disconnect",
        "--force",
        network,
        postgresContainer,
      ]).catch(() => undefined);
    }
  });
  const { stdout: attachedOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
    postgresContainer,
  ]);
  const address = attachedOutput.trim();
  assert.equal(isIP(address), 4, "PostgreSQL must have an IPv4 address on the k3d network");
  return address;
}

async function createScopedController(context, identifier, platformNamespace, kubeconfig) {
  const suffix = hash(identifier);
  const account = "openclaw-production-controller";
  const namespaceRole = `oce-production-namespaces-${suffix}`;
  const tenantRole = `oce-production-tenant-${suffix}`;
  const binding = `oce-production-controller-${suffix}`;
  const apiBinding = `oce-production-secret-api-${suffix}`;
  const apiNamespaceRole = `oce-production-secret-namespaces-${suffix}`;
  const apiSecretRole = `oce-production-secrets-${suffix}`;
  const apiConfigurationRole = `oce-production-configurations-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-production-controller-"));
  context.after(async () => {
    await kubectl("delete", "clusterrolebinding", binding, apiBinding, "--ignore-not-found=true");
    await kubectl(
      "delete",
      "clusterrole",
      namespaceRole,
      tenantRole,
      apiNamespaceRole,
      apiSecretRole,
      apiConfigurationRole,
      "--ignore-not-found=true",
    );
    await rm(directory, { recursive: true, force: true });
  });

  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
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
      // Match Helm: Compute reads admitted source keys and persists Gateway
      // projections only inside the namespaces that bind this role.
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "create", "update", "delete"],
        },
      },
      {
        op: "add",
        path: "/rules/-",
        value: { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
      },
      {
        op: "add",
        path: "/rules/-",
        value: { apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] },
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
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: ["gateway.networking.k8s.io"],
          resources: ["httproutes"],
          verbs: ["get", "create", "patch", "delete"],
        },
      },
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: ["gateway.envoyproxy.io"],
          resources: ["securitypolicies"],
          verbs: ["get", "create", "patch", "delete"],
        },
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
    context: `scoped-production-${suffix}`,
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
    "--verb=get,create,update,patch,delete",
    "--resource=secrets",
  );
  await kubectl(
    "create",
    "clusterrole",
    apiConfigurationRole,
    "--verb=get,list,create,update,patch,delete",
    "--resource=configmaps",
  );
  const apiIdentity = await createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account: "openclaw-production-secret-api",
    clusterRole: apiNamespaceRole,
    clusterRoleBinding: apiBinding,
    context: `scoped-secret-api-${suffix}`,
  });
  return {
    ...identity,
    tenantRole,
    apiSecretRole,
    apiConfigurationRole,
    apiAccount: apiIdentity.account,
    apiAuthentication: apiIdentity.authentication,
  };
}

async function startInClusterControllers(
  context,
  {
    apiConfiguration,
    authBaseURL,
    controller,
    controllerPort,
    events,
    nativeAdminDomain,
    nativeAdminSharedCookieDomain,
    platformNamespace,
    workspaceGateway,
  },
) {
  const databaseAddress = await attachPostgresToK3d(context);
  const databaseServiceName = "occ-test-postgres";
  const inClusterDatabaseUrl = new URL(databaseUrl);
  inClusterDatabaseUrl.hostname = `${databaseServiceName}.${platformNamespace}.svc`;
  inClusterDatabaseUrl.port = "5432";
  const kubernetesEndpoint = await resource("endpoints", "kubernetes", "default");
  const kubernetesAddress = kubernetesEndpoint.subsets?.[0]?.addresses?.[0]?.ip;
  const kubernetesPort = kubernetesEndpoint.subsets?.[0]?.ports?.[0]?.port;
  assert.equal(isIP(kubernetesAddress), 4, "Kubernetes API endpoint must expose IPv4");
  assert.equal(Number.isInteger(kubernetesPort), true, "Kubernetes API endpoint port is required");
  const name = "openclaw-enterprise-api";
  const labels = workspaceGateway.apiPodLabels;
  const configurationSecret = `${name}-installation`;
  const databaseSecret = `${name}-database`;
  const authSecretName = `${name}-auth`;
  const probeConfigMap = `${name}-gateway-probe`;
  const probeSource = await readFile("tests/fixtures/gateway-routing/probe.mjs", "utf8");
  const manifests = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: probeConfigMap, namespace: platformNamespace },
        data: { "gateway-probe.mjs": probeSource },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: configurationSecret, namespace: platformNamespace },
        stringData: { "installation.yaml": JSON.stringify(apiConfiguration) },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: databaseSecret, namespace: platformNamespace },
        stringData: { url: inClusterDatabaseUrl.toString() },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: authSecretName, namespace: platformNamespace },
        stringData: { secret: authSecret },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: databaseServiceName, namespace: platformNamespace },
        spec: { ports: [{ name: "postgres", port: 5432, targetPort: 5432 }] },
      },
      {
        apiVersion: "v1",
        kind: "Endpoints",
        metadata: { name: databaseServiceName, namespace: platformNamespace },
        subsets: [
          { addresses: [{ ip: databaseAddress }], ports: [{ name: "postgres", port: 5432 }] },
        ],
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace: platformNamespace },
        spec: { selector: labels, ports: [{ name: "http", port: 8080, targetPort: "http" }] },
      },
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name, namespace: platformNamespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              serviceAccountName: controller.apiAccount,
              automountServiceAccountToken: true,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [
                {
                  name: "api",
                  image: controllerImage,
                  imagePullPolicy: "IfNotPresent",
                  args: ["apps/controller/src/server.mjs"],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                    readOnlyRootFilesystem: true,
                  },
                  resources: {
                    requests: { cpu: "100m", memory: "128Mi" },
                    limits: { cpu: "1", memory: "1Gi" },
                  },
                  env: [
                    { name: "NODE_ENV", value: "production" },
                    {
                      name: "OCC_CONFIG_PATH",
                      value: "/etc/openclaw/installation/installation.yaml",
                    },
                    {
                      name: "OCC_DATABASE_URL",
                      valueFrom: { secretKeyRef: { name: databaseSecret, key: "url" } },
                    },
                    {
                      name: "OCC_AUTH_SECRET",
                      valueFrom: { secretKeyRef: { name: authSecretName, key: "secret" } },
                    },
                    { name: "OCC_AUTH_BASE_URL", value: authBaseURL },
                    {
                      name: "OCC_AGENT_NATIVE_ADMIN_ENABLED",
                      value: nativeAdminDomain === undefined ? "false" : "true",
                    },
                    ...(nativeAdminDomain === undefined
                      ? []
                      : [
                          { name: "OCC_AGENT_NATIVE_ADMIN_DOMAIN", value: nativeAdminDomain },
                          ...(nativeAdminSharedCookieDomain === undefined
                            ? []
                            : [
                                {
                                  name: "OCC_AUTH_COOKIE_DOMAIN",
                                  value: nativeAdminSharedCookieDomain,
                                },
                              ]),
                        ]),
                    {
                      name: "OCC_HOST",
                      valueFrom: { fieldRef: { fieldPath: "status.podIP" } },
                    },
                    { name: "OCC_PORT", value: "8080" },
                    {
                      name: "OCC_GATEWAY_API_KEY_PATH",
                      value: "/etc/openclaw/gateway-api-key/key",
                    },
                    { name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/gateway-ca/ca.crt" },
                  ],
                  volumeMounts: [
                    {
                      name: "installation",
                      mountPath: "/etc/openclaw/installation",
                      readOnly: true,
                    },
                    {
                      name: "gateway-api-key",
                      mountPath: "/etc/openclaw/gateway-api-key",
                      readOnly: true,
                    },
                    { name: "gateway-ca", mountPath: "/etc/openclaw/gateway-ca", readOnly: true },
                    {
                      name: "gateway-probe",
                      mountPath: "/app/apps/controller/gateway-probe.mjs",
                      subPath: "gateway-probe.mjs",
                      readOnly: true,
                    },
                  ],
                  ports: [{ name: "http", containerPort: 8080 }],
                  readinessProbe: { httpGet: { path: "/readyz", port: "http" } },
                  livenessProbe: { httpGet: { path: "/healthz", port: "http" } },
                },
                {
                  name: "loopback-forwarder",
                  image: controllerImage,
                  imagePullPolicy: "IfNotPresent",
                  command: ["node", "-e"],
                  args: [
                    "const net=require('node:net');const host=process.env.POD_IP;net.createServer(client=>{const upstream=net.connect(8080,host);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.pipe(upstream);upstream.pipe(client)}).listen(18080,'0.0.0.0')",
                  ],
                  env: [{ name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } }],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                    readOnlyRootFilesystem: true,
                  },
                  resources: {
                    requests: { cpu: "10m", memory: "32Mi" },
                    limits: { cpu: "100m", memory: "64Mi" },
                  },
                  ports: [{ name: "local-forward", containerPort: 18080 }],
                },
              ],
              volumes: [
                {
                  name: "installation",
                  secret: {
                    secretName: configurationSecret,
                    items: [{ key: "installation.yaml", path: "installation.yaml" }],
                  },
                },
                {
                  name: "gateway-api-key",
                  secret: {
                    secretName: workspaceGateway.apiKeySecretName,
                    items: [{ key: "occ", path: "key" }],
                  },
                },
                {
                  name: "gateway-ca",
                  secret: {
                    secretName: workspaceGateway.caSecretName,
                    items: [{ key: "tls.crt", path: "ca.crt" }],
                  },
                },
                { name: "gateway-probe", configMap: { name: probeConfigMap } },
              ],
            },
          },
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: `${name}-isolation`, namespace: platformNamespace },
        spec: {
          podSelector: { matchLabels: labels },
          policyTypes: ["Ingress", "Egress"],
          ingress: [],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                  },
                  podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [{ ipBlock: { cidr: `${databaseAddress}/32` } }],
              ports: [{ protocol: "TCP", port: 5432 }],
            },
            {
              to: [{ ipBlock: { cidr: `${kubernetesAddress}/32` } }],
              ports: [{ protocol: "TCP", port: kubernetesPort }],
            },
          ],
        },
      },
    ],
  };
  // Use the production worker entrypoint inside the same network as its private
  // Gateway route, with the worker's own identity and only its required mounts.
  const apiPodSpec = manifests.items.find(({ kind }) => kind === "Deployment").spec.template.spec;
  const apiContainer = apiPodSpec.containers[0];
  const workerName = "openclaw-enterprise-worker";
  const workerLabels = { ...labels, "app.kubernetes.io/component": "worker" };
  const workerVolumes = ["installation", "gateway-api-key", "gateway-ca"];
  manifests.items.push({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: workerName, namespace: platformNamespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: workerLabels },
      template: {
        metadata: { labels: workerLabels },
        spec: {
          serviceAccountName: controller.account,
          automountServiceAccountToken: true,
          securityContext: apiPodSpec.securityContext,
          containers: [
            {
              name: "worker",
              image: controllerImage,
              imagePullPolicy: "IfNotPresent",
              args: ["apps/controller/src/worker.mjs"],
              securityContext: apiContainer.securityContext,
              resources: apiContainer.resources,
              env: [
                ...apiContainer.env.filter(({ name }) =>
                  [
                    "NODE_ENV",
                    "OCC_CONFIG_PATH",
                    "OCC_DATABASE_URL",
                    "OCC_GATEWAY_API_KEY_PATH",
                    "NODE_EXTRA_CA_CERTS",
                  ].includes(name),
                ),
                { name: "OCC_WORKER_READINESS_PATH", value: "/var/run/openclaw/ready" },
                { name: "OCC_WORKER_POLL_INTERVAL_MS", value: "50" },
                { name: "OCC_WORKER_LEASE_DURATION_MS", value: "60000" },
                { name: "OCC_WORKER_MAX_ATTEMPTS", value: "30" },
              ],
              volumeMounts: [
                ...apiContainer.volumeMounts.filter(({ name }) => workerVolumes.includes(name)),
                { name: "worker-readiness", mountPath: "/var/run/openclaw" },
              ],
              readinessProbe: {
                exec: {
                  command: ["node", "scripts/production-healthcheck.mjs", "worker", "ready"],
                },
              },
              livenessProbe: {
                exec: { command: ["node", "scripts/production-healthcheck.mjs", "worker"] },
              },
            },
          ],
          volumes: [
            ...apiPodSpec.volumes.filter(({ name }) => workerVolumes.includes(name)),
            { name: "worker-readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
          ],
        },
      },
    },
  });
  const workerIsolation = structuredClone(
    manifests.items.find(({ kind }) => kind === "NetworkPolicy"),
  );
  workerIsolation.metadata.name = `${workerName}-isolation`;
  workerIsolation.spec.podSelector.matchLabels = workerLabels;
  manifests.items.push(workerIsolation);
  await applyManifest(JSON.stringify(manifests), {
    redactions: [databaseUrl, authSecret, workspaceGateway.apiKey],
  });
  await kubectl(
    "wait",
    "--namespace",
    platformNamespace,
    "--for=condition=Available",
    `deployment/${name}`,
    "--timeout=180s",
  );
  const pods = await resources(
    "pods",
    platformNamespace,
    "-l",
    Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(","),
  );
  assert.equal(pods.length, 1, "in-cluster OCC API Deployment must have one Pod");
  const forwarding = await startPortForwardTarget(
    platformNamespace,
    `pod/${pods[0].metadata.name}`,
    `${controllerPort ?? 0}:18080`,
  );
  context.after(() => forwarding.stop());
  await kubectl(
    "wait",
    "--namespace",
    platformNamespace,
    "--for=condition=Available",
    `deployment/${workerName}`,
    "--timeout=180s",
  );
  const logs = spawn(
    "kubectl",
    kubectlArguments([
      "logs",
      "--namespace",
      platformNamespace,
      `deployment/${workerName}`,
      "--container=worker",
      "--follow=true",
    ]),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let logError;
  let stopping = false;
  logs.once("error", (error) => {
    logError = error;
  });
  const logExit = new Promise((resolve) =>
    logs.once("close", (code) => {
      if (!stopping) {
        logError ??= new Error(`Worker log stream exited unexpectedly (${code}).`);
      }
      resolve();
    }),
  );
  logs.stderr.resume();
  const lines = createInterface({ input: logs.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.service === "occ-worker" && typeof event.event === "string") {
        events.push(event);
      }
    } catch {
      logError ??= new Error("Worker emitted an invalid structured log record.");
    }
  });
  const worker = {
    async stop() {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await kubectl(
          "delete",
          "deployment",
          workerName,
          "--namespace",
          platformNamespace,
          "--ignore-not-found=true",
          "--wait=true",
          "--timeout=120s",
        );
      } finally {
        logs.kill("SIGTERM");
        await logExit;
        lines.close();
      }
      if (logError !== undefined) {
        throw logError;
      }
    },
  };
  context.after(() => worker.stop());
  await once(logs, "spawn");
  return { pod: pods[0], url: forwarding.url, worker };
}

function installationConfiguration(authentication, platformNamespace, slack, options = {}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    codexSeccompProfile,
    cluster: "k3d-production-harness-topology",
  });
  configuration.drivers.secret.configuration.authentication = authentication;
  configuration.drivers.configuration.id = "configuration-kubernetes-production";
  configuration.drivers.compute.id = "compute-kubernetes-production";
  configuration.drivers.plugin = { id: "codex-plugin", configuration: {} };
  // The real Gateway loads its plugins during the first model request.
  configuration.drivers.compute.configuration.resources.gateway.limits.memory = "2Gi";
  const pluginStatusProxyCidrs = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS;
  if (pluginStatusProxyCidrs !== undefined && pluginStatusProxyCidrs.trim().length > 0) {
    configuration.drivers.compute.configuration.network.pluginStatusProxySourceCidrs =
      pluginStatusProxyCidrs
        .split(",")
        .map((cidr) => cidr.trim())
        .filter(Boolean);
  }
  if (options.gatewayTrustedProxyCidrs !== undefined) {
    configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs =
      options.gatewayTrustedProxyCidrs;
  }
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "8",
    "requests.cpu": "2",
    "requests.memory": "2Gi",
    "limits.cpu": "8",
    // Two embedded Agents plus one replacement Gateway may coexist during cutover.
    "limits.memory": "6Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 3_600;
  if (options.gatewayRouting !== undefined) {
    configuration.drivers.compute.configuration.gatewayRouting = options.gatewayRouting;
    delete configuration.drivers.compute.configuration.network.gatewayClients;
  }
  if (slack !== undefined) {
    configuration.drivers.compute.configuration.runtime.channels = {
      proxyUrl: slack.proxyUrl,
    };
  }
  return configuration;
}

function nativeConfiguration(harnessId, slack, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  const provider = harnessId === "codex" ? "codex" : "openai";
  configuration.models.providers[provider].models[0].input = ["text", "image"];
  if (options.controlUi !== undefined) {
    configuration.gateway.controlUi = options.controlUi;
  }
  if (options.gatewayAuth !== undefined) {
    configuration.gateway = {
      ...configuration.gateway,
      auth: options.gatewayAuth.auth,
      ...(options.gatewayAuth.allowRealIpFallback === undefined
        ? {}
        : { allowRealIpFallback: options.gatewayAuth.allowRealIpFallback }),
      trustedProxies: options.gatewayAuth.trustedProxies,
    };
  }
  if (harnessId === "openclaw") {
    const modelEnvName = options.modelEnvName ?? "OPENAI_API_KEY";
    configuration.secrets = {
      providers: {
        model: {
          source: "env",
          allowlist: Array.from(new Set(["OPENAI_API_KEY", modelEnvName])),
        },
      },
    };
    configuration.models.providers.openai.apiKey = {
      source: "env",
      provider: "model",
      id: modelEnvName,
    };
  }
  if (harnessId === "codex" && slack === undefined) {
    // Native Codex file tools require a writable app-server sandbox plus an omitted or wildcard
    // OpenClaw dynamic-tool allowlist; this case explicitly edits AGENTS.md in the workspace.
    const appServer = configuration.plugins.entries.codex.config.appServer;
    appServer.approvalPolicy = "never";
    appServer.sandbox = "workspace-write";
    configuration.tools = {
      allow: ["*"],
      fs: { workspaceOnly: true },
    };
    // Admit the Memory tool owner through the same explicit plugin policy as Codex.
    configuration.plugins.allow.push("memory-core");
    // Exercise remote file indexing without projecting the Harness model key into Gateway.
    configuration.memory = {
      search: {
        enabled: true,
        provider: "none",
        sources: ["memory"],
        store: { vector: { enabled: false } },
      },
    };
  }
  if (slack === undefined) {
    return configuration;
  }

  configuration.plugins.allow.push("slack");
  configuration.plugins.entries.slack = { enabled: true };
  configuration.channels = {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "allowlist",
      allowFrom: [slack.allowedUserId],
      channels: {
        [slack.channelId]: {
          requireMention: true,
          allowBots: "mentions",
          users: [slack.allowedUserId],
          replyToMode: "off",
        },
      },
    },
  };
  return configuration;
}

async function captureCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-4096);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed (${code}): ${stderr}`));
      }
    });
  });
}

function assertNoSecretMaterial(value, secrets, description) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    assert.equal(serialized.includes(secret), false, description);
  }
}

function secretApiProtectedValues(topology, extra = []) {
  return [
    process.env.OPENAI_API_KEY,
    topology.secretApi?.initialProbeValue,
    topology.secretApi?.initialPeerProbeValue,
    topology.secretApi?.initialSharedProbeValue,
    topology.secretApi?.rotatedSharedProbeValue,
    topology.secretApi?.missingBackendValue,
    topology.secretApi?.unboundDeleteValue,
    topology.secretApi?.slackAppValue,
    topology.secretApi?.slackBotValue,
    ...extra,
  ];
}

function secretBinding(source) {
  return { source, delivery: { type: "env" } };
}

function assertSecretMetadata(secret, { namespaceId, name }) {
  assert.equal(secret.namespaceId, namespaceId);
  assert.equal(
    Object.hasOwn(secret, "agentId"),
    false,
    "Secret API responses must not expose an Agent owner",
  );
  assert.equal(secret.name, name);
  assert.deepEqual(secret.ref, { kind: "secret", namespaceId, id: secret.id });
  for (const key of [
    "value",
    "agentId",
    "backendRef",
    "backendName",
    "backendNamespaceName",
    "backendKey",
  ]) {
    assert.equal(Object.hasOwn(secret, key), false, `Secret API responses must omit ${key}`);
  }
}

async function createApiSecret(request, namespaceId, name, value) {
  const response = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name,
    value,
  });
  assertNoSecretMaterial(
    response,
    [value, process.env.OPENAI_API_KEY],
    "Secret create is metadata only",
  );
  assert.equal(
    response.status,
    201,
    `Secret create failed with HTTP ${response.status} (${response.error?.code ?? "unknown"})`,
  );
  assertSecretMetadata(response.data, { namespaceId, name });
  const read = await request("GET", `/namespaces/${namespaceId}/secrets/${response.data.id}`);
  assertNoSecretMaterial(read, [value, process.env.OPENAI_API_KEY], "Secret read is metadata only");
  assert.equal(
    read.status,
    200,
    `Secret read failed with HTTP ${read.status} (${read.error?.code ?? "unknown"})`,
  );
  assert.deepEqual(read.data, response.data);
  return response.data;
}

async function updateApiSecret(request, namespaceId, secret, value) {
  const response = await request("PATCH", `/namespaces/${namespaceId}/secrets/${secret.id}`, {
    value,
  });
  assertNoSecretMaterial(
    response,
    [value, process.env.OPENAI_API_KEY],
    "Secret update is metadata only",
  );
  assert.equal(
    response.status,
    200,
    `Secret update failed with HTTP ${response.status} (${response.error?.code ?? "unknown"})`,
  );
  assert.deepEqual(response.data, secret, "Secret update keeps the stable public ref");
  return response.data;
}

async function expectApiFailureWithoutSecret(request, method, path, body, secrets, description) {
  const response = await request(method, path, body);
  assert.ok(response.status >= 400, `${description} unexpectedly succeeded`);
  assertNoSecretMaterial(response, secrets, `${description} must not leak secret material`);
  return response;
}

async function grantSecretOperate(pool, namespaceId, subjectId, secretId) {
  const roleId = `role-secret-operate-${randomUUID()}`;
  const bindingId = `binding-secret-operate-${randomUUID()}`;
  await pool.query(
    "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
    [
      roleId,
      namespaceId,
      "Secret operate",
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );
  await pool.query(
    `INSERT INTO occ.iam_access_bindings
     (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, $4, 'secret', $5)`,
    [bindingId, namespaceId, subjectId, roleId, secretId],
  );
}

async function createSecretAssignmentCallerRequest({
  pool,
  createPostgresControllerAuth,
  requestFactory,
  installation,
  namespaceId,
  baseURL,
}) {
  const identifier = randomUUID();
  const credentials = {
    email: `secret-assignment-${hash(identifier)}@example.test`,
    password: `secret-assignment-${identifier}`,
  };
  const roleId = `role-secret-assignment-caller-${identifier}`;
  const bindingId = `binding-secret-assignment-caller-${identifier}`;
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    secret: authSecret,
    baseURL,
    pool,
    secureCookies: false,
  });
  const account = await auth.createAccount({
    email: credentials.email,
    password: credentials.password,
    name: "OpenClaw Secret Assignment Caller",
  });
  const seed = auth.principalSeed(account, { roleId });
  const permissions = [
    { action: "read", resourceKind: "namespace" },
    ...["create", "read", "update", "delete"].flatMap((action) => [
      { action, resourceKind: "configuration" },
      { action, resourceKind: "secret" },
    ]),
    ...["create", "read", "update", "deploy", "operate"].map((action) => ({
      action,
      resourceKind: "agent",
    })),
    { action: "read", resourceKind: "agent_revision" },
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [roleId, namespaceId, "Namespace Secret assignment caller", JSON.stringify(permissions)],
    );
    await client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, NULL, NULL, 'principal', $2, $3)`,
      [seed.principal.id, seed.principal.issuer, seed.principal.subject],
    );
    await client.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, NULL, $4, NULL, NULL)`,
      [bindingId, namespaceId, seed.principal.id, roleId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    principalId: seed.principal.id,
    request: await requestFactory(credentials),
  };
}

async function ensureHarnessAdminPrincipal(
  pool,
  createPostgresControllerAuth,
  installation,
  credentials,
  baseURL,
) {
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    secret: authSecret,
    baseURL,
    pool,
    secureCookies: false,
  });
  const existing = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [
    credentials.email.trim().toLowerCase(),
  ]);
  assert.ok(existing.rows.length <= 1, "the harness administrator email must be unique");
  if (existing.rows.length === 1) {
    try {
      await auth.auth.api.signInEmail({
        body: { email: credentials.email, password: credentials.password },
      });
    } catch (error) {
      throw new Error(
        "The configured OPENCLAW_DEV_PASSWORD does not match the persisted k3d administrator account. Run './scripts/k3d reset' before retrying.",
        { cause: error },
      );
    }
  }
  const account =
    existing.rows[0] ??
    (await auth.createAccount({
      email: credentials.email,
      password: credentials.password,
      name: "OpenClaw Harness Administrator",
    }));
  // Prepared k3d databases outlive demo namespaces, so reruns reuse the bootstrap administrator.
  const existingPrincipal = await pool.query(
    `SELECT id
       FROM occ.iam_identities
      WHERE kind = 'principal' AND issuer = $1 AND subject = $2`,
    [auth.issuer, account.id],
  );
  assert.ok(
    existingPrincipal.rows.length <= 1,
    "the harness administrator external identity must be unique",
  );
  if (existingPrincipal.rows.length === 1) {
    return;
  }
  const seed = auth.principalSeed(account);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const role of seed.roles) {
      await client.query(
        `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
         VALUES ($1, NULL, $2, $3::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [role.id, role.name ?? null, JSON.stringify(role.permissions)],
      );
    }
    await client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, NULL, NULL, 'principal', $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [seed.principal.id, seed.principal.issuer, seed.principal.subject],
    );
    for (const binding of seed.bindings) {
      await client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, NULL, $2, NULL, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          binding.id,
          binding.subjectId,
          binding.roleId,
          binding.resourceKind ?? null,
          binding.resourceId ?? null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function storedSecret(pool, namespaceId, secretId) {
  const { rows } = await pool.query(
    `SELECT id, namespace_id, name, driver_id,
            backend_namespace_name, backend_name, backend_key, backend_uid
       FROM occ.secrets
      WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, secretId],
  );
  assert.equal(rows.length, 1, "the Secret metadata must be persisted exactly once");
  const [row] = rows;
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    name: row.name,
    driverId: row.driver_id,
    backendRef: {
      namespaceName: row.backend_namespace_name,
      name: row.backend_name,
      key: row.backend_key,
      uid: row.backend_uid,
    },
  };
}

async function createUndeployedAgent(request, namespaceId, mode, name, secretBindings) {
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: nativeConfiguration(mode === "dedicated" ? "codex" : "openclaw"),
    ...(secretBindings === undefined ? {} : { secretBindings }),
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name,
    configurationId: configuration.data.id,
    executionMode: mode,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  return { configuration: configuration.data, agent: agent.data };
}

async function storedAgent(pool, namespaceId, agentId) {
  const { rows } = await pool.query(
    `SELECT id, namespace_id, service_principal_id, active_revision_id
       FROM occ.agents
      WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, agentId],
  );
  assert.equal(rows.length, 1, "the Agent must be persisted exactly once");
  const [row] = rows;
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    servicePrincipalId: row.service_principal_id,
    activeRevisionId: row.active_revision_id ?? undefined,
  };
}

async function grantGatewayWorkerTarget(target, role, account, platformNamespace) {
  await waitFor(`Gateway runtime namespace ${target}`, async () => {
    try {
      return await resource("namespace", target);
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
    "openclaw-gateway-worker",
    "--namespace",
    target,
    `--clusterrole=${role}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );
}

async function topologyPods(topology) {
  const targets = [...new Set([topology.placement, topology.gatewayPlacement])];
  return (await Promise.all(targets.map((target) => resources("pods", target)))).flat();
}

async function arrangeProductionTopology(context, mode, slack, options = {}) {
  const loggingObservationStartedAt = Date.now();
  const includeSecretProbes = options.secretLifecycle === true;
  if (mode === "dedicated") {
    assert.match(
      controllerImage ?? "",
      /^\S+@sha256:[a-f0-9]{64}$/i,
      "Dedicated storage requires the imported controller image for node enrollment through routing.",
    );
  }
  const kubeconfig = await validatePrerequisites();
  const identifier = randomUUID();
  const credentials =
    options.credentials ??
    Object.freeze({
      email: `admin-kubernetes-${hash(identifier)}@example.test`,
      password: `kubernetes-harness-${identifier}`,
    });
  const bootstrapAuthBaseURL =
    options.controllerPort === undefined
      ? authBaseURL
      : `http://127.0.0.1:${options.controllerPort}`;
  const controllerAuthBaseURL = options.publicOrigin ?? bootstrapAuthBaseURL;
  const gatewayPassword =
    options.gatewayPassword === false ? undefined : randomBytes(32).toString("base64url");
  let inClusterWorker;
  const platformNamespace = `oce-production-${mode}-${hash(identifier)}`;
  await kubectl("create", "namespace", platformNamespace);
  context.after(async () => {
    try {
      await inClusterWorker?.stop();
    } finally {
      await kubectl(
        "delete",
        "namespace",
        platformNamespace,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=120s",
      );
    }
  });
  const controller = await createScopedController(
    context,
    identifier,
    platformNamespace,
    kubeconfig,
  );
  // Shared infrastructure and API credentials exist before any Agent is created.
  // The production Compute Driver alone supplies each Agent's route and endpoint.
  let workspaceGateway;
  if (mode === "dedicated" || options.workspaceGateway === true) {
    const gatewayHelpers = {
      kubectl,
      applyManifest,
      resource,
      resources,
      waitFor,
      startPortForwardTarget,
    };
    await ensureEnvoyGatewayControllers(gatewayHelpers);
    workspaceGateway = await createEnvoyWorkspaceGatewayPlan(
      context,
      { platformNamespace },
      gatewayHelpers,
    );
  }
  const approvedClient = "approved-gateway-client";
  await kubectl(
    "run",
    approvedClient,
    "--namespace",
    platformNamespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    "--labels=app.kubernetes.io/name=approved-gateway-client",
    "--command",
    "--",
    "node",
    "-e",
    `require("node:net").createServer((socket) => socket.end()).listen(${deniedPort}, "0.0.0.0")`,
  );
  await kubectl(
    "wait",
    "--namespace",
    platformNamespace,
    "--for=condition=Ready",
    `pod/${approvedClient}`,
    "--timeout=180s",
  );
  const [
    { default: pg },
    { BOOTSTRAP_DEFAULT_NAMESPACE_NAME, PostgresPlatformState },
    { createPostgresControllerAuth },
    { loadInstallationConfiguration },
    { composeProduction },
    { createControllerWorker },
    { kubernetesNamespaceName },
  ] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/index.ts"),
    import("../../apps/controller/src/auth/index.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
  ]);

  const directory = await mkdtemp(join(tmpdir(), `oce-k3d-production-${mode}-`));
  const startupPath = join(directory, "api-installation.yaml");
  const workerStartupPath = join(directory, "worker-installation.yaml");
  const workerConfiguration = installationConfiguration(
    controller.authentication,
    platformNamespace,
    slack,
    workspaceGateway === undefined
      ? {}
      : {
          gatewayRouting: workspaceGateway.routing,
          gatewayTrustedProxyCidrs: workspaceGateway.nativeOptions.gatewayAuth.trustedProxies,
        },
  );
  const apiConfiguration = structuredClone(workerConfiguration);
  if (workspaceGateway !== undefined) {
    apiConfiguration.drivers.configuration.configuration.authentication = { mode: "inCluster" };
    apiConfiguration.drivers.secret.configuration.authentication = { mode: "inCluster" };
    apiConfiguration.drivers.compute.configuration.authentication = { mode: "inCluster" };
  } else {
    apiConfiguration.drivers.secret.configuration.authentication = controller.apiAuthentication;
  }
  await writeFile(startupPath, JSON.stringify(apiConfiguration), { mode: 0o600 });
  await writeFile(workerStartupPath, JSON.stringify(workerConfiguration), { mode: 0o600 });
  const drivers =
    workspaceGateway === undefined
      ? await loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: startupPath },
        })
      : undefined;
  const workerDrivers =
    workspaceGateway === undefined
      ? await loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: workerStartupPath },
        })
      : undefined;
  const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const platformState = new PostgresPlatformState(observerPool);
  let activeInstallation = await platformState.loadInstallation();
  let workerPool;
  let worker;
  let productionApp;
  let controllerApiPod;
  let placement;
  let gatewayRuntimeNamespace;
  let gatewayPlacement;
  let forwarding;
  context.after(async () => {
    try {
      await forwarding?.stop();
    } finally {
      if (worker !== undefined) {
        await worker.stop();
      } else if (workerPool !== undefined) {
        await workerPool.end();
      }
      if (productionApp !== undefined) {
        await productionApp.close();
      }
      await observerPool.end();
      if (gatewayRuntimeNamespace !== undefined) {
        await kubectl(
          "delete",
          "namespace",
          gatewayRuntimeNamespace,
          "--ignore-not-found=true",
          "--wait=true",
          "--timeout=120s",
        );
      }
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
      await rm(directory, { recursive: true, force: true });
    }
  });

  let createdFreshInstallation = false;
  if (activeInstallation !== undefined) {
    await ensureHarnessAdminPrincipal(
      observerPool,
      createPostgresControllerAuth,
      activeInstallation,
      credentials,
      controllerAuthBaseURL,
    );
    context.diagnostic(`reusing pre-initialized Installation ${activeInstallation.id}`);
  } else {
    // Bootstrap establishes IAM and the initial default Namespace; production API/worker owns deployment.
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL: bootstrapAuthBaseURL,
      installationName,
    });
    activeInstallation = await platformState.loadInstallation();
    assert.ok(activeInstallation, "development bootstrap must persist the Installation");
    await ensureHarnessAdminPrincipal(
      observerPool,
      createPostgresControllerAuth,
      activeInstallation,
      credentials,
      controllerAuthBaseURL,
    );
    createdFreshInstallation = true;
  }

  const events = [];
  let controllerUrl;
  let requestFactory;
  if (workspaceGateway !== undefined) {
    const controllerApi = await startInClusterControllers(context, {
      apiConfiguration,
      authBaseURL: controllerAuthBaseURL,
      controller,
      controllerPort: options.controllerPort,
      events,
      nativeAdminDomain: options.nativeAdmin?.domain,
      nativeAdminSharedCookieDomain: options.nativeAdmin?.sharedCookieDomain,
      platformNamespace,
      workspaceGateway,
    });
    inClusterWorker = controllerApi.worker;
    controllerApiPod = controllerApi.pod;
    controllerUrl = controllerApi.url;
    requestFactory = (requestCredentials) =>
      createAuthenticatedControllerUrlRequest(
        controllerUrl,
        requestCredentials,
        controllerAuthBaseURL,
      );
  } else {
    productionApp = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL: controllerAuthBaseURL,
      drivers,
    });
    requestFactory = (requestCredentials) =>
      createAuthenticatedControllerRequest(productionApp, requestCredentials);
  }
  if (workspaceGateway === undefined && options.controllerPort !== undefined) {
    await productionApp.listen({ host: "127.0.0.1", port: options.controllerPort ?? 0 });
    const address = productionApp.server.address();
    assert.ok(address && typeof address === "object");
    controllerUrl = `http://127.0.0.1:${address.port}`;
  }
  let workspaceRequest;
  if (workspaceGateway !== undefined) {
    const controllerRequest = await requestFactory(credentials);
    workspaceRequest = async (...args) => {
      const response = await controllerRequest(...args);
      assertNoSecretMaterial(
        response,
        [process.env.OPENAI_API_KEY, workspaceGateway.apiKey],
        "workspace-files controller response must not expose credentials",
      );
      return response;
    };
  }
  let adminRequest = await requestFactory(credentials);
  let request = adminRequest;
  let secretAssignmentPrincipalId;
  let namespaceId;
  if (createdFreshInstallation) {
    const namespaces = await adminRequest("GET", "/namespaces");
    assert.equal(namespaces.status, 200, JSON.stringify(namespaces.error));
    const defaultNamespace = namespaces.data.find(
      ({ name }) => name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
    );
    assert.ok(defaultNamespace, "fresh bootstrap must expose the default Namespace");
    namespaceId = defaultNamespace.id;
  } else {
    const createdNamespace = await adminRequest("POST", "/namespaces", {
      name: `production-${mode}-${randomUUID()}`,
    });
    assert.equal(createdNamespace.status, 201);
    namespaceId = createdNamespace.data.id;
  }
  placement = kubernetesNamespaceName(namespaceId);
  gatewayRuntimeNamespace = kubernetesGatewayNamespaceName(namespaceId);
  gatewayPlacement = mode === "dedicated" ? gatewayRuntimeNamespace : placement;
  if (workspaceGateway === undefined) {
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    worker = createControllerWorker({
      mode: "production",
      pool: workerPool,
      drivers: workerDrivers,
      pollIntervalMs: 50,
      leaseDurationMs: 60_000,
      maxAttempts: 30,
      emit: (event) => events.push(event),
    });
    await worker.start();
  }

  // The real production worker must remain pending until an operator grants this exact tenant.
  await waitFor(`the production worker to create tenant namespace ${placement}`, async () => {
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
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-secret-api",
    "--namespace",
    placement,
    `--clusterrole=${controller.apiSecretRole}`,
    `--serviceaccount=${platformNamespace}:${controller.apiAccount}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-configuration-api",
    "--namespace",
    placement,
    `--clusterrole=${controller.apiConfigurationRole}`,
    `--serviceaccount=${platformNamespace}:${controller.apiAccount}`,
  );
  await grantGatewayWorkerTarget(
    gatewayRuntimeNamespace,
    controller.tenantRole,
    controller.account,
    platformNamespace,
  );
  for (const role of [controller.apiSecretRole, controller.apiConfigurationRole]) {
    await kubectl(
      "create",
      "rolebinding",
      `canonical-${role}`,
      "--namespace",
      gatewayRuntimeNamespace,
      `--clusterrole=${role}`,
      `--serviceaccount=${platformNamespace}:${controller.apiAccount}`,
    );
  }
  for (const verb of ["get", "create"]) {
    const secretAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${platformNamespace}:${controller.account}`,
    ).catch(({ stdout }) => stdout);
    assert.equal(
      secretAccess.trim(),
      "yes",
      `worker Secret ${verb} access must match the node enrollment role`,
    );

    const apiAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${platformNamespace}:${controller.apiAccount}`,
    );
    assert.equal(apiAccess.trim(), "yes", `the production API requires Secret ${verb} access`);

    // Independent operator bootstrap credentials remain separate from application identities.
    const operatorAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
    );
    assert.equal(operatorAccess.trim(), "yes", `the external test operator must authorize ${verb}`);
  }

  for (const verb of ["list", "patch"]) {
    const denied = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${platformNamespace}:${controller.account}`,
    ).catch(({ stdout }) => stdout);
    assert.equal(denied.trim(), "no", `node enrollment must not grant Secret ${verb} access`);
  }

  await waitFor(`the production worker to provision tenant ${placement}`, async () => {
    const observation = await request("GET", `/namespaces/${namespaceId}`);
    assert.equal(observation.status, 200);
    return observation.data.status === "ready" ? observation.data : undefined;
  });

  let secretApi;
  {
    const secretAssignmentCaller = await createSecretAssignmentCallerRequest({
      pool: observerPool,
      createPostgresControllerAuth,
      requestFactory,
      installation: activeInstallation,
      namespaceId,
      baseURL: controllerAuthBaseURL,
    });
    request = secretAssignmentCaller.request;
    secretAssignmentPrincipalId = secretAssignmentCaller.principalId;

    // Namespace-scoped Secrets are provisioned once the Namespace is ready, before any Agent exists.
    const modelSecret = await createApiSecret(
      request,
      namespaceId,
      "model-key",
      process.env.OPENAI_API_KEY,
    );
    secretApi = { assignmentPrincipalId: secretAssignmentPrincipalId, model: modelSecret };
    if (slack !== undefined) {
      const slackAppValue = slack.appToken;
      const slackBotValue = slack.botToken;
      const slackAppSecret = await createApiSecret(
        request,
        namespaceId,
        "slack-app-token",
        slackAppValue,
      );
      const slackBotSecret = await createApiSecret(
        request,
        namespaceId,
        "slack-bot-token",
        slackBotValue,
      );
      secretApi = {
        ...secretApi,
        slackApp: slackAppSecret,
        slackBot: slackBotSecret,
        slackAppValue,
        slackBotValue,
      };
    }
    if (includeSecretProbes) {
      const initialProbeValue = `secret-rotation-initial-${randomUUID()}`;
      const probeSecret = await createApiSecret(
        request,
        namespaceId,
        "rotation-probe",
        initialProbeValue,
      );
      const initialPeerProbeValue = `secret-rotation-peer-${randomUUID()}`;
      const peerProbeSecret = await createApiSecret(
        request,
        namespaceId,
        "rotation-peer-probe",
        initialPeerProbeValue,
      );
      const initialSharedProbeValue = `secret-rotation-shared-initial-${randomUUID()}`;
      const sharedProbeSecret = await createApiSecret(
        request,
        namespaceId,
        "rotation-shared-probe",
        initialSharedProbeValue,
      );
      const missingBackendValue = `missing-backend-secret-${randomUUID()}`;
      const missingBackendSecret = await createApiSecret(
        request,
        namespaceId,
        "missing-backend",
        missingBackendValue,
      );
      const unboundDeleteValue = `unbound-delete-${randomUUID()}`;
      const unboundDeleteSecret = await createApiSecret(
        request,
        namespaceId,
        "unbound-delete",
        unboundDeleteValue,
      );
      secretApi = {
        assignmentPrincipalId: secretAssignmentPrincipalId,
        ...secretApi,
        model: modelSecret,
        probe: probeSecret,
        peerProbe: peerProbeSecret,
        sharedProbe: sharedProbeSecret,
        missingBackend: missingBackendSecret,
        unboundDelete: unboundDeleteSecret,
        initialProbeValue,
        initialPeerProbeValue,
        initialSharedProbeValue,
        missingBackendValue,
        unboundDeleteValue,
      };
    }
    if (options.bindingNegativeControl !== false) {
      const ungranted = await createUndeployedAgent(
        request,
        namespaceId,
        mode,
        `ungranted-model-${randomUUID()}`,
      );
      const actorDenied = await expectApiFailureWithoutSecret(
        request,
        "PATCH",
        `/namespaces/${namespaceId}/agents/${ungranted.agent.id}`,
        {
          configurationId: ungranted.agent.configurationId,
          harnessAuth: { method: "api_key", source: modelSecret.ref },
        },
        [process.env.OPENAI_API_KEY],
        "Harness auth assignment without exact actor Secret operate",
      );
      assert.equal(actorDenied.status, 403);
    }
    await Promise.all(
      [
        secretApi.model,
        secretApi.slackApp,
        secretApi.slackBot,
        secretApi.probe,
        secretApi.peerProbe,
        secretApi.sharedProbe,
        secretApi.missingBackend,
        secretApi.unboundDelete,
      ]
        .filter(Boolean)
        .map((secret) =>
          grantSecretOperate(observerPool, namespaceId, secretAssignmentPrincipalId, secret.id),
        ),
    );
  }

  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const secretBindings = {
    ...(includeSecretProbes
      ? {
          [secretRotationProbe]: secretBinding(secretApi.probe.ref),
          [sharedSecretRotationProbe]: secretBinding(secretApi.sharedProbe.ref),
        }
      : {}),
    ...(slack === undefined
      ? {}
      : {
          SLACK_APP_TOKEN: secretBinding(secretApi.slackApp.ref),
          SLACK_BOT_TOKEN: secretBinding(secretApi.slackBot.ref),
        }),
  };
  const selectedNativeOptions =
    workspaceGateway === undefined
      ? options.nativeOptions
      : { ...options.nativeOptions, ...workspaceGateway.nativeOptions };
  if (gatewayPassword !== undefined) {
    assert.ok(
      selectedNativeOptions?.gatewayAuth,
      "gateway password requires explicit native gateway authentication",
    );
  }
  const nativeOptions =
    gatewayPassword === undefined
      ? selectedNativeOptions
      : {
          ...selectedNativeOptions,
          gatewayAuth: {
            ...selectedNativeOptions.gatewayAuth,
            auth: {
              ...selectedNativeOptions.gatewayAuth.auth,
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
        };
  // Exercise Preset selection through the same creation APIs as the console. The
  // scoped caller still needs its own Secret grants; the template grants nothing.
  const launchValues = nativeConfiguration(harnessId, slack, nativeOptions);
  const templateValues = structuredClone(launchValues);
  const modelReference = templateValues.agents.defaults.model;
  templateValues.agents.defaults.model = "{{ vars.model }}";
  templateValues.agents.defaults.models = {
    "{{ vars.model }}": templateValues.agents.defaults.models[modelReference],
  };
  const presetsPath = `/namespaces/${namespaceId}/presets`;
  const preset = await adminRequest("POST", presetsPath, {
    name: `production-${mode}-${randomUUID()}`,
    template: {
      variables: {
        name: { type: "string" },
        model: { type: "string", default: modelReference },
        secretId: { type: "string" },
      },
      agent: {
        name: "{{ vars.name }}",
        executionMode: mode,
        harnessAuth: {
          method: "api_key",
          source: { ...secretApi.model.ref, id: "{{ vars.secretId }}" },
        },
      },
      configuration: {
        values: templateValues,
        ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.error));
  const presetPath = `${presetsPath}/${preset.data.id}`;
  const selectedPreset = await adminRequest("GET", presetPath);
  assert.equal(selectedPreset.status, 200, JSON.stringify(selectedPreset.error));
  const launch = renderPresetTemplate(selectedPreset.data.template, {
    name: `production-${mode}-${randomUUID()}`,
    secretId: secretApi.model.ref.id,
  });
  assert.deepEqual(launch.configuration.values, launchValues);
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    ...launch.configuration,
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  if (Object.keys(secretBindings).length > 0) {
    assert.deepEqual(configuration.data.secretBindings, secretBindings);
  }
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    ...launch.agent,
    configurationId: configuration.data.id,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  assert.deepEqual(agent.data.harnessAuth, { method: "api_key", source: secretApi.model.ref });
  const changedPreset = await adminRequest("PATCH", presetPath, { template: {} });
  assert.equal(changedPreset.status, 200, JSON.stringify(changedPreset.error));
  const deletedPreset = await adminRequest("DELETE", presetPath);
  assert.equal(deletedPreset.status, 204, JSON.stringify(deletedPreset.error));
  const independentConfiguration = await request(
    "GET",
    `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
  );
  assert.equal(independentConfiguration.status, 200);
  assert.deepEqual(independentConfiguration.data.values, launchValues);
  const persistedAgent = await storedAgent(observerPool, namespaceId, agent.data.id);
  const provisionedGatewayPassword = await provisionAgentTransportSecret(
    directory,
    placement,
    agent.data.id,
    {
      gatewayPassword,
      executionMode: mode,
    },
  );
  assert.equal(provisionedGatewayPassword, gatewayPassword);
  {
    const revisionsBefore = await request(
      "GET",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions`,
    );
    assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
    const deniedDeploy = await expectApiFailureWithoutSecret(
      request,
      "POST",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
      undefined,
      secretApiProtectedValues({ secretApi }),
      "Secret-backed deploy before Agent service principal operate",
    );
    assert.equal(
      deniedDeploy.status,
      403,
      `Agent service principal denial returned HTTP ${deniedDeploy.status}`,
    );
    const revisionsAfter = await request(
      "GET",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions`,
    );
    assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
    assert.deepEqual(
      revisionsAfter.data.map(({ id }) => id),
      revisionsBefore.data.map(({ id }) => id),
      "missing Agent service-principal Secret operate must reject deployment before revision admission",
    );
    await Promise.all(
      [
        secretApi.model,
        secretApi.slackApp,
        secretApi.slackBot,
        secretApi.probe,
        secretApi.sharedProbe,
      ]
        .filter(Boolean)
        .map((secret) =>
          grantSecretOperate(
            observerPool,
            namespaceId,
            persistedAgent.servicePrincipalId,
            secret.id,
          ),
        ),
    );
    secretApi = {
      ...secretApi,
      configuration: configuration.data,
    };
  }

  const deployed = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  assert.deepEqual(deployed.data.harness, { id: harnessId, version: "1.0.0", mode });
  assert.deepEqual(deployed.data.harnessAuth, agent.data.harnessAuth);
  assert.equal(Object.hasOwn(deployed.data, "serviceAccount"), false);
  for (const [description, response] of [
    ["Agent", agent],
    ["AgentRevision", deployed],
  ]) {
    assert.equal(
      JSON.stringify(response).includes(process.env.OPENAI_API_KEY),
      false,
      `the production ${description} response must never contain provider credential bytes`,
    );
  }

  await waitFor(`production ${mode} AgentRevision ${deployed.data.id} activation`, async () => {
    const observation = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === deployed.data.id ? observation.data : undefined;
  });
  await waitFor(`production worker completion of ${deployed.data.id}`, () =>
    events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === deployed.data.id &&
        event.outcome === "success",
    ),
  );
  const observedRevision = await request(
    "GET",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions/${deployed.data.id}`,
  );
  assert.equal(observedRevision.status, 200, JSON.stringify(observedRevision.error));
  assert.deepEqual(observedRevision.data.harnessAuth, deployed.data.harnessAuth);
  if (secretApi !== undefined && secretApi.configuration.secretBindings !== undefined) {
    assert.deepEqual(observedRevision.data.secretBindings, secretApi.configuration.secretBindings);
  }
  assert.equal(
    JSON.stringify(events).includes(process.env.OPENAI_API_KEY),
    false,
    "production worker evidence must never contain provider credential bytes",
  );
  assert.equal(
    JSON.stringify(await resources("configmaps", placement)).includes(process.env.OPENAI_API_KEY),
    false,
    "production ConfigMaps must never contain provider credential bytes",
  );

  const gatewayServiceName = `gateway-${hash(agent.data.id)}`;
  const agentServiceName = `agent-${hash(agent.data.id)}`;
  const workloadAccounts =
    mode === "dedicated" ? [gatewayServiceName, agentServiceName] : [agentServiceName];
  for (const accountName of workloadAccounts) {
    const accountNamespace =
      accountName === gatewayServiceName && mode === "dedicated" ? gatewayPlacement : placement;
    const workloadSecretAccess = await kubectl(
      "auth",
      "can-i",
      "get",
      "secrets",
      "--namespace",
      accountNamespace,
      `--as=system:serviceaccount:${accountNamespace}:${accountName}`,
    ).catch(({ stdout }) => stdout);
    assert.equal(
      workloadSecretAccess.trim(),
      "no",
      "workload identity must not acquire Kubernetes Secret API access",
    );
  }
  const pods = await waitFor(`production ${mode} workload Pods`, async () => {
    const running = (await topologyPods({ placement, gatewayPlacement })).filter((pod) =>
      pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return running.length === (mode === "dedicated" ? 2 : 1) ? running : undefined;
  });
  const gatewayPod = pods.find(
    ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
  );
  assert.ok(gatewayPod, "production execution must start the exact Agent-owned real gateway");
  const harnessPod = pods.find(
    ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "agent",
  );
  const modelStorage = await storedSecret(observerPool, namespaceId, secretApi.model.id);
  await assertModelRuntimeProjection(harnessPod ?? gatewayPod, modelStorage);
  if (mode === "dedicated") {
    assert.equal(
      gatewayPod.spec.containers.some((container) =>
        (container.env ?? []).some(({ name }) => name === "OPENAI_API_KEY"),
      ),
      false,
    );
  }
  if (slack !== undefined) {
    const slackAppStorage = await storedSecret(observerPool, namespaceId, secretApi.slackApp.id);
    const slackBotStorage = await storedSecret(observerPool, namespaceId, secretApi.slackBot.id);
    const gatewayContainer = gatewayPod.spec.containers[0];
    for (const [name, source] of [
      ["SLACK_APP_TOKEN", slackAppStorage],
      ["SLACK_BOT_TOKEN", slackBotStorage],
    ]) {
      const ref = gatewayContainer.env.find((entry) => entry.name === name).valueFrom.secretKeyRef;
      if (mode === "dedicated") {
        assert.equal(source.backendRef.namespaceName, gatewayPlacement);
        assertRequiredSecretKeyRef(ref, {
          name: source.backendRef.name,
          key: source.backendRef.key,
        });
      } else {
        const projected = await resource("secret", ref.name, gatewayPlacement);
        const original = await resource(
          "secret",
          source.backendRef.name,
          source.backendRef.namespaceName,
        );
        assert.equal(
          projected.data[ref.key] === original.data[source.backendRef.key],
          true,
          "only the admitted channel key must reach the embedded runtime",
        );
      }
    }
    if (harnessPod !== undefined) {
      assert.equal(
        harnessPod.spec.containers.some((container) =>
          (container.env ?? []).some(({ name }) =>
            ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"].includes(name),
          ),
        ),
        false,
        "channel Secrets must stay out of the dedicated Codex workload",
      );
    }
  }
  const gatewayVersion = (
    await kubectl(
      "exec",
      gatewayPod.metadata.name,
      "--namespace",
      gatewayPlacement,
      "--",
      "node",
      "/app/openclaw.mjs",
      "--version",
    )
  ).trim();
  assert.ok(gatewayVersion, "production gateway image must contain the real OpenClaw executable");
  if (process.env.OCC_TEST_KUBERNETES_OPENCLAW_VERSION) {
    assert.ok(gatewayVersion.includes(process.env.OCC_TEST_KUBERNETES_OPENCLAW_VERSION));
  }
  context.diagnostic(`${mode}: ${gatewayVersion}`);
  await assertGatewayEffectiveDefaultModel(
    context,
    { mode, placement, gatewayPlacement, gatewayPod },
    `${harnessId === "codex" ? "codex" : "openai"}/${providerModel}`,
  );

  const startGatewayForward = () =>
    options.gatewayPort === undefined
      ? startPortForward(gatewayPlacement, gatewayServiceName)
      : startPortForwardTarget(
          gatewayPlacement,
          `service/${gatewayServiceName}`,
          `${options.gatewayPort}:8080`,
        );
  if (slack === undefined) {
    forwarding = await startGatewayForward();
  }
  const restartControllerApi = async () => {
    assert.equal(
      workspaceGateway,
      undefined,
      "controller restart proof is scoped to the local Fastify production harness",
    );
    const previousUrl = controllerUrl;
    await productionApp.close();
    productionApp = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL: controllerAuthBaseURL,
      drivers,
    });
    if (previousUrl !== undefined) {
      await productionApp.listen({
        host: "127.0.0.1",
        port: Number(new URL(previousUrl).port),
      });
      controllerUrl = previousUrl;
    }
    adminRequest = await requestFactory(credentials);
    request = adminRequest;
  };
  return {
    mode,
    placement,
    gatewayPlacement,
    namespaceId,
    installation: activeInstallation,
    platformNamespace,
    gatewayImage,
    workspaceGateway,
    controllerApiPod,
    workspaceRequest,
    approvedClient,
    controllerAccount: controller.account,
    controllerTenantRole: controller.tenantRole,
    apiSecretRole: controller.apiSecretRole,
    apiAccount: controller.apiAccount,
    kubernetesNamespaceName,
    adminRequest: (...args) => adminRequest(...args),
    request: (...args) => request(...args),
    restartControllerApi,
    events,
    agent: agent.data,
    persistedAgent,
    revision: deployed.data,
    gatewayServiceName,
    agentServiceName,
    gatewayPod,
    harnessPod,
    loggingObservationStartedAt,
    gatewayPassword,
    controllerUrl,
    credentials,
    directory,
    gatewayUrl: forwarding?.url,
    async refreshGatewayUrl() {
      // kubectl selects one Pod; a gateway restart invalidates the previous tunnel.
      await forwarding?.stop();
      forwarding = await startGatewayForward();
      return forwarding.url;
    },
    observerPool,
    secretApi,
  };
}

async function inspectWorkloadEnvironment(namespace, pod) {
  const script = `const keys=${JSON.stringify([
    "OPENAI_API_KEY",
    secretRotationProbe,
    "APP_SERVER_TOKEN",
    "APP_SERVER_URL",
    "OPENCLAW_GATEWAY_PASSWORD",
  ])};process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k=>[k,Object.hasOwn(process.env,k)]))))`;
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function inspectEnvironmentValue(namespace, pod, name, expected) {
  const script = `const name=${JSON.stringify(name)};const expected=${JSON.stringify(expected)};process.stdout.write(JSON.stringify({present:Object.hasOwn(process.env,name),matches:process.env[name]===expected}))`;
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function inspectProjectedIdentity(namespace, pod) {
  const script =
    'const fs=require("node:fs");const p="/var/run/secrets/openclaw/service-principal/token";if(!fs.existsSync(p)){process.stdout.write("null");process.exit(0)}const c=JSON.parse(Buffer.from(fs.readFileSync(p,"utf8").split(".")[1],"base64url"));process.stdout.write(JSON.stringify({subject:c.sub,audience:c.aud}))';
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function assertDeniedConnection(namespace, pod, targetIp) {
  const script = String.raw`
    const socket = require("node:net").createConnection(
      { host: ${JSON.stringify(targetIp)}, port: ${deniedPort}, timeout: 3500 },
      () => { process.stdout.write("ALLOWED"); socket.destroy(); },
    );
    socket.on("timeout", () => { process.stdout.write("DENIED"); socket.destroy(); });
    socket.on("error", () => { process.stdout.write("DENIED"); });
  `;
  const outcome = await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script);
  assert.equal(outcome, "DENIED", "enforced production tenant policies must deny unrelated Pods");
}

async function assertUnauthorizedCodexSocket(topology) {
  const script = String.raw`
    const { randomBytes } = require("node:crypto");
    const request = require("node:http").request(
      process.env.APP_SERVER_URL.replace(/^ws:/, "http:"),
      { headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      } },
    );
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      process.stdout.write("101");
    });
    request.on("response", (response) => {
      response.resume();
      process.stdout.write(String(response.statusCode));
    });
    request.on("error", (error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
    request.end();
  `;
  const status = await kubectl(
    "exec",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.gatewayPlacement,
    "--",
    "node",
    "-e",
    script,
  );
  assert.ok(["401", "403"].includes(status), `unauthorized Codex WebSocket returned ${status}`);
}

async function assertActualModelTurn(topology) {
  topology.gatewayUrl = await topology.refreshGatewayUrl();
  try {
    await assertGatewayModelTurn({
      gatewayUrl: topology.gatewayUrl,
      gatewayPassword: topology.gatewayPassword,
      nonce: `OCC-K3D-${topology.mode.toUpperCase()}-${randomUUID()}`,
      secrets: [process.env.OPENAI_API_KEY],
    });
  } catch (error) {
    const transport = await resource(
      "secret",
      `openclaw-agent-transport-${hash(topology.agent.id)}`,
      topology.placement,
    );
    const protectedValues = [
      process.env.OPENAI_API_KEY,
      ...Object.values(transport.data).map((value) => Buffer.from(value, "base64").toString()),
    ];
    const logs = await Promise.all(
      [topology.gatewayPod, topology.harnessPod]
        .filter(Boolean)
        .map((pod) =>
          kubectl("logs", pod.metadata.name, "--namespace", pod.metadata.namespace, "--tail=100"),
        ),
    );
    assertNoSecretMaterial(
      logs,
      protectedValues,
      "Runtime failure logs must not expose credentials",
    );
    throw new Error(`${error.message}\n${logs.join("\n")}`, { cause: error });
  }
}

// Exercise the regular Secret -> Agent draft -> deployment -> worker -> native startup path.
// The failure log distinguishes rejected native authentication from ordinary startup latency.
async function assertInvalidHarnessAuthStaysUnready(context, topology, options = {}) {
  const namespaceId = topology.agent.namespaceId;
  const agentPath = `/namespaces/${namespaceId}/agents/${topology.agent.id}`;
  const validBinding = structuredClone(topology.agent.harnessAuth);
  const predecessor = structuredClone(topology.revision);
  const invalidKey = `sk-invalid-harness-auth-${randomUUID()}`;
  const invalidSecret = await createApiSecret(
    topology.request,
    namespaceId,
    "invalid-model-key",
    invalidKey,
  );
  await Promise.all(
    [topology.secretApi.assignmentPrincipalId, topology.persistedAgent.servicePrincipalId].map(
      (principalId) =>
        grantSecretOperate(topology.observerPool, namespaceId, principalId, invalidSecret.id),
    ),
  );
  const rebound = await topology.request("PATCH", agentPath, {
    configurationId: topology.agent.configurationId,
    harnessAuth: { method: "api_key", source: invalidSecret.ref },
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  assertNoSecretMaterial(rebound, [invalidKey], "invalid-key binding response");
  assert.equal(rebound.status, 200, JSON.stringify(rebound.error));
  const serviceName =
    topology.mode === "dedicated" ? topology.agentServiceName : topology.gatewayServiceName;
  const servingService = await resource("service", serviceName, topology.placement);
  const candidate = await topology.request("POST", `${agentPath}/deploy`);
  assertNoSecretMaterial(candidate, [invalidKey], "invalid-key deployment response");
  assert.equal(candidate.status, 202, JSON.stringify(candidate.error));
  assert.deepEqual(candidate.data.harnessAuth, rebound.data.harnessAuth);
  const storage = await storedSecret(topology.observerPool, namespaceId, invalidSecret.id);
  const rejectedPod = await waitFor(
    `native authentication rejection for ${candidate.data.id}`,
    async () => {
      const pod = (await topologyPods(topology)).find(
        (pod) =>
          pod.metadata.deletionTimestamp === undefined &&
          pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
          (topology.mode === "dedicated"
            ? pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
              pod.metadata.labels?.["openclaw.dev/revision"] === candidate.data.id
            : pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
              gatewayConsumesRevision(pod, topology.agent.id, candidate.data.id)),
      );
      if (!pod?.status.containerStatuses?.some(({ state }) => state?.running)) {
        return undefined;
      }
      let logs;
      try {
        logs = await kubectl(
          "logs",
          pod.metadata.name,
          "--namespace",
          pod.metadata.namespace,
          "--tail=100",
        );
      } catch (error) {
        // A Pod can be replaced between observation and log retrieval; wait for its successor.
        if (/NotFound|not found|PodInitializing|ContainerCreating/.test(error.stderr ?? "")) {
          return undefined;
        }
        throw error;
      }
      assertNoSecretMaterial(
        logs,
        [invalidKey, process.env.OPENAI_API_KEY],
        "failed native authentication logs",
      );
      if (!logs.includes("Harness model authentication probe failed.")) {
        return undefined;
      }
      assert.equal(
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
        false,
      );
      await assertModelRuntimeProjection(pod, storage);
      return pod;
    },
    120_000,
  );
  await waitFor(
    `unready candidate ${candidate.data.id} worker observation`,
    () =>
      topology.events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.data.id &&
          event.outcome === "pending" &&
          (event.code === "REVISION_INCOMPLETE" ||
            (topology.mode === "embedded" && event.code === "REVISION_FINALIZATION_INCOMPLETE")),
      ),
    60_000,
  );
  assertNoSecretMaterial(topology.events, [invalidKey], "failed candidate worker events");
  const active = await topology.request("GET", agentPath);
  assert.equal(active.status, 200);
  if (topology.mode === "dedicated") {
    assert.equal(active.data.activeRevisionId, predecessor.id);
    assert.equal(
      (await resource("pod", topology.gatewayPod.metadata.name, topology.gatewayPlacement)).metadata
        .uid,
      topology.gatewayPod.metadata.uid,
      "invalid auth must preserve the dedicated serving gateway Pod",
    );
    assert.equal(
      (await resource("pod", topology.harnessPod.metadata.name, topology.placement)).metadata.uid,
      topology.harnessPod.metadata.uid,
      "invalid auth must preserve the serving Codex Pod",
    );
  } else {
    // Embedded activation publishes the revision before replacing the shared
    // gateway. Failed native startup keeps that replacement unready, with no rollback.
    assert.equal(active.data.activeRevisionId, candidate.data.id);
    const gateways = (await topologyPods(topology)).filter(
      ({ metadata }) =>
        metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
    );
    assert.equal(
      gateways.some(({ metadata }) => metadata.uid === topology.gatewayPod.metadata.uid),
      false,
    );
    assert.equal(gateways.length, 1);
    assert.equal(gateways[0].metadata.uid, rejectedPod.metadata.uid);
  }
  const stillServing = await resource("service", serviceName, topology.placement);
  assert.deepEqual(
    stillServing.spec.selector,
    servingService.spec.selector,
    "the Service keeps its existing topology selector through failed authentication",
  );
  const slices = await resources("endpointslices", topology.placement);
  assert.equal(
    slices
      .filter(({ metadata }) => metadata.labels?.["kubernetes.io/service-name"] === serviceName)
      .flatMap(({ endpoints = [] }) => endpoints)
      .some(
        (endpoint) =>
          endpoint.targetRef?.uid === rejectedPod.metadata.uid &&
          endpoint.conditions?.ready !== false,
      ),
    false,
    "the rejected candidate must never become a serving endpoint",
  );
  if (topology.mode === "embedded") {
    assert.equal(
      slices
        .filter(({ metadata }) => metadata.labels?.["kubernetes.io/service-name"] === serviceName)
        .flatMap(({ endpoints = [] }) => endpoints)
        .some((endpoint) => endpoint.conditions?.ready !== false),
      false,
      "failed embedded cutover leaves no ready gateway endpoint",
    );
  }
  const retained = await topology.request(
    "DELETE",
    `/namespaces/${namespaceId}/secrets/${invalidSecret.id}`,
  );
  assertNoSecretMaterial(retained, [invalidKey], "referenced invalid source deletion response");
  assert.equal(retained.status, 409, "draft and pending deployment retain their exact auth source");
  const historical = await topology.request("GET", `${agentPath}/revisions/${predecessor.id}`);
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data.harnessAuth, predecessor.harnessAuth);
  if (options.recover === false) {
    return { revision: candidate.data, rejectedPod };
  }
  if (topology.mode === "dedicated") {
    await assertActualModelTurn(topology);
    const afterTurn = await topology.request("GET", agentPath);
    assert.equal(afterTurn.status, 200);
    assert.equal(afterTurn.data.activeRevisionId, predecessor.id);
  }

  const restored = await topology.request("PATCH", agentPath, {
    configurationId: topology.agent.configurationId,
    harnessAuth: validBinding,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.error));
  const recovery = await topology.request("POST", `${agentPath}/deploy`);
  assert.equal(recovery.status, 202, JSON.stringify(recovery.error));
  await waitFor(`valid authentication recovery ${recovery.data.id}`, async () => {
    const observed = await topology.request("GET", agentPath);
    assert.equal(observed.status, 200);
    return observed.data.activeRevisionId === recovery.data.id ? observed.data : undefined;
  });
  await waitFor(`valid recovery ${recovery.data.id} worker completion`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === recovery.data.id &&
        event.outcome === "success",
    ),
  );
  topology.gatewayPod = await waitForReadyGatewayPod(topology, recovery.data.id);
  if (topology.mode === "dedicated") {
    topology.harnessPod = await waitForReadyAgentPod(
      topology,
      recovery.data.id,
      topology.harnessPod.metadata.uid,
    );
  }
  topology.agent = restored.data;
  topology.revision = recovery.data;
  assert.deepEqual(recovery.data.harnessAuth, validBinding);
  await assertActualModelTurn(topology);
  context.diagnostic(
    topology.mode === "dedicated"
      ? "dedicated: invalid-key candidate stayed unready; predecessor served and valid binding recovered"
      : "embedded: invalid-key replacement left the shared gateway unavailable; valid redeploy recovered",
  );
}

function assertRuntimeFailureEvidence(value) {
  assert.deepEqual(
    Object.keys(value).sort(),
    ["check", "checkedAt", "code", "component"],
    "startup failure evidence must contain only the allowlisted runtime fields",
  );
  for (const key of ["component", "check", "code"]) {
    assert.equal(typeof value[key], "string", `runtime failure ${key} must be a string`);
    assert.match(value[key], /^[A-Za-z0-9._~:@-]{1,64}$/);
  }
  assert.equal(Number.isNaN(Date.parse(value.checkedAt)), false);
}

async function deploymentStatus(topology, revisionId) {
  const response = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deployments/${revisionId}`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.error));
  assertNoSecretMaterial(
    response,
    secretApiProtectedValues(topology, [process.env.OPENAI_API_KEY]),
    "deployment status response",
  );
  return response.data;
}

async function deleteRevisionPods(topology, revisionId) {
  const pods = (await topologyPods(topology)).filter((pod) => {
    const { metadata } = pod;
    if (
      metadata.deletionTimestamp !== undefined ||
      metadata.labels?.["openclaw.dev/agent"] !== topology.agent.id
    ) {
      return false;
    }
    if (metadata.labels?.["openclaw.dev/workload-role"] === "agent") {
      return metadata.labels?.["openclaw.dev/revision"] === revisionId;
    }
    return (
      metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      gatewayConsumesRevision(pod, topology.agent.id, revisionId)
    );
  });
  await Promise.all(
    pods.map((pod) =>
      kubectl(
        "delete",
        "pod",
        pod.metadata.name,
        "--namespace",
        pod.metadata.namespace,
        "--wait=true",
        "--timeout=90s",
      ),
    ),
  );
  return pods;
}

async function assertStartupFailureDeploymentStatusDurable(context, topology, options = {}) {
  const plugins = options.pluginsEnabled
    ? {
        [startupFailurePluginId]: { enabled: true, toolDefaults: { approval: "provider_default" } },
      }
    : {};
  const failure = await assertInvalidHarnessAuthStaysUnready(context, topology, {
    plugins,
    recover: false,
  });
  const failed = await deploymentStatus(topology, failure.revision.id);
  assert.deepEqual(
    Object.keys(failed).sort(),
    ["agentId", "deploymentId", "error", "namespaceId", "status", "warnings"],
    "deployment status must use the approved durable status shape",
  );
  assert.equal(failed.deploymentId, failure.revision.id);
  assert.equal(failed.namespaceId, topology.agent.namespaceId);
  assert.equal(failed.agentId, topology.agent.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "CONVERGENCE_DEADLINE_EXCEEDED");
  assert.equal(typeof failed.error.message, "string");
  assert.equal(typeof failed.error.data.timeoutMs, "number");
  assert.ok(failed.error.data.timeoutMs > 0);
  assertRuntimeFailureEvidence(failed.error.data.runtimeFailure);
  assert.ok(Array.isArray(failed.warnings));
  const deletedPods = await deleteRevisionPods(topology, failure.revision.id);
  assert.ok(
    deletedPods.length > 0,
    "durability proof must delete the failed native Pod before re-reading deployment status",
  );
  const afterPodDeletion = await deploymentStatus(topology, failure.revision.id);
  assert.deepEqual(
    afterPodDeletion,
    failed,
    "failed deployment status must survive native Pod deletion and restart opportunities",
  );
  await topology.restartControllerApi();
  const afterControllerRestart = await deploymentStatus(topology, failure.revision.id);
  assert.deepEqual(
    afterControllerRestart,
    failed,
    "failed deployment status must survive controller API restart",
  );
  context.diagnostic(
    `startup failure durability: ${failure.revision.id} plugins ${
      options.pluginsEnabled ? "enabled" : "disabled"
    } retained ${failed.error.code}`,
  );
}

async function assertKubernetesOtelLogs(topology) {
  const observation = createOtelLogObservation(undefined, {
    description: `k3d ${topology.mode} runtime OTel logs`,
    startedAt: topology.loggingObservationStartedAt,
  });
  assertKubernetesRuntimeOtelSettings(observation, [topology.gatewayPod, topology.harnessPod]);
  await observation.assertRecords({
    forbidden: [process.env.OPENAI_API_KEY, topology.gatewayPassword],
    expected: [
      {
        label: `${topology.mode} gateway operational record`,
        serviceName: "openclaw-gateway",
        resource: {
          [OTEL_RESOURCE.namespaceId]: topology.agent.namespaceId,
          [OTEL_RESOURCE.agentId]: topology.agent.id,
          [OTEL_RESOURCE.revisionId]: topology.revision.id,
        },
        attributes: { "event.name": "gateway.operational" },
        body: "gateway.operational",
      },
      ...(topology.harnessPod === undefined
        ? []
        : [
            {
              label: "dedicated Codex app-server operational record",
              serviceName: "codex-app-server",
              resource: {
                [OTEL_RESOURCE.namespaceId]: topology.agent.namespaceId,
                [OTEL_RESOURCE.agentId]: topology.agent.id,
                [OTEL_RESOURCE.revisionId]: topology.revision.id,
              },
              attributes: { "event.name": "codex.operational" },
              body: "codex.operational",
            },
          ]),
    ],
  });
}

function harnessWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

function sharedVolumeClaimName(pod) {
  return pod.spec.volumes?.find(({ name }) => name === sharedWorkspaceVolumeName)
    ?.persistentVolumeClaim?.claimName;
}

function sharedVolumeSubPaths(pod) {
  return (pod.spec.containers[0].volumeMounts ?? [])
    .filter(({ name }) => name === sharedWorkspaceVolumeName)
    .map(({ subPath }) => subPath)
    .sort();
}

function assertPrivateStateInitContainer(pod) {
  const main = pod.spec.containers[0];
  const [init] = pod.spec.initContainers ?? [];
  const { runAsUser, runAsGroup, fsGroup } = pod.spec.securityContext;
  assert.deepEqual(
    pod.spec.initContainers?.map(({ name }) => name),
    ["prepare-private-state"],
    "runtime gateway and Codex Pods must prepare private /home/node state exactly once",
  );
  assert.equal(init.image, main.image, "private-state init must use the main workload image");
  assert.deepEqual(
    [
      init.volumeMounts,
      init.env ?? [],
      init.envFrom ?? [],
      init.securityContext,
      { runAsUser, runAsGroup, fsGroup },
    ],
    [
      [
        { name: "runtime-state", mountPath: "/home/node" },
        ...(pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway"
          ? [{ name: "openclaw-gateway-state", mountPath: "/gateway-state" }]
          : [{ name: "openclaw-node-state", mountPath: "/workspace-node-state" }]),
      ],
      [],
      [],
      {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    ],
  );
}

async function assertScopedTenantPvcAccess(topology) {
  const verbs = ["get", "create", "patch", "delete", "list", "update"];
  assert.deepEqual(
    await Promise.all(
      verbs.map((verb) =>
        kubectl(
          "auth",
          "can-i",
          verb,
          "persistentvolumeclaims",
          "--namespace",
          topology.placement,
          `--as=system:serviceaccount:${topology.platformNamespace}:${topology.controllerAccount}`,
        ).then(
          (stdout) => stdout.trim(),
          ({ stdout }) => stdout.trim(),
        ),
      ),
    ),
    ["yes", "yes", "yes", "yes", "no", "no"],
    "the scoped tenant controller must receive only the four required PVC verbs",
  );
}

async function assertDedicatedWorkspaceResources(topology) {
  await assertScopedTenantPvcAccess(topology);
  const claimName = harnessWorkspaceClaimName(topology.agent.id);
  const claim = await resource("persistentvolumeclaim", claimName, topology.placement);
  assert.deepEqual(
    [claim.spec.accessModes, claim.spec.resources.requests.storage, claim.status.phase],
    [["ReadWriteOnce"], harnessWorkspaceClaimSize, "Bound"],
    "the Agent-owned Harness workspace PVC must be bound with the expected spec",
  );
  assert.deepEqual(
    [sharedVolumeClaimName(topology.gatewayPod), sharedVolumeClaimName(topology.harnessPod)],
    [undefined, claimName],
    "only Harness may mount the workspace claim",
  );
  assert.deepEqual(
    [sharedVolumeSubPaths(topology.gatewayPod), sharedVolumeSubPaths(topology.harnessPod)],
    [[], harnessWorkspaceSubPaths],
  );
  return claim;
}

// The image enters through chat.send, so persistence must retain real application media.
const continuityImage =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC";
const gatewayPrivatePaths = [
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
];

async function assertGatewayPrivateResources(topology) {
  const name = `gateway-state-${hash(topology.agent.id)}`;
  const claim = await resource("persistentvolumeclaim", name, topology.gatewayPlacement);
  assert.deepEqual(
    [
      claim.spec.accessModes,
      claim.spec.resources.requests.storage,
      claim.spec.storageClassName,
      claim.status.phase,
    ],
    [["ReadWriteOnce"], "10Gi", "local-path", "Bound"],
  );
  assert.equal(claim.metadata.labels["openclaw.dev/agent"], topology.agent.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], topology.agent.namespaceId);
  assert.deepEqual(
    topology.gatewayPod.spec.volumes.find(({ name }) => name === "openclaw-gateway-state"),
    { name: "openclaw-gateway-state", persistentVolumeClaim: { claimName: name } },
  );
  assert.deepEqual(
    topology.gatewayPod.spec.containers[0].volumeMounts
      .filter(({ name }) => name === "openclaw-gateway-state")
      .map(({ subPath, mountPath }) => [subPath, mountPath]),
    [
      ...gatewayPrivatePaths,
      ...(topology.mode === "embedded"
        ? [["workspace", "/home/node/.openclaw/workspace"]]
        : [["sessions", "/home/node/.openclaw/agents/main/sessions"]]),
    ],
  );
  if (topology.harnessPod !== undefined) {
    assert.equal(
      JSON.stringify(topology.harnessPod.spec).includes(name),
      false,
      "the Codex Pod must never mount the gateway-private claim",
    );
  }
  return claim;
}

async function gatewayCall(topology, method, params) {
  // The real CLI authenticates from the Pod's env/config; credentials never enter kubectl args.
  return JSON.parse(
    await execNode(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      `
    const { execFileSync } = require("node:child_process");
    process.stdout.write(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      ${JSON.stringify(method)}, "--params", ${JSON.stringify(JSON.stringify(params))},
      "--json", "--timeout", "180000"], { encoding: "utf8", timeout: 210000 }));
  `,
    ),
  );
}

async function assertGatewayEffectiveDefaultModel(context, topology, expectedModel) {
  const actualModel = JSON.parse(
    await execNode(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      `
    (async () => {
      const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
      const model = loadConfig({ pin: false }).agents?.defaults?.model;
      const primary = typeof model === "string" ? model : model?.primary;
      if (typeof primary !== "string" || !primary.trim()) {
        throw new Error("Effective runtime config did not expose agents.defaults.model");
      }
      process.stdout.write(JSON.stringify(primary));
    })().catch(error => {
      console.error(error);
      process.exit(1);
    });
  `,
    ),
  );
  assert.equal(
    actualModel,
    expectedModel,
    `gateway effective default model changed before live model calls: ${actualModel}`,
  );
  context.diagnostic(`${topology.mode}: effective default model ${actualModel}`);
}

function messageText(message) {
  if (typeof message.content === "string") {
    return message.content;
  }
  return (message.content ?? [])
    .filter(({ type }) => type === "text")
    .map(({ text }) => text)
    .join("\n");
}

function assertNativeToolSucceeded(history, marker, expectedText) {
  const historyJson = JSON.stringify(history);
  assert.doesNotMatch(
    historyJson,
    /require_escalated/,
    "native Codex execution must not request escalated execution",
  );
  assert.equal(
    history.messages.some(({ role, stopReason }) => role === "assistant" && stopReason === "error"),
    false,
    "the native provider turn must not end in an assistant error",
  );

  const call = history.messages
    .flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [];
      }
      return message.content
        .filter((block) => block?.type === "toolCall" && ["bash", "exec"].includes(block.name))
        .map((block) => ({ message, block }));
    })
    .find(({ block }) => JSON.stringify(block.arguments ?? {}).includes(marker));
  assert.ok(call, "chat.history must retain the native shell tool call for the probe");

  const result = history.messages.find(
    (message) =>
      message.role === "toolResult" &&
      (call.block.id === undefined || message.toolCallId === call.block.id) &&
      ["bash", "exec"].includes(message.toolName) &&
      messageText(message).includes(marker) &&
      messageText(message).includes(expectedText),
  );
  assert.ok(result, "chat.history must retain the successful native shell tool result");
  assert.notEqual(result.isError, true, "native shell tool result must not be marked as an error");
  if (result.details?.exitCode !== undefined) {
    assert.equal(result.details.exitCode, 0);
  }
  if (typeof result.details?.status === "string") {
    assert.match(result.details.status, /completed|success/i);
  }
}

async function assertConversation(topology, sessionKey, nonce) {
  return waitFor(`provider transcript ${nonce}`, async () => {
    const history = await gatewayCall(topology, "chat.history", { sessionKey, limit: 30 });
    assert.equal(
      history.messages.some(
        ({ role, stopReason }) => role === "assistant" && stopReason === "error",
      ),
      false,
      "the actual provider turn must succeed",
    );
    const user = history.messages.find(
      (message) => message.role === "user" && messageText(message).includes(nonce),
    );
    const assistant = history.messages.find(
      (message) => message.role === "assistant" && messageText(message).includes(nonce),
    );
    return user && assistant ? history : undefined;
  });
}

function assistantMessageContaining(history, nonce) {
  return history.messages.find(
    (message) => message.role === "assistant" && messageText(message).includes(nonce),
  );
}

function artifactSummaryForDiagnostics({
  id,
  type,
  title,
  mimeType,
  sizeBytes,
  sessionKey,
  messageSeq,
  source,
  download,
}) {
  return {
    id,
    type,
    title,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(messageSeq === undefined ? {} : { messageSeq }),
    ...(source === undefined ? {} : { source }),
    download: { mode: download?.mode },
  };
}

async function inspectGatewayPersistence(topology, imageDigest, sessionKey, sessionId) {
  // Read existing persisted state only. Missing/corrupt storage fails; the probe never creates it.
  return JSON.parse(
    await execNode(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      `
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const path = require("node:path");
    const { createHash } = require("node:crypto");

    function messageText(message) {
      if (typeof message.content === "string") return message.content;
      return (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\\n");
    }

    function files(dir) { return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
      const file=path.join(dir,entry.name); return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
    }); }

    (async () => {
      const {
        readVisibleSessionTranscriptMessageEntries,
        resolveSessionTranscriptTarget,
      } = await import("openclaw/plugin-sdk/session-transcript-runtime");
      const canonicalSessionKey = ${JSON.stringify(sessionKey)}.trim().toLowerCase();
      if (${JSON.stringify(sessionKey)} !== canonicalSessionKey) {
        throw new Error("Test generated a noncanonical session key");
      }
      const expectedSessionId = ${JSON.stringify(sessionId)};
      if (typeof expectedSessionId !== "string" || !expectedSessionId.trim()) {
        throw new Error("Test must probe persistence with the exact session id exposed by chat.history");
      }

      const stateDatabase = "/home/node/.openclaw/state/openclaw.sqlite";
      const transcriptDatabase = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
      const databases = [stateDatabase, transcriptDatabase].map(file => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout=5000");
          return { file, integrity: db.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0]) };
        } finally { db.close(); }
      });

      const target = await resolveSessionTranscriptTarget({
        sessionId: expectedSessionId,
        sessionKey: canonicalSessionKey,
      });
      const entries = await readVisibleSessionTranscriptMessageEntries(target);
      const transcript = {
        agentId: target.agentId,
        memoryKey: target.memoryKey,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        targetKind: target.targetKind,
        messages: entries.map(({entryId, parentId, role, seq, message}) => ({
          entryId,
          parentId: parentId ?? null,
          role,
          seq,
          text: messageText(message),
        })),
      };

      const media = files("/home/node/.openclaw/media").filter(file =>
        createHash("sha256").update(fs.readFileSync(file)).digest("hex") === ${JSON.stringify(imageDigest)});
      process.stdout.write(JSON.stringify({
        databases,
        media,
        transcript,
      }));
    })().catch(error => {
      console.error(error);
      process.exit(1);
    });
  `,
    ),
  );
}

async function assertRetainedArtifact(
  topology,
  sessionKey,
  {
    expectedId,
    expectedData = continuityImage,
    messageSeq,
    expectedType = "image",
    expectedMimeType = "image/png",
  } = {},
) {
  const deadline = Date.now() + 240_000;
  let lastArtifacts = [];
  let artifact;
  while (Date.now() < deadline && artifact === undefined) {
    const { artifacts } = await gatewayCall(topology, "artifacts.list", { sessionKey });
    lastArtifacts = artifacts.map(artifactSummaryForDiagnostics);
    artifact = artifacts.find(
      ({ type, id, source, messageSeq: artifactMessageSeq }) =>
        type === expectedType &&
        /^artifact_[A-Za-z0-9_-]+$/.test(id) &&
        source === "session-transcript" &&
        (expectedId === undefined || id === expectedId) &&
        (messageSeq === undefined || artifactMessageSeq === messageSeq),
    );
    if (artifact === undefined) {
      await delay(750);
    }
  }
  if (artifact === undefined) {
    const history = await gatewayCall(topology, "chat.history", { sessionKey, limit: 10 });
    const observed = history.messages.map((message) => ({
      role: message.role,
      text: messageText(message).slice(0, 800),
      seq: message.__openclaw?.seq,
      contentTypes: Array.isArray(message.content)
        ? message.content.map((block) => block.type)
        : [],
    }));
    assertNoSecretMaterial(
      observed,
      [topology.gatewayPassword, process.env.OPENAI_API_KEY],
      "artifact failure history",
    );
    process.stderr.write(`Artifact failure history: ${JSON.stringify(observed)}\n`);
  }
  assert.ok(
    artifact,
    `Timed out waiting for retained ${expectedType} artifact. Last artifacts: ${JSON.stringify(lastArtifacts)}`,
  );
  assert.equal(artifact.download.mode, "url");
  // Mint a fresh ticket after each restart. The capability stays inside the Pod, out of kubectl args/logs.
  const downloaded = JSON.parse(
    await execNode(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      `
    const assert = require("node:assert/strict");
    const { execFileSync } = require("node:child_process");
    const result = JSON.parse(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      "artifacts.download", "--params", ${JSON.stringify(JSON.stringify({ sessionKey, artifactId: artifact.id }))},
      "--json", "--timeout", "180000"], { encoding: "utf8", timeout: 210000 }));
    const origin = "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT;
    const url = new URL(result.url, origin);
    assert.equal(url.origin, origin);
    assert.ok(url.pathname.startsWith("/api/chat/media/outgoing/"));
    assert.ok(url.searchParams.has("mediaTicket"));
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200, "the current artifact ticket must download the retained bytes");
      assert.ok(response.headers.get("content-type").startsWith(${JSON.stringify(expectedMimeType)}));
      process.stdout.write(JSON.stringify({data: Buffer.from(await response.arrayBuffer()).toString("base64")}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ),
  );
  assert.deepEqual(Buffer.from(downloaded.data, "base64"), Buffer.from(expectedData, "base64"));
  return artifact.id;
}

async function assertGatewayPodContinuity(context, topology, privateClaim) {
  const sessionKey = `agent:main:durability-${randomUUID()}`;
  const nonce = `OCE-BEFORE-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Reply with exactly ${nonce}. Do not use tools; the attached PNG tests image retention.`,
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "durability.png",
        content: continuityImage,
      },
    ],
  });
  const history = await assertConversation(topology, sessionKey, nonce);
  const digest = createHash("sha256").update(Buffer.from(continuityImage, "base64")).digest("hex");
  const uploaded = await inspectGatewayPersistence(topology, digest, sessionKey, history.sessionId);
  const inboundPath = uploaded.media.find((file) => file.includes("/media/inbound/"));
  assert.ok(inboundPath, "chat.send must persist the actual PNG under private media");
  // A real model returns the uploaded PNG through the supported MEDIA directive. No image-generation bill
  // or hand-written output file is needed to exercise managed outgoing records and their ticketed download.
  const imageNonce = `OCE-IMAGE-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Return these exact two lines without tools or code fences:\n${imageNonce}\nMEDIA:${inboundPath}`,
  });
  const imageHistory = await assertConversation(topology, sessionKey, imageNonce);
  const imageMessageSeq = assistantMessageContaining(imageHistory, imageNonce)?.__openclaw?.seq;
  assert.equal(
    typeof imageMessageSeq,
    "number",
    "chat.history must expose the assistant transcript seq for the returned image artifact",
  );
  const artifactId = await assertRetainedArtifact(topology, sessionKey, {
    expectedData: continuityImage,
    messageSeq: imageMessageSeq,
  });
  const before = await inspectGatewayPersistence(topology, digest, sessionKey, history.sessionId);
  for (const database of before.databases) {
    assert.deepEqual(database.integrity, ["ok"]);
  }
  assert.equal(before.transcript.sessionKey, sessionKey);
  assert.equal(before.transcript.sessionId, history.sessionId);
  for (const role of ["user", "assistant"]) {
    assert.ok(
      before.transcript.messages.some(
        (message) => message.role === role && message.text.includes(nonce),
      ),
      `the initial ${role} turn must be exposed through the retained session transcript`,
    );
  }
  if (topology.harnessPod !== undefined) {
    const hidden = await execNode(
      topology.placement,
      topology.harnessPod.metadata.name,
      `
      const fs = require("node:fs");
      process.stdout.write(JSON.stringify(${JSON.stringify([...before.databases.map(({ file }) => file), ...before.media])}.filter(file => fs.existsSync(file))));
    `,
    );
    assert.deepEqual(
      JSON.parse(hidden),
      [],
      "Codex must not see the gateway private state, transcript database, or retained image files",
    );
  }

  // Deleting the Pod destroys emptyDir state; only the owning durable claim can preserve these outcomes.
  const previousUid = topology.gatewayPod.metadata.uid;
  await kubectl(
    "delete",
    "pod",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.gatewayPlacement,
    "--wait=true",
    "--timeout=120s",
  );
  topology.gatewayPod = await waitFor("a replacement gateway Pod with a new UID", async () =>
    (await resources("pods", topology.gatewayPlacement)).find(
      (pod) =>
        pod.metadata.uid !== previousUid &&
        !pod.metadata.deletionTimestamp &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    ),
  );
  const retained = await assertGatewayPrivateResources(topology);
  assert.equal(retained.metadata.uid, privateClaim.metadata.uid);
  await assertConversation(topology, sessionKey, nonce);
  await assertRetainedArtifact(topology, sessionKey, { expectedId: artifactId });
  const restored = await inspectGatewayPersistence(
    topology,
    digest,
    sessionKey,
    before.transcript.sessionId,
  );
  for (const database of restored.databases) {
    assert.deepEqual(database.integrity, ["ok"]);
  }
  assert.deepEqual(
    restored.transcript,
    before.transcript,
    "the exact visible session transcript messages must survive Pod replacement",
  );
  for (const file of before.media) {
    assert.ok(restored.media.includes(file), "all retained PNG files must survive");
  }
  const afterNonce = `OCE-AFTER-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Reply with exactly ${afterNonce}. Do not use tools.`,
  });
  await assertConversation(topology, sessionKey, afterNonce);
  const continued = await inspectGatewayPersistence(
    topology,
    digest,
    sessionKey,
    before.transcript.sessionId,
  );
  assert.equal(continued.transcript.sessionId, before.transcript.sessionId);
  assert.equal(continued.transcript.sessionKey, before.transcript.sessionKey);
  for (const role of ["user", "assistant"]) {
    assert.ok(
      continued.transcript.messages.some(
        (message) => message.role === role && message.text.includes(afterNonce),
      ),
      `the post-restart ${role} turn must write to the retained session transcript`,
    );
  }
  context.diagnostic(
    `Gateway transcript, PNG ${artifactId}, and SQLite integrity survived Pod UID ${previousUid} -> ${topology.gatewayPod.metadata.uid}.`,
  );
}

async function assertEmbeddedCreatesNoHarnessWorkspaceClaim(topology) {
  const claimName = harnessWorkspaceClaimName(topology.agent.id);
  const claims = await resources("persistentvolumeclaims", topology.placement);
  assert.equal(
    claims.some(({ metadata }) => metadata.name === claimName),
    false,
    "embedded execution must not create an Agent Harness workspace PVC",
  );
  assert.equal(sharedVolumeClaimName(topology.gatewayPod), undefined);
  assert.deepEqual(sharedVolumeSubPaths(topology.gatewayPod), []);
}

async function execNode(namespace, pod, script) {
  return kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script);
}

async function writeFileInPod(namespace, pod, file, content) {
  const script = `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const file = ${JSON.stringify(file)};
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ${JSON.stringify(content)});
  `;
  await execNode(namespace, pod, script);
}

async function readFileInPod(namespace, pod, file) {
  return execNode(
    namespace,
    pod,
    `const { readFileSync } = require("node:fs");process.stdout.write(readFileSync(${JSON.stringify(file)}, "utf8"));`,
  );
}

async function inspectFileInPod(namespace, pod, file) {
  return JSON.parse(
    await execNode(
      namespace,
      pod,
      `
        const { existsSync, readFileSync } = require("node:fs");
        const file = ${JSON.stringify(file)};
        if (!existsSync(file)) {
          process.stdout.write(JSON.stringify({ exists: false }));
          process.exit(0);
        }
        const content = readFileSync(file, "utf8");
        process.stdout.write(JSON.stringify({
          exists: true,
          sizeBytes: Buffer.byteLength(content),
          tail: content.slice(-1000),
        }));
      `,
    ),
  );
}

async function promiseResult(read) {
  try {
    return await read();
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

async function inspectDedicatedAgentsInstructionsDiagnostics(
  topology,
  sessionKey,
  instructionsPath,
) {
  const [gatewayInstructions, harnessInstructions, history] = await Promise.all([
    promiseResult(() =>
      inspectFileInPod(
        topology.gatewayPlacement,
        topology.gatewayPod.metadata.name,
        instructionsPath,
      ),
    ),
    promiseResult(() =>
      inspectFileInPod(topology.placement, topology.harnessPod.metadata.name, instructionsPath),
    ),
    promiseResult(() => gatewayCall(topology, "chat.history", { sessionKey, limit: 10 })),
  ]);
  return {
    gatewayInstructions,
    harnessInstructions,
    history: Array.isArray(history.messages)
      ? history.messages.map((message) => ({
          role: message.role,
          stopReason: message.stopReason,
          text: messageText(message).slice(0, 800),
          seq: message.__openclaw?.seq,
        }))
      : history,
  };
}

async function requestDedicatedAgentTurn(topology, sessionKey, prompt) {
  const response = await fetch(`${topology.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${topology.gatewayPassword}`,
      "content-type": "application/json",
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  assertNoSecretMaterial(
    body,
    [topology.gatewayPassword, process.env.OPENAI_API_KEY],
    "Dedicated Agent responses must not expose credentials",
  );
  assert.equal(response.status, 200, `dedicated Agent model turn failed: ${body}`);
  return JSON.parse(body).choices?.[0]?.message?.content ?? "";
}

async function requestFreshDedicatedHarnessTurn(topology) {
  return execNode(
    topology.gatewayPlacement,
    topology.gatewayPod.metadata.name,
    `
      const socket = new WebSocket(process.env.APP_SERVER_URL, {
        headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
      });
      const pending = new Map();
      let requestId = 0;
      let assistant = "";
      let finished = false;
      const timeout = setTimeout(() => fail(new Error("Codex harness turn timed out")), 180_000);

      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        process.stderr.write(error.message || String(error));
        process.exitCode = 1;
      }

      function request(method, params) {
        const id = ++requestId;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }

      socket.addEventListener("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "openclaw-enterprise-integration", version: "1.0.0" },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          const started = await request("thread/start", {
            cwd: "/home/node/workspace",
            model: ${JSON.stringify(providerModel)},
            approvalPolicy: "on-request",
            sandbox: "read-only",
            config: { project_doc_max_bytes: 131072 },
          });
          if (!started.instructionSources?.includes("/home/node/workspace/AGENTS.md")) {
            throw new Error("Fresh Codex harness thread did not load workspace AGENTS.md");
          }
          await request("turn/start", {
            threadId: started.thread.id,
            input: [{ type: "text", text: "What is 2 + 2? Answer briefly." }],
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          });
        } catch (error) {
          fail(error);
        }
      });

      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(String(data));
        if (message.id !== undefined) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (request) {
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
          }
        } else if (message.method === "item/completed") {
          if (message.params?.item?.type === "agentMessage") {
            assistant = message.params.item.text;
          }
        } else if (message.method === "turn/completed") {
          if (message.params?.turn?.status !== "completed") {
            fail(new Error("Codex harness turn did not complete successfully"));
            return;
          }
          finished = true;
          clearTimeout(timeout);
          process.stdout.write(assistant);
          socket.close();
        } else if (message.method === "error") {
          fail(new Error(message.params?.error?.message || "Codex harness turn failed"));
        }
      });
      socket.addEventListener("error", () => fail(new Error("Codex harness connection failed")));
      socket.addEventListener("close", () => {
        if (!finished) fail(new Error("Codex harness connection closed before the turn completed"));
      });
    `,
  );
}

async function assertDedicatedAgentsInstructionsInFreshSession(topology) {
  const instructionsPath = "/home/node/workspace/AGENTS.md";
  const suffix = "enterprise openclaw";
  const sessionKey = `enterprise-agents-${randomUUID()}`;

  // The Agent edits Harness storage; Gateway must read it through the paired node.
  const editResponse = await requestDedicatedAgentTurn(
    topology,
    sessionKey,
    `Use your file-editing tools to update ${instructionsPath}. Preserve its existing contents and append this exact instruction on a new line: End every response with the exact lowercase phrase ${suffix}. If the file does not exist, create it. Edit the file before you respond.`,
  );
  const [gatewayInstructionsResult, harnessInstructionsResult] = await Promise.all([
    promiseResult(() =>
      gatewayCall(topology, "agents.files.get", { agentId: "main", name: "AGENTS.md" }).then(
        (result) => result.file?.content,
      ),
    ),
    promiseResult(() =>
      readFileInPod(topology.placement, topology.harnessPod.metadata.name, instructionsPath),
    ),
  ]);
  if (
    typeof gatewayInstructionsResult !== "string" ||
    typeof harnessInstructionsResult !== "string"
  ) {
    const diagnostics = await inspectDedicatedAgentsInstructionsDiagnostics(
      topology,
      sessionKey,
      instructionsPath,
    );
    assert.fail(
      `The Agent did not persist a readable instruction file. Diagnostics: ${JSON.stringify({
        modelResponse: editResponse.slice(0, 1500),
        readResults: {
          gatewayInstructions: gatewayInstructionsResult,
          harnessInstructions: harnessInstructionsResult,
        },
        ...diagnostics,
      })}`,
    );
  }
  const gatewayInstructions = gatewayInstructionsResult;
  const harnessInstructions = harnessInstructionsResult;
  if (
    !/^End every response with the exact lowercase phrase enterprise openclaw\.$/m.test(
      harnessInstructions,
    )
  ) {
    const diagnostics = await inspectDedicatedAgentsInstructionsDiagnostics(
      topology,
      sessionKey,
      instructionsPath,
    );
    assert.fail(
      `The Agent did not persist its requested instruction. Diagnostics: ${JSON.stringify({
        modelResponse: editResponse.slice(0, 1500),
        ...diagnostics,
      })}`,
    );
  }
  assert.equal(gatewayInstructions, harnessInstructions);

  // A new native harness thread must load persisted instructions absent from its neutral prompt.
  const response = await requestFreshDedicatedHarnessTurn(topology);
  assert.match(response.trimEnd(), /enterprise openclaw[.!?]*$/);
}

async function waitForReadyAgentPod(topology, revisionId, previousUid) {
  return waitFor(`dedicated Codex Pod for revision ${revisionId}`, async () => {
    const ready = (await topologyPods(topology)).find(
      (pod) =>
        pod.metadata.uid !== previousUid &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        pod.metadata.labels?.["openclaw.dev/revision"] === revisionId &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return ready;
  });
}

async function waitForReadyGatewayPod(topology, revisionId, previousUid) {
  return waitFor(`embedded OpenClaw gateway Pod for revision ${revisionId}`, async () => {
    const ready = (await resources("pods", topology.gatewayPlacement)).find(
      (pod) =>
        (previousUid === undefined || pod.metadata.uid !== previousUid) &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        gatewayConsumesRevision(pod, topology.agent.id, revisionId) &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return ready;
  });
}

async function deployEmbeddedAgentAndWait(topology, agentId, description, options = {}) {
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${agentId}/deploy`,
  );
  assertNoSecretMaterial(
    deployed,
    options.protectedValues ?? secretApiProtectedValues(topology),
    `${description} deploy response must not leak secret material`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  await waitFor(`${description} revision ${deployed.data.id} activation`, async () => {
    const observation = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${agentId}`,
    );
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === deployed.data.id ? observation.data : undefined;
  });
  await waitFor(`worker completion of ${description} ${deployed.data.id}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === deployed.data.id &&
        event.outcome === "success",
    ),
  );
  return {
    revision: deployed.data,
    gatewayPod: await waitForReadyGatewayPod(
      { ...topology, agent: { ...topology.agent, id: agentId } },
      deployed.data.id,
      options.previousUid,
    ),
  };
}

function gatewayConsumesRevision(pod, agentId, revisionId) {
  // Gateways have stable labels; the immutable mounted ConfigMap selects the revision.
  return pod.spec.volumes?.some(
    ({ configMap }) => configMap?.name === `gateway-${hash(agentId)}-rev-${hash(revisionId)}`,
  );
}

function assertRequiredSecretKeyRef(actual, expected, message) {
  assert.ok(actual, message);
  const { optional, ...reference } = actual;
  assert.deepEqual(reference, expected, message);
  // The Kubernetes API omits an explicit false because false is this field's default.
  assert.equal(optional ?? false, false, message);
}

async function assertModelRuntimeProjection(pod, storage) {
  const ref = pod.spec.containers[0].env.find(({ name }) => name === "OPENAI_API_KEY")?.valueFrom
    ?.secretKeyRef;
  const agentId = pod.metadata.labels["openclaw.dev/agent"];
  const revisionId = pod.metadata.labels["openclaw.dev/revision"];
  assertRequiredSecretKeyRef(ref, {
    name: `harness-secrets-${hash(agentId)}-${hash(revisionId)}`,
    key: "OPENAI_API_KEY",
  });
  const [runtime, source] = await Promise.all([
    resource("secret", ref.name, pod.metadata.namespace),
    resource("secret", storage.backendRef.name, storage.backendRef.namespaceName),
  ]);
  assert.equal(
    runtime.data[ref.key] === source.data[storage.backendRef.key],
    true,
    "the admitted model source must reach only its selected runtime projection",
  );
}

async function assertOpenAiKeyProjectedFromSecret(topology, pod) {
  const storage = await storedSecret(
    topology.observerPool,
    topology.agent.namespaceId,
    topology.secretApi.model.id,
  );
  await assertModelRuntimeProjection(pod, storage);
  const backend = await resource(
    "secret",
    storage.backendRef.name,
    storage.backendRef.namespaceName,
  );
  assert.equal(
    Object.hasOwn(backend.data ?? {}, storage.backendRef.key),
    true,
    "the Secret API backend must still contain the projected OPENAI_API_KEY key",
  );
  assert.equal(
    backend.data[storage.backendRef.key] ===
      Buffer.from(process.env.OPENAI_API_KEY).toString("base64"),
    true,
    "the selected valid model credential must remain unchanged in backing storage",
  );
}

async function assertNoLegacyModelSecret(topology) {
  const legacyName = `${modelPrefix}-${hash(topology.agent.id)}`;
  let missing = false;
  try {
    await kubectl("get", "secret", legacyName, "--namespace", topology.placement, "-o", "name");
  } catch (error) {
    assert.match(error.stderr ?? error.message, /NotFound|not found/i);
    missing = true;
  }
  assert.equal(missing, true, "Secret API model binding must replace the operator model Secret");
}

async function assertSecretApiNoLeakage(topology, secrets) {
  const [revisions, audit, configMaps] = await Promise.all([
    topology.observerPool.query(
      "SELECT admitted_spec::text AS value FROM occ.agent_revisions WHERE namespace_id = $1",
      [topology.agent.namespaceId],
    ),
    topology.observerPool.query(
      "SELECT action, resource_kind, resource_id, details::text AS details FROM occ.audit_events WHERE namespace_id = $1",
      [topology.agent.namespaceId],
    ),
    resources("configmaps", topology.placement),
  ]);
  assertNoSecretMaterial(
    revisions.rows,
    secrets,
    "PostgreSQL AgentRevision snapshots are ref-only",
  );
  assertNoSecretMaterial(audit.rows, secrets, "audit evidence must not contain secret material");
  assertNoSecretMaterial(
    configMaps,
    secrets,
    "gateway ConfigMaps must not contain secret material",
  );
  const approvedClientEnvironment = await inspectWorkloadEnvironment(
    topology.platformNamespace,
    topology.approvedClient,
  );
  assert.deepEqual(approvedClientEnvironment, {
    OPENAI_API_KEY: false,
    [secretRotationProbe]: false,
    APP_SERVER_TOKEN: false,
    APP_SERVER_URL: false,
    OPENCLAW_GATEWAY_PASSWORD: false,
  });
}

async function assertCrossNamespaceSecretBindingDenied(context, topology) {
  const namespace = await topology.adminRequest("POST", "/namespaces", {
    name: `secret-api-cross-namespace-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201, JSON.stringify(namespace.error));
  const placement = topology.kubernetesNamespaceName(namespace.data.id);
  const gatewayTarget = kubernetesGatewayNamespaceName(namespace.data.id);
  context.after(async () => {
    await kubectl("delete", "namespace", gatewayTarget, "--ignore-not-found=true", "--wait=true");
    await kubectl(
      "delete",
      "namespace",
      placement,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    );
  });
  await waitFor(`the production worker to create cross-Namespace tenant ${placement}`, async () => {
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
    `--clusterrole=${topology.controllerTenantRole}`,
    `--serviceaccount=${topology.platformNamespace}:${topology.controllerAccount}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-secret-api",
    "--namespace",
    placement,
    `--clusterrole=${topology.apiSecretRole}`,
    `--serviceaccount=${topology.platformNamespace}:${topology.apiAccount}`,
  );
  await grantGatewayWorkerTarget(
    gatewayTarget,
    topology.controllerTenantRole,
    topology.controllerAccount,
    topology.platformNamespace,
  );
  await kubectl(
    "create",
    "rolebinding",
    "canonical-secret-api",
    "--namespace",
    gatewayTarget,
    `--clusterrole=${topology.apiSecretRole}`,
    `--serviceaccount=${topology.platformNamespace}:${topology.apiAccount}`,
  );
  await waitFor(
    `the production worker to provision cross-Namespace tenant ${placement}`,
    async () => {
      const observation = await topology.adminRequest("GET", `/namespaces/${namespace.data.id}`);
      assert.equal(observation.status, 200);
      return observation.data.status === "ready" ? observation.data : undefined;
    },
  );
  const crossValue = `cross-namespace-secret-${randomUUID()}`;
  const crossSecret = await createApiSecret(
    topology.adminRequest,
    namespace.data.id,
    "cross-namespace",
    crossValue,
  );
  await createUndeployedAgent(
    topology.adminRequest,
    namespace.data.id,
    "embedded",
    `secret-api-cross-agent-${randomUUID()}`,
  );
  await grantSecretOperate(
    topology.observerPool,
    namespace.data.id,
    topology.secretApi.assignmentPrincipalId,
    crossSecret.id,
  );
  const denied = await expectApiFailureWithoutSecret(
    topology.request,
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    {
      configurationId: topology.agent.configurationId,
      harnessAuth: { method: "api_key", source: crossSecret.ref },
    },
    secretApiProtectedValues(topology, [crossValue]),
    "cross-Namespace Secret binding",
  );
  assert.equal(denied.status, 404, `unexpected cross-Namespace denial ${denied.status}`);
  const observed = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
  );
  assert.equal(observed.status, 200, JSON.stringify(observed.error));
  assert.deepEqual(
    observed.data.harnessAuth,
    topology.agent.harnessAuth,
    "cross-Namespace denial must preserve the valid same-Namespace bindings",
  );
  context.diagnostic(`secret-api cross-namespace: denied with HTTP ${denied.status}`);
}

async function assertMissingBackendSecretBindingFailsBounded(context, topology) {
  const secret = topology.secretApi.missingBackend;
  const missingValue = topology.secretApi.missingBackendValue;
  const missing = await createUndeployedAgent(
    topology.request,
    topology.agent.namespaceId,
    "embedded",
    `secret-api-missing-backend-${randomUUID()}`,
  );
  const missingAgent = await storedAgent(
    topology.observerPool,
    topology.agent.namespaceId,
    missing.agent.id,
  );
  await Promise.all([
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      topology.secretApi.assignmentPrincipalId,
      secret.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      missingAgent.servicePrincipalId,
      secret.id,
    ),
  ]);
  const stored = await storedSecret(topology.observerPool, topology.agent.namespaceId, secret.id);
  const bound = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}`,
    {
      configurationId: missing.agent.configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  );
  assert.equal(bound.status, 200, JSON.stringify(bound.error));
  assertNoSecretMaterial(
    bound,
    secretApiProtectedValues(topology),
    "missing-backend Configuration response must not leak secret material",
  );
  await kubectl(
    "delete",
    "secret",
    stored.backendRef.name,
    "--namespace",
    stored.backendRef.namespaceName,
    "--wait=true",
    "--timeout=120s",
  );
  const revisionsBefore = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/revisions`,
  );
  assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/deploy`,
  );
  assertNoSecretMaterial(
    deployed,
    secretApiProtectedValues(topology),
    "missing-backend deploy response must not leak secret material",
  );
  assert.equal(deployed.status, 503, `missing backend deploy returned HTTP ${deployed.status}`);
  const revisionsAfter = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/revisions`,
  );
  assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
  assert.deepEqual(
    revisionsAfter.data.map(({ id }) => id),
    revisionsBefore.data.map(({ id }) => id),
    "missing Secret backend must be rejected before admitting a revision",
  );
  context.diagnostic(
    `secret-api missing-backend: deploy rejected with HTTP ${deployed.status} after deleting backend ${stored.backendRef.name}`,
  );
  const agent = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}`,
  );
  assert.equal(agent.status, 200, JSON.stringify(agent.error));
  assert.equal(
    agent.data.activeRevisionId,
    undefined,
    "a missing Secret backend must not become the active Agent revision",
  );
  assertNoSecretMaterial(
    [bound, deployed, agent],
    secretApiProtectedValues(topology),
    "missing-backend diagnostics must not leak secret material",
  );
}

async function assertSecretApiNegativeRows(context, topology) {
  await assertCrossNamespaceSecretBindingDenied(context, topology);
  await assertMissingBackendSecretBindingFailsBounded(context, topology);
}

async function assertSameNamespaceSecretSharing(context, topology) {
  const peerBindings = {
    [peerSecretRotationProbe]: secretBinding(topology.secretApi.peerProbe.ref),
    [sharedSecretRotationProbe]: secretBinding(topology.secretApi.sharedProbe.ref),
  };
  const configuration = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/configurations`,
    {
      kind: "agent",
      values: nativeConfiguration("openclaw"),
    },
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await topology.request("POST", `/namespaces/${topology.agent.namespaceId}/agents`, {
    name: `secret-api-shared-consumer-${randomUUID()}`,
    configurationId: configuration.data.id,
    executionMode: "embedded",
    harnessAuth: topology.agent.harnessAuth,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const boundConfiguration = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${configuration.data.id}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: peerBindings,
    },
  );
  assert.equal(boundConfiguration.status, 200, JSON.stringify(boundConfiguration.error));
  assert.deepEqual(boundConfiguration.data.secretBindings, peerBindings);
  const updatedAgent = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/agents/${agent.data.id}`,
    {
      configurationId: boundConfiguration.data.id,
      executionMode: "embedded",
    },
  );
  assert.equal(updatedAgent.status, 200, JSON.stringify(updatedAgent.error));
  assert.equal(updatedAgent.data.configurationId, boundConfiguration.data.id);
  const persistedAgent = await storedAgent(
    topology.observerPool,
    topology.agent.namespaceId,
    agent.data.id,
  );
  await Promise.all([
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.model.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.peerProbe.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.sharedProbe.id,
    ),
  ]);
  const gatewayPassword = await provisionAgentTransportSecret(
    topology.directory,
    topology.placement,
    agent.data.id,
    { executionMode: "embedded" },
  );
  const deployed = await deployEmbeddedAgentAndWait(
    { ...topology, agent: agent.data },
    agent.data.id,
    "shared Secret consumer",
  );
  const peerTopology = {
    ...topology,
    agent: agent.data,
    persistedAgent,
    revision: deployed.revision,
    gatewayServiceName: `gateway-${hash(agent.data.id)}`,
    agentServiceName: `agent-${hash(agent.data.id)}`,
    gatewayPod: deployed.gatewayPod,
    gatewayPassword,
  };
  let forwarding = await startPortForward(
    topology.gatewayPlacement,
    peerTopology.gatewayServiceName,
  );
  context.after(() => forwarding?.stop());
  peerTopology.gatewayUrl = forwarding.url;
  peerTopology.refreshGatewayUrl = async () => {
    await forwarding?.stop();
    forwarding = await startPortForward(topology.gatewayPlacement, peerTopology.gatewayServiceName);
    return forwarding.url;
  };

  const assertEnvironmentValues = async (checks) => {
    for (const { pod, name, value, expected, message } of checks) {
      assert.deepEqual(
        await inspectEnvironmentValue(topology.placement, pod, name, value),
        expected,
        message,
      );
    }
  };

  await assertEnvironmentValues([
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the primary gateway must receive the shared sentinel before rotation",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must receive the shared sentinel before rotation",
    },
    {
      pod: topology.gatewayPod.metadata.name,
      name: peerSecretRotationProbe,
      value: topology.secretApi.initialPeerProbeValue,
      expected: { present: false, matches: false },
      message: "the primary gateway must not receive the peer Agent's private Secret binding",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: secretRotationProbe,
      value: topology.secretApi.initialProbeValue,
      expected: { present: false, matches: false },
      message: "the peer gateway must not receive the primary Agent's private Secret binding",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: peerSecretRotationProbe,
      value: topology.secretApi.initialPeerProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must receive its private Secret binding",
    },
  ]);

  const primaryPodUid = topology.gatewayPod.metadata.uid;
  const peerPodUid = peerTopology.gatewayPod.metadata.uid;
  const rotatedSharedProbeValue = `secret-rotation-shared-rotated-${randomUUID()}`;
  await updateApiSecret(
    topology.request,
    topology.agent.namespaceId,
    topology.secretApi.sharedProbe,
    rotatedSharedProbeValue,
  );
  topology.secretApi.rotatedSharedProbeValue = rotatedSharedProbeValue;
  assert.equal(
    (await resource("pod", topology.gatewayPod.metadata.name, topology.gatewayPlacement)).metadata
      .uid,
    primaryPodUid,
    "updating a shared Secret must not restart the primary consumer",
  );
  assert.equal(
    (await resource("pod", peerTopology.gatewayPod.metadata.name, topology.gatewayPlacement))
      .metadata.uid,
    peerPodUid,
    "updating a shared Secret must not restart the peer consumer",
  );
  await assertEnvironmentValues(
    [
      [topology.gatewayPod.metadata.name, "primary"],
      [peerTopology.gatewayPod.metadata.name, "peer"],
    ].flatMap(([pod, description]) => [
      {
        pod,
        name: sharedSecretRotationProbe,
        value: topology.secretApi.initialSharedProbeValue,
        expected: { present: true, matches: true },
        message: `${description} gateway must retain the old shared sentinel until it restarts`,
      },
      {
        pod,
        name: sharedSecretRotationProbe,
        value: rotatedSharedProbeValue,
        expected: { present: true, matches: false },
        message: `${description} gateway must not observe the rotated shared sentinel before restart`,
      },
    ]),
  );

  const peerRedeployed = await deployEmbeddedAgentAndWait(
    { ...topology, agent: agent.data },
    agent.data.id,
    "shared Secret consumer redeploy",
    { previousUid: peerTopology.gatewayPod.metadata.uid },
  );
  peerTopology.gatewayPod = peerRedeployed.gatewayPod;
  peerTopology.revision = peerRedeployed.revision;
  await assertEnvironmentValues([
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: rotatedSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must observe the rotated shared sentinel after its redeploy",
    },
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message:
        "the primary gateway must keep the old shared sentinel while only the peer redeploys",
    },
  ]);
  await assertActualModelTurn(peerTopology);

  const primaryRedeployed = await deployEmbeddedAgentAndWait(
    topology,
    topology.agent.id,
    "primary shared Secret consumer redeploy",
    { previousUid: topology.gatewayPod.metadata.uid },
  );
  topology.gatewayPod = primaryRedeployed.gatewayPod;
  topology.revision = primaryRedeployed.revision;
  await assertEnvironmentValues([
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: rotatedSharedProbeValue,
      expected: { present: true, matches: true },
      message:
        "the primary gateway must observe the rotated shared sentinel after its own redeploy",
    },
  ]);

  for (const [secret, value, description] of [
    [topology.secretApi.model, process.env.OPENAI_API_KEY, "shared model Secret delete"],
    [topology.secretApi.sharedProbe, rotatedSharedProbeValue, "shared sentinel Secret delete"],
    [
      topology.secretApi.peerProbe,
      topology.secretApi.initialPeerProbeValue,
      "peer probe Secret delete",
    ],
  ]) {
    const deleted = await expectApiFailureWithoutSecret(
      topology.request,
      "DELETE",
      `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
      undefined,
      [value],
      description,
    );
    assert.equal(deleted.status, 409);
  }
  await assertSecretApiNoLeakage(topology, secretApiProtectedValues(topology));
  context.diagnostic(
    `secret-api sharing: shared model ${topology.secretApi.model.ref.id} powered selected Agents ${topology.agent.id} and ${agent.data.id}`,
  );
}

async function assertUnboundSecretDeletion(context, topology) {
  const value = topology.secretApi.unboundDeleteValue;
  const secret = topology.secretApi.unboundDelete;
  const stored = await storedSecret(topology.observerPool, topology.agent.namespaceId, secret.id);
  // An unbound Secret can be removed through OCC; the real driver must delete its exact backend.
  const deleted = await topology.request(
    "DELETE",
    `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
  );
  assertNoSecretMaterial(deleted, [value], "Secret deletion must return no material");
  assert.equal(deleted.status, 204);
  const read = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
  );
  assert.equal(read.status, 404);
  await assert.rejects(
    () =>
      kubectl(
        "get",
        "secret",
        stored.backendRef.name,
        "--namespace",
        topology.placement,
        "-o",
        "name",
      ),
    (error) => /NotFound/.test(error.stderr ?? ""),
  );
  context.diagnostic(
    "secret-api deletion: unbound OCC metadata and exact Kubernetes backend removed",
  );
}

async function assertSecretApiRotationAndRedeploy(context, topology) {
  const { model, probe, initialProbeValue } = topology.secretApi;
  const [modelStorage, probeStorage] = await Promise.all([
    storedSecret(topology.observerPool, topology.agent.namespaceId, model.id),
    storedSecret(topology.observerPool, topology.agent.namespaceId, probe.id),
  ]);
  assert.equal(Object.hasOwn(modelStorage, "agentId"), false);
  assert.equal(Object.hasOwn(probeStorage, "agentId"), false);

  await assertModelRuntimeProjection(topology.gatewayPod, modelStorage);
  assert.notEqual(modelStorage.backendRef.name, `${modelPrefix}-${hash(topology.agent.id)}`);
  await assertNoLegacyModelSecret(topology);

  const initialProbe = await inspectEnvironmentValue(
    topology.gatewayPlacement,
    topology.gatewayPod.metadata.name,
    secretRotationProbe,
    initialProbeValue,
  );
  assert.deepEqual(initialProbe, { present: true, matches: true });

  const rotatedProbeValue = `secret-rotation-rotated-${randomUUID()}`;
  const beforePodUid = topology.gatewayPod.metadata.uid;
  const beforeRevisions = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(beforeRevisions.status, 200, JSON.stringify(beforeRevisions.error));
  await updateApiSecret(topology.request, topology.agent.namespaceId, probe, rotatedProbeValue);
  const afterAgent = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
  );
  assert.equal(afterAgent.status, 200, JSON.stringify(afterAgent.error));
  assert.equal(afterAgent.data.activeRevisionId, topology.revision.id);
  const samePod = await resource(
    "pod",
    topology.gatewayPod.metadata.name,
    topology.gatewayPlacement,
  );
  assert.equal(samePod.metadata.uid, beforePodUid);
  const afterRevisions = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(afterRevisions.status, 200, JSON.stringify(afterRevisions.error));
  assert.deepEqual(
    afterRevisions.data.map(({ id }) => id),
    beforeRevisions.data.map(({ id }) => id),
    "Secret update must not admit a new revision or restart the running gateway",
  );
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      initialProbeValue,
    ),
    { present: true, matches: true },
  );
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: false },
  );

  // Deleting only this task-owned Pod proves an already-admitted revision restarts with the latest Secret.
  await kubectl(
    "delete",
    "pod",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.gatewayPlacement,
    "--wait=true",
    "--timeout=120s",
  );
  topology.gatewayPod = await waitForReadyGatewayPod(topology, topology.revision.id, beforePodUid);
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: true },
  );

  // A different OCC Secret reference containing the same authorized key proves draft/revision
  // isolation. This is binding replacement, not proof of upstream key rotation or revocation.
  const previousRevision = structuredClone(topology.revision);
  const replacement = await createApiSecret(
    topology.request,
    topology.agent.namespaceId,
    "replacement-model-source",
    process.env.OPENAI_API_KEY,
  );
  await Promise.all(
    [topology.secretApi.assignmentPrincipalId, topology.persistedAgent.servicePrincipalId].map(
      (principalId) =>
        grantSecretOperate(
          topology.observerPool,
          topology.agent.namespaceId,
          principalId,
          replacement.id,
        ),
    ),
  );
  const rebound = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    {
      configurationId: topology.agent.configurationId,
      harnessAuth: { method: "api_key", source: replacement.ref },
    },
  );
  assert.equal(rebound.status, 200, JSON.stringify(rebound.error));
  assert.equal(rebound.data.activeRevisionId, previousRevision.id);
  assert.equal(
    (await resource("pod", topology.gatewayPod.metadata.name, topology.gatewayPlacement)).metadata
      .uid,
    topology.gatewayPod.metadata.uid,
    "draft binding changes cannot restart an active process",
  );
  const unchanged = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions/${previousRevision.id}`,
  );
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.data.harnessAuth, previousRevision.harnessAuth);
  const retained = await topology.request(
    "DELETE",
    `/namespaces/${topology.agent.namespaceId}/secrets/${model.id}`,
  );
  assert.equal(retained.status, 409, "active and sibling consumers must retain the former source");
  topology.agent = rebound.data;

  const secondRevision = await deployEmbeddedAgentAndWait(
    topology,
    topology.agent.id,
    "Secret-backed embedded redeploy",
    {
      previousUid: topology.gatewayPod.metadata.uid,
      protectedValues: secretApiProtectedValues(topology, [rotatedProbeValue]),
    },
  );
  assert.notEqual(secondRevision.revision.id, topology.revision.id);
  topology.gatewayPod = secondRevision.gatewayPod;
  topology.revision = secondRevision.revision;
  topology.secretApi.model = replacement;
  assert.deepEqual(topology.revision.harnessAuth, topology.agent.harnessAuth);
  const historical = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions/${previousRevision.id}`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data.harnessAuth, previousRevision.harnessAuth);
  await assertActualModelTurn(topology);
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: true },
  );
  await assertSecretApiNoLeakage(topology, [
    process.env.OPENAI_API_KEY,
    initialProbeValue,
    rotatedProbeValue,
  ]);
  const deleteBound = await expectApiFailureWithoutSecret(
    topology.request,
    "DELETE",
    `/namespaces/${topology.agent.namespaceId}/secrets/${probe.id}`,
    undefined,
    [process.env.OPENAI_API_KEY, rotatedProbeValue],
    "bound Secret delete",
  );
  assert.equal(deleteBound.status, 409);
  context.diagnostic(
    `secret-api rotation: stable ref ${probe.ref.id}; same-revision restart and explicit deploy consumed latest value`,
  );
}

async function assertNativeReferenceNegativeControl(context, topology) {
  const revisionsPath = `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`;
  const before = await topology.request("GET", revisionsPath);
  assert.equal(before.status, 200);
  const invalid = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("openclaw", undefined, {
        modelEnvName: "SECRET_API_DISABLED_OPENAI_KEY",
      }),
      secretBindings: topology.secretApi.configuration.secretBindings,
    },
  );
  assert.equal(invalid.status, 200, JSON.stringify(invalid.error));
  const denied = await expectApiFailureWithoutSecret(
    topology.request,
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
    undefined,
    secretApiProtectedValues(topology),
    "competing native model credential selector",
  );
  assert.equal(denied.status, 409, "harnessAuth must remain the sole model-auth selector");
  const after = await topology.request("GET", revisionsPath);
  assert.equal(after.status, 200);
  assert.deepEqual(
    after.data,
    before.data,
    "a competing selector cannot admit or rewrite a revision",
  );
  const active = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
  );
  assert.equal(active.status, 200);
  assert.equal(active.data.activeRevisionId, topology.revision.id);
  const gateway = await resource(
    "pod",
    topology.gatewayPod.metadata.name,
    topology.gatewayPlacement,
  );
  assert.equal(gateway.metadata.uid, topology.gatewayPod.metadata.uid);
  await assertOpenAiKeyProjectedFromSecret(topology, gateway);
  const restored = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: topology.secretApi.configuration.secretBindings,
    },
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.error));
  const recovered = await deployEmbeddedAgentAndWait(
    topology,
    topology.agent.id,
    "canonical native model credential reference",
    { previousUid: topology.gatewayPod.metadata.uid },
  );
  topology.gatewayPod = recovered.gatewayPod;
  topology.revision = recovered.revision;
  await assertActualModelTurn(topology);
  context.diagnostic(
    "competing native credential selector denied before revision admission; canonical reference served a real model turn",
  );
}

async function assertLegacyModelSecretBindingDenied(topology) {
  const value = `dedicated-denied-secret-${randomUUID()}`;
  const secret = await createApiSecret(
    topology.request,
    topology.agent.namespaceId,
    "dedicated-model-denied",
    value,
  );
  await grantSecretOperate(
    topology.observerPool,
    topology.agent.namespaceId,
    topology.persistedAgent.servicePrincipalId,
    secret.id,
  );
  await grantSecretOperate(
    topology.observerPool,
    topology.agent.namespaceId,
    topology.secretApi.assignmentPrincipalId,
    secret.id,
  );
  const revisionsBefore = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
  const bound = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("codex"),
      secretBindings: { OPENAI_API_KEY: secretBinding(secret.ref) },
    },
  );
  assert.equal(bound.status, 404, "Configuration cannot select model authentication");
  assertNoSecretMaterial(bound, [value, process.env.OPENAI_API_KEY], "legacy model binding denial");
  const revisionsAfter = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
  assert.deepEqual(
    revisionsAfter.data.map(({ id }) => id),
    revisionsBefore.data.map(({ id }) => id),
    "dedicated model Secret binding denial must happen before revision mutation",
  );
  const gateway = await resource(
    "pod",
    topology.gatewayPod.metadata.name,
    topology.gatewayPlacement,
  );
  const harness = await resource("pod", topology.harnessPod.metadata.name, topology.placement);
  assert.equal(gateway.metadata.uid, topology.gatewayPod.metadata.uid);
  assert.equal(harness.metadata.uid, topology.harnessPod.metadata.uid);
}

async function assertDedicatedWorkspaceRuntime(context, topology, claim, privateClaim) {
  const nonce = `split-${randomUUID()}`;
  const gatewayPod = topology.gatewayPod.metadata.name;
  let harnessPod = topology.harnessPod.metadata.name;
  const workspaceFromGateway = "/home/node/workspace/AGENTS.md";
  const workspaceFromHarness = `/home/node/workspace/harness-${nonce}.txt`;
  const harnessContent = randomBytes(24).toString("hex");
  const opened = await gatewayCall(topology, "agents.files.get", {
    agentId: "main",
    name: "AGENTS.md",
  });
  assert.equal(opened.file.missing, false);
  const ownerContent = `${opened.file.content}\n<!-- ${nonce} -->\n`;
  await gatewayCall(topology, "agents.files.set", {
    agentId: "main",
    name: "AGENTS.md",
    content: ownerContent,
    expectedHash: opened.file.hash,
  });
  assert.equal(
    await readFileInPod(topology.placement, harnessPod, workspaceFromGateway),
    ownerContent,
    "owner edits through Gateway must reach the Harness file",
  );
  assert.equal(
    (await inspectFileInPod(topology.gatewayPlacement, gatewayPod, workspaceFromGateway)).exists,
    false,
    "Gateway must not retain a local workspace copy",
  );

  // The expected content is absent from the prompt: a real tool read must supply it.
  await writeFileInPod(topology.placement, harnessPod, workspaceFromHarness, harnessContent);
  await context.test("model reads and writes through the native sandbox", async () => {
    const probeMarker = `SANDBOX-${randomUUID()}`;
    const workspaceOutput = `/home/node/workspace/sandbox-${nonce}.txt`;
    const outsideSentinel = `/home/node/codex-sandbox-outside-${nonce}.txt`;
    const outsideContent = `outside-${randomBytes(24).toString("hex")}\n`;
    const workspaceOutputContent = `${probeMarker}-workspace-write\n`;
    await writeFileInPod(topology.placement, harnessPod, outsideSentinel, outsideContent);
    try {
      const script = [
        "const fs=require('node:fs')",
        `const source=${JSON.stringify(workspaceFromHarness)}`,
        `const output=${JSON.stringify(workspaceOutput)}`,
        `const outside=${JSON.stringify(outsideSentinel)}`,
        `const marker=${JSON.stringify(probeMarker)}`,
        `const outputContent=${JSON.stringify(workspaceOutputContent)}`,
        "const content=fs.readFileSync(source,'utf8')",
        "fs.writeFileSync(output,outputContent)",
        "let denied='NO_ERROR'",
        "try{fs.writeFileSync(outside,'escaped\\n')}catch(error){denied=error.code||error.name}",
        "if(denied==='NO_ERROR'){console.error('outside workspace write unexpectedly succeeded');process.exit(70)}",
        "process.stdout.write('PROBE '+marker+'\\nREAD:'+content+'\\nWRITE:'+outputContent+'DENIED:'+denied+'\\n')",
      ].join(";");
      const scriptArgument = `'${script.replaceAll("'", "'\"'\"'")}'`;
      const command = `timeout 60s node -e ${scriptArgument}`;
      const sandboxSession = `enterprise-workspace-sandbox-${randomUUID()}`;
      const response = await requestDedicatedAgentTurn(
        topology,
        sandboxSession,
        `Use your native Harness shell tool to run exactly this one command from /home/node/workspace, then return the command output without adding another command:\n${command}\nThe source file is local to your working environment. Do not use Gateway network file-transfer tools, do not supply Gateway connection settings, and do not request escalated execution.`,
      );
      assert.ok(
        response.includes(harnessContent),
        `The model did not return the Harness file contents. Response: ${response.slice(0, 1500)}`,
      );
      assert.ok(response.includes(probeMarker));
      assert.ok(response.includes("DENIED:"));
      const history = await gatewayCall(topology, "chat.history", {
        sessionKey: sandboxSession,
        limit: 100,
      });
      assertNativeToolSucceeded(history, probeMarker, harnessContent);
      assert.equal(
        await readFileInPod(topology.placement, harnessPod, workspaceOutput),
        workspaceOutputContent,
        "native workspace-write execution must create the expected workspace bytes",
      );
      assert.equal(
        await readFileInPod(topology.placement, harnessPod, outsideSentinel),
        outsideContent,
        "outside-workspace sentinel must remain unchanged after the sandboxed command",
      );
    } finally {
      await execNode(
        topology.placement,
        harnessPod,
        `
          const { rmSync } = require("node:fs");
          for (const file of ${JSON.stringify([workspaceOutput, outsideSentinel])}) {
            rmSync(file, { force: true });
          }
        `,
      );
    }
  });

  const privateSession = `/home/node/.openclaw/agents/main/sessions/gateway-${nonce}.json`;
  await writeFileInPod(
    topology.gatewayPlacement,
    gatewayPod,
    privateSession,
    JSON.stringify({ nonce }),
  );
  assert.equal(
    (await inspectFileInPod(topology.placement, harnessPod, privateSession)).exists,
    false,
    "Harness must not see Gateway session files",
  );

  const [harnessPrivate, gatewayPrivate] = await Promise.all([
    execNode(
      topology.placement,
      harnessPod,
      'process.stdout.write(String(require("node:fs").existsSync("/home/node/.openclaw/openclaw.json")))',
    ),
    execNode(
      topology.gatewayPlacement,
      gatewayPod,
      'const fs=require("node:fs");process.stdout.write(JSON.stringify({auth:fs.existsSync("/home/node/.codex/auth.json"),config:fs.existsSync("/home/node/.codex/config.toml")}))',
    ),
  ]);
  assert.equal(harnessPrivate, "false", "Codex must not see private gateway state");
  assert.deepEqual(JSON.parse(gatewayPrivate), { auth: false, config: false });

  await context.test("attachment bytes and same-session continuation", async () => {
    // Bytes beyond a preview must reach the Harness, return as a managed artifact,
    // and remain usable in the same model session. Compare independent exact bytes.
    const attachmentSession = `agent:main:attachment-${randomUUID()}`;
    const attachmentNonce = `OCE-ATTACHMENT-${randomUUID()}`;
    const attachmentInput = `${randomBytes(35000).toString("hex")}\n`;
    const attachmentOutput = `${attachmentInput}VERIFIED\n`;
    const outputPath = `/home/node/workspace/media/outbound/${nonce}.txt`;
    await gatewayCall(topology, "chat.send", {
      sessionKey: attachmentSession,
      idempotencyKey: randomUUID(),
      message: `Use your native Harness shell and the installed Node.js runtime to read the ORIGINAL attached file from its staged path, not its preview. Python is not installed. The staged file is local to this Harness; do not fetch it through Gateway network file-transfer tools. Write ${outputPath} with exactly those bytes followed by VERIFIED and a newline. Return ${attachmentNonce} on one line and MEDIA:${outputPath} on a separate line beginning with MEDIA:, without code fences. Do not edit other files or access external services.`,
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          fileName: `${nonce}.txt`,
          content: Buffer.from(attachmentInput).toString("base64"),
        },
      ],
    });
    const attachmentHistory = await assertConversation(
      topology,
      attachmentSession,
      attachmentNonce,
    );
    assert.equal(await readFileInPod(topology.placement, harnessPod, outputPath), attachmentOutput);
    const attachmentSeq = assistantMessageContaining(attachmentHistory, attachmentNonce)?.__openclaw
      ?.seq;
    assert.equal(typeof attachmentSeq, "number");
    await assertRetainedArtifact(topology, attachmentSession, {
      messageSeq: attachmentSeq,
      expectedType: "file",
      expectedMimeType: "text/plain",
      expectedData: Buffer.from(attachmentOutput).toString("base64"),
    });
    const continuation = await requestDedicatedAgentTurn(
      topology,
      attachmentSession,
      `Use native file tools to compute the SHA-256 of the output file from the previous turn. Return its digest. Do not modify it.`,
    );
    assert.ok(continuation.includes(createHash("sha256").update(attachmentOutput).digest("hex")));
    process.stderr.write(
      "k3d dedicated: attachment processing, exact download and model continuation passed.\n",
    );
  });

  await context.test("Memory search reads the remote workspace", async () => {
    // The confirmation is absent from the prompt and only exists on the Harness.
    // Native FTS indexing/search must bridge that source to Gateway-owned Memory.
    const memoryKey = `memory${randomBytes(12).toString("hex")}`;
    const memoryValue = randomBytes(24).toString("hex");
    const memoryFile = `/home/node/workspace/memory/${memoryKey}.md`;
    await writeFileInPod(
      topology.placement,
      harnessPod,
      memoryFile,
      `# ${memoryKey}\n\nThe confirmation for ${memoryKey} is ${memoryValue}.\n`,
    );
    assert.equal(
      (await inspectFileInPod(topology.gatewayPlacement, gatewayPod, memoryFile)).exists,
      false,
    );
    const memorySession = `agent:main:memory-${randomUUID()}`;
    await waitFor("native Memory retrieval from the Harness workspace", async () => {
      const answer = await requestDedicatedAgentTurn(
        topology,
        memorySession,
        `Use memory_search to find the confirmation for ${memoryKey}. Return its source path and snippet. Do not use shell or file tools, edit files, or rebuild the index.`,
      );
      return answer.includes(memoryValue) ? answer : undefined;
    });
    const memoryHistory = await gatewayCall(topology, "chat.history", {
      sessionKey: memorySession,
      limit: 100,
    });
    assert.ok(
      memoryHistory.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "memory_search" &&
          messageText(message).includes(memoryValue),
      ),
      "the actual Memory tool result must contain the unprompted Harness marker",
    );
    process.stderr.write(
      "k3d dedicated: native Memory FTS retrieved the unprompted Harness marker.\n",
    );
  });

  await context.test("Skill installation runs on the remote Harness", async () => {
    // Installation is an owner operation through Gateway; the fresh model then
    // invokes the installed dependency by name in the remote Harness workspace.
    const skillName = `storage-cowsay-${randomBytes(8).toString("hex")}`;
    const skillFile = `/home/node/workspace/skills/${skillName}/SKILL.md`;
    await writeFileInPod(
      topology.placement,
      harnessPod,
      skillFile,
      `---\nname: ${skillName}\ndescription: Print a synthetic storage verification message with cowsay.\nmetadata: ${JSON.stringify({ openclaw: { requires: { bins: ["cowsay"] }, install: [{ id: "node", kind: "node", package: "cowsay@1.6.0", bins: ["cowsay"] }] } })}\n---\nRun cowsay by command name with the requested message.\n`,
    );
    const skillStatus = await gatewayCall(topology, "skills.status", { agentId: "main" });
    assert.ok(
      skillStatus.skills.some((skill) => skill.name === skillName && skill.filePath === skillFile),
    );
    const installed = await gatewayCall(topology, "skills.install", {
      agentId: "main",
      name: skillName,
      installId: "node",
      timeoutMs: 120000,
    });
    assert.equal(installed.ok, true);
    const installedCommand = await inspectFileInPod(
      topology.placement,
      harnessPod,
      "/home/node/.openclaw/tools/node/npm/bin/cowsay",
    );
    process.stderr.write(
      `k3d dedicated: installed Skill executable ${JSON.stringify({
        exists: installedCommand.exists,
        sizeBytes: installedCommand.sizeBytes,
      })}\n`,
    );
    process.stderr.write(
      `k3d dedicated: Skill runtime PATH admission ${await execNode(
        topology.placement,
        harnessPod,
        `const fs = require("node:fs"); const rows = [];
      for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
        try {
          const name = fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim();
          if (name !== "node" && name !== "codex") continue;
          const env = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\\0");
          const path = env.find(value => value.startsWith("PATH=")) ?? "";
          rows.push({pid, name, managedBin: path.includes("/home/node/.openclaw/tools/node/npm/bin"), localBin: path.includes("/home/node/.local/bin")});
        } catch {}
      }
      process.stdout.write(JSON.stringify(rows));`,
      )}\n`,
    );
    const skillNonce = `OCE-SKILL-${randomBytes(8).toString("hex")}`;
    const skillSession = `agent:main:skill-${randomUUID()}`;
    const skillAnswer = await requestDedicatedAgentTurn(
      topology,
      skillSession,
      `Read the ${skillName} Skill, then run cowsay ${skillNonce} by command name. Do not set PATH, use an absolute binary path, install packages yourself, or edit other files. Return the actual command output. If the command is unavailable, also report the actual shell PATH for diagnosis.`,
    );
    assert.ok(skillAnswer.includes(skillNonce));
    const skillHistory = await gatewayCall(topology, "chat.history", {
      sessionKey: skillSession,
      limit: 100,
    });
    assert.ok(
      skillHistory.messages.some(
        (message) =>
          message.role === "toolResult" &&
          messageText(message).includes(skillNonce) &&
          messageText(message).includes("(oo)"),
      ),
      "a successful native tool result must include actual cowsay output",
    );
    assert.equal(
      (await inspectFileInPod(topology.gatewayPlacement, gatewayPod, skillFile)).exists,
      false,
    );
    process.stderr.write(
      "k3d dedicated: owner Skill installation and real Harness command execution passed.\n",
    );
  });

  await kubectl(
    "delete",
    "pod",
    harnessPod,
    "--namespace",
    topology.placement,
    "--wait=true",
    "--timeout=120s",
  );
  const restartedHarness = await waitForReadyAgentPod(
    topology,
    topology.revision.id,
    topology.harnessPod.metadata.uid,
  );
  harnessPod = restartedHarness.metadata.name;
  assert.equal(
    await readFileInPod(topology.placement, harnessPod, workspaceFromGateway),
    ownerContent,
  );
  const reconnected = await gatewayCall(topology, "agents.files.get", {
    agentId: "main",
    name: "AGENTS.md",
  });
  assert.equal(reconnected.file.content, ownerContent, "paired node must reconnect after restart");

  const secondRevision = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(secondRevision.status, 202, JSON.stringify(secondRevision.error));
  assert.notEqual(secondRevision.data.id, topology.revision.id);
  await waitFor(`second dedicated revision ${secondRevision.data.id} activation`, async () => {
    const observation = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === secondRevision.data.id
      ? observation.data
      : undefined;
  });
  await waitFor(`worker completion of second dedicated revision ${secondRevision.data.id}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === secondRevision.data.id &&
        event.outcome === "success",
    ),
  );
  const preservedClaim = await resource(
    "persistentvolumeclaim",
    claim.metadata.name,
    topology.placement,
  );
  assert.equal(
    preservedClaim.metadata.uid,
    claim.metadata.uid,
    "Agent revisions must reuse the same PVC",
  );
  assert.equal(
    (await resource("persistentvolumeclaim", privateClaim.metadata.name, topology.gatewayPlacement))
      .metadata.uid,
    privateClaim.metadata.uid,
    "replacing an Agent revision must preserve the exact gateway-private claim",
  );
  const nextHarness = await waitForReadyAgentPod(
    topology,
    secondRevision.data.id,
    restartedHarness.metadata.uid,
  );
  assert.equal(
    await readFileInPod(topology.placement, nextHarness.metadata.name, workspaceFromHarness),
    harnessContent,
  );
  const afterRevision = await gatewayCall(topology, "agents.files.get", {
    agentId: "main",
    name: "AGENTS.md",
  });
  assert.equal(
    afterRevision.file.content,
    ownerContent,
    "new revision must enroll its workspace node",
  );
  context.diagnostic(
    `Harness workspace and Gateway-private state persisted across restart and revision: ${claim.metadata.name}`,
  );
}

async function assertRoutedWorkspaceFilesThroughOcc(topology, connection) {
  const marker = `occ-agents-${hash(randomUUID())}`;
  const files = new Map([
    [
      "AGENTS.md",
      `When asked for the configured workspace marker, reply exactly ${marker} and no other text.\n`,
    ],
    ["SOUL.md", `Workspace soul proof ${randomUUID()}.\n`],
    ["IDENTITY.md", `Workspace identity proof ${randomUUID()}.\n`],
    ["USER.md", `Workspace user proof ${randomUUID()}.\n`],
  ]);
  const basePath = `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/workspace/files`;
  for (const [name, content] of files) {
    const written = await topology.workspaceRequest("PUT", `${basePath}/${name}`, { content });
    assert.equal(written.status, 200, JSON.stringify(written.error));
    assert.deepEqual(written.data, { name, size: Buffer.byteLength(content, "utf8") });
  }
  await assertRoutedWorkspaceFileReads(topology, files);
  await assertRoutedWorkspaceModelTurn(topology, connection, marker);
  return { marker, files };
}

async function assertRoutedWorkspaceFileReads(topology, files) {
  const basePath = `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/workspace/files`;
  for (const [name, content] of files) {
    const observed = await topology.workspaceRequest("GET", `${basePath}/${name}`);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    assert.deepEqual(observed.data, { name, content });
  }
}

async function assertRoutedWorkspaceModelTurn(topology, connection, marker) {
  const turn = await connection.requestModelTurn(marker);
  assertNoSecretMaterial(
    turn.content,
    [topology.gatewayPassword, topology.workspaceGateway.apiKey, process.env.OPENAI_API_KEY],
    "workspace-file model proof must not expose credentials",
  );
}

export {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertDedicatedAgentsInstructionsInFreshSession,
  assertLegacyModelSecretBindingDenied,
  assertDedicatedWorkspaceResources,
  assertDedicatedWorkspaceRuntime,
  assertDeniedConnection,
  assertEmbeddedCreatesNoHarnessWorkspaceClaim,
  assertGatewayPodContinuity,
  assertGatewayPrivateResources,
  assertKubernetesOtelLogs,
  assertInvalidHarnessAuthStaysUnready,
  assertNativeReferenceNegativeControl,
  assertPrivateStateInitContainer,
  assertRoutedWorkspaceFileReads,
  assertRoutedWorkspaceFilesThroughOcc,
  assertRoutedWorkspaceModelTurn,
  assertSameNamespaceSecretSharing,
  assertSecretApiNegativeRows,
  assertSecretApiRotationAndRedeploy,
  assertStartupFailureDeploymentStatusDurable,
  assertUnauthorizedCodexSocket,
  assertUnboundSecretDeletion,
  hash,
  inspectProjectedIdentity,
  inspectWorkloadEnvironment,
  kubectl,
  modelPrefix,
  requiresGatewayRouting,
  requiresNativeAdminRouting,
  requiresLiveSlack,
  requiresProductionCluster,
  requiresProductionClusterOtelLogs,
  resource,
  resources,
  secretRotationProbe,
  storedSecret,
  slackApi,
  waitFor,
  waitForReadyGatewayPod,
};
