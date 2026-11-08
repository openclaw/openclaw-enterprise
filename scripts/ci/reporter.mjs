import { failureInputLimit } from "./failure-redaction.mjs";

const safeOccErrorCodes = new Set([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INSTALLATION_EXISTS",
  "RESOURCE_CONFLICT",
  "NAMESPACE_NOT_READY",
  "NAMESPACE_NOT_EMPTY",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNKNOWN_OUTCOME",
  "INTERNAL_ERROR",
  "DEPENDENCY_UNAVAILABLE",
]);

const safeChatGptOperations = new Set([
  "create-service-account",
  "delete-service-account",
  "create-credential",
  "delete-credential",
]);

const safeRepositoryPlatformSetupStages = new Set([
  "selection",
  "kubernetes-setup",
  "database-bootstrap",
  "controller-startup",
  "namespace-create",
  "namespace-provisioning",
  "namespace-reconciliation",
  "controller-stop",
  "credential-service-startup",
  "control-relay-startup",
  "relay-creation",
  "relay-readiness",
  "controller-restart",
]);

const safeCredentialServiceFailures = new Set([
  "gateway-listener",
  "child-exited",
  "child-deadline",
  "other",
]);

const postTestAsyncActivityPrefix =
  "Error: A resource generated asynchronous activity after the test ended.";

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
  "second-agent-cleanup",
  "editing-state-enforcement",
  "grant-revocation",
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

function parseMeasurement(message) {
  if (!message.startsWith(measurementPrefix)) {
    return undefined;
  }
  try {
    return JSON.parse(message.slice(measurementPrefix.length));
  } catch {
    return undefined;
  }
}

function safeMeasurement(value) {
  if (isRecord(value) && value.kind === openShellInitialTurnoverKind) {
    return safeOpenShellInitialTurnoverMeasurement(value);
  }
  if (isRecord(value) && value.kind === openShellGatewayTurnFailureKind) {
    const { kind, checkpoint, turn, status } = value;
    const outsideTurn = checkpoint === "gateway-setup" || checkpoint === "native-evidence";
    const validTurn = outsideTurn
      ? turn === 0
      : [
          "turn-request",
          "response-read",
          "credential-absence",
          "http-status",
          "response-nonce",
        ].includes(checkpoint) &&
        (turn === 1 || turn === 2);
    const validStatus =
      status === null ||
      (checkpoint === "http-status" && Number.isInteger(status) && status >= 100 && status <= 599);
    return validTurn && validStatus ? { kind, checkpoint, turn, status } : undefined;
  }
  if (isRecord(value) && value.kind === openShellStageMeasurementKind) {
    if (
      ![
        "installation",
        "initial-model",
        "filesystem-network",
        "network-policy",
        "credential-route",
        "replacement",
        "untrusted-upstream",
        "tool-outage",
        "model-outage",
        "gateway-outage",
        "oauth-refresh",
        "non-model-source",
        "credential-absence",
        "credential-withdrawal",
        "embedded-refusal",
        "native-policy",
      ].includes(value.stage) ||
      !["passed", "failed"].includes(value.outcome) ||
      !Number.isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 7_200_000
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      stage: value.stage,
      outcome: value.outcome,
      elapsedMs: value.elapsedMs,
    };
  }
  if (isRecord(value) && value.kind === openShellSandboxMeasurementKind) {
    if (
      !openShellSandboxStages.has(value.stage) ||
      !["passed", "failed"].includes(value.outcome) ||
      !Number.isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 2_400_000
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      stage: value.stage,
      outcome: value.outcome,
      elapsedMs: value.elapsedMs,
    };
  }
  if (isRecord(value) && value.kind === openShellPolicyCheckKind) {
    return openShellPolicyChecks.has(value.check)
      ? { kind: value.kind, check: value.check }
      : undefined;
  }
  if (isRecord(value) && value.kind === openShellNativePolicyCheckKind) {
    const { kind, stage, primaryCheck, cleanupCheck } = value;
    if (
      stage !== "native-policy-scopes" ||
      (primaryCheck === null && cleanupCheck === null) ||
      (primaryCheck !== null && !nativePolicyPrimaryChecks.has(primaryCheck)) ||
      (cleanupCheck !== null && !nativePolicyCleanupChecks.has(cleanupCheck))
    ) {
      return undefined;
    }
    return { kind, stage, primaryCheck, cleanupCheck };
  }
  if (isRecord(value) && value.kind === openShellFixtureTeardownKind) {
    return ["passed", "failed", "incomplete"].includes(value.outcome)
      ? { kind: value.kind, outcome: value.outcome }
      : undefined;
  }
  if (isRecord(value) && value.kind === "local-first-agent-startup-failure") {
    if (
      ![
        "unknown",
        "canceled",
        "deadline",
        "routing",
        "network-verification",
        "network-cleanup",
        "registry-detach",
        "platform-namespace",
        "openshell-preparation",
        "rollback",
      ].includes(value.primaryStage) ||
      typeof value.cleanupFailed !== "boolean" ||
      typeof value.parentContextDone !== "boolean"
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      primaryStage: value.primaryStage,
      cleanupFailed: value.cleanupFailed,
      parentContextDone: value.parentContextDone,
    };
  }
  if (isRecord(value) && value.kind === "local-first-agent-setup-point") {
    if (
      ![
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
      ].includes(value.stage) ||
      !Number.isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 7_200_000
    ) {
      return undefined;
    }
    return { kind: value.kind, stage: value.stage, elapsedMs: value.elapsedMs };
  }
  if (isRecord(value) && value.kind === "local-first-agent-capacity") {
    const result = { kind: value.kind };
    for (const key of ["cpus", "totalMiB", "minimumFreeMiB", "maximumLoadHundredths", "samples"]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000_000) {
        return undefined;
      }
      result[key] = value[key];
    }
    return result;
  }
  if (isRecord(value) && value.kind === "local-first-agent-command") {
    if (
      !["setup", "cleanup"].includes(value.phase) ||
      ![
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
      ].includes(value.stage) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 100_000 ||
      !Number.isInteger(value.failed) ||
      value.failed < 0 ||
      value.failed > value.count ||
      !Number.isInteger(value.elapsedMs) ||
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
        Number.isInteger(nonzeroExitCount) &&
        nonzeroExitCount >= 0 &&
        Number.isInteger(signaledCount) &&
        signaledCount >= 0 &&
        nonzeroExitCount + signaledCount <= value.failed
      ) {
        if (nonzeroExitCount > 0) {
          result.nonzeroExitCount = nonzeroExitCount;
        }
        if (signaledCount > 0) {
          result.signaledCount = signaledCount;
        }
      }
    }
    return result;
  }
  if (isRecord(value) && value.kind === "local-first-agent-pod") {
    if (
      !["native-initial", "native-replacement"].includes(value.stage) ||
      !["harness", "gateway"].includes(value.role) ||
      !Number.isInteger(value.restarts) ||
      value.restarts < 0 ||
      value.restarts > 1000
    ) {
      return undefined;
    }
    const result = {
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
      if (
        value[key] !== null &&
        (!Number.isInteger(value[key]) || value[key] < -60_000 || value[key] > 7_200_000)
      ) {
        return undefined;
      }
      result[key] = value[key];
    }
    return result;
  }
  if (isRecord(value) && value.kind === "local-first-agent") {
    if (
      ![
        "setup",
        "cleanup",
        "initial-deploy-and-model",
        "reuse-model",
        "native-deploy",
        "native-model",
        "native-redeploy",
        "native-resumed-model",
      ].includes(value.stage) ||
      !["passed", "failed"].includes(value.outcome) ||
      !Number.isInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 7_200_000
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      stage: value.stage,
      outcome: value.outcome,
      elapsedMs: value.elapsedMs,
    };
  }
  if (isRecord(value) && value.kind === "runtime-model-probe") {
    return safeModelProbeMeasurement(value);
  }
  if (isRecord(value) && value.kind === "runtime-sigterm") {
    return safeSigtermMeasurement(value);
  }
  if (
    !isRecord(value) ||
    value.kind !== "kubelet-volume-refresh" ||
    !["secret", "configmap"].includes(value.volume) ||
    !["none", "pod-annotation"].includes(value.nudge) ||
    !Number.isInteger(value.sample) ||
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

// Shared by the real refresh observer and receipt admission. This establishes
// original-turn continuity only; it cannot identify an interrupted workspace read.
export function openShellTurnoverQualification(value) {
  if (value.requestOutcome === "failed") {
    return "failed";
  }
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
    !Number.isSafeInteger(value.clockOffsetMinMs) ||
    !Number.isSafeInteger(value.clockOffsetMaxMs) ||
    value.clockOffsetMinMs > value.clockOffsetMaxMs ||
    value.startedAtMs > value.finishedAtMs
  ) {
    return "incomplete";
  }
  const events = [value.turnoverAtMs, value.staleTunnelAtMs];
  const providerChanged = value.providerEnvBeforeSha256 !== value.providerEnvAfterSha256;
  if (
    !providerChanged &&
    !value.providerEnvChanged &&
    !value.harness1006LogObserved &&
    events.every((time) => time === null) &&
    value.capturedGeneration === null &&
    value.currentGeneration === null &&
    Number.isSafeInteger(value.connectedBeforeMs) &&
    value.connectedBeforeMs === value.connectedAfterMs
  ) {
    return "unexercised";
  }
  const inRequest = (time) =>
    Number.isSafeInteger(time) &&
    time >= value.startedAtMs + value.clockOffsetMaxMs &&
    time <= value.finishedAtMs + value.clockOffsetMinMs;
  if (
    providerChanged &&
    value.providerEnvChanged &&
    value.harness1006LogObserved &&
    events.every(inRequest) &&
    Number.isSafeInteger(value.connectedBeforeMs) &&
    value.connectedBeforeMs <= value.startedAtMs + value.clockOffsetMinMs &&
    value.connectedAfterMs > value.connectedBeforeMs &&
    inRequest(value.connectedAfterMs) &&
    value.turnoverAtMs <= value.staleTunnelAtMs &&
    value.staleTunnelAtMs <= value.connectedAfterMs &&
    Number.isSafeInteger(value.capturedGeneration) &&
    value.capturedGeneration >= 0 &&
    value.currentGeneration === value.capturedGeneration + 1
  ) {
    return "turn-continuity";
  }
  return "incomplete";
}

function safeOpenShellInitialTurnoverMeasurement(value) {
  if (
    ![1, 2].includes(value.request) ||
    !["passed", "failed"].includes(value.requestOutcome) ||
    !["complete", "unavailable"].includes(value.observation) ||
    !["turn-continuity", "unexercised", "incomplete", "failed"].includes(value.qualification) ||
    (value.httpStatus !== null &&
      !(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
  ) {
    return undefined;
  }
  const measurement = {
    kind: value.kind,
    request: value.request,
    requestOutcome: value.requestOutcome,
    httpStatus: value.httpStatus,
    observation: value.observation,
    qualification: value.qualification,
  };
  for (const key of ["startedAtMs", "finishedAtMs"]) {
    if (!(Number.isSafeInteger(value[key]) && value[key] >= 0)) {
      return undefined;
    }
    measurement[key] = value[key];
  }
  for (const key of ["clockOffsetMinMs", "clockOffsetMaxMs"]) {
    if (value[key] !== null && !Number.isSafeInteger(value[key])) {
      return undefined;
    }
    measurement[key] = value[key];
  }
  for (const key of [
    "connectedBeforeMs",
    "connectedAfterMs",
    "turnoverAtMs",
    "staleTunnelAtMs",
    "capturedGeneration",
    "currentGeneration",
  ]) {
    if (value[key] !== null && !(Number.isSafeInteger(value[key]) && value[key] >= 0)) {
      return undefined;
    }
    measurement[key] = value[key];
  }
  for (const key of [
    "nodeIdSha256",
    "providerEnvBeforeSha256",
    "providerEnvAfterSha256",
    "configBeforeSha256",
    "configAfterSha256",
    "policyBeforeSha256",
    "policyAfterSha256",
  ]) {
    if (
      value[key] !== null &&
      !(typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key]))
    ) {
      return undefined;
    }
    measurement[key] = value[key];
  }
  for (const key of [
    "nonceMatched",
    "harness1006LogObserved",
    "durableCommands",
    "configUnchanged",
    "policyUnchanged",
    "providerEnvChanged",
    "settingsConsistent",
    "stableRuntime",
  ]) {
    if (typeof value[key] !== "boolean") {
      return undefined;
    }
    measurement[key] = value[key];
  }
  return measurement.qualification === openShellTurnoverQualification(measurement)
    ? measurement
    : undefined;
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

// A Gateway model probe's timing (finding 936). Times are whole milliseconds
// up to an hour, or null when the run did not reach that point.
function safeModelProbeMeasurement(value) {
  if (!modelProbeMeasurementCases.has(value.case)) {
    return undefined;
  }
  const measurement = {
    kind: value.kind,
    case: value.case,
    code: modelProbeMeasurementCodes.has(value.code)
      ? value.code
      : value.code === null
        ? null
        : "other",
  };
  for (const key of modelProbeMeasurementTimes) {
    const time = value[key];
    if (time !== null && !(Number.isInteger(time) && time >= -60_000 && time <= 3_600_000)) {
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
function safeSigtermMeasurement(value) {
  if (!sigtermMeasurementCases.has(value.case) || typeof value.stopped !== "boolean") {
    return undefined;
  }
  for (const key of ["elapsedMs", "budgetMs"]) {
    if (!(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 3_600_000)) {
      return undefined;
    }
  }
  return {
    kind: value.kind,
    case: value.case,
    stopped: value.stopped,
    elapsedMs: value.elapsedMs,
    budgetMs: value.budgetMs,
  };
}

const safeRuntimeImageStockBrokerStages = new Set([
  "material-init",
  "native-git-init",
  "config-patch",
  "fixture-reachability",
  "initialize",
  "bundled-system-skill",
  "proxy-env",
  "broker-denial",
  "outside-home-read",
  "outside-home-shadow-write",
  "outside-home-read-after-shadow-write",
  "git-proof",
  "explicit-deny",
  "unrelated-private-host",
  "direct-private-host",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function pluginStatusPods(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const phases = ["Pending", "Running", "Succeeded", "Failed", "Unknown"];
  const reasons = [
    "ContainerCreating",
    "PodInitializing",
    "CrashLoopBackOff",
    "ErrImagePull",
    "ImagePullBackOff",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
    "Error",
    "Completed",
    "OOMKilled",
    "ContainerCannotRun",
    "StartError",
  ];
  return value
    .slice(0, 3)
    .filter((pod) => isRecord(pod) && phases.includes(pod.phase))
    .map((pod) => ({
      phase: pod.phase,
      ready: typeof pod.ready === "boolean" ? pod.ready : undefined,
      scheduled: typeof pod.scheduled === "boolean" ? pod.scheduled : undefined,
      containers: Array.isArray(pod.containers)
        ? pod.containers
            .slice(0, 2)
            .filter(
              (container) =>
                isRecord(container) &&
                ["gateway", "prepare-private-state"].includes(container.name),
            )
            .map((container) => ({
              name: container.name,
              restartCount:
                Number.isInteger(container.restartCount) &&
                container.restartCount >= 0 &&
                container.restartCount <= 2147483647
                  ? container.restartCount
                  : undefined,
              exitCode:
                Number.isInteger(container.exitCode) &&
                container.exitCode >= 0 &&
                container.exitCode <= 255
                  ? container.exitCode
                  : undefined,
              waitingReason: reasons.includes(container.waitingReason)
                ? container.waitingReason
                : undefined,
              terminatedReason: reasons.includes(container.terminatedReason)
                ? container.terminatedReason
                : undefined,
            }))
        : undefined,
    }));
}

function schedulingFailureClasses(value) {
  if (value === undefined) {
    return undefined;
  }
  const allowed = [
    "disk-pressure",
    "memory-pressure",
    "pid-pressure",
    "not-ready",
    "unreachable",
    "cordoned",
    "control-plane",
    "insufficient-cpu",
    "insufficient-memory",
    "insufficient-ephemeral-storage",
    "insufficient-pods",
    "untolerated-taint",
    "other",
  ];
  if (!Array.isArray(value) || value.length > allowed.length) {
    return ["other"];
  }
  const unknown = value.some((entry) => !allowed.includes(entry));
  const classes = allowed.filter(
    (entry) => value.includes(entry) || (entry === "other" && unknown),
  );
  return classes.length > 0 ? classes : ["other"];
}

function relayPodDiagnostic(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.lookup !== "found") {
    return { lookup: value.lookup === "unavailable" ? "unavailable" : "other" };
  }
  const closed = (field, allowed) => (allowed.includes(field) ? field : "other");
  const integer = (field, maximum) =>
    Number.isSafeInteger(field) && field >= 0 && field <= maximum ? field : undefined;
  const boolean = (field) => (typeof field === "boolean" ? field : undefined);
  return {
    lookup: "found",
    phase: closed(value.phase, ["Pending", "Running", "Succeeded", "Failed", "Unknown"]),
    scheduled: closed(value.scheduled, ["True", "False", "Unknown"]),
    scheduledReason:
      value.scheduledReason === undefined
        ? undefined
        : closed(value.scheduledReason, ["Unschedulable", "SchedulingGated"]),
    schedulingFailures: schedulingFailureClasses(value.schedulingFailures),
    ready: closed(value.ready, ["True", "False", "Unknown"]),
    containerState: closed(value.containerState, ["waiting", "running", "terminated"]),
    waitingReason: closed(value.waitingReason, [
      "ContainerCreating",
      "PodInitializing",
      "ImagePullBackOff",
      "ErrImagePull",
      "InvalidImageName",
      "CreateContainerConfigError",
      "CreateContainerError",
      "RunContainerError",
      "CrashLoopBackOff",
    ]),
    terminationReason: closed(value.terminationReason, [
      "Completed",
      "Error",
      "OOMKilled",
      "ContainerCannotRun",
    ]),
    exitCode: integer(value.exitCode, 255),
    restartCount: integer(value.restartCount, 2 ** 31 - 1),
    nodeAssigned: boolean(value.nodeAssigned),
    imageIdPresent: boolean(value.imageIdPresent),
    containerIdPresent: boolean(value.containerIdPresent),
  };
}

function filesystemCounters(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  const integer = (field) => (Number.isSafeInteger(field) && field >= 0 ? field : undefined);
  return {
    availableBytes: integer(value.availableBytes),
    capacityBytes: integer(value.capacityBytes),
    inodesFree: integer(value.inodesFree),
    inodes: integer(value.inodes),
  };
}

function nodeFilesystemDiagnostic(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.lookup === "found"
    ? {
        lookup: "found",
        nodeFs: filesystemCounters(value.nodeFs),
        imageFs: filesystemCounters(value.imageFs),
      }
    : { lookup: value.lookup === "unavailable" ? "unavailable" : "other" };
}

function nodeTaintDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 64) {
    return [{ category: "other", effect: "other" }];
  }
  const categories = [
    "disk-pressure",
    "memory-pressure",
    "pid-pressure",
    "not-ready",
    "unreachable",
    "cordoned",
    "network-unavailable",
    "control-plane",
    "cloud-provider-uninitialized",
    "out-of-service",
    "critical-addons",
    "other",
  ];
  const effects = ["NoSchedule", "NoExecute", "PreferNoSchedule", "other"];
  const taints = new Map();
  for (const entry of value) {
    const category = categories.includes(entry?.category) ? entry.category : "other";
    const effect = effects.includes(entry?.effect) ? entry.effect : "other";
    taints.set(`${category}/${effect}`, { category, effect });
  }
  return [...taints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
}

function relayNodeDiagnostic(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.lookup !== "found") {
    return { lookup: value.lookup === "unavailable" ? "unavailable" : "other" };
  }
  const condition = (field) => (["True", "False", "Unknown"].includes(field) ? field : "other");
  const count = (field) =>
    Number.isSafeInteger(field) && field >= 0 && field <= 2 ** 31 - 1 ? field : undefined;
  return {
    lookup: "found",
    conditions: {
      ready: condition(value.conditions?.ready),
      diskPressure: condition(value.conditions?.diskPressure),
      memoryPressure: condition(value.conditions?.memoryPressure),
      pidPressure: condition(value.conditions?.pidPressure),
      networkUnavailable: condition(value.conditions?.networkUnavailable),
    },
    unschedulable: typeof value.unschedulable === "boolean" ? value.unschedulable : undefined,
    taints: nodeTaintDiagnostics(value.taints),
    taintCount: count(value.taintCount),
    unrecognizedTaintCount: count(value.unrecognizedTaintCount),
    filesystems: nodeFilesystemDiagnostic(value.filesystems),
  };
}

// The proof runs in a separate controller process. Both its test and the CI
// reporter use this closed vocabulary; neither publishes arbitrary stage text.
export function nativeFirstAgentProofDiagnostic(failureStage, worker) {
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
  if (!stages.includes(failureStage)) {
    return undefined;
  }
  const diagnostic = { kind: "native-first-agent-proof", failureStage };
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
    historyExecErrorFlag: ["none", "false", "true", "absent", "other", "mixed"],
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
  const safe = {};
  for (const [field, values] of Object.entries(vocabularies)) {
    if (worker[field] !== undefined) {
      safe[field] = [...values, "absent", "other"].includes(worker[field])
        ? worker[field]
        : "other";
    }
  }
  for (const field of [
    "proofRpcResponse",
    "historyToolProofPresent",
    "historyFinalProofPresent",
    "historySettleExpired",
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
    if (Number.isSafeInteger(worker[field]) && worker[field] >= 0 && worker[field] <= limit) {
      safe[field] = worker[field];
    }
  }
  if (
    Number.isInteger(worker.historyExecNestedExitCode) &&
    worker.historyExecNestedExitCode >= 0 &&
    worker.historyExecNestedExitCode <= 255
  ) {
    safe.historyExecNestedExitCode = worker.historyExecNestedExitCode;
  }
  if (
    safe.historyExecNestedExitCode > 0 &&
    ["write-session-file", "read-session-file", "read-workspace-file", "emit-proof"].includes(
      worker.historyExecFailureOperation,
    ) &&
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
    ].includes(worker.historyExecFailureCode)
  ) {
    safe.historyExecFailureOperation = worker.historyExecFailureOperation;
    safe.historyExecFailureCode = worker.historyExecFailureCode;
  }
  return { ...diagnostic, worker: safe };
}

function failureDiagnostic(error) {
  const diagnostic = error?.openclawCiDiagnostic;
  if (!isRecord(diagnostic)) {
    return undefined;
  }
  if (diagnostic.kind === "openshell-startup-process") {
    const keys = Reflect.ownKeys(diagnostic);
    if (!keys.includes("kind") || !keys.includes("outcome")) {
      return undefined;
    }
    const { kind, outcome, exitCode, signal, code } = diagnostic;
    if (outcome === "output-limit" && keys.length === 2) {
      return { kind, outcome };
    }
    if (keys.length !== 3) {
      return undefined;
    }
    if (
      outcome === "exit" &&
      keys.includes("exitCode") &&
      Number.isInteger(exitCode) &&
      exitCode > 0 &&
      exitCode <= 255
    ) {
      return { kind, outcome, exitCode };
    }
    if (
      outcome === "signal" &&
      keys.includes("signal") &&
      typeof signal === "string" &&
      Object.hasOwn(process.getBuiltinModule("node:os").constants.signals, signal)
    ) {
      return { kind, outcome, signal };
    }
    if (
      outcome === "launch-error" &&
      keys.includes("code") &&
      [
        "E2BIG",
        "EACCES",
        "EAGAIN",
        "EMFILE",
        "ENFILE",
        "ENOENT",
        "ENOEXEC",
        "ENOMEM",
        "ENOTDIR",
        "EPERM",
      ].includes(code)
    ) {
      return { kind, outcome, code };
    }
    return undefined;
  }
  if (diagnostic.kind === "native-first-agent-proof") {
    return nativeFirstAgentProofDiagnostic(diagnostic.failureStage, diagnostic.worker);
  }
  if (diagnostic.kind === "runtime-model-probe") {
    if (
      !["outer-timeout", "wrapper-exited", "classification"].includes(diagnostic.reason) ||
      ![
        "not-observed",
        "READY",
        "AUTHENTICATION_FAILED",
        "MODEL_PROBE_CPU_STARVED",
        "MODEL_PROBE_FAILED",
        "MODEL_PROBE_TIMEOUT",
        "UNAVAILABLE",
        "other",
      ].includes(diagnostic.probe) ||
      !["not-observed", "ok", "failed", "other"].includes(diagnostic.modelPhase)
    ) {
      return undefined;
    }
    const result = {
      kind: "runtime-model-probe",
      reason: diagnostic.reason,
      probe: diagnostic.probe,
      modelPhase: diagnostic.modelPhase,
    };
    for (const key of [
      "running",
      "readyObserved",
      "pluginReadyObserved",
      "nativeSpawnPhaseObserved",
      "failureObserved",
    ]) {
      if (typeof diagnostic[key] !== "boolean") {
        return undefined;
      }
      result[key] = diagnostic[key];
    }
    for (const key of [
      "loadClientsSubmitted",
      "loadClientsStarted",
      "loadClientsSettled",
      "loadClientsRejected",
    ]) {
      if (!Number.isInteger(diagnostic[key]) || diagnostic[key] < 0 || diagnostic[key] > 8) {
        return undefined;
      }
      result[key] = diagnostic[key];
    }
    if (
      result.loadClientsSettled > result.loadClientsSubmitted ||
      result.loadClientsStarted > result.loadClientsSubmitted ||
      result.loadClientsRejected > result.loadClientsSettled
    ) {
      return undefined;
    }
    for (const key of ["capMs", "elapsedMs", "cpuWaitMs"]) {
      if (diagnostic[key] === undefined || (key === "cpuWaitMs" && diagnostic[key] === null)) {
        result[key] = diagnostic[key];
      } else if (
        Number.isSafeInteger(diagnostic[key]) &&
        diagnostic[key] >= 0 &&
        diagnostic[key] <= 3_600_000
      ) {
        result[key] = diagnostic[key];
      } else {
        return undefined;
      }
    }
    result.probeStage = [
      "prepare",
      "preflight",
      "spawn",
      "returned",
      "cleanup",
      "complete",
    ].includes(diagnostic.probeStage)
      ? diagnostic.probeStage
      : "not-observed";
    return result;
  }
  if (diagnostic.kind === "network-policy") {
    return [
      "Agent outbound platform traffic",
      "Agent outbound Kubernetes API traffic",
      "Agent outbound cloud metadata traffic",
      "cross-tenant Agent traffic",
      "same-tenant Agent-to-Agent traffic",
      "gateway-to-candidate Agent traffic",
      "same-tenant gateway-to-Agent traffic",
      "cross-tenant gateway-to-Agent traffic",
    ].includes(diagnostic.stage)
      ? { kind: "network-policy", stage: diagnostic.stage }
      : undefined;
  }
  if (diagnostic.kind === "kubernetes-plugin-status") {
    return ["ready-status", "warning-status", "initial-rollout", "warning-rollout"].includes(
      diagnostic.stage,
    )
      ? {
          kind: "kubernetes-plugin-status",
          stage: diagnostic.stage,
          pods: pluginStatusPods(diagnostic.pods),
        }
      : undefined;
  }
  if (diagnostic.kind === "repository-platform-setup") {
    const stage = diagnostic.stage;
    return typeof stage === "string" && safeRepositoryPlatformSetupStages.has(stage)
      ? {
          kind: "repository-platform-setup",
          stage,
          relayPod:
            stage === "relay-readiness" ? relayPodDiagnostic(diagnostic.relayPod) : undefined,
          relayNode:
            stage === "relay-readiness" ? relayNodeDiagnostic(diagnostic.relayNode) : undefined,
          credentialService:
            stage === "credential-service-startup" &&
            safeCredentialServiceFailures.has(diagnostic.credentialService)
              ? diagnostic.credentialService
              : undefined,
        }
      : undefined;
  }
  if (diagnostic.kind === "runtime-image-stock-broker") {
    const stage = diagnostic.stage;
    return typeof stage === "string" && safeRuntimeImageStockBrokerStages.has(stage)
      ? { kind: "runtime-image-stock-broker", stage }
      : undefined;
  }
  if (diagnostic.kind === "metrics-monitoring") {
    const stages = ["prometheus-up", "occ-request", "grafana-health", "grafana-datasource"];
    const reasons = ["timeout", "container-exited", "query-error"];
    if (!stages.includes(diagnostic.stage) || !reasons.includes(diagnostic.reason)) {
      return undefined;
    }
    return {
      kind: "metrics-monitoring",
      stage: diagnostic.stage,
      reason: diagnostic.reason,
      container: ["server", "agent", "grafana"].includes(diagnostic.container)
        ? diagnostic.container
        : undefined,
      exitCode:
        Number.isInteger(diagnostic.exitCode) &&
        diagnostic.exitCode >= 0 &&
        diagnostic.exitCode <= 255
          ? diagnostic.exitCode
          : undefined,
      lastHttpStatus: safeStatus(diagnostic.lastHttpStatus),
    };
  }
  if (diagnostic.kind === "observability-installation-status") {
    const status = safeStatus(diagnostic.status);
    return status === undefined
      ? undefined
      : { kind: "observability-installation-status", status, expectedStatus: 401 };
  }
  if (diagnostic.kind === "observability-log-export") {
    // Which attributed source never reached the OTLP receiver; no record content.
    return typeof diagnostic.api === "boolean" && typeof diagnostic.worker === "boolean"
      ? { kind: "observability-log-export", api: diagnostic.api, worker: diagnostic.worker }
      : undefined;
  }
  if (diagnostic.kind !== "controller-http") {
    return undefined;
  }
  const status = safeStatus(diagnostic.status);
  const expectedStatus = safeStatus(diagnostic.expectedStatus);
  const occErrorCode = diagnostic.occErrorCode;
  if (
    status === undefined ||
    expectedStatus === undefined ||
    typeof occErrorCode !== "string" ||
    !safeOccErrorCodes.has(occErrorCode)
  ) {
    return undefined;
  }
  return {
    kind: "controller-http",
    status,
    expectedStatus,
    occErrorCode,
    upstream: upstreamDiagnostic(diagnostic.upstream),
  };
}

function upstreamDiagnostic(value) {
  if (!isRecord(value) || value.kind !== "chatgpt-admin-http") {
    return undefined;
  }
  const status = safeStatus(value.status);
  const operation = value.operation;
  if (
    status === undefined ||
    typeof operation !== "string" ||
    !safeChatGptOperations.has(operation)
  ) {
    return undefined;
  }
  return { kind: "chatgpt-admin-http", operation, status };
}

// Stack lines before the first frame: the "Name: message" header.
function stackHeader(stack) {
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
function errorHeader(error) {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error?.message === "string" && error.message) {
    return error.message;
  }
  const header = typeof error?.stack === "string" ? stackHeader(error.stack) : "";
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
// truncates them (failure-redaction.mjs) before anything reaches an artifact
// or the job log.
function failureText(cause) {
  const message = errorHeader(cause);
  const stack = typeof cause?.stack === "string" ? cause.stack : "";
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
  const lines = [];
  const partial = { stdout: "", stderr: "" };
  const dropping = { stdout: false, stderr: false };
  let omitted = 0;
  // Trim in batches so a chatty passing file costs amortized constant time per line.
  const trim = (limit) => {
    if (lines.length > limit) {
      omitted += lines.length - outputTailLines;
      lines.splice(0, lines.length - outputTailLines);
    }
  };
  const push = (line) => {
    lines.push(line.slice(0, failureInputLimit));
    trim(2 * outputTailLines);
  };
  return {
    add(stream, text) {
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
      partial[stream] = parts.pop();
      if (partial[stream].length >= failureInputLimit) {
        parts.push(partial[stream]);
        partial[stream] = "";
        dropping[stream] = true;
      }
      for (const line of parts) {
        push(`${stream}: ${line}`);
      }
    },
    diagnostic(text) {
      push(`diagnostic: ${text}`);
    },
    finish() {
      for (const stream of ["stdout", "stderr"]) {
        if (partial[stream] !== "") {
          push(`${stream}: ${partial[stream]}`);
        }
      }
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
function* interruptedOutput({ lines, omitted }) {
  // Measured as JSON, since escaping can grow a line several times.
  const sizes = lines.map((line) => JSON.stringify(line).length);
  let end = lines.length;
  while (end > 0) {
    let start = end - 1;
    let chars = sizes[start];
    while (start > 0 && chars + sizes[start - 1] <= interruptedOutputBatchChars) {
      start -= 1;
      chars += sizes[start];
    }
    yield `${JSON.stringify({
      type: "test:output",
      // Every line before this batch, so run-tests can count the ones a cut lost.
      data: { lines: lines.slice(start, end), omitted: omitted + start },
    })}\n`;
    end = start;
  }
}

function location(data = {}) {
  const error = data.details?.error;
  const cause = error?.cause ?? error;
  const fileFailure = typeof data.file === "string" && data.name === data.file;
  // Only retain coordinates in the known test file, never arbitrary stack text.
  const frame =
    typeof cause?.stack === "string" && typeof data.file === "string"
      ? cause.stack.split("\n").find((line) => line.includes(`${data.file}:`))
      : undefined;
  const coordinates = frame
    ?.slice(frame.indexOf(`${data.file}:`) + data.file.length + 1)
    .match(/^(\d+):(\d+)/);
  const failureLocation = coordinates
    ? { file: data.file, line: Number(coordinates[1]), column: Number(coordinates[2]) }
    : undefined;
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
    error: error
      ? {
          code: error.code === "ERR_TEST_FAILURE" ? "ERR_TEST_FAILURE" : undefined,
          name: "Error",
          failureType:
            fileFailure && error.failureType === "testCodeFailure" ? "testCodeFailure" : undefined,
          exitCode:
            fileFailure &&
            Number.isInteger(error.exitCode) &&
            error.exitCode >= 0 &&
            error.exitCode <= 255
              ? error.exitCode
              : undefined,
          signal:
            fileFailure && ["SIGABRT", "SIGKILL", "SIGTERM"].includes(error.signal)
              ? error.signal
              : undefined,
          cause:
            cause?.code === "ERR_ASSERTION" && cause?.name === "AssertionError"
              ? { code: "ERR_ASSERTION", name: "AssertionError" }
              : undefined,
          location: failureLocation,
          diagnostic: failureDiagnostic(cause),
          ...failureText(cause),
        }
      : undefined,
    durationMs:
      typeof data.details?.duration_ms === "number" ? data.details.duration_ms : undefined,
    testType: data.details?.type,
  };
}

// Only for scripts/ci/run-tests.mjs: failure text here is unredacted, so never
// point a step whose stdout reaches a log or artifact at this reporter directly.
export default async function* jsonLinesReporter(source) {
  const output = outputTail();
  let failed = false;
  let outputSent = false;
  // Tests dequeued and not yet complete: the ones a timeout interrupted. Tests
  // declared in a loop can share a key, so each key counts its runs.
  const running = new Map();
  const runningKey = (data) => `${data.nesting}:${data.line}:${data.column}:${data.name}`;
  for await (const event of source) {
    if (event.type === "test:dequeue" && typeof event.data?.name === "string") {
      const key = runningKey(event.data);
      running.set(key, { data: event.data, count: (running.get(key)?.count ?? 0) + 1 });
      continue;
    }
    if (event.type === "test:complete" && typeof event.data?.name === "string") {
      const key = runningKey(event.data);
      const entry = running.get(key);
      if (entry?.count > 1) {
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
        output.add(event.type.slice(5), event.data.message);
      }
      continue;
    }
    if (event.type === "test:fail") {
      failed = true;
    }
    if (event.type === "test:diagnostic") {
      const message = event.data?.message;
      if (typeof message !== "string") {
        continue;
      }
      const value = parseMeasurement(message);
      // Per-test diagnostics name their file; the run summary counts do not.
      // OpenShell measurements belong only in the projected record, even on failure.
      if (typeof event.data.file === "string" && !message.startsWith(measurementPrefix)) {
        output.diagnostic(message);
      }
      // Node diagnostics can quote thrown errors; retain only this fixed failure category.
      if (message.startsWith(postTestAsyncActivityPrefix)) {
        yield '{"type":"test:diagnostic","data":{"kind":"post-test-async-activity"}}\n';
      } else if (value !== undefined) {
        const measurement = safeMeasurement(value);
        if (measurement) {
          yield `${JSON.stringify({
            type: "test:diagnostic",
            data: { kind: "measurement", measurement },
          })}\n`;
        }
      }
      continue;
    }
    if (!["test:pass", "test:fail", "test:start"].includes(event.type)) {
      continue;
    }

    yield `${JSON.stringify({
      type: event.type,
      data: location(event.data),
    })}\n`;
  }
  // Passing files send nothing extra.
  if (failed && !outputSent) {
    yield `${JSON.stringify({ type: "test:output", data: output.finish() })}\n`;
  }
}
