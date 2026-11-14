import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  completedToolResult as findCompletedToolResult,
  expandTranscriptMessage,
  sessionEvidenceScript,
} from "../helpers/normal-agent-tools.mjs";
import { repositoryFailureSummaryScript } from "../helpers/repository-native-journey.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const toolCall = Type.Object({
  id: Type.String(),
  seq: Type.Number(),
  name: Type.String(),
  processAction: Type.Optional(Type.String()),
  processSessionId: Type.Optional(Type.String()),
  operations: Type.Array(Type.String()),
});

const toolResult = Type.Object({
  toolCallId: Type.String(),
  seq: Type.Number(),
  isError: Type.Boolean(),
  status: Type.Optional(Type.String()),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  processSessionId: Type.Optional(Type.String()),
});

const sessionEvidence = Type.Object({
  promptReportSource: Type.String(),
  promptToolNames: Type.Array(Type.String()),
  terminalAssistantMarkerSeen: Type.Boolean(),
  calls: Type.Array(toolCall),
  results: Type.Array(toolResult),
});

const failureSummary = Type.Object({
  toolResults: Type.Array(
    Type.Object({ seq: Type.Number(), categories: Type.Array(Type.String()) }),
  ),
});

type ToolCall = Omit<Static<typeof toolCall>, "operations">;
type ToolResult = Static<typeof toolResult>;

function completedToolResult(
  trace: { calls: readonly ToolCall[]; results: readonly ToolResult[] },
  call: Pick<ToolCall, "id" | "seq">,
): ToolResult | undefined {
  const result: unknown = findCompletedToolResult(trace, call);
  if (result !== undefined) {
    assert.ok(Check(toolResult, result), "invalid completed tool result");
  }
  return result;
}

const call = { id: "push", seq: 44, name: "exec" };
const failure = { toolCallId: "push", seq: 45, isError: true };
const success = {
  toolCallId: "push",
  seq: 47,
  isError: false,
  status: "completed",
  exitCode: 0,
};

test("installed tool evidence retains a later completion of the same call", () => {
  // Observed installed trace: an interim push error, followed by the actual
  // successful completion. Independent GitHub readback confirmed the commit.
  assert.equal(completedToolResult({ calls: [call], results: [failure, success] }, call), success);
});

test("missing, failed, stale and unrelated tool results do not prove completion", () => {
  for (const results of [
    [],
    [failure],
    [{ ...success, toolCallId: "other" }],
    [{ ...success, seq: 43 }],
    [{ ...success, exitCode: 1 }],
    [success, { ...failure, seq: 48 }],
    [{ ...success, status: "running" }],
  ]) {
    assert.equal(completedToolResult({ calls: [call], results }, call), undefined);
  }
});

test("running execution requires a later successful poll of its exact process session", () => {
  const running = { ...success, status: "running", exitCode: null, processSessionId: "session-a" };
  const poll = {
    id: "poll",
    seq: 48,
    name: "process",
    processAction: "poll",
    processSessionId: "session-a",
  };
  const completed = { ...success, seq: 49, toolCallId: "poll", processSessionId: "session-a" };
  const evidence = (pollCall: typeof poll, result: typeof completed) => ({
    calls: [call, pollCall],
    results: [running, result],
  });
  assert.equal(completedToolResult(evidence(poll, completed), call), completed);
  const invalidPolls: [typeof poll, typeof completed][] = [
    [{ ...poll, processSessionId: "session-b" }, completed],
    [poll, { ...completed, processSessionId: "session-b" }],
    [{ ...poll, processAction: "kill" }, completed],
    [{ ...poll, seq: 46 }, completed],
    [poll, { ...completed, seq: 47 }],
    [poll, { ...completed, exitCode: 1 }],
    [poll, { ...completed, isError: true }],
  ];
  for (const [pollCall, result] of invalidPolls) {
    assert.equal(completedToolResult(evidence(pollCall, result), call), undefined);
  }
  assert.equal(
    completedToolResult(
      {
        calls: [call, poll],
        results: [running, completed, { ...completed, seq: 50, isError: true }],
      },
      call,
    ),
    undefined,
  );
});

// Schema captured from a real installed OpenClaw code-mode transcript.
const nested = (
  id: string,
  parent: string,
  name: string,
  input: { command: string; workdir?: string } | { action: string; sessionId: string },
  result: {
    content: { type: string; text: string }[];
    details: { status: string; exitCode?: number; sessionId?: string };
    isError?: boolean;
  },
) => ({
  role: "custom",
  customType: "openclaw.nested-tool.v1",
  details: {
    parentToolCallId: parent,
    toolCallId: id,
    toolName: name,
    input,
    result,
    isError: false,
  },
});
const parent = (id: string) => ({
  role: "assistant",
  content: [
    { type: "toolCall", id, name: "exec", arguments: { code: "model source is not evidence" } },
  ],
});

test("nested runtime records require a real preceding parent and preserve errors", () => {
  const parents = new Set<string>();
  const result = { content: [], details: { status: "completed", exitCode: 0 } };
  const message = nested("push", "parent", "exec", { command: "git push" }, result);
  assert.deepEqual(expandTranscriptMessage(message, 10, parents), []);
  expandTranscriptMessage(parent("parent"), 9, parents);
  const entries: unknown = expandTranscriptMessage(message, 10, parents);
  assert.ok(
    Check(Type.Array(Type.Object({ seq: Type.Number(), message: Type.Unknown() })), entries),
  );
  const [nestedCall, nestedResult] = entries;
  assert.ok(nestedCall && nestedResult);
  assert.ok(Check(Type.Object({ content: Type.Array(Type.Unknown()) }), nestedCall.message));
  assert.partialDeepStrictEqual(nestedCall.message.content[0], { id: "push" });
  assert.ok(nestedCall.seq < nestedResult.seq);
  assert.partialDeepStrictEqual(nestedResult.message, { details: { exitCode: 0 } });

  const withError: unknown = expandTranscriptMessage(
    { ...message, details: { ...message.details, isError: true } },
    10,
    parents,
  );
  assert.ok(Check(Type.Array(Type.Unknown()), withError));
  assert.partialDeepStrictEqual(withError[1], { message: { isError: true } });

  const untrusted: unknown = expandTranscriptMessage(
    { ...message, customType: "untrusted" },
    10,
    parents,
  );
  assert.ok(Check(Type.Array(Type.Unknown()), untrusted));
  assert.partialDeepStrictEqual(untrusted[0], { message: { role: "custom" } });
});

test("installed evidence reader recognizes nested push and exact process completion", async (t) => {
  const directory = await temporaryDirectory(t, "nested-repository-evidence-");
  const path = join(directory, "agent.sqlite");
  // Close the writable database before either child opens the stored transcript.
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER)",
    );
    db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run("proof", "session", "{}");
    db.exec("CREATE TABLE session_entry_snapshots (session_key TEXT, field TEXT, value_json TEXT)");
    db.prepare("INSERT INTO session_entry_snapshots VALUES (?, ?, ?)").run(
      "proof",
      "systemPromptReport",
      JSON.stringify({ source: "run", tools: { entries: [{ name: "exec" }] } }),
    );
    const command = "git push origin HEAD:refs/heads/proof";
    const records = [
      { role: "user", content: "proof-marker" },
      parent("push-parent"),
      nested(
        "push",
        "push-parent",
        "exec",
        { command, workdir: "/workspace/repo" },
        { content: [], details: { status: "running", sessionId: "swift-coral" } },
      ),
      parent("poll-parent"),
      nested(
        "poll",
        "poll-parent",
        "process",
        { action: "poll", sessionId: "swift-coral" },
        { content: [], details: { status: "completed", exitCode: 0, sessionId: "swift-coral" } },
      ),
      parent("ordinary-failure"),
      {
        role: "toolResult",
        toolCallId: "ordinary-failure",
        content: [{ type: "text", text: "SSL certificate problem" }],
        isError: true,
      },
      parent("failed-parent"),
      nested(
        "nested-failure",
        "failed-parent",
        "exec",
        { command: "pwd" },
        {
          content: [{ type: "text", text: "authentication failed" }],
          details: { status: "error", exitCode: 1 },
          isError: true,
        },
      ),
      {
        role: "assistant",
        content: [{ type: "text", text: "proof-marker" }],
        stopReason: "stop",
      },
    ];
    for (const [seq, message] of records.entries()) {
      const event = JSON.stringify({ type: "message", message });
      db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, NULL, ?)").run(
        "session",
        seq,
        event,
        Buffer.byteLength(event),
      );
    }
  } finally {
    db.close();
  }
  const script = sessionEvidenceScript.replace(
    '"/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
    JSON.stringify(path),
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      script,
      "proof",
      "proof-marker",
      "exec",
      "",
      JSON.stringify({
        toolNames: ["exec", "process"],
        commands: [
          {
            operation: "push",
            workdir: "/workspace/repo",
            argv: ["git", "push", "origin", "HEAD:refs/heads/proof"],
          },
        ],
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const trace: unknown = JSON.parse(result.stdout);
  assert.ok(Check(sessionEvidence, trace), "invalid session evidence");
  assert.equal(trace.promptReportSource, "run");
  assert.deepEqual(trace.promptToolNames, ["exec"]);
  const push = trace.calls.find((value) => value.operations.includes("push"));
  assert.ok(push);
  assert.equal(push.id, "push");
  assert.equal(completedToolResult(trace, push)?.toolCallId, "poll");
  assert.equal(trace.terminalAssistantMarkerSeen, true);
  assert.equal(trace.calls.filter((value) => value.operations.length).length, 1);
  // Diagnostics and acceptance read the same stored events. Correlation must
  // survive both ordinary results and the two events expanded from a nested call.
  const summaryResult = spawnSync(
    process.execPath,
    [
      "-e",
      repositoryFailureSummaryScript.replace(
        '"/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
        JSON.stringify(path),
      ),
      "proof",
    ],
    { encoding: "utf8" },
  );
  assert.equal(summaryResult.status, 0, summaryResult.stderr);
  const summary: unknown = JSON.parse(summaryResult.stdout);
  assert.ok(Check(failureSummary, summary), "invalid repository failure summary");
  for (const [id, category] of [
    ["ordinary-failure", "tls-validation"],
    ["nested-failure", "repository-authentication"],
  ]) {
    const matchedResult: ToolResult | undefined = trace.results.find(
      (entry) => entry.toolCallId === id,
    );
    assert.ok(matchedResult, `acceptance reader must retain ${id}`);
    assert.deepEqual(
      summary.toolResults.find((entry) => entry.seq === matchedResult.seq)?.categories,
      [category],
    );
  }
  const poll = trace.results.find((value) => value.toolCallId === "poll");
  assert.ok(poll);
  poll.exitCode = 1;
  assert.equal(completedToolResult(trace, push), undefined);
});
