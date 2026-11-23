import assert from "node:assert/strict";
import type {
  ResponseOutputContent,
  ResponsesEvent,
} from "../../apps/controller/src/drivers/egress-proxy/openai-responses.ts";
import { isResponsesEvent } from "../../apps/controller/src/drivers/egress-proxy/openai-responses.ts";
import { isArray } from "../helpers/egress-observation-values.ts";
import type { createStaticEgressExchange } from "../helpers/static-egress-exchange.ts";
import {
  encodeSyntheticEvents,
  type syntheticResponsesEvents,
} from "../fixtures/synthetic-egress-provider.mjs";
import captured from "../fixtures/static-egress/codex-responses.json" with { type: "json" };

type SyntheticEvent = ReturnType<typeof syntheticResponsesEvents>[number];
type SyntheticEnvelope = Extract<SyntheticEvent, { response: object }>;
type SyntheticItemEvent = Extract<SyntheticEvent, { item: object }>;
type SyntheticMessage = Extract<SyntheticItemEvent["item"], { type: "message" }>;
type SyntheticPartEvent = Extract<SyntheticEvent, { part: object }>;
type Response = Extract<ResponsesEvent, { response: object }>["response"];
export type WireContent = ResponseOutputContent & { annotations?: []; logprobs?: [] };
export type WireMessage = Omit<SyntheticMessage, "content" | "status"> & {
  content: WireContent[];
  status?: string;
};
export type WireOutputItem = WireMessage | Exclude<Response["output"][number], { type: "message" }>;
type TokenCounts = Pick<
  NonNullable<SyntheticEnvelope["response"]["usage"]>,
  "input_tokens" | "output_tokens" | "total_tokens"
>;
type WireResponse = Omit<Response, "output"> & {
  model?: string;
  output: WireOutputItem[];
  usage?: TokenCounts | null;
};
type Envelope<Tag extends "response.created" | "response.completed"> = {
  type: Tag;
  response: WireResponse;
};
type MessageItem<Tag extends "response.output_item.added" | "response.output_item.done"> = Omit<
  SyntheticItemEvent,
  "type" | "item"
> & { type: Tag; item: WireMessage };
type TextPart<Tag extends "response.content_part.added" | "response.content_part.done"> = Omit<
  SyntheticPartEvent,
  "type" | "part"
> & { type: Tag; part: Extract<WireContent, { type: "output_text" }> };
type CanonicalEvents = readonly [
  Envelope<"response.created">,
  MessageItem<"response.output_item.added">,
  TextPart<"response.content_part.added">,
  Extract<SyntheticEvent, { type: "response.output_text.delta" }>,
  Extract<SyntheticEvent, { type: "response.output_text.done" }>,
  TextPart<"response.content_part.done">,
  MessageItem<"response.output_item.done">,
  Envelope<"response.completed">,
];

const canonicalTags = [
  "response.created",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "response.completed",
] as const;

// The protocol validator checks the fields. The scenarios also need the eight
// captured positions to carry assistant messages and output text.
function assertCanonicalEvents(events: unknown): asserts events is CanonicalEvents {
  assert.ok(
    isArray(events) && events.length === canonicalTags.length,
    "captured Responses event count",
  );
  for (const [index, tag] of canonicalTags.entries()) {
    const event: unknown = events[index];
    assert.ok(
      isResponsesEvent(event, captured.request.model) && event.type === tag,
      `captured Responses event ${index}`,
    );
    if ("response" in event) {
      assert.ok(
        event.response.output.every((item) => item.type === "message"),
        "captured Responses output",
      );
    }
    if ("item" in event) {
      assert.equal(event.item.type, "message", "captured Responses message");
    }
    if ("part" in event) {
      assert.equal(event.part?.type, "output_text", "captured Responses output text");
    }
  }
}

const capturedEvents: unknown = captured.responseEvents;
assertCanonicalEvents(capturedEvents);
export const wire = { ...captured, responseEvents: capturedEvents };
export function responseEvents(): CanonicalEvents {
  return structuredClone(wire.responseEvents);
}
export const encode = (events: readonly { type: string }[]) =>
  encodeSyntheticEvents(events).toString("utf8");
export const selectedMaterial = "synthetic-key-initial";
export const reflectedMaterial: [string, string] = [
  selectedMaterial,
  Buffer.from(selectedMaterial).toString("base64"),
];

export function splitText(text: string): [string, string] {
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

export function assistantMessage(item: WireOutputItem | undefined): WireMessage {
  assert.ok(item?.type === "message", "captured assistant message");
  return item;
}

type Exchange = ReturnType<typeof createStaticEgressExchange>;
export type ExchangeRequest = NonNullable<Parameters<Exchange["exchangeResponse"]>[1]>;
type CheckOptions = {
  blocked?: boolean;
  label?: string;
  stream?: boolean;
  request?: ExchangeRequest | undefined;
};

// Exercise the actual protected exchange in both directions. A denied response must
// release no messages (including its head); an allowed response must arrive byte-for-byte.
export function responseChecks(f: Pick<Exchange, "exchangeResponse">) {
  async function check(
    rawBody: string,
    {
      blocked,
      label = "",
      stream = true,
      request = { ...wire.request, stream },
    }: CheckOptions = {},
  ) {
    const contentType = stream ? "text/event-stream" : "application/json";
    const result = await f.exchangeResponse({ status: 200, contentType, rawBody }, request);
    if (blocked) {
      assert.ok("blocked" in result, label);
      assert.equal(result.blocked, true, label);
    } else {
      assert.ok(!("blocked" in result), label);
      assert.equal(result.response_complete, true, label);
      assert.equal(result.body?.toString(), rawBody, label);
    }
    return rawBody;
  }
  return {
    wireBody: check,
    events(
      events: readonly { type: string }[],
      blocked: boolean,
      label: string,
      stream = true,
      request?: ExchangeRequest,
    ) {
      if (stream) {
        return check(encode(events), { blocked, label, stream, request });
      }
      const last = events.at(-1);
      assert.ok(last && "response" in last, "non-stream response has a terminal envelope");
      const body = JSON.stringify(last.response);
      return check(body, { blocked, label, stream, request });
    },
  };
}
