import { immutableCopy, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";

import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type {
  ProvisioningEffectReceipt,
  ProvisioningEffectTarget,
} from "../provisioning-effects.ts";
import type { WorkClaim } from "./controller-work.ts";

export type ControllerWorkKind = "lifecycle" | "provisioning";

export type AgentProvisioningStatus = "queued" | "running" | "failed" | "succeeded" | "cancelled";

export type AgentProvisioningPhase =
  "admitted" | "secrets" | "database_setup" | "configuration" | "transport" | "handoff";

export type AgentProvisioningEffectSettlement = ProvisioningEffectReceipt;

export interface AgentProvisioningRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly fingerprintKeyVersion: string;
  readonly status: AgentProvisioningStatus;
  readonly completedPhase: AgentProvisioningPhase;
  readonly secretCursor: number;
  readonly secretCount: number;
  readonly configurationGeneration?: number;
  readonly revisionId?: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly protectedInputs: Readonly<Record<string, unknown>>;
  readonly progress: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateAgentProvisioningRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly fingerprintKeyVersion: string;
  readonly secretCount: number;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly protectedInputs: Readonly<Record<string, unknown>>;
}

export interface AgentProvisioningCheckpoint {
  readonly completedPhase: AgentProvisioningPhase;
  readonly status?: Exclude<AgentProvisioningStatus, "queued">;
  readonly secretCursor?: number;
  readonly configurationGeneration?: number;
  readonly revisionId?: string;
  readonly progress?: Readonly<Record<string, unknown>>;
  readonly protectedInputs?: Readonly<Record<string, unknown>>;
}

export interface AgentProvisioningFailure {
  readonly disposition: "retry" | "permanent";
  readonly code: string;
  readonly message: string;
}

export interface AgentProvisioningReplay {
  readonly record: Readonly<AgentProvisioningRecord>;
  readonly replayed: boolean;
}

export interface AgentProvisioningReadRepository {
  findByWorkId(workId: string): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  findByAgent(
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  findByConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  findByRequest(
    namespaceId: string,
    actorId: string,
    requestId: string,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
}

export interface AgentProvisioningRepository extends AgentProvisioningReadRepository {
  create(record: CreateAgentProvisioningRecord): Promise<Readonly<AgentProvisioningReplay>>;
  beginEffect(
    claim: WorkClaim,
    effect: ProvisioningEffectTarget,
  ): Promise<Readonly<AgentProvisioningRecord>>;
  checkpoint(
    claim: WorkClaim,
    checkpoint: AgentProvisioningCheckpoint,
  ): Promise<Readonly<AgentProvisioningRecord>>;
  recordFailure(
    claim: WorkClaim,
    checkpoint: AgentProvisioningCheckpoint,
    failure: AgentProvisioningFailure,
  ): Promise<Readonly<AgentProvisioningRecord>>;
  settleEffect(
    workId: string,
    settlement: AgentProvisioningEffectSettlement,
  ): Promise<Readonly<AgentProvisioningRecord>>;
  completeEffectCleanup(
    workId: string,
    owner: string,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  cancel(
    claim: WorkClaim,
    error: { readonly code: string; readonly message: string },
  ): Promise<Readonly<AgentProvisioningRecord>>;
  cancelByAgent(
    namespaceId: string,
    agentId: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  retryByAgent(
    namespaceId: string,
    agentId: string,
    actorId: string,
  ): Promise<Readonly<AgentProvisioningRecord>>;
}

const PHASE_ORDER: Record<AgentProvisioningPhase, number> = Object.freeze({
  admitted: 0,
  secrets: 1,
  database_setup: 2,
  configuration: 3,
  transport: 4,
  handoff: 5,
});

const STATUS_VALUES = new Set(["queued", "running", "failed", "succeeded", "cancelled"]);
const PHASE_VALUES = new Set(Object.keys(PHASE_ORDER));
const SAFE_TOKEN = /^[A-Za-z0-9._~:@/-]{1,200}$/u;
const EFFECT_OWNER = /^[A-Za-z0-9._~:@/-]{1,600}$/u;
const REQUEST_FINGERPRINT = /^[a-f0-9]{64}$/u;
const FAILURE_MESSAGE_MAX_LENGTH = 1_000;

function objectRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError(`${name} must be an object.`);
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

function safeToken(value: string, name: string): string {
  if (!isNonEmptyString(value) || !SAFE_TOKEN.test(value)) {
    throw new ScopeViolationError(`${name} must be a safe identifier.`);
  }
  return value;
}

function effectOwner(value: string): string {
  if (!isNonEmptyString(value) || !EFFECT_OWNER.test(value)) {
    throw new ScopeViolationError("Agent provisioning effect owner must be a safe identifier.");
  }
  return value;
}

function phase(value: string): AgentProvisioningPhase {
  if (!PHASE_VALUES.has(value)) {
    throw new ScopeViolationError("The Agent provisioning phase is invalid.");
  }
  return value as AgentProvisioningPhase;
}

function status(value: string): AgentProvisioningStatus {
  if (!STATUS_VALUES.has(value)) {
    throw new ScopeViolationError("The Agent provisioning status is invalid.");
  }
  return value as AgentProvisioningStatus;
}

export function validateProvisioningFingerprint(value: string): string {
  if (!REQUEST_FINGERPRINT.test(value)) {
    throw new ScopeViolationError("The Agent provisioning request fingerprint is invalid.");
  }
  return value;
}

export function phaseAtLeast(
  next: AgentProvisioningPhase,
  current: AgentProvisioningPhase,
): boolean {
  return PHASE_ORDER[next] >= PHASE_ORDER[current];
}

export function validateProvisioningCreate(
  input: CreateAgentProvisioningRecord,
): CreateAgentProvisioningRecord {
  const secretCount = input.secretCount;
  if (!Number.isSafeInteger(secretCount) || secretCount < 0) {
    throw new ScopeViolationError("Agent provisioning Secret count must be a safe integer.");
  }
  return Object.freeze({
    workId: safeToken(input.workId, "Agent provisioning work ID"),
    namespaceId: safeToken(input.namespaceId, "Agent provisioning Namespace ID"),
    agentId: safeToken(input.agentId, "Agent provisioning Agent ID"),
    configurationId: safeToken(input.configurationId, "Agent provisioning Configuration ID"),
    actorId: safeToken(input.actorId, "Agent provisioning actor ID"),
    requestId: safeToken(input.requestId, "Agent provisioning request ID"),
    requestFingerprint: validateProvisioningFingerprint(input.requestFingerprint),
    fingerprintKeyVersion: safeToken(
      input.fingerprintKeyVersion,
      "Agent provisioning fingerprint key version",
    ),
    secretCount,
    plan: objectRecord(input.plan, "Agent provisioning plan"),
    protectedInputs: objectRecord(input.protectedInputs, "Agent provisioning protected inputs"),
  });
}

export function validateProvisioningCheckpoint(
  input: AgentProvisioningCheckpoint,
): AgentProvisioningCheckpoint {
  const completedPhase = phase(input.completedPhase);
  const normalized: AgentProvisioningCheckpoint = {
    completedPhase,
    ...(input.status === undefined
      ? {}
      : { status: status(input.status) as Exclude<AgentProvisioningStatus, "queued"> }),
    ...(input.secretCursor === undefined
      ? {}
      : { secretCursor: positiveCursor(input.secretCursor) }),
    ...(input.configurationGeneration === undefined
      ? {}
      : { configurationGeneration: positiveCursor(input.configurationGeneration) }),
    ...(input.revisionId === undefined
      ? {}
      : { revisionId: safeToken(input.revisionId, "Agent provisioning revision ID") }),
    ...(input.progress === undefined
      ? {}
      : { progress: objectRecord(input.progress, "Agent provisioning progress") }),
    ...(input.protectedInputs === undefined
      ? {}
      : {
          protectedInputs: objectRecord(
            input.protectedInputs,
            "Agent provisioning protected inputs",
          ),
        }),
  };
  return Object.freeze(normalized);
}

export function validateProvisioningFailure(
  input: AgentProvisioningFailure,
): AgentProvisioningFailure {
  if (input.disposition !== "retry" && input.disposition !== "permanent") {
    throw new ScopeViolationError("Agent provisioning failure disposition is invalid.");
  }
  const code = safeToken(input.code, "Agent provisioning failure code");
  if (!isNonEmptyString(input.message) || input.message.length > FAILURE_MESSAGE_MAX_LENGTH) {
    throw new ScopeViolationError("Agent provisioning failure message is invalid.");
  }
  return Object.freeze({ disposition: input.disposition, code, message: input.message });
}

export function validateProvisioningEffectSettlement(
  input: AgentProvisioningEffectSettlement,
): AgentProvisioningEffectSettlement {
  const kind = input.kind;
  if (kind !== "secret" && kind !== "configuration" && kind !== "transport") {
    throw new ScopeViolationError("Agent provisioning effect kind is invalid.");
  }
  return Object.freeze({
    kind,
    owner: effectOwner(input.owner),
    targetId: safeToken(input.targetId, "Agent provisioning effect target"),
    ...(input.secretId === undefined
      ? {}
      : { secretId: safeToken(input.secretId, "Agent provisioning Secret effect target") }),
    ...(input.result === undefined
      ? {}
      : { result: objectRecord(input.result, "Agent provisioning effect result") }),
  });
}

function positiveCursor(value: number): number {
  if (value === 0) {
    return 0;
  }
  if (!isPositiveSafeInteger(value)) {
    throw new ScopeViolationError("Agent provisioning numeric progress is invalid.");
  }
  return value;
}

export function validateProvisioningReplay(
  existing: AgentProvisioningRecord,
  input: CreateAgentProvisioningRecord,
): void {
  if (
    existing.namespaceId !== input.namespaceId ||
    existing.actorId !== input.actorId ||
    existing.requestId !== input.requestId ||
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.fingerprintKeyVersion !== input.fingerprintKeyVersion ||
    existing.agentId !== input.agentId ||
    existing.configurationId !== input.configurationId
  ) {
    throw new ResourceConflictError("The Agent provisioning request ID has a different plan.");
  }
}

export function copyProvisioningRecord(
  record: AgentProvisioningRecord,
): Readonly<AgentProvisioningRecord> {
  return immutableCopy(record);
}

export const provisioningPhaseOrder = Object.freeze({ ...PHASE_ORDER });
