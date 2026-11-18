type ProofProgramInputs = {
  sessionFile: { path: string };
  sessionFileContent: string | undefined;
  workspaceFile?: { path: string } | undefined;
  toolPrefix: string;
  createSessionFile: boolean;
};

// This same program runs through the model's exec and in the local diagnostic proof.
export function nativeWorkerProofProgram({
  sessionFile,
  sessionFileContent,
  workspaceFile,
  toolPrefix,
  createSessionFile,
}: ProofProgramInputs): string {
  return [
    'process.stderr.write("FIRST_AGENT_NATIVE_PROGRAM_ENTRY\\n");',
    'let operation="write-session-file";try{',
    ...(createSessionFile
      ? [
          `require("node:fs").writeFileSync(${JSON.stringify(sessionFile.path)},${JSON.stringify(sessionFileContent)},{flag:"wx"});`,
        ]
      : []),
    'operation="read-session-file";',
    `const sessionFileSha256=require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(${JSON.stringify(sessionFile.path)})).digest("hex");`,
    ...(workspaceFile === undefined
      ? []
      : [
          'operation="read-workspace-file";',
          `const workspaceFileSha256=require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(${JSON.stringify(workspaceFile.path)})).digest("hex");`,
        ]),
    'operation="emit-proof";',
    `process.stdout.write(${JSON.stringify(toolPrefix)} + JSON.stringify({`,
    'hostname:require("node:os").hostname(),',
    'cwd:process.cwd(),modelCredentialPresent:Object.hasOwn(process.env,"OPENAI_API_KEY")||Object.hasOwn(process.env,"CODEX_ACCESS_TOKEN"),sessionFileSha256,',
    ...(workspaceFile === undefined ? [] : ["workspaceFileSha256,"]),
    '}) + "\\n");',
    "}catch(error){",
    'const code=["EACCES","EPERM","ENOENT","EEXIST","EISDIR","ENOTDIR","ENOSPC","EROFS","EMFILE","EIO"].includes(error?.code)?error.code:"other";',
    'process.stderr.write("FIRST_AGENT_NATIVE_FAILURE "+JSON.stringify({operation,code})+"\\n");process.exitCode=1;}',
  ].join("");
}

type HistoryEvidenceInputs = {
  messages: unknown;
  runId: string;
  toolPrefix: string;
  marker: string;
  command?: string | undefined;
};

type HistoryRecord = Record<string, unknown>;

type ExecEnvelope =
  | { kind: "plain"; output: string }
  | { kind: "other"; output: string; outer: HistoryRecord | undefined }
  | { kind: "aggregated"; output: string; outer: HistoryRecord; shell: HistoryRecord };

// The controller evaluates this function's source, so keep all runtime dependencies
// inside the function. Only the fixed observation may enter failure diagnostics.
export function nativeWorkerHistoryEvidence({
  messages: history,
  runId,
  toolPrefix,
  marker,
  command,
}: HistoryEvidenceInputs) {
  const isRecord = (value: unknown): value is HistoryRecord =>
    value !== null && typeof value === "object";
  const asRecord = (value: unknown): HistoryRecord | undefined =>
    isRecord(value) ? value : undefined;
  const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
  const oneOf = <const T extends string>(value: unknown, allowed: readonly T[]): value is T =>
    allowed.some((candidate) => candidate === value);

  if (!isArray(history)) {
    throw new Error("Invalid native history");
  }
  const messages = history.filter((message): message is HistoryRecord => {
    if (message == null) {
      throw new TypeError("Invalid native history message");
    }
    const record = asRecord(message);
    return record !== undefined && asRecord(record.__openclaw)?.runId === runId;
  });
  const text = (content: unknown): string => {
    if (typeof content === "string") {
      return content;
    }
    return (isArray(content) ? content : [])
      .map((part) => asRecord(part))
      .flatMap((part) =>
        part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n");
  };
  const decodeExec = (output: string): ExecEnvelope => {
    try {
      const parsed: unknown = JSON.parse(output);
      const outer = asRecord(parsed);
      const shell = asRecord(outer?.value);
      if (outer && shell && typeof shell.aggregated === "string") {
        return { kind: "aggregated", output: shell.aggregated, outer, shell };
      }
      return { kind: "other", output, outer };
    } catch {
      return { kind: "plain", output };
    }
  };
  const execCompleted = (envelope: ExecEnvelope): boolean => {
    if (envelope.kind !== "aggregated") {
      return true;
    }
    // Legacy wrappers can carry only output. Once a result declares a process
    // status, accept its output only after an explicit successful exit.
    const { outer, shell } = envelope;
    const hasStatus = Object.hasOwn(outer, "status") || Object.hasOwn(shell, "status");
    return (
      (!hasStatus || (outer.status === "completed" && shell.status === "completed")) &&
      (!(hasStatus || Object.hasOwn(shell, "exitCode")) || shell.exitCode === 0)
    );
  };
  const errorFlag = (value: unknown) => {
    if (value === false) {
      return "false";
    }
    if (value === true) {
      return "true";
    }
    return value === undefined ? "absent" : "other";
  };
  const exec = messages
    .filter((message) => message.role === "toolResult" && message.toolName === "exec")
    .map((message) => {
      const envelope = decodeExec(text(message.content));
      return {
        message,
        envelope,
        flag: errorFlag(message.isError),
        hasProofLine: envelope.output.split(/\r?\n/).some((line) => line.startsWith(toolPrefix)),
      };
    });
  // Failed commands can echo the marker in their source. Proof needs a
  // standalone output line and a successful result from this run.
  const toolResult = exec.find(
    (result) => result.flag === "false" && result.hasProofLine && execCompleted(result.envelope),
  );
  const assistants = messages
    .filter((message) => message.role === "assistant")
    .map((message) => {
      const content = message.content;
      const toolCalls = isArray(content)
        ? content.filter((part): part is HistoryRecord => asRecord(part)?.type === "toolCall")
        : [];
      return {
        message,
        text: text(content),
        terminal:
          message.stopReason !== "toolUse" && message.stopReason !== "error" && !toolCalls.length,
        toolCalls,
      };
    });
  const final = assistants.find(
    (assistant) => assistant.text.trim() === marker && assistant.terminal,
  );
  const parts = messages.flatMap((message) =>
    isArray(message.content) ? message.content.map(asRecord) : [],
  );
  const textPartCount = parts.filter(
    (part) => part?.type === "text" && typeof part.text === "string",
  ).length;
  const toolCallPartCount = parts.filter((part) => part?.type === "toolCall").length;
  const calls = assistants.flatMap(({ toolCalls }) =>
    toolCalls.filter((part) => part.name === "exec").map((part) => asRecord(part.arguments)),
  );
  const flags = [...new Set(exec.map((result) => result.flag))];
  const flag = flags.length > 1 ? "mixed" : (flags[0] ?? "none");

  const observeExecStage = (envelope: ExecEnvelope | undefined) => {
    if (!envelope || envelope.kind === "plain") {
      return {};
    }
    const { outer } = envelope;
    const status = outer?.status;
    if (!oneOf(status, ["completed", "failed", "waiting"])) {
      return {};
    }
    const stage = { historyExecOuterStatus: status };
    if (status === "failed" && outer) {
      const { code, failurePhase, bridgeDispatchStarted } = outer;
      return {
        ...stage,
        ...(oneOf(code, [
          "aborted",
          "invalid_input",
          "runtime_unavailable",
          "timeout",
          "output_limit_exceeded",
          "snapshot_limit_exceeded",
          "internal_error",
        ]) && { historyExecOuterCode: code }),
        ...(oneOf(failurePhase, ["input", "guest", "bridge", "host"]) && {
          historyExecOuterFailurePhase: failurePhase,
        }),
        ...(typeof bridgeDispatchStarted === "boolean" && {
          historyExecBridgeDispatchStarted: bridgeDispatchStarted,
        }),
      };
    }
    if (status === "completed" && envelope.kind === "aggregated") {
      const { status: nestedStatus, failureKind } = envelope.shell;
      return {
        ...stage,
        historyExecProofProgramEntryPresent: envelope.output
          .split(/\r?\n/)
          .includes("FIRST_AGENT_NATIVE_PROGRAM_ENTRY"),
        ...(oneOf(nestedStatus, ["completed", "failed"]) && {
          historyExecNestedStatus: nestedStatus,
        }),
        ...(nestedStatus === "failed" &&
          oneOf(failureKind, [
            "shell-command-not-found",
            "shell-not-executable",
            "overall-timeout",
            "no-output-timeout",
            "memory-limit",
            "signal",
            "aborted",
            "runtime-error",
          ]) && { historyExecNestedFailureKind: failureKind }),
      };
    }
    return stage;
  };
  const exits = exec.flatMap(({ envelope }) => {
    if (envelope.kind === "aggregated") {
      const { exitCode } = envelope.shell;
      if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) {
        return [{ exitCode, output: envelope.output }];
      }
    }
    return [];
  });
  const onlyExit = exits.length === 1 ? exits[0] : undefined;
  const observeExecFailure = () => {
    if (!onlyExit || onlyExit.exitCode <= 0 || onlyExit.exitCode > 255) {
      return {};
    }
    const prefix = "FIRST_AGENT_NATIVE_FAILURE ";
    const lines = onlyExit.output.split(/\r?\n/).filter((line) => line.startsWith(prefix));
    const line = lines.length === 1 ? lines[0] : undefined;
    if (!line || line.length > 256) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(line.slice(prefix.length));
      const failure = asRecord(parsed);
      const operation = failure?.operation;
      const code = failure?.code;
      if (
        oneOf(operation, [
          "write-session-file",
          "read-session-file",
          "read-workspace-file",
          "emit-proof",
        ]) &&
        oneOf(code, [
          "EACCES",
          "EPERM",
          "ENOENT",
          "EEXIST",
          "EISDIR",
          "ENOTDIR",
          "ENOSPC",
          "EROFS",
          "EMFILE",
          "EIO",
          "other",
        ])
      ) {
        return { historyExecFailureOperation: operation, historyExecFailureCode: code };
      }
    } catch {
      // A malformed peer marker cannot supply diagnostic fields.
    }
    return {};
  };

  return {
    tool: toolResult?.message,
    final: final?.message,
    messages,
    output: toolResult?.envelope.output,
    observation: {
      ...observeExecStage(exec.length === 1 ? exec[0]?.envelope : undefined),
      historyMessageCount: history.length,
      historyRunMessageCount: messages.length,
      historyExecCount: exec.length,
      historyExplicitSuccessCount: exec.filter((result) => result.flag === "false").length,
      historyExecErrorFlag: flag,
      historyStringContentCount: messages.filter((message) => typeof message.content === "string")
        .length,
      historyArrayContentCount: messages.filter((message) => isArray(message.content)).length,
      historyOtherContentCount: messages.filter(
        (message) => typeof message.content !== "string" && !isArray(message.content),
      ).length,
      historyTextPartCount: textPartCount,
      historyToolCallPartCount: toolCallPartCount,
      historyOtherPartCount: parts.length - textPartCount - toolCallPartCount,
      historyExecCallCount: calls.length,
      historyExecCodeStringCount: calls.filter((args) => typeof args?.code === "string").length,
      // A source mention is not evidence that the nested command executed.
      historyExecCodeToolPrefixContainsCount: calls.filter(
        (args) => typeof args?.code === "string" && args.code.includes(toolPrefix),
      ).length,
      ...(onlyExit && onlyExit.exitCode >= 0 && onlyExit.exitCode <= 255
        ? { historyExecNestedExitCode: onlyExit.exitCode }
        : {}),
      ...observeExecFailure(),
      historyExecNestedExitZeroCount: exits.filter(({ exitCode }) => exitCode === 0).length,
      historyExecNestedExitNonzeroCount: exits.filter(({ exitCode }) => exitCode !== 0).length,
      historyExecCommandStringCount: calls.filter((args) => typeof args?.command === "string")
        .length,
      historyExecExactCommandCount: calls.filter(
        (args) => typeof command === "string" && args?.command === command,
      ).length,
      historyExecNonemptyTextCount: exec.filter(({ envelope }) => envelope.output.trim().length > 0)
        .length,
      historyExecAggregatedCount: exec.filter(({ envelope }) => envelope.kind === "aggregated")
        .length,
      historyExecOtherJsonCount: exec.filter(({ envelope }) => envelope.kind === "other").length,
      historyToolPrefixContainsCount: exec.filter(({ envelope }) =>
        envelope.output.includes(toolPrefix),
      ).length,
      historyAssistantNonemptyTextCount: assistants.filter(
        (assistant) => assistant.text.trim().length > 0,
      ).length,
      historyFinalMarkerContainsCount: assistants.filter((assistant) =>
        assistant.text.includes(marker),
      ).length,
      historyToolPrefixCount: exec.filter((result) => result.hasProofLine).length,
      historyFinalMarkerCount: assistants.filter((assistant) => assistant.text.trim() === marker)
        .length,
      historyTerminalAssistantCount: assistants.filter((assistant) => assistant.terminal).length,
      historyToolProofPresent: Boolean(toolResult),
      historyFinalProofPresent: Boolean(final),
    },
  };
}
