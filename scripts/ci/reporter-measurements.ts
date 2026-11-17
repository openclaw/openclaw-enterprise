import {
  openShellGitRetentionKind,
  projectOpenShellGitRetention,
} from "./openshell-git-retention.mjs";
import { openShellProgress } from "./openshell-progress.mjs";
import { isRecord } from "./reporter-diagnostics.ts";

// Tests publish timings with t.diagnostic(`${measurementPrefix}${JSON}`). Only the
// allowlisted shape below is retained in ordinary results.
const measurementPrefix = "openclaw-ci-measurement ";
const openShellStageMeasurementKind = "openshell-stage";
const openShellSandboxMeasurementKind = "openshell-sandbox-phase";
const openShellPolicyCheckKind = "openshell-network-policy-check";
const openShellFixtureTeardownKind = "openshell-fixture-teardown";
const openShellGatewayTurnFailureKind = "openshell-gateway-turn-failure";
const openShellNativePolicyCheckKind = "openshell-native-policy-check";
const openShellInitialTurnoverKind = "openshell-initial-turnover";
const nativePolicyPrimaryChecks = new Set([
  "agent.get",
  "agent.status-200",
  "agent.active-revision",
  "sandbox.wait-active",
  "sandbox.native-address",
  "baseline.policy-status",
  "baseline.sandbox",
  "baseline.resource-version",
  "fixture.make-directory",
  "fixture.pause-worker",
  "fixture.read-helm-values",
  "fixture.save-helm-values",
  "fixture.parse-helm-values",
  "fixture.prepare-auth-values",
  "fixture.write-auth-values",
  "client.reader",
  "client.recommender",
  "client.writer",
  "client.no-scopes",
  "read.unauthenticated-code-16",
  "read.reader-equals-baseline",
  "read.no-scopes-code-7",
  "drafts.reader-code-7",
  "drafts.no-scopes-code-7",
  "drafts.recommender-rpc",
  "drafts.recommender-chunks-array",
  "read.recommender-code-7",
  "update.reader-code-7",
  "update.no-scopes-code-7",
  "read.writer-code-7",
  "read.reader-unchanged-after-denials",
  "update.writer-rpc",
  "read.reader-wait-loaded",
  "read.loaded-policy-equals-baseline",
  "fixture.write-success-marker",
  "auth.helm-upgrade",
  "auth.gateway-ready",
  "auth.restart-forward",
]);
const nativePolicyCleanupChecks = new Set([
  "cleanup.close-client",
  "cleanup.restore-auth.helm-upgrade",
  "cleanup.restore-auth.gateway-ready",
  "cleanup.restore-auth.restart-forward",
  "cleanup.remove-directory",
  "cleanup.resume-worker",
]);
const openShellPolicyChecks = new Set([
  "installation-discovery",
  "cluster-target-reachability",
  "agent-default-control-request",
  "agent-default-control-exit",
  "agent-default-control-response",
  "agent-initial-denial-request",
  "agent-initial-denial-exit",
  "agent-initial-denial-reason",
  "provider-denial-read",
  "provider-denial-observed",
  "provider-denied-dns-binding",
  "editing-admission",
  "apply-authorization",
  "grant-application",
  "granted-agent-request",
  "provider-allow-observed",
  "revision-unchanged",
  "second-agent-isolation",
  "second-agent-control-request",
  "second-agent-denied-request",
  "second-agent-cleanup",
  "editing-state-enforcement",
  "grant-revocation",
]);
const firstAgentStages = new Set([
  "setup",
  "cleanup",
  "initial-deploy-and-model",
  "reuse-model",
  "native-deploy",
  "native-model",
  "native-redeploy",
  "native-resumed-model",
]);
const openShellSandboxStages = new Set([
  "installation",
  "exposure-auth",
  "gateway-turns",
  "filesystem-egress",
  "network-policy",
  "credential-route",
  "pod-replacement",
  "untrusted-model-upstream",
  "tool-upstream-outage",
  "model-provider-outage",
  "gateway-outage",
  "oauth-refresh",
  "non-model-source",
  "credential-audit",
  "source-withdrawal",
  "embedded-fail-closed",
  "native-policy-scopes",
]);

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isChoice<T extends string | number>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value);
}

function isAllowed(value: unknown, choices: ReadonlySet<string>): value is string {
  return typeof value === "string" && choices.has(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCount(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

// Undefined identifies ordinary diagnostics. Null keeps rejected measurements
// out of the raw failure output, including when parsing or projection throws.
export function parseMeasurementDiagnostic(message: string): object | null | undefined {
  if (!message.startsWith(measurementPrefix)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(message.slice(measurementPrefix.length));
    return safeMeasurement(value) ?? null;
  } catch {
    return null;
  }
}

function safeMeasurement(value: unknown): object | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind === "keycloak-enrollment-interrupted") {
    const { kind, row, operation } = value;
    return isSafeInteger(row) &&
      row >= 0 &&
      row <= 33 &&
      isChoice(operation, [
        "close-console",
        "close-ingress",
        "close-context",
        "prepare-installation",
        "delete-realm-resource",
        "configure-realm",
        "query-users",
        "serve-console",
        "open-page",
        "sign-in",
        "wait-for-callback",
        "wait-for-console",
      ])
      ? { kind, row, operation }
      : undefined;
  }
  if (value.kind === openShellGitRetentionKind) {
    const measurement: unknown = projectOpenShellGitRetention(value);
    return isRecord(measurement) ? measurement : undefined;
  }
  if (value.kind === openShellInitialTurnoverKind) {
    return safeOpenShellInitialTurnoverMeasurement(value);
  }
  if (value.kind === openShellGatewayTurnFailureKind) {
    const { kind, checkpoint, turn, status } = value;
    const outsideTurn = checkpoint === "gateway-setup" || checkpoint === "native-evidence";
    const validStatus =
      status === null ||
      (checkpoint === "http-status" && isInteger(status) && status >= 100 && status <= 599);
    if (
      (!outsideTurn &&
        !isChoice(checkpoint, [
          "turn-request",
          "response-read",
          "credential-absence",
          "http-status",
          "response-nonce",
        ])) ||
      !isChoice(turn, [0, 1, 2]) ||
      outsideTurn !== (turn === 0) ||
      !validStatus
    ) {
      return undefined;
    }
    return { kind, checkpoint, turn, status };
  }
  if (value.kind === openShellStageMeasurementKind) {
    const { kind, stage, outcome } = value;
    const allowedStage =
      typeof stage === "string" &&
      stage !== "exposure-auth" &&
      Boolean(openShellProgress({ kind, stage, outcome }));
    return safeStageMeasurement(value, allowedStage, 7_200_000);
  }
  if (value.kind === openShellSandboxMeasurementKind) {
    return safeStageMeasurement(value, isAllowed(value.stage, openShellSandboxStages), 2_400_000);
  }
  if (value.kind === openShellPolicyCheckKind) {
    return isAllowed(value.check, openShellPolicyChecks)
      ? { kind: value.kind, check: value.check }
      : undefined;
  }
  if (value.kind === "openshell-policy-probe") {
    if (
      !(
        (value.role === "control" && value.port === 8082) ||
        (value.role === "policy" && value.port === 8083)
      ) ||
      !isHash(value.targetHash) ||
      !isCount(value.commandCount) ||
      !isCount(value.candidateCount) ||
      value.candidateCount > value.commandCount ||
      (value.selectedIndex !== null && !isCount(value.selectedIndex)) ||
      (value.selectedIndex === null
        ? value.candidateCount !== 0
        : value.selectedIndex >= value.commandCount || value.candidateCount === 0) ||
      !isCount(value.laterUriMatches) ||
      value.laterUriMatches >
        (value.selectedIndex === null ? 0 : value.commandCount - value.selectedIndex - 1) ||
      !Array.isArray(value.commands) ||
      value.commands.length !== Math.min(8, value.commandCount - (value.selectedIndex ?? 0))
    ) {
      return undefined;
    }
    const commands: Array<{
      hash: string;
      hasUrllib: boolean;
      hasInterpreter: boolean;
      hasExpectedUri: boolean;
    }> = [];
    const rawCommands: unknown[] = value.commands;
    for (const command of rawCommands) {
      if (!isRecord(command)) {
        return undefined;
      }
      const { hash, hasUrllib, hasInterpreter, hasExpectedUri } = command;
      if (
        !isHash(hash) ||
        typeof hasUrllib !== "boolean" ||
        typeof hasInterpreter !== "boolean" ||
        typeof hasExpectedUri !== "boolean"
      ) {
        return undefined;
      }
      commands.push({ hash, hasUrllib, hasInterpreter, hasExpectedUri });
    }
    return {
      kind: value.kind,
      role: value.role,
      port: value.port,
      targetHash: value.targetHash,
      commandCount: value.commandCount,
      candidateCount: value.candidateCount,
      selectedIndex: value.selectedIndex,
      laterUriMatches: value.laterUriMatches,
      commands,
    };
  }
  if (value.kind === openShellNativePolicyCheckKind) {
    const { kind, stage, primaryCheck, cleanupCheck } = value;
    if (
      stage !== "native-policy-scopes" ||
      (primaryCheck === null && cleanupCheck === null) ||
      (primaryCheck !== null && !isAllowed(primaryCheck, nativePolicyPrimaryChecks)) ||
      (cleanupCheck !== null && !isAllowed(cleanupCheck, nativePolicyCleanupChecks))
    ) {
      return undefined;
    }
    return { kind, stage, primaryCheck, cleanupCheck };
  }
  if (value.kind === openShellFixtureTeardownKind) {
    return isChoice(value.outcome, ["passed", "failed", "incomplete"])
      ? { kind: value.kind, outcome: value.outcome }
      : undefined;
  }
  if (value.kind === "local-first-agent-startup-failure") {
    if (
      !isChoice(value.primaryStage, [
        "unknown",
        "canceled",
        "deadline",
        "controller-image-import",
        "routing",
        "network-verification",
        "network-cleanup",
        "registry-detach",
        "platform-namespace",
        "openshell-preparation",
        "rollback",
      ]) ||
      typeof value.cleanupFailed !== "boolean" ||
      typeof value.parentContextDone !== "boolean" ||
      (value.routingOperation !== undefined &&
        (value.primaryStage !== "routing" ||
          !isChoice(value.routingOperation, [
            "manifest-download",
            "gateway-api-readiness",
            "manifest-filter",
            "manifest-write",
            "manifest-apply",
            "controller-crd-readiness",
            "controller-rollout",
            "gateway-class-apply",
            "gateway-class-readiness",
            "node-pod-cidr",
          ]))) ||
      (value.routingController !== undefined &&
        (value.routingOperation === undefined ||
          value.routingOperation === "node-pod-cidr" ||
          !isChoice(value.routingController, ["cert-manager", "envoy-gateway"])))
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      primaryStage: value.primaryStage,
      cleanupFailed: value.cleanupFailed,
      parentContextDone: value.parentContextDone,
      ...(value.routingOperation !== undefined ? { routingOperation: value.routingOperation } : {}),
      ...(value.routingController !== undefined
        ? { routingController: value.routingController }
        : {}),
    };
  }
  if (value.kind === "local-first-agent-setup-point") {
    if (
      !isChoice(value.stage, [
        "database-start",
        "cluster-start",
        "controller-images-start",
        "routing-start",
        "network-check-start",
        "openshell-assets-start",
        "openshell-gateway-start",
        "platform-start",
        "controller-start",
        "namespace-check-start",
        "ready",
      ]) ||
      !isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 7_200_000
    ) {
      return undefined;
    }
    return { kind: value.kind, stage: value.stage, elapsedMs: value.elapsedMs };
  }
  if (value.kind === "local-first-agent-capacity") {
    const result: Record<string, string | number> = { kind: value.kind };
    for (const key of ["cpus", "totalMiB", "minimumFreeMiB", "maximumLoadHundredths", "samples"]) {
      const count = value[key];
      if (!isSafeInteger(count) || count < 0 || count > 10_000_000) {
        return undefined;
      }
      result[key] = count;
    }
    return result;
  }
  if (value.kind === "local-first-agent-manifest-failure") {
    if (
      !isChoice(value.reason, [
        "selected-input",
        "http-status",
        "transport",
        "deadline",
        "canceled",
        "integrity",
        "local-io",
      ])
    ) {
      return undefined;
    }
    return { kind: value.kind, reason: value.reason };
  }
  if (value.kind === "local-first-agent-command") {
    if (
      !isChoice(value.phase, ["setup", "cleanup"]) ||
      !isChoice(value.stage, [
        "runtime-build",
        "controller-build",
        "compose-build-and-start",
        "compose-build",
        "image-pull",
        "image-export",
        "image-import",
        "node-image-pull",
        "cluster-create",
        "k3d-image-import",
        "kubernetes-readiness",
        "helm-install",
        "openshell-image-selection",
        "openshell-image-validation",
        "openshell-assets-directory",
        "openshell-charts",
        "openshell-agent-sandbox-manifest",
        "openshell-agent-sandbox-image",
        "openshell-runtime-class",
        "openshell-agent-sandbox-apply",
        "openshell-agent-sandbox-rollout",
        "openshell-workspace-render",
        "openshell-gateway-import",
        "openshell-sandbox-import",
        "openshell-supervisor-import",
        "openshell-prepare",
      ]) ||
      !isInteger(value.count) ||
      value.count < 1 ||
      value.count > 100_000 ||
      !isInteger(value.failed) ||
      value.failed < 0 ||
      value.failed > value.count ||
      !isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 7_200_000
    ) {
      return undefined;
    }
    const result = {
      kind: value.kind,
      phase: value.phase,
      stage: value.stage,
      count: value.count,
      failed: value.failed,
      elapsedMs: value.elapsedMs,
    };
    if (value.stage === "runtime-build") {
      const { nonzeroExitCount = 0, signaledCount = 0 } = value;
      if (
        isInteger(nonzeroExitCount) &&
        nonzeroExitCount >= 0 &&
        isInteger(signaledCount) &&
        signaledCount >= 0 &&
        nonzeroExitCount + signaledCount <= value.failed
      ) {
        return {
          ...result,
          ...(nonzeroExitCount > 0 ? { nonzeroExitCount } : {}),
          ...(signaledCount > 0 ? { signaledCount } : {}),
        };
      }
    }
    return result;
  }
  if (value.kind === "local-first-agent-pod") {
    if (
      !isChoice(value.stage, ["native-initial", "native-replacement"]) ||
      !isChoice(value.role, ["harness", "gateway"]) ||
      !isInteger(value.restarts) ||
      value.restarts < 0 ||
      value.restarts > 1000
    ) {
      return undefined;
    }
    const result: Record<string, string | number | null> = {
      kind: value.kind,
      stage: value.stage,
      role: value.role,
      restarts: value.restarts,
    };
    for (const key of [
      "createdAfterRequestMs",
      "scheduledMs",
      "initializedMs",
      "runningMs",
      "readyMs",
      "observedMs",
    ]) {
      const time = value[key];
      if (time !== null && (!isInteger(time) || time < -60_000 || time > 7_200_000)) {
        return undefined;
      }
      result[key] = time;
    }
    return result;
  }
  if (value.kind === "local-first-agent") {
    return safeStageMeasurement(value, isAllowed(value.stage, firstAgentStages), 7_200_000);
  }
  if (value.kind === "runtime-model-probe") {
    return safeModelProbeMeasurement(value);
  }
  if (value.kind === "runtime-sigterm") {
    return safeSigtermMeasurement(value);
  }
  if (
    value.kind !== "kubelet-volume-refresh" ||
    !isChoice(value.volume, ["secret", "configmap"]) ||
    !isChoice(value.nudge, ["none", "pod-annotation"]) ||
    !isInteger(value.sample) ||
    value.sample < 0 ||
    value.sample > 99 ||
    typeof value.seconds !== "number" ||
    !Number.isFinite(value.seconds) ||
    value.seconds < -60 ||
    value.seconds > 3_600
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    volume: value.volume,
    nudge: value.nudge,
    sample: value.sample,
    seconds: Math.round(value.seconds * 10) / 10,
  };
}

type OpenShellTurnoverObservation = {
  requestOutcome: "passed" | "failed";
  observation: "complete" | "unavailable";
  httpStatus: number | null;
  startedAtMs: number;
  finishedAtMs: number;
  clockOffsetMinMs: number | null;
  clockOffsetMaxMs: number | null;
  connectedBeforeMs: number | null;
  connectedAfterMs: number | null;
  turnoverAtMs: number | null;
  staleTunnelAtMs: number | null;
  capturedGeneration: number | null;
  currentGeneration: number | null;
  nodeIdSha256: string | null;
  providerEnvBeforeSha256: string | null;
  providerEnvAfterSha256: string | null;
  configBeforeSha256: string | null;
  configAfterSha256: string | null;
  policyBeforeSha256: string | null;
  policyAfterSha256: string | null;
  nonceMatched: boolean;
  harness1006LogObserved: boolean;
  configUnchanged: boolean;
  policyUnchanged: boolean;
  providerEnvChanged: boolean;
  settingsConsistent: boolean;
  stableRuntime: boolean;
};

// Shared by the real refresh observer and receipt admission. This establishes
// original-turn continuity only; it cannot identify an interrupted workspace read.
export function openShellTurnoverQualification(value: OpenShellTurnoverObservation) {
  if (value.requestOutcome === "failed") {
    return "failed";
  }
  const {
    clockOffsetMinMs,
    clockOffsetMaxMs,
    connectedBeforeMs,
    connectedAfterMs,
    turnoverAtMs,
    staleTunnelAtMs,
  } = value;
  if (
    value.observation !== "complete" ||
    !value.stableRuntime ||
    !value.settingsConsistent ||
    value.httpStatus !== 200 ||
    !value.nonceMatched ||
    !value.nodeIdSha256 ||
    !value.configUnchanged ||
    !value.policyUnchanged ||
    !value.configBeforeSha256 ||
    value.configBeforeSha256 !== value.configAfterSha256 ||
    !value.policyBeforeSha256 ||
    value.policyBeforeSha256 !== value.policyAfterSha256 ||
    !value.providerEnvBeforeSha256 ||
    !value.providerEnvAfterSha256 ||
    !isSafeInteger(clockOffsetMinMs) ||
    !isSafeInteger(clockOffsetMaxMs) ||
    clockOffsetMinMs > clockOffsetMaxMs ||
    value.startedAtMs > value.finishedAtMs
  ) {
    return "incomplete";
  }
  const providerChanged = value.providerEnvBeforeSha256 !== value.providerEnvAfterSha256;
  if (
    !providerChanged &&
    !value.providerEnvChanged &&
    !value.harness1006LogObserved &&
    turnoverAtMs === null &&
    staleTunnelAtMs === null &&
    value.capturedGeneration === null &&
    value.currentGeneration === null &&
    isSafeInteger(connectedBeforeMs) &&
    connectedBeforeMs === connectedAfterMs
  ) {
    return "unexercised";
  }
  const inRequest = (time: number | null): time is number =>
    isSafeInteger(time) &&
    time >= value.startedAtMs + clockOffsetMaxMs &&
    time <= value.finishedAtMs + clockOffsetMinMs;
  if (
    providerChanged &&
    value.providerEnvChanged &&
    value.harness1006LogObserved &&
    inRequest(turnoverAtMs) &&
    inRequest(staleTunnelAtMs) &&
    isSafeInteger(connectedBeforeMs) &&
    connectedBeforeMs <= value.startedAtMs + clockOffsetMinMs &&
    inRequest(connectedAfterMs) &&
    connectedAfterMs > connectedBeforeMs &&
    turnoverAtMs <= staleTunnelAtMs &&
    staleTunnelAtMs <= connectedAfterMs &&
    isSafeInteger(value.capturedGeneration) &&
    value.capturedGeneration >= 0 &&
    value.currentGeneration === value.capturedGeneration + 1
  ) {
    return "turn-continuity";
  }
  return "incomplete";
}

function safeOpenShellInitialTurnoverMeasurement(value: Record<string, unknown>) {
  const {
    request,
    requestOutcome,
    httpStatus,
    observation,
    qualification,
    startedAtMs,
    finishedAtMs,
    clockOffsetMinMs,
    clockOffsetMaxMs,
    connectedBeforeMs,
    connectedAfterMs,
    turnoverAtMs,
    staleTunnelAtMs,
    capturedGeneration,
    currentGeneration,
    nodeIdSha256,
    providerEnvBeforeSha256,
    providerEnvAfterSha256,
    configBeforeSha256,
    configAfterSha256,
    policyBeforeSha256,
    policyAfterSha256,
    nonceMatched,
    harness1006LogObserved,
    durableCommands,
    configUnchanged,
    policyUnchanged,
    providerEnvChanged,
    settingsConsistent,
    stableRuntime,
  } = value;
  if (
    !isChoice(request, [1, 2]) ||
    !isChoice(requestOutcome, ["passed", "failed"]) ||
    !isChoice(observation, ["complete", "unavailable"]) ||
    !isChoice(qualification, ["turn-continuity", "unexercised", "incomplete", "failed"]) ||
    (httpStatus !== null && !(isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) ||
    !isCount(startedAtMs) ||
    !isCount(finishedAtMs) ||
    (clockOffsetMinMs !== null && !isSafeInteger(clockOffsetMinMs)) ||
    (clockOffsetMaxMs !== null && !isSafeInteger(clockOffsetMaxMs)) ||
    (connectedBeforeMs !== null && !isCount(connectedBeforeMs)) ||
    (connectedAfterMs !== null && !isCount(connectedAfterMs)) ||
    (turnoverAtMs !== null && !isCount(turnoverAtMs)) ||
    (staleTunnelAtMs !== null && !isCount(staleTunnelAtMs)) ||
    (capturedGeneration !== null && !isCount(capturedGeneration)) ||
    (currentGeneration !== null && !isCount(currentGeneration)) ||
    (nodeIdSha256 !== null && !isHash(nodeIdSha256)) ||
    (providerEnvBeforeSha256 !== null && !isHash(providerEnvBeforeSha256)) ||
    (providerEnvAfterSha256 !== null && !isHash(providerEnvAfterSha256)) ||
    (configBeforeSha256 !== null && !isHash(configBeforeSha256)) ||
    (configAfterSha256 !== null && !isHash(configAfterSha256)) ||
    (policyBeforeSha256 !== null && !isHash(policyBeforeSha256)) ||
    (policyAfterSha256 !== null && !isHash(policyAfterSha256)) ||
    typeof nonceMatched !== "boolean" ||
    typeof harness1006LogObserved !== "boolean" ||
    typeof durableCommands !== "boolean" ||
    typeof configUnchanged !== "boolean" ||
    typeof policyUnchanged !== "boolean" ||
    typeof providerEnvChanged !== "boolean" ||
    typeof settingsConsistent !== "boolean" ||
    typeof stableRuntime !== "boolean"
  ) {
    return undefined;
  }
  const measurement = {
    kind: openShellInitialTurnoverKind,
    request,
    requestOutcome,
    httpStatus,
    observation,
    qualification,
    startedAtMs,
    finishedAtMs,
    clockOffsetMinMs,
    clockOffsetMaxMs,
    connectedBeforeMs,
    connectedAfterMs,
    turnoverAtMs,
    staleTunnelAtMs,
    capturedGeneration,
    currentGeneration,
    nodeIdSha256,
    providerEnvBeforeSha256,
    providerEnvAfterSha256,
    configBeforeSha256,
    configAfterSha256,
    policyBeforeSha256,
    policyAfterSha256,
    nonceMatched,
    harness1006LogObserved,
    durableCommands,
    configUnchanged,
    policyUnchanged,
    providerEnvChanged,
    settingsConsistent,
    stableRuntime,
  };
  return qualification === openShellTurnoverQualification(measurement) ? measurement : undefined;
}

function safeStageMeasurement(
  value: Record<string, unknown>,
  allowedStage: boolean,
  maxElapsedMs: number,
) {
  const { kind, stage, outcome, elapsedMs } = value;
  if (
    !allowedStage ||
    typeof kind !== "string" ||
    typeof stage !== "string" ||
    (outcome !== "passed" && outcome !== "failed") ||
    !isInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > maxElapsedMs
  ) {
    return undefined;
  }
  return { kind, stage, outcome, elapsedMs };
}

const modelProbeMeasurementCases = new Set([
  "gateway-500m-answer",
  "gateway-500m-hang",
  "gateway-500m-contended",
  "gateway-1cpu-answer",
]);
const modelProbeMeasurementCodes = new Set([
  "READY",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "MODEL_PROBE_FAILED",
  "AUTHENTICATION_FAILED",
  "UNAVAILABLE",
]);
const modelProbeMeasurementTimes = [
  "elapsedMs",
  "capMs",
  "cpuWaitMs",
  "setupMs",
  "probeDoneMs",
  "readyMs",
];

// A Gateway model probe's timing. Times are whole milliseconds
// up to an hour, or null when the run did not reach that point.
function safeModelProbeMeasurement(value: Record<string, unknown>) {
  if (!isAllowed(value.case, modelProbeMeasurementCases)) {
    return undefined;
  }
  const code = isAllowed(value.code, modelProbeMeasurementCodes) ? value.code : "other";
  const measurement: Record<string, string | number | null> = {
    kind: "runtime-model-probe",
    case: value.case,
    code: value.code === null ? null : code,
  };
  for (const key of modelProbeMeasurementTimes) {
    const time = value[key];
    if (time !== null && !(isInteger(time) && time >= -60_000 && time <= 3_600_000)) {
      return undefined;
    }
    measurement[key] = time;
  }
  return measurement;
}

const sigtermMeasurementCases = new Set([
  "codex-model-probe",
  "codex-held-failure",
  "codex-ready",
  "gateway-model-probe",
  "gateway-held-failure",
  "gateway-ready",
  "dedicated-gateway-harness-wait",
]);

// How long a runtime wrapper took to stop after SIGTERM in one startup phase, against the
// budget the termination test allows it, in whole milliseconds up to an hour.
function safeSigtermMeasurement(value: Record<string, unknown>) {
  if (!isAllowed(value.case, sigtermMeasurementCases) || typeof value.stopped !== "boolean") {
    return undefined;
  }
  const { elapsedMs, budgetMs } = value;
  if (
    !isInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 3_600_000 ||
    !isInteger(budgetMs) ||
    budgetMs < 0 ||
    budgetMs > 3_600_000
  ) {
    return undefined;
  }
  return {
    kind: "runtime-sigterm",
    case: value.case,
    stopped: value.stopped,
    elapsedMs,
    budgetMs,
  };
}
