import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import {
  enterManualModel,
  openAdvancedSettings,
  waitForLiveControls,
} from "./console-agents-test-support.mjs";
import { SAVED_CONFIGURATION_CHANGED } from "../helpers/refusal-text.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// The Configuration editor's errors read as errors and its hints as hints, including after the
// editor is rebuilt from a kept draft (finding 1940).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// "danger" for an error (the danger status block, UX plan C1), otherwise the line's class.
const feedbackClass = (page: Page) =>
  page
    .locator("#configuration-editor-feedback")
    .evaluate((node) =>
      node.className === "status" ? node.getAttribute("data-tone") : node.className,
    );

async function openEditor(
  page: Page,
  fixture: Awaited<ReturnType<typeof createConsoleAppFixture>>,
  namespace: NamespaceWire,
  agent: AgentWire,
  marker: string,
) {
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
  await openAdvancedSettings(page);
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill(JSON.stringify(nativeValues(marker), null, 2));
}

// Leaving for a global route keeps the draft; coming back rebuilds the editor from it.
async function leaveAndReturn(page: Page) {
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await waitForLiveControls(page, ["configuration-json"]);
}

test("a refused or stale Configuration save is an error; editing again is a hint", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration feedback", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Feedback Agent", nativeValues("saved"));
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, { browser });
  let patchAnswer = "refuse";
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    if (patchAnswer === "refuse") {
      await route.fulfill(
        apiErrorResponse(400, "INVALID_REQUEST", "Refused for this test.", {
          requestId: "req_00000000-0000-4000-8000-000000000400",
        }),
      );
      return;
    }
    // Another browser saves between this page's reread and its PATCH.
    await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("other"));
    await route.continue();
  });
  await openEditor(page, fixture, namespace, agent, "refused");

  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await page.getByText("Refused for this test.").waitFor();
  assert.equal(await feedbackClass(page), "danger");

  // The next note is guidance again, not a leftover error colour.
  await page.getByLabel("Configuration JSON", { exact: true }).press("End");
  await page.getByLabel("Configuration JSON", { exact: true }).press("Enter");
  await page
    .locator("#configuration-editor-feedback")
    .getByText("Save or cancel these Configuration edits before deploying.", { exact: true })
    .waitFor();
  assert.equal(await feedbackClass(page), "hint");

  patchAnswer = "stale";
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await page.getByText(SAVED_CONFIGURATION_CHANGED).waitFor();
  assert.equal(await feedbackClass(page), "danger");

  // The rebuilt editor still needs a reload, and says so as an error.
  await leaveAndReturn(page);
  await page
    .locator("#configuration-editor-feedback")
    .getByText("Reload this draft before saving again.", { exact: true })
    .waitFor();
  assert.equal(await feedbackClass(page), "danger");
});

test("an unknown Configuration save outcome stays an error when the editor is rebuilt", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unknown feedback", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unknown Agent", nativeValues("saved"));
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, { browser });
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fetch();
    await route.fulfill(
      apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "masked Configuration response", {
        requestId: "req_00000000-0000-4000-8000-000000000503",
      }),
    );
  });
  const outcomeUnknown = page
    .locator("#configuration-editor-feedback")
    .getByText(
      "Outcome unknown. Configuration may have been saved. Reload this draft before saving again.",
      { exact: true },
    );
  await openEditor(page, fixture, namespace, agent, "unknown");
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await outcomeUnknown.waitFor();
  assert.equal(await feedbackClass(page), "danger");

  await leaveAndReturn(page);
  await outcomeUnknown.waitFor();
  assert.equal(await feedbackClass(page), "danger");
});

test("Create Agent: Reset template clears a JSON error; a primary or fallback model mismatch focuses the JSON", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create JSON feedback", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await enterManualModel(page, "unused-json-feedback-key", "gpt-4.1");
  await page.getByLabel("Agent name").fill("JSON feedback Agent");
  await openAdvancedSettings(page);
  const json = page.getByLabel("Configuration JSON", { exact: true });
  const jsonError = page.locator("#configuration-json-error");
  const template = await json.inputValue();

  // A stray closing brace after the object is located (finding 1939).
  await json.fill(`${template}}`);
  await page.getByRole("button", { name: "Create Agent" }).click();
  const lines = template.split("\n");
  await jsonError
    .getByText(
      `Invalid JSON at line ${lines.length}, column ${template.length - template.lastIndexOf("\n")}. Enter a valid JSON object.`,
      { exact: true },
    )
    .waitFor();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reset template", exact: true }).click();
  // The template, rebuilt (its keys may come back in another order).
  assert.deepEqual(JSON.parse(await json.inputValue()), JSON.parse(template));
  assert.equal(await jsonError.isHidden(), true);
  assert.equal(await json.getAttribute("aria-invalid"), null);

  const focusedId = () => page.evaluate(() => globalThis.document.activeElement?.id);
  // The selected model under the OpenAI prefix, which Codex does not run: the primary-model
  // mismatch, the most common one (finding 1951).
  const values = JSON.parse(template);
  const selected = values.agents.defaults.model;
  const primary = typeof selected === "string" ? selected : selected.primary;
  assert.equal(primary, "codex/gpt-4.1");
  values.agents.defaults.model = "openai/gpt-4.1";
  await json.fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "Configuration must use the selected provider and model. Update the JSON or reset the template before saving.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await focusedId(), "configuration-json");

  values.agents.defaults.model = {
    primary,
    fallbacks: ["another-provider/model"],
  };
  await json.fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "Fallback models must use the selected provider and execution mode. Update the Configuration JSON or reset the template before saving.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await focusedId(), "configuration-json");
});
