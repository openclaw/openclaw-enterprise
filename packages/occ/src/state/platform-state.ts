import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import type {
  RepositorySessionAttempt,
  RepositoryBrokerReceipt,
  RepositorySessionReadRepository,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";
import { memoryRepositorySessions } from "./memory-repository-sessions.ts";
import {
  normalizedRepositoryBindings,
  normalizedRepositoryAccess,
  validRepositoryRevisionState,
} from "./repository-credential-state.ts";
import type {
  AccessBinding,
  Agent,
  AgentRead,
  AgentRevisionRead,
  WorkspaceSetup,
  AgentDesiredRuntimeState,
  AgentStatus,
  AgentRevision,
  AuditEvent,
  CredentialSource,
  CredentialSourceSnapshot,
  CredentialWithdrawal,
  SecretReference,
  HarnessExecutionMode,
  HarnessAuthBinding,
  AgentCredentialSourceBinding,
  HarnessAuthSnapshot,
  Identity,
  Installation,
  Namespace,
  NamespaceStatus,
  PluginDesiredState,
  PluginApprovers,
  Preset,
  RepositoryBindingSelection,
  RepositoryAccess,
  Secret,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
  Role,
  IAMPolicyReadRepository,
  IAMPolicyRepository,
} from "@openclaw-enterprise/contracts";
import {
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  normalizePluginDesiredState,
  normalizePluginApprovers,
  normalizeHarnessAuthBinding,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  harnessAuthBindingFromSnapshot,
  normalizeSecretBindings,
  validPluginRevisionState,
  validPluginApprovers,
  isBackendId,
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
import {
  CREDENTIAL_WITHDRAWAL_TARGET,
  credentialWithdrawalWorkKey,
  type ControllerWork,
  type ControllerWorkAttempt,
} from "./controller-work.ts";
import type {
  AgentProvisioningReadRepository,
  AgentProvisioningRepository,
} from "./agent-provisioning.ts";

export interface InstallationReadRepository {
  findInstallation(installationId: string): Promise<Readonly<Installation> | undefined>;
  getInstallation(): Promise<Readonly<Installation> | undefined>;
}

export interface InstallationRepository extends InstallationReadRepository {
  createInstallation(installation: Installation): Promise<Readonly<Installation>>;
  /**
   * Holds a human Principal's account until COMMIT so a disable cannot commit first.
   * False when the account is disabled; true when it is enabled or the Principal has
   * no human account (its IAM bindings alone decide).
   */
  holdPrincipalAccount(principalId: string): Promise<boolean>;
}

export interface NamespaceReadRepository {
  findNamespace(namespaceId: string): Promise<Readonly<Namespace> | undefined>;
  listNamespaces(): Promise<readonly Readonly<Namespace>[]>;
}

export interface PersistedNamespace extends Namespace {
  readonly deletedAt?: string;
}

export interface NamespaceRepository extends NamespaceReadRepository {
  createNamespace(namespace: Namespace): Promise<Readonly<Namespace>>;
  lockNamespace(
    namespaceId: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  hasAgents(namespaceId: string): Promise<boolean>;
  hasConfigurations(namespaceId: string): Promise<boolean>;
  /** IDs of the Namespace's Configurations, oldest first; nothing else lists them. */
  listConfigurationIds(namespaceId: string): Promise<readonly string[]>;
  hasPresets(namespaceId: string): Promise<boolean>;
  hasServiceAccounts(namespaceId: string): Promise<boolean>;
  hasSecrets(namespaceId: string): Promise<boolean>;
  hasCredentialSources(namespaceId: string): Promise<boolean>;
  transitionNamespaceStatus(
    namespaceId: string,
    expected: NamespaceStatus | readonly NamespaceStatus[],
    next: NamespaceStatus,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  markNamespaceDeleted(
    namespaceId: string,
    deletedAt: string,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
}

export interface WorkspaceSetupReadRepository {
  find(namespaceId: string, agentId: string): Promise<Readonly<WorkspaceSetup> | undefined>;
}

export interface WorkspaceSetupRepository extends WorkspaceSetupReadRepository {
  create(setup: WorkspaceSetup): Promise<Readonly<WorkspaceSetup>>;
  complete(
    namespaceId: string,
    agentId: string,
    id: string,
  ): Promise<Readonly<WorkspaceSetup> | undefined>;
  delete(namespaceId: string, agentId: string): Promise<boolean>;
}

export interface AgentReadRepository {
  findAgentForBrowsing(
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRead> | undefined>;
  listAgentsForBrowsing(namespaceId: string): Promise<readonly Readonly<AgentRead>[]>;
  findAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  listAgents(namespaceId: string): Promise<readonly Readonly<Agent>[]>;
}

export interface AgentRepository extends AgentReadRepository {
  createAgent(agent: Agent): Promise<Readonly<Agent>>;
  lockAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  updateConfiguration(
    namespaceId: string,
    agentId: string,
    configurationId: string,
    executionMode?: HarnessExecutionMode,
    harnessAuth?: HarnessAuthBinding | null,
    backendId?: string | null,
    plugins?: PluginDesiredState,
    repositoryBindings?: readonly RepositoryBindingSelection[],
    pluginApprovers?: PluginApprovers | null,
    repositoryAccess?: RepositoryAccess | null,
    credentialSources?: readonly AgentCredentialSourceBinding[],
  ): Promise<Readonly<Agent> | undefined>;
  compareAndSetActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string | undefined,
    candidateRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
  compareAndClearActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
  transitionAgentDesiredRuntimeState(
    namespaceId: string,
    agentId: string,
    expected: AgentDesiredRuntimeState | readonly AgentDesiredRuntimeState[],
    next: AgentDesiredRuntimeState,
  ): Promise<Readonly<Agent> | undefined>;
  /**
   * Moves the Agent between lifecycle states, returning undefined when the
   * Agent is absent or does not currently hold one of `expected`. Deletion is
   * asynchronous, so the transition is the boundary that stops concurrent
   * mutations from admitting work the teardown has already enumerated. Callers
   * that treat an already-deleting Agent as success check its status first,
   * as `deleteNamespace` does for a Namespace.
   */
  transitionAgentStatus(
    namespaceId: string,
    agentId: string,
    expected: AgentStatus | readonly AgentStatus[],
    next: AgentStatus,
  ): Promise<Readonly<Agent> | undefined>;
}

export interface AgentRevisionReadRepository {
  findRevisionForBrowsing(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevisionRead> | undefined>;
  listRevisionsForBrowsing(
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevisionRead>[]>;
  findRevision(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision> | undefined>;
  listRevisions(namespaceId: string, agentId: string): Promise<readonly Readonly<AgentRevision>[]>;
}

export interface AgentRevisionRepository extends AgentRevisionReadRepository {
  createRevision(revision: AgentRevision): Promise<Readonly<AgentRevision>>;
}

export interface ConfigurationOwnership {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: "agent";
  readonly generation: number;
  readonly secretBindings?: SecretBindings;
  readonly createdAt: string;
}

export interface ConfigurationReadRepository {
  findConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
}

export interface ConfigurationRepository extends ConfigurationReadRepository {
  createConfiguration(
    configuration: ConfigurationOwnership,
  ): Promise<Readonly<ConfigurationOwnership>>;
  lockConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  advanceConfigurationGeneration(
    namespaceId: string,
    configurationId: string,
    expectedGeneration: number,
    secretBindings?: SecretBindings,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  deleteConfiguration(namespaceId: string, configurationId: string): Promise<boolean>;
}

export interface PresetReadRepository {
  findPreset(namespaceId: string, presetId: string): Promise<Readonly<Preset> | undefined>;
  listPresets(namespaceId: string): Promise<readonly Readonly<Preset>[]>;
}

export interface PresetRepository extends PresetReadRepository {
  createPreset(preset: Preset): Promise<Readonly<Preset>>;
  lockPreset(namespaceId: string, presetId: string): Promise<Readonly<Preset> | undefined>;
  updatePreset(
    namespaceId: string,
    presetId: string,
    changes: Partial<Pick<Preset, "name" | "template">>,
  ): Promise<Readonly<Preset> | undefined>;
  deletePreset(namespaceId: string, presetId: string): Promise<boolean>;
}

/**
 * The current platform state that keeps a Secret from deletion. An Agent appears once,
 * whether its draft, active revision, or a pending deployment holds the reference.
 */
export type SecretReferenceKind =
  "agent" | "configuration" | "credential_source" | "provisioning_request";

export interface SecretReferenceEntry {
  readonly kind: SecretReferenceKind;
  readonly id: string;
}

/** At most `limit` references, ordered by kind then ID; `truncated` when more exist. */
export interface SecretReferencePage {
  readonly references: readonly Readonly<SecretReferenceEntry>[];
  readonly truncated: boolean;
}

export interface SecretReadRepository {
  findSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  listSecrets(namespaceId: string): Promise<readonly Readonly<Secret>[]>;
  listReferences(
    namespaceId: string,
    secretId: string,
    limit: number,
  ): Promise<Readonly<SecretReferencePage>>;
}

export interface SecretRepository extends SecretReadRepository {
  lockSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  createSecret(secret: Secret): Promise<Readonly<Secret>>;
  deleteSecret(namespaceId: string, secretId: string): Promise<boolean>;
  hasReferences(namespaceId: string, secretId: string): Promise<boolean>;
}

export interface CredentialSourceReadRepository {
  findCredentialSource(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  listCredentialSources(namespaceId: string): Promise<readonly Readonly<CredentialSource>[]>;
  findCredentialWithdrawal(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
  listCredentialWithdrawals(
    namespaceId: string,
    revisionId: string,
  ): Promise<readonly Readonly<CredentialWithdrawal>[]>;
}

export interface CredentialSourceRepository extends CredentialSourceReadRepository {
  lockCredentialSource(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  createCredentialSource(source: CredentialSource): Promise<Readonly<CredentialSource>>;
  /**
   * Points each existing Secret input field at a replacement same-Namespace Secret. The field
   * set is fixed by the source type; only the referenced Secret IDs change.
   */
  replaceCredentialSourceSecrets(
    namespaceId: string,
    credentialSourceId: string,
    secrets: Readonly<Record<string, SecretReference>>,
  ): Promise<Readonly<CredentialSource> | undefined>;
  /** Moves a registering source to `ready` once the gateway confirms its copy. */
  markCredentialSourceReady(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  /** Moves a registering or ready source to `deleting`; the record stays until the gateway copy is gone. */
  markCredentialSourceDeleting(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  deleteCredentialSource(namespaceId: string, credentialSourceId: string): Promise<boolean>;
  /** True while an Agent draft, active revision, or pending deployment references the source. */
  hasReferences(namespaceId: string, credentialSourceId: string): Promise<boolean>;
  /** Records a pending withdrawal, or returns the existing one for the same revision and source. */
  requestCredentialWithdrawal(
    withdrawal: CredentialWithdrawal,
  ): Promise<Readonly<CredentialWithdrawal>>;
  /** Records the worker's latest outcome code on a pending withdrawal. */
  recordCredentialWithdrawalAttempt(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
    attempt: { readonly reason: string; readonly at: string },
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
  /** Moves a pending withdrawal to `revoked`; a revoked withdrawal never changes again. */
  markCredentialWithdrawalRevoked(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
    completedAt: string,
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
}

export interface ServiceAccountReadRepository {
  findServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  listServiceAccounts(namespaceId: string): Promise<readonly Readonly<ServiceAccount>[]>;
  findServiceAccountBackendBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly backendId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined
  >;
}

export interface ServiceAccountRepository extends ServiceAccountReadRepository {
  createServiceAccount(account: ServiceAccount): Promise<Readonly<ServiceAccount>>;
  lockServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  updateCredential(
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  deleteServiceAccount(namespaceId: string, serviceAccountId: string): Promise<boolean>;
  hasReferences(namespaceId: string, serviceAccountId: string): Promise<boolean>;
}

const serviceAccountIdentifier =
  /^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secretName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const secretKey = /^[-._a-zA-Z0-9]+$/;

function validCredential(credential: unknown): credential is ServiceAccountCredential {
  if (
    credential === null ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    Object.keys(credential).length !== 2 ||
    !("kind" in credential) ||
    !("secretRef" in credential) ||
    (credential.kind !== "api_key" &&
      credential.kind !== "oauth_access_token" &&
      credential.kind !== "access_token") ||
    credential.secretRef === null ||
    typeof credential.secretRef !== "object" ||
    Array.isArray(credential.secretRef) ||
    Object.keys(credential.secretRef).length !== 2 ||
    !("name" in credential.secretRef) ||
    !("key" in credential.secretRef)
  ) {
    return false;
  }
  const { name, key } = credential.secretRef;
  return (
    typeof name === "string" &&
    name.length <= 253 &&
    secretName.test(name) &&
    typeof key === "string" &&
    key.length <= 253 &&
    secretKey.test(key) &&
    key !== "." &&
    key !== ".."
  );
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

export function validHarnessAuthSnapshot(value: HarnessAuthSnapshot, namespaceId: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    if (value.method === "runtime") {
      return normalizeHarnessAuthBinding(value) !== null;
    }
    if (value.method === "credential_source") {
      return (
        normalizeHarnessAuthBinding({ method: value.method, sourceId: value.sourceId }) !== null &&
        Object.keys(value).length === 5 &&
        isNonEmptyString(value.credentialGatewayId) &&
        isNonEmptyString(value.sourceType) &&
        value.loginMode === "api_key"
      );
    }
    const binding = normalizeHarnessAuthBinding({ method: value.method, source: value.source });
    if (isSecretHarnessAuth(binding)) {
      return (
        Object.keys(value).length === 3 &&
        binding.source.namespaceId === namespaceId &&
        isSecretHarnessAuth(value) &&
        isNonEmptyString(value.secretDriverId)
      );
    }
    if (
      !isServiceAccountHarnessAuth(value) ||
      value.source.namespaceId !== namespaceId ||
      Object.keys(value).length !== 4 ||
      !validCredential(value.credential) ||
      value.credential.kind !== "access_token"
    ) {
      return false;
    }
    const backend = value.backendBinding;
    return (
      backend !== null &&
      typeof backend === "object" &&
      !Array.isArray(backend) &&
      Object.keys(backend).length === 4 &&
      isNonEmptyString(backend.backendId) &&
      isNonEmptyString(backend.driverId) &&
      isNonEmptyString(backend.workspaceId) &&
      backend.credentialIssued === true
    );
  } catch {
    return false;
  }
}

export function harnessAuthMatches(
  binding: HarnessAuthBinding | null,
  snapshot: HarnessAuthSnapshot,
): boolean {
  if (binding === null || binding.method !== snapshot.method) {
    return false;
  }
  if (binding.method === "runtime") {
    return true;
  }
  if (binding.method === "credential_source" && snapshot.method === "credential_source") {
    return binding.sourceId === snapshot.sourceId;
  }
  return (
    "source" in binding &&
    "source" in snapshot &&
    binding.source.kind === snapshot.source.kind &&
    binding.source.namespaceId === snapshot.source.namespaceId &&
    binding.source.id === snapshot.source.id
  );
}

function harnessSecretReference(
  binding: HarnessAuthBinding | undefined | null,
  namespaceId: string,
  secretId: string,
): boolean {
  return (
    isSecretHarnessAuth(binding) &&
    binding.source.namespaceId === namespaceId &&
    binding.source.id === secretId
  );
}

function harnessCredentialSourceReference(
  binding: HarnessAuthBinding | HarnessAuthSnapshot | undefined | null,
  credentialSourceId: string,
): boolean {
  return binding?.method === "credential_source" && binding.sourceId === credentialSourceId;
}

function harnessAccountReference(
  binding: HarnessAuthBinding | undefined | null,
  serviceAccountId: string,
): boolean {
  return isServiceAccountHarnessAuth(binding) && binding.source.id === serviceAccountId;
}

export async function assertHarnessAuthAvailable(
  state: Pick<PlatformReadView, "secrets" | "serviceAccounts" | "credentialSources">,
  namespaceId: string,
  value: HarnessAuthBinding | null,
): Promise<void> {
  let binding: HarnessAuthBinding | null;
  try {
    binding = normalizeHarnessAuthBinding(value);
  } catch {
    throw new ScopeViolationError("The Agent harness authentication binding is invalid.");
  }
  if (binding === null || binding.method === "runtime") {
    return;
  }
  if (isSecretHarnessAuth(binding)) {
    if (
      binding.source.namespaceId !== namespaceId ||
      (await state.secrets.findSecret(namespaceId, binding.source.id)) === undefined
    ) {
      throw new ScopeViolationError(
        "The Agent harness authentication references an unavailable Secret.",
      );
    }
  } else if (binding.method === "credential_source") {
    const source = await state.credentialSources.findCredentialSource(
      namespaceId,
      binding.sourceId,
    );
    if (source === undefined || source.state !== "ready") {
      throw new ScopeViolationError(
        "The Agent harness authentication references an unavailable credential source.",
      );
    }
  } else if (
    binding.source.namespaceId !== namespaceId ||
    (await state.serviceAccounts.findServiceAccount(namespaceId, binding.source.id)) === undefined
  ) {
    throw new ScopeViolationError(
      "The Agent harness authentication references an unavailable ServiceAccount.",
    );
  }
}

/** In-memory mirror of `agents_harness_credential_source_listed`. */
export function assertHarnessCredentialSourceListed(
  harnessAuth: HarnessAuthBinding | null,
  bindings: readonly AgentCredentialSourceBinding[] | undefined,
): void {
  if (
    harnessAuth?.method === "credential_source" &&
    !(bindings ?? []).some(({ sourceId }) => sourceId === harnessAuth.sourceId)
  ) {
    throw new ScopeViolationError("The Agent's Harness credential source must be listed.");
  }
}

/** In-memory mirror of the `agent_credential_sources` foreign key. */
export async function assertAgentCredentialSourcesAvailable(
  state: Pick<PlatformReadView, "credentialSources">,
  namespaceId: string,
  bindings: readonly AgentCredentialSourceBinding[] | undefined,
): Promise<void> {
  for (const { sourceId } of bindings ?? []) {
    if ((await state.credentialSources.findCredentialSource(namespaceId, sourceId)) === undefined) {
      throw new ScopeViolationError("The Agent references an unavailable credential source.");
    }
  }
}

function agentCredentialSourceReference(
  bindings: readonly { readonly sourceId: string }[] | undefined,
  credentialSourceId: string,
): boolean {
  return (bindings ?? []).some(({ sourceId }) => sourceId === credentialSourceId);
}

/** A revision freezes exactly the owner's non-model sources, in order. */
export function credentialSourcesMatch(
  bindings: readonly AgentCredentialSourceBinding[] | undefined,
  snapshots: readonly CredentialSourceSnapshot[] | undefined,
): boolean {
  const owner = (bindings ?? []).map(({ sourceId }) => sourceId);
  const frozen = (snapshots ?? []).map(({ sourceId }) => sourceId);
  return owner.length === frozen.length && owner.every((sourceId, i) => sourceId === frozen[i]);
}

export function validCredentialSourceSnapshots(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return false;
  }
  const seen = new Set<string>();
  return value.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const keys = Object.keys(entry).sort();
    const snapshot = entry as Record<string, unknown>;
    const valid =
      keys.join(",") === "credentialGatewayId,sourceId,sourceType" &&
      isNonEmptyString(snapshot.sourceId) &&
      isNonEmptyString(snapshot.credentialGatewayId) &&
      isNonEmptyString(snapshot.sourceType) &&
      !seen.has(snapshot.sourceId);
    seen.add(snapshot.sourceId as string);
    return valid;
  });
}

function assertAdmittedAgentRevision(revision: AgentRevision): void {
  if (
    (revision.backendId !== null && !isBackendId(revision.backendId)) ||
    !/^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      revision.configurationId,
    ) ||
    revision.configurationKind !== "agent" ||
    !Number.isSafeInteger(revision.configurationGeneration) ||
    revision.configurationGeneration <= 0 ||
    typeof revision.configuration !== "object" ||
    revision.configuration === null ||
    Array.isArray(revision.configuration) ||
    typeof revision.harness !== "object" ||
    revision.harness === null ||
    Array.isArray(revision.harness) ||
    Object.keys(revision.harness).length !== 3 ||
    !Object.hasOwn(revision.harness, "id") ||
    !Object.hasOwn(revision.harness, "version") ||
    !Object.hasOwn(revision.harness, "mode") ||
    !isNonEmptyString(revision.harness.id) ||
    !isNonEmptyString(revision.harness.version) ||
    (revision.harness.mode !== "embedded" && revision.harness.mode !== "dedicated") ||
    typeof revision.compute !== "object" ||
    revision.compute === null ||
    Array.isArray(revision.compute) ||
    Object.keys(revision.compute).length !== 2 ||
    !Object.hasOwn(revision.compute, "id") ||
    !Object.hasOwn(revision.compute, "implementation") ||
    !isNonEmptyString(revision.compute.id) ||
    !isNonEmptyString(revision.compute.implementation) ||
    (revision.sandboxDriverId !== undefined && !isNonEmptyString(revision.sandboxDriverId)) ||
    (revision.secretDriverId !== undefined && !isNonEmptyString(revision.secretDriverId)) ||
    Object.hasOwn(revision, "serviceAccount") ||
    !validHarnessAuthSnapshot(revision.harnessAuth, revision.namespaceId) ||
    !validCredentialSourceSnapshots(revision.credentialSources) ||
    !validPluginRevisionState(revision.plugins) ||
    !validPluginApprovers(revision.pluginApprovers) ||
    (revision.repositoryCredentials !== undefined &&
      !validRepositoryRevisionState(revision.repositoryCredentials))
  ) {
    throw new ScopeViolationError(
      "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
    );
  }
}

export interface PlatformAuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<readonly Readonly<AuditEvent>[]>;
}

interface PlatformOperationBase {
  readonly action: "reconcile";
  readonly namespaceId: string;
  readonly resourceId: string;
  readonly actorId: string;
}

export type PlatformOperation =
  | (PlatformOperationBase & {
      readonly kind: "namespace";
      readonly target: "ready" | "deleted";
    })
  | (PlatformOperationBase & {
      readonly kind: "agent_revision";
      readonly target?: never;
    })
  | (PlatformOperationBase & {
      /** Revokes pending credential withdrawals from an active revision; never deploys it. */
      readonly kind: "agent_revision";
      readonly target: typeof CREDENTIAL_WITHDRAWAL_TARGET;
      readonly operationId: string;
    })
  | (PlatformOperationBase & {
      readonly kind: "agent";
      readonly target: "stopped";
      readonly operationId: string;
    })
  | (PlatformOperationBase & {
      /**
       * Agent teardown is scoped to the Agent, not one revision: it retires
       * every revision the Agent owns.
       */
      readonly kind: "agent";
      readonly target: "deleted";
      readonly operationId?: never;
    });

export interface PlatformOperationReadRepository {
  list(): Promise<readonly Readonly<PlatformOperation>[]>;
  findWork(idempotencyKey: string): Promise<Readonly<ControllerWork> | undefined>;
  findWorkAttempt(idempotencyKey: string): Promise<Readonly<ControllerWorkAttempt> | undefined>;
  /** True while credential withdrawal work for the revision is queued or claimed. */
  hasOutstandingCredentialWithdrawalWork(namespaceId: string, revisionId: string): Promise<boolean>;
}

export interface PlatformOperationRepository extends PlatformOperationReadRepository {
  append(operation: PlatformOperation): Promise<void>;
  /**
   * Requeue the exact deleting Agent's terminal teardown initiated by
   * `initiatingActorId`, assigning it to `actorId` (the same actor for a plain
   * retry, another for a takeover).
   */
  retryFailedAgentDeletion(
    namespaceId: string,
    agentId: string,
    initiatingActorId: string,
    actorId: string,
  ): Promise<boolean>;
  /**
   * Requeue the exact deleting Namespace's terminal teardown initiated by
   * `initiatingActorId`, assigning it to `actorId` (the same actor for a plain
   * retry, another for a takeover).
   */
  retryFailedNamespaceDeletion(
    namespaceId: string,
    initiatingActorId: string,
    actorId: string,
  ): Promise<boolean>;
}

export type { AgentProvisioningRecord } from "./agent-provisioning.ts";

export type { IAMPolicyReadRepository, IAMPolicyRepository } from "@openclaw-enterprise/contracts";

export interface PlatformReadView {
  readonly installations: InstallationReadRepository;
  readonly namespaces: NamespaceReadRepository;
  readonly configurations: ConfigurationReadRepository;
  readonly presets: PresetReadRepository;
  readonly secrets: SecretReadRepository;
  readonly credentialSources: CredentialSourceReadRepository;
  readonly serviceAccounts: ServiceAccountReadRepository;
  readonly agents: AgentReadRepository;
  readonly workspaceSetups: WorkspaceSetupReadRepository;
  readonly revisions: AgentRevisionReadRepository;
  readonly iamPolicy: IAMPolicyReadRepository;
  readonly repositorySessions: RepositorySessionReadRepository;
  readonly provisioning: AgentProvisioningReadRepository;
  readonly operations: PlatformOperationReadRepository;
}

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly installations: InstallationRepository;
  readonly namespaces: NamespaceRepository;
  readonly configurations: ConfigurationRepository;
  readonly presets: PresetRepository;
  readonly secrets: SecretRepository;
  readonly credentialSources: CredentialSourceRepository;
  readonly serviceAccounts: ServiceAccountRepository;
  readonly agents: AgentRepository;
  readonly workspaceSetups: WorkspaceSetupRepository;
  readonly revisions: AgentRevisionRepository;
  readonly iamPolicy: IAMPolicyRepository;
  readonly repositorySessions: RepositorySessionRepository;
  readonly provisioning: AgentProvisioningRepository;
  readonly audit: PlatformAuditRepository;
  readonly operations: PlatformOperationRepository;
}

export interface PlatformStateStore {
  read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T>;
  transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T>;
}

export interface TransactionalAuditWriter {
  append(event: AuditEvent): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PlatformAuditSink {
  append(event: AuditEvent): Promise<void>;
  beginTransaction?(): TransactionalAuditWriter;
  checkpoint?(): number;
  restore?(checkpoint: number): void;
}

export interface InMemoryPlatformStateOptions {
  readonly auditSink?: PlatformAuditSink;
  /** Preprovisioned identities copied at construction; later input changes are not observed. */
  readonly iamIdentities?: readonly Identity[];
  /**
   * Live identity lookup, consulted on every AccessBinding write so identities enrolled after
   * construction can be bound. State still applies the exact subject rule to the result.
   */
  readonly resolveIAMIdentity?: (identityId: string) => Identity | undefined;
}

interface IAMSubjectSource {
  readonly identities: readonly Identity[];
  readonly resolve: ((identityId: string) => Identity | undefined) | undefined;
}

interface PlatformSnapshot {
  installation: Readonly<Installation> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly presets: Map<string, Readonly<Preset>>;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly credentialSources: Map<string, Readonly<CredentialSource>>;
  readonly credentialWithdrawals: Map<string, Readonly<CredentialWithdrawal>>;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly agents: Map<string, Readonly<Agent>>;
  readonly workspaceSetups: Map<string, Readonly<WorkspaceSetup>>;
  readonly revisions: Map<string, readonly Readonly<AgentRevision>[]>;
  readonly roles: Map<string, Readonly<Role>>;
  readonly bindings: Map<string, Readonly<AccessBinding>>;
  readonly servicePrincipals: Map<string, Readonly<ServicePrincipal>>;
  readonly repositorySessions: Map<string, Readonly<RepositorySessionAttempt>>;
  readonly repositoryBrokerReceipts: Map<string, Readonly<RepositoryBrokerReceipt>>;
  readonly audit: Readonly<AuditEvent>[];
  readonly operations: Readonly<PlatformOperation>[];
}

function agentKey(namespaceId: string, agentId: string): string {
  return `${namespaceId}\u0000${agentId}`;
}

/**
 * Defensive: the controller already matches the type's catalog fields before any gateway call.
 * Both stores refuse a replacement that would change a source's Secret field set.
 */
export function assertSameCredentialSourceFields(
  current: Readonly<Record<string, SecretReference>>,
  replacement: Readonly<Record<string, SecretReference>>,
): void {
  const fields = Object.keys(current).sort();
  const replaced = Object.keys(replacement).sort();
  if (
    fields.length !== replaced.length ||
    fields.some((field, index) => field !== replaced[index])
  ) {
    throw new ScopeViolationError("Credential source Secret fields cannot change.");
  }
}

function operationIdempotencyKey(operation: Readonly<PlatformOperation>): string {
  if (operation.kind === "agent") {
    return `agent:${operation.resourceId}:${operation.action}:${operation.target}:${operation.operationId}`;
  }
  if (operation.kind === "agent_revision" && operation.target === CREDENTIAL_WITHDRAWAL_TARGET) {
    return credentialWithdrawalWorkKey(operation.resourceId, operation.operationId);
  }
  return `${operation.kind}:${operation.resourceId}:${operation.action}${
    operation.kind === "namespace" ? `:${operation.target}` : ""
  }`;
}

function cloneSnapshot(snapshot: PlatformSnapshot): PlatformSnapshot {
  return {
    installation:
      snapshot.installation === undefined ? undefined : immutableCopy(snapshot.installation),
    namespaces: new Map(
      Array.from(snapshot.namespaces, ([key, namespace]) => [key, immutableCopy(namespace)]),
    ),
    configurations: new Map(
      Array.from(snapshot.configurations, ([key, configuration]) => [
        key,
        immutableCopy(configuration),
      ]),
    ),
    presets: new Map(Array.from(snapshot.presets, ([key, preset]) => [key, immutableCopy(preset)])),
    secrets: new Map(Array.from(snapshot.secrets, ([key, secret]) => [key, immutableCopy(secret)])),
    credentialWithdrawals: new Map(
      Array.from(snapshot.credentialWithdrawals, ([key, withdrawal]) => [
        key,
        immutableCopy(withdrawal),
      ]),
    ),
    credentialSources: new Map(
      Array.from(snapshot.credentialSources, ([key, source]) => [key, immutableCopy(source)]),
    ),
    serviceAccounts: new Map(
      Array.from(snapshot.serviceAccounts, ([key, account]) => [key, immutableCopy(account)]),
    ),
    agents: new Map(Array.from(snapshot.agents, ([key, agent]) => [key, immutableCopy(agent)])),
    workspaceSetups: new Map(
      Array.from(snapshot.workspaceSetups, ([key, setup]) => [key, immutableCopy(setup)]),
    ),
    // Revisions are copied on ingress/egress; appends replace frozen history arrays.
    // A separate Map isolates this snapshot's future appends without copying history.
    revisions: new Map(snapshot.revisions),
    roles: new Map(Array.from(snapshot.roles, ([key, role]) => [key, immutableCopy(role)])),
    bindings: new Map(
      Array.from(snapshot.bindings, ([key, binding]) => [key, immutableCopy(binding)]),
    ),
    servicePrincipals: new Map(snapshot.servicePrincipals),
    repositorySessions: new Map(
      Array.from(snapshot.repositorySessions, ([key, attempt]) => [key, immutableCopy(attempt)]),
    ),
    repositoryBrokerReceipts: new Map(
      Array.from(snapshot.repositoryBrokerReceipts, ([key, receipt]) => [
        key,
        immutableCopy(receipt),
      ]),
    ),
    audit: snapshot.audit.map((event) => immutableCopy(event)),
    operations: snapshot.operations.map((operation) => immutableCopy(operation)),
  };
}

function assertInitialized(snapshot: PlatformSnapshot): void {
  if (!snapshot.installation) {
    throw new ScopeViolationError("The server-owned Installation has not been initialized.");
  }
}

function iamPolicyKey(namespaceId: string, id: string): string {
  return `${namespaceId}\u0000${id}`;
}

/**
 * Namespace IAM Roles may grant only `read` on the `namespace` kind. Any other
 * action would let a Namespace-targeted binding authorize Namespace lifecycle
 * operations such as deletion.
 */
export function namespaceRoleGrantsBeyondRead(role: Pick<Role, "permissions">): boolean {
  return role.permissions.some(
    (permission) => permission.resourceKind === "namespace" && permission.action !== "read",
  );
}

const secretIdentifier =
  /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namespaceIdentifier =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kubernetesNamespaceName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

function normalizedSecretBindings(bindings?: SecretBindings): SecretBindings | undefined {
  if (bindings === undefined) {
    return undefined;
  }
  try {
    const normalized = normalizeSecretBindings(bindings);
    for (const { source } of Object.values(normalized)) {
      if (!namespaceIdentifier.test(source.namespaceId) || !secretIdentifier.test(source.id)) {
        throw new ScopeViolationError("Secret bindings must reference exact Secrets.");
      }
    }
    return Object.keys(normalized).length === 0 ? undefined : immutableCopy(normalized);
  } catch (error) {
    if (error instanceof ScopeViolationError) {
      throw error;
    }
    throw new ScopeViolationError("Secret bindings are invalid.");
  }
}

function secretBindingRefs(
  bindings?: SecretBindings,
): readonly { namespaceId: string; id: string }[] {
  const normalized = normalizedSecretBindings(bindings);
  if (normalized === undefined) {
    return [];
  }
  return Object.freeze(
    Object.values(normalized).map(({ source }) => ({
      namespaceId: source.namespaceId,
      id: source.id,
    })),
  );
}

function secretBindingsReference(
  bindings: SecretBindings | undefined,
  namespaceId: string,
  secretId: string,
): boolean {
  return secretBindingRefs(bindings).some(
    (source) => source.namespaceId === namespaceId && source.id === secretId,
  );
}

async function assertSecretBindingsAvailable(
  secrets: Pick<SecretReadRepository, "findSecret">,
  namespaceId: string,
  bindings: SecretBindings | undefined,
): Promise<void> {
  for (const source of secretBindingRefs(bindings)) {
    if (source.namespaceId !== namespaceId) {
      throw new ScopeViolationError("Secret bindings cannot cross Namespace boundaries.");
    }
    const secret = await secrets.findSecret(namespaceId, source.id);
    if (secret === undefined) {
      throw new ScopeViolationError("Secret bindings reference unavailable Secret metadata.");
    }
  }
}

async function assertConfigurationUsableByAgent(
  configurations: ConfigurationReadRepository,
  secrets: SecretReadRepository,
  namespaceId: string,
  configurationId: string,
): Promise<void> {
  const configuration = await configurations.findConfiguration(namespaceId, configurationId);
  if (configuration === undefined) {
    throw new ScopeViolationError("The Agent references an unavailable Configuration.");
  }
  await assertSecretBindingsAvailable(secrets, namespaceId, configuration.secretBindings);
}

function assertSecret(secret: Secret): void {
  if (
    !secretIdentifier.test(secret.id) ||
    !namespaceIdentifier.test(secret.namespaceId) ||
    typeof secret.name !== "string" ||
    secret.name.length < 1 ||
    Array.from(secret.name).length > 200 ||
    secret.name !== secret.name.trim() ||
    /[\x00-\x1f\x7f]/.test(secret.name) ||
    typeof secret.driverId !== "string" ||
    secret.driverId.length < 1 ||
    secret.driverId.length > 200 ||
    secret.driverId !== secret.driverId.trim() ||
    /[\x00-\x1f\x7f]/.test(secret.driverId) ||
    secret.backendRef === null ||
    typeof secret.backendRef !== "object" ||
    Array.isArray(secret.backendRef) ||
    Object.keys(secret.backendRef).length !== 4 ||
    typeof secret.backendRef.namespaceName !== "string" ||
    secret.backendRef.namespaceName.length < 1 ||
    secret.backendRef.namespaceName.length > 63 ||
    !kubernetesNamespaceName.test(secret.backendRef.namespaceName) ||
    typeof secret.backendRef.name !== "string" ||
    secret.backendRef.name.length < 1 ||
    secret.backendRef.name.length > 253 ||
    !secretName.test(secret.backendRef.name) ||
    typeof secret.backendRef.key !== "string" ||
    secret.backendRef.key.length < 1 ||
    secret.backendRef.key.length > 253 ||
    !secretKey.test(secret.backendRef.key) ||
    secret.backendRef.key === "." ||
    secret.backendRef.key === ".." ||
    typeof secret.backendRef.uid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(secret.backendRef.uid)
  ) {
    throw new ScopeViolationError("The Secret or backend reference is invalid.");
  }
}

const credentialSourceIdentifier =
  /^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credentialSourceType = /^[a-z][a-z0-9-]{0,63}$/;
const credentialSourceField = /^[a-z][a-z0-9_]{0,63}$/;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Mirrors the PostgreSQL credential source constraints for the in-memory adapter. */
function assertCredentialSource(source: CredentialSource): void {
  const config: unknown = source.config;
  const secretInputs: unknown = source.secrets;
  if (
    !credentialSourceIdentifier.test(source.id) ||
    !namespaceIdentifier.test(source.namespaceId) ||
    typeof source.name !== "string" ||
    source.name.length < 1 ||
    Array.from(source.name).length > 200 ||
    source.name !== source.name.trim() ||
    Array.from(source.name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) ||
    typeof source.type !== "string" ||
    !credentialSourceType.test(source.type) ||
    !isPlainRecord(config) ||
    Object.keys(config).length > 32 ||
    Object.entries(config).some(
      ([field, value]) =>
        !credentialSourceField.test(field) ||
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 2048,
    ) ||
    !isPlainRecord(secretInputs) ||
    typeof source.driverId !== "string" ||
    source.driverId.length < 1 ||
    source.driverId.length > 200 ||
    source.driverId !== source.driverId.trim() ||
    (source.state !== "registering" && source.state !== "ready" && source.state !== "deleting")
  ) {
    throw new ScopeViolationError("The credential source is invalid.");
  }
  // Secret inputs persist only as same-Namespace Secret IDs keyed by field.
  for (const [field, reference] of Object.entries(secretInputs)) {
    if (
      !credentialSourceField.test(field) ||
      !isPlainRecord(reference) ||
      Object.keys(reference).length !== 3 ||
      reference.kind !== "secret" ||
      reference.namespaceId !== source.namespaceId ||
      typeof reference.id !== "string" ||
      !secretIdentifier.test(reference.id)
    ) {
      throw new ScopeViolationError(
        "Credential source Secret inputs must reference exact Secrets.",
      );
    }
  }
}

function repositories(
  snapshot: PlatformSnapshot,
  iamSubjects: IAMSubjectSource,
): PlatformUnitOfWork {
  const installations: InstallationRepository = {
    findInstallation: async (installationId) =>
      snapshot.installation?.id === installationId
        ? immutableCopy(snapshot.installation)
        : undefined,
    getInstallation: async () =>
      snapshot.installation === undefined ? undefined : immutableCopy(snapshot.installation),
    createInstallation: async (installation) => {
      if (snapshot.installation !== undefined) {
        throw new ResourceConflictError("An Installation has already been bootstrapped.");
      }
      const saved = immutableCopy(installation);
      snapshot.installation = saved;
      return immutableCopy(saved);
    },
    // In-memory State has no human accounts, and its units are serialized.
    holdPrincipalAccount: async () => true,
  };

  const namespaces: NamespaceRepository = {
    findNamespace: async (namespaceId) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      return namespace !== undefined && namespace.deletedAt === undefined
        ? immutableCopy(namespace)
        : undefined;
    },
    listNamespaces: async () =>
      Object.freeze(
        Array.from(snapshot.namespaces.values())
          .filter((namespace) => namespace.deletedAt === undefined)
          .map((namespace) => immutableCopy(namespace)),
      ),
    createNamespace: async (namespace) => {
      assertInitialized(snapshot);
      const key = namespace.id;
      if (
        namespace.existingNamespace !== undefined &&
        (namespace.existingNamespace.length > 63 ||
          !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace.existingNamespace))
      ) {
        throw new ScopeViolationError("The existing Kubernetes namespace name is invalid.");
      }
      if (snapshot.namespaces.has(key)) {
        throw new ResourceConflictError("The server generated an existing Namespace identity.");
      }
      const named = Array.from(snapshot.namespaces.values()).find(
        (existing) => existing.name === namespace.name,
      );
      if (named !== undefined) {
        throw new ResourceStateConflictError(
          named.deletedAt === undefined ? NAMESPACE_NAME_CONFLICT : DELETED_NAMESPACE_NAME_CONFLICT,
        );
      }
      if (
        namespace.existingNamespace !== undefined &&
        Array.from(snapshot.namespaces.values()).some(
          (existing) =>
            existing.deletedAt === undefined &&
            existing.existingNamespace === namespace.existingNamespace,
        )
      ) {
        throw new ResourceConflictError(
          "The existing Kubernetes namespace is already assigned to a Namespace.",
        );
      }
      const saved = immutableCopy(namespace);
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
    lockNamespace: async (namespaceId, options = {}) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      if (
        namespace === undefined ||
        (namespace.deletedAt !== undefined && options.includeDeleted !== true)
      ) {
        return undefined;
      }
      return immutableCopy(namespace);
    },
    hasAgents: async (namespaceId) =>
      Array.from(snapshot.agents.values()).some((agent) => agent.namespaceId === namespaceId),
    hasConfigurations: async (namespaceId) =>
      Array.from(snapshot.configurations.values()).some(
        (configuration) => configuration.namespaceId === namespaceId,
      ),
    listConfigurationIds: async (namespaceId) =>
      Object.freeze(
        Array.from(snapshot.configurations.values())
          .filter((configuration) => configuration.namespaceId === namespaceId)
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .map((configuration) => configuration.id),
      ),
    hasPresets: async (namespaceId) =>
      Array.from(snapshot.presets.values()).some((preset) => preset.namespaceId === namespaceId),
    hasServiceAccounts: async (namespaceId) =>
      Array.from(snapshot.serviceAccounts.values()).some(
        (account) => account.namespaceId === namespaceId,
      ),
    hasSecrets: async (namespaceId) =>
      Array.from(snapshot.secrets.values()).some((secret) => secret.namespaceId === namespaceId),
    hasCredentialSources: async (namespaceId) =>
      Array.from(snapshot.credentialSources.values()).some(
        (source) => source.namespaceId === namespaceId,
      ),
    transitionNamespaceStatus: async (namespaceId, expected, next) => {
      const key = namespaceId;
      const namespace = snapshot.namespaces.get(key);
      const expectedStatuses = Array.isArray(expected) ? expected : [expected];
      if (
        namespace === undefined ||
        namespace.deletedAt !== undefined ||
        !expectedStatuses.includes(namespace.status)
      ) {
        return undefined;
      }
      const allowed =
        namespace.status === next ||
        (namespace.status === "provisioning" &&
          (next === "ready" || next === "failed" || next === "deleting")) ||
        ((namespace.status === "ready" || namespace.status === "failed") && next === "deleting");
      if (!allowed) {
        throw new ScopeViolationError("The Namespace lifecycle transition is invalid.");
      }
      const saved = immutableCopy({ ...namespace, status: next });
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
    markNamespaceDeleted: async (namespaceId, deletedAt) => {
      const key = namespaceId;
      const namespace = snapshot.namespaces.get(key);
      if (namespace === undefined || namespace.status !== "deleting") {
        return undefined;
      }
      if (namespace.deletedAt !== undefined) {
        return immutableCopy(namespace);
      }
      if (
        Array.from(snapshot.agents.values()).some((agent) => agent.namespaceId === namespaceId) ||
        Array.from(snapshot.configurations.values()).some(
          (configuration) => configuration.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.presets.values()).some(
          (preset) => preset.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.serviceAccounts.values()).some(
          (account) => account.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.secrets.values()).some(
          (secret) => secret.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.credentialSources.values()).some(
          (source) => source.namespaceId === namespaceId,
        )
      ) {
        throw new ScopeViolationError("A nonempty Namespace cannot be tombstoned.");
      }
      const deletedTime = new Date(deletedAt).getTime();
      const createdTime = new Date(namespace.createdAt).getTime();
      if (Number.isNaN(deletedTime) || Number.isNaN(createdTime) || deletedTime < createdTime) {
        throw new ScopeViolationError("The Namespace tombstone timestamp is invalid.");
      }
      const saved = immutableCopy({ ...namespace, deletedAt });
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
  };

  // Deleting a Namespace resource also removes the AccessBindings that grant
  // on it (as Agent deletion does), so none outlive their target or keep
  // blocking deletion of the Role they reference. Resource ids are unique.
  const deleteResourceAccessBindings = (
    resourceKind: "configuration" | "preset" | "secret" | "credential_source" | "service_account",
    resourceId: string,
  ): void => {
    for (const [key, binding] of snapshot.bindings) {
      if (binding.resourceKind === resourceKind && binding.resourceId === resourceId) {
        snapshot.bindings.delete(key);
      }
    }
  };

  const findPreset: PresetReadRepository["findPreset"] = async (namespaceId, presetId) => {
    if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
      return undefined;
    }
    const preset = snapshot.presets.get(agentKey(namespaceId, presetId));
    return preset === undefined ? undefined : immutableCopy(preset);
  };
  const presets: PresetRepository = {
    findPreset,
    listPresets: async (namespaceId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined
          ? []
          : Array.from(snapshot.presets.values())
              .filter((preset) => preset.namespaceId === namespaceId)
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((preset) => immutableCopy(preset)),
      ),
    createPreset: async (preset) => {
      assertInitialized(snapshot);
      const namespace = await namespaces.lockNamespace(preset.namespaceId);
      if (namespace === undefined || !["provisioning", "ready"].includes(namespace.status)) {
        throw new ScopeViolationError("The Preset belongs to an unavailable Namespace.");
      }
      if (Array.from(snapshot.presets.values()).some((existing) => existing.id === preset.id)) {
        throw new ResourceConflictError("The server generated an existing Preset identity.");
      }
      if (
        Array.from(snapshot.presets.values()).some(
          (existing) =>
            existing.namespaceId === preset.namespaceId && existing.name === preset.name,
        )
      ) {
        throw new ResourceStateConflictError(PRESET_NAME_CONFLICT);
      }
      const saved = immutableCopy(preset);
      snapshot.presets.set(agentKey(preset.namespaceId, preset.id), saved);
      return immutableCopy(saved);
    },
    lockPreset: findPreset,
    updatePreset: async (namespaceId, presetId, changes) => {
      const current = await findPreset(namespaceId, presetId);
      if (current === undefined) {
        return undefined;
      }
      const saved = immutableCopy({ ...current, ...changes });
      if (
        Array.from(snapshot.presets.values()).some(
          (existing) =>
            existing.namespaceId === namespaceId &&
            existing.id !== presetId &&
            existing.name === saved.name,
        )
      ) {
        throw new ResourceStateConflictError(PRESET_NAME_CONFLICT);
      }
      snapshot.presets.set(agentKey(namespaceId, presetId), saved);
      return immutableCopy(saved);
    },
    deletePreset: async (namespaceId, presetId) => {
      if ((await findPreset(namespaceId, presetId)) === undefined) {
        return false;
      }
      snapshot.presets.delete(agentKey(namespaceId, presetId));
      deleteResourceAccessBindings("preset", presetId);
      return true;
    },
  };

  const configurations: ConfigurationRepository = {
    findConfiguration: async (namespaceId, configurationId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return undefined;
      }
      const configuration = snapshot.configurations.get(agentKey(namespaceId, configurationId));
      return configuration === undefined ? undefined : immutableCopy(configuration);
    },
    createConfiguration: async (configuration) => {
      assertInitialized(snapshot);
      if (
        configuration.kind !== "agent" ||
        !Number.isSafeInteger(configuration.generation) ||
        configuration.generation <= 0
      ) {
        throw new ScopeViolationError("The Configuration kind or generation is invalid.");
      }
      const namespace = await namespaces.lockNamespace(configuration.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The Configuration belongs to an unavailable Namespace.");
      }
      const key = agentKey(configuration.namespaceId, configuration.id);
      if (
        snapshot.configurations.has(key) ||
        Array.from(snapshot.configurations.values()).some(
          (existing) => existing.id === configuration.id,
        )
      ) {
        throw new ResourceConflictError("The server generated an existing Configuration identity.");
      }
      const secretBindings = normalizedSecretBindings(configuration.secretBindings);
      await assertSecretBindingsAvailable(
        {
          findSecret: async (namespaceId, secretId) => {
            const secret = snapshot.secrets.get(agentKey(namespaceId, secretId));
            return secret === undefined ? undefined : immutableCopy(secret);
          },
        },
        configuration.namespaceId,
        secretBindings,
      );
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = configuration;
      const saved = immutableCopy({
        ...withoutSecretBindings,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
      snapshot.configurations.set(key, saved);
      return immutableCopy(saved);
    },
    lockConfiguration: async (namespaceId, configurationId) =>
      configurations.findConfiguration(namespaceId, configurationId),
    advanceConfigurationGeneration: async (
      namespaceId,
      configurationId,
      expectedGeneration,
      nextSecretBindings,
    ) => {
      const current = await configurations.findConfiguration(namespaceId, configurationId);
      if (current === undefined || current.generation !== expectedGeneration) {
        return undefined;
      }
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        throw new ScopeViolationError("The Configuration generation exceeds its supported range.");
      }
      const secretBindings =
        nextSecretBindings === undefined
          ? current.secretBindings
          : normalizedSecretBindings(nextSecretBindings);
      await assertSecretBindingsAvailable(secrets, namespaceId, secretBindings);
      const { secretBindings: _currentSecretBindings, ...withoutSecretBindings } = current;
      const updated = immutableCopy({
        ...withoutSecretBindings,
        generation: current.generation + 1,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
      snapshot.configurations.set(agentKey(namespaceId, configurationId), updated);
      return immutableCopy(updated);
    },
    deleteConfiguration: async (namespaceId, configurationId) => {
      const existing = await configurations.findConfiguration(namespaceId, configurationId);
      if (existing === undefined) {
        return false;
      }
      if (
        Array.from(snapshot.agents.values()).some(
          (agent) => agent.namespaceId === namespaceId && agent.configurationId === configurationId,
        )
      ) {
        throw new ScopeViolationError("The Configuration is referenced by an Agent.");
      }
      snapshot.configurations.delete(agentKey(namespaceId, configurationId));
      deleteResourceAccessBindings("configuration", configurationId);
      return true;
    },
  };

  const secrets: SecretRepository = {
    findSecret: async (namespaceId, secretId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return undefined;
      }
      const secret = snapshot.secrets.get(agentKey(namespaceId, secretId));
      return secret === undefined ? undefined : immutableCopy(secret);
    },
    listSecrets: async (namespaceId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return Object.freeze([]);
      }
      return Object.freeze(
        Array.from(snapshot.secrets.values())
          .filter((secret) => secret.namespaceId === namespaceId)
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? left.id.localeCompare(right.id)
              : left.createdAt.localeCompare(right.createdAt),
          )
          .map((secret) => immutableCopy(secret)),
      );
    },
    lockSecret: async (namespaceId, secretId) => secrets.findSecret(namespaceId, secretId),
    createSecret: async (secret) => {
      assertInitialized(snapshot);
      assertSecret(secret);
      const namespace = await namespaces.lockNamespace(secret.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The Secret belongs to an unavailable Namespace.");
      }
      const key = agentKey(secret.namespaceId, secret.id);
      if (
        snapshot.secrets.has(key) ||
        Array.from(snapshot.secrets.values()).some((existing) => existing.id === secret.id)
      ) {
        throw new ResourceConflictError("The server generated an existing Secret identity.");
      }
      if (
        Array.from(snapshot.secrets.values()).some(
          (existing) =>
            existing.namespaceId === secret.namespaceId && existing.name === secret.name,
        )
      ) {
        throw new ResourceStateConflictError(SECRET_NAME_CONFLICT);
      }
      const saved = immutableCopy(secret);
      snapshot.secrets.set(key, saved);
      return immutableCopy(saved);
    },
    listReferences: async (namespaceId, secretId, limit) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) {
        return Object.freeze({ references: Object.freeze([]), truncated: false });
      }
      const found = new Map<string, Readonly<SecretReferenceEntry>>();
      const add = (kind: SecretReferenceKind, id: string): void => {
        found.set(`${kind}\u0000${id}`, Object.freeze({ kind, id }));
      };
      for (const configuration of snapshot.configurations.values()) {
        if (
          configuration.namespaceId === namespaceId &&
          secretBindingsReference(configuration.secretBindings, namespaceId, secretId)
        ) {
          add("configuration", configuration.id);
        }
      }
      for (const source of snapshot.credentialSources.values()) {
        if (
          source.namespaceId === namespaceId &&
          Object.values(source.secrets).some((reference) => reference.id === secretId)
        ) {
          add("credential_source", source.id);
        }
      }
      for (const agent of snapshot.agents.values()) {
        const activeRevision = (snapshot.revisions.get(agentKey(namespaceId, agent.id)) ?? []).find(
          (revision) => revision.id === agent.activeRevisionId,
        );
        if (
          agent.namespaceId === namespaceId &&
          (harnessSecretReference(agent.harnessAuth, namespaceId, secretId) ||
            harnessSecretReference(activeRevision?.harnessAuth, namespaceId, secretId) ||
            secretBindingsReference(activeRevision?.secretBindings, namespaceId, secretId))
        ) {
          add("agent", agent.id);
        }
      }
      for (const operation of snapshot.operations) {
        if (operation.kind !== "agent_revision" || operation.namespaceId !== namespaceId) {
          continue;
        }
        const revision = Array.from(snapshot.revisions.values())
          .flat()
          .find(
            (candidate) =>
              candidate.namespaceId === namespaceId && candidate.id === operation.resourceId,
          );
        if (
          revision !== undefined &&
          (secretBindingsReference(revision.secretBindings, namespaceId, secretId) ||
            harnessSecretReference(revision.harnessAuth, namespaceId, secretId))
        ) {
          add("agent", revision.agentId);
        }
      }
      // Kind, then ID, in code-unit order, as PostgreSQL's COLLATE "C" sorts them.
      const ordered = Array.from(found.keys())
        .sort()
        .map((key) => found.get(key) as Readonly<SecretReferenceEntry>);
      return Object.freeze({
        references: Object.freeze(ordered.slice(0, limit)),
        truncated: ordered.length > limit,
      });
    },
    hasReferences: async (namespaceId, secretId) =>
      (await secrets.listReferences(namespaceId, secretId, 1)).references.length > 0,
    deleteSecret: async (namespaceId, secretId) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) {
        return false;
      }
      if (await secrets.hasReferences(namespaceId, secretId)) {
        throw new ScopeViolationError("The Secret is referenced by active platform state.");
      }
      snapshot.secrets.delete(agentKey(namespaceId, secretId));
      deleteResourceAccessBindings("secret", secretId);
      return true;
    },
  };

  const findCredentialSource: CredentialSourceReadRepository["findCredentialSource"] = async (
    namespaceId,
    credentialSourceId,
  ) => {
    if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
      return undefined;
    }
    const source = snapshot.credentialSources.get(agentKey(namespaceId, credentialSourceId));
    return source === undefined ? undefined : immutableCopy(source);
  };

  const withdrawalKey = (namespaceId: string, revisionId: string, credentialSourceId: string) =>
    JSON.stringify([namespaceId, revisionId, credentialSourceId]);
  // Mirrors the database cascades: a withdrawal ends with its revision or its source.
  const liveWithdrawal = (withdrawal: Readonly<CredentialWithdrawal>) =>
    snapshot.credentialSources.has(
      agentKey(withdrawal.namespaceId, withdrawal.credentialSourceId),
    ) &&
    (snapshot.revisions.get(agentKey(withdrawal.namespaceId, withdrawal.agentId)) ?? []).some(
      (revision) => revision.id === withdrawal.revisionId,
    );
  const findCredentialWithdrawal = async (
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
  ) => {
    const found = snapshot.credentialWithdrawals.get(
      withdrawalKey(namespaceId, revisionId, credentialSourceId),
    );
    return found === undefined || !liveWithdrawal(found) ? undefined : immutableCopy(found);
  };

  const credentialSources: CredentialSourceRepository = {
    findCredentialSource,
    findCredentialWithdrawal,
    listCredentialWithdrawals: async (namespaceId, revisionId) =>
      Object.freeze(
        Array.from(snapshot.credentialWithdrawals.values())
          .filter(
            (withdrawal) =>
              withdrawal.namespaceId === namespaceId &&
              withdrawal.revisionId === revisionId &&
              liveWithdrawal(withdrawal),
          )
          .sort((left, right) => left.credentialSourceId.localeCompare(right.credentialSourceId))
          .map((withdrawal) => immutableCopy(withdrawal)),
      ),
    requestCredentialWithdrawal: async (withdrawal) => {
      assertInitialized(snapshot);
      const existing = await findCredentialWithdrawal(
        withdrawal.namespaceId,
        withdrawal.revisionId,
        withdrawal.credentialSourceId,
      );
      if (existing !== undefined) {
        return existing;
      }
      if (
        withdrawal.state !== "pending" ||
        withdrawal.completedAt !== undefined ||
        !isNonEmptyString(withdrawal.requestedBy)
      ) {
        throw new ScopeViolationError("A new credential withdrawal must be pending.");
      }
      if (!liveWithdrawal(withdrawal)) {
        throw new ScopeViolationError(
          "The credential withdrawal must name an existing revision and source.",
        );
      }
      const saved = immutableCopy(withdrawal);
      snapshot.credentialWithdrawals.set(
        withdrawalKey(withdrawal.namespaceId, withdrawal.revisionId, withdrawal.credentialSourceId),
        saved,
      );
      return immutableCopy(saved);
    },
    recordCredentialWithdrawalAttempt: async (
      namespaceId,
      revisionId,
      credentialSourceId,
      attempt,
    ) => {
      const current = await findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId);
      if (current === undefined || current.state !== "pending") {
        return undefined;
      }
      if (!/^[A-Z0-9_]{1,64}$/u.test(attempt.reason)) {
        throw new ScopeViolationError("A credential withdrawal reason must be a reason code.");
      }
      const saved = immutableCopy({
        ...current,
        lastReason: attempt.reason,
        lastAttemptAt: attempt.at,
      });
      snapshot.credentialWithdrawals.set(
        withdrawalKey(namespaceId, revisionId, credentialSourceId),
        saved,
      );
      return immutableCopy(saved);
    },
    markCredentialWithdrawalRevoked: async (
      namespaceId,
      revisionId,
      credentialSourceId,
      completedAt,
    ) => {
      const current = await findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId);
      if (current === undefined || current.state !== "pending") {
        return undefined;
      }
      const saved = immutableCopy({ ...current, state: "revoked" as const, completedAt });
      snapshot.credentialWithdrawals.set(
        withdrawalKey(namespaceId, revisionId, credentialSourceId),
        saved,
      );
      return immutableCopy(saved);
    },
    listCredentialSources: async (namespaceId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return Object.freeze([]);
      }
      return Object.freeze(
        Array.from(snapshot.credentialSources.values())
          .filter((source) => source.namespaceId === namespaceId)
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? left.id.localeCompare(right.id)
              : left.createdAt.localeCompare(right.createdAt),
          )
          .map((source) => immutableCopy(source)),
      );
    },
    lockCredentialSource: findCredentialSource,
    createCredentialSource: async (source) => {
      assertInitialized(snapshot);
      assertCredentialSource(source);
      const namespace = await namespaces.lockNamespace(source.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The credential source belongs to an unavailable Namespace.");
      }
      for (const reference of Object.values(source.secrets)) {
        if (!snapshot.secrets.has(agentKey(source.namespaceId, reference.id))) {
          throw new ScopeViolationError("The credential source references an unavailable Secret.");
        }
      }
      const key = agentKey(source.namespaceId, source.id);
      if (
        snapshot.credentialSources.has(key) ||
        Array.from(snapshot.credentialSources.values()).some(
          (existing) => existing.id === source.id,
        )
      ) {
        throw new ResourceConflictError(
          "The server generated an existing credential source identity.",
        );
      }
      if (
        Array.from(snapshot.credentialSources.values()).some(
          (existing) =>
            existing.namespaceId === source.namespaceId && existing.name === source.name,
        )
      ) {
        throw new ResourceStateConflictError(CREDENTIAL_SOURCE_NAME_CONFLICT);
      }
      const saved = immutableCopy(source);
      snapshot.credentialSources.set(key, saved);
      return immutableCopy(saved);
    },
    replaceCredentialSourceSecrets: async (namespaceId, credentialSourceId, secrets) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (current === undefined || current.state !== "ready") {
        return undefined;
      }
      assertSameCredentialSourceFields(current.secrets, secrets);
      for (const reference of Object.values(secrets)) {
        if (
          reference.kind !== "secret" ||
          reference.namespaceId !== namespaceId ||
          !snapshot.secrets.has(agentKey(namespaceId, reference.id))
        ) {
          throw new ScopeViolationError("The credential source references an unavailable Secret.");
        }
      }
      const saved = immutableCopy({ ...current, secrets: { ...secrets } });
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return immutableCopy(saved);
    },
    markCredentialSourceReady: async (namespaceId, credentialSourceId) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (current === undefined || current.state !== "registering") {
        return undefined;
      }
      const saved = immutableCopy({ ...current, state: "ready" as const });
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return immutableCopy(saved);
    },
    markCredentialSourceDeleting: async (namespaceId, credentialSourceId) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (current === undefined || current.state === "deleting") {
        return undefined;
      }
      const saved = immutableCopy({ ...current, state: "deleting" as const });
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return immutableCopy(saved);
    },
    hasReferences: async (namespaceId, credentialSourceId) => {
      if ((await findCredentialSource(namespaceId, credentialSourceId)) === undefined) {
        return false;
      }
      return (
        Array.from(snapshot.agents.values()).some((agent) => {
          const activeRevision = (
            snapshot.revisions.get(agentKey(namespaceId, agent.id)) ?? []
          ).find((revision) => revision.id === agent.activeRevisionId);
          return (
            agent.namespaceId === namespaceId &&
            (harnessCredentialSourceReference(agent.harnessAuth, credentialSourceId) ||
              harnessCredentialSourceReference(activeRevision?.harnessAuth, credentialSourceId) ||
              agentCredentialSourceReference(agent.credentialSources, credentialSourceId) ||
              agentCredentialSourceReference(activeRevision?.credentialSources, credentialSourceId))
          );
        }) ||
        snapshot.operations.some((operation) => {
          if (operation.kind !== "agent_revision" || operation.namespaceId !== namespaceId) {
            return false;
          }
          const revision = Array.from(snapshot.revisions.values())
            .flat()
            .find(
              (candidate) =>
                candidate.namespaceId === namespaceId && candidate.id === operation.resourceId,
            );
          return (
            harnessCredentialSourceReference(revision?.harnessAuth, credentialSourceId) ||
            agentCredentialSourceReference(revision?.credentialSources, credentialSourceId)
          );
        })
      );
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
      snapshot.credentialSources.delete(agentKey(namespaceId, credentialSourceId));
      deleteResourceAccessBindings("credential_source", credentialSourceId);
      return true;
    },
  };

  const serviceAccounts: ServiceAccountRepository = {
    findServiceAccount: async (namespaceId, serviceAccountId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return undefined;
      }
      const account = snapshot.serviceAccounts.get(agentKey(namespaceId, serviceAccountId));
      return account === undefined ? undefined : immutableCopy(account);
    },
    listServiceAccounts: async (namespaceId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return Object.freeze([]);
      }
      return Object.freeze(
        Array.from(snapshot.serviceAccounts.values())
          .filter((account) => account.namespaceId === namespaceId)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          )
          .map((account) => immutableCopy(account)),
      );
    },
    findServiceAccountBackendBinding: async () => undefined,
    createServiceAccount: async (account) => {
      assertInitialized(snapshot);
      if (
        !serviceAccountIdentifier.test(account.id) ||
        typeof account.name !== "string" ||
        account.name.length < 1 ||
        Array.from(account.name).length > 200 ||
        account.name !== account.name.trim() ||
        /[\x00-\x1f\x7f]/.test(account.name) ||
        (account.credential !== undefined && !validCredential(account.credential))
      ) {
        throw new ScopeViolationError("The ServiceAccount or its credential reference is invalid.");
      }
      const namespace = await namespaces.lockNamespace(account.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The ServiceAccount belongs to an unavailable Namespace.");
      }
      const key = agentKey(account.namespaceId, account.id);
      if (
        snapshot.serviceAccounts.has(key) ||
        Array.from(snapshot.serviceAccounts.values()).some((existing) => existing.id === account.id)
      ) {
        throw new ResourceConflictError(
          "The server generated an existing ServiceAccount identity.",
        );
      }
      if (
        Array.from(snapshot.serviceAccounts.values()).some(
          (existing) =>
            existing.namespaceId === account.namespaceId && existing.name === account.name,
        )
      ) {
        throw new ResourceStateConflictError(SERVICE_ACCOUNT_NAME_CONFLICT);
      }
      const saved = immutableCopy(account);
      snapshot.serviceAccounts.set(key, saved);
      return immutableCopy(saved);
    },
    lockServiceAccount: async (namespaceId, serviceAccountId) =>
      serviceAccounts.findServiceAccount(namespaceId, serviceAccountId),
    updateCredential: async (namespaceId, serviceAccountId, credential) => {
      if (!validCredential(credential)) {
        throw new ScopeViolationError("The ServiceAccount credential reference is invalid.");
      }
      const current = await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
      if (current === undefined) {
        return undefined;
      }
      const updated = immutableCopy({ ...current, credential });
      snapshot.serviceAccounts.set(agentKey(namespaceId, serviceAccountId), updated);
      return immutableCopy(updated);
    },
    hasReferences: async (namespaceId, serviceAccountId) => {
      if ((await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId)) === undefined) {
        return false;
      }
      return (
        Array.from(snapshot.agents.values()).some((agent) => {
          if (agent.namespaceId !== namespaceId) {
            return false;
          }
          const activeRevision = (
            snapshot.revisions.get(agentKey(namespaceId, agent.id)) ?? []
          ).find((revision) => revision.id === agent.activeRevisionId);
          return (
            harnessAccountReference(agent.harnessAuth, serviceAccountId) ||
            harnessAccountReference(activeRevision?.harnessAuth, serviceAccountId)
          );
        }) ||
        snapshot.operations.some((operation) => {
          if (operation.kind !== "agent_revision" || operation.namespaceId !== namespaceId) {
            return false;
          }
          return Array.from(snapshot.revisions.values()).some((revisions) =>
            revisions.some(
              (revision) =>
                revision.namespaceId === namespaceId &&
                revision.id === operation.resourceId &&
                harnessAccountReference(revision.harnessAuth, serviceAccountId),
            ),
          );
        })
      );
    },
    deleteServiceAccount: async (namespaceId, serviceAccountId) => {
      if ((await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId)) === undefined) {
        return false;
      }
      if (await serviceAccounts.hasReferences(namespaceId, serviceAccountId)) {
        throw new ScopeViolationError("The ServiceAccount is referenced by active platform state.");
      }
      snapshot.serviceAccounts.delete(agentKey(namespaceId, serviceAccountId));
      deleteResourceAccessBindings("service_account", serviceAccountId);
      return true;
    },
  };

  const workspaceSetups: WorkspaceSetupRepository = {
    find: async (namespaceId, agentId) => {
      const setup = snapshot.workspaceSetups.get(agentKey(namespaceId, agentId));
      return setup === undefined ? undefined : immutableCopy(setup);
    },
    create: async (setup) => {
      const owner = snapshot.agents.get(agentKey(setup.namespaceId, setup.agentId));
      if (owner === undefined || owner.status !== "active") {
        throw new ScopeViolationError("The workspace setup requires its exact active Agent.");
      }
      let files;
      let defaultsId;
      try {
        files = normalizeInitialWorkspaceFiles(setup.files);
        defaultsId = normalizeWorkspaceDefaultsId(setup.defaultsId);
      } catch {
        throw new ScopeViolationError("The workspace setup is invalid.");
      }
      if (
        !isNonEmptyString(setup.id) ||
        setup.id.length > 200 ||
        setup.completed ||
        files === undefined
      ) {
        throw new ScopeViolationError("The workspace setup must begin with pending files.");
      }
      const key = agentKey(setup.namespaceId, setup.agentId);
      if (
        snapshot.workspaceSetups.has(key) ||
        Array.from(snapshot.workspaceSetups.values()).some((other) => other.id === setup.id)
      ) {
        throw new ResourceConflictError("The Agent already owns a workspace setup.");
      }
      const saved = immutableCopy({
        ...setup,
        files,
        ...(defaultsId === undefined ? {} : { defaultsId }),
      });
      snapshot.workspaceSetups.set(key, saved);
      return immutableCopy(saved);
    },
    complete: async (namespaceId, agentId, id) => {
      const key = agentKey(namespaceId, agentId);
      const setup = snapshot.workspaceSetups.get(key);
      if (setup === undefined || setup.id !== id) {
        return undefined;
      }
      const { files: _files, ...metadata } = setup;
      const completed = immutableCopy({ ...metadata, completed: true });
      snapshot.workspaceSetups.set(key, completed);
      return immutableCopy(completed);
    },
    delete: async (namespaceId, agentId) =>
      snapshot.workspaceSetups.delete(agentKey(namespaceId, agentId)),
  };

  const agents: AgentRepository = {
    findAgentForBrowsing: async (namespaceId, agentId) => agents.findAgent(namespaceId, agentId),
    listAgentsForBrowsing: async (namespaceId) => agents.listAgents(namespaceId),
    findAgent: async (namespaceId, agentId) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      if (namespace?.deletedAt !== undefined) {
        return undefined;
      }
      const agent = snapshot.agents.get(agentKey(namespaceId, agentId));
      return agent?.namespaceId === namespaceId ? immutableCopy(agent) : undefined;
    },
    listAgents: async (namespaceId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? Array.from(snapshot.agents.values())
              .filter((agent) => agent.namespaceId === namespaceId)
              .map((agent) => immutableCopy(agent))
          : [],
      ),
    createAgent: async (agent) => {
      assertInitialized(snapshot);
      if (agent.executionMode !== "embedded" && agent.executionMode !== "dedicated") {
        throw new ScopeViolationError("The Agent execution mode is invalid.");
      }
      if (agent.backendId !== null && !isBackendId(agent.backendId)) {
        throw new ScopeViolationError("The Agent Backend identity is invalid.");
      }
      const plugins = normalizedPlugins(agent.plugins);
      const pluginApprovers = normalizedPluginApprovers(agent.pluginApprovers);
      const repositoryBindings = normalizedRepositoryBindings(agent.repositoryBindings);
      const repositoryAccess = normalizedRepositoryAccess(
        agent.repositoryAccess,
        repositoryBindings,
      );
      const namespace = await namespaces.lockNamespace(agent.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The Agent belongs to an unavailable Namespace.");
      }
      await assertConfigurationUsableByAgent(
        configurations,
        secrets,
        agent.namespaceId,
        agent.configurationId,
      );
      await assertHarnessAuthAvailable(
        { secrets, serviceAccounts, credentialSources },
        agent.namespaceId,
        agent.harnessAuth,
      );
      await assertAgentCredentialSourcesAvailable(
        { credentialSources },
        agent.namespaceId,
        agent.credentialSources,
      );
      assertHarnessCredentialSourceListed(agent.harnessAuth, agent.credentialSources);
      const key = agentKey(agent.namespaceId, agent.id);
      if (snapshot.agents.has(key)) {
        throw new ResourceConflictError("The server generated an existing Agent identity.");
      }
      if (
        Array.from(snapshot.agents.values()).some(
          (existing) => existing.namespaceId === agent.namespaceId && existing.name === agent.name,
        )
      ) {
        throw new ResourceStateConflictError(AGENT_NAME_CONFLICT);
      }
      if (
        Array.from(snapshot.agents.values()).some(
          (existing) => existing.servicePrincipalId === agent.servicePrincipalId,
        )
      ) {
        throw new ResourceConflictError(
          "An Agent service principal already belongs to another Agent.",
        );
      }
      const {
        plugins: _providedPlugins,
        pluginApprovers: _providedPluginApprovers,
        repositoryBindings: _providedRepositoryBindings,
        repositoryAccess: _providedRepositoryAccess,
        ...withoutPlugins
      } = agent;
      const saved = immutableCopy({
        ...withoutPlugins,
        ...(plugins === undefined ? {} : { plugins }),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
        desiredRuntimeState: "stopped" as const,
        status: "active" as const,
      });
      snapshot.agents.set(key, saved);
      return immutableCopy(saved);
    },
    lockAgent: async (namespaceId, agentId) => agents.findAgent(namespaceId, agentId),
    transitionAgentDesiredRuntimeState: async (namespaceId, agentId, expected, next) => {
      const key = agentKey(namespaceId, agentId);
      const agent = snapshot.agents.get(key);
      const expectedStates = Array.isArray(expected) ? expected : [expected];
      if (
        agent === undefined ||
        agent.namespaceId !== namespaceId ||
        !expectedStates.includes(agent.desiredRuntimeState)
      ) {
        return undefined;
      }
      const saved = immutableCopy({ ...agent, desiredRuntimeState: next });
      snapshot.agents.set(key, saved);
      return immutableCopy(saved);
    },
    transitionAgentStatus: async (namespaceId, agentId, expected, next) => {
      const key = agentKey(namespaceId, agentId);
      const agent = snapshot.agents.get(key);
      const expectedStatuses = Array.isArray(expected) ? expected : [expected];
      if (
        agent === undefined ||
        agent.namespaceId !== namespaceId ||
        !expectedStatuses.includes(agent.status)
      ) {
        return undefined;
      }
      // Mirrors agents_status_valid and the one-way active -> deleting path the
      // database enforces; deletion removes the row, so nothing returns to active.
      if (agent.status !== next && !(agent.status === "active" && next === "deleting")) {
        throw new ScopeViolationError("The Agent lifecycle transition is invalid.");
      }
      if (next === "deleting" && agent.desiredRuntimeState !== "stopped") {
        throw new ScopeViolationError("A deleting Agent must already be stopped.");
      }
      const saved = immutableCopy({ ...agent, status: next });
      snapshot.agents.set(key, saved);
      return immutableCopy(saved);
    },
    updateConfiguration: async (
      namespaceId,
      agentId,
      configurationId,
      executionMode,
      harnessAuth,
      backendId,
      nextPlugins,
      nextRepositoryBindings,
      nextPluginApprovers,
      nextRepositoryAccess,
      nextCredentialSources,
    ) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current) {
        return undefined;
      }
      if (backendId !== undefined && backendId !== null && !isBackendId(backendId)) {
        throw new ScopeViolationError("The Agent Backend identity is invalid.");
      }
      if (
        executionMode !== undefined &&
        executionMode !== "embedded" &&
        executionMode !== "dedicated"
      ) {
        throw new ScopeViolationError("The Agent execution mode is invalid.");
      }
      if ((await configurations.findConfiguration(namespaceId, configurationId)) === undefined) {
        throw new ScopeViolationError("The Agent references an unavailable Configuration.");
      }
      await assertConfigurationUsableByAgent(configurations, secrets, namespaceId, configurationId);
      const association = harnessAuth === undefined ? current.harnessAuth : harnessAuth;
      await assertHarnessAuthAvailable(
        { secrets, serviceAccounts, credentialSources },
        namespaceId,
        association,
      );
      await assertAgentCredentialSourcesAvailable(
        { credentialSources },
        namespaceId,
        nextCredentialSources,
      );
      const agentCredentialSources =
        nextCredentialSources === undefined ? current.credentialSources : nextCredentialSources;
      assertHarnessCredentialSourceListed(association, agentCredentialSources);
      const nextBackendId = backendId === undefined ? current.backendId : backendId;
      const plugins = nextPlugins === undefined ? current.plugins : normalizedPlugins(nextPlugins);
      const pluginApprovers =
        nextPluginApprovers === undefined
          ? current.pluginApprovers
          : nextPluginApprovers === null
            ? undefined
            : normalizedPluginApprovers(nextPluginApprovers);
      const repositoryBindings =
        nextRepositoryBindings === undefined
          ? current.repositoryBindings
          : normalizedRepositoryBindings(nextRepositoryBindings);
      const repositoryAccess = normalizedRepositoryAccess(
        nextRepositoryAccess === undefined
          ? nextRepositoryBindings === undefined
            ? current.repositoryAccess
            : undefined
          : nextRepositoryAccess,
        repositoryBindings,
      );
      const {
        repositoryAccess: _currentRepositoryAccess,
        plugins: _currentPlugins,
        pluginApprovers: _currentPluginApprovers,
        repositoryBindings: _currentRepositoryBindings,
        credentialSources: _currentCredentialSources,
        ...withoutPlugins
      } = current;
      const updated = immutableCopy({
        ...withoutPlugins,
        configurationId,
        backendId: nextBackendId,
        executionMode: executionMode ?? current.executionMode,
        harnessAuth: association,
        ...(agentCredentialSources === undefined || agentCredentialSources.length === 0
          ? {}
          : { credentialSources: agentCredentialSources }),
        ...(plugins === undefined ? {} : { plugins }),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
      });
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return immutableCopy(updated);
    },
    compareAndClearActiveRevision: async (namespaceId, agentId, expectedRevisionId) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current || current.activeRevisionId !== expectedRevisionId) {
        return undefined;
      }
      const { activeRevisionId: _activeRevisionId, ...stopped } = current;
      const updated = immutableCopy(stopped);
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return immutableCopy(updated);
    },
    compareAndSetActiveRevision: async (
      namespaceId,
      agentId,
      expectedRevisionId,
      candidateRevisionId,
    ) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current || current.activeRevisionId !== expectedRevisionId) {
        return undefined;
      }
      const candidate = await revisions.findRevision(namespaceId, agentId, candidateRevisionId);
      if (!candidate) {
        throw new ScopeViolationError("The active AgentRevision belongs to another Agent.");
      }
      const updated = immutableCopy({ ...current, activeRevisionId: candidateRevisionId });
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return immutableCopy(updated);
    },
  };

  const revisions: AgentRevisionRepository = {
    findRevisionForBrowsing: async (namespaceId, agentId, revisionId) =>
      revisions.findRevision(namespaceId, agentId, revisionId),
    listRevisionsForBrowsing: async (namespaceId, agentId) =>
      revisions.listRevisions(namespaceId, agentId),
    findRevision: async (namespaceId, agentId, revisionId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return undefined;
      }
      const candidate = snapshot.revisions
        .get(agentKey(namespaceId, agentId))
        ?.find((revision) => revision.id === revisionId);
      return candidate?.namespaceId === namespaceId && candidate.agentId === agentId
        ? immutableCopy(candidate)
        : undefined;
    },
    listRevisions: async (namespaceId, agentId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? (snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [])
              .filter(
                (revision) => revision.namespaceId === namespaceId && revision.agentId === agentId,
              )
              .map((revision) => immutableCopy(revision))
          : [],
      ),
    createRevision: async (revision) => {
      assertInitialized(snapshot);
      assertAdmittedAgentRevision(revision);
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
      await assertHarnessAuthAvailable(
        { secrets, serviceAccounts, credentialSources },
        revision.namespaceId,
        harnessAuthBindingFromSnapshot(revision.harnessAuth),
      );
      const secretBindings = normalizedSecretBindings(revision.secretBindings);
      const plugins = revision.plugins === undefined ? undefined : immutableCopy(revision.plugins);
      await assertSecretBindingsAvailable(secrets, revision.namespaceId, secretBindings);
      const key = agentKey(revision.namespaceId, revision.agentId);
      const previous = snapshot.revisions.get(key) ?? [];
      if (previous.some((existing) => existing.id === revision.id)) {
        throw new ResourceConflictError("The server generated an existing AgentRevision identity.");
      }
      const {
        secretBindings: _providedSecretBindings,
        plugins: _providedPlugins,
        ...withoutSecretBindings
      } = revision;
      const saved = immutableCopy({
        ...withoutSecretBindings,
        ...(secretBindings === undefined ? {} : { secretBindings }),
        ...(plugins === undefined ? {} : { plugins }),
      });
      snapshot.revisions.set(key, Object.freeze([...previous, saved]));
      return immutableCopy(saved);
    },
  };

  // A revision of a deleting Agent is removed with it, so it admits no new binding.
  const liveAgentRevisionExists = (namespaceId: string, revisionId: string): boolean =>
    Array.from(snapshot.revisions.values())
      .flat()
      .some(
        (revision) =>
          revision.namespaceId === namespaceId &&
          revision.id === revisionId &&
          snapshot.agents.get(agentKey(namespaceId, revision.agentId))?.status === "active",
      );

  const managedPolicyResourceExists = async (
    namespaceId: string,
    resourceKind: NonNullable<AccessBinding["resourceKind"]>,
    resourceId: string,
  ): Promise<boolean> => {
    if (resourceKind === "namespace") {
      return (
        resourceId === namespaceId && (await namespaces.findNamespace(namespaceId)) !== undefined
      );
    }
    if (resourceKind === "agent") {
      return (await agents.findAgent(namespaceId, resourceId))?.status === "active";
    }
    if (resourceKind === "agent_revision") {
      return liveAgentRevisionExists(namespaceId, resourceId);
    }
    if (resourceKind === "configuration") {
      return (await configurations.findConfiguration(namespaceId, resourceId)) !== undefined;
    }
    if (resourceKind === "preset") {
      return (await presets.findPreset(namespaceId, resourceId)) !== undefined;
    }
    if (resourceKind === "secret") {
      return (await secrets.findSecret(namespaceId, resourceId)) !== undefined;
    }
    if (resourceKind === "credential_source") {
      return (await findCredentialSource(namespaceId, resourceId)) !== undefined;
    }
    if (resourceKind === "service_account") {
      return (await serviceAccounts.findServiceAccount(namespaceId, resourceId)) !== undefined;
    }
    return false;
  };

  const namespaceServicePrincipalExists = (namespaceId: string, identityId: string): boolean =>
    Array.from(snapshot.agents.values()).some(
      (agent) =>
        agent.namespaceId === namespaceId &&
        agent.servicePrincipalId === identityId &&
        agent.status === "active" &&
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined,
    );

  // A human without a Namespace, or a non-Agent ServicePrincipal of the exact Namespace.
  const bindableIdentity = (namespaceId: string, identity: Identity | undefined): boolean =>
    identity !== undefined &&
    ((identity.kind === "principal" && identity.namespaceId === undefined) ||
      (identity.kind === "service_principal" &&
        identity.namespaceId === namespaceId &&
        identity.agentId === undefined));

  const policySubjectExists = (namespaceId: string, identityId: string): boolean => {
    // Agent ServicePrincipals resolve only through live Agents.
    if (namespaceServicePrincipalExists(namespaceId, identityId)) {
      return true;
    }
    if (snapshot.servicePrincipals.get(identityId)?.namespaceId === namespaceId) {
      return true;
    }
    const resolved = iamSubjects.resolve?.(identityId);
    if (resolved?.id === identityId && bindableIdentity(namespaceId, resolved)) {
      return true;
    }
    return iamSubjects.identities.some(
      (identity) => identity.id === identityId && bindableIdentity(namespaceId, identity),
    );
  };

  const iamPolicy: IAMPolicyRepository = {
    listRoles: async (namespaceId) =>
      Object.freeze(
        Array.from(snapshot.roles.values())
          .filter((role) => role.namespaceId === namespaceId)
          .map((role) => immutableCopy(role)),
      ),
    getRole: async (namespaceId, roleId) => {
      const role = snapshot.roles.get(iamPolicyKey(namespaceId, roleId));
      return role === undefined ? undefined : immutableCopy(role);
    },
    createRole: async (role) => {
      assertInitialized(snapshot);
      const namespace = await namespaces.lockNamespace(role.namespaceId ?? "");
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The IAM Role belongs to an unavailable Namespace.");
      }
      const key = iamPolicyKey(namespace.id, role.id);
      if (
        snapshot.roles.has(key) ||
        Array.from(snapshot.roles.values()).some((candidate) => candidate.id === role.id)
      ) {
        throw new ResourceConflictError("The server generated an existing IAM Role identity.");
      }
      if (role.namespaceId !== namespace.id || role.permissions.length === 0) {
        throw new ScopeViolationError("The IAM Role must be Namespace-scoped and nonempty.");
      }
      if (namespaceRoleGrantsBeyondRead(role)) {
        throw new ScopeViolationError("Namespace IAM Roles support only Namespace read.");
      }
      const saved = immutableCopy(role);
      snapshot.roles.set(key, saved);
      return immutableCopy(saved);
    },
    deleteRole: async (namespaceId, roleId) => {
      const key = iamPolicyKey(namespaceId, roleId);
      if (!snapshot.roles.has(key)) {
        return false;
      }
      if (
        Array.from(snapshot.bindings.values()).some(
          (binding) => binding.namespaceId === namespaceId && binding.roleId === roleId,
        )
      ) {
        throw new IAMRoleInUseError();
      }
      snapshot.roles.delete(key);
      return true;
    },
    listAccessBindings: async (namespaceId) =>
      Object.freeze(
        Array.from(snapshot.bindings.values())
          .filter((binding) => binding.namespaceId === namespaceId)
          .map((binding) => immutableCopy(binding)),
      ),
    getAccessBinding: async (namespaceId, bindingId) => {
      const binding = snapshot.bindings.get(iamPolicyKey(namespaceId, bindingId));
      return binding === undefined ? undefined : immutableCopy(binding);
    },
    // In memory, Restrictions live in the IAM driver's seed, not in platform state, and
    // no deletion removes them.
    listRestrictionsTargeting: async () => Object.freeze([]),
    createAccessBinding: async (binding) => {
      assertInitialized(snapshot);
      const namespaceId = binding.namespaceId ?? "";
      const namespace = await namespaces.lockNamespace(namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      ) {
        throw new ScopeViolationError("The IAM AccessBinding belongs to an unavailable Namespace.");
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
      if (
        binding.subjectKind !== "identity" ||
        !policySubjectExists(namespace.id, binding.subjectId)
      ) {
        throw new IAMPolicyValidationError(
          "/subjectId",
          "The IAM AccessBinding subject must be a human Principal, a non-Agent ServicePrincipal of this Namespace, or the ServicePrincipal of a live Agent here.",
        );
      }
      if (
        binding.resourceKind === undefined ||
        binding.resourceId === undefined ||
        !(await managedPolicyResourceExists(namespace.id, binding.resourceKind, binding.resourceId))
      ) {
        throw new IAMPolicyValidationError(
          "/resourceId",
          "The IAM AccessBinding target does not exist in this Namespace or is being deleted.",
        );
      }
      const key = iamPolicyKey(namespace.id, binding.id);
      if (
        snapshot.bindings.has(key) ||
        Array.from(snapshot.bindings.values()).some((candidate) => candidate.id === binding.id)
      ) {
        throw new ResourceConflictError(
          "The server generated an existing IAM AccessBinding identity.",
        );
      }
      const saved = immutableCopy(binding);
      snapshot.bindings.set(key, saved);
      return immutableCopy(saved);
    },
    deleteAccessBinding: async (namespaceId, bindingId) =>
      snapshot.bindings.delete(iamPolicyKey(namespaceId, bindingId)),
    listServicePrincipals: async (namespaceId) =>
      Object.freeze(
        Array.from(snapshot.servicePrincipals.values()).filter(
          (servicePrincipal) => servicePrincipal.namespaceId === namespaceId,
        ),
      ),
    getServicePrincipal: async (namespaceId, servicePrincipalId) => {
      const found = snapshot.servicePrincipals.get(servicePrincipalId);
      return found?.namespaceId === namespaceId ? found : undefined;
    },
    createServicePrincipal: async (servicePrincipal) => {
      assertInitialized(snapshot);
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
      if (
        snapshot.servicePrincipals.has(servicePrincipal.id) ||
        iamSubjects.resolve?.(servicePrincipal.id) !== undefined ||
        iamSubjects.identities.some((identity) => identity.id === servicePrincipal.id)
      ) {
        throw new ResourceConflictError(
          "The server generated an existing ServicePrincipal identity.",
        );
      }
      const saved = Object.freeze({
        kind: "service_principal" as const,
        id: servicePrincipal.id,
        namespaceId: namespace.id,
      });
      snapshot.servicePrincipals.set(saved.id, saved);
      return saved;
    },
  };

  const repositorySessions = memoryRepositorySessions(
    snapshot.repositorySessions,
    snapshot.repositoryBrokerReceipts,
    (owner) =>
      snapshot.revisions
        .get(agentKey(owner.namespaceId, owner.agentId))
        ?.find((revision) => revision.id === owner.revisionId),
    (owner) => {
      const namespace = snapshot.namespaces.get(owner.namespaceId);
      const agent = snapshot.agents.get(agentKey(owner.namespaceId, owner.agentId));
      return (
        namespace?.status === "ready" &&
        agent?.status === "active" &&
        agent.desiredRuntimeState === "running"
      );
    },
  );

  const provisioningUnavailable = async (): Promise<never> => {
    throw new DependencyUnavailableError(
      "Agent provisioning requires durable PostgreSQL state for checkpoints.",
    );
  };
  const provisioningAbsent = async (): Promise<undefined> => undefined;
  const provisioningPendingAbsent = async (): Promise<boolean> => false;

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
    repositorySessions,
    provisioning: {
      findByWorkId: provisioningAbsent,
      findWithWork: provisioningAbsent,
      hasPendingNamespaceProvisioning: provisioningPendingAbsent,
      findByAgent: provisioningAbsent,
      findByConfiguration: provisioningAbsent,
      findByRequest: provisioningAbsent,
      create: provisioningUnavailable,
      beginEffect: provisioningUnavailable,
      checkpoint: provisioningUnavailable,
      recordFailure: provisioningUnavailable,
      settleEffect: provisioningUnavailable,
      cancel: provisioningUnavailable,
      cancelByAgent: async () => undefined,
      retryByWorkId: provisioningUnavailable,
      releaseConfiguration: async () => false,
    },
    audit: {
      async append(event) {
        if (event.installationId !== snapshot.installation?.id) {
          throw new ScopeViolationError("The audit event belongs to another Installation.");
        }
        if (event.resource.namespaceId !== event.namespaceId) {
          throw new ScopeViolationError("The audit event belongs to another Namespace.");
        }
        snapshot.audit.push(immutableCopy(event));
      },
      list: async () => Object.freeze(snapshot.audit.map((event) => immutableCopy(event))),
    },
    operations: {
      append: async (operation) => {
        assertInitialized(snapshot);
        if (
          operation.kind !== "namespace" &&
          operation.kind !== "agent_revision" &&
          operation.kind !== "agent"
        ) {
          throw new ScopeViolationError("The platform operation has an unsupported resource kind.");
        }
        if (
          operation.kind === "namespace" &&
          (operation.namespaceId !== operation.resourceId ||
            (operation.target !== "ready" && operation.target !== "deleted"))
        ) {
          throw new ScopeViolationError(
            "Namespace work does not match its exact lifecycle target.",
          );
        }
        // Agent-wide work names the Agent itself, never its owning Namespace.
        // Mirrors the owner resolution and controller_work_agent_owner foreign
        // key the database applies to the same operation.
        if (operation.kind === "agent") {
          if (operation.namespaceId === operation.resourceId) {
            throw new ScopeViolationError("Agent work must name its exact Agent.");
          }
          const owner = snapshot.agents.get(agentKey(operation.namespaceId, operation.resourceId));
          if (owner === undefined || owner.namespaceId !== operation.namespaceId) {
            throw new ScopeViolationError("Agent work does not match its exact owner.");
          }
          if (operation.target !== "stopped" && operation.target !== "deleted") {
            throw new ScopeViolationError("Agent work does not match its exact lifecycle target.");
          }
          if (operation.target === "stopped" && !isNonEmptyString(operation.operationId)) {
            throw new ScopeViolationError("Agent stop work requires its exact operation identity.");
          }
        }
        const duplicate = snapshot.operations.find(
          (existing) =>
            existing.kind === operation.kind &&
            existing.resourceId === operation.resourceId &&
            existing.action === operation.action &&
            (existing.kind !== "namespace" ||
              (operation.kind === "namespace" && existing.target === operation.target)) &&
            (existing.kind !== "agent_revision" ||
              (operation.kind === "agent_revision" &&
                existing.target === operation.target &&
                (existing.target === undefined ||
                  (operation.target === CREDENTIAL_WITHDRAWAL_TARGET &&
                    existing.operationId === operation.operationId)))) &&
            (existing.kind !== "agent" ||
              (operation.kind === "agent" &&
                existing.target === operation.target &&
                (existing.target === "deleted" ||
                  (operation.target === "stopped" &&
                    existing.operationId === operation.operationId)))),
        );
        if (duplicate !== undefined) {
          if (
            duplicate.actorId !== operation.actorId ||
            duplicate.namespaceId !== operation.namespaceId
          ) {
            throw new ResourceConflictError(
              "The platform operation already belongs to another owner or actor.",
            );
          }
          return;
        }
        snapshot.operations.push(immutableCopy(operation));
      },
      list: async () =>
        Object.freeze(snapshot.operations.map((operation) => immutableCopy(operation))),
      // The in-memory operation log has no executing or terminal work records.
      retryFailedAgentDeletion: async () => false,
      retryFailedNamespaceDeletion: async () => false,
      findWorkAttempt: async () => undefined,
      // Recorded work never executes here, so every recorded withdrawal stays outstanding.
      hasOutstandingCredentialWithdrawalWork: async (namespaceId, revisionId) =>
        snapshot.operations.some(
          (operation) =>
            operation.kind === "agent_revision" &&
            operation.target === CREDENTIAL_WITHDRAWAL_TARGET &&
            operation.namespaceId === namespaceId &&
            operation.resourceId === revisionId,
        ),
      findWork: async (idempotencyKey) => {
        const operation = snapshot.operations.find(
          (candidate) => operationIdempotencyKey(candidate) === idempotencyKey,
        );
        if (operation === undefined) {
          return undefined;
        }
        const now = new Date(0);
        const revisionOwner =
          operation.kind === "agent_revision"
            ? Array.from(snapshot.revisions.values())
                .flat()
                .find(
                  (revision) =>
                    revision.namespaceId === operation.namespaceId &&
                    revision.id === operation.resourceId,
                )?.agentId
            : undefined;
        return immutableCopy({
          kind: "lifecycle",
          idempotencyKey,
          namespaceId: operation.namespaceId,
          ...(operation.kind === "agent" ? { agentId: operation.resourceId } : {}),
          ...(operation.kind === "agent_revision"
            ? {
                ...(revisionOwner === undefined ? {} : { agentId: revisionOwner }),
                revisionId: operation.resourceId,
              }
            : {}),
          actorId: operation.actorId,
          ...(operation.kind === "namespace" ? { namespaceTarget: operation.target } : {}),
          ...(operation.kind === "agent" ? { agentTarget: operation.target } : {}),
          ...(operation.kind === "agent_revision" && operation.target !== undefined
            ? { agentTarget: operation.target }
            : {}),
          state: "queued",
          availableAt: now,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      },
    },
  };
}

/**
 * The memory counterpart of `occ.finalize_agent_deletion` (migrations/0035), applied to the
 * records this adapter keeps. Returns false unless the Agent's deletion was admitted: it is
 * `deleting`, stopped, and its `deleted` lifecycle work is recorded.
 */
function finalizeAgentDeletion(
  snapshot: PlatformSnapshot,
  namespaceId: string,
  agentId: string,
): boolean {
  const work = snapshot.operations.find(
    (operation) =>
      operation.kind === "agent" &&
      operation.target === "deleted" &&
      operation.namespaceId === namespaceId &&
      operation.resourceId === agentId,
  );
  const key = agentKey(namespaceId, agentId);
  const agent = snapshot.agents.get(key);
  if (
    work === undefined ||
    snapshot.namespaces.get(namespaceId) === undefined ||
    agent === undefined ||
    agent.status !== "deleting" ||
    agent.desiredRuntimeState !== "stopped"
  ) {
    return false;
  }
  const installation = snapshot.installation;
  if (installation === undefined) {
    throw new ScopeViolationError("The server-owned Installation has not been initialized.");
  }
  const revisionIds = new Set((snapshot.revisions.get(key) ?? []).map((revision) => revision.id));

  // Attempts outlive their revision as evidence (migrations/0035): completion detaches every
  // attempt's live revision without waiting for repository cleanup, whatever its phase.
  for (const [admissionId, attempt] of snapshot.repositorySessions) {
    if (
      attempt.namespaceId === namespaceId &&
      attempt.agentId === agentId &&
      attempt.liveRevisionId !== null
    ) {
      snapshot.repositorySessions.set(
        admissionId,
        immutableCopy({ ...attempt, liveRevisionId: null }),
      );
    }
  }

  // The finalizer's three AccessBinding groups: the Agent's ServicePrincipal as subject, the
  // Agent as target, and the Agent's AgentRevisions as target. Like the SQL, the first two are
  // not Namespace-scoped. Restrictions live in the IAM driver's seed here, not in this state.
  for (const [bindingKey, binding] of snapshot.bindings) {
    if (
      (binding.subjectKind === "identity" && binding.subjectId === agent.servicePrincipalId) ||
      (binding.resourceKind === "agent" && binding.resourceId === agentId) ||
      (binding.resourceKind === "agent_revision" &&
        binding.resourceId !== undefined &&
        revisionIds.has(binding.resourceId))
    ) {
      snapshot.bindings.delete(bindingKey);
    }
  }

  // The setup cascades with its Agent. Credential withdrawals already end with their revision
  // here (liveWithdrawal), as the database cascade does.
  snapshot.workspaceSetups.delete(key);
  snapshot.revisions.delete(key);
  snapshot.agents.delete(key);

  snapshot.audit.push(
    immutableCopy({
      id: `aud_${crypto.randomUUID()}`,
      installationId: installation.id,
      namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation" as const,
      actorId: work.actorId,
      source: "occ" as const,
      action: "openclaw.agents.lifecycle.delete",
      resource: { kind: "agent" as const, id: agentId, namespaceId },
      outcome: "success" as const,
      // Memory work is never claimed or retried, so its completion is the first attempt.
      details: { reasonCode: "AGENT_DELETED", attemptCount: 1 },
    }),
  );

  // The Agent's own lifecycle work and its revisions' work end with it.
  const remaining = snapshot.operations.filter(
    (operation) =>
      operation.namespaceId !== namespaceId ||
      !(
        (operation.kind === "agent" && operation.resourceId === agentId) ||
        (operation.kind === "agent_revision" && revisionIds.has(operation.resourceId))
      ),
  );
  snapshot.operations.splice(0, snapshot.operations.length, ...remaining);
  return true;
}

/** Process-local, single-writer state. No restart or multi-process durability. */
export class InMemoryPlatformState implements PlatformStateStore {
  private snapshot: PlatformSnapshot = {
    installation: undefined,
    namespaces: new Map(),
    configurations: new Map(),
    presets: new Map(),
    secrets: new Map(),
    credentialSources: new Map(),
    credentialWithdrawals: new Map(),
    serviceAccounts: new Map(),
    agents: new Map(),
    workspaceSetups: new Map(),
    revisions: new Map(),
    roles: new Map(),
    bindings: new Map(),
    servicePrincipals: new Map(),
    repositorySessions: new Map(),
    repositoryBrokerReceipts: new Map(),
    audit: [],
    operations: [],
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly auditSink: PlatformAuditSink | undefined;
  private readonly iamSubjects: IAMSubjectSource;

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
    this.iamSubjects = {
      identities: immutableCopy(options.iamIdentities ?? []),
      resolve: options.resolveIAMIdentity,
    };
  }

  pendingOperations(): readonly Readonly<PlatformOperation>[] {
    return Object.freeze(this.snapshot.operations.map((operation) => immutableCopy(operation)));
  }

  async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    await this.pending;
    const lifetime = new RepositoryTransactionLifetime();
    try {
      return await work(
        createPlatformReadView(
          repositories(cloneSnapshot(this.snapshot), this.iamSubjects),
          lifetime,
        ),
      );
    } finally {
      await lifetime.finish();
    }
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.commit((working, lifetime) =>
      work(bindPlatformUnitOfWork(repositories(working, this.iamSubjects), lifetime)),
    );
  }

  /**
   * Completes an admitted Agent deletion the way the PostgreSQL worker's finalizer does
   * (`PostgresWorkQueue.completeAgentDeletion`). Memory records lifecycle work but never
   * executes it, so dev and test callers complete it here. Removes the Agent, its
   * AgentRevisions and every AccessBinding the deletion audit listed, and records the
   * `openclaw.agents.lifecycle.delete` success. Returns false when no deletion was admitted.
   */
  async completeAgentDeletion(namespaceId: string, agentId: string): Promise<boolean> {
    return this.commit(async (working) => finalizeAgentDeletion(working, namespaceId, agentId));
  }

  private async commit<T>(
    work: (working: PlatformSnapshot, lifetime: RepositoryTransactionLifetime) => Promise<T>,
  ): Promise<T> {
    const previous = this.pending;
    let release: (() => void) | undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifetime = new RepositoryTransactionLifetime();
    try {
      await previous;
      const working = cloneSnapshot(this.snapshot);
      const committedAuditCount = working.audit.length;
      const result = await work(working, lifetime);
      await lifetime.finish();
      await this.publishAudit(working.audit.slice(committedAuditCount));
      this.snapshot = working;
      return result;
    } finally {
      await lifetime.finish();
      release?.();
    }
  }

  private async publishAudit(events: readonly Readonly<AuditEvent>[]): Promise<void> {
    if (!this.auditSink || events.length === 0) {
      return;
    }

    if (typeof this.auditSink.beginTransaction === "function") {
      let transaction: TransactionalAuditWriter | undefined;
      try {
        transaction = this.auditSink.beginTransaction();
        for (const event of events) {
          await transaction.append(event);
        }
        await transaction.commit();
      } catch {
        try {
          await transaction?.rollback();
        } catch {
          // The platform state still remains unpublished when rollback fails.
        }
        throw new DependencyUnavailableError("The platform audit repository is unavailable.");
      }
      return;
    }

    let checkpoint: number | undefined;
    try {
      checkpoint = this.auditSink.checkpoint?.();
      for (const event of events) {
        await this.auditSink.append(event);
      }
    } catch {
      try {
        if (checkpoint !== undefined) {
          this.auditSink.restore?.(checkpoint);
        }
      } catch {
        // An external sink failure still cannot publish the platform snapshot.
      }
      throw new DependencyUnavailableError("The platform audit repository is unavailable.");
    }
  }
}
