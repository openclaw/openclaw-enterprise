import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  ResourceConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createControllerAuth } from "../helpers/password-hasher.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createReadyComputeDriver, registerAndSelectDrivers } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { reservePort } from "../helpers/available-port.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { EMBEDDED_API_KEY_REQUIRED } from "../helpers/refusal-text.mjs";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);

function createRuntimeCredentialComputeDriver(options = {}) {
  const statusByAgent = new Map();
  const calls = [];
  const diagnosticObservedAt = "2026-01-02T03:04:05.000Z";
  const diagnosticCheckedAt = "2026-01-02T03:04:04.000Z";
  const emptyStatus = Object.freeze({
    transportConfigured: false,
  });
  const keyOf = (binding) => `${binding.namespace.id}:${binding.agent.id}`;
  const explicitKeyOf = (namespaceId, agentId) => `${namespaceId}:${agentId}`;
  const statusOf = (binding) => statusByAgent.get(keyOf(binding)) ?? emptyStatus;

  return createReadyComputeDriver(options.id ?? "runtime-credential-compute", {
    implementation: options.implementation ?? "in-memory-runtime-credential-test",
    requiresAgentRuntimeCredentials: true,
    calls,
    setStatus(namespaceId, agentId, status) {
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
    async diagnoseAgentDeployment(binding) {
      calls.push({
        operation: "diagnostics",
        agentId: binding.agent.id,
        revisionId: binding.revision.id,
      });
      if (options.diagnosticsError !== undefined) {
        throw options.diagnosticsError;
      }
      if (Object.hasOwn(options, "diagnosticsResult")) {
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
}

// Namespace setup is outside these admission cases; no Kubernetes cluster is contacted.
function createKubernetesComputeDriver() {
  const computeDriver = createTestKubernetesComputeDriver("runtime-credential-compute");
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
const running = {};
const apps = new Map();
const cleanup = [];
after(() => Promise.all(cleanup.map((step) => step())));

function forwarder(identity, target) {
  return new Proxy(identity, {
    get(pinned, key) {
      if (Object.hasOwn(pinned, key)) {
        return pinned[key];
      }
      const value = target()[key];
      return typeof value === "function" ? value.bind(target()) : value;
    },
    has: (pinned, key) => Object.hasOwn(pinned, key) || key in target(),
  });
}

async function createSharedApp(implementation) {
  const installationId = `ins_${randomUUID()}`;
  // The port is part of the auth base URL and origin, so hold it until the app binds it; a
  // released probe port can be taken by another socket while the account and app are built.
  const reservation = await reservePort();
  cleanup.push(reservation.release);
  const origin = `http://127.0.0.1:${reservation.port}`;
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL: origin,
    secret: `runtime-credential-test-secret-${randomUUID()}`,
    memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
  });
  const createAccount = async (label, name, grant) => {
    const credentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `runtime-password-${randomUUID()}`,
      name,
    };
    const seed = auth.principalSeed(await auth.createAccount(credentials), { grant });
    return { seed, signIn: () => signInWithEmailPassword({ origin, ...credentials }) };
  };
  const administrator = await createAccount(
    "runtime-admin",
    "Runtime Credential Administrator",
    "administrator",
  );
  const { seed } = administrator;
  const policy = { groups: [], memberships: [], restrictions: [] };
  const principals = [];
  let principalsUsed;
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
  let controller;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    publicOrigin: origin,
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
              .map((line) => JSON.parse(line)),
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
    await app.listen({
      host: "127.0.0.1",
      port: reservation.port,
      reusePort: reservation.reusePort,
    });
    cleanup.push(() => app.close());
  } finally {
    await reservation.release();
  }
  const adminSession = await administrator.signIn();

  async function request(
    method,
    path,
    { session = adminSession, body, origin: requestOrigin = origin } = {},
  ) {
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...authenticatedHeaders(session),
        ...(mutation ? { origin: requestOrigin } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const payload = text.length === 0 ? undefined : JSON.parse(text);
    if (payload !== undefined) {
      assert.match(payload.meta?.requestId ?? "", identifier("req"));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    return { status: response.status, body: payload, data: payload?.data };
  }

  const installed = await request("POST", "/installation/bootstrap", {
    body: { name: "Runtime credential test" },
  });
  assert.equal(installed.status, 201);

  async function bootstrapAgent(values = createHarnessConfiguration("openclaw", "gpt-4.1")) {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `runtime-namespace-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201);
    await controller.handleNamespaceLifecycle(seed.principal.id, namespace.data.id, "ready");
    const secret = await request("POST", `/namespaces/${namespace.data.id}/secrets`, {
      body: { name: "Model API key", value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201);
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      body: {
        kind: "agent",
        values,
      },
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      body: {
        name: "Runtime credential Agent",
        configurationId: configuration.data.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
    });
    assert.equal(agent.status, 201);
    const servicePrincipalId = `service-agent-${agent.data.id}`;
    const roleId = `auth-${agent.data.id}`;
    policy.identities.push({
      id: servicePrincipalId,
      kind: "service_principal",
      namespaceId: namespace.data.id,
      agentId: agent.data.id,
    });
    grantRole(policy, servicePrincipalId, {
      id: roleId,
      namespaceId: namespace.data.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.data.id },
    });
    return {
      namespace: namespace.data,
      configuration: configuration.data,
      agent: agent.data,
      secret: secret.data,
      agentPath: `/namespaces/${namespace.data.id}/agents/${agent.data.id}`,
      credentialsPath: `/namespaces/${namespace.data.id}/agents/${agent.data.id}/runtime-credentials`,
    };
  }

  // A controller restarted on the same state with another Compute Driver, as after the
  // Installation's Driver configuration changed. Unlike the app's, this Driver is selected
  // directly, so its own id and implementation reach OCC.
  function restartController(computeDriver) {
    const restarted = new OpenClawController(controller.installation, {
      state: platformState,
      recordOperations: false,
    });
    registerAndSelectDrivers(restarted, [iamDriver, computeDriver]);
    return restarted;
  }

  async function createPrincipal(label, configurePolicy) {
    if (principalsUsed === principals.length) {
      const { seed: created, signIn } = await createAccount(label, label, "none");
      principals.push({ principal: created.principal, session: await signIn() });
    }
    const pooled = principals[principalsUsed++];
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
    resetPolicy,
    restartController,
  };
}

async function createFixture({
  computeDriver = createRuntimeCredentialComputeDriver(),
  auditSink = new InMemoryAuditSink(),
  logLines = [],
} = {}) {
  const { implementation } = computeDriver;
  if (!apps.has(implementation)) {
    // Building the app signs the administrator in, which audits and logs: into a sink and lines
    // no case reads, so a case sees only its own.
    Object.assign(running, { computeDriver, auditSink: new InMemoryAuditSink(), logLines: [] });
    apps.set(implementation, createSharedApp(implementation));
  }
  const shared = await apps.get(implementation);
  Object.assign(running, { computeDriver, auditSink, logLines });
  shared.resetPolicy();
  return { ...shared, auditSink, computeDriver };
}

// A 403 that reached no Compute Driver call and was audited as this authorization denial.
function assertDenied(fixture, response, authorization) {
  assertApiError(response, 403, "FORBIDDEN");
  assert.equal(fixture.computeDriver.calls.length, 0);
  const denial = fixture.auditSink.events.at(-1);
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
  assert.deepEqual(fixture.computeDriver.calls[1].input, {});

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
  assert.equal(first.data.revision, 1);
  const credentials = await fixture.request("GET", `${agentPath}/runtime-credentials`);
  assert.equal(credentials.status, 200);
  assert.equal(credentials.data.transportConfigured, true);

  const second = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(second.status, 202, JSON.stringify(second.body));
  assert.equal(second.data.revision, 2);
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
  assert.equal(revisions.data.length, 2);
});

test("Kubernetes without managed runtime credentials admits a draft deployment", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { agent, agentPath } = await fixture.bootstrapAgent();
  // This credential-admission fixture has no Gateway runtime to apply managed mode.
  const updated = await fixture.request("PATCH", agentPath, {
    body: { configurationId: agent.configurationId, gatewayManagedMode: false },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const admitted = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  assert.equal(admitted.data.revision, 1);
});

test("Kubernetes deploy names an unsupported Harness authentication model provider", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  const { openai } = values.models.providers;
  values.agents.defaults = {
    model: "zai/glm-5",
    models: { "zai/glm-5": { agentRuntime: { id: "openclaw" } } },
  };
  values.models.providers = {
    zai: { ...openai, models: [{ ...openai.models[0], id: "glm-5", name: "glm-5" }] },
  };
  // The Configuration alone is valid: only the Agent's api_key binding, which the Kubernetes
  // Driver projects only for providers it knows, makes the pair undeliverable.
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stored = await fixture.request("GET", agentPath);
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${stored.data.configurationId}`,
    { body: { values } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const message =
    "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.";

  // The caller must learn that, not that the resource already exists: deployment refuses the
  // pair, and so does the Agent's next save (finding 1117).
  const refused = await fixture.request("POST", `${agentPath}/deploy`);
  assertApiError(refused, 409, "RESOURCE_CONFLICT");
  assert.equal(refused.body.error.message, message);
  const updated = await fixture.request("PATCH", agentPath, {
    body: { configurationId: stored.data.configurationId },
  });
  assert.equal(updated.status, 409, JSON.stringify(updated.body));
  assert.equal(updated.body.error.message, message);
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Unsupported provider Agent",
      configurationId: stored.data.configurationId,
      executionMode: "embedded",
      harnessAuth: stored.data.harnessAuth,
    },
  });
  assert.equal(created.status, 409, JSON.stringify(created.body));
  assert.equal(created.body.error.message, message);
  // The stored Agent still reads.
  assert.equal((await fixture.request("GET", agentPath)).status, 200);
});

test("Kubernetes names a model provider reference the startup model check cannot resolve", async () => {
  const fixture = await createFixture({ computeDriver: createKubernetesComputeDriver() });
  const { namespace, agent } = await fixture.bootstrapAgent();
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  values.models.providers.openai.baseUrl = "${MODEL_HOST}";
  // Configuration save accepts the reference: another Compute's runtime may resolve it.
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stored = await fixture.request("GET", agentPath);
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${stored.data.configurationId}`,
    { body: { values } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  // Kubernetes probes the model with only the api_key binding's credential, so deploy and the
  // Agent's saves name the setting and the reason, not a generic topology conflict (finding 2828).
  const message =
    "Configuration setting models.providers.openai.baseUrl must not hold an environment or Secret reference: the startup model check on Kubernetes gets only the Harness credential.";
  const refused = (response) => {
    assertApiError(response, 400, "INVALID_REQUEST");
    assert.equal(response.body.error.message, message);
  };
  refused(await fixture.request("POST", `${agentPath}/deploy`));
  refused(
    await fixture.request("PATCH", agentPath, {
      body: { configurationId: stored.data.configurationId },
    }),
  );
  refused(
    await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Probe reference Agent",
        configurationId: stored.data.configurationId,
        executionMode: "embedded",
        harnessAuth: stored.data.harnessAuth,
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
  const refused = (response) => {
    assertApiError(response, 400, "INVALID_REQUEST");
    assert.equal(response.body.error.message, message);
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
  const stored = await fixture.request("POST", agentsPath, {
    body: {
      name: "Draft runtime Agent",
      configurationId: draft.data.id,
      executionMode: "embedded",
      harnessAuth: { method: "runtime" },
    },
  });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const replaced = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${draft.data.id}`,
    { body: { values: createHarnessConfiguration("openclaw", "gpt-4.1") } },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const storedPath = `${agentsPath}/${stored.data.id}`;
  refused(await fixture.request("POST", `${storedPath}/deploy`));
  refused(await fixture.request("PATCH", storedPath, { body: { configurationId: draft.data.id } }));
  assert.equal((await fixture.request("GET", storedPath)).status, 200);
  // The fix the message names is accepted.
  const fixed = await fixture.request("PATCH", storedPath, {
    body: {
      configurationId: draft.data.id,
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
        permissions: {
          agent: ["deploy", ...agentActions],
          configuration: ["read"],
          secret: ["operate"],
        },
      });
    });
    const denied = await fixture.request("POST", `${agentPath}/deploy`, { session });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.deepEqual(fixture.auditSink.events.at(-1).authorization, {
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
  const admitted = await fixture.request("POST", `${agentPath}/deploy`, {
    session: deploySessions[0],
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
  assert.equal(revisionsBeforeRetry.data.length, 0);

  const retried = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  assert.equal(retried.data.revision, 1);
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
  assert.deepEqual(fixture.computeDriver.calls.at(-1).input, {});
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
  ]) {
    const roleId = `runtime-${held}-without-${missing}`;
    const { principal, session } = await fixture.createPrincipal(roleId, (limited) => {
      grantRole(fixture.policy, limited.id, {
        id: roleId,
        bindingId: `${roleId}-binding`,
        namespaceId: namespace.id,
        permissions: { agent: [held] },
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
  // Deployment provisions connection credentials; the assertions below cover diagnostics only.
  fixture.computeDriver.calls.length = 0;
  const path = `${agentPath}/deployments/${revision.data.id}/diagnostics`;

  const { principal, session } = await fixture.createPrincipal(
    "deployment-diagnostics-reader",
    (limited) => {
      grantRole(fixture.policy, limited.id, {
        id: "diagnostics-revision-reader",
        bindingId: "diagnostics-revision-reader-binding",
        namespaceId: namespace.id,
        permissions: { agent_revision: ["read"] },
        resource: { kind: "agent_revision", id: revision.data.id },
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
  assert.equal(scopedDiagnostics.data.revisionId, revision.data.id);
  assert.deepEqual(fixture.computeDriver.calls, [
    { operation: "diagnostics", agentId: agent.id, revisionId: revision.data.id },
  ]);
  fixture.computeDriver.calls.length = 0;

  const diagnostics = await fixture.request("POST", path);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual(diagnostics.data, {
    revisionId: revision.data.id,
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
    { operation: "diagnostics", agentId: agent.id, revisionId: revision.data.id },
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
    resource: { kind: "agent_revision", id: revision.data.id, namespaceId: namespace.id },
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
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "DEPENDENCY_UNAVAILABLE");
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
  assert.equal(auditFailed.status, 503);
  assert.equal(auditFailed.body.error.code, "DEPENDENCY_UNAVAILABLE");
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
  const lines = [];
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
  assert.deepEqual({ code: status.body.error.code, message: status.body.error.message }, expected);
  // The first deployment checks runtime credentials before admitting a revision.
  const deployed = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 503, JSON.stringify(deployed.body));
  assert.deepEqual(
    { code: deployed.body.error.code, message: deployed.body.error.message },
    expected,
  );

  const warnings = lines.filter(
    (line) => line.event === "agent_runtime_credentials.cluster_denied",
  );
  assert.equal(warnings.length, 2, JSON.stringify(lines));
  for (const [warning, response] of [
    [warnings[0], status],
    [warnings[1], deployed],
  ]) {
    assert.equal(warning.severity, "WARN");
    assert.equal(warning.requestId, response.body.meta.requestId);
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
  ...[ResourceConflictError, ScopeViolationError].map((DriverError) => [
    `sanitize ${DriverError.name} from Drivers`,
    { diagnosticsError: new DriverError(marker) },
  ]),
  ["reject a null Driver response as unavailable", { diagnosticsResult: null }],
]) {
  test(`deployment diagnostics ${name}`, async () => {
    const fixture = await createFixture({
      computeDriver: createRuntimeCredentialComputeDriver(diagnostics),
    });
    const { agentPath } = await fixture.bootstrapAgent();
    const revision = await fixture.request("POST", `${agentPath}/deploy`);
    assert.equal(revision.status, 202);
    const result = await fixture.request(
      "POST",
      `${agentPath}/deployments/${revision.data.id}/diagnostics`,
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(JSON.stringify(result.body).includes(marker), false);
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);
  });
}

test("deployment diagnostics refuse a Compute Driver with the deployment's id but another implementation", async () => {
  const fixture = await createFixture();
  const { namespace, agent, agentPath } = await fixture.bootstrapAgent();
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const diagnose = (computeDriver) =>
    fixture
      .restartController(computeDriver)
      .diagnoseAgentDeployment(fixture.administratorId, namespace.id, agent.id, revision.data.id);
  // The same id and implementation still diagnose after the restart.
  const unchanged = createRuntimeCredentialComputeDriver();
  assert.equal((await diagnose(unchanged)).revisionId, revision.data.id);
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
  const diagnosticOptions = { diagnosticsResult: null };
  const fixture = await createFixture({
    computeDriver: createRuntimeCredentialComputeDriver(diagnosticOptions),
  });
  const { agentPath } = await fixture.bootstrapAgent();
  const revision = await fixture.request("POST", `${agentPath}/deploy`);
  assert.equal(revision.status, 202);
  const path = `${agentPath}/deployments/${revision.data.id}/diagnostics`;
  const check = {
    component: "gateway",
    check: "connectivity",
    state: "unknown",
    checkedAt: "2026-01-02T03:04:04.000Z",
  };
  const base = {
    revisionId: revision.data.id,
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
  ]) {
    diagnosticOptions.diagnosticsResult = diagnosticsResult;
    const result = await fixture.request("POST", path);
    assert.equal(result.status, 503, name);
    assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE", name);
    assert.equal(JSON.stringify(result.body).includes("private token value"), false, name);
  }
});
