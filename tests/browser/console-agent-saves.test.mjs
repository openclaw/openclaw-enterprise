import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  pathRequests,
  recordLayoutShifts,
  selectSecret,
  setSlackSelection,
  takeLayoutShifts,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForInputValue,
  secretOptionLabel,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  createRepositoryLaunchFixture,
  focusedDescription,
  focusedText,
  openAdvancedSettings,
  watchForReload,
} from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Saves and reloads on the Agent page's tabs, and every Reload draft, re-navigated to the same
// URL: the page collapsed to its summary, reread the session, versions, permissions and
// deployments (about 12 reads), jumped to the top, dropped focus and showed no saved message
// (findings 1445 and 1446). They now refresh in place.

const scrollY = (page) => page.evaluate(() => globalThis.scrollY);
// A refresh in place rereads the Agent's permission answer, so a grant applies to the rebuilt
// editors (finding 1538); a page load also rereads the Namespace's.
const pageReloadReads = (requests) =>
  requests
    .filter((request) => request.method === "GET")
    .map((request) => request.path)
    .filter((path) => /\/api\/auth\/session|\/revisions|\/permissions|\/deployments/.test(path))
    .filter((path) => !/\/agents\/[^/]+\/permissions$/.test(path));

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// Opens an Agent draft tab. The default viewport is short, so a reload's jump to the top shows
// as a lost scroll position.
async function openTab(t, fixture, namespace, agent, tab, options = {}) {
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: options.viewport ?? { width: 1280, height: 600 } },
  });
  await options.beforeLogin?.(page);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", tab));
  return page;
}

// Scrolls `control` below the first screen and starts watching the page. check() asserts the
// page was updated in place: the same summary node, no loading text, none of a page load's
// reads, and the scroll position kept.
async function watchPlace(page, fixture, control) {
  await control.scrollIntoViewIfNeeded();
  const before = await scrollY(page);
  assert.ok(before > 0, "the control sits below the first screen");
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);
  return {
    requests,
    async check() {
      assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
      assert.deepEqual(pageReloadReads(requests), []);
      assert.ok((await scrollY(page)) > before / 2, "the page kept its scroll position");
    },
  };
}

// `prepare` sets up the bootstrapped fixture before the Agent is created.
async function plainAgent(t, name, values = nativeValues("before"), options, prepare) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  prepare?.(fixture);
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(namespace.id, name, values, options);
  return { fixture, namespace, agent };
}

// A Slack token binding as the API stores it.
const envBinding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });

// Codex with Slack in socket mode, reading both tokens from env Secret bindings.
const slackValues = () =>
  nativeValues("channels", {
    harnessId: "codex",
    channels: {
      slack: {
        enabled: true,
        mode: "socket",
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        channels: {},
      },
    },
  });

async function slackAgent(t, name) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-in-place");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-in-place");
  const agent = await fixture.createAgent(namespace.id, name, slackValues(), {
    executionMode: "dedicated",
    secretBindings: {
      SLACK_APP_TOKEN: envBinding(app),
      SLACK_BOT_TOKEN: envBinding(bot),
    },
  });
  return { fixture, namespace, agent, app, bot };
}

const configurationPath = ({ namespace, agent }) =>
  `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;

// Each save or Reload draft refreshes the draft in place, names the saved generation, moves
// focus to the control that remains, and leaves a draft that can be deployed.
const inPlaceCases = [
  {
    name: "saving the draft Configuration updates the Agent page in place",
    async setup(t) {
      const { fixture, namespace } = await createRuntimeAuthFixture(t, "Configuration in place");
      const agent = await fixture.createAgent(
        namespace.id,
        "Saved In Place",
        nativeValues("before"),
        { harnessAuth: { method: "runtime" } },
      );
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
      return { fixture, namespace, agent };
    },
    tab: "configuration",
    viewport: { width: 1280, height: 720 },
    async prepare(page) {
      await page.getByRole("heading", { name: "Prepare this version" }).waitFor();
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(".agent-draft-actions .primary")?.disabled === false,
      );
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      const editor = page.getByLabel("Configuration JSON");
      await editor.fill(JSON.stringify(nativeValues("after"), null, 2));
      return page.getByRole("button", { name: "Save Configuration" });
    },
    saved: "Configuration saved.",
    focus: "Edit Configuration",
    described: true,
    async verify(page, c, requests) {
      // Two reads of the saved Configuration and none of an Agent page reload's reads.
      const reads = requests
        .filter((request) => request.method === "GET")
        .map((request) => request.path);
      const configurationReads = reads.filter((path) => path === configurationPath(c));
      assert.equal(configurationReads.length, 2, reads.join(" "));
      assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");
      // The refreshed draft is current: deploying it passes the preflight against the saved
      // state.
      const deploying = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/namespaces/${c.namespace.id}/agents/${c.agent.id}/deploy`),
      );
      await page.getByRole("button", { name: "Deploy new version" }).click();
      assert.equal((await deploying).status(), 202);
    },
  },
  {
    name: "channel saves and Reload draft update the Agent page in place",
    setup: (t) => slackAgent(t, "Channels In Place"),
    tab: "channels",
    async prepare(page) {
      await page.getByRole("heading", { name: "Channels In Place" }).waitFor();
      await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
      return page.getByRole("button", { name: "Disable Slack" });
    },
    saved: "Channels saved.",
    // Disable is gone; focus stays on the provider's remaining action.
    focus: "Edit Slack",
    described: true,
    async verify(page, c) {
      assert.equal(await page.getByRole("button", { name: "Disable Slack" }).count(), 0);
      const saved = await c.fixture.request("GET", configurationPath(c));
      assert.equal(saved.data.values.channels.slack.enabled, false);
    },
  },
  {
    name: "Reload draft after a lost channel save updates the Agent page in place",
    setup: (t) => slackAgent(t, "Channel Reload In Place"),
    tab: "channels",
    // The API commits, but the browser cannot know that the response was lost.
    async beforeLogin(page, c) {
      await page.route(`**${configurationPath(c)}`, async (route, request) => {
        if (request.method() !== "PATCH") {
          await route.continue();
          return;
        }
        assert.equal((await route.fetch()).status(), 200);
        await route.abort("failed");
      });
    },
    async prepare(page) {
      await page.getByRole("heading", { name: "Channel Reload In Place" }).waitFor();
      await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
      await page.getByRole("button", { name: "Disable Slack" }).click();
      const reload = page.getByRole("button", { name: "Reload draft" });
      await reload.waitFor();
      return reload;
    },
    saved: "Draft reloaded.",
    focus: "Draft reloaded.",
    async verify(page) {
      assert.equal(await page.getByRole("button", { name: "Reload draft" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Disable Slack" }).count(), 0);
    },
  },
  {
    name: "Reload draft in the Configuration editor updates the Agent page in place",
    setup: (t) => plainAgent(t, "Configuration Reload In Place"),
    tab: "configuration",
    async prepare(page, c) {
      await page.getByRole("heading", { name: "Configuration Reload In Place" }).waitFor();
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      const editor = page.getByLabel("Configuration JSON");
      await editor.fill(JSON.stringify(nativeValues("mine"), null, 2));
      const changed = await c.fixture.request("PATCH", configurationPath(c), {
        body: { values: nativeValues("theirs") },
      });
      assert.equal(changed.status, 200);
      await page.getByRole("button", { name: "Save Configuration" }).click();
      const reload = page.getByRole("button", { name: "Reload draft" });
      await reload.waitFor();
      return reload;
    },
    saved: "Draft reloaded.",
    // The reader's edits are carried over the reread document (finding 1512), so Save
    // Configuration is the next step and deployment waits for it.
    focus: "Save Configuration",
    described: true,
    description:
      'Draft reloaded. Your edits are applied over the reloaded Configuration. Another browser also changed /plugins/entries/knowledge/config/marker (saved: "theirs"); yours are shown. Review them, then save.',
    deployable: false,
  },
];

for (const c of inPlaceCases) {
  test(c.name, async (t) => {
    const context = await c.setup(t);
    const { fixture, namespace, agent } = context;
    const page = await openTab(t, fixture, namespace, agent, c.tab, {
      viewport: c.viewport,
      beforeLogin: (routed) => c.beforeLogin?.(routed, context),
    });
    const control = await c.prepare(page, context);
    const place = await watchPlace(page, fixture, control);

    await control.click();
    await page.getByRole("status").filter({ hasText: c.saved }).waitFor();
    await page.getByText(/Configuration .* · generation 2$/).waitFor();
    await place.check();
    assert.equal(await focusedText(page), c.focus);
    if (c.described) {
      assert.equal(await focusedDescription(page), c.description ?? c.saved);
    }
    assert.equal(
      await page.getByRole("button", { name: "Deploy new version" }).isEnabled(),
      c.deployable ?? true,
    );
    await c.verify?.(page, context, place.requests);
  });
}

// The authentication source save re-navigated the same way. It now refreshes in place from
// the saved Agent, and a second save checks against that saved state instead of the page's
// first read. Reload authentication source keeps focus too (finding 1446).
test("saving and reloading the authentication source update the Agent page in place", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Authentication in place");
  const first = await fixture.createSecret(namespace.id, "First harness Secret", "hidden-first");
  const second = await fixture.createSecret(namespace.id, "Second harness Secret", "hidden-second");
  const agent = await fixture.createAgent(
    namespace.id,
    "Authentication In Place",
    nativeValues("auth", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: first.ref }, executionMode: "dedicated" },
  );
  const page = await openTab(t, fixture, namespace, agent, "credentials", {
    viewport: { width: 390, height: 844 },
  });
  await page.getByRole("heading", { name: "Authentication In Place" }).waitFor();
  const secretField = page.getByLabel("API key Secret");
  await waitForInputValue(secretField, secretOptionLabel(first));
  const kept = await watchForReload(page);
  const saveAuthentication = page.getByRole("button", { name: "Save authentication source" });
  const savedAgent = async () =>
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .harnessAuth;

  for (const secret of [second, first]) {
    await selectSecret(page, "API key Secret", secret);
    await saveAuthentication.scrollIntoViewIfNeeded();
    const scrollBefore = await scrollY(page);
    assert.ok(scrollBefore > 0, "the Save button sits below the first screen");
    await saveAuthentication.click();
    await page.getByRole("status").filter({ hasText: "Authentication source saved." }).waitFor();
    await waitForInputValue(secretField, secretOptionLabel(secret));
    assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
    assert.equal(await focusedText(page), "Save authentication source");
    assert.equal(await focusedDescription(page), "Authentication source saved.");
    // The staged-Secret hint is gone after the save, so the page may end one line shorter.
    const scrollAfter = await scrollY(page);
    assert.ok(
      Math.abs(scrollAfter - scrollBefore) <= 40,
      `the page kept its scroll: ${scrollBefore} -> ${scrollAfter}`,
    );
    assert.deepEqual(await savedAgent(), { method: "api_key", source: secret.ref });
  }

  const reload = page.getByRole("button", { name: "Reload authentication source" });
  await selectSecret(page, "API key Secret", second);
  await reload.click();
  await waitForInputValue(secretField, secretOptionLabel(first));
  assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(page), "Reload authentication source");

  // Leaving the tab while Reload reads must not keep a Credentials form with its controls off.
  const agentPath = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  const read = await holdRequests(t, page, agentPath);
  await reload.click();
  await read.requested;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  read.release();
  await page.unroute(agentPath);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await waitForInputValue(secretField, secretOptionLabel(first));
  await saveAuthentication.waitFor();
  await waitForEnabled(saveAuthentication);
  await waitForEnabled(reload);
});

// Refresh sharing, the Configuration editor's Cancel and the Create Agent shortcuts replaced or
// disabled the control the reader used, dropping keyboard focus to the document (finding 1446).
test("Refresh sharing, the Configuration editor and the Create Agent shortcuts keep keyboard focus", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  );
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Kept focus", {
    defaultPresets: [preset],
  });
  const agent = await fixture.createAgent(namespace.id, "Kept Focus", nativeValues("focus"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  await page.getByRole("heading", { name: "Kept Focus" }).waitFor();

  const sharing = page.getByRole("region", { name: "Share Agent", exact: true });
  await sharing.getByText("Current policy loaded.", { exact: false }).waitFor();
  await sharing.getByRole("button", { name: "Refresh sharing" }).focus();
  await page.keyboard.press("Enter");
  await sharing.getByRole("button", { name: "Refresh sharing", disabled: false }).waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.tagName !== "BODY");
  assert.equal(await focusedText(page), "Refresh sharing");

  // Edit Configuration opens the editor in place of the pressed button; the editor takes
  // focus instead of the document, without scrolling the page to fit it (finding 1620).
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  const edit = page.getByRole("button", { name: "Edit Configuration" });
  await edit.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const editScroll = await page.evaluate(() => globalThis.scrollY);
  await edit.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Configuration JSON").waitFor();
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "configuration-json",
  );
  assert.equal(await page.evaluate(() => globalThis.scrollY), editScroll);
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  assert.equal(await focusedText(page), "Edit Configuration");

  for (const shortcut of ["Start with default Preset", "Start without Preset"]) {
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    const start = page.getByRole("button", { name: shortcut });
    await page
      .getByRole("button", { name: "Start with default Preset", disabled: false })
      .waitFor();
    await start.focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Agent name").waitFor();
    await page.waitForFunction(() => globalThis.document.activeElement?.tagName !== "BODY");
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement?.tagName),
      "H1",
      shortcut,
    );
  }
});

test("saving and reloading plugin selections update the Agent page in place", async (t) => {
  const { fixture, namespace, agent } = await plainAgent(
    t,
    "Plugins In Place",
    nativeValues("plugins", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: null },
    (created) => {
      const pluginDriver = new CodexPluginDriver();
      created.controller.registerDriver(pluginDriver);
      created.controller.selectDriver("plugin", pluginDriver.id);
    },
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const page = await openTab(t, fixture, namespace, agent, "plugins");
  await page.getByRole("heading", { name: "Plugins In Place" }).waitFor();
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  const edited = { "codex-plugin:linear@openai-curated-remote": { enabled: false } };
  await json.fill(JSON.stringify(edited));
  const save = page.getByRole("button", { name: "Save plugin selections", exact: true });
  const place = await watchPlace(page, fixture, save);

  // Until the rebuilt tab mounts, the saved editor stays locked: an edit made there would be
  // dropped by the rebuild (review of #2551).
  const reread = await holdRequests(t, page, `**${configurationPath({ namespace, agent })}`, {
    once: true,
    method: "GET",
  });
  await save.click();
  await reread.requested;
  await page.getByRole("status").filter({ hasText: "Plugin selections saved." }).waitFor();
  // The plugin fields go inert while saving; the JSON stays readable but read-only.
  assert.equal(
    await json.evaluate(
      (node) => node.disabled || node.readOnly || node.closest("[inert]") !== null,
    ),
    true,
  );
  assert.equal(await save.isDisabled(), true);
  reread.release();
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).waitFor();
  await page.waitForFunction(
    () => globalThis.document.activeElement?.getAttribute("role") === "status",
  );
  await place.check();
  // Save is disabled with nothing left to save, so the saved status takes focus.
  assert.equal(await focusedText(page), "Plugin selections saved.");
  assert.deepEqual(JSON.parse(await json.inputValue()), edited);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.plugins, edited);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "plugins");

  // A change saved elsewhere asks for a reload, which also rebuilds in place.
  const elsewhere = { "codex-plugin:linear@openai-curated-remote": { enabled: true } };
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: elsewhere,
  });
  // The rebuilt tab starts with its JSON collapsed, as a fresh page does.
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await json.fill("{}");
  await save.click();
  const reload = page.getByRole("button", { name: "Reload plugin selections" });
  await reload.waitFor();
  // Save disabled itself, so Reload takes focus, described by why (finding 1998).
  assert.deepEqual(
    await reload.evaluate((node) => ({
      focused: node === globalThis.document.activeElement,
      description: (node.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => globalThis.document.getElementById(id)?.textContent),
    })),
    {
      focused: true,
      description: ["Plugin selections changed. Reload this Agent before saving again."],
    },
  );
  await reload.click();
  await page.getByRole("status").filter({ hasText: "Plugin selections reloaded." }).waitFor();
  await place.check();
  assert.deepEqual(JSON.parse(await json.inputValue()), elsewhere);
  assert.equal(await save.isDisabled(), true);
  // The rebuilt editor is clean, so the tabs are free to leave again.
  assert.equal(await page.getByRole("tab", { name: "Channels", exact: true }).isEnabled(), true);
});

const repositoryAccess = (defaultProfile) => ({
  defaultProfile,
  repositories: [{ repositoryRef: "application" }],
});

// An Agent with Contributor access to one repository its Namespace may use.
async function repositoryAgent(t, name) {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("repositories"));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const saved = await fixture.request("PATCH", agentPath, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: repositoryAccess("git-full"),
    },
  });
  assert.equal(saved.status, 200);
  return { fixture, namespace, agent, agentPath };
}

test("repository saves, Cancel and Reload draft update the Agent page in place", async (t) => {
  const { fixture, namespace, agent, agentPath } = await repositoryAgent(
    t,
    "Repositories In Place",
  );
  const page = await openTab(t, fixture, namespace, agent, "repositories");
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const place = await watchPlace(page, fixture, save);

  await page.locator("#repository-default-git-read").check();
  await save.click();
  await page.getByRole("status").filter({ hasText: "Repository access saved." }).waitFor();
  await place.check();
  assert.equal(await focusedText(page), "Repository access saved.");
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(
    (await fixture.request("GET", agentPath)).data.repositoryAccess,
    repositoryAccess("git-read"),
  );

  // Cancel drops the edit and rebuilds from the saved state in place.
  await page.locator("#repository-default-git-full").check();
  assert.equal(await save.isEnabled(), true);
  await cancel.click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#repository-default-git-read")?.checked === true,
  );
  await place.check();
  assert.equal(await focusedText(page), "Cancel");
  assert.equal(await save.isDisabled(), true);

  // A change saved elsewhere asks for Reload draft, which rebuilds in place too.
  const concurrent = await fixture.request("PATCH", agentPath, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: repositoryAccess("git-write"),
    },
  });
  assert.equal(concurrent.status, 200);
  await page.locator("#repository-default-git-full").check();
  await save.click();
  await page
    .getByText("Repository access changed while you were editing. Reload this draft before saving.")
    .waitFor();
  const reload = page.getByRole("button", { name: "Reload draft", exact: true });
  await reload.click();
  await page.getByRole("status").filter({ hasText: "Draft reloaded." }).waitFor();
  await place.check();
  await page
    .getByText("Contributor · no issue management · Agent default", { exact: true })
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  await waitForEnabled(cancel);
  await waitForEnabled(page.getByRole("tab", { name: "Channels", exact: true }));
  assert.equal(pathRequests(place.requests, "PATCH", agentPath).length, 1);
});

// Cancel rereads the Agent before the tab is rebuilt. A repository-choices read that finished
// in that window re-enabled the editor being replaced, so the cancelled edit could be changed
// and saved again (review of #2551).
test("repository Cancel keeps the replaced editor locked while choices finish loading", async (t) => {
  const { fixture, namespace, agent, agentPath } = await repositoryAgent(
    t,
    "Repositories Cancel Lock",
  );
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const options = await holdRequests(t, page, `${fixture.origin}${agentPath}/repository-options`, {
    once: true,
    method: "GET",
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"));
  await options.requested;
  const remove = page.getByRole("button", { name: /^Remove/ });
  await remove.click();
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const reread = await holdRequests(t, page, `${fixture.origin}${agentPath}`, {
    once: true,
    method: "GET",
  });
  await cancel.click();
  await reread.requested;
  options.release();
  await page.waitForResponse((response) => response.url().endsWith("/repository-options"));
  const profile = page.locator("#repository-default-git-read");
  // Loading the choices sets aria-busy="false", re-renders and updates the editor in one
  // synchronous step, so the editor's final state is set once this is seen. It must stay
  // locked, so no field can make the cancelled edit savable again.
  await page.locator('.repository-options[aria-busy="false"]').waitFor({ state: "attached" });
  assert.equal(await cancel.isDisabled(), true, "the cancelled editor is still shown");
  assert.equal(await profile.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 0);

  reread.release();
  await remove.waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 0);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.repositoryAccess.repositories, [
    { repositoryRef: "application" },
  ]);
});

// Another browser re-saves the Configuration unchanged, so its generation moves under the page.
async function changeElsewhere(c) {
  const current = await c.fixture.request("GET", configurationPath(c));
  const changed = await c.fixture.request("PATCH", configurationPath(c), {
    body: { values: current.data.values },
  });
  assert.equal(changed.status, 200);
}

// Another browser binds `secret` to the Slack token `token`, and may change the values too.
async function rebindElsewhere(c, token, secret, values = (current) => current) {
  const current = (await c.fixture.request("GET", configurationPath(c))).data;
  const changed = await c.fixture.request("PATCH", configurationPath(c), {
    body: {
      values: values(current.values),
      secretBindings: { ...current.secretBindings, [token]: envBinding(secret) },
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
}

// Picks the two other Slack token Secrets in the channel Secrets form.
async function selectNewSlackSecrets(page, c) {
  await selectSecret(page, "Slack app token", c.secondApp);
  await selectSecret(page, "Slack bot token", c.secondBot);
}

// A save that disables its own button, or a conflict that leaves Reload draft as the next step,
// dropped focus to body (finding 1481). Focus now lands on the saved status, or on Reload draft
// described by the conflict.
const outcomeFocusCases = [
  {
    name: "saving channel Secrets leaves focus on the saved status",
    tab: "credentials",
    async act(page, c) {
      await selectNewSlackSecrets(page, c);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    },
    message: "Channel Secret bindings saved. Deploy the new version to deliver them.",
    focus: "Channel Secret bindings saved. Deploy the new version to deliver them.",
  },
  {
    name: "a channel Secrets conflict focuses Reload draft",
    tab: "credentials",
    async act(page, c) {
      await selectNewSlackSecrets(page, c);
      await changeElsewhere(c);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    },
    message: "Configuration changed. Reload this draft before saving channel Secrets.",
    focus: "Reload draft",
    described: true,
  },
  {
    name: "a Configuration conflict focuses Reload draft",
    tab: "configuration",
    async act(page, c) {
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      const values = nativeValues("mine", { harnessId: "codex" });
      await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
      await changeElsewhere(c);
      await page.getByRole("button", { name: "Save Configuration" }).click();
    },
    message:
      "The saved Configuration changed while you were editing. Reload this draft before saving.",
    focus: "Reload draft",
    described: true,
  },
];

for (const c of outcomeFocusCases) {
  test(c.name, async (t) => {
    const context = await slackAgent(t, "Save Outcome Focus");
    const { fixture, namespace, agent } = context;
    context.secondApp = await fixture.createSecret(namespace.id, "Second app token", "xapp-2");
    context.secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
    const page = await openTab(t, fixture, namespace, agent, c.tab);
    await page.getByRole("heading", { name: "Save Outcome Focus" }).waitFor();
    await c.act(page, context);
    await page.getByText(c.message).waitFor();
    assert.equal(await focusedText(page), c.focus);
    if (c.described) {
      assert.equal(await focusedDescription(page), c.message);
    }
  });
}

// A Channels save that conflicted with another browser's save failed the same way on every
// retry: Cancel, reopening the editor and tab switches kept the page's old generation, and only
// a browser reload recovered (finding 1480). The section now offers Reload draft.
test("a Channels conflict offers Reload draft, which recovers in place", async (t) => {
  const context = await slackAgent(t, "Channels Conflict");
  const { fixture, namespace, agent } = context;
  const page = await openTab(t, fixture, namespace, agent, "channels");
  await page.getByRole("heading", { name: "Channels Conflict" }).waitFor();
  const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await changeElsewhere(context);
  await edit.click();
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  const message =
    "The saved Configuration changed while you were editing. Reload this draft before saving.";
  await page.getByRole("alert").filter({ hasText: message }).waitFor();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await focusedText(page), "Reload draft");
  assert.equal(await focusedDescription(page), message);
  // The editor cannot reopen against the old generation, and nothing deploys from it.
  assert.equal(await edit.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByRole("status").filter({ hasText: "Draft reloaded." }).waitFor();
  await edit.click();
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  assert.equal((await fixture.request("GET", configurationPath(context))).data.generation, 3);
});

// A Channels conflict closed the editor and dropped its edits with no warning: DM policy,
// allowlists and a Secret chosen there (finding 1504). The conflict now names the chosen
// Secret, and Reload draft reopens only the reader's edits over the reread settings, so the
// other browser's changes are kept too.
test("a Channels conflict keeps the editor's edits for Reload draft", async (t) => {
  const context = await slackAgent(t, "Channels Carry");
  const { fixture, namespace, agent } = context;
  const carriedBot = await fixture.createSecret(namespace.id, "Carried bot token", "xoxb-carry");
  const otherApp = await fixture.createSecret(namespace.id, "Other app token", "xapp-other");
  const page = await openTab(t, fixture, namespace, agent, "channels");
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("heading", { name: "Channels Carry" }).waitFor();
  const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await edit.click();
  await dialog.getByLabel("Direct-message policy").selectOption("allowlist");
  await setSlackSelection(
    dialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
    "UCARRY123",
  );
  await selectSecret(dialog, "Slack bot token", carriedBot);
  // Another browser turns off mentions and swaps the app token Secret.
  await rebindElsewhere(context, "SLACK_APP_TOKEN", otherApp, (values) => ({
    ...values,
    channels: { slack: { ...values.channels.slack, requireMention: false } },
  }));
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  const message =
    "The saved Configuration changed while you were editing. Reload this draft before saving. Reload draft reopens your Slack edits over the saved settings, including the Secret “Carried bot token”.";
  await page.getByRole("alert").filter({ hasText: message }).waitFor();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await focusedText(page), "Reload draft");
  assert.equal(await focusedDescription(page), message);

  await page.getByRole("button", { name: "Reload draft" }).click();
  await dialog.waitFor();
  const note =
    "Your edits are applied over the reloaded settings: Direct-message policy, Allowed people in direct messages (added UCARRY123), Slack bot token. Review them, then save.";
  await dialog.getByRole("status").filter({ hasText: note }).waitFor();
  assert.equal(await dialog.getByLabel("Direct-message policy").inputValue(), "allowlist");
  assert.equal(await dialog.getByLabel("Require a mention").isChecked(), false);
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await fixture.request("GET", configurationPath(context))).data;
  assert.equal(saved.generation, 3);
  assert.equal(saved.values.channels.slack.dmPolicy, "allowlist");
  assert.deepEqual(saved.values.channels.slack.allowFrom, ["UCARRY123"]);
  assert.equal(saved.values.channels.slack.requireMention, false);
  assert.deepEqual(saved.secretBindings.SLACK_APP_TOKEN, envBinding(otherApp));
  assert.deepEqual(saved.secretBindings.SLACK_BOT_TOKEN, envBinding(carriedBot));
  // The carried Secret still gets its access grant on the final save.
  assert.deepEqual(
    requests
      .filter(
        (request) => request.method === "POST" && request.path.endsWith("/iam/access-bindings"),
      )
      .map((request) => request.body.resourceId),
    [carriedBot.id],
  );
});

// A Secret picked and then picked back is no edit: carrying it would put the old binding back
// over another browser's change.
test("a Channels conflict does not carry a Secret picked back to the saved one", async (t) => {
  const context = await slackAgent(t, "Channels Pick Back");
  const { fixture, namespace, agent } = context;
  const original = (await fixture.request("GET", configurationPath(context))).data.secretBindings
    .SLACK_BOT_TOKEN;
  const originalBot = { id: original.source.id, name: "Channels Pick Back bot token" };
  const tempBot = await fixture.createSecret(namespace.id, "Temporary bot token", "xoxb-temp");
  const otherBot = await fixture.createSecret(namespace.id, "Other bot token", "xoxb-other");
  const page = await openTab(t, fixture, namespace, agent, "channels");
  await page.getByRole("heading", { name: "Channels Pick Back" }).waitFor();
  const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await edit.click();
  await dialog.getByLabel("Direct-message policy").selectOption("disabled");
  await selectSecret(dialog, "Slack bot token", tempBot);
  await selectSecret(dialog, "Slack bot token", originalBot);
  await rebindElsewhere(context, "SLACK_BOT_TOKEN", otherBot);
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  const message =
    "The saved Configuration changed while you were editing. Reload this draft before saving. Reload draft reopens your Slack edits over the saved settings.";
  await page.getByRole("alert").filter({ hasText: message }).waitFor();
  assert.equal(await focusedDescription(page), message);

  await page.getByRole("button", { name: "Reload draft" }).click();
  await dialog
    .getByRole("status")
    .filter({
      hasText:
        "Your edits are applied over the reloaded settings: Direct-message policy. Review them, then save.",
    })
    .waitFor();
  await waitForInputValue(dialog.getByLabel("Slack bot token"), "Other bot token");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await fixture.request("GET", configurationPath(context))).data;
  assert.deepEqual(saved.secretBindings.SLACK_BOT_TOKEN, envBinding(otherBot));
});

// Sets the Agent's Slack settings as another browser would, through the API.
async function saveSlackElsewhere(c, slack) {
  const current = await c.fixture.request("GET", configurationPath(c));
  const changed = await c.fixture.request("PATCH", configurationPath(c), {
    body: {
      values: {
        ...current.data.values,
        channels: { slack: { ...current.data.values.channels.slack, ...slack } },
      },
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
}

// Edits Slack, lets another browser save first, then saves and reloads the carried draft. A
// `slack` object, even {}, is saved first and moves the Configuration to generation 2 before the
// page opens; `undefined` opens the page at generation 1.
async function carrySlackEdit(t, name, slack, edit, elsewhere) {
  const context = await slackAgent(t, name);
  const { fixture, namespace, agent } = context;
  if (slack !== undefined) {
    await saveSlackElsewhere(context, slack);
  }
  const page = await openTab(t, fixture, namespace, agent, "channels");
  await page.getByRole("heading", { name }).waitFor();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
  await edit(dialog);
  await elsewhere(context);
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("button", { name: "Reload draft" }).click();
  return { context, page, dialog };
}

// The editor Reload draft reopens has no opener left on the rebuilt page; closing it returned
// focus to the document body.
test("closing an editor reopened by Reload draft focuses Edit Slack", async (t) => {
  const { page, dialog } = await carrySlackEdit(
    t,
    "Channels Reopened Close",
    undefined,
    (opened) => opened.getByLabel("Direct-message policy").selectOption("disabled"),
    changeElsewhere,
  );
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await focusedText(page), "Edit Slack");
});

// A carried list replaced the reread list, so a person another browser revoked in the meantime
// came back (finding 1509). The reader's added person is applied to the reread list instead.
test("a carried Slack list adds the reader's entry without undoing another browser's revoke", async (t) => {
  const { context, page, dialog } = await carrySlackEdit(
    t,
    "Carried List",
    { channels: { C0000AAA: { requireMention: true, users: ["U0000AAA", "U0000BBB"] } } },
    (opened) =>
      setSlackSelection(
        opened.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        "U0000AAA, U0000BBB, U0000CCC",
      ),
    (c) =>
      saveSlackElsewhere(c, {
        channels: { C0000AAA: { requireMention: true, users: ["U0000AAA"] } },
      }),
  );
  await dialog
    .getByRole("status")
    .filter({
      hasText:
        "Your edits are applied over the reloaded settings: Allowed people in these channels (added U0000CCC). Review them, then save.",
    })
    .waitFor();
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await context.fixture.request("GET", configurationPath(context))).data;
  assert.deepEqual(saved.values.channels.slack.channels.C0000AAA.users, ["U0000AAA", "U0000CCC"]);
});

// Changing the DM policy from open clears "*" from the DM user list by itself. That cleared list
// was carried as the reader's edit and erased another browser's allowlist (finding 1509). Now
// only the policy is carried, and since the other browser changed it too, both are shown.
test("a carried DM policy keeps another browser's DM users and names its saved policy", async (t) => {
  const { context, page, dialog } = await carrySlackEdit(
    t,
    "Carried Policy",
    { dmPolicy: "open", allowFrom: ["*"] },
    (opened) => opened.getByLabel("Direct-message policy").selectOption("pairing"),
    (c) => saveSlackElsewhere(c, { dmPolicy: "allowlist", allowFrom: ["U0000DDD", "U0000EEE"] }),
  );
  await dialog
    .getByRole("status")
    .filter({
      hasText:
        "Your edits are applied over the reloaded settings: Direct-message policy (also changed in another browser, saved as “Allowlist — selected users only”). Review them, then save.",
    })
    .waitFor();
  assert.equal(await dialog.getByLabel("Direct-message policy").inputValue(), "pairing");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await context.fixture.request("GET", configurationPath(context))).data;
  assert.equal(saved.values.channels.slack.dmPolicy, "pairing");
  assert.deepEqual(saved.values.channels.slack.allowFrom, ["U0000DDD", "U0000EEE"]);
});

// A DM user the reader added is ignored by the save once another browser opened DMs to anyone,
// so the note says it was not applied instead of listing it as applied (finding 1509).
test("a carried DM user is named as not applied when another browser opened DMs", async (t) => {
  const { context, page, dialog } = await carrySlackEdit(
    t,
    "Carried Off",
    { dmPolicy: "allowlist", allowFrom: ["U0000AAA"] },
    (opened) =>
      setSlackSelection(
        opened.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
        "U0000AAA, U0000BBB",
      ),
    (c) => saveSlackElsewhere(c, { dmPolicy: "open", allowFrom: ["*"] }),
  );
  await dialog
    .getByRole("status")
    .filter({
      hasText:
        "Not applied, because the reloaded settings turn it off: Allowed people in direct messages. Review them, then save.",
    })
    .waitFor();
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await context.fixture.request("GET", configurationPath(context))).data;
  assert.equal(saved.values.channels.slack.dmPolicy, "open");
  assert.deepEqual(saved.values.channels.slack.allowFrom, ["*"]);
});

// Carried edits reopened over whatever Reload draft found: after another browser moved the
// Agent to a Configuration other Agents may share, saving wrote them there; and a carried draft
// the editor could not reopen stayed for a later visit (finding 1510).
const declinedCarryCases = [
  {
    name: "moved to another Configuration",
    async elsewhere(c) {
      const current = (await c.fixture.request("GET", configurationPath(c))).data;
      const other = await c.fixture.request(
        "POST",
        `/namespaces/${c.namespace.id}/configurations`,
        { body: { kind: "agent", values: current.values } },
      );
      assert.equal(other.status, 201, JSON.stringify(other.body));
      c.other = other.data;
      const moved = await c.fixture.request(
        "PATCH",
        `/namespaces/${c.namespace.id}/agents/${c.agent.id}`,
        { body: { configurationId: other.data.id } },
      );
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
    },
    note: "Your Slack edits were not reapplied: this Agent now uses another Configuration.",
    async check(c) {
      const other = (
        await c.fixture.request("GET", `/namespaces/${c.namespace.id}/configurations/${c.other.id}`)
      ).data;
      assert.equal(other.generation, 1);
      assert.equal(other.values.channels.slack.dmPolicy, undefined);
    },
  },
  {
    name: "no longer editable here",
    // A wildcard channel is edited only in native Configuration JSON.
    elsewhere: (c) => saveSlackElsewhere(c, { channels: { "*": { requireMention: true } } }),
    note: "Your Slack edits were not reapplied: the reloaded settings cannot be edited here.",
    async check(c) {
      assert.equal(
        (await c.fixture.request("GET", configurationPath(c))).data.values.channels.slack.dmPolicy,
        undefined,
      );
    },
  },
];

for (const c of declinedCarryCases) {
  test(`carried Slack edits are dropped with a note when the Agent was ${c.name}`, async (t) => {
    const { context, page, dialog } = await carrySlackEdit(
      t,
      "Declined Carry",
      {},
      (opened) => opened.getByLabel("Direct-message policy").selectOption("disabled"),
      c.elsewhere,
    );
    await page.getByRole("status").filter({ hasText: c.note }).waitFor();
    assert.equal(await dialog.count(), 0);
    await c.check(context);
    // The declined draft is forgotten: a later visit to Channels does not try it again.
    await page.getByRole("link", { name: "← Agents", exact: true }).click();
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
    await page.getByRole("link", { name: "Declined Carry", exact: true }).click();
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
    assert.equal(await page.getByRole("status").filter({ hasText: c.note }).count(), 0);
    assert.equal(await dialog.count(), 0);
  });
}

// A Configuration reserved for provisioning also answers 409 RESOURCE_CONFLICT. The console took
// it for another browser's save and offered a Reload draft that met the same refusal forever
// (finding 1511). Only the stale-generation refusal, marked by its /expectedGeneration detail,
// offers Reload draft now. The API answer is replayed here in the exact shape the controller
// returns for a reservation (proved in postgres-agent-provisioning.test.mjs).
// A Kubernetes resourceVersion conflict answers the catch-all "already exists" sentence instead,
// which names nothing to fix, so each save shows its own conflict text (finding 1639).
const GENERIC_CONFLICT = "The requested platform resource already exists.";
const SAVED_STATE_CONFLICT =
  "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.";
// Deploy would deliver the saved bindings, not the refused choices shown (finding 1640).
const UNSAVED_SECRETS_GATE =
  "Save the channel Secret choices before deploying, or reload the page to discard unsaved changes.";
const configurationSaveCases = [
  {
    name: "Channels",
    tab: "channels",
    genericText: SAVED_STATE_CONFLICT,
    async act({ page }) {
      await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      await dialog.getByLabel("Direct-message policy").selectOption("disabled");
      await dialog.getByRole("button", { name: "Save configuration" }).click();
    },
  },
  {
    name: "Configuration editor",
    tab: "configuration",
    genericText: SAVED_STATE_CONFLICT,
    async act({ page, configurationEdit }) {
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      const values = nativeValues(configurationEdit, { harnessId: "codex" });
      await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
      await page.getByRole("button", { name: "Save Configuration" }).click();
    },
  },
  {
    name: "channel Secrets",
    tab: "credentials",
    genericText: "Credential metadata conflicts with the saved Agent state or selected Secrets.",
    staleText: "Configuration changed. Reload this draft before saving channel Secrets.",
    async act({ page, context }) {
      await selectNewSlackSecrets(page, context);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    },
  },
];

for (const [c, generic] of configurationSaveCases.flatMap((c) => [
  [c, false],
  [c, true],
])) {
  test(`a ${c.name} save refused ${generic ? "with the catch-all conflict" : "for provisioning"} shows ${generic ? "its own conflict text" : "the refusal"}, not Reload draft`, async (t) => {
    const context = await slackAgent(t, `Reserved ${c.name}`);
    const { fixture, namespace, agent } = context;
    context.secondApp = await fixture.createSecret(namespace.id, "Second app token", "xapp-2");
    context.secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
    const refusal = generic
      ? GENERIC_CONFLICT
      : "The Configuration is reserved for provisioning and is not available for this operation.";
    let writes = 0;
    const page = await openTab(t, fixture, namespace, agent, c.tab, {
      beforeLogin: (routed) =>
        routed.route(`**${configurationPath(context)}`, async (route) => {
          if (route.request().method() !== "PATCH") {
            await route.continue().catch(() => {});
            return;
          }
          writes += 1;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "RESOURCE_CONFLICT",
                message: refusal,
              },
              meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
            }),
          });
        }),
    });
    await page.getByRole("heading", { name: `Reserved ${c.name}` }).waitFor();
    await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
    const requests = apiRequests(page, fixture.origin);
    await c.act({ page, context, configurationEdit: "reserved" });
    await page
      .getByText(generic ? c.genericText : refusal)
      .first()
      .waitFor();
    assert.equal(await page.getByText(GENERIC_CONFLICT).count(), 0);
    if (c.tab === "credentials") {
      // The refused write did not bind these Secrets. Keep both choices in the rebuilt form.
      await waitForInputValue(page.getByLabel("Slack app token"), context.secondApp.name);
      await waitForInputValue(page.getByLabel("Slack bot token"), context.secondBot.name);
      assert.equal(accessBindingPostRequests(requests, namespace.id).length, 0);
      // Deploy would deliver the saved bindings, not the choices shown (finding 1640).
      await page.getByText(UNSAVED_SECRETS_GATE).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );
    }
    assert.equal(writes, 1);
    assert.equal(await page.getByRole("button", { name: "Reload draft" }).count(), 0);
    assert.equal(
      await page.getByText("The saved Configuration changed while you were editing.").count(),
      0,
    );
  });
}

// Deploy delivers the saved bindings, so a channel Secret choice that is shown but not saved
// blocks it until it is saved or the saved Secret is chosen again (finding 1640).
test("an unsaved channel Secret choice blocks Deploy new version until it is saved", async (t) => {
  const context = await slackAgent(t, "Unsaved Secrets");
  const { fixture, namespace, agent, bot } = context;
  const secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
  const page = await openTab(t, fixture, namespace, agent, "credentials");
  await page.getByRole("heading", { name: "Unsaved Secrets" }).waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  await selectSecret(page, "Slack bot token", secondBot);
  await page.getByText(UNSAVED_SECRETS_GATE).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  // Choosing the saved Secret again leaves nothing unsaved.
  await selectSecret(page, "Slack bot token", bot);
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  assert.equal(await page.getByText(UNSAVED_SECRETS_GATE).count(), 0);
  await selectSecret(page, "Slack bot token", secondBot);
  await page.getByText(UNSAVED_SECRETS_GATE).waitFor();
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  assert.equal(await page.getByText(UNSAVED_SECRETS_GATE).count(), 0);
});

// A member who cannot read the saved Secret cannot choose it again: the picker offers the
// unreadable binding only while the draft holds it. The gate names a way out that works for
// every reader, and a page reload drops the unsaved choice (finding 1649).
test("the unsaved channel Secret gate names a way out for a member who cannot read the saved Secret", async (t) => {
  const context = await slackAgent(t, "Unreadable Saved Secret");
  const { fixture, namespace, agent, bot } = context;
  const secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
  const page = await openTab(t, fixture, namespace, agent, "credentials", {
    // The member's Secret list leaves out the saved bot token, as IAM would.
    beforeLogin: (routed) =>
      routed.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue().catch(() => {});
          return;
        }
        const response = await route.fetch();
        const body = await response.json();
        body.data = body.data.filter((secret) => secret.id !== bot.id);
        await route.fulfill({ response, json: body });
      }),
  });
  await page.getByRole("heading", { name: "Unreadable Saved Secret" }).waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  const botPicker = page.getByLabel("Slack bot token", { exact: true });
  // With the list loaded, the unreadable saved binding is offered only as "Bound Secret".
  assert.equal(await botPicker.inputValue(), "Bound Secret");
  await botPicker.fill("");
  await page.getByRole("option", { name: secretOptionLabel(secondBot), exact: true }).waitFor();
  await page.getByRole("option", { name: "Bound Secret", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("option", { name: secretOptionLabel(bot), exact: true }).count(),
    0,
  );
  await selectSecret(page, "Slack bot token", secondBot);
  await page.getByText(UNSAVED_SECRETS_GATE, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  // The saved Secret is no longer offered, so "choose it again" cannot be followed.
  await botPicker.fill("");
  await page.getByRole("option", { name: secretOptionLabel(secondBot), exact: true }).waitFor();
  assert.equal(await page.getByRole("option", { name: /Bound Secret/ }).count(), 0);
  assert.equal(
    await page.getByRole("option", { name: secretOptionLabel(bot), exact: true }).count(),
    0,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Unreadable Saved Secret" }).waitFor();
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  assert.equal(await botPicker.inputValue(), "Bound Secret");
  assert.equal(await page.getByText(UNSAVED_SECRETS_GATE).count(), 0);
});

// The Deploy gate names a missing Slack binding before an unsaved Secret choice, so first-time
// setup still says what is missing while another token is being changed (#2714 review). Saving
// the choice alone would not make the draft deployable.
test("the Deploy gate names a missing Slack binding before an unsaved Secret choice", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Missing and unsaved");
  const bot = await fixture.createSecret(namespace.id, "Missing and unsaved bot", "xoxb-gate");
  const secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-gate-2");
  // Slack names both tokens, but only the bot token is bound.
  const agent = await fixture.createAgent(namespace.id, "Missing and unsaved", slackValues(), {
    executionMode: "dedicated",
    secretBindings: { SLACK_BOT_TOKEN: envBinding(bot) },
  });
  const page = await openTab(t, fixture, namespace, agent, "credentials");
  await page.getByRole("heading", { name: "Missing and unsaved" }).waitFor();
  const missing = page.getByText(
    /^Complete these in Credentials before deploying: Slack Secret bindings/,
  );
  await missing.waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isDisabled(), true);
  const gate = await missing.textContent();
  // Changing the bound token leaves the app token missing: the gate keeps naming it.
  await selectSecret(page, "Slack bot token", secondBot);
  await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(secondBot));
  await expectNoText(page, UNSAVED_SECRETS_GATE);
  assert.equal(await page.getByText(gate, { exact: true }).count(), 1);
  assert.equal(await deploy.isDisabled(), true);
});

// Reload draft after a Configuration conflict dropped the JSON editor's edits (finding 1512).
// They are now merged over the reread document key by key: the other browser's change stays,
// and a value both changed keeps the reader's and names the saved one. An object where each
// browser changed other keys is named too, since those keys may belong together (finding 1524).
test("a Configuration conflict merges the JSON edits over the reread document", async (t) => {
  const context = await slackAgent(t, "Carried JSON");
  const { fixture, namespace, agent } = context;
  const page = await openTab(t, fixture, namespace, agent, "configuration");
  await page.getByRole("heading", { name: "Carried JSON" }).waitFor();
  const before = (await fixture.request("GET", configurationPath(context))).data.values;
  const withKnowledge = (values, config) => ({
    ...values,
    plugins: {
      ...values.plugins,
      entries: {
        ...values.plugins.entries,
        knowledge: {
          ...values.plugins.entries.knowledge,
          config: { ...values.plugins.entries.knowledge.config, ...config },
        },
      },
    },
  });
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(withKnowledge(before, { marker: "mine", note: "kept" }), null, 2));
  const changed = await fixture.request("PATCH", configurationPath(context), {
    body: { values: withKnowledge(before, { marker: "theirs", thresholds: [4] }) },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page
    .getByRole("status")
    .filter({
      hasText:
        'Draft reloaded. Your edits are applied over the reloaded Configuration. Another browser also changed /plugins/entries/knowledge/config/marker (saved: "theirs"); yours are shown. Both browsers changed different keys in /plugins/entries/knowledge/config; check they still fit together. Review them, then save.',
    })
    .waitFor();
  assert.equal(await focusedText(page), "Save Configuration");
  assert.match(await focusedDescription(page), /^Draft reloaded\. Your edits are applied/);
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Configuration saved." }).waitFor();
  const saved = (await fixture.request("GET", configurationPath(context))).data;
  assert.equal(saved.generation, 3);
  assert.deepEqual(
    saved.values,
    withKnowledge(before, { marker: "mine", note: "kept", thresholds: [4] }),
  );
});

// Picks a second bot token Secret on the Credentials tab, lets another browser save first, and
// saves into the conflict. `otherApp` adds an app token Secret before the page loads; `agentRead`
// may answer the page's Agent reads, and returns true when it did.
async function channelSecretsConflict(t, name, { otherApp = false, agentRead, elsewhere }) {
  const context = await slackAgent(t, name);
  const { fixture, namespace, agent } = context;
  context.secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
  if (otherApp) {
    context.otherApp = await fixture.createSecret(namespace.id, "Other app token", "xapp-other");
  }
  const page = await openTab(t, fixture, namespace, agent, "credentials", {
    // Only callers that answer the Agent reads install a route.
    beforeLogin:
      agentRead === undefined
        ? undefined
        : (routed) =>
            routed.route(`**/namespaces/${namespace.id}/agents/${agent.id}`, async (route) => {
              if (route.request().method() !== "GET" || !(await agentRead(route))) {
                await route.continue().catch(() => {});
              }
            }),
  });
  await page.getByRole("heading", { name }).waitFor();
  await selectSecret(page, "Slack bot token", context.secondBot);
  await elsewhere(context);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Configuration changed. Reload this draft before saving channel Secrets.")
    .waitFor();
  return { context, page };
}

// The channel Secrets panel dropped its Secret choices at a conflict, before Reload draft
// (finding 1512). They now stay shown and are applied over the reread bindings, so another
// browser's change to the other token stays.
test("a channel Secrets conflict carries the chosen Secret over the reread bindings", async (t) => {
  const { context, page } = await channelSecretsConflict(t, "Carried Secrets", {
    otherApp: true,
    elsewhere: (c) => rebindElsewhere(c, "SLACK_APP_TOKEN", c.otherApp),
  });
  const { fixture, secondBot, otherApp } = context;
  // The choice stays visible while the panel waits for Reload draft.
  await waitForInputValue(page.getByLabel("Slack bot token"), "Second bot token");
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page
    .getByRole("status")
    .filter({
      hasText:
        "Your Secret choices are applied over the reloaded bindings: Slack bot token. Review them, then save.",
    })
    .waitFor();
  await waitForInputValue(page.getByLabel("Slack bot token"), "Second bot token");
  await waitForInputValue(page.getByLabel("Slack app token"), "Other app token");
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  const saved = (await fixture.request("GET", configurationPath(context))).data;
  assert.deepEqual(saved.secretBindings.SLACK_BOT_TOKEN, envBinding(secondBot));
  assert.deepEqual(saved.secretBindings.SLACK_APP_TOKEN, envBinding(otherApp));
});

// Carried channel Secret choices vanished without notice when the reread showed no Slack token
// form (finding 1525). The Channel Secrets section now says they were not reapplied.
const notReappliedCases = [
  {
    name: "Slack is off",
    other: (values) => ({
      ...values,
      channels: { slack: { ...values.channels.slack, enabled: false } },
    }),
    note: "Your channel Secret choices were not reapplied: Slack is off in the reloaded Configuration.",
  },
  {
    name: "Slack uses named accounts",
    other: (values) => ({
      ...values,
      channels: {
        slack: {
          ...values.channels.slack,
          accounts: {
            ops: {
              appToken: { source: "env", provider: "default", id: "SLACK_OPS_APP_TOKEN" },
              botToken: { source: "env", provider: "default", id: "SLACK_OPS_BOT_TOKEN" },
            },
          },
        },
      },
    }),
    note: "Your channel Secret choices were not reapplied: the reloaded Configuration uses named Slack accounts.",
  },
  {
    name: "the Agent uses operator-managed credentials",
    other: (values) => values,
    // Another browser switched the Agent's authentication; the page's reread shows it.
    runtimeAuth: true,
    note: "Your channel Secret choices were not reapplied: this Agent now uses operator-managed credentials.",
  },
];

for (const c of notReappliedCases) {
  test(`carried channel Secret choices are named as not reapplied when ${c.name}`, async (t) => {
    let runtimeAuth = false;
    const { context, page } = await channelSecretsConflict(t, "Unapplied Secrets", {
      async agentRead(route) {
        if (!runtimeAuth) {
          return false;
        }
        const response = await route.fetch();
        const json = await response.json();
        json.data = { ...json.data, harnessAuth: { method: "runtime" } };
        await route.fulfill({ response, json });
        return true;
      },
      async elsewhere(other) {
        const current = (await other.fixture.request("GET", configurationPath(other))).data;
        const changed = await other.fixture.request("PATCH", configurationPath(other), {
          body: { values: c.other(current.values) },
        });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
      },
    });
    const { fixture, secondBot } = context;
    runtimeAuth = Boolean(c.runtimeAuth);
    await page.getByRole("button", { name: "Reload draft" }).click();
    const section = page.locator("section.channel-secrets");
    await section.getByRole("status").filter({ hasText: c.note }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
    assert.equal(await page.getByLabel("Slack bot token").count(), 0);
    const saved = (await fixture.request("GET", configurationPath(context))).data;
    assert.notEqual(saved.secretBindings.SLACK_BOT_TOKEN.source.id, secondBot.id);
  });
}

// The carried choices lived in a page variable, so the page load that follows a failed Reload
// draft reread dropped them (finding 1525). The draft store now keeps them for that page.
test("carried channel Secret choices survive the page load after a failed reread", async (t) => {
  let failAgentRead = false;
  let failedReads = 0;
  const { context, page } = await channelSecretsConflict(t, "Reloaded Secrets", {
    otherApp: true,
    async agentRead(route) {
      if (!failAgentRead) {
        return false;
      }
      failAgentRead = false;
      failedReads += 1;
      await route.abort("failed");
      return true;
    },
    elsewhere: (c) => rebindElsewhere(c, "SLACK_APP_TOKEN", c.otherApp),
  });
  const { fixture, secondBot, otherApp } = context;
  failAgentRead = true;
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page
    .getByRole("status")
    .filter({
      hasText:
        "Your Secret choices are applied over the reloaded bindings: Slack bot token. Review them, then save.",
    })
    .waitFor();
  assert.equal(failedReads, 1);
  // Only the page load reads the session, versions and permissions again.
  assert.notDeepEqual(pageReloadReads(requests), []);
  await waitForInputValue(page.getByLabel("Slack bot token"), "Second bot token");
  await waitForInputValue(page.getByLabel("Slack app token"), "Other app token");
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  const saved = (await fixture.request("GET", configurationPath(context))).data;
  assert.deepEqual(saved.secretBindings.SLACK_BOT_TOKEN, envBinding(secondBot));
  assert.deepEqual(saved.secretBindings.SLACK_APP_TOKEN, envBinding(otherApp));
});

// After Save Configuration the rebuilt summary showed "Bound Secret · sec_… · Loading
// metadata…" on two lines until the Secret was reread, then collapsed to its name and moved the
// cards below (CLS 0.073, finding 1482). It now keeps the name it already showed.
test("a saved Configuration's summary keeps the Secret name while it rereads it", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Summary Name");
  const model = await fixture.createSecret(namespace.id, "Summary model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Summary Name", nativeValues("before"), {
    harnessAuth: { method: "api_key", source: model.ref },
  });
  let reads = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const page = await openTab(t, fixture, namespace, agent, "configuration", {
    // The rebuilt summary's metadata read waits, as on a slow link (a hand-written count, not
    // Playwright's { times }).
    beforeLogin: (routed) =>
      routed.route(`**/namespaces/${namespace.id}/secrets/${model.id}`, async (route) => {
        reads += 1;
        if (reads === 2) {
          await held;
        }
        await route.continue().catch(() => {});
      }),
  });
  await page.getByRole("heading", { name: "Summary Name" }).waitFor();
  const name = page.getByRole("link", { name: "Summary model key", exact: true });
  await name.waitFor();
  await page.evaluate(() => {
    globalThis.__metadataLoading = [];
    new globalThis.MutationObserver(() => {
      for (const node of globalThis.document.querySelectorAll(".secret-reference")) {
        if (node.textContent.includes("Loading metadata")) {
          globalThis.__metadataLoading.push(node.textContent);
        }
      }
    }).observe(globalThis.document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("after"), null, 2));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("status").filter({ hasText: "Configuration saved." }).waitFor();
  assert.ok(reads >= 2, "the rebuilt summary rereads the Secret");
  assert.equal(await name.isVisible(), true);
  assert.deepEqual(await page.evaluate(() => globalThis.__metadataLoading), []);
});

// A channel save's own state clears before the saved draft refreshes, so only the refresh keeps
// the other tabs locked until the rebuilt tab is in place; no test checked it (finding 1487).
test("the other tabs stay locked while a saved channel draft refreshes", async (t) => {
  const context = await slackAgent(t, "Refresh Lock");
  const { fixture, namespace, agent } = context;
  // The page's third Configuration read (load, save preflight, refresh) waits; a hand-written
  // count, not Playwright's { times }.
  let reads = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let markRefreshing;
  const refreshing = new Promise((resolve) => {
    markRefreshing = resolve;
  });
  t.after(() => release());
  const page = await openTab(t, fixture, namespace, agent, "channels", {
    beforeLogin: (routed) =>
      routed.route(`**${configurationPath(context)}`, async (route) => {
        if (route.request().method() === "GET" && ++reads === 3) {
          markRefreshing();
          await held;
        }
        await route.continue().catch(() => {});
      }),
  });
  await page.getByRole("heading", { name: "Refresh Lock" }).waitFor();
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  const plugins = page.getByRole("tab", { name: "Plugins", exact: true });
  await waitForEnabled(plugins);
  await page.getByRole("button", { name: "Disable Slack" }).click();
  await refreshing;
  assert.equal(await plugins.isDisabled(), true);
  assert.equal(
    await page.getByRole("tab", { name: "Credentials", exact: true }).isDisabled(),
    true,
  );
  release();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  await waitForEnabled(plugins);
});

// Save Configuration collapses the ~400 px editor to its summary when the save lands, about
// 0.7 s after the click on a live cluster, past the input's 500 ms grace. Stop Agent then
// moved up into view: CLS 0.074 (finding 1482).
test("a Configuration save that lands late does not move the cards below the editor", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Late save");
  const agent = await fixture.createAgent(namespace.id, "Late Save", nativeValues("before"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const page = await openTab(t, fixture, namespace, agent, "configuration", {
    viewport: { width: 1280, height: 800 },
    // The save lands 900 ms after the click.
    beforeLogin: (routed) =>
      routed.route(`**/namespaces/${namespace.id}/configurations/*`, async (route) => {
        if (route.request().method() === "PATCH") {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        await route.fallback().catch(() => {});
      }),
  });
  await page.getByRole("heading", { name: "Late Save" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("after"), null, 2));
  const save = page.getByRole("button", { name: "Save Configuration" });
  // A reader scrolls the editor's actions into view, then saves once the page is still.
  await save.evaluate((control) => control.scrollIntoView({ block: "center" }));
  await page.evaluate(() => globalThis.document.fonts.ready);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.evaluate(recordLayoutShifts);
  await save.click();
  await page.getByRole("status").filter({ hasText: "Configuration saved." }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 500));
  // The tab and the cards below it. Headless Chromium also reports the body itself when the
  // page gets shorter, on main as well, which a reader does not see.
  const { shifts } = await takeLayoutShifts(page);
  const shift = shifts
    .filter((entry) => entry.sources.some((source) => !source.node.startsWith("BODY.")))
    .reduce((sum, entry) => sum + entry.value, 0);
  t.diagnostic(`shift ${shift}: ${JSON.stringify(shifts)}`);
  assert.ok(shift < 0.01, `shift ${shift}`);
  // The saved summary's next step is in view, where Save Configuration was.
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Edit Configuration",
  );
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).isVisible(), true);
});

// A deployed Agent's Configuration tab with an unsaved edit in the JSON editor.
async function editedConfiguration(t) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Team");
  const agent = await fixture.createAgent(namespace.id, "Field Guide", nativeValues("before"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const page = await openTab(t, fixture, namespace, agent, "configuration");
  const edit = page.getByRole("button", { name: "Edit Configuration" });
  await edit.click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("after"), null, 2));
  return { page, namespace, agent, edit };
}

// Pressing Save disabled it while it held focus, so focus fell to the body for the whole
// "Checking Configuration…" wait (finding 1646). The status takes it, as Deploy's does, until
// Edit Configuration takes it once the save lands.
test("a keyboard Configuration save keeps focus on its status while the save is checked", async (t) => {
  const { page, namespace, agent } = await editedConfiguration(t);

  // The save's reread of the Configuration is held, as on a slow link.
  const reread = await holdRequests(t, page, `**${configurationPath({ namespace, agent })}`, {
    once: true,
    method: "GET",
  });
  const save = page.getByRole("button", { name: "Save Configuration" });
  await save.focus();
  // Every frame from here until Edit Configuration has focus: the focused node.
  await page.evaluate(() => {
    const trail = [];
    globalThis.focusTrail = trail;
    globalThis.focusFrames = 0;
    const sample = () => {
      globalThis.focusFrames += 1;
      const node = globalThis.document.activeElement;
      const entry =
        !node || node === globalThis.document.body
          ? "BODY"
          : `${node.tagName}: ${node.textContent.trim()}`;
      if (trail.at(-1) !== entry) {
        trail.push(entry);
      }
      if (entry !== "BUTTON: Edit Configuration") {
        globalThis.requestAnimationFrame(sample);
      }
    };
    sample();
  });
  await page.keyboard.press("Enter");
  await reread.requested;
  const held = await page.evaluate(() => globalThis.focusFrames);
  await page.waitForFunction((frames) => globalThis.focusFrames >= frames + 12, held);
  reread.release();
  await page.waitForFunction(() => globalThis.focusTrail.at(-1) === "BUTTON: Edit Configuration");
  const trail = await page.evaluate(() => globalThis.focusTrail);
  assert.deepEqual(
    trail,
    ["BUTTON: Save Configuration", "P: Checking Configuration…", "BUTTON: Edit Configuration"],
    trail.join(" | "),
  );
  await page.getByRole("status").filter({ hasText: "Configuration saved." }).waitFor();
});

// The reader who moved on keeps focus, so no focused control names "Configuration saved.": the
// status announces itself instead, by taking its text after it is shown (finding 1641).
test("a late Configuration save leaves focus on the Agents link when the reader moved there", async (t) => {
  const { page, namespace, agent, edit } = await editedConfiguration(t);

  const saved = await holdRequests(t, page, `**${configurationPath({ namespace, agent })}`, {
    once: true,
    method: "PATCH",
    afterServer: true,
  });
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await saved.requested;
  await page.getByRole("link", { name: "← Agents", exact: true }).focus();
  // The texts each status showed, sampled after every rendered frame.
  await page.evaluate(() => {
    const shown = new Map();
    globalThis.shownStatusTexts = shown;
    const sample = () => {
      let saved = false;
      for (const status of globalThis.document.querySelectorAll('[role="status"]')) {
        const texts = shown.get(status) ?? [];
        if (texts.at(-1) !== status.textContent) {
          texts.push(status.textContent);
        }
        shown.set(status, texts);
        saved ||= status.textContent === "Configuration saved.";
      }
      if (!saved) {
        globalThis.requestAnimationFrame(() => setTimeout(sample));
      }
    };
    sample();
  });
  saved.release();

  await edit.waitFor();
  // The status was shown empty first, so its text arrived as a change.
  const texts = await page.waitForFunction(
    () =>
      [...globalThis.shownStatusTexts].find(
        ([status, shown]) => status.isConnected && shown.at(-1) === "Configuration saved.",
      )?.[1],
  );
  assert.deepEqual(await texts.jsonValue(), ["", "Configuration saved."]);
  assert.equal(await edit.getAttribute("aria-describedby"), null);
  assert.equal(await focusedText(page), "← Agents");
});

// A save from another browser that landed between a save's reread and its PATCH was silently
// overwritten (finding 1505). The PATCH now names the generation the page read, and the API's
// 409 leaves Reload draft as the next step, as a conflict found by the reread does.
for (const c of configurationSaveCases) {
  test(`a ${c.name} save raced after its reread is refused and offers Reload draft`, async (t) => {
    const context = await slackAgent(t, `Raced ${c.name}`);
    const { fixture, namespace, agent } = context;
    context.secondApp = await fixture.createSecret(namespace.id, "Second app token", "xapp-2");
    context.secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
    const patches = [];
    const before = (await fixture.request("GET", configurationPath(context))).data.values;
    const page = await openTab(t, fixture, namespace, agent, c.tab, {
      // Another browser saves after the page's preflight reread, just before its PATCH.
      beforeLogin: (routed) =>
        routed.route(`**${configurationPath(context)}`, async (route) => {
          if (route.request().method() === "PATCH") {
            patches.push(route.request().postDataJSON());
            await changeElsewhere(context);
          }
          await route.continue().catch(() => {});
        }),
    });
    await page.getByRole("heading", { name: `Raced ${c.name}` }).waitFor();
    await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
    await c.act({ page, context, configurationEdit: "raced" });
    const message =
      c.staleText ??
      "The saved Configuration changed while you were editing. Reload this draft before saving.";
    await page.getByText(message).first().waitFor();
    assert.equal(await focusedText(page), "Reload draft");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].expectedGeneration, 1);
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
    // The other browser's save stands; the page's edit did not replace it.
    const saved = (await fixture.request("GET", configurationPath(context))).data;
    assert.equal(saved.generation, 2);
    assert.deepEqual(saved.values, before);

    await page.getByRole("button", { name: "Reload draft" }).click();
    await page.getByRole("status").filter({ hasText: "Draft reloaded." }).waitFor();
  });
}

// Edit current Configuration, low on a version's page, switched to the draft at the top of the
// page and focused its heading; the editor still needed an Edit Configuration click about
// 1,500 px below (finding 2061). It now opens the draft with the editor open, in view and focused.
// The editor came to the very top, with the draft's "New version" notice out of view, so nothing
// on screen said this was the draft (finding 2086): the notice now sits at the top, above it.
const draftEditorInView = (page) =>
  page.waitForFunction(() => {
    const active = globalThis.document.activeElement;
    const notice = globalThis.document.querySelector(".version-selection-notice");
    if (active?.id !== "configuration-json" || !notice?.textContent.startsWith("New version.")) {
      return false;
    }
    const editor = active.getBoundingClientRect();
    const shown = notice.getBoundingClientRect();
    return (
      shown.top >= 0 &&
      shown.top < 120 &&
      editor.top > shown.bottom &&
      editor.top + 80 <= globalThis.innerHeight
    );
  });

test("Edit current Configuration opens the draft's Configuration editor in view and focused", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Edit current");
  const agent = await fixture.createAgent(namespace.id, "Edit Current", nativeValues("current"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  const start = page.getByRole("button", { name: "Edit current Configuration" });
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  const editor = page.getByLabel("Configuration JSON");
  await editor.waitFor();
  await draftEditorInView(page);
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);

  // The draft page can show before its Configuration read lands: the editor opens once it does.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration").href);
  await start.waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  const draftRead = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "GET", once: true },
  );
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  await draftRead.requested;
  await page.waitForFunction(
    () => globalThis.document.activeElement?.closest(".agent-tabs") !== null,
  );
  draftRead.release();
  await draftEditorInView(page);

  // Unsaved edits keep the draft in its editor: going to v1 and back through Edit current
  // Configuration brings that editor, with the edits, into view and focus.
  await editor.fill(`${await editor.inputValue()}\n`);
  await page.locator('.revision-selector [aria-label$=", current version"]').click();
  await page.waitForURL((next) => next.searchParams.get("revision") === revision.id);
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  await draftEditorInView(page);
  assert.match(await editor.inputValue(), /\n$/);
});

// A window too short for the notice and the editor's first lines together brings the editor
// itself to the top (finding 2086).
test("Edit current Configuration in a short window brings the editor to the top", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Edit short");
  const agent = await fixture.createAgent(namespace.id, "Edit Short", nativeValues("current"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 420 } },
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  const start = page.getByRole("button", { name: "Edit current Configuration" });
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  await page.waitForFunction(() => {
    const active = globalThis.document.activeElement;
    const box = active?.getBoundingClientRect();
    const notice = globalThis.document.querySelector(".version-selection-notice");
    // The editor, not the notice, is at the top: the notice is above the window.
    return (
      active?.id === "configuration-json" &&
      box.top >= 0 &&
      box.top < 120 &&
      notice?.getBoundingClientRect().bottom <= 0
    );
  });
});

// A draft already shown and kept for a return is restored, not rebuilt, when Edit current
// Configuration opens it again: that return opens its editor too (finding 2089).
test("Edit current Configuration opens the editor of a kept draft it returns to", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Edit kept");
  const agent = await fixture.createAgent(namespace.id, "Edit Kept", nativeValues("current"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await trackSettledFetches(page);
  // A settled deployment record and no polls, so each page is kept as it was left.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: revision.id,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: "succeeded",
            error: null,
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_test_edit_kept" },
        }),
      }),
  );
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  const start = page.getByRole("button", { name: "Edit current Configuration" });
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  await draftEditorInView(page);
  // The kept draft is the same node when it comes back.
  await page.locator(".agent-version-detail").evaluate((node) => {
    node.dataset.kept = "";
  });
  // The editor can be in view before the draft's other reads land (its Secret's name, say); a
  // draft left with one still pending is rebuilt on return, not kept.
  await waitForIdleFetches(page);
  await page.goBack();
  await page.waitForURL((next) => next.searchParams.get("revision") === revision.id);
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await page.waitForURL(/revision=draft/);
  await draftEditorInView(page);
  assert.equal(await page.locator(".agent-version-detail[data-kept]").count(), 1);
});
