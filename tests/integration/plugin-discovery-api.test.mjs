import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

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

async function createFixture(t, { supported = true } = {}) {
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const fixture = await createConsoleAppFixture(t, { state, auditSink });
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
