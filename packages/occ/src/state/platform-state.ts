import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import type {
  RepositorySessionAttempt,
  RepositorySessionReadRepository,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";
import { memoryRepositorySessions } from "./memory-repository-sessions.ts";
import {
  normalizedRepositoryBindings,
  validRepositoryRevisionState,
} from "./repository-credential-state.ts";
import type {
  AccessBinding,
  Agent,
  WorkspaceSetup,
  AgentDesiredRuntimeState,
  AgentStatus,
  AgentRevision,
  AuditEvent,
  HarnessExecutionMode,
  HarnessAuthBinding,
  HarnessAuthSnapshot,
  Installation,
  Namespace,
  NamespaceStatus,
  PluginDesiredState,
  Preset,
  RepositoryBindingSelection,
  Secret,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
  Role,
} from "@openclaw-enterprise/contracts";
import {
  normalizeInitialWorkspaceFiles,
  normalizeWorkspaceDefaultsId,
  normalizePluginDesiredState,
  normalizeHarnessAuthBinding,
  harnessAuthBindingFromSnapshot,
  normalizeSecretBindings,
  validPluginRevisionState,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import type { ControllerWork } from "./controller-work.ts";
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
  hasPresets(namespaceId: string): Promise<boolean>;
  hasServiceAccounts(namespaceId: string): Promise<boolean>;
  hasSecrets(namespaceId: string): Promise<boolean>;
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
    providerId?: string | null,
    plugins?: PluginDesiredState,
    repositoryBindings?: readonly RepositoryBindingSelection[],
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

export interface SecretReadRepository {
  findSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  listSecrets(namespaceId: string): Promise<readonly Readonly<Secret>[]>;
}

export interface SecretRepository extends SecretReadRepository {
  lockSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  createSecret(secret: Secret): Promise<Readonly<Secret>>;
  deleteSecret(namespaceId: string, secretId: string): Promise<boolean>;
  hasReferences(namespaceId: string, secretId: string): Promise<boolean>;
}

export interface ServiceAccountReadRepository {
  findServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  listServiceAccounts(namespaceId: string): Promise<readonly Readonly<ServiceAccount>[]>;
  findServiceAccountProviderBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly providerId: string;
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
const providerIdentifier = /^(?!\s)(?!.*\s$)(?!.*[\x00-\x1f\x7f]).{1,200}$/;

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

export function validHarnessAuthSnapshot(value: HarnessAuthSnapshot, namespaceId: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    if (value.method === "runtime") {
      return normalizeHarnessAuthBinding(value) !== null;
    }
    const binding =
      value.method === "api_key"
        ? normalizeHarnessAuthBinding({ method: value.method, source: value.source })
        : normalizeHarnessAuthBinding({
            method: value.method,
            serviceAccountId: value.serviceAccountId,
          });
    if (binding?.method === "api_key") {
      return (
        Object.keys(value).length === 3 &&
        binding.source.namespaceId === namespaceId &&
        value.method === "api_key" &&
        isNonEmptyString(value.secretDriverId)
      );
    }
    if (
      value.method !== "chatgpt_service_account" ||
      Object.keys(value).length !== 4 ||
      !validCredential(value.credential) ||
      value.credential.kind !== "access_token"
    ) {
      return false;
    }
    const provider = value.providerBinding;
    return (
      provider !== null &&
      typeof provider === "object" &&
      !Array.isArray(provider) &&
      Object.keys(provider).length === 4 &&
      isNonEmptyString(provider.providerId) &&
      isNonEmptyString(provider.driverId) &&
      isNonEmptyString(provider.workspaceId) &&
      provider.credentialIssued === true
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
  return binding.method === "api_key" && snapshot.method === "api_key"
    ? binding.source.namespaceId === snapshot.source.namespaceId &&
        binding.source.id === snapshot.source.id
    : binding.method === "chatgpt_service_account" &&
        snapshot.method === "chatgpt_service_account" &&
        binding.serviceAccountId === snapshot.serviceAccountId;
}

function harnessSecretReference(
  binding: HarnessAuthBinding | undefined | null,
  namespaceId: string,
  secretId: string,
): boolean {
  return (
    binding?.method === "api_key" &&
    binding.source.namespaceId === namespaceId &&
    binding.source.id === secretId
  );
}

function harnessAccountReference(
  binding: HarnessAuthBinding | undefined | null,
  serviceAccountId: string,
): boolean {
  return (
    binding?.method === "chatgpt_service_account" && binding.serviceAccountId === serviceAccountId
  );
}

export async function assertHarnessAuthAvailable(
  state: Pick<PlatformReadView, "secrets" | "serviceAccounts">,
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
  if (binding.method === "api_key") {
    if (
      binding.source.namespaceId !== namespaceId ||
      (await state.secrets.findSecret(namespaceId, binding.source.id)) === undefined
    ) {
      throw new ScopeViolationError(
        "The Agent harness authentication references an unavailable Secret.",
      );
    }
  } else if (
    (await state.serviceAccounts.findServiceAccount(namespaceId, binding.serviceAccountId)) ===
    undefined
  ) {
    throw new ScopeViolationError(
      "The Agent harness authentication references an unavailable ServiceAccount.",
    );
  }
}

function assertAdmittedAgentRevision(revision: AgentRevision): void {
  if (
    (revision.providerId !== null &&
      (typeof revision.providerId !== "string" || !providerIdentifier.test(revision.providerId))) ||
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
    !validPluginRevisionState(revision.plugins) ||
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
}

export interface PlatformOperationRepository extends PlatformOperationReadRepository {
  append(operation: PlatformOperation): Promise<void>;
}

export type { AgentProvisioningRecord } from "./agent-provisioning.ts";

export interface IAMPolicyReadRepository {
  listRoles(namespaceId: string): Promise<readonly Readonly<Role>[]>;
  getRole(namespaceId: string, roleId: string): Promise<Readonly<Role> | undefined>;
  listAccessBindings(namespaceId: string): Promise<readonly Readonly<AccessBinding>[]>;
  getAccessBinding(
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
}

export interface IAMPolicyRepository extends IAMPolicyReadRepository {
  createRole(role: Role): Promise<Readonly<Role>>;
  deleteRole(namespaceId: string, roleId: string): Promise<boolean>;
  createAccessBinding(binding: AccessBinding): Promise<Readonly<AccessBinding>>;
  deleteAccessBinding(namespaceId: string, bindingId: string): Promise<boolean>;
}

export interface PlatformReadView {
  readonly installations: InstallationReadRepository;
  readonly namespaces: NamespaceReadRepository;
  readonly configurations: ConfigurationReadRepository;
  readonly presets: PresetReadRepository;
  readonly secrets: SecretReadRepository;
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
}

interface PlatformSnapshot {
  installation: Readonly<Installation> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly presets: Map<string, Readonly<Preset>>;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly agents: Map<string, Readonly<Agent>>;
  readonly workspaceSetups: Map<string, Readonly<WorkspaceSetup>>;
  readonly revisions: Map<string, readonly Readonly<AgentRevision>[]>;
  readonly roles: Map<string, Readonly<Role>>;
  readonly bindings: Map<string, Readonly<AccessBinding>>;
  readonly repositorySessions: Map<string, Readonly<RepositorySessionAttempt>>;
  readonly audit: Readonly<AuditEvent>[];
  readonly operations: Readonly<PlatformOperation>[];
}

function agentKey(namespaceId: string, agentId: string): string {
  return `${namespaceId}\u0000${agentId}`;
}

function operationIdempotencyKey(operation: Readonly<PlatformOperation>): string {
  if (operation.kind === "agent") {
    return `agent:${operation.resourceId}:${operation.action}:${operation.target}:${operation.operationId}`;
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
    serviceAccounts: new Map(
      Array.from(snapshot.serviceAccounts, ([key, account]) => [key, immutableCopy(account)]),
    ),
    agents: new Map(Array.from(snapshot.agents, ([key, agent]) => [key, immutableCopy(agent)])),
    workspaceSetups: new Map(
      Array.from(snapshot.workspaceSetups, ([key, setup]) => [key, immutableCopy(setup)]),
    ),
    revisions: new Map(
      Array.from(snapshot.revisions, ([key, revisions]) => [
        key,
        Object.freeze(revisions.map((revision) => immutableCopy(revision))),
      ]),
    ),
    roles: new Map(Array.from(snapshot.roles, ([key, role]) => [key, immutableCopy(role)])),
    bindings: new Map(
      Array.from(snapshot.bindings, ([key, binding]) => [key, immutableCopy(binding)]),
    ),
    repositorySessions: new Map(
      Array.from(snapshot.repositorySessions, ([key, attempt]) => [key, immutableCopy(attempt)]),
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
  secrets: SecretReadRepository,
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
    secret.name.length > 200 ||
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

function repositories(snapshot: PlatformSnapshot): PlatformUnitOfWork {
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
      if (
        Array.from(snapshot.namespaces.values()).some(
          (existing) => existing.name === namespace.name,
        )
      ) {
        throw new ResourceConflictError(
          "A Namespace with this name already exists in the Installation.",
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
    hasPresets: async (namespaceId) =>
      Array.from(snapshot.presets.values()).some((preset) => preset.namespaceId === namespaceId),
    hasServiceAccounts: async (namespaceId) =>
      Array.from(snapshot.serviceAccounts.values()).some(
        (account) => account.namespaceId === namespaceId,
      ),
    hasSecrets: async (namespaceId) =>
      Array.from(snapshot.secrets.values()).some((secret) => secret.namespaceId === namespaceId),
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
        Array.from(snapshot.secrets.values()).some((secret) => secret.namespaceId === namespaceId)
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
      if (
        Array.from(snapshot.presets.values()).some(
          (existing) =>
            existing.id === preset.id ||
            (existing.namespaceId === preset.namespaceId && existing.name === preset.name),
        )
      ) {
        throw new ResourceConflictError("The Preset identity or Namespace name already exists.");
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
        throw new ResourceConflictError("The Preset name already exists in this Namespace.");
      }
      snapshot.presets.set(agentKey(namespaceId, presetId), saved);
      return immutableCopy(saved);
    },
    deletePreset: async (namespaceId, presetId) => {
      if ((await findPreset(namespaceId, presetId)) === undefined) {
        return false;
      }
      return snapshot.presets.delete(agentKey(namespaceId, presetId));
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
          listSecrets: async (namespaceId) =>
            Object.freeze(
              Array.from(snapshot.secrets.values())
                .filter((secret) => secret.namespaceId === namespaceId)
                .map((secret) => immutableCopy(secret)),
            ),
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
        throw new ResourceConflictError("A Secret with this name already exists in the Namespace.");
      }
      const saved = immutableCopy(secret);
      snapshot.secrets.set(key, saved);
      return immutableCopy(saved);
    },
    hasReferences: async (namespaceId, secretId) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) {
        return false;
      }
      return (
        Array.from(snapshot.configurations.values()).some(
          (configuration) =>
            configuration.namespaceId === namespaceId &&
            secretBindingsReference(configuration.secretBindings, namespaceId, secretId),
        ) ||
        Array.from(snapshot.agents.values()).some((agent) => {
          const activeRevision = (
            snapshot.revisions.get(agentKey(namespaceId, agent.id)) ?? []
          ).find((revision) => revision.id === agent.activeRevisionId);
          return (
            agent.namespaceId === namespaceId &&
            (harnessSecretReference(agent.harnessAuth, namespaceId, secretId) ||
              harnessSecretReference(activeRevision?.harnessAuth, namespaceId, secretId) ||
              secretBindingsReference(activeRevision?.secretBindings, namespaceId, secretId))
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
            secretBindingsReference(revision?.secretBindings, namespaceId, secretId) ||
            harnessSecretReference(revision?.harnessAuth, namespaceId, secretId)
          );
        })
      );
    },
    deleteSecret: async (namespaceId, secretId) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) {
        return false;
      }
      if (await secrets.hasReferences(namespaceId, secretId)) {
        throw new ScopeViolationError("The Secret is referenced by active platform state.");
      }
      snapshot.secrets.delete(agentKey(namespaceId, secretId));
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
    findServiceAccountProviderBinding: async () => undefined,
    createServiceAccount: async (account) => {
      assertInitialized(snapshot);
      if (
        !serviceAccountIdentifier.test(account.id) ||
        typeof account.name !== "string" ||
        account.name.length < 1 ||
        account.name.length > 200 ||
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
        Array.from(snapshot.serviceAccounts.values()).some(
          (existing) =>
            existing.id === account.id ||
            (existing.namespaceId === account.namespaceId && existing.name === account.name),
        )
      ) {
        throw new ResourceConflictError(
          "A ServiceAccount with this identity or name already exists.",
        );
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
      if (
        agent.providerId !== null &&
        (typeof agent.providerId !== "string" || !providerIdentifier.test(agent.providerId))
      ) {
        throw new ScopeViolationError("The Agent Provider identity is invalid.");
      }
      const plugins = normalizedPlugins(agent.plugins);
      const repositoryBindings = normalizedRepositoryBindings(agent.repositoryBindings);
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
        { secrets, serviceAccounts },
        agent.namespaceId,
        agent.harnessAuth,
      );
      const key = agentKey(agent.namespaceId, agent.id);
      if (snapshot.agents.has(key)) {
        throw new ResourceConflictError("The server generated an existing Agent identity.");
      }
      if (
        Array.from(snapshot.agents.values()).some(
          (existing) => existing.namespaceId === agent.namespaceId && existing.name === agent.name,
        )
      ) {
        throw new ResourceConflictError("An Agent with this name already exists in the Namespace.");
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
        repositoryBindings: _providedRepositoryBindings,
        ...withoutPlugins
      } = agent;
      const saved = immutableCopy({
        ...withoutPlugins,
        ...(plugins === undefined ? {} : { plugins }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
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
      providerId,
      nextPlugins,
      nextRepositoryBindings,
    ) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current) {
        return undefined;
      }
      if (providerId !== undefined && providerId !== null && !providerIdentifier.test(providerId)) {
        throw new ScopeViolationError("The Agent Provider identity is invalid.");
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
      await assertHarnessAuthAvailable({ secrets, serviceAccounts }, namespaceId, association);
      const nextProviderId = providerId === undefined ? current.providerId : providerId;
      const plugins = nextPlugins === undefined ? current.plugins : normalizedPlugins(nextPlugins);
      const repositoryBindings =
        nextRepositoryBindings === undefined
          ? current.repositoryBindings
          : normalizedRepositoryBindings(nextRepositoryBindings);
      const {
        plugins: _currentPlugins,
        repositoryBindings: _currentRepositoryBindings,
        ...withoutPlugins
      } = current;
      const updated = immutableCopy({
        ...withoutPlugins,
        configurationId,
        providerId: nextProviderId,
        executionMode: executionMode ?? current.executionMode,
        harnessAuth: association,
        ...(plugins === undefined ? {} : { plugins }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
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
        owner.providerId !== revision.providerId ||
        !harnessAuthMatches(owner.harnessAuth, revision.harnessAuth)
      ) {
        throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
      }
      await assertHarnessAuthAvailable(
        { secrets, serviceAccounts },
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

  const agentRevisionExists = (namespaceId: string, revisionId: string): boolean =>
    Array.from(snapshot.revisions.values())
      .flat()
      .some((revision) => revision.namespaceId === namespaceId && revision.id === revisionId);

  const managedPolicyResourceExists = async (
    namespaceId: string,
    resourceKind: NonNullable<AccessBinding["resourceKind"]>,
    resourceId: string,
  ): Promise<boolean> => {
    if (resourceKind === "agent") {
      return (await agents.findAgent(namespaceId, resourceId)) !== undefined;
    }
    if (resourceKind === "agent_revision") {
      return agentRevisionExists(namespaceId, resourceId);
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
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined,
    );

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
        throw new ResourceConflictError("The IAM Role is referenced by an AccessBinding.");
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
        throw new ScopeViolationError("The IAM AccessBinding references an unavailable Role.");
      }
      if (
        binding.subjectKind !== "identity" ||
        !namespaceServicePrincipalExists(namespace.id, binding.subjectId)
      ) {
        throw new ScopeViolationError(
          "The IAM AccessBinding subject does not belong to the exact Namespace.",
        );
      }
      if (
        binding.resourceKind === undefined ||
        binding.resourceId === undefined ||
        !(await managedPolicyResourceExists(namespace.id, binding.resourceKind, binding.resourceId))
      ) {
        throw new ScopeViolationError(
          "The IAM AccessBinding target does not belong to the exact Namespace.",
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
  };

  const repositorySessions = memoryRepositorySessions(
    snapshot.repositorySessions,
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
    serviceAccounts,
    agents,
    workspaceSetups,
    revisions,
    iamPolicy,
    repositorySessions,
    provisioning: {
      findByWorkId: provisioningAbsent,
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

/** Process-local, single-writer state. No restart or multi-process durability. */
export class InMemoryPlatformState implements PlatformStateStore {
  private snapshot: PlatformSnapshot = {
    installation: undefined,
    namespaces: new Map(),
    configurations: new Map(),
    presets: new Map(),
    secrets: new Map(),
    serviceAccounts: new Map(),
    agents: new Map(),
    workspaceSetups: new Map(),
    revisions: new Map(),
    roles: new Map(),
    bindings: new Map(),
    repositorySessions: new Map(),
    audit: [],
    operations: [],
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly auditSink: PlatformAuditSink | undefined;

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
  }

  pendingOperations(): readonly Readonly<PlatformOperation>[] {
    return Object.freeze(this.snapshot.operations.map((operation) => immutableCopy(operation)));
  }

  async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    await this.pending;
    const lifetime = new RepositoryTransactionLifetime();
    try {
      return await work(
        createPlatformReadView(repositories(cloneSnapshot(this.snapshot)), lifetime),
      );
    } finally {
      await lifetime.finish();
    }
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
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
      const result = await work(bindPlatformUnitOfWork(repositories(working), lifetime));
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
