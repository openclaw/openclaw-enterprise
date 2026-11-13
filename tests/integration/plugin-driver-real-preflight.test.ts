import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type UserMessageMetadata = {
  __openclaw?: { mirrorIdentity: string; mirrorOrigin: string };
  idempotencyKey?: string | number;
};
type TranscriptRow = string | { role: string; content: string | readonly object[] };
type EvidenceOptions = { sessionKey: string; turnMarker: string; toolName: string };
type AgentSelection = {
  id?: string | undefined;
  namespaceId?: string | undefined;
  revision?: { id?: string | undefined } | undefined;
};
type TranscriptAssertion<Result> = (
  agent: AgentSelection,
  options: EvidenceOptions,
) => Promise<Result>;
type TranscriptAssertions = {
  assertSessionToolCallEvidence: TranscriptAssertion<{ codexMirrorTurnVerified?: boolean }>;
  assertNoSessionToolCallEvidence: TranscriptAssertion<void>;
  assertSessionToolDeniedEvidence: TranscriptAssertion<void>;
};
type TranscriptAssertionOptions = {
  proofMode: "codex";
  gatewayUrl: undefined;
  execCodex: undefined;
  waitFor: undefined;
  readRuntimeLogs: undefined;
  recordRuntimeLogs: undefined;
  execGateway: (
    agent: AgentSelection,
    argv: [node: "node", evalFlag: "-e", script: string, ...args: string[]],
  ) => Promise<{ label: string; stdout: string }>;
};

async function transcriptWriter(t: TestContext, prefix: string) {
  const {
    createNativePluginAssertions,
  }: {
    createNativePluginAssertions: (options: TranscriptAssertionOptions) => TranscriptAssertions;
  } = await import("../helpers/plugin-driver-real.mjs");
  const directory = await temporaryDirectory(t, prefix);

  return (name: string, rows: readonly TranscriptRow[]) => {
    const path = join(directory, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER)",
      );
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run("proof", "session", "{}");
      const insert = db.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
      );
      for (const [seq, row] of rows.entries()) {
        // Raw event text includes malformed rows that cannot be serialized as messages.
        insert.run(
          "session",
          seq,
          typeof row === "string" ? row : JSON.stringify({ type: "message", message: row }),
        );
      }
    } finally {
      db.close();
    }

    const assertions = createNativePluginAssertions({
      proofMode: "codex",
      gatewayUrl: undefined,
      execCodex: undefined,
      waitFor: undefined,
      readRuntimeLogs: undefined,
      recordRuntimeLogs: undefined,
      async execGateway(_agent, [, , script, ...args]) {
        const run = spawnSync(
          process.execPath,
          [
            "-e",
            script.replace(
              '"/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
              JSON.stringify(path),
            ),
            ...args,
          ],
          { encoding: "utf8" },
        );
        assert.equal(run.status, 0, run.stderr);
        return { label: "stub-runtime", stdout: run.stdout };
      },
    });
    return assertions;
  };
}

function evidenceFailureDetails(error: Error) {
  const message = error.message.slice(error.message.indexOf("{")).split("\n")[0];
  assert.ok(message);
  const details: unknown = JSON.parse(message);
  assert.ok(typeof details === "object" && details !== null && "markerUserMessages" in details);
  return details;
}

// Run in a child so selection is set before the real fixture module is loaded,
// without changing the caller's environment or touching a cluster or database.
test("the full real plugin proof rejects shared or missing scenario databases before provisioning", () => {
  const child = fileURLToPath(
    new URL("../fixtures/plugin-driver-preflight-database-child.ts", import.meta.url),
  );
  const result = spawnSync(process.execPath, [child], {
    encoding: "utf8",
    env: {
      ...process.env,
      OCC_TEST_PLUGIN_DRIVER_REAL: "1",
      OCC_TEST_KUBERNETES_KUBECONFIG: "/nonexistent",
      OCC_TEST_KUBERNETES_CONTEXT: "preflight",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "preflight",
      OCC_TEST_KUBERNETES_CODEX_IMAGE: "preflight",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "");
});

// Finding 2019: a Codex turn whose prompt mirror falls before the evidence window failed with
// only the turn object. Its failure now lists every marker-bearing user message. The stub runs
// the evidence script against a local transcript instead of the gateway Pod's.
test("a Codex turn without its prompt mirror names the marker-bearing user messages", async (t) => {
  const transcript = await transcriptWriter(t, "codex-prompt-evidence-");
  const marker = "calendar-marker-2019";
  const user = (seq: number, mirrorIdentity?: string) => ({
    role: "user",
    content: `List my calendars ${marker}`,
    ...(mirrorIdentity ? { __openclaw: { mirrorIdentity, mirrorOrigin: "codex-app-server" } } : {}),
    timestamp: 1_000 + seq,
  });
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "list_calendars", arguments: {} }],
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:call" },
  };
  const result = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "list_calendars",
    content: [{ type: "text", text: '{"calendars":["Work"]}' }],
    isError: false,
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:result" },
  };
  const answer = {
    role: "assistant",
    content: [{ type: "text", text: `Work ${marker}` }],
    stopReason: "stop",
    __openclaw: { mirrorIdentity: "turn-1:assistant" },
  };
  const options = { sessionKey: "proof", turnMarker: marker, toolName: "list_calendars" };

  // One mirrored prompt: the turn is proven, and the listing marks the prompt in the window.
  const proven = await transcript("proven", [
    user(0, "turn-1:prompt"),
    call,
    result,
    answer,
  ]).assertSessionToolCallEvidence({}, options);
  assert.ok(typeof proven === "object" && proven !== null && "codexMirrorTurnVerified" in proven);
  assert.equal(proven.codexMirrorTurnVerified, true);

  // An unmirrored copy after the mirrored prompt starts the window past the prompt mirror.
  const late = transcript("late", [user(0, "turn-1:prompt"), user(1), call, result, answer]);
  const expected = [
    {
      seq: 0,
      inWindow: false,
      mirrorIdentity: "turn-1:prompt",
      mirrorOrigin: "codex-app-server",
      idempotencyKey: null,
      timestamp: 1000,
    },
    {
      seq: 1,
      inWindow: true,
      mirrorIdentity: null,
      mirrorOrigin: null,
      idempotencyKey: null,
      timestamp: 1001,
    },
  ];
  await assert.rejects(late.assertSessionToolCallEvidence({}, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^proof Codex run must include a native prompt and tool call/);
    const details = evidenceFailureDetails(error);
    assert.ok("turn" in details && typeof details.turn === "object" && details.turn !== null);
    assert.ok("promptSeen" in details.turn);
    assert.equal(details.turn.promptSeen, false);
    assert.deepEqual(details.markerUserMessages, expected);
    return true;
  });
  // The disabled-tool phase's check lists them too.
  const quiet = transcript("quiet", [user(0, "turn-1:prompt"), user(1), answer]);
  await assert.rejects(quiet.assertNoSessionToolCallEvidence({}, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^proof must include a completed marker-bearing Codex run: /);
    const details = evidenceFailureDetails(error);
    assert.deepEqual(details.markerUserMessages, expected);
    return true;
  });
});

// Findings 2029 and 2030: the evidence script reads every transcript row of the session, so a row
// that is not JSON must not fail it, and a denied Codex turn without its prompt mirror lists the
// newest ten marker-bearing user messages, as the allowed turn's check does. The stub runs the
// evidence script against a local transcript instead of the gateway Pod's.
test("the session evidence tolerates malformed rows and lists the newest marker messages on denial", async (t) => {
  const transcript = await transcriptWriter(t, "codex-session-evidence-");
  const marker = "calendar-marker-2030";
  const user = (seq: number, extra: UserMessageMetadata = {}) => ({
    role: "user",
    content: `List my calendars ${marker}`,
    timestamp: 1_000 + seq,
    ...extra,
  });
  const prompt = (seq: number, extra: UserMessageMetadata = {}) =>
    user(seq, {
      __openclaw: { mirrorIdentity: "turn-1:prompt", mirrorOrigin: "codex-app-server" },
      ...extra,
    });
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "list_calendars", arguments: {} }],
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:call" },
  };
  const result = (isError: boolean) => ({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "list_calendars",
    content: [
      { type: "text", text: isError ? "user rejected MCP tool call" : '{"calendars":["Work"]}' },
    ],
    isError,
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:result" },
  });
  const answer = {
    role: "assistant",
    content: [{ type: "text", text: `Done ${marker}` }],
    stopReason: "stop",
    __openclaw: { mirrorIdentity: "turn-1:assistant" },
  };
  const options = { sessionKey: "proof", turnMarker: marker, toolName: "list_calendars" };

  // A truncated row from an earlier turn, before the evidence window, leaves the proof intact.
  const proven = await transcript("malformed", [
    '{"type":"message","message":{"role":"user"',
    prompt(1),
    call,
    result(false),
    answer,
  ]).assertSessionToolCallEvidence({}, options);
  assert.ok(typeof proven === "object" && proven !== null && "codexMirrorTurnVerified" in proven);
  assert.equal(proven.codexMirrorTurnVerified, true);

  // A truncated row inside the window could be the tool call the disabled-tool phase must not
  // make, so the check that the turn made none fails on it instead of passing over it.
  const hidden = transcript("hidden", [
    '{"type":"message","message":{"role":"user"',
    prompt(1),
    '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1"',
    answer,
  ]);
  await assert.rejects(hidden.assertNoSessionToolCallEvidence({}, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /transcript row 2 in the evidence window is not JSON/);
    return true;
  });

  // Ten earlier marker-bearing retries, then the mirrored prompt and an unmirrored copy after it,
  // which starts the window past the prompt mirror: the denied turn's check fails and lists the
  // newest ten. Only a string idempotency key is reported.
  const denied = transcript("denied", [
    ...Array.from({ length: 10 }, (_, seq) => user(seq)),
    prompt(10, { idempotencyKey: "retry-10" }),
    user(11, { idempotencyKey: 11 }),
    call,
    result(true),
    answer,
  ]);
  const listed = (seq: number) => ({
    seq,
    inWindow: seq === 11,
    mirrorIdentity: seq === 10 ? "turn-1:prompt" : null,
    mirrorOrigin: seq === 10 ? "codex-app-server" : null,
    idempotencyKey: seq === 10 ? "retry-10" : null,
    timestamp: 1_000 + seq,
  });
  await assert.rejects(denied.assertSessionToolDeniedEvidence({}, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /^proof denied Codex run must include a native prompt and tool call\/result plus an owned terminal reply: \{/,
    );
    const details = evidenceFailureDetails(error);
    assert.ok("turn" in details && typeof details.turn === "object" && details.turn !== null);
    assert.ok("promptSeen" in details.turn);
    assert.equal(details.turn.promptSeen, false);
    assert.deepEqual(
      details.markerUserMessages,
      Array.from({ length: 10 }, (_, index) => listed(index + 2)),
    );
    return true;
  });
});
