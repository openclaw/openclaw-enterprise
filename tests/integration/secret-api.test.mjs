import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";

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
                ...(options.now === undefined ? {} : { now: options.now }),
              });
              return controller;
            },
          }),
      iamDriver,
      computeDriver: options.computeDriver ?? createReadyComputeDriver("compute-secret-api"),
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
      ...createReadyComputeDriver("compute-secret-api"),
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
  grantRole(fixture.state, reader.id, {
    id: "role-model-reader",
    bindingId: "binding-model-reader",
    namespaceId: namespace.id,
    permissions: { namespace: ["read"] },
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
  // The exact read adds the Secret's consumers; nothing references this one yet.
  assert.deepEqual(detail.data, {
    ...created.data,
    consumers: {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 0,
      truncated: false,
    },
  });

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
  // An empty value or name also names the schema's minimum length, so the caller can fix it.
  for (const [method, path, body, field] of [
    ["POST", `/namespaces/${namespace.id}/secrets`, { name: "Empty", value: "" }, "value"],
    ["POST", `/namespaces/${namespace.id}/secrets`, { name: "", value: "nonempty" }, "name"],
    ["PATCH", `/namespaces/${namespace.id}/secrets/${created.data.id}`, { value: "" }, "value"],
  ]) {
    const empty = await request(fixture.app, method, path, { body });
    assert.equal(empty.status, 400);
    assert.equal(
      empty.body.error.message,
      `The request does not match the operation contract: body /${field} has an unsupported value (expected at least 1 character).`,
    );
    assert.deepEqual(empty.body.error.details, [{ path: `/${field}`, code: "INVALID_VALUE" }]);
  }
  // A name over the schema's maximum length names that bound too.
  const longName = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "n".repeat(201), value: "nonempty" },
  });
  assert.equal(longName.status, 400);
  assert.equal(
    longName.body.error.message,
    "The request does not match the operation contract: body /name is too long (expected at most 200 characters).",
  );
  assert.deepEqual(longName.body.error.details, [{ path: "/name", code: "TOO_LONG" }]);
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
  grantRole(fixture.state, reader.id, {
    id: "role-secret-reader-without-secret",
    bindingId: "binding-secret-reader-without-secret",
    namespaceId: namespace.id,
    permissions: { namespace: ["read"] },
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
        ...createReadyComputeDriver("compute-secret-api"),
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
    // The caller holds delete on the Secret, so the conflict names what still depends on it.
    const blocked = await request(
      fixture.app,
      "DELETE",
      `/namespaces/${namespace.id}/secrets/${key.data.id}`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(
      blocked.body.error.message,
      `The Secret is still referenced by Agent ${agent.id}. Remove those references first.`,
    );
    // Authorization precedes the reference check: a caller without delete learns nothing about references.
    const { app: outsiderApp } = await fixture.createPrincipal("secret-outsider");
    const forbidden = await request(
      outsiderApp,
      "DELETE",
      `/namespaces/${namespace.id}/secrets/${key.data.id}`,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "FORBIDDEN");
    // Administrative rights on the actor do not give the Agent permission to receive a key.
    const { servicePrincipalId } = await fixture
      .controller()
      .getAgent(fixture.principal.id, namespace.id, agent.id);
    // The Agent's service principal exists but holds no grant on the key.
    fixture.state.identities.push({
      kind: "service_principal",
      id: servicePrincipalId,
      namespaceId: namespace.id,
    });
    const denied = await request(fixture.app, "POST", `${path}/deploy`);
    assert.equal(denied.status, 403);
    // The caller's own grants passed, so the denial audit records the caller's deploy request
    // and names the Agent service principal and the grant it lacks, never the caller as denied.
    const agentDenial = fixture.auditSink.events.findLast(
      (event) => event.kind === "authorization_denial",
    );
    assert.equal(agentDenial.reasonCode, "AGENT_PRINCIPAL_NOT_AUTHORIZED");
    // The route's reason passes through the audit factory like any other: redacted and capped
    // at 120 characters. The details below still name the principal, action and resource.
    assert.ok(denied.body.error.message.length > 120);
    assert.equal(agentDenial.decisionReason, denied.body.error.message.slice(0, 120));
    assert.deepEqual(agentDenial.authorization, {
      principalId: fixture.principal.id,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
    assert.equal(agentDenial.details.servicePrincipalId, servicePrincipalId);
    assert.equal(agentDenial.details.action, "operate");
    assert.deepEqual(agentDenial.details.resource, key.data.ref);
    assert.equal(agentDenial.details.iamEvidence, undefined);
    assert.equal(agentDenial.details.servicePrincipalEvidence.identityId, servicePrincipalId);
    grantRole(fixture.state, servicePrincipalId, {
      id: "harness-key-delivery",
      namespaceId: namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: key.data.id },
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

// Exercises the HTTP routes, Native IAM and in-memory platform state; PostgreSQL's reference
// query is covered by the platform state store contract.
test("Secret consumers name only readable references, on GET and in the delete conflict", async () => {
  const harnessAuthDriver = createTestKubernetesComputeDriver("compute-secret-consumers");
  const fixture = await createFixture({
    computeDriver: {
      ...createReadyComputeDriver("compute-secret-api"),
      validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
    },
  });
  const model = "openai/gpt-5";
  const { namespace, configuration, agent } = await bootstrapAgent(fixture, {
    agents: {
      defaults: { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } },
    },
  });
  const secrets = `/namespaces/${namespace.id}/secrets`;
  const key = await request(fixture.app, "POST", secrets, {
    body: { name: "Shared key", value: `synthetic-shared-key-${randomUUID()}` },
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const keyPath = `${secrets}/${key.data.id}`;
  const none = { agents: [], configurations: [], credentialSources: [], provisioningRequests: [] };
  // A new Secret has no consumers, and the field is on the exact read only.
  assert.deepEqual((await request(fixture.app, "GET", keyPath)).data.consumers, {
    ...none,
    unreadable: 0,
    truncated: false,
  });
  assert.equal(key.data.consumers, undefined);

  const bindTo = async () => {
    const created = await request(
      fixture.app,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        body: {
          kind: "agent",
          values: {},
          secretBindings: { SLACK_BOT_TOKEN: { source: key.data.ref } },
        },
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.data.id;
  };
  const visible = await bindTo();
  const hidden = await bindTo();
  // The Agent's draft model credential is the third reference.
  const bound = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: {
        configurationId: configuration.id,
        harnessAuth: { method: "api_key", source: key.data.ref },
      },
    },
  );
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const admin = await request(fixture.app, "GET", keyPath);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data.consumers, {
    ...none,
    agents: [agent.id],
    configurations: [visible, hidden].sort(),
    unreadable: 0,
    truncated: false,
  });

  // A member who may read and delete the Secret and read one of the Configurations, nothing else.
  const { principal: member, app: memberApp } = await fixture.createPrincipal("secret-member");
  grantRole(fixture.state, member.id, {
    id: "role-consumer-secret",
    namespaceId: namespace.id,
    permissions: { secret: ["read", "delete"] },
    resource: { kind: "secret", id: key.data.id },
  });
  grantRole(fixture.state, member.id, {
    id: "role-consumer-configuration",
    namespaceId: namespace.id,
    permissions: { configuration: ["read"] },
    resource: { kind: "configuration", id: visible },
  });
  const read = await request(memberApp, "GET", keyPath);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  // The Agent and the other Configuration are counted, never named: no existence oracle.
  assert.deepEqual(read.data.consumers, {
    ...none,
    configurations: [visible],
    unreadable: 2,
    truncated: false,
  });
  const memberDelete = await request(memberApp, "DELETE", keyPath);
  assert.equal(memberDelete.status, 409);
  assert.equal(memberDelete.body.error.code, "RESOURCE_CONFLICT");
  assert.equal(
    memberDelete.body.error.message,
    `The Secret is still referenced by Configuration ${visible}; 2 resources you cannot read. Remove those references first.`,
  );
  for (const unreadable of [hidden, agent.id]) {
    assert.doesNotMatch(JSON.stringify(read.body), new RegExp(unreadable));
    assert.doesNotMatch(JSON.stringify(memberDelete.body), new RegExp(unreadable));
  }
  // Delete alone, without read on the Secret, gets the same answer: naming depends only on
  // reading the referencing resources.
  const { principal: deleter, app: deleterApp } = await fixture.createPrincipal("secret-deleter");
  grantRole(fixture.state, deleter.id, {
    id: "role-consumer-deleter",
    namespaceId: namespace.id,
    permissions: { secret: ["delete"] },
    resource: { kind: "secret", id: key.data.id },
  });
  grantRole(fixture.state, deleter.id, {
    id: "role-consumer-deleter-configuration",
    namespaceId: namespace.id,
    permissions: { configuration: ["read"] },
    resource: { kind: "configuration", id: visible },
  });
  assert.equal((await request(deleterApp, "GET", keyPath)).status, 403);
  assert.deepEqual(
    (await request(deleterApp, "DELETE", keyPath)).body.error,
    memberDelete.body.error,
  );

  // The caller who can read everything sees every ID that fits the 256-character message.
  const adminDelete = await request(fixture.app, "DELETE", keyPath);
  assert.equal(adminDelete.status, 409);
  assert.equal(
    adminDelete.body.error.message,
    `The Secret is still referenced by Agent ${agent.id}; Configurations ${[visible, hidden].sort().join(", ")}. Remove those references first.`,
  );

  // Past the limit, OCC examines the first 50 references and says more exist; the message
  // keeps to the error contract's cap and names IDs of each kind in turn.
  const many = [visible, hidden];
  while (many.length < 50) {
    many.push(await bindTo());
  }
  const full = await request(fixture.app, "GET", keyPath);
  assert.equal(full.data.consumers.truncated, true);
  assert.deepEqual(full.data.consumers.agents, [agent.id]);
  assert.deepEqual(full.data.consumers.configurations, many.sort().slice(0, 49));
  const capped = await request(fixture.app, "DELETE", keyPath);
  assert.equal(capped.status, 409);
  assert.ok(capped.body.error.message.length <= 256, capped.body.error.message);
  assert.match(
    capped.body.error.message,
    new RegExp(
      `^The Secret is still referenced by Agent ${agent.id}; Configurations cfg_[^;]+ and \\d+ more; and more\\. Remove those references first\\.$`,
    ),
  );

  // Clearing every reference empties consumers and lets deletion proceed.
  const cleared = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: { configurationId: configuration.id, harnessAuth: null },
    },
  );
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  for (const id of many) {
    const removed = await request(
      fixture.app,
      "DELETE",
      `/namespaces/${namespace.id}/configurations/${id}`,
    );
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
  }
  assert.deepEqual((await request(fixture.app, "GET", keyPath)).data.consumers, {
    ...none,
    unreadable: 0,
    truncated: false,
  });
  assert.equal((await request(fixture.app, "DELETE", keyPath)).status, 204);
});

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
  grantRole(fixture.state, principal.id, {
    id: "harness-editor",
    namespaceId: namespace.id,
    permissions: { agent: ["update"], configuration: ["read"] },
  });
  const { binding: grant } = grantRole(fixture.state, principal.id, {
    id: "harness-source",
    namespaceId: namespace.id,
    permissions: { secret: ["operate"] },
    resource: { kind: "secret", id: secrets[0].id },
  });
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
  // A foreign Secret reference is an invalid request (#1033), not a scope miss.
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.message, "Secret references cannot cross Namespaces.");
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
  // Provider keys, reserved prefixes and process-control names, in any letter case. The
  // message names the rule and the destination, and the detail points at its binding.
  const reservedPrefix = (prefix, name) =>
    `A secret binding destination uses the reserved prefix ${prefix}*: ${name}.`;
  const reservedName = (name) =>
    `A secret binding destination is a reserved process or platform variable name: ${name}.`;
  for (const [destination, message] of [
    ["OPENAI_API_KEY", reservedPrefix("OPENAI_", "OPENAI_API_KEY")],
    ["ANTHROPIC_API_KEY", reservedPrefix("ANTHROPIC_", "ANTHROPIC_API_KEY")],
    ["ANTHROPIC_AUTH_TOKEN", reservedPrefix("ANTHROPIC_", "ANTHROPIC_AUTH_TOKEN")],
    ["openclaw_gateway_token", reservedPrefix("OPENCLAW_", "openclaw_gateway_token")],
    ["LD_PRELOAD", reservedPrefix("LD_", "LD_PRELOAD")],
    ["KUBECONFIG", reservedName("KUBECONFIG")],
    ["PATH", reservedName("PATH")],
    ["path", reservedName("path")],
    ["HTTPS_PROXY", reservedName("HTTPS_PROXY")],
  ]) {
    const reserved = await request(
      fixture.app,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        body: {
          kind: "agent",
          values: {},
          secretBindings: { [destination]: { source: localKey.data.ref } },
        },
      },
    );
    assert.equal(reserved.status, 400, destination);
    assert.equal(reserved.body.error.message, message, destination);
    assert.deepEqual(
      reserved.body.error.details,
      [{ path: `/secretBindings/${destination}`, code: "INVALID_VALUE" }],
      destination,
    );
    assert.doesNotMatch(
      JSON.stringify(reserved.body),
      new RegExp(localKey.data.ref.id),
      destination,
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

test("Contract messages give no bound hint for keywords inherited from Object.prototype", () => {
  for (const keyword of ["constructor", "toString", "__proto__"]) {
    const validation = Object.assign(new Error("body/x is invalid"), {
      statusCode: 400,
      validationContext: "body",
      validation: [
        {
          keyword,
          instancePath: "/x",
          schemaPath: `#/properties/x/${keyword}`,
          params: { limit: 1 },
        },
      ],
    });
    const failure = requestFailure(validation);
    assert.equal(failure.status, 400);
    assert.equal(
      failure.message,
      "The request does not match the operation contract: body /x has an unsupported value.",
    );
  }
});

/** Records gateway copies; OCC admission, IAM and the audit rows under test stay real. */
function createRecordingCredentialGateway() {
  const stored = new Map();
  return {
    id: "credential-gateway-secret-api",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    stored,
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ];
    },
    async registerSource(context, input) {
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async updateSource(context, input) {
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async rotateSource() {
      throw new Error("not exercised");
    },
    async sourceStatus(context) {
      return stored.has(context.source.id) ? { state: "ready" } : { state: "absent" };
    },
    async removeSource(context) {
      stored.delete(context.source.id);
    },
    async attachForRevision() {
      throw new Error("not exercised");
    },
    async attachmentStatus() {
      throw new Error("not exercised");
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  };
}

test("credential source writes commit one value-free audit row each", async () => {
  let now = Date.now();
  const fixture = await createFixture({
    now: () => new Date(now),
    computeDriver: {
      ...createReadyComputeDriver("compute-secret-api"),
      async resolveSandboxNamespace(namespace) {
        return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
      },
    },
  });
  const namespace = await bootstrapNamespace(fixture);
  const gateway = createRecordingCredentialGateway();
  fixture.controller().registerDriver(gateway);
  fixture.controller().selectDriver("credential_gateway", gateway.id);
  const value = `credential-source-value-${randomUUID()}`;
  const rotated = `credential-source-rotated-${randomUUID()}`;
  const secret = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Source key", value },
  });
  assert.equal(secret.status, 201);
  const sources = `/namespaces/${namespace.id}/credential-sources`;

  const created = await request(fixture.app, "POST", sources, {
    body: { name: "openai", type: "openai", secrets: { api_key: secret.data.ref } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(gateway.stored.get(created.data.id), { api_key: value });
  const updatedSecret = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${secret.data.id}`,
    { body: { value: rotated } },
  );
  assert.equal(updatedSecret.status, 200);
  const updated = await request(fixture.app, "PATCH", `${sources}/${created.data.id}`, {
    body: {},
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(gateway.stored.get(created.data.id), { api_key: rotated });
  // Past the registration fence: no timed-out registration could still create a gateway copy.
  now += 71_000;
  const deleted = await request(fixture.app, "DELETE", `${sources}/${created.data.id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(gateway.stored.has(created.data.id), false);

  const mutations = fixture.auditSink.events.filter(
    (event) => event.kind === "mutation" && event.resource.kind === "credential_source",
  );
  assert.deepEqual(
    mutations.map((event) => [event.action, event.resource]),
    ["create", "update", "delete"].map((verb) => [
      `openclaw.credential_sources.${verb}`,
      { kind: "credential_source", id: created.data.id, namespaceId: namespace.id },
    ]),
  );
  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(value), false);
  assert.equal(audit.includes(rotated), false);
});
