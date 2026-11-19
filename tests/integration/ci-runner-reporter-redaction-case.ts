import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { projectFailureDiagnostic } from "../../scripts/ci/reporter-diagnostics.ts";
import {
  assertRepositorySetupDiagnostics,
  repositorySetupDiagnosticCases,
} from "../fixtures/ci-runner-repository-setup-diagnostics.ts";
import {
  createRunnerFixture as fixture,
  laneArgs,
  requireTestResult,
  runRunnerSync,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";
import {
  collectNativeWorkerFailure,
  nativeWorkerPlacementObservation,
  nativeWorkerTurnEventObservation,
  nativeWorkerTurnObservation,
} from "../helpers/local-first-agent-native.mjs";
import {
  nativeWorkerHistoryEvidence,
  nativeWorkerProofProgram,
} from "../helpers/native-worker-history-proof.ts";
import {
  firstRunnerRecord,
  parseRunnerRecord,
  runnerArray,
  runnerNamedRows,
  runnerRecord,
  runnerText,
} from "./ci-runner-result-records.ts";

type ControllerHttpDiagnostic = Extract<
  ReturnType<typeof projectFailureDiagnostic>,
  { occErrorCode: string }
>;

type NativeDiagnosticRequest = (
  method: string,
  params: Record<string, unknown>,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<unknown>;

// The serialized native helper accepts these observations independently. This
// fixture leaves the live lookups absent unless a case supplies them.
const absentNativeLookups = {
  elapsedMs: undefined,
  environment: undefined,
  environmentLookup: undefined,
  expectedNodeId: undefined,
  nodeLookup: undefined,
  nodes: undefined,
  placementLookup: undefined,
  sessionId: undefined,
};

export async function checkReporterRedaction(t: TestContext) {
  const root = await fixture(t);
  const resultsPath = join(root, "results/redacted.json");
  const secret = "secretauthvalue";
  // This marker is deliberately absent from the redactor's environment secrets.
  // The native projector and reporter must remove it themselves.
  const nativePrivate = "private-native-observation-marker";
  const failedProgram = spawnSync(
    process.execPath,
    [
      "-e",
      nativeWorkerProofProgram({
        sessionFile: { path: join(root, nativePrivate) },
        sessionFileContent: undefined,
        workspaceFile: undefined,
        createSessionFile: false,
        toolPrefix: "proof ",
      }),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(failedProgram.status, 1);
  const inconsistentNativeFailures = [
    [0, "read-session-file", "ENOENT"],
    [undefined, "read-session-file", "ENOENT"],
    [1, undefined, "ENOENT"],
    [1, "read-session-file", undefined],
    [1, nativePrivate, "ENOENT"],
    [1, "read-session-file", nativePrivate],
  ] as const;
  const nativeHistoryEnvelope: unknown = nativeWorkerHistoryEvidence({
    runId: "selected",
    toolPrefix: "proof ",
    marker: nativePrivate,
    command: nativePrivate,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "exec", arguments: { code: nativePrivate } }],
        __openclaw: { runId: "selected" },
      },
      {
        role: "toolResult",
        toolName: "exec",
        isError: false,
        content: JSON.stringify({
          value: { aggregated: failedProgram.stderr, exitCode: failedProgram.status },
        }),
        __openclaw: { runId: "selected" },
      },
    ],
  });
  const nativeHistory = runnerRecord(
    runnerRecord(nativeHistoryEnvelope, "native history evidence").observation,
    "native history observations",
  );
  assert.equal(nativeHistory.historyExecCodeStringCount, 1);
  assert.equal(nativeHistory.historyExecCommandStringCount, 0);
  assert.equal(nativeHistory.historyExecNestedExitNonzeroCount, 1);
  assert.equal(nativeHistory.historyExecNestedExitCode, 1);
  assert.equal(nativeHistory.historyExecFailureOperation, "read-session-file");
  assert.equal(nativeHistory.historyExecFailureCode, "ENOENT");
  assert.equal(nativeHistory.historyToolProofPresent, false);
  assert.equal(nativeHistory.historyFinalProofPresent, false);
  const nativeWorker: unknown = nativeWorkerPlacementObservation({
    placementLookup: undefined,
    placement: {
      state: "failed",
      recoveryError: `Worker tunnel did not connect within 3 minutes; ${nativePrivate}`,
      terminalReason: { message: nativePrivate },
      remoteWorkspaceDir: nativePrivate,
      session: nativePrivate,
    },
    environment: {
      id: nativePrivate,
      worker: {
        state: "failed",
        tunnelStatus: "stopped",
        error: nativePrivate,
        attachedSessionIds: [nativePrivate],
      },
    },
    nodes: [
      { nodeId: "unrelated-node", connected: true, caps: [nativePrivate] },
      {
        nodeId: nativePrivate,
        connected: false,
        paired: true,
        sessionHost: true,
        caps: ["system", nativePrivate],
        commands: [nativePrivate],
        workerBundle: { status: "installed", version: nativePrivate },
      },
    ],
    expectedNodeId: nativePrivate,
    sessionId: nativePrivate,
    environmentLookup: "found",
    nodeLookup: "found",
    elapsedMs: 180488,
  });
  const wrappedNativeWorker: unknown = nativeWorkerPlacementObservation({
    ...absentNativeLookups,
    placement: {
      state: "failed",
      recoveryError: `Worker node bootstrap failed: OpenClaw worker deploy artifact is missing; build the running package at ${nativePrivate}`,
      terminalReason: `Worker node bootstrap failed: Device worker bundle installation failed: ${nativePrivate}`,
    },
    environment: {
      worker: {
        error:
          "Worker provider preparation failed: Device worker node is not connected with the installer dialect",
      },
    },
  });
  // A retained session can acquire a new owner during send. Exercise the real
  // collector with public RPC-shaped observations, then retain its result through CI.
  const nativeSession = { key: "agent:main:retained-proof", sessionId: "retained-proof" };
  const lastPlacement = { state: "active", environmentId: "previous-owner" };
  const collectRetained = (refresh: "fresh" | "rejected" | "mismatched"): Promise<unknown> => {
    const request: NativeDiagnosticRequest = async (method, params) => {
      if (method === "node.list") {
        return { nodes: [] };
      }
      if (method === "sessions.describe") {
        if (refresh === "rejected") {
          throw new Error(nativePrivate);
        }
        return {
          session: {
            sessionId: refresh === "mismatched" ? "different-session" : nativeSession.sessionId,
            placement: { state: "failed", environmentId: "replacement-owner" },
          },
        };
      }
      if (method === "environments.status") {
        return params.environmentId === "replacement-owner"
          ? { id: "replacement-owner", worker: { state: "failed", tunnelStatus: "stopped" } }
          : { id: "previous-owner", worker: { state: "attached", tunnelStatus: "connected" } };
      }
      throw new Error("Unexpected diagnostic RPC");
    };
    return collectNativeWorkerFailure({
      session: nativeSession,
      lastPlacement,
      elapsedMs: 3000,
      error: undefined,
      expectedNodeId: undefined,
      outcome: undefined,
      runId: undefined,
      request,
    });
  };
  const freshNativeWorker = await collectRetained("fresh");
  const fallbackNativeWorker = await collectRetained("rejected");
  const mismatchedNativeWorker = await collectRetained("mismatched");
  const diagnosticSignals = new Set<AbortSignal>();
  const readTurn: NativeDiagnosticRequest = async (method, params, options) => {
    diagnosticSignals.add(options.signal);
    assert.equal(options.timeoutMs, 5000);
    if (method === "node.list") {
      return { nodes: [] };
    }
    if (method === "sessions.describe") {
      return { session: { sessionId: nativeSession.sessionId } };
    }
    assert.equal(method, "chat.history");
    assert.deepEqual(params, { sessionKey: nativeSession.key, limit: 30 });
    return { messages: [] };
  };
  const selectedTurn = { key: nativeSession.key, runId: "selected-run" };
  const identity = { sessionKey: selectedTurn.key, runId: selectedTurn.runId };
  const lifecycle = (data: Record<string, unknown>) => ({
    event: "agent",
    payload: { ...identity, stream: "lifecycle", data },
  });
  const selectedTerminal = lifecycle({
    phase: "error",
    executionSettled: true,
    providerStarted: true,
    error: `Cloud worker result does not match its committed transcript acknowledgement (leaf=${nativePrivate})`,
    transcript: `${nativePrivate}-transcript`,
    token: `${nativePrivate}-token`,
  });
  const turnEvents = Object.assign(
    {},
    ...[
      {
        event: "chat",
        payload: { ...identity, state: "status", phase: "starting_model", token: nativePrivate },
      },
      selectedTerminal,
      {
        event: "chat",
        payload: { ...identity, state: "status", phase: nativePrivate },
      },
      lifecycle({
        phase: "error",
        executionSettled: false,
        providerStarted: false,
        error: nativePrivate,
      }),
      {
        ...selectedTerminal,
        payload: {
          ...selectedTerminal.payload,
          runId: "foreign-run",
          data: { phase: "end", executionSettled: true, providerStarted: false },
        },
      },
      {
        ...selectedTerminal,
        payload: {
          ...selectedTerminal.payload,
          sessionKey: "agent:main:foreign-session",
          data: { phase: "end", executionSettled: true, providerStarted: false },
        },
      },
    ].map((event) => nativeWorkerTurnEventObservation(event, selectedTurn)),
  );
  assert.doesNotMatch(JSON.stringify(turnEvents), new RegExp(nativePrivate));
  const collectedTurn: unknown = await collectNativeWorkerFailure({
    session: nativeSession,
    runId: selectedTurn.runId,
    outcome: { status: "error", error: nativePrivate },
    turnEvents,
    elapsedMs: undefined,
    lastPlacement: undefined,
    expectedNodeId: undefined,
    error: undefined,
    request: readTurn,
  });
  assert.equal(diagnosticSignals.size, 1, "Failure reads must share one deadline");
  // Keep foreign turns and private error suffixes out of the real reporter artifact.
  const turnCases = [
    ["Remote workspace skill discovery failed", "workspace-discovery"],
    ["Runtime-local inference failed its output boundary", "worker-model-output"],
    [
      "Node-local inference startup does not match the admitted workspace or model",
      "worker-model-setup",
    ],
    [
      "Cloud worker transcript identity does not match the active turn",
      "worker-transcript-authority",
    ],
    ["Incorrect API key provided", "model-authentication"],
    ["insufficient_quota", "model-rate-or-quota"],
    ["Worker model is not approved for this session", "model-unavailable"],
    ["exec denied by security policy", "tool-policy"],
    ["EACCES: permission denied", "filesystem-permission"],
    ["Cannot find module", "file-or-command-missing"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls-validation"],
    ["fetch failed", "network-connection"],
    ["Worker turn authority changed while preparing its launch", "worker-authority"],
    ["Worker tunnel does not support worker turns", "worker-transport"],
    [
      "Cloud worker could not preserve authoritative provider replay. Stop or reclaim the cloud worker, then retry locally.",
      "worker-provider-replay",
    ],
    ["HTTP 401", "http-unauthorized"],
    ["HTTP 403", "http-forbidden"],
    ["HTTP 429", "http-rate-limit"],
  ] as const;
  const turnDiagnostics = turnCases.map(([message, category]) => {
    const worker: unknown = nativeWorkerTurnObservation({
      outcome: { status: "error", error: `${message}: ${nativePrivate}`, stopReason: "error" },
      error: new Error(nativePrivate),
      runId: "selected-run",
      historyLookup: "found",
      messages: [
        { role: "assistant", errorMessage: nativePrivate, __openclaw: { runId: "foreign-run" } },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: `${message}: ${nativePrivate}`,
          __openclaw: { runId: "selected-run" },
        },
        {
          role: "toolResult",
          toolName: "exec",
          isError: true,
          content: [{ type: "text", text: `${message}: ${nativePrivate}` }],
          __openclaw: { runId: "selected-run" },
        },
        {
          role: "toolResult",
          toolName: "exec",
          isError: true,
          content: nativePrivate,
          __openclaw: { runId: "foreign-run" },
        },
      ],
    });
    return {
      name: `native turn ${category}`,
      diagnostic: {
        kind: "native-first-agent-proof",
        failureStage: "model-outcome",
        worker: runnerRecord(worker, category),
      },
    };
  });
  // Installer errors add one more fixed wrapper. Exercise distinct transfer,
  // extraction, storage and prewarm failures without retaining their private details.
  const nativeLeafCases = [
    ["gateway returned 401", "bundle-http-401"],
    ["gateway returned 403", "bundle-http-403"],
    ["gateway returned 404", "bundle-http-404"],
    ["gateway returned 429", "bundle-http-client-error"],
    ["gateway returned 503", "bundle-http-server-error"],
    ["gateway returned 0", "bundle-http-unexpected-status"],
    ["gateway returned an unexpected worker bundle range", "bundle-range-invalid"],
    ["gateway returned an unexpected worker bundle length", "bundle-transfer-length-invalid"],
    [
      "worker bundle download stopped after 3 consecutive no-progress failures",
      "bundle-download-no-progress",
    ],
    ["prepared worker bundle archive has an unexpected length", "bundle-archive-length-invalid"],
    ["worker bundle archive exceeded its byte limit", "bundle-archive-too-large"],
    ["worker bundle transfer response exceeded its byte limit", "bundle-response-too-large"],
    ["worker bundle archive failed integrity validation", "bundle-archive-integrity-failed"],
    ["published worker bundle failed validation", "bundle-published-invalid"],
    ["gateway TLS fingerprint mismatch", "bundle-tls-mismatch"],
    ["Cloudflare Access credentials require HTTPS", "bundle-https-required"],
    ["gateway transfer is unavailable", "bundle-transfer-unavailable"],
    [
      "Worker bundle archive manifest does not match its expected hash",
      "bundle-manifest-hash-mismatch",
    ],
    ["Extracted worker bundle does not match its expected hash", "bundle-extracted-hash-mismatch"],
    ["Invalid worker bundle archive path:", "bundle-entry-invalid"],
    ["Worker bundle archive exceeds its entry limit", "bundle-extraction-limit"],
    ["Worker bundle contains a symbolic link:", "bundle-symlink-refused"],
    ["Worker bundle file changed while hashing:", "bundle-file-changed"],
    ["EACCES: permission denied", "bundle-storage-access-denied"],
    ["EPERM: operation not permitted", "bundle-operation-denied"],
    ["EROFS: read-only file system", "bundle-storage-readonly"],
    ["ENOSPC: no space left on device", "bundle-storage-full"],
    ["ENOENT: no such file or directory", "bundle-file-missing"],
    ["Command failed:", "bundle-prewarm-failed"],
    ["INVALID_REQUEST: invalid node worker bundle install request", "bundle-request-invalid"],
  ] as const;
  const nativeLeafDiagnostics = nativeLeafCases.map(([message, category]) => {
    const worker: unknown = nativeWorkerPlacementObservation({
      ...absentNativeLookups,
      placement: {
        state: "failed",
        recoveryError: `Worker node bootstrap failed: Device worker bundle installation failed: ${category === "bundle-request-invalid" ? "" : "worker-bundle-install-failed: "}${message} ${nativePrivate}`,
      },
    });
    return {
      name: `native installer ${category}`,
      diagnostic: {
        kind: "native-first-agent-proof",
        failureStage: "required-placement-terminal-failed",
        worker: runnerRecord(worker, category),
      },
    };
  });
  // An unknown outer message is not permission to search arbitrary private text for a cause.
  assert.equal(
    runnerRecord(
      nativeWorkerPlacementObservation({
        placement: {
          recoveryError: `${nativePrivate}: Worker node bootstrap failed: OpenClaw worker deploy artifact is missing; build the running package`,
        },
        ...absentNativeLookups,
      }),
      "native worker placement",
    ).recoveryError,
    "other",
  );
  const repositorySetupCases = repositorySetupDiagnosticCases(secret);

  await writeSingleFileRunnerLane(
    root,
    "redacted",
    "tests/integration/redacted.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("redacted failure locator", () => {',
      `  console.log("${secret}-stdout");`,
      `  console.error("${secret}-stderr");`,
      `  assert.equal("${secret}-actual", "expected");`,
      "});",
      'test("job env redaction", () => {',
      '  throw new Error("owner openclaw-public-owner strippedjobvalue42");',
      "});",
      'test("redacted custom error", () => {',
      `  console.log("${secret}-custom-stdout");`,
      `  console.error("${secret}-custom-stderr");`,
      `  const error = new Error("${secret}-message");`,
      `  error.name = "${secret}-name";`,
      `  error.code = "${secret}-code";`,
      "  throw error;",
      "});",
      'test("allowlisted controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(503, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 503,",
      "      expectedStatus: 201,",
      '      occErrorCode: "DEPENDENCY_UNAVAILABLE",',
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      '        operation: "create-service-account",',
      "        status: 403,",
      `        body: "${secret}-body",`,
      "      },",
      `      identity: "${secret}-identity",`,
      "    };",
      "    throw error;",
      "  }",
      "});",
      'test("allowlisted observability installation status diagnostic", () => {',
      "  try {",
      "    assert.equal(503, 401);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "observability-installation-status",',
      "      status: 503,",
      `      body: "${secret}-body",`,
      "    };",
      "    throw error;",
      "  }",
      "});",
      'test("rejects unsafe observability installation status diagnostic", () => {',
      '  const error = new Error("Invalid status control");',
      `  error.openclawCiDiagnostic = { kind: "observability-installation-status", status: "${secret}" };`,
      "  throw error;",
      "});",
      'test("allowlisted observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: true, worker: false, records: ["${secret}-record"] };`,
      "  throw error;",
      "});",
      'test("rejects unsafe observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: "${secret}", worker: false };`,
      "  throw error;",
      "});",
      'test("rejects unsafe controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(500, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 500,",
      "      expectedStatus: 201,",
      `      occErrorCode: "${secret}-code",`,
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      `        operation: "${secret}-operation",`,
      "        status: 401,",
      "      },",
      "    };",
      "    throw error;",
      "  }",
      "});",
      'for (const stage of ["ready-status", "warning-status", "initial-rollout", "warning-rollout", "secretauthvalue-stage"]) {',
      '  test(stage === "secretauthvalue-stage" ? "unsafe plugin stage" : stage, () => {',
      '    const error = new Error("secretauthvalue-message");',
      '    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage, body: "secretauthvalue-body" };',
      '    if (stage === "warning-rollout") error.openclawCiDiagnostic.pods = [',
      '      { phase: "Pending", ready: false, scheduled: true, secret: "secretauthvalue", containers: [',
      '        { name: "gateway", restartCount: 2, exitCode: 1, waitingReason: "CrashLoopBackOff", terminatedReason: "Error", message: "secretauthvalue" },',
      '        { name: "secretauthvalue", restartCount: 3 },',
      '        { name: "gateway", restartCount: 4 }',
      "      ] },",
      '      { phase: "secretauthvalue" },',
      '      { phase: "Running", ready: "secretauthvalue", scheduled: "secretauthvalue", containers: [',
      '        { name: "prepare-private-state", restartCount: -1, exitCode: 256, waitingReason: "secretauthvalue", terminatedReason: "secretauthvalue" }',
      "      ] },",
      '      { phase: "Failed" }',
      "    ];",
      "    throw error;",
      "  });",
      "}",
      `for (const { name, diagnostic } of ${JSON.stringify([
        {
          name: "allowlisted denied traffic diagnostic",
          diagnostic: {
            kind: "network-policy",
            stage: "Agent outbound platform traffic",
            target: secret,
          },
        },
        {
          name: "rejects unsafe denied traffic diagnostic",
          diagnostic: { kind: "network-policy", stage: secret },
        },
        {
          name: "allowlisted runtime stock broker diagnostic",
          diagnostic: {
            kind: "runtime-image-stock-broker",
            stage: "broker-denial",
            command: [secret],
            stderr: `${secret}-stderr`,
          },
        },
        {
          name: "rejects unsafe runtime stock broker stage",
          diagnostic: { kind: "runtime-image-stock-broker", stage: `${secret}-stage` },
        },
        {
          name: "retains native first-Agent proof failure stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement",
            output: `${secret}-output`,
          },
        },
        {
          name: "retains a terminal native first-Agent placement stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-reclaimed",
          },
        },
        {
          name: "retains native worker placement observations through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-failed",
            worker: {
              ...runnerRecord(nativeWorker, "native worker placement"),
              recoveryErrorDetail: nativePrivate,
              session: nativePrivate,
            },
            environmentId: nativePrivate,
            workspace: nativePrivate,
          },
        },
        {
          name: "retains value-free native history observations through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-history",
            worker: { ...nativeHistory, transcript: nativePrivate },
          },
        },
        ...inconsistentNativeFailures.map(([exitCode, operation, code], index) => ({
          name: `rejects inconsistent native failure ${index}`,
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-history",
            worker: {
              historyExecNestedExitCode: exitCode,
              historyExecFailureOperation: operation,
              historyExecFailureCode: code,
            },
          },
        })),
        {
          name: "rejects hostile native worker diagnostic fields",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement",
            worker: {
              placementState: nativePrivate,
              recoveryError: { message: nativePrivate },
              environmentLookup: { value: nativePrivate },
              expectedNodeConnected: nativePrivate,
              expectedNodeMatches: 4097,
              nodeCount: -1,
              elapsedMs: 3_600_001,
              session: nativePrivate,
              turnStatus: nativePrivate,
              turnError: { message: nativePrivate },
              turnStartupPhase: nativePrivate,
              turnLifecyclePhase: nativePrivate,
              turnLifecycleError: nativePrivate,
              providerStarted: nativePrivate,
              assistantError: nativePrivate,
              execError: nativePrivate,
              execResultCount: 4097,
              ...Object.fromEntries(Object.keys(nativeHistory).map((key) => [key, nativePrivate])),
            },
          },
        },
        {
          name: "retains wrapped native worker bootstrap causes through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-failed",
            worker: runnerRecord(wrappedNativeWorker, "wrapped native worker placement"),
          },
        },
        ...(
          [
            ["refreshes retained native placement", freshNativeWorker],
            ["labels fallback after failed native placement refresh", fallbackNativeWorker],
            ["rejects another session during native placement refresh", mismatchedNativeWorker],
          ] as const
        ).map(([name, worker]) => ({
          name,
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-and-exec",
            worker: runnerRecord(worker, name),
          },
        })),
        ...nativeLeafDiagnostics,
        ...turnDiagnostics,
        {
          name: "collects native turn failure within the shared read budget",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-outcome",
            worker: runnerRecord(collectedTurn, "collected native turn"),
          },
        },
        {
          name: "rejects unknown native first-Agent proof stage",
          diagnostic: { kind: "native-first-agent-proof", failureStage: `${secret}-stage` },
        },
        {
          name: "retains safe monitoring readiness evidence",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: "prometheus-up",
            reason: "container-exited",
            container: "agent",
            exitCode: 2,
            lastHttpStatus: 503,
            logs: secret,
          },
        },
        {
          name: "rejects unsafe monitoring stage",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: secret,
            reason: "timeout",
          },
        },
        ...repositorySetupCases.map(({ name, diagnostic }) => ({ name, diagnostic })),
      ])}) {`,
      "  test(name, () => {",
      `    const cause = new Error("${secret}-source-message");`,
      `    cause.args = ["${secret}-argument"];`,
      `    cause.configuration = { credential: "${secret}-credential" };`,
      `    const error = new Error("${secret}-setup-message", { cause });`,
      "    error.openclawCiDiagnostic = diagnostic;",
      "    throw error;",
      "  });",
      "}",
      "",
    ].join("\n"),
  );

  const result = runRunnerSync(laneArgs(root, "redacted", "state/redacted.jsonl", resultsPath), {
    // Public runner metadata stays readable; the runner strips OCC_TEST_* from
    // the test child, so only its own second pass can redact this value.
    GITHUB_REPOSITORY_OWNER: "openclaw-public-owner",
    OCC_TEST_STRIPPED_VALUE: "strippedjobvalue42",
  });

  assert.equal(result.status, 1);
  const details = await readFile(join(root, "state/redacted.jsonl.diagnostics.json"), "utf8");
  const cliAndArtifact = `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}\n${details}`;
  assert.doesNotMatch(cliAndArtifact, /secretauthvalue|strippedjobvalue42/);
  assert.ok(!cliAndArtifact.includes(nativePrivate));
  const report = parseRunnerRecord(details, "diagnostics");
  const diagnosticFailure = firstRunnerRecord(report.failures, "diagnostic failure");
  assert.ok(runnerArray(diagnosticFailure.tests, "diagnostic failures").length > 0);
  const summary = parseRunnerRecord(await readFile(resultsPath, "utf8"), "redaction result");
  const file = firstRunnerRecord(summary.files, "file result");
  const tests = runnerNamedRows(file.tests, "test results");
  const [locator] = tests;
  assert(locator, "Expected the failure locator case");
  assert.equal(locator.name, "redacted failure locator");
  assert.equal(locator.line, 3);
  const failure = runnerRecord(locator.error, "locator error");
  const cause = runnerRecord(failure.cause, "locator cause");
  const location = runnerRecord(failure.location, "locator location");
  assert.equal(failure.code, "ERR_TEST_FAILURE");
  assert.equal(failure.name, "Error");
  assert.equal(cause.code, "ERR_ASSERTION");
  assert.equal(cause.name, "AssertionError");
  assert.equal(location.file, await realpath(join(root, "tests/integration/redacted.test.mjs")));
  assert.equal(location.line, 6);
  assert.ok(typeof location.column === "number" && location.column > 0);
  // The bounded message and top frame name the failure; env values never survive.
  assert.match(
    runnerText(failure.message, "locator message"),
    /'\[env:CI_RUNNER_FIXTURE_CREDENTIAL\]-actual'/,
  );
  assert.match(runnerText(failure.message, "locator message"), /'expected'/);
  assert.match(
    runnerText(failure.frame, "locator frame"),
    /\(tests\/integration\/redacted\.test\.mjs:6:\d+\)$/,
  );
  assert.match(
    result.stderr,
    /run-tests: failed tests\/integration\/redacted\.test\.mjs:6 "redacted failure locator": Expected values/,
  );
  const customFailure = requireTestResult(tests, "redacted custom error");
  assert.equal(customFailure.status, "failed");
  const customError = runnerRecord(customFailure.error, "custom error");
  assert.equal(customError.cause, undefined);
  assert.equal(runnerRecord(customError.location, "custom error location").line, 14);
  assert.equal(customError.message, "[env:CI_RUNNER_FIXTURE_CREDENTIAL]-message");
  assert.equal(
    runnerRecord(requireTestResult(tests, "job env redaction").error, "environment error").message,
    "owner openclaw-public-owner [env:OCC_TEST_STRIPPED_VALUE]",
  );

  function diagnosticFor(name: string) {
    return runnerRecord(requireTestResult(tests, name).error, "test failure").diagnostic;
  }

  function assertDiagnostic(name: string, expected: object) {
    assert.deepEqual(diagnosticFor(name), expected, name);
  }

  function assertNoDiagnostic(name: string) {
    assert.equal(diagnosticFor(name), undefined, name);
  }

  function workerFor(name: string) {
    const diagnostic = runnerRecord(diagnosticFor(name), "worker diagnostic");
    return runnerRecord(diagnostic.worker, "native worker observations");
  }

  assertDiagnostic("allowlisted controller HTTP diagnostic", {
    kind: "controller-http",
    status: 503,
    expectedStatus: 201,
    occErrorCode: "DEPENDENCY_UNAVAILABLE",
    upstream: { kind: "chatgpt-admin-http", operation: "create-service-account", status: 403 },
  } satisfies ControllerHttpDiagnostic);
  assertNoDiagnostic("rejects unsafe controller HTTP diagnostic");
  assertDiagnostic("allowlisted observability installation status diagnostic", {
    kind: "observability-installation-status",
    status: 503,
    expectedStatus: 401,
  });
  assertNoDiagnostic("rejects unsafe observability installation status diagnostic");
  assertDiagnostic("allowlisted observability log export diagnostic", {
    kind: "observability-log-export",
    api: true,
    worker: false,
  });
  assertNoDiagnostic("rejects unsafe observability log export diagnostic");
  // Keep the failed wait identifiable without exposing arbitrary runtime output.
  for (const stage of ["ready-status", "warning-status", "initial-rollout"]) {
    assertDiagnostic(stage, { kind: "kubernetes-plugin-status", stage });
  }
  assertDiagnostic("warning-rollout", {
    kind: "kubernetes-plugin-status",
    stage: "warning-rollout",
    pods: [
      {
        phase: "Pending",
        ready: false,
        scheduled: true,
        containers: [
          {
            name: "gateway",
            restartCount: 2,
            exitCode: 1,
            waitingReason: "CrashLoopBackOff",
            terminatedReason: "Error",
          },
        ],
      },
      { phase: "Running", containers: [{ name: "prepare-private-state" }] },
    ],
  });
  assertNoDiagnostic("unsafe plugin stage");
  assertDiagnostic("allowlisted denied traffic diagnostic", {
    kind: "network-policy",
    stage: "Agent outbound platform traffic",
  });
  assertNoDiagnostic("rejects unsafe denied traffic diagnostic");
  assertDiagnostic("allowlisted runtime stock broker diagnostic", {
    kind: "runtime-image-stock-broker",
    stage: "broker-denial",
  });
  assertNoDiagnostic("rejects unsafe runtime stock broker stage");
  const nativeProof = requireTestResult(tests, "retains native first-Agent proof failure stage");
  assert.equal(nativeProof.status, "failed");
  assert.deepEqual(diagnosticFor(nativeProof.name), {
    kind: "native-first-agent-proof",
    failureStage: "required-placement",
  });
  assertDiagnostic("retains a terminal native first-Agent placement stage", {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-reclaimed",
  });
  assertDiagnostic("retains native worker placement observations through CI", {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-failed",
    worker: {
      placementState: "failed",
      recoveryError: "tunnel-timeout",
      terminalReason: "other",
      workspaceReferencePresent: true,
      environmentLookup: "found",
      environmentState: "failed",
      environmentError: "other",
      tunnelStatus: "stopped",
      attachedSessionCount: 1,
      attachedSessionMatches: true,
      nodeLookup: "found",
      nodeCount: 2,
      connectedNodeCount: 1,
      expectedNodeIdPresent: true,
      expectedNodeMatches: 1,
      expectedNodeConnected: false,
      expectedNodePaired: true,
      expectedNodeSessionHost: true,
      expectedNodeCaps: 2,
      expectedNodeCommands: 1,
      expectedNodeWorkerBundle: "installed",
      elapsedMs: 180488,
    },
  });
  assert.deepEqual(
    workerFor("retains value-free native history observations through CI"),
    nativeHistory,
  );
  for (const [index, [exitCode]] of inconsistentNativeFailures.entries()) {
    assert.deepEqual(
      workerFor(`rejects inconsistent native failure ${index}`),
      exitCode === undefined ? {} : { historyExecNestedExitCode: exitCode },
    );
  }
  assert.deepEqual(workerFor("rejects hostile native worker diagnostic fields"), {
    placementState: "other",
    recoveryError: "other",
    environmentLookup: "other",
    turnStatus: "other",
    turnError: "other",
    assistantError: "other",
    execError: "other",
    turnStartupPhase: "other",
    turnLifecyclePhase: "other",
    turnLifecycleError: "other",
    historyExecErrorFlag: "other",
  });
  for (const [, category] of turnCases) {
    const turn = workerFor(`native turn ${category}`);
    assert.equal(turn.turnStatus, "error");
    assert.equal(turn.turnError, category);
    assert.equal(turn.assistantError, category);
    assert.equal(turn.execError, category);
    assert.equal(turn.proofError, "other");
    assert.equal(turn.execResultCount, 1);
    assert.equal(turn.execFailureCount, 1);
  }
  const collected = workerFor("collects native turn failure within the shared read budget");
  assert.deepEqual(
    {
      turnError: collected.turnError,
      turnStartupPhase: collected.turnStartupPhase,
      turnLifecyclePhase: collected.turnLifecyclePhase,
      turnLifecycleError: collected.turnLifecycleError,
      providerStarted: collected.providerStarted,
      historyLookup: collected.historyLookup,
      execResultCount: collected.execResultCount,
    },
    {
      turnError: "other",
      turnStartupPhase: "starting_model",
      turnLifecyclePhase: "error",
      turnLifecycleError: "worker-transcript-settlement",
      providerStarted: true,
      historyLookup: "found",
      execResultCount: 0,
    },
  );
  const wrapped = workerFor("retains wrapped native worker bootstrap causes through CI");
  assert.equal(wrapped.recoveryError, "worker-deploy-artifact-missing");
  assert.equal(wrapped.terminalReason, "bundle-install-failed");
  assert.equal(wrapped.environmentError, "node-installer-disconnected");
  const fresh = workerFor("refreshes retained native placement");
  assert.equal(fresh.placementLookup, "fresh");
  assert.equal(fresh.placementState, "failed");
  assert.equal(fresh.environmentState, "failed");
  assert.equal(fresh.tunnelStatus, "stopped");
  for (const name of [
    "labels fallback after failed native placement refresh",
    "rejects another session during native placement refresh",
  ]) {
    const fallback = workerFor(name);
    assert.equal(fallback.placementLookup, "fallback");
    assert.equal(fallback.placementState, "active");
    assert.equal(fallback.environmentState, "attached");
  }
  for (const [, category] of nativeLeafCases) {
    assert.equal(workerFor(`native installer ${category}`).recoveryError, category);
  }
  assertDiagnostic("retains safe monitoring readiness evidence", {
    kind: "metrics-monitoring",
    stage: "prometheus-up",
    reason: "container-exited",
    container: "agent",
    exitCode: 2,
    lastHttpStatus: 503,
  });
  assertNoDiagnostic("rejects unsafe monitoring stage");
  assertRepositorySetupDiagnostics(summary, repositorySetupCases);

  const unsafeNativeProof = requireTestResult(
    tests,
    "rejects unknown native first-Agent proof stage",
  );
  assert.equal(unsafeNativeProof.status, "failed");
  assert.equal(diagnosticFor(unsafeNativeProof.name), undefined);
}
