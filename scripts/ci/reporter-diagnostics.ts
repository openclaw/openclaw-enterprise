import { skipperOperationDiagnostic } from "./skipper-release.ts";

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

type NativeProofProjection = (
  failureStage: unknown,
  worker: unknown,
) =>
  | {
      kind: "native-first-agent-proof";
      failureStage: string;
      worker?: Record<string, string | number | boolean>;
    }
  | undefined;

const probeBooleanFields = [
  "running",
  "readyObserved",
  "pluginReadyObserved",
  "nativeSpawnPhaseObserved",
  "failureObserved",
] as const;
const probeDurationFields = ["capMs", "elapsedMs", "cpuWaitMs"] as const;

function isProbeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8;
}

type ProbeDiagnosticFields = {
  kind: "runtime-model-probe";
  reason: string;
  probe: string;
  modelPhase: string;
  probeStage?: string;
} & Partial<Record<(typeof probeBooleanFields)[number], boolean>> &
  Partial<Record<(typeof probeDurationFields)[number], number | null | undefined>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalProperty(value: unknown, key: string): unknown {
  if (value == null) {
    return undefined;
  }
  const boxed: unknown = Object(value);
  return (typeof boxed === "object" && boxed !== null) || typeof boxed === "function"
    ? Reflect.get(boxed, key)
    : undefined;
}

function includes(allowed: readonly string[], value: unknown): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function safeStatus(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

const podPhases = ["Pending", "Running", "Succeeded", "Failed", "Unknown"];

function pluginStatusPods(value: unknown) {
  if (!isUnknownArray(value)) {
    return undefined;
  }
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
    .filter(
      (pod): pod is Record<string, unknown> & { phase: string } =>
        isRecord(pod) && includes(podPhases, pod.phase),
    )
    .map((pod) => ({
      phase: pod.phase,
      ready: typeof pod.ready === "boolean" ? pod.ready : undefined,
      scheduled: typeof pod.scheduled === "boolean" ? pod.scheduled : undefined,
      containers: isUnknownArray(pod.containers)
        ? pod.containers
            .slice(0, 2)
            .filter(
              (container): container is Record<string, unknown> & { name: string } =>
                isRecord(container) &&
                includes(["gateway", "prepare-private-state"], container.name),
            )
            .map((container) => ({
              name: container.name,
              restartCount:
                typeof container.restartCount === "number" &&
                Number.isInteger(container.restartCount) &&
                container.restartCount >= 0 &&
                container.restartCount <= 2147483647
                  ? container.restartCount
                  : undefined,
              exitCode:
                typeof container.exitCode === "number" &&
                Number.isInteger(container.exitCode) &&
                container.exitCode >= 0 &&
                container.exitCode <= 255
                  ? container.exitCode
                  : undefined,
              waitingReason: includes(reasons, container.waitingReason)
                ? container.waitingReason
                : undefined,
              terminatedReason: includes(reasons, container.terminatedReason)
                ? container.terminatedReason
                : undefined,
            }))
        : undefined,
    }));
}

function schedulingFailureClasses(value: unknown) {
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
  if (!isUnknownArray(value) || value.length > allowed.length) {
    return ["other"];
  }
  const hasUnrecognizedClass = value.some((entry) => !includes(allowed, entry));
  const classes = allowed.filter(
    (entry) => value.includes(entry) || (entry === "other" && hasUnrecognizedClass),
  );
  return classes.length > 0 ? classes : ["other"];
}

function nonnegativeSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function relayPodDiagnostic(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.lookup !== "found") {
    return { lookup: value.lookup === "unavailable" ? "unavailable" : "other" };
  }
  const closed = (field: unknown, allowed: string[]) =>
    includes(allowed, field) ? field : "other";
  const boolean = (field: unknown) => (typeof field === "boolean" ? field : undefined);
  return {
    lookup: "found",
    phase: closed(value.phase, podPhases),
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
    exitCode: nonnegativeSafeInteger(value.exitCode, 255),
    restartCount: nonnegativeSafeInteger(value.restartCount, 2 ** 31 - 1),
    nodeAssigned: boolean(value.nodeAssigned),
    imageIdPresent: boolean(value.imageIdPresent),
    containerIdPresent: boolean(value.containerIdPresent),
  };
}

function filesystemCounters(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    availableBytes: nonnegativeSafeInteger(value.availableBytes),
    capacityBytes: nonnegativeSafeInteger(value.capacityBytes),
    inodesFree: nonnegativeSafeInteger(value.inodesFree),
    inodes: nonnegativeSafeInteger(value.inodes),
  };
}

function nodeFilesystemDiagnostic(value: unknown) {
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

function nodeTaintDiagnostics(value: unknown) {
  if (!isUnknownArray(value) || value.length > 64) {
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
  const taints = new Map<string, { category: string; effect: string }>();
  for (const entry of value) {
    const category = optionalProperty(entry, "category");
    const effect = optionalProperty(entry, "effect");
    const safeCategory = includes(categories, category) ? category : "other";
    const safeEffect = includes(effects, effect) ? effect : "other";
    taints.set(`${safeCategory}/${safeEffect}`, { category: safeCategory, effect: safeEffect });
  }
  return [...taints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
}

function relayNodeDiagnostic(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.lookup !== "found") {
    return { lookup: value.lookup === "unavailable" ? "unavailable" : "other" };
  }
  const condition = (key: string) => {
    const field = optionalProperty(value.conditions, key);
    return includes(["True", "False", "Unknown"], field) ? field : "other";
  };
  return {
    lookup: "found",
    conditions: {
      ready: condition("ready"),
      diskPressure: condition("diskPressure"),
      memoryPressure: condition("memoryPressure"),
      pidPressure: condition("pidPressure"),
      networkUnavailable: condition("networkUnavailable"),
    },
    unschedulable: typeof value.unschedulable === "boolean" ? value.unschedulable : undefined,
    taints: nodeTaintDiagnostics(value.taints),
    taintCount: nonnegativeSafeInteger(value.taintCount, 2 ** 31 - 1),
    unrecognizedTaintCount: nonnegativeSafeInteger(value.unrecognizedTaintCount, 2 ** 31 - 1),
    filesystems: nodeFilesystemDiagnostic(value.filesystems),
  };
}

export function projectFailureDiagnostic(
  error: unknown,
  projectNativeFirstAgentProof: NativeProofProjection,
) {
  const diagnostic = optionalProperty(error, "openclawCiDiagnostic");
  if (!isRecord(diagnostic)) {
    return undefined;
  }
  if (diagnostic.kind === "skipper-operation") {
    return skipperOperationDiagnostic(diagnostic);
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
      typeof exitCode === "number" &&
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
      includes(
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
        ],
        code,
      )
    ) {
      return { kind, outcome, code };
    }
    return undefined;
  }
  if (diagnostic.kind === "native-first-agent-proof") {
    return projectNativeFirstAgentProof(diagnostic.failureStage, diagnostic.worker);
  }
  if (diagnostic.kind === "runtime-model-probe") {
    if (
      !includes(["outer-timeout", "wrapper-exited", "classification"], diagnostic.reason) ||
      !includes(
        [
          "not-observed",
          "READY",
          "AUTHENTICATION_FAILED",
          "MODEL_PROBE_CPU_STARVED",
          "MODEL_PROBE_FAILED",
          "MODEL_PROBE_TIMEOUT",
          "UNAVAILABLE",
          "other",
        ],
        diagnostic.probe,
      ) ||
      !includes(["not-observed", "ok", "failed", "other"], diagnostic.modelPhase)
    ) {
      return undefined;
    }
    const fields: ProbeDiagnosticFields = {
      kind: "runtime-model-probe",
      reason: diagnostic.reason,
      probe: diagnostic.probe,
      modelPhase: diagnostic.modelPhase,
    };
    for (const key of probeBooleanFields) {
      if (typeof diagnostic[key] !== "boolean") {
        return undefined;
      }
      fields[key] = diagnostic[key];
    }
    const loadClientsSubmitted = diagnostic.loadClientsSubmitted;
    if (!isProbeCount(loadClientsSubmitted)) {
      return undefined;
    }
    const loadClientsStarted = diagnostic.loadClientsStarted;
    if (!isProbeCount(loadClientsStarted)) {
      return undefined;
    }
    const loadClientsSettled = diagnostic.loadClientsSettled;
    if (!isProbeCount(loadClientsSettled)) {
      return undefined;
    }
    const loadClientsRejected = diagnostic.loadClientsRejected;
    if (
      !isProbeCount(loadClientsRejected) ||
      loadClientsSettled > loadClientsSubmitted ||
      loadClientsStarted > loadClientsSubmitted ||
      loadClientsRejected > loadClientsSettled
    ) {
      return undefined;
    }
    const result = Object.assign(fields, {
      loadClientsSubmitted,
      loadClientsStarted,
      loadClientsSettled,
      loadClientsRejected,
    });
    for (const key of probeDurationFields) {
      if (diagnostic[key] === undefined || (key === "cpuWaitMs" && diagnostic[key] === null)) {
        result[key] = diagnostic[key];
      } else if (
        typeof diagnostic[key] === "number" &&
        Number.isSafeInteger(diagnostic[key]) &&
        diagnostic[key] >= 0 &&
        diagnostic[key] <= 3_600_000
      ) {
        result[key] = diagnostic[key];
      } else {
        return undefined;
      }
    }
    result.probeStage = includes(
      ["prepare", "preflight", "spawn", "returned", "cleanup", "complete"],
      diagnostic.probeStage,
    )
      ? diagnostic.probeStage
      : "not-observed";
    return result;
  }
  if (diagnostic.kind === "network-policy") {
    return includes(
      [
        "Agent outbound platform traffic",
        "Agent outbound Kubernetes API traffic",
        "Agent outbound cloud metadata traffic",
        "cross-tenant Agent traffic",
        "same-tenant Agent-to-Agent traffic",
        "gateway-to-candidate Agent traffic",
        "same-tenant gateway-to-Agent traffic",
        "cross-tenant gateway-to-Agent traffic",
      ],
      diagnostic.stage,
    )
      ? { kind: "network-policy", stage: diagnostic.stage }
      : undefined;
  }
  if (diagnostic.kind === "kubernetes-plugin-status") {
    return includes(
      ["ready-status", "warning-status", "initial-rollout", "warning-rollout"],
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
            typeof diagnostic.credentialService === "string" &&
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
    if (!includes(stages, diagnostic.stage) || !includes(reasons, diagnostic.reason)) {
      return undefined;
    }
    return {
      kind: "metrics-monitoring",
      stage: diagnostic.stage,
      reason: diagnostic.reason,
      container: includes(["server", "agent", "grafana"], diagnostic.container)
        ? diagnostic.container
        : undefined,
      exitCode:
        typeof diagnostic.exitCode === "number" &&
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

function upstreamDiagnostic(value: unknown) {
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
