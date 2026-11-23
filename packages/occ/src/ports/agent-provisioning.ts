import type { ControllerWork, WorkClaim } from "../controller-work.ts";

export type AgentProvisioningStatus = "queued" | "running" | "failed" | "succeeded" | "cancelled";

export type AgentProvisioningPhase = "admitted" | "configuration" | "transport" | "handoff";

export type AgentProvisioningEffectSettlement = ProvisioningEffectReceipt;

export interface AgentProvisioningRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly configurationId?: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly status: AgentProvisioningStatus;
  readonly completedPhase: AgentProvisioningPhase;
  readonly revisionId?: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly progress: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateAgentProvisioningRecord {
  readonly workId: string;
  readonly namespaceId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly plan: Readonly<Record<string, unknown>>;
}

export interface AgentProvisioningCheckpoint {
  readonly completedPhase: AgentProvisioningPhase;
  readonly status?: Exclude<AgentProvisioningStatus, "queued">;
  readonly agentId?: string;
  readonly configurationId?: string;
  readonly revisionId?: string;
  readonly progress?: Readonly<Record<string, unknown>>;
}

export interface AgentProvisioningFailure {
  /**
   * `defer` requeues the work after `delayMs` without spending an attempt: the attempt found
   * nothing it could act on yet (a pending effect still inside its settle window).
   */
  readonly disposition: "retry" | "permanent" | "defer";
  readonly code: string;
  readonly message: string;
  readonly delayMs?: number;
}

export interface AgentProvisioningReplay {
  readonly record: Readonly<AgentProvisioningRecord>;
  readonly replayed: boolean;
}

export interface AgentProvisioningWithWork {
  readonly record: Readonly<AgentProvisioningRecord>;
  readonly work?: Readonly<ControllerWork>;
}

export interface AgentProvisioningReadRepository {
  findByWorkId(workId: string): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  /** The job and its queue row from one statement, so both reflect the same commits. */
  findWithWork(workId: string): Promise<Readonly<AgentProvisioningWithWork> | undefined>;
  hasPendingNamespaceProvisioning(namespaceId: string): Promise<boolean>;
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
  create(
    record: CreateAgentProvisioningRecord,
    requestId?: string,
  ): Promise<Readonly<AgentProvisioningReplay>>;
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
  cancel(
    claim: WorkClaim,
    error: { readonly code: string; readonly message: string },
  ): Promise<Readonly<AgentProvisioningRecord>>;
  /**
   * Cancels the Agent's job before handoff. When a worker still held its claim, the job keeps
   * that claim's lease expiry, the latest moment its former attempt can still be writing.
   */
  cancelByAgent(
    namespaceId: string,
    agentId: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<{ readonly workId: string; readonly attemptId?: string } | undefined>;
  /**
   * Records the receipt for a cancelled job's unsettled transport write once the claim that
   * began it has lapsed, on the database clock. Returns undefined when nothing was settled.
   */
  settleAbandonedEffect(
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined>;
  retryByWorkId(
    namespaceId: string,
    workId: string,
    actorId: string,
  ): Promise<Readonly<AgentProvisioningRecord>>;
  /**
   * Clears a succeeded record's Configuration once its Agent selects another one, so that
   * Configuration can be deleted. Returns false when the record still holds it.
   */
  releaseConfiguration(namespaceId: string, configurationId: string): Promise<boolean>;
}

export type ProvisioningEffectKind = "configuration" | "transport";

export interface ProvisioningEffectTarget {
  readonly kind: ProvisioningEffectKind;
  readonly targetId?: string;
}

export interface ProvisioningPendingEffect extends ProvisioningEffectTarget {
  readonly owner?: string;
  readonly targetId: string;
  /**
   * When the effect was recorded, on the database clock (the repository stamps it). Effects
   * recorded before it existed have none.
   */
  readonly startedAt?: Date;
  readonly targetMatches: boolean;
  readonly ownerPresent: boolean;
}

export interface ProvisioningEffectReceipt extends ProvisioningEffectTarget {
  readonly owner: string;
  readonly targetId: string;
}
