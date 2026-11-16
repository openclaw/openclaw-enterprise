import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";

export interface SlackIdentity {
  readonly team_id: string;
  readonly user_id: string;
  readonly bot_id?: string;
}

export interface SlackMessage {
  readonly ts: string;
  readonly text?: string;
  readonly bot_id?: string;
  readonly user?: string;
  readonly thread_ts?: string;
}

interface MessagePage {
  readonly messages?: readonly SlackMessage[];
  readonly has_more?: boolean;
  readonly response_metadata?: { readonly next_cursor?: string };
}

interface ChannelQuery {
  readonly channel: string;
}

interface PageQuery extends ChannelQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

interface HistoryQuery extends PageQuery {
  readonly oldest?: string;
  readonly inclusive?: boolean;
}

interface RepliesQuery extends PageQuery {
  readonly ts: string;
}

export interface SlackRequests {
  "auth.test": [body?: Record<string, never>];
  "conversations.info": [body: ChannelQuery];
  "conversations.history": [body: HistoryQuery];
  "conversations.replies": [body: RepliesQuery];
  "chat.postMessage": [body: ChannelQuery & { readonly text: string }];
}

interface SlackResults {
  "auth.test": SlackIdentity;
  "conversations.info": { readonly channel?: unknown };
  "conversations.history": MessagePage;
  "conversations.replies": MessagePage;
  "chat.postMessage": { readonly channel: string; readonly ts: string };
}

type SlackMethod = keyof SlackRequests;
type SlackCall = {
  [Method in SlackMethod]: [method: Method, token: string, ...body: SlackRequests[Method]];
}[SlackMethod];
type SlackResult<Method extends SlackMethod> = { readonly ok: true } & SlackResults[Method];
type ObjectValue = Record<string, unknown>;

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isMessage(value: unknown): value is SlackMessage {
  const message = asRecord(value);
  return (
    message !== undefined &&
    typeof message.ts === "string" &&
    isOptionalString(message.text) &&
    isOptionalString(message.bot_id) &&
    isOptionalString(message.user) &&
    isOptionalString(message.thread_ts)
  );
}

function isMessagePage(value: ObjectValue): value is ObjectValue & MessagePage {
  const metadata = asRecord(value.response_metadata);
  return (
    (value.messages === undefined ||
      (Array.isArray(value.messages) && value.messages.every(isMessage))) &&
    (value.has_more === undefined || typeof value.has_more === "boolean") &&
    (value.response_metadata === undefined ||
      (metadata !== undefined && isOptionalString(metadata.next_cursor)))
  );
}

const validate: {
  readonly [Method in SlackMethod]: (
    value: ObjectValue,
  ) => value is ObjectValue & SlackResults[Method];
} = {
  "auth.test": (value): value is ObjectValue & SlackIdentity =>
    typeof value.team_id === "string" &&
    typeof value.user_id === "string" &&
    isOptionalString(value.bot_id),
  // The destination check owns the channel's identity and exact type flags.
  "conversations.info": (value): value is ObjectValue & SlackResults["conversations.info"] =>
    value !== undefined,
  "conversations.history": isMessagePage,
  "conversations.replies": isMessagePage,
  "chat.postMessage": (value): value is ObjectValue & SlackResults["chat.postMessage"] =>
    typeof value.channel === "string" && typeof value.ts === "string",
};

function isTransient(error: unknown): boolean {
  const fault = asRecord(error);
  const code = asRecord(fault?.cause)?.code ?? fault?.code;
  return (
    fault?.name === "TimeoutError" ||
    fault?.message === "fetch failed" ||
    (typeof code === "string" &&
      ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
        code,
      ))
  );
}

export async function slackApi<Call extends SlackCall>(
  ...call: Call
): Promise<SlackResult<Call[0]>> {
  const method: Call[0] = call[0];
  const [, token, body = {}] = call;
  assert.ok(Object.hasOwn(validate, method), "unsupported Slack proof operation");
  const writesMessage = method === "chat.postMessage";
  const url = new URL(`https://slack.com/api/${method}`);
  if (!writesMessage) {
    for (const [key, value] of Object.entries<string | number | boolean | undefined>({ ...body })) {
      url.searchParams.set(key, String(value));
    }
  }
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, {
        // Send the selected token only to Slack's API. A redirect must never forward it.
        redirect: "error",
        method: writesMessage ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(writesMessage ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(writesMessage ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (writesMessage || attempt === 2 || !isTransient(error)) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
      continue;
    }
    if (writesMessage || attempt === 2 || (response.status !== 429 && response.status < 500)) {
      break;
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryDelay =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1_000, 5_000)
        : 250 * 2 ** attempt;
    await delay(retryDelay);
  }
  assert.ok(response, "Slack request did not return a response");
  assert.equal(response.status, 200, `Slack ${method} returned HTTP ${response.status}.`);
  const wire: unknown = await response.json();
  const result = asRecord(wire);
  const error = typeof result?.error === "string" ? result.error : "unknown_error";
  assert.ok(result?.ok === true, `Slack ${method} failed: ${error}.`);
  const success = { ...result, ok: true } as const;
  assert.ok(validate[method](success), `Slack ${method} returned a malformed result.`);
  return success;
}
