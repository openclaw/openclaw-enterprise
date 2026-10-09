import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { backendSummariesFromDefinitions } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { reservePort } from "./available-port.mjs";

export const backendFixtures = Object.freeze([
  Object.freeze({
    id: "openai-primary",
    type: "chatgpt",
    configuration: Object.freeze({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      apiKeyPath: "/var/run/secrets/openclaw/backends/openai-primary/api-key",
      credentialTtlSeconds: 3600,
    }),
    drivers: Object.freeze({ service_account: "chatgpt-backend-service-account" }),
  }),
]);

function computeDriver({
  repositoryCredentials = false,
  discoverHarnessModels = async () => [],
  agentProvisioning = false,
  sandboxDriver,
  credentialGatewayDriver,
} = {}) {
  const driver = createTestKubernetesComputeDriver("console-compute", {
    repositoryCredentials,
    sandboxDriver,
    credentialGatewayDriver,
  });

  return Object.assign(driver, {
    implementation: "test-memory-lifecycle",
    // Most Console cases use drafts. Branch-selection tests can retain the actual
    // Compute capability while verifying that their flow avoids the durable queue.
    ...(agentProvisioning ? {} : { agentProvisioning: undefined }),
    // Catalog data is the external Compute boundary; Console/OCC/IAM routes remain real.
    discoverHarnessModels,
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    // The same fixture placement is shared by source management and the Sandbox.
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: `console-${namespace.id}` };
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

export async function createConsoleAppFixture(t, options = {}) {
  const installationId = `ins_${randomUUID()}`;
  // The ports are part of the origins the app is configured with, so hold them until the
  // listeners bind them; a released probe port can be taken by another listener meanwhile.
  const appPort = await reservePort();
  t.after(appPort.release);
  const port = appPort.port;
  const originHost = options.originHost ?? "127.0.0.1";
  const browserReservation = options.https === true ? await reservePort() : null;
  if (browserReservation !== null) {
    t.after(browserReservation.release);
  }
  const browserPort = browserReservation?.port ?? port;
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
  const seed = auth.principalSeed(account, { grant: "administrator" });
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
  // These grant-free accounts are fixture setup. Accounts added later through
  // createAccountWithPolicy are also shareable, because State resolves identities live.
  const provisionedAccounts = [];
  for (const label of options.provisionedPeople ?? []) {
    const personCredentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `console-password-${randomUUID()}`,
      name: label,
    };
    const person = await auth.createAccount(personCredentials);
    const personSeed = auth.principalSeed(person, { roleId: seed.roles[0].id });
    policy.identities.push(personSeed.principal);
    provisionedAccounts.push({ credentials: personCredentials, principal: personSeed.principal });
  }
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const policyUnit = new AsyncLocalStorage();
  class ConsolePlatformState extends InMemoryPlatformState {
    transact(work) {
      // Authorization inside a transaction reads that actual unit, without waiting on itself.
      return super.transact((unit) => policyUnit.run(unit, () => work(unit)));
    }
  }
  const platformState =
    options.state ??
    new ConsolePlatformState({
      auditSink,
      // Live lookup, so people enrolled after construction can be bound like in Postgres.
      resolveIAMIdentity: (identityId) =>
        policy.identities.find((identity) => identity.id === identityId),
    });
  const iamDriver = new NativeIAMDriver(
    {
      async loadNativeIAMState() {
        // The real evaluator reads Roles and bindings committed by the real policy APIs.
        if (options.provisionedPeople === undefined) {
          return policy;
        }
        const readPolicy = async (view) => {
          const namespaces = await view.namespaces.listNamespaces();
          const roles = [];
          const bindings = [];
          const identities = [];
          for (const namespace of namespaces) {
            // Browser-created Agents must participate in the same live IAM evaluation
            // as their browser-created credential grants.
            for (const agent of await view.agents.listAgents(namespace.id)) {
              identities.push({
                id: agent.servicePrincipalId,
                kind: "service_principal",
                namespaceId: agent.namespaceId,
                agentId: agent.id,
              });
            }
            roles.push(...(await view.iamPolicy.listRoles(namespace.id)));
            bindings.push(...(await view.iamPolicy.listAccessBindings(namespace.id)));
          }
          return { roles, bindings, identities };
        };
        const unit = policyUnit.getStore();
        const managed = await (unit ? readPolicy(unit) : platformState.read(readPolicy));
        return {
          ...policy,
          identities: [
            ...policy.identities,
            ...managed.identities.filter(
              (identity) => !policy.identities.some((existing) => existing.id === identity.id),
            ),
          ],
          roles: [...policy.roles, ...managed.roles],
          bindings: [...policy.bindings, ...managed.bindings],
        };
      },
    },
    { id: "console-native-iam" },
  );
  const backends = options.backends ?? backendFixtures;
  const publicOrigin = options.publicOrigin === true ? origin : options.publicOrigin;
  const backendSummaries = Object.hasOwn(options, "backendSummaries")
    ? options.backendSummaries
    : backendSummariesFromDefinitions(backends);
  const secretDriver = Object.hasOwn(options, "secretDriver")
    ? options.secretDriver
    : createTestSecretDriver({ id: "console-secret" });
  let configurationDriver = options.configurationDriver;
  if (
    configurationDriver === undefined &&
    (options.filesystemConfiguration === true || options.defaultPresets?.length)
  ) {
    // Native value validation (Preset seeding, inline credential checks) needs the
    // real storage Driver; the in-memory test Driver accepts any values.
    const root = await mkdtemp(join(tmpdir(), "occ-console-configuration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    configurationDriver = new FilesystemConfigurationDriver(root);
  }
  let controller;
  const appOptions = {
    metrics: options.metrics,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    workspaceFilesAccess: options.workspaceFilesAccess,
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId, ...options.development },
    computeDriver:
      options.computeDriver ??
      computeDriver({
        repositoryCredentials: options.repositoryCredentials === true,
        discoverHarnessModels: options.discoverHarnessModels,
        agentProvisioning: options.agentProvisioning,
        sandboxDriver: options.sandboxDriver,
        credentialGatewayDriver: options.credentialGatewayDriver,
      }),
    configurationDriver:
      configurationDriver ?? createTestConfigurationDriver({ id: "console-configuration" }),
    ...(options.sandboxDriver === undefined ? {} : { sandboxDriver: options.sandboxDriver }),
    ...(secretDriver === undefined || secretDriver === null ? {} : { secretDriver }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(options.observabilityUrl === undefined
      ? {}
      : { observabilityUrl: options.observabilityUrl }),
    ...(options.nativeAdmin === undefined ? {} : { nativeAdmin: options.nativeAdmin }),
    ...(options.agentRuntimeLogs === undefined
      ? {}
      : { agentRuntimeLogs: options.agentRuntimeLogs }),
    ...(options.nativeAdminGatewayApiKey === undefined
      ? {}
      : { nativeAdminGatewayApiKey: options.nativeAdminGatewayApiKey }),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: platformState,
        ...(options.now === undefined ? {} : { now: options.now }),
        recordOperations: options.recordOperations ?? false,
        backends,
        defaultPresets: options.defaultPresets ?? [],
        bundledPresetVersions: options.bundledPresetVersions ?? [],
        refreshBundledDefaultPresets: options.refreshBundledDefaultPresets === true,
        ...(options.nativeWorkerSupport === undefined
          ? {}
          : { nativeWorkerSupport: options.nativeWorkerSupport }),
      });
      const modelBackends = backends.filter((backend) => backend.type === "chatgpt");
      if (modelBackends.length > 0) {
        const unexpectedBackendCall = async () =>
          assert.fail("Console read tests must not call Backend clients or provision accounts.");
        for (const backend of modelBackends) {
          controller.registerDriver({
            id: backend.drivers.service_account,
            capability: "service_account",
            implementation: "backend-read-test",
            backendId: backend.id,
            create: unexpectedBackendCall,
            createCredential: unexpectedBackendCall,
            delete: unexpectedBackendCall,
          });
        }
        controller.selectDriver("service_account", modelBackends[0].drivers.service_account);
      }
      return controller;
    },
  };
  if (backendSummaries !== undefined) {
    appOptions.backendSummaries = backendSummaries;
  }
  const app = createFastifyApp(appOptions);
  if (options.onSend) {
    app.addHook("onSend", options.onSend);
  }
  await app.listen({ host: "127.0.0.1", port, reusePort: appPort.reusePort });
  await appPort.release();
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
    ingress.listen({
      port: browserPort,
      host: "127.0.0.1",
      reusePort: browserReservation.reusePort,
    });
    await once(ingress, "listening");
    await browserReservation.release();
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
      headers:
        session === null
          ? headers
          : authenticatedHeaders(session, { origin: new URL(authBaseURL).origin, ...headers }),
      body,
    });
    const payload = result.response.status === 204 ? {} : parseJson(result);
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

  function grantAgentSecretOperate(agent, source) {
    const roleId = `auth-${agent.id}`;
    policy.identities.push({
      id: agent.servicePrincipalId,
      kind: "service_principal",
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    policy.roles.push({
      id: roleId,
      namespaceId: agent.namespaceId,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    policy.bindings.push({
      id: roleId,
      namespaceId: agent.namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId,
      resourceKind: "secret",
      resourceId: source.id,
    });
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
        ...(options.backendId === undefined ? {} : { backendId: options.backendId }),
        harnessAuth,
        ...(options.credentialSources === undefined
          ? {}
          : { credentialSources: options.credentialSources }),
        ...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
      },
    });
    assert.equal(agent.status, 201);
    if (harnessAuth?.method === "api_key") {
      grantAgentSecretOperate(agent.data, harnessAuth.source);
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
    provisionedAccounts,
    policy,
    // The real Native IAM Driver, for tests that simulate an IAM outage at its boundary.
    iamDriver,
    rawRequest,
    request,
    signIn,
    bootstrap,
    createNamespace,
    createConfiguration,
    updateConfiguration,
    createAgent,
    grantAgentSecretOperate,
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
