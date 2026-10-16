import assert from "node:assert/strict";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  pathRequests,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  focusedDescription,
  focusedText,
  openAdvancedSettings,
  watchForReload,
} from "./console-agents-test-support.mjs";

// Saves and reloads on the Plugins, Channels and Repositories tabs, and every Reload draft,
// re-navigated to the same URL: the page collapsed to its summary, reread the session,
// versions, permissions and deployments, jumped to the top and showed no saved message. #2548
// fixed this for the Configuration and authentication source saves; these now refresh in place
// too (the rest of finding 1445).

const scrollY = (page) => page.evaluate(() => globalThis.scrollY);
const pageReloadReads = (requests) =>
  requests
    .filter((request) => request.method === "GET")
    .map((request) => request.path)
    .filter((path) => /\/api\/auth\/session|\/revisions|\/permissions|\/deployments/.test(path));

// Scrolls `control` below the first screen at a short viewport, so a reload's jump to the top
// shows as a lost scroll position.
async function scrollTo(page, control) {
  await control.scrollIntoViewIfNeeded();
  const before = await scrollY(page);
  assert.ok(before > 0, "the control sits below the first screen");
  return before;
}

async function assertKeptPlace(page, kept, requests, scrollBefore) {
  assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
  assert.deepEqual(pageReloadReads(requests), []);
  assert.ok((await scrollY(page)) > scrollBefore / 2, "the page kept its scroll position");
}

test("saving and reloading plugin selections update the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Plugins in place", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Plugins In Place",
    nativeValues("plugins", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: null },
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 600 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByRole("heading", { name: "Plugins In Place" }).waitFor();
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  const edited = { "codex-plugin:linear@openai-curated-remote": { enabled: false } };
  await json.fill(JSON.stringify(edited));
  const save = page.getByRole("button", { name: "Save plugin selections", exact: true });
  const scrollBefore = await scrollTo(page, save);
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await save.click();
  await page.getByRole("status").filter({ hasText: "Plugin selections saved." }).waitFor();
  await assertKeptPlace(page, kept, requests, scrollBefore);
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
  await assertKeptPlace(page, kept, requests, scrollBefore);
  assert.deepEqual(JSON.parse(await json.inputValue()), elsewhere);
  assert.equal(await save.isDisabled(), true);
  // The rebuilt editor is clean, so the tabs are free to leave again.
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
});

async function createSlackAgent(fixture, namespace, name) {
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-in-place");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-in-place");
  return fixture.createAgent(
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
}

test("channel saves and Reload draft update the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channels in place", { ready: true });
  const agent = await createSlackAgent(fixture, namespace, "Channels In Place");
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 600 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
  await page.getByRole("heading", { name: "Channels In Place" }).waitFor();
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  const disable = page.getByRole("button", { name: "Disable Slack" });
  const scrollBefore = await scrollTo(page, disable);
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await disable.click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  await page.getByText(/Configuration .* · generation 2$/).waitFor();
  await assertKeptPlace(page, kept, requests, scrollBefore);
  // Disable is gone; focus stays on the provider's remaining action.
  assert.equal(await focusedText(page), "Edit Slack");
  assert.equal(await focusedDescription(page), "Channels saved.");
  assert.equal(await disable.count(), 0);
  assert.equal(
    (await fixture.request("GET", configurationPath)).data.values.channels.slack.enabled,
    false,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isEnabled(), true);
});

test("Reload draft after a lost channel save updates the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel reload in place", { ready: true });
  const agent = await createSlackAgent(fixture, namespace, "Channel Reload In Place");
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 600 } },
  });
  // The API commits, but the browser cannot know that the response was lost.
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
  await page.getByRole("heading", { name: "Channel Reload In Place" }).waitFor();
  await page.getByRole("button", { name: "Deploy new version", disabled: false }).waitFor();
  const disable = page.getByRole("button", { name: "Disable Slack" });
  await disable.click();
  const reload = page.getByRole("button", { name: "Reload draft" });
  await reload.waitFor();
  const scrollBefore = await scrollTo(page, reload);
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await reload.click();
  await page.getByRole("status").filter({ hasText: "Draft reloaded." }).waitFor();
  await page.getByText(/Configuration .* · generation 2$/).waitFor();
  await assertKeptPlace(page, kept, requests, scrollBefore);
  assert.equal(await focusedText(page), "Draft reloaded.");
  assert.equal(await reload.count(), 0);
  assert.equal(await disable.count(), 0);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isEnabled(), true);
});

test("repository saves, Cancel and Reload draft update the Agent page in place", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repositories In Place",
    nativeValues("repositories"),
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const access = (defaultProfile) => ({
    defaultProfile,
    repositories: [{ repositoryRef: "application" }],
  });
  const initial = await fixture.request("PATCH", agentPath, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-full") },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 600 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"));
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const scrollBefore = await scrollTo(page, save);
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await page.locator("#repository-default-git-read").check();
  await save.click();
  await page.getByRole("status").filter({ hasText: "Repository access saved." }).waitFor();
  await assertKeptPlace(page, kept, requests, scrollBefore);
  assert.equal(await focusedText(page), "Repository access saved.");
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.repositoryAccess, {
    ...access("git-read"),
  });

  // Cancel drops the edit and rebuilds from the saved state in place.
  await page.locator("#repository-default-git-full").check();
  assert.equal(await save.isEnabled(), true);
  await cancel.click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#repository-default-git-read")?.checked === true,
  );
  await assertKeptPlace(page, kept, requests, scrollBefore);
  assert.equal(await focusedText(page), "Cancel");
  assert.equal(await save.isDisabled(), true);

  // A change saved elsewhere asks for Reload draft, which rebuilds in place too.
  const concurrent = await fixture.request("PATCH", agentPath, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-write") },
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
  await assertKeptPlace(page, kept, requests, scrollBefore);
  await page
    .getByText("Contributor · no issue management · Agent default", { exact: true })
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
});

test("Reload draft in the Configuration editor updates the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration reload", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Configuration Reload In Place",
    nativeValues("before"),
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 600 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Configuration Reload In Place" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  await editor.fill(JSON.stringify(nativeValues("mine"), null, 2));
  const changed = await fixture.request("PATCH", configurationPath, {
    body: { values: nativeValues("theirs") },
  });
  assert.equal(changed.status, 200);
  await page.getByRole("button", { name: "Save Configuration" }).click();
  const reload = page.getByRole("button", { name: "Reload draft" });
  await reload.waitFor();
  const scrollBefore = await scrollTo(page, reload);
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await reload.click();
  await page.getByRole("status").filter({ hasText: "Draft reloaded." }).waitFor();
  await page.getByText(/Configuration .* · generation 2$/).waitFor();
  await assertKeptPlace(page, kept, requests, scrollBefore);
  assert.equal(await focusedText(page), "Edit Configuration");
  assert.equal(await focusedDescription(page), "Draft reloaded.");
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isEnabled(), true);
});

// Cancel rereads the Agent before the tab is rebuilt. A repository-choices read that finished
// in that window re-enabled Save on the editor being replaced, so the cancelled edit could
// still be written (review of #2551).
test("repository Cancel keeps the replaced editor locked while choices finish loading", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repositories Cancel Lock",
    nativeValues("repositories-cancel"),
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const saved = await fixture.request("PATCH", agentPath, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: {
        defaultProfile: "git-full",
        repositories: [{ repositoryRef: "application" }],
      },
    },
  });
  assert.equal(saved.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const hold = async (url, method) => {
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let requested;
    const seen = new Promise((resolve) => {
      requested = resolve;
    });
    await page.route(
      url,
      async (route) => {
        if (route.request().method() !== method) {
          await route.fallback();
          return;
        }
        requested();
        await released;
        await route.continue().catch(() => {});
      },
      { times: 1 },
    );
    return { seen, release };
  };
  const options = await hold(`${fixture.origin}${agentPath}/repository-options`, "GET");
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"));
  await options.seen;
  const remove = page.getByRole("button", { name: /^Remove/ });
  await remove.click();
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const reread = await hold(`${fixture.origin}${agentPath}`, "GET");
  await cancel.click();
  await reread.seen;
  options.release();
  await page.waitForResponse((response) => response.url().endsWith("/repository-options"));
  // Let the choices' completion run its updates.
  await new Promise((resolve) => setTimeout(resolve, 300));
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
