import type { CREDENTIAL_WITHDRAWAL_TARGET } from "../controller-work.ts";
import type { AgentDeploymentWorkReader } from "./agent-reads.ts";

interface PlatformOperationBase {
  readonly action: "reconcile";
  readonly namespaceId: string;
  readonly resourceId: string;
  readonly actorId: string;
}

export type PlatformOperation =
  | (PlatformOperationBase & {
      readonly kind: "namespace";
      readonly target: "ready" | "deleted";
    })
  | (PlatformOperationBase & {
      readonly kind: "agent_revision";
      readonly target?: never;
    })
  | (PlatformOperationBase & {
      /** Revokes pending credential withdrawals from an active revision; never deploys it. */
      readonly kind: "agent_revision";
      readonly target: typeof CREDENTIAL_WITHDRAWAL_TARGET;
      readonly operationId: string;
    })
  | (PlatformOperationBase & {
      readonly kind: "agent";
      readonly target: "stopped" | "sandbox_policy";
      readonly operationId: string;
    })
  | (PlatformOperationBase & {
      /**
       * Agent teardown is scoped to the Agent, not one revision: it retires
       * every revision the Agent owns.
       */
      readonly kind: "agent";
      readonly target: "deleted";
      readonly operationId?: never;
    });

export interface PlatformOperationReadRepository extends AgentDeploymentWorkReader {
  list(): Promise<readonly Readonly<PlatformOperation>[]>;
  /**
   * `list()` without finished deployment work for a revision under its own reconcile key.
   * That work cannot change a deployment inventory, so its history is never read. Other work
   * is returned in `list()` order, including rows that need a refusal.
   */
  listUnsettledOperations(): Promise<readonly Readonly<PlatformOperation>[]>;
  /** True while credential withdrawal work for the revision is queued or claimed. */
  hasOutstandingCredentialWithdrawalWork(namespaceId: string, revisionId: string): Promise<boolean>;
}

export interface PlatformOperationRepository extends PlatformOperationReadRepository {
  append(operation: PlatformOperation, requestId?: string): Promise<void>;
  /**
   * Requeue the exact deleting Agent's terminal teardown initiated by
   * `initiatingActorId`, assigning it to `actorId` (the same actor for a plain
   * retry, another for a takeover).
   */
  retryFailedAgentDeletion(
    namespaceId: string,
    agentId: string,
    initiatingActorId: string,
    actorId: string,
  ): Promise<boolean>;
  /**
   * Requeue the exact deleting Namespace's terminal teardown initiated by
   * `initiatingActorId`, assigning it to `actorId` (the same actor for a plain
   * retry, another for a takeover).
   */
  retryFailedNamespaceDeletion(
    namespaceId: string,
    initiatingActorId: string,
    actorId: string,
  ): Promise<boolean>;
  /**
   * Makes the revision's queued credential withdrawal work claimable now instead of at its
   * scheduled time. Claimed work is left alone. True when any queued work was waiting.
   */
  expediteCredentialWithdrawalWork(namespaceId: string, revisionId: string): Promise<boolean>;
}
