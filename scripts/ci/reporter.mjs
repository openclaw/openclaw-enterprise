import { captureFailureText, failureInputLimit } from "./failure-redaction.mjs";

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
// allowlisted shape below survives; anything else is dropped like other diagnostics.
const measurementPrefix = "openclaw-ci-measurement ";

function safeMeasurement(message) {
  let value;
  try {
    value = JSON.parse(message.slice(measurementPrefix.length));
  } catch {
    return undefined;
  }
  if (isRecord(value) && value.kind === "runtime-model-probe") {
    return safeModelProbeMeasurement(value);
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
const unreadableErrorProperty = Symbol("unreadable error property");
const unreadableErrorText = "[error details omitted: unreadable property]";

function readErrorProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return unreadableErrorProperty;
  }
}

function errorText(cause) {
  const rawMessage = typeof cause === "string" ? cause : readErrorProperty(cause, "message");
  const rawStack = readErrorProperty(cause, "stack");
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const stack = typeof rawStack === "string" ? rawStack : "";
  const unreadable = rawMessage === unreadableErrorProperty || rawStack === unreadableErrorProperty;
  const detailMessage = unreadable
    ? `${message}${message ? "\n" : ""}${unreadableErrorText}`
    : message;
  // The stack starts with the message, which can quote another process's stack.
  const messageEnd =
    message && stack.includes(message) ? stack.indexOf(message) + message.length : 0;
  const frames = stack
    .slice(messageEnd)
    .split("\n")
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => line.trim());
  return {
    message: detailMessage ? captureFailureText(detailMessage) : undefined,
    // Internal transport flags are generated here, never copied from the Error.
    messageCompleteLines: true,
    frame: frames[0]?.slice(0, failureInputLimit),
    // The whole stack goes only to the failure details in the diagnostics report.
    stack: frames.length > 0 ? captureFailureText(frames.join("\n")) : undefined,
    stackCompleteLines: true,
  };
}

function failureText(error) {
  const first = errorText(error);
  let message = first.message ?? "";
  let stack = first.stack ?? "";
  let count = 1;
  const ancestors = new Set();
  const append = (path, detail) => {
    if (detail.message) {
      message = captureFailureText(`${message}${message ? "\n" : ""}${path}: ${detail.message}`);
    }
    if (detail.stack) {
      stack = captureFailureText(`${stack}${stack ? "\n" : ""}${path}:\n${detail.stack}`);
    }
  };
  const visit = (value, path, depth) => {
    if (count >= 32) {
      append(path, { message: "[error details omitted: traversal limit]" });
      return;
    }
    count += 1;
    if (depth > 8) {
      append(path, { message: "[error details omitted: traversal limit]" });
      return;
    }
    if (value === unreadableErrorProperty) {
      append(path, { message: unreadableErrorText });
      return;
    }
    if (ancestors.has(value)) {
      append(path, { message: "[error details omitted: circular reference]" });
      return;
    }
    append(path, errorText(value));
    children(value, path, depth);
  };
  const children = (value, path, depth) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    ancestors.add(value);
    try {
      const causePath = path ? `${path}.cause` : "cause";
      const cause = readErrorProperty(value, "cause");
      if (cause !== undefined) {
        visit(cause, causePath, depth + 1);
      }
      const errorsPath = path ? `${path}.errors` : "errors";
      const errors = readErrorProperty(value, "errors");
      let isArray = false;
      try {
        isArray = Array.isArray(errors);
      } catch {
        visit(unreadableErrorProperty, errorsPath, depth + 1);
        return;
      }
      if (errors === unreadableErrorProperty) {
        visit(errors, errorsPath, depth + 1);
      } else if (isArray) {
        const length = readErrorProperty(errors, "length");
        if (!Number.isSafeInteger(length) || length < 0) {
          visit(unreadableErrorProperty, errorsPath, depth + 1);
          return;
        }
        for (let index = 0; index < length; index += 1) {
          const nextPath = `${errorsPath}[${index}]`;
          if (count >= 32) {
            append(nextPath, { message: "[error details omitted: traversal limit]" });
            break;
          }
          visit(readErrorProperty(errors, index), nextPath, depth + 1);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  };
  children(error, "", 0);
  return { ...first, message: message || undefined, stack: stack || undefined };
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
      // Per-test diagnostics name their file; the run summary counts do not.
      if (typeof event.data?.message === "string" && typeof event.data.file === "string") {
        output.diagnostic(event.data.message);
      }
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
  // Passing files send nothing extra.
  if (failed && !outputSent) {
    yield `${JSON.stringify({ type: "test:output", data: output.finish() })}\n`;
  }
}
