// Evaluate the private chat response. Only fixed diagnostic labels leave the runner.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [mode, directory] = process.argv.slice(2);
if (directory === undefined) {
  throw new TypeError('The "path" argument must be of type string. Received undefined');
}
const read = (file: string): string => readFileSync(join(directory, file), "utf8");
function readJson(file: string): unknown {
  try {
    return JSON.parse(read(file));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validHistoryRow(value: unknown): boolean {
  if (!isRecord(value) || !nonemptyString(value.role)) {
    return false;
  }
  const attribution = value.__openclaw;
  if (
    attribution !== undefined &&
    (!isRecord(attribution) ||
      (attribution.runId !== undefined && !nonemptyString(attribution.runId)))
  ) {
    return false;
  }
  return (
    value.role !== "assistant" ||
    value.content === undefined ||
    typeof value.content === "string" ||
    Array.isArray(value.content)
  );
}

function validAssistantBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonemptyString(value.type) &&
    (value.type !== "toolCall" || (nonemptyString(value.name) && nonemptyString(value.id)))
  );
}

function validToolResult(value: Record<string, unknown>): boolean {
  return (
    nonemptyString(value.toolName) &&
    nonemptyString(value.toolCallId) &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

const tool = "codex_apps.linear.list_teams";
// OpenClaw renders native MCP events as server.tool. Some Codex versions
// surface the full provider-callable name instead. Match only this operation.
const listTools = new Set([
  tool,
  "mcp__codex_apps__linear_list_teams",
  "mcp__codex_apps__linear__list_teams",
  "codex_apps.linear_list_teams",
]);
const team = process.env.OCC_TEST_LINEAR_TEAM_ID?.toLowerCase();
function containsTeam(value: unknown): boolean {
  if (!team) {
    return false;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.toLowerCase().includes(team)) {
        return true;
      }
      continue;
    }
    const values = Array.isArray(item) ? array(item) : isRecord(item) ? Object.values(item) : [];
    for (const child of values) {
      pending.push(child);
    }
  }
  return false;
}

function promptText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return array(content)
    .map(record)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

const chat = readJson("linear-result");
const chatRecord = record(chat ?? {});
const outcome = record(chatRecord.outcome ?? {});
const terminalReply = record(outcome.terminalReply ?? {});
const history = record(chatRecord.history ?? {});
const markerFile = join(directory, "linear-marker");
const marker = existsSync(markerFile) ? read("linear-marker").trim() : "";
const messageValues = array(history.messages);
const messages = messageValues.map(record);
const userMessages = messages.filter((m) => m.role === "user");
const userMessage = userMessages[0];
const singleTurn =
  marker.length > 0 &&
  userMessages.length === 1 &&
  userMessage !== undefined &&
  promptText(userMessage.content).includes(marker);
// chat.mjs creates a unique session, sends exactly once and fetches its history.
// Only consider rows after that prompt and reject any row attributed to a different run.
const runMessages = singleTurn
  ? messages.slice(messages.indexOf(userMessage) + 1).filter((m) => {
      const runId = record(m.__openclaw ?? {}).runId;
      return !runId || runId === chatRecord.runId;
    })
  : [];
const blocks = runMessages.filter((m) => m.role === "assistant").flatMap((m) => array(m.content));
const calls = blocks.map(record).filter((b) => b.type === "toolCall");
const results = runMessages.filter((m) => m.role === "toolResult");
function historyMatched() {
  if (
    (chatRecord.runId !== undefined && !nonemptyString(chatRecord.runId)) ||
    !messageValues.every(validHistoryRow) ||
    !blocks.every(validAssistantBlock) ||
    !results.every(validToolResult) ||
    outcome.status !== "ok" ||
    typeof terminalReply.text !== "string" ||
    !containsTeam(terminalReply.text)
  ) {
    return false;
  }
  return calls.some(
    (call) =>
      typeof call.name === "string" &&
      listTools.has(call.name) &&
      typeof call.id === "string" &&
      call.id.length > 0 &&
      results.some(
        (result) =>
          result.toolCallId === call.id &&
          result.toolName === call.name &&
          result.isError !== true &&
          containsTeam(result.content),
      ),
  );
}

if (mode === "history") {
  process.exitCode = historyMatched() ? 0 : 1;
} else if (mode === "diagnose") {
  const phases = [
    "before",
    "catalog",
    "deploy",
    "prompt",
    "send",
    "transcript",
    "agent",
    "evidence",
  ];
  const stageFile = join(directory, "linear-stage");
  const stage = existsSync(stageFile) ? read("linear-stage").trim() : "";
  console.log("Linear stage:", phases.includes(stage) ? stage : "prepare");
  for (const file of [
    "catalog-secret-ref",
    "plugins",
    "plugin-agent",
    "linear-marker",
    "linear-result",
    "linear-run-id",
    "linear-transcript.json",
  ]) {
    if (existsSync(join(directory, file)) && statSync(join(directory, file)).size > 0) {
      console.log("Linear created:", file);
    }
  }
  const logFile = `linear-${stage}.log`;
  if (phases.includes(stage) && existsSync(join(directory, logFile))) {
    const log = read(logFile);
    const http = /^OCE REST request failed with HTTP ([1-5]\d\d)$/m.exec(log);
    if (http) {
      console.log("Linear HTTP:", http[1]);
    }
    const causes: [string, string][] = [
      ["Linear is unavailable for this account.", "account-plugin-unavailable"],
      ["Expected exactly one marked run.", "marked-run-missing-or-ambiguous"],
      [
        "The selected run has no matched successful Linear result and terminal reply.",
        "matched-tool-or-terminal-missing",
      ],
      ["Transcript event length mismatch.", "transcript-event-length-mismatch"],
      ["SQLITE_BUSY", "transcript-database-busy"],
    ];
    for (const [needle, label] of causes) {
      if (log.includes(needle)) {
        console.log("Linear cause:", label);
      }
    }
  }
  const before = record(readJson("linear-agent-before.json") ?? {}).data;
  const after = record(readJson("linear-agent-after.json") ?? {}).data;
  if (
    before &&
    after &&
    JSON.stringify(record(before).repositoryBindings) !==
      JSON.stringify(record(after).repositoryBindings)
  ) {
    console.log("Linear cause: changed-git-binding");
  }
  if (chat) {
    console.log(
      "Linear outcome:",
      typeof outcome.status === "string" && ["ok", "error", "timeout"].includes(outcome.status)
        ? outcome.status
        : "other",
    );
    console.log(
      "Linear history:",
      singleTurn ? "marked-single-turn" : "missing-single-marked-prompt",
    );
    const names = new Set(
      [...calls.map((c) => c.name), ...results.map((r) => r.toolName)].filter(
        (name): name is string => typeof name === "string",
      ),
    );
    const knownTools = new Set([
      ...listTools,
      "dispatch_action",
      "tool_search",
      "search_tools",
      "tool_search_tool_regex",
      "mcp__node_repl__js",
      "node_repl.js",
      "code_mode",
      "exec",
      "bash",
      "exec_command",
      "mcp__codex_apps__search",
      "codex_apps.search",
    ]);
    for (const name of names) {
      const label = knownTools.has(name)
        ? name
        : /^(?:mcp__codex_apps__linear_|codex_apps\.linear[._])/.test(name)
          ? "other-linear-action"
          : "other";
      console.log("Linear tool:", label);
    }
    // Returned text is diagnostic only. Report categories, never account output.
    const reply = typeof terminalReply.text === "string" ? terminalReply.text : "";
    const replyPatterns: [RegExp, string][] = [
      [/not connected|connect your account|reconnect|sign in|log in|oauth/i, "mentions-connection"],
      [/unauthorized|unauthenticated|forbidden|permission denied/i, "mentions-authorization"],
      [
        /unavailable|not available|not installed|could not find|no matching|no tools/i,
        "mentions-unavailable",
      ],
    ];
    for (const [pattern, label] of replyPatterns) {
      if (pattern.test(reply)) {
        console.log("Linear reply:", label);
      }
      if (results.some((r) => pattern.test(JSON.stringify(r.content) ?? ""))) {
        console.log("Linear result:", label);
      }
    }
    if (results.some((m) => m.isError === true)) {
      console.log("Linear result: tool-error");
    }
    if (results.some((m) => m.isError !== true)) {
      console.log("Linear result: tool-response");
    }
    console.log(
      "Linear reply:",
      containsTeam(reply) ? "expected-id-present" : "expected-id-absent",
    );
  }
  const transcript = readJson("linear-transcript.json");
  if (transcript) {
    console.log(
      "Linear tool result:",
      containsTeam(record(transcript).results) ? "expected-id-present" : "expected-id-absent",
    );
    console.log(
      "Linear terminal:",
      containsTeam(record(transcript).reply) ? "expected-id-present" : "expected-id-absent",
    );
  }
} else {
  throw new Error("Choose history or diagnose.");
}
