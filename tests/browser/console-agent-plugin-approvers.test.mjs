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
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

test("Agent plugin approver selectors save inheritance and workspace-qualified users", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
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
    nativeValues("slack-directory", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const pluginId = "codex-plugin:calendar@openai-curated-remote";
  const toolId = "app_calendar/create_event";
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: { [pluginId]: { enabled: true, tools: { [toolId]: { enabled: true } } } },
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies = [];
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      directoryBodies.push(body);
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
  await login(page, fixture, pluginsUrl.pathname + pluginsUrl.search);
  await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
  await page.getByRole("button", { name: "Find approver for Default plugin approvers" }).click();
  const userDialog = page.getByRole("dialog", {
    name: "Find approver for Default plugin approvers",
  });
  await userDialog.getByText("Test workspace · TTEST123").waitFor();
  await userDialog.getByRole("button", { name: "Close" }).click();
  await page
    .getByLabel("Default plugin approvers exact Slack selector")
    .fill("team:TOTHER123:user:UTEST123");
  await page.getByRole("button", { name: "Add exact selector" }).click();
  await page
    .getByText("This bot belongs to workspace TTEST123. Enter a user in that workspace.")
    .waitFor();
  await page
    .getByLabel("Default plugin approvers exact Slack selector")
    .fill("team:TTEST123:user:UTEST999");
  await page.getByRole("button", { name: "Add exact selector" }).click();
  await page.getByRole("button", { name: "Remove team:TTEST123:user:UTEST999" }).click();
  await page.getByRole("button", { name: "Find approver for Default plugin approvers" }).click();
  await userDialog.getByRole("button", { name: /Alex.*UTEST123/ }).click();
  assert.equal(await page.getByText("team:TTEST123:user:UTEST123", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const pluginDialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await pluginDialog.getByRole("button", { name: pluginId, exact: true }).click();
  await pluginDialog.getByLabel(`${pluginId} plugin approvers mode`).selectOption("none");
  const toolRow = pluginDialog.locator(`details.plugin-tool-row[data-tool="${toolId}"]`);
  await toolRow.locator("summary").click();
  await toolRow.getByLabel(`${toolId} tool approvers mode`).selectOption("chosen");
  await toolRow
    .getByLabel(`${toolId} tool approvers exact Slack selector`)
    .fill("team:TTEST123:user:UTEST123");
  await toolRow.getByRole("button", { name: "Add exact selector" }).click();
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
  assert.deepEqual(savedAgent.plugins[pluginId].tools[toolId].approvers, approvers);
  assert.deepEqual(directoryBodies[0], {
    secretId: botSecret.id,
    kind: "users",
    agentId: agent.id,
  });

  await page.goto(`${fixture.origin}${pluginsUrl.pathname}${pluginsUrl.search}`);
  await page
    .locator(".slack-approver-id")
    .filter({ hasText: "UTEST123" })
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

  await page.goto(`${fixture.origin}${pluginsUrl.pathname}${pluginsUrl.search}`);
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
  await login(page, fixture, url.pathname + url.search);
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
