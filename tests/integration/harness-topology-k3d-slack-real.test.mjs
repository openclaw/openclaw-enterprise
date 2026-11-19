import { browserSlackSender } from "../helpers/browser-slack-sender.ts";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSlackChannelDestination,
  verifySingleSlackDelivery,
} from "../helpers/slack-delivery.ts";
import { parseGatewayObservation } from "../helpers/normal-agent-observation-receipts.ts";
import { sessionEvidenceScript } from "../helpers/normal-agent-gateway-evidence.ts";
import {
  arrangeProductionTopology,
  assertDeniedConnection,
  storedSecret,
  hash,
  kubectl,
  requiresLiveSlack,
  resource,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";
import { slackApi } from "../helpers/slack-web-api.ts";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";

// The topology registers its platform Namespace delete before the worker and port-forward stops.
// Run them newest-first, each bounded and all attempted (finding 1711).
const topologyTeardown = (testContext) =>
  boundedTeardown(testContext, { label: "production topology teardown" });

test(
  "production k3d gateway replies once to a real Slack message through its assigned Envoy listener and Codex Agent",
  { ...requiresLiveSlack, timeout: 1_800_000 },
  async (testContext) => {
    const { context } = topologyTeardown(testContext);
    for (const key of ["OCC_TEST_SLACK_CHANNEL_ID", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
      assert.ok(process.env[key], `${key} is required for explicitly requested live Slack proof.`);
    }
    const browserDirectory = process.env.OCC_TEST_SLACK_BROWSER_DIRECTORY;
    const gatewayIdentity = await slackApi("auth.test", process.env.SLACK_BOT_TOKEN);
    if (browserDirectory) {
      assert.match(process.env.OCC_TEST_SLACK_SENDER_USER_ID ?? "", /^U[A-Z0-9]+$/);
      assert.match(process.env.SLACK_TEAM_ID ?? "", /^T[A-Z0-9]+$/);
      assert.match(process.env.SLACK_APP_ID ?? "", /^A[A-Z0-9]+$/);
    } else {
      assert.ok(
        process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN,
        "An explicitly provisioned distinct sender bot is required without browser coordination.",
      );
    }
    const senderIdentity = browserDirectory
      ? { user_id: process.env.OCC_TEST_SLACK_SENDER_USER_ID, team_id: process.env.SLACK_TEAM_ID }
      : await slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN);
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
    if (!browserDirectory) {
      assert.equal(slack.senderBotToken.startsWith("xoxb-"), true);
    }
    // The browser coordinator supplies the human identity. Slack history verifies
    // that this exact person authored the one message; no sender token is invented.
    const members = [
      { role: "gateway", token: slack.botToken, userId: gatewayIdentity.user_id },
      ...(browserDirectory
        ? []
        : [{ role: "sender", token: slack.senderBotToken, userId: senderIdentity.user_id }]),
    ];
    const memberships = await Promise.allSettled(
      members.map(({ token }) =>
        slackApi("conversations.info", token, { channel: slack.channelId }),
      ),
    );
    const membershipFailures = [];
    for (const [index, result] of memberships.entries()) {
      const { role, userId } = members[index];
      let status = "unverified";
      if (result.status === "fulfilled") {
        assertSlackChannelDestination(result.value, slack.channelId);
        status = result.value.channel?.is_member === true ? "member" : "not-member";
      }
      testContext.diagnostic(
        `Slack ${role} channel membership=${status}; channel=${slack.channelId}; user=${userId}`,
      );
      if (status !== "member") {
        const reason = result.status === "rejected" ? ` ${result.reason.message}` : "";
        membershipFailures.push(
          `Slack ${role} membership=${status}.${reason} Invite bot ${userId} to channel ${slack.channelId} and ensure it can read channel information before rerunning.`,
        );
      }
    }
    assert.equal(membershipFailures.length, 0, membershipFailures.join("\n"));

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
      slack.senderBotToken
        ? JSON.stringify(topology.revision.configuration).includes(slack.senderBotToken)
        : false,
      false,
      "Agent revisions must not persist the external sender credential",
    );
    const proxyUrl = gatewayEnvironment.find(({ name }) => name === "HTTPS_PROXY")?.value;
    assert.ok(proxyUrl, "Gateway must receive its assigned Envoy listener");
    const bindingId = gateway.spec.template.metadata.labels["openclaw.dev/channel-egress-binding"];
    assert.ok(bindingId);
    const policyList = JSON.parse(
      await kubectl(
        "get",
        "networkpolicy",
        "--namespace",
        topology.gatewayPlacement,
        "--selector",
        `openclaw.dev/channel-egress-binding=${bindingId}`,
        "-o",
        "json",
      ),
    ).items;
    assert.equal(policyList.length, 1);
    const policy = policyList[0];
    assert.equal(
      policy.spec.podSelector.matchLabels["openclaw.dev/revision"],
      topology.revision.id,
    );
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/agent"], topology.agent.id);
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(
      policy.spec.podSelector.matchLabels["openclaw.dev/channel-egress-binding"],
      bindingId,
    );
    const proxyPort = Number(new URL(proxyUrl).port);
    assert.deepEqual(policy.spec.egress[0].ports, [{ protocol: "TCP", port: proxyPort }]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.gatewayPlacement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );

    // The proxy is ready, but a dedicated Codex Agent has no channel egress grant.
    // Exercise the enforcing policy rather than checking selectors alone.
    const proxyService = await resource(
      "service",
      slack.channelEgress.serviceName,
      slack.channelEgress.envoyNamespace,
    );
    await assertDeniedConnection(
      topology.placement,
      topology.harnessPod.metadata.name,
      proxyService.spec.clusterIP,
      proxyPort,
    );
    const fleet = JSON.parse(
      await kubectl(
        "get",
        "pods",
        "--namespace",
        slack.channelEgress.envoyNamespace,
        "--selector",
        `gateway.envoyproxy.io/owning-gateway-name=${slack.channelEgress.gatewayName}`,
        "-o",
        "json",
      ),
    );
    for (const token of [slack.appToken, slack.botToken, slack.senderBotToken].filter(Boolean)) {
      assert.ok(!JSON.stringify(fleet).includes(token), "Envoy must not receive Slack credentials");
    }

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
        slack.senderBotToken ? logs.includes(slack.senderBotToken) : false,
        false,
        "gateway logs must not expose the external sender's token",
      );
      return /\[?slack\]?\s+socket mode connected/i.test(logs) || undefined;
    });
    // TODO: retire this delivery caller after the protected QA matrix lane is qualified.
    // Keep the focused lane's acceptance coverage during the transition, without resends.
    const delivery = await verifySingleSlackDelivery({
      slack,
      gatewayIdentity,
      senderIdentity,
      replyMode: "root",
      ...(browserDirectory
        ? {
            sendMessage: browserSlackSender({
              directory: browserDirectory,
              workspaceId: gatewayIdentity.team_id,
              channelId: slack.channelId,
              appId: process.env.SLACK_APP_ID,
              senderUserId: senderIdentity.user_id,
            }),
          }
        : {}),
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
          const proof = parseGatewayObservation(
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
    if (process.env.OCC_TEST_SLACK_EVIDENCE_PATH) {
      await writeFile(process.env.OCC_TEST_SLACK_EVIDENCE_PATH, JSON.stringify(delivery, null, 2), {
        mode: 0o600,
      });
    }
    context.diagnostic(
      "Channel credential isolation, assigned Envoy listener, and single-message native Codex Slack delivery verified.",
    );
  },
);
