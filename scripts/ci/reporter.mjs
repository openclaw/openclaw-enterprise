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

const postTestAsyncActivityPrefix =
  "Error: A resource generated asynchronous activity after the test ended.";

// Tests publish timings with t.diagnostic(`${measurementPrefix}${JSON}`). Only the
// allowlisted shape below survives; anything else is dropped like other diagnostics.
const measurementPrefix = "openclaw-ci-measurement ";

function safeMeasurement(message) {
  let value;
  try {
    value = JSON.parse(message.slice(measurementPrefix.length));
  } catch {
    return undefined;
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

const safeRuntimeImageStockBrokerStages = new Set([
  "material-init",
  "native-git-init",
  "config-patch",
  "fixture-reachability",
  "initialize",
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

function failureDiagnostic(error) {
  const diagnostic = error?.openclawCiDiagnostic;
  if (!isRecord(diagnostic)) {
    return undefined;
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

// Failure messages and the top stack frame make flakes attributable. They are
// raw here and travel only over the pipe to run-tests, which redacts and
// truncates them (failure-redaction.mjs) before anything reaches an artifact
// or the job log.
function failureText(cause) {
  const message =
    typeof cause === "string" ? cause : typeof cause?.message === "string" ? cause.message : "";
  const stack = typeof cause?.stack === "string" ? cause.stack : "";
  // The stack starts with the message, which can quote another process's stack.
  const messageEnd =
    message && stack.includes(message) ? stack.indexOf(message) + message.length : 0;
  const frame = stack
    .slice(messageEnd)
    .split("\n")
    .find((line) => /^\s+at\s/u.test(line))
    ?.trim();
  return {
    message: message ? message.slice(0, failureInputLimit) : undefined,
    frame: frame ? frame.slice(0, failureInputLimit) : undefined,
  };
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
  for await (const event of source) {
    if (event.type === "test:diagnostic") {
      // Node diagnostics can quote thrown errors; retain only this fixed failure category.
      if (
        typeof event.data?.message === "string" &&
        event.data.message.startsWith(postTestAsyncActivityPrefix)
      ) {
        yield '{"type":"test:diagnostic","data":{"kind":"post-test-async-activity"}}\n';
      } else if (
        typeof event.data?.message === "string" &&
        event.data.message.startsWith(measurementPrefix)
      ) {
        const measurement = safeMeasurement(event.data.message);
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
}
