import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { Check } from "typebox/value";

import {
  ErrorResponse,
  Meta,
  type AgentResponse,
  type ConfigurationResponse,
  type CreateAgentBody,
  type NamespaceResponse,
  type OpenClawConfigurationDocument,
  type SecretResponse,
} from "../../packages/contracts/src/index.ts";
import { verifyPlatformStateStoreContract } from "../conformance/platform-state-store.contract.mjs";
import { admittedConfiguration } from "./admitted-configuration.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { reservePort, reservedPortArgs } from "./available-port.ts";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { createConsoleFixtureTransport, fetchLoopback } from "./console-fixture-transport.ts";
import { jsonRequestInit } from "./inject-json.mjs";
import { jsonLines as parseJsonLines } from "./json-lines.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import {
  cleanupKubernetesNamespaces,
  createKubernetesStartupEnvironment,
  grantTenantAccess,
} from "./postgres-platform-kubernetes.ts";
import { stopProcess } from "./stop-process.mjs";
import { temporaryDirectory } from "./temporary-directory.ts";
import { waitFor } from "./wait-for.mjs";

type Configuration = ConfigurationResponse["data"];
type Agent = AgentResponse["data"];
type AgentOptions = Partial<CreateAgentBody>;
type Session = { response: Response; setCookie: string[]; cookie: string; origin: string };
type Worker = Awaited<ReturnType<typeof spawnWorker>>;
type Controller = Awaited<ReturnType<typeof startController>>;
type RequestOptions = {
  authenticated?: boolean;
  session?: string | Pick<Session, "cookie" | "origin">;
};
export type KubernetesFixtureAgent = Agent & {
  harnessAuth: Extract<Agent["harnessAuth"], { method: "api_key" }>;
};

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = fileURLToPath(new URL("../../apps/controller/src/server.mjs", import.meta.url));
const workerEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/worker.mjs", import.meta.url),
);
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "openclaw-postgres-development-auth-secret-minimum-32-bytes";
const browserOrigin = "https://console.oce.localhost";
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
const caseDatabases = new WeakMap<TestContext, string>();
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

// Under the CI runner (prepared ownership in OPENCLAW_ENTERPRISE_CI_STATE) a case can own a
// database: prepareFile's fresh copy of the lane's migrated template, the same empty database
// the runner prepared for the file (OCC_TEST_DATABASE_URL), which such a file leaves unused.
// Nothing connects to the lane template (PostgreSQL copies only a database without sessions),
// so a step that still used OCC_TEST_DATABASE_URL could not break another case's copy. The OCC
// processes started below with the same context use the copy. It is dropped after the case's
// other after hooks, which stop those processes and end its pools: node:test runs a hook added
// while the after hooks run after the ones already registered. A failing after hook makes
// node:test skip the later ones, the drop included; lane cleanup drops that copy. Without
// prepared ownership the cases share OCC_TEST_DATABASE_URL, so they must run one at a time.
const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
const caseDatabasesAvailable = Boolean(statePath);
// The worker revision fixture's limit for the drop's wait for the CI state lock.
const caseDatabaseDropLockTimeoutMs = 120_000;

async function prepareCaseDatabase(
  context: TestContext,
  { lane, testFile }: { lane: string; testFile: string },
) {
  if (!statePath) {
    return databaseUrl;
  }
  const { prepareFile } = await import("../../scripts/ci/prepare.mjs");
  const prepared = await prepareFile({
    lane,
    file: fileURLToPath(testFile),
    statePath,
    template: undefined,
    modelSelectors: undefined,
  });
  const { cleanup } = prepared;
  assert.ok(cleanup, "the prepared case must own database cleanup");
  context.after(() =>
    context.after(() => cleanup({ lockTimeoutMs: caseDatabaseDropLockTimeoutMs })),
  );
  const ownedDatabaseUrl: unknown = prepared.env.OCC_TEST_DATABASE_URL;
  assert.ok(typeof ownedDatabaseUrl === "string", "the prepared case must own a database URL");
  caseDatabases.set(context, ownedDatabaseUrl);
  return ownedDatabaseUrl;
}

function contextDatabaseUrl(context: TestContext) {
  return caseDatabases.get(context) ?? databaseUrl;
}

async function configuredDriverEnvironment(context: TestContext, kubernetesDrivers: boolean) {
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

async function waitForNamespaceReady(api: Controller, namespaceId: string, worker: Worker) {
  const ready = await pollUntil(
    `Namespace ${namespaceId} to become ready through the independent worker`,
    async () => {
      const current = await request<NamespaceResponse["data"]>(
        api,
        "GET",
        `/namespaces/${namespaceId}`,
      );
      assert.equal(current.status, 200);
      return current.data.status === "ready" ? current.data : undefined;
    },
    { worker, timeoutMs: 60_000 },
  );
  assert.equal(ready.id, namespaceId);
  assert.equal(ready.status, "ready");
  return ready;
}

async function createConfiguration(
  api: Controller,
  namespaceId: string,
  values: OpenClawConfigurationDocument = defaultAgentConfigurationValues,
) {
  const configuration = await request<Configuration>(
    api,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values,
    },
  );
  assert.equal(configuration.status, 201);
  return configuration.data;
}

async function updateConfiguration(
  api: Controller,
  namespaceId: string,
  configurationId: string,
  values: OpenClawConfigurationDocument,
) {
  const configuration = await request<Configuration>(
    api,
    "PATCH",
    `/namespaces/${namespaceId}/configurations/${configurationId}`,
    { values },
  );
  assert.equal(configuration.status, 200);
  return configuration.data;
}

async function createConfiguredAgent(
  api: Controller,
  namespaceId: string,
  name: string,
  values?: OpenClawConfigurationDocument,
  body: AgentOptions = {},
) {
  const configuration = await createConfiguration(api, namespaceId, values);
  const agent = await request<Agent>(api, "POST", `/namespaces/${namespaceId}/agents`, {
    name,
    configurationId: configuration.id,
    ...body,
  });
  assert.equal(agent.status, 201);
  return { configuration, agent: agent.data };
}

async function createKubernetesHarnessAuth(
  api: Controller,
  namespaceId: string,
): Promise<KubernetesFixtureAgent["harnessAuth"]> {
  // Fixture workloads receive an owned synthetic source, never a real provider credential.
  const secret = await request<SecretResponse["data"]>(
    api,
    "POST",
    `/namespaces/${namespaceId}/secrets`,
    {
      name: `fixture-model-${randomUUID()}`,
      value: `synthetic-fixture-key-${randomUUID()}`,
    },
  );
  assert.equal(secret.status, 201, JSON.stringify(secret.error));
  return { method: "api_key", source: secret.data.ref };
}

async function createKubernetesConfiguredAgent(
  pool: Pool,
  api: Controller,
  namespaceId: string,
  name: string,
  values?: OpenClawConfigurationDocument,
  body: AgentOptions = {},
) {
  const harnessAuth = await createKubernetesHarnessAuth(api, namespaceId);
  const created = await createConfiguredAgent(api, namespaceId, name, values, {
    // The fixture image does not contain an OC Gateway runtime.
    gatewayManagedMode: false,
    ...body,
    harnessAuth,
  });
  await grantAgentSecretOperate(pool, created.agent, harnessAuth.source.id);
  assertFixtureHarnessAuth(created.agent);
  return { configuration: created.configuration, agent: created.agent };
}

function assertFixtureHarnessAuth(agent: Agent): asserts agent is KubernetesFixtureAgent {
  assert.equal(agent.harnessAuth?.method, "api_key");
}

function admitted(values: OpenClawConfigurationDocument): OpenClawConfigurationDocument {
  return admittedConfiguration(values);
}

async function startController(
  context: TestContext,
  {
    kubernetesDrivers = false,
    databaseUrl: occDatabaseUrl = contextDatabaseUrl(context),
  }: { kubernetesDrivers?: boolean; databaseUrl?: string } = {},
) {
  // Hold the private loopback transport port until the child binds it.
  const reservation = await reservePort();
  context.after(reservation.release);
  const { port } = reservation;
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const configurationRoot = await temporaryDirectory(context, "openclaw-postgres-configurations-");
  await ensureDevelopmentBootstrap(context, {
    databaseUrl: occDatabaseUrl,
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: browserOrigin,
    agentDomain: "agents.oce.localhost",
    installationName: "PostgreSQL platform state integration",
    // The Job's code in this process; the API below is the real server.mjs process.
    inProcess: true,
  });
  const child = spawn(process.execPath, [...reservedPortArgs(reservation), entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      OCC_HOST: "127.0.0.1",
      OCC_PORT: String(port),
      OCC_DATABASE_URL: occDatabaseUrl,
      OCC_AUTH_BASE_URL: browserOrigin,
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
      OCC_AUTH_SECRET: authSecret,
      OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
      OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-postgres-platform-state",
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopProcess(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));

  const origin = `http://127.0.0.1:${port}`;
  const transport = createConsoleFixtureTransport(browserOrigin, origin);
  const session = await waitFor<Session>(
    () => `the durable OCC subprocess to become ready:\n${output}`,
    async () => {
      assert.equal(child.exitCode, null, `The durable OCC subprocess exited early:\n${output}`);
      try {
        return await signInWithEmailPassword({
          fetch: (input, init) => transport.fetchThroughLoopback(new Request(input, init)),
          origin: browserOrigin,
          email: adminEmail,
          password: adminPassword,
          rememberMe: undefined,
        });
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 15_000, intervalMs: 40 },
  );
  // Only the child can sign in, so it has bound the port; the reservation would otherwise
  // keep taking (and resetting) a share of the connections.
  await reservation.release();
  return { child, origin, session, output: () => output };
}

async function spawnWorker(context: TestContext, { kubernetesDrivers = false } = {}) {
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const occDatabaseUrl = contextDatabaseUrl(context);
  const child = spawn(process.execPath, [workerEntrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: occDatabaseUrl,
      OCC_DATABASE_URL: occDatabaseUrl,
      OCC_TEST_DATABASE_URL: occDatabaseUrl,
      OCC_WORKER_POLL_INTERVAL_MS: "20",
      OCC_WORKER_LEASE_DURATION_MS: "5000",
      OCC_AUTH_BASE_URL: browserOrigin,
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
      OCC_AUTH_SECRET: authSecret,
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopProcess(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));

  return { child, output: () => output };
}

async function startWorker(context: TestContext, options?: { kubernetesDrivers?: boolean }) {
  const worker = await spawnWorker(context, options);
  return waitFor(
    () => `the separate OCC worker subprocess to become ready:\n${worker.output()}`,
    () => {
      assert.equal(
        worker.child.exitCode,
        null,
        `The separate OCC worker subprocess exited early:\n${worker.output()}`,
      );
      return /"event"\s*:\s*"worker\.started"/.test(worker.output()) ? worker : undefined;
    },
    { timeoutMs: 15_000, intervalMs: 25 },
  );
}

async function startKubernetesController(context: TestContext) {
  return startController(context, { kubernetesDrivers: true });
}

async function startKubernetesWorker(context: TestContext) {
  return startWorker(context, { kubernetesDrivers: true });
}

async function pollUntil<Value>(
  description: string,
  operation: () => Value | undefined | PromiseLike<Value | undefined>,
  { worker, timeoutMs = 15_000 }: { worker?: Worker; timeoutMs?: number } = {},
) {
  return waitFor(
    () => `${description}${worker === undefined ? "" : `.\n${worker.output()}`}`,
    () => {
      if (worker !== undefined) {
        assert.equal(
          worker.child.exitCode,
          null,
          `The OCC worker exited while waiting for ${description}:\n${worker.output()}`,
        );
      }
      return operation();
    },
    { timeoutMs, intervalMs: 35 },
  );
}

async function request<Data = unknown>(
  controller: Pick<Controller, "origin" | "session">,
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
) {
  const response = await fetchLoopback(`${controller.origin}${path}`, {
    ...jsonRequestInit(method, body, {
      host: new URL(browserOrigin).host,
      ...(options.authenticated === false
        ? {}
        : authenticatedHeaders(options.session ?? controller.session)),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload: unknown = await response.json();
  assert.ok(
    typeof payload === "object" && payload !== null && !Array.isArray(payload),
    "expected a JSON response envelope",
  );
  const envelope = payload as Record<string, unknown>;
  const { error, meta } = envelope;
  assert.ok(
    error === undefined || Check(ErrorResponse.properties.error, error),
    "invalid API error envelope",
  );
  const requestId =
    typeof meta === "object" && meta !== null && "requestId" in meta ? meta.requestId : undefined;
  assert.ok(
    requestId === undefined || Check(Meta.properties.requestId, requestId),
    "invalid API request ID",
  );
  return { status: response.status, data: envelope.data as Data, error, requestId };
}

async function createDurableController(pool: Pool) {
  const [
    { NativeIAMDriver },
    { OpenClawController },
    { PostgresPlatformState },
    { createDevelopmentComputeDriver, registerAndSelectDrivers },
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
  registerAndSelectDrivers(controller, [iam, compute]);

  return {
    controller,
    state,
    harness: DEVELOPMENT_HARNESS_DESCRIPTOR,
    resolveHarness: resolveApprovedDevelopmentHarness,
  };
}

export {
  adminEmail,
  adminPassword,
  admitted,
  caseDatabasesAvailable,
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
  prepareCaseDatabase,
  request,
  requiresPostgres,
  requiresPostgresAndKubernetesConfiguration,
  spawnWorker,
  startController,
  startKubernetesController,
  startKubernetesWorker,
  updateConfiguration,
  verifyPlatformStateStoreContract,
  waitForNamespaceReady,
};
