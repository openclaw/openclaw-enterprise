import { writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
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
  assertActualModelTurn,
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
    for (const key of [
      "OCC_TEST_SLACK_CHANNEL_ID",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "OCC_TEST_SLACK_SENDER_BOT_TOKEN",
    ]) {
      assert.ok(process.env[key], `${key} is required for explicitly requested live Slack proof.`);
    }
    const gatewayIdentity = await slackApi("auth.test", process.env.SLACK_BOT_TOKEN);
    const senderIdentity = await slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN);
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
    assert.equal(slack.senderBotToken.startsWith("xoxb-"), true);
    const members = [
      { role: "gateway", token: slack.botToken, userId: gatewayIdentity.user_id },
      { role: "sender", token: slack.senderBotToken, userId: senderIdentity.user_id },
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
    // Deployment already validated the saved Slack credentials through OCC's
    // listener. Exercise both directory operations through their real API owner.
    for (const [kind, id] of [
      ["channels", slack.channelId],
      ["users", senderIdentity.user_id],
    ]) {
      const directory = await topology.adminRequest(
        "POST",
        `/namespaces/${topology.agent.namespaceId}/channel-directory/lookup`,
        {
          agentId: topology.agent.id,
          secretId: topology.secretApi.slackBot.id,
          kind,
          ids: [id],
        },
      );
      assert.equal(directory.status, 200, "OCC directory must use its restricted Envoy listener");
      assert.equal(directory.data.workspaceId, gatewayIdentity.team_id);
      assert.ok(directory.data.candidates.some((candidate) => candidate.id === id));
    }
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
    // Remove the actual forwarding Pods while retaining their recoverable fleet
    // identity. OCC must remain usable and reject activation before admitting a
    // revision; the existing Gateway must not gain direct provider access.
    const revisionsPath = `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`;
    const beforeFailure = await topology.adminRequest("GET", revisionsPath);
    const scaleEgress = (replicas) =>
      kubectl(
        "patch",
        "envoyproxy",
        slack.channelEgress.gatewayName,
        "--namespace",
        topology.platformNamespace,
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { provider: { kubernetes: { envoyDeployment: { replicas } } } } }),
      );
    const egressPods = async () =>
      JSON.parse(
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
      ).items;
    try {
      await scaleEgress(0);
      await waitFor("the task egress fleet to stop", async () => (await egressPods()).length === 0);
      assert.equal((await topology.adminRequest("GET", "/installation")).status, 200);
      await assertActualModelTurn({ ...topology, harnessId: "codex" });
      const refused = await topology.adminRequest(
        "POST",
        `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
      );
      assert.equal(refused.status, 503);
      assert.equal(refused.error.code, "CHANNEL_CREDENTIAL_UNAVAILABLE");
      assert.deepEqual(
        (await topology.adminRequest("GET", revisionsPath)).data,
        beforeFailure.data,
      );
      await assertDeniedConnection(
        topology.gatewayPlacement,
        topology.gatewayPod.metadata.name,
        (await lookup("slack.com", { family: 4 })).address,
        443,
      );
    } finally {
      await scaleEgress(1);
      await waitFor("the task egress fleet to recover", async () => {
        const pods = await egressPods();
        return (
          pods.length > 0 &&
          pods.every((pod) =>
            pod.status.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
          )
        );
      });
    }
    const recovered = await topology.adminRequest(
      "POST",
      `/namespaces/${topology.agent.namespaceId}/channel-directory/lookup`,
      {
        agentId: topology.agent.id,
        secretId: topology.secretApi.slackBot.id,
        kind: "users",
        ids: [senderIdentity.user_id],
      },
    );
    assert.equal(
      recovered.status,
      200,
      "OCC provider access must recover through its restored listener",
    );
    context.diagnostic(
      "Channel credential isolation, assigned Envoy listener, and single-message native Codex Slack delivery verified.",
    );
  },
);
