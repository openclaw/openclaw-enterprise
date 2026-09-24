import type {
  HarnessAuthBinding,
  HarnessExecutionMode,
  InitialWorkspaceFiles,
  OpenClawConfigurationDocument,
  PluginDesiredState,
  RepositoryBindingRequest,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import {
  normalizeHarnessAuthBinding,
  normalizeInitialWorkspaceFiles,
  normalizeSecretBindings,
  normalizeWorkspaceDefaultsId,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ScopeViolationError } from "./errors.ts";
import type { AgentProvisioningRecord } from "./state/agent-provisioning.ts";
import type { ControllerWork } from "./state/controller-work.ts";

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
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
}

export interface AgentProvisioningProgress {
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
}

export interface ProvisionAgentResult {
  readonly provisioning: Readonly<AgentProvisioningProgress>;
}

export interface AgentProvisioningPlan {
  readonly configuration: AgentProvisioningConfigurationInput;
  readonly harnessAuth: HarnessAuthBinding | null;
  readonly executionMode: HarnessExecutionMode;
}

function configurationDocument(value: unknown): OpenClawConfigurationDocument {
  const record = asRecord(value);
  if (record === undefined) {
    throw new ScopeViolationError("Agent provisioning Configuration values must be an object.");
  }
  return immutableCopy(record as OpenClawConfigurationDocument);
}

function normalizeBindingError(error: unknown): never {
  throw new ScopeViolationError(
    error instanceof Error ? error.message : "Agent provisioning Secret bindings are invalid.",
  );
}

function normalizeProvisioningSecretBindings(input: unknown): SecretBindings | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    const normalized = normalizeSecretBindings(input);
    return Object.keys(normalized).length === 0 ? undefined : normalized;
  } catch (error) {
    normalizeBindingError(error);
  }
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

export function provisioningProgress(
  record: Readonly<AgentProvisioningRecord>,
  work?: Readonly<ControllerWork>,
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
  return Object.freeze({
    workId: record.workId,
    status: failed
      ? "failed"
      : record.status === "succeeded"
        ? "succeeded"
        : work?.state === "claimed"
          ? "running"
          : "queued",
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
            message: "Provisioning was cancelled. Create a new Agent to provision again.",
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
