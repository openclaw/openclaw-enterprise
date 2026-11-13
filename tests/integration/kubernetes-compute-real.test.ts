import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Static } from "typebox";
import type {
  KubernetesComputeDriverOptions,
  KubernetesWorkloadPeer,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { PostgresDevelopmentConfig } from "../../apps/controller/src/composition/development-postgres.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import {
  WORKSPACE_DEFAULTS_ID,
  type AgentDeploymentDiagnosticsResponse,
  type AgentDeploymentStatusResponse,
  type AgentResponse,
  type AgentRevisionResponse,
  type AgentRuntimeCredentialResponse,
  type AgentRuntimeCredentialsBody,
  type AgentRuntimeImagesResponse,
  type AgentRuntimeLogsResponse,
  type AgentRuntimeResponse,
  type ConfigurationResponse,
  type CreateAgentBody,
  type CreateConfigurationBody,
  type CreateNamespaceBody as CreateNamespaceBodySchema,
  type CreateSecretBody,
  type ErrorResponse,
  type HarnessExecutionMode,
  type IAMAccessBindingListResponse,
  type NamespaceResponse,
  type SecretResponse,
  type UpdateAgentBody,
  type UpdateConfigurationBody,
} from "../../packages/contracts/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { inlineProbeCommand } from "../helpers/kubernetes-real.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import {
  kubeconfigPath,
  kubernetesContext,
  runtimeImage,
  databaseUrl,
  requiresKubernetesAndPostgres,
  probeSource,
  hash,
  kubectl,
  kubectlRead as runKubectlRead,
  resource as readResource,
  resources as listResources,
  missing,
  waitFor as waitForFixture,
  waitForDeletedClaim,
  assertKubernetesFixtureAvailable,
  namespace,
  agentName,
  gatewayName,
  revisionName,
  assertReadyGateway as readyGateway,
  assertHarnessWorkspaceClaim as workspaceClaim,
  assertAgentServiceEndpointCount,
  fixtureComputeConfiguration as createComputeConfiguration,
  workloadPod as findWorkloadPod,
  assertExecDenied,
  createDnsTrafficFixture as provisionDnsTrafficFixture,
  deleteNamespaces,
} from "../helpers/kubernetes-compute-real.mjs";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type ObjectMetadata = InstanceType<KubernetesSdk["V1ObjectMeta"]> & { name: string; uid: string };
type ListedObject = { metadata: ObjectMetadata };
type Pod = InstanceType<KubernetesSdk["V1Pod"]> & {
  metadata: ObjectMetadata & { namespace: string };
  spec: InstanceType<KubernetesSdk["V1PodSpec"]>;
  status: InstanceType<KubernetesSdk["V1PodStatus"]>;
};
type Deployment = InstanceType<KubernetesSdk["V1Deployment"]> & {
  metadata: ObjectMetadata;
  spec: InstanceType<KubernetesSdk["V1DeploymentSpec"]> & {
    template: { metadata: ObjectMetadata; spec: Pod["spec"] };
  };
};
type ResourceByKind = {
  namespace: ListedObject;
  secret: ListedObject & { data: Record<string, string> };
  deployment: Deployment;
  serviceaccount: ListedObject;
  configmap: ListedObject;
  persistentvolumeclaim: ListedObject;
  networkpolicy: ListedObject & InstanceType<KubernetesSdk["V1NetworkPolicy"]>;
};
type ResourcesByKind = { pods: Pod; deployments: Deployment };
type AgentWithSecrets = AgentResponse["data"] & {
  modelSecretId: string;
  boundSecretId?: string;
  boundSecretValue?: string | undefined;
};
type Revision = AgentRevisionResponse["data"];
type RuntimeImagesResponse = Static<typeof AgentRuntimeImagesResponse>;
type CreateNamespaceBody = Static<typeof CreateNamespaceBodySchema>;
type ApiEnvelope<T extends { data: unknown }> =
  (T & { error?: never }) | (ErrorResponse & { data?: never });
type ApiResult<T extends { data: unknown }> = { status: number } & ApiEnvelope<T>;
type RequestOptions = {
  session?: false | string | { cookie: string; origin: string };
  headers?: Record<string, string>;
};
type RequestPayload =
  | CreateNamespaceBody
  | CreateAgentBody
  | CreateConfigurationBody
  | CreateSecretBody
  | UpdateAgentBody
  | UpdateConfigurationBody
  | AgentRuntimeCredentialsBody;
type WorkspaceFiles = Record<string, string>;
type DnsProtocol = "udp" | "tcp";
type DnsAnswer = { address: string };
type DnsTrafficFixture = {
  selected: Pod;
  unselected: Pod;
  control: Pod;
  query(source: Pod, target: Pod, protocol: DnsProtocol, port: number): Promise<string>;
  assertQueryDenied(
    description: string,
    source: Pod,
    target: Pod,
    protocol: DnsProtocol,
    port: number,
  ): Promise<void>;
};

const kubectlRead: (...args: string[]) => Promise<string> = runKubectlRead;
const assertReadyGateway: (
  placement: string,
  agentId: string,
  namespaceId: string,
  candidate?: Revision,
) => Promise<Deployment> = readyGateway;
const assertHarnessWorkspaceClaim: (
  placement: string,
  namespaceId: string,
  agentId: string,
  expectedUid?: string,
) => Promise<ListedObject> = workspaceClaim;
const createDnsTrafficFixture = provisionDnsTrafficFixture as (
  context: TestContext,
  peer: KubernetesWorkloadPeer,
) => Promise<DnsTrafficFixture>;
const fixtureComputeConfiguration = createComputeConfiguration as (
  overrides: Partial<KubernetesComputeDriverOptions>,
) => KubernetesComputeDriverOptions;
const resource: <K extends keyof ResourceByKind>(
  kind: K,
  name: string,
  namespace?: string,
) => Promise<ResourceByKind[K]> = readResource;
const resources: <K extends string>(
  kind: K,
  namespace: string,
) => Promise<(K extends keyof ResourcesByKind ? ResourcesByKind[K] : ListedObject)[]> =
  listResources;
const workloadPod: (namespace: string, selector: string) => Promise<Pod | undefined> =
  findWorkloadPod;
const waitFor: <T>(
  description: string,
  operation: () => T | false | undefined | Promise<T | false | undefined>,
  timeoutMs?: number,
) => Promise<T> = waitForFixture;

test(
  "authenticated PostgreSQL OCC API and worker deploy real Agent-owned gateways, Secret bindings, and revisions",
  { ...requiresKubernetesAndPostgres, timeout: runtimeImage === undefined ? 360_000 : 600_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    assert.ok(databaseUrl);
    assert.ok(kubeconfigPath && kubernetesContext);
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

    const { kubernetesNamespaceName } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");
    const { kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const installation = createInstallationDriverConfiguration();
    async function runtimeNodeName(): Promise<string> {
      const nodes = JSON.parse(await kubectl("get", "nodes", "-o", "json")) as {
        items: ListedObject[];
      };
      const name = nodes.items[0]?.metadata.name;
      assert.ok(name, "Kubernetes must report a node for the runtime Gateway");
      return name;
    }
    const computeConfiguration = fixtureComputeConfiguration(
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
                "kubernetes.io/hostname": await runtimeNodeName(),
              },
              channels: { proxyUrl: "http://10.42.0.15:3128" },
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
    const authentication = { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext };
    const configuration = {
      ...installation,
      drivers: {
        ...installation.drivers,
        compute: {
          ...installation.drivers.compute,
          configuration: {
            ...computeConfiguration,
            network: { ...computeConfiguration.network, pluginStatusProxySourceCidrs: proxyCidrs },
          },
        },
        configuration: {
          ...installation.drivers.configuration,
          configuration: { ...installation.drivers.configuration.configuration, authentication },
        },
        secret: {
          ...installation.drivers.secret,
          configuration: { ...installation.drivers.secret.configuration, authentication },
        },
      },
    };
    // Each API and worker process installs its own token issuers, including after a failed start.
    async function loadDrivers() {
      const drivers = await loadInstallationConfiguration({
        mode: "development",
        environment: {},
        startupConfiguration: { configuration, logging: { level: "info" } },
      });
      assert.ok(drivers);
      return drivers;
    }
    const adminCredentials = {
      email: "admin-kubernetes-integration@example.test",
      password: "kubernetes-integration-admin-password",
    };
    const namespaceIds: string[] = [];
    const placements = new Map<string, string>();
    function placementOf(namespaceId: string): string {
      const placement = placements.get(namespaceId);
      assert.ok(placement, `Namespace ${namespaceId} must have a recorded placement`);
      return placement;
    }
    const existingName = `oce-api-existing-${hash(randomUUID())}`;
    const lifecycle: {
      app?: Awaited<ReturnType<typeof composePostgresDevelopment>>;
      worker?: ReturnType<typeof createControllerWorker>;
      workerPool?: InstanceType<typeof pg.Pool>;
    } = {};
    context.after(async () => {
      if (lifecycle.worker !== undefined) {
        await lifecycle.worker.stop();
      } else if (lifecycle.workerPool !== undefined) {
        await lifecycle.workerPool.end();
      }
      if (lifecycle.app !== undefined) {
        await lifecycle.app.close();
      }
      await observerPool.end();
      await deleteNamespaces(
        ...new Set([
          existingName,
          ...placements.values(),
          ...namespaceIds.map(kubernetesNamespaceName),
        ]),
      );
    });

    const authSecret = "kubernetes-integration-auth-secret-32-bytes";
    const authBaseURL = "https://console.oce.localhost";
    if (previous === undefined) {
      await ensureDevelopmentBootstrap(context, {
        databaseUrl,
        email: adminCredentials.email,
        password: adminCredentials.password,
        authSecret,
        authBaseURL,
        agentDomain: "agents.oce.localhost",
        installationName: "OpenClaw Kubernetes integration",
      });
    }

    const developmentConfig: PostgresDevelopmentConfig = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    };
    // Both supported startup callers must reject old storage before admitting
    // API writes or claiming work, even when running the development profile.
    // Until it is gone, this Namespace fails every single-cluster Compute preflight in
    // the cluster (driver.preflight, worker start, development composition). Under
    // fileConcurrency, keep this file's lane free of other files that preflight.
    const legacyOwner = namespace("dev-upgrade");
    const legacyName = `oce-gateways-${hash(legacyOwner.id, 24)}`;
    await kubectl("create", "namespace", legacyName);
    try {
      await kubectl(
        "label",
        "namespace",
        legacyName,
        "app.kubernetes.io/managed-by=openclaw-enterprise",
        `openclaw.dev/gateway-namespace=${legacyOwner.id}`,
      );
      await kubectl(
        "annotate",
        "namespace",
        legacyName,
        `openclaw.dev/namespace-id=${legacyOwner.id}`,
      );
      const before = await resource("namespace", legacyName);
      await assert.rejects(async () => {
        const unexpected = await composePostgresDevelopment(developmentConfig, await loadDrivers());
        await unexpected.close();
      }, /Existing split-layout Gateway storage/);
      const rejectedWorker = createControllerWorker({
        drivers: await loadDrivers(),
        pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }),
        emit: () => {},
      });
      try {
        await assert.rejects(rejectedWorker.start(), /Existing split-layout Gateway storage/);
      } finally {
        await rejectedWorker.stop();
      }
      const after = await resource("namespace", legacyName);
      assert.equal(after.metadata.uid, before.metadata.uid);
      assert.deepEqual(after.metadata.labels, before.metadata.labels);
      assert.equal(await missing("namespace", kubernetesNamespaceName(legacyOwner.id)), true);
    } finally {
      await kubectl("delete", "namespace", legacyName, "--wait=true");
    }
    const apiDrivers = await loadDrivers();
    const app = await composePostgresDevelopment(developmentConfig, apiDrivers);
    lifecycle.app = app;
    const session = await signInToControllerApp(app, adminCredentials);

    async function request<T extends { data: unknown } = never>(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      url: string,
      payload?: RequestPayload,
      options: RequestOptions = {},
    ): Promise<ApiResult<T>> {
      const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(options.session === false ? {} : authenticatedHeaders(options.session ?? session)),
          ...(mutation ? { origin: authBaseURL } : {}),
          ...options.headers,
          host: new URL(authBaseURL).host,
        },
        ...(payload === undefined ? {} : { payload }),
      });
      return { status: response.statusCode, ...response.json<ApiEnvelope<T>>() };
    }

    async function startWorker({ convergenceTimeoutMs }: { convergenceTimeoutMs?: number } = {}) {
      const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
      lifecycle.workerPool = workerPool;
      const worker = createControllerWorker({
        pool: workerPool,
        drivers: await loadDrivers(),
        pollIntervalMs: 25,
        leaseDurationMs: 30_000,
        maxAttempts: 20,
        ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
        emit: () => {},
      });
      lifecycle.worker = worker;
      await worker.start();
      return worker;
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
      Object.hasOwn(unclaimedExistingNamespace.metadata.labels ?? {}, "openclaw.dev/namespace"),
      false,
    );
    assert.equal(
      Object.hasOwn(
        unclaimedExistingNamespace.metadata.annotations ?? {},
        "openclaw.dev/namespace-id",
      ),
      false,
    );

    // Keep the shared worker running throughout Namespace creation and external namespace adoption.
    let worker = await startWorker();
    const unauthorized = await request(
      "POST",
      "/namespaces",
      { name: "unauthorized" },
      { session: false, headers: { authorization: "Bearer denied" } },
    );
    assert.ok([401, 403].includes(unauthorized.status));

    for (const label of ["primary", "secondary"]) {
      const created = await request<NamespaceResponse>("POST", "/namespaces", {
        name: `kubernetes-${label}-${randomUUID()}`,
      });
      assert.equal(created.status, 201);
      assert.ok(created.data);
      namespaceIds.push(created.data.id);
      placements.set(created.data.id, kubernetesNamespaceName(created.data.id));
    }

    const adopted = await request<NamespaceResponse>("POST", "/namespaces", {
      name: `kubernetes-adopted-${randomUUID()}`,
      existingNamespace: existingName,
    });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.error));
    assert.ok(adopted.data);
    assert.equal(adopted.data.existingNamespace, existingName);
    namespaceIds.push(adopted.data.id);
    placements.set(adopted.data.id, existingName);

    const [primaryNamespaceId, secondaryNamespaceId, adoptedNamespaceId] = namespaceIds;
    assert.ok(primaryNamespaceId && secondaryNamespaceId && adoptedNamespaceId);

    await Promise.all(
      namespaceIds.map((id) =>
        waitFor(`API Namespace ${id} to become ready`, async () => {
          const current = await request<NamespaceResponse>("GET", `/namespaces/${id}`);
          assert.equal(current.status, 200);
          assert.ok(current.data);
          return current.data.status === "ready" ? current.data : undefined;
        }),
      ),
    );
    for (const id of namespaceIds) {
      assert.equal(
        (await resources("deployments", placementOf(id))).length,
        0,
        "a ready Namespace must not have a gateway until an Agent is deployed",
      );
    }
    const adoptedBacking = await resource("namespace", existingName);
    assert.equal(adoptedBacking.metadata.uid, unclaimedExistingNamespace.metadata.uid);
    assert.equal(adoptedBacking.metadata.labels?.["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(adoptedBacking.metadata.labels?.["openclaw.dev/namespace"], adoptedNamespaceId);
    assert.equal(
      adoptedBacking.metadata.annotations?.["openclaw.dev/namespace-id"],
      adoptedNamespaceId,
    );
    assert.equal(
      adoptedBacking.metadata.annotations?.["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(adoptedNamespaceId)), true);
    assert.equal(
      (await state.read((view) => view.namespaces.findNamespace(adoptedNamespaceId)))
        ?.existingNamespace,
      existingName,
      "the real worker must recover explicit namespace selection from PostgreSQL",
    );

    // The caller can operate each Agent's Secrets, so its deploy gives the Agent's
    // ServicePrincipal operate on exactly those Secrets (RFC-0026). A deploy by a caller who
    // cannot operate a source writes no grant and is refused; postgres-default-users.test.ts
    // covers it.
    async function assertDeployGrants(namespaceId: string, agent: AgentWithSecrets) {
      const bindings = await request<IAMAccessBindingListResponse>(
        "GET",
        `/namespaces/${namespaceId}/iam/access-bindings`,
      );
      assert.equal(bindings.status, 200, JSON.stringify(bindings.error));
      assert.ok(bindings.data);
      for (const secretId of [agent.modelSecretId, agent.boundSecretId].filter(Boolean)) {
        const grant: IAMAccessBindingListResponse["data"][number] | undefined = bindings.data.find(
          ({ id }) => id === `binding_${agent.id}_${secretId}_operate`,
        );
        assert.ok(grant && "resourceKind" in grant);
        assert.deepEqual(
          [grant.subjectId, grant.resourceKind, grant.resourceId],
          [agent.servicePrincipalId, "secret", secretId],
          `${agent.id}: deploy grants its Agent operate on Secret ${secretId}`,
        );
      }
    }

    const initialWorkspaceFilesByAgent = new Map<string, WorkspaceFiles>();
    async function assertInitialWorkspace(
      namespaceId: string,
      agentId: string,
      expectedFiles: WorkspaceFiles | undefined,
      candidate: Revision,
      executionMode: HarnessExecutionMode = "dedicated",
    ) {
      assert.ok(expectedFiles);
      const placement = placementOf(namespaceId);
      const output = await kubectlRead(
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
      const files: unknown = JSON.parse(output);
      assert.deepEqual(files, expectedFiles);
      const completed = await state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
      assert.ok(completed);
      assert.equal(completed.completed, true);
      assert.equal(completed.files, undefined, "activation removes staged document bytes");
      const delivered = await resource("secret", `workspace-setup-${hash(agentId)}`, placement);
      const setup = delivered.data["setup.json"];
      assert.ok(setup);
      const payload = JSON.parse(Buffer.from(setup, "base64").toString("utf8")) as {
        completed: boolean;
        files?: WorkspaceFiles;
      };
      assert.equal(payload.completed, true);
      assert.equal(payload.files, undefined, "runtime delivery retains only its restart guard");
    }

    async function createAgent(
      namespaceId: string,
      label: string,
      options: { executionMode?: HarnessExecutionMode; boundSecret?: boolean } = {},
    ): Promise<AgentWithSecrets> {
      const executionMode = options.executionMode ?? "dedicated";
      const model = executionMode === "embedded" ? "openai/gpt-4.1" : "codex/gpt-4.1";
      const agentRuntime = executionMode === "embedded" ? "openclaw" : "codex";
      const secret = await request<SecretResponse>("POST", `/namespaces/${namespaceId}/secrets`, {
        name: `${label} fixture model key`,
        value: `fixture-only-${randomUUID()}`,
      });
      assert.equal(secret.status, 201, JSON.stringify(secret.error));
      assert.ok(secret.data);
      let boundSecret: SecretResponse["data"] | undefined;
      let boundSecretValue: string | undefined;
      if (options.boundSecret === true) {
        boundSecretValue = `bound-secret-${randomUUID()}`;
        const response = await request<SecretResponse>(
          "POST",
          `/namespaces/${namespaceId}/secrets`,
          {
            name: `${label} bound sentinel`,
            value: boundSecretValue,
          },
        );
        assert.equal(response.status, 201, JSON.stringify(response.error));
        assert.ok(response.data);
        boundSecret = response.data;
      }
      const baseValues = {
        gateway: {
          mode: "local",
          bind: "lan",
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
        // A Dedicated Codex Gateway runs the codex plugin, so an allowlist must name it too.
        plugins: { allow: ["codex", "slack"], entries: { slack: { enabled: true } } },
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
      const configuration = await request<ConfigurationResponse>(
        "POST",
        `/namespaces/${namespaceId}/configurations`,
        {
          kind: "agent",
          values: baseValues,
        },
      );
      assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
      assert.ok(configuration.data);
      const created = await request<AgentResponse>("POST", `/namespaces/${namespaceId}/agents`, {
        name: `${label}-${randomUUID()}`,
        configurationId: configuration.data.id,
        ...(runtimeImage === undefined
          ? { gatewayManagedMode: false }
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
      assert.ok(created.data);
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
      if (boundSecret !== undefined) {
        // Configuration save refuses channel credentials without Secret bindings, naming the
        // setting and the binding, before any deployment (finding 2319).
        const missingConfiguration = await request(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          { values: missingChannelBindingValues },
        );
        assert.equal(
          missingConfiguration.status,
          400,
          `${label} before channel Secret bindings: ${JSON.stringify(missingConfiguration.error)}`,
        );
        assert.ok(missingConfiguration.error);
        assert.equal(missingConfiguration.error.code, "INVALID_REQUEST");
        assert.match(
          missingConfiguration.error.message,
          /^Configuration setting channels\.slack\.appToken references SLACK_APP_TOKEN without a Configuration Secret binding: /,
        );
        // This k3d fixture has no runtime.channels proxy and uses the fixture image,
        // so successful deployment proves generic API/IAM/admission/gateway Secret
        // projection. Real Slack channel runtime proof belongs to the real-runtime suite.
        const updated = await request<ConfigurationResponse>(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          {
            values: baseValues,
            secretBindings: {
              BOUND_SENTINEL: {
                source: boundSecret.ref,
                delivery: { type: "env" },
              },
            },
          },
        );
        assert.equal(updated.status, 200, JSON.stringify(updated.error));
      }
      return {
        ...created.data,
        modelSecretId: secret.data.id,
        ...(boundSecret === undefined ? {} : { boundSecretId: boundSecret.id, boundSecretValue }),
      };
    }

    async function deploy(namespaceId: string, agentId: string) {
      const result = await request<AgentRevisionResponse>(
        "POST",
        `/namespaces/${namespaceId}/agents/${agentId}/deploy`,
      );
      assert.equal(result.status, 202, JSON.stringify(result.error));
      assert.ok(result.data);
      assert.deepEqual(result.data.compute, {
        id: apiDrivers.computeDriver.id,
        implementation: apiDrivers.computeDriver.implementation,
      });
      assert.equal(Object.hasOwn(result.data, "servicePrincipalId"), false);
      return result.data;
    }

    async function waitForActive(namespaceId: string, agentId: string, revisionId: string) {
      return waitFor(
        `Agent ${agentId} to activate revision ${revisionId}`,
        async () => {
          const current = await request<AgentResponse>(
            "GET",
            `/namespaces/${namespaceId}/agents/${agentId}`,
          );
          assert.equal(current.status, 200);
          assert.ok(current.data);
          return current.data.activeRevisionId === revisionId ? current.data : undefined;
        },
        runtimeImage === undefined ? 120_000 : 240_000,
      );
    }

    const first = await createAgent(primaryNamespaceId, "first");
    const second = await createAgent(primaryNamespaceId, "second");
    const boundSecretAgent = await createAgent(primaryNamespaceId, "bound-secret", {
      boundSecret: true,
    });
    const separateTenant = await createAgent(secondaryNamespaceId, "separate-tenant");
    const embeddedDelete = await createAgent(secondaryNamespaceId, "embedded-delete", {
      executionMode: "embedded",
    });
    const adoptedTenant = await createAgent(adoptedNamespaceId, "adopted-tenant");
    if (runtimeImage !== undefined) {
      const firstCredentialsPath = `/namespaces/${primaryNamespaceId}/agents/${first.id}/runtime-credentials`;
      const beforeDeploy = await request<AgentRuntimeCredentialResponse>(
        "GET",
        firstCredentialsPath,
      );
      assert.equal(beforeDeploy.status, 200, JSON.stringify(beforeDeploy.error));
      assert.deepEqual(beforeDeploy.data, { transportConfigured: false });
      for (const [namespaceId, agent] of [
        [primaryNamespaceId, second],
        [primaryNamespaceId, boundSecretAgent],
        [secondaryNamespaceId, separateTenant],
        [secondaryNamespaceId, embeddedDelete],
        [adoptedNamespaceId, adoptedTenant],
      ] as const) {
        const provisioned = await request<AgentRuntimeCredentialResponse>(
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
      await resource("secret", name, existingName);
    }
    for (const name of embeddedCredentialSecrets) {
      await resource("secret", name, placementOf(secondaryNamespaceId));
    }
    const admitted = await Promise.all([
      deploy(primaryNamespaceId, first.id),
      deploy(primaryNamespaceId, second.id),
      deploy(secondaryNamespaceId, separateTenant.id),
      deploy(secondaryNamespaceId, embeddedDelete.id),
      deploy(adoptedNamespaceId, adoptedTenant.id),
      deploy(primaryNamespaceId, boundSecretAgent.id),
    ] as const);
    for (const [namespaceId, agent] of [
      [primaryNamespaceId, first],
      [primaryNamespaceId, second],
      [secondaryNamespaceId, separateTenant],
      [secondaryNamespaceId, embeddedDelete],
      [adoptedNamespaceId, adoptedTenant],
      [primaryNamespaceId, boundSecretAgent],
    ] as const) {
      await assertDeployGrants(namespaceId, agent);
    }
    if (runtimeImage !== undefined) {
      const afterDeploy = await request<AgentRuntimeCredentialResponse>(
        "GET",
        `/namespaces/${primaryNamespaceId}/agents/${first.id}/runtime-credentials`,
      );
      assert.equal(afterDeploy.status, 200, JSON.stringify(afterDeploy.error));
      assert.deepEqual(afterDeploy.data, { transportConfigured: true });
      await resource(
        "secret",
        `transport-${hash(first.id)}`,
        kubernetesNamespaceName(primaryNamespaceId),
      );
    }

    await Promise.all(
      (
        [
          [primaryNamespaceId, first, admitted[0]],
          [primaryNamespaceId, second, admitted[1]],
          [primaryNamespaceId, boundSecretAgent, admitted[5]],
          [secondaryNamespaceId, separateTenant, admitted[2]],
          [secondaryNamespaceId, embeddedDelete, admitted[3], "embedded"],
          [adoptedNamespaceId, adoptedTenant, admitted[4], "dedicated"],
        ] as const
      ).map(async ([namespaceId, agent, candidate, executionMode = "dedicated"]) => {
        await waitForActive(namespaceId, agent.id, candidate.id);
        const placement = placementOf(namespaceId);
        await assertReadyGateway(placement, agent.id, namespaceId, candidate);
        const imagePath = `/namespaces/${namespaceId}/agents/${agent.id}/runtime-images`;
        const byContainer = (
          a: { workload: string; container: string },
          b: { workload: string; container: string },
        ) => `${a.workload}/${a.container}`.localeCompare(`${b.workload}/${b.container}`);
        const podImages = async () =>
          (await resources("pods", placement))
            .filter(
              (pod) =>
                pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
                pod.metadata.labels?.["openclaw.dev/revision"] === candidate.id &&
                !pod.metadata.deletionTimestamp,
            )
            .flatMap((pod) =>
              (
                [
                  [pod.spec.containers, pod.status.containerStatuses],
                  [pod.spec.initContainers, pod.status.initContainerStatuses],
                  [pod.spec.ephemeralContainers, pod.status.ephemeralContainerStatuses],
                ] as const
              ).flatMap(([containers = [], statuses = []]) =>
                containers.map((container) => ({
                  workload: `${pod.metadata.namespace}/${pod.metadata.name}`,
                  container: container.name,
                  image: container.image,
                  // Kubernetes reports an unknown image ID as "", which the API returns as null.
                  imageId: statuses.find((state) => state.name === container.name)?.imageID || null,
                })),
              ),
            )
            .sort(byContainer);
        // The read lists live Pods through the Kubernetes API on every call, and its
        // contract reports a failed Kubernetes read as 503 DEPENDENCY_UNAVAILABLE for
        // the caller to retry, so activation cannot make a single read infallible.
        // Pod snapshots taken before and after each read bound what it could see:
        // when they agree the Pods did not change, and the API must match exactly.
        const imagesDeadline = Date.now() + 60_000;
        for (;;) {
          const before = await podImages();
          const imageRead = await request<RuntimeImagesResponse>("GET", imagePath);
          const after = await podImages();
          const retry = Date.now() < imagesDeadline;
          if (
            retry &&
            imageRead.status === 503 &&
            imageRead.error?.code === "DEPENDENCY_UNAVAILABLE"
          ) {
            await delay(500);
            continue;
          }
          assert.equal(imageRead.status, 200, JSON.stringify(imageRead.error));
          assert.ok(imageRead.data);
          assert.equal(imageRead.data.status, "observed");
          if (retry && !isDeepStrictEqual(before, after)) {
            await delay(500);
            continue;
          }
          assert.ok(after.length > 0);
          assert.deepEqual(
            imageRead.data.images
              .map(({ commit, openclawCommit, ...identity }) => {
                assert.ok(commit === null || /^[a-f0-9]{40}$/.test(commit));
                assert.ok(openclawCommit === null || /^[a-f0-9]{40}$/.test(openclawCommit));
                return identity;
              })
              .sort(byContainer),
            after,
          );
          break;
        }
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
            assert.deepEqual(Object.keys(candidate.secretBindings ?? {}), ["BOUND_SENTINEL"]);
            const harnessContainer = deployment.spec.template.spec.containers[0];
            assert.ok(harnessContainer?.env);
            assert.equal(
              harnessContainer.env.some((entry) => entry.name === "BOUND_SENTINEL"),
              false,
              "dedicated Harness must not receive gateway Secret bindings",
            );
            const gatewayDeployment = await resource(
              "deployment",
              gatewayName(agent.id),
              placementOf(namespaceId),
            );
            const gatewayContainer = gatewayDeployment.spec.template.spec.containers[0];
            const projection = gatewayContainer?.env?.find(
              (entry) => entry.name === "BOUND_SENTINEL",
            );
            const secretRef = projection?.valueFrom?.secretKeyRef;
            assert.ok(secretRef);
            assert.equal(secretRef.optional ?? false, false);
            assert.ok(
              secretRef.name,
              "Configuration Secret bindings must render a concrete Kubernetes Secret name",
            );
            const pod = await waitFor(`bound Secret gateway ${agent.id} Pod`, async () =>
              (await resources("pods", placementOf(namespaceId))).find(
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
            const observedSecret = await kubectlRead(
              "exec",
              pod.metadata.name,
              "--namespace",
              placementOf(namespaceId),
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
        assert.ok(storedAgent && storedRevision);
        assert.equal(storedAgent.servicePrincipalId, `service-agent-${agent.id}`);
        assert.equal(storedRevision.servicePrincipalId, storedAgent.servicePrincipalId);
        const account = await resource("serviceaccount", agentName(agent.id), placement);
        assert.equal(
          account.metadata.annotations?.["openclaw.dev/service-principal-id"],
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
        placementOf(primaryNamespaceId),
        `app.kubernetes.io/name=${revisionName(admitted[0])}`,
      ),
      workloadPod(
        kubernetesNamespaceName(primaryNamespaceId),
        `app.kubernetes.io/name=${gatewayName(first.id)}`,
      ),
      workloadPod(
        placementOf(secondaryNamespaceId),
        `app.kubernetes.io/name=${gatewayName(embeddedDelete.id)}`,
      ),
    ]);
    const runningDnsSources = dnsSources.filter((source) => source !== undefined);
    assert.equal(
      runningDnsSources.length,
      dnsSources.length,
      "all API-deployed DNS source Pods must be running",
    );
    for (const protocol of ["udp", "tcp"] as const) {
      for (const [target, port] of [
        [dns.selected, 5353],
        [dns.selected, 5354],
        [dns.unselected, 5353],
      ] as const) {
        assert.equal(
          (JSON.parse(await dns.query(dns.control, target, protocol, port)) as DnsAnswer).address,
          "192.0.2.53",
        );
      }
    }
    // A denied UDP query waits out the probe's 2.5 s timeout, so the three source Pods
    // are probed concurrently. Each Pod still runs one probe at a time, in the same order:
    // the allowed control, both denied queries, then the control again.
    for (const protocol of ["udp", "tcp"] as const) {
      await Promise.all(
        runningDnsSources.map(async (source) => {
          assert.equal(
            (JSON.parse(await dns.query(source, dns.selected, protocol, 5353)) as DnsAnswer)
              .address,
            "192.0.2.53",
            `${source.metadata.name} must resolve over ${protocol} port 5353`,
          );
          for (const [target, port] of [
            [dns.selected, 5354],
            [dns.unselected, 5353],
          ] as const) {
            await dns.assertQueryDenied(
              `DNS from ${source.metadata.name} to ${target.metadata.name} over ${protocol} port ${port}`,
              source,
              target,
              protocol,
              port,
            );
          }
          assert.equal(
            (JSON.parse(await dns.query(source, dns.selected, protocol, 5353)) as DnsAnswer)
              .address,
            "192.0.2.53",
            "the allowed DNS control must still work after denied queries",
          );
        }),
      );
    }

    const deploymentPath = `/namespaces/${primaryNamespaceId}/agents/${first.id}/deployments/${admitted[0].id}`;
    const persistedBefore = await waitFor("first revision deployment to settle", async () => {
      const observed = await request<AgentDeploymentStatusResponse>("GET", deploymentPath);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      assert.ok(observed.data);
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    const diagnosticsPath = `${deploymentPath}/diagnostics`;
    const diagnostics = await request<AgentDeploymentDiagnosticsResponse>("POST", diagnosticsPath);
    assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.error));
    assert.ok(diagnostics.data);
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
      assert.ok(
        gatewayConfiguration?.checkedAt,
        "the real Gateway must answer its native Slack check",
      );
      assert.equal(
        new Date(gatewayConfiguration.checkedAt).toISOString(),
        gatewayConfiguration.checkedAt,
      );
    }
    assert.equal(
      (await request("POST", diagnosticsPath, undefined, { session: false })).status,
      401,
    );
    const persistedAfter = await request<AgentDeploymentStatusResponse>("GET", deploymentPath);
    assert.equal(persistedAfter.status, 200, JSON.stringify(persistedAfter.error));
    assert.deepEqual(persistedAfter.data, persistedBefore);

    // Runtime status and container logs for the same exact revision, read through the
    // regular API with the Installation's Kubernetes credentials. Only Pods carrying
    // this Agent's and revision's labels are listed and read.
    const runtimePath = `${deploymentPath}/runtime`;
    const runningGateway = (observed: ApiResult<AgentRuntimeResponse>) => {
      const runtime = observed.data;
      const source = runtime?.sources.find(({ id }) => id === "gateway");
      return source?.pods.find(({ uid }) =>
        runtime?.pods.some(
          (pod) =>
            pod.uid === uid &&
            pod.containers.some(({ name, state }) => name === "gateway" && state === "running"),
        ),
      );
    };
    const gatewayPod = await waitFor("a running Gateway container in runtime status", async () => {
      const observed = await request<AgentRuntimeResponse>("GET", runtimePath);
      return observed.status === 200 ? runningGateway(observed) : undefined;
    });
    const runtimeStatus = await request<AgentRuntimeResponse>("GET", runtimePath);
    assert.ok(runtimeStatus.data);
    assert.equal(runtimeStatus.data.revisionId, admitted[0].id);
    assert.ok(runtimeStatus.data.pods.every(({ name }) => name.length > 0));
    const logsPath = `${runtimePath}/logs?source=gateway&tailLines=100`;
    const firstPage = await request<AgentRuntimeLogsResponse>("GET", logsPath);
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.error));
    assert.ok(firstPage.data);
    assert.equal(firstPage.data.stream?.pod, gatewayPod.name);
    assert.ok(typeof firstPage.data.cursor === "string");
    assert.ok(
      firstPage.data.records.every(
        (record) => record.type !== "line" || record.contentClass === "operational",
      ),
    );
    const followPage = await request<AgentRuntimeLogsResponse>(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(firstPage.data.cursor)}`,
    );
    assert.equal(followPage.status, 200, JSON.stringify(followPage.error));
    const followCursor = followPage.data?.cursor;
    assert.ok(typeof followCursor === "string");
    // One audited view for the first page; the cursor poll is not re-audited.
    const views = await observerPool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE action = 'openclaw.agents.runtime_logs.view' AND resource_id = $1`,
      [first.id],
    );
    assert.equal(views.rows[0]?.count, 1);
    // Replacing the Pod ends the cursor's instance; the next poll labels it.
    const gatewayPods = JSON.parse(
      await kubectl(
        "get",
        "pods",
        "--all-namespaces",
        "-l",
        `openclaw.dev/revision=${admitted[0].id},openclaw.dev/workload-role=gateway`,
        "-o",
        "json",
      ),
    ) as { items: Pod[] };
    const matchingGateway = gatewayPods.items.find(
      ({ metadata }) => metadata.uid === gatewayPod.uid,
    );
    assert.ok(matchingGateway);
    const gatewayNamespace = matchingGateway.metadata.namespace;
    await kubectl("delete", "pod", gatewayPod.name, "-n", gatewayNamespace, "--wait=false");
    const replacementGateway = await waitFor(
      "a replacement Gateway Pod in runtime status",
      async () => {
        const observed = await request<AgentRuntimeResponse>("GET", runtimePath);
        const pod = observed.status === 200 ? runningGateway(observed) : undefined;
        return pod !== undefined && pod.uid !== gatewayPod.uid ? pod : undefined;
      },
      180_000,
    );
    const replaced = await request<AgentRuntimeLogsResponse>(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(followCursor)}`,
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.error));
    assert.ok(replaced.data);
    const gap = replaced.data.records[0];
    assert.ok(gap);
    assert.equal(gap.type, "gap");
    assert.equal(gap.reason, "stream_replaced");
    assert.equal(replaced.data.stream?.pod, replacementGateway.name);
    const previousInstance = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&pod=${replacementGateway.name}&previous=true`,
    );
    assert.equal(previousInstance.status, 200, JSON.stringify(previousInstance.error));
    assert.equal((await request("GET", runtimePath, undefined, { session: false })).status, 401);

    if (runtimeImage !== undefined) {
      const gatewayTarget = kubernetesNamespaceName(primaryNamespaceId);
      const dataTarget = placementOf(primaryNamespaceId);
      const firstGateway = await resource("deployment", gatewayName(first.id), gatewayTarget);
      assert.equal(firstGateway.spec.template.spec.automountServiceAccountToken, false);
      const env = firstGateway.spec.template.spec.containers[0]?.env;
      const transportUrl = env?.find(({ name }) => name === "APP_SERVER_URL")?.value;
      assert.ok(transportUrl);
      assert.equal(new URL(transportUrl).hostname, `${agentName(first.id)}.${dataTarget}.svc`);
      const gatewayConnectArguments = (target: string) => [
        "exec",
        `deployment/${gatewayName(first.id)}`,
        "--namespace",
        gatewayTarget,
        "-c",
        "gateway",
        "--",
        ...inlineProbeCommand(probeSource, "tcp", target, 18790),
      ];
      await kubectlRead(...gatewayConnectArguments(new URL(transportUrl).hostname));
      // Finding 335: only the probe's own refused or unanswered connection is a
      // denial, never a DNS error or a dropped exec stream.
      for (const [description, forbidden] of [
        ["same-tenant gateway-to-Agent traffic", `${agentName(second.id)}.${dataTarget}.svc`],
        [
          "cross-tenant gateway-to-Agent traffic",
          `${agentName(separateTenant.id)}.${placementOf(secondaryNamespaceId)}.svc`,
        ],
      ] as const) {
        await assertExecDenied(description, gatewayConnectArguments(forbidden));
      }
    }

    async function ownedComputeResources(namespaceName: string, agentId: string) {
      const kinds = [
        ["deployment", "deployments"],
        ["service", "services"],
        ["serviceaccount", "serviceaccounts"],
        ["configmap", "configmaps"],
        ["networkpolicy", "networkpolicies"],
        ["persistentvolumeclaim", "persistentvolumeclaims"],
        ["secret", "secrets"],
      ] as const;
      const owned: { kind: (typeof kinds)[number][0]; name: string; namespace: string }[] = [];
      for (const [kind, plural] of kinds) {
        for (const object of await resources(plural, namespaceName)) {
          if (object.metadata.labels?.["openclaw.dev/agent"] === agentId) {
            owned.push({ kind, name: object.metadata.name, namespace: namespaceName });
          }
        }
      }
      return owned;
    }

    const embeddedPlacement = placementOf(secondaryNamespaceId);
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

    // Agent save refuses a dedicated draft its Configuration cannot serve (no native model
    // catalog), with deployment's message; the deployed revision and its storage stay.
    const updatedEmbedded = await request(
      "PATCH",
      `/namespaces/${secondaryNamespaceId}/agents/${embeddedDelete.id}`,
      { configurationId: embeddedDelete.configurationId, executionMode: "dedicated" },
    );
    assert.equal(updatedEmbedded.status, 400, JSON.stringify(updatedEmbedded.error));
    assert.ok(updatedEmbedded.error);
    assert.match(
      updatedEmbedded.error.message,
      /^Configuration setting models\.providers\.openai\.models must list the selected OpenAI models/,
    );
    // Deleting an active embedded Agent must not finalize until its gateway Pod is gone.
    const deletingEmbedded = await request(
      "DELETE",
      `/namespaces/${secondaryNamespaceId}/agents/${embeddedDelete.id}`,
    );
    assert.equal(deletingEmbedded.status, 202, JSON.stringify(deletingEmbedded.error));
    await waitFor("running embedded Agent deletion to finalize after Pod termination", async () => {
      const current = await request(
        "GET",
        `/namespaces/${secondaryNamespaceId}/agents/${embeddedDelete.id}`,
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
    await assertReadyGateway(embeddedPlacement, separateTenant.id, secondaryNamespaceId);
    const adoptedWorkspace = await assertHarnessWorkspaceClaim(
      existingName,
      adoptedNamespaceId,
      adoptedTenant.id,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      existingName,
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
    const stopped = await request<AgentResponse>(
      "POST",
      `/namespaces/${adoptedNamespaceId}/agents/${adoptedTenant.id}/stop`,
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
    assert.ok(stopped.data);
    assert.equal(stopped.data.desiredRuntimeState, "stopped");
    await waitFor("the stopped Agent pointer and real runtime to be cleared", async () => {
      const current = await request<AgentResponse>(
        "GET",
        `/namespaces/${adoptedNamespaceId}/agents/${adoptedTenant.id}`,
      );
      assert.equal(current.status, 200);
      assert.ok(current.data);
      if (current.data.activeRevisionId !== undefined) {
        return undefined;
      }
      if (!(await missing("deployment", revisionName(admitted[4]), existingName))) {
        return undefined;
      }
      if (!(await missing("deployment", gatewayName(adoptedTenant.id), existingName))) {
        return undefined;
      }
      const ownedPods = (
        await Promise.all([existingName].map((target) => resources("pods", target)))
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
          view.revisions.findRevision(adoptedNamespaceId, adoptedTenant.id, admitted[4].id),
        )
      )?.id,
      admitted[4].id,
      "API stop must retain immutable revision history",
    );

    const restarted = await deploy(adoptedNamespaceId, adoptedTenant.id);
    assert.notEqual(restarted.id, admitted[4].id);
    await waitForActive(adoptedNamespaceId, adoptedTenant.id, restarted.id);
    await assertReadyGateway(existingName, adoptedTenant.id, adoptedNamespaceId, restarted);
    if (runtimeImage !== undefined) {
      await assertInitialWorkspace(
        adoptedNamespaceId,
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
      await kubectlRead(
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
      (await assertHarnessWorkspaceClaim(existingName, adoptedNamespaceId, adoptedTenant.id))
        .metadata.uid,
      adoptedWorkspace.metadata.uid,
    );

    await worker.stop();
    delete lifecycle.worker;
    delete lifecycle.workerPool;
    const replacementPlacement = kubernetesNamespaceName(primaryNamespaceId);
    // A controller upgrade leaves ready Namespaces and their old DNS grants in place.
    // Preparing one replacement must add backend ports without narrowing access for other Agents.
    const readyNamespace = await request<NamespaceResponse>(
      "GET",
      `/namespaces/${primaryNamespaceId}`,
    );
    assert.equal(readyNamespace.data?.status, "ready");
    const legacyDnsPolicies: ResourceByKind["networkpolicy"][] = [];
    for (const target of [replacementPlacement]) {
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
      primaryNamespaceId,
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
    const replacement = await deploy(primaryNamespaceId, first.id);
    worker = await startWorker();
    await waitForActive(primaryNamespaceId, first.id, replacement.id);
    for (const previous of legacyDnsPolicies) {
      const current = await resource("networkpolicy", "allow-dns", previous.metadata.namespace);
      const expected = structuredClone(previous.spec);
      const ports = expected?.egress?.[0]?.ports;
      assert.ok(ports);
      ports.push({ protocol: "UDP", port: 5353 }, { protocol: "TCP", port: 5353 });
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
    const placement = kubernetesNamespaceName(primaryNamespaceId);
    await waitFor(`old revision deployment ${revisionName(admitted[0])} to be deleted`, () =>
      missing("deployment", revisionName(admitted[0]), placement),
    );
    await resource("deployment", revisionName(replacement), placement);
    await assertHarnessWorkspaceClaim(
      placement,
      primaryNamespaceId,
      first.id,
      replacementClaim.metadata.uid,
    );
    assert.equal(
      await kubectlRead(
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
    await assertReadyGateway(placement, first.id, primaryNamespaceId);
    await assertReadyGateway(placement, second.id, primaryNamespaceId);
    await assertReadyGateway(placement, boundSecretAgent.id, primaryNamespaceId);
    assert.equal(
      (await resources("deployments", kubernetesNamespaceName(primaryNamespaceId))).filter(
        ({ spec }) => spec.template.metadata?.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      3,
      "worker restart and replacement revisions must preserve one gateway for each running Agent",
    );

    if (runtimeImage === undefined) {
      // Block the fixture's native readiness using the retained workspace, then
      // prove a failed candidate and recovery both keep the same volume and data.
      await worker.stop();
      delete lifecycle.worker;
      delete lifecycle.workerPool;
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
      const failed = await deploy(primaryNamespaceId, first.id);
      await startWorker({ convergenceTimeoutMs: 20_000 });
      const failedWork = await waitFor(
        "replacement to fail native readiness",
        async () => {
          const work = await observerPool.query<{ state: string; reason_code: string }>(
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
        primaryNamespaceId,
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
      const recovered = await deploy(primaryNamespaceId, first.id);
      await waitForActive(primaryNamespaceId, first.id, recovered.id);
      await waitFor("failed candidate to release its workspace", () =>
        missing("deployment", revisionName(failed), placement),
      );
      await assertHarnessWorkspaceClaim(
        placement,
        primaryNamespaceId,
        first.id,
        replacementClaim.metadata.uid,
      );
      assert.equal(
        await kubectlRead(
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

    const adoptedOwned = await ownedComputeResources(existingName, adoptedTenant.id);
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

    // Agent save refuses an embedded draft of this Codex Agent, as deployment would; the
    // running revision is unaffected.
    const updatedDedicated = await request(
      "PATCH",
      `/namespaces/${adoptedNamespaceId}/agents/${adoptedTenant.id}`,
      { configurationId: adoptedTenant.configurationId, executionMode: "embedded" },
    );
    assert.equal(updatedDedicated.status, 400, JSON.stringify(updatedDedicated.error));
    assert.ok(updatedDedicated.error);
    assert.match(updatedDedicated.error.message, /^The Configuration selects the Codex Harness, /);
    // Public deletion of an active dedicated Agent must remove persisted ownership only after
    // every real Agent-owned Kubernetes effect, including its live Pods, has been removed.
    const deleting = await request<AgentResponse>(
      "DELETE",
      `/namespaces/${adoptedNamespaceId}/agents/${adoptedTenant.id}`,
    );
    assert.equal(deleting.status, 202, JSON.stringify(deleting.error));
    assert.ok(deleting.data);
    assert.equal(deleting.data.status, "deleting");
    await waitFor(
      "running dedicated Agent deletion to finalize after Pod termination",
      async () => {
        const current = await request(
          "GET",
          `/namespaces/${adoptedNamespaceId}/agents/${adoptedTenant.id}`,
        );
        const ownedPods = (
          await Promise.all([existingName].map((target) => resources("pods", target)))
        )
          .flat()
          .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id);
        return current.status === 404 && ownedPods.length === 0 ? true : undefined;
      },
    );
    for (const name of adoptedCredentialSecrets) {
      assert.equal(await missing("secret", name, existingName), true);
    }
    const deletedClaims = [adoptedWorkspace.metadata.name];
    if (runtimeImage !== undefined) {
      deletedClaims.push(`gateway-state-${hash(adoptedTenant.id)}`);
    }
    for (const name of deletedClaims) {
      await waitForDeletedClaim(name, existingName);
    }
    assert.equal(await missing("deployment", gatewayName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("service", gatewayName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("service", agentName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("serviceaccount", agentName(adoptedTenant.id), existingName), true);
    for (const { kind, name, namespace: target } of adoptedOwned) {
      assert.equal(await missing(kind, name, target), true, `${kind} ${name} remains`);
    }
    assert.equal(
      await state.read((view) =>
        view.revisions.findRevision(adoptedNamespaceId, adoptedTenant.id, restarted.id),
      ),
      undefined,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      existingName,
    );
    await resource("namespace", existingName);
    await assertReadyGateway(placement, second.id, primaryNamespaceId);
  },
);
