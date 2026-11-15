import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
  startWorkspaceGatewayHostRelay,
} from "./envoy-workspace-gateway.mjs";
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
} from "./plugin-driver-proof-inputs.ts";

const authSecret = "plugin-driver-real-auth-secret-32-bytes";
const authBaseURL = "https://console.oce.localhost";
const proofPrefix = "occ-plugin-01a08228";

function nativeConfiguration(harnessId) {
  const configuration = createHarnessConfiguration(harnessId, optionalPluginProofModel());
  if (harnessId === "codex") {
    configuration.tools = {
      fs: { workspaceOnly: true },
    };
  }
  return configuration;
}

function createServiceKeyControllerRequest(app, serviceKey) {
  assert.equal(typeof serviceKey, "string", "a bootstrap service API key is required");
  assert.ok(serviceKey.length > 0, "a bootstrap service API key is required");
  return async (method, url, payload) => {
    const response = await app.inject({
      method,
      url,
      headers: { "x-api-key": serviceKey, host: "127.0.0.1" },
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      ...(response.body.length === 0 ? {} : response.json()),
    };
  };
}

async function bootstrapServiceKeyFromFile(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    typeof parsed.data?.key,
    "string",
    "bootstrap service-key file must contain data.key",
  );
  assert.ok(parsed.data.key.length > 0, "bootstrap service-key file must contain data.key");
  return parsed.data.key;
}

function installationAdministratorServicePrincipal(iamState) {
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
  assert.ok(principal, "existing proof Installation must have a bootstrap service Principal");
  return principal;
}

function createAgentPluginApi({ request, namespaceId, gatewayAuth }) {
  async function createAgent({ harnessId, executionMode, name, harnessAuth, backendId }) {
    const values = nativeConfiguration(harnessId);
    if (gatewayAuth !== undefined) {
      values.gateway = {
        ...values.gateway,
        ...gatewayAuth,
        auth: { ...gatewayAuth.auth, password: values.gateway.auth.password },
      };
    }
    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values,
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name,
      configurationId: configuration.data.id,
      executionMode,
      ...(backendId === undefined ? {} : { backendId }),
      ...(harnessAuth === undefined ? {} : { harnessAuth }),
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.error));
    return agent.data;
  }

  async function getAgent(agentId) {
    const response = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
    assert.equal(response.status, 200, JSON.stringify(response.error));
    return response.data;
  }

  async function replaceAgentPlugins(agentId, plugins) {
    const current = await getAgent(agentId);
    const response = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      configurationId: current.configurationId,
      executionMode: current.executionMode,
      ...(current.backendId === undefined ? {} : { backendId: current.backendId }),
      plugins,
    });
    assert.equal(response.status, 200, JSON.stringify(response.error));
    return response.data.plugins ?? {};
  }

  function installPolicy(payload) {
    const { pluginId: _pluginId, ...policy } = payload;
    return { enabled: true, ...policy };
  }

  async function selectPlugin(agentId, payload) {
    const current = await getAgent(agentId);
    const plugins = {
      ...(current.plugins ?? {}),
      [payload.pluginId]: installPolicy(payload),
    };
    const updated = await replaceAgentPlugins(agentId, plugins);
    return updated[payload.pluginId];
  }

  async function updatePluginPolicy(agentId, pluginId, payload) {
    const current = await getAgent(agentId);
    assert.ok(current.plugins?.[pluginId], `Plugin ${pluginId} must already be selected.`);
    const nextPolicy = { ...current.plugins[pluginId], ...payload };
    for (const [key, value] of Object.entries(nextPolicy)) {
      if (value === null || value === undefined) {
        delete nextPolicy[key];
      }
    }
    const updated = await replaceAgentPlugins(agentId, {
      ...current.plugins,
      [pluginId]: nextPolicy,
    });
    return updated[pluginId];
  }

  async function removePluginSelection(agentId, pluginId) {
    const current = await getAgent(agentId);
    const plugins = { ...(current.plugins ?? {}) };
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
}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: `k3d-${proofPrefix}`,
    codexSeccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
  });
  if (pluginDriverId === "codex-plugin") {
    configuration.drivers.compute.configuration.resources.gateway.limits.memory =
      productionGatewayMemoryLimit;
    configuration.drivers.compute.configuration.resources.agent.limits.memory = "2Gi";
  }
  configuration.drivers.secret.configuration.authentication = authentication;
  configuration.drivers.configuration.id = "configuration-kubernetes-plugin-real";
  configuration.drivers.compute.id = "compute-kubernetes-plugin-real";
  configuration.drivers.plugin = [{ id: pluginDriverId, configuration: pluginDriverConfiguration }];
  if (workspaceGateway !== undefined) {
    configuration.drivers.compute.configuration.gatewayRouting = workspaceGateway.routing;
    configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs =
      workspaceGateway.nativeOptions.gatewayAuth.trustedProxies;
    delete configuration.drivers.compute.configuration.network.gatewayClients;
  }
  configuration.drivers.compute.configuration.network.pluginStatusProxySourceCidrs =
    pluginProofPluginStatusProxyCidrs();
  if (codexServiceAccountImport !== undefined) {
    configuration.backend = [
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
    ];
    configuration.drivers.service_account = {
      id: "chatgpt-service-accounts",
      configuration: {},
    };
  }
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "8",
    "requests.cpu": "2",
    "requests.memory": "2Gi",
    // Two Agent/gateway pairs plus an overlapping revision during cutover.
    "limits.cpu": "12",
    "limits.memory": pluginDriverId === "codex-plugin" ? "12Gi" : "6Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 3_600;
  return configuration;
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

async function codexServiceAccountImportConfiguration(directory, credential) {
  const imported = credential ?? (await readCodexServiceAccountCredential());
  const apiKeyPath = join(directory, "codex-service-account-import-provider-marker");
  await writeFile(apiKeyPath, "test-only-existing-codex-service-account-import\n", {
    mode: 0o600,
  });
  return { ...imported, apiKeyPath };
}

async function deriveCodexWorkspaceId(accessToken) {
  const response = await fetch(
    "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(response.status, 200, "the Codex service-account token must authenticate.");
  const body = await response.json();
  const accountId = body?.chatgpt_account_id;
  assert.equal(typeof accountId, "string", "whoami must return a ChatGPT account identity.");
  assert.match(accountId, /^[0-9a-f-]{36}$/i, "the ChatGPT account identity must be a UUID.");
  return accountId;
}

function createImportedCodexServiceAccountDriverFactory(imported, compute) {
  const driverId = "chatgpt-service-accounts";
  const backendId = "openai";
  return (controller, state) => {
    const driver = {
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
          workspaceId: imported.workspaceId,
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

async function waitForPluginProofWorkerSuccess(waitFor, events, revisionId, options) {
  const description = typeof options === "string" ? options : options.description;
  try {
    await waitFor(description, () =>
      events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === revisionId &&
          event.outcome === "success" &&
          ["REVISION_ACTIVATED", "REVISION_ALREADY_ACTIVE"].includes(event.code),
      ),
    );
  } catch (error) {
    const diagnostics = typeof options === "string" ? [] : options.diagnostics();
    throw new Error(`${error.message} Worker events: ${JSON.stringify(diagnostics)}`);
  }
}

function sanitizedPluginProofWorkerEvents(events, revisionId) {
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

/**
 * @param {{ after: (cleanup: () => Promise<void>) => void }} context
 * @param {import("./plugin-driver-proof-inputs.ts").PluginProofInputOptions & {
 *   codexCredential?: Awaited<ReturnType<typeof readCodexServiceAccountCredential>>,
 *   pluginDriverConfiguration?: Record<string, unknown>,
 * }} options
 */
export async function createPluginDriverRealFixture(
  context,
  { scenario, pluginDriverId, databaseUrl, codexCredential, pluginDriverConfiguration = {} },
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

  await validatePrerequisites();
  let worker;
  let app;
  let pool;
  const forwarders = [];
  const gatewayPasswords = new Map();
  let tenantNamespace;
  let gatewayRuntimeNamespace;
  let gatewayPlacement;

  function isKubernetesNotFound(error) {
    return /NotFound|not found/i.test(`${error?.stderr ?? ""}\n${error?.message ?? ""}`);
  }

  async function waitForTenantNamespaceDeletion() {
    if (tenantNamespace === undefined) {
      return;
    }
    try {
      await kubectl("wait", "--for=delete", `namespace/${tenantNamespace}`, "--timeout=60s");
    } catch (error) {
      if (isKubernetesNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "occ-plugin-driver-real-"));
  context.after(async () => {
    const failures = [];
    async function cleanup(operation) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const forwarder of forwarders.splice(0)) {
      forwarder.stop();
    }
    if (worker !== undefined) {
      await cleanup(() => worker.stop());
    }
    if (app !== undefined) {
      await cleanup(() => app.close());
    }
    if (pool !== undefined) {
      await cleanup(() => pool.end());
    }
    if (gatewayRuntimeNamespace !== undefined && gatewayRuntimeNamespace !== tenantNamespace) {
      await cleanup(() =>
        kubectl(
          "delete",
          "namespace",
          gatewayRuntimeNamespace,
          "--ignore-not-found=true",
          "--wait=true",
        ),
      );
    }
    if (tenantNamespace !== undefined) {
      await cleanup(() =>
        kubectl("delete", "namespace", tenantNamespace, "--ignore-not-found=true", "--wait=false"),
      );
      await cleanup(() => waitForTenantNamespaceDeletion());
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
  let workspaceGateway;
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
    workspaceGateway = await createEnvoyWorkspaceGatewayPlan(
      context,
      { platformNamespace },
      helpers,
    );
    workspaceGateway.routing.endpointPort = await startWorkspaceGatewayHostRelay(
      context,
      workspaceGateway,
      { ...helpers, gatewayImage },
    );
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

  const kubeconfig = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const [api, workerIdentity] = await Promise.all(
    ["api", "worker"].map((role) =>
      createControllerIdentity({
        directory,
        platformNamespace,
        kubeconfig,
        account: `${proofPrefix}-${role}`,
        clusterRole: `${proofPrefix}-namespaces-${suffix}`,
        clusterRoleBinding: `${proofPrefix}-${role}-${suffix}`,
        context: `${proofPrefix}-${role}-${suffix}`,
      }),
    ),
  );

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

  const driverEnvironment = {};
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
    { kubernetesNamespaceName },
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
  assert.equal(apiDrivers.pluginDrivers[0]?.id, pluginDriverId);
  assert.equal(workerDrivers.pluginDrivers[0]?.id, pluginDriverId);

  const serviceAccountDriverFactory =
    codexServiceAccountImport === undefined
      ? undefined
      : createImportedCodexServiceAccountDriverFactory(
          codexServiceAccountImport,
          apiDrivers.computeDriver,
        );

  pool = new pg.Pool({ connectionString: selectedDatabaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const existing = await state.loadInstallation();
  let serviceKey;
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
      pool,
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
    serviceKey = await bootstrapServiceKeyFromFile(
      bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    );
  }

  app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl: selectedDatabaseUrl,
    authSecret,
    authBaseURL,
    nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    drivers: apiDrivers,
    ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
  });
  const request = createServiceKeyControllerRequest(app, serviceKey);
  const events = [];
  worker = createControllerWorker({
    mode: "production",
    pool: new pg.Pool({ connectionString: selectedDatabaseUrl, max: 6 }),
    drivers: workerDrivers,
    pollIntervalMs: 50,
    leaseDurationMs: 60_000,
    maxAttempts: 30,
    emit: (event) => events.push(event),
  });
  await worker.start();

  const createdNamespace = await request("POST", "/namespaces", {
    name: `${proofPrefix}-${suffix}`,
  });
  assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
  tenantNamespace = kubernetesNamespaceName(createdNamespace.data.id);
  gatewayRuntimeNamespace = kubernetesNamespaceName(createdNamespace.data.id);
  gatewayPlacement = pluginDriverId === "codex-plugin" ? gatewayRuntimeNamespace : tenantNamespace;
  await waitFor(`the worker to create ${tenantNamespace}`, async () => {
    try {
      return await resource("namespace", tenantNamespace);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
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
  await waitFor(`namespace ${createdNamespace.data.id} to become API-ready`, async () => {
    const observed = await request("GET", `/namespaces/${createdNamespace.data.id}`);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    return observed.data.status === "ready" ? observed.data : undefined;
  });

  const agentApi = createAgentPluginApi({
    request,
    namespaceId: createdNamespace.data.id,
    gatewayAuth: workspaceGateway?.nativeOptions.gatewayAuth,
  });

  async function createCodexServiceAccountFromToken({ accessToken, name }) {
    assert.ok(
      serviceAccountDriverFactory,
      "Codex ServiceAccounts require the configured test import ServiceAccount Driver.",
    );
    assert.ok(
      accessToken === codexServiceAccountImport.accessToken,
      "Codex ServiceAccount import must use the configured existing test credential.",
    );
    const account = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/service-accounts`,
      { name },
    );
    assert.equal(account.status, 201, JSON.stringify(account.error));
    const binding = await pool.query(
      `SELECT external_account_id, workspace_id, backend_id, driver_id
       FROM occ.service_account_driver_bindings
       WHERE namespace_id = $1 AND service_account_id = $2`,
      [createdNamespace.data.id, account.data.id],
    );
    assert.equal(binding.rowCount, 1, "ServiceAccount creation must persist provider binding.");
    assert.equal(binding.rows[0].external_account_id, `imported-${account.data.id}`);
    assert.equal(binding.rows[0].workspace_id, codexServiceAccountImport.workspaceId);
    assert.equal(binding.rows[0].backend_id, "openai");
    assert.equal(binding.rows[0].driver_id, "chatgpt-service-accounts");

    const issued = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/service-accounts/${account.data.id}/credentials`,
      {},
    );
    assert.equal(issued.status, 201, JSON.stringify(issued.error));
    assert.equal(issued.data.credential.kind, "access_token");
    assertNoSecretMaterial(
      issued,
      [accessToken, codexServiceAccountImport.workspaceId],
      "service-account responses must not expose imported credential values.",
    );
    return issued.data;
  }

  async function deployAndWait(agent) {
    let gatewayPassword = gatewayPasswords.get(agent.id);
    if (gatewayPassword === undefined) {
      gatewayPassword = await provisionAgentTransportSecret(directory, tenantNamespace, agent.id, {
        executionMode: agent.executionMode,
      });
      gatewayPasswords.set(agent.id, gatewayPassword);
    }
    const deployed = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/agents/${agent.id}/deploy`,
    );
    assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
    try {
      await waitFor(`revision ${deployed.data.id} activation`, async () => {
        const observed = await request(
          "GET",
          `/namespaces/${createdNamespace.data.id}/agents/${agent.id}`,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.error));
        const deployment = await getDeploymentStatus(agent.id, deployed.data.id);
        assert.notEqual(deployment.status, "failed", JSON.stringify(deployment.error));
        return observed.data.activeRevisionId === deployed.data.id ? observed.data : undefined;
      });
    } catch (error) {
      const diagnostics = await deploymentActivationDiagnostics(agent, deployed.data.id, events);
      assert.fail(`${error.message} Diagnostics: ${JSON.stringify(diagnostics)}`);
    }
    await waitForPluginProofWorkerSuccess(waitFor, events, deployed.data.id, {
      description: `worker completion of ${deployed.data.id}`,
      diagnostics: () => sanitizedPluginProofWorkerEvents(events, deployed.data.id),
    });
    const status = await getDeploymentStatus(agent.id, deployed.data.id);
    assert.equal(status.status, "succeeded", JSON.stringify(status.error));
    return { revision: deployed.data, gatewayPassword, status };
  }

  async function getDeploymentStatus(agentId, deploymentId) {
    const status = await request(
      "GET",
      `/namespaces/${createdNamespace.data.id}/agents/${agentId}/deployments/${deploymentId}`,
    );
    assert.equal(status.status, 200, JSON.stringify(status.error));
    return status.data;
  }

  async function deploymentActivationDiagnostics(agent, revisionId, workerEvents) {
    return {
      revisionId,
      agentId: agent.id,
      namespaceId: createdNamespace.data.id,
      agent: await safeDiagnostic(async () => {
        const observed = await request(
          "GET",
          `/namespaces/${createdNamespace.data.id}/agents/${agent.id}`,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.error));
        return {
          activeRevisionId: observed.data.activeRevisionId ?? null,
          desiredRuntimeState: observed.data.desiredRuntimeState ?? null,
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
        const { rows } = await pool.query(
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
        const row = rows[0];
        return {
          state: row.state,
          reasonCode: row.reason_code,
          warnings: row.result_data?.warnings ?? [],
          attemptCount: row.attempt_count,
          availableAt: row.available_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          completedAt: row.completed_at,
        };
      }),
      workerEvents: sanitizedPluginProofWorkerEvents(workerEvents, revisionId),
      runtime: await safeDiagnostic(async () => {
        const pods = (await resources("pods", gatewayPlacement)).filter(
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
              gatewayPlacement,
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

  async function safeDiagnostic(operation) {
    try {
      return await operation();
    } catch (error) {
      return {
        unavailable: true,
        reason: error?.name ?? "Error",
      };
    }
  }

  function isPodReady(pod) {
    return pod.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    );
  }

  function gatewayPodPrefix(agent) {
    return `gateway-${hash(agent.id)}`;
  }

  async function gatewayPods(agent) {
    const prefix = gatewayPodPrefix(agent);
    return (await resources("pods", gatewayPlacement)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        pod.metadata.deletionTimestamp === undefined &&
        pod.metadata.name?.startsWith(prefix),
    );
  }

  async function waitForSameGatewayPodReady(agent, expected) {
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

  async function gatewayPod(agent) {
    const pods = await gatewayPods(agent);
    assert.ok(pods.length > 0, "the exact Agent must have running workload Pods to inspect.");
    const pod = pods.find(isPodReady);
    assert.ok(pod, `the exact Agent gateway Pod ${gatewayPodPrefix(agent)} must be running.`);
    return pod;
  }

  function podIdentity(pod) {
    return {
      podName: pod.metadata.name,
      podUid: pod.metadata.uid,
      revisionId: pod.metadata.labels?.["openclaw.dev/revision"],
      role: pod.metadata.labels?.["openclaw.dev/workload-role"] ?? "gateway",
    };
  }

  async function gatewayPodIdentity(agent) {
    const pod = await gatewayPod(agent);
    return podIdentity(pod);
  }

  async function activeReadyCodexAgentPods(agent, activeRevisionId) {
    return (await resources("pods", tenantNamespace)).filter(
      (pod) =>
        pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        pod.metadata.labels?.["openclaw.dev/revision"] === activeRevisionId &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
        pod.metadata.deletionTimestamp === undefined &&
        pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
  }

  async function activeCodexAgentPod(agent, activeRevisionId) {
    const pods = await activeReadyCodexAgentPods(agent, activeRevisionId);
    assert.equal(pods.length, 1, "native inspection requires the exact active Ready Codex Pod.");
    return pods[0];
  }

  async function restartActiveCodexAgentPod(agent) {
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
        if (pods.length !== 1) {
          return undefined;
        }
        const candidate = podIdentity(pods[0]);
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
      const current = await agentApi.getAgent(agent.id);
      const pods = (await resources("pods", tenantNamespace)).filter(
        (pod) =>
          pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
          pod.metadata.labels?.["openclaw.dev/revision"] === current.activeRevisionId &&
          pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
          pod.metadata.deletionTimestamp === undefined &&
          pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
      );
      assert.equal(pods.length, 1, "native inspection requires the exact active Ready Codex Pod.");
      return {
        label: pods[0].metadata.name,
        stdout: await kubectl(
          "exec",
          pods[0].metadata.name,
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
      const forwarding = await startPortForward(gatewayPlacement, `gateway-${hash(agent.id)}`);
      forwarders.push(forwarding);
      return { url: forwarding.url };
    },
    execGateway: async (agent, argv) => {
      const pod = await gatewayPod(agent);
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

  async function bindOpenAIModelSecret(agentId) {
    const key = requiredPluginProofEnv("OPENAI_API_KEY", "OpenClaw embedded model credential");
    const secret = await request("POST", `/namespaces/${createdNamespace.data.id}/secrets`, {
      name: `Plugin model key ${agentId}`,
      value: key,
    });
    assert.equal(secret.status, 201, JSON.stringify(secret.error));
    const agent = await agentApi.getAgent(agentId);
    const bound = await request(
      "PATCH",
      `/namespaces/${createdNamespace.data.id}/agents/${agentId}`,
      {
        configurationId: agent.configurationId,
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
    );
    assert.equal(bound.status, 200, JSON.stringify(bound.error));
    await grantAgentSecretOperate(pool, bound.data, secret.data.id);
    assertNoSecretMaterial(
      [secret, bound],
      [key],
      "Harness binding responses must not expose the API key.",
    );
    return key;
  }

  return {
    namespaceId: createdNamespace.data.id,
    tenantNamespace,
    request,
    events,
    pool,
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

export async function readCodexServiceAccountCredential() {
  const accessToken = requiredPluginProofEnv(
    "CODEX_ACCESS_TOKEN",
    "Codex service-account access token",
  );
  const workspaceId = await deriveCodexWorkspaceId(accessToken);
  return { accessToken, workspaceId };
}
