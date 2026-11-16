import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { ControllerWork, WorkClaim } from "./controller-work.ts";

export type ObserverInvocationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ObserverTargetRole = "agent" | "gateway";

export interface ObserverImageIdentity {
  readonly reference: string;
  readonly digest: string;
  readonly qualificationId: string;
}

export interface ObserverObservationScope {
  readonly kind: "dns";
  readonly interfaceName: string;
  readonly filterIdentity: string;
}

export interface ObserverInvocationLimits {
  readonly maximumDurationMs: number;
  readonly maximumCapturedRecords: number;
  readonly maximumEncodedOutputBytes: number;
}

export interface ObserverCancellationContract {
  readonly kind: "claim_abort";
  readonly gracePeriodMs: number;
}

export interface ObserverInvocationQualification {
  readonly qualificationId: string;
  readonly backendVersion: string;
  readonly imageQualificationId: string;
  readonly evidenceContractId: string;
  readonly securityProfileId: string;
  readonly maximumDurationMs: number;
  readonly maximumCapturedRecords: number;
  readonly maximumEncodedOutputBytes: number;
  readonly maximumCancellationGraceMs: number;
}

export interface ObserverEvidenceDestination {
  readonly contractId: string;
  readonly destinationId: string;
}

export interface ObserverSecurityProfile {
  readonly profileId: string;
  readonly capabilities: readonly [];
  readonly privileged: false;
}

export interface ObserverInvocationPlanInput {
  readonly backendVersion: string;
  readonly image: Readonly<ObserverImageIdentity>;
  readonly observationScope: Readonly<ObserverObservationScope>;
  readonly limits: Readonly<ObserverInvocationLimits>;
  readonly cancellation: Readonly<ObserverCancellationContract>;
  readonly evidenceDestination: Readonly<ObserverEvidenceDestination>;
  readonly cleanupPolicy: "observer_first";
  readonly securityProfile: Readonly<ObserverSecurityProfile>;
}

export interface ObserverInvocationPlan extends ObserverInvocationPlanInput {
  readonly qualificationId: string;
}

export interface ObserverTargetResolutionEvidence {
  readonly targetContainerId: string;
  readonly namespaceNetworkId: string;
  readonly targetIdentity: string;
  readonly observedAt: string;
}

export interface ObserverContainerEvidence {
  readonly observerContainerId: string;
  readonly createdAt: string;
}

export interface ObserverReadinessEvidence {
  readonly targetContainerId: string;
  readonly interfaceName: string;
  readonly filterIdentity: string;
  readonly readyAt: string;
}

export type ObserverInvocationOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export type ObserverBoundReached = "duration" | "record_count" | "encoded_output";

export interface ObserverTerminalEvidence {
  readonly startedAt: string;
  readonly captureDeadlineAt: string;
  readonly captureStoppedAt: string;
  readonly terminalCompletedAt: string;
  readonly startOutcome: ObserverInvocationOutcome;
  readonly stopOutcome: ObserverInvocationOutcome;
  readonly boundsReached: readonly ObserverBoundReached[];
  readonly capturedRecordCount: number;
  readonly encodedOutputBytes: number;
}

export interface ObserverCleanupEvidence {
  readonly terminationRequestedAt: string;
  readonly graceDeadline: string;
  readonly forceRemovalOutcome: "not_required" | "removed";
  readonly removalCompletedAt?: string;
  readonly absenceVerifiedAt: string;
  readonly targetTeardownAuthorized: true;
}

export interface ObserverInvocationProgress {
  readonly targetResolution?: Readonly<ObserverTargetResolutionEvidence>;
  readonly observer?: Readonly<ObserverContainerEvidence>;
  readonly readiness?: Readonly<ObserverReadinessEvidence>;
  readonly terminal?: Readonly<ObserverTerminalEvidence>;
  readonly cleanup?: Readonly<ObserverCleanupEvidence>;
}

export type ObserverInvocationPhase =
  "admitted" | "target_resolved" | "observer_created" | "ready" | "terminal" | "cleanup";

export interface ObserverInvocationRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly status: ObserverInvocationStatus;
  readonly completedPhase: ObserverInvocationPhase;
  readonly targetRole: ObserverTargetRole;
  readonly plan: Readonly<ObserverInvocationPlan>;
  readonly progress: Readonly<ObserverInvocationProgress>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateObserverInvocationRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly targetRole: ObserverTargetRole;
  readonly plan: Readonly<ObserverInvocationPlanInput>;
}

export interface ObserverInvocationCheckpoint {
  readonly completedPhase: ObserverInvocationPhase;
  readonly status?: Exclude<ObserverInvocationStatus, "queued">;
  readonly progress?: Readonly<ObserverInvocationProgress>;
}

export interface ObserverInvocationFailure {
  readonly disposition: "retry" | "permanent" | "defer";
  readonly code: string;
  readonly message: string;
  readonly delayMs?: number;
}

export interface ObserverInvocationReplay {
  readonly record: Readonly<ObserverInvocationRecord>;
  readonly replayed: boolean;
}

export interface ObserverInvocationWithWork {
  readonly record: Readonly<ObserverInvocationRecord>;
  readonly work?: Readonly<ControllerWork>;
}

export interface ObserverInvocationReadRepository {
  findByWorkId(workId: string): Promise<Readonly<ObserverInvocationRecord> | undefined>;
  findWithWork(workId: string): Promise<Readonly<ObserverInvocationWithWork> | undefined>;
  findByRequest(
    namespaceId: string,
    actorId: string,
    requestId: string,
  ): Promise<Readonly<ObserverInvocationRecord> | undefined>;
  listRevisionInvocations(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<readonly Readonly<ObserverInvocationRecord>[]>;
}

export interface ObserverInvocationRepository extends ObserverInvocationReadRepository {
  create(
    record: CreateObserverInvocationRecord,
    qualification: Readonly<ObserverInvocationQualification>,
  ): Promise<Readonly<ObserverInvocationReplay>>;
  checkpoint(
    claim: WorkClaim,
    checkpoint: ObserverInvocationCheckpoint,
  ): Promise<Readonly<ObserverInvocationRecord>>;
  recordFailure(
    claim: WorkClaim,
    checkpoint: ObserverInvocationCheckpoint,
    failure: ObserverInvocationFailure,
  ): Promise<Readonly<ObserverInvocationRecord>>;
  cancel(
    claim: WorkClaim,
    checkpoint: ObserverInvocationCheckpoint,
    error: { readonly code: string; readonly message: string },
  ): Promise<Readonly<ObserverInvocationRecord>>;
}

const STATUS_VALUES = new Set<ObserverInvocationStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

const PHASE_ORDER: Readonly<Record<ObserverInvocationPhase, number>> = Object.freeze({
  admitted: 0,
  target_resolved: 1,
  observer_created: 2,
  ready: 3,
  terminal: 4,
  cleanup: 5,
});

const PHASE_VALUES = new Set<ObserverInvocationPhase>(
  Object.keys(PHASE_ORDER) as ObserverInvocationPhase[],
);

const SAFE_TOKEN = /^[A-Za-z0-9._~:@/-]{1,200}$/u;
const REQUEST_FINGERPRINT = /^[a-f0-9]{64}$/u;
const FAILURE_MESSAGE_MAX_LENGTH = 1_000;
const MAX_DEFER_DELAY_MS = 300_000;

function safeToken(value: string, name: string): string {
  if (!isNonEmptyString(value) || !SAFE_TOKEN.test(value)) {
    throw new ScopeViolationError(`${name} must be a safe identifier.`);
  }
  return value;
}

function closedRecord(
  value: unknown,
  name: string,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError(name + " must be an object.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ScopeViolationError(name + " has unsupported fields.");
  }
  return record;
}

function optionalClosedRecord(
  value: unknown,
  name: string,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError(name + " must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new ScopeViolationError(name + " has unsupported fields.");
  }
  return record;
}

function boundedIdentifier(value: unknown, name: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9._~:@/-]+$/u.test(value)
  ) {
    throw new ScopeViolationError(name + " must be a safe identifier.");
  }
  return value;
}

function dockerIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ScopeViolationError(name + " must be an immutable Docker identifier.");
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new ScopeViolationError(name + " must be a canonical ISO timestamp.");
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ScopeViolationError(name + " must be a canonical ISO timestamp.");
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ScopeViolationError(name + " must be a nonnegative safe integer.");
  }
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ScopeViolationError(name + " must be a positive safe integer.");
  }
  return value as number;
}

function validateObserverImageIdentity(value: unknown): ObserverImageIdentity {
  const record = closedRecord(value, "Observer image identity", [
    "reference",
    "digest",
    "qualificationId",
  ]);
  if (typeof record.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.digest)) {
    throw new ScopeViolationError("Observer image identity requires an immutable SHA-256 digest.");
  }
  const reference = boundedIdentifier(record.reference, "Observer image reference");
  if (!reference.endsWith("@" + record.digest)) {
    throw new ScopeViolationError(
      "Observer image reference must be qualified by its admitted digest.",
    );
  }
  return Object.freeze({
    reference,
    digest: record.digest,
    qualificationId: boundedIdentifier(record.qualificationId, "Observer image qualification ID"),
  });
}

function validateObservationScope(value: unknown): ObserverObservationScope {
  const record = closedRecord(value, "Observer observation scope", [
    "kind",
    "interfaceName",
    "filterIdentity",
  ]);
  if (record.kind !== "dns") {
    throw new ScopeViolationError("Observer observation scope kind is invalid.");
  }
  return Object.freeze({
    kind: "dns",
    interfaceName: boundedIdentifier(record.interfaceName, "Observer interface name", 64),
    filterIdentity: boundedIdentifier(record.filterIdentity, "Observer filter identity"),
  });
}

function validateInvocationLimits(value: unknown): ObserverInvocationLimits {
  const record = closedRecord(value, "Observer invocation limits", [
    "maximumDurationMs",
    "maximumCapturedRecords",
    "maximumEncodedOutputBytes",
  ]);
  return Object.freeze({
    maximumDurationMs: positiveInteger(record.maximumDurationMs, "Observer maximum duration"),
    maximumCapturedRecords: positiveInteger(
      record.maximumCapturedRecords,
      "Observer maximum captured-record count",
    ),
    maximumEncodedOutputBytes: positiveInteger(
      record.maximumEncodedOutputBytes,
      "Observer maximum encoded output size",
    ),
  });
}

function validateCancellationContract(value: unknown): ObserverCancellationContract {
  const record = closedRecord(value, "Observer cancellation contract", ["kind", "gracePeriodMs"]);
  if (record.kind !== "claim_abort") {
    throw new ScopeViolationError("Observer cancellation path is invalid.");
  }
  return Object.freeze({
    kind: "claim_abort",
    gracePeriodMs: positiveInteger(record.gracePeriodMs, "Observer cancellation grace period"),
  });
}

function validateQualification(value: unknown): ObserverInvocationQualification {
  const record = closedRecord(value, "Observer invocation qualification", [
    "qualificationId",
    "backendVersion",
    "imageQualificationId",
    "evidenceContractId",
    "securityProfileId",
    "maximumDurationMs",
    "maximumCapturedRecords",
    "maximumEncodedOutputBytes",
    "maximumCancellationGraceMs",
  ]);
  return Object.freeze({
    qualificationId: boundedIdentifier(record.qualificationId, "Observer qualification ID"),
    backendVersion: boundedIdentifier(record.backendVersion, "Qualified observer backend version"),
    imageQualificationId: boundedIdentifier(
      record.imageQualificationId,
      "Qualified observer image identity",
    ),
    evidenceContractId: boundedIdentifier(
      record.evidenceContractId,
      "Qualified observer evidence contract",
    ),
    securityProfileId: boundedIdentifier(
      record.securityProfileId,
      "Qualified observer security profile",
    ),
    maximumDurationMs: positiveInteger(
      record.maximumDurationMs,
      "Qualified observer maximum duration",
    ),
    maximumCapturedRecords: positiveInteger(
      record.maximumCapturedRecords,
      "Qualified observer maximum captured-record count",
    ),
    maximumEncodedOutputBytes: positiveInteger(
      record.maximumEncodedOutputBytes,
      "Qualified observer maximum encoded output size",
    ),
    maximumCancellationGraceMs: positiveInteger(
      record.maximumCancellationGraceMs,
      "Qualified observer maximum cancellation grace period",
    ),
  });
}

function validateEvidenceDestination(value: unknown): ObserverEvidenceDestination {
  const record = closedRecord(value, "Observer evidence destination", [
    "contractId",
    "destinationId",
  ]);
  return Object.freeze({
    contractId: boundedIdentifier(record.contractId, "Observer evidence contract ID"),
    destinationId: boundedIdentifier(record.destinationId, "Observer evidence destination ID"),
  });
}

function validateSecurityProfile(value: unknown): ObserverSecurityProfile {
  const record = closedRecord(value, "Observer security profile", [
    "profileId",
    "capabilities",
    "privileged",
  ]);
  if (
    !Array.isArray(record.capabilities) ||
    record.capabilities.length !== 0 ||
    record.privileged !== false
  ) {
    throw new ScopeViolationError(
      "Observer capability authority is unaccepted and privileged mode is prohibited.",
    );
  }
  return Object.freeze({
    profileId: boundedIdentifier(record.profileId, "Observer security profile ID"),
    capabilities: Object.freeze([]) as readonly [],
    privileged: false,
  });
}

export function validateObserverInvocationPlan(
  value: unknown,
  qualificationValue?: unknown,
): ObserverInvocationPlan {
  if (qualificationValue === undefined) {
    throw new ScopeViolationError(
      "Observer invocation admission requires an accepted qualification.",
    );
  }
  const qualification = validateQualification(qualificationValue);
  const record = closedRecord(value, "Observer invocation plan", [
    "backendVersion",
    "image",
    "observationScope",
    "limits",
    "cancellation",
    "evidenceDestination",
    "cleanupPolicy",
    "securityProfile",
  ]);
  if (record.cleanupPolicy !== "observer_first") {
    throw new ScopeViolationError("Observer cleanup policy is invalid.");
  }
  const backendVersion = boundedIdentifier(record.backendVersion, "Observer backend version");
  const image = validateObserverImageIdentity(record.image);
  const observationScope = validateObservationScope(record.observationScope);
  const limits = validateInvocationLimits(record.limits);
  const cancellation = validateCancellationContract(record.cancellation);
  const evidenceDestination = validateEvidenceDestination(record.evidenceDestination);
  const securityProfile = validateSecurityProfile(record.securityProfile);

  if (
    backendVersion !== qualification.backendVersion ||
    image.qualificationId !== qualification.imageQualificationId ||
    evidenceDestination.contractId !== qualification.evidenceContractId ||
    securityProfile.profileId !== qualification.securityProfileId
  ) {
    throw new ScopeViolationError(
      "Observer invocation plan does not match its accepted qualification.",
    );
  }
  if (
    limits.maximumDurationMs > qualification.maximumDurationMs ||
    limits.maximumCapturedRecords > qualification.maximumCapturedRecords ||
    limits.maximumEncodedOutputBytes > qualification.maximumEncodedOutputBytes ||
    cancellation.gracePeriodMs > qualification.maximumCancellationGraceMs
  ) {
    throw new ScopeViolationError("Observer invocation plan exceeds its accepted qualification.");
  }

  return Object.freeze({
    qualificationId: qualification.qualificationId,
    backendVersion,
    image,
    observationScope,
    limits,
    cancellation,
    evidenceDestination,
    cleanupPolicy: "observer_first",
    securityProfile,
  });
}

function invocationOutcome(value: unknown, name: string): ObserverInvocationOutcome {
  if (
    value !== "succeeded" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "timed_out"
  ) {
    throw new ScopeViolationError(name + " is invalid.");
  }
  return value;
}

function validateTargetResolution(value: unknown): ObserverTargetResolutionEvidence {
  const record = closedRecord(value, "Observer target-resolution evidence", [
    "targetContainerId",
    "namespaceNetworkId",
    "targetIdentity",
    "observedAt",
  ]);
  return Object.freeze({
    targetContainerId: dockerIdentifier(record.targetContainerId, "Observer target container ID"),
    namespaceNetworkId: dockerIdentifier(
      record.namespaceNetworkId,
      "Observer Namespace network ID",
    ),
    targetIdentity: boundedIdentifier(record.targetIdentity, "Observer target identity"),
    observedAt: timestamp(record.observedAt, "Observer target-resolution time"),
  });
}

function validateObserverContainer(value: unknown): ObserverContainerEvidence {
  const record = closedRecord(value, "Observer container evidence", [
    "observerContainerId",
    "createdAt",
  ]);
  return Object.freeze({
    observerContainerId: dockerIdentifier(record.observerContainerId, "Observer container ID"),
    createdAt: timestamp(record.createdAt, "Observer creation time"),
  });
}

function validateReadiness(value: unknown): ObserverReadinessEvidence {
  const record = closedRecord(value, "Observer readiness evidence", [
    "targetContainerId",
    "interfaceName",
    "filterIdentity",
    "readyAt",
  ]);
  return Object.freeze({
    targetContainerId: dockerIdentifier(record.targetContainerId, "Observer readiness target ID"),
    interfaceName: boundedIdentifier(record.interfaceName, "Observer readiness interface", 64),
    filterIdentity: boundedIdentifier(record.filterIdentity, "Observer readiness filter identity"),
    readyAt: timestamp(record.readyAt, "Observer readiness time"),
  });
}

function validateBounds(value: unknown): readonly ObserverBoundReached[] {
  if (!Array.isArray(value)) {
    throw new ScopeViolationError("Observer terminal bounds must be an array.");
  }
  const allowed = new Set<ObserverBoundReached>(["duration", "record_count", "encoded_output"]);
  const normalized = value.map((item) => {
    if (typeof item !== "string" || !allowed.has(item as ObserverBoundReached)) {
      throw new ScopeViolationError("Observer terminal bound is invalid.");
    }
    return item as ObserverBoundReached;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ScopeViolationError("Observer terminal bounds contain duplicates.");
  }
  return Object.freeze(normalized);
}

function validateTerminal(
  value: unknown,
  plan: Readonly<ObserverInvocationPlan>,
): ObserverTerminalEvidence {
  const record = closedRecord(value, "Observer terminal evidence", [
    "startedAt",
    "captureDeadlineAt",
    "captureStoppedAt",
    "terminalCompletedAt",
    "startOutcome",
    "stopOutcome",
    "boundsReached",
    "capturedRecordCount",
    "encodedOutputBytes",
  ]);
  const startedAt = timestamp(record.startedAt, "Observer start time");
  const captureDeadlineAt = timestamp(record.captureDeadlineAt, "Observer capture deadline");
  const captureStoppedAt = timestamp(record.captureStoppedAt, "Observer capture-stop time");
  const terminalCompletedAt = timestamp(
    record.terminalCompletedAt,
    "Observer terminal-completion time",
  );
  const startTime = Date.parse(startedAt);
  const deadlineTime = Date.parse(captureDeadlineAt);
  const captureStoppedTime = Date.parse(captureStoppedAt);
  const terminalCompletedTime = Date.parse(terminalCompletedAt);

  if (deadlineTime - startTime !== plan.limits.maximumDurationMs) {
    throw new ScopeViolationError(
      "Observer capture deadline does not match the admitted duration.",
    );
  }
  if (
    captureStoppedTime < startTime ||
    captureStoppedTime > deadlineTime ||
    terminalCompletedTime < captureStoppedTime
  ) {
    throw new ScopeViolationError("Observer terminal timing violates the admitted capture bound.");
  }

  const boundsReached = validateBounds(record.boundsReached);
  const capturedRecordCount = nonnegativeInteger(
    record.capturedRecordCount,
    "Observer captured-record count",
  );
  const encodedOutputBytes = nonnegativeInteger(
    record.encodedOutputBytes,
    "Observer encoded output size",
  );

  if (
    capturedRecordCount > plan.limits.maximumCapturedRecords ||
    encodedOutputBytes > plan.limits.maximumEncodedOutputBytes
  ) {
    throw new ScopeViolationError("Observer terminal evidence exceeds an admitted output bound.");
  }

  const expectedBounds: ObserverBoundReached[] = [];
  if (captureStoppedTime === deadlineTime) {
    expectedBounds.push("duration");
  }
  if (capturedRecordCount === plan.limits.maximumCapturedRecords) {
    expectedBounds.push("record_count");
  }
  if (encodedOutputBytes === plan.limits.maximumEncodedOutputBytes) {
    expectedBounds.push("encoded_output");
  }
  if (
    boundsReached.length !== expectedBounds.length ||
    boundsReached.some((bound) => !expectedBounds.includes(bound))
  ) {
    throw new ScopeViolationError(
      "Observer terminal bound evidence conflicts with admitted limits.",
    );
  }

  return Object.freeze({
    startedAt,
    captureDeadlineAt,
    captureStoppedAt,
    terminalCompletedAt,
    startOutcome: invocationOutcome(record.startOutcome, "Observer start outcome"),
    stopOutcome: invocationOutcome(record.stopOutcome, "Observer stop outcome"),
    boundsReached,
    capturedRecordCount,
    encodedOutputBytes,
  });
}

function validateCleanup(
  value: unknown,
  plan: Readonly<ObserverInvocationPlan>,
): ObserverCleanupEvidence {
  const record = optionalClosedRecord(value, "Observer cleanup evidence", [
    "terminationRequestedAt",
    "graceDeadline",
    "forceRemovalOutcome",
    "removalCompletedAt",
    "absenceVerifiedAt",
    "targetTeardownAuthorized",
  ]);
  for (const required of [
    "terminationRequestedAt",
    "graceDeadline",
    "forceRemovalOutcome",
    "absenceVerifiedAt",
    "targetTeardownAuthorized",
  ]) {
    if (!Object.hasOwn(record, required)) {
      throw new ScopeViolationError("Observer cleanup evidence requires every mandatory field.");
    }
  }
  if (record.forceRemovalOutcome !== "not_required" && record.forceRemovalOutcome !== "removed") {
    throw new ScopeViolationError("Observer force-removal outcome is invalid.");
  }
  if (record.targetTeardownAuthorized !== true) {
    throw new ScopeViolationError("Observer cleanup must verify absence before target teardown.");
  }

  const terminationRequestedAt = timestamp(
    record.terminationRequestedAt,
    "Observer termination-request time",
  );
  const graceDeadline = timestamp(record.graceDeadline, "Observer cleanup grace deadline");
  const absenceVerifiedAt = timestamp(
    record.absenceVerifiedAt,
    "Observer absence-verification time",
  );
  const terminationTime = Date.parse(terminationRequestedAt);
  const graceTime = Date.parse(graceDeadline);
  const absenceTime = Date.parse(absenceVerifiedAt);

  if (
    graceTime < terminationTime ||
    graceTime - terminationTime > plan.cancellation.gracePeriodMs
  ) {
    throw new ScopeViolationError(
      "Observer cleanup grace period exceeds the admitted cancellation bound.",
    );
  }

  let removalCompletedAt: string | undefined;
  if (record.forceRemovalOutcome === "removed") {
    if (record.removalCompletedAt === undefined) {
      throw new ScopeViolationError("Observer forced removal requires its completion time.");
    }
    removalCompletedAt = timestamp(record.removalCompletedAt, "Observer removal-completion time");
    const removalTime = Date.parse(removalCompletedAt);
    if (removalTime < graceTime || absenceTime < removalTime) {
      throw new ScopeViolationError(
        "Observer forced-removal evidence violates mandatory cleanup ordering.",
      );
    }
  } else {
    if (record.removalCompletedAt !== undefined) {
      throw new ScopeViolationError(
        "Observer cleanup without forced removal cannot record removal completion.",
      );
    }
    if (absenceTime < terminationTime) {
      throw new ScopeViolationError(
        "Observer absence verification predates its termination request.",
      );
    }
  }

  return Object.freeze({
    terminationRequestedAt,
    graceDeadline,
    forceRemovalOutcome: record.forceRemovalOutcome,
    ...(removalCompletedAt === undefined ? {} : { removalCompletedAt }),
    absenceVerifiedAt,
    targetTeardownAuthorized: true,
  });
}

export function validateObserverInvocationProgress(
  value: unknown,
  plan: Readonly<ObserverInvocationPlan>,
): ObserverInvocationProgress {
  const record = optionalClosedRecord(value, "Observer invocation progress", [
    "targetResolution",
    "observer",
    "readiness",
    "terminal",
    "cleanup",
  ]);

  const targetResolution =
    record.targetResolution === undefined
      ? undefined
      : validateTargetResolution(record.targetResolution);
  const observer =
    record.observer === undefined ? undefined : validateObserverContainer(record.observer);
  const readiness =
    record.readiness === undefined ? undefined : validateReadiness(record.readiness);
  const terminal =
    record.terminal === undefined ? undefined : validateTerminal(record.terminal, plan);
  const cleanup = record.cleanup === undefined ? undefined : validateCleanup(record.cleanup, plan);

  if (observer !== undefined && targetResolution === undefined) {
    throw new ScopeViolationError(
      "Observer container evidence requires target-resolution evidence.",
    );
  }
  if (readiness !== undefined && (targetResolution === undefined || observer === undefined)) {
    throw new ScopeViolationError(
      "Observer readiness requires target-resolution and container evidence.",
    );
  }
  if (terminal !== undefined && observer === undefined) {
    throw new ScopeViolationError("Observer terminal evidence requires container evidence.");
  }
  if (cleanup !== undefined && terminal === undefined) {
    throw new ScopeViolationError("Observer cleanup evidence requires terminal evidence.");
  }
  if (
    readiness !== undefined &&
    targetResolution !== undefined &&
    (readiness.targetContainerId !== targetResolution.targetContainerId ||
      readiness.interfaceName !== plan.observationScope.interfaceName ||
      readiness.filterIdentity !== plan.observationScope.filterIdentity)
  ) {
    throw new ScopeViolationError(
      "Observer readiness evidence does not match admitted target and capture authority.",
    );
  }

  return Object.freeze({
    ...(targetResolution === undefined ? {} : { targetResolution }),
    ...(observer === undefined ? {} : { observer }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(cleanup === undefined ? {} : { cleanup }),
  });
}

function invocationStatus(value: string): ObserverInvocationStatus {
  if (!STATUS_VALUES.has(value as ObserverInvocationStatus)) {
    throw new ScopeViolationError("The observer invocation status is invalid.");
  }
  return value as ObserverInvocationStatus;
}

function invocationPhase(value: string): ObserverInvocationPhase {
  if (!PHASE_VALUES.has(value as ObserverInvocationPhase)) {
    throw new ScopeViolationError("The observer invocation phase is invalid.");
  }
  return value as ObserverInvocationPhase;
}

function targetRole(value: string): ObserverTargetRole {
  if (value !== "agent" && value !== "gateway") {
    throw new ScopeViolationError("The observer target role is invalid.");
  }
  return value;
}

export function validateObserverInvocationFingerprint(value: string): string {
  if (!REQUEST_FINGERPRINT.test(value)) {
    throw new ScopeViolationError("The observer invocation request fingerprint is invalid.");
  }
  return value;
}

export function observerInvocationPhaseAtLeast(
  next: ObserverInvocationPhase,
  current: ObserverInvocationPhase,
): boolean {
  return PHASE_ORDER[next] >= PHASE_ORDER[current];
}

export function validateObserverInvocationCreate(
  input: CreateObserverInvocationRecord,
  qualification?: unknown,
): CreateObserverInvocationRecord {
  return Object.freeze({
    workId: safeToken(input.workId, "Observer invocation work ID"),
    namespaceId: safeToken(input.namespaceId, "Observer invocation Namespace ID"),
    agentId: safeToken(input.agentId, "Observer invocation Agent ID"),
    revisionId: safeToken(input.revisionId, "Observer invocation revision ID"),
    actorId: safeToken(input.actorId, "Observer invocation actor ID"),
    requestId: safeToken(input.requestId, "Observer invocation request ID"),
    requestFingerprint: validateObserverInvocationFingerprint(input.requestFingerprint),
    targetRole: targetRole(input.targetRole),
    plan: validateObserverInvocationPlan(input.plan, qualification),
  });
}

function highestObserverEvidencePhase(
  progress: Readonly<ObserverInvocationProgress>,
): ObserverInvocationPhase {
  if (progress.cleanup !== undefined) {
    return "cleanup";
  }
  if (progress.terminal !== undefined) {
    return "terminal";
  }
  if (progress.readiness !== undefined) {
    return "ready";
  }
  if (progress.observer !== undefined) {
    return "observer_created";
  }
  if (progress.targetResolution !== undefined) {
    return "target_resolved";
  }
  return "admitted";
}

function validateCheckpointStatus(
  phase: ObserverInvocationPhase,
  status: Exclude<ObserverInvocationStatus, "queued"> | undefined,
  progress: Readonly<ObserverInvocationProgress>,
): void {
  if (phase === "admitted") {
    if (status !== undefined) {
      throw new ScopeViolationError(
        "An admitted observer invocation cannot have an execution status.",
      );
    }
    return;
  }

  if (phase === "target_resolved" || phase === "observer_created" || phase === "ready") {
    if (status !== undefined && status !== "running") {
      throw new ScopeViolationError("An active observer phase permits only running status.");
    }
    return;
  }

  if (phase === "terminal") {
    if (status !== undefined) {
      throw new ScopeViolationError(
        "A terminal observer phase cannot settle before verified cleanup.",
      );
    }
    return;
  }

  if (status === undefined) {
    throw new ScopeViolationError("A cleaned observer invocation requires its terminal status.");
  }
  if (status === "running") {
    throw new ScopeViolationError("A cleaned observer invocation cannot remain running.");
  }

  const stopOutcome = progress.terminal?.stopOutcome;
  if (stopOutcome === undefined) {
    throw new ScopeViolationError(
      "A cleaned observer invocation requires terminal outcome evidence.",
    );
  }
  if (status === "succeeded" && stopOutcome !== "succeeded") {
    throw new ScopeViolationError("Observer invocation success conflicts with terminal evidence.");
  }
  if (status === "cancelled" && stopOutcome !== "cancelled") {
    throw new ScopeViolationError(
      "Observer invocation cancellation conflicts with terminal evidence.",
    );
  }
  if (status === "failed" && stopOutcome !== "failed" && stopOutcome !== "timed_out") {
    throw new ScopeViolationError("Observer invocation failure conflicts with terminal evidence.");
  }
}

export function validateObserverInvocationCheckpoint(
  input: ObserverInvocationCheckpoint,
  plan: Readonly<ObserverInvocationPlan>,
): ObserverInvocationCheckpoint {
  const completedPhase = invocationPhase(input.completedPhase);
  const progress: Readonly<ObserverInvocationProgress> =
    input.progress === undefined
      ? Object.freeze({})
      : validateObserverInvocationProgress(input.progress, plan);

  if (completedPhase === "admitted" && Object.keys(progress).length !== 0) {
    throw new ScopeViolationError(
      "An admitted observer invocation cannot carry execution evidence.",
    );
  }
  if (completedPhase === "target_resolved" && progress.targetResolution === undefined) {
    throw new ScopeViolationError("The target-resolved phase requires target-resolution evidence.");
  }
  if (completedPhase === "observer_created" && progress.observer === undefined) {
    throw new ScopeViolationError("The observer-created phase requires container evidence.");
  }
  if (completedPhase === "ready" && progress.readiness === undefined) {
    throw new ScopeViolationError("The ready phase requires readiness evidence.");
  }
  if (completedPhase === "terminal" && progress.terminal === undefined) {
    throw new ScopeViolationError("The terminal phase requires terminal evidence.");
  }
  if (
    completedPhase === "cleanup" &&
    (progress.terminal === undefined || progress.cleanup === undefined)
  ) {
    throw new ScopeViolationError("The cleanup phase requires terminal and cleanup evidence.");
  }

  const highestPhase = highestObserverEvidencePhase(progress);
  if (highestPhase !== completedPhase) {
    throw new ScopeViolationError(
      "Observer checkpoint phase does not match its highest evidence stage.",
    );
  }

  const status =
    input.status === undefined
      ? undefined
      : (invocationStatus(input.status) as Exclude<ObserverInvocationStatus, "queued">);
  validateCheckpointStatus(completedPhase, status, progress);

  return Object.freeze({
    completedPhase,
    ...(status === undefined ? {} : { status }),
    ...(input.progress === undefined ? {} : { progress }),
  });
}

export function validateObserverInvocationFailure(
  input: ObserverInvocationFailure,
): ObserverInvocationFailure {
  if (
    input.disposition !== "retry" &&
    input.disposition !== "permanent" &&
    input.disposition !== "defer"
  ) {
    throw new ScopeViolationError("Observer invocation failure disposition is invalid.");
  }
  const code = safeToken(input.code, "Observer invocation failure code");
  if (!isNonEmptyString(input.message) || input.message.length > FAILURE_MESSAGE_MAX_LENGTH) {
    throw new ScopeViolationError("Observer invocation failure message is invalid.");
  }
  if (input.disposition !== "defer") {
    if (input.delayMs !== undefined) {
      throw new ScopeViolationError("Only a deferred observer invocation failure has a delay.");
    }
    return Object.freeze({ disposition: input.disposition, code, message: input.message });
  }
  if (
    !Number.isSafeInteger(input.delayMs) ||
    input.delayMs! < 1 ||
    input.delayMs! > MAX_DEFER_DELAY_MS
  ) {
    throw new ScopeViolationError("The deferred observer invocation delay is invalid.");
  }
  return Object.freeze({
    disposition: "defer",
    code,
    message: input.message,
    delayMs: input.delayMs!,
  });
}

export function validateObserverInvocationReplay(
  existing: ObserverInvocationRecord,
  input: CreateObserverInvocationRecord,
): void {
  if (
    existing.namespaceId !== input.namespaceId ||
    existing.agentId !== input.agentId ||
    existing.revisionId !== input.revisionId ||
    existing.actorId !== input.actorId ||
    existing.requestId !== input.requestId ||
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.targetRole !== input.targetRole
  ) {
    throw new ResourceConflictError(
      "The observer invocation request ID has a different admitted plan.",
    );
  }
}

export function copyObserverInvocationRecord(
  record: ObserverInvocationRecord,
): Readonly<ObserverInvocationRecord> {
  return immutableCopy(record);
}
