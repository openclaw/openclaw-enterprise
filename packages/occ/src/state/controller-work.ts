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
  readonly warnings: readonly PluginDeploymentWarning[];
}

export interface PluginDeploymentWarning {
  readonly code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED";
  readonly pluginId: string;
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
    case "REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    default:
      return "Deployment reconciliation failed.";
  }
}
