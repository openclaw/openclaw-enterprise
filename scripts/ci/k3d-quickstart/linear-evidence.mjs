// Evaluate the private chat response. Only fixed diagnostic labels leave the runner.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [mode, directory] = process.argv.slice(2);
const read = (file) => readFileSync(join(directory, file), "utf8");
function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch {
    return undefined;
  }
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
const containsTeam = (value) =>
  Boolean(
    team &&
    JSON.stringify(value ?? null)
      .toLowerCase()
      .includes(team),
  );

const chat = readJson("linear-result");
const messages = Array.isArray(chat?.history?.messages) ? chat.history.messages : [];
const markerFile = join(directory, "linear-marker");
const marker = existsSync(markerFile) ? read("linear-marker").trim() : "";
const userMessages = messages.filter((m) => m.role === "user");
const singleTurn =
  marker.length > 0 &&
  userMessages.length === 1 &&
  JSON.stringify(userMessages[0].content ?? null).includes(marker);
// chat.mjs creates a unique session, sends exactly once and fetches its history.
// Only consider rows after that prompt and reject any row attributed to a different run.
const runMessages = singleTurn
  ? messages
      .slice(messages.indexOf(userMessages[0]) + 1)
      .filter((m) => !m.__openclaw?.runId || m.__openclaw.runId === chat.runId)
  : [];
const calls = runMessages
  .filter((m) => m.role === "assistant" && Array.isArray(m.content))
  .flatMap((m) => m.content.filter((b) => b.type === "toolCall"));
const results = runMessages.filter((m) => m.role === "toolResult");
function historyMatched() {
  if (chat?.outcome?.status !== "ok" || !containsTeam(chat.outcome.terminalReply?.text)) {
    return false;
  }
  return calls.some(
    (call) =>
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
    if (http) console.log("Linear HTTP:", http[1]);
    for (const [needle, label] of [
      ["Linear is unavailable for this account.", "account-plugin-unavailable"],
      ["Expected exactly one marked run.", "marked-run-missing-or-ambiguous"],
      [
        "The selected run has no matched successful Linear result and terminal reply.",
        "matched-tool-or-terminal-missing",
      ],
      ["Transcript event length mismatch.", "transcript-event-length-mismatch"],
      ["SQLITE_BUSY", "transcript-database-busy"],
    ]) {
      if (log.includes(needle)) console.log("Linear cause:", label);
    }
  }
  const before = readJson("linear-agent-before.json")?.data;
  const after = readJson("linear-agent-after.json")?.data;
  if (
    before &&
    after &&
    JSON.stringify(before.repositoryBindings) !== JSON.stringify(after.repositoryBindings)
  ) {
    console.log("Linear cause: changed-git-binding");
  }
  if (chat) {
    console.log(
      "Linear outcome:",
      ["ok", "error", "timeout"].includes(chat.outcome?.status) ? chat.outcome.status : "other",
    );
    console.log(
      "Linear history:",
      singleTurn ? "marked-single-turn" : "missing-single-marked-prompt",
    );
    const names = new Set([...calls.map((c) => c.name), ...results.map((r) => r.toolName)]);
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
    const reply = chat.outcome?.terminalReply?.text ?? "";
    for (const [pattern, label] of [
      [/not connected|connect your account|reconnect|sign in|log in|oauth/i, "mentions-connection"],
      [/unauthorized|unauthenticated|forbidden|permission denied/i, "mentions-authorization"],
      [
        /unavailable|not available|not installed|could not find|no matching|no tools/i,
        "mentions-unavailable",
      ],
    ]) {
      if (pattern.test(reply)) console.log("Linear reply:", label);
      if (results.some((r) => pattern.test(JSON.stringify(r.content))))
        console.log("Linear result:", label);
    }
    if (results.some((m) => m.isError === true)) console.log("Linear result: tool-error");
    if (results.some((m) => m.isError !== true)) console.log("Linear result: tool-response");
    console.log(
      "Linear reply:",
      containsTeam(chat.outcome?.terminalReply?.text)
        ? "expected-id-present"
        : "expected-id-absent",
    );
  }
  const transcript = readJson("linear-transcript.json");
  if (transcript) {
    console.log(
      "Linear tool result:",
      containsTeam(transcript.results) ? "expected-id-present" : "expected-id-absent",
    );
    console.log(
      "Linear terminal:",
      containsTeam(transcript.reply) ? "expected-id-present" : "expected-id-absent",
    );
  }
} else {
  throw new Error("Choose history or diagnose.");
}
