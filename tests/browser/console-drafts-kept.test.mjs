import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  asksBeforeUnload,
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
  pathRequests,
  repositoryCheckbox,
  selectSecret,
  settlePageRequests,
  waitForCondition,
  waitForInputValue,
  writeRequests,
} from "./console-agents-browser-helpers.mjs";
import {
  configurationPostRequests,
  createModelCredentialSecret,
  createRepositoryLaunchFixture,
  enterManualModel,
  routeInstallationProvisioning,
  raceAgentName,
  routeInstallationWithoutProvisioning,
} from "./console-agents-test-support.mjs";
import {
  CHANNEL_SECRETS_CONFIGURATION_CHANGED,
  REPOSITORY_EDITS_PENDING,
  RESOURCE_NOT_FOUND,
} from "../helpers/refusal-text.mjs";

// Unsaved drafts survive a refused Create and a failed Namespace read, and a pending save holds
// every way off the page (findings 1934, 1935, 1937). The rules that keep untouched forms and
// saved choices from asking before a reload are pinned too (finding 1938).

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const standardCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });

const sidebarLink = (page, name) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name, exact: true });
const heading = (page, name) => page.getByRole("heading", { name, exact: true });
// Refocusing the window rechecks the session and Namespace access.
const refocus = (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

// Fails the next `/namespaces` read, as a dropped connection would.
async function failNextNamespacesRead(page) {
  const failed = Promise.withResolvers();
  let armed = true;
  await page.route("**/namespaces", async (route) => {
    if (!armed || route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    armed = false;
    await route.abort("connectionreset");
    failed.resolve();
  });
  return failed.promise;
}

function revokeNamespace(fixture, namespace, id) {
  fixture.policy.restrictions.push({
    id,
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
}

function restoreNamespace(fixture, id) {
  const index = fixture.policy.restrictions.findIndex((restriction) => restriction.id === id);
  assert.notEqual(index, -1);
  fixture.policy.restrictions.splice(index, 1);
}

async function startDefaultPreset(page) {
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
}

const envBinding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });

async function createSlackAgent(fixture, namespace, name) {
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-kept");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-kept");
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues("kept", {
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
      secretBindings: { SLACK_APP_TOKEN: envBinding(app), SLACK_BOT_TOKEN: envBinding(bot) },
    },
  );
  return { agent, app, bot };
}

test("a refused Create stays a draft for a reload and a return, and the retry reuses what it saved", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Refused create", { ready: true });
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: standardCodexPreset,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-refused-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const name = page.getByLabel("Agent name", { exact: true });
  await name.waitFor();
  assert.equal(await asksBeforeUnload(page), true);

  // Another create takes the name after the preflight, so the Secret and Configuration are saved
  // before the API refuses the Agent.
  await raceAgentName(page, fixture, namespace.id, "Existing Agent");
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  // The form is still the reader's to fix, so a reload asks first (finding 1934).
  assert.equal(await asksBeforeUnload(page), true);

  await sidebarLink(page, "Agents").click();
  await heading(page, "Agents").waitFor();
  assert.equal(await asksBeforeUnload(page), true);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await name.waitFor();
  assert.equal(await name.inputValue(), "Existing Agent");
  // The kept form names, and reuses, the Secret and Configuration the refused attempt saved.
  const savedLine = page.getByText(/^Secret saved: \S+\. Configuration saved: \S+\. Retries reuse/);
  await savedLine.waitFor();
  const [, secretId, configurationId] = /^Secret saved: (\S+)\. Configuration saved: (\S+)\./.exec(
    await savedLine.textContent(),
  );

  // The retry uses the Secret the refused attempt saved; the restored form cannot pick another.
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isDisabled(), true);
  await name.fill("Kept Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { data } = await created.json();
  await page.waitForURL((url) => url.pathname === `/console/agents/${data.id}`);
  assert.equal(data.name, "Kept Agent");
  assert.equal(data.configurationId, configurationId);
  assert.equal(data.harnessAuth.source.id, secretId);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  // A created Agent leaves no draft behind.
  assert.equal(await asksBeforeUnload(page), false);
});

test("a draft kept after a refusal between the Secret and the Configuration keeps that Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Refused configuration", { ready: true });
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: standardCodexPreset,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  // The first Configuration write is refused as too many requests; nothing was saved by it.
  let refuse = true;
  await page.route(`**/namespaces/${namespace.id}/configurations`, async (route, request) => {
    if (!refuse || request.method() !== "POST") {
      await route.fallback();
      return;
    }
    refuse = false;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "Slow down." } }),
    });
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Refused configuration Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-refused-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const name = page.getByLabel("Agent name", { exact: true });
  await name.waitFor();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const savedLine = page.getByText(/^Secret saved: \S+\. Retries reuse/);
  await savedLine.waitFor();
  const [, secretId] = /^Secret saved: (\S+)\./.exec(await savedLine.textContent());

  await sidebarLink(page, "Agents").click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await name.waitFor();
  await savedLine.waitFor();
  // The restored form has no password field; it names the saved Secret and keeps it fixed, since
  // the retry grants the Agent access to that Secret (internal review).
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, "Refused configuration Agent");
  assert.equal(await picker.isDisabled(), true);

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { data } = await created.json();
  await page.waitForURL((url) => url.pathname === `/console/agents/${data.id}`);
  assert.equal(data.harnessAuth.source.id, secretId);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.ok(
    access.data.some(
      (binding) => binding.subjectId === data.servicePrincipalId && binding.resourceId === secretId,
    ),
  );
});

test("a failed Namespace read keeps drafts; a read that no longer lists their Namespace drops them", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Kept drafts", { ready: true });
  const other = await fixture.createNamespace("Other drafts", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await startDefaultPreset(page);
  await page.getByLabel("Agent name", { exact: true }).fill("Kept draft");

  const failed = failNextNamespacesRead(page);
  await sidebarLink(page, "Namespaces").click();
  await failed;
  await heading(page, "Namespace access unavailable").waitFor();
  // Hiding private content does not need dropping the in-memory draft (finding 1935).
  assert.equal(await asksBeforeUnload(page), true);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await heading(page, "Namespaces").waitFor();
  await sidebarLink(page, "Agents").click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await waitForInputValue(page.getByLabel("Agent name", { exact: true }), "Kept draft");

  // Another Namespace's pages keep the draft; a read that no longer lists its Namespace drops it.
  await page.getByLabel("Namespace", { exact: true }).selectOption(other.id);
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  assert.equal(await asksBeforeUnload(page), true);
  revokeNamespace(fixture, namespace, "drafts-kept-revoke");
  await sidebarLink(page, "Namespaces").click();
  await heading(page, "Namespaces").waitFor();
  await page.getByText("Other drafts", { exact: true }).waitFor();
  assert.equal(await page.getByText("Kept drafts", { exact: true }).count(), 0);
  assert.equal(await asksBeforeUnload(page), false);

  restoreNamespace(fixture, "drafts-kept-revoke");
  await sidebarLink(page, "Agents").click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  await page.getByLabel("Namespace", { exact: true }).selectOption(namespace.id);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  // The chooser of a ready Namespace adds no status line, and no stray "null" text.
  assert.equal(
    await page
      .locator('.content [aria-live="polite"]:not([inert])')
      .evaluate((view) =>
        [...view.childNodes].some(
          (node) =>
            node.nodeType === globalThis.Node.TEXT_NODE && node.textContent.includes("null"),
        ),
      ),
    false,
  );
});

test("a failed Namespace recheck keeps the Agent page's Configuration edit", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Kept editor", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Kept editor Agent", nativeValues("kept"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editor = page.getByLabel("Configuration JSON", { exact: true });
  await editor.fill('{"edited": true}');

  const failed = failNextNamespacesRead(page);
  await refocus(page);
  await failed;
  await heading(page, "Namespace access unavailable").waitFor();
  assert.equal(await asksBeforeUnload(page), true);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await waitForInputValue(editor, '{"edited": true}');
  assert.equal(await asksBeforeUnload(page), true);
});

test("a pending save holds the sidebar links and Back on the Agent page", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pending leave", { ready: true });
  const { agent } = await createSlackAgent(fixture, namespace, "Pending leave Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Pending leave Agent" }).click();
  const openTab = async (name, id) => {
    await page.getByRole("tab", { name, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("tab") === id);
  };
  await openTab("Channels", "channels");
  // Channels kept while Repositories is open comes back as the same DOM, and with it its own
  // note, not the Repositories editor's (finding 1962).
  const disableSlack = page.getByRole("button", { name: "Disable Slack" });
  await disableSlack.evaluate((node) => {
    node.dataset.retained = "true";
  });
  await openTab("Repositories", "repositories");
  await openTab("Channels", "channels");
  assert.equal(await disableSlack.getAttribute("data-retained"), "true");
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
  const held = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH" },
  );
  await disableSlack.click();
  await held.requested;
  const pageUrl = page.url();
  const note = page.getByText(
    "Wait for channel settings save to finish before leaving the editor.",
  );
  try {
    // The sidebar refuses as ← Agents does (finding 1937).
    await sidebarLink(page, "Agents").click();
    await note.waitFor();
    assert.equal(page.url(), pageUrl);
    await sidebarLink(page, "Namespaces").click();
    assert.equal(page.url(), pageUrl);
    // So does Back to another page (the Agents list, before the Agent and its three tab
    // changes). The browser returns to this entry without discarding the intervening tabs.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          globalThis.addEventListener("popstate", resolve, { once: true });
          globalThis.history.go(-4);
        }),
    );
    await page.waitForURL(pageUrl);
    assert.equal(await deploy.isDisabled(), true);
    await note.waitFor();
    // On a phone the refusal closes the navigation drawer, which would hide the reason.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".mobile-toggle").click();
    await page.locator(".shell.drawer-open").waitFor();
    await sidebarLink(page, "Agents").click();
    assert.equal(await page.locator(".shell.drawer-open").count(), 0);
    assert.equal(page.url(), pageUrl);
    assert.equal(await note.isVisible(), true);
    await page.setViewportSize({ width: 1280, height: 720 });
  } finally {
    held.release();
  }
  await page.getByText(/Configuration .*generation 2/).waitFor();
  // The refused traversal kept all four entries, so the same traversal now reaches the list.
  await page.evaluate(() => globalThis.history.go(-4));
  await heading(page, "Agents").waitFor();
});

// Each write that holds the page names itself beside its control when the sidebar, Back or
// ← Agents is refused; they refused in silence before (findings 1962, 1965). A reload or tab
// close asks first while it runs (finding 2125).
for (const pending of [
  {
    kind: "a deploy",
    tab: "configuration",
    reason: "This page stays open until the deploy request finishes.",
    beside: ".agent-draft-actions",
    hold: ({ namespace, agent }) => [`**/namespaces/${namespace.id}/agents/${agent.id}/deploy`],
    start: (page) => page.getByRole("button", { name: "Deploy new version" }).click(),
  },
  {
    kind: "an authentication save",
    tab: "credentials",
    reason: "This page stays open until the authentication save finishes.",
    beside: "form.agent-card",
    hold: ({ namespace, agent }) => [
      `**/namespaces/${namespace.id}/agents/${agent.id}`,
      { method: "PATCH" },
    ],
    start: (page) => page.getByRole("button", { name: "Save authentication source" }).click(),
  },
  {
    kind: "a channel Secrets save",
    tab: "credentials",
    reason: "This page stays open until the channel Secret bindings save finishes.",
    beside: ".channel-secrets",
    hold: ({ namespace, agent }) => [
      `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      { method: "PATCH" },
    ],
    start: async (page, { replacement }) => {
      await selectSecret(page, "Slack app token", replacement);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    },
  },
  {
    kind: "a plugin save",
    tab: "plugins",
    reason: "Wait for plugin selections to finish saving before leaving this tab.",
    beside: "section.agent-card",
    hold: ({ namespace, agent }) => [
      `**/namespaces/${namespace.id}/agents/${agent.id}`,
      { method: "PATCH" },
    ],
    start: async (page) => {
      await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
      await page
        .getByLabel("Plugin selections JSON")
        .fill(JSON.stringify({ "codex-plugin:linear@openai-curated-remote": { enabled: true } }));
      await page.getByRole("button", { name: "Save plugin selections" }).click();
    },
  },
]) {
  test(`${pending.kind} holds the sidebar, Back and ← Agents and says why`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    if (pending.tab === "plugins") {
      const driver = new CodexPluginDriver();
      fixture.controller.registerDriver(driver);
      fixture.controller.selectDriver("plugin", driver.id);
    }
    const namespace = await fixture.createNamespace("Pending reason", { ready: true });
    const { agent } = await createSlackAgent(fixture, namespace, "Pending reason Agent");
    const replacement = await fixture.createSecret(namespace.id, "Replacement app", "xapp-new");
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Pending reason Agent" }).click();
    if (pending.tab !== "configuration") {
      const tabLabel = pending.tab === "plugins" ? "Plugins" : "Credentials";
      await page.getByRole("tab", { name: tabLabel, exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get("tab") === pending.tab);
    }
    await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
    const held = await holdRequests(t, page, ...pending.hold({ namespace, agent }));
    await pending.start(page, { replacement });
    await held.requested;
    const pageUrl = page.url();
    const reason = page.getByText(pending.reason, { exact: true });
    // Each refusal shows the note again; it is removed first so a silent one would fail.
    const refusedWithReason = async (leave) => {
      await reason.evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
      await leave();
      await reason.waitFor();
      await page.waitForURL(pageUrl);
    };
    try {
      assert.equal(await asksBeforeUnload(page), true);
      await refusedWithReason(() => sidebarLink(page, "Agents").click());
      // Back to the Agents list, past the tab change where one was made.
      await refusedWithReason(() =>
        page.evaluate(
          (steps) =>
            new Promise((resolve) => {
              globalThis.addEventListener("popstate", resolve, { once: true });
              globalThis.history.go(steps);
            }),
          pending.tab === "configuration" ? -1 : -2,
        ),
      );
      await refusedWithReason(() => page.getByRole("link", { name: "← Agents" }).click());
      // One note, in a live region, beside the control whose request holds the page.
      assert.equal(await reason.count(), 1);
      assert.equal(await reason.getAttribute("role"), "status");
      assert.equal(await reason.isVisible(), true);
      assert.equal(
        await reason.evaluate(
          (node, beside) =>
            Boolean(
              node.parentElement.closest(beside) || node.previousElementSibling?.matches(beside),
            ),
          pending.beside,
        ),
        true,
        `the note sits beside ${pending.beside}`,
      );
      // A double click writes the note's text once, so a screen reader reads it once, and the
      // first refusal's delayed write does not repeat it (finding 1976).
      await reason.evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
      await page.evaluate((text) => {
        globalThis.leaveNoteWrites = 0;
        globalThis.leaveNoteObserver = new globalThis.MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.textContent === text) {
                globalThis.leaveNoteWrites += 1;
              }
            }
          }
        });
        globalThis.leaveNoteObserver.observe(globalThis.document.body, {
          childList: true,
          subtree: true,
        });
      }, pending.reason);
      await sidebarLink(page, "Agents").dblclick();
      await reason.waitFor();
      // Outlasts the note's 100 ms delayed write: a timer set later with a longer delay runs after it.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
      assert.equal(
        await page.evaluate(() => {
          globalThis.leaveNoteObserver.disconnect();
          return globalThis.leaveNoteWrites;
        }),
        1,
      );
      assert.equal(page.url(), pageUrl);
    } finally {
      held.release();
    }
    // The note goes with the hold.
    await reason.waitFor({ state: "detached" });
    // The save's reread may still be settling the form; then a reload asks no more.
    await waitForCondition(
      async () => !(await asksBeforeUnload(page)),
      "a reload still asks after the write",
    );
  });
}

// A plugin save keeps its editor locked until the tab rebuilds. After Delete there is no tab to
// rebuild, so the settled save held ← Agents, the sidebar and a reload for good (finding 2125).
test("a plugin save that settles after Delete lets the page go", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Plugin save delete", { ready: true });
  const { agent } = await createSlackAgent(fixture, namespace, "Plugin Delete Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
  // The controller applies the save; its answer waits until after Delete.
  const held = await holdRequests(t, page, `**/namespaces/${namespace.id}/agents/${agent.id}`, {
    method: "PATCH",
    once: true,
    afterServer: true,
  });
  await page.locator("summary", { hasText: "Plugin selections JSON" }).first().click();
  await page
    .getByLabel("Plugin selections JSON")
    .fill(JSON.stringify({ "codex-plugin:linear@openai-curated-remote": { enabled: true } }));
  await page.getByRole("button", { name: "Save plugin selections" }).click();
  await held.requested;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  await page
    .getByRole("dialog", { name: "Delete Plugin Delete Agent?" })
    .getByRole("button", { name: "Permanently delete Agent" })
    .click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  const reason = page.getByText(
    "Wait for plugin selections to finish saving before leaving this tab.",
    { exact: true },
  );
  await page.getByRole("link", { name: "← Agents" }).click();
  await reason.waitFor();
  assert.equal(await asksBeforeUnload(page), true);

  held.release();
  await reason.waitFor({ state: "detached" });
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("link", { name: "← Agents" }).click();
  await heading(page, "Agents").waitFor();
});

test("Back during a Configuration save preserves the previous Agent tab", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Save and Back", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Draft history", nativeValues("before"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByRole("tab", { name: "Channels" }).click();
  await page.getByRole("tab", { name: "Channels", selected: true }).waitFor();
  const channelsUrl = page.url();
  await page.getByRole("tab", { name: "Configuration" }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const configurationUrl = page.url();

  const editor = page.getByLabel("Configuration JSON", { exact: true });
  const values = nativeValues("after");
  await editor.fill(JSON.stringify(values, null, 2));
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const requests = apiRequests(page, fixture.origin);
  // The controller applies the edit once. Back arrives while this editor still awaits its answer.
  const held = await holdRequests(t, page, `**${path}`, { method: "PATCH", afterServer: true });
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await held.requested;
  try {
    await page.goBack();
    await page
      .getByText("Wait for Configuration save to finish before leaving the editor.", {
        exact: true,
      })
      .waitFor();
    await page.waitForURL(configurationUrl);
    assert.equal(await editor.evaluate((node) => node.readOnly), true);
  } finally {
    held.release();
  }
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  const saved = await fixture.request("GET", path);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.values, values);
  await page.goBack();
  assert.equal(page.url(), channelsUrl, "one Back after the save should reach Channels");
  await page.getByRole("tab", { name: "Channels", selected: true }).waitFor();
  await page.goForward();
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  assert.equal(page.url(), configurationUrl);
  await settlePageRequests(page);
  assert.equal(pathRequests(requests, "PATCH", path).length, 1);
});

test("Back refused by unsaved repository changes preserves the previous Agent tab", async (t) => {
  const repository = "example/application";
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1965",
      repository,
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository history",
    nativeValues("draft"),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("tab", { name: "Channels" }).click();
  await page.getByRole("tab", { name: "Channels", selected: true }).waitFor();
  const channelsUrl = page.url();
  await page.getByRole("tab", { name: "Repositories" }).click();
  const choice = repositoryCheckbox(page, repository);
  await choice.check();
  await page.locator("#repository-default-git-read").check();
  const repositoriesUrl = page.url();

  await page.goBack();
  await page.getByText(REPOSITORY_EDITS_PENDING).waitFor();
  await page.waitForURL(repositoriesUrl);
  assert.equal(await choice.isChecked(), true, "Back kept the unsaved selection");

  // Cancel rereads the saved access in place. Wait for its unselected repository before Back.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await choice.and(page.locator("input:not(:checked):enabled")).waitFor();
  assert.equal(await choice.isChecked(), false);
  await page.goBack();
  assert.equal(page.url(), channelsUrl, "one Back after Cancel should reach Channels");
  await page.getByRole("tab", { name: "Channels", selected: true }).waitFor();
  await page.goForward();
  await page.getByRole("tab", { name: "Repositories", selected: true }).waitFor();
  assert.equal(page.url(), repositoriesUrl);
  await settlePageRequests(page);
  assert.deepEqual(writeRequests(requests), [], "no repository write");
});

test("an uncertain Configuration save holds ← Agents, but the sidebar may leave the kept draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain leave", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Uncertain leave Agent", nativeValues("u"));
  const { page } = await newPage(t, fixture);
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.fallback();
        return;
      }
      // The write lands, but its answer does not say so.
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked" } }),
      });
    },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editor = page.getByLabel("Configuration JSON", { exact: true });
  await editor.fill(JSON.stringify(nativeValues("uncertain"), null, 2));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText("Outcome unknown. Configuration may have been saved.").waitFor();
  const pageUrl = page.url();
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByText("Outcome unknown. Reload this draft before leaving the editor.").waitFor();
  assert.equal(page.url(), pageUrl);
  // No write is in flight: the sidebar leaves, and the uncertain draft is kept for the return.
  await sidebarLink(page, "Namespaces").click();
  await heading(page, "Namespaces").waitFor();
  assert.equal(await asksBeforeUnload(page), true);
  await page.goBack();
  await waitForInputValue(editor, JSON.stringify(nativeValues("uncertain"), null, 2));
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
});

test("untouched forms, unchanged drawers and search text do not ask before a reload", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Nothing to lose", { ready: true });
  await createSlackAgent(fixture, namespace, "Nothing to lose Agent");
  const { page } = await newPage(t, fixture);
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Nothing to lose Agent" }).waitFor();

  // Agent search text is no unsaved work.
  await page.getByRole("searchbox", { name: "Search Agents" }).fill("Nothing");
  assert.equal(await asksBeforeUnload(page), false);

  // An untouched Create form has nothing to lose; the manual model switch is a change.
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await startDefaultPreset(page);
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  assert.equal(await asksBeforeUnload(page), true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(dialogs.splice(0), ["confirm: Discard this draft?"]);
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  assert.equal(await asksBeforeUnload(page), false);

  // An open, unchanged Slack drawer has nothing to lose.
  await page.getByRole("link", { name: "Nothing to lose Agent" }).click();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  await page.getByRole("button", { name: "Save configuration" }).waitFor();
  assert.equal(await asksBeforeUnload(page), false);
});

test("a changed Preset variable still asks before a reload after a return", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Touched Preset", { ready: true });
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: standardCodexPreset,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  const variable = page.getByLabel("Name", { exact: true });
  await variable.fill("Touched draft");
  assert.equal(await asksBeforeUnload(page), true);
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  // A changed Preset list rebuilds the step from its draft instead of reusing the shown page.
  const added = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: { ...standardCodexPreset, name: "added-preset" },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await waitForInputValue(variable, "Touched draft");
  assert.equal(await asksBeforeUnload(page), true);
});

test("Secret choices carried through Reload draft do not ask before a reload", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Carried choices", { ready: true });
  const { agent } = await createSlackAgent(fixture, namespace, "Carried choices Agent");
  const secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-2");
  const otherApp = await fixture.createSecret(namespace.id, "Other app token", "xapp-other");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Carried choices Agent" }).waitFor();
  await selectSecret(page, "Slack bot token", secondBot);
  // Another browser rebinds the app token first.
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const current = (await fixture.request("GET", configurationPath)).data;
  const changed = await fixture.request("PATCH", configurationPath, {
    body: {
      values: current.values,
      secretBindings: { ...current.secretBindings, SLACK_APP_TOKEN: envBinding(otherApp) },
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page.getByText(CHANNEL_SECRETS_CONFIGURATION_CHANGED).waitFor();

  const reread = await holdRequests(t, page, `**/namespaces/${namespace.id}/agents/${agent.id}`, {
    once: true,
    method: "GET",
  });
  await page.getByRole("button", { name: "Reload draft" }).click();
  await reread.requested;
  // The carried choices name saved Secrets: a reload would lose nothing (finding 1938).
  assert.equal(await asksBeforeUnload(page), false);
  reread.release();
  await page
    .getByRole("status")
    .filter({
      hasText:
        "Your Secret choices are applied over the reloaded bindings: Slack bot token. Review them, then save.",
    })
    .waitFor();
});

// A refusal keeps the Create form as a draft only when a retry cannot repeat a write: an
// uncertain outcome, an admitted provisioning job, a pending credential registration, a job that
// created its Agent and a repository policy refusal keep none (finding 1965).
const apiError = (status, code, message) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    error: { code, message },
    meta: { requestId: "req_00000000-0000-4000-8000-000000001965" },
  }),
});

// The sidebar leaves the refused form and Create Agent returns to the chooser: no kept draft
// reopens it or asks before a reload.
async function expectNoKeptDraft(page) {
  await sidebarLink(page, "Agents").click();
  await heading(page, "Agents").waitFor();
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  assert.equal(await asksBeforeUnload(page), false);
}

// A dedicated Codex Agent with a new model Secret, which the Installation provisions.
async function fillProvisionedAgent(page, fixture, namespace, name) {
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill(name);
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "synthetic-guard-model-key");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
}

// Admits one provisioning job and answers its status reads with `read`.
async function routeProvisioningJob(page, namespace, read) {
  const url = `/namespaces/${namespace.id}/agents/provision/work_1`;
  let requestId;
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
    requestId = route.request().postDataJSON().requestId;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          provisioning: {
            requestId,
            workId: "work_1",
            status: "queued",
            phase: "accepted",
            attemptCount: 0,
            updatedAt: new Date().toISOString(),
            url,
          },
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000202" },
      }),
    });
  });
  await page.route(`**${url}`, (route) => route.fulfill(read(url, requestId)));
}

test("an uncertain Create outcome keeps no draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain create", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    // The Agent is created, but the answer does not say so: a retry could create another.
    await route.fetch();
    await route.fulfill(apiError(503, "DEPENDENCY_UNAVAILABLE", "masked"));
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await startDefaultPreset(page);
  await enterManualModel(page, "synthetic-guard-model-key", "gpt-5.1");
  await page.getByLabel("Agent name", { exact: true }).fill("Uncertain Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByText(/^Outcome unknown\. The result could not be confirmed\./).waitFor();
  await expectNoKeptDraft(page);
});

test("a refused read of an admitted provisioning job keeps no draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Admitted create", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationProvisioning(page, fixture);
  // The job is admitted, then its status read is refused: the request ID stays the job's.
  await routeProvisioningJob(page, namespace, () => apiError(404, "NOT_FOUND", RESOURCE_NOT_FOUND));
  await fillProvisionedAgent(page, fixture, namespace, "Admitted Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByText(/^Resource unavailable in this Namespace\./).waitFor();
  await expectNoKeptDraft(page);
});

test("a failed provisioning job that names its Agent keeps no draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Failed job create", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationProvisioning(page, fixture);
  // The job created its Agent and first version, then the deployment failed: no Retry, and a
  // kept draft would create the Agent again.
  await routeProvisioningJob(page, namespace, (url, requestId) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        requestId,
        workId: "work_1",
        status: "failed",
        phase: "handoff",
        attemptCount: 1,
        updatedAt: new Date().toISOString(),
        agentId: "agt_00000000-0000-4000-8000-000000001965",
        revisionId: "rev_00000000-0000-4000-8000-000000001965",
        url,
        error: {
          code: "PROVISIONING_DEPLOYMENT_FAILED",
          message: "The initial deployment failed.",
        },
      },
      meta: { requestId: "req_00000000-0000-4000-8000-000000000200" },
    }),
  }));
  await fillProvisionedAgent(page, fixture, namespace, "Failed job Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByText(/^The initial deployment failed\. Open this Agent/).waitFor();
  await expectNoKeptDraft(page);
});

test("a refused credential registration keeps no draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Registration create", { ready: true });
  const { page } = await newPage(t, fixture);
  // The Installation provisions dedicated Agents through a Credential Gateway model source.
  await routeInstallationWithoutProvisioning(page, fixture, {
    agentProvisioning: { executionModes: ["dedicated"] },
    credentialSources: {
      types: [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ],
    },
  });
  await page.route(`**/namespaces/${namespace.id}/credential-sources`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill(apiError(429, "RATE_LIMITED", "Slow down."));
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Registration Agent");
  await enterManualModel(page, "synthetic-guard-model-key", "gpt-5");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  // The registration keeps its frozen name for Check credential registration.
  await page.getByRole("button", { name: "Check credential registration" }).waitFor();
  await expectNoKeptDraft(page);
});

test("a repository-scoped Agent refusal keeps no draft", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1965",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  // Agent create is denied once the preflight passes, so the Configuration is saved first.
  let deny = true;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/validate`,
    async (route) => {
      const response = await route.fetch();
      if (deny) {
        deny = false;
        fixture.policy.restrictions.push({
          id: "guard-agent-create",
          namespaceId: namespace.id,
          resourceKind: "agent",
          action: "create",
          effect: "deny",
        });
      }
      await route.fulfill({ response });
    },
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await startDefaultPreset(page);
  await enterManualModel(page, "synthetic-guard-model-key", "gpt-5.1");
  await page.getByLabel("Agent name", { exact: true }).fill("Repository Agent");
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  // The retry is locked until a repository reload, which a restored draft would skip.
  await heading(page, "Recover from a rejected Agent save").waitFor();
  fixture.policy.restrictions.pop();
  await expectNoKeptDraft(page);
});
