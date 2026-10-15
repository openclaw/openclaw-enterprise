import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { slack } from "../../apps/controller/src/console/channels/slack.mjs";
import { missingChannelCredentialGroups } from "../../apps/controller/src/console/agents/credentials.mjs";

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
