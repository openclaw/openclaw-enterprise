import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";

import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error.mjs";
import { SECRET_NAME_CONFLICT } from "../helpers/refusal-text.mjs";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  consoleViewports,
  countInvalidEvents,
  detailUrl,
  fileBrowser,
  holdRequests,
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
const createConsoleAppFixture = (t: TestContext, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

function presetId(preset: unknown) {
  assert.ok(
    typeof preset === "object" && preset && "id" in preset && typeof preset.id === "string",
    "created Preset has an ID",
  );
  return preset.id;
}

// A control's accessible name and description as Chromium's accessibility tree computes them,
// which is what a screen reader announces on focus.
async function accessible(page: Page, locator: Locator) {
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
    assert.ok(node, "Chromium exposes the field in its accessibility tree");
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
const errorPlacement = (control: Locator) =>
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

const focusedId = (page: Page) =>
  page.evaluate(() => globalThis.document.activeElement?.id ?? null);

async function assertFieldError(
  page: Page,
  control: Locator,
  { name, error, help }: { name: string; error: string; help?: string },
) {
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
        await selector.selectOption(presetId(preset.data));
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
        const inputHeight = await name.evaluate((node) =>
          Math.round(node.getBoundingClientRect().height),
        );
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
      await page.getByLabel("Preset template", { exact: true }).selectOption(presetId(preset.data));
      await page.getByLabel("Agent Name", { exact: true }).waitFor();
      const tag = (label: string) =>
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
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = panel.getByLabel("Existing person’s Principal ID", { exact: true });
  const acknowledge = panel.getByRole("checkbox");
  const share = panel.getByRole("button", { name: "Share Agent", exact: true });
  await panel.locator("#share-principal-id:enabled").waitFor();
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
  const [recipient] = fixture.provisionedAccounts;
  assert.ok(recipient, "Share recipient was provisioned");
  await principal.fill(recipient.principal.id);
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
    error: "API key Secret is required.",
  });
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // A click opens the list; picking by pointer types nothing into the field.
  await picker.click();
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
    const path = "/console/dom.mjs";
    const {
      element,
      validateOnSubmit,
    }: typeof import("../../apps/controller/src/console/dom.mts") = await import(path);
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
    const submitted: string[] = [];
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

// The required Secret picker as the console's check leaves it: the error names the label the
// page shows (finding 1987), and the list stays closed so it does not cover that error (finding
// 1988). Click, typing and ArrowDown still open it.
const pickerState = (control: Locator) =>
  control.evaluate((node) => {
    const error = globalThis.document.getElementById(`${node.id}-error`);
    const listboxId = node.getAttribute("aria-controls");
    const listbox = listboxId && globalThis.document.getElementById(listboxId);
    if (!listbox || !error) {
      throw new Error(`Missing listbox or error for ${node.id}`);
    }
    const box = error.getBoundingClientRect();
    const top = globalThis.document.elementFromPoint(box.left + 4, box.top + box.height / 2);
    return {
      expanded: node.getAttribute("aria-expanded"),
      listboxHidden: listbox.hidden,
      errorOnTop: error.contains(top),
      focused: globalThis.document.activeElement === node,
    };
  });

const closedPicker = { expanded: "false", listboxHidden: true, errorOnTop: true, focused: true };

for (const viewport of consoleViewports) {
  test(`Create Agent's required Secret error names its field and stays in sight at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Picker label", { ready: true });
    await fixture.createSecret(namespace.id, "Label model key", "synthetic-label-key");
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    const invalidEvents = await countInvalidEvents(page);
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await waitForCreateFormReads(page);
    await page.getByLabel("Agent name", { exact: true }).fill("Picker Label Agent");
    // A valid picker still opens on focus alone, as Tab gives it (#2922; finding 2076).
    const apiKey = page.getByLabel("API key Secret", { exact: true });
    await apiKey.focus();
    assert.equal(await apiKey.getAttribute("aria-expanded"), "true");
    assert.equal(
      await apiKey.evaluate((node) => {
        const id = node.getAttribute("aria-controls");
        return id && globalThis.document.getElementById(id)?.hidden;
      }),
      false,
      "its list shows",
    );
    await apiKey.press("Escape");
    assert.equal(await apiKey.getAttribute("aria-expanded"), "false");
    const create = page.getByRole("button", { name: "Create Agent", exact: true });
    await create.click();
    assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
    await assertFieldError(page, apiKey, {
      name: "API key Secret",
      error: "API key Secret is required.",
    });
    assert.deepEqual(await pickerState(apiKey), closedPicker);
    // Another method renames the field; the shown error follows, and a second check uses it.
    await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
    const token = page.getByLabel("Service account token Secret", { exact: true });
    await assertFieldError(page, token, {
      name: "Service account token Secret",
      error: "Service account token Secret is required.",
    });
    await create.click();
    await assertFieldError(page, token, {
      name: "Service account token Secret",
      error: "Service account token Secret is required.",
    });
    assert.deepEqual(await pickerState(token), closedPicker);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    // Click, ArrowDown and typing still open the list.
    await token.click();
    assert.equal(await token.getAttribute("aria-expanded"), "true");
    await token.press("Escape");
    assert.equal(await token.getAttribute("aria-expanded"), "false");
    await token.press("ArrowDown");
    assert.equal(await token.getAttribute("aria-expanded"), "true");
    await token.press("Escape");
    await token.pressSequentially("Label");
    assert.equal(await token.getAttribute("aria-expanded"), "true");
    await page.getByRole("option", { name: "Label model key", exact: true }).click();
    await page.getByText("Secret selected. Create Agent binds it.", { exact: true }).waitFor();
    assert.equal(await errorPlacement(token), null, "the required error is gone");
  });
}

// A Create Secret refusal other than a name conflict disables the submit while it runs; the
// refusal then takes focus inside the dialog, in view, instead of the page behind it (finding
// 1989).
for (const viewport of consoleViewports) {
  test(`a refused Create Secret keeps focus in the dialog, on the refusal, at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Secret refusals", { ready: true });
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await routeInstallationWithoutProvisioning(page, fixture);
    let refusal = apiErrorResponse(409, "NAMESPACE_NOT_READY", "refused");
    await page.route(`**/namespaces/${namespace.id}/secrets`, (route, request) =>
      request.method() === "POST" ? route.fulfill(refusal) : route.fallback(),
    );
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await waitForCreateFormReads(page);
    await openCreateSecretDialog(page, "API key Secret");
    const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
    await dialog.getByLabel("Value", { exact: true }).fill("synthetic-refused-value");
    const focusedRefusal = () =>
      page.evaluate(() => {
        const active = globalThis.document.activeElement;
        if (!active) {
          throw new Error("Expected a focused refusal");
        }
        const box = active.getBoundingClientRect();
        return {
          inDialog: Boolean(active.closest("dialog[open]")),
          role: active.getAttribute("role"),
          text: active.textContent,
          inView: box.top >= 0 && box.bottom <= globalThis.innerHeight,
        };
      });
    // The Secret API never answers 429: a rate limit in front of it (an ingress or proxy) does,
    // with its own page and no API envelope.
    const cases = [
      [
        apiErrorResponse(409, "NAMESPACE_NOT_READY", "refused"),
        "This Namespace is not ready, so it cannot store Secrets yet.",
      ],
      [
        apiErrorResponse(403, "FORBIDDEN", "refused"),
        "Access denied. You do not have permission to manage this Secret binding.",
      ],
      [proxyErrorResponse(429), "Too many requests. Wait before trying again."],
    ] as const;
    // While the request runs, every control that could change or reveal the value is disabled.
    const pending = await holdRequests(t, page, `**/namespaces/${namespace.id}/secrets`, {
      once: true,
      method: "POST",
      fulfill: apiErrorResponse(409, "NAMESPACE_NOT_READY", "refused"),
    });
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    await pending.requested;
    for (const control of [
      dialog.getByRole("button", { name: "Create Secret", exact: true }),
      dialog.getByRole("button", { name: "Show value", exact: true }),
      dialog.getByLabel("Name", { exact: true }),
      dialog.getByLabel("Value", { exact: true }),
    ]) {
      assert.equal(await control.isDisabled(), true, "disabled while creating");
    }
    pending.release();
    await dialog.getByRole("alert").filter({ hasText: cases[0][1] }).waitFor();
    for (const [response, text] of cases) {
      const { status } = response;
      refusal = response;
      await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: text }).waitFor();
      const focused = await focusedRefusal();
      assert.equal(focused.inDialog, true, `${status}: focus stays in the dialog`);
      assert.equal(focused.role, "alert", `${status}: on the refusal`);
      assert.ok(focused.text.startsWith(text), `${status}: ${focused.text}`);
      assert.equal(focused.inView, true, `${status}: in view`);
    }
    // A name conflict shows the API's sentence and still puts focus on Name to change it.
    refusal = apiErrorResponse(409, "RESOURCE_CONFLICT", SECRET_NAME_CONFLICT);
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: SECRET_NAME_CONFLICT }).waitFor();
    assert.equal(
      await focusedId(page),
      await dialog.getByLabel("Name", { exact: true }).getAttribute("id"),
    );
    // A conflict that names no reason, either with no message at all (a body without the API's
    // envelope) or with the API's generic text, keeps the dialog's name and Namespace guidance
    // instead of the generic "Refresh, then try again" (review of #3690).
    const unexplained =
      "Secret creation conflicted. A Secret with this name may already exist in this Namespace. Check the name and Namespace state before trying again.";
    for (const response of [
      proxyErrorResponse(409),
      apiErrorResponse(409, "RESOURCE_CONFLICT", "The requested platform resource already exists."),
    ]) {
      refusal = response;
      await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: unexplained }).waitFor();
      assert.equal(await dialog.getByText(/Refresh, then try again/).count(), 0);
      assert.equal(await dialog.getByText(SECRET_NAME_CONFLICT).count(), 0);
    }
    // An unknown outcome disables Name, Value and the submit, so its message takes focus like a
    // refusal (finding 2075). It is last: the dialog refuses another try until a refresh.
    refusal = apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "refused");
    const unknown = "Secret creation outcome could not be confirmed. Refresh before trying again.";
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: unknown }).waitFor();
    const focused = await focusedRefusal();
    assert.equal(focused.inDialog, true, "503: focus stays in the dialog");
    assert.equal(focused.role, "alert", "503: on the message");
    assert.ok(focused.text.startsWith(unknown), `503: ${focused.text}`);
    assert.equal(focused.inView, true, "503: in view");
    for (const control of [
      dialog.getByRole("button", { name: "Create Secret", exact: true }),
      dialog.getByRole("button", { name: "Show value", exact: true }),
      dialog.getByLabel("Name", { exact: true }),
      dialog.getByLabel("Value", { exact: true }),
    ]) {
      assert.equal(await control.isDisabled(), true, "503: no other try until a refresh");
    }
    // The value the outcome may have stored is not kept in the page.
    assert.equal(await dialog.getByLabel("Value", { exact: true }).inputValue(), "");
  });
}
