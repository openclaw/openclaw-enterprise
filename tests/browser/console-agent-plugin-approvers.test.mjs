import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  pathRequests,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

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
      executionMode: "embedded",
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
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies = [];
  let directoryAvailable = true;
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      directoryBodies.push(body);
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
  await picker.getByRole("option", { name: /Alex.*UTEST123/ }).waitFor();
  const searched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/channel-directory/lookup`) &&
      response.request().postDataJSON()?.query === "Alex",
  );
  await people.fill("Alex");
  await searched;
  const result = picker.getByRole("option", { name: /Alex.*UTEST123/ });
  await result.waitFor();
  const resultNode = await result.elementHandle();
  const lookupCount = directoryBodies.length;
  let releaseSession;
  const sessionGate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  t.after(() => releaseSession());
  let sessionReached;
  const sessionHeld = new Promise((resolve) => {
    sessionReached = resolve;
  });
  const sessionPath = `${fixture.origin}/api/auth/session`;
  await page.route(sessionPath, async (route) => {
    const response = await route.fetch();
    sessionReached();
    await sessionGate;
    await route.fulfill({ response });
  });

  // Refocus checks access without discarding an open search or repeating its lookup.
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  await sessionHeld;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
      ),
  );
  releaseSession();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(await people.inputValue(), "Alex");
  assert.equal(await people.getAttribute("aria-expanded"), "true");
  assert.equal(await resultNode.evaluate((node) => node.isConnected), true);
  assert.equal(directoryBodies.length, lookupCount);
  await page.unroute(sessionPath);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).focus();
  assert.equal(await people.getAttribute("aria-expanded"), "false");
  const peopleNode = await people.elementHandle();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await people.waitFor({ state: "detached" });
  assert.equal(await peopleNode.evaluate((node) => node.isConnected), false);
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
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
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await people.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await people.waitFor();
  assert.equal(await selectedPeopleNode.evaluate((node) => node.isConnected), true);
  assert.equal(
    await picker.locator('.slack-directory-chip[data-value="team:TTEST123:user:UTEST123"]').count(),
    1,
  );
  await picker
    .getByRole("button", { name: "Remove team:TTEST123:user:UTEST123", exact: true })
    .click();
  await people.fill("team:TOTHER123:user:UTEST123");
  await people.press("Enter");
  await picker
    .getByText("This bot belongs to workspace TTEST123. Enter a user in that workspace.")
    .waitFor();
  directoryAvailable = false;
  await people.fill("UTEST999");
  await picker.getByText("Slack directory lookup is unavailable.").waitFor();
  await people.press("Enter");
  await picker
    .locator('.slack-directory-chip[data-value="UTEST999"]')
    .getByText("UTEST999")
    .waitFor();
  await picker.getByRole("button", { name: "Remove UTEST999", exact: true }).click();
  directoryAvailable = true;
  await people.fill("Alex");
  await picker.getByRole("option", { name: /Alex.*UTEST123/ }).click();
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
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
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
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isDisabled(), false);

  await page.getByLabel("Default plugin approvers mode").selectOption("none");
  assert.equal(await deploy.isDisabled(), true);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  assert.equal(await page.getByLabel("Default plugin approvers mode").inputValue(), "none");
  await page
    .getByText("Save or discard plugin changes before deploying.", { exact: true })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);
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
  const { page } = await newPage(t, fixture);
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
