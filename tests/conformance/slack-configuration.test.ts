import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SecretBinding,
} from "../../packages/contracts/src/index.ts";
import { isRecord } from "../../apps/controller/src/console/channels/shared-ui.mts";
import { slack } from "../../apps/controller/src/console/channels/slack.mts";
import { missingChannelCredentialGroups } from "../../apps/controller/src/console/agents/credentials.mjs";
import {
  enabledChannelEntries,
  requireChannelSecretBindings,
} from "../../packages/occ/src/channel-secret-bindings.ts";
import { admitGatewaySecurityDefaults } from "../../packages/occ/src/gateway-security-defaults.ts";

// These are form inputs, not a replacement for configuration or threading logic.
const fields = {
  "#slack-channel-ids": { value: "CEXAMPLE" },
  "#slack-allowed-user-ids": { value: "UEXAMPLE" },
  "#slack-channel-access": { value: "selected" },
  "#slack-require-mention": { checked: true },
  "#slack-dm-policy": { value: "" },
  "#slack-dm-user-ids": { value: "" },
  "#slack-enabled": { checked: true },
};
const form = {
  querySelector(selector: string) {
    assert.ok(Object.hasOwn(fields, selector), `unexpected Slack form selector: ${selector}`);
    return fields[selector as keyof typeof fields];
  },
};
// This adapter supplies only the controls read by updatedValues. Browser tests exercise the DOM.
const body = form as unknown as HTMLFormElement;

function configurationRecord(value: unknown, setting: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${setting} must be an object`);
  return value;
}

function slackConfig(values: unknown): Record<string, unknown> {
  const channels = configurationRecord(configurationRecord(values, "values").channels, "channels");
  return configurationRecord(channels.slack, "channels.slack");
}

function env(id: string) {
  return { source: "env", provider: "default", id };
}

function bound(...keys: string[]) {
  return {
    secretBindings: Object.fromEntries(
      keys.map((key): [string, SecretBinding] => [
        key,
        { source: { kind: "secret", namespaceId: "ns_1", id: `sec_${key}` } },
      ]),
    ),
  };
}

test("new Slack configuration defaults to threaded replies without changing existing reply policy", () => {
  const created = slackConfig(slack.updatedValues({}, body));
  assert.equal(created.replyToMode, undefined);
  assert.deepEqual(created.replyToModeByChatType, { channel: "all" });
  for (const policy of [
    {},
    { replyToMode: "off" },
    { replyToMode: "first" },
    { replyToMode: "all", replyToModeByChatType: { direct: "off", channel: "off" } },
  ]) {
    const values = {
      channels: {
        slack: {
          ...policy,
          channels: {
            CEXAMPLE: { replyToMode: "off", requireMention: false },
          },
        },
      },
    };
    const original = structuredClone(values);
    const updated = slackConfig(slack.updatedValues(values, body));
    // Editing an existing block must preserve even the absence of a reply setting.
    assert.equal(updated.replyToMode, policy.replyToMode);
    assert.deepEqual(updated.replyToModeByChatType, policy.replyToModeByChatType);
    const channels = configurationRecord(updated.channels, "channels.slack.channels");
    assert.equal(configurationRecord(channels.CEXAMPLE, "CEXAMPLE").replyToMode, "off");
    assert.deepEqual(values, original);
  }
});

test("bundled Slack presets supply threaded replies", async () => {
  const preset: unknown = JSON.parse(
    await readFile(new URL("../../deploy/presets/swe-preset.json", import.meta.url), "utf8"),
  );
  const template = configurationRecord(configurationRecord(preset, "preset").template, "template");
  const configuration = configurationRecord(template.configuration, "template.configuration");
  const bundled = slackConfig(configuration.values);
  assert.equal(bundled.replyToMode, undefined);
  assert.deepEqual(bundled.replyToModeByChatType, { channel: "all" });
});

test("the Slack editor steers named accounts away from the default account's token names", () => {
  const support = slack.support({ channels: { slack: { accounts: { work: {} } } } });
  assert.ok(support.supported === false);
  // OpenClaw starts an implicit default account from SLACK_APP_TOKEN/SLACK_BOT_TOKEN.
  assert.match(
    support.reason,
    /own token environment names, not SLACK_APP_TOKEN or SLACK_BOT_TOKEN/,
  );
});

// The card names a token it cannot edit as Configuration save names it (finding 2530): a string is
// a reference only in a form the runtime reads, or with a `${` it keeps as written; an object with
// no source is the object save refuses; every other value holds the credential inline.
test("the Slack editor names a bot token it cannot edit the way Configuration save does", () => {
  const inline = "holds a credential value inline, where a reference is required";
  const reference = "uses a credential reference this editor does not write";
  const tokens: readonly (readonly [token: unknown, diagnostic: string])[] = [
    ["xoxb-pasted", inline],
    // A `$` before a name the runtime does not read, an escape, and blank text are no reference.
    ["$xoxbSECRET", inline],
    ["$${SLACK_BOT_TOKEN}", inline],
    ["", inline],
    ["   ", inline],
    [["xoxb-pasted"], inline],
    ["$SLACK_SPARE_TOKEN", reference],
    ["xoxb-${SLACK_BOT_TOKEN}", reference],
    ["${SLACK_BOT_TOKEN:-xoxb-fallback}", reference],
    ["${slack_bot_token}", reference],
    [{ source: "file", provider: "default", id: "/slack/bot" }, reference],
    [{ value: "xoxb-pasted" }, "holds an object the Slack Channel Driver cannot read"],
  ];
  for (const [botToken, form] of tokens) {
    const support = slack.support({
      channels: { slack: { appToken: "${SLACK_APP_TOKEN}", botToken } },
    });
    assert.ok(support.supported === false, JSON.stringify(botToken));
    assert.equal(
      support.reason,
      `Slack bot token ${form}. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`,
      JSON.stringify(botToken),
    );
  }
});

test("the deploy gate requires a named Slack account's own keys, not the default account's", () => {
  const named = {
    channels: {
      slack: {
        enabled: true,
        accounts: {
          work: { appToken: env("SLACK_WORK_APP_TOKEN"), botToken: env("SLACK_WORK_BOT_TOKEN") },
        },
      },
    },
  };
  assert.deepEqual(
    missingChannelCredentialGroups(named, bound("SLACK_WORK_APP_TOKEN", "SLACK_WORK_BOT_TOKEN")),
    [],
  );
  assert.deepEqual(missingChannelCredentialGroups(named, bound("SLACK_WORK_APP_TOKEN")), [
    "Slack Secret bindings (SLACK_WORK_BOT_TOKEN)",
  ]);
  // The default account keeps its fixed keys.
  const standard = { channels: { slack: { enabled: true } } };
  assert.deepEqual(missingChannelCredentialGroups(standard, bound("SLACK_WORK_APP_TOKEN")), [
    "Slack Secret bindings",
  ]);
  assert.deepEqual(
    missingChannelCredentialGroups(standard, bound("SLACK_APP_TOKEN", "SLACK_BOT_TOKEN")),
    [],
  );
});

// With no named accounts, the gate lists the keys the default account's tokens name, as
// Configuration save and the Slack Channel Driver read them, and no app token in HTTP mode. It
// asked for SLACK_APP_TOKEN and SLACK_BOT_TOKEN instead and held Deploy for a Configuration OCC
// deploys (finding 2526).
test("the deploy gate requires the keys the default Slack account's tokens name", () => {
  const slackWith = (slack: OpenClawConfigurationDocument) => ({
    channels: { slack: { enabled: true, ...slack } },
  });
  const acme = slackWith({ appToken: "${ACME_SLACK_APP}", botToken: "${ACME_SLACK_BOT}" });
  assert.deepEqual(
    missingChannelCredentialGroups(acme, bound("ACME_SLACK_APP", "ACME_SLACK_BOT")),
    [],
  );
  // The standard names do not stand in for the keys the tokens name.
  assert.deepEqual(
    missingChannelCredentialGroups(
      acme,
      bound("SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "ACME_SLACK_APP"),
    ),
    ["Slack Secret bindings (ACME_SLACK_BOT)"],
  );
  // An env SecretRef names its key too; a token with no key keeps the standard name.
  const mixed = slackWith({
    botToken: env("ACME_SLACK_BOT"),
  });
  assert.deepEqual(missingChannelCredentialGroups(mixed, bound("ACME_SLACK_BOT")), [
    "Slack Secret bindings (SLACK_APP_TOKEN)",
  ]);
  // HTTP mode reads no app token.
  const http = slackWith({
    mode: "http",
    botToken: "${SLACK_BOT_TOKEN}",
    signingSecret: "${SLACK_SIGNING_SECRET}",
  });
  assert.deepEqual(
    missingChannelCredentialGroups(http, bound("SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET")),
    [],
  );
  assert.deepEqual(missingChannelCredentialGroups(http, bound("SLACK_SIGNING_SECRET")), [
    "Slack Secret bindings (SLACK_BOT_TOKEN)",
  ]);
  // Save still requires a binding for each name an app token HTTP mode keeps references, written
  // whole or not, so the gate lists it (finding 2541).
  for (const [appToken, key] of [
    ["${ACME_SLACK_APP}", "ACME_SLACK_APP"],
    ["${ACME_SLACK_APP:-x}", "ACME_SLACK_APP"],
    ["xapp-${ACME_SLACK_APP}", "ACME_SLACK_APP"],
    ["$ACME_SLACK_APP", "ACME_SLACK_APP"],
    ["$SLACK_APP_TOKEN", "SLACK_APP_TOKEN"],
  ] as const) {
    const httpWithApp = slackWith({ mode: "http", appToken, botToken: "${SLACK_BOT_TOKEN}" });
    assert.notDeepEqual(missingChannelCredentialGroups(httpWithApp, bound("SLACK_BOT_TOKEN")), []);
    assert.deepEqual(
      missingChannelCredentialGroups(httpWithApp, bound("SLACK_BOT_TOKEN", key)),
      [],
    );
  }
  // Every name in the app token, not just the first.
  const twoNames = slackWith({
    mode: "http",
    appToken: "${ACME_SLACK_A}${ACME_SLACK_B}",
    botToken: "${SLACK_BOT_TOKEN}",
  });
  assert.deepEqual(
    missingChannelCredentialGroups(twoNames, bound("SLACK_BOT_TOKEN", "ACME_SLACK_A")),
    ["Slack Secret bindings (ACME_SLACK_B)"],
  );
});

// Deploy delivers what Configuration save and deployment admission accept, so the gate must never
// wait for fewer bindings than they require: every name the Slack settings reference, the signing
// secret, user token and relay token included (finding 2554). Record the keys save looks up, then
// leave each one unbound while providing every other binding and check the Deploy diagnostic.
test("the deploy gate holds every Slack binding Configuration save requires", () => {
  const cases: readonly {
    shape: OpenClawConfigurationDocument;
    keys: readonly string[];
    formKeys?: readonly string[];
  }[] = [
    {
      shape: { appToken: "${SLACK_APP_TOKEN}", botToken: "${SLACK_BOT_TOKEN}" },
      keys: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      formKeys: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    },
    {
      shape: {
        appToken: "${SLACK_APP_TOKEN}",
        botToken: "${SLACK_BOT_TOKEN}",
        signingSecret: "${SLACK_SIGNING_SECRET}",
        userToken: "$SLACK_USER_TOKEN",
        relay: { authToken: "${SLACK_RELAY_TOKEN:-}" },
      },
      keys: [
        "SLACK_APP_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
        "SLACK_USER_TOKEN",
        "SLACK_RELAY_TOKEN",
      ],
      formKeys: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    },
    {
      shape: {
        mode: "http",
        botToken: "${SLACK_BOT_TOKEN}",
        signingSecret: env("SLACK_SIGNING_SECRET"),
      },
      keys: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    },
    {
      shape: { mode: "http", appToken: "xapp-${ACME_APP}", botToken: env("ACME_BOT") },
      keys: ["ACME_APP", "ACME_BOT"],
    },
    {
      shape: { appToken: "${ACME_APP}", botToken: "${ACME_BOT}", userToken: "${ACME_USER:-x}" },
      keys: ["ACME_APP", "ACME_BOT", "ACME_USER"],
    },
    {
      // Outside a secret-input field, a fallback needs no binding; an env SecretRef always does.
      shape: {
        botToken: "${SLACK_BOT_TOKEN}",
        replyToMode: "${REPLY_MODE:-all}",
        extra: env("ACME_EXTRA"),
      },
      keys: ["SLACK_BOT_TOKEN", "ACME_EXTRA"],
      formKeys: ["SLACK_BOT_TOKEN"],
    },
    {
      shape: {
        accounts: {
          work: {
            appToken: "${WORK_APP}",
            botToken: env("WORK_BOT"),
            signingSecret: "$WORK_SIGNING",
            relay: { authToken: "${WORK_RELAY}" },
          },
          off: { enabled: false, appToken: "${OFF_APP}", botToken: "${OFF_BOT}" },
        },
      },
      keys: ["WORK_APP", "WORK_BOT", "WORK_SIGNING", "WORK_RELAY", "OFF_APP", "OFF_BOT"],
    },
  ];
  for (const { shape, keys, formKeys = [] } of cases) {
    const values = { channels: { slack: { enabled: true, ...shape } } };
    const visited = new Set<string>();
    requireChannelSecretBindings(
      values,
      enabledChannelEntries(values),
      (name) => {
        visited.add(name);
        return true;
      },
      (_setting, requirement) => new Error(requirement),
    );
    assert.deepEqual(visited, new Set(keys), JSON.stringify(shape));
    const available = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", ...keys];
    assert.deepEqual(missingChannelCredentialGroups(values, bound(...available)), []);
    for (const name of keys) {
      assert.deepEqual(
        missingChannelCredentialGroups(values, bound(...available.filter((key) => key !== name))),
        [formKeys.includes(name) ? "Slack Secret bindings" : `Slack Secret bindings (${name})`],
        `${name} unbound: ${JSON.stringify(shape)}`,
      );
    }
  }
});

// gateway-security-defaults.ts repeats the enabled-channel rule so it can stay import-free
// (finding 3191). The session.dmScope fill must follow exactly the channels that start a
// channel runtime and need Secret bindings.
test("the session.dmScope fill follows enabledChannelEntries", () => {
  const channelCases: readonly (OpenClawConfigurationValue | undefined)[] = [
    undefined,
    {},
    [],
    null,
    { defaults: {} },
    { modelByChannel: {} },
    { slack: {} },
    { slack: { enabled: false } },
    { slack: { enabled: "false" } },
    { slack: true },
    { slack: null },
    { defaults: {}, slack: { enabled: false }, msteams: {} },
  ];
  for (const channels of channelCases) {
    const values: OpenClawConfigurationDocument = channels === undefined ? {} : { channels };
    const admitted = admitGatewaySecurityDefaults(values).session;
    assert.equal(
      isRecord(admitted) && admitted.dmScope !== undefined,
      enabledChannelEntries(values).length > 0,
      JSON.stringify(channels),
    );
  }
});
