import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { slackApi } from "./harness-topology-k3d-real.mjs";

export async function allMessages(method, token, params) {
  const messages = [];
  let cursor;
  do {
    const page = await slackApi(method, token, {
      ...params,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    messages.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor;
    assert.ok(!page.has_more || cursor, "Slack must provide a cursor for complete observation");
  } while (cursor);
  return messages;
}

// Only the reads are polled. A lost ingress event is a failure, never a reason
// to resend the mutation and accidentally prove a different conversation.
export async function verifySingleSlackDelivery({
  slack,
  gatewayIdentity,
  senderIdentity,
  nativeEvidence,
  replyMode = "thread",
  observationMs = 60_000,
}) {
  assert.notEqual(gatewayIdentity.user_id, senderIdentity.user_id);
  assert.equal(gatewayIdentity.team_id, senderIdentity.team_id);
  assert.ok(observationMs >= 60_000 && observationMs <= 300_000);
  const nonce = `OCC-SLACK-${randomUUID()}`;
  const sent = await slackApi("chat.postMessage", slack.senderBotToken, {
    channel: slack.channelId,
    text: `<@${gatewayIdentity.user_id}> Reply with exactly this nonce and no other text: ${nonce}`,
  });
  assert.equal(sent.channel, slack.channelId);
  assert.match(sent.ts, /^\d+\.\d+$/);
  const deadline = Date.now() + 240_000;
  let firstObserved;
  let response;
  while (Date.now() < (firstObserved ? firstObserved + observationMs : deadline)) {
    const roots = await allMessages("conversations.history", slack.senderBotToken, {
      channel: slack.channelId,
      oldest: sent.ts,
      inclusive: true,
    });
    const thread = await allMessages("conversations.replies", slack.senderBotToken, {
      channel: slack.channelId,
      ts: sent.ts,
    });
    const unique = [
      ...new Map([...roots, ...thread].map((message) => [message.ts, message])).values(),
    ];
    const matches = unique.filter(
      (message) => message.ts !== sent.ts && message.text?.includes(nonce),
    );
    assert.ok(
      matches.length <= 1,
      "one initial message must not produce duplicate visible responses",
    );
    const intended = matches[0];
    if (intended) {
      assert.equal(intended.user, gatewayIdentity.user_id);
      assert.equal(intended.bot_id, gatewayIdentity.bot_id);
      assert.equal(intended.text.trim(), nonce);
      if (replyMode === "thread") {
        assert.equal(
          intended.thread_ts,
          sent.ts,
          "response must preserve the original thread timestamp",
        );
      } else {
        assert.ok(
          intended.thread_ts === undefined || intended.thread_ts === intended.ts,
          "root-mode response must be a root",
        );
      }
      assert.equal(
        thread.filter((m) => m.ts !== sent.ts && m.user === gatewayIdentity.user_id).length,
        replyMode === "thread" ? 1 : 0,
        "no extra bot progress or duplicate replies in the original thread",
      );
      firstObserved ??= Date.now();
      response = intended;
    }
    await delay(4_000);
  }
  assert.ok(response, "the only submitted Slack message did not receive its intended reply");
  const native = await nativeEvidence(nonce);
  return {
    nonce,
    channel: slack.channelId,
    botId: gatewayIdentity.bot_id,
    senderId: senderIdentity.user_id,
    originalThreadTs: sent.ts,
    responseTs: response.ts,
    replyMode,
    initialMessages: 1,
    visibleResponses: 1,
    observationMs,
    native,
  };
}
