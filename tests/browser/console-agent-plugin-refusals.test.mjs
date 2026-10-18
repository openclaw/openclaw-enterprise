import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { openAdvancedSettings } from "./console-agents-test-support.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();
const pluginId = "occ-plugin:diffs";
const selections = JSON.stringify({
  [pluginId]: { enabled: true, toolDefaults: { approval: "none" } },
});

async function pluginFixture(t, options) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  return fixture;
}

// What a reader sees of the focused refusal, and whether the page scrolls sideways.
const refusalView = (page) =>
  page
    .getByRole("alert")
    .filter({ hasText: "every tool" })
    .evaluate((alert) => {
      const { top, bottom } = alert.getBoundingClientRect();
      const status = [...globalThis.document.querySelectorAll("[role=status]")].find((node) =>
        node.textContent.includes("Configuration saved:"),
      );
      return {
        text: alert.textContent,
        focused: globalThis.document.activeElement === alert,
        error: alert.classList.contains("error"),
        // Sub-pixel layout can end the line a fraction past the viewport it was aligned to.
        inView: top >= 0 && bottom <= globalThis.innerHeight + 1,
        rect: [Math.round(top), Math.round(bottom), globalThis.innerHeight, globalThis.scrollY],
        beforeSavedStatus: status
          ? Boolean(
              alert.compareDocumentPosition(status) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : null,
        sideways: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth,
      };
    });

// Fills Create Agent from the Standard OpenClaw Preset with `entries` as the Configuration's
// roster and the plugin selected, at `width`. Returns the page and the POST /agents matcher.
async function refusedCreateForm(t, name, entries, width = 1280) {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-openclaw.json", import.meta.url), "utf8"),
  );
  const fixture = await pluginFixture(t, { defaultPresets: [preset] });
  const namespace = await fixture.createNamespace(name, { ready: true });
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width, height: 900 } },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption({ label: "Standard OpenClaw" });
  await page.getByLabel("Name", { exact: true }).fill(name.toLowerCase().replaceAll(" ", "-"));
  await page.getByLabel("Model", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-model-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await configuration.inputValue());
  values.agents = { ...values.agents, ...entries };
  await configuration.fill(JSON.stringify(values, null, 2));
  await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
  const pluginJson = page.getByLabel("Plugin selections JSON");
  await pluginJson.fill(selections);
  await pluginJson.press("Tab");
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const isAgentPost = (response) =>
    response.url() === agentsUrl && response.request().method() === "POST";
  const refused = page.waitForResponse(isAgentPost);
  await page.getByRole("button", { name: "Create Agent", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal((await refused).status(), 400);
  await page.getByRole("alert").filter({ hasText: "every tool" }).waitFor();
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();
  // The Configuration is saved now, and its editor with it.
  assert.equal(await configuration.isDisabled(), true);
  return { page, pluginJson, isAgentPost };
}

const inPlaceFix = new RegExp(
  `This form cannot edit saved Configuration cfg_[0-9a-f-]+\\. Deselect plugin ${pluginId} under Plugins and select Create Agent again;`,
);

// A plugin refusal after Create Agent saved its Configuration landed under the fold, below a
// "Configuration saved" line that read as progress (finding 1862). Its own fixes edit the
// Configuration, which the form no longer can, and the fix left there went unnamed (finding
// 1863). A long setting path scrolled the phone-width page sideways (finding 1868).
test("Create Agent shows a plugin refusal in view, first and wrapped, with the fix it allows", async (t) => {
  const { page } = await refusedCreateForm(
    t,
    "Plugin refusal phone",
    {
      ownership: "explicit",
      entries: { main: {}, research_assistant_planning: { tools: { deny: ["*"] } } },
    },
    360,
  );
  const view = await refusalView(page);
  t.diagnostic(JSON.stringify(view));
  assert.equal(view.focused, true);
  assert.equal(view.inView, true, "the focused refusal is on screen");
  assert.equal(view.beforeSavedStatus, true, "the refusal leads the saved-resources line");
  assert.ok(view.sideways <= 0, `page scrolls ${view.sideways} px sideways`);
  assert.match(view.text, /agents\.entries\.research_assistant_planning\.tools\.deny denies/);
  assert.match(view.text, inPlaceFix);
});

test("Create Agent completes after deselecting the plugin a refusal names", async (t) => {
  const { page, pluginJson, isAgentPost } = await refusedCreateForm(t, "Plugin refusal fix", {
    entries: { main: { tools: { deny: ["diffs"] } } },
  });
  assert.match((await refusalView(page)).text, inPlaceFix);
  await pluginJson.fill("{}");
  await pluginJson.press("Tab");
  const created = page.waitForResponse(isAgentPost);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  await page.waitForURL(/\/console\/agents\/agt_/);
});

// Without a plugin in the refusal the form adds nothing: the API's sentence stands alone.
test("Create Agent adds no plugin guidance to a refusal that names no selected plugin", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-openclaw.json", import.meta.url), "utf8"),
  );
  const fixture = await pluginFixture(t, { defaultPresets: [preset] });
  const namespace = await fixture.createNamespace("Plain refusal create", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption({ label: "Standard OpenClaw" });
  await page.getByLabel("Name", { exact: true }).fill("plain-refusal");
  await page.getByLabel("Model", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-model-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
  await page.getByLabel("Plugin selections JSON").fill(selections);
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const reason = "Agent name is reserved for this test.";
  await page.route(agentsUrl, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "INVALID_REQUEST", message: reason },
            meta: { requestId: "req_test_plain_refusal" },
          }),
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: reason });
  await alert.waitFor();
  const text = await alert.textContent();
  assert.ok(text.startsWith(reason), text);
  assert.doesNotMatch(text, /deselect plugin|cannot edit saved Configuration/i);
});

// The Plugins tab showed a refusal in the muted status line and dropped focus to the page
// when Save disabled (finding 1864).
test("the Plugins tab shows a plugin refusal as a focused error", async (t) => {
  const fixture = await pluginFixture(t);
  const namespace = await fixture.createNamespace("Plugin refusal tab", { ready: true });
  const values = nativeValues("refusal");
  delete values.plugins.entries.knowledge;
  values.tools = { ...values.tools, byProvider: { openai: { deny: ["diffs"] } } };
  const agent = await fixture.createAgent(namespace.id, "Deny Agent", values);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 900 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
  const pluginJson = page.getByLabel("Plugin selections JSON");
  await pluginJson.fill(selections);
  await pluginJson.press("Tab");
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${agent.id}`) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections" }).focus();
  await page.keyboard.press("Enter");
  assert.equal((await patched).status(), 400);
  await page.getByRole("alert").filter({ hasText: "every tool" }).waitFor();
  await page.getByRole("button", { name: "Save plugin selections", disabled: false }).waitFor();
  const view = await refusalView(page);
  t.diagnostic(JSON.stringify(view));
  assert.equal(view.error, true);
  assert.equal(view.focused, true);
  assert.equal(view.inView, true);
  assert.equal(
    view.text,
    `Configuration setting tools.byProvider.openai.deny blocks every tool of plugin ${pluginId}; remove the matching deny entry or deselect the plugin.`,
  );
  // An edit clears the refusal.
  await pluginJson.fill("{}");
  assert.equal(await page.getByRole("alert").filter({ hasText: "every tool" }).count(), 0);
});
