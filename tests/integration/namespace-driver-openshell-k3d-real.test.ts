import { boundedTeardown } from "../helpers/kubernetes-real.mjs";
import assert from "node:assert/strict";
import test from "node:test";
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
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import {
  developmentBootstrapEnvironment,
  runBootstrapInstallation,
} from "../helpers/bootstrap-installation.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  openshellHash,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
  waitForOpenShellRevisionActivation,
} from "../helpers/openshell-kubernetes-real.mjs";
import { OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  createScopedController,
  apiServerPodProxySourceCidrs,
  withFirstPrepareRevisionFailureDiagnostic,
} from "../helpers/openshell-sandbox-workflows.mjs";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { redactedQaTail } from "../helpers/qa-secrets.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
  startWorkspaceGatewayHostRelay,
} from "../helpers/envoy-workspace-gateway.mjs";

const execute = promisify(execFile);
const selected = process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL === "1";

test(
  "bootstrap reconciles OpenShell gateways and Workspaces before any Agent, then runs Agents in both Namespaces",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_NAMESPACE_OPENSHELL_REAL=1 with prepared disposable OpenShell infrastructure.",
    timeout: 2_400_000,
  },
  async (testContext) => {
    const { context } = boundedTeardown(testContext, { label: "Namespace lifecycle bootstrap" });
    const env = process.env;
    assert.ok(env.OPENAI_API_KEY, "the live Agent proof requires an authorized model credential");
    assert.ok(
      env.OCC_TEST_OPENAI_MODEL,
      "the live Agent proof requires an explicitly selected model",
    );
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
      openShellRuntimeClass: env.OCC_TEST_OPENSHELL_RUNTIME_CLASS,
    });
    const kubeconfig = await fixture.validateOpenShellPrerequisites();
    const directory = await mkdtemp(join(tmpdir(), "oce-namespace-bootstrap-"));
    const platformNamespace = `oce-ns-${openshellHash(randomUUID())}`;
    const placements: string[] = [];
    context.after(async () => {
      for (const name of [...placements, platformNamespace]) {
        await fixture.kubectl(
          "delete",
          "namespace",
          name,
          "--ignore-not-found=true",
          "--wait=false",
        );
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
    const gatewayEndpointPort = await startWorkspaceGatewayHostRelay(context, workspaceGateway, {
      ...gatewayHelpers,
      gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    });
    const configuration = createOpenShellInstallationConfiguration({
      authentication: identity.authentication,
      platformNamespace,
      cluster: env.OCC_TEST_KUBERNETES_CONTEXT,
      gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
      codexImage: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
      openShellRuntimeClass: env.OCC_TEST_OPENSHELL_RUNTIME_CLASS,
    }) as ReturnType<typeof createOpenShellInstallationConfiguration> & {
      backend: { configuration: { serviceName: string; insecureTransport: string } }[];
      drivers: {
        sandbox: { configuration: OpenShellSandboxDriverOptions };
        credential_gateway: { configuration: { binaries: string[] } };
      };
    };
    const modelBaseUrl = env.OCC_TEST_OPENSHELL_MODEL_BASE_URL ?? "https://api.openai.com/v1";
    const compute = configuration.drivers.compute.configuration;
    Object.assign(compute, {
      gatewayRouting: { ...workspaceGateway.routing, endpointPort: gatewayEndpointPort },
      network: {
        ...compute.network,
        gatewayTrustedProxyCidrs: workspaceGateway.nativeOptions.gatewayAuth.trustedProxies,
        gatewayClients: undefined,
        pluginStatusProxySourceCidrs: await apiServerPodProxySourceCidrs(),
      },
      // The task explicitly permits the supported OpenShell Credential Gateway topology's
      // existing identity and credential placement. This proof does not change those contracts.
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
        modelProvider: { protocol: "openai-responses", baseUrl: modelBaseUrl },
      },
    });
    // Native OpenClaw uses Node for model traffic; the Codex-only binary policy must not apply.
    configuration.drivers.credential_gateway.configuration.binaries = ["/usr/local/bin/node"];
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
      `--set-string=server.defaultRuntimeClassName=${env.OCC_TEST_OPENSHELL_RUNTIME_CLASS}`,
      `--set-json=gatewayConfig.openshell\\.drivers\\.kubernetes.allowed_pod_labels=${JSON.stringify(OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST)}`,
      ...openShellChartImageValues("gateway.image", env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE),
      ...openShellChartImageValues("sandboxRuntime.image", env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE),
      ...openShellChartImageValues("supervisor.image", env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE),
    ]);
    const operatorKinds = new Set(["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
    const prerequisites = [...gateway, ...workspace].filter((item) =>
      operatorKinds.has(item.kind!),
    );
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
        object.spec.replicas = 0;
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
    const environment = { ...env, OCC_CONFIG_PATH: startupPath, OCC_GATEWAY_API_KEY_PATH: keyPath };
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
    const apiLogs: Record<string, unknown>[] = [];
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
    let app = await startApi(drivers);
    context.after(() => app.close());
    let request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
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
    let worker = startWorker(await loadDrivers());
    context.after(() => worker.stop());
    await worker.start();
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
    const ready = async (id: string) => {
      const placement = await prepareNamespace(id);
      if (id === initial[0].id) {
        // Zero replicas makes real gateway readiness pending. Interrupt the worker, repair
        // configuration, and let a successor resume queued work without replacing its key.
        await fixture.waitFor("Driver-created gateway Service", () =>
          fixture.maybeResource("service", service, placement),
        );
        assert.equal((await request("GET", `/namespaces/${id}`)).data.status, "provisioning");
        assert.equal(
          (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
          0,
        );
        const signingKey = await fixture.resource("secret", `${service}-jwt-keys`, placement);
        await worker.stop();
        for (const object of templates) {
          if (object.kind === "Deployment" || object.kind === "StatefulSet") {
            object.spec.replicas = 1;
          }
        }
        await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
        worker = startWorker(await loadDrivers());
        await worker.start();
        assert.equal(
          (await fixture.resource("secret", `${service}-jwt-keys`, placement)).metadata.uid,
          signingKey.metadata.uid,
        );
      }
      await fixture.waitFor(
        "all Namespace participants complete",
        async () => {
          const observed = await request("GET", `/namespaces/${id}`);
          assert.equal(observed.status, 200);
          assert.notEqual(observed.data.status, "failed", JSON.stringify(namespaceOutcomes));
          return observed.data.status === "ready" ? true : undefined;
        },
        300_000,
      );
      assert.equal(
        (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
        0,
        "both gateway and Workspace must precede every Agent",
      );
      const serviceResource = await fixture.resource("service", service, placement);
      assert.equal(serviceResource.metadata.labels["openclaw.dev/namespace"], id);
      const pods = (await fixture.resources("pods", placement)) as {
        metadata: { labels?: Record<string, string> };
        spec: { containers: { image: string }[] };
        status?: { conditions?: { type: string; status: string }[] };
      }[];
      assert.ok(
        pods.some(
          (pod) =>
            pod.metadata.labels?.["app.kubernetes.io/instance"] === service &&
            pod.metadata.labels?.["openclaw.dev/namespace"] === id &&
            pod.metadata.labels?.["openclaw.dev/namespace-gateway"] === "true" &&
            pod.spec.containers.some(({ image }) =>
              image.endsWith(`@${env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE!.split("@")[1]}`),
            ) &&
            pod.status?.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        ),
      );
      const { client } = await connected(placement);
      await client.health(AbortSignal.timeout(10_000));
      const workspace = await client.getWorkspace(placement, AbortSignal.timeout(10_000));
      assert.ok(workspace);
      assert.equal(workspace.labels["openclaw.dev/namespace-id"], id);
      return placement;
    };
    await ready(initial[0].id);
    testContext.diagnostic(
      "OpenShell Namespace proof: default gateway and Workspace ready with zero persisted Agents",
    );
    const later = await request("POST", "/namespaces", { name: "later" });
    assert.equal(later.status, 201);
    assert.notEqual(await ready(later.data.id), kubernetesNamespaceName(initial[0].id));
    testContext.diagnostic(
      "OpenShell Namespace proof: later gateway and Workspace ready with zero persisted Agents",
    );

    // Only now create Agents: both persisted zero-Agent checkpoints above have already proved
    // the shipped Namespace worker created healthy gateways and owned Workspaces independently.
    const proveAgent = async (namespaceId: string, name: string) => {
      const placement = kubernetesNamespaceName(namespaceId);
      const { client: provider } = await connected(placement);
      const workspaceBefore = await provider.getWorkspace(placement, AbortSignal.timeout(10_000));
      const modelSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
        name: "model-key",
        value: env.OPENAI_API_KEY,
      });
      assert.equal(modelSecret.status, 201);
      assert.equal(JSON.stringify(modelSecret).includes(env.OPENAI_API_KEY!), false);
      const source = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
        name: "model-source",
        type: "openai",
        config: { authorized_base_url: modelBaseUrl },
        secrets: { api_key: modelSecret.data.ref },
      });
      if (source.status !== 201) {
        const pod = await fixture.resource("pod", `${service}-0`, placement);
        const permissions: Record<string, string> = {};
        for (const verb of ["get", "list", "watch", "create", "update", "patch", "delete"]) {
          permissions[verb] = String(
            await fixture
              .kubectl(
                "auth",
                "can-i",
                verb,
                "secrets",
                "--namespace",
                placement,
                `--as=system:serviceaccount:${placement}:${pod.spec.serviceAccountName}`,
                "--quiet=false",
              )
              .catch(() => "denied"),
          ).trim();
        }
        const logs = String(
          await fixture
            .kubectl("logs", `${service}-0`, "--namespace", placement, "--tail=100")
            .catch(() => "unavailable"),
        );
        apiLogs.push({
          event: "gateway-registration-diagnostic",
          permissions,
          categories: [
            ...new Set(
              logs.match(
                /forbidden|permission denied|deadline exceeded|timed out|connection refused|unreachable|failed to resolve|unable to resolve/giu,
              ) ?? [],
            ),
          ],
        });
      }
      assert.equal(source.status, 201, `${JSON.stringify(source.error)} ${apiDiagnostic()}`);
      assert.deepEqual(source.data.status, { state: "ready" });
      assert.equal(JSON.stringify(source).includes(env.OPENAI_API_KEY!), false);
      const base = createHarnessConfiguration(
        "openclaw",
        env.OCC_TEST_OPENAI_MODEL!.replace(/^openai\//u, ""),
      );
      assert.ok(base.models.providers.openai);
      const native = {
        ...base,
        models: {
          providers: {
            openai: {
              ...base.models.providers.openai,
              baseUrl: modelBaseUrl,
              apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
            },
          },
        },
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
        gateway: {
          ...base.gateway,
          ...workspaceGateway.nativeOptions.gatewayAuth,
          auth: {
            ...workspaceGateway.nativeOptions.gatewayAuth.auth,
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
      };
      const agentConfiguration = await request(
        "POST",
        `/namespaces/${namespaceId}/configurations`,
        {
          kind: "agent",
          values: native,
        },
      );
      assert.equal(agentConfiguration.status, 201, JSON.stringify(agentConfiguration.error));
      const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: "namespace-lifecycle-agent",
        configurationId: agentConfiguration.data.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.data.id },
        credentialSources: [{ sourceId: source.data.id }],
      });
      assert.equal(agent.status, 201, JSON.stringify(agent.error));
      const path = `/namespaces/${namespaceId}/agents/${agent.data.id}`;
      const credentials = await request("POST", `${path}/runtime-credentials`, {});
      assert.equal(credentials.status, 200, JSON.stringify(credentials.error));
      assert.equal(credentials.data.transportConfigured, true);
      // The normal Agent principal needs permission on its exact source, not on the Secret.
      const role = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
        name: "Exact model source operate",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      });
      assert.equal(role.status, 201, JSON.stringify(role.error));
      const binding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: agent.data.servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "credential_source",
        resourceId: source.data.id,
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.error));
      const deployed = await request("POST", `${path}/deploy`);
      assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
      assert.equal(deployed.data.harness.mode, "dedicated");
      assert.equal(deployed.data.harness.id, "openclaw");
      assert.deepEqual(deployed.data.harnessAuth, agent.data.harnessAuth);
      try {
        await waitForOpenShellRevisionActivation(fixture.waitFor, {
          request,
          agentPath: path,
          revisionId: deployed.data.id,
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "Agent activation failed"} ${apiDiagnostic()}`,
          { cause: error },
        );
      }
      const sandbox = await fixture.waitForSandbox(placement, deployed.data);
      const harness = await fixture.waitForProviderHarnessPod(placement, deployed.data);
      assert.equal(harness.metadata.namespace, placement);
      assert.equal(harness.spec.serviceAccountName, sandboxAccount);
      // The authorized gateway-configured identity uses the maintained launcher's Namespace account.
      await fixture.assertProviderOwnedHarness(
        placement,
        deployed.data,
        sandbox,
        harness,
        "maintainedLauncher",
      );
      const workspaceAfter = await provider.getWorkspace(placement, AbortSignal.timeout(10_000));
      assert.ok(workspaceBefore);
      assert.ok(workspaceAfter);
      assert.equal(workspaceAfter.name, workspaceBefore.name);
      assert.equal(
        workspaceAfter.id,
        workspaceBefore.id,
        "Agent deployment must reuse the Workspace created by Namespace reconciliation",
      );
      assert.deepEqual(workspaceAfter.labels, workspaceBefore.labels);
      const gatewayPods = (await fixture.resources("pods", placement)).filter(
        (pod: { metadata: { labels?: Record<string, string> } }) =>
          pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id &&
          pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      );
      assert.equal(gatewayPods.length, 1);
      assert.equal(gatewayPods[0].metadata.labels["openclaw.dev/namespace"], namespaceId);
      assert.equal(gatewayPods[0].metadata.labels["openclaw.dev/revision"], deployed.data.id);
      const gatewayContainer = gatewayPods[0].spec.containers.find(
        (container: { name: string }) => container.name === "gateway",
      );
      const workspaceNodeId = gatewayContainer.env.find(
        (entry: { name: string; value?: string }) => entry.name === "OPENCLAW_WORKSPACE_NODE_ID",
      )?.value;
      assert.equal(typeof workspaceNodeId, "string");
      assert.ok(workspaceNodeId.length > 0);
      const { GatewayClient } = await import(require.resolve("@openclaw/gateway-client"));
      const hello = Promise.withResolvers();
      const client = new GatewayClient({
        url: `wss://${workspaceGateway.routing.hostname}:${gatewayEndpointPort}${path}`,
        edgeAuthHeaders: { "x-api-key": workspaceGateway.apiKey },
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes: [],
        deviceIdentity: null,
        onHelloOk: hello.resolve,
        onConnectError: (error: { code?: string; details?: { httpStatus?: number } }) => {
          // The real client retries startup admission; authentication refusals still fail immediately.
          if (error.code === "UNAVAILABLE" && error.details?.httpStatus === 503) {
            return;
          }
          hello.reject(error);
        },
      });
      const timeout = setTimeout(
        () => hello.reject(new Error("Agent gateway connection timed out")),
        120_000,
      );
      try {
        client.start();
        await hello.promise;
        // Runtime Pod readiness precedes native node enrollment. Use the live Gateway contract
        // to wait for this revision's exact paired node before exercising its remote workspace.
        await fixture.waitFor(
          "the revision's native workspace node connection",
          async () => {
            const { nodes } = await client.request("node.list", {});
            return nodes.some(
              (node: { nodeId: string; paired: boolean; connected: boolean }) =>
                node.nodeId === workspaceNodeId && node.paired && node.connected,
            )
              ? true
              : undefined;
          },
          120_000,
        );
        const nonce = `namespace-proof-${randomUUID()}`;
        const sessionKey = `agent:main:${nonce}`;
        const sent = await client.request("chat.send", {
          sessionKey,
          idempotencyKey: randomUUID(),
          message: `Reply with exactly this nonce and no other text: ${nonce}`,
        });
        await fixture.waitFor(
          "real Agent model turn completion",
          async () => {
            const outcome = await client.request("agent.wait", {
              runId: sent.runId,
              timeoutMs: 3_000,
            });
            if (["pending", "timeout"].includes(outcome.status) && outcome.endedAt === undefined) {
              return undefined;
            }
            assert.equal(
              outcome.status,
              "ok",
              `the real provider-backed Agent run must succeed: ${redactedQaTail(
                JSON.stringify(outcome),
                {
                  ...environment,
                  AUTH_SECRET: authSecret,
                  BOOTSTRAP_PASSWORD: credentials.password,
                  GATEWAY_API_KEY: workspaceGateway.apiKey,
                },
                { lines: 4, lineChars: 2000 },
              ).join("\n")}`,
            );
            return true;
          },
          600_000,
        );
        const history = await client.request("chat.history", { sessionKey, limit: 20 });
        assert.ok(
          history.messages.some(
            (message: { role: string; content: string | { type: string; text?: string }[] }) =>
              message.role === "assistant" &&
              (typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
              ).includes(nonce),
          ),
          "the real model must return the unique nonce",
        );
      } catch (error) {
        const pods = await fixture.resources("pods", placement);
        const messages: string[] = [];
        for (const pod of pods.filter(
          (pod: { metadata: { labels?: Record<string, string> } }) =>
            pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id &&
            pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
        )) {
          const logs = String(
            await fixture
              .kubectl(
                "logs",
                pod.metadata.name,
                "--namespace",
                placement,
                "--container",
                "gateway",
                "--tail=150",
              )
              .catch(() => "unavailable"),
          );
          messages.push(
            ...logs
              .split("\n")
              .filter((line) =>
                /unauthor|forbidden|denied|admission|origin|proxy|error|failed/iu.test(line),
              )
              .slice(-16),
          );
        }
        // eslint-disable-next-line preserve-caught-error -- Raw gateway responses may contain credentials; retain only the redacted diagnostic.
        throw new Error(
          redactedQaTail(
            `${error instanceof Error ? error.message : "Agent model turn failed"}\n${messages.join("\n")}`,
            {
              ...environment,
              AUTH_SECRET: authSecret,
              BOOTSTRAP_PASSWORD: credentials.password,
              GATEWAY_API_KEY: workspaceGateway.apiKey,
            },
            { lines: 18, lineChars: 900 },
          )
            .join("\n")
            .replace(/[A-Za-z0-9_+/.=-]{40,}/g, "[opaque]"),
        );
      } finally {
        clearTimeout(timeout);
        await client.stopAndWait();
      }
      // Teardown goes through the regular Agent operation before Namespace cleanup can run.
      assert.equal((await request("DELETE", path)).status, 202);
      await fixture.waitFor(
        "Agent deletion",
        async () => ((await request("GET", path)).status === 404 ? true : undefined),
        120_000,
      );
      // Namespace deletion requires each independent resource owner to finish its cleanup.
      for (const resource of [
        `credential-sources/${source.data.id}`,
        `secrets/${modelSecret.data.id}`,
        `configurations/${agentConfiguration.data.id}`,
      ]) {
        const removed = await request("DELETE", `/namespaces/${namespaceId}/${resource}`);
        assert.equal(removed.status, 204, JSON.stringify(removed.error));
      }
      await provider.health(AbortSignal.timeout(10_000));
      assert.ok(await provider.getWorkspace(placement, AbortSignal.timeout(10_000)));
      testContext.diagnostic(
        `OpenShell Namespace proof: ${name} Agent completed a real model turn and API teardown`,
      );
    };
    await proveAgent(initial[0].id, "default");
    await proveAgent(later.data.id, "later");

    // IAM denial must commit audit evidence without queuing or provisioning a Namespace.
    const ungranted = {
      email: "ungranted@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const ungrantedAccount = await request("POST", "/api/auth/accounts", ungranted);
    assert.equal(ungrantedAccount.status, 201);
    const ungrantedRequest = await createAuthenticatedControllerRequest(
      app,
      ungranted,
      authBaseURL,
    );
    const workBefore = (
      await pool.query(
        "select count(*)::int as count from occ.controller_work where work_kind = 'lifecycle' and namespace_target is not null",
      )
    ).rows[0].count;
    assert.equal((await ungrantedRequest("POST", "/namespaces", { name: "denied" })).status, 403);
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.namespaces where name = 'denied'"))
        .rows[0].count,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from occ.controller_work where work_kind = 'lifecycle' and namespace_target is not null",
        )
      ).rows[0].count,
      workBefore,
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where actor_id = $1 and outcome = 'denied'",
          [ungrantedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Apply a real Installation IAM configuration, then remove its grant while queued
    // work is paused. Account disable is a sign-in control, not an IAM grant revocation.
    await worker.stop();
    const accessPolicy = {
      roles: [{ id: "namespace_creator", permissions: ["namespace:create"] }],
      defaultUserGroups: ["namespace-creators"],
      roleBindings: [
        { group: "namespace-creators", role: "namespace_creator", scope: "installation" },
      ],
    };
    Object.assign(configuration, { iam: accessPolicy });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers(true));
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    const queuedActor = {
      email: "queued-actor@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const queuedAccount = await request("POST", "/api/auth/accounts", queuedActor);
    assert.equal(queuedAccount.status, 201);
    const queuedRequest = await createAuthenticatedControllerRequest(app, queuedActor, authBaseURL);
    const revoked = await queuedRequest("POST", "/namespaces", { name: "revoked-before-dispatch" });
    assert.equal(revoked.status, 201);
    placements.push(kubernetesNamespaceName(revoked.data.id));
    accessPolicy.roleBindings = [];
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers(true));
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    worker = startWorker(await loadDrivers());
    await worker.start();
    await fixture.waitFor("revoked queued actor fails before infrastructure", async () => {
      const observed = (
        await pool.query(
          "select state, actor_id from occ.controller_work where namespace_id = $1 and namespace_target = 'ready'",
          [revoked.data.id],
        )
      ).rows[0];
      assert.equal(observed.actor_id, queuedAccount.data.principalId);
      return observed.state === "failed_permanent" ? true : undefined;
    });
    assert.equal(
      String(
        await fixture.kubectl(
          "get",
          "namespace",
          kubernetesNamespaceName(revoked.data.id),
          "--ignore-not-found=true",
          "-o",
          "json",
        ),
      ).trim(),
      "",
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where namespace_id = $1 and actor_id = $2 and outcome = 'denied'",
          [revoked.data.id, queuedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Kubernetes quota is a real provider refusal after owned Secrets have been created.
    // Deleting this partial setup must remove those resources without requiring a gateway.
    await worker.stop();
    const originalQuota = structuredClone(
      configuration.drivers.compute.configuration.resources.namespace.quota,
    );
    Object.assign(configuration.drivers.compute.configuration.resources.namespace.quota, {
      services: "0",
    });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    const refused = await request("POST", "/namespaces", { name: "quota-refused" });
    assert.equal(refused.status, 201);
    const refusedPlacement = await prepareNamespace(refused.data.id);
    await fixture.waitFor("provider refusal blocks readiness", async () => {
      const observed = await request("GET", `/namespaces/${refused.data.id}`);
      assert.equal(observed.status, 200);
      assert.notEqual(observed.data.status, "ready");
      return observed.data.status === "failed" ? true : undefined;
    });
    assert.ok(await fixture.maybeResource("secret", `${service}-jwt-keys`, refusedPlacement));
    assert.equal(await fixture.maybeResource("service", service, refusedPlacement), undefined);
    const remove = async (id: string, { retainBackingNamespace = false } = {}) => {
      assert.equal((await request("DELETE", `/namespaces/${id}`)).status, 202);
      await fixture.waitFor("Namespace cleanup completes through the worker", async () => {
        if ((await request("GET", `/namespaces/${id}`)).status === 404) {
          return true;
        }
        const work = (
          await pool.query(
            "select state from occ.controller_work where namespace_id = $1 and namespace_target = 'deleted'",
            [id],
          )
        ).rows[0];
        assert.notEqual(
          work?.state,
          "failed_permanent",
          JSON.stringify(namespaceOutcomes.slice(-5)),
        );
        return undefined;
      });
      if (retainBackingNamespace) {
        return;
      }
      assert.equal(
        String(
          await fixture.kubectl(
            "get",
            "namespace",
            kubernetesNamespaceName(id),
            "--ignore-not-found=true",
            "-o",
            "json",
          ),
        ).trim(),
        "",
      );
    };
    await remove(refused.data.id);
    await worker.stop();
    configuration.drivers.compute.configuration.resources.namespace.quota = originalQuota;
    for (const object of templates) {
      if (object.kind === "Deployment" || object.kind === "StatefulSet") {
        object.spec.replicas = 0;
      }
    }
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    // A Service can exist without a reachable gateway. Deletion must remove the actual
    // partially prepared resources rather than retry an RPC to an absent backend forever.
    const cold = await request("POST", "/namespaces", { name: "gateway-never-started" });
    assert.equal(cold.status, 201);
    const coldPlacement = await prepareNamespace(cold.data.id);
    await fixture.waitFor("unavailable gateway Service created by the Driver", () =>
      fixture.maybeResource("service", service, coldPlacement),
    );
    assert.notEqual((await request("GET", `/namespaces/${cold.data.id}`)).data.status, "ready");
    await remove(cold.data.id);

    await worker.stop();
    const externalPlacement = `ext-${randomUUID().slice(0, 8)}`;
    await fixture.kubectl("create", "namespace", externalPlacement);
    placements.push(externalPlacement);
    await fixture.kubectl(
      "annotate",
      "namespace",
      externalPlacement,
      "openclaw.dev/namespace-lifecycle=external",
    );
    await fixture.kubectl(
      "label",
      "namespace",
      externalPlacement,
      "pod-security.kubernetes.io/enforce=baseline",
      "pod-security.kubernetes.io/audit=restricted",
      "pod-security.kubernetes.io/warn=restricted",
    );
    await fixture.kubectl(
      "create",
      "configmap",
      "operator-sentinel",
      "--namespace",
      externalPlacement,
      "--from-literal=owner=operator",
    );
    const externalUid = (await fixture.resource("namespace", externalPlacement)).metadata.uid;
    const sentinelUid = (
      await fixture.resource("configmap", "operator-sentinel", externalPlacement)
    ).metadata.uid;
    const external = await request("POST", "/namespaces", {
      name: "unclaimed-external",
      existingNamespace: externalPlacement,
    });
    assert.equal(external.status, 201);
    await prepareNamespace(external.data.id, externalPlacement);
    worker = startWorker(await loadDrivers());
    await worker.start();
    // An incompatible operator Pod Security setting refuses adoption before ownership is claimed.
    // Require the committed Compute refusal, so an undispatched queue item cannot satisfy this.
    await fixture.waitFor("Compute refuses external adoption before claiming", async () => {
      const evidence = (
        await pool.query(
          "select details from occ.audit_events where namespace_id = $1 and action = 'openclaw.namespaces.lifecycle.ensure'",
          [external.data.id],
        )
      ).rows;
      return evidence.some(({ details }) =>
        details.participants?.some(
          (participant: { registrationId: string; outcome: string }) =>
            participant.registrationId === drivers.computeDriver.id &&
            participant.outcome === "permanent",
        ),
      )
        ? true
        : undefined;
    });
    assert.equal((await request("GET", `/namespaces/${external.data.id}`)).data.status, "failed");
    const unclaimed = await fixture.resource("namespace", externalPlacement);
    assert.equal(unclaimed.metadata.labels?.["openclaw.dev/namespace"], undefined);
    assert.equal(unclaimed.metadata.annotations?.["openclaw.dev/namespace-id"], undefined);
    assert.equal(await fixture.maybeResource("service", service, externalPlacement), undefined);
    await remove(external.data.id, { retainBackingNamespace: true });
    assert.equal(
      (await fixture.resource("namespace", externalPlacement)).metadata.uid,
      externalUid,
    );
    assert.equal(
      (await fixture.resource("configmap", "operator-sentinel", externalPlacement)).metadata.uid,
      sentinelUid,
    );
    const cleanupEvidence = (
      await pool.query(
        "select details from occ.audit_events where namespace_id = $1 and action = 'openclaw.namespaces.lifecycle.delete'",
        [external.data.id],
      )
    ).rows;
    assert.ok(cleanupEvidence.length > 0);
    assert.ok(
      cleanupEvidence.every(({ details }) =>
        details.participants?.every(
          ({ registrationId }: { registrationId: string }) =>
            registrationId !== drivers.sandboxDriver!.id,
        ),
      ),
    );
    await remove(later.data.id);
    const remaining = await connected(kubernetesNamespaceName(initial[0].id));
    await remaining.client.health(AbortSignal.timeout(10_000));
    assert.ok(
      await remaining.client.getWorkspace(
        kubernetesNamespaceName(initial[0].id),
        AbortSignal.timeout(10_000),
      ),
    );
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
      0,
    );
  },
);
