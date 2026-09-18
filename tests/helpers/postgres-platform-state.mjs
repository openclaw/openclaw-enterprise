import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { verifyPlatformStateStoreContract } from "../conformance/platform-state-store.contract.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import {
  createKubernetesInstallationConfiguration,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = fileURLToPath(new URL("../../apps/controller/src/server.mjs", import.meta.url));
const workerEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/worker.mjs", import.meta.url),
);
const execute = promisify(execFile);
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "openclaw-postgres-development-auth-secret-minimum-32-bytes";
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};
const requiresPostgresAndKubernetesConfiguration = {
  skip: !databaseUrl
    ? "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests."
    : process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1"
      ? false
      : "Set OCC_TEST_KUBERNETES_CONFIGURATION=1 to run PostgreSQL plus live Kubernetes Driver coverage.",
};
const useKubernetesDrivers = process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1";
const kubernetesStartupEnvironments = new WeakMap();
const kubernetesWorkloadResources = Object.freeze({
  requests: Object.freeze({ cpu: "25m", memory: "48Mi" }),
  limits: Object.freeze({ cpu: "250m", memory: "192Mi" }),
});
const defaultAgentConfigurationValues = Object.freeze({
  gateway: Object.freeze({ controlUi: Object.freeze({ enabled: false }) }),
  agents: Object.freeze({
    defaults: Object.freeze({
      model: "openai/gpt-fixture",
      models: Object.freeze({
        "openai/gpt-fixture": Object.freeze({ agentRuntime: Object.freeze({ id: "openclaw" }) }),
      }),
    }),
  }),
});

async function kubectl(...args) {
  const { stdout } = await execute(
    "kubectl",
    ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

async function configuredDriverEnvironment(context, kubernetesDrivers) {
  if (!kubernetesDrivers) {
    return {};
  }
  assert.equal(
    useKubernetesDrivers,
    true,
    "OCC_TEST_KUBERNETES_CONFIGURATION=1 is required for live Kubernetes Driver coverage.",
  );
  return (await createKubernetesStartupEnvironment(context)).environment;
}

async function createKubernetesStartupEnvironment(context) {
  // The API and worker share a scoped controller identity; the base kubeconfig is used only
  // to create that identity and grant per-tenant access after each Namespace exists.
  const cached = kubernetesStartupEnvironments.get(context);
  if (cached !== undefined) {
    return cached;
  }

  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
  const installationId = `ins_${randomUUID()}`;
  const identifier = kubernetesHash(installationId);
  const account = "openclaw-controller";
  const namespaceRole = `oce-postgres-namespaces-${identifier}`;
  const tenantRole = `oce-postgres-tenant-${identifier}`;
  const binding = `oce-postgres-controller-${identifier}`;
  const platformNamespace = `oce-postgres-platform-${identifier}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-postgres-kubernetes-"));
  context.after(async () => {
    const cleanup = await Promise.allSettled([
      kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true", "--wait=true"),
      kubectl("delete", "clusterrolebinding", binding, "--ignore-not-found=true"),
      kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found=true"),
      rm(directory, { recursive: true, force: true }),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason));
    }
  });

  await kubectl("create", "namespace", platformNamespace);
  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
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
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges,secrets",
  );
  await kubectl(
    "patch",
    "clusterrole",
    tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "create", "patch", "delete"],
        },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrolebinding",
    binding,
    `--clusterrole=${namespaceRole}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );

  const token = (
    await kubectl("create", "token", account, "--namespace", platformNamespace)
  ).trim();
  const current = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const scopedContext = `scoped-${identifier}`;
  const scopedKubeconfig = join(directory, "kubeconfig.json");
  await writeFile(
    scopedKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "local", cluster: current.clusters[0].cluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name: scopedContext, context: { cluster: "local", user: account } }],
      "current-context": scopedContext,
    }),
    { mode: 0o600 },
  );

  const authentication = {
    mode: "kubeconfig",
    kubeconfigPath: scopedKubeconfig,
    context: scopedContext,
  };
  const installation = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage: fixtureImage,
    codexImage: fixtureImage,
    cluster: `postgres-platform-state-${identifier}`,
  });
  installation.drivers.secret.configuration.authentication = structuredClone(authentication);
  installation.drivers.compute.configuration.images.requireImmutableDigest = false;
  installation.drivers.compute.configuration.resources.gateway = structuredClone(
    kubernetesWorkloadResources,
  );
  installation.drivers.compute.configuration.resources.agent = structuredClone(
    kubernetesWorkloadResources,
  );
  installation.drivers.compute.configuration.resources.namespace = {
    quota: {
      pods: "20",
      "requests.cpu": "1",
      "requests.memory": "1Gi",
      "limits.cpu": "4",
      "limits.memory": "3Gi",
    },
    containerDefaults: structuredClone(kubernetesWorkloadResources),
  };
  installation.drivers.compute.configuration.network.gatewayPort = 8080;
  delete installation.drivers.compute.configuration.runtime;
  const configurationPath = join(directory, "installation.yaml");
  await writeFile(configurationPath, JSON.stringify(installation), {
    encoding: "utf8",
    mode: 0o600,
  });

  const environment = { OCC_CONFIG_PATH: configurationPath };
  const startup = { environment, platformNamespace, account, tenantRole };
  kubernetesStartupEnvironments.set(context, startup);
  return startup;
}

async function waitForKubernetesNamespace(context, namespaceId) {
  const name = kubernetesNamespaceName(namespaceId);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await kubectl("get", "namespace", name, "-o", "json");
      return name;
    } catch (error) {
      if (!/NotFound|not found/i.test(error.stderr ?? error.message)) {
        throw error;
      }
      await delay(100);
    }
  }
  assert.fail(`Timed out waiting for Kubernetes Namespace ${name}.`);
}

async function grantTenantAccess(context, namespaceId) {
  // Kubernetes namespace creation succeeds before tenant resources can be reconciled;
  // this mirrors the operator-owned RoleBinding handoff required by the real driver.
  const { platformNamespace, account, tenantRole } =
    await createKubernetesStartupEnvironment(context);
  const name = await waitForKubernetesNamespace(context, namespaceId);
  try {
    await kubectl(
      "create",
      "rolebinding",
      "openclaw-controller",
      "--namespace",
      name,
      `--clusterrole=${tenantRole}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
  } catch (error) {
    if (!/AlreadyExists|already exists/i.test(error.stderr ?? error.message)) {
      throw error;
    }
  }
}

function cleanupKubernetesNamespaces(context, namespaceIds) {
  context.after(async () => {
    const cleanup = await Promise.allSettled(
      namespaceIds.map((namespaceId) =>
        kubectl(
          "delete",
          "namespace",
          kubernetesNamespaceName(namespaceId),
          "--ignore-not-found=true",
          "--wait=true",
        ),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason));
    }
  });
}

async function waitForNamespaceReady(api, namespaceId, worker) {
  const ready = await pollUntil(
    `Namespace ${namespaceId} to become ready through the independent worker`,
    async () => {
      const current = await request(api, "GET", `/namespaces/${namespaceId}`);
      assert.equal(current.status, 200);
      return current.data.status === "ready" ? current.data : undefined;
    },
    { worker, timeoutMs: 60_000 },
  );
  assert.equal(ready.id, namespaceId);
  assert.equal(ready.status, "ready");
  return ready;
}

async function createConfiguration(api, namespaceId, values = defaultAgentConfigurationValues) {
  const configuration = await request(api, "POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values,
  });
  assert.equal(configuration.status, 201);
  return configuration.data;
}

async function updateConfiguration(api, namespaceId, configurationId, values) {
  const configuration = await request(
    api,
    "PATCH",
    `/namespaces/${namespaceId}/configurations/${configurationId}`,
    { values },
  );
  assert.equal(configuration.status, 200);
  return configuration.data;
}

async function createConfiguredAgent(api, namespaceId, name, values, body = {}) {
  const configuration = await createConfiguration(api, namespaceId, values);
  const agent = await request(api, "POST", `/namespaces/${namespaceId}/agents`, {
    name,
    configurationId: configuration.id,
    ...body,
  });
  assert.equal(agent.status, 201);
  return { configuration, agent: agent.data };
}

async function createKubernetesHarnessAuth(api, namespaceId) {
  // Fixture workloads receive an owned synthetic source, never a real provider credential.
  const secret = await request(api, "POST", `/namespaces/${namespaceId}/secrets`, {
    name: `fixture-model-${randomUUID()}`,
    value: `synthetic-fixture-key-${randomUUID()}`,
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.error));
  return { method: "api_key", source: secret.data.ref };
}

async function createKubernetesConfiguredAgent(pool, api, namespaceId, name, values, body = {}) {
  const harnessAuth = await createKubernetesHarnessAuth(api, namespaceId);
  const created = await createConfiguredAgent(api, namespaceId, name, values, {
    ...body,
    harnessAuth,
  });
  await grantAgentSecretOperate(pool, created.agent, harnessAuth.source.id);
  return created;
}

function admitted(values) {
  return admitLoggingConfiguration(values, "info");
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopController(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
  force.unref();
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

async function startController(context, { kubernetesDrivers = false } = {}) {
  const port = await availablePort();
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const configurationRoot = await mkdtemp(join(tmpdir(), "openclaw-postgres-configurations-"));
  context.after(async () => {
    await rm(configurationRoot, { recursive: true, force: true });
  });
  await ensureDevelopmentBootstrap(context, {
    databaseUrl,
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: `http://127.0.0.1:${port}`,
    installationName: "PostgreSQL platform state integration",
  });
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      OCC_HOST: "127.0.0.1",
      OCC_PORT: String(port),
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
      OCC_AUTH_SECRET: authSecret,
      OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
      OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-postgres-platform-state",
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopController(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `The durable OCC subprocess exited early:\n${output}`);
    try {
      const session = await signInWithEmailPassword({
        fetch,
        origin,
        email: adminEmail,
        password: adminPassword,
      });
      return { child, origin, session };
    } catch {
      await delay(40);
    }
  }
  assert.fail(`The durable OCC subprocess never became ready:\n${output}`);
}

async function spawnWorker(context, { kubernetesDrivers = false } = {}) {
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const child = spawn(process.execPath, [workerEntrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      OCC_DATABASE_URL: databaseUrl,
      OCC_TEST_DATABASE_URL: databaseUrl,
      OCC_WORKER_POLL_INTERVAL_MS: "20",
      OCC_WORKER_LEASE_DURATION_MS: "5000",
      OCC_AUTH_BASE_URL: "http://127.0.0.1",
      OCC_AUTH_SECRET: authSecret,
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopController(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return { child, output: () => output };
}

async function startWorker(context, options) {
  const worker = await spawnWorker(context, options);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(
      worker.child.exitCode,
      null,
      `The separate OCC worker subprocess exited early:\n${worker.output()}`,
    );
    if (/"event"\s*:\s*"worker\.started"/.test(worker.output())) {
      return worker;
    }
    await delay(25);
  }
  assert.fail(`The separate OCC worker subprocess never became ready:\n${worker.output()}`);
}

async function startKubernetesController(context) {
  return startController(context, { kubernetesDrivers: true });
}

async function startKubernetesWorker(context) {
  return startWorker(context, { kubernetesDrivers: true });
}

async function pollUntil(description, operation, { worker, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker !== undefined) {
      assert.equal(
        worker.child.exitCode,
        null,
        `The OCC worker exited while waiting for ${description}:\n${worker.output()}`,
      );
    }
    const result = await operation();
    if (result !== undefined) {
      return result;
    }
    await delay(35);
  }
  assert.fail(
    `Timed out waiting for ${description}.${worker === undefined ? "" : `\n${worker.output()}`}`,
  );
}

function parseJsonLines(output) {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function request(controller, method, path, body, options = {}) {
  const response = await fetch(`${controller.origin}${path}`, {
    method,
    headers: {
      ...(options.authenticated === false
        ? {}
        : authenticatedHeaders(options.session ?? controller.session)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json();
  return { status: response.status, data: payload.data, error: payload.error };
}

async function createDurableController(pool) {
  const [
    { NativeIAMDriver },
    { OpenClawController },
    { PostgresPlatformState },
    { createDevelopmentComputeDriver },
    { DEVELOPMENT_HARNESS_DESCRIPTOR, resolveApprovedHarness: resolveApprovedDevelopmentHarness },
  ] = await Promise.all([
    import("../../packages/iam/src/index.ts"),
    import("../../packages/occ/src/index.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../helpers/development.mjs"),
    import("../../apps/controller/src/composition/production-harness.ts"),
  ]);
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  assert.ok(installation, "the real OCC subprocess must bootstrap the singleton Installation");

  const iam = new NativeIAMDriver(state, {
    id: "native-iam",
    implementation: "native",
  });
  const compute = createDevelopmentComputeDriver();
  const controller = new OpenClawController(installation, { state, recordOperations: true });
  for (const driver of [iam, compute]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }

  return {
    controller,
    state,
    harness: DEVELOPMENT_HARNESS_DESCRIPTOR,
    resolveHarness: resolveApprovedDevelopmentHarness,
  };
}

export {
  adminEmail,
  admitted,
  cleanupKubernetesNamespaces,
  createConfiguration,
  createConfiguredAgent,
  createKubernetesConfiguredAgent,
  createKubernetesHarnessAuth,
  createDurableController,
  databaseUrl,
  defaultAgentConfigurationValues,
  grantTenantAccess,
  parseJsonLines,
  pollUntil,
  request,
  requiresPostgres,
  requiresPostgresAndKubernetesConfiguration,
  spawnWorker,
  startController,
  startKubernetesController,
  startKubernetesWorker,
  stopController,
  updateConfiguration,
  verifyPlatformStateStoreContract,
  waitForNamespaceReady,
};
