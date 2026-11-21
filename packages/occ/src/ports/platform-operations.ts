import type {
  CREDENTIAL_WITHDRAWAL_TARGET,
  ControllerWork,
  ControllerWorkAttempt,
  ControllerWorkLookup,
} from "../controller-work.ts";
import type { RepositoryRevisionOwner } from "./repository-sessions.ts";

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

export interface PlatformOperationReadRepository {
  list(): Promise<readonly Readonly<PlatformOperation>[]>;
  findWork(idempotencyKey: string): Promise<Readonly<ControllerWork> | undefined>;
  findWorkByKeys(idempotencyKeys: readonly string[]): Promise<ControllerWorkLookup>;
  findWorkAttempt(idempotencyKey: string): Promise<Readonly<ControllerWorkAttempt> | undefined>;
  /** Whether this revision completed maintenance requiring fresh repository execution. */
  hasRepositoryExecutionRedeployRequired(owner: RepositoryRevisionOwner): Promise<boolean>;
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
