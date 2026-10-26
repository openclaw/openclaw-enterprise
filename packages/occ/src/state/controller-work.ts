import { immutableCopy, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { isComputePreparationFailureEvidence } from "@openclaw-enterprise/contracts";
import type { RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";

import { SandboxRepositoryRecipientUnverifiedError, ScopeViolationError } from "../errors.ts";
import { recognizedRuntimeFailureValues, runtimeFailureCause } from "../runtime-failure-cause.ts";

export { runtimeFailureCause };

export type { RuntimeFailureCause, RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";

export type ControllerWorkState = "queued" | "claimed" | "succeeded" | "failed_permanent";

export type ControllerWorkKind = "lifecycle" | "provisioning";

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

const FAILURE_CODE = /^[A-Z0-9_]{1,64}$/u;

/** Public pending explanations never include arbitrary Driver or provider text. */
export function deploymentProgressForWork(
  work: Readonly<ControllerWork>,
  attempt: ControllerWorkAttempt | undefined,
): DeploymentStatusResult["progress"] {
  if (work.state === "succeeded" || work.state === "failed_permanent") {
    return null;
  }
  let code = "RECONCILIATION_PENDING";
  let message = "Deployment has not completed. Another reconciliation is pending.";
  switch (attempt?.code) {
    case "REVISION_INCOMPLETE":
      code = attempt.code;
      message = "Waiting for the runtime to become ready.";
      break;
    case "REVISION_UNSCHEDULABLE":
      code = attempt.code;
      message =
        "The cluster has no room for this Agent's Pods yet; they are waiting to be scheduled.";
      break;
    case "REVISION_IMAGE_PULL_FAILED":
      // Fixed copy: never the image reference or the registry's response.
      code = attempt.code;
      message =
        "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.";
      break;
    case "NAMESPACE_POD_QUOTA_EXCEEDED":
      // Fixed copy: never the quota's numbers or name (finding 1617).
      code = attempt.code;
      message =
        "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.";
      break;
    case "WORKSPACE_NODE_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the workspace node to connect to the Gateway.";
      break;
    case "WORKSPACE_SETUP_RETRYING":
      code = attempt.code;
      message =
        "Workspace setup failed; Kubernetes is retrying it. If it keeps failing, ask an admin to check the Agent's workspace storage and runtime image.";
      break;
    case "WORKSPACE_NODE_BINDING_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the Gateway to apply the workspace node.";
      break;
    case "REPOSITORY_GIT_MATERIAL_PENDING":
      // Fixed copy, like REPOSITORY_GIT_ROUTE_PENDING (finding 1045).
      code = attempt.code;
      message =
        "Workloads are ready; waiting for the Sandbox to install this version's repository Git credential. If this persists, check the worker log for repository credential (PREPARED_GITHUB_RECOVERY_REQUIRED) or OpenShell gateway errors.";
      break;
    case "WORKSPACE_NODE_RECONNECT_PENDING":
      code = attempt.code;
      message =
        "Workloads are ready; waiting for the workspace node to reconnect after the repository Git credential was installed.";
      break;
    case "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING":
      code = attempt.code;
      message = "Waiting for harness credential initialization to finish.";
      break;
    case "REPOSITORY_GIT_ROUTE_PENDING":
      // Fixed copy: never the repository, grant or the gateway's answer (finding 1045).
      code = attempt.code;
      message =
        "Workloads are ready; waiting for the controller to verify this version's repository Git access. If this persists, check the worker log for repository credential or OpenShell gateway errors.";
      break;
    case "DEPENDENCY_UNAVAILABLE":
      code = attempt.code;
      message = "A dependency was unavailable. The controller will retry.";
      break;
    case "EXECUTION_ADMISSION_WITHDRAWAL_PENDING":
      code = attempt.code;
      message =
        "This version can no longer run with its admitted access. The controller will keep checking that access is closed and the workload has stopped.";
      break;
    case "REFUSED_CANDIDATE_STOP_PENDING":
      // The refusal is the code this deployment's `error` carries once the stop succeeds,
      // unless a newer revision supersedes it first.
      code = attempt.code;
      // A refusal that lifted after the convergence deadline waits to publish the deadline.
      message =
        attempt.refusal === "CONVERGENCE_DEADLINE_EXCEEDED"
          ? "Deployment missed its convergence deadline; stopping the candidate before recording the failure. The controller will retry."
          : `Deployment refused${
              attempt.refusal !== undefined && FAILURE_CODE.test(attempt.refusal)
                ? ` (${attempt.refusal})`
                : ""
            }; stopping the refused version before recording the failure. The controller will retry.`;
      break;
    case "PREDECESSOR_STOP_YIELDED":
      // Exclusive replacement: the serving version's gateway drains before this one starts.
      code = attempt.code;
      message =
        "Waiting for the previous version's gateway to finish its active work before this version starts.";
      break;
    case "AGENT_STOP_YIELDED":
      // The Agent stopped during this deployment: its stop waits for a gateway drain, and the
      // deployment then ends stopped (finding 1106).
      code = attempt.code;
      message =
        "The Agent was stopped; its gateway is finishing active work before the stop completes.";
      break;
    case "AGENT_GATEWAY_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.";
      break;
    case "KUBERNETES_API_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Kubernetes API was unavailable. The controller will retry until the deployment deadline.";
      break;
    case "SANDBOX_ADMISSION_LIMIT_REACHED":
      code = attempt.code;
      message =
        "The Sandbox gateway refuses new requests from the controller until its request admissions free up. The controller will retry until the deployment deadline.";
      break;
    case "SANDBOX_GATEWAY_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Sandbox gateway did not answer the controller yet. The controller will retry until the deployment deadline.";
      break;
    case "ACTIVE_REVISION_CHANGED":
      code = attempt.code;
      message = "The selected version changed. The controller will reconcile again.";
      break;
    case "LEASE_EXPIRED":
      code = attempt.code;
      // A claim lost while stopping a refused candidate keeps that refusal (finding 1021).
      message =
        attempt.refusal !== undefined && FAILURE_CODE.test(attempt.refusal)
          ? `Deployment refused (${attempt.refusal}); the previous worker claim expired before the refused version was stopped. The controller will retry.`
          : "The previous worker claim expired. Reconciliation will resume.";
      break;
    case "ACTIVE_REVISION_RECOVERY":
      code = attempt.code;
      message =
        "The previous worker claim expired after this version was published. The controller will finish activating it.";
      break;
    case "PREDECESSOR_STOP_RECOVERY":
      // Its predecessor stop had started; failing without a pass would leave it half stopped
      // (finding 1107).
      code = attempt.code;
      message =
        "The last attempt ended while the previous version was stopping. The controller will try once more.";
      break;
  }
  return Object.freeze({
    lastAttempt:
      attempt === undefined
        ? null
        : Object.freeze({
            at: attempt.at.toISOString(),
            code,
            message,
          }),
    nextAttemptAt: work.state === "queued" ? work.availableAt.toISOString() : null,
  });
}

export interface PluginDeploymentWarning {
  readonly code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED";
  readonly pluginId: string;
}

/**
 * Revision-scoped work that revokes credential sources from a running revision. It names the
 * revision but is not a deployment: it never prepares, activates, or supersedes it, and it owns
 * no repository-credential cleanup. The value is persisted in `controller_work.agent_target`.
 */
export const CREDENTIAL_WITHDRAWAL_TARGET = "credentials_withdrawn";

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

export interface WorkClaim {
  readonly idempotencyKey: string;
  readonly claimToken: string;
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

const RUNTIME_FAILURE_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

export function safeFailureCode(value: string): string {
  const normalized = nonempty(value, "Controller work failure code")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 64);
  return normalized.length === 0 ? "UNKNOWN_FAILURE" : normalized;
}

export function nonempty(value: string, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new ScopeViolationError(`${name} must be a nonempty string.`);
  }
  return value;
}

function validateRuntimeFailureIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !RUNTIME_FAILURE_IDENTIFIER.test(value)) {
    throw new ScopeViolationError(`${name} must be a safe identifier.`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

export function validateRuntimeFailureEvidence(value: unknown): RuntimeFailureEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError("Runtime failure evidence must be an object.");
  }
  const evidence = value as Partial<RuntimeFailureEvidence>;
  const keys = Object.keys(evidence);
  const hasCause = keys.includes("cause");
  if (
    keys.length !== (hasCause ? 5 : 4) ||
    !keys.includes("component") ||
    !keys.includes("check") ||
    !keys.includes("checkedAt") ||
    !keys.includes("code")
  ) {
    throw new ScopeViolationError("Runtime failure evidence has unsupported fields.");
  }
  const checkedAt = evidence.checkedAt;
  if (typeof checkedAt !== "string" || !validIsoTimestamp(checkedAt)) {
    throw new ScopeViolationError("Runtime failure evidence requires an ISO timestamp.");
  }
  const code = validateRuntimeFailureIdentifier(evidence.code, "Runtime failure code");
  const cause = hasCause ? runtimeFailureCause(evidence.cause) : undefined;
  if (hasCause && (cause === undefined || code !== "MODEL_PROBE_FAILED")) {
    throw new ScopeViolationError("Runtime failure cause is invalid.");
  }
  return Object.freeze({
    component: validateRuntimeFailureIdentifier(evidence.component, "Runtime failure component"),
    check: validateRuntimeFailureIdentifier(evidence.check, "Runtime failure check"),
    checkedAt,
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Validates failure data before it is recorded, and again when it is read back. A runtime
 * failure value outside the vocabulary in packages/contracts/src/runtime-failure.mjs is recorded,
 * and read back, as UNRECOGNIZED rather than as served (findings 1660, 1674).
 */
export function validateFailureData(
  reasonCode: string,
  data: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (data === undefined) {
    return undefined;
  }
  if (
    reasonCode === "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED" ||
    reasonCode === "HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT"
  ) {
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !Object.hasOwn(data, "preparation") ||
      !isComputePreparationFailureEvidence((data as Record<string, unknown>).preparation)
    ) {
      throw new ScopeViolationError("Compute preparation failure data has unsupported fields.");
    }
    return immutableCopy(data as Record<string, unknown>);
  }
  if (reasonCode === "CONVERGENCE_DEADLINE_EXCEEDED") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ScopeViolationError("Convergence deadline failure data must be an object.");
    }
    const keys = Object.keys(data);
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      !keys.includes("timeoutMs") ||
      keys.some((key) => key !== "timeoutMs" && key !== "runtimeFailure")
    ) {
      throw new ScopeViolationError("Convergence deadline failure data has unsupported fields.");
    }
    const timeoutMs = (data as { readonly timeoutMs?: unknown }).timeoutMs;
    if (typeof timeoutMs !== "number" || !isPositiveSafeInteger(timeoutMs)) {
      throw new ScopeViolationError(
        "Convergence deadline failure data requires a positive timeout.",
      );
    }
    const runtimeFailure = (data as { readonly runtimeFailure?: unknown }).runtimeFailure;
    const evidence =
      runtimeFailure === undefined ? undefined : validateRuntimeFailureEvidence(runtimeFailure);
    if (evidence?.cause !== undefined) {
      throw new ScopeViolationError("Convergence deadline failure data cannot carry a cause.");
    }
    return Object.freeze({
      timeoutMs,
      ...(evidence === undefined
        ? {}
        : { runtimeFailure: recognizedRuntimeFailureValues(evidence) }),
    });
  }
  if (reasonCode === "RUNTIME_MODEL_PROBE_FAILED") {
    // The held model-probe failure that ended the deployment, with its cause.
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !Object.hasOwn(data, "runtimeFailure")
    ) {
      throw new ScopeViolationError("Model probe failure data has unsupported fields.");
    }
    const evidence = validateRuntimeFailureEvidence(
      (data as { readonly runtimeFailure: unknown }).runtimeFailure,
    );
    if (evidence.code !== "MODEL_PROBE_FAILED") {
      throw new ScopeViolationError("Model probe failure data requires its runtime failure.");
    }
    return Object.freeze({ runtimeFailure: recognizedRuntimeFailureValues(evidence) });
  }
  throw new ScopeViolationError("Controller work failure data is not allowed for this code.");
}

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._~:@-]{1,253}$/u;

function validatePluginWarning(value: unknown): PluginDeploymentWarning {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScopeViolationError("Plugin deployment warning must be an object.");
  }
  const warning = value as Partial<PluginDeploymentWarning>;
  const keys = Object.keys(warning);
  if (
    keys.length !== 2 ||
    !keys.includes("code") ||
    !keys.includes("pluginId") ||
    (warning.code !== "PLUGIN_INSTALL_FAILED" && warning.code !== "PLUGIN_AUTH_REQUIRED") ||
    !isNonEmptyString(warning.pluginId) ||
    !PLUGIN_ID_PATTERN.test(warning.pluginId)
  ) {
    throw new ScopeViolationError("Plugin deployment warning is invalid.");
  }
  return Object.freeze({ code: warning.code, pluginId: warning.pluginId });
}

export function validatePluginWarnings(
  warnings: unknown,
): readonly PluginDeploymentWarning[] | undefined {
  if (warnings === undefined) {
    return undefined;
  }
  if (!Array.isArray(warnings)) {
    throw new ScopeViolationError("Plugin deployment warnings must be an array.");
  }
  const seen = new Set<string>();
  const normalized = warnings.map((value) => {
    const warning = validatePluginWarning(value);
    if (seen.has(warning.pluginId)) {
      throw new ScopeViolationError("Plugin deployment warnings contain duplicates.");
    }
    seen.add(warning.pluginId);
    return warning;
  });
  return Object.freeze(normalized);
}

interface SuccessResultData {
  readonly warnings: readonly PluginDeploymentWarning[];
}

export function validateSuccessResultData(data: unknown): SuccessResultData | undefined {
  if (data === undefined) {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ScopeViolationError("Successful controller work result data must be an object.");
  }
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "warnings") {
    throw new ScopeViolationError("Successful controller work result data has unsupported fields.");
  }
  const warnings = validatePluginWarnings((data as { readonly warnings?: unknown }).warnings);
  if (warnings === undefined) {
    throw new ScopeViolationError("Successful controller work result data requires warnings.");
  }
  return Object.freeze({ warnings });
}

export function deploymentErrorForWork(
  work: Readonly<ControllerWork>,
): DeploymentStatusError | null {
  if (work.state !== "failed_permanent" && !completedWithoutActivation(work)) {
    return null;
  }
  const code = work.reasonCode ?? "UNKNOWN_FAILURE";
  const data =
    work.resultData === undefined
      ? undefined
      : validateFailureData(code, immutableCopy(work.resultData));
  return Object.freeze({
    code,
    message: deploymentErrorMessage(code),
    ...(data === undefined ? {} : { data }),
  });
}

/**
 * The fixed codes that name the guidance for a refusal whose next step does not depend on the
 * operation. A stop, deletion or credential withdrawal the Sandbox gateway refused has no status
 * of its own, so the worker logs the code with the failed work (finding 1694); the deployment
 * status shows the same guidance as text, and the Sandbox Driver reference spells it out. The
 * log carries the code, not the sentence, because the log sanitizer keeps no free text.
 */
export const OPERATION_REFUSAL_HINT_CODES = Object.freeze({
  SANDBOX_GATEWAY_UNAUTHORIZED: "sandbox-gateway-identity",
} as const);

export type OperationRefusalHintCode =
  (typeof OPERATION_REFUSAL_HINT_CODES)[keyof typeof OPERATION_REFUSAL_HINT_CODES];

/** The guidance code a refusal with this result code logs, if any. */
export function operationRefusalHintCode(code: string): OperationRefusalHintCode | undefined {
  return Object.hasOwn(OPERATION_REFUSAL_HINT_CODES, code)
    ? OPERATION_REFUSAL_HINT_CODES[code as keyof typeof OPERATION_REFUSAL_HINT_CODES]
    : undefined;
}

export function deploymentWarningsForWork(
  work: Readonly<ControllerWork>,
): readonly PluginDeploymentWarning[] {
  if (work.state !== "succeeded" || work.resultData === undefined) {
    return Object.freeze([]);
  }
  return validateSuccessResultData(immutableCopy(work.resultData))?.warnings ?? Object.freeze([]);
}

export function controllerWorkDeploymentStatus(
  work: Readonly<ControllerWork>,
  now: Date = new Date(),
): DeploymentStatus {
  if (work.state === "succeeded") {
    return completedWithoutActivation(work) ? "failed" : "succeeded";
  }
  if (work.state === "failed_permanent") {
    return "failed";
  }
  if (controllerWorkLeaseActive(work, now)) {
    return "running";
  }
  return "queued";
}

/**
 * The status a deployment's record reports for its work, and for its revision cleanup. Once a
 * worker has claimed the work, it stays `running` until it records a result: a deferral between
 * attempts, a retry or an expired claim queues the work again, but reporting `queued` then read
 * as the deploy or cleanup stepping back (findings 2456, 2466). `attempt` is the latest evidence
 * bound to this work; a deferral that refunds its attempt still records evidence, so claimed
 * work always has one or the other. Callers can skip reading it when `attemptCount` is non-zero.
 */
export function deploymentStatusForWork(
  work: Readonly<ControllerWork>,
  attempt: ControllerWorkAttempt | undefined,
  now: Date = new Date(),
): DeploymentStatus {
  const status = controllerWorkDeploymentStatus(work, now);
  if (
    status === "queued" &&
    (work.state === "claimed" || work.attemptCount > 0 || attempt !== undefined)
  ) {
    return "running";
  }
  return status;
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

function completedWithoutActivation(work: Readonly<ControllerWork>): boolean {
  return (
    work.state === "succeeded" &&
    work.reasonCode !== "REVISION_ACTIVATED" &&
    work.reasonCode !== "REVISION_ALREADY_ACTIVE"
  );
}

// Each message names the cause and the next step. Every client (console, occ, HTTP API) shows
// this text as is, so the guidance lives here only; the console adds just a link to the page
// that holds the setting (finding 1393). `deployment-failure-steps.ts` records which kind of
// step each code leads to, so clients choose their actions without parsing this text: keep the
// two in step.
function deploymentErrorMessage(code: string): string {
  switch (code) {
    case "CONVERGENCE_DEADLINE_EXCEEDED":
      return "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.";
    case "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED":
      return "Harness credential initialization failed. Correct the cause and deploy again.";
    case "HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT":
      return "Harness credential initialization exceeded its deadline. Correct the cause and deploy again.";
    case "RUNTIME_AUTHENTICATION_FAILED":
      return "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.";
    case "RUNTIME_CPU_STARVED":
      return "Deployment runtime did not get enough CPU to finish its startup model check, because of a CPU limit below one core or a busy node. Ask an admin to raise the limit or free node capacity, then deploy a new version.";
    // Model-probe codes come from the runtime wrapper's startup model check
    // (`runtime-entrypoints.ts`). OpenClaw classifies transport errors (refused connection,
    // DNS failure, "fetch failed") as a timeout; Codex reports them as
    // RUNTIME_MODEL_PROBE_FAILED unless the connection hangs until its cap.
    case "RUNTIME_MODEL_PROBE_TIMEOUT":
      return "The startup model check did not get a reply from the model provider in time. With OpenClaw this includes a provider the runtime cannot reach (refused connection or unknown host). Check that the runtime can reach the provider (network egress, proxy, or a custom baseUrl in the Configuration) and that the provider is responding, then deploy a new version.";
    case "RUNTIME_MODEL_PROBE_FAILED":
      return "The startup model check failed for a reason other than a rejected credential, such as an unknown model, invalid provider settings, a provider or TLS error, a rate limit or quota, or, with Codex, a provider the runtime cannot reach. Check the model and its provider settings (such as baseUrl and api) in the Configuration, the provider account, and that the runtime can reach the provider, then deploy a new version.";
    case "RUNTIME_LOGIN_FAILED":
      return "Deployment runtime could not sign in to the model provider. Check the Agent's model credential (for an OAuth login, sign in again) and that the runtime can reach the provider, then deploy a new version.";
    case "RUNTIME_STARTUP_FAILED":
      return "Deployment runtime failed a startup check. Check this version's logs for the failed check and correct its cause, then deploy a new version.";
    case "EXECUTION_ADMISSION_WITHDRAWN":
      return "This version can no longer run with its admitted access. The controller closed that access and observed the workload stopped. Deploy a new version to use the current installation.";
    case "REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    case "REVISION_STOPPED":
      return "Deployment ended because the Agent was stopped.";
    case "REPOSITORY_REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    case "REPOSITORY_REVISION_STOPPED":
      return "Deployment ended because the Agent was stopped or its Namespace is no longer ready. To run the Agent, deploy again once its Namespace is ready.";
    // Repository credential refusals (finding 1045). Like the refusals below, the status never
    // names a repository, grant or Driver.
    case "REPOSITORY_RUNTIME_UNSUPPORTED":
      return "The Installation's Compute Driver can no longer deliver repository credentials to this revision. Repository access needs an embedded OpenClaw or dedicated Codex runtime with no Sandbox Driver, on a Compute Driver configured for repository credentials. Ask an admin to restore that setup, or remove the Agent's repository access, then deploy again.";
    case "REPOSITORY_BINDING_UNAVAILABLE":
      return "A repository this revision binds, or its access level, is no longer approved for the Agent's Namespace. Choose approved repository access on the Agent, or ask an admin to approve it again, then deploy again.";
    case "REPOSITORY_BINDING_CHANGED":
      return "The approval behind a repository this revision binds changed since admission, for example the access levels or push rules approved for the Agent's Namespace. Deploy again to admit a revision with the current approval.";
    case "REPOSITORY_DRIVER_MISMATCH":
      return "The Installation no longer selects the repository credential Driver this revision was admitted with. Deploy again to admit a revision for the selected Driver, choosing approved repository access first if the deploy is refused. If the Installation has none, remove the Agent's repository access or ask an admin to select one.";
    case "REPOSITORY_GIT_ROUTE_BLOCKED":
      return "This version's repository Git access was closed by the controller: its Sandbox or supervisor was replaced, a credential write's outcome is unknown, or the access was withdrawn. The worker log names the reason (OPENSHELL_GIT_RECONCILIATION_REQUIRED). Deploy a new version.";
    case "REPOSITORY_GIT_SENDER_UNQUALIFIED":
      return "This version was admitted with repository Git delivery that the selected Credential Proxy cannot enforce: no OpenShell release is qualified for the git-write profile, so it could never start. Remove the Agent's repository binding, select a qualified installed sender, or use native prepared Git without a Sandbox, then deploy again.";
    case "REPOSITORY_GIT_PROFILE_UNSUPPORTED":
      return "This version was admitted with repository Git delivery that has no delivery profile: a Credential Proxy delivers only one binding with the git-write or github-installation profile, so it could never start. Keep one binding with a supported profile, remove the Agent's repository bindings, or use native prepared Git without a Sandbox or Credential Proxy, then deploy again.";
    case "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED":
      return "This revision's repository access deadline, fixed when the revision was admitted, has passed. Deploy again to admit a revision with a new deadline.";
    // Refusals the worker decides again on every pass (finding 1039). The status never names
    // the principal or the resource the decision was about.
    case "AUTHORIZATION_DENIED":
      return "The account that requested this deployment, or the Agent's own identity, no longer has a permission the revision needs: deploy on the Agent, read on its Configuration, or use of a Secret, credential source or ServiceAccount it binds. Ask an admin to grant the access, then deploy again.";
    case "ACTOR_REVOKED":
      return "The account that requested this deployment is no longer an active account in the Installation. Deploy again from an account with deploy access to the Agent.";
    case "HARNESS_AUTH_REQUIRED":
      return "This revision has no Harness authentication method. Set one on the Agent, then deploy again.";
    case "BACKEND_UNAVAILABLE":
      return "The Backend this revision was admitted with is no longer configured on the Installation. Ask an admin to restore it, or move the Agent to a configured Backend, then deploy again.";
    case "HARNESS_AUTH_SOURCE_CHANGED":
      return "The ServiceAccount this revision authenticates with is missing, has no access token, or its credential changed since admission. Bind an available ServiceAccount, or deploy again to admit a revision with its current credential.";
    case "SECRET_BINDING_UNAVAILABLE":
      return "A Secret this revision binds is missing or no longer belongs to the selected Secret Driver. Bind available Secrets, then deploy again.";
    case "NAMESPACE_NOT_READY":
      return "The Agent's Namespace was not ready when the controller ran this deployment, for example while it is being deleted. Deploy again once the Namespace is ready.";
    case "WORKSPACE_SETUP_REFUSED":
      return "Initial workspace setup refused this version's workspace, and every retry would refuse it again: the workspace files or setup record, or the runtime's default files, do not match what the Agent was created with. Ask an admin to check the Agent's workspace storage and runtime image; do not delete the setup record to force a replay.";
    case "WORKSPACE_SETUP_UNSUPPORTED":
      return "The Agent was created with initial workspace files, which the Installation's Compute Driver cannot set up. Ask an admin to select a Compute Driver that supports them, then deploy again, or create the Agent without initial workspace files.";
    case "DEPENDENCY_UNAVAILABLE":
      return "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an admin to check the controller worker log.";
    case "LEASE_EXPIRED":
      return "The controller worker stopped or lost its claim during this deployment's last attempt. Deploy again.";
    case "AGENT_GATEWAY_UNAVAILABLE":
      return "The Agent Gateway was still not reachable through its route at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the gateway route and the Agent's Pods.";
    case "AGENT_GATEWAY_UNAUTHORIZED":
      return "The Agent Gateway refused its own CLI as unauthorized. Check that the Agent's Configuration sets gateway.auth.password to OPENCLAW_GATEWAY_PASSWORD (Enable gateway password access), then deploy again.";
    case "KUBERNETES_API_UNAVAILABLE":
      return "The Kubernetes API was still unavailable at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the cluster's API server.";
    case "KUBERNETES_SECRET_WRITE_FORBIDDEN":
      return "Kubernetes refused access to a Secret this version needs (HTTP 403 Forbidden), so the controller did not retry. Ask a platform operator to check that the worker's tenant RoleBindings grant get, create and update on secrets in the Agent's Kubernetes namespaces (with an execution cluster, also the control cluster's Gateway namespace), and that no admission policy or ResourceQuota refuses Secrets there, then deploy again.";
    case "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED":
      return SandboxRepositoryRecipientUnverifiedError.description;
    case "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED":
      return "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness. Use credential sources instead of Secret bindings, or ask an Installation administrator for a Sandbox Driver that supports them, then deploy again.";
    case "SANDBOX_HARNESS_UNSUPPORTED":
      return "The Sandbox Driver does not support this revision's Harness settings, such as plugins, network policy additions or ServiceAccount credentials. Change them, or ask an Installation administrator for a Driver that supports them, then deploy again.";
    case "SANDBOX_GATEWAY_UNAUTHORIZED":
      return "The Sandbox gateway refused the controller's identity in this revision's Workspace, so the Driver could not confirm the revision's Sandbox removed, its Harness exposure withdrawn or its credentials detached. A Workspace removed outside the controller presents the same way. For an authentication failure, check the controller gateway identity's token file and the gateway's signing-key refresh; for a permission denial, restore that identity's Workspace role (or recreate the Workspace with a deploy). Then deploy, stop, delete or withdraw again.";
    case "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT":
      return "Two credential sources the Agent binds use the same environment variable. Bind only one source per variable, for example one openai source and bearer-token sources with distinct env_var values, then deploy again.";
    case "CREDENTIAL_WITHDRAWN":
      return "The Harness credential source was withdrawn from this revision, so the revision cannot start. Bind a replacement source or another authentication method, then deploy again.";
    case "CREDENTIAL_GATEWAY_MISMATCH":
      return "The Installation no longer selects the Credential Gateway this revision was admitted with. Bind sources registered through the selected gateway, or remove them and change harnessAuth, then deploy again.";
    case "HARNESS_AUTH_SOURCE_UNAVAILABLE":
      return "The Harness authentication source this revision was admitted with is missing, being deleted, or changed since admission. Bind an available source, then deploy again.";
    case "EGRESS_PROVIDER_UNAVAILABLE":
      return "The protected egress provider this revision's Harness source was admitted with is no longer selected or available. Ask an admin to reselect it, or bind a source admitted under the selected provider, then deploy again.";
    case "CREDENTIAL_SOURCE_UNAVAILABLE":
      return "A credential source this revision lists is missing, being deleted, or changed since admission. Bind available sources, then deploy again.";
    case "SECRET_DRIVER_MISMATCH":
      return "The Installation no longer selects the Secret Driver this revision was admitted with. Bind Secrets created through the selected Secret Driver, or remove the old Secret bindings, then deploy again.";
    case "COMPUTE_DRIVER_MISMATCH":
      return "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.";
    case "HARNESS_DESCRIPTOR_MISMATCH":
      return "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.";
    case "SERVICE_ACCOUNT_BACKEND_MISMATCH":
      return "The ServiceAccount's Backend binding no longer matches the Agent's Backend, or its credential is no longer issued. Bind a ServiceAccount created and issued under the Agent's current Backend, then deploy again.";
    case "SANDBOX_ADMISSION_LIMIT_REACHED":
      return "The Sandbox gateway still refused new controller requests (request admission limit reached) at the deployment deadline. Deploy again once other Sandbox work has finished; if it keeps failing, ask an operator to check the gateway's request limit.";
    case "SANDBOX_GATEWAY_UNAVAILABLE":
      return "The Sandbox gateway still did not answer the controller at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the Sandbox gateway.";
    // These codes used to fall through to the fallback below, which named no step (finding 2537).
    case "INVALID_HARNESS_AUTH":
      return "This version's Harness authentication cannot be used: its Secret or ServiceAccount is outside the Agent's Namespace, or its method is not supported. Choose the Harness authentication again in the Agent's Credentials, then deploy a new version.";
    case "INVALID_AGENT_PRINCIPAL":
      return "The Agent's own identity, which this version runs as, is missing from the Installation, so the controller did not start the version. Ask an Installation administrator to check the Agent and the controller worker log.";
    case "INVALID_SECRET_BINDINGS":
      return "The Secret bindings stored with this version are not valid, so the controller did not start it. Deploy again to admit a version with the Agent's current Secret bindings; if the deploy is refused, bind the Agent's Secrets again first.";
    case "EXECUTION_ADMISSION_UNAVAILABLE":
      return "This version was admitted for protected execution that the Installation can no longer provide, for example after its Credential Proxy changed. Deploy again; if the deploy is refused, ask an Installation administrator to check the Credential Proxy.";
    case "INVALID_TARGET":
    case "INVALID_REVISION_OWNER":
    case "INVALID_ADMITTED_REVISION":
    case "INVALID_ACTIVE_REVISION":
      return "The stored records for this version are inconsistent with its Agent or Namespace, so the controller did not start it and it has no runtime logs. Ask an Installation administrator to check the controller worker log for this deployment.";
    case "INVALID_DRIVER_OBSERVATION":
      return "The Compute Driver reported this version's state in a form the controller rejects, so it stopped the deployment. Check this version's logs, then deploy a new version; if it fails again, ask an operator whether the Compute Driver matches this controller.";
    case "INVALID_REPOSITORY_DRIVER_OBSERVATION":
      return "The repository credential Driver reported a session in a form the controller rejects, so it stopped the deployment. Check this version's logs, then deploy a new version; if it fails again, ask an operator to check the repository credential Driver.";
    case "INVALID_REPOSITORY_ATTEMPT_OWNER":
      return "A repository session stored for this version does not match the repository access it binds, so the controller stopped the deployment. Its runtime logs cannot show why: ask an Installation administrator to check the controller worker log.";
    case "REPOSITORY_PROXY_ADMISSION_MISMATCH":
      return "This version's repository access no longer matches the Credential Proxy delivery it was admitted with. Deploy again to admit a version with the current repository access.";
    case "REPOSITORY_PREPARED_ADMISSION_UNAVAILABLE":
      return "The Installation's repository credential Driver cannot keep the session records this version's repository access needs. Ask an Installation administrator for a Driver that supports them, or remove the Agent's repository access, then deploy again.";
    case "REPOSITORY_EXECUTION_CLOSED":
      return "This version's standing repository access was closed, and the controller does not reopen it for the same version. Deploy again to restore repository access.";
    case "REPOSITORY_EXECUTION_CHANGED":
    case "REPOSITORY_EXECUTION_REPLACED":
      return "This version's runtime was replaced after the controller checked it for repository access, so the controller closed that access. Deploy again to restore repository access.";
    case "REPOSITORY_EXECUTION_UNVERIFIED":
      return "The controller could not confirm that the runtime holding this version's standing repository access is the one it recorded, so it did not grant that access. Deploy again to restore repository access.";
    case "REPOSITORY_SESSION_RECOVERY_UNSAFE":
      return "A repository session this version opened ended in an unknown state and may still hold a credential, so the controller opens no other for it. Deploy again; if repository access still fails, ask an Installation administrator to check for open sessions.";
    case "REPOSITORY_SESSION_NO_LONGER_CURRENT":
      return "This version's repository session ended or expired before the controller confirmed it. Deploy again to open a new session.";
    case "REPOSITORY_STANDING_APPROVAL_REMOVED":
      return "The standing repository approval this version was admitted with was removed or replaced. Approve the repository access again, or remove the Agent's repository access, then deploy again.";
    case "REPOSITORY_STANDING_POLICY_CHANGED":
      return "The Namespace's repository policy changed since this version's standing repository approval, so the approval no longer covers it. Approve the repository access again under the current policy, or remove the Agent's repository access, then deploy again.";
    case "UNKNOWN_FAILURE":
      return "The deployment failed without a recorded reason. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log, then deploy a new version.";
    default:
      return "Deployment failed. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log for this code.";
  }
}
