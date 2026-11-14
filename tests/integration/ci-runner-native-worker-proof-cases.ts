import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";
import { nativeFirstAgentProofDiagnostic } from "../../scripts/ci/reporter.mjs";
import {
  collectNativeWorkerFailure,
  nativePlacementReadRetryable,
  nativeWorkerHistoryEvidence,
  nativeWorkerProofProgram,
} from "../helpers/local-first-agent-native.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

function modelHistoryDiagnostic(
  observation: ReturnType<typeof nativeWorkerHistoryEvidence>["observation"],
): { worker: Record<string, unknown> } {
  const diagnostic = nativeFirstAgentProofDiagnostic("model-history", observation);
  assert.ok(diagnostic && "worker" in diagnostic && isRecord(diagnostic.worker));
  return diagnostic;
}

export function registerNativeWorkerProofCases(): void {
  test("native proof diagnoses real file failures without disclosing program output", async (t) => {
    const directory = await temporaryDirectory(t, "native-proof-diagnostic-");
    const toolPrefix = "FIRST_AGENT_NATIVE_TOOL ";
    const privateName = "private-native-proof-file";
    const workspaceFile = { path: join(directory, privateName) };
    await writeFile(workspaceFile.path, "private-workspace-content");
    for (const [name, createSessionFile, operation, errorCode] of [
      ["duplicate", true, "write-session-file", "EEXIST"],
      ["missing-session", false, "read-session-file", "ENOENT"],
      ["missing-workspace", true, "read-workspace-file", "ENOENT"],
      ["success", true, undefined, undefined],
      ["reuse", false, undefined, undefined],
    ] as const) {
      const sessionFile = { path: join(directory, name) };
      if (name === "duplicate") {
        await writeFile(sessionFile.path, "keep-existing-session");
      } else if (name === "reuse") {
        await writeFile(sessionFile.path, "private-session-content");
      }
      // Run the same generated program as the native model prompt against actual
      // files. Only the recorded Code Mode envelope is supplied to the decoder.
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          nativeWorkerProofProgram({
            sessionFile,
            sessionFileContent: "private-session-content",
            toolPrefix,
            createSessionFile,
            workspaceFile:
              name === "missing-workspace"
                ? { path: workspaceFile.path + "-absent" }
                : workspaceFile,
          }),
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, operation ? 1 : 0, name);
      const evidence = nativeWorkerHistoryEvidence({
        runId: "selected",
        toolPrefix,
        marker: "expected-final",
        command: undefined,
        messages: [
          {
            role: "toolResult",
            toolName: "exec",
            isError: false,
            content: JSON.stringify({
              value: { aggregated: result.stdout + result.stderr, exitCode: result.status },
            }),
            __openclaw: { runId: "selected" },
          },
        ],
      });
      const diagnostic = modelHistoryDiagnostic(evidence.observation);
      assert.equal(diagnostic.worker.historyExecNestedExitCode, result.status, name);
      assert.equal(diagnostic.worker.historyExecFailureOperation, operation, name);
      assert.equal(diagnostic.worker.historyExecFailureCode, errorCode, name);
      assert.equal(Boolean(evidence.tool), !operation, name);
      assert.equal(Boolean(evidence.final), false, name);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-|keep-existing|Error:|\bat /);
      if (operation) {
        assert.doesNotMatch(result.stdout + result.stderr, /private-|keep-existing|Error:|\bat /);
      } else {
        const proof: unknown = JSON.parse(result.stdout.slice(toolPrefix.length));
        assert.ok(isRecord(proof));
        assert.equal(
          proof.sessionFileSha256,
          createHash("sha256").update("private-session-content").digest("hex"),
        );
        assert.equal(
          proof.workspaceFileSha256,
          createHash("sha256").update("private-workspace-content").digest("hex"),
        );
      }
    }
    assert.equal(await readFile(join(directory, "duplicate"), "utf8"), "keep-existing-session");
  });

  test("native history proof keeps exact run, explicit success and marker predicates", () => {
    const prefix = "FIRST_AGENT_NATIVE_TOOL ";
    const marker = "FIRST_AGENT_NATIVE_expected";
    const history = { runId: "selected", toolPrefix: prefix, marker, command: undefined };
    const output = prefix + JSON.stringify({ hostname: "private-host", content: "private-value" });
    const tool = {
      role: "toolResult",
      toolName: "exec",
      isError: false,
      content: output,
      __openclaw: { runId: history.runId },
    };
    const final = {
      role: "assistant",
      stopReason: "stop",
      content: marker,
      __openclaw: { runId: history.runId },
    };
    for (const [name, messages, toolPresent, finalPresent, flag, counters] of [
      ["valid", [tool, final], true, true, "false"],
      [
        "wrapped",
        [{ ...tool, content: JSON.stringify({ value: { aggregated: output } }) }, final],
        true,
        true,
        "false",
      ],
      ["missing flag", [{ ...tool, isError: undefined }, final], false, true, "absent"],
      ["error", [{ ...tool, isError: true }, final], false, true, "true"],
      ["invalid flag", [{ ...tool, isError: 0 }, final], false, true, "other"],
      [
        "source echo",
        [{ ...tool, content: "command: " + output }, final],
        false,
        true,
        "false",
        [
          ["historyToolPrefixContainsCount", 1],
          ["historyToolPrefixCount", 0],
        ],
      ],
      ["wrong run", [{ ...tool, __openclaw: { runId: "other" } }, final], false, true, "none"],
      ["foreign final", [tool, { ...final, __openclaw: { runId: "other" } }], true, false, "false"],
      [
        "wrong marker",
        [tool, { ...final, content: "Done: " + marker }],
        true,
        false,
        "false",
        [
          ["historyFinalMarkerContainsCount", 1],
          ["historyFinalMarkerCount", 0],
        ],
      ],
      [
        "unsupported content",
        [{ ...tool, content: { output } }, final],
        false,
        true,
        "false",
        [
          ["historyOtherContentCount", 1],
          ["historyExecNonemptyTextCount", 0],
        ],
      ],
      [
        "unrecognized envelope",
        [{ ...tool, content: JSON.stringify({ output }) }, final],
        false,
        true,
        "false",
        [
          ["historyExecOtherJsonCount", 1],
          ["historyExecAggregatedCount", 0],
        ],
      ],
      [
        "tool continuation",
        [tool, { ...final, content: [{ type: "text", text: marker }, { type: "toolCall" }] }],
        true,
        false,
        "false",
      ],
    ] as const) {
      const evidence = nativeWorkerHistoryEvidence({ ...history, messages });
      assert.equal(Boolean(evidence.tool), toolPresent, name);
      assert.equal(Boolean(evidence.final), finalPresent, name);
      assert.equal(evidence.observation.historyExecErrorFlag, flag, name);
      for (const [counter, expected] of counters ?? []) {
        assert.equal(evidence.observation[counter], expected, `${name}: ${counter}`);
      }
      assert.doesNotMatch(
        JSON.stringify(evidence.observation),
        /private-host|private-value|FIRST_AGENT_NATIVE/,
      );
    }
    // Code Mode can succeed without producing the requested shell proof. Source
    // mentions and nested exit codes remain observations, never proof predicates.
    for (const [exitCode, aggregated] of [
      ...[0, 2, undefined, null, "0", 0.5].map((code) => [code, "private-output"] as const),
      [0, undefined],
      [2, null],
      [0, ""],
    ] as const) {
      const call = {
        ...final,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            name: "exec",
            arguments: { code: `console.log(${JSON.stringify(prefix)}); // private-code` },
          },
        ],
      };
      const result = {
        ...tool,
        content: JSON.stringify({ value: { aggregated, exitCode } }),
      };
      const evidence = nativeWorkerHistoryEvidence({
        messages: [
          call,
          result,
          { ...final, content: "Done" },
          { ...call, __openclaw: { runId: "other" } },
          { ...result, __openclaw: { runId: "other" } },
        ],
        ...history,
      });
      assert.equal(evidence.observation.historyExecCodeStringCount, 1);
      assert.equal(evidence.observation.historyExecCodeToolPrefixContainsCount, 1);
      assert.equal(evidence.observation.historyExecCommandStringCount, 0);
      assert.equal(
        evidence.observation.historyExecNestedExitZeroCount,
        exitCode === 0 && typeof aggregated === "string" ? 1 : 0,
      );
      assert.equal(
        evidence.observation.historyExecNestedExitNonzeroCount,
        exitCode === 2 && typeof aggregated === "string" ? 1 : 0,
      );
      assert.equal(evidence.observation.historyToolProofPresent, false);
      assert.equal(evidence.observation.historyFinalProofPresent, false);
      assert.doesNotMatch(JSON.stringify(evidence.observation), /private-|FIRST_AGENT_NATIVE/);
    }
    // Only a single recognized failing result may contribute bounded categories.
    // Unmarked pre-Node failures and hostile/ambiguous markers remain unclassified.
    const failureLine =
      'FIRST_AGENT_NATIVE_FAILURE {"operation":"read-session-file","code":"ENOENT"}';
    for (const [exitCode, aggregated] of [
      [1, "private-shell-error"],
      [1, 'FIRST_AGENT_NATIVE_FAILURE {"operation":"private-path","code":"ENOENT"}'],
      [1, 'FIRST_AGENT_NATIVE_FAILURE {"operation":"read-session-file","code":"private-error"}'],
      [1, "FIRST_AGENT_NATIVE_FAILURE {invalid"],
      [1, "command: " + failureLine],
      [1, failureLine + "\n" + failureLine],
      [1, failureLine + "\nFIRST_AGENT_NATIVE_FAILURE {invalid"],
      [
        1,
        failureLine + '\nFIRST_AGENT_NATIVE_FAILURE {"operation":"private-path","code":"ENOENT"}',
      ],
      [1, failureLine + "\nFIRST_AGENT_NATIVE_FAILURE " + "x".repeat(256)],
      [0, failureLine],
      [256, failureLine],
      [-1, failureLine],
    ] as const) {
      const evidence = nativeWorkerHistoryEvidence({
        messages: [{ ...tool, content: JSON.stringify({ value: { exitCode, aggregated } }) }],
        ...history,
      });
      const diagnostic = modelHistoryDiagnostic(evidence.observation);
      assert.equal(diagnostic.worker.historyExecFailureOperation, undefined);
      assert.equal(diagnostic.worker.historyExecFailureCode, undefined);
      assert.equal(
        diagnostic.worker.historyExecNestedExitCode,
        exitCode >= 0 && exitCode <= 255 ? exitCode : undefined,
      );
      assert.equal(Boolean(evidence.tool), false);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-|FIRST_AGENT_NATIVE/);
    }
    // Peer-supplied part names and command arguments must not become diagnostic values.
    const command = "private-command";
    const observed = nativeWorkerHistoryEvidence({
      ...history,
      command,
      messages: [
        {
          ...final,
          content: [
            { type: "toolCall", name: "exec", arguments: { command } },
            { type: "toolCall", name: "exec", arguments: { command: "other-private-command" } },
            { type: "text", text: "private-text" },
            { type: "private-part-type", value: "private-value" },
          ],
        },
        {
          ...tool,
          content: [{ type: "text", text: JSON.stringify({ value: { aggregated: output } }) }],
        },
        // An unrelated run cannot affect command or shape evidence.
        {
          ...final,
          content: [{ type: "toolCall", name: "exec", arguments: { command } }],
          __openclaw: { runId: "other" },
        },
      ],
    });
    assert.equal(observed.observation.historyArrayContentCount, 2);
    assert.equal(observed.observation.historyTextPartCount, 2);
    assert.equal(observed.observation.historyToolCallPartCount, 2);
    assert.equal(observed.observation.historyOtherPartCount, 1);
    assert.equal(observed.observation.historyExecCallCount, 2);
    assert.equal(observed.observation.historyExecCommandStringCount, 2);
    assert.equal(observed.observation.historyExecExactCommandCount, 1);
    assert.equal(observed.observation.historyExecNonemptyTextCount, 1);
    assert.equal(observed.observation.historyExecAggregatedCount, 1);
    assert.equal(observed.observation.historyAssistantNonemptyTextCount, 1);
    assert.doesNotMatch(JSON.stringify(observed.observation), /private-|FIRST_AGENT_NATIVE/);
  });

  test("native placement retries only the correlated pinned read-generation signal", async () => {
    const message = "Error: Session changed while preparing its description; retry the request";
    const error = Object.assign(new Error(message), { code: "UNAVAILABLE" });
    assert.equal(nativePlacementReadRetryable(error, true), true);
    assert.equal(
      nativePlacementReadRetryable(error, false),
      false,
      "local/transport errors cannot opt into a retry by text",
    );
    for (const rejected of [
      Object.assign(new Error(message), { code: "FORBIDDEN" }),
      Object.assign(
        new Error("Session repository binding changed while preparing its description"),
        {
          code: "UNAVAILABLE",
        },
      ),
      Object.assign(new Error("gateway request timed out"), { code: "UNAVAILABLE" }),
      Object.assign(new Error("private peer text"), { code: "UNAVAILABLE" }),
      Object.assign(new Error(message + "; private suffix"), { code: "UNAVAILABLE" }),
    ]) {
      assert.equal(nativePlacementReadRetryable(rejected, true), false);
    }
    const requests: string[] = [];
    const observed = await collectNativeWorkerFailure({
      error,
      elapsedMs: 1,
      session: undefined,
      lastPlacement: undefined,
      expectedNodeId: undefined,
      runId: undefined,
      outcome: undefined,
      request: async (method: string) => {
        requests.push(method);
        return { nodes: [] };
      },
    });
    assert.deepEqual(requests, ["node.list"]);
    assert.ok("proofError" in observed);
    assert.equal(
      observed.proofError,
      "session-read-changed",
      "pre-turn failures must retain safe classification",
    );
    assert.doesNotMatch(JSON.stringify(observed), /Session changed|private peer/);
  });
}
