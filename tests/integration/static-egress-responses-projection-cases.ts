import assert from "node:assert/strict";
import test from "node:test";
import type {
  ItemContentEvent,
  ItemEvent,
  ResponsesEvent,
} from "../../apps/controller/src/drivers/egress-proxy/openai-responses.ts";
import { outputWithIndependentCitation } from "../fixtures/synthetic-egress-provider.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import {
  assistantMessage,
  encode,
  reflectedMaterial,
  responseChecks,
  responseEvents,
  selectedMaterial,
  splitText,
  wire,
  type WireContent,
  type WireMessage,
} from "./static-egress-responses-data.ts";

type ProjectionKind = "done" | "envelope" | "added" | "deltas" | "seed" | "active";
type SnapshotKind = "part" | "item" | "parts" | "duplicate" | "initial";
type ReasoningSummary = (Extract<ItemEvent["item"], { type: "reasoning" }>["summary"][number] & {
  type: "summary_text";
})[];

function outputTextParts(...texts: string[]): Extract<WireContent, { type: "output_text" }>[] {
  return texts.map((text) => ({ type: "output_text", text, annotations: [] }));
}

export function registerStaticEgressResponsesProjectionCases(): void {
  test("shipped exchange withholds material split across one reasoning part", async (t) => {
    const f = await staticEgressFixture(t);
    const [prefix, suffix] = splitText(selectedMaterial);
    const part = (index: number, text = ""): ItemContentEvent => ({
      type: "response.reasoning_summary_part.added",
      item_id: "rs_exchange",
      output_index: 0,
      summary_index: index,
      part: { type: "summary_text", text },
    });
    const summaryDelta = (index: number, text: string): ItemContentEvent => ({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_exchange",
      output_index: 0,
      summary_index: index,
      delta: text,
    });
    const textDelta = (index: number, text: string): ItemContentEvent => ({
      type: "response.reasoning_text.delta",
      item_id: "rs_exchange",
      output_index: 0,
      content_index: index,
      delta: text,
    });
    const textDone = (index: number, text: string): ItemContentEvent & { text: string } => ({
      type: "response.reasoning_text.done",
      item_id: "rs_exchange",
      output_index: 0,
      content_index: index,
      text,
    });
    const stream = (inner: ItemContentEvent[], doneSummary: ReasoningSummary) => {
      let sequence = 0;
      const numbered = <Event extends { type: string }>(event: Event) => ({
        sequence_number: sequence++,
        ...event,
      });
      const reasoning = { type: "reasoning", id: "rs_exchange", summary: [] };
      const response = (status: "in_progress" | "completed") => ({
        id: "resp_reasoning_exchange",
        object: "response",
        model: wire.request.model,
        created_at: 1791985502,
        status,
        output: status === "completed" ? [{ type: "reasoning", summary: doneSummary }] : [],
      });
      return [
        numbered({ type: "response.created", response: response("in_progress") }),
        numbered({ type: "response.output_item.added", output_index: 0, item: reasoning }),
        ...inner.map((event) => numbered(event)),
        numbered({
          type: "response.output_item.done",
          output_index: 0,
          item: { ...reasoning, summary: doneSummary },
        }),
        numbered({ type: "response.completed", response: response("completed") }),
      ];
    };
    const redacted: ReasoningSummary = [
      { type: "summary_text", text: "redacted" },
      { type: "summary_text", text: "aside" },
    ];
    const cases = [
      {
        label: "harmless-summary",
        blocked: false,
        events: stream(
          [
            part(0),
            summaryDelta(0, "hello "),
            part(1),
            summaryDelta(1, "aside"),
            summaryDelta(0, "world"),
          ],
          [
            { type: "summary_text", text: "hello world" },
            { type: "summary_text", text: "aside" },
          ],
        ),
      },
      {
        label: "harmless-reasoning-text-completion",
        blocked: false,
        events: stream([textDelta(0, "ordinary response"), textDone(0, "ordinary response")], []),
      },
      {
        label: "withheld-skipped-summary-index",
        blocked: true,
        // Summary parts append: skipping index zero cannot open a later part.
        events: stream([part(1, "ok")], []),
      },
      {
        label: "withheld-unopened-reasoning-text-completion",
        blocked: true,
        // A completion may finish an open index, but cannot open the next one.
        events: stream([textDelta(0, "ordinary response"), textDone(1, "aside")], []),
      },
      {
        label: "withheld-summary",
        blocked: true,
        events: stream(
          [
            part(0),
            summaryDelta(0, prefix),
            part(1),
            summaryDelta(1, "aside"),
            summaryDelta(0, suffix),
          ],
          redacted,
        ),
      },
      {
        label: "withheld-reasoning-text",
        blocked: true,
        events: stream(
          [textDelta(0, prefix), textDelta(1, "aside"), textDelta(0, suffix)],
          redacted,
        ),
      },
    ];
    for (const entry of cases) {
      const rawBody = encode(entry.events);
      const result = await f.exchangeResponse(
        { status: 200, contentType: "text/event-stream", rawBody },
        wire.request,
      );
      const withheld = "blocked" in result;
      const released = withheld ? 0 : Buffer.byteLength(result.body ?? "");
      console.log(
        `exchange ${entry.label}: ${withheld ? "withheld" : "delivered"} released_bytes=${released}`,
      );
      if (entry.blocked) {
        assert.ok(withheld, entry.label);
        assert.equal(result.blocked, true, entry.label);
        assert.equal(released, 0, entry.label);
      } else {
        assert.ok(!withheld, entry.label);
        assert.equal(result.response_complete, true, entry.label);
        assert.equal(result.body?.toString(), rawBody, entry.label);
        assert.equal(released, Buffer.byteLength(rawBody), entry.label);
      }
    }
  });

  test("Responses output text assembled across parts and messages cannot reveal selected material", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const message = (id: string, parts: string[]): WireMessage => ({
      type: "message",
      id,
      status: "completed",
      role: "assistant",
      content: outputTextParts(...parts),
    });
    // Deltas and completed items stay harmless. Only the terminal envelope contains
    // the candidate, so protecting an earlier projection cannot mask this test.
    for (const stream of [false, true]) {
      for (const acrossMessages of [false, true]) {
        for (const text of [...reflectedMaterial, "ordinary response"]) {
          const parts = splitText(text);
          const events = responseEvents();
          events[7].response.output = acrossMessages
            ? parts.map((part, i) => message(`msg_${i}`, [part]))
            : [message("msg_0", parts)];
          await check.events(
            events,
            reflectedMaterial.includes(text),
            `stream=${stream}, acrossMessages=${acrossMessages}`,
            stream,
            stream ? wire.request : { model: "fixture-model", input: "hello", store: false },
          );
        }
      }
    }
  });

  test("Responses refusal parts pass as assistant content and cannot reveal selected material", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    // A provider safety refusal streams as a `refusal` content part with refusal deltas.
    const refusalEvents = (refusal: string): ResponsesEvent[] => {
      const [prefix, suffix] = splitText(refusal);
      return responseEvents().flatMap<ResponsesEvent>((next) => {
        if ("part" in next) {
          return [
            {
              ...next,
              part: { type: "refusal", refusal: next.type.endsWith(".added") ? "" : refusal },
            },
          ];
        }
        if (next.type === "response.output_text.delta") {
          return [
            { ...next, type: "response.refusal.delta", delta: prefix },
            { ...next, type: "response.refusal.delta", delta: suffix },
          ];
        }
        if (next.type === "response.output_text.done") {
          const { text: _text, ...fields } = next;
          const done = { ...fields, type: "response.refusal.done", refusal };
          return [done];
        }
        const items = [
          ...("item" in next ? [next.item] : []),
          ...("response" in next ? next.response.output : []),
        ];
        for (const item of items) {
          if (item.type === "message" && item.content.length > 0) {
            item.content = [{ type: "refusal", refusal }];
          }
        }
        return [next];
      });
    };
    for (const stream of [false, true]) {
      const request = stream
        ? wire.request
        : { model: "fixture-model", input: "hello", store: false };
      await check.events(
        refusalEvents("I can't help with that."),
        false,
        `refusal passes, stream=${stream}`,
        stream,
        request,
      );
      for (const material of reflectedMaterial) {
        await check.events(
          refusalEvents(`I can't help with ${material}.`),
          true,
          `refusal reflecting material, stream=${stream}`,
          stream,
          request,
        );
      }
    }
    // Split across an output_text delta and a refusal delta in the next part: the consumer may
    // join both, so the assistant stream protects their concatenation.
    const mixed = (text: string) => {
      const [created, item, part, delta, ...rest] = responseEvents();
      const [prefix, suffix] = splitText(text);
      return [
        created,
        item,
        part,
        { ...delta, delta: prefix },
        { ...part, content_index: 1, part: { type: "refusal", refusal: "" } },
        {
          ...delta,
          type: "response.refusal.delta",
          content_index: 1,
          delta: suffix,
        },
        ...rest,
      ];
    };
    await check.events(mixed("ordinary response"), false, "benign output_text and refusal deltas");
    for (const material of reflectedMaterial) {
      await check.events(
        mixed(material),
        true,
        "output_text and refusal deltas assembling material",
      );
    }
    // Split across refusal deltas only: the terminal snapshot stays harmless.
    for (const material of reflectedMaterial) {
      const events = refusalEvents(material).map((event) => {
        if (event.type === "response.refusal.done") {
          return { ...event, refusal: "redacted" };
        }
        if ("part" in event && event.part?.type === "refusal" && event.part.refusal) {
          return { ...event, part: { ...event.part, refusal: "redacted" } };
        }
        const items = [
          ...("item" in event ? [event.item] : []),
          ...("response" in event ? event.response.output : []),
        ];
        for (const item of items) {
          if (item.type === "message" && item.content.length > 0) {
            item.content = [{ type: "refusal", refusal: "redacted" }];
          }
        }
        return event;
      });
      await check.events(events, true, "refusal deltas assembling the material");
    }
  });

  test("Responses assistant projections protect independent items and seeded deltas", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const parts = (text: string) => outputTextParts(...splitText(text));
    function eventsFor(text: string, kind: ProjectionKind): ResponsesEvent[] {
      const capture = responseEvents();
      const events: ResponsesEvent[] = [...capture];
      if (kind === "done") {
        // Change only this independent item. Deltas and terminal output stay READY.
        capture[6].item.content = parts(text);
      } else if (kind === "envelope") {
        assistantMessage(capture[7].response.output[0]).content = parts(text);
      } else if (kind === "added") {
        capture[1].item.content = parts(text);
        // Seeded parts already occupy indexes 0 and 1; no duplicate append.
        events.splice(2, 1);
      } else if (kind === "deltas") {
        const [left, right] = splitText(text);
        events.splice(3, 1, { ...capture[3], delta: left }, { ...capture[3], delta: right });
      } else {
        // Split the seed across two parts, then finish via an ID-free delta.
        // No single indexed SDK snapshot contains the full candidate.
        // Split inside the citation opener when present, so neither event has it.
        const citation = text.indexOf("citation");
        const boundary = citation === -1 ? Math.floor(text.length / 2) : citation + 3;
        const seed = parts(text.slice(0, boundary));
        capture[3].delta = text.slice(boundary);
        if (kind === "seed") {
          capture[1].item.content = seed;
          events.splice(2, 1);
        } else {
          // The delta names the first item, but the assistant consumer sends it
          // to the most recently added message. Both wire items remain valid.
          const active = structuredClone(capture[1]);
          active.output_index = 1;
          active.item.id = "msg_active";
          active.item.content = seed;
          const done = structuredClone(capture[6]);
          events.splice(3, 0, active);
          done.output_index = 1;
          done.item.id = "msg_active";
          events.splice(events.length - 1, 0, done);
        }
      }
      return events;
    }
    // Retain both encodings on the two independent item surfaces. Other cases
    // each exercise a distinct consumer boundary rather than a Cartesian matrix.
    for (const kind of ["done", "added", "seed"] as const) {
      for (const candidate of reflectedMaterial) {
        await check.events(eventsFor(candidate, kind), true, kind);
      }
    }
    const collapsed = "synthetic-key-<oai-mem-citation>note</oai-mem-citation>initial";
    for (const kind of ["done", "added", "envelope", "deltas", "seed", "active"] as const) {
      // protect() also asserts zero response messages, including the head.
      await check.events(eventsFor(collapsed, kind), true, kind);
    }
    await check.events(eventsFor(collapsed, "envelope"), true, "JSON envelope", false);
    // An open citation in one message cannot hide visible text in the next.
    // The preceding stream events remain benign, isolating the terminal envelope check.
    for (const streaming of [false, true]) {
      for (const text of [...reflectedMaterial, "ordinary response"]) {
        const events = responseEvents();
        const response = events[7].response;
        response.output = outputWithIndependentCitation(assistantMessage(response.output[0]), text);
        const rawBody = await check.events(
          events,
          reflectedMaterial.includes(text),
          "citation in an independent message",
          streaming,
        );
        assert.equal(rawBody.includes(text), false, "text should be split by a citation");
      }
    }
    for (const [kind, candidate] of [
      ["done", "Answer.<oai-mem-citation>source</oai-mem-citation>"],
      ["added", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
      ["envelope", "Intro\n<proposed_plan>\n- step\n</proposed_plan>\nDone"],
      ["seed", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
      ["active", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
      ["deltas", "Intro\n\u0085<proposed_plan>\u0085\n- step\n</proposed_plan>\nDone"],
      ["seed", "Intro\n<proposed_plan>\n- step\n</proposed_plan>\nDone"],
      ["done", "ordinary <oai-mem-citation>unclosed"],
      ["done", "ordinary <proposed_plan>inline</proposed_plan>"],
      ["done", "synthetic-key-&lt;oai-mem-citation&gt;note&lt;/oai-mem-citation&gt;initial"],
    ] satisfies [ProjectionKind, string][]) {
      await check.events(eventsFor(candidate, kind), false, `benign ${kind}`);
    }
    // Switching consumers must inspect the previous run before discarding it.
    for (const item of [
      { type: "message", role: "assistant", id: "msg_next", content: [] },
      { type: "reasoning", id: "rs_next", summary: [] },
    ] satisfies (ItemEvent["item"] & { role?: string })[]) {
      for (const malicious of [false, true]) {
        const events = eventsFor(
          malicious ? collapsed : "Hello <oai-mem-citation>source</oai-mem-citation> world",
          "seed",
        );
        const delta = events.findIndex((event) => event.type === "response.output_text.delta");
        events.splice(delta + 1, 0, { type: "response.output_item.added", output_index: 1, item });
        events.splice(events.length - 1, 0, {
          type: "response.output_item.done",
          output_index: 1,
          item,
        });
        await check.events(events, malicious, `switch to ${item.type}`);
      }
    }
    const safeEnvelope = eventsFor(
      "Answer.<oai-mem-citation>source</oai-mem-citation>",
      "envelope",
    );
    await check.events(safeEnvelope, false, "safe JSON envelope", false);
    // Hidden data still receives raw and citation-only protection in either mode.
    for (const candidate of [
      "<oai-mem-citation>synthetic-key-initial</oai-mem-citation>",
      "<proposed_plan>\nsynthetic-key-initial\n</proposed_plan>",
      "<proposed_plan>\n" + collapsed + "\n</proposed_plan>",
    ]) {
      await check.events(eventsFor(candidate, "seed"), true, "hidden data");
    }
    // Assistant projections must not reinterpret local tool data.
    const tool = {
      type: "function_call",
      id: "fc_markup",
      call_id: "call_markup",
      name: "fixture_function_0",
      arguments: JSON.stringify({ text: "<oai-mem-citation>note" }),
    } satisfies ItemEvent["item"] & { call_id: string; name: string };
    const nonMessage = [
      structuredClone(wire.responseEvents[0]),
      { type: "response.output_item.added", output_index: 0, item: tool },
      { type: "response.output_item.done", output_index: 0, item: tool },
      {
        type: "response.completed",
        response: { ...wire.responseEvents[7].response, output: [tool] },
      },
    ];
    await check.events(nonMessage, false, "local tool markup");
  });

  test("signed Responses Plan projections protect completed and response-wide streamed text", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const added = (index: number, text: string) =>
      ({
        type: "response.output_item.added",
        output_index: index,
        item: {
          type: "message",
          id: `msg_plan_${index}`,
          role: "assistant",
          content: outputTextParts(text),
        },
      }) satisfies ItemEvent & { item: ItemEvent["item"] & { role: string } };
    const done = (event: ReturnType<typeof added>, text = "READY") =>
      ({
        ...event,
        type: "response.output_item.done",
        item: { ...event.item, content: outputTextParts(text) },
      }) satisfies ItemEvent;
    const response = (...events: ResponsesEvent[]) => [
      wire.responseEvents[0],
      ...events,
      wire.responseEvents[7],
    ];
    for (const unsafe of [false, true]) {
      const expected = unsafe ? ["synthetic", "key", "initial"].join("-") : "ready to proceed";
      const split = expected.lastIndexOf(unsafe ? "-" : " ") + 1;
      const left = expected.slice(0, split);
      const right = expected.slice(split);
      // Completed Plan extracts the raw block before stripping its citations.
      // Ordinary citation-visible text and the terminal envelope stay harmless.
      const completed = responseEvents();
      const markup = `<oai-mem-citation>outer\n<proposed_plan>\n${left}<oai-mem-citation>note</oai-mem-citation>${right}\n</proposed_plan>\n`;
      completed[6].item.content = outputTextParts(markup);
      assert.ok(!encode(completed).includes(expected));
      await check.events(completed, unsafe, "completed Plan and benign twin");
      // Each completed message owns its Plan; a later safe message must not
      // erase an unsafe earlier message from the response-envelope projection.
      const envelope = responseEvents();
      envelope[7].response.output = [
        { ...completed[6].item, content: outputTextParts(markup) },
        {
          ...completed[6].item,
          id: "msg_later_plan",
          content: outputTextParts("<proposed_plan>\nSafe final message\n</proposed_plan>"),
        },
      ];
      await check.events(envelope, unsafe, "independent completed Plan in envelope");
      // The response has one streamed Plan, even though each seed has its own
      // assistant parser and both completed messages independently say READY.
      const a = added(0, `<proposed_plan>\n${left}`);
      const b = added(1, `<proposed_plan>\n${right}`);
      const streamed = response(a, done(a), b, done(b));
      assert.ok(!encode(streamed).includes(expected));
      await check.events(streamed, unsafe, "cross-message Plan and benign twin");
    }
    assert.equal(wire.responseEvents.length, 8);
    await check.events(wire.responseEvents, false, "captured finite eight-event response");
    const generated =
      "Intro\n<proposed_plan>\n- Inspect <oai-mem-citation>source</oai-mem-citation>code\n</proposed_plan>\nDone";
    for (const split of [false, true]) {
      const capture = responseEvents();
      capture[4].text = generated;
      capture[5].part.text = generated;
      capture[6].item.content = outputTextParts(generated);
      assistantMessage(capture[7].response.output[0]).content = outputTextParts(generated);
      const events = [...capture];
      events.splice(
        3,
        1,
        ...(split
          ? [
              "Intro\n<pro",
              "posed_plan>\n- Inspect <oai-mem-",
              "citation>source</oai-mem-citation>code\n</proposed_plan>\nDone",
            ]
          : [generated]
        ).map((delta) => ({ ...wire.responseEvents[3], delta })),
      );
      await check.events(events, false, `coherent generated plan, split=${split}`);
    }
    // These opposite verdicts distinguish the actual stream from a last-block,
    // per-message, close-completes, or raw-before-citations approximation.
    const a = added(0, "<proposed_plan>\nsynthetic-key-");
    const b = added(1, "<proposed_plan>\ninitial");
    await check.events(
      response(a, done(a, "<proposed_plan>\nfinished\n</proposed_plan>"), b, done(b)),
      false,
      "completed Plan stops later Plan deltas",
    );
    const spanning = added(0, "<proposed_plan>\nsynthetic-key-");
    const delta = (text: string) => ({
      ...wire.responseEvents[3],
      item_id: spanning.item.id,
      delta: text,
    });
    await check.events(
      response(
        spanning,
        delta(
          "<oai-mem-citation>\n</proposed_plan>\nignored\n<proposed_plan>\n</oai-mem-citation>initial",
        ),
        done(spanning),
      ),
      true,
      "stream strips citations before recognizing tags",
    );
    // A partial citation opener stays buffered when another assistant or
    // reasoning item displaces its owner. Flushing early would insert the opener
    // between the credential halves and miss the actual streamed Plan text.
    for (const next of [
      b,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "rs_plan", summary: [] },
      } satisfies ItemEvent,
    ]) {
      const tail = added(0, "<proposed_plan>\nsynthetic-key-<oai-mem-");
      const suffix = next.item.type === "message" ? [] : [added(2, "<proposed_plan>\ninitial")];
      const endNext =
        next.item.type === "message"
          ? ({
              ...next,
              type: "response.output_item.done",
              item: { ...next.item, content: outputTextParts("READY") },
            } satisfies ItemEvent)
          : ({ ...next, type: "response.output_item.done" } satisfies ItemEvent);
      // done(tail) flushes the currently active, unrelated assistant first.
      await check.events(
        response(tail, next, ...suffix, done(tail), endNext, ...suffix.map((event) => done(event))),
        true,
        `deferred citation tail after ${next.item.type}`,
      );
    }
    const tail = added(0, "<proposed_plan>\nsynthetic-key-<oai-mem-");
    await check.events(
      response(tail, done(tail), b, done(b)),
      false,
      "done before displacement really flushes the partial opener",
    );
    const blocks = added(0, "<proposed_plan>\n</proposed_plan>\n<proposed_plan>\nsynthetic-key-");
    await check.events(
      response(blocks, done(blocks), b, done(b)),
      true,
      "closing a block does not complete the streamed Plan",
    );
    // Completed Plan selects the last raw block, not every prior block. Ordinary
    // citation-visible text stays harmless while the earlier Plan would be unsafe.
    const last = responseEvents();
    last[6].item.content = outputTextParts(
      "<oai-mem-citation>outer\n<proposed_plan>\nsynthetic-key-<oai-mem-citation>note</oai-mem-citation>initial\n</proposed_plan>\n<proposed_plan>\nfinal safe plan\n</proposed_plan>",
    );
    await check.events(last, false, "completed Plan selects only the last block");
  });

  test("Responses incremental text snapshots cannot reveal selected material", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const events = (candidate: string, kind: SnapshotKind) => {
      const [created, item, part, delta, ...rest] = responseEvents();
      const [prefix, suffix] = splitText(candidate);
      if (kind === "item") {
        item.item.content = [{ ...part.part, text: prefix, annotations: [] }];
        return [created, item, { ...delta, delta: suffix }, ...rest];
      }
      if (kind === "parts") {
        return [
          created,
          item,
          part,
          { ...delta, delta: prefix },
          { ...part, content_index: 1 },
          { ...delta, content_index: 1, delta: "distraction" },
          { ...delta, delta: suffix },
          ...rest,
        ];
      }
      if (kind === "duplicate") {
        part.part.text = prefix;
        return [
          created,
          item,
          part,
          { ...part, part: { ...part.part, text: "distraction" } },
          { ...delta, delta: suffix },
          ...rest,
        ];
      }
      if (kind === "initial") {
        created.response.output = [{ ...item.item, content: [{ ...part.part, text: prefix }] }];
        return [created, item, part, { ...delta, delta: suffix }, ...rest];
      }
      part.part.text = prefix;
      return [created, item, part, { ...delta, delta: suffix }, ...rest];
    };
    // A harmless terminal response cannot erase a credential exposed in an earlier
    // SDK snapshot assembled from an added part and later indexed deltas.
    for (const kind of ["part", "item", "parts", "duplicate", "initial"] as const) {
      for (const candidate of reflectedMaterial) {
        await check.events(events(candidate, kind), true, `${kind} snapshot must be withheld`);
      }
    }
    for (const kind of ["part", "item", "parts"] as const) {
      await check.events(events("ordinary response", kind), false, `benign ${kind}`);
    }
    const laterProgress: ResponsesEvent[] = events("ordinary response", "part");
    const previous = laterProgress.at(-2);
    const first = laterProgress[0];
    assert.ok(previous && "item" in previous, "later progress retains the completed item");
    assert.ok(first && "response" in first, "later progress retains the created envelope");
    const progress = {
      ...structuredClone(first),
      type: "response.in_progress",
      response: { ...first.response, output: [structuredClone(previous.item)] },
    };
    laterProgress.splice(2, 0, progress);
    await check.events(laterProgress, false, "later in_progress snapshot");
  });
}
