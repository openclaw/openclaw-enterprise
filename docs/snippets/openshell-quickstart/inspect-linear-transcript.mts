// Read one marked Linear turn from this Agent's existing Gateway transcript.
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

const toolName = "codex_apps.linear.list_teams";
const toolId = "openclaw:core:" + toolName;

interface Message {
  seq: number;
  fields: Record<string, unknown>;
  mirror: Record<string, unknown> | undefined;
}

interface ToolCall {
  id: string;
  name: typeof toolName | "dispatch_action";
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const blocks = array(content ?? []);
  if (!blocks) {
    throw new Error("Invalid transcript message content.");
  }
  return blocks
    .flatMap((value) => {
      const block = record(value);
      if (!block) {
        throw new Error("Invalid transcript content block.");
      }
      return block.type === "text" ? [block.text] : [];
    })
    .join("\n");
}

function readMessage(row: Record<string, SQLOutputValue>): Message[] {
  const { seq, event_json: json, event_zstd: compressed, event_utf8_bytes: bytes } = row;
  if (typeof seq !== "number") {
    throw new Error("Invalid transcript sequence.");
  }
  let text: string;
  if (typeof json === "string") {
    text = json;
  } else if (json === null && compressed instanceof Uint8Array) {
    text = zstdDecompressSync(compressed).toString("utf8");
  } else {
    throw new Error("Invalid transcript event encoding.");
  }
  if (bytes !== null && Buffer.byteLength(text) !== bytes) {
    throw new Error("Transcript event length mismatch.");
  }
  const decoded: unknown = JSON.parse(text);
  const event = record(decoded);
  if (!event) {
    throw new Error("Invalid transcript event.");
  }
  if (event.type !== "message") {
    return [];
  }
  const fields = record(event.message);
  if (!fields) {
    throw new Error("Invalid transcript message.");
  }
  return [{ seq, fields, mirror: record(fields.__openclaw) }];
}

function linearCalls({ fields }: Message): ToolCall[] {
  if (fields.role !== "assistant") {
    return [];
  }
  return (array(fields.content) ?? []).flatMap((value) => {
    const block = record(value);
    if (!block) {
      throw new Error("Invalid transcript content block.");
    }
    if (block.type !== "toolCall") {
      return [];
    }
    const { id, name } = block;
    const actionId = record(block.arguments)?.id;
    if (
      name === toolName ||
      (name === "dispatch_action" && (actionId === toolName || actionId === toolId))
    ) {
      if (typeof id !== "string") {
        throw new Error("Invalid transcript tool call ID.");
      }
      return [{ id, name }];
    }
    return [];
  });
}

function linearResult(call: ToolCall, fields: Record<string, unknown>): unknown {
  if (call.name === toolName) {
    return fields.content;
  }
  // Match the real dispatcher envelope; an outer success alone proves no inner call.
  const envelope = record(fields.details);
  const tool = record(envelope?.tool);
  const result = record(envelope?.result);
  if (
    tool?.name === toolName &&
    tool.source === "openclaw" &&
    tool.id === toolId &&
    typeof envelope?.status !== "string" &&
    result?.isError !== true
  ) {
    return array(result?.content);
  }
}

function readRun(messages: readonly Message[]) {
  const calls = messages.flatMap(linearCalls);
  const results = messages.flatMap(({ fields }) => {
    const call = calls.find(({ id }) => id === fields.toolCallId);
    if (
      fields.role !== "toolResult" ||
      fields.isError === true ||
      !call ||
      fields.toolName !== call.name
    ) {
      return [];
    }
    const content = linearResult(call, fields);
    // The direct result always contributed an entry, even without a content field.
    return call.name === toolName || content !== undefined ? [{ callId: call.id, content }] : [];
  });
  let reply: Message | undefined;
  for (const message of messages) {
    if (message.fields.role === "assistant" && message.mirror?.runTerminal === true) {
      reply = message;
    }
  }
  if (results.length === 0 || !reply) {
    throw new Error("The selected run has no matched successful Linear result and terminal reply.");
  }
  return { results, reply: textOf(reply.fields.content) };
}

const [marker, expectedRunId] = process.argv.slice(2);
if (!marker) {
  throw new Error("Pass the unique marker from the Linear prompt.");
}
const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {
  readOnly: true,
});
try {
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = db.prepare("SELECT session_key, current_session_id FROM session_nodes");
  const events = db.prepare(
    "SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq",
  );

  const matches = sessions.all().flatMap(({ session_key: sessionKey, current_session_id: id }) => {
    if (id === null) {
      return [];
    }
    if (typeof id !== "string" || typeof sessionKey !== "string") {
      throw new Error("Invalid transcript session.");
    }
    const messages = events.all(id).flatMap(readMessage);
    return messages.flatMap(({ seq, fields, mirror }) => {
      if (fields.role !== "user" || mirror?.mirrorOrigin !== "codex-app-server") {
        return [];
      }
      const identity = mirror.mirrorIdentity;
      if (identity == null) {
        return [];
      }
      if (typeof identity !== "string") {
        throw new Error("Invalid transcript mirror identity.");
      }
      if (!identity.endsWith(":prompt") || !textOf(fields.content).includes(marker)) {
        return [];
      }
      const runId = mirror.runId;
      if (!runId || (expectedRunId && runId !== expectedRunId)) {
        return [];
      }
      if (typeof runId !== "string") {
        throw new Error("Invalid transcript run ID.");
      }
      const run = messages.filter(
        (message) =>
          message.seq > seq &&
          message.mirror?.runId === runId &&
          message.mirror?.mirrorOrigin === "codex-app-server",
      );
      return [{ sessionKey, runId, toolName, ...readRun(run) }];
    });
  });
  if (matches.length !== 1) {
    throw new Error(
      "Expected exactly one marked run. Check the Agent, marker and run ID; do not resend the turn.",
    );
  }
  console.log(JSON.stringify(matches[0], null, 2));
} finally {
  db.close();
}
