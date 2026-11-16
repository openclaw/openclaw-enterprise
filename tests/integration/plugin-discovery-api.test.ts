import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { PluginDiscoveryError } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import {
  accessToken,
  catalogEntry,
  createDiscoveryLogger,
  createFixture,
  pluginDetails,
  remoteId,
} from "./plugin-discovery-api-fixture.ts";
import {
  honorsDisconnectsDuringIam,
  rechecksCredentialSourceGrants,
} from "./plugin-discovery-api-disconnect-cases.ts";
import {
  usesCurrentAgentSecret,
  requiresExactAgentAndSecretGrants,
  rechecksAgentSecretGrant,
  refusesReplacedCredential,
  withholdsCredentialAfterHarnessChange,
  discardsResultAfterHarnessChange,
  rechecksCallerSecretGrant,
  authorizesBeforeDriverSupport,
  refusesUnsupportedAuthenticationAndMode,
  usesCuratedCatalogForApiKeyAgent,
  readsHostedCapabilitiesWithoutSecret,
} from "./plugin-discovery-api-saved-agent-cases.ts";
import {
  authorizesSelectedSecretBeforeDriverSupport,
  rechecksSelectedSecretGrant,
  usesSameNamespaceSecret,
  usesCurrentHostedCredential,
  requiresExactSecretGrantAndOwnership,
  suppressesSecretBackendErrors,
} from "./plugin-discovery-api-selected-secret-cases.ts";
import {
  usesEachHarnessCatalog,
  savesCuratedSelectionsInRevision,
  requiresHostedCredentialAndCuratedGrant,
} from "./plugin-discovery-api-catalog-cases.ts";

test(
  "Plugin discovery uses the selected Driver through authenticated HTTP without creating resources",
  usesSelectedDriver,
);
test(
  "Plugin discovery requires exact Namespace Agent-create permission before Driver I/O",
  requiresExactAgentCreate,
);
test(
  "Hosted plugin discovery honors client disconnects during IAM reads",
  { timeout: 30_000 },
  honorsDisconnectsDuringIam,
);
test(
  "Plugin discovery validates bounded credential and identity input before Driver I/O",
  validatesCredentialAndIdentity,
);
test(
  "Plugin discovery preserves safe failure reasons and suppresses upstream errors",
  preservesSafeFailures,
);
test(
  "Plugin discovery reports unsupported selected Drivers without attempting runtime discovery",
  reportsUnsupportedDriver,
);
test(
  "Saved Agent plugin discovery uses its current Secret for catalog and tools without exposing the token",
  usesCurrentAgentSecret,
);
test(
  "Saved Agent plugin discovery requires exact Agent and Secret grants before credential use",
  requiresExactAgentAndSecretGrants,
);
test(
  "Saved Agent source discovery denies missing grants and rechecks revocation after retrieval",
  rechecksCredentialSourceGrants,
);
test(
  "Saved Agent plugin discovery rechecks Secret authority after the backend read",
  rechecksAgentSecretGrant,
);
test(
  "Saved Agent plugin discovery refuses a credential replaced during the backend read",
  refusesReplacedCredential,
);
test(
  "Changing a saved Agent's configured Harness during discovery withholds the old catalog credential",
  withholdsCredentialAfterHarnessChange,
);
test(
  "Saved Agent discovery discards a hosted result after the Agent changes Harness",
  discardsResultAfterHarnessChange,
);
test(
  "Saved Agent plugin discovery rechecks the caller's Secret authority after the backend read",
  rechecksCallerSecretGrant,
);
test(
  "Saved Agent plugin discovery denies unauthorized callers before reporting Driver support",
  authorizesBeforeDriverSupport,
);
test(
  "Saved Agent plugin discovery rejects unsupported Harness authentication or execution mode without reading credentials",
  refusesUnsupportedAuthenticationAndMode,
);
test(
  "Saved Agent uses a credential-free curated catalog for an API-key Codex Agent",
  usesCuratedCatalogForApiKeyAgent,
);
test(
  "Saved Agent hosted capabilities need Agent edit grants but no Secret access",
  readsHostedCapabilitiesWithoutSecret,
);
test(
  "Unsupported discovery still authorizes the exact selected Secret before capability errors",
  authorizesSelectedSecretBeforeDriverSupport,
);
test(
  "Selected Secret discovery rechecks Secret authority after the backend read",
  rechecksSelectedSecretGrant,
);
test(
  "Plugin discovery uses an authorized same-Namespace Secret for catalog and details",
  usesSameNamespaceSecret,
);
test(
  "Selected Secret discovery reaches the hosted provider with the current credential",
  usesCurrentHostedCredential,
);
test(
  "Selected Secret discovery requires exact Secret operate permission and same-Namespace ownership",
  requiresExactSecretGrantAndOwnership,
);
test(
  "Selected Secret backend failures suppress sensitive error details",
  suppressesSecretBackendErrors,
);
test(
  "Mixed Installation targets each Harness catalog before reading a discovery Secret",
  usesEachHarnessCatalog,
);
test(
  "Curated discovery admits plugins with skills without provider I/O and saves selections in a revision",
  savesCuratedSelectionsInRevision,
);
test(
  "Hosted discovery requires a credential, and curated discovery still requires Agent-create authorization",
  requiresHostedCredentialAndCuratedGrant,
);

async function usesSelectedDriver(t: TestContext) {
  const fixture = await createFixture(t);
  const catalog = await fixture.request("POST", fixture.path, {
    body: { harnessId: "codex", accessToken, q: "knowledge" },
  });
  const firstPage = fixture.fixtureResponse(
    catalog,
    200,
    AgentPluginCatalogResponse,
    "catalog",
  ).data;
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.deepEqual(firstPage, { plugins: [catalogEntry], nextCursor: "second-page" });
  const next = await fixture.request("POST", fixture.path, {
    body: { harnessId: "codex", accessToken, q: "knowledge", cursor: firstPage.nextCursor },
  });
  assert.equal(next.status, 200);
  assert.deepEqual(fixture.fixtureResponse(next, 200, AgentPluginCatalogResponse, "next").data, {
    plugins: [],
    nextCursor: null,
  });
  const details = await fixture.request("POST", `${fixture.path}/details`, {
    body: { harnessId: "codex", accessToken, pluginId: remoteId },
  });
  assert.equal(details.status, 200);
  assert.equal(details.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data,
    pluginDetails,
  );
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
}

async function requiresExactAgentCreate(t: TestContext) {
  const fixture = await createFixture(t);
  const reader = await fixture.createAccountWithPolicy("plugin-reader", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "plugin-reader-role",
      bindingId: "plugin-reader-binding",
      namespaceId: fixture.namespace.id,
      permissions: { namespace: ["read"] },
      resource: undefined,
    });
  });
  const session = await fixture.signIn(reader.credentials);
  for (const [suffix, body] of [
    ["", { accessToken }],
    ["/details", { accessToken, pluginId: remoteId }],
  ] as const) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", ...body },
    });
    assertApiError(denied, 403, "FORBIDDEN");
  }
  assert.deepEqual(fixture.calls, []);
  const denial = fixture.auditSink.events.at(-1);
  assert.ok(denial);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.principal.id,
    action: "create",
    resource: { kind: "agent", id: fixture.namespace.id, namespaceId: fixture.namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(accessToken), false);

  const readerRole = fixture.policy.roles.find(({ id }) => id === "plugin-reader-role");
  assert.ok(readerRole);
  readerRole.permissions.push({ action: "create", resourceKind: "agent" });
  const granted = await fixture.request("POST", fixture.path, {
    session,
    body: { harnessId: "codex", accessToken },
  });
  assert.equal(granted.status, 200);
  fixture.calls.length = 0;
  const absent = await fixture.request("POST", `/namespaces/ns_${randomUUID()}/agents/plugins`, {
    body: { harnessId: "codex", accessToken },
  });
  assert.equal(absent.status, 404);
  assert.deepEqual(fixture.calls, []);
}

async function validatesCredentialAndIdentity(t: TestContext) {
  const { logger, logs } = createDiscoveryLogger();
  const fixture = await createFixture(t, { logger });
  const wrongKind = {
    kind: "secrets",
    namespaceId: fixture.namespace.id,
    id: `sec_${randomUUID()}`,
  };
  // The body is a union of credential shapes without a shared literal field. Only the shape
  // whose fields the body uses is reported: the other shapes' required fields and the fields
  // they do not accept are not, and a wrong literal nested inside the field stays that
  // field's own problem.
  for (const [suffix, body, details] of [
    ["", { accessToken: "" }, [{ path: "/accessToken", code: "INVALID_VALUE" }]],
    ["", { accessToken: "x".repeat(16385) }, [{ path: "/accessToken", code: "TOO_LONG" }]],
    ["", { accessToken, cursor: "x".repeat(8193) }, [{ path: "/cursor", code: "TOO_LONG" }]],
    ["", { accessToken, q: "x".repeat(1025) }, [{ path: "/q", code: "TOO_LONG" }]],
    ["", { accessToken, accountId: "caller-supplied-authority" }, undefined],
    ["", { secretRef: wrongKind }, [{ path: "/secretRef/kind", code: "INVALID_VALUE" }]],
    ["/details", { accessToken, pluginId: "" }, [{ path: "/pluginId", code: "INVALID_VALUE" }]],
    [
      "/details",
      { accessToken, pluginId: "x".repeat(257) },
      [{ path: "/pluginId", code: "TOO_LONG" }],
    ],
  ] as const) {
    const invalid = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", ...body },
    });
    const label = `${suffix || "list"} ${JSON.stringify(Object.keys(body))}: ${JSON.stringify(invalid.body)}`;
    assert.equal(invalid.status, 400, label);
    if (details !== undefined) {
      assert.deepEqual(
        fixture.fixtureResponse(invalid, 400, ErrorResponse, "invalid").error.details,
        details,
        label,
      );
    }
    assert.equal(JSON.stringify(invalid.body).includes(accessToken), false, label);
  }
  assert.deepEqual(fixture.calls, []);
  // No validation failure logs the submitted token.
  assert.doesNotMatch(logs.join(""), /at-plugin-discovery/);
}

async function preservesSafeFailures(t: TestContext) {
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
  ] as const) {
    fixture.failWith(error);
    for (const [suffix, body] of [
      ["", { accessToken }],
      ["/details", { accessToken, pluginId: remoteId }],
    ] as const) {
      const failed = await fixture.request("POST", `${fixture.path}${suffix}`, {
        body: { harnessId: "codex", ...body },
      });
      assert.equal(failed.status, status);
      assert.equal(
        fixture.fixtureResponse(failed, status, ErrorResponse, "failed").error.code,
        code,
      );
      assert.doesNotMatch(JSON.stringify(failed.body), /private upstream|at-plugin-discovery/);
    }
  }
}

async function reportsUnsupportedDriver(t: TestContext) {
  const fixture = await createFixture(t, { supported: false });
  for (const [suffix, body] of [
    ["", { accessToken }],
    ["/details", { accessToken, pluginId: remoteId }],
  ] as const) {
    const unsupported = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", ...body },
    });
    assert.equal(unsupported.status, 501);
    assert.equal(
      fixture.fixtureResponse(unsupported, 501, ErrorResponse, "unsupported").error.code,
      "NOT_IMPLEMENTED",
    );
  }
  assert.deepEqual(fixture.calls, []);
}
