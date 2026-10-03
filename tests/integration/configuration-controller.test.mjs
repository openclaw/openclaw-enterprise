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
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";

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
  // A long unknown field name still fits the 256-character error message contract.
  const longField = await request(context.app, "PATCH", `${collection}/${created.body.data.id}`, {
    body: { values: {}, ["x".repeat(400)]: true },
  });
  assert.equal(longField.status, 400, JSON.stringify(longField.body));
  assert.ok(longField.body.error.message.length <= 256, longField.body.error.message);
  assert.match(longField.body.error.message, /: body \/x+…$/);

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
    const computeDriver = {
      id: "compute-configuration-integration",
      capability: "compute",
      implementation: "integration-compute-substrate",
      validateHarnessAuth() {},
      ...(runtimeLogging === undefined ? {} : { runtimeLogging }),
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
    const harnessSecret = await context.controller.createSecret(context.principal.id, {
      namespaceId: namespace.id,
      name: "configuration-model-key",
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
    context.bindings.push({
      id: "model-consumer",
      subjectKind: "identity",
      subjectId: admittedAgent.servicePrincipalId,
      roleId: "model-consumer",
      namespaceId: namespace.id,
      resourceKind: "secret",
      resourceId: harnessSecret.id,
    });
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
  const computeDriver = {
    id: "compute-configuration-integration",
    capability: "compute",
    implementation: "integration-compute-substrate",
    validateHarnessAuth() {},
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
  const harnessSecret = await context.controller.createSecret(context.principal.id, {
    namespaceId: namespace.id,
    name: "runtime-less-model-key",
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
  context.bindings.push({
    id: "model-consumer",
    subjectKind: "identity",
    subjectId: admittedAgent.servicePrincipalId,
    roleId: "model-consumer",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: harnessSecret.id,
  });

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
