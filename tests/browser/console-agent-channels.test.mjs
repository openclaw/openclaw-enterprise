import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  fileBrowser,
  holdRequests,
  login,
  MEMBER_WRITE,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  selectSecret,
  setSlackSelection,
  slackSelectionValue,
  statusTone,
  waitForEnabled,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";

// The Agent's grant of a saved Slack Secret was refused, or the IAM policy shows none (finding 1920).
const GRANT_REFUSED =
  "Configuration saved, but this Agent cannot use the saved Slack Secret until it is granted access. Granting it needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Retry Secret access.";
const GRANT_MISSING =
  "This Agent has no access to a bound Slack Secret, so deploying it would be refused. Select Retry Secret access to grant it.";
// A session known not to administer the Installation sent no grant (finding 2263).
const GRANT_UNVERIFIED =
  "Configuration saved, but this session did not verify that this Agent can use the saved Slack Secret. Granting access needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Retry Secret access.";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A bootstrapped Console with one ready Namespace.
async function readyNamespace(t, name) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  return { fixture, namespace: await fixture.createNamespace(name, { ready: true }) };
}

// A dedicated Codex Agent whose socket-mode Slack channel reads both tokens from env SecretRefs.
// `slack` adds Slack settings; other options go to createAgent over executionMode "dedicated".
// Returns the Agent and the exact Slack values it was created with.
async function createSlackAgent(fixture, namespace, { name, slug, slack: extra, ...options }) {
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    ...extra,
  };
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues(slug, { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", ...options },
  );
  return { agent, slack };
}

// Signs in at the Agent's draft `tab` and waits for its `heading`.
async function openDraft(page, fixture, agent, heading, tab = "channels") {
  await login(page, fixture, detailUrl(fixture, agent.namespaceId, agent.id, "draft", tab));
  await page.getByRole("heading", { name: heading }).waitFor();
}

// Answers `method` requests to `pattern` with an API error; other requests reach the API.
async function failMethod(page, pattern, method, { status, error, requestId }) {
  await page.route(pattern, async (route, request) => {
    if (request.method() !== method) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error, meta: { requestId } }),
    });
  });
}

// Every case builds its own Console and browser context, so cases run a few at a time.
describe("Agent channels", { concurrency: 3 }, () => {
  test("Channel drawer saves channel edits without exposing Secret values or dropping unrelated draft state", async (t) => {
    const secretValue = "super-secret-channel-value";
    const slackAppSecretValue = "super-secret-slack-app-value";
    const slackBotSecretValue = "super-secret-slack-bot-value";
    const { fixture, namespace } = await readyNamespace(t, "Channel state");
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
    const { page, artifacts } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, "Channel Agent");
    await page.getByRole("tab", { name: "Channels" }).click();
    for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
      await expectNoText(page, value);
    }

    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    // The drawer's standing notice is info, not a warning (finding 2006).
    assert.deepEqual(
      await statusTone(dialog.getByText(/^New version\. Changes affect future deployments/)),
      { className: "status", tone: "info", role: "status" },
    );
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

    const channelIds = page.getByRole("combobox", { name: "Channels", exact: true });
    const allowedUsers = page.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = page.getByLabel("Who can use the agent in these channels?");
    assert.equal(await slackSelectionValue(allowedUsers), "UOLD123");
    await waitForEnabled(allowedUsers);
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(channelIds, "COLD123, CNEW123");
    await setSlackSelection(allowedUsers, "UNEW123");
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(allowedUsers, "");
    assert.equal(await allowEveryone.isEnabled(), true);
    await allowEveryone.selectOption("everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await allowEveryone.selectOption("selected");
    assert.equal(await allowedUsers.isEnabled(), true);
    await setSlackSelection(allowedUsers, "UNEW123");
    assert.equal(await allowEveryone.inputValue(), "selected");
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

    assert.equal(await slackSelectionValue(channelIds), "COLD123, CNEW123");
    assert.equal(await slackSelectionValue(allowedUsers), "UNEW123");

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
      const { fixture, namespace } = await readyNamespace(t, "Unsupported Slack native");
      const { agent, slack } = await createSlackAgent(fixture, namespace, {
        name: `Unsupported Slack ${name}`,
        slug: `unsupported-slack-${name}`,
        slack: { channels },
      });
      const { page } = await newPage(t, fixture, { browser });
      const requests = apiRequests(page, fixture.origin);

      await openDraft(page, fixture, agent, `Unsupported Slack ${name}`);
      await page.getByText(reason).waitFor();
      assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);
      await revealNativeConfiguration(page, "Slack native configuration");
      const nativeJson = JSON.parse(await page.locator(".channel-native pre").textContent());
      assert.deepEqual(nativeJson, slack);
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    });
  }

  // Every deployment needs a model authentication source. An Agent with its API key bound was
  // still told to configure model credentials "before first deploy" (finding 2063).
  test("Channel drawer asks for model credentials only while the Agent has none", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "notice");
    const NOTICE = "New version. Changes affect future deployments using this Configuration.";
    const { agent: keyed } = await createSlackAgent(fixture, namespace, {
      name: "Keyed Agent",
      slug: "keyed",
    });
    assert.equal(keyed.harnessAuth?.method, "api_key");
    const { agent: unkeyed } = await createSlackAgent(fixture, namespace, {
      name: "Unkeyed Agent",
      slug: "unkeyed",
      harnessAuth: null,
    });
    const { page } = await newPage(t, fixture, { browser });
    await login(
      page,
      fixture,
      detailUrl(fixture, keyed.namespaceId, keyed.id, "draft", "channels"),
    );
    const notice = async (agent, heading) => {
      await page.goto(detailUrl(fixture, agent.namespaceId, agent.id, "draft", "channels").href);
      await page.getByRole("heading", { name: heading }).waitFor();
      await page.getByRole("button", { name: "Edit Slack" }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      const text = await dialog.locator(".status").first().textContent();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      return text;
    };
    assert.equal(await notice(keyed, "Keyed Agent"), NOTICE);
    assert.equal(
      await notice(unkeyed, "Unkeyed Agent"),
      `${NOTICE} Configure model credentials in the Credentials tab before deploying.`,
    );
  });

  test("Channel drawer binds existing Slack Secrets without dropping unsaved channel edits", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Unbound Slack credentials");
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
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Unbound Slack Agent",
      slug: "unbound-slack",
      slack: { channels: { CUNBOUND123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Unbound Slack Agent");
    // Establish a same-document history entry before opening the modal.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
    const channelIds = dialog.getByRole("combobox", { name: "Channels", exact: true });
    await setSlackSelection(channelIds, "CDISCARD123");
    await selectSecret(dialog, "Slack app token", slackAppSecret);

    // Panel clicks and drags ending outside keep edits; a backdrop click discards them.
    const bounds = await dialog.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(bounds.x + 8, bounds.y + 8);
    assert.equal(await dialog.isVisible(), true);
    await page.mouse.move(bounds.x + 8, bounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(bounds.x / 2, bounds.y + 8);
    await page.mouse.up();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await slackSelectionValue(channelIds), "CDISCARD123");
    await page.mouse.click(bounds.x / 2, bounds.y + 8);
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await page.getByRole("button", { name: "Edit Slack" }).click();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123");
    assert.equal(await dialog.getByLabel("Slack app token").inputValue(), "");

    await setSlackSelection(channelIds, "CUNBOUND123, CBOUND456");
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await dialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
    await selectSecret(dialog, "Slack bot token", slackBotSecret);
    await dialog.getByText("Secret binding staged. Save changes to apply it.").nth(1).waitFor();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
    assert.equal(
      await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
      0,
    );
    await dialog.getByText("Choose existing Slack token Secrets or create them here.").waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
    await page.goForward();
    await dialog.waitFor();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
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
    const saveReached = Promise.withResolvers();
    const saveRelease = Promise.withResolvers();
    t.after(() => saveRelease.resolve());
    // Hold the real save response so dismissal cannot hide an in-flight mutation.
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        saveReached.resolve();
        await saveRelease.promise;
        await route.fulfill({ response });
      },
    );
    await page.getByRole("button", { name: "Save configuration" }).click();
    await saveReached.promise;
    await page.mouse.click(bounds.x / 2, bounds.y + 8);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "Save configuration" }).isDisabled(),
      true,
    );
    saveRelease.resolve();
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
    const { fixture, namespace } = await readyNamespace(t, "Final Slack grant");
    const firstSecret = await fixture.createSecret(
      namespace.id,
      "First Slack app token",
      "hidden-a",
    );
    const finalSecret = await fixture.createSecret(
      namespace.id,
      "Final Slack app token",
      "hidden-b",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Final Slack Grant Agent",
      slug: "final-slack-grant",
      slack: { channels: { CFINAL123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    const grantStarted = Promise.withResolvers();
    const releaseGrant = Promise.withResolvers();
    t.after(() => releaseGrant.resolve());
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        grantStarted.resolve();
        await releaseGrant.promise;
        await route.continue();
      },
    );

    await openDraft(page, fixture, agent, "Final Slack Grant Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await selectSecret(dialog, "Slack app token", firstSecret);
    await selectSecret(dialog, "Slack app token", finalSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await grantStarted.promise;
    // Configuration is already saved, but the Agent's Secret grant is still in flight.
    try {
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("tab", { name: "Credentials", exact: true }).isDisabled(),
        true,
      );
    } finally {
      releaseGrant.resolve();
    }
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
    const { fixture, namespace } = await readyNamespace(t, "Original Slack grant");
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
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Original Slack Grant Agent",
      slug: "original-slack-grant",
      slack: { channels: { CORIG123: { requireMention: true } } },
      secretBindings,
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Original Slack Grant Agent");
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
    const { fixture, namespace } = await readyNamespace(t, "Rejected Slack save");
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Rejected save Slack app token",
      "hidden-rejected-save",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Rejected Slack Save Agent",
      slug: "rejected-slack-save",
      slack: { channels: { CREJECT123: { requireMention: true } } },
    });
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await failMethod(page, `**${configurationPath}`, "PATCH", {
      status: 403,
      error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
      requestId: "req_00000000-0000-4000-8000-000000000403",
    });

    await openDraft(page, fixture, agent, "Rejected Slack Save Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await allowEveryone.inputValue(), "everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await dialog.getByText(/Access denied|permission/i).waitFor();
    assert.equal(await allowEveryone.inputValue(), "everyone");
    await waitForEnabled(allowEveryone);
    assert.equal(await allowedUsers.isVisible(), false);

    const configuration = await fixture.request("GET", configurationPath);
    assert.equal(configuration.status, 200);
    assert.deepEqual(configuration.data.secretBindings ?? {}, {});
    assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
  });

  test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Slack everyone access");
    const { agent, slack } = await createSlackAgent(fixture, namespace, {
      name: "Slack Everyone Agent",
      slug: "slack-everyone",
      slack: {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: ["UDM123"],
        channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
      },
    });
    const { page } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, "Slack Everyone Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    let dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await setSlackSelection(
      dialog.getByRole("combobox", { name: "Channels", exact: true }),
      "CEVERY123, CSECOND123",
    );
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await allowEveryone.inputValue(), "everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${agent.configurationId}`),
    );
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await saved).status(), 200);
    // The PATCH answer reaches the test before the page has closed the drawer and rebuilt the
    // tab. A click begun then can pass Playwright's enabled check on the old card's Edit Slack
    // under the open drawer and land after the save disabled it: no drawer opens (finding 2282).
    // The status comes with the rebuilt tab.
    await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();

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
      await dialog.getByLabel("Who can use the agent in these channels?").inputValue(),
      "everyone",
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: "Allowed people in these channels", exact: true })
        .isVisible(),
      false,
    );
    assert.equal(await dialog.getByLabel("Require a mention", { exact: true }).isChecked(), false);
  });

  test("Channel drawer refuses to keep a channel enabled for an Embedded Agent", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Embedded Slack");
    // An Embedded OpenClaw Agent whose Configuration was then given an enabled Slack channel: the
    // Configuration API accepts it, while the Agent cannot serve it (Agent save and deploy refuse).
    const values = nativeValues("embedded-slack");
    const agent = await fixture.createAgent(namespace.id, "Embedded Slack Agent", values);
    assert.equal(agent.executionMode, "embedded");
    await fixture.updateConfiguration(namespace.id, agent.configurationId, {
      ...values,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        },
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Embedded Slack Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    // A refusal is a danger alert (finding 2006), and nothing is written.
    const refusal = dialog.getByText("Channels require Dedicated execution.", { exact: true });
    await refusal.waitFor();
    assert.deepEqual(await statusTone(refusal), {
      className: "status",
      tone: "danger",
      role: "alert",
    });
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });

  // Only a grant whose answer is lost or failed (5xx) leaves its outcome unknown; a refusal is
  // known (the member case below, finding 1920).
  test("Channel drawer reports an unknown grant outcome when the post-PATCH Secret grant fails", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Partial Slack grant");
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Partial save Slack app token",
      "hidden-partial-save",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Partial Slack Grant Agent",
      slug: "partial-slack-grant",
      slack: { channels: { CPARTIAL123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await failMethod(page, `**/namespaces/${namespace.id}/iam/access-bindings`, "POST", {
      status: 503,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked IAM failure" },
      requestId: "req_00000000-0000-4000-8000-000000000433",
    });

    await openDraft(page, fixture, agent, "Partial Slack Grant Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    // The notice names the refused grant's Request ID for the Installation administrator it sends
    // the operator to (finding 2195: #3207 wrapped the error and dropped it).
    await page
      .getByText(
        "Configuration saved, but Secret access grants could not be confirmed. Reload the draft, inspect saved bindings in Agent Credentials, then ask an Installation administrator to grant this Agent access to the saved Secret. Request ID: req_00000000-0000-4000-8000-000000000433",
        { exact: true },
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

    assert.equal(
      await page.getByRole("tab", { name: "Credentials", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Reload draft" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/Configuration .*generation 2/).waitFor();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    const appToken = page.getByLabel("Slack app token");
    await appToken.waitFor();
    assert.equal(await appToken.evaluate((node) => node.tagName), "INPUT");
    await waitForInputValue(appToken, secretOptionLabel(slackAppSecret));
    // The reloaded page no longer knows of the failed grant, but an Installation administrator's
    // console reads the IAM policy: the saved app token is not plainly Bound (finding 1920). The
    // bot token is still missing, so nothing can be saved or retried yet.
    await page.getByText("Bound · Agent access not confirmed", { exact: true }).waitFor();
    await page.getByText(GRANT_MISSING, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Retry Secret access" }).isDisabled(),
      true,
    );
  });

  // A member cannot write IAM policy, and the session already knows it (finding 2109), so a Slack
  // token saved from the drawer or from Credentials sends no grant the API would refuse and audit.
  // The warning says nothing verified the Agent's access and names who grants it. It offers no
  // Retry, and Reload draft clears the block, as the harness path does (findings 2259, 2263).
  for (const entry of ["drawer", "credentials"]) {
    test(`A member's Slack token saved from ${entry} names the administrator step without a grant`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, `Member Slack ${entry}`);
      const appSecret = await fixture.createSecret(
        namespace.id,
        "Member Slack app token",
        "hidden-member-app",
      );
      const botSecret = await fixture.createSecret(
        namespace.id,
        "Member Slack bot token",
        "hidden-member-bot",
      );
      const { agent } = await createSlackAgent(fixture, namespace, {
        name: "Member Slack Grant Agent",
        slug: "member-slack-grant",
        slack: { channels: { CMEMBER123: { requireMention: true } } },
        secretBindings: { SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } } },
      });
      const writer = await fixture.createNamespaceMember(
        "member-write",
        namespace.id,
        MEMBER_WRITE,
      );
      const { page } = await newPage(t, fixture, { browser });
      const requests = apiRequests(page, fixture.origin);
      const probe = page.waitForResponse(`${fixture.origin}/observability`);
      await login(
        page,
        fixture,
        detailUrl(
          fixture,
          namespace.id,
          agent.id,
          "draft",
          entry === "drawer" ? "channels" : entry,
        ),
        writer.credentials,
      );
      await page.getByRole("heading", { name: "Member Slack Grant Agent" }).waitFor();
      // The session's Installation read already found this account is no administrator.
      assert.equal((await probe).status(), 403);
      if (entry === "drawer") {
        await page.getByRole("button", { name: "Edit Slack" }).click();
        const dialog = page.getByRole("dialog", { name: "Edit Slack" });
        await selectSecret(dialog, "Slack app token", appSecret);
        await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
        // The Configuration saved, so the drawer closes; the page names the next step.
        await dialog.waitFor({ state: "hidden" });
        const warning = page.getByText(GRANT_UNVERIFIED, { exact: true });
        await warning.waitFor();
        assert.equal(
          await warning.evaluate((node) => node.closest(".status")?.getAttribute("data-tone")),
          "warning",
        );
        // Not a finished save: the notice says only what saved.
        await page.getByText("Configuration saved.", { exact: true }).waitFor();
        await expectNoText(page, /outcome is unknown|Outcome unknown|Channels saved\./);
        assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), false);
        await page.getByRole("link", { name: "Open Credentials" }).click();
      } else {
        await selectSecret(page, "Slack app token", appSecret);
        await page.getByRole("button", { name: "Save channel Secrets" }).click();
      }
      // Credentials marks the saved app token and offers no Retry the API would refuse.
      const panel = page.locator(".channel-secrets");
      const warning = panel.getByText(GRANT_UNVERIFIED, { exact: true });
      await warning.waitFor();
      assert.equal(await warning.getAttribute("data-tone"), "warning");
      const badges = () =>
        page
          .locator(".credential-status-list .badge")
          .evaluateAll((items) => items.map((badge) => badge.textContent));
      assert.deepEqual(await badges(), ["Bound · Agent access not confirmed", "Bound"]);
      assert.equal(await page.getByRole("button", { name: "Retry Secret access" }).count(), 0);
      await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );
      const configuration = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(configuration.data.secretBindings, {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      });
      assert.deepEqual(
        requests.filter(({ path }) => path.includes("/iam/")),
        [],
      );

      // Nothing verified the grant, so Reload draft clears the block it set.
      await panel.getByRole("button", { name: "Reload draft" }).click();
      await page.getByText("Draft reloaded.", { exact: true }).waitFor();
      await expectNoText(page, GRANT_UNVERIFIED);
      assert.deepEqual(await badges(), ["Bound", "Bound"]);
      assert.deepEqual(
        requests.filter(({ path }) => path.includes("/iam/")),
        [],
      );

      // The administrator the warning names opens the Agent: its policy read finds no grant. The
      // answer updates the panel in place, so a reader already in a picker keeps focus.
      const { page: adminPage } = await newPage(t, fixture, { browser });
      const bindingsRead = await holdRequests(
        t,
        adminPage,
        `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
        { once: true, method: "GET" },
      );
      await openDraft(adminPage, fixture, agent, "Member Slack Grant Agent", "credentials");
      await bindingsRead.requested;
      const appPicker = adminPage
        .locator(".channel-secrets")
        .getByLabel("Slack app token", { exact: true });
      await appPicker.focus();
      bindingsRead.release();
      await adminPage.getByText(GRANT_MISSING, { exact: true }).waitFor();
      assert.equal(
        await appPicker.evaluate((node) => node === globalThis.document.activeElement),
        true,
      );
      await adminPage.getByRole("button", { name: "Retry Secret access" }).click();
      await adminPage
        .getByText(
          "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.",
        )
        .waitFor();
      await adminPage.getByText("Ready to deploy.", { exact: true }).waitFor();
      assert.deepEqual(
        await adminPage
          .locator(".credential-status-list .badge")
          .evaluateAll((items) => items.map((badge) => badge.textContent)),
        ["Bound", "Bound"],
      );
    });
  }

  test("Agent credentials retry outstanding Slack Secret grants after changing one token", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Runtime Slack retained grant");
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
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Runtime Slack Retained Grant Agent",
      slug: "runtime-slack-retained-grant",
      slack: { channels: { CRETRYGRANT123: { requireMention: true } } },
      harnessAuth: { method: "api_key", source: modelSecret.ref },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    let denyGrant = true;
    let rejectNextConfigurationPatch = false;
    const reservation =
      "The Configuration is reserved for provisioning and is not available for this operation.";
    await page.route(
      `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      async (route, request) => {
        if (request.method() === "PATCH" && rejectNextConfigurationPatch) {
          rejectNextConfigurationPatch = false;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "RESOURCE_CONFLICT", message: reservation },
              meta: { requestId: "req_00000000-0000-4000-8000-000000000834" },
            }),
          });
          return;
        }
        await route.continue();
      },
    );
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
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
      },
    );

    await openDraft(page, fixture, agent, "Runtime Slack Retained Grant Agent", "credentials");
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
    requests.length = 0;
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    // This write was refused; only the earlier saved binding has an outstanding access grant.
    const outcome = page.locator(".channel-secrets [role=alert]");
    await outcome.filter({ hasText: reservation }).waitFor({ timeout: 5_000 });
    const message = await outcome.innerText();
    assert.match(message, /Access to a previously saved Secret is still unconfirmed/);
    assert.doesNotMatch(message, /Configuration saved/i);
    await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(secondAppSecret));
    assert.deepEqual(
      requests.filter((request) => request.method !== "GET").map((request) => request.method),
      ["PATCH"],
    );
    assert.equal(await page.getByRole("button", { name: "Reload draft" }).count(), 0);
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

    // Saving again here is an explicit user action with the still-selected second app token.
    requests.length = 0;
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
    assert.equal(
      await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
      false,
    );
  });

  // The feedback line takes its tone before its text, so a refusal's text arrives in an alert
  // and a later Secret choice turns it back to a warning before clearing it (finding 2015).
  test("Agent credentials set the channel Secrets feedback tone before its text", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Runtime Slack tone order");
    const botSecret = await fixture.createSecret(
      namespace.id,
      "Tone order Slack bot token",
      "hidden-tone-order-bot",
    );
    const appSecret = await fixture.createSecret(
      namespace.id,
      "Tone order Slack app token",
      "hidden-tone-order-app",
    );
    const otherAppSecret = await fixture.createSecret(
      namespace.id,
      "Other tone order Slack app token",
      "hidden-tone-order-other-app",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Runtime Slack Tone Order Agent",
      slug: "runtime-slack-tone-order",
      slack: { channels: { CTONEORDER123: { requireMention: true } } },
      secretBindings: {
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const configurationPath = `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    await failMethod(page, configurationPath, "PATCH", {
      status: 403,
      error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
      requestId: "req_00000000-0000-4000-8000-000000002015",
    });
    await openDraft(page, fixture, agent, "Runtime Slack Tone Order Agent", "credentials");
    await selectSecret(page, "Slack app token", appSecret);
    const feedback = page.locator(".channel-secrets > p.status[role=alert]").first();
    // Records, in order, each change to the feedback line's tone and text.
    const watchFeedback = () =>
      feedback.evaluate((line) => {
        const changes = [];
        globalThis.feedbackChanges = changes;
        new globalThis.MutationObserver((records) => {
          for (const record of records) {
            changes.push(record.type === "attributes" ? record.attributeName : "text");
          }
        }).observe(line, {
          attributes: true,
          attributeFilter: ["data-tone", "role"],
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    const feedbackChanges = () => page.evaluate(() => globalThis.feedbackChanges);

    await watchFeedback();
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    const refusal = page.locator(".channel-secrets > p.status[role=alert][data-tone=danger]");
    await refusal.filter({ hasText: /\S/ }).waitFor();
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);

    await watchFeedback();
    await selectSecret(page, "Slack app token", otherAppSecret);
    // Without an outstanding grant the warning is empty, so the line is attached but not visible.
    await page
      .locator(".channel-secrets > p.status[role=alert][data-tone=warning]")
      .waitFor({ state: "attached" });
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);
  });

  // Every grant failure keeps the saved binding blocked. An unavailable IAM API (503) still leaves a
  // known saved Configuration, not an unknown outcome. A refusal (403) says who can grant it
  // (finding 1920). Retry Secret access retries the pending grant on its own, without another
  // Configuration write; 403 keeps it pending for the channel-edit check below.
  const grantErrorCodes = {
    403: "ACCESS_DENIED",
    429: "TOO_MANY_REQUESTS",
    503: "DEPENDENCY_UNAVAILABLE",
  };
  for (const grantStatus of [403, 429, 503]) {
    test(`Agent credentials report partial Slack Secret grant failure (${grantStatus})`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, "Runtime Slack grant failure");
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
      const { agent } = await createSlackAgent(fixture, namespace, {
        name: "Runtime Slack Grant Failure Agent",
        slug: "runtime-slack-grant-failure",
        slack: { channels: { CRUNTIMEFAIL123: { requireMention: true } } },
        secretBindings,
      });
      const { page } = await newPage(t, fixture, { browser });
      const requests = apiRequests(page, fixture.origin);
      await failMethod(page, `**/namespaces/${namespace.id}/iam/access-bindings`, "POST", {
        status: grantStatus,
        error: { code: grantErrorCodes[grantStatus], message: "masked IAM failure" },
        requestId: "req_00000000-0000-4000-8000-000000000733",
      });

      await openDraft(page, fixture, agent, "Runtime Slack Grant Failure Agent", "credentials");
      requests.length = 0;
      await selectSecret(page, "Slack app token", replacementAppSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const grantWarning = page.getByText(
        grantStatus === 403
          ? GRANT_REFUSED
          : "Configuration saved, but Secret access grants could not be confirmed. Select Retry Secret access; if it is refused, ask an Installation administrator.",
      );
      await grantWarning.waitFor();
      // The Configuration saved, so the unconfirmed grant is a warning from the start, not a
      // refusal that turns into one when another Secret is picked (finding 2003).
      assert.equal(await grantWarning.getAttribute("data-tone"), "warning");
      assert.equal(
        await page.getByText("Bound · Agent access not confirmed", { exact: true }).count(),
        1,
      );
      await waitForEnabled(page.getByRole("button", { name: "Retry Secret access" }));
      await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );

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
      if (grantStatus !== 403) {
        // The pending grant is retried on its own once IAM answers again.
        await page.unroute(`**/namespaces/${namespace.id}/iam/access-bindings`);
        await page.getByRole("button", { name: "Retry Secret access" }).click();
        await page
          .getByText(
            "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.",
          )
          .waitFor();
        assert.deepEqual(
          accessBindingPostRequests(requests, namespace.id).map(
            (request) => request.body.resourceId,
          ),
          [replacementAppSecret.id, replacementAppSecret.id],
        );
        const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
        assert.equal(
          requests.filter(({ method, path }) => method === "PATCH" && path === configurationPath)
            .length,
          1,
        );
        assert.equal(
          await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByText("Configuration saved, but Secret access grants could not be confirmed.", {
              exact: false,
            })
            .count(),
          0,
        );
      }
      if (grantStatus === 403) {
        await page.getByRole("tab", { name: "Channels", exact: true }).click();
        await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Edit Slack" });
        await setSlackSelection(
          dialog.getByRole("combobox", { name: "Channels", exact: true }),
          "CRUNTIMEFAIL123, CRETAINREFS123",
        );
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

  test("a long Agent name's suggested Slack Secret name stays within the Name rule", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Long Agent names");
    // An Agent name may use all 200 characters, so "<Agent name> Slack app token" cannot be
    // suggested as is; the dialog shortens the middle and keeps what the Secret is for
    // (finding 1809).
    const name = `Long Slack Agent ${"n".repeat(183)}`;
    assert.equal(Array.from(name).length, 200);
    const { agent } = await createSlackAgent(fixture, namespace, { name, slug: "long-slack" });
    const { page } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, name);
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const drawer = page.getByRole("dialog", { name: "Edit Slack" });
    await drawer.getByLabel("Slack app token", { exact: true }).fill("Create a new Secret");
    await drawer.getByRole("option", { name: "Create new Secret...", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
    const suggested = await dialog.getByLabel("Name", { exact: true }).inputValue();
    // 159 leading characters, the ellipsis, and the last 40 characters of the suggestion.
    assert.equal(
      suggested,
      `Long Slack Agent ${"n".repeat(142)}…${"n".repeat(24)} Slack app token`,
    );
    assert.equal(Array.from(suggested).length, 200);

    // The API accepts the suggestion unchanged.
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/secrets"),
    );
    await dialog.getByLabel("Value", { exact: true }).fill("long-name-app-token");
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    const response = await created;
    assert.equal(response.status(), 201, await response.text());
    assert.equal((await response.json()).data.name, suggested);
    await dialog.waitFor({ state: "hidden" });
  });
});
