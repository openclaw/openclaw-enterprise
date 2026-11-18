import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ServiceAccountDriverFactory } from "../../apps/controller/src/composition/installation-config.ts";
import type { composeProduction } from "../../apps/controller/src/composition/production.ts";
import type {
  KubernetesComputeDriver as KubernetesCompute,
  KubernetesComputeDriverOptions,
  KubernetesGatewayRoutingOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  ControllerWorker,
  ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import {
  AgentDeploymentStatusResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  JsonValue,
  NamespaceId,
  NamespaceResponse,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  SecretResponse,
  ServiceAccountResponse,
  type HarnessAuthBinding,
  type HarnessExecutionMode,
  type PluginDesiredSelection,
  type PluginDesiredState,
  type ServiceAccountDriver,
} from "../../packages/contracts/src/index.ts";
import type {
  PersistedNativeIAMState,
  PostgresPool,
} from "../../packages/occ/src/state/postgres-state.ts";
import type { PostgresQueryClient } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.ts";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "./envoy-workspace-gateway.mjs";
import { startWorkspaceGatewayHostRelay } from "./workspace-gateway-host-relay.ts";
import {
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  kubernetesHash as hash,
  productionGatewayMemoryLimit,
} from "./kubernetes-real.ts";
import {
  assertNoSecretMaterial,
  createNativePluginAssertions,
} from "./native-plugin-assertions.ts";
import {
  optionalPluginProofModel,
  requiredPluginProofEnv,
  selectPluginProofInputs,
  type PluginProofInputOptions,
} from "./plugin-driver-proof-inputs.ts";

const authSecret = "plugin-driver-real-auth-secret-32-bytes";
const authBaseURL = "https://console.oce.localhost";
const proofPrefix = "occ-plugin-01a08228";

type FixtureContext = { after: (cleanup: () => Promise<void>) => void };
type FixtureOptions = PluginProofInputOptions & {
  codexCredential?: CodexCredential;
  pluginDriverConfiguration?: Record<string, unknown>;
};
type ControllerApp = Awaited<ReturnType<typeof composeProduction>>;
type InjectOptions = Exclude<
  ControllerApp["inject"] extends {
    (options: infer Options): Promise<unknown>;
    (): unknown;
  }
    ? Options
    : never,
  string
>;
type KubernetesFixture = ReturnType<typeof createRealKubernetesFixture>;
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
type CodexCredential = { accessToken: string; workspaceId: string };
type CodexServiceAccountImport = Awaited<ReturnType<typeof codexServiceAccountImportConfiguration>>;
type AgentSelection = { id: string };
type WorkspaceGateway = {
  apiKey: string;
  routing: KubernetesGatewayRoutingOptions;
  nativeOptions: {
    gatewayAuth: Omit<
      Awaited<ReturnType<typeof createEnvoyWorkspaceGatewayPlan>>["nativeOptions"]["gatewayAuth"],
      "trustedProxies"
    > & { trustedProxies: string[] };
  };
};
type GatewayAuth = WorkspaceGateway["nativeOptions"]["gatewayAuth"];

const podSchema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
    uid: Type.String(),
    namespace: Type.String(),
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
    deletionTimestamp: Type.Optional(Type.String()),
  }),
  status: Type.Optional(
    Type.Object({
      phase: Type.Optional(Type.String()),
      conditions: Type.Optional(
        Type.Array(Type.Object({ type: Type.String(), status: Type.String() })),
      ),
    }),
  ),
});
type TenantPod = Static<typeof podSchema>;

const schemaRefs = {
  SafeJsonValue: JsonValue,
  PluginApprovers: PluginApproversSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginToolPolicy: PluginToolPolicySchema,
};
type ResponseEnvelope = { status: number; data?: unknown; error?: unknown; meta?: unknown };

function nativeConfiguration(harnessId: string, gatewayAuth: GatewayAuth | undefined) {
  const configuration = createHarnessConfiguration(harnessId, optionalPluginProofModel());
  return {
    ...configuration,
    ...(harnessId === "codex" ? { tools: { fs: { workspaceOnly: true } } } : {}),
    ...(gatewayAuth === undefined
      ? {}
      : {
          gateway: {
            ...configuration.gateway,
            ...gatewayAuth,
            auth: { ...gatewayAuth.auth, password: configuration.gateway.auth.password },
          },
        }),
  };
}

function createServiceKeyControllerRequest(app: ControllerApp, serviceKey: string) {
  assert.equal(typeof serviceKey, "string", "a bootstrap service API key is required");
  assert.ok(serviceKey.length > 0, "a bootstrap service API key is required");
  return async (
    method: NonNullable<InjectOptions["method"]>,
    url: string,
    payload?: InjectOptions["payload"],
  ): Promise<ResponseEnvelope> => {
    const response = await app.inject({
      method,
      url,
      headers: { "x-api-key": serviceKey, host: "127.0.0.1" },
      ...(payload === undefined ? {} : { payload }),
    });
    const body: unknown = response.body.length === 0 ? undefined : response.json<unknown>();
    return { status: response.statusCode, ...asRecord(body) };
  };
}

function responseData<Data extends TSchema>(
  response: ResponseEnvelope,
  status: number,
  schema: { properties: { data: Data } },
): Static<Data, typeof schemaRefs> {
  assert.equal(response.status, status, JSON.stringify(response.error));
  assert.ok(
    Check(schemaRefs, schema.properties.data, response.data),
    `HTTP ${status} response must match the data schema`,
  );
  return response.data;
}

function installationAdministratorServicePrincipal(iamState: PersistedNativeIAMState) {
  const administratorRoles = new Set(
    iamState.roles
      .filter((role) =>
        role.permissions.some(
          (permission) =>
            permission.action === "administer" && permission.resourceKind === "installation",
        ),
      )
      .map((role) => role.id),
  );
  const administratorPrincipals = new Set(
    iamState.bindings
      .filter(
        (binding) => binding.subjectKind === "identity" && administratorRoles.has(binding.roleId),
      )
      .map((binding) => binding.subjectId),
  );
  const principal = iamState.identities.find(
    (identity) => identity.kind === "service_principal" && administratorPrincipals.has(identity.id),
  );
  assert.ok(
    principal?.kind === "service_principal",
    "existing proof Installation must have a bootstrap service Principal",
  );
  return principal;
}

function isDesiredPluginState(value: unknown): value is PluginDesiredState {
  return Check(schemaRefs, PluginDesiredStateSchema, value);
}

function desiredPlugins(value: unknown): PluginDesiredState {
  if (value === undefined) {
    return {};
  }
  assert.ok(isDesiredPluginState(value), "Agent response must contain valid plugin selections");
  return value;
}

function createAgentPluginApi({
  request,
  namespaceId,
  gatewayAuth,
}: {
  request: ReturnType<typeof createServiceKeyControllerRequest>;
  namespaceId: string;
  gatewayAuth: GatewayAuth | undefined;
}) {
  async function createAgent({
    harnessId,
    executionMode,
    name,
    harnessAuth,
    backendId,
  }: {
    harnessId: string;
    executionMode: HarnessExecutionMode;
    name: string;
    harnessAuth?: HarnessAuthBinding;
    backendId?: string;
  }) {
    const configuration = responseData(
      await request("POST", `/namespaces/${namespaceId}/configurations`, {
        kind: "agent",
        values: nativeConfiguration(harnessId, gatewayAuth),
      }),
      201,
      ConfigurationResponse,
    );
    return responseData(
      await request("POST", `/namespaces/${namespaceId}/agents`, {
        name,
        configurationId: configuration.id,
        executionMode,
        ...(backendId === undefined ? {} : { backendId }),
        ...(harnessAuth === undefined ? {} : { harnessAuth }),
      }),
      201,
      AgentResponse,
    );
  }

  async function getAgent(agentId: string) {
    const response = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
    return responseData(response, 200, AgentReadResponse);
  }

  async function replaceAgentPlugins(agentId: string, plugins: Record<string, unknown>) {
    const current = await getAgent(agentId);
    const response = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      configurationId: current.configurationId,
      executionMode: current.executionMode,
      ...(current.backendId === undefined ? {} : { backendId: current.backendId }),
      plugins,
    });
    return desiredPlugins(responseData(response, 200, AgentResponse).plugins);
  }

  async function selectPlugin(
    agentId: string,
    { pluginId, ...policy }: { pluginId: string } & Partial<PluginDesiredSelection>,
  ) {
    const current = await getAgent(agentId);
    const plugins = {
      ...desiredPlugins("plugins" in current ? current.plugins : undefined),
      [pluginId]: { enabled: true, ...policy },
    };
    const updated = await replaceAgentPlugins(agentId, plugins);
    return updated[pluginId];
  }

  async function updatePluginPolicy(
    agentId: string,
    pluginId: string,
    payload: { [Key in keyof PluginDesiredSelection]?: PluginDesiredSelection[Key] | null },
  ) {
    const current = await getAgent(agentId);
    const plugins = desiredPlugins("plugins" in current ? current.plugins : undefined);
    const policy = plugins[pluginId];
    assert.ok(policy, `Plugin ${pluginId} must already be selected.`);
    const nextPolicy = Object.fromEntries(
      Object.entries({ ...policy, ...payload }).filter(
        ([, value]) => value !== undefined && value !== null,
      ),
    );
    const updated = await replaceAgentPlugins(agentId, { ...plugins, [pluginId]: nextPolicy });
    return updated[pluginId];
  }

  async function removePluginSelection(agentId: string, pluginId: string) {
    const current = await getAgent(agentId);
    const plugins = { ...desiredPlugins("plugins" in current ? current.plugins : undefined) };
    delete plugins[pluginId];
    await replaceAgentPlugins(agentId, plugins);
  }

  return { createAgent, getAgent, selectPlugin, updatePluginPolicy, removePluginSelection };
}

function installationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  pluginDriverId,
  pluginDriverConfiguration,
  codexServiceAccountImport,
  workspaceGateway,
}: Pick<
  Parameters<typeof createKubernetesInstallationConfiguration>[0],
  "authentication" | "platformNamespace" | "gatewayImage" | "codexImage"
> & {
  pluginDriverId: FixtureOptions["pluginDriverId"];
  pluginDriverConfiguration: Record<string, unknown>;
  codexServiceAccountImport: CodexServiceAccountImport | undefined;
  workspaceGateway: WorkspaceGateway | undefined;
}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: `k3d-${proofPrefix}`,
    codexSeccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
  });
  const compute = configuration.drivers.compute.configuration;
  const { gatewayClients, ...network } = compute.network;
  const dedicated = pluginDriverId === "codex-plugin";
  const resources = {
    ...compute.resources,
    gateway: dedicated
      ? {
          ...compute.resources.gateway,
          limits: { ...compute.resources.gateway.limits, memory: productionGatewayMemoryLimit },
        }
      : compute.resources.gateway,
    namespace: {
      ...compute.resources.namespace,
      quota: {
        pods: "8",
        "requests.cpu": "2",
        "requests.memory": "2Gi",
        // Two Agent/gateway pairs plus an overlapping revision during cutover.
        "limits.cpu": "12",
        "limits.memory": dedicated ? "12Gi" : "6Gi",
      },
    },
  };
  return {
    ...configuration,
    ...(codexServiceAccountImport === undefined
      ? {}
      : {
          backend: [
            {
              id: "openai",
              type: "chatgpt",
              configuration: {
                workspaceId: codexServiceAccountImport.workspaceId,
                apiKeyPath: codexServiceAccountImport.apiKeyPath,
                credentialTtlSeconds: 3_600,
              },
              drivers: { service_account: "chatgpt-service-accounts" },
            },
          ],
        }),
    drivers: {
      ...configuration.drivers,
      secret: {
        ...configuration.drivers.secret,
        configuration: { authentication },
      },
      configuration: {
        ...configuration.drivers.configuration,
        id: "configuration-kubernetes-plugin-real",
      },
      compute: {
        id: "compute-kubernetes-plugin-real",
        configuration: {
          ...compute,
          ...(workspaceGateway === undefined ? {} : { gatewayRouting: workspaceGateway.routing }),
          network: {
            ...network,
            ...(workspaceGateway === undefined
              ? { gatewayClients }
              : {
                  gatewayTrustedProxyCidrs:
                    workspaceGateway.nativeOptions.gatewayAuth.trustedProxies,
                }),
            pluginStatusProxySourceCidrs: pluginProofPluginStatusProxyCidrs(),
          } satisfies KubernetesComputeDriverOptions["network"],
          resources,
          servicePrincipalCredentials: {
            ...compute.servicePrincipalCredentials,
            expirationSeconds: 3_600,
          },
        },
      },
      plugin: [{ id: pluginDriverId, configuration: pluginDriverConfiguration }],
      ...(codexServiceAccountImport === undefined
        ? {}
        : { service_account: { id: "chatgpt-service-accounts", configuration: {} } }),
    },
  };
}

function pluginProofPluginStatusProxyCidrs() {
  const configured = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS;
  assert.ok(
    configured && configured.trim().length > 0,
    "OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS must contain at least one CIDR.",
  );
  const cidrs = configured
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  assert.ok(
    cidrs.length > 0,
    "OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS must contain at least one CIDR.",
  );
  return cidrs;
}

async function codexServiceAccountImportConfiguration(
  directory: string,
  credential: CodexCredential | undefined,
) {
  const imported = credential ?? (await readCodexServiceAccountCredential());
  const apiKeyPath = join(directory, "codex-service-account-import-provider-marker");
  await writeFile(apiKeyPath, "test-only-existing-codex-service-account-import\n", {
    mode: 0o600,
  });
  return { ...imported, apiKeyPath };
}

async function deriveCodexWorkspaceId(accessToken: string) {
  const response = await fetch(
    "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(response.status, 200, "the Codex service-account token must authenticate.");
  const body: unknown = await response.json();
  const accountId = asRecord(body)?.chatgpt_account_id;
  assert.ok(typeof accountId === "string", "whoami must return a ChatGPT account identity.");
  assert.match(accountId, /^[0-9a-f-]{36}$/i, "the ChatGPT account identity must be a UUID.");
  return accountId;
}

type ServiceAccountCompute = Pick<
  KubernetesCompute,
  "storeServiceAccountCredential" | "deleteServiceAccountCredential"
>;

function createImportedCodexServiceAccountDriverFactory(
  imported: CodexServiceAccountImport,
  compute: ServiceAccountCompute,
): ServiceAccountDriverFactory {
  const driverId = "chatgpt-service-accounts";
  const backendId = "openai";
  return (controller, state) => {
    const driver: ServiceAccountDriver = {
      capability: "service_account",
      implementation: "test-existing-codex-import",
      id: driverId,
      async create(account) {
        await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `INSERT INTO occ.service_account_driver_bindings
               (service_account_id, namespace_id, backend_id, driver_id, external_account_id, workspace_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              account.id,
              account.namespaceId,
              backendId,
              driverId,
              `imported-${account.id}`,
              imported.workspaceId,
            ],
          ),
        );
      },
      async createCredential(account) {
        const secretRef = await compute.storeServiceAccountCredential({
          namespaceId: account.namespaceId,
          serviceAccountId: account.id,
          credentialId: `imported-credential-${account.id}`,
          accessToken: imported.accessToken,
        });
        controller.registerRollback(() =>
          compute.deleteServiceAccountCredential({
            namespaceId: account.namespaceId,
            serviceAccountId: account.id,
            secretRef,
            accessToken: imported.accessToken,
          }),
        );
        const result = await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `UPDATE occ.service_account_driver_bindings
             SET external_credential_id = $4
             WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
            [account.id, account.namespaceId, driverId, `imported-credential-${account.id}`],
          ),
        );
        assert.equal(result.rowCount, 1, "imported ServiceAccount binding must be exact.");
        return { kind: "access_token", secretRef };
      },
      async delete(account) {
        if (account.credential?.kind === "access_token") {
          await compute.deleteServiceAccountCredential({
            namespaceId: account.namespaceId,
            serviceAccountId: account.id,
            secretRef: account.credential.secretRef,
          });
        }
        await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `DELETE FROM occ.service_account_driver_bindings
             WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
            [account.id, account.namespaceId, driverId],
          ),
        );
      },
    };
    controller.registerDriver(driver);
    if (controller.selectDriver("service_account", driver.id) !== driver) {
      throw new Error("The configured ServiceAccount Driver was not selected correctly.");
    }
  };
}

async function waitForPluginProofWorkerSuccess(
  waitFor: KubernetesFixture["waitFor"],
  events: readonly WorkerEvent[],
  revisionId: string,
) {
  try {
    await waitFor(`worker completion of ${revisionId}`, () =>
      events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === revisionId &&
          event.outcome === "success" &&
          (event.code === "REVISION_ACTIVATED" || event.code === "REVISION_ALREADY_ACTIVE"),
      ),
    );
  } catch (error) {
    const eventsSummary = sanitizedPluginProofWorkerEvents(events, revisionId);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Worker events: ${JSON.stringify(eventsSummary)}`, {
      cause: error,
    });
  }
}

function sanitizedPluginProofWorkerEvents(events: readonly WorkerEvent[], revisionId: string) {
  return events
    .filter((event) => event.revisionId === revisionId || event.event === "worker.error")
    .slice(-8)
    .map((event) => ({
      event: event.event,
      revisionId: event.revisionId,
      outcome: event.outcome,
      code: event.code,
      step: event.step,
      status: event.status,
      errorClass: event.errorClass,
      dependency: event.dependency,
      cause: event.cause,
      reason: event.reason,
      method: event.method,
      grpcStatus: event.grpcStatus,
      validationCategory: event.validationCategory,
    }));
}

export async function createPluginDriverRealFixture(
  context: FixtureContext,
  {
    scenario,
    pluginDriverId,
    databaseUrl,
    codexCredential,
    pluginDriverConfiguration = {},
  }: FixtureOptions,
) {
  const inputs = selectPluginProofInputs({ scenario, pluginDriverId, databaseUrl });
  const { gatewayImage, codexImage, databaseUrl: selectedDatabaseUrl } = inputs;
  const suffix = hash(`${proofPrefix}-${randomUUID()}`);
  const platformNamespace = `${proofPrefix}-${suffix}`;
  const credentials = {
    email: `plugin-driver-${suffix}@example.test`,
    password: `plugin-driver-password-${randomUUID()}`,
  };
  const {
    kubectl,
    resource,
    resources,
    createControllerIdentity,
    waitFor,
    validatePrerequisites,
    provisionAgentTransportSecret,
    startPortForward,
    startPortForwardTarget,
    applyManifest,
  } = createRealKubernetesFixture(inputs);

  const kubeconfig = await validatePrerequisites();
  const cleanupState: {
    worker?: ControllerWorker;
    app?: ControllerApp;
    pool?: PostgresPool;
    tenantNamespace?: string;
  } = {};
  const forwarders: Awaited<ReturnType<typeof startPortForward>>[] = [];
  const gatewayPasswords = new Map<string, string>();

  async function waitForTenantNamespaceDeletion(tenantNamespace: string) {
    try {
      await kubectl("wait", "--for=delete", `namespace/${tenantNamespace}`, "--timeout=60s");
    } catch (error) {
      const failure = asRecord(error);
      if (/NotFound|not found/i.test(`${failure?.stderr ?? ""}\n${failure?.message ?? ""}`)) {
        return;
      }
      throw error;
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "occ-plugin-driver-real-"));
  context.after(async () => {
    const failures: unknown[] = [];
    async function cleanup(operation: () => Promise<unknown> | undefined) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const forwarder of forwarders.splice(0)) {
      await cleanup(() => forwarder.stop());
    }
    await cleanup(() => cleanupState.worker?.stop());
    await cleanup(() => cleanupState.app?.close());
    await cleanup(() => cleanupState.pool?.end());
    const namespace = cleanupState.tenantNamespace;
    if (namespace !== undefined) {
      await cleanup(() =>
        kubectl("delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"),
      );
      await cleanup(() => waitForTenantNamespaceDeletion(namespace));
    }
    for (const role of ["api", "worker"]) {
      await cleanup(() =>
        kubectl(
          "delete",
          "clusterrolebinding",
          `${proofPrefix}-${role}-${suffix}`,
          "--ignore-not-found=true",
        ),
      );
    }
    await cleanup(() =>
      kubectl(
        "delete",
        "clusterrole",
        `${proofPrefix}-namespaces-${suffix}`,
        `${proofPrefix}-tenant-${suffix}`,
        `${proofPrefix}-tenant-pods-${suffix}`,
        `${proofPrefix}-tenant-pods-proxy-${suffix}`,
        `${proofPrefix}-secrets-${suffix}`,
        "--ignore-not-found=true",
      ),
    );
    await cleanup(() =>
      kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true"),
    );
    await cleanup(() => rm(directory, { recursive: true, force: true }));
    if (failures.length !== 0) {
      throw new AggregateError(failures, "Plugin real proof cleanup failed.");
    }
  });

  await kubectl("create", "namespace", platformNamespace);
  // Dedicated Agents use the production routed endpoint. The fixture owns the
  // real Envoy resources; Compute creates each Agent's route during deployment.
  let workspaceGateway: WorkspaceGateway | undefined;
  if (pluginDriverId === "codex-plugin") {
    const helpers = {
      kubectl,
      resource,
      resources,
      waitFor,
      startPortForwardTarget,
      applyManifest,
    };
    await ensureEnvoyGatewayControllers(helpers);
    const plan = await createEnvoyWorkspaceGatewayPlan(context, { platformNamespace }, helpers);
    const endpointPort = await startWorkspaceGatewayHostRelay(context, plan, {
      ...helpers,
      gatewayImage,
    });
    const { gatewayAuth } = plan.nativeOptions;
    const trustedProxies: unknown = gatewayAuth.trustedProxies;
    assert.ok(
      Check(Type.Array(Type.String()), trustedProxies),
      "the Gateway must supply trusted proxy CIDRs",
    );
    workspaceGateway = {
      apiKey: plan.apiKey,
      routing: { ...plan.routing, endpointPort },
      nativeOptions: { gatewayAuth: { ...gatewayAuth, trustedProxies } },
    };
  }
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-namespaces-${suffix}`,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-tenant-${suffix}`,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges,persistentvolumeclaims,jobs.batch,httproutes.gateway.networking.k8s.io,securitypolicies.gateway.envoyproxy.io",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-tenant-pods-${suffix}`,
    "--verb=get,list,watch",
    "--resource=pods",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-tenant-pods-proxy-${suffix}`,
    "--verb=get",
    "--resource=pods/proxy",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-secrets-${suffix}`,
    "--verb=get,create,patch,update,delete",
    "--resource=secrets",
  );

  const createIdentity = (role: "api" | "worker") =>
    createControllerIdentity({
      directory,
      platformNamespace,
      kubeconfig,
      account: `${proofPrefix}-${role}`,
      clusterRole: `${proofPrefix}-namespaces-${suffix}`,
      clusterRoleBinding: `${proofPrefix}-${role}-${suffix}`,
      context: `${proofPrefix}-${role}-${suffix}`,
    });
  const [api, workerIdentity] = await Promise.all([
    createIdentity("api"),
    createIdentity("worker"),
  ]);

  const apiConfigurationPath = join(directory, "api-installation.yaml");
  const workerConfigurationPath = join(directory, "worker-installation.yaml");
  const codexServiceAccountImport =
    pluginDriverId === "codex-plugin"
      ? await codexServiceAccountImportConfiguration(directory, codexCredential)
      : undefined;
  await Promise.all([
    writeFile(
      apiConfigurationPath,
      JSON.stringify(
        installationConfiguration({
          authentication: api.authentication,
          platformNamespace,
          gatewayImage,
          codexImage,
          pluginDriverId,
          pluginDriverConfiguration,
          codexServiceAccountImport,
          workspaceGateway,
        }),
      ),
      { mode: 0o600 },
    ),
    writeFile(
      workerConfigurationPath,
      JSON.stringify(
        installationConfiguration({
          authentication: workerIdentity.authentication,
          platformNamespace,
          gatewayImage,
          codexImage,
          pluginDriverId,
          pluginDriverConfiguration,
          codexServiceAccountImport,
          workspaceGateway,
        }),
      ),
      { mode: 0o600 },
    ),
  ]);

  const driverEnvironment: NodeJS.ProcessEnv = {};
  if (workspaceGateway !== undefined) {
    const keyPath = join(directory, "gateway-api-key");
    await writeFile(keyPath, workspaceGateway.apiKey, { mode: 0o600 });
    driverEnvironment.OCC_GATEWAY_API_KEY_PATH = keyPath;
    driverEnvironment.OCC_GATEWAY_CA_PATH = process.env.OCC_TEST_GATEWAY_CA_CERT_PATH;
  }

  const [
    { PostgresPlatformState },
    { createPostgresControllerAuth },
    { loadInstallationConfiguration },
    { composeProduction },
    { createControllerWorker },
    { KubernetesComputeDriver, kubernetesNamespaceName },
  ] = await Promise.all([
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../apps/controller/src/auth/index.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
  ]);

  const [apiDrivers, workerDrivers] = await Promise.all([
    loadInstallationConfiguration({
      mode: "production",
      environment: { ...driverEnvironment, OCC_CONFIG_PATH: apiConfigurationPath },
    }),
    loadInstallationConfiguration({
      mode: "production",
      environment: { ...driverEnvironment, OCC_CONFIG_PATH: workerConfigurationPath },
    }),
  ]);
  assert.ok(apiDrivers && workerDrivers, "both Installation configurations are required");
  assert.equal(apiDrivers.pluginDrivers?.[0]?.id, pluginDriverId);
  assert.equal(workerDrivers.pluginDrivers?.[0]?.id, pluginDriverId);

  let serviceAccountDriverFactory: ServiceAccountDriverFactory | undefined;
  if (codexServiceAccountImport !== undefined) {
    assert.ok(
      apiDrivers.computeDriver instanceof KubernetesComputeDriver,
      "the configured Kubernetes Compute Driver must store imported ServiceAccount credentials",
    );
    serviceAccountDriverFactory = createImportedCodexServiceAccountDriverFactory(
      codexServiceAccountImport,
      apiDrivers.computeDriver,
    );
  }

  const databasePool = new pg.Pool({ connectionString: selectedDatabaseUrl, max: 4 });
  const proofPool: PostgresPool & PostgresQueryClient = databasePool;
  cleanupState.pool = proofPool;
  const state = new PostgresPlatformState(proofPool);
  const existing = await state.loadInstallation();
  let serviceKey: string;
  if (existing !== undefined) {
    assert.equal(
      existing.name,
      `Plugin Driver real proof ${pluginDriverId}`,
      "refusing to modify a database Installation not owned by this disposable proof",
    );
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: existing.id,
      secret: authSecret,
      baseURL: authBaseURL,
      agentDomain: "agents.oce.localhost",
      pool: databasePool,
    });
    const servicePrincipal = installationAdministratorServicePrincipal(
      await state.loadNativeIAMState(existing.id),
    );
    serviceKey = (
      await auth.createServiceKey({
        principal: servicePrincipal,
        name: `pdr-${suffix}`,
      })
    ).key;
  } else {
    const bootstrap = await ensureDevelopmentBootstrap(context, {
      databaseUrl: selectedDatabaseUrl,
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL,
      installationName: `Plugin Driver real proof ${pluginDriverId}`,
    });
    serviceKey = await readFile(bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE, "utf8");
  }

  const app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl: selectedDatabaseUrl,
    authSecret,
    authBaseURL,
    nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    drivers: apiDrivers,
    ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
  });
  cleanupState.app = app;
  const request = createServiceKeyControllerRequest(app, serviceKey);
  const events: WorkerEvent[] = [];
  const worker = createControllerWorker({
    mode: "production",
    pool: new pg.Pool({ connectionString: selectedDatabaseUrl, max: 6 }),
    drivers: workerDrivers,
    pollIntervalMs: 50,
    leaseDurationMs: 60_000,
    maxAttempts: 30,
    emit: (event) => {
      events.push(event);
    },
  });
  cleanupState.worker = worker;
  await worker.start();

  const createdNamespace = await request("POST", "/namespaces", {
    name: `${proofPrefix}-${suffix}`,
  });
  assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
  const namespaceId = asRecord(createdNamespace.data)?.id;
  assert.ok(Check(NamespaceId, namespaceId), "the created Namespace must have an ID");
  const tenantNamespace = kubernetesNamespaceName(namespaceId);
  cleanupState.tenantNamespace = tenantNamespace;
  await waitFor(`the worker to create ${tenantNamespace}`, async () => {
    try {
      return await resource("namespace", tenantNamespace);
    } catch (error) {
      const failure = asRecord(error);
      if (/NotFound|not found/i.test(String(failure?.stderr ?? failure?.message))) {
        return undefined;
      }
      throw error;
    }
  });
  for (const identity of [api, workerIdentity]) {
    await kubectl(
      "create",
      "rolebinding",
      `${proofPrefix}-${identity.account}`,
      "--namespace",
      tenantNamespace,
      `--clusterrole=${proofPrefix}-tenant-${suffix}`,
      `--serviceaccount=${platformNamespace}:${identity.account}`,
    );
  }
  await kubectl(
    "create",
    "rolebinding",
    `${proofPrefix}-worker-pods`,
    "--namespace",
    tenantNamespace,
    `--clusterrole=${proofPrefix}-tenant-pods-${suffix}`,
    `--serviceaccount=${platformNamespace}:${workerIdentity.account}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    `${proofPrefix}-worker-pods-proxy`,
    "--namespace",
    tenantNamespace,
    `--clusterrole=${proofPrefix}-tenant-pods-proxy-${suffix}`,
    `--serviceaccount=${platformNamespace}:${workerIdentity.account}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    `${proofPrefix}-api-secrets`,
    "--namespace",
    tenantNamespace,
    `--clusterrole=${proofPrefix}-secrets-${suffix}`,
    `--serviceaccount=${platformNamespace}:${api.account}`,
  );
  // The trusted worker delivers runtime projections in the same tenant target.
  await kubectl(
    "create",
    "rolebinding",
    `${proofPrefix}-worker-secrets`,
    "--namespace",
    tenantNamespace,
    `--clusterrole=${proofPrefix}-secrets-${suffix}`,
    `--serviceaccount=${platformNamespace}:${workerIdentity.account}`,
  );
  await waitFor(`namespace ${namespaceId} to become API-ready`, async () => {
    const observed = await request("GET", `/namespaces/${namespaceId}`);
    const namespace = responseData(observed, 200, NamespaceResponse);
    return namespace.status === "ready" ? namespace : undefined;
  });

  const agentApi = createAgentPluginApi({
    request,
    namespaceId,
    gatewayAuth: workspaceGateway?.nativeOptions.gatewayAuth,
  });

  async function createCodexServiceAccountFromToken({
    accessToken,
    name,
  }: {
    accessToken: string;
    name: string;
  }) {
    assert.ok(
      codexServiceAccountImport,
      "Codex ServiceAccounts require the configured test import ServiceAccount Driver.",
    );
    assert.ok(
      accessToken === codexServiceAccountImport.accessToken,
      "Codex ServiceAccount import must use the configured existing test credential.",
    );
    const account = responseData(
      await request("POST", `/namespaces/${namespaceId}/service-accounts`, { name }),
      201,
      ServiceAccountResponse,
    );
    const binding = await proofPool.query(
      `SELECT external_account_id, workspace_id, backend_id, driver_id
       FROM occ.service_account_driver_bindings
       WHERE namespace_id = $1 AND service_account_id = $2`,
      [namespaceId, account.id],
    );
    assert.equal(binding.rowCount, 1, "ServiceAccount creation must persist provider binding.");
    const row = asRecord(binding.rows[0]);
    assert.ok(row, "ServiceAccount binding row must exist");
    assert.equal(row.external_account_id, `imported-${account.id}`);
    assert.equal(row.workspace_id, codexServiceAccountImport.workspaceId);
    assert.equal(row.backend_id, "openai");
    assert.equal(row.driver_id, "chatgpt-service-accounts");

    const issued = await request(
      "POST",
      `/namespaces/${namespaceId}/service-accounts/${account.id}/credentials`,
      {},
    );
    const serviceAccount = responseData(issued, 201, ServiceAccountResponse);
    assert.equal(serviceAccount.credential?.kind, "access_token");
    assertNoSecretMaterial(
      issued,
      [accessToken, codexServiceAccountImport.workspaceId],
      "service-account responses must not expose imported credential values.",
    );
    return serviceAccount;
  }

  async function deployAndWait(agent: AgentSelection) {
    let gatewayPassword = gatewayPasswords.get(agent.id);
    if (gatewayPassword === undefined) {
      gatewayPassword = await provisionAgentTransportSecret(directory, tenantNamespace, agent.id);
      gatewayPasswords.set(agent.id, gatewayPassword);
    }
    const revision = responseData(
      await request("POST", `/namespaces/${namespaceId}/agents/${agent.id}/deploy`),
      202,
      AgentRevisionResponse,
    );
    try {
      await waitFor(`revision ${revision.id} activation`, async () => {
        const current = await agentApi.getAgent(agent.id);
        const deployment = await getDeploymentStatus(agent.id, revision.id);
        assert.notEqual(deployment.status, "failed", JSON.stringify(deployment.error));
        return current.activeRevisionId === revision.id ? current : undefined;
      });
    } catch (error) {
      const diagnostics = await deploymentActivationDiagnostics(agent, revision.id, events);
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`${message} Diagnostics: ${JSON.stringify(diagnostics)}`);
    }
    await waitForPluginProofWorkerSuccess(waitFor, events, revision.id);
    const status = await getDeploymentStatus(agent.id, revision.id);
    assert.equal(status.status, "succeeded", JSON.stringify(status.error));
    return { revision, gatewayPassword, status };
  }

  async function getDeploymentStatus(agentId: string, deploymentId: string) {
    const status = await request(
      "GET",
      `/namespaces/${namespaceId}/agents/${agentId}/deployments/${deploymentId}`,
    );
    return responseData(status, 200, AgentDeploymentStatusResponse);
  }

  async function deploymentActivationDiagnostics(
    agent: AgentSelection,
    revisionId: string,
    workerEvents: readonly WorkerEvent[],
  ) {
    return {
      revisionId,
      agentId: agent.id,
      namespaceId,
      agent: await safeDiagnostic(async () => {
        const current = await agentApi.getAgent(agent.id);
        return {
          activeRevisionId: current.activeRevisionId ?? null,
          desiredRuntimeState: current.desiredRuntimeState ?? null,
        };
      }),
      deployment: await safeDiagnostic(async () => {
        const status = await getDeploymentStatus(agent.id, revisionId);
        return {
          deploymentId: status.deploymentId,
          status: status.status,
          namespaceId: status.namespaceId,
          agentId: status.agentId,
          warnings: status.warnings,
        };
      }),
      controllerWork: await safeDiagnostic(async () => {
        const { rows } = await proofPool.query(
          `SELECT state, reason_code, result_data, attempt_count, available_at, created_at, updated_at, completed_at
             FROM occ.controller_work
            WHERE revision_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [revisionId],
        );
        if (rows[0] === undefined) {
          return null;
        }
        const row = asRecord(rows[0]);
        assert.ok(row, "controller work diagnostic must be a PostgreSQL row");
        return {
          state: row.state,
          reasonCode: row.reason_code,
          warnings: asRecord(row.result_data)?.warnings ?? [],
          attemptCount: row.attempt_count,
          availableAt: row.available_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          completedAt: row.completed_at,
        };
      }),
      workerEvents: sanitizedPluginProofWorkerEvents(workerEvents, revisionId),
      runtime: await safeDiagnostic(async () => {
        const pods = (await tenantPods()).filter(
          (pod) => pod.metadata.labels?.["openclaw.dev/agent"] === agent.id,
        );
        const privateDiagnostics = await mkdtemp(join(tmpdir(), "occ-plugin-proof-failure-"));
        // Keep raw native logs private and outside the fixture directory that cleanup removes.
        for (const pod of pods) {
          try {
            const logs = await kubectl(
              "logs",
              pod.metadata.name,
              "--namespace",
              tenantNamespace,
              "--all-containers=true",
              "--tail=200",
            );
            await writeFile(join(privateDiagnostics, `${pod.metadata.name}.log`), logs, {
              mode: 0o600,
            });
          } catch {
            // Preserve the deployment failure when a removed Pod has no logs.
          }
        }
        return {
          privateDiagnostics,
          pods: pods.map((pod) => ({
            name: pod.metadata.name,
            revisionId: pod.metadata.labels?.["openclaw.dev/revision"],
            role: pod.metadata.labels?.["openclaw.dev/workload-role"],
            phase: pod.status?.phase,
            ready: isPodReady(pod),
          })),
        };
      }),
    };
  }

  async function safeDiagnostic<Result>(operation: () => Promise<Result>) {
    try {
      return await operation();
    } catch (error) {
      return {
        unavailable: true,
        reason: error instanceof Error ? error.name : "Error",
      };
    }
  }

  async function tenantPods() {
    const pods = await resources("pods", tenantNamespace);
    assert.ok(Check(Type.Array(podSchema), pods), "kubectl must return the tenant Pod list");
    return pods;
  }

  function isPodReady(pod: TenantPod) {
    return pod.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    );
  }

  function gatewayPodPrefix(agent: AgentSelection) {
    return `gateway-${hash(agent.id)}`;
  }

  async function gatewayPods(agent: AgentSelection) {
    const prefix = gatewayPodPrefix(agent);
    return (await tenantPods()).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        pod.metadata.deletionTimestamp === undefined &&
        pod.metadata.name?.startsWith(prefix),
    );
  }

  async function waitForSameGatewayPodReady(
    agent: AgentSelection,
    expected: ReturnType<typeof podIdentity>,
  ) {
    return waitFor(`existing gateway Pod ${expected.podName} to become Ready`, async () => {
      const pods = await gatewayPods(agent);
      const samePod = pods.find(
        (pod) => pod.metadata.name === expected.podName && pod.metadata.uid === expected.podUid,
      );
      if (samePod !== undefined) {
        return isPodReady(samePod) ? podIdentity(samePod) : undefined;
      }
      const replacement = pods.find(
        (pod) => pod.metadata.name !== expected.podName || pod.metadata.uid !== expected.podUid,
      );
      assert.equal(
        replacement,
        undefined,
        `Codex Agent restart must not replace gateway Pod ${expected.podName}.`,
      );
      return undefined;
    });
  }

  async function gatewayPod(agent: AgentSelection) {
    const pods = await gatewayPods(agent);
    assert.ok(pods.length > 0, "the exact Agent must have running workload Pods to inspect.");
    const pod = pods.find(isPodReady);
    assert.ok(pod, `the exact Agent gateway Pod ${gatewayPodPrefix(agent)} must be running.`);
    return pod;
  }

  function podIdentity(pod: TenantPod) {
    return {
      podName: pod.metadata.name,
      podUid: pod.metadata.uid,
      revisionId: pod.metadata.labels?.["openclaw.dev/revision"],
      role: pod.metadata.labels?.["openclaw.dev/workload-role"] ?? "gateway",
    };
  }

  async function gatewayPodIdentity(agent: AgentSelection) {
    const pod = await gatewayPod(agent);
    return podIdentity(pod);
  }

  async function activeReadyCodexAgentPods(agent: AgentSelection, activeRevisionId: string) {
    return (await tenantPods()).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        pod.metadata.labels?.["openclaw.dev/revision"] === activeRevisionId &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
        pod.metadata.deletionTimestamp === undefined &&
        isPodReady(pod),
    );
  }

  async function activeCodexAgentPod(agent: AgentSelection, activeRevisionId: string) {
    const pods = await activeReadyCodexAgentPods(agent, activeRevisionId);
    const [pod] = pods;
    assert.ok(
      pod !== undefined && pods.length === 1,
      "native inspection requires the exact active Ready Codex Pod.",
    );
    return pod;
  }

  async function restartActiveCodexAgentPod(agent: AgentSelection) {
    assert.equal(
      pluginDriverId,
      "codex-plugin",
      "Agent-only restart proof requires a dedicated Codex Agent workload.",
    );
    const current = await agentApi.getAgent(agent.id);
    assert.ok(current.activeRevisionId, "the exact Agent must have an active revision to restart.");
    const activeRevisionId = current.activeRevisionId;
    const gatewayBefore = await gatewayPodIdentity(agent);
    const agentBefore = podIdentity(await activeCodexAgentPod(agent, activeRevisionId));
    await kubectl(
      "delete",
      "pod",
      agentBefore.podName,
      "--namespace",
      tenantNamespace,
      "--wait=false",
    );
    const agentAfter = await waitFor(
      `active revision ${activeRevisionId} Codex Agent Pod restart`,
      async () => {
        const pods = await activeReadyCodexAgentPods(agent, activeRevisionId);
        const [pod] = pods;
        if (pod === undefined || pods.length !== 1) {
          return undefined;
        }
        const candidate = podIdentity(pod);
        return candidate.podUid === agentBefore.podUid ? undefined : candidate;
      },
    );
    const gatewayAfter = await waitForSameGatewayPodReady(agent, gatewayBefore);
    assert.deepEqual(
      gatewayAfter,
      gatewayBefore,
      "Codex Agent restart must leave the existing gateway Pod serving the revision.",
    );
    return {
      revisionId: activeRevisionId,
      agentBefore,
      agentAfter,
      gatewayBefore,
      gatewayAfter,
    };
  }

  const nativeAssertions = createNativePluginAssertions({
    proofMode: pluginDriverId === "codex-plugin" ? "codex" : "openclaw",
    waitFor,
    execCodex: async (agent, argv) => {
      assert.ok(agent.id, "native inspection requires an Agent ID");
      const current = await agentApi.getAgent(agent.id);
      assert.ok(current.activeRevisionId, "native inspection requires an active revision");
      const pod = await activeCodexAgentPod({ id: agent.id }, current.activeRevisionId);
      return {
        label: pod.metadata.name,
        stdout: await kubectl(
          "exec",
          pod.metadata.name,
          "--namespace",
          tenantNamespace,
          "--container",
          "agent",
          "--",
          ...argv,
        ),
      };
    },
    gatewayUrl: async (agent) => {
      assert.ok(agent.id, "Gateway forwarding requires an Agent ID");
      const forwarding = await startPortForward(tenantNamespace, `gateway-${hash(agent.id)}`);
      forwarders.push(forwarding);
      return { url: forwarding.url };
    },
    execGateway: async (agent, argv) => {
      assert.ok(agent.id, "Gateway inspection requires an Agent ID");
      const pod = await gatewayPod({ id: agent.id });
      return {
        label: pod.metadata.name,
        stdout: await kubectl(
          "exec",
          pod.metadata.name,
          "--namespace",
          pod.metadata.namespace,
          "--",
          ...argv,
        ),
      };
    },
  });

  async function bindOpenAIModelSecret(agentId: string) {
    const key = requiredPluginProofEnv("OPENAI_API_KEY", "OpenClaw embedded model credential");
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: `Plugin model key ${agentId}`,
      value: key,
    });
    const selectedSecret = responseData(secret, 201, SecretResponse);
    const agent = await agentApi.getAgent(agentId);
    const bound = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      configurationId: agent.configurationId,
      harnessAuth: { method: "api_key", source: selectedSecret.ref },
    });
    const boundAgent = responseData(bound, 200, AgentResponse);
    await grantAgentSecretOperate(proofPool, boundAgent, selectedSecret.id);
    assertNoSecretMaterial(
      [secret, bound],
      [key],
      "Harness binding responses must not expose the API key.",
    );
    return key;
  }

  return {
    namespaceId,
    tenantNamespace,
    request,
    events,
    pool: proofPool,
    kubectl,
    resource,
    waitFor,
    createAgent: agentApi.createAgent,
    createCodexServiceAccountFromToken,
    selectPlugin: agentApi.selectPlugin,
    updatePluginPolicy: agentApi.updatePluginPolicy,
    removePluginSelection: agentApi.removePluginSelection,
    getAgent: agentApi.getAgent,
    deployAndWait,
    getDeploymentStatus,
    gatewayPodIdentity,
    restartActiveCodexAgentPod,
    normalGatewayTurn: nativeAssertions.normalGatewayTurn,
    assertSessionToolCallEvidence: nativeAssertions.assertSessionToolCallEvidence,
    assertSessionToolDeniedEvidence: nativeAssertions.assertSessionToolDeniedEvidence,
    assertNoSessionToolCallEvidence: nativeAssertions.assertNoSessionToolCallEvidence,
    readOpenClawPluginPolicy: nativeAssertions.readOpenClawPluginPolicy,
    listCodexNativeCatalog: nativeAssertions.listCodexNativeCatalog,
    codexNativePluginDetail: nativeAssertions.codexNativePluginDetail,
    codexPluginToolInventory: nativeAssertions.codexPluginToolInventory,
    codexAppConfiguration: nativeAssertions.codexAppConfiguration,
    codexEffectivePluginConfiguration: nativeAssertions.codexEffectivePluginConfiguration,
    writeWorkspaceSentinel: nativeAssertions.writeWorkspaceSentinel,
    readWorkspaceSentinel: nativeAssertions.readWorkspaceSentinel,
    bindOpenAIModelSecret,
  };
}

export async function readCodexServiceAccountCredential(): Promise<CodexCredential> {
  const accessToken = requiredPluginProofEnv(
    "CODEX_ACCESS_TOKEN",
    "Codex service-account access token",
  );
  const workspaceId = await deriveCodexWorkspaceId(accessToken);
  return { accessToken, workspaceId };
}
