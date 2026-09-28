import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthAccountRoleNotFoundError } from "../../apps/controller/src/auth/index.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createControllerApp, createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AgentDeletingError,
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  InMemoryPlatformState,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInWithEmailPassword,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = fileURLToPath(new URL("../../apps/controller/src/server.mjs", import.meta.url));
const developmentEmail = "admin@openclaw.local";
const developmentPassword = "openclaw-development-password";
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);
const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";
const missingAgentId = "agt_6f1c9b2d-8e34-4a1f-9c57-2d0b8e4a71c3";

async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function childEnvironment(port, overrides = {}) {
  const environment = {
    ...process.env,
    NODE_ENV: "development",
    OCC_HOST: "127.0.0.1",
    OCC_PORT: String(port),
    OCC_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
    OCC_AUTH_SECRET: "openclaw-development-auth-secret-minimum-32-bytes",
    OPENCLAW_DEV_EMAIL: developmentEmail,
    OPENCLAW_DEV_PASSWORD: developmentPassword,
    ...overrides,
  };

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete environment[key];
    }
  }

  return environment;
}

function startChild(port, overrides = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    env: childEnvironment(port, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return { child, output: () => output };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const forced = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 1_000);
  forced.unref();

  try {
    await exited;
  } finally {
    clearTimeout(forced);
  }
}

async function assertUnsafeStartupRejected() {
  const configuredDatabase = { OCC_DATABASE_URL: "postgresql://127.0.0.1:1/openclaw" };
  for (const [description, overrides] of [
    ["missing development database", {}],
    ["production mode", { ...configuredDatabase, NODE_ENV: "production", OCC_HOST: "192.0.2.10" }],
    ["nonloopback bind", { ...configuredDatabase, OCC_HOST: "192.0.2.10" }],
    ["unsafe container bind", { ...configuredDatabase, OCC_HOST: "0.0.0.0" }],
    ["low-entropy auth secret", { ...configuredDatabase, OCC_AUTH_SECRET: "insecure" }],
    ["invalid auth base URL", { ...configuredDatabase, OCC_AUTH_BASE_URL: "not-a-url" }],
    [
      "nonloopback auth base URL",
      { ...configuredDatabase, OCC_AUTH_BASE_URL: "http://192.0.2.10:3000" },
    ],
    ["missing development email", { ...configuredDatabase, OPENCLAW_DEV_EMAIL: "" }],
    ["missing development password", { ...configuredDatabase, OPENCLAW_DEV_PASSWORD: "" }],
  ]) {
    const port = await availableLoopbackPort();
    const processState = startChild(port, overrides);
    let deadline;

    try {
      const result = await Promise.race([
        once(processState.child, "exit"),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`${description} did not reject startup within 15 seconds`)),
            15_000,
          );
        }),
      ]);
      const [exitCode] = result;
      assert.notEqual(exitCode, 0, `${description} must fail closed:\n${processState.output()}`);
    } finally {
      clearTimeout(deadline);
      await stopChild(processState.child);
    }
  }
}

async function request(url, method, path, options = {}) {
  const headers = {
    ...(options.identity === false ? {} : authenticatedHeaders(options.session)),
    ...options.headers,
  };
  let body;

  if (Object.hasOwn(options, "body")) {
    body = JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  } else if (Object.hasOwn(options, "rawBody")) {
    body = options.rawBody;
  }

  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const payload = await response.json();
  assert.match(payload.meta?.requestId ?? "", identifier("req"));
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  if (response.ok) {
    assert.deepEqual(Object.keys(payload).sort(), ["data", "meta"]);
  } else {
    assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
    assert.equal(typeof payload.error.code, "string");
    assert.ok(payload.error.code.length > 0);
    assert.match(payload.error.code, /^[A-Z][A-Z_]*$/);
    assert.equal(typeof payload.error.message, "string");
    assert.ok(payload.error.message.length > 0);
  }

  return {
    status: response.status,
    headers: response.headers,
    body: payload,
    data: payload.data,
  };
}

async function bootstrap(controller, name = "Enterprise development") {
  const result = await controller.request("POST", "/installation/bootstrap", {
    body: { name },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.name, name);
  assert.match(result.data.id, identifier("ins"));
  assert.equal(Number.isNaN(Date.parse(result.data.createdAt)), false);
  return result.data;
}

async function defaultNamespace(controller) {
  const result = await controller.request("GET", "/namespaces");
  assert.equal(result.status, 200);
  const found = result.data.find(
    (namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  );
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.status, "provisioning");
  return found;
}

function assertOnlyDefaultNamespace(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.data.map((namespace) => namespace.name),
    [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
  );
}

async function createNamespace(controller, name) {
  const result = await controller.request("POST", "/namespaces", {
    body: { name },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.name, name);
  assert.match(result.data.id, identifier("ns"));
  assert.equal(result.data.status, "provisioning");
  assert.equal(Object.hasOwn(result.data, "installationId"), false);
  return result.data;
}

async function createConfiguration(controller, namespaceId, values = {}) {
  const result = await controller.request("POST", `/namespaces/${namespaceId}/configurations`, {
    body: { kind: "agent", values },
  });
  assert.equal(result.status, 201);
  assert.match(result.data.id, identifier("cfg"));
  assert.equal(result.data.namespaceId, namespaceId);
  assert.deepEqual(result.data.values, values);
  return result.data;
}

async function createServiceAccount(controller, namespaceId, name) {
  const result = await controller.request("POST", `/namespaces/${namespaceId}/service-accounts`, {
    body: { name },
  });
  assert.equal(result.status, 201);
  assert.match(result.data.id, identifier("sa"));
  assert.deepEqual(result.data, {
    id: result.data.id,
    namespaceId,
    name,
  });
  return result.data;
}

async function createAgent(controller, namespaceId, name, values = {}) {
  const configuration = await createConfiguration(controller, namespaceId, values);
  const result = await controller.request("POST", `/namespaces/${namespaceId}/agents`, {
    body: { name, configurationId: configuration.id },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.name, name);
  assert.equal(result.data.namespaceId, namespaceId);
  assert.match(result.data.id, identifier("agt"));
  assert.equal(result.data.configurationId, configuration.id);
  assert.equal(Object.hasOwn(result.data, "installationId"), false);
  assert.equal(typeof result.data.servicePrincipalId, "string");
  assert.ok(result.data.servicePrincipalId.length > 0);
  return result.data;
}

function exactSecretRef(namespaceId, id) {
  return { kind: "secret", namespaceId, id };
}

function provisioningRequestBody(namespaceId, secrets, overrides = {}) {
  return {
    requestId: `req_${randomUUID()}`,
    name: `Provisioned Agent ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: { agents: { defaults: { model: "codex/gpt-6-astra" } } },
      secretBindings: {
        TOOL_API_KEY: {
          source: exactSecretRef(namespaceId, secrets.toolApiKey.id),
        },
      },
      ...overrides.configuration,
    },
    harnessAuth: {
      method: "api_key",
      source: exactSecretRef(namespaceId, secrets.modelApiKey.id),
    },
    ...overrides,
  };
}

function createProvisioningCapableConfigurationDriver() {
  const driver = createTestConfigurationDriver({ id: "configuration-provisioning-api" });
  driver.createExact = (configuration) => driver.create(configuration);
  driver.inspectExact = async (configuration) => {
    try {
      const stored = await driver.read(configuration);
      assert.deepEqual(stored, configuration);
      return stored;
    } catch {
      return undefined;
    }
  };
  return driver;
}

function createProvisioningCapableComputeDriver() {
  const runtimeStatus = new Map();
  const keyOf = ({ namespace, agent }) => `${namespace.id}:${agent.id}`;
  return {
    id: "compute-provisioning-api",
    capability: "compute",
    implementation: "deterministic-test",
    agentProvisioning: { executionModes: ["dedicated"] },
    requiresAgentRuntimeCredentials: true,
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    validateHarnessAuth() {},
    validateAgentProvisioning() {},
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async provisionAgentRuntimeCredentials(binding) {
      runtimeStatus.set(keyOf(binding), { transportConfigured: true });
      return { transportConfigured: true };
    },
    async getAgentRuntimeCredentialStatus(binding) {
      return runtimeStatus.get(keyOf(binding)) ?? { transportConfigured: false };
    },
    async stopRevision() {},
    async retireRevision() {},
  };
}

async function bindHarnessKey(fixture, namespaceId, agent) {
  const created = await injectedRequest(fixture.app, "POST", `/namespaces/${namespaceId}/secrets`, {
    body: { name: `key-${agent.id}`, value: "synthetic-api-contract-key" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const internalAgent = await fixture.controller.getAgent(
    fixture.principal.id,
    namespaceId,
    agent.id,
  );
  const roleId = `harness-key-${agent.id}`;
  fixture.state.identities.push({
    kind: "service_principal",
    id: internalAgent.servicePrincipalId,
    namespaceId,
  });
  fixture.state.roles.push({
    id: roleId,
    namespaceId,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.state.bindings.push({
    id: roleId,
    namespaceId,
    subjectKind: "identity",
    subjectId: internalAgent.servicePrincipalId,
    roleId,
    resourceKind: "secret",
    resourceId: created.data.id,
  });
  const binding = { method: "api_key", source: created.data.ref };
  const updated = await injectedRequest(
    fixture.app,
    "PATCH",
    `/namespaces/${namespaceId}/agents/${agent.id}`,
    {
      body: { configurationId: agent.configurationId, harnessAuth: binding },
    },
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  return binding;
}

const diffsPluginId = "occ-plugin:diffs";
const linearPluginId = "codex-plugin:linear@openai-curated-remote";

function pluginPolicy(overrides = {}) {
  return { enabled: true, toolDefaults: { approval: "none" }, ...overrides };
}

function assertPolicyOnlyPlugin(selection) {
  for (const key of ["id", "nativeId", "name", "driver", "release", "artifacts"]) {
    assert.equal(
      Object.hasOwn(selection, key),
      false,
      `Agent plugin policy must not expose ${key}`,
    );
  }
}

async function createInjectedFixture(options = {}) {
  const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "OCC API Administrator",
  });
  const principal = authFixture.seed.principal;
  const state = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: authFixture.seed.roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: authFixture.seed.roles[0].id,
      },
    ],
    restrictions: [],
  };
  const iamDriver =
    options.iamDriver ??
    new NativeIAMDriver({ loadNativeIAMState: async () => state }, { id: "iam-integration" });
  const computeCalls = { ensureNamespace: [], deleteNamespace: [] };
  const computeDriver = options.computeDriver ?? {
    id: "compute-integration",
    capability: "compute",
    implementation: "deterministic-test",
    async ensureNamespace(namespace) {
      computeCalls.ensureNamespace.push(namespace.id);
      return {
        namespaceId: namespace.id,
        namespaceReady: true,
      };
    },
    async deleteNamespace(namespace) {
      computeCalls.deleteNamespace.push(namespace.id);
      return {
        namespaceId: namespace.id,
        namespaceDeleted: true,
      };
    },
    // OCC API coverage exercises admission; runtime compatibility belongs to Compute suites.
    validateHarnessAuth() {},
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async stopRevision() {},
    async retireRevision() {},
  };
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const configurationDriver =
    options.configurationDriver ??
    createTestConfigurationDriver({ id: "configuration-integration" });
  const secretDriver =
    options.secretDriver ?? createTestSecretDriver({ id: "secret-api-integration" });
  const sessionsByPrincipalId = new Map();
  let controller;
  let platformState;
  let app;

  async function installAuthSeed(seed, { auditEvent } = {}) {
    const roleIds = new Set(state.roles.map((role) => role.id));
    for (const binding of seed.bindings) {
      if (!roleIds.has(binding.roleId)) {
        throw new AuthAccountRoleNotFoundError(binding.roleId);
      }
    }
    state.identities.push(seed.principal);
    state.roles.push(...seed.roles);
    state.bindings.push(...seed.bindings);
    if (auditEvent !== undefined) {
      await auditSink.append(auditEvent);
    }
  }

  function createApp(identity = principal, createApplication = createControllerApp) {
    const created = createApplication({
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              const baseState = new InMemoryPlatformState({ auditSink });
              platformState =
                options.deploymentWorks === undefined
                  ? baseState
                  : stateWithDeploymentWork(baseState, options.deploymentWorks);
              controller = new OpenClawController(installation, {
                state: platformState,
                recordOperations: options.recordOperations ?? false,
                ...(options.backends === undefined ? {} : { backends: options.backends }),
              });
              if (options.backends?.length) {
                // Association alone must never provision an upstream account or credential.
                const unexpectedBackendCall = async () => assert.fail("Unexpected Backend call");
                controller.registerDriver({
                  id: options.backends[0].drivers.service_account,
                  implementation: "chatgpt",
                  capability: "service_account",
                  backendId: options.backends[0].id,
                  create: unexpectedBackendCall,
                  createCredential: unexpectedBackendCall,
                  delete: unexpectedBackendCall,
                });
                controller.selectDriver(
                  "service_account",
                  options.backends[0].drivers.service_account,
                );
              }
              return controller;
            },
          }),
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      ...(Object.hasOwn(options, "backendSummaries")
        ? { backendSummaries: options.backendSummaries }
        : {}),
      development: {
        enabled: true,
        installationId,
      },
      auth: authFixture.auth,
      ...(options.provisionAuthAccount === undefined
        ? {}
        : {
            provisionAuthAccount: (seed, auditEvent) =>
              options.provisionAuthAccount(seed, {
                installAuthSeed,
                state,
                auditEvent,
              }),
          }),
    });
    created.defaultSession = sessionsByPrincipalId.get(identity.id);
    return created;
  }

  app = createApp();
  sessionsByPrincipalId.set(principal.id, await signInToControllerApp(app, authFixture));
  app.defaultSession = sessionsByPrincipalId.get(principal.id);

  return {
    app,
    session: app.defaultSession,
    authFixture,
    auditSink,
    computeCalls,
    createApp,
    async createAuthPrincipal(name) {
      const email = `${name}-${randomUUID()}@example.com`;
      const password = `generated-password-${randomUUID()}`;
      const account = await authFixture.auth.createAccount({
        email,
        password,
        name,
      });
      const seed = authFixture.auth.principalSeed(account);
      sessionsByPrincipalId.set(
        seed.principal.id,
        await signInToControllerApp(app, { email, password }),
      );
      return {
        principal: seed.principal,
        session: sessionsByPrincipalId.get(seed.principal.id),
      };
    },
    get iamDriver() {
      return iamDriver;
    },
    get computeDriver() {
      return computeDriver;
    },
    get configurationDriver() {
      return configurationDriver;
    },
    installationId,
    principal,
    state,
    get platformState() {
      return platformState;
    },
    installAuthSeed,
    get controller() {
      return controller;
    },
  };
}

async function configuredController(options = {}) {
  const fixture = await createInjectedFixture(options);
  return {
    fixture,
    request: (method, pathname, options) => injectedRequest(fixture.app, method, pathname, options),
  };
}

function stateWithDeploymentWork(state, deploymentWorks) {
  const withWork = (view) => ({
    ...view,
    operations: {
      ...view.operations,
      findWork: async (requestedKey) =>
        deploymentWorks.has(requestedKey)
          ? Object.freeze({ ...deploymentWorks.get(requestedKey) })
          : view.operations.findWork(requestedKey),
    },
  });
  return {
    read: (operation) => state.read((view) => operation(withWork(view))),
    transact: (operation) => state.transact((view) => operation(withWork(view))),
    transactWithQueue: (operation, options) =>
      state.transactWithQueue((view, queue) => operation(withWork(view), queue), options),
    registerRollback: (rollback) => state.registerRollback(rollback),
  };
}

async function injectedRequest(app, method, pathname, options = {}) {
  const headers = {
    ...(options.identity === false
      ? {}
      : authenticatedHeaders(options.session ?? app.defaultSession)),
    ...options.headers,
  };
  const hasBody = Object.hasOwn(options, "body");
  const hasRawBody = Object.hasOwn(options, "rawBody");
  if (hasBody || hasRawBody) {
    headers["content-type"] ??= "application/json";
  }
  let payload;
  if (hasRawBody) {
    payload = options.rawBody;
  } else if (hasBody) {
    payload = JSON.stringify(options.body);
  }
  const response = await app.fetch(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    }),
  );
  if (response.status === 204) {
    return { status: response.status, headers: response.headers };
  }
  const body = await response.json();
  assert.match(body.meta?.requestId ?? "", identifier("req"));
  return { status: response.status, headers: response.headers, body, data: body.data };
}

async function createInjectedConfiguration(fixture, namespaceId, values = {}) {
  const result = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    { body: { kind: "agent", values } },
  );
  assert.equal(result.status, 201);
  return result.data;
}

test("OCC Fastify serves singleton, Namespace, Configuration, and Agent resource routes", async () => {
  const controller = await configuredController();
  const installation = await bootstrap(controller);

  const singleton = await controller.request("GET", "/installation");
  assert.equal(singleton.status, 200);
  assert.deepEqual(singleton.data, installation);
  const bootstrappedDefault = await defaultNamespace(controller);

  const namespace = await createNamespace(controller, "research");
  assert.equal(Object.hasOwn(namespace, "installationId"), false);

  const namespaces = await controller.request("GET", "/namespaces");
  assert.equal(namespaces.status, 200);
  assert.deepEqual(namespaces.data, [bootstrappedDefault, namespace]);

  const namespaceDetail = await controller.request("GET", `/namespaces/${namespace.id}`);
  assert.equal(namespaceDetail.status, 200);
  assert.deepEqual(namespaceDetail.data, namespace);

  const agent = await createAgent(controller, namespace.id, "research-agent");
  assert.equal(Object.hasOwn(agent, "installationId"), false);

  const account = await createServiceAccount(controller, namespace.id, "research-account");
  const serviceAccounts = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/service-accounts`,
  );
  assert.equal(serviceAccounts.status, 200);
  assert.deepEqual(serviceAccounts.data, [account]);

  const agents = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.equal(agents.status, 200);
  assert.deepEqual(agents.data, [agent]);

  const agentDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(agentDetail.status, 200);
  assert.deepEqual(agentDetail.data, agent);

  const stopped = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(stopped.data.id, agent.id);

  const deployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(deployment.status, 409);
  assert.equal(deployment.body.error.code, "NAMESPACE_NOT_READY");

  const secondDeployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(secondDeployment.status, 409);
  assert.equal(secondDeployment.body.error.code, "NAMESPACE_NOT_READY");

  const revisions = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);

  const revisionDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${missingRevisionId}`,
  );
  assert.equal(revisionDetail.status, 404);
  assert.equal(revisionDetail.body.error.code, "NOT_FOUND");

  // Deletion is asynchronous: the route admits the request, moves the Agent to
  // deleting and queues teardown. It answers 202 rather than 204 because the
  // Agent and its revisions still exist until the worker finishes.
  assert.equal(agent.status, "active");
  const missingDeletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${missingAgentId}`,
  );
  assert.equal(missingDeletion.status, 404);
  assert.equal(missingDeletion.body.error.code, "NOT_FOUND");

  const deletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202);
  assert.deepEqual(deletion.data, { ...agent, status: "deleting" });

  // Reads keep returning a deleting Agent, so an operator can observe teardown
  // in progress instead of seeing it vanish before its resources are gone.
  const deletingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletingDetail.status, 200);
  assert.equal(deletingDetail.data.status, "deleting");

  // A repeated request converges on the in-flight teardown rather than
  // conflicting, so a client retry after a lost response is safe.
  const repeatedDeletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(repeatedDeletion.status, 202);
  assert.deepEqual(repeatedDeletion.data, deletion.data);

  // The Agent row survives until teardown completes, so its Namespace is still
  // occupied. Offboarding becomes possible only once the row is removed.
  const stillOccupied = await controller.request("DELETE", `/namespaces/${namespace.id}`);
  assert.equal(stillOccupied.status, 409);
  assert.equal(stillOccupied.body.error.code, "NAMESPACE_NOT_EMPTY");

  const secondBootstrap = await controller.request("POST", "/installation/bootstrap", {
    body: { name: "another installation" },
  });
  assert.equal(secondBootstrap.status, 409);
  assert.equal(secondBootstrap.body.error.code, "INSTALLATION_EXISTS");

  const installationCollection = await controller.request("POST", "/installations", {
    body: { name: "forbidden collection" },
  });
  assert.equal(installationCollection.status, 404);

  const auditEndpoint = await controller.request("GET", "/audit");
  assert.equal(auditEndpoint.status, 404);

  const unchanged = await controller.request("GET", "/installation");
  assert.deepEqual(unchanged.data, installation);
});

test("Namespace IAM routes manage exact Role and AccessBinding policy through the selected Driver", async () => {
  const fixture = await createInjectedFixture();
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller);

  const namespace = await createNamespace(controller, "iam-policy");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Model API key", value: "iam-policy-secret" },
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));
  const agent = await createAgent(controller, namespace.id, "iam-policy-agent");

  const role = await controller.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: {
      name: "Secret operator",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  assert.match(role.data.id, identifier("role"));
  assert.deepEqual(role.data, {
    id: role.data.id,
    namespaceId: namespace.id,
    name: "Secret operator",
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });

  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  assert.equal(roles.status, 200);
  assert.deepEqual(roles.data, [role.data]);

  const roleDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${role.data.id}`,
  );
  assert.equal(roleDetail.status, 200);
  assert.deepEqual(roleDetail.data, role.data);

  const binding = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: secret.data.id,
      },
    },
  );
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  assert.match(binding.data.id, identifier("binding"));
  assert.deepEqual(binding.data, {
    id: binding.data.id,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.data.id,
    resourceKind: "secret",
    resourceId: secret.data.id,
  });

  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  assert.equal(bindings.status, 200);
  assert.deepEqual(bindings.data, [binding.data]);

  const bindingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings/${binding.data.id}`,
  );
  assert.equal(bindingDetail.status, 200);
  assert.deepEqual(bindingDetail.data, binding.data);

  const referencedDelete = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/roles/${role.data.id}`,
  );
  assert.equal(referencedDelete.status, 409);
  assert.equal(referencedDelete.body.error.code, "RESOURCE_CONFLICT");

  const deletedBinding = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/access-bindings/${binding.data.id}`,
  );
  assert.equal(deletedBinding.status, 204);

  const deletedRole = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/iam/roles/${role.data.id}`,
  );
  assert.equal(deletedRole.status, 204);

  const missingRole = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${role.data.id}`,
  );
  assert.equal(missingRole.status, 404);
  assert.equal(missingRole.body.error.code, "NOT_FOUND");
});

test("Namespace IAM read routes serialize broad native policy without widening mutations", async () => {
  const fixture = await createInjectedFixture();
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "iam-native-read-policy");
  const role = {
    id: "role_native_read_policy",
    namespaceId: namespace.id,
    name: "Native namespace reader",
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent_revision" },
    ],
  };
  const binding = {
    id: "binding_native_group_namespace",
    namespaceId: namespace.id,
    subjectKind: "group",
    subjectId: "grp_native_namespace_operators",
    roleId: role.id,
  };
  const readPolicyDriver = {
    id: "iam-native-read-policy",
    capability: "iam",
    implementation: "native-read-policy-test",
    async lookupIdentity(input) {
      if (
        input.issuer === fixture.principal.issuer &&
        input.subject === fixture.principal.subject
      ) {
        return fixture.principal;
      }
      return undefined;
    },
    async authorize(request) {
      return {
        allowed: true,
        reason: "admitted for native read policy serialization",
        driverId: "iam-native-read-policy",
        evidence: {
          identityId: request.principalId,
          groupIds: [],
          bindingIds: [],
          roleIds: [],
          restrictionIds: [],
        },
      };
    },
    async listNamespaceRoles(_context, namespaceId) {
      return namespaceId === namespace.id ? [role] : [];
    },
    async getNamespaceRole(_context, namespaceId, roleId) {
      return namespaceId === namespace.id && roleId === role.id ? role : undefined;
    },
    async listNamespaceAccessBindings(_context, namespaceId) {
      return namespaceId === namespace.id ? [binding] : [];
    },
    async getNamespaceAccessBinding(_context, namespaceId, bindingId) {
      return namespaceId === namespace.id && bindingId === binding.id ? binding : undefined;
    },
  };
  fixture.controller.registerDriver(readPolicyDriver);
  fixture.controller.selectDriver("iam", readPolicyDriver.id);

  const roles = await controller.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  assert.equal(roles.status, 200, JSON.stringify(roles.body));
  assert.deepEqual(roles.data, [role]);

  const roleDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${role.id}`,
  );
  assert.equal(roleDetail.status, 200, JSON.stringify(roleDetail.body));
  assert.deepEqual(roleDetail.data, role);

  const bindings = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  assert.equal(bindings.status, 200, JSON.stringify(bindings.body));
  assert.deepEqual(bindings.data, [binding]);

  const bindingDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings/${binding.id}`,
  );
  assert.equal(bindingDetail.status, 200, JSON.stringify(bindingDetail.body));
  assert.deepEqual(bindingDetail.data, binding);

  const broadRoleCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/roles`,
    {
      body: {
        name: "Rejected broad mutating role",
        permissions: [{ action: "read", resourceKind: "namespace" }],
      },
    },
  );
  assert.equal(broadRoleCreate.status, 400);
  assert.equal(broadRoleCreate.body.error.code, "INVALID_REQUEST");

  const groupBindingCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "group",
        subjectId: binding.subjectId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: "sec_11111111-1111-4111-8111-111111111111",
      },
    },
  );
  assert.equal(groupBindingCreate.status, 400);
  assert.equal(groupBindingCreate.body.error.code, "INVALID_REQUEST");

  const broadBindingCreate = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: fixture.principal.id,
        roleId: role.id,
      },
    },
  );
  assert.equal(broadBindingCreate.status, 400);
  assert.equal(broadBindingCreate.body.error.code, "INVALID_REQUEST");
});

test("Namespace IAM routes fail closed without policy management and roll back audit failures", async () => {
  const unsupportedFixture = await createInjectedFixture();
  const unsupported = {
    request: (method, path, options) =>
      injectedRequest(unsupportedFixture.app, method, path, options),
  };
  await bootstrap(unsupported);
  const unsupportedNamespace = await createNamespace(unsupported, "unsupported-iam");
  const unsupportedDriver = {
    id: "iam-without-policy-management",
    capability: "iam",
    implementation: "admission-only-test",
    async lookupIdentity(input) {
      if (
        input.issuer === unsupportedFixture.principal.issuer &&
        input.subject === unsupportedFixture.principal.subject
      ) {
        return unsupportedFixture.principal;
      }
      return undefined;
    },
    async authorize(request) {
      return {
        allowed: true,
        reason: "admitted for unsupported management test",
        driverId: "iam-without-policy-management",
        evidence: {
          identityId: request.principalId,
          groupIds: [],
          bindingIds: [],
          roleIds: [],
          restrictionIds: [],
        },
      };
    },
  };
  unsupportedFixture.controller.registerDriver(unsupportedDriver);
  unsupportedFixture.controller.selectDriver("iam", unsupportedDriver.id);
  const dependencyFailure = await unsupported.request(
    "POST",
    `/namespaces/${unsupportedNamespace.id}/iam/roles`,
    {
      body: {
        name: "Unsupported",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    },
  );
  assert.equal(dependencyFailure.status, 503, JSON.stringify(dependencyFailure.body));
  assert.equal(dependencyFailure.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    unsupportedFixture.state.roles.filter((role) => role.namespaceId === unsupportedNamespace.id),
    [],
  );

  const rollbackFixture = await createInjectedFixture();
  const rollback = {
    request: (method, path, options) => injectedRequest(rollbackFixture.app, method, path, options),
  };
  await bootstrap(rollback);
  const rollbackNamespace = await createNamespace(rollback, "rollback-iam");
  const originalAppend = rollbackFixture.auditSink.append.bind(rollbackFixture.auditSink);
  rollbackFixture.auditSink.append = async (event) => {
    if (event.action === "openclaw.iam.roles.create") {
      throw new Error("synthetic audit outage");
    }
    await originalAppend(event);
  };

  const auditFailure = await rollback.request(
    "POST",
    `/namespaces/${rollbackNamespace.id}/iam/roles`,
    {
      body: {
        name: "Rolled back",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
    },
  );
  assert.equal(auditFailure.status, 503);
  assert.equal(auditFailure.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    rollbackFixture.state.roles.filter((role) => role.namespaceId === rollbackNamespace.id),
    [],
  );
});

test("Agent deletion closes every synchronous mutation boundary before teardown", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "deletion-race");
  const agent = await createAgent(controller, namespace.id, "deletion-race-agent");
  await controller.fixture.controller.handleNamespaceLifecycle(
    controller.fixture.principal.id,
    namespace.id,
    "ready",
  );
  await bindHarnessKey(controller.fixture, namespace.id, agent);
  const deployed = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(deployed.status, 202);

  const deletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202);
  assert.equal(deletion.data.status, "deleting");
  assert.equal(deletion.data.desiredRuntimeState, "stopped");

  for (const mutation of [
    () =>
      controller.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: { configurationId: agent.configurationId },
      }),
    () => controller.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`),
  ]) {
    const rejected = await mutation();
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "AGENT_DELETING");
    assert.equal(rejected.body.error.message, "The requested Agent is being deleted.");
  }

  // Credential provisioning and workspace routing are intentionally absent
  // from this API fixture, so prove their admission barriers directly before
  // either unavailable dependency is consulted.
  await assert.rejects(
    controller.fixture.controller.provisionAgentRuntimeCredentials(
      controller.fixture.principal.id,
      namespace.id,
      agent.id,
      {},
    ),
    AgentDeletingError,
  );
  await assert.rejects(
    controller.fixture.controller.getOperableActiveAgentRevision(
      controller.fixture.principal.id,
      namespace.id,
      agent.id,
    ),
    AgentDeletingError,
  );

  const revisions = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.data.length, 1, "no mutation may admit work after deletion starts");
});

test("Agent Backend API preserves nullable drafts and immutable revision associations", async () => {
  const fixture = await createInjectedFixture({
    backends: [
      {
        id: "openai",
        type: "chatgpt",
        configuration: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          apiKeyPath: "/unused-in-api-contract-test",
        },
        drivers: { service_account: "chatgpt-service-accounts" },
      },
    ],
    backendSummaries: [{ id: "openai", type: "chatgpt" }],
  });
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller);
  const backends = await controller.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, [{ id: "openai", type: "chatgpt" }]);
  assert.doesNotMatch(JSON.stringify(backends.body), /apiKey|workspaceId|credential|drivers|path/i);
  const namespace = await createNamespace(controller, "provider-api");
  const configuration = await createConfiguration(controller, namespace.id);
  const collection = `/namespaces/${namespace.id}/agents`;

  // Exercise wire defaults and persistence through the real authenticated Fastify routes.
  for (const [name, association] of [
    ["omitted", {}],
    ["null", { backendId: null }],
    ["selected", { backendId: "openai" }],
  ]) {
    const result = await controller.request("POST", collection, {
      body: { name, configurationId: configuration.id, ...association },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.data.backendId, association.backendId ?? null);
    const read = await controller.request("GET", `${collection}/${result.data.id}`);
    assert.equal(read.data.backendId, association.backendId ?? null);
  }

  const agents = await controller.request("GET", collection);
  const selected = agents.data.find((agent) => agent.name === "selected");
  const target = `${collection}/${selected.id}`;
  const preserved = await controller.request("PATCH", target, {
    body: { configurationId: configuration.id },
  });
  assert.equal(preserved.status, 200);
  assert.equal(preserved.data.backendId, "openai");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  await bindHarnessKey(fixture, namespace.id, selected);
  const revision = await controller.request("POST", `${target}/deploy`);
  assert.equal(revision.status, 202, JSON.stringify(revision.body));
  assert.equal(revision.data.backendId, "openai");

  const cleared = await controller.request("PATCH", target, {
    body: { configurationId: configuration.id, backendId: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.backendId, null);
  const prior = await controller.request("GET", `${target}/revisions/${revision.data.id}`);
  assert.equal(prior.data.backendId, "openai", "draft changes cannot rewrite admitted revisions");
  const independent = await controller.request("POST", `${target}/deploy`);
  assert.equal(independent.status, 202);
  assert.equal(independent.data.backendId, null);

  for (const backendId of ["", " ", "unknown", 42, [], {}]) {
    const expectedStatus = backendId === "unknown" ? 404 : 400;
    const invalid = await controller.request("POST", collection, {
      body: { name: "invalid-provider", configurationId: configuration.id, backendId },
    });
    assert.equal(invalid.status, expectedStatus, JSON.stringify(invalid.body));
    const invalidPatch = await controller.request("PATCH", target, {
      body: { configurationId: configuration.id, backendId },
    });
    assert.equal(invalidPatch.status, expectedStatus, JSON.stringify(invalidPatch.body));
  }
  const unchanged = await controller.request("GET", target);
  assert.equal(unchanged.data.backendId, null);
  const replaced = await controller.request("PATCH", target, {
    body: { configurationId: configuration.id, backendId: "openai" },
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.backendId, "openai");
});

test("Installation API exposes Agent provisioning capabilities without configured Backends", async () => {
  let ensureNamespaceCalls;
  let deleteNamespaceCalls;
  const computeDriver = {
    id: "compute-provisioning-capable",
    capability: "compute",
    implementation: "deterministic-test",
    agentProvisioning: { executionModes: ["dedicated"] },
    async ensureNamespace(namespace) {
      ensureNamespaceCalls.push(namespace.id);
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      deleteNamespaceCalls.push(namespace.id);
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    validateHarnessAuth() {},
    validateAgentProvisioning() {},
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async stopRevision() {},
    async retireRevision() {},
  };
  const fixture = await createInjectedFixture({
    backends: [],
    backendSummaries: [],
    computeDriver,
  });
  ensureNamespaceCalls = fixture.computeCalls.ensureNamespace;
  deleteNamespaceCalls = fixture.computeCalls.deleteNamespace;
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  const bootstrapped = await bootstrap(controller);
  assert.deepEqual(bootstrapped.capabilities, {
    agentProvisioning: { executionModes: ["dedicated"] },
  });

  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  assert.deepEqual(installation.data.capabilities, bootstrapped.capabilities);

  const backends = await controller.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, []);
});

test("Agent deployment status polls the admitted revision work with exact read authorization", async () => {
  const deploymentWorks = new Map();
  const fixture = await createInjectedFixture({ deploymentWorks, recordOperations: true });
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "deployment-status");
  const agent = await createAgent(controller, namespace.id, "status-agent");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  await bindHarnessKey(fixture, namespace.id, agent);

  const admitted = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${admitted.data.id}`;

  const status = await controller.request("GET", path);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(status.data, {
    deploymentId: admitted.data.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    status: "queued",
    error: null,
    warnings: [],
  });
  const runtimeFailure = {
    component: "gateway",
    check: "readyz",
    checkedAt: "2026-09-19T20:30:00.000Z",
    code: "STARTUP_FAILED",
  };
  deploymentWorks.set(`agent_revision:${admitted.data.id}:reconcile`, {
    idempotencyKey: `agent_revision:${admitted.data.id}:reconcile`,
    namespaceId: namespace.id,
    agentId: agent.id,
    revisionId: admitted.data.id,
    actorId: fixture.principal.id,
    state: "failed_permanent",
    availableAt: new Date(0),
    attemptCount: 1,
    completedAt: new Date("2026-09-19T20:31:00.000Z"),
    reasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
    resultData: { timeoutMs: 900_000, runtimeFailure },
    createdAt: new Date(0),
    updatedAt: new Date("2026-09-19T20:31:00.000Z"),
  });
  const failedStatus = await controller.request("GET", path);
  assert.equal(failedStatus.status, 200, JSON.stringify(failedStatus.body));
  assert.deepEqual(failedStatus.data, {
    deploymentId: admitted.data.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    status: "failed",
    error: {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message: "Deployment convergence deadline exceeded.",
      data: { timeoutMs: 900_000, runtimeFailure },
    },
    warnings: [],
  });

  const missing = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${missingRevisionId}`,
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");

  const { principal: revisionReader } = await fixture.createAuthPrincipal(
    "deployment-status-reader",
  );
  fixture.state.identities.push(revisionReader);
  fixture.state.roles.push({
    id: "role-deployment-status-reader",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent_revision" }],
  });
  fixture.state.bindings.push({
    id: "binding-deployment-status-reader",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: revisionReader.id,
    roleId: "role-deployment-status-reader",
  });
  const readerApp = fixture.createApp(revisionReader);
  const parentDenied = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(parentDenied.status, 403);
  const readableDeployment = await injectedRequest(readerApp, "GET", path);
  assert.equal(readableDeployment.status, 200, JSON.stringify(readableDeployment.body));
  assert.equal(readableDeployment.data.status, "failed");
  assert.deepEqual(readableDeployment.data.error?.data?.runtimeFailure, runtimeFailure);

  fixture.state.roles.find(
    (role) => role.id === "role-deployment-status-reader",
  ).permissions.length = 0;
  const deniedApp = fixture.createApp(revisionReader);
  const denied = await injectedRequest(deniedApp, "GET", path);
  assert.equal(denied.status, 403);
});

test("Installation deployment inventory fails closed on incomplete authorization and reports in-flight work", async () => {
  const deploymentWorks = new Map();
  const fixture = await createInjectedFixture({ deploymentWorks, recordOperations: true });
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "deployment-inventory");
  const agent = await createAgent(controller, namespace.id, "inventory-agent");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  await bindHarnessKey(fixture, namespace.id, agent);
  const admitted = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  const workKey = `agent_revision:${admitted.data.id}:reconcile`;
  const completedWork = {
    kind: "lifecycle",
    idempotencyKey: workKey,
    namespaceId: namespace.id,
    agentId: agent.id,
    revisionId: admitted.data.id,
    actorId: fixture.principal.id,
    state: "succeeded",
    availableAt: new Date(0),
    attemptCount: 1,
    completedAt: new Date(1),
    createdAt: new Date(0),
    updatedAt: new Date(1),
  };
  deploymentWorks.set(workKey, completedWork);
  await fixture.platformState.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, admitted.data.id),
  );

  const inventoryPath = "/installation/deployment-inventory";
  const inventory = await controller.request("GET", inventoryPath);
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
  assert.equal(inventory.data.installationId, fixture.installationId);
  assert.equal(inventory.data.namespaces.length, 2);
  assert.deepEqual(
    inventory.data.namespaces.find((candidate) => candidate.id === namespace.id),
    {
      id: namespace.id,
      status: "ready",
      agents: [
        {
          id: agent.id,
          status: "active",
          desiredRuntimeState: "running",
          executionMode: "embedded",
          activeRevisionId: admitted.data.id,
          deploymentInProgress: false,
        },
      ],
    },
  );

  // A complete fleet response must not turn any exact-resource denial into omission.
  for (const restriction of [
    {
      id: "deny-inventory-namespace-read",
      namespaceId: namespace.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
      action: "read",
      effect: "deny",
    },
    {
      id: "deny-inventory-agent-read",
      namespaceId: namespace.id,
      resourceKind: "agent",
      resourceId: agent.id,
      action: "read",
      effect: "deny",
    },
    {
      id: "deny-inventory-agent-deploy",
      namespaceId: namespace.id,
      resourceKind: "agent",
      resourceId: agent.id,
      action: "deploy",
      effect: "deny",
    },
    {
      id: "deny-inventory-revision-read",
      namespaceId: namespace.id,
      resourceKind: "agent_revision",
      resourceId: admitted.data.id,
      action: "read",
      effect: "deny",
    },
  ]) {
    fixture.state.restrictions.push(restriction);
    const denied = await controller.request("GET", inventoryPath);
    assert.equal(denied.status, 403, restriction.id);
    fixture.state.restrictions.pop();
  }

  deploymentWorks.set(workKey, { ...completedWork, state: "claimed" });
  const inProgress = await controller.request("GET", inventoryPath);
  assert.equal(inProgress.status, 200, JSON.stringify(inProgress.body));
  const inProgressAgent = inProgress.data.namespaces
    .find((candidate) => candidate.id === namespace.id)
    ?.agents.find((candidate) => candidate.id === agent.id);
  assert.equal(inProgressAgent?.deploymentInProgress, true);

  // Missing durable work makes completeness unknowable and must fail the whole operation.
  deploymentWorks.set(workKey, undefined);
  const incomplete = await controller.request("GET", inventoryPath);
  assert.equal(incomplete.status, 503);
  assert.equal(incomplete.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("Channel directory lookup checks the exact edit target and Secret before and after reading", async () => {
  const token = "synthetic-channel-directory-token";
  const secretDriver = createTestSecretDriver({ id: "secret-directory-integration" });
  const originalWithValue = secretDriver.withValue.bind(secretDriver);
  let revokeOnRead;
  let fixture;
  secretDriver.withValue = (secret, use) =>
    originalWithValue(secret, (value) => {
      if (revokeOnRead !== undefined) {
        fixture.state.restrictions.push(revokeOnRead);
        revokeOnRead = undefined;
      }
      return use(value);
    });
  const controller = await configuredController({ secretDriver });
  fixture = controller.fixture;
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "channel-directory-api");
  const configuration = await createConfiguration(controller, namespace.id);
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "channel-bot", value: token },
  });
  assert.equal(secret.status, 201);
  const agent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "directory-agent", configurationId: configuration.id },
  });
  assert.equal(agent.status, 201);

  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = { secretId: secret.data.id, kind: "users", query: "mem" };
  const unavailable = await controller.request("POST", path, { body });
  assert.equal(unavailable.status, 501);
  assert.equal(unavailable.body.error.code, "NOT_IMPLEMENTED");

  let providerCalls = 0;
  let lastProviderInput;
  let providerResult = {
    workspaceId: "T123",
    workspaceName: "Example workspace",
    candidates: [{ id: "U123", name: "member", displayName: "Member", token }],
    complete: true,
    token,
  };
  const channelDriver = {
    id: "channel-directory-integration",
    capability: "channel",
    implementation: "test-directory",
    async lookupDirectory(input) {
      providerCalls += 1;
      lastProviderInput = input;
      assert.equal(input.token, token);
      return providerResult;
    },
  };
  fixture.controller.registerDriver(channelDriver);
  fixture.controller.selectDriver("channel", channelDriver.id);
  const expected = {
    workspaceId: "T123",
    workspaceName: "Example workspace",
    candidates: [{ id: "U123", name: "member", displayName: "Member" }],
    complete: true,
  };
  const created = await controller.request("POST", path, { body });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.data, expected);
  assert.equal(JSON.stringify(created.body).includes(token), false);
  assert.equal(providerCalls, 1);
  const hydrated = await controller.request("POST", path, {
    body: { secretId: secret.data.id, kind: "users", ids: ["U123", "U999"] },
  });
  assert.equal(hydrated.status, 200, JSON.stringify(hydrated.body));
  assert.deepEqual(hydrated.data, expected);
  assert.deepEqual(lastProviderInput.ids, ["U123", "U999"]);
  const mixed = await controller.request("POST", path, {
    body: { ...body, ids: ["U123"] },
  });
  assert.equal(mixed.status, 400);
  assert.deepEqual(
    (
      await controller.request("POST", path, {
        body: { ...body, agentId: agent.data.id },
      })
    ).data,
    expected,
  );
  assert.deepEqual(
    (
      await controller.request("POST", path, {
        body: { ...body, configurationId: configuration.id },
      })
    ).data,
    expected,
  );

  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", namespace.id, "create", {}],
    ["agent", agent.data.id, "update", { agentId: agent.data.id }],
    ["configuration", configuration.id, "update", { configurationId: configuration.id }],
    ["secret", secret.data.id, "operate", {}],
  ]) {
    const restriction = {
      id: `deny-directory-${resourceKind}-${action}`,
      namespaceId: namespace.id,
      resourceKind,
      resourceId,
      action,
      effect: "deny",
    };
    fixture.state.restrictions.push(restriction);
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    fixture.state.restrictions.pop();
  }

  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", agent.data.id, "update", { agentId: agent.data.id }],
    ["secret", secret.data.id, "operate", {}],
  ]) {
    revokeOnRead = {
      id: `revoke-directory-after-read-${resourceKind}`,
      namespaceId: namespace.id,
      resourceKind,
      resourceId,
      action,
      effect: "deny",
    };
    const callsBefore = providerCalls;
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(providerCalls, callsBefore);
    fixture.state.restrictions.pop();
  }

  providerResult = { workspaceId: "T123", candidates: [], complete: false, nextCursor: "more" };
  const incompleteHydration = await controller.request("POST", path, {
    body: { secretId: secret.data.id, kind: "users", ids: ["U123"] },
  });
  assert.equal(incompleteHydration.status, 503);
  assert.equal(incompleteHydration.body.error.code, "CHANNEL_DIRECTORY_INVALID_RESPONSE");

  providerResult = { workspaceId: "T123", workspaceName: token, candidates: [], complete: true };
  const echoed = await controller.request("POST", path, { body });
  assert.equal(echoed.status, 503);
  assert.equal(echoed.body.error.code, "CHANNEL_DIRECTORY_INVALID_RESPONSE");
  assert.equal(JSON.stringify(echoed.body).includes(token), false);

  providerResult = { candidates: [], complete: true, token };
  const invalid = await controller.request("POST", path, { body });
  assert.equal(invalid.status, 503);
  assert.equal(invalid.body.error.code, "CHANNEL_DIRECTORY_INVALID_RESPONSE");
  assert.equal(JSON.stringify(invalid.body).includes(token), false);
});

test("Agent create and update replace policy-only plugin maps and revisions freeze the requested snapshot", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-api");
  const configuration = await createConfiguration(controller, namespace.id);
  const replacementConfiguration = await createConfiguration(controller, namespace.id, {
    runtime: { revision: "replacement" },
  });
  const pluginDriver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  const capabilities = installation.data.capabilities.pluginPolicies;
  assert.deepEqual(capabilities.driver, {
    id: "occ-plugin",
    implementation: "occ/openclaw-plugin",
  });
  assert.deepEqual(capabilities.toolDefaults, {
    enabled: true,
    approval: ["provider_default", "none"],
    reviewer: [],
  });
  assert.deepEqual(capabilities.tools, {
    enabled: true,
    approval: ["provider_default", "none"],
    reviewer: [],
  });
  assert.deepEqual(capabilities.approvers, { agent: true, plugin: true, tools: true });
  assert.equal(capabilities.driverPolicySchema.additionalProperties, false);
  assert.deepEqual(capabilities.driverPolicySchema.properties, {});
  const initialPlugins = {
    [diffsPluginId]: pluginPolicy({
      approvers: [{ channel: "slack", id: "team:T123:user:U123" }],
      toolDefaults: { enabled: false, approval: "none" },
      tools: { diffs: { enabled: true, approvers: [] } },
    }),
  };

  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "plugin-agent",
      configurationId: configuration.id,
      plugins: initialPlugins,
      pluginApprovers: [],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.plugins, initialPlugins);
  assert.deepEqual(created.data.pluginApprovers, []);
  assertPolicyOnlyPlugin(created.data.plugins[diffsPluginId]);

  const saved = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.plugins, initialPlugins);
  assert.deepEqual(saved.data.pluginApprovers, []);

  await controller.fixture.controller.handleNamespaceLifecycle(
    controller.fixture.principal.id,
    namespace.id,
    "ready",
  );
  await bindHarnessKey(controller.fixture, namespace.id, created.data);
  const deployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(deployment.status, 202);
  assert.deepEqual(deployment.data.plugins, {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: initialPlugins,
  });
  assert.deepEqual(deployment.data.pluginApprovers, []);
  assert.equal(Object.hasOwn(deployment.data.plugins, "artifacts"), false);

  const omittedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id } },
  );
  assert.equal(omittedPlugins.status, 200);
  assert.equal(omittedPlugins.data.configurationId, replacementConfiguration.id);
  assert.deepEqual(omittedPlugins.data.plugins, initialPlugins);
  assert.deepEqual(omittedPlugins.data.pluginApprovers, []);

  const replacementPlugins = {
    [diffsPluginId]: pluginPolicy({
      toolDefaults: { approval: "provider_default" },
      tools: { diffs: { approval: "none" } },
    }),
  };
  const replacedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    {
      body: {
        configurationId: replacementConfiguration.id,
        plugins: replacementPlugins,
        pluginApprovers: [{ channel: "slack", id: "team:T123:user:U456" }],
      },
    },
  );
  assert.equal(replacedPlugins.status, 200);
  // Replacing policy removes old enablement overrides without inventing new defaults.
  assert.deepEqual(replacedPlugins.data.plugins, replacementPlugins);
  assert.deepEqual(replacedPlugins.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
  assertPolicyOnlyPlugin(replacedPlugins.data.plugins[diffsPluginId]);

  const clearedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id, plugins: {} } },
  );
  assert.equal(clearedPlugins.status, 200);
  assert.deepEqual(clearedPlugins.data.plugins, {});
  assert.deepEqual(clearedPlugins.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);

  const historical = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}/revisions/${deployment.data.id}`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data.plugins, deployment.data.plugins);
  assert.deepEqual(historical.data.pluginApprovers, []);

  const pluginFreeRevision = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(pluginFreeRevision.status, 202);
  assert.equal(Object.hasOwn(pluginFreeRevision.data, "plugins"), false);
  assert.deepEqual(pluginFreeRevision.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
  const clearedApprovers = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id, pluginApprovers: null } },
  );
  assert.equal(clearedApprovers.status, 200);
  assert.equal(Object.hasOwn(clearedApprovers.data, "pluginApprovers"), false);
  const inheritedRevision = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(inheritedRevision.status, 202);
  assert.equal(Object.hasOwn(inheritedRevision.data, "pluginApprovers"), false);
  assert.deepEqual(pluginFreeRevision.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
});

test("Agent plugin reviewer selection preserves omission and rejects unsupported tool scope", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-reviewer-api");
  const configuration = await createConfiguration(controller, namespace.id, {
    agents: { defaults: { model: "codex/gpt-6-astra" } },
  });
  const pluginDriver = new CodexPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  const capabilities = installation.data.capabilities.pluginPolicies;
  assert.equal(capabilities.driver.id, "codex-plugin");
  assert.deepEqual(capabilities.toolDefaults.reviewer, ["human", "auto"]);
  assert.deepEqual(capabilities.tools.reviewer, []);
  assert.equal(
    Object.hasOwn(capabilities.driverPolicySchema.properties, "approvalsReviewer"),
    false,
  );

  const plugins = { [linearPluginId]: { enabled: true, toolDefaults: { reviewer: "auto" } } };
  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "reviewer-agent",
      executionMode: "dedicated",
      configurationId: configuration.id,
      plugins,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.data.plugins, plugins);
  const path = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  const saved = await controller.request("GET", path);
  assert.deepEqual(saved.data.plugins, plugins);
  const omitted = await controller.request("PATCH", path, {
    body: { configurationId: configuration.id },
  });
  assert.equal(omitted.status, 200);
  assert.deepEqual(omitted.data.plugins, plugins);

  // A tool reviewer must not silently become an app reviewer, even when redundant or disabled.
  for (const policy of [
    {
      enabled: true,
      toolDefaults: { reviewer: "auto" },
      tools: { "app/search": { reviewer: "auto" } },
    },
    { enabled: true, tools: { "app/search": { enabled: false, reviewer: "human" } } },
    { enabled: false, tools: { "app/search": { reviewer: "auto" } } },
  ]) {
    const rejected = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, plugins: { [linearPluginId]: policy } },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
    assert.equal(
      rejected.body.error.message,
      "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
    );
  }
  assert.deepEqual((await controller.request("GET", path)).data.plugins, plugins);

  // Replacing the policy removes the explicit reviewer without writing a replacement default.
  const inherited = { [linearPluginId]: { enabled: true } };
  const replaced = await controller.request("PATCH", path, {
    body: { configurationId: configuration.id, plugins: inherited },
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.data.plugins, inherited);
});

test("Agent plugin maps reject structural errors and preserve exact authorization and audit boundaries", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-api-auth");
  const configuration = await createConfiguration(controller, namespace.id);
  const pluginDriver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const auditCount = controller.fixture.auditSink.events.length;

  for (const policy of [
    { ...pluginPolicy(), nativeId: "diffs" },
    { enabled: true, approvalMode: "always" },
  ]) {
    const invalidCreate = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "invalid-plugin-agent",
        configurationId: configuration.id,
        plugins: { [diffsPluginId]: policy },
      },
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(invalidCreate.body.error.code, "INVALID_REQUEST");
    assert.equal(controller.fixture.auditSink.events.length, auditCount);
  }

  const agent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "plugin-auth-agent", configurationId: configuration.id },
  });
  assert.equal(agent.status, 201);
  const secondAgent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "plugin-auth-sibling", configurationId: configuration.id },
  });
  assert.equal(secondAgent.status, 201);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.data.id}`;
  const siblingPath = `/namespaces/${namespace.id}/agents/${secondAgent.data.id}`;

  const auditBeforeInvalidUpdate = controller.fixture.auditSink.events.length;
  const snakeCaseReviewer = await controller.request("PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      plugins: {
        [linearPluginId]: {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
          approvals_reviewer: "auto_review",
        },
      },
    },
  });
  assert.equal(snakeCaseReviewer.status, 400);
  assert.equal(snakeCaseReviewer.body.error.code, "INVALID_REQUEST");
  assert.equal(controller.fixture.auditSink.events.length, auditBeforeInvalidUpdate);

  for (const plugins of [
    { "codex-plugin:bad/plugin@openai-curated-remote": pluginPolicy() },
    { [linearPluginId]: pluginPolicy({ tools: { "bad tool": { enabled: true } } }) },
    { [linearPluginId]: pluginPolicy({ tools: { search: {} } }) },
    { [diffsPluginId]: { enabled: true, approvalMode: "never" } },
    { [diffsPluginId]: pluginPolicy({ approvalsReviewer: "user" }) },
    { [diffsPluginId]: pluginPolicy({ destructiveActions: "never" }) },
    { [diffsPluginId]: pluginPolicy({ writes: "prompt" }) },
    { [diffsPluginId]: pluginPolicy({ tools: { diffs: { approvalMode: "always" } } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { approval: "native" } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { approval: "auto" } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { reviewer: "user" } }) },
    { [diffsPluginId]: pluginPolicy({ tools: { diffs: { reviewer: null } } }) },
  ]) {
    const invalid = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id, plugins },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_REQUEST");
    assert.equal(controller.fixture.auditSink.events.length, auditBeforeInvalidUpdate);
  }

  const afterInvalidUpdate = await controller.request("GET", agentPath);
  assert.equal(Object.hasOwn(afterInvalidUpdate.data, "plugins"), false);

  // These policies satisfy the shared schema but the selected native driver cannot apply them.
  for (const [policy, message] of [
    [
      pluginPolicy({ toolDefaults: { approval: "all_actions" } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ toolDefaults: { approval: "write_actions" } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ tools: { diffs: { approval: "all_actions" } } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ driverPolicy: { destructiveEnabled: false } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ toolDefaults: { reviewer: "human" } }),
      "This Plugin Driver does not support toolDefaults.reviewer. Omit the reviewer to inherit the Harness setting.",
    ],
    [
      pluginPolicy({ tools: { diffs: { reviewer: "auto" } } }),
      "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
    ],
  ]) {
    const unsupportedCreate = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/agents`,
      {
        body: {
          name: "unsupported-plugin-agent",
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: policy },
        },
      },
    );
    const unsupportedUpdate = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id, plugins: { [diffsPluginId]: policy } },
    });
    for (const response of [unsupportedCreate, unsupportedUpdate]) {
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "INVALID_REQUEST");
      assert.equal(response.body.error.message, message);
    }
  }
  const afterUnsupported = await controller.request("GET", agentPath);
  assert.deepEqual(afterUnsupported.data, afterInvalidUpdate.data);
  const savedAgents = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.equal(savedAgents.data.length, 2, "unsupported policies must not create an Agent");

  const { principal: noGrantPrincipal } =
    await controller.fixture.createAuthPrincipal("plugin-no-grant");
  controller.fixture.state.identities.push(noGrantPrincipal);
  const noGrantApp = controller.fixture.createApp(noGrantPrincipal);
  const noGrantRead = await injectedRequest(noGrantApp, "GET", agentPath);
  assert.equal(noGrantRead.status, 403);
  assert.equal(noGrantRead.body.error.code, "FORBIDDEN");
  const noGrantUpdate = await injectedRequest(noGrantApp, "PATCH", agentPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assert.equal(noGrantUpdate.status, 403);
  assert.equal(noGrantUpdate.body.error.code, "FORBIDDEN");
  const afterNoGrant = await controller.request("GET", agentPath);
  assert.equal(Object.hasOwn(afterNoGrant.data, "plugins"), false);

  const { principal: exactAgentPrincipal } =
    await controller.fixture.createAuthPrincipal("plugin-exact-agent");
  controller.fixture.state.identities.push(exactAgentPrincipal);
  controller.fixture.state.roles.push({
    id: "role-plugin-exact-agent",
    namespaceId: namespace.id,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "update", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  });
  controller.fixture.state.bindings.push(
    {
      id: "binding-plugin-exact-agent",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: exactAgentPrincipal.id,
      roleId: "role-plugin-exact-agent",
      resourceKind: "agent",
      resourceId: agent.data.id,
    },
    {
      id: "binding-plugin-exact-configuration",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: exactAgentPrincipal.id,
      roleId: "role-plugin-exact-agent",
      resourceKind: "configuration",
      resourceId: configuration.id,
    },
  );
  const exactAgentApp = controller.fixture.createApp(exactAgentPrincipal);
  const exactRead = await injectedRequest(exactAgentApp, "GET", agentPath);
  assert.equal(exactRead.status, 200);
  const foreignRead = await injectedRequest(exactAgentApp, "GET", siblingPath);
  assert.equal(foreignRead.status, 403);
  assert.equal(foreignRead.body.error.code, "FORBIDDEN");
  const foreignUpdate = await injectedRequest(exactAgentApp, "PATCH", siblingPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assert.equal(foreignUpdate.status, 403);
  assert.equal(foreignUpdate.body.error.code, "FORBIDDEN");

  const updated = await injectedRequest(exactAgentApp, "PATCH", agentPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.plugins, { [diffsPluginId]: pluginPolicy() });

  const secondDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${secondAgent.data.id}`,
  );
  assert.equal(Object.hasOwn(secondDetail.data, "plugins"), false);

  const beforeAuditFailure = await controller.request("GET", agentPath);
  const originalAppend = controller.fixture.auditSink.append;
  controller.fixture.auditSink.append = async () => {
    throw new Error("plugin audit sink unavailable");
  };
  const failedAudit = await controller.request("PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      plugins: { [diffsPluginId]: pluginPolicy({ enabled: false }) },
    },
  });
  controller.fixture.auditSink.append = originalAppend;
  assert.equal(failedAudit.status, 503);
  assert.equal(failedAudit.body.error.code, "DEPENDENCY_UNAVAILABLE");
  const afterAuditFailure = await controller.request("GET", agentPath);
  assert.deepEqual(afterAuditFailure.data, beforeAuditFailure.data);
});

test("native ServiceAccounts keep private credential references and cannot admit Harness authentication", async () => {
  const controller = await configuredController({ recordOperations: true });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "service-account-lifecycle");
  const account = await createServiceAccount(controller, namespace.id, "model-provider");
  const accountPath = `/namespaces/${namespace.id}/service-accounts/${account.id}`;

  const detail = await controller.request("GET", accountPath);
  assert.deepEqual(detail.data, account);

  const configuration = await createConfiguration(controller, namespace.id);
  const agentResult = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "service-account-agent",
      configurationId: configuration.id,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
    },
  });
  assert.equal(agentResult.status, 201);
  assert.equal(agentResult.data.harnessAuth.serviceAccountId, account.id);
  const agent = agentResult.data;
  const deploymentPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;

  // A ready Namespace is insufficient: associated accounts without credentials cannot admit revisions.
  await controller.fixture.controller.handleNamespaceLifecycle(
    controller.fixture.principal.id,
    namespace.id,
    "ready",
  );
  const missingCredential = await controller.request("POST", deploymentPath);
  assert.equal(missingCredential.status, 409);
  assert.equal(missingCredential.body.error.code, "RESOURCE_CONFLICT");

  const initialCredential = {
    kind: "api_key",
    secretRef: { name: "namespace-provider-source", key: "provider-api-key" },
  };
  const assigned = await controller.request("PATCH", `${accountPath}/credential`, {
    body: initialCredential,
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.data.credential, { kind: initialCredential.kind });
  assert.deepEqual(
    (
      await controller.fixture.controller.getServiceAccount(
        controller.fixture.principal.id,
        namespace.id,
        account.id,
      )
    ).credential,
    initialCredential,
  );

  const nativeDeployment = await controller.request("POST", deploymentPath);
  assert.equal(nativeDeployment.status, 409);
  assert.equal(nativeDeployment.body.error.code, "RESOURCE_CONFLICT");

  // OAuth references are representable, but no refresh or OAuth execution exists yet.
  const oauthCredential = {
    kind: "oauth_access_token",
    secretRef: { name: "namespace-oauth-source", key: "access-token" },
  };
  const oauthUpdate = await controller.request("PATCH", `${accountPath}/credential`, {
    body: oauthCredential,
  });
  assert.equal(oauthUpdate.status, 200);
  const oauthDeployment = await controller.request("POST", deploymentPath);
  assert.equal(oauthDeployment.status, 409);
  assert.equal(oauthDeployment.body.error.code, "RESOURCE_CONFLICT");

  const replacementCredential = {
    kind: "api_key",
    secretRef: { name: "namespace-provider-rotated", key: "rotated-api-key" },
  };
  const replaced = await controller.request("PATCH", `${accountPath}/credential`, {
    body: replacementCredential,
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.data.credential, { kind: replacementCredential.kind });
  assert.deepEqual(
    (
      await controller.fixture.controller.getServiceAccount(
        controller.fixture.principal.id,
        namespace.id,
        account.id,
      )
    ).credential,
    replacementCredential,
  );
  assert.deepEqual(
    (await controller.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/revisions`))
      .data,
    [],
  );

  const boundDeletion = await controller.request("DELETE", accountPath);
  assert.equal(boundDeletion.status, 409);
  assert.equal(boundDeletion.body.error.code, "RESOURCE_CONFLICT");

  const detached = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: { configurationId: configuration.id, harnessAuth: null },
    },
  );
  assert.equal(detached.status, 200);
  assert.equal(detached.data.harnessAuth, null);

  // Failed admissions create no pending revision that could keep a detached account referenced.
  const deletedDetached = await controller.fixture.app.fetch(
    new Request(`http://127.0.0.1${accountPath}`, {
      method: "DELETE",
      headers: authenticatedHeaders(controller.fixture.session),
    }),
  );
  assert.equal(deletedDetached.status, 204);

  const unusedAccount = await createServiceAccount(controller, namespace.id, "unused-provider");
  const unusedAccountPath = `/namespaces/${namespace.id}/service-accounts/${unusedAccount.id}`;
  // Successful DELETE is intentionally bodyless, unlike canonical JSON resource responses.
  const deleted = await controller.fixture.app.fetch(
    new Request(`http://127.0.0.1${unusedAccountPath}`, {
      method: "DELETE",
      headers: authenticatedHeaders(controller.fixture.session),
    }),
  );
  assert.equal(deleted.status, 204);
  const missingAccount = await controller.request("GET", unusedAccountPath);
  assert.equal(missingAccount.status, 404);

  const accountEvents = controller.fixture.auditSink.events.filter(
    (event) => event.kind === "mutation" && event.resource.kind === "service_account",
  );
  assert.deepEqual(
    new Set(accountEvents.map(({ action }) => action)),
    new Set([
      "openclaw.service_accounts.create",
      "openclaw.service_accounts.update",
      "openclaw.service_accounts.delete",
    ]),
  );
  assert.deepEqual(accountEvents[0].authorization.resource, {
    kind: "service_account",
    id: namespace.id,
    namespaceId: namespace.id,
  });
  assert.deepEqual(accountEvents.at(-1).authorization.resource, {
    kind: "service_account",
    id: unusedAccount.id,
    namespaceId: namespace.id,
  });
});

test("native ServiceAccounts reject invalid references and enforce exact Namespace-scoped access", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespaceA = await createNamespace(controller, "service-account-namespace-a");
  const namespaceB = await createNamespace(controller, "service-account-namespace-b");
  const accountA = await createServiceAccount(controller, namespaceA.id, "account-a");
  const accountB = await createServiceAccount(controller, namespaceA.id, "account-b");
  const exactAccountPath = `/namespaces/${namespaceA.id}/service-accounts/${accountA.id}`;

  const duplicate = await controller.request(
    "POST",
    `/namespaces/${namespaceA.id}/service-accounts`,
    { body: { name: "account-a" } },
  );
  assert.equal(duplicate.status, 409);

  // Account ownership participates in Namespace emptiness even before any Agent is created.
  const occupiedNamespace = await controller.request("DELETE", `/namespaces/${namespaceA.id}`);
  assert.equal(occupiedNamespace.status, 409);
  assert.equal(occupiedNamespace.body.error.code, "NAMESPACE_NOT_EMPTY");

  for (const invalid of [
    { name: "unrecognized-field", implementation: "native" },
    { name: "cross-namespace", namespaceId: namespaceB.id },
  ]) {
    const rejected = await controller.request(
      "POST",
      `/namespaces/${namespaceA.id}/service-accounts`,
      { body: invalid },
    );
    assert.equal(rejected.status, 400);
  }

  for (const invalid of [
    ...[".", ".."].map((key) => ({ kind: "api_key", secretRef: { name: "valid-source", key } })),
    { kind: "api_key", secretRef: { name: "valid-source", key: "credential", namespace: "other" } },
    { kind: "provider_token", secretRef: { name: "valid-source", key: "credential" } },
  ]) {
    const rejected = await controller.request("PATCH", `${exactAccountPath}/credential`, {
      body: invalid,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
  }

  const credential = { kind: "api_key", secretRef: { name: "account-a-source", key: "api-key" } };
  const assigned = await controller.request("PATCH", `${exactAccountPath}/credential`, {
    body: credential,
  });
  assert.equal(assigned.status, 200);

  // A real account ID never becomes accessible by substituting a sibling Namespace in the URL.
  for (const [method, suffix, options] of [
    ["GET", ""],
    ["PATCH", "/credential", { body: credential }],
    ["DELETE", ""],
  ]) {
    const crossNamespace = await controller.request(
      method,
      `/namespaces/${namespaceB.id}/service-accounts/${accountA.id}${suffix}`,
      options,
    );
    assert.equal(crossNamespace.status, 404);
  }

  const configurationB = await createConfiguration(controller, namespaceB.id);
  const configurationA = await createConfiguration(controller, namespaceA.id);
  const crossNamespaceAssociation = await controller.request(
    "POST",
    `/namespaces/${namespaceB.id}/agents`,
    {
      body: {
        name: "cross-namespace-agent",
        configurationId: configurationB.id,
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: accountA.id },
      },
    },
  );
  assert.equal(crossNamespaceAssociation.status, 404);

  // Namespace-wide Agent authority never substitutes for an exact ServiceAccount binding.
  controller.fixture.state.roles.push(
    {
      id: "role-service-account-namespace-reader",
      namespaceId: namespaceA.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "configuration" },
        { action: "create", resourceKind: "agent" },
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
      ],
    },
    {
      id: "role-exact-service-account-reader",
      namespaceId: namespaceA.id,
      permissions: [{ action: "read", resourceKind: "service_account" }],
    },
  );
  async function exactReader(suffix, accountId) {
    const { principal: identity } = await controller.fixture.createAuthPrincipal(suffix);
    controller.fixture.state.identities.push(identity);
    controller.fixture.state.bindings.push(
      ...["namespace", "account"].map((kind) => ({
        id: `binding-${suffix}-${kind}`,
        namespaceId: namespaceA.id,
        subjectKind: "identity",
        subjectId: identity.id,
        roleId:
          kind === "namespace"
            ? "role-service-account-namespace-reader"
            : "role-exact-service-account-reader",
        ...(kind === "account" ? { resourceKind: "service_account", resourceId: accountId } : {}),
      })),
    );
    return { identity, app: controller.fixture.createApp(identity) };
  }

  const { identity: reader, app: readerApp } = await exactReader(
    "existing-account-reader",
    accountA.id,
  );

  const authorizedAccount = await injectedRequest(readerApp, "GET", exactAccountPath);
  assert.equal(authorizedAccount.status, 200);

  const accountList = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${namespaceA.id}/service-accounts`,
  );
  assert.equal(accountList.status, 200);
  assert.deepEqual(accountList.data, [assigned.data]);
  assert.equal(JSON.stringify(accountList.data).includes(accountB.id), false);
  assert.equal(Object.hasOwn(accountList.data[0], "backendId"), false);

  const denied = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${namespaceA.id}/service-accounts/${accountB.id}`,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  const denial = controller.fixture.auditSink.events.at(-1);
  assert.deepEqual(denial.resource, {
    kind: "service_account",
    id: accountB.id,
    namespaceId: namespaceA.id,
  });
  assert.equal(denial.action, "openclaw.service_accounts.read");

  // Agent creation still needs read permission on its exact associated account, not a sibling.
  const deniedAssociation = await injectedRequest(
    readerApp,
    "POST",
    `/namespaces/${namespaceA.id}/agents`,
    {
      body: {
        name: "denied-account-association",
        configurationId: configurationA.id,
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: accountB.id },
      },
    },
  );
  assert.equal(deniedAssociation.status, 403);
  const deniedAssociationAudit = controller.fixture.auditSink.events.at(-1);
  assert.equal(deniedAssociationAudit.action, "openclaw.agents.create");
  assert.deepEqual(deniedAssociationAudit.authorization, {
    principalId: reader.id,
    action: "read",
    resource: { kind: "service_account", id: accountB.id, namespaceId: namespaceA.id },
  });

  const allowedAssociation = await injectedRequest(
    readerApp,
    "POST",
    `/namespaces/${namespaceA.id}/agents`,
    {
      body: {
        name: "allowed-account-association",
        configurationId: configurationA.id,
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: accountA.id },
      },
    },
  );
  assert.equal(allowedAssociation.status, 201);
  assert.equal(allowedAssociation.data.harnessAuth.serviceAccountId, accountA.id);
  const associatedAgentPath = `/namespaces/${namespaceA.id}/agents/${allowedAssociation.data.id}`;

  // Replacing A with B requires exact read on the new account, not merely authority over A.
  const deniedNewAccount = await injectedRequest(readerApp, "PATCH", associatedAgentPath, {
    body: {
      configurationId: configurationA.id,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: accountB.id },
    },
  });
  assert.equal(deniedNewAccount.status, 403);
  const unchangedAfterNewAccountDenial = await injectedRequest(
    readerApp,
    "GET",
    associatedAgentPath,
  );
  assert.equal(unchangedAfterNewAccountDenial.data.harnessAuth.serviceAccountId, accountA.id);

  const deniedCreation = await injectedRequest(
    readerApp,
    "POST",
    `/namespaces/${namespaceA.id}/service-accounts`,
    { body: { name: "unauthorized-account" } },
  );
  assert.equal(deniedCreation.status, 403);
  assert.deepEqual(controller.fixture.auditSink.events.at(-1).resource, {
    kind: "service_account",
    id: namespaceA.id,
    namespaceId: namespaceA.id,
  });

  // Reading replacement account B cannot authorize detaching or replacing the existing account A.
  const { identity: replacementOnlyReader, app: replacementOnlyApp } = await exactReader(
    "replacement-only-reader",
    accountB.id,
  );

  for (const serviceAccountId of [null, accountB.id]) {
    const deniedOldAccount = await injectedRequest(
      replacementOnlyApp,
      "PATCH",
      associatedAgentPath,
      {
        body: {
          configurationId: configurationA.id,
          harnessAuth:
            serviceAccountId === null
              ? null
              : { method: "chatgpt_service_account", serviceAccountId },
        },
      },
    );
    assert.equal(deniedOldAccount.status, 403);
    const deniedOldAccountAudit = controller.fixture.auditSink.events.at(-1);
    assert.equal(deniedOldAccountAudit.action, "openclaw.agents.update");
    assert.deepEqual(deniedOldAccountAudit.authorization, {
      principalId: replacementOnlyReader.id,
      action: "read",
      resource: {
        kind: "service_account",
        id: accountA.id,
        namespaceId: namespaceA.id,
      },
    });

    const unchanged = await injectedRequest(replacementOnlyApp, "GET", associatedAgentPath);
    assert.equal(unchanged.data.harnessAuth.serviceAccountId, accountA.id);
  }
});

test("session inspection stays optional and never exposes session or credential secrets", async () => {
  const fixture = await createInjectedFixture();

  const anonymous = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    identity: false,
  });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data, null);

  const authenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  assert.equal(authenticated.status, 200);
  assert.notEqual(authenticated.data, null);
  const exposed = JSON.stringify(authenticated.data);
  assert.doesNotMatch(exposed, /token|password|credential/i);
  assert.equal(exposed.includes(fixture.app.defaultSession.cookie), false);
  assert.match(authenticated.data.sessionKey, /^[A-Za-z0-9_-]+$/);

  const repeated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.sessionKey, authenticated.data.sessionKey);
  assert.deepEqual(repeated.data.user, authenticated.data.user);

  const nextSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email: fixture.authFixture.email,
    password: fixture.authFixture.password,
  });
  const nextAuthenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    session: nextSession,
  });
  assert.equal(nextAuthenticated.status, 200);
  assert.notEqual(nextAuthenticated.data.sessionKey, authenticated.data.sessionKey);
  assert.deepEqual(nextAuthenticated.data.user, authenticated.data.user);
});

test("administrator-created auth accounts sign in and receive only provisioned IAM access", async () => {
  let provisionedSeed;
  const fixture = await createInjectedFixture({
    provisionAuthAccount(seed, { installAuthSeed, auditEvent }) {
      provisionedSeed = seed;
      return installAuthSeed(seed, { auditEvent });
    },
  });
  const selectedIAMDriver = fixture.iamDriver;
  const controller = {
    fixture,
    request: (method, pathname, options) => injectedRequest(fixture.app, method, pathname, options),
  };
  await bootstrap(controller, "Provisioned account installation");
  const readOnlyRole = {
    id: "role-read-only-auth-account",
    name: "Read-only auth account",
    permissions: [{ action: "read", resourceKind: "installation" }],
  };
  fixture.state.roles.push(readOnlyRole);

  const missingRole = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: `missing-role-${randomUUID()}@example.com`,
      password: `generated-password-${randomUUID()}`,
      name: "Missing Role Operator",
    },
  });
  assert.equal(missingRole.status, 400);

  const unknownRole = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: `unknown-role-${randomUUID()}@example.com`,
      password: `generated-password-${randomUUID()}`,
      name: "Unknown Role Operator",
      roleId: "role-does-not-exist",
    },
  });
  assert.equal(unknownRole.status, 400);

  const invalidEmail = "invalid-auth-account-email";
  const invalidEmailPassword = `generated-password-${randomUUID()}`;
  const stateCounts = {
    identities: fixture.state.identities.length,
    roles: fixture.state.roles.length,
    bindings: fixture.state.bindings.length,
    auditEvents: fixture.auditSink.events.length,
  };
  const invalidEmailResult = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: invalidEmail,
      password: invalidEmailPassword,
      name: "Invalid Email Operator",
      roleId: readOnlyRole.id,
    },
  });
  assert.equal(invalidEmailResult.status, 400);
  assert.equal(invalidEmailResult.body.error.code, "INVALID_REQUEST");
  assert.deepEqual(
    {
      identities: fixture.state.identities.length,
      roles: fixture.state.roles.length,
      bindings: fixture.state.bindings.length,
      auditEvents: fixture.auditSink.events.length,
    },
    stateCounts,
  );
  await assert.rejects(
    signInWithEmailPassword({
      fetch: fixture.app.fetch.bind(fixture.app),
      email: invalidEmail,
      password: invalidEmailPassword,
    }),
    /HTTP 400/,
  );

  const email = `operator-${randomUUID()}@example.com`;
  const password = `generated-password-${randomUUID()}`;
  const originalAuthorize = selectedIAMDriver.authorize;
  selectedIAMDriver.authorize = async (...args) => {
    const decision = await originalAuthorize.apply(selectedIAMDriver, args);
    if (args[0].action !== "administer") {
      return decision;
    }
    const groupIds = ["original-admin-evidence"];
    groupIds[Symbol.iterator] = () => {
      throw new Error("the audit event must not use the supplied iterator");
    };
    return { ...decision, evidence: { ...decision.evidence, groupIds } };
  };
  const auditCount = fixture.auditSink.events.length;
  const created = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: { email, password, name: "Read Only Operator", roleId: readOnlyRole.id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(fixture.iamDriver, selectedIAMDriver);
  assert.equal(created.data.email, email);
  assert.equal(created.data.name, "Read Only Operator");
  assert.equal(created.data.principalId, provisionedSeed.principal.id);
  assert.deepEqual(provisionedSeed.roles, []);
  assert.deepEqual(
    provisionedSeed.bindings.map(({ roleId }) => roleId),
    [readOnlyRole.id],
  );
  const accountEvents = fixture.auditSink.events.slice(auditCount);
  assert.equal(accountEvents.length, 1);
  assert.equal(accountEvents[0].kind, "mutation");
  assert.equal(accountEvents[0].action, "openclaw.auth.accounts.create");
  assert.deepEqual(accountEvents[0].details?.iamEvidence?.groupIds, ["original-admin-evidence"]);
  assert.deepEqual(accountEvents[0].resource, {
    kind: "installation",
    id: fixture.installationId,
  });

  const secondSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email,
    password,
  });
  const installation = await injectedRequest(fixture.app, "GET", "/installation", {
    session: secondSession,
  });
  assert.equal(installation.status, 200);

  const denied = await injectedRequest(fixture.app, "POST", "/namespaces", {
    session: secondSession,
    body: { name: "denied-account-namespace" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
});

test("OCC Fastify enforces strict schemas, canonical errors, and its real 64 KiB limit", async () => {
  const controller = await configuredController();

  const malformedJson = await controller.request("POST", "/installation/bootstrap", {
    rawBody: "{not-json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error.code, "INVALID_REQUEST");

  const unsupportedType = await controller.request("POST", "/installation/bootstrap", {
    rawBody: "name=enterprise",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(unsupportedType.status, 415);
  assert.equal(unsupportedType.body.error.code, "UNSUPPORTED_MEDIA_TYPE");

  for (const invalid of [null, [], {}, { name: "" }, { name: "   " }]) {
    const result = await controller.request("POST", "/installation/bootstrap", { body: invalid });
    assert.equal(result.status, 400);
  }

  await bootstrap(controller);

  for (const invalid of [null, [], {}, { name: "" }, { name: 4 }]) {
    const result = await controller.request("POST", "/namespaces", {
      body: invalid,
    });
    assert.equal(result.status, 400);
  }

  const namespace = await createNamespace(controller, "validated");
  const duplicateNamespace = await controller.request("POST", "/namespaces", {
    body: { name: "validated" },
  });
  assert.equal(duplicateNamespace.status, 409);
  assert.equal(duplicateNamespace.body.error.code, "RESOURCE_CONFLICT");

  const invalidAgent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "" },
  });
  assert.equal(invalidAgent.status, 400);

  const agent = await createAgent(controller, namespace.id, "valid-agent");
  const duplicateAgent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "valid-agent", configurationId: agent.configurationId },
  });
  assert.equal(duplicateAgent.status, 409);
  assert.equal(duplicateAgent.body.error.code, "RESOURCE_CONFLICT");

  for (const configurationId of [null, [], "invalid"]) {
    const invalidCreation = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: { name: "invalid-configuration-agent", configurationId },
    });
    assert.equal(invalidCreation.status, 400);

    const invalidReplacement = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      { body: { configurationId } },
    );
    assert.equal(invalidReplacement.status, 400);
  }

  for (const body of [{ configuration: {} }, { draft_spec: {} }, {}]) {
    const invalidDeployment = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
      { body },
    );
    assert.equal(invalidDeployment.status, 400);
  }

  for (const key of ["__proto__", "constructor", "prototype"]) {
    const unsafeConfiguration = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        rawBody: `{\"kind\":\"agent\",\"values\":{\"${key}\":\"polluted\"}}`,
        headers: { "content-type": "application/json" },
      },
    );
    assert.equal(unsafeConfiguration.status, 400, key);
    assert.equal(unsafeConfiguration.body.error.code, "INVALID_REQUEST");
  }

  let deeplyNested = {};
  for (let depth = 0; depth < 26; depth += 1) {
    deeplyNested = { nested: deeplyNested };
  }
  const tooDeep = await controller.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: deeplyNested },
  });
  assert.equal(tooDeep.status, 400);
  assert.equal(tooDeep.body.error.details[0]?.code, "TOO_DEEP");

  for (const extra of ["name", "namespaceId", "servicePrincipalId"]) {
    const injected = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      { body: { configurationId: agent.configurationId, [extra]: "injected" } },
    );
    assert.equal(injected.status, 400, extra);
  }

  const foreignInstallation = await controller.request("POST", "/namespaces", {
    body: { name: "foreign", installationId: "installation-foreign" },
  });
  assert.equal(foreignInstallation.status, 400);

  const namespaceOverride = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "foreign",
      configurationId: agent.configurationId,
      namespaceId: "namespace-foreign",
    },
  });
  assert.equal(namespaceOverride.status, 400);

  const unexpectedQuery = await controller.request("GET", "/namespaces?owner=foreign");
  assert.equal(unexpectedQuery.status, 400);
  assert.equal(unexpectedQuery.body.error.code, "INVALID_REQUEST");

  const malformedIdentifier = await controller.request("GET", "/namespaces/ns_not-a-uuid");
  assert.equal(malformedIdentifier.status, 400);

  const wrongResourceKind = await controller.request("GET", `/namespaces/${agent.id}`);
  assert.equal(wrongResourceKind.status, 400);

  const oversized = await controller.request("POST", "/namespaces", {
    body: { name: "x".repeat(64 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");

  // Keep method order and overlapping literal/parameter paths in the public Allow header.
  for (const [method, path, allowed] of [
    ["DELETE", "/namespaces", "POST, GET"],
    [
      "OPTIONS",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      "GET, PATCH, DELETE",
    ],
    ["OPTIONS", `/namespaces/${namespace.id}/agents/${agent.id}/deploy?ignored=true`, "POST"],
    ["OPTIONS", `/namespaces/${namespace.id}/agents/provision`, "POST, PATCH, GET, DELETE"],
  ]) {
    const unsupportedMethod = await controller.request(method, path);
    assert.equal(unsupportedMethod.status, 405);
    assert.equal(unsupportedMethod.body.error.code, "METHOD_NOT_ALLOWED");
    assert.equal(unsupportedMethod.headers.get("allow"), allowed);
  }

  const fixture = await createInjectedFixture();
  const bootstrapped = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Validation-order installation" },
  });
  assert.equal(bootstrapped.status, 201);

  const originalLookup = fixture.iamDriver.lookupIdentity;
  const originalAuthorize = fixture.iamDriver.authorize;
  let identityLookups = 0;
  let authorizationChecks = 0;
  fixture.iamDriver.lookupIdentity = async (...args) => {
    identityLookups += 1;
    return originalLookup.apply(fixture.iamDriver, args);
  };
  fixture.iamDriver.authorize = async (...args) => {
    authorizationChecks += 1;
    return originalAuthorize.apply(fixture.iamDriver, args);
  };
  const auditCount = fixture.auditSink.events.length;

  try {
    for (const options of [
      { rawBody: '{"name":' },
      { body: { name: "invalid-scope", installationId: fixture.installationId } },
    ]) {
      const invalid = await injectedRequest(fixture.app, "POST", "/namespaces", options);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_REQUEST");
      assert.equal(identityLookups, 0);
      assert.equal(authorizationChecks, 0);
      assert.equal(fixture.auditSink.events.length, auditCount);
    }
  } finally {
    fixture.iamDriver.lookupIdentity = originalLookup;
    fixture.iamDriver.authorize = originalAuthorize;
  }

  const untouched = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(untouched);
});

test("Agent provisioning API validates inline configuration with existing Secret references", async () => {
  const fixture = await createInjectedFixture({
    computeDriver: createProvisioningCapableComputeDriver(),
    configurationDriver: createProvisioningCapableConfigurationDriver(),
  });
  const installation = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Provisioning validation installation" },
  });
  assert.equal(installation.status, 201);
  const namespace = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "provisioning-validation" },
  });
  assert.equal(namespace.status, 201);
  await fixture.controller.handleNamespaceLifecycle(
    fixture.principal.id,
    namespace.data.id,
    "ready",
  );
  const modelApiKey = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/secrets`,
    { body: { name: "model-api-key", value: `model-key-${randomUUID()}` } },
  );
  assert.equal(modelApiKey.status, 201, JSON.stringify(modelApiKey.body));
  const toolApiKey = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/secrets`,
    { body: { name: "tool-api-key", value: `tool-key-${randomUUID()}` } },
  );
  assert.equal(toolApiKey.status, 201, JSON.stringify(toolApiKey.body));
  const secrets = { modelApiKey: modelApiKey.data, toolApiKey: toolApiKey.data };

  const foreignNamespaceId = `ns_${randomUUID()}`;
  const foreignSecretId = `sec_${randomUUID()}`;
  const oversizedBindings = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`TOOL_${index}`, { source: toolApiKey.data.ref }]),
  );
  const invalidBodies = [
    [
      "submitted Secret values",
      {
        ...provisioningRequestBody(namespace.data.id, secrets),
        secrets: [{ name: "tool-api-key", value: `tool-key-${randomUUID()}` }],
      },
    ],
    [
      "request-local Secret binding sources",
      provisioningRequestBody(namespace.data.id, secrets, {
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "provisioning-secret", name: "tool-api-key" },
            },
          },
        },
      }),
    ],
    [
      "request-local Harness Secret source",
      provisioningRequestBody(namespace.data.id, secrets, {
        harnessAuth: {
          method: "api_key",
          source: { kind: "provisioning-secret", name: "model-api-key" },
        },
      }),
    ],
    [
      "too many binding destinations",
      provisioningRequestBody(namespace.data.id, secrets, {
        configuration: { secretBindings: oversizedBindings },
      }),
    ],
    [
      "non-env delivery",
      provisioningRequestBody(namespace.data.id, secrets, {
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: toolApiKey.data.ref,
              delivery: { type: "file" },
            },
          },
        },
      }),
    ],
    [
      "cross-Namespace Secret references",
      provisioningRequestBody(namespace.data.id, secrets, {
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "secret", namespaceId: foreignNamespaceId, id: foreignSecretId },
            },
          },
        },
        harnessAuth: { method: "runtime" },
      }),
    ],
    [
      "reserved environment destinations",
      provisioningRequestBody(namespace.data.id, secrets, {
        configuration: {
          secretBindings: {
            OPENCLAW_TOKEN: {
              source: toolApiKey.data.ref,
            },
          },
        },
        harnessAuth: { method: "runtime" },
      }),
    ],
  ];

  for (const [description, body] of invalidBodies) {
    const result = await injectedRequest(
      fixture.app,
      "POST",
      `/namespaces/${namespace.data.id}/agents/provision`,
      { body },
    );
    assert.equal(result.status, 400, description);
    assert.equal(result.body.error.code, "INVALID_REQUEST", description);
  }

  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  // Driver-specific validation must precede durable provisioning and resource creation.
  const invalidPolicy = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/agents/provision`,
    {
      body: provisioningRequestBody(namespace.data.id, secrets, {
        plugins: {
          [linearPluginId]: { enabled: true, tools: { "app/search": { reviewer: "auto" } } },
        },
      }),
    },
  );
  assert.equal(invalidPolicy.status, 400, JSON.stringify(invalidPolicy.body));
  assert.equal(invalidPolicy.body.error.code, "INVALID_REQUEST");
  assert.equal(
    invalidPolicy.body.error.message,
    "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
  );
  assert.deepEqual(
    await fixture.platformState.read((view) => view.agents.listAgents(namespace.data.id)),
    [],
  );

  const durableOnly = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/agents/provision`,
    { body: provisioningRequestBody(namespace.data.id, secrets) },
  );
  assert.equal(durableOnly.status, 503, JSON.stringify(durableOnly.body));
  assert.equal(durableOnly.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(
    await fixture.platformState.read((view) => view.agents.listAgents(namespace.data.id)),
    [],
    "in-memory admission must stop before creating an Agent",
  );

  const oversized = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/agents/provision`,
    {
      rawBody: JSON.stringify(
        provisioningRequestBody(namespace.data.id, secrets, {
          configuration: { values: { payload: "x".repeat(448 * 1024) } },
        }),
      ),
    },
  );
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("bootstrap fails closed when IAM omits structured authorization evidence", async () => {
  const fixture = await createInjectedFixture();
  fixture.iamDriver.authorize = async () => ({
    allowed: true,
    driverId: fixture.iamDriver.id,
  });

  const response = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Must not initialize" },
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(fixture.controller, undefined);
  assert.deepEqual(fixture.auditSink.events, []);
});

test("OCC development subprocess requires PostgreSQL-backed startup", async () => {
  await assertUnsafeStartupRejected();
});

test("bodyless OCC routes reject request payloads before IAM or domain side effects", async () => {
  const fixture = await createInjectedFixture();
  const installation = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Bodyless-route installation" },
  });
  assert.equal(installation.status, 201);

  const namespace = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "bodyless-route-namespace" },
  });
  assert.equal(namespace.status, 201);

  const configuration = await createInjectedConfiguration(fixture, namespace.data.id);
  const agent = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/agents`,
    { body: { name: "bodyless-route-agent", configurationId: configuration.id } },
  );
  assert.equal(agent.status, 201);

  const originalLookup = fixture.iamDriver.lookupIdentity;
  const originalAuthorize = fixture.iamDriver.authorize;
  let identityLookups = 0;
  let authorizationChecks = 0;
  fixture.iamDriver.lookupIdentity = async (...args) => {
    identityLookups += 1;
    return originalLookup.apply(fixture.iamDriver, args);
  };
  fixture.iamDriver.authorize = async (...args) => {
    authorizationChecks += 1;
    return originalAuthorize.apply(fixture.iamDriver, args);
  };
  const auditCount = fixture.auditSink.events.length;
  const app = fixture.createApp(fixture.principal, createFastifyApp);

  try {
    for (const [method, url] of [
      ["GET", "/installation"],
      ["GET", "/namespaces"],
      ["GET", `/namespaces/${namespace.data.id}`],
      ["GET", `/namespaces/${namespace.data.id}/service-accounts`],
      ["GET", `/namespaces/${namespace.data.id}/agents`],
      ["GET", `/namespaces/${namespace.data.id}/agents/${agent.data.id}`],
      ["GET", `/namespaces/${namespace.data.id}/agents/${agent.data.id}/revisions`],
      [
        "GET",
        `/namespaces/${namespace.data.id}/agents/${agent.data.id}/revisions/${missingRevisionId}`,
      ],
      ["POST", `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deploy`],
      ["POST", `/namespaces/${namespace.data.id}/agents/${agent.data.id}/stop`],
    ]) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...authenticatedHeaders(app.defaultSession),
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        payload: JSON.stringify({ unexpected: "request body" }),
        remoteAddress: "127.0.0.1",
      });
      const body = response.json();

      assert.equal(response.statusCode, 400, url);
      assert.equal(body.error.code, "INVALID_REQUEST", url);
      assert.match(body.meta.requestId, identifier("req"));
      assert.equal(identityLookups, 0, url);
      assert.equal(authorizationChecks, 0, url);
      assert.equal(fixture.auditSink.events.length, auditCount, url);
    }
  } finally {
    fixture.iamDriver.lookupIdentity = originalLookup;
    fixture.iamDriver.authorize = originalAuthorize;
    await app.close();
  }
});

test("OCC isolates Namespace ownership and filters collections by exact IAM grants", async () => {
  const controller = await configuredController();
  await bootstrap(controller);

  const namespaceA = await createNamespace(controller, "namespace-a");
  const namespaceB = await createNamespace(controller, "namespace-b");
  const agentA = await createAgent(controller, namespaceA.id, "private-agent-a");
  const agentB = await createAgent(controller, namespaceB.id, "private-agent-b");

  const listedA = await controller.request("GET", `/namespaces/${namespaceA.id}/agents`);
  const listedB = await controller.request("GET", `/namespaces/${namespaceB.id}/agents`);
  assert.deepEqual(listedA.data, [agentA]);
  assert.deepEqual(listedB.data, [agentB]);

  for (const [method, path, options] of [
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}`],
    ["POST", `/namespaces/${namespaceB.id}/agents/${agentA.id}/deploy`],
    ["POST", `/namespaces/${namespaceB.id}/agents/${agentA.id}/stop`],
    [
      "PATCH",
      `/namespaces/${namespaceB.id}/agents/${agentA.id}`,
      { body: { configurationId: agentB.configurationId } },
    ],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}/revisions`],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentA.id}/revisions/${missingRevisionId}`],
    ["GET", `/namespaces/${namespaceB.id}/agents/${agentB.id}/revisions/${missingRevisionId}`],
  ]) {
    const response = await controller.request(method, path, options);
    assert.ok(
      [403, 404].includes(response.status),
      `${method} ${path} must not expose cross-Namespace resources`,
    );
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes("private-agent-a"));
    assert.ok(!serialized.includes("namespace-a-only"));
  }

  const original = await controller.request(
    "GET",
    `/namespaces/${namespaceA.id}/agents/${agentA.id}/revisions`,
  );
  assert.deepEqual(original.data, []);

  const fixture = await createInjectedFixture();
  const bootstrapped = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "IAM-scoped installation" },
  });
  assert.equal(bootstrapped.status, 201);

  const tenantA = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "tenant-a" },
  });
  const tenantB = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "tenant-b" },
  });
  assert.equal(tenantA.status, 201);
  assert.equal(tenantB.status, 201);

  const tenantBConfiguration = await createInjectedConfiguration(fixture, tenantB.data.id);
  const ownAgent = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${tenantB.data.id}/agents`,
    { body: { name: "tenant-b-agent", configurationId: tenantBConfiguration.id } },
  );
  assert.equal(ownAgent.status, 201);

  const { principal: reader } = await fixture.createAuthPrincipal("tenant-b-reader");
  fixture.state.identities.push(reader);
  fixture.state.roles.push({
    id: "role-tenant-b-reader",
    namespaceId: tenantB.data.id,
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent" },
      { action: "read", resourceKind: "agent_revision" },
    ],
  });
  fixture.state.bindings.push({
    id: "binding-tenant-b-reader",
    namespaceId: tenantB.data.id,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: "role-tenant-b-reader",
  });
  const readerApp = fixture.createApp(reader);

  const visibleNamespaces = await injectedRequest(readerApp, "GET", "/namespaces");
  assert.equal(visibleNamespaces.status, 200);
  assert.deepEqual(
    visibleNamespaces.data.map((item) => item.id),
    [tenantB.data.id],
  );

  const visibleAgent = await injectedRequest(
    readerApp,
    "GET",
    `/namespaces/${tenantB.data.id}/agents/${ownAgent.data.id}`,
  );
  assert.equal(visibleAgent.status, 200);

  const { principal: revisionReader } = await fixture.createAuthPrincipal("revision-only-reader");
  fixture.state.identities.push(revisionReader);
  fixture.state.roles.push({
    id: "role-revision-only-reader",
    namespaceId: tenantB.data.id,
    permissions: [{ action: "read", resourceKind: "agent_revision" }],
  });
  fixture.state.bindings.push({
    id: "binding-revision-only-reader",
    namespaceId: tenantB.data.id,
    subjectKind: "identity",
    subjectId: revisionReader.id,
    roleId: "role-revision-only-reader",
  });
  const revisionReaderApp = fixture.createApp(revisionReader);
  const ownRevisionPath = `/namespaces/${tenantB.data.id}/agents/${ownAgent.data.id}/revisions/${missingRevisionId}`;

  const parentDenied = await injectedRequest(
    revisionReaderApp,
    "GET",
    `/namespaces/${tenantB.data.id}/agents/${ownAgent.data.id}`,
  );
  assert.equal(parentDenied.status, 403);

  const exactRevision = await injectedRequest(revisionReaderApp, "GET", ownRevisionPath);
  assert.equal(exactRevision.status, 404);
  assert.equal(exactRevision.body.error.code, "NOT_FOUND");

  const wrongParent = await injectedRequest(
    revisionReaderApp,
    "GET",
    `/namespaces/${tenantA.data.id}/agents/${ownAgent.data.id}/revisions/${missingRevisionId}`,
  );
  assert.equal(wrongParent.status, 404);

  fixture.state.roles.find((role) => role.id === "role-revision-only-reader").permissions.length =
    0;
  const deniedRevisionApp = fixture.createApp(revisionReader);
  const deniedRevision = await injectedRequest(deniedRevisionApp, "GET", ownRevisionPath);
  assert.equal(deniedRevision.status, 403);
  const denialEvent = fixture.auditSink.events.at(-1);
  assert.equal(denialEvent.kind, "authorization_denial");
  assert.equal(denialEvent.action, "openclaw.agent_revisions.read");
  assert.deepEqual(denialEvent.resource, {
    kind: "agent_revision",
    id: missingRevisionId,
    namespaceId: tenantB.data.id,
  });
  assert.deepEqual(denialEvent.authorization, {
    principalId: revisionReader.id,
    action: "read",
    resource: denialEvent.resource,
  });

  const refreshedReaderApp = fixture.createApp(reader);
  for (const [method, pathname, options] of [
    ["GET", `/namespaces/${tenantA.data.id}`],
    ["GET", `/namespaces/${tenantA.data.id}/agents`],
    [
      "POST",
      `/namespaces/${tenantA.data.id}/agents`,
      { body: { name: "unauthorized-agent", configurationId: tenantBConfiguration.id } },
    ],
  ]) {
    const denied = await injectedRequest(refreshedReaderApp, method, pathname, options);
    assert.equal(denied.status, 403, `${method} ${pathname}`);
    assert.equal(denied.body.error.code, "FORBIDDEN");
  }
});

test("two Namespaces become independently ready and deletion tombstones only its exact target", async () => {
  const fixture = await createInjectedFixture();
  await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Lifecycle installation" },
  });
  const namespaceA = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "lifecycle-a" },
  });
  const namespaceB = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "lifecycle-b" },
  });
  assert.equal(namespaceA.data.status, "provisioning");
  assert.equal(namespaceB.data.status, "provisioning");

  const originalConfiguration = await createInjectedConfiguration(fixture, namespaceA.data.id, {
    model: "original",
  });
  const agentA = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.data.id}/agents`,
    { body: { name: "lifecycle-agent-a", configurationId: originalConfiguration.id } },
  );
  assert.equal(agentA.status, 201);
  assert.equal(agentA.data.configurationId, originalConfiguration.id);
  const firstConfiguration = await createInjectedConfiguration(fixture, namespaceA.data.id, {
    model: "first",
    temperature: "0",
  });
  const replacedReference = await injectedRequest(
    fixture.app,
    "PATCH",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}`,
    { body: { configurationId: firstConfiguration.id } },
  );
  assert.equal(replacedReference.status, 200);
  assert.equal(replacedReference.data.configurationId, firstConfiguration.id);
  assert.deepEqual(fixture.computeCalls.ensureNamespace, []);
  const unavailable = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}/deploy`,
  );
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.error.code, "NAMESPACE_NOT_READY");

  await fixture.controller.handleNamespaceLifecycle(
    fixture.principal.id,
    namespaceA.data.id,
    "ready",
  );
  await fixture.controller.handleNamespaceLifecycle(
    fixture.principal.id,
    namespaceB.data.id,
    "ready",
  );
  assert.deepEqual(fixture.computeCalls.ensureNamespace, [namespaceA.data.id, namespaceB.data.id]);

  await bindHarnessKey(fixture, namespaceA.data.id, {
    ...agentA.data,
    configurationId: firstConfiguration.id,
  });
  const readyDeployment = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}/deploy`,
  );
  assert.equal(readyDeployment.status, 202);
  assert.match(readyDeployment.data.id, identifier("rev"));
  assert.deepEqual(Object.keys(readyDeployment.data).sort(), [
    "agentId",
    "backendId",
    "compute",
    "configuration",
    "configurationGeneration",
    "configurationId",
    "configurationKind",
    "createdAt",
    "harness",
    "harnessAuth",
    "id",
    "namespaceId",
    "revision",
  ]);
  assert.equal(readyDeployment.data.configurationId, firstConfiguration.id);
  assert.equal(readyDeployment.data.configurationKind, "agent");
  assert.equal(readyDeployment.data.configurationGeneration, 1);
  assert.deepEqual(
    readyDeployment.data.configuration,
    admitLoggingConfiguration({ model: "first", temperature: "0" }, "info"),
  );
  assert.deepEqual(readyDeployment.data.harness, {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  });
  assert.deepEqual(readyDeployment.data.compute, {
    id: "compute-integration",
    implementation: "deterministic-test",
  });
  assert.equal(readyDeployment.data.revision, 1);
  assert.equal(Object.hasOwn(readyDeployment.data, "servicePrincipalId"), false);

  const secondConfiguration = await createInjectedConfiguration(fixture, namespaceA.data.id, {
    model: "second",
    temperature: "1",
  });
  const nextReference = await injectedRequest(
    fixture.app,
    "PATCH",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}`,
    { body: { configurationId: secondConfiguration.id } },
  );
  assert.equal(nextReference.status, 200);
  const historical = await injectedRequest(
    fixture.app,
    "GET",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}/revisions/${readyDeployment.data.id}`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data, readyDeployment.data);

  const nextDeployment = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}/deploy`,
  );
  assert.equal(nextDeployment.status, 202);
  assert.equal(nextDeployment.data.revision, 2);
  assert.deepEqual(
    nextDeployment.data.configuration,
    admitLoggingConfiguration({ model: "second", temperature: "1" }, "info"),
  );
  const admittedRevisions = await injectedRequest(
    fixture.app,
    "GET",
    `/namespaces/${namespaceA.data.id}/agents/${agentA.data.id}/revisions`,
  );
  assert.deepEqual(admittedRevisions.data, [readyDeployment.data, nextDeployment.data]);
  assert.deepEqual(fixture.computeCalls.ensureNamespace, [namespaceA.data.id, namespaceB.data.id]);

  const deleting = await injectedRequest(
    fixture.app,
    "DELETE",
    `/namespaces/${namespaceB.data.id}`,
  );
  assert.equal(deleting.status, 202);
  assert.equal(deleting.data.status, "deleting");
  const rejectedChild = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceB.data.id}/agents`,
    { body: { name: "too-late", configurationId: firstConfiguration.id } },
  );
  assert.equal(rejectedChild.status, 409);

  await fixture.controller.handleNamespaceLifecycle(
    fixture.principal.id,
    namespaceB.data.id,
    "deleted",
  );
  assert.deepEqual(fixture.computeCalls.deleteNamespace, [namespaceB.data.id]);
  const absent = await injectedRequest(fixture.app, "GET", `/namespaces/${namespaceB.data.id}`);
  assert.equal(absent.status, 404);
  const listed = await injectedRequest(fixture.app, "GET", "/namespaces");
  assert.deepEqual(
    listed.data.map(({ name }) => name),
    [BOOTSTRAP_DEFAULT_NAMESPACE_NAME, "lifecycle-a"],
  );
  const stillReady = await injectedRequest(fixture.app, "GET", `/namespaces/${namespaceA.data.id}`);
  assert.equal(stillReady.data.status, "ready");
});

test("bootstrap, mutations, and denials emit attributable private audit events", async () => {
  const fixture = await createInjectedFixture();
  const originalIAMDriverId = fixture.iamDriver.id;
  const installation = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Audited installation" },
  });
  assert.equal(installation.status, 201);

  const namespace = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "audited-namespace" },
  });
  assert.equal(namespace.status, 201);

  const configuration = await createInjectedConfiguration(fixture, namespace.data.id);
  const agent = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/agents`,
    { body: { name: "audited-agent", configurationId: configuration.id } },
  );
  assert.equal(agent.status, 201);

  // Beginning deletion is an audited mutation in its own right: it is the
  // record that attributes the teardown to the principal who requested it,
  // and it must exist before any resource is destroyed.
  const deletion = await injectedRequest(
    fixture.app,
    "DELETE",
    `/namespaces/${namespace.data.id}/agents/${agent.data.id}`,
  );
  assert.equal(deletion.status, 202);
  assert.equal(deletion.data.status, "deleting");

  const expectedAuditEvents = fixture.auditSink.events.length;
  const unauthenticated = await injectedRequest(fixture.app, "GET", "/installation", {
    identity: false,
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(fixture.auditSink.events.length, expectedAuditEvents);

  const permissions = fixture.state.roles[0].permissions;
  const namespaceCreate = permissions.findIndex(
    (entry) => entry.action === "create" && entry.resourceKind === "namespace",
  );
  permissions.splice(namespaceCreate, 1);
  // Deleting an Agent is destructive and is gated by its own permission rather
  // than riding on update or deploy, so a principal that can change an Agent
  // still cannot tear it down.
  const agentDelete = permissions.findIndex(
    (entry) => entry.action === "delete" && entry.resourceKind === "agent",
  );
  permissions.splice(agentDelete, 1);
  const denialApp = fixture.createApp();
  const unauthorized = await injectedRequest(denialApp, "POST", "/namespaces", {
    body: { name: "never-log-this-request-body" },
  });
  assert.equal(unauthorized.status, 403);

  const deletionDenied = await injectedRequest(
    denialApp,
    "DELETE",
    `/namespaces/${namespace.data.id}/agents/${agent.data.id}`,
  );
  assert.equal(deletionDenied.status, 403);

  const mutationEvents = fixture.auditSink.events.filter((event) =>
    ["bootstrap", "mutation"].includes(event.kind),
  );
  assert.equal(mutationEvents.length, 5);
  assert.deepEqual(
    mutationEvents.map((event) => [event.kind, event.resource.kind]),
    [
      ["bootstrap", "installation"],
      ["mutation", "namespace"],
      ["mutation", "configuration"],
      ["mutation", "agent"],
      ["mutation", "agent"],
    ],
  );
  for (const event of mutationEvents) {
    assert.equal(event.outcome, "success");
    assert.equal(event.installationId, fixture.installationId);
    assert.equal(event.actorId, fixture.principal.id);
    assert.equal(event.actor.principalId, fixture.principal.id);
    assert.equal(event.actor.issuer, fixture.principal.issuer);
    assert.equal(event.actor.subject, fixture.principal.subject);
    assert.match(event.requestId, identifier("req"));
    assert.equal(typeof event.admissionDecisionId, "string");
    assert.equal(event.source, "occ");
    assert.equal(event.iamDriverId, originalIAMDriverId);
  }
  assert.deepEqual(
    mutationEvents.map((event) => event.authorization),
    [
      {
        principalId: fixture.principal.id,
        action: "administer",
        resource: {
          kind: "installation",
          id: fixture.installationId,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "namespace",
          id: fixture.installationId,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "configuration",
          id: namespace.data.id,
          namespaceId: namespace.data.id,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "agent",
          id: namespace.data.id,
          namespaceId: namespace.data.id,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "delete",
        resource: {
          kind: "agent",
          id: agent.data.id,
          namespaceId: namespace.data.id,
        },
      },
    ],
  );

  // Both refusals are audited, so a denied destructive request leaves evidence
  // naming the principal who attempted it.
  const authorizationDenials = fixture.auditSink.events.filter(
    (event) => event.kind === "authorization_denial",
  );
  assert.equal(authorizationDenials.length, 2);
  for (const denial of authorizationDenials) {
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.actor.principalId, fixture.principal.id);
    assert.equal(denial.installationId, fixture.installationId);
    assert.equal(denial.reasonCode, "AUTHORIZATION_DENIED");
  }
  assert.deepEqual(
    authorizationDenials.map((denial) => [
      denial.authorization.action,
      denial.authorization.resource.kind,
    ]),
    [
      ["create", "namespace"],
      ["delete", "agent"],
    ],
  );
  assert.equal(authorizationDenials[1].authorization.resource.id, agent.data.id);

  const recorded = JSON.stringify(fixture.auditSink.events);
  assert.equal(recorded.includes(fixture.session.cookie), false);
  assert.equal(recorded.includes("never-log-this-request-body"), false);
});

test("authorization accepts getter-backed decisions and unrelated function properties", async () => {
  for (const kind of ["getters", "function"]) {
    const fixture = await createInjectedFixture();
    const controller = {
      request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
    };
    await bootstrap(controller, "Decision compatibility");
    const originalAuthorize = fixture.iamDriver.authorize;
    fixture.iamDriver.authorize = async (...args) => {
      const decision = await originalAuthorize.apply(fixture.iamDriver, args);
      if (kind === "function") {
        return { ...decision, extra: () => {} };
      }
      return new (class {
        get allowed() {
          return decision.allowed;
        }
        get reason() {
          return decision.reason;
        }
        get driverId() {
          return decision.driverId;
        }
        get evidence() {
          return decision.evidence;
        }
      })();
    };
    const namespace = await createNamespace(controller, `decision-compatibility-${kind}`);
    assert.ok(namespace.id);
  }
});

test("authorization rejects sparse decision evidence", async () => {
  const fixture = await createInjectedFixture();
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller, "Sparse decision evidence");
  const originalAuthorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async (...args) => {
    const decision = await originalAuthorize.apply(fixture.iamDriver, args);
    if (args[0].action !== "create") {
      return decision;
    }
    return { ...decision, evidence: { ...decision.evidence, groupIds: Array(1) } };
  };
  const response = await controller.request("POST", "/namespaces", {
    body: { name: "sparse-evidence" },
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("deploy audit preserves its authorization decision and rolls back with append failure", async () => {
  let fixture;
  let laterIAMDriver;
  const sharedEvidence = ["matching-restriction"];
  sharedEvidence[Symbol.iterator] = function* () {
    yield "forged-iterator-value";
  };
  const computeDriver = createProvisioningCapableComputeDriver();
  computeDriver.validateHarnessAuth = () => {
    if (fixture.controller.selectedDriver("iam").id === laterIAMDriver.id) {
      return;
    }
    sharedEvidence.push("mutated-after-authorization");
    fixture.controller.registerDriver(laterIAMDriver);
    fixture.controller.selectDriver("iam", laterIAMDriver.id);
  };
  fixture = await createInjectedFixture({ computeDriver, recordOperations: true });
  laterIAMDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => fixture.state },
    { id: "iam-selected-after-deploy-decision" },
  );
  const controller = {
    request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
  };
  await bootstrap(controller, "Deploy audit provenance");
  const namespace = await createNamespace(controller, "deploy-audit-provenance");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  const agent = await createAgent(controller, namespace.id, "decision-bound-agent");
  await bindHarnessKey(fixture, namespace.id, agent);
  const authorizingDriverId = fixture.iamDriver.id;
  const originalAuthorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async (...args) => {
    const decision = await originalAuthorize.apply(fixture.iamDriver, args);
    if (args[0].action !== "deploy") {
      return decision;
    }
    return {
      ...decision,
      evidence: { ...decision.evidence, groupIds: sharedEvidence, restrictionIds: sharedEvidence },
    };
  };
  const auditCount = fixture.auditSink.events.length;

  // Harness validation runs after OCC has checked deploy authorization. Changing
  // Driver selection here proves the audit uses that completed decision.
  const deployed = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.equal(sharedEvidence.length, 2);
  assert.equal(sharedEvidence[0], "matching-restriction");
  assert.equal(sharedEvidence[1], "mutated-after-authorization");
  assert.equal(fixture.controller.selectedDriver("iam").id, laterIAMDriver.id);
  const deployEvents = fixture.auditSink.events
    .slice(auditCount)
    .filter(
      (event) => event.resource.kind === "agent_revision" && event.resource.id === deployed.data.id,
    );
  assert.equal(deployEvents.length, 1);
  assert.equal(deployEvents[0].iamDriverId, authorizingDriverId);
  assert.equal(deployEvents[0].outcome, "success");
  assert.equal(deployEvents[0].decisionReason, undefined);
  assert.deepEqual(deployEvents[0].authorization, {
    principalId: fixture.principal.id,
    action: "deploy",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });
  assert.deepEqual(deployEvents[0].details?.iamEvidence, {
    identityId: fixture.principal.id,
    groupIds: ["matching-restriction"],
    bindingIds: ["binding-admin"],
    roleIds: [fixture.state.roles[0].id],
    restrictionIds: ["matching-restriction"],
  });

  const failedAgent = await createAgent(controller, namespace.id, "audit-failure-agent");
  await bindHarnessKey(fixture, namespace.id, failedAgent);
  const revisionsBefore = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${failedAgent.id}/revisions`,
  );
  assert.deepEqual(revisionsBefore.data, []);
  const workCount = fixture.controller.pendingOperations().length;
  const failureAuditCount = fixture.auditSink.events.length;
  const originalAppend = fixture.auditSink.append;
  fixture.auditSink.append = async () => {
    throw new Error("deploy audit unavailable");
  };
  let failedDeploy;
  try {
    failedDeploy = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${failedAgent.id}/deploy`,
    );
  } finally {
    fixture.auditSink.append = originalAppend;
  }
  assert.equal(failedDeploy.status, 503);
  assert.equal(failedDeploy.body.error.code, "DEPENDENCY_UNAVAILABLE");
  const unchangedRevisions = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${failedAgent.id}/revisions`,
  );
  assert.deepEqual(unchangedRevisions.data, []);
  const unchangedAgent = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${failedAgent.id}`,
  );
  assert.equal(unchangedAgent.data.desiredRuntimeState, "stopped");
  assert.equal(fixture.controller.pendingOperations().length, workCount);
  assert.equal(fixture.auditSink.events.length, failureAuditCount);
});

test("IAM and audit dependency failures fail closed without orphaned state", async () => {
  const bootstrapFailure = await createInjectedFixture();
  const originalBootstrapAppend = bootstrapFailure.auditSink.append;
  bootstrapFailure.auditSink.append = async () => {
    throw new Error("bootstrap audit unavailable");
  };
  let failedBootstrap;
  try {
    failedBootstrap = await injectedRequest(
      bootstrapFailure.app,
      "POST",
      "/installation/bootstrap",
      { body: { name: "must-not-create-an-installation" } },
    );
  } finally {
    bootstrapFailure.auditSink.append = originalBootstrapAppend;
  }
  assert.equal(failedBootstrap.status, 503);
  assert.equal(failedBootstrap.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(bootstrapFailure.auditSink.events, []);

  const absentInstallation = await injectedRequest(bootstrapFailure.app, "GET", "/installation");
  assert.equal(absentInstallation.status, 404);

  const recoveredBootstrap = await injectedRequest(
    bootstrapFailure.app,
    "POST",
    "/installation/bootstrap",
    { body: { name: "recovered installation" } },
  );
  assert.equal(recoveredBootstrap.status, 201);

  const fixture = await createInjectedFixture();
  const bootstrapResult = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Failure-injection installation" },
  });
  assert.equal(bootstrapResult.status, 201);

  const originalAppend = fixture.auditSink.append;
  fixture.auditSink.append = async () => {
    throw new Error("sk-audit-provider-credential-123456789");
  };
  let failedMutation;
  try {
    failedMutation = await injectedRequest(fixture.app, "POST", "/namespaces", {
      body: { name: "must-never-become-visible" },
    });
  } finally {
    fixture.auditSink.append = originalAppend;
  }
  assert.equal(failedMutation.status, 503);
  assert.equal(failedMutation.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failedMutation.body).includes("sk-audit-provider"), false);

  const unchanged = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(unchanged);
  assert.equal(fixture.auditSink.events.length, 1);

  const originalAuthorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async () => {
    throw new Error("sk-iam-provider-credential-123456789");
  };
  let unavailable;
  try {
    unavailable = await injectedRequest(fixture.app, "POST", "/namespaces", {
      body: { name: "must-never-be-authorized" },
    });
  } finally {
    fixture.iamDriver.authorize = originalAuthorize;
  }
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable.body).includes("sk-iam-provider"), false);

  const stillUnchanged = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(stillUnchanged);
});

test("runtime auth admits SSH revisions without source permissions but retains deployment authorization and exact grammar", async () => {
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts: { runtime: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const controller = await configuredController({ computeDriver, recordOperations: true });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "runtime");
  // Namespace provisioning is a prerequisite; this test exercises admission, not SSH transport.
  await controller.fixture.platformState.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configuration = await createConfiguration(
    controller,
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
  );
  // Neither an actor source grant nor an Agent source grant is needed: OCC owns no source.
  for (const resourceKind of ["secret", "service_account"]) {
    for (const action of ["read", "operate"]) {
      controller.fixture.state.restrictions.push({
        id: `deny-runtime-${resourceKind}-${action}`,
        namespaceId: namespace.id,
        resourceKind,
        action,
        effect: "deny",
      });
    }
  }
  const collection = `/namespaces/${namespace.id}/agents`;
  for (const extra of [
    { source: { kind: "secret" } },
    { serviceAccountId: "sa_not_allowed" },
    { value: "never-a-credential" },
    { environmentVariable: "OPENAI_API_KEY" },
  ]) {
    const invalid = await controller.request("POST", collection, {
      body: {
        name: "invalid-runtime",
        configurationId: configuration.id,
        harnessAuth: { method: "runtime", ...extra },
      },
    });
    assert.equal(invalid.status, 400);
  }
  const created = await controller.request("POST", collection, {
    body: {
      name: "Runtime Agent",
      configurationId: configuration.id,
      harnessAuth: { method: "runtime" },
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.harnessAuth, { method: "runtime" });
  const path = `${collection}/${created.data.id}`;
  const deployed = await controller.request("POST", `${path}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.deepEqual(deployed.data.harnessAuth, { method: "runtime" });
  const admitted = await controller.fixture.platformState.read((view) =>
    view.revisions.findRevision(namespace.id, created.data.id, deployed.data.id),
  );
  assert.deepEqual(admitted.harnessAuth, { method: "runtime" });
  const detached = await controller.request("PATCH", path, {
    body: { configurationId: configuration.id, harnessAuth: null },
  });
  assert.equal(detached.status, 200);
  assert.deepEqual(
    (await controller.request("GET", `${path}/revisions/${deployed.data.id}`)).data.harnessAuth,
    { method: "runtime" },
  );
  await controller.request("PATCH", path, {
    body: { configurationId: configuration.id, harnessAuth: { method: "runtime" } },
  });
  controller.fixture.state.restrictions.push({
    id: "deny-runtime-deploy",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: created.data.id,
    action: "deploy",
    effect: "deny",
  });
  assert.equal((await controller.request("POST", `${path}/deploy`)).status, 403);
});
