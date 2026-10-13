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
import {
  admitLoggingConfiguration,
  renderPresetTemplate,
} from "../../packages/contracts/src/index.ts";
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

// Building a controller app and signing in to it cost more than most cases, so the cases share
// one administrator and one session, and one app per Driver shape: with or without a Compute
// Driver and a Configuration Driver. Cases run one at a time. Each gets a new Namespace and its
// own Drivers, audit sink and IAM grants: the app's Drivers and sink forward to the running
// case's. A forwarding Driver keeps one identity, because OCC rechecks it on every selection,
// so a case Driver's own id and implementation never reach OCC.
const running = {};
const apps = new Map();
let administrator;
let session;

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

async function sharedApp(withCompute, withConfiguration) {
  const authFixture = await (administrator ??= createTestAuthPrincipal({
    name: "Configuration Integration Administrator",
  }));
  const principal = authFixture.seed.principal;
  const identities = [];
  const roles = [];
  const bindings = [];
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
  const auditSink = forwarder({}, () => running.auditSink);
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
    ...(withConfiguration
      ? {
          configurationDriver: forwarder(
            {
              id: "configuration-integration",
              capability: "configuration",
              implementation: "integration-memory-substrate",
            },
            () => running.configurationDriver,
          ),
        }
      : {}),
    ...(withCompute
      ? {
          computeDriver: forwarder(
            {
              id: "compute-configuration-integration",
              capability: "compute",
              implementation: "integration-compute-substrate",
            },
            () => running.computeDriver,
          ),
        }
      : {}),
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
  // Each case starts from the administrator's grants alone, or the permissions it names.
  const grant = (permissions = authFixture.seed.roles[0].permissions) => {
    identities.splice(0, Infinity, principal);
    roles.splice(0, Infinity, { id: "role-configuration-integration", permissions });
    bindings.splice(0, Infinity, {
      id: "binding-configuration-integration",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-configuration-integration",
    });
  };
  grant();
  session ??= await signInToControllerApp(app, authFixture);
  app.defaultSession = session;
  const installed = await request(app, "POST", "/installation/bootstrap", {
    body: { name: "Configuration integration" },
  });
  assert.equal(installed.status, 201);
  return { app, principal, identities, roles, bindings, controller, grant };
}

let namespaces = 0;

async function fixture({
  permissions,
  configurationDriver = createConfigurationBackend(),
  computeDriver,
  auditSink = new InMemoryAuditSink(),
} = {}) {
  Object.assign(running, { configurationDriver, computeDriver, auditSink });
  const shape = `${computeDriver !== undefined}/${configurationDriver !== null}`;
  if (!apps.has(shape)) {
    apps.set(shape, sharedApp(computeDriver !== undefined, configurationDriver !== null));
  }
  const { grant, ...context } = await apps.get(shape);
  grant(permissions);
  namespaces += 1;
  const namespace = await request(context.app, "POST", "/namespaces", {
    body: { name: `Configuration tenant ${namespaces}` },
  });
  assert.equal(namespace.status, 201);
  return {
    ...context,
    auditSink,
    namespace: namespace.body.data,
    collection: `/namespaces/${namespace.body.data.id}/configurations`,
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

// A model and runtime selection, so deployment reaches the Configuration rules.
const runtimeDefaults = {
  model: "openai/gpt-4.1",
  models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
};
const runtimeSelected = { agents: { defaults: runtimeDefaults } };

const configurationRules = [
  "validateConfiguration",
  "validateHarnessAuth",
  "validateGatewaySettings",
];

// A Compute Driver that runs the named real Kubernetes Compute admission rules, as production
// admission does.
function kubernetesRules(id, ...rules) {
  const kubernetes = createTestKubernetesComputeDriver(id);
  return createReadyComputeDriver(id, {
    implementation: "integration-compute-substrate",
    ...Object.fromEntries(rules.map((rule) => [rule, (...args) => kubernetes[rule](...args)])),
  });
}

// Readies the Namespace and binds the Agent's Harness authentication to a new Secret, so
// deployment admission reaches the Configuration.
async function readyAgent(context, namespace, agentId, configurationId, secretName) {
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const harnessSecret = await context.controller.createSecret(context.principal.id, {
    namespaceId: namespace.id,
    name: secretName,
    value: "synthetic-configuration-key",
  });
  const admittedAgent = await context.controller.updateAgent(context.principal.id, {
    namespaceId: namespace.id,
    agentId,
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

// Creates a Configuration with `values` and a ready Agent that uses it.
async function deployableAgent(context, namespace, { values, name, secretName }) {
  const collection = `/namespaces/${namespace.id}/configurations`;
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configurationId = created.body.data.id;
  const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name, configurationId },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await readyAgent(context, namespace, agent.body.data.id, configurationId, secretName);
  return {
    created,
    configurationId,
    item: `${collection}/${configurationId}`,
    agentPath: `/namespaces/${namespace.id}/agents/${agent.body.data.id}`,
  };
}

// Writes a row past OCC, as an older release's create would have stored it.
async function writePastOcc(configurationDriver, configurationId, values) {
  const stored = configurationDriver
    .storedConfigurations()
    .find(({ id }) => id === configurationId);
  await configurationDriver.update({ ...stored, values });
}

test("native OpenClaw Configuration HTTP CRUD preserves documents, SecretRefs, exact scope, and audit", async () => {
  const configurationDriver = createConfigurationBackend();
  const { namespace, collection, ...context } = await fixture({ configurationDriver });
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
  const { namespace, collection, ...context } = await fixture({ configurationDriver });

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
  const { namespace, collection, ...context } = await fixture({ configurationDriver });
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
  const { namespace, collection, ...context } = await fixture({ configurationDriver });
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
  // Deployment runs the real Kubernetes Compute roster rules.
  const configurationDriver = createConfigurationBackend();
  const { namespace, collection, ...context } = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-roster-integration", "validateHarnessAuth"),
  });
  const withAgents = (agents) => ({ agents: { defaults: runtimeDefaults, ...agents } });
  const valid = withAgents({});
  const { created, configurationId, item, agentPath } = await deployableAgent(context, namespace, {
    values: valid,
    name: "Roster consumer",
    secretName: "roster-key",
  });
  const deploy = () => request(context.app, "POST", `${agentPath}/deploy`);
  const storeAsOlderRelease = (values) =>
    writePastOcc(configurationDriver, configurationId, values);

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
      defaults: { ...runtimeDefaults, sessionStore: { agentId: "helper" } },
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
  // Deployment runs the real Kubernetes Compute admission rules. On a dedicated Agent, a refusal
  // in preparation came after the running revision stopped, with no rollback (findings
  // 1113-1115); admission now names the setting first.
  const configurationDriver = createConfigurationBackend();
  const { namespace, collection, ...context } = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules(
      "compute-settings-integration",
      "validateHarnessAuth",
      "validateGatewaySettings",
    ),
  });
  const valid = runtimeSelected;
  const { created, configurationId, item, agentPath } = await deployableAgent(context, namespace, {
    values: valid,
    name: "Settings consumer",
    secretName: "settings-key",
  });
  const storeAsOlderRelease = (values) =>
    writePastOcc(configurationDriver, configurationId, values);
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
  const configurationDriver = createConfigurationBackend();
  const { namespace, collection, ...context } = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-caller-settings", ...configurationRules),
  });
  const valid = runtimeSelected;
  const { created, configurationId, item, agentPath } = await deployableAgent(context, namespace, {
    values: valid,
    name: "Caller settings consumer",
    secretName: "caller-key",
  });
  const storeAsOlderRelease = (values) =>
    writePastOcc(configurationDriver, configurationId, values);
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const credentialHeader = (name) =>
    `must not set the credential header "${name}" (its name marks a credential)`;
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
      setting("models.providers.openai.headers", `${credentialHeader("X-Api-Key")}: ${binding}`),
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
      setting(
        "models.providers.openai.request.headers",
        `${credentialHeader("Authorization")}: ${binding}`,
      ),
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
      setting(
        "models.providers.google.headers",
        `${credentialHeader("x-goog-api-key")}: ${binding}`,
      ),
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
  const { namespace, collection, ...context } = await fixture();
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
  const { namespace, collection, ...context } = await fixture();

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
  const { namespace, ...context } = await fixture({
    permissions: [
      { action: "create", resourceKind: "namespace" },
      { action: "create", resourceKind: "configuration" },
    ],
  });
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
    const { namespace, collection, ...context } = await fixture({ computeDriver });
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
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.body.data.id}`;

    // A referenced Configuration cannot be deleted and leave an Agent with a dangling reference.
    const referenced = await request(context.app, "DELETE", `${collection}/${configurationId}`);
    assert.equal(referenced.status, 409);
    assert.equal(referenced.body.error.code, "RESOURCE_CONFLICT");

    // Admission requires a ready Namespace; revision snapshots remain immutable independently.
    await readyAgent(
      context,
      namespace,
      agent.body.data.id,
      configurationId,
      "configuration-model-key",
    );
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
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
      `${agentPath}/revisions/${deployed.body.data.id}`,
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
  const { namespace, ...context } = await fixture({ computeDriver });
  // An OpenAI model with no agentRuntime policy is valid to store but cannot select a Harness.
  const { agentPath } = await deployableAgent(context, namespace, {
    values: { agents: { defaults: { model: "openai/gpt-4.1" } } },
    name: "Runtime-less consumer",
    secretName: "runtime-less-model-key",
  });

  const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
  // The Agent exists and is visible, so a Configuration content problem is not a 404.
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(deployed.body.error.code, "INVALID_REQUEST");
  assert.equal(
    deployed.body.error.message,
    "The configured Agent model requires an explicit supported Harness runtime.",
  );
  const unchanged = await request(context.app, "GET", agentPath);
  assert.equal(unchanged.status, 200);
});

test("Configuration operations fail closed when no ConfigurationDriver is selected", async () => {
  const { namespace, ...context } = await fixture({ configurationDriver: null });
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
  const { namespace, ...context } = await fixture({ configurationDriver, auditSink });

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
    const { namespace, collection, ...context } = await fixture({
      configurationDriver,
      auditSink: new FailingConfigurationAuditSink(),
    });
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
  const { namespace, collection, ...context } = await fixture({ configurationDriver });
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

test("Without Kubernetes Compute, Configuration and Preset saves refuse what every Compute refuses", async (t) => {
  // Findings 1189-1191: a Compute without validateConfiguration (Docker) relies on the shared
  // model provider rules and the Configuration Driver alone. Preset saves skipped the shared
  // rules, header names no HTTP client sends were stored, and plausible credential header
  // names (version, dot and new words) took literals.
  const root = await mkdtemp(join(tmpdir(), "occ-model-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  // Like Docker Compute: ready Namespaces, no validateConfiguration.
  const computeDriver = createReadyComputeDriver("compute-without-configuration-rules");
  const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const presets = `/namespaces/${namespace.id}/presets`;
  const sentinel = `synthetic-model-rule-credential-${randomUUID()}`;
  const gateway = (settings) => ({ models: { providers: { gateway: settings } } });
  // Finding 1218: the refusal names the header up to its first invalid character, never past it.
  const invalidName = (setting, name) =>
    `Configuration setting ${setting} must use valid HTTP header names, not ${JSON.stringify(name)}.`;
  const listMessage =
    "Configuration setting models.providers.gateway.models must be an array of model entries.";
  const refused = [
    [
      gateway({ headers: { "x-api-key ": sentinel } }),
      invalidName("models.providers.gateway.headers", "x-api-key…"),
    ],
    // A name a Preset variable filled is refused here, so the person can find it.
    [
      gateway({ headers: { "X-Trace": "t", "Bad Header": "v" } }),
      invalidName("models.providers.gateway.headers", "Bad…"),
    ],
    // A credential pasted into the name is never echoed.
    [
      gateway({ headers: { [`Authorization: Bearer ${sentinel}`]: "v" } }),
      invalidName("models.providers.gateway.headers", "Authorization…"),
    ],
    // Finding 1222: nor whole when pasted alone, before a newline: the echo stops at 23 characters.
    [
      gateway({ headers: { [`${sentinel}\n`]: "v" } }),
      invalidName("models.providers.gateway.headers", `${sentinel.slice(0, 23)}…`),
    ],
    [
      gateway({ models: [{ id: "m", request: { headers: { Authorizatioн: sentinel } } }] }),
      invalidName("models.providers.gateway.models.0.request.headers", "Authorizatio…"),
    ],
    [gateway({ models: {} }), listMessage],
    // The list first, as on Kubernetes Compute, when a header name is refused too.
    [gateway({ models: {}, headers: { "x-api-key ": sentinel } }), listMessage],
    [gateway({ models: { m: { id: "m", headers: { "x-api-key": sentinel } } } }), listMessage],
    [
      gateway({ baseUrl: "ftp://models.example.test" }),
      "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
    ],
    // Finding 1243: OpenClaw renders the `$${HOST}` escape as the literal text `${HOST}`, so it is
    // no environment reference and the URL is checked as written.
    [
      gateway({ baseUrl: "ftp://$${HOST}/v1" }),
      "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
    ],
    // Finding 1244: a user name or password in a model endpoint is a credential, as in a proxy URL.
    [
      gateway({
        models: [{ id: "m", baseUrl: `https://user:${sentinel}@models.example.test/v1` }],
      }),
      "Configuration field /models/providers/gateway/models/0/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    // Finding 1250: an environment reference the runtime fills in the host or port, where the URL
    // does not parse as written, leaves the user name and password a literal.
    [
      gateway({ baseUrl: `https://user:${sentinel}@models.example.test:\${MODEL_PORT}/v1` }),
      "Configuration field /models/providers/gateway/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    [
      gateway({
        request: {
          proxy: {
            mode: "explicit-proxy",
            url: `http://u:${sentinel}@\${PROXY_HOST}:\${PROXY_PORT}`,
          },
        },
      }),
      "Configuration field /models/providers/gateway/request/proxy/url carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    // The runtime renders a reference's fallback when the variable is unset.
    [
      gateway({ baseUrl: `https://\${MODEL_HOST:-user:${sentinel}@models.example.test}/v1` }),
      "Configuration field /models/providers/gateway/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    [
      gateway({
        request: {
          proxy: { mode: "explicit-proxy", url: `\${PROXY_URL:-http://u:${sentinel}@proxy:3128}` },
        },
      }),
      "Configuration field /models/providers/gateway/request/proxy/url carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    // One reference set and another unset: https://setu:<password>@models.example.test.
    [
      gateway({ baseUrl: `https://\${A_HOST:-h/}\${B_USER:-u:${sentinel}@models.example.test}` }),
      "Configuration field /models/providers/gateway/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    // The URL parser ends the user name at the last `@`, inside brackets too.
    [
      gateway({ baseUrl: `https://[\${MODEL_HOST}user:${sentinel}@models.example.test/]` }),
      "Configuration field /models/providers/gateway/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
  ];
  for (const [values, message] of refused) {
    for (const [collection, body] of [
      [configurations, { kind: "agent", values }],
      [presets, { name: "Refused", template: { configuration: { values } } }],
    ]) {
      const response = await request(context.app, "POST", collection, { body });
      assert.equal(response.status, 400, `${collection}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.message, message, collection);
      assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    }
  }
  // Credential header names the widened rule matches take only references.
  for (const name of [
    "Authentication",
    "X-Authentication",
    "X-JWT",
    "X-JWT-Assertion",
    "X-Client-Assertion",
    "X-Hmac",
    "X-Otp",
    "X-Pin",
    "X-Pwd",
    "X-Pass",
    "X-License",
    "X-Api-Key-V2",
    "x-signature-v1",
    "x.authorization",
    "x.token",
  ]) {
    const response = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values: gateway({ headers: { [name]: sentinel } }) },
    });
    assert.equal(response.status, 400, `${name}: ${JSON.stringify(response.body)}`);
    assert.match(
      response.body.error.message,
      /^Configuration field \/models\/providers\/gateway\/headers\/\S+ holds a credential value inline/,
      name,
    );
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  }
  assert.deepEqual(await readdir(root), []);
  const listed = await request(context.app, "GET", presets);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.data, []);

  // Benign names and a bearer reference under an Authentication header still save.
  const accepted = gateway({
    headers: {
      Authentication: "Bearer ${GATEWAY_TOKEN}",
      "X-Partition-Key": "p",
      "X-Shard-Key": "s",
      "X-Sort-Key": "s",
      "X-Dedup-Key": "d",
      "X-Passthrough": "on",
      "X-Pinned-Version": "1",
      "x-api-key-version": "2",
    },
    models: [{ id: "m", request: { headers: { "x.trace.id": "t" } } }],
    // Finding 1250: an environment reference with a fallback that holds no user name.
    baseUrl: "https://${MODEL_HOST:-models.example.test}/v1",
    request: { proxy: { mode: "explicit-proxy", url: "${PROXY_URL:-http://proxy.example:3128}" } },
  });
  const created = await request(context.app, "POST", configurations, {
    body: { kind: "agent", values: accepted },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.values, accepted);
  const preset = await request(context.app, "POST", presets, {
    body: { name: "Accepted", template: { configuration: { values: accepted } } },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  // A variable without a default is checked when its Configuration is created, not before.
  const variables = {
    url: { type: "string" },
    api: { type: "string" },
    header: { type: "string" },
    port: { type: "string" },
  };
  const templated = await request(context.app, "POST", presets, {
    body: {
      name: "Templated",
      template: {
        variables,
        configuration: {
          values: gateway({
            baseUrl: "{{ vars.url }}",
            api: "{{ vars.api }}",
            models: [
              { id: "m", baseUrl: "https://{{ vars.url }}/v1" },
              { id: "n", baseUrl: "{{ vars.url }}/v1" },
              { id: "o", baseUrl: "http://localhost:{{ vars.port }}/v1" },
              { id: "p", baseUrl: "http://[{{ vars.url }}]:8080/v1" },
              { id: "q", baseUrl: "http{{ vars.port }}://models.example.test" },
              // Finding 1243: a variable may split the scheme, follow an IPv6 address as its port,
              // or sit beside many others.
              { id: "r", baseUrl: "ht{{ vars.port }}://models.example.test" },
              { id: "t", baseUrl: "http://[::1]{{ vars.port }}/v1" },
              {
                id: "s",
                baseUrl:
                  "https://{{ vars.url }}.{{ vars.api }}.{{ vars.header }}.{{ vars.port }}.test:{{ vars.port }}/{{ vars.url }}",
              },
              // Finding 1250: an `@` in the path, query or fragment is no user name.
              { id: "u", baseUrl: "https://{{ vars.url }}/models/m@2024?at=a@b#c@d" },
              {
                id: "v",
                request: {
                  proxy: { mode: "explicit-proxy", url: "http://{{ vars.url }}:{{ vars.port }}" },
                },
              },
            ],
            headers: {
              "{{ vars.header }}": "v",
              "X-{{ vars.header }}-Trace": "t",
              // A bearer reference under a name a variable completes, as under Authorization.
              "Authorization{{ vars.header }}": "Bearer ${GATEWAY_TOKEN}",
            },
          }),
        },
      },
    },
  });
  assert.equal(templated.status, 201, JSON.stringify(templated.body));
  // Finding 1214: an escaped token, or a default that reads like one, stays literal text in the
  // launch render, so it is checked as written: these saved and then failed every launch.
  const headers = (name) => invalidName("models.providers.gateway.headers", name);
  // Finding 1251: a name whose first character is invalid is named by that character's code
  // point, not an empty quote.
  const startsWith = (setting, point) =>
    `Configuration setting ${setting} must use valid HTTP header names, not one that starts with ${point}.`;
  for (const [values, message, agent] of [
    [
      gateway({ headers: { "\\{{ vars.header }}": "v" } }),
      startsWith("models.providers.gateway.headers", "U+007B"),
    ],
    [gateway({ headers: { "Authorization\\{{ vars.header }}": "v" } }), headers("Authorization…")],
    [
      gateway({ headers: { "\\{{ vars.undeclared }}": "v" } }),
      startsWith("models.providers.gateway.headers", "U+007B"),
    ],
    [
      gateway({ headers: { "{{ vars.literal }}": "v" } }),
      startsWith("models.providers.gateway.headers", "U+007B"),
    ],
    // A placeholder outside configuration renders the same text but does not admit it.
    [
      gateway({ headers: { "\\{{ vars.header }}": "v" } }),
      startsWith("models.providers.gateway.headers", "U+007B"),
      { name: "{{ vars.header }}" },
    ],
    [
      gateway({ baseUrl: "\\{{ vars.url }}" }),
      "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
    ],
    // Finding 1220: the same text as a placeholder elsewhere is still literal here.
    [
      {
        models: {
          providers: {
            gateway: { headers: { "{{ vars.header }}": "v" } },
            other: { headers: { "\\{{ vars.header }}": "v" } },
          },
        },
      },
      startsWith("models.providers.other.headers", "U+007B"),
    ],
    [
      gateway({
        headers: { "{{ vars.url }}": "v" },
        models: [{ id: "m", baseUrl: "\\{{ vars.url }}" }],
      }),
      "Configuration field /models/providers/gateway/models/0/baseUrl must be an absolute http or https URL.",
    ],
    [
      gateway({ headers: { "{{ vars.header }}": "v" }, api: "{{ vars.literal }}" }),
      "Configuration field /models/providers/gateway/api must name a model API the runtime supports, such as openai-responses, openai-completions or anthropic-messages.",
    ],
    // Finding 1221: the text around a variable is checked with a stand-in for it. The refusal shows
    // the variable's placeholder up to the first invalid literal character.
    [gateway({ headers: { "{{ vars.header }} ": "v" } }), headers("{{ vars.header }}…")],
    [gateway({ headers: { "X-{{ vars.header }}\u200b": "v" } }), headers("X-{{ vars.header }}…")],
    [
      gateway({ headers: { "\\{{ vars.url }}-{{ vars.header }}": "v" } }),
      startsWith("models.providers.gateway.headers", "U+007B"),
    ],
    [
      gateway({ baseUrl: "ftp://{{ vars.url }}" }),
      "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
    ],
    [
      gateway({ models: [{ id: "m", baseUrl: "https://models {{ vars.url }}.test" }] }),
      "Configuration field /models/providers/gateway/models/0/baseUrl must be an absolute http or https URL.",
    ],
    // Finding 1243: a literal scheme other than http(s) is refused however many variables follow.
    [
      gateway({
        baseUrl: "ftp://{{ vars.url }}{{ vars.api }}{{ vars.header }}{{ vars.port }}{{ vars.url }}",
      }),
      "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
    ],
    // Finding 1244: the text around a variable names a credential header, which takes no literal,
    // and a variable in a model endpoint's user name or password fills a credential.
    [
      gateway({ headers: { "Authorization{{ vars.header }}": "Bearer synthetic" } }),
      "Configuration field /models/providers/gateway/headers/Authorization{{ vars.header }} holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
    ],
    [
      gateway({ baseUrl: "https://user:{{ vars.url }}@models.example.test/v1" }),
      "Configuration field /models/providers/gateway/baseUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    ],
    // Finding 1250: so is literal userinfo, or a variable that is the whole of it, where a variable
    // fills the host or port and the URL does not parse until filled.
    ...[
      ["baseUrl", { baseUrl: `https://user:${sentinel}@{{ vars.url }}/v1` }],
      ["baseUrl", { baseUrl: "https://{{ vars.header }}@{{ vars.url }}/v1" }],
      ["baseUrl", { baseUrl: `{{ vars.url }}://user:${sentinel}@{{ vars.api }}/v1` }],
      // A baseUrl needs literal slashes after its scheme (finding 1259); a proxy URL does not.
      [
        "request/proxy/url",
        {
          request: {
            proxy: {
              mode: "explicit-proxy",
              url: `https:{{ vars.url }}//user:${sentinel}@{{ vars.api }}/v1`,
            },
          },
        },
      ],
      ["baseUrl", { baseUrl: `https://[{{ vars.url }}user:${sentinel}@models.test/]` }],
      [
        "models/0/baseUrl",
        {
          models: [{ id: "m", baseUrl: `https://user:${sentinel}@models.test:{{ vars.port }}/v1` }],
        },
      ],
      [
        "request/proxy/url",
        {
          request: {
            proxy: { mode: "explicit-proxy", url: `http://u:${sentinel}@{{ vars.url }}` },
          },
        },
      ],
      // A variable scheme may be socks5, where a backslash stays in the user name.
      [
        "request/proxy/url",
        {
          request: {
            proxy: {
              mode: "explicit-proxy",
              url: `{{ vars.api }}://u\\x:${sentinel}@{{ vars.url }}:{{ vars.port }}`,
            },
          },
        },
      ],
      [
        "models/0/request/proxy/url",
        {
          models: [
            {
              id: "m",
              request: {
                proxy: {
                  mode: "explicit-proxy",
                  url: `http://u:${sentinel}@proxy:{{ vars.port }}`,
                },
              },
            },
          ],
        },
      ],
    ].map(([field, settings]) => [
      gateway(settings),
      `Configuration field /models/providers/gateway/${field} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`,
    ]),
    // A model row's credential header is matched as the text around its variables too.
    [
      gateway({
        models: [{ id: "m", headers: { "Authorization{{ vars.header }}": "Bearer synthetic" } }],
      }),
      "Configuration field /models/providers/gateway/models/0/headers/Authorization{{ vars.header }} holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
    ],
  ]) {
    const escaped = await request(context.app, "POST", presets, {
      body: {
        name: "Escaped",
        template: {
          variables: { ...variables, literal: { type: "string", default: "{{ vars.header }}" } },
          ...(agent ? { agent } : {}),
          configuration: { values },
        },
      },
    });
    assert.equal(escaped.status, 400, JSON.stringify(escaped.body));
    assert.equal(escaped.body.error.message, message);
    assert.equal(JSON.stringify(escaped.body).includes(sentinel), false);
  }
  // A default that fills a header name is a literal name: a credential name takes no literal.
  const filledCredential = await request(context.app, "POST", presets, {
    body: {
      name: "Filled credential",
      template: {
        variables: { header: { type: "string", default: "x-api-key" } },
        configuration: { values: gateway({ headers: { "{{ vars.header }}": sentinel } }) },
      },
    },
  });
  assert.equal(filledCredential.status, 400, JSON.stringify(filledCredential.body));
  assert.match(filledCredential.body.error.message, /holds a credential value inline/);
  assert.equal(JSON.stringify(filledCredential.body).includes(sentinel), false);
  // A default is checked like any value.
  const defaulted = await request(context.app, "POST", presets, {
    body: {
      name: "Defaulted",
      template: {
        variables: { url: { type: "string", default: "ftp://models.example.test" } },
        configuration: { values: gateway({ baseUrl: "{{ vars.url }}" }) },
      },
    },
  });
  assert.equal(defaulted.status, 400, JSON.stringify(defaulted.body));
  assert.equal(
    defaulted.body.error.message,
    "Configuration field /models/providers/gateway/baseUrl must be an absolute http or https URL.",
  );
});

test("Configuration and Preset saves refuse a user name or password in proxy, channel proxy, MCP server and proxy environment URLs", async (t) => {
  // Finding 1255: #2347 refused URL userinfo only in model baseUrl and request.proxy.url. The
  // Gateway's egress proxy, channel proxies, MCP server URLs and proxy environment variables
  // carry the same credential (a proxy sends it as Proxy-Authorization), and saved.
  const root = await mkdtemp(join(tmpdir(), "occ-url-userinfo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const computeDriver = createReadyComputeDriver("compute-url-userinfo");
  const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const presets = `/namespaces/${namespace.id}/presets`;
  const sentinel = `synthetic-url-userinfo-${randomUUID()}`;
  const message = (field) =>
    `Configuration field ${field} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;
  const userinfo = `http://u:${sentinel}@proxy.example:3128`;
  const refused = [
    [{ proxy: { enabled: true, proxyUrl: userinfo } }, "/proxy/proxyUrl"],
    [{ channels: { telegram: { proxy: userinfo } } }, "/channels/telegram/proxy"],
    [
      { channels: { discord: { proxy: `socks5://u:${sentinel}@proxy:1080` } } },
      "/channels/discord/proxy",
    ],
    [
      { channels: { telegram: { accounts: { ops: { proxy: userinfo } } } } },
      "/channels/telegram/accounts/ops/proxy",
    ],
    [
      { mcp: { servers: { docs: { url: `https://u:${sentinel}@mcp.example.test/mcp` } } } },
      "/mcp/servers/docs/url",
    ],
    [
      { nodeHost: { mcp: { servers: { docs: { url: `https://${sentinel}@mcp.example.test` } } } } },
      "/nodeHost/mcp/servers/docs/url",
    ],
    [{ env: { vars: { HTTPS_PROXY: userinfo } } }, "/env/vars/HTTPS_PROXY"],
    [{ env: { vars: { http_proxy: userinfo } } }, "/env/vars/http_proxy"],
    [{ env: { ALL_PROXY: userinfo } }, "/env/ALL_PROXY"],
    [{ env: { vars: { all_proxy: userinfo } } }, "/env/vars/all_proxy"],
    // curl and git read a proxy without a scheme as http.
    [{ env: { vars: { HTTPS_PROXY: `${sentinel}@proxy.example:3128` } } }, "/env/vars/HTTPS_PROXY"],
    // As in #2347: an environment reference in the port, or a fallback that holds userinfo.
    [
      { channels: { telegram: { proxy: `http://u:${sentinel}@proxy.example:\${PROXY_PORT}` } } },
      "/channels/telegram/proxy",
    ],
    [
      { proxy: { proxyUrl: `\${EGRESS_PROXY:-http://u:${sentinel}@proxy.example:3128}` } },
      "/proxy/proxyUrl",
    ],
    // Finding 1259: an MCP server's environment reaches its stdio process, and plugins read
    // Codex's network proxy and a speech provider's proxy.
    [
      { mcp: { servers: { docs: { command: "docs-mcp", env: { HTTPS_PROXY: userinfo } } } } },
      "/mcp/servers/docs/env/HTTPS_PROXY",
    ],
    [
      {
        nodeHost: { mcp: { servers: { docs: { env: { all_proxy: `${sentinel}@proxy:3128` } } } } },
      },
      "/nodeHost/mcp/servers/docs/env/all_proxy",
    ],
    [
      {
        plugins: {
          entries: { codex: { config: { appServer: { networkProxy: { proxyUrl: userinfo } } } } },
        },
      },
      "/plugins/entries/codex/config/appServer/networkProxy/proxyUrl",
    ],
    [{ tts: { providers: { microsoft: { proxy: userinfo } } } }, "/tts/providers/microsoft/proxy"],
    [
      {
        agents: {
          entries: {
            main: {
              tts: { personas: { calm: { providers: { microsoft: { proxy: userinfo } } } } },
            },
          },
        },
      },
      "/agents/entries/main/tts/personas/calm/providers/microsoft/proxy",
    ],
    [
      {
        channels: {
          discord: {
            accounts: {
              ops: { voice: { tts: { providers: { microsoft: { proxy: userinfo } } } } },
            },
          },
        },
      },
      "/channels/discord/accounts/ops/voice/tts/providers/microsoft/proxy",
    ],
    [
      { talk: { providers: { microsoft: { proxy: userinfo } } } },
      "/talk/providers/microsoft/proxy",
    ],
    [
      {
        plugins: {
          entries: {
            acpx: {
              config: {
                mcpServers: { docs: { command: "docs-mcp", env: { HTTPS_PROXY: userinfo } } },
              },
            },
          },
        },
      },
      "/plugins/entries/acpx/config/mcpServers/docs/env/HTTPS_PROXY",
    ],
    [
      {
        plugins: {
          entries: {
            "voice-call": {
              config: {
                numbers: { "+15550100": { tts: { providers: { edge: { proxy: userinfo } } } } },
              },
            },
          },
        },
      },
      "/plugins/entries/voice-call/config/numbers/+15550100/tts/providers/edge/proxy",
    ],
  ];
  // A Configuration to update: a refused edit leaves it as it was.
  const original = await request(context.app, "POST", configurations, {
    body: {
      kind: "agent",
      values: { env: { vars: { HTTPS_PROXY: "http://proxy.example:3128" } } },
    },
  });
  assert.equal(original.status, 201, JSON.stringify(original.body));
  const item = `${configurations}/${original.body.data.id}`;
  for (const [values, field] of refused) {
    for (const [method, path, body] of [
      ["POST", configurations, { kind: "agent", values }],
      ["PATCH", item, { values }],
      ["POST", presets, { name: "Refused", template: { configuration: { values } } }],
    ]) {
      const response = await request(context.app, method, path, { body });
      assert.equal(response.status, 400, `${method} ${path}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.message, message(field), `${method} ${path}`);
      assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    }
  }
  const read = await request(context.app, "GET", item);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.data.values, original.body.data.values);
  assert.deepEqual(await readdir(join(root, namespace.id)), [`${original.body.data.id}.json`]);
  assert.equal(
    (await readFile(join(root, namespace.id, `${original.body.data.id}.json`), "utf8")).includes(
      sentinel,
    ),
    false,
  );
  assert.deepEqual((await request(context.app, "GET", presets)).body.data, []);

  // A Preset variable as the host, port or the whole URL is checked once filled; literal userinfo
  // beside it, or a variable as the whole user name, is refused at save.
  const variables = { host: { type: "string" }, port: { type: "string" }, url: { type: "string" } };
  for (const [values, field] of [
    [{ proxy: { proxyUrl: `http://u:${sentinel}@{{ vars.host }}:3128` } }, "/proxy/proxyUrl"],
    [
      { channels: { discord: { proxy: `http://u:${sentinel}@proxy.example:{{ vars.port }}` } } },
      "/channels/discord/proxy",
    ],
    [
      { mcp: { servers: { docs: { url: "https://{{ vars.url }}@{{ vars.host }}/mcp" } } } },
      "/mcp/servers/docs/url",
    ],
    [{ env: { vars: { HTTPS_PROXY: `u:${sentinel}@{{ vars.host }}` } } }, "/env/vars/HTTPS_PROXY"],
    [
      { env: { vars: { HTTPS_PROXY: `${sentinel}@{{ vars.host }}:3128` } } },
      "/env/vars/HTTPS_PROXY",
    ],
    // A variable in the name is matched as the text around it.
    [
      { env: { vars: { "{{ vars.host }}_PROXY": `http://u:${sentinel}@proxy.example:3128` } } },
      "/env/vars/{{ vars.host }}_PROXY",
    ],
    [
      {
        mcp: {
          servers: { docs: { env: { "{{ vars.host }}_PROXY": `u:${sentinel}@proxy:3128` } } },
        },
      },
      "/mcp/servers/docs/env/{{ vars.host }}_PROXY",
    ],
  ]) {
    const response = await request(context.app, "POST", presets, {
      body: { name: "Refused", template: { variables, configuration: { values } } },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.message, message(field));
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  }

  // A proxy without userinfo, a whole reference, a fallback without userinfo, NO_PROXY and an
  // `@` in a path still save.
  const accepted = {
    proxy: { enabled: true, proxyUrl: "${EGRESS_PROXY:-http://proxy.example:3128}" },
    channels: {
      telegram: { proxy: "http://10.42.0.15:3128", accounts: { ops: { proxy: "${OPS_PROXY}" } } },
      discord: { proxy: "socks5://proxy.example:1080" },
    },
    mcp: {
      servers: {
        docs: { url: "https://mcp.example.test/v1/@scope/mcp" },
        local: {
          command: "docs-mcp",
          env: { HTTPS_PROXY: "http://proxy.example:3128", TOKEN: "a@b" },
        },
      },
    },
    plugins: {
      entries: {
        codex: { config: { appServer: { networkProxy: { proxyUrl: "http://127.0.0.1:3128" } } } },
      },
    },
    tts: { providers: { microsoft: { proxy: "${SPEECH_PROXY}" } } },
    env: {
      HTTP_PROXY: "proxy.example:3128",
      vars: { HTTPS_PROXY: "${CORP_PROXY}", NO_PROXY: "localhost,.svc,10.0.0.0/8" },
    },
  };
  const created = await request(context.app, "POST", configurations, {
    body: { kind: "agent", values: accepted },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.values, accepted);
  const templated = await request(context.app, "POST", presets, {
    body: {
      name: "Templated",
      template: {
        variables,
        configuration: {
          values: {
            ...accepted,
            proxy: { proxyUrl: "http://{{ vars.host }}:{{ vars.port }}" },
            channels: { telegram: { proxy: "{{ vars.url }}" } },
            env: { vars: { HTTPS_PROXY: "{{ vars.host }}:3128", ALL_PROXY: "{{ vars.url }}" } },
          },
        },
      },
    },
  });
  assert.equal(templated.status, 201, JSON.stringify(templated.body));

  // A document an older release stored with one still reads, so its operator can edit it.
  const path = join(root, namespace.id, `${original.body.data.id}.json`);
  const stale = { proxy: { proxyUrl: userinfo }, env: { vars: { HTTPS_PROXY: userinfo } } };
  const current = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...current, values: stale }));
  const staleRead = await request(context.app, "GET", item);
  assert.equal(staleRead.status, 200, JSON.stringify(staleRead.body));
  assert.deepEqual(staleRead.body.data.values, stale);
  const resaved = await request(context.app, "PATCH", item, { body: { values: stale } });
  assert.equal(resaved.status, 400, JSON.stringify(resaved.body));
  assert.equal(resaved.body.error.message, message("/proxy/proxyUrl"));
});

test("Configuration and Preset saves refuse a user name or password in a URL in any environment map, whatever the variable's name", async (t) => {
  // Findings 1260-1262: the userinfo rule read only `env`, `env.vars` and MCP server `env`, and
  // only `*_PROXY` names. A skill, hook, local model service, exec secret provider, Docker sandbox
  // or install policy check starts its process with its own `env`, and pip, npm, git and Go send
  // the userinfo in `PIP_INDEX_URL`, `npm_config_registry` or `GOPROXY` as Basic auth.
  const root = await mkdtemp(join(tmpdir(), "occ-env-url-userinfo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const computeDriver = createReadyComputeDriver("compute-env-url-userinfo");
  const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const presets = `/namespaces/${namespace.id}/presets`;
  const sentinel = `synthetic-env-url-userinfo-${randomUUID()}`;
  const message = (field) =>
    `Configuration field ${field} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;
  const index = `https://u:${sentinel}@pypi.example.test/simple`;
  const refused = [
    [
      { skills: { entries: { docs: { env: { HTTPS_PROXY: index } } } } },
      "/skills/entries/docs/env/HTTPS_PROXY",
    ],
    [
      { hooks: { internal: { entries: { audit: { env: { PIP_INDEX_URL: index } } } } } },
      "/hooks/internal/entries/audit/env/PIP_INDEX_URL",
    ],
    [
      {
        models: {
          providers: {
            local: { localService: { command: "/usr/bin/serve", env: { GOPROXY: index } } },
          },
        },
      },
      "/models/providers/local/localService/env/GOPROXY",
    ],
    [
      {
        secrets: {
          providers: {
            vault: { source: "exec", command: "/usr/bin/vault", env: { VAULT: index } },
          },
        },
      },
      "/secrets/providers/vault/env/VAULT",
    ],
    [
      { agents: { defaults: { sandbox: { docker: { env: { npm_config_registry: index } } } } } },
      "/agents/defaults/sandbox/docker/env/npm_config_registry",
    ],
    [
      { agents: { entries: { main: { sandbox: { docker: { env: { HTTP_PROXY: index } } } } } } },
      "/agents/entries/main/sandbox/docker/env/HTTP_PROXY",
    ],
    [
      {
        security: {
          installPolicy: { exec: { command: "/usr/bin/scan", env: { GIT_CONFIG_VALUE_0: index } } },
        },
      },
      "/security/installPolicy/exec/env/GIT_CONFIG_VALUE_0",
    ],
    // Any name, in the maps checked before: a URL anywhere in the value, also in a list.
    [
      { env: { vars: { GOPROXY: `https://${sentinel}@proxy.example.test,direct` } } },
      "/env/vars/GOPROXY",
    ],
    [{ env: { PIP_INDEX_URL: index } }, "/env/PIP_INDEX_URL"],
    [
      { env: { vars: { PIP_EXTRA_INDEX_URL: `https://pypi.example.test ${index}` } } },
      "/env/vars/PIP_EXTRA_INDEX_URL",
    ],
    [
      {
        mcp: {
          servers: {
            docs: {
              command: "docs-mcp",
              env: { NPM_REGISTRY: `\${SCHEME}://u:${sentinel}@npm.test` },
            },
          },
        },
      },
      "/mcp/servers/docs/env/NPM_REGISTRY",
    ],
    [
      { env: { vars: { PIP_INDEX_URL: `\${PIP_URL:-https://u:${sentinel}@pypi.example.test}` } } },
      "/env/vars/PIP_INDEX_URL",
    ],
    // URL parsers drop a tab or newline, a reference may render empty between `:` and `//`, and
    // an http(s) URL reads userinfo with one slash or none.
    [
      { skills: { entries: { tab: { env: { PIP_INDEX_URL: `https:\t//u:${sentinel}@pypi` } } } } },
      "/skills/entries/tab/env/PIP_INDEX_URL",
    ],
    [
      { skills: { entries: { gap: { env: { INDEX: `https:\${GAP:-}//u:${sentinel}@pypi` } } } } },
      "/skills/entries/gap/env/INDEX",
    ],
    [
      { skills: { entries: { slash: { env: { INDEX: `https:/u:${sentinel}@pypi` } } } } },
      "/skills/entries/slash/env/INDEX",
    ],
    [
      { skills: { entries: { none: { env: { INDEX: `HTTPS:u:${sentinel}@pypi` } } } } },
      "/skills/entries/none/env/INDEX",
    ],
    // A reference in the scheme renders it: `https${X:-}:` reads as `https:`.
    [
      { skills: { entries: { ref: { env: { INDEX: `https\${X:-}:u:${sentinel}@pypi` } } } } },
      "/skills/entries/ref/env/INDEX",
    ],
    [
      {
        skills: {
          entries: { list: { env: { GOPROXY: `ok.example,\${P:-https}:u:${sentinel}@h` } } },
        },
      },
      "/skills/entries/list/env/GOPROXY",
    ],
    // A space in the userinfo still reads as userinfo (WHATWG, Python), `${a/}` is no reference
    // (names are upper case), and a backslash ends a `file` authority.
    [
      { skills: { entries: { space: { env: { INDEX: `https://u:p w${sentinel}@pypi` } } } } },
      "/skills/entries/space/env/INDEX",
    ],
    [
      {
        skills: {
          entries: { lower: { env: { INDEX: `https://ok\${a/},https:u:${sentinel}@h` } } },
        },
      },
      "/skills/entries/lower/env/INDEX",
    ],
    [
      { skills: { entries: { file: { env: { INDEX: `file://h\\https:u:${sentinel}@h` } } } } },
      "/skills/entries/file/env/INDEX",
    ],
    // Python and curl read a backslash in a password as part of the userinfo.
    [
      { skills: { entries: { bs: { env: { INDEX: `https://u:p\\w${sentinel}@pypi` } } } } },
      "/skills/entries/bs/env/INDEX",
    ],
    [
      { env: { vars: { HTTPS_PROXY: `http://u:p\\w${sentinel}@proxy.example:3128` } } },
      "/env/vars/HTTPS_PROXY",
    ],
  ];
  for (const [values, field] of refused) {
    await t.test(`refuses ${field}`, async () => {
      for (const [path, body] of [
        [configurations, { kind: "agent", values }],
        [presets, { name: "Refused", template: { configuration: { values } } }],
      ]) {
        const response = await request(context.app, "POST", path, { body });
        assert.equal(response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.error.message, message(field), path);
        assert.equal(JSON.stringify(response.body).includes(sentinel), false);
      }
    });
  }

  // A Preset variable beside the userinfo, in the scheme or between `:` and `//`, is refused at
  // save; a variable that is the whole URL is checked once filled.
  const variables = {
    url: { type: "string" },
    host: { type: "string" },
    scheme: { type: "string" },
  };
  for (const [env, field] of [
    [{ PIP_INDEX_URL: "https://{{ vars.url }}@pypi.example.test" }, "PIP_INDEX_URL"],
    [{ GOPROXY: `{{ vars.scheme }}://u:${sentinel}@{{ vars.host }}` }, "GOPROXY"],
    [{ REGISTRY: `https:{{ vars.scheme }}//u:${sentinel}@npm.test` }, "REGISTRY"],
  ]) {
    await t.test(`refuses a Preset ${field} at save`, async () => {
      const response = await request(context.app, "POST", presets, {
        body: {
          name: "Refused",
          template: {
            variables,
            configuration: { values: { skills: { entries: { x: { env } } } } },
          },
        },
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.message, message(`/skills/entries/x/env/${field}`));
      assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    });
  }
  // A value whose URLs would take too long to check is refused rather than block the controller.
  await t.test("refuses a value too costly to check", async () => {
    // Twelve values that each fit the budget exceed it together: it is the document's.
    const env = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`X${index}`, `x://h${"${A:-x}".repeat(170)}`]),
    );
    const one = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values: { skills: { entries: { x: { env: { X0: env.X0 } } } } } },
    });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    await request(context.app, "DELETE", `${configurations}/${one.body.data.id}`);
    const values = { skills: { entries: { x: { env } } } };
    const response = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.message,
      "Configuration field /skills/entries/x/env/X10, with the URLs and environment values before it, holds too many URLs or ${NAME} references to check for a user name or password. Shorten these values, or make each whole value a ${NAME} reference.",
    );
  });
  // Nothing refused was stored.
  assert.deepEqual((await request(context.app, "GET", presets)).body.data, []);
  assert.deepEqual(await readdir(join(root, namespace.id)).catch(() => []), []);

  const saved = await request(context.app, "POST", presets, {
    body: {
      name: "Whole variable",
      template: {
        variables,
        configuration: {
          values: { skills: { entries: { x: { env: { PIP_INDEX_URL: "{{ vars.url }}" } } } } },
        },
      },
    },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const launch = (url) =>
    request(context.app, "POST", configurations, {
      body: {
        kind: "agent",
        ...renderPresetTemplate(saved.body.data.template, { url, host: "", scheme: "" })
          .configuration,
      },
    });
  await t.test("refuses a whole Preset variable at launch", async () => {
    const filled = await launch(index);
    assert.equal(filled.status, 400, JSON.stringify(filled.body));
    assert.equal(filled.body.error.message, message("/skills/entries/x/env/PIP_INDEX_URL"));
    assert.equal(JSON.stringify(filled.body).includes(sentinel), false);
  });
  const plain = await launch("https://pypi.example.test/simple");
  assert.equal(plain.status, 201, JSON.stringify(plain.body));

  // Ordinary values, URLs without userinfo, an `@` outside a URL's authority, whole references
  // and fallbacks without userinfo still save in every map.
  const env = {
    PIP_INDEX_URL: "https://pypi.example.test/simple",
    GOPROXY: "https://proxy.golang.org,direct",
    NPM_SCOPE_URL: "https://registry.example.test/@scope/pkg",
    GIT_CONFIG_VALUE_0: "${GIT_URL}",
    REGISTRY: "${REGISTRY_URL:-https://registry.example.test}",
    MAINTAINER: "ops@example.test",
    NOTE: "see https://docs.example.test/help or write to ops@example.test",
    ARTIFACT: "s3://bucket/key@v1",
    JDBC: "jdbc:postgresql://db.example.test/app?user=ops@example.test",
    PLAIN: "use https: everywhere, ask ops@example.test",
    NEWS: "news:ops@example.test",
    WINDOWS_ADMIN: "Windows:admin@example.test",
    ARGS: "--proxy=http://proxy.example.test:3128/ --user=ops@example.test",
    JSON: '{"url": "https://api.example.test", "contact": "ops@example.test"}',
    ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
    WINDOWS_FILE: "file:///C:\\Users\\ops@example.test\\notes.txt",
    NO_PROXY: "localhost,.svc,10.0.0.0/8",
    LOG_LEVEL: "debug",
  };
  const accepted = {
    env: { ...env, vars: env },
    skills: { entries: { docs: { env } } },
    hooks: { internal: { entries: { audit: { env } } } },
    models: { providers: { local: { localService: { command: "/usr/bin/serve", env } } } },
    secrets: { providers: { vault: { source: "exec", command: "/usr/bin/vault", env } } },
    agents: {
      defaults: { sandbox: { docker: { env } } },
      entries: { main: { sandbox: { docker: { env } } } },
    },
    security: { installPolicy: { exec: { command: "/usr/bin/scan", env } } },
    mcp: { servers: { docs: { command: "docs-mcp", env } } },
  };
  const created = await request(context.app, "POST", configurations, {
    body: { kind: "agent", values: accepted },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.values, accepted);
  const templated = await request(context.app, "POST", presets, {
    body: {
      name: "Templated",
      template: {
        variables,
        configuration: {
          values: {
            ...accepted,
            skills: {
              entries: {
                docs: {
                  env: {
                    ...env,
                    PIP_INDEX_URL: "https://{{ vars.host }}/simple",
                    GOPROXY: "{{ vars.url }}",
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(templated.status, 201, JSON.stringify(templated.body));
});

test("Configuration and Preset saves check a URL of many ${NAME:-fallback} references in bounded time", async (t) => {
  // Finding 1265: the userinfo rule renders a URL once per `${NAME:-fallback}` reference and reads
  // it whole each time, so a body-sized baseUrl of fallbacks held the controller for seconds.
  // Every URL field now spends the document's work budget, which refuses such a value at once.
  const root = await mkdtemp(join(tmpdir(), "occ-url-userinfo-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const computeDriver = createReadyComputeDriver("compute-url-userinfo-cost");
  const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const presets = `/namespaces/${namespace.id}/presets`;
  const cost = (field) =>
    `Configuration field ${field}, with the URLs and environment values before it, holds too many URLs or \${NAME} references to check for a user name or password. Shorten these values, or make each whole value a \${NAME} reference.`;
  // 60 KB of fallbacks, the most the 64 KiB request body holds, in the path and in the authority.
  const fallbacks = (prefix, suffix) =>
    `${prefix}${"${A:-x}".repeat(Math.floor((60 * 1024 - prefix.length - suffix.length) / 7))}${suffix}`;
  const urls = [fallbacks("https://h.example/", ""), fallbacks("https://", "@h.example/v1")];
  const fields = [
    [(url) => ({ models: { providers: { p: { baseUrl: url } } } }), "/models/providers/p/baseUrl"],
    [
      (url) => ({
        models: {
          providers: { p: { baseUrl: "https://h.example/v1", request: { proxy: { url } } } },
        },
      }),
      "/models/providers/p/request/proxy/url",
    ],
    [(proxyUrl) => ({ proxy: { proxyUrl } }), "/proxy/proxyUrl"],
    [(proxy) => ({ channels: { telegram: { proxy } } }), "/channels/telegram/proxy"],
    [(url) => ({ mcp: { servers: { docs: { url } } } }), "/mcp/servers/docs/url"],
  ];
  const timed = async (path, body) => {
    const start = performance.now();
    const response = await request(context.app, "POST", path, { body });
    return { ...response, elapsed: performance.now() - start };
  };
  for (const [values, field] of fields) {
    for (const [index, url] of urls.entries()) {
      await t.test(
        `refuses ${field} of fallbacks (${index === 0 ? "path" : "authority"})`,
        async () => {
          const response = await timed(configurations, { kind: "agent", values: values(url) });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          assert.equal(response.body.error.message, cost(field));
          // Unbounded, this took 4 to 14 s; bounded, a few milliseconds.
          assert.ok(response.elapsed < 500, `took ${response.elapsed} ms`);
        },
      );
    }
  }
  await t.test("refuses a Preset URL of fallbacks around a variable", async () => {
    const response = await timed(presets, {
      name: "Costly",
      template: {
        variables: { host: { type: "string" } },
        configuration: { values: { proxy: { proxyUrl: `${urls[1]}{{ vars.host }}` } } },
      },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.message, cost("/proxy/proxyUrl"));
    assert.ok(response.elapsed < 500, `took ${response.elapsed} ms`);
  });
  // A URL with a few fallbacks is still checked whole.
  await t.test("still refuses userinfo in a fallback and accepts a plain one", async () => {
    const refused = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values: { proxy: { proxyUrl: "http://${HOST:-u:pw@proxy}:3128" } } },
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.message,
      "Configuration field /proxy/proxyUrl carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
    );
    const saved = await request(context.app, "POST", configurations, {
      body: {
        kind: "agent",
        values: { proxy: { proxyUrl: "http://${HOST:-proxy}:${PORT:-3128}" } },
      },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  });
});

test("Preset and Configuration saves refuse a baseUrl or api that a variable fills with no host or no string", async (t) => {
  // Finding 1256: `https://{{ vars.h }}/v1` filled empty renders `https:///v1`, whose first path
  // segment the URL parser reads as the host. Finding 1257: a number or boolean variable that is
  // the whole baseUrl or api saved, and failed every launch.
  const root = await mkdtemp(join(tmpdir(), "occ-preset-fill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const computeDriver = createReadyComputeDriver("compute-preset-fill");
  const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const presets = `/namespaces/${namespace.id}/presets`;
  const gateway = (settings) => ({ models: { providers: { gateway: settings } } });
  const baseUrl = (field = "baseUrl") =>
    `Configuration field /models/providers/gateway/${field} must be an absolute http or https URL.`;
  const api =
    "Configuration field /models/providers/gateway/api must name a model API the runtime supports, such as openai-responses, openai-completions or anthropic-messages.";

  // An empty written authority, however it is spelled, is refused on Configuration create, and
  // so is one or no slash after the scheme (finding 1259), which the URL parser accepts.
  for (const [settings, message] of [
    [{ baseUrl: "https:///v1" }, baseUrl()],
    [{ baseUrl: " HTTP:\\\\\\v1" }, baseUrl()],
    [{ baseUrl: "https:/\t//v1" }, baseUrl()],
    [
      { models: [{ id: "m", baseUrl: "http:////models.example.test/v1" }] },
      baseUrl("models/0/baseUrl"),
    ],
    [{ baseUrl: "https:/models.example.test/v1" }, baseUrl()],
    [{ baseUrl: "https:v1" }, baseUrl()],
    [{ baseUrl: " \tHTTPS:/models.example.test" }, baseUrl()],
    [{ baseUrl: "https:\\models.example.test" }, baseUrl()],
    [{ baseUrl: "https:${MODEL_HOST}/v1" }, baseUrl()],
    [{ models: [{ id: "m", baseUrl: "http:/${MODEL_HOST}" }] }, baseUrl("models/0/baseUrl")],
    // The runtime renders a fallback when its variable is unset.
    [{ baseUrl: "${MODEL_URL:-https:/models.example.test/v1}" }, baseUrl()],
    [{ baseUrl: "https://${MODEL_HOST:-}/v1" }, baseUrl()],
  ]) {
    const response = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values: gateway(settings) },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.message, message);
  }

  const template = (variables, settings) => ({
    variables,
    configuration: { values: gateway(settings) },
  });
  const hostVariable = { baseUrl: "https://{{ vars.h }}/v1" };
  for (const [variables, settings, message] of [
    // An empty default is a literal empty host.
    [{ h: { type: "string", default: "" } }, hostVariable, baseUrl()],
    // A variable cannot supply the slashes (finding 1259).
    [{ h: { type: "string" } }, { baseUrl: "https:{{ vars.h }}" }, baseUrl()],
    [{ h: { type: "string" } }, { baseUrl: "HTTPS:/{{ vars.h }}/v1" }, baseUrl()],
    [{ n: { type: "number" } }, { baseUrl: "{{ vars.n }}" }, baseUrl()],
    [{ b: { type: "boolean" } }, { baseUrl: "{{ vars.b }}" }, baseUrl()],
    [{ n: { type: "number" } }, { api: "{{ vars.n }}" }, api],
    [
      { b: { type: "boolean" } },
      { models: [{ id: "m", baseUrl: "{{ vars.b }}" }] },
      baseUrl("models/0/baseUrl"),
    ],
  ]) {
    const response = await request(context.app, "POST", presets, {
      body: { name: "Refused", template: template(variables, settings) },
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.message, message);
  }
  assert.deepEqual((await request(context.app, "GET", presets)).body.data, []);

  // A host variable without a default saves; filled empty at launch, its Configuration is refused.
  const variables = { h: { type: "string" }, n: { type: "number" }, u: { type: "string" } };
  const values = {
    ...hostVariable,
    models: [{ id: "m", baseUrl: "{{ vars.u }}", contextWindow: "{{ vars.n }}" }],
  };
  const saved = await request(context.app, "POST", presets, {
    body: { name: "Filled at launch", template: template(variables, values) },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const launch = (inputs) =>
    request(context.app, "POST", configurations, {
      body: {
        kind: "agent",
        ...renderPresetTemplate(saved.body.data.template, inputs).configuration,
      },
    });
  const empty = await launch({ h: "", n: 1000, u: "https://models.example.test/v1" });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.error.message, baseUrl());
  const oneSlash = await launch({ h: "models.example.test", n: 1000, u: "https:/v1" });
  assert.equal(oneSlash.status, 400, JSON.stringify(oneSlash.body));
  assert.equal(oneSlash.body.error.message, baseUrl("models/0/baseUrl"));

  // Two slashes or backslashes after any spelling of the scheme, and references beside them, save.
  for (const value of [
    " HTTPS://models.example.test/v1",
    "https:\\\\models.example.test/v1",
    "http://localhost:${MODEL_PORT}/v1",
    "https://${MODEL_HOST}/v1",
    "${MODEL_BASE_URL}/v1",
    "${MODEL_URL:-https://models.example.test}/v1",
  ]) {
    const response = await request(context.app, "POST", configurations, {
      body: { kind: "agent", values: gateway({ baseUrl: value }) },
    });
    assert.equal(response.status, 201, `${value}: ${JSON.stringify(response.body)}`);
  }
  const filled = await launch({
    h: "models.example.test",
    n: 1000,
    u: "https://models.example.test/v1",
  });
  assert.equal(filled.status, 201, JSON.stringify(filled.body));
});

test("A stored Configuration with request credentials an older release accepted reads, is repaired by an edit, and does not deploy", async (t) => {
  // The 2026-10-12 notice: an older release saved model credentials in a provider's request
  // transport settings. After the upgrade the bundled Driver must still read and replace that
  // document so its operator can remove them, while save and deployment refuse it with the
  // Kubernetes Compute rule's message, before any revision or runtime resource exists.
  const root = await mkdtemp(join(tmpdir(), "occ-upgrade-configuration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const { namespace, ...context } = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-upgrade-repair", ...configurationRules),
  });
  const valid = runtimeSelected;
  const { configurationId, item, agentPath } = await deployableAgent(context, namespace, {
    values: valid,
    name: "Upgraded Configuration consumer",
    secretName: "upgrade-key",
  });
  const path = join(root, namespace.id, `${configurationId}.json`);
  const sentinel = `synthetic-request-credential-${randomUUID()}`;
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const requestAuth = `Configuration setting models.providers.openai.request.auth must be unset or {mode: "provider-default"}: ${binding}.`;
  const credentialHeader = `Configuration setting models.providers.openai.request.headers must not set the credential header "x-goog-api-key" (its name marks a credential): ${binding}.`;

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
