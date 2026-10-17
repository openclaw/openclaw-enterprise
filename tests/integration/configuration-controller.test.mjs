import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
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
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

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
    // Preset saves need a Driver that checks values; the OCC and Compute rules run before it.
    async validateValues() {},
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
    presets: `/namespaces/${namespace.body.data.id}/presets`,
  };
}

// A ready Namespace on the Filesystem Configuration Driver, for Configuration and Preset saves.
// The default Compute, like Docker Compute, runs no Configuration rules of its own.
async function saveFixture(t, computeDriver = createReadyComputeDriver("compute-save-rules")) {
  const root = await mkdtemp(join(tmpdir(), "occ-save-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const context = await fixture({ configurationDriver, computeDriver });
  const { id } = context.namespace;
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(id, "provisioning", "ready"),
  );
  return { ...context, root, stored: () => readdir(join(root, id)).catch(() => []) };
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
      credential_proxy: { enabled: true },
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

// A ready Agent whose Configuration holds `valid`, with the Driver that stores it, for
// refusedAtSaveAndDeploy.
async function storedRowAgent(context, configurationDriver, valid, { name, secretName }) {
  const agent = await deployableAgent(context, context.namespace, {
    values: valid,
    name,
    secretName,
  });
  return { ...agent, configurationDriver, valid };
}

// Writes a row past OCC, as an older release's create would have stored it.
async function writePastOcc(configurationDriver, configurationId, values) {
  const stored = configurationDriver
    .storedConfigurations()
    .find(({ id }) => id === configurationId);
  await configurationDriver.update({ ...stored, values });
}

// The refusal texts the save rules name a field or setting with.
const setting = (path, requirement) => `Configuration setting ${path} ${requirement}.`;
const absoluteUrl = (field) =>
  `Configuration field ${field} must be an absolute http or https URL.`;
const modelApi = (field) =>
  `Configuration field ${field} must name a model API the runtime supports, such as openai-responses, openai-completions or anthropic-messages.`;
const userinfo = (field) =>
  `Configuration field ${field} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;
const inline = (field) =>
  `Configuration field ${field} holds a credential value inline, where a reference is required.`;
const literalKey = (field) =>
  `${inline(field)} Make the value a \${NAME} reference or a SecretRef.`;
const literalHeader = (field) =>
  `${inline(field)} Make the header value a \${NAME} reference, or Bearer \${NAME} for an Authorization header.`;
const literalModelKey = (field) =>
  `${inline(field)} Store the key as a Secret and select it as the Agent's model credential instead.`;
const gatewayPassword = `${inline("/gateway/auth/password")} Use the OPENCLAW_GATEWAY_PASSWORD environment reference, whose value the Compute Driver generates, instead.`;
const openaiOnly =
  "must select openai/<model>, the provider of the Agent's Harness authentication binding";
const approvalPolicy = (policy) => ({
  ...runtimeSelected,
  plugins: { entries: { codex: { config: { appServer: { approvalPolicy: policy } } } } },
});
const policyPath = "plugins.entries.codex.config.appServer.approvalPolicy";
const policyEnum = setting(policyPath, 'must be "never", "on-request" or "on-failure"');
const policyRetired = setting(
  policyPath,
  'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
);

// The document that holds `value` at the JSON pointer `field`; a segment 0 is a one-item list.
const at = (field, value) =>
  field
    .split("/")
    .slice(1)
    .reduceRight((inner, key) => (key === "0" ? [inner] : { [key]: inner }), value);

const savePreset = (context, template, name = "Refused") =>
  request(context.app, "POST", context.presets, { body: { name, template } });

// A 400 that names `message` and never echoes `sentinel`.
function assertRefused(response, message, { label = "", sentinel } = {}) {
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, "INVALID_REQUEST", label);
  assert.equal(response.body.error.message, message, label);
  if (sentinel !== undefined) {
    assert.equal(JSON.stringify(response.body).includes(sentinel), false, label);
  }
}

// Every save path that must enforce a rule refuses `values` with the same `message`: Configuration
// create, an update of `item` when given, and a Preset save unless `preset` is false (#2394 and
// #2396 found rules that ran on one path but not another).
async function refusedOnSave(context, values, message, { item, preset = true, sentinel } = {}) {
  const saves = [["POST", context.collection, { kind: "agent", values }]];
  if (item !== undefined) {
    saves.push(["PATCH", item, { values }]);
  }
  if (preset) {
    saves.push([
      "POST",
      context.presets,
      { name: "Refused", template: { configuration: { values } } },
    ]);
  }
  for (const [method, path, body] of saves) {
    const response = await request(context.app, method, path, { body });
    assertRefused(response, message, {
      label: `${method} ${path} ${JSON.stringify(values)}`,
      sentinel,
    });
  }
}

// Configuration create stores `values` as sent, and a Preset of `presetValues` saves.
async function acceptedOnSave(context, values, { variables, presetValues = values } = {}) {
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.values, values);
  const preset = await savePreset(
    context,
    { variables, configuration: { values: presetValues } },
    `Accepted-${created.body.data.id}`,
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  return created;
}

// No refused save stored a Preset or, on the Filesystem Driver, a Configuration beyond `kept`.
async function assertNothingStored(context, kept = []) {
  assert.deepEqual((await request(context.app, "GET", context.presets)).body.data, []);
  assert.deepEqual(await context.stored(), kept);
}

// Create and update refuse `values` and leave the Agent's Configuration as it was. A row an older
// release stored with them still reads, deployment refuses it with `deploy` (by default the save's
// 400), and an update that keeps them is refused. Then the valid row is stored again.
async function refusedAtSaveAndDeploy(context, agent, values, message, deploy = {}) {
  const { status = 400, message: deployMessage = message } = deploy;
  const label = JSON.stringify(values);
  await refusedOnSave(context, values, message, { item: agent.item, preset: false });
  const unchanged = await request(context.app, "GET", agent.item);
  assert.deepEqual(unchanged.body.data, agent.created.body.data, label);
  await writePastOcc(agent.configurationDriver, agent.configurationId, values);
  const read = await request(context.app, "GET", agent.item);
  assert.equal(read.status, 200, label);
  assert.deepEqual(read.body.data.values, values, label);
  const deployed = await request(context.app, "POST", `${agent.agentPath}/deploy`);
  assert.equal(deployed.status, status, `${label}: ${JSON.stringify(deployed.body)}`);
  if (status === 400) {
    assert.equal(deployed.body.error.code, "INVALID_REQUEST", label);
  }
  assert.equal(deployed.body.error.message, deployMessage, label);
  const kept = await request(context.app, "PATCH", agent.item, { body: { values } });
  assertRefused(kept, message, { label });
  await writePastOcc(agent.configurationDriver, agent.configurationId, agent.valid);
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

// A PATCH that names the generation it read is refused with 409 once another save moved it,
// and the newer content stays; without the field the update replaces as before (finding 1505).
test("Configuration HTTP PATCH refuses a stale expectedGeneration and keeps the newer content", async () => {
  const configurationDriver = createConfigurationBackend();
  const { collection, ...context } = await fixture({ configurationDriver });
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: { model: "created" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pathname = `${collection}/${created.body.data.id}`;

  const first = await request(context.app, "PATCH", pathname, {
    body: { values: { model: "first" }, expectedGeneration: 1 },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.generation, 2);

  // The refusal comes before any write: the substrate never holds the refused content, not even
  // until a rollback restores the newer document.
  const writes = [];
  const update = configurationDriver.update;
  configurationDriver.update = (configuration) => {
    writes.push(configuration.values.model);
    return update(configuration);
  };
  // Any generation but the current one is refused, a generation ahead of it included.
  for (const expectedGeneration of [1, 3]) {
    const stale = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "stale" }, expectedGeneration },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(
      stale.body.error.message,
      "The Configuration changed since it was read. Read its current generation before updating it.",
    );
    // The detail tells a stale read apart from other Configuration conflicts, such as a
    // provisioning reservation, which a reread does not fix (finding 1511).
    assert.deepEqual(stale.body.error.details, [
      { path: "/expectedGeneration", code: "INVALID_VALUE" },
    ]);
  }
  assert.deepEqual(writes, []);
  const read = await request(context.app, "GET", pathname);
  assert.equal(read.body.data.generation, 2);
  assert.deepEqual(read.body.data.values, { model: "first" });
  assert.deepEqual(configurationDriver.storedConfigurations()[0].values, { model: "first" });

  for (const expectedGeneration of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "invalid" }, expectedGeneration },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.error.code, "INVALID_REQUEST");
  }

  const unchecked = await request(context.app, "PATCH", pathname, {
    body: { values: { model: "unchecked" } },
  });
  assert.equal(unchecked.status, 200, JSON.stringify(unchecked.body));
  assert.equal(unchecked.body.data.generation, 3);
  assert.deepEqual(writes, ["unchecked"]);
  assert.deepEqual(
    context.auditSink.events
      .filter((event) => event.resource.kind === "configuration")
      .map((event) => event.action),
    [
      "openclaw.configurations.create",
      "openclaw.configurations.update",
      "openclaw.configurations.update",
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

test("Configuration HTTP names a model provider baseUrl or api the runtime cannot use", async (t) => {
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: createOpenClawConfiguration() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const field = (path) => `/models/providers/openai/${path}`;
  // These values used to save and then fail deployment as an unexplained model probe
  // failure; every save now answers a 400 naming the field and stores nothing.
  for (const [settings, message] of [
    [{ baseUrl: "not a url", api: "openai-responses" }, absoluteUrl(field("baseUrl"))],
    [{ baseUrl: "ftp://models.example/v1" }, absoluteUrl(field("baseUrl"))],
    [{ baseUrl: "https://api.openai.com/v1", api: "openai-bogus" }, modelApi(field("api"))],
    [
      {
        models: [
          { id: "a", name: "a" },
          { id: "b", name: "b", baseUrl: "/v1" },
        ],
      },
      absoluteUrl(field("models/1/baseUrl")),
    ],
    // Only a provider's blank baseUrl means "use the built-in default"; a model's must be set.
    [{ models: [{ id: "a", name: "a", baseUrl: "" }] }, absoluteUrl(field("models/0/baseUrl"))],
    [{ models: [{ id: "a", name: "a", api: 7 }] }, modelApi(field("models/0/api"))],
  ]) {
    await refusedOnSave(context, at("/models/providers/openai", settings), message, { item });
  }
  const unchanged = await request(context.app, "GET", item);
  assert.deepEqual(unchanged.body.data, created.body.data);
  await assertNothingStored(context, [`${created.body.data.id}.json`]);
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

test("Deployment refuses a stored model provider baseUrl or api that saves refuse, with the save's text", async () => {
  // Finding 1549: a row an older release stored with such a value deployed (202) and failed
  // later as an unexplained model probe failure. The rule is OCC's, so it holds on any Compute.
  const field = (path) => `/models/providers/openai/${path}`;
  const rows = [
    [{ baseUrl: "ftp://models.example/v1" }, absoluteUrl(field("baseUrl"))],
    [
      { baseUrl: "https:/models.example/v1" },
      `Configuration field ${field("baseUrl")} must start with https:// or http:// (the // after the scheme is missing).`,
    ],
    [{ baseUrl: "https://models.example/v1", api: "openai-bogus" }, modelApi(field("api"))],
    [
      { models: [{ id: "gpt-4.1", name: "gpt-4.1", baseUrl: "/v1" }] },
      absoluteUrl(field("models/0/baseUrl")),
    ],
    // Deployment already refused a models record (Harness resolution); a header name, only on
    // Kubernetes Compute.
    [
      { models: {} },
      setting("models.providers.openai.models", "must be an array of model entries"),
    ],
    [
      { headers: { "X-Trace ": "v" } },
      setting(
        "models.providers.openai.headers",
        'must use valid HTTP header names, not "X-Trace…"',
      ),
    ],
  ];
  for (const [label, computeDriver] of [
    ["Kubernetes", kubernetesRules("compute-model-provider-deploy", ...configurationRules)],
    [
      "ready",
      createReadyComputeDriver("compute-model-provider-deploy-ready", { validateHarnessAuth() {} }),
    ],
  ]) {
    const configurationDriver = createConfigurationBackend();
    const context = await fixture({ configurationDriver, computeDriver });
    const agent = await storedRowAgent(context, configurationDriver, runtimeSelected, {
      name: `${label} model provider consumer`,
      secretName: `${label.toLowerCase()}-model-provider-key`,
    });
    for (const [settings, message] of rows) {
      const values = { ...runtimeSelected, ...at("/models/providers/openai", settings) };
      await refusedAtSaveAndDeploy(context, agent, values, message);
    }
    assert.equal(configurationDriver.storedConfigurations().length, 1, label);
    // No refused deployment admitted a revision; the restored row deploys.
    const revisions = await request(context.app, "GET", `${agent.agentPath}/revisions`);
    assert.deepEqual(revisions.body.data, [], label);
    const deployed = await request(context.app, "POST", `${agent.agentPath}/deploy`);
    assert.equal(deployed.status, 202, `${label}: ${JSON.stringify(deployed.body)}`);
  }
});

test("Configuration HTTP refuses a model provider models setting that is not a list", async (t) => {
  // Finding 1186: the credential rules walk only a list of model rows, so a record of rows
  // carried a literal credential header past them into storage, and OpenClaw refused the
  // document only when the Gateway started. Every provider is checked, selected or not.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: createOpenClawConfiguration() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = "synthetic-model-credential-not-for-configuration";
  for (const [providers, key] of [
    [
      { gateway: { models: { m: { id: "m", headers: { "x-api-key": sentinel } } } } },
      "models.providers.gateway",
    ],
    [{ "my gateway": { models: null } }, 'models.providers["my gateway"]'],
    [{ openai: { models: "gpt-5" } }, "models.providers.openai"],
    [{ gateway: { models: {} } }, "models.providers.gateway"],
    // The list first, as on Kubernetes Compute, when a header name is refused too.
    [{ gateway: { models: {}, headers: { "x-api-key ": sentinel } } }, "models.providers.gateway"],
  ]) {
    const message = setting(`${key}.models`, "must be an array of model entries");
    await refusedOnSave(context, { models: { providers } }, message, { item, sentinel });
  }
  const unchanged = await request(context.app, "GET", item);
  assert.deepEqual(unchanged.body.data, created.body.data);
  await assertNothingStored(context, [`${created.body.data.id}.json`]);
  // A list, an empty one, or no models setting still saves.
  const listed = { models: { providers: { gateway: { models: [] }, openai: {} } } };
  const updated = await request(context.app, "PATCH", item, { body: { values: listed } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.values, listed);
});

const withAgents = (agents) => ({ agents: { defaults: runtimeDefaults, ...agents } });

// The Gateway roster's text for an Agent ID it rejects.
const gatewayId = (path) =>
  `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`;

// A selected Compute with no Configuration rules is not the same as no Compute selected.
// The shared content rules (model providers, settings, roster) must protect Configuration create
// and update in either case.
test("Configuration save checks the shared content rules before a Compute Driver is selected", async () => {
  const context = await fixture();
  const { collection } = context;
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: createOpenClawConfiguration() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${collection}/${created.body.data.id}`;
  const provider = "/models/providers/gateway";
  for (const [values, message] of [
    [at(provider, { baseUrl: "ftp://models.example/v1" }), absoluteUrl(`${provider}/baseUrl`)],
    [
      at(provider, { models: {} }),
      setting("models.providers.gateway.models", "must be an array of model entries"),
    ],
    [approvalPolicy("untrusted"), policyRetired],
    [withAgents({ entries: { "main!": {} } }), gatewayId('agents.entries["main!"]')],
  ]) {
    await refusedOnSave(context, values, message, { item, preset: false });
  }
  const unchanged = await request(context.app, "GET", item);
  assert.deepEqual(unchanged.body.data, created.body.data);
});

// One shape per rule. Every topology's OpenClaw Gateway rejects each (finding 874).
const rosterRefusals = [
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
];

test("Configuration save refuses an agents roster every deployment refuses, with deployment's text", async () => {
  // Deployment runs the real Kubernetes Compute roster rules.
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-roster-integration", "validateHarnessAuth"),
  });
  const valid = withAgents({});
  const agent = await storedRowAgent(context, configurationDriver, valid, {
    name: "Roster consumer",
    secretName: "roster-key",
  });
  // An existing row with the shape still reads, and deployment refuses it as before, with the
  // text the save gives.
  for (const [values, message] of rosterRefusals) {
    await refusedAtSaveAndDeploy(context, agent, values, message);
  }
  assert.equal(configurationDriver.storedConfigurations().length, 1);
  // Only a write that keeps the shape is refused: replacing it with a valid roster saves.
  const unowned = withAgents({ entries: { main: {}, helper: {} } });
  await writePastOcc(configurationDriver, agent.configurationId, unowned);
  const fixed = withAgents({ ownership: "explicit", entries: { main: {}, helper: {} } });
  const repaired = await request(context.app, "PATCH", agent.item, { body: { values: fixed } });
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
    const saved = await request(context.app, "POST", context.collection, {
      body: { kind: "agent", values },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.values, values);
  }
});

test("Preset save refuses an agents roster every deployment refuses, as Configuration save does", async (t) => {
  // Finding 1308: Preset save skipped the agents shape and Gateway roster rules, so a Preset
  // with a roster every deployment refuses saved and failed only when a launch created its
  // Configuration. An Agent ID or ownership that waits on an unfilled variable is checked as far
  // as its written text goes, and in full once filled.
  const context = await saveFixture(
    t,
    kubernetesRules("compute-roster-preset", ...configurationRules),
  );
  const variables = {
    id: { type: "string" },
    ownership: { type: "string" },
    count: { type: "number" },
  };
  const template = (values) => ({ variables, configuration: { values } });
  const onlyExplicit =
    'The OpenClaw Gateway accepts only "explicit" for agents.ownership: set it to "explicit", or remove it if agents.entries has at most one entry.';
  const ownership = (written) => [
    withAgents({ ownership: written, entries: { main: {} } }),
    onlyExplicit,
  ];
  const refused = [
    ...rosterRefusals,
    // Written text no filling makes a valid Agent ID: a space, or a leading -.
    [
      withAgents({ entries: { "main {{ vars.id }}": {} } }),
      gatewayId('agents.entries["main {{ vars.id }}"]'),
    ],
    [
      withAgents({ entries: { "-{{ vars.id }}": {} } }),
      gatewayId('agents.entries["-{{ vars.id }}"]'),
    ],
    // An ownership no filling makes "explicit", or that a number variable fills.
    ownership("shared-{{ vars.ownership }}"),
    ownership("{{ vars.count }}"),
    // Each written part is matched after the one before it, never overlapping it.
    ownership("expl{{ vars.ownership }}plicit"),
    ownership("exp{{ vars.ownership }}x{{ vars.ownership }}t"),
    ownership("ex{{ vars.ownership }}p{{ vars.ownership }}p{{ vars.ownership }}t"),
    // Written text longer than 64 characters makes no valid Agent ID, whatever fills it.
    [
      withAgents({ entries: { [`${"a".repeat(65)}{{ vars.id }}`]: {} } }),
      gatewayId(`agents.entries["${"a".repeat(65)}{{ vars.id }}"]`),
    ],
    // Finding 1315: many adjacent variables are matched in linear time. Keep this case last.
    ownership(`${"{{ vars.ownership }}".repeat(64)}x`),
  ];
  for (const [index, [values, message]] of refused.entries()) {
    await t.test(`refuses Preset ${index}: ${message}`, async () => {
      const started = Date.now();
      assertRefused(await savePreset(context, template(values)), message, {
        label: JSON.stringify(values),
      });
      if (index === refused.length - 1) {
        // Finding 1315: a save blocks the controller while it checks, so it must stay fast.
        assert.ok(Date.now() - started < 5_000, JSON.stringify(values));
      }
    });
  }
  await assertNothingStored(context);

  // An Agent ID or ownership that a filling can still make valid saves, and the launch's
  // Configuration is checked in full: two IDs that normalize alike, or an ownership filled with
  // anything but "explicit", are refused there with the Configuration save text.
  await t.test("accepts a roster whose Agent ID or ownership waits on a variable", async () => {
    const accepted = [
      withAgents({ ownership: "explicit", entries: { "{{ vars.id }}": {}, main: {} } }),
      withAgents({ entries: { "agent-{{ vars.id }}": {} } }),
      withAgents({ ownership: "{{ vars.ownership }}", entries: { main: {}, helper: {} } }),
      withAgents({ ownership: "ex{{ vars.ownership }}", entries: { main: {}, helper: {} } }),
      withAgents({ ownership: "ex{{ vars.ownership }}plicit", entries: { main: {}, helper: {} } }),
      withAgents({ entries: { [`${"a".repeat(64)}{{ vars.id }}`]: {} } }),
    ];
    for (const [index, values] of accepted.entries()) {
      const saved = await savePreset(context, template(values), `Templated-${index}`);
      assert.equal(saved.status, 201, `${JSON.stringify(values)}: ${JSON.stringify(saved.body)}`);
    }
    for (const [values, inputs, message] of [
      [
        accepted[0],
        { id: "Main" },
        "The OpenClaw Gateway normalizes agents.entries.Main and agents.entries.main to the same Agent ID: rename one.",
      ],
      [accepted[2], { ownership: "shared" }, onlyExplicit],
    ]) {
      const launched = await request(context.app, "POST", context.collection, {
        body: {
          kind: "agent",
          ...renderPresetTemplate(template(values), { count: 1, ...inputs }).configuration,
        },
      });
      assertRefused(launched, message);
    }
  });
});

test("Configuration save and Kubernetes deployment admission refuse settings preparation would refuse", async () => {
  // Deployment runs the real Kubernetes Compute admission rules. On a dedicated Agent, a refusal
  // in preparation came after the running revision stopped, with no rollback (findings
  // 1113-1115); admission now names the setting first. The Compute's own Configuration rules
  // run too: they do not replace the shared settings rules on save.
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-settings-integration", ...configurationRules),
  });
  const valid = runtimeSelected;
  const agent = await storedRowAgent(context, configurationDriver, valid, {
    name: "Settings consumer",
    secretName: "settings-key",
  });
  const { item, agentPath } = agent;
  const password = (value) => ({ ...valid, gateway: { auth: { password: value } } });
  const kubernetesPassword = setting(
    "gateway.auth.password",
    'must be the environment reference {source: "env", id: "OPENCLAW_GATEWAY_PASSWORD"}, whose value Kubernetes Compute generates',
  );

  // Topology-independent rules: the save refuses with a 400 naming the setting; an existing row
  // still reads, and deployment refuses it before any revision is admitted.
  for (const [values, message, deployMessage = message] of [
    [approvalPolicy("always"), policyEnum],
    [approvalPolicy("untrusted"), policyRetired],
    [password("literal-gateway-password"), gatewayPassword, kubernetesPassword],
  ]) {
    await refusedAtSaveAndDeploy(context, agent, values, message, {
      status: 409,
      message: deployMessage,
    });
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
    approvalPolicy("never"),
    approvalPolicy("on-request"),
    approvalPolicy("on-failure"),
    password({ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" }),
    password("${OPENCLAW_GATEWAY_PASSWORD}"),
  ]) {
    const saved = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(saved.status, 200, `${JSON.stringify(values)}: ${JSON.stringify(saved.body)}`);
  }
});

test("Preset save refuses a Codex approval policy every Gateway refuses, as Configuration save does", async (t) => {
  // Finding 1311: Preset save skipped the settings rules Configuration save and Agent
  // provisioning run, so a Preset with a retired or unknown Codex approval policy saved and was
  // refused only when a launch created its Configuration. A policy that waits on an unfilled
  // variable is checked as far as its written text goes, and in full once filled. The rule holds
  // on every Compute, so none of Kubernetes' own rules run here.
  const context = await saveFixture(t);
  const variables = { policy: { type: "string" }, count: { type: "number" } };
  const template = (policy) => ({ variables, configuration: { values: approvalPolicy(policy) } });
  for (const [policy, message] of [
    ["untrusted", policyRetired],
    ["always", policyEnum],
    [{ mode: "never" }, policyEnum],
    // Written text no filling makes an accepted policy, or a number variable.
    ["un{{ vars.policy }}", policyEnum],
    ["{{ vars.policy }}-never", policyEnum],
    ["{{ vars.count }}", policyEnum],
  ]) {
    assertRefused(await savePreset(context, template(policy)), message, {
      label: JSON.stringify(policy),
    });
  }
  await assertNothingStored(context);

  // A policy a filling can still make accepted saves.
  for (const [index, policy] of [
    "never",
    "on-request",
    "on-failure",
    "{{ vars.policy }}",
    "on-{{ vars.policy }}",
    "{{ vars.policy }}ever",
  ].entries()) {
    const saved = await savePreset(context, template(policy), `Accepted-${index}`);
    assert.equal(saved.status, 201, `${policy}: ${JSON.stringify(saved.body)}`);
  }
  // The filled Preset reaches the same rule on the Configuration its launch creates.
  const launched = await request(context.app, "POST", context.collection, {
    body: {
      kind: "agent",
      ...renderPresetTemplate(template("{{ vars.policy }}"), { policy: "untrusted", count: 1 })
        .configuration,
    },
  });
  assertRefused(launched, policyRetired);
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

  // The provider apiKey rule depends only on the Configuration's primary model and Harness, so
  // save refuses it too (finding 1299), and deployment names it on a row stored earlier.
  const apiKey = {
    ...valid,
    models: {
      providers: {
        openai: { apiKey: { source: "env", provider: "default", id: "OTHER_MODEL_KEY" } },
      },
    },
  };
  const apiKeyRefusal = setting(
    "models.providers.openai.apiKey",
    "must be ${OPENAI_API_KEY} or an env SecretRef to OPENAI_API_KEY, which the Agent's Harness authentication binding supplies",
  );
  const saved = await request(context.app, "PATCH", item, { body: { values: apiKey } });
  assert.equal(saved.status, 400, JSON.stringify(saved.body));
  assert.equal(saved.body.error.message, apiKeyRefusal);
  await storeAsOlderRelease(apiKey);
  const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(deployed.body.error.message, apiKeyRefusal);
  await storeAsOlderRelease(valid);
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

test("Configuration save refuses a model selection or apiKey off the primary model's provider, naming the setting", async (t) => {
  // Findings 1298 and 1299: these saved and failed only at deployment, which named no setting
  // for a fallback. The rules depend only on the Configuration, so no Agent is consulted.
  const configurationDriver = createConfigurationBackend();
  const context = await fixture({
    configurationDriver,
    computeDriver: kubernetesRules("compute-model-provider-save", ...configurationRules),
  });
  const { namespace, collection } = context;
  const valid = runtimeSelected;
  const { created, configurationId, item, agentPath } = await deployableAgent(context, namespace, {
    values: valid,
    name: "Model provider consumer",
    secretName: "model-provider-key",
  });
  const other = "anthropic/claude-opus-4";
  const fallback = setting(
    "agents.defaults.model.fallbacks",
    "must use the primary model's provider",
  );
  // A default model setting off the openai provider, and the refusal that names it.
  const offDefaults = (path, settings) => [
    { agents: { defaults: { ...runtimeDefaults, ...settings } } },
    setting(`agents.defaults.${path}`, openaiOnly),
  ];
  const offProvider = [
    offDefaults("subagents.model", { subagents: { model: other } }),
    offDefaults("imageModel", { imageModel: other }),
    offDefaults("pdfModel.primary", { pdfModel: { primary: other } }),
    // Finding 1306: OpenClaw's explicit /model allowlist, on the defaults and on an Agent entry.
    offDefaults("modelPolicy.allow", { modelPolicy: { allow: [runtimeDefaults.model, other] } }),
    [
      {
        agents: {
          defaults: runtimeDefaults,
          entries: { main: { modelPolicy: { allow: ["openai/*", other] } } },
        },
      },
      setting("agents.entries.main.modelPolicy.allow", openaiOnly),
    ],
    // Finding 1310: OpenClaw reads openrouter:auto and openrouter:free, which have no slash, as
    // the openrouter provider's models, trimmed and in any case.
    offDefaults("subagents.model", { subagents: { model: "openrouter:auto" } }),
    offDefaults("modelPolicy.allow", { modelPolicy: { allow: [" OpenRouter:Free "] } }),
    // The provider with no model, a root model setting, and fallbacks that are not a list.
    offDefaults("subagents.model", { subagents: { model: "openai/" } }),
    [{ ...valid, tts: { summaryModel: other } }, setting("tts.summaryModel", openaiOnly)],
    [
      {
        agents: {
          defaults: {
            ...runtimeDefaults,
            subagents: { model: { primary: runtimeDefaults.model, fallbacks: other } },
          },
        },
      },
      setting("agents.defaults.subagents.model.fallbacks", "must be provider/model references"),
    ],
    [
      {
        ...valid,
        models: {
          providers: {
            anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "${ANTHROPIC_API_KEY}" },
          },
        },
      },
      setting(
        "models.providers.anthropic.apiKey",
        "must be unset: the Agent's Harness authentication binding serves only openai models",
      ),
    ],
    [
      {
        agents: {
          defaults: {
            ...runtimeDefaults,
            model: { primary: runtimeDefaults.model, fallbacks: [other] },
          },
        },
      },
      fallback,
    ],
  ];
  // One subtest per refusal, so each stands on its own. The console's Save Configuration sends
  // the PATCH; a Preset save refuses the same text.
  for (const [values, message] of offProvider) {
    await t.test(message, async () => {
      await refusedOnSave(context, values, message, { item, sentinel: "claude-opus-4" });
      const unchanged = await request(context.app, "GET", item);
      assert.deepEqual(unchanged.body.data, created.body.data, JSON.stringify(values));
    });
  }

  // A row stored before the fallback rule still reads; Agent save and deployment name it.
  await t.test("a stored fallback on another provider", async () => {
    const entryFallback = {
      agents: {
        defaults: runtimeDefaults,
        entries: {
          main: { model: { primary: runtimeDefaults.model, fallbacks: [other] } },
        },
      },
    };
    for (const [values, message] of [
      [offProvider.at(-1)[0], fallback],
      [
        entryFallback,
        setting("agents.entries.main.model.fallbacks", "must use the primary model's provider"),
      ],
    ]) {
      const label = JSON.stringify(values);
      await writePastOcc(configurationDriver, configurationId, values);
      const agentSaved = await request(context.app, "PATCH", agentPath, {
        body: { configurationId },
      });
      assertRefused(agentSaved, message, { label });
      assertRefused(await request(context.app, "POST", `${agentPath}/deploy`), message, { label });
      // Refused before a revision exists.
      const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
      assert.deepEqual(revisions.body.data, [], label);
      await writePastOcc(configurationDriver, configurationId, valid);
    }
  });

  // Finding 1310: deployment reads an OpenRouter compatibility selector as save does, so a row
  // stored before the rule is refused by name before a revision exists.
  await t.test("a stored OpenRouter compatibility selector", async () => {
    const values = {
      agents: { defaults: { ...runtimeDefaults, heartbeat: { model: "openrouter:auto" } } },
    };
    const message = setting("agents.defaults.heartbeat.model", openaiOnly);
    await writePastOcc(configurationDriver, configurationId, values);
    assertRefused(await request(context.app, "POST", `${agentPath}/deploy`), message);
    const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
    assert.deepEqual(revisions.body.data, []);
    await writePastOcc(configurationDriver, configurationId, valid);
  });

  // A Configuration whose model policy selects the Codex Harness runs as Dedicated Codex, which
  // takes no provider apiKey at all.
  const codexDefaults = {
    model: "codex/gpt-5",
    models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
  };
  const codexItem = async () => {
    const codex = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: { agents: { defaults: codexDefaults } } },
    });
    assert.equal(codex.status, 201, JSON.stringify(codex.body));
    return `${collection}/${codex.body.data.id}`;
  };
  await t.test("a provider apiKey on Dedicated Codex", async () => {
    const codex = await codexItem();
    // A null key is still set: deployment refuses it, so save does too.
    for (const apiKey of ["${OPENAI_API_KEY}", null]) {
      const values = {
        agents: { defaults: codexDefaults },
        models: { providers: { codex: { apiKey } } },
      };
      const message = setting(
        "models.providers.codex.apiKey",
        "must be unset: Dedicated Codex receives model credentials from the Agent's Harness authentication binding",
      );
      await refusedOnSave(context, values, message, { item: codex });
    }
  });

  // Finding 1306: Dedicated Codex qualifies each /model allowlist entry as it does a models
  // policy key, so an entry needs its provider, and OpenClaw calls media and voice models
  // directly, which Codex does not serve.
  await t.test("an allowlist entry, media or voice model on Dedicated Codex", async () => {
    const codex = await codexItem();
    const unset =
      "must be unset: Dedicated Codex serves chat models only, not media or voice models";
    for (const [defaults, message] of [
      [
        { modelPolicy: { allow: ["codex/gpt-5", "gpt-5"] } },
        setting(
          "agents.defaults.modelPolicy.allow",
          "must select codex/<model>, the provider of the Agent's Harness authentication binding",
        ),
      ],
      [
        { mediaModels: { image: "codex/gpt-image-1" } },
        setting("agents.defaults.mediaModels.image", unset),
      ],
      [
        { mediaModels: { video: { primary: "codex/sora-2", fallbacks: [] } } },
        setting("agents.defaults.mediaModels.video", unset),
      ],
      [{ voiceModel: "codex/gpt-realtime" }, setting("agents.defaults.voiceModel", unset)],
    ]) {
      const values = { agents: { defaults: { ...codexDefaults, ...defaults } } };
      await refusedOnSave(context, values, message, { item: codex });
    }
    // A qualified entry or wildcard saves.
    const allowed = {
      agents: {
        defaults: { ...codexDefaults, modelPolicy: { allow: ["codex/gpt-5", "codex/*"] } },
      },
    };
    const saved = await request(context.app, "PATCH", codex, { body: { values: allowed } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });

  // Oracle: a caller who may update Configurations but not read Agents gets the same answer for
  // the Configuration an Agent uses as for one no Agent uses, and nothing names the Agent.
  await t.test("a caller who cannot read the Agent learns nothing about it", async () => {
    const unused = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: valid },
    });
    assert.equal(unused.status, 201, JSON.stringify(unused.body));
    const role = context.roles.find(({ id }) => id === "role-configuration-integration");
    const answers = async (values) => {
      const responses = [];
      for (const path of [item, `${collection}/${unused.body.data.id}`]) {
        const { status, body } = await request(context.app, "PATCH", path, { body: { values } });
        responses.push({ status, error: body.error });
      }
      assert.deepEqual(responses[0], responses[1], JSON.stringify(values));
      return responses[0];
    };
    role.permissions = [
      { action: "read", resourceKind: "configuration" },
      { action: "update", resourceKind: "configuration" },
    ];
    const memberAgentRead = await request(context.app, "GET", agentPath);
    assert.equal(memberAgentRead.status, 403, JSON.stringify(memberAgentRead.body));
    const refused = await answers(offProvider[1][0]);
    assert.equal(refused.status, 400);
    assert.equal(refused.error.message, offProvider[1][1]);
    assert.equal((await answers(valid)).status, 200);
    // A zero-grant member gets the uniform 403, whatever the values.
    role.permissions = [];
    for (const values of [valid, offProvider[1][0]]) {
      const denied = await answers(values);
      assert.equal(denied.status, 403);
      assert.equal(denied.error.code, "FORBIDDEN");
    }
  });
});

test("Preset save refuses a model selection or apiKey off the primary model's provider, as Configuration save does", async (t) => {
  // Finding 1305: Preset saves skipped the rules of findings 1298 and 1299, so a Preset whose
  // defaults selected another provider saved and was refused only when a launch created its
  // Configuration. A provider that waits on an unfilled variable is checked once filled.
  const context = await saveFixture(
    t,
    kubernetesRules("compute-model-provider-preset", ...configurationRules),
  );
  const other = "anthropic/claude-opus-4";
  const variables = {
    model: { type: "string" },
    provider: { type: "string" },
    key: { type: "string" },
    count: { type: "number" },
  };
  const inputs = { model: "gpt-5", provider: "openai", key: "OPENAI_API_KEY", count: 1 };
  // The primary model's provider is written; its model waits on a variable.
  const templated = {
    model: "openai/{{ vars.model }}",
    models: { "openai/{{ vars.model }}": { agentRuntime: { id: "openclaw" } } },
  };
  const refused = [
    [
      { agents: { defaults: { ...runtimeDefaults, imageModel: other } } },
      setting("agents.defaults.imageModel", openaiOnly),
    ],
    [
      {
        agents: { defaults: { ...templated, subagents: { model: "anthropic/{{ vars.model }}" } } },
      },
      setting("agents.defaults.subagents.model", openaiOnly),
    ],
    [
      {
        agents: {
          defaults: {
            ...templated,
            model: { primary: templated.model, fallbacks: ["anthropic/{{ vars.model }}"] },
          },
        },
      },
      setting("agents.defaults.model.fallbacks", "must use the primary model's provider"),
    ],
    [
      {
        ...runtimeSelected,
        models: { providers: { anthropic: { apiKey: "${ANTHROPIC_API_KEY}" } } },
      },
      setting(
        "models.providers.anthropic.apiKey",
        "must be unset: the Agent's Harness authentication binding serves only openai models",
      ),
    ],
    [
      { agents: { defaults: templated }, models: { providers: { openai: { apiKey: "${KEY}" } } } },
      setting(
        "models.providers.openai.apiKey",
        "must be ${OPENAI_API_KEY} or an env SecretRef to OPENAI_API_KEY, which the Agent's Harness authentication binding supplies",
      ),
    ],
    // A number variable that is the whole selection fills it with no string.
    [
      { agents: { defaults: { ...runtimeDefaults, pdfModel: "{{ vars.count }}" } } },
      setting("agents.defaults.pdfModel", "must be provider/model references"),
    ],
    // Finding 1306: an allowlist entry is checked like a selection, a written provider at save.
    [
      {
        agents: {
          defaults: { ...templated, modelPolicy: { allow: ["anthropic/{{ vars.model }}"] } },
        },
      },
      setting("agents.defaults.modelPolicy.allow", openaiOnly),
    ],
    [
      {
        agents: { defaults: { ...runtimeDefaults, modelPolicy: { allow: ["{{ vars.count }}"] } } },
      },
      setting("agents.defaults.modelPolicy.allow", "must be provider/model references"),
    ],
    // Finding 1310: an OpenRouter compatibility selector names the openrouter provider.
    [
      { agents: { defaults: { ...templated, utilityModel: "openrouter:free" } } },
      setting("agents.defaults.utilityModel", openaiOnly),
    ],
    // A fallback and a policy key whose provider waits on a variable leave the rest checked.
    [
      {
        agents: {
          defaults: {
            model: { primary: templated.model, fallbacks: ["{{ vars.provider }}/gpt-5-mini"] },
            models: {
              ...templated.models,
              "{{ vars.provider }}/gpt-5-mini": { agentRuntime: { id: "openclaw" } },
            },
            imageModel: other,
          },
        },
      },
      setting("agents.defaults.imageModel", openaiOnly),
    ],
    // So does an Agent entry whose model's provider waits on one.
    [
      {
        agents: {
          defaults: { ...templated, imageModel: other },
          entries: { main: { model: "{{ vars.provider }}/{{ vars.model }}" } },
        },
      },
      setting("agents.defaults.imageModel", openaiOnly),
    ],
    [
      {
        agents: {
          defaults: { ...templated, imageModel: other },
          entries: { main: { model: { primary: "{{ vars.provider }}/{{ vars.model }}" } } },
        },
      },
      setting("agents.defaults.imageModel", openaiOnly),
    ],
    // A variable in another secrets source leaves the apiKey reference checked.
    [
      {
        agents: { defaults: templated },
        secrets: { providers: { other: { source: "env", allowlist: ["{{ vars.key }}"] } } },
        models: {
          providers: { openai: { apiKey: { source: "env", provider: "default", id: "KEY" } } },
        },
      },
      setting(
        "models.providers.openai.apiKey",
        "must be ${OPENAI_API_KEY} or an env SecretRef to OPENAI_API_KEY, which the Agent's Harness authentication binding supplies",
      ),
    ],
    // As the standard Codex Preset, plus an apiKey Dedicated Codex never takes.
    [
      {
        agents: {
          defaults: {
            model: "codex/{{ vars.model }}",
            models: { "codex/{{ vars.model }}": { agentRuntime: { id: "codex" } } },
          },
        },
        models: { providers: { codex: { apiKey: "${OPENAI_API_KEY}" } } },
      },
      setting(
        "models.providers.codex.apiKey",
        "must be unset: Dedicated Codex receives model credentials from the Agent's Harness authentication binding",
      ),
    ],
  ];
  const launch = (template) =>
    request(context.app, "POST", context.collection, {
      body: { kind: "agent", ...renderPresetTemplate(template, inputs).configuration },
    });
  for (const [index, [values, message]] of refused.entries()) {
    const label = JSON.stringify(values);
    await t.test(`refuses Preset ${index}: ${message}`, async () => {
      const template = { variables, configuration: { values } };
      assertRefused(await savePreset(context, template), message, {
        label,
        sentinel: "claude-opus-4",
      });
      // The same message as the Configuration a launch would create.
      assertRefused(await launch(template), message, { label });
    });
  }
  await assertNothingStored(context);

  // A selection, fallback, provider key or apiKey whose provider (or key source) waits on a
  // variable saves and is checked once filled; so is a primary whose provider does, which
  // selects no supported provider yet.
  await t.test("accepts a Preset whose provider waits on a variable", async () => {
    const accepted = [
      {
        agents: {
          defaults: {
            ...templated,
            imageModel: "{{ vars.provider }}/gpt-image-1",
            subagents: { model: "{{ vars.model }}" },
            modelPolicy: { allow: ["{{ vars.provider }}/gpt-5", "openai/{{ vars.model }}"] },
          },
        },
        models: {
          providers: {
            "{{ vars.provider }}": { apiKey: "${ANTHROPIC_API_KEY}" },
            openai: { apiKey: { source: "env", provider: "default", id: "{{ vars.key }}" } },
          },
        },
      },
      {
        agents: {
          defaults: {
            model: { primary: templated.model, fallbacks: ["{{ vars.provider }}/gpt-5-mini"] },
            models: {
              ...templated.models,
              "{{ vars.provider }}/gpt-5-mini": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            model: "{{ vars.provider }}/{{ vars.model }}",
            models: {
              "{{ vars.provider }}/{{ vars.model }}": { agentRuntime: { id: "openclaw" } },
            },
            imageModel: other,
          },
        },
      },
      // An Agent entry's fallback, and an apiKey SecretRef whose default env alias, secrets source
      // name or source body waits on a variable.
      {
        agents: {
          defaults: templated,
          entries: {
            main: {
              model: { primary: templated.model, fallbacks: ["{{ vars.provider }}/gpt-5-mini"] },
            },
          },
        },
      },
      ...[
        { defaults: { env: "{{ vars.key }}" } },
        { providers: { "{{ vars.key }}": { source: "env" } } },
        { providers: { "vault-env": { source: "{{ vars.key }}" } } },
      ].map((secrets) => ({
        agents: { defaults: templated },
        secrets,
        models: {
          providers: {
            openai: { apiKey: { source: "env", provider: "vault-env", id: "OPENAI_API_KEY" } },
          },
        },
      })),
    ];
    for (const [index, values] of accepted.entries()) {
      const template = { variables, configuration: { values } };
      const saved = await savePreset(context, template, `Templated-${index}`);
      assert.equal(saved.status, 201, `${JSON.stringify(values)}: ${JSON.stringify(saved.body)}`);
    }
    // Filled with another provider, the launch's Configuration is refused by name.
    const launched = await launch({ variables, configuration: { values: accepted[2] } });
    assertRefused(launched, setting("agents.defaults.imageModel", openaiOnly));
  });

  // Every shipped Preset still saves.
  await t.test("accepts every shipped Preset", async () => {
    const files = [
      ...(await readdir(new URL("../../deploy/presets/", import.meta.url)))
        .filter((file) => file.endsWith(".json"))
        .map((file) => new URL(`../../deploy/presets/${file}`, import.meta.url)),
      new URL("../../deploy/examples/slack-team-preset.json", import.meta.url),
    ];
    assert.ok(files.length >= 5);
    for (const file of files) {
      const preset = JSON.parse(await readFile(file, "utf8"));
      const saved = await request(context.app, "POST", context.presets, { body: preset });
      assert.equal(saved.status, 201, `${file}: ${JSON.stringify(saved.body)}`);
    }
  });
});

test("Configuration and Preset saves check an OpenRouter compatibility selector as a model fallback or primary", async (t) => {
  // Finding 1320: the fallback rule kept only references with a slash, so OpenClaw's
  // openrouter:auto and openrouter:free were never checked. A Codex primary with an
  // openrouter:auto fallback saved and deployment refused it with a message that named no
  // setting, and any fallback under an openrouter:auto primary saved unchecked. Both read as the
  // openrouter provider's models now (finding 1310), so the rule names the setting at save.
  const context = await saveFixture(
    t,
    kubernetesRules("compute-openrouter-fallbacks", ...configurationRules),
  );
  const codex = {
    model: "codex/gpt-5",
    models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
  };
  const withModel = (model, defaults = codex) => ({
    agents: { defaults: { ...defaults, model } },
  });
  const fallbacks = (path) =>
    setting(`${path}.model.fallbacks`, "must use the primary model's provider");
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: withModel(codex.model) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  for (const [values, path] of [
    [withModel({ primary: codex.model, fallbacks: ["openrouter:auto"] }), "agents.defaults"],
    [withModel({ primary: codex.model, fallbacks: [" OpenRouter:Free "] }), "agents.defaults"],
    [
      {
        agents: {
          defaults: codex,
          entries: { main: { model: { primary: codex.model, fallbacks: ["openrouter:free"] } } },
        },
      },
      "agents.entries.main",
    ],
    // An openrouter:auto primary keeps its fallbacks on openrouter.
    [withModel({ primary: "openrouter:auto", fallbacks: ["codex/gpt-5"] }), "agents.defaults"],
    [withModel({ primary: "openrouter:free", fallbacks: ["openai/gpt-5"] }), "agents.defaults"],
  ]) {
    await refusedOnSave(context, values, fallbacks(path), { item });
  }
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // A Preset selector that waits on a variable is checked once filled: a default fills it here.
  const waiting = withModel({ primary: codex.model, fallbacks: ["openrouter:{{ vars.kind }}"] });
  const filled = await savePreset(context, {
    variables: { kind: { type: "string", default: "auto" } },
    configuration: { values: waiting },
  });
  assertRefused(filled, fallbacks("agents.defaults"));
  const deferred = await savePreset(
    context,
    { variables: { kind: { type: "string" } }, configuration: { values: waiting } },
    "OpenRouter-deferred",
  );
  assert.equal(deferred.status, 201, JSON.stringify(deferred.body));

  // Fallbacks on the primary model's provider save, a compatibility selector among them.
  for (const [index, values] of [
    withModel({ primary: codex.model, fallbacks: ["codex/gpt-5-mini"] }),
    withModel({ primary: "openrouter:auto", fallbacks: ["openrouter:free", "openrouter/meta/m"] }),
    withModel({ primary: "openrouter/meta/m", fallbacks: [" OpenRouter:Auto "] }),
    // Only the two selectors name openrouter: another bare name is an alias, as written.
    {
      agents: {
        defaults: {
          ...codex,
          subagents: { model: "openrouter:auto-1" },
          heartbeat: { model: "my-openrouter:free" },
        },
      },
    },
  ].entries()) {
    const label = JSON.stringify(values);
    const saved = await request(context.app, "PATCH", item, { body: { values } });
    assert.equal(saved.status, 200, `${label}: ${JSON.stringify(saved.body)}`);
    const preset = await savePreset(context, { configuration: { values } }, `Accepted-${index}`);
    assert.equal(preset.status, 201, `${label}: ${JSON.stringify(preset.body)}`);
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
    // Only a stale expectedGeneration carries the /expectedGeneration detail; the console offers
    // Reload draft for that one, and a reread cannot fix this conflict (finding 1511).
    assert.equal(referenced.body.error.details, undefined);

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
  // The caller learns which field must become a reference, never the submitted value.
  assertRefused(rejected, literalModelKey("/models/providers/openai/apiKey"), { sentinel });
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
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-model-rule-credential-${randomUUID()}`;
  const gateway = (settings) => ({ models: { providers: { gateway: settings } } });
  const field = (path) => `/models/providers/gateway/${path}`;
  // Finding 1218: the refusal names the header up to its first invalid character, never past it.
  const invalidName = (name, path = "models.providers.gateway.headers") =>
    setting(path, `must use valid HTTP header names, not ${JSON.stringify(name)}`);
  // The models list rules are in the models setting test above.
  const refused = [
    [gateway({ headers: { "x-api-key ": sentinel } }), invalidName("x-api-key…")],
    // A name a Preset variable filled is refused here, so the person can find it.
    [gateway({ headers: { "X-Trace": "t", "Bad Header": "v" } }), invalidName("Bad…")],
    // A credential pasted into the name is never echoed.
    [
      gateway({ headers: { [`Authorization: Bearer ${sentinel}`]: "v" } }),
      invalidName("Authorization…"),
    ],
    // Finding 1222: nor whole when pasted alone, before a newline: the echo stops at 23 characters.
    [gateway({ headers: { [`${sentinel}\n`]: "v" } }), invalidName(`${sentinel.slice(0, 23)}…`)],
    [
      gateway({ models: [{ id: "m", request: { headers: { Authorizatioн: sentinel } } }] }),
      invalidName("Authorizatio…", "models.providers.gateway.models.0.request.headers"),
    ],
    [gateway({ baseUrl: "ftp://models.example.test" }), absoluteUrl(field("baseUrl"))],
    // Finding 1243: OpenClaw renders the `$${HOST}` escape as the literal text `${HOST}`, so it is
    // no environment reference and the URL is checked as written.
    [gateway({ baseUrl: "ftp://$${HOST}/v1" }), absoluteUrl(field("baseUrl"))],
    // Finding 1244: a user name or password in a model endpoint is a credential, as in a proxy URL.
    [
      gateway({
        models: [{ id: "m", baseUrl: `https://user:${sentinel}@models.example.test/v1` }],
      }),
      userinfo(field("models/0/baseUrl")),
    ],
    // Finding 1250: an environment reference the runtime fills in the host or port, where the URL
    // does not parse as written, leaves the user name and password a literal.
    [
      gateway({ baseUrl: `https://user:${sentinel}@models.example.test:\${MODEL_PORT}/v1` }),
      userinfo(field("baseUrl")),
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
      userinfo(field("request/proxy/url")),
    ],
    // The runtime renders a reference's fallback when the variable is unset.
    [
      gateway({ baseUrl: `https://\${MODEL_HOST:-user:${sentinel}@models.example.test}/v1` }),
      userinfo(field("baseUrl")),
    ],
    [
      gateway({
        request: {
          proxy: { mode: "explicit-proxy", url: `\${PROXY_URL:-http://u:${sentinel}@proxy:3128}` },
        },
      }),
      userinfo(field("request/proxy/url")),
    ],
    // One reference set and another unset: https://setu:<password>@models.example.test.
    [
      gateway({ baseUrl: `https://\${A_HOST:-h/}\${B_USER:-u:${sentinel}@models.example.test}` }),
      userinfo(field("baseUrl")),
    ],
    // The URL parser ends the user name at the last `@`, inside brackets too.
    [
      gateway({ baseUrl: `https://[\${MODEL_HOST}user:${sentinel}@models.example.test/]` }),
      userinfo(field("baseUrl")),
    ],
    // Credential header names the widened rule matches take only references.
    ...[
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
    ].map((name) => [
      gateway({ headers: { [name]: sentinel } }),
      literalModelKey(field(`headers/${name}`)),
    ]),
  ];
  for (const [values, message] of refused) {
    await refusedOnSave(context, values, message, { item, sentinel });
  }
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // Benign names and a bearer reference under an Authentication header still save.
  await acceptedOnSave(
    context,
    gateway({
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
      request: {
        proxy: { mode: "explicit-proxy", url: "${PROXY_URL:-http://proxy.example:3128}" },
      },
    }),
  );
  // A variable without a default is checked when its Configuration is created, not before.
  const variables = {
    url: { type: "string" },
    api: { type: "string" },
    header: { type: "string" },
    port: { type: "string" },
  };
  const templated = await savePreset(
    context,
    {
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
    "Templated",
  );
  assert.equal(templated.status, 201, JSON.stringify(templated.body));
  // Finding 1214: an escaped token, or a default that reads like one, stays literal text in the
  // launch render, so it is checked as written: these saved and then failed every launch.
  // Finding 1251: a name whose first character is invalid is named by that character's code
  // point, not an empty quote.
  const startsWith = (path = "models.providers.gateway.headers") =>
    setting(path, "must use valid HTTP header names, not one that starts with U+007B");
  for (const [values, message, agent] of [
    [gateway({ headers: { "\\{{ vars.header }}": "v" } }), startsWith()],
    [
      gateway({ headers: { "Authorization\\{{ vars.header }}": "v" } }),
      invalidName("Authorization…"),
    ],
    [gateway({ headers: { "\\{{ vars.undeclared }}": "v" } }), startsWith()],
    [gateway({ headers: { "{{ vars.literal }}": "v" } }), startsWith()],
    // A placeholder outside configuration renders the same text but does not admit it.
    [
      gateway({ headers: { "\\{{ vars.header }}": "v" } }),
      startsWith(),
      { name: "{{ vars.header }}" },
    ],
    [gateway({ baseUrl: "\\{{ vars.url }}" }), absoluteUrl(field("baseUrl"))],
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
      startsWith("models.providers.other.headers"),
    ],
    [
      gateway({
        headers: { "{{ vars.url }}": "v" },
        models: [{ id: "m", baseUrl: "\\{{ vars.url }}" }],
      }),
      absoluteUrl(field("models/0/baseUrl")),
    ],
    [
      gateway({ headers: { "{{ vars.header }}": "v" }, api: "{{ vars.literal }}" }),
      modelApi(field("api")),
    ],
    // Finding 1221: the text around a variable is checked with a stand-in for it. The refusal shows
    // the variable's placeholder up to the first invalid literal character.
    [gateway({ headers: { "{{ vars.header }} ": "v" } }), invalidName("{{ vars.header }}…")],
    [
      gateway({ headers: { "X-{{ vars.header }}\u200b": "v" } }),
      invalidName("X-{{ vars.header }}…"),
    ],
    [gateway({ headers: { "\\{{ vars.url }}-{{ vars.header }}": "v" } }), startsWith()],
    [gateway({ baseUrl: "ftp://{{ vars.url }}" }), absoluteUrl(field("baseUrl"))],
    [
      gateway({ models: [{ id: "m", baseUrl: "https://models {{ vars.url }}.test" }] }),
      absoluteUrl(field("models/0/baseUrl")),
    ],
    // Finding 1243: a literal scheme other than http(s) is refused however many variables follow.
    [
      gateway({
        baseUrl: "ftp://{{ vars.url }}{{ vars.api }}{{ vars.header }}{{ vars.port }}{{ vars.url }}",
      }),
      absoluteUrl(field("baseUrl")),
    ],
    // Finding 1244: the text around a variable names a credential header, which takes no literal,
    // and a variable in a model endpoint's user name or password fills a credential.
    [
      gateway({ headers: { "Authorization{{ vars.header }}": "Bearer synthetic" } }),
      literalModelKey(field("headers/Authorization{{ vars.header }}")),
    ],
    [
      gateway({ baseUrl: "https://user:{{ vars.url }}@models.example.test/v1" }),
      userinfo(field("baseUrl")),
    ],
    // Finding 1250: so is literal userinfo, or a variable that is the whole of it, where a variable
    // fills the host or port and the URL does not parse until filled.
    ...[
      ["baseUrl", `https://user:${sentinel}@{{ vars.url }}/v1`],
      ["baseUrl", "https://{{ vars.header }}@{{ vars.url }}/v1"],
      ["baseUrl", `{{ vars.url }}://user:${sentinel}@{{ vars.api }}/v1`],
      // A baseUrl needs literal slashes after its scheme (finding 1259); a proxy URL does not.
      ["request/proxy/url", `https:{{ vars.url }}//user:${sentinel}@{{ vars.api }}/v1`],
      ["baseUrl", `https://[{{ vars.url }}user:${sentinel}@models.test/]`],
      ["models/0/baseUrl", `https://user:${sentinel}@models.test:{{ vars.port }}/v1`],
      ["request/proxy/url", `http://u:${sentinel}@{{ vars.url }}`],
      // A variable scheme may be socks5, where a backslash stays in the user name.
      ["request/proxy/url", `{{ vars.api }}://u\\x:${sentinel}@{{ vars.url }}:{{ vars.port }}`],
      ["models/0/request/proxy/url", `http://u:${sentinel}@proxy:{{ vars.port }}`],
    ].map(([path, url]) => {
      // A proxy URL sits beside its mode, and a model row has an id.
      const proxy = { request: { proxy: { mode: "explicit-proxy", url } } };
      const settings = path.endsWith("proxy/url") ? proxy : { baseUrl: url };
      const row = path.startsWith("models/") ? { models: [{ id: "m", ...settings }] } : settings;
      return [gateway(row), userinfo(field(path))];
    }),
    // A model row's credential header is matched as the text around its variables too.
    [
      gateway({
        models: [{ id: "m", headers: { "Authorization{{ vars.header }}": "Bearer synthetic" } }],
      }),
      literalModelKey(field("models/0/headers/Authorization{{ vars.header }}")),
    ],
  ]) {
    const escaped = await savePreset(context, {
      variables: { ...variables, literal: { type: "string", default: "{{ vars.header }}" } },
      agent,
      configuration: { values },
    });
    assertRefused(escaped, message, { label: JSON.stringify(values), sentinel });
  }
  // A default that fills a header name is a literal name: a credential name takes no literal.
  const filledCredential = await savePreset(context, {
    variables: { header: { type: "string", default: "x-api-key" } },
    configuration: { values: gateway({ headers: { "{{ vars.header }}": sentinel } }) },
  });
  assert.equal(filledCredential.status, 400, JSON.stringify(filledCredential.body));
  assert.match(filledCredential.body.error.message, /holds a credential value inline/);
  assert.equal(JSON.stringify(filledCredential.body).includes(sentinel), false);
  // A default is checked like any value.
  const defaulted = await savePreset(context, {
    variables: { url: { type: "string", default: "ftp://models.example.test" } },
    configuration: { values: gateway({ baseUrl: "{{ vars.url }}" }) },
  });
  assertRefused(defaulted, absoluteUrl(field("baseUrl")));
});

test("Configuration and Preset saves refuse a user name or password in proxy, channel proxy, MCP server and proxy environment URLs", async (t) => {
  // Finding 1255: #2347 refused URL userinfo only in model baseUrl and request.proxy.url. The
  // Gateway's egress proxy, channel proxies, MCP server URLs and proxy environment variables
  // carry the same credential (a proxy sends it as Proxy-Authorization), and saved.
  const context = await saveFixture(t);
  const sentinel = `synthetic-url-userinfo-${randomUUID()}`;
  const proxy = `http://u:${sentinel}@proxy.example:3128`;
  // A Configuration to update: a refused edit leaves it as it was.
  const original = await request(context.app, "POST", context.collection, {
    body: {
      kind: "agent",
      values: { env: { vars: { HTTPS_PROXY: "http://proxy.example:3128" } } },
    },
  });
  assert.equal(original.status, 201, JSON.stringify(original.body));
  const item = `${context.collection}/${original.body.data.id}`;
  // An MCP server that runs a command passes its environment to it.
  const stdio = (env) => ({ command: "docs-mcp", env });
  for (const [field, value = proxy, values = at(field, value)] of [
    ["/proxy/proxyUrl", proxy, { proxy: { enabled: true, proxyUrl: proxy } }],
    ["/channels/telegram/proxy"],
    ["/channels/discord/proxy", `socks5://u:${sentinel}@proxy:1080`],
    ["/channels/telegram/accounts/ops/proxy"],
    ["/mcp/servers/docs/url", `https://u:${sentinel}@mcp.example.test/mcp`],
    ["/nodeHost/mcp/servers/docs/url", `https://${sentinel}@mcp.example.test`],
    ["/env/vars/HTTPS_PROXY"],
    ["/env/vars/http_proxy"],
    ["/env/ALL_PROXY"],
    ["/env/vars/all_proxy"],
    // curl and git read a proxy without a scheme as http.
    ["/env/vars/HTTPS_PROXY", `${sentinel}@proxy.example:3128`],
    // Read as http, a backslash or a double quote in the user name is still userinfo to curl.
    ["/env/vars/HTTPS_PROXY", `CORP\\ops:${sentinel}@proxy.example:3128`],
    ["/env/vars/HTTPS_PROXY", `ops"${sentinel}@proxy.example:3128`],
    // As in #2347: an environment reference in the port, or a fallback that holds userinfo.
    ["/channels/telegram/proxy", `http://u:${sentinel}@proxy.example:\${PROXY_PORT}`],
    ["/proxy/proxyUrl", `\${EGRESS_PROXY:-${proxy}}`],
    // Finding 1259: an MCP server's environment reaches its stdio process, and plugins read
    // Codex's network proxy and a speech provider's proxy.
    [
      "/mcp/servers/docs/env/HTTPS_PROXY",
      proxy,
      at("/mcp/servers/docs", stdio({ HTTPS_PROXY: proxy })),
    ],
    ["/nodeHost/mcp/servers/docs/env/all_proxy", `${sentinel}@proxy:3128`],
    ["/plugins/entries/codex/config/appServer/networkProxy/proxyUrl"],
    [
      "/plugins/entries/codex/config/appServer/networkProxy/socksUrl",
      `socks5://u:${sentinel}@proxy.example:1080`,
    ],
    ["/tts/providers/microsoft/proxy"],
    ["/channels/discord/voice/tts/providers/microsoft/proxy"],
    ["/plugins/entries/voice-call/config/tts/providers/microsoft/proxy"],
    ["/talk/realtime/providers/microsoft/proxy"],
    ["/agents/entries/main/tts/personas/calm/providers/microsoft/proxy"],
    ["/channels/discord/accounts/ops/voice/tts/providers/microsoft/proxy"],
    ["/talk/providers/microsoft/proxy"],
    [
      "/plugins/entries/acpx/config/mcpServers/docs/env/HTTPS_PROXY",
      proxy,
      at("/plugins/entries/acpx/config/mcpServers/docs", stdio({ HTTPS_PROXY: proxy })),
    ],
    ["/plugins/entries/voice-call/config/numbers/+15550100/tts/providers/edge/proxy"],
  ]) {
    await refusedOnSave(context, values, userinfo(field), { item, sentinel });
  }
  const read = await request(context.app, "GET", item);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.data.values, original.body.data.values);
  await assertNothingStored(context, [`${original.body.data.id}.json`]);
  const path = join(context.root, context.namespace.id, `${original.body.data.id}.json`);
  assert.equal((await readFile(path, "utf8")).includes(sentinel), false);

  // A Preset variable as the host, port or the whole URL is checked once filled; literal userinfo
  // beside it, or a variable as the whole user name, is refused at save.
  const variables = { host: { type: "string" }, port: { type: "string" }, url: { type: "string" } };
  for (const [field, value] of [
    ["/proxy/proxyUrl", `http://u:${sentinel}@{{ vars.host }}:3128`],
    ["/channels/discord/proxy", `http://u:${sentinel}@proxy.example:{{ vars.port }}`],
    ["/mcp/servers/docs/url", "https://{{ vars.url }}@{{ vars.host }}/mcp"],
    ["/env/vars/HTTPS_PROXY", `u:${sentinel}@{{ vars.host }}`],
    ["/env/vars/HTTPS_PROXY", `${sentinel}@{{ vars.host }}:3128`],
    // A variable in the name is matched as the text around it.
    ["/env/vars/{{ vars.host }}_PROXY", proxy],
    ["/mcp/servers/docs/env/{{ vars.host }}_PROXY", `u:${sentinel}@proxy:3128`],
  ]) {
    const response = await savePreset(context, {
      variables,
      configuration: { values: at(field, value) },
    });
    assertRefused(response, userinfo(field), { label: field, sentinel });
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
  await acceptedOnSave(context, accepted, {
    variables,
    presetValues: {
      ...accepted,
      proxy: { proxyUrl: "http://{{ vars.host }}:{{ vars.port }}" },
      channels: { telegram: { proxy: "{{ vars.url }}" } },
      env: { vars: { HTTPS_PROXY: "{{ vars.host }}:3128", ALL_PROXY: "{{ vars.url }}" } },
    },
  });

  // A document an older release stored with one still reads, so its operator can edit it.
  const stale = { proxy: { proxyUrl: proxy }, env: { vars: { HTTPS_PROXY: proxy } } };
  const current = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...current, values: stale }));
  const staleRead = await request(context.app, "GET", item);
  assert.equal(staleRead.status, 200, JSON.stringify(staleRead.body));
  assert.deepEqual(staleRead.body.data.values, stale);
  const resaved = await request(context.app, "PATCH", item, { body: { values: stale } });
  assertRefused(resaved, userinfo("/proxy/proxyUrl"));
});

test("Configuration and Preset saves refuse a user name or password in a URL in any environment map, whatever the variable's name", async (t) => {
  // Findings 1260-1262: the userinfo rule read only `env`, `env.vars` and MCP server `env`, and
  // only `*_PROXY` names. A skill, hook, local model service, exec secret provider, Docker sandbox
  // or install policy check starts its process with its own `env`, and pip, npm, git and Go send
  // the userinfo in `PIP_INDEX_URL`, `npm_config_registry` or `GOPROXY` as Basic auth.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-env-url-userinfo-${randomUUID()}`;
  const index = `https://u:${sentinel}@pypi.example.test/simple`;
  const skill = (name, variable, value) => [`/skills/entries/${name}/env/${variable}`, value];
  const registry = `\${SCHEME}://u:${sentinel}@npm.test`;
  // A process the Gateway starts runs a command, with its environment.
  const command = (path, command, env, settings = {}) => at(path, { ...settings, command, env });
  for (const [field, value = index, values = at(field, value)] of [
    ["/skills/entries/docs/env/HTTPS_PROXY"],
    ["/hooks/internal/entries/audit/env/PIP_INDEX_URL"],
    [
      "/models/providers/local/localService/env/GOPROXY",
      index,
      command("/models/providers/local/localService", "/usr/bin/serve", { GOPROXY: index }),
    ],
    [
      "/secrets/providers/vault/env/VAULT",
      index,
      command("/secrets/providers/vault", "/usr/bin/vault", { VAULT: index }, { source: "exec" }),
    ],
    ["/agents/defaults/sandbox/docker/env/npm_config_registry"],
    ["/agents/entries/main/sandbox/docker/env/HTTP_PROXY"],
    [
      "/security/installPolicy/exec/env/GIT_CONFIG_VALUE_0",
      index,
      command("/security/installPolicy/exec", "/usr/bin/scan", { GIT_CONFIG_VALUE_0: index }),
    ],
    // Any name, in the maps checked before: a URL anywhere in the value, also in a list.
    ["/env/vars/GOPROXY", `https://${sentinel}@proxy.example.test,direct`],
    ["/env/PIP_INDEX_URL"],
    ["/env/vars/PIP_EXTRA_INDEX_URL", `https://pypi.example.test ${index}`],
    [
      "/mcp/servers/docs/env/NPM_REGISTRY",
      registry,
      command("/mcp/servers/docs", "docs-mcp", { NPM_REGISTRY: registry }),
    ],
    ["/env/vars/PIP_INDEX_URL", `\${PIP_URL:-https://u:${sentinel}@pypi.example.test}`],
    // URL parsers drop a tab or newline, a reference may render empty between `:` and `//`, and
    // an http(s) URL reads userinfo with one slash or none.
    skill("tab", "PIP_INDEX_URL", `https:\t//u:${sentinel}@pypi`),
    skill("gap", "INDEX", `https:\${GAP:-}//u:${sentinel}@pypi`),
    skill("slash", "INDEX", `https:/u:${sentinel}@pypi`),
    skill("none", "INDEX", `HTTPS:u:${sentinel}@pypi`),
    // So does every other special scheme.
    ...["http", "wss", "ftp"].map((scheme) => skill(scheme, "INDEX", `${scheme}:u:${sentinel}@h`)),
    // A reference's fallback can end the URL around it and start one of its own.
    skill("fallback", "GOPROXY", `https://h\${P:-/,https://u:${sentinel}@h}`),
    // A reference in the scheme renders it: `https${X:-}:` reads as `https:`.
    skill("ref", "INDEX", `https\${X:-}:u:${sentinel}@pypi`),
    skill("list", "GOPROXY", `ok.example,\${P:-https}:u:${sentinel}@h`),
    // A space in the userinfo still reads as userinfo (WHATWG, Python), `${a/}` is no reference
    // (names are upper case), and a backslash ends a `file` authority.
    skill("space", "INDEX", `https://u:p w${sentinel}@pypi`),
    skill("lower", "INDEX", `https://ok\${a/},https:u:${sentinel}@h`),
    skill("file", "INDEX", `file://h\\https:u:${sentinel}@h`),
    // Python and curl read a backslash in a password as part of the userinfo.
    skill("bs", "INDEX", `https://u:p\\w${sentinel}@pypi`),
    ["/env/vars/HTTPS_PROXY", `http://u:p\\w${sentinel}@proxy.example:3128`],
  ]) {
    await t.test(`refuses ${field}`, async () => {
      await refusedOnSave(context, values, userinfo(field), { item, sentinel });
    });
  }

  // A Preset variable beside the userinfo, in the scheme or between `:` and `//`, is refused at
  // save; a variable that is the whole URL is checked once filled.
  const variables = {
    url: { type: "string" },
    host: { type: "string" },
    scheme: { type: "string" },
  };
  for (const [variable, value] of [
    ["PIP_INDEX_URL", "https://{{ vars.url }}@pypi.example.test"],
    ["GOPROXY", `{{ vars.scheme }}://u:${sentinel}@{{ vars.host }}`],
    ["REGISTRY", `https:{{ vars.scheme }}//u:${sentinel}@npm.test`],
    // A variable scheme may be a special one, which needs no slashes.
    ["NPM_REGISTRY", `{{ vars.scheme }}:u:${sentinel}@npm.test`],
  ]) {
    await t.test(`refuses a Preset ${variable} at save`, async () => {
      const field = `/skills/entries/x/env/${variable}`;
      const response = await savePreset(context, {
        variables,
        configuration: { values: at(field, value) },
      });
      assertRefused(response, userinfo(field), { label: field, sentinel });
    });
  }
  // A value whose URLs would take too long to check is refused rather than block the controller.
  await t.test("refuses a value too costly to check", async () => {
    // Twelve values that each fit the budget exceed it together: it is the document's.
    const env = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`X${index}`, `x://h${"${A:-x}".repeat(170)}`]),
    );
    const one = await request(context.app, "POST", context.collection, {
      body: { kind: "agent", values: { skills: { entries: { x: { env: { X0: env.X0 } } } } } },
    });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    await request(context.app, "DELETE", `${context.collection}/${one.body.data.id}`);
    const response = await request(context.app, "POST", context.collection, {
      body: { kind: "agent", values: { skills: { entries: { x: { env } } } } },
    });
    assertRefused(
      response,
      "Configuration field /skills/entries/x/env/X10, with the URLs and environment values before it, holds too many URLs or ${NAME} references to check for a user name or password. Shorten these values, or make each whole value a ${NAME} reference.",
    );
  });
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  const saved = await savePreset(
    context,
    {
      variables,
      configuration: {
        values: { skills: { entries: { x: { env: { PIP_INDEX_URL: "{{ vars.url }}" } } } } },
      },
    },
    "Whole variable",
  );
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const launch = (url) =>
    request(context.app, "POST", context.collection, {
      body: {
        kind: "agent",
        ...renderPresetTemplate(saved.body.data.template, { url, host: "", scheme: "" })
          .configuration,
      },
    });
  await t.test("refuses a whole Preset variable at launch", async () => {
    const field = "/skills/entries/x/env/PIP_INDEX_URL";
    assertRefused(await launch(index), userinfo(field), { label: field, sentinel });
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
    WINDOWS_DIRECTORY: "file:///${NOTES_DIR:-C:\\Users\\ops@example.test}\\notes.txt",
    // `$${NAME}` renders literal text.
    ESCAPED: "$${HOME}:ops@example.test",
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
  await acceptedOnSave(context, accepted, {
    variables,
    presetValues: {
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
  });
});

test("Configuration and Preset saves check a URL of many ${NAME:-fallback} references in bounded time", async (t) => {
  // Finding 1265: the userinfo rule renders a URL once per `${NAME:-fallback}` reference and reads
  // it whole each time, so a body-sized baseUrl of fallbacks held the controller for seconds.
  // Every URL field now spends the document's work budget, which refuses such a value at once.
  const context = await saveFixture(t);
  const cost = (field) =>
    `Configuration field ${field}, with the URLs and environment values before it, holds too many URLs or \${NAME} references to check for a user name or password. Shorten these values, or make each whole value a \${NAME} reference.`;
  // 60 KB of fallbacks, the most the 64 KiB request body holds, in the path and in the authority.
  const fallbacks = (prefix, suffix) =>
    `${prefix}${"${A:-x}".repeat(Math.floor((60 * 1024 - prefix.length - suffix.length) / 7))}${suffix}`;
  const urls = [fallbacks("https://h.example/", ""), fallbacks("https://", "@h.example/v1")];
  // A refusal of a body-sized value: unbounded, this took 4 to 14 s; bounded, a few milliseconds.
  const refusedAtOnce = async (path, body, field) => {
    const start = performance.now();
    const response = await request(context.app, "POST", path, { body });
    const elapsed = performance.now() - start;
    assertRefused(response, cost(field));
    assert.ok(elapsed < 500, `took ${elapsed} ms`);
  };
  const proxied = (url) => ({ baseUrl: "https://h.example/v1", request: { proxy: { url } } });
  for (const [field, values] of [
    ["/models/providers/p/baseUrl", (url) => at("/models/providers/p/baseUrl", url)],
    ["/models/providers/p/request/proxy/url", (url) => at("/models/providers/p", proxied(url))],
    ["/proxy/proxyUrl", (url) => at("/proxy/proxyUrl", url)],
    ["/channels/telegram/proxy", (url) => at("/channels/telegram/proxy", url)],
    ["/mcp/servers/docs/url", (url) => at("/mcp/servers/docs/url", url)],
  ]) {
    for (const [index, url] of urls.entries()) {
      await t.test(
        `refuses ${field} of fallbacks (${index === 0 ? "path" : "authority"})`,
        async () => {
          await refusedAtOnce(context.collection, { kind: "agent", values: values(url) }, field);
        },
      );
    }
  }
  const costlyPreset = (proxyUrl) => ({
    name: "Costly",
    template: {
      variables: { host: { type: "string" } },
      configuration: { values: { proxy: { proxyUrl } } },
    },
  });
  await t.test("refuses a Preset URL of fallbacks around a variable", async () => {
    await refusedAtOnce(
      context.presets,
      costlyPreset(`${urls[1]}{{ vars.host }}`),
      "/proxy/proxyUrl",
    );
  });
  // Each unfilled Preset variable is charged as a dozen characters in every rendering.
  await t.test("refuses a Preset URL of fallbacks and many variables", async () => {
    const url = `https://h.example/${"${A:-x}".repeat(300)}${"/{{ vars.host }}".repeat(2000)}`;
    await refusedAtOnce(context.presets, costlyPreset(url), "/proxy/proxyUrl");
  });
  // The budget is the document's: seven proxies that each fit it exceed it together.
  await t.test("refuses URL fields that fit the budget alone but not together", async () => {
    const proxy = `x://h${"${A:-x}".repeat(300)}`;
    const accounts = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`a${index}`, { proxy }]),
    );
    const one = await request(context.app, "POST", context.collection, {
      body: { kind: "agent", values: { channels: { telegram: { accounts: { a0: { proxy } } } } } },
    });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    await refusedOnSave(
      context,
      { channels: { telegram: { accounts } } },
      cost("/channels/telegram/accounts/a6/proxy"),
    );
  });
  for (const [name, value] of [
    // A scheme-less proxy is checked as written and as http, and pays for both readings.
    ["HTTPS_PROXY", "${A:-x}".repeat(415)],
    // A git config proxy spends the budget too: unbudgeted, this one took 12 s.
    ["GIT_CONFIG_PARAMETERS", `'http.proxy'='${"${A:-x}".repeat(8500)}'`],
  ]) {
    await t.test(`refuses ${name} of fallbacks`, async () => {
      const body = { kind: "agent", values: { env: { vars: { [name]: value } } } };
      await refusedAtOnce(context.collection, body, `/env/vars/${name}`);
    });
  }
  // A URL with a few fallbacks is still checked whole.
  await t.test("still refuses userinfo in a fallback and accepts a plain one", async () => {
    await refusedOnSave(
      context,
      { proxy: { proxyUrl: "http://${HOST:-u:pw@proxy}:3128" } },
      userinfo("/proxy/proxyUrl"),
    );
    const saved = await request(context.app, "POST", context.collection, {
      body: {
        kind: "agent",
        values: { proxy: { proxyUrl: "http://${HOST:-proxy}:${PORT:-3128}" } },
      },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  });
  // An escaped `$${NAME:-fallback}` is literal text, and costs no rendering.
  await t.test("accepts a URL of escaped fallbacks", async () => {
    const escaped = await request(context.app, "POST", context.collection, {
      body: {
        kind: "agent",
        values: { proxy: { proxyUrl: `http://proxy:3128/${"$${A:-x}".repeat(800)}` } },
      },
    });
    assert.equal(escaped.status, 201, JSON.stringify(escaped.body));
  });
});

test("Configuration save refuses a document too large to store before its content rules", async () => {
  // Finding 1317: the Kubernetes Driver's 1 MiB ConfigMap cap ran after OCC's content rules, so
  // the rules walked any document up to the 6.2 MiB request limit. OCC now asks the Driver
  // first, and HTTP names the limit instead of calling the document invalid, so the user knows
  // to shrink it. The real Kubernetes Driver checks the values here; the simple substrate stands
  // in for its ConfigMap storage.
  const kubernetes = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
  const backend = createConfigurationBackend();
  const configurationDriver = {
    ...backend,
    validate: (configuration) => kubernetes.validate(configuration),
    validateSize: (values) => kubernetes.validateSize(values),
    // Agent provisioning requires exact create and inspect before it reads the plan; the size
    // refusal comes first, so neither runs.
    createExact: (configuration) => backend.create(configuration),
    inspectExact: async () => undefined,
  };
  const { namespace, collection, ...context } = await fixture({
    configurationDriver,
    computeDriver: createReadyComputeDriver("compute-oversized", {
      agentProvisioning: { executionModes: ["dedicated"] },
      validateAgentProvisioning() {},
      async provisionAgentRuntimeCredentials() {
        return { transportConfigured: true };
      },
      async getAgentRuntimeCredentialStatus() {
        return { transportConfigured: false };
      },
    }),
  });
  const contentRefusal = setting(
    "models.providers.openai.models",
    "must be an array of model entries",
  );
  // A document that breaks a content rule, padded to `bytes` of JSON.
  const document = (bytes) => {
    const values = {
      models: { providers: { openai: { models: "gpt-5" } } },
      plugins: { entries: { knowledge: { config: { note: "" } } } },
    };
    values.plugins.entries.knowledge.config.note = "x".repeat(
      bytes - JSON.stringify(values).length,
    );
    return values;
  };
  const sizeRefusal =
    "Configuration values are too large: stored as JSON they must be smaller than 1 MiB. Remove or shorten settings, then save again.";
  const limit = 1_048_576;
  const under = document(limit - 1);
  const over = document(limit);
  const save = (method, path, values) =>
    request(context.app, method, path, {
      body: method === "POST" ? { kind: "agent", values } : { values },
    });

  // Just under the cap the content rule refuses it by name; at the cap the size refusal wins.
  assertRefused(await save("POST", collection, under), contentRefusal);
  assertRefused(await save("POST", collection, over), sizeRefusal);
  await assert.rejects(
    context.controller.createConfiguration(context.principal.id, {
      namespaceId: namespace.id,
      kind: "agent",
      values: over,
    }),
    { name: "ConfigurationSizeError", message: sizeRefusal },
  );
  // So is the Configuration Agent provisioning creates.
  await context.controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const harnessSecret = await context.controller.createSecret(context.principal.id, {
    namespaceId: namespace.id,
    name: "oversized-agent-key",
    value: "synthetic-configuration-key",
  });
  // Called directly: the provision route's request body limit refuses a 1 MiB document first.
  await assert.rejects(
    context.controller.provisionAgent(context.principal.id, {
      namespaceId: namespace.id,
      requestId: "oversized-agent",
      name: "Oversized",
      executionMode: "dedicated",
      configuration: { kind: "agent", values: over },
      harnessAuth: { method: "api_key", source: harnessSecret.ref },
    }),
    { name: "ConfigurationSizeError", message: sizeRefusal },
  );

  // An update is checked in the same order.
  const created = await save("POST", collection, {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${collection}/${created.body.data.id}`;
  assertRefused(await save("PATCH", item, under), contentRefusal);
  assertRefused(await save("PATCH", item, over), sizeRefusal);
  assert.deepEqual(
    configurationDriver.storedConfigurations().map(({ values }) => values),
    [{}],
  );
});

test("Configuration save checks a large agents roster in step with its size", async () => {
  // Finding 1321: a valid Configuration of 60,000 agents.entries without their own settings
  // (710 KB, under the 1 MiB cap) held the controller's event loop for 7-8 s at save, so every
  // tenant's requests waited. The Kubernetes Configuration Driver's credential rules and the
  // Kubernetes Compute model rules built each setting's name for every entry, set or not, and
  // listed the roster once per setting. They now skip a setting an entry does not hold.
  const kubernetes = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
  const compute = createTestKubernetesComputeDriver("compute-large-roster");
  // Each rule the save runs, with the arguments it ran with, so it can be timed again.
  const checks = [];
  const recorded =
    (rule) =>
    (...args) => {
      checks.push(() => rule(...args));
      return rule(...args);
    };
  const configurationDriver = {
    ...createConfigurationBackend(),
    validate: recorded((configuration) => kubernetes.validate(configuration)),
    validateSize: (values) => kubernetes.validateSize(values),
  };
  const { collection, ...context } = await fixture({
    configurationDriver,
    computeDriver: createReadyComputeDriver("compute-large-roster", {
      implementation: "integration-compute-substrate",
      ...Object.fromEntries(
        configurationRules.map((rule) => [rule, (...args) => compute[rule](...args)]),
      ),
      validateConfiguration: recorded((...args) => compute.validateConfiguration(...args)),
    }),
  });
  const codex = {
    model: "codex/gpt-5",
    models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
  };
  const created = await request(context.app, "POST", collection, {
    body: { kind: "agent", values: { agents: { defaults: codex } } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const values = {
    agents: {
      defaults: codex,
      ownership: "explicit",
      entries: Object.fromEntries(Array.from({ length: 60_000 }, (_, index) => [`a${index}`, {}])),
    },
  };
  assert.ok(JSON.stringify(values).length > 700_000);
  checks.length = 0;
  const saved = await request(context.app, "PATCH", `${collection}/${created.body.data.id}`, {
    body: { values },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 500));
  assert.equal(Object.keys(saved.body.data.values.agents.entries).length, 60_000);
  assert.equal(checks.length, 2);
  // The bound is relative to a structured clone of the same document, so a slow or busy runner
  // does not fail it. The two are timed in turn, each at its best of five. At two CPUs the
  // save's two rules take about 2.5 clones; they took about 13 before.
  const timings = { checking: Infinity, cloning: Infinity };
  for (let round = 0; round < 5; round += 1) {
    for (const [name, work] of [
      ["checking", () => checks.forEach((check) => check())],
      ["cloning", () => structuredClone(values)],
    ]) {
      const started = performance.now();
      work();
      timings[name] = Math.min(timings[name], performance.now() - started);
    }
  }
  const { checking, cloning } = timings;
  assert.ok(
    checking < 6 * cloning,
    `the rules took ${checking.toFixed(0)} ms, a clone ${cloning.toFixed(0)} ms`,
  );
  // A setting an entry does hold is still checked, and named.
  values.agents.entries.a59999 = { sandbox: { ssh: { identityData: "synthetic-literal-key" } } };
  const refused = await request(context.app, "PATCH", `${collection}/${created.body.data.id}`, {
    body: { values },
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body).slice(0, 500));
  assert.equal(
    refused.body.error.message,
    literalKey("/agents/entries/a59999/sandbox/ssh/identityData"),
  );
});

test("Configuration and Preset saves read a git config value as a proxy when its key names one", async (t) => {
  // Finding 1276: git reads `GIT_CONFIG_VALUE_<n>` as the value of the key `GIT_CONFIG_KEY_<n>`
  // names, and git and curl send a proxy's userinfo, scheme or not, as Proxy-Authorization. The
  // scheme-less proxy read keyed on the variable name only, so `u:pw@proxy:3128` saved.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-git-proxy-userinfo-${randomUUID()}`;
  const proxy = `u:${sentinel}@proxy.example.test:3128`;
  const pair = (key, index = 0) => ({
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: key,
    [`GIT_CONFIG_VALUE_${index}`]: proxy,
  });
  const parameters = (value) => ({ env: { vars: { GIT_CONFIG_PARAMETERS: value } } });
  const refused = [
    [{ env: { vars: pair("http.proxy") } }, "/env/vars/GIT_CONFIG_VALUE_0"],
    [{ env: pair("https.proxy", 2) }, "/env/GIT_CONFIG_VALUE_2"],
    // Section and variable names in any case, with a URL or remote subsection.
    [
      at("/skills/entries/docs/env", pair("HTTP.https://github.com/.Proxy", 3)),
      "/skills/entries/docs/env/GIT_CONFIG_VALUE_3",
    ],
    [
      at("/agents/defaults/sandbox/docker/env", pair("remote.origin.proxy", 1)),
      "/agents/defaults/sandbox/docker/env/GIT_CONFIG_VALUE_1",
    ],
    [
      at("/mcp/servers/docs", { command: "docs-mcp", env: pair("http.proxy") }),
      "/mcp/servers/docs/env/GIT_CONFIG_VALUE_0",
    ],
    // `env` and `env.vars` are one environment; a key's environment reference renders its
    // fallback.
    [
      { env: { GIT_CONFIG_KEY_0: "http.proxy", vars: { GIT_CONFIG_VALUE_0: proxy } } },
      "/env/vars/GIT_CONFIG_VALUE_0",
    ],
    [
      { env: { vars: { GIT_CONFIG_VALUE_0: proxy, GIT_CONFIG_KEY_0: "http.proxy" } } },
      "/env/vars/GIT_CONFIG_VALUE_0",
    ],
    [{ env: { vars: pair("${GIT_KEY:-http.proxy}") } }, "/env/vars/GIT_CONFIG_VALUE_0"],
    // A key that is a whole reference may render any key.
    [at("/skills/entries/x/env", pair("${GIT_KEY}")), "/skills/entries/x/env/GIT_CONFIG_VALUE_0"],
    // Keys pair across the maps OpenClaw merges: the Gateway's environment and every skill's, and
    // the Docker sandbox's defaults and each Agent's.
    [
      {
        env: { vars: { GIT_CONFIG_KEY_0: "http.proxy" } },
        skills: { entries: { x: { env: { GIT_CONFIG_VALUE_0: proxy } } } },
      },
      "/skills/entries/x/env/GIT_CONFIG_VALUE_0",
    ],
    [
      {
        skills: {
          entries: {
            a: { env: { GIT_CONFIG_KEY_0: "http.proxy" } },
            b: { env: { GIT_CONFIG_VALUE_0: proxy } },
          },
        },
      },
      "/skills/entries/b/env/GIT_CONFIG_VALUE_0",
    ],
    [
      {
        agents: {
          defaults: { sandbox: { docker: { env: { GIT_CONFIG_KEY_0: "http.proxy" } } } },
          entries: { main: { sandbox: { docker: { env: { GIT_CONFIG_VALUE_0: proxy } } } } },
        },
      },
      "/agents/entries/main/sandbox/docker/env/GIT_CONFIG_VALUE_0",
    ],
    [
      {
        agents: {
          defaults: { sandbox: { docker: { env: { GIT_CONFIG_VALUE_0: proxy } } } },
          entries: { main: { sandbox: { docker: { env: { GIT_CONFIG_KEY_0: "http.proxy" } } } } },
        },
      },
      "/agents/defaults/sandbox/docker/env/GIT_CONFIG_VALUE_0",
    ],
    // OpenClaw trims a variable's name.
    [
      { env: { vars: { GIT_CONFIG_KEY_0: "http.proxy", "GIT_CONFIG_VALUE_0 ": proxy } } },
      "/env/vars/GIT_CONFIG_VALUE_0 ",
    ],
    [{ env: { vars: { " HTTPS_PROXY": proxy } } }, "/env/vars/ HTTPS_PROXY"],
    // `git -c` pairs in GIT_CONFIG_PARAMETERS, in the current and the older quoting.
    ...[
      `'user.name'='ops' 'http.proxy'='${proxy}'`,
      `'remote.origin.proxy=${proxy}'`,
      // A value is split at the first `=` (a password may end in one), `'\''` quotes a `'`, a key
      // may be a reference, and a proxy without a scheme or a password still names a user.
      `'remote.origin.proxy=u:${sentinel}=@proxy.example.test:3128'`,
      `'user.name'='o'\\''brien' 'http.proxy'='u:it'\\''s${sentinel}@proxy.example.test:3128'`,
      `'\${GIT_PROXY_KEY}'='${proxy}'`,
      `'http.proxy'='${sentinel}@proxy.example.test:3128'`,
    ].map((value) => [parameters(value), "/env/vars/GIT_CONFIG_PARAMETERS"]),
  ];
  for (const [values, field] of refused) {
    await t.test(`refuses ${field}`, async () => {
      await refusedOnSave(context, values, userinfo(field), { item, sentinel });
    });
  }
  // On a Preset save, a key that waits on a variable is matched as the text around it, and a
  // name whose index waits on one pairs with every index.
  const variables = { url: { type: "string" }, n: { type: "string" } };
  for (const [key, variable] of [
    [{ GIT_CONFIG_KEY_0: "{{ vars.url }}" }, "GIT_CONFIG_VALUE_0"],
    [{ GIT_CONFIG_KEY_0: "{{ vars.url }}.proxy" }, "GIT_CONFIG_VALUE_0"],
    [{ GIT_CONFIG_KEY_0: "http.{{ vars.url }}" }, "GIT_CONFIG_VALUE_0"],
    [{ GIT_CONFIG_KEY_0: "http.proxy" }, "GIT_CONFIG_VALUE{{ vars.n }}"],
    [{ GIT_CONFIG_KEY_0: "http.proxy" }, "GIT_CONFIG_{{ vars.n }}_0"],
    [{ GIT_CONFIG_KEY_0: "http.{{ vars.url }}.proxy" }, "GIT_CONFIG_VALUE_0"],
    [{ GIT_CONFIG_KEY_0: "http.https://{{ vars.url }}/.proxy" }, "GIT_CONFIG_VALUE_0"],
    [{ GIT_CONFIG_KEY_0: "http.proxy" }, "GIT_CONFIG_VALUE_{{ vars.n }}"],
    [{ "GIT_CONFIG_KEY_{{ vars.n }}": "http.proxy" }, "GIT_CONFIG_VALUE_4"],
  ]) {
    await t.test(`refuses a Preset ${variable} at save`, async () => {
      const field = `/skills/entries/x/env/${variable}`;
      const env = { ...key, [variable]: proxy };
      const response = await savePreset(context, {
        variables,
        configuration: { values: { skills: { entries: { x: { env } } } } },
      });
      assertRefused(response, userinfo(field), { label: field, sentinel });
    });
  }
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // Ordinary git config pairs still save: other keys with an `@` in their value (`core.gitProxy`
  // names a command), a proxy without a user name, or one that is a whole reference, and a proxy
  // key in another process's map.
  const env = {
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "user.email",
    GIT_CONFIG_VALUE_0: "ops@example.test",
    GIT_CONFIG_KEY_1: "http.proxy",
    GIT_CONFIG_VALUE_1: "proxy.example.test:3128",
    GIT_CONFIG_KEY_2: "https.proxy",
    GIT_CONFIG_VALUE_2: "${GIT_PROXY}",
    GIT_CONFIG_KEY_3: "url.git@github.com:.insteadOf",
    GIT_CONFIG_VALUE_3: "gh:",
    GIT_CONFIG_KEY_4: "http.proxyAuthMethod",
    GIT_CONFIG_VALUE_4: "basic",
    GIT_CONFIG_KEY_5: "core.gitProxy",
    GIT_CONFIG_VALUE_5: "ssh ops@jump.example.test nc %h %p",
    GIT_CONFIG_PARAMETERS: "'user.email'='ops@example.test' 'http.proxy'='proxy.example.test:3128'",
  };
  const sandboxEnv = (GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0) => ({
    sandbox: { docker: { env: { GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 } } },
  });
  const accepted = {
    env: { vars: env },
    skills: { entries: { docs: { env } } },
    hooks: {
      internal: {
        entries: {
          mail: {
            env: { GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "ops@example.test" },
          },
          // `$${NAME}` renders literal text, which names no proxy section.
          jump: {
            env: {
              GIT_CONFIG_KEY_0: "$${GIT_SECTION}.proxy",
              GIT_CONFIG_VALUE_0: "ops@jump.example.test",
            },
          },
        },
      },
    },
    mcp: { servers: { docs: { command: "docs-mcp", env } } },
    // Each Agent's sandbox runs with the defaults' environment and its own, not another Agent's.
    agents: {
      ownership: "explicit",
      entries: {
        a: sandboxEnv("http.proxy", "http://proxy:3128"),
        b: sandboxEnv("url.https://github.com/.insteadOf", "git@github.com:"),
      },
    },
  };
  await acceptedOnSave(context, accepted, {
    variables,
    presetValues: {
      ...accepted,
      skills: { entries: { docs: { env: { ...env, GIT_CONFIG_KEY_0: "user.{{ vars.n }}" } } } },
    },
  });
});

test("Configuration and Preset saves refuse a literal credential in an MCP server header", async (t) => {
  // Finding 1278: OpenClaw marks MCP server headers sensitive, and a model provider's credential
  // headers already had to hold references, but an MCP server saved a literal `Authorization`.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-mcp-header-${randomUUID()}`;
  const server = (headers) => ({ url: "https://mcp.example.test/mcp", headers });
  for (const [root, header, value] of [
    ["/mcp/servers/docs", "Authorization", `Bearer ${sentinel}`],
    ["/nodeHost/mcp/servers/docs", "X-Api-Key", sentinel],
    // `Bearer ${NAME}` holds a reference only in an Authorization header; a number is a literal.
    ["/mcp/servers/docs", "X-Auth-Token", "Bearer ${MCP_TOKEN}"],
    ["/mcp/servers/docs", "x-client-secret", 12345],
    ["/mcp/servers/docs", "Authorization", `Bearer ${sentinel}\${SUFFIX}`],
  ]) {
    const field = `${root}/headers/${header}`;
    await t.test(`refuses ${field}`, async () => {
      const values = at(root, server({ [header]: value }));
      await refusedOnSave(context, values, literalHeader(field), { item, sentinel });
    });
  }
  // A Preset header name that waits on a variable is matched as the text around it.
  await t.test("refuses a Preset header name around a variable at save", async () => {
    const response = await savePreset(context, {
      variables: { suffix: { type: "string" } },
      configuration: {
        values: {
          mcp: { servers: { docs: server({ "Authorization{{ vars.suffix }}": sentinel }) } },
        },
      },
    });
    const field = "/mcp/servers/docs/headers/Authorization{{ vars.suffix }}";
    assertRefused(response, literalHeader(field), { label: field, sentinel });
  });
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // Credential headers that hold references, and headers that name no credential, still save.
  const headers = {
    Authorization: "Bearer ${MCP_TOKEN}",
    "Authorization-V2": "Bearer ${MCP_TOKEN_V2}",
    "X-Api-Key": "${MCP_API_KEY}",
    "Proxy-Authorization": "${MCP_PROXY_AUTH}",
    Accept: "application/json",
    "X-Request-Source": "openclaw",
    "Idempotency-Key": "fixed",
    "X-Retry-Count": 3,
  };
  await acceptedOnSave(context, {
    mcp: { servers: { docs: server(headers) } },
    nodeHost: { mcp: { servers: { docs: server(headers) } } },
  });
});

test("Configuration and Preset saves refuse a literal key in the other key and header slots the Gateway sends", async (t) => {
  // Finding 1307: memory search, media understanding, speech and Talk providers, web fetch,
  // OpenTelemetry export, skills and the cron webhook carry keys the Gateway sends, most marked
  // sensitive by OpenClaw, but a literal value saved in each and reached the ConfigMap.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-gateway-key-${randomUUID()}`;
  const option = (field) => `${inline(field)} Make the option value a \${NAME} reference.`;
  const invalidHeaderNames = (field, name) =>
    `Configuration field ${field} must use valid HTTP header names, not ${JSON.stringify(name)}.`;
  // A literal at `field`, and the refusal that names it.
  const slot = (field, message = literalKey, value = sentinel) => [
    at(field, value),
    message(field),
  ];
  const refused = [
    slot("/memory/search/remote/apiKey"),
    slot("/agents/entries/main/memory/search/remote/headers/Authorization", literalHeader),
    slot("/memory/search/remote/baseUrl", userinfo, `https://u:${sentinel}@emb.example.test`),
    [
      {
        tools: { media: { models: [{ provider: "openai", headers: { "X-Api-Key": sentinel } }] } },
      },
      literalHeader("/tools/media/models/0/headers/X-Api-Key"),
    ],
    [
      at("/tools/media/audio/request/auth", { mode: "authorization-bearer", token: sentinel }),
      literalKey("/tools/media/audio/request/auth/token"),
    ],
    slot(
      "/tools/media/image/models/0/request/headers/Authorization",
      literalHeader,
      `Bearer ${sentinel}`,
    ),
    slot("/tts/providers/openai/apiKey"),
    slot("/tts/personas/narrator/providers/elevenlabs/apiKey"),
    slot("/agents/entries/main/tts/providers/openai/apiKey"),
    slot("/talk/providers/openai/apiKey"),
    slot("/talk/realtime/providers/openai/apiKey", literalKey, 12345),
    slot("/tools/web/fetch/headers/Authorization", literalHeader, `Bearer ${sentinel}`),
    slot("/diagnostics/otel/headers/x-api-key", literalHeader),
    slot("/skills/entries/weather/apiKey"),
    slot("/cron/webhookToken"),
    // Media query options carry a provider's key; a camelCase name is matched by its words.
    slot("/tools/media/models/0/providerOptions/google/key", option),
    slot("/tools/media/audio/providerOptions/deepgram/accessToken", option),
    // A name that only starts like a token count still names a key.
    slot("/tools/media/models/0/providerOptions/google/max_tokens_key", option),
    slot("/tools/media/video/headers/Authorization", literalHeader),
    slot("/gateway/remote/edgeAuth/CF-Access-Client-Secret", literalHeader),
    // A header name no HTTP client sends would hide a literal from the credential rule.
    [
      at("/memory/search/remote/headers/Authorization ", `Bearer ${sentinel}`),
      invalidHeaderNames("/memory/search/remote/headers", "Authorization…"),
    ],
    [
      at("/mcp/servers/docs", {
        url: "https://mcp.example.test",
        headers: { "X-Api-Key\t": sentinel },
      }),
      invalidHeaderNames("/mcp/servers/docs/headers", "X-Api-Key…"),
    ],
  ];
  for (const [values, message] of refused) {
    await t.test(`refuses ${message.split(" ")[2]}`, async () => {
      await refusedOnSave(context, values, message, { item, sentinel });
    });
  }
  // A Preset option name is matched as the text around its variable, as a header name is.
  await t.test("refuses a Preset option name around a variable at save", async () => {
    const field = "/tools/media/models/0/providerOptions/google/api_key{{ vars.suffix }}";
    const response = await savePreset(context, {
      variables: { suffix: { type: "string" } },
      configuration: { values: at(field, sentinel) },
    });
    assertRefused(response, option(field), { label: field, sentinel });
  });
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // `${NAME}` and SecretRef references, and headers that name no credential, still save.
  const secretRef = (id) => ({ source: "env", provider: "default", id });
  const headers = {
    Authorization: "Bearer ${EMBED_TOKEN}",
    "X-Api-Key": "${EMBED_KEY}",
    Accept: "application/json",
  };
  await acceptedOnSave(context, {
    memory: {
      search: {
        remote: { baseUrl: "https://emb.example.test/v1", apiKey: "${EMBED_KEY}", headers },
      },
    },
    agents: {
      entries: {
        main: {
          memory: { search: { remote: { apiKey: secretRef("EMBED_KEY") } } },
          tts: { providers: { openai: { apiKey: "${TTS_KEY}" } } },
        },
      },
    },
    tools: {
      media: {
        models: [{ provider: "openai", model: "gpt-5", headers }],
        audio: {
          request: { auth: { mode: "authorization-bearer", token: "${MEDIA_TOKEN}" } },
          providerOptions: {
            deepgram: { model: "nova-3", smart_format: true, key: "${DG_KEY}" },
            openai: { max_tokens: 4096, maxOutputTokens: 512 },
            // A count in each word the rule lists, singular or plural, names no credential.
            vllm: {
              min_tokens: 1,
              num_tokens: 2,
              total_tokens: 3,
              context_tokens: 4,
              input_tokens: 5,
              max_completion_tokens: 6,
              max_token: 7,
            },
          },
        },
        image: { models: [{ request: { headers } }] },
      },
      web: { fetch: { headers: { Authorization: "Bearer ${FETCH_TOKEN}", "User-Agent": "oce" } } },
    },
    tts: {
      providers: { openai: { apiKey: secretRef("TTS_KEY"), voice: "alloy" } },
      personas: { narrator: { providers: { elevenlabs: { apiKey: "${ELEVENLABS_API_KEY}" } } } },
    },
    talk: {
      providers: { openai: { apiKey: "${TALK_KEY}" } },
      realtime: { providers: { openai: { apiKey: secretRef("TALK_KEY") } } },
    },
    diagnostics: { otel: { headers: { "x-api-key": "${OTEL_KEY}", "x-tenant": "oce" } } },
    skills: { entries: { weather: { apiKey: secretRef("WEATHER_KEY") } } },
    cron: { webhookToken: "${CRON_WEBHOOK_TOKEN}" },
    gateway: {
      remote: {
        edgeAuth: {
          "CF-Access-Client-Id": "oce.access",
          "CF-Access-Client-Secret": "${CF_SECRET}",
        },
      },
    },
  });
});

test("Configuration and Preset saves refuse a literal secret in the other slots OpenClaw marks sensitive", async (t) => {
  // Finding 1309: Gateway and hooks tokens, sandbox SSH keys, storage passphrases, and the secret
  // settings of channels and plugins (`webSearch.apiKey`) saved as literals and reached the
  // ConfigMap that Namespace members read. Channel and plugin keys are matched as OpenClaw
  // matches plugin-owned fields, plus the fields bundled manifests mark sensitive.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const sentinel = `synthetic-sensitive-slot-${randomUUID()}`;
  const slot = (field, message = literalKey, value = sentinel) => [
    at(field, value),
    message(field),
  ];
  const tokenUrl = `https://chat.example.test/?token=${sentinel}`;
  const refused = [
    // Slots the pinned OpenClaw schema registers sensitive.
    slot("/gateway/auth/token"),
    // The Gateway password keeps its own message, which names the reference Compute fills.
    [at("/gateway/auth/password", sentinel), gatewayPassword],
    slot("/gateway/remote/token"),
    slot("/gateway/remote/password"),
    slot("/gateway/controlUi/github/token"),
    slot("/hooks/token"),
    slot("/hooks/gmail/pushToken"),
    slot("/agents/defaults/sandbox/ssh/identityData"),
    slot("/agents/entries/main/sandbox/ssh/certificateData"),
    slot("/agents/defaults/sandbox/ssh/knownHostsData"),
    slot("/storage/locations/backup/encryption/passphrase"),
    // Channel settings: a token, an account's password and an inline service account.
    slot("/channels/telegram/botToken"),
    slot("/channels/matrix/accounts/work/password"),
    slot("/channels/googlechat/serviceAccount", literalKey, { private_key: sentinel }),
    // A field only the channel's manifest marks sensitive: a URL that carries a token.
    slot("/channels/synology-chat/incomingUrl", literalKey, tokenUrl),
    slot("/channels/synology-chat/accounts/ops/webhookUrl", literalKey, tokenUrl),
    slot("/channels/synology-chat/webhookUrl", literalKey, tokenUrl),
    slot("/channels/synology-chat/accounts/ops/incomingUrl", literalKey, tokenUrl),
    // Each word of the rule: a secret, an encryption key, a service account reference.
    slot("/channels/line/channelSecret"),
    slot("/channels/feishu/encryptKey"),
    slot("/channels/googlechat/serviceAccountRef"),
    // Two literals in one channel: the first in the document is named.
    [
      { channels: { telegram: { botToken: sentinel, webhookSecret: sentinel } } },
      literalKey("/channels/telegram/botToken"),
    ],
    // Plugin settings: a key, an account's password, a list entry, a field only the manifest
    // marks sensitive and a headers map.
    slot("/plugins/entries/brave/config/webSearch/apiKey"),
    slot("/plugins/entries/imap/config/accounts/work/password"),
    [
      at("/plugins/entries/memory-lancedb/config/embedding/apiKeys", ["${EMBED_KEY}", sentinel]),
      literalKey("/plugins/entries/memory-lancedb/config/embedding/apiKeys/1"),
    ],
    slot("/plugins/entries/voice-call/config/telnyx/publicKey"),
    slot(
      "/plugins/entries/codex/config/appServer/headers/Authorization",
      literalHeader,
      `Bearer ${sentinel}`,
    ),
    // A snake_case API key, a private key, and a token whose name starts with "file".
    slot("/plugins/entries/tavily/config/api_key"),
    slot("/plugins/entries/github/config/app/privateKey"),
    slot("/plugins/entries/dropbox/config/fileAccessToken"),
    // A Gateway password that is not a whole `${NAME}` reference or an env reference with an id.
    ...[
      `\${OPENCLAW_GATEWAY_PASSWORD}${sentinel}`,
      "${9GATEWAY_PASSWORD}",
      { source: "env", value: sentinel },
    ].map((password) => [at("/gateway/auth/password", password), gatewayPassword]),
  ];
  for (const [index, [values, message]] of refused.entries()) {
    await t.test(`refuses ${index}: ${message.split(" ")[2]}`, async () => {
      await refusedOnSave(context, values, message, { item, sentinel });
    });
  }
  // A Preset variable that fills a whole secret renders as its own text, a literal: the Preset
  // must name a reference instead (a SecretRef whose `id` waits on a variable).
  const variable = await savePreset(context, {
    variables: { token: { type: "string" } },
    configuration: { values: { channels: { telegram: { botToken: "{{ vars.token }}" } } } },
  });
  assertRefused(variable, literalKey("/channels/telegram/botToken"));
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // `${NAME}` and SecretRef references still save, and so do settings the rule leaves alone:
  // where a credential is read from (`secretFile`), a channel map key that reads like one, a
  // boolean, a hook mapping's routing key, an unencrypted storage location, and an environment
  // map, which keeps the rules every environment map has.
  const secretRef = (id) => ({ source: "env", provider: "default", id });
  await acceptedOnSave(context, {
    gateway: {
      auth: { mode: "password", password: "${OPENCLAW_GATEWAY_PASSWORD}" },
      remote: { token: secretRef("REMOTE_GATEWAY_TOKEN") },
      controlUi: { github: { token: "${CONTROL_UI_GITHUB_TOKEN}" } },
    },
    hooks: {
      token: "${HOOKS_TOKEN}",
      gmail: { pushToken: "${GMAIL_PUSH_TOKEN}" },
      mappings: [{ match: { path: "gmail" }, sessionKey: "hook:gmail:{{messages[0].id}}" }],
    },
    agents: {
      defaults: { sandbox: { ssh: { identityData: secretRef("SANDBOX_SSH_KEY") } } },
    },
    storage: {
      locations: {
        backup: { encryption: { passphrase: "${BACKUP_PASSPHRASE}" } },
        scratch: { encryption: "none" },
      },
    },
    channels: {
      telegram: {
        enabled: false,
        botToken: "${TELEGRAM_BOT_TOKEN}",
        accounts: { work: { botToken: secretRef("TELEGRAM_WORK_BOT_TOKEN") } },
      },
      line: { enabled: false, secretFile: "/run/secrets/line-channel-secret" },
      googlechat: {
        enabled: false,
        serviceAccount: secretRef("GOOGLECHAT_SERVICE_ACCOUNT"),
        serviceAccountEmail: "chat-bot@example.iam.gserviceaccount.com",
      },
      slack: { enabled: false, channels: { "secret-launch": { requireMention: true } } },
    },
    plugins: {
      entries: {
        brave: { config: { webSearch: { apiKey: "${BRAVE_API_KEY}" } } },
        firecrawl: { config: { webFetch: { apiKey: secretRef("FIRECRAWL_API_KEY") } } },
        "voice-call": { config: { telnyx: { publicKey: "${TELNYX_PUBLIC_KEY}" } } },
        "visitor-access": { config: { requireToken: true } },
        // Where a secret is read from, and a name that only starts with "token".
        "secret-reader": {
          config: {
            secretPath: "/run/secrets/reader",
            secretsDir: "/run/secrets",
            apiKeyEnv: "READER_API_KEY",
            tokenizer: "o200k_base",
          },
        },
        acpx: {
          config: {
            mcpServers: { docs: { command: "docs-mcp", env: { DOCS_API_TOKEN: "env-value" } } },
          },
        },
      },
    },
  });
});

test("Preset and Configuration saves refuse a baseUrl or api that a variable fills with no host or no string", async (t) => {
  // Finding 1256: `https://{{ vars.h }}/v1` filled empty renders `https:///v1`, whose first path
  // segment the URL parser reads as the host. Finding 1257: a number or boolean variable that is
  // the whole baseUrl or api saved, and failed every launch.
  const context = await saveFixture(t);
  const created = await request(context.app, "POST", context.collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = `${context.collection}/${created.body.data.id}`;
  const gateway = (settings) => ({ models: { providers: { gateway: settings } } });
  const baseUrl = (field = "baseUrl") => absoluteUrl(`/models/providers/gateway/${field}`);
  // Finding 1285: a scheme followed by one or no slash names the missing `//`.
  const slashes = (field = "baseUrl") =>
    `Configuration field /models/providers/gateway/${field} must start with https:// or http:// (the // after the scheme is missing).`;
  const api = modelApi("/models/providers/gateway/api");
  // Finding 1346: a numeric or 0x last label makes the URL parser read the host as IPv4.
  const numericHost = (field = "baseUrl") =>
    `${baseUrl(field)} A numeric or 0x last label parses as IPv4; use four decimal octets from 0 to 255 without leading zeros.`;

  // An empty written authority, however it is spelled, is refused on every save, and so is one
  // or no slash after the scheme (finding 1259), which the URL parser accepts. Only the latter
  // says the `//` is missing (finding 1285).
  for (const [settings, message] of [
    [{ baseUrl: "https:///v1" }, baseUrl()],
    [{ baseUrl: " HTTP:\\\\\\v1" }, baseUrl()],
    [{ baseUrl: "https:/\t//v1" }, baseUrl()],
    [
      { models: [{ id: "m", baseUrl: "http:////models.example.test/v1" }] },
      baseUrl("models/0/baseUrl"),
    ],
    [{ baseUrl: "https:/models.example.test/v1" }, slashes()],
    [{ baseUrl: "https:v1" }, slashes()],
    [{ baseUrl: "http:/models.example.test" }, slashes()],
    [{ baseUrl: " \tHTTPS:/models.example.test" }, slashes()],
    [{ baseUrl: "https:\\models.example.test" }, slashes()],
    [{ baseUrl: "https:${MODEL_HOST}/v1" }, slashes()],
    [{ models: [{ id: "m", baseUrl: "http:/${MODEL_HOST}" }] }, slashes("models/0/baseUrl")],
    // The runtime renders a fallback when its variable is unset. The value does not start with
    // the scheme, so the general message stays.
    [{ baseUrl: "${MODEL_URL:-https:/models.example.test/v1}" }, baseUrl()],
    [{ baseUrl: "https://${MODEL_HOST:-}/v1" }, baseUrl()],
    // A value that is not a string is refused for its type.
    [{ baseUrl: ["https:/v1"] }, baseUrl()],
    // As the URL parser reads them: tabs dropped, leading spaces trimmed, any scheme case.
    [{ baseUrl: "https://\t/v1" }, baseUrl()],
    [{ baseUrl: "https://\t/${MODEL_HOST}/v1" }, baseUrl()],
    [{ baseUrl: " HTTPS:${MODEL_HOST}/v1" }, slashes()],
    // Each rendering counts: every reference set, every fallback, and the first fallback alone.
    [{ baseUrl: "https:${MODEL_SLASHES:-//}models.example.test/v1" }, slashes()],
    [{ baseUrl: "${MODEL_SCHEME:-https://}${MODEL_SLASH:-/}models.example.test/v1" }, baseUrl()],
    [{ baseUrl: "${MODEL_SCHEME:-https:/}${MODEL_PATH:-/models.example.test}/v1" }, baseUrl()],
    // A host the URL parser reads as IPv4 and refuses names the last label (finding 1346).
    [{ baseUrl: "https://api.123/v1" }, numericHost()],
    [{ baseUrl: "https://api.0x10/v1" }, numericHost()],
    [{ baseUrl: "HTTPS://999.1.2.3:8443" }, numericHost()],
    [{ models: [{ id: "m", baseUrl: "https://1.2.3.4.5/v1" }] }, numericHost("models/0/baseUrl")],
    [{ baseUrl: "https://0.0.0.08./v1" }, numericHost()],
    // The hint finds the host as the URL parser does: any case of 0x and a bare 0x, edge spaces
    // and C0 controls trimmed, backslashes as slashes, and userinfo skipped.
    [{ baseUrl: "https://api.0X10/v1" }, numericHost()],
    [{ baseUrl: "https://api.0x/v1" }, numericHost()],
    [{ baseUrl: " \u0001https://api.123/v1" }, numericHost()],
    [{ baseUrl: "https://api.123 \u0001" }, numericHost()],
    [{ baseUrl: "https:\\\\api.123/v1" }, numericHost()],
    [
      {
        baseUrl: syntheticCredentialUrl({
          username: "user",
          password: "secret",
          host: "api.123",
          pathname: "/v1",
        }),
      },
      numericHost(),
    ],
    // A URL that fails for another reason too keeps the general message, and so does a last
    // label that only starts or ends with digits.
    [{ baseUrl: "https://api.123:99999/v1" }, baseUrl()],
    [{ baseUrl: "https://api.a<1/v1" }, baseUrl()],
    [{ baseUrl: "https://api.1<a/v1" }, baseUrl()],
    // The hint replaces only the last label before re-checking, so a bad earlier label keeps the
    // general message.
    [{ baseUrl: "https://api.a<b.123/v1" }, baseUrl()],
  ]) {
    await refusedOnSave(context, gateway(settings), message, { item });
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
    [{ h: { type: "string" } }, { baseUrl: "https:{{ vars.h }}" }, slashes()],
    [{ h: { type: "string" } }, { baseUrl: "HTTPS:/{{ vars.h }}/v1" }, slashes()],
    [{ n: { type: "number" } }, { baseUrl: "{{ vars.n }}" }, baseUrl()],
    [{ b: { type: "boolean" } }, { baseUrl: "{{ vars.b }}" }, baseUrl()],
    [{ p: { type: "string" } }, { baseUrl: "https://api.123/{{ vars.p }}" }, numericHost()],
    // The last label can follow the variable: the hint reads the text around it, filled.
    [{ h: { type: "string" } }, { baseUrl: "https://{{ vars.h }}.1.2.3.4/v1" }, numericHost()],
    [
      {},
      { models: [{ id: "m", baseUrl: "https://api.0x10/v1" }] },
      numericHost("models/0/baseUrl"),
    ],
    [{ n: { type: "number" } }, { api: "{{ vars.n }}" }, api],
    [
      { b: { type: "boolean" } },
      { models: [{ id: "m", baseUrl: "{{ vars.b }}" }] },
      baseUrl("models/0/baseUrl"),
    ],
  ]) {
    assertRefused(await savePreset(context, template(variables, settings)), message);
  }
  await assertNothingStored(context, [`${created.body.data.id}.json`]);

  // A host variable without a default saves; filled empty at launch, its Configuration is refused.
  const variables = { h: { type: "string" }, n: { type: "number" }, u: { type: "string" } };
  const values = {
    ...hostVariable,
    models: [{ id: "m", baseUrl: "{{ vars.u }}", contextWindow: "{{ vars.n }}" }],
  };
  const saved = await savePreset(context, template(variables, values), "Filled at launch");
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const launch = (inputs) =>
    request(context.app, "POST", context.collection, {
      body: {
        kind: "agent",
        ...renderPresetTemplate(saved.body.data.template, inputs).configuration,
      },
    });
  assertRefused(await launch({ h: "", n: 1000, u: "https://models.example.test/v1" }), baseUrl());
  const oneSlash = await launch({ h: "models.example.test", n: 1000, u: "https:/v1" });
  assertRefused(oneSlash, slashes("models/0/baseUrl"));

  // Two slashes or backslashes after any spelling of the scheme, and references beside them, save.
  for (const value of [
    " HTTPS://models.example.test/v1",
    "https:\\\\models.example.test/v1",
    "http://localhost:${MODEL_PORT}/v1",
    "https://${MODEL_HOST}/v1",
    "https:\\\\${MODEL_HOST}/v1",
    "${MODEL_BASE_URL}/v1",
    "${MODEL_URL:-https://models.example.test}/v1",
  ]) {
    const response = await request(context.app, "POST", context.collection, {
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
  const requestAuth = setting(
    "models.providers.openai.request.auth",
    `must be unset or {mode: "provider-default"}: ${binding}`,
  );
  const credentialHeader = setting(
    "models.providers.openai.request.headers",
    `must not set the credential header "x-goog-api-key" (its name marks a credential): ${binding}`,
  );

  // The openai provider's request transport settings, as an older release stored them.
  for (const [label, transport, message] of [
    [
      "request.auth authorization-bearer",
      { auth: { mode: "authorization-bearer", token: sentinel } },
      requestAuth,
    ],
    [
      "request.auth header",
      { auth: { mode: "header", headerName: "x-key", value: sentinel } },
      requestAuth,
    ],
    ["request.headers", { headers: { "x-goog-api-key": sentinel } }, credentialHeader],
  ]) {
    const stale = { ...valid, ...at("/models/providers/openai/request", transport) };
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
    assertRefused(resaved, message, { label, sentinel });
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assertRefused(deployed, message, { label, sentinel });
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

test("A stored Configuration with a literal Gateway password an older release accepted reads and does not deploy", async (t) => {
  // Deployment does not run the save rules (validateConfigurationSettings); the Configuration
  // Driver's credential rules refuse the literal there, with the save message, before any
  // revision exists. Without that check, Kubernetes Compute answers with a gateway.auth.mode
  // conflict and other Compute Drivers get further still.
  for (const [label, computeDriver] of [
    [
      "Kubernetes Compute",
      kubernetesRules("compute-stored-gateway-password", ...configurationRules),
    ],
    ["ready Compute", createReadyComputeDriver("compute-stored-gateway-password-ready")],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "occ-stored-gateway-password-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configurationDriver = new FilesystemConfigurationDriver(root);
    const { namespace, ...context } = await fixture({ configurationDriver, computeDriver });
    const { configurationId, item, agentPath } = await deployableAgent(context, namespace, {
      values: runtimeSelected,
      name: "Stored Gateway password consumer",
      secretName: "stored-gateway-password-key",
    });
    const path = join(root, namespace.id, `${configurationId}.json`);
    const sentinel = `synthetic-gateway-password-${randomUUID()}`;
    const stale = {
      ...runtimeSelected,
      gateway: { auth: { mode: "password", password: sentinel } },
    };
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...current, values: stale }));

    const read = await request(context.app, "GET", item);
    assert.equal(read.status, 200, `${label}: ${JSON.stringify(read.body)}`);
    assert.deepEqual(read.body.data.values, stale, label);
    // Saving it unchanged and deploying it are refused with the same message.
    const resaved = await request(context.app, "PATCH", item, { body: { values: stale } });
    assertRefused(resaved, gatewayPassword, { label, sentinel });
    const deployed = await request(context.app, "POST", `${agentPath}/deploy`);
    assertRefused(deployed, gatewayPassword, { label, sentinel });
    const revisions = await request(context.app, "GET", `${agentPath}/revisions`);
    assert.deepEqual(revisions.body.data, [], label);
  }
});
