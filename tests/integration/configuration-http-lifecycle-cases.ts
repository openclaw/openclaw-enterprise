import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import type { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  ConfigurationSchema,
  ConfigurationValues,
  ErrorResponse,
  JsonValue,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  type AccessBinding,
  type ComputeDriver,
  type Configuration,
  type ConfigurationDriver,
  type Identity,
  type NamespaceWire,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type Permission,
  type Principal,
  type Role,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import {
  admittedConfiguration,
  withGatewaySecurityDefaults,
} from "../helpers/admitted-configuration.mjs";
import { servedAs } from "../helpers/agent-identity.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { FlakyConfigurationCoreV1Api } from "../helpers/kubernetes-configuration-core.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const schemaContext = {
  SafeJsonValue: JsonValue,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginApprovers: PluginApproversSchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

interface HttpResponse {
  status: number;
  body: unknown;
}

interface AgentReadinessContext {
  controller: OpenClawController;
  principal: Principal;
  identities: Identity[];
  roles: Role[];
  bindings: AccessBinding[];
}

interface ConfigurationContext extends AgentReadinessContext {
  app: ControllerApp;
  auditSink: InMemoryAuditSink;
}

interface ConfigurationHttpLifecycleFixtures {
  createConfigurationBackend(): ConfigurationDriver & { storedConfigurations(): Configuration[] };
  fixture(options?: {
    configurationDriver?: ConfigurationDriver;
    computeDriver?: ComputeDriver;
    permissions?: Permission[];
  }): Promise<ConfigurationContext & { namespace: NamespaceWire; collection: string }>;
  createOpenClawConfiguration(): OpenClawConfigurationDocument;
  request(
    app: ControllerApp,
    method: string,
    pathname: string,
    options?: { body?: unknown; authorization?: boolean },
  ): Promise<HttpResponse>;
  readyAgent(
    context: AgentReadinessContext,
    namespace: NamespaceWire,
    agentId: string,
    configurationId: string,
    secretName: string,
  ): Promise<void>;
  deployAccepted(context: ConfigurationContext, agentPath: string): Promise<HttpResponse>;
  updateSaved(
    context: ConfigurationContext,
    item: string,
    values: OpenClawConfigurationDocument,
  ): Promise<HttpResponse>;
  assertRefused(response: HttpResponse, message: string, options: { sentinel: string }): void;
  literalModelKey(field: string): string;
}

export function registerConfigurationCrudCases(fixtures: ConfigurationHttpLifecycleFixtures): void {
  const { createConfigurationBackend, fixture, createOpenClawConfiguration, request } = fixtures;

  test("native OpenClaw Configuration HTTP CRUD preserves documents, SecretRefs, exact scope, and audit", async () => {
    const configurationDriver = createConfigurationBackend();
    const { namespace, collection, ...context } = await fixture({ configurationDriver });
    const values = createOpenClawConfiguration();

    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
    assert.match(created.body.data.id, /^cfg_[0-9a-f-]{36}$/);
    assert.equal(created.body.data.namespaceId, namespace.id);
    assert.equal(created.body.data.kind, "agent");
    assert.equal(created.body.data.generation, 1);
    assert.deepEqual(created.body.data.values, values);
    assert.deepEqual(configurationDriver.storedConfigurations()[0]?.values, values);
    const pathname = `${collection}/${created.body.data.id}`;

    const read = await request(context.app, "GET", pathname);
    assert.equal(read.status, 200);
    assert.ok(Check(schemaContext, ConfigurationResponse, read.body));
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
    assert.ok(Check(schemaContext, ConfigurationResponse, updated.body));
    assert.equal(updated.body.data.kind, "agent");
    assert.equal(updated.body.data.generation, 2);
    assert.deepEqual(updated.body.data.values, replacement);
    assert.deepEqual(configurationDriver.storedConfigurations()[0]?.values, replacement);

    const deleted = await request(context.app, "DELETE", pathname);
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, undefined);

    const missing = await request(context.app, "GET", pathname);
    assert.equal(missing.status, 404);
    assert.ok(Check(ErrorResponse, missing.body));
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
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
    const pathname = `${collection}/${created.body.data.id}`;

    const first = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "first" }, expectedGeneration: 1 },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, first.body));
    assert.equal(first.body.data.generation, 2);

    // The refusal comes before any write: the substrate never holds the refused content, not even
    // until a rollback restores the newer document.
    const writes: (OpenClawConfigurationValue | undefined)[] = [];
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
      assert.ok(Check(ErrorResponse, stale.body));
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
    assert.ok(Check(schemaContext, ConfigurationResponse, read.body));
    assert.equal(read.body.data.generation, 2);
    assert.deepEqual(read.body.data.values, { model: "first" });
    assert.deepEqual(configurationDriver.storedConfigurations()[0]?.values, { model: "first" });

    for (const expectedGeneration of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await request(context.app, "PATCH", pathname, {
        body: { values: { model: "invalid" }, expectedGeneration },
      });
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.ok(Check(ErrorResponse, invalid.body));
      assert.equal(invalid.body.error.code, "INVALID_REQUEST");
    }

    const unchecked = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "unchecked" } },
    });
    assert.equal(unchecked.status, 200, JSON.stringify(unchecked.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, unchecked.body));
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

  test("Configuration HTTP PATCH on a slow Kubernetes API answers 503 within its budget and saves nothing", async (t) => {
    // Finding 3106: a PATCH whose chained Kubernetes calls each took seconds, under their own 10 s
    // limit, committed after the Console ingress had answered 504 at 15 s, so the caller thought
    // the save had failed. The real Kubernetes Configuration Driver runs here over an in-memory
    // CoreV1Api (not cluster proof); the Fastify, IAM, OCC and transaction paths are real.
    const client = new FlakyConfigurationCoreV1Api();
    const configurationDriver = new KubernetesConfigurationDriver({
      authentication: { mode: "inCluster" },
    });
    assert.ok(Object.hasOwn(configurationDriver, "client"));
    Object.assign(configurationDriver, { client: Promise.resolve(client) });
    const { collection, namespace, ...context } = await fixture({ configurationDriver });
    client.addNamespace(namespace.id);
    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: { model: "created" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
    const pathname = `${collection}/${created.body.data.id}`;

    // Each Kubernetes call now takes 4 s of the API's clock. The PATCH needs five (namespace
    // verification and read for the locked record, then again with the replace), 20 s in all.
    let lag = 0;
    const clock = Date.now;
    t.mock.method(Date, "now", () => clock() + lag);
    const called = client.called.bind(client);
    client.called = (method) => {
      lag += 4_000;
      return called(method);
    };
    const before = { ...client.calls };
    const slow = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "edited" } },
    });
    assert.equal(slow.status, 503, JSON.stringify(slow.body));
    assert.ok(Check(ErrorResponse, slow.body));
    assert.equal(slow.body.error.code, "DEPENDENCY_UNAVAILABLE");
    // The 12 s budget ran out after three calls, before the update's read and replace, which
    // were never sent. The compensation still ran its own namespace verification and read after
    // the budget, found the stored generation unchanged, and left it alone.
    assert.deepEqual(client.calls, {
      listNamespace: before.listNamespace + 3,
      readNamespacedConfigMap: before.readNamespacedConfigMap + 2,
      createNamespacedConfigMap: before.createNamespacedConfigMap,
      replaceNamespacedConfigMap: before.replaceNamespacedConfigMap,
      deleteNamespacedConfigMap: before.deleteNamespacedConfigMap,
    });
    const read = await request(context.app, "GET", pathname);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, read.body));
    assert.equal(read.body.data.generation, 1);
    assert.deepEqual(read.body.data.values, { model: "created" });

    // Within the budget the same save succeeds.
    client.called = called;
    const saved = await request(context.app, "PATCH", pathname, {
      body: { values: { model: "edited" } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, saved.body));
    assert.equal(saved.body.data.generation, 2);
  });

  test("Configuration HTTP requires native supported requests and rejects immutable metadata changes", async () => {
    const configurationDriver = createConfigurationBackend();
    const { namespace, collection, ...context } = await fixture({ configurationDriver });

    for (const values of [null, [], "not-an-openclaw-document", 42]) {
      const invalid = await request(context.app, "POST", collection, {
        body: { kind: "agent", values },
      });
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.ok(Check(ErrorResponse, invalid.body));
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
      assert.ok(Check(ErrorResponse, rejected.body));
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
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));

    for (const body of [
      { kind: "agent", values: {} },
      { kind: "gateway", values: {} },
      { generation: 4, values: {} },
    ]) {
      const rejected = await request(
        context.app,
        "PATCH",
        `${collection}/${created.body.data.id}`,
        {
          body,
        },
      );
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.ok(Check(ErrorResponse, rejected.body));
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
    assert.ok(Check(ErrorResponse, longField.body));
    assert.equal(longField.body.error.message.length, 256, longField.body.error.message);
    assert.match(longField.body.error.message, /: body \/x+… is not an accepted field\.$/);

    const unchanged = await request(context.app, "GET", `${collection}/${created.body.data.id}`);
    assert.ok(Check(schemaContext, ConfigurationResponse, unchanged.body));
    assert.deepEqual(unchanged.body.data, created.body.data);
  });
}

export function registerConfigurationOwnershipCases(
  fixtures: ConfigurationHttpLifecycleFixtures,
): void {
  const { fixture, createOpenClawConfiguration, request, readyAgent, deployAccepted, updateSaved } =
    fixtures;

  test("Namespace deletion names the Configuration IDs that keep it occupied", async () => {
    const { namespace, collection, ...context } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await request(context.app, "POST", collection, {
        body: { kind: "agent", values: createOpenClawConfiguration() },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
      ids.push(created.body.data.id);
    }
    // Configurations have no list route, so the 409 is where an operator learns which IDs
    // to delete. Configurations created in the same millisecond may be named in any order.
    const named = async () => {
      const blocked = await request(context.app, "DELETE", `/namespaces/${namespace.id}`);
      assert.equal(blocked.status, 409);
      assert.ok(Check(ErrorResponse, blocked.body));
      assert.equal(blocked.body.error.code, "NAMESPACE_NOT_EMPTY");
      const listed =
        /^The requested Namespace is not empty\. It still contains: Configurations \((.+)\)\.$/.exec(
          blocked.body.error.message,
        );
      assert.ok(listed?.[1], blocked.body.error.message);
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
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
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
    assert.ok(Check(ErrorResponse, unauthenticated.body));
    assert.equal(unauthenticated.body.error.code, "UNAUTHENTICATED");
  });

  test("Configuration authorization failures target the exact Configuration resource", async () => {
    const { namespace, ...context } = await fixture({
      permissions: [
        { action: "create", resourceKind: "namespace" },
        { action: "create", resourceKind: "configuration" },
      ],
    });
    const created = await request(
      context.app,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        body: { kind: "agent", values: { model: "gpt-test" } },
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));

    // Creating in a tenant does not implicitly authorize reading its exact Configuration.
    const denied = await request(
      context.app,
      "GET",
      `/namespaces/${namespace.id}/configurations/${created.body.data.id}`,
    );
    assert.equal(denied.status, 403);
    assert.ok(Check(ErrorResponse, denied.body));
    assert.equal(denied.body.error.code, "FORBIDDEN");
    const denial = context.auditSink.events.at(-1);
    assert.ok(denial);
    assert.equal(denial.resource.kind, "configuration");
    assert.equal(denial.resource.id, created.body.data.id);
  });

  for (const runtimeLogging of [undefined, "driver"] as const) {
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
      assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
      const configurationId = created.body.data.id;
      const agent = await request(context.app, "POST", `/namespaces/${namespace.id}/agents`, {
        body: { name: "Configuration consumer", configurationId },
      });
      assert.equal(agent.status, 201, JSON.stringify(agent.body));
      assert.ok(Check(schemaContext, AgentResponse, agent.body));
      assert.equal(agent.body.data.configurationId, configurationId);
      const agentPath = `/namespaces/${namespace.id}/agents/${agent.body.data.id}`;

      // A referenced Configuration cannot be deleted and leave an Agent with a dangling reference.
      const referenced = await request(context.app, "DELETE", `${collection}/${configurationId}`);
      assert.equal(referenced.status, 409);
      assert.ok(Check(ErrorResponse, referenced.body));
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
      const deployed = await deployAccepted(context, agentPath);
      assert.ok(Check(schemaContext, AgentRevisionResponse, deployed.body));
      assert.equal(deployed.body.data.configurationId, configurationId);
      assert.equal(deployed.body.data.configurationKind, "agent");
      assert.equal(deployed.body.data.configurationGeneration, 1);
      const identity: unknown = servedAs(initialValues, "Configuration consumer");
      assert.ok(Check(schemaContext, ConfigurationValues, identity));
      const expected: unknown =
        runtimeLogging === "driver"
          ? withGatewaySecurityDefaults(identity)
          : admittedConfiguration(identity);
      assert.ok(Check(schemaContext, ConfigurationValues, expected));
      assert.deepEqual(deployed.body.data.configuration, expected);

      const source = await request(context.app, "GET", `${collection}/${configurationId}`);
      assert.equal(source.status, 200);
      assert.ok(Check(schemaContext, ConfigurationResponse, source.body));
      assert.deepEqual(source.body.data.values, initialValues);
      const expectedHistorical = structuredClone(deployed.body.data.configuration);

      const updated = await updateSaved(context, `${collection}/${configurationId}`, {
        models: {
          providers: {
            openai: { apiKey: { source: "store", provider: "teamstore", id: "NEXT_API_KEY" } },
          },
        },
      });
      assert.ok(Check(schemaContext, ConfigurationResponse, updated.body));
      assert.equal(updated.body.data.generation, 2);
      const historical = await request(
        context.app,
        "GET",
        `${agentPath}/revisions/${deployed.body.data.id}`,
      );
      assert.equal(historical.status, 200);
      assert.ok(Check(schemaContext, AgentRevisionResponse, historical.body));
      assert.equal(historical.body.data.configurationGeneration, 1);
      assert.deepEqual(historical.body.data.configuration, expectedHistorical);
    });
  }
}

export function registerFilesystemConfigurationCredentialCase(
  fixtures: ConfigurationHttpLifecycleFixtures,
): void {
  const { fixture, createOpenClawConfiguration, request, assertRefused, literalModelKey } =
    fixtures;

  test("Filesystem Configuration API rejects plaintext model writes without changing stored references", async (t) => {
    const root = await temporaryDirectory(t, "occ-model-configuration-");
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
    assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
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
        {
          models: { providers: { "a/b~c": { headers: { Authorization: `Bearer ${sentinel}` } } } },
        },
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
      assert.ok(Check(ErrorResponse, named.body));
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
    ] as const) {
      const named = await request(context.app, "PATCH", `${collection}/${id}`, {
        body: { values: { models: { providers: { [providerName]: { apiKey: sentinel } } } } },
      });
      assert.equal(named.status, 400);
      assert.ok(Check(ErrorResponse, named.body));
      const { message } = named.body.error;
      assert.equal(message.startsWith(`Configuration field ${field} holds`), true, message);
      assert.equal(/[\p{Cc}\p{Cf}]/u.test(message), false);
      assert.equal(message.isWellFormed(), true);
      assert.ok(Array.from(message).length <= 256);
    }
    assert.equal(await readFile(path, "utf8"), original);
    const unchanged = await request(context.app, "GET", `${collection}/${id}`);
    assert.equal(unchanged.status, 200);
    assert.ok(Check(schemaContext, ConfigurationResponse, unchanged.body));
    assert.deepEqual(unchanged.body.data, created.body.data);

    // Direct Driver callers and externally modified storage retain the same boundary.
    const persisted: unknown = JSON.parse(original);
    assert.ok(Check(schemaContext, ConfigurationSchema, persisted));
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
}
