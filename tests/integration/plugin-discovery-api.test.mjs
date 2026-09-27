import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { codexRuntimeArtifact } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState, PluginDiscoveryError } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const accessToken = "at-plugin-discovery-private-fixture";
const pluginId = "codex-plugin:knowledge@openai-remote";
const remoteId = "remote-knowledge";
const catalogEntry = {
  id: pluginId,
  remoteId,
  name: "Knowledge",
  description: "Search shared knowledge.",
  available: true,
  tools: null,
};
const pluginDetails = {
  ...catalogEntry,
  tools: [
    {
      id: "app_knowledge/search",
      name: "Search",
      ownerId: "app_knowledge",
      description: "Search knowledge documents.",
      available: false,
      unavailableReason: "Connect an account to use this tool.",
    },
  ],
};

async function createFixture(
  t,
  { supported = true, secretDriver = createTestSecretDriver(), logger } = {},
) {
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const fixture = await createConsoleAppFixture(t, { state, auditSink, secretDriver, logger });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Plugin discovery", { ready: true });
  const calls = [];
  let failure;
  // Only the external Driver boundary is controlled: HTTP, IAM and OCC remain real.
  const driver = {
    id: "plugin-discovery-test",
    capability: "plugin",
    implementation: "test-plugin-catalog",
    async listCatalog() {
      throw new Error("Credential discovery must not use the runtime catalog.");
    },
    ...(supported
      ? {
          async discoverCatalog(input) {
            calls.push({ operation: "list", input });
            if (failure) {
              throw failure;
            }
            return {
              plugins: input.cursor ? [] : [catalogEntry],
              nextCursor: input.cursor ? null : "second-page",
            };
          },
          async getCatalogPlugin(input) {
            calls.push({ operation: "details", input });
            if (failure) {
              throw failure;
            }
            return pluginDetails;
          },
        }
      : {}),
  };
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  return {
    ...fixture,
    namespace,
    calls,
    auditSink,
    secretDriver,
    path: `/namespaces/${namespace.id}/agents/plugins`,
    failWith(error) {
      failure = error;
    },
  };
}

test("Plugin discovery uses the selected Driver through authenticated HTTP without creating resources", async (t) => {
  const fixture = await createFixture(t);
  const catalog = await fixture.request("POST", fixture.path, { body: { accessToken } });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.deepEqual(catalog.data, { plugins: [catalogEntry], nextCursor: "second-page" });
  const next = await fixture.request("POST", fixture.path, {
    body: { accessToken, cursor: catalog.data.nextCursor },
  });
  assert.equal(next.status, 200);
  assert.deepEqual(next.data, { plugins: [], nextCursor: null });
  const details = await fixture.request("POST", `${fixture.path}/details`, {
    body: { accessToken, pluginId: remoteId },
  });
  assert.equal(details.status, 200);
  assert.equal(details.headers.get("cache-control"), "no-store");
  assert.deepEqual(details.data, pluginDetails);
  assert.deepEqual(fixture.calls, [
    { operation: "list", input: { accessToken } },
    { operation: "list", input: { accessToken, cursor: "second-page" } },
    { operation: "details", input: { accessToken, pluginId: remoteId } },
  ]);
  assert.deepEqual(
    await fixture.controller.transact(async (unit) => ({
      agents: await unit.namespaces.hasAgents(fixture.namespace.id),
      configurations: await unit.namespaces.hasConfigurations(fixture.namespace.id),
      secrets: await unit.namespaces.hasSecrets(fixture.namespace.id),
      serviceAccounts: await unit.serviceAccounts.listServiceAccounts(fixture.namespace.id),
    })),
    { agents: false, configurations: false, secrets: false, serviceAccounts: [] },
  );
  assert.equal(
    JSON.stringify([catalog.body, details.body, fixture.auditSink.events]).includes(accessToken),
    false,
  );
});

test("Plugin discovery requires exact Namespace Agent-create permission before Driver I/O", async (t) => {
  const fixture = await createFixture(t);
  const reader = await fixture.createAccountWithPolicy("plugin-reader", (principal) => {
    fixture.policy.roles.push({
      id: "plugin-reader-role",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "plugin-reader-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "plugin-reader-role",
    });
  });
  const session = await fixture.signIn(reader.credentials);
  for (const [suffix, body] of [
    ["", { accessToken }],
    ["/details", { accessToken, pluginId: remoteId }],
  ]) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, { session, body });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");
  }
  assert.deepEqual(fixture.calls, []);
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.principal.id,
    action: "create",
    resource: { kind: "agent", id: fixture.namespace.id, namespaceId: fixture.namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(accessToken), false);

  fixture.policy.roles.at(-1).permissions.push({ action: "create", resourceKind: "agent" });
  const granted = await fixture.request("POST", fixture.path, { session, body: { accessToken } });
  assert.equal(granted.status, 200);
  fixture.calls.length = 0;
  const absent = await fixture.request("POST", `/namespaces/ns_${randomUUID()}/agents/plugins`, {
    body: { accessToken },
  });
  assert.equal(absent.status, 404);
  assert.deepEqual(fixture.calls, []);
});

test("Plugin discovery validates bounded credential and identity input before Driver I/O", async (t) => {
  const fixture = await createFixture(t);
  for (const [suffix, body] of [
    ["", { accessToken: "" }],
    ["", { accessToken: "x".repeat(16385) }],
    ["", { accessToken, cursor: "x".repeat(8193) }],
    ["", { accessToken, accountId: "caller-supplied-authority" }],
    ["/details", { accessToken, pluginId: "" }],
    ["/details", { accessToken, pluginId: "x".repeat(257) }],
  ]) {
    const invalid = await fixture.request("POST", `${fixture.path}${suffix}`, { body });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(invalid.body).includes(accessToken), false);
  }
  assert.deepEqual(fixture.calls, []);
});

test("Plugin discovery preserves safe failure reasons and suppresses upstream errors", async (t) => {
  const fixture = await createFixture(t);
  for (const [error, status, code] of [
    [
      new PluginDiscoveryError("credentials_rejected"),
      400,
      "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
    ],
    [new PluginDiscoveryError("rate_limited"), 429, "PLUGIN_DISCOVERY_RATE_LIMITED"],
    [new PluginDiscoveryError("invalid_response"), 503, "PLUGIN_DISCOVERY_INVALID_RESPONSE"],
    [new PluginDiscoveryError("unavailable"), 503, "PLUGIN_DISCOVERY_UNAVAILABLE"],
    [new Error(`private upstream failure ${accessToken}`), 503, "PLUGIN_DISCOVERY_UNAVAILABLE"],
  ]) {
    fixture.failWith(error);
    for (const [suffix, body] of [
      ["", { accessToken }],
      ["/details", { accessToken, pluginId: remoteId }],
    ]) {
      const failed = await fixture.request("POST", `${fixture.path}${suffix}`, { body });
      assert.equal(failed.status, status);
      assert.equal(failed.body.error.code, code);
      assert.doesNotMatch(JSON.stringify(failed.body), /private upstream|at-plugin-discovery/);
    }
  }
});

test("Plugin discovery reports unsupported selected Drivers without attempting runtime discovery", async (t) => {
  const fixture = await createFixture(t, { supported: false });
  for (const [suffix, body] of [
    ["", { accessToken }],
    ["/details", { accessToken, pluginId: remoteId }],
  ]) {
    const unsupported = await fixture.request("POST", `${fixture.path}${suffix}`, { body });
    assert.equal(unsupported.status, 501);
    assert.equal(unsupported.body.error.code, "NOT_IMPLEMENTED");
  }
  assert.deepEqual(fixture.calls, []);
});

test("Unsupported discovery still authorizes the exact selected Secret before capability errors", async (t) => {
  const fixture = await createFixture(t, { supported: false });
  const secret = await fixture.createSecret(fixture.namespace.id, "selected-pat", accessToken);
  const account = await fixture.createAccountWithPolicy(
    "unsupported-discovery-creator",
    (principal) => {
      fixture.policy.roles.push({
        id: "unsupported-discovery-agent-create",
        namespaceId: fixture.namespace.id,
        permissions: [{ action: "create", resourceKind: "agent" }],
      });
      fixture.policy.bindings.push({
        id: "unsupported-discovery-agent-create-binding",
        namespaceId: fixture.namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "unsupported-discovery-agent-create",
      });
    },
  );
  const session = await fixture.signIn(account.credentials);
  // An unsupported PluginDriver must never ask the Secret backend for the value.
  fixture.secretDriver.withValue = async () => {
    throw new Error("Unexpected Secret value read");
  };
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { secretRef: secret.ref, ...extra },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(fixture.auditSink.events.at(-1).authorization, {
      principalId: account.principal.id,
      action: "operate",
      resource: secret.ref,
    });
    assert.equal(fixture.auditSink.events.at(-1).kind, "authorization_denial");
  }
  fixture.policy.roles.push({
    id: "unsupported-discovery-secret-operator",
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.policy.bindings.push({
    id: "unsupported-discovery-secret-binding",
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: account.principal.id,
    roleId: "unsupported-discovery-secret-operator",
    resourceKind: "secret",
    resourceId: secret.id,
  });
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const unsupported = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { secretRef: secret.ref, ...extra },
    });
    assert.equal(unsupported.status, 501);
    assert.equal(unsupported.body.error.code, "NOT_IMPLEMENTED");
  }
});

test("Plugin discovery uses an authorized same-Namespace Secret for catalog and details", async (t) => {
  const fixture = await createFixture(t);
  const stored = await fixture.request("POST", `/namespaces/${fixture.namespace.id}/secrets`, {
    body: { name: "discovery-pat", value: accessToken },
  });
  assert.equal(stored.status, 201);
  for (const [suffix, extra, expected] of [
    ["", {}, { plugins: [catalogEntry], nextCursor: "second-page" }],
    ["/details", { pluginId: remoteId }, pluginDetails],
  ]) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { secretRef: stored.data.ref, ...extra },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, expected);
    assert.equal(JSON.stringify(response.body).includes(accessToken), false);
  }
  assert.deepEqual(fixture.calls, [
    { operation: "list", input: { accessToken } },
    { operation: "details", input: { accessToken, pluginId: remoteId } },
  ]);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
});

test("Selected Secret discovery reaches the hosted provider with the current credential", async (t) => {
  const logs = [];
  const logger = createOccLogger({
    component: "plugin-discovery-test",
    destination: {
      write(chunk) {
        logs.push(String(chunk));
        return true;
      },
    },
  });
  const fixture = await createFixture(t, { logger });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const secret = await fixture.createSecret(fixture.namespace.id, "hosted-pat", accessToken);
  const rotated = "at-rotated-private-fixture";
  const originalFetch = globalThis.fetch;
  const credentials = [];
  let echoCredential = false;
  const plugin = {
    id: "remote-fixture",
    name: "fixture",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Fixture",
      description: "Hosted fixture",
      interface: {},
      requires_local_executor: false,
      app_ids: ["fixture-app"],
      app_manifest: null,
      skills: [],
      mcp_servers: [],
    },
  };
  // Replace only provider HTTP; the actual routes, IAM, Secret and Plugin Drivers execute.
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const address = String(url);
    if (
      !address.startsWith("https://auth.openai.com/") &&
      !address.startsWith("https://chatgpt.com/backend-api/ps/")
    ) {
      return originalFetch(url, init);
    }
    const token = init.headers.Authorization.slice("Bearer ".length);
    credentials.push(token);
    if (token === "at-revoked-private-fixture") {
      return Response.json({ error: token }, { status: 401 });
    }
    if (address.includes("/whoami")) {
      return Response.json({
        chatgpt_account_id: "account-fixture",
        chatgpt_account_is_fedramp: false,
      });
    }
    assert.equal(init.headers["ChatGPT-Account-ID"], "account-fixture");
    if (address.includes("plugins/list")) {
      return Response.json({
        plugins: [
          {
            ...plugin,
            release: { ...plugin.release, display_name: echoCredential ? token : "Fixture" },
          },
        ],
        pagination: { next_page_token: null },
      });
    }
    if (address.includes("plugins/remote-fixture")) {
      return Response.json({
        ...plugin,
        release: { ...plugin.release, display_name: echoCredential ? token : "Fixture" },
      });
    }
    assert.ok(address.endsWith("apps/batch"));
    return Response.json({
      apps: [
        {
          id: "fixture-app",
          status: "ENABLED",
          tools: [{ name: "search", title: "Search", is_enabled: true, is_read_only: true }],
        },
      ],
    });
  });

  const list = await fixture.request("POST", fixture.path, { body: { secretRef: secret.ref } });
  assert.equal(list.status, 200);
  assert.equal(list.data.plugins[0].remoteId, "remote-fixture");
  const details = await fixture.request("POST", `${fixture.path}/details`, {
    body: { secretRef: secret.ref, pluginId: "remote-fixture" },
  });
  assert.equal(details.status, 200);
  assert.equal(details.data.tools[0].id, "fixture-app/search");
  assert.ok(credentials.every((value) => value === accessToken));

  // A discovered policy must reach the raw native tool despite its renamed prefix.
  const artifact = codexRuntimeArtifact(
    {
      [details.data.id]: {
        enabled: true,
        tools: { [details.data.tools[0].id]: { enabled: true, approval: "prompt" } },
      },
    },
    [
      {
        plugin: {
          summary: {
            id: "fixture@openai-curated-remote",
            remotePluginId: plugin.id,
            version: "1.0.0",
          },
          apps: [{ id: "fixture-app" }],
          skills: [],
          hooks: [],
          mcpServers: [],
        },
      },
    ],
    [],
    [
      {
        name: "codex_apps",
        tools: {
          "renamed_123.search": {
            name: "renamed_123.search",
            inputSchema: { type: "object", properties: {} },
            _meta: {
              connector_id: "fixture-app",
              _codex_apps: { resource_uri: "/fixture-app/link_fixture/search" },
            },
          },
        },
      },
    ],
  );
  assert.deepEqual(artifact.configuration.apps["fixture-app"].tools, {
    "renamed_123.search": { enabled: true, approval_mode: "prompt" },
  });

  // Rotation is observed by the next request without persisting the old or new value in discovery state.
  const updatePath = `/namespaces/${fixture.namespace.id}/secrets/${secret.id}`;
  assert.equal(
    (await fixture.request("PATCH", updatePath, { body: { value: rotated } })).status,
    200,
  );
  credentials.length = 0;
  assert.equal(
    (await fixture.request("POST", fixture.path, { body: { secretRef: secret.ref } })).status,
    200,
  );
  assert.ok(credentials.length > 0 && credentials.every((value) => value === rotated));

  echoCredential = true;
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: "remote-fixture" }],
  ]) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { secretRef: secret.ref, ...extra },
    });
    assert.equal(response.body.error.code, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
    assert.equal(JSON.stringify(response.body).includes(rotated), false);
  }
  echoCredential = false;
  for (const [value, code] of [
    ["not-a-pat", "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED"],
    ["at-revoked-private-fixture", "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED"],
  ]) {
    assert.equal((await fixture.request("PATCH", updatePath, { body: { value } })).status, 200);
    const response = await fixture.request("POST", fixture.path, {
      body: { secretRef: secret.ref },
    });
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes(value), false);
  }
  const persisted = await fixture.controller.transact((unit) =>
    unit.secrets.findSecret(fixture.namespace.id, secret.id),
  );
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /at-plugin-discovery-private-fixture|at-rotated-private-fixture|at-revoked-private-fixture/,
  );
  const deletion = await fixture.rawRequest("DELETE", updatePath, {
    headers: authenticatedHeaders(await fixture.signIn()),
  });
  assert.equal(deletion.response.status, 204);
  const deleted = await fixture.request("POST", fixture.path, { body: { secretRef: secret.ref } });
  assert.equal(deleted.status, 404);
  assert.doesNotMatch(
    JSON.stringify([list.body, details.body, deleted.body, fixture.auditSink.events, logs]),
    /at-plugin-discovery-private-fixture|at-rotated-private-fixture|at-revoked-private-fixture/,
  );
});

test("Selected Secret discovery requires exact Secret operate permission and same-Namespace ownership", async (t) => {
  const fixture = await createFixture(t);
  const secret = await fixture.createSecret(fixture.namespace.id, "selected-pat", accessToken);
  const another = await fixture.createSecret(
    fixture.namespace.id,
    "other-pat",
    "at-other-private-fixture",
  );
  const otherNamespace = await fixture.createNamespace("Other Namespace", { ready: true });
  const foreign = await fixture.createSecret(
    otherNamespace.id,
    "foreign-pat",
    "at-foreign-private-fixture",
  );
  const account = await fixture.createAccountWithPolicy("discovery-creator", (principal) => {
    fixture.policy.roles.push({
      id: "discovery-agent-create",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "create", resourceKind: "agent" }],
    });
    fixture.policy.bindings.push({
      id: "discovery-agent-create-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "discovery-agent-create",
    });
  });
  const session = await fixture.signIn(account.credentials);
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { secretRef: secret.ref, ...extra },
    });
    assert.equal(denied.status, 403);
    const evidence = fixture.auditSink.events.at(-1);
    assert.equal(evidence.kind, "authorization_denial");
    assert.deepEqual(evidence.authorization, {
      principalId: account.principal.id,
      action: "operate",
      resource: secret.ref,
    });
  }
  assert.deepEqual(fixture.calls, []);
  fixture.policy.roles.push({
    id: "selected-secret-operator",
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.policy.bindings.push({
    id: "selected-secret-binding",
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: account.principal.id,
    roleId: "selected-secret-operator",
    resourceKind: "secret",
    resourceId: secret.id,
  });
  assert.equal(
    (await fixture.request("POST", fixture.path, { session, body: { secretRef: secret.ref } }))
      .status,
    200,
  );
  assert.equal(
    (await fixture.request("POST", fixture.path, { session, body: { secretRef: another.ref } }))
      .status,
    403,
  );
  fixture.calls.length = 0;
  for (const ref of [foreign.ref, { ...foreign.ref, namespaceId: fixture.namespace.id }]) {
    const response = await fixture.request("POST", fixture.path, { body: { secretRef: ref } });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(fixture.calls, []);
  for (const body of [
    { accessToken, secretRef: secret.ref },
    { secretRef: secret.ref, accountId: "untrusted" },
  ]) {
    assert.equal((await fixture.request("POST", fixture.path, { body })).status, 400);
  }
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
});

test("Selected Secret backend failures suppress sensitive error details", async (t) => {
  const secretDriver = createTestSecretDriver();
  const fixture = await createFixture(t, { secretDriver });
  const secret = await fixture.createSecret(fixture.namespace.id, "unavailable-pat", accessToken);
  secretDriver.withValue = async () => {
    throw new Error(`inaccessible ${accessToken}`);
  };
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { secretRef: secret.ref, ...extra },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(response.body), /inaccessible|at-plugin-discovery/);
  }
  assert.deepEqual(fixture.calls, []);
  delete secretDriver.withValue;
  const unsupported = await fixture.request("POST", fixture.path, {
    body: { secretRef: secret.ref },
  });
  assert.equal(unsupported.status, 503);
  assert.equal(
    (await fixture.request("POST", fixture.path, { body: { accessToken } })).status,
    200,
  );
});
