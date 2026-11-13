import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  createRunnerFixture,
  currentSha,
  laneArgs,
  runRunnerSync,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

const retentionKind = "openshell-git-retention";

type RetentionReceipt = Record<string, unknown> & { event: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMeasurementResult(resultsPath: string) {
  const artifact = await readFile(resultsPath, "utf8");
  const summary: unknown = JSON.parse(artifact);
  assert.ok(isJsonObject(summary) && Array.isArray(summary.files), "Expected result files");
  const files: unknown[] = summary.files;
  const [file] = files;
  assert.ok(isJsonObject(file) && Array.isArray(file.measurements), "Expected file measurements");
  const rows: unknown[] = file.measurements;
  const measurements = rows.map((row) => {
    assert.ok(isJsonObject(row) && typeof row.kind === "string", "Expected a measurement kind");
    return row;
  });
  const receipts = measurements.filter((row): row is RetentionReceipt => {
    if (row.kind !== retentionKind) {
      return false;
    }
    assert.ok(typeof row.event === "string", "Expected a Git retention event");
    return true;
  });
  return { artifact, summary, file, measurements, receipts };
}

export async function checkAllowlistedMeasurements(t: TestContext) {
  const root = await createRunnerFixture(t);
  const resultsPath = join(root, "results/measurements.json");
  const measurement = (value: unknown) => `openclaw-ci-measurement ${JSON.stringify(value)}`;
  const measurements = (kind: string, samples: readonly Record<string, unknown>[]) =>
    samples.map((sample) => measurement({ kind, ...sample }));
  const openshellPhase = {
    kind: "openshell-sandbox-phase",
    stage: "exposure-auth",
    outcome: "passed",
    elapsedMs: 39_000,
  };
  // These receipts travel through the real reporter and runner into the uploaded
  // result, including after a later failure. Unknown text must never reach a tail.
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const sha256 = "a".repeat(64);
  const opaque = "supplier-instance-123";
  const opaqueHash = createHash("sha256").update(opaque).digest("hex");
  const time = "2026-11-05T12:00:00.123456789Z";
  const forbidden = "unregistered-retention-private-text";
  const runtimeReceipt = {
    revisionId: opaque,
    sandboxId: opaque,
    sandboxUid: uuid,
    podUid: uuid,
    mainProcessInstanceId: opaque,
    mainProcessStartedAt: time,
    containers: [
      {
        name: opaque,
        id: opaque,
        imageId: `containerd://sha256:${sha256}`,
        startedAt: time,
        restartCount: 0,
        output: forbidden,
      },
    ],
    credential: forbidden,
  };
  const launchReceipt = {
    workspace: opaque,
    sandboxId: opaque,
    requestId: uuid,
    executionSeconds: 120,
    observerMs: 180_000,
  };
  const expiryObservation = {
    event: "worker.openshell-git-expiry",
    workerUid: uuid,
    namespaceMatches: true,
    repository: "match",
    outcome: "pending",
    check: "retained-provider-profiles",
    failure: "gateway_unavailable",
    rawLog: forbidden,
  };
  const expiryDiagnostic = {
    event: "git-expiry-unconfirmed",
    namespaceId: opaque,
    agentId: opaque,
    revisionId: opaque,
    repositoryRef: opaque,
    lastWorkerUid: uuid,
    polls: 4,
    workerReadFailures: 0,
    noReadyWorkerPolls: 1,
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2005,
    parsedEvents: 2002,
    parseFailures: 3,
    tailLimitReads: 1,
    workerChanges: 1,
    matchingEventReads: 5,
    rejectedEventReads: 1,
    driverSuccessSeen: true,
    workerAcknowledgementSeen: false,
    observationsTruncated: true,
    observations: [
      expiryObservation,
      {
        ...expiryObservation,
        namespaceMatches: false,
        repository: "mismatch",
        outcome: "retire-runtime",
        failure: "failed",
        grpcStatus: 10,
      },
      {
        ...expiryObservation,
        outcome: "withdrawn",
        check: "record-reduced-generation",
      },
      {
        event: "worker.completed",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        outcome: "success",
        code: "REPOSITORY_RUNTIME_RETIREMENT_QUEUED",
        error: forbidden,
      },
      {
        event: "worker.completed",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        outcome: "pending",
        code: forbidden,
      },
      {
        event: "worker.repository-cleanup-warning",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        code: "REPOSITORY_CLEANUP_STALLED",
        cause: forbidden,
      },
    ],
  };
  // The live observer uses this same projection before retaining or emitting a
  // record. Malicious fields must disappear there, not just in the reporter.
  const { projectOpenShellGitExpiryObservation, projectOpenShellGitMaintenanceCompletion } =
    await import("../../scripts/ci/openshell-git-retention.mjs");
  assert.deepEqual(
    projectOpenShellGitMaintenanceCompletion({
      outcome: forbidden,
      code: forbidden,
      failure: forbidden,
      error: forbidden,
    }),
    { outcome: "unrecognized", code: "unrecognized", failure: "UNRECOGNIZED" },
  );
  const captured = expiryDiagnostic.observations.map(projectOpenShellGitExpiryObservation);
  assert.ok(!JSON.stringify(captured).includes(forbidden));
  assert.ok(
    captured[1] && "failure" in captured[1] && "grpcStatus" in captured[1],
    "Expected a projected expiry failure",
  );
  assert.equal(captured[1].failure, "failed");
  assert.equal(captured[1].grpcStatus, 10);
  for (const failure of [
    "launch_sandbox_missing",
    "launch_workload_unconfirmed",
    "launch_contract_mismatch",
    "launch_fingerprint_mismatch",
  ]) {
    const projected = projectOpenShellGitExpiryObservation({
      ...expiryObservation,
      outcome: "retire-runtime",
      check: "original-launch-and-pods",
      failure,
    });
    assert.ok(projected && "failure" in projected, "Expected a failure projection");
    assert.equal(projected.failure, failure);
  }
  for (const grpcStatus of [-1, 0, 17, 1.5, "10", forbidden]) {
    assert.equal(
      projectOpenShellGitExpiryObservation({ ...expiryObservation, grpcStatus }),
      undefined,
    );
  }
  assert.ok(captured[4] && "code" in captured[4], "Expected a projected expiry code");
  assert.equal(captured[4].code, "unrecognized");
  assert.ok(captured[5] && "cause" in captured[5], "Expected a projected expiry cause");
  assert.equal(captured[5].cause, "unrecognized");
  for (const field of [
    "outcome",
    "check",
    "failure",
    "workerUid",
    "namespaceMatches",
    "repository",
  ]) {
    assert.equal(
      projectOpenShellGitExpiryObservation({ ...expiryObservation, [field]: forbidden }),
      undefined,
    );
  }
  const retainedFailures = ["after-expiry", "after-worker-restart"].map((stage, index) => ({
    event: "retained-execution-failed",
    stage,
    connectionsBefore: 2,
    connectionsAfter: 2 + index,
    requestsBefore: 1,
    requestsAfter: 1 + index,
    originUnchanged: index === 0,
  }));
  const withdrawalWitnesses = (
    [
      ["live witness before denial", "accepted", 200],
      ["live witness after denial", "refused", 401],
      ["replacement witness before denial", "refused", 403],
      ["replacement witness after denial", "unconfirmed", null],
    ] as const
  ).map(([stage, outcome, status], index) => ({
    event: "withdrawal-origin-witness",
    stage,
    outcome,
    status,
    targetedRetirementRefusals: index,
  }));
  const withdrawalDecision = {
    event: "withdrawal-decision-unconfirmed",
    mode: "live",
    workerReady: true,
    workerComparison: "unchecked",
    freshRequests: 2,
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2004,
    parsedEvents: 2000,
    parseFailures: 4,
    tailLimitReads: 1,
    candidates: 5,
    rejectedCode: 1,
    rejectedReason: 1,
    rejectedOperation: 1,
    rejectedRequestId: 0,
  };
  const withdrawalRetirement = {
    event: "withdrawal-retirement-refused",
    outcome: "passed",
    status: 503,
    targetedRetirementRefusals: 1,
  };
  const policyDenials = ["after-expiry", "after-worker-restart", "after-removal"].map((stage) => ({
    event: "git-policy-denied",
    stage,
    reason: "transparent_tcp_policy_denied",
    policyReason: "endpoint-not-admitted",
    marker: "policy-dns-ineligible",
    host: "github.com",
    port: 443,
    executable: "/usr/lib/git-core/git-remote-http",
    count: 1,
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_001_000,
  }));
  const maintenanceDiagnostic = {
    event: "worker-maintenance-unconfirmed",
    reason: "own-budget-exhausted",
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2004,
    parsedEvents: 2000,
    parseFailures: 4,
    tailLimitReads: 1,
    completionsTruncated: false,
    completions: [
      { outcome: "pending", code: "REPOSITORY_CLEANUP_PENDING", error: forbidden },
      { outcome: "retry", code: forbidden, failure: forbidden },
      { outcome: "permanent", code: "REPOSITORY_ACCESS_WITHDRAWN" },
      // Ordinary revision readiness must remain distinguishable from Git cleanup.
      { outcome: "pending", code: "REPOSITORY_GIT_ROUTE_PENDING" },
      { outcome: "pending", code: "REPOSITORY_GIT_MATERIAL_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_BINDING_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_RECONNECT_PENDING" },
      { outcome: "pending", code: "WORKSPACE_SETUP_RETRYING" },
      // Keep the optional runtime failure separate from the maintenance wait code.
      {
        outcome: "pending",
        code: "REVISION_INCOMPLETE",
        failure: "REPOSITORY_ROUTE_BLOCKED",
      },
      {
        outcome: "pending",
        code: "REVISION_FINALIZATION_INCOMPLETE",
        failure: "MODEL_PROBE_FAILED",
      },
      {
        outcome: "pending",
        code: `REPOSITORY_GIT_ROUTE_PENDING_${forbidden}`,
        failure: { code: "REPOSITORY_ROUTE_BLOCKED", message: forbidden },
      },
    ],
    error: forbidden,
  };
  const maintenanceReasons = [
    "permanent",
    "read-failure",
    "cancelled",
    "own-budget-exhausted",
    "unrecognized",
  ];
  const restartStages = [
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
  ];
  const finiteRemoval = [
    {
      event: "finite-removal-live-denial",
      boundary: "signed-access-withdrawn",
      signer: "exercised",
      requestId: opaque,
      workerUid: uuid,
    },
    {
      event: "finite-removal-live-denial",
      boundary: "supervisor-policy",
      signer: "unexercised",
      requestId: null,
      workerUid: uuid,
    },
    {
      event: "finite-removal-reduced",
      revisionId: opaque,
      workId: opaque,
      workerUid: uuid,
      code: "REPOSITORY_ACCESS_WITHDRAWN",
      sessionId: opaque,
      processInstanceId: opaque,
      networkInstanceId: opaque,
      attachmentEpoch: opaque,
      providerEnvRevision: "3",
      configRevision: "4",
      policyHash: sha256,
    },
    {
      event: "finite-removal-conversation",
      stage: "after-replacement",
      revisionId: opaque,
      sessionId: opaque,
      threadId: opaque,
      userSeq: 10,
      assistantSeq: 11,
    },
    {
      event: "finite-removal-retired",
      revisionId: opaque,
      cause: "required-model-withdrawn",
      deadlineWallMs: 1800000000000,
      observedAt: 1799999999000,
      activeRevisionCleared: true,
      sandboxAbsent: true,
      agentPodsAbsent: true,
    },
  ];
  const workerRestart = {
    event: "worker-restarted",
    beforeUid: "12345678-1234-1234-1234-123456789001",
    afterUid: "12345678-1234-1234-1234-123456789002",
    controllerImageDigest: `sha256:${sha256}`,
    controllerConfigDigest: `sha256:${"b".repeat(64)}`,
    beforeImageDigest: `sha256:${"b".repeat(64)}`,
    afterImageDigest: `sha256:${sha256}`,
    databaseUid: "12345678-1234-1234-1234-123456789003",
    custodyUid: "12345678-1234-1234-1234-123456789004",
    custodyVersion: "234",
  };
  const retentionReceipts = [
    ...finiteRemoval.map((receipt) => ({ ...receipt, credential: forbidden, output: forbidden })),
    ...withdrawalWitnesses.map((receipt) => ({ ...receipt, error: forbidden, token: forbidden })),
    { ...withdrawalRetirement, token: forbidden },
    ...["unchecked", "same", "different"].map((workerComparison) => ({
      ...withdrawalDecision,
      workerComparison,
      requestIds: [forbidden],
      error: forbidden,
    })),
    ...maintenanceReasons.map((reason) => ({ ...maintenanceDiagnostic, reason })),
    ...restartStages.map((stage) => ({
      event: "worker-restart-unconfirmed",
      stage,
      error: forbidden,
    })),
    ...policyDenials.map((receipt) => ({ ...receipt, message: forbidden, credential: forbidden })),
    ...retainedFailures.map((receipt) => ({
      ...receipt,
      credential: forbidden,
      stdout: forbidden,
      stderr: forbidden,
    })),
    expiryDiagnostic,
    {
      event: "supervisor-trust",
      parent: `ghcr.io/example/stock@sha256:${sha256}`,
      reference: `docker.io/library/test@sha256:${sha256}`,
      binaryHash: sha256,
      configDigest: `sha256:${sha256}`,
    },
    { event: "finite-git-grant", revisionId: opaque, deadlineWallMs: 1_800_000_000_000 },
    { event: "initial-runtime", ...runtimeReceipt },
    {
      event: "installed-supervisor",
      sandboxId: opaque,
      workloadPodUid: uuid,
      supervisorPodUid: uuid,
      image: `docker.io/library/test@sha256:${sha256}`,
      imageId: `containerd://sha256:${sha256}`,
      containerId: opaque,
      binaryHash: sha256,
    },
    ...["before-expiry", "after-expiry", "after-worker-restart"].map((stage) => ({
      event: "model-turn-succeeded",
      stage,
      nonce: `FIRST_AGENT_${uuid}`,
    })),
    {
      event: "initial-git-succeeded",
      revisionId: opaque,
      sha: "b".repeat(40),
      connections: 2,
      requests: 1,
    },
    {
      event: "git-expiry-observed",
      deadlineWallMs: 1_800_000_000_000,
      workId: opaque,
      code: "REPOSITORY_ACCESS_WITHDRAWN",
      workerUid: uuid,
      expiry: {
        event: "worker.openshell-git-expiry",
        namespaceId: opaque,
        agentId: opaque,
        revisionId: opaque,
        repositoryRef: opaque,
        outcome: "withdrawn",
        check: "record-reduced-generation",
        output: forbidden,
      },
    },
    workerRestart,
    ...["after-expiry", "after-worker-restart"].map((event) => ({
      event,
      ...runtimeReceipt,
      nonGit: "succeeded",
      freshGit: "transparent-policy-denied",
      connections: 2,
      requests: 1,
    })),
    { event: "managed-workload-exec-dispatch-unknown", ...launchReceipt },
    {
      event: "managed-workload-exec-result",
      ...launchReceipt,
      outcome: "terminal-exit",
      exitCode: 0,
      grpcStatus: 0,
      stdoutBytes: 12,
      stderrBytes: 0,
    },
    {
      event: "managed-workload-exec-unconfirmed",
      ...launchReceipt,
      grpcStatus: "unknown",
      reason: "stream-failure",
    },
    { event: "cleanup", outcome: "passed" },
  ].map((value) => ({ kind: retentionKind, ...value, unexpected: forbidden }));
  const invalidRetention = [
    ...[
      "controllerImageDigest",
      "controllerConfigDigest",
      "beforeImageDigest",
      "afterImageDigest",
    ].flatMap((field) =>
      [forbidden, undefined].map((value) => ({
        ...workerRestart,
        [field]: value,
        unexpected: forbidden,
      })),
    ),
    { ...finiteRemoval[0], signer: "unexercised" },
    { ...finiteRemoval[0], requestId: null },
    { ...finiteRemoval[1], requestId: opaque },
    { ...finiteRemoval[2], code: "REPOSITORY_RUNTIME_RETIREMENT_QUEUED" },
    { ...finiteRemoval[2], policyHash: forbidden },
    { ...finiteRemoval[3], assistantSeq: 10 },
    { ...finiteRemoval[4], observedAt: 1800000000000 },
    { ...finiteRemoval[4], sandboxAbsent: false },
    ...["stage", "outcome", "status", "targetedRetirementRefusals"].map((field) => ({
      ...withdrawalWitnesses[0],
      [field]: forbidden,
    })),
    { ...withdrawalWitnesses[0], targetedRetirementRefusals: -1 },
    ...(
      [
        ["accepted", 401],
        ["accepted", 403],
        ["accepted", null],
        ["refused", 200],
        ["refused", null],
        ["unconfirmed", 200],
        ["unconfirmed", 401],
        ["unconfirmed", 403],
      ] as const
    ).map(([outcome, status]) => ({ ...withdrawalWitnesses[0], outcome, status })),
    { ...withdrawalRetirement, status: 204 },
    { ...withdrawalDecision, mode: forbidden },
    { ...withdrawalDecision, freshRequests: -1 },
    { ...withdrawalDecision, workerComparison: forbidden },
    { ...withdrawalDecision, workerComparison: true },
    ...[0, 2].map((targetedRetirementRefusals) => ({
      ...withdrawalRetirement,
      targetedRetirementRefusals,
    })),
    { ...withdrawalRetirement, outcome: forbidden },
    { ...withdrawalRetirement, targetedRetirementRefusals: forbidden },
    ...(
      [
        ["stage", "before-expiry"],
        ["reason", "transparent_tcp_identity_unavailable"],
        ["policyReason", forbidden],
        ["marker", forbidden],
        ["host", forbidden],
        ["port", 80],
        ["executable", forbidden],
        ["count", 0],
        ["count", 2001],
        ["count", { toString: 0, credential: forbidden }],
        ["startedAt", forbidden],
        ["endedAt", -1],
      ] satisfies readonly (readonly [field: string, value: unknown])[]
    ).map(([field, value]) => ({ ...policyDenials[0], [field]: value })),
    ...(
      [
        ["stage", "before-expiry"],
        ["stage", forbidden],
        ["connectionsBefore", forbidden],
        ["connectionsAfter", -1],
        ["requestsBefore", 0.5],
        ["requestsAfter", Number.MAX_SAFE_INTEGER + 1],
        ["originUnchanged", forbidden],
      ] satisfies readonly (readonly [field: string, value: unknown])[]
    ).map(([field, value]) => ({ ...retainedFailures[0], [field]: value })),
    { ...expiryDiagnostic, polls: -1 },
    { ...expiryDiagnostic, logReadSuccesses: 0.5 },
    { ...expiryDiagnostic, driverSuccessSeen: forbidden },
    { ...expiryDiagnostic, lastWorkerUid: forbidden },
    { ...expiryDiagnostic, observations: Array(17).fill(expiryObservation) },
    {
      ...expiryDiagnostic,
      observations: [{ ...expiryObservation, check: forbidden }],
    },
    {
      ...expiryDiagnostic,
      observations: [{ ...expiryObservation, failure: forbidden }],
    },
    { event: forbidden },
    { event: "initial-runtime", ...runtimeReceipt, podUid: forbidden },
    {
      event: "initial-runtime",
      ...runtimeReceipt,
      containers: [{ ...runtimeReceipt.containers[0], imageId: forbidden }],
    },
    {
      event: "initial-runtime",
      ...runtimeReceipt,
      containers: Array(17).fill(runtimeReceipt.containers[0]),
    },
    { event: "finite-git-grant", revisionId: opaque, deadlineWallMs: -1 },
    { event: "model-turn-succeeded", stage: "before-expiry", nonce: forbidden },
    { event: "model-turn-succeeded", stage: forbidden, nonce: `FIRST_AGENT_${uuid}` },
    { ...maintenanceDiagnostic, reason: forbidden },
    { ...maintenanceDiagnostic, logReadFailures: -1 },
    { ...maintenanceDiagnostic, logReadSuccesses: forbidden },
    { ...maintenanceDiagnostic, tailLimitReads: 0.5 },
    { ...maintenanceDiagnostic, completionsTruncated: forbidden },
    { ...maintenanceDiagnostic, completions: Array(17).fill({ outcome: "retry", code: "x" }) },
    { ...maintenanceDiagnostic, completions: [forbidden] },
    { event: "worker-restart-unconfirmed", stage: forbidden },
    { event: "worker-restart-unconfirmed" },
    { event: "cleanup", outcome: forbidden },
  ].map((value) => ({ kind: retentionKind, ...value }));
  // Observation metadata can survive unavailable probes; payloads and raw identities cannot.
  const unavailableTurnover = {
    kind: "openshell-initial-turnover",
    request: 1,
    clockOffsetMinMs: -1,
    clockOffsetMaxMs: 1,
    startedAtMs: 1_800_000_000_000,
    finishedAtMs: 1_800_000_010_000,
    requestOutcome: "failed",
    httpStatus: null,
    nonceMatched: false,
    observation: "unavailable",
    qualification: "failed",
    durableCommands: false,
    nodeIdSha256: null,
    connectedBeforeMs: null,
    connectedAfterMs: null,
    providerEnvBeforeSha256: null,
    providerEnvAfterSha256: null,
    configBeforeSha256: null,
    configAfterSha256: null,
    policyBeforeSha256: null,
    policyAfterSha256: null,
    turnoverAtMs: null,
    staleTunnelAtMs: null,
    harness1006LogObserved: false,
    capturedGeneration: null,
    currentGeneration: null,
    configUnchanged: false,
    policyUnchanged: false,
    providerEnvChanged: false,
    settingsConsistent: false,
    stableRuntime: false,
  };
  const unexercisedTurnover = {
    ...unavailableTurnover,
    requestOutcome: "passed",
    httpStatus: 200,
    nonceMatched: true,
    observation: "complete",
    qualification: "unexercised",
    durableCommands: true,
    nodeIdSha256: "a".repeat(64),
    connectedBeforeMs: 1_799_999_999_000,
    connectedAfterMs: 1_799_999_999_000,
    providerEnvBeforeSha256: "b".repeat(64),
    providerEnvAfterSha256: "b".repeat(64),
    configBeforeSha256: "c".repeat(64),
    configAfterSha256: "c".repeat(64),
    policyBeforeSha256: "d".repeat(64),
    policyAfterSha256: "d".repeat(64),
    configUnchanged: true,
    policyUnchanged: true,
    settingsConsistent: true,
    stableRuntime: true,
  };
  const turnContinuity = {
    ...unexercisedTurnover,
    request: 2,
    qualification: "turn-continuity",
    connectedAfterMs: 1_800_000_003_000,
    providerEnvAfterSha256: "e".repeat(64),
    turnoverAtMs: 1_800_000_001_000,
    staleTunnelAtMs: 1_800_000_002_000,
    harness1006LogObserved: true,
    capturedGeneration: 1,
    currentGeneration: 2,
    providerEnvChanged: true,
  };
  const runtimeFailure = {
    kind: "local-first-agent-command",
    phase: "setup",
    stage: "runtime-build",
    count: 4,
    failed: 3,
    elapsedMs: 200,
  };
  // These records exercise the same consistency decision used by the real observer.
  // Contradiction stays incomplete even when each field is well-typed.
  const incompleteTurnover = (
    base: typeof turnContinuity | typeof unexercisedTurnover,
    overrides: Partial<typeof turnContinuity>,
  ) => ({
    ...base,
    ...overrides,
    qualification: "incomplete",
  });
  const conflictingSettings = incompleteTurnover(turnContinuity, { settingsConsistent: false });
  const unchangedProvider = incompleteTurnover(turnContinuity, {
    providerEnvAfterSha256: turnContinuity.providerEnvBeforeSha256,
  });
  const missingTurnoverEvent = incompleteTurnover(unexercisedTurnover, {
    providerEnvAfterSha256: "e".repeat(64),
  });
  const changedGateway = incompleteTurnover(turnContinuity, { stableRuntime: false });
  const earlyRelay = incompleteTurnover(turnContinuity, { staleTunnelAtMs: 1_799_999_999_999 });
  const lateTurnover = incompleteTurnover(turnContinuity, { turnoverAtMs: 1_800_000_010_001 });
  await writeSingleFileRunnerLane(
    root,
    "measure",
    "tests/integration/measurements.test.mjs",
    [
      'import test from "node:test";',
      `import { runOpenShellStage } from ${JSON.stringify(new URL("../helpers/openshell-stage.mjs", import.meta.url).href)};`,
      'test("measures", async (t) => {',
      '  await runOpenShellStage(t, "scratch-sibling-isolation", async () => {});',
      '  await runOpenShellStage(t, "scratch-queued-actor-revocation", async () => {});',
      ...[
        ...measurements("openshell-stage", [
          {
            stage: "oauth-refresh",
            outcome: "passed",
            elapsedMs: 123,
            transcript: "secretauthvalue-transcript",
          },
          { stage: "secretauthvalue-stage", outcome: "passed", elapsedMs: 123 },
        ]),
        measurement({
          kind: "local-first-agent-command",
          phase: "setup",
          stage: "runtime-build",
          count: 1,
          failed: 0,
          elapsedMs: 100,
          args: "secretauthvalue-args",
        }),
        measurement({ ...runtimeFailure, nonzeroExitCount: 1, signaledCount: 1 }),
        measurement({ ...runtimeFailure, stage: "openshell-agent-sandbox-image" }),
        measurement({
          ...runtimeFailure,
          elapsedMs: 201,
          signaledCount: "secretauthvalue-outcome",
        }),
        measurement({ ...runtimeFailure, elapsedMs: 202, nonzeroExitCount: 2, signaledCount: 2 }),
        measurement({
          ...runtimeFailure,
          elapsedMs: 203,
          stage: "controller-build",
          signaledCount: 1,
        }),
        measurement({
          kind: "local-first-agent-command",
          phase: "setup",
          stage: "secretauthvalue-stage",
          count: 1,
          failed: 0,
          elapsedMs: 100,
        }),
        ...measurements("local-first-agent-pod", [
          {
            stage: "native-initial",
            role: "harness",
            restarts: 0,
            createdAfterRequestMs: 100,
            scheduledMs: 100,
            initializedMs: 200,
            runningMs: 200,
            readyMs: 300,
            observedMs: 400,
            environment: "secretauthvalue-env",
          },
          { stage: "native-initial", role: "secretauthvalue-role", restarts: 0 },
        ]),

        ...measurements("local-first-agent", [
          {
            stage: "setup",
            outcome: "passed",
            elapsedMs: 1234,
            transcript: "secretauthvalue-transcript",
          },
          { stage: "secretauthvalue-stage", outcome: "passed", elapsedMs: 12 },
          { stage: "setup", outcome: "secretauthvalue-outcome", elapsedMs: 12 },
          { stage: "setup", outcome: "passed", elapsedMs: "secretauthvalue-time" },
        ]),

        ...measurements("kubelet-volume-refresh", [
          {
            volume: "secret",
            nudge: "pod-annotation",
            sample: 1,
            seconds: 1.234,
            extra: "secretauthvalue-extra",
          },
          { volume: "secretauthvalue-volume", nudge: "none", sample: 0, seconds: 1 },
          { volume: "configmap", nudge: "none", sample: 0, seconds: "secretauthvalue-seconds" },
        ]),
        ...measurements("runtime-model-probe", [
          {
            case: "gateway-500m-answer",
            code: "READY",
            elapsedMs: 61_234,
            capMs: 110_000,
            cpuWaitMs: 4_321,
            setupMs: 2_345,
            probeDoneMs: 63_456,
            readyMs: null,
            extra: "secretauthvalue-extra",
          },
          {
            case: "gateway-1cpu-answer",
            code: "secretauthvalue-code",
            elapsedMs: 1,
            capMs: 65_000,
            cpuWaitMs: null,
            setupMs: 1,
            probeDoneMs: 1,
            readyMs: 1,
          },
          {
            case: "gateway-500m-contended",
            code: null,
            elapsedMs: null,
            capMs: null,
            cpuWaitMs: null,
            setupMs: 1,
            probeDoneMs: null,
            readyMs: null,
          },
          {
            case: "secretauthvalue-case",
            code: "READY",
            elapsedMs: 1,
            capMs: 1,
            cpuWaitMs: 1,
            setupMs: 1,
            probeDoneMs: 1,
            readyMs: 1,
          },
          {
            case: "gateway-500m-hang",
            code: "MODEL_PROBE_TIMEOUT",
            elapsedMs: "secretauthvalue-elapsed",
            capMs: 1,
            cpuWaitMs: 1,
            setupMs: 1,
            probeDoneMs: 1,
            readyMs: 1,
          },
        ]),
        ...measurements("runtime-sigterm", [
          {
            case: "gateway-model-probe",
            stopped: true,
            elapsedMs: 4_321,
            budgetMs: 15_000,
            extra: "secretauthvalue-extra",
          },
          { case: "secretauthvalue-case", stopped: true, elapsedMs: 1, budgetMs: 15_000 },
          {
            case: "codex-ready",
            stopped: "secretauthvalue-stopped",
            elapsedMs: 1,
            budgetMs: 15_000,
          },
          { case: "codex-ready", stopped: false, elapsedMs: 1.5, budgetMs: 15_000 },
        ]),
        measurement({ ...openshellPhase, detail: "secretauthvalue-phase-detail" }),
        measurement({ ...openshellPhase, stage: "secretauthvalue-phase-stage" }),
        measurement({ ...openshellPhase, outcome: "secretauthvalue-phase-outcome" }),
        measurement({ ...openshellPhase, elapsedMs: 2_400_001 }),
        measurement({ ...openshellPhase, elapsedMs: 0.5 }),
        ...retentionReceipts.map(measurement),
        ...invalidRetention.map(measurement),
        `openclaw-ci-measurement {"kind":"openshell-git-retention","private":"${forbidden}",`,
        ...[unavailableTurnover, unexercisedTurnover, turnContinuity].map((value) =>
          measurement({
            ...value,
            detail: "secretauthvalue-turnover-detail",
            nodeId: "secretauthvalue-node-id",
            provider: { config: "secretauthvalue-provider-config" },
          }),
        ),
        ...[
          { request: 3 },
          { startedAtMs: -1 },
          { finishedAtMs: Number.MAX_SAFE_INTEGER + 1 },
          { requestOutcome: "secretauthvalue-request-outcome" },
          { httpStatus: 600 },
          { observation: "secretauthvalue-observation" },
          { qualification: "secretauthvalue-qualification" },
          { nodeIdSha256: "secretauthvalue-node-id" },
          { providerEnvAfterSha256: "A".repeat(64) },
          { configBeforeSha256: "a".repeat(63) },
          { policyAfterSha256: undefined },
          { connectedAfterMs: 0.5 },
          { turnoverAtMs: "secretauthvalue-time" },
          { currentGeneration: -1 },
          { nonceMatched: "secretauthvalue-matched" },
          { durableCommands: 1 },
          { stableRuntime: undefined },
          { harness1006LogObserved: "secretauthvalue-close" },
        ].map((invalid) => measurement({ ...turnContinuity, ...invalid })),
        ...[
          conflictingSettings,
          unchangedProvider,
          missingTurnoverEvent,
          changedGateway,
          earlyRelay,
          lateTurnover,
        ].flatMap((value) => [
          measurement(value),
          measurement({ ...value, qualification: "turn-continuity" }),
        ]),
        "openclaw-ci-measurement secretauthvalue-not-json",
        "secretauthvalue-plain-diagnostic",
      ].map((message) => `  t.diagnostic(${JSON.stringify(message)});`),
      "});",
      "",
    ].join("\n"),
  );

  const result = runRunnerSync(laneArgs(root, "measure", "state/measurements.jsonl", resultsPath));
  assert.equal(result.status, 0, result.stderr);
  const {
    artifact,
    summary,
    file,
    measurements: recorded,
    receipts,
  } = await readMeasurementResult(resultsPath);
  const [sibling, revocation, ...otherMeasurements] = recorded;
  assert.ok(sibling && revocation, "Expected both leading stage measurements");
  for (const [receipt, stage] of [
    [sibling, "scratch-sibling-isolation"],
    [revocation, "scratch-queued-actor-revocation"],
  ] as const) {
    const { elapsedMs, ...outcome } = receipt;
    assert.deepEqual(outcome, { kind: "openshell-stage", stage, outcome: "passed" });
    assert.ok(typeof elapsedMs === "number" && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
  }
  assert.deepEqual(
    otherMeasurements.filter(({ kind }) => kind !== retentionKind),
    [
      { kind: "openshell-stage", stage: "oauth-refresh", outcome: "passed", elapsedMs: 123 },
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: "runtime-build",
        count: 1,
        failed: 0,
        elapsedMs: 100,
      },
      { ...runtimeFailure, nonzeroExitCount: 1, signaledCount: 1 },
      { ...runtimeFailure, stage: "openshell-agent-sandbox-image" },
      { ...runtimeFailure, elapsedMs: 201 },
      { ...runtimeFailure, elapsedMs: 202 },
      { ...runtimeFailure, elapsedMs: 203, stage: "controller-build" },
      {
        kind: "local-first-agent-pod",
        stage: "native-initial",
        role: "harness",
        restarts: 0,
        createdAfterRequestMs: 100,
        scheduledMs: 100,
        initializedMs: 200,
        runningMs: 200,
        readyMs: 300,
        observedMs: 400,
      },

      { kind: "local-first-agent", stage: "setup", outcome: "passed", elapsedMs: 1234 },
      {
        kind: "kubelet-volume-refresh",
        volume: "secret",
        nudge: "pod-annotation",
        sample: 1,
        seconds: 1.2,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-500m-answer",
        code: "READY",
        elapsedMs: 61_234,
        capMs: 110_000,
        cpuWaitMs: 4_321,
        setupMs: 2_345,
        probeDoneMs: 63_456,
        readyMs: null,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-1cpu-answer",
        code: "other",
        elapsedMs: 1,
        capMs: 65_000,
        cpuWaitMs: null,
        setupMs: 1,
        probeDoneMs: 1,
        readyMs: 1,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-500m-contended",
        code: null,
        elapsedMs: null,
        capMs: null,
        cpuWaitMs: null,
        setupMs: 1,
        probeDoneMs: null,
        readyMs: null,
      },
      {
        kind: "runtime-sigterm",
        case: "gateway-model-probe",
        stopped: true,
        elapsedMs: 4_321,
        budgetMs: 15_000,
      },
      openshellPhase,
      unavailableTurnover,
      unexercisedTurnover,
      turnContinuity,
      conflictingSettings,
      unchangedProvider,
      missingTurnoverEvent,
      changedGateway,
      earlyRelay,
      lateTurnover,
    ],
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
  assert.deepEqual(
    receipts.filter(({ event }) => event.startsWith("finite-removal-")),
    [
      {
        kind: retentionKind,
        event: "finite-removal-live-denial",
        boundary: "signed-access-withdrawn",
        signer: "exercised",
        requestIdHash: opaqueHash,
        workerUid: uuid,
      },
      {
        kind: retentionKind,
        event: "finite-removal-live-denial",
        boundary: "supervisor-policy",
        signer: "unexercised",
        requestIdHash: null,
        workerUid: uuid,
      },
      {
        kind: retentionKind,
        event: "finite-removal-reduced",
        revisionIdHash: opaqueHash,
        workIdHash: opaqueHash,
        workerUid: uuid,
        code: "REPOSITORY_ACCESS_WITHDRAWN",
        sessionIdHash: opaqueHash,
        processInstanceIdHash: opaqueHash,
        networkInstanceIdHash: opaqueHash,
        attachmentEpochHash: opaqueHash,
        providerEnvRevision: "3",
        configRevision: "4",
        policyHash: sha256,
      },
      {
        kind: retentionKind,
        event: "finite-removal-conversation",
        stage: "after-replacement",
        revisionIdHash: opaqueHash,
        sessionIdHash: opaqueHash,
        threadIdHash: opaqueHash,
        userSeq: 10,
        assistantSeq: 11,
      },
      {
        kind: retentionKind,
        event: "finite-removal-retired",
        revisionIdHash: opaqueHash,
        cause: "required-model-withdrawn",
        deadlineWallMs: 1800000000000,
        observedAt: 1799999999000,
        activeRevisionCleared: true,
        sandboxAbsent: true,
        agentPodsAbsent: true,
      },
    ],
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === workerRestart.event),
    [{ kind: retentionKind, ...workerRestart }],
    "expected exactly one allowlisted worker restart projection with the original identities",
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "withdrawal-origin-witness"),
    withdrawalWitnesses.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.deepEqual(
    receipts.find(({ event }) => event === "withdrawal-retirement-refused"),
    { kind: retentionKind, ...withdrawalRetirement },
  );
  assert.deepEqual(
    receipts.map(({ event }) => event),
    retentionReceipts.map(({ event }) => event),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "retained-execution-failed"),
    retainedFailures.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "git-policy-denied"),
    policyDenials.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(file.path, "tests/integration/measurements.test.mjs");
  assert.deepEqual(
    receipts.find(({ event }) => event === "initial-runtime"),
    {
      kind: retentionKind,
      event: "initial-runtime",
      revisionIdHash: opaqueHash,
      sandboxIdHash: opaqueHash,
      sandboxUid: uuid,
      podUid: uuid,
      mainProcessInstanceIdHash: opaqueHash,
      mainProcessStartedAt: time,
      containers: [
        {
          nameHash: opaqueHash,
          idHash: opaqueHash,
          imageDigest: `sha256:${sha256}`,
          startedAt: time,
          restartCount: 0,
        },
      ],
    },
  );
  assert.deepEqual(
    receipts.find(({ event }) => event === "supervisor-trust"),
    {
      kind: retentionKind,
      event: "supervisor-trust",
      parentDigest: `sha256:${sha256}`,
      imageDigest: `sha256:${sha256}`,
      binaryHash: sha256,
      configDigest: `sha256:${sha256}`,
    },
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "withdrawal-decision-unconfirmed"),
    ["unchecked", "same", "different"].map((workerComparison) => ({
      kind: retentionKind,
      ...withdrawalDecision,
      workerComparison,
    })),
  );
  const expiryReceipt = receipts.find(({ event }) => event === "git-expiry-observed");
  assert.ok(expiryReceipt, "Expected an expiry receipt");
  assert.deepEqual(expiryReceipt.expiry, {
    event: "worker.openshell-git-expiry",
    namespaceIdHash: opaqueHash,
    agentIdHash: opaqueHash,
    revisionIdHash: opaqueHash,
    repositoryRefHash: opaqueHash,
    outcome: "withdrawn",
    check: "record-reduced-generation",
  });
  assert.deepEqual(
    receipts.filter(({ event }) => event === "worker-restart-unconfirmed"),
    restartStages.map((stage) => ({
      kind: retentionKind,
      event: "worker-restart-unconfirmed",
      stage,
    })),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "worker-maintenance-unconfirmed"),
    maintenanceReasons.map((reason) => ({
      kind: retentionKind,
      event: "worker-maintenance-unconfirmed",
      reason,
      logReads: 3,
      logReadSuccesses: 2,
      logReadFailures: 1,
      linesRead: 2004,
      parsedEvents: 2000,
      parseFailures: 4,
      tailLimitReads: 1,
      completionsTruncated: false,
      completions: [
        { outcome: "pending", code: "REPOSITORY_CLEANUP_PENDING" },
        { outcome: "retry", code: "unrecognized", failure: "UNRECOGNIZED" },
        { outcome: "permanent", code: "REPOSITORY_ACCESS_WITHDRAWN" },
        { outcome: "pending", code: "REPOSITORY_GIT_ROUTE_PENDING" },
        { outcome: "pending", code: "REPOSITORY_GIT_MATERIAL_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_BINDING_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_RECONNECT_PENDING" },
        { outcome: "pending", code: "WORKSPACE_SETUP_RETRYING" },
        {
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          failure: "REPOSITORY_ROUTE_BLOCKED",
        },
        {
          outcome: "pending",
          code: "REVISION_FINALIZATION_INCOMPLETE",
          failure: "MODEL_PROBE_FAILED",
        },
        { outcome: "pending", code: "unrecognized", failure: "UNRECOGNIZED" },
      ],
    })),
  );
  const unconfirmed = receipts.find(({ event }) => event === "git-expiry-unconfirmed");
  assert.ok(unconfirmed, "Expected an unconfirmed expiry receipt");
  assert.deepEqual(unconfirmed.observations, captured);
  assert.equal(unconfirmed.namespaceIdHash, opaqueHash);
  assert.equal(unconfirmed.agentIdHash, opaqueHash);
  assert.equal(unconfirmed.revisionIdHash, opaqueHash);
  assert.equal(unconfirmed.repositoryRefHash, opaqueHash);
  assert.equal(unconfirmed.lastWorkerUid, uuid);
  assert.equal(unconfirmed.tailLimitReads, 1);
  assert.equal(unconfirmed.workerChanges, 1);
  assert.equal(unconfirmed.driverSuccessSeen, true);
  assert.equal(unconfirmed.workerAcknowledgementSeen, false);
  assert.equal(unconfirmed.observationsTruncated, true);
  for (const output of [result.stdout, result.stderr, artifact]) {
    assert.ok(!output.includes(forbidden));
    assert.ok(!output.includes(opaque));
  }

  // A later failure makes the reporter emit its raw output buffer. Invalid
  // receipts and unselected fields must still not fall through into that buffer.
  const fixtureFile = join(root, "tests/integration/measurements.test.mjs");
  await writeFile(
    fixtureFile,
    (await readFile(fixtureFile, "utf8")) +
      '\ntest("fails after receipts", () => { throw new Error("controlled failure"); });\n',
  );
  const failed = runRunnerSync(
    laneArgs(root, "measure", "state/failed-measurements.json", resultsPath),
  );
  assert.equal(failed.status, 1, failed.stderr);
  const failure = await readMeasurementResult(resultsPath);
  const diagnostics = await readFile(
    join(root, "state/failed-measurements.json.diagnostics.json"),
    "utf8",
  );
  assert.equal(failure.file.nodeExitCode, 1);
  const diagnosticReport: unknown = JSON.parse(diagnostics);
  assert.ok(
    isJsonObject(diagnosticReport) &&
      Array.isArray(diagnosticReport.failures) &&
      diagnosticReport.failures.some(
        (entry: unknown) =>
          isJsonObject(entry) &&
          entry.file === "tests/integration/measurements.test.mjs" &&
          Array.isArray(entry.tests) &&
          entry.tests.some(
            (test: unknown) =>
              isJsonObject(test) &&
              test.name === "fails after receipts" &&
              test.message === "controlled failure",
          ),
      ),
    "Expected the deliberate child failure in diagnostics",
  );
  assert.deepEqual(failure.receipts, receipts);
  for (const output of [failed.stdout, failed.stderr, failure.artifact, diagnostics]) {
    assert.ok(!output.includes(forbidden));
    assert.ok(!output.includes(opaque));
  }
}
