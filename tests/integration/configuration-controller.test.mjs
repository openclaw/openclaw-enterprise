import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { bindRole } from "../helpers/iam-grants.mjs";

function createConfigurationBackend() {
  // This deliberately simple substrate exercises the real Fastify, IAM, OCC, and audit paths.
  // Kubernetes transport and ConfigMap ownership are verified by the actual Driver's own tests.
  const configurations = new Map();
  const key = ({ namespaceId, id }) => `${namespaceId}/${id}`;
  return {
    id: "configuration-integration",
    capability: "configuration",
    implementation: "integration-memory-substrate",
    async create(configuration) {
      configurations.set(key(configuration), structuredClone(configuration));
      return configuration;
    },
    async read(reference) {
      return configurations.get(key(reference));
    },
    async update(configuration) {
      configurations.set(key(configuration), structuredClone(configuration));
      return configuration;
    },
    async delete(reference) {
      configurations.delete(key(reference));
    },
    async validate() {},
    storedConfigurations() {
      return [...configurations.values()].map((configuration) => structuredClone(configuration));
    },
  };
}

async function fixture({
  permissions,
  configurationDriver = createConfigurationBackend(),
  computeDriver,
  auditSink = new InMemoryAuditSink(),
} = {}) {
  const authFixture = await createTestAuthPrincipal({
    name: "Configuration Integration Administrator",
  });
  const principal = authFixture.seed.principal;
  const roles = [
    {
      id: "role-configuration-integration",
      permissions: permissions ?? authFixture.seed.roles[0].permissions,
    },
  ];
  const identities = [principal];
  const bindings = [
    {
      id: "binding-configuration-integration",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-configuration-integration",
    },
  ];
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities,
      groups: [],
      memberships: [],
      roles,
      bindings,
      restrictions: [],
    }),
  });
  let controller;
  const app = createControllerApp({
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
    iamDriver: iam,
    secretDriver: createTestSecretDriver(),
    ...(configurationDriver === null ? {} : { configurationDriver }),
    ...(computeDriver === undefined ? {} : { computeDriver }),
    resolveHarness: resolveApprovedDevelopmentHarness,
    auditSink,
    development: {
      enabled: true,
      issuer: principal.issuer,
      subject: principal.subject,
      principalId: principal.id,
      installationId: authFixture.installationId,
    },
    auth: authFixture.auth,
  });
  app.defaultSession = await signInToControllerApp(app, authFixture);

  return {
    app,
    principal,
    identities,
    roles,
    bindings,
    session: app.defaultSession,
    auditSink,
    get controller() {
      return controller;
    },
  };
}

async function request(
  app,
  method,
  pathname,
  { body, authorization = true, session = app.defaultSession } = {},
) {
  const headers = authorization ? authenticatedHeaders(session) : {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json(),
  };
}

async function bootstrapAndCreateNamespace(context) {
  const installed = await request(context.app, "POST", "/installation/bootstrap", {
    body: { name: "Configuration integration" },
  });
  assert.equal(installed.status, 201);
  const namespace = await request(context.app, "POST", "/namespaces", {
    body: { name: "Configuration tenant" },
  });
  assert.equal(namespace.status, 201);
  return namespace.body.data;
}

function createOpenClawConfiguration() {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "store", provider: "teamstore", id: "OPENAI_API_KEY" },
          headers: { "X-Request-Id": "request-123" },
        },
      },
    },
    secrets: {
      providers: { teamstore: { source: "store" } },
      defaults: { store: "teamstore" },
      egressProxy: { enabled: true },
    },
    agents: { defaults: { sandbox: { mode: "all" } } },
    plugins: {
      entries: {
        knowledge: {
          enabled: true,
          config: {
            thresholds: [0, 1.25, null],
            labels: ["search", "lookup"],
            fallback: null,
            note: "Bearer documentation-example",
            target: { provider: "openai", id: "gpt-5" },
          },
        },
      },
    },
  };
}

async function configureAgentHarnessSecret(context, namespace, agent, configurationId, secretName) {
  const harnessSecret = await context.controller.createSecret(context.principal.id, {
    namespaceId: namespace.id,
    name: secretName,
    value: "synthetic-configuration-key",
  });
  const admittedAgent = await context.controller.updateAgent(context.principal.id, {
    namespaceId: namespace.id,
    agentId: agent.body.data.id,
    configurationId,
    harnessAuth: { method: "api_key", source: harnessSecret.ref },
  });
  context.identities.push({
    kind: "service_principal",
    id: admittedAgent.servicePrincipalId,
    namespaceId: namespace.id,
    agentId: admittedAgent.id,
  });
  context.roles.push({
    id: "model-consumer",
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  bindRole(context, admittedAgent.servicePrincipalId, {
    id: "model-consumer",
    roleId: "model-consumer",
    namespaceId: namespace.id,
    resource: { kind: "secret", id: harnessSecret.id },
  });
}

test("native OpenClaw Configuration HTTP CRUD preserves documents, SecretRefs, exact scope, and audit", async () => {
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const values = createOpenClawConfiguration();

  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.data.id, /^cfg_[0-9a-f-]{36}$/);
  assert.equal(created.body.data.namespaceId, namespace.id);
  assert.equal(created.body.data.kind, "agent");
  assert.equal(created.body.data.generation, 1);
  assert.deepEqual(created.body.data.values, values);
  assert.deepEqual(configurationDriver.storedConfigurations()[0].values, values);
  const pathname = `${collection}/${created.body.data.id}`;

  const read = await request(context.app, "GET", pathname);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, created.body.data);

  // PATCH replaces the complete OpenClaw document; omitted nested sections must not survive.
  const replacement = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://replacement.example/v1",
          apiKey: { source: "store", provider: "teamstore", id: "REPLACEMENT_API_KEY" },
        },
      },
    },
    agents: { defaults: { sandbox: { mode: "off" } } },
  };
  const updated = await request(context.app, "PATCH", pathname, {
    body: { values: replacement },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.kind, "agent");
  assert.equal(updated.body.data.generation, 2);
  assert.deepEqual(updated.body.data.values, replacement);
  assert.deepEqual(configurationDriver.storedConfigurations()[0].values, replacement);

  const deleted = await request(context.app, "DELETE", pathname);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, undefined);

  const missing = await request(context.app, "GET", pathname);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
  assert.deepEqual(
    context.auditSink.events
      .filter((event) => event.resource.kind === "configuration")
      .map((event) => event.action),
    [
      "openclaw.configurations.create",
      "openclaw.configurations.update",
      "openclaw.configurations.delete",
    ],
  );
});

test("Configuration HTTP requires native supported requests and rejects immutable metadata changes", async () => {
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;

  for (const values of [null, [], "not-an-openclaw-document", 42]) {
    const invalid = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(configurationDriver.storedConfigurations(), []);
  }

  assert.equal(
    context.auditSink.events.some((event) => event.resource.kind === "configuration"),
    false,
    "rejected documents must never emit successful Configuration mutation audits",
  );

  for (const body of [
    { values: {} },
    { kind: "gateway", values: {} },
    { kind: "namespace", values: {} },
    { kind: "agent", generation: 1, values: {} },
  ]) {
    // Consumers cannot omit/invent kind or supply server-managed generation.
    const rejected = await request(context.app, "POST", collection, { body });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
  }
  assert.deepEqual(configurationDriver.storedConfigurations(), []);
  assert.equal(
    context.auditSink.events.some((event) => event.resource.kind === "configuration"),
    false,
    "rejected requests must never emit successful Configuration mutation audits",
  );

  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: { model: "stable" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  for (const body of [
    { kind: "agent", values: {} },
    { kind: "gateway", values: {} },
    { generation: 4, values: {} },
  ]) {
    const rejected = await request(context.app, "PATCH", `${collection}/${created.body.data.id}`, {
      body,
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
    // Clients that print only the message, such as occ, must still see which field to drop.
    const field = Object.keys(body).find((key) => key !== "values");
    assert.match(
      rejected.body.error.message,
      new RegExp(`: body /${field} is not an accepted field\\.$`),
    );
    assert.deepEqual(rejected.body.error.details, [{ path: `/${field}`, code: "UNKNOWN_FIELD" }]);
  }
  // A long unknown field name still fits the 256-character error message contract; the
  // name is cut, not the problem wording.
  const longField = await request(context.app, "PATCH", `${collection}/${created.body.data.id}`, {
    body: { values: {}, ["x".repeat(400)]: true },
  });
  assert.equal(longField.status, 400, JSON.stringify(longField.body));
  assert.equal(longField.body.error.message.length, 256, longField.body.error.message);
  assert.match(longField.body.error.message, /: body \/x+… is not an accepted field\.$/);

  const unchanged = await request(context.app, "GET", `${collection}/${created.body.data.id}`);
  assert.deepEqual(unchanged.body.data, created.body.data);
});

test("Configuration HTTP names a model provider baseUrl or api the runtime cannot use", async () => {
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const provider = (settings) => ({ models: { providers: { openai: settings } } });
  const baseUrlMessage = (field) =>
    `Configuration field ${field} must be an absolute http or https URL.`;
  const apiMessage = (field) =>
    `Configuration field ${field} must name a model API the runtime supports, such as openai-responses, openai-completions or anthropic-messages.`;
  // These values used to save and then fail deployment as an unexplained model probe
  // failure; the save now answers a 400 naming the field and stores nothing.
  for (const [values, message] of [
    [
      provider({ baseUrl: "not a url", api: "openai-responses" }),
      baseUrlMessage("/models/providers/openai/baseUrl"),
    ],
    [
      provider({ baseUrl: "ftp://models.example/v1" }),
      baseUrlMessage("/models/providers/openai/baseUrl"),
    ],
    [
      provider({ baseUrl: "https://api.openai.com/v1", api: "openai-bogus" }),
      apiMessage("/models/providers/openai/api"),
    ],
    [
      provider({
        models: [
          { id: "a", name: "a" },
          { id: "b", name: "b", baseUrl: "/v1" },
        ],
      }),
      baseUrlMessage("/models/providers/openai/models/1/baseUrl"),
    ],
    // Only a provider's blank baseUrl means "use the built-in default"; a model's must be set.
    [
      provider({ models: [{ id: "a", name: "a", baseUrl: "" }] }),
      baseUrlMessage("/models/providers/openai/models/0/baseUrl"),
    ],
  ]) {
    const rejected = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
    assert.equal(rejected.body.error.message, message);
  }
  assert.deepEqual(configurationDriver.storedConfigurations(), []);

  const values = createOpenClawConfiguration();
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${collection}/${created.body.data.id}`;
  const failedUpdate = await request(context.app, "PATCH", item, {
    body: { values: provider({ models: [{ id: "a", name: "a", api: 7 }] }) },
  });
  assert.equal(failedUpdate.status, 400);
  assert.equal(
    failedUpdate.body.error.message,
    apiMessage("/models/providers/openai/models/0/api"),
  );
  const unchanged = await request(context.app, "GET", item);
  assert.deepEqual(unchanged.body.data, created.body.data);
  // Any API id the pinned runtime accepts, on a provider or a model, still saves, as do a
  // blank provider baseUrl (the runtime's built-in default) and `${VAR}` references the
  // runtime resolves before it validates.
  const local = {
    models: {
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          models: [{ id: "m", name: "m", api: "openai-completions", baseUrl: "http://[::1]:9/v1" }],
        },
        openai: { baseUrl: "" },
        gateway: { baseUrl: "${PRIVATE_GATEWAY_URL}", api: "${GATEWAY_MODEL_API}" },
        fallback: { baseUrl: "${FALLBACK_URL:-https://models.example/v1}", api: "${API:-ollama}" },
      },
    },
  };
  const updated = await request(context.app, "PATCH", item, { body: { values: local } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.values, local);
});

test("Configuration HTTP refuses a model provider models setting that is not a list", async () => {
  // Finding 1186: the credential rules walk only a list of model rows, so a record of rows
  // carried a literal credential header past them into storage, and OpenClaw refused the
  // document only when the Gateway started. Every provider is checked, selected or not.
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const sentinel = "synthetic-model-credential-not-for-configuration";
  const message = (key) => `Configuration setting ${key}.models must be an array of model entries.`;
  for (const [values, setting] of [
    [
      {
        models: {
          providers: {
            gateway: { models: { m: { id: "m", headers: { "x-api-key": sentinel } } } },
          },
        },
      },
      "models.providers.gateway",
    ],
    [
      { models: { providers: { "my gateway": { models: null } } } },
      'models.providers["my gateway"]',
    ],
    [{ models: { providers: { openai: { models: "gpt-5" } } } }, "models.providers.openai"],
  ]) {
    const rejected = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
    assert.equal(rejected.body.error.message, message(setting));
  }
  assert.deepEqual(configurationDriver.storedConfigurations(), []);

  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: createOpenClawConfiguration() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${collection}/${created.body.data.id}`;
  const failedUpdate = await request(context.app, "PATCH", item, {
    body: { values: { models: { providers: { gateway: { models: {} } } } } },
  });
  assert.equal(failedUpdate.status, 400, JSON.stringify(failedUpdate.body));
  assert.equal(failedUpdate.body.error.message, message("models.providers.gateway"));
  const unchanged = await request(context.app, "GET", item);
  assert.deepEqual(unchanged.body.data, created.body.data);
  // A list, an empty one, or no models setting still saves.
  const listed = { models: { providers: { gateway: { models: [] }, openai: {} } } };
  const updated = await request(context.app, "PATCH", item, { body: { values: listed } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.values, listed);
});

test("Configuration save refuses an agents roster every deployment refuses, with deployment's text", async () => {
  // Deployment runs the real Kubernetes Compute roster rules, as production admission does.
  const kubernetes = createTestKubernetesComputeDriver("compute-roster-integration");
  const computeDriver = createReadyComputeDriver("compute-configuration-integration", {
    implementation: "integration-compute-substrate",
    validateHarnessAuth: (...args) => kubernetes.validateHarnessAuth(...args),
  });
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver, computeDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  // A selected model and runtime, so deployment reaches the roster rules.
  const defaults = {
    model: "openai/gpt-4.1",
    models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
  };
  const withAgents = (agents) => ({ agents: { defaults, ...agents } });
  const valid = withAgents({});
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: valid },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const item = `${collection}/${configurationId}`;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "Roster consumer", configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await configureAgentHarnessSecret(context, namespace, agent, configurationId, "roster-key");
  const deploy = () =>
    request(context.app, "POST", `/namespaces/${namespace.id}/agents/${agent.body.data.id}/deploy`);
  // A row an older release saved, written past OCC as that release's create would have.
  const storeAsOlderRelease = async (values) => {
    const stored = configurationDriver
      .storedConfigurations()
      .find(({ id }) => id === configurationId);
    await configurationDriver.update({ ...stored, values });
  };

  const gatewayId = (path) =>
    `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`;
  // One shape per rule. Every topology's OpenClaw Gateway rejects each (finding 874).
  for (const [values, message] of [
    [{ agents: "x" }, "Configuration setting agents must be an object."],
    [{ agents: { defaults: [] } }, "Configuration setting agents.defaults must be an object."],
    [
      withAgents({ entries: [] }),
      "Configuration setting agents.entries must be an object keyed by Agent ID.",
    ],
    [
      withAgents({ entries: { main: null } }),
      "Configuration setting agents.entries.main must be an object.",
    ],
    [
      withAgents({ list: [{ id: "main" }] }),
      "Configuration setting agents.list is unsupported: remove it and configure each Agent under agents.entries, keyed by its Agent ID.",
    ],
    [
      withAgents({ list: [], entries: { main: {} } }),
      "The OpenClaw Gateway rejects agents.list: remove it and configure each Agent under agents.entries, keyed by its Agent ID.",
    ],
    [withAgents({ entries: { "main!": {} } }), gatewayId('agents.entries["main!"]')],
    [
      withAgents({ ownership: "explicit", entries: { main: {}, Main: {} } }),
      "The OpenClaw Gateway normalizes agents.entries.main and agents.entries.Main to the same Agent ID: rename one.",
    ],
    [
      withAgents({ entries: { main: { default: true } } }),
      "The OpenClaw Gateway rejects agents.entries.main.default: remove it.",
    ],
    [
      withAgents({ ownership: "shared", entries: { main: {} } }),
      'The OpenClaw Gateway accepts only "explicit" for agents.ownership: set it to "explicit", or remove it if agents.entries has at most one entry.',
    ],
    [
      withAgents({ entries: { main: {}, helper: {} } }),
      'The OpenClaw Gateway needs agents.ownership "explicit" for more than one agents.entries entry: set it, or keep one entry.',
    ],
    [
      withAgents({ ownership: "explicit" }),
      'The OpenClaw Gateway needs at least one agents.entries entry when agents.ownership is "explicit": add one, or remove agents.ownership.',
    ],
  ]) {
    const label = JSON.stringify(values);
    const rejected = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(rejected.status, 400, label);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST", label);
    assert.equal(rejected.body.error.message, message, label);
    const replaced = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(replaced.status, 400, label);
    assert.equal(replaced.body.error.message, message, label);
    const unchanged = await request(context.app, "GET", item);
    assert.deepEqual(unchanged.body.data, created.body.data, label);

    // An existing row with the shape still reads, and deployment refuses it as before, with the
    // text the save gives.
    await storeAsOlderRelease(values);
    const read = await request(context.app, "GET", item);
    assert.equal(read.status, 200, label);
    assert.deepEqual(read.body.data.values, values, label);
    const deployed = await deploy();
    assert.equal(deployed.status, 400, label);
    assert.equal(deployed.body.error.code, "INVALID_REQUEST", label);
    assert.equal(deployed.body.error.message, message, label);
    // Only a write that keeps the shape is refused: replacing it with a valid roster saves.
    const kept = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(kept.status, 400, label);
    assert.equal(kept.body.error.message, message, label);
    await storeAsOlderRelease(valid);
  }
  assert.equal(configurationDriver.storedConfigurations().length, 1);
  await storeAsOlderRelease(withAgents({ entries: { main: {}, helper: {} } }));
  const fixed = withAgents({ ownership: "explicit", entries: { main: {}, helper: {} } });
  const repaired = await request(context.app, "PATCH", item, { body: { values: fixed } });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.deepEqual(repaired.body.data.values, fixed);

  // Rules that depend on the topology stay at deployment: only dedicated execution serves main,
  // so these save (embedded OpenClaw deploys them; see kubernetes-compute.test.mjs).
  // An empty agents.list beside an empty roster is valid everywhere.
  for (const values of [
    withAgents({ entries: { helper: {} } }),
    withAgents({ ownership: "explicit", entries: { main: {}, _main: {} } }),
    withAgents({
      ownership: "explicit",
      entries: { main: {}, helper: {} },
      defaults: { ...defaults, sessionStore: { agentId: "helper" } },
    }),
    withAgents({ list: [] }),
  ]) {
    const saved = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.values, values);
  }
});

test("Configuration save and Kubernetes deployment admission refuse settings preparation would refuse", async () => {
  // Deployment runs the real Kubernetes Compute admission rules, as production admission does.
  // On a dedicated Agent, a refusal in preparation came after the running revision stopped,
  // with no rollback (findings 1113-1115); admission now names the setting first.
  const kubernetes = createTestKubernetesComputeDriver("compute-settings-integration");
  const computeDriver = createReadyComputeDriver("compute-settings-integration", {
    implementation: "integration-compute-substrate",
    validateHarnessAuth: (...args) => kubernetes.validateHarnessAuth(...args),
    validateGatewaySettings: (...args) => kubernetes.validateGatewaySettings(...args),
  });
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver, computeDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const valid = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
        models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: valid },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const item = `${collection}/${configurationId}`;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "Settings consumer", configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await configureAgentHarnessSecret(context, namespace, agent, configurationId, "settings-key");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.body.data.id}`;
  // A row an older release saved, written past OCC as that release's create would have.
  const storeAsOlderRelease = async (values) => {
    const stored = configurationDriver
      .storedConfigurations()
      .find(({ id }) => id === configurationId);
    await configurationDriver.update({ ...stored, values });
  };
  const policy = (approvalPolicy) => ({
    ...valid,
    plugins: { entries: { codex: { config: { appServer: { approvalPolicy } } } } },
  });
  const password = (value) => ({ ...valid, gateway: { auth: { password: value } } });
  const setting = (path, requirement) => `Configuration setting ${path} ${requirement}.`;
  const policyEnum = setting(
    "plugins.entries.codex.config.appServer.approvalPolicy",
    'must be "never", "on-request" or "on-failure"',
  );
  const kubernetesPassword = setting(
    "gateway.auth.password",
    'must be the environment reference {source: "env", id: "OPENCLAW_GATEWAY_PASSWORD"}, whose value Kubernetes Compute generates',
  );

  // Topology-independent rules: the save refuses with a 400 naming the setting; an existing row
  // still reads, and deployment refuses it before any revision is admitted.
  for (const [values, saveMessage, deployStatus, deployMessage] of [
    [policy("always"), policyEnum, 409, policyEnum],
    [
      policy("untrusted"),
      setting(
        "plugins.entries.codex.config.appServer.approvalPolicy",
        'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
      ),
      409,
      setting(
        "plugins.entries.codex.config.appServer.approvalPolicy",
        'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
      ),
    ],
    [
      password("literal-gateway-password"),
      "Configuration field /gateway/auth/password holds a credential value inline, where a reference is required. Use the OPENCLAW_GATEWAY_PASSWORD environment reference, whose value the Compute Driver generates, instead.",
      409,
      kubernetesPassword,
    ],
  ]) {
    const label = JSON.stringify(values);
    const rejected = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(rejected.status, 400, label);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST", label);
    assert.equal(rejected.body.error.message, saveMessage, label);
    const replaced = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(replaced.status, 400, label);
    assert.equal(replaced.body.error.message, saveMessage, label);
    const unchanged = await request(context.app, "GET", item);
    assert.deepEqual(unchanged.body.data, created.body.data, label);

    await storeAsOlderRelease(values);
    const read = await request(context.app, "GET", item);
    assert.equal(read.status, 200, label);
    assert.deepEqual(read.body.data.values, values, label);
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, deployStatus, label);
    assert.equal(deployed.body.error.message, deployMessage, label);
    await storeAsOlderRelease(valid);
  }
  assert.equal(configurationDriver.storedConfigurations().length, 1);

  // Rules that depend on the Compute Driver or the topology save, and deployment refuses them.
  for (const [values, deployStatus, deployMessage] of [
    [
      password({ source: "env", provider: "default", id: "MY_GATEWAY_PASSWORD" }),
      409,
      kubernetesPassword,
    ],
    // An explicit null is unset to the save rule, as for model credentials; Kubernetes refuses it.
    [password(null), 409, kubernetesPassword],
    [
      { ...valid, channels: { slack: { enabled: true } } },
      400,
      setting("channels.slack", "is enabled, but channels require a dedicated Agent workload"),
    ],
  ]) {
    const label = JSON.stringify(values);
    const saved = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(saved.status, 200, `${label}: ${JSON.stringify(saved.body)}`);
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, deployStatus, label);
    assert.equal(deployed.body.error.message, deployMessage, label);
  }
  // No refused deployment admitted a revision, so none stopped a running one.
  const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.body.data, []);

  // Values every Gateway accepts still save.
  for (const values of [
    policy("never"),
    policy("on-request"),
    policy("on-failure"),
    password({ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" }),
    password("${OPENCLAW_GATEWAY_PASSWORD}"),
  ]) {
    const saved = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(saved.status, 200, `${JSON.stringify(values)}: ${JSON.stringify(saved.body)}`);
  }
});

test("Configuration save and Kubernetes deployment refuse caller-owned credentials and channels with one named message", async () => {
  // Finding 1116: deployment refused these with an unnamed 409; Configuration save accepted them.
  // Both now run the Kubernetes Compute rule module and name the setting.
  const kubernetes = createTestKubernetesComputeDriver("compute-caller-settings");
  const computeDriver = createReadyComputeDriver("compute-caller-settings", {
    implementation: "integration-compute-substrate",
    validateConfiguration: (...args) => kubernetes.validateConfiguration(...args),
    validateHarnessAuth: (...args) => kubernetes.validateHarnessAuth(...args),
    validateGatewaySettings: (...args) => kubernetes.validateGatewaySettings(...args),
  });
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({ configurationDriver, computeDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const valid = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
        models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: valid },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const item = `${collection}/${configurationId}`;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "Caller settings consumer", configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await configureAgentHarnessSecret(context, namespace, agent, configurationId, "caller-key");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.body.data.id}`;
  const storeAsOlderRelease = async (values) => {
    const stored = configurationDriver
      .storedConfigurations()
      .find(({ id }) => id === configurationId);
    await configurationDriver.update({ ...stored, values });
  };
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const credentialHeader =
    "must not set a credential header (authorization, any key, token, secret, password or cookie)";
  const setting = (path, requirement) => `Configuration setting ${path} ${requirement}.`;

  for (const [values, message] of [
    [
      { ...valid, channels: { discord: { enabled: true } } },
      setting(
        "channels.discord",
        "is not a supported channel: use slack or msteams, or set its enabled to false",
      ),
    ],
    [
      {
        ...valid,
        auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      },
      setting("auth", `must be empty: ${binding}`),
    ],
    [
      { ...valid, env: { vars: { OPENAI_BASE_URL: "https://example.invalid/v1" } } },
      setting(
        "env.vars.OPENAI_BASE_URL",
        `must not be set: the Agent's Harness authentication binding owns model provider environment`,
      ),
    ],
    [
      {
        ...valid,
        models: {
          providers: { openai: { headers: { "X-Api-Key": "${OPENAI_API_KEY}" }, models: [] } },
        },
      },
      setting("models.providers.openai.headers", `${credentialHeader}: ${binding}`),
    ],
    // OpenClaw's request transport overrides carry credentials too (finding 1142).
    [
      {
        ...valid,
        models: {
          providers: {
            openai: { request: { headers: { Authorization: "Bearer ${MODEL_TOKEN}" } } },
          },
        },
      },
      setting("models.providers.openai.request.headers", `${credentialHeader}: ${binding}`),
    ],
    [
      {
        ...valid,
        models: {
          providers: {
            openai: {
              request: { auth: { mode: "authorization-bearer", token: "${MODEL_TOKEN}" } },
            },
          },
        },
      },
      setting(
        "models.providers.openai.request.auth",
        `must be unset or {mode: "provider-default"}: ${binding}`,
      ),
    ],
    // A provider the primary model does not select is still reachable (imageModel, /model).
    [
      {
        ...valid,
        models: {
          providers: { google: { headers: { "x-goog-api-key": "${GOOGLE_API_KEY}" } } },
        },
      },
      setting("models.providers.google.headers", `${credentialHeader}: ${binding}`),
    ],
  ]) {
    const label = JSON.stringify(values);
    const rejected = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(rejected.status, 400, `${label}: ${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.error.message, message, label);
    const replaced = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(replaced.status, 400, label);
    assert.equal(replaced.body.error.message, message, label);
    const unchanged = await request(context.app, "GET", item);
    assert.deepEqual(unchanged.body.data, created.body.data, label);

    // A row an older release stored still reads; deployment refuses it with the same text.
    await storeAsOlderRelease(values);
    const read = await request(context.app, "GET", item);
    assert.equal(read.status, 200, label);
    assert.deepEqual(read.body.data.values, values, label);
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, 400, `${label}: ${JSON.stringify(deployed.body)}`);
    assert.equal(deployed.body.error.message, message, label);
    // Agent save checks the same rule on the stored row.
    const agentSaved = await request(context.app, "PATCH", agentPath, {
      body: { configurationId },
    });
    assert.equal(agentSaved.status, 400, `${label}: ${JSON.stringify(agentSaved.body)}`);
    assert.equal(agentSaved.body.error.message, message, label);
    await storeAsOlderRelease(valid);
  }
  assert.equal(configurationDriver.storedConfigurations().length, 1);

  // A provider apiKey depends on the Agent's binding, so it saves and deployment names it.
  const apiKey = {
    ...valid,
    models: {
      providers: {
        openai: { apiKey: { source: "env", provider: "default", id: "OTHER_MODEL_KEY" } },
      },
    },
  };
  const saved = await request(context.app, "PATCH", item, { body: { values: apiKey } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(
    deployed.body.error.message,
    setting(
      "models.providers.openai.apiKey",
      "must be ${OPENAI_API_KEY} or an env SecretRef to OPENAI_API_KEY, which the Agent's Harness authentication binding supplies",
    ),
  );
  // Agent save checks what depends on the Agent: an embedded Agent cannot serve a channel. The
  // Installation's channel runtime and the channel's Secret bindings wait for deployment.
  const slack = {
    ...valid,
    channels: {
      slack: {
        enabled: true,
        mode: "socket",
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      },
    },
  };
  assert.equal(
    (await request(context.app, "PATCH", item, { body: { values: slack } })).status,
    200,
  );
  const embeddedSlack = setting(
    "channels.slack",
    "is enabled, but channels require a dedicated Agent workload",
  );
  const agentUpdate = await request(context.app, "PATCH", agentPath, {
    body: { configurationId },
  });
  assert.equal(agentUpdate.status, 400, JSON.stringify(agentUpdate.body));
  assert.equal(agentUpdate.body.error.message, embeddedSlack);
  const slackDeploy = await request(context.app, "POST", `${agentPath}/deploy`);
  assert.equal(slackDeploy.status, 400);
  assert.equal(slackDeploy.body.error.message, embeddedSlack);
  const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
  assert.deepEqual(revisions.body.data, []);

  // A disabled unsupported channel and a non-credential env name still save.
  for (const values of [
    { ...valid, channels: { discord: { enabled: false } } },
    { ...valid, env: { vars: { HTTP_PROXY: "http://proxy:3128" } } },
  ]) {
    const accepted = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(
      accepted.status,
      200,
      `${JSON.stringify(values)}: ${JSON.stringify(accepted.body)}`,
    );
  }
});

test("Namespace deletion names the Configuration IDs that keep it occupied", async () => {
  const context = await fixture();
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: createOpenClawConfiguration() },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ids.push(created.body.data.id);
  }
  // Configurations have no list route, so the 409 is where an operator learns which IDs
  // to delete. Configurations created in the same millisecond may be named in any order.
  const named = async () => {
    const blocked = await request(context.app, "DELETE", `/namespaces/${namespace.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "NAMESPACE_NOT_EMPTY");
    const listed =
      /^The requested Namespace is not empty\. It still contains: Configurations \((.+)\)\.$/.exec(
        blocked.body.error.message,
      );
    assert.ok(listed, blocked.body.error.message);
    return listed[1].split(", ").sort();
  };
  assert.deepEqual(await named(), [...ids].sort());
  const removed = await request(context.app, "DELETE", `${collection}/${ids[0]}`);
  assert.equal(removed.status, 204);
  assert.deepEqual(await named(), ids.slice(1).sort());
});

test("Configuration HTTP routes reject foreign Namespace ownership and missing admission", async () => {
  const context = await fixture();
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;

  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: createOpenClawConfiguration() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const foreignNamespaceId = `ns_${randomUUID()}`;
  const foreign = await request(
    context.app,
    "GET",
    `/namespaces/${foreignNamespaceId}/configurations/${created.body.data.id}`,
  );
  assert.equal(foreign.status, 404);

  const unauthenticated = await request(
    context.app,
    "GET",
    `${collection}/${created.body.data.id}`,
    { authorization: false },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, "UNAUTHENTICATED");
});

test("Configuration authorization failures target the exact Configuration resource", async () => {
  const context = await fixture({
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
      { action: "create", resourceKind: "configuration" },
    ],
  });
  const namespace = await bootstrapAndCreateNamespace(context);
  const created = await request(context.app, "POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: { model: "gpt-test" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Creating in a tenant does not implicitly authorize reading its exact Configuration.
  const denied = await request(
    context.app,
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.body.data.id}`,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(context.auditSink.events.at(-1).resource.kind, "configuration");
  assert.equal(context.auditSink.events.at(-1).resource.id, created.body.data.id);
});

for (const runtimeLogging of [undefined, "driver"]) {
  test(`Configuration references and immutable revisions with ${runtimeLogging ?? "platform"} logging`, async () => {
    const computeDriver = createReadyComputeDriver("compute-configuration-integration", {
      implementation: "integration-compute-substrate",
      validateHarnessAuth() {},
      ...(runtimeLogging === undefined ? {} : { runtimeLogging }),
    });
    const context = await fixture({ computeDriver });
    const namespace = await bootstrapAndCreateNamespace(context);
    const collection = `/namespaces/${namespace.id}/configurations`;
    // Existing managed runtimes can own native export; only the selected Driver, not
    // tenant configuration, decides whether admission preserves that policy.
    const initialValues = {
      ...createOpenClawConfiguration(),
      logging: { consoleLevel: "warn", consoleStyle: "json" },
      diagnostics: { otel: { logs: true, captureContent: false } },
    };
    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: initialValues },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const configurationId = created.body.data.id;
    const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
      body: { name: "Configuration consumer", configurationId },
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    assert.equal(agent.body.data.configurationId, configurationId);

    // A referenced Configuration cannot be deleted and leave an Agent with a dangling reference.
    const referenced = await request(context.app, "DELETE", `${collection}/${configurationId}`);
    assert.equal(referenced.status, 409);
    assert.equal(referenced.body.error.code, "RESOURCE_CONFLICT");

    // Admission requires a ready Namespace; revision snapshots remain immutable independently.
    await context.controller.transact((state) =>
      state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    await configureAgentHarnessSecret(
      context,
      namespace,
      agent,
      configurationId,
      "configuration-model-key",
    );
    const deployed = await request(
      context.app,
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.body.data.id}/deploy`,
    );
    assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
    assert.equal(deployed.body.data.configurationId, configurationId);
    assert.equal(deployed.body.data.configurationKind, "agent");
    assert.equal(deployed.body.data.configurationGeneration, 1);
    assert.deepEqual(
      deployed.body.data.configuration,
      runtimeLogging === "driver"
        ? initialValues
        : admitLoggingConfiguration(initialValues, "info"),
    );

    const source = await request(context.app, "GET", `${collection}/${configurationId}`);
    assert.equal(source.status, 200);
    assert.deepEqual(source.body.data.values, initialValues);
    const expectedHistorical = structuredClone(deployed.body.data.configuration);

    const updated = await request(context.app, "PATCH", `${collection}/${configurationId}`, {
      body: {
        values: {
          models: {
            providers: {
              openai: { apiKey: { source: "store", provider: "teamstore", id: "NEXT_API_KEY" } },
            },
          },
        },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.generation, 2);
    const historical = await request(
      context.app,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.body.data.id}/revisions/${deployed.body.data.id}`,
    );
    assert.equal(historical.status, 200);
    assert.equal(historical.body.data.configurationGeneration, 1);
    assert.deepEqual(historical.body.data.configuration, expectedHistorical);
  });
}

test("Deploy rejects Configuration content that selects no supported Harness runtime with a 400", async () => {
  const computeDriver = createReadyComputeDriver("compute-configuration-integration", {
    implementation: "integration-compute-substrate",
    validateHarnessAuth() {},
  });
  const context = await fixture({ computeDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  // An OpenAI model with no agentRuntime policy is valid to store but cannot select a Harness.
  const created = await request(context.app, "POST", collection, {
    body: {
      kind: "agent",
      values: { agents: { defaults: { model: "openai/gpt-4.1" } } },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "Runtime-less consumer", configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await configureAgentHarnessSecret(
    context,
    namespace,
    agent,
    configurationId,
    "runtime-less-model-key",
  );

  const deployed = await request(
    context.app,
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.body.data.id}/deploy`,
  );
  // The Agent exists and is visible, so a Configuration content problem is not a 404.
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(deployed.body.error.code, "INVALID_REQUEST");
  assert.equal(
    deployed.body.error.message,
    "The configured Agent model requires an explicit supported Harness runtime.",
  );
  const unchanged = await request(
    context.app,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.body.data.id}`,
  );
  assert.equal(unchanged.status, 200);
});

test("Configuration operations fail closed when no ConfigurationDriver is selected", async () => {
  const context = await fixture({ configurationDriver: null });
  const namespace = await bootstrapAndCreateNamespace(context);
  const unavailable = await request(
    context.app,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { body: { kind: "agent", values: { model: "gpt-test" } } },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("Configuration creation rolls back its external substrate when its required mutation audit fails", async () => {
  class FailingConfigurationAuditSink extends InMemoryAuditSink {
    async append(event) {
      if (event.resource.kind === "configuration" && event.kind === "mutation") {
        this.rejectedConfigurationId = event.resource.id;
        throw new Error("The durable mutation audit is unavailable.");
      }
      return super.append(event);
    }
  }

  const configurationDriver = createConfigurationBackend();
  const auditSink = new FailingConfigurationAuditSink();
  const context = await fixture({ configurationDriver, auditSink });
  const namespace = await bootstrapAndCreateNamespace(context);

  // The genuine Fastify/OCC transaction must compensate the external write after audit failure.
  const rejected = await request(
    context.app,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { body: { kind: "agent", values: { model: "gpt-never-admitted" } } },
  );
  assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(configurationDriver.storedConfigurations(), []);
  const persisted = await context.controller.transact((state) =>
    state.configurations.findConfiguration(namespace.id, auditSink.rejectedConfigurationId),
  );
  assert.equal(persisted, undefined);
});

for (const [method, action] of [
  ["PATCH", "openclaw.configurations.update"],
  ["DELETE", "openclaw.configurations.delete"],
]) {
  test(`Configuration ${method} restores its external substrate when its mutation audit fails`, async () => {
    class FailingConfigurationAuditSink extends InMemoryAuditSink {
      async append(event) {
        if (event.action === action) {
          throw new Error("The durable configuration mutation audit is unavailable.");
        }
        return super.append(event);
      }
    }

    const configurationDriver = createConfigurationBackend();
    const context = await fixture({
      configurationDriver,
      auditSink: new FailingConfigurationAuditSink(),
    });
    const namespace = await bootstrapAndCreateNamespace(context);
    const collection = `/namespaces/${namespace.id}/configurations`;
    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: { model: "gpt-original", region: "west" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const configuration = created.body.data;

    // Audit failure occurs after the genuine external update/delete, forcing OCC compensation.
    const rejected = await request(
      context.app,
      method,
      `${collection}/${configuration.id}`,
      method === "PATCH" ? { body: { values: { model: "gpt-must-not-survive" } } } : {},
    );
    assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "DEPENDENCY_UNAVAILABLE");

    // Both the substrate values and persisted exact-namespace ownership remain unchanged.
    assert.deepEqual(configurationDriver.storedConfigurations(), [configuration]);
    const persisted = await context.controller.transact((state) =>
      state.configurations.findConfiguration(namespace.id, configuration.id),
    );
    assert.deepEqual(persisted, {
      id: configuration.id,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: configuration.createdAt,
    });
    const restored = await request(context.app, "GET", `${collection}/${configuration.id}`);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.data, configuration);
  });
}

test("Filesystem Configuration API rejects plaintext model writes without changing stored references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-model-configuration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const context = await fixture({ configurationDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const sentinel = `synthetic-configuration-credential-${randomUUID()}`;
  const unsafe = { models: { providers: { openai: { apiKey: sentinel } } } };
  const rejected = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: unsafe },
  });
  assert.equal(rejected.status, 400);
  // The caller learns which field must become a reference, never the submitted value.
  assert.equal(
    rejected.body.error.message,
    "Configuration field /models/providers/openai/apiKey holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
  );
  assert.equal(JSON.stringify(rejected.body).includes(sentinel), false);
  assert.deepEqual(await readdir(root), []);

  const values = createOpenClawConfiguration();
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const path = join(root, namespace.id, `${id}.json`);
  const original = await readFile(path, "utf8");
  const failedUpdate = await request(context.app, "PATCH", `${collection}/${id}`, {
    body: { values: unsafe },
  });
  assert.equal(failedUpdate.status, 400);
  assert.equal(JSON.stringify(failedUpdate.body).includes(sentinel), false);
  // Credential environment values and headers name their own field the same way.
  for (const [unsafeValues, field] of [
    [{ env: { vars: { OPENAI_API_KEY: sentinel } } }, "/env/vars/OPENAI_API_KEY"],
    [
      { models: { providers: { "a/b~c": { headers: { Authorization: `Bearer ${sentinel}` } } } } },
      "/models/providers/a~1b~0c/headers/Authorization",
    ],
    // A long provider name shortens the path so the message stays within the 256-character contract.
    [
      { models: { providers: { ["p".repeat(300)]: { apiKey: sentinel } } } },
      `/models/providers/p+…`,
    ],
  ]) {
    const named = await request(context.app, "PATCH", `${collection}/${id}`, {
      body: { values: unsafeValues },
    });
    assert.equal(named.status, 400);
    assert.match(named.body.error.message, new RegExp(`^Configuration field ${field} holds`));
    assert.ok(named.body.error.message.length <= 256);
    assert.equal(JSON.stringify(named.body).includes(sentinel), false);
  }
  // A provider name is a submitted object key: control and format characters in it are
  // replaced, and a shortened path never ends in half of a surrogate pair, as for other
  // contract messages that name submitted keys.
  for (const [providerName, field] of [
    ["evil\u001b[2J\u202Ename", "/models/providers/evil?[2J?name/apiKey"],
    ["\u{1F600}".repeat(150), `/models/providers/${"\u{1F600}".repeat(72)}…`],
  ]) {
    const named = await request(context.app, "PATCH", `${collection}/${id}`, {
      body: { values: { models: { providers: { [providerName]: { apiKey: sentinel } } } } },
    });
    assert.equal(named.status, 400);
    const { message } = named.body.error;
    assert.equal(message.startsWith(`Configuration field ${field} holds`), true, message);
    assert.equal(/[\p{Cc}\p{Cf}]/u.test(message), false);
    assert.equal(message.isWellFormed(), true);
    assert.ok(Array.from(message).length <= 256);
  }
  assert.equal(await readFile(path, "utf8"), original);
  const unchanged = await request(context.app, "GET", `${collection}/${id}`);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.body.data, created.body.data);

  // Direct Driver callers and externally modified storage retain the same boundary.
  const persisted = JSON.parse(original);
  await assert.rejects(
    configurationDriver.create({ ...persisted, values: unsafe }),
    /holds a credential value inline, where a reference is required/,
  );
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, JSON.stringify({ ...persisted, values: unsafe }));
  const unreadable = await request(context.app, "GET", `${collection}/${id}`);
  assert.equal(unreadable.status, 503);
  assert.equal(JSON.stringify(unreadable.body).includes(sentinel), false);
  assert.equal(JSON.stringify(context.auditSink.events).includes(sentinel), false);
});

test("A stored Configuration with request credentials an older release accepted reads, is repaired by an edit, and does not deploy", async (t) => {
  // The 2026-10-12 notice: an older release saved model credentials in a provider's request
  // transport settings. After the upgrade the bundled Driver must still read and replace that
  // document so its operator can remove them, while save and deployment refuse it with the
  // Kubernetes Compute rule's message, before any revision or runtime resource exists.
  const root = await mkdtemp(join(tmpdir(), "occ-upgrade-configuration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const kubernetes = createTestKubernetesComputeDriver("compute-upgrade-repair");
  const computeDriver = createReadyComputeDriver("compute-upgrade-repair", {
    implementation: "integration-compute-substrate",
    validateConfiguration: (...args) => kubernetes.validateConfiguration(...args),
    validateHarnessAuth: (...args) => kubernetes.validateHarnessAuth(...args),
    validateGatewaySettings: (...args) => kubernetes.validateGatewaySettings(...args),
  });
  const context = await fixture({ configurationDriver, computeDriver });
  const namespace = await bootstrapAndCreateNamespace(context);
  const collection = `/namespaces/${namespace.id}/configurations`;
  const valid = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
        models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: valid },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const item = `${collection}/${configurationId}`;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "Upgraded Configuration consumer", configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await configureAgentHarnessSecret(context, namespace, agent, configurationId, "upgrade-key");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.body.data.id}`;
  const path = join(root, namespace.id, `${configurationId}.json`);
  const sentinel = `synthetic-request-credential-${randomUUID()}`;
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const requestAuth = `Configuration setting models.providers.openai.request.auth must be unset or {mode: "provider-default"}: ${binding}.`;
  const credentialHeader = `Configuration setting models.providers.openai.request.headers must not set a credential header (authorization, any key, token, secret, password or cookie): ${binding}.`;

  for (const [label, stale, message] of [
    [
      "request.auth authorization-bearer",
      {
        ...valid,
        models: {
          providers: {
            openai: { request: { auth: { mode: "authorization-bearer", token: sentinel } } },
          },
        },
      },
      requestAuth,
    ],
    [
      "request.auth header",
      {
        ...valid,
        models: {
          providers: {
            openai: { request: { auth: { mode: "header", headerName: "x-key", value: sentinel } } },
          },
        },
      },
      requestAuth,
    ],
    [
      "request.headers",
      {
        ...valid,
        models: {
          providers: { openai: { request: { headers: { "x-goog-api-key": sentinel } } } },
        },
      },
      credentialHeader,
    ],
  ]) {
    // Seed the document the older release stored, directly in the Driver's storage.
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...current, values: stale }));

    // It still reads, so its operator can see what to remove.
    const read = await request(context.app, "GET", item);
    assert.equal(read.status, 200, `${label}: ${JSON.stringify(read.body)}`);
    assert.deepEqual(read.body.data.values, stale, label);
    const agents = await request(context.app, "GET", `/namespaces/${namespace.id}/agents`);
    assert.equal(agents.status, 200, label);
    assert.deepEqual(
      agents.body.data.map((listed) => listed.configurationId),
      [configurationId],
      label,
    );

    // Saving it unchanged and deploying it are refused with the same named message, and no
    // revision is admitted.
    const resaved = await request(context.app, "PATCH", item, { body: { values: stale } });
    assert.equal(resaved.status, 400, `${label}: ${JSON.stringify(resaved.body)}`);
    assert.equal(resaved.body.error.message, message, label);
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, 400, `${label}: ${JSON.stringify(deployed.body)}`);
    assert.equal(deployed.body.error.message, message, label);
    for (const body of [resaved.body, deployed.body]) {
      assert.equal(JSON.stringify(body).includes(sentinel), false, label);
    }
    const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
    assert.deepEqual(revisions.body.data, [], label);

    // An edit that removes the credential repairs it.
    const repaired = await request(context.app, "PATCH", item, { body: { values: valid } });
    assert.equal(repaired.status, 200, `${label}: ${JSON.stringify(repaired.body)}`);
    assert.deepEqual(repaired.body.data.values, valid, label);
    assert.equal((await readFile(path, "utf8")).includes(sentinel), false, label);
  }
  // The repaired Configuration deploys through the Agent's Harness authentication binding.
  const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.equal(JSON.stringify(context.auditSink.events).includes(sentinel), false);
});
