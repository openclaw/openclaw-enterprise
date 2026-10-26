import type {
  HarnessAuthBinding,
  HarnessExecutionMode,
  InitialWorkspaceFiles,
  OpenClawConfigurationDocument,
  PluginDesiredState,
  PluginApprovers,
  RepositoryBindingRequest,
  RepositoryAccess,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import {
  normalizeHarnessAuthBinding,
  normalizeInitialWorkspaceFiles,
  normalizeSecretBindings,
  normalizeWorkspaceDefaultsId,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ScopeViolationError, SecretBindingValidationError } from "./errors.ts";
import type { AgentProvisioningRecord } from "./state/agent-provisioning.ts";
import type { ControllerWork } from "./state/controller-work.ts";
import { controllerWorkLeaseActive } from "./state/controller-work.ts";

export type AgentProvisioningStatus = "queued" | "running" | "failed" | "succeeded";

export interface AgentProvisioningConfigurationInput {
  readonly kind: "agent";
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
}

export interface ProvisionAgentInput {
  readonly requestId: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly configuration: AgentProvisioningConfigurationInput;
  readonly initialWorkspaceFiles?: InitialWorkspaceFiles;
  readonly workspaceDefaultsId?: string;
  readonly backendId?: string | null;
  readonly harnessAuth?: HarnessAuthBinding | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
  readonly repositoryAccess?: RepositoryAccess;
}

/** The pending code a provisioning job records while its initial deployment has not finished. */
export const PROVISIONING_DEPLOYMENT_PENDING = "PROVISIONING_DEPLOYMENT_PENDING";

const PROVISIONING_DEPLOYMENT_PENDING_MESSAGE = "Waiting for the initial deployment to complete.";

/**
 * Why a job past handoff has not finished (finding 1634). The job defers without a lease and
 * without spending attempts while its first deployment converges, so `status` and
 * `attemptCount` alone read like a job that never ran.
 */
export interface AgentProvisioningDeploymentWait {
  readonly phase: "deployment";
  readonly lastAttempt: {
    readonly at: string;
    readonly code: string;
    readonly message: string;
  } | null;
}

/** The initial deployment's own progress (`deploymentProgressForWork`), as far as it is used here. */
export type AgentProvisioningDeploymentProgress = {
  readonly lastAttempt: AgentProvisioningDeploymentWait["lastAttempt"];
} | null;

export interface AgentProvisioningProgress {
  readonly requestId: string;
  readonly workId: string;
  readonly status: AgentProvisioningStatus;
  readonly phase: AgentProvisioningRecord["completedPhase"];
  readonly attemptCount: number;
  readonly updatedAt: string;
  readonly agentId?: string;
  readonly configurationId?: string;
  readonly revisionId?: string;
  readonly url?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly progress?: AgentProvisioningDeploymentWait;
}

export interface ProvisionAgentResult {
  readonly provisioning: Readonly<AgentProvisioningProgress>;
}

function configurationDocument(value: unknown): OpenClawConfigurationDocument {
  const record = asRecord(value);
  if (record === undefined) {
    throw new ScopeViolationError("Agent provisioning Configuration values must be an object.");
  }
  return immutableCopy(record as OpenClawConfigurationDocument);
}

/**
 * Normalizes Secret bindings a caller submitted. A binding that breaks the grammar is the
 * caller's invalid request, reported with the rule it broke. Bindings read back from state
 * use the plain grammar instead: a stored binding that no longer validates is not the
 * caller's fault.
 */
export function normalizeRequestSecretBindings(
  input: unknown,
  bindingsPath = "/secretBindings",
): SecretBindings {
  try {
    return normalizeSecretBindings(input);
  } catch (error) {
    const destination =
      error instanceof Error &&
      "destination" in error &&
      typeof error.destination === "string" &&
      "destinationRule" in error
        ? error.destinationRule === "invalid_format"
          ? { bindingsPath, code: "INVALID_FORMAT" as const }
          : { bindingsPath, key: error.destination, code: "INVALID_VALUE" as const }
        : undefined;
    throw new SecretBindingValidationError(
      error instanceof Error ? error.message : "Secret bindings are invalid.",
      destination,
    );
  }
}

function normalizeProvisioningSecretBindings(input: unknown): SecretBindings | undefined {
  if (input === undefined) {
    return undefined;
  }
  const normalized = normalizeRequestSecretBindings(input, "/configuration/secretBindings");
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export function requireProvisioningRequestId(value: unknown): string {
  if (!isNonEmptyString(value) || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new ScopeViolationError("Agent provisioning requires one stable request id.");
  }
  return value;
}

export function normalizeProvisioningConfiguration(
  input: unknown,
): AgentProvisioningConfigurationInput {
  const record = asRecord(input);
  if (record?.kind !== "agent" || record.values === undefined) {
    throw new ScopeViolationError("Agent provisioning requires inline Agent Configuration.");
  }
  const secretBindings = normalizeProvisioningSecretBindings(record.secretBindings);
  return Object.freeze({
    kind: "agent",
    values: configurationDocument(record.values),
    ...(secretBindings === undefined ? {} : { secretBindings }),
  });
}

export function normalizeProvisioningHarnessAuth(input: unknown): HarnessAuthBinding | null {
  return normalizeHarnessAuthBinding(input);
}

export function normalizeProvisioningWorkspace(
  initialWorkspaceFiles: unknown,
  workspaceDefaultsId: unknown,
): {
  readonly initialWorkspaceFiles?: InitialWorkspaceFiles;
  readonly workspaceDefaultsId?: string;
} {
  const files = normalizeInitialWorkspaceFiles(initialWorkspaceFiles);
  const defaultsId = normalizeWorkspaceDefaultsId(workspaceDefaultsId);
  return Object.freeze({
    ...(files === undefined ? {} : { initialWorkspaceFiles: files }),
    ...(defaultsId === undefined ? {} : { workspaceDefaultsId: defaultsId }),
  });
}

/**
 * The wait a job past handoff reports. `deployment` is the initial deployment's own progress,
 * given only when the caller may read that deployment; it names the wait when it knows one.
 * Otherwise the job's own deferral code stands in, which the provisioning read already covers.
 */
function provisioningDeploymentWait(
  record: Readonly<AgentProvisioningRecord>,
  deployment: AgentProvisioningDeploymentProgress | undefined,
): AgentProvisioningDeploymentWait {
  const named = deployment?.lastAttempt;
  if (named != null && named.code !== "RECONCILIATION_PENDING") {
    return Object.freeze({
      phase: "deployment",
      lastAttempt: Object.freeze({ at: named.at, code: named.code, message: named.message }),
    });
  }
  const deferred =
    asRecord(asRecord(record.progress)?.error)?.code === PROVISIONING_DEPLOYMENT_PENDING;
  return Object.freeze({
    phase: "deployment",
    lastAttempt:
      deferred && record.updatedAt instanceof Date && !Number.isNaN(record.updatedAt.getTime())
        ? Object.freeze({
            at: record.updatedAt.toISOString(),
            code: PROVISIONING_DEPLOYMENT_PENDING,
            message: PROVISIONING_DEPLOYMENT_PENDING_MESSAGE,
          })
        : null,
  });
}

export function provisioningProgress(
  record: Readonly<AgentProvisioningRecord>,
  work?: Readonly<ControllerWork>,
  now: Date = new Date(),
  deployment?: AgentProvisioningDeploymentProgress,
): Readonly<AgentProvisioningProgress> {
  const progress = asRecord(record.progress);
  const error = asRecord(progress?.error);
  const cancelled = record.status === "cancelled";
  const failed = cancelled || record.status === "failed" || work?.state === "failed_permanent";
  const updatedAt =
    record.updatedAt instanceof Date && !Number.isNaN(record.updatedAt.getTime())
      ? record.updatedAt.toISOString()
      : new Date(0).toISOString();
  const attemptCount =
    work === undefined || !Number.isSafeInteger(work.attemptCount) || work.attemptCount < 0
      ? 0
      : work.attemptCount;
  const workReasonCode = work?.reasonCode;
  const failedCode = isNonEmptyString(workReasonCode) ? workReasonCode : "PROVISIONING_FAILED";
  let status: AgentProvisioningStatus = "queued";
  if (failed) {
    status = "failed";
  } else if (record.status === "succeeded") {
    status = "succeeded";
  } else if (work !== undefined && controllerWorkLeaseActive(work, now)) {
    status = "running";
  }
  return Object.freeze({
    requestId: record.requestId,
    workId: record.workId,
    status,
    phase: record.completedPhase,
    attemptCount,
    updatedAt,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    ...(record.configurationId === undefined ? {} : { configurationId: record.configurationId }),
    ...(record.revisionId === undefined ? {} : { revisionId: record.revisionId }),
    ...(cancelled
      ? {
          error: {
            code: "PROVISIONING_CANCELLED",
            // Stop and Delete store a fixed sentence naming which one cancelled the job: a
            // stopped Agent keeps its name, so "create a new Agent" would be wrong (finding 1376).
            message:
              error?.code === "PROVISIONING_CANCELLED" && isNonEmptyString(error.message)
                ? error.message
                : "Provisioning was cancelled.",
          },
        }
      : failed
        ? error !== undefined && isNonEmptyString(error.code) && isNonEmptyString(error.message)
          ? { error: { code: error.code, message: error.message } }
          : {
              error: {
                code: failedCode,
                message: "Provisioning failed. Review the failed step before retrying.",
              },
            }
        : {}),
    // Handoff recorded the first revision; the job now only waits for that deployment.
    ...((status === "queued" || status === "running") && record.revisionId !== undefined
      ? { progress: provisioningDeploymentWait(record, deployment) }
      : {}),
  });
}

export function canonicalProvisioningJson(input: unknown): string {
  if (input === null) {
    return "null";
  }
  if (typeof input === "bigint") {
    throw new ScopeViolationError("Agent provisioning request must be JSON serializable.");
  }
  if (typeof input !== "object") {
    return JSON.stringify(input) ?? "null";
  }
  if (Array.isArray(input)) {
    return `[${input.map((item) => canonicalProvisioningJson(item)).join(",")}]`;
  }
  return `{${Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalProvisioningJson(value)}`)
    .join(",")}}`;
}
