import {
  matchingOperations,
  observationFields,
  standaloneArguments,
} from "./normal-agent-repository-command.ts";
import { expandTranscriptMessage } from "./normal-agent-transcript.ts";

type ObservedCall = {
  seq: number;
  id: unknown;
  name: unknown;
  mirrorIdentity: unknown;
  processSessionId?: string | undefined;
  processAction?: unknown;
  operations?: unknown[];
};

type ObservedResult = {
  seq: number;
  toolCallId: unknown;
  toolName: unknown;
  isError: boolean;
  matchesResult: boolean;
  mirrorIdentity: unknown;
  status?: unknown;
  exitCode?: unknown;
  processSessionId?: unknown;
  commitShas?: string[];
  pullUrls?: string[];
};

type CodexMirror = {
  turnPrefix: string;
  promptSeen: boolean;
  terminalAssistantSeen: boolean;
  terminalAssistantDelivered: boolean;
  toolCallMirrorSeen: boolean;
  toolResultMirrorSeen: boolean;
};

function readGatewaySession() {
  /* eslint-disable @typescript-eslint/no-require-imports -- The serialized observer runs under node -e. */
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { zstdDecompressSync } = require("node:zlib") as typeof import("node:zlib");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sessionKey = process.argv[1];
  if (sessionKey === undefined) {
    throw new Error("missing Gateway session key");
  }
  const marker = process.argv[2];
  const toolName = process.argv[3];
  const resultPattern = process.argv[4];
  // Optional bounded summaries let installed scenarios inspect real calls without
  // exporting their raw arguments, output, or credential-bearing environment.
  const suppliedSummary: unknown = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
  const summary = observationFields(suppliedSummary);
  function operationsFor(block: Record<string, unknown>) {
    if (block.name !== "exec" && block.name !== "bash") {
      return [];
    }
    const input = observationFields(block.arguments);
    const args = standaloneArguments(input?.command);
    if (args?.[0] !== "git" && args?.[0] !== "gh") {
      return [];
    }
    return matchingOperations(
      summary?.commands ?? [],
      block.name === "bash" ? input?.cwd : input?.workdir,
      args,
    );
  }
  const selectedTools = summary?.toolNames ?? [toolName];
  if (!Array.isArray(selectedTools) && typeof selectedTools !== "string") {
    throw new Error("invalid Gateway tool selection");
  }
  function selected(name: unknown) {
    return typeof selectedTools === "string"
      ? selectedTools.includes(String(name))
      : (selectedTools as unknown[]).includes(name);
  }
  function parseText(value: unknown): unknown {
    if (typeof value !== "string") {
      throw new Error("missing SQLite JSON text");
    }
    return JSON.parse(value);
  }
  const databasePath = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const db = new DatabaseSync(databasePath, { readOnly: true });
  function contains(value: unknown, needle: string | undefined): boolean {
    if (!needle) {
      return false;
    }
    if (typeof value === "string") {
      return value.includes(needle);
    }
    if (Array.isArray(value)) {
      return (value as unknown[]).some((entry) => contains(entry, needle));
    }
    if (value && typeof value === "object") {
      return Object.values(observationFields(value) ?? {}).some((entry) => contains(entry, needle));
    }
    return false;
  }
  function textOf(content: unknown) {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return (content as unknown[])
        .map(observationFields)
        .flatMap((block) =>
          block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
        )
        .join("\n");
    }
    return "";
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const session = db
      .prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey);
    if (!session) {
      process.stdout.write(JSON.stringify({ databasePath, sessionKey, exists: false }));
      return;
    }
    const entry = observationFields(parseText(session.entry_json));
    // Current runtimes store large entry fields separately; older runtimes inline them.
    const hasSnapshots = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_entry_snapshots'",
      )
      .get();
    const snapshot = hasSnapshots
      ? db
          .prepare(
            "SELECT value_json FROM session_entry_snapshots WHERE session_key = ? AND field = 'systemPromptReport'",
          )
          .get(sessionKey)
      : undefined;
    const promptReport = observationFields(
      snapshot ? parseText(snapshot.value_json) : entry?.systemPromptReport,
    );
    const toolEntries = observationFields(promptReport?.tools)?.entries;
    const promptTools =
      promptReport?.source === "run" && Array.isArray(toolEntries)
        ? (toolEntries as unknown[])
            .map((tool) => observationFields(tool)?.name)
            .filter((name) => typeof name === "string")
        : undefined;
    if (session.current_session_id === undefined) {
      throw new Error("missing stored session ID");
    }
    const rows = db
      .prepare(
        "SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(session.current_session_id);
    const messages: {
      role: unknown;
      hasMarker: boolean;
      stopReason: unknown;
      hasToolCalls: boolean;
    }[] = [];
    const calls: ObservedCall[] = [];
    const results: ObservedResult[] = [];
    const eventTypeCounts: Record<string, number> = {};
    const roleCounts: Record<string, number> = {};
    const contentBlockTypeCounts: Record<string, number> = {};
    const observedToolNames = new Set<string>();
    const resultToolNames = new Set<string>();
    const finalAssistantDiagnostics = {
      mentionsUnavailable: false,
      mentionsAuth: false,
    };
    const codexTurns = new Map<string, CodexMirror>();
    function turn(prefix: string) {
      const current = codexTurns.get(prefix) ?? {
        turnPrefix: prefix,
        promptSeen: false,
        terminalAssistantSeen: false,
        terminalAssistantDelivered: false,
        toolCallMirrorSeen: false,
        toolResultMirrorSeen: false,
      };
      codexTurns.set(prefix, current);
      return current;
    }
    function prefixForMirrorIdentity(identity: unknown, suffix: string) {
      return typeof identity === "string" && identity.endsWith(suffix)
        ? identity.slice(0, -suffix.length)
        : undefined;
    }
    function prefixForToolMirrorIdentity(identity: unknown, suffix: string) {
      if (typeof identity !== "string" || !identity.endsWith(suffix)) {
        return undefined;
      }
      const withoutSuffix = identity.slice(0, -suffix.length);
      const marker = ":tool:";
      const index = withoutSuffix.lastIndexOf(marker);
      return index === -1 ? undefined : withoutSuffix.slice(0, index);
    }
    const parentCalls = new Set<string>();
    for (const row of rows) {
      const eventText =
        row.event_json ??
        (row.event_zstd instanceof Uint8Array
          ? zstdDecompressSync(row.event_zstd).toString("utf8")
          : undefined);
      if (typeof eventText !== "string") {
        throw new Error("missing transcript event text");
      }
      if (Buffer.byteLength(eventText) !== (row.event_utf8_bytes ?? Buffer.byteLength(eventText))) {
        throw new Error("transcript event length mismatch");
      }
      const event = observationFields(parseText(eventText));
      const eventType = String(event?.type ?? "unknown");
      eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
      if (event?.type !== "message") {
        continue;
      }
      const rowSequence = row.seq;
      if (typeof rowSequence !== "number") {
        throw new Error("invalid transcript sequence");
      }
      for (const { message: rawMessage, seq } of expandTranscriptMessage(
        event.message,
        rowSequence,
        parentCalls,
      )) {
        const message = observationFields(rawMessage) ?? {};
        const hasMarker = contains(rawMessage, marker);
        const mirrorIdentity = observationFields(message.__openclaw)?.mirrorIdentity;
        const role = String(message.role ?? "unknown");
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
        const promptPrefix = prefixForMirrorIdentity(mirrorIdentity, ":prompt");
        if (message.role === "user" && hasMarker && promptPrefix !== undefined) {
          turn(promptPrefix).promptSeen = true;
        }
        const assistantPrefix = prefixForMirrorIdentity(mirrorIdentity, ":assistant");
        if (message.role === "assistant" && assistantPrefix !== undefined) {
          // Delivery is owned by the exact runtime mirror identity. The model's
          // optional completion wording is a separate diagnostic fact.
          turn(assistantPrefix).terminalAssistantDelivered = true;
          if (hasMarker) {
            turn(assistantPrefix).terminalAssistantSeen = true;
          }
        }
        messages.push({
          role: message.role,
          hasMarker,
          stopReason: message.stopReason,
          hasToolCalls:
            Array.isArray(message.content) &&
            (message.content as unknown[]).some(
              (block) => observationFields(block)?.type === "toolCall",
            ),
        });
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const entry of message.content as unknown[]) {
            const block = observationFields(entry);
            const blockType = String(block?.type ?? "unknown");
            contentBlockTypeCounts[blockType] = (contentBlockTypeCounts[blockType] ?? 0) + 1;
            if (typeof block?.name === "string") {
              observedToolNames.add(block.name);
            }
            if (block?.type === "toolCall" && selected(block.name)) {
              const toolPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":call");
              if (toolPrefix !== undefined) {
                turn(toolPrefix).toolCallMirrorSeen = true;
              }
              const args = observationFields(block.arguments);
              calls.push({
                seq,
                id: block.id,
                name: block.name,
                mirrorIdentity,
                ...(summary
                  ? {
                      processSessionId:
                        block.name === "process" && typeof args?.sessionId === "string"
                          ? args.sessionId
                          : undefined,
                      processAction: block.name === "process" ? args?.action : undefined,
                      operations: operationsFor(block),
                    }
                  : {}),
              });
            }
          }
          if (hasMarker) {
            const text = textOf(message.content).toLowerCase();
            finalAssistantDiagnostics.mentionsUnavailable ||=
              /unavailable|not available|unable|cannot|can't|could not|no access|not connected|not installed/.test(
                text,
              );
            finalAssistantDiagnostics.mentionsAuth ||=
              /auth|permission|credential|login|connect|unauthoriz/.test(text);
          }
        }
        if (message.role === "toolResult" && calls.some((call) => call.id === message.toolCallId)) {
          const resultPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":result");
          if (resultPrefix !== undefined) {
            turn(resultPrefix).toolResultMirrorSeen = true;
          }
          const details = observationFields(message.details);
          const content = textOf(message.content);
          const resultText =
            content + (typeof details?.aggregated === "string" ? "\n" + details.aggregated : "");
          const lines = resultText.split(/\r?\n/).map((line) => line.trim());
          results.push({
            seq,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError === true,
            matchesResult:
              contains(message, resultPattern) || content.includes(String(resultPattern)),
            mirrorIdentity,
            ...(summary
              ? {
                  status: details?.status,
                  exitCode: details?.exitCode,
                  processSessionId: details?.sessionId,
                  commitShas: [...new Set(lines.filter((line) => /^[a-f0-9]{40}$/.test(line)))],
                  pullUrls: [
                    ...new Set(
                      lines.filter((line) =>
                        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
                          line,
                        ),
                      ),
                    ),
                  ],
                }
              : {}),
          });
        }
        if (message.role === "toolResult" && typeof message.toolName === "string") {
          resultToolNames.add(message.toolName);
        }
      }
    }
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    process.stdout.write(
      JSON.stringify({
        databasePath,
        sessionKey,
        sessionId: session.current_session_id,
        exists: true,
        promptReportSource: promptReport?.source,
        promptToolNames: promptTools,
        messageCount: messages.length,
        userMarkerSeen: messages.some((message) => message.role === "user" && message.hasMarker),
        assistantMarkerSeen: messages.some(
          (message) => message.role === "assistant" && message.hasMarker,
        ),
        ...(summary
          ? {
              terminalAssistantMarkerSeen:
                !!lastAssistant?.hasMarker &&
                !lastAssistant.hasToolCalls &&
                lastAssistant.stopReason !== "error",
            }
          : {}),
        assistantError: messages.some(
          (message) => message.role === "assistant" && message.stopReason === "error",
        ),
        calls,
        results,
        codexTurns: Array.from(codexTurns.values()),
        diagnostics: {
          eventCount: rows.length,
          eventTypeCounts,
          roleCounts,
          contentBlockTypeCounts,
          observedToolNames: Array.from(observedToolNames).sort(),
          resultToolNames: Array.from(resultToolNames).sort(),
          finalAssistantDiagnostics,
        },
      }),
    );
  } finally {
    db.close();
  }
}

// The runtime evaluates regular JavaScript with node -e. Node strips these
// functions' types at import, and the observer carries its own dependencies.
export const sessionEvidenceScript = `
${observationFields}
${standaloneArguments}
${matchingOperations}
${expandTranscriptMessage}
(${readGatewaySession})();
`;
