import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; namespace?: string };
}
const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const kubernetesRequire = createRequire(require.resolve("@kubernetes/client-node"));
const { loadAll } = kubernetesRequire("js-yaml") as { loadAll: (source: string) => unknown[] };
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createAuthenticatedControllerRequest } from "./auth-session.ts";
import {
  developmentBootstrapEnvironment,
  runBootstrapInstallation,
} from "./bootstrap-installation.mjs";
import {
  createOpenShellTokenServiceInstallationConfiguration,
  createOpenShellKubernetesFixture,
  openshellHash,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
} from "./openshell-kubernetes-real.mjs";
import { OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  createScopedController,
  apiServerPodProxySourceCidrs,
  withFirstPrepareRevisionFailureDiagnostic,
} from "./openshell-sandbox-workflows.mjs";

import { redactedQaTail } from "./qa-secrets.ts";
import { jsonLineDestination } from "./json-lines.ts";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "./envoy-workspace-gateway.mjs";
import { startWorkspaceGatewayHostRelay } from "./workspace-gateway-host-relay.ts";

const execute = promisify(execFile);

export async function createOpenShellNamespaceLifecycle(
  context: TestContext,
  namespaceOnly = false,
) {
  const env = { ...process.env };
  if (namespaceOnly) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
    delete env.OCC_TEST_OPENAI_MODEL;
  }
  const fixture = createOpenShellKubernetesFixture({
    commandTimeoutMs: 60_000,
    signal: undefined,
    kubeconfigPath: env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: env.OCC_TEST_KUBERNETES_CONTEXT,
    databaseUrl: env.OCC_TEST_DATABASE_URL,
    gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    codexImage: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
    openShellGatewayImage: env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE,
    openShellSandboxImage: env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE,
    openShellSupervisorImage: env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE,
    openShellHelmPath: env.OCC_TEST_OPENSHELL_HELM,
    openShellHelmChart: env.OCC_TEST_OPENSHELL_HELM_CHART,
    openShellWorkspaceHelmChart: env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART,
  });
  const kubeconfig = namespaceOnly
    ? await fixture.validateOpenShellNamespacePrerequisites()
    : await fixture.validateOpenShellPrerequisites();
  const directory = await mkdtemp(join(tmpdir(), "oce-namespace-bootstrap-"));
  const platformNamespace = `oce-ns-${openshellHash(randomUUID())}`;
  const custodyNamespace = `${platformNamespace}-credentials`;
  const placements: string[] = [];
  context.after(async () => {
    for (const name of [...placements, custodyNamespace, platformNamespace]) {
      await fixture.kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=false");
    }
    await rm(directory, { recursive: true, force: true });
  });
  await fixture.kubectl("create", "namespace", platformNamespace);
  const identity = await createScopedController(
    context,
    randomUUID(),
    platformNamespace,
    kubeconfig,
  );
  // Match the chart's private TokenService store and its separate API and worker grants.
  await fixture.kubectl("create", "namespace", custodyNamespace);
  for (const [account, verbs] of [
    [identity.apiIdentity.account, "get,create,update,delete"],
    [identity.account, "get,delete"],
  ] as const) {
    await fixture.kubectl(
      "create",
      "role",
      account,
      "-n",
      custodyNamespace,
      "--resource=secrets",
      `--verb=${verbs}`,
    );
    await fixture.kubectl(
      "create",
      "rolebinding",
      account,
      "-n",
      custodyNamespace,
      `--role=${account}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
  }
  // Gateway workloads use the same tenant binding as other runtime workloads. No cluster-wide
  // workload permission is granted; RBAC prerequisites below remain operator-owned.
  await fixture.kubectl(
    "patch",
    "clusterrole",
    identity.tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: ["apps"],
          resources: ["statefulsets"],
          verbs: ["get", "list", "create", "patch", "delete"],
        },
      },
    ]),
  );
  await fixture.kubectl(
    "patch",
    "clusterrole",
    identity.tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["list"] },
      },
    ]),
  );
  // Envoy is the Installation's authenticated Agent routing prerequisite. It does not create
  // the namespace-owned OpenShell gateway or Workspace that this test proves below.
  const gatewayHelpers = {
    kubectl: fixture.kubectl,
    applyManifest: fixture.applyManifest,
    async resource(kind: string, name: string, namespace?: string) {
      if (namespace === undefined) {
        return fixture.resource(kind, name, namespace);
      }
      // Polling needs actual absence, without exposing raw kubectl stderr or Secret data.
      const resource = await fixture.maybeResource(kind, name, namespace);
      if (resource === undefined) {
        throw new Error("Kubernetes resource not found.");
      }
      return resource;
    },
    resources: fixture.resources,
    waitFor: fixture.waitFor,
    startPortForwardTarget: fixture.startPortForwardTarget,
  };
  await ensureEnvoyGatewayControllers(gatewayHelpers);
  const workspaceGateway = await createEnvoyWorkspaceGatewayPlan(
    context,
    { platformNamespace },
    gatewayHelpers,
  );
  const gatewayImage = env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  assert.ok(gatewayImage, "OCC_TEST_KUBERNETES_GATEWAY_IMAGE must select the relay image.");
  const gatewayEndpointPort = await startWorkspaceGatewayHostRelay(context, workspaceGateway, {
    ...gatewayHelpers,
    gatewayImage,
  });
  const configuration = createOpenShellTokenServiceInstallationConfiguration({
    authentication: identity.authentication,
    platformNamespace,
    cluster: env.OCC_TEST_KUBERNETES_CONTEXT!,
    gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    codexImage: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
  }) as ReturnType<typeof createOpenShellTokenServiceInstallationConfiguration> & {
    backend: { configuration: { serviceName: string; insecureTransport: string } }[];
    drivers: {
      sandbox: { configuration: OpenShellSandboxDriverOptions };
    };
  };
  const modelBaseUrl = "https://api.openai.com/v1";
  if (!namespaceOnly) {
    assert.ok(
      URL.parse(env.OCC_TEST_OPENSHELL_MODEL_BASE_URL || modelBaseUrl)?.href.replace(/\/$/u, "") ===
        modelBaseUrl,
      "The OpenAI model preset requires its approved endpoint.",
    );
    Object.assign(configuration, {
      sandboxNetworkPolicyCeiling: [
        {
          id: "openai-responses",
          binary: "/usr/local/bin/node",
          host: "api.openai.com",
          ports: [{ from: 443, to: 443 }],
        },
      ],
    });
  }
  const compute = configuration.drivers.compute.configuration;
  Object.assign(compute, {
    gatewayRouting: { ...workspaceGateway.routing, endpointPort: gatewayEndpointPort },
    network: {
      ...compute.network,
      gatewayTrustedProxyCidrs: workspaceGateway.nativeOptions.gatewayAuth.trustedProxies,
      gatewayClients: undefined,
      pluginStatusProxySourceCidrs: await apiServerPodProxySourceCidrs(),
    },
    servicePrincipalCredentials: { mode: "disabled" },
    resources: {
      ...compute.resources,
      agent: {
        ...compute.resources.agent,
        limits: { ...compute.resources.agent.limits, memory: "6Gi" },
      },
      namespace: {
        ...compute.resources.namespace,
        quota: { ...compute.resources.namespace.quota, "limits.memory": "20Gi" },
      },
    },
    runtime: {
      ...compute.runtime,
      nativeOpenClawSessionCapacity: 2,
      ...(namespaceOnly
        ? {}
        : { modelProvider: { protocol: "openai-responses", baseUrl: modelBaseUrl } }),
    },
  });
  const originalQuota = structuredClone(compute.resources.namespace.quota);
  if (namespaceOnly) {
    // Kubernetes must refuse the first gateway Service after the signing key exists.
    Object.assign(compute.resources.namespace.quota, { services: "0" });
  }
  const sandboxResources = configuration.drivers.sandbox.configuration.kubernetes
    .agentResources as {
    limits: Record<string, string>;
  };
  sandboxResources.limits.memory = "6Gi";
  const templateNamespace = "oce-namespace-template";
  const service = `openshell-${openshellHash(templateNamespace, 10)}`;
  const common = ["--namespace", templateNamespace, `--set-string=fullnameOverride=${service}`];
  const sandboxApis = String(await fixture.kubectl("api-versions"))
    .split("\n")
    .filter((version) => /^agents\.x-k8s\.io\/v1(?:alpha|beta)1$/.test(version));
  assert.ok(sandboxApis.length > 0, "the real cluster must serve Agent Sandbox before rendering");
  const render = async (chart: string, args: string[]) => {
    const { stdout } = await execute(
      env.OCC_TEST_OPENSHELL_HELM!,
      [
        "template",
        service,
        chart,
        ...common,
        ...sandboxApis.flatMap((version) => ["--api-versions", version]),
        ...args,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return loadAll(stdout).filter(Boolean) as KubernetesObject[];
  };
  const workspace = await render(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART!, [
    `--set-string=fullnameOverride=${service}-workspace`,
    "--set=gateway.allowDriverConfig=true",
    `--set-string=gateway.serviceAccount.name=${service}`,
    `--set-string=gateway.serviceAccount.namespace=${templateNamespace}`,
    `--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=${service}`,
  ]);
  const sandboxAccounts = workspace.filter((resource) => resource.kind === "ServiceAccount");
  assert.equal(sandboxAccounts.length, 1, "the workspace chart must supply its Sandbox account");
  const sandboxAccount = sandboxAccounts[0]!.metadata!.name!;
  // Rendering contributes configuration only. Neither Helm nor this test creates a gateway,
  // Service, gateway data volume, signing key, or Workspace.
  const gateway = await render(env.OCC_TEST_OPENSHELL_HELM_CHART!, [
    "--set=pkiInitJob.enabled=false",
    "--set=server.disableTls=true",
    "--set=server.auth.allowUnauthenticatedUsers=true",
    "--set=server.drivers.kubernetes.allowDriverConfig=true",
    "--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
    "--set-string=server.drivers.kubernetes.workspaceMode=operator",
    "--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
    "--set=workspaceResources.enabled=false",
    "--set=sandboxServiceAccount.create=false",
    `--set-string=sandboxServiceAccount.name=${sandboxAccount}`,
    "--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
    `--set-json=gatewayConfig.openshell\\.drivers\\.kubernetes.allowed_pod_labels=${JSON.stringify(OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST)}`,
    ...openShellChartImageValues("gateway.image", env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE),
    ...openShellChartImageValues("sandboxRuntime.image", env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE),
    ...openShellChartImageValues("supervisor.image", env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE),
  ]);
  const operatorKinds = new Set(["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
  const prerequisites = [...gateway, ...workspace].filter((item) => operatorKinds.has(item.kind!));
  const clusterRoles = new Set(
    prerequisites
      .filter((object) => object.kind === "ClusterRole")
      .map((object) => object.metadata!.name!),
  );
  const clusterBindings = new Set<string>();
  const installedClusterRoles = new Set<string>();
  for (const object of prerequisites) {
    if (object.kind === "ClusterRole") {
      object.metadata!.name = `${platformNamespace}-${object.metadata!.name}`;
    }
    const roleRef = (object as KubernetesObject & { roleRef?: { kind: string; name: string } })
      .roleRef;
    if (roleRef?.kind === "ClusterRole" && clusterRoles.has(roleRef.name)) {
      roleRef.name = `${platformNamespace}-${roleRef.name}`;
    }
  }
  context.after(async () => {
    for (const name of clusterBindings) {
      await fixture.kubectl("delete", "clusterrolebinding", name, "--ignore-not-found=true");
    }
    for (const name of installedClusterRoles) {
      await fixture.kubectl("delete", "clusterrole", name, "--ignore-not-found=true");
    }
  });
  const runtime = [...gateway, ...workspace].filter((item) => !operatorKinds.has(item.kind!));
  const endpoints = (await fixture.resource("endpoints", "kubernetes", "default")) as {
    subsets: { addresses: { ip: string }[] }[];
  };
  const peers = endpoints.subsets.flatMap((subset) =>
    subset.addresses.map(({ ip }) => ({ ipBlock: { cidr: `${ip}/32` } })),
  );
  const templates = JSON.parse(
    JSON.stringify([
      ...runtime,
      ...openShellGatewayNetworkPolicies(templateNamespace, peers).items,
    ]).replaceAll(templateNamespace, "${OCE_NAMESPACE}"),
  );
  for (const object of templates) {
    if (object.kind === "Deployment" || object.kind === "StatefulSet") {
      object.spec.replicas = namespaceOnly ? 1 : 0;
    }
  }
  Object.assign(configuration.drivers.sandbox.configuration.gateway, {
    namespaceGatewayResources: templates,
    operatorNamespaceLabels: { "openshell.ai/openclaw-workspace": "true" },
    readiness: {
      serviceName: service,
      podSelector: { "app.kubernetes.io/instance": service },
      timeoutMs: 30_000,
    },
  });
  // Resolve each Agent's approved workspace PVC from its workload requirements.
  Object.assign(configuration.drivers.sandbox.configuration.kubernetes.sandboxDataMount, {
    claimName: undefined,
  });
  configuration.backend[0]!.configuration = {
    serviceName: service,
    insecureTransport: "network-policy",
  };
  const startupPath = join(directory, "installation.json");
  const keyPath = join(directory, "gateway-key");
  await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(keyPath, workspaceGateway.apiKey, { mode: 0o600 });
  const credentials = {
    email: "namespace-bootstrap@example.test",
    password: randomBytes(24).toString("base64url"),
  };
  const authSecret = randomBytes(32).toString("hex");
  const authBaseURL = "https://console.oce.localhost";
  const environment = {
    ...env,
    OCC_CONFIG_PATH: startupPath,
    OCC_GATEWAY_API_KEY_PATH: keyPath,
    OCC_INSTALLATION_SECRET_NAMESPACE: custodyNamespace,
  };
  const databaseUrl = env.OCC_TEST_DATABASE_URL!;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  assert.equal(
    (await pool.query("select count(*)::int as count from occ.installation")).rows[0].count,
    0,
    "bootstrap proof requires a fresh migrated database",
  );
  const bootstrap = await runBootstrapInstallation(
    developmentBootstrapEnvironment({
      databaseUrl,
      directory,
      ...credentials,
      authSecret,
      authBaseURL,
      installationName: "namespace-lifecycle",
      environment,
    }),
  );
  assert.equal(
    bootstrap.ok,
    true,
    `shipped bootstrap must succeed before provider infrastructure is available: ${redactedQaTail(
      bootstrap.stderr,
      {
        ...environment,
        AUTH_SECRET: authSecret,
        BOOTSTRAP_PASSWORD: credentials.password,
        GATEWAY_API_KEY: workspaceGateway.apiKey,
      },
      { lines: 12, lineChars: 800 },
    ).join("\n")}`,
  );
  const initial = (await pool.query("select id, name, status from occ.namespaces")).rows;
  assert.equal(initial.length, 1);
  assert.equal(initial[0].name, "default");
  assert.equal(initial[0].status, "provisioning");
  const forwards = new Map<
    string,
    Promise<{ client: GrpcOpenShellGatewayClient; stop: () => Promise<void> }>
  >();
  const connected = (namespace: string) => {
    let pending = forwards.get(namespace);
    if (!pending) {
      pending = fixture.startPortForward(namespace, service).then((forward) => ({
        client: new GrpcOpenShellGatewayClient({ endpoint: forward.url }),
        stop: forward.stop,
      }));
      forwards.set(namespace, pending);
    }
    return pending;
  };
  context.after(async () => {
    for (const pending of forwards.values()) {
      const transport = await pending;
      transport.client.close();
      await transport.stop();
    }
  });
  // Only the transport changes for a loopback test process. Every RPC reaches the actual
  // gateway; Namespace setup, Workspace creation, and results come from shipped Drivers.
  const transportFailures: {
    operation: string;
    errorClass: string | undefined;
    code: number | undefined;
    grpcStatus: number | undefined;
  }[] = [];
  const apiStartupPath = join(directory, "api-installation.json");
  const loadDrivers = async (forApi = false) => {
    if (forApi) {
      const apiConfiguration = structuredClone(configuration);
      apiConfiguration.drivers.secret.configuration.authentication =
        identity.apiIdentity.authentication;
      await writeFile(apiStartupPath, JSON.stringify(apiConfiguration), { mode: 0o600 });
    }
    return (await loadInstallationConfiguration({
      mode: "production",
      environment: { ...environment, OCC_CONFIG_PATH: forApi ? apiStartupPath : startupPath },
      createOpenShellBackend(definition) {
        const client = new OpenShellGateway(definition.configuration);
        return {
          id: definition.id,
          drivers: definition.drivers,
          client: new Proxy(client, {
            get(target, property) {
              if (property === "clientForNamespace") {
                return (namespace: string) =>
                  new Proxy(
                    {},
                    {
                      get(_target, operation: string) {
                        return async (...args: unknown[]) => {
                          const { client: gatewayClient } = await connected(namespace);
                          const method = Reflect.get(gatewayClient, operation) as (
                            ...args: unknown[]
                          ) => unknown;
                          try {
                            return await method.apply(gatewayClient, args);
                          } catch (error) {
                            // Keep provider payloads and credential-bearing RPC arguments out of evidence.
                            transportFailures.push({
                              operation,
                              errorClass: error instanceof Error ? error.name : undefined,
                              code:
                                typeof Reflect.get(Object(error), "code") === "number"
                                  ? Reflect.get(Object(error), "code")
                                  : undefined,
                              grpcStatus:
                                typeof Reflect.get(Object(error), "grpcStatus") === "number"
                                  ? Reflect.get(Object(error), "grpcStatus")
                                  : undefined,
                            });
                            throw error;
                          }
                        };
                      },
                    },
                  );
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
      },
    }))!;
  };
  const drivers = await loadDrivers(true);
  const apiLogs: unknown[] = [];
  const apiDiagnostic = () =>
    redactedQaTail(
      JSON.stringify({ events: apiLogs.slice(-12), transportFailures }),
      {
        ...environment,
        AUTH_SECRET: authSecret,
        BOOTSTRAP_PASSWORD: credentials.password,
        GATEWAY_API_KEY: workspaceGateway.apiKey,
      },
      { lines: 12, lineChars: 8000 },
    ).join("\n");
  const startApi = (selectedDrivers: typeof drivers) =>
    composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      logger: createOccLogger({
        component: "namespace-proof-api",
        destination: jsonLineDestination(apiLogs),
      }),
      drivers: selectedDrivers,
      gatewayApiKeyPath: keyPath,
    });
  const app = await startApi(drivers);
  if (namespaceOnly) {
    context.after(() => app.close());
  }
  const request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
  const namespaceOutcomes: unknown[] = [];
  const startWorker = (selectedDrivers: typeof drivers) =>
    createControllerWorker({
      mode: "production",
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers: {
        ...selectedDrivers,
        computeDriver: withFirstPrepareRevisionFailureDiagnostic(selectedDrivers.computeDriver),
      },
      pollIntervalMs: 100,
      leaseDurationMs: 10_000,
      maxAttempts: 40,
      emit: (event) => {
        if (event.event === "worker.completed") {
          namespaceOutcomes.push({
            operation: event.operation,
            code: event.code,
            reason: event.reason,
          });
        }
      },
    });
  const worker = startWorker(await loadDrivers());
  if (namespaceOnly) {
    context.after(() => worker.stop());
  }
  const prepareNamespace = async (id: string, placement = kubernetesNamespaceName(id)) => {
    placements.push(placement);
    assert.notEqual(placement, "default");
    await fixture.waitFor(
      "Compute creates the backing namespace",
      async () =>
        String(
          await fixture.kubectl(
            "get",
            "namespace",
            placement,
            "--ignore-not-found=true",
            "-o",
            "json",
          ),
        ).trim() || undefined,
    );
    // Operator grants are prerequisites. The test creates no gateway workload or Workspace.
    const prerequisitePath = join(directory, `${placement}-operator.json`);
    const objects = JSON.parse(
      JSON.stringify(prerequisites).replaceAll(templateNamespace, placement),
    ) as KubernetesObject[];
    // Chart role names can contain the namespace template too. Match the rendered names
    // before adding the disposable-installation suffix to both sides of each binding.
    const renderedClusterRoles = new Set(
      objects
        .filter((object) => object.kind === "ClusterRole")
        .map((object) => object.metadata!.name!),
    );
    for (const object of objects) {
      if (object.kind === "ClusterRole") {
        object.metadata!.name += `-${placement}`;
        installedClusterRoles.add(object.metadata!.name!);
      }
      const roleRef = (object as KubernetesObject & { roleRef?: { kind: string; name: string } })
        .roleRef;
      if (roleRef?.kind === "ClusterRole" && renderedClusterRoles.has(roleRef.name)) {
        roleRef.name += `-${placement}`;
      }
      if (object.kind === "ClusterRoleBinding") {
        object.metadata!.name = `${platformNamespace}-${object.metadata!.name}-${placement}`;
        clusterBindings.add(object.metadata!.name);
      }
    }
    await writeFile(
      prerequisitePath,
      JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }),
      { mode: 0o600 },
    );
    await fixture.kubectl("apply", "--namespace", placement, "-f", prerequisitePath);
    await fixture.kubectl(
      "create",
      "rolebinding",
      "namespace-lifecycle-worker",
      "--namespace",
      placement,
      `--clusterrole=${identity.tenantRole}`,
      `--serviceaccount=${platformNamespace}:${identity.account}`,
    );
    // Match the supported API/worker split: canonical model Secrets use the API identity.
    await fixture.kubectl(
      "create",
      "rolebinding",
      "namespace-lifecycle-api-secrets",
      "--namespace",
      placement,
      `--clusterrole=${identity.apiSecretRole}`,
      `--serviceaccount=${platformNamespace}:${identity.apiIdentity.account}`,
    );
    return placement;
  };

  return {
    fixture,
    startupPath,
    configuration,
    originalQuota,
    templates,
    apiDiagnostic,
    loadDrivers,
    app,
    startApi,
    request,
    worker,
    startWorker,
    prepareNamespace,
    connected,
    placements,
    service,
    initial,
    pool,
    namespaceOutcomes,
    credentials,
    authBaseURL,
    workspaceGateway,
    gatewayEndpointPort,
    environment,
    authSecret,
    sandboxAccount,
    drivers,
    modelBaseUrl,
  };
}
