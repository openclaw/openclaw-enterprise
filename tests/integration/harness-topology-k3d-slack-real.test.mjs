import assert from "node:assert/strict";
import { isIP } from "node:net";
import test from "node:test";
import { verifySingleSlackDelivery } from "../helpers/slack-delivery.mjs";
import { sessionEvidenceScript } from "../helpers/normal-agent-tools.mjs";
import {
  arrangeProductionTopology,
  assertDeniedConnection,
  storedSecret,
  hash,
  kubectl,
  requiresLiveSlack,
  resource,
  slackApi,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";

test(
  "production k3d gateway replies once to a real Slack message through its approved proxy and Codex Agent",
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
    const gateway = await resource("deployment", `gateway-${suffix}`, topology.gatewayPlacement);
    const agent = await resource(
      "deployment",
      `agent-${suffix}-rev-${hash(topology.revision.id)}`,
      topology.placement,
    );
    const gatewayEnvironment = gateway.spec.template.spec.containers[0].env;
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
      const source = await storedSecret(
        topology.observerPool,
        topology.agent.namespaceId,
        topology.secretApi[key === "SLACK_APP_TOKEN" ? "slackApp" : "slackBot"].id,
      );
      const { optional, ...ref } = gatewayEnvironment.find(({ name }) => name === key).valueFrom
        .secretKeyRef;
      assert.equal(source.backendRef.namespaceName, topology.gatewayPlacement);
      assert.equal(optional ?? false, false);
      assert.deepEqual(
        ref,
        { name: source.backendRef.name, key: source.backendRef.key },
        "only the owning Gateway may reference the admitted canonical channel source",
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
      topology.gatewayPlacement,
    );
    // NetworkPolicy scopes its Pod selector to the owning Kubernetes namespace.
    assert.equal(policy.metadata.namespace, topology.gatewayPlacement);
    assert.deepEqual(policy.spec.podSelector.matchLabels, {
      "openclaw.dev/network-profile": "broad-egress-v1",
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
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );

    await waitFor("a genuine authenticated Slack Socket Mode connection", async () => {
      const logs = await kubectl(
        "logs",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.gatewayPlacement,
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
    // TODO: retire this delivery caller after the protected QA matrix lane is qualified.
    // Keep the focused lane's acceptance coverage during the transition, without resends.
    await verifySingleSlackDelivery({
      slack,
      gatewayIdentity,
      senderIdentity,
      replyMode: "root",
      nativeEvidence: async (nonce) => {
        const execGateway = (...args) =>
          kubectl(
            "exec",
            topology.gatewayPod.metadata.name,
            "--namespace",
            topology.gatewayPlacement,
            "--",
            ...args,
          );
        const probe =
          "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT session_key FROM session_nodes').all().map(x=>x.session_key)));d.close()";
        const keys = JSON.parse(await execGateway("node", "-e", probe));
        const matches = [];
        for (const key of keys.filter((key) => key.includes("slack"))) {
          const proof = JSON.parse(
            await execGateway(
              "node",
              "-e",
              sessionEvidenceScript,
              key,
              nonce,
              "",
              nonce,
              JSON.stringify({ toolNames: [] }),
            ),
          );
          if (!proof.userMarkerSeen || !proof.terminalAssistantMarkerSeen) {
            continue;
          }
          const turns = (proof.codexTurns ?? []).filter(
            (turn) => turn.promptSeen && turn.terminalAssistantSeen,
          );
          if (turns.length === 0) {
            continue;
          }
          assert.equal(
            turns.length,
            1,
            "one ingress must correlate with one completed native Codex turn",
          );
          matches.push({
            sessionKey: key,
            sessionId: proof.sessionId,
            nativeTurnPrefix: turns[0].turnPrefix,
          });
        }
        assert.equal(
          matches.length,
          1,
          "the exact gateway must persist the Slack prompt and one completed native Codex response",
        );
        assert.equal(
          (await resource("pod", topology.gatewayPod.metadata.name, topology.gatewayPlacement))
            .metadata.uid,
          topology.gatewayPod.metadata.uid,
        );
        return matches[0];
      },
    });
    context.diagnostic(
      "Channel credential isolation, approved proxy, and single-message native Codex Slack delivery verified.",
    );
  },
);
