import assert from "node:assert/strict";

import { networkProxyAcceptance, slackRead } from "./network-proxy-acceptance.ts";

type Message = Record<string, unknown>;
type SlackReader = (
  method: string,
  token: string,
  fields: Record<string, string>,
) => Promise<Record<string, unknown>>;
export type RootMetadata = { replies: number; latest: string | null };
export type RootInventory = Record<string, RootMetadata>;
const pageLimit = 10;

function timestamp(value: unknown): bigint {
  assert.ok(
    typeof value === "string" && /^\d+\.\d{1,6}$/u.test(value),
    "Slack activity timestamp is invalid",
  );
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
}

export function acceptanceAuthor(message: Message): "receiver" | "sender" {
  if (
    (message.user === networkProxyAcceptance.receiver ||
      (message.bot_id === networkProxyAcceptance.receiverBot &&
        message.app_id === networkProxyAcceptance.app)) &&
    (message.bot_id === undefined || message.bot_id === networkProxyAcceptance.receiverBot) &&
    (message.app_id === undefined || message.app_id === networkProxyAcceptance.app)
  ) {
    return "receiver";
  }
  if (
    (message.user === networkProxyAcceptance.sender ||
      (message.bot_id === networkProxyAcceptance.senderBot &&
        message.app_id === networkProxyAcceptance.senderApp)) &&
    (message.bot_id === undefined || message.bot_id === networkProxyAcceptance.senderBot) &&
    (message.app_id === undefined || message.app_id === networkProxyAcceptance.senderApp)
  ) {
    return "sender";
  }
  throw new Error("Unexpected Slack channel author or actor identity");
}

function pageMessages(page: Record<string, unknown>): Message[] {
  assert.ok(
    Array.isArray(page.messages) &&
      page.messages.every((item) => item && typeof item === "object" && !Array.isArray(item)),
    "Slack activity response is invalid",
  );
  return page.messages as Message[];
}

function cursor(page: Record<string, unknown>): string {
  const value = (page.response_metadata as Record<string, unknown> | undefined)?.next_cursor ?? "";
  assert.ok(
    typeof value === "string" && (page.has_more !== true || value.length > 0),
    "Slack activity cursor is incomplete",
  );
  return value;
}

function metadata(message: Message): RootMetadata {
  const replies = Number(message.reply_count ?? 0);
  assert.ok(Number.isSafeInteger(replies) && replies >= 0, "Slack thread metadata is invalid");
  const latest = message.latest_reply ?? null;
  assert.ok(
    (replies === 0 && latest === null) ||
      (typeof latest === "string" && timestamp(latest) >= timestamp(message.ts)),
    "Slack thread metadata is incomplete",
  );
  return { replies, latest: latest as string | null };
}

async function collect(
  method: string,
  token: string,
  fields: Record<string, string>,
  call: SlackReader,
): Promise<Message[]> {
  const result: Message[] = [];
  const cursors = new Set<string>();
  let next = "";
  for (let page = 0; page < pageLimit; page++) {
    const response = await call(method, token, {
      ...fields,
      limit: "200",
      ...(next ? { cursor: next } : {}),
    });
    result.push(...pageMessages(response));
    next = cursor(response);
    if (!next) {
      return result;
    }
    assert.ok(!cursors.has(next), "Slack activity cursor repeated");
    cursors.add(next);
  }
  throw new Error("Slack activity inventory exceeded its bounded pagination limit");
}

async function roots(token: string, call: SlackReader): Promise<Message[]> {
  const values = await collect(
    "conversations.history",
    token,
    { channel: networkProxyAcceptance.channel },
    call,
  );
  const seen = new Set<string>();
  let previous: bigint | undefined;
  for (const message of values) {
    const ts = timestamp(message.ts);
    assert.ok(
      !seen.has(String(message.ts)) && (previous === undefined || ts < previous),
      "Slack root pagination changed concurrently",
    );
    seen.add(String(message.ts));
    previous = ts;
  }
  const firstAgain = pageMessages(
    await call("conversations.history", token, {
      channel: networkProxyAcceptance.channel,
      limit: "200",
    }),
  );
  const describe = (items: Message[]) => items.map((item) => [item.ts, metadata(item)]);
  assert.deepEqual(
    describe(firstAgain),
    describe(values.slice(0, firstAgain.length)),
    "Slack root pagination changed concurrently",
  );
  return values;
}

export async function captureAcceptanceRoots(
  token: string,
  baseline: string,
  call: SlackReader = slackRead,
): Promise<RootInventory> {
  const start = timestamp(baseline);
  const inventory: RootInventory = {};
  for (const root of await roots(token, call)) {
    const data = metadata(root);
    assert.ok(
      timestamp(root.ts) < start && (!data.latest || timestamp(data.latest) < start),
      "Unexpected channel activity before the first stage",
    );
    inventory[String(root.ts)] = data;
  }
  return inventory;
}

/** Reconcile all new roots and changed threads, including replies on roots older than the baseline. */
export async function reconcileAcceptanceActivity(
  token: string,
  baseline: string,
  inventory: RootInventory,
  call: SlackReader = slackRead,
): Promise<{ total: number; receiver: number; sender: number; seenIds: string[] }> {
  const start = timestamp(baseline);
  const seen = new Map<string, Message>();
  const present = new Set<string>();
  for (const root of await roots(token, call)) {
    const ts = String(root.ts);
    present.add(ts);
    const data = metadata(root);
    const before = inventory[ts];
    if (timestamp(ts) >= start) {
      seen.set(ts, root);
    }
    if (before) {
      assert.ok(
        data.replies >= before.replies &&
          (!before.latest || (data.latest && timestamp(data.latest) >= timestamp(before.latest))),
        "Existing Slack thread metadata regressed",
      );
    }
    const changed =
      data.replies > 0 &&
      (!before || data.replies !== before.replies || data.latest !== before.latest);
    if (changed) {
      for (const item of await collect(
        "conversations.replies",
        token,
        { channel: networkProxyAcceptance.channel, ts, oldest: baseline, inclusive: "true" },
        call,
      )) {
        if (timestamp(item.ts) >= start) {
          seen.set(String(item.ts), item);
        }
      }
    }
  }
  assert.ok(
    Object.keys(inventory).every((ts) => present.has(ts)),
    "A baseline Slack root disappeared during acceptance",
  );
  const result = { total: seen.size, receiver: 0, sender: 0, seenIds: [...seen.keys()].sort() };
  for (const item of seen.values()) {
    result[acceptanceAuthor(item)]++;
  }
  return result;
}
