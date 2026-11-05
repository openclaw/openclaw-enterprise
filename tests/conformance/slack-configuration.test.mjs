import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { slack } from "../../apps/controller/src/console/channels/slack.mts";
import { missingChannelCredentialGroups } from "../../apps/controller/src/console/agents/credentials.mjs";
import {
  enabledChannelEntries,
  requireChannelSecretBindings,
} from "../../packages/occ/src/channel-secret-bindings.ts";

// These are form inputs, not a replacement for configuration or threading logic.
const fields = {
  "#slack-channel-ids": { value: "CEXAMPLE" },
  "#slack-allowed-user-ids": { value: "UEXAMPLE" },
  "#slack-channel-access": { value: "selected" },
  "#slack-require-mention": { checked: true },
  "#slack-dm-policy": { value: "", dataset: {} },
  "#slack-dm-user-ids": { value: "" },
  "#slack-enabled": { checked: true },
};
const body = { querySelector: (selector) => fields[selector] };

test("new Slack configuration defaults to threaded replies without changing existing reply policy", () => {
  const created = slack.updatedValues({}, body);
  assert.equal(created.channels.slack.replyToMode, undefined);
  assert.deepEqual(created.channels.slack.replyToModeByChatType, { channel: "all" });
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
    const updated = slack.updatedValues(values, body).channels.slack;
    // Editing an existing block must preserve even the absence of a reply setting.
    assert.equal(updated.replyToMode, policy.replyToMode);
    assert.deepEqual(updated.replyToModeByChatType, policy.replyToModeByChatType);
    assert.equal(updated.channels.CEXAMPLE.replyToMode, "off");
    assert.deepEqual(values, original);
  }
});

test("bundled Slack presets supply threaded replies", async () => {
  for (const name of ["swe-preset"]) {
    const preset = JSON.parse(
      await readFile(new URL(`../../deploy/presets/${name}.json`, import.meta.url), "utf8"),
    );
    assert.equal(preset.template.configuration.values.channels.slack.replyToMode, undefined, name);
    assert.deepEqual(
      preset.template.configuration.values.channels.slack.replyToModeByChatType,
      { channel: "all" },
      name,
    );
  }
});

test("the Slack editor steers named accounts away from the default account's token names", () => {
  const support = slack.support({ channels: { slack: { accounts: { work: {} } } } });
  assert.equal(support.supported, false);
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
  for (const [botToken, form] of [
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
  ]) {
    const support = slack.support({
      channels: { slack: { appToken: "${SLACK_APP_TOKEN}", botToken } },
    });
    assert.equal(support.supported, false, JSON.stringify(botToken));
    assert.equal(
      support.reason,
      `Slack bot token ${form}. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`,
      JSON.stringify(botToken),
    );
  }
});

test("the deploy gate requires a named Slack account's own keys, not the default account's", () => {
  const env = (id) => ({ source: "env", provider: "default", id });
  const bound = (...keys) => ({
    secretBindings: Object.fromEntries(
      keys.map((key) => [
        key,
        { source: { kind: "secret", namespaceId: "ns_1", id: `sec_${key}` } },
      ]),
    ),
  });
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
  const bound = (...keys) => ({
    secretBindings: Object.fromEntries(
      keys.map((key) => [
        key,
        { source: { kind: "secret", namespaceId: "ns_1", id: `sec_${key}` } },
      ]),
    ),
  });
  const slackWith = (slack) => ({ channels: { slack: { enabled: true, ...slack } } });
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
    botToken: { source: "env", provider: "default", id: "ACME_SLACK_BOT" },
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
  ]) {
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
// secret, user token and relay token included (finding 2554). For each shape this collects the
// names save requires from its own refusals, then leaves each one unbound, with the standard pair
// bound, and expects the gate to hold Deploy.
test("the deploy gate holds every Slack binding Configuration save requires", () => {
  const env = (id) => ({ source: "env", provider: "default", id });
  const shapes = [
    { appToken: "${SLACK_APP_TOKEN}", botToken: "${SLACK_BOT_TOKEN}" },
    {
      appToken: "${SLACK_APP_TOKEN}",
      botToken: "${SLACK_BOT_TOKEN}",
      signingSecret: "${SLACK_SIGNING_SECRET}",
      userToken: "$SLACK_USER_TOKEN",
      relay: { authToken: "${SLACK_RELAY_TOKEN:-}" },
    },
    { mode: "http", botToken: "${SLACK_BOT_TOKEN}", signingSecret: env("SLACK_SIGNING_SECRET") },
    { mode: "http", appToken: "xapp-${ACME_APP}", botToken: env("ACME_BOT") },
    { appToken: "${ACME_APP}", botToken: "${ACME_BOT}", userToken: "${ACME_USER:-x}" },
    // Outside a secret-input field, a fallback needs no binding; an env SecretRef always does.
    { botToken: "${SLACK_BOT_TOKEN}", replyToMode: "${REPLY_MODE:-all}", extra: env("ACME_EXTRA") },
    {
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
  ];
  const binding = (key) => ({ source: { kind: "secret", namespaceId: "ns_1", id: `sec_${key}` } });
  for (const shape of shapes) {
    const values = { channels: { slack: { enabled: true, ...shape } } };
    const required = new Set();
    for (;;) {
      let missing;
      try {
        requireChannelSecretBindings(
          values,
          enabledChannelEntries(values),
          (name) => required.has(name),
          (_setting, requirement) => new Error(requirement),
        );
      } catch (error) {
        missing = /^references (\S+) without a Configuration Secret binding/.exec(
          error.message,
        )?.[1];
        assert.ok(missing, error.message);
      }
      if (missing === undefined) {
        break;
      }
      required.add(missing);
    }
    assert.ok(required.size > 0, JSON.stringify(shape));
    for (const name of required) {
      const keys = [...required, "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"].filter(
        (key) => key !== name,
      );
      const configuration = {
        secretBindings: Object.fromEntries(keys.map((key) => [key, binding(key)])),
      };
      assert.notDeepEqual(
        missingChannelCredentialGroups(values, configuration),
        [],
        `${name} unbound: ${JSON.stringify(shape)}`,
      );
    }
  }
});
