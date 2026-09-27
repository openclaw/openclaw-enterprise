import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  accessBindingPostRequests,
  detailUrl,
  expectNoText,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  revealNativeConfiguration,
  routeRuntimeCredentials,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  waitForCondition,
} from "./console-agents-browser-helpers.mjs";

function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        // Some request bodies are not JSON.
      }
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}`, body });
    }
  });
  return requests;
}

test("Channel drawer saves channel edits without exposing Secret values or dropping unrelated draft state", async (t) => {
  const secretValue = "super-secret-channel-value";
  const slackAppSecretValue = "super-secret-slack-app-value";
  const slackBotSecretValue = "super-secret-slack-bot-value";
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel state", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Slack bot token",
    slackBotSecretValue,
  );
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
    SLACK_APP_TOKEN: {
      source: slackAppSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: slackBotSecret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Channel Agent",
    nativeValues("channels", {
      harnessId: "codex",
      providerModel: "gpt-5.1",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          replyToMode: "off",
          replyToModeByChatType: { direct: "first", channel: "off" },
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          allowFrom: ["UOLD123"],
          channels: {
            COLD123: {
              requireMention: true,
              users: ["UOLD123"],
            },
          },
        },
        msteams: {
          enabled: false,
          appId: "00000000-0000-4000-8000-000000000000",
          tenantId: "11111111-1111-4111-8111-111111111111",
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
          requireMention: true,
        },
      },
    }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page, artifacts } = await newPage(t, fixture);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "channels").search,
  );
  await page.getByRole("heading", { name: "Channel Agent" }).waitFor();
  await page.getByRole("button", { name: "Channels" }).click();
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }

  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const appSecretPath = `/namespaces/${namespace.id}/secrets/${slackAppSecret.id}`;
  const botSecretPath = `/namespaces/${namespace.id}/secrets/${slackBotSecret.id}`;
  const appSecretLink = dialog.getByRole("link", {
    name: "View app token Secret metadata (opens in new tab)",
  });
  const botSecretLink = dialog.getByRole("link", {
    name: "View bot token Secret metadata (opens in new tab)",
  });
  assert.equal(await appSecretLink.getAttribute("href"), appSecretPath);
  assert.equal(await appSecretLink.getAttribute("target"), "_blank");
  assert.equal(await appSecretLink.getAttribute("rel"), "noopener");
  assert.equal(await botSecretLink.getAttribute("href"), botSecretPath);
  await dialog.getByText("Secret menu changes are saved with these channel settings.").waitFor();

  const channelIds = page.getByLabel("Slack channel IDs");
  const allowedUsers = page.getByLabel("Allowed channel user IDs");
  const allowEveryone = page.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowedUsers.inputValue(), "UOLD123");
  assert.equal(await allowedUsers.isDisabled(), false);
  assert.equal(await allowEveryone.isDisabled(), true);
  await channelIds.fill("COLD123, CNEW123");
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  await allowedUsers.fill("");
  assert.equal(await allowEveryone.isEnabled(), true);
  await allowEveryone.check();
  assert.equal(await allowedUsers.isDisabled(), true);
  await allowEveryone.uncheck();
  assert.equal(await allowedUsers.isEnabled(), true);
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  assert.equal(
    await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
    0,
  );
  await dialog
    .getByText("Choose existing Slack token Secrets or create them here.")
    .scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: join(artifacts, "agent-channel-drawer-links.png"),
  });

  const appSecretPopupPromise = page.waitForEvent("popup");
  await appSecretLink.click();
  const appSecretPopup = await appSecretPopupPromise;
  await appSecretPopup.waitForLoadState("domcontentloaded");
  assert.equal(new URL(appSecretPopup.url()).pathname, appSecretPath);
  await appSecretPopup.getByText("Slack app token").waitFor();
  const secretMetadataText = await appSecretPopup.locator("body").textContent();
  assert.match(secretMetadataText, new RegExp(slackAppSecret.id));
  assert.doesNotMatch(secretMetadataText, new RegExp(slackAppSecretValue));
  await appSecretPopup.close();

  assert.equal(await channelIds.inputValue(), "COLD123, CNEW123");
  assert.equal(await allowedUsers.inputValue(), "UNEW123");

  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }
  assert.equal(await page.getByRole("button", { name: /Microsoft Teams/ }).count(), 0);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(configuration.data.values.channels.slack.appToken, {
    source: "env",
    provider: "default",
    id: "SLACK_APP_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.botToken, {
    source: "env",
    provider: "default",
    id: "SLACK_BOT_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    COLD123: { requireMention: true, users: ["UNEW123"] },
    CNEW123: { requireMention: true, users: ["UNEW123"] },
  });
  assert.equal(configuration.data.values.channels.slack.replyToMode, "off");
  assert.deepEqual(configuration.data.values.channels.slack.replyToModeByChatType, {
    direct: "first",
    channel: "off",
  });
  assert.equal(configuration.data.values.channels.slack.dmPolicy, "allowlist");
  assert.deepEqual(configuration.data.values.channels.slack.allowFrom, ["UOLD123"]);
  assert.equal(
    configuration.data.values.channels.msteams.appId,
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(
    configuration.data.values.channels.msteams.tenantId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(configuration.data.values.channels.msteams.appPassword, {
    source: "env",
    provider: "default",
    id: "MSTEAMS_APP_PASSWORD",
  });
  assert.equal(configuration.data.values.plugins.entries.knowledge.config.marker, "channels");
  assert.deepEqual(
    configuration.data.values.plugins.entries.knowledge.config.thresholds,
    [1, 2, 3],
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-5.1");

  await page.screenshot({ path: join(artifacts, "agent-channels.png"), fullPage: true });
});

for (const [name, channels, reason] of [
  [
    "wildcard channel map",
    { "*": { requireMention: true, users: ["*"] } },
    "Slack wildcard channels must be edited in native Configuration JSON.",
  ],
  [
    "mixed channel sender lists",
    {
      CMIXED123: { requireMention: true, users: ["UONE123"] },
      CMIXED456: { requireMention: true, users: ["UTWO456"] },
    },
    "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
  ],
  [
    "comma channel sender ID",
    { CCOMMA123: { requireMention: true, users: ["UONE123,UTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
  [
    "newline channel sender ID",
    { CNEWLINE123: { requireMention: true, users: ["UONE123\nUTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
]) {
  test(`Channel drawer keeps Slack ${name} in native JSON`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unsupported Slack native", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      channels,
    };
    const agent = await fixture.createAgent(
      namespace.id,
      `Unsupported Slack ${name}`,
      nativeValues(`unsupported-slack-${name}`, { harnessId: "codex", channels: { slack } }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: `Unsupported Slack ${name}` }).waitFor();
    await page.getByText(reason).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);
    await revealNativeConfiguration(page, "Slack native configuration");
    const nativeJson = JSON.parse(await page.locator(".channel-native pre").textContent());
    assert.deepEqual(nativeJson, slack);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

test("Channel drawer binds existing Slack Secrets without dropping unsaved channel edits", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unbound Slack credentials", { ready: true });
  const slackAppSecretValue = "never-visible-menu-app-token";
  const slackBotSecretValue = "never-visible-menu-bot-token";
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack bot token",
    slackBotSecretValue,
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CUNBOUND123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Unbound Slack Agent",
    nativeValues("unbound-slack", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Unbound Slack Agent" }).waitFor();
  // Establish a same-document history entry before opening the modal.
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
  const channelIds = dialog.getByLabel("Slack channel IDs");
  await channelIds.fill("CUNBOUND123, CBOUND456");
  await selectSecret(dialog, "Slack app token", slackAppSecret);
  await dialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  await selectSecret(dialog, "Slack bot token", slackBotSecret);
  await dialog.getByText("Secret binding staged. Save changes to apply it.").nth(1).waitFor();
  assert.equal(await channelIds.inputValue(), "CUNBOUND123, CBOUND456");
  assert.equal(
    await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
    0,
  );
  await dialog.getByText("Choose existing Slack token Secrets or create them here.").waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  await page.goForward();
  await dialog.waitFor();
  assert.equal(await channelIds.inputValue(), "CUNBOUND123, CBOUND456");
  assert.equal(
    await dialog.getByLabel("Slack app token").inputValue(),
    secretOptionLabel(slackAppSecret),
  );
  assert.equal(
    await dialog.getByLabel("Slack bot token").inputValue(),
    secretOptionLabel(slackBotSecret),
  );
  const beforeSave = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(beforeSave.data.generation, 1);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    CUNBOUND123: { requireMention: true, users: ["*"] },
    CBOUND456: { requireMention: true, users: ["*"] },
  });
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes(slackAppSecretValue), false);
  assert.equal(pageText.includes(slackBotSecretValue), false);
});

test("Channel drawer grants only the final selected Slack Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Final Slack grant", { ready: true });
  const firstSecret = await fixture.createSecret(namespace.id, "First Slack app token", "hidden-a");
  const finalSecret = await fixture.createSecret(namespace.id, "Final Slack app token", "hidden-b");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CFINAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Final Slack Grant Agent",
    nativeValues("final-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Final Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await selectSecret(dialog, "Slack app token", firstSecret);
  await selectSecret(dialog, "Slack app token", finalSecret);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: finalSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [finalSecret.id],
  );
});

test("Channel drawer does not grant when Slack Secret selection returns to original", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Original Slack grant", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original Slack app token",
    "hidden-original",
  );
  const temporarySecret = await fixture.createSecret(
    namespace.id,
    "Temporary Slack app token",
    "hidden-temporary",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: { source: originalSecret.ref, delivery: { type: "env" } },
  };
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CORIG123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Original Slack Grant Agent",
    nativeValues("original-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Original Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await selectSecret(dialog, "Slack app token", temporarySecret);
  await selectSecret(dialog, "Slack app token", originalSecret);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer does not grant Slack Secret access when Configuration save is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rejected Slack save", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Rejected save Slack app token",
    "hidden-rejected-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CREJECT123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Rejected Slack Save Agent",
    nativeValues("rejected-slack-save", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000403" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Rejected Slack Save Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
  await selectSecret(dialog, "Slack app token", slackAppSecret);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByText(/Access denied|permission/i).waitFor();
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowEveryone.isEnabled(), true);
  assert.equal(await allowedUsers.isDisabled(), true);

  const configuration = await fixture.request("GET", configurationPath);
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings ?? {}, {});
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack everyone access", { ready: true });
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["UDM123"],
    channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Everyone Agent",
    nativeValues("slack-everyone", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Slack Everyone Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  let dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack channel IDs").fill("CEVERY123, CSECOND123");
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
  await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${agent.configurationId}`),
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saved).status(), 200);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.values.channels.slack, {
    ...slack,
    channels: {
      CEVERY123: { requireMention: false, users: ["*"], allowBots: "mentions" },
      CSECOND123: { requireMention: false, users: ["*"] },
    },
  });

  await page.getByRole("button", { name: "Edit Slack" }).click();
  dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(
    await dialog.getByLabel("Allow everyone in these channels to mention the agent").isChecked(),
    true,
  );
  assert.equal(await dialog.getByLabel("Allowed channel user IDs").isDisabled(), true);
  assert.equal(await dialog.getByLabel("Require a mention", { exact: true }).isChecked(), false);
});

test("Channel drawer reports partial save when post-PATCH Secret grant is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial Slack grant", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Partial save Slack app token",
    "hidden-partial-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CPARTIAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Partial Slack Grant Agent",
    nativeValues("partial-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Partial Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await selectSecret(dialog, "Slack app token", slackAppSecret);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page
    .getByText(
      "Configuration saved, but Secret access grants could not be confirmed. Open Agent Credentials to inspect saved bindings, then ask a Namespace administrator to grant this Agent access to the saved Secret.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.equal(configuration.data.generation, 2);
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: slackAppSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id],
  );

  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const appToken = page.getByLabel("Slack app token");
  await appToken.waitFor();
  assert.equal(await appToken.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await appToken.evaluate((node) => node.value), secretOptionLabel(slackAppSecret));
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
});

test("Agent credentials choose existing Slack Secrets without reading token values", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack picker", { ready: true });
  const slackAppSecretValue = "never-visible-runtime-app-token";
  const slackBotSecretValue = "never-visible-runtime-bot-token";
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Runtime Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Runtime Slack bot token",
    slackBotSecretValue,
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CRUNTIME123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Picker Agent",
    nativeValues("runtime-slack-picker", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Picker Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "Slack app token", slackAppSecret);
  await selectSecret(page, "Slack bot token", slackBotSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
  assert.deepEqual(secretPostRequests(requests, namespace.id), []);
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes(slackAppSecretValue), false);
  assert.equal(pageText.includes(slackBotSecretValue), false);
});

test("Agent credentials finish Slack Secret grants after navigating away from save", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack navigation grant", {
    ready: true,
  });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack app token",
    "hidden-navigation-app",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack bot token",
    "hidden-navigation-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CNAVIGATE123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Navigation Agent",
    nativeValues("runtime-slack-navigation", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  let markPatchPersisted;
  const patchPersisted = new Promise((resolve) => {
    markPatchPersisted = resolve;
  });
  let releasePatch;
  const patchRelease = new Promise((resolve) => {
    releasePatch = resolve;
  });
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      markPatchPersisted();
      await patchRelease;
      await route.fulfill({ response });
    },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Navigation Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "Slack app token", slackAppSecret);
  await selectSecret(page, "Slack bot token", slackBotSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await patchPersisted;
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
  releasePatch();
  await waitForCondition(
    () => accessBindingPostRequests(requests, namespace.id).length === 2,
    "expected saved Slack Secret grants to finish after navigation",
  );

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
});

test("Agent credentials retry outstanding Slack Secret grants after changing one token", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack retained grant", { ready: true });
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Retained grant model credential",
    "hidden-retained-model",
  );
  const firstAppSecret = await fixture.createSecret(
    namespace.id,
    "First retained Slack app token",
    "hidden-retained-first-app",
  );
  const secondAppSecret = await fixture.createSecret(
    namespace.id,
    "Second retained Slack app token",
    "hidden-retained-second-app",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Retained Slack bot token",
    "hidden-retained-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CRETRYGRANT123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Retained Grant Agent",
    nativeValues("runtime-slack-retained-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", harnessAuth: { method: "api_key", source: modelSecret.ref } },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  let denyGrant = true;
  let rejectNextConfigurationPatch = false;
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() === "PATCH" && rejectNextConfigurationPatch) {
        rejectNextConfigurationPatch = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "CONFLICT", message: "simulated stale configuration" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000834" },
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST" || !denyGrant) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000833" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Retained Grant Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "Slack app token", firstAppSecret);
  await selectSecret(page, "Slack bot token", botSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  const firstConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(firstConfiguration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: firstAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
  });

  denyGrant = false;
  rejectNextConfigurationPatch = true;
  await selectSecret(page, "Slack app token", secondAppSecret);
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  requests.length = 0;
  await selectSecret(page, "Slack app token", secondAppSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();

  const finalConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(finalConfiguration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: secondAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id)
      .map((request) => request.body.resourceId)
      .sort(),
    [botSecret.id, secondAppSecret.id].sort(),
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

// A persisted binding must remain blocked for both permission denials and retryable IAM failures.
for (const grantStatus of [403, 429]) {
  test(`Agent credentials report partial Slack Secret grant failure (${grantStatus})`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Runtime Slack grant failure", { ready: true });
    const originalBotSecret = await fixture.createSecret(
      namespace.id,
      "Existing runtime Slack bot token",
      "hidden-existing-runtime-bot",
    );
    const replacementAppSecret = await fixture.createSecret(
      namespace.id,
      "Denied runtime Slack app token",
      "hidden-denied-runtime-app",
    );
    const secretBindings = {
      SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
    };
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      channels: { CRUNTIMEFAIL123: { requireMention: true } },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Runtime Slack Grant Failure Agent",
      nativeValues("runtime-slack-grant-failure", { harnessId: "codex", channels: { slack } }),
      { executionMode: "dedicated", secretBindings },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
      transportConfigured: true,
    });
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: grantStatus,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000733" },
          }),
        });
      },
    );
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: "Runtime Slack Grant Failure Agent" }).waitFor();
    requests.length = 0;
    await selectSecret(page, "Slack app token", replacementAppSecret);
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page
      .getByText(
        "Configuration saved, but Secret access grants could not be confirmed. Ask a Namespace administrator to grant this Agent access to the saved Secret.",
      )
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      false,
    );
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.secretBindings, {
      SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
    });
    assert.deepEqual(
      accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
      [replacementAppSecret.id],
    );
    if (grantStatus === 403) {
      await page.getByRole("button", { name: "Channels", exact: true }).click();
      await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      await dialog.getByLabel("Slack channel IDs").fill("CRUNTIMEFAIL123, CRETAINREFS123");
      await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const afterChannelEdit = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(afterChannelEdit.data.secretBindings, {
        SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
      });
      assert.deepEqual(Object.keys(afterChannelEdit.data.values.channels.slack.channels).sort(), [
        "CRETAINREFS123",
        "CRUNTIMEFAIL123",
      ]);
    }
  });
}
