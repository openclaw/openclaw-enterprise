import { constants } from "node:os";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import {
  skipperGatewayChatPhases,
  skipperOperations,
  skipperOperationDiagnostic,
  skipperSelectedFailure,
  skipperTestCheckpoints,
} from "./skipper-release.ts";

const stages = [
  "preflight",
  "install",
  "bind-images",
  "bind-database",
  "selected-test",
  "verify-proof",
  "write-success-receipt",
  "finish-fixture",
] as const;
const cleanups = ["passed", "failed", "unknown"] as const;

const installerPrefix = "install/occ-dev-up/";

function installerExit(status: string) {
  const code = Number(status);
  if (Number.isInteger(code) && code > 0 && code <= 255 && String(code) === status) {
    return { component: "occ-dev-up", exitCode: code };
  }
  if (Object.hasOwn(constants.signals, status)) {
    return { component: "occ-dev-up", signal: status };
  }
}

type Checkpoint =
  | ["skipper_test_operation", (typeof skipperOperations)[number] | "unknown"]
  | ["skipper_last_test_checkpoint", string]
  | ["skipper_gateway_chat_phase", (typeof skipperGatewayChatPhases)[number]]
  | ["skipper_gateway_exec_exit_code", number]
  | ["skipper_gateway_exec_signal", string]
  | ["skipper_gateway_exec_code", string]
  | ["skipper_gateway_exec_helper_entered", true]
  | ["skipper_http_status", number]
  | ["skipper_gateway_category", string]
  | ["skipper_gateway_transport_cause", string]
  | ["skipper_runtime_signal", string]
  | ["skipper_model_request_observation", string]
  | ["skipper_model_fixture_selected_terminal_success", true]
  | ["skipper_stage", (typeof stages)[number] | `${typeof installerPrefix}${string}`]
  | ["skipper_installed_cleanup", (typeof cleanups)[number]];

export async function recordSkipperCheckpoint(...[key, value]: Checkpoint): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (process.env.GITHUB_ACTIONS === "true" && output) {
    // A failure to record evidence must leave the original proof and cleanup in charge.
    await appendFile(output, key + "=" + value + "\n").catch(() => {});
  }
}

/** Append the observed process termination before cleanup can fail or the owner exits. */
export async function recordSkipperInstallerExit(result?: {
  code: number | null;
  signal: string | null;
}) {
  if (!result) {
    return;
  }
  const status = String(result.code ?? result.signal);
  const exit = installerExit(status);
  if (exit) {
    await recordSkipperCheckpoint("skipper_stage", `${installerPrefix}${status}`);
    return exit.exitCode === undefined
      ? `occ dev up terminated by ${exit.signal}`
      : `occ dev up exited ${exit.exitCode}`;
  }
}

/** Failed runners retain only the valid prefix; successful runners require the whole ledger. */
export async function readSkipperJourney(ledgerPath: string, failed: boolean) {
  const ledger = await readFile(ledgerPath, "utf8").catch(() => "");
  const entries: Record<string, unknown>[] = [];
  for (const line of ledger.trim().split("\n")) {
    if (failed ? !line.trim() : !line) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("Invalid installed Skipper journey entry.");
      }
      entries.push(entry as Record<string, unknown>);
    } catch (error) {
      if (!failed) {
        throw error;
      }
      break;
    }
  }
  return entries;
}

/** Retain bounded failure evidence before optional ledger I/O. */
export async function recordSkipperTestFailure(
  resultText: string,
  ledgerPath: string,
  teamReview: boolean,
) {
  let diagnostic: ReturnType<typeof skipperOperationDiagnostic>;
  try {
    diagnostic = skipperOperationDiagnostic(skipperSelectedFailure(resultText).error.diagnostic);
  } catch {
    // Missing or malformed runner evidence does not establish an operation.
  }
  await recordSkipperCheckpoint("skipper_test_operation", diagnostic?.operation ?? "unknown");
  if (diagnostic?.modelRequestObservation !== undefined) {
    await recordSkipperCheckpoint(
      "skipper_model_request_observation",
      diagnostic.modelRequestObservation,
    );
  }
  if (diagnostic?.operation === "gateway-exec") {
    const { exitCode, signal, code, helperEntered } = diagnostic;
    if (exitCode !== undefined) {
      await recordSkipperCheckpoint("skipper_gateway_exec_exit_code", exitCode);
    }
    if (signal !== undefined) {
      await recordSkipperCheckpoint("skipper_gateway_exec_signal", signal);
    }
    if (code !== undefined) {
      await recordSkipperCheckpoint("skipper_gateway_exec_code", code);
    }
    if (helperEntered) {
      await recordSkipperCheckpoint("skipper_gateway_exec_helper_entered", helperEntered);
    }
  }
  if (diagnostic?.operation === "gateway-chat") {
    const { gatewayChatPhase, httpStatus, gatewayCategory, runtimeSignal, gatewayTransportCause } =
      diagnostic;
    if (diagnostic.modelFixtureSelectedTerminalSuccess) {
      await recordSkipperCheckpoint("skipper_model_fixture_selected_terminal_success", true);
    }
    if (gatewayChatPhase) {
      await recordSkipperCheckpoint("skipper_gateway_chat_phase", gatewayChatPhase);
    }
    if (httpStatus !== undefined) {
      await recordSkipperCheckpoint("skipper_http_status", httpStatus);
    }
    if (runtimeSignal !== undefined) {
      await recordSkipperCheckpoint("skipper_runtime_signal", runtimeSignal);
    }
    if (gatewayTransportCause !== undefined) {
      await recordSkipperCheckpoint("skipper_gateway_transport_cause", gatewayTransportCause);
    }
    if (gatewayCategory !== undefined) {
      await recordSkipperCheckpoint("skipper_gateway_category", gatewayCategory);
    }
  }
  const entries = await readSkipperJourney(ledgerPath, true);
  const known = skipperTestCheckpoints(teamReview);
  const last =
    entries
      .map((entry) => entry.phase)
      .filter((phase): phase is string => typeof phase === "string" && known.includes(phase))
      .at(-1) ?? "unknown";
  await recordSkipperCheckpoint("skipper_last_test_checkpoint", last);
  return {
    entries,
    last,
    gatewayChat: diagnostic?.operation === "gateway-chat" ? diagnostic : undefined,
  };
}

function selected<T extends string>(
  allowed: readonly T[],
  input: string | undefined,
): T | "unknown" {
  return allowed.find((value) => value === input) ?? "unknown";
}

if (import.meta.main && process.env.SKIPPER_PROOF_OUTCOME === "failure") {
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sourceSha } = process.env;
  const output = process.argv[2];
  if (
    !output ||
    !runId ||
    !/^[1-9]\d{0,15}$/.test(runId) ||
    !attempt ||
    !/^[1-9]\d{0,3}$/.test(attempt) ||
    !sourceSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  ) {
    console.error("Invalid installed Skipper failure receipt identity.");
    process.exitCode = 1;
  } else {
    const stage = process.env.SKIPPER_STAGE;
    const installer = stage?.startsWith(installerPrefix)
      ? installerExit(stage.slice(installerPrefix.length))
      : undefined;
    const lastStage = installer ? "install" : selected(stages, stage);
    const testOperation = selected(skipperOperations, process.env.SKIPPER_TEST_OPERATION);
    const statusText = process.env.SKIPPER_HTTP_STATUS;
    const status = Number(statusText);
    const gatewayChat =
      lastStage === "selected-test" && testOperation === "gateway-chat"
        ? skipperOperationDiagnostic({
            kind: "skipper-operation",
            operation: testOperation,
            gatewayChatPhase: process.env.SKIPPER_GATEWAY_CHAT_PHASE,
            // Accept only the canonical text emitted by the recorder.
            httpStatus: String(status) === statusText ? status : undefined,
            gatewayCategory: process.env.SKIPPER_GATEWAY_CATEGORY,
            gatewayTransportCause: process.env.SKIPPER_GATEWAY_TRANSPORT_CAUSE,
            runtimeSignal: process.env.SKIPPER_RUNTIME_SIGNAL,
            modelFixtureSelectedTerminalSuccess:
              process.env.SKIPPER_MODEL_FIXTURE_SELECTED_TERMINAL_SUCCESS === "true",
            modelRequestObservation: process.env.SKIPPER_MODEL_REQUEST_OBSERVATION,
          })
        : undefined;
    const exitText = process.env.SKIPPER_GATEWAY_EXEC_EXIT_CODE;
    const exitCode = Number(exitText);
    const execDiagnostic =
      lastStage === "selected-test" && testOperation === "gateway-exec"
        ? skipperOperationDiagnostic({
            kind: "skipper-operation",
            operation: testOperation,
            // Accept only the canonical text emitted by the recorder.
            exitCode: String(exitCode) === exitText ? exitCode : undefined,
            modelRequestObservation: process.env.SKIPPER_MODEL_REQUEST_OBSERVATION,
            signal: process.env.SKIPPER_GATEWAY_EXEC_SIGNAL,
            code: process.env.SKIPPER_GATEWAY_EXEC_CODE,
            helperEntered: process.env.SKIPPER_GATEWAY_EXEC_HELPER_ENTERED === "true",
          })
        : undefined;
    const gatewayExec = {
      ...(execDiagnostic?.modelRequestObservation
        ? { modelRequestObservation: execDiagnostic.modelRequestObservation }
        : {}),
      ...(execDiagnostic?.exitCode !== undefined ? { exitCode: execDiagnostic.exitCode } : {}),
      ...(execDiagnostic?.signal !== undefined ? { signal: execDiagnostic.signal } : {}),
      ...(execDiagnostic?.code !== undefined ? { code: execDiagnostic.code } : {}),
      ...(execDiagnostic?.helperEntered ? { helperEntered: execDiagnostic.helperEntered } : {}),
    };
    const receipt = {
      version: 1,
      runId,
      attempt,
      sourceSha,
      outcome: "failed",
      lastStage,
      ...(installer ? { installer } : {}),
      ...(Object.keys(gatewayExec).length > 0 ? { gatewayExec } : {}),
      ...(lastStage === "selected-test"
        ? {
            testOperation,
            ...(gatewayChat?.gatewayChatPhase
              ? { gatewayChatPhase: gatewayChat.gatewayChatPhase }
              : {}),
            ...(gatewayChat?.httpStatus !== undefined
              ? { httpStatus: gatewayChat.httpStatus }
              : {}),
            ...(gatewayChat?.gatewayCategory !== undefined
              ? { gatewayCategory: gatewayChat.gatewayCategory }
              : {}),
            ...(gatewayChat?.gatewayTransportCause
              ? { gatewayTransportCause: gatewayChat.gatewayTransportCause }
              : {}),
            ...(gatewayChat?.runtimeSignal ? { runtimeSignal: gatewayChat.runtimeSignal } : {}),
            ...(gatewayChat?.modelFixtureSelectedTerminalSuccess
              ? { modelFixtureSelectedTerminalSuccess: true }
              : {}),
            ...(gatewayChat?.modelRequestObservation
              ? { modelRequestObservation: gatewayChat.modelRequestObservation }
              : {}),
            lastTestCheckpoint: selected(
              [...skipperTestCheckpoints(false), ...skipperTestCheckpoints(true)],
              process.env.SKIPPER_LAST_TEST_CHECKPOINT,
            ),
          }
        : {}),
      installedCleanup: selected(cleanups, process.env.SKIPPER_INSTALLED_CLEANUP),
    };
    try {
      await writeFile(output, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      console.error("Could not write installed Skipper failure receipt.");
      process.exitCode = 1;
    }
  }
}
