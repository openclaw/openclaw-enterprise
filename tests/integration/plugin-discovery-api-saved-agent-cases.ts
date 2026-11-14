import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  AgentPluginPolicyCapabilitiesResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { AuthorizationRequest } from "../../packages/contracts/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";
import {
  callerDenied,
  EMBEDDED_API_KEY_REQUIRED,
  GENERIC_DENIAL,
} from "../helpers/refusal-text.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  accessToken,
  catalogEntry,
  createDiscoveryConsole,
  createFixture,
  createSavedAgent,
  pluginDetails,
  remoteId,
  secretValueReadCount,
  type DiscoveryResponse,
  type ConsoleFixture,
} from "./plugin-discovery-api-fixture.ts";

export async function usesCurrentAgentSecret(t: TestContext) {
  const fixture = await createFixture(t);
  const { secret, path } = await createSavedAgent(fixture);

  // Search and pagination preserve Agent-owned credential authority on every read.
  const catalog = await fixture.request("POST", path, { body: { q: "linear" } });
  const page = fixture.fixtureResponse(
    catalog,
    200,
    AgentPluginCatalogResponse,
    "plugin catalog",
  ).data;
  assert.deepEqual(page, { plugins: [catalogEntry], nextCursor: "second-page" });
  const next = await fixture.request("POST", path, {
    body: {
      cursor: page.nextCursor,
      q: "linear",
    },
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(fixture.fixtureResponse(next, 200, AgentPluginCatalogResponse, "next").data, {
    plugins: [],
    nextCursor: null,
  });
  const details = await fixture.request("POST", `${path}/details`, {
    body: { pluginId: remoteId },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.deepEqual(
    fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data,
    pluginDetails,
  );
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
}

export async function requiresExactAgentAndSecretGrants(t: TestContext) {
  const fixture = await createFixture(t);
  const { agent, secret, path } = await createSavedAgent(fixture);
  const secretReadsBefore = secretValueReadCount(fixture.secretDriver);
  const actor = await fixture.createAccountWithPolicy("saved-plugin-editor", () => {});
  const session = await fixture.signIn(actor.credentials);
  const agentRole: ConsoleFixture["policy"]["roles"][number] = {
    id: `agent-plugin-editor-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "update", resourceKind: "agent" }],
  };
  const secretRole: ConsoleFixture["policy"]["roles"][number] = {
    id: `agent-plugin-source-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  fixture.policy.roles.push(agentRole, secretRole);
  bindRole(fixture.policy, actor.principal.id, {
    id: `binding-${agentRole.id}`,
    roleId: agentRole.id,
    namespaceId: fixture.namespace.id,
    resource: { kind: "agent", id: agent.id },
  });
  const actorSecretBinding: ConsoleFixture["policy"]["bindings"][number] = {
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

  async function expectDenied(
    action: AuthorizationRequest["action"],
    principalId: string,
    resource: AuthorizationRequest["resource"],
    message: string,
  ) {
    for (const [suffix, body] of [
      ["", {}],
      ["/details", { pluginId: remoteId }],
    ] as const) {
      const result = await fixture.request("POST", `${path}${suffix}`, { session, body });
      assertApiError(result, 403, "FORBIDDEN");
      assert.equal(
        fixture.fixtureResponse(result, 403, ErrorResponse, "plugin discovery refusal").error
          .message,
        message,
      );
      const denial = fixture.auditSink.events.at(-1);
      assert.ok(denial);
      assert.equal(denial.kind, "authorization_denial");
      assert.deepEqual(denial.authorization, { principalId, action, resource });
    }
    assert.deepEqual(fixture.calls, []);
    assert.equal(secretValueReadCount(fixture.secretDriver) - secretReadsBefore, 0);
  }

  // Each permission is checked independently before the stored PAT can reach the Plugin Driver.
  // The caller's own denials name the grant (finding 2534): the Agent by the ID the path sent, the
  // stored Secret by no ID.
  const agentRef: AuthorizationRequest["resource"] = {
    kind: "agent",
    id: agent.id,
    namespaceId: fixture.namespace.id,
  };
  await expectDenied(
    "read",
    actor.principal.id,
    agentRef,
    callerDenied("Agent read", `Agent ${agent.id}`),
  );
  agentRole.permissions = [{ action: "read", resourceKind: "agent" }];
  await expectDenied(
    "update",
    actor.principal.id,
    agentRef,
    callerDenied("Agent update", `Agent ${agent.id}`),
  );
  agentRole.permissions.push({ action: "update", resourceKind: "agent" });
  fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(actorSecretBinding), 1);
  await expectDenied(
    "operate",
    actor.principal.id,
    secret.ref,
    callerDenied("Secret operate", "a Secret this request uses"),
  );
  fixture.policy.bindings.push(actorSecretBinding);
  fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(agentSecretBinding), 1);
  // The request audit attributes the failed subordinate grant to the authenticated actor. The
  // Agent's own principal was denied, not the caller, so the text names no grant.
  await expectDenied("operate", actor.principal.id, secret.ref, GENERIC_DENIAL);
  fixture.policy.bindings.push(agentSecretBinding);

  const allowed = await fixture.request("POST", path, { session, body: {} });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(fixture.calls, [{ operation: "list", input: { accessToken } }]);
}

export async function rechecksAgentSecretGrant(t: TestContext) {
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
  assertApiError(denied, 403, "FORBIDDEN");
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.equal(
    JSON.stringify([denied.body, fixture.auditSink.events]).includes(accessToken),
    false,
  );
}

export async function refusesReplacedCredential(t: TestContext) {
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
  assert.ok(agentBinding);
  fixture.policy.bindings.push({
    ...agentBinding,
    id: `${agentBinding.id}-replacement`,
    resourceId: replacement.id,
  });
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let updated: DiscoveryResponse | undefined;
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
    fixture.fixtureResponse(changed, 409, ErrorResponse, "plugin discovery refusal").error.message,
    "The Agent's plugin credential or catalog changed. Refresh and retry.",
  );
  assert.deepEqual(fixture.calls, []);
}

export async function withholdsCredentialAfterHarnessChange(t: TestContext) {
  const fixture = await createFixture(t, { additionalPluginDriver: new OCCPluginDriver() });
  const { agent, path } = await createSavedAgent(fixture);
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let changed: DiscoveryResponse | undefined;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, async (value) => {
      changed = await fixture.request(
        "PATCH",
        `/namespaces/${fixture.namespace.id}/configurations/${agent.configurationId}`,
        {
          body: { values: createHarnessConfiguration("openclaw", "gpt-5.1") },
        },
      );
      return use(value);
    });
  const result = await fixture.request("POST", path, { body: {} });
  assert.equal(changed?.status, 200, JSON.stringify(changed?.body));
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual(fixture.calls, []);
}

export async function discardsResultAfterHarnessChange(t: TestContext) {
  let changed: DiscoveryResponse | undefined;
  const fixture = await createFixture(t, {
    additionalPluginDriver: new OCCPluginDriver(),
    onCatalogDetails: async () => {
      changed = await fixture.request(
        "PATCH",
        `/namespaces/${fixture.namespace.id}/configurations/${agent.configurationId}`,
        { body: { values: createHarnessConfiguration("openclaw", "gpt-5.1") } },
      );
    },
  });
  const { agent, path } = await createSavedAgent(fixture);
  const result = await fixture.request("POST", `${path}/details`, {
    body: { pluginId: catalogEntry.id },
  });
  assert.equal(changed?.status, 200, JSON.stringify(changed?.body));
  assert.deepEqual(
    fixture.calls.map(({ operation }) => operation),
    ["details"],
  );
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(
    fixture.fixtureResponse(result, 409, ErrorResponse, "plugin discovery refusal").error.message,
    "The Agent's plugin credential or catalog changed. Refresh and retry.",
  );
}

export async function rechecksCallerSecretGrant(t: TestContext) {
  const fixture = await createFixture(t);
  const { agent, secret, path } = await createSavedAgent(fixture);
  const actor = await fixture.createAccountWithPolicy("saved-plugin-revoked-editor", () => {});
  const session = await fixture.signIn(actor.credentials);
  const agentRole: ConsoleFixture["policy"]["roles"][number] = {
    id: `agent-plugin-editor-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "update", resourceKind: "agent" },
    ],
  };
  const secretRole: ConsoleFixture["policy"]["roles"][number] = {
    id: `agent-plugin-source-${randomUUID()}`,
    namespaceId: fixture.namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  fixture.policy.roles.push(agentRole, secretRole);
  const actorSecretBinding: ConsoleFixture["policy"]["bindings"][number] = {
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
  assertApiError(denied, 403, "FORBIDDEN");
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.auditSink.events.at(-1)?.authorization, {
    principalId: actor.principal.id,
    action: "operate",
    resource: secret.ref,
  });
}

export async function authorizesBeforeDriverSupport(t: TestContext) {
  const fixture = await createFixture(t, { supported: false });
  const { path } = await createSavedAgent(fixture);
  const secretReadsBefore = secretValueReadCount(fixture.secretDriver);
  const actor = await fixture.createAccountWithPolicy("ungranted-plugin-editor", () => {});
  const session = await fixture.signIn(actor.credentials);

  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const denied = await fixture.request("POST", `${path}${suffix}`, { session, body });
    assertApiError(denied, 403, "FORBIDDEN");
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(secretValueReadCount(fixture.secretDriver) - secretReadsBefore, 0);
}

export async function refusesUnsupportedAuthenticationAndMode(t: TestContext) {
  const fixture = await createFixture(t);
  const { path } = await createSavedAgent(fixture, "api_key");
  // A Service Accounts Secret on an embedded Agent never reaches stored discovery: Agent save
  // refuses the pair, as deployment does (finding 1117).
  const secret = await fixture.createSecret(fixture.namespace.id, "Embedded PAT", accessToken);
  const configuration = await fixture.createConfiguration(
    fixture.namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
  );
  const embedded = await fixture.request("POST", `/namespaces/${fixture.namespace.id}/agents`, {
    body: {
      name: `Embedded PAT Agent ${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "embedded",
      harnessAuth: { method: "codex_pat", source: secret.ref },
    },
  });
  assert.equal(embedded.status, 400, JSON.stringify(embedded.body));
  assert.equal(
    fixture.fixtureResponse(embedded, 400, ErrorResponse, "plugin discovery refusal").error.message,
    EMBEDDED_API_KEY_REQUIRED,
  );
  // Stored discovery reads only a Secret-backed PAT today, so a dedicated Codex Agent whose
  // PAT comes from a managed ServiceAccount is refused like the other unsupported sources.
  const account = await fixture.state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: fixture.namespace.id,
      name: `plugin-discovery-account-${randomUUID().slice(0, 8)}`,
    }),
  );
  const managed = await fixture.createAgent(
    fixture.namespace.id,
    `Managed PAT Agent ${randomUUID()}`,
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: {
        method: "codex_pat",
        source: {
          kind: "service_account",
          namespaceId: fixture.namespace.id,
          id: account.id,
        },
      },
    },
  );
  const managedPath = `/namespaces/${fixture.namespace.id}/agents/${managed.id}/plugins`;
  const secretReadsBefore = secretValueReadCount(fixture.secretDriver);
  for (const [prefix, suffix, body] of [
    [path, "", {}],
    [path, "/details", { pluginId: remoteId }],
    [managedPath, "", {}],
    [managedPath, "/details", { pluginId: remoteId }],
  ] as const) {
    const unsupported = await fixture.request("POST", `${prefix}${suffix}`, { body });
    assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body));
    assert.equal(
      fixture.fixtureResponse(unsupported, 501, ErrorResponse, "plugin discovery refusal").error
        .code,
      "NOT_IMPLEMENTED",
    );
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(secretValueReadCount(fixture.secretDriver) - secretReadsBefore, 0);
}

export async function usesCuratedCatalogForApiKeyAgent(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const fixture = await createDiscoveryConsole(t, { secretDriver });
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
  const secretReadsBefore = secretValueReadCount(secretDriver);
  const editor = await fixture.createAccountWithPolicy("curated-plugin-editor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "curated-plugin-editor-role",
      bindingId: "curated-plugin-editor-binding",
      namespaceId: namespace.id,
      permissions: { agent: ["read", "update"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const session = await fixture.signIn(editor.credentials);

  const installation = await fixture.request("GET", "/installation", { session });
  assert.equal(installation.status, 403, JSON.stringify(installation.body));
  const capabilities = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.equal(capabilities.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    fixture.fixtureResponse(
      capabilities,
      200,
      AgentPluginPolicyCapabilitiesResponse,
      "capabilities",
    ).data,
    {
      driver: { id: driver.id, implementation: driver.implementation },
      ...driver.policyCapabilities,
      discoveryCredential: "none",
    },
  );
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);

  // Agent read/update suffices for static discovery; no Secret operate grant or model-key read is used.
  const catalog = await fixture.request("POST", path, { session, body: {} });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const linear = fixture
    .fixtureResponse(catalog, 200, AgentPluginCatalogResponse, "plugin catalog")
    .data.plugins.find((entry) => entry.id === "codex-plugin:linear@openai-curated-remote");
  assert.equal(linear?.selectableWithoutTools, true);
  assert.ok(linear);
  const details = await fixture.request("POST", `${path}/details`, {
    session,
    body: { pluginId: linear.remoteId },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.deepEqual(
    fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data,
    linear,
  );
  // The id the list just returned names the same entry; it is not a plugin the Driver lacks.
  const byListedId = await fixture.request("POST", `${path}/details`, {
    session,
    body: { pluginId: linear.id },
  });
  assert.equal(byListedId.status, 200, JSON.stringify(byListedId.body));
  assert.deepEqual(
    fixture.fixtureResponse(byListedId, 200, AgentPluginDetailsResponse, "byListedId").data,
    linear,
  );
  // An id without its marketplace stays unknown, and the refusal names the listed id.
  const unversioned = await fixture.request("POST", `${path}/details`, {
    session,
    body: { pluginId: "codex-plugin:linear" },
  });
  assertApiError(unversioned, 400, "INVALID_REQUEST");
  assert.match(
    fixture.fixtureResponse(unversioned, 400, ErrorResponse, "plugin discovery refusal").error
      .message,
    /does not offer: codex-plugin:linear\. Use codex-plugin:linear@openai-curated-remote\.$/,
  );
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);

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
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);

  const role = fixture.policy.roles.find((item) => item.id === "curated-plugin-editor-role");
  assert.ok(role);
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
  assertApiError(deleting, 409, "AGENT_DELETING");
  const capabilitiesDeleting = await fixture.request("GET", `${path}/capabilities`, { session });
  assertApiError(capabilitiesDeleting, 409, "AGENT_DELETING");
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);
}

export async function readsHostedCapabilitiesWithoutSecret(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const fixture = await createDiscoveryConsole(t, { secretDriver });
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
    grantRole(fixture.policy, principal.id, {
      id: "hosted-policy-editor-role",
      bindingId: "hosted-policy-editor-binding",
      namespaceId: namespace.id,
      permissions: { agent: ["read", "update"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const session = await fixture.signIn(editor.credentials);
  const secretReadsBefore = secretValueReadCount(secretDriver);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;

  const installation = await fixture.request("GET", "/installation", { session });
  assert.equal(installation.status, 403, JSON.stringify(installation.body));
  const capabilities = await fixture.request("GET", `${path}/capabilities`, { session });
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.deepEqual(
    fixture.fixtureResponse(
      capabilities,
      200,
      AgentPluginPolicyCapabilitiesResponse,
      "capabilities",
    ).data,
    {
      driver: { id: driver.id, implementation: driver.implementation },
      ...driver.policyCapabilities,
      discoveryCredential: "required",
    },
  );
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);
  const catalog = await fixture.request("POST", path, { session, body: {} });
  assert.equal(catalog.status, 403, JSON.stringify(catalog.body));
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);
}
