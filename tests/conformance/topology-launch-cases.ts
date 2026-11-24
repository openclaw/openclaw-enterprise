import assert from "node:assert/strict";
import test from "node:test";
import {
  renderPresetTemplate,
  type SecretBindings,
  type SecretReference,
} from "../../packages/contracts/src/index.ts";
import {
  createNativeTopologyConfiguration,
  createTopologyPresetTemplate,
} from "../helpers/topology-launch-configuration.ts";

const providerModel = "example-model";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const modelSecret: SecretReference = {
  kind: "secret",
  namespaceId,
  id: "sec_00000000-0000-4000-8000-000000000001",
};
const selectedSecretId = "sec_00000000-0000-4000-8000-000000000002";

export function registerTopologyLaunchCases(): void {
  test("embedded OpenClaw Preset clones native values and omits empty bindings", () => {
    const launchValues = createNativeTopologyConfiguration("openclaw", providerModel);
    const modelReference = "openai/example-model";
    const { defaults } = launchValues.agents;
    const model = defaults.models[modelReference];
    assert.equal(defaults.model, modelReference);
    assert.deepEqual(model, { agentRuntime: { id: "openclaw" } });

    const expectedValues = structuredClone(launchValues);
    const template = createTopologyPresetTemplate(launchValues, "embedded", modelSecret, {});
    assert.deepEqual(launchValues, expectedValues);
    assert.equal(Object.hasOwn(template.configuration, "secretBindings"), false);

    assert.ok(model !== null && typeof model === "object");
    Object.assign(model, { agentRuntime: { id: "changed-after-template-creation" } });

    const name = "embedded-openclaw";
    const rendered = renderPresetTemplate(template, { name, secretId: selectedSecretId });
    assert.deepEqual(rendered.agent, {
      name,
      executionMode: "embedded",
      harnessAuth: { method: "api_key", source: { ...modelSecret, id: selectedSecretId } },
    });
    assert.deepEqual(rendered.configuration?.values, expectedValues);
  });

  test("dedicated Codex Slack Preset renders native channel policy and populated bindings", () => {
    const allowedUserId = "U0000000001";
    const channelId = "C0000000001";
    const launchValues = createNativeTopologyConfiguration("codex", providerModel, {
      allowedUserId,
      channelId,
    });
    assert.ok("channels" in launchValues);
    const { channels } = launchValues;
    assert.equal(launchValues.agents.defaults.model, "codex/example-model");
    assert.deepEqual(channels, {
      slack: {
        enabled: true,
        mode: "socket",
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        dmPolicy: "allowlist",
        allowFrom: [allowedUserId],
        channels: {
          [channelId]: {
            requireMention: true,
            allowBots: "mentions",
            users: [allowedUserId],
            replyToMode: "off",
          },
        },
      },
    });

    const secretBindings: SecretBindings = {
      SLACK_APP_TOKEN: {
        source: { ...modelSecret, id: "sec_00000000-0000-4000-8000-000000000003" },
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: { ...modelSecret, id: "sec_00000000-0000-4000-8000-000000000004" },
        delivery: { type: "env" },
      },
    };
    const template = createTopologyPresetTemplate(
      launchValues,
      "dedicated",
      modelSecret,
      secretBindings,
    );
    const rendered = renderPresetTemplate(template, {
      name: "dedicated-codex-slack",
      secretId: selectedSecretId,
    });
    assert.equal(rendered.agent?.["executionMode"], "dedicated");
    assert.deepEqual(rendered.configuration?.values, launchValues);
    assert.deepEqual(rendered.configuration?.secretBindings, secretBindings);
  });
}
