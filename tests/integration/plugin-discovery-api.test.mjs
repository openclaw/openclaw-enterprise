import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { codexRuntimeArtifact } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState, PluginDiscoveryError } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

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

async function createSavedAgent(fixture, method = "codex_pat") {
  const secret = await fixture.createSecret(
    fixture.namespace.id,
    `Plugin discovery credential ${randomUUID()}`,
    accessToken,
  );
  const dedicated = method === "codex_pat";
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    `Stored credential Agent ${randomUUID()}`,
    createHarnessConfiguration(dedicated ? "codex" : "openclaw", "gpt-5.1"),
    {
      executionMode: dedicated ? "dedicated" : "embedded",
      harnessAuth: { method, source: secret.ref },
    },
  );
  if (method === "codex_pat") {
    grantAgentSecret(fixture, agent, secret);
  }
  return { agent, secret, path: `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins` };
}

// Runtime and discovery both need the Agent's own authority to operate its bound Secret.
function grantAgentSecret(fixture, agent, secret) {
  const roleId = `agent-plugin-secret-${randomUUID()}`;
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: fixture.namespace.id,
    agentId: agent.id,
  });
  fixture.policy.roles.push({
    id: roleId,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.policy.bindings.push({
    id: `binding-${roleId}`,
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId,
    resourceKind: "secret",
    resourceId: secret.id,
  });
}

function trackSecretValueReads(secretDriver) {
  const withValue = secretDriver.withValue.bind(secretDriver);
  let reads = 0;
  secretDriver.withValue = (secret, use) => {
    reads++;
    return withValue(secret, use);
  };
  return () => reads;
}

test("Plugin discovery uses the selected Driver through authenticated HTTP without creating resources", async (t) => {
  const fixture = await createFixture(t);
  const catalog = await fixture.request("POST", fixture.path, {
    body: { accessToken, q: "knowledge" },
  });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.deepEqual(catalog.data, { plugins: [catalogEntry], nextCursor: "second-page" });
  const next = await fixture.request("POST", fixture.path, {
    body: { accessToken, q: "knowledge", cursor: catalog.data.nextCursor },
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
    { operation: "list", input: { accessToken, q: "knowledge" } },
    { operation: "list", input: { accessToken, q: "knowledge", cursor: "second-page" } },
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
    ["", { accessToken, q: "x".repeat(1025) }],
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

test("Saved Agent plugin discovery uses its current Secret for catalog and tools without exposing the token", async (t) => {
  const fixture = await createFixture(t);
  const { secret, path } = await createSavedAgent(fixture);

  // Search and pagination preserve Agent-owned credential authority on every read.
  const catalog = await fixture.request("POST", path, { body: { q: "linear" } });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.deepEqual(catalog.data, { plugins: [catalogEntry], nextCursor: "second-page" });
  const next = await fixture.request("POST", path, {
    body: { cursor: catalog.data.nextCursor, q: "linear" },
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(next.data, { plugins: [], nextCursor: null });
  const details = await fixture.request("POST", `${path}/details`, {
    body: { pluginId: remoteId },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.deepEqual(details.data, pluginDetails);
  assert.deepEqual(fixture.calls, [
    { operation: "list", input: { accessToken, q: "linear" } },
    { operation: "list", input: { accessToken, cursor: "second-page", q: "linear" } },
    { operation: "details", input: { accessToken, pluginId: remoteId } },
  ]);

  const rotatedToken = `at-plugin-discovery-rotated-${randomUUID()}`;
  const rotated = await fixture.request(
    "PATCH",
    `/namespaces/${fixture.namespace.id}/secrets/${secret.id}`,
    { body: { value: rotatedToken } },
  );
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const refreshed = await fixture.request("POST", path, { body: {} });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(fixture.calls.at(-1), {
    operation: "list",
    input: { accessToken: rotatedToken },
  });
  assert.equal(
    JSON.stringify([
      catalog.body,
      next.body,
      details.body,
      refreshed.body,
      fixture.auditSink.events,
    ]).includes(accessToken),
    false,
  );
  assert.equal(
    JSON.stringify([rotated.body, refreshed.body, fixture.auditSink.events]).includes(rotatedToken),
    false,
  );

  // A stored-credential route must never accept caller-selected credential authority.
  const selected = await fixture.request("POST", path, {
    body: { accessToken: "at-caller-selected-credential" },
  });
  assert.equal(selected.status, 400);
  assert.equal(fixture.calls.length, 4);
});

test("Saved Agent plugin discovery requires exact Agent and Secret grants before credential use", async (t) => {
  const fixture = await createFixture(t);
  const { agent, secret, path } = await createSavedAgent(fixture);
  const secretReads = trackSecretValueReads(fixture.secretDriver);
  const actor = await fixture.createAccountWithPolicy("saved-plugin-editor", () => {});
  const session = await fixture.signIn(actor.credentials);
  const agentRole = {
    id: `agent-plugin-editor-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "update", resourceKind: "agent" }],
  };
  const secretRole = {
    id: `agent-plugin-source-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  fixture.policy.roles.push(agentRole, secretRole);
  fixture.policy.bindings.push({
    id: `binding-${agentRole.id}`,
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: actor.principal.id,
    roleId: agentRole.id,
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const actorSecretBinding = {
    id: `binding-${secretRole.id}`,
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: actor.principal.id,
    roleId: secretRole.id,
    resourceKind: "secret",
    resourceId: secret.id,
  };
  fixture.policy.bindings.push(actorSecretBinding);
  const agentSecretBinding = fixture.policy.bindings.find(
    (binding) =>
      binding.subjectId === agent.servicePrincipalId &&
      binding.resourceKind === "secret" &&
      binding.resourceId === secret.id,
  );
  assert.ok(agentSecretBinding);

  async function expectDenied(action, principalId, resource) {
    for (const [suffix, body] of [
      ["", {}],
      ["/details", { pluginId: remoteId }],
    ]) {
      const result = await fixture.request("POST", `${path}${suffix}`, { session, body });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.error.code, "FORBIDDEN");
      const denial = fixture.auditSink.events.at(-1);
      assert.equal(denial.kind, "authorization_denial");
      assert.deepEqual(denial.authorization, { principalId, action, resource });
    }
    assert.deepEqual(fixture.calls, []);
    assert.equal(secretReads(), 0);
  }

  // Each permission is checked independently before the stored PAT can reach the Plugin Driver.
  await expectDenied("read", actor.principal.id, {
    kind: "agent",
    id: agent.id,
    namespaceId: fixture.namespace.id,
  });
  agentRole.permissions = [{ action: "read", resourceKind: "agent" }];
  await expectDenied("update", actor.principal.id, {
    kind: "agent",
    id: agent.id,
    namespaceId: fixture.namespace.id,
  });
  agentRole.permissions.push({ action: "update", resourceKind: "agent" });
  fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(actorSecretBinding), 1);
  await expectDenied("operate", actor.principal.id, secret.ref);
  fixture.policy.bindings.push(actorSecretBinding);
  fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(agentSecretBinding), 1);
  // The request audit attributes the failed subordinate grant to the authenticated actor.
  await expectDenied("operate", actor.principal.id, secret.ref);
  fixture.policy.bindings.push(agentSecretBinding);

  const allowed = await fixture.request("POST", path, { session, body: {} });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(fixture.calls, [{ operation: "list", input: { accessToken } }]);
});

test("Saved Agent plugin discovery rechecks Secret authority after the backend read", async (t) => {
  const fixture = await createFixture(t);
  const { agent, secret, path } = await createSavedAgent(fixture);
  const bindingIndex = fixture.policy.bindings.findIndex(
    (binding) =>
      binding.subjectId === agent.servicePrincipalId &&
      binding.resourceKind === "secret" &&
      binding.resourceId === secret.id,
  );
  assert.notEqual(bindingIndex, -1);
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let secretReads = 0;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, (value) => {
      secretReads++;
      // Revoke consumption after the backend yields the value, before discovery uses it.
      fixture.policy.bindings.splice(bindingIndex, 1);
      return use(value);
    });

  const denied = await fixture.request("POST", path, { body: {} });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.equal(
    JSON.stringify([denied.body, fixture.auditSink.events]).includes(accessToken),
    false,
  );
});

test("Saved Agent plugin discovery refuses a credential replaced during the backend read", async (t) => {
  const fixture = await createFixture(t);
  const { agent, path } = await createSavedAgent(fixture);
  const replacement = await fixture.createSecret(
    fixture.namespace.id,
    "Replacement plugin credential",
    `${accessToken}-replacement`,
  );
  // Both the caller and the Agent may use the replacement, so only the identity check refuses.
  const agentBinding = fixture.policy.bindings.find(
    (binding) =>
      binding.subjectId === agent.servicePrincipalId && binding.resourceKind === "secret",
  );
  fixture.policy.bindings.push({
    ...agentBinding,
    id: `${agentBinding.id}-replacement`,
    resourceId: replacement.id,
  });
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let updated;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, async (value) => {
      if (!updated) {
        updated = await fixture.request(
          "PATCH",
          `/namespaces/${fixture.namespace.id}/agents/${agent.id}`,
          {
            body: {
              configurationId: agent.configurationId,
              harnessAuth: { method: "codex_pat", source: replacement.ref },
            },
          },
        );
      }
      return use(value);
    });

  const changed = await fixture.request("POST", path, { body: {} });
  assert.equal(updated?.status, 200, JSON.stringify(updated?.body));
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(
    changed.body.error.message,
    "The Agent's plugin credential changed. Refresh and retry.",
  );
  assert.deepEqual(fixture.calls, []);
});

test("Saved Agent plugin discovery rechecks the caller's Secret authority after the backend read", async (t) => {
  const fixture = await createFixture(t);
  const { agent, secret, path } = await createSavedAgent(fixture);
  const actor = await fixture.createAccountWithPolicy("saved-plugin-revoked-editor", () => {});
  const session = await fixture.signIn(actor.credentials);
  const agentRole = {
    id: `agent-plugin-editor-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "update", resourceKind: "agent" },
    ],
  };
  const secretRole = {
    id: `agent-plugin-source-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  fixture.policy.roles.push(agentRole, secretRole);
  const actorSecretBinding = {
    id: `binding-${secretRole.id}`,
    namespaceId: fixture.namespace.id,
    subjectKind: "identity",
    subjectId: actor.principal.id,
    roleId: secretRole.id,
    resourceKind: "secret",
    resourceId: secret.id,
  };
  fixture.policy.bindings.push(
    {
      id: `binding-${agentRole.id}`,
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: actor.principal.id,
      roleId: agentRole.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
    actorSecretBinding,
  );
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let secretReads = 0;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, (value) => {
      secretReads++;
      // Revoke only the caller's Secret grant after the backend yields the value; the
      // Agent's own grant stays, so only the caller's re-check can refuse.
      fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(actorSecretBinding), 1);
      return use(value);
    });

  const denied = await fixture.request("POST", path, { session, body: {} });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.auditSink.events.at(-1).authorization, {
    principalId: actor.principal.id,
    action: "operate",
    resource: secret.ref,
  });
});

test("Saved Agent plugin discovery denies unauthorized callers before reporting Driver support", async (t) => {
  const fixture = await createFixture(t, { supported: false });
  const { path } = await createSavedAgent(fixture);
  const secretReads = trackSecretValueReads(fixture.secretDriver);
  const actor = await fixture.createAccountWithPolicy("ungranted-plugin-editor", () => {});
  const session = await fixture.signIn(actor.credentials);

  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const denied = await fixture.request("POST", `${path}${suffix}`, { session, body });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "FORBIDDEN");
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(secretReads(), 0);
});

test("Saved Agent plugin discovery rejects unsupported Harness authentication or execution mode without reading credentials", async (t) => {
  const fixture = await createFixture(t);
  const { path } = await createSavedAgent(fixture, "api_key");
  // A Service Accounts Secret the Agent may operate is not enough; the Agent must also run
  // dedicated. If create-time admission starts refusing this combination, this case is moot.
  const secret = await fixture.createSecret(fixture.namespace.id, "Embedded PAT", accessToken);
  const embedded = await fixture.createAgent(
    fixture.namespace.id,
    `Embedded PAT Agent ${randomUUID()}`,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { executionMode: "embedded", harnessAuth: { method: "codex_pat", source: secret.ref } },
  );
  grantAgentSecret(fixture, embedded, secret);
  const embeddedPath = `/namespaces/${fixture.namespace.id}/agents/${embedded.id}/plugins`;
  const secretReads = trackSecretValueReads(fixture.secretDriver);
  for (const [prefix, suffix, body] of [
    [path, "", {}],
    [path, "/details", { pluginId: remoteId }],
    [embeddedPath, "", {}],
    [embeddedPath, "/details", { pluginId: remoteId }],
  ]) {
    const unsupported = await fixture.request("POST", `${prefix}${suffix}`, { body });
    assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body));
    assert.equal(unsupported.body.error.code, "NOT_IMPLEMENTED");
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(secretReads(), 0);
});

test("Saved Agent uses a credential-free curated catalog for an API-key Codex Agent", async (t) => {
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Curated Agent plugins", { ready: true });
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Curated API-key Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;
  const secretReads = trackSecretValueReads(secretDriver);
  const editor = await fixture.createAccountWithPolicy("curated-plugin-editor", (principal) => {
    fixture.policy.roles.push({
      id: "curated-plugin-editor-role",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "curated-plugin-editor-binding",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "curated-plugin-editor-role",
      resourceKind: "agent",
      resourceId: agent.id,
    });
  });
  const session = await fixture.signIn(editor.credentials);

  const installation = await fixture.request("GET", "/installation", { session });
  assert.equal(installation.status, 403, JSON.stringify(installation.body));
  const capabilities = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.equal(capabilities.headers.get("cache-control"), "no-store");
  assert.deepEqual(capabilities.data, {
    driver: { id: driver.id, implementation: driver.implementation },
    ...driver.policyCapabilities,
    discoveryCredential: "none",
  });
  assert.equal(secretReads(), 0);

  // Agent read/update suffices for static discovery; no Secret operate grant or model-key read is used.
  const catalog = await fixture.request("POST", path, { session, body: {} });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const linear = catalog.data.plugins.find(
    (entry) => entry.id === "codex-plugin:linear@openai-curated-remote",
  );
  assert.equal(linear?.selectableWithoutTools, true);
  const details = await fixture.request("POST", `${path}/details`, {
    session,
    body: { pluginId: linear.remoteId },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.deepEqual(details.data, linear);
  assert.equal(secretReads(), 0);

  const embedded = await fixture.createAgent(
    namespace.id,
    "Embedded Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { executionMode: "embedded" },
  );
  const unsupported = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${embedded.id}/plugins`,
    { body: {} },
  );
  assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body));
  assert.equal(secretReads(), 0);

  const role = fixture.policy.roles.find((item) => item.id === "curated-plugin-editor-role");
  role.permissions = [{ action: "read", resourceKind: "agent" }];
  const denied = await fixture.request("POST", path, { session, body: {} });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  const capabilitiesDenied = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilitiesDenied.status, 403, JSON.stringify(capabilitiesDenied.body));
  role.permissions.push({ action: "update", resourceKind: "agent" });
  const deletion = await fixture.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
  const deleting = await fixture.request("POST", `${path}/details`, {
    session,
    body: { pluginId: linear.remoteId },
  });
  assert.equal(deleting.status, 409, JSON.stringify(deleting.body));
  assert.equal(deleting.body.error.code, "AGENT_DELETING");
  const capabilitiesDeleting = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilitiesDeleting.status, 409, JSON.stringify(capabilitiesDeleting.body));
  assert.equal(capabilitiesDeleting.body.error.code, "AGENT_DELETING");
  assert.equal(secretReads(), 0);
});

test("Saved Agent hosted capabilities need Agent edit grants but no Secret access", async (t) => {
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Hosted Agent policy", { ready: true });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const secret = await fixture.createSecret(namespace.id, "Hosted Agent token", accessToken);
  const agent = await fixture.createAgent(
    namespace.id,
    "Hosted Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated", harnessAuth: { method: "codex_pat", source: secret.ref } },
  );
  const editor = await fixture.createAccountWithPolicy("hosted-policy-editor", (principal) => {
    fixture.policy.roles.push({
      id: "hosted-policy-editor-role",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "hosted-policy-editor-binding",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "hosted-policy-editor-role",
      resourceKind: "agent",
      resourceId: agent.id,
    });
  });
  const session = await fixture.signIn(editor.credentials);
  const secretReads = trackSecretValueReads(secretDriver);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;

  const installation = await fixture.request("GET", "/installation", { session });
  assert.equal(installation.status, 403, JSON.stringify(installation.body));
  const capabilities = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.deepEqual(capabilities.data, {
    driver: { id: driver.id, implementation: driver.implementation },
    ...driver.policyCapabilities,
    discoveryCredential: "required",
  });
  assert.equal(secretReads(), 0);
  const catalog = await fixture.request("POST", path, { session, body: {} });
  assert.equal(catalog.status, 403, JSON.stringify(catalog.body));
  assert.equal(secretReads(), 0);
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

test("Selected Secret discovery rechecks Secret authority after the backend read", async (t) => {
  const fixture = await createFixture(t);
  const secret = await fixture.createSecret(fixture.namespace.id, "revoked-pat", accessToken);
  const account = await fixture.createAccountWithPolicy("discovery-revoked", (principal) => {
    fixture.policy.roles.push({
      id: "revoked-discovery-agent-create",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "create", resourceKind: "agent" }],
    });
    fixture.policy.bindings.push({
      id: "revoked-discovery-agent-create-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "revoked-discovery-agent-create",
    });
    fixture.policy.roles.push({
      id: "revoked-discovery-secret-operator",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    fixture.policy.bindings.push({
      id: "revoked-discovery-secret-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "revoked-discovery-secret-operator",
      resourceKind: "secret",
      resourceId: secret.id,
    });
  });
  const session = await fixture.signIn(account.credentials);
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let secretReads = 0;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, (value) => {
      secretReads++;
      // Revoke the caller's Secret grant after the backend yields the value, before the
      // stored credential is sent to the external catalog.
      const index = fixture.policy.bindings.findIndex(
        (binding) => binding.id === "revoked-discovery-secret-binding",
      );
      if (index !== -1) {
        fixture.policy.bindings.splice(index, 1);
      }
      return use(value);
    });

  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { secretRef: secret.ref, ...extra },
    });
    // The first request reads the value and is then refused; the second is refused before it.
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "FORBIDDEN");
  }
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
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
  const catalogRequests = [];
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
      skills: [{ name: "knowledge-workflow" }],
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
    if (address.includes("plugins/list") || address.includes("plugins/search")) {
      const request = new URL(address);
      catalogRequests.push({ path: request.pathname, q: request.searchParams.get("q") });
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

  const list = await fixture.request("POST", fixture.path, {
    body: { secretRef: secret.ref, q: "fixture" },
  });
  assert.equal(list.status, 200);
  assert.equal(list.data.plugins[0].remoteId, "remote-fixture");
  assert.equal(list.data.plugins[0].available, true);
  assert.deepEqual(catalogRequests, [{ path: "/backend-api/ps/plugins/search", q: "fixture" }]);
  const details = await fixture.request("POST", `${fixture.path}/details`, {
    body: { secretRef: secret.ref, pluginId: "remote-fixture" },
  });
  assert.equal(details.status, 200);
  assert.equal(details.data.available, true);
  assert.equal(details.data.tools[0].id, "fixture-app/search");
  assert.ok(credentials.every((value) => value === accessToken));

  // Skills must not prevent a discovered plugin from entering a real Agent revision.
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "Knowledge agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const plugins = { [details.data.id]: { enabled: true } };
  await fixture.updateAgent(fixture.namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins,
  });
  const revision = await fixture.deployAgent(fixture.namespace.id, agent.id);
  assert.deepEqual(revision.plugins.plugins, plugins);

  // A discovered policy must reach the raw native tool despite its renamed prefix.
  const artifact = codexRuntimeArtifact(
    {
      [details.data.id]: {
        enabled: true,
        tools: { [details.data.tools[0].id]: { enabled: true, approval: "all_actions" } },
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
          skills: [{ name: "knowledge-workflow" }],
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
  // A reference to another Namespace breaks a static rule, so it is an invalid request with
  // that rule's message; a Secret this Namespace does not hold stays a not-found.
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    for (const [description, ref, status, code, message] of [
      [
        "cross-Namespace Secret",
        foreign.ref,
        400,
        "INVALID_REQUEST",
        "Secret references cannot cross Namespaces.",
      ],
      [
        "missing Secret",
        { ...foreign.ref, namespaceId: fixture.namespace.id },
        404,
        "NOT_FOUND",
        undefined,
      ],
    ]) {
      for (const field of ["secretRef", "oauthLogin"]) {
        const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
          body: { [field]: ref, ...extra },
        });
        const label = `${suffix || "list"} ${field}, ${description}: ${JSON.stringify(response.body)}`;
        assert.equal(response.status, status, label);
        assert.equal(response.body.error.code, code, label);
        if (message !== undefined) {
          assert.equal(response.body.error.message, message, label);
        }
      }
    }
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

test("Curated discovery admits plugins with skills without provider I/O and saves selections in a revision", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Curated plugins", { ready: true });
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const path = `/namespaces/${namespace.id}/agents/plugins`;

  // Permit the real HTTP fixture transport while making any discovery-service call fail.
  const fetch = globalThis.fetch;
  const externalRequests = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (new URL(url).hostname !== "127.0.0.1") {
      externalRequests.push(String(url));
      throw new Error("Curated discovery must not call an external service.");
    }
    return fetch(url, options);
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities.pluginDiscovery, { credential: "none" });
  const page = await fixture.request("POST", path, { body: {} });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.data.nextCursor, null);
  const linear = page.data.plugins.find(
    (entry) => entry.id === "codex-plugin:linear@openai-curated-remote",
  );
  assert.ok(linear);
  assert.equal(linear.remoteId, "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c");
  assert.equal(linear.tools, null);
  assert.equal(linear.selectableWithoutTools, true);
  const search = await fixture.request("POST", path, { body: { q: "  LiNeAr  " } });
  assert.equal(search.status, 200);
  assert.deepEqual(search.data.plugins, [linear]);
  assert.equal(search.data.nextCursor, null);
  const details = await fixture.request("POST", `${path}/details`, {
    body: { pluginId: linear.remoteId },
  });
  assert.equal(details.status, 200);
  assert.deepEqual(details.data, linear);
  const slack = page.data.plugins.find(
    (entry) => entry.id === "codex-plugin:slack@openai-curated-remote",
  );
  assert.ok(slack);
  const slackDetails = await fixture.request("POST", `${path}/details`, {
    body: { pluginId: slack.remoteId },
  });
  assert.equal(slackDetails.status, 200);
  assert.deepEqual(slackDetails.data, slack);
  const notion = page.data.plugins.find(
    (entry) => entry.id === "codex-plugin:notion@openai-curated-remote",
  );
  assert.ok(notion);
  assert.notEqual(notion.available, false);
  assert.equal(notion.selectableWithoutTools, true);
  assert.equal(
    (await fixture.request("POST", `${path}/details`, { body: { pluginId: "unknown" } })).status,
    503,
  );
  assert.equal((await fixture.request("POST", path, { body: { cursor: "unknown" } })).status, 503);

  // The exact selected ID and policy enter the real Agent and immutable revision path.
  const agent = await fixture.createAgent(
    namespace.id,
    "Linear agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const plugins = {
    [linear.id]: { enabled: true, toolDefaults: { approval: "write_actions", reviewer: "human" } },
    [slack.id]: { enabled: true, toolDefaults: { reviewer: "auto" } },
    [notion.id]: { enabled: true },
  };
  const updated = await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins,
  });
  assert.deepEqual(updated.plugins, plugins);
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.plugins.plugins, plugins);
  assert.deepEqual(revision.plugins.driver, {
    id: driver.id,
    implementation: driver.implementation,
  });
  assert.deepEqual(externalRequests, []);
});

test("Hosted discovery requires a credential, and curated discovery still requires Agent-create authorization", async (t) => {
  const fixture = await createFixture(t);
  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ]) {
    const missing = await fixture.request("POST", `${fixture.path}${suffix}`, { body });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED");
  }
  assert.deepEqual(fixture.calls, []);

  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const reader = await fixture.createAccountWithPolicy("curated-reader", (principal) => {
    fixture.policy.roles.push({
      id: "curated-reader-role",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "curated-reader-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "curated-reader-role",
    });
  });
  const session = await fixture.signIn(reader.credentials);
  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c" }],
  ]) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, { session, body });
    assert.equal(denied.status, 403);
  }
});
