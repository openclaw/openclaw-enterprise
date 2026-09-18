import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  openShellAgentName,
  openShellGatewayName,
  openshellHash as hash,
} from "../helpers/openshell-kubernetes-real.mjs";
import {
  assertGatewayModelTurn,
  configureExistingK3dLocalPathSharedFileSystem,
} from "../helpers/kubernetes-real.mjs";

const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? runtimeImage;
const codexImage =
  process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
  process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
  runtimeImage;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const openShellCliPath = process.env.OCC_TEST_OPENSHELL_CLI;
const openShellGatewayImage = process.env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE;
const openShellSupervisorImage = process.env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE;
const openShellHelmPath = process.env.OCC_TEST_OPENSHELL_HELM;
const openShellHelmChart = process.env.OCC_TEST_OPENSHELL_HELM_CHART;
const openShellChartVersion = process.env.OCC_TEST_OPENSHELL_CHART_VERSION ?? "0.0.113";
const openShellRuntimeClass = process.env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox";
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.6-sol").replace(
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
    openShellCliPath,
    openShellGatewayImage,
    openShellSupervisorImage,
    openShellHelmPath,
    openShellHelmChart,
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
const diagnosticQueryTimeoutMs = 3_000;
const observerPoolConnectionTimeoutMs = 5_000;

const fixture = createOpenShellKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
  openShellCliPath,
  openShellGatewayImage,
  openShellSupervisorImage,
  openShellRuntimeClass,
  openShellHelmPath,
  openShellHelmChart,
  openShellChartVersion,
});
const {
  kubectl,
  resource,
  resources,
  createControllerIdentity,
  waitFor,
  validateOpenShellPrerequisites,
  provisionAgentTransportCredentials,
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

function nativeCodexConfiguration() {
  const configuration = createHarnessConfiguration("codex", providerModel);
  configuration.tools = {
    allow: ["read", "write", "edit", "exec"],
    fs: { workspaceOnly: true },
  };
  return configuration;
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

function throwOpenShellAbortReason(signal) {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason ?? new Error("OpenShell management port-forward operation was aborted.");
}

function createIntegrationSandboxDriverFactory(OpenShellSandboxDriver) {
  const gatewayState = new Map();
  const provisioningFailures = new Map();

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
    function optionsFor(requirements, namespaceName, endpoint) {
      const options = structuredClone(selection.configuration);
      options.gateway.endpoint = endpoint;
      options.gateway.readiness = {
        ...options.gateway.readiness,
        serviceName: `openshell-${hash(namespaceName, 10)}`,
      };
      if (requirements !== undefined) {
        const claimName = requirements.workspaceMounts[0]?.claimName;
        assert.ok(claimName, "OpenShell requires the Agent shared workspace PVC.");
        options.kubernetes.sandboxDataMount = {
          claimName,
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        };
      }
      return options;
    }

    function delegate(requirements, namespaceName, endpoint) {
      return new OpenShellSandboxDriver(optionsFor(requirements, namespaceName, endpoint), {
        id: selection.id,
        implementation: "openshell",
      });
    }

    return {
      id: selection.id,
      capability: "sandbox",
      implementation: selection.implementation,
      facets: Object.freeze(["networking", "filesystem", "process"]),
      configureAgent(configuration) {
        return new OpenShellSandboxDriver(selection.configuration, {
          id: selection.id,
          implementation: "openshell",
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
        const endpoint = await endpointForNamespace(context, {
          sandboxServiceAccountName: context.requirements.serviceAccountName,
        });
        try {
          // Hand the real Driver exactly what Compute rendered. No credential files,
          // replacement startup commands, or operator-patched provider Pods are permitted.
          return await delegate(
            context.requirements,
            context.namespace.name,
            endpoint,
          ).provisionHarness(context);
        } catch (error) {
          provisioningFailures.set(context.revision.id, error);
          throw error;
        }
      },
      async cleanup(context) {
        if (context.revision === undefined) {
          await stopGatewayForward(context.namespace.name);
          return;
        }
        const endpoint = existingEndpointForNamespace(context);
        await delegate(undefined, context.namespace.name, endpoint).cleanup(context);
      },
    };
  };
  createDriver.disposeGatewayForwards = disposeGatewayForwards;
  createDriver.provisioningFailures = provisioningFailures;
  return createDriver;
}

async function prepareProductionInstallation(
  context,
  { expectUnsupportedProjection = false } = {},
) {
  const kubeconfig = await validateOpenShellPrerequisites();
  await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
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
  ] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
    import("../../apps/controller/src/drivers/sandbox/openshell.ts"),
  ]);

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
  configuration.drivers.secret.configuration.authentication = controller.authentication;
  const workerStartupPath = join(directory, "worker-installation.json");
  await writeFile(workerStartupPath, JSON.stringify(configuration), { mode: 0o600 });
  const apiConfiguration = structuredClone(configuration);
  apiConfiguration.drivers.secret.configuration.authentication =
    controller.apiIdentity.authentication;
  await writeFile(startupPath, JSON.stringify(apiConfiguration), { mode: 0o600 });
  const createSandboxDriver = createIntegrationSandboxDriverFactory(OpenShellSandboxDriver);
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: startupPath },
    createSandboxDriver,
  });
  const workerDrivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: workerStartupPath },
    createSandboxDriver,
  });
  assert.equal(drivers.sandboxDriver?.capability, "sandbox");
  assert.equal(drivers.sandboxDriver?.id, configuration.drivers.sandbox.id);

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
  let gatewayForward;
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
    await cleanupStep("OpenShell gateway port-forward", async () => {
      await gatewayForward?.stop();
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
  const request = await createAuthenticatedControllerRequest(productionApp, adminCredentials);
  const events = [];
  workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  worker = createControllerWorker({
    mode: "production",
    pool: workerPool,
    drivers: workerDrivers,
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
  await kubectl(
    "create",
    "rolebinding",
    "openshell-secret-api",
    "--namespace",
    placement,
    `--clusterrole=${controller.apiSecretRole}`,
    `--serviceaccount=${platformNamespace}:${controller.apiIdentity.account}`,
  );
  const modelSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name: `openshell-model-${randomUUID()}`,
    value: process.env.OPENAI_API_KEY,
  });
  assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.error));
  assert.equal(JSON.stringify(modelSecret).includes(process.env.OPENAI_API_KEY), false);

  const agentConfiguration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: nativeCodexConfiguration(),
  });
  assert.equal(agentConfiguration.status, 201, JSON.stringify(agentConfiguration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `openshell-${randomUUID()}`,
    configurationId: agentConfiguration.data.id,
    executionMode: "dedicated",
    harnessAuth: { method: "api_key", source: modelSecret.data.ref },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));

  const transport = await provisionAgentTransportCredentials(directory, placement, agent.data.id);
  const {
    rows: [principal],
  } = await observerPool.query(
    "SELECT service_principal_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
    [namespaceId, agent.data.id],
  );
  const roleId = `openshell-secret-operate-${randomUUID()}`;
  await observerPool.query(
    "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
    [
      roleId,
      namespaceId,
      "Exact model Secret operate",
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );
  await observerPool.query(
    `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, $4, 'secret', $5)`,
    [randomUUID(), namespaceId, principal.service_principal_id, roleId, modelSecret.data.id],
  );
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
    assert.match(
      failure.message,
      /cannot receive secretKeyRef.*upstream Secret projection support is required/,
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
    for (const pod of await resources("pods", placement)) {
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
    return { request, namespaceId, agent: agent.data, observerPool };
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
  assertWorkspaceMounts(harnessPod);
  await assertServicePrincipalTokenProjection(
    placement,
    harnessPod,
    configuration.drivers.compute.configuration.servicePrincipalCredentials,
  );
  assertApprovedOpenShellPrivileges(harnessPod);
  process.stderr.write(
    "OpenShell integration: approved mounts and privileges verified; checking secret exposure.\n",
  );
  await assertNoSecretBytes(placement, [process.env.OPENAI_API_KEY, transport.appServerToken]);
  process.stderr.write(
    "OpenShell integration: secret exposure checks passed; verifying gateway routing.\n",
  );

  const gatewayServiceName = openShellGatewayName(agent.data.id);
  const agentServiceName = openShellAgentName(agent.data.id);
  const gatewayPods = (await resources("pods", placement)).filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id,
  );
  assert.equal(gatewayPods.length, 1, "the Compute-owned Agent gateway must still be separate.");
  const gatewayPod = gatewayPods[0];
  const agentService = await resource("service", agentServiceName, placement);
  assert.deepEqual(agentService.spec.selector, {
    "openclaw.dev/agent": agent.data.id,
    "openclaw.dev/revision": deployed.data.id,
    "openclaw.dev/workload-role": "agent",
  });
  gatewayForward = await startGatewayPortForward(placement, gatewayServiceName);

  return {
    request,
    events,
    placement,
    namespaceId,
    agent: agent.data,
    revision: deployed.data,
    gatewayPod,
    harnessPod,
    sandbox,
    gatewayToken: transport.gatewayToken,
    gatewayUrl: gatewayForward.url,
    observerPool,
  };
}

async function assertOpenShellToolFilesystemAndNetworkEnforcement(topology) {
  const nonce = `openshell-boundary-${randomUUID()}`;
  const writablePath = `/home/node/workspace/${nonce}.txt`;
  const approvedPath = "/home/node/openclaw-runtime-assets/bundled-skills";
  const readonlyPath = `${approvedPath}/${nonce}.txt`;
  const escapedPath = `/home/node/workspace/../${nonce}-escape.txt`;
  const result = await requestCodexTurnFromGatewayPod({
    namespace: topology.placement,
    gatewayPod: topology.gatewayPod.metadata.name,
    providerModel,
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
  await assertWorkerCompleted({
    description: `replacement revision ${redeployed.data.id} finalization`,
    events: topology.events,
    pool: topology.observerPool,
    namespaceId: topology.namespaceId,
    agentId: topology.agent.id,
    revisionId: redeployed.data.id,
  });
  // Retirement of the previous revision must leave the provider's replacement routable.
  const activeService = await resource(
    "service",
    openShellAgentName(topology.agent.id),
    topology.placement,
  );
  assert.deepEqual(activeService.spec.selector, {
    "openclaw.dev/agent": topology.agent.id,
    "openclaw.dev/revision": redeployed.data.id,
    "openclaw.dev/workload-role": "agent",
  });
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

test(
  "stock OpenShell rejects unsupported Secret projection without activating the Agent",
  { ...requiresOpenShellK3d, timeout: 900_000 },
  async (context) => {
    const topology = await prepareProductionInstallation(context, {
      expectUnsupportedProjection: true,
    });
    await assertEmbeddedOpenShellFailsClosed(topology);
  },
);

test(
  "OpenShell with genuine Secret projection executes and enforces a provider-owned Codex Harness",
  {
    skip:
      process.env.OCC_TEST_OPENSHELL_SECRET_PROJECTION === "1"
        ? requiresOpenShellK3d.skip
        : "Requires production Driver and upstream support for genuine Secret and ServicePrincipal projections; stock v0.0.113 is unsupported. Set OCC_TEST_OPENSHELL_SECRET_PROJECTION=1 only with that implementation.",
    timeout: 900_000,
  },
  async (context) => {
    const topology = await prepareProductionInstallation(context);
    assert.equal(
      topology.harnessPod.spec.serviceAccountName,
      openShellAgentName(topology.agent.id),
    );
    assert.ok(topology.sandbox.metadata.name);
    process.stderr.write(
      "OpenShell integration: starting authenticated real gateway model turn.\n",
    );
    await assertGatewayModelTurn({
      gatewayUrl: topology.gatewayUrl,
      gatewayToken: topology.gatewayToken,
      nonce: `OCC-OPENSHELL-${randomUUID()}`,
      secrets: [process.env.OPENAI_API_KEY],
    });
    process.stderr.write(
      "OpenShell integration: real gateway model turn passed; testing actual filesystem and network enforcement.\n",
    );
    await assertOpenShellToolFilesystemAndNetworkEnforcement(topology);
    process.stderr.write(
      "OpenShell integration: tool filesystem and egress verified; testing Pod-absent replacement and cleanup.\n",
    );
    await assertDuplicateReconciliationDoesNotDuplicateOpenShell(topology);
    await assertEmbeddedOpenShellFailsClosed(topology);
  },
);
