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
  if (body !== undefined) headers["content-type"] = "application/json";
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
  }

  const unchanged = await request(context.app, "GET", `${collection}/${created.body.data.id}`);
  assert.deepEqual(unchanged.body.data, created.body.data);
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
        if (event.action === action)
          throw new Error("The durable configuration mutation audit is unavailable.");
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
  assert.equal(await readFile(path, "utf8"), original);
  const unchanged = await request(context.app, "GET", `${collection}/${id}`);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.body.data, created.body.data);

  // Direct Driver callers and externally modified storage retain the same boundary.
  const persisted = JSON.parse(original);
  await assert.rejects(
    configurationDriver.create({ ...persisted, values: unsafe }),
    /Model credentials must use unresolved references/,
  );
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, JSON.stringify({ ...persisted, values: unsafe }));
  const unreadable = await request(context.app, "GET", `${collection}/${id}`);
  assert.equal(unreadable.status, 503);
  assert.equal(JSON.stringify(unreadable.body).includes(sentinel), false);
  assert.equal(JSON.stringify(context.auditSink.events).includes(sentinel), false);
});
