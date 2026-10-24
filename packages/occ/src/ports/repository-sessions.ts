import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryApprovalScope,
  RepositoryExecutionIdentity,
} from "@openclaw-enterprise/contracts";

export interface RepositoryRevisionOwner {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

export type RepositorySessionPhase = "opening" | "open" | "closing" | "disposed" | "invalidated";

/** Safe recovery identifiers only; gateway bearer material never belongs in State. */
export interface RepositorySessionAttempt extends RepositoryRevisionOwner {
  /** Cleared when the live revision is physically deleted; phase retains disposal evidence. */
  readonly liveRevisionId: string | null;
  readonly cleanupContext: {
    readonly driver: NonNullable<AgentRevision["repositoryCredentials"]>["driver"];
    readonly binding: AdmittedRepositoryBinding;
  };
  readonly repositoryRef: string;
  readonly admissionId: string;
  readonly durationSeconds: number;
  readonly deadlineWallMs: number;
  readonly phase: RepositorySessionPhase;
  /** 0, 1: historical brokers; 2: OCC session; 3: prepared-only native broker. */
  readonly brokerProtocol: 0 | 1 | 2 | 3;
  readonly predecessorAdmissionId?: string;
  readonly executionFingerprint?: string;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Nonsecret evidence owned by the exact persisted repository attempt. */
export interface RepositoryBrokerReceipt {
  readonly admissionId: string;
  readonly state: "fenced" | "reserved" | "active" | "disposed";
  readonly generation?: string;
  readonly sessionId?: string;
  readonly deadlineWallMs?: number;
  readonly revoked?: number;
  readonly expired?: number;
}

export interface RepositoryStandingApproval {
  readonly generation: number;
  readonly scope: RepositoryApprovalScope;
  readonly scopeFingerprint: string;
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly binding: AdmittedRepositoryBinding;
  readonly approvedBy: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface RepositorySessionReadRepository {
  findStandingExecution(
    owner: RepositoryRevisionOwner,
  ): Promise<(RepositoryExecutionIdentity & { readonly closed: boolean }) | undefined>;
  listStandingApprovals(
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<RepositoryStandingApproval>[]>;
  findStandingApproval(
    namespaceId: string,
    agentId: string,
    repositoryRef: string,
  ): Promise<Readonly<RepositoryStandingApproval> | undefined>;
  findAttempt(admissionId: string): Promise<Readonly<RepositorySessionAttempt> | undefined>;
  findBrokerReceipt(admissionId: string): Promise<Readonly<RepositoryBrokerReceipt> | undefined>;
  findBrokerReceiptBySession(
    sessionId: string,
  ): Promise<Readonly<RepositoryBrokerReceipt> | undefined>;
  listRevisionAttempts(
    owner: RepositoryRevisionOwner,
  ): Promise<readonly Readonly<RepositorySessionAttempt>[]>;
  listNamespaceAttempts(
    namespaceId: string,
  ): Promise<readonly Readonly<RepositorySessionAttempt>[]>;
}

export interface RepositorySessionRepository extends RepositorySessionReadRepository {
  recordStandingExecution(
    owner: RepositoryRevisionOwner,
    execution: RepositoryExecutionIdentity,
  ): Promise<void>;
  approveStanding(
    input: Omit<RepositoryStandingApproval, "generation" | "revokedAt">,
  ): Promise<Readonly<RepositoryStandingApproval>>;
  /** Withdraw this active approval generation or report a conflict; never remove its successor. */
  revokeStanding(
    approval: Pick<RepositoryStandingApproval, "namespaceId" | "agentId" | "id" | "generation">,
    at: string,
  ): Promise<void>;
  /** Serialize receipt changes with the exact attempt and its owner. */
  lockAttempt(admissionId: string): Promise<Readonly<RepositorySessionAttempt> | undefined>;
  createBrokerReceipt(input: {
    readonly admissionId: string;
    readonly state: "fenced" | "reserved";
    readonly generation?: string;
  }): Promise<Readonly<RepositoryBrokerReceipt>>;
  advanceBrokerReceipt(input: {
    readonly admissionId: string;
    readonly expectedState: "reserved" | "active";
    readonly generation: string;
    readonly state: "active" | "disposed";
    readonly sessionId: string;
    readonly deadlineWallMs: number;
    readonly revoked?: number;
    readonly expired?: number;
  }): Promise<Readonly<RepositoryBrokerReceipt> | undefined>;
  /** A broker abandons its own reservation; no session was handed out for it. */
  fenceBrokerReceipt(input: {
    readonly admissionId: string;
    readonly generation: string;
  }): Promise<Readonly<RepositoryBrokerReceipt> | undefined>;
  /** Persists the immutable request identity in the opening phase before external admission. */
  createAttempt(
    input: RepositoryRevisionOwner & {
      readonly repositoryRef: string;
      readonly admissionId: string;
      readonly durationSeconds: number;
      readonly deadlineWallMs: number;
      readonly createdAt: string;
      readonly brokerProtocol?: 1 | 2 | 3;
      readonly predecessorAdmissionId?: string;
      readonly executionFingerprint?: string;
    },
  ): Promise<Readonly<RepositorySessionAttempt>>;
  /** Compare-and-set phase changes preserve ownership, request fields, and any known session ID. */
  advanceAttempt(input: {
    readonly admissionId: string;
    readonly expectedPhase: RepositorySessionPhase;
    readonly phase: RepositorySessionPhase;
    readonly sessionId?: string;
    readonly updatedAt: string;
  }): Promise<Readonly<RepositorySessionAttempt> | undefined>;
}
