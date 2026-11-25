import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  AgentPluginPolicyCapabilitiesResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  accessToken,
  createDiscoveryConsole,
  createFixture,
  createSavedAgent,
  remoteId,
  secretValueReadCount,
} from "./plugin-discovery-api-fixture.ts";

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
  assert.equal(catalog.status, 409, JSON.stringify(catalog.body));
  assert.match(JSON.stringify(catalog.body), /Re-enroll a service account token/);
  assert.equal(secretValueReadCount(secretDriver) - secretReadsBefore, 0);
}
