import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  ItemEvent,
  ResponsesEvent,
} from "../../apps/controller/src/drivers/egress-proxy/openai-responses.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { parseJson } from "../helpers/egress-observation-values.ts";
import inlineCapture from "../fixtures/static-egress/codex-inline-tools.json" with { type: "json" };
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
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
  type ExchangeRequest,
  type WireOutputItem,
} from "./static-egress-responses-data.ts";
import { registerStaticEgressResponsesProjectionCases } from "./static-egress-responses-projection-cases.ts";

function parseMetadata(text: string): object {
  const metadata = asRecord(parseJson(text));
  assert.ok(metadata, "captured Codex turn metadata");
  return metadata;
}

function parsedEvent(text: string): { type: string } {
  const value = parseJson(text);
  const record = asRecord(value);
  assert.ok(record && typeof record.type === "string", "transformed synthetic wire event");
  return { ...record, type: record.type };
}

export function registerStaticEgressResponsesPrefixCases(): void {
  registerStaticEgressResponsesProjectionCases();
  test("Responses follow-up replays assistant text with empty provider metadata", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const capture = responseEvents();
    const terminal = capture[7];
    const assistant = assistantMessage(terminal.response.output[0]);
    const part = assistant.content[0];
    assert.ok(part?.type === "output_text", "captured assistant output text");
    part.logprobs = [];
    const tool = {
      type: "custom_tool_call",
      id: "ct_local",
      call_id: "call_local",
      name: "fixture_custom_0",
      input: "fixture input",
    } satisfies WireOutputItem & { id: string; call_id: string; name: string; input: string };
    const addedTool = {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...tool, input: "" },
    } satisfies ItemEvent & { item: typeof tool };
    const events: ResponsesEvent[] = [...capture];
    events.splice(-1, 0, addedTool, {
      type: "response.output_item.done",
      output_index: 1,
      item: tool,
    });
    terminal.response.output.push(tool);
    const initial = {
      ...wire.request,
      tools: [...wire.request.tools, { type: "custom", name: tool.name }],
    };
    // The local tool call and assistant message must pass the response policy before replay.
    await check.events(events, false, "the first exchange releases a local call", true, initial);

    const output = {
      type: "custom_tool_call_output",
      call_id: tool.call_id,
      output: [{ type: "input_text", text: "fixture result" }],
    };
    const followup = {
      ...initial,
      input: [...initial.input, assistant, tool, output],
    };
    await check.events(responseEvents(), false, "the follow-up admits the replay", true, followup);
    assert.deepEqual(f.providerRequests.at(-1)?.body, followup);

    const withPart = (content: ExchangeRequest[string]) => ({ ...assistant, content: [content] });
    // Keep the metadata confined to replayed assistant output text.
    const deniedInputs = [
      ...["system", "developer", "user"].map((role) => [{ ...assistant, role }, tool, output]),
      [assistant, tool, { ...output, output: [part] }],
      [withPart({ ...part, type: "input_text" }), tool, output],
      [withPart({ ...part, annotations: [{}] }), tool, output],
      [withPart({ ...part, logprobs: [{}] }), tool, output],
      [withPart({ ...part, annotations: null }), tool, output],
      [withPart({ ...part, logprobs: null }), tool, output],
      [withPart({ ...part, unknown: [] }), tool, output],
    ];
    const reads = f.secretReads;
    const sends = f.providerRequests.length;
    for (const input of deniedInputs) {
      const request = { ...followup, input: [...initial.input, ...input] };
      assert.ok((await f.resolve(f.capture(request))).refused);
    }
    assert.equal(f.secretReads, reads, "unsupported metadata cannot read credentials");
    assert.equal(f.providerRequests.length, sends, "unsupported metadata cannot send");
  });
}

export async function runStaticEgressNativeAgentMessageCase(t: TestContext): Promise<void> {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const message = {
    type: "agent_message",
    id: "amsg_fixture",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "input_text", text: "Synthetic task" }],
  };
  const encrypted = { type: "encrypted_content", encrypted_content: "synthetic-ciphertext" };
  const requestWith = (item: ExchangeRequest[string]) => ({
    ...wire.request,
    input: [...wire.request.input, item],
  });

  for (const content of [message.content, [...message.content, encrypted]]) {
    const request = requestWith({ ...message, content });
    await check.events(responseEvents(), false, "native agent input completes", true, request);
    assert.deepEqual(f.providerRequests.at(-1)?.body, request);
  }

  const reads = f.secretReads;
  const sends = f.providerRequests.length;
  for (const item of [
    { ...message, author: "https://example.invalid/agent" },
    { ...message, recipient: "/other/worker" },
    { ...message, recipient: "/root/../other" },
    { ...message, tools: [{ type: "web_search" }] },
    { ...message, content: [] },
    { ...message, content: [encrypted] },
    { ...message, content: [...message.content, encrypted, encrypted] },
    { ...message, content: [{ type: "input_image", image_url: "https://example.invalid/image" }] },
    { ...message, content: [...message.content, { ...encrypted, encrypted_content: {} }] },
  ]) {
    assert.ok((await f.resolve(f.capture(requestWith(item)))).refused);
  }
  assert.equal(f.secretReads, reads, "unsupported agent messages cannot read credentials");
  assert.equal(f.providerRequests.length, sends, "unsupported agent messages cannot send");
}

export function registerStaticEgressResponsesWireCases(
  unicodeEscapes: (text: string) => string,
): void {
  test("Codex manual compaction forwards its closed metadata through protected inference", async (t) => {
    const f = await staticEgressFixture(t);
    const key = "x-codex-turn-metadata";
    const metadata = parseMetadata(wire.request.client_metadata[key]);
    const compaction = {
      trigger: "manual",
      reason: "user_requested",
      implementation: "responses",
      phase: "standalone_turn",
      strategy: "memento",
    };
    function request(record: object, kind = "compaction") {
      return {
        ...wire.request,
        client_metadata: {
          ...wire.request.client_metadata,
          [key]: JSON.stringify({ ...metadata, request_kind: kind, compaction: record }),
        },
      };
    }
    const manual = request(compaction);
    const check = responseChecks(f);
    await check.events(responseEvents(), false, "manual compaction", true, manual);
    assert.deepEqual(f.providerRequests.at(-1)?.body, manual);

    // Codex serializes reasoning content as null when a prior provider item omitted it.
    const reasoning = {
      type: "reasoning",
      id: "rs_fixture",
      summary: [{ type: "summary_text", text: "Earlier reasoning" }],
      content: null,
      encrypted_content: "opaque reasoning fixture",
    };
    const replay = { ...manual, input: [...manual.input, reasoning] };
    await check.events(
      responseEvents(),
      false,
      "manual compaction replays reasoning",
      true,
      replay,
    );
    assert.deepEqual(f.providerRequests.at(-1)?.body, replay);

    const reads = f.secretReads;
    const sends = f.providerRequests.length;
    for (const invalid of [
      request({ ...compaction, strategy: "unknown" }),
      request({ ...compaction, phase: undefined }),
      request({ ...compaction, authority: "owner" }),
      request(compaction, "turn"),
      { ...manual, tools: [{ type: "web_search" }] },
      { ...manual, model: "outside-the-grant" },
      ...[{}, "text", [{ type: "input_text", text: "unexpected" }]].map((content) => ({
        ...replay,
        input: [...manual.input, { ...reasoning, content }],
      })),
      { ...replay, input: [...manual.input, { ...reasoning, unknown: null }] },
    ]) {
      assert.ok((await f.resolve(f.capture(invalid))).refused);
    }
    assert.equal(f.secretReads, reads);
    assert.equal(f.providerRequests.length, sends);
  });

  test("selected Codex Responses wire admits local tools and finite SSE while rejecting remote tools and unprotected events", async (t) => {
    const f = await staticEgressFixture(t);
    // Sanitized packaged 0.163.0-alpha.2 request and synthetic response consumed by that
    // binary. This exercises OCE's real transport, not a model provider or installed Harness.
    const check = responseChecks(f);
    const body = encode(wire.responseEvents);
    await check.wireBody(body);
    assert.deepEqual(f.providerRequests[0]?.body, wire.request);
    await check.wireBody(body.replaceAll("\n", "\r\n"), { label: "CRLF" });

    // A reduced, sanitized packaged-client capture uses developer input for local tools.
    // Its format header participates in the signed request. This proves the OCE
    // contract with a fixture sender, not native relay or model-provider support.
    const capturedInline = structuredClone(inlineCapture);
    const inline = {
      ...capturedInline,
      request: {
        ...capturedInline.request,
        client_metadata: {
          ...capturedInline.request.client_metadata,
          mcp_attribution: JSON.stringify({ status: "none" }),
        },
      },
    };
    const metadataKey = "x-codex-turn-metadata";
    const turnMetadata = parseMetadata(inline.request.client_metadata[metadataKey]);
    const repositoryRoot = "/workspace/repository";
    const origin = "https://example.invalid/owner/repository.git";
    // Extend the sanitized request with the metadata Codex sends from a Git checkout.
    const workspace = {
      latest_git_commit_hash: "a".repeat(40),
      has_changes: false,
      associated_remote_urls: {
        origin,
        mirror: "git@example.invalid:owner/repository.git",
      },
    };
    const captureInline = (request: ExchangeRequest) => {
      const captured = f.capture(request);
      captured.request.headers.push(
        ...Object.entries(inline.headers).map(([name, value]) => ({ name, value })),
      );
      return captured;
    };
    // Captured native requests paired telemetry "ultra" with wire "xhigh". Preserve each field's
    // supported spelling through authorization and the actual TLS provider request.
    for (const [effort, metadata] of [
      [inline.request.reasoning.effort, turnMetadata],
      [
        inline.request.reasoning.effort,
        { ...turnMetadata, workspaces: { [repositoryRoot]: workspace } },
      ],
      ["high", { ...turnMetadata, reasoning_effort: "high" }],
      ["xhigh", { ...turnMetadata, reasoning_effort: "ultra" }],
      ["max", { ...turnMetadata, reasoning_effort: "max" }],
    ] as const) {
      inline.request.reasoning.effort = effort;
      inline.request.client_metadata[metadataKey] = JSON.stringify(metadata);
      const captured = captureInline(inline.request);
      const { ready } = await f.resolve(captured);
      assert.ok(ready, "native metadata and inline tools resolve through the installed provider");
      assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
      f.setResponse({ status: 200, contentType: "text/event-stream", rawBody: body });
      const protectedReply = await f.protect(captured, await f.send(captured, ready));
      assert.ok(!("blocked" in protectedReply), "native inline response is released");
      assert.equal(protectedReply.response_complete, true);
      assert.equal(protectedReply.body.toString(), body);
      assert.deepEqual(f.providerRequests.at(-1)?.body, inline.request);
    }

    // Inline declarations cannot expand the admitted local-tool grant or let
    // client metadata select authority. Refuse before another Secret read/send.
    const inlineReads = f.secretReads;
    const inlineSends = f.providerRequests.length;
    type InlineRequest = typeof inline.request;
    function firstInput(request: InlineRequest) {
      const item = request.input[0];
      assert.ok(item, "captured inline additional-tools input");
      return item;
    }
    function declaredTools(request: InlineRequest) {
      const item = firstInput(request);
      assert.ok(item.tools, "captured inline tool declarations");
      return item.tools;
    }
    function namespace(request: InlineRequest, index: number) {
      const item = declaredTools(request)[index];
      assert.ok(item, "captured inline namespace");
      return item;
    }
    function messageParameter(request: InlineRequest) {
      const tool = namespace(request, 1).tools[0];
      assert.ok(
        tool && "parameters" in tool && tool.parameters?.properties?.message,
        "captured inline message parameter",
      );
      return tool.parameters.properties.message;
    }
    const mutations: ((request: InlineRequest) => void)[] = [
      ...[
        { status: "none" },
        " ".repeat(8192) + '{"status":"none"}',
        '{"status":"none","status":"none"}',
        '{"status":"active"}',
        '{"status":"none","server":"https://remote.example.test"}',
      ].map((attribution) => (request: InlineRequest) => {
        Object.assign(request.client_metadata, { mcp_attribution: attribution });
      }),
      ...["system", "user", "assistant"].map((role) => (request: InlineRequest) => {
        firstInput(request).role = role;
      }),
      (request) => {
        Object.assign(firstInput(request), {
          tools: [...declaredTools(request), { type: "web_search" }],
        });
      },
      (request) => {
        const item = namespace(request, 0);
        Object.assign(item, { tools: [...item.tools, { type: "web_search" }] });
      },
      (request) => {
        Object.assign(firstInput(request), { authority: "owner" });
      },
      (request) => {
        Object.assign(messageParameter(request), { encrypted: false });
      },
      (request) => {
        messageParameter(request).type = "number";
      },
      (request) => {
        const metadata = parseMetadata(request.client_metadata[metadataKey]);
        request.client_metadata[metadataKey] = JSON.stringify({
          ...metadata,
          reasoning_effort: "unrecognized",
        });
      },
      ...["ultra", "unrecognized"].map((effort) => (request: InlineRequest) => {
        request.reasoning.effort = effort;
      }),
      ...[
        { relative: workspace },
        { ["/".repeat(4097)]: workspace },
        { ["/workspace/line\nbreak"]: workspace },
        { [repositoryRoot]: workspace, "/workspace/another-repository": workspace },
        { [repositoryRoot]: {} },
        { [repositoryRoot]: { namespace_id: f.namespace.id } },
        { [repositoryRoot]: { latest_git_commit_hash: "1234" } },
        { [repositoryRoot]: { has_changes: "false" } },
        ...[
          {},
          { "up\u017ftream": origin },
          { origin: "https://\u212A.example.invalid/owner/repository.git" },
          { origin: "https://example.invalid/owner/repo\u017fitory.git" },
          {
            origin: syntheticCredentialUrl({
              username: "fixture-user",
              password: "fixture-password",
              host: "example.invalid",
              pathname: "/owner/repository.git",
            }),
          },
          { origin: origin + "?query=value" },
          { origin: origin + "#fragment" },
          { origin: "ssh://git@example.invalid/owner/repository.git" },
          { origin: "fixture-user@example.invalid:owner/repository.git" },
          { origin: "helper::git@example.invalid:owner/repository.git" },
          { origin: "https://example.invalid/" + "a".repeat(2048) },
          Object.fromEntries(Array.from({ length: 17 }, (_, index) => [index, origin])),
        ].map((associated_remote_urls) => ({
          [repositoryRoot]: { associated_remote_urls },
        })),
      ].map((workspaces) => (request: InlineRequest) => {
        request.client_metadata[metadataKey] = JSON.stringify({ ...turnMetadata, workspaces });
      }),
      (request) => {
        request.client_metadata[metadataKey] =
          '{"workspaces":{"/workspace/repository":{"has_changes":false,"has_changes":true}}}';
      },
      (request) => {
        Object.assign(request.client_metadata, { namespace_id: f.namespace.id });
      },
      (request) => {
        request.model = "model-outside-the-inference-grant";
      },
      (request) => {
        Object.assign(request.text, {
          format: {
            type: "json_schema",
            name: "output",
            schema: { type: "string", encrypted: true },
          },
        });
      },
      (request) => {
        request.store = true;
      },
    ];
    for (const mutate of mutations) {
      const request = structuredClone(inline.request);
      mutate(request);
      assert.ok((await f.resolve(captureInline(request))).refused);
    }
    assert.equal(f.secretReads, inlineReads, "unsupported inline requests cannot read credentials");
    assert.equal(f.providerRequests.length, inlineSends, "unsupported inline requests cannot send");
    const beforeReads = f.secretReads;
    for (const body of [
      { ...wire.request, tools: [...wire.request.tools, ...wire.refusedTools] },
      { ...wire.request, tools: [{ type: "mcp", server_url: "https://remote.example.test" }] },
      { ...wire.request, tools: [{ type: "namespace", name: "remote", tools: wire.refusedTools }] },
      { ...wire.request, tools: [{ ...wire.request.tools[0], strict: null }] },
      { ...wire.request, previous_response_id: "unadmitted-state" },
      {
        ...wire.request,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "https://remote.example.test/image" }],
          },
        ],
      },
      { ...wire.request, client_metadata: { namespace_id: f.namespace.id } },
    ]) {
      assert.ok((await f.resolve(f.capture(body))).refused);
    }
    assert.equal(
      f.secretReads,
      beforeReads,
      "unsupported provider operations cannot read credentials",
    );

    const split = [...responseEvents()];
    const deltaIndex = split.findIndex((event) => event.type === "response.output_text.delta");
    const delta = split[deltaIndex];
    assert.ok(delta && "delta" in delta, "captured output text delta");
    split.splice(
      deltaIndex,
      1,
      { ...delta, delta: "synthetic-key-" },
      { ...delta, delta: "initial" },
    );
    const switched: { type: string }[] = [...responseEvents()];
    const firstMessage = switched
      .slice(1, -1)
      .map((event) => parsedEvent(JSON.stringify(event).replaceAll("READY", "synthetic-key-")));
    const secondMessage = switched.slice(1, -1).map((event) => ({
      ...parsedEvent(
        JSON.stringify(event)
          .replaceAll("READY", "initial")
          .replaceAll("msg_runtime_probe", "msg_second"),
      ),
      output_index: 1,
    }));
    switched.splice(1, switched.length - 2, ...firstMessage, ...secondMessage);
    // Keep the terminal snapshot harmless so only cross-item deltas trigger refusal.
    await check.events(
      switched,
      true,
      "OutputTextDelta drops item IDs, so the consumer-observable concatenation must be scanned",
    );
    // Function arguments have a protocol-defined JSON layer, including when
    // unicode escapes straddle deltas. A harmless terminal snapshot cannot erase
    // arguments that a local tool consumer already accumulated.
    const functionEvents = (argumentsText: string) => {
      const item = {
        type: "function_call",
        id: "fc_local",
        call_id: "call_local",
        name: "fixture_function_0",
        arguments: argumentsText,
        status: "completed",
      } satisfies ItemEvent["item"] & { call_id: string; name: string; status: string };
      const end = structuredClone(wire.responseEvents[7]);
      end.response.output = [item];
      return [
        structuredClone(wire.responseEvents[0]),
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, arguments: "", status: "in_progress" },
        },
        ...splitText(argumentsText).map((delta) => ({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta,
        })),
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: item.id,
          arguments: argumentsText,
        },
        { type: "response.output_item.done", output_index: 0, item },
        end,
      ];
    };
    const safeFunction = functionEvents('{"cmd":"printf READY"}');
    await check.events(
      safeFunction,
      false,
      "ordinary Harness-local function tools remain supported",
    );
    // Providers can omit argument deltas. The two completion events must still agree
    // on which arguments the Harness would execute.
    const withoutDeltas = structuredClone(safeFunction);
    withoutDeltas.splice(2, 2);
    await check.events(withoutDeltas, false, "function call without argument deltas");
    const argumentDone = withoutDeltas[2];
    assert.ok(argumentDone && "arguments" in argumentDone, "function argument completion");
    argumentDone.arguments = '{"cmd":"different arguments"}';
    await check.events(
      withoutDeltas,
      true,
      "function_call_arguments.done and output_item.done cannot disagree about the arguments",
    );
    const escapedCredential = unicodeEscapes("synthetic-key-initial");
    const escapedFunction = functionEvents('{"cmd":"' + escapedCredential + '"}');
    const disguisedFunction = structuredClone(escapedFunction);
    disguisedFunction.splice(4, 1);
    const disguisedDone = disguisedFunction.at(-2);
    const disguisedEnd = disguisedFunction.at(-1);
    assert.ok(
      disguisedDone && "item" in disguisedDone && disguisedDone.item.type === "function_call",
      "function item completion",
    );
    assert.ok(disguisedEnd && "response" in disguisedEnd, "function response completion");
    disguisedDone.item.arguments = '{"cmd":"printf READY"}';
    disguisedEnd.response.output = [];
    const wrongAssociation = structuredClone(safeFunction);
    const associatedDelta = wrongAssociation[3];
    assert.ok(associatedDelta && "item_id" in associatedDelta, "function argument delta");
    associatedDelta.item_id = "fc_unassociated";
    const afterDone = structuredClone(safeFunction);
    const firstDelta = safeFunction[2];
    assert.ok(firstDelta, "first function argument delta");
    afterDone.splice(-1, 0, firstDelta);
    for (const events of [
      escapedFunction,
      disguisedFunction,
      wrongAssociation,
      afterDone,
      functionEvents('{"cmd":"unterminated'),
      functionEvents('{"cmd":"ok","cmd":"other"}'),
    ]) {
      await check.events(
        events,
        true,
        "argument decoding, item association and completion all precede release",
      );
    }
    const remote = responseEvents();
    const remoteEvents = [
      remote[0],
      { ...remote[1], item: { type: "web_search_call", id: "remote-effect", status: "completed" } },
      ...remote.slice(2),
    ];
    const wrongModel = responseEvents();
    wrongModel[7].response.model = "unadmitted-model";
    for (const unsafe of [
      encode(wire.responseEvents.slice(0, -1)),
      encode(split),
      encode(remoteEvents),
      encode(wrongModel),
      body + 'event: response.future_event\ndata: {"type":"response.future_event"}\n\n',
      body.replace('"delta":"READY"', '"delta":"synthetic-key-initial","delta":"READY"'),
      body.replace("event: response.created", "event: response.completed"),
      ":ignored\rcomment\n" + body,
      body.replace("\n\n", "\n\n\n"),
      body.replace(/\n\n$/, "\n"),
    ]) {
      await check.wireBody(unsafe, { blocked: true });
    }
  });

  // A streamed response from the provider carries its full documented envelope on
  // response.created, response.in_progress and response.completed. The shape follows
  // openai-python src/openai/types/responses/response.py at
  // 0f73f1d519f8719b226e9084d78c8bdb4a60e48f (2026-10-12) for the request fields the
  // bounded inference policy admits; the fixture envelope only ever carried the minimum.
  function liveResponsesEnvelope(status: "in_progress" | "completed") {
    return {
      id: "resp_live_shaped",
      object: "response",
      created_at: 1791985502.0,
      status,
      background: false,
      billing: { payer: "developer" },
      completed_at: status === "completed" ? 1791985503.0 : null,
      conversation: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      max_tool_calls: null,
      model: wire.request.model,
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: wire.request.prompt_cache_key,
      prompt_cache_retention: null,
      reasoning: { effort: "medium", summary: "auto" },
      safety_identifier: null,
      service_tier: "default",
      store: false,
      temperature: 1.0,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "auto",
      tools: wire.request.tools,
      top_logprobs: 0,
      top_p: 1.0,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {},
    };
  }

  test("live-shaped Responses envelopes pass while undeclared or credential-bearing envelope fields refuse", async (t) => {
    const f = await staticEgressFixture(t);
    const check = responseChecks(f);
    const base = responseEvents();
    const capturedCompleted = structuredClone(base[7]);
    assert.ok(capturedCompleted.response.usage, "captured completed token counts");
    const completed = {
      ...capturedCompleted,
      response: {
        ...liveResponsesEnvelope("completed"),
        output: capturedCompleted.response.output,
        usage: {
          ...capturedCompleted.response.usage,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      },
    };
    const live = [
      {
        type: "response.created",
        sequence_number: 0,
        response: liveResponsesEnvelope("in_progress"),
      },
      {
        type: "response.in_progress",
        sequence_number: 1,
        response: liveResponsesEnvelope("in_progress"),
      },
      ...base.slice(1, -1).map((event, index) => ({ ...event, sequence_number: index + 2 })),
      { ...completed, sequence_number: base.length + 1 },
    ];
    await check.events(live, false, "documented envelope fields on every envelope event");
    // The provider reports its effective image policy even when the request omits it.
    // Check each envelope event and preserve its original bytes through signed egress.
    const withImage = (image: ExchangeRequest[string]) =>
      live.map((event) =>
        "response" in event ? { ...event, response: { ...event.response, image } } : event,
      );
    for (const context_compression of ["enabled", "disabled"]) {
      await check.events(
        withImage({ context_compression }),
        false,
        `documented image context compression: ${context_compression}`,
      );
    }
    for (const [label, image] of [
      ["null image policy", null],
      ["missing image context compression", {}],
      ["request-only automatic image policy", { context_compression: "auto" }],
      ["wrong image context compression type", { context_compression: true }],
      ["unknown image policy member", { context_compression: "enabled", extra: false }],
      ["image policy reflects selected material", { context_compression: selectedMaterial }],
    ] satisfies [string, ExchangeRequest[string]][]) {
      await check.events(withImage(image), true, label);
    }
    // The admitted local declarations omit optional fields. Responses may echo their
    // documented null defaults; they must not turn an otherwise valid turn into a 502.
    const functionTool = {
      type: "function",
      name: "fixture_local",
      parameters: { type: "object", properties: {} },
    };
    const customTool = { type: "custom", name: "fixture_custom" };
    const namespaceTool = {
      type: "namespace",
      name: "fixture_namespace",
      tools: [functionTool, customTool],
    };
    const localTools = [functionTool, customTool, namespaceTool];
    const localRequest = { ...wire.request, tools: localTools };
    const responseFunction = {
      ...functionTool,
      description: null,
      strict: null,
      defer_loading: null,
    };
    const responseCustom = { ...customTool, description: null, defer_loading: null, format: null };
    const echoedTools = [
      responseFunction,
      responseCustom,
      { ...namespaceTool, tools: [responseFunction, responseCustom] },
    ];
    const withTools = (tools: ExchangeRequest[string]) =>
      live.map((event) =>
        "response" in event ? { ...event, response: { ...event.response, tools } } : event,
      );
    await check.events(
      withTools(echoedTools),
      false,
      "nullable local-tool response defaults",
      true,
      localRequest,
    );
    for (const [label, tools] of [
      ["wrong strict type", [{ ...responseFunction, strict: "false" }]],
      ["wrong description type", [{ ...responseCustom, description: {} }]],
      ["wrong defer_loading type", [{ ...responseFunction, defer_loading: 0 }]],
      ["unknown custom format", [{ ...responseCustom, format: { type: "remote" } }]],
      ["unknown function field", [{ ...responseFunction, remote_execution: true }]],
      ["hosted tool", [{ type: "web_search" }]],
      ["nested hosted tool", [{ ...namespaceTool, tools: [{ type: "web_search" }] }]],
    ] satisfies [string, ExchangeRequest[string]][]) {
      await check.events(withTools(tools), true, label, true, localRequest);
    }
    // Documented fields that the admitted request cannot ask for still have to be absent,
    // and documented optional structures are typed, not free-form.
    const nullableStructures = structuredClone(live);
    const nullableEnd = nullableStructures.at(-1);
    assert.ok(nullableEnd && "response" in nullableEnd, "live response completion");
    Object.assign(nullableEnd.response, {
      access_programs: { cyber: "standard" },
      prompt_cache_diagnostics: { type: "cache_hit" },
      prompt_cache_options: { mode: "implicit", ttl: "30m", comparison_response_id: null },
      reasoning: null,
      incomplete_details: { reason: null },
      error: null,
      text: null,
      moderation: null,
      prompt: null,
    });
    await check.events(nullableStructures, false, "typed optional envelope structures");
    const withEnvelope = (fields: object) => {
      const events = structuredClone(live);
      const first = events[0];
      assert.ok(first && "response" in first, "live response creation");
      Object.assign(first.response, fields);
      return events;
    };
    for (const [label, fields] of [
      ["undeclared envelope field", { x_future_field: 0 }],
      ["undeclared field carrying the selected material", { debug: selectedMaterial }],
      [
        "declared text field reflecting the selected material",
        { safety_identifier: selectedMaterial },
      ],
      ["declared text field reflecting encoded material", { user: reflectedMaterial[1] }],
      ["undeclared structure member", { billing: { payer: "developer", token: "x" } }],
      ["undeclared conversation state", { conversation: { id: "conv_unadmitted" } }],
      ["undeclared prior response state", { previous_response_id: "resp_unadmitted" }],
      ["prompt template reference", { prompt: { id: "pmpt_unadmitted" } }],
      ["moderation result", { moderation: { input: { type: "error", code: "x", message: "y" } } }],
      ["wrong top_logprobs type", { top_logprobs: "0" }],
      ["unknown access program", { access_programs: { cyber: "unknown" } }],
      ["unknown cache diagnostic", { prompt_cache_diagnostics: { type: "future" } }],
      ["background execution", { background: true }],
    ] satisfies [string, object][]) {
      await check.events(withEnvelope(fields), true, label);
    }
  });
}
