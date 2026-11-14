import type { TestEvent } from "node:test/reporters";
import { projectFailureDiagnostic, isRecord } from "./reporter-diagnostics.ts";
import {
  boundedProgressLines,
  openShellProgress,
  openShellProgressPrefix,
} from "./openshell-progress.mjs";
import { failureInputLimit } from "./failure-redaction.ts";
import { recordsCoverage } from "./full-integration-coverage.ts";
import { parseMeasurementDiagnostic } from "./reporter-measurements.ts";

export { openShellTurnoverQualification } from "./reporter-measurements.ts";

type TestResult = Extract<TestEvent, { type: "test:pass" }>["data"];
type TestCounts = Extract<TestEvent, { type: "test:summary" }>["data"]["counts"];
type ReportedCounts = Partial<TestCounts & { failed: number }>;

// Node's stream and direct callers share this subset. Direct callers can
// supply partial events, and Node 24 does not always supply the test IDs.
type ReporterEventData = Partial<
  Pick<
    TestResult,
    "file" | "line" | "column" | "name" | "nesting" | "skip" | "todo" | "testId" | "parentId"
  >
> & {
  details?: { duration_ms?: number; type?: string; error?: unknown };
  counts?: ReportedCounts;
  message?: string;
  type?: string;
};

type ReporterEvent = TestEvent | { type: string; data?: ReporterEventData | undefined };
type SerializedFailure = {
  cause?: unknown;
  code?: unknown;
  exitCode?: unknown;
  failureType?: unknown;
  message?: unknown;
  name?: unknown;
  signal?: unknown;
  stack?: unknown;
};

function failureFields(value: unknown): SerializedFailure | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const boxed: object = Object(value);
  return boxed;
}

type OutputStream = "stdout" | "stderr";
type OutputTail = { lines: string[]; omitted: number };
type WorkerField = string | number | boolean;

const postTestAsyncActivityPrefix =
  "Error: A resource generated asynchronous activity after the test ended.";

// The proof runs in a separate controller process. Both its test and the CI
// reporter use this closed vocabulary; neither publishes arbitrary stage text.
export function nativeFirstAgentProofDiagnostic(failureStage: unknown, worker: unknown) {
  const stages = [
    "startup",
    "connect",
    "create",
    "create-session-id-missing",
    "required-placement",
    "required-placement-describe-rejected",
    "required-placement-terminal-failed",
    "required-placement-terminal-reclaimed",
    "required-placement-terminal-local",
    "session-identity",
    "send",
    "model-and-exec",
    "model-outcome",
    "model-history",
    "exec-proof",
    "current-placement",
  ];
  if (typeof failureStage !== "string" || !stages.includes(failureStage)) {
    return undefined;
  }
  const diagnostic = { kind: "native-first-agent-proof" as const, failureStage };
  if (!isRecord(worker)) {
    return diagnostic;
  }
  const errors = [
    "tunnel-timeout",
    "workspace-command-timeout",
    "workspace-command-failed",
    "node-transport-unavailable",
    "node-supervisor-disconnected",
    "workspace-not-synced",
    "workspace-device-mismatch",
    "workspace-validation-failed",
    "workspace-session-mismatch",
    "owner-credential-stale",
    "owner-epoch-stale",
    "owner-binding-changed",
    "tunnel-stopped",
    "worker-bootstrap-failed",
    "bundle-install-failed",
    "provider-preparation-failed",
    "provider-operation-failed",
    "provider-profile-rejected",
    "node-installer-disconnected",
    "node-install-connection-stale",
    "bundle-receipt-mismatch",
    "bundle-prefetch-unsupported",
    "worker-deploy-artifact-missing",
    "worker-deploy-artifact-unsafe",
    "gateway-build-missing",
    "gateway-cli-missing",
    "bootstrap-artifact-too-large",
    "bootstrap-transfer-too-large",
    "bundle-http-401",
    "bundle-http-403",
    "bundle-http-404",
    "bundle-http-client-error",
    "bundle-http-server-error",
    "bundle-http-unexpected-status",
    "bundle-storage-access-denied",
    "bundle-operation-denied",
    "bundle-storage-readonly",
    "bundle-storage-full",
    "bundle-file-missing",
    "bundle-prewarm-failed",
    "bundle-request-invalid",
    "bundle-range-invalid",
    "bundle-transfer-length-invalid",
    "bundle-download-no-progress",
    "bundle-archive-length-invalid",
    "bundle-archive-too-large",
    "bundle-response-too-large",
    "bundle-archive-integrity-failed",
    "bundle-published-invalid",
    "bundle-tls-mismatch",
    "bundle-https-required",
    "bundle-transfer-unavailable",
    "bundle-manifest-hash-mismatch",
    "bundle-extracted-hash-mismatch",
    "bundle-entry-invalid",
    "bundle-extraction-limit",
    "bundle-symlink-refused",
    "bundle-file-changed",
  ];
  const turnErrors = [
    "session-read-changed",
    "session-binding-changed",
    "model-authentication",
    "model-rate-or-quota",
    "model-unavailable",
    "tool-policy",
    "filesystem-permission",
    "file-or-command-missing",
    "tls-validation",
    "network-connection",
    "worker-authority",
    "worker-transport",
    "http-unauthorized",
    "http-forbidden",
    "http-rate-limit",
  ];
  const vocabularies = {
    proofRpcCode: ["UNAVAILABLE", "INVALID_REQUEST", "NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"],
    placementReadFailure: ["request-start-timeout", "session-model-catalog-unavailable"],
    historyExecErrorFlag: ["none", "false", "true", "absent", "other", "mixed"],
    historyExecOuterStatus: ["completed", "failed", "waiting"],
    historyExecOuterCode: [
      "aborted",
      "invalid_input",
      "runtime_unavailable",
      "timeout",
      "output_limit_exceeded",
      "snapshot_limit_exceeded",
      "internal_error",
    ],
    historyExecOuterFailurePhase: ["input", "guest", "bridge", "host"],
    historyExecNestedStatus: ["completed", "failed"],
    historyExecNestedFailureKind: [
      "shell-command-not-found",
      "shell-not-executable",
      "overall-timeout",
      "no-output-timeout",
      "memory-limit",
      "signal",
      "aborted",
      "runtime-error",
    ],
    turnStatus: ["ok", "error", "timeout", "pending"],
    turnError: turnErrors,
    proofError: turnErrors,
    assistantError: turnErrors,
    execError: turnErrors,
    turnStopReason: ["stop", "length", "toolUse", "error", "aborted"],
    assistantStopReason: ["stop", "length", "toolUse", "error", "aborted"],
    historyLookup: ["found", "unavailable", "invalid", "absent"],
    placementLookup: ["fresh", "fallback", "absent"],
    placementState: [
      "local",
      "requested",
      "provisioning",
      "syncing",
      "starting",
      "active",
      "draining",
      "reconciling",
      "reclaimed",
      "failed",
    ],
    recoveryError: errors,
    terminalReason: errors,
    environmentError: errors,
    environmentLookup: ["absent", "found", "unavailable", "mismatch"],
    environmentState: [
      "requested",
      "provisioning",
      "bootstrapping",
      "ready",
      "attached",
      "idle",
      "draining",
      "destroying",
      "destroyed",
      "failed",
      "orphaned",
    ],
    tunnelStatus: ["stopped", "connecting", "connected", "reconnecting"],
    nodeLookup: ["found", "unavailable", "invalid"],
    expectedNodeWorkerBundle: ["installed", "missing"],
  };
  const safe: Record<string, WorkerField> = {};
  for (const [field, values] of Object.entries(vocabularies)) {
    const value = worker[field];
    if (value !== undefined) {
      safe[field] =
        typeof value === "string" && (values.includes(value) || value === "absent")
          ? value
          : "other";
    }
  }
  for (const field of [
    "proofRpcResponse",
    "historyToolProofPresent",
    "historyFinalProofPresent",
    "historySettleExpired",
    "historyExecBridgeDispatchStarted",
    "historyExecProofProgramEntryPresent",
    "workspaceReferencePresent",
    "attachedSessionMatches",
    "expectedNodeIdPresent",
    "expectedNodeConnected",
    "expectedNodePaired",
    "expectedNodeSessionHost",
    "providerStarted",
  ]) {
    if (typeof worker[field] === "boolean") {
      safe[field] = worker[field];
    }
  }
  for (const field of [
    "placementReadRetries",
    "historyMessageCount",
    "historyRunMessageCount",
    "historyExecCount",
    "historyExplicitSuccessCount",
    "historyStringContentCount",
    "historyArrayContentCount",
    "historyOtherContentCount",
    "historyTextPartCount",
    "historyToolCallPartCount",
    "historyOtherPartCount",
    "historyExecCallCount",
    "historyExecCodeStringCount",
    "historyExecCodeToolPrefixContainsCount",
    "historyExecNestedExitZeroCount",
    "historyExecNestedExitNonzeroCount",
    "historyExecCommandStringCount",
    "historyExecExactCommandCount",
    "historyExecNonemptyTextCount",
    "historyExecAggregatedCount",
    "historyExecOtherJsonCount",
    "historyToolPrefixContainsCount",
    "historyAssistantNonemptyTextCount",
    "historyFinalMarkerContainsCount",
    "historyToolPrefixCount",
    "historyFinalMarkerCount",
    "historyTerminalAssistantCount",
    "attachedSessionCount",
    "nodeCount",
    "connectedNodeCount",
    "expectedNodeMatches",
    "expectedNodeCaps",
    "expectedNodeCommands",
    "elapsedMs",
    "execResultCount",
    "execFailureCount",
  ]) {
    const limit = field === "elapsedMs" ? 3_600_000 : 4096;
    const value = worker[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit) {
      safe[field] = value;
    }
  }
  const exitCode = worker.historyExecNestedExitCode;
  if (
    typeof exitCode === "number" &&
    Number.isInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 255
  ) {
    safe.historyExecNestedExitCode = exitCode;
    if (exitCode > 0) {
      const operation = worker.historyExecFailureOperation;
      if (
        typeof operation === "string" &&
        ["write-session-file", "read-session-file", "read-workspace-file", "emit-proof"].includes(
          operation,
        )
      ) {
        const code = worker.historyExecFailureCode;
        if (
          typeof code === "string" &&
          [
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
          ].includes(code)
        ) {
          safe.historyExecFailureOperation = operation;
          safe.historyExecFailureCode = code;
        }
      }
    }
  }
  return { ...diagnostic, worker: safe };
}

// Stack lines before the first frame: the "Name: message" header.
function stackHeader(stack: string) {
  const lines = stack.split("\n");
  const end = lines.findIndex((line) => /^\s+at\s/u.test(line));
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .join("\n")
    .trim();
}

// An error's first line. A DOMException (a fetch TimeoutError or AbortError)
// crosses the test runner's process boundary as a bare stack with an empty
// message, so its header names it; a thrown value without either is printed.
function errorHeader(error: unknown, fields: SerializedFailure | undefined) {
  if (typeof error === "string") {
    return error;
  }
  if (typeof fields?.message === "string" && fields.message) {
    return fields.message;
  }
  const header = typeof fields?.stack === "string" ? stackHeader(fields.stack) : "";
  if (header || error === undefined) {
    return header;
  }
  try {
    const text = String(error);
    return text === "[object Object]" ? "" : text;
  } catch {
    return "";
  }
}

// Failure messages and the top stack frame make flakes attributable. They are
// raw here and travel only over the pipe to run-tests, which redacts and
// truncates them (failure-redaction.ts) before anything reaches an artifact
// or the job log.
function failureText(cause: unknown, fields: SerializedFailure | undefined) {
  const message = errorHeader(cause, fields);
  const stack = typeof fields?.stack === "string" ? fields.stack : "";
  // The stack starts with the message, which can quote another process's stack.
  const messageEnd =
    message && stack.includes(message) ? stack.indexOf(message) + message.length : 0;
  const frames = stack
    .slice(messageEnd)
    .split("\n")
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => line.trim());
  // A DOMException's constructor and Node's own frames do not locate a failure.
  const frame = frames.find((line) => !/^at (?:.* \()?node:internal\//u.test(line)) ?? frames[0];
  return {
    message: message ? message.slice(0, failureInputLimit) : undefined,
    frame: frame?.slice(0, failureInputLimit),
    // The whole stack goes only to the failure details in the diagnostics report.
    stack: frames.length > 0 ? frames.join("\n").slice(0, failureInputLimit) : undefined,
  };
}

// A failed file's last output lines (test stdout, stderr and diagnostics), raw
// like failure text: run-tests redacts them into the diagnostics report.
const outputTailLines = 400;

function outputTail() {
  const lines: string[] = [];
  const partial = { stdout: "", stderr: "" };
  const dropping = { stdout: false, stderr: false };
  let omitted = 0;
  // A blank before a marker is its separator, even across chunks or stderr.
  // Keep its position, but do not let it evict an ordinary line until classified.
  let pendingStdoutBlank: { index: number } | undefined;
  const settleStdoutBlank = () => {
    if (pendingStdoutBlank && pendingStdoutBlank.index < 0) {
      omitted += 1;
    }
    pendingStdoutBlank = undefined;
  };
  // Trim in batches so a chatty passing file costs amortized constant time per line.
  const trim = (limit: number) => {
    const pendingIndex = pendingStdoutBlank?.index ?? -1;
    const count = lines.length - Number(pendingIndex >= 0);
    if (count > limit) {
      const excess = count - outputTailLines;
      const removed = excess + Number(pendingIndex >= 0 && pendingIndex < excess);
      omitted += excess;
      lines.splice(0, removed);
      if (pendingStdoutBlank) {
        pendingStdoutBlank.index -= removed;
      }
    }
  };
  const push = (line: string) => {
    if (line.startsWith(`stdout: ${openShellProgressPrefix}`)) {
      if (pendingStdoutBlank && pendingStdoutBlank.index >= 0) {
        lines.splice(pendingStdoutBlank.index, 1);
      }
      pendingStdoutBlank = undefined;
      return;
    }
    if (line.startsWith("stdout: ")) {
      settleStdoutBlank();
      if (line === "stdout: ") {
        pendingStdoutBlank = { index: lines.length };
      }
    }
    lines.push(line.slice(0, failureInputLimit));
    trim(2 * outputTailLines);
  };
  return {
    add(stream: OutputStream, text: string) {
      let rest = text;
      if (dropping[stream]) {
        // The rest of a line cut at the limit could start inside a secret.
        const end = rest.indexOf("\n");
        if (end === -1) {
          return;
        }
        dropping[stream] = false;
        rest = rest.slice(end + 1);
      }
      const parts = (partial[stream] + rest).split("\n");
      partial[stream] = parts.pop() ?? "";
      if (partial[stream].length >= failureInputLimit) {
        parts.push(partial[stream]);
        partial[stream] = "";
        dropping[stream] = true;
      }
      for (const line of parts) {
        push(`${stream}: ${line}`);
      }
    },
    diagnostic(text: string) {
      push(`diagnostic: ${text}`);
    },
    finish(): OutputTail {
      for (const stream of ["stdout", "stderr"] as const) {
        if (partial[stream] !== "") {
          push(`${stream}: ${partial[stream]}`);
        }
      }
      settleStdoutBlank();
      trim(outputTailLines);
      return { lines, omitted };
    },
  };
}

const interruptedTestLimit = 20;
// About this much JSON per batch (the line strings, without the envelope).
const interruptedOutputBatchChars = 32 * 1024;

// Node exits soon after an interruption and can cut what is still queued, so the
// tail goes out in small batches, newest first: a cut loses the oldest lines and
// at most one partial JSON line, which run-tests skips.
function* interruptedOutput({ lines, omitted }: OutputTail) {
  // Measured as JSON, since escaping can grow a line several times.
  const sizes = lines.map((line) => JSON.stringify(line).length);
  let end = lines.length;
  while (end > 0) {
    let start = end - 1;
    let chars = sizes[start]!;
    while (start > 0 && chars + sizes[start - 1]! <= interruptedOutputBatchChars) {
      start -= 1;
      chars += sizes[start]!;
    }
    yield `${JSON.stringify({
      type: "test:output",
      // Every line before this batch, so run-tests can count the ones a cut lost.
      data: { lines: lines.slice(start, end), omitted: omitted + start },
    })}\n`;
    end = start;
  }
}

function location(data: ReporterEventData = {}, recordCoverage = false) {
  const rawError = data.details?.error;
  const error = failureFields(rawError);
  const cause = error?.cause ?? rawError;
  const fields = failureFields(cause);
  const { file } = data;
  const fileFailure = typeof data.file === "string" && data.name === data.file;
  const exitCode = fileFailure ? error?.exitCode : undefined;
  const signal = fileFailure ? error?.signal : undefined;
  // Only retain coordinates in the known test file, never arbitrary stack text.
  let failureLocation: { file: string; line: number; column: number } | undefined;
  if (typeof file === "string" && typeof fields?.stack === "string") {
    const marker = `${file}:`;
    const frame = fields.stack.split("\n").find((line) => line.includes(marker));
    const coordinates = frame?.slice(frame.indexOf(marker) + marker.length).match(/^(\d+):(\d+)/);
    if (coordinates) {
      failureLocation = { file, line: Number(coordinates[1]), column: Number(coordinates[2]) };
    }
  }
  return {
    file: data.file,
    line: data.line,
    column: data.column,
    name: data.name,
    nesting: data.nesting,
    skip: data.skip,
    todo: data.todo,
    type: data.type,
    testId: data.testId,
    parentId: data.parentId,
    caseAssertionFailure:
      recordCoverage &&
      !fileFailure &&
      data.details?.type === "test" &&
      error?.failureType === "testCodeFailure" &&
      fields?.code === "ERR_ASSERTION" &&
      fields?.name === "AssertionError"
        ? true
        : undefined,
    caseSubtestsFailed:
      recordCoverage &&
      !fileFailure &&
      (data.details?.type === "test" || data.details?.type === "suite") &&
      error?.failureType === "subtestsFailed"
        ? true
        : undefined,
    error:
      rawError && error
        ? {
            code: error.code === "ERR_TEST_FAILURE" ? "ERR_TEST_FAILURE" : undefined,
            name: "Error",
            failureType:
              fileFailure && error.failureType === "testCodeFailure"
                ? "testCodeFailure"
                : undefined,
            exitCode:
              typeof exitCode === "number" &&
              Number.isInteger(exitCode) &&
              exitCode >= 0 &&
              exitCode <= 255
                ? exitCode
                : undefined,
            signal:
              signal === "SIGABRT" || signal === "SIGKILL" || signal === "SIGTERM"
                ? signal
                : undefined,
            cause:
              fields?.code === "ERR_ASSERTION" && fields?.name === "AssertionError"
                ? { code: "ERR_ASSERTION", name: "AssertionError" }
                : undefined,
            location: failureLocation,
            diagnostic: projectFailureDiagnostic(cause, nativeFirstAgentProofDiagnostic),
            ...failureText(cause, fields),
          }
        : undefined,
    durationMs:
      typeof data.details?.duration_ms === "number" ? data.details.duration_ms : undefined,
    testType: data.details?.type,
  };
}

// Only for scripts/ci/run-tests.ts: failure text here is unredacted, so never
// point a step whose stdout reaches a log or artifact at this reporter directly.
export default async function* jsonLinesReporter(
  source: AsyncIterable<ReporterEvent> | Iterable<ReporterEvent>,
): AsyncGenerator<string> {
  const recordCoverage = recordsCoverage(process.env.GITHUB_WORKFLOW);
  const output = outputTail();
  const progress: Record<string, unknown>[] = [];
  const readProgress: (text: string) => void = boundedProgressLines((line: string) => {
    if (!line.startsWith(openShellProgressPrefix)) {
      return;
    }
    try {
      const raw: unknown = JSON.parse(line.slice(openShellProgressPrefix.length));
      const value: unknown = openShellProgress(raw);
      if (isRecord(value)) {
        progress.push(value);
      }
    } catch {
      // Invalid progress never becomes raw failure output.
    }
  });
  let failed = false;
  let outputSent = false;
  // Tests dequeued and not yet complete: the ones a timeout interrupted. Tests
  // declared in a loop can share a key, so each key counts its runs.
  const running = new Map<string, { data: ReporterEventData; count: number }>();
  const runningKey = (data: ReporterEventData) =>
    `${data.nesting}:${data.line}:${data.column}:${data.name}`;
  for await (const event of source) {
    if (event.type === "test:dequeue" && typeof event.data?.name === "string") {
      const key = runningKey(event.data);
      running.set(key, { data: event.data, count: (running.get(key)?.count ?? 0) + 1 });
      continue;
    }
    if (event.type === "test:complete" && typeof event.data?.name === "string") {
      const key = runningKey(event.data);
      const entry = running.get(key);
      if (entry && entry.count > 1) {
        entry.count -= 1;
      } else {
        running.delete(key);
      }
      continue;
    }
    if (event.type === "test:interrupted") {
      // The runner's timeout sent SIGTERM and Node exits right after this event,
      // so send the names first and the output once, newest lines first.
      yield `${JSON.stringify({
        type: "test:interrupted",
        data: {
          running: [...running.values()].slice(-interruptedTestLimit).map(({ data }) => ({
            name: data.name,
            line: data.line,
            nesting: data.nesting,
          })),
        },
      })}\n`;
      if (!outputSent) {
        outputSent = true;
        yield* interruptedOutput(output.finish());
      }
      continue;
    }
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      if (typeof event.data?.message === "string") {
        if (event.type === "test:stdout") {
          readProgress(event.data.message);
          for (const value of progress.splice(0)) {
            yield `${JSON.stringify({ type: "test:progress", data: value })}\n`;
          }
        }
        output.add(event.type === "test:stdout" ? "stdout" : "stderr", event.data.message);
      }
      continue;
    }
    if (event.type === "test:fail") {
      failed = true;
    }
    if (
      recordCoverage &&
      event.type === "test:summary" &&
      typeof event.data?.file === "string" &&
      event.data.counts
    ) {
      const { tests, passed, failed, cancelled, skipped, todo, suites }: ReportedCounts =
        event.data.counts;
      yield `${JSON.stringify({
        type: "test:summary",
        data: { tests, passed, failed, cancelled, skipped, todo, suites },
      })}\n`;
      continue;
    }
    if (event.type === "test:diagnostic") {
      const message = event.data?.message;
      if (typeof message !== "string") {
        continue;
      }
      const measurement = parseMeasurementDiagnostic(message);
      if (typeof event.data?.file === "string" && measurement === undefined) {
        output.diagnostic(message);
      }
      // Node diagnostics can quote thrown errors; retain only this fixed failure category.
      if (message.startsWith(postTestAsyncActivityPrefix)) {
        yield '{"type":"test:diagnostic","data":{"kind":"post-test-async-activity"}}\n';
      } else if (measurement) {
        yield `${JSON.stringify({
          type: "test:diagnostic",
          data: { kind: "measurement", measurement },
        })}\n`;
      }
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail" && event.type !== "test:start") {
      continue;
    }

    yield `${JSON.stringify({
      type: event.type,
      data: location(event.data, recordCoverage),
    })}\n`;
  }
  // Passing files send nothing extra.
  if (failed && !outputSent) {
    yield `${JSON.stringify({ type: "test:output", data: output.finish() })}\n`;
  }
}
