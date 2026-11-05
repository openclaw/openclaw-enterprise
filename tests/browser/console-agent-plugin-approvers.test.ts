import {
  enterManualModel,
  openAdvancedSettings,
  submitCreateAgent,
} from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Locator } from "playwright";
import type { PluginFieldCatalog } from "../../apps/controller/src/console/agents/plugin-fields.mjs";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import type { PluginApprovers, SecretMetadata } from "../../packages/contracts/src/index.ts";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { importedPluginPackage } from "../helpers/imported-plugin-package.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
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
} from "./console-agents-browser-helpers.ts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.ts";
import {
  callerDenied,
  refusedNamed,
  SECRET_CREATE_DENIED,
  SLACK_LOOKUP_DENIED,
} from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function entity(value: unknown): Record<string, unknown> & { id: string } {
  const result = record(value);
  return { ...result, id: text(result.id) };
}

function agentEntity(value: unknown) {
  const result = entity(value);
  return { ...result, configurationId: text(result.configurationId) };
}

function responseData(value: unknown) {
  return record(record(value).data);
}

function controller(fixture: Fixture): OpenClawController {
  const value: unknown = fixture.controller;
  assert.ok(value instanceof OpenClawController);
  return value;
}

function secretEntity(value: unknown): SecretMetadata {
  const result = record(value);
  const ref = record(result.ref);
  assert.equal(ref.kind, "secret");
  return {
    id: text(result.id),
    name: text(result.name),
    namespaceId: text(result.namespaceId),
    ref: { kind: "secret", id: text(ref.id), namespaceId: text(ref.namespaceId) },
  };
}

function lastBody(requests: ReturnType<typeof pathRequests>) {
  const request = requests.at(-1);
  assert.ok(request, "Expected an API request");
  return record(request.body);
}

type LookupBody = Record<string, unknown> & { ids?: string[]; query?: string };

function isLookupBody(body: Record<string, unknown>): body is LookupBody {
  const ids: unknown = body.ids;
  return (
    (ids === undefined ||
      (Array.isArray(ids) && ids.every((id: unknown) => typeof id === "string"))) &&
    (body.query === undefined || typeof body.query === "string")
  );
}

function lookupBody(value: unknown): LookupBody {
  const body = record(value);
  assert.ok(isLookupBody(body), "Expected directory lookup IDs and query");
  return body;
}

declare global {
  var waitForPluginDetails: () => Promise<void>;
  var showPluginPage2: (selections?: string) => void;
  var liveWrites: (string | null)[];
  var liveRegions: (string | null)[];
}

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

test("A dedicated OpenClaw Agent can enable and disable Google Workspace without a connection", async (t) => {
  const { fixture, namespace: namespaceValue }: { fixture: Fixture; namespace: unknown } =
    await createReadyConsoleNamespace(t, "Package installation");
  const namespace = entity(namespaceValue);
  for (const driver of [
    new OCCPluginDriver(),
    createTestKubernetesComputeDriver("compute-google-package"),
  ]) {
    controller(fixture).registerDriver(driver);
    controller(fixture).selectDriver(driver.capability, driver.id);
  }
  const agent = agentEntity(
    await fixture.createAgent(namespace.id, "Package Agent", nativeValues("package"), {
      executionMode: "dedicated",
      harnessAuth: null,
    }),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const id = "occ-plugin:google@1.0.0";
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins" });
  async function checkPolicySupport(pluginName: string) {
    const policies = dialog.getByRole("group", { name: "Plugin policies" });
    for (const label of ["tools enabled by default", "require approval for", "default reviewer"]) {
      const field = policies.getByRole("combobox", { name: `${pluginName} ${label}`, exact: true });
      assert.equal(await field.isDisabled(), true);
      assert.equal(await field.locator("option:checked").textContent(), "Not supported");
    }
    await dialog
      .getByRole("group", { name: "Driver policy" })
      .getByText(/driver-specific settings are not supported/i)
      .waitFor();
    await dialog.getByRole("heading", { name: "Tools", exact: true }).waitFor();
    await dialog.getByText(/per-tool policies are not supported/i).waitFor();
  }
  await dialog.getByRole("button", { name: "Google Workspace", exact: true }).click();
  await dialog.getByRole("button", { name: "Add Google Workspace", exact: true }).click();
  assert.equal(await dialog.getByLabel("Google account", { exact: true }).inputValue(), "");
  await dialog
    .getByRole("option", { name: "Install without an account" })
    .waitFor({ state: "attached" });
  await checkPolicySupport("Google Workspace");
  async function save(enabled: boolean) {
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    const saved = page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.deepEqual(responseData(await fixture.request("GET", path)).plugins, {
      [id]: { enabled },
    });
    await page.getByText("Plugin selections saved.", { exact: true }).waitFor();
  }
  await save(true);

  // Reopen the saved selection before its catalog entry (including the tool list) has arrived.
  const catalog = await holdRequests(t, page, `**${path}/plugins`, { method: "POST" });
  await page.reload();
  await catalog.requested;
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: id, exact: true }).click();
  const enabled = dialog.getByLabel(`Enable ${id}`, { exact: true });
  assert.equal(await enabled.isChecked(), true);
  await checkPolicySupport(id);
  assert.equal(await dialog.getByLabel(/plugin approvers mode/).count(), 0);
  assert.equal(await dialog.getByLabel("Filter tools").count(), 0);
  await enabled.uncheck();
  await save(false);
  catalog.release();
});

test("The dedicated Agent draft can select a published skill while its hosted server stays off", async (t) => {
  const { fixture, namespace: resource } = await createReadyConsoleNamespace(
    t,
    "Namespace plugin import",
  );
  const namespace = entity(resource);
  for (const driver of [
    new OCCPluginDriver(),
    createTestKubernetesComputeDriver("compute-namespace-plugin"),
  ]) {
    controller(fixture).registerDriver(driver);
    controller(fixture).selectDriver(driver.capability, driver.id);
  }
  const agent = agentEntity(
    await fixture.createAgent(namespace.id, "Report reader", nativeValues("import"), {
      executionMode: "dedicated",
      harnessAuth: null,
    }),
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByText("Import plugin", { exact: true }).click();
  const archive = await importedPluginPackage(t, "readable marker", {
    mcpUrl: "https://reports.example.com/mcp",
  });
  await page.getByLabel("Package archive").setInputFiles({
    name: "reports.tgz",
    mimeType: "application/gzip",
    buffer: Buffer.from(archive, "base64"),
  });
  const preview = page.waitForResponse((response) =>
    response.url().endsWith("/plugin-releases/preview"),
  );
  await page.getByRole("button", { name: "Preview package", exact: true }).click();
  const reviewed = responseData(await (await preview).json());
  assert.deepEqual(reviewed.skills, ["import-probe"]);
  const digest = text(reviewed.digest);
  const publish = page.waitForResponse(
    (response) =>
      response.url().endsWith("/plugin-releases") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Publish to Namespace", exact: true }).click();
  assert.equal(responseData(await (await publish).json()).digest, digest);
  await page
    .getByText("Release published to this Namespace’s plugin catalog.", { exact: true })
    .waitFor();

  // Publication updates the Namespace inventory. Only an explicit Agent save stages the release for deployment.
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const pluginId = "occ-import:" + digest;
  const title = "import-probe 1.0.0 (" + digest.slice(0, 12) + ")";
  const existing = responseData(await fixture.request("GET", path)).plugins;
  assert.equal(record(existing ?? {})[pluginId], undefined);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins" });
  await dialog.getByRole("button", { name: title, exact: true }).click();
  await dialog.getByRole("button", { name: "Add " + title, exact: true }).click();
  const account = dialog.getByRole("combobox", { name: "probe", exact: true });
  assert.equal(await account.locator("option:checked").textContent(), "Leave this server off");
  assert.equal(
    await dialog.getByRole("checkbox", { name: "Enable " + title, exact: true }).isChecked(),
    true,
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  await page.getByText("Plugin selections saved.", { exact: true }).waitFor();
  assert.deepEqual(record(responseData(await fixture.request("GET", path)).plugins)[pluginId], {
    enabled: true,
  });
});

test("Plugin details refresh preserves the user's current keyboard focus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  for (const destination of ["Beta", "Search plugins"]) {
    const { page } = await newPage(t, fixture, { browser });
    const requested = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
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
      const modulePath = "/console/agents/plugin-fields.mjs";
      const module: unknown = await import(modulePath);
      function isPluginFieldsModule(
        value: unknown,
      ): value is Pick<
        typeof import("../../apps/controller/src/console/agents/plugin-fields.mjs"),
        "createPluginFields"
      > {
        return (
          typeof value === "object" &&
          value !== null &&
          "createPluginFields" in value &&
          typeof value.createPluginFields === "function"
        );
      }
      if (!isPluginFieldsModule(module)) {
        throw new Error("Expected createPluginFields from " + modulePath);
      }
      const { createPluginFields } = module;
      const alpha = { id: "alpha", name: "Alpha", remoteId: "alpha", tools: null };
      const beta = { id: "beta", name: "Beta", tools: [] };
      const catalog: PluginFieldCatalog = {
        status: "ready",
        canLoad: true,
        entries: [alpha, beta],
      };
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
    const isFocused = (node: Element) => node === node.ownerDocument.activeElement;
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
    const modulePath = "/console/agents/plugin-fields.mjs";
    const module: unknown = await import(modulePath);
    function isPluginFieldsModule(
      value: unknown,
    ): value is Pick<
      typeof import("../../apps/controller/src/console/agents/plugin-fields.mjs"),
      "createPluginFields"
    > {
      return (
        typeof value === "object" &&
        value !== null &&
        "createPluginFields" in value &&
        typeof value.createPluginFields === "function"
      );
    }
    if (!isPluginFieldsModule(module)) {
      throw new Error("Expected createPluginFields from " + modulePath);
    }
    const { createPluginFields } = module;
    const alpha = { id: "alpha", name: "Alpha", remoteId: "alpha", tools: null };
    const beta = { id: "beta", name: "Beta", tools: [] };
    const catalog: PluginFieldCatalog = { status: "ready", canLoad: true, entries: [alpha, beta] };
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
        if (!target) {
          throw new Error("Expected a live-region mutation target");
        }
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
  const preset = record(
    JSON.parse(
      await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
    ),
  );
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [preset] });
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  controller(fixture).registerDriver(driver);
  controller(fixture).selectDriver("plugin", driver.id);
  const namespace = entity(await fixture.createNamespace("Approver search", { ready: true }));
  const bot = secretEntity(
    await fixture.createSecret(namespace.id, "Search bot", "synthetic-slack-token"),
  );
  const { page, artifacts } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const lookups: ReturnType<typeof lookupBody>[] = [];
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  t.after(() => releaseLookup.resolve());
  let denied = false;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = lookupBody(route.request().postDataJSON());
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
  const controlStyle = (locator: Locator) =>
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
  const body = lastBody(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`));
  assert.deepEqual(body.pluginApprovers, [{ channel: "slack", id: "team:TTEST123:user:UTEST123" }]);
  const configuration = lastBody(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/configurations`),
  );
  assert.equal(
    configuration.secretBindings === undefined
      ? undefined
      : record(configuration.secretBindings).SLACK_BOT_TOKEN,
    undefined,
  );
});

test("Create Agent keeps the search Secret out of plugin approver lookups", async (t) => {
  const preset = record(
    JSON.parse(
      await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
    ),
  );
  const pluginId = "occ-plugin:diffs";
  record(record(preset.template).agent).plugins = {
    [pluginId]: { enabled: true, approvers: [{ channel: "slack", id: "UOTHER123" }] },
  };
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [preset] });
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  controller(fixture).registerDriver(driver);
  controller(fixture).selectDriver("plugin", driver.id);
  const namespace = entity(await fixture.createNamespace("Approver privacy", { ready: true }));
  const bot = secretEntity(
    await fixture.createSecret(namespace.id, "Search bot", "synthetic-slack-token"),
  );
  const spare = secretEntity(
    await fixture.createSecret(namespace.id, "Spare bot", "synthetic-spare-token"),
  );
  // This administrator may not create Secrets in the Namespace, so the Namespace permission answer
  // denies Secret create; nothing here creates one.
  restrict(fixture.policy, "create", "secret", { namespaceId: namespace.id });
  // Nor operate the spare token, which a people search needs on its Secret (finding 2469).
  restrict(fixture.policy, "operate", "secret", {
    namespaceId: namespace.id,
    resourceId: spare.id,
  });
  const { page } = await newPage(t, fixture, { browser });
  const lookups: ReturnType<typeof lookupBody>[] = [];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      lookups.push(lookupBody(route.request().postDataJSON()));
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
  controller(fixture).registerDriver(pluginDriver);
  controller(fixture).selectDriver("plugin", pluginDriver.id);
  const namespace = entity(
    await fixture.createNamespace("Slack directory picker", { ready: true }),
  );
  const appSecret = secretEntity(
    await fixture.createSecret(namespace.id, "Slack app token", "xapp-test-secret"),
  );
  const botSecret = secretEntity(
    await fixture.createSecret(namespace.id, "Slack bot token", "xoxb-test-secret"),
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "disabled",
    channels: { CEXIST123: { requireMention: true, users: ["*"] } },
  };
  const agent = agentEntity(
    await fixture.createAgent(
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
    ),
  );
  const pluginId = "occ-plugin:diffs";
  const toolId = "diffs";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: { [pluginId]: { enabled: true, tools: { [toolId]: { enabled: true } } } },
  });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies: ReturnType<typeof lookupBody>[] = [];
  let directoryAvailable = true;
  let directoryDenied = false;
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = lookupBody(route.request().postDataJSON());
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
              ? candidates.filter((candidate) => body.ids?.includes(candidate.id))
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
      lookupBody(response.request().postDataJSON()).query === "Alex",
  );
  await people.fill("Alex");
  await searched;
  const result = picker.getByRole("option", { name: /Alex.*@alex/ });
  await result.waitFor();
  const resultNode = await result.elementHandle();
  assert.ok(resultNode);
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
  assert.ok(peopleNode);
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
      lookupBody(response.request().postDataJSON()).ids?.includes("UTEST123") === true,
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
  assert.ok(selectedPeopleNode);
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
  await pluginDialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await pluginDialog.locator(`[data-plugin-id="${pluginId}"] .plugin-list-item`).click();
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
    lastBody(pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`))
      .pluginApprovers,
    approvers,
  );
  assert.deepEqual(
    responseData(await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
      .pluginApprovers,
    approvers,
  );
  let savedAgent = responseData(
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`),
  );
  assert.deepEqual(record(record(savedAgent.plugins)[pluginId]).approvers, []);
  assert.deepEqual(
    record(record(record(record(savedAgent.plugins)[pluginId]).tools)[toolId]).approvers,
    [{ channel: "slack", id: "UTEST123" }],
  );
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
  await reopenedPlugins.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await reopenedPlugins.locator(`[data-plugin-id="${pluginId}"] .plugin-list-item`).click();
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
  savedAgent = responseData(
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`),
  );
  assert.deepEqual(record(record(savedAgent.plugins)[pluginId]).approvers, []);
  assert.deepEqual(record(record(record(savedAgent.plugins)[pluginId]).tools)[toolId], {
    enabled: true,
  });

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
    lastBody(pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`))
      .pluginApprovers,
    null,
  );
  savedAgent = responseData(
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`),
  );
  assert.equal(Object.hasOwn(savedAgent, "pluginApprovers"), false);
});

test("Unsaved default plugin approvers block deployment after leaving Plugins", async (t) => {
  const { fixture, namespace: namespaceValue }: { fixture: Fixture; namespace: unknown } =
    await createRuntimeAuthFixture(t, "Unsaved plugin approvers");
  const namespace = entity(namespaceValue);
  const pluginDriver = new CodexPluginDriver();
  controller(fixture).registerDriver(pluginDriver);
  controller(fixture).selectDriver("plugin", pluginDriver.id);
  const agent = agentEntity(
    await fixture.createAgent(
      namespace.id,
      "Approver Draft Agent",
      nativeValues("approver-draft"),
      { executionMode: "embedded", harnessAuth: { method: "runtime" } },
    ),
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
  const { fixture, namespace: namespaceValue }: { fixture: Fixture; namespace: unknown } =
    await createRuntimeAuthFixture(t, "Reader plugin approvers");
  const namespace = entity(namespaceValue);
  const pluginDriver = new CodexPluginDriver();
  controller(fixture).registerDriver(pluginDriver);
  controller(fixture).selectDriver("plugin", pluginDriver.id);
  const agent = agentEntity(
    await fixture.createAgent(
      namespace.id,
      "Reader Approver Agent",
      nativeValues("reader-approvers"),
      { executionMode: "embedded", harnessAuth: { method: "runtime" } },
    ),
  );
  const approver = "team:TTEST123:user:UREADER1";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    pluginApprovers: [{ channel: "slack", id: approver }],
  });
  const reader = record(
    await fixture.createNamespaceMember("approver-reader", namespace.id, [
      ["read", "namespace"],
      ["read", "agent"],
      ["read", "agent_revision"],
      ["read", "configuration"],
    ]),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
    record(reader.credentials),
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
  const { fixture, namespace: namespaceValue }: { fixture: Fixture; namespace: unknown } =
    await createRuntimeAuthFixture(t, "Codex plugin approvers");
  const namespace = entity(namespaceValue);
  const pluginDriver = new CodexPluginDriver();
  controller(fixture).registerDriver(pluginDriver);
  controller(fixture).selectDriver("plugin", pluginDriver.id);
  const agent = agentEntity(
    await fixture.createAgent(
      namespace.id,
      "Codex Approver Agent",
      nativeValues("codex-approvers"),
      { executionMode: "embedded", harnessAuth: { method: "runtime" } },
    ),
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
    const modulePath = "/console/agents/slack-approvers.mjs";
    const module: unknown = await import(modulePath);
    function isSlackApproversModule(
      value: unknown,
    ): value is Pick<
      typeof import("../../apps/controller/src/console/agents/slack-approvers.mjs"),
      "createSlackApproverField"
    > {
      return (
        typeof value === "object" &&
        value !== null &&
        "createSlackApproverField" in value &&
        typeof value.createSlackApproverField === "function"
      );
    }
    if (!isSlackApproversModule(module)) {
      throw new Error("Expected createSlackApproverField from " + modulePath);
    }
    const { createSlackApproverField } = module;
    let value: PluginApprovers | undefined = [];
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
    const picker = field.querySelector<HTMLElement>(".slack-directory-field");
    const select = field.querySelector("select");
    if (!helper || !picker || !select) {
      throw new Error("Expected approver field controls");
    }
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

test("plugin prefetch remains usable after leaving during its debounce", async (t) => {
  const { fixture, namespace: namespaceValue }: { fixture: Fixture; namespace: unknown } =
    await createReadyConsoleNamespace(t, "Plugin return");
  const namespace = entity(namespaceValue);
  for (const driver of [
    new OCCPluginDriver(),
    createTestKubernetesComputeDriver("compute-plugin-return"),
  ]) {
    controller(fixture).registerDriver(driver);
    controller(fixture).selectDriver(driver.capability, driver.id);
  }
  const agent = agentEntity(
    await fixture.createAgent(namespace.id, "Plugin return Agent", nativeValues("package"), {
      executionMode: "dedicated",
      harnessAuth: null,
    }),
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const initialSelections = { "occ-plugin:google@1.0.0": { enabled: false } };
  const saved = record(
    await fixture.request("PATCH", agentPath, {
      body: { configurationId: agent.configurationId, plugins: initialSelections },
    }),
  );
  assert.equal(saved.status, 200);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("tab", { name: "Configuration", exact: true }).waitFor();
  // Leave after capabilities arrive but before the deferred read, then expire it while hidden.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  const capabilities = page.waitForResponse((r) => r.url().endsWith("/plugins/capabilities"));
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await (await capabilities).finished();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.clock.runFor(400);
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins" });
  await page.clock.runFor(1000);
  await dialog.getByRole("button", { name: "Google Workspace", exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Loading plugins…", exact: true }).count(),
    0,
  );
  assert.deepEqual(
    responseData(await fixture.request("GET", agentPath)).plugins,
    initialSelections,
  );
});
