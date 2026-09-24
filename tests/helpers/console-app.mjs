import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { providerSummariesFromDefinitions } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";

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

function computeDriver({
  repositoryCredentials = false,
  discoverHarnessModels = async () => [],
} = {}) {
  const driver = createTestKubernetesComputeDriver("console-compute", { repositoryCredentials });

  return Object.assign(driver, {
    implementation: "test-memory-lifecycle",
    // In-memory State has no durable provisioning queue; this fixture supports draft creation.
    agentProvisioning: undefined,
    // Catalog data is the external Compute boundary; Console/OCC/IAM routes remain real.
    discoverHarnessModels,
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
  });
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
  const originHost = options.originHost ?? "127.0.0.1";
  const browserPort = options.https === true ? await availableLoopbackPort() : port;
  const origin = `${options.https === true ? "https" : "http"}://${originHost}:${browserPort}`;
  const browserArgs = [];
  const transportOrigin = `http://127.0.0.1:${port}`;
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
    ...(options.authCookieDomain === undefined
      ? {}
      : { sharedCookieDomain: options.authCookieDomain }),
    ...(options.authSecureCookies === undefined
      ? {}
      : { secureCookies: options.authSecureCookies }),
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
  const publicOrigin = options.publicOrigin === true ? origin : options.publicOrigin;
  const providerSummaries = Object.hasOwn(options, "providerSummaries")
    ? options.providerSummaries
    : providerSummariesFromDefinitions(providers);
  const platformState = options.state ?? new InMemoryPlatformState({ auditSink });
  const secretDriver = Object.hasOwn(options, "secretDriver")
    ? options.secretDriver
    : createTestSecretDriver({ id: "console-secret" });
  let controller;
  const appOptions = {
    metrics: options.metrics,
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId, ...options.development },
    computeDriver:
      options.computeDriver ??
      computeDriver({
        repositoryCredentials: options.repositoryCredentials === true,
        discoverHarnessModels: options.discoverHarnessModels,
      }),
    configurationDriver:
      options.configurationDriver ?? createTestConfigurationDriver({ id: "console-configuration" }),
    ...(secretDriver === undefined || secretDriver === null ? {} : { secretDriver }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(options.nativeAdmin === undefined ? {} : { nativeAdmin: options.nativeAdmin }),
    ...(options.nativeAdminGatewayApiKey === undefined
      ? {}
      : { nativeAdminGatewayApiKey: options.nativeAdminGatewayApiKey }),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: platformState,
        recordOperations: options.recordOperations ?? false,
        providers,
        defaultPresets: options.defaultPresets ?? [],
      });
      const modelProviders = providers.filter((provider) => provider.type === "chatgpt");
      if (modelProviders.length > 0) {
        const unexpectedProviderCall = async () =>
          assert.fail("Console read tests must not call Provider clients or provision accounts.");
        for (const provider of modelProviders) {
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
        controller.selectDriver("service_account", modelProviders[0].drivers.service_account);
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

  if (options.https === true) {
    // Exercise browser Secure/Domain cookies through a real TLS ingress to the HTTP API.
    const directory = await mkdtemp(join(tmpdir(), "openclaw-console-tls-"));
    cleanupBeforeAppClose.push(() => rm(directory, { recursive: true, force: true }));
    const keyPath = join(directory, "tls.key");
    const certPath = join(directory, "tls.crt");
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        `/CN=${originHost}`,
        "-addext",
        `subjectAltName=DNS:${originHost}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
    const cert = await readFile(certPath);
    const ingress = createHttpsServer(
      { key: await readFile(keyPath), cert },
      (incoming, outgoing) => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            method: incoming.method,
            path: incoming.url,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode, response.headers);
            response.pipe(outgoing);
          },
        );
        upstream.on("error", () => outgoing.writeHead(502).end());
        incoming.pipe(upstream);
      },
    );
    cleanupBeforeAppClose.push(async () => {
      ingress.closeAllConnections();
      await new Promise((resolve, reject) =>
        ingress.close((error) => (error ? reject(error) : resolve())),
      );
    });
    ingress.listen(browserPort, "127.0.0.1");
    await once(ingress, "listening");
    const spki = createHash("sha256")
      .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
    browserArgs.push(`--ignore-certificate-errors-spki-list=${spki}`);
  }

  async function rawRequest(method, path, { headers = {}, body, timeout = 5000 } = {}) {
    const response = await fetch(`${transportOrigin}${path}`, {
      method,
      headers: {
        host: new URL(origin).host,
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

  async function fetchThroughLoopback(request) {
    const url = new URL(request.url);
    return fetch(`${transportOrigin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers),
        host: url.host,
      },
      ...(request.body === null ? {} : { body: Buffer.from(await request.arrayBuffer()) }),
      signal: request.signal,
    });
  }

  async function signIn(overrides = {}) {
    return signInWithEmailPassword({
      origin,
      fetch: fetchThroughLoopback,
      ...credentials,
      ...overrides,
    });
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
    browserArgs,
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
    app,
    get controller() {
      return controller;
    },
  };
}
