import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { providerSummariesFromDefinitions } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

export const providerFixtures = Object.freeze([
  Object.freeze({
    id: "openai-primary",
    type: "chatgpt",
    configuration: Object.freeze({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      apiKeyPath: "/var/run/secrets/openclaw/providers/openai-primary/api-key",
      credentialTtlSeconds: 3600,
    }),
    drivers: Object.freeze({ service_account: "chatgpt-provider-service-account" }),
  }),
]);

function computeDriver() {
  return {
    id: "console-compute",
    capability: "compute",
    implementation: "test-memory-lifecycle",
    validateHarnessAuth: KubernetesComputeDriver.prototype.validateHarnessAuth,
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
  };
}

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

export async function createConsoleAppFixture(t, options = {}) {
  const installationId = `ins_${randomUUID()}`;
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  // CUA fault-injection keeps Better Auth on the trusted browser origin.
  const authBaseURL = options.authBaseURL ?? origin;
  const authMode = options.authMode ?? "development";
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    installationId,
    mode: authMode,
    baseURL: authBaseURL,
    secret: `console-test-secret-${randomUUID()}-${randomUUID()}`,
    memoryDatabase,
  });
  const credentials = {
    email: `console-admin-${randomUUID()}@example.com`,
    password: `console-password-${randomUUID()}`,
    name: "Console Administrator",
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const policy = {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    roles: seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((item) => ({ ...item })),
    })),
    bindings: seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "console-native-iam" },
  );
  const providers = options.providers ?? providerFixtures;
  const providerSummaries = Object.hasOwn(options, "providerSummaries")
    ? options.providerSummaries
    : providerSummariesFromDefinitions(providers);
  const platformState = options.state ?? new InMemoryPlatformState({ auditSink });
  const secretDriver = Object.hasOwn(options, "secretDriver")
    ? options.secretDriver
    : createTestSecretDriver({ id: "console-secret" });
  let controller;
  const appOptions = {
    auth,
    iamDriver,
    auditSink,
    development: options.development ?? { enabled: true, installationId },
    computeDriver: options.computeDriver ?? computeDriver(),
    configurationDriver: createTestConfigurationDriver({ id: "console-configuration" }),
    ...(secretDriver === undefined || secretDriver === null ? {} : { secretDriver }),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: platformState,
        recordOperations: false,
        providers,
      });
      if (providers.length > 0) {
        const unexpectedProviderCall = async () =>
          assert.fail("Console read tests must not call Provider clients or provision accounts.");
        for (const provider of providers) {
          controller.registerDriver({
            id: provider.drivers.service_account,
            capability: "service_account",
            implementation: "provider-read-test",
            providerId: provider.id,
            create: unexpectedProviderCall,
            createCredential: unexpectedProviderCall,
            delete: unexpectedProviderCall,
          });
        }
        controller.selectDriver("service_account", providers[0].drivers.service_account);
      }
      return controller;
    },
  };
  if (providerSummaries !== undefined) {
    appOptions.providerSummaries = providerSummaries;
  }
  const app = createFastifyApp(appOptions);
  await app.listen({ host: "127.0.0.1", port });
  const cleanupBeforeAppClose = [];
  let appClosed = false;

  function registerCleanupBeforeAppClose(cleanup) {
    cleanupBeforeAppClose.push(cleanup);
  }

  async function close() {
    if (appClosed) {
      return;
    }
    appClosed = true;
    let cleanupError;
    try {
      for (const cleanup of cleanupBeforeAppClose) {
        try {
          await cleanup();
        } catch (error) {
          cleanupError ??= error;
        }
      }
    } finally {
      try {
        await app.close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }

  t.after(close);

  async function rawRequest(method, path, { headers = {}, body, timeout = 5000 } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return { response, text };
  }

  function parseJson(result) {
    assert.match(result.response.headers.get("content-type") ?? "", /application\/json/i);
    const payload = JSON.parse(result.text);
    assert.match(payload.meta?.requestId ?? "", /^req_[0-9a-f-]+$/);
    assert.equal(result.response.headers.get("x-request-id"), payload.meta.requestId);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
    return payload;
  }

  async function signIn(overrides = {}) {
    return signInWithEmailPassword({ origin, ...credentials, ...overrides });
  }

  const adminSession = await signIn();

  async function request(method, path, { session = adminSession, headers = {}, body } = {}) {
    const result = await rawRequest(method, path, {
      headers: session === null ? headers : authenticatedHeaders(session, headers),
      body,
    });
    const payload = parseJson(result);
    return {
      status: result.response.status,
      headers: result.response.headers,
      body: payload,
      data: payload.data,
    };
  }

  async function bootstrap(name = "Console test Installation") {
    const result = await request("POST", "/installation/bootstrap", { body: { name } });
    assert.equal(result.status, 201);
    return result.data;
  }

  async function createNamespace(name, { ready = false } = {}) {
    const result = await request("POST", "/namespaces", { body: { name } });
    assert.equal(result.status, 201);
    if (ready) {
      await makeNamespaceReady(result.data.id);
    }
    return ready ? (await request("GET", `/namespaces/${result.data.id}`)).data : result.data;
  }

  async function makeNamespaceReady(namespaceId) {
    assert.ok(controller, "bootstrap must create the controller before Namespace lifecycle runs");
    const updated = await controller.handleNamespaceLifecycle(
      seed.principal.id,
      namespaceId,
      "ready",
    );
    assert.equal(updated?.status, "ready");
    return updated;
  }

  async function createConfiguration(namespaceId, values = {}, options = {}) {
    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: {
        kind: "agent",
        values,
        ...(options.secretBindings === undefined ? {} : { secretBindings: options.secretBindings }),
      },
    });
    assert.equal(configuration.status, 201);
    return configuration.data;
  }

  async function updateConfiguration(namespaceId, configurationId, values = {}, options = {}) {
    const configuration = await request(
      "PATCH",
      `/namespaces/${namespaceId}/configurations/${configurationId}`,
      {
        body: {
          values,
          ...(options.secretBindings === undefined
            ? {}
            : { secretBindings: options.secretBindings }),
        },
      },
    );
    assert.equal(configuration.status, 200);
    return configuration.data;
  }

  async function createAgent(namespaceId, name, values = {}, options = {}) {
    const configuration = await createConfiguration(namespaceId, values, {
      secretBindings: options.secretBindings,
    });
    const namespace = await request("GET", `/namespaces/${namespaceId}`);
    const harnessAuth =
      options.harnessAuth === undefined && secretDriver && namespace.data.status === "ready"
        ? {
            method: "api_key",
            source: (
              await createSecret(namespaceId, `Auth ${name}`, `test-api-key-${randomUUID()}`)
            ).ref,
          }
        : (options.harnessAuth ?? null);
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      body: {
        name,
        configurationId: configuration.id,
        ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
        harnessAuth,
        ...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
      },
    });
    assert.equal(agent.status, 201);
    if (harnessAuth?.method === "api_key") {
      const servicePrincipalId = `service-agent-${agent.data.id}`;
      const roleId = `auth-${agent.data.id}`;
      policy.identities.push({
        id: servicePrincipalId,
        kind: "service_principal",
        namespaceId,
        agentId: agent.data.id,
      });
      policy.roles.push({
        id: roleId,
        namespaceId,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
      policy.bindings.push({
        id: roleId,
        namespaceId,
        subjectKind: "identity",
        subjectId: servicePrincipalId,
        roleId,
        resourceKind: "secret",
        resourceId: harnessAuth.source.id,
      });
    }
    return agent.data;
  }

  async function updateAgent(namespaceId, agentId, body) {
    const agent = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      body,
    });
    assert.equal(agent.status, 200);
    return agent.data;
  }

  async function deployAgent(namespaceId, agentId) {
    const revision = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
    assert.equal(revision.status, 202, JSON.stringify(revision.body));
    return revision.data;
  }

  async function activateRevision(namespaceId, agentId, revisionId, expectedRevisionId) {
    assert.ok(controller, "bootstrap must create the controller before revision activation");
    // This renders a valid admitted active revision for console tests; runtime dispatch,
    // worker lease handling, and Compute Driver effects are proved by worker tests.
    const active = await platformState.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespaceId, agentId, expectedRevisionId, revisionId),
    );
    assert.ok(active, "the admitted Agent revision must activate from the expected state");
    return active;
  }

  async function seedActiveAgentRevision(namespaceId, agentId, expectedRevisionId) {
    const revision = await deployAgent(namespaceId, agentId);
    const agent = await activateRevision(namespaceId, agentId, revision.id, expectedRevisionId);
    return { agent, revision };
  }

  async function createSecret(namespaceId, name, value) {
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      body: { name, value },
    });
    assert.equal(secret.status, 201);
    return secret.data;
  }

  async function createAccountWithPolicy(label, configurePolicy) {
    const accountCredentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `console-password-${randomUUID()}`,
      name: label,
    };
    const created = await auth.createAccount(accountCredentials);
    const createdSeed = auth.principalSeed(created, { roleId: seed.roles[0].id });
    policy.identities.push(createdSeed.principal);
    configurePolicy(createdSeed.principal);
    return { credentials: accountCredentials, principal: createdSeed.principal };
  }

  return {
    origin,
    credentials,
    memoryDatabase,
    policy,
    rawRequest,
    request,
    signIn,
    bootstrap,
    createNamespace,
    createConfiguration,
    updateConfiguration,
    createAgent,
    updateAgent,
    deployAgent,
    activateRevision,
    seedActiveAgentRevision,
    createSecret,
    createAccountWithPolicy,
    registerCleanupBeforeAppClose,
  };
}
