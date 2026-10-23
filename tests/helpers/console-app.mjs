import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { after } from "node:test";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerAuth } from "./password-hasher.mjs";
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
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.mjs";

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
  channelRuntime = false,
  discoverHarnessModels = async () => [],
  agentProvisioning = false,
  sandboxDriver,
  credentialGatewayDriver,
} = {}) {
  const driver = createTestKubernetesComputeDriver("console-compute", {
    repositoryCredentials,
    sandboxDriver,
    credentialGatewayDriver,
    channelRuntime,
  });

  return Object.assign(driver, {
    implementation: "test-memory-lifecycle",
    // A channel runtime needs runtime storage, whose Agent runtime credentials this fixture
    // does not provision unless repository credentials ask for them.
    ...(channelRuntime && !repositoryCredentials
      ? { requiresAgentRuntimeCredentials: undefined }
      : {}),
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

function spkiHash(cert) {
  return createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
}

/** The Chromium flag that accepts exactly these leaf certificates (PEM), by public key. */
export function chromiumTrustArg(certs) {
  return `--ignore-certificate-errors-spki-list=${certs.map(spkiHash).join(",")}`;
}

/**
 * A TLS ingress on 127.0.0.1:`port` that forwards every request to the HTTP listener on
 * 127.0.0.1:`upstreamPort`, as a production ingress would. `tls` ({ key, cert }, PEM) is the
 * leaf to serve; without it a one-day self-signed leaf for `originHost` is made with openssl.
 * Returns the leaf, the Chromium flag that trusts it, and close().
 */
export async function startHttpsIngress({
  port,
  upstreamPort,
  originHost = "127.0.0.1",
  tls,
  reusePort = false,
}) {
  let key = tls?.key;
  let cert = tls?.cert;
  if (tls === undefined) {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-console-tls-"));
    try {
      const keyPath = join(directory, "tls.key");
      const certPath = join(directory, "tls.crt");
      await writeFile(keyPath, sharedRsaPrivateKeyPem("console-ingress"), { mode: 0o600 });
      const generated = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-key",
          keyPath,
          "-days",
          "1",
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
      key = await readFile(keyPath);
      cert = await readFile(certPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const ingress = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
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
  });
  ingress.listen({ port, host: "127.0.0.1", reusePort });
  await once(ingress, "listening");
  return {
    cert,
    browserArg: chromiumTrustArg([cert]),
    async close() {
      ingress.closeAllConnections();
      await new Promise((resolve, reject) =>
        ingress.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// One app for every test in a file, for tests that need no fresh database (CI runs each file in
// its own process). Call it at the top level of a test file: it returns `fileApp(t)`, which
// creates and bootstraps the app on first use and closes it after the file's last test. Building
// the app, creating its administrator account (a password hash), signing in (a password check)
// and the bootstrap cost about 0.3 CPU-s a test.
//
// Tests that share the app share its database, so each test must make its own Namespace (under a
// name no other test in the file uses) and read only what it made. A test keeps
// createConsoleAppFixture when it checks first-run or empty state, the Namespace list or the
// default Namespace selection; signs the administrator out or expires or deletes sessions
// (fixture.memoryDatabase); registers or selects controller Drivers; changes fixture.iamDriver;
// reads the audit sink; uses the bootstrap result; or needs fixture options of its own. The
// fixture's IAM policy (fixture.policy: identities, Roles, bindings, restrictions) is restored
// before and after each test, so what a test adds there does not reach later tests. Browser
// pages for the file app close when their test ends (newPage), and login() signs them in with one
// session shared by the file.
export function fileConsoleApp(options = {}) {
  const cleanups = [];
  let startPolicy;
  let created;
  after(async () => {
    await created?.catch(() => {});
    let cleanupError;
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  });
  return async function fileApp(t) {
    if (created === undefined) {
      const creating = (async () => {
        const fixture = await createConsoleAppFixture(
          { after: (cleanup) => cleanups.push(cleanup) },
          options,
        );
        await fixture.bootstrap();
        fixture.sharedByFile = true;
        startPolicy = structuredClone(fixture.policy);
        return fixture;
      })();
      // A failed start fails only the test that asked for it; the next test starts a new app,
      // as each test did with an app of its own. The partial app's cleanups still run after.
      creating.catch(() => {
        if (created === creating) {
          created = undefined;
        }
      });
      created = creating;
    }
    const fixture = await created;
    // The policy as the app started, restored before and after each test: a test body still
    // running after its end (a timeout, an unawaited promise) cannot carry its changes into the
    // next test.
    const restorePolicy = () => {
      for (const [key, value] of Object.entries(structuredClone(startPolicy))) {
        fixture.policy[key].splice(0, Infinity, ...value);
      }
    };
    restorePolicy();
    t.after(restorePolicy);
    return fixture;
  };
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
    restrictions: /** @type {import("../../packages/contracts/src/index.ts").Restriction[]} */ ([]),
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
  const basePlatformState =
    options.state ??
    new ConsolePlatformState({
      preparedTokenProof: options.preparedTokenProof,
      auditSink,
      // Live lookup, so people enrolled after construction can be bound like in Postgres.
      resolveIAMIdentity: (identityId) =>
        policy.identities.find((identity) => identity.id === identityId),
    });
  const platformState = options.wrapState?.(basePlatformState) ?? basePlatformState;
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
          const principals = [];
          for (const namespace of namespaces) {
            principals.push(...(await view.iamPolicy.listServicePrincipals(namespace.id)));
            principals.push(
              ...(await view.agents.listAgents(namespace.id)).map((agent) => ({
                id: agent.servicePrincipalId,
                namespaceId: agent.namespaceId,
                agentId: agent.id,
                kind: "service_principal",
              })),
            );
            roles.push(...(await view.iamPolicy.listRoles(namespace.id)));
            bindings.push(...(await view.iamPolicy.listAccessBindings(namespace.id)));
          }
          return { roles, bindings, principals };
        };
        const unit = policyUnit.getStore();
        const managed = await (unit ? readPolicy(unit) : platformState.read(readPolicy));
        return {
          ...policy,
          identities: [
            ...policy.identities,
            ...managed.principals.filter(
              (principal) => !policy.identities.some((identity) => identity.id === principal.id),
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
        channelRuntime: options.channelRuntime === true,
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
    ...(options.consoleTheme === undefined ? {} : { consoleTheme: options.consoleTheme }),
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
        preparedTokens: options.preparedTokens,
        sandboxNetworkPolicyCeiling: options.sandboxNetworkPolicyCeiling,
        driverConfigurations: options.driverConfigurations,
        ...(options.now === undefined ? {} : { now: options.now }),
        recordOperations: options.recordOperations ?? false,
        backends,
        defaultPresets: options.defaultPresets ?? [],
        bundledPresetVersions: options.bundledPresetVersions ?? [],
        refreshBundledDefaultPresets: options.refreshBundledDefaultPresets === true,
        ...(options.nativeWorkerSupport === undefined
          ? {}
          : { nativeWorkerSupport: options.nativeWorkerSupport }),
        ...(options.credentialProxyCapacity === undefined
          ? {}
          : { credentialProxyCapacity: options.credentialProxyCapacity }),
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
    const ingress = await startHttpsIngress({
      port: browserPort,
      upstreamPort: port,
      originHost,
      reusePort: browserReservation.reusePort,
    });
    await browserReservation.release();
    cleanupBeforeAppClose.push(ingress.close);
    browserArgs.push(ingress.browserArg);
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

  /**
   * @param {string} method
   * @param {string} path
   * @param {{session?: typeof adminSession | null, headers?: Record<string, string>, body?: unknown}} [options]
   */
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

  // The listed bindings createAgent adds for each Agent's model credential (finding 2260).
  const modelGrantBindingIds = new Set();

  // Grants the Agent operate on one Secret, as an Installation administrator's console does. The
  // Agent's service principal and its role are added on the first grant; a repeat changes nothing.
  // The evaluator reads this fixture policy, while the Namespace's IAM API lists only what it
  // stored, so a `listed` grant is also written through that API: the console's policy reads
  // then see it, as they see a production grant (finding 1920).
  async function grantAgentSecretOperate(
    agent,
    source,
    { listed = true, modelGrant = false } = {},
  ) {
    const roleId = `auth-${agent.id}`;
    const bindingId = `${roleId}-${source.id}`;
    if (policy.bindings.some((binding) => binding.id === bindingId)) {
      return;
    }
    if (!policy.identities.some((identity) => identity.id === agent.servicePrincipalId)) {
      policy.identities.push({
        id: agent.servicePrincipalId,
        kind: "service_principal",
        namespaceId: agent.namespaceId,
        agentId: agent.id,
      });
    }
    if (!policy.roles.some((role) => role.id === roleId)) {
      policy.roles.push({
        id: roleId,
        namespaceId: agent.namespaceId,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
    }
    policy.bindings.push({
      id: bindingId,
      namespaceId: agent.namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId,
      resourceKind: "secret",
      resourceId: source.id,
    });
    if (listed) {
      const binding = await listSecretOperate(agent, source);
      if (modelGrant) {
        modelGrantBindingIds.add(binding.id);
      }
    }
  }

  // The Namespace's listed access bindings, without the model-credential grants createAgent
  // lists: what the console or the test itself granted since.
  async function addedAccessBindings(namespaceId) {
    const bindings = await request("GET", `/namespaces/${namespaceId}/iam/access-bindings`);
    assert.equal(bindings.status, 200, JSON.stringify(bindings.body));
    return bindings.data.filter(({ id }) => !modelGrantBindingIds.has(id));
  }

  async function listSecretOperate(agent, source) {
    const iamPath = `/namespaces/${agent.namespaceId}/iam`;
    const permissions = [{ action: "operate", resourceKind: "secret" }];
    const roles = await request("GET", `${iamPath}/roles`);
    assert.equal(roles.status, 200, JSON.stringify(roles.body));
    let listedRole = roles.data.find(({ name }) => name === "Fixture Agent Secret operate");
    if (!listedRole) {
      const created = await request("POST", `${iamPath}/roles`, {
        body: { name: "Fixture Agent Secret operate", permissions },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      listedRole = created.data;
    }
    const binding = await request("POST", `${iamPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: listedRole.id,
        resourceKind: "secret",
        resourceId: source.id,
      },
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    return binding.data;
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
    // An Installation administrator's console reads the model credential's grant as it reads bound
    // channel Secrets' grants, so it is listed too (finding 2260).
    if (harnessAuth?.method === "api_key") {
      await grantAgentSecretOperate(agent.data, harnessAuth.source, { modelGrant: true });
    }
    // The console grants the Agent each Secret its Configuration binds when it binds it.
    for (const { source } of Object.values(options.secretBindings ?? {})) {
      if (source?.kind === "secret") {
        await grantAgentSecretOperate(agent.data, source);
      }
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

  /**
   * @param {string} label
   * @param {(principal: import("../../packages/contracts/src/index.ts").Principal) => void} configurePolicy
   */
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

  /**
   * A Namespace member: an account whose one Role in `namespaceId` holds exactly `grants`, as
   * [action, resourceKind] pairs. It has no Installation access.
   * @param {string} label
   * @param {string} namespaceId
   * @param {readonly (readonly [
   *   import("../../packages/contracts/src/index.ts").Permission["action"],
   *   import("../../packages/contracts/src/index.ts").Permission["resourceKind"],
   * ])[]} grants
   */
  function createNamespaceMember(label, namespaceId, grants) {
    return createAccountWithPolicy(label, (principal) => {
      policy.roles.push({
        id: `role-${label}`,
        namespaceId,
        permissions: grants.map(([action, resourceKind]) => ({ action, resourceKind })),
      });
      policy.bindings.push({
        id: `binding-${label}`,
        namespaceId,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: `role-${label}`,
      });
    });
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
    addedAccessBindings,
    updateAgent,
    deployAgent,
    activateRevision,
    seedActiveAgentRevision,
    createSecret,
    createAccountWithPolicy,
    createNamespaceMember,
    registerCleanupBeforeAppClose,
    app,
    get controller() {
      return controller;
    },
  };
}
