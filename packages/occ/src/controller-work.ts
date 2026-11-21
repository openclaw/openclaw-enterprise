import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { DeploymentRepositoryAccessStatus } from "./deployment-repository-access.ts";

export interface WorkClaim {
  readonly idempotencyKey: string;
  readonly claimToken: string;
}

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
  /** The claim's audit event ID. Independent of the lease token and the retry count. */
  readonly auditAttemptId?: string;
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

export type ControllerWorkLookup = Pick<ReadonlyMap<string, Readonly<ControllerWork>>, "get">;

export type DeploymentStatus = "queued" | "running" | "succeeded" | "failed";

export interface DeploymentStatusError {
  readonly code: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DeploymentStatusResult {
  readonly deploymentId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly status: DeploymentStatus;
  readonly error: DeploymentStatusError | null;
  readonly repositoryAccess?: DeploymentRepositoryAccessStatus;
  readonly warnings: readonly PluginDeploymentWarning[];
  readonly progress: {
    readonly lastAttempt: {
      readonly at: string;
      readonly code: string;
      readonly message: string;
    } | null;
    readonly nextAttemptAt: string | null;
  } | null;
  readonly cleanup: {
    readonly status: DeploymentStatus;
    readonly nextAttemptAt: string | null;
  } | null;
}

export interface ControllerWorkAttempt {
  readonly at: Date;
  readonly code: string;
  /** The refusal a `REFUSED_CANDIDATE_STOP_PENDING` deferral waits to publish. */
  readonly refusal?: string;
}

export interface PluginDeploymentWarning {
  readonly code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED";
  readonly pluginId: string;
}

export function workMatchesRevision(
  work: ControllerWork,
  revision: Pick<AgentRevision, "id" | "namespaceId" | "agentId">,
): boolean {
  return (
    work.namespaceId === revision.namespaceId &&
    work.agentId === revision.agentId &&
    work.revisionId === revision.id
  );
}
