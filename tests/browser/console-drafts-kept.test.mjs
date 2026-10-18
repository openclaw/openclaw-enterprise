import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
  pathRequests,
  selectSecret,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import {
  configurationPostRequests,
  routeInstallationWithoutProvisioning,
} from "./console-agents-test-support.mjs";

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

// Whether a reload or tab close would ask first: the console cancels beforeunload.
const asksBeforeUnload = (page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    globalThis.dispatchEvent(event);
    return event.defaultPrevented;
  });
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
  await fixture.createAgent(namespace.id, "Existing Agent");
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
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "channels");
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
  const held = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH" },
  );
  await page.getByRole("button", { name: "Disable Slack" }).click();
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
    // So does Back to another page (the Agents list, before the Agent and its Channels tab):
    // the page stays and its URL is restored before the history event ends.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          globalThis.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true });
          globalThis.history.go(-2);
        }),
    );
    assert.equal(page.url(), pageUrl);
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
  // The refused Back kept the Agents list in history, so Back now reaches it.
  await page.goBack();
  await heading(page, "Agents").waitFor();
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
  await page.getByRole("button", { name: "Channels", exact: true }).click();
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
  await page
    .getByText("Configuration changed. Reload this draft before saving channel Secrets.")
    .waitFor();

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
