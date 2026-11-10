import { asRecord } from "@openclaw-enterprise/utils";
import { parseUnambiguousJson } from "../repo/access/json-members.ts";

// Closed provider-owned schemas. Local tool schemas describe data for the Harness;
// provider-executed tools and remote references require a different admitted grant.
type Validator = (value: unknown) => boolean;
const text: Validator = (value) => typeof value === "string" && value.length <= 1024 * 1024;
const name: Validator = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const bool: Validator = (value) => typeof value === "boolean";
const number: Validator = (value) => typeof value === "number" && Number.isFinite(value);
const integer: Validator = (value) =>
  number(value) && Number.isSafeInteger(value) && Number(value) >= 0;
const oneOf =
  (...values: readonly unknown[]): Validator =>
  (value) =>
    values.includes(value);
const nullable =
  (check: Validator): Validator =>
  (value) =>
    value === null || check(value);
const array =
  (check: Validator, maximum = 4096, minimum = 0): Validator =>
  (value) =>
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(check);
type Fields = Readonly<Record<string, Validator>>;
function object(required: Fields, optional: Fields = {}): Validator {
  const fields = { ...optional, ...required };
  const keys = Object.keys(required);
  return (value) => {
    const record = asRecord(value);
    return (
      record !== undefined &&
      keys.every((key) => Object.hasOwn(record, key)) &&
      Object.entries(record).every(
        ([key, item]) => Object.hasOwn(fields, key) && fields[key]!(item),
      )
    );
  };
}

const optionalFields = (fields: Fields): Validator => object({}, fields);

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) {
    return false;
  }
  if (value === null || typeof value === "boolean" || text(value) || number(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 1024 && value.every((item) => jsonValue(item, depth + 1));
  }
  const record = asRecord(value);
  return (
    record !== undefined &&
    Object.keys(record).length <= 256 &&
    Object.values(record).every((item) => jsonValue(item, depth + 1))
  );
}

function jsonSchema(value: unknown, depth = 0, localTool = false): boolean {
  if (depth > 16) {
    return false;
  }
  const nested = (item: unknown) => jsonSchema(item, depth + 1, localTool);
  const definitions: Validator = (item) => {
    const record = asRecord(item);
    return (
      record !== undefined &&
      Object.keys(record).length <= 256 &&
      Object.entries(record).every(([key, schema]) => text(key) && nested(schema))
    );
  };
  const type = oneOf("object", "array", "string", "number", "integer", "boolean", "null");
  return optionalFields({
    type: (item) => type(item) || array(type, 7)(item),
    properties: definitions,
    required: array(text, 256),
    additionalProperties: (item) => bool(item) || nested(item),
    items: nested,
    anyOf: array(nested, 64),
    oneOf: array(nested, 64),
    allOf: array(nested, 64),
    enum: array((item) => jsonValue(item), 1024),
    const: (item) => jsonValue(item),
    description: text,
    title: text,
    default: (item) => jsonValue(item),
    minimum: number,
    maximum: number,
    exclusiveMinimum: number,
    exclusiveMaximum: number,
    multipleOf: (item) => number(item) && Number(item) > 0,
    minLength: integer,
    maxLength: integer,
    // A local string-parameter annotation, not a grant or an encryption operation.
    ...(localTool
      ? { encrypted: (item: unknown) => item === true && asRecord(value)?.type === "string" }
      : {}),
    minItems: integer,
    maxItems: integer,
    minProperties: integer,
    maxProperties: integer,
    uniqueItems: bool,
    pattern: text,
    format: text,
    $defs: definitions,
    $ref: (item) => typeof item === "string" && /^#\/\$defs\/[a-zA-Z0-9_.-]+$/.test(item),
    $schema: oneOf(
      "https://json-schema.org/draft/2020-12/schema",
      "http://json-schema.org/draft-07/schema#",
    ),
  })(value);
}

const functionTool = object(
  { type: oneOf("function"), name, parameters: (value) => jsonSchema(value, 0, true) },
  { description: text, strict: bool, defer_loading: bool },
);
const plainTextFormat = object({ type: oneOf("text") });
const grammarFormat = object({
  type: oneOf("grammar"),
  syntax: oneOf("lark", "regex"),
  definition: text,
});
const customTool = object(
  { type: oneOf("custom"), name },
  {
    description: text,
    defer_loading: bool,
    format: (value) => plainTextFormat(value) || grammarFormat(value),
  },
);
const localTool: Validator = (value) => functionTool(value) || customTool(value);
const namespaceTool = object(
  { type: oneOf("namespace"), name, tools: array(localTool, 128) },
  { description: text },
);
const tools = array((value) => localTool(value) || namespaceTool(value), 128);
// Response echoes may contain documented null defaults for local-tool metadata.
// Keep these separate from request admission and retain the same bounded schemas.
const responseFunctionTool = object(
  { type: oneOf("function"), name, parameters: (value) => jsonSchema(value, 0, true) },
  { description: nullable(text), strict: nullable(bool), defer_loading: nullable(bool) },
);
const responseCustomTool = object(
  { type: oneOf("custom"), name },
  {
    description: nullable(text),
    defer_loading: nullable(bool),
    format: nullable((value) => plainTextFormat(value) || grammarFormat(value)),
  },
);
const responseLocalTool: Validator = (value) =>
  responseFunctionTool(value) || responseCustomTool(value);
const responseNamespaceTool = object(
  { type: oneOf("namespace"), name, tools: array(responseLocalTool, 128) },
  { description: text },
);
const responseTools = array(
  (value) => responseLocalTool(value) || responseNamespaceTool(value),
  128,
);

const toolChoice = oneOf("auto", "none", "required");

const textPart = object({ type: oneOf("input_text", "output_text"), text });
const contentParts = array(textPart);
const content: Validator = (value) => text(value) || contentParts(value);
const phase = oneOf("commentary", "partial_answer", "final_answer");
const status = oneOf("in_progress", "completed", "incomplete");
const summary = object({ type: oneOf("summary_text"), text });
const inputMessage = object(
  { role: oneOf("system", "developer", "user", "assistant"), content },
  { type: oneOf("message"), id: text, phase, status },
);
const reasoningItem = object(
  { type: oneOf("reasoning"), summary: array(summary) },
  {
    id: text,
    content: array(object({ type: oneOf("reasoning_text"), text })),
    encrypted_content: nullable(text),
    status,
  },
);
const toolOutput = object(
  {
    type: oneOf("function_call_output", "custom_tool_call_output"),
    call_id: text,
    output: content,
  },
  { id: text, name, namespace: name },
);
const toolCall: Validator = (value) => {
  const type = asRecord(value)?.type;
  if (type !== "function_call" && type !== "custom_tool_call") {
    return false;
  }
  const field = type === "function_call" ? "arguments" : "input";
  return object(
    { type: oneOf(type), call_id: text, name, [field]: text },
    { id: text, namespace: name, status },
  )(value);
};
// Codex can declare the same local tools in developer input instead of the top-level list.
const additionalLocalTools = object(
  { type: oneOf("additional_tools"), role: oneOf("developer"), tools },
  { id: text },
);
const inputItems = array(
  (item) =>
    inputMessage(item) ||
    reasoningItem(item) ||
    toolCall(item) ||
    toolOutput(item) ||
    additionalLocalTools(item),
);

const reasoningEffort = oneOf("none", "minimal", "low", "medium", "high", "xhigh");
const reasoning = optionalFields({
  effort: reasoningEffort,
  summary: oneOf("auto", "concise", "detailed"),
  context: oneOf("auto", "current_turn", "all_turns"),
});

const metadataText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 8192;
function metadataJson(schema: Validator): Validator {
  return (value) => {
    if (!metadataText(value)) {
      return false;
    }
    try {
      return schema(parseUnambiguousJson(value));
    } catch {
      return false;
    }
  };
}

const gitRemoteUrls: Validator = (value) => {
  const remotes = Object.entries(asRecord(value) ?? {});
  return (
    remotes.length >= 1 &&
    remotes.length <= 16 &&
    remotes.every(
      ([remote, url]) =>
        /^[A-Za-z0-9_.-]{1,256}$/u.test(remote) &&
        typeof url === "string" &&
        url.length <= 2048 &&
        ((/^[Hh][Tt][Tt][Pp][Ss]:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u.test(
          url,
        ) &&
          URL.canParse(url)) ||
          /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~/-]+$/u.test(url)),
    )
  );
};
const gitWorkspace = optionalFields({
  latest_git_commit_hash: (value) =>
    typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
  has_changes: bool,
  associated_remote_urls: gitRemoteUrls,
});
const gitWorkspaces: Validator = (value) => {
  const roots = Object.entries(asRecord(value) ?? {});
  return (
    roots.length === 1 &&
    roots.every(
      ([root, metadata]) =>
        root.startsWith("/") &&
        root.length <= 4096 &&
        !/[\p{Cc}]/u.test(root) &&
        Object.keys(asRecord(metadata) ?? {}).length > 0 &&
        gitWorkspace(metadata),
    )
  );
};
// These are telemetry fields emitted by the selected client, never OCC identities or grants.
const clientMetadata = optionalFields({
  mcp_attribution: metadataJson(object({ status: oneOf("none") })),
  session_id: metadataText,
  thread_id: metadataText,
  turn_id: metadataText,
  parent_turn_id: metadataText,
  root_turn_id: metadataText,
  "x-codex-installation-id": metadataText,
  "x-codex-window-id": metadataText,
  "x-codex-parent-thread-id": metadataText,
  "x-openai-subagent": metadataText,
  "x-codex-turn-metadata": metadataJson(
    optionalFields({
      installation_id: metadataText,
      session_id: metadataText,
      thread_id: metadataText,
      agent_name: metadataText,
      turn_id: metadataText,
      window_id: metadataText,
      window_number: integer,
      context_window_id: metadataText,
      request_kind: oneOf("turn", "prewarm", "compaction", "memory"),
      history_initialization: metadataText,
      root_turn_id: metadataText,
      parent_turn_id: metadataText,
      parent_thread_id: metadataText,
      forked_from_thread_id: metadataText,
      forked_from_ordinal_exclusive: integer,
      thread_source: metadataText,
      turn_trigger: metadataText,
      subagent_kind: metadataText,
      sandbox: metadataText,
      sandbox_mode: metadataText,
      auto_review_enabled: bool,
      node_repl_auto_review_required: bool,
      node_repl_disabled: bool,
      turn_started_at_unix_ms: integer,
      analytics_enabled: bool,
      history_ingest_requested: bool,
      model: metadataText,
      reasoning_effort: reasoningEffort,
      workspaces: gitWorkspaces,
    }),
  ),
});
const jsonFormat = object(
  { type: oneOf("json_schema"), name, schema: jsonSchema },
  { description: text, strict: bool },
);
const textSettings = optionalFields({
  verbosity: oneOf("low", "medium", "high"),
  format: (value) => plainTextFormat(value) || jsonFormat(value),
});

export const validResponsesRequest = object(
  { model: text, input: (value) => text(value) || inputItems(value), store: oneOf(false) },
  {
    instructions: text,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: bool,
    reasoning: nullable(reasoning),
    stream: bool,
    stream_options: optionalFields({
      include_usage: bool,
      include_obfuscation: bool,
      reasoning_summary_delivery: oneOf("sequential_cutoff"),
    }),
    include: array(oneOf("reasoning.encrypted_content"), 1),
    service_tier: oneOf("auto", "default", "flex", "priority"),
    prompt_cache_key: text,
    client_metadata: clientMetadata,
    text: textSettings,
    temperature: (value) => number(value) && Number(value) >= 0 && Number(value) <= 2,
    top_p: (value) => number(value) && Number(value) >= 0 && Number(value) <= 1,
    max_output_tokens: (value) => integer(value) && Number(value) > 0,
  },
);

// The legacy Chat surface accepts plain message strings and no tools.
const chatNumber: Validator = (value) => number(value) && Number(value) >= 0;
const chatMessages = array(
  object({
    role: (value) => ["system", "user", "assistant"].includes(String(value)),
    content: (value) => typeof value === "string",
  }),
  128,
  1,
);
export const validChatRequest = object(
  {
    model: (value) => typeof value === "string",
    messages: chatMessages,
  },
  {
    stream: oneOf(false),
    store: oneOf(false),
    temperature: chatNumber,
    top_p: chatNumber,
    max_completion_tokens: chatNumber,
  },
);

const empty = array(() => false, 0);
const outputText = object(
  { type: oneOf("output_text"), text },
  { annotations: empty, logprobs: empty },
);
// A provider safety refusal arrives as a documented `refusal` part of the assistant message
// (openai-python ResponseOutputRefusal). Its text is assistant-visible, so the stream scans
// it like output_text.
const outputRefusal = object({ type: oneOf("refusal"), refusal: text });
const outputContent: Validator = (value) => outputText(value) || outputRefusal(value);
const outputMessage = object(
  { type: oneOf("message"), id: text, role: oneOf("assistant"), content: array(outputContent) },
  { status, phase },
);
const outputItem: Validator = (value) =>
  outputMessage(value) || reasoningItem(value) || toolCall(value);
const usage = object(
  { input_tokens: integer, output_tokens: integer, total_tokens: integer },
  {
    input_tokens_details: optionalFields({ cached_tokens: integer, cache_write_tokens: integer }),
    output_tokens_details: optionalFields({ reasoning_tokens: integer }),
  },
);
const error = object(
  { message: text },
  {
    code: nullable(text),
    type: nullable(text),
    param: nullable(text),
    misalignment: nullable(
      optionalFields({
        detailed_explanation: nullable(text),
        error_type: nullable(text),
        review_target: nullable(text),
        steer: nullable(object({ message: text })),
      }),
    ),
  },
);
const cacheDiagnostics: Validator = (value) =>
  object(
    {
      type: oneOf("cache_miss"),
      cache_missed_tokens: integer,
      reason: oneOf(
        "model_changed",
        "prompt_cache_key_changed",
        "tools_changed",
        "text_format_changed",
        "reasoning_effort_changed",
        "verbosity_changed",
        "context_compacted",
        "input_changed",
        "service_tier_changed",
      ),
    },
    { comparison_reusable_tokens: nullable(integer) },
  )(value) ||
  object({ type: oneOf("cache_hit", "comparison_response_not_found", "unavailable") })(value);
// The response envelope stays closed: every field the provider may return is declared
// with its type, and an undeclared field refuses the whole response. The declared set
// is the `Response` model of openai-python src/openai/types/responses/response.py at
// 0f73f1d519f8719b226e9084d78c8bdb4a60e48f (2026-10-12), restricted to what the admitted
// request above can produce. Fields that would describe provider-side state or features
// the request cannot ask for (stored conversations, prior responses, prompt templates,
// moderation, background execution) must echo their empty value. `billing` is not in that
// model but is returned by the provider alongside the documented fields; it is declared
// here with its observed shape rather than left to refuse every live response.
// The image policy follows the Responses API response schema (2026-11-04):
// https://developers.openai.com/api/reference/resources/responses/methods/create
// Its effective policy excludes the request-only "auto" value.
const response = object(
  {
    id: text,
    status: oneOf("in_progress", "completed", "failed", "incomplete", "cancelled", "queued"),
    output: array(outputItem),
  },
  {
    object: oneOf("response"),
    created_at: number,
    completed_at: nullable(number),
    model: text,
    usage: nullable(usage),
    error: nullable(error),
    incomplete_details: nullable(
      optionalFields({
        reason: nullable(oneOf("max_output_tokens", "max_messages", "content_filter", "steered")),
      }),
    ),
    instructions: nullable(text),
    tools: responseTools,
    tool_choice: toolChoice,
    parallel_tool_calls: bool,
    reasoning: nullable(
      optionalFields({
        effort: nullable(text),
        summary: nullable(text),
        generate_summary: nullable(text),
        context: nullable(text),
        mode: nullable(text),
      }),
    ),
    store: bool,
    background: nullable(oneOf(false)),
    service_tier: nullable(text),
    temperature: nullable(number),
    top_p: nullable(number),
    top_logprobs: nullable(integer),
    max_output_tokens: nullable(integer),
    max_tool_calls: nullable(integer),
    text: nullable(textSettings),
    previous_response_id: oneOf(null),
    conversation: oneOf(null),
    prompt: oneOf(null),
    moderation: oneOf(null),
    image: object({ context_compression: oneOf("enabled", "disabled") }),
    prompt_cache_key: nullable(text),
    prompt_cache_retention: nullable(text),
    prompt_cache_options: nullable(
      object(
        { mode: oneOf("implicit", "explicit"), ttl: oneOf("30m") },
        { comparison_response_id: nullable(text) },
      ),
    ),
    prompt_cache_diagnostics: nullable(cacheDiagnostics),
    access_programs: nullable(
      object({ cyber: oneOf("standard", "daybreak_blue", "daybreak_red") }),
    ),
    billing: object({ payer: name }),
    safety_identifier: nullable(text),
    user: nullable(text),
    truncation: nullable(oneOf("disabled", "auto")),
    metadata: nullable(object({})),
  },
);

// The stream needs only this projection of the closed wire shapes checked below.
export type ResponseOutputContent =
  { type: "output_text"; text: string } | { type: "refusal"; refusal: string };
type ResponseOutputItem =
  | { type: "message"; content: ResponseOutputContent[] }
  | { type: "reasoning" | "custom_tool_call" }
  | { type: "function_call"; arguments: string };
export type ItemEvent = {
  type: "response.output_item.added" | "response.output_item.done";
  output_index: number;
  item: ResponseOutputItem & { id: string };
};
export type ItemContentEvent = {
  type: string;
  output_index: number;
  item_id: string;
  delta?: string;
  arguments?: string;
  content_index?: number;
  part?: ResponseOutputContent;
};
export type ResponsesEvent = { type: string; sequence_number?: number } & (
  | { response: { id: string; status: string; output: ResponseOutputItem[] } }
  | ItemEvent
  | ItemContentEvent
);

/** Check an individual wire event. Order and completion belong to the stream. */
export function isResponsesEvent(value: unknown, model: string): value is ResponsesEvent {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string") {
    return false;
  }
  const base = { type: oneOf(event.type) };
  const optional = { sequence_number: integer };
  if (
    [
      "response.created",
      "response.in_progress",
      "response.completed",
      "response.failed",
      "response.incomplete",
    ].includes(event.type)
  ) {
    const envelope = asRecord(event.response);
    return (
      object({ ...base, response }, optional)(event) &&
      (envelope?.model === undefined || envelope.model === model) &&
      envelope?.status === event.type.slice("response.".length).replace("created", "in_progress")
    );
  }
  if (["response.output_item.added", "response.output_item.done"].includes(event.type)) {
    return (
      typeof asRecord(event.item)?.id === "string" &&
      object({ ...base, output_index: integer, item: outputItem }, optional)(event)
    );
  }
  const indexed = { ...base, item_id: text, output_index: integer };
  if (["response.content_part.added", "response.content_part.done"].includes(event.type)) {
    return object({ ...indexed, content_index: integer, part: outputContent }, optional)(event);
  }
  if (
    ["response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(
      event.type,
    )
  ) {
    return object({ ...indexed, summary_index: integer, part: summary }, optional)(event);
  }
  for (const [prefix, index, field] of [
    ["response.output_text", "content_index", "text"],
    ["response.refusal", "content_index", "refusal"],
    ["response.reasoning_text", "content_index", "text"],
    ["response.reasoning_summary_text", "summary_index", "text"],
    ["response.function_call_arguments", undefined, "arguments"],
    ["response.custom_tool_call_input", undefined, "input"],
  ] as const) {
    const isDelta = event.type === `${prefix}.delta`;
    if (isDelta || event.type === `${prefix}.done`) {
      const dataField = isDelta ? "delta" : field;
      return object(
        {
          ...indexed,
          ...(index === undefined ? {} : { [index]: integer }),
          [dataField]: text,
        },
        {
          ...optional,
          ...(prefix === "response.output_text" ? { logprobs: empty } : {}),
          ...(isDelta ? { obfuscation: text } : {}),
        },
      )(event);
    }
  }
  return false;
}
