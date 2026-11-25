import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { ControllerWork, WorkClaim } from "./controller-work.ts";

export type ObserverInvocationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

import type {
  ObserverAbsenceEvidence,
  ObserverCleanupEvidence,
  ObserverContainerEvidence,
  ObserverCreateDispatchEvidence,
  ObserverInvocationPlan,
  ObserverInvocationPlanInput,
  ObserverReadinessEvidence,
  ObserverTargetResolutionEvidence,
  ObserverTargetRole,
  ObserverTerminalEvidence,
} from "@openclaw-enterprise/contracts";

export interface ObserverInvocationRetryResume {
  readonly failedPhase: ObserverInvocationPhase;
  readonly resumeFrom: "target_resolution" | "observer_creation_reconciliation" | "cleanup";
}

export interface ObserverInvocationProgress {
  readonly observerAbsence?: Readonly<ObserverAbsenceEvidence>;
  readonly targetResolution?: Readonly<ObserverTargetResolutionEvidence>;
  readonly observerCreateDispatch?: Readonly<ObserverCreateDispatchEvidence>;

  readonly observer?: Readonly<ObserverContainerEvidence>;
  readonly readiness?: Readonly<ObserverReadinessEvidence>;
  readonly terminal?: Readonly<ObserverTerminalEvidence>;
  readonly cleanup?: Readonly<ObserverCleanupEvidence>;
  readonly retryResume?: Readonly<ObserverInvocationRetryResume>;
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

function observerInvocationPlanForPersistence(
  plan: Readonly<ObserverInvocationPlanInput>,
  qualificationValue: unknown,
): ObserverInvocationPlan {
  if (
    typeof qualificationValue !== "object" ||
    qualificationValue === null ||
    Array.isArray(qualificationValue)
  ) {
    throw new ScopeViolationError(
      "Observer invocation admission requires an accepted qualification.",
    );
  }
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new ScopeViolationError("Observer invocation plan must be an object.");
  }
  const qualification = qualificationValue as Readonly<Record<string, unknown>>;
  if (typeof qualification.qualificationId !== "string") {
    throw new ScopeViolationError("Observer invocation qualification ID is unavailable.");
  }
  return Object.freeze({
    qualificationId: qualification.qualificationId,
    ...plan,
  });
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
    plan: observerInvocationPlanForPersistence(input.plan, qualification),
  });
}

function observerInvocationProgressForPersistence(
  value: Readonly<ObserverInvocationProgress>,
): Readonly<ObserverInvocationProgress> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError("Observer invocation progress must be an object.");
  }
  const observerCreateDispatch = value.observerCreateDispatch;
  if (observerCreateDispatch !== undefined) {
    if (
      typeof observerCreateDispatch !== "object" ||
      observerCreateDispatch === null ||
      Array.isArray(observerCreateDispatch)
    ) {
      throw new ScopeViolationError("Observer create-dispatch evidence must be an object.");
    }
    if (
      Object.keys(observerCreateDispatch).length !== 2 ||
      !Object.hasOwn(observerCreateDispatch, "invocationId") ||
      !Object.hasOwn(observerCreateDispatch, "dispatchedAt")
    ) {
      throw new ScopeViolationError("Observer create-dispatch evidence fields are invalid.");
    }
    safeToken(observerCreateDispatch.invocationId, "Observer create-dispatch invocation ID");
    if (!isNonEmptyString(observerCreateDispatch.dispatchedAt)) {
      throw new ScopeViolationError("Observer create-dispatch time is unavailable.");
    }
    if (value.targetResolution === undefined || value.observerAbsence !== undefined) {
      throw new ScopeViolationError(
        "Observer create dispatch requires target resolution without verified observer absence.",
      );
    }
  }

  const retryResume = value.retryResume;
  if (retryResume !== undefined) {
    if (typeof retryResume !== "object" || retryResume === null || Array.isArray(retryResume)) {
      throw new ScopeViolationError("Observer retry-resume state must be an object.");
    }
    const failedPhase = invocationPhase(retryResume.failedPhase);
    if (
      retryResume.resumeFrom !== "target_resolution" &&
      retryResume.resumeFrom !== "observer_creation_reconciliation" &&
      retryResume.resumeFrom !== "cleanup"
    ) {
      throw new ScopeViolationError("Observer retry-resume target is invalid.");
    }
    if (
      retryResume.resumeFrom === "target_resolution" &&
      value.cleanup === undefined &&
      value.observerAbsence === undefined
    ) {
      throw new ScopeViolationError(
        "Observer retry target resolution requires verified cleanup or observer absence.",
      );
    }
    if (
      retryResume.resumeFrom === "observer_creation_reconciliation" &&
      (failedPhase !== "observer_created" ||
        value.observerCreateDispatch === undefined ||
        value.observer !== undefined)
    ) {
      throw new ScopeViolationError(
        "Observer create reconciliation requires uncertain dispatched observer creation without observer evidence.",
      );
    }

    if (retryResume.resumeFrom === "cleanup" && failedPhase !== "cleanup") {
      throw new ScopeViolationError("Observer retry cleanup requires cleanup as the failed phase.");
    }
  }
  return Object.freeze({ ...value });
}

export function validateObserverInvocationCheckpoint(
  input: ObserverInvocationCheckpoint,
  _plan: Readonly<ObserverInvocationPlan>,
): ObserverInvocationCheckpoint {
  const completedPhase = invocationPhase(input.completedPhase);
  const status =
    input.status === undefined
      ? undefined
      : (invocationStatus(input.status) as Exclude<ObserverInvocationStatus, "queued">);
  const progress =
    input.progress === undefined
      ? undefined
      : observerInvocationProgressForPersistence(input.progress);

  return Object.freeze({
    completedPhase,
    ...(status === undefined ? {} : { status }),
    ...(progress === undefined ? {} : { progress }),
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
