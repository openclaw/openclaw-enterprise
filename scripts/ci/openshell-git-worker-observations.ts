import { createHash } from "node:crypto";
import {
  RUNTIME_DIAGNOSTIC_CODES,
  UNRECOGNIZED_RUNTIME_VALUE,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
} from "../../packages/contracts/src/runtime-failure.ts";

type FieldValue = string | number | boolean | null | object;
type ProjectionField = readonly [source: string, read: (value: unknown) => FieldValue | undefined];
type ProjectionFields = Readonly<Record<string, ProjectionField>>;
type Projected<Fields extends ProjectionFields> = {
  [Key in keyof Fields]: Exclude<ReturnType<Fields[Key][1]>, undefined>;
};

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const text = (pattern: RegExp) => (value: unknown) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;
export const uuid = text(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const digest = text(/^sha256:[a-f0-9]{64}$/);
export const hash = text(/^[a-f0-9]{64}$/);
const timestamp = text(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
export const integer = (maximum: number) => (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
export const count = integer(Number.MAX_SAFE_INTEGER);
export function choice<const Value extends string | number | boolean | null>(...values: Value[]) {
  const allowed: readonly unknown[] = values;
  const includes = (value: unknown): value is Value => allowed.includes(value);
  return (value: unknown) => (includes(value) ? value : undefined);
}
export const imageDigest = (value: unknown) =>
  typeof value === "string" && value.length <= 1024
    ? digest(value.match(/(?:^|[@/])(sha256:[a-f0-9]{64})$/)?.[1])
    : undefined;
// Supplier IDs and work IDs have no shared UUID contract. Correlate their exact
// bytes without accepting arbitrary upstream text into a public CI artifact.
export const identityHash = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 1024
    ? createHash("sha256").update(value).digest("hex")
    : undefined;

export function project<const Fields extends ProjectionFields>(
  value: unknown,
  fields: Fields,
): Projected<Fields> | undefined {
  if (!record(value)) {
    return undefined;
  }
  const result: Record<string, FieldValue> = {};
  for (const [target, [source, read]] of Object.entries<ProjectionField>(fields)) {
    const selected = read(value[source]);
    if (selected === undefined) {
      return undefined;
    }
    result[target] = selected;
  }
  // Each declared field was assigned its own reader's validated result.
  return result as Projected<Fields>;
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function projectArray<Item>(
  value: unknown,
  read: (item: unknown) => Item | undefined,
  minLength = 0,
): Item[] | undefined {
  if (!isArray(value) || value.length < minLength || value.length > 16) {
    return undefined;
  }
  const items = value.map(read);
  return items.every((item) => item !== undefined) ? items : undefined;
}

export const runtime = {
  revisionIdHash: ["revisionId", identityHash],
  sandboxIdHash: ["sandboxId", identityHash],
  sandboxUid: ["sandboxUid", uuid],
  podUid: ["podUid", uuid],
  mainProcessInstanceIdHash: ["mainProcessInstanceId", identityHash],
  mainProcessStartedAt: ["mainProcessStartedAt", timestamp],
  containers: [
    "containers",
    (value) =>
      projectArray(
        value,
        (container) =>
          project(container, {
            nameHash: ["name", identityHash],
            idHash: ["id", identityHash],
            imageDigest: ["imageId", imageDigest],
            startedAt: ["startedAt", timestamp],
            restartCount: ["restartCount", count],
          }),
        1,
      ),
  ],
} satisfies ProjectionFields;
export const launch = {
  workspaceHash: ["workspace", identityHash],
  sandboxIdHash: ["sandboxId", identityHash],
  requestId: ["requestId", uuid],
  executionSeconds: ["executionSeconds", integer(3600)],
  observerMs: ["observerMs", integer(3_600_000)],
} satisfies ProjectionFields;
export const stages = choice("before-expiry", "after-expiry", "after-worker-restart");
export const boolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);
// Safety vocabulary from openshell-expired-git.ts. Keep the standalone reporter
// independent of controller imports, and never accept arbitrary diagnostic text.
const expiryCheck = choice(
  "model-provider",
  "original-launch-and-pods",
  "original-git-provider",
  "attachment-after-send-intent",
  "original-git-installation",
  "before-detach",
  "sandbox-version-moved-before-intent",
  "detach-intent",
  "conditional-detach",
  "repeated-conditional-detach",
  "launch-after-uncertain-detach",
  "launch-after-detach",
  "git-revocation-on-original-supervisor",
  "retained-provider-profiles",
  "model-on-original-supervisor",
  "reduced-generation-moved-across-provider-check",
  "sandbox-version-moved-after-read",
  "record-reduced-generation",
);
const cleanupCode = choice(
  "REPOSITORY_ACCESS_WITHDRAWN",
  "REPOSITORY_CLEANUP_COMPLETE",
  "REPOSITORY_CLEANUP_PENDING",
  "REPOSITORY_RUNTIME_RETIREMENT_QUEUED",
);
const cleanupCause = choice(
  "REPOSITORY_WITHDRAWAL_UNCONFIRMED",
  "REPOSITORY_ATTEMPT_INVALIDATED",
  "REPOSITORY_CLEANUP_FAILED",
  "REPOSITORY_CLEANUP_PENDING",
  "COMPUTE_DRIVER_MISMATCH",
);
// worker.ts and Kubernetes activation report these ordinary readiness waits.
// Keep unknown Driver codes private, just as for cleanup diagnostics.
const readinessCode = choice(
  "REPOSITORY_GIT_ROUTE_PENDING",
  "REPOSITORY_GIT_MATERIAL_PENDING",
  "WORKSPACE_NODE_PENDING",
  "WORKSPACE_NODE_BINDING_PENDING",
  "WORKSPACE_NODE_RECONNECT_PENDING",
  "WORKSPACE_SETUP_RETRYING",
  "REVISION_INCOMPLETE",
  "REVISION_FINALIZATION_INCOMPLETE",
);
const runtimeFailureCode = choice(
  ...RUNTIME_DIAGNOSTIC_CODES,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
);

const workerObservationFields = {
  workerUid: ["workerUid", uuid],
  namespaceMatches: ["namespaceMatches", boolean],
  repository: ["repository", choice("match", "mismatch", "absent")],
} satisfies ProjectionFields;
const workerExpiryFields = {
  event: ["event", choice("worker.openshell-git-expiry")],
  ...workerObservationFields,
  outcome: ["outcome", choice("withdrawn", "pending", "retire-runtime")],
  check: ["check", expiryCheck],
} satisfies ProjectionFields;
const expiryFailure = choice(
  "unconfirmed",
  "admission_limit",
  "gateway_unavailable",
  "timeout",
  "failed",
  "launch_sandbox_missing",
  "launch_workload_unconfirmed",
  "launch_contract_mismatch",
  "launch_fingerprint_mismatch",
);
const expiryGrpcStatus = choice(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
const completionOutcome = choice("success", "pending", "retry", "permanent");
const unrecognized = "unrecognized" as const;
const cleanupCompletionCode = (value: unknown) => cleanupCode(value) ?? unrecognized;
const cleanupWarningCause = (value: unknown) => cleanupCause(value) ?? unrecognized;

function projectWorkerExpiry(value: Record<string, unknown>) {
  const observation = project(value, workerExpiryFields);
  if (observation === undefined) {
    return undefined;
  }
  let failure: ReturnType<typeof expiryFailure>;
  if (observation.outcome === "pending" || value.failure !== undefined) {
    failure = expiryFailure(value.failure);
    if (failure === undefined) {
      return undefined;
    }
  }
  let grpcStatus: ReturnType<typeof expiryGrpcStatus>;
  if (value.grpcStatus !== undefined) {
    grpcStatus = expiryGrpcStatus(value.grpcStatus);
    if (grpcStatus === undefined) {
      return undefined;
    }
  }
  return {
    ...observation,
    ...(failure === undefined ? {} : { failure }),
    ...(grpcStatus === undefined ? {} : { grpcStatus }),
  };
}

/** Select before buffering: worker records may contain unrelated private fields. */
export function projectOpenShellGitExpiryObservation(value: unknown) {
  if (!record(value)) {
    return undefined;
  }
  switch (value.event) {
    case "worker.openshell-git-expiry":
      return projectWorkerExpiry(value);
    case "worker.completed":
      return project(value, {
        event: ["event", choice("worker.completed")],
        ...workerObservationFields,
        outcome: ["outcome", completionOutcome],
        code: ["code", cleanupCompletionCode],
      });
    case "worker.repository-cleanup-warning":
      return project(value, {
        event: ["event", choice("worker.repository-cleanup-warning")],
        ...workerObservationFields,
        code: ["code", choice("REPOSITORY_CLEANUP_STALLED")],
        cause: ["cause", cleanupWarningCause],
      });
    default:
      return undefined;
  }
}

/** Classify only the selected runtime's denials; never retain arbitrary event fields. */
export function selectOpenShellGitWithdrawalDenials(
  events: Iterable<unknown, unknown, undefined>,
  { sandboxId, revisionId }: { sandboxId: string; revisionId: string },
) {
  const requestIds: string[] = [];
  const result = {
    requestIds,
    candidates: 0,
    rejectedCode: 0,
    rejectedReason: 0,
    rejectedOperation: 0,
    rejectedRequestId: 0,
  };
  for (const event of events) {
    if (
      !record(event) ||
      event.event !== "worker.openshell-git-denied" ||
      event.sandboxId !== sandboxId ||
      event.revisionId !== revisionId
    ) {
      continue;
    }
    result.candidates++;
    if (event.reasonCode !== "access_withdrawn") {
      result.rejectedCode++;
    } else if (
      event.reason !== "session_closed" &&
      event.reason !== "route_blocked" &&
      event.reason !== "material_unavailable"
    ) {
      result.rejectedReason++;
    } else if (
      event.reason === "session_closed"
        ? event.operation !== "advertise-upload-pack"
        : event.operation !== undefined
    ) {
      result.rejectedOperation++;
    } else if (typeof event.requestId !== "string" || event.requestId.length === 0) {
      result.rejectedRequestId++;
    } else {
      // Lookup-level withdrawal precedes operation selection, even in the original Worker.
      result.requestIds.push(event.requestId);
    }
  }
  return result;
}

const maintenanceOutcome = (value: unknown) => completionOutcome(value) ?? unrecognized;
const maintenanceCode = (value: unknown) =>
  cleanupCode(value) ?? readinessCode(value) ?? unrecognized;

/** Select matching maintenance completions before buffering their diagnostics. */
export function projectOpenShellGitMaintenanceCompletion(value: unknown) {
  if (!record(value)) {
    return undefined;
  }
  const completion = project(value, {
    outcome: ["outcome", maintenanceOutcome],
    code: ["code", maintenanceCode],
  });
  if (completion === undefined || value.failure === undefined) {
    return completion;
  }
  return {
    ...completion,
    failure: runtimeFailureCode(value.failure) ?? UNRECOGNIZED_RUNTIME_VALUE,
  };
}

const logCounts = {
  logReads: ["logReads", count],
  logReadSuccesses: ["logReadSuccesses", count],
  logReadFailures: ["logReadFailures", count],
  linesRead: ["linesRead", count],
  parsedEvents: ["parsedEvents", count],
  parseFailures: ["parseFailures", count],
  tailLimitReads: ["tailLimitReads", count],
} satisfies ProjectionFields;

export const maintenanceDiagnostics = {
  reason: [
    "reason",
    choice("permanent", "read-failure", "cancelled", "own-budget-exhausted", "unrecognized"),
  ],
  completionsTruncated: ["completionsTruncated", boolean],
  completions: [
    "completions",
    (value) => projectArray(value, projectOpenShellGitMaintenanceCompletion),
  ],
  ...logCounts,
} satisfies ProjectionFields;

export const expiryDiagnostics = {
  namespaceIdHash: ["namespaceId", identityHash],
  agentIdHash: ["agentId", identityHash],
  revisionIdHash: ["revisionId", identityHash],
  repositoryRefHash: ["repositoryRef", identityHash],
  lastWorkerUid: ["lastWorkerUid", (value) => (value === null ? null : uuid(value))],
  driverSuccessSeen: ["driverSuccessSeen", boolean],
  workerAcknowledgementSeen: ["workerAcknowledgementSeen", boolean],
  observationsTruncated: ["observationsTruncated", boolean],
  observations: [
    "observations",
    (value) => projectArray(value, projectOpenShellGitExpiryObservation),
  ],
  polls: ["polls", count],
  workerReadFailures: ["workerReadFailures", count],
  noReadyWorkerPolls: ["noReadyWorkerPolls", count],
  ...logCounts,
  workerChanges: ["workerChanges", count],
  matchingEventReads: ["matchingEventReads", count],
  rejectedEventReads: ["rejectedEventReads", count],
} satisfies ProjectionFields;
