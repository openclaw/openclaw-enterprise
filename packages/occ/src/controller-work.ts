import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { DeploymentRepositoryAccessStatus } from "./deployment-repository-access.ts";
import { ScopeViolationError } from "./errors.ts";

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

const CREDENTIAL_WITHDRAWAL_ACTION = "reconcile";

/** One key per request, so a withdrawal never replaces the revision's deployment key. */
export function credentialWithdrawalWorkKey(revisionId: string, operationId: string): string {
  return `agent_revision:${nonempty(revisionId, "Credential withdrawal revision")}:${CREDENTIAL_WITHDRAWAL_ACTION}:${CREDENTIAL_WITHDRAWAL_TARGET}:${nonempty(operationId, "Credential withdrawal operation")}`;
}

/** The request's operation ID, or undefined when the key is not this revision's withdrawal key. */
export function credentialWithdrawalOperationId(
  revisionId: string,
  idempotencyKey: string,
): string | undefined {
  const prefix = `agent_revision:${revisionId}:${CREDENTIAL_WITHDRAWAL_ACTION}:${CREDENTIAL_WITHDRAWAL_TARGET}:`;
  return idempotencyKey.startsWith(prefix) && idempotencyKey.length > prefix.length
    ? idempotencyKey.slice(prefix.length)
    : undefined;
}

export function isCredentialWithdrawalWork(
  work: Pick<ControllerWork, "revisionId" | "agentTarget">,
): boolean {
  return work.revisionId !== undefined && work.agentTarget === CREDENTIAL_WITHDRAWAL_TARGET;
}

/**
 * Whether a revision was admitted no later than `work` was created: the revisions a stop or
 * deletion owns. The PostgreSQL store stamps both on its own clock, so controller clock skew
 * cannot move a running revision past the stop (finding 1195); revisions it admitted before
 * that fix keep the controller's stamp. Both reads are truncated to milliseconds, and a tie
 * counts as earlier, so the stop still stops the revision.
 */
export function revisionAdmittedBeforeWork(
  revision: { readonly createdAt: string },
  work: { readonly createdAt: Date },
): boolean {
  return Date.parse(revision.createdAt) <= work.createdAt.getTime();
}

export interface EnqueueWork {
  readonly kind?: ControllerWorkKind;
  readonly idempotencyKey: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly actorId: string;
  readonly namespaceTarget?: "ready" | "deleted";
  /** See `CREDENTIAL_WITHDRAWAL_TARGET` for the revision-scoped target. */
  readonly agentTarget?:
    "stopped" | "deleted" | "provisioned" | "sandbox_policy" | typeof CREDENTIAL_WITHDRAWAL_TARGET;
  readonly availableAt?: Date | string;
}

export interface WorkResult {
  readonly code?: string;
  readonly resultData?: Readonly<Record<string, unknown>>;
}

export interface RetryableFailure {
  readonly code: string;
  readonly summary?: string;
}

export interface DeferredWork extends RetryableFailure {
  /** A refusal waiting on its candidate's stop; recorded in the deferral's evidence. */
  readonly refusal?: string;
  /** That stop yielded to other Work rather than failing; recorded as `stopYielded: true`. */
  readonly stopYielded?: boolean;
}

export interface PermanentFailure {
  readonly code: string;
  readonly data?: unknown;
  readonly summary?: string;
}

/**
 * Whether claimed work still holds a live lease. Leases are granted and expired on the
 * database clock; the controller's clock can disagree with it, so the store's own judgement
 * wins when it read one, and `now` is only a fallback for stores without a clock.
 */
export function controllerWorkLeaseActive(
  work: Readonly<ControllerWork>,
  now: Date = new Date(),
): boolean {
  if (work.state !== "claimed") {
    return false;
  }
  return (
    work.leaseActive ??
    (work.leaseExpiresAt !== undefined && work.leaseExpiresAt.getTime() > now.getTime())
  );
}

export function nonempty(value: string, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new ScopeViolationError(`${name} must be a nonempty string.`);
  }
  return value;
}
