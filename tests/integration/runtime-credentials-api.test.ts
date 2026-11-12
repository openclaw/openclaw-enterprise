import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import test, { after } from "node:test";

import type {
  AgentDeploymentDiagnostics,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AuthorizationRequest,
  ComputeAgentBinding,
  ComputeAgentRevisionBinding,
  ComputeDriver,
  Principal,
} from "../../packages/contracts/src/index.ts";
import {
  AgentDeploymentDiagnosticsResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  AgentRuntimeCredentialResponse,
  ConfigurationResponse,
  NamespaceResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  ResourceConflictError,
  RuntimeDiagnosticsTransportError,
  RuntimeCredentialsForbiddenByClusterError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createControllerAuth } from "../helpers/password-hasher.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { jsonRequestInit } from "../helpers/inject-json.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver, registerAndSelectDrivers } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { reservePort } from "../helpers/available-port.ts";
import { grantRole } from "../helpers/iam-grants.mjs";
import { EMBEDDED_API_KEY_REQUIRED } from "../helpers/refusal-text.mjs";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix: string) => new RegExp(`^${prefix}_${uuidV4}$`);

type RuntimeCredentialDriverOptions = {
  id?: string;
  implementation?: string;
  statusError?: Error;
  provisionError?: Error;
  diagnosticsError?: Error;
  diagnosticsResult?: AgentDeploymentDiagnostics | null;
};
type RuntimeCredentialCall = {
  operation: "status" | "provision" | "diagnostics";
  agentId: string;
  input?: AgentRuntimeCredentialsInput;
  revisionId?: string;
};

function createRuntimeCredentialComputeDriver(options: RuntimeCredentialDriverOptions = {}) {
  const statusByAgent = new Map<string, AgentRuntimeCredentialStatus>();
  const calls: RuntimeCredentialCall[] = [];
  const diagnosticObservedAt = "2026-01-02T03:04:05.000Z";
  const diagnosticCheckedAt = "2026-01-02T03:04:04.000Z";
  const emptyStatus = Object.freeze({
    transportConfigured: false,
  });
  const keyOf = (binding: ComputeAgentBinding) => `${binding.namespace.id}:${binding.agent.id}`;
  const explicitKeyOf = (namespaceId: string, agentId: string) => `${namespaceId}:${agentId}`;
  const statusOf = (binding: ComputeAgentBinding) =>
    statusByAgent.get(keyOf(binding)) ?? emptyStatus;

  const driver = createReadyComputeDriver(options.id ?? "runtime-credential-compute", {
    implementation: options.implementation ?? "in-memory-runtime-credential-test",
    requiresAgentRuntimeCredentials: true,
    calls,
    setStatus(namespaceId: string, agentId: string, status: AgentRuntimeCredentialStatus) {
      statusByAgent.set(explicitKeyOf(namespaceId, agentId), { ...status });
    },
    validateHarnessAuth() {},
    async getAgentRuntimeCredentialStatus(binding) {
      calls.push({ operation: "status", agentId: binding.agent.id });
      if (options.statusError !== undefined) {
        throw options.statusError;
      }
      return { ...statusOf(binding) };
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({
        operation: "provision",
        agentId: binding.agent.id,
        input: structuredClone(input),
      });
      const status = {
        transportConfigured: true,
      };
      statusByAgent.set(keyOf(binding), status);
      if (options.provisionError !== undefined) {
        throw options.provisionError;
      }
      return { ...status };
    },
  });
  // This fixture also exercises an invalid null response from the runtime boundary.
  Object.defineProperty(driver, "diagnoseAgentDeployment", {
    enumerable: true,
    configurable: true,
    writable: true,
    async value(binding: ComputeAgentRevisionBinding): Promise<AgentDeploymentDiagnostics | null> {
      calls.push({
        operation: "diagnostics",
        agentId: binding.agent.id,
        revisionId: binding.revision.id,
      });
      if (options.diagnosticsError !== undefined) {
        throw options.diagnosticsError;
      }
      if (options.diagnosticsResult !== undefined) {
        return options.diagnosticsResult;
      }
      return {
        revisionId: binding.revision.id,
        observedAt: diagnosticObservedAt,
        checks: [
          {
            component: "gateway",
            check: "connectivity",
            state: "failed",
            checkedAt: diagnosticCheckedAt,
            code: "DISCONNECTED",
          },
          // Compute reads checks from the runtime, which can serve anything of this shape.
          {
            component: "runtime",
            check: "gateway",
            state: "succeeded",
            checkedAt: diagnosticCheckedAt,
            code: "gateway_ready",
          },
        ],
      };
    },
  });
  return driver;
}

// Admission fixtures own Namespace setup. Driver reads still use the selected Kubernetes client.
function createKubernetesComputeDriver(
  options?: Parameters<typeof createTestKubernetesComputeDriver>[1],
) {
  const computeDriver = createTestKubernetesComputeDriver("runtime-credential-compute", options);
  computeDriver.ensureNamespace = async (namespace) => ({
    namespaceId: namespace.id,
    namespaceReady: true,
  });
  return computeDriver;
}

// Building a listening controller app and signing accounts in to it cost more than most cases,
// so the cases share them: one app per Compute Driver implementation, with one administrator
// session and a pool of limited principals. Cases run one at a time. Each gets a new Namespace
// and its own Compute Driver, audit sink, OCC log lines and IAM grants: the app's Driver, sink
// and log destination forward to the running case's, and each case starts from the
// administrator's grants alone, so a pooled principal holds only what the case grants it. A
// forwarding Driver keeps one identity, because OCC rechecks it on every selection, so a case
// Driver's own id never reaches OCC.
type LogLine = Record<string, unknown>;
type Session = { response: Response; cookie: string; origin: string };
type RunningCase = {
  auditSink: InMemoryAuditSink;
  computeDriver: ComputeDriver;
  logLines: LogLine[];
};
let running: RunningCase;
const apps = new Map<string, ReturnType<typeof createSharedApp>>();
const cleanup: Array<() => Promise<unknown>> = [];
after(() => Promise.all(cleanup.map((step) => step())));

function forwarder<T extends object>(identity: Partial<T>, target: () => T): T {
  return new Proxy(target(), {
    get(_pinned, key) {
      if (Object.hasOwn(identity, key)) {
        return Reflect.get(identity, key);
      }
      const current = target();
      const value: unknown = Reflect.get(current, key);
      return typeof value === "function" ? value.bind(current) : value;
    },
    has: (_pinned, key) => Object.hasOwn(identity, key) || key in target(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

async function createSharedApp(implementation: string) {
  const installationId = `ins_${randomUUID()}`;
  // Reserve the loopback test socket while accounts and the application are built.
  const reservation = await reservePort();
  cleanup.push(reservation.release);
  const origin = `http://127.0.0.1:${reservation.port}`;
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL: "https://console.oce.localhost",
    agentDomain: "agents.oce.localhost",
    secret: `runtime-credential-test-secret-${randomUUID()}`,
    memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
  });
  const createAccount = async (label: string, name: string, grant: "administrator" | "none") => {
    const credentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `runtime-password-${randomUUID()}`,
      name,
    };
    const seed = auth.principalSeed(await auth.createAccount(credentials), { grant });
    return {
      seed,
      signIn: (): Promise<Session> =>
        signInWithEmailPassword({
          origin,
          rememberMe: undefined,
          headers: { origin: "https://console.oce.localhost" },
          ...credentials,
        }),
    };
  };
  const administrator = await createAccount(
    "runtime-admin",
    "Runtime Credential Administrator",
    "administrator",
  );
  const { seed } = administrator;
  const policy: { [K in keyof NativeIAMState]: Array<NativeIAMState[K][number]> } = {
    identities: [],
    groups: [],
    memberships: [],
    roles: [],
    bindings: [],
    restrictions: [],
  };
  const principals: Array<{
    principal: Principal;
    session: Awaited<ReturnType<typeof administrator.signIn>>;
  }> = [];
  let principalsUsed = 0;
  const resetPolicy = () => {
    principalsUsed = 0;
    Object.assign(policy, {
      identities: [seed.principal],
      roles: seed.roles.map((role) => ({
        ...role,
        permissions: role.permissions.map((permission) => ({ ...permission })),
      })),
      bindings: seed.bindings.map((binding) => ({ ...binding })),
    });
  };
  resetPolicy();
  const auditSink = forwarder({}, () => running.auditSink);
  const platformState = new InMemoryPlatformState({ auditSink });
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "runtime-credential-iam" },
  );
  let controller: OpenClawController | undefined;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId, browserOrigin: "https://console.oce.localhost" },
    publicOrigin: "https://console.oce.localhost",
    computeDriver: forwarder(
      { id: "runtime-credential-compute", capability: "compute", implementation },
      () => running.computeDriver,
    ),
    configurationDriver: createTestConfigurationDriver({ id: "runtime-credential-configuration" }),
    secretDriver: createTestSecretDriver({ id: "runtime-credential-secret" }),
    resolveHarness: resolveApprovedHarness,
    logger: createOccLogger({
      component: "occ-api",
      level: "info",
      destination: {
        write(chunk) {
          running.logLines.push(
            ...String(chunk)
              .split("\n")
              .filter(Boolean)
              .map((line) => record(JSON.parse(line))),
          );
          return true;
        },
      },
    }),
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: platformState,
        recordOperations: false,
      });
      return controller;
    },
  });
  try {
    const listenOptions = {
      host: "127.0.0.1",
      port: reservation.port,
      reusePort: reservation.reusePort,
    };
    await app.listen(listenOptions);
    cleanup.push(() => app.close());
  } finally {
    await reservation.release();
  }
  const adminSession = await administrator.signIn();

  const fixtureResponse = createFixtureResponse(app.getSchemas());
  async function request(
    method: string,
    path: string,
    {
      session = adminSession,
      body,
      origin: requestOrigin = "https://console.oce.localhost",
    }: {
      session?: typeof adminSession;
      body?: object;
      origin?: string;
    } = {},
  ) {
    const response = await fetchLoopback(
      `${origin}${path}`,
      jsonRequestInit(method, body, {
        ...authenticatedHeaders(session),
        host: "console.oce.localhost",
        origin: requestOrigin,
      }),
    );
    const text = await response.text();
    const payload = text.length === 0 ? undefined : record(JSON.parse(text));
    if (payload !== undefined) {
      const requestId = record(payload.meta).requestId;
      assert.ok(typeof requestId === "string");
      assert.match(requestId, identifier("req"));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    return { status: response.status, body: payload, data: payload?.data };
  }

  const installed = await request("POST", "/installation/bootstrap", {
    body: { name: "Runtime credential test" },
  });
  assert.equal(installed.status, 201, JSON.stringify(installed));

  assert.ok(controller, "controller must be initialized after bootstrap");
  const initializedController = controller;

  async function bootstrapAgent(values = createHarnessConfiguration("openclaw", "gpt-4.1")) {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `runtime-namespace-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201);
    const namespaceData = fixtureResponse(
      namespace,
      201,
      NamespaceResponse,
      "create Namespace",
    ).data;
    await initializedController.handleNamespaceLifecycle(
      seed.principal.id,
      namespaceData.id,
      "ready",
    );
    const secret = await request("POST", `/namespaces/${namespaceData.id}/secrets`, {
      body: { name: "Model API key", value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201);
    const secretData = fixtureResponse(secret, 201, SecretResponse, "create Secret").data;
    const configuration = await request("POST", `/namespaces/${namespaceData.id}/configurations`, {
      body: {
        kind: "agent",
        values,
      },
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
    const configurationData = fixtureResponse(
      configuration,
      201,
      ConfigurationResponse,
      "create Configuration",
    ).data;
    const agent = await request("POST", `/namespaces/${namespaceData.id}/agents`, {
      body: {
        name: "Runtime credential Agent",
        configurationId: configurationData.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secretData.ref },
      },
    });
    assert.equal(agent.status, 201);
    const agentData = fixtureResponse(agent, 201, AgentResponse, "create Agent").data;
    const servicePrincipalId = `service-agent-${agentData.id}`;
    const roleId = `auth-${agentData.id}`;
    policy.identities.push({
      id: servicePrincipalId,
      kind: "service_principal",
      namespaceId: namespaceData.id,
      agentId: agentData.id,
    });
    grantRole(policy, servicePrincipalId, {
      id: roleId,
      namespaceId: namespaceData.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secretData.id },
    });
    return {
      namespace: namespaceData,
      configuration: configurationData,
      agent: agentData,
      secret: secretData,
      agentPath: `/namespaces/${namespaceData.id}/agents/${agentData.id}`,
      credentialsPath: `/namespaces/${namespaceData.id}/agents/${agentData.id}/runtime-credentials`,
    };
  }

  // A controller restarted on the same state with another Compute Driver, as after the
  // Installation's Driver configuration changed. Unlike the app's, this Driver is selected
  // directly, so its own id and implementation reach OCC.
  function restartController(computeDriver: ComputeDriver) {
    const restarted = new OpenClawController(initializedController.installation, {
      state: platformState,
      recordOperations: false,
    });
    registerAndSelectDrivers(restarted, [iamDriver, computeDriver]);
    return restarted;
  }

  async function createPrincipal(label: string, configurePolicy: (principal: Principal) => void) {
    if (principalsUsed === principals.length) {
      const { seed: created, signIn } = await createAccount(label, label, "none");
      principals.push({ principal: created.principal, session: await signIn() });
    }
    const pooled = principals[principalsUsed++];
    assert.ok(pooled);
    policy.identities.push(pooled.principal);
    configurePolicy(pooled.principal);
    return pooled;
  }

  return {
    administratorId: seed.principal.id,
    bootstrapAgent,
    createPrincipal,
    origin,
    policy,
    request,
    fixtureResponse,
    resetPolicy,
    restartController,
  };
}

async function createFixture<
  T extends ComputeDriver = ReturnType<typeof createRuntimeCredentialComputeDriver>,
>(options?: { computeDriver?: T; auditSink?: InMemoryAuditSink; logLines?: LogLine[] }) {
  const computeDriver = options?.computeDriver ?? createRuntimeCredentialComputeDriver();
  const auditSink = options?.auditSink ?? new InMemoryAuditSink();
  const logLines = options?.logLines ?? [];
  const { implementation } = computeDriver;
  if (!apps.has(implementation)) {
    // Building the app signs the administrator in, which audits and logs: into a sink and lines
    // no case reads, so a case sees only its own.
    running = { computeDriver, auditSink: new InMemoryAuditSink(), logLines: [] };
    apps.set(implementation, createSharedApp(implementation));
  }
  const shared = await apps.get(implementation);
  running = { computeDriver, auditSink, logLines };
  assert.ok(shared);
  shared.resetPolicy();
  return { ...shared, auditSink, computeDriver };
}

// A 403 that reached no Compute Driver call and was audited as this authorization denial.
type ApiResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createSharedApp>>["request"]>>;
function assertDenied(
  fixture: { computeDriver: { calls: RuntimeCredentialCall[] }; auditSink: InMemoryAuditSink },
  response: ApiResponse,
  authorization: AuthorizationRequest,
) {
  assertApiError(response, 403, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const denial = fixture.auditSink.events.at(-1);
  assert.ok(denial);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, authorization);
}

test("runtime credential API provisions transport metadata only through the selected Compute Driver", async () => {
  const fixture = await createFixture();
  const { agent, credentialsPath: path } = await fixture.bootstrapAgent();

  const initial = await fixture.request("GET", path);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, {
    transportConfigured: false,
  });

  const provisioned = await fixture.request("POST", path, { body: {} });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
  });

  const observed = await fixture.request("GET", path);
  assert.equal(observed.status, 200);
  assert.deepEqual(observed.data, provisioned.data);
  assert.deepEqual(
    fixture.computeDriver.calls.map((call) => call.operation),
    ["status", "provision", "status"],
  );
  assert.deepEqual(fixture.computeDriver.calls[1]?.input, {});

  assert.ok(
    fixture.auditSink.events.some(
      (event) =>
        event.action === "openclaw.agents.runtime_credentials.provision" &&
        event.resource.kind === "agent" &&
        event.resource.id === agent.id &&
        event.outcome === "success",
    ),
  );
});

test("first draft deployment provisions generated credentials and later revisions reuse them", async () => {
  const fixture = await createFixture();
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();

  const first = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(
    fixture.fixtureResponse(first, 202, AgentRevisionResponse, "first deployment").data.revision,
    1,
  );
  const credentials = await fixture.request("GET", `${agentPath}/runtime-credentials`);
  assert.equal(credentials.status, 200);
  assert.equal(
    fixture.fixtureResponse(credentials, 200, AgentRuntimeCredentialResponse, "runtime credentials")
      .data.transportConfigured,
    true,
  );

  const second = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(second.status, 202, JSON.stringify(second.body));
  assert.equal(
    fixture.fixtureResponse(second, 202, AgentRevisionResponse, "second deployment").data.revision,
    2,
  );
  assert.equal(
    fixture.computeDriver.calls.filter(({ operation }) => operation === "provision").length,
    1,
    "a later revision must retain the original transport values",
  );

  // Lost credentials after a historical revision require recovery, not silent regeneration.
  fixture.computeDriver.setStatus(namespace.id, agent.id, { transportConfigured: false });
  const missing = await fixture.request("POST", `${agentPath}/deploy`);
  assertApiError(missing, 409, "RESOURCE_CONFLICT");
  assert.equal(
    fixture.computeDriver.calls.filter(({ operation }) => operation === "provision").length,
    1,
  );
  const revisions = await fixture.request("GET", `${agentPath}/revisions`);
  assert.equal(revisions.status, 200);
  assert.equal(
    fixture.fixtureResponse(revisions, 200, AgentRevisionListResponse, "list revisions").data
      .length,
    2,
  );
});

test("Kubernetes diagnostics distinguish a starting Gateway from a denied Pod proxy read", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-diagnostics-");
  const { key, cert, certPath } = await selfSigned(directory);
  const token = `kubernetes-fixture-${randomUUID()}`;
  const marker = `private-kubernetes-detail-${randomUUID()}`;
  const resources = new Map<string, object>();
  const proxyReads: string[] = [];
  const failures = new Map<string, 403 | 503>();
  const startupUnavailable = Promise.withResolvers<void>();
  let unavailableStatusPath: string | undefined = undefined;
  let diagnosticsRefusalsServed = 0;
  const server = createServer({ key, cert }, async (request, response) => {
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    const path = request.url ?? "";
    if (path.includes("/proxy/")) {
      proxyReads.push(path);
    }
    const headers = { "content-type": "application/json" };
    const diagnosticsStatus = failures.get(path);
    if (diagnosticsStatus !== undefined) {
      if (diagnosticsStatus === 403) {
        await startupUnavailable.promise;
        response.once("finish", () => {
          diagnosticsRefusalsServed += 1;
        });
      }
      response.writeHead(diagnosticsStatus, headers).end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "Status",
          status: "Failure",
          reason: diagnosticsStatus === 503 ? "ServiceUnavailable" : "Forbidden",
          code: diagnosticsStatus,
          message: marker,
        }),
      );
      return;
    }
    const resource = resources.get(new URL(path, "https://127.0.0.1").pathname);
    if (path === unavailableStatusPath && resource === undefined) {
      response.once("finish", startupUnavailable.resolve);
    }
    response.writeHead(resource === undefined ? 404 : 200, headers).end(JSON.stringify(resource));
  });
  const port = await listen(t, server);
  const kubeconfigPath = join(directory, "kubeconfig");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "fixture",
          cluster: { server: `https://127.0.0.1:${port}`, "certificate-authority": certPath },
        },
      ],
      users: [{ name: "controller", user: { token } }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "controller" } }],
      "current-context": "fixture",
    }),
    { mode: 0o600 },
  );

  const lines: LogLine[] = [];
  const fixture = await createFixture({
    logLines: lines,
    computeDriver: createKubernetesComputeDriver({
      authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
    }),
  });
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();
  // This credential-admission fixture has no Gateway runtime to apply managed mode.
  const updated = await fixture.request("PATCH", agentPath, {
    body: { configurationId: agent.configurationId, gatewayManagedMode: false },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const admitted = await fixture.request("POST", `${agentPath}/deploy`);
  const revision = fixture.fixtureResponse(
    admitted,
    202,
    AgentRevisionResponse,
    "admit deployment",
  ).data;
  assert.equal(revision.revision, 1);

  // The SDK discovers the owned Namespace and a Running Pod for the admitted revision.
  const namespaceName = kubernetesNamespaceName(namespace.id);
  const ownedNamespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespace.id,
      },
      annotations: { "openclaw.dev/namespace-id": namespace.id },
    },
    status: { phase: "Active" },
  };
  const podName = "gateway-pod";
  const podUid = randomUUID();
  const namespacePath = `/api/v1/namespaces/${namespaceName}`;
  resources.set("/api/v1/namespaces", {
    apiVersion: "v1",
    kind: "NamespaceList",
    items: [ownedNamespace],
  });
  resources.set(namespacePath, ownedNamespace);
  resources.set(`${namespacePath}/pods`, {
    apiVersion: "v1",
    kind: "PodList",
    items: [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: podName,
          namespace: namespaceName,
          uid: podUid,
          labels: {
            "openclaw.dev/agent": agent.id,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "gateway",
          },
        },
        status: {
          phase: "Running",
          podIP: "10.42.0.10",
          containerStatuses: [{ name: "gateway", containerID: "containerd://gateway-fixture" }],
        },
      },
    ],
  });
  const proxyPath = `${namespacePath}/pods/${podName}%3A18791/proxy/openclaw%2Fruntime%2F`;
  const statusPath = `${proxyPath}status`;
  resources.set(statusPath, { revisionId: revision.id, container: "gateway", podUid });
  const diagnosticsPath = `${proxyPath}diagnostics`;
  failures.set(diagnosticsPath, 503);
  const diagnose = () =>
    fixture.request("POST", `${agentPath}/deployments/${revision.id}/diagnostics`);
  const dependencyLogs = (requestId: string) =>
    lines.filter(
      (line) => line.event === "http.dependency_unavailable" && line.requestId === requestId,
    );

  // Kubernetes can answer 503 while the private endpoint starts. OCC still returns an observation.
  const starting = fixture.fixtureResponse(
    await diagnose(),
    200,
    AgentDeploymentDiagnosticsResponse,
    "Gateway diagnostics while starting",
  );
  assert.deepEqual(proxyReads.sort(), [diagnosticsPath, statusPath]);
  assert.equal(starting.data.revisionId, revision.id);
  assert.deepEqual(starting.data.checks, [
    {
      component: "gateway",
      check: "runtime-status",
      state: "unknown",
      checkedAt: null,
      code: "UNAVAILABLE",
    },
  ]);
  assert.deepEqual(dependencyLogs(starting.meta.requestId), []);

  // Settle the supplementary startup response before diagnostics refuses, so no sibling
  // read needs a later Pod check after the public failure permits fixture teardown.
  unavailableStatusPath = statusPath;
  resources.delete(statusPath);
  // An API-server refusal of the same proxy request has a fixed operator category.
  failures.set(diagnosticsPath, 403);
  proxyReads.length = 0;
  const denied = fixture.fixtureResponse(await diagnose(), 503, ErrorResponse, "denied Pod proxy");
  // A request timeout can produce the same public category; require the intended refusal.
  assert.equal(diagnosticsRefusalsServed, 1);
  assert.deepEqual(
    proxyReads.filter((path) => path === diagnosticsPath),
    [diagnosticsPath],
  );
  assert.deepEqual(denied.error, {
    code: "DEPENDENCY_UNAVAILABLE",
    message: "A required platform dependency is unavailable.",
  });
  assert.deepEqual(
    dependencyLogs(denied.meta.requestId).map(({ errorClass, message, causes }) => ({
      errorClass,
      message,
      causes,
    })),
    [
      {
        errorClass: "RuntimeDiagnosticsTransportError",
        message: "The private Gateway diagnostics transport is unavailable.",
        causes: undefined,
      },
    ],
  );
  assert.equal(JSON.stringify(starting).includes(marker), false);
  assert.equal(JSON.stringify(denied).includes(marker), false);
  assert.equal(JSON.stringify(lines).includes(marker), false);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);
});

test("Kubernetes deploy names an unconfigured Harness authentication model provider", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  values.agents.defaults = {
    model: "zai/glm-5",
    models: { "zai/glm-5": { agentRuntime: { id: "openclaw" } } },
  };
  // A custom provider needs an explicit catalog and credential reference. Keep this
  // unsupported-binding scenario unconfigured; configured providers are supported.
  Object.assign(values.models, { providers: {} });
  // The draft Configuration can be stored, but its model has no deliverable provider.
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stored = await fixture.request("GET", agentPath);
  const storedData = fixture.fixtureResponse(stored, 200, AgentResponse, "read Agent").data;
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${storedData.configurationId}`,
    { body: { values } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const message =
    "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.";

  // The caller must learn that, not that the resource already exists: deployment refuses the
  // pair, and so does the Agent's next save (finding 1117).
  const refused = await fixture.request("POST", `${agentPath}/deploy`);
  assertApiError(refused, 409, "RESOURCE_CONFLICT");
  assert.equal(
    fixture.fixtureResponse(refused, 409, ErrorResponse, "error response").error.message,
    message,
  );
  const updated = await fixture.request("PATCH", agentPath, {
    body: { configurationId: storedData.configurationId },
  });
  assert.equal(updated.status, 409, JSON.stringify(updated.body));
  assert.equal(
    fixture.fixtureResponse(updated, 409, ErrorResponse, "error response").error.message,
    message,
  );
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Unsupported provider Agent",
      configurationId: storedData.configurationId,
      executionMode: "embedded",
      harnessAuth: storedData.harnessAuth,
    },
  });
  assert.equal(created.status, 409, JSON.stringify(created.body));
  assert.equal(
    fixture.fixtureResponse(created, 409, ErrorResponse, "error response").error.message,
    message,
  );
  // The stored Agent still reads.
  assert.equal((await fixture.request("GET", agentPath)).status, 200);
});

test("Kubernetes names a model provider reference the startup model check cannot resolve", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  assert.ok(values.models.providers.openai);
  values.models.providers.openai.baseUrl = "${MODEL_HOST}";
  // Configuration save accepts the reference: another Compute's runtime may resolve it.
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stored = await fixture.request("GET", agentPath);
  const storedData = fixture.fixtureResponse(stored, 200, AgentResponse, "read Agent").data;
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${storedData.configurationId}`,
    { body: { values } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  // Kubernetes probes the model with only the api_key binding's credential, so deploy and the
  // Agent's saves name the setting and the reason, not a generic topology conflict (finding 2828).
  const message =
    "Configuration setting models.providers.openai.baseUrl must not hold an environment or Secret reference: the startup model check on Kubernetes gets only the Harness credential.";
  const refused = (response: ApiResponse) => {
    assertApiError(response, 400, "INVALID_REQUEST");
    assert.equal(
      fixture.fixtureResponse(response, 400, ErrorResponse, "error response").error.message,
      message,
    );
  };
  refused(await fixture.request("POST", `${agentPath}/deploy`));
  refused(
    await fixture.request("PATCH", agentPath, {
      body: { configurationId: storedData.configurationId },
    }),
  );
  refused(
    await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Probe reference Agent",
        configurationId: storedData.configurationId,
        executionMode: "embedded",
        harnessAuth: storedData.harnessAuth,
      },
    }),
  );
});

test("Kubernetes names a Harness authentication method the execution mode cannot use, at save and deploy", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { namespace, agent, configuration, secret } = await fixture.bootstrapAgent();
  const message = EMBEDDED_API_KEY_REQUIRED;
  const agentsPath = `/namespaces/${namespace.id}/agents`;
  const agentPath = `${agentsPath}/${agent.id}`;
  const refused = (response: ApiResponse) => {
    assertApiError(response, 400, "INVALID_REQUEST");
    assert.equal(
      fixture.fixtureResponse(response, 400, ErrorResponse, "error response").error.message,
      message,
    );
  };
  // The method alone decides it, so Agent create and update refuse it as deployment does.
  for (const harnessAuth of [{ method: "runtime" }, { method: "codex_pat", source: secret.ref }]) {
    refused(
      await fixture.request("PATCH", agentPath, {
        body: { configurationId: configuration.id, harnessAuth },
      }),
    );
    refused(
      await fixture.request("POST", agentsPath, {
        body: {
          name: `Embedded ${harnessAuth.method} Agent`,
          configurationId: configuration.id,
          executionMode: "embedded",
          harnessAuth,
        },
      }),
    );
  }
  // A Configuration that selects no model is a draft, so save admits the pair. Once it selects
  // one, deployment and the Agent's next update refuse the stored row with the same message.
  const draft = await fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const draftData = fixture.fixtureResponse(
    draft,
    201,
    ConfigurationResponse,
    "create draft Configuration",
  ).data;
  const stored = await fixture.request("POST", agentsPath, {
    body: {
      name: "Draft runtime Agent",
      configurationId: draftData.id,
      executionMode: "embedded",
      harnessAuth: { method: "runtime" },
    },
  });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const storedData = fixture.fixtureResponse(stored, 201, AgentResponse, "create draft Agent").data;
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${draftData.id}`,
    { body: { values: createHarnessConfiguration("openclaw", "gpt-4.1") } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const storedPath = `${agentsPath}/${storedData.id}`;
  refused(await fixture.request("POST", `${storedPath}/deploy`));
  refused(await fixture.request("PATCH", storedPath, { body: { configurationId: draftData.id } }));
  assert.equal((await fixture.request("GET", storedPath)).status, 200);
  // The fix the message names is accepted.
  const fixed = await fixture.request("PATCH", storedPath, {
    body: {
      configurationId: draftData.id,
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
});

test("first deployment requires Agent read and operate only when generating credentials", async () => {
  const fixture = await createFixture();
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();
  const deploySessions = [];
  for (const { label, agentActions, deniedAction } of [
    { label: "without-agent-read", agentActions: [], deniedAction: "read" },
    { label: "without-agent-operate", agentActions: ["read"], deniedAction: "operate" },
  ]) {
    const { principal, session } = await fixture.createPrincipal(label, (identity) => {
      const roleId = `deploy-${randomUUID()}`;
      grantRole(fixture.policy, identity.id, {
        id: roleId,
        bindingId: `${roleId}-binding`,
        namespaceId: namespace.id,
        resource: undefined,
        permissions: {
          agent: ["deploy", ...agentActions],
          configuration: ["read"],
          secret: ["operate"],
        },
      });
    });
    const denied = await fixture.request("POST", `${agentPath}/deploy`, { session });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.deepEqual(fixture.auditSink.events.at(-1)?.authorization, {
      principalId: principal.id,
      action: deniedAction,
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
    deploySessions.push(session);
  }
  assert.equal(
    fixture.computeDriver.calls.some(({ operation }) => operation === "provision"),
    false,
  );

  const prepared = await fixture.request("POST", `${agentPath}/runtime-credentials`, { body: {} });
  assert.equal(prepared.status, 200);
  const deploySession = deploySessions[0];
  assert.ok(deploySession);
  const admitted = await fixture.request("POST", `${agentPath}/deploy`, {
    session: deploySession,
  });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
});

test("failed first-deployment credential write does not admit a revision and can be retried", async () => {
  const leakedValue = `driver-leak-${randomUUID()}`;
  const fixture = await createFixture({
    computeDriver: createRuntimeCredentialComputeDriver({
      provisionError: new Error(`must not leak ${leakedValue}`),
    }),
  });
  const { agentPath } = await fixture.bootstrapAgent();

  // A remote Secret can be stored before its response is lost; retries must inspect it.
  const failed = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(JSON.stringify(failed.body).includes(leakedValue), false);
  const revisionsBeforeRetry = await fixture.request("GET", `${agentPath}/revisions`);
  assert.equal(revisionsBeforeRetry.status, 200);
  assert.equal(
    fixture.fixtureResponse(
      revisionsBeforeRetry,
      200,
      AgentRevisionListResponse,
      "list revisions before retry",
    ).data.length,
    0,
  );

  const retried = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  assert.equal(
    fixture.fixtureResponse(retried, 202, AgentRevisionResponse, "retry deployment").data.revision,
    1,
  );
  assert.equal(
    fixture.computeDriver.calls.filter(({ operation }) => operation === "provision").length,
    1,
  );
});

test("runtime credential POST accepts empty input when only transport provisioning is needed", async () => {
  const fixture = await createFixture();
  const { namespace, agent, credentialsPath: path } = await fixture.bootstrapAgent();
  fixture.computeDriver.setStatus(namespace.id, agent.id, {
    transportConfigured: false,
  });

  const provisioned = await fixture.request("POST", path, { body: {} });
  assert.equal(provisioned.status, 200);
  assert.deepEqual(provisioned.data, {
    transportConfigured: true,
  });
  assert.deepEqual(fixture.computeDriver.calls.at(-1)?.input, {});
});

test("runtime credential POST rejects channel token bodies before driver provisioning", async () => {
  const fixture = await createFixture();
  const { credentialsPath: path } = await fixture.bootstrapAgent();
  const appToken = `xapp-${randomUUID()}`;

  const rejected = await fixture.request("POST", path, {
    body: { slack: { appToken, botToken: "xoxb-test" } },
  });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(rejected.body).includes(appToken), false);
  assert.equal(fixture.computeDriver.calls.length, 0);
});

test("runtime credential POST keeps session CSRF and exact Agent read plus operate authorization", async () => {
  const fixture = await createFixture();
  const { namespace, agent, credentialsPath: path } = await fixture.bootstrapAgent();

  const wrongLoopbackOrigin = fixture.origin.replace(/:\d+$/, ":1");
  const csrfRejected = await fixture.request("POST", path, {
    origin: wrongLoopbackOrigin,
    body: {},
  });
  assertApiError(csrfRejected, 403, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);

  // Each grant is required on its own: operate without read, then read without operate.
  for (const [held, missing] of [
    ["operate", "read"],
    ["read", "operate"],
  ] as const) {
    const roleId = `runtime-${held}-without-${missing}`;
    const { principal, session } = await fixture.createPrincipal(roleId, (limited) => {
      grantRole(fixture.policy, limited.id, {
        id: roleId,
        bindingId: `${roleId}-binding`,
        namespaceId: namespace.id,
        permissions: { agent: [held] },
        resource: undefined,
      });
    });
    assertDenied(fixture, await fixture.request("POST", path, { session, body: {} }), {
      principalId: principal.id,
      action: missing,
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
  }
});

test("runtime credential API rejects unsupported initial provisioning states and request shapes", async () => {
  const fixture = await createFixture();
  const { agentPath, credentialsPath: path } = await fixture.bootstrapAgent();
  const invalidBodies = [
    { modelApiKey: "legacy-model-secret" },
    { modelApiKey: "valid", extra: "unsupported" },
    { slack: { appToken: "xapp-valid" } },
    { slack: { appToken: "xapp-valid", botToken: "xoxb-valid", extra: "unsupported" } },
  ];

  for (const body of invalidBodies) {
    const rejected = await fixture.request("POST", path, { body });
    assertApiError(rejected, 400, "INVALID_REQUEST");
  }
  assert.equal(fixture.computeDriver.calls.length, 0);

  const generated = await fixture.request("POST", path, { body: {} });
  assert.equal(generated.status, 200);

  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const deployedRejected = await fixture.request("POST", path, {
    body: {},
  });
  assertApiError(deployedRejected, 409, "RESOURCE_CONFLICT");
});

test("deployment diagnostics require exact revision read and Agent operate authorization", async () => {
  const fixture = await createFixture();
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const revisionData = fixture.fixtureResponse(
    revision,
    202,
    AgentRevisionResponse,
    "deploy Agent",
  ).data;
  // Deployment provisions connection credentials; the assertions below cover diagnostics only.
  fixture.computeDriver.calls.length = 0;
  const path = `${agentPath}/deployments/${revisionData.id}/diagnostics`;

  const { principal, session } = await fixture.createPrincipal(
    "deployment-diagnostics-reader",
    (limited) => {
      grantRole(fixture.policy, limited.id, {
        id: "diagnostics-revision-reader",
        bindingId: "diagnostics-revision-reader-binding",
        namespaceId: namespace.id,
        permissions: { agent_revision: ["read"] },
        resource: { kind: "agent_revision", id: revisionData.id },
      });
    },
  );
  assertDenied(fixture, await fixture.request("POST", path, { session }), {
    principalId: principal.id,
    action: "operate",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });

  grantRole(fixture.policy, principal.id, {
    id: "diagnostics-agent-operator",
    bindingId: "diagnostics-agent-operator-binding",
    namespaceId: namespace.id,
    permissions: { agent: ["operate"] },
    resource: { kind: "agent", id: agent.id },
  });
  assertDenied(fixture, await fixture.request("POST", path, { session }), {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  });

  grantRole(fixture.policy, principal.id, {
    id: "diagnostics-agent-reader",
    bindingId: "diagnostics-agent-reader-binding",
    namespaceId: namespace.id,
    permissions: { agent: ["read"] },
    resource: { kind: "agent", id: agent.id },
  });
  const scopedDiagnostics = await fixture.request("POST", path, { session });
  assert.equal(scopedDiagnostics.status, 200);
  assert.equal(
    fixture.fixtureResponse(
      scopedDiagnostics,
      200,
      AgentDeploymentDiagnosticsResponse,
      "scoped diagnostics",
    ).data.revisionId,
    revisionData.id,
  );
  assert.deepEqual(fixture.computeDriver.calls, [
    { operation: "diagnostics", agentId: agent.id, revisionId: revisionData.id },
  ]);
  fixture.computeDriver.calls.length = 0;

  const diagnostics = await fixture.request("POST", path);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual(diagnostics.data, {
    revisionId: revisionData.id,
    observedAt: "2026-01-02T03:04:05.000Z",
    checks: [
      {
        component: "gateway",
        check: "connectivity",
        state: "failed",
        checkedAt: "2026-01-02T03:04:04.000Z",
        code: "DISCONNECTED",
      },
      // Values outside the runtime's vocabulary are not returned as served (finding 1673).
      {
        component: "UNRECOGNIZED",
        check: "UNRECOGNIZED",
        state: "succeeded",
        checkedAt: "2026-01-02T03:04:04.000Z",
        code: "UNRECOGNIZED",
      },
    ],
  });
  assert.deepEqual(fixture.computeDriver.calls, [
    { operation: "diagnostics", agentId: agent.id, revisionId: revisionData.id },
  ]);

  // Revoking revision access must deny an otherwise authorized Agent operator.
  const revisionBindingIndex = fixture.policy.bindings.findIndex(
    (binding) => binding.id === "diagnostics-revision-reader-binding",
  );
  assert.notEqual(revisionBindingIndex, -1);
  fixture.policy.bindings.splice(revisionBindingIndex, 1);
  fixture.computeDriver.calls.length = 0;
  assertDenied(fixture, await fixture.request("POST", path, { session }), {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent_revision", id: revisionData.id, namespaceId: namespace.id },
  });
});

test("runtime credential driver and audit failures stay sanitized and recoverable through GET", async () => {
  const leakedDriverValue = `driver-leak-${randomUUID()}`;
  const driverFailureFixture = await createFixture({
    computeDriver: createRuntimeCredentialComputeDriver({
      provisionError: new Error(`must not leak ${leakedDriverValue}`),
    }),
  });
  const { credentialsPath: failedPath } = await driverFailureFixture.bootstrapAgent();
  const failed = await driverFailureFixture.request("POST", failedPath, {
    body: {},
  });
  assertApiError(failed, 503, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.body).includes(leakedDriverValue), false);
  assert.equal(
    JSON.stringify(driverFailureFixture.auditSink.events).includes(leakedDriverValue),
    false,
  );
  const recovered = await driverFailureFixture.request("GET", failedPath);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, {
    transportConfigured: true,
  });

  const leakedAuditValue = `audit-leak-${randomUUID()}`;
  const auditSink = new InMemoryAuditSink();
  const originalAppend = auditSink.append.bind(auditSink);
  auditSink.append = async (event) => {
    if (event.action === "openclaw.agents.runtime_credentials.provision") {
      throw new Error(`must not leak ${leakedAuditValue}`);
    }
    await originalAppend(event);
  };
  const auditFailureFixture = await createFixture({ auditSink });
  const { credentialsPath: auditPath } = await auditFailureFixture.bootstrapAgent();
  const auditFailed = await auditFailureFixture.request("POST", auditPath, {
    body: {},
  });
  assertApiError(auditFailed, 503, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(auditFailed.body).includes(leakedAuditValue), false);
  assert.equal(
    JSON.stringify(auditFailureFixture.auditSink.events).includes(leakedAuditValue),
    false,
  );
  const auditRecovered = await auditFailureFixture.request("GET", auditPath);
  assert.equal(auditRecovered.status, 200);
  assert.deepEqual(auditRecovered.data, {
    transportConfigured: true,
  });
});

test("a cluster denial of runtime credentials names the missing RoleBinding and logs the cause", async () => {
  const lines: LogLine[] = [];
  // The data-plane tenant-api RoleBinding is missing (D396).
  const fixture = await createFixture({
    logLines: lines,
    computeDriver: createRuntimeCredentialComputeDriver({
      statusError: new RuntimeCredentialsForbiddenByClusterError({
        verb: "get",
        resource: "secrets",
        kubernetesNamespace: "oce-90018df17b2b259",
        plane: "execution",
        status: 403,
      }),
    }),
  });
  const { agentPath } = await fixture.bootstrapAgent();
  const expected = {
    code: "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
    message:
      "The cluster denied OCC access needed for this Agent's runtime credentials. Ask a platform operator to grant the API ServiceAccount the documented tenant RoleBindings in the Agent's Kubernetes namespaces.",
  };

  const status = await fixture.request("GET", `${agentPath}/runtime-credentials`);
  assert.equal(status.status, 503, JSON.stringify(status.body));
  const statusError = fixture.fixtureResponse(
    status,
    503,
    ErrorResponse,
    "credential status",
  ).error;
  assert.deepEqual({ code: statusError.code, message: statusError.message }, expected);
  // The first deployment checks runtime credentials before admitting a revision.
  const deployed = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 503, JSON.stringify(deployed.body));
  const deploymentError = fixture.fixtureResponse(deployed, 503, ErrorResponse, "deployment").error;
  assert.deepEqual({ code: deploymentError.code, message: deploymentError.message }, expected);

  const warnings = lines.filter(
    (line) => line.event === "agent_runtime_credentials.cluster_denied",
  );
  assert.equal(warnings.length, 2, JSON.stringify(lines));
  for (const [warning, response] of [
    [warnings[0], status],
    [warnings[1], deployed],
  ] as const) {
    assert.ok(warning);
    assert.equal(warning.severity, "WARN");
    assert.equal(
      warning.requestId,
      fixture.fixtureResponse(response, 503, ErrorResponse, "cluster denial").meta.requestId,
    );
    assert.deepEqual(
      {
        verb: warning.verb,
        resource: warning.resource,
        kubernetesNamespace: warning.kubernetesNamespace,
        plane: warning.plane,
        kubernetesStatus: warning.kubernetesStatus,
      },
      {
        verb: "get",
        resource: "secrets",
        kubernetesNamespace: "oce-90018df17b2b259",
        plane: "execution",
        kubernetesStatus: 403,
      },
    );
  }
});

const marker = `private-driver-detail-${randomUUID()}`;
for (const [name, diagnostics] of [
  ...[ResourceConflictError, ScopeViolationError].map(
    (DriverError) =>
      [
        `sanitize ${DriverError.name} from Drivers`,
        { diagnosticsError: new DriverError(marker) },
      ] as const,
  ),
  [
    "retain only the fixed private Gateway transport category in operator logs",
    {
      diagnosticsError: Object.assign(new RuntimeDiagnosticsTransportError(), {
        message: marker,
        cause: new Error(marker),
      }),
    },
  ] as const,
  ["reject a null Driver response as unavailable", { diagnosticsResult: null }] as const,
]) {
  test(`deployment diagnostics ${name}`, async () => {
    const lines: LogLine[] = [];
    const fixture = await createFixture({
      logLines: lines,
      computeDriver: createRuntimeCredentialComputeDriver(diagnostics),
    });
    const { agentPath } = await fixture.bootstrapAgent();
    const revision = await fixture.request("POST", `${agentPath}/deploy`);
    assert.equal(revision.status, 202);
    const revisionData = fixture.fixtureResponse(
      revision,
      202,
      AgentRevisionResponse,
      "deploy Agent",
    ).data;
    const result = await fixture.request(
      "POST",
      `${agentPath}/deployments/${revisionData.id}/diagnostics`,
    );
    assertApiError(result, 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(JSON.stringify(result.body).includes(marker), false);
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);
    assert.equal(JSON.stringify(lines).includes(marker), false);
    if (diagnostics.diagnosticsError instanceof RuntimeDiagnosticsTransportError) {
      const logged = lines.find((line) => line.event === "http.dependency_unavailable");
      assert.ok(logged);
      assert.equal(logged.errorClass, "RuntimeDiagnosticsTransportError");
      assert.equal(logged.message, "The private Gateway diagnostics transport is unavailable.");
      assert.equal(
        logged.requestId,
        fixture.fixtureResponse(result, 503, ErrorResponse, "diagnostics failure").meta.requestId,
      );
      assert.equal(logged.causes, undefined);
    }
  });
}

test("deployment diagnostics refuse a Compute Driver with the deployment's id but another implementation", async () => {
  const fixture = await createFixture();
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const revisionData = fixture.fixtureResponse(
    revision,
    202,
    AgentRevisionResponse,
    "deploy Agent",
  ).data;
  const diagnose = (computeDriver: ComputeDriver) =>
    fixture
      .restartController(computeDriver)
      .diagnoseAgentDeployment(fixture.administratorId, namespace.id, agent.id, revisionData.id);
  // The same id and implementation still diagnose after the restart.
  const unchanged = createRuntimeCredentialComputeDriver();
  assert.equal((await diagnose(unchanged)).revisionId, revisionData.id);
  assert.equal(unchanged.calls.length, 1);
  const replacement = createRuntimeCredentialComputeDriver({
    implementation: "replacement-runtime-credential-test",
  });
  assert.equal(replacement.id, unchanged.id);
  await assert.rejects(diagnose(replacement), {
    name: "DependencyUnavailableError",
    message: "The deployment's Compute Driver is unavailable.",
  });
  assert.deepEqual(replacement.calls, []);
});

test("deployment diagnostics reject invalid Driver evidence", async () => {
  const diagnosticOptions: RuntimeCredentialDriverOptions = { diagnosticsResult: null };
  const fixture = await createFixture({
    computeDriver: createRuntimeCredentialComputeDriver(diagnosticOptions),
  });
  const { agentPath } = await fixture.bootstrapAgent();
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const revisionData = fixture.fixtureResponse(
    revision,
    202,
    AgentRevisionResponse,
    "deploy Agent",
  ).data;
  const path = `${agentPath}/deployments/${revisionData.id}/diagnostics`;
  const check = {
    component: "gateway",
    check: "connectivity",
    state: "unknown" as const,
    checkedAt: "2026-01-02T03:04:04.000Z",
  };
  const base = {
    revisionId: revisionData.id,
    observedAt: "2026-01-02T03:04:05.000Z",
    checks: [check],
  };
  for (const [name, diagnosticsResult] of [
    ["revision binding", { ...base, revisionId: `rev_${randomUUID()}` }],
    ["observation time", { ...base, observedAt: "2026-01-02" }],
    ["check time", { ...base, checks: [{ ...check, checkedAt: "2026-01-02" }] }],
    ["component", { ...base, checks: [{ ...check, component: "gateway status" }] }],
    ["check", { ...base, checks: [{ ...check, check: "private status" }] }],
    ["code", { ...base, checks: [{ ...check, code: "private token value" }] }],
  ] as const) {
    diagnosticOptions.diagnosticsResult = diagnosticsResult;
    const result = await fixture.request("POST", path);
    assertApiError(result, 503, "DEPENDENCY_UNAVAILABLE", name);
    assert.equal(JSON.stringify(result.body).includes("private token value"), false, name);
  }
});
