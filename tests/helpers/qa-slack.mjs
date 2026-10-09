import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadYaml, dumpYaml, waitFor, yamlDocuments } from "./qa-utils.mjs";
import { protectedText, grantQaSecret } from "./qa-secrets.mjs";
import { slackApi } from "./harness-topology-k3d-real.mjs";
import { allMessages, verifySingleSlackDelivery } from "./slack-delivery.mjs";
import { sessionEvidenceScript } from "./normal-agent-tools.mjs";

export async function prepareQaSlack(f) {
  const configuration = f.configuration.drivers.compute.configuration;
  if (f.controlPlane === "compose") {
    const path = join(f.stateDirectory, "compose.yaml");
    const compose = loadYaml(await readFile(path, "utf8"));
    compose.services["slack-proxy"] = {
      image: f.controllerDockerImage,
      entrypoint: ["node", "apps/controller/src/slack-proxy.mjs"],
      environment: { NODE_ENV: "production", OCC_SLACK_PROXY_PORT: "3128" },
      networks: { development: {} },
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "128m",
    };
    await writeFile(path, dumpYaml(compose), { mode: 0o600 });
    await f.compose("up", "-d", "--no-deps", "slack-proxy");
    const id = (await f.compose("ps", "-q", "slack-proxy")).trim();
    const ip = JSON.parse(await f.run("docker", ["inspect", id]))[0].NetworkSettings.Networks[
      `${f.cluster}_development`
    ].IPAddress;
    const proxyUrl = `http://${ip}:3128`;
    configuration.runtime.channels = { proxyUrl };
    compose.services.controller.environment.OCC_CHANNEL_DIRECTORY_PROXY_URL = proxyUrl;
    await writeFile(path, dumpYaml(compose), { mode: 0o600 });
  } else {
    const hostname = `openclaw-enterprise-slack-proxy.${f.state.platformNamespace}.svc`;
    configuration.runtime.channels = {
      proxyUrl: `http://${hostname}:3128`,
      managedProxy: {
        hostname,
        namespace: f.state.platformNamespace,
        podLabels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": "openclaw-enterprise",
          "app.kubernetes.io/component": "slack-proxy",
        },
        port: 3128,
      },
    };
    const path = join(f.stateDirectory, "helm-values.json");
    const values = JSON.parse(await readFile(path, "utf8"));
    values.slackProxy = { enabled: true };
    await writeFile(path, JSON.stringify(values), { mode: 0o600 });
    const manifests = await f.run("helm", [
      "template",
      "openclaw-enterprise",
      "deploy/helm/openclaw-enterprise",
      "-n",
      f.state.platformNamespace,
      "-f",
      path,
    ]);
    const selected = yamlDocuments(manifests)
      .filter((doc) => {
        const object = loadYaml(doc);
        return (
          object?.metadata?.name?.includes("slack-proxy") ||
          (["Deployment", "NetworkPolicy"].includes(object?.kind) &&
            object?.metadata?.name === "openclaw-enterprise-api")
        );
      })
      .join("\n---\n");
    await f.kubectl(
      "-n",
      f.state.platformNamespace,
      "apply",
      "-f",
      await f.write("slack-resources.yaml", selected),
    );
  }
  await f.saveInstallation(f.configuration);
}

export async function verifyQaSlack(f, agent) {
  assert.equal(agent.preset, "Codex", "embedded OpenClaw Slack is not supported");
  const slack = {
    appToken: await protectedText(process.env.OCC_TEST_QA_SLACK_APP_TOKEN_FILE, "Slack app token"),
    botToken: await protectedText(
      process.env.OCC_TEST_QA_SLACK_BOT_TOKEN_FILE,
      "Slack gateway bot token",
    ),
    senderBotToken: await protectedText(
      process.env.OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE,
      "distinct Slack sender",
    ),
    channelId: process.env.OCC_TEST_QA_SLACK_CHANNEL_ID,
  };
  assert.match(slack.channelId ?? "", /^[CG][A-Z0-9]+$/);
  const gatewayIdentity = await slackApi("auth.test", slack.botToken);
  const senderIdentity = await slackApi("auth.test", slack.senderBotToken);
  assert.notEqual(gatewayIdentity.user_id, senderIdentity.user_id);
  assert.equal(gatewayIdentity.team_id, senderIdentity.team_id);
  for (const token of [slack.botToken, slack.senderBotToken]) {
    assert.equal(
      (await slackApi("conversations.info", token, { channel: slack.channelId })).channel.is_member,
      true,
    );
  }
  await prepareQaSlack(f);
  const base = `/namespaces/${agent.namespaceId}`;
  const configuration = await f.api("GET", `${base}/configurations/${agent.configurationId}`);
  const bindings = { ...configuration.secretBindings };
  for (const [name, value] of [
    ["SLACK_APP_TOKEN", slack.appToken],
    ["SLACK_BOT_TOKEN", slack.botToken],
  ]) {
    const secret = await f.api("POST", `${base}/secrets`, {
      name: `${agent.name}-${name.toLowerCase()}`,
      value,
    });
    await grantQaSecret(f, agent, secret.id, `${agent.name}-${name.toLowerCase()}`);
    bindings[name] = {
      source: { kind: "secret", namespaceId: agent.namespaceId, id: secret.id },
      delivery: { type: "env" },
    };
  }
  const values = configuration.values;
  values.plugins.allow = [...new Set([...(values.plugins.allow ?? []), "slack"])];
  values.plugins.entries.slack = { enabled: true };
  values.channels = {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
      channels: {
        [slack.channelId]: {
          requireMention: true,
          allowBots: "mentions",
          users: [senderIdentity.user_id],
          replyToMode: "all",
        },
      },
    },
  };
  await f.api("PATCH", `${base}/configurations/${configuration.id}`, {
    values,
    secretBindings: bindings,
  });
  await f.deployAndWait(agent);
  const gateway = await f.pod(agent, "gateway");
  const logs = () =>
    f.kubectl("-n", gateway.metadata.namespace, "logs", gateway.metadata.name, "-c", "gateway");
  await waitFor("Slack Socket Mode authentication", async () =>
    /\[?slack\]?\s+socket mode connected/i.test(await logs()),
  );
  const nativeEvidence = async (nonce) => {
    // Locate the actual Slack-created session, then use the common decompressed
    // transcript observer to verify the same Codex prompt/assistant turn.
    const probe =
      "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT session_key FROM session_nodes').all().map(x=>x.session_key)));d.close()";
    const keys = JSON.parse((await f.execRole(agent, "gateway", ["node", "-e", probe])).stdout);
    const matches = [];
    for (const key of keys.filter((key) => key.includes("slack"))) {
      const proof = JSON.parse(
        (
          await f.execRole(agent, "gateway", [
            "node",
            "-e",
            sessionEvidenceScript,
            key,
            nonce,
            "",
            nonce,
            JSON.stringify({ toolNames: [] }),
          ])
        ).stdout,
      );
      if (
        proof.userMarkerSeen &&
        proof.terminalAssistantMarkerSeen &&
        proof.codexTurns?.some((t) => t.promptSeen && t.terminalAssistantSeen)
      ) {
        const turns = proof.codexTurns.filter(
          (turn) => turn.promptSeen && turn.terminalAssistantSeen,
        );
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
    }
    assert.equal(
      matches.length,
      1,
      "one exact native Codex session must contain the ingress and terminal answer",
    );
    assert.equal((await f.pod(agent, "gateway")).metadata.uid, gateway.metadata.uid);
    return {
      ...matches[0],
      agentId: agent.id,
      revisionId: agent.revision.id,
      podUid: gateway.metadata.uid,
    };
  };
  try {
    const evidence = await verifySingleSlackDelivery({
      slack,
      gatewayIdentity,
      senderIdentity,
      nativeEvidence,
    });
    await f.record("Codex-slack", evidence);
    await verifyNativeSlackRoot(f, agent, slack, gatewayIdentity);
  } finally {
    // Stop this Socket Mode consumer before the next installation can connect.
    values.channels.slack.enabled = false;
    await f.api("PATCH", `${base}/configurations/${configuration.id}`, {
      values,
      secretBindings: bindings,
    });
    await f.deployAndWait(agent);
  }
}

async function verifyNativeSlackRoot(f, agent, slack, identity) {
  const marker = `QA_SLACK_ROOT_${randomUUID()}`;
  const sessionKey = `agent:main:qa-slack-root-${randomUUID()}`;
  const oldest = String(Date.now() / 1000);
  // This is a separate outbound-tool task, not another Slack ingress or retry.
  // Exactly one external initial message was submitted by the ingress proof.
  await agent.native.normalGatewayTurn({
    agent,
    sessionKey,
    prompt: `Use the native Slack message tool with accountId default to send exactly ONE new top-level message to channel ${slack.channelId}. Its complete text must be ${marker}. Do not send progress messages or a thread reply. Do not use shell commands, direct HTTP, another credential, or another channel. Do not retry a failed or uncertain send. After the tool completes, include ${marker} in your final answer.`,
    expectedPatterns: [marker],
    secrets: [slack.appToken, slack.botToken, slack.senderBotToken],
  });
  let reply;
  let firstSeen;
  const deadline = Date.now() + 180_000;
  while (Date.now() < (firstSeen ? firstSeen + 60_000 : deadline)) {
    const messages = await allMessages("conversations.history", slack.senderBotToken, {
      channel: slack.channelId,
      oldest,
    });
    const matching = messages.filter((message) => message.text?.includes(marker));
    assert.ok(matching.length <= 1, "native outbound root must not be duplicated");
    if (matching.length) {
      reply = matching[0];
      assert.equal(reply.user, identity.user_id);
      assert.equal(reply.bot_id, identity.bot_id);
      assert.equal(reply.text.trim(), marker);
      assert.ok(reply.thread_ts === undefined || reply.thread_ts === reply.ts);
      firstSeen ??= Date.now();
    }
    await delay(4_000);
  }
  assert.ok(reply, "native message tool must create its intended root message");
  const read = async (tools, pattern) =>
    JSON.parse(
      (
        await f.execRole(agent, "gateway", [
          "node",
          "-e",
          sessionEvidenceScript,
          sessionKey,
          marker,
          "",
          pattern,
          JSON.stringify({ toolNames: tools }),
        ])
      ).stdout,
    );
  const discovered = await read([], reply.ts);
  const names = discovered.diagnostics.observedToolNames.filter((name) =>
    /(?:^|[_.])message$/.test(name),
  );
  assert.equal(names.length, 1, "root send must use the native message tool");
  const evidence = await read(names, reply.ts);
  assert.equal(evidence.calls.length, 1, "native root send must be attempted only once");
  const call = evidence.calls[0];
  const result = evidence.results.find((value) => value.toolCallId === call.id);
  assert.ok(
    result && !result.isError && result.matchesResult && result.seq > call.seq,
    "native successful send result must name the independently observed timestamp",
  );
  assert.ok(call.mirrorIdentity?.endsWith(":call"));
  assert.equal(result.mirrorIdentity, call.mirrorIdentity.slice(0, -5) + ":result");
  const prefix = call.mirrorIdentity.slice(0, call.mirrorIdentity.lastIndexOf(":tool:"));
  assert.ok(prefix);
  assert.ok(
    evidence.codexTurns.some(
      (turn) => turn.turnPrefix === prefix && turn.promptSeen && turn.terminalAssistantSeen,
    ),
  );
  await f.record("Codex-slack-outbound-root", {
    agentId: agent.id,
    revisionId: agent.revision.id,
    sessionKey,
    channel: slack.channelId,
    botId: identity.bot_id,
    responseTs: reply.ts,
    visibleMessages: 1,
    observationMs: 60_000,
  });
}
