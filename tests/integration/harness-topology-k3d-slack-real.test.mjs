import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertDeniedConnection,
  channelPrefix,
  hash,
  kubectl,
  requiresLiveSlack,
  resource,
  slackApi,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";

test(
  "production k3d gateway replies to a real Slack message through its approved proxy and Codex Agent",
  { ...requiresLiveSlack, timeout: 780_000 },
  async (context) => {
    for (const key of [
      "OCC_TEST_SLACK_PROXY_URL",
      "OCC_TEST_SLACK_CHANNEL_ID",
      "OCC_TEST_SLACK_SENDER_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
    ]) {
      assert.ok(process.env[key], `${key} is required for explicitly requested live Slack proof.`);
    }
    const proxy = new URL(process.env.OCC_TEST_SLACK_PROXY_URL);
    const address = proxy.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(address);
    assert.notEqual(family, 0, "the approved channel proxy must use an exact literal IP");
    assert.notEqual(proxy.port, "", "the approved channel proxy requires an explicit port");
    const [gatewayIdentity, senderIdentity] = await Promise.all([
      slackApi("auth.test", process.env.SLACK_BOT_TOKEN),
      slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN),
    ]);
    assert.equal(
      gatewayIdentity.team_id,
      senderIdentity.team_id,
      "the gateway and Slack test sender must belong to the same workspace",
    );
    assert.notEqual(
      gatewayIdentity.user_id,
      senderIdentity.user_id,
      "Slack integration requires a distinct sender because OpenClaw rejects its own bot messages",
    );
    const slack = {
      proxyUrl: process.env.OCC_TEST_SLACK_PROXY_URL,
      allowedUserId: senderIdentity.user_id,
      channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID,
      appToken: process.env.SLACK_APP_TOKEN,
      botToken: process.env.SLACK_BOT_TOKEN,
      senderBotToken: process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN,
    };
    assert.equal(
      slack.appToken.startsWith("xapp-"),
      true,
      "Slack requires a Socket Mode app token",
    );
    assert.equal(slack.botToken.startsWith("xoxb-"), true, "Slack requires an approved bot token");
    assert.equal(
      slack.senderBotToken.startsWith("xoxb-"),
      true,
      "Slack end-to-end proof requires an approved second bot token",
    );
    const [gatewayChannel, senderChannel] = await Promise.all([
      slackApi("conversations.info", slack.botToken, { channel: slack.channelId }),
      slackApi("conversations.info", slack.senderBotToken, { channel: slack.channelId }),
    ]);
    assert.equal(gatewayChannel.channel?.is_member, true, "the gateway must join the test channel");
    assert.equal(senderChannel.channel?.is_member, true, "the sender must join the test channel");

    const topology = await arrangeProductionTopology(context, "dedicated", slack);
    assert.ok(topology.harnessPod, "channels must preserve their separate dedicated Codex Agent");
    const suffix = hash(topology.agent.id);
    const gateway = await resource("deployment", `gateway-${suffix}`, topology.placement);
    const agent = await resource(
      "deployment",
      `agent-${suffix}-rev-${hash(topology.revision.id)}`,
      topology.placement,
    );
    const gatewayEnvironment = gateway.spec.template.spec.containers[0].env;
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
      assert.deepEqual(
        gatewayEnvironment.find(({ name }) => name === key)?.valueFrom?.secretKeyRef,
        { name: `${channelPrefix}-${suffix}`, key },
        "only the owning gateway may receive operator-owned channel credential references",
      );
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
      assert.equal(
        JSON.stringify(topology.revision.configuration).includes(
          slack[key === "SLACK_APP_TOKEN" ? "appToken" : "botToken"],
        ),
        false,
      );
    }
    for (const environment of [gatewayEnvironment, agentEnvironment]) {
      assert.equal(
        environment.some(({ name }) => name === "OCC_TEST_SLACK_SENDER_BOT_TOKEN"),
        false,
        "the external sender credential must remain outside every platform workload",
      );
    }
    assert.equal(
      JSON.stringify(topology.revision.configuration).includes(slack.senderBotToken),
      false,
      "Agent revisions must not persist the external sender credential",
    );
    assert.equal(
      gatewayEnvironment.find(({ name }) => name === "HTTPS_PROXY")?.value,
      slack.proxyUrl,
    );
    const policy = await resource(
      "networkpolicy",
      `allow-gateway-channels-${suffix}`,
      topology.placement,
    );
    assert.deepEqual(policy.spec.podSelector.matchLabels, {
      "openclaw.dev/workload-role": "gateway",
      "openclaw.dev/agent": topology.agent.id,
    });
    assert.deepEqual(policy.spec.egress, [
      {
        to: [{ ipBlock: { cidr: `${address}/${family === 4 ? 32 : 128}` } }],
        ports: [{ protocol: "TCP", port: Number(proxy.port) }],
      },
    ]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );

    await waitFor("a genuine authenticated Slack Socket Mode connection", async () => {
      const logs = await kubectl(
        "logs",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.placement,
      );
      assert.equal(logs.includes(slack.appToken), false, "gateway logs must not expose app tokens");
      assert.equal(logs.includes(slack.botToken), false, "gateway logs must not expose bot tokens");
      assert.equal(
        logs.includes(slack.senderBotToken),
        false,
        "gateway logs must not expose the external sender's token",
      );
      return /\[?slack\]?\s+socket mode connected/i.test(logs) || undefined;
    });
    const baselineLogs = await kubectl(
      "logs",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
    );
    const nonce = `OCC-SLACK-${randomUUID()}`;
    const message = {
      channel: slack.channelId,
      text: `<@${gatewayIdentity.user_id}> Reply with exactly this nonce and no other text: ${nonce}`,
    };
    // A distinct explicitly allowed bot proves actual Slack ingress, Codex execution, and egress.
    const sent = await slackApi("chat.postMessage", slack.senderBotToken, message);
    let attempts = 1;
    let nextAttemptAt = Date.now() + 45_000;
    const reply = await waitFor(
      "the genuine gateway-authored Slack response from its dedicated Codex Agent",
      async () => {
        const history = await slackApi("conversations.history", slack.senderBotToken, {
          channel: slack.channelId,
          oldest: sent.ts,
          inclusive: false,
          limit: 30,
        });
        const response = history.messages?.find(
          (candidate) =>
            candidate.user === gatewayIdentity.user_id &&
            Number(candidate.ts) > Number(sent.ts) &&
            typeof candidate.text === "string" &&
            candidate.text.includes(nonce),
        );
        if (response !== undefined) {
          return response;
        }
        // Slack distributes shared-app events across connections, so an unrelated gateway can win.
        if (attempts < 3 && Date.now() >= nextAttemptAt) {
          await slackApi("chat.postMessage", slack.senderBotToken, message);
          attempts += 1;
          nextAttemptAt = Date.now() + 45_000;
        }
        await delay(2_250);
        return undefined;
      },
      240_000,
    );
    assert.equal(reply.user, gatewayIdentity.user_id);
    assert.match(reply.text, new RegExp(nonce));
    const gatewayLogs = await kubectl(
      "logs",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
    );
    const turnLogs = gatewayLogs.slice(baselineLogs.length);
    const ingress = turnLogs
      .split("\n")
      .find((line) =>
        line.includes(
          `Inbound app_mention slack:${gatewayIdentity.team_id}:channel:${slack.channelId}:user:${senderIdentity.user_id} -> bot:${gatewayIdentity.user_id}`,
        ),
      );
    if (ingress !== undefined) {
      assert.match(ingress, new RegExp(`\\((?:channel|group), ${message.text.length} chars\\)`));
    }
    assert.ok(
      turnLogs.includes(
        "codex app-server approval reviewer updated from active thread model provider",
      ),
      "this gateway must route the Slack message through its own dedicated Codex Agent",
    );
    const transcriptProbe = String.raw`
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(
        "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite",
        { readOnly: true },
      );
      const { matches } = database
        .prepare("SELECT COUNT(*) AS matches FROM transcript_events WHERE instr(event_json, ?) > 0")
        .get(${JSON.stringify(nonce)});
      process.stdout.write(String(matches));
    `;
    const transcriptMatches = Number(
      await kubectl(
        "exec",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.placement,
        "--",
        "node",
        "-e",
        transcriptProbe,
      ),
    );
    assert.ok(
      transcriptMatches >= 2,
      "this exact gateway must persist both the unique Slack prompt and its Codex Agent response",
    );
    context.diagnostic(
      `Real Slack -> gateway -> dedicated Codex -> Slack response: agent=${topology.agent.id}; channel=${slack.channelId}; sender=${slack.allowedUserId}; attempts=${attempts}; nonce=${nonce}.`,
    );
    if (process.env.OCC_TEST_SLACK_MANUAL_WAIT_SECONDS !== undefined) {
      const seconds = Number(process.env.OCC_TEST_SLACK_MANUAL_WAIT_SECONDS);
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300);
      context.diagnostic(`Keeping the real Slack gateway available for ${seconds} seconds.`);
      await delay(seconds * 1_000);
    }
  },
);
