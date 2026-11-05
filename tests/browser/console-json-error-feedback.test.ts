import {
  enterManualModel,
  openAdvancedSettings,
  waitForLiveControls,
} from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import {
  detailUrl,
  fileBrowser,
  focusedId,
  login,
  nativeValues,
  nextFrames,
  newPage,
  shippedPreset,
} from "./console-agents-browser-helpers.ts";
import { SAVED_CONFIGURATION_CHANGED } from "../helpers/refusal-text.mjs";

const defaultCodexPreset = await shippedPreset("default-codex");

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

test("Configuration keeps an out-of-range number draft until corrected before saving", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Number range feedback");
  const agent = await fixture.createAgent(
    namespace.id,
    "Number range Agent",
    nativeValues("saved"),
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, { browser });
  let patches = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === configurationPath) {
      patches += 1;
    }
  });
  await openEditor(page, fixture, namespace, agent, "corrected");
  const json = page.getByLabel("Configuration JSON", { exact: true });
  const corrected = JSON.stringify(nativeValues("corrected"));
  const draft = corrected.replace('"thresholds":[1,2,3]', '"thresholds":[1,1e400,3]');
  assert.notEqual(draft, corrected);
  await json.fill(draft);
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await page
    .locator("#configuration-json-error")
    .getByText("A number is too large or too small to save. Use a number closer to zero.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await focusedId(page), "configuration-json");
  assert.equal(await json.inputValue(), draft);
  assert.equal(patches, 0);

  // The correction must reach the real Controller route and survive a separate read.
  await json.fill(corrected);
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === configurationPath,
  );
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.equal(patches, 1);
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.values, nativeValues("corrected"));
});

test("a refused or stale Configuration save is an error; editing again is a hint", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Configuration feedback");
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Unknown feedback");
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

test("Create Agent: number-range model edits preserve drafts; syntax, shape, reset and model mismatch feedback", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Create JSON feedback", {
    defaultPresets: [defaultCodexPreset],
  });
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
  const model = page.getByLabel("Model ID", { exact: true });

  // Establish normal Tab focus on this form before comparing syntax and shape failures.
  await model.fill("gpt-5.4");
  await model.press("Tab");
  await nextFrames(page);
  const normalFocus = await page.evaluateHandle(() => document.activeElement);
  assert.notEqual(await focusedId(page), "configuration-json");
  for (const draft of ["{ invalid", "[]"]) {
    await json.fill(draft);
    await model.fill("gpt-4.1");
    await model.press("Tab");
    await nextFrames(page);
    assert.equal(await normalFocus.evaluate((node) => node === document.activeElement), true);
    assert.equal(await json.inputValue(), draft);
    assert.equal(await jsonError.isHidden(), true);
    await page.getByRole("button", { name: "Choose a model from the list", exact: true }).click();
    assert.equal(await focusedId(page), "agent-model");
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
    assert.equal(await model.evaluate((node) => node === document.activeElement), true);
    assert.equal(await json.inputValue(), draft);
    // Ensure the next manual change fires even when the selected model survived the toggle.
    await model.fill("gpt-5.4");
    await model.press("Tab");
  }

  // Valid JSON syntax can still contain a number that serialization would replace with null.
  const overflow = template.replace(/^\s*\{/, '{"metadata":{"thresholds":[1,-1e400,3]},');
  assert.notEqual(overflow, template);
  await json.fill(overflow);
  await model.fill("gpt-4.1");
  await model.press("Tab");
  await jsonError
    .getByText("A number is too large or too small to save. Use a number closer to zero.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await focusedId(page), "configuration-json");
  assert.equal(await json.inputValue(), overflow);
  for (const name of ["Choose a model from the list", "Enter model ID manually"]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(await focusedId(page), "configuration-json");
    assert.equal(await json.inputValue(), overflow);
  }
  await json.fill(overflow.replace("-1e400", "-1.5e2"));
  await model.fill("gpt-5.4");
  await model.press("Tab");
  await nextFrames(page);
  const corrected: unknown = JSON.parse(await json.inputValue());
  assert.partialDeepStrictEqual(corrected, { metadata: { thresholds: [1, -150, 3] } });
  assert.equal(await jsonError.isHidden(), true);
  assert.equal(await normalFocus.evaluate((node) => node === document.activeElement), true);
  await json.fill(template);
  await model.fill("gpt-4.1");
  await model.press("Tab");

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
  assert.equal(await focusedId(page), "configuration-json");

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
  assert.equal(await focusedId(page), "configuration-json");
});
