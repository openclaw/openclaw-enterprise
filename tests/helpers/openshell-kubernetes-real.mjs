import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
} from "./kubernetes-real.mjs";

const execute = promisify(execFile);
const sandboxApiResource = "sandboxes.agents.x-k8s.io";
const harnessPort = 18790;
const gatewayPort = 8080;
const transportSecretPrefix = "openclaw-agent-transport";

const requiredWorkspaceMounts = Object.freeze([
  {
    subPath: "bundled-skills",
    mountPath: "/home/node/openclaw-runtime-assets/bundled-skills",
    readOnly: true,
  },
  {
    subPath: "generated-images",
    mountPath: "/home/node/.codex/generated_images",
    readOnly: false,
  },
  {
    subPath: "plugin-skills",
    mountPath: "/home/node/openclaw-runtime-assets/plugin-skills",
    readOnly: true,
  },
  {
    subPath: "sessions",
    mountPath: "/home/node/.openclaw/agents/main/sessions",
    readOnly: true,
  },
  { subPath: "workspace", mountPath: "/home/node/workspace", readOnly: false },
]);

export function openshellHash(value, length = 12) {
  return sha256Hex(value, length);
}

export function openShellAgentName(agentId) {
  return `agent-${openshellHash(agentId)}`;
}

export function openShellGatewayName(agentId) {
  return `gateway-${openshellHash(agentId)}`;
}

export function openShellRevisionName(revision) {
  return `${openShellAgentName(revision.agentId)}-rev-${openshellHash(revision.id)}`;
}

export function createOpenShellServiceLoopbackLookup(serviceHostname) {
  const expectedHostname = serviceHostname.toLowerCase();

  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname) {
      const error = new Error(`Refusing to resolve unexpected OpenShell hostname ${hostname}.`);
      error.code = "ENOTFOUND";
      callback(error);
      return;
    }

    const address = { address: "127.0.0.1", family: 4 };
    if (typeof options === "object" && options.all === true) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

// Model egress comes only from the credential source's OpenShell profile, bound to this binary.
export const OPENSHELL_CODEX_BINARY =
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.160.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex";

export function createOpenShellInstallationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  openShellRuntimeClass = "openshell-sandbox",
  cluster,
}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster,
  });
  configuration.drivers.configuration.id = "configuration-kubernetes-production";
  configuration.drivers.compute.id = "compute-kubernetes-production";
  // The real Gateway loads its plugins and installs the native worker bundle during the first turn.
  configuration.drivers.compute.configuration.resources.gateway.limits.memory = "4Gi";
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "14",
    "requests.cpu": "3",
    "requests.memory": "3Gi",
    "limits.cpu": "16",
    "limits.memory": "8Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 3600;
  // The integration replaces this placeholder transport with each namespace's port-forward.
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      // The fixture gateway is in-cluster HTTP isolated by the suite's NetworkPolicies.
      configuration: { endpoint: "http://127.0.0.1:1", insecureTransport: "network-policy" },
      drivers: {
        sandbox: "sandbox-openshell-kubernetes",
        credential_gateway: "credential-gateway-openshell-kubernetes",
      },
    },
  ];
  configuration.drivers.credential_gateway = {
    id: "credential-gateway-openshell-kubernetes",
    configuration: { binaries: [OPENSHELL_CODEX_BINARY] },
  };
  configuration.drivers.sandbox = {
    id: "sandbox-openshell-kubernetes",
    configuration: {
      gateway: {
        workspaceMode: "operator",
        readiness: {
          serviceName: "openshell-gateway",
          podSelector: { "app.kubernetes.io/name": "openshell" },
        },
        // Compute owns ordinary Harness DNS; OpenShell's own `openshell-sandbox-supervisors`
        // policy covers supervisor egress, and the installer scopes gateway DNS/API access below.
        networkPolicyResources: [],
      },
      kubernetes: {
        runtimeClassName: openShellRuntimeClass,
        // Match the Compute-owned Harness budget. The cluster's 1 GiB default
        // can OOM-kill a real worker while it installs the Gateway bundle.
        agentResources: structuredClone(
          configuration.drivers.compute.configuration.resources.agent,
        ),
        // TODO(OpenShell per-Sandbox ServiceAccount support): replace the shared gateway setting
        // with Compute's exact Agent ServiceAccount on each Sandbox request.
        serviceAccount: { mode: "gatewayConfigured" },
        // TODO(OpenShell existing-workspace support): remove this fixture-only mount once upstream
        // can reuse approved Enterprise workspace subpaths without requiring a /sandbox alias.
        sandboxDataMount: {
          claimName: "workspace-placeholder",
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
        userNamespaces: false,
      },
      policy: {
        filesystem: {
          includeWorkdir: true,
          readOnly: ["/app"],
          readWrite: ["/home/node/.codex", "/dev/null"],
        },
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "openclaw",
            endpoints: [{ host: "www.openclaw.org", ports: [443], tls: "skip" }],
            binaries: [{ path: "/usr/bin/curl" }],
          },
        ],
      },
      sandboxNamePrefix: "os",
    },
  };
  return configuration;
}

export function openShellChartImageValues(prefix, image) {
  assert.ok(image, `${prefix}.repository requires an explicit OpenShell image.`);
  const digest = image.match(/@sha256:[a-f0-9]{64}$/i)?.[0];
  assert.ok(digest, `${prefix}.digest requires an immutable OpenShell image digest.`);
  const withoutDigest = image.slice(0, -digest.length);
  const firstSlash = withoutDigest.indexOf("/");
  assert.ok(firstSlash > 0, `${prefix}.registry requires a qualified OpenShell image.`);
  const registry = withoutDigest.slice(0, firstSlash);
  const repositoryWithTag = withoutDigest.slice(firstSlash + 1);
  const tagSeparator = repositoryWithTag.lastIndexOf(":");
  const repository =
    tagSeparator === -1 ? repositoryWithTag : repositoryWithTag.slice(0, tagSeparator);
  return [
    `--set-string=${prefix}.registry=${registry}`,
    `--set-string=${prefix}.repository=${repository}`,
    `--set-string=${prefix}.digest=${digest.slice(1)}`,
  ];
}

function renderedOpenShellImage(image) {
  const digest = image.match(/@sha256:[a-f0-9]{64}$/i)?.[0];
  assert.ok(digest, "OpenShell image reference must include an immutable digest.");
  const withoutDigest = image.slice(0, -digest.length);
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagSeparator = withoutDigest.lastIndexOf(":");
  if (tagSeparator > lastSlash) {
    return `${withoutDigest.slice(0, tagSeparator)}${digest}`;
  }
  return `${withoutDigest}${digest}`;
}

function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRenderedOpenShellImages({
  gatewayPod,
  statefulSet,
  configMap,
  gatewayImage,
  sandboxImage,
  supervisorImage,
  defaultTag,
}) {
  const expectedGatewayImage = renderedOpenShellImage(gatewayImage);
  const expectedSandboxImage = renderedOpenShellImage(sandboxImage);
  const expectedSupervisorImage = renderedOpenShellImage(supervisorImage);
  assert.equal(
    statefulSet.metadata?.labels?.["app.kubernetes.io/version"],
    defaultTag,
    "OpenShell gateway StatefulSet must retain the pinned chart application version.",
  );
  assert.equal(
    statefulSet.spec?.template?.spec?.containers?.find(({ name }) => name === "openshell-gateway")
      ?.image,
    expectedGatewayImage,
    "OpenShell gateway StatefulSet image must retain the imported immutable digest after Helm rendering.",
  );
  assert.equal(
    gatewayPod.spec?.containers?.find(({ name }) => name === "openshell-gateway")?.image,
    expectedGatewayImage,
    "OpenShell gateway Pod image must retain the imported immutable digest after Helm rendering.",
  );
  assert.match(
    configMap.data?.["gateway.toml"] ?? "",
    new RegExp(
      `sandbox_runtime_image\\s*=\\s*${regexpEscape(JSON.stringify(expectedSandboxImage))}`,
    ),
    "OpenShell sandbox runtime image in gateway.toml must retain the imported immutable digest after Helm rendering.",
  );
  assert.match(
    configMap.data?.["gateway.toml"] ?? "",
    new RegExp(`supervisor_image\\s*=\\s*${regexpEscape(JSON.stringify(expectedSupervisorImage))}`),
    "OpenShell supervisor image in gateway.toml must retain the imported immutable digest after Helm rendering.",
  );
}

function openShellGatewayServiceName(namespace) {
  return `openshell-${openshellHash(namespace, 10)}`;
}

// OpenShell v0.1.3-pre.1 runs a separate supervisor Pod per Sandbox; it (not the Harness workload) calls
// the gateway back. Mirrors internal/occdev/kubernetes.go and OpenShell sandbox_runtime.rs labels.
export const openShellSupervisorLabels = Object.freeze({
  "openshell.ai/managed-by": "openshell",
  "openshell.ai/boundary-role": "supervisor",
});

export function openShellGatewayNetworkPolicies(namespace, apiPeers) {
  const gatewayLabels = {
    "app.kubernetes.io/name": "openshell",
    "app.kubernetes.io/instance": openShellGatewayServiceName(namespace),
  };
  const supervisorLabels = { ...openShellSupervisorLabels };
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-control-plane", namespace },
        spec: {
          podSelector: { matchLabels: gatewayLabels },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                  },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            { to: apiPeers, ports: [{ protocol: "TCP", port: 443 }] },
            { to: apiPeers, ports: [{ protocol: "TCP", port: 6443 }] },
          ],
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-callback", namespace },
        spec: {
          podSelector: { matchLabels: gatewayLabels },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: supervisorLabels } }],
              ports: [
                { protocol: "TCP", port: gatewayPort },
                { protocol: "TCP", port: 8081 },
              ],
            },
          ],
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-sandbox-callback", namespace },
        spec: {
          podSelector: { matchLabels: { ...supervisorLabels } },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [{ podSelector: { matchLabels: { ...gatewayLabels } } }],
              ports: [{ protocol: "TCP", port: gatewayPort }],
            },
          ],
        },
      },
    ],
  };
}

export function createOpenShellKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
  openShellGatewayImage,
  openShellSandboxImage,
  openShellSupervisorImage,
  openShellRuntimeClass = "openshell-sandbox",
  openShellHelmPath,
  openShellHelmChart,
  openShellWorkspaceHelmChart,
  openShellChartVersion = "0.1.3-pre.1",
}) {
  const base = createRealKubernetesFixture({
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl,
  });

  async function kubectl(...args) {
    return base.kubectl(...args);
  }

  async function validatePrerequisites() {
    assert.equal(
      process.env.OCC_TEST_OPENSHELL_K3D_REAL,
      "1",
      "OCC_TEST_OPENSHELL_K3D_REAL=1 is required for the real OpenShell integration.",
    );
    assert.ok(
      process.env.OPENAI_API_KEY,
      "OPENAI_API_KEY is required for the API binding workflow; a model turn additionally requires genuine upstream Secret projection support.",
    );
    assert.ok(
      openShellHelmPath,
      "OCC_TEST_OPENSHELL_HELM must point at the Helm binary used to install the namespace-scoped OpenShell gateway.",
    );
    assert.ok(
      openShellHelmChart,
      "OCC_TEST_OPENSHELL_HELM_CHART must point at the OpenShell Helm chart or chart archive.",
    );
    assert.ok(
      openShellWorkspaceHelmChart,
      "OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART must point at the OpenShell workspace Helm chart or chart archive.",
    );
    for (const [name, image] of [
      ["OCC_TEST_OPENSHELL_GATEWAY_IMAGE", openShellGatewayImage],
      ["OCC_TEST_OPENSHELL_SANDBOX_IMAGE", openShellSandboxImage],
      ["OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE", openShellSupervisorImage],
    ]) {
      assert.match(
        image ?? "",
        /@sha256:[a-f0-9]{64}$/i,
        `${name} must select a real imported OpenShell image by immutable SHA-256 digest.`,
      );
    }
    await execute("openssl", ["version"], { maxBuffer: 1024 * 1024 });
    await execute(openShellHelmPath, ["show", "chart", openShellHelmChart], {
      maxBuffer: 1024 * 1024,
    });
    await execute(openShellHelmPath, ["show", "chart", openShellWorkspaceHelmChart], {
      maxBuffer: 1024 * 1024,
    });
    const kubeconfig = await base.validatePrerequisites();
    await kubectl("get", "runtimeclass", openShellRuntimeClass, "-o", "json");
    const resources = await kubectl("api-resources", "--api-group=agents.x-k8s.io", "-o", "name");
    assert.match(
      resources,
      /(^|\n)sandboxes(?:\.agents\.x-k8s\.io)?(\n|$)/,
      "the Agent Sandbox CRD must expose sandboxes.agents.x-k8s.io.",
    );
    await waitForControllerPod();
    return kubeconfig;
  }

  async function waitForControllerPod() {
    await base.waitFor(
      "the Agent Sandbox controller to be ready",
      async () => {
        const pods = JSON.parse(
          await kubectl("get", "pods", "--all-namespaces", "-o", "json"),
        ).items;
        const ready = pods.filter((pod) => {
          const name = pod.metadata?.name ?? "";
          const labels = Object.values(pod.metadata?.labels ?? {}).join(" ");
          const looksLikeController = /agent.*sandbox.*controller|sandbox.*controller/i.test(
            `${name} ${labels}`,
          );
          return (
            looksLikeController &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            )
          );
        });
        return ready.length > 0 ? ready : undefined;
      },
      180_000,
    );
  }

  async function customResources(resource, namespace) {
    return JSON.parse(await kubectl("get", resource, "--namespace", namespace, "-o", "json")).items;
  }

  async function maybeResource(kind, name, namespace) {
    try {
      return await base.resource(kind, name, namespace);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
        return undefined;
      }
      throw error;
    }
  }

  function chartImageValues(prefix, image) {
    return openShellChartImageValues(prefix, image);
  }

  async function ensureOpenShellJwtSecret(namespace) {
    const serviceName = openShellGatewayServiceName(namespace);
    const secretName = `${serviceName}-jwt-keys`;
    if ((await maybeResource("secret", secretName, namespace)) !== undefined) {
      return secretName;
    }

    const directory = await mkdtemp(join(tmpdir(), "openshell-jwt-"));
    const signingPath = join(directory, "signing.pem");
    const publicPath = join(directory, "public.pem");
    const kidPath = join(directory, "kid");
    try {
      await execute("openssl", ["genpkey", "-algorithm", "ed25519", "-out", signingPath], {
        maxBuffer: 1024 * 1024,
      });
      await execute("openssl", ["pkey", "-in", signingPath, "-pubout", "-out", publicPath], {
        maxBuffer: 1024 * 1024,
      });
      await writeFile(kidPath, `openshell-${openshellHash(namespace)}\n`, { mode: 0o600 });
      try {
        await kubectl(
          "create",
          "secret",
          "generic",
          secretName,
          "--namespace",
          namespace,
          `--from-file=signing.pem=${signingPath}`,
          `--from-file=public.pem=${publicPath}`,
          `--from-file=kid=${kidPath}`,
        );
      } catch (error) {
        if (!/AlreadyExists|already exists/i.test(error.stderr ?? error.message)) {
          throw error;
        }
      }
      return secretName;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function apiCidr(address) {
    return address.includes(":") ? `${address}/128` : `${address}/32`;
  }

  async function kubernetesApiPeers() {
    const service = JSON.parse(
      await kubectl("get", "service", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const endpoints = JSON.parse(
      await kubectl("get", "endpoints", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const addresses = new Set();
    if (service.spec?.clusterIP && service.spec.clusterIP !== "None") {
      addresses.add(service.spec.clusterIP);
    }
    for (const subset of endpoints.subsets ?? []) {
      for (const address of subset.addresses ?? []) {
        if (typeof address.ip === "string") {
          addresses.add(address.ip);
        }
      }
    }
    assert.ok(
      addresses.size > 0,
      "the OpenShell gateway requires a Kubernetes API NetworkPolicy peer.",
    );
    return [...addresses].map((address) => ({ ipBlock: { cidr: apiCidr(address) } }));
  }

  async function applyOpenShellGatewayNetworkPolicies(namespace) {
    const policies = openShellGatewayNetworkPolicies(namespace, await kubernetesApiPeers());
    const directory = await mkdtemp(join(tmpdir(), "openshell-networkpolicy-"));
    const path = join(directory, "networkpolicies.json");
    try {
      await writeFile(path, JSON.stringify(policies), { mode: 0o600 });
      await kubectl("apply", "--namespace", namespace, "-f", path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function installOpenShellGateway(namespace, { sandboxServiceAccountName } = {}) {
    await kubectl(
      "label",
      "namespace",
      namespace,
      "openshell.ai/openclaw-workspace=true",
      "--overwrite",
    );
    await applyOpenShellGatewayNetworkPolicies(namespace);
    await ensureOpenShellJwtSecret(namespace);
    const instance = openShellGatewayServiceName(namespace);
    const workspaceValues = [
      `--set-string=fullnameOverride=${instance}-workspace`,
      "--set=gateway.allowDriverConfig=true",
      `--set-string=gateway.serviceAccount.name=${instance}`,
      `--set-string=gateway.serviceAccount.namespace=${namespace}`,
      `--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=${instance}`,
      "--set=sandboxServiceAccount.create=false",
      `--set-string=sandboxServiceAccount.name=${sandboxServiceAccountName ?? "openshell-sandbox"}`,
    ];
    await execute(
      openShellHelmPath,
      [
        "upgrade",
        "--install",
        `${instance}-workspace`,
        openShellWorkspaceHelmChart,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
        "--wait",
        "--timeout",
        "240s",
        ...workspaceValues,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const values = [
      `--set-string=fullnameOverride=${instance}`,
      "--set=pkiInitJob.enabled=false",
      "--set=server.disableTls=true",
      "--set=server.auth.allowUnauthenticatedUsers=true",
      "--set=server.drivers.kubernetes.allowDriverConfig=true",
      "--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
      "--set-string=server.drivers.kubernetes.workspaceMode=operator",
      "--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
      "--set=workspaceResources.enabled=false",
      "--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
      `--set-string=server.defaultRuntimeClassName=${openShellRuntimeClass}`,
      ...chartImageValues("gateway.image", openShellGatewayImage),
      ...chartImageValues("sandboxRuntime.image", openShellSandboxImage),
      ...chartImageValues("supervisor.image", openShellSupervisorImage),
    ];
    if (sandboxServiceAccountName !== undefined) {
      values.push("--set=sandboxServiceAccount.create=false");
      values.push(`--set-string=sandboxServiceAccount.name=${sandboxServiceAccountName}`);
    }

    await execute(
      openShellHelmPath,
      [
        "upgrade",
        "--install",
        openShellGatewayServiceName(namespace),
        openShellHelmChart,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
        "--wait",
        "--timeout",
        "240s",
        ...values,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const gateway = await waitForOpenShellGateway(namespace);
    assertRenderedOpenShellImages({
      gatewayPod: gateway,
      statefulSet: await base.resource("statefulset", instance, namespace),
      configMap: await base.resource("configmap", `${instance}-config`, namespace),
      gatewayImage: openShellGatewayImage,
      sandboxImage: openShellSandboxImage,
      supervisorImage: openShellSupervisorImage,
      defaultTag: openShellChartVersion,
    });
    return gateway;
  }

  async function startOpenShellGatewayPortForward(namespace) {
    return await base.startPortForward(namespace, openShellGatewayServiceName(namespace));
  }

  async function readAgentTransportCredentials(namespace, agentId) {
    const suffix = openshellHash(agentId);
    const secret = await base.resource("secret", `${transportSecretPrefix}-${suffix}`, namespace);
    const encodedToken = secret.data?.["app-server-token"];
    assert.equal(typeof encodedToken, "string", "the generated transport token must exist");
    return { appServerToken: Buffer.from(encodedToken, "base64").toString() };
  }

  async function waitForOpenShellGateway(namespace) {
    return await base.waitFor(
      "the namespace-scoped OpenShell gateway",
      async () => {
        const pods = await base.resources("pods", namespace);
        const instance = openShellGatewayServiceName(namespace);
        const ready = pods.filter((pod) => {
          const labels = pod.metadata?.labels ?? {};
          return (
            labels["app.kubernetes.io/name"] === "openshell" &&
            labels["app.kubernetes.io/instance"] === instance &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            )
          );
        });
        return ready.length === 1 ? ready[0] : undefined;
      },
      240_000,
    );
  }

  async function findSandbox(namespace, revision) {
    const resources = await customResources(sandboxApiResource, namespace);
    const sandboxName = `os-${openshellHash(revision.id, 16)}`;
    return resources.find(
      (sandbox) => sandbox.metadata?.labels?.["openshell.ai/sandbox-name"] === sandboxName,
    );
  }

  async function waitForSandbox(namespace, revision) {
    return await base.waitFor(
      `OpenShell Sandbox for revision ${revision.id}`,
      async () => {
        return (await findSandbox(namespace, revision)) ?? undefined;
      },
      240_000,
    );
  }

  async function waitForProviderHarnessPod(namespace, revision) {
    const pod = await base.waitFor(
      `OpenShell-owned Harness Pod for revision ${revision.id}`,
      async () => {
        const pods = await base.resources("pods", namespace);
        return pods.find(
          (pod) =>
            pod.metadata?.labels?.["openclaw.dev/workload-role"] === "agent" &&
            pod.metadata?.labels?.["openclaw.dev/agent"] === revision.agentId &&
            pod.metadata?.labels?.["openclaw.dev/revision"] === revision.id &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
        );
      },
      360_000,
    );
    // Compute gives the Sandbox the provider-fenced profile: the Pod keeps Gateway transport
    // ingress but receives none of Compute's DNS, model or auth egress, so OpenShell's own
    // egress fence is not unioned away.
    assert.equal(
      pod.metadata.labels?.["openclaw.dev/network-profile"],
      "provider-fenced-v1",
      "the OpenShell-owned Harness Pod must carry the provider-fenced network profile.",
    );
    return pod;
  }

  async function assertProviderOwnedHarness(namespace, revision, sandbox, pod) {
    assert.equal(sandbox.metadata.namespace, namespace);
    assert.equal(pod.metadata.namespace, namespace);
    assert.ok(sandbox.metadata.name, "Sandbox must have a stable resource name.");
    assert.equal(pod.spec.serviceAccountName, openShellAgentName(revision.agentId));
    assert.equal(pod.metadata.labels?.["openclaw.dev/namespace"], revision.namespaceId);
    assert.equal(pod.metadata.labels?.["openclaw.dev/agent"], revision.agentId);
    assert.equal(pod.metadata.labels?.["openclaw.dev/revision"], revision.id);
    assert.equal(
      pod.metadata.labels?.["app.kubernetes.io/name"],
      openShellRevisionName(revision),
      "the provider-owned Pod must carry Compute's immutable revision selector.",
    );
    assert.equal(
      pod.metadata.ownerReferences?.some(
        (owner) => owner.kind === "Sandbox" && owner.name === sandbox.metadata.name,
      ),
      true,
      "the Agent Sandbox controller, not Compute, must own the Harness Pod.",
    );
    assert.equal(
      await maybeResource("deployment", openShellRevisionName(revision), namespace),
      undefined,
      "OpenShell-selected dedicated revisions must not also create a Compute-owned Harness Deployment.",
    );
  }

  function harnessContainer(pod) {
    const container = pod.spec.containers.find((entry) =>
      (entry.env ?? []).some(({ name }) => name === "OPENAI_API_KEY"),
    );
    assert.ok(container, "provider-owned Pod must contain the Codex Harness container.");
    for (const name of ["APP_SERVER_TOKEN", "OPENAI_API_KEY"]) {
      const projection = container.env.find((entry) => entry.name === name);
      assert.ok(projection?.valueFrom?.secretKeyRef, `${name} requires genuine Secret projection.`);
      assert.equal(Object.hasOwn(projection, "value"), false);
    }
    return container;
  }

  function assertWorkspaceMounts(pod) {
    const container = harnessContainer(pod);
    const workspaceVolumes = new Set(
      (pod.spec.volumes ?? [])
        .filter(({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName)
        .map(({ name }) => name),
    );
    const mounts = (container.volumeMounts ?? [])
      .filter(({ name }) => workspaceVolumes.has(name))
      .map(({ mountPath, readOnly = false, subPath }) => ({ mountPath, readOnly, subPath }))
      .sort((left, right) => left.subPath.localeCompare(right.subPath));
    const required = mounts.filter(({ mountPath, subPath }) =>
      requiredWorkspaceMounts.some(
        (mount) => mount.subPath === subPath && mount.mountPath === mountPath,
      ),
    );
    assert.deepEqual(required, requiredWorkspaceMounts);
    assert.equal(
      mounts.some(({ subPath, mountPath }) => subPath === "" || mountPath === "/"),
      false,
      "the Harness must never mount the PVC root.",
    );
    assert.equal(
      mounts.some(
        ({ mountPath, readOnly, subPath }) =>
          mountPath === "/sandbox/enterprise" && readOnly === false && subPath === "workspace",
      ),
      true,
      "the integration fixture must add the approved /sandbox descendant alias required by OpenShell.",
    );
  }

  async function assertServicePrincipalTokenProjection(namespace, pod, expected) {
    const container = harnessContainer(pod);
    const volumes = (pod.spec.volumes ?? []).filter(
      ({ name }) => name === "openclaw-service-principal",
    );
    assert.equal(volumes.length, 1, "the Harness requires its own Enterprise token projection.");
    assert.deepEqual(volumes[0].projected?.sources, [
      {
        serviceAccountToken: {
          audience: expected.audience,
          expirationSeconds: expected.expirationSeconds,
          path: "token",
        },
      },
    ]);
    const mounts = (container.volumeMounts ?? []).filter(
      ({ name }) => name === "openclaw-service-principal",
    );
    assert.deepEqual(mounts, [
      {
        name: "openclaw-service-principal",
        mountPath: "/var/run/secrets/openclaw/service-principal",
        readOnly: true,
      },
    ]);

    // Read the kubelet-projected JWT inside the actual provider-owned container without exposing
    // its bearer value; claims prove audience and exact per-Agent Kubernetes ServiceAccount.
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

  function assertApprovedOpenShellPrivileges(pod, { compatibilityBridge = false } = {}) {
    assert.equal(
      pod.spec.runtimeClassName,
      openShellRuntimeClass,
      "OpenShell Pods must use the trusted RuntimeClass selected for the admission exemption.",
    );
    const initCapabilities = new Set(
      (pod.spec.initContainers ?? []).flatMap(
        (container) => container.securityContext?.capabilities?.add ?? [],
      ),
    );
    assert.deepEqual(
      [...initCapabilities],
      [],
      "OpenShell v0.1.3-pre.1 must not add capabilities to workload Pod init containers.",
    );
    const networkSidecar = pod.spec.containers.find(({ name }) =>
      ["openshell-network", "openshell-supervisor-network"].includes(name),
    );
    assert.equal(
      networkSidecar,
      undefined,
      "OpenShell v0.1.3-pre.1 must keep its network supervisor outside the workload Pod.",
    );
    const container = compatibilityBridge
      ? pod.spec.containers.find(({ name }) => name === "agent")
      : harnessContainer(pod);
    assert.ok(container, "the provider-owned Pod must contain its Agent container.");
    assert.equal(container.securityContext?.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext?.capabilities?.drop, ["ALL"]);
    assert.notEqual(container.securityContext?.runAsUser, 0);
  }

  async function assertGatewayBootstrapPolicies(namespace) {
    const policies = await base.resources("networkpolicies", namespace);
    assert.ok(
      policies.some(({ metadata }) => /openshell/i.test(metadata.name)),
      "SandboxDriver.ensureNamespace must install provider-specific NetworkPolicies.",
    );
  }

  async function assertNoSecretBytes(namespace, secrets) {
    const redacted = secrets.filter(Boolean);
    const [pods, configMaps] = await Promise.all([
      base.resources("pods", namespace),
      base.resources("configmaps", namespace),
    ]);
    const document = JSON.stringify({ pods, configMaps });
    for (const secret of redacted) {
      assert.equal(
        document.includes(secret),
        false,
        "Kubernetes metadata must not expose secrets.",
      );
    }
  }

  async function requestCodexTurnFromPod({
    namespace,
    pod,
    container,
    providerModel,
    prompt,
    appServerUrl,
    appServerTokenPath,
  }) {
    const script = String.raw`
      const appServerUrl = ${JSON.stringify(appServerUrl)} ?? process.env.APP_SERVER_URL;
      const appServerToken = ${
        appServerTokenPath === undefined
          ? "process.env.APP_SERVER_TOKEN"
          : `require("node:fs").readFileSync(${JSON.stringify(appServerTokenPath)}, "utf8")`
      };
      const timeout = setTimeout(() => fail(new Error("Codex harness turn timed out")), 300000);
      const pending = new Map();
      const items = [];
      let nextId = 1;
      let assistant = "";
      let finished = false;

      function fail(error) {
        clearTimeout(timeout);
        process.stderr.write(error?.stack || String(error));
        process.exit(1);
      }

      function request(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }

      const socket = new WebSocket(appServerUrl, {
        headers: { authorization: "Bearer " + appServerToken },
      });

      socket.addEventListener("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "openclaw-enterprise-openshell-integration", version: "1.0.0" },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          const started = await request("thread/start", {
            cwd: "/home/node/workspace",
            model: ${JSON.stringify(providerModel)},
            approvalPolicy: "on-request",
            sandbox: "danger-full-access",
            config: { project_doc_max_bytes: 131072 },
          });
          await request("turn/start", {
            threadId: started.thread.id,
            input: [{ type: "text", text: ${JSON.stringify(prompt)} }],
            sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
          });
        } catch (error) {
          fail(error);
        }
      });

      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(String(data));
        items.push(message);
        if (message.id !== undefined) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (entry) {
            if (message.error) entry.reject(new Error(message.error.message));
            else entry.resolve(message.result);
          }
        } else if (message.method === "item/completed") {
          const item = message.params?.item;
          if (item?.type === "agentMessage") assistant = item.text ?? "";
        } else if (message.method === "turn/completed") {
          if (message.params?.turn?.status !== "completed") {
            fail(new Error("Codex harness turn did not complete successfully"));
            return;
          }
          finished = true;
          clearTimeout(timeout);
          process.stdout.write(JSON.stringify({ assistant, items }));
          socket.close();
        } else if (message.method === "error") {
          fail(new Error(message.params?.error?.message || "Codex harness turn failed"));
        }
      });
      socket.addEventListener("error", () => {
        if (!finished) fail(new Error("Codex harness connection failed"));
      });
      socket.addEventListener("close", () => {
        if (!finished) fail(new Error("Codex harness connection closed before completion"));
      });
    `;
    const containerArguments = container === undefined ? [] : ["--container", container];
    return JSON.parse(
      await kubectl(
        "exec",
        pod,
        "--namespace",
        namespace,
        ...containerArguments,
        "--",
        "node",
        "-e",
        script,
      ),
    );
  }

  async function requestCodexTurnFromGatewayPod({ namespace, gatewayPod, providerModel, prompt }) {
    return requestCodexTurnFromPod({
      namespace,
      pod: gatewayPod,
      providerModel,
      prompt,
    });
  }

  async function requestCodexTurnFromOpenShellHarnessPod({
    namespace,
    harnessPod,
    providerModel,
    prompt,
    appServerTokenPath,
  }) {
    return requestCodexTurnFromPod({
      namespace,
      pod: harnessPod,
      container: "agent",
      providerModel,
      prompt,
      appServerUrl: `ws://127.0.0.1:${harnessPort}`,
      appServerTokenPath,
    });
  }

  async function startGatewayPortForward(namespace, serviceName) {
    return await base.startPortForward(namespace, serviceName);
  }

  return {
    ...base,
    validateOpenShellPrerequisites: validatePrerequisites,
    customResources,
    maybeResource,
    readAgentTransportCredentials,
    waitForOpenShellGateway,
    installOpenShellGateway,
    startOpenShellGatewayPortForward,
    waitForSandbox,
    waitForProviderHarnessPod,
    assertProviderOwnedHarness,
    assertWorkspaceMounts,
    assertServicePrincipalTokenProjection,
    assertApprovedOpenShellPrivileges,
    assertGatewayBootstrapPolicies,
    assertNoSecretBytes,
    requestCodexTurnFromGatewayPod,
    requestCodexTurnFromOpenShellHarnessPod,
    startGatewayPortForward,
  };
}
