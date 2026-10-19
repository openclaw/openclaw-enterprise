import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  consoleViewports,
  countInvalidEvents,
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
} from "./console-agents-browser-helpers.mjs";
import {
  openAdvancedSettings,
  openCreateSecretDialog,
  routeInstallationWithoutProvisioning,
  waitForCreateFormReads,
} from "./console-agents-test-support.mjs";

// Form fields share one pattern (UX plan C3): a label, the control, its error, then its help.
// The console checks required fields itself, so the browser's transient bubble never shows; it
// writes a persistent error under each field, links it with aria-describedby and aria-invalid,
// and moves focus to the first field to fix.

const browser = fileBrowser();

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const standardCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

// A control's accessible name and description as Chromium's accessibility tree computes them,
// which is what a screen reader announces on focus.
async function accessible(page, locator) {
  await locator.evaluate((node) => node.setAttribute("data-ax-probe", ""));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "[data-ax-probe]",
    });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    const [node] = nodes;
    return {
      name: node.name?.value ?? "",
      description: node.description?.value ?? "",
      invalid: node.properties?.find((property) => property.name === "invalid")?.value?.value,
    };
  } finally {
    await cdp.detach();
    await locator.evaluate((node) => node.removeAttribute("data-ax-probe"));
  }
}

// The field's error sits under its control (or the control's wrapper), inside the same field,
// and reads in the danger colour.
const errorPlacement = (control) =>
  control.evaluate((node) => {
    const error = globalThis.document.getElementById(`${node.id}-error`);
    if (!error || error.hidden) {
      return null;
    }
    const field = node.closest(".field, .form-field, .channel-field");
    const probe = globalThis.document.createElement("span");
    probe.style.color = "var(--color-danger)";
    globalThis.document.body.append(probe);
    const danger = globalThis.getComputedStyle(probe).color;
    probe.remove();
    return {
      text: error.textContent,
      inField: Boolean(field?.contains(error)),
      below: error.getBoundingClientRect().top >= node.getBoundingClientRect().bottom,
      danger: globalThis.getComputedStyle(error).color === danger,
    };
  });

const focusedId = (page) => page.evaluate(() => globalThis.document.activeElement?.id ?? null);

async function assertFieldError(page, control, { name, error, help }) {
  const shown = await accessible(page, control);
  assert.equal(shown.name, name, `${name}: accessible name`);
  assert.equal(shown.invalid, "true", `${name}: aria-invalid`);
  assert.ok(shown.description.includes(error), `${name}: described by "${shown.description}"`);
  if (help) {
    assert.ok(shown.description.includes(help), `${name}: described by its help`);
  }
  const placement = await errorPlacement(control);
  assert.deepEqual(placement, { text: error, inField: true, below: true, danger: true }, name);
}

// The Create Agent form's fields: one console with the default Codex Preset, a Namespace for each
// case.
test("Create Agent form fields", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  for (const viewport of consoleViewports) {
    await t.test(
      `Use Preset checks its variables without the browser bubble at ${viewport.width}px`,
      async (t) => {
        const namespace = await fixture.createNamespace(`Preset fields ${viewport.width}`, {
          ready: true,
        });
        const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
          body: standardCodexPreset,
        });
        assert.equal(preset.status, 201, JSON.stringify(preset.body));
        const { page } = await newPage(t, fixture, { browser, context: { viewport } });
        const invalidEvents = await countInvalidEvents(page);
        await routeInstallationWithoutProvisioning(page, fixture);
        await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
        const selector = page.getByLabel("Preset template", { exact: true });
        await selector.selectOption(preset.data.id);
        const name = page.getByLabel("Name", { exact: true });
        const model = page.getByLabel("Model", { exact: true });
        const secret = page.getByLabel("Model Secret", { exact: true });
        await name.waitFor();
        // A single-line value is an input, not a resizable textarea.
        assert.equal(await name.evaluate((node) => node.tagName), "INPUT");
        // The Preset select has the shared input chrome and control height.
        const chrome = await selector.evaluate((node) => {
          const probe = globalThis.document.createElement("span");
          probe.style.color = "var(--color-border-strong)";
          globalThis.document.body.append(probe);
          const strong = globalThis.getComputedStyle(probe).color;
          probe.remove();
          const style = globalThis.getComputedStyle(node);
          return {
            edge: style.borderTopWidth === "1px" && style.borderTopColor === strong,
            height: Math.round(node.getBoundingClientRect().height),
          };
        });
        const inputHeight = Math.round((await name.boundingBox()).height);
        assert.equal(chrome.edge, true, "the Preset select has the input edge");
        assert.equal(chrome.height, inputHeight, "the Preset select is as tall as the inputs");
        assert.ok(inputHeight >= 40, `controls are at least --control-h tall (${inputHeight})`);

        await page.getByRole("button", { name: "Use Preset", exact: true }).click();
        assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
        assert.equal(await focusedId(page), await name.getAttribute("id"), "focus on the first");
        await assertFieldError(page, name, {
          name: "Name",
          error: "Name is required.",
          help: "Name for the new Agent",
        });
        await assertFieldError(page, model, {
          name: "Model",
          error: "Model is required.",
          help: "Codex model ID without the codex/ prefix",
        });
        await assertFieldError(page, secret, {
          name: "Model Secret",
          error: "Model Secret is required.",
          help: "Model API key; stored as a Secret when you create the Agent",
        });
        // The Preset group's own alert stays empty: the errors are under the fields.
        assert.equal(
          await page.getByRole("group", { name: "Preset" }).getByRole("alert").textContent(),
          "",
        );
        assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);

        // Fixing a field clears its error; the others stay until the next check.
        await name.fill("Field Agent");
        const fixed = await accessible(page, name);
        assert.equal(fixed.invalid, "false");
        assert.equal(fixed.description, "Name for the new Agent");
        assert.equal(await errorPlacement(name), null);
        assert.equal((await accessible(page, model)).invalid, "true");
        // The next check moves focus to the first field still wrong.
        await page.getByRole("button", { name: "Use Preset", exact: true }).click();
        assert.equal(await focusedId(page), await model.getAttribute("id"));
        assert.deepEqual(await invalidEvents(), []);
        // A field another choice turns off loses its error: an existing Secret replaces the typed one.
        await page
          .getByLabel("Secret source for Model Secret", { exact: true })
          .selectOption("existing");
        assert.equal(await errorPlacement(secret), null);
        assert.equal(await secret.getAttribute("aria-invalid"), null);
      },
    );
  }

  // Only the variable that names the Agent is a single-line input. Any other string variable may hold
  // several lines (instructions, a workspace file), even with a one-line default, so it keeps a
  // textarea; and spaces are a value there, not a missing one.
  await t.test(
    "Preset string variables keep several lines and spaces; only the Agent name is an input",
    async (t) => {
      const namespace = await fixture.createNamespace("Preset controls", { ready: true });
      const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
        body: {
          name: "Preset controls",
          template: {
            variables: {
              agentName: { type: "string" },
              notes: { type: "string" },
              prefix: { type: "string", default: "One line" },
              lines: { type: "string", default: "First\nSecond" },
            },
            agent: {
              name: "{{ vars.agentName }}",
              initialWorkspaceFiles: { "USER.md": "{{ vars.notes }}" },
            },
            configuration: {
              values: { messages: { responsePrefix: "{{ vars.prefix }} {{ vars.lines }}" } },
            },
          },
        },
      });
      assert.equal(preset.status, 201, JSON.stringify(preset.body));
      const { page } = await newPage(t, fixture, { browser });
      const invalidEvents = await countInvalidEvents(page);
      await routeInstallationWithoutProvisioning(page, fixture);
      await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
      await page.getByLabel("Preset template", { exact: true }).selectOption(preset.data.id);
      await page.getByLabel("Agent Name", { exact: true }).waitFor();
      const tag = (label) =>
        page.getByLabel(label, { exact: true }).evaluate((node) => node.tagName);
      assert.deepEqual(
        [await tag("Agent Name"), await tag("Notes"), await tag("Prefix"), await tag("Lines")],
        ["INPUT", "TEXTAREA", "TEXTAREA", "TEXTAREA"],
      );
      await page.getByLabel("Agent Name", { exact: true }).fill("Preset controls");
      await page.getByLabel("Notes", { exact: true }).fill(" ");
      await page.getByLabel("Prefix", { exact: true }).fill("One\nline");
      await page.getByRole("button", { name: "Use Preset", exact: true }).click();
      await openAdvancedSettings(page);
      const values = JSON.parse(
        await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
      );
      assert.equal(values.messages.responsePrefix, "One\nline First\nSecond");
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      assert.equal(await page.locator(".field-error:visible").count(), 0, "no field errors");
    },
  );

  await t.test(
    "Create Agent checks its fields without the browser bubble and focuses the first",
    async (t) => {
      const namespace = await fixture.createNamespace("Create fields", { ready: true });
      const { page } = await newPage(t, fixture, { browser });
      const invalidEvents = await countInvalidEvents(page);
      await routeInstallationWithoutProvisioning(page, fixture);
      const requests = apiRequests(page, fixture.origin);
      await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start with default Preset" }).click();
      await waitForCreateFormReads(page);
      const name = page.getByLabel("Agent name", { exact: true });
      await name.fill("   ");
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      assert.equal(await focusedId(page), "agent-name");
      // Spaces alone are no name: the API trims them.
      await assertFieldError(page, name, {
        name: "Agent name",
        error: "Agent name is required.",
        help: "Unique within this Namespace.",
      });
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    },
  );

  await t.test(
    "the Create Secret dialog checks its fields without the browser bubble",
    async (t) => {
      const namespace = await fixture.createNamespace("Secret fields", { ready: true });
      const { page } = await newPage(t, fixture, { browser });
      const invalidEvents = await countInvalidEvents(page);
      await routeInstallationWithoutProvisioning(page, fixture);
      const requests = apiRequests(page, fixture.origin);
      await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start with default Preset" }).click();
      await waitForCreateFormReads(page);
      await openCreateSecretDialog(page, "API key Secret");
      const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
      const name = dialog.getByLabel("Name", { exact: true });
      const value = dialog.getByLabel("Value", { exact: true });
      await name.fill("  ");
      await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      assert.equal(await focusedId(page), await name.getAttribute("id"));
      await assertFieldError(page, name, {
        name: "Name",
        error: "Name is required.",
        help: "Unique within this Namespace.",
      });
      await assertFieldError(page, value, {
        name: "Value",
        error: "Value is required.",
        help: "Stored as a Namespace Secret. The value is never read back.",
      });
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    },
  );
});

test("Share Agent checks its fields without the browser bubble", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["field-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Share fields");
  const agent = await fixture.createAgent(namespace.id, "Share fields", nativeValues("fields"));
  const { page } = await newPage(t, fixture, { browser });
  const invalidEvents = await countInvalidEvents(page);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = panel.getByLabel("Existing person’s Principal ID", { exact: true });
  const acknowledge = panel.getByRole("checkbox");
  const share = panel.getByRole("button", { name: "Share Agent", exact: true });
  await page.waitForFunction(
    () => !globalThis.document.querySelector("#share-principal-id")?.disabled,
  );
  await share.click();
  assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
  assert.equal(await focusedId(page), "share-principal-id");
  await assertFieldError(page, principal, {
    name: "Existing person’s Principal ID",
    error: "Existing person’s Principal ID is required.",
    help: "Use the Principal ID returned when the person was provisioned in this Installation. This does not create an account.",
  });
  const consent = await accessible(page, acknowledge);
  assert.equal(consent.invalid, "true");
  assert.equal(consent.description, "Check this box to continue.");
  // Both errors clear as the fields are fixed, and the share goes ahead.
  await principal.fill(fixture.provisionedAccounts[0].principal.id);
  await acknowledge.check();
  assert.equal((await accessible(page, principal)).invalid, "false");
  assert.equal((await accessible(page, acknowledge)).invalid, "false");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await share.click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  assert.deepEqual(await invalidEvents(), []);
});

// Choosing a Secret from the picker fires no input event, so the picker clears its own "is
// required" error; without that, the stale error and aria-invalid stayed under the field after a
// refused Create (finding 1983).
test("choosing a model credential Secret by click clears its required error", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Picker fields", { ready: true });
  await fixture.createSecret(namespace.id, "Picked model key", "synthetic-picked-key");
  const { page } = await newPage(t, fixture, { browser });
  const invalidEvents = await countInvalidEvents(page);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await waitForCreateFormReads(page);
  await page.getByLabel("Agent name", { exact: true }).fill("Picker Agent");
  const picker = page.getByLabel("API key Secret", { exact: true });
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
  assert.equal(await focusedId(page), "provider-credential-secret");
  await assertFieldError(page, picker, {
    name: "API key Secret",
    error: "Model credential Secret is required.",
  });
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // Focus opened the list; picking by pointer types nothing into the field.
  await page.getByRole("option", { name: "Picked model key", exact: true }).click();
  await page.getByText("Secret selected. Create Agent binds it.", { exact: true }).waitFor();
  assert.equal(await picker.getAttribute("aria-invalid"), null, "aria-invalid cleared");
  assert.equal((await accessible(page, picker)).invalid, "false");
  assert.equal(await errorPlacement(picker), null, "the required error is gone");
});

// No shipped form needs these two today: every form's own submit handler checks its fields
// again, and none has a required field inside a collapsed section. So the shared helpers are
// pinned on a form built for the test (finding 1983).
test("the shared submit check stops a failing form and opens the collapsed section to fix", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const { page } = await newPage(t, fixture, { browser });
  await page.goto(new URL("/console/", fixture.origin).href);
  const outcome = await page.evaluate(async () => {
    const { element, validateOnSubmit } = await import("/console/dom.mjs");
    const name = element("input", { id: "helper-name", type: "text", value: "Named" });
    const token = element("input", { id: "helper-token", type: "text", required: true });
    const section = element(
      "details",
      {},
      element("summary", {}, "Advanced"),
      element(
        "div",
        { className: "form-field" },
        element("label", { for: "helper-token" }, "Token"),
        token,
      ),
    );
    const form = element(
      "form",
      {},
      element(
        "div",
        { className: "form-field" },
        element("label", { for: "helper-name" }, "Name"),
        name,
      ),
      section,
      element("button", { type: "submit" }, "Save"),
    );
    globalThis.document.body.append(form);
    validateOnSubmit(form);
    // The form's own handler, which (unlike the shipped ones) checks nothing itself.
    const submitted = [];
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted.push(token.value);
    });
    const state = () => ({
      submitted: [...submitted],
      open: section.open,
      focused: globalThis.document.activeElement?.id ?? null,
      invalid: token.getAttribute("aria-invalid"),
      error: globalThis.document.getElementById("helper-token-error")?.hidden === false,
    });
    form.requestSubmit();
    const refused = state();
    token.value = "secret-free";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
    const accepted = state();
    form.remove();
    return { refused, accepted };
  });
  assert.deepEqual(outcome.refused, {
    submitted: [],
    open: true,
    focused: "helper-token",
    invalid: "true",
    error: true,
  });
  assert.deepEqual(outcome.accepted, {
    submitted: ["secret-free"],
    open: true,
    focused: "helper-token",
    invalid: null,
    error: false,
  });
});
