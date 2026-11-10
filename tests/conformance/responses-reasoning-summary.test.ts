import assert from "node:assert/strict";
import test from "node:test";
import { protectedResponsesStream } from "../../apps/controller/src/drivers/egress-proxy/openai-responses-stream.ts";

// The selected material is the sentinel the static egress tests already use.
const secret = "synthetic-key-initial";
const model = "fixture-model";

function encode(events: readonly Record<string, unknown>[]): string {
  return `${events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n`)
    .join("\n")}\n`;
}

/** True when the stream reader releases the body. */
function releases(events: readonly Record<string, unknown>[]): boolean {
  const leaked = (value: string) => value.includes(secret);
  const scan = (root: unknown): boolean => {
    const pending = [{ value: root, depth: 0 }];
    while (pending.length > 0) {
      const next = pending.pop();
      if (!next) {
        break;
      }
      const { value } = next;
      if (typeof value === "string" && leaked(value)) {
        return false;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (leaked(key)) {
            return false;
          }
          pending.push({ value: item, depth: next.depth + 1 });
        }
      }
    }
    return true;
  };
  return protectedResponsesStream(encode(events), model, {
    scan,
    leaked,
    fragmentOverlap: Math.max(1, secret.length - 1),
  });
}

function stream(
  summaryEvents: readonly Record<string, unknown>[],
  doneSummary: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  let sequence = 0;
  const numbered = (event: Record<string, unknown>) => ({
    sequence_number: sequence++,
    ...event,
  });
  const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
  return [
    numbered({
      type: "response.created",
      response: { id: "resp_1", status: "in_progress", output: [] },
    }),
    numbered({ type: "response.output_item.added", output_index: 0, item: reasoning }),
    ...summaryEvents.map((event) => numbered(event)),
    numbered({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoning, summary: doneSummary },
    }),
    numbered({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "reasoning", summary: doneSummary }],
      },
    }),
  ];
}

const part = (index: number, text = "") => ({
  type: "response.reasoning_summary_part.added",
  item_id: "rs_1",
  output_index: 0,
  summary_index: index,
  part: { type: "summary_text", text },
});

const delta = (index: number, text: string) => ({
  type: "response.reasoning_summary_text.delta",
  item_id: "rs_1",
  output_index: 0,
  summary_index: index,
  delta: text,
});

test("a reasoning summary part keeps its own text when another part arrives between its deltas", () => {
  const middle = Math.floor(secret.length / 2);
  const harmless = [
    { type: "summary_text", text: "redacted" },
    { type: "summary_text", text: "aside" },
  ];
  // The completed item stays harmless. The client still joins each summary_index
  // from its deltas, so the first part shows the selected material.
  assert.equal(
    releases(
      stream(
        [
          part(0),
          delta(0, secret.slice(0, middle)),
          part(1),
          delta(1, "aside"),
          delta(0, secret.slice(middle)),
        ],
        harmless,
      ),
    ),
    false,
  );
  assert.equal(
    releases(
      stream(
        [part(0), delta(0, "hello "), part(1), delta(1, "aside"), delta(0, "world")],
        [
          { type: "summary_text", text: "hello world" },
          { type: "summary_text", text: "aside" },
        ],
      ),
    ),
    true,
  );
  // A gap makes the next delta land on a different part than the one the client tracks.
  assert.equal(releases(stream([part(1, "ok")], [])), false);
  const text = (index: number, chunk: string) => ({
    type: "response.reasoning_text.delta",
    item_id: "rs_1",
    output_index: 0,
    content_index: index,
    delta: chunk,
  });
  assert.equal(
    releases(
      stream(
        [text(0, secret.slice(0, middle)), text(1, "aside"), text(0, secret.slice(middle))],
        harmless,
      ),
    ),
    false,
  );
});
