import { openShellNamespaceObjects } from "./openshell-workspace-protocol.ts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { Agent, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createConsoleFixtureRevisions } from "./console-fixture-revisions.ts";
import {
  createConsoleFixturePolicy,
  createConsoleFixturePolicyHelpers,
} from "./console-fixture-policy.ts";
import { fileConsoleApp as createFileConsoleApp } from "./console-file-app.ts";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerAuth } from "./password-hasher.ts";
import { backendSummariesFromDefinitions } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentResponse,
  ConfigurationResponse,
  InstallationResponse,
  NamespaceResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { NAME_MAX_CHARACTERS } from "../../packages/contracts/src/api/plain-text.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.ts";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.ts";
import { reservePort } from "./available-port.ts";
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.ts";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import { createFixtureResponse } from "./console-fixture-response.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

/**
 * @typedef {{
 *   email?: string,
 *   password?: string,
 *   name?: string | undefined,
 *   rememberMe?: boolean | undefined,
 *   origin?: string | undefined,
 *   path?: string | undefined,
 *   fetch?: ((request: Request) => Promise<Response>) | undefined,
 *   headers?: Record<string, string> | undefined,
 * }} SignInOverrides
 */
/** @typedef {{response: Response, setCookie: string[], cookie: string, origin: string}} ConsoleSession */
/** @typedef {string | ConsoleSession | {cookie: string, origin?: string | undefined}} RequestSession */

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
  modelProvider,
  channelRuntime = false,
  routed = true,
  discoverHarnessModels = async () => [],
  agentProvisioning = false,
  sandboxDriver,
  credentialGatewayDriver,
  resolveSandboxNamespace = async (namespace) => ({
    ...namespace,
    name: kubernetesNamespaceName(namespace.id),
  }),
  // OCC applies the bundled Kubernetes Compute's own save rules (channel credentials only from
  // Secret bindings, finding 2319) only under its implementation, such as `kubernetes-local`.
  implementation = "test-memory-lifecycle",
} = {}) {
  const namespaceObjects = openShellNamespaceObjects();
  const driver = createTestKubernetesComputeDriver("console-compute", {
    gatewayRuntime: true,
    ...(modelProvider === undefined ? {} : { modelProvider }),
    // As `occ dev up` installs it: the controller reads Gateway private status, so the save and
    // deploy rules for a runtime workspace node apply (finding 3133).
    privateStatus: true,
    repositoryCredentials,
    sandboxDriver,
    credentialGatewayDriver,
    channelRuntime,
    routed,
  });

  return Object.assign(driver, {
    implementation,
    // Gateway startup and transport credentials are simulated unless repository credentials
    // are in scope. Console, OCC and IAM routes still use production code.
    ...(repositoryCredentials ? {} : { requiresAgentRuntimeCredentials: undefined }),
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
    resolveSandboxNamespace,
    async resolveSandboxNamespaceContext(namespace, signal) {
      return {
        namespace: await resolveSandboxNamespace(namespace),
        kubernetes: namespaceObjects,
        signal,
      };
    },
    async checkNamespaceDeletion(namespace) {
      return { namespaceId: namespace.id, deletionAllowed: true };
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

// The default model credential Secret's name for createAgent. An Agent name may use all of the
// Name rule's characters, so "Auth <Agent name>" is cut to that length (in code points); the cut
// can land after a space, which a Name cannot end with.
function authSecretName(agentName) {
  return Array.from(`Auth ${agentName}`).slice(0, NAME_MAX_CHARACTERS).join("").trimEnd();
}

// Playwright route.fetch uses Node's TLS client, separately from Chromium.
// Keep each live fixture's exact certificate trusted until that fixture closes.
let originalNodeCertificates;
const nodeFixtureCertificates = new Map();
function trustNodeFixtureCertificate(cert) {
  const pem = cert.toString();
  originalNodeCertificates ??= getCACertificates("default");
  nodeFixtureCertificates.set(pem, (nodeFixtureCertificates.get(pem) ?? 0) + 1);
  const update = () =>
    setDefaultCACertificates([...originalNodeCertificates, ...nodeFixtureCertificates.keys()]);
  update();
  return () => {
    const remaining = nodeFixtureCertificates.get(pem) - 1;
    if (remaining === 0) {
      nodeFixtureCertificates.delete(pem);
    } else {
      nodeFixtureCertificates.set(pem, remaining);
    }
    update();
    if (nodeFixtureCertificates.size === 0) {
      originalNodeCertificates = undefined;
    }
  };
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
 * Returns the leaf and close().
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
          // Concurrent self-signed roots need distinct subjects. OpenSSL otherwise
          // selects one of the same-subject/key certificates and rejects the others.
          `/CN=${originHost}/OU=${randomUUID()}`,
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
  assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0 && upstreamPort <= 65535);
  // Only this fixture's existing loopback API socket uses this Agent. Preserve the
  // real browser Host/Origin/cookies instead of routing the local hop via env proxy.
  const agent = new Agent({ keepAlive: false });
  const ingress = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        agent,
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        response.on("error", (error) => outgoing.destroy(error));
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    // Preserve deliberate connection-loss cases through the fixture TLS hop.
    upstream.on("error", (error) => outgoing.destroy(error));
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) {
        upstream.destroy();
      }
    });
    incoming.pipe(upstream);
  });
  ingress.listen({ port, host: "127.0.0.1", reusePort });
  await once(ingress, "listening");
  return {
    cert,
    async close() {
      agent.destroy();
      await new Promise((resolve, reject) => {
        ingress.close((error) => (error ? reject(error) : resolve()));
        ingress.closeAllConnections();
      });
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
  return createFileConsoleApp((registrar) => createConsoleAppFixture(registrar, options));
}

/**
 * Keep object-typed wrappers and keyed options extracted with Parameters compatible.
 * @param {import("./console-file-app.ts").CleanupRegistrar} t
 * @template {object | Record<string, unknown>} [Options=object]
 * @param {Options & {auditSink?: InMemoryAuditSink, durableRequestAuditSink?: InMemoryAuditSink, https?: boolean, ingressTLS?: {key: Buffer, cert: Buffer}}} [options]
 */
export async function createConsoleAppFixture(t, options = {}) {
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  if (!(auditSink instanceof InMemoryAuditSink)) {
    throw new TypeError("Console fixture auditSink must be an InMemoryAuditSink instance.");
  }
  const defaultAgentGatewayManagedMode = options.agentGatewayManagedMode;
  const installationId = `ins_${randomUUID()}`;
  // The ports are part of the origins the app is configured with, so hold them until the
  // listeners bind them; a released probe port can be taken by another listener meanwhile.
  const appPort = await reservePort();
  t.after(appPort.release);
  const port = appPort.port;
  const originHost = options.originHost ?? "console.oce.localhost";
  const https = options.https !== false;
  const browserReservation = https ? await reservePort() : null;
  if (browserReservation !== null) {
    t.after(browserReservation.release);
  }
  const browserPort = browserReservation?.port ?? port;
  const origin = `${https ? "https" : "http"}://${originHost}:${browserPort}`;
  const browserArgs = [];
  const transportOrigin = `http://127.0.0.1:${port}`;
  const { rawRequest, fetchThroughLoopback } = createConsoleFixtureTransport(
    origin,
    transportOrigin,
  );
  // CUA fault-injection keeps Better Auth on the trusted browser origin.
  const authBaseURL = options.authBaseURL ?? origin;
  const authMode = options.authMode ?? "development";
  // Better Auth owns the rows; test consumers only read or change their expiry.
  /** @type {{ expiresAt: Date }[]} */
  const sessionRows = [];
  const memoryDatabase = {
    user: [],
    account: [],
    session: sessionRows,
    verification: [],
    apikey: [],
  };
  const authSecret = `console-test-secret-${randomUUID()}-${randomUUID()}`;
  const auth = createControllerAuth({
    installationId,
    mode: authMode,
    baseURL: authBaseURL,
    agentDomain: options.nativeAdmin?.domain ?? `agents.${new URL(authBaseURL).hostname}`,
    secret: authSecret,
    memoryDatabase,
  });
  const credentials = {
    email: `console-admin-${randomUUID()}@example.com`,
    password: `console-password-${randomUUID()}`,
    name: "Console Administrator",
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account, { grant: "administrator" });
  const policy = createConsoleFixturePolicy(seed);
  // These grant-free accounts are fixture setup. Accounts added later through
  // createAccountWithPolicy are also shareable, because State resolves identities live.
  /** @type {{credentials: typeof credentials, principal: typeof seed.principal}[]} */
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
  /** @type {import("../../packages/occ/src/index.ts").PlatformStateStore} */
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
  /** @type {((native: NativeIAMDriver) => NonNullable<import("../../packages/occ/src/index.ts").ControllerOptions["authorize"]>) | undefined} */
  const authorizeWith = options.authorizeWith;
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
    const root = await temporaryDirectory(t, "occ-console-configuration-");
    configurationDriver = new FilesystemConfigurationDriver(root);
  }
  let controller;
  const appOptions = {
    metrics: options.metrics,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    workspaceFilesAccess: options.workspaceFilesAccess,
    gatewayPeopleAccess: options.gatewayPeopleAccess,
    auth,
    iamDriver,
    auditSink,
    ...(options.durableRequestAuditSink === undefined
      ? {}
      : { durableRequestAuditSink: options.durableRequestAuditSink }),
    development: {
      enabled: true,
      installationId,
      ...(options.development?.enabled === false
        ? {}
        : { browserOrigin: new URL(authBaseURL).origin }),
      ...options.development,
    },
    computeDriver:
      options.computeDriver ??
      computeDriver({
        repositoryCredentials: options.repositoryCredentials === true,
        channelRuntime: options.channelRuntime === true,
        routed: options.routed !== false,
        discoverHarnessModels: options.discoverHarnessModels,
        agentProvisioning: options.agentProvisioning,
        modelProvider: options.modelProvider,
        sandboxDriver: options.sandboxDriver,
        credentialGatewayDriver: options.credentialGatewayDriver,
        resolveSandboxNamespace: options.resolveSandboxNamespace,
        implementation: options.computeImplementation,
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
        authenticationStateEncryptionSecret: authSecret,
        namespaceLifecycleBindings:
          options.namespaceLifecycleBindings ??
          (options.sandboxDriver?.ensureNamespace === undefined
            ? []
            : [sandboxNamespaceLifecycleBinding(appOptions.computeDriver, options.sandboxDriver)]),
        ...(authorizeWith === undefined ? {} : { authorize: authorizeWith(iamDriver) }),
        preparedTokens: options.preparedTokens,
        ...(options.pluginSourceReader === undefined
          ? {}
          : { pluginSourceReader: options.pluginSourceReader }),
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

  /** @param {() => void | Promise<void>} cleanup */
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
  const fixtureResponse = createFixtureResponse(app.getSchemas());

  if (https) {
    // Exercise browser Secure/Domain cookies through a real TLS ingress to the HTTP API.
    const ingress = await startHttpsIngress({
      tls: options.ingressTLS,
      port: browserPort,
      upstreamPort: port,
      originHost,
      reusePort: browserReservation.reusePort,
    });
    await browserReservation.release();
    cleanupBeforeAppClose.push(ingress.close, trustNodeFixtureCertificate(ingress.cert));
    if (options.ingressTLS === undefined) {
      browserArgs.push(chromiumTrustArg([ingress.cert]));
    }
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

  /** @param {SignInOverrides} [overrides] @returns {Promise<ConsoleSession>} */
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
   * @param {{session?: RequestSession | null | undefined, headers?: Record<string, string>, body?: unknown}} [options]
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
    return fixtureResponse(result, 201, InstallationResponse, "bootstrap Installation").data;
  }

  const {
    createNamespace,
    grantAgentSecretOperate,
    addedAccessBindings,
    withIamOutage,
    createNamespaceMember,
  } = createConsoleFixturePolicyHelpers({
    policy,
    principalId: seed.principal.id,
    request,
    fixtureResponse,
    getController: () => controller,
    iamDriver,
    createAccountWithPolicy,
  });

  /**
   * @param {string} namespaceId
   * @param {object} [values]
   */
  async function createConfiguration(namespaceId, values = {}, options = {}) {
    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: {
        kind: "agent",
        values,
        ...(options.secretBindings === undefined ? {} : { secretBindings: options.secretBindings }),
      },
    });
    return fixtureResponse(configuration, 201, ConfigurationResponse, "create Configuration").data;
  }

  /**
   * @param {string} namespaceId
   * @param {string} configurationId
   * @param {object} [values]
   */
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
    return fixtureResponse(configuration, 200, ConfigurationResponse, "update Configuration").data;
  }

  /**
   * @param {string} namespaceId
   * @param {string} name
   * @param {object} [values]
   */
  async function createAgent(namespaceId, name, values = {}, options = {}) {
    const configuration = await createConfiguration(namespaceId, values, {
      secretBindings: options.secretBindings,
    });
    const namespaceResponse = await request("GET", `/namespaces/${namespaceId}`);
    const namespace = fixtureResponse(
      namespaceResponse,
      200,
      NamespaceResponse,
      "read Agent Namespace",
    ).data;
    const harnessAuth =
      options.harnessAuth === undefined && secretDriver && namespace.status === "ready"
        ? {
            method: "api_key",
            source: (
              await createSecret(namespaceId, authSecretName(name), `test-api-key-${randomUUID()}`)
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
        ...(defaultAgentGatewayManagedMode === undefined
          ? {}
          : { gatewayManagedMode: defaultAgentGatewayManagedMode }),
      },
    });
    const created = fixtureResponse(agent, 201, AgentResponse, "create Agent").data;
    // An Installation administrator's console reads the model credential's grant as it reads bound
    // channel Secrets' grants, so it is listed too (finding 2260).
    if (harnessAuth?.method === "api_key") {
      await grantAgentSecretOperate(created, harnessAuth.source, { modelGrant: true });
    }
    // The console grants the Agent each Secret its Configuration binds when it binds it.
    for (const { source } of Object.values(options.secretBindings ?? {})) {
      if (source?.kind === "secret") {
        await grantAgentSecretOperate(created, source);
      }
    }
    return created;
  }

  /**
   * @param {string} namespaceId
   * @param {string} agentId
   * @param {unknown} body
   */
  async function updateAgent(namespaceId, agentId, body) {
    const agent = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      body,
    });
    return fixtureResponse(agent, 200, AgentResponse, "update Agent").data;
  }

  const { deployAgent, activateRevision, seedActiveAgentRevision } = createConsoleFixtureRevisions(
    request,
    fixtureResponse,
    () => {
      assert.ok(controller, "bootstrap must create the controller before revision activation");
      return platformState;
    },
  );

  /**
   * @param {string} namespaceId
   * @param {string} name
   * @param {string} value
   */
  async function createSecret(namespaceId, name, value) {
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      body: { name, value },
    });
    return fixtureResponse(secret, 201, SecretResponse, "create Secret").data;
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

  return {
    principal: seed.principal,
    origin,
    browserArgs,
    credentials,
    memoryDatabase,
    provisionedAccounts,
    policy,
    // The sink State and the API audit to: `options.auditSink`, or one the fixture made.
    auditSink,
    // The real Native IAM Driver, for tests that simulate an IAM outage at its boundary.
    iamDriver,
    withIamOutage,
    rawRequest,
    fetch: fetchThroughLoopback,
    request,
    fixtureResponse,
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

export { memberRole, grantMember } from "./console-fixture-policy.ts";

export { authorizationDenials, denialsDuring } from "./console-audit-denials.ts";
