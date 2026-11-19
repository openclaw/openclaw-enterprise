import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";
import {
  slackApi,
  type SlackIdentity,
  type SlackMessage,
  type SlackRequests,
} from "./slack-web-api.ts";

export function assertSlackChannelDestination(response: unknown, channelId: string): void {
  const channel = asRecord(asRecord(response)?.channel);
  const flags = ["is_channel", "is_group", "is_private"];
  const validFlags =
    channel !== undefined &&
    flags.every((flag) => !(flag in channel) || typeof channel[flag] === "boolean");
  // Both channel shapes need explicit IM and MPIM exclusions below.
  const modern = channel?.is_channel === true && channel?.is_group !== true;
  const legacy =
    channel?.is_channel === false && channel?.is_group === true && channel?.is_private === true;
  if (
    !validFlags ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    channel.id !== channelId ||
    typeof channel.is_private !== "boolean" ||
    channel.is_im !== false ||
    channel.is_mpim !== false ||
    !(modern || legacy)
  ) {
    throw new Error(
      "Slack destination-type failure: conversations.info must identify the exact configured public or private channel, not a DM or MPIM.",
    );
  }
}

type MessageMethod = "conversations.history" | "conversations.replies";
type MessageQuery = {
  [Method in MessageMethod]: [method: Method, token: string, params: SlackRequests[Method][0]];
}[MessageMethod];

export async function allMessages(...request: MessageQuery): Promise<SlackMessage[]> {
  const params = request[2];
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    request[2] = { ...params, limit: 100, ...(cursor ? { cursor } : {}) };
    const page = await slackApi(...request);
    messages.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor;
    assert.ok(!page.has_more || cursor, "Slack must provide a cursor for complete observation");
  } while (cursor);
  return messages;
}

export function assertSlackBotAuthor(message: SlackMessage, identity: SlackIdentity): void {
  assert.match(identity.bot_id ?? "", /^B[A-Z0-9]+$/, "auth.test must identify the expected bot");
  assert.match(message.bot_id ?? "", /^B[A-Z0-9]+$/, "the Slack message must identify its bot");
  assert.equal(message.bot_id, identity.bot_id, "the expected bot must author the Slack message");
  // Slack bot_message payloads can omit user. auth.test binds the exact bot_id
  // to our bot user; any supplied user must still agree with that identity.
  if (message.user !== undefined) {
    assert.equal(message.user, identity.user_id, "the Slack message user must match its bot");
  }
}

interface DeliveryCheck<Native> {
  readonly slack: {
    readonly channelId: string;
    readonly senderBotToken?: string;
    readonly botToken?: string;
  };
  readonly gatewayIdentity: SlackIdentity;
  readonly senderIdentity: SlackIdentity;
  readonly nativeEvidence: (nonce: string) => Native | PromiseLike<Native>;
  readonly replyMode?: "thread" | "root";
  readonly observationMs?: number;
  readonly sendMessage?: (
    text: string,
  ) => Promise<{ readonly channel: string; readonly ts: string }>;
}

// Only the reads are polled. A lost ingress event is a failure, never a reason
// to resend the mutation and accidentally prove a different conversation.
export async function verifySingleSlackDelivery<Native>({
  slack,
  gatewayIdentity,
  senderIdentity,
  nativeEvidence,
  replyMode = "thread",
  observationMs = 60_000,
  sendMessage,
}: DeliveryCheck<Native>) {
  const botId = gatewayIdentity.bot_id ?? "";
  assert.match(botId, /^B[A-Z0-9]+$/, "auth.test must identify the expected bot");
  assert.notEqual(gatewayIdentity.user_id, senderIdentity.user_id);
  assert.equal(gatewayIdentity.team_id, senderIdentity.team_id);
  assert.ok(observationMs >= 60_000 && observationMs <= 300_000);
  const nonce = `OCC-SLACK-${randomUUID()}`;
  const text = `<@${gatewayIdentity.user_id}> Reply with exactly this nonce and no other text: ${nonce}`;
  const readerToken = slack.senderBotToken ?? slack.botToken;
  assert.ok(readerToken, "a provisioned Slack credential must observe delivery");
  assert.ok(
    sendMessage || slack.senderBotToken,
    "the test requires an authorized human sender or a distinct sender bot",
  );
  const sent = sendMessage
    ? await sendMessage(text)
    : await slackApi("chat.postMessage", slack.senderBotToken!, { channel: slack.channelId, text });
  assert.equal(sent.channel, slack.channelId);
  assert.match(sent.ts, /^\d+\.\d+$/);
  const deadline = Date.now() + 240_000;
  let firstObserved: number | undefined;
  let response: SlackMessage | undefined;
  while (Date.now() < (firstObserved ? firstObserved + observationMs : deadline)) {
    const roots = await allMessages("conversations.history", readerToken, {
      channel: slack.channelId,
      oldest: sent.ts,
      inclusive: true,
    });
    const thread = await allMessages("conversations.replies", readerToken, {
      channel: slack.channelId,
      ts: sent.ts,
    });
    const unique = [
      ...new Map([...roots, ...thread].map((message) => [message.ts, message])).values(),
    ];
    const initial = unique.find((message) => message.ts === sent.ts);
    assert.ok(initial, "Slack must expose the exact initial message");
    if (senderIdentity.bot_id) {
      assertSlackBotAuthor(initial, senderIdentity);
    } else {
      assert.equal(
        initial.user,
        senderIdentity.user_id,
        "the confirmed human must author the message",
      );
    }
    assert.ok(
      initial.text?.includes(nonce),
      "the confirmed initial message must contain this run's nonce",
    );
    const matches = unique.filter(
      (message) => message.ts !== sent.ts && message.text?.includes(nonce),
    );
    assert.ok(
      matches.length <= 1,
      "one initial message must not produce duplicate visible responses",
    );
    const intended = matches[0];
    if (intended) {
      assertSlackBotAuthor(intended, gatewayIdentity);
      assert.equal(intended.text?.trim(), nonce);
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
        thread.filter(
          (m) =>
            m.ts !== sent.ts &&
            (m.bot_id === gatewayIdentity.bot_id || m.user === gatewayIdentity.user_id),
        ).length,
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
    botId,
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
