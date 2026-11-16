import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { asRecord } from "../../packages/utils/src/index.ts";
import { createNativePluginAssertions } from "../helpers/native-plugin-assertions.ts";
import type { SessionEvidenceOptions } from "../helpers/plugin-gateway-session-evidence.ts";
import { registerQaSecret } from "../helpers/qa-secrets.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type AssistantCall<Arguments> = {
  role: "assistant";
  content: [{ type: "toolCall"; id: string; name: string; arguments: Arguments }];
};
type ToolIdentity = { id: string; name: string; source: string };
type SearchQuery = { query: string; limit: number };
type SearchGroup = { query: string; candidates: ToolIdentity[]; truncated?: boolean };
type Mutation<Call, Result> = [name: string, change: (call: Call, result: Result) => void];

type CodeModeDetails =
  | {
      status: string;
      value:
        | { status: string; error: string }
        | {
            status: string;
            exitCode: number;
            aggregated: string;
            catalog?: { name: string; source: string; callableName: string }[];
          };
    }
  | { status: string; bridgeDispatchStarted: boolean; error: string };

const sessionId = "session-fixture";

function promptSnapshot(names: readonly string[]): string {
  return JSON.stringify({ source: "run", tools: { entries: names.map((name) => ({ name })) } });
}

function insertTranscript(
  db: DatabaseSync,
  messages: readonly Record<string, unknown>[],
  isCompressed: (seq: number) => boolean,
): void {
  const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)");
  for (const [seq, message] of messages.entries()) {
    const text = JSON.stringify({ type: "message", message });
    const compressed = isCompressed(seq);
    insert.run(
      sessionId,
      seq,
      compressed ? null : text,
      compressed ? zstdCompressSync(text) : null,
      Buffer.byteLength(text, "utf8"),
    );
  }
}

function readDiagnostic(message: string): Record<string, unknown> {
  const opening = message.indexOf("{");
  assert.notEqual(opening, -1, "missing JSON diagnostic");
  const value: unknown = JSON.parse(message.slice(opening));
  const diagnostic = asRecord(value);
  assert.ok(diagnostic, "expected a JSON diagnostic object");
  return diagnostic;
}

export function registerQaNativeToolEvidenceCase(): void {
  test("native tool evidence reads compressed rows, prompt snapshots and command exit status", async (t) => {
    const directory = await temporaryDirectory(t, "oce-tool-evidence-");
    const databasePath = join(directory, "transcript.sqlite");
    const sessionKey = "agent:main:evidence-fixture";
    const toolErrorSecret = "fixture-tool-error-secret";
    registerQaSecret(toolErrorSecret);
    const allowedResult = {
      role: "toolResult",
      toolCallId: "allowed-call",
      toolName: "exec",
      content: [{ type: "text", text: "TOOL-SUCCESS" }],
      isError: false,
      details: { exitCode: 0 },
    };
    const deniedResult = {
      role: "toolResult",
      toolCallId: "denied-call",
      toolName: "automations",
      isError: true,
      content: [
        {
          type: "text",
          text: [
            "earlier error context omitted from bounded diagnostic",
            "Automation not found: fixture-job",
            `private fixture value: ${toolErrorSecret}`,
            "x".repeat(3_000),
          ].join("\n"),
        },
      ],
    };
    const rows = [
      { role: "user", content: "allowed-fixture" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "allowed-call",
            name: "exec",
            arguments: { command: "printf TOOL-SUCCESS" },
          },
        ],
      },
      allowedResult,
      {
        role: "assistant",
        content: [{ type: "text", text: "allowed-fixture" }],
        stopReason: "stop",
      },
      { role: "user", content: "denied-fixture" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "denied-call",
            name: "automations",
            arguments: {
              action: "update",
              jobId: "fixture-job",
              job: { payload: { timeoutSeconds: 5 } },
            },
          },
        ],
      },
      deniedResult,
      {
        role: "assistant",
        content: [{ type: "text", text: "denied-fixture" }],
        stopReason: "stop",
      },
    ];
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, entry_json TEXT);
        CREATE TABLE session_entry_snapshots(session_key TEXT, field TEXT, value_json TEXT);
        CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER);`);
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(sessionKey, sessionId, "{}");
      db.prepare("INSERT INTO session_entry_snapshots VALUES (?, ?, ?)").run(
        sessionKey,
        "systemPromptReport",
        promptSnapshot(["exec", "automations"]),
      );
      insertTranscript(db, rows, (seq) => [1, 2, 4, 5, 7].includes(seq));
    } finally {
      db.close();
    }
    // Run the actual evidence reader in a child process with disposable SQLite state.
    const assertionOptions = {
      execGateway: async (_agent, [command, flag, script, ...args]) => {
        assert.equal(command, "node");
        assert.equal(flag, "-e");
        const localScript = script.replace(
          '"/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
          JSON.stringify(databasePath),
        );
        return {
          label: "sqlite-fixture",
          stdout: execFileSync(process.execPath, ["-e", localScript, ...args], {
            encoding: "utf8",
          }),
        };
      },
      proofMode: "openclaw",
    } satisfies Parameters<typeof createNativePluginAssertions>[0];
    const native = createNativePluginAssertions(assertionOptions);
    const shellEvidence = {
      sessionKey,
      turnMarker: "allowed-fixture",
      toolName: "exec",
      resultPattern: "TOOL-SUCCESS",
    };
    const allowed = await native.assertSessionToolCallEvidence(
      {},
      {
        ...shellEvidence,
        expectedExitCode: 0,
      },
    );
    assert.equal(allowed.toolCallId, "allowed-call");
    assert.equal(allowed.promptAdvertised, true);
    assert.equal(allowed.exitCode, 0);
    const promptReport = asRecord(allowed.promptReport);
    assert.ok(promptReport);
    assert.equal(promptReport.source, "run");
    assert.deepEqual(promptReport.toolNames, ["exec", "automations"]);
    await t.test("positive direct evidence matches the requested arguments", async () => {
      assert.equal(
        (
          await native.assertSessionToolCallEvidence(
            {},
            { ...shellEvidence, expectedArguments: { command: "printf TOOL-SUCCESS" } },
          )
        ).toolCallId,
        "allowed-call",
      );
      await assert.rejects(
        native.assertSessionToolCallEvidence(
          {},
          { ...shellEvidence, expectedArguments: { command: "a different task" } },
        ),
        /matching successful result/,
      );
    });
    const promptCases = [
      [
        undefined,
        { present: false, valueType: "undefined", entriesType: "undefined", entriesCount: null },
      ],
      [
        { source: "estimate", tools: { entries: [{ name: "exec" }] } },
        {
          present: true,
          valueType: "object",
          source: "estimate",
          entriesType: "array",
          entriesCount: 1,
        },
      ],
      [
        { source: "run", tools: { entries: {} } },
        {
          present: true,
          valueType: "object",
          source: "run",
          entriesType: "object",
          entriesCount: null,
        },
      ],
    ] as const;
    for (const [report, expectedShape] of promptCases) {
      const update = new DatabaseSync(databasePath);
      try {
        update.exec("DELETE FROM session_entry_snapshots");
        if (report !== undefined) {
          update
            .prepare("INSERT INTO session_entry_snapshots VALUES (?, ?, ?)")
            .run(sessionKey, "systemPromptReport", JSON.stringify(report));
        }
      } finally {
        update.close();
      }
      await assert.rejects(
        native.assertSessionToolCallEvidence({}, shellEvidence),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /tools\.entries snapshot:/);
          const diagnostic = readDiagnostic(error.message);
          assert.equal(diagnostic.sessionId, sessionId);
          assert.deepEqual(diagnostic.promptReport, expectedShape);
          return true;
        },
      );
    }
    const restore = new DatabaseSync(databasePath);
    try {
      restore.prepare("UPDATE session_entry_snapshots SET value_json = ?").run(promptSnapshot([]));
      await assert.rejects(
        native.assertSessionToolCallEvidence({}, shellEvidence),
        /prompt tools must advertise exec: .*"promptToolNames":\[\]/,
      );
      restore
        .prepare("UPDATE session_entry_snapshots SET value_json = ?")
        .run(promptSnapshot(["exec", "automations"]));
    } finally {
      restore.close();
    }
    for (const details of [
      { exitCode: 1 },
      undefined,
      { status: "running", sessionId: "fixture-process" },
    ]) {
      const text = JSON.stringify({ type: "message", message: { ...allowedResult, details } });
      const update = new DatabaseSync(databasePath);
      try {
        update
          .prepare(
            "UPDATE transcript_events SET event_zstd = ?, event_utf8_bytes = ? WHERE seq = 2",
          )
          .run(zstdCompressSync(text), Buffer.byteLength(text, "utf8"));
      } finally {
        update.close();
      }
      await assert.rejects(
        native.assertSessionToolCallEvidence({}, { ...shellEvidence, expectedExitCode: 0 }),
        details?.status === "running"
          ? /must exit with code 0: .*"status":"running"/
          : /must exit with code 0/,
      );
    }
    // Tools without structured exit status retain their existing evidence contract.
    assert.equal(
      (await native.assertSessionToolCallEvidence({}, shellEvidence)).toolCallId,
      "allowed-call",
    );
    const denial = {
      sessionKey,
      turnMarker: "denied-fixture",
      toolName: "automations",
      expectedArguments: {
        action: "update",
        jobId: "fixture-job",
        job: { payload: { timeoutSeconds: 5 } },
      },
      resultPattern: ["job.payload.kind:", "Automation not found: fixture-job"],
    };
    const denialProof = await native.assertSessionToolPolicyDeniedEvidence({}, denial);
    assert.equal(denialProof.toolCallId, "denied-call");
    assert.equal(denialProof.matchedRefusal, "Automation not found: fixture-job");
    await assert.rejects(
      native.assertSessionToolPolicyDeniedEvidence(
        {},
        { ...denial, expectedArguments: { ...denial.expectedArguments, jobId: "wrong-target" } },
      ),
      /exact requested action and target/,
    );
    await assert.rejects(
      native.assertSessionToolPolicyDeniedEvidence(
        {},
        {
          ...denial,
          resultPattern: [
            "job.payload.kind:",
            "automation command payloads cannot be created or edited",
          ],
        },
      ),
      /the attempted tool must return the policy refusal/,
    );
    await assert.rejects(
      native.assertSessionToolPolicyDeniedEvidence(
        {},
        {
          ...denial,
          expectedArguments: {
            ...denial.expectedArguments,
            job: { payload: { timeoutSeconds: 6 } },
          },
        },
      ),
      /exact requested action and target/,
    );
    await assert.rejects(native.assertSessionToolCallEvidence({}, denial), (error: unknown) => {
      assert.ok(error instanceof Error);
      const diagnostic = readDiagnostic(error.message);
      assert.ok(Array.isArray(diagnostic.results));
      const result = asRecord(diagnostic.results[0]);
      assert.ok(result);
      assert.equal(result.toolCallId, "denied-call");
      assert.equal(result.errorText, undefined);
      assert.ok(Array.isArray(result.errorLines));
      const lines: unknown[] = result.errorLines;
      const [refusal, redaction, tail] = lines;
      assert.equal(lines.length, 3);
      assert.equal(refusal, "Automation not found: fixture-job");
      assert.equal(redaction, "private fixture value: [env:qa-secret]");
      assert.equal(error.message.includes(toolErrorSecret), false);
      assert.ok(
        lines.every(
          (line) => typeof line === "string" && line.length <= 900 + "... [truncated]".length,
        ),
      );
      assert.ok(typeof tail === "string");
      assert.match(tail, /\[truncated\]$/);
      return true;
    });

    function replaceTranscript(
      messages: readonly Record<string, unknown>[],
      promptNames: readonly string[] = ["exec", "dispatch_action", "tool_search"],
    ): void {
      const update = new DatabaseSync(databasePath);
      try {
        update.exec("DELETE FROM transcript_events");
        update
          .prepare("UPDATE session_entry_snapshots SET value_json = ?")
          .run(promptSnapshot(promptNames));
        insertTranscript(update, messages, (seq) => seq % 2 === 0);
      } finally {
        update.close();
      }
    }
    await t.test("does not treat an assistant refusal as a denied tool call", async () => {
      replaceTranscript([
        { role: "user", content: "denied-fixture" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I cannot call that tool. denied-fixture" }],
          stopReason: "stop",
        },
      ]);
      await assert.rejects(
        native.assertSessionToolPolicyDeniedEvidence({}, denial),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /the denied turn must attempt exactly the requested tool/);
          const [summary] = error.message.split("\n");
          assert.ok(summary);
          const diagnostic = readDiagnostic(summary);
          assert.deepEqual(diagnostic.observedToolNames, []);
          const assistant = asRecord(diagnostic.finalAssistantDiagnostics);
          assert.ok(assistant);
          assert.equal(assistant.mentionsUnavailable, true);
          return true;
        },
      );
    });
    const dispatchedCall: AssistantCall<{ id: string; args: { action: string; jobId?: string } }> =
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dispatched-call",
            name: "dispatch_action",
            arguments: { id: "openclaw:core:automations", args: { action: "list" } },
          },
        ],
      };
    const targetResult = {
      content: [{ type: "text", text: '{"jobs":[]}' }],
      details: { jobs: [] },
    };
    const envelope: { tool: ToolIdentity; result: typeof targetResult; status?: string } = {
      tool: { id: "openclaw:core:automations", name: "automations", source: "openclaw" },
      result: targetResult,
    };
    const dispatchedResult = {
      role: "toolResult",
      toolCallId: "dispatched-call",
      toolName: "dispatch_action",
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      details: envelope,
    };
    const dispatchedMessages = (
      call = dispatchedCall,
      result: Record<string, unknown> = dispatchedResult,
    ) => [
      { role: "user", content: "dispatched-fixture" },
      call,
      result,
      {
        role: "assistant",
        content: [{ type: "text", text: "dispatched-fixture" }],
        stopReason: "stop",
      },
    ];
    const dispatchedEvidence = {
      sessionKey,
      turnMarker: "dispatched-fixture",
      toolName: "automations",
      expectedArguments: { action: "list" },
      resultPattern: "jobs",
    };
    await t.test(
      "correlates the real dispatcher and target without a direct target schema",
      async () => {
        for (const id of [
          "openclaw:core:automations",
          "automations",
          " openclaw:core:automations ",
          "\tautomations\n",
        ]) {
          const call = structuredClone(dispatchedCall);
          call.content[0].arguments.id = id;
          replaceTranscript(dispatchedMessages(call));
          await assert.rejects(
            native.assertNoSessionToolCallEvidence({}, dispatchedEvidence),
            /still invoked automations/,
          );
          const proof = await native.assertSessionToolCallEvidence({}, dispatchedEvidence);
          assert.equal(proof.toolName, "dispatch_action");
          assert.equal(proof.targetName, "automations");
          assert.equal(proof.targetId, id.trim());
          assert.equal(proof.toolCallId, "dispatched-call");
        }
      },
    );
    const dispatcherCases: Mutation<typeof dispatchedCall, typeof dispatchedResult>[] = [
      [
        "wrong call target",
        (call) => {
          call.content[0].arguments.id = "openclaw:core:nodes";
        },
      ],
      [
        "wrong target arguments",
        (call) => {
          call.content[0].arguments.args.action = "run";
        },
      ],
      [
        "wrong result identity",
        (_call, result) => {
          result.toolCallId = "different-call";
        },
      ],
      [
        "wrong envelope target",
        (_call, result) => {
          result.details.tool.name = "nodes";
        },
      ],
      [
        "target failure behind an ordinary outer result",
        (_call, result) => {
          result.details.status = "failed";
        },
      ],
    ];
    for (const [name, change] of dispatcherCases) {
      await t.test(`rejects dispatched ${name}`, async () => {
        const call = structuredClone(dispatchedCall);
        const result = structuredClone(dispatchedResult);
        change(call, result);
        replaceTranscript(dispatchedMessages(call, result));
        await assert.rejects(
          native.assertSessionToolCallEvidence({}, dispatchedEvidence),
          /matching successful result/,
        );
      });
    }
    await t.test(
      "correlates a thrown dispatcher refusal to its exact target arguments",
      async () => {
        const call = structuredClone(dispatchedCall);
        call.content[0].arguments.args = { action: "run", jobId: "fixture-job" };
        const result = {
          ...deniedResult,
          toolCallId: "dispatched-call",
          toolName: "dispatch_action",
        };
        const options = {
          ...denial,
          turnMarker: "dispatched-fixture",
          expectedArguments: { action: "run", jobId: "fixture-job" },
        };
        for (const details of [
          undefined,
          { status: "error", tool: "dispatch_action", error: "Automation not found: fixture-job" },
        ]) {
          replaceTranscript(dispatchedMessages(call, { ...result, details }));
          assert.equal(
            (await native.assertSessionToolPolicyDeniedEvidence({}, options)).targetId,
            "openclaw:core:automations",
          );
        }
        await assert.rejects(
          native.assertSessionToolPolicyDeniedEvidence(
            {},
            {
              ...options,
              expectedArguments: { action: "run", jobId: "wrong-target" },
            },
          ),
          /exact requested action and target/,
        );
        const details = {
          tool: { ...envelope.tool, name: "nodes" },
          result: { content: result.content },
        };
        replaceTranscript(dispatchedMessages(call, { ...result, details }));
        await assert.rejects(
          native.assertSessionToolPolicyDeniedEvidence({}, options),
          /the refusal must belong to the attempted target/,
        );
      },
    );

    const expectedCatalog = { present: ["read"], absent: ["agents_list", "gateway"] };
    const searchCall: AssistantCall<{ queries: [SearchQuery, SearchQuery, SearchQuery] }> = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "search-call",
          name: "tool_search",
          arguments: {
            queries: [
              { query: "read", limit: 1 },
              { query: "agents_list", limit: 1 },
              { query: "gateway", limit: 1 },
            ],
          },
        },
      ],
    };
    const readCandidate = { id: "openclaw:core:read", name: "read", source: "openclaw" };
    const searchPayload: {
      results: [SearchGroup, SearchGroup, SearchGroup?];
      truncated?: boolean;
    } = {
      results: [
        { query: "read", candidates: [readCandidate] },
        // Exact-name search may return a fuzzy alternative when the exact tool is absent.
        { query: "agents_list", candidates: [readCandidate] },
        { query: "gateway", candidates: [] },
      ],
    };
    const searchResult = {
      role: "toolResult",
      toolCallId: "search-call",
      toolName: "tool_search",
      isError: false,
      content: [{ type: "text", text: JSON.stringify(searchPayload) }],
      details: searchPayload,
    };
    const searchEvidence = {
      sessionKey,
      turnMarker: "search-fixture",
      toolName: "tool_search",
      expectedCatalog,
    };
    function replaceSearch(call = searchCall, result = searchResult) {
      replaceTranscript([
        { role: "user", content: "search-fixture" },
        call,
        result,
        {
          role: "assistant",
          content: [{ type: "text", text: "search-fixture" }],
          stopReason: "stop",
        },
      ]);
    }
    await t.test("proves complete exact discovery with an allowed positive control", async () => {
      replaceSearch();
      const proof = await native.assertSessionToolCallEvidence({}, searchEvidence);
      assert.equal(proof.toolCallId, "search-call");
      assert.deepEqual(proof.catalog, [
        { query: "read", names: ["read"], truncated: false },
        { query: "agents_list", names: ["read"], truncated: false },
        { query: "gateway", names: [], truncated: false },
      ]);
    });
    const catalogCases: Mutation<typeof searchCall, typeof searchResult>[] = [
      [
        "nonexact request",
        (call) => {
          call.content[0].arguments.queries[1].query = "agents";
        },
      ],
      [
        "different request limit",
        (call) => {
          call.content[0].arguments.queries[1].limit = 2;
        },
      ],
      [
        "wrong result identity",
        (_call, result) => {
          result.toolCallId = "other-search";
        },
      ],
      [
        "missing result group",
        (_call, result) => {
          result.details.results.pop();
        },
      ],
      [
        "duplicate result group",
        (_call, result) => {
          result.details.results[2] = result.details.results[0];
        },
      ],
      [
        "truncated response",
        (_call, result) => {
          result.details.truncated = true;
        },
      ],
      [
        "truncated group",
        (_call, result) => {
          result.details.results[1].truncated = true;
        },
      ],
      [
        "missing allowed control",
        (_call, result) => {
          result.details.results[0].candidates = [];
        },
      ],
      [
        "forbidden exact match",
        (_call, result) => {
          result.details.results[1].candidates = [
            { id: "openclaw:core:agents_list", name: "agents_list", source: "openclaw" },
          ];
        },
      ],
    ];
    for (const [name, change] of catalogCases) {
      await t.test(`rejects catalog proof with ${name}`, async () => {
        const call = structuredClone(searchCall);
        const result = structuredClone(searchResult);
        change(call, result);
        replaceSearch(call, result);
        await assert.rejects(
          native.assertSessionToolCallEvidence({}, searchEvidence),
          /matching successful result/,
        );
      });
    }
    await t.test("binds Code Mode evidence to the exact real-tool program", async (t) => {
      const codeModeCall: NonNullable<SessionEvidenceOptions["codeModeCall"]> = {
        title: "Gateway policy qualification",
        code: 'return await exec({"command":"printf TOOL-SUCCESS","awaitResults":true});',
        awaitResults: true,
      };
      const completed = {
        status: "completed",
        value: { status: "completed", exitCode: 0, aggregated: "TOOL-SUCCESS" },
      };
      const replaceCodeMode = (details: CodeModeDetails, args = codeModeCall) =>
        replaceTranscript(
          [
            { role: "user", content: "code-mode-fixture" },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "code-mode-call", name: "exec", arguments: args }],
            },
            {
              role: "toolResult",
              toolCallId: "code-mode-call",
              toolName: "exec",
              isError: false,
              content: [{ type: "text", text: JSON.stringify(details) }],
              details,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "code-mode-fixture" }],
              stopReason: "stop",
            },
          ],
          ["exec"],
        );
      const options = {
        sessionKey,
        turnMarker: "code-mode-fixture",
        toolName: "exec",
        codeModeCall,
        resultPattern: "TOOL-SUCCESS",
        expectedExitCode: 0,
      };
      replaceCodeMode(completed);
      const proof = await native.assertSessionToolCallEvidence({}, options);
      assert.equal(proof.codeModeProgramVerified, true);
      assert.equal(proof.exitCode, 0);
      await t.test("rejects guest-manufactured success without the exact program", async () => {
        replaceCodeMode(completed, {
          ...codeModeCall,
          code: 'return {status:"completed",exitCode:0,aggregated:"TOOL-SUCCESS"};',
        });
        await assert.rejects(
          native.assertSessionToolCallEvidence({}, options),
          /matching successful result/,
        );
      });
      for (const value of [
        { status: "running", exitCode: 0, aggregated: "TOOL-SUCCESS" },
        { status: "completed", exitCode: 1, aggregated: "TOOL-SUCCESS" },
      ]) {
        replaceCodeMode({ ...completed, value });
        await assert.rejects(
          native.assertSessionToolCallEvidence({}, options),
          /must exit with code 0/,
        );
      }
      await t.test("correlates returned Gateway errors and thrown bridge errors", async () => {
        const refusal = "cron job not found: fixture-job";
        const call = {
          ...codeModeCall,
          code: 'return await automations({"action":"update","jobId":"fixture-job","job":{"payload":{"timeoutSeconds":1}}});',
        };
        const denied = {
          sessionKey,
          turnMarker: options.turnMarker,
          toolName: "exec",
          codeModeCall: call,
          resultPattern: refusal,
        };
        for (const details of [
          { status: "completed", value: { status: "error", error: refusal } },
          { status: "failed", bridgeDispatchStarted: true, error: refusal },
        ]) {
          replaceCodeMode(details, call);
          assert.equal(
            (await native.assertSessionToolPolicyDeniedEvidence({}, denied))
              .codeModeProgramVerified,
            true,
          );
        }
        replaceCodeMode({ status: "failed", bridgeDispatchStarted: false, error: refusal }, call);
        await assert.rejects(
          native.assertSessionToolPolicyDeniedEvidence({}, denied),
          /refusal must belong to the attempted target/,
        );
        replaceCodeMode(
          { status: "completed", value: { status: "error", error: "unrelated fixture error" } },
          call,
        );
        await assert.rejects(
          native.assertSessionToolPolicyDeniedEvidence({}, denied),
          /must return the policy refusal/,
        );
      });
      await t.test(
        "checks the actual complete catalog alongside the child's command result",
        async () => {
          const call = {
            ...codeModeCall,
            code: 'const command = await exec({"command":"printf TOOL-SUCCESS","awaitResults":true}); return {...command, catalog: catalog.all().filter(tool => ["read","gateway"].includes(tool.toolName)).map(tool => ({name: tool.toolName, source: tool.source, callableName: tool.callableName}))};',
          };
          const readHandle = { name: "read", source: "openclaw", callableName: "read" };
          const details = {
            status: "completed",
            value: { ...completed.value, catalog: [readHandle] },
          };
          const catalogOptions = {
            ...options,
            codeModeCall: call,
            expectedCatalog: { present: ["read"], absent: ["gateway"] },
          };
          replaceCodeMode(details, call);
          const proof = await native.assertSessionToolCallEvidence({}, catalogOptions);
          assert.deepEqual(proof.catalog, [readHandle]);
          assert.equal(proof.exitCode, 0);
          details.value.catalog.push({
            name: "gateway",
            source: "openclaw",
            callableName: "gateway",
          });
          replaceCodeMode(details, call);
          await assert.rejects(
            native.assertSessionToolCallEvidence({}, catalogOptions),
            /matching successful result/,
          );
        },
      );
    });
    await t.test("binds Codex tool work to its native terminal or Gateway finalizer", async () => {
      const prefix = "codex:thread-fixture:turn-fixture";
      const runId = "gateway-run";
      const mirror = (mirrorIdentity: string, terminal = false) => ({
        mirrorIdentity,
        mirrorOrigin: "codex-app-server",
        mirrorSourceFingerprint: "fixture-fingerprint",
        runId,
        ...(terminal ? { runTerminal: true } : {}),
      });
      const messages = [
        {
          role: "user",
          content: "codex-fixture",
          __openclaw: mirror(`${prefix}:prompt`),
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "codex-call",
              name: "automations",
              arguments: { action: "list" },
            },
          ],
          __openclaw: mirror(`${prefix}:tool:codex-call:call`),
        },
        {
          role: "toolResult",
          toolCallId: "codex-call",
          toolName: "automations",
          isError: false,
          content: targetResult.content,
          __openclaw: mirror(`${prefix}:tool:codex-call:result`),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "codex-fixture" }],
          stopReason: "stop",
          __openclaw: mirror(`${prefix}:assistant`, true),
        },
      ] as const;
      replaceTranscript(messages, []);
      const codex = createNativePluginAssertions({ ...assertionOptions, proofMode: "codex" });
      const proof = await codex.assertSessionToolCallEvidence(
        {},
        { ...dispatchedEvidence, turnMarker: "codex-fixture" },
      );
      assert.equal(proof.toolName, "automations");
      assert.equal(proof.codexMirrorTurnVerified, true);
      const evidence = { ...dispatchedEvidence, turnMarker: "codex-fixture" };
      const absence = { ...evidence, toolName: "agents_list" };
      const [prompt, call, result, answer] = messages;
      const write = (...rows: Record<string, unknown>[]) => replaceTranscript(rows, []);
      const finalizer = { ...answer, __openclaw: mirror(`settled-finalizer:${runId}`, true) };
      const continuation = { ...answer, __openclaw: mirror("continuation-turn:assistant", true) };
      for (const [terminal, kind] of [
        [finalizer, "settled-finalizer"],
        [continuation, "native-continuation"],
      ] as const) {
        const progress =
          kind === "native-continuation"
            ? [
                {
                  role: "assistant",
                  content: "Finishing",
                  __openclaw: mirror("continuation-turn:commentary:item"),
                },
              ]
            : [];
        write(prompt, call, result, ...progress, terminal);
        const finalized = await codex.assertSessionToolCallEvidence({}, evidence);
        assert.equal(finalized.codexGatewayRunCompletion, kind);
        assert.equal(finalized.codexMirrorTurnVerified, undefined);
        await codex.assertNoSessionToolCallEvidence({}, absence);
        await assert.rejects(
          codex.assertNoSessionToolCallEvidence({}, evidence),
          /still invoked automations/,
        );
      }
      // A completed run cannot supply missing IDs or substitute another tool's mirror pair.
      const unidentified = { ...call, content: [{ ...call.content[0], id: undefined }] };
      write(prompt, unidentified, { ...result, toolCallId: undefined }, finalizer);
      await assert.rejects(codex.assertSessionToolCallEvidence({}, evidence), /terminal/);
      await assert.rejects(codex.assertNoSessionToolCallEvidence({}, absence), /completed/);

      const other = {
        ...call,
        content: [{ ...call.content[0], id: "other", name: "other" }],
        __openclaw: mirror(`${prefix}:tool:other:call`),
      };
      const otherResult = {
        ...result,
        toolCallId: "other",
        toolName: "other",
        __openclaw: mirror(`${prefix}:tool:other:result`),
      };
      const wrongResult = { ...result, __openclaw: mirror(`${prefix}:tool:wrong:result`) };
      write(prompt, other, otherResult, call, wrongResult, continuation);
      await assert.rejects(codex.assertSessionToolCallEvidence({}, evidence), /terminal/);
      await codex.assertNoSessionToolCallEvidence({}, absence);
      write(
        prompt,
        other,
        otherResult,
        call,
        {
          ...wrongResult,
          isError: true,
          content: [{ type: "text", text: "user rejected MCP tool call" }],
        },
        continuation,
      );
      await assert.rejects(codex.assertSessionToolDeniedEvidence({}, evidence), /owned terminal/);

      for (const rows of [
        [
          prompt,
          call,
          result,
          { ...continuation, __openclaw: { ...continuation.__openclaw, runId: "other" } },
        ],
        [prompt, call, result, { ...finalizer, __openclaw: mirror(`settled-finalizer:${runId}`) }],
        [
          prompt,
          call,
          result,
          { ...finalizer, __openclaw: mirror("settled-finalizer:different-run", true) },
        ],
        [
          prompt,
          call,
          result,
          { ...finalizer, __openclaw: mirror(`${prefix}:commentary:other-item`, true) },
        ],
        [
          prompt,
          call,
          result,
          { ...answer, __openclaw: mirror(`${prefix}:commentary:item`) },
          { ...finalizer, content: [{ type: "text", text: "another answer" }] },
        ],
        [prompt, call, finalizer, result],
        [
          prompt,
          { ...call, __openclaw: { ...call.__openclaw, runId: "other" } },
          result,
          finalizer,
        ],
        [prompt, call, result, { ...prompt, __openclaw: mirror("unrelated:prompt") }, finalizer],
      ]) {
        write(...rows);
        await assert.rejects(
          codex.assertSessionToolCallEvidence({}, evidence),
          /terminal|matching successful result/,
        );
        await assert.rejects(codex.assertNoSessionToolCallEvidence({}, absence), /completed/);
      }
      messages[2].__openclaw.mirrorIdentity = "codex:other:turn:tool:codex-call:result";
      replaceTranscript(messages, []);
      await assert.rejects(
        codex.assertSessionToolCallEvidence(
          {},
          { ...dispatchedEvidence, turnMarker: "codex-fixture" },
        ),
        /share one mirrored turn/,
      );
    });
  });
}
