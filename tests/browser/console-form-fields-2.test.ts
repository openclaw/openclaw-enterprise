import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { BrowserContextOptions, Locator, Page } from "playwright";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  consoleViewports,
  countInvalidEvents,
  detailUrl,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  selectSecret,
} from "./console-agents-browser-helpers.mjs";
import {
  openAdvancedSettings,
  openCreateSecretDialog,
  routeInstallationWithoutProvisioning,
  waitForCreateFormReads,
} from "./console-agents-test-support.mjs";

// The forms #2907 left on the browser's check (finding 1979): Plugin selections, the
// authentication source form and the workspace file editor. Each now checks its fields itself
// (UX plan C3): no transient bubble, a persistent error under the field, linked with
// aria-describedby and aria-invalid, and focus on the first field to fix. Slack channel
// credentials switched too, but Save stays disabled until both tokens are bound, and a bound
// picker passes, so no supported state reaches its check.

const browser = fileBrowser();

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// The control's error as a reader meets it: under the control, inside its field, in the danger
// colour, linked to the control, which has focus.
const shownError = (control: Locator) =>
  control.evaluate((node) => {
    const error = globalThis.document.getElementById(`${node.id}-error`);
    if (!error || error.hidden) {
      return null;
    }
    // Plugin selections JSON is a textarea in its own disclosure, not a labelled field.
    const field = node.closest(".field, .form-field, .channel-field, details.plugin-json");
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
      linked:
        node.getAttribute("aria-invalid") === "true" &&
        (node.getAttribute("aria-describedby") ?? "").split(/\s+/).includes(error.id),
      focused: globalThis.document.activeElement === node,
    };
  });

async function assertShownError(control: Locator, text: string) {
  assert.deepEqual(await shownError(control), {
    text,
    inField: true,
    below: true,
    danger: true,
    linked: true,
    focused: true,
  });
}

const PLUGIN_JSON_ERROR = "Enter a valid Plugin selections JSON object.";

async function openPluginJson(page: Page) {
  await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
  return page.getByLabel("Plugin selections JSON", { exact: true });
}

test("the authentication source form shows a missing Secret under its field", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Auth fields", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Auth Fields", nativeValues("af"), {
    harnessAuth: null,
  });
  const { page } = await newPage(t, fixture, { browser });
  const invalidEvents = await countInvalidEvents(page);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const method = page.getByLabel("Authentication source", { exact: true });
  const save = page.getByRole("button", { name: "Save authentication source", exact: true });
  await method.selectOption("api_key");
  await save.click();
  assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
  await assertShownError(
    page.getByLabel("API key Secret", { exact: true }),
    "API key Secret is required.",
  );
  // A source without a Secret field drops the error with the field.
  await method.selectOption("runtime");
  assert.equal(await page.locator("#harness-auth-secret-error:not([hidden])").count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// The renamed field's required error names the label the page shows (finding 1987), and the
// console's check leaves its list closed, so the error stays in sight (finding 1988).
test("the authentication source form names the Service account token Secret it requires", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Auth labels", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Auth Labels",
    nativeValues("al", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: null },
  );
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("Authentication source", { exact: true }).selectOption("codex_pat");
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  const token = page.getByLabel("Service account token Secret", { exact: true });
  await assertShownError(token, "Service account token Secret is required.");
  assert.equal(await token.getAttribute("aria-expanded"), "false", "the list stays closed");
  assert.equal(
    await token.evaluate((node) => {
      const error = globalThis.document.getElementById(`${node.id}-error`);
      if (!error) {
        throw new Error(`Missing field error for ${node.id}`);
      }
      const { left, top, height } = error.getBoundingClientRect();
      return error.contains(globalThis.document.elementFromPoint(left + 4, top + height / 2));
    }),
    true,
    "nothing covers the error",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("the workspace file editor shows an oversized file's error under the file", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace fields", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace Fields", nativeValues("wf"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const invalidEvents = await countInvalidEvents(page);
  const writes: string[] = [];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    (route) => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().method());
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { name: "AGENTS.md", content: "before" } }),
      });
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  const editor = page.getByLabel("AGENTS.md", { exact: true });
  const reload = page.getByRole("button", { name: "Reload AGENTS.md", exact: true });
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await editor.fill("a".repeat(16_385));
  const save = page.getByRole("button", { name: "Save AGENTS.md", exact: true });
  // Only the rule the file breaks (finding 2366).
  const error = "Use at most 16 KiB (16,384 UTF-8 bytes) in AGENTS.md.";
  // A second Save without an edit is checked the same way, not by the browser.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await save.click();
    assert.deepEqual(await invalidEvents(), [], `no browser validation bubble (${attempt})`);
    await assertShownError(editor, error);
  }
  assert.deepEqual(writes, []);
  // Its help stays linked beside the error, and an edit clears the error.
  assert.match(
    (await editor.getAttribute("aria-describedby")) ?? "",
    /\bworkspace-AGENTS\.md-hint\b/,
    "help stays linked",
  );
  await editor.fill("after");
  assert.equal(await shownError(editor), null);
  await editor.fill("x\0y");
  await save.click();
  await assertShownError(editor, "Use valid Unicode without NUL characters in AGENTS.md.");
  assert.deepEqual(writes, []);
  // A saved file keeps focus on its editor, though Save is disabled while it saves and after
  // (finding 2366).
  await editor.fill("after");
  await save.click();
  await page.getByText("AGENTS.md saved.", { exact: true }).waitFor();
  assert.equal(await hasFocus(editor), true, "focus stays on the saved file");
  // Reload replaces the file without an input event; the error goes with the refused text.
  await editor.fill("a".repeat(16_385));
  await save.click();
  await assertShownError(editor, error);
  await reload.click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), "before");
  assert.equal(await shownError(editor), null);
  assert.equal(await editor.getAttribute("aria-invalid"), null);
  assert.equal(await hasFocus(reload), true, "focus returns to Reload");
  // Focus the reader moves out of the file's form while it saves stays where they put it.
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    {
      once: true,
      method: "PUT",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { name: "AGENTS.md", content: "moved" } }),
      },
    },
  );
  await editor.fill("moved");
  await save.click();
  await write.requested;
  const agentsLink = page.getByRole("link", { name: "← Agents" });
  await agentsLink.focus();
  write.release();
  await page.getByText("AGENTS.md saved.", { exact: true }).waitFor();
  assert.equal(await hasFocus(agentsLink), true, "focus stays where the reader moved it");
});

// A Reload that finds the file gone empties the editor for a new file: the refused text's error
// goes with it, as it does on a Reload that reads the file (finding 1996).
test("the workspace file editor drops an oversized file's error when Reload finds no file", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace missing", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace Missing", nativeValues("wm"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const writes: string[] = [];
  let missing = false;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    (route) => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().method());
      }
      return route.fulfill(
        missing
          ? apiErrorResponse(404, "NOT_FOUND", "The requested workspace file was not found.")
          : {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ data: { name: "AGENTS.md", content: "before" } }),
            },
      );
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  const editor = page.getByLabel("AGENTS.md", { exact: true });
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await editor.fill("a".repeat(16_385));
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  await assertShownError(editor, "Use at most 16 KiB (16,384 UTF-8 bytes) in AGENTS.md.");
  // Removed elsewhere since it loaded.
  missing = true;
  await page.getByRole("button", { name: "Reload AGENTS.md", exact: true }).click();
  await page.getByText("AGENTS.md is missing. Save to create it.", { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), "");
  assert.equal(await shownError(editor), null);
  assert.equal(await editor.getAttribute("aria-invalid"), null);
  assert.deepEqual(writes, []);
});

// Choosing an issued ChatGPT service account without picking one is the console's check too: the
// error under the account list, which takes focus, not only the grey status line (finding 1997).
test("the authentication source form shows a missing service account under its field", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Account fields", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Account Fields",
    nativeValues("acf", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: null },
  );
  const { page } = await newPage(t, fixture, { browser });
  const invalidEvents = await countInvalidEvents(page);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("Authentication source", { exact: true }).selectOption("service_account");
  // The list is enabled once the Namespace's accounts are read; it has none.
  await page
    .getByText("No issued ChatGPT accounts available in this Namespace.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
  await assertShownError(
    page.getByLabel("Issued ChatGPT service account", { exact: true }),
    "Issued ChatGPT service account is required.",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Plugin selections on a draft Agent's Plugins tab: one console, an Agent for each case.
test("Plugin selections JSON", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Plugin fields", { ready: true });
  let agents = 0;
  const pluginsTab = async (t: TestContext, context?: BrowserContextOptions) => {
    agents += 1;
    const agent = await fixture.createAgent(
      namespace.id,
      `Plugin Fields ${agents}`,
      nativeValues(`pf${agents}`),
    );
    const { page } = await newPage(t, fixture, { browser, context });
    return { agent, page, url: detailUrl(fixture, namespace.id, agent.id, "draft", "plugins") };
  };

  for (const viewport of consoleViewports) {
    await t.test(
      `Plugin selections JSON shows its error under the field at ${viewport.width}px`,
      async (t) => {
        const { page, url } = await pluginsTab(t, { viewport });
        const invalidEvents = await countInvalidEvents(page);
        const requests = apiRequests(page, fixture.origin);
        await login(page, fixture, url);
        const pluginJson = await openPluginJson(page);
        await pluginJson.fill("[]");
        // The section closes so the check must open it again.
        await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
        await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
        assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
        await assertShownError(pluginJson, PLUGIN_JSON_ERROR);
        // The status line does not repeat the error.
        assert.equal(await page.getByText(PLUGIN_JSON_ERROR, { exact: true }).count(), 1);
        assert.deepEqual(nonAuthWriteRequests(requests), []);
        // An edit clears the error.
        await pluginJson.fill("{}");
        assert.equal(await shownError(pluginJson), null);
        assert.equal(await pluginJson.getAttribute("aria-invalid"), null);
      },
    );
  }

  // A Plugins save outcome takes focus only from the page or the disabled Save button: a reader
  // who moved focus while the save ran keeps it (finding 1978).
  const outcomes = [
    {
      name: "refusal",
      response: apiErrorResponse(409, "RESOURCE_CONFLICT", "Held."),
      shown: (page: Page) =>
        page.getByRole("alert").filter({
          hasText:
            "Plugin changes conflict with the current Agent state. Refresh this Agent before retrying.",
        }),
      takesFocus: (page: Page) =>
        page.getByRole("alert").filter({ hasText: "Plugin changes conflict" }),
    },
    {
      name: "unknown outcome",
      response: apiErrorResponse(500, "INTERNAL_ERROR", "Held."),
      shown: (page: Page) =>
        page.getByText(
          "Outcome unknown. Plugin selections may have been saved. Reload this Agent before trying again.",
          { exact: true },
        ),
      takesFocus: (page: Page) =>
        page.getByRole("button", { name: "Reload plugin selections", exact: true }),
    },
  ];
  for (const outcome of outcomes) {
    for (const moved of [false, true]) {
      await t.test(
        `a Plugins save ${outcome.name} ${moved ? "leaves focus where the reader moved it" : "takes focus from the Save button"}`,
        async (t) => {
          const { agent, page, url } = await pluginsTab(t);
          await login(page, fixture, url);
          const pluginJson = await openPluginJson(page);
          await pluginJson.fill("{}\n");
          const patch = await holdRequests(
            t,
            page,
            `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
            { method: "PATCH", fulfill: outcome.response },
          );
          await page.getByRole("button", { name: "Save plugin selections", exact: true }).focus();
          await page.keyboard.press("Enter");
          await patch.requested;
          if (moved) {
            // Plugin selections JSON is read-only while the save runs, but still takes focus.
            await pluginJson.focus();
          }
          patch.release();
          await outcome.shown(page).waitFor();
          // The outcome and its focus move are one task: once it shows, focus has settled.
          const target = moved ? pluginJson : outcome.takesFocus(page);
          assert.equal(
            await hasFocus(target),
            true,
            moved ? "focus stays on Plugin selections JSON" : "the outcome takes focus",
          );
        },
      );
    }
  }
});

// Create Agent and its inline Create Secret dialog check what the API would refuse before any
// write, naming the field and the rule (findings 2339-2341). The API stays the authority.
test("Create Agent refuses what the API would refuse before any write", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const NAME_RULE = "Remove tabs, line breaks and other control characters from the name.";
  // The form lists the Namespace's Secrets when it opens, so a Secret to choose exists first.
  const createForm = async (t: TestContext, label: string, secretName?: string) => {
    const namespace = await fixture.createNamespace(label, { ready: true });
    const secret = secretName
      ? await fixture.createSecret(namespace.id, secretName, `${label} value`)
      : null;
    const { page } = await newPage(t, fixture, { browser });
    const invalidEvents = await countInvalidEvents(page);
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await waitForCreateFormReads(page);
    if (secret) {
      // A complete form apart from the field under test, so that field is the first to fix.
      await selectSecret(page, "API key Secret", secret);
      const model = page.getByLabel("Model ID", { exact: true });
      if (!(await model.isVisible())) {
        await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
      }
      await model.fill("gpt-4.1");
    }
    return { page, invalidEvents, requests };
  };

  // Finding 2340: a control character in the Agent name was sent, and in the existing-Secret
  // flow the Configuration was saved before the API refused the name.
  await t.test("the Agent name follows the API's Name rule", async (t) => {
    const { page, invalidEvents, requests } = await createForm(t, "Agent name rule", "Name key");
    const name = page.getByLabel("Agent name", { exact: true });
    const create = page.getByRole("button", { name: "Create Agent", exact: true });
    for (const value of ["Support\tbot", "Support\u0085bot", "Support\u2028bot"]) {
      await name.fill(value);
      await create.click();
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      await assertShownError(name, NAME_RULE);
    }
    assert.deepEqual(nonAuthWriteRequests(requests), [], "nothing is saved");
  });

  // Finding 2341: an oversized or NUL workspace file was refused by the API with a message that
  // named no file, inside the collapsed Advanced settings.
  await t.test("initial workspace files follow the Workspace tab's rule", async (t) => {
    const { page, invalidEvents, requests } = await createForm(t, "Workspace rule", "Files key");
    await page.getByLabel("Agent name", { exact: true }).fill("Workspace rule");
    await openAdvancedSettings(page);
    const agents = page.getByLabel("AGENTS.md", { exact: true });
    const create = page.getByRole("button", { name: "Create Agent", exact: true });
    const advanced = page.locator(".launch-advanced");
    const tooLarge = "Use at most 16 KiB (16,384 UTF-8 bytes) in AGENTS.md.";
    for (const [content, error] of [
      ["a".repeat(16_385), tooLarge],
      ["\u00e9".repeat(8_193), tooLarge],
      ["x\0y", "Use valid Unicode without NUL characters in AGENTS.md."],
    ] as const) {
      await agents.fill(content);
      // Advanced settings closes, so the check must open it to show the file.
      await advanced.locator("> summary").click();
      await create.click();
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      assert.equal(await advanced.evaluate((node) => (node as HTMLDetailsElement).open), true);
      await assertShownError(agents, error);
    }
    assert.deepEqual(nonAuthWriteRequests(requests), [], "nothing is saved");
  });

  // Finding 2339: the dialog checked only that its fields were filled, and its password input
  // dropped a pasted value's line breaks.
  await t.test("the inline Create Secret dialog follows the API's Secret rules", async (t) => {
    const { page, invalidEvents, requests } = await createForm(t, "Secret dialog rules");
    // The suggested Name carries the Agent name and arrives without an input event: the submit
    // checks it too.
    await page.getByLabel("Agent name", { exact: true }).fill("Support\tbot");
    await openCreateSecretDialog(page, "API key Secret");
    const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
    const name = dialog.getByLabel("Name", { exact: true });
    const value = dialog.getByLabel("Value", { exact: true });
    const submit = dialog.getByRole("button", { name: "Create Secret", exact: true });
    // The value help says in plain words what is kept, short enough for the phone sheet
    // (finding 2388).
    assert.match(
      await dialog.locator(".secret-value-field").innerText(),
      /The value is never read back\. Spaces kept; line breaks normalized\./,
    );
    assert.equal(await name.inputValue(), "Support\tbot model credential");
    await value.fill("token");
    await submit.click();
    assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
    await assertShownError(name, NAME_RULE);
    // An edited Name is checked too.
    await name.fill("model\tkey");
    await submit.click();
    assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
    await assertShownError(name, NAME_RULE);
    // Show value unmasks the value and says so; pressing it again masks it.
    const reveal = dialog.getByRole("button", { name: "Show value", exact: true });
    await reveal.click();
    const hide = dialog.getByRole("button", { name: "Hide value", exact: true });
    assert.equal(await hide.getAttribute("aria-pressed"), "true");
    assert.equal(
      await value.evaluate((node) => node.classList.contains("secret-value--masked")),
      false,
    );
    await hide.click();
    assert.equal(await reveal.getAttribute("aria-pressed"), "false");
    assert.equal(
      await value.evaluate((node) => node.classList.contains("secret-value--masked")),
      true,
    );
    await name.fill("Model key");
    for (const [content, rule] of [
      ["to\0ken", "Use valid UTF-8 without NUL characters."],
      ["\u00e9".repeat(32_769), "Use at most 65,536 UTF-8 bytes."],
    ] as const) {
      await value.fill(content);
      await submit.click();
      assert.deepEqual(await invalidEvents(), [], "no browser validation bubble");
      await assertShownError(value, rule);
    }
    assert.deepEqual(nonAuthWriteRequests(requests), [], "no Secret is created");
    // A multiline credential is sent exactly as entered.
    const multiline = "-----BEGIN KEY-----\nline two\n  indented\n-----END KEY-----";
    await value.fill(multiline);
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
    const created = nonAuthWriteRequests(requests).filter((request) =>
      request.path.endsWith("/secrets"),
    );
    assert.deepEqual(
      created.map((request) => request.body),
      [{ name: "Model key", value: multiline }],
    );
  });
});
