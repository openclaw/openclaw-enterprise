import { immutableCopy, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import type { RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";

import { ScopeViolationError } from "../errors.ts";
import { runtimeFailureCause } from "../runtime-failure-cause.ts";

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
}

export interface ControllerWorkAttempt {
  readonly at: Date;
  readonly code: string;
}

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
    case "WORKSPACE_NODE_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the workspace node to connect to the Gateway.";
      break;
    case "WORKSPACE_NODE_BINDING_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the Gateway to apply the workspace node.";
      break;
    case "DEPENDENCY_UNAVAILABLE":
      code = attempt.code;
      message = "A dependency was unavailable. The controller will retry.";
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
    case "ACTIVE_REVISION_CHANGED":
      code = attempt.code;
      message = "The selected version changed. The controller will reconcile again.";
      break;
    case "LEASE_EXPIRED":
      code = attempt.code;
      message = "The previous worker claim expired. Reconciliation will resume.";
      break;
    case "ACTIVE_REVISION_RECOVERY":
      code = attempt.code;
      message =
        "The previous worker claim expired after this version was published. The controller will finish activating it.";
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
    "stopped" | "deleted" | "provisioned" | typeof CREDENTIAL_WITHDRAWAL_TARGET;
  readonly state: ControllerWorkState;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: Date;
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
    "stopped" | "deleted" | "provisioned" | typeof CREDENTIAL_WITHDRAWAL_TARGET;
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

export function validateFailureData(
  reasonCode: string,
  data: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (data === undefined) {
    return undefined;
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
      ...(evidence === undefined ? {} : { runtimeFailure: evidence }),
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
    return Object.freeze({ runtimeFailure: evidence });
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
  if (work.state === "claimed") {
    if (work.leaseExpiresAt !== undefined && work.leaseExpiresAt.getTime() > now.getTime()) {
      return "running";
    }
    return "queued";
  }
  return "queued";
}

function completedWithoutActivation(work: Readonly<ControllerWork>): boolean {
  return (
    work.state === "succeeded" &&
    work.reasonCode !== "REVISION_ACTIVATED" &&
    work.reasonCode !== "REVISION_ALREADY_ACTIVE"
  );
}

function deploymentErrorMessage(code: string): string {
  switch (code) {
    case "CONVERGENCE_DEADLINE_EXCEEDED":
      return "Deployment convergence deadline exceeded.";
    case "RUNTIME_AUTHENTICATION_FAILED":
      return "Deployment runtime credentials were rejected.";
    case "RUNTIME_CPU_STARVED":
      return "Deployment runtime did not get enough CPU to start.";
    case "RUNTIME_MODEL_PROBE_TIMEOUT":
      return "Deployment runtime startup model check timed out.";
    case "RUNTIME_MODEL_PROBE_FAILED":
      return "Deployment runtime startup model check failed.";
    case "RUNTIME_LOGIN_FAILED":
      return "Deployment runtime could not sign in to the model provider.";
    case "RUNTIME_STARTUP_FAILED":
      return "Deployment runtime failed a startup check.";
    case "REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    case "REVISION_STOPPED":
      return "Deployment ended because the Agent was stopped.";
    case "AGENT_GATEWAY_UNAVAILABLE":
      return "The Agent Gateway was still not reachable through its route at the deployment deadline.";
    case "KUBERNETES_API_UNAVAILABLE":
      return "The Kubernetes API was still unavailable at the deployment deadline.";
    case "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED":
      return "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness.";
    case "SANDBOX_HARNESS_UNSUPPORTED":
      return "The Sandbox Driver does not support this revision's Harness.";
    default:
      return "Deployment reconciliation failed.";
  }
}
