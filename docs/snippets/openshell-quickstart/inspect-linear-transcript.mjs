// Read one marked Linear turn from this Agent's existing Gateway transcript.
// The database stays read-only; only the matched tool result and reply leave the Pod.
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

const [marker, expectedRunId] = process.argv.slice(2);
if (!marker) {
  throw new Error("Pass the unique marker from the Linear prompt.");
}
const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {
  readOnly: true,
});
const toolName = "codex_apps.linear.list_teams";
function textOf(content) {
  return typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}
try {
  db.exec("PRAGMA busy_timeout=5000");
  const matches = [];
  for (const session of db
    .prepare("SELECT session_key, current_session_id FROM session_nodes")
    .all()) {
    const messages = db
      .prepare(
        "SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(session.current_session_id)
      .flatMap((row) => {
        const text = row.event_json ?? zstdDecompressSync(row.event_zstd).toString("utf8");
        if (row.event_utf8_bytes !== null && Buffer.byteLength(text) !== row.event_utf8_bytes) {
          throw new Error("Transcript event length mismatch.");
        }
        const event = JSON.parse(text);
        return event.type === "message" ? [{ seq: row.seq, ...event.message }] : [];
      });
    const prompts = messages.filter(
      (message) =>
        message.role === "user" &&
        message.__openclaw?.mirrorOrigin === "codex-app-server" &&
        message.__openclaw?.mirrorIdentity?.endsWith(":prompt") &&
        textOf(message.content).includes(marker),
    );
    for (const prompt of prompts) {
      const runId = prompt.__openclaw.runId;
      if (!runId || (expectedRunId && runId !== expectedRunId)) {
        continue;
      }
      const run = messages.filter(
        (message) =>
          message.seq > prompt.seq &&
          message.__openclaw?.runId === runId &&
          message.__openclaw?.mirrorOrigin === "codex-app-server",
      );
      const calls = run
        .filter((message) => message.role === "assistant")
        .flatMap((message) =>
          (Array.isArray(message.content) ? message.content : []).filter(
            (block) =>
              block.type === "toolCall" &&
              (block.name === toolName ||
                (block.name === "dispatch_action" &&
                  [toolName, "openclaw:core:" + toolName].includes(block.arguments?.id))),
          ),
        );
      const results = run.flatMap((message) => {
        const call = calls.find((candidate) => candidate.id === message.toolCallId);
        if (
          message.role !== "toolResult" ||
          message.isError === true ||
          !call ||
          message.toolName !== call.name
        ) {
          return [];
        }
        if (call.name === toolName) {
          return [{ callId: call.id, content: message.content }];
        }
        // Match the real dispatcher envelope; an outer success alone proves no inner call.
        const envelope = message.details;
        if (
          envelope?.tool?.name !== toolName ||
          envelope.tool.source !== "openclaw" ||
          envelope.tool.id !== "openclaw:core:" + toolName ||
          typeof envelope.status === "string" ||
          envelope.result?.isError === true ||
          !Array.isArray(envelope.result?.content)
        ) {
          return [];
        }
        return [{ callId: call.id, content: envelope.result.content }];
      });
      const reply = run.findLast(
        (message) => message.role === "assistant" && message.__openclaw?.runTerminal === true,
      );
      if (!results.length || !reply) {
        throw new Error(
          "The selected run has no matched successful Linear result and terminal reply.",
        );
      }
      matches.push({
        sessionKey: session.session_key,
        runId,
        toolName,
        results,
        reply: textOf(reply.content),
      });
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      "Expected exactly one marked run. Check the Agent, marker and run ID; do not resend the turn.",
    );
  }
  console.log(JSON.stringify(matches[0], null, 2));
} finally {
  db.close();
}
