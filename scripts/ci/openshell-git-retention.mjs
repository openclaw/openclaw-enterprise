import {
  boolean,
  choice,
  count,
  digest,
  expiryDiagnostics,
  hash,
  identityHash,
  imageDigest,
  integer,
  launch,
  maintenanceDiagnostics,
  project,
  record,
  runtime,
  stages,
  text,
  uuid,
} from "./openshell-git-worker-observations.ts";

export {
  projectOpenShellGitExpiryObservation,
  projectOpenShellGitMaintenanceCompletion,
  selectOpenShellGitWithdrawalDenials,
} from "./openshell-git-worker-observations.ts";

export const openShellGitRetentionKind = "openshell-git-retention";

const gitAclFailureCodes = new Set([
  "ACL_ALLOWED_CAPTURE",
  "ACL_CREDENTIAL_IN_ENVIRONMENT",
  "ACL_CREDENTIAL_IN_OUTPUT",
  "ACL_DENIAL_CAPTURE",
  "ACL_GIT_AUTHORITY_DENIAL",
  "ACL_HEAD_STATUS",
  "ACL_NATIVE_HTTP",
  "ACL_NATIVE_REST_DENIAL",
  "ACL_NATIVE_UNEXPECTED_SUCCESS",
  "ACL_PLACEHOLDER_ENVIRONMENT",
]);

/** @param {unknown} value */
export function projectOpenShellGitAclFailure(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (gitAclFailureCodes.has(value)) {
    return value;
  }
  const variant =
    /^ACL_VARIANT_(?:PROCESS|OUTPUT_LIMIT|STDERR|HTTP_[1-5][0-9]{2}|CURL_EXIT_[1-9][0-9]{0,2})$/u.exec(
      value,
    );
  return variant?.[0] === value ? value : undefined;
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
  "finite-git-initialization-failed": {
    stage: ["stage", choice("deployment-observation", "runtime-identity-read", "runtime-receipt")],
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
  if (
    selected !== undefined &&
    value.event === "managed-workload-exec-result" &&
    value.failure !== undefined
  ) {
    const failure = projectOpenShellGitAclFailure(value.failure);
    if (failure === undefined || value.outcome !== "terminal-exit" || value.exitCode === 0) {
      return undefined;
    }
    return { kind: openShellGitRetentionKind, event: value.event, ...selected, failure };
  }
  return selected === undefined
    ? undefined
    : { kind: openShellGitRetentionKind, event: value.event, ...selected };
}
