import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  codexCatalogEntries,
  codexRuntimeReadParams,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import {
  calendarPluginId,
  codexCatalogFixture,
  codexSelection,
  context,
  linearPluginId,
  thirdPluginId,
  thirdRemotePluginId,
} from "./plugin-driver-fixtures.ts";

test("Hardcoded OpenAI catalog returns curated details without provider requests", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0]) => {
    requests.push(String(url));
    throw new Error("Unexpected provider request");
  });
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  const page = await driver.discoverCatalog({});
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    new Set(page.plugins.map((entry) => entry.name)),
    new Set([
      "Linear",
      "Slack",
      "GitHub",
      "Notion",
      "Figma",
      "Canva",
      "Datadog",
      "Sentry",
      "Adobe",
      "Coursera Learning",
      "Google Contacts",
    ]),
  );
  const linear = page.plugins.find((entry) => entry.id === linearPluginId);
  assert.ok(linear);
  assert.equal(linear.id, linearPluginId);
  assert.equal(linear.remoteId, "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c");
  assert.equal(linear.tools, null);
  assert.equal(linear.selectableWithoutTools, true);
  assert.deepEqual(await driver.getCatalogPlugin({ pluginId: linear.remoteId }), linear);
  const github = page.plugins.find((entry) => entry.name === "GitHub");
  assert.ok(github);
  assert.equal(github.remoteId, "plugin_connector_1p_1a69035c238881919c4190932b2df699");
  assert.deepEqual(await driver.getCatalogPlugin({ pluginId: github.remoteId }), github);
  // Recorded releases with unsupported components must never be offered for selection.
  assert.deepEqual(
    new Set(page.plugins.filter((entry) => entry.available === false).map((entry) => entry.name)),
    new Set(["Sentry"]),
  );
  assert.equal(new Set(page.plugins.map((entry) => entry.remoteId)).size, page.plugins.length);
  for (const entry of page.plugins) {
    assert.ok(entry.remoteId);
    assert.deepEqual(await driver.getCatalogPlugin({ pluginId: entry.remoteId }), entry);
    if (entry.available === false) {
      assert.ok(entry.unavailableReason);
      assert.match(entry.unavailableReason, /no concrete hosted app/);
    } else {
      assert.equal(entry.selectableWithoutTools, true);
    }
  }
  assert.deepEqual(await driver.listCatalog(context("dedicated")), page.plugins);
  // The curated catalog is a single page with fixed IDs: a cursor is an invalid response, and
  // an unknown ID is the caller's error (finding 2790).
  await assert.rejects(driver.discoverCatalog({ cursor: "invalid" }), {
    name: "PluginDiscoveryError",
    reason: "invalid_response",
  });
  await assert.rejects(driver.getCatalogPlugin({ pluginId: "invalid" }), {
    name: "PluginPolicyValidationError",
    pluginId: "invalid",
  });
  assert.deepEqual(requests, []);
});

test("Codex curated catalog discovery projects arbitrary marketplace entries", () => {
  const catalog = codexCatalogEntries(codexCatalogFixture());
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  assert.deepEqual(catalog[2], {
    id: thirdPluginId,
    name: "Third Plugin",
    tools: null,
  });
  assert.deepEqual(codexRuntimeReadParams(codexSelection(thirdPluginId), codexCatalogFixture()), [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: thirdRemotePluginId },
  ]);
});
