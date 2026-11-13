import assert from "node:assert/strict";
import type { SQLOutputValue } from "node:sqlite";
import { isGatewayCompletionId } from "../../scripts/first-agent-model.mjs";
import { redactedQaTail } from "./qa-secrets.mjs";

type TranscriptFailure = "integrity" | "prompt_missing" | "answer_missing" | "source" | "run";
type ReplyFailure =
  | TranscriptFailure
  | "command"
  | "timeout"
  | "session_missing"
  | "binding"
  | "transcript"
  | "continuity"
  | "sequence";

// Only these locally defined outcomes may leave the Gateway reader.
const replyFailures: ReadonlySet<unknown> = new Set<ReplyFailure>([
  "command",
  "timeout",
  "session_missing",
  "binding",
  "transcript",
  "prompt_missing",
  "answer_missing",
  "source",
  "run",
  "integrity",
  "continuity",
  "sequence",
]);

function isReplyFailure(value: unknown): value is ReplyFailure {
  return replyFailures.has(value);
}

export class ConversationReplyError extends Error {
  readonly reason: ReplyFailure;

  constructor(reason: unknown) {
    super(reason === "continuity" ? "Conversation mismatch." : "Conversation reply unavailable.");
    this.reason = isReplyFailure(reason) ? reason : "transcript";
  }
}

type Catalog = { present: string[]; absent: string[] };
type CodeModeCall = { code: string; title: string; awaitResults: true };
type ToolCall = {
  seq: SQLOutputValue | undefined;
  id: unknown;
  name: unknown;
  mirrorIdentity: unknown;
  targetId?: string;
  targetName?: string;
  matchesArguments: boolean;
  matchesSearchArguments?: boolean;
};
type MessageEvidence = {
  seq: SQLOutputValue | undefined;
  role: unknown;
  hasMarker: boolean;
  stopReason: unknown;
  mirrorIdentity: unknown;
  runId: unknown;
  runTerminal: boolean;
  codexSource: boolean;
  textMarker: boolean;
  toolCallIds: unknown[];
  toolCallId: unknown;
};
type ToolResult = {
  seq: SQLOutputValue | undefined;
  toolCallId: unknown;
  toolName: unknown;
  isError: boolean;
  matchesTarget: boolean;
  exitCode: number | undefined;
  resultDetails: { type: string; keys: string[]; status: unknown };
  errorText?: string | undefined;
  codeModeProgramVerified?: true;
  deniedByUser: boolean;
  matchesResult: boolean;
  matchedResultPattern: string | undefined;
  matchesCatalog?: boolean;
  catalog?: unknown;
  catalogTruncated?: boolean;
  mirrorIdentity: unknown;
  approvalReviews: {
    id: unknown;
    status: unknown;
    riskLevel?: string;
    userAuthorization?: string;
    rationale?: string;
  }[];
};
type CodexTurn = {
  turnPrefix: string;
  promptSeen: boolean;
  terminalAssistantSeen: boolean;
  toolCallMirrorSeen: boolean;
  toolResultMirrorSeen: boolean;
  gatewayRunCompletion?: "settled-finalizer" | "native-continuation";
};

// Node strips these function bodies when it loads this module. Each command is
// then serialized for node -e in the Gateway and must only use its own scope.
function sessionEvidenceInGateway() {
  /* eslint-disable @typescript-eslint/no-require-imports -- The serialized Gateway program runs under node -e. */
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { isDeepStrictEqual } = require("node:util") as typeof import("node:util");
  const { zstdDecompressSync } = require("node:zlib") as typeof import("node:zlib");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sessionKey = process.argv[1]!;
  const marker = process.argv[2]!;
  const toolName = process.argv[3];
  const resultPatterns = stringList(parseJson(process.argv[4]!));
  const expectedArguments = parseJson(process.argv[5] || "null");
  const catalog = parseJson(process.argv[6] || "null");
  const expectedCatalog =
    catalog === null
      ? null
      : {
          present: stringList(field(catalog, "present")),
          absent: stringList(field(catalog, "absent")),
        };
  const codeModeCall = parseJson(process.argv[7] || "null");
  const conversationReply = process.argv[8] === "conversation-reply";
  const databasePath = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const db = new DatabaseSync(databasePath, { readOnly: true });

  function parseJson(text: string): unknown {
    return JSON.parse(text);
  }

  function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  function stringList(value: unknown): string[] {
    if (!isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new Error("Expected a list of strings.");
    }
    return value;
  }

  function field(value: unknown, key: string): unknown {
    return value == null ? undefined : (Object(value) as Record<string, unknown>)[key];
  }

  function contains(value: unknown, needle: string): boolean {
    if (!needle) {
      return false;
    }
    if (typeof value === "string") {
      return value.includes(needle);
    }
    if (isArray(value)) {
      return value.some((entry) => contains(entry, needle));
    }
    if (value && typeof value === "object") {
      const entries: unknown[] = Object.values(value);
      return entries.some((entry) => contains(entry, needle));
    }
    return false;
  }

  function textOf(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (isArray(content)) {
      return content
        .flatMap((block) => {
          const text = field(block, "text");
          return field(block, "type") === "text" && typeof text === "string" ? [text] : [];
        })
        .join("\n");
    }
    return "";
  }

  function hasStructuredResult(value: unknown): boolean {
    if (isArray(value)) {
      return value.some(hasStructuredResult);
    }
    if (value && typeof value === "object") {
      const text = field(value, "text");
      if (field(value, "type") === "text" && typeof text === "string") {
        return hasStructuredResult(text);
      }
      return Object.keys(value).length > 0;
    }
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }
    try {
      return hasStructuredResult(parseJson(value.trim()));
    } catch {
      return false;
    }
  }

  function matchesToolName(name: unknown): boolean {
    return (
      typeof name === "string" &&
      (toolName ? name === toolName : /(^|[._:-])list[_-]?calendars$/i.test(name))
    );
  }

  // A malformed row establishes nothing. One before the evidence window must
  // leave a passing run intact. One inside the window fails the proof.
  function parseEvent(text: string): unknown {
    try {
      return parseJson(text);
    } catch {
      return undefined;
    }
  }

  function sqlText(value: SQLOutputValue | undefined): string {
    if (typeof value !== "string") {
      throw new Error("Expected SQLite text.");
    }
    return value;
  }

  function decodeRow(row: Record<string, SQLOutputValue>, maxOutputLength?: number) {
    if (row.event_json != null) {
      const text = sqlText(row.event_json);
      return { text, stored: Buffer.byteLength(text) };
    }
    const blob = row.event_zstd;
    if (!(blob instanceof Uint8Array)) {
      throw new Error("Expected compressed transcript bytes.");
    }
    return {
      text: zstdDecompressSync(
        blob,
        maxOutputLength === undefined ? undefined : { maxOutputLength },
      ).toString("utf8"),
      stored: blob.byteLength,
    };
  }

  function requiredField(value: unknown, key: string): unknown {
    if (value == null) {
      throw new Error("Missing transcript object.");
    }
    return field(value, key);
  }

  function matchesGuestCatalog(catalog: unknown, expected: Catalog): boolean {
    return (
      isArray(catalog) &&
      catalog.every(
        (candidate) =>
          typeof field(candidate, "name") === "string" &&
          field(candidate, "source") === "openclaw" &&
          typeof field(candidate, "callableName") === "string",
      ) &&
      [...expected.present, ...expected.absent].every((name) => {
        const exact = catalog.filter((candidate) => field(candidate, "name") === name);
        return expected.present.includes(name)
          ? exact.length === 1 && field(exact[0], "callableName") === name
          : exact.length === 0;
      })
    );
  }

  function matchesSearchCatalog(groups: unknown[] | undefined, expected: Catalog): boolean {
    return (
      groups?.length === expected.present.length + expected.absent.length &&
      [...expected.present, ...expected.absent].every((name) => {
        const matched = groups.filter((group) => requiredField(group, "query") === name);
        const candidates = field(matched[0], "candidates");
        if (
          matched.length !== 1 ||
          field(matched[0], "truncated") === true ||
          !isArray(candidates) ||
          candidates.length > 1 ||
          candidates.some(
            (candidate) =>
              typeof field(candidate, "name") !== "string" ||
              typeof field(candidate, "id") !== "string" ||
              typeof field(candidate, "source") !== "string",
          )
        ) {
          return false;
        }
        const exact = candidates.filter((candidate) => {
          const candidateName = field(candidate, "name");
          return (
            typeof candidateName === "string" && candidateName.toLowerCase() === name.toLowerCase()
          );
        });
        return expected.present.includes(name)
          ? exact.length === 1 &&
              field(exact[0], "source") === "openclaw" &&
              field(exact[0], "id") === "openclaw:core:" + name
          : exact.length === 0;
      })
    );
  }

  function candidateNames(candidates: unknown): unknown[] | undefined {
    if (candidates == null) {
      return undefined;
    }
    if (!isArray(candidates)) {
      throw new Error("Expected transcript catalog candidates.");
    }
    return candidates.map((candidate) => requiredField(candidate, "name"));
  }

  function readApprovalReviews(reviews: unknown): ToolResult["approvalReviews"] {
    if (!isArray(reviews)) {
      throw new Error("Expected transcript approval reviews.");
    }
    return reviews.map((review) => {
      const riskLevel = field(review, "riskLevel");
      const userAuthorization = field(review, "userAuthorization");
      const rationale = field(review, "rationale");
      return {
        id: requiredField(review, "id"),
        status: field(review, "status"),
        ...(typeof riskLevel === "string" ? { riskLevel } : {}),
        ...(typeof userAuthorization === "string" ? { userAuthorization } : {}),
        ...(typeof rationale === "string" ? { rationale: rationale.slice(0, 500) } : {}),
      };
    });
  }

  try {
    db.exec("PRAGMA busy_timeout=5000");
    const session = db
      .prepare(
        conversationReply
          ? "SELECT current_session_id FROM session_nodes WHERE session_key = ?"
          : "SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?",
      )
      .get(sessionKey);
    if (!session) {
      if (conversationReply) {
        throw new Error("Conversation reply unavailable.");
      }
      process.stdout.write(JSON.stringify({ databasePath, sessionKey, exists: false }));
      process.exit(0);
    }
    if (conversationReply) {
      function fail(reason: TranscriptFailure = "integrity"): never {
        process.stdout.write(JSON.stringify({ failure: reason }));
        process.exit(0);
      }

      if (
        typeof session.current_session_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(session.current_session_id)
      ) {
        fail();
      }
      let storedRemaining = 1048576;
      let decodedRemaining = 1048576;
      const window: { seq: SQLOutputValue | undefined; event: unknown }[] = [];
      // Select sequence numbers first. Apply the remaining budgets in SQLite
      // before bringing each payload into JS, and bound decompression separately.
      const recent = db.prepare(
        "SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 256",
      );
      const payload = db.prepare(
        "SELECT event_json, CASE WHEN event_json IS NULL THEN event_zstd END AS event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? AND seq = ? AND (event_utf8_bytes IS NULL OR event_utf8_bytes BETWEEN 0 AND ?) AND ((event_json IS NOT NULL AND length(CAST(event_json AS BLOB)) <= ?) OR (event_json IS NULL AND length(event_zstd) <= ?))",
      );
      for (const { seq } of recent.iterate(session.current_session_id)) {
        if (!storedRemaining || !decodedRemaining) {
          fail();
        }
        const row = payload.get(
          session.current_session_id,
          seq!,
          decodedRemaining,
          Math.min(storedRemaining, decodedRemaining),
          storedRemaining,
        );
        if (!row) {
          fail();
        }
        const { text, stored } = decodeRow(row, decodedRemaining);
        storedRemaining -= stored;
        const size = Buffer.byteLength(text);
        if (
          size > decodedRemaining ||
          (row.event_utf8_bytes != null && size !== row.event_utf8_bytes)
        ) {
          fail();
        }
        decodedRemaining -= size;
        const event = parseEvent(text);
        if (!event) {
          fail();
        }
        window.push({ seq, event });
        const message = field(event, "message");
        if (
          field(event, "type") === "message" &&
          field(message, "role") === "user" &&
          textOf(field(message, "content")).includes(marker)
        ) {
          break;
        }
      }
      window.reverse();
      const messages = window.map(({ event, seq }) => {
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
          fail();
        }
        return {
          seq,
          message: field(event, "type") === "message" ? field(event, "message") : null,
        };
      });
      const prompt = messages[0];
      if (
        !prompt ||
        field(prompt.message, "role") !== "user" ||
        !textOf(field(prompt.message, "content")).includes(marker)
      ) {
        fail("prompt_missing");
      }
      const source = field(prompt.message, "__openclaw");
      const promptIdentity = field(source, "mirrorIdentity");
      const promptFingerprint = field(source, "mirrorSourceFingerprint");
      if (
        field(source, "mirrorOrigin") !== "codex-app-server" ||
        typeof promptIdentity !== "string" ||
        !/^[A-Za-z0-9_-]+:prompt$/.test(promptIdentity) ||
        typeof promptFingerprint !== "string" ||
        !promptFingerprint
      ) {
        fail("source");
      }
      const runId = process.argv[10];
      if (field(source, "runId") !== runId) {
        fail("run");
      }
      const answer = messages
        .filter(
          ({ message }) =>
            field(message, "role") === "assistant" &&
            textOf(field(message, "content")).includes(marker),
        )
        .at(-1);
      if (!answer) {
        fail("answer_missing");
      }
      const meta = field(answer.message, "__openclaw");
      const answerIdentity = field(meta, "mirrorIdentity");
      const answerFingerprint = field(meta, "mirrorSourceFingerprint");
      // The mirror writer assigns this key at write time. The current session
      // binding alone cannot attribute the assistant message to that thread.
      const expectedKey = "codex-app-server:" + process.argv[9] + ":" + answerIdentity;
      // A recovered logical run keeps its admitted prompt and can finish on a new native turn.
      if (
        field(meta, "mirrorOrigin") !== "codex-app-server" ||
        typeof answerIdentity !== "string" ||
        !/^[A-Za-z0-9_-]+:assistant$/.test(answerIdentity) ||
        typeof answerFingerprint !== "string" ||
        !answerFingerprint ||
        field(answer.message, "idempotencyKey") !== expectedKey
      ) {
        fail("source");
      }
      if (field(meta, "runId") !== runId || field(meta, "runTerminal") !== true) {
        fail("run");
      }
      if (
        answer.seq <= prompt.seq ||
        field(answer.message, "stopReason") !== "stop" ||
        messages.some(({ message, seq }) => {
          const metadata = field(message, "__openclaw");
          return (
            seq < answer.seq &&
            field(message, "role") === "assistant" &&
            field(metadata, "runId") === runId &&
            field(metadata, "runTerminal") === true
          );
        }) ||
        messages.some(({ message }, index) => index > 0 && field(message, "role") === "user") ||
        messages.some(
          ({ message, seq }) =>
            field(message, "isError") === true ||
            field(message, "stopReason") === "error" ||
            (seq > answer.seq && field(message, "role") === "assistant"),
        ) ||
        messages.some((row, index) => index > 0 && row.seq <= messages[index - 1]!.seq)
      ) {
        fail();
      }
      const current = db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(sessionKey);
      if (current?.current_session_id !== session.current_session_id) {
        fail();
      }
      process.stdout.write(
        JSON.stringify({
          sessionId: session.current_session_id,
          userSeq: prompt.seq,
          assistantSeq: answer.seq,
        }),
      );
      process.exit(0);
    }
    const entry = parseJson(sqlText(session.entry_json));
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
    const promptReport = snapshot
      ? parseJson(sqlText(snapshot.value_json))
      : field(entry, "systemPromptReport");
    const promptEntries = field(field(promptReport, "tools"), "entries");
    const promptReportSource = field(promptReport, "source");
    const promptTools =
      promptReportSource === "run" && isArray(promptEntries)
        ? promptEntries
            .map((tool) => field(tool, "name"))
            .filter((name) => typeof name === "string")
        : undefined;
    const allRows = db
      .prepare(
        "SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(session.current_session_id!)
      .map((row) => {
        const { text } = decodeRow(row);
        if (row.event_utf8_bytes !== null && Buffer.byteLength(text) !== row.event_utf8_bytes) {
          throw new Error("transcript event length mismatch");
        }
        return { seq: row.seq, text };
      });
    // Repeated calls share a session; an earlier allowed result cannot prove this turn.

    // Report the newest marker-bearing requests, including any before the
    // selected window. An unmirrored copy can move the window past the mirror.
    const markerRows = allRows
      .map((row, index) => {
        const event = parseEvent(row.text);
        return { row, index, type: field(event, "type"), message: field(event, "message") };
      })
      .filter(
        ({ type, message }) =>
          type === "message" && field(message, "role") === "user" && contains(message, marker),
      );
    const start = markerRows.at(-1)?.index ?? -1;
    const rows = start < 0 ? [] : allRows.slice(start);
    const markerUserMessages = markerRows.slice(-10).map(({ row, index, message }) => {
      const meta = field(message, "__openclaw");
      const idempotencyKey = field(message, "idempotencyKey");
      return {
        seq: row.seq,
        inWindow: index >= start,
        mirrorIdentity: field(meta, "mirrorIdentity") ?? null,
        mirrorOrigin: field(meta, "mirrorOrigin") ?? null,
        idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
        timestamp: field(message, "timestamp") ?? null,
      };
    });
    const messages: MessageEvidence[] = [];
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];
    const eventTypeCounts: Record<string, number> = {};
    const roleCounts: Record<string, number> = {};
    const contentBlockTypeCounts: Record<string, number> = {};
    const observedToolNames = new Set<string>();
    const resultToolNames = new Set<string>();
    const finalAssistantDiagnostics = {
      mentionsUnavailable: false,
      mentionsAuth: false,
    };
    const codexTurns = new Map<string, CodexTurn>();
    function turn(prefix: string) {
      const current = codexTurns.get(prefix) ?? {
        turnPrefix: prefix,
        promptSeen: false,
        terminalAssistantSeen: false,
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

    for (const row of rows) {
      const event = parseEvent(row.text);
      // A malformed row inside the window could hide a tool call.
      if (event === undefined) {
        throw new Error("transcript row " + row.seq + " in the evidence window is not JSON");
      }
      // Non-message rows, including null payloads, cannot establish tool or turn evidence.
      const type = field(event, "type");
      const eventType = String(type ?? "unknown");
      eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
      if (type !== "message") {
        continue;
      }
      const message = field(event, "message");
      const meta = field(message, "__openclaw");
      const mirrorIdentity = field(meta, "mirrorIdentity");
      const fingerprint = field(meta, "mirrorSourceFingerprint");
      const hasMarker = contains(message, marker);
      const role = requiredField(message, "role");
      const content = field(message, "content");
      const toolCallId = field(message, "toolCallId");
      const toolResultName = field(message, "toolName");
      const roleKey = String(role ?? "unknown");
      roleCounts[roleKey] = (roleCounts[roleKey] ?? 0) + 1;
      const promptPrefix = prefixForMirrorIdentity(mirrorIdentity, ":prompt");
      if (role === "user" && hasMarker && promptPrefix !== undefined) {
        turn(promptPrefix).promptSeen = true;
      }
      const assistantPrefix = prefixForMirrorIdentity(mirrorIdentity, ":assistant");
      if (role === "assistant" && hasMarker && assistantPrefix !== undefined) {
        turn(assistantPrefix).terminalAssistantSeen = true;
      }
      messages.push({
        seq: row.seq,
        role,
        hasMarker,
        stopReason: field(message, "stopReason"),
        mirrorIdentity,
        runId: field(meta, "runId"),
        runTerminal: field(meta, "runTerminal") === true,
        codexSource:
          field(meta, "mirrorOrigin") === "codex-app-server" &&
          typeof fingerprint === "string" &&
          fingerprint.length > 0,
        textMarker: textOf(content).includes(marker),
        toolCallIds:
          role === "assistant" && isArray(content)
            ? content
                .filter((block) => field(block, "type") === "toolCall")
                .map((block) => field(block, "id"))
            : [],
        toolCallId,
      });
      if (role === "assistant" && isArray(content)) {
        for (const block of content) {
          const blockType = field(block, "type");
          const blockTypeKey = String(blockType ?? "unknown");
          contentBlockTypeCounts[blockTypeKey] = (contentBlockTypeCounts[blockTypeKey] ?? 0) + 1;
          const name = field(block, "name");
          if (typeof name === "string") {
            observedToolNames.add(name);
          }
          // Preserve the actual dispatcher call recorded in the transcript.
          const args = field(block, "arguments");
          const id = field(args, "id");
          const selectedId = typeof id === "string" ? id.trim() : undefined;
          const targetId =
            name === "dispatch_action" &&
            toolName &&
            (selectedId === toolName || selectedId === "openclaw:core:" + toolName)
              ? selectedId
              : undefined;
          if (blockType === "toolCall" && (matchesToolName(name) || targetId)) {
            const input = targetId ? field(args, "args") : args;
            const toolPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":call");
            if (toolPrefix !== undefined) {
              turn(toolPrefix).toolCallMirrorSeen = true;
            }
            const queries = field(input, "queries");
            calls.push({
              seq: row.seq,
              id: field(block, "id"),
              name,
              mirrorIdentity,
              ...(targetId ? { targetId, targetName: toolName! } : {}),
              matchesArguments:
                expectedArguments === null ||
                Object.keys(Object(expectedArguments)).every((key) =>
                  isDeepStrictEqual(field(input, key), field(expectedArguments, key)),
                ),
              ...(expectedCatalog
                ? {
                    matchesSearchArguments:
                      name === "tool_search" &&
                      isArray(queries) &&
                      queries.length ===
                        expectedCatalog.present.length + expectedCatalog.absent.length &&
                      [...expectedCatalog.present, ...expectedCatalog.absent].every(
                        (name) =>
                          queries.filter(
                            (query) =>
                              requiredField(query, "query") === name && field(query, "limit") === 1,
                          ).length === 1,
                      ),
                  }
                : {}),
            });
          }
        }
        if (hasMarker) {
          const text = textOf(content).toLowerCase();
          finalAssistantDiagnostics.mentionsUnavailable ||=
            /unavailable|not available|unable|cannot|can't|could not|no access|not connected|not installed/.test(
              text,
            );
          finalAssistantDiagnostics.mentionsAuth ||=
            /auth|permission|credential|login|connect|unauthoriz/.test(text);
        }
      }
      if (role !== "toolResult") {
        continue;
      }
      const call = calls.find((call) => call.id === toolCallId);
      if (call) {
        const resultPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":result");
        if (resultPrefix !== undefined) {
          turn(resultPrefix).toolResultMirrorSeen = true;
        }
        const details = field(message, "details");
        const envelope = call.targetId ? details : undefined;
        const envelopeTool = field(envelope, "tool");
        const envelopeResult = field(envelope, "result");
        // Thrown errors name the dispatcher as a string; canonical results carry tool metadata.
        const hasEnvelope =
          (envelopeTool !== null && typeof envelopeTool === "object") ||
          envelopeResult !== undefined;
        const matchesDispatcherTarget =
          !call.targetId ||
          (toolResultName === call.name &&
            (hasEnvelope
              ? field(envelopeTool, "name") === toolName &&
                field(envelopeTool, "source") === "openclaw" &&
                field(envelopeTool, "id") ===
                  (call.targetId === toolName ? "openclaw:core:" + toolName : call.targetId) &&
                isArray(field(envelopeResult, "content"))
              : field(message, "isError") === true));
        // Code Mode returns guest values. Match the full fixture program,
        // title and synchronous execution request before inspecting them.
        const exactCodeMode =
          codeModeCall !== null && call.matchesArguments && toolResultName === "exec";
        const cell = exactCodeMode ? details : undefined;
        const value = field(cell, "value");
        const cellStatus = field(cell, "status");
        const returnedFailure =
          cellStatus === "completed" &&
          field(value, "status") === "error" &&
          typeof field(value, "error") === "string";
        const thrownFailure =
          cellStatus === "failed" && field(cell, "bridgeDispatchStarted") === true;
        const matchesTarget =
          matchesDispatcherTarget &&
          (codeModeCall === null ||
            (exactCodeMode && (cellStatus === "completed" || thrownFailure)));
        const targetResult = exactCodeMode
          ? { content, details: cellStatus === "completed" ? value : cell }
          : call.targetId && hasEnvelope
            ? envelopeResult
            : message;
        const targetContent = field(targetResult, "content");
        const targetDetails = field(targetResult, "details");
        const targetStatus = field(targetDetails, "status");
        const exitCode = field(targetDetails, "exitCode");
        // Dedicated Gateway proxies return an error value; input validation can throw.
        const isError =
          field(message, "isError") === true ||
          returnedFailure ||
          thrownFailure ||
          (call.targetId && typeof field(envelope, "status") === "string");
        const groupsValue = field(details, "results");
        const groups = expectedCatalog && isArray(groupsValue) ? groupsValue : undefined;
        const codeModeCatalog = exactCodeMode ? field(value, "catalog") : undefined;
        const matchesCatalog =
          expectedCatalog === null ||
          (codeModeCall !== null
            ? exactCodeMode &&
              cellStatus === "completed" &&
              matchesGuestCatalog(codeModeCatalog, expectedCatalog)
            : call.matchesSearchArguments === true &&
              field(details, "truncated") !== true &&
              matchesSearchCatalog(groups, expectedCatalog));
        const matchedResultPattern = resultPatterns.find(
          (pattern) => contains(targetResult, pattern) || textOf(targetContent).includes(pattern),
        );
        const approvalReviews = field(details, "approvalReviews") ?? [];
        results.push({
          seq: row.seq,
          toolCallId,
          toolName: toolResultName,
          isError: Boolean(isError),
          matchesTarget,
          exitCode:
            typeof exitCode === "number" &&
            Number.isInteger(exitCode) &&
            (codeModeCall === null || (cellStatus === "completed" && targetStatus === "completed"))
              ? exitCode
              : undefined,
          resultDetails: {
            type: targetDetails === null ? "null" : typeof targetDetails,
            keys:
              targetDetails && typeof targetDetails === "object"
                ? Object.keys(targetDetails)
                    .slice(0, 16)
                    .map((key) => key.slice(0, 64))
                : [],
            status:
              typeof targetStatus === "string" &&
              [
                "running",
                "completed",
                "failed",
                "approval-pending",
                "pending",
                "deferred",
                "blocked",
                "error",
              ].includes(targetStatus)
                ? targetStatus
                : undefined,
          },
          errorText:
            isError || (exactCodeMode && cellStatus === "failed")
              ? textOf(targetContent)
              : undefined,
          ...(exactCodeMode ? { codeModeProgramVerified: true } : {}),
          // Native Codex emits this terminal reason when MCP approval is denied.
          deniedByUser: textOf(content).includes("user rejected MCP tool call"),
          matchesResult:
            matchesTarget &&
            matchesCatalog &&
            (resultPatterns.length
              ? matchedResultPattern !== undefined
              : hasStructuredResult(targetContent)),
          matchedResultPattern,
          ...(expectedCatalog
            ? {
                matchesCatalog,
                catalog: exactCodeMode
                  ? codeModeCatalog
                  : groups?.map((group) => ({
                      query: requiredField(group, "query"),
                      names: candidateNames(field(group, "candidates")),
                      truncated: field(group, "truncated") === true,
                    })),
                catalogTruncated: field(details, "truncated") === true,
              }
            : {}),
          mirrorIdentity,
          // A reviewer that failed closed or timed out leaves out risk and authorization.
          approvalReviews: readApprovalReviews(approvalReviews),
        });
      }
      if (typeof toolResultName === "string") {
        resultToolNames.add(toolResultName);
      }
    }

    // A Gateway run can finish in a later Codex turn or a tool-free finalizer.
    // The native prompt and tool pair must still come from one turn before the answer.
    const prompt = messages[0];
    const sourcePrefix = prefixForMirrorIdentity(prompt?.mirrorIdentity, ":prompt");
    const sourceTurn = sourcePrefix === undefined ? undefined : codexTurns.get(sourcePrefix);
    if (
      sourceTurn?.promptSeen &&
      !sourceTurn.terminalAssistantSeen &&
      prompt?.textMarker &&
      prompt.codexSource &&
      prompt.runId &&
      markerUserMessages.length === 1
    ) {
      const belongsToSource = (row: MessageEvidence) =>
        typeof row.mirrorIdentity === "string" && row.mirrorIdentity.startsWith(sourcePrefix + ":");
      const run = messages.filter((row) => row.runId === prompt.runId || belongsToSource(row));
      const terminal = run.pop();
      const source = run.filter(belongsToSource);
      const completion =
        terminal?.mirrorIdentity === "settled-finalizer:" + String(prompt.runId)
          ? "settled-finalizer"
          : terminal &&
              prefixForMirrorIdentity(terminal.mirrorIdentity, ":assistant") &&
              !belongsToSource(terminal)
            ? "native-continuation"
            : undefined;
      if (
        completion &&
        terminal?.role === "assistant" &&
        terminal.textMarker &&
        terminal.codexSource &&
        terminal.runTerminal &&
        terminal.runId === prompt.runId &&
        run.every((row) => row.role !== "user" || row === prompt) &&
        source.every((row) => row.codexSource && row.runId === prompt.runId)
      ) {
        // Progress from a continuation belongs to that later turn. The original
        // turn supplies the correlated tool pair.
        const callsByMirror = new Map<unknown, unknown[]>();
        for (const row of source) {
          if (row.role === "assistant" && row.toolCallIds.length) {
            callsByMirror.set(row.mirrorIdentity, row.toolCallIds);
          } else if (
            row.role === "toolResult" &&
            typeof row.mirrorIdentity === "string" &&
            prefixForToolMirrorIdentity(row.mirrorIdentity, ":result") === sourcePrefix
          ) {
            const callIdentity = row.mirrorIdentity.slice(0, -":result".length) + ":call";
            if (
              typeof row.toolCallId === "string" &&
              row.toolCallId.trim() &&
              callsByMirror.get(callIdentity)?.includes(row.toolCallId)
            ) {
              sourceTurn.gatewayRunCompletion = completion;
              break;
            }
          }
        }
      }
    }

    const markerAssistantMessages = messages
      .filter((row) => row.role === "assistant" && row.textMarker)
      .slice(-5)
      .map(({ seq, stopReason, mirrorIdentity, runId, runTerminal }) => ({
        seq,
        stopReason,
        mirrorIdentity,
        runId,
        runTerminal,
      }));
    process.stdout.write(
      JSON.stringify({
        databasePath,
        sessionKey,
        sessionId: session.current_session_id,
        exists: true,
        promptReportSource,
        promptReportShape: {
          present: promptReport !== undefined,
          valueType: promptReport === null ? "null" : typeof promptReport,
          source: promptReportSource,
          entriesType: isArray(promptEntries)
            ? "array"
            : promptEntries === null
              ? "null"
              : typeof promptEntries,
          entriesCount: isArray(promptEntries) ? promptEntries.length : null,
        },
        promptToolNames: promptTools,
        messageCount: messages.length,
        userMarkerSeen: messages.some((message) => message.role === "user" && message.hasMarker),
        assistantMarkerSeen: messages.some(
          (message) => message.role === "assistant" && message.hasMarker,
        ),
        assistantError: messages.some(
          (message) => message.role === "assistant" && message.stopReason === "error",
        ),
        calls,
        results,
        codexTurns: Array.from(codexTurns.values()),
        markerUserMessages,
        markerAssistantMessages,
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

function codexSessionBindingInGateway() {
  const qa = process.argv[2] === "conversation-reply";
  try {
    /* eslint-disable @typescript-eslint/no-require-imports -- The serialized Gateway program runs under node -e. */
    const assert: typeof import("node:assert/strict") = require("node:assert/strict");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const sessionKey = process.argv[1]!;
    const sessions = new DatabaseSync(
      "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite",
      { readOnly: true },
    );
    const state = new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite", {
      readOnly: true,
    });
    try {
      const session = sessions
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(sessionKey);
      if (qa && !session) {
        process.stdout.write('{"failure":"session_missing"}');
        process.exit(0);
      }
      assert.ok(session, "the original OC session must exist");
      const key =
        "session-key:main:" + createHash("sha256").update(sessionKey.trim()).digest("base64url");
      const bindingColumn = qa
        ? "CASE WHEN length(CAST(value_json AS BLOB)) <= 65536 THEN value_json END AS value_json"
        : "value_json";
      const row = state
        .prepare(
          "SELECT " +
            bindingColumn +
            " FROM plugin_state_entries WHERE plugin_id = 'codex' AND namespace = 'app-server-thread-bindings' AND entry_key = ? AND (expires_at IS NULL OR expires_at > ?)",
        )
        .get(key, Date.now());
      assert.ok(row, "the OC session must have an active Codex binding");
      const value = row.value_json;
      assert.ok(typeof value === "string", "the Codex binding must be JSON text");
      const stored: unknown = JSON.parse(value);
      assert.ok(stored !== null && typeof stored === "object");
      assert.ok("version" in stored);
      assert.equal(stored.version, 1);
      assert.ok("state" in stored);
      assert.equal(stored.state, "active");
      assert.ok("sessionId" in stored);
      assert.equal(stored.sessionId, session.current_session_id);
      assert.ok(
        "binding" in stored && stored.binding !== null && typeof stored.binding === "object",
      );
      assert.ok("threadId" in stored.binding);
      const threadId = stored.binding.threadId;
      assert.ok(typeof threadId === "string" && threadId.length > 0);
      if (
        qa &&
        ![session.current_session_id, threadId].every(
          (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
        )
      ) {
        throw new Error();
      }
      process.stdout.write(JSON.stringify({ sessionId: session.current_session_id, threadId }));
    } finally {
      sessions.close();
      state.close();
    }
  } catch (error) {
    if (!qa) {
      throw error;
    }
    process.stdout.write('{"error":"Conversation reply unavailable."}');
  }
}

type AgentSelection = {
  id?: string | undefined;
  namespaceId?: string | undefined;
  revision?: { id?: string | undefined } | undefined;
};

type SessionEvidenceOptions = {
  sessionKey: string;
  turnMarker: string;
  toolName?: string;
  resultPattern?: string | string[];
  expectedArguments?: Record<string, unknown>;
  expectedCatalog?: Catalog;
  codeModeCall?: CodeModeCall;
};

type GatewayCommand = [node: "node", evalFlag: "-e", script: string, ...args: string[]];
type GatewayExecution = { label: string; stdout: string };
type CodexBinding = { sessionId: string; threadId: string };
type ConversationReply = CodexBinding & { userSeq: number; assistantSeq: number };
type BindingOptions = { sessionKey: string; conversationReply?: boolean };
type BindingEvidence = CodexBinding | { failure: "session_missing" } | { error: string };
type ConversationReplyOptions = {
  sessionKey?: string;
  turnMarker?: string;
  runId?: string;
  previous?: ConversationReply | undefined;
};

const sessionEvidenceScript = `(${sessionEvidenceInGateway.toString()})();`;
const codexSessionBindingScript = `(${codexSessionBindingInGateway.toString()})();`;
const conversationReplyScript = `try { ${sessionEvidenceScript} } catch { process.stdout.write('{"error":"Conversation reply unavailable."}'); }`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isConversationReply(value: unknown): value is ConversationReply {
  return (
    isRecord(value) &&
    isConversationId(value.sessionId) &&
    isConversationId(value.threadId) &&
    typeof value.userSeq === "number" &&
    Number.isSafeInteger(value.userSeq) &&
    value.userSeq >= 0 &&
    typeof value.assistantSeq === "number" &&
    Number.isSafeInteger(value.assistantSeq) &&
    value.assistantSeq > value.userSeq
  );
}

const transcriptFailures: ReadonlySet<unknown> = new Set<TranscriptFailure>([
  "integrity",
  "prompt_missing",
  "answer_missing",
  "source",
  "run",
]);

export function createGatewaySessionEvidence({
  execGateway,
  proofMode,
}: {
  execGateway: (agent: AgentSelection, argv: GatewayCommand) => Promise<GatewayExecution>;
  proofMode: "openclaw" | "codex";
}) {
  async function sessionEvidence(
    agent: AgentSelection,
    {
      sessionKey,
      turnMarker,
      toolName,
      resultPattern,
      expectedArguments,
      expectedCatalog,
      codeModeCall,
    }: SessionEvidenceOptions,
  ) {
    if (codeModeCall !== undefined) {
      assert.equal(proofMode, "openclaw");
      assert.equal(toolName, "exec");
      assert.ok(typeof codeModeCall.code === "string" && codeModeCall.code.length > 0);
      assert.ok(typeof codeModeCall.title === "string" && codeModeCall.title.length > 0);
      assert.equal(codeModeCall.awaitResults, true);
      assert.equal(expectedArguments, undefined);
    }
    const execution = await execGateway(agent, [
      "node",
      "-e",
      sessionEvidenceScript,
      sessionKey,
      turnMarker,
      toolName ?? "",
      JSON.stringify(
        Array.isArray(resultPattern) ? resultPattern : resultPattern ? [resultPattern] : [],
      ),
      JSON.stringify(codeModeCall ?? expectedArguments ?? null),
      JSON.stringify(expectedCatalog ?? null),
      JSON.stringify(codeModeCall ?? null),
    ]);
    const evidence: unknown = JSON.parse(execution.stdout);
    assert.ok(isRecord(evidence), "expected Gateway session evidence");
    const results: unknown = evidence.results;
    if (results != null) {
      assert.ok(Array.isArray(results), "expected Gateway tool results");
      for (const result of results as unknown[]) {
        assert.ok(isRecord(result), "expected a Gateway tool result");
        if (typeof result.errorText === "string") {
          result.errorLines = redactedQaTail(result.errorText, process.env, {
            lines: 3,
            lineChars: 900,
          });
          delete result.errorText;
        }
      }
    }
    return { runtime: execution.label, ...evidence };
  }

  async function readCodexSessionBinding(
    agent: AgentSelection,
    { sessionKey, conversationReply = false }: BindingOptions,
  ): Promise<BindingEvidence> {
    assert.equal(proofMode, "codex");
    const execution = await execGateway(agent, [
      "node",
      "-e",
      codexSessionBindingScript,
      sessionKey,
      conversationReply ? "conversation-reply" : "",
    ]);
    const binding: unknown = JSON.parse(execution.stdout);
    assert.ok(isRecord(binding), "expected Gateway session binding evidence");
    if (binding.failure === "session_missing") {
      return { failure: binding.failure };
    }
    if (typeof binding.error === "string") {
      return { error: binding.error };
    }
    assert.ok(
      typeof binding.sessionId === "string" && typeof binding.threadId === "string",
      "expected Gateway session and thread IDs",
    );
    return { sessionId: binding.sessionId, threadId: binding.threadId };
  }

  async function readConversationReply(
    agent: AgentSelection,
    { sessionKey, turnMarker, runId, previous }: ConversationReplyOptions = {},
  ): Promise<ConversationReply> {
    let reading: "binding" | "transcript" = "binding";
    let reply: ConversationReply;
    let prior: ConversationReply | undefined;
    try {
      if (
        proofMode !== "codex" ||
        !isConversationId(agent?.id) ||
        typeof sessionKey !== "string" ||
        !/^agent:main:git-withdrawal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          sessionKey,
        ) ||
        typeof turnMarker !== "string" ||
        !/^FIRST_AGENT_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          turnMarker,
        ) ||
        typeof runId !== "string" ||
        !isGatewayCompletionId(runId) ||
        (previous !== undefined && !isConversationReply(previous))
      ) {
        throw new ConversationReplyError("integrity");
      }
      prior = previous === undefined ? undefined : { ...previous };
      const selected = Object.freeze({
        id: agent.id,
        namespaceId: agent.namespaceId,
        revision: Object.freeze({ id: agent.revision?.id }),
      });
      const before = await readCodexSessionBinding(selected, {
        sessionKey,
        conversationReply: true,
      });
      if (
        !("sessionId" in before) ||
        !isConversationId(before.sessionId) ||
        !isConversationId(before.threadId)
      ) {
        throw new ConversationReplyError("failure" in before ? "session_missing" : "binding");
      }
      reading = "transcript";
      const execution = await execGateway(selected, [
        "node",
        "-e",
        conversationReplyScript,
        sessionKey,
        turnMarker,
        "",
        "[]",
        "null",
        "null",
        "null",
        "conversation-reply",
        before.threadId,
        runId,
      ]);
      const evidence: unknown = JSON.parse(execution.stdout);
      reading = "binding";
      const after = await readCodexSessionBinding(selected, {
        sessionKey,
        conversationReply: true,
      });
      if (
        !("sessionId" in after) ||
        after.sessionId !== before.sessionId ||
        after.threadId !== before.threadId
      ) {
        throw new ConversationReplyError("binding");
      }
      if (isRecord(evidence) && evidence.failure !== undefined) {
        throw new ConversationReplyError(
          transcriptFailures.has(evidence.failure) ? evidence.failure : "transcript",
        );
      }
      reading = "transcript";
      assert.ok(isRecord(evidence));
      const observed = {
        sessionId: evidence.sessionId,
        threadId: before.threadId,
        userSeq: evidence.userSeq,
        assistantSeq: evidence.assistantSeq,
      };
      if (
        !isConversationReply(observed) ||
        observed.sessionId !== before.sessionId ||
        agent.id !== selected.id ||
        agent.namespaceId !== selected.namespaceId ||
        agent.revision?.id !== selected.revision.id
      ) {
        throw new ConversationReplyError("transcript");
      }
      reply = observed;
    } catch (error) {
      if (error instanceof ConversationReplyError) {
        throw error;
      }
      throw new ConversationReplyError(reading);
    }
    if (prior && (reply.sessionId !== prior.sessionId || reply.threadId !== prior.threadId)) {
      throw new ConversationReplyError("continuity");
    }
    if (prior && reply.userSeq <= prior.assistantSeq) {
      throw new ConversationReplyError("sequence");
    }
    return reply;
  }

  return { sessionEvidence, readCodexSessionBinding, readConversationReply };
}
