export type ControllerWorkState = "queued" | "claimed" | "succeeded" | "failed_permanent";

export type ControllerWorkKind = "lifecycle" | "provisioning";

/**
 * Revision-scoped work that revokes credential sources from a running revision. It names the
 * revision but is not a deployment: it never prepares, activates, or supersedes it, and it owns
 * no repository-credential cleanup. The value is persisted in `controller_work.agent_target`.
 */
export const CREDENTIAL_WITHDRAWAL_TARGET = "credentials_withdrawn";

export interface ControllerWork {
  readonly kind: ControllerWorkKind;
  readonly idempotencyKey: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly actorId: string;
  readonly namespaceTarget?: "ready" | "deleted";
  /** See `CREDENTIAL_WITHDRAWAL_TARGET` for the revision-scoped target. */
  readonly agentTarget?:
    "stopped" | "deleted" | "provisioned" | "sandbox_policy" | typeof CREDENTIAL_WITHDRAWAL_TARGET;
  readonly state: ControllerWorkState;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: Date;
  /** Claim liveness judged by the State store's clock when it read this work. */
  readonly leaseActive?: boolean;
  readonly completedAt?: Date;
  readonly reasonCode?: string;
  readonly resultData?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimedWork extends ControllerWork {
  readonly state: "claimed";
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
  /**
   * Milliseconds since `createdAt` when the claim was granted or renewed, by the State store's
   * clock. `createdAt` is on that clock too, so subtracting it from the controller's clock would
   * shift the age by their skew.
   */
  readonly ageMs: number;
}
