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
