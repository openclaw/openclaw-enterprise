import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Page, Route } from "playwright";
import type {
  Agent,
  Namespace,
  SecretMetadata,
  SecretBinding,
  SecretBindings,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";

import { apiErrorResponse } from "../helpers/api-error-response.ts";
import { responseTo } from "./console-action-helpers.ts";
import {
  accessBindingPostRequests,
  apiRequests,
  createSlackSourceConsoleFixture,
  detailUrl,
  expectNoText,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  revokeAdministratorGrant,
  setSlackSelection,
  slackSelectionValue,
  statusTone,
  waitForEnabled,
  waitForInputValue,
} from "./console-agents-browser-helpers.ts";
import { trackSettledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";
import { SLACK_SETUP_HINT } from "../helpers/refusal-text.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createSlackSourceConsoleFixture>>["fixture"];
type DraftAgent = Pick<Agent, "id" | "namespaceId" | "configurationId">;

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
}

function assertAgent(value: unknown): asserts value is DraftAgent & Record<string, unknown> {
  assertRecord(value);
  assert.ok(typeof value.id === "string");
  assert.ok(typeof value.namespaceId === "string");
  assert.ok(typeof value.configurationId === "string");
}

function assertSecret(value: unknown): asserts value is SecretMetadata {
  assertRecord(value);
  assert.ok(typeof value.id === "string");
  assert.ok(typeof value.name === "string");
  assert.ok(typeof value.namespaceId === "string");
  const ref = value.ref;
  assertRecord(ref);
  assert.equal(ref.kind, "secret");
  assert.ok(typeof ref.id === "string");
  assert.ok(typeof ref.namespaceId === "string");
}

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A dedicated Codex Agent whose socket-mode Slack channel reads both tokens from env bindings.
// `slack` adds Slack settings; other options go to createAgent over executionMode "dedicated".
// Returns the Agent and the exact Slack values it was created with.
async function createSlackAgent(
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
  {
    name,
    slug,
    slack: extra,
    ...options
  }: {
    name: string;
    slug: string;
    slack?: OpenClawConfigurationDocument;
    secretBindings?: SecretBindings;
    harnessAuth?: Agent["harnessAuth"];
  },
) {
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    ...extra,
  };
  const agent: unknown = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues(slug, { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", ...options },
  );
  assertAgent(agent);
  return { agent, slack };
}

// Bound Sources for the named Slack tokens (`app`, `bot`). Configuration save refuses an enabled
// channel's token reference without a binding (finding 2319), so a drawer save that changes one
// token needs the other bound already.
async function slackTokenBindings(
  enroll: Awaited<ReturnType<typeof createSlackSourceConsoleFixture>>["enroll"],
  label: string,
  tokens = ["app", "bot"],
) {
  const bindings: Record<string, SecretBinding> = {};
  for (const token of tokens) {
    const { source } = await enroll(
      `${label} Slack ${token} token`,
      token === "app" ? "xapp" : "xoxb",
    );
    bindings[`SLACK_${token.toUpperCase()}_TOKEN`] = {
      source: source.ref,
      delivery: { type: "env" },
    };
  }
  return bindings;
}

// Signs in at the Agent's draft `tab` and waits for its `heading`.
async function openDraft(
  page: Page,
  fixture: ConsoleFixture,
  agent: DraftAgent,
  heading: string,
  tab = "channels",
) {
  await login(page, fixture, detailUrl(fixture, agent.namespaceId, agent.id, "draft", tab));
  await page.getByRole("heading", { name: heading }).waitFor();
}

// Answers `method` requests to `pattern` with `answer` (an API error or a proxy page); other
// requests reach the API.
async function failMethod(
  page: Page,
  pattern: Parameters<Page["route"]>[0],
  method: string,
  answer: Parameters<Route["fulfill"]>[0],
) {
  await page.route(pattern, async (route, request) => {
    if (request.method() !== method) {
      await route.continue();
      return;
    }
    await route.fulfill(answer);
  });
}

// Every case builds its own Console and browser context, so cases run a few at a time.
describe("Agent channels", { concurrency: 3 }, () => {
  test("Channel drawer saves channel edits without exposing credential values or dropping unrelated draft state", async (t) => {
    const secretValue = "super-secret-channel-value";
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Channel state",
    );
    const secret: unknown = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
    assertSecret(secret);
    const app = await enroll("Slack app token", "xapp");
    const bot = await enroll("Slack bot token", "xoxb");
    const slackAppSource = app.source;
    const slackBotSource = bot.source;
    const slackAppMaterial = app.secret;
    const slackBotMaterial = bot.secret;
    const secretBindings: SecretBindings = {
      EXTERNAL_API_TOKEN: {
        source: secret.ref,
        delivery: { type: "env" },
      },
      SLACK_APP_TOKEN: {
        source: slackAppSource.ref,
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: slackBotSource.ref,
        delivery: { type: "env" },
      },
    };
    const agent: unknown = await fixture.createAgent(
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
    assertAgent(agent);
    const { page, artifacts } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, "Channel Agent");
    await page.getByRole("tab", { name: "Channels" }).click();
    for (const value of [secretValue, slackAppMaterial, slackBotMaterial]) {
      await expectNoText(page, value);
    }

    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    // The drawer's standing notice is info, not a warning (finding 2006).
    assert.deepEqual(
      await statusTone(dialog.getByText(/^New version\. Changes affect future deployments/)),
      { className: "status", tone: "info", role: "status" },
    );
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
      .getByText(
        "Choose ready static Credential Sources or add new credentials for the Slack bot and app tokens.",
        { exact: false },
      )
      .scrollIntoViewIfNeeded();
    await dialog.screenshot({ path: join(artifacts, "agent-channel-drawer.png") });

    assert.equal(await slackSelectionValue(channelIds), "COLD123, CNEW123");
    assert.equal(await slackSelectionValue(allowedUsers), "UNEW123");

    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    for (const value of [secretValue, slackAppMaterial, slackBotMaterial]) {
      await expectNoText(page, value);
    }
    assert.equal(await page.getByRole("button", { name: /Microsoft Teams/ }).count(), 0);

    const configuration: unknown = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );

    assertRecord(configuration);
    assert.equal(configuration.status, 200);
    const configurationData = configuration.data;
    assertRecord(configurationData);
    const configurationDataValues = configurationData.values;
    assertRecord(configurationDataValues);
    const configurationDataValuesAgents = configurationDataValues.agents;
    assertRecord(configurationDataValuesAgents);
    const configurationDataValuesChannels = configurationDataValues.channels;
    assertRecord(configurationDataValuesChannels);
    const configurationDataValuesPlugins = configurationDataValues.plugins;
    assertRecord(configurationDataValuesPlugins);
    const configurationDataValuesAgentsDefaults = configurationDataValuesAgents.defaults;
    assertRecord(configurationDataValuesAgentsDefaults);
    const configurationDataValuesChannelsMsteams = configurationDataValuesChannels.msteams;
    assertRecord(configurationDataValuesChannelsMsteams);
    const configurationDataValuesChannelsSlack = configurationDataValuesChannels.slack;
    assertRecord(configurationDataValuesChannelsSlack);
    const configurationDataValuesPluginsEntries = configurationDataValuesPlugins.entries;
    assertRecord(configurationDataValuesPluginsEntries);
    const configurationDataValuesPluginsEntriesKnowledge =
      configurationDataValuesPluginsEntries.knowledge;
    assertRecord(configurationDataValuesPluginsEntriesKnowledge);
    const configurationDataValuesPluginsEntriesKnowledgeConfig =
      configurationDataValuesPluginsEntriesKnowledge.config;
    assertRecord(configurationDataValuesPluginsEntriesKnowledgeConfig);

    assert.deepEqual(configurationData.secretBindings, secretBindings);
    assert.deepEqual(configurationDataValuesChannelsSlack.appToken, {
      source: "env",
      provider: "default",
      id: "SLACK_APP_TOKEN",
    });
    assert.deepEqual(configurationDataValuesChannelsSlack.botToken, {
      source: "env",
      provider: "default",
      id: "SLACK_BOT_TOKEN",
    });
    assert.deepEqual(configurationDataValuesChannelsSlack.channels, {
      COLD123: { requireMention: true, users: ["UNEW123"] },
      CNEW123: { requireMention: true, users: ["UNEW123"] },
    });
    assert.equal(configurationDataValuesChannelsSlack.replyToMode, "off");
    assert.deepEqual(configurationDataValuesChannelsSlack.replyToModeByChatType, {
      direct: "first",
      channel: "off",
    });
    assert.equal(configurationDataValuesChannelsSlack.dmPolicy, "allowlist");
    assert.deepEqual(configurationDataValuesChannelsSlack.allowFrom, ["UOLD123"]);
    assert.equal(
      configurationDataValuesChannelsMsteams.appId,
      "00000000-0000-4000-8000-000000000000",
    );
    assert.equal(
      configurationDataValuesChannelsMsteams.tenantId,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.deepEqual(configurationDataValuesChannelsMsteams.appPassword, {
      source: "env",
      provider: "default",
      id: "MSTEAMS_APP_PASSWORD",
    });
    assert.equal(configurationDataValuesPluginsEntriesKnowledgeConfig.marker, "channels");
    assert.deepEqual(configurationDataValuesPluginsEntriesKnowledgeConfig.thresholds, [1, 2, 3]);
    assert.equal(configurationDataValuesAgentsDefaults.model, "codex/gpt-5.1");

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
  ] satisfies [string, OpenClawConfigurationDocument, string][]) {
    test(`Channel drawer keeps Slack ${name} in native JSON`, async (t) => {
      const { fixture, namespace } = await createSlackSourceConsoleFixture(
        t,
        "Unsupported Slack native",
      );
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
      const nativeText = await page.locator(".channel-native pre").textContent();
      assert.ok(nativeText !== null);
      const nativeJson: unknown = JSON.parse(nativeText);
      assert.deepEqual(nativeJson, slack);
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    });
  }

  // Configuration save recommends a whole `${NAME}` bound to a Source for a channel token. The
  // drawer opened that form as "non-standard" and stayed disabled (finding 2495): it now edits
  // the channel and saves each token in the form it was written.
  test("Channel drawer edits Slack whose tokens are whole ${NAME} references and keeps them", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Whole reference Slack",
    );
    const tokens = { appToken: "${SLACK_APP_TOKEN}", botToken: "${SLACK_BOT_TOKEN}" };
    const { agent, slack } = await createSlackAgent(fixture, namespace, {
      name: "Whole reference Slack",
      slug: "whole-reference-slack",
      slack: { ...tokens, channels: { COLD123: { requireMention: true, users: ["*"] } } },
      secretBindings: await slackTokenBindings(enroll, "Whole reference"),
    });
    const { page } = await newPage(t, fixture, { browser });
    await openDraft(page, fixture, agent, "Whole reference Slack");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const save = dialog.getByRole("button", { name: "Save configuration" });
    // Reading the references back is no change.
    assert.equal(await save.isDisabled(), true);
    await dialog.getByLabel("Require a mention").uncheck();
    await waitForEnabled(save);
    await save.click();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const storedResponse: unknown = await fixture.request("GET", configurationPath);
    assertRecord(storedResponse);
    const storedResponseData = storedResponse.data;
    assertRecord(storedResponseData);
    const storedResponseDataValues = storedResponseData.values;
    assertRecord(storedResponseDataValues);
    const storedResponseDataValuesChannels = storedResponseDataValues.channels;
    assertRecord(storedResponseDataValuesChannels);
    const stored = storedResponseDataValuesChannels.slack;
    assert.deepEqual(stored, {
      ...slack,
      channels: { COLD123: { requireMention: false, users: ["*"] } },
    });
  });

  // A token reference the drawer cannot write back keeps it disabled; the reason names the way
  // out and describes the disabled button (finding 2495).
  test("Channel drawer names how to edit Slack with a token reference it does not write", async (t) => {
    const { fixture, namespace } = await createSlackSourceConsoleFixture(
      t,
      "Other reference Slack",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Other reference Slack",
      slug: "other-reference-slack",
      slack: { botToken: { source: "env", provider: "default", id: "OTHER_BOT_TOKEN" } },
    });
    const { page } = await newPage(t, fixture, { browser });
    await openDraft(page, fixture, agent, "Other reference Slack");
    const reason = page.getByText(
      "Slack bot token uses a credential reference this editor does not write. To edit Slack here, set botToken to ${SLACK_BOT_TOKEN} in the Configuration JSON.",
      { exact: true },
    );
    await reason.waitFor();
    const edit = page.getByRole("button", { name: "Edit Slack" });
    assert.equal(await edit.isDisabled(), true);
    assert.equal(await edit.getAttribute("aria-describedby"), await reason.getAttribute("id"));
  });

  // OpenClaw matches plugins.deny entries by policy ID (trimmed, lowercased), so a padded or
  // mixed-case `Slack` blocks the slack plugin as the exact `slack` does; the card said nothing
  // and offered Configure Slack (finding 3082). Another plugin's deny entry blocks nothing.
  test("The Slack card names a plugins.deny entry in any spelling of slack", async (t) => {
    const { fixture, namespace } = await createSlackSourceConsoleFixture(t, "Denied Slack plugin");
    const { page } = await newPage(t, fixture, { browser });
    const blocked = page.getByText("Slack is explicitly blocked in native plugin configuration.", {
      exact: true,
    });
    const cases: [string, string[], boolean][] = [
      ["padded", [" Slack"], true],
      ["upper", ["SLACK "], true],
      ["exact", ["slack"], true],
      // Not a non-text item: every Configuration save refuses one (finding 3101).
      ["other", ["discord", "telegram"], false],
    ];
    const agents: DraftAgent[] = [];
    for (const [slug, deny] of cases) {
      const values: unknown = nativeValues(slug, { harnessId: "codex" });
      assertRecord(values);
      const valuesPlugins = values.plugins;
      assertRecord(valuesPlugins);
      valuesPlugins.deny = deny;
      const agent: unknown = await fixture.createAgent(namespace.id, `Deny ${slug} Agent`, values, {
        executionMode: "dedicated",
      });
      assertAgent(agent);
      agents.push(agent);
    }
    const firstAgent = agents[0];
    assert.ok(firstAgent);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, firstAgent.id, "draft", "channels"),
    );
    for (const [index, [slug, , isBlocked]] of cases.entries()) {
      const currentAgent = agents[index];
      assert.ok(currentAgent);
      await page.goto(detailUrl(fixture, namespace.id, currentAgent.id, "draft", "channels").href);
      await page.getByRole("heading", { name: `Deny ${slug} Agent` }).waitFor();
      const configure = page.getByRole("button", { name: "Configure Slack" });
      await configure.waitFor();
      if (isBlocked) {
        await blocked.waitFor();
        assert.equal(await configure.isDisabled(), true, slug);
        assert.equal(
          await configure.getAttribute("aria-describedby"),
          await blocked.getAttribute("id"),
        );
      } else {
        await waitForEnabled(configure);
        assert.equal(await blocked.count(), 0, slug);
      }
    }
  });

  // OpenClaw merges the plugins.entries keyed `slack` and ` Slack` in key order, and the last
  // boolean `enabled` wins. Saving the channel enabled only the exact key, so a later ` Slack`
  // entry's `enabled: false` kept the plugin off (finding 3082). The save now enables that entry
  // too, keeps its other settings, and adds no second spelling to plugins.allow.
  test("Channel drawer enables every spelling of the slack plugin entry it saves", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Variant Slack entry",
    );
    const values: unknown = nativeValues("variant-slack-entry", {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: "${SLACK_APP_TOKEN}",
          botToken: "${SLACK_BOT_TOKEN}",
          channels: { COLD123: { requireMention: true, users: ["*"] } },
        },
      },
    });
    assertRecord(values);
    const valuesPlugins = values.plugins;
    assertRecord(valuesPlugins);
    const valuesPluginsEntries = valuesPlugins.entries;
    assertRecord(valuesPluginsEntries);
    valuesPlugins.allow = ["codex", " Slack"];
    valuesPlugins.entries = {
      ...valuesPluginsEntries,
      slack: { enabled: false },
      " Slack": { enabled: false, config: { marker: "variant" } },
    };
    const agent: unknown = await fixture.createAgent(namespace.id, "Variant Slack entry", values, {
      executionMode: "dedicated",
      secretBindings: await slackTokenBindings(enroll, "Variant entry"),
    });
    assertAgent(agent);
    const { page } = await newPage(t, fixture, { browser });
    await openDraft(page, fixture, agent, "Variant Slack entry");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const save = dialog.getByRole("button", { name: "Save configuration" });
    await dialog.getByLabel("Require a mention").uncheck();
    await waitForEnabled(save);
    await save.click();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const storedResponse: unknown = await fixture.request("GET", configurationPath);
    assertRecord(storedResponse);
    const storedResponseData = storedResponse.data;
    assertRecord(storedResponseData);
    const storedResponseDataValues = storedResponseData.values;
    assertRecord(storedResponseDataValues);
    const stored = storedResponseDataValues.plugins;
    assertRecord(stored);
    const storedEntries = stored.entries;
    assertRecord(storedEntries);
    assert.deepEqual(storedEntries.slack, { enabled: true });
    assert.deepEqual(storedEntries[" Slack"], { enabled: true, config: { marker: "variant" } });
    assert.deepEqual(stored.allow, ["codex", " Slack"]);
    // Other plugins' entries are untouched.
    assert.deepEqual(storedEntries.knowledge, valuesPluginsEntries.knowledge);
    assert.deepEqual(storedEntries.codex, valuesPluginsEntries.codex);
  });

  // Every deployment needs a model authentication source. An Agent with its API key bound was
  // still told to configure model credentials "before first deploy" (finding 2063).
  test("Channel drawer asks for model credentials only while the Agent has none", async (t) => {
    const { fixture, namespace } = await createSlackSourceConsoleFixture(t, "notice");
    const NOTICE = "New version. Changes affect future deployments using this Configuration.";
    const { agent: keyed } = await createSlackAgent(fixture, namespace, {
      name: "Keyed Agent",
      slug: "keyed",
    });
    const keyedAuth = keyed.harnessAuth;
    if (keyedAuth !== null && keyedAuth !== undefined) {
      assertRecord(keyedAuth);
    }
    assert.equal(keyedAuth?.method, "api_key");
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
    const notice = async (agent: DraftAgent, heading: string) => {
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

  test("Channel drawer keeps staged Source choices and channel edits through dismissal and history", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Unbound Slack credentials",
    );
    const app = await enroll("Existing menu Slack app token", "xapp");
    const bot = await enroll("Existing menu Slack bot token", "xoxb");
    const slackAppSource = app.source;
    const slackBotSource = bot.source;
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Unbound Slack Agent",
      slug: "unbound-slack",
      slack: { channels: { CUNBOUND123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Unbound Slack Agent");
    // The card asks for both token Sources until each one is bound (finding 2438).
    const setupHint = page.locator(".channel-card").getByText(SLACK_SETUP_HINT, { exact: true });
    await setupHint.waitFor();
    // Establish a same-document history entry before opening the modal.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
    const channelIds = dialog.getByRole("combobox", { name: "Channels", exact: true });
    await setSlackSelection(channelIds, "CDISCARD123");
    await dialog.getByLabel("Slack app token", { exact: true }).selectOption(slackAppSource.id);

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
    assert.equal(await dialog.getByLabel("Slack app token", { exact: true }).inputValue(), "");

    await setSlackSelection(channelIds, "CUNBOUND123, CBOUND456");
    await dialog.getByLabel("Slack app token", { exact: true }).selectOption(slackAppSource.id);
    await dialog.getByLabel("Slack bot token", { exact: true }).selectOption(slackBotSource.id);
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
    assert.equal(
      await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
      0,
    );
    await dialog
      .getByText(/Choose ready static Credential Sources or add new credentials/)
      .waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
    await page.goForward();
    await dialog.waitFor();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
    assert.equal(
      await dialog.getByLabel("Slack app token", { exact: true }).inputValue(),
      slackAppSource.id,
    );
    assert.equal(
      await dialog.getByLabel("Slack bot token", { exact: true }).inputValue(),
      slackBotSource.id,
    );
    const beforeSave: unknown = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assertRecord(beforeSave);
    const beforeSaveData = beforeSave.data;
    assertRecord(beforeSaveData);
    assert.equal(beforeSaveData.generation, 1);
    // Hold the real save response so dismissal cannot hide an in-flight mutation.
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const save = await holdRequests(t, page, `${fixture.origin}${configurationPath}`, {
      method: "PATCH",
      afterServer: true,
      timeout: 0,
    });
    await page.getByRole("button", { name: "Save configuration" }).click();
    await save.requested;
    await page.mouse.click(bounds.x / 2, bounds.y + 8);
    await nextFrames(page);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "Save configuration" }).isDisabled(),
      true,
    );
    // The API has applied the save, but the page has not heard so: it is still waiting on the
    // Configuration write. Source delegation belongs to deployment admission.
    const savedConfiguration: unknown = await fixture.request("GET", configurationPath);
    assertRecord(savedConfiguration);
    const savedConfigurationData = savedConfiguration.data;
    assertRecord(savedConfigurationData);
    assert.equal(savedConfigurationData.generation, 2);
    const saved = requests
      .map(({ method, path }) => method === "PATCH" && path === configurationPath)
      .lastIndexOf(true);
    assert.notEqual(saved, -1);
    assert.deepEqual(
      requests.slice(saved + 1).filter(({ path }) => path.includes("/iam/")),
      [],
    );
    save.release();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
    const configuration: unknown = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assertRecord(configuration);
    const configurationData = configuration.data;
    assertRecord(configurationData);
    const configurationDataValues = configurationData.values;
    assertRecord(configurationDataValues);
    const configurationDataValuesChannels = configurationDataValues.channels;
    assertRecord(configurationDataValuesChannels);
    const configurationDataValuesChannelsSlack = configurationDataValuesChannels.slack;
    assertRecord(configurationDataValuesChannelsSlack);
    assert.deepEqual(configurationData.secretBindings, {
      SLACK_APP_TOKEN: { source: slackAppSource.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: slackBotSource.ref, delivery: { type: "env" } },
    });
    assert.deepEqual(configurationDataValuesChannelsSlack.channels, {
      CUNBOUND123: { requireMention: true, users: ["*"] },
      CBOUND456: { requireMention: true, users: ["*"] },
    });
    await setupHint.waitFor({ state: "detached" });
    const pageText = await page.locator("body").textContent();
    assert.ok(pageText !== null);
    assert.equal(pageText.includes(app.secret), false);
    assert.equal(pageText.includes(bot.secret), false);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`A closed Channels draft distinguishes unavailable and denied access checks (${viewport.width} px)`, async (t) => {
      const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
        t,
        "Channel access check",
      );
      const { agent } = await createSlackAgent(fixture, namespace, {
        name: "Channel access Agent",
        slug: "channel-access",
        secretBindings: await slackTokenBindings(enroll, "Channel access"),
      });
      const { page } = await newPage(t, fixture, { browser, context: { viewport } });
      await trackSettledFetches(page);
      await openDraft(page, fixture, agent, "Channels");
      const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
      const tab = page.getByRole("tab", { name: "Channels", exact: true });
      const panel = page.getByRole("tabpanel", { name: "Channels", exact: true });
      const draftEntry = page.locator("#revision-selector option[value=draft]");
      await edit.waitFor();
      await waitForIdleFetches(page);
      const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
      const agentUrl = fixture.origin + agentPath;
      const permissionsPath = `${agentPath}/permissions`;
      const permissionsUrl = fixture.origin + permissionsPath;
      const requests = apiRequests(page, fixture.origin);
      const unavailableResponse = apiErrorResponse(
        503,
        "INTERNAL_ERROR",
        "Permission read unavailable.",
      );
      let unavailable = false;
      await page.route(permissionsUrl, async (route) => {
        if (!unavailable || route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        unavailable = false;
        await route.fulfill(unavailableResponse);
      });
      const checkPermissions = async (
        trigger: () => Promise<unknown>,
        status: number,
        configurationUpdate?: boolean,
      ) => {
        const checked = responseTo(page, "GET", permissionsUrl);
        await trigger();
        const response = await checked;
        assert.equal(response.status(), status, "permission check HTTP response");
        if (configurationUpdate !== undefined) {
          const body: unknown = await response.json();
          assertRecord(body);
          assertRecord(body.data);
          assert.equal(body.data.configurationUpdate, configurationUpdate);
        }
        await waitForIdleFetches(page);
        await nextFrames(page);
      };
      const recheck = (status: number, configurationUpdate?: boolean) =>
        checkPermissions(
          () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
          status,
          configurationUpdate,
        );

      // Start away from the scroll limits so the tab can stay in the same part of the viewport
      // even when the permission-gated checklist and harness controls above it disappear.
      await tab.evaluate((control) => {
        window.scrollBy({
          top: control.getBoundingClientRect().top - window.innerHeight / 2,
          behavior: "instant",
        });
      });
      await edit.evaluate((control: HTMLButtonElement) => control.focus({ preventScroll: true }));
      assert.equal(await hasFocus(edit), true);
      const tabTop = () => tab.evaluate((control) => control.getBoundingClientRect().top);
      const initialTop = await tabTop();
      assert.ok(initialTop > 0 && initialTop < viewport.height, "Channels tab starts in view");
      const expectAnchor = async () => {
        const top = await tabTop();
        assert.ok(
          Math.abs(top - initialTop) <= 1,
          `Channels tab moved from ${initialTop} to ${top}`,
        );
      };
      const unconfirmed = /Could not check your edit access\. Select Refresh to try again\./;
      const unconfirmedDraft = "Draft · Edit access unconfirmed";
      const denial = /Your access does not include editing this Configuration/;
      const expectUnconfirmed = async () => {
        const copy = await panel.innerText();
        assert.match(copy, unconfirmed);
        assert.doesNotMatch(
          copy,
          /Your access does not include|read-only with your access|ask an Installation administrator/i,
        );
        assert.equal(await edit.count(), 0);
        assert.equal(await draftEntry.textContent(), unconfirmedDraft);
      };

      unavailable = true;
      await recheck(503);
      await expectUnconfirmed();
      await expectAnchor();
      assert.equal(
        await hasFocus(tab),
        true,
        "focus returns to the selected tab after Edit is removed",
      );

      await recheck(200, true);
      await edit.waitFor();
      assert.doesNotMatch(await panel.innerText(), unconfirmed);
      assert.equal(await draftEntry.textContent(), "Draft · Editable Configuration");
      await expectAnchor();
      assert.equal(await hasFocus(tab), true);

      // A genuine denial has the same disabled action as a failed check, but different copy.
      await edit.evaluate((control: HTMLButtonElement) => control.focus({ preventScroll: true }));
      assert.equal(await hasFocus(edit), true);
      const restore = revokeAdministratorGrant(fixture, ["update", "configuration"]);
      t.after(restore);
      await recheck(200, false);
      assert.match(await panel.innerText(), denial);
      assert.equal(await edit.count(), 0);
      assert.equal(await hasFocus(tab), true, "focus returns to the selected tab after denial");
      unavailable = true;
      await recheck(503);
      await expectUnconfirmed();
      await page.getByRole("tab", { name: "Configuration", exact: true }).click();
      await page.getByRole("tabpanel", { name: "Configuration", exact: true }).waitFor();
      assert.equal(await draftEntry.textContent(), unconfirmedDraft);
      await tab.click();
      await panel.getByText(unconfirmed).waitFor();
      await expectUnconfirmed();
      await recheck(200, false);
      assert.match(await panel.innerText(), denial);
      assert.doesNotMatch(await panel.innerText(), unconfirmed);
      assert.equal(await draftEntry.textContent(), "Draft · Read-only Configuration");
      assert.equal(await edit.count(), 0);
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 5);

      restore();
      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      // An Agent read can fail before Refresh reaches permissions. Retry still needs confirmation.
      await page.route(
        agentUrl,
        (route) =>
          route.fulfill(apiErrorResponse(503, "INTERNAL_ERROR", "Agent read unavailable.")),
        { times: 1 },
      );
      const failedAgentRead = responseTo(page, "GET", agentUrl);
      await refresh.click();
      assert.equal((await failedAgentRead).status(), 503);
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 5);
      const recoveredAgentRead = responseTo(page, "GET", agentUrl);
      unavailable = true;
      await checkPermissions(() => retry.click(), 503);
      assert.equal((await recoveredAgentRead).status(), 200);
      await expectUnconfirmed();
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 6);

      // Refresh must wait for a current answer, even when the account really has edit access.
      const failedRefresh = await holdRequests(t, page, permissionsUrl, {
        once: true,
        method: "GET",
        fulfill: unavailableResponse,
      });
      await checkPermissions(async () => {
        await refresh.click();
        await failedRefresh.requested;
        assert.equal(await edit.count(), 0, "Edit Slack stays unavailable during Refresh");
        failedRefresh.release();
      }, 503);
      await waitForEnabled(refresh);
      await expectUnconfirmed();
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 7);

      await checkPermissions(() => refresh.click(), 200, true);
      await waitForEnabled(refresh);
      await waitForEnabled(edit);
      assert.doesNotMatch(await panel.innerText(), unconfirmed);
      assert.doesNotMatch(await panel.innerText(), denial);
      assert.equal(await draftEntry.textContent(), "Draft · Editable Configuration");
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 8);

      const readAnchor = () =>
        tab.evaluate((control) => ({
          top: control.getBoundingClientRect().top,
          scroll: window.scrollY,
          maxScroll: document.documentElement.scrollHeight - window.innerHeight,
        }));
      const expectSettledAnchor = async (previousTop: number, phase: string) => {
        const { top, scroll, maxScroll } = await readAnchor();
        const target = Math.max(0, Math.min(maxScroll, scroll + top - previousTop));
        assert.ok(
          Math.abs(scroll - target) <= 1,
          `${phase}: Channels tab moved from ${previousTop} to ${top} at scroll ${scroll}, expected ${target} of ${maxScroll}`,
        );
        return top;
      };
      await edit.click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
      await cancel.press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await hasFocus(edit), true, "Cancel restores Edit Slack focus");
      await page.evaluate(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      });
      const bottom = await readAnchor();
      assert.ok(bottom.maxScroll > 0);
      assert.equal(bottom.scroll, bottom.maxScroll, "the reader starts at the bottom");
      assert.ok(bottom.top > 0 && bottom.top < viewport.height, "Channels tab starts in view");

      // Use the settled scroll range. A shorter page can make the old screen position unreachable.
      unavailable = true;
      await recheck(503);
      await expectUnconfirmed();
      const unconfirmedTop = await expectSettledAnchor(bottom.top, "unavailable access");
      assert.equal(await hasFocus(tab), true);
      await recheck(200, true);
      await waitForEnabled(edit);
      await expectSettledAnchor(unconfirmedTop, "confirmed access");
      assert.equal(await hasFocus(tab), true);
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 10);

      // Returning to the browser tab must preserve arrow-key focus without activating it.
      const strip = page.getByRole("tablist").filter({ has: tab });
      const repositories = strip.getByRole("tab", { name: "Repositories", exact: true });
      await page.keyboard.press("ArrowRight");
      assert.equal(await hasFocus(repositories), true);
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      await recheck(200, true);
      assert.equal(await hasFocus(repositories), true);
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      const stops = await strip
        .getByRole("tab")
        .evaluateAll((tabs) =>
          tabs.filter((item) => item.tabIndex >= 0).map((item) => item.textContent?.trim()),
        );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await strip.evaluate((list) => list.matches(":focus-within")),
        false,
        "Shift+Tab leaves the Agent tabs in one step",
      );
      await page.keyboard.press("Tab");
      assert.equal(await hasFocus(tab), true, "Tab returns to the selected Channels tab");
      assert.deepEqual(stops, ["Repositories"]);
      assert.equal(pathRequests(requests, "GET", permissionsPath).length, 11);
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    });
  }

  // A version snapshot cannot be edited, so its Slack card offers no setup step: a reader of a
  // v1 without Slack was told to provide the tokens (finding 2455). The Dedicated draft still
  // asks; an Embedded one cannot have channels, so it does not (finding D708).
  test("A version snapshot's Slack card shows no setup hint", async (t) => {
    const { fixture, namespace } = await createSlackSourceConsoleFixture(t, "Snapshot Slack hint");
    const agent: unknown = await fixture.createAgent(
      namespace.id,
      "Snapshot Agent",
      nativeValues("snapshot", { harnessId: "codex" }),
      { executionMode: "dedicated" },
    );
    assertAgent(agent);
    const { revision }: { revision: unknown } = await fixture.seedActiveAgentRevision(
      namespace.id,
      agent.id,
    );
    assertRecord(revision);
    const { page } = await newPage(t, fixture, { browser });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "channels"));
    const card = page.locator(".channel-card").filter({ hasText: "Slack" });
    await card.getByText("Not configured").first().waitFor();
    assert.equal(await card.getByText(SLACK_SETUP_HINT, { exact: true }).count(), 0);
    await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "channels").href);
    await page.locator(".channel-card").getByText(SLACK_SETUP_HINT, { exact: true }).waitFor();
  });

  // A save with nothing changed wrote the same settings as a new Configuration generation and
  // said "Channels saved." (finding 2482). A Source picked back or a box checked back is no change.
  test("Edit Slack keeps Save disabled until something changes", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Slack no-op save",
    );
    const app = (await enroll("No-op Slack app token", "xapp")).source;
    const spare = (await enroll("Spare Slack app token", "xapp")).source;
    const botBindings = await slackTokenBindings(enroll, "No-op", ["bot"]);
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Slack No-op Agent",
      slug: "slack-noop",
      slack: { channels: { CNOOP123: { requireMention: true, users: ["*"] } } },
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        ...botBindings,
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await openDraft(page, fixture, agent, "Slack No-op Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const save = dialog.getByRole("button", { name: "Save configuration", exact: true });
    const bot = dialog.getByLabel("Slack bot token", { exact: true });
    const boundBot = botBindings.SLACK_BOT_TOKEN!.source.id;
    await waitForInputValue(bot, boundBot);
    assert.equal(await save.isDisabled(), true);
    // A Source picked and then picked back is no change.
    await dialog.getByLabel("Slack app token", { exact: true }).selectOption(spare.id);
    await waitForEnabled(save);
    await dialog.getByLabel("Slack app token", { exact: true }).selectOption(app.id);
    assert.equal(await save.isDisabled(), true);
    // A box changed and changed back.
    const mention = dialog.getByLabel("Require a mention", { exact: true });
    await mention.uncheck();
    await waitForEnabled(save);
    await mention.check();
    assert.equal(await save.isDisabled(), true);
    // Only directory lookups, which read Slack names, were sent.
    assert.deepEqual(
      nonAuthWriteRequests(requests).filter(
        (request) => !request.path.endsWith("/channel-directory/lookup"),
      ),
      [],
    );
    const configuration: unknown = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assertRecord(configuration);
    const configurationData = configuration.data;
    assertRecord(configurationData);
    assert.equal(configurationData.generation, 1);
  });

  // A DM policy changed and changed back is no change either, though leaving Open cleared its
  // wildcard sender list: the editor made that change itself, not the reader (finding 1509).
  test("Edit Slack keeps Save disabled after a DM policy is changed back", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Slack DM no-op save",
    );
    const bindings = await slackTokenBindings(enroll, "DM no-op");
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Slack DM No-op Agent",
      slug: "slack-dm-noop",
      slack: { dmPolicy: "open", allowFrom: ["*"] },
      secretBindings: bindings,
    });
    const { page } = await newPage(t, fixture, { browser });
    await openDraft(page, fixture, agent, "Slack DM No-op Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const save = dialog.getByRole("button", { name: "Save configuration", exact: true });
    await waitForInputValue(
      dialog.getByLabel("Slack bot token", { exact: true }),
      bindings.SLACK_BOT_TOKEN!.source.id,
    );
    assert.equal(await save.isDisabled(), true);
    const policy = dialog.getByLabel("Direct-message policy", { exact: true });
    await policy.selectOption("allowlist");
    await waitForEnabled(save);
    await policy.selectOption("open");
    assert.equal(await save.isDisabled(), true);
  });

  test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Slack everyone access",
    );
    const { agent, slack } = await createSlackAgent(fixture, namespace, {
      name: "Slack Everyone Agent",
      slug: "slack-everyone",
      slack: {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: ["UDM123"],
        channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
      },
      secretBindings: await slackTokenBindings(enroll, "Everyone"),
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

    const configuration: unknown = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );

    assertRecord(configuration);
    const configurationData = configuration.data;
    assertRecord(configurationData);
    const configurationDataValues = configurationData.values;
    assertRecord(configurationDataValues);
    const configurationDataValuesChannels = configurationDataValues.channels;
    assertRecord(configurationDataValuesChannels);
    assert.deepEqual(configurationDataValuesChannels.slack, {
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
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Embedded Slack",
    );
    // An Embedded OpenClaw Agent whose Configuration was then given an enabled Slack channel: the
    // Configuration API accepts it, while the Agent cannot serve it (Agent save and deploy refuse).
    const values: unknown = nativeValues("embedded-slack");
    assertRecord(values);
    const agent: unknown = await fixture.createAgent(namespace.id, "Embedded Slack Agent", values);
    assertAgent(agent);
    assert.equal(agent.executionMode, "embedded");
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      {
        ...values,
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          },
        },
      },
      { secretBindings: await slackTokenBindings(enroll, "Embedded") },
    );
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Embedded Slack Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
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
  // The feedback line takes its tone before its text, so a refusal's text arrives in an alert
  // and a later Source choice turns it back to a warning before clearing it (finding 2015).
  test("Agent credentials set the channel credential feedback tone before its text", async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Runtime Slack tone order",
    );
    const botSource = (await enroll("Tone order Slack bot token", "xoxb")).source;
    const appSource = (await enroll("Tone order Slack app token", "xapp")).source;
    const otherAppSource = (await enroll("Other tone order Slack app token", "xapp")).source;
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Runtime Slack Tone Order Agent",
      slug: "runtime-slack-tone-order",
      slack: { channels: { CTONEORDER123: { requireMention: true } } },
      secretBindings: {
        SLACK_BOT_TOKEN: { source: botSource.ref, delivery: { type: "env" } },
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const configurationPath = `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    await failMethod(
      page,
      configurationPath,
      "PATCH",
      apiErrorResponse(403, "FORBIDDEN", "masked Configuration denial", {
        requestId: "req_00000000-0000-4000-8000-000000002015",
      }),
    );
    await openDraft(page, fixture, agent, "Runtime Slack Tone Order Agent", "credentials");
    await page.getByLabel("Slack app token", { exact: true }).selectOption(appSource.id);
    const feedback = page.locator(".channel-secrets > p.status[role=alert]").first();
    // Records, in order, each change to the feedback line's tone and text.
    const watchFeedback = () =>
      feedback.evaluate((line) => {
        const changes: (string | null)[] = [];
        Object.assign(globalThis, { feedbackChanges: changes });
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
    const feedbackChanges = () =>
      page.evaluate(() => {
        const state: unknown = globalThis;
        return typeof state === "object" && state !== null && "feedbackChanges" in state
          ? state.feedbackChanges
          : undefined;
      });

    await watchFeedback();
    await page.getByRole("button", { name: "Save channel credentials" }).click();
    const refusal = page.locator(".channel-secrets > p.status[role=alert][data-tone=danger]");
    await refusal.filter({ hasText: /\S/ }).waitFor();
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);

    await watchFeedback();
    await page.getByLabel("Slack app token", { exact: true }).selectOption(otherAppSource.id);
    // Without an outstanding grant the warning is empty, so the line is attached but not visible.
    await page
      .locator(".channel-secrets > p.status[role=alert][data-tone=warning]")
      .waitFor({ state: "attached" });
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);
  });
});
