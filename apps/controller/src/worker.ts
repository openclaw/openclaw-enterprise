import { installationDriverConfigurations } from "./composition/installation-config.ts";
import {
  DriverConfigurationRegistry,
  type DriverConfigurationRegistration,
} from "@openclaw-enterprise/occ";
import { reconcileSandboxPolicy, failAbandonedSandboxPolicies } from "./worker/sandbox-policy.ts";
import { isSecretHarnessAuth, isServiceAccountHarnessAuth } from "@openclaw-enterprise/contracts";
import { isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isSandboxFacet, normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import type {
  Agent,
  AgentRevision,
  AgentRevisionMetadata,
  CredentialSource,
  AuditEvent,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  ComputePrepareRevisionFailureDiagnostic,
  CredentialWithdrawal,
  PluginDeploymentWarning,
  PluginDriver,
  ComputeReadiness,
  RepoDriver,
  RepositoryCredentialMaterialRef,
  ComputeRevisionContext,
  ConfigurationDriver,
  Driver,
  IAMDriver,
  Installation,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  BackendDefinition,
  SandboxDriver,
  CredentialGatewayDriver,
  SecretBindings,
  SecretDriver,
  ResolvedHarnessAuth,
  RuntimeFailureEvidence,
  SecretEnvironmentProjection,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import {
  NativeIAMDriver,
  validatePersistedNativeIAMState,
  type NativeIAMState,
} from "@openclaw-enterprise/iam";
import {
  PostgresPlatformState,
  PostgresWorkQueue,
  OpenClawController,
  ActivationFailedError,
  ComputePreparationFailedError,
  ActivationPendingError,
  CredentialSourceRevisionError,
  CredentialWithdrawalRefusedError,
  SandboxGatewayUnauthorizedError,
  SandboxGatewayUnavailableError,
  SANDBOX_DELETION_UNCONFIRMED,
  operationRefusalHint,
  SandboxRevisionUnsupportedError,
  ScopeViolationError,
  TransientDependencyError,
  WorkClaimLostError,
  CREDENTIAL_WITHDRAWAL_TARGET,
  credentialWithdrawalCompanionRevisions,
  isCredentialWithdrawalWork,
  isRepositoryCleanupWork,
  repositoryCleanupRevisionId,
  revisionAdmittedBeforeWork,
  isRepositoryRuntimeRetirementWork,
  provisioningEffectReceipt as provisioningEffectReceiptForRecord,
  provisioningPendingEffect,
  type ClaimedWork,
  type ControllerWork,
  type NativeWorkerSupport,
  type ProvisioningEffectReceipt,
  type PlatformReadView,
  type PlatformUnitOfWork,
  type PostgresPool,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
  validateRuntimeFailureEvidence,
} from "@openclaw-enterprise/occ";
import {
  backendDefinitionMap,
  removeNamespacePolicy,
  removedPolicyDetails,
  validateBackendDefinitions,
  validateServiceAccountBackendBinding,
} from "@openclaw-enterprise/occ";
import type { InstallationRuntimeDrivers } from "./composition/installation-config.ts";
import { resolveApprovedHarness } from "./composition/production-harness.ts";
import {
  ComputeStopYieldedError,
  withComputeAbortSignal,
  withComputeWorkWaiting,
  withYieldingComputeStop,
} from "./drivers/compute/operation-context.ts";
import type { OccMetrics, WorkKind, WorkOutcome } from "./metrics/index.ts";
import {
  isStopYieldedCode,
  PredecessorStopYieldedError,
  type StopYieldedCode,
  StopYields,
  stopWithDrainYield,
  stopYieldedCode,
  stopYieldRecheckMs,
} from "./worker/stop-yields.ts";
import {
  RepositoryCredentialAuthorityError,
  repositoryCleanupFailureCode,
  RepositoryCredentialLifecycle,
} from "./worker/repository-credentials.ts";

/**
 * Connection limits for the worker's main PostgreSQL pool. The worker is serial, so one query
 * on a connection that went silent (a failover or partition with no RST) would otherwise stop
 * every claim forever. `query_timeout` is client-side: it abandons the query, the transaction
 * owner discards the connection, and the loop retries on a fresh one. It is not sent to the
 * server, so poolers and migrations are unaffected. Size it well above any legitimate query.
 * TCP keepalive only prunes dead idle connections eventually (kernel probe defaults apply).
 */
export function workerDatabasePoolOptions(timeoutMs: number) {
  const timeout = positiveInteger(timeoutMs, "Worker database timeout");
  return {
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
  } as const;
}

export interface ControllerWorkerOptions {
  readonly metrics?: OccMetrics;
  readonly pool: PostgresPool & PostgresQueryClient;
  readonly mode?: "development" | "production";
  readonly drivers?: InstallationRuntimeDrivers;
  readonly computeDriver?: ComputeDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly credentialGatewayDriver?: CredentialGatewayDriver;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly convergenceTimeoutMs?: number;
  readonly emit?: (event: Readonly<Record<string, unknown>>) => void;
  readonly onHealthy?: () => Promise<void>;
  /**
   * Called, at most once per health interval, when the run loop starts a pass or a claim
   * heartbeat renews. It goes quiet only while the loop is stuck, so a liveness probe can tell
   * a wedged worker from one waiting out a database outage (each pass then fails fast).
   */
  readonly onProgress?: () => Promise<void>;
}

type Observation = NamespaceEnsureResult | NamespaceDeleteResult;
type Outcome = "success" | "pending" | "retry" | "permanent";

// A revision whose runtime is not ready yet is progress, not a failure. Recheck
// it on a short cadence so earlier transient failures on the same Work do not
// stretch readiness waits through the queue's exponential retry backoff. The
// worker is serial and each recheck is a full preparation pass (0.2-1.7 s live),
// so the cadence grows with the deployment's age, from 500 ms to 5 s at 200 s:
// a runtime that stays unready for minutes cannot take half the worker (D223).
const REVISION_READINESS_RECHECK_MS = 500;
const REVISION_READINESS_RECHECK_MAX_MS = 5_000;
const REVISION_READINESS_RECHECK_AGE_DIVISOR = 40;

// Pending reason codes for an unready revision. Compute may say why it waits.
const REVISION_PENDING_CODES: Readonly<Record<string, string>> = Object.freeze({
  WORKLOAD_UNSCHEDULABLE: "REVISION_UNSCHEDULABLE",
  WORKLOAD_IMAGE_PULL_FAILED: "REVISION_IMAGE_PULL_FAILED",
  NAMESPACE_POD_QUOTA_EXCEEDED: "NAMESPACE_POD_QUOTA_EXCEEDED",
  WORKSPACE_NODE_PENDING: "WORKSPACE_NODE_PENDING",
  WORKSPACE_SETUP_RETRYING: "WORKSPACE_SETUP_RETRYING",
  HARNESS_CREDENTIAL_BOOTSTRAP_PENDING: "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
});
const REVISION_READINESS_CODES: ReadonlySet<string> = new Set([
  "REVISION_INCOMPLETE",
  "WORKSPACE_NODE_BINDING_PENDING",
  ...Object.values(REVISION_PENDING_CODES),
]);

// A candidate revision's own deployment work: the only work that observes its OAuth bootstrap.
// An active revision's source is already consumed.
function isCandidateDeployment(claim: ClaimedWork): boolean {
  return claim.idempotencyKey === `agent_revision:${claim.revisionId}:reconcile`;
}

// A refused candidate whose stop keeps failing waits on that stop, which can block the serial
// worker for minutes (Kubernetes waits for gateway and Agent Pods to terminate). Each failed stop
// doubles its recheck from the readiness cadence up to 5 minutes, and waits at least four times
// as long as that stop took, so a blocked stop holds at most a fifth of the worker and other
// Agents' work runs between attempts (finding 1002).
const REFUSED_CANDIDATE_STOP_RECHECK_MAX_MS = 300_000;
// Refusals that authorizeRevision and resolveRevisionBackend decide again on every pass, before
// a stored refusal's stop is retried; one that no longer stands lifts the stored refusal.
const REDECIDED_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "ACTOR_REVOKED",
  "AUTHORIZATION_DENIED",
  "INVALID_AGENT_PRINCIPAL",
  "HARNESS_AUTH_REQUIRED",
  "INVALID_HARNESS_AUTH",
  "INVALID_SECRET_BINDINGS",
  "BACKEND_UNAVAILABLE",
  "HARNESS_AUTH_SOURCE_CHANGED",
  "SERVICE_ACCOUNT_BACKEND_MISMATCH",
]);
const REFUSED_CANDIDATE_STOP_DURATION_FACTOR = 4;

// A repository cleanup that another pass cannot settle (an invalidated attempt or a cleanup
// error, with no session still closing) still rechecks so its obligation stays visible, but
// the delay grows with the work row's age, as for long readiness rechecks: age / 40, at least
// the configured interval and at most 10 minutes.
const REPOSITORY_CLEANUP_RECHECK_MAX_MS = 600_000;
const REPOSITORY_CLEANUP_RECHECK_AGE_DIVISOR = 40;

function repositoryCleanupRecheckMs(intervalMs: number, ageMs: number): number {
  return Math.max(
    intervalMs,
    Math.min(
      REPOSITORY_CLEANUP_RECHECK_MAX_MS,
      Math.round(ageMs / REPOSITORY_CLEANUP_RECHECK_AGE_DIVISOR),
    ),
  );
}

const LOGGED_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
// A Kubernetes Status reason is one bare CamelCase word, such as Forbidden.
const LOGGED_STATUS_REASON = /^[A-Za-z]{1,64}$/u;

function loggedHttpStatus(error: unknown): number | undefined {
  const status =
    error !== null && typeof error === "object"
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * The HTTP status and Status reason on an error's `cause`. A Driver error that
 * replaces an SDK error, to keep private request data out of logs (a Kubernetes
 * private Secret write) or to classify it as transient, keeps them there.
 */
function causeStatusLogFields(error: object): {
  readonly status?: number;
  readonly reason?: string;
} {
  const cause = (error as { readonly cause?: unknown }).cause;
  const status = loggedHttpStatus(cause);
  if (status === undefined) {
    return {};
  }
  const reason = (cause as { readonly reason?: unknown }).reason;
  return {
    status,
    ...(typeof reason === "string" && LOGGED_STATUS_REASON.test(reason) ? { reason } : {}),
  };
}

/**
 * Log fields that say which dependency failed and why, without provider text:
 * a transient dependency names itself and a closed reason; any other failure
 * gives only its error class. Either adds the HTTP status of an SDK error, its
 * own or its cause's, and the Status reason a cause keeps.
 */
function revisionFailureLogFields(error: unknown): {
  readonly dependency?: string;
  readonly cause?: string;
  readonly status?: number;
  readonly reason?: string;
} {
  if (error instanceof TransientDependencyError) {
    return { dependency: error.dependency, cause: error.reason, ...causeStatusLogFields(error) };
  }
  const record = error !== null && typeof error === "object" ? error : undefined;
  const name =
    record === undefined
      ? undefined
      : [(record as { readonly name?: unknown }).name, record.constructor?.name].find(
          (candidate): candidate is string =>
            typeof candidate === "string" &&
            candidate !== "Error" &&
            LOGGED_ERROR_NAME.test(candidate),
        );
  const errorClass = name ?? "Error";
  // Kubernetes SDK errors carry the HTTP status in `code`.
  const status = loggedHttpStatus(record);
  if (status !== undefined) {
    return { cause: errorClass, status };
  }
  return record === undefined
    ? { cause: errorClass }
    : { cause: errorClass, ...causeStatusLogFields(record) };
}

/**
 * The dependency a revision pass waits for when its failure clears by itself: within the
 * convergence deadline, without spending the attempt budget (D28). A Sandbox gateway that did not
 * answer at all (down or restarting) is one (findings 1658, 2040), at every step of the pass that
 * calls it: the candidate's preparation and an exclusive predecessor's stop, which the next pass
 * repeats. Other work (an Agent stop or deletion, a credential withdrawal, a Namespace) keeps its
 * attempt budget: it has no convergence deadline to bound the wait.
 */
function revisionDependencyFailure(error: unknown): TransientDependencyError | undefined {
  if (error instanceof TransientDependencyError) {
    return error;
  }
  return error instanceof SandboxGatewayUnavailableError
    ? new TransientDependencyError(
        "sandbox_gateway",
        "unavailable",
        "The Sandbox gateway did not answer.",
        { cause: error },
      )
    : undefined;
}

/** Why a claim-owned effect lost its claim; the `CLAIM_LOST` log line names it as `cause`. */
type ClaimLossCause =
  | "CLAIM_RENEWAL_REFUSED"
  | "CLAIM_RENEWAL_LATE"
  | "CLAIM_RENEWAL_FAILED"
  | "CLAIM_LEASE_LAPSED"
  | "WORKER_STOPPING";

/** A claim lost around an external effect. Keeps the base error's name for its callers. */
class ClaimLeaseLostError extends WorkClaimLostError {
  readonly lossCause: ClaimLossCause;

  constructor(lossCause: ClaimLossCause) {
    super();
    this.lossCause = lossCause;
  }
}

/**
 * Stopping a refused candidate failed or yielded to other Work. The pass waits as
 * `REFUSED_CANDIDATE_STOP_PENDING`, whose evidence and log keep the refusal code the stop was
 * for, and its log names the stop's own failure.
 */
class RefusedCandidateStopError extends Error {
  readonly refusal: string;
  /** How long the unfinished stop held the worker. */
  readonly durationMs: number;
  /** The stop yielded to other Work rather than failing, so it does not double the backoff. */
  readonly yielded: boolean;

  constructor(refusal: string, durationMs: number, cause: unknown) {
    super("The refused AgentRevision candidate could not be stopped.", { cause });
    this.name = "RefusedCandidateStopError";
    this.refusal = refusal;
    this.durationMs = durationMs;
    this.yielded = cause instanceof ComputeStopYieldedError;
  }

  /**
   * The refusal stands, but it is not published while its candidate may still serve: the work
   * waits on the stop's own dependency and the next pass repeats the refusal and the stop.
   */
  pending(): {
    readonly result: RevisionDispatchResult;
    readonly logFields: Readonly<Record<string, string | number>>;
  } {
    return {
      result: {
        outcome: "pending",
        code: "REFUSED_CANDIDATE_STOP_PENDING",
        refusedCandidate: this.refusal,
        refusedStopMs: this.durationMs,
        ...(this.yielded ? { refusedStopYielded: true } : {}),
      },
      logFields: { ...revisionFailureLogFields(this.cause), refusal: this.refusal },
    };
  }
}

/**
 * The pending result of an activation pass that did not finish: a dependency
 * that is converging and a known activation wait keep their own codes (D330);
 * anything else stays REVISION_FINALIZATION_INCOMPLETE.
 */
function activationPendingResult(error: unknown): {
  readonly outcome: "pending";
  readonly code: string;
  readonly dependencyFailure?: TransientDependencyError;
} {
  if (error instanceof TransientDependencyError) {
    return { outcome: "pending", code: error.code, dependencyFailure: error };
  }
  if (error instanceof ActivationPendingError) {
    return { outcome: "pending", code: error.code };
  }
  return { outcome: "pending", code: "REVISION_FINALIZATION_INCOMPLETE" };
}

function revisionPendingCode(observation: unknown): string {
  const reason = (observation as { readonly pendingReason?: unknown }).pendingReason;
  return typeof reason === "string" && Object.hasOwn(REVISION_PENDING_CODES, reason)
    ? REVISION_PENDING_CODES[reason]!
    : "REVISION_INCOMPLETE";
}

function revisionReadinessRecheckMs(ageMs: number): number {
  return Math.min(
    REVISION_READINESS_RECHECK_MAX_MS,
    Math.max(
      REVISION_READINESS_RECHECK_MS,
      Math.round(ageMs / REVISION_READINESS_RECHECK_AGE_DIVISOR),
    ),
  );
}

interface DispatchResult {
  readonly outcome: Outcome;
  readonly code: string;
  readonly observation?: Observation;
  readonly decision?: AuthorizationDecision;
  readonly authorization?: AuthorizationRequest;
}

interface RevisionDispatchResult extends DispatchResult {
  /** Terminal preparation requires durable retirement of this exact revision. */
  readonly cleanupFailedPreparation?: true;
  /** A transient dependency failure, retried until the convergence deadline. */
  readonly dependencyFailure?: TransientDependencyError;
  /**
   * A refusal whose exclusive candidate could not be stopped yet. Its pending passes outlast
   * the attempt budget and the convergence deadline: ending the work would leave the refused
   * candidate serving with nothing left to stop it.
   */
  readonly refusedCandidate?: string;
  /** How long the refused candidate's unfinished stop took; it lengthens the recheck. */
  readonly refusedStopMs?: number;
  /** That stop yielded to other Work; later rechecks do not count it as a failure. */
  readonly refusedStopYielded?: boolean;
  /** This pass already ran the refused candidate's stop, so publishing does not run it again. */
  readonly refusedCandidateStopped?: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly resultData?: Readonly<Record<string, unknown>>;
  readonly revision?: Readonly<AgentRevision>;
  readonly previous?: Readonly<AgentRevision>;
  readonly supersededBy?: Readonly<AgentRevision>;
  readonly expectedActiveRevisionId?: string;
  readonly context?: ComputeRevisionContext;
}

interface AgentStopDispatchResult extends DispatchResult {
  readonly agent?: Readonly<Agent>;
  readonly revision?: Readonly<AgentRevision>;
}

interface CredentialWithdrawalAttempt {
  readonly credentialSourceId: string;
  /** The withdrawal's own requester, whose `agent:operate` authorizes its detach. */
  readonly requestedBy: string;
  readonly code: string;
  /** True once the gateway confirmed revocation or the Sandbox no longer exists. */
  readonly revoked: boolean;
  /** Present when the requester no longer holds `agent:operate`; nothing was detached. */
  readonly denial?: Pick<DispatchResult, "authorization" | "decision">;
}

interface CredentialWithdrawalDispatchResult extends DispatchResult {
  /** One entry per pending withdrawal this pass reached; absent when none was pending. */
  readonly attempts?: readonly CredentialWithdrawalAttempt[];
  /** Earlier attempts already settled every withdrawal; this one changed nothing. */
  readonly nothingPending?: boolean;
}

function unrevokedAttempts(
  withdrawals: readonly Readonly<CredentialWithdrawal>[],
  code: string,
): CredentialWithdrawalAttempt[] {
  return withdrawals.map(({ credentialSourceId, requestedBy }) => ({
    credentialSourceId,
    requestedBy,
    code,
    revoked: false,
  }));
}

/**
 * An authorized withdrawal still awaiting confirmation retries the claim. Otherwise a denied
 * requester fails it, after every authorized withdrawal was revoked in the same pass.
 */
function settleCredentialWithdrawal(
  attempts: readonly CredentialWithdrawalAttempt[],
): CredentialWithdrawalDispatchResult {
  const denied = attempts.find(({ denial }) => denial !== undefined);
  if (attempts.some(({ revoked, denial }) => !revoked && denial === undefined)) {
    return { outcome: "retry", code: "CREDENTIAL_WITHDRAWAL_PENDING", attempts };
  }
  return denied === undefined
    ? { outcome: "success", code: "CREDENTIALS_WITHDRAWN", attempts }
    : { outcome: "permanent", code: denied.code, attempts };
}

/**
 * A pending withdrawal whose last attempt found its requester without `agent:operate` waits
 * for a replay: only an operator who still holds it can take it over and queue an attempt
 * that can succeed, so maintenance does not queue another denied attempt. One Compute refused
 * (CredentialWithdrawalRefusedError) waits too: an operator corrects the cause, then replays.
 */
const CREDENTIAL_WITHDRAWAL_REPLAY_REASONS: ReadonlySet<string> = new Set([
  "AUTHORIZATION_DENIED",
  "ACTOR_REVOKED",
  "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
  "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT",
]);

function credentialWithdrawalAwaitsReplay(withdrawal: Readonly<CredentialWithdrawal>): boolean {
  return (
    withdrawal.lastReason !== undefined &&
    CREDENTIAL_WITHDRAWAL_REPLAY_REASONS.has(withdrawal.lastReason)
  );
}

/**
 * Later attempt series a withdrawal gets after its work runs out of attempts on a retryable
 * failure: 30 s, 1, 2 and 4 min, then every 5 min, about an hour in all.
 */
const MAX_CREDENTIAL_WITHDRAWAL_RECOVERIES = 15;
const CREDENTIAL_WITHDRAWAL_RECOVERY_BASE_MS = 30_000;
const CREDENTIAL_WITHDRAWAL_RECOVERY_MAX_MS = 300_000;
const CREDENTIAL_WITHDRAWAL_RECOVERY_SUFFIX = /:recovery:([1-9][0-9]*)$/;

/**
 * The series after the claimed one. Every series of one request shares the request's work key
 * with its number appended, so a series is queued once and the chain stays bounded; a replay is
 * a new request whose chain starts again.
 */
function nextCredentialWithdrawalRecovery(idempotencyKey: string): {
  readonly idempotencyKey: string;
  readonly number: number;
} {
  const current = CREDENTIAL_WITHDRAWAL_RECOVERY_SUFFIX.exec(idempotencyKey);
  const requestKey = current === null ? idempotencyKey : idempotencyKey.slice(0, current.index);
  const number = (current === null ? 0 : Number(current[1])) + 1;
  return { idempotencyKey: `${requestKey}:recovery:${number}`, number };
}

function credentialWithdrawalRecoveryDelayMs(recovery: number): number {
  return Math.min(
    CREDENTIAL_WITHDRAWAL_RECOVERY_MAX_MS,
    CREDENTIAL_WITHDRAWAL_RECOVERY_BASE_MS * 2 ** Math.min(recovery - 1, 10),
  );
}

/**
 * Native Harness exposures the worker withdraws outside a preparation pass: a revision already
 * active when the worker starts, deployed by a controller that kept the exposure for the
 * Sandbox's lifetime (finding 1669), and a candidate that failed for good while its Sandbox
 * stays for diagnosis (finding 1672). Attempts: at once, then 30 s, 1, 2 and 4 min later; the
 * fifth failure is logged by code and the revision left until the next start.
 */
const MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS = 5;
const HARNESS_EXPOSURE_WITHDRAWAL_RETRY_BASE_MS = 30_000;
/**
 * The sweep step runs on passes that follow an empty claim, and after this many claimed passes
 * in a row regardless, so a queue that is never empty cannot starve it (finding 1695).
 */
const HARNESS_EXPOSURE_SWEEP_CLAIMED_PASSES = 5;

interface PendingHarnessExposureWithdrawal {
  readonly revision: Readonly<AgentRevision>;
  attempts: number;
  dueAt: number;
}

/** The code a failed exposure withdrawal is logged with; never the provider's text. */
function harnessExposureWithdrawalCode(error: unknown): string {
  if (error instanceof TransientDependencyError) {
    return error.code;
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code
    : "HARNESS_EXPOSURE_WITHDRAWAL_FAILED";
}

/** The operator guidance a failed stop, deletion or withdrawal logs with its code (finding 1694). */
function refusalHintField(terminal: boolean, code: string): { readonly hint?: string } {
  const hint = terminal ? operationRefusalHint(code) : undefined;
  return hint === undefined ? {} : { hint };
}

/** A revision whose Sandbox Driver may hold a native Harness exposure for this Compute. */
function holdsNativeHarnessExposure(
  revision: Readonly<AgentRevision>,
  compute: Pick<ComputeDriver, "id" | "implementation">,
): boolean {
  return (
    revision.harness.mode === "dedicated" &&
    revision.harness.id === "openclaw" &&
    revision.sandboxDriverId !== undefined &&
    revision.compute.id === compute.id &&
    revision.compute.implementation === compute.implementation
  );
}

/** A revision's first pending withdrawal, preferring one that does not await a replay. */
function firstPendingCredentialWithdrawal(
  withdrawals: readonly Readonly<CredentialWithdrawal>[],
): Readonly<CredentialWithdrawal> | undefined {
  const pending = withdrawals.filter(({ state }) => state === "pending");
  return pending.find((withdrawal) => !credentialWithdrawalAwaitsReplay(withdrawal)) ?? pending[0];
}

/**
 * A pending withdrawal that needs an attempt queued: it does not await a replay, and no attempt
 * for its revision is queued or running. Every path that queues withdrawal work without an
 * operator request (maintenance, a later series) checks this, so each revision keeps one chain.
 */
async function credentialWithdrawalNeedsAttempt(
  unit: PlatformUnitOfWork,
  withdrawal: Readonly<CredentialWithdrawal>,
): Promise<boolean> {
  return (
    withdrawal.state === "pending" &&
    !credentialWithdrawalAwaitsReplay(withdrawal) &&
    !(await unit.operations.hasOutstandingCredentialWithdrawalWork(
      withdrawal.namespaceId,
      withdrawal.revisionId,
    ))
  );
}

/** Each requester's withdrawn source ids, in attempt order. */
function sourceIdsByRequester(
  attempts: readonly CredentialWithdrawalAttempt[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const { requestedBy, credentialSourceId } of attempts) {
    grouped.set(requestedBy, [...(grouped.get(requestedBy) ?? []), credentialSourceId]);
  }
  return grouped;
}

/** The revision's admitted sources once each: its Harness source first, then the others. */
function revisionCredentialSourceIds(revision: Readonly<AgentRevision>): readonly string[] {
  const harnessSourceId = revisionHarnessSourceId(revision);
  return [
    ...(harnessSourceId === undefined ? [] : [harnessSourceId]),
    ...(revision.credentialSources ?? [])
      .map(({ sourceId }) => sourceId)
      .filter((sourceId) => sourceId !== harnessSourceId),
  ];
}

function revisionHarnessSourceId(revision: Readonly<AgentRevision>): string | undefined {
  return revision.harnessAuth.method === "credential_source"
    ? revision.harnessAuth.sourceId
    : undefined;
}

interface AgentDeletionDispatchResult extends DispatchResult {
  readonly namespace?: Readonly<Namespace>;
  readonly agent?: Readonly<Agent>;
  readonly revisions?: readonly Readonly<AgentRevision>[];
  readonly delayMs?: number;
  readonly abandonedProvisioningEffect?: {
    readonly workId: string;
    readonly receipt: ProvisioningEffectReceipt;
  };
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function workOperation(claim: ControllerWork): string {
  if (isCredentialWithdrawalWork(claim)) {
    return "agent_revision.credential_withdrawal";
  }
  if (claim.revisionId !== undefined) {
    return "agent_revision.reconcile";
  }
  if (claim.agentTarget === "stopped") {
    return "agent.stop";
  }
  if (claim.agentTarget === "deleted") {
    return "agent.delete";
  }
  if (claim.namespaceTarget === "deleted") {
    return "namespace.delete";
  }
  if (claim.namespaceTarget === "ready") {
    return "namespace.ensure";
  }
  return "work.reconcile";
}

// Worker-local phase timing for one deployment work item. It spans the passes
// this process observes; a restart or eviction starts a new record.
interface DeployTiming {
  passes: number;
  passStartedAt: number;
  prepareMs: number;
  firstUnreadyAt: number | undefined;
  readinessWaitMs: number | undefined;
  readyAt: number | undefined;
}

const MAX_DEPLOY_TIMINGS = 256;
const SAFE_COMPUTE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_COMPUTE_FAILURE_STAGE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_COMPUTE_FAILURE_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_COMPUTE_FAILURE_MESSAGE_LENGTH = 256;

function printableComputeFailureMessage(value: string): boolean {
  return (
    value.length <= MAX_COMPUTE_FAILURE_MESSAGE_LENGTH &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 32 && codePoint !== 127;
    })
  );
}

function validComputeFailureDiagnostic(
  value: ComputePrepareRevisionFailureDiagnostic | undefined,
): value is ComputePrepareRevisionFailureDiagnostic {
  return (
    value !== undefined &&
    SAFE_COMPUTE_FAILURE_CODE.test(value.code) &&
    SAFE_COMPUTE_FAILURE_STAGE.test(value.stage) &&
    (value.errorClass === undefined || SAFE_COMPUTE_FAILURE_CLASS.test(value.errorClass)) &&
    (value.message === undefined || printableComputeFailureMessage(value.message)) &&
    (value.status === undefined ||
      (Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 999))
  );
}

/** A yielded stop's log lines name how often this worker saw its stop yield (finding 1094). */
function stopYieldsField(stopYields: number | undefined): { stopYields?: number } {
  return stopYields === undefined ? {} : { stopYields };
}

function workLogFields(claim: ClaimedWork): {
  readonly workId: string;
  readonly attempt: number;
  readonly operation: string;
} {
  return {
    workId: claim.idempotencyKey,
    attempt: claim.attemptCount,
    operation: workOperation(claim),
  };
}

function validDriver(driver: ComputeDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "compute" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.ensureNamespace === "function" &&
    typeof driver.deleteNamespace === "function" &&
    typeof driver.prepareRevision === "function" &&
    typeof driver.stopRevision === "function" &&
    typeof driver.retireRevision === "function" &&
    (driver.deleteAgentRuntimeCredentials === undefined ||
      typeof driver.deleteAgentRuntimeCredentials === "function")
  );
}

function validSandboxDriver(driver: SandboxDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "sandbox" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    Array.isArray(driver.facets) &&
    driver.facets.length > 0 &&
    driver.facets.every(isSandboxFacet) &&
    (driver.ensureNamespace === undefined || typeof driver.ensureNamespace === "function") &&
    (driver.provisionHarness === undefined || typeof driver.provisionHarness === "function") &&
    typeof driver.cleanup === "function"
  );
}

function validSecretDriver(driver: SecretDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "secret" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.create === "function" &&
    typeof driver.update === "function" &&
    typeof driver.delete === "function" &&
    typeof driver.resolve === "function" &&
    (driver.withValue === undefined || typeof driver.withValue === "function")
  );
}

function validLifecycleHooks(driver: Driver): boolean {
  const hooks = driver.computeLifecycleHooks;
  if (hooks === undefined) {
    return true;
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return false;
  }
  const phases = new Set([
    "afterNamespacePrepared",
    "beforeWorkloadStart",
    "beforeWorkloadStop",
    "beforeNamespaceDelete",
  ]);
  const candidate = hooks as unknown as Record<string, unknown>;
  return (
    Object.keys(candidate).length > 0 &&
    Object.entries(candidate).every(
      ([phase, callback]) => phases.has(phase) && typeof callback === "function",
    )
  );
}

/** A Driver's optional Namespace failure reason, kept only when bounded and printable. */
function namespaceFailureReason(observation: Observation): string | undefined {
  const reason = (observation as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 && printableComputeFailureMessage(reason)
    ? reason
    : undefined;
}

function validObservation(value: unknown, namespaceId: string, target: "ready" | "deleted") {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId")) {
    return false;
  }
  const observation = value as Partial<NamespaceEnsureResult & NamespaceDeleteResult>;
  if (
    observation.namespaceId !== namespaceId ||
    (observation.failure !== undefined &&
      observation.failure !== "retryable" &&
      observation.failure !== "permanent")
  ) {
    return false;
  }
  return target === "ready"
    ? typeof observation.namespaceReady === "boolean"
    : typeof observation.namespaceDeleted === "boolean";
}

function validRevisionObservation(value: unknown, revision: Readonly<AgentRevision>): boolean {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId")) {
    return false;
  }
  const observation = value as Record<string, unknown>;
  if (
    observation.warnings !== undefined &&
    computePluginWarnings(observation.warnings, revision) === undefined
  ) {
    return false;
  }
  return (
    observation.namespaceId === revision.namespaceId &&
    observation.agentId === revision.agentId &&
    observation.revisionId === revision.id &&
    typeof observation.ready === "boolean"
  );
}

function computePluginWarnings(
  warnings: unknown,
  revision: Readonly<AgentRevision>,
): readonly PluginDeploymentWarning[] | undefined {
  if (warnings === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(warnings)) {
    return undefined;
  }
  const admitted = revision.plugins?.plugins;
  if (admitted === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized: PluginDeploymentWarning[] = [];
  for (const warning of warnings) {
    if (typeof warning !== "object" || warning === null || Array.isArray(warning)) {
      return undefined;
    }
    const candidate = warning as Record<string, unknown>;
    const code = candidate.code;
    const pluginId = candidate.pluginId;
    if (
      Object.keys(candidate).length !== 2 ||
      (code !== "PLUGIN_INSTALL_FAILED" && code !== "PLUGIN_AUTH_REQUIRED") ||
      typeof pluginId !== "string" ||
      !Object.hasOwn(admitted, pluginId)
    ) {
      return undefined;
    }
    if (seen.has(pluginId)) {
      return undefined;
    }
    seen.add(pluginId);
    normalized.push({ code, pluginId });
  }
  return Object.freeze(normalized);
}

function pluginWarningsResultData(
  warnings: readonly PluginDeploymentWarning[],
): Readonly<Record<string, unknown>> | undefined {
  if (warnings.length === 0) {
    return undefined;
  }
  return Object.freeze({ warnings });
}

function safeRuntimeFailureEvidence(value: unknown): RuntimeFailureEvidence | undefined {
  try {
    return validateRuntimeFailureEvidence(value);
  } catch {
    return undefined;
  }
}

function runtimeFailureFromObservation(observation: unknown): RuntimeFailureEvidence | undefined {
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    return undefined;
  }
  return safeRuntimeFailureEvidence(
    (observation as { readonly runtimeFailure?: unknown }).runtimeFailure,
  );
}

// Deployment failure codes for runtime failures that Kubernetes runtime
// entrypoints hold until restart. AUTHENTICATION_FAILED is a provider 401/403 or
// invalid-key rejection; MODEL_PROBE_CPU_STARVED ran out of a CPU budget sized
// for the container's CPU limit; the others are a probe timeout or failure, a
// failed Codex login, a missing probe configuration, and an invalid plugin
// approver configuration. Kubernetes Compute reports a workspace setup refusal
// that every init container restart repeats (finding 1677). Unknown codes stay
// pending until the deadline.
const HELD_RUNTIME_FAILURE_CODES: Readonly<Record<string, string>> = Object.freeze({
  AUTHENTICATION_FAILED: "RUNTIME_AUTHENTICATION_FAILED",
  MODEL_PROBE_CPU_STARVED: "RUNTIME_CPU_STARVED",
  MODEL_PROBE_TIMEOUT: "RUNTIME_MODEL_PROBE_TIMEOUT",
  MODEL_PROBE_FAILED: "RUNTIME_MODEL_PROBE_FAILED",
  LOGIN_FAILED: "RUNTIME_LOGIN_FAILED",
  UNAVAILABLE: "RUNTIME_STARTUP_FAILED",
  INCOMPATIBLE_RESPONSE: "RUNTIME_STARTUP_FAILED",
  WORKSPACE_SETUP_REFUSED: "WORKSPACE_SETUP_REFUSED",
});

function heldRuntimeFailureCode(code: string): string | undefined {
  return Object.hasOwn(HELD_RUNTIME_FAILURE_CODES, code)
    ? HELD_RUNTIME_FAILURE_CODES[code]
    : undefined;
}

function convergenceDeadlineResultData(
  timeoutMs: number,
  runtimeFailure: RuntimeFailureEvidence | undefined,
): Readonly<Record<string, unknown>> {
  // Deadline data never carries a cause; only RUNTIME_MODEL_PROBE_FAILED keeps one.
  const { cause: _cause, ...evidence } = runtimeFailure ?? {};
  return Object.freeze({
    timeoutMs,
    ...(runtimeFailure === undefined ? {} : { runtimeFailure: evidence }),
  });
}

function revisionSecretBindings(
  revision: Readonly<AgentRevision>,
): { readonly bindings: SecretBindings } | { readonly result: RevisionDispatchResult } {
  try {
    return { bindings: normalizeSecretBindings(revision.secretBindings) };
  } catch {
    return { result: { outcome: "permanent", code: "INVALID_SECRET_BINDINGS" } };
  }
}

function uniqueSecretRefs(bindings: SecretBindings): SecretReference[] {
  const refs = new Map<string, SecretReference>();
  for (const { source } of Object.values(bindings)) {
    refs.set(`${source.namespaceId}\u0000${source.id}`, source);
  }
  return [...refs.values()];
}

const MAX_STOPPED_PREDECESSOR_RECORDS = 4_096;
const MAX_AUDITED_PENDING_LIFECYCLE_RECORDS = 4_096;

export class ControllerWorker {
  private readonly metrics: OccMetrics | undefined;
  private passOutcome: WorkOutcome = "error";
  /** The revision this pass asked Compute to prepare, if any. */
  private preparedThisPass: string | undefined;
  /**
   * The refusal this deployment pass's work still waits to publish: its latest evidence is a
   * REFUSED_CANDIDATE_STOP_PENDING deferral, or a lost claim that kept its refusal.
   */
  private refusalWait: { readonly idempotencyKey: string; readonly refusal: string } | undefined;
  private readonly state: PostgresPlatformState;
  private readonly driverConfigurations: readonly DriverConfigurationRegistration[];
  private readonly configurations = new DriverConfigurationRegistry();
  private readonly policyCeiling: readonly import("@openclaw-enterprise/contracts").SandboxNetworkGrant[];
  private readonly queue: PostgresWorkQueue;
  private readonly compute: ComputeDriver;
  private readonly configuration: ConfigurationDriver | undefined;
  private readonly queueOptions: PostgresWorkQueueOptions;
  private readonly iamDriverId: string;
  private readonly iam: IAMDriver;
  private readonly secretDriverId: string | undefined;
  private readonly configuredServiceAccountDriverId: string | undefined;
  private readonly nativeWorkerSupport: NativeWorkerSupport | undefined;
  private readonly secretDriver: SecretDriver | undefined;
  private provisioningController: OpenClawController | undefined;
  private readonly sandbox: SandboxDriver | undefined;
  private readonly credentialGateway: CredentialGatewayDriver | undefined;
  private readonly backends: readonly BackendDefinition[];
  private readonly backendMap: ReadonlyMap<string, BackendDefinition>;
  private readonly requireComputePreflight: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly convergenceTimeoutMs: number;
  private readonly maintenanceIntervalMs: number | undefined;
  // Keyed by revision ID; undefined until the start-time listing has run.
  private readonly harnessExposureWithdrawals = new Map<string, PendingHarnessExposureWithdrawal>();
  private harnessExposureListed = false;
  private harnessExposureListingFailures = 0;
  private claimedLastPass = false;
  private claimedPassesSinceSweep = 0;
  private readonly repoDriver: RepoDriver | undefined;
  private readonly repositoryCleanupRetryMs: number;
  private readonly pluginDriver: PluginDriver | undefined;
  private readonly repositoryCredentials: RepositoryCredentialLifecycle;
  private readonly mode: "development" | "production";
  private readonly emit: (event: Readonly<Record<string, unknown>>) => void;
  private readonly onHealthy: (() => Promise<void>) | undefined;
  private readonly onProgress: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private installation: Readonly<Installation> | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private lastHealthAt = 0;
  private pendingHealth: Promise<void> | undefined;
  private lastProgressAt = 0;
  private pendingProgress = false;
  /**
   * Predecessors this process stopped for an exclusive successor, by revision ID.
   * The dispatch guard supersedes a predecessor's own work once an exclusive
   * successor exists, so only a late effect from a lost claim (or an edit outside
   * the worker) can recreate it. Compute reports such a predecessor as a
   * not-ready successor rather than an error, so each record is stopped again
   * after one lease, then after two, four and so on: a returned predecessor is
   * always stopped again, at a cost that grows only logarithmically with time.
   */
  private readonly stoppedPredecessors = new Map<
    string,
    { readonly stoppedAt: number; readonly restopAfterMs: number }
  >();
  private readonly deployTimings = new Map<string, DeployTiming>();
  /** The last stuck-cleanup cause logged per repository cleanup work item. */
  private readonly repositoryCleanupCauses = new Map<string, string>();
  /**
   * The last pending Namespace lifecycle observation this process audited, by work
   * key. A teardown waits for Kubernetes namespaces to terminate over many passes;
   * a pass that observes the same pending state again is not audited again. The
   * terminal pass and a changed pending state are always audited.
   */
  private readonly auditedPendingLifecycle = new Map<string, string>();
  /** Work whose latest pass yielded its stop during a Gateway drain (findings 1093, 1094). */
  private readonly stopYields = new StopYields();
  /** Whether this pass deferred its work as AGENT_STOP_YIELDED. */
  private stopYieldedThisPass = false;
  /** Each claim's work creation instant on this process's monotonic clock; see `workAgeMs`. */
  private readonly workOrigins = new WeakMap<ClaimedWork, number>();

  constructor(options: ControllerWorkerOptions) {
    this.metrics = options.metrics;
    this.mode = options.mode ?? "development";
    if (this.mode !== "development" && this.mode !== "production") {
      throw new Error("The controller worker mode must be development or production.");
    }
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "Worker poll interval");
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 5_000, "Worker claim lease");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "Maximum worker attempts");
    this.convergenceTimeoutMs = positiveInteger(
      options.convergenceTimeoutMs ?? 900_000,
      "Worker convergence timeout",
    );
    const drivers = options.drivers;
    this.driverConfigurations = installationDriverConfigurations(drivers?.installation);
    for (const definition of this.driverConfigurations) {
      this.configurations.register(definition);
    }
    this.policyCeiling = drivers?.installation.sandboxNetworkPolicyCeiling ?? [];
    this.configuredServiceAccountDriverId = drivers?.installation.drivers.service_account?.id;
    this.nativeWorkerSupport = drivers?.installation.runtime?.nativeWorkerSupport;
    if (this.mode === "production" && drivers === undefined) {
      throw new Error("Production controller workers require Installation startup configuration.");
    }
    this.queueOptions = {
      leaseDurationMs: this.leaseDurationMs,
      maxAttempts: this.maxAttempts,
    };
    this.state = new PostgresPlatformState(options.pool, { workQueue: this.queueOptions });
    this.queue = new PostgresWorkQueue(options.pool, this.queueOptions);
    this.backends = validateBackendDefinitions(drivers?.installation.backend ?? []);
    this.backendMap = backendDefinitionMap(this.backends);
    this.iamDriverId = drivers?.installation.drivers.iam.id ?? "native-iam";
    this.iam =
      drivers === undefined
        ? new NativeIAMDriver(this.state, { id: "native-iam", implementation: "native" })
        : drivers.createIAMDriver(this.state);
    if (this.iam.capability !== "iam" || this.iam.id !== this.iamDriverId) {
      throw new Error("The selected IAM Driver is unavailable.");
    }
    const computeDriver = drivers === undefined ? options.computeDriver : drivers.computeDriver;
    if (computeDriver === undefined) {
      throw new Error("The selected Compute Driver must be explicitly provided.");
    }
    if (drivers === undefined && !validDriver(computeDriver)) {
      throw new Error("The selected Compute Driver is unavailable.");
    }
    if (
      computeDriver.activationOrder === "beforeCommit" &&
      typeof computeDriver.activateRevision !== "function"
    ) {
      throw new Error("A before-commit Compute Driver must implement activateRevision.");
    }
    this.compute = computeDriver;
    const selectedSecretDriver = drivers?.secretDriver;
    this.secretDriver = selectedSecretDriver;
    const selectedSecretConfiguration = drivers?.installation.drivers.secret;
    this.secretDriverId = selectedSecretDriver?.id ?? selectedSecretConfiguration?.id;
    if (selectedSecretConfiguration !== undefined) {
      if (selectedSecretDriver === undefined || !validSecretDriver(selectedSecretDriver)) {
        throw new Error("The selected Secret Driver is unavailable.");
      }
      if (selectedSecretDriver.id !== selectedSecretConfiguration.id) {
        throw new Error("The selected Secret Driver does not match Installation configuration.");
      }
    }
    this.maintenanceIntervalMs =
      computeDriver.maintenanceIntervalMs === undefined
        ? undefined
        : positiveInteger(computeDriver.maintenanceIntervalMs, "Compute maintenance interval");
    this.configuration = drivers?.configurationDriver;
    if (this.configuration !== undefined && !validLifecycleHooks(this.configuration)) {
      throw new Error("The selected Configuration Driver exposes invalid lifecycle hooks.");
    }
    this.sandbox = drivers?.sandboxDriver ?? options.sandboxDriver;
    this.credentialGateway = drivers?.credentialGatewayDriver ?? options.credentialGatewayDriver;
    if (
      (drivers?.installation.drivers.credential_gateway === undefined) !==
      (drivers?.credentialGatewayDriver === undefined)
    ) {
      throw new Error(
        "The selected Credential Gateway Driver requires shared startup configuration.",
      );
    }
    if (this.credentialGateway !== undefined && this.sandbox === undefined) {
      throw new Error("The selected Credential Gateway Driver requires a paired Sandbox Driver.");
    }
    if (
      (drivers?.installation.drivers.sandbox === undefined) !==
      (drivers?.sandboxDriver === undefined)
    ) {
      throw new Error("The selected Sandbox Driver requires shared startup configuration.");
    }
    if (this.sandbox !== undefined) {
      if (!validSandboxDriver(this.sandbox)) {
        throw new Error("The selected Sandbox Driver is unavailable.");
      }
      if (!validLifecycleHooks(this.sandbox)) {
        throw new Error("The selected Sandbox Driver exposes invalid lifecycle hooks.");
      }
    }
    this.requireComputePreflight =
      this.mode === "production" && drivers?.installation.drivers.compute.package === undefined;
    this.emit =
      options.emit ??
      ((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      });
    this.onHealthy = options.onHealthy;
    this.onProgress = options.onProgress;
    this.repoDriver = drivers?.repoDriver;
    this.repositoryCleanupRetryMs = positiveInteger(
      this.repoDriver?.maintenanceIntervalMs ?? 30_000,
      "Repository cleanup retry interval",
    );
    this.pluginDriver = drivers?.pluginDriver;
    if (this.repoDriver !== undefined) {
      const driver = this.repoDriver;
      if (
        driver.capability !== "repo" ||
        typeof driver.resolve !== "function" ||
        typeof driver.open !== "function" ||
        typeof driver.status !== "function" ||
        typeof driver.close !== "function" ||
        (driver.durableBrokerReceipts === true && typeof driver.checkAdmissionReady !== "function")
      ) {
        throw new Error("The selected repository credential Driver is unavailable.");
      }
      positiveInteger(driver.maintenanceIntervalMs, "Repository credential maintenance interval");
    }
    this.repositoryCredentials = new RepositoryCredentialLifecycle({
      state: this.state,
      queueOptions: this.queueOptions,
      driver: this.repoDriver,
      authorize: (claim, revision) => this.assertRepositoryAuthority(claim, revision),
      effect: (claim, operation) => this.withClaimHeartbeat(claim, operation),
    });
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) {
      throw new Error("The controller worker is already running.");
    }
    const installation = await this.state.loadInstallation();
    if (installation === undefined) {
      throw new Error("The platform Installation must be bootstrapped before starting the worker.");
    }
    this.installation = installation;
    validatePersistedNativeIAMState(await this.loadIAMState());
    this.attachLifecycleDrivers(this.iam);
    const provisioning = new OpenClawController(installation, {
      state: this.state,
      sandboxNetworkPolicyCeiling: this.policyCeiling,
      driverConfigurations: this.driverConfigurations,
      backends: this.backends,
      recordOperations: true,
      ...(this.configuredServiceAccountDriverId === undefined
        ? {}
        : { configuredServiceAccountDriverId: this.configuredServiceAccountDriverId }),
      ...(this.nativeWorkerSupport === undefined
        ? {}
        : { nativeWorkerSupport: this.nativeWorkerSupport }),
    });
    for (const driver of [
      this.configuration,
      this.sandbox,
      this.credentialGateway,
      this.iam,
      this.secretDriver,
      this.repoDriver,
      this.pluginDriver,
      this.compute,
    ] as const) {
      if (driver !== undefined) {
        provisioning.registerDriver(driver);
        provisioning.selectDriver(driver.capability, driver.id);
      }
    }
    this.provisioningController = provisioning;
    const compute = this.compute;
    if (typeof compute.preflight === "function") {
      const result = await compute.preflight();
      if (result !== undefined) {
        for (const warning of result.warnings) {
          this.emit({
            event: "compute.preflight-warning",
            computeDriverId: compute.id,
            ...warning,
          });
        }
      }
    } else if (this.requireComputePreflight) {
      throw new Error("The selected bundled production Compute Driver requires preflight.");
    }
    this.emit({
      event: "worker.started",
      computeDriverId: this.compute.id,
      ...(this.sandbox === undefined ? {} : { sandboxDriverId: this.sandbox.id }),
    });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.abort.abort();
    await this.loop;
    await this.state.close();
    this.emit({ event: "worker.stopped" });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      // Every pass starts here, including back-to-back claims that skip the idle delay.
      this.progress();
      let claimed: ClaimedWork | undefined;
      try {
        const recovery = await this.state.transactWithQueue(async (unit, queue) => {
          const recovered = await queue.recoverStale();
          await failAbandonedSandboxPolicies(unit, this.installation!.id, recovered.failed);
          return recovered;
        }, this.queueOptions);
        await this.scheduleRecoveredCredentialWithdrawals(recovery.failed);
        // A sweep step asks the Sandbox gateway, up to its deadline: it runs on passes that
        // follow an empty claim, so queued work is not delayed by a gateway that does not
        // answer, and once per HARNESS_EXPOSURE_SWEEP_CLAIMED_PASSES claimed passes in a row,
        // so a saturated queue still gets one step (finding 1695).
        if (
          !this.claimedLastPass ||
          this.claimedPassesSinceSweep >= HARNESS_EXPOSURE_SWEEP_CLAIMED_PASSES
        ) {
          this.claimedPassesSinceSweep = 0;
          await this.withdrawPendingHarnessExposure();
        }
        const claim = await this.queue.claim();
        this.claimedLastPass = claim !== undefined;
        if (claim !== undefined) {
          this.claimedPassesSinceSweep += 1;
          this.workOrigins.set(claim, performance.now() - claim.ageMs);
          claimed = claim;
          const started = process.hrtime.bigint();
          this.passOutcome = "error";
          this.preparedThisPass = undefined;
          this.refusalWait = undefined;
          this.stopYieldedThisPass = false;
          try {
            await this.process(claim);
          } catch (error) {
            this.passOutcome = error instanceof WorkClaimLostError ? "claim_lost" : "error";
            throw error;
          } finally {
            if (!this.stopYieldedThisPass) {
              this.stopYields.settled(claim.idempotencyKey);
            }
            let kind: WorkKind = "namespace_ensure";
            if (claim.kind === "provisioning") {
              kind = "agent_provisioning";
            } else if (claim.agentTarget === "sandbox_policy") {
              kind = "agent_sandbox_policy";
            } else if (claim.agentTarget === "deleted") {
              kind = "agent_delete";
            } else if (claim.agentTarget === "stopped") {
              kind = "agent_stop";
            } else if (isCredentialWithdrawalWork(claim)) {
              kind = "agent_credential_withdrawal";
            } else if (claim.revisionId !== undefined) {
              kind = "agent_revision";
            } else if (claim.namespaceTarget === "deleted") {
              kind = "namespace_delete";
            }
            this.metrics?.observeWork(
              kind,
              this.passOutcome,
              Number(process.hrtime.bigint() - started) / 1e9,
            );
          }
          await this.health(true);
          continue;
        }
        await this.health(false);
      } catch (error) {
        if (error instanceof WorkClaimLostError && this.stopping) {
          // A graceful shutdown aborted the pass in flight. That is no failure: the work keeps
          // its claim until the lease expires, then another worker resumes it (finding 1040).
          this.emit({
            event: "worker.pass-interrupted",
            ...(claimed === undefined ? {} : workLogFields(claimed)),
            cause: "WorkerStopping",
          });
        } else {
          this.emit({
            event: "worker.error",
            code: error instanceof WorkClaimLostError ? "CLAIM_LOST" : "WORKER_UNAVAILABLE",
            ...(error instanceof ClaimLeaseLostError
              ? {
                  ...(claimed === undefined ? {} : workLogFields(claimed)),
                  cause: error.lossCause,
                }
              : {}),
          });
        }
      }
      try {
        await delay(this.pollIntervalMs, undefined, { signal: this.abort.signal });
      } catch (error) {
        if (!this.stopping) {
          throw error;
        }
      }
    }
  }

  /**
   * Milliseconds since the claimed work was created, by PostgreSQL's clock. The convergence
   * deadline and age-scaled rechecks use it. `createdAt` is on the database clock, so
   * `Date.now() - createdAt` would move the deadline by the controller's skew from it
   * (finding 1187). The claim carries PostgreSQL's age when granted, and each renewal around
   * an external effect refreshes it; this process's monotonic clock advances it in between.
   * It trails the database's age by one round trip, so it never ends work early.
   */
  private workAgeMs(claim: ClaimedWork): number {
    const origin = this.workOrigins.get(claim);
    if (origin === undefined) {
      throw new Error(`The worker has no claim time for work ${claim.idempotencyKey}.`);
    }
    return Math.max(0, performance.now() - origin);
  }

  /** Report loop progress without ever delaying the loop; see `onProgress`. */
  private progress(): void {
    const now = Date.now();
    if (
      this.onProgress === undefined ||
      this.pendingProgress ||
      now - this.lastProgressAt < Math.max(1_000, this.pollIntervalMs * 20)
    ) {
      return;
    }
    const onProgress = this.onProgress;
    this.lastProgressAt = now;
    this.pendingProgress = true;
    void (async () => onProgress())()
      .catch(() => {
        this.emit({ event: "worker.error", code: "PROGRESS_UNAVAILABLE" });
      })
      .finally(() => {
        this.pendingProgress = false;
      });
  }

  private async health(force: boolean): Promise<void> {
    if (this.pendingHealth !== undefined) {
      return this.pendingHealth;
    }
    const now = Date.now();
    if (!force && now - this.lastHealthAt < Math.max(1_000, this.pollIntervalMs * 20)) {
      return;
    }
    this.lastHealthAt = now;
    this.pendingHealth = (async () => {
      const pending = await this.queue.pending();
      await this.repoDriver?.checkAdmissionReady?.(AbortSignal.timeout(2000));
      await this.onHealthy?.();
      this.emit({ event: "worker.health", status: "ready", pending });
    })()
      .catch(() => {
        this.emit({ event: "worker.error", code: "HEALTH_UNAVAILABLE" });
      })
      .finally(() => {
        this.pendingHealth = undefined;
      });
    return this.pendingHealth;
  }

  private async loadIAMState(): Promise<NativeIAMState> {
    if (this.installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    return this.state.loadNativeIAMState();
  }

  private attachLifecycleDrivers(iam: IAMDriver): void {
    if (!validLifecycleHooks(iam)) {
      throw new Error("The selected IAM Driver exposes invalid lifecycle hooks.");
    }
    const lifecycleDrivers: Driver[] = [];
    if (this.configuration?.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(this.configuration);
    }
    if (this.sandbox?.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(this.sandbox);
    }
    if (iam.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(iam);
    }
    if (lifecycleDrivers.length === 0) {
      return;
    }
    if (typeof this.compute.setLifecycleDrivers !== "function") {
      throw new Error("The selected Compute Driver cannot accept selected lifecycle Drivers.");
    }
    this.compute.setLifecycleDrivers(Object.freeze(lifecycleDrivers));
  }

  private async iamDecision(
    driver: IAMDriver,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    const decision = await driver.authorize(request);
    const evidence = decision?.evidence;
    if (
      decision === null ||
      typeof decision !== "object" ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.reason !== "string" ||
      decision.driverId !== driver.id ||
      evidence === null ||
      typeof evidence !== "object" ||
      (evidence.identityId !== undefined &&
        (typeof evidence.identityId !== "string" || evidence.identityId.trim().length === 0)) ||
      ![evidence.groupIds, evidence.bindingIds, evidence.roleIds, evidence.restrictionIds].every(
        (values) =>
          Array.isArray(values) &&
          values.every((value) => typeof value === "string" && value.trim().length > 0),
      )
    ) {
      throw new Error("The selected IAM Driver returned an invalid authorization decision.");
    }
    return decision;
  }

  private async stagedRevision(
    operation: "activateRevision" | "deactivateRevision",
    revision: Readonly<AgentRevision>,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    const stage = this.compute[operation];
    if (typeof stage !== "function") {
      throw new Error(`The selected production Compute Driver requires ${operation}.`);
    }
    if (operation === "activateRevision") {
      this.stoppedPredecessors.delete(revision.id);
    }
    await stage.call(this.compute, revision, context);
  }

  private shouldActivateAfterCommit(compute: ComputeDriver): boolean {
    return (
      compute.activationOrder !== "beforeCommit" &&
      (this.mode === "production" || typeof compute.activateRevision === "function")
    );
  }

  private shouldActivatePublishedRevision(compute: ComputeDriver): boolean {
    return this.mode === "production" || typeof compute.activateRevision === "function";
  }

  private async authorize(
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult | undefined> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const state = await this.loadIAMState();
    const driver = this.iam;
    const exact: AuthorizationRequest = {
      principalId: claim.actorId,
      action: claim.namespaceTarget === "ready" ? "create" : "delete",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
    };
    const request: AuthorizationRequest =
      claim.namespaceTarget === "ready"
        ? {
            principalId: claim.actorId,
            action: "create",
            resource: { kind: "namespace", id: installation.id },
          }
        : exact;
    if (!state.identities.some((identity) => identity.id === claim.actorId)) {
      const decision = await this.iamDecision(driver, request);
      return { outcome: "permanent", code: "ACTOR_REVOKED", decision, authorization: request };
    }
    const decision = await this.iamDecision(driver, request);
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        decision,
        authorization: request,
      };
    }
    if (claim.namespaceTarget === "ready") {
      if (namespace.existingNamespace !== undefined) {
        const adminRequest: AuthorizationRequest = {
          principalId: claim.actorId,
          action: "administer",
          resource: { kind: "installation", id: installation.id },
        };
        const adminDecision = await this.iamDecision(driver, adminRequest);
        if (!adminDecision.allowed) {
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            decision: adminDecision,
            authorization: adminRequest,
          };
        }
      }
      const exactDecision = await this.iamDecision(driver, exact);
      if (exactDecision.evidence.restrictionIds.length > 0) {
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          decision: exactDecision,
          authorization: exact,
        };
      }
    }
    return undefined;
  }

  private revisionMaintenanceInterval(revision: Readonly<AgentRevision>): number | undefined {
    const repositoryInterval =
      revision.repositoryCredentials === undefined
        ? undefined
        : this.repoDriver?.maintenanceIntervalMs;
    const intervals = [this.maintenanceIntervalMs, repositoryInterval].filter(
      (interval): interval is number => interval !== undefined,
    );
    return intervals.length === 0 ? undefined : Math.min(...intervals);
  }

  private async assertRepositoryAuthority(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    if (this.stopping || this.abort.signal.aborted) {
      throw new WorkClaimLostError();
    }
    const { namespace, agent, active } = await this.state.read(async (view) => {
      const namespace = await view.namespaces.findNamespace(revision.namespaceId);
      const agent = await view.agents.findAgent(revision.namespaceId, revision.agentId);
      const active =
        agent?.activeRevisionId === undefined
          ? undefined
          : await view.revisions.findRevision(
              revision.namespaceId,
              revision.agentId,
              agent.activeRevisionId,
            );
      return { namespace, agent, active };
    });
    if (
      namespace?.status !== "ready" ||
      agent?.desiredRuntimeState !== "running" ||
      agent.servicePrincipalId !== revision.servicePrincipalId
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_STOPPED");
    }
    if (
      agent.activeRevisionId !== undefined &&
      agent.activeRevisionId !== revision.id &&
      (active === undefined || active.revision >= revision.revision)
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_SUPERSEDED");
    }
    const denied = await this.authorizeRevision(claim, agent, revision);
    if (denied !== undefined) {
      throw new RepositoryCredentialAuthorityError(denied.code);
    }
    const backend = await this.resolveRevisionBackend(revision);
    if (backend !== undefined) {
      throw new RepositoryCredentialAuthorityError(backend.code);
    }
    if (typeof this.compute.validateRepositoryCredentials !== "function") {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_RUNTIME_UNSUPPORTED");
    }
    try {
      this.compute.validateRepositoryCredentials(revision.harness, revision.sandboxDriverId);
    } catch {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_RUNTIME_UNSUPPORTED");
    }
  }

  private async prepareRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext,
  ): Promise<{ readonly observation: ComputeReadiness; readonly context: ComputeRevisionContext }> {
    const timing = this.deployTimings.get(claim.idempotencyKey);
    const started = Date.now();
    try {
      const prepared = await this.prepareRevisionPass(claim, revision, context);
      if (timing !== undefined) {
        const now = Date.now();
        if (!prepared.observation.ready) {
          timing.firstUnreadyAt ??= now;
        } else {
          timing.readyAt = now;
          if (timing.readinessWaitMs === undefined && timing.firstUnreadyAt !== undefined) {
            timing.readinessWaitMs = now - timing.firstUnreadyAt;
          }
        }
      }
      return prepared;
    } catch (error) {
      // The worker aborted Compute itself, on a lost claim or a graceful shutdown: the pass's
      // own claim-loss or interruption record explains it, so there is no Compute failure to
      // describe (finding 1040).
      // A predecessor's stop that yielded is no preparation failure: the candidate is untouched.
      if (error instanceof WorkClaimLostError || error instanceof ComputeStopYieldedError) {
        throw error;
      }
      let diagnostic: ComputePrepareRevisionFailureDiagnostic | undefined;
      try {
        diagnostic = this.compute.describePrepareRevisionFailure?.(error);
      } catch {
        // Diagnostics must never replace the Compute failure that owns retry behavior.
      }
      if (validComputeFailureDiagnostic(diagnostic)) {
        this.emit({
          event: "worker.compute-prepare-failed",
          ...workLogFields(claim),
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          computeDriverId: this.compute.id,
          code: diagnostic.code,
          step: diagnostic.stage,
          ...(diagnostic.errorClass === undefined ? {} : { errorClass: diagnostic.errorClass }),
          ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
          ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
        });
      }
      throw error;
    } finally {
      if (timing !== undefined) {
        timing.prepareMs += Date.now() - started;
      }
    }
  }

  private async prepareRevisionPass(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext,
  ): Promise<{ readonly observation: ComputeReadiness; readonly context: ComputeRevisionContext }> {
    // Preparing a revision can recreate its runtime, so it is no longer known stopped.
    this.stoppedPredecessors.delete(revision.id);
    let earlier: readonly Readonly<AgentRevisionMetadata>[] = [];
    if (this.compute.requiresStoppedPredecessors?.(revision) === true) {
      earlier = await this.state.read(async (view) =>
        (await view.revisions.listRevisionMetadata(revision.namespaceId, revision.agentId)).filter(
          (candidate) => candidate.revision < revision.revision,
        ),
      );
      await this.stopPredecessors(claim, earlier);
    }
    try {
      return await this.prepareAfterPredecessors(claim, revision, context);
    } catch (error) {
      // A failed pass may stem from a predecessor that came back; sweep it again.
      for (const previous of earlier) {
        this.stoppedPredecessors.delete(previous.id);
      }
      throw error;
    }
  }

  /**
   * Stops every predecessor before exclusive replacement prepares its candidate, so the
   * Harness's single-writer volumes are never mounted twice. A predecessor's Gateway drain yields
   * like a stopped Agent's (`drain` "yield", finding 1090): the pass ends pending as
   * `PREDECESSOR_STOP_YIELDED` before the candidate is touched, and the next pass repeats the
   * idempotent stop, which resumes the drain. The Harness is deleted only after the Gateway's Pods
   * are gone, and the candidate is prepared only after every predecessor's stop returned in this
   * pass. A newer revision admitted meanwhile supersedes this work and stops both itself.
   */
  private async stopPredecessors(
    claim: ClaimedWork,
    earlier: readonly Readonly<AgentRevisionMetadata>[],
    drain: "yield" | "wait" = "yield",
    load: (
      listed: Readonly<AgentRevisionMetadata>,
    ) => Promise<Readonly<AgentRevision> | undefined> = (listed) =>
      this.state.read((view) =>
        view.revisions.findRevision(listed.namespaceId, listed.agentId, listed.id),
      ),
  ): Promise<void> {
    for (const listed of earlier) {
      const record = this.stoppedPredecessors.get(listed.id);
      if (record !== undefined && Date.now() - record.stoppedAt < record.restopAfterMs) {
        continue;
      }
      // By default, decode only a predecessor this pass stops; a recently stopped one is skipped
      // unread (finding 1323). One that is gone went with its Agent or Namespace, whose own
      // teardown stops it.
      const previous = await load(listed);
      if (previous === undefined) {
        continue;
      }
      await this.closeRevisionCredentials(claim, previous);
      if (drain === "wait") {
        await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(previous));
      } else {
        try {
          await this.stopYieldingDrain(claim, previous);
        } catch (error) {
          throw error instanceof ComputeStopYieldedError
            ? new PredecessorStopYieldedError(error)
            : error;
        }
      }
      this.stoppedPredecessors.delete(previous.id);
      this.stoppedPredecessors.set(previous.id, {
        stoppedAt: Date.now(),
        restopAfterMs: record === undefined ? this.leaseDurationMs : record.restopAfterMs * 2,
      });
      if (this.stoppedPredecessors.size > MAX_STOPPED_PREDECESSOR_RECORDS) {
        // Forgetting a record only costs one repeated idempotent stop.
        const oldest = this.stoppedPredecessors.keys().next().value;
        if (oldest !== undefined) {
          this.stoppedPredecessors.delete(oldest);
        }
      }
    }
  }

  private async prepareAfterPredecessors(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext,
  ): Promise<{ readonly observation: ComputeReadiness; readonly context: ComputeRevisionContext }> {
    let prepared = context;
    if (revision.repositoryCredentials !== undefined) {
      const repositoryCredentials = await this.repositoryCredentials.prepare(claim, revision);
      prepared = { ...context, repositoryCredentials };
      await this.assertRepositoryAuthority(claim, revision);
      this.repositoryCredentials.validate(revision);
    }
    await this.recheckRevokedCredentialSources(claim, revision);
    this.preparedThisPass = revision.id;
    let observation = await this.withClaimHeartbeat(claim, () =>
      this.compute.prepareRevision(revision, prepared),
    );
    if (!validRevisionObservation(observation, revision)) {
      throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
    }
    const missing = observation.repositoryCredentialMaterialMissing;
    if (missing !== undefined) {
      if (
        observation.ready ||
        !Array.isArray(missing) ||
        missing.length === 0 ||
        prepared.repositoryCredentials === undefined ||
        missing.some(
          (entry: RepositoryCredentialMaterialRef) =>
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.repositoryRef !== "string" ||
            typeof entry.sessionId !== "string" ||
            Object.keys(entry).some((key) => key !== "repositoryRef" && key !== "sessionId"),
        )
      ) {
        throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
      }
      const repositoryCredentials = await this.repositoryCredentials.repair(
        claim,
        revision,
        prepared.repositoryCredentials,
        missing,
      );
      prepared = { ...context, repositoryCredentials };
      await this.assertRepositoryAuthority(claim, revision);
      this.repositoryCredentials.validate(revision);
      observation = await this.withClaimHeartbeat(claim, () =>
        this.compute.prepareRevision(revision, prepared),
      );
      if (
        !validRevisionObservation(observation, revision) ||
        observation.repositoryCredentialMaterialMissing !== undefined
      ) {
        throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
      }
    }
    return { observation, context: prepared };
  }

  private async processRepositoryCleanup(claim: ClaimedWork): Promise<void> {
    let complete = false;
    let cause: string | undefined;
    const cleanupRevisionId = repositoryCleanupRevisionId(claim);
    if (cleanupRevisionId === undefined) {
      await this.finalize(claim, undefined, { outcome: "permanent", code: "INVALID_TARGET" });
      return;
    }
    try {
      const revision = await this.state.read(async (view) => {
        if (claim.agentId === undefined) {
          return undefined;
        }
        return view.revisions.findRevision(claim.namespaceId, claim.agentId, cleanupRevisionId);
      });
      if (revision !== undefined) {
        const retireRuntime = isRepositoryRuntimeRetirementWork(claim);
        ({ settled: complete, cause } = await this.repositoryCredentials.cleanup(claim, revision, {
          retireRuntime,
        }));
        if (retireRuntime) {
          if (
            revision.compute.id !== this.compute.id ||
            revision.compute.implementation !== this.compute.implementation
          ) {
            throw new Error("COMPUTE_DRIVER_MISMATCH");
          }
          const resources = await this.state.read(async (view) => ({
            namespace: await view.namespaces.findNamespace(revision.namespaceId),
            agent: await view.agents.findAgent(revision.namespaceId, revision.agentId),
          }));
          if (
            resources.namespace !== undefined &&
            resources.agent !== undefined &&
            this.compute.bindAgent !== undefined
          ) {
            await this.withClaimHeartbeat(claim, async () => {
              await this.compute.bindAgent!({
                namespace: resources.namespace!,
                agent: resources.agent!,
              });
            });
          }
          // Session service outages cannot delay exact workload/material retirement.
          await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(revision));
        }
      } else {
        const attempts = await this.state.read(async (view) =>
          (await view.repositorySessions.listNamespaceAttempts(claim.namespaceId)).filter(
            (attempt) => attempt.revisionId === cleanupRevisionId,
          ),
        );
        ({ settled: complete, cause } = await this.repositoryCredentials.cleanupRetained(
          claim,
          attempts,
        ));
      }
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      complete = false;
      cause = repositoryCleanupFailureCode(error);
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const attempts =
        claim.agentId === undefined
          ? (await unit.repositorySessions.listNamespaceAttempts(claim.namespaceId)).filter(
              (attempt) => attempt.revisionId === cleanupRevisionId,
            )
          : await unit.repositorySessions.listRevisionAttempts({
              namespaceId: claim.namespaceId,
              agentId: claim.agentId,
              revisionId: cleanupRevisionId,
            });
      if (complete) {
        complete = !attempts.some(
          (attempt) => attempt.phase === "closing" || attempt.phase === "invalidated",
        );
      }
      if (
        !complete &&
        cause === undefined &&
        attempts.some(({ phase }) => phase === "invalidated")
      ) {
        cause = "REPOSITORY_ATTEMPT_INVALIDATED";
      }
      if (complete) {
        await queue.complete(claim);
      } else {
        // A session still closing keeps the configured cadence whatever else is stuck: its
        // disposal must not wait on an unrelated invalidated attempt. Otherwise a stuck
        // cleanup keeps its obligation visible but slows down with age, like long readiness
        // rechecks. The row's age spans every obligation it has carried for the revision.
        await queue.defer(
          claim,
          { code: "REPOSITORY_CLEANUP_PENDING" },
          {
            delayMs:
              cause === undefined || attempts.some(({ phase }) => phase === "closing")
                ? this.repositoryCleanupRetryMs
                : repositoryCleanupRecheckMs(this.repositoryCleanupRetryMs, this.workAgeMs(claim)),
          },
        );
      }
    }, this.queueOptions);
    this.reportRepositoryCleanupCause(claim, complete ? undefined : cause);
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: cleanupRevisionId,
      outcome: complete ? "success" : "pending",
      code: complete ? "REPOSITORY_CLEANUP_COMPLETE" : "REPOSITORY_CLEANUP_PENDING",
    });
  }

  /** Log a stuck cleanup's cause once per work item and cause, not on every recheck. */
  private reportRepositoryCleanupCause(claim: ClaimedWork, cause: string | undefined): void {
    const key = claim.idempotencyKey;
    if (cause === undefined) {
      this.repositoryCleanupCauses.delete(key);
      return;
    }
    if (this.repositoryCleanupCauses.get(key) === cause) {
      return;
    }
    this.repositoryCleanupCauses.delete(key);
    this.repositoryCleanupCauses.set(key, cause);
    if (this.repositoryCleanupCauses.size > MAX_STOPPED_PREDECESSOR_RECORDS) {
      // Forgetting a record only costs one repeated warning.
      const oldest = this.repositoryCleanupCauses.keys().next().value;
      if (oldest !== undefined) {
        this.repositoryCleanupCauses.delete(oldest);
      }
    }
    this.emit({
      event: "worker.repository-cleanup-warning",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: repositoryCleanupRevisionId(claim),
      code: "REPOSITORY_CLEANUP_STALLED",
      cause,
    });
  }

  private async closeRevisionCredentials(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    options: { readonly awaitCleanup?: boolean } = {},
  ): Promise<void> {
    if (revision.repositoryCredentials !== undefined) {
      // An unavailable service leaves durable cleanup work; workload shutdown continues.
      await this.repositoryCredentials.closeRevision(claim, revision, options);
    }
  }

  private async process(claim: ClaimedWork): Promise<void> {
    if (claim.kind === "provisioning") {
      await this.processAgentProvisioning(claim);
      return;
    }
    if (claim.agentTarget === "sandbox_policy") {
      this.passOutcome = await reconcileSandboxPolicy(
        {
          state: this.state,
          queueOptions: this.queueOptions,
          driver: this.sandbox,
          compute: this.compute,
          iam: this.iam,
          installationId: this.installation!.id,
          ceiling: this.policyCeiling,
          configurations: this.configurations,
          signal: this.abort.signal,
          maxAttempts: this.maxAttempts,
          deadlineMs: this.convergenceTimeoutMs,
          leaseDurationMs: this.leaseDurationMs,
        },
        claim,
      );
      return;
    }
    if (isRepositoryCleanupWork(claim)) {
      await this.processRepositoryCleanup(claim);
      return;
    }
    // A withdrawal names the active revision, an admitted successor, or a predecessor not yet
    // retired, but never deploys it.
    if (isCredentialWithdrawalWork(claim)) {
      await this.processCredentialWithdrawal(claim);
      return;
    }
    if (claim.revisionId !== undefined) {
      await this.processRevision(claim);
      return;
    }
    if (claim.agentTarget !== undefined) {
      if (claim.agentTarget === "deleted") {
        await this.processAgentDeletion(claim);
      } else {
        await this.processAgentStop(claim);
      }
      return;
    }
    if (claim.agentId !== undefined || claim.namespaceTarget === undefined) {
      await this.finalize(claim, undefined, { outcome: "permanent", code: "INVALID_TARGET" });
      return;
    }
    let namespace: Readonly<Namespace> | undefined;
    let result: DispatchResult;
    try {
      namespace = await this.state.read((view) => view.namespaces.findNamespace(claim.namespaceId));
      const expected = claim.namespaceTarget === "ready" ? "provisioning" : "deleting";
      if (namespace === undefined || namespace.status !== expected) {
        await this.finalize(claim, namespace, { outcome: "success", code: "SUPERSEDED_TARGET" });
        return;
      }
      const denied = await this.authorize(claim, namespace);
      if (denied !== undefined) {
        await this.finalize(claim, namespace, denied);
        return;
      }
      if (!(await this.renewClaim(claim))) {
        throw new WorkClaimLostError();
      }
      result = await this.observe(claim, namespace);
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalize(claim, namespace, result);
  }

  private async processAgentProvisioning(claim: ClaimedWork): Promise<void> {
    const controller = this.provisioningController;
    if (controller === undefined) {
      throw new Error("The provisioning controller is unavailable.");
    }
    const result = await controller.processAgentProvisioning(claim, resolveApprovedHarness, {
      runEffect: (operation) => this.withClaimHeartbeat(claim, operation),
    });
    this.passOutcome = result.outcome === "succeeded" ? "success" : result.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      outcome: this.passOutcome,
      code: result.outcome === "succeeded" ? "PROVISIONING_COMPLETED" : result.code,
      ...(result.outcome === "succeeded" ? { revisionId: result.revisionId } : {}),
      // A Compute refusal's reason; status and the Collector export keep only the code.
      ...(result.outcome !== "succeeded" && result.reason !== undefined
        ? { reason: result.reason }
        : {}),
      // A refused job's unrecorded Configuration its Driver could not delete (finding 1395).
      ...(result.outcome !== "succeeded" && result.orphanedConfigurationId !== undefined
        ? { orphanedConfigurationId: result.orphanedConfigurationId }
        : {}),
    });
  }

  private async processAgentStop(claim: ClaimedWork): Promise<void> {
    let result: AgentStopDispatchResult;
    let stopping: Readonly<AgentRevision> | undefined;
    try {
      if (
        claim.agentId === undefined ||
        claim.agentTarget !== "stopped" ||
        claim.namespaceTarget !== undefined
      ) {
        await this.finalizeAgentStop(claim, { outcome: "permanent", code: "INVALID_TARGET" });
        return;
      }
      const authorizedAgent = await this.state.read((view) =>
        view.agents.findAgent(claim.namespaceId, claim.agentId!),
      );
      if (authorizedAgent === undefined) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      const denied = await this.authorizeAgentAction(claim, authorizedAgent, "operate");
      if (denied !== undefined) {
        await this.finalizeAgentStop(claim, { ...denied, agent: authorizedAgent });
        return;
      }
      // Admission may change desired state while IAM is consulted. Reload the exact
      // Agent immediately before any backend effect so a later deployment wins.
      const resources = await this.state.read(async (view) => {
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const revisions = await view.revisions.listRevisions(claim.namespaceId, claim.agentId!);
        return { namespace, agent, revisions };
      });
      const { namespace, agent, revisions } = resources;
      if (
        namespace === undefined ||
        agent === undefined ||
        agent.servicePrincipalId !== authorizedAgent.servicePrincipalId
      ) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      if (agent.desiredRuntimeState !== "stopped") {
        await this.finalizeAgentStop(claim, {
          outcome: "success",
          code: "STOP_SUPERSEDED",
          agent,
        });
        return;
      }
      const active = revisions.find((revision) => revision.id === agent.activeRevisionId);
      if (agent.activeRevisionId !== undefined && active === undefined) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_ACTIVE_REVISION",
          agent,
        });
        return;
      }
      if (active !== undefined && !revisionAdmittedBeforeWork(active, claim)) {
        await this.finalizeAgentStop(claim, { outcome: "success", code: "STOP_SUPERSEDED", agent });
        return;
      }
      const ownedByCompute = (revision: Readonly<AgentRevision>) =>
        revision.compute.id === this.compute.id &&
        revision.compute.implementation === this.compute.implementation;
      if (active !== undefined && !ownedByCompute(active)) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
          agent,
          revision: active,
        });
        return;
      }
      // A terminal candidate or a predecessor with failed retirement can still
      // own resources. Capture this Driver's history once; never include a later
      // admission, and stop the serving revision before any candidate cleanup.
      const cleanup = [
        ...(active === undefined ? [] : [active]),
        ...revisions.filter(
          (revision) =>
            revision.id !== active?.id &&
            ownedByCompute(revision) &&
            revisionAdmittedBeforeWork(revision, claim),
        ),
      ];
      if (
        cleanup.some(
          (revision) =>
            revision.agentId !== agent.id ||
            revision.namespaceId !== agent.namespaceId ||
            revision.servicePrincipalId !== agent.servicePrincipalId,
        )
      ) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
          agent,
        });
        return;
      }
      if (cleanup.length > 0 && this.compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await this.compute.bindAgent!({ namespace, agent });
        });
      }
      for (const revision of cleanup) {
        const current = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (current === undefined || current.servicePrincipalId !== agent.servicePrincipalId) {
          await this.finalizeAgentStop(claim, {
            outcome: "permanent",
            code: "INVALID_AGENT_OWNER",
          });
          return;
        }
        if (current.desiredRuntimeState !== "stopped") {
          await this.finalizeAgentStop(claim, {
            outcome: "success",
            code: "STOP_SUPERSEDED",
            agent: current,
          });
          return;
        }
        await this.closeRevisionCredentials(claim, revision);
        const afterClose = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (afterClose?.desiredRuntimeState !== "stopped") {
          await this.finalizeAgentStop(claim, {
            outcome: "success",
            code: "STOP_SUPERSEDED",
            ...(afterClose === undefined ? {} : { agent: afterClose }),
          });
          return;
        }
        stopping = revision;
        await this.stopYieldingDrain(claim, revision);
      }
      result = {
        outcome: "success",
        code: active === undefined ? "AGENT_ALREADY_STOPPED" : "AGENT_STOPPED",
        agent,
        ...(active === undefined ? {} : { revision: active }),
      };
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      // The Sandbox gateway refused the controller's identity, so the Driver could not confirm
      // the revision's Sandbox gone: retrying cannot help until an operator restores the role,
      // so the stop fails with that code instead of recording the Sandbox stopped (finding 1676).
      // An identity the gateway could not authenticate mends itself (a token file or signing
      // key between refreshes), so it retries within the attempt budget first (finding 1694).
      result =
        error instanceof ComputeStopYieldedError
          ? {
              outcome: "pending",
              code: "AGENT_STOP_YIELDED",
              ...(stopping === undefined ? {} : { revision: stopping }),
            }
          : error instanceof SandboxGatewayUnauthorizedError
            ? { outcome: error.transient ? "retry" : "permanent", code: error.code }
            : { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalizeAgentStop(claim, result);
  }

  /**
   * Stops a revision whose Gateway drain may yield: a stopped Agent's revision, or a predecessor
   * that exclusive replacement stops before its successor starts. While the work is younger than
   * the convergence deadline, the Gateway drain wait ends once other Work is due
   * (ComputeStopYieldedError) and the work is deferred to repeat the stop. Older work keeps the
   * full bounded wait, so a drain that never ends cannot defer it forever (finding 1088). Age
   * counts from the work's creation: maintenance work is created one interval before it is due,
   * so a convergence deadline shorter than the maintenance interval leaves its stops without
   * yielding. Stops that yielded during their own drain do not count as due Work (see
   * withClaimHeartbeat; finding 1093).
   */
  private stopYieldingDrain(claim: ClaimedWork, revision: Readonly<AgentRevision>): Promise<void> {
    return this.withClaimHeartbeat(claim, () =>
      stopWithDrainYield(this.workAgeMs(claim), this.convergenceTimeoutMs, () =>
        this.compute.stopRevision(revision),
      ),
    );
  }

  /** When work whose stop yielded to other Work runs again: 1 s, growing with its age to 5 s. */
  private stopYieldRecheckMs(claim: ClaimedWork): number {
    return stopYieldRecheckMs(this.workAgeMs(claim));
  }

  /**
   * Records a committed stop-yield deferral (`code`). Returns the work's yield count when its
   * `worker.completed` line is due: the first yield, then at most one a minute (finding 1094).
   */
  private recordStopYield(claim: ClaimedWork, code: StopYieldedCode): number | undefined {
    this.stopYieldedThisPass = true;
    return this.stopYields.yielded(claim.idempotencyKey, code);
  }

  private async processAgentDeletion(claim: ClaimedWork): Promise<void> {
    let result: AgentDeletionDispatchResult;
    try {
      if (
        claim.agentId === undefined ||
        claim.agentTarget !== "deleted" ||
        claim.namespaceTarget !== undefined
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_TARGET",
        });
        return;
      }
      const resources = await this.state.read(async (view) => {
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const revisions =
          agent === undefined
            ? []
            : await view.revisions.listRevisions(claim.namespaceId, claim.agentId!);
        const provisioning =
          agent === undefined
            ? undefined
            : await view.provisioning.findByAgent(claim.namespaceId, claim.agentId!);
        return { namespace, agent, revisions, provisioning };
      });
      const { namespace, agent, revisions, provisioning } = resources;
      if (namespace === undefined || agent === undefined) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      if (agent.status !== "deleting" || agent.desiredRuntimeState !== "stopped") {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_STATE",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      const denied = await this.authorizeAgentAction(claim, agent, "delete");
      if (denied !== undefined) {
        await this.finalizeAgentDeletion(claim, { ...denied, namespace, agent, revisions });
        return;
      }
      if (
        revisions.some(
          (revision) =>
            revision.namespaceId !== namespace.id ||
            revision.agentId !== agent.id ||
            revision.servicePrincipalId !== agent.servicePrincipalId,
        )
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      if (
        revisions.some(
          (revision) =>
            revision.compute.id !== this.compute.id ||
            revision.compute.implementation !== this.compute.implementation,
        )
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      if (
        this.compute.provisionAgentRuntimeCredentials !== undefined &&
        this.compute.deleteAgentRuntimeCredentials === undefined
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "CREDENTIAL_DELETION_UNSUPPORTED",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      const pendingProvisioningEffect =
        provisioning === undefined ? undefined : provisioningPendingEffect(provisioning);
      const settledProvisioningEffect =
        pendingProvisioningEffect === undefined
          ? undefined
          : provisioningEffectReceiptForRecord(provisioning!);
      let abandonedProvisioningEffect: AgentDeletionDispatchResult["abandonedProvisioningEffect"];
      if (
        provisioning?.progress.pendingEffect !== undefined &&
        (pendingProvisioningEffect === undefined ||
          !pendingProvisioningEffect.ownerPresent ||
          settledProvisioningEffect === undefined ||
          settledProvisioningEffect.kind !== pendingProvisioningEffect.kind ||
          settledProvisioningEffect.owner !== pendingProvisioningEffect.owner ||
          settledProvisioningEffect.targetId !== pendingProvisioningEffect.targetId)
      ) {
        // A cancelled provisioning never runs again, so nothing else will settle
        // its effect. After a former claim's lease has run out, this teardown
        // removes what the effect could have written and settles it itself.
        // Malformed or conflicting evidence stays fail-closed.
        const abandonAfterMs = provisioning.updatedAt.getTime() + this.leaseDurationMs - Date.now();
        if (
          provisioning.status !== "cancelled" ||
          pendingProvisioningEffect?.ownerPresent !== true ||
          settledProvisioningEffect !== undefined ||
          abandonAfterMs > 0
        ) {
          await this.finalizeAgentDeletion(claim, {
            outcome: "pending",
            code: "PROVISIONING_EFFECT_PENDING",
            namespace,
            agent,
            revisions,
            ...(abandonAfterMs > 0 ? { delayMs: Math.ceil(abandonAfterMs) } : {}),
          });
          return;
        }
        abandonedProvisioningEffect = {
          workId: provisioning.workId,
          receipt: {
            kind: pendingProvisioningEffect.kind,
            owner: pendingProvisioningEffect.owner!,
            targetId: pendingProvisioningEffect.targetId,
          },
        };
      }
      if (revisions.length > 0 && this.compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await this.compute.bindAgent!({ namespace, agent });
        });
      }
      for (const revision of revisions) {
        await this.closeRevisionCredentials(claim, revision, { awaitCleanup: false });
        await this.withClaimHeartbeat(claim, () => this.compute.retireRevision(revision));
      }
      if (this.compute.deleteAgentRuntimeCredentials !== undefined) {
        await this.withClaimHeartbeat(claim, () =>
          this.compute.deleteAgentRuntimeCredentials!({ namespace, agent }),
        );
      }
      result = {
        outcome: "success",
        code: "AGENT_DELETED",
        namespace,
        agent,
        revisions,
        ...(abandonedProvisioningEffect === undefined ? {} : { abandonedProvisioningEffect }),
      };
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      // As for a stop: a refused identity cannot confirm a Sandbox removed (finding 1676), and
      // an unauthenticated one retries first (finding 1694).
      result =
        error instanceof SandboxGatewayUnauthorizedError
          ? { outcome: error.transient ? "retry" : "permanent", code: error.code }
          : { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalizeAgentDeletion(claim, result);
  }

  private async authorizeAgentAction(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
    action: "delete" | "operate",
    principalId: string = claim.actorId,
  ): Promise<DispatchResult | undefined> {
    const authorization: AuthorizationRequest = {
      principalId,
      action,
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const state = await this.loadIAMState();
    // Consult IAM before classifying a revoked actor so Driver failures still retry.
    const decision = await this.iamDecision(this.iam, authorization);
    if (!state.identities.some((identity) => identity.id === principalId)) {
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };
    }
    return undefined;
  }

  private async finalizeAgentDeletion(
    claim: ClaimedWork,
    result: AgentDeletionDispatchResult,
  ): Promise<void> {
    if (result.outcome === "success") {
      if (claim.agentId === undefined) {
        throw new Error("The worker Agent deletion context is unavailable.");
      }
      const abandoned = result.abandonedProvisioningEffect;
      const completed = await this.state.transactWithQueue(async (unit, queue) => {
        if (abandoned !== undefined) {
          // Committed only with the finalizer's claim check in this transaction.
          await unit.provisioning.settleEffect(abandoned.workId, abandoned.receipt);
        }
        const completed = await queue.completeAgentDeletion(
          claim,
          claim.namespaceId,
          claim.agentId!,
        );
        if (completed === "cleanup-pending") {
          await queue.defer(claim, { code: "REPOSITORY_CLEANUP_PENDING" });
        }
        return completed;
      }, this.queueOptions);
      if (completed === "cleanup-pending") {
        this.passOutcome = "pending";
        this.emit({
          event: "worker.completed",
          ...workLogFields(claim),
          namespaceId: claim.namespaceId,
          agentId: claim.agentId,
          outcome: "pending",
          code: "REPOSITORY_CLEANUP_PENDING",
        });
        return;
      }
    } else {
      await this.state.transactWithQueue(async (unit, queue) => {
        if ((await queue.heartbeat(claim)) === undefined) {
          throw new WorkClaimLostError();
        }
        const terminalFailure =
          result.outcome === "permanent" ||
          (result.outcome === "retry" && claim.attemptCount >= this.maxAttempts);
        if (result.decision !== undefined) {
          await this.appendAgentDenial(unit, claim, result, "deletion");
        } else if (terminalFailure) {
          await this.appendAgentDeletionOutcome(unit, claim, result);
        }
        if (terminalFailure) {
          await queue.fail(claim, { code: result.code });
        } else if (result.outcome === "pending") {
          // Convergence waits do not consume the bounded failure budget.
          await queue.defer(
            claim,
            { code: result.code },
            result.delayMs === undefined ? {} : { delayMs: result.delayMs },
          );
        } else {
          await queue.retry(claim, { code: result.code });
        }
      }, this.queueOptions);
    }
    this.passOutcome =
      result.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : result.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      // `result` is the Driver's classification; `outcome` the queue's decision, so a retry that
      // spent the attempt budget reads `permanent` here, as the hint says (finding 1694).
      result: result.outcome,
      outcome: this.passOutcome,
      code: result.code,
      ...refusalHintField(this.passOutcome === "permanent", result.code),
    });
  }

  private async appendAgentDeletionOutcome(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentDeletionDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent deletion audit context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.delete",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: "failure",
      details: {
        computeDriverId: this.compute.id,
        reasonCode: result.code,
      },
    });
  }

  private async finalizeAgentStop(
    claim: ClaimedWork,
    result: AgentStopDispatchResult,
  ): Promise<void> {
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      if (result.outcome === "success" && result.agent !== undefined) {
        const agent = await this.lockClaimAgent(unit, claim);
        if (agent === undefined || agent.servicePrincipalId !== result.agent.servicePrincipalId) {
          result = { outcome: "permanent", code: "INVALID_AGENT_OWNER" };
        } else if (agent.desiredRuntimeState !== "stopped") {
          // A later deployment may retain the old active pointer while preparing.
          // Never clear it merely because the final exact stop call completed.
          result = { ...result, code: "STOP_SUPERSEDED" };
        } else if (result.revision !== undefined && agent.activeRevisionId === result.revision.id) {
          await unit.agents.compareAndClearActiveRevision(
            claim.namespaceId,
            agent.id,
            result.revision.id,
          );
        }
      }
      const terminalFailure =
        result.outcome === "permanent" ||
        (result.outcome === "retry" && claim.attemptCount >= this.maxAttempts);
      if (result.decision !== undefined) {
        await this.appendAgentDenial(unit, claim, result, "stop");
      } else if (result.outcome === "success" || terminalFailure) {
        await this.appendAgentStopOutcome(unit, claim, result);
      }

      if (result.outcome === "success") {
        await queue.complete(claim);
      } else if (terminalFailure) {
        await queue.fail(claim, { code: result.code });
      } else if (result.outcome === "pending") {
        // A stop that yielded to due Work refunds its attempt and runs again after that Work.
        // Repeated yields are not failures, so they record no evidence; the outcome does.
        await queue.defer(
          claim,
          { code: result.code },
          { delayMs: this.stopYieldRecheckMs(claim), recordEvidence: false },
        );
      } else {
        await queue.retry(claim, { code: result.code });
      }
    }, this.queueOptions);
    this.passOutcome =
      result.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : result.outcome;
    if (result.outcome === "success" && result.code !== "STOP_SUPERSEDED") {
      this.metrics?.observeAgentOperation("stop", this.workAgeMs(claim) / 1000);
    }
    let stopYields: number | undefined;
    if (result.outcome === "pending" && result.code === "AGENT_STOP_YIELDED") {
      stopYields = this.recordStopYield(claim, result.code);
      if (stopYields === undefined) {
        return;
      }
    } else {
      stopYields = this.stopYields.count(claim.idempotencyKey);
    }
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: result.revision?.id,
      // As for a deletion: `outcome` is the queue's decision (finding 1694).
      result: result.outcome,
      outcome: this.passOutcome,
      code: result.code,
      ...stopYieldsField(stopYields),
      ...refusalHintField(this.passOutcome === "permanent", result.code),
    });
  }

  private async appendAgentStopOutcome(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentStopDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent stop audit context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.stop",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: result.outcome === "success" ? "success" : "failure",
      details: {
        computeDriverId: this.compute.id,
        reasonCode: result.code,
        ...(result.revision === undefined ? {} : { revisionId: result.revision.id }),
      },
    });
  }

  private async appendAgentDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: DispatchResult,
    operation: "deletion" | "stop",
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error(`The worker Agent ${operation} authorization context is unavailable.`);
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: operation === "deletion" ? "openclaw.agents.delete" : "openclaw.agents.stop",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  /**
   * Revokes every pending withdrawal of the revision's sources from its Sandbox, in admission
   * order: the Harness source first, then each non-model source. A withdrawal is marked
   * `revoked` only after the gateway confirms it; anything still pending retries with backoff.
   */
  private async processCredentialWithdrawal(claim: ClaimedWork): Promise<void> {
    let result: CredentialWithdrawalDispatchResult;
    let requested: readonly Readonly<CredentialWithdrawal>[] = [];
    const denied: CredentialWithdrawalAttempt[] = [];
    const attempts: CredentialWithdrawalAttempt[] = [];
    try {
      if (claim.agentId === undefined || claim.revisionId === undefined) {
        await this.finalizeCredentialWithdrawal(claim, {
          outcome: "permanent",
          code: "INVALID_TARGET",
        });
        return;
      }
      const agent = await this.state.read((view) =>
        view.agents.findAgent(claim.namespaceId, claim.agentId!),
      );
      if (agent === undefined) {
        await this.finalizeCredentialWithdrawal(claim, {
          outcome: "success",
          code: "WITHDRAWAL_REVISION_RETIRED",
        });
        return;
      }
      const { revision, pending } = await this.state.read(async (view) => {
        const found = await view.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        if (found === undefined) {
          return { revision: found, pending: [] };
        }
        // Admission withdraws only sources the revision was admitted with.
        const pendingWithdrawals: {
          readonly withdrawal: Readonly<CredentialWithdrawal>;
          readonly source: Readonly<CredentialSource>;
        }[] = [];
        for (const sourceId of revisionCredentialSourceIds(found)) {
          const withdrawal = await view.credentialSources.findCredentialWithdrawal(
            claim.namespaceId,
            found.id,
            sourceId,
          );
          const source = await view.credentialSources.findCredentialSource(
            claim.namespaceId,
            sourceId,
          );
          // A source's deletion removes its withdrawals, so it has nothing left to revoke.
          if (withdrawal?.state === "pending" && source !== undefined) {
            pendingWithdrawals.push({ withdrawal, source });
          }
        }
        return { revision: found, pending: pendingWithdrawals };
      });
      // A retired revision took its Sandbox and attachments with it.
      if (revision === undefined) {
        await this.finalizeCredentialWithdrawal(claim, {
          outcome: "success",
          code: "WITHDRAWAL_REVISION_RETIRED",
        });
        return;
      }
      requested = pending.map(({ withdrawal }) => withdrawal);
      // Earlier attempts already revoked every requested source.
      if (pending.length === 0) {
        await this.finalizeCredentialWithdrawal(claim, {
          outcome: "success",
          code: "CREDENTIALS_WITHDRAWN",
          nothingPending: true,
        });
        return;
      }
      // Requests for different sources share this claim, so each withdrawal's own requester
      // must still operate the Agent before its source is detached. The claim actor's
      // authority never stands in for another requester's.
      const allowed: typeof pending = [];
      for (const entry of pending) {
        const denial = await this.authorizeAgentAction(
          claim,
          agent,
          "operate",
          entry.withdrawal.requestedBy,
        );
        if (denial === undefined) {
          allowed.push(entry);
        } else {
          denied.push({
            credentialSourceId: entry.withdrawal.credentialSourceId,
            requestedBy: entry.withdrawal.requestedBy,
            code: denial.code,
            revoked: false,
            denial: {
              ...(denial.authorization === undefined
                ? {}
                : { authorization: denial.authorization }),
              ...(denial.decision === undefined ? {} : { decision: denial.decision }),
            },
          });
        }
      }
      const authorized = allowed.map(({ withdrawal }) => withdrawal);
      if (allowed.length > 0) {
        if (
          revision.compute.id !== this.compute.id ||
          revision.compute.implementation !== this.compute.implementation
        ) {
          await this.finalizeCredentialWithdrawal(claim, {
            outcome: "permanent",
            code: "COMPUTE_DRIVER_MISMATCH",
            attempts: [...unrevokedAttempts(authorized, "COMPUTE_DRIVER_MISMATCH"), ...denied],
          });
          return;
        }
        const withdraw = this.compute.withdrawCredentialSource?.bind(this.compute);
        if (withdraw === undefined) {
          await this.finalizeCredentialWithdrawal(claim, {
            outcome: "permanent",
            code: "CREDENTIAL_WITHDRAWAL_UNSUPPORTED",
            attempts: [
              ...unrevokedAttempts(authorized, "CREDENTIAL_WITHDRAWAL_UNSUPPORTED"),
              ...denied,
            ],
          });
          return;
        }
        for (const { withdrawal, source } of allowed) {
          const status = await this.withClaimHeartbeat(claim, (signal) =>
            withdraw(revision, source, signal),
          );
          const revoked = status.state === "revoked" || status.state === "absent";
          attempts.push({
            credentialSourceId: source.id,
            requestedBy: withdrawal.requestedBy,
            code: revoked ? "CREDENTIALS_WITHDRAWN" : "CREDENTIAL_WITHDRAWAL_PENDING",
            revoked,
          });
        }
      }
      result = settleCredentialWithdrawal([...attempts, ...denied]);
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      // Confirmed revocations stand; every withdrawal not yet confirmed or denied retries,
      // including one IAM failed to authorize, so no earlier denial stays its last reason. A
      // Compute refusal that retrying cannot change (a configuration that cannot reach the
      // Sandbox, or an object Compute does not own) fails them once instead, as a Compute
      // mismatch does; a replay tries again. So does a Sandbox gateway that refuses the
      // controller's identity (finding 1676): retrying cannot restore the Workspace role, and
      // the reason names the fix instead of a generic failure. An identity the gateway could
      // not authenticate keeps the reason but retries first (finding 1694).
      const coded =
        error instanceof CredentialWithdrawalRefusedError ||
        error instanceof SandboxGatewayUnauthorizedError;
      const refused =
        coded && !(error instanceof SandboxGatewayUnauthorizedError && error.transient);
      const code = coded ? error.code : "DEPENDENCY_UNAVAILABLE";
      const settled = new Set(
        [...attempts, ...denied].map(({ credentialSourceId }) => credentialSourceId),
      );
      result = {
        outcome: refused ? "permanent" : "retry",
        code,
        attempts: [
          ...attempts,
          ...unrevokedAttempts(
            requested.filter(({ credentialSourceId }) => !settled.has(credentialSourceId)),
            code,
          ),
          ...denied,
        ],
      };
    }
    await this.finalizeCredentialWithdrawal(claim, result);
  }

  private async finalizeCredentialWithdrawal(
    claim: ClaimedWork,
    dispatched: CredentialWithdrawalDispatchResult,
  ): Promise<void> {
    let result = dispatched;
    const terminal = ({ outcome }: CredentialWithdrawalDispatchResult) =>
      outcome === "permanent" || (outcome === "retry" && claim.attemptCount >= this.maxAttempts);
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      result = dispatched;
      let terminalFailure = terminal(result);
      // A terminal failure's queue transition locks the Namespace and Agent for cleanup. Take
      // them first, in admission order, before updating withdrawal rows: a concurrent
      // withdrawal request locks the Namespace, then the Agent, then the same rows. Under those
      // locks, a replay that took a denied withdrawal over during this pass is settled.
      if (terminalFailure) {
        await this.lockClaimScope(unit, claim);
        result = await this.withoutReassignedDenials(unit, claim, result);
        terminalFailure = terminal(result);
      }
      // Each row explains a withdrawal that is still pending, including after the last attempt.
      const at = new Date().toISOString();
      for (const attempt of result.attempts ?? []) {
        await unit.credentialSources.recordCredentialWithdrawalAttempt(
          claim.namespaceId,
          claim.revisionId!,
          attempt.credentialSourceId,
          { reason: attempt.code, at },
        );
        if (attempt.revoked) {
          await unit.credentialSources.markCredentialWithdrawalRevoked(
            claim.namespaceId,
            claim.revisionId!,
            attempt.credentialSourceId,
            at,
          );
        }
      }
      const attempts = result.attempts ?? [];
      // Each confirmed revocation is audited as its requester's mutation in the pass that
      // confirmed it, so a later retry cannot lose it.
      const revokedBy = sourceIdsByRequester(attempts.filter(({ revoked }) => revoked));
      for (const [actorId, credentialSourceIds] of revokedBy) {
        await this.appendCredentialWithdrawalAudit(unit, claim, {
          actorId,
          outcome: "success",
          code: "CREDENTIALS_WITHDRAWN",
          credentialSourceIds,
        });
      }
      if (result.outcome !== "retry" || terminalFailure) {
        // Denials are final for this claim and audited once, against each denied requester.
        for (const attempt of attempts) {
          if (attempt.denial !== undefined) {
            await this.appendCredentialWithdrawalAudit(unit, claim, {
              actorId: attempt.requestedBy,
              outcome: "denied",
              code: attempt.code,
              credentialSourceIds: [attempt.credentialSourceId],
              ...attempt.denial,
            });
          }
        }
        const unsettled = attempts.filter(
          ({ revoked, denial }) => !revoked && denial === undefined,
        );
        // A failure is audited against each unsettled withdrawal's requester, as a revocation
        // is, so a withdrawal a replay took over is not attributed to the claim's actor.
        if (terminalFailure) {
          const failedBy = sourceIdsByRequester(unsettled);
          if (attempts.length === 0) {
            failedBy.set(claim.actorId, []);
          }
          for (const [actorId, credentialSourceIds] of failedBy) {
            await this.appendCredentialWithdrawalAudit(unit, claim, {
              actorId,
              outcome: "failure",
              code: result.code,
              credentialSourceIds,
            });
          }
        }
      }
      if (result.outcome === "success") {
        await queue.complete(claim);
      } else if (terminalFailure) {
        await queue.fail(claim, { code: result.code });
        if (result.outcome === "retry") {
          await this.scheduleCredentialWithdrawalRecovery(unit, queue, claim);
        }
      } else {
        await queue.retry(claim, { code: result.code });
      }
    }, this.queueOptions);
    this.passOutcome = terminal(result) ? "permanent" : result.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      // `outcome` is the queue's decision; a terminal retry (`permanent` here) has its recovery
      // series queued (finding 1694).
      result: result.outcome,
      outcome: this.passOutcome,
      code: result.code,
      ...refusalHintField(terminal(result), result.code),
    });
  }

  /**
   * A denial checked the requester this pass read. A replay that made another operator the
   * requester since then (requestRevisionCredentialWithdrawal) leaves this claim as the
   * withdrawal's only work, so the denial must not end it: that withdrawal becomes unconfirmed
   * with CREDENTIAL_WITHDRAWAL_REASSIGNED, and a claim that only denials failed retries, so
   * its next attempt authorizes the new requester. Other outcomes stand. Runs under the
   * Namespace and Agent locks, which the replay takes before it reassigns.
   */
  private async withoutReassignedDenials(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: CredentialWithdrawalDispatchResult,
  ): Promise<CredentialWithdrawalDispatchResult> {
    const attempts = result.attempts ?? [];
    if (!attempts.some(({ denial }) => denial !== undefined)) {
      return result;
    }
    const current = await unit.credentialSources.listCredentialWithdrawals(
      claim.namespaceId,
      claim.revisionId!,
    );
    let reassigned = false;
    const settled = attempts.map((attempt): CredentialWithdrawalAttempt => {
      const withdrawal = current.find(
        ({ credentialSourceId }) => credentialSourceId === attempt.credentialSourceId,
      );
      if (
        attempt.denial === undefined ||
        withdrawal?.state !== "pending" ||
        withdrawal.requestedBy === attempt.requestedBy
      ) {
        return attempt;
      }
      reassigned = true;
      return {
        credentialSourceId: attempt.credentialSourceId,
        requestedBy: withdrawal.requestedBy,
        code: "CREDENTIAL_WITHDRAWAL_REASSIGNED",
        revoked: false,
      };
    });
    if (!reassigned) {
      return result;
    }
    // settleCredentialWithdrawal failed the claim only for its denials when every other
    // withdrawal was revoked; it now retries. Any other failure keeps its outcome and code.
    if (
      result.outcome === "permanent" &&
      attempts.every(({ revoked, denial }) => revoked || denial !== undefined)
    ) {
      return { outcome: "retry", code: "CREDENTIAL_WITHDRAWAL_REASSIGNED", attempts: settled };
    }
    return { ...result, attempts: settled };
  }

  /**
   * One bounded step of the native Harness exposure sweep per loop pass, before the claim, as
   * stale-claim recovery runs. The first pass lists the revisions (one read, no claim): every
   * active revision whose Sandbox Driver may hold the exposure, and every newer candidate whose
   * deployment failed for good; the Kubernetes Driver declares no maintenance interval, so no
   * pass would reach them otherwise. Each later pass withdraws for at most one due revision,
   * so a provider that does not answer costs one bounded call per pass. The withdrawal is
   * idempotent and churns nothing: a revision without the exposure is confirmed and dropped.
   */
  private async withdrawPendingHarnessExposure(): Promise<void> {
    const compute = this.compute;
    if (compute.withdrawHarnessExposure === undefined || this.stopping) {
      return;
    }
    // Listed once per start, with bounded retries; candidates handed over by terminal
    // failures share the map and are withdrawn whether or not the listing succeeded.
    if (
      !this.harnessExposureListed &&
      this.harnessExposureListingFailures < MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS
    ) {
      let listed: Map<string, PendingHarnessExposureWithdrawal> | undefined;
      try {
        listed = await this.listHarnessExposureWithdrawals();
      } catch {
        if (this.stopping || this.abort.signal.aborted) {
          return;
        }
        this.harnessExposureListingFailures += 1;
        this.emit({
          event: "worker.harness-exposure-sweep-failed",
          code: "WORKER_UNAVAILABLE",
          attempt: this.harnessExposureListingFailures,
        });
      }
      if (listed !== undefined) {
        this.harnessExposureListed = true;
        for (const [revisionId, candidate] of listed) {
          if (!this.harnessExposureWithdrawals.has(revisionId)) {
            this.harnessExposureWithdrawals.set(revisionId, candidate);
          }
        }
        if (this.harnessExposureWithdrawals.size > 0) {
          this.emit({
            event: "worker.harness-exposure-sweep",
            pending: this.harnessExposureWithdrawals.size,
          });
        }
      }
    }
    const now = Date.now();
    const pending = [...this.harnessExposureWithdrawals.values()].find(
      (candidate) => candidate.dueAt <= now,
    );
    if (pending === undefined) {
      return;
    }
    const { revision } = pending;
    const fields = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    try {
      await withComputeAbortSignal(this.abort.signal, () =>
        compute.withdrawHarnessExposure!(revision, this.abort.signal),
      );
    } catch (error) {
      if (this.stopping || this.abort.signal.aborted) {
        return;
      }
      pending.attempts += 1;
      const permanent = pending.attempts >= MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS;
      if (permanent) {
        this.harnessExposureWithdrawals.delete(revision.id);
      } else {
        pending.dueAt =
          Date.now() + HARNESS_EXPOSURE_WITHDRAWAL_RETRY_BASE_MS * 2 ** (pending.attempts - 1);
      }
      const code = harnessExposureWithdrawalCode(error);
      // A target that vanished between the Driver's read and its delete (a failed candidate
      // retired by the next activation, or a role lost in between) is unconfirmed, not failed:
      // the next attempt settles it through the Driver's absence check (finding 1696). An
      // exposure dropped on its last attempt is a failure whatever the error, since nothing
      // settles it before the next start.
      this.emit({
        event:
          code === SANDBOX_DELETION_UNCONFIRMED && !permanent
            ? "worker.harness-exposure-withdrawal-unconfirmed"
            : "worker.harness-exposure-withdrawal-failed",
        ...fields,
        code,
        attempt: pending.attempts,
        outcome: permanent ? "permanent" : "retry",
      });
      return;
    }
    this.harnessExposureWithdrawals.delete(revision.id);
    this.emit({ event: "worker.harness-exposure-withdrawn", ...fields });
  }

  /**
   * A candidate that failed for good keeps its Sandbox for diagnosis, and with it the exposure
   * Compute's status read used, which nothing reads any more and which the Gateway's node
   * binding never closed (finding 1672): the sweep withdraws it from the next pass on, and a
   * restart lists it again from its failed deployment (as a non-active revision). An active
   * revision is left alone: its exposure went with its readiness. The failure is already
   * committed, so a read that fails here only defers the withdrawal to the next start.
   */
  private async scheduleFailedCandidateExposureWithdrawal(claim: ClaimedWork): Promise<void> {
    if (
      this.compute.withdrawHarnessExposure === undefined ||
      claim.agentId === undefined ||
      claim.revisionId === undefined
    ) {
      return;
    }
    const { agent, revision } = await this.state.read(async (view) => ({
      agent: await view.agents.findAgent(claim.namespaceId, claim.agentId!),
      revision: await view.revisions.findRevision(
        claim.namespaceId,
        claim.agentId!,
        claim.revisionId!,
      ),
    }));
    if (
      revision === undefined ||
      agent?.activeRevisionId === revision.id ||
      !holdsNativeHarnessExposure(revision, this.compute)
    ) {
      return;
    }
    if (!this.harnessExposureWithdrawals.has(revision.id)) {
      this.harnessExposureWithdrawals.set(revision.id, { revision, attempts: 0, dueAt: 0 });
    }
  }

  private async listHarnessExposureWithdrawals(): Promise<
    Map<string, PendingHarnessExposureWithdrawal>
  > {
    const listed = await this.state.read(async (view) => {
      const found: {
        readonly activeRevisionId: string | undefined;
        readonly revisions: readonly Readonly<AgentRevision>[];
      }[] = [];
      for (const namespace of await view.namespaces.listNamespaces()) {
        // A Namespace fails only from `provisioning` (no Agent ran in it), and `deleting`
        // releases the provider Workspace with every Sandbox in it.
        if (namespace.status !== "ready") {
          continue;
        }
        for (const agent of await view.agents.listAgents(namespace.id)) {
          const revisions = await view.revisions.listRevisions(namespace.id, agent.id);
          const active = revisions.find(({ id }) => id === agent.activeRevisionId);
          // Older revisions were retired when the active one activated; a newer candidate
          // that failed keeps its Sandbox until the next activation retires it.
          const candidates = revisions.filter(
            (revision) =>
              holdsNativeHarnessExposure(revision, this.compute) &&
              (active === undefined ||
                revision.id === active.id ||
                revision.revision > active.revision),
          );
          if (candidates.length > 0) {
            found.push({ activeRevisionId: agent.activeRevisionId, revisions: candidates });
          }
        }
      }
      return found;
    });
    const pending = new Map<string, PendingHarnessExposureWithdrawal>();
    for (const { activeRevisionId, revisions } of listed) {
      for (const revision of revisions) {
        if (revision.id !== activeRevisionId) {
          const deployment = await this.queue.findWork(`agent_revision:${revision.id}:reconcile`);
          if (deployment?.state !== "failed_permanent") {
            continue;
          }
        }
        pending.set(revision.id, { revision, attempts: 0, dueAt: 0 });
      }
    }
    return pending;
  }

  /**
   * Withdrawal work that ran out of attempts on a retryable failure (an unreachable gateway, or
   * one that has not confirmed revocation yet) queues one later series of attempts for its
   * revision, in the transaction that fails it, or right after stale-claim recovery fails it
   * (scheduleRecoveredCredentialWithdrawals). Compute without a maintenance interval (the
   * Kubernetes Driver) has no pass that would re-queue it, so without this a dependency outage
   * longer than the attempt budget would leave a token usable after the dependency recovers.
   * The queued series keeps `withdrawalInProgress` true while it waits. Each series waits twice
   * as long as the one before, up to five minutes, and the chain ends after
   * MAX_CREDENTIAL_WITHDRAWAL_RECOVERIES series. Where Compute schedules maintenance, each pass
   * re-queues the withdrawal instead (recoverPendingCredentialWithdrawals). A revision whose
   * pending withdrawals all await a replay gets none, and neither does one whose replay already
   * queued an attempt (credentialWithdrawalNeedsAttempt). The Namespace and Agent are already
   * locked here, as for any terminal failure.
   */
  private async scheduleCredentialWithdrawalRecovery(
    unit: PlatformUnitOfWork,
    queue: Pick<PostgresWorkQueue, "enqueue">,
    claim: ControllerWork,
  ): Promise<void> {
    const recovery = nextCredentialWithdrawalRecovery(claim.idempotencyKey);
    if (
      this.maintenanceIntervalMs !== undefined ||
      recovery.number > MAX_CREDENTIAL_WITHDRAWAL_RECOVERIES
    ) {
      return;
    }
    const next = firstPendingCredentialWithdrawal(
      await unit.credentialSources.listCredentialWithdrawals(claim.namespaceId, claim.revisionId!),
    );
    if (next === undefined || !(await credentialWithdrawalNeedsAttempt(unit, next))) {
      return;
    }
    await queue.enqueue({
      idempotencyKey: recovery.idempotencyKey,
      namespaceId: claim.namespaceId,
      agentId: claim.agentId!,
      revisionId: claim.revisionId!,
      actorId: claim.actorId,
      agentTarget: CREDENTIAL_WITHDRAWAL_TARGET,
      availableAt: new Date(Date.now() + credentialWithdrawalRecoveryDelayMs(recovery.number)),
    });
  }

  /**
   * Stale-claim recovery fails withdrawal work whose lease ran out on its last attempt (its
   * worker died, or a gateway call outlasted the lease) without the worker's final pass. Each
   * such item gets its next series here, as if that pass had failed it, in its own transaction
   * that takes the Namespace and Agent first. A replay queued in between wins (the
   * outstanding-work check), so this never starts a second chain. An item that cannot be
   * scheduled is reported and left for a replay; the others still are.
   */
  private async scheduleRecoveredCredentialWithdrawals(
    failed: readonly ControllerWork[],
  ): Promise<void> {
    if (this.maintenanceIntervalMs !== undefined) {
      return;
    }
    for (const work of failed) {
      if (!isCredentialWithdrawalWork(work) || work.agentId === undefined) {
        continue;
      }
      try {
        await this.state.transactWithQueue(async (unit, queue) => {
          await this.lockClaimScope(unit, work);
          await this.scheduleCredentialWithdrawalRecovery(unit, queue, work);
        }, this.queueOptions);
      } catch {
        this.emit({
          event: "worker.error",
          code: "WORKER_UNAVAILABLE",
          workId: work.idempotencyKey,
          operation: workOperation(work),
        });
      }
    }
  }

  private async appendCredentialWithdrawalAudit(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    entry: {
      readonly actorId: string;
      readonly outcome: "success" | "failure" | "denied";
      readonly code: string;
      readonly credentialSourceIds: readonly string[];
      readonly authorization?: AuthorizationRequest;
      readonly decision?: AuthorizationDecision;
    },
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker credential withdrawal audit context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: entry.outcome === "denied" ? "authorization_denial" : "mutation",
      actorId: entry.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.credentials_withdraw",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(entry.authorization === undefined ? {} : { authorization: entry.authorization }),
      ...(entry.decision === undefined ? {} : { decisionReason: entry.decision.reason }),
      ...(entry.outcome === "denied" ? { reasonCode: entry.code } : {}),
      outcome: entry.outcome,
      details: {
        computeDriverId: this.compute.id,
        reasonCode: entry.code,
        ...(claim.revisionId === undefined ? {} : { revisionId: claim.revisionId }),
        ...(entry.credentialSourceIds.length === 0
          ? {}
          : { credentialSourceIds: [...entry.credentialSourceIds] }),
      },
    });
  }

  /**
   * A model-withdrawn revision must not be prepared again. Maintenance recovers every pending
   * withdrawal, including tool sources and those of revisions that may still run with a source
   * (see pendingCredentialWithdrawals), and stops only after all revocations are confirmed.
   */
  private async completeWithdrawnRevisionMaintenance(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    try {
      await this.recheckRevokedCredentialSources(claim, revision);
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      // A failed recheck ends only this claim; the maintenance chain continues, so the next
      // pass rechecks again and still re-queues pending withdrawals.
      const pending = activationPendingResult(error);
      await this.finalizeActiveRevision(claim, revision, pending.code, undefined, {
        ...(pending.dependencyFailure === undefined
          ? {}
          : { dependencyFailure: pending.dependencyFailure }),
        failureLogFields: revisionFailureLogFields(error),
      });
      return;
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      // Namespace first, as every transaction that may also lock it (the work insert's
      // foreign key) must.
      await unit.namespaces.lockNamespace(revision.namespaceId, { includeDeleted: true });
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const pending = await this.pendingCredentialWithdrawals(unit, revision);
      await this.requeueCredentialWithdrawals(unit, pending);
      await queue.complete(claim, { code: "CREDENTIAL_WITHDRAWN" });
      if (pending.length > 0 && this.revisionMaintenanceInterval(revision) !== undefined) {
        await this.enqueueMaintenance(queue, claim, revision);
      }
    }, this.queueOptions);
    this.passOutcome = "success";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: "success",
      outcome: "success",
      code: "CREDENTIAL_WITHDRAWN",
    });
  }

  /**
   * A withdrawal that found no Sandbox records the source revoked, yet a CreateSandbox that
   * OpenShell accepted before its worker lost the claim can still land afterwards, with the
   * source attached. Before each preparation, and each pass of a model-withdrawn revision,
   * the gateway detaches every revoked source again if the Sandbox still lists it. Revoked
   * rows stay revoked; the next pass checks again until the Sandbox no longer lists it. A
   * recheck needs no requester reauthorization: the revocation is already recorded.
   */
  private async recheckRevokedCredentialSources(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const withdraw = this.compute.withdrawCredentialSource?.bind(this.compute);
    const sourceIds = revisionCredentialSourceIds(revision);
    if (withdraw === undefined || sourceIds.length === 0) {
      return;
    }
    const sources = await this.state.read(async (view) => {
      const revokedIds = new Set(
        (await view.credentialSources.listCredentialWithdrawals(revision.namespaceId, revision.id))
          .filter(({ state }) => state === "revoked")
          .map(({ credentialSourceId }) => credentialSourceId),
      );
      const revoked: Readonly<CredentialSource>[] = [];
      // Admission order, as withdrawal uses.
      for (const sourceId of sourceIds) {
        if (!revokedIds.has(sourceId)) {
          continue;
        }
        // A deleted source took its gateway provider, and its withdrawals, with it.
        const source = await view.credentialSources.findCredentialSource(
          revision.namespaceId,
          sourceId,
        );
        if (source !== undefined) {
          revoked.push(source);
        }
      }
      return revoked;
    });
    for (const source of sources) {
      await this.withClaimHeartbeat(claim, (signal) =>
        withdraw(revision, source, signal, { recheck: true }),
      );
    }
  }

  /**
   * Withdrawal work retries a bounded number of times. Maintenance of a revision that keeps
   * running re-queues any pending non-model withdrawal, its own or that of a revision that may
   * still run with a source, so a gateway outage cannot leave a token usable after the gateway
   * recovers. Without Compute maintenance, scheduleCredentialWithdrawalRecovery queues a bounded
   * chain of later attempts instead. Ordinary maintenance then continues.
   */
  private async recoverPendingCredentialWithdrawals(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const sourceIds = new Set((revision.credentialSources ?? []).map(({ sourceId }) => sourceId));
    const pending = await this.state.read((view) =>
      this.pendingCredentialWithdrawals(view, revision, sourceIds),
    );
    if (pending.every(credentialWithdrawalAwaitsReplay)) {
      return;
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.lockNamespace(revision.namespaceId, { includeDeleted: true });
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      await this.requeueCredentialWithdrawals(
        unit,
        await this.pendingCredentialWithdrawals(unit, revision, sourceIds),
      );
    }, this.queueOptions);
  }

  /**
   * The pending credential withdrawals that maintenance of the active `revision` recovers, one
   * per revision, preferring one that does not await a replay: its own (only of `sourceIds`,
   * when given), then those of the revisions that may still run with a withdrawn source
   * (credentialWithdrawalCompanionRevisions). No other pass would ever queue those: a successor
   * has no maintenance before it activates, and a predecessor's ends once it is superseded. In
   * practice they are admitted successors: an active revision gets a maintenance chain only once
   * its deployment activated it, which retires its predecessors, so an unretired predecessor's
   * withdrawal is retried by a replay.
   */
  private async pendingCredentialWithdrawals(
    view: PlatformReadView,
    revision: Readonly<AgentRevision>,
    sourceIds?: ReadonlySet<string>,
  ): Promise<readonly Readonly<CredentialWithdrawal>[]> {
    const withdrawals = await view.credentialSources.listCredentialWithdrawals(
      revision.namespaceId,
      revision.id,
    );
    // A withdrawal records a row on the then-active revision with every other revision's, and
    // a successor that activates has its own, so without one there is nothing to recover. This
    // keeps the revision walk off the maintenance passes of Agents that never withdrew a source.
    if (withdrawals.length === 0) {
      return [];
    }
    const own = firstPendingCredentialWithdrawal(
      withdrawals.filter(
        ({ credentialSourceId }) => sourceIds === undefined || sourceIds.has(credentialSourceId),
      ),
    );
    const pending = own === undefined ? [] : [own];
    const companions = await credentialWithdrawalCompanionRevisions(
      view,
      await view.revisions.listRevisions(revision.namespaceId, revision.agentId),
      revision,
      new Date(),
    );
    for (const companion of companions) {
      // Rows exist only for sources the revision holds, so none needs filtering here.
      const found = firstPendingCredentialWithdrawal(
        await view.credentialSources.listCredentialWithdrawals(companion.namespaceId, companion.id),
      );
      if (found !== undefined) {
        pending.push(found);
      }
    }
    return pending;
  }

  /**
   * Queues withdrawal work for each revision's pending withdrawal that has no attempt queued
   * or running, so one outage costs one bounded series of attempts per maintenance pass. The
   * work re-checks each withdrawal's own requester, as for a replay. A withdrawal that awaits a
   * replay is skipped, so a denied requester's withdrawal is not retried on every pass. Its
   * revision's work, re-queued for another of its withdrawals, still rechecks and audits it.
   */
  private async requeueCredentialWithdrawals(
    unit: PlatformUnitOfWork,
    pending: readonly Readonly<CredentialWithdrawal>[],
  ): Promise<void> {
    for (const withdrawal of pending) {
      if (!(await credentialWithdrawalNeedsAttempt(unit, withdrawal))) {
        continue;
      }
      await unit.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: CREDENTIAL_WITHDRAWAL_TARGET,
        namespaceId: withdrawal.namespaceId,
        resourceId: withdrawal.revisionId,
        actorId: withdrawal.requestedBy,
        operationId: randomUUID(),
      });
    }
  }

  private beginDeployPass(claim: ClaimedWork): void {
    // Maintenance, cleanup and stop work are not deployments.
    if (claim.idempotencyKey !== `agent_revision:${claim.revisionId}:reconcile`) {
      return;
    }
    let timing = this.deployTimings.get(claim.idempotencyKey);
    if (timing === undefined) {
      if (this.deployTimings.size >= MAX_DEPLOY_TIMINGS) {
        this.deployTimings.delete(this.deployTimings.keys().next().value!);
      }
      timing = {
        passes: 0,
        passStartedAt: 0,
        prepareMs: 0,
        firstUnreadyAt: undefined,
        readinessWaitMs: undefined,
        readyAt: undefined,
      };
      this.deployTimings.set(claim.idempotencyKey, timing);
    }
    timing.passes += 1;
    timing.passStartedAt = Date.now();
    timing.readyAt = undefined;
  }

  /**
   * Phase timing for the deployment pass that is finishing. Milliseconds are
   * worker wall clock: `durationMs` is this pass, `prepareMs` sums Compute
   * preparation across passes, `readinessWaitMs` runs from the first unready
   * observation to the first ready one (or now), `activationMs` runs from this
   * pass's ready observation to completion, and `elapsedMs` is since admission,
   * by the database clock (`workAgeMs`).
   */
  private deployTimingFields(claim: ClaimedWork): Readonly<Record<string, number>> {
    const timing = this.deployTimings.get(claim.idempotencyKey);
    if (timing === undefined) {
      return {};
    }
    const now = Date.now();
    if (this.passOutcome === "success" || this.passOutcome === "permanent") {
      this.deployTimings.delete(claim.idempotencyKey);
    }
    let readinessWaitMs = timing.readinessWaitMs ?? 0;
    if (timing.readinessWaitMs === undefined && timing.firstUnreadyAt !== undefined) {
      readinessWaitMs = now - timing.firstUnreadyAt;
    }
    return {
      durationMs: now - timing.passStartedAt,
      deployPasses: timing.passes,
      prepareMs: timing.prepareMs,
      readinessWaitMs,
      ...(timing.readyAt === undefined ? {} : { activationMs: now - timing.readyAt }),
      elapsedMs: this.workAgeMs(claim),
    };
  }

  private async processRevision(claim: ClaimedWork): Promise<void> {
    this.beginDeployPass(claim);
    let result: RevisionDispatchResult;
    let failureLogFields: Readonly<Record<string, string | number>> | undefined;
    let refusalWaitRead = false;
    let claimAgent: Readonly<Agent> | undefined;
    try {
      if (
        claim.agentId === undefined ||
        claim.revisionId === undefined ||
        claim.namespaceTarget !== undefined ||
        claim.agentTarget !== undefined
      ) {
        await this.finalizeRevision(claim, { outcome: "permanent", code: "INVALID_TARGET" });
        return;
      }
      const resources = await this.state.read(async (view) => {
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const revision = await view.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        const previous =
          agent?.activeRevisionId === undefined
            ? undefined
            : await view.revisions.findRevision(
                claim.namespaceId,
                claim.agentId!,
                agent.activeRevisionId,
              );
        return { namespace, agent, revision, previous };
      });
      const { namespace, agent, revision, previous } = resources;
      claimAgent = agent;
      if (namespace === undefined || agent === undefined || revision === undefined) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
        });
        return;
      }
      await this.readRefusalWait(claim, agent, revision.id);
      refusalWaitRead = true;
      if (namespace.status !== "ready") {
        await this.finalizeRevision(claim, { outcome: "permanent", code: "NAMESPACE_NOT_READY" });
        return;
      }
      if (
        revision.namespaceId !== namespace.id ||
        revision.agentId !== agent.id ||
        revision.servicePrincipalId !== agent.servicePrincipalId
      ) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_ADMITTED_REVISION",
        });
        return;
      }
      const approvedHarness = resolveApprovedHarness(revision.harness.id, revision.harness.mode);
      if (approvedHarness === undefined || revision.harness.version !== approvedHarness.version) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "HARNESS_DESCRIPTOR_MISMATCH",
        });
        return;
      }
      if (
        revision.compute.id !== this.compute.id ||
        revision.compute.implementation !== this.compute.implementation
      ) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
        });
        return;
      }
      if (claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)) {
        const original = await this.queue.findWork(`agent_revision:${revision.id}:reconcile`);
        if (original === undefined) {
          await this.finalizeRevision(claim, { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" });
          return;
        }
        if (
          original.state === "failed_permanent" ||
          original.reasonCode === "REVISION_SUPERSEDED"
        ) {
          // Maintenance must never prepare or reactivate a terminally failed deployment.
          await this.finalizeRevision(claim, { outcome: "permanent", code: "REVISION_SUPERSEDED" });
          return;
        }
      }
      if (agent.activeRevisionId !== undefined && previous === undefined) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_ACTIVE_REVISION",
        });
        return;
      }
      const denied = await this.authorizeRevision(claim, agent, revision);
      if (denied !== undefined) {
        await this.finalizeRevision(claim, denied);
        return;
      }
      const backend = await this.resolveRevisionBackend(revision);
      if (backend !== undefined) {
        await this.finalizeRevision(claim, backend);
        return;
      }
      // Authorization and the backend are decided again above on every pass. Once a stored
      // refusal of theirs no longer stands (for example `deploy` granted again), the deployment
      // continues, as it did before the wait was stored. Past the convergence deadline it cannot
      // converge any more: preparing the candidate again only restarted it, and the deadline then
      // ended the work with it running beside a stopped predecessor (finding 1042). The wait
      // instead stops it and publishes the deadline.
      if (this.refusalWait !== undefined && REDECIDED_REFUSAL_CODES.has(this.refusalWait.refusal)) {
        this.refusalWait =
          this.workAgeMs(claim) >= this.convergenceTimeoutMs
            ? { ...this.refusalWait, refusal: "CONVERGENCE_DEADLINE_EXCEEDED" }
            : undefined;
      }
      if (agent.desiredRuntimeState === "stopped") {
        if (claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)) {
          if (revision.repositoryCredentials !== undefined) {
            await this.closeRevisionCredentials(claim, revision);
            if (this.compute.bindAgent !== undefined) {
              await this.withClaimHeartbeat(claim, async () => {
                await this.compute.bindAgent!({ namespace, agent });
              });
            }
            await this.stopYieldingDrain(claim, revision);
          }
          await this.completeStoppedRevisionWork(
            claim,
            revision,
            "REVISION_MAINTENANCE_SUPERSEDED",
          );
          return;
        }
        if (this.compute.bindAgent !== undefined) {
          await this.withClaimHeartbeat(claim, async () => {
            await this.compute.bindAgent!({ namespace, agent });
          });
        }
        await this.closeRevisionCredentials(claim, revision);
        await this.stopYieldingDrain(claim, revision);
        // Once this reconciliation has published its candidate, it owns retiring
        // every predecessor even if stop admission clears the active pointer before
        // a recovery attempt. A different active revision means this candidate was
        // never published, so its authorized stop work remains solely responsible.
        if (agent.activeRevisionId === revision.id || agent.activeRevisionId === undefined) {
          await this.retireEarlierRevisions(claim, revision);
        } else {
          // A predecessor stop this work started and yielded already removed that revision's
          // Gateway. Finish it before ending stopped, rather than leave its Harness and workspace
          // to the Agent-stop work alone (finding 1109). It is this work's own effect, authorized
          // when it started; a failure retries like this revision's own stop above, and a yield
          // waits on the stopped Agent's drain like that stop's (AGENT_STOP_YIELDED).
          try {
            await this.finishYieldedPredecessorStops(
              claim,
              this.refusalWait === undefined ? "yield" : "wait",
              "throw",
            );
          } catch (error) {
            throw error instanceof PredecessorStopYieldedError
              ? new ComputeStopYieldedError(error.message)
              : error;
          }
        }
        await this.completeStoppedRevisionWork(claim, revision, "REVISION_STOPPED");
        return;
      }
      // Exclusive preparation cannot allow an older maintenance/retry pass to
      // recreate a predecessor between the replacement's readiness observations.
      const successor =
        this.compute.requiresStoppedPredecessors === undefined
          ? undefined
          : await this.state.read(async (view) => {
              // Decode only the later revisions, in revision order, until one matches.
              const later = (
                await view.revisions.listRevisionMetadata(revision.namespaceId, revision.agentId)
              ).filter((candidate) => candidate.revision > revision.revision);
              for (const listed of later) {
                const candidate = await view.revisions.findRevision(
                  listed.namespaceId,
                  listed.agentId,
                  listed.id,
                );
                if (
                  candidate !== undefined &&
                  candidate.compute.id === this.compute.id &&
                  candidate.compute.implementation === this.compute.implementation &&
                  this.compute.requiresStoppedPredecessors?.(candidate) === true
                ) {
                  return candidate;
                }
              }
              return undefined;
            });
      if (successor !== undefined) {
        // A refusal decided after this check (lost repository authority, a Secret or
        // credential-source problem, a refused observation) may still wait on its candidate's
        // stop. The newer revision's sweep gives up at its own deadline, so finish that stop
        // before superseding; a failed stop keeps waiting (finding 1004).
        // The wait need not be the latest evidence: a lost claim or a retry may have followed it.
        // A stop this process made within a lease (the newer revision's sweep) is not repeated.
        const stopped = this.stoppedPredecessors.get(revision.id);
        const waited =
          claim.idempotencyKey === `agent_revision:${revision.id}:reconcile` &&
          (stopped === undefined || Date.now() - stopped.stoppedAt >= stopped.restopAfterMs)
            ? await this.queue.findWorkAttempt(
                claim.idempotencyKey,
                "REFUSED_CANDIDATE_STOP_PENDING",
              )
            : undefined;
        if (waited !== undefined) {
          await this.stopRefusedCandidate(claim, waited.refusal ?? "UNKNOWN_FAILURE");
        }
        // A predecessor stop this work yielded is finished before handing off too: the newer
        // revision stops every predecessor only if its own pass gets that far, and a refusal
        // before then would leave the predecessor's Harness running without its Gateway
        // (finding 1090). It still yields, unless a stored refusal's wait owns the deferral.
        const predecessorStop = await this.finishYieldedPredecessorStops(
          claim,
          this.refusalWait === undefined ? "yield" : "wait",
        );
        await this.finalizeRevision(
          claim,
          { outcome: "success", code: "REVISION_SUPERSEDED", supersededBy: successor },
          predecessorStop,
        );
        return;
      }
      if (this.refusalWait !== undefined) {
        // The refusal is already decided and recorded: retry its stop before anything that could
        // restart the candidate or fail first. Re-running the pass re-stopped predecessors and
        // re-prepared the candidate when Compute had refused it, so on Kubernetes its fresh Pods
        // kept a yielding stop from ever finishing (finding 1034), and an error before the refusal
        // ended the work with the candidate running (finding 1033).
        if (previous !== undefined && previous.revision >= revision.revision) {
          // A newer revision activated beside this shared candidate; it retires the candidate. (An
          // error before this point retries the stop and publishes the refusal instead.)
          await this.finalizeRevision(claim, {
            outcome: "success",
            code: "REVISION_SUPERSEDED",
            supersededBy: previous,
          });
          return;
        }
        const refusal = this.refusalWait.refusal;
        await this.stopRefusedCandidate(claim, refusal);
        await this.finalizeRevision(claim, {
          ...this.storedRefusalResult(refusal),
          refusedCandidateStopped: true,
        });
        return;
      }
      if (revision.repositoryCredentials !== undefined) {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      }
      if (
        agent.activeRevisionId === revision.id &&
        revision.harnessAuth.method === "credential_source" &&
        claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)
      ) {
        const sourceId = revision.harnessAuth.sourceId;
        const withdrawal = await this.state.read((view) =>
          view.credentialSources.findCredentialWithdrawal(
            revision.namespaceId,
            revision.id,
            sourceId,
          ),
        );
        if (withdrawal !== undefined) {
          await this.completeWithdrawnRevisionMaintenance(claim, revision);
          return;
        }
      }
      if (
        agent.activeRevisionId === revision.id &&
        claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)
      ) {
        await this.recoverPendingCredentialWithdrawals(claim, revision);
      }
      // Deploy and repair work must never re-attach a withdrawn source.
      const secretContext = await this.resolveRevisionSecretContext(revision);
      if ("result" in secretContext) {
        if (agent.activeRevisionId === revision.id) {
          await this.finalizeActiveRevision(claim, revision, secretContext.result.code);
        } else {
          await this.finalizeRevision(claim, secretContext.result);
        }
        return;
      }
      if (this.compute.bindAgent !== undefined) {
        try {
          await this.withClaimHeartbeat(claim, async () => {
            await this.compute.bindAgent!({ namespace, agent });
          });
        } catch (error) {
          if (error instanceof WorkClaimLostError || agent.activeRevisionId !== revision.id) {
            throw error;
          }
          await this.finalizeActiveRevision(claim, revision, "COMPUTE_BINDING_INCOMPLETE");
          return;
        }
      }
      if (agent.activeRevisionId === revision.id) {
        let resultData: Readonly<Record<string, unknown>> | undefined;
        try {
          const compute = this.compute;
          // Publishing the active pointer precedes activation. Reobserve even when
          // periodic maintenance is disabled so recovery verifies current readiness.
          const prepared = await this.prepareRevision(claim, revision, secretContext.context);
          const observation = prepared.observation;
          const context = prepared.context;
          if (!validRevisionObservation(observation, revision)) {
            await this.finalizeRevision(claim, {
              outcome: "permanent",
              code: "INVALID_DRIVER_OBSERVATION",
            });
            return;
          }
          resultData = pluginWarningsResultData(
            computePluginWarnings(observation.warnings, revision) ?? Object.freeze([]),
          );
          if (!observation.ready) {
            await this.finalizeActiveRevision(
              claim,
              revision,
              revisionPendingCode(observation),
              runtimeFailureFromObservation(observation),
            );
            return;
          }
          if (this.shouldActivatePublishedRevision(compute)) {
            if (revision.repositoryCredentials !== undefined) {
              await this.assertRepositoryAuthority(claim, revision);
              this.repositoryCredentials.validate(revision);
            }
            await this.withClaimHeartbeat(claim, () =>
              this.stagedRevision("activateRevision", revision, context),
            );
          }
          await this.retireEarlierRevisions(claim, revision);
        } catch (error) {
          // A yielded predecessor stop ends the pass pending below, like a candidate's.
          if (
            error instanceof WorkClaimLostError ||
            error instanceof RepositoryCredentialAuthorityError ||
            error instanceof ComputeStopYieldedError ||
            error instanceof ComputePreparationFailedError
          ) {
            throw error;
          }
          // As for a lost repository credential authority, this ends a maintenance
          // claim's chain too: the revision cannot activate without a new one.
          if (
            error instanceof ActivationFailedError ||
            error instanceof CredentialSourceRevisionError
          ) {
            await this.finalizeRevision(
              claim,
              { outcome: "permanent", code: error.code },
              revisionFailureLogFields(error),
            );
            return;
          }
          const pending = activationPendingResult(error);
          await this.finalizeActiveRevision(claim, revision, pending.code, undefined, {
            ...(pending.dependencyFailure === undefined
              ? {}
              : { dependencyFailure: pending.dependencyFailure }),
            failureLogFields: revisionFailureLogFields(error),
          });
          return;
        }
        await this.completeActivatedRevision(claim, {
          outcome: "success",
          code: "REVISION_ALREADY_ACTIVE",
          revision,
          ...(resultData === undefined ? {} : { resultData }),
        });
        return;
      }
      if (previous !== undefined && previous.revision >= revision.revision) {
        await this.finalizeRevision(claim, {
          outcome: "success",
          code: "REVISION_SUPERSEDED",
          supersededBy: previous,
        });
        return;
      }
      if (!(await this.renewClaim(claim))) {
        throw new WorkClaimLostError();
      }
      result = await this.observeRevision(
        claim,
        revision,
        previous,
        agent.activeRevisionId,
        secretContext.context,
      );
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      if (!refusalWaitRead && !(error instanceof RefusedCandidateStopError)) {
        await this.rereadRefusalWait(claim, claimAgent, error);
      }
      if (error instanceof RefusedCandidateStopError) {
        ({ result, logFields: failureLogFields } = error.pending());
      } else {
        const dependencyFailure = revisionDependencyFailure(error);
        if (error instanceof ComputePreparationFailedError) {
          result = {
            outcome: "permanent",
            code: error.code,
            cleanupFailedPreparation: true,
            ...(error.evidence === undefined ? {} : { data: { preparation: error.evidence } }),
          };
        } else if (error instanceof SandboxGatewayUnauthorizedError) {
          // A missing Workspace role fails the deployment at once; an identity the gateway
          // could not authenticate retries within the attempt budget first (finding 1694).
          result = { outcome: error.transient ? "retry" : "permanent", code: error.code };
        } else if (
          error instanceof RepositoryCredentialAuthorityError ||
          error instanceof SandboxRevisionUnsupportedError ||
          error instanceof CredentialSourceRevisionError ||
          error instanceof ActivationFailedError
        ) {
          result = { outcome: "permanent", code: error.code };
        } else if (error instanceof ComputeStopYieldedError) {
          // A predecessor's or a stopped Agent's revision stop yielded to other Work; the next
          // pass repeats it.
          result = { outcome: "pending", code: stopYieldedCode(error)! };
        } else if (dependencyFailure !== undefined) {
          // A dependency that recovers by itself must not spend the attempt budget:
          // five quick retries end long before a Gateway route, an API server
          // that is converging under load, or a restarting Sandbox gateway comes back (D28).
          result = { outcome: "pending", code: dependencyFailure.code, dependencyFailure };
        } else {
          result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
        }
        failureLogFields = revisionFailureLogFields(dependencyFailure ?? error);
      }
    }
    try {
      await this.finalizeRevision(claim, result, failureLogFields);
    } catch (error) {
      // A refusal caught above (for example lost repository authority) stops its candidate here.
      if (!(error instanceof RefusedCandidateStopError)) {
        throw error;
      }
      const pending = error.pending();
      await this.finalizeRevision(claim, pending.result, pending.logFields);
    }
  }

  private async authorizeRevision(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    const state = await this.loadIAMState();
    const driver = this.iam;
    const authorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const actor = state.identities.find((identity) => identity.id === claim.actorId);
    if (actor === undefined) {
      const decision = await this.iamDecision(driver, authorization);
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    const identity = state.identities.find(
      (candidate) =>
        candidate.kind === "service_principal" &&
        candidate.id === revision.servicePrincipalId &&
        candidate.namespaceId === agent.namespaceId &&
        candidate.agentId === agent.id,
    );
    if (identity === undefined) {
      return { outcome: "permanent", code: "INVALID_AGENT_PRINCIPAL" };
    }
    const decision = await this.iamDecision(driver, authorization);
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };
    }

    const configurationAuthorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "read",
      resource: {
        kind: "configuration",
        id: revision.configurationId,
        namespaceId: revision.namespaceId,
      },
    };
    const configurationDecision = await this.iamDecision(driver, configurationAuthorization);
    if (!configurationDecision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization: configurationAuthorization,
        decision: configurationDecision,
      };
    }

    if (revision.harnessAuth === undefined || revision.harnessAuth === null) {
      return { outcome: "permanent", code: "HARNESS_AUTH_REQUIRED" };
    }
    const secretBindings = revisionSecretBindings(revision);
    if ("result" in secretBindings) {
      return secretBindings.result;
    }
    const refs = uniqueSecretRefs(secretBindings.bindings);
    const auth = revision.harnessAuth;
    if (isSecretHarnessAuth(auth)) {
      if (auth.source?.kind !== "secret" || auth.source.namespaceId !== revision.namespaceId) {
        return { outcome: "permanent", code: "INVALID_HARNESS_AUTH" };
      }
      if (
        !refs.some(
          (ref) => ref.id === auth.source.id && ref.namespaceId === auth.source.namespaceId,
        )
      ) {
        refs.push(auth.source);
      }
    } else if (
      !isServiceAccountHarnessAuth(auth) &&
      auth.method !== "credential_source" &&
      auth.method !== "runtime"
    ) {
      return { outcome: "permanent", code: "INVALID_HARNESS_AUTH" };
    }
    // Both the deploying actor and the Agent principal must still operate every source the
    // revision can attach. A withdrawn source, pending or revoked, never attaches again
    // (`resolveRevisionSecretContext`), so a grant removed from it must not fail maintenance
    // before maintenance re-queues the withdrawal itself.
    const withdrawnSourceIds = new Set(
      (
        await this.state.read((view) =>
          view.credentialSources.listCredentialWithdrawals(revision.namespaceId, revision.id),
        )
      ).map(({ credentialSourceId }) => credentialSourceId),
    );
    for (const sourceId of revisionCredentialSourceIds(revision)) {
      if (withdrawnSourceIds.has(sourceId)) {
        continue;
      }
      for (const principalId of [claim.actorId, revision.servicePrincipalId]) {
        const sourceAuthorization: AuthorizationRequest = {
          principalId,
          action: "operate",
          resource: {
            kind: "credential_source",
            id: sourceId,
            namespaceId: revision.namespaceId,
          },
        };
        const sourceDecision = await this.iamDecision(driver, sourceAuthorization);
        if (!sourceDecision.allowed) {
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            authorization: sourceAuthorization,
            decision: sourceDecision,
          };
        }
      }
    }
    for (const ref of refs) {
      for (const principalId of [claim.actorId, revision.servicePrincipalId]) {
        const secretAuthorization: AuthorizationRequest = {
          principalId,
          action: "operate",
          resource: ref,
        };
        const secretDecision = await this.iamDecision(driver, secretAuthorization);
        if (!secretDecision.allowed) {
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            authorization: secretAuthorization,
            decision: secretDecision,
          };
        }
      }
    }

    if (isServiceAccountHarnessAuth(auth)) {
      if (auth.source.namespaceId !== revision.namespaceId) {
        return { outcome: "permanent", code: "INVALID_HARNESS_AUTH" };
      }
      const accountAuthorization: AuthorizationRequest = {
        principalId: claim.actorId,
        action: "read",
        resource: {
          kind: "service_account",
          id: auth.source.id,
          namespaceId: revision.namespaceId,
        },
      };
      const accountDecision = await this.iamDecision(driver, accountAuthorization);
      if (!accountDecision.allowed) {
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          authorization: accountAuthorization,
          decision: accountDecision,
        };
      }
    }
    return undefined;
  }

  private async resolveRevisionBackend(
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    if (
      revision.backendId !== null &&
      this.backendMap.get(revision.backendId)?.type !== "chatgpt"
    ) {
      return { outcome: "permanent", code: "BACKEND_UNAVAILABLE" };
    }
    const auth = revision.harnessAuth;
    if (!isServiceAccountHarnessAuth(auth)) {
      return undefined;
    }
    const { account, binding } = await this.state.read(async (view) => ({
      account: await view.serviceAccounts.findServiceAccount(revision.namespaceId, auth.source.id),
      binding: await view.serviceAccounts.findServiceAccountBackendBinding(
        revision.namespaceId,
        auth.source.id,
      ),
    }));
    if (
      account === undefined ||
      account.namespaceId !== revision.namespaceId ||
      account.credential?.kind !== "access_token" ||
      auth.credential?.kind !== "access_token" ||
      account.credential.secretRef.name !== auth.credential.secretRef.name ||
      account.credential.secretRef.key !== auth.credential.secretRef.key
    ) {
      return { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_CHANGED" };
    }
    try {
      validateServiceAccountBackendBinding(this.backendMap, revision.backendId, binding);
      const admitted = auth.backendBinding;
      if (
        admitted === undefined ||
        binding === undefined ||
        binding.backendId !== admitted.backendId ||
        binding.driverId !== admitted.driverId ||
        binding.workspaceId !== admitted.workspaceId ||
        binding.credentialIssued !== admitted.credentialIssued
      ) {
        return { outcome: "permanent", code: "SERVICE_ACCOUNT_BACKEND_MISMATCH" };
      }
      return undefined;
    } catch {
      return { outcome: "permanent", code: "SERVICE_ACCOUNT_BACKEND_MISMATCH" };
    }
  }

  private async observeRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    previous: Readonly<AgentRevision> | undefined,
    expectedActiveRevisionId: string | undefined,
    context: ComputeRevisionContext,
  ): Promise<RevisionDispatchResult> {
    return this.withClaimHeartbeat(claim, async () => {
      const prepared = await this.prepareRevision(claim, revision, context);
      const observation = prepared.observation;
      context = prepared.context;
      if (!validRevisionObservation(observation, revision)) {
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      }
      const resultData = pluginWarningsResultData(
        computePluginWarnings(observation.warnings, revision) ?? Object.freeze([]),
      );
      if (!observation.ready) {
        const runtimeFailure = runtimeFailureFromObservation(observation);
        return {
          outcome: "pending",
          code: revisionPendingCode(observation),
          ...(runtimeFailure === undefined ? {} : { data: { runtimeFailure } }),
        };
      }
      if (revision.repositoryCredentials !== undefined) {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      }
      const agent = await this.state.read((view) =>
        view.agents.findAgent(revision.namespaceId, revision.agentId),
      );
      if (agent?.desiredRuntimeState !== "running") {
        // The Agent stopped during preparation. A yield ends the pass pending; the next pass
        // repeats the stop as a stopped Agent's revision.
        await this.closeRevisionCredentials(claim, revision);
        await this.stopYieldingDrain(claim, revision);
        return { outcome: "success", code: "REVISION_STOPPED" };
      }
      if (this.compute.activationOrder === "beforeCommit") {
        await this.stagedRevision("activateRevision", revision, context);
      } else if (
        this.mode === "production" &&
        revision.harness.mode === "dedicated" &&
        expectedActiveRevisionId === undefined
      ) {
        await this.stagedRevision("deactivateRevision", revision);
      }
      return {
        outcome: "success",
        code: "REVISION_ACTIVATED",
        revision,
        ...(resultData === undefined ? {} : { resultData }),
        context,
        ...(previous === undefined ? {} : { previous }),
        ...(expectedActiveRevisionId === undefined ? {} : { expectedActiveRevisionId }),
      };
    });
  }

  private async resolveRevisionSecretContext(
    revision: Readonly<AgentRevision>,
  ): Promise<
    { readonly context: ComputeRevisionContext } | { readonly result: RevisionDispatchResult }
  > {
    const bindings = revisionSecretBindings(revision);
    if ("result" in bindings) {
      return { result: bindings.result };
    }
    const secretDriverId = this.secretDriverId;
    if (
      Object.keys(bindings.bindings).length > 0 &&
      (typeof secretDriverId !== "string" || revision.secretDriverId !== secretDriverId)
    ) {
      return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
    }

    const resolved = await this.state.read(async (view) => {
      const projections: SecretEnvironmentProjection[] = [];
      for (const [name, binding] of Object.entries(bindings.bindings)) {
        const secret = await view.secrets.findSecret(binding.source.namespaceId, binding.source.id);
        if (
          secret === undefined ||
          secret.namespaceId !== revision.namespaceId ||
          secret.driverId !== secretDriverId ||
          secret.backendRef.namespaceName.trim().length === 0 ||
          secret.backendRef.name.trim().length === 0 ||
          secret.backendRef.key.trim().length === 0 ||
          secret.backendRef.uid.trim().length === 0
        ) {
          return undefined;
        }
        projections.push({
          name,
          secretId: secret.id,
          namespaceId: secret.namespaceId,
          agentId: revision.agentId,
          backendRef: secret.backendRef,
        });
      }
      return projections;
    });

    if (resolved === undefined) {
      return { result: { outcome: "permanent", code: "SECRET_BINDING_UNAVAILABLE" } };
    }

    let harnessAuth: ResolvedHarnessAuth;
    if (isSecretHarnessAuth(revision.harnessAuth)) {
      const auth = revision.harnessAuth;
      if (typeof secretDriverId !== "string" || auth.secretDriverId !== secretDriverId) {
        return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
      }
      const secret = await this.state.read((view) =>
        view.secrets.findSecret(auth.source.namespaceId, auth.source.id),
      );
      if (
        secret === undefined ||
        secret.namespaceId !== revision.namespaceId ||
        secret.namespaceId !== auth.source.namespaceId ||
        secret.id !== auth.source.id ||
        secret.driverId !== secretDriverId ||
        secret.backendRef.namespaceName.trim().length === 0 ||
        secret.backendRef.name.trim().length === 0 ||
        secret.backendRef.key.trim().length === 0 ||
        secret.backendRef.uid.trim().length === 0
      ) {
        return { result: { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_UNAVAILABLE" } };
      }
      // Admission verifies the physical source. Workers project authoritative
      // OCC metadata without requiring permission to read backend Secret values.
      harnessAuth = { ...auth, backendRef: secret.backendRef };
    } else if (revision.harnessAuth.method === "credential_source") {
      const auth = revision.harnessAuth;
      if (
        this.credentialGateway === undefined ||
        auth.credentialGatewayId !== this.credentialGateway.id
      ) {
        return { result: { outcome: "permanent", code: "CREDENTIAL_GATEWAY_MISMATCH" } };
      }
      const { source, withdrawal } = await this.state.read(async (view) => ({
        source: await view.credentialSources.findCredentialSource(
          revision.namespaceId,
          auth.sourceId,
        ),
        withdrawal: await view.credentialSources.findCredentialWithdrawal(
          revision.namespaceId,
          revision.id,
          auth.sourceId,
        ),
      }));
      // A withdrawn source never re-attaches to its revision, for example after Pod loss.
      if (withdrawal !== undefined) {
        return { result: { outcome: "permanent", code: "CREDENTIAL_WITHDRAWN" } };
      }
      // A deleting source can no longer be attached, even to an admitted revision.
      if (
        source === undefined ||
        source.state !== "ready" ||
        source.driverId !== auth.credentialGatewayId ||
        source.type !== auth.sourceType
      ) {
        return { result: { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_UNAVAILABLE" } };
      }
      harnessAuth = { ...auth, source };
    } else {
      harnessAuth = revision.harnessAuth;
    }
    const credentialSources: Readonly<CredentialSource>[] = [];
    for (const snapshot of revision.credentialSources ?? []) {
      // The Harness source is listed too; it resolves above through the Harness binding.
      if (snapshot.sourceId === revisionHarnessSourceId(revision)) {
        continue;
      }
      if (
        this.credentialGateway === undefined ||
        snapshot.credentialGatewayId !== this.credentialGateway.id
      ) {
        return { result: { outcome: "permanent", code: "CREDENTIAL_GATEWAY_MISMATCH" } };
      }
      const { source, withdrawal } = await this.state.read(async (view) => ({
        source: await view.credentialSources.findCredentialSource(
          revision.namespaceId,
          snapshot.sourceId,
        ),
        withdrawal: await view.credentialSources.findCredentialWithdrawal(
          revision.namespaceId,
          revision.id,
          snapshot.sourceId,
        ),
      }));
      // A withdrawn non-model source stays detached; the revision keeps running without it.
      if (withdrawal !== undefined) {
        continue;
      }
      if (
        source === undefined ||
        source.state !== "ready" ||
        source.driverId !== snapshot.credentialGatewayId ||
        source.type !== snapshot.sourceType
      ) {
        return { result: { outcome: "permanent", code: "CREDENTIAL_SOURCE_UNAVAILABLE" } };
      }
      credentialSources.push(source);
    }
    const workspaceSetup = await this.state.read((view) =>
      view.workspaceSetups.find(revision.namespaceId, revision.agentId),
    );
    if (workspaceSetup !== undefined && this.compute.supportsWorkspaceSetup !== true) {
      return { result: { outcome: "permanent", code: "WORKSPACE_SETUP_UNSUPPORTED" } };
    }
    return {
      context: {
        secretEnvironment: Object.freeze(resolved),
        harnessAuth,
        ...(credentialSources.length === 0
          ? {}
          : { credentialSources: Object.freeze(credentialSources) }),
        ...(workspaceSetup === undefined ? {} : { workspaceSetup }),
      },
    };
  }

  /** Renews the lease and re-anchors the work's age (`workAgeMs`); false once the claim is lost. */
  private async renewClaim(claim: ClaimedWork): Promise<boolean> {
    const renewed = await this.queue.heartbeat(claim);
    if (renewed === undefined) {
      return false;
    }
    this.workOrigins.set(claim, performance.now() - renewed.ageMs);
    return true;
  }

  private async withClaimHeartbeat<T>(
    claim: ClaimedWork,
    effect: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stopping || this.abort.signal.aborted) {
      throw new ClaimLeaseLostError("WORKER_STOPPING");
    }
    // Consecutive short effects can each finish before their timer fires while
    // the whole sequence outlives the lease. Renew before every external effect.
    const firstRenewal = performance.now();
    if (!(await this.renewClaim(claim))) {
      throw new ClaimLeaseLostError("CLAIM_RENEWAL_REFUSED");
    }
    let lost: ClaimLossCause | undefined;
    const operation = new AbortController();
    const abandon = (cause: ClaimLossCause) => {
      lost ??= cause;
      operation.abort(new ClaimLeaseLostError(cause));
    };
    const stopping = () => abandon("WORKER_STOPPING");
    // A renewal that is never answered (a silent connection) waits for the
    // database timeout, long after the lease. Another worker may own the claim
    // by then, so stop when the last confirmed lease runs out. Measured from
    // when the renewal was sent, this is never later than the stored expiry.
    // The renewal stores clock_timestamp() + lease at an unknown moment between
    // send and answer, so one answered after the lease proves nothing about now:
    // lease recovery may already have given the work to another worker. A late
    // renewal therefore loses the claim at once (finding 2137).
    let lapse: ReturnType<typeof setTimeout> | undefined;
    const confirmLease = (renewedAt: number): boolean => {
      clearTimeout(lapse);
      const now = performance.now();
      const remainingMs = renewedAt + this.leaseDurationMs - now;
      if (remainingMs <= 0) {
        this.emit({
          event: "worker.claim-renewal-warning",
          ...workLogFields(claim),
          code: "CLAIM_RENEWAL_LATE",
          durationMs: now - renewedAt,
        });
        return false;
      }
      lapse = setTimeout(() => abandon("CLAIM_LEASE_LAPSED"), remainingMs);
      lapse.unref();
      return true;
    };
    if (!confirmLease(firstRenewal)) {
      throw new ClaimLeaseLostError("CLAIM_RENEWAL_LATE");
    }
    this.progress();
    let pending = Promise.resolve();
    this.abort.signal.addEventListener("abort", stopping, { once: true });
    if (this.abort.signal.aborted) {
      stopping();
    }
    const heartbeat = setInterval(
      () => {
        pending = pending.then(async () => {
          const renewedAt = performance.now();
          if (!(await this.renewClaim(claim))) {
            abandon("CLAIM_RENEWAL_REFUSED");
          } else if (lost === undefined) {
            if (!confirmLease(renewedAt)) {
              abandon("CLAIM_RENEWAL_LATE");
              return;
            }
            this.progress();
            void this.health(false);
          }
        });
        pending.catch(() => {
          abandon("CLAIM_RENEWAL_FAILED");
        });
      },
      Math.max(1, Math.floor(this.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    // Readiness callbacks must not delay Compute or the next claim renewal.
    // health() serializes its own updates and reports failures separately.
    void this.health(false);
    try {
      // The worker is serial: Compute may end an optional in-pass wait early
      // when other Work could be claimed, instead of holding it back (D221).
      // Stops whose latest pass yielded during a Gateway drain are not due Work for a draining
      // stop, so draining stops do not take turns. Other waits skip only a stopped Agent's yielded
      // stop, whose next pass just rechecks its drain; a deployment whose predecessor's drain
      // ended deploys next. Every wait that asks is optional and bounded, so this only lets it
      // run to its own end (findings 1093, 1090, 1108).
      return await withComputeAbortSignal(operation.signal, () =>
        withComputeWorkWaiting(
          (wait) => this.queue.claimableWorkWaiting({ except: this.stopYields.waiting(wait) }),
          () => effect(operation.signal),
        ),
      );
    } finally {
      clearInterval(heartbeat);
      this.abort.signal.removeEventListener("abort", stopping);
      await pending.catch(() => {});
      clearTimeout(lapse);
      if (lost !== undefined) {
        throw new ClaimLeaseLostError(lost);
      }
    }
  }

  private async observe(
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult> {
    return this.withClaimHeartbeat(claim, async () => {
      if (claim.namespaceTarget === "deleted") {
        const attempts = await this.state.read((view) =>
          view.repositorySessions.listNamespaceAttempts(namespace.id),
        );
        const owners = new Map(attempts.map((attempt) => [attempt.revisionId, attempt]));
        for (const attempt of owners.values()) {
          const revision = await this.state.read((view) =>
            view.revisions.findRevision(attempt.namespaceId, attempt.agentId, attempt.revisionId),
          );
          if (revision !== undefined && revisionAdmittedBeforeWork(revision, claim)) {
            await this.closeRevisionCredentials(claim, revision);
          }
        }
      }
      const observation =
        claim.namespaceTarget === "ready"
          ? await this.compute.ensureNamespace(namespace)
          : await this.compute.deleteNamespace(namespace);
      if (!validObservation(observation, namespace.id, claim.namespaceTarget ?? "ready")) {
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      }
      const complete =
        "namespaceReady" in observation ? observation.namespaceReady : observation.namespaceDeleted;
      let outcome: Outcome;
      if (observation.failure === "permanent") {
        outcome = "permanent";
      } else if (complete && observation.failure === undefined) {
        outcome = "success";
      } else if (observation.failure === "retryable") {
        outcome = "retry";
      } else {
        outcome = "pending";
      }
      return {
        outcome,
        code: complete ? "NAMESPACE_RECONCILED" : "NAMESPACE_INCOMPLETE",
        observation,
      };
    });
  }

  /**
   * Whether a candidate's deployment work last saw its OAuth bootstrap still running: of its
   * readiness evidence, the newest is HARNESS_CREDENTIAL_BOOTSTRAP_PENDING. Transient dependency
   * failures, retries and lost claims say nothing about the bootstrap and are skipped. A later
   * readiness code wins, as it would for a pass that saw the deployment at the deadline: a
   * runtime that failed by itself stays for diagnosis. A ready pass records no readiness code, so
   * a revision published since (its activation can still fail transiently) is never retired.
   */
  private async bootstrapLastPending(claim: ClaimedWork): Promise<boolean> {
    if (!isCandidateDeployment(claim)) {
      return false;
    }
    const latest = await this.queue.findWorkAttempt(claim.idempotencyKey, [
      ...REVISION_READINESS_CODES,
    ]);
    if (latest?.code !== "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING") {
      return false;
    }
    // Only this claim publishes its candidate, so a pointer that is elsewhere now stays so.
    const agent = await this.state.read((view) =>
      view.agents.findAgent(claim.namespaceId, claim.agentId!),
    );
    return agent?.activeRevisionId !== claim.revisionId;
  }

  private async finalizeRevision(
    claim: ClaimedWork,
    result: RevisionDispatchResult,
    failureLogFields?: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    if (
      this.refusalWait?.idempotencyKey === claim.idempotencyKey &&
      result.refusedCandidate === undefined &&
      (result.outcome === "retry" || result.outcome === "pending")
    ) {
      // A pass that failed before retrying its stored refusal's stop retries that stop instead,
      // keeping the refusal: neither the attempt budget nor the deadline may end the wait with
      // the refused candidate running (finding 1033).
      result = this.storedRefusalResult(this.refusalWait.refusal);
    }
    const runtimeFailure =
      result.outcome === "pending"
        ? safeRuntimeFailureEvidence(result.data?.runtimeFailure)
        : undefined;
    // A yielded stop is not convergence: it yields only before the deadline and then waits.
    const expired =
      result.outcome === "pending" &&
      result.refusedCandidate === undefined &&
      !isStopYieldedCode(result.code) &&
      this.workAgeMs(claim) >= this.convergenceTimeoutMs;
    // Runtime entrypoints publish a runtime failure only after their own retries
    // end, and then hold the container unready until an explicit restart that
    // nothing performs: no liveness probe or controller restarts it. Waiting for
    // the convergence deadline therefore cannot change the result, so every held
    // failure ends the deployment at once with a code naming its cause. The kubelet
    // does restart a refused workspace setup, but it refuses the same way each time.
    const heldFailureCode =
      runtimeFailure === undefined ? undefined : heldRuntimeFailureCode(runtimeFailure.code);
    let resolved: RevisionDispatchResult;
    if (heldFailureCode !== undefined) {
      resolved = {
        outcome: "permanent",
        code: heldFailureCode,
        // A failed model probe keeps its evidence and the runtime's classified cause.
        ...(heldFailureCode === "RUNTIME_MODEL_PROBE_FAILED" ? { data: { runtimeFailure } } : {}),
      };
    } else if (expired && result.dependencyFailure !== undefined) {
      // The dependency was still failing at the deadline: name it, not the deadline.
      resolved = {
        outcome: "permanent",
        code: result.code,
        // This pass could not see the bootstrap, so the work's latest readiness evidence
        // stands in: a bootstrap last seen running is retired with the failure, as below
        // (finding 1165).
        ...((await this.bootstrapLastPending(claim))
          ? { cleanupFailedPreparation: true as const }
          : {}),
      };
    } else if (expired) {
      resolved = {
        ...result,
        outcome: "permanent",
        code: "CONVERGENCE_DEADLINE_EXCEEDED",
        data: convergenceDeadlineResultData(this.convergenceTimeoutMs, runtimeFailure),
        // No runtime exists yet to keep for diagnosis, and nothing else retires this revision:
        // its bootstrap Job and seed Secret (the OAuth token bundle) go with the failure. Only
        // a candidate's own deployment work can observe a bootstrap; an active revision's
        // source is already consumed.
        ...(result.code === "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING" && isCandidateDeployment(claim)
          ? { cleanupFailedPreparation: true as const }
          : {}),
      };
    } else {
      resolved = result;
    }
    if (resolved.outcome === "success" && resolved.revision?.repositoryCredentials !== undefined) {
      try {
        await this.assertRepositoryAuthority(claim, resolved.revision);
        this.repositoryCredentials.validate(resolved.revision);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        resolved =
          error instanceof RepositoryCredentialAuthorityError
            ? { outcome: "permanent", code: error.code }
            : { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
      }
    }
    if (
      resolved.outcome === "retry" &&
      claim.attemptCount >= this.maxAttempts &&
      (await this.continueExhaustedActiveRevision(claim, resolved.code))
    ) {
      return;
    }
    // OCC refused this candidate (its authority, credentials or configuration), so its runtime
    // must not keep serving. A runtime that failed by itself (a held startup failure, the
    // convergence deadline, exhausted retries) stays for diagnosis on its version's Logs tab.
    // ActivationFailedError also lands here, but no bundled Driver activates before commit, so
    // it only reaches a published (active) revision, which the stop skips.
    if (
      resolved.outcome === "permanent" &&
      heldFailureCode === undefined &&
      !expired &&
      resolved.cleanupFailedPreparation !== true &&
      resolved.refusedCandidateStopped !== true
    ) {
      await this.stopRefusedCandidate(claim, resolved.code);
    }
    const refusedStopRecheckMs =
      resolved.refusedCandidate === undefined
        ? undefined
        : await this.refusedStopRecheckMs(claim, resolved.refusedStopMs ?? 0);
    let activated: Readonly<AgentRevision> | undefined;
    let stoppedCandidate: Readonly<AgentRevision> | undefined;
    // Set when the pointer commit lost a race: the pass then commits a retry, not `resolved`.
    let activeRevisionChanged = false;
    let committedOutcome: WorkOutcome =
      resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : resolved.outcome;
    if (committedOutcome === "permanent") {
      failureLogFields = {
        ...failureLogFields,
        ...(await this.finishYieldedPredecessorStops(claim, "wait")),
      };
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      if (resolved.supersededBy !== undefined && resolved.outcome === "success") {
        const revision = await unit.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        if (revision?.repositoryCredentials !== undefined) {
          await queue.enqueueRepositoryCleanup(
            claim,
            {
              namespaceId: revision.namespaceId,
              agentId: revision.agentId,
              revisionId: revision.id,
            },
            "terminal-runtime",
          );
        }
        await this.appendRevisionSuperseded(unit, claim, resolved.supersededBy);
      } else if (resolved.revision !== undefined && resolved.outcome === "success") {
        const current = await this.lockClaimAgent(unit, claim);
        if (
          current === undefined ||
          current.servicePrincipalId !== resolved.revision.servicePrincipalId ||
          current.activeRevisionId !== resolved.expectedActiveRevisionId
        ) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          committedOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
          activeRevisionChanged = true;
          return;
        }
        if (current.desiredRuntimeState !== "running") {
          stoppedCandidate = resolved.revision;
          return;
        }
        const activeAgent = await unit.agents.compareAndSetActiveRevision(
          claim.namespaceId,
          current.id,
          resolved.expectedActiveRevisionId,
          resolved.revision.id,
        );
        if (activeAgent === undefined) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          committedOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
          activeRevisionChanged = true;
          return;
        }
        activated = resolved.revision;
        return;
      } else if (resolved.decision !== undefined) {
        await this.appendRevisionDenial(unit, claim, resolved);
      }

      if (resolved.outcome === "success") {
        await queue.complete(claim, {
          code: resolved.code,
          ...(resolved.resultData === undefined ? {} : { resultData: resolved.resultData }),
        });
      } else if (resolved.refusedCandidate !== undefined) {
        // Every deferral is recorded, so `lastAttempt.at` shows the stop is still retried; the
        // backoff bounds them to one per few minutes.
        await queue.defer(
          claim,
          {
            code: resolved.code,
            refusal: resolved.refusedCandidate,
            ...(resolved.refusedStopYielded === true ? { stopYielded: true } : {}),
          },
          { delayMs: refusedStopRecheckMs!, repeatEvidence: true },
        );
      } else if (resolved.outcome === "pending") {
        const ageMs = this.workAgeMs(claim);
        await queue.defer(
          claim,
          { code: resolved.code },
          // A transient dependency failure is rechecked on the readiness cadence:
          // like an unready runtime, it waits for convergence, not for a fix.
          isStopYieldedCode(resolved.code)
            ? { delayMs: this.stopYieldRecheckMs(claim) }
            : resolved.dependencyFailure !== undefined ||
                REVISION_READINESS_CODES.has(resolved.code)
              ? { delayMs: revisionReadinessRecheckMs(ageMs) }
              : {},
        );
      } else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts) {
        if (resolved.cleanupFailedPreparation === true) {
          // Register retirement while the source claim is still held. Both rows
          // commit together, so cleanup survives a crash after deployment failure.
          await queue.enqueueRepositoryCleanup(
            claim,
            {
              namespaceId: claim.namespaceId,
              agentId: claim.agentId!,
              revisionId: claim.revisionId!,
            },
            "failed-preparation",
          );
        }
        await queue.fail(claim, {
          code: resolved.code,
          ...(resolved.data === undefined ? {} : { data: resolved.data }),
        });
      } else {
        await queue.retry(claim, {
          code: resolved.code,
        });
      }
    }, this.queueOptions);
    if (stoppedCandidate !== undefined) {
      await this.closeRevisionCredentials(claim, stoppedCandidate);
      try {
        await this.stopYieldingDrain(claim, stoppedCandidate);
      } catch (error) {
        // Nothing was committed for this claim: the next pass repeats the stop as a stopped
        // Agent's revision.
        if (!(error instanceof ComputeStopYieldedError)) {
          throw error;
        }
        await this.finalizeRevision(claim, { outcome: "pending", code: "AGENT_STOP_YIELDED" });
        return;
      }
      await this.completeStoppedRevisionWork(claim, stoppedCandidate, "REVISION_STOPPED");
      return;
    }
    const compute = this.compute;
    this.passOutcome = committedOutcome;
    if (
      committedOutcome === "permanent" &&
      !activeRevisionChanged &&
      isCandidateDeployment(claim)
    ) {
      try {
        await this.scheduleFailedCandidateExposureWithdrawal(claim);
      } catch {
        // The failure is committed; the next start lists the candidate from its deployment.
      }
    }
    if (activated !== undefined) {
      try {
        const current = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (current?.desiredRuntimeState !== "running") {
          await this.closeRevisionCredentials(claim, activated);
          await this.stopYieldingDrain(claim, activated);
          await this.retireEarlierRevisions(claim, activated);
          await this.completeStoppedRevisionWork(claim, activated, "REVISION_STOPPED");
          return;
        }
        if (this.shouldActivateAfterCommit(compute)) {
          if (activated.repositoryCredentials !== undefined) {
            await this.assertRepositoryAuthority(claim, activated);
            this.repositoryCredentials.validate(activated);
          }
          await this.withClaimHeartbeat(claim, () =>
            this.stagedRevision("activateRevision", activated!, resolved.context),
          );
        }
        await this.retireEarlierRevisions(claim, activated);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        if (error instanceof RepositoryCredentialAuthorityError) {
          await this.finalizeRevision(claim, { outcome: "permanent", code: error.code });
          return;
        }
        if (error instanceof ComputeStopYieldedError) {
          // The Agent stopped after activation and its stop yielded: the next pass repeats it as
          // the stopped Agent's active revision, then retires the earlier ones.
          await this.finalizeRevision(claim, { outcome: "pending", code: "AGENT_STOP_YIELDED" });
          return;
        }
        await this.finalizeRevision(
          claim,
          error instanceof ActivationFailedError
            ? { outcome: "permanent", code: error.code }
            : activationPendingResult(error),
          revisionFailureLogFields(error),
        );
        return;
      }
      await this.completeActivatedRevision(claim, resolved);
      return;
    }
    let stopYields: number | undefined;
    if (resolved.outcome === "pending" && isStopYieldedCode(resolved.code)) {
      stopYields = this.recordStopYield(claim, resolved.code);
      if (stopYields === undefined) {
        return;
      }
    } else {
      stopYields = this.stopYields.count(claim.idempotencyKey);
    }
    // A lost pointer race reports the retry this pass committed, not the resolved success
    // (finding 1611).
    const reported = activeRevisionChanged
      ? { outcome: "retry" as const, code: "ACTIVE_REVISION_CHANGED" }
      : resolved;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: reported.outcome,
      outcome: reported.outcome,
      code: reported.code,
      ...failureLogFields,
      ...this.deployTimingFields(claim),
      ...stopYieldsField(stopYields),
    });
  }

  /**
   * A deployment whose predecessor stop yielded (PREDECESSOR_STOP_YIELDED) already removed the
   * serving revision's Gateway; only its drain and the Harness deletion were left to a later pass.
   * Before such work ends in failure (a refusal, exhausted attempts, the deadline), superseded or
   * stopped, it finishes that stop, so the predecessor ends stopped, as when the stop never
   * yielded, rather than keeping its Harness and workspace with nothing left to stop it (findings
   * 1090, 1109). A failure finishes it with the full bounded wait (`drain` "wait"); a superseded
   * or stopped pass may still yield.
   * Work that never yielded its predecessor stop leaves the serving revision alone. A stop that
   * still fails is logged as `predecessorStop` and the result is published anyway, unless
   * `failures` is "throw": a stopped Agent's revision pass retries it instead (finding 1109).
   */
  private async finishYieldedPredecessorStops(
    claim: ClaimedWork,
    drain: "yield" | "wait" = "wait",
    failures: "log" | "throw" = "log",
  ): Promise<Readonly<Record<string, string | number>>> {
    if (
      claim.agentId === undefined ||
      claim.revisionId === undefined ||
      claim.namespaceTarget !== undefined ||
      claim.agentTarget !== undefined ||
      (await this.queue.findWorkAttempt(claim.idempotencyKey, "PREDECESSOR_STOP_YIELDED")) ===
        undefined
    ) {
      return {};
    }
    // This rare recovery decodes every revision up front, outside the try below: an unreadable
    // one fails the pass rather than being logged as a predecessor stop failure.
    const revisions = await this.state.read((view) =>
      view.revisions.listRevisions(claim.namespaceId, claim.agentId!),
    );
    const revision = revisions.find((candidate) => candidate.id === claim.revisionId);
    if (revision === undefined || this.compute.requiresStoppedPredecessors?.(revision) !== true) {
      return {};
    }
    try {
      await this.stopPredecessors(
        claim,
        revisions.filter((candidate) => candidate.revision < revision.revision),
        drain,
        async (listed) => revisions.find((candidate) => candidate.id === listed.id),
      );
      return {};
    } catch (error) {
      if (
        failures === "throw" ||
        error instanceof WorkClaimLostError ||
        error instanceof ComputeStopYieldedError
      ) {
        throw error;
      }
      return { predecessorStop: revisionFailureLogFields(error).cause ?? "Error" };
    }
  }

  /**
   * Exclusive replacement stops every predecessor before a candidate's first pass, so a
   * candidate that a later pass refuses (for example after its actor lost `deploy`) would be
   * the only runtime left, serving a deployment OCC rejected while the recorded active revision
   * has no workload (finding 990). Without an active revision, any Compute's candidate is the
   * Agent's only runtime too: a refused first embedded deployment on Kubernetes kept its Gateway
   * Pod with its model key, secret environment and private state until a later deployment, stop
   * or delete (finding 1016). Stop it under the live claim before the failure is published, so
   * the Agent is unavailable until a new revision activates. A refused active revision is left
   * alone: its workload is the one recorded, and active maintenance owns it.
   */
  private async stopRefusedCandidate(claim: ClaimedWork, refusal: string): Promise<void> {
    const compute = this.compute;
    // Only the deployment's own work can leave a candidate serving: maintenance exists only for
    // revisions that activated, and their retirement already stopped them.
    if (
      claim.agentId === undefined ||
      claim.revisionId === undefined ||
      claim.namespaceTarget !== undefined ||
      claim.agentTarget !== undefined ||
      claim.idempotencyKey !== `agent_revision:${claim.revisionId}:reconcile`
    ) {
      return;
    }
    const { namespace, agent, revision } = await this.state.read(async (view) => ({
      namespace: await view.namespaces.findNamespace(claim.namespaceId),
      agent: await view.agents.findAgent(claim.namespaceId, claim.agentId!),
      revision: await view.revisions.findRevision(
        claim.namespaceId,
        claim.agentId!,
        claim.revisionId!,
      ),
    }));
    if (
      namespace === undefined ||
      agent === undefined ||
      revision === undefined ||
      namespace.status !== "ready" ||
      revision.namespaceId !== namespace.id ||
      revision.agentId !== agent.id ||
      revision.servicePrincipalId !== agent.servicePrincipalId ||
      revision.compute.id !== compute.id ||
      revision.compute.implementation !== compute.implementation ||
      agent.activeRevisionId === revision.id
    ) {
      return;
    }
    if (compute.requiresStoppedPredecessors?.(revision) !== true) {
      // Beside a non-exclusive active revision the candidate is left alone: that revision still
      // serves, and an embedded Kubernetes candidate may own the Agent's shared Gateway route,
      // which stopping the candidate would delete. Its next deployment, stop or delete retires it.
      if (agent.activeRevisionId !== undefined) {
        return;
      }
      // Only a candidate Compute prepared can have a runtime: this pass prepared it, or an
      // earlier pass that recorded evidence may have (stopping an unprepared one is idempotent).
      // A refusal decided before the work's first preparation leaves Compute untouched.
      if (
        this.preparedThisPass !== revision.id &&
        this.refusalWait?.idempotencyKey !== claim.idempotencyKey &&
        (await this.queue.findWorkAttempt(claim.idempotencyKey)) === undefined
      ) {
        return;
      }
    }
    const started = Date.now();
    try {
      if (compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await compute.bindAgent!({ namespace, agent });
        });
      }
      await this.closeRevisionCredentials(claim, revision);
      // Its Pod-termination waits end when other Work is waiting; the stop then waits like a
      // failed one, for as long as it ran, and the next pass repeats it (finding 1022).
      await this.withClaimHeartbeat(claim, () =>
        withYieldingComputeStop(() => compute.stopRevision(revision)),
      );
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        // A graceful shutdown aborts a slow stop (a Pod-termination wait) like a lost claim.
        // While the lease holds, the pass waits on the stop instead, so a restart during the
        // first stop, before any wait evidence, neither spends an attempt nor leaves the refusal
        // unrecorded (finding 1021). The interrupted stop's duration lengthens the recheck like a
        // failed stop's, so the next controller does not repeat a blocking stop within seconds
        // (finding 1022). A lease that already ran out still loses the claim when the deferral
        // commits.
        if (!this.stopping) {
          throw error;
        }
        // Its log names the shutdown, not a lost claim.
        const stopping = new Error("The controller stopped during the refused candidate's stop.", {
          cause: error,
        });
        stopping.name = "WorkerStopping";
        // Capped so a rollout during a long Gateway drain rechecks within the backoff's maximum.
        throw new RefusedCandidateStopError(
          refusal,
          Math.min(
            Date.now() - started,
            REFUSED_CANDIDATE_STOP_RECHECK_MAX_MS / REFUSED_CANDIDATE_STOP_DURATION_FACTOR,
          ),
          stopping,
        );
      }
      throw new RefusedCandidateStopError(refusal, Date.now() - started, error);
    }
    // Like a swept predecessor, the next deployment need not stop it again within a lease.
    this.stoppedPredecessors.delete(revision.id);
    this.stoppedPredecessors.set(revision.id, {
      stoppedAt: Date.now(),
      restopAfterMs: this.leaseDurationMs,
    });
    if (this.stoppedPredecessors.size > MAX_STOPPED_PREDECESSOR_RECORDS) {
      const oldest = this.stoppedPredecessors.keys().next().value;
      if (oldest !== undefined) {
        this.stoppedPredecessors.delete(oldest);
      }
    }
  }

  /**
   * Records the refusal this deployment pass waits to publish, if its work's latest evidence is a
   * stop wait. An active revision has none: its refused stop never runs.
   */
  private async readRefusalWait(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
    revisionId: string,
  ): Promise<void> {
    if (
      claim.idempotencyKey !== `agent_revision:${revisionId}:reconcile` ||
      agent.activeRevisionId === revisionId
    ) {
      return;
    }
    const latest = await this.queue.findWorkAttempt(claim.idempotencyKey);
    if (
      latest?.refusal !== undefined &&
      (latest.code === "REFUSED_CANDIDATE_STOP_PENDING" || latest.code === "LEASE_EXPIRED")
    ) {
      this.refusalWait = { idempotencyKey: claim.idempotencyKey, refusal: latest.refusal };
    }
  }

  /**
   * After an error in the pass's first reads (its resources or `readRefusalWait`), reads the
   * stored refusal again, so the pass retries the wait's stop like any later failure. Recorded as
   * an ordinary retry instead, the error spent an attempt and its evidence ended the wait: the
   * next pass prepared the candidate again, and at the attempt limit the work failed with the
   * candidate running and the refusal lost (finding 1041). If this read fails too, the error
   * leaves the claim to lease recovery, which keeps a stored wait and refunds its attempt. A
   * ScopeViolationError (an invalid row) cannot recover by itself, so it stays a retry that the
   * attempt limit ends instead of a wait repeated forever.
   */
  private async rereadRefusalWait(
    claim: ClaimedWork,
    agent: Readonly<Agent> | undefined,
    error: unknown,
  ): Promise<void> {
    const { agentId, revisionId } = claim;
    if (
      agentId === undefined ||
      revisionId === undefined ||
      claim.idempotencyKey !== `agent_revision:${revisionId}:reconcile`
    ) {
      return;
    }
    try {
      const current =
        agent ??
        (await this.state.read((view) => view.agents.findAgent(claim.namespaceId, agentId)));
      if (current !== undefined) {
        await this.readRefusalWait(claim, current, revisionId);
      }
    } catch (reread) {
      if (reread instanceof WorkClaimLostError) {
        throw reread;
      }
      if (reread instanceof ScopeViolationError || error instanceof ScopeViolationError) {
        return;
      }
      // The run loop's own log names no work.
      this.emit({
        event: "worker.error",
        code: "WORKER_UNAVAILABLE",
        ...workLogFields(claim),
        ...revisionFailureLogFields(error),
      });
      throw error;
    }
  }

  /** The permanent result that publishes a stored refusal once its candidate is stopped. */
  private storedRefusalResult(refusal: string): RevisionDispatchResult {
    return refusal === "CONVERGENCE_DEADLINE_EXCEEDED"
      ? {
          outcome: "permanent",
          code: refusal,
          data: convergenceDeadlineResultData(this.convergenceTimeoutMs, undefined),
        }
      : { outcome: "permanent", code: refusal };
  }

  /**
   * The recheck after this work's next unfinished refused-candidate stop: the readiness cadence,
   * doubled for each earlier consecutive failure up to REFUSED_CANDIDATE_STOP_RECHECK_MAX_MS, and
   * at least REFUSED_CANDIDATE_STOP_DURATION_FACTOR times as long as the stop took. The
   * earlier failures are counted from the work's evidence, so a restart keeps the backoff
   * (finding 1022); if that read fails, the backoff starts again. A stop that yielded to other
   * Work is not a failure, so a busy queue does not double it (finding 1025).
   */
  private async refusedStopRecheckMs(claim: ClaimedWork, stopMs: number): Promise<number> {
    const earlier = await this.queue.countRefusedStopWaits(claim.idempotencyKey).catch(() => 0);
    return Math.max(
      Math.min(
        REFUSED_CANDIDATE_STOP_RECHECK_MAX_MS,
        revisionReadinessRecheckMs(this.workAgeMs(claim)) * 2 ** Math.min(earlier, 20),
      ),
      Math.ceil(Math.max(0, stopMs) * REFUSED_CANDIDATE_STOP_DURATION_FACTOR),
    );
  }

  private async completeStoppedRevisionWork(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    code: string,
  ): Promise<void> {
    await this.closeRevisionCredentials(claim, revision);
    await this.state.transactWithQueue(async (_unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      await queue.complete(claim, { code });
    }, this.queueOptions);
    this.passOutcome = "success";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: revision.id,
      result: "success",
      outcome: "success",
      code,
      ...this.deployTimingFields(claim),
      ...stopYieldsField(this.stopYields.count(claim.idempotencyKey)),
    });
  }

  private async retireEarlierRevisions(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const earlier = await this.state.read(async (view) =>
      (await view.revisions.listRevisions(revision.namespaceId, revision.agentId)).filter(
        (candidate) => candidate.revision < revision.revision,
      ),
    );
    for (const previous of earlier) {
      await this.closeRevisionCredentials(claim, previous);
      await this.withClaimHeartbeat(claim, () => this.compute.retireRevision(previous));
    }
  }

  private async completeActivatedRevision(
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const revision = result.revision;
    if (revision === undefined) {
      throw new Error("The activated Agent revision is unavailable.");
    }
    let completed = false;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const agent = await this.lockClaimAgent(unit, claim);
      if (
        agent === undefined ||
        agent.id !== revision.agentId ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id
      ) {
        await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
        return;
      }
      const setup = await unit.workspaceSetups.find(revision.namespaceId, revision.agentId);
      if (setup !== undefined && !setup.completed) {
        await unit.workspaceSetups.complete(revision.namespaceId, revision.agentId, setup.id);
      }
      await this.appendRevisionObservation(unit, claim, result);
      await queue.complete(claim, {
        code: result.code,
        ...(result.resultData === undefined ? {} : { resultData: result.resultData }),
      });
      if (this.revisionMaintenanceInterval(revision) !== undefined) {
        await this.enqueueMaintenance(queue, claim, revision);
      }
      completed = true;
    }, this.queueOptions);
    this.passOutcome = result.outcome;
    if (!completed) {
      this.passOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
      // Like the pointer commit's lost race, this pass committed a retry (finding 1611).
      this.emit({
        event: "worker.completed",
        ...workLogFields(claim),
        namespaceId: claim.namespaceId,
        agentId: claim.agentId,
        revisionId: claim.revisionId,
        result: "retry",
        outcome: "retry",
        code: "ACTIVE_REVISION_CHANGED",
        ...this.deployTimingFields(claim),
        ...stopYieldsField(this.stopYields.count(claim.idempotencyKey)),
      });
      return;
    }
    // Original admission time survives queue waits and retries. Maintenance and
    // superseded work must not count as additional successful deployments.
    if (claim.idempotencyKey === `agent_revision:${revision.id}:reconcile`) {
      this.metrics?.observeAgentOperation("deploy", this.workAgeMs(claim) / 1000);
    }
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: result.outcome,
      outcome: result.outcome,
      code: result.code,
      ...this.deployTimingFields(claim),
      // A deployment whose predecessor stop yielded counts those yields here (finding 1090).
      ...stopYieldsField(this.stopYields.count(claim.idempotencyKey)),
    });
  }

  private async finalizeActiveRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    code: string,
    runtimeFailure?: RuntimeFailureEvidence,
    failure: {
      readonly dependencyFailure?: TransientDependencyError;
      readonly failureLogFields?: Readonly<Record<string, string | number>>;
    } = {},
  ): Promise<void> {
    if (
      this.revisionMaintenanceInterval(revision) === undefined ||
      !new RegExp(`^agent_revision:${revision.id}:maintenance:(0|[1-9][0-9]*)$`).test(
        claim.idempotencyKey,
      )
    ) {
      await this.finalizeRevision(
        claim,
        {
          outcome: "pending",
          code,
          ...(runtimeFailure === undefined ? {} : { data: { runtimeFailure } }),
          ...(failure.dependencyFailure === undefined
            ? {}
            : { dependencyFailure: failure.dependencyFailure }),
        },
        failure.failureLogFields,
      );
      return;
    }
    let superseded = false;
    if (revision.repositoryCredentials !== undefined) {
      try {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        if (error instanceof RepositoryCredentialAuthorityError) {
          await this.finalizeRevision(claim, { outcome: "permanent", code: error.code });
          return;
        }
        throw error;
      }
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const agent = await this.lockClaimAgent(unit, claim);
      if (
        agent === undefined ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id ||
        agent.desiredRuntimeState !== "running"
      ) {
        await queue.complete(claim);
        superseded = true;
        return;
      }
      if (revision.repositoryCredentials !== undefined) {
        this.repositoryCredentials.validate(revision);
      }
      // Keep each failed observation bounded without permanently abandoning
      // an authorized active runtime after one prolonged backend outage.
      await queue.fail(claim, { code }, { continuingRevision: true });
      await this.enqueueMaintenance(queue, claim, revision);
    }, this.queueOptions);
    this.passOutcome = superseded ? "success" : "permanent";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: "pending",
      outcome: "pending",
      code,
      ...failure.failureLogFields,
      ...stopYieldsField(this.stopYields.count(claim.idempotencyKey)),
    });
  }

  // A dependency outage that outlasts one maintenance claim's retries must not
  // retire the authorized active runtime. Fail only this bounded claim and keep
  // the maintenance chain, as finalizeActiveRevision does for failed
  // observations. The queue still refuses continuation past the credential
  // deadline, and the next pass re-checks authority before any new material.
  // The same holds for a deployment that already published the active pointer
  // (for example one recovered after its lease expired): its last retry fails
  // the deployment without retiring the runtime it activated.
  private async continueExhaustedActiveRevision(
    claim: ClaimedWork,
    code: string,
  ): Promise<boolean> {
    const revisionId = claim.revisionId;
    if (
      claim.agentId === undefined ||
      revisionId === undefined ||
      claim.namespaceTarget !== undefined
    ) {
      return false;
    }
    const maintenance = new RegExp(
      `^agent_revision:${revisionId}:maintenance:(0|[1-9][0-9]*)$`,
    ).test(claim.idempotencyKey);
    if (!maintenance && claim.idempotencyKey !== `agent_revision:${revisionId}:reconcile`) {
      return false;
    }
    let continued = false;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const agent = await this.lockClaimAgent(unit, claim);
      if (agent?.activeRevisionId !== revisionId || agent.desiredRuntimeState !== "running") {
        return;
      }
      const namespace = await unit.namespaces.findNamespace(claim.namespaceId);
      const revision = await unit.revisions.findRevision(
        claim.namespaceId,
        claim.agentId!,
        revisionId,
      );
      if (
        namespace?.status !== "ready" ||
        revision === undefined ||
        revision.servicePrincipalId !== agent.servicePrincipalId ||
        (maintenance && this.revisionMaintenanceInterval(revision) === undefined) ||
        (revision.repositoryCredentials !== undefined &&
          Date.now() >= revision.repositoryCredentials.deadlineWallMs)
      ) {
        return;
      }
      await queue.fail(claim, { code }, { continuingRevision: true });
      if (maintenance) {
        await this.enqueueMaintenance(queue, claim, revision);
      }
      continued = true;
    }, this.queueOptions);
    if (!continued) {
      return false;
    }
    this.passOutcome = "permanent";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId,
      result: "retry",
      outcome: "retry",
      code,
      ...this.deployTimingFields(claim),
    });
    return true;
  }

  // Lock the claim's Agent in admission order: Namespace, then Agent. These
  // transactions can later take Namespace locks (a Controller work insert's
  // foreign key, or the queue's cleanup transfer), so locking the Agent first
  // deadlocks with a concurrent Namespace-scoped mutation that then locks the
  // Agent, such as deploy, stop, delete or credential withdrawal.
  private async lockClaimAgent(
    unit: PlatformUnitOfWork,
    claim: Pick<ControllerWork, "namespaceId" | "agentId">,
  ): Promise<Readonly<Agent> | undefined> {
    await unit.namespaces.lockNamespace(claim.namespaceId, { includeDeleted: true });
    return unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
  }

  // lockClaimAgent for work that may carry no Agent (a malformed withdrawal target).
  private async lockClaimScope(
    unit: PlatformUnitOfWork,
    claim: Pick<ControllerWork, "namespaceId" | "agentId">,
  ): Promise<void> {
    if (claim.agentId === undefined) {
      await unit.namespaces.lockNamespace(claim.namespaceId, { includeDeleted: true });
    } else {
      await this.lockClaimAgent(unit, claim);
    }
  }

  private async enqueueMaintenance(
    queue: Pick<PostgresWorkQueue, keyof PostgresWorkQueue>,
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const interval = this.revisionMaintenanceInterval(revision)!;
    const candidateAvailableAt = new Date(Date.now() + interval);
    let maintenanceBucket = Math.floor(candidateAvailableAt.getTime() / interval);
    const maintenancePrefix = `agent_revision:${revision.id}:maintenance:`;
    const currentBucket = claim.idempotencyKey.startsWith(maintenancePrefix)
      ? Number(claim.idempotencyKey.slice(maintenancePrefix.length))
      : undefined;
    // Clock skew must not deduplicate the successor against its completed claim.
    const availableAt =
      currentBucket !== undefined &&
      Number.isSafeInteger(currentBucket) &&
      currentBucket >= 0 &&
      maintenanceBucket <= currentBucket
        ? new Date((currentBucket + 1) * interval)
        : candidateAvailableAt;
    maintenanceBucket = Math.floor(availableAt.getTime() / interval);
    await queue.enqueue({
      idempotencyKey: `agent_revision:${revision.id}:maintenance:${maintenanceBucket}`,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      actorId: claim.actorId,
      availableAt,
    });
  }

  private async appendRevisionObservation(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    const revision = result.revision;
    if (installation === undefined || revision === undefined) {
      throw new Error("The worker revision activation is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: revision.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.activate",
      resource: { kind: "agent_revision", id: revision.id, namespaceId: revision.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: "success",
      details: {
        computeDriverId: this.compute.id,
        ...(result.previous === undefined ? {} : { previousRevisionId: result.previous.id }),
      },
    });
  }

  private async appendRevisionSuperseded(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    active: Readonly<AgentRevision>,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined || claim.revisionId === undefined) {
      throw new Error("The worker superseded revision is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.supersede",
      resource: {
        kind: "agent_revision",
        id: claim.revisionId,
        namespaceId: claim.namespaceId,
      },
      iamDriverId: this.iamDriverId,
      outcome: "success",
      details: {
        activeRevisionId: active.id,
        reasonCode: "REVISION_SUPERSEDED",
      },
    });
  }

  private async appendRevisionDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker revision authorization is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.deploy",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  private async finalize(
    claim: ClaimedWork,
    namespace: Readonly<Namespace> | undefined,
    result: DispatchResult,
  ): Promise<void> {
    const expired =
      result.outcome === "pending" && this.workAgeMs(claim) >= this.convergenceTimeoutMs;
    const resolved: DispatchResult = expired
      ? { ...result, outcome: "permanent", code: "CONVERGENCE_DEADLINE_EXCEEDED" }
      : result;
    const pendingAudit =
      resolved.outcome === "pending" && resolved.observation !== undefined
        ? JSON.stringify([claim.namespaceTarget, resolved.code, resolved.observation])
        : undefined;
    let auditedPending = false;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const current =
        namespace === undefined
          ? undefined
          : await unit.namespaces.lockNamespace(namespace.id, { includeDeleted: true });
      if (
        current !== undefined &&
        current.deletedAt === undefined &&
        ((claim.namespaceTarget === "ready" && current.status === "provisioning") ||
          (claim.namespaceTarget === "deleted" && current.status === "deleting"))
      ) {
        const exhausted = resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts;
        if (claim.namespaceTarget === "ready" && resolved.outcome === "success") {
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "ready");
        } else if (
          claim.namespaceTarget === "ready" &&
          (resolved.outcome === "permanent" || exhausted)
        ) {
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "failed");
        }
        let removedPolicy;
        if (claim.namespaceTarget === "deleted" && resolved.outcome === "success") {
          await unit.namespaces.markNamespaceDeleted(current.id, new Date().toISOString());
          // No grant outlives its Namespace; the lifecycle event records what was removed.
          removedPolicy = await removeNamespacePolicy(unit, current.id);
        }

        if (resolved.decision !== undefined) {
          await this.appendDenial(unit, claim, current, resolved);
        } else if (
          resolved.observation !== undefined &&
          (pendingAudit === undefined ||
            this.auditedPendingLifecycle.get(claim.idempotencyKey) !== pendingAudit)
        ) {
          await this.appendObservation(unit, claim, current, resolved, removedPolicy);
          auditedPending = pendingAudit !== undefined;
        }
      }

      if (resolved.outcome === "success") {
        await queue.complete(claim);
      } else if (resolved.outcome === "pending") {
        // The queue's reconcile evidence for this wait follows the lifecycle audit above.
        await queue.defer(
          claim,
          { code: resolved.code },
          pendingAudit !== undefined &&
            this.auditedPendingLifecycle.get(claim.idempotencyKey) === pendingAudit
            ? { recordEvidence: false }
            : {},
        );
      } else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts) {
        await queue.fail(claim, { code: resolved.code });
      } else {
        await queue.retry(claim, { code: resolved.code });
      }
    }, this.queueOptions);
    // Recorded after commit: a rolled-back audit row is written again next pass.
    if (pendingAudit === undefined) {
      this.auditedPendingLifecycle.delete(claim.idempotencyKey);
    } else if (auditedPending) {
      this.auditedPendingLifecycle.delete(claim.idempotencyKey);
      if (this.auditedPendingLifecycle.size >= MAX_AUDITED_PENDING_LIFECYCLE_RECORDS) {
        // Drop the oldest; at worst that work's next identical pass is audited again.
        this.auditedPendingLifecycle.delete(this.auditedPendingLifecycle.keys().next().value!);
      }
      this.auditedPendingLifecycle.set(claim.idempotencyKey, pendingAudit);
    }
    this.passOutcome =
      resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : resolved.outcome;
    // The Compute Driver's bounded reason for a failed Namespace pass; the lifecycle audit
    // and Namespace status keep only the failure class.
    const reason =
      claim.namespaceTarget !== "ready" || resolved.observation?.failure === undefined
        ? undefined
        : namespaceFailureReason(resolved.observation);
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      result: resolved.outcome,
      outcome: resolved.outcome,
      code: resolved.code,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async appendObservation(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
    removedPolicy?: Parameters<typeof removedPolicyDetails>[0],
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const observation = result.observation;
    if (observation === undefined) {
      return;
    }
    const details = {
      computeDriverId: this.compute.id,
      ...("namespaceReady" in observation
        ? { namespaceReady: observation.namespaceReady }
        : { namespaceDeleted: observation.namespaceDeleted }),
      ...(observation.failure === undefined ? {} : { failure: observation.failure }),
      ...(result.outcome === "pending" ? { convergencePending: true } : {}),
      ...removedPolicyDetails(removedPolicy),
    };
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.iamDriverId,
      outcome: result.outcome === "success" || result.outcome === "pending" ? "success" : "failure",
      details,
    };
    await unit.audit.append(event);
  }

  private async appendDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.delete"
          : "openclaw.namespaces.create",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    };
    await unit.audit.append(event);
  }
}

export function createControllerWorker(options: ControllerWorkerOptions): ControllerWorker {
  return new ControllerWorker(options);
}
