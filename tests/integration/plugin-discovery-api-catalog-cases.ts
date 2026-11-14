import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  InstallationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  accessToken,
  createDiscoveryConsole,
  createFixture,
  remoteId,
  secretValueReadCount,
  fetchUrl,
} from "./plugin-discovery-api-fixture.ts";

export async function usesEachHarnessCatalog(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const readsBefore = secretValueReadCount(secretDriver);
  const fixture = await createDiscoveryConsole(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Mixed plugin catalogs", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Discovery Secret", accessToken);
  const path = `/namespaces/${namespace.id}/agents/plugins`;
  fixture.controller.installPluginDrivers([
    new OCCPluginDriver(),
    new CodexPluginDriver({ catalogSource: "openai-curated" }),
  ]);
  const installation = await fixture.request("GET", "/installation");
  const capabilities = fixture.fixtureResponse(
    installation,
    200,
    InstallationResponse,
    "installation",
  ).data.capabilities;
  assert.ok(capabilities?.pluginCatalogs);
  assert.deepEqual(
    Object.fromEntries(
      capabilities.pluginCatalogs.map(({ harnessId, pluginPolicies, pluginDiscovery }) => {
        const driver = pluginPolicies.driver;
        assert.ok(typeof driver === "object" && driver !== null && "id" in driver);
        return [harnessId, [driver.id, pluginDiscovery?.credential]];
      }),
    ),
    {
      openclaw: ["occ-plugin", "none"],
      codex: ["codex-plugin", "none"],
    },
  );
  for (const [harnessId, name] of [
    ["openclaw", "Google Workspace"],
    ["codex", "Linear"],
  ] as const) {
    const page = await fixture.request("POST", path, { body: { harnessId, q: name } });
    const catalog = fixture.fixtureResponse(
      page,
      200,
      AgentPluginCatalogResponse,
      "Harness catalog",
    ).data;
    const entry = catalog.plugins.find((entry) => entry.name === name);
    assert.ok(entry, JSON.stringify(catalog));
    const details = await fixture.request("POST", `${path}/details`, {
      body: { harnessId, pluginId: entry.remoteId ?? entry.id },
    });
    assert.equal(details.status, 200);
    assert.equal(
      fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data.id,
      entry.id,
    );
  }
  for (const body of [
    { q: "Linear" },
    { harnessId: "unknown", q: "Linear" },
    { secretRef: secret.ref },
    { harnessId: "openclaw", secretRef: secret.ref },
  ]) {
    const rejected = await fixture.request("POST", path, { body });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  }
  assert.equal(secretValueReadCount(secretDriver) - readsBefore, 0);
}

export async function savesCuratedSelectionsInRevision(t: TestContext) {
  const fixture = await createDiscoveryConsole(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Curated plugins", { ready: true });
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const path = `/namespaces/${namespace.id}/agents/plugins`;

  // Permit the real HTTP fixture transport while making any discovery-service call fail.
  const fetch = globalThis.fetch;
  const externalRequests: string[] = [];
  const localFetch: typeof fetch = (url, options) => {
    const target = fetchUrl(url);
    if (target.hostname !== "127.0.0.1") {
      externalRequests.push(target.href);
      throw new Error("Curated discovery must not call an external service.");
    }
    return fetch(url, options);
  };
  t.mock.method(globalThis, "fetch", localFetch);
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(
    fixture.fixtureResponse(installation, 200, InstallationResponse, "installation").data
      .capabilities?.pluginCatalogs?.[0]?.pluginDiscovery,
    {
      credential: "none",
    },
  );
  const page = await fixture.request("POST", path, { body: { harnessId: "codex" } });
  const catalog = fixture.fixtureResponse(
    page,
    200,
    AgentPluginCatalogResponse,
    "curated catalog",
  ).data;
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(catalog.nextCursor, null);
  const linear = catalog.plugins.find(
    (entry) => entry.id === "codex-plugin:linear@openai-curated-remote",
  );
  assert.ok(linear);
  assert.equal(linear.remoteId, "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c");
  assert.equal(linear.tools, null);
  assert.equal(linear.selectableWithoutTools, true);
  const search = await fixture.request("POST", path, {
    body: { harnessId: "codex", q: "  LiNeAr  " },
  });
  const searchPage = fixture.fixtureResponse(
    search,
    200,
    AgentPluginCatalogResponse,
    "curated search",
  ).data;
  assert.deepEqual(searchPage.plugins, [linear]);
  assert.equal(searchPage.nextCursor, null);
  const details = await fixture.request("POST", `${path}/details`, {
    body: { harnessId: "codex", pluginId: linear.remoteId },
  });
  assert.equal(details.status, 200);
  assert.deepEqual(
    fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data,
    linear,
  );
  const slack = catalog.plugins.find(
    (entry) => entry.id === "codex-plugin:slack@openai-curated-remote",
  );
  assert.ok(slack);
  const slackDetails = await fixture.request("POST", `${path}/details`, {
    body: { harnessId: "codex", pluginId: slack.remoteId },
  });
  assert.equal(slackDetails.status, 200);
  assert.deepEqual(
    fixture.fixtureResponse(slackDetails, 200, AgentPluginDetailsResponse, "slackDetails").data,
    slack,
  );
  const notion = catalog.plugins.find(
    (entry) => entry.id === "codex-plugin:notion@openai-curated-remote",
  );
  assert.ok(notion);
  assert.notEqual(notion.available, false);
  assert.equal(notion.selectableWithoutTools, true);
  // An unknown ID is the caller's error, named in the refusal (finding 2790); a cursor
  // on the single-page catalog is still an invalid catalog response.
  const unknown = await fixture.request("POST", `${path}/details`, {
    body: { harnessId: "codex", pluginId: "unknown" },
  });
  assert.equal(unknown.status, 400);
  assert.equal(
    fixture.fixtureResponse(unknown, 400, ErrorResponse, "unknown").error.code,
    "INVALID_REQUEST",
  );
  assert.match(
    fixture.fixtureResponse(unknown, 400, ErrorResponse, "unknown").error.message,
    /\(codex-plugin\) does not offer: unknown\./,
  );
  assert.equal(
    (await fixture.request("POST", path, { body: { harnessId: "codex", cursor: "unknown" } }))
      .status,
    503,
  );

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
  assert.deepEqual(revision.plugins?.plugins, plugins);
  assert.deepEqual(revision.plugins?.driver, {
    id: driver.id,
    implementation: driver.implementation,
  });
  assert.deepEqual(externalRequests, []);
}

export async function requiresHostedCredentialAndCuratedGrant(t: TestContext) {
  const fixture = await createFixture(t);
  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const missing = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", ...body },
    });
    assertApiError(missing, 400, "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED");
  }
  assert.deepEqual(fixture.calls, []);

  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const reader = await fixture.createAccountWithPolicy("curated-reader", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "curated-reader-role",
      bindingId: "curated-reader-binding",
      namespaceId: fixture.namespace.id,
      permissions: { namespace: ["read"] },
      resource: undefined,
    });
  });
  const session = await fixture.signIn(reader.credentials);
  for (const [suffix, body] of [
    ["", {}],
    ["/details", { pluginId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c" }],
  ] as const) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", ...body },
    });
    assert.equal(denied.status, 403);
  }
}
