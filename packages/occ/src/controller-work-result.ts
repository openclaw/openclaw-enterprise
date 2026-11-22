import { immutableCopy, isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import {
  isComputePreparationFailureEvidence,
  type RuntimeFailureEvidence,
} from "@openclaw-enterprise/contracts";

import type { PluginDeploymentWarning } from "./controller-work.ts";
import { ScopeViolationError } from "./errors.ts";
import { recognizedRuntimeFailureValues, runtimeFailureCause } from "./runtime-failure-cause.ts";

const RUNTIME_FAILURE_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

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
 * failure value outside the vocabulary in packages/contracts/src/runtime-failure.ts is recorded,
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

function validatePluginWarnings(warnings: unknown): readonly PluginDeploymentWarning[] | undefined {
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
