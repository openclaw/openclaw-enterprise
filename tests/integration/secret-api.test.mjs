import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);
const defaultControllerBodyLimit = 64 * 1024;
const syntheticSecretSentinel = "synthetic-secret-boundary:";

function jsonBodyBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function bodyAtJsonLimit(limit, buildBody) {
  const emptyBodyBytes = jsonBodyBytes(buildBody(""));
  const targetValueBytes = limit - emptyBodyBytes;
  assert.ok(targetValueBytes >= syntheticSecretSentinel.length);
  const value = `${syntheticSecretSentinel}${"x".repeat(
    targetValueBytes - syntheticSecretSentinel.length,
  )}`;
  assert.equal(Buffer.byteLength(value, "utf8"), targetValueBytes);

  const body = buildBody(value);
  assert.equal(jsonBodyBytes(body), limit);
  return { body, value };
}

function createTestComputeDriver() {
  return {
    id: "compute-secret-api",
    capability: "compute",
    implementation: "deterministic-test",
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
}

async function createFixture(options = {}) {
  const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "Secret API Administrator",
  });
  const principal = authFixture.seed.principal;
  const state = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: authFixture.seed.roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: authFixture.seed.roles[0].id,
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: "iam-secret-api" },
  );
  const auditSink = new InMemoryAuditSink();
  const secretDriver = options.secretDriver ?? createTestSecretDriver({ id: "secret-api-test" });
  let controller;
  const sessionsByPrincipalId = new Map();

  function createApp(identity = principal) {
    const app = createControllerApp({
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              controller = new OpenClawController(installation, {
                state: new InMemoryPlatformState({ auditSink }),
                recordOperations: options.recordOperations ?? false,
              });
              return controller;
            },
          }),
      iamDriver,
      computeDriver: options.computeDriver ?? createTestComputeDriver(),
      configurationDriver: createTestConfigurationDriver({ id: "configuration-secret-api" }),
      secretDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      development: { enabled: true, installationId },
      auth: authFixture.auth,
    });
    app.defaultSession = sessionsByPrincipalId.get(identity.id);
    return app;
  }

  const app = createApp();
  sessionsByPrincipalId.set(principal.id, await signInToControllerApp(app, authFixture));
  app.defaultSession = sessionsByPrincipalId.get(principal.id);

  async function createPrincipal(name) {
    const email = `${name}-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const account = await authFixture.auth.createAccount({ email, password, name });
    const seed = authFixture.auth.principalSeed(account, { grant: "none" });
    state.identities.push(seed.principal);
    sessionsByPrincipalId.set(
      seed.principal.id,
      await signInToControllerApp(app, { email, password }),
    );
    return { principal: seed.principal, app: createApp(seed.principal) };
  }

  return {
    app,
    auditSink,
    controller: () => controller,
    createPrincipal,
    principal,
    secretDriver,
    state,
  };
}

async function request(app, method, pathname, options = {}) {
  const headers = {
    ...(options.identity === false
      ? {}
      : authenticatedHeaders(options.session ?? app.defaultSession)),
    ...options.headers,
  };
  const hasBody = Object.hasOwn(options, "body");
  if (hasBody) {
    headers["content-type"] ??= "application/json";
  }
  const response = await app.fetch(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  const body = response.status === 204 ? undefined : await response.json();
  if (body !== undefined) {
    assert.match(body.meta?.requestId ?? "", identifier("req"));
  }
  return { status: response.status, headers: response.headers, body, data: body?.data };
}

async function bootstrapNamespace(fixture) {
  const bootstrapped = await request(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Secret API installation" },
  });
  assert.equal(bootstrapped.status, 201);

  const namespace = await request(fixture.app, "POST", "/namespaces", {
    body: { name: "secret-api-namespace" },
  });
  assert.equal(namespace.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, namespace.data.id, "ready");

  return namespace.data;
}

async function bootstrapAgent(fixture, values = {}, executionMode = "embedded") {
  const namespace = await bootstrapNamespace(fixture);
  const configuration = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { body: { kind: "agent", values } },
  );
  assert.equal(configuration.status, 201);

  const agent = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "secret-api-agent", configurationId: configuration.data.id, executionMode },
  });
  assert.equal(agent.status, 201);
  return { namespace, configuration: configuration.data, agent: agent.data };
}

function createModelDiscoveryFixture() {
  const native = createTestKubernetesComputeDriver("compute-model-discovery");
  return createFixture({
    computeDriver: {
      ...createTestComputeDriver(),
      discoverHarnessModels: native.discoverHarnessModels,
    },
  });
}

test("Agent model discovery uses native provider APIs without creating platform resources", async (t) => {
  const fixture = await createModelDiscoveryFixture();
  const namespace = await bootstrapNamespace(fixture);
  const apiKey = `model-discovery-key-${randomUUID()}`;
  const pages = [
    { data: [{ id: "z-model" }, { id: "embedding-model" }, { id: "ft:model/custom" }] },
    {
      data: [{ id: "claude-new", display_name: "New Claude" }],
      has_more: true,
      last_id: "claude-new",
    },
    {
      data: [{ id: "claude-previous", display_name: "Previous Claude" }],
      has_more: false,
      last_id: "claude-previous",
    },
    { data: [], has_more: false, last_id: null },
    { chatgpt_account_id: "verified-account", chatgpt_account_is_fedramp: true },
    {
      models: [
        {
          slug: "codex-later",
          display_name: "Later model",
          visibility: "list",
          priority: 2,
          model_messages: { instructions: "omit runtime prompts" },
        },
        { slug: "codex-hidden", display_name: "Hidden model", visibility: "hide", priority: 0 },
        { slug: "codex-dynamic", display_name: "Codex dynamic", visibility: "list", priority: 1 },
      ],
    },
  ];
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json(pages.shift()));
  const path = `/namespaces/${namespace.id}/agents/models`;
  const openai = await request(fixture.app, "POST", path, {
    body: { provider: "openai", authMethod: "api_key", apiKey },
  });
  assert.equal(openai.status, 200);
  assert.equal(openai.headers.get("cache-control"), "no-store");
  assert.deepEqual(openai.data, [
    { id: "embedding-model", name: "embedding-model" },
    { id: "ft:model/custom", name: "ft:model/custom" },
    { id: "z-model", name: "z-model" },
  ]);
  const anthropic = await request(fixture.app, "POST", path, {
    body: { provider: "anthropic", authMethod: "api_key", apiKey },
  });
  assert.equal(anthropic.status, 200);
  assert.deepEqual(anthropic.data, [
    { id: "claude-new", name: "New Claude" },
    { id: "claude-previous", name: "Previous Claude" },
  ]);
  const empty = await request(fixture.app, "POST", path, {
    body: { provider: "anthropic", authMethod: "api_key", apiKey },
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, []);
  const pat = await request(fixture.app, "POST", path, {
    body: { provider: "openai", authMethod: "codex_pat", apiKey: "at-fixture-token" },
  });
  assert.equal(pat.status, 200);
  assert.deepEqual(pat.data, [
    { id: "codex-dynamic", name: "Codex dynamic" },
    { id: "codex-later", name: "Later model" },
  ]);
  const calls = transport.mock.calls.map(({ arguments: args }) => args);
  assert.deepEqual(
    calls.map(([url]) => url),
    [
      "https://api.openai.com/v1/models",
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-new",
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "https://chatgpt.com/backend-api/codex/models?client_version=0.156.0",
    ],
  );
  assert.deepEqual(calls[0][1].headers, { Authorization: `Bearer ${apiKey}` });
  for (const [, options] of calls.slice(1, 4)) {
    assert.deepEqual(options.headers, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  }
  for (const [, options] of calls) {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(calls[1][1].signal, calls[2][1].signal);
  assert.deepEqual(calls[4][1].headers, { Authorization: "Bearer at-fixture-token" });
  assert.deepEqual(calls[5][1].headers, {
    Authorization: "Bearer at-fixture-token",
    "ChatGPT-Account-ID": "verified-account",
    "X-OpenAI-Fedramp": "true",
  });
  assert.equal(calls[4][1].signal, calls[5][1].signal);
  assert.deepEqual(fixture.secretDriver.calls, []);
  assert.deepEqual(
    await fixture.controller().transact(async (unit) => ({
      agents: await unit.namespaces.hasAgents(namespace.id),
      configurations: await unit.namespaces.hasConfigurations(namespace.id),
      secrets: await unit.namespaces.hasSecrets(namespace.id),
    })),
    { agents: false, configurations: false, secrets: false },
  );
  assert.equal(JSON.stringify([openai.body, anthropic.body, empty.body]).includes(apiKey), false);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(apiKey), false);
});

test("OpenAI API-key model discovery excludes models whose shutdown date has arrived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-04-15T23:59:59Z") });
  const fixture = await createModelDiscoveryFixture();
  const namespace = await bootstrapNamespace(fixture);
  // OpenAI's optional shutdown_date is a calendar date, independent of model age or ID.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { id: "past-shutdown", shutdown_date: "2030-04-14" },
        { id: "today-shutdown", shutdown_date: "2030-04-15" },
        { id: "future-shutdown", shutdown_date: "2030-04-16" },
        { id: "invalid-date", shutdown_date: "2030-02-30" },
        { id: "invalid-type", shutdown_date: 1 },
        { id: "null-shutdown", shutdown_date: null },
        { id: "unspecified-shutdown", created: 1 },
      ],
    }),
  );
  const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
    body: { provider: "openai", authMethod: "api_key", apiKey: "synthetic-discovery-key" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, [
    { id: "future-shutdown", name: "future-shutdown" },
    { id: "invalid-date", name: "invalid-date" },
    { id: "invalid-type", name: "invalid-type" },
    { id: "null-shutdown", name: "null-shutdown" },
    { id: "unspecified-shutdown", name: "unspecified-shutdown" },
  ]);
});

test("Service account token discovery rejects invalid identity without falling through to the API-key endpoint", async (t) => {
  const fixture = await createModelDiscoveryFixture();
  const namespace = await bootstrapNamespace(fixture);
  for (const [response, expectedCode] of [
    [
      Response.json({ error: "private upstream error" }, { status: 401 }),
      "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
    ],
    [Response.json({ chatgpt_account_id: "unverified" }), "MODEL_DISCOVERY_INVALID_RESPONSE"],
  ]) {
    const transport = t.mock.method(globalThis, "fetch", async () => response);
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: { provider: "openai", authMethod: "codex_pat", apiKey: "at-private-fixture" },
    });
    assert.equal(result.body.error.code, expectedCode);
    assert.equal(transport.mock.callCount(), 1);
    assert.equal(
      transport.mock.calls[0].arguments[0],
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
    );
    assert.doesNotMatch(
      JSON.stringify([result.body, fixture.auditSink.events]),
      /at-private-fixture|private upstream error/,
    );
    transport.mock.restore();
  }
});

test("Agent model discovery requires namespace Agent-create permission before provider I/O", async (t) => {
  const fixture = await createModelDiscoveryFixture();
  const namespace = await bootstrapNamespace(fixture);
  const { principal: reader, app: readerApp } = await fixture.createPrincipal("model-reader");
  fixture.state.roles.push({
    id: "role-model-reader",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  fixture.state.bindings.push({
    id: "binding-model-reader",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: "role-model-reader",
  });
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const apiKey = `denied-discovery-key-${randomUUID()}`;
  const denied = await request(readerApp, "POST", `/namespaces/${namespace.id}/agents/models`, {
    body: { provider: "openai", authMethod: "api_key", apiKey },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(transport.mock.callCount(), 0);
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.id,
    action: "create",
    resource: { kind: "agent", id: namespace.id, namespaceId: namespace.id },
  });
  assert.equal(JSON.stringify([denied.body, denial]).includes(apiKey), false);

  fixture.state.roles[fixture.state.roles.length - 1].permissions.push({
    action: "create",
    resourceKind: "agent",
  });
  const granted = await request(readerApp, "POST", `/namespaces/${namespace.id}/agents/models`, {
    body: { provider: "openai", authMethod: "api_key", apiKey },
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.data, []);
  assert.equal(transport.mock.callCount(), 1);
});

test("Agent model discovery reports unsupported Compute Drivers without contacting a provider", async (t) => {
  const fixture = await createFixture();
  const namespace = await bootstrapNamespace(fixture);
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
    body: { provider: "openai", authMethod: "api_key", apiKey: `unsupported-key-${randomUUID()}` },
  });
  assert.equal(result.status, 501);
  assert.equal(result.body.error.code, "NOT_IMPLEMENTED");
  assert.equal(
    result.body.error.message,
    "Model discovery is unavailable. Enter a model ID manually.",
  );
  assert.equal(transport.mock.callCount(), 0);
});

test("Agent model discovery bounds and redacts provider failures", async (t) => {
  const fixture = await createModelDiscoveryFixture();
  const namespace = await bootstrapNamespace(fixture);
  const apiKey = `private-discovery-key-${randomUUID()}`;
  const upstreamDetail = `private-upstream-detail-${randomUUID()}`;
  let oversizedCancelled = false;
  const credentialsRejected = [
    400,
    "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
    "The provider rejected model discovery. Check the selected credential and its permission to list models, then retry or enter a model ID manually.",
  ];
  const rateLimited = [
    429,
    "MODEL_DISCOVERY_RATE_LIMITED",
    "The provider rate-limited model discovery. Wait and retry, or enter a model ID manually.",
  ];
  const unavailable = [
    503,
    "MODEL_DISCOVERY_UNAVAILABLE",
    "The provider model service is unavailable. Retry or enter a model ID manually.",
  ];
  const invalidResponse = [
    503,
    "MODEL_DISCOVERY_INVALID_RESPONSE",
    "The provider returned an invalid model list. Retry or enter a model ID manually.",
  ];
  const scenarios = [
    [
      "rejected API key",
      () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 401 }),
      credentialsRejected,
    ],
    [
      "missing Models permission",
      () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 403 }),
      credentialsRejected,
    ],
    [
      "provider rate limit",
      () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 429 }),
      rateLimited,
    ],
    [
      "provider service error",
      () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 500 }),
      unavailable,
    ],
    [
      "transport error",
      () => {
        throw new Error(`${upstreamDetail} ${apiKey}`);
      },
      unavailable,
    ],
    [
      "provider timeout",
      () => {
        throw new DOMException(`${upstreamDetail} ${apiKey}`, "TimeoutError");
      },
      unavailable,
    ],
    ["malformed JSON", () => new Response(`{${upstreamDetail} ${apiKey}`), invalidResponse],
    [
      "missing model list",
      () => Response.json({ message: `${upstreamDetail} ${apiKey}` }),
      invalidResponse,
    ],
    [
      "oversized stream",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
            },
            cancel() {
              oversizedCancelled = true;
            },
          }),
        ),
      invalidResponse,
    ],
  ];
  for (const [name, respond, [status, code, message]] of scenarios) {
    await t.test(name, async (subtest) => {
      const transport = subtest.mock.method(globalThis, "fetch", respond);
      const failed = await request(
        fixture.app,
        "POST",
        `/namespaces/${namespace.id}/agents/models`,
        { body: { provider: "openai", authMethod: "api_key", apiKey } },
      );
      assert.equal(failed.status, status);
      assert.equal(failed.body.error.code, code);
      assert.equal(failed.body.error.message, message);
      assert.equal(transport.mock.callCount(), 1);
      const exposed = JSON.stringify([failed.body, fixture.auditSink.events]);
      assert.equal(exposed.includes(apiKey), false);
      assert.equal(exposed.includes(upstreamDetail), false);
    });
  }
  assert.equal(oversizedCancelled, true);
});

test("Secret API stores values through the selected driver and returns metadata only", async () => {
  const fixture = await createFixture();
  const { namespace, agent } = await bootstrapAgent(fixture);
  const originalValue = `secret-value-${randomUUID()}`;
  const rotatedValue = `rotated-value-${randomUUID()}`;

  const removedOwnerField = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: { agentId: agent.id, name: "Removed owner key", value: `secret-value-${randomUUID()}` },
    },
  );
  assert.equal(removedOwnerField.status, 400);
  assert.equal(removedOwnerField.body.error.code, "INVALID_REQUEST");

  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Backend API key", value: originalValue },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.id, identifier("sec"));
  assert.deepEqual(created.data, {
    id: created.data.id,
    namespaceId: namespace.id,
    name: "Backend API key",
    ref: { kind: "secret", namespaceId: namespace.id, id: created.data.id },
  });
  assert.equal(JSON.stringify(created.body).includes(originalValue), false);
  assert.equal(JSON.stringify(created.body).includes("backendRef"), false);
  assert.equal(JSON.stringify(created.body).includes("driverId"), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), originalValue);

  const hidden = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Hidden provider API key", value: `secret-value-${randomUUID()}` },
  });
  assert.equal(hidden.status, 201);
  fixture.state.restrictions.push({
    id: "deny-hidden-secret-read",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: hidden.data.id,
    action: "read",
    effect: "deny",
  });
  const foreignNamespace = await request(fixture.app, "POST", "/namespaces", {
    body: { name: `foreign-secret-list-${randomUUID()}` },
  });
  assert.equal(foreignNamespace.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, foreignNamespace.data.id, "ready");
  const foreign = await request(
    fixture.app,
    "POST",
    `/namespaces/${foreignNamespace.data.id}/secrets`,
    { body: { name: "Foreign provider API key", value: `secret-value-${randomUUID()}` } },
  );
  assert.equal(foreign.status, 201);
  const listed = await request(fixture.app, "GET", `/namespaces/${namespace.id}/secrets`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, [created.data]);
  assert.equal(JSON.stringify(listed.body).includes(originalValue), false);
  assert.equal(
    JSON.stringify(listed.body).includes(fixture.secretDriver.valueFor(hidden.data)),
    false,
  );
  assert.equal(JSON.stringify(listed.body).includes(foreign.data.id), false);

  const detail = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data, created.data);

  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: { value: rotatedValue } },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data, created.data);
  assert.equal(fixture.secretDriver.valueFor(created.data), rotatedValue);

  for (const invalid of ["", "bad\u0000value"]) {
    const rejected = await request(
      fixture.app,
      "PATCH",
      `/namespaces/${namespace.id}/secrets/${created.data.id}`,
      { body: { value: invalid } },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
  }
  const deleted = await request(
    fixture.app,
    "DELETE",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(deleted.status, 204);
  assert.equal(fixture.secretDriver.has(created.data), false);

  const missing = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(missing.status, 404);

  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(originalValue), false);
  assert.equal(audit.includes(rotatedValue), false);
  assert.deepEqual(
    fixture.auditSink.events
      .filter((event) => event.resource.kind === "secret" && event.kind === "mutation")
      .map((event) => event.action),
    [
      "openclaw.secrets.create",
      "openclaw.secrets.create",
      "openclaw.secrets.create",
      "openclaw.secrets.update",
      "openclaw.secrets.delete",
    ],
  );
});

test("Secret API accepts the largest default JSON body and rejects one byte over", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);

  const createEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({
    name: "HTTP body boundary key",
    value,
  }));
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: createEnvelope.body,
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), createEnvelope.value);

  const oversizedCreateBody = {
    ...createEnvelope.body,
    value: `${createEnvelope.value}x`,
  };
  assert.equal(jsonBodyBytes(oversizedCreateBody), defaultControllerBodyLimit + 1);
  const oversizedCreate = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: oversizedCreateBody,
    },
  );
  assert.equal(oversizedCreate.status, 413);
  assert.equal(oversizedCreate.body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedCreate.body).includes(syntheticSecretSentinel), false);

  const updateEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({ value }));
  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: updateEnvelope.body },
  );
  assert.equal(updated.status, 200);
  assert.equal(JSON.stringify(updated.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);

  const oversizedUpdateBody = { value: `${updateEnvelope.value}x` };
  assert.equal(jsonBodyBytes(oversizedUpdateBody), defaultControllerBodyLimit + 1);
  const oversizedUpdate = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: oversizedUpdateBody },
  );
  assert.equal(oversizedUpdate.status, 413);
  assert.equal(oversizedUpdate.body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedUpdate.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(syntheticSecretSentinel), false);
});

test("Secret API denial and storage failures return value-free errors", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);
  const value = `private-denied-value-${randomUUID()}`;
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Denied metadata key", value },
  });
  assert.equal(created.status, 201);

  const { principal: reader, app: readerApp } = await fixture.createPrincipal("secret-reader");
  fixture.state.roles.push({
    id: "role-secret-reader-without-secret",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  fixture.state.bindings.push({
    id: "binding-secret-reader-without-secret",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: "role-secret-reader-without-secret",
  });

  const denied = await request(
    readerApp,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.id,
    action: "read",
    resource: { kind: "secret", id: created.data.id, namespaceId: namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(value), false);

  const leakedBackendValue = `backend-leak-${randomUUID()}`;
  const failingFixture = await createFixture({
    secretDriver: createTestSecretDriver({
      id: "secret-api-failing",
      createError: new Error(`must not leak ${leakedBackendValue}`),
    }),
  });
  const failing = await bootstrapAgent(failingFixture);
  const failed = await request(
    failingFixture.app,
    "POST",
    `/namespaces/${failing.namespace.id}/secrets`,
    {
      body: {
        name: "Backend failure key",
        value: leakedBackendValue,
      },
    },
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.body).includes(leakedBackendValue), false);
  assert.equal(JSON.stringify(failingFixture.auditSink.events).includes(leakedBackendValue), false);
});

// These tests exercise API validation, Native IAM, OCC admission, and state ownership.
// Passive Secret storage does not establish provider login or model execution proof.
for (const [model, method, executionMode] of [
  ["openai/gpt-5", "api_key", "embedded"],
  ["anthropic/claude-sonnet-4-5", "api_key", "embedded"],
  ["codex/gpt-5", "codex_pat", "dedicated"],
]) {
  test(`${model} Harness Secret binding preserves draft semantics, exact delivery grants, and revision source retention`, async () => {
    const harnessAuthDriver = createTestKubernetesComputeDriver("compute-harness-auth");
    const fixture = await createFixture({
      recordOperations: true,
      computeDriver: {
        ...createTestComputeDriver(),
        validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
      },
    });
    let { namespace, configuration, agent } = await bootstrapAgent(
      fixture,
      {
        ...(method === "codex_pat" ? createHarnessConfiguration("codex", "gpt-5") : {}),
        agents: {
          defaults: {
            model,
            models: {
              [model]: { agentRuntime: { id: method === "codex_pat" ? "codex" : "openclaw" } },
            },
          },
        },
      },
      executionMode,
    );
    let path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal(agent.harnessAuth, null);
    assert.equal((await request(fixture.app, "POST", `${path}/deploy`)).status, 409);
    const value = `synthetic-harness-key-${randomUUID()}`;
    const key = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: "Harness key", value },
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const binding = { method, source: key.data.ref };
    if (method === "codex_pat") {
      const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents`, {
        body: {
          name: "direct-pat-agent",
          configurationId: configuration.id,
          executionMode,
          harnessAuth: binding,
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.deepEqual(created.data.harnessAuth, binding);
      agent = created.data;
      path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    }

    const bound = await request(fixture.app, "PATCH", path, {
      body: { configurationId: configuration.id, harnessAuth: binding },
    });
    assert.equal(bound.status, 200);
    assert.deepEqual(bound.data.harnessAuth, binding);
    const unchanged = await request(fixture.app, "PATCH", path, {
      body: { configurationId: configuration.id },
    });
    assert.deepEqual(unchanged.data.harnessAuth, binding);
    assert.equal(
      (await request(fixture.app, "DELETE", `/namespaces/${namespace.id}/secrets/${key.data.id}`))
        .status,
      409,
    );
    // Administrative rights on the actor do not give the Agent permission to receive a key.
    const denied = await request(fixture.app, "POST", `${path}/deploy`);
    assert.equal(denied.status, 403);
    const { servicePrincipalId } = await fixture
      .controller()
      .getAgent(fixture.principal.id, namespace.id, agent.id);
    fixture.state.identities.push({
      kind: "service_principal",
      id: servicePrincipalId,
      namespaceId: namespace.id,
    });
    fixture.state.roles.push({
      id: "harness-key-delivery",
      namespaceId: namespace.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    fixture.state.bindings.push({
      id: "harness-key-delivery",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: servicePrincipalId,
      roleId: "harness-key-delivery",
      resourceKind: "secret",
      resourceId: key.data.id,
    });
    const admitted = await request(fixture.app, "POST", `${path}/deploy`);
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.deepEqual(admitted.data.harnessAuth, binding);
    const internal = await fixture
      .controller()
      .getRevision(fixture.principal.id, namespace.id, agent.id, admitted.data.id);
    assert.deepEqual(internal.harnessAuth, { ...binding, secretDriverId: fixture.secretDriver.id });
    assert.equal(JSON.stringify(admitted.body).includes("secretDriverId"), false);
    assert.equal(JSON.stringify(admitted.body).includes(value), false);
    const cleared = await request(fixture.app, "PATCH", path, {
      body: { configurationId: configuration.id, harnessAuth: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.harnessAuth, null);
    assert.deepEqual(
      (
        await fixture
          .controller()
          .getRevision(fixture.principal.id, namespace.id, agent.id, admitted.data.id)
      ).harnessAuth,
      internal.harnessAuth,
    );
    // Pending revision ownership outlives the current draft binding.
    assert.equal(
      (await request(fixture.app, "DELETE", `/namespaces/${namespace.id}/secrets/${key.data.id}`))
        .status,
      409,
    );
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(value), false);
  });
}

test("Changing Harness Secret bindings requires grants on both removed and replacement sources", async () => {
  const fixture = await createFixture();
  const { namespace, configuration, agent } = await bootstrapAgent(fixture);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const secrets = [];
  for (const name of ["Original", "Replacement"]) {
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name, value: `synthetic-${randomUUID()}` },
    });
    assert.equal(result.status, 201);
    secrets.push(result.data);
  }
  const [original, replacement] = secrets.map((secret) => ({
    method: "api_key",
    source: secret.ref,
  }));
  assert.equal(
    (
      await request(fixture.app, "PATCH", path, {
        body: { configurationId: configuration.id, harnessAuth: original },
      })
    ).status,
    200,
  );
  const { principal, app } = await fixture.createPrincipal("harness-editor");
  fixture.state.roles.push({
    id: "harness-editor",
    namespaceId: namespace.id,
    permissions: [
      { action: "update", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  });
  fixture.state.bindings.push({
    id: "harness-editor",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "harness-editor",
  });
  fixture.state.roles.push({
    id: "harness-source",
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  const grant = {
    id: "harness-source",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "harness-source",
    resourceKind: "secret",
    resourceId: secrets[0].id,
  };
  fixture.state.bindings.push(grant);
  const patch = (harnessAuth) =>
    request(app, "PATCH", path, { body: { configurationId: configuration.id, harnessAuth } });
  assert.equal((await patch(replacement)).status, 403); // Missing replacement authority.
  grant.resourceId = secrets[1].id;
  assert.equal((await patch(replacement)).status, 403); // Missing removed-source authority.
  assert.equal((await patch(null)).status, 403);
  fixture.state.bindings.push({
    ...grant,
    id: "harness-source-original",
    resourceId: secrets[0].id,
  });
  assert.equal((await patch(replacement)).status, 200);
  assert.equal(
    (await request(fixture.app, "DELETE", `/namespaces/${namespace.id}/secrets/${secrets[0].id}`))
      .status,
    204,
  );
  assert.equal((await patch(null)).status, 200);
  assert.equal(
    (await request(fixture.app, "DELETE", `/namespaces/${namespace.id}/secrets/${secrets[1].id}`))
      .status,
    204,
  );
});

test("Harness source admission rejects foreign references and superseded model selectors", async () => {
  const fixture = await createFixture();
  const { namespace, configuration, agent } = await bootstrapAgent(fixture);
  const foreign = await request(fixture.app, "POST", "/namespaces", {
    body: { name: "foreign-harness-source" },
  });
  assert.equal(foreign.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, foreign.data.id, "ready");
  const key = await request(fixture.app, "POST", `/namespaces/${foreign.data.id}/secrets`, {
    body: { name: "Foreign key", value: `synthetic-${randomUUID()}` },
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const rejected = await request(fixture.app, "PATCH", path, {
    body: {
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: key.data.ref },
    },
  });
  assert.equal(rejected.status, 404);
  for (const method of ["POST", "PATCH"]) {
    const rejected = await request(
      fixture.app,
      method,
      method === "POST" ? `/namespaces/${namespace.id}/agents` : path,
      {
        body: {
          ...(method === "POST" ? { name: "Legacy selector" } : {}),
          configurationId: configuration.id,
          serviceAccountId: `sa_${randomUUID()}`,
        },
      },
    );
    assert.equal(rejected.status, 400);
  }
  const localKey = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Local model key", value: `synthetic-${randomUUID()}` },
  });
  assert.equal(localKey.status, 201);
  const malformed = await request(fixture.app, "PATCH", path, {
    body: {
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: localKey.data.ref, credential: "plaintext" },
    },
  });
  assert.equal(malformed.status, 400);
  for (const destination of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    assert.equal(
      (
        await request(fixture.app, "POST", `/namespaces/${namespace.id}/configurations`, {
          body: {
            kind: "agent",
            values: {},
            secretBindings: { [destination]: { source: localKey.data.ref } },
          },
        })
      ).status,
      404,
    );
  }
  assert.equal(
    (
      await request(fixture.app, "POST", `${path}/runtime-credentials`, {
        body: { modelApiKey: "synthetic-legacy-key" },
      })
    ).status,
    400,
  );
});
