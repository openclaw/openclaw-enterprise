import { immutableCopy, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../errors.ts";

export type ControllerWorkState = "queued" | "claimed" | "succeeded" | "failed_permanent";

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
}

export interface ControllerWork {
  readonly idempotencyKey: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly actorId: string;
  readonly namespaceTarget?: "ready" | "deleted";
  readonly agentTarget?: "stopped";
  readonly state: ControllerWorkState;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly completedAt?: Date;
  readonly reasonCode?: string;
  readonly errorData?: Readonly<Record<string, unknown>>;
  readonly receiptId?: string;
  readonly receiptAcknowledgedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimedWork extends ControllerWork {
  readonly state: "claimed";
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
}

export interface EnqueueWork {
  readonly idempotencyKey: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly actorId: string;
  readonly namespaceTarget?: "ready" | "deleted";
  readonly agentTarget?: "stopped";
  readonly availableAt?: Date | string;
}

export interface WorkClaim {
  readonly idempotencyKey: string;
  readonly claimToken: string;
}

export interface WorkResult {
  readonly code?: string;
  readonly receiptId?: string;
}

export interface RetryableFailure {
  readonly code: string;
  readonly summary?: string;
  readonly receiptId?: string;
}

export interface PermanentFailure {
  readonly code: string;
  readonly data?: unknown;
  readonly summary?: string;
  readonly receiptId?: string;
}

export interface ReceiptAcknowledgementIdentity {
  readonly idempotencyKey: string;
  readonly state: "succeeded" | "failed_permanent";
  readonly reasonCode: string;
  readonly receiptId: string;
}

export interface ReceiptAcknowledgementWork extends ControllerWork {
  readonly state: "succeeded" | "failed_permanent";
  readonly reasonCode: string;
  readonly receiptId: string;
}

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

export function safeReceiptId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const receiptId = nonempty(value, "Controller work receipt ID");
  if (receiptId.length > 512) {
    throw new ScopeViolationError("The controller work receipt ID exceeds 512 characters.");
  }
  return receiptId;
}

export function validateFailureData(
  reasonCode: string,
  data: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (data === undefined) return undefined;
  if (reasonCode === "PLUGIN_INSTALL_FAILED" || reasonCode === "PLUGIN_AUTH_REQUIRED") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ScopeViolationError("Plugin deployment failure data must be an object.");
    }
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "pluginId") {
      throw new ScopeViolationError("Plugin deployment failure data has unsupported fields.");
    }
    const pluginId = (data as { readonly pluginId?: unknown }).pluginId;
    if (!isNonEmptyString(pluginId) || pluginId.length > 253) {
      throw new ScopeViolationError("Plugin deployment failure data requires a safe plugin ID.");
    }
    return Object.freeze({ pluginId });
  }
  if (reasonCode === "CONVERGENCE_DEADLINE_EXCEEDED") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ScopeViolationError("Convergence deadline failure data must be an object.");
    }
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "timeoutMs") {
      throw new ScopeViolationError("Convergence deadline failure data has unsupported fields.");
    }
    const timeoutMs = (data as { readonly timeoutMs?: unknown }).timeoutMs;
    if (typeof timeoutMs !== "number" || !isPositiveSafeInteger(timeoutMs)) {
      throw new ScopeViolationError(
        "Convergence deadline failure data requires a positive timeout.",
      );
    }
    return Object.freeze({ timeoutMs });
  }
  throw new ScopeViolationError("Controller work failure data is not allowed for this code.");
}

export function deploymentErrorForWork(
  work: Readonly<ControllerWork>,
): DeploymentStatusError | null {
  if (work.state !== "failed_permanent" && !completedWithoutActivation(work)) return null;
  const code = work.reasonCode ?? "UNKNOWN_FAILURE";
  const data =
    work.errorData === undefined
      ? undefined
      : validateFailureData(code, immutableCopy(work.errorData));
  return Object.freeze({
    code,
    message: deploymentErrorMessage(code),
    ...(data === undefined ? {} : { data }),
  });
}

export function controllerWorkDeploymentStatus(
  work: Readonly<ControllerWork>,
  now: Date = new Date(),
): DeploymentStatus {
  if (work.state === "succeeded") return completedWithoutActivation(work) ? "failed" : "succeeded";
  if (work.state === "failed_permanent") return "failed";
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
    case "PLUGIN_INSTALL_FAILED":
      return "Plugin installation failed.";
    case "PLUGIN_AUTH_REQUIRED":
      return "Plugin authentication is required.";
    case "CONVERGENCE_DEADLINE_EXCEEDED":
      return "Deployment convergence deadline exceeded.";
    case "REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    default:
      return "Deployment reconciliation failed.";
  }
}
