import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  operateDeniedSecretOption,
  pathRequests,
  selectSecret,
  settledView,
  statusTone,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  enterManualModel,
  openAdvancedSettings,
  submitCreateAgent,
} from "./console-agents-test-support.mjs";
import {
  callerDenied,
  refusedNamed,
  SECRET_CREATE_DENIED,
  SLACK_LOOKUP_DENIED,
} from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

test("Plugin details refresh preserves the user's current keyboard focus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  for (const destination of ["Beta", "Search plugins"]) {
    const { page } = await newPage(t, fixture, { browser });
    const requested = Promise.withResolvers();
    const released = Promise.withResolvers();
    t.after(() => released.resolve());
    await page.exposeFunction("waitForPluginDetails", () => {
      requested.resolve();
      return released.promise;
    });
    await login(page, fixture, "/console");
    // Sign-in reloads the page after its session check, and that reload closes every open
    // dialog in the document: mount the component once the Agents page has settled.
    await page.locator(settledView).waitFor();
    // Exercise the served Console component with a held synthetic catalog update.
    await page.evaluate(async () => {
      const { createPluginFields } = await import("/console/agents/plugin-fields.mjs");
      const alpha = { id: "alpha", name: "Alpha", remoteId: "alpha", tools: null };
      const beta = { id: "beta", name: "Beta", tools: [] };
      const catalog = { status: "ready", canLoad: true, entries: [alpha, beta] };
      const input = globalThis.document.createElement("textarea");
      input.id = "plugin-focus-selections";
      input.value = "{}";
      const fields = createPluginFields({
        input,
        catalog,
        async onLoadTools() {
          await globalThis.waitForPluginDetails();
          fields.setCatalog({ ...catalog, entries: [{ ...alpha, tools: [] }, beta] });
        },
      });
      globalThis.document.body.append(fields.section);
    });
    await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Configure plugins" });
    const alpha = dialog.getByRole("button", { name: "Alpha", exact: true });
    const beta = dialog.getByRole("button", { name: "Beta", exact: true });
    const search = dialog.getByLabel("Search plugins");
    await alpha.click();
    await requested.promise;
    await alpha.focus();
    await page.keyboard.press("Tab");
    const isFocused = (node) => node === node.ownerDocument.activeElement;
    assert.equal(await beta.evaluate(isFocused), true);
    if (destination === "Search plugins") {
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
    }
    const expected = destination === "Beta" ? beta : search;
    assert.equal(await expected.evaluate(isFocused), true);
    released.resolve();
    await dialog.getByText("No tools listed for this plugin.").waitFor();
    assert.equal(await expected.evaluate(isFocused), true);
  }
});

// Each redraw (tool details arriving, for one) used to rewrite the dialog's status lines with the
// same words, so screen readers could announce "Page 1 · 2 plugins" again (finding 1890). Live
// regions change only when their text does.
test("Plugin dialog redraws leave unchanged live regions alone", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console");
  // As above: the dialog opens only after sign-in's reload of the page.
  await page.locator(settledView).waitFor();
  await page.evaluate(async () => {
    const { createPluginFields } = await import("/console/agents/plugin-fields.mjs");
    const alpha = { id: "alpha", name: "Alpha", remoteId: "alpha", tools: null };
    const beta = { id: "beta", name: "Beta", tools: [] };
    const catalog = { status: "ready", canLoad: true, entries: [alpha, beta] };
    const input = globalThis.document.createElement("textarea");
    input.id = "plugin-live-selections";
    input.value = "{}";
    const fields = createPluginFields({
      input,
      catalog,
      async onLoadTools() {
        fields.setCatalog({ ...catalog, entries: [{ ...alpha, tools: [] }, beta] });
      },
    });
    // Shows the second catalog page with the given Plugin selections JSON.
    globalThis.showPluginPage2 = (selections = "{}") => {
      input.value = selections;
      fields.setCatalog({ ...catalog, pageNumber: 2, entries: [{ ...alpha, tools: [] }, beta] });
    };
    globalThis.document.body.append(fields.section);
  });
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins" });
  await dialog.getByText("Page 1 · 2 plugins", { exact: true }).waitFor();
  // Every text change inside the dialog's live regions, as region text after the change.
  await dialog.evaluate((node) => {
    globalThis.liveWrites = [];
    const regions = [...node.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];
    const observer = new globalThis.MutationObserver((records) => {
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        globalThis.liveWrites.push(target.textContent);
      }
    });
    for (const region of regions) {
      observer.observe(region, { childList: true, characterData: true, subtree: true });
    }
    globalThis.liveRegions = regions.map((region) => region.textContent);
  });
  const liveWrites = () => page.evaluate(() => globalThis.liveWrites.splice(0));
  assert.ok(
    (await page.evaluate(() => globalThis.liveRegions)).includes(
      "This installation does not support plugin policy editing. You can browse plugins; existing settings are preserved.",
    ),
  );

  // Opening Alpha loads its tools; the dialog redraws twice with the same status lines.
  await dialog.getByRole("button", { name: "Alpha", exact: true }).click();
  await dialog.getByText("No tools listed for this plugin.").waitFor();
  assert.deepEqual(await liveWrites(), []);
  // A real change is written once, and a redraw after it writes nothing.
  await page.evaluate(() => globalThis.showPluginPage2());
  await dialog.getByText("Page 2 · 2 plugins", { exact: true }).waitFor();
  assert.deepEqual(await liveWrites(), ["Page 2 · 2 plugins"]);
  const invalid =
    "Fix Plugin selections JSON to use the controls. Check plugin enablement and tool policies. Your JSON has been kept.";
  await page.evaluate(() => globalThis.showPluginPage2("["));
  await dialog.getByText(invalid, { exact: true }).waitFor();
  assert.deepEqual(await liveWrites(), [invalid]);
  assert.deepEqual(await statusTone(dialog.getByText(invalid, { exact: true })), {
    className: "status",
    tone: "danger",
    role: "alert",
  });
  await page.evaluate(() => globalThis.showPluginPage2("["));
  assert.deepEqual(await liveWrites(), []);
});

test("Create Agent searches approvers with a search-only Slack Secret", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  );
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [preset] });
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Approver search", { ready: true });
  const bot = await fixture.createSecret(namespace.id, "Search bot", "synthetic-slack-token");
  const { page, artifacts } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const lookups = [];
  const lookupStarted = Promise.withResolvers();
  const releaseLookup = Promise.withResolvers();
  t.after(() => releaseLookup.resolve());
  let denied = false;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      lookups.push(body);
      if (body.ids?.includes("UTEST123")) {
        lookupStarted.resolve();
        await releaseLookup.promise;
      }
      if (denied) {
        await route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            workspaceName: "Test workspace",
            candidates:
              !body.query || "freeman".includes(body.query.toLowerCase())
                ? [{ id: "UTEST123", name: "freeman", displayName: "Freeman Example" }]
                : [],
            complete: true,
          },
          meta: { requestId: "req_test_directory" },
        }),
      });
    },
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await openAdvancedSettings(page);
  // The approvers select looks like every other select on the form: it was bold with a thin
  // square border and no padding (finding 2401).
  const controlStyle = (locator) =>
    locator.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return {
        border: `${style.borderTopWidth} ${style.borderTopColor}`,
        radius: style.borderTopLeftRadius,
        padding: style.padding,
        minHeight: style.minHeight,
        weight: style.fontWeight,
      };
    });
  assert.deepEqual(
    await controlStyle(page.getByLabel("Default plugin approvers mode")),
    await controlStyle(page.getByLabel("Provider", { exact: true })),
  );
  await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
  const people = page.getByRole("combobox", {
    name: "Default plugin approvers people",
    exact: true,
  });
  await people.fill("free");
  await page
    .getByText("Select a Slack bot token Secret to search by name. You can still paste exact IDs.")
    .first()
    .waitFor();
  await people.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: join(artifacts, "approver-before-search.png") });
  const secret = page.getByLabel("Slack bot token Secret for people search", { exact: true });
  assert.equal(await secret.count(), 1);
  await people.fill("UOTHER123");
  await people.press("Enter");
  await page.locator('.slack-directory-chip[data-value="UOTHER123"]').waitFor();
  await page.getByRole("button", { name: "Remove selected person 1 (name unavailable)" }).click();
  await selectSecret(page, "Slack bot token Secret for people search", bot);
  denied = true;
  await people.fill("denied");
  // The API named no grant here, so the console names the Secret's.
  await page.getByText(SLACK_LOOKUP_DENIED).waitFor();
  denied = false;
  await people.fill("nobody");
  await page.getByText("No matches found. Try another name or paste an exact ID.").waitFor();
  await people.fill("free");
  await page.getByRole("option", { name: /Freeman Example.*@freeman/ }).waitFor();
  await people.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: join(artifacts, "approver-results.png") });
  await people.press("ArrowDown");
  await people.press("Enter");
  // Hold name resolution at the first selected frame. The search result already identified this person.
  await lookupStarted.promise;
  const chip = page.locator(".slack-directory-chip");
  assert.equal(await chip.locator("span").innerText(), "Freeman Example (@freeman)");
  await chip
    .getByRole("button", { name: "Remove Freeman Example (@freeman)", exact: true })
    .waitFor();
  releaseLookup.resolve();
  assert.ok(lookups.some((body) => body.secretId === bot.id && body.query === "free"));
  await page.getByLabel("Agent name").fill("Approver search Agent");
  await enterManualModel(page, "synthetic-model-key", "gpt-5.1");
  await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
  const body = pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`).at(-1).body;
  assert.deepEqual(body.pluginApprovers, [{ channel: "slack", id: "team:TTEST123:user:UTEST123" }]);
  const configuration = pathRequests(
    requests,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
  ).at(-1).body;
  assert.equal(configuration.secretBindings?.SLACK_BOT_TOKEN, undefined);
});

test("Create Agent keeps the search Secret out of plugin approver lookups", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  );
  const pluginId = "occ-plugin:diffs";
  preset.template.agent.plugins = {
    [pluginId]: { enabled: true, approvers: [{ channel: "slack", id: "UOTHER123" }] },
  };
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [preset] });
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Approver privacy", { ready: true });
  const bot = await fixture.createSecret(namespace.id, "Search bot", "synthetic-slack-token");
  const spare = await fixture.createSecret(namespace.id, "Spare bot", "synthetic-spare-token");
  // This administrator may not create Secrets in the Namespace, so the Namespace permission answer
  // denies Secret create; nothing here creates one.
  restrict(fixture.policy, "create", "secret", { namespaceId: namespace.id });
  // Nor operate the spare token, which a people search needs on its Secret (finding 2469).
  restrict(fixture.policy, "operate", "secret", {
    namespaceId: namespace.id,
    resourceId: spare.id,
  });
  const { page } = await newPage(t, fixture, { browser });
  const lookups = [];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      lookups.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { workspaceId: "TTEST123", candidates: [], complete: true },
          meta: { requestId: "req_test_directory" },
        }),
      });
    },
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
  // The people search's Secret picker follows the answer: its inline Create Secret is disabled
  // with the reason (finding 2451).
  await page
    .getByLabel("Slack bot token Secret for people search", { exact: true })
    .fill("no matching Secret");
  const createAction = page
    .locator('[id^="approver-directory-secret-option-"]')
    .filter({ hasText: "Create new Secret..." });
  assert.equal(await createAction.textContent(), `Create new Secret... ${SECRET_CREATE_DENIED}`);
  assert.equal(await createAction.getAttribute("aria-disabled"), "true");
  // The spare token is listed disabled with the reason, and a forced click chooses nothing, so
  // no search is made with it.
  const deniedSpare = await operateDeniedSecretOption(
    page,
    "Slack bot token Secret for people search",
    spare,
  );
  await deniedSpare.click({ force: true });
  await page.getByLabel("Slack bot token Secret for people search", { exact: true }).press("Enter");
  assert.equal(await page.getByText("Ready to search.").count(), 0);
  await selectSecret(page, "Slack bot token Secret for people search", bot);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  const pluginPeople = dialog.getByRole("combobox", {
    name: `${pluginId} plugin approvers people`,
    exact: true,
  });
  await pluginPeople.fill("unrelated");
  await dialog
    .getByText("Select a Slack bot token Secret to search by name. You can still paste exact IDs.")
    .first()
    .waitFor();
  assert.deepEqual(lookups, []);
});

test("Agent plugin approver selectors save inheritance and workspace-qualified users", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  // Plugin and tool overrides need a Driver that advertises them; Codex offers only the default.
  const pluginDriver = new OCCPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Slack directory picker", { ready: true });
  const appSecret = await fixture.createSecret(namespace.id, "Slack app token", "xapp-test-secret");
  const botSecret = await fixture.createSecret(namespace.id, "Slack bot token", "xoxb-test-secret");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "disabled",
    channels: { CEXIST123: { requireMention: true, users: ["*"] } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Directory Agent",
    nativeValues("slack-directory", { channels: { slack } }),
    {
      // Channels need a dedicated Agent workload, which Agent save checks.
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const pluginId = "occ-plugin:diffs";
  const toolId = "diffs";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: { [pluginId]: { enabled: true, tools: { [toolId]: { enabled: true } } } },
  });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies = [];
  let directoryAvailable = true;
  let directoryDenied = false;
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      directoryBodies.push(body);
      if (directoryDenied) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: callerDenied("Secret operate", "a Secret this request uses"),
            },
            meta: { requestId: "req_test_slack_directory_denied" },
          }),
        });
        return;
      }
      if (!directoryAvailable) {
        await route.fulfill({
          status: 501,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "NOT_IMPLEMENTED", message: "Directory unavailable" },
            meta: { requestId: "req_test_slack_directory_unavailable" },
          }),
        });
        return;
      }
      const candidates =
        body.kind === "users"
          ? [{ id: "UTEST123", name: "alex", displayName: "Alex" }]
          : [
              { id: "CEXIST123", name: "existing-room" },
              { id: "CTEST456", name: "release-room" },
            ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            workspaceName: "Test workspace",
            candidates: body.ids
              ? candidates.filter((candidate) => body.ids.includes(candidate.id))
              : candidates,
            complete: true,
          },
          meta: { requestId: "req_test_slack_directory" },
        }),
      });
    },
  );

  const pluginsUrl = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, pluginsUrl);
  await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
  const people = page.getByRole("combobox", {
    name: "Default plugin approvers people",
    exact: true,
  });
  const picker = people.locator("..").locator("..");
  await people.focus();
  await picker.getByRole("option", { name: /Alex.*@alex/ }).waitFor();
  const searched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/channel-directory/lookup`) &&
      response.request().postDataJSON()?.query === "Alex",
  );
  await people.fill("Alex");
  await searched;
  const result = picker.getByRole("option", { name: /Alex.*@alex/ });
  await result.waitFor();
  const resultNode = await result.elementHandle();
  const lookupCount = directoryBodies.length;
  const sessionPath = `${fixture.origin}/api/auth/session`;
  const session = await holdRequests(t, page, sessionPath, { afterServer: true, timeout: 0 });

  // Refocus checks access without discarding an open search or repeating its lookup.
  const beforeRefocus = requests.length;
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  await session.requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
  await nextFrames(page);
  // While the session answer is held the view stays inert with the search still open, and the
  // check has not gone on to read the Namespaces.
  assert.equal(await people.inputValue(), "Alex");
  assert.equal(await people.getAttribute("aria-expanded"), "true");
  assert.equal(await resultNode.evaluate((node) => node.isConnected), true);
  assert.deepEqual(pathRequests(requests.slice(beforeRefocus), "GET", "/namespaces"), []);
  session.release();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(await people.inputValue(), "Alex");
  assert.equal(await people.getAttribute("aria-expanded"), "true");
  assert.equal(await resultNode.evaluate((node) => node.isConnected), true);
  assert.equal(directoryBodies.length, lookupCount);
  await page.unroute(sessionPath);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).focus();
  assert.equal(await people.getAttribute("aria-expanded"), "false");
  const peopleNode = await people.elementHandle();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await people.waitFor({ state: "detached" });
  assert.equal(await peopleNode.evaluate((node) => node.isConnected), false);
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await people.waitFor();
  assert.equal(await peopleNode.evaluate((node) => node.isConnected), true);
  assert.equal(await resultNode.evaluate((node) => node.isConnected), true);
  assert.equal(await people.inputValue(), "Alex");
  const resolvedSelection = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/channel-directory/lookup`) &&
      response.request().postDataJSON()?.ids?.includes("UTEST123"),
  );
  await people.focus();
  await result.waitFor();
  await result.click();
  await resolvedSelection;
  await picker
    .locator('.slack-directory-chip[data-value="team:TTEST123:user:UTEST123"]')
    .getByText("Alex (@alex)")
    .waitFor();
  const selectedPeopleNode = await people.elementHandle();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await people.waitFor({ state: "detached" });
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await people.waitFor();
  assert.equal(await selectedPeopleNode.evaluate((node) => node.isConnected), true);
  assert.equal(
    await picker.locator('.slack-directory-chip[data-value="team:TTEST123:user:UTEST123"]').count(),
    1,
  );
  await picker.getByRole("button", { name: "Remove Alex (@alex)", exact: true }).click();
  await people.fill("team:TOTHER123:user:UTEST123");
  await people.press("Enter");
  await picker
    .getByText("This bot belongs to workspace TTEST123. Enter a user in that workspace.")
    .waitFor();
  assert.deepEqual(
    await statusTone(
      picker.getByText("This bot belongs to workspace TTEST123. Enter a user in that workspace."),
    ),
    { className: "status", tone: "danger", role: "alert" },
  );
  directoryAvailable = false;
  await people.fill("UTEST999");
  await picker.getByText("Slack directory lookup is unavailable.").waitFor();
  await people.press("Enter");
  await picker
    .locator('.slack-directory-chip[data-value="UTEST999"]')
    .getByText("Name unavailable")
    .waitFor();
  await picker
    .getByRole("button", { name: "Remove selected person 1 (name unavailable)", exact: true })
    .click();
  // The lookup checks several grants, so a refusal shows the one the API names (finding D753).
  directoryDenied = true;
  await people.fill("UTEST998");
  await picker
    .getByText(refusedNamed("Slack lookup", "Secret operate", "a Secret this request uses"))
    .waitFor();
  directoryDenied = false;
  directoryAvailable = true;
  await people.fill("Alex");
  await picker.getByRole("option", { name: /Alex.*@alex/ }).click();
  assert.equal(
    await picker.locator('.slack-directory-chip[data-value="team:TTEST123:user:UTEST123"]').count(),
    1,
  );
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const pluginDialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await pluginDialog.getByRole("button", { name: pluginId, exact: true }).click();
  await pluginDialog.getByLabel(`${pluginId} plugin approvers mode`).selectOption("none");
  const toolRow = pluginDialog.locator(`details.plugin-tool-row[data-tool="${toolId}"]`);
  await toolRow.locator("summary").click();
  await toolRow.getByLabel(`${toolId} tool approvers mode`).selectOption("chosen");
  const toolPeople = toolRow.getByRole("combobox", {
    name: `${toolId} tool approvers people`,
    exact: true,
  });
  directoryAvailable = false;
  await toolPeople.fill("UTEST123");
  await toolRow.getByText("Slack directory lookup is unavailable.").waitFor();
  await toolPeople.press("Enter");
  await pluginDialog.getByRole("button", { name: "Done", exact: true }).click();
  const savedApprovers = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections" }).click();
  assert.equal((await savedApprovers).status(), 200);
  const approvers = [{ channel: "slack", id: "team:TTEST123:user:UTEST123" }];
  assert.deepEqual(
    pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`).at(-1).body
      .pluginApprovers,
    approvers,
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .pluginApprovers,
    approvers,
  );
  let savedAgent = (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
    .data;
  assert.deepEqual(savedAgent.plugins[pluginId].approvers, []);
  assert.deepEqual(savedAgent.plugins[pluginId].tools[toolId].approvers, [
    { channel: "slack", id: "UTEST123" },
  ]);
  directoryAvailable = true;
  assert.deepEqual(directoryBodies[0], {
    secretId: botSecret.id,
    kind: "users",
    agentId: agent.id,
  });

  await page.goto(pluginsUrl.href);
  await page
    .locator('.slack-directory-chip[data-value="team:TTEST123:user:UTEST123"]')
    .getByText("Alex")
    .waitFor();
  assert.ok(
    directoryBodies.some(
      (body) =>
        body.agentId === agent.id && body.kind === "users" && body.ids?.includes("UTEST123"),
    ),
  );

  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const reopenedPlugins = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await reopenedPlugins.getByRole("button", { name: pluginId, exact: true }).click();
  const reopenedTool = reopenedPlugins.locator(`details.plugin-tool-row[data-tool="${toolId}"]`);
  await reopenedTool.locator("summary").click();
  await reopenedTool.getByLabel(`${toolId} tool approvers mode`).selectOption("inherit");
  await reopenedPlugins.getByRole("button", { name: "Done", exact: true }).click();
  const savedInheritance = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections" }).click();
  assert.equal((await savedInheritance).status(), 200);
  savedAgent = (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
    .data;
  assert.deepEqual(savedAgent.plugins[pluginId].approvers, []);
  assert.deepEqual(savedAgent.plugins[pluginId].tools[toolId], { enabled: true });

  await page.goto(pluginsUrl.href);
  await page.getByLabel("Default plugin approvers mode").selectOption("inherit");
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  assert.equal(await page.getByLabel("Default plugin approvers mode").inputValue(), "inherit");
  const clearedDefault = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections" }).click();
  assert.equal((await clearedDefault).status(), 200);
  assert.equal(
    pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`).at(-1).body
      .pluginApprovers,
    null,
  );
  savedAgent = (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
    .data;
  assert.equal(Object.hasOwn(savedAgent, "pluginApprovers"), false);
});

test("Unsaved default plugin approvers block deployment after leaving Plugins", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Unsaved plugin approvers");
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Approver Draft Agent",
    nativeValues("approver-draft"),
    { executionMode: "embedded", harnessAuth: { method: "runtime" } },
  );
  const { page } = await newPage(t, fixture, { browser });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await waitForEnabled(deploy);

  await page.getByLabel("Default plugin approvers mode").selectOption("none");
  assert.equal(await deploy.isDisabled(), true);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  assert.equal(await page.getByLabel("Default plugin approvers mode").inputValue(), "none");
  await page
    .getByText("Save or discard plugin changes before deploying.", { exact: true })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);
});

// A member who can only read the Agent sees the draft's saved default approvers, which the next
// deployment uses. The approver field waits for the policy capabilities, a read that needs Agent
// update and is skipped for this reader, so they show as text, as a version's snapshot does
// (finding 2447).
test("A reader sees the version draft's default plugin approvers", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Reader plugin approvers");
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Reader Approver Agent",
    nativeValues("reader-approvers"),
    { executionMode: "embedded", harnessAuth: { method: "runtime" } },
  );
  const approver = "team:TTEST123:user:UREADER1";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    pluginApprovers: [{ channel: "slack", id: approver }],
  });
  const reader = await fixture.createNamespaceMember("approver-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "agent_revision"],
    ["read", "configuration"],
  ]);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
    reader.credentials,
  );
  await page
    .getByText("These are the version draft's plugin selections, read-only", { exact: false })
    .waitFor();
  const saved = page.locator(".plugin-approvers-saved");
  await saved.getByRole("heading", { name: "Default plugin approvers", exact: true }).waitFor();
  await saved.getByText("The next deployment uses these Agent default approvers.").waitFor();
  assert.deepEqual(await saved.getByRole("listitem").allTextContents(), [`slack: ${approver}`]);
  // No editable field stands in for the text, and no capabilities read answers 403.
  assert.equal(await page.getByLabel("Default plugin approvers mode").isVisible(), false);
  assert.deepEqual(pathRequests(requests, "GET", `${path}/plugins/capabilities`), []);
});

test("Codex Agents offer only default plugin approvers", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Codex plugin approvers");
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Codex Approver Agent",
    nativeValues("codex-approvers"),
    { executionMode: "embedded", harnessAuth: { method: "runtime" } },
  );
  const pluginId = "codex-plugin:calendar@openai-curated-remote";
  const toolId = "app_calendar/create_event";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: { [pluginId]: { enabled: true, tools: { [toolId]: { enabled: true } } } },
  });
  const { page } = await newPage(t, fixture, { browser });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  // Codex approval requests carry no plugin or tool identity, so the API refuses those
  // overrides and the Console must not offer them. The Agent default stays available.
  await page.getByLabel("Default plugin approvers mode").waitFor();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const pluginDialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await pluginDialog.getByRole("button", { name: pluginId, exact: true }).click();
  const toolRow = pluginDialog.locator(`details.plugin-tool-row[data-tool="${toolId}"]`);
  await toolRow.locator("summary").click();
  await toolRow.getByLabel(`${toolId} require approval for`).waitFor();
  assert.equal(await pluginDialog.getByLabel(`${pluginId} plugin approvers mode`).count(), 0);
  assert.equal(await toolRow.getByLabel(`${toolId} tool approvers mode`).count(), 0);
});

test("No Slack approvers does not ask the operator to select hidden people", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console");
  await page.locator(settledView).waitFor();
  const hints = await page.evaluate(async () => {
    const { createSlackApproverField } = await import("/console/agents/slack-approvers.mjs");
    let value = [];
    const field = createSlackApproverField({
      context: {
        namespaceId: "ns_1",
        request() {
          return Promise.resolve({ candidates: [], truncated: false });
        },
        isCurrent() {
          return true;
        },
        onExpired() {},
      },
      label: "Approvers",
      allowInherit: false,
      getSecretId() {
        return "sec_1";
      },
      getValue() {
        return value;
      },
      onChange(next) {
        value = next;
      },
    });
    globalThis.document.body.append(field);
    const helper = field.querySelector("p.hint");
    const picker = field.querySelector(".slack-directory-field");
    const select = field.querySelector("select");
    const none = { hint: helper.textContent, pickerHidden: picker.hidden };
    select.value = "chosen";
    select.dispatchEvent(new Event("change"));
    const chosen = { hint: helper.textContent, pickerHidden: picker.hidden };
    value = [{ channel: "teams", id: "person-1" }];
    select.value = "none";
    select.dispatchEvent(new Event("change"));
    return {
      none,
      chosen,
      preserved: { hint: helper.textContent, pickerHidden: picker.hidden },
    };
  });
  assert.equal(hints.none.hint, "No Slack user can approve.");
  assert.equal(hints.none.pickerHidden, true);
  assert.equal(hints.chosen.hint, "No Slack user can approve until people are selected.");
  assert.equal(hints.chosen.pickerHidden, false);
  assert.equal(
    hints.preserved.hint,
    "No Slack user can approve. 1 other channel entries are preserved.",
  );
  assert.equal(hints.preserved.pickerHidden, true);
});
