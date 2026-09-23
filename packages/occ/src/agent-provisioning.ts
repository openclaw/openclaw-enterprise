import type {
  Agent,
  HarnessAuthBinding,
  HarnessExecutionMode,
  InitialWorkspaceFiles,
  OpenClawConfigurationDocument,
  PluginDesiredState,
  RepositoryBindingRequest,
  SecretBindings,
  SecretReference,
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

export interface AgentProvisioningSecretInput {
  readonly name: string;
  readonly value: string;
}

export interface ProvisioningSecretSource {
  readonly kind: "provisioning-secret";
  readonly name: string;
}

export type AgentProvisioningSecretSource = ProvisioningSecretSource | SecretReference;

export interface AgentProvisioningSecretBinding {
  readonly source: AgentProvisioningSecretSource;
  readonly delivery?: { readonly type: "env" };
}

export type AgentProvisioningSecretBindings = Readonly<
  Record<string, AgentProvisioningSecretBinding>
>;

export interface AgentProvisioningConfigurationInput {
  readonly kind: "agent";
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: AgentProvisioningSecretBindings;
}

export type AgentProvisioningHarnessAuth =
  HarnessAuthBinding | { readonly method: "api_key"; readonly source: ProvisioningSecretSource };

export interface ProvisionAgentInput {
  readonly requestId: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly configuration: AgentProvisioningConfigurationInput;
  readonly secrets?: readonly AgentProvisioningSecretInput[];
  readonly initialWorkspaceFiles?: InitialWorkspaceFiles;
  readonly workspaceDefaultsId?: string;
  readonly providerId?: string | null;
  readonly harnessAuth?: AgentProvisioningHarnessAuth | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly repositoryBindings?: readonly RepositoryBindingRequest[];
}

export interface AgentProvisioningProgress {
  readonly status: AgentProvisioningStatus;
  readonly phase: AgentProvisioningRecord["completedPhase"];
  readonly attemptCount: number;
  readonly updatedAt: string;
  readonly revisionId?: string;
  readonly url?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ProvisionAgentResult {
  readonly agent: Readonly<Agent>;
  readonly provisioning: Readonly<AgentProvisioningProgress>;
}

export interface NormalizedProvisioningSecret {
  readonly name: string;
  readonly value: string;
}

export interface AgentProvisioningPlan {
  readonly configuration: AgentProvisioningConfigurationInput;
  readonly harnessAuth: AgentProvisioningHarnessAuth | null;
  readonly executionMode?: HarnessExecutionMode;
  readonly secrets: readonly {
    readonly name: string;
    readonly secretId: string;
    readonly slot: string;
  }[];
}

const LOCAL_SECRET_NAME = /^[A-Za-z0-9._:@-]{1,200}$/u;
const PROVISIONING_SECRET_PLACEHOLDER_NAMESPACE = "__provisioning_request__";

function configurationDocument(value: unknown): OpenClawConfigurationDocument {
  const record = asRecord(value);
  if (record === undefined) {
    throw new ScopeViolationError("Agent provisioning Configuration values must be an object.");
  }
  return immutableCopy(record as OpenClawConfigurationDocument);
}

function provisioningSecretSource(value: unknown): ProvisioningSecretSource | undefined {
  const record = asRecord(value);
  if (record?.kind !== "provisioning-secret" || !isNonEmptyString(record.name)) {
    return undefined;
  }
  if (!LOCAL_SECRET_NAME.test(record.name)) {
    throw new ScopeViolationError("Agent provisioning Secret names must be safe identifiers.");
  }
  return Object.freeze({ kind: "provisioning-secret", name: record.name });
}

function normalizeBindingError(error: unknown): never {
  throw new ScopeViolationError(
    error instanceof Error ? error.message : "Agent provisioning Secret bindings are invalid.",
  );
}

function placeholderSecretReference(name: string): SecretReference {
  return Object.freeze({
    kind: "secret",
    namespaceId: PROVISIONING_SECRET_PLACEHOLDER_NAMESPACE,
    id: `local:${name}`,
  });
}

function normalizeProvisioningSecretBindings(
  input: unknown,
): AgentProvisioningSecretBindings | undefined {
  if (input === undefined) {
    return undefined;
  }
  const bindingRecord = asRecord(input);
  if (bindingRecord === undefined) {
    throw new ScopeViolationError("Agent provisioning Secret bindings must be an object.");
  }

  const localSources = new Map<string, ProvisioningSecretSource>();
  const validationInput: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(bindingRecord)) {
    const binding = asRecord(value);
    const local =
      binding?.source === undefined ? undefined : provisioningSecretSource(binding.source);
    if (binding !== undefined && local !== undefined) {
      localSources.set(name, local);
      validationInput[name] = Object.freeze({
        ...binding,
        source: placeholderSecretReference(local.name),
      });
      continue;
    }
    validationInput[name] = value;
  }

  let normalized: SecretBindings;
  try {
    normalized = normalizeSecretBindings(validationInput);
  } catch (error) {
    normalizeBindingError(error);
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(normalized).map(([name, binding]) => [
        name,
        Object.freeze({
          source: localSources.get(name) ?? binding.source,
          ...(binding.delivery === undefined ? {} : { delivery: binding.delivery }),
        }),
      ]),
    ),
  );
}

function sameProvisioningSecretSource(
  left: AgentProvisioningSecretSource,
  right: AgentProvisioningSecretSource,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "provisioning-secret") {
    return left.name === (right as ProvisioningSecretSource).name;
  }
  return (
    left.namespaceId === (right as SecretReference).namespaceId &&
    left.id === (right as SecretReference).id
  );
}

export function requireProvisioningRequestId(value: unknown): string {
  if (!isNonEmptyString(value) || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new ScopeViolationError("Agent provisioning requires one stable request id.");
  }
  return value;
}

export function normalizeProvisioningSecrets(
  input: unknown,
  validateValue: (value: unknown) => void,
): readonly NormalizedProvisioningSecret[] {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(input) || input.length > 64) {
    throw new ScopeViolationError("Agent provisioning secrets must be a bounded array.");
  }
  const names = new Set<string>();
  return Object.freeze(
    input.map((entry) => {
      const record = asRecord(entry);
      if (
        record === undefined ||
        Object.keys(record).some((key) => key !== "name" && key !== "value") ||
        !isNonEmptyString(record.name) ||
        !LOCAL_SECRET_NAME.test(record.name)
      ) {
        throw new ScopeViolationError("Agent provisioning secrets require a name and value.");
      }
      if (names.has(record.name)) {
        throw new ScopeViolationError("Agent provisioning secret names must be unique.");
      }
      validateValue(record.value);
      names.add(record.name);
      return Object.freeze({ name: record.name, value: String(record.value) });
    }),
  );
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

export function normalizeProvisioningHarnessAuth(
  input: unknown,
): AgentProvisioningHarnessAuth | null {
  const record = asRecord(input);
  const localSource =
    record?.method === "api_key" ? provisioningSecretSource(record.source) : undefined;
  if (localSource !== undefined) {
    return Object.freeze({ method: "api_key", source: localSource });
  }
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

export function localProvisioningSecretNames(
  configuration: AgentProvisioningConfigurationInput,
  harnessAuth: AgentProvisioningHarnessAuth | null,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const binding of Object.values(configuration.secretBindings ?? {})) {
    if (
      harnessAuth?.method === "api_key" &&
      sameProvisioningSecretSource(binding.source, harnessAuth.source)
    ) {
      throw new ScopeViolationError(
        "Agent provisioning Harness authentication Secret cannot also be delivered to the gateway environment.",
      );
    }
    if (binding.source.kind === "provisioning-secret") {
      names.add(binding.source.name);
    }
  }
  if (harnessAuth?.method === "api_key" && harnessAuth.source.kind === "provisioning-secret") {
    names.add(harnessAuth.source.name);
  }
  return names;
}

export function exactSecretBindings(
  bindings: AgentProvisioningSecretBindings | undefined,
  created: ReadonlyMap<string, SecretReference>,
): SecretBindings | undefined {
  if (bindings === undefined) {
    return undefined;
  }
  const exact: Record<string, SecretBindings[string]> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    const source =
      binding.source.kind === "provisioning-secret"
        ? created.get(binding.source.name)
        : binding.source;
    if (source === undefined) {
      throw new ScopeViolationError("Agent provisioning Secret binding source is unavailable.");
    }
    exact[name] = Object.freeze({
      source,
      ...(binding.delivery === undefined ? {} : { delivery: binding.delivery }),
    });
  }
  if (Object.keys(exact).length === 0) {
    return undefined;
  }
  try {
    return normalizeSecretBindings(exact);
  } catch (error) {
    normalizeBindingError(error);
  }
}

export function exactProvisioningHarnessAuth(
  harnessAuth: AgentProvisioningHarnessAuth | null,
  created: ReadonlyMap<string, SecretReference>,
): HarnessAuthBinding | null {
  if (harnessAuth?.method !== "api_key" || harnessAuth.source.kind !== "provisioning-secret") {
    return harnessAuth as HarnessAuthBinding | null;
  }
  const source = created.get(harnessAuth.source.name);
  if (source === undefined) {
    throw new ScopeViolationError("Agent provisioning Harness Secret source is unavailable.");
  }
  return Object.freeze({ method: "api_key", source });
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
