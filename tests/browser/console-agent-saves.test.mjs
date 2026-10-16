import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
  pathRequests,
  recordLayoutShifts,
  selectSecret,
  takeLayoutShifts,
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

// Saves and reloads on the Agent page's tabs, and every Reload draft, re-navigated to the same
// URL: the page collapsed to its summary, reread the session, versions, permissions and
// deployments (about 12 reads), jumped to the top, dropped focus and showed no saved message
// (findings 1445 and 1446). They now refresh in place.

const scrollY = (page) => page.evaluate(() => globalThis.scrollY);
const pageReloadReads = (requests) =>
  requests
    .filter((request) => request.method === "GET")
    .map((request) => request.path)
    .filter((path) => /\/api\/auth\/session|\/revisions|\/permissions|\/deployments/.test(path));

// Opens an Agent draft tab. The default viewport is short, so a reload's jump to the top shows
// as a lost scroll position.
async function openTab(t, fixture, namespace, agent, tab, options = {}) {
  const { page } = await newPage(t, fixture, {
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

async function slackAgent(t, name) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-in-place");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-in-place");
  const agent = await fixture.createAgent(
    namespace.id,
    name,
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
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  return { fixture, namespace, agent };
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
      await page.getByRole("heading", { name: "Create new version" }).waitFor();
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
    focus: "Edit Configuration",
    described: true,
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
      assert.equal(await focusedDescription(page), c.saved);
    }
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isEnabled(), true);
    await c.verify?.(page, context, place.requests);
  });
}

// The authentication source save re-navigated the same way. It now refreshes in place from
// the saved Agent, and a second save checks against that saved state instead of the page's
// first read. Reload authentication source keeps focus too (finding 1446).
test("saving and reloading the authentication source update the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Authentication in place", { ready: true });
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
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  read.release();
  await page.unroute(agentPath);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await waitForInputValue(secretField, secretOptionLabel(first));
  await saveAuthentication.waitFor();
  assert.equal(await saveAuthentication.isDisabled(), false);
  assert.equal(await reload.isDisabled(), false);
});

// Refresh sharing, the Configuration editor's Cancel and the Create Agent shortcuts replaced or
// disabled the control the reader used, dropping keyboard focus to the document (finding 1446).
test("Refresh sharing, editor Cancel and the Create Agent shortcuts keep keyboard focus", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  );
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [preset] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Kept focus", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Kept Focus", nativeValues("focus"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Kept Focus" }).waitFor();

  const sharing = page.getByRole("region", { name: "Share Agent", exact: true });
  await sharing.getByText("Current policy loaded.", { exact: false }).waitFor();
  await sharing.getByRole("button", { name: "Refresh sharing" }).focus();
  await page.keyboard.press("Enter");
  await sharing.getByRole("button", { name: "Refresh sharing", disabled: false }).waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.tagName !== "BODY");
  assert.equal(await focusedText(page), "Refresh sharing");

  await page.getByRole("button", { name: "Edit Configuration" }).click();
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
  // The plugin fields go inert while saving; the JSON stays in them.
  assert.equal(
    await json.evaluate((node) => node.disabled || node.closest("[inert]") !== null),
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
  await reload.click();
  await page.getByRole("status").filter({ hasText: "Plugin selections reloaded." }).waitFor();
  await place.check();
  assert.deepEqual(JSON.parse(await json.inputValue()), elsewhere);
  assert.equal(await save.isDisabled(), true);
  // The rebuilt editor is clean, so the tabs are free to leave again.
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
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
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
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
  const { page } = await newPage(t, fixture);
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
  // The choices' completion updates the editor; it must stay locked, so no field can make
  // the cancelled edit savable again.
  const profile = page.locator("#repository-default-git-read");
  await profile.waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));
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

// After Save Configuration the rebuilt summary showed "Bound Secret · sec_… · Loading
// metadata…" on two lines until the Secret was reread, then collapsed to its name and moved the
// cards below (CLS 0.073, finding 1482). It now keeps the name it already showed.
test("a saved Configuration's summary keeps the Secret name while it rereads it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Summary Name", { ready: true });
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
  const plugins = page.getByRole("button", { name: "Plugins", exact: true });
  assert.equal(await plugins.isEnabled(), true);
  await page.getByRole("button", { name: "Disable Slack" }).click();
  await refreshing;
  assert.equal(await plugins.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Credentials", exact: true }).isDisabled(),
    true,
  );
  release();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  assert.equal(await plugins.isEnabled(), true);
});

// Save Configuration collapses the ~400 px editor to its summary when the save lands, about
// 0.7 s after the click on a live cluster, past the input's 500 ms grace. Stop Agent then
// moved up into view: CLS 0.074 (finding 1482).
test("a Configuration save that lands late does not move the cards below the editor", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Late save", { ready: true });
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
