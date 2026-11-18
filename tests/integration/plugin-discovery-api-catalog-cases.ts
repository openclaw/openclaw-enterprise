import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  InstallationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  accessToken,
  createDiscoveryConsole,
  secretValueReadCount,
} from "./plugin-discovery-api-fixture.ts";

export async function usesEachHarnessCatalog(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const readsBefore = secretValueReadCount(secretDriver);
  const fixture = await createDiscoveryConsole(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Mixed plugin catalogs", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Discovery Secret", accessToken);
  const path = `/namespaces/${namespace.id}/agents/plugins`;
  fixture.controller.installPluginDrivers([new OCCPluginDriver(), new CodexPluginDriver()]);
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
      codex: ["codex-plugin", "required"],
    },
  );
  const page = await fixture.request("POST", path, {
    body: { harnessId: "openclaw", q: "Google Workspace" },
  });
  const catalog = fixture.fixtureResponse(
    page,
    200,
    AgentPluginCatalogResponse,
    "OpenClaw catalog",
  ).data;
  const entry = catalog.plugins.find((entry) => entry.name === "Google Workspace");
  assert.ok(entry);
  const details = await fixture.request("POST", `${path}/details`, {
    body: { harnessId: "openclaw", pluginId: entry.remoteId ?? entry.id },
  });
  assert.equal(
    fixture.fixtureResponse(details, 200, AgentPluginDetailsResponse, "details").data.id,
    entry.id,
  );
  // The other Harness still resolves its own account-authenticated discovery policy.
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: "remote-fixture" }],
  ] as const) {
    const missing = await fixture.request("POST", `${path}${suffix}`, {
      body: { harnessId: "codex", ...extra },
    });
    assertApiError(missing, 400, "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED");
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
