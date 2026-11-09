import { createHash } from "node:crypto";
import {
  RUNTIME_DIAGNOSTIC_CODES,
  UNRECOGNIZED_RUNTIME_VALUE,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
} from "../../packages/contracts/src/runtime-failure.mjs";

export const openShellGitRetentionKind = "openshell-git-retention";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (pattern) => (value) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;
const uuid = text(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = text(/^sha256:[a-f0-9]{64}$/);
const hash = text(/^[a-f0-9]{64}$/);
const timestamp = text(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const integer = (maximum) => (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
const count = integer(Number.MAX_SAFE_INTEGER);
const choice =
  (...values) =>
  (value) =>
    values.includes(value) ? value : undefined;
const imageDigest = (value) =>
  typeof value === "string" && value.length <= 1024
    ? digest(value.match(/(?:^|[@/])(sha256:[a-f0-9]{64})$/)?.[1])
    : undefined;
// Supplier IDs and work IDs have no shared UUID contract. Correlate their exact
// bytes without accepting arbitrary upstream text into a public CI artifact.
const identityHash = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 1024
    ? createHash("sha256").update(value).digest("hex")
    : undefined;

function project(value, fields) {
  if (!record(value)) {
    return undefined;
  }
  const result = {};
  for (const [target, [source, read]] of Object.entries(fields)) {
    const selected = read(value[source]);
    if (selected === undefined) {
      return undefined;
    }
    result[target] = selected;
  }
  return result;
}

const runtime = {
  revisionIdHash: ["revisionId", identityHash],
  sandboxIdHash: ["sandboxId", identityHash],
  sandboxUid: ["sandboxUid", uuid],
  podUid: ["podUid", uuid],
  mainProcessInstanceIdHash: ["mainProcessInstanceId", identityHash],
  mainProcessStartedAt: ["mainProcessStartedAt", timestamp],
  containers: [
    "containers",
    (value) => {
      if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
        return undefined;
      }
      const containers = value.map((container) =>
        project(container, {
          nameHash: ["name", identityHash],
          idHash: ["id", identityHash],
          imageDigest: ["imageId", imageDigest],
          startedAt: ["startedAt", timestamp],
          restartCount: ["restartCount", count],
        }),
      );
      return containers.every((container) => container !== undefined) ? containers : undefined;
    },
  ],
};
const launch = {
  workspaceHash: ["workspace", identityHash],
  sandboxIdHash: ["sandboxId", identityHash],
  requestId: ["requestId", uuid],
  executionSeconds: ["executionSeconds", integer(3600)],
  observerMs: ["observerMs", integer(3_600_000)],
};
const stages = choice("before-expiry", "after-expiry", "after-worker-restart");
const boolean = (value) => (typeof value === "boolean" ? value : undefined);
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

/** Select before buffering: worker records may contain unrelated private fields. */
export function projectOpenShellGitExpiryObservation(value) {
  if (!record(value)) {
    return undefined;
  }
  const fields = {
    event: [
      "event",
      choice(
        "worker.openshell-git-expiry",
        "worker.completed",
        "worker.repository-cleanup-warning",
      ),
    ],
    workerUid: ["workerUid", uuid],
    namespaceMatches: ["namespaceMatches", boolean],
    repository: ["repository", choice("match", "mismatch", "absent")],
  };
  switch (value.event) {
    case "worker.openshell-git-expiry":
      fields.outcome = ["outcome", choice("withdrawn", "pending", "retire-runtime")];
      fields.check = ["check", expiryCheck];
      if (value.outcome === "pending" || value.failure !== undefined) {
        fields.failure = [
          "failure",
          choice("unconfirmed", "admission_limit", "gateway_unavailable", "timeout", "failed"),
        ];
      }
      if (value.grpcStatus !== undefined) {
        fields.grpcStatus = [
          "grpcStatus",
          choice(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
        ];
      }
      break;
    case "worker.completed":
      fields.outcome = ["outcome", choice("success", "pending", "retry", "permanent")];
      fields.code = ["code", (code) => cleanupCode(code) ?? "unrecognized"];
      break;
    case "worker.repository-cleanup-warning":
      fields.code = ["code", choice("REPOSITORY_CLEANUP_STALLED")];
      fields.cause = ["cause", (cause) => cleanupCause(cause) ?? "unrecognized"];
      break;
    default:
      return undefined;
  }
  return project(value, fields);
}

/** Classify only the selected runtime's denials; never retain arbitrary event fields. */
export function selectOpenShellGitWithdrawalDenials(events, { sandboxId, revisionId }) {
  const result = {
    requestIds: [],
    candidates: 0,
    rejectedCode: 0,
    rejectedReason: 0,
    rejectedOperation: 0,
    rejectedRequestId: 0,
  };
  for (const event of events) {
    if (
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
      !["session_closed", "route_blocked", "material_unavailable"].includes(event.reason)
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

/** Select matching maintenance completions before buffering their diagnostics. */
export function projectOpenShellGitMaintenanceCompletion(value) {
  const completion = project(value, {
    outcome: [
      "outcome",
      (outcome) => choice("success", "pending", "retry", "permanent")(outcome) ?? "unrecognized",
    ],
    code: ["code", (code) => cleanupCode(code) ?? readinessCode(code) ?? "unrecognized"],
  });
  if (completion && value.failure !== undefined) {
    completion.failure = runtimeFailureCode(value.failure) ?? UNRECOGNIZED_RUNTIME_VALUE;
  }
  return completion;
}

const maintenanceDiagnostics = {
  reason: [
    "reason",
    choice("permanent", "read-failure", "cancelled", "own-budget-exhausted", "unrecognized"),
  ],
  completionsTruncated: ["completionsTruncated", boolean],
  completions: [
    "completions",
    (value) => {
      if (!Array.isArray(value) || value.length > 16) {
        return undefined;
      }
      const selected = value.map(projectOpenShellGitMaintenanceCompletion);
      return selected.every((item) => item !== undefined) ? selected : undefined;
    },
  ],
};
for (const name of [
  "logReads",
  "logReadSuccesses",
  "logReadFailures",
  "linesRead",
  "parsedEvents",
  "parseFailures",
  "tailLimitReads",
]) {
  maintenanceDiagnostics[name] = [name, count];
}

const expiryDiagnostics = {
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
    (value) => {
      if (!Array.isArray(value) || value.length > 16) {
        return undefined;
      }
      const selected = value.map(projectOpenShellGitExpiryObservation);
      return selected.every((item) => item !== undefined) ? selected : undefined;
    },
  ],
};
for (const name of [
  "polls",
  "workerReadFailures",
  "noReadyWorkerPolls",
  "logReads",
  "logReadSuccesses",
  "logReadFailures",
  "linesRead",
  "parsedEvents",
  "parseFailures",
  "tailLimitReads",
  "workerChanges",
  "matchingEventReads",
  "rejectedEventReads",
]) {
  expiryDiagnostics[name] = [name, count];
}
const withdrawalDiagnostics = {
  mode: ["mode", choice("live", "replacement")],
  workerReady: ["workerReady", boolean],
  workerComparison: ["workerComparison", choice("unchecked", "same", "different")],
};
for (const name of [
  "logReads",
  "logReadSuccesses",
  "logReadFailures",
  "linesRead",
  "parsedEvents",
  "parseFailures",
  "tailLimitReads",
  "candidates",
  "rejectedCode",
  "rejectedReason",
  "rejectedOperation",
  "rejectedRequestId",
  "freshRequests",
]) {
  withdrawalDiagnostics[name] = [name, count];
}
const events = {
  "withdrawal-decision-unconfirmed": withdrawalDiagnostics,
  "finite-removal-live-denial": {
    boundary: ["boundary", choice("signed-access-withdrawn", "supervisor-policy")],
    signer: ["signer", choice("exercised", "unexercised")],
    requestIdHash: ["requestId", (value) => (value === null ? null : identityHash(value))],
    workerUid: ["workerUid", uuid],
  },
  "finite-removal-reduced": {
    revisionIdHash: ["revisionId", identityHash],
    workIdHash: ["workId", identityHash],
    workerUid: ["workerUid", uuid],
    code: ["code", choice("REPOSITORY_ACCESS_WITHDRAWN")],
    sessionIdHash: ["sessionId", identityHash],
    processInstanceIdHash: ["processInstanceId", identityHash],
    networkInstanceIdHash: ["networkInstanceId", identityHash],
    attachmentEpochHash: ["attachmentEpoch", identityHash],
    providerEnvRevision: ["providerEnvRevision", text(/^[1-9][0-9]{0,29}$/)],
    configRevision: ["configRevision", text(/^[1-9][0-9]{0,29}$/)],
    policyHash: ["policyHash", hash],
  },
  "finite-removal-conversation": {
    stage: ["stage", choice("before-removal", "after-replacement")],
    revisionIdHash: ["revisionId", identityHash],
    sessionIdHash: ["sessionId", identityHash],
    threadIdHash: ["threadId", identityHash],
    userSeq: ["userSeq", count],
    assistantSeq: ["assistantSeq", count],
  },
  "finite-removal-retired": {
    revisionIdHash: ["revisionId", identityHash],
    cause: ["cause", choice("required-model-withdrawn")],
    deadlineWallMs: ["deadlineWallMs", count],
    observedAt: ["observedAt", count],
    activeRevisionCleared: ["activeRevisionCleared", choice(true)],
    sandboxAbsent: ["sandboxAbsent", choice(true)],
    agentPodsAbsent: ["agentPodsAbsent", choice(true)],
  },
  "withdrawal-origin-witness": {
    stage: [
      "stage",
      choice(
        "live witness before denial",
        "live witness after denial",
        "replacement witness before denial",
        "replacement witness after denial",
      ),
    ],
    outcome: ["outcome", choice("unconfirmed", "accepted", "refused")],
    status: ["status", choice(null, 200, 401, 403)],
    targetedRetirementRefusals: ["targetedRetirementRefusals", count],
  },
  "withdrawal-retirement-refused": {
    outcome: ["outcome", choice("passed")],
    status: ["status", choice(503)],
    targetedRetirementRefusals: ["targetedRetirementRefusals", choice(1)],
  },
  "git-policy-denied": {
    stage: ["stage", choice("after-expiry", "after-worker-restart", "after-removal")],
    reason: ["reason", choice("transparent_tcp_policy_denied")],
    policyReason: ["policyReason", choice("endpoint-not-admitted")],
    marker: ["marker", choice("policy-dns-ineligible")],
    host: ["host", choice("github.com")],
    port: ["port", choice(443)],
    executable: [
      "executable",
      choice(
        "/usr/lib/git-core/git-remote-https",
        "/usr/lib/git-core/git-remote-http",
        "/usr/libexec/git-core/git-remote-https",
        "/usr/libexec/git-core/git-remote-http",
      ),
    ],
    count: [
      "count",
      (value) => (Number.isSafeInteger(value) && value > 0 && value <= 2000 ? value : undefined),
    ],
    startedAt: ["startedAt", count],
    endedAt: ["endedAt", count],
  },
  "retained-execution-failed": {
    stage: ["stage", choice("after-expiry", "after-worker-restart")],
    connectionsBefore: ["connectionsBefore", count],
    connectionsAfter: ["connectionsAfter", count],
    requestsBefore: ["requestsBefore", count],
    requestsAfter: ["requestsAfter", count],
    originUnchanged: ["originUnchanged", boolean],
  },
  "git-expiry-unconfirmed": expiryDiagnostics,
  "supervisor-trust": {
    parentDigest: ["parent", imageDigest],
    imageDigest: ["reference", imageDigest],
    binaryHash: ["binaryHash", hash],
    configDigest: ["configDigest", digest],
  },
  "finite-git-grant": {
    revisionIdHash: ["revisionId", identityHash],
    deadlineWallMs: ["deadlineWallMs", count],
  },
  "initial-runtime": runtime,
  "installed-supervisor": {
    sandboxIdHash: ["sandboxId", identityHash],
    workloadPodUid: ["workloadPodUid", uuid],
    supervisorPodUid: ["supervisorPodUid", uuid],
    imageDigest: ["image", imageDigest],
    runningImageDigest: ["imageId", imageDigest],
    containerIdHash: ["containerId", identityHash],
    binaryHash: ["binaryHash", hash],
  },
  "model-turn-succeeded": {
    stage: ["stage", stages],
    nonce: [
      "nonce",
      text(/^FIRST_AGENT_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    ],
  },
  "initial-git-succeeded": {
    revisionIdHash: ["revisionId", identityHash],
    sha: ["sha", text(/^[a-f0-9]{40}$/)],
    connections: ["connections", count],
    requests: ["requests", count],
  },
  "git-expiry-observed": {
    deadlineWallMs: ["deadlineWallMs", count],
    workIdHash: ["workId", identityHash],
    code: ["code", choice("REPOSITORY_ACCESS_WITHDRAWN")],
    workerUid: ["workerUid", uuid],
    expiry: [
      "expiry",
      (value) =>
        project(value, {
          event: ["event", choice("worker.openshell-git-expiry")],
          namespaceIdHash: ["namespaceId", identityHash],
          agentIdHash: ["agentId", identityHash],
          revisionIdHash: ["revisionId", identityHash],
          repositoryRefHash: ["repositoryRef", identityHash],
          outcome: ["outcome", choice("withdrawn")],
          check: ["check", choice("record-reduced-generation")],
        }),
    ],
  },
  "worker-maintenance-unconfirmed": maintenanceDiagnostics,
  "worker-restart-unconfirmed": {
    stage: [
      "stage",
      choice(
        "controller-image",
        "ready-worker",
        "before-worker-image",
        "durable-before",
        "rollout-restart",
        "rollout-ready",
        "replacement-worker",
        "after-worker-image",
        "revision-maintenance",
        "durable-after",
        "durable-retention-assertion",
      ),
    ],
  },
  "worker-restarted": {
    beforeUid: ["beforeUid", uuid],
    afterUid: ["afterUid", uuid],
    controllerImageDigest: ["controllerImageDigest", digest],
    controllerConfigDigest: ["controllerConfigDigest", digest],
    beforeImageDigest: ["beforeImageDigest", digest],
    afterImageDigest: ["afterImageDigest", digest],
    databaseUid: ["databaseUid", uuid],
    custodyUid: ["custodyUid", uuid],
    custodyVersion: ["custodyVersion", text(/^[0-9]{1,30}$/)],
  },
  "managed-workload-exec-dispatch-unknown": launch,
  "managed-workload-exec-unconfirmed": {
    ...launch,
    grpcStatus: ["grpcStatus", (value) => (value === "unknown" ? value : integer(16)(value))],
    reason: ["reason", choice("invalid-terminal-stream", "stream-failure")],
  },
  "managed-workload-exec-result": {
    ...launch,
    outcome: ["outcome", choice("timeout-unconfirmed", "terminal-exit")],
    exitCode: ["exitCode", integer(255)],
    grpcStatus: ["grpcStatus", integer(16)],
    stdoutBytes: ["stdoutBytes", integer(2 * 1024 * 1024)],
    stderrBytes: ["stderrBytes", integer(2 * 1024 * 1024)],
  },
  cleanup: { outcome: ["outcome", choice("passed")] },
};
for (const stage of ["after-expiry", "after-worker-restart"]) {
  events[stage] = {
    ...runtime,
    nonGit: ["nonGit", choice("succeeded")],
    freshGit: ["freshGit", choice("transparent-policy-denied")],
    connections: ["connections", count],
    requests: ["requests", count],
  };
}

/** Closed receipt projection; unknown fields, command output and credentials never pass through. */
export function projectOpenShellGitRetention(value) {
  if (
    !record(value) ||
    value.kind !== openShellGitRetentionKind ||
    typeof value.event !== "string" ||
    !Object.hasOwn(events, value.event)
  ) {
    return undefined;
  }
  const selected = project(value, events[value.event]);
  if (
    selected !== undefined &&
    value.event === "withdrawal-origin-witness" &&
    !(
      (selected.outcome === "accepted" && selected.status === 200) ||
      (selected.outcome === "refused" && [401, 403].includes(selected.status)) ||
      (selected.outcome === "unconfirmed" && selected.status === null)
    )
  ) {
    return undefined;
  }
  if (selected !== undefined) {
    if (
      value.event === "finite-removal-live-denial" &&
      !(
        (selected.boundary === "signed-access-withdrawn" &&
          selected.signer === "exercised" &&
          selected.requestIdHash !== null) ||
        (selected.boundary === "supervisor-policy" &&
          selected.signer === "unexercised" &&
          selected.requestIdHash === null)
      )
    ) {
      return undefined;
    }
    if (
      value.event === "finite-removal-conversation" &&
      selected.assistantSeq <= selected.userSeq
    ) {
      return undefined;
    }
    if (
      value.event === "finite-removal-retired" &&
      selected.observedAt >= selected.deadlineWallMs
    ) {
      return undefined;
    }
  }
  return selected === undefined
    ? undefined
    : { kind: openShellGitRetentionKind, event: value.event, ...selected };
}
