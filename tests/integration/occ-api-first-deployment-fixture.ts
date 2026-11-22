import assert from "node:assert/strict";

import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  ConfigurationResponse,
  SecretResponse,
  type FirstDeploymentIntent,
} from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createAgent,
  createInjectedControllerFixture,
  createNamespace,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type FixtureRequestOptions = NonNullable<Parameters<FixtureRequest>[2]>;

export interface FirstDeploymentFixtureOptions {
  readonly ready?: boolean | undefined;
  readonly slackFetch?: ConstructorParameters<typeof SlackChannelDriver>[0] | undefined;
}

export async function prepareFixture({
  ready = true,
  slackFetch,
}: FirstDeploymentFixtureOptions = {}) {
  let providerCalls = 0;
  const channelDriver = new SlackChannelDriver(async (...args) => {
    providerCalls++;
    if (slackFetch) {
      return slackFetch(...args);
    }
    assert.fail("Guarded admission must never contact Slack");
  });
  const secretDriver = createTestSecretDriver();
  const fixture = await createInjectedControllerFixture(
    { recordOperations: true, channelDriver, secretDriver },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        return factory(backendSummaries === undefined ? options : { ...options, backendSummaries });
      },
    },
  );
  const request: FixtureRequest = (method, pathname, options) =>
    injectedRequest(fixture.app, method, pathname, options);
  const controller = { fixture, request };
  await bootstrapInstallation(controller);
  const namespace = await createNamespace(controller, "first-deployment");
  if (ready) {
    await fixture.markNamespaceReady(namespace.id);
  }
  const agent = await createAgent(controller, namespace.id, "first-deployment");
  if (ready) {
    await bindHarnessKey(fixture, namespace.id, agent);
  }
  secretDriver.calls.length = 0;
  const platformState = fixture.platformState;
  const occ = fixture.controller;
  const auditSink = fixture.auditSink;
  assert(platformState instanceof InMemoryPlatformState, "bootstrap must create in-memory state");
  assert(occ, "bootstrap must create the controller");
  assert(auditSink instanceof InMemoryAuditSink, "the fixture must use in-memory audit evidence");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const intent: FirstDeploymentIntent = {
    key: "review-1",
    expectedConfigurationId: agent.configurationId,
    expectedGeneration: 1,
  };
  return {
    controller: { fixture: { ...fixture, platformState, controller: occ, auditSink }, request },
    namespace,
    agent,
    path,
    intent,
    secretDriver,
    channelDriver,
    providerCalls: () => providerCalls,
  };
}

export async function firstDeploymentFixture(options: FirstDeploymentFixtureOptions = {}) {
  const prepared = await prepareFixture(options);
  const { controller, namespace, agent, path, intent } = prepared;
  const recover = (
    body: FirstDeploymentIntent = intent,
    requestOptions: FixtureRequestOptions = {},
  ) =>
    controller.request(
      "GET",
      `${path}/deploy-first/${body.key}/${body.expectedConfigurationId}/${body.expectedGeneration}`,
      requestOptions,
    );
  const listRevisions = () =>
    controller.fixture.platformState.read((state) =>
      state.revisions.listRevisions(namespace.id, agent.id),
    );
  const listRevisionMetadata = () =>
    controller.fixture.platformState.read((state) =>
      state.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
  const work = () =>
    controller.fixture.platformState
      .pendingOperations()
      .filter((entry) => entry.kind === "agent_revision");
  return { ...prepared, recover, listRevisions, listRevisionMetadata, work };
}

export async function slackFirstDeploymentFixture(
  enabled = true,
  beforeResponse: () => Promise<void> = async () => {},
) {
  const fixture = await firstDeploymentFixture({
    slackFetch: async (url, options) => {
      assert.equal(new URL(String(url)).href, "https://slack.com/api/auth.test");
      assert.equal(options?.method, "POST");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer xoxb-synthetic-bot");
      await beforeResponse();
      return Response.json({ ok: true, bot_id: "B123", team_id: "T123" });
    },
  });
  const { controller, namespace, agent } = fixture;
  const bot = checkedInjectedBody(
    await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: "slack-bot", value: "xoxb-synthetic-bot" },
    }),
    201,
    SecretResponse,
  ).data;
  const harnessGrant = controller.fixture.state.bindings.find(
    (binding) => binding.id === `harness-key-${agent.id}`,
  );
  assert(harnessGrant, "the Agent must have its harness Secret grant");
  controller.fixture.state.bindings.push({
    ...harnessGrant,
    id: `slack-bot-${agent.id}`,
    resourceId: bot.id,
  });
  const updated = checkedInjectedBody(
    await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      {
        body: {
          values: {
            channels: { slack: { enabled, mode: "http", botToken: "${SLACK_BOT_TOKEN}" } },
          },
          secretBindings: { SLACK_BOT_TOKEN: { source: bot.ref } },
        },
      },
    ),
    200,
    ConfigurationResponse,
  ).data;
  fixture.secretDriver.calls.length = 0;
  return {
    ...fixture,
    bot,
    intent: { ...fixture.intent, expectedGeneration: updated.generation },
  };
}
