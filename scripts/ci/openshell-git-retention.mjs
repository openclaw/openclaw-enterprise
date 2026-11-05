import { createHash } from "node:crypto";

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
      if (value.outcome === "pending") {
        fields.failure = [
          "failure",
          choice("unconfirmed", "admission_limit", "gateway_unavailable", "timeout", "failed"),
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
const events = {
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
  "worker-restarted": {
    beforeUid: ["beforeUid", uuid],
    afterUid: ["afterUid", uuid],
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
    freshGit: ["freshGit", choice("http-403")],
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
  return selected === undefined
    ? undefined
    : { kind: openShellGitRetentionKind, event: value.event, ...selected };
}
