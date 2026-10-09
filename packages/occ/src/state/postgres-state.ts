import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { DatabaseError } from "pg";

import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindRepository } from "../ports/repository-factory.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import { postgresRepositorySessions } from "./postgres-repository-sessions.ts";
import {
  validRepositoryBindingSelections,
  normalizedRepositoryAccess,
  validRepositoryRevisionState,
} from "./repository-credential-state.ts";
import type {
  AccessBinding,
  Agent,
  AgentCredentialSourceBinding,
  AgentMetadata,
  AgentRead,
  AgentRevisionMetadata,
  AgentRevisionRead,
  ConfigurationReadError,
  WorkspaceSetup,
  AgentRevision,
  AuditEvent,
  CredentialSource,
  CredentialWithdrawal,
  Group,
  GroupMembership,
  Identity,
  Installation,
  Namespace,
  PluginDesiredState,
  PluginApprovers,
  Preset,
  Permission,
  Principal,
  Restriction,
  Role,
  Secret,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
} from "@openclaw-enterprise/contracts";
import {
  harnessAuthBindingFromSnapshot,
  normalizePluginDesiredState,
  normalizePluginApprovers,
  normalizeHarnessAuthBinding,
  normalizeSecretBindings,
  PERMISSION_ACTIONS as PLATFORM_PERMISSION_ACTIONS,
  RESOURCE_KINDS as PLATFORM_RESOURCE_KINDS,
  validPluginRevisionState,
  validPluginApprovers,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AGENT_NAME_CONFLICT,
  CREDENTIAL_SOURCE_NAME_CONFLICT,
  DELETED_NAMESPACE_NAME_CONFLICT,
  DependencyUnavailableError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  NAMESPACE_NAME_CONFLICT,
  PRESET_NAME_CONFLICT,
  ResourceConflictError,
  ResourceStateConflictError,
  SECRET_NAME_CONFLICT,
  SERVICE_ACCOUNT_NAME_CONFLICT,
  ScopeViolationError,
} from "../errors.ts";
import type {
  AgentRepository,
  WorkspaceSetupRepository,
  AgentRevisionRepository,
  ConfigurationOwnership,
  ConfigurationRepository,
  CredentialSourceRepository,
  InstallationRepository,
  IAMPolicyRepository,
  NamespaceRepository,
  PersistedNamespace,
  PresetRepository,
  PlatformAuditSink,
  PlatformOperation,
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
  SecretReferenceKind,
  SecretRepository,
  ServiceAccountRepository,
} from "./platform-state.ts";
import {
  copyProvisioningRecord,
  phaseAtLeast,
  validateProvisioningCheckpoint,
  validateProvisioningCreate,
  validateProvisioningEffectSettlement,
  validateProvisioningFailure,
  validateProvisioningReplay,
  type AgentProvisioningCheckpoint,
  type AgentProvisioningEffectSettlement,
  type AgentProvisioningFailure,
  type AgentProvisioningRecord,
  type CreateAgentProvisioningRecord,
} from "./agent-provisioning.ts";
import {
  assertHarnessAuthAvailable,
  assertSameCredentialSourceFields,
  harnessAuthMatches,
  credentialSourcesMatch,
  validCredentialSourceSnapshots,
  namespaceRoleGrantsBeyondRead,
  validHarnessAuthSnapshot,
} from "./platform-state.ts";
import {
  asWork,
  WorkClaimLostError,
  PostgresWorkQueue,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
} from "./postgres-work-queue.ts";
import { beginProvisioningEffectProgress } from "../provisioning-effects.ts";
import {
  CREDENTIAL_WITHDRAWAL_TARGET,
  credentialWithdrawalOperationId,
  credentialWithdrawalWorkKey,
} from "./controller-work.ts";

type PostgresRow = Record<string, unknown>;

export interface PostgresClient extends PostgresQueryClient {
  release(discard?: boolean): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export interface PersistedNativeIAMState {
  readonly identities: readonly Identity[];
  readonly groups: readonly Group[];
  readonly memberships: readonly GroupMembership[];
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
  readonly restrictions: readonly Restriction[];
}

export interface PostgresPlatformStateOptions {
  readonly bootstrapNativeIAM?: PersistedNativeIAMState;
  readonly workQueue?: PostgresWorkQueueOptions;
}

export interface PersistedNativeIAMPrincipalSeed {
  readonly principal: Principal;
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
}

export class PostgresCommitOutcomeUnknownError extends DependencyUnavailableError {
  constructor() {
    super("The PostgreSQL transaction commit outcome is unknown.");
    this.name = "PostgresCommitOutcomeUnknownError";
  }
}

interface TransactionContext {
  readonly lifetime: RepositoryTransactionLifetime;
  readonly client: PostgresClient;
  installation: Readonly<Installation> | undefined;
  installationLoaded: boolean;
}

const PERMISSION_ACTIONS = new Set<string>(PLATFORM_PERMISSION_ACTIONS);
const RESOURCE_KINDS = new Set<string>(PLATFORM_RESOURCE_KINDS);
const AUDIT_METADATA_KEY = "__occAuditMetadata";
const SECRET_IDENTIFIER =
  /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE_IDENTIFIER =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function rows(value: unknown[]): PostgresRow[] {
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new DependencyUnavailableError("The persistence repository returned invalid data.");
    }
    return row as PostgresRow;
  });
}

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DependencyUnavailableError("Persisted platform state is invalid or incomplete.");
  }
  return value;
}

function optionalText(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  return text(row, key);
}

function timestamp(row: PostgresRow, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new DependencyUnavailableError("Persisted platform state has an invalid timestamp.");
  }
  return date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DependencyUnavailableError("Persisted platform state contains invalid JSON.");
  }
  return parsed as Record<string, unknown>;
}

class SavedConfigurationReadError extends DependencyUnavailableError {
  readonly field: ConfigurationReadError["field"];

  constructor(field: ConfigurationReadError["field"], message: string) {
    super(message);
    this.field = field;
  }
}

function configurationRead<T>(field: ConfigurationReadError["field"], read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DependencyUnavailableError || error instanceof SyntaxError) {
      throw new SavedConfigurationReadError(field, "Persisted saved configuration is invalid.");
    }
    throw error;
  }
}

function invalidPersistedPluginState(message: string): never {
  throw new DependencyUnavailableError(message);
}

function browseSavedConfiguration<T extends object, M extends object>(
  metadata: M,
  read: () => T,
): T | (M & { readonly configurationReadError: ConfigurationReadError }) {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof SavedConfigurationReadError)) {
      throw error;
    }
    // Only payload decoding is recoverable here. Queries and identity/lifecycle
    // reads stay outside this boundary; invalid settings never become defaults.
    return immutableCopy({
      ...metadata,
      configurationReadError: {
        code: "SAVED_CONFIGURATION_UNREADABLE" as const,
        field: error.field,
      },
    });
  }
}

function invalidPluginState(message: string): never {
  throw new ScopeViolationError(message);
}

function normalizedPlugins(plugins?: PluginDesiredState): PluginDesiredState | undefined {
  return normalizePluginDesiredState(plugins, invalidPluginState);
}

function normalizedPluginApprovers(approvers?: PluginApprovers): PluginApprovers | undefined {
  return normalizePluginApprovers(approvers, invalidPluginState);
}

function pluginApproversFromJson(value: unknown): PluginApprovers | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return normalizePluginApprovers(value, invalidPersistedPluginState);
}

function pluginStateFromJson(value: unknown): PluginDesiredState | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = jsonObject(value);
  return normalizePluginDesiredState(parsed, invalidPersistedPluginState);
}

function repositoryBindingsFromJson(value: unknown): Agent["repositoryBindings"] {
  if (value === null || value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw new DependencyUnavailableError("Persisted Agent repository bindings are invalid.");
  }
  if (!validRepositoryBindingSelections(parsed)) {
    throw new DependencyUnavailableError("Persisted Agent repository bindings are invalid.");
  }
  return parsed;
}

function installationFromRow(row: PostgresRow): Readonly<Installation> {
  return immutableCopy({
    id: text(row, "id"),
    name: text(row, "name"),
    createdAt: timestamp(row, "created_at"),
  });
}

function namespaceFromRow(row: PostgresRow): Readonly<PersistedNamespace> {
  const status = text(row, "status");
  if (!["provisioning", "ready", "failed", "deleting"].includes(status)) {
    throw new DependencyUnavailableError("Persisted Namespace status is invalid.");
  }
  const deletedAt =
    row.deleted_at === null || row.deleted_at === undefined
      ? undefined
      : timestamp(row, "deleted_at");
  const existingNamespace = optionalText(row, "existing_namespace");
  return immutableCopy({
    id: text(row, "id"),
    name: text(row, "name"),
    ...(existingNamespace === undefined ? {} : { existingNamespace }),
    status: status as Namespace["status"],
    createdAt: timestamp(row, "created_at"),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  });
}

function presetFromRow(row: PostgresRow): Readonly<Preset> {
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    template: jsonObject(row.template) as Preset["template"],
    createdAt: timestamp(row, "created_at"),
  });
}

function agentMetadataFromRow(row: PostgresRow): Readonly<AgentMetadata> {
  const activeRevisionId = optionalText(row, "active_revision_id");

  const desiredRuntimeState = text(row, "desired_runtime_state");
  if (desiredRuntimeState !== "running" && desiredRuntimeState !== "stopped") {
    throw new DependencyUnavailableError("Persisted Agent desired runtime state is invalid.");
  }
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    configurationId: text(row, "configuration_id"),
    backendId: row.backend_id === null ? null : text(row, "backend_id"),
    executionMode: text(row, "execution_mode") as Agent["executionMode"],

    servicePrincipalId: text(row, "service_principal_id"),
    ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
    desiredRuntimeState,
    status: text(row, "status") as Agent["status"],
    createdAt: timestamp(row, "created_at"),
  });
}

function agentFromRow(row: PostgresRow, metadata = agentMetadataFromRow(row)): Readonly<Agent> {
  const repositoryBindings = configurationRead("repositoryBindings", () =>
    repositoryBindingsFromJson(row.repository_bindings),
  );
  const pluginApprovers = configurationRead("pluginApprovers", () =>
    pluginApproversFromJson(row.plugin_approvers),
  );
  let harnessAuth: Agent["harnessAuth"];
  try {
    harnessAuth = normalizeHarnessAuthBinding(row.harness_auth);
  } catch {
    throw new SavedConfigurationReadError(
      "harnessAuth",
      "Persisted Agent harness authentication is invalid.",
    );
  }
  const plugins = configurationRead("plugins", () => pluginStateFromJson(row.plugins));
  const credentialSources = configurationRead("credentialSources", () =>
    agentCredentialSourcesFromJson(row.credential_sources),
  );
  let repositoryAccess: Agent["repositoryAccess"];
  try {
    repositoryAccess = normalizedRepositoryAccess(
      row.repository_access == null ? undefined : jsonObject(row.repository_access),
      repositoryBindings,
    );
  } catch {
    throw new SavedConfigurationReadError(
      "repositoryAccess",
      "Persisted Agent repository access is invalid.",
    );
  }
  return immutableCopy({
    ...metadata,
    ...(plugins === undefined ? {} : { plugins }),
    ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
    ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
    ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
    harnessAuth,
    ...(credentialSources === undefined ? {} : { credentialSources }),
  });
}

function agentCredentialSourcesFromJson(
  value: unknown,
): readonly AgentCredentialSourceBinding[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        Object.keys(entry).length === 1 &&
        isNonEmptyString((entry as { sourceId?: unknown }).sourceId),
    )
  ) {
    throw new Error("Persisted Agent credential sources are invalid.");
  }
  return Object.freeze(value.map(({ sourceId }: { sourceId: string }) => ({ sourceId })));
}

function agentForBrowsingFromRow(row: PostgresRow): Readonly<AgentRead> {
  const metadata = agentMetadataFromRow(row);
  return browseSavedConfiguration(metadata, () => agentFromRow(row, metadata));
}

function serviceAccountFromRow(row: PostgresRow): Readonly<ServiceAccount> {
  const credential = row.credential as ServiceAccountCredential | null;
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    ...(credential === null ? {} : { credential }),
  });
}

function configurationFromRow(row: PostgresRow): Readonly<ConfigurationOwnership> {
  const secretBindings =
    row.secret_bindings === null || row.secret_bindings === undefined
      ? undefined
      : secretBindingsFromJson(row.secret_bindings, text(row, "namespace_id"));
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    kind: text(row, "kind") as ConfigurationOwnership["kind"],
    generation: Number(row.generation),
    ...(secretBindings === undefined ? {} : { secretBindings }),
    createdAt: timestamp(row, "created_at"),
  });
}

function secretFromRow(row: PostgresRow): Readonly<Secret> {
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    driverId: text(row, "driver_id"),
    backendRef: {
      namespaceName: text(row, "backend_namespace_name"),
      name: text(row, "backend_name"),
      key: text(row, "backend_key"),
      uid: text(row, "backend_uid"),
    },
    createdAt: timestamp(row, "created_at"),
  });
}

const CREDENTIAL_SOURCE_COLUMNS = `cs.id, cs.namespace_id, cs.name, cs.type, cs.config,
  cs.driver_id, cs.state, cs.created_at,
  COALESCE((
    SELECT jsonb_object_agg(css.field, css.secret_id)
    FROM occ.credential_source_secrets AS css
    WHERE css.credential_source_id = cs.id
  ), '{}'::jsonb) AS secret_ids`;

const CREDENTIAL_WITHDRAWAL_COLUMNS = `namespace_id, agent_id, revision_id, credential_source_id,
  state, requested_by, requested_at, completed_at, last_reason, last_attempt_at`;

function credentialWithdrawalFromRow(row: PostgresRow): Readonly<CredentialWithdrawal> {
  const state = text(row, "state");
  if (state !== "pending" && state !== "revoked") {
    throw new DependencyUnavailableError("Persisted credential withdrawal state is invalid.");
  }
  const completedAt = row.completed_at === null ? undefined : timestamp(row, "completed_at");
  const lastReason = optionalText(row, "last_reason");
  const lastAttemptAt =
    row.last_attempt_at === null ? undefined : timestamp(row, "last_attempt_at");
  return Object.freeze({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revisionId: text(row, "revision_id"),
    credentialSourceId: text(row, "credential_source_id"),
    state,
    requestedBy: text(row, "requested_by"),
    requestedAt: timestamp(row, "requested_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(lastReason === undefined ? {} : { lastReason }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
  });
}

function credentialSourceFromRow(row: PostgresRow): Readonly<CredentialSource> {
  const namespaceId = text(row, "namespace_id");
  const state = text(row, "state");
  if (state !== "registering" && state !== "ready" && state !== "deleting") {
    throw new DependencyUnavailableError("Persisted credential source state is invalid.");
  }
  const config = jsonObject(row.config);
  const secretIds = jsonObject(row.secret_ids);
  if (
    Object.values(config).some((value) => typeof value !== "string") ||
    Object.values(secretIds).some((value) => typeof value !== "string")
  ) {
    throw new DependencyUnavailableError("Persisted credential source metadata is invalid.");
  }
  return immutableCopy({
    id: text(row, "id"),
    namespaceId,
    name: text(row, "name"),
    type: text(row, "type"),
    config: config as Record<string, string>,
    secrets: Object.fromEntries(
      Object.entries(secretIds as Record<string, string>).map(([field, id]) => [
        field,
        { kind: "secret" as const, namespaceId, id },
      ]),
    ),
    driverId: text(row, "driver_id"),
    state,
    createdAt: timestamp(row, "created_at"),
  });
}

function revisionMetadataFromRow(row: PostgresRow): Readonly<AgentRevisionMetadata> {
  const rawNumber = row.revision_number;
  const revision = typeof rawNumber === "string" ? Number(rawNumber) : rawNumber;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new DependencyUnavailableError("Persisted AgentRevision numbering is invalid.");
  }
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revision,
    backendId: row.backend_id === null ? null : text(row, "backend_id"),
    createdAt: timestamp(row, "admitted_at"),
  });
}

function revisionFromRow(
  row: PostgresRow,
  metadata = revisionMetadataFromRow(row),
): Readonly<AgentRevision> {
  const admitted = configurationRead("configuration", () => jsonObject(row.admitted_spec)) as {
    configuration_id: AgentRevision["configurationId"];
    configuration_kind: AgentRevision["configurationKind"];
    configuration_generation: AgentRevision["configurationGeneration"];
    draft_spec: AgentRevision["configuration"];
    harness: AgentRevision["harness"];
    compute: AgentRevision["compute"];
    sandbox_driver_id?: AgentRevision["sandboxDriverId"];
    harness_auth: AgentRevision["harnessAuth"];
    credential_sources?: AgentRevision["credentialSources"];
    secret_driver_id?: AgentRevision["secretDriverId"];
    secret_bindings?: AgentRevision["secretBindings"];
    plugins?: AgentRevision["plugins"];
    plugin_approvers?: AgentRevision["pluginApprovers"];
    repository_credentials?: AgentRevision["repositoryCredentials"];
  };
  if (
    Object.hasOwn(admitted, "service_account") ||
    !validHarnessAuthSnapshot(admitted.harness_auth, text(row, "namespace_id"))
  ) {
    throw new SavedConfigurationReadError(
      "harnessAuth",
      "Persisted AgentRevision harness authentication is invalid or legacy.",
    );
  }
  if (!validCredentialSourceSnapshots(admitted.credential_sources)) {
    throw new SavedConfigurationReadError(
      "credentialSources",
      "Persisted AgentRevision credential sources are invalid.",
    );
  }
  const secretBindings =
    admitted.secret_bindings === undefined
      ? undefined
      : configurationRead("secretBindings", () =>
          secretBindingsFromJson(admitted.secret_bindings, metadata.namespaceId),
        );
  if (!validPluginRevisionState(admitted.plugins)) {
    throw new SavedConfigurationReadError(
      "plugins",
      "Persisted AgentRevision plugin state is invalid.",
    );
  }
  if (!validPluginApprovers(admitted.plugin_approvers)) {
    throw new SavedConfigurationReadError(
      "pluginApprovers",
      "Persisted AgentRevision plugin approvers are invalid.",
    );
  }
  if (
    admitted.repository_credentials !== undefined &&
    !validRepositoryRevisionState(admitted.repository_credentials)
  ) {
    throw new SavedConfigurationReadError(
      "repositoryCredentials",
      "Persisted AgentRevision repository credentials are invalid.",
    );
  }
  return immutableCopy({
    ...metadata,
    configurationId: admitted.configuration_id,
    configurationKind: admitted.configuration_kind,
    configurationGeneration: admitted.configuration_generation,
    configuration: admitted.draft_spec,
    harness: admitted.harness,
    compute: admitted.compute,
    ...(admitted.sandbox_driver_id === undefined
      ? {}
      : { sandboxDriverId: admitted.sandbox_driver_id }),
    ...(admitted.secret_driver_id === undefined
      ? {}
      : { secretDriverId: admitted.secret_driver_id }),
    ...(secretBindings === undefined ? {} : { secretBindings }),
    ...(admitted.plugins === undefined ? {} : { plugins: admitted.plugins }),
    ...(admitted.plugin_approvers === undefined
      ? {}
      : { pluginApprovers: admitted.plugin_approvers }),
    ...(admitted.repository_credentials === undefined
      ? {}
      : { repositoryCredentials: admitted.repository_credentials }),
    harnessAuth: admitted.harness_auth,
    ...(admitted.credential_sources === undefined
      ? {}
      : { credentialSources: admitted.credential_sources }),
    servicePrincipalId: text(row, "service_principal_id"),
  });
}

function revisionForBrowsingFromRow(row: PostgresRow): Readonly<AgentRevisionRead> {
  const metadata = revisionMetadataFromRow(row);
  return browseSavedConfiguration(metadata, () => revisionFromRow(row, metadata));
}

function secretBindingsFromJson(value: unknown, namespaceId: string): SecretBindings | undefined {
  if (!NAMESPACE_IDENTIFIER.test(namespaceId)) {
    throw new DependencyUnavailableError("Persisted Secret bindings have an invalid Namespace.");
  }
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  let normalized: SecretBindings;
  try {
    normalized = normalizeSecretBindings(parsed);
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  for (const { source } of Object.values(normalized)) {
    if (source.namespaceId !== namespaceId || !SECRET_IDENTIFIER.test(source.id)) {
      throw new DependencyUnavailableError("Persisted Secret bindings reference invalid Secrets.");
    }
  }
  return Object.keys(normalized).length === 0 ? undefined : immutableCopy(normalized);
}

function secretBindingsFromState(
  value: SecretBindings,
  namespaceId: string,
): SecretBindings | undefined {
  try {
    return secretBindingsFromJson(value, namespaceId);
  } catch (error) {
    if (error instanceof DependencyUnavailableError) {
      throw new ScopeViolationError("Secret bindings are invalid.");
    }
    throw error;
  }
}

function serializeSecretBindings(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): string | null {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  return normalized === undefined ? null : JSON.stringify(normalized);
}

function referencedSecretIds(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): readonly string[] {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  if (normalized === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Array.from(new Set(Object.values(normalized).map(({ source }) => source.id))),
  );
}

/**
 * Unique constraints on caller-chosen names, mapped to the duplicate-name text the memory
 * store also raises. Identity (id) collisions stay generic. The caller was already authorized
 * to create (or rename) that resource kind in that scope, and the 409 alone reveals that the
 * name is taken, so naming the kind discloses nothing new.
 */
const NAME_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  agents_namespace_id_name_unique: AGENT_NAME_CONFLICT,
  secrets_namespace_id_name_unique: SECRET_NAME_CONFLICT,
  presets_namespace_id_name_unique: PRESET_NAME_CONFLICT,
  service_accounts_namespace_id_name_unique: SERVICE_ACCOUNT_NAME_CONFLICT,
  credential_sources_namespace_id_name_unique: CREDENTIAL_SOURCE_NAME_CONFLICT,
  // The inline `name ... UNIQUE` on occ.namespaces (0000_occ_initial.sql) gets this default name.
  namespaces_name_key: NAMESPACE_NAME_CONFLICT,
});

function databaseError(error: unknown): Error {
  if (
    error instanceof ScopeViolationError ||
    error instanceof DependencyUnavailableError ||
    !(error instanceof Error)
  ) {
    return error instanceof Error
      ? error
      : new DependencyUnavailableError("The platform persistence repository is unavailable.");
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "23505") {
    const constraint =
      "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
    const nameConflict =
      constraint !== undefined && Object.hasOwn(NAME_CONFLICTS, constraint)
        ? NAME_CONFLICTS[constraint]
        : undefined;
    if (nameConflict !== undefined) {
      return new ResourceStateConflictError(nameConflict);
    }
    return new ResourceConflictError(
      "A platform resource with this identity or name already exists.",
    );
  }
  if (
    code === "23001" ||
    code === "23503" ||
    code === "23514" ||
    code === "23502" ||
    code === "55000"
  ) {
    return new ScopeViolationError("The resource violates its exact platform ownership or state.");
  }
  if (code === "55P03") {
    // A lock timeout is transient contention, retryable like a statement timeout (57014).
    return new DependencyUnavailableError("The platform persistence lock timeout expired.");
  }
  if (code === "40001" || code === "40P01") {
    // A serialization failure or deadlock aborts the whole transaction before
    // COMMIT (see commitOutcomeUnknown), so the caller can safely retry it.
    return new DependencyUnavailableError(
      "The platform persistence transaction conflicted with a concurrent transaction.",
    );
  }
  if (
    code?.startsWith("08") ||
    code?.startsWith("53") ||
    code?.startsWith("57") ||
    code === "3D000" ||
    code === "3F000" ||
    code === "42P01" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  ) {
    return new DependencyUnavailableError("The platform persistence repository is unavailable.");
  }
  return error;
}

/**
 * pg's client-side `query_timeout` rejects with this code-less error and leaves the statement
 * running on the connection, so anything queued after it would wait for it. The message comes
 * from pg/lib/client.js (`query_timeout` handling); recheck it when upgrading pg.
 */
function queryAbandonedByClient(error: unknown): boolean {
  return error instanceof Error && !("code" in error) && error.message === "Query read timeout";
}

function commitOutcomeUnknown(error: unknown): boolean {
  const code =
    error instanceof DatabaseError && typeof error.code === "string" ? error.code : undefined;
  // Only server responses that establish transaction rejection prove no commit.
  // 40003 and arbitrary SQLSTATEs retain the possibly committed outcome.
  return !(
    code !== undefined &&
    (/^23[0-9A-Z]{3}$/.test(code) || code === "40001" || code === "40P01" || code === "25P02")
  );
}

function auditDetails(event: AuditEvent): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = { ...(event.details ?? {}) };
  if (AUDIT_METADATA_KEY in details) {
    throw new ScopeViolationError("The audit details contain reserved persistence metadata.");
  }

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion",
    "source",
    "requestId",
    "admissionDecisionId",
    "actor",
    "iamDriverId",
    "authorization",
    "decisionReason",
    "reasonCode",
  ] as const) {
    const value = event[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  if (Object.keys(metadata).length > 0) {
    details[AUDIT_METADATA_KEY] = metadata;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function auditFromRow(row: PostgresRow, installationId: string): Readonly<AuditEvent> {
  const namespaceId = optionalText(row, "namespace_id");
  const resourceKind = text(row, "resource_kind");
  const outcome = text(row, "outcome");
  const kind = text(row, "kind");
  if (
    !RESOURCE_KINDS.has(resourceKind) ||
    !["success", "denied", "failure"].includes(outcome) ||
    !["bootstrap", "mutation", "access", "authorization_denial"].includes(kind)
  ) {
    throw new DependencyUnavailableError("Persisted audit evidence contains an invalid event.");
  }

  const rawDetails = row.details === null ? undefined : jsonObject(row.details);
  const details = rawDetails === undefined ? undefined : { ...rawDetails };
  const rawMetadata = details?.[AUDIT_METADATA_KEY];
  if (details !== undefined) {
    delete details[AUDIT_METADATA_KEY];
  }
  const storedMetadata = rawMetadata === undefined ? {} : jsonObject(rawMetadata);
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion",
    "source",
    "requestId",
    "admissionDecisionId",
    "actor",
    "iamDriverId",
    "authorization",
    "decisionReason",
    "reasonCode",
  ] as const) {
    if (Object.hasOwn(storedMetadata, key)) {
      metadata[key] = storedMetadata[key];
    }
  }

  return immutableCopy({
    id: text(row, "id"),
    installationId,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    occurredAt: timestamp(row, "occurred_at"),
    kind: kind as AuditEvent["kind"],
    actorId: text(row, "actor_id"),
    action: text(row, "action"),
    resource: {
      kind: resourceKind as AuditEvent["resource"]["kind"],
      id: text(row, "resource_id"),
      ...(namespaceId === undefined ? {} : { namespaceId }),
    },
    outcome: outcome as AuditEvent["outcome"],
    ...metadata,
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
  });
}

function timestampDate(row: PostgresRow, key: string): Date {
  return new Date(timestamp(row, key));
}

function provisioningRecordFromRow(row: PostgresRow): Readonly<AgentProvisioningRecord> {
  const status = text(row, "status");
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "failed" &&
    status !== "succeeded" &&
    status !== "cancelled"
  ) {
    throw new DependencyUnavailableError("Persisted Agent provisioning status is invalid.");
  }
  const completedPhase = text(row, "completed_phase");
  if (
    completedPhase !== "admitted" &&
    completedPhase !== "configuration" &&
    completedPhase !== "transport" &&
    completedPhase !== "handoff"
  ) {
    throw new DependencyUnavailableError("Persisted Agent provisioning phase is invalid.");
  }
  const agentId = optionalText(row, "agent_id");
  const configurationId = optionalText(row, "configuration_id");
  return copyProvisioningRecord({
    workId: text(row, "work_id"),
    namespaceId: text(row, "namespace_id"),
    ...(agentId === undefined ? {} : { agentId }),
    ...(configurationId === undefined ? {} : { configurationId }),
    actorId: text(row, "actor_id"),
    requestId: text(row, "request_id"),
    requestFingerprint: text(row, "request_fingerprint"),
    status,
    completedPhase,
    ...(row.revision_id === null || row.revision_id === undefined
      ? {}
      : { revisionId: text(row, "revision_id") }),
    plan: jsonObject(row.plan),
    progress: jsonObject(row.progress),
    createdAt: timestampDate(row, "created_at"),
    updatedAt: timestampDate(row, "updated_at"),
  });
}

function pendingEffect(value: Readonly<Record<string, unknown>>): unknown {
  return value.pendingEffect;
}

function effectReceipt(value: Readonly<Record<string, unknown>>): unknown {
  return value.effectReceipt;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function pendingEffectMatchesReceipt(progress: Readonly<Record<string, unknown>>): boolean {
  const pending = recordValue(pendingEffect(progress));
  const receipt = recordValue(effectReceipt(progress));
  if (pending === undefined || receipt === undefined) {
    return false;
  }
  return (
    (pending.kind === "configuration" || pending.kind === "transport") &&
    typeof pending.owner === "string" &&
    pending.owner.length > 0 &&
    typeof pending.targetId === "string" &&
    pending.targetId.length > 0 &&
    pending.kind === receipt.kind &&
    pending.owner === receipt.owner &&
    pending.targetId === receipt.targetId
  );
}

function pendingEffectChanged(
  current: Readonly<Record<string, unknown>>,
  next: AgentProvisioningCheckpoint,
): boolean {
  if (next.progress === undefined) {
    return false;
  }
  const currentPending = pendingEffect(current);
  const nextPending = pendingEffect(next.progress);
  if (currentPending !== undefined && nextPending === undefined) {
    return !pendingEffectMatchesReceipt(current);
  }
  return (
    currentPending !== undefined &&
    nextPending !== undefined &&
    !isDeepStrictEqual(currentPending, nextPending)
  );
}

function validateProvisioningProgressStep(
  current: Readonly<AgentProvisioningRecord>,
  next: AgentProvisioningCheckpoint,
): void {
  if (!phaseAtLeast(next.completedPhase, current.completedPhase)) {
    throw new ScopeViolationError("Agent provisioning checkpoints cannot move backward.");
  }
  if (pendingEffectChanged(current.progress, next)) {
    throw new ScopeViolationError("Agent provisioning pending effects cannot be replaced.");
  }
}

function restrictionFromRow(row: PostgresRow): Readonly<Restriction> {
  const namespaceId = optionalText(row, "namespace_id");
  const action = text(row, "action");
  const resourceKind = text(row, "resource_kind");
  const resourceId = optionalText(row, "resource_id");
  if (
    !PERMISSION_ACTIONS.has(action) ||
    !RESOURCE_KINDS.has(resourceKind) ||
    text(row, "effect") !== "deny"
  ) {
    throw new DependencyUnavailableError("Persisted IAM restriction is invalid.");
  }
  return immutableCopy({
    id: text(row, "id"),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    action: action as Restriction["action"],
    resourceKind: resourceKind as Restriction["resourceKind"],
    ...(resourceId === undefined ? {} : { resourceId }),
    effect: "deny" as const,
  });
}

function permissions(value: unknown): readonly Permission[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) {
    throw new DependencyUnavailableError("Persisted IAM permissions must be an array.");
  }
  return Object.freeze(
    parsed.map((permission): Permission => {
      if (
        permission === null ||
        typeof permission !== "object" ||
        typeof permission.action !== "string" ||
        !PERMISSION_ACTIONS.has(permission.action) ||
        typeof permission.resourceKind !== "string" ||
        !RESOURCE_KINDS.has(permission.resourceKind)
      ) {
        throw new DependencyUnavailableError("Persisted IAM permissions are invalid.");
      }
      return immutableCopy({
        action: permission.action as Permission["action"],
        resourceKind: permission.resourceKind as Permission["resourceKind"],
      });
    }),
  );
}

export class PostgresPlatformState implements PlatformStateStore {
  readonly auditSink: PlatformAuditSink;
  private readonly pool: PostgresPool;
  private readonly queueOptions: PostgresWorkQueueOptions;
  private bootstrapNativeIAM: PersistedNativeIAMState | undefined;
  private readonly contexts = new WeakMap<PlatformUnitOfWork, TransactionContext>();
  private readonly currentTransaction = new AsyncLocalStorage<TransactionContext>();

  constructor(pool: PostgresPool, options: PostgresPlatformStateOptions = {}) {
    this.pool = pool;
    this.queueOptions = Object.freeze({ ...(options.workQueue ?? {}) });
    this.bootstrapNativeIAM = options.bootstrapNativeIAM;
    this.auditSink = {
      append: async (event) => this.transact(async (state) => state.audit.append(event)),
    };
  }

  setBootstrapNativeIAM(state: PersistedNativeIAMState): void {
    this.bootstrapNativeIAM = state;
  }

  async loadInstallation(): Promise<Readonly<Installation> | undefined> {
    return this.read(async (state) => state.installations.getInstallation());
  }

  async loadNativeIAMState(installationId?: string): Promise<PersistedNativeIAMState> {
    const current = this.currentTransaction.getStore();
    if (current !== undefined) {
      // The selected Driver must observe policy on the same unit as its caller's
      // mutation and audit. An escaped callback retains a closed lifetime and
      // cannot silently acquire a new client after the original operation ends.
      return current.lifetime.run(() => this.readNativeIAMState(current, installationId));
    }
    return this.execute(true, async (_state, context) => {
      const installation = await this.currentInstallation(context);
      if (installation === undefined && this.bootstrapNativeIAM !== undefined) {
        return this.bootstrapNativeIAM;
      }
      return this.readNativeIAMState(context, installationId);
    });
  }

  /**
   * Read all six policy collections on the original unit in one statement.
   * This snapshot is not an authority fence; the caller must order all
   * participating invalidators through the selected writer protocol.
   */
  async loadNativeIAMStateInTransaction(
    unit: PlatformUnitOfWork,
    installationId?: string,
  ): Promise<PersistedNativeIAMState> {
    const context = this.contexts.get(unit);
    if (context === undefined) {
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    }
    return context.lifetime.run(() => this.readNativeIAMState(context, installationId));
  }

  private async readNativeIAMState(
    context: TransactionContext,
    installationId?: string,
  ): Promise<PersistedNativeIAMState> {
    const installation = await this.currentInstallation(context);
    if (installation === undefined) {
      throw new DependencyUnavailableError("The platform Installation has not been initialized.");
    }
    if (installationId !== undefined && installation.id !== installationId) {
      throw new ScopeViolationError("IAM state belongs to another Installation.");
    }

    // One statement gives the borrowed READ COMMITTED unit one policy snapshot.
    const [snapshot] = rows(
      (
        await context.client.query(`SELECT
        COALESCE((SELECT jsonb_agg(v ORDER BY id) FROM
          (SELECT id, namespace_id, agent_id, kind, issuer, subject FROM occ.iam_identities) v),
          '[]'::jsonb) AS identities,
        COALESCE((SELECT jsonb_agg(v ORDER BY id) FROM
          (SELECT id, namespace_id, name, permissions FROM occ.iam_roles) v),
          '[]'::jsonb) AS roles,
        COALESCE((SELECT jsonb_agg(v ORDER BY id) FROM
          (SELECT id, namespace_id, name FROM occ.iam_groups) v),
          '[]'::jsonb) AS groups,
        COALESCE((SELECT jsonb_agg(v ORDER BY group_id, principal_id) FROM
          (SELECT namespace_id, group_id, principal_id FROM occ.iam_group_memberships) v),
          '[]'::jsonb) AS memberships,
        COALESCE((SELECT jsonb_agg(v ORDER BY id) FROM
          (SELECT id, namespace_id, identity_subject_id, group_subject_id, role_id,
            resource_kind, resource_id FROM occ.iam_access_bindings) v),
          '[]'::jsonb) AS bindings,
        COALESCE((SELECT jsonb_agg(v ORDER BY id) FROM
          (SELECT id, namespace_id, action, resource_kind, resource_id, effect
            FROM occ.iam_restrictions) v), '[]'::jsonb) AS restrictions`)
      ).rows,
    );
    const collection = (key: keyof PersistedNativeIAMState): PostgresRow[] => {
      const value = snapshot?.[key];
      if (!Array.isArray(value)) {
        throw new DependencyUnavailableError("Persisted IAM collections are invalid.");
      }
      return rows(value);
    };
    const identityRows = collection("identities");
    const roleRows = collection("roles");
    const groupRows = collection("groups");
    const membershipRows = collection("memberships");
    const bindingRows = collection("bindings");
    const restrictionRows = collection("restrictions");

    const identities = identityRows.map((row): Identity => {
      const id = text(row, "id");
      const kind = text(row, "kind");
      const namespaceId = optionalText(row, "namespace_id");
      if (kind === "principal") {
        return immutableCopy({
          id,
          kind,
          issuer: text(row, "issuer"),
          subject: text(row, "subject"),
        });
      }
      if (kind === "service_principal") {
        const agentId = optionalText(row, "agent_id");
        if (agentId !== undefined && namespaceId === undefined) {
          throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
        }
        return immutableCopy({
          id,
          kind,
          ...(namespaceId === undefined ? {} : { namespaceId }),
          ...(agentId === undefined ? {} : { agentId }),
        });
      }
      throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
    });

    const roles = roleRows.map((row): Role => {
      const namespaceId = optionalText(row, "namespace_id");
      const name = optionalText(row, "name");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        ...(name === undefined ? {} : { name }),
        permissions: permissions(row.permissions),
      });
    });

    const groups = groupRows.map((row): Group => {
      const namespaceId = optionalText(row, "namespace_id");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        name: text(row, "name"),
      });
    });

    const memberships = membershipRows.map((row): GroupMembership => {
      const namespaceId = optionalText(row, "namespace_id");
      return immutableCopy({
        ...(namespaceId === undefined ? {} : { namespaceId }),
        groupId: text(row, "group_id"),
        principalId: text(row, "principal_id"),
      });
    });

    const bindings = bindingRows.map((row): AccessBinding => {
      const namespaceId = optionalText(row, "namespace_id");
      const resourceKind = optionalText(row, "resource_kind");
      const resourceId = optionalText(row, "resource_id");
      if (
        (resourceKind === undefined) !== (resourceId === undefined) ||
        (resourceKind !== undefined && !RESOURCE_KINDS.has(resourceKind))
      ) {
        throw new DependencyUnavailableError("Persisted IAM binding has an invalid resource.");
      }
      const identitySubjectId = optionalText(row, "identity_subject_id");
      const groupSubjectId = optionalText(row, "group_subject_id");
      if ((identitySubjectId === undefined) === (groupSubjectId === undefined)) {
        throw new DependencyUnavailableError("Persisted IAM binding has an ambiguous subject.");
      }
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        subjectKind: identitySubjectId === undefined ? "group" : "identity",
        subjectId: identitySubjectId ?? groupSubjectId!,
        roleId: text(row, "role_id"),
        ...(resourceKind === undefined
          ? {}
          : { resourceKind: resourceKind as NonNullable<AccessBinding["resourceKind"]> }),
        ...(resourceId === undefined ? {} : { resourceId }),
      });
    });

    const restrictions = restrictionRows.map(restrictionFromRow);

    const state = { identities, groups, memberships, roles, bindings, restrictions };
    this.validateIAMState(state, true);
    return immutableCopy(state);
  }

  async seedNativeIAM(state: PersistedNativeIAMState): Promise<void> {
    return this.transact(async (unit) => {
      const context = this.contexts.get(unit);
      if (context === undefined) {
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      }
      const installation = await this.currentInstallation(context);
      if (installation === undefined) {
        throw new ScopeViolationError("IAM state requires an initialized Installation.");
      }
      await this.insertIAMState(context, state);
    });
  }

  async appendNativeIAMPrincipal(
    seed: PersistedNativeIAMPrincipalSeed,
    auditEvent?: AuditEvent,
  ): Promise<PersistedNativeIAMState> {
    let installationId: string | undefined;
    await this.transact(async (unit) => {
      installationId = await this.insertNativeIAMPrincipal(unit, seed);
      if (auditEvent !== undefined) {
        await unit.audit.append(auditEvent);
      }
    });
    return this.loadNativeIAMState(installationId);
  }

  /** Inserts one account Principal and its exact Installation bindings in the caller's transaction. */
  async insertNativeIAMPrincipal(
    unit: PlatformUnitOfWork,
    seed: PersistedNativeIAMPrincipalSeed,
  ): Promise<string> {
    const context = this.contexts.get(unit);
    if (context === undefined) {
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    }
    const installation = await this.currentInstallation(context);
    if (installation === undefined) {
      throw new ScopeViolationError("IAM state requires an initialized Installation.");
    }
    if (seed.roles.length > 0) {
      throw new ScopeViolationError("Account provisioning must bind an existing IAM Role.");
    }
    for (const binding of seed.bindings) {
      if (
        binding.subjectKind !== "identity" ||
        binding.subjectId !== seed.principal.id ||
        binding.resourceKind !== "installation" ||
        binding.resourceId !== installation.id ||
        binding.namespaceId !== undefined
      ) {
        throw new ScopeViolationError(
          "Account provisioning requires an exact Installation binding.",
        );
      }
    }
    await context.client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        seed.principal.id,
        null,
        null,
        seed.principal.kind,
        seed.principal.issuer,
        seed.principal.subject,
      ],
    );
    for (const binding of seed.bindings) {
      await context.client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id,
          resource_kind, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          binding.id,
          null,
          binding.subjectId,
          null,
          binding.roleId,
          binding.resourceKind,
          binding.resourceId,
        ],
      );
    }
    return installation.id;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    return this.execute(true, async (state, context) =>
      work(createPlatformReadView(state, context.lifetime)),
    );
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.execute(false, async (state) => work(state));
  }

  /**
   * Run one read-only statement on a pooled connection outside any transaction (one round
   * trip, no BEGIN/COMMIT). Only for a single SELECT that needs no snapshot shared with
   * other statements, locks nothing and writes nothing.
   */
  async readStatement(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<readonly PostgresRow[]> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw error instanceof ScopeViolationError || error instanceof DependencyUnavailableError
        ? error
        : new DependencyUnavailableError("The platform persistence repository is unavailable.");
    }
    let transportError: Error | undefined;
    const onTransportError = (error: Error) => {
      transportError ??= error;
    };
    let discard = false;
    try {
      client.on?.("error", onTransportError);
      const result = await client.query(statement, parameters);
      if (transportError !== undefined) {
        throw transportError;
      }
      return rows(result.rows);
    } catch (error) {
      discard = true;
      if (transportError !== undefined) {
        throw new DependencyUnavailableError("The platform persistence repository is unavailable.");
      }
      throw databaseError(error);
    } finally {
      try {
        client.release(discard || transportError !== undefined);
      } catch {
        // The statement's outcome stands; a failed release only loses the connection.
      }
      try {
        client.removeListener?.("error", onTransportError);
      } catch {
        // As above.
      }
    }
  }

  /**
   * Hold Installation authority for the original transaction. Participants
   * must await the complete protected operation and take write intent before
   * acquiring account, policy, or resource locks.
   */
  async transactWithNativeIAMAuthority<T>(
    installationId: string,
    intent: "read" | "write",
    work: (state: PlatformUnitOfWork) => Promise<T>,
  ): Promise<T> {
    if (
      typeof installationId !== "string" ||
      installationId.length === 0 ||
      (intent !== "read" && intent !== "write")
    ) {
      throw new ScopeViolationError("The Installation authority request is invalid.");
    }
    return this.execute(
      false,
      async (state, context) => {
        const statement =
          intent === "read"
            ? "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))"
            : "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))";
        // Respect a stricter caller limit and bound authority acquisition.
        const timeout = await context.client.query(
          "SELECT setting FROM pg_catalog.pg_settings WHERE name = 'lock_timeout'",
        );
        const previousLockTimeout = text(rows(timeout.rows)[0] ?? {}, "setting");
        await context.client.query(
          `SELECT pg_catalog.set_config('lock_timeout',
             CASE WHEN $1::integer = 0 THEN '5000'
                  ELSE LEAST($1::integer, 5000)::text END, true)`,
          [previousLockTimeout],
        );
        await context.client.query(statement, [`native-account-security-v1:${installationId}`]);
        await context.client.query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [
          previousLockTimeout,
        ]);
        await this.requireInstallation(context, installationId);
        return work(state);
      },
      true,
    );
  }

  queryInTransaction(
    unit: PlatformUnitOfWork,
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    const context = this.contexts.get(unit);
    if (context === undefined) {
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    }
    return context.lifetime.run(() => context.client.query(statement, parameters));
  }

  /**
   * Hold the native IAM policy barrier on the original unit. The SQL supplier
   * verifies the preheld Installation authority. Account and session writers
   * must participate separately in the same authority protocol.
   */
  async guardNativeIAMPolicyInTransaction(
    unit: PlatformUnitOfWork,
    installationId: string,
    intent: "read" | "write",
  ): Promise<void> {
    if (
      typeof installationId !== "string" ||
      installationId.length === 0 ||
      (intent !== "read" && intent !== "write")
    ) {
      throw new ScopeViolationError("The native IAM policy barrier request is invalid.");
    }
    const context = this.contexts.get(unit);
    if (context === undefined) {
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    }
    await context.lifetime.run(async () => {
      await context.client.query("SELECT occ.native_iam_policy_barrier($1, $2)", [
        installationId,
        intent === "write",
      ]);
    });
  }

  async transactWithQueue<T>(
    work: (
      state: PlatformUnitOfWork,
      queue: Pick<PostgresWorkQueue, keyof PostgresWorkQueue>,
    ) => Promise<T>,
    options: PostgresWorkQueueOptions = {},
  ): Promise<T> {
    const queueOptions = { ...this.queueOptions, ...options };
    return this.execute(false, async (state, context) =>
      work(state, this.bindQueue(context, queueOptions)),
    );
  }

  /**
   * Acquire write authority and the IAM barrier before exposing either
   * repository. Other transactions still need to participate explicitly.
   */
  async transactWithNativeIAMPolicyQueue<T>(
    installationId: string,
    work: (
      state: PlatformUnitOfWork,
      queue: Pick<PostgresWorkQueue, keyof PostgresWorkQueue>,
    ) => Promise<T>,
    options: PostgresWorkQueueOptions = {},
  ): Promise<T> {
    const queueOptions = { ...this.queueOptions, ...options };
    return this.transactWithNativeIAMAuthority(installationId, "write", async (state) => {
      await this.guardNativeIAMPolicyInTransaction(state, installationId, "write");
      const context = this.contexts.get(state);
      if (context === undefined) {
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      }
      return work(state, this.bindQueue(context, queueOptions));
    });
  }

  private bindQueue(
    context: TransactionContext,
    options: PostgresWorkQueueOptions,
  ): Pick<PostgresWorkQueue, keyof PostgresWorkQueue> {
    return bindRepository(new PostgresWorkQueue(context.client, options), context.lifetime, [
      "enqueue",
      "enqueueRepositoryCleanup",
      "claim",
      "heartbeat",
      "pending",
      "claimableWorkWaiting",
      "complete",
      "completeAgentDeletion",
      "defer",
      "retry",
      "fail",
      "recoverStale",
      "findWork",
      "findWorkAttempt",
    ]);
  }

  private async execute<T>(
    readOnly: boolean,
    work: (state: PlatformUnitOfWork, context: TransactionContext) => Promise<T>,
    readCommitted = false,
  ): Promise<T> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      // No statement has run yet, so any checkout failure (DNS, routing, TLS,
      // credentials or a password callback) is unavailability, not a server verdict.
      throw error instanceof ScopeViolationError || error instanceof DependencyUnavailableError
        ? error
        : new DependencyUnavailableError("The platform persistence repository is unavailable.");
    }

    // Checked-out pg clients emit transport errors independently of query rejection.
    // The transaction owner retains the event through release; repository callers
    // still receive the original query failure or the exact unknown-COMMIT outcome.
    let transportError: Error | undefined;
    const onTransportError = (error: Error) => {
      transportError ??= error;
    };
    const lifetime = new RepositoryTransactionLifetime();
    let started = false;
    let committing = false;
    let acknowledged = false;
    let failed = false;
    let discard = false;
    // A statement the client abandoned (query_timeout) may still run on this connection;
    // a ROLLBACK would only queue behind it, so the connection is discarded instead.
    let abandoned = false;
    let unit: PlatformUnitOfWork | undefined;
    try {
      try {
        client.on?.("error", onTransportError);
      } catch (error) {
        discard = true;
        throw error;
      }
      if (transportError !== undefined) {
        throw transportError;
      }
      try {
        await client.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : readCommitted
              ? "BEGIN ISOLATION LEVEL READ COMMITTED"
              : "BEGIN",
        );
      } catch (error) {
        // A BEGIN abandoned by a client query timeout may still be in flight on this
        // connection; every later statement would queue behind it. Never reuse it.
        discard = true;
        throw error;
      }
      started = true;
      if (transportError !== undefined) {
        throw transportError;
      }
      const context: TransactionContext = {
        lifetime,
        client: {
          query: async (statement, parameters) => {
            lifetime.assertActive();
            if (transportError !== undefined) {
              throw transportError;
            }
            let result: Awaited<ReturnType<PostgresClient["query"]>>;
            try {
              result = await client.query(statement, parameters);
            } catch (error) {
              abandoned ||= queryAbandonedByClient(error);
              throw error;
            }
            lifetime.assertActive();
            if (transportError !== undefined) {
              throw transportError;
            }
            return result;
          },
          release: () => {
            throw new ScopeViolationError("Only the transaction owner releases the client.");
          },
        },
        installation: undefined,
        installationLoaded: false,
      };
      const activeUnit = bindPlatformUnitOfWork(this.repositories(context), lifetime);
      unit = activeUnit;
      this.contexts.set(activeUnit, context);
      const result = await this.currentTransaction.run(context, () => work(activeUnit, context));
      await lifetime.finish();
      if (transportError) {
        throw transportError;
      }
      committing = true;
      let completion: unknown;
      try {
        completion = await client.query("COMMIT");
      } catch (error) {
        if (transportError !== undefined || commitOutcomeUnknown(error)) {
          throw new PostgresCommitOutcomeUnknownError();
        }
        committing = false;
        throw error;
      }
      if (transportError !== undefined) {
        throw new PostgresCommitOutcomeUnknownError();
      }
      // Inspect acknowledgment separately: a throwing projection is not a server
      // rejection, even if its exception happens to contain a SQLSTATE.
      const command = (completion as { command?: unknown } | null)?.command;
      if (command === "ROLLBACK") {
        committing = false;
        started = false;
        throw new DependencyUnavailableError("The platform transaction was rolled back.");
      }
      if (command !== "COMMIT") {
        throw new PostgresCommitOutcomeUnknownError();
      }
      acknowledged = true;
      committing = false;
      started = false;
      return result;
    } catch (error) {
      failed = true;
      discard ||= committing || transportError !== undefined || abandoned;
      await lifetime.finish();
      // An uncertain COMMIT, broken transport or abandoned statement must not be queried again.
      if (started && !committing && transportError === undefined && !abandoned) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
      }
      if (committing) {
        if (error instanceof PostgresCommitOutcomeUnknownError) {
          throw error;
        }
        throw new PostgresCommitOutcomeUnknownError();
      }
      // An observed client error means the connection is broken, whatever code it
      // carries; classify it as unavailable rather than as a server verdict.
      if (transportError !== undefined && error === transportError) {
        throw new DependencyUnavailableError("The platform persistence repository is unavailable.");
      }
      throw databaseError(error);
    } finally {
      lifetime.close();
      if (unit !== undefined) {
        this.contexts.delete(unit);
      }
      let cleanupFailed = false;
      try {
        client.release(discard || transportError !== undefined);
      } catch {
        cleanupFailed = true;
      }
      try {
        client.removeListener?.("error", onTransportError);
      } catch {
        cleanupFailed = true;
      }
      // Preserve the original failure. A failure after acknowledged COMMIT can
      // never be reported as definite rollback or authorize an automatic replay.
      if (!failed && (cleanupFailed || transportError !== undefined) && acknowledged) {
        throw new PostgresCommitOutcomeUnknownError();
      }
    }
  }

  private async currentInstallation(
    context: TransactionContext,
  ): Promise<Readonly<Installation> | undefined> {
    if (!context.installationLoaded) {
      const candidates = rows(
        (
          await context.client.query(
            "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2",
          )
        ).rows,
      );
      if (candidates.length > 1) {
        throw new DependencyUnavailableError("The platform Installation is ambiguous.");
      }
      context.installation =
        candidates[0] === undefined ? undefined : installationFromRow(candidates[0]);
      context.installationLoaded = true;
    }
    return context.installation;
  }

  private async requireInitialized(context: TransactionContext): Promise<Readonly<Installation>> {
    const installation = await this.currentInstallation(context);
    if (installation === undefined) {
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    }
    return installation;
  }

  private async requireInstallation(
    context: TransactionContext,
    installationId: string,
  ): Promise<Readonly<Installation>> {
    const installation = await this.requireInitialized(context);
    if (installation.id !== installationId) {
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    }
    return installation;
  }

  private repositories(context: TransactionContext): PlatformUnitOfWork {
    const { client } = context;
    const queue = new PostgresWorkQueue(client, this.queueOptions);

    const installations: InstallationRepository = {
      findInstallation: async (installationId) => {
        const installation = await this.currentInstallation(context);
        return installation?.id === installationId ? immutableCopy(installation) : undefined;
      },
      getInstallation: async () => {
        const installation = await this.currentInstallation(context);
        return installation === undefined ? undefined : immutableCopy(installation);
      },
      createInstallation: async (installation) => {
        if ((await this.currentInstallation(context)) !== undefined) {
          throw new ResourceConflictError("An Installation has already been bootstrapped.");
        }
        await client.query(
          "INSERT INTO occ.installation (id, name, created_at) VALUES ($1, $2, $3)",
          [installation.id, installation.name, installation.createdAt],
        );
        context.installation = immutableCopy(installation);
        context.installationLoaded = true;
        if (this.bootstrapNativeIAM !== undefined) {
          await this.insertIAMState(context, this.bootstrapNativeIAM);
        }
        return immutableCopy(installation);
      },
      holdPrincipalAccount: async (principalId) => {
        const installation = await this.currentInstallation(context);
        if (installation === undefined) {
          throw new DependencyUnavailableError(
            "The platform Installation has not been initialized.",
          );
        }
        // FOR SHARE conflicts with the account UPDATE that disables it.
        const [account] = rows(
          (
            await client.query(
              `SELECT disabled FROM occ.human_authentication_accounts
               WHERE principal_id = $1 AND installation_id = $2 FOR SHARE`,
              [principalId, installation.id],
            )
          ).rows,
        );
        return account === undefined || account.disabled === false;
      },
    };

    const namespaces: NamespaceRepository = {
      findNamespace: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE id = $1 AND deleted_at IS NULL`,
              [namespaceId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : namespaceFromRow(found);
      },
      listNamespaces: async () => {
        const found = rows(
          (
            await client.query(
              `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE deleted_at IS NULL ORDER BY created_at, id`,
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => namespaceFromRow(row)));
      },
      createNamespace: async (namespace) => {
        await this.requireInitialized(context);
        // A tombstone keeps its name UNIQUE; say so instead of reporting a live Namespace.
        const tombstoned = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.namespaces WHERE name = $1 AND deleted_at IS NOT NULL) AS present",
              [namespace.name],
            )
          ).rows,
        )[0];
        if (tombstoned?.present === true) {
          throw new ResourceStateConflictError(DELETED_NAMESPACE_NAME_CONFLICT);
        }
        await client.query(
          `INSERT INTO occ.namespaces (id, name, existing_namespace, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            namespace.id,
            namespace.name,
            namespace.existingNamespace ?? null,
            namespace.status,
            namespace.createdAt,
          ],
        );
        return immutableCopy(namespace);
      },
      lockNamespace: async (namespaceId, options = {}) => {
        const found = rows(
          (
            await client.query(
              `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces
               WHERE id = $1${options.includeDeleted === true ? "" : " AND deleted_at IS NULL"}
               FOR UPDATE`,
              [namespaceId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : namespaceFromRow(found);
      },
      hasAgents: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      hasConfigurations: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.configurations WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      listConfigurationIds: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                "SELECT id FROM occ.configurations WHERE namespace_id = $1 ORDER BY created_at, id",
                [namespaceId],
              )
            ).rows,
          ).map((row) => String(row.id)),
        ),
      hasPresets: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.presets WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      hasServiceAccounts: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.service_accounts WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      hasSecrets: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.secrets WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      hasCredentialSources: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              "SELECT EXISTS (SELECT 1 FROM occ.credential_sources WHERE namespace_id = $1) AS present",
              [namespaceId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      transitionNamespaceStatus: async (namespaceId, expected, next) => {
        await this.requireInitialized(context);
        const expectedStatuses = Array.isArray(expected) ? expected : [expected];
        const found = rows(
          (
            await client.query(
              `UPDATE occ.namespaces SET status = $3
               WHERE id = $1 AND status = ANY($2::text[]) AND deleted_at IS NULL
               RETURNING id, name, existing_namespace, status, created_at, deleted_at`,
              [namespaceId, expectedStatuses, next],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : namespaceFromRow(found);
      },
      markNamespaceDeleted: async (namespaceId, deletedAt) => {
        await this.requireInitialized(context);
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.namespaces SET deleted_at = $2
               WHERE id = $1 AND status = 'deleting' AND deleted_at IS NULL
               RETURNING id, name, existing_namespace, status, created_at, deleted_at`,
              [namespaceId, deletedAt],
            )
          ).rows,
        )[0];
        if (updated !== undefined) {
          return namespaceFromRow(updated);
        }
        const existing = rows(
          (
            await client.query(
              `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE id = $1 AND status = 'deleting' FOR UPDATE`,
              [namespaceId],
            )
          ).rows,
        )[0];
        return existing === undefined ? undefined : namespaceFromRow(existing);
      },
    };

    // Deleting a Namespace resource also removes the AccessBindings that grant
    // on it (as Agent deletion does), so none outlive their target or keep
    // blocking deletion of the Role they reference. Resource ids are unique.
    const deleteResourceAccessBindings = async (
      resourceKind: "configuration" | "preset" | "secret" | "credential_source" | "service_account",
      resourceId: string,
    ): Promise<void> => {
      await client.query(
        "DELETE FROM occ.iam_access_bindings WHERE resource_kind = $1 AND resource_id = $2",
        [resourceKind, resourceId],
      );
    };

    const findPreset = async (
      namespaceId: string,
      presetId: string,
      lock = false,
    ): Promise<Readonly<Preset> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT p.id, p.namespace_id, p.name, p.template, p.created_at
         FROM occ.presets AS p
         JOIN occ.namespaces AS n ON n.id = p.namespace_id AND n.deleted_at IS NULL
         WHERE p.namespace_id = $1 AND p.id = $2${lock ? " FOR UPDATE OF p" : ""}`,
            [namespaceId, presetId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : presetFromRow(found);
    };
    const presets: PresetRepository = {
      findPreset,
      listPresets: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT p.id, p.namespace_id, p.name, p.template, p.created_at
         FROM occ.presets AS p
         JOIN occ.namespaces AS n ON n.id = p.namespace_id AND n.deleted_at IS NULL
         WHERE p.namespace_id = $1 ORDER BY p.id`,
                [namespaceId],
              )
            ).rows,
          ).map(presetFromRow),
        ),
      createPreset: async (preset) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(preset.namespaceId);
        if (namespace === undefined || !["provisioning", "ready"].includes(namespace.status)) {
          throw new ScopeViolationError("The Preset belongs to an unavailable Namespace.");
        }
        await client.query(
          `INSERT INTO occ.presets (id, namespace_id, name, template, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            preset.id,
            preset.namespaceId,
            preset.name,
            JSON.stringify(preset.template),
            preset.createdAt,
          ],
        );
        return immutableCopy(preset);
      },
      lockPreset: async (namespaceId, presetId) => findPreset(namespaceId, presetId, true),
      updatePreset: async (namespaceId, presetId, changes) => {
        const current = await findPreset(namespaceId, presetId, true);
        if (current === undefined) {
          return undefined;
        }
        const found = rows(
          (
            await client.query(
              `UPDATE occ.presets SET name = $3, template = $4::jsonb
           WHERE namespace_id = $1 AND id = $2
           RETURNING id, namespace_id, name, template, created_at`,
              [
                namespaceId,
                presetId,
                changes.name ?? current.name,
                JSON.stringify(changes.template ?? current.template),
              ],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : presetFromRow(found);
      },
      deletePreset: async (namespaceId, presetId) => {
        const deleted = await client.query(
          `DELETE FROM occ.presets AS p USING occ.namespaces AS n
           WHERE p.namespace_id = $1 AND p.id = $2 AND n.id = p.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, presetId],
        );
        if (deleted.rowCount !== 1) {
          return false;
        }
        await deleteResourceAccessBindings("preset", presetId);
        return true;
      },
    };

    const findSecret = async (
      namespaceId: string,
      secretId: string,
      lock = false,
    ): Promise<Readonly<Secret> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT s.id, s.namespace_id, s.name, s.driver_id,
                    s.backend_namespace_name, s.backend_name, s.backend_key, s.backend_uid,
                    s.created_at
             FROM occ.secrets AS s
             JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
             WHERE s.namespace_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
            [namespaceId, secretId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : secretFromRow(found);
    };

    const listSecrets = async (namespaceId: string): Promise<readonly Readonly<Secret>[]> =>
      Object.freeze(
        rows(
          (
            await client.query(
              `SELECT s.id, s.namespace_id, s.name, s.driver_id,
                      s.backend_namespace_name, s.backend_name, s.backend_key, s.backend_uid,
                      s.created_at
               FROM occ.secrets AS s
               JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
               WHERE s.namespace_id = $1
               ORDER BY s.created_at, s.id`,
              [namespaceId],
            )
          ).rows,
        ).map(secretFromRow),
      );

    const validateSecretBindingsAvailable = async (
      namespaceId: string,
      bindings: SecretBindings | undefined,
    ): Promise<void> => {
      const secretIds = referencedSecretIds(namespaceId, bindings);
      if (secretIds.length === 0) {
        return;
      }
      const found = rows(
        (
          await client.query(
            `SELECT id FROM occ.secrets
             WHERE namespace_id = $1 AND id = ANY($2::text[])
             ORDER BY id`,
            [namespaceId, secretIds],
          )
        ).rows,
      );
      if (found.length !== secretIds.length) {
        throw new ScopeViolationError("Secret bindings reference unavailable Secret metadata.");
      }
    };

    const findConfiguration = async (
      namespaceId: string,
      configurationId: string,
      lock = false,
    ): Promise<Readonly<ConfigurationOwnership> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT c.id, c.namespace_id, c.kind, c.generation, c.created_at
                  , c.secret_bindings
             FROM occ.configurations AS c
             JOIN occ.namespaces AS n ON n.id = c.namespace_id AND n.deleted_at IS NULL
             WHERE c.namespace_id = $1 AND c.id = $2${lock ? " FOR UPDATE OF c" : ""}`,
            [namespaceId, configurationId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : configurationFromRow(found);
    };

    const configurations: ConfigurationRepository = {
      findConfiguration,
      createConfiguration: async (configuration) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(configuration.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        ) {
          throw new ScopeViolationError("The Configuration belongs to an unavailable Namespace.");
        }
        const serializedSecretBindings = serializeSecretBindings(
          configuration.namespaceId,
          configuration.secretBindings,
        );
        await validateSecretBindingsAvailable(
          configuration.namespaceId,
          configuration.secretBindings,
        );
        await client.query(
          `INSERT INTO occ.configurations
           (id, namespace_id, kind, generation, secret_bindings, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            configuration.id,
            configuration.namespaceId,
            configuration.kind,
            configuration.generation,
            serializedSecretBindings,
            configuration.createdAt,
          ],
        );
        const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = configuration;
        const storedSecretBindings =
          serializedSecretBindings === null
            ? undefined
            : secretBindingsFromJson(serializedSecretBindings, configuration.namespaceId);
        const saved: ConfigurationOwnership =
          storedSecretBindings === undefined
            ? withoutSecretBindings
            : { ...withoutSecretBindings, secretBindings: storedSecretBindings };
        return immutableCopy({
          ...saved,
        });
      },
      lockConfiguration: async (namespaceId, configurationId) =>
        findConfiguration(namespaceId, configurationId, true),
      advanceConfigurationGeneration: async (
        namespaceId,
        configurationId,
        expectedGeneration,
        nextSecretBindings,
      ) => {
        const current = await findConfiguration(namespaceId, configurationId, true);
        if (current === undefined || current.generation !== expectedGeneration) {
          return undefined;
        }
        const secretBindings =
          nextSecretBindings === undefined ? current.secretBindings : nextSecretBindings;
        await validateSecretBindingsAvailable(namespaceId, secretBindings);
        const serializedSecretBindings = serializeSecretBindings(namespaceId, secretBindings);
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.configurations AS c
               SET generation = c.generation + 1, secret_bindings = $4::jsonb
               FROM occ.namespaces AS n
               WHERE c.namespace_id = $1 AND c.id = $2 AND c.generation = $3
                 AND n.id = c.namespace_id AND n.deleted_at IS NULL
               RETURNING c.id, c.namespace_id, c.kind, c.generation, c.secret_bindings,
                         c.created_at`,
              [namespaceId, configurationId, expectedGeneration, serializedSecretBindings],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : configurationFromRow(updated);
      },
      deleteConfiguration: async (namespaceId, configurationId) => {
        const deleted = await client.query(
          `DELETE FROM occ.configurations AS c USING occ.namespaces AS n
           WHERE c.namespace_id = $1 AND c.id = $2
             AND n.id = c.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, configurationId],
        );
        if (deleted.rowCount !== 1) {
          return false;
        }
        await deleteResourceAccessBindings("configuration", configurationId);
        return true;
      },
    };

    const secrets: SecretRepository = {
      findSecret,
      listSecrets,
      lockSecret: async (namespaceId, secretId) => findSecret(namespaceId, secretId, true),
      createSecret: async (secret) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(secret.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        ) {
          throw new ScopeViolationError("The Secret belongs to an unavailable Namespace.");
        }
        await client.query(
          `INSERT INTO occ.secrets
           (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
            backend_key, backend_uid, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            secret.id,
            secret.namespaceId,
            secret.name,
            secret.driverId,
            secret.backendRef.namespaceName,
            secret.backendRef.name,
            secret.backendRef.key,
            secret.backendRef.uid,
            secret.createdAt,
          ],
        );
        return immutableCopy(secret);
      },
      listReferences: async (namespaceId, secretId, limit) => {
        // One statement for every kind, and none for a Secret that is gone or whose Namespace
        // is deleted (as findSecret); LIMIT limit + 1 tells a full page from a truncated one.
        const found = rows(
          (
            await client.query(
              `SELECT reference.kind, reference.id FROM (
                 SELECT 'credential_source'::text AS kind, credential_source_id AS id
                 FROM occ.credential_source_secrets
                 WHERE namespace_id = $1 AND secret_id = $2
                 UNION
                 SELECT 'configuration', c.id
                 FROM occ.configurations AS c,
                      jsonb_each(COALESCE(c.secret_bindings, '{}'::jsonb)) AS binding(env, value)
                 WHERE c.namespace_id = $1
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
                 UNION
                 SELECT 'agent', a.id
                 FROM occ.agents AS a
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = a.namespace_id
                  AND r.agent_id = a.id
                  AND r.id = a.active_revision_id,
                      jsonb_each(COALESCE(r.admitted_spec->'secret_bindings', '{}'::jsonb))
                        AS binding(env, value)
                 WHERE a.namespace_id = $1
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
                 UNION
                 SELECT 'agent', w.agent_id
                 FROM occ.controller_work AS w
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = w.namespace_id
                  AND r.agent_id = w.agent_id
                  AND r.id = w.revision_id,
                      jsonb_each(COALESCE(r.admitted_spec->'secret_bindings', '{}'::jsonb))
                        AS binding(env, value)
                 WHERE w.namespace_id = $1
                   AND w.state IN ('queued', 'claimed')
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
                 UNION
                 SELECT 'agent', id FROM occ.agents
                 WHERE namespace_id = $1 AND harness_auth_secret_id = $2
                 UNION
                 SELECT 'agent', a.id FROM occ.agents AS a
                 JOIN occ.agent_revisions AS r ON r.namespace_id = a.namespace_id
                   AND r.agent_id = a.id AND r.id = a.active_revision_id
                 WHERE a.namespace_id = $1
                   AND r.admitted_spec #>> '{harness_auth,source,kind}' = 'secret'
                   AND r.admitted_spec #>> '{harness_auth,source,id}' = $2
                 UNION
                 SELECT 'agent', w.agent_id FROM occ.controller_work AS w
                 JOIN occ.agent_revisions AS r ON r.namespace_id = w.namespace_id
                   AND r.agent_id = w.agent_id AND r.id = w.revision_id
                 WHERE w.namespace_id = $1 AND w.state IN ('queued', 'claimed')
                   AND r.admitted_spec #>> '{harness_auth,source,kind}' = 'secret'
                   AND r.admitted_spec #>> '{harness_auth,source,id}' = $2
                 UNION
                 -- A queued or running guided provisioning plan creates its Configuration and
                 -- Agent from these references later. A failed plan does not block: nothing
                 -- removes it, and reading or retrying it then names the deleted Secret.
                 SELECT 'provisioning_request', p.work_id FROM occ.agent_provisioning_work AS p
                 WHERE p.namespace_id = $1 AND p.status IN ('queued', 'running')
                   AND (
                     EXISTS (
                       SELECT 1
                       FROM jsonb_each(
                         COALESCE(p.plan #> '{configuration,secretBindings}', '{}'::jsonb)
                       ) AS binding(env, value)
                       WHERE binding.value #>> '{source,kind}' = 'secret'
                         AND binding.value #>> '{source,namespaceId}' = $1
                         AND binding.value #>> '{source,id}' = $2
                     ) OR (
                       p.plan #>> '{harnessAuth,source,kind}' = 'secret'
                       AND p.plan #>> '{harnessAuth,source,id}' = $2
                     )
                   )
               ) AS reference
               WHERE EXISTS (
                 SELECT 1 FROM occ.secrets AS s
                 JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
                 WHERE s.namespace_id = $1 AND s.id = $2
               )
               ORDER BY reference.kind COLLATE "C", reference.id COLLATE "C"
               LIMIT $3`,
              [namespaceId, secretId, limit + 1],
            )
          ).rows,
        );
        const references = found.slice(0, limit).map((row) =>
          Object.freeze({
            kind: text(row, "kind") as SecretReferenceKind,
            id: text(row, "id"),
          }),
        );
        return Object.freeze({
          references: Object.freeze(references),
          truncated: found.length > limit,
        });
      },
      hasReferences: async (namespaceId, secretId) =>
        (await secrets.listReferences(namespaceId, secretId, 1)).references.length > 0,
      deleteSecret: async (namespaceId, secretId) => {
        if ((await findSecret(namespaceId, secretId)) === undefined) {
          return false;
        }
        if (await secrets.hasReferences(namespaceId, secretId)) {
          throw new ScopeViolationError("The Secret is referenced by active platform state.");
        }
        const deleted = await client.query(
          `DELETE FROM occ.secrets AS s USING occ.namespaces AS n
           WHERE s.namespace_id = $1 AND s.id = $2
             AND n.id = s.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, secretId],
        );
        if (deleted.rowCount !== 1) {
          return false;
        }
        await deleteResourceAccessBindings("secret", secretId);
        return true;
      },
    };

    const findServiceAccount = async (
      namespaceId: string,
      serviceAccountId: string,
      lock = false,
    ): Promise<Readonly<ServiceAccount> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT s.id, s.namespace_id, s.name, s.credential
             FROM occ.service_accounts AS s
             JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
             WHERE s.namespace_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
            [namespaceId, serviceAccountId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : serviceAccountFromRow(found);
    };

    const findCredentialSource = async (
      namespaceId: string,
      credentialSourceId: string,
      lock = false,
    ): Promise<Readonly<CredentialSource> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT ${CREDENTIAL_SOURCE_COLUMNS}
             FROM occ.credential_sources AS cs
             JOIN occ.namespaces AS n ON n.id = cs.namespace_id AND n.deleted_at IS NULL
             WHERE cs.namespace_id = $1 AND cs.id = $2${lock ? " FOR UPDATE OF cs" : ""}`,
            [namespaceId, credentialSourceId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : credentialSourceFromRow(found);
    };

    const findCredentialWithdrawal = async (
      namespaceId: string,
      revisionId: string,
      credentialSourceId: string,
    ): Promise<Readonly<CredentialWithdrawal> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT ${CREDENTIAL_WITHDRAWAL_COLUMNS} FROM occ.credential_withdrawals
             WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3`,
            [namespaceId, revisionId, credentialSourceId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : credentialWithdrawalFromRow(found);
    };

    const credentialSources: CredentialSourceRepository = {
      findCredentialSource,
      findCredentialWithdrawal,
      listCredentialWithdrawals: async (namespaceId, revisionId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT ${CREDENTIAL_WITHDRAWAL_COLUMNS} FROM occ.credential_withdrawals
                 WHERE namespace_id = $1 AND revision_id = $2
                 ORDER BY credential_source_id`,
                [namespaceId, revisionId],
              )
            ).rows,
          ).map(credentialWithdrawalFromRow),
        ),
      requestCredentialWithdrawal: async (withdrawal) => {
        await this.requireInitialized(context);
        // Replays return the recorded withdrawal; the primary key admits one per revision and source.
        await client.query(
          `INSERT INTO occ.credential_withdrawals
           (namespace_id, agent_id, revision_id, credential_source_id, state, requested_by,
            requested_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (namespace_id, revision_id, credential_source_id) DO NOTHING`,
          [
            withdrawal.namespaceId,
            withdrawal.agentId,
            withdrawal.revisionId,
            withdrawal.credentialSourceId,
            withdrawal.state,
            withdrawal.requestedBy,
            withdrawal.requestedAt,
            withdrawal.completedAt ?? null,
          ],
        );
        const saved = await findCredentialWithdrawal(
          withdrawal.namespaceId,
          withdrawal.revisionId,
          withdrawal.credentialSourceId,
        );
        if (saved === undefined || saved.agentId !== withdrawal.agentId) {
          throw new ResourceConflictError("The credential withdrawal could not be recorded.");
        }
        return saved;
      },
      reassignCredentialWithdrawal: async (
        namespaceId,
        revisionId,
        credentialSourceId,
        requestedBy,
      ) => {
        if (!isNonEmptyString(requestedBy)) {
          throw new ScopeViolationError("A credential withdrawal requester is missing.");
        }
        const updated = await client.query(
          `UPDATE occ.credential_withdrawals SET requested_by = $4
           WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3
             AND state = 'pending'`,
          [namespaceId, revisionId, credentialSourceId, requestedBy],
        );
        return updated.rowCount === 1
          ? findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId)
          : undefined;
      },
      recordCredentialWithdrawalAttempt: async (
        namespaceId,
        revisionId,
        credentialSourceId,
        attempt,
      ) => {
        const updated = await client.query(
          `UPDATE occ.credential_withdrawals SET last_reason = $4, last_attempt_at = $5
           WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3
             AND state = 'pending'`,
          [namespaceId, revisionId, credentialSourceId, attempt.reason, attempt.at],
        );
        return updated.rowCount === 1
          ? findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId)
          : undefined;
      },
      markCredentialWithdrawalRevoked: async (
        namespaceId,
        revisionId,
        credentialSourceId,
        completedAt,
      ) => {
        const updated = await client.query(
          `UPDATE occ.credential_withdrawals SET state = 'revoked', completed_at = $4
           WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3
             AND state = 'pending'`,
          [namespaceId, revisionId, credentialSourceId, completedAt],
        );
        return updated.rowCount === 1
          ? findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId)
          : undefined;
      },
      listCredentialSources: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT ${CREDENTIAL_SOURCE_COLUMNS}
                 FROM occ.credential_sources AS cs
                 JOIN occ.namespaces AS n ON n.id = cs.namespace_id AND n.deleted_at IS NULL
                 WHERE cs.namespace_id = $1
                 ORDER BY cs.created_at, cs.id`,
                [namespaceId],
              )
            ).rows,
          ).map(credentialSourceFromRow),
        ),
      lockCredentialSource: async (namespaceId, credentialSourceId) =>
        findCredentialSource(namespaceId, credentialSourceId, true),
      createCredentialSource: async (source) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(source.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        ) {
          throw new ScopeViolationError(
            "The credential source belongs to an unavailable Namespace.",
          );
        }
        const secretInputs = Object.entries(source.secrets);
        // Only the Secret ID is stored; the row's Namespace makes every input same-Namespace.
        if (
          secretInputs.some(
            ([, reference]) =>
              reference.kind !== "secret" || reference.namespaceId !== source.namespaceId,
          )
        ) {
          throw new ScopeViolationError(
            "Credential source Secret inputs must reference exact Secrets.",
          );
        }
        await client.query(
          `INSERT INTO occ.credential_sources
           (id, namespace_id, name, type, config, driver_id, state, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [
            source.id,
            source.namespaceId,
            source.name,
            source.type,
            JSON.stringify(source.config),
            source.driverId,
            source.state,
            source.createdAt,
          ],
        );
        if (secretInputs.length > 0) {
          await client.query(
            `INSERT INTO occ.credential_source_secrets
             (namespace_id, credential_source_id, field, secret_id)
             SELECT $1, $2, input.field, input.secret_id
             FROM unnest($3::text[], $4::text[]) AS input(field, secret_id)`,
            [
              source.namespaceId,
              source.id,
              secretInputs.map(([field]) => field),
              secretInputs.map(([, reference]) => reference.id),
            ],
          );
        }
        return immutableCopy(source);
      },
      replaceCredentialSourceSecrets: async (namespaceId, credentialSourceId, secrets) => {
        const current = await findCredentialSource(namespaceId, credentialSourceId);
        if (current === undefined || current.state !== "ready") {
          return undefined;
        }
        assertSameCredentialSourceFields(current.secrets, secrets);
        const inputs = Object.entries(secrets);
        if (
          inputs.some(
            ([, reference]) => reference.kind !== "secret" || reference.namespaceId !== namespaceId,
          )
        ) {
          throw new ScopeViolationError(
            "Credential source Secret inputs must reference exact Secrets.",
          );
        }
        // The Secret foreign key rejects a missing or foreign Secret.
        const updated = await client.query(
          `UPDATE occ.credential_source_secrets AS css SET secret_id = input.secret_id
           FROM unnest($3::text[], $4::text[]) AS input(field, secret_id)
           WHERE css.namespace_id = $1 AND css.credential_source_id = $2
             AND css.field = input.field`,
          [
            namespaceId,
            credentialSourceId,
            inputs.map(([field]) => field),
            inputs.map(([, reference]) => reference.id),
          ],
        );
        if (updated.rowCount !== inputs.length) {
          throw new DependencyUnavailableError(
            "Persisted credential source Secret fields are invalid.",
          );
        }
        return findCredentialSource(namespaceId, credentialSourceId);
      },
      markCredentialSourceReady: async (namespaceId, credentialSourceId) => {
        const updated = await client.query(
          `UPDATE occ.credential_sources AS cs SET state = 'ready'
           FROM occ.namespaces AS n
           WHERE cs.namespace_id = $1 AND cs.id = $2 AND cs.state = 'registering'
             AND n.id = cs.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, credentialSourceId],
        );
        return updated.rowCount === 1
          ? findCredentialSource(namespaceId, credentialSourceId)
          : undefined;
      },
      markCredentialSourceDeleting: async (namespaceId, credentialSourceId) => {
        const updated = await client.query(
          `UPDATE occ.credential_sources AS cs SET state = 'deleting'
           FROM occ.namespaces AS n
           WHERE cs.namespace_id = $1 AND cs.id = $2 AND cs.state IN ('registering', 'ready')
             AND n.id = cs.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, credentialSourceId],
        );
        return updated.rowCount === 1
          ? findCredentialSource(namespaceId, credentialSourceId)
          : undefined;
      },
      hasReferences: async (namespaceId, credentialSourceId) =>
        (await credentialSources.findBlockingReference(namespaceId, credentialSourceId)) !==
        undefined,
      findBlockingReference: async (namespaceId, credentialSourceId) => {
        if ((await findCredentialSource(namespaceId, credentialSourceId)) === undefined) {
          return undefined;
        }
        // Withdrawal work is reported only when nothing else references the source, so the
        // refusal can name the way out that applies.
        const found = rows(
          (
            await client.query(
              `WITH held_work AS (
                 -- Outstanding work for a revision admitted with the source.
                 SELECT w.agent_target IS NOT DISTINCT FROM $3 AS withdrawal
                 FROM occ.controller_work AS w
                 JOIN occ.agent_revisions AS r ON r.namespace_id = w.namespace_id
                   AND r.agent_id = w.agent_id AND r.id = w.revision_id
                 WHERE w.namespace_id = $1 AND w.state IN ('queued', 'claimed')
                   AND ((r.admitted_spec #>> '{harness_auth,method}' = 'credential_source'
                         AND r.admitted_spec #>> '{harness_auth,sourceId}' = $2)
                     OR r.admitted_spec->'credential_sources' @> jsonb_build_array(
                          jsonb_build_object('sourceId', $2::text)))
               )
               SELECT EXISTS (
                 SELECT 1 FROM occ.agents
                 WHERE namespace_id = $1 AND harness_auth_credential_source_id = $2
               ) OR EXISTS (
                 SELECT 1 FROM occ.agent_credential_sources
                 WHERE namespace_id = $1 AND credential_source_id = $2
               ) OR EXISTS (
                 SELECT 1 FROM occ.agents AS a
                 JOIN occ.agent_revisions AS r ON r.namespace_id = a.namespace_id
                   AND r.agent_id = a.id AND r.id = a.active_revision_id
                 WHERE a.namespace_id = $1
                   AND ((r.admitted_spec #>> '{harness_auth,method}' = 'credential_source'
                         AND r.admitted_spec #>> '{harness_auth,sourceId}' = $2)
                     OR r.admitted_spec->'credential_sources' @> jsonb_build_array(
                          jsonb_build_object('sourceId', $2::text)))
               ) OR EXISTS (SELECT 1 FROM held_work WHERE NOT withdrawal) AS referenced,
               EXISTS (SELECT 1 FROM held_work WHERE withdrawal) AS withdrawal_work`,
              [namespaceId, credentialSourceId, CREDENTIAL_WITHDRAWAL_TARGET],
            )
          ).rows,
        )[0];
        if (found?.referenced === true) {
          return "reference";
        }
        return found?.withdrawal_work === true ? "withdrawal_work" : undefined;
      },
      deleteCredentialSource: async (namespaceId, credentialSourceId) => {
        if ((await findCredentialSource(namespaceId, credentialSourceId)) === undefined) {
          return false;
        }
        if (await credentialSources.hasReferences(namespaceId, credentialSourceId)) {
          throw new ScopeViolationError(
            "The credential source is referenced by active platform state.",
          );
        }
        const deleted = await client.query(
          `DELETE FROM occ.credential_sources AS cs USING occ.namespaces AS n
           WHERE cs.namespace_id = $1 AND cs.id = $2
             AND n.id = cs.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, credentialSourceId],
        );
        if (deleted.rowCount !== 1) {
          return false;
        }
        await deleteResourceAccessBindings("credential_source", credentialSourceId);
        return true;
      },
    };

    const serviceAccounts: ServiceAccountRepository = {
      findServiceAccount,
      listServiceAccounts: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT s.id, s.namespace_id, s.name, s.credential
                 FROM occ.service_accounts AS s
                 JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
                 WHERE s.namespace_id = $1
                 ORDER BY s.name, s.id`,
                [namespaceId],
              )
            ).rows,
          ).map(serviceAccountFromRow),
        ),
      findServiceAccountBackendBinding: async (namespaceId, serviceAccountId) => {
        const found = rows(
          (
            await client.query(
              `SELECT b.backend_id, b.driver_id, b.workspace_id,
                      b.external_credential_id IS NOT NULL AS credential_issued
               FROM occ.service_account_driver_bindings AS b
               JOIN occ.namespaces AS n ON n.id = b.namespace_id AND n.deleted_at IS NULL
               WHERE b.namespace_id = $1 AND b.service_account_id = $2`,
              [namespaceId, serviceAccountId],
            )
          ).rows,
        )[0];
        return found === undefined
          ? undefined
          : immutableCopy({
              backendId: text(found, "backend_id"),
              driverId: text(found, "driver_id"),
              workspaceId: text(found, "workspace_id"),
              credentialIssued: found.credential_issued === true,
            });
      },
      lockServiceAccount: async (namespaceId, serviceAccountId) =>
        findServiceAccount(namespaceId, serviceAccountId, true),
      createServiceAccount: async (account) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(account.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        ) {
          throw new ScopeViolationError("The ServiceAccount belongs to an unavailable Namespace.");
        }
        await client.query(
          `INSERT INTO occ.service_accounts
           (id, namespace_id, name, credential)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            account.id,
            account.namespaceId,
            account.name,
            account.credential === undefined ? null : JSON.stringify(account.credential),
          ],
        );
        return immutableCopy(account);
      },
      updateCredential: async (namespaceId, serviceAccountId, credential) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.service_accounts AS s
               SET credential = $3::jsonb
               FROM occ.namespaces AS n
               WHERE s.namespace_id = $1 AND s.id = $2
                 AND n.id = s.namespace_id AND n.deleted_at IS NULL
               RETURNING s.id, s.namespace_id, s.name, s.credential`,
              [namespaceId, serviceAccountId, JSON.stringify(credential)],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : serviceAccountFromRow(updated);
      },
      hasReferences: async (namespaceId, serviceAccountId) => {
        if ((await findServiceAccount(namespaceId, serviceAccountId)) === undefined) {
          return false;
        }
        // One statement observes both sides of the worker's pending-to-active handoff.
        const found = rows(
          (
            await client.query(
              `SELECT EXISTS (
                 SELECT 1 FROM occ.agents
                 WHERE namespace_id = $1 AND harness_auth_service_account_id = $2
               ) OR EXISTS (
                 SELECT 1 FROM occ.agents AS a
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = a.namespace_id
                  AND r.agent_id = a.id
                  AND r.id = a.active_revision_id
                 WHERE a.namespace_id = $1
                   AND r.admitted_spec #>> '{harness_auth,source,kind}' = 'service_account'
                   AND r.admitted_spec #>> '{harness_auth,source,id}' = $2
               ) OR EXISTS (
                 SELECT 1 FROM occ.controller_work AS w
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = w.namespace_id
                  AND r.agent_id = w.agent_id
                  AND r.id = w.revision_id
                 WHERE w.namespace_id = $1
                   AND w.state IN ('queued', 'claimed')
                   AND r.admitted_spec #>> '{harness_auth,source,kind}' = 'service_account'
                   AND r.admitted_spec #>> '{harness_auth,source,id}' = $2
               ) OR EXISTS (
                 -- A queued or running guided provisioning plan creates its Agent from this
                 -- account later. A failed plan does not block: nothing removes it, and
                 -- reading or retrying it then names the deleted ServiceAccount.
                 SELECT 1 FROM occ.agent_provisioning_work AS p
                 WHERE p.namespace_id = $1 AND p.status IN ('queued', 'running')
                   AND p.plan #>> '{harnessAuth,source,kind}' = 'service_account'
                   AND p.plan #>> '{harnessAuth,source,id}' = $2
               ) AS present`,
              [namespaceId, serviceAccountId],
            )
          ).rows,
        )[0];
        return found?.present === true;
      },
      deleteServiceAccount: async (namespaceId, serviceAccountId) => {
        if (await serviceAccounts.hasReferences(namespaceId, serviceAccountId)) {
          throw new ScopeViolationError(
            "The ServiceAccount is referenced by active platform state.",
          );
        }
        const deleted = await client.query(
          `DELETE FROM occ.service_accounts AS s USING occ.namespaces AS n
           WHERE s.namespace_id = $1 AND s.id = $2
             AND n.id = s.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, serviceAccountId],
        );
        if (deleted.rowCount !== 1) {
          return false;
        }
        await deleteResourceAccessBindings("service_account", serviceAccountId);
        return true;
      },
      findIssuedCredentialBinding: async (namespaceId, serviceAccountId) => {
        const found = rows(
          (
            await client.query(
              `SELECT b.backend_id, b.workspace_id, b.external_account_id, b.external_credential_id
               FROM occ.service_account_driver_bindings AS b
               JOIN occ.namespaces AS n ON n.id = b.namespace_id AND n.deleted_at IS NULL
               WHERE b.namespace_id = $1 AND b.service_account_id = $2
                 AND b.external_credential_id IS NOT NULL`,
              [namespaceId, serviceAccountId],
            )
          ).rows,
        )[0];
        return found === undefined
          ? undefined
          : immutableCopy({
              backendId: text(found, "backend_id"),
              workspaceId: text(found, "workspace_id"),
              externalAccountId: text(found, "external_account_id"),
              credentialId: text(found, "external_credential_id"),
            });
      },
    };

    const findAgentRow = async (
      namespaceId: string,
      agentId: string,
      lock = false,
    ): Promise<PostgresRow | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                    a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                    a.active_revision_id, a.desired_runtime_state, a.status, a.created_at
             FROM occ.agents AS a
             JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
             WHERE a.namespace_id = $1 AND a.id = $2${lock ? " FOR UPDATE OF a" : ""}`,
            [namespaceId, agentId],
          )
        ).rows,
      )[0];
      return found;
    };

    const setupFromRow = (row: PostgresRow): Readonly<WorkspaceSetup> =>
      immutableCopy({
        id: row.id as string,
        namespaceId: row.namespace_id as string,
        agentId: row.agent_id as string,
        ...(row.defaults_id === null ? {} : { defaultsId: row.defaults_id as string }),
        ...(row.files === null ? {} : { files: row.files as NonNullable<WorkspaceSetup["files"]> }),
        completed: row.completed as boolean,
      });
    const workspaceSetups: WorkspaceSetupRepository = {
      find: async (namespaceId, agentId) => {
        const row = rows(
          (
            await client.query(
              "SELECT id, namespace_id, agent_id, defaults_id, files, completed FROM occ.workspace_setups WHERE namespace_id = $1 AND agent_id = $2",
              [namespaceId, agentId],
            )
          ).rows,
        )[0];
        return row === undefined ? undefined : setupFromRow(row);
      },
      create: async (setup) => {
        const row = rows(
          (
            await client.query(
              `INSERT INTO occ.workspace_setups (id, namespace_id, agent_id, defaults_id, files, completed)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
              [
                setup.id,
                setup.namespaceId,
                setup.agentId,
                setup.defaultsId ?? null,
                setup.files === undefined ? null : JSON.stringify(setup.files),
                setup.completed,
              ],
            )
          ).rows,
        )[0];
        return setupFromRow(row!);
      },
      complete: async (namespaceId, agentId, id) => {
        const row = rows(
          (
            await client.query(
              `UPDATE occ.workspace_setups SET files = NULL, completed = true
           WHERE namespace_id = $1 AND agent_id = $2 AND id = $3 RETURNING *`,
              [namespaceId, agentId, id],
            )
          ).rows,
        )[0];
        return row === undefined ? undefined : setupFromRow(row);
      },
      delete: async (namespaceId, agentId) =>
        rows(
          (
            await client.query(
              "DELETE FROM occ.workspace_setups WHERE namespace_id = $1 AND agent_id = $2 RETURNING id",
              [namespaceId, agentId],
            )
          ).rows,
        ).length > 0,
    };

    const listAgentRows = async (namespaceId: string): Promise<PostgresRow[]> => {
      const found = rows(
        (
          await client.query(
            `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                      a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                      a.active_revision_id, a.desired_runtime_state, a.status, a.created_at
               FROM occ.agents AS a
               JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
               WHERE a.namespace_id = $1 ORDER BY a.created_at, a.id`,
            [namespaceId],
          )
        ).rows,
      );
      return found;
    };

    const agents: AgentRepository = {
      findAgent: async (namespaceId, agentId) => {
        const row = await findAgentRow(namespaceId, agentId);
        return row === undefined ? undefined : agentFromRow(row);
      },
      findAgentForBrowsing: async (namespaceId, agentId) => {
        const row = await findAgentRow(namespaceId, agentId);
        return row === undefined ? undefined : agentForBrowsingFromRow(row);
      },
      listAgents: async (namespaceId) =>
        Object.freeze((await listAgentRows(namespaceId)).map((row) => agentFromRow(row))),
      listAgentsForBrowsing: async (namespaceId) =>
        Object.freeze((await listAgentRows(namespaceId)).map(agentForBrowsingFromRow)),
      lockAgent: async (namespaceId, agentId) => {
        const row = await findAgentRow(namespaceId, agentId, true);
        return row === undefined ? undefined : agentFromRow(row);
      },
      createAgent: async (agent) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(agent.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        ) {
          throw new ScopeViolationError("The Agent belongs to an unavailable Namespace.");
        }
        const configuration = await configurations.findConfiguration(
          agent.namespaceId,
          agent.configurationId,
        );
        if (configuration === undefined) {
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        }
        await validateSecretBindingsAvailable(agent.namespaceId, configuration.secretBindings);
        await assertHarnessAuthAvailable(
          { secrets, serviceAccounts, credentialSources },
          agent.namespaceId,
          agent.harnessAuth,
        );
        const plugins = normalizedPlugins(agent.plugins);
        const pluginApprovers = normalizedPluginApprovers(agent.pluginApprovers);
        const repositoryBindings =
          agent.repositoryBindings?.length === 0 ? undefined : agent.repositoryBindings;
        const repositoryAccess = normalizedRepositoryAccess(
          agent.repositoryAccess,
          repositoryBindings,
        );
        const {
          repositoryAccess: _providedRepositoryAccess,
          plugins: _providedPlugins,
          pluginApprovers: _providedPluginApprovers,
          repositoryBindings: _providedRepositoryBindings,
          credentialSources: providedCredentialSources,
          ...withoutPlugins
        } = agent;
        const agentCredentialSources =
          providedCredentialSources?.length === 0 ? undefined : providedCredentialSources;
        const saved = immutableCopy({
          ...withoutPlugins,
          ...(agentCredentialSources === undefined
            ? {}
            : { credentialSources: agentCredentialSources }),
          ...(plugins === undefined ? {} : { plugins }),
          ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
          ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
          ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
          desiredRuntimeState: "stopped" as const,
          status: "active" as const,
        });
        await client.query(
          `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, backend_id, execution_mode,
             service_principal_id, harness_auth, active_revision_id, created_at, plugins,
             plugin_approvers, repository_bindings, repository_access, credential_sources)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
                    $14::jsonb, $15::jsonb)`,
          [
            saved.id,
            saved.namespaceId,
            saved.name,
            saved.configurationId,
            saved.backendId,
            saved.executionMode,
            saved.servicePrincipalId,
            saved.harnessAuth === null ? null : JSON.stringify(saved.harnessAuth),
            saved.activeRevisionId ?? null,
            saved.createdAt,
            plugins === undefined ? null : JSON.stringify(plugins),
            pluginApprovers === undefined ? null : JSON.stringify(pluginApprovers),
            repositoryBindings === undefined ? null : JSON.stringify(repositoryBindings),
            repositoryAccess === undefined ? null : JSON.stringify(repositoryAccess),
            agentCredentialSources === undefined ? null : JSON.stringify(agentCredentialSources),
          ],
        );
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
           VALUES ($1, $2, $3, 'service_principal', NULL, NULL)`,
          [saved.servicePrincipalId, saved.namespaceId, saved.id],
        );
        return saved;
      },
      updateConfiguration: async (
        namespaceId,
        agentId,
        configurationId,
        executionMode,
        harnessAuth,
        backendId,
        plugins,
        repositoryBindings,
        pluginApprovers,
        repositoryAccess,
        nextCredentialSources,
      ) => {
        if (harnessAuth !== undefined) {
          await assertHarnessAuthAvailable(
            { secrets, serviceAccounts, credentialSources },
            namespaceId,
            harnessAuth,
          );
        }
        const configuration = await configurations.findConfiguration(namespaceId, configurationId);
        if (configuration === undefined) {
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        }
        await validateSecretBindingsAvailable(namespaceId, configuration.secretBindings);
        const nextPlugins = plugins === undefined ? undefined : normalizedPlugins(plugins);
        const nextPluginApprovers =
          pluginApprovers == null ? undefined : normalizedPluginApprovers(pluginApprovers);
        const nextRepositoryBindings =
          repositoryBindings?.length === 0 ? undefined : repositoryBindings;
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a
               SET configuration_id = $3, execution_mode = COALESCE($4::text, a.execution_mode),
                   harness_auth = CASE WHEN $5::boolean THEN $6::jsonb ELSE a.harness_auth END,
                   backend_id = CASE WHEN $7::boolean THEN $8::text ELSE a.backend_id END,
                   plugins = CASE WHEN $9::boolean THEN $10::jsonb ELSE a.plugins END,
                   plugin_approvers = CASE WHEN $11::boolean THEN $12::jsonb ELSE a.plugin_approvers END,
                   repository_bindings = CASE WHEN $13::boolean THEN $14::jsonb ELSE a.repository_bindings END,
                   repository_access = CASE WHEN $15::boolean THEN $16::jsonb ELSE a.repository_access END,
                   credential_sources = CASE WHEN $17::boolean THEN $18::jsonb ELSE a.credential_sources END
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                 RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                          a.active_revision_id, a.desired_runtime_state, a.status, a.created_at`,
              [
                namespaceId,
                agentId,
                configurationId,
                executionMode ?? null,
                harnessAuth !== undefined,
                harnessAuth == null ? null : JSON.stringify(harnessAuth),
                backendId !== undefined,
                backendId ?? null,
                plugins !== undefined,
                nextPlugins === undefined ? null : JSON.stringify(nextPlugins),
                pluginApprovers !== undefined,
                nextPluginApprovers === undefined ? null : JSON.stringify(nextPluginApprovers),
                repositoryBindings !== undefined,
                nextRepositoryBindings === undefined
                  ? null
                  : JSON.stringify(nextRepositoryBindings),
                repositoryAccess !== undefined || repositoryBindings !== undefined,
                repositoryAccess == null
                  ? null
                  : JSON.stringify(
                      normalizedRepositoryAccess(repositoryAccess, nextRepositoryBindings),
                    ),
                nextCredentialSources !== undefined,
                nextCredentialSources === undefined || nextCredentialSources.length === 0
                  ? null
                  : JSON.stringify(nextCredentialSources),
              ],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      compareAndSetActiveRevision: async (
        namespaceId,
        agentId,
        expectedRevisionId,
        candidateRevisionId,
      ) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET active_revision_id = $4
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                AND a.active_revision_id IS NOT DISTINCT FROM $3::text
                  AND n.id = a.namespace_id AND n.deleted_at IS NULL
                  RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                          a.active_revision_id, a.desired_runtime_state, a.status, a.created_at`,
              [namespaceId, agentId, expectedRevisionId ?? null, candidateRevisionId],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      compareAndClearActiveRevision: async (namespaceId, agentId, expectedRevisionId) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET active_revision_id = NULL
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2 AND a.active_revision_id = $3
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                         a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                         a.active_revision_id, a.desired_runtime_state, a.status, a.created_at`,
              [namespaceId, agentId, expectedRevisionId],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      transitionAgentDesiredRuntimeState: async (namespaceId, agentId, expected, next) => {
        const expectedStates = Array.isArray(expected) ? expected : [expected];
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET desired_runtime_state = $4
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND a.desired_runtime_state = ANY($3::text[])
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                         a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                         a.active_revision_id, a.desired_runtime_state, a.status, a.created_at`,
              [namespaceId, agentId, expectedStates, next],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      transitionAgentStatus: async (namespaceId, agentId, expected, next) => {
        const expectedStatuses = Array.isArray(expected) ? expected : [expected];
        // Only a row currently holding one of the expected statuses matches, as
        // in transitionNamespaceStatus. Callers that treat an already-deleting
        // Agent as success check its status before transitioning.
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET status = $4
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND a.status = ANY($3::text[])
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
               RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                         a.backend_id, a.plugins, a.plugin_approvers, a.repository_bindings, a.repository_access, a.service_principal_id, a.harness_auth, a.credential_sources,
                         a.active_revision_id, a.desired_runtime_state, a.status, a.created_at`,
              [namespaceId, agentId, expectedStatuses, next],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
    };

    const findRevisionRow = async (
      namespaceId: string,
      agentId: string,
      revisionId: string,
    ): Promise<PostgresRow | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.backend_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 AND r.id = $3`,
            [namespaceId, agentId, revisionId],
          )
        ).rows,
      )[0];
      return found;
    };

    const listRevisionRows = async (
      namespaceId: string,
      agentId: string,
    ): Promise<PostgresRow[]> => {
      const found = rows(
        (
          await client.query(
            `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.backend_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 ORDER BY r.revision_number`,
            [namespaceId, agentId],
          )
        ).rows,
      );
      return found;
    };

    const revisions: AgentRevisionRepository = {
      findRevision: async (namespaceId, agentId, revisionId) => {
        const row = await findRevisionRow(namespaceId, agentId, revisionId);
        return row === undefined ? undefined : revisionFromRow(row);
      },
      findRevisionForBrowsing: async (namespaceId, agentId, revisionId) => {
        const row = await findRevisionRow(namespaceId, agentId, revisionId);
        return row === undefined ? undefined : revisionForBrowsingFromRow(row);
      },
      listRevisions: async (namespaceId, agentId) =>
        Object.freeze(
          (await listRevisionRows(namespaceId, agentId)).map((row) => revisionFromRow(row)),
        ),
      listRevisionsForBrowsing: async (namespaceId, agentId) =>
        Object.freeze(
          (await listRevisionRows(namespaceId, agentId)).map(revisionForBrowsingFromRow),
        ),
      createRevision: async (revision) => {
        await this.requireInitialized(context);
        if (
          Object.hasOwn(revision, "serviceAccount") ||
          !validHarnessAuthSnapshot(revision.harnessAuth, revision.namespaceId) ||
          !validCredentialSourceSnapshots(revision.credentialSources)
        ) {
          throw new ScopeViolationError(
            "The AgentRevision harness authentication is invalid or legacy.",
          );
        }
        await assertHarnessAuthAvailable(
          { secrets, serviceAccounts, credentialSources },
          revision.namespaceId,
          harnessAuthBindingFromSnapshot(revision.harnessAuth),
        );
        const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
        if (
          owner === undefined ||
          owner.servicePrincipalId !== revision.servicePrincipalId ||
          owner.backendId !== revision.backendId ||
          !harnessAuthMatches(owner.harnessAuth, revision.harnessAuth) ||
          !credentialSourcesMatch(owner.credentialSources, revision.credentialSources)
        ) {
          throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
        }
        const secretBindings =
          revision.secretBindings === undefined
            ? undefined
            : secretBindingsFromState(revision.secretBindings, revision.namespaceId);
        await validateSecretBindingsAvailable(revision.namespaceId, secretBindings);
        if (!validPluginRevisionState(revision.plugins)) {
          throw new ScopeViolationError("The AgentRevision plugin state is invalid.");
        }
        if (!validPluginApprovers(revision.pluginApprovers)) {
          throw new ScopeViolationError("The AgentRevision plugin approvers are invalid.");
        }
        await client.query(
          `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            revision.id,
            revision.namespaceId,
            revision.agentId,
            revision.revision,
            revision.backendId,
            JSON.stringify({
              configuration_id: revision.configurationId,
              configuration_kind: revision.configurationKind,
              configuration_generation: revision.configurationGeneration,
              draft_spec: revision.configuration,
              harness: revision.harness,
              compute: revision.compute,
              ...(revision.sandboxDriverId === undefined
                ? {}
                : { sandbox_driver_id: revision.sandboxDriverId }),
              ...(revision.secretDriverId === undefined
                ? {}
                : { secret_driver_id: revision.secretDriverId }),
              ...(secretBindings === undefined ? {} : { secret_bindings: secretBindings }),
              ...(revision.plugins === undefined ? {} : { plugins: revision.plugins }),
              ...(revision.pluginApprovers === undefined
                ? {}
                : { plugin_approvers: revision.pluginApprovers }),
              ...(revision.repositoryCredentials === undefined
                ? {}
                : { repository_credentials: revision.repositoryCredentials }),
              harness_auth: revision.harnessAuth,
              ...(revision.credentialSources === undefined
                ? {}
                : { credential_sources: revision.credentialSources }),
            }),
            revision.createdAt,
          ],
        );
        const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = revision;
        return immutableCopy({
          ...withoutSecretBindings,
          ...(secretBindings === undefined ? {} : { secretBindings }),
        });
      },
    };

    const roleFromRow = (row: PostgresRow): Readonly<Role> => {
      const namespaceId = optionalText(row, "namespace_id");
      const name = optionalText(row, "name");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        ...(name === undefined ? {} : { name }),
        permissions: permissions(row.permissions),
      });
    };

    const servicePrincipalFromRow = (row: PostgresRow): Readonly<ServicePrincipal> =>
      Object.freeze({
        kind: "service_principal",
        id: text(row, "id"),
        namespaceId: text(row, "namespace_id"),
      });

    const accessBindingFromRow = (row: PostgresRow): Readonly<AccessBinding> => {
      const namespaceId = optionalText(row, "namespace_id");
      const resourceKind = optionalText(row, "resource_kind");
      const resourceId = optionalText(row, "resource_id");
      const identitySubjectId = optionalText(row, "identity_subject_id");
      const groupSubjectId = optionalText(row, "group_subject_id");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        subjectKind: identitySubjectId === undefined ? "group" : "identity",
        subjectId: identitySubjectId ?? groupSubjectId!,
        roleId: text(row, "role_id"),
        ...(resourceKind === undefined
          ? {}
          : { resourceKind: resourceKind as NonNullable<AccessBinding["resourceKind"]> }),
        ...(resourceId === undefined ? {} : { resourceId }),
      });
    };

    const lockTarget = async (
      namespaceId: string,
      resourceKind: NonNullable<AccessBinding["resourceKind"]>,
      resourceId: string,
    ): Promise<boolean> => {
      const queryByKind: Record<string, string> = {
        namespace: "SELECT 1 FROM occ.namespaces WHERE id = $1 AND id = $2 FOR KEY SHARE",
        // Status can change without changing a key. SHARE also fences the
        // active -> deleting transition until the policy transaction settles.
        agent:
          "SELECT 1 FROM occ.agents WHERE namespace_id = $1 AND id = $2 AND status = 'active' FOR SHARE",
        // A revision of a deleting Agent is removed with it, so it admits no new binding.
        agent_revision: `SELECT 1 FROM occ.agent_revisions AS r
           JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
           WHERE r.namespace_id = $1 AND r.id = $2 AND a.status = 'active'
           FOR SHARE OF a`,
        configuration:
          "SELECT 1 FROM occ.configurations WHERE namespace_id = $1 AND id = $2 FOR KEY SHARE",
        preset: "SELECT 1 FROM occ.presets WHERE namespace_id = $1 AND id = $2 FOR KEY SHARE",
        secret: "SELECT 1 FROM occ.secrets WHERE namespace_id = $1 AND id = $2 FOR KEY SHARE",
        credential_source:
          "SELECT 1 FROM occ.credential_sources WHERE namespace_id = $1 AND id = $2 FOR KEY SHARE",
        service_account:
          "SELECT 1 FROM occ.service_accounts WHERE namespace_id = $1 AND id = $2 FOR KEY SHARE",
      };
      const query = queryByKind[resourceKind];
      if (query === undefined) {
        return false;
      }
      const found = await client.query(query, [namespaceId, resourceId]);
      return found.rowCount === 1;
    };

    const iamPolicy: IAMPolicyRepository = {
      listRoles: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                "SELECT id, namespace_id, name, permissions FROM occ.iam_roles WHERE namespace_id = $1 ORDER BY id",
                [namespaceId],
              )
            ).rows,
          ).map(roleFromRow),
        ),
      getRole: async (namespaceId, roleId) => {
        const found = rows(
          (
            await client.query(
              "SELECT id, namespace_id, name, permissions FROM occ.iam_roles WHERE namespace_id = $1 AND id = $2",
              [namespaceId, roleId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : roleFromRow(found);
      },
      createRole: async (role) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(role.namespaceId ?? "");
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready") ||
          role.namespaceId !== namespace.id ||
          role.permissions.length === 0
        ) {
          throw new ScopeViolationError("The IAM Role must belong to an available Namespace.");
        }
        if (namespaceRoleGrantsBeyondRead(role)) {
          throw new ScopeViolationError("Namespace IAM Roles support only Namespace read.");
        }
        await client.query(
          "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
          [role.id, namespace.id, role.name ?? null, JSON.stringify(role.permissions)],
        );
        return immutableCopy(role);
      },
      deleteRole: async (namespaceId, roleId) => {
        const existing = await iamPolicy.getRole(namespaceId, roleId);
        if (existing === undefined) {
          return false;
        }
        const references = await client.query(
          "SELECT 1 FROM occ.iam_access_bindings WHERE namespace_id = $1 AND role_id = $2 LIMIT 1",
          [namespaceId, roleId],
        );
        if (references.rowCount !== 0) {
          throw new IAMRoleInUseError();
        }
        const deleted = await client.query(
          "DELETE FROM occ.iam_roles WHERE namespace_id = $1 AND id = $2",
          [namespaceId, roleId],
        );
        return deleted.rowCount === 1;
      },
      listAccessBindings: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT id, namespace_id, identity_subject_id, group_subject_id, role_id,
                        resource_kind, resource_id
                 FROM occ.iam_access_bindings
                 WHERE namespace_id = $1 ORDER BY id`,
                [namespaceId],
              )
            ).rows,
          ).map(accessBindingFromRow),
        ),
      // Not Namespace-scoped: the Agent deletion finalizer's DELETE is not either, and an
      // Installation Restriction (no Namespace) may name a Namespace resource.
      listRestrictionsTargeting: async (resourceKind, resourceIds) =>
        Object.freeze(
          resourceIds.length === 0
            ? []
            : rows(
                (
                  await client.query(
                    `SELECT id, namespace_id, action, resource_kind, resource_id, effect
                     FROM occ.iam_restrictions
                     WHERE resource_kind = $1 AND resource_id = ANY($2::text[]) ORDER BY id`,
                    [resourceKind, [...resourceIds]],
                  )
                ).rows,
              ).map(restrictionFromRow),
        ),
      getAccessBinding: async (namespaceId, bindingId) => {
        const found = rows(
          (
            await client.query(
              `SELECT id, namespace_id, identity_subject_id, group_subject_id, role_id,
                      resource_kind, resource_id
               FROM occ.iam_access_bindings
               WHERE namespace_id = $1 AND id = $2`,
              [namespaceId, bindingId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : accessBindingFromRow(found);
      },
      createAccessBinding: async (binding) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(binding.namespaceId ?? "");
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready") ||
          binding.namespaceId !== namespace.id ||
          binding.subjectKind !== "identity" ||
          binding.resourceKind === undefined ||
          binding.resourceId === undefined
        ) {
          throw new ScopeViolationError(
            "The IAM AccessBinding must belong to an available Namespace.",
          );
        }
        // Same subject rule as the in-memory adapter: a human without a Namespace, a
        // non-Agent ServicePrincipal of the exact Namespace, or the ServicePrincipal of a
        // live Agent there. The Agent owner key is deferred, so it cannot vouch mid-unit.
        // Deleting the Agent removes bindings for its ServicePrincipal, so SHARE fences
        // the active -> deleting transition until this policy transaction settles (the
        // Namespace lock above already serializes with deletion; this keeps the fence
        // local to the Agent row, as lockTarget does for Agent targets).
        await client.query(
          `SELECT 1 FROM occ.agents
           WHERE namespace_id = $1 AND service_principal_id = $2 FOR SHARE`,
          [namespace.id, binding.subjectId],
        );
        const identity = await client.query(
          `SELECT 1 FROM occ.iam_identities AS i
           WHERE i.id = $2 AND (
             (i.kind = 'principal' AND i.namespace_id IS NULL) OR
             (i.kind = 'service_principal' AND i.namespace_id = $1 AND (
               i.agent_id IS NULL OR EXISTS (
                 SELECT 1 FROM occ.agents AS a
                 WHERE a.namespace_id = $1 AND a.id = i.agent_id
                   AND a.service_principal_id = i.id AND a.status = 'active'
               )
             ))
           )`,
          [namespace.id, binding.subjectId],
        );
        if (identity.rowCount !== 1) {
          throw new IAMPolicyValidationError(
            "/subjectId",
            "The IAM AccessBinding subject must be a human Principal, a non-Agent ServicePrincipal of this Namespace, or the ServicePrincipal of a live Agent here.",
          );
        }
        const role = await iamPolicy.getRole(namespace.id, binding.roleId);
        if (role === undefined) {
          throw new IAMPolicyValidationError(
            "/roleId",
            "The IAM AccessBinding Role does not exist in this Namespace.",
          );
        }
        if (binding.resourceKind === "namespace" && namespaceRoleGrantsBeyondRead(role)) {
          throw new IAMPolicyValidationError(
            "/roleId",
            "Namespace IAM Roles support only Namespace read.",
          );
        }
        if (!(await lockTarget(namespace.id, binding.resourceKind, binding.resourceId))) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM AccessBinding target does not exist in this Namespace or is being deleted.",
          );
        }
        await client.query(
          `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, group_subject_id, role_id,
            resource_kind, resource_id)
           VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
          [
            binding.id,
            namespace.id,
            binding.subjectId,
            binding.roleId,
            binding.resourceKind,
            binding.resourceId,
          ],
        );
        return immutableCopy(binding);
      },
      deleteAccessBinding: async (namespaceId, bindingId) => {
        const deleted = await client.query(
          "DELETE FROM occ.iam_access_bindings WHERE namespace_id = $1 AND id = $2",
          [namespaceId, bindingId],
        );
        return deleted.rowCount === 1;
      },
      listServicePrincipals: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT id, namespace_id FROM occ.iam_identities
                 WHERE kind = 'service_principal' AND namespace_id = $1 AND agent_id IS NULL
                 ORDER BY id`,
                [namespaceId],
              )
            ).rows,
          ).map(servicePrincipalFromRow),
        ),
      getServicePrincipal: async (namespaceId, servicePrincipalId) => {
        const found = rows(
          (
            await client.query(
              `SELECT id, namespace_id FROM occ.iam_identities
               WHERE kind = 'service_principal' AND namespace_id = $1 AND agent_id IS NULL
                 AND id = $2`,
              [namespaceId, servicePrincipalId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : servicePrincipalFromRow(found);
      },
      createServicePrincipal: async (servicePrincipal) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(servicePrincipal.namespaceId ?? "");
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready") ||
          servicePrincipal.namespaceId !== namespace.id ||
          servicePrincipal.agentId !== undefined
        ) {
          throw new ScopeViolationError(
            "The ServicePrincipal must belong to an available Namespace.",
          );
        }
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
           VALUES ($1, $2, NULL, 'service_principal', NULL, NULL)`,
          [servicePrincipal.id, namespace.id],
        );
        return servicePrincipalFromRow({ id: servicePrincipal.id, namespace_id: namespace.id });
      },
    };

    return {
      installations,
      namespaces,
      configurations,
      presets,
      secrets,
      credentialSources,
      serviceAccounts,
      agents,
      workspaceSetups,
      revisions,
      iamPolicy,
      repositorySessions: postgresRepositorySessions(client),
      provisioning: {
        findByWorkId: async (workId) => {
          const found = rows(
            (
              await client.query("SELECT * FROM occ.agent_provisioning_work WHERE work_id = $1", [
                workId,
              ])
            ).rows,
          );
          return found[0] === undefined ? undefined : provisioningRecordFromRow(found[0]);
        },
        findWithWork: async (workId) => {
          // One statement, one snapshot: separate reads under READ COMMITTED can pair a
          // job with a queue row from a later commit (a failed queue row, a running job).
          const found = rows(
            (
              await client.query(
                `SELECT provisioning.*, to_jsonb(work) AS controller_work
                 FROM occ.agent_provisioning_work AS provisioning
                 LEFT JOIN occ.controller_work AS work
                   ON work.idempotency_key = provisioning.work_id
                 WHERE provisioning.work_id = $1`,
                [workId],
              )
            ).rows,
          );
          if (found[0] === undefined) {
            return undefined;
          }
          const work = found[0].controller_work;
          return Object.freeze({
            record: provisioningRecordFromRow(found[0]),
            ...(work === null || work === undefined ? {} : { work: asWork(work) }),
          });
        },
        hasPendingNamespaceProvisioning: async (namespaceId) => {
          // An external write is unresolved until a receipt matches its pending effect
          // exactly, the rule occ.finalize_agent_deletion applies. A settled effect on
          // terminal work is history, not work in flight. Missing or malformed
          // evidence still blocks deletion.
          const found = await client.query(
            `SELECT 1
             FROM occ.agent_provisioning_work AS provisioning
             JOIN occ.controller_work AS work
               ON work.idempotency_key = provisioning.work_id
             WHERE provisioning.namespace_id = $1
               AND (
                 (
                   (
                     provisioning.progress ? 'pendingEffect'
                     OR provisioning.progress ? 'effectReceipt'
                   )
                   AND NOT COALESCE(
                     provisioning.progress->'effectReceipt'->>'kind' =
                       provisioning.progress->'pendingEffect'->>'kind'
                     AND provisioning.progress->'effectReceipt'->>'owner' =
                       provisioning.progress->'pendingEffect'->>'owner'
                     AND provisioning.progress->'effectReceipt'->>'targetId' =
                       provisioning.progress->'pendingEffect'->>'targetId',
                     false
                   )
                 )
                 OR provisioning.status IN ('queued', 'running')
                 OR work.state IN ('queued', 'claimed')
               )
             LIMIT 1`,
            [namespaceId],
          );
          return (found.rowCount ?? 0) > 0;
        },
        findByAgent: async (namespaceId, agentId) => {
          const found = rows(
            (
              await client.query(
                `SELECT * FROM occ.agent_provisioning_work
                 WHERE namespace_id = $1 AND agent_id = $2`,
                [namespaceId, agentId],
              )
            ).rows,
          );
          return found[0] === undefined ? undefined : provisioningRecordFromRow(found[0]);
        },
        findByConfiguration: async (namespaceId, configurationId) => {
          const found = rows(
            (
              await client.query(
                `SELECT * FROM occ.agent_provisioning_work
                 WHERE namespace_id = $1 AND configuration_id = $2`,
                [namespaceId, configurationId],
              )
            ).rows,
          );
          return found[0] === undefined ? undefined : provisioningRecordFromRow(found[0]);
        },
        findByRequest: async (namespaceId, actorId, requestId) => {
          const found = rows(
            (
              await client.query(
                `SELECT * FROM occ.agent_provisioning_work
                 WHERE namespace_id = $1 AND actor_id = $2 AND request_id = $3`,
                [namespaceId, actorId, requestId],
              )
            ).rows,
          );
          return found[0] === undefined ? undefined : provisioningRecordFromRow(found[0]);
        },
        create: async (input: CreateAgentProvisioningRecord) => {
          const record = validateProvisioningCreate(input);
          await this.requireInitialized(context);
          await queue.enqueue({
            kind: "provisioning",
            idempotencyKey: record.workId,
            namespaceId: record.namespaceId,
            actorId: record.actorId,
          });
          const inserted = rows(
            (
              await client.query(
                `INSERT INTO occ.agent_provisioning_work (
                   work_id, namespace_id, actor_id, request_id, request_fingerprint,
                   status, completed_phase, plan, progress, created_at, updated_at
                 )
                 SELECT work.idempotency_key, work.namespace_id, work.actor_id, $3::text,
                   $4::text, 'queued', 'admitted', $5::jsonb, '{}'::jsonb,
                   clock_timestamp(), clock_timestamp()
                 FROM occ.controller_work AS work
                 WHERE work.idempotency_key = $1
                   AND work.work_kind = 'provisioning'
                   AND work.namespace_id = $2
                   AND work.agent_id IS NULL
                   AND work.actor_id = $6
                   AND work.revision_id IS NULL
                   AND work.namespace_target IS NULL
                   AND work.agent_target IS NULL
                 ON CONFLICT (namespace_id, actor_id, request_id) DO NOTHING
                 RETURNING *`,
                [
                  record.workId,
                  record.namespaceId,
                  record.requestId,
                  record.requestFingerprint,
                  JSON.stringify(record.plan),
                  record.actorId,
                ],
              )
            ).rows,
          );
          if (inserted[0] !== undefined) {
            return Object.freeze({
              record: provisioningRecordFromRow(inserted[0]),
              replayed: false,
            });
          }
          const existing = await this.repositories(context).provisioning.findByRequest(
            record.namespaceId,
            record.actorId,
            record.requestId,
          );
          if (existing === undefined) {
            throw new ResourceConflictError(
              "The Agent provisioning work could not be reserved with its accepted plan.",
            );
          }
          validateProvisioningReplay(existing, record);
          return Object.freeze({ record: existing, replayed: true });
        },
        beginEffect: async (claim, effect) => {
          const current = await this.repositories(context).provisioning.findByWorkId(
            claim.idempotencyKey,
          );
          if (current === undefined) {
            throw new ResourceConflictError("The Agent provisioning record is unavailable.");
          }
          const progress = beginProvisioningEffectProgress(current, effect);
          const updated = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
                   SELECT work.*
                   FROM occ.controller_work AS work
                   JOIN occ.agent_provisioning_work AS provisioning
                     ON provisioning.work_id = work.idempotency_key
                   WHERE provisioning.work_id = $1
                     AND work.work_kind = 'provisioning'
                     AND work.namespace_id = provisioning.namespace_id
                     AND work.agent_id IS NULL
                     AND work.actor_id = provisioning.actor_id
                     AND work.revision_id IS NULL
                     AND work.namespace_target IS NULL
                     AND work.agent_target IS NULL
                     AND work.state = 'claimed'
                     AND work.claim_token = $2::uuid
                     AND work.lease_expires_at > clock_timestamp()
                   FOR UPDATE OF work
                 ), updated_provisioning AS (
                   UPDATE occ.agent_provisioning_work AS provisioning
                   SET status = 'running',
                       -- The database clock stamps the effect, so a later attempt on any
                       -- replica can age it against updated_at (finding 911).
                       progress = jsonb_set(
                         $3::jsonb,
                         '{pendingEffect,startedAt}',
                         to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                       ),
                       updated_at = clock_timestamp()
                   FROM owner
                   WHERE provisioning.work_id = owner.idempotency_key
                     AND provisioning.status NOT IN ('failed', 'succeeded', 'cancelled')
                     AND NOT (provisioning.progress ? 'pendingEffect')
                     AND NOT (provisioning.progress ? 'effectReceipt')
                   RETURNING provisioning.*
                 )
                 SELECT * FROM updated_provisioning`,
                [claim.idempotencyKey, claim.claimToken, JSON.stringify(progress)],
              )
            ).rows,
          );
          if (updated[0] === undefined) {
            throw new WorkClaimLostError();
          }
          return provisioningRecordFromRow(updated[0]);
        },
        checkpoint: async (claim, checkpoint: AgentProvisioningCheckpoint) => {
          const next = validateProvisioningCheckpoint(checkpoint);
          const current = await this.repositories(context).provisioning.findByWorkId(
            claim.idempotencyKey,
          );
          if (current === undefined) {
            throw new ResourceConflictError("The Agent provisioning record is unavailable.");
          }
          validateProvisioningProgressStep(current, next);
          if (next.status === "failed" || next.status === "cancelled") {
            throw new ScopeViolationError(
              "Agent provisioning terminal failures must use their lifecycle repository methods.",
            );
          }
          if (
            next.status === "succeeded" &&
            (next.completedPhase !== "handoff" || next.revisionId === undefined)
          ) {
            throw new ScopeViolationError(
              "Agent provisioning success requires the exact handoff revision.",
            );
          }
          if (
            current.status === "cancelled" ||
            current.status === "failed" ||
            current.status === "succeeded"
          ) {
            throw new ScopeViolationError(
              "Terminal Agent provisioning work cannot be checkpointed.",
            );
          }
          const updated = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
                   SELECT work.*
                   FROM occ.controller_work AS work
                   JOIN occ.agent_provisioning_work AS provisioning
                     ON provisioning.work_id = work.idempotency_key
	                   WHERE provisioning.work_id = $1
	                     AND work.work_kind = 'provisioning'
	                     AND work.namespace_id = provisioning.namespace_id
		                     AND work.agent_id IS NULL
	                     AND work.actor_id = provisioning.actor_id
	                     AND work.revision_id IS NULL
	                     AND work.namespace_target IS NULL
	                     AND work.agent_target IS NULL
	                     AND work.state = 'claimed'
	                     AND work.claim_token = $2::uuid
	                     AND work.lease_expires_at > clock_timestamp()
                   FOR UPDATE OF work
                 ), updated_provisioning AS (
                   UPDATE occ.agent_provisioning_work AS provisioning
                   SET completed_phase = $3::text,
                       status = COALESCE($4::text, provisioning.status),
                       agent_id = COALESCE($5::text, provisioning.agent_id),
                       configuration_id = COALESCE($6::text, provisioning.configuration_id),
                       revision_id = COALESCE($7::text, provisioning.revision_id),
                       progress = COALESCE($8::jsonb, provisioning.progress),
                       updated_at = clock_timestamp()
                   FROM owner
	                   WHERE provisioning.work_id = owner.idempotency_key
	                     AND provisioning.status NOT IN ('failed', 'succeeded', 'cancelled')
	                     AND provisioning.progress = $9::jsonb
	                   RETURNING provisioning.*
	                 ), completed_work AS (
                   UPDATE occ.controller_work AS work
                   SET state = 'succeeded',
                       claim_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = clock_timestamp(),
                       reason_code = 'PROVISIONING_HANDOFF',
                       result_data = NULL,
                       updated_at = clock_timestamp()
                   WHERE $4::text = 'succeeded'
                     AND $3::text = 'handoff'
                     AND work.idempotency_key = $1
                     AND EXISTS (SELECT 1 FROM updated_provisioning)
                   RETURNING work.idempotency_key
                 )
                 SELECT * FROM updated_provisioning`,
                [
                  claim.idempotencyKey,
                  claim.claimToken,
                  next.completedPhase,
                  next.status ?? null,
                  next.agentId ?? null,
                  next.configurationId ?? null,
                  next.revisionId ?? null,
                  next.progress === undefined ? null : JSON.stringify(next.progress),
                  JSON.stringify(current.progress),
                ],
              )
            ).rows,
          );
          if (updated[0] === undefined) {
            throw new WorkClaimLostError();
          }
          return provisioningRecordFromRow(updated[0]);
        },
        recordFailure: async (
          claim,
          checkpoint: AgentProvisioningCheckpoint,
          failure: AgentProvisioningFailure,
        ) => {
          const next = validateProvisioningCheckpoint(checkpoint);
          const failed = validateProvisioningFailure(failure);
          if (next.status === "succeeded" || next.status === "cancelled") {
            throw new ScopeViolationError(
              "Agent provisioning failure cannot record success or cancellation.",
            );
          }
          const current = await this.repositories(context).provisioning.findByWorkId(
            claim.idempotencyKey,
          );
          if (current === undefined) {
            throw new ResourceConflictError("The Agent provisioning record is unavailable.");
          }
          validateProvisioningProgressStep(current, next);
          if (
            current.status === "cancelled" ||
            current.status === "failed" ||
            current.status === "succeeded"
          ) {
            throw new ScopeViolationError("Terminal Agent provisioning work cannot fail again.");
          }
          // A permanent or exhausted failure's queue transition locks the Namespace for
          // cleanup. Take it before the work row: stopping or deleting the provisioned Agent
          // locks the Namespace, then the Agent, then this work row (cancelByAgent).
          await namespaces.lockNamespace(current.namespaceId, { includeDeleted: true });
          const checkpointed = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
	                   SELECT work.*
	                   FROM occ.controller_work AS work
	                   JOIN occ.agent_provisioning_work AS provisioning
	                     ON provisioning.work_id = work.idempotency_key
	                   WHERE provisioning.work_id = $1
	                     AND work.work_kind = 'provisioning'
	                     AND work.namespace_id = provisioning.namespace_id
		                     AND work.agent_id IS NULL
	                     AND work.actor_id = provisioning.actor_id
	                     AND work.revision_id IS NULL
	                     AND work.namespace_target IS NULL
	                     AND work.agent_target IS NULL
	                     AND work.state = 'claimed'
	                     AND work.claim_token = $2::uuid
	                     AND work.lease_expires_at > clock_timestamp()
	                   FOR UPDATE OF work
	                 ), updated_provisioning AS (
	                   UPDATE occ.agent_provisioning_work AS provisioning
	                   SET completed_phase = $3::text,
	                       status = CASE
		                         WHEN $10::text = 'permanent' THEN 'failed'
		                         ELSE 'running'
		                       END,
		                       agent_id = COALESCE($4::text, provisioning.agent_id),
		                       configuration_id = COALESCE($5::text, provisioning.configuration_id),
		                       revision_id = COALESCE($6::text, provisioning.revision_id),
		                       progress = COALESCE($7::jsonb, provisioning.progress) ||
		                         jsonb_build_object(
		                           'error',
		                           jsonb_build_object('code', $8::text, 'message', $9::text)
		                         ),
		                       updated_at = clock_timestamp()
	                   FROM owner
	                   WHERE provisioning.work_id = owner.idempotency_key
	                     AND provisioning.status NOT IN ('failed', 'succeeded', 'cancelled')
	                     AND provisioning.progress = $11::jsonb
	                   RETURNING provisioning.*
	                 )
	                 SELECT * FROM updated_provisioning`,
                [
                  claim.idempotencyKey,
                  claim.claimToken,
                  next.completedPhase,
                  next.agentId ?? null,
                  next.configurationId ?? null,
                  next.revisionId ?? null,
                  next.progress === undefined ? null : JSON.stringify(next.progress),
                  failed.code,
                  failed.message,
                  failed.disposition,
                  JSON.stringify(current.progress),
                ],
              )
            ).rows,
          );
          if (checkpointed[0] === undefined) {
            throw new WorkClaimLostError();
          }
          if (failed.disposition === "permanent") {
            await queue.fail(claim, { code: failed.code });
            return provisioningRecordFromRow(checkpointed[0]);
          }
          if (failed.disposition === "defer") {
            // The provisioning failure audit the caller appends already records this wait.
            await queue.defer(
              claim,
              { code: failed.code },
              { delayMs: failed.delayMs!, recordEvidence: false },
            );
            return provisioningRecordFromRow(checkpointed[0]);
          }
          await queue.retry(claim, { code: failed.code });
          const work = await queue.findWork(claim.idempotencyKey);
          if (work?.state !== "failed_permanent") {
            return provisioningRecordFromRow(checkpointed[0]);
          }
          const terminal = rows(
            (
              await client.query(
                `SELECT * FROM occ.agent_provisioning_work
                 WHERE work_id = $1 AND status = 'failed'`,
                [claim.idempotencyKey],
              )
            ).rows,
          );
          if (terminal[0] === undefined) {
            throw new ResourceConflictError(
              "The Agent provisioning retry exhaustion was not recorded.",
            );
          }
          return provisioningRecordFromRow(terminal[0]);
        },
        settleEffect: async (workId: string, input: AgentProvisioningEffectSettlement) => {
          const settlement = validateProvisioningEffectSettlement(input);
          const receiptJson = JSON.stringify(settlement);
          const settled = rows(
            (
              await client.query(
                `WITH matched AS MATERIALIZED (
                   SELECT provisioning.*
                   FROM occ.agent_provisioning_work AS provisioning
                   WHERE provisioning.work_id = $1
                     AND provisioning.progress -> 'pendingEffect' ->> 'kind' = $2
                     AND provisioning.progress -> 'pendingEffect' ->> 'owner' = $3
                     AND provisioning.progress -> 'pendingEffect' ->> 'targetId' = $4
	                   FOR UPDATE
	                 ), updated_provisioning AS (
	                   UPDATE occ.agent_provisioning_work AS provisioning
	                   SET progress = provisioning.progress ||
	                         jsonb_build_object('effectReceipt', $5::jsonb),
	                       updated_at = clock_timestamp()
                   FROM matched
                   WHERE provisioning.work_id = matched.work_id
                     AND (
                       NOT (provisioning.progress ? 'effectReceipt')
	                       OR provisioning.progress -> 'effectReceipt' = $5::jsonb
                     )
                   RETURNING provisioning.*
                 )
                 SELECT * FROM updated_provisioning`,
                [workId, settlement.kind, settlement.owner, settlement.targetId, receiptJson],
              )
            ).rows,
          );
          if (settled[0] === undefined) {
            throw new ResourceConflictError(
              "The Agent provisioning effect settlement does not match.",
            );
          }
          return provisioningRecordFromRow(settled[0]);
        },
        cancel: async (claim, error) => {
          const code = typeof error.code === "string" ? error.code : "";
          const message = typeof error.message === "string" ? error.message : "";
          if (code.length === 0 || message.length === 0) {
            throw new ScopeViolationError(
              "Agent provisioning cancellation requires a safe reason.",
            );
          }
          const cancelled = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
                   SELECT work.*
                   FROM occ.controller_work AS work
                   JOIN occ.agent_provisioning_work AS provisioning
                     ON provisioning.work_id = work.idempotency_key
                   WHERE provisioning.work_id = $1
	                     AND work.work_kind = 'provisioning'
	                     AND work.namespace_id = provisioning.namespace_id
		                     AND work.agent_id IS NULL
	                     AND work.actor_id = provisioning.actor_id
	                     AND work.revision_id IS NULL
	                     AND work.namespace_target IS NULL
	                     AND work.agent_target IS NULL
	                     AND work.state = 'claimed'
	                     AND work.claim_token = $2::uuid
	                     AND work.lease_expires_at > clock_timestamp()
                   FOR UPDATE OF work
                 ), updated_provisioning AS (
	                   UPDATE occ.agent_provisioning_work AS provisioning
		                   SET status = 'cancelled',
		                       progress = provisioning.progress || jsonb_build_object(
		                         'error', jsonb_build_object('code', $3::text, 'message', $4::text)
		                       ),
		                       updated_at = clock_timestamp()
	                   FROM owner
	                   WHERE provisioning.work_id = owner.idempotency_key
	                     AND provisioning.status NOT IN ('failed', 'succeeded', 'cancelled')
	                   RETURNING provisioning.*
                 ), completed_work AS (
                   UPDATE occ.controller_work AS work
                   SET state = 'failed_permanent',
                       claim_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = clock_timestamp(),
                       reason_code = 'PROVISIONING_CANCELLED',
                       result_data = NULL,
                       updated_at = clock_timestamp()
                   WHERE work.idempotency_key = $1
                     AND EXISTS (SELECT 1 FROM updated_provisioning)
                   RETURNING work.idempotency_key
                 )
                 SELECT * FROM updated_provisioning`,
                [claim.idempotencyKey, claim.claimToken, code, message],
              )
            ).rows,
          );
          if (cancelled[0] === undefined) {
            throw new WorkClaimLostError();
          }
          return provisioningRecordFromRow(cancelled[0]);
        },
        cancelByAgent: async (namespaceId, agentId, error) => {
          const code = typeof error.code === "string" ? error.code : "";
          const message = typeof error.message === "string" ? error.message : "";
          if (code.length === 0 || message.length === 0) {
            throw new ScopeViolationError(
              "Agent provisioning cancellation requires a safe reason.",
            );
          }
          const cancelled = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
                   SELECT work.*
                   FROM occ.controller_work AS work
                   JOIN occ.agent_provisioning_work AS provisioning
                     ON provisioning.work_id = work.idempotency_key
                   WHERE provisioning.namespace_id = $1
	                     AND provisioning.agent_id = $2
	                     AND provisioning.status NOT IN ('cancelled', 'succeeded')
	                     AND provisioning.revision_id IS NULL
	                     AND work.work_kind = 'provisioning'
	                     AND work.namespace_id = provisioning.namespace_id
		                     AND work.agent_id IS NULL
	                     AND work.actor_id = provisioning.actor_id
	                     AND work.revision_id IS NULL
	                     AND work.namespace_target IS NULL
	                     AND work.agent_target IS NULL
	                     AND work.state IN ('queued', 'claimed', 'failed_permanent')
	                   FOR UPDATE OF work
	                 ), updated_provisioning AS (
	                   UPDATE occ.agent_provisioning_work AS provisioning
		                   SET status = 'cancelled',
		                       progress = provisioning.progress || jsonb_build_object(
		                         'error', jsonb_build_object('code', $3::text, 'message', $4::text)
		                       ),
		                       updated_at = clock_timestamp()
                   FROM owner
                   WHERE provisioning.work_id = owner.idempotency_key
                   RETURNING provisioning.*
                 ), completed_work AS (
                   UPDATE occ.controller_work AS work
                   SET state = 'failed_permanent',
                       claim_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = clock_timestamp(),
                       reason_code = 'PROVISIONING_CANCELLED',
                       result_data = NULL,
                       updated_at = clock_timestamp()
                   FROM owner
                   WHERE work.idempotency_key = owner.idempotency_key
                     AND EXISTS (SELECT 1 FROM updated_provisioning)
                   RETURNING work.idempotency_key
                 )
                 SELECT * FROM updated_provisioning`,
                [namespaceId, agentId, code, message],
              )
            ).rows,
          );
          return cancelled[0] === undefined ? undefined : provisioningRecordFromRow(cancelled[0]);
        },
        retryByWorkId: async (namespaceId, workId, actorId) => {
          const retried = rows(
            (
              await client.query(
                `WITH owner AS MATERIALIZED (
                   SELECT work.*
                   FROM occ.controller_work AS work
                   JOIN occ.agent_provisioning_work AS provisioning
                     ON provisioning.work_id = work.idempotency_key
                   WHERE provisioning.namespace_id = $1
                     AND provisioning.work_id = $2
                     AND provisioning.actor_id = $3
	                     AND provisioning.status = 'failed'
	                     AND provisioning.revision_id IS NULL
	                     AND work.work_kind = 'provisioning'
	                     AND work.namespace_id = provisioning.namespace_id
		                     AND work.agent_id IS NULL
	                     AND work.actor_id = provisioning.actor_id
	                     AND work.revision_id IS NULL
	                     AND work.namespace_target IS NULL
	                     AND work.agent_target IS NULL
	                     AND work.state = 'failed_permanent'
	                   FOR UPDATE OF work
                 ), updated_provisioning AS (
                   UPDATE occ.agent_provisioning_work AS provisioning
                   SET status = 'queued',
                       updated_at = clock_timestamp()
                   FROM owner
                   WHERE provisioning.work_id = owner.idempotency_key
                   RETURNING provisioning.*
                 ), queued_work AS (
                   UPDATE occ.controller_work AS work
                   SET state = 'queued',
                       attempt_count = 0,
                       available_at = clock_timestamp(),
                       claim_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = NULL,
                       reason_code = NULL,
                       result_data = NULL,
                       updated_at = clock_timestamp()
                   FROM owner
                   WHERE work.idempotency_key = owner.idempotency_key
                     AND EXISTS (SELECT 1 FROM updated_provisioning)
                   RETURNING work.idempotency_key
                 )
                 SELECT * FROM updated_provisioning`,
                [namespaceId, workId, actorId],
              )
            ).rows,
          );
          if (retried[0] === undefined) {
            throw new ResourceConflictError("The Agent provisioning work is not retryable.");
          }
          return provisioningRecordFromRow(retried[0]);
        },
        releaseConfiguration: async (namespaceId, configurationId) => {
          const released = await client.query(
            `UPDATE occ.agent_provisioning_work AS provisioning
             SET configuration_id = NULL,
                 updated_at = clock_timestamp()
             WHERE provisioning.namespace_id = $1
               AND provisioning.configuration_id = $2
               AND provisioning.status = 'succeeded'
               AND NOT EXISTS (
                 SELECT 1 FROM occ.agents AS agent
                 WHERE agent.namespace_id = provisioning.namespace_id
                   AND agent.id = provisioning.agent_id
                   AND agent.configuration_id = provisioning.configuration_id
               )`,
            [namespaceId, configurationId],
          );
          return released.rowCount === 1;
        },
      },
      audit: {
        append: async (event) => {
          await this.requireInstallation(context, event.installationId);
          if (event.resource.namespaceId !== event.namespaceId) {
            throw new ScopeViolationError("The audit event and resource scopes do not match.");
          }
          const details = auditDetails(event);
          await client.query(
            `INSERT INTO occ.audit_events
             (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
              outcome, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
            [
              event.id,
              event.occurredAt,
              event.kind,
              event.actorId,
              event.action,
              event.namespaceId ?? null,
              event.resource.kind,
              event.resource.id,
              event.outcome,
              details === undefined ? null : JSON.stringify(details),
            ],
          );
        },
        list: async () => {
          const installation = await this.currentInstallation(context);
          if (installation === undefined) {
            return Object.freeze([]);
          }
          const found = rows(
            (
              await client.query(
                `SELECT id, occurred_at, kind, actor_id, action, namespace_id, resource_kind,
                        resource_id, outcome, details
                 FROM occ.audit_events ORDER BY occurred_at, id`,
              )
            ).rows,
          );
          return Object.freeze(found.map((row) => auditFromRow(row, installation.id)));
        },
      },
      operations: {
        append: async (operation) => {
          await this.requireInitialized(context);
          const namespaceId = operation.namespaceId;
          if (namespaceId === undefined) {
            throw new ScopeViolationError("Controller work requires an exact Namespace owner.");
          }

          let agentId: string | undefined;
          let revisionId: string | undefined;
          let namespaceTarget: "ready" | "deleted" | undefined;
          let agentTarget: "stopped" | "deleted" | typeof CREDENTIAL_WITHDRAWAL_TARGET | undefined;
          if (operation.kind === "namespace") {
            if (namespaceId !== operation.resourceId) {
              throw new ScopeViolationError("Namespace work does not match its exact owner.");
            }
            namespaceTarget = operation.target;
          } else if (operation.kind === "agent_revision") {
            revisionId = operation.resourceId;
            const owner = rows(
              (
                await client.query(
                  "SELECT agent_id FROM occ.agent_revisions WHERE namespace_id = $1 AND id = $2",
                  [namespaceId, revisionId],
                )
              ).rows,
            )[0];
            if (owner === undefined) {
              throw new ScopeViolationError("AgentRevision work does not match its exact owner.");
            }
            agentId = text(owner, "agent_id");
            agentTarget = operation.target;
          } else if (operation.kind === "agent") {
            // Validate the Agent-wide target before resolving its exact owner.
            if (namespaceId === operation.resourceId) {
              throw new ScopeViolationError("Agent work must name its exact Agent.");
            }
            const owner = rows(
              (
                await client.query(
                  "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
                  [namespaceId, operation.resourceId],
                )
              ).rows,
            )[0];
            if (owner === undefined) {
              throw new ScopeViolationError("Agent work does not match its exact owner.");
            }
            agentId = text(owner, "id");
            agentTarget = operation.target;
          } else {
            throw new ScopeViolationError("Unsupported controller work resource kind.");
          }

          await queue.enqueue({
            idempotencyKey:
              operation.kind === "agent"
                ? operation.target === "stopped"
                  ? `agent:${operation.resourceId}:${operation.action}:${operation.target}:${operation.operationId}`
                  : `agent:${operation.resourceId}:${operation.action}:${operation.target}`
                : operation.kind === "agent_revision" &&
                    operation.target === CREDENTIAL_WITHDRAWAL_TARGET
                  ? credentialWithdrawalWorkKey(operation.resourceId, operation.operationId)
                  : `${operation.kind}:${operation.resourceId}:${operation.action}${
                      namespaceTarget === undefined ? "" : `:${namespaceTarget}`
                    }`,
            namespaceId,
            ...(agentId === undefined ? {} : { agentId }),
            ...(revisionId === undefined ? {} : { revisionId }),
            ...(namespaceTarget === undefined ? {} : { namespaceTarget }),
            ...(agentTarget === undefined ? {} : { agentTarget }),
            actorId: operation.actorId,
          });
        },
        list: async () => {
          await this.requireInitialized(context);
          const found = rows(
            (
              await client.query(
                `SELECT idempotency_key, namespace_id, agent_id, revision_id, actor_id,
                        namespace_target, agent_target
                 FROM occ.controller_work
                 WHERE work_kind = 'lifecycle'
                 ORDER BY created_at, idempotency_key`,
              )
            ).rows,
          );
          return Object.freeze(
            found.map((row): Readonly<PlatformOperation> => {
              const namespaceId = text(row, "namespace_id");
              const revisionId = optionalText(row, "revision_id");
              const agentId = optionalText(row, "agent_id");
              const base = {
                action: "reconcile" as const,
                namespaceId,
                resourceId: revisionId ?? agentId ?? namespaceId,
                actorId: text(row, "actor_id"),
              };
              // The three shapes are distinguished by which owner columns are
              // populated: a revision names one, Agent teardown names only its
              // Agent, and Namespace work names neither and carries a target.
              if (agentId === undefined) {
                const target = text(row, "namespace_target");
                if (target !== "ready" && target !== "deleted") {
                  throw new DependencyUnavailableError(
                    "Persisted Namespace work has an invalid target.",
                  );
                }
                return immutableCopy({ ...base, kind: "namespace", target });
              }
              if (revisionId === undefined) {
                const target = text(row, "agent_target");
                if (target !== "stopped" && target !== "deleted") {
                  throw new DependencyUnavailableError(
                    "Persisted Agent work has an invalid target.",
                  );
                }
                if (target === "deleted") {
                  return immutableCopy({ ...base, kind: "agent", target });
                }
                const key = text(row, "idempotency_key");
                const prefix = `agent:${agentId}:reconcile:${target}:`;
                if (!key.startsWith(prefix) || key.length === prefix.length) {
                  throw new DependencyUnavailableError(
                    "Persisted Agent work has an invalid operation identity.",
                  );
                }
                return immutableCopy({
                  ...base,
                  kind: "agent",
                  target,
                  operationId: key.slice(prefix.length),
                });
              }
              const revisionTarget = optionalText(row, "agent_target");
              if (revisionTarget === undefined) {
                return immutableCopy({ ...base, kind: "agent_revision" });
              }
              const operationId = credentialWithdrawalOperationId(
                revisionId,
                text(row, "idempotency_key"),
              );
              if (revisionTarget !== CREDENTIAL_WITHDRAWAL_TARGET || operationId === undefined) {
                throw new DependencyUnavailableError(
                  "Persisted AgentRevision work has an invalid target.",
                );
              }
              return immutableCopy({
                ...base,
                kind: "agent_revision",
                target: revisionTarget,
                operationId,
              });
            }),
          );
        },
        retryFailedAgentDeletion: async (namespaceId, agentId, initiatingActorId, actorId) => {
          await this.requireInitialized(context);
          // Work actor identity is frozen for the application role; this
          // definer function is the one path that may hand terminal teardown
          // to another caller after OCC has verified the takeover.
          const retried = await client.query(
            "SELECT occ.retry_failed_agent_deletion($1::text, $2::text, $3::text, $4::text) AS retried",
            [namespaceId, agentId, initiatingActorId, actorId],
          );
          return (retried.rows[0] as { retried?: unknown } | undefined)?.retried === true;
        },
        retryFailedNamespaceDeletion: async (namespaceId, initiatingActorId, actorId) => {
          await this.requireInitialized(context);
          // created_at is immutable, so a retry keeps the original convergence
          // deadline: the retried pass succeeds only once teardown has finished.
          // Work actor identity is frozen for the application role; this
          // definer function is the one path that may hand terminal teardown
          // to another caller after OCC has verified the takeover.
          const retried = await client.query(
            "SELECT occ.retry_failed_namespace_deletion($1::text, $2::text, $3::text) AS retried",
            [namespaceId, initiatingActorId, actorId],
          );
          return (retried.rows[0] as { retried?: unknown } | undefined)?.retried === true;
        },
        findWork: async (idempotencyKey) => {
          await this.requireInitialized(context);
          return queue.findWork(idempotencyKey);
        },
        findWorkAttempt: async (idempotencyKey) => {
          await this.requireInitialized(context);
          return queue.findWorkAttempt(idempotencyKey);
        },
        hasOutstandingCredentialWithdrawalWork: async (namespaceId, revisionId) => {
          await this.requireInitialized(context);
          const found = await client.query(
            `SELECT 1 FROM occ.controller_work
             WHERE namespace_id = $1 AND revision_id = $2 AND agent_target = $3
               AND state IN ('queued', 'claimed')
             LIMIT 1`,
            [namespaceId, revisionId, CREDENTIAL_WITHDRAWAL_TARGET],
          );
          return found.rowCount === 1;
        },
        expediteCredentialWithdrawalWork: async (namespaceId, revisionId) => {
          await this.requireInitialized(context);
          const expedited = await client.query(
            `UPDATE occ.controller_work
             SET available_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE namespace_id = $1 AND revision_id = $2 AND agent_target = $3
               AND state = 'queued' AND available_at > clock_timestamp()`,
            [namespaceId, revisionId, CREDENTIAL_WITHDRAWAL_TARGET],
          );
          return (expedited.rowCount ?? 0) > 0;
        },
      },
    };
  }

  private validateIAMState(state: PersistedNativeIAMState, requireComplete: boolean): void {
    const identities = new Map<string, Identity>();
    const groups = new Map<string, Group>();
    const roles = new Map<string, Role>();
    const membershipKeys = new Set<string>();
    const bindingIds = new Set<string>();
    const restrictionIds = new Set<string>();
    for (const identity of state.identities) {
      if (identities.has(identity.id)) {
        throw new DependencyUnavailableError("Persisted IAM identities are invalid or ambiguous.");
      }
      identities.set(identity.id, identity);
    }
    for (const group of state.groups) {
      if (groups.has(group.id)) {
        throw new DependencyUnavailableError("Persisted IAM groups are invalid or ambiguous.");
      }
      groups.set(group.id, group);
    }
    for (const membership of state.memberships) {
      const group = groups.get(membership.groupId);
      const principal = identities.get(membership.principalId);
      const key = `${membership.groupId}\u0000${membership.principalId}`;
      if (
        group === undefined ||
        principal?.kind !== "principal" ||
        group.namespaceId !== membership.namespaceId ||
        membershipKeys.has(key)
      ) {
        throw new DependencyUnavailableError("Persisted IAM group memberships violate scope.");
      }
      membershipKeys.add(key);
    }
    for (const role of state.roles) {
      if (roles.has(role.id)) {
        throw new DependencyUnavailableError("Persisted IAM roles are invalid or ambiguous.");
      }
      permissions(role.permissions);
      roles.set(role.id, role);
    }
    for (const binding of state.bindings) {
      const identity =
        binding.subjectKind === "identity" ? identities.get(binding.subjectId) : undefined;
      const group = binding.subjectKind === "group" ? groups.get(binding.subjectId) : undefined;
      const role = roles.get(binding.roleId);
      if (
        bindingIds.has(binding.id) ||
        (binding.subjectKind === "identity" && identity === undefined) ||
        (binding.subjectKind === "group" && group === undefined) ||
        (binding.subjectKind !== "identity" && binding.subjectKind !== "group") ||
        role === undefined ||
        (identity?.namespaceId !== undefined && identity.namespaceId !== binding.namespaceId) ||
        (binding.subjectKind === "group" && group?.namespaceId !== binding.namespaceId) ||
        (role.namespaceId !== undefined && role.namespaceId !== binding.namespaceId) ||
        (binding.resourceKind === undefined) !== (binding.resourceId === undefined) ||
        (binding.resourceKind !== undefined && !RESOURCE_KINDS.has(binding.resourceKind)) ||
        (binding.namespaceId !== undefined && binding.resourceKind === "installation") ||
        (binding.namespaceId !== undefined &&
          binding.resourceKind === "namespace" &&
          binding.resourceId !== undefined &&
          binding.resourceId !== binding.namespaceId)
      ) {
        throw new DependencyUnavailableError("Persisted IAM access bindings violate exact scope.");
      }
      bindingIds.add(binding.id);
    }
    for (const restriction of state.restrictions) {
      if (
        restrictionIds.has(restriction.id) ||
        restriction.effect !== "deny" ||
        !PERMISSION_ACTIONS.has(restriction.action) ||
        !RESOURCE_KINDS.has(restriction.resourceKind) ||
        (restriction.namespaceId !== undefined &&
          restriction.resourceKind === "namespace" &&
          restriction.resourceId !== undefined &&
          restriction.resourceId !== restriction.namespaceId) ||
        (restriction.namespaceId !== undefined && restriction.resourceKind === "installation")
      ) {
        throw new DependencyUnavailableError("Persisted IAM restrictions violate exact scope.");
      }
      restrictionIds.add(restriction.id);
    }
    if (
      requireComplete &&
      (!state.identities.some((identity) => identity.kind === "principal") ||
        state.roles.length === 0 ||
        state.bindings.length === 0)
    ) {
      throw new DependencyUnavailableError("Persisted native IAM state is incomplete.");
    }
  }

  private async insertIAMState(
    context: TransactionContext,
    state: PersistedNativeIAMState,
  ): Promise<void> {
    this.validateIAMState(state, true);
    for (const identity of state.identities) {
      await context.client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          identity.id,
          identity.namespaceId ?? null,
          identity.kind === "service_principal" ? (identity.agentId ?? null) : null,
          identity.kind,
          identity.kind === "principal" ? identity.issuer : null,
          identity.kind === "principal" ? identity.subject : null,
        ],
      );
    }
    for (const role of state.roles) {
      await context.client.query(
        "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
        [role.id, role.namespaceId ?? null, role.name ?? null, JSON.stringify(role.permissions)],
      );
    }
    for (const group of state.groups) {
      await context.client.query(
        "INSERT INTO occ.iam_groups (id, namespace_id, name) VALUES ($1, $2, $3)",
        [group.id, group.namespaceId ?? null, group.name],
      );
    }
    for (const membership of state.memberships) {
      await context.client.query(
        `INSERT INTO occ.iam_group_memberships (namespace_id, group_id, principal_id)
         VALUES ($1, $2, $3)`,
        [membership.namespaceId ?? null, membership.groupId, membership.principalId],
      );
    }
    for (const binding of state.bindings) {
      await context.client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id,
          resource_kind, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          binding.id,
          binding.namespaceId ?? null,
          binding.subjectKind === "identity" ? binding.subjectId : null,
          binding.subjectKind === "group" ? binding.subjectId : null,
          binding.roleId,
          binding.resourceKind ?? null,
          binding.resourceId ?? null,
        ],
      );
    }
    for (const restriction of state.restrictions) {
      await context.client.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          restriction.id,
          restriction.namespaceId ?? null,
          restriction.action,
          restriction.resourceKind,
          restriction.resourceId ?? null,
          restriction.effect,
        ],
      );
    }
  }
}

export { PostgresPlatformState as PostgresPlatformStateStore };
