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

function failureDiagnostic(error) {
  const diagnostic = error?.openclawCiDiagnostic;
  if (!isRecord(diagnostic)) {
    return undefined;
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

function location(data = {}) {
  const error = data.details?.error;
  const cause = error?.cause ?? error;
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
          cause:
            cause?.code === "ERR_ASSERTION" && cause?.name === "AssertionError"
              ? { code: "ERR_ASSERTION", name: "AssertionError" }
              : undefined,
          location: failureLocation,
          diagnostic: failureDiagnostic(cause),
        }
      : undefined,
    durationMs:
      typeof data.details?.duration_ms === "number" ? data.details.duration_ms : undefined,
    testType: data.details?.type,
  };
}

export default async function* jsonLinesReporter(source) {
  for await (const event of source) {
    if (!["test:pass", "test:fail", "test:start"].includes(event.type)) {
      continue;
    }

    yield `${JSON.stringify({
      type: event.type,
      data: location(event.data),
    })}\n`;
  }
}
