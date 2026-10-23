import { asRecord } from "@openclaw-enterprise/utils";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import {
  isResponsesEvent,
  type ItemContentEvent,
  type ItemEvent,
  type ResponseOutputContent,
  type ResponsesEvent,
} from "./openai-responses.ts";

import {
  AssistantPlanStream,
  completedAssistantPlan,
  withoutCitations,
} from "./openai-assistant-projections.ts";

type Scan = (value: unknown) => boolean;

interface ResponseProtection {
  scan: Scan;
  leaked: (text: string) => boolean;
  fragmentOverlap: number;
}

// A refusal part's text is shown to the Agent like output_text, so it is protected alike.
function partText(part: ResponseOutputContent): string {
  return part.type === "refusal" ? part.refusal : part.text;
}

// The supported assistant consumer joins message parts without a delimiter.
function assistantText(parts: readonly ResponseOutputContent[]): string {
  return parts.map(partText).join("");
}

function withoutPlan(text: string): string {
  if (!text.includes("<proposed_plan>")) {
    return text;
  }
  const visible: string[] = [];
  let active = false;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(start, end);
    // Rust str::trim uses Unicode White_Space (unlike JavaScript trim).
    let left = 0;
    let right = line.length;
    while (left < right && /\p{White_Space}/u.test(line[left]!)) {
      left++;
    }
    while (right > left && /\p{White_Space}/u.test(line[right - 1]!)) {
      right--;
    }
    const slug = line.slice(left, right);
    if (!active && slug === "<proposed_plan>") {
      active = true;
    } else if (active && slug === "</proposed_plan>") {
      active = false;
    } else if (!active) {
      visible.push(line);
    }
    start = end;
  }
  return visible.join("");
}

function protectedAssistantText(text: string, scan: Scan): boolean {
  if (!scan(text)) {
    return false;
  }
  const cited = withoutCitations(text);
  if (cited !== text && !scan(cited)) {
    return false;
  }
  const visible = withoutPlan(cited);
  return visible === cited || scan(visible);
}

// Decode exactly the JSON layer defined for function arguments. Strings inside
// that object remain strings; this is not a general-purpose encoding decoder.
const maximumArgumentBytes = 1024 * 1024;
function protectedArguments(text: string, scan: Scan): boolean {
  if (Buffer.byteLength(text) > maximumArgumentBytes) {
    return false;
  }
  const argumentsObject = asRecord(parseUnambiguousJson(text));
  return argumentsObject !== undefined && scan(argumentsObject);
}

export function protectedResponseOutput(value: unknown, scan: Scan): boolean {
  const output = asRecord(value)?.output;
  if (!Array.isArray(output)) {
    return true;
  }
  const messages: string[] = [];
  for (const entry of output) {
    const item = asRecord(entry);
    if (
      item?.type === "function_call" &&
      (typeof item.arguments !== "string" || !protectedArguments(item.arguments, scan))
    ) {
      return false;
    }
    if (item?.type === "message" && Array.isArray(item.content)) {
      const parts: string[] = [];
      for (const entry of item.content) {
        const part = asRecord(entry);
        if (part?.type === "output_text" && typeof part.text === "string") {
          parts.push(part.text);
        } else if (part?.type === "refusal" && typeof part.refusal === "string") {
          parts.push(part.refusal);
        }
      }
      // Citation and Plan visibility start afresh for each completed assistant message.
      const text = parts.join("");
      const plan = completedAssistantPlan(text);
      if ((plan !== undefined && !scan(plan)) || !protectedAssistantText(text, scan)) {
        return false;
      }
      messages.push(text);
    }
  }
  // Responses clients also concatenate output_text across messages without a delimiter.
  return messages.length < 2 || protectedAssistantText(messages.join(""), scan);
}

/** Inspect the entire bounded response before the provider releases its original bytes. */
export function protectedResponsesStream(
  body: string,
  model: string,
  policy: ResponseProtection,
): boolean {
  const stream = new ResponsesStream(policy);
  let eventCount = 0;
  for (const { name, data } of eventFrames(body)) {
    if (++eventCount > 16_384) {
      return false;
    }
    const event = parseUnambiguousJson(data);
    if (
      !isResponsesEvent(event, model) ||
      (name !== undefined && name !== event.type) ||
      !policy.scan(event) ||
      !stream.accept(event)
    ) {
      return false;
    }
  }
  return stream.complete;
}

// Only comments, event and data fields are admitted. Unlike a browser EventSource,
// never discard an unknown field or unfinished frame, or accept a bare carriage return.
function* eventFrames(body: string): Generator<{ name: string | undefined; data: string }> {
  if (!body.endsWith("\n\n") && !body.endsWith("\n\r\n")) {
    throw new Error("Expected a complete Responses event frame.");
  }
  let name: string | undefined;
  const data: string[] = [];
  let start = 0;
  let hasField = false;
  while (start < body.length) {
    const end = body.indexOf("\n", start);
    const line = body.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (line.includes("\r")) {
      throw new Error("Unexpected carriage return in Responses event.");
    }
    if (line === "") {
      if (!hasField) {
        throw new Error("Unexpected empty Responses event frame.");
      }
      if (data.length > 0) {
        yield { name, data: data.join("\n") };
      } else if (name !== undefined) {
        throw new Error("Responses event has a name but no data.");
      }
      name = undefined;
      data.length = 0;
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:") && name === undefined) {
      name = line.slice(6).replace(/^ /, "");
    } else if (!line.startsWith(":")) {
      throw new Error("Unsupported Responses event field.");
    }
    hasField = line !== "";
  }
}

interface TrackedItem {
  id: string;
  type: ItemEvent["item"]["type"];
  done: boolean;
  argumentDeltas: string[];
  argumentBytes: number;
  completedArguments?: string;
  textTails: string[];
}

interface AssistantConsumer {
  chunks: string[];
  plan: AssistantPlanStream;
}

class ResponsesStream {
  private readonly policy: ResponseProtection;
  private readonly items = new Map<number, TrackedItem>();
  private readonly itemIds = new Set<string>();
  private readonly fragments = new Map<string, string>();
  private assistant: AssistantConsumer | undefined;
  private readonly assistants = new Set<AssistantConsumer>();
  private readonly planDeltas: string[] = [];
  private planCompleted = false;
  private responseId?: string;
  private sequence = -1;
  private terminal = false;

  constructor(policy: ResponseProtection) {
    this.policy = policy;
  }

  get complete(): boolean {
    return this.terminal && [...this.items.values()].every((item) => item.done);
  }

  accept(event: ResponsesEvent): boolean {
    if (
      this.terminal ||
      (event.sequence_number !== undefined && event.sequence_number <= this.sequence)
    ) {
      return false;
    }
    this.sequence = event.sequence_number ?? this.sequence;
    if ("response" in event) {
      const { id, status } = event.response;
      if (this.responseId !== undefined && id !== this.responseId) {
        return false;
      }
      // The closed event schema binds the event name to this exact response status.
      this.terminal = status === "completed" || status === "failed" || status === "incomplete";
      // The SDK initializes its output from this envelope and then appends items.
      // A seeded initial output would make event indexes ambiguous.
      if (this.responseId === undefined && !this.terminal && event.response.output.length !== 0) {
        return false;
      }
      this.responseId = id;
      return (
        (!this.terminal || this.finishResponse()) &&
        protectedResponseOutput(event.response, this.policy.scan)
      );
    }
    return "item" in event ? this.outputItem(event) : this.itemContent(event);
  }

  private finishAssistant(): boolean {
    const assistant = this.assistant;
    this.assistant = undefined;
    if (assistant === undefined) {
      return true;
    }
    assistant.plan.finish();
    this.assistants.delete(assistant);
    return protectedAssistantText(assistant.chunks.join(""), this.policy.scan);
  }

  private finishResponse(): boolean {
    // Displaced parsers drain in unspecified map order in the consumer. One
    // nonempty Plan tail is unambiguous; multiple tails cannot be ordered safely.
    let planTails = 0;
    for (const assistant of this.assistants) {
      const before = this.planDeltas.length;
      this.assistant = assistant;
      if (!this.finishAssistant()) {
        return false;
      }
      if (this.planDeltas.length !== before && ++planTails > 1) {
        return false;
      }
    }
    return this.policy.scan(this.planDeltas.join(""));
  }

  private outputItem({ type, output_index, item }: ItemEvent): boolean {
    const text = item.type === "message" ? assistantText(item.content) : undefined;
    if (text !== undefined && !protectedAssistantText(text, this.policy.scan)) {
      return false;
    }
    const tracked = this.items.get(output_index);
    if (type === "response.output_item.added") {
      if (
        tracked ||
        this.itemIds.has(item.id) ||
        output_index !== this.items.size ||
        this.items.size >= 4096
      ) {
        return false;
      }
      // Assistant deltas have no item/content IDs in the supported consumer.
      // They extend the active message's joined seed, not an indexed part.
      if (text !== undefined || item.type === "reasoning") {
        this.assistant = undefined;
        if (text !== undefined) {
          const assistant: AssistantConsumer = {
            chunks: [text],
            plan: new AssistantPlanStream((delta) => {
              if (!this.planCompleted) {
                this.planDeltas.push(delta);
              }
            }),
          };
          this.assistants.add(assistant);
          this.assistant = assistant;
          assistant.plan.push(text);
        }
      }
      this.itemIds.add(item.id);
      this.items.set(output_index, {
        id: item.id,
        type: item.type,
        done: false,
        argumentDeltas: [],
        argumentBytes: 0,
        textTails:
          item.type === "message"
            ? item.content.map((part) => partText(part).slice(-this.policy.fragmentOverlap))
            : [],
      });
      return (
        item.type !== "function_call" ||
        item.arguments === "" ||
        protectedArguments(item.arguments, this.policy.scan)
      );
    }
    if (!tracked || tracked.done || tracked.id !== item.id || tracked.type !== item.type) {
      return false;
    }
    if (!this.finishAssistant()) {
      return false;
    }
    if (text !== undefined) {
      const plan = completedAssistantPlan(text);
      if (plan !== undefined) {
        if (!this.policy.scan(plan)) {
          return false;
        }
        this.planCompleted = true;
      }
    }
    tracked.done = true;
    return (
      item.type !== "function_call" || argumentsMatch(tracked, item.arguments, this.policy.scan)
    );
  }

  private itemContent(event: ItemContentEvent): boolean {
    const item = this.items.get(event.output_index);
    if (!item || item.done || item.id !== event.item_id) {
      return false;
    }
    // Refusal text is assistant-visible like output_text: one joined stream for both.
    const assistantDelta =
      event.type === "response.output_text.delta" || event.type === "response.refusal.delta";
    if (assistantDelta && event.delta !== undefined) {
      this.assistant?.chunks.push(event.delta);
      this.assistant?.plan.push(event.delta);
    }
    if (event.delta !== undefined) {
      // Codex exposes output deltas without item IDs. Protect the concatenation the
      // consumer sees, including across two distinct, otherwise valid output items.
      const key = assistantDelta ? "response.output_text.delta" : event.type;
      const text = (this.fragments.get(key) ?? "") + event.delta;
      if (this.policy.leaked(text)) {
        return false;
      }
      this.fragments.set(key, text.slice(-this.policy.fragmentOverlap));
    }
    if (event.type.startsWith("response.function_call_arguments.")) {
      return item.type === "function_call" && acceptArguments(item, event, this.policy.scan);
    }
    if (event.type.startsWith("response.reasoning_")) {
      return item.type === "reasoning";
    }
    if (event.type.startsWith("response.custom_tool_call_input.")) {
      return item.type === "custom_tool_call";
    }
    if (item.type !== "message" || event.content_index === undefined) {
      return false;
    }
    if (event.type === "response.content_part.added") {
      // Added parts append in the SDK; accepting a duplicate or a gap would
      // make the indexed delta target a different part than the one tracked.
      if (event.content_index !== item.textTails.length || !event.part) {
        return false;
      }
      item.textTails.push(partText(event.part).slice(-this.policy.fragmentOverlap));
      return true;
    }
    const previous = item.textTails[event.content_index];
    if (previous === undefined) {
      return false;
    }
    if (
      (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") &&
      event.delta !== undefined
    ) {
      const snapshot = previous + event.delta;
      if (this.policy.leaked(snapshot)) {
        return false;
      }
      item.textTails[event.content_index] = snapshot.slice(-this.policy.fragmentOverlap);
    }
    // Completion events do not replace the SDK's accumulated snapshot.
    return true;
  }
}

function acceptArguments(item: TrackedItem, event: ItemContentEvent, scan: Scan): boolean {
  if (item.completedArguments !== undefined) {
    return false;
  }
  if (event.delta !== undefined) {
    item.argumentBytes += Buffer.byteLength(event.delta);
    if (item.argumentBytes > maximumArgumentBytes) {
      return false;
    }
    item.argumentDeltas.push(event.delta);
    return true;
  }
  if (event.arguments === undefined || !argumentsMatch(item, event.arguments, scan)) {
    return false;
  }
  item.completedArguments = event.arguments;
  return true;
}

// A snapshot may arrive with no deltas, or the argument .done event may be omitted.
// Decode the exact arguments assembled by the consumer and require snapshots to agree.
function argumentsMatch(item: TrackedItem, text: string, scan: Scan): boolean {
  if (item.completedArguments !== undefined) {
    return text === item.completedArguments;
  }
  return (
    (item.argumentDeltas.length === 0 || text === item.argumentDeltas.join("")) &&
    protectedArguments(text, scan)
  );
}
