import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { slack } from "../../apps/controller/src/console/channels/slack.mjs";

// These are form inputs, not a replacement for configuration or threading logic.
const fields = {
  "#slack-channel-ids": { value: "CEXAMPLE" },
  "#slack-allowed-user-ids": { value: "UEXAMPLE" },
  "#slack-allow-everyone": { checked: false },
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
  for (const name of ["devday", "devday-qa", "devday-oncall"]) {
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
