import type {
  WorkspaceSetupRepository,
  SandboxPolicyRepository,
  AgentRepository,
  AgentRevisionRepository,
} from "../ports/agents.ts";
import type {
  OAuthAuthenticationState,
  AuthenticationState,
  OAuthSourceRef,
  AuthenticationStateRepository,
} from "../ports/authentication-states.ts";
import type {
  ConfigurationOwnership,
  ConfigurationReadRepository,
  ConfigurationRepository,
} from "../ports/configurations.ts";
import type {
  ConnectionTemplateReadRepository,
  ConnectionTemplateRepository,
} from "../ports/connection-templates.ts";
import type {
  StoredCredentialWithdrawal,
  CredentialSourceReadRepository,
  CredentialSourceRepository,
} from "../ports/credential-sources.ts";
import type { InstallationRepository } from "../ports/installations.ts";
import type { PersistedNamespace, NamespaceRepository } from "../ports/namespaces.ts";
import type { PlatformOperation } from "../ports/platform-operations.ts";
import type { PlatformStateStore } from "../ports/platform-state-store.ts";
import type {
  ConnectionTokenCustody,
  SavedConnectionRepository,
} from "../ports/saved-connections.ts";
import type {
  SecretReferenceKind,
  SecretReferenceEntry,
  SecretReadRepository,
  SecretRepository,
} from "../ports/secrets.ts";
import type { ServiceAccountRepository } from "../ports/service-accounts.ts";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type { PresetReadRepository, PresetRepository } from "../ports/presets.ts";
import { cancelledDeviceAuthorization } from "../device-authorization.ts";
import { repositoryRemovalWorkKey } from "../repository-withdrawal.ts";
import type { PreparedTokenCurrentProof } from "@openclaw-enterprise/contracts";
import {
  isCanonicalRepositoryGrantList,
  assertExecutionAdmission,
  validateConnectionTemplateDestinations,
  MAX_AGENT_CREDENTIAL_SOURCES,
} from "@openclaw-enterprise/contracts";
import { memoryEgressSendReceipts } from "./egress-send-receipts.ts";
import type { StoredSendReceipt } from "../egress-send-receipts.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  ProtectedEgressSource,
  EgressInstallation,
  EgressMaterialEvidence,
} from "@openclaw-enterprise/contracts";
import type { PredecessorReplacement } from "../ports/agent-reads.ts";
import type { StoredOAuthClient } from "../ports/oauth-client.ts";
import type { TokenServiceInstance } from "../ports/token-service.ts";
import type { CredentialPolicyReductionState } from "../ports/credential-policy-reduction.ts";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import type { SandboxPolicy } from "@openclaw-enterprise/contracts";
import type {
  RepositorySessionAttempt,
  RepositoryBrokerReceipt,
  RepositoryStandingApproval,
} from "../ports/repository-sessions.ts";
import { memoryRepositorySessions } from "./memory-repository-sessions.ts";
import {
  normalizedRepositoryBindings,
  normalizedRepositoryAccess,
  validRepositoryRevisionState,
} from "../repository-credential-validation.ts";
import type {
  ConnectionTemplate,
  OAuthConnectionTemplateVersion,
  SavedConnection,
  AccessBinding,
  Agent,
  WorkspaceSetup,
  AgentRevision,
  AuditEvent,
  CredentialSource,
  CredentialSourceSnapshot,
  CredentialWithdrawal,
  SecretReference,
  HarnessAuthBinding,
  AgentCredentialSourceBinding,
  HarnessAuthSnapshot,
  Identity,
  Installation,
  PluginDesiredState,
  PluginDriverIdentity,
  PluginApprovers,
  Preset,
  Secret,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
  Role,
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
  validPluginDriverIdentity,
  validPluginApprovers,
  isBackendId,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AGENT_NAME_CONFLICT,
  CREDENTIAL_SOURCE_NAME_CONFLICT,
  DELETED_NAMESPACE_NAME_CONFLICT,
  DependencyUnavailableError,
  EGRESS_REVISION_INSTALLED_CONFLICT,
  EGRESS_SANDBOX_INSTALLED_CONFLICT,
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
import { CREDENTIAL_WITHDRAWAL_TARGET, credentialWithdrawalWorkKey } from "../controller-work.ts";
import type { ControllerWork } from "../controller-work.ts";

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

function assertPluginDriverSelection(
  driver: PluginDriverIdentity | undefined,
  plugins: PluginDesiredState | undefined,
): void {
  const hasPlugins = Object.keys(plugins ?? {}).length > 0;
  if (hasPlugins ? !validPluginDriverIdentity(driver) : driver !== undefined) {
    throw new ScopeViolationError("Only a nonempty plugin selection has a Plugin Driver owner.");
  }
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
        (value.loginMode === "api_key" ||
          value.loginMode === "codex_pat" ||
          value.loginMode === "chatgptAuthTokens")
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

/** Validate new snapshots against rows held by the insertion transaction, never archive reads. */
export async function assertRevisionAuthAvailable(
  state: Pick<PlatformReadView, "secrets" | "serviceAccounts" | "credentialSources">,
  revision: AgentRevision,
  loadSources: (
    ids: readonly string[],
  ) => Promise<
    readonly Pick<
      CredentialSource,
      "id" | "namespaceId" | "type" | "state" | "ownerCapability" | "driverId"
    >[]
  >,
): Promise<void> {
  const snapshots: CredentialSourceSnapshot[] = [...(revision.credentialSources ?? [])];
  if (revision.harnessAuth?.method === "credential_source") {
    snapshots.push(revision.harnessAuth);
  } else {
    await assertHarnessAuthAvailable(
      state,
      revision.namespaceId,
      harnessAuthBindingFromSnapshot(revision.harnessAuth),
    );
  }
  if (snapshots.length === 0) {
    return;
  }
  const sources = new Map(
    (await loadSources([...new Set(snapshots.map(({ sourceId }) => sourceId))])).map((source) => [
      source.id,
      source,
    ]),
  );
  // Deduplicate locks, not assertions: the Harness and list can disagree on the same ID.
  for (const snapshot of snapshots) {
    const source = sources.get(snapshot.sourceId);
    if (
      source === undefined ||
      source.namespaceId !== revision.namespaceId ||
      source.state !== "ready"
    ) {
      throw new ScopeViolationError(
        "The AgentRevision references an unavailable credential source.",
      );
    }
    const ownerMatches =
      (source.ownerCapability === "credential_gateway" &&
        snapshot.credentialProxyId === undefined &&
        snapshot.credentialGatewayId === source.driverId) ||
      (source.ownerCapability === "credential_proxy" &&
        snapshot.credentialGatewayId === undefined &&
        snapshot.credentialProxyId === source.driverId);
    if (source.type !== snapshot.sourceType || !ownerMatches) {
      throw new ScopeViolationError(
        "The AgentRevision credential source snapshot does not match its current owner or type.",
      );
    }
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
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_CREDENTIAL_SOURCES) {
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
      ["credentialGatewayId,sourceId,sourceType", "credentialProxyId,sourceId,sourceType"].includes(
        keys.join(","),
      ) &&
      isNonEmptyString(snapshot.sourceId) &&
      isNonEmptyString(snapshot.credentialGatewayId ?? snapshot.credentialProxyId) &&
      isNonEmptyString(snapshot.sourceType) &&
      !seen.has(snapshot.sourceId);
    seen.add(snapshot.sourceId as string);
    return valid;
  });
}

function assertAdmittedAgentRevision(revision: AgentRevision): void {
  assertExecutionAdmission(revision);
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
    Object.keys(revision.harness).length !== 5 ||
    !Object.hasOwn(revision.harness, "id") ||
    !Object.hasOwn(revision.harness, "version") ||
    !Object.hasOwn(revision.harness, "mode") ||
    asRecord(revision.harness.overrides) === undefined ||
    asRecord(revision.harness.configuration) === undefined ||
    !isNonEmptyString(revision.harness.id) ||
    !isNonEmptyString(revision.harness.version) ||
    (revision.harness.mode !== "embedded" && revision.harness.mode !== "dedicated") ||
    typeof revision.compute !== "object" ||
    revision.compute === null ||
    Array.isArray(revision.compute) ||
    Object.keys(revision.compute).some(
      (key) => !["id", "implementation", "admission", "runtimeInputs"].includes(key),
    ) ||
    !Object.hasOwn(revision.compute, "id") ||
    !Object.hasOwn(revision.compute, "implementation") ||
    !isNonEmptyString(revision.compute.id) ||
    !isNonEmptyString(revision.compute.implementation) ||
    (revision.compute.admission !== undefined &&
      (typeof revision.compute.admission !== "string" ||
        !/^[\x20-\x7e]{1,1024}$/.test(revision.compute.admission))) ||
    (revision.compute.runtimeInputs !== undefined &&
      (typeof revision.compute.runtimeInputs !== "string" ||
        !/^[\x20-\x7e]{1,4096}$/.test(revision.compute.runtimeInputs))) ||
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
  readonly preparedTokenProof?: PreparedTokenCurrentProof;
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
  readonly egressSendReceipts: Map<string, StoredSendReceipt>;
  installation: Readonly<Installation> | undefined;
  tokenServiceInstance: Readonly<TokenServiceInstance> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly connectionTemplates: Map<string, Readonly<ConnectionTemplate>>;
  readonly clientRegistrations: Map<
    string,
    Readonly<StoredOAuthClient> & { cleanupAfter?: string }
  >;
  readonly oauthConnectionTemplateVersions: Map<string, Readonly<OAuthConnectionTemplateVersion>>;
  readonly connectionTokenCustody: Map<string, Readonly<ConnectionTokenCustody>>;
  readonly savedConnections: Map<string, Readonly<SavedConnection>>;
  readonly presets: Map<string, Readonly<Preset>>;
  readonly authenticationStates: Map<string, AuthenticationState>;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly credentialSources: Map<string, Readonly<CredentialSource>>;
  readonly credentialPolicyReductions: Map<string, CredentialPolicyReductionState>;
  readonly credentialWithdrawals: Map<string, Readonly<StoredCredentialWithdrawal>>;
  readonly egressInstallations: Map<string, Readonly<EgressInstallation>>;
  readonly retiredEgressInstallations: Set<string>;
  readonly egressRejected: Set<string>;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly agents: Map<string, Readonly<Agent>>;
  readonly predecessorReplacements: Map<string, Readonly<PredecessorReplacement>>;
  readonly sandboxPolicies: Map<string, Readonly<SandboxPolicy>>;
  readonly workspaceSetups: Map<string, Readonly<WorkspaceSetup>>;
  readonly revisions: Map<string, readonly Readonly<AgentRevision>[]>;
  readonly firstDeploymentDigests: Map<string, string>;
  readonly roles: Map<string, Readonly<Role>>;
  readonly bindings: Map<string, Readonly<AccessBinding>>;
  readonly servicePrincipals: Map<string, Readonly<ServicePrincipal>>;
  readonly repositoryStandingExecutions: Map<
    string,
    { executionId: string; fingerprint: string; closed: boolean }
  >;
  readonly repositoryStandingApprovals: Map<string, Readonly<RepositoryStandingApproval>>;
  readonly repositorySessions: Map<string, Readonly<RepositorySessionAttempt>>;
  readonly repositoryBrokerReceipts: Map<string, Readonly<RepositoryBrokerReceipt>>;
  readonly repositoryWithdrawals: Map<string, Readonly<ControllerWork>>;
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
    const key = `agent:${operation.resourceId}:${operation.action}:${operation.target}`;
    return operation.target === "deleted" ? key : `${key}:${operation.operationId}`;
  }
  if (operation.kind === "agent_revision" && operation.target === CREDENTIAL_WITHDRAWAL_TARGET) {
    return credentialWithdrawalWorkKey(operation.resourceId, operation.operationId);
  }
  return `${operation.kind}:${operation.resourceId}:${operation.action}${
    operation.kind === "namespace" ? `:${operation.target}` : ""
  }`;
}

function memoryLifecycleWork(
  idempotencyKey: string,
  operation: Readonly<PlatformOperation>,
  revisionOwner: string | undefined,
): Readonly<ControllerWork> {
  const now = new Date(0);
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
}

// Records that are plain data (objects, arrays, primitives) and frozen all the way down, so
// every later snapshot can share them instead of copying them again. A record holding a Map,
// Set, Date or other object that deepFreeze cannot freeze is copied on every snapshot, as before.
const sharedRecords = new WeakSet<object>();

// `seen` stops at a cycle (structuredClone keeps one), whose objects are checked once. With
// `frozen`, every object must also be frozen already.
function isPlainData(value: unknown, frozen = false, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return true;
  }
  seen.add(value);
  if (frozen && !Object.isFrozen(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (Array.isArray(value) || prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((entry) => isPlainData(entry, frozen, seen))
  );
}

// A snapshot's copy of one stored record. Before this, every read and every transaction
// structuredCloned the whole store, audit log included, so a long test's reads grew with
// everything it had written. A shared record is frozen, so sharing it keeps each snapshot
// isolated: transactions replace records, they cannot change one in place.
function storedCopy<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (sharedRecords.has(value)) {
    return value;
  }
  // A write stores its own `immutableCopy` (see `repositories`). Share that record as it is:
  // a read's snapshot is discarded, so a record copied only there was copied again by every
  // read until the next transaction (finding 2781: 0.5 s per request for 4 large Presets).
  if (isPlainData(value, true)) {
    sharedRecords.add(value);
    return value;
  }
  const copy = immutableCopy(value);
  if (isPlainData(copy)) {
    sharedRecords.add(copy);
  }
  return copy;
}

function copyStoredMap<K, V>(source: ReadonlyMap<K, V>): Map<K, Readonly<V>> {
  const copy = new Map<K, Readonly<V>>();
  for (const [key, value] of source) {
    copy.set(key, storedCopy(value));
  }
  return copy;
}

function cloneSnapshot(snapshot: PlatformSnapshot): PlatformSnapshot {
  return {
    installation:
      snapshot.installation === undefined ? undefined : storedCopy(snapshot.installation),
    tokenServiceInstance: snapshot.tokenServiceInstance,
    namespaces: copyStoredMap(snapshot.namespaces),
    configurations: copyStoredMap(snapshot.configurations),
    connectionTemplates: new Map(snapshot.connectionTemplates),
    clientRegistrations: new Map(snapshot.clientRegistrations),
    oauthConnectionTemplateVersions: new Map(snapshot.oauthConnectionTemplateVersions),
    connectionTokenCustody: new Map(snapshot.connectionTokenCustody),
    savedConnections: new Map(snapshot.savedConnections),
    presets: copyStoredMap(snapshot.presets),
    authenticationStates: new Map(snapshot.authenticationStates),
    secrets: copyStoredMap(snapshot.secrets),
    egressRejected: new Set(snapshot.egressRejected),
    egressSendReceipts: new Map(snapshot.egressSendReceipts),
    retiredEgressInstallations: new Set(snapshot.retiredEgressInstallations),
    egressInstallations: copyStoredMap(snapshot.egressInstallations),
    credentialPolicyReductions: new Map(snapshot.credentialPolicyReductions),
    credentialWithdrawals: copyStoredMap(snapshot.credentialWithdrawals),
    credentialSources: copyStoredMap(snapshot.credentialSources),
    serviceAccounts: copyStoredMap(snapshot.serviceAccounts),
    agents: copyStoredMap(snapshot.agents),
    predecessorReplacements: copyStoredMap(snapshot.predecessorReplacements),
    sandboxPolicies: copyStoredMap(snapshot.sandboxPolicies),
    workspaceSetups: copyStoredMap(snapshot.workspaceSetups),
    // Revisions are copied on ingress/egress; writes replace frozen history arrays.
    // A separate Map isolates this snapshot's future writes without copying history.
    revisions: new Map(snapshot.revisions),
    firstDeploymentDigests: new Map(snapshot.firstDeploymentDigests),
    roles: copyStoredMap(snapshot.roles),
    bindings: copyStoredMap(snapshot.bindings),
    servicePrincipals: new Map(snapshot.servicePrincipals),
    repositoryStandingExecutions: new Map(snapshot.repositoryStandingExecutions),
    repositoryStandingApprovals: new Map(snapshot.repositoryStandingApprovals),
    repositoryWithdrawals: new Map(snapshot.repositoryWithdrawals),
    repositorySessions: copyStoredMap(snapshot.repositorySessions),
    repositoryBrokerReceipts: copyStoredMap(snapshot.repositoryBrokerReceipts),
    audit: snapshot.audit.map((event) => storedCopy(event)),
    operations: snapshot.operations.map((operation) => storedCopy(operation)),
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

/**
 * An AccessBinding subject is a principal ID, which never holds "@". An email is the caller's own
 * input, so naming the mistake reveals nothing about which principals exist; an unknown ID keeps
 * the answer an ineligible one gets (finding D753).
 */
export function assertBindingSubjectNotEmail(subjectId: string): void {
  if (subjectId.includes("@")) {
    throw new IAMPolicyValidationError(
      "/subjectId",
      "The IAM AccessBinding subject is an email address, not a principal ID. Use the person's principalId (prn_…): creating their account returns it; see the IAM guide.",
    );
  }
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

function validEgressRef(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    Object.keys(value).length === 2 &&
    typeof value.id === "string" &&
    value.id.length >= 1 &&
    value.id.length <= 200 &&
    typeof value.generation === "number" &&
    /^[1-9][0-9]{0,14}$/.test(String(value.generation))
  );
}

/** Mirrors egress_source_is_valid; static and prepared sources each have a closed admitted shape. */
function assertProtectedEgressSource(
  value: ProtectedEgressSource,
  namespaceId: string,
  sourceId: string,
): void {
  const key = value?.key;
  const common =
    isPlainRecord(value) &&
    isPlainRecord(key) &&
    Object.keys(key).length === 5 &&
    /^ins_[0-9a-f-]{36}$/.test(key.installationId) &&
    key.namespaceId === namespaceId &&
    key.source?.id === sourceId &&
    [key.source, key.backend, key.provider, value.sender, value.resolver].every(validEgressRef);
  if (value.adoption === "credential_free") {
    const { grant } = value;
    if (
      !common ||
      key.provider.id !== "credential-free-repository-metadata" ||
      key.provider.generation !== 1 ||
      Object.keys(value).length !== 8 ||
      value.schemaVersion !== 3 ||
      value.retention !== "none" ||
      Object.keys(grant).length !== 5 ||
      grant.kind !== "credential_free_repository_metadata" ||
      grant.profile !== "metadata-read" ||
      !/^[1-9]\d*$/.test(grant.repositoryId) ||
      !Number.isSafeInteger(Number(grant.repositoryId)) ||
      !/^[a-zA-Z\d_-]+\/[a-zA-Z\d_.-]+$/.test(grant.repository) ||
      /\/(?:\.|\.)$/.test(grant.repository) ||
      !/^agt_[0-9a-f-]{36}$/.test(grant.isolationId) ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value.origin)
    ) {
      throw new ScopeViolationError("The credential-free metadata schema or scope is invalid.");
    }
    return;
  }
  if (value.adoption === "prepared") {
    const { grant } = value;
    if (grant.kind === "prepared_scope") {
      const scope = Object.entries(grant.scope ?? {});
      if (
        !common ||
        value.schemaVersion !== 4 ||
        key.provider.id === "github-app-metadata" ||
        value.retention !== "none" ||
        Object.keys(value).length !== 8 ||
        Object.keys(grant).length !== 3 ||
        !/^agt_[0-9a-f-]{36}$/.test(grant.isolationId) ||
        !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value.origin) ||
        !isPlainRecord(grant.scope) ||
        !scope.length ||
        scope.length > 16 ||
        scope.some(
          ([k, v]) =>
            !/^[a-z][a-z0-9_]{0,63}$/.test(k) ||
            typeof v !== "string" ||
            !v.length ||
            v.length > 1024,
        )
      ) {
        throw new ScopeViolationError("The prepared credential scope or source schema is invalid.");
      }
      return;
    }
    if (
      !common ||
      key.provider.id !== "github-app-metadata" ||
      key.provider.generation !== 1 ||
      Object.keys(value).length !== 8 ||
      value.schemaVersion !== 2 ||
      value.retention !== "none" ||
      Object.keys(grant).length !== 7 ||
      grant.kind !== "github_repository_metadata" ||
      grant.profile !== "metadata-read" ||
      ![grant.appId, grant.installationId, grant.repositoryId].every(
        (id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)),
      ) ||
      !/^[a-zA-Z\d_-]+\/[a-zA-Z\d_.-]+$/.test(grant.repository) ||
      !/^agt_[0-9a-f-]{36}$/.test(grant.isolationId) ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value.origin)
    ) {
      throw new ScopeViolationError(
        "The prepared GitHub metadata source schema or scope is invalid.",
      );
    }
    return;
  }
  const secret = value?.secret;
  if (
    !common ||
    Object.keys(value).length !== 9 ||
    value.schemaVersion !== 1 ||
    value.adoption !== "live" ||
    value.retention !== "none" ||
    typeof value.materialRefId !== "string" ||
    value.materialRefId.length < 1 ||
    value.materialRefId.length > 200 ||
    !validEgressRef(value.secretDriver) ||
    !isPlainRecord(secret) ||
    Object.keys(secret).length !== 3 ||
    secret.kind !== "secret" ||
    secret.namespaceId !== namespaceId ||
    !/^sec_[0-9a-f-]{36}$/.test(secret.id)
  ) {
    throw new ScopeViolationError("The protected source schema or scope is invalid.");
  }
}

function validTokenServiceRegistration(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    Object.keys(value).every((key) => key === "backendRef") &&
    (value.backendRef === undefined ||
      (isPlainRecord(value.backendRef) &&
        Object.values(value.backendRef).every((item) => typeof item === "string")))
  );
}

/** Mirrors the PostgreSQL credential source constraints for the in-memory adapter. */
function assertCredentialSource(source: CredentialSource): void {
  if (source.egress !== undefined) {
    assertProtectedEgressSource(source.egress, source.namespaceId, source.id);
  }
  const config: unknown = source.config;
  const secretInputs: unknown = source.secrets;
  const validOwner =
    source.ownerCapability === "token_service"
      ? source.egress === undefined &&
        source.driverId === undefined &&
        (source.tokenServiceInstanceId === undefined
          ? source.type === "oauth2-refresh-token" &&
            source.registration === undefined &&
            source.registrationDispatchedAt === undefined
          : source.type !== "oauth2-refresh-token" &&
            (source.registration === undefined ||
              validTokenServiceRegistration(source.registration)) &&
            (source.registrationDispatchedAt === undefined ||
              (Number.isFinite(Date.parse(source.registrationDispatchedAt)) &&
                Date.parse(source.registrationDispatchedAt) >= Date.parse(source.createdAt))) &&
            (source.state !== "registering" || source.registration === undefined) &&
            (source.state !== "ready" ||
              (source.registration !== undefined &&
                source.registrationDispatchedAt !== undefined)) &&
            Object.keys(source.secrets).length === 0)
      : (source.ownerCapability === "credential_gateway" ||
          (source.ownerCapability === "credential_proxy" && source.egress !== undefined)) &&
        typeof source.driverId === "string" &&
        source.driverId.length >= 1 &&
        source.driverId.length <= 200 &&
        source.driverId === source.driverId.trim();
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
    !validOwner ||
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

function namespaceResourceExists(
  resources: Iterable<{ readonly namespaceId: string }>,
  namespaceId: string,
): boolean {
  for (const resource of resources) {
    if (resource.namespaceId === namespaceId) {
      return true;
    }
  }
  return false;
}

// A write stores an `immutableCopy` and returns that same value: it is a deep-frozen clone of
// plain data, so the caller cannot change the stored state through it. That holds while the
// stored contract types carry no Date, Map, Set or typed array (see `immutableSnapshot` in
// @openclaw-enterprise/utils). Copying it again only doubled the cost of every write.
function repositories(
  snapshot: PlatformSnapshot,
  iamSubjects: IAMSubjectSource,
  preparedTokenProof: PreparedTokenCurrentProof,
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
      return saved;
    },
    selectTokenServiceInstance: async (candidate) => {
      assertInitialized(snapshot);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          candidate.id,
        ) ||
        !isNonEmptyString(candidate.driverId) ||
        candidate.driverId.length > 200 ||
        candidate.driverId !== candidate.driverId.trim() ||
        !isNonEmptyString(candidate.storeIdentity) ||
        candidate.storeIdentity.length > 200 ||
        candidate.storeIdentity !== candidate.storeIdentity.trim()
      ) {
        throw new ScopeViolationError("The TokenService instance identity is invalid.");
      }
      const current = snapshot.tokenServiceInstance;
      if (
        current?.driverId === candidate.driverId &&
        current.storeIdentity === candidate.storeIdentity
      ) {
        return current;
      }
      if (
        current &&
        (current.id === candidate.id ||
          Array.from(snapshot.credentialSources.values()).some(
            (source) =>
              source.ownerCapability === "token_service" &&
              source.tokenServiceInstanceId === current.id,
          ))
      ) {
        throw new ResourceStateConflictError("The TokenService instance still has registrations.");
      }
      const selected = immutableCopy(candidate);
      snapshot.tokenServiceInstance = selected;
      return selected;
    },
    // In-memory State has no human accounts, and its units are serialized.
    holdPrincipalAccount: async () => true,
    // Memory authentication owns its sessions outside platform State.
    holdAuthenticationSession: async () => false,
    // One in-process State applies each unit of work alone; there is nothing to serialize with.
    holdIAMConfiguration: async () => undefined,
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
      return saved;
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
      namespaceResourceExists(snapshot.agents.values(), namespaceId),
    hasConfigurations: async (namespaceId) =>
      namespaceResourceExists(snapshot.configurations.values(), namespaceId),
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
      namespaceResourceExists(snapshot.presets.values(), namespaceId),
    hasServiceAccounts: async (namespaceId) =>
      namespaceResourceExists(snapshot.serviceAccounts.values(), namespaceId),
    hasSecrets: async (namespaceId) =>
      namespaceResourceExists(snapshot.secrets.values(), namespaceId),
    hasCredentialSources: async (namespaceId) =>
      namespaceResourceExists(snapshot.credentialSources.values(), namespaceId),
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
      return saved;
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
        namespaceResourceExists(snapshot.agents.values(), namespaceId) ||
        namespaceResourceExists(snapshot.configurations.values(), namespaceId) ||
        namespaceResourceExists(snapshot.presets.values(), namespaceId) ||
        namespaceResourceExists(snapshot.serviceAccounts.values(), namespaceId) ||
        namespaceResourceExists(snapshot.secrets.values(), namespaceId) ||
        namespaceResourceExists(snapshot.credentialSources.values(), namespaceId)
      ) {
        throw new ScopeViolationError("A nonempty Namespace cannot be tombstoned.");
      }
      const deletedTime = new Date(deletedAt).getTime();
      const createdTime = new Date(namespace.createdAt).getTime();
      if (Number.isNaN(deletedTime) || Number.isNaN(createdTime) || deletedTime < createdTime) {
        throw new ScopeViolationError("The Namespace tombstone timestamp is invalid.");
      }
      for (const [id, state] of snapshot.authenticationStates) {
        if (state.namespaceId === namespaceId) {
          snapshot.authenticationStates.delete(id);
        }
      }
      const saved = immutableCopy({ ...namespace, deletedAt });
      snapshot.namespaces.set(key, saved);
      return saved;
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
  const versionKey = (templateId: string, version: number) => `${templateId}\u0000${version}`;
  const findConnectionTemplate: ConnectionTemplateReadRepository["findConnectionTemplate"] = async (
    templateId,
  ) => {
    const template = snapshot.connectionTemplates.get(templateId);
    return template === undefined ? undefined : immutableCopy(template);
  };
  const assertTemplateVersion = (
    template: ConnectionTemplate,
    version: OAuthConnectionTemplateVersion,
  ) => {
    validateConnectionTemplateDestinations(version);
    if (!version.oauthClientId) {
      return;
    }
    const registration = snapshot.clientRegistrations.get(version.oauthClientId);
    if (
      !registration ||
      registration.cleanupAfter !== undefined ||
      (registration.namespaceId !== undefined &&
        registration.namespaceId !== template.namespaceId) ||
      registration.issuer !== version.issuer ||
      registration.tokenUrl !== version.tokenUrl ||
      (version.revocationUrl !== undefined &&
        registration.revocationUrl !== version.revocationUrl) ||
      version.templateId !== template.id
    ) {
      throw new ResourceStateConflictError(
        "The OAuth client registration must match the template scope and client.",
      );
    }
  };
  const connectionTemplates: ConnectionTemplateRepository = {
    findConnectionTemplate,
    countNamespaceConnectionTemplates: async (namespaceId) =>
      Array.from(snapshot.connectionTemplates.values()).filter(
        (template) => template.namespaceId === namespaceId,
      ).length,
    hasOtherConnectionIssuer: async (issuer) =>
      [...snapshot.oauthConnectionTemplateVersions.values()].some(
        (version) => version.oauthClientId !== undefined && version.issuer !== issuer,
      ),
    listConnectionTemplates: async () =>
      Object.freeze(
        Array.from(snapshot.connectionTemplates.values())
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((template) => immutableCopy(template)),
      ),
    findOAuthConnectionTemplateVersion: async (templateId, version) => {
      const found = snapshot.oauthConnectionTemplateVersions.get(versionKey(templateId, version));
      return found === undefined ? undefined : immutableCopy(found);
    },
    listOAuthClients: async () =>
      Object.freeze(
        Array.from(snapshot.clientRegistrations.values())
          .filter((row) => row.cleanupAfter === undefined)
          .map((row) => immutableCopy(row))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    countNamespaceOAuthClients: async (namespaceId) =>
      Array.from(snapshot.clientRegistrations.values()).filter(
        (client) => client.namespaceId === namespaceId,
      ).length,
    findOAuthClient: async (id) => {
      const row = snapshot.clientRegistrations.get(id);
      return row?.cleanupAfter === undefined ? row : undefined;
    },
    lockOAuthClient: async (id) => connectionTemplates.findOAuthClient(id),
    listOAuthClientCleanups: async (limit) =>
      [...snapshot.clientRegistrations.values()]
        .filter((row) => row.cleanupAfter && Date.parse(row.cleanupAfter) <= Date.now())
        .sort((a, b) => a.cleanupAfter!.localeCompare(b.cleanupAfter!))
        .slice(0, limit)
        .map((row) => row.id),
    lockOAuthClientForCleanup: async (id, dueOnly) => {
      const row = snapshot.clientRegistrations.get(id);
      return row?.cleanupAfter && (!dueOnly || Date.parse(row.cleanupAfter) <= Date.now())
        ? row
        : undefined;
    },
    setOAuthClientCleanup: async (id, cleanupAfter) => {
      const row = snapshot.clientRegistrations.get(id);
      if (row) {
        const { cleanupAfter: _old, ...client } = row;
        snapshot.clientRegistrations.set(
          id,
          immutableCopy({ ...client, ...(cleanupAfter && { cleanupAfter }) }),
        );
      }
    },
    lockConnectionTemplate: findConnectionTemplate,
    createOAuthClient: async (registration, cleanupAfter) => {
      assertInitialized(snapshot);
      if (
        (registration.tokenEndpointAuthMethod === "none") !==
          (registration.secretDriverId === undefined) ||
        registration.secretDriverId === ""
      ) {
        throw new ResourceConflictError(
          "Only confidential OAuth clients have a private Secret Driver.",
        );
      }
      if (
        registration.namespaceId !== undefined &&
        !snapshot.namespaces.has(registration.namespaceId)
      ) {
        throw new ResourceStateConflictError("The client registration Namespace does not exist.");
      }
      // The issuer and client ID identify a registration within the template's scope.
      if (
        snapshot.clientRegistrations.has(registration.id) ||
        Array.from(snapshot.clientRegistrations.values()).some(
          (existing) =>
            existing.namespaceId === registration.namespaceId &&
            existing.issuer === registration.issuer &&
            existing.clientId === registration.clientId,
        )
      ) {
        throw new ResourceConflictError("The OAuth client is already registered.");
      }
      const saved = immutableCopy(registration);
      snapshot.clientRegistrations.set(
        saved.id,
        immutableCopy({ ...registration, ...(cleanupAfter && { cleanupAfter }) }),
      );
      return immutableCopy(saved);
    },
    deleteOAuthClient: async (registrationId, retainForCleanup) => {
      if (
        Array.from(snapshot.oauthConnectionTemplateVersions.values()).some(
          (version) => version.oauthClientId === registrationId,
        )
      ) {
        return false;
      }
      if (retainForCleanup) {
        await connectionTemplates.setOAuthClientCleanup(registrationId, new Date().toISOString());
        return snapshot.clientRegistrations.has(registrationId);
      }
      return snapshot.clientRegistrations.delete(registrationId);
    },
    createConnectionTemplate: async (template) => {
      assertInitialized(snapshot);
      if (snapshot.connectionTemplates.has(template.id)) {
        throw new ResourceConflictError(
          "The server generated an existing connection template identity.",
        );
      }
      assertTemplateVersion(template, template.current);
      const saved = immutableCopy(template);
      snapshot.connectionTemplates.set(saved.id, saved);
      snapshot.oauthConnectionTemplateVersions.set(
        versionKey(saved.id, saved.current.version),
        saved.current,
      );
      return immutableCopy(saved);
    },
    updateConnectionTemplate: async (templateId, changes) => {
      const current = snapshot.connectionTemplates.get(templateId);
      if (current === undefined) {
        return undefined;
      }
      if (changes.version !== undefined) {
        assertTemplateVersion(current, changes.version);
        // Mirrors the database: versions advance by one and never change.
        if (changes.version.version !== current.current.version + 1) {
          throw new ResourceStateConflictError("Connection template versions advance by one.");
        }
        snapshot.oauthConnectionTemplateVersions.set(
          versionKey(templateId, changes.version.version),
          immutableCopy(changes.version),
        );
      }
      const saved = immutableCopy({
        ...current,
        ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
        ...(changes.version === undefined ? {} : { current: changes.version }),
      });
      snapshot.connectionTemplates.set(templateId, saved);
      return immutableCopy(saved);
    },
    deleteConnectionTemplate: async (templateId) => {
      if (!snapshot.connectionTemplates.has(templateId)) {
        return false;
      }
      if (
        [...snapshot.savedConnections.values()].some(
          (connection) => connection.connectionTemplateId === templateId,
        ) ||
        [...snapshot.authenticationStates.values()].some(
          (state) => state.kind === "oauth_connection" && state.connectionTemplateId === templateId,
        )
      ) {
        throw new ResourceStateConflictError("The connection template is in use.");
      }
      snapshot.connectionTemplates.delete(templateId);
      for (const key of Array.from(snapshot.oauthConnectionTemplateVersions.keys())) {
        if (key.startsWith(`${templateId}\u0000`)) {
          snapshot.oauthConnectionTemplateVersions.delete(key);
        }
      }
      return true;
    },
  };

  const assertConnectionScope = (record: SavedConnection | OAuthAuthenticationState): void => {
    const { namespaceId, credentialSourceId, connectionTemplateId, connectionTemplateVersion } =
      record;
    const template = snapshot.connectionTemplates.get(connectionTemplateId);
    if (
      !snapshot.credentialSources.has(agentKey(namespaceId, credentialSourceId)) ||
      !template ||
      (template.namespaceId !== undefined && template.namespaceId !== namespaceId) ||
      !snapshot.oauthConnectionTemplateVersions.has(
        versionKey(connectionTemplateId, connectionTemplateVersion),
      )
    ) {
      throw new ResourceStateConflictError(
        "The connection must use a source and template in its scope.",
      );
    }
  };
  const savedConnections: SavedConnectionRepository = {
    findTokenCustody: async (namespaceId, sourceId) => {
      const custody = snapshot.connectionTokenCustody.get(agentKey(namespaceId, sourceId));
      return (
        custody &&
        immutableCopy({
          ...custody,
          due:
            custody.nextRefreshAt !== undefined && Date.parse(custody.nextRefreshAt) <= Date.now(),
        })
      );
    },
    createTokenCustody: async (custody) => {
      const key = agentKey(custody.namespaceId, custody.sourceId);
      if (snapshot.connectionTokenCustody.has(key)) {
        throw new Error("Connection token custody already exists.");
      }
      snapshot.connectionTokenCustody.set(key, storedCopy(custody));
    },
    recordTokenSchedule: async (namespaceId, sourceId, schedule) => {
      const key = agentKey(namespaceId, sourceId);
      const account = snapshot.savedConnections.get(key);
      if (account && typeof schedule === "object") {
        snapshot.savedConnections.set(
          key,
          storedCopy({ ...account, grantedScopes: schedule.grantedScopes }),
        );
      }
      const custody = snapshot.connectionTokenCustody.get(key);
      if (!custody) {
        throw new Error("Connection token custody is missing.");
      }
      const { nextRefreshAt: _previous, ...existing } = custody;
      let next: ConnectionTokenCustody = existing;
      if (schedule === "due") {
        next = { ...existing, nextRefreshAt: new Date().toISOString() };
      } else if (schedule !== "stopped") {
        next = { ...existing, ...schedule };
      }
      snapshot.connectionTokenCustody.set(key, storedCopy(next));
    },
    listDueConnectionTokens: async (installationId, limit, afterSourceId) => {
      if (snapshot.installation?.id !== installationId) {
        return [];
      }
      const now = new Date().toISOString();
      const due = [...snapshot.savedConnections.values()].filter((account) => {
        const next = snapshot.connectionTokenCustody.get(
          agentKey(account.namespaceId, account.credentialSourceId),
        )?.nextRefreshAt;
        return (
          !account.revocationRequestedBy &&
          next !== undefined &&
          next <= now &&
          account.credentialSourceId > (afterSourceId ?? "")
        );
      });
      return immutableCopy(
        due
          .sort((a, b) => a.credentialSourceId.localeCompare(b.credentialSourceId))
          .slice(0, limit),
      );
    },
    findSavedConnection: async (namespaceId, credentialSourceId) => {
      const found = snapshot.savedConnections.get(agentKey(namespaceId, credentialSourceId));
      return found === undefined ? undefined : immutableCopy(found);
    },
    listRevokingConnections: async (installationId, limit, afterSourceId) => {
      if (snapshot.installation?.id !== installationId) {
        return [];
      }
      return Object.freeze(
        Array.from(snapshot.savedConnections.values())
          .filter(
            (account) =>
              account.revocationRequestedBy !== undefined &&
              (afterSourceId === undefined || account.credentialSourceId > afterSourceId),
          )
          .sort((a, b) => a.credentialSourceId.localeCompare(b.credentialSourceId))
          .slice(0, limit)
          .map((account) => immutableCopy(account)),
      );
    },
    requestConnectionRevocation: async (namespaceId, sourceId, principalId) => {
      const key = agentKey(namespaceId, sourceId);
      const current = snapshot.savedConnections.get(key);
      if (current && current.revocationRequestedBy === undefined) {
        snapshot.savedConnections.set(
          key,
          storedCopy({ ...current, revocationRequestedBy: principalId }),
        );
      }
    },
    confirmConnectionRevocation: async (namespaceId, sourceId, at) => {
      const key = agentKey(namespaceId, sourceId);
      const current = snapshot.savedConnections.get(key);
      if (current?.revocationRequestedBy !== undefined && current.revokedAt === undefined) {
        snapshot.savedConnections.set(key, storedCopy({ ...current, revokedAt: at }));
      }
    },
    listNamespaceConnections: async (namespaceId) =>
      Object.freeze(
        Array.from(snapshot.savedConnections.values())
          .filter(
            (connection) =>
              connection.namespaceId === namespaceId &&
              connection.revocationRequestedBy === undefined,
          )
          .sort((a, b) => a.credentialSourceId.localeCompare(b.credentialSourceId))
          .map((connection) => immutableCopy(connection)),
      ),
    createSavedConnection: async (connection) => {
      assertInitialized(snapshot);
      assertConnectionScope(connection);
      const version = snapshot.oauthConnectionTemplateVersions.get(
        versionKey(connection.connectionTemplateId, connection.connectionTemplateVersion),
      );
      const client = snapshot.clientRegistrations.get(connection.oauthClientId);
      if (
        !version ||
        !isDeepStrictEqual(version.destinations, connection.destinations) ||
        version.issuer !== connection.issuer ||
        version.tokenUrl !== connection.tokenUrl ||
        version.oauthClientId !== connection.oauthClientId ||
        client?.clientId !== connection.clientId ||
        version.mcp?.serverUrl !== connection.mcpServerUrl ||
        version.mcp?.resource !== connection.resource
      ) {
        throw new ResourceStateConflictError(
          "The saved account must match its approved template version and OAuth client.",
        );
      }
      const key = agentKey(connection.namespaceId, connection.credentialSourceId);
      if (snapshot.savedConnections.has(key)) {
        throw new ResourceConflictError("The credential source is already connected.");
      }
      const saved = immutableCopy(connection);
      snapshot.savedConnections.set(key, saved);
      return immutableCopy(saved);
    },
    deleteSavedConnection: async (namespaceId, credentialSourceId) =>
      snapshot.savedConnections.delete(agentKey(namespaceId, credentialSourceId)),
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
    listPresetSummaries: async (namespaceId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined
          ? []
          : Array.from(snapshot.presets.values())
              .filter((preset) => preset.namespaceId === namespaceId)
              .sort((a, b) => a.id.localeCompare(b.id))
              .map(({ id, namespaceId, name, createdAt }) =>
                Object.freeze({ id, namespaceId, name, createdAt }),
              ),
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
      return saved;
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
      return saved;
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
      return saved;
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
      return updated;
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

  const authenticationStates: AuthenticationStateRepository = {
    create: async (state) => {
      if (state.kind === "oauth_connection") {
        assertInitialized(snapshot);
        assertConnectionScope(state);
      } else if (!snapshot.namespaces.has(state.namespaceId)) {
        throw new ScopeViolationError("The login belongs to an unavailable Namespace.");
      }
      if (snapshot.authenticationStates.has(state.id)) {
        throw new ResourceConflictError("The authentication state already exists.");
      }
      snapshot.authenticationStates.set(state.id, storedCopy(state));
    },
    findDevice: async (namespaceId, id) => {
      const state = snapshot.authenticationStates.get(id);
      return state?.kind === "device_authorization" && state.namespaceId === namespaceId
        ? state
        : undefined;
    },
    replaceDevice: async (
      namespaceId,
      id,
      version,
      { phase, expiresAt, nextPollAt, privateState, encryptedChallenge },
    ) => {
      const state = snapshot.authenticationStates.get(id);
      if (
        state?.kind !== "device_authorization" ||
        state.namespaceId !== namespaceId ||
        state.version !== version
      ) {
        return false;
      }
      const { privateState: _handle, encryptedChallenge: _challenge, ...metadata } = state;
      snapshot.authenticationStates.set(
        id,
        storedCopy({
          ...metadata,
          phase,
          expiresAt,
          nextPollAt,
          ...(privateState === undefined ? {} : { privateState }),
          ...(encryptedChallenge === undefined ? {} : { encryptedChallenge }),
          version: version + 1,
        }),
      );
      return true;
    },
    consumeOAuth: async (id, actorId, sessionId, at) => {
      const state = snapshot.authenticationStates.get(id);
      if (
        state?.kind !== "oauth_connection" ||
        state.actorId !== actorId ||
        state.sessionId !== sessionId ||
        state.expiresAt <= at
      ) {
        return undefined;
      }
      snapshot.authenticationStates.delete(id);
      return state;
    },
    expire: async (at, limit) => {
      const abandoned: OAuthSourceRef[] = [];
      let deviceCount = 0;
      const deadline = Date.parse(at);
      const states = [...snapshot.authenticationStates.values()].sort(
        (left, right) =>
          Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
          left.id.localeCompare(right.id),
      );
      for (const state of states) {
        if (Date.parse(state.expiresAt) > deadline) {
          break;
        }
        if (state.kind === "oauth_connection" && abandoned.length < limit) {
          snapshot.authenticationStates.delete(state.id);
          abandoned.push({
            namespaceId: state.namespaceId,
            credentialSourceId: state.credentialSourceId,
          });
        } else if (
          state.kind === "device_authorization" &&
          state.phase !== "cancelled" &&
          deviceCount < limit
        ) {
          snapshot.authenticationStates.set(
            state.id,
            storedCopy({
              ...cancelledDeviceAuthorization(state),
              kind: "device_authorization",
              id: state.id,
              version: state.version + 1,
            }),
          );
          deviceCount++;
        }
      }
      return abandoned;
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
      return saved;
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

  const materialKey = (evidence: EgressMaterialEvidence) =>
    JSON.stringify([
      evidence.source.namespaceId,
      evidence.kind === "static" ? evidence.secretDriver.id : evidence.source.provider.id,
      evidence.materialId,
      evidence.materialVersion,
    ]);
  const currentInstallation = (original: EgressInstallation): EgressInstallation =>
    [...snapshot.credentialPolicyReductions.values()].reduce(
      (current, { request, observed }) =>
        observed &&
        request.expected.plan.execution.revisionId === original.plan.execution.revisionId &&
        observed.plan.generation > current.plan.generation
          ? observed
          : current,
      original,
    );
  const credentialSources: CredentialSourceRepository = {
    listCredentialPolicyReductions: async (namespaceId, revisionId) =>
      [...snapshot.credentialPolicyReductions.values()].filter(
        ({ request }) =>
          request.expected.plan.execution.namespaceId === namespaceId &&
          request.expected.plan.execution.revisionId === revisionId,
      ),
    isEgressMaterialRejected: async (evidence) =>
      snapshot.egressRejected.has(materialKey(evidence)),
    rejectEgressMaterial: async (evidence) => {
      snapshot.egressRejected.add(materialKey(evidence));
    },
    findEgressInstallation: async (senderId, sandboxId) => {
      const found = [...snapshot.egressInstallations.values()].find(
        (installation) =>
          installation.sender.id === senderId &&
          installation.sandboxId === sandboxId &&
          !snapshot.retiredEgressInstallations.has(
            agentKey(
              installation.plan.execution.namespaceId,
              installation.plan.execution.revisionId,
            ),
          ),
      );
      return found === undefined ||
        !(
          snapshot.revisions.get(
            agentKey(found.plan.execution.namespaceId, found.plan.execution.agentId),
          ) ?? []
        ).some((revision) => revision.id === found.plan.execution.revisionId)
        ? undefined
        : currentInstallation(found);
    },
    findRevisionEgressInstallation: async (namespaceId, revisionId) => {
      const found = [...snapshot.egressInstallations.values()].find(
        ({ plan: { execution } }) =>
          execution.namespaceId === namespaceId && execution.revisionId === revisionId,
      );
      return found && currentInstallation(found);
    },
    saveCredentialPolicyReduction: async (namespaceId, revisionId, bindingId, expected, next) => {
      const key = JSON.stringify([namespaceId, revisionId, bindingId]);
      if (!isDeepStrictEqual(snapshot.credentialPolicyReductions.get(key), expected)) {
        return false;
      }
      snapshot.credentialPolicyReductions.set(key, immutableCopy(next));
      return true;
    },
    recordEgressInstallation: async (installation) => {
      const execution = installation.plan.execution;
      const revision = (
        snapshot.revisions.get(agentKey(execution.namespaceId, execution.agentId)) ?? []
      ).find((item) => item.id === execution.revisionId);
      if (!revision || !isDeepStrictEqual(revision.egressPlan, installation.plan)) {
        throw new ScopeViolationError("Egress installation does not match an admitted revision.");
      }
      const key = agentKey(execution.namespaceId, execution.revisionId);
      const prior = snapshot.egressInstallations.get(key);
      if (
        prior !== undefined &&
        (prior.sender.id !== installation.sender.id || prior.sandboxId !== installation.sandboxId)
      ) {
        throw new ResourceStateConflictError(EGRESS_REVISION_INSTALLED_CONFLICT);
      }
      if (
        snapshot.retiredEgressInstallations.has(key) ||
        (prior !== undefined &&
          (!isDeepStrictEqual(prior.plan, installation.plan) ||
            !isDeepStrictEqual(prior.sender, installation.sender) ||
            !isDeepStrictEqual(prior.enforcement, installation.enforcement)))
      ) {
        throw new ResourceStateConflictError("Egress execution identity is already bound.");
      }
      if (
        Array.from(snapshot.egressInstallations.entries()).some(
          ([otherKey, other]) =>
            otherKey !== key &&
            !snapshot.retiredEgressInstallations.has(otherKey) &&
            other.sender.id === installation.sender.id &&
            other.sandboxId === installation.sandboxId,
        )
      ) {
        throw new ResourceStateConflictError(EGRESS_SANDBOX_INSTALLED_CONFLICT);
      }
      snapshot.egressInstallations.set(key, prior ?? immutableCopy(installation));
    },
    retireEgressInstallation: async (namespaceId, revisionId) => {
      const key = agentKey(namespaceId, revisionId);
      if (snapshot.egressInstallations.has(key)) {
        snapshot.retiredEgressInstallations.add(key);
      }
    },
    admitEgressSource: async (namespaceId, sourceId, expectedGeneration, egress) => {
      const current = await findCredentialSource(namespaceId, sourceId);
      if (
        !current ||
        current.state !== "ready" ||
        (current.egress?.key.source.generation ?? 0) !== expectedGeneration
      ) {
        return undefined;
      }
      if (
        egress.key.source.id !== sourceId ||
        egress.key.namespaceId !== namespaceId ||
        egress.key.source.generation !== expectedGeneration + 1
      ) {
        throw new ScopeViolationError("Egress source generation or scope is invalid.");
      }
      assertProtectedEgressSource(egress, namespaceId, sourceId);
      const saved = immutableCopy({ ...current, egress });
      snapshot.credentialSources.set(agentKey(namespaceId, sourceId), saved);
      return saved;
    },
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
      return saved;
    },
    reassignCredentialWithdrawal: async (
      namespaceId,
      revisionId,
      credentialSourceId,
      requestedBy,
    ) => {
      const current = await findCredentialWithdrawal(namespaceId, revisionId, credentialSourceId);
      if (current === undefined || current.state !== "pending") {
        return undefined;
      }
      if (!isNonEmptyString(requestedBy)) {
        throw new ScopeViolationError("A credential withdrawal requester is missing.");
      }
      const saved = immutableCopy({ ...current, requestedBy });
      snapshot.credentialWithdrawals.set(
        withdrawalKey(namespaceId, revisionId, credentialSourceId),
        saved,
      );
      return saved;
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
      return saved;
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
      return saved;
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
      if (
        source.ownerCapability === "token_service" &&
        source.tokenServiceInstanceId !== undefined &&
        source.tokenServiceInstanceId !== snapshot.tokenServiceInstance?.id
      ) {
        throw new ScopeViolationError(
          "The credential source belongs to an unavailable TokenService instance.",
        );
      }
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
      return saved;
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
      return saved;
    },
    setCredentialSourceRegistrationDispatch: async (
      namespaceId,
      credentialSourceId,
      dispatchedAt,
    ) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (
        current?.ownerCapability !== "token_service" ||
        current.tokenServiceInstanceId === undefined ||
        current.registration !== undefined ||
        current.state !== (dispatchedAt === undefined ? "deleting" : "registering") ||
        (current.registrationDispatchedAt === undefined) === (dispatchedAt === undefined)
      ) {
        return false;
      }
      const { registrationDispatchedAt: _, ...rest } = current;
      const saved = immutableCopy(
        dispatchedAt === undefined ? rest : { ...rest, registrationDispatchedAt: dispatchedAt },
      );
      assertCredentialSource(saved);
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return true;
    },
    updateCredentialSourceConfig: async (namespaceId, credentialSourceId, config) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (
        current?.ownerCapability !== "token_service" ||
        current.tokenServiceInstanceId === undefined ||
        current.state !== "ready"
      ) {
        return undefined;
      }
      const saved = immutableCopy({ ...current, config });
      assertCredentialSource(saved);
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return saved;
    },
    markCredentialSourceReady: async (namespaceId, credentialSourceId, registration, config) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (current === undefined || current.state !== "registering") {
        return undefined;
      }
      if (
        config !== undefined &&
        (current.ownerCapability !== "token_service" ||
          current.tokenServiceInstanceId === undefined)
      ) {
        return undefined;
      }
      const saved = immutableCopy({
        ...current,
        state: "ready" as const,
        ...(registration === undefined ? {} : { registration }),
        ...(config === undefined ? {} : { config }),
      });
      assertCredentialSource(saved);
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return saved;
    },
    markCredentialSourceDeleting: async (namespaceId, credentialSourceId) => {
      const current = await findCredentialSource(namespaceId, credentialSourceId);
      if (current === undefined || current.state === "deleting") {
        return undefined;
      }
      const saved = immutableCopy({ ...current, state: "deleting" as const });
      snapshot.credentialSources.set(agentKey(namespaceId, credentialSourceId), saved);
      return saved;
    },
    hasReferences: async (namespaceId, credentialSourceId) =>
      (await credentialSources.findBlockingReference(namespaceId, credentialSourceId)) !==
      undefined,
    findBlockingReference: async (namespaceId, credentialSourceId) => {
      if ((await findCredentialSource(namespaceId, credentialSourceId)) === undefined) {
        return undefined;
      }
      const revisionOperations = (withdrawal: boolean) =>
        snapshot.operations.some((operation) => {
          if (
            operation.kind !== "agent_revision" ||
            operation.namespaceId !== namespaceId ||
            (operation.target === CREDENTIAL_WITHDRAWAL_TARGET) !== withdrawal
          ) {
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
        });
      const referenced =
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
        }) || revisionOperations(false);
      if (referenced) {
        return "reference";
      }
      return revisionOperations(true) ? "withdrawal_work" : undefined;
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
      const key = agentKey(namespaceId, credentialSourceId);
      snapshot.credentialSources.delete(key);
      snapshot.connectionTokenCustody.delete(key);
      snapshot.savedConnections.delete(key);
      for (const [id, state] of snapshot.authenticationStates) {
        if (
          state.kind === "oauth_connection" &&
          state.namespaceId === namespaceId &&
          state.credentialSourceId === credentialSourceId
        ) {
          snapshot.authenticationStates.delete(id);
        }
      }
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
      return saved;
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
      return updated;
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
    // Backend bindings are PostgreSQL-only, as findServiceAccountBackendBinding.
    findIssuedCredentialBinding: async () => undefined,
  };

  const sandboxPolicies: SandboxPolicyRepository = {
    supportsRepositoryNetworkPolicy: true,
    find: async (namespaceId, agentId) => {
      const value = snapshot.sandboxPolicies.get(agentKey(namespaceId, agentId));
      return value === undefined ? undefined : immutableCopy(value);
    },
    save: async (policy, expectedVersion) => {
      const key = agentKey(policy.namespaceId, policy.agentId);
      const existing = snapshot.sandboxPolicies.get(key);
      if (existing === undefined || existing.version !== expectedVersion) {
        return undefined;
      }
      validateSandboxNetworkGrants(policy.additions);
      if (
        !snapshot.agents.has(key) ||
        existing.id !== policy.id ||
        policy.id !== `sbp_${policy.agentId.slice(4)}` ||
        !Number.isInteger(policy.version) ||
        policy.version > 2147483647 ||
        policy.version < 1 ||
        (policy.version !== expectedVersion && policy.version !== expectedVersion + 1)
      ) {
        throw new ScopeViolationError("Invalid SandboxPolicy ownership or version.");
      }
      const grants = policy.repositoryNetworkPolicy;
      if (grants !== undefined && !isCanonicalRepositoryGrantList(grants)) {
        throw new ScopeViolationError("Repository network policy grants must be canonical.");
      }
      if (
        (existing.repositoryNetworkPolicy !== undefined && grants === undefined) ||
        (policy.version === existing.version &&
          !isDeepStrictEqual(grants, existing.repositoryNetworkPolicy))
      ) {
        throw new ScopeViolationError("Invalid repository network policy transition.");
      }
      const application = policy.application;
      const previousApplication = existing.application;
      if (
        (policy.version === existing.version &&
          !isDeepStrictEqual(policy.additions, existing.additions)) ||
        (policy.version !== existing.version &&
          (previousApplication?.state === "pending" || application !== undefined)) ||
        (previousApplication?.state === "pending" && application === undefined)
      ) {
        throw new ScopeViolationError("Invalid SandboxPolicy version transition.");
      }
      if (application !== undefined) {
        const revision = (snapshot.revisions.get(key) ?? []).find(
          ({ id }) => id === application.revisionId,
        );
        if (
          grants !== undefined ||
          revision?.sandboxPolicy?.repositoryNetworkPolicy !== undefined ||
          application.snapshot.repositoryNetworkPolicy !== undefined
        ) {
          throw new ScopeViolationError("Repository network policy requires a new deployment.");
        }
        if (
          revision === undefined ||
          application.policyVersion !== policy.version ||
          application.snapshot.version !== policy.version ||
          !isDeepStrictEqual(application.snapshot.additions, policy.additions)
        ) {
          throw new ScopeViolationError("Invalid SandboxPolicy application ownership or snapshot.");
        }
        if (application.id === previousApplication?.id) {
          const {
            state: _state,
            expectedProviderVersion: _expected,
            providerVersion: _provider,
            reason: _reason,
            ...identity
          } = application;
          const {
            state: _previousState,
            expectedProviderVersion: _previousExpected,
            providerVersion: _previousProvider,
            reason: _previousReason,
            ...previousIdentity
          } = previousApplication;
          if (
            !isDeepStrictEqual(identity, previousIdentity) ||
            (previousApplication.expectedProviderVersion !== undefined &&
              previousApplication.expectedProviderVersion !==
                application.expectedProviderVersion) ||
            (previousApplication.state !== "pending" &&
              !isDeepStrictEqual(application, previousApplication))
          ) {
            throw new ScopeViolationError("SandboxPolicy application identity is immutable.");
          }
        } else if (
          previousApplication?.state === "pending" ||
          application.state !== "pending" ||
          application.expectedProviderVersion !== undefined
        ) {
          throw new ScopeViolationError("Invalid SandboxPolicy application transition.");
        }
      }
      if (
        !isDeepStrictEqual(policy.applied, existing.applied) &&
        (application?.state !== "applied" ||
          policy.applied?.policyVersion !== application.policyVersion ||
          policy.applied?.revisionId !== application.revisionId ||
          policy.applied?.providerVersion !== application.providerVersion)
      ) {
        throw new ScopeViolationError("Applied policy requires confirmed application evidence.");
      }
      const saved = immutableCopy(policy);
      snapshot.sandboxPolicies.set(key, saved);
      return saved;
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
      return saved;
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
      return completed;
    },
    delete: async (namespaceId, agentId) =>
      snapshot.workspaceSetups.delete(agentKey(namespaceId, agentId)),
  };

  const agents: AgentRepository = {
    findPredecessorReplacement: async (namespaceId, agentId) =>
      (await agents.findAgent(namespaceId, agentId)) === undefined
        ? undefined
        : snapshot.predecessorReplacements.get(agentKey(namespaceId, agentId)),
    recordPredecessorReplacement: async (namespaceId, agentId, input) => {
      const agent = await agents.findAgent(namespaceId, agentId);
      if (!agent || agent.activeRevisionId !== input.predecessorRevisionId) {
        return undefined;
      }
      const revisions = snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [];
      const predecessor = revisions.find((revision) => revision.id === input.predecessorRevisionId);
      const candidate = revisions.find((revision) => revision.id === input.candidateRevisionId);
      if (!predecessor || !candidate || candidate.revision <= predecessor.revision) {
        return undefined;
      }
      const key = agentKey(namespaceId, agentId);
      const current = snapshot.predecessorReplacements.get(key);
      const previous =
        current?.predecessorRevisionId === input.predecessorRevisionId ? current : undefined;
      const now = new Date().toISOString();
      const saved = immutableCopy({
        ...input,
        phase: previous?.phase === "stopping" ? "stopping" : input.phase,
        startedAt: previous?.startedAt ?? now,
        ...(previous?.stoppingAt
          ? { stoppingAt: previous.stoppingAt }
          : input.phase === "stopping"
            ? { stoppingAt: now }
            : {}),
      });
      snapshot.predecessorReplacements.set(key, saved);
      return saved;
    },
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
    hasAgentNamed: async (namespaceId, name) =>
      snapshot.namespaces.get(namespaceId)?.deletedAt === undefined &&
      Array.from(snapshot.agents.values()).some(
        (agent) => agent.namespaceId === namespaceId && agent.name === name,
      ),
    listAgentReferences: async () => {
      const live = new Set(
        Array.from(snapshot.namespaces.values())
          .filter((namespace) => namespace.deletedAt === undefined)
          .map((namespace) => namespace.id),
      );
      return Object.freeze(
        Array.from(snapshot.agents.values())
          .filter((agent) => live.has(agent.namespaceId))
          .map((agent) => Object.freeze({ id: agent.id, namespaceId: agent.namespaceId })),
      );
    },
    setSandboxPolicyEditing: async (namespaceId, agentId, enabled) => {
      const key = agentKey(namespaceId, agentId);
      const current = snapshot.agents.get(key);
      if (current === undefined) {
        return undefined;
      }
      const saved = immutableCopy({ ...current, sandboxPolicyEditing: enabled });
      snapshot.agents.set(key, saved);
      return saved;
    },
    createAgent: async (agent) => {
      assertInitialized(snapshot);
      if (agent.executionMode !== "embedded" && agent.executionMode !== "dedicated") {
        throw new ScopeViolationError("The Agent execution mode is invalid.");
      }
      if (agent.backendId !== null && !isBackendId(agent.backendId)) {
        throw new ScopeViolationError("The Agent Backend identity is invalid.");
      }
      const plugins = normalizedPlugins(agent.plugins);
      assertPluginDriverSelection(agent.pluginDriver, plugins);
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
        gatewayManagedMode: agent.gatewayManagedMode ?? true,
        ...(plugins === undefined ? {} : { plugins }),
        ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
        ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
        sandboxPolicyEditing: false,
        desiredRuntimeState: "stopped" as const,
        status: "active" as const,
      });
      snapshot.agents.set(key, saved);
      snapshot.sandboxPolicies.set(
        key,
        immutableCopy({
          id: `sbp_${agent.id.slice(4)}`,
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          version: 1,
          additions: [],
        }),
      );
      return saved;
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
      if (next !== "running" && agent.activeRevisionId) {
        const execution = snapshot.repositoryStandingExecutions.get(agent.activeRevisionId);
        if (execution) {
          snapshot.repositoryStandingExecutions.set(agent.activeRevisionId, {
            ...execution,
            closed: true,
          });
        }
      }
      const saved = immutableCopy({ ...agent, desiredRuntimeState: next });
      snapshot.agents.set(key, saved);
      return saved;
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
      return saved;
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
      gatewayManagedMode,
      nextPluginDriver,
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
      // Like PostgreSQL, only a supplied binding must be available; omission keeps the stored one.
      if (harnessAuth !== undefined) {
        await assertHarnessAuthAvailable(
          { secrets, serviceAccounts, credentialSources },
          namespaceId,
          harnessAuth,
        );
      }
      const association = harnessAuth === undefined ? current.harnessAuth : harnessAuth;
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
      const pluginDriver =
        nextPluginDriver === undefined ? current.pluginDriver : (nextPluginDriver ?? undefined);
      assertPluginDriverSelection(pluginDriver, plugins);
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
        pluginDriver: _currentPluginDriver,
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
        gatewayManagedMode: gatewayManagedMode ?? current.gatewayManagedMode,
        ...(pluginDriver === undefined ? {} : { pluginDriver }),
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
      return updated;
    },
    compareAndClearActiveRevision: async (namespaceId, agentId, expectedRevisionId) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current || current.activeRevisionId !== expectedRevisionId) {
        return undefined;
      }
      const execution = snapshot.repositoryStandingExecutions.get(expectedRevisionId);
      if (execution) {
        snapshot.repositoryStandingExecutions.set(expectedRevisionId, {
          ...execution,
          closed: true,
        });
      }
      const { activeRevisionId: _activeRevisionId, ...stopped } = current;
      const updated = immutableCopy(stopped);
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return updated;
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
      if (current.activeRevisionId && current.activeRevisionId !== candidateRevisionId) {
        const execution = snapshot.repositoryStandingExecutions.get(current.activeRevisionId);
        if (execution) {
          snapshot.repositoryStandingExecutions.set(current.activeRevisionId, {
            ...execution,
            closed: true,
          });
        }
      }
      const updated = immutableCopy({ ...current, activeRevisionId: candidateRevisionId });
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return updated;
    },
  };

  const revisions: AgentRevisionRepository = {
    findFirstDeploymentReceipt: async (namespaceId, agentId, digest) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) {
        return undefined;
      }
      const first = snapshot.revisions
        .get(agentKey(namespaceId, agentId))
        ?.find((revision) => revision.revision === 1);
      return first !== undefined && snapshot.firstDeploymentDigests.get(first.id) === digest
        ? immutableCopy({
            revisionId: first.id,
            namespaceId,
            agentId,
            configurationId: first.configurationId,
            configurationGeneration: first.configurationGeneration,
            createdAt: first.createdAt,
          })
        : undefined;
    },
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
    listRevisionMetadata: async (namespaceId, agentId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? (snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [])
              .filter(
                (revision) => revision.namespaceId === namespaceId && revision.agentId === agentId,
              )
              .map(({ id, namespaceId, agentId, revision, backendId, createdAt }) =>
                Object.freeze({ id, namespaceId, agentId, revision, backendId, createdAt }),
              )
          : [],
      ),
    pageRevisionSummaries: async (namespaceId, agentId, { before, limit }) => {
      const older =
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? (snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [])
              .filter(
                (revision) =>
                  revision.namespaceId === namespaceId &&
                  revision.agentId === agentId &&
                  (before === undefined || revision.revision < before),
              )
              .sort((left, right) => right.revision - left.revision)
          : [];
      const page = older
        .slice(0, limit)
        .map(
          ({
            id,
            namespaceId,
            agentId,
            revision,
            backendId,
            configurationId,
            configurationGeneration,
            harness,
            createdAt,
          }) =>
            immutableCopy({
              id,
              namespaceId,
              agentId,
              revision,
              backendId,
              configurationId,
              configurationGeneration,
              harness,
              createdAt,
            }),
        );
      return Object.freeze({
        revisions: Object.freeze(page),
        ...(older.length > limit ? { nextBefore: page.at(-1)!.revision } : {}),
      });
    },
    createRevision: async (input, firstDeploymentDigest) => {
      const revision = immutableCopy(input);
      assertInitialized(snapshot);
      assertAdmittedAgentRevision(revision);
      const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
      if (
        owner === undefined ||
        owner.servicePrincipalId !== revision.servicePrincipalId ||
        owner.backendId !== revision.backendId ||
        revision.gatewayManagedMode !== owner.gatewayManagedMode ||
        !harnessAuthMatches(owner.harnessAuth, revision.harnessAuth) ||
        !credentialSourcesMatch(owner.credentialSources, revision.credentialSources)
      ) {
        throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
      }
      await assertRevisionAuthAvailable(
        { secrets, serviceAccounts, credentialSources },
        revision,
        async (ids) => {
          const sources = await Promise.all(
            ids.map((id) => findCredentialSource(revision.namespaceId, id)),
          );
          return sources.filter((source) => source !== undefined);
        },
      );
      const secretBindings = normalizedSecretBindings(revision.secretBindings);
      const plugins = revision.plugins === undefined ? undefined : immutableCopy(revision.plugins);
      await assertSecretBindingsAvailable(secrets, revision.namespaceId, secretBindings);
      const key = agentKey(revision.namespaceId, revision.agentId);
      if (
        snapshot.sandboxPolicies.get(key)?.repositoryNetworkPolicy !== undefined ||
        revision.sandboxPolicy?.repositoryNetworkPolicy !== undefined
      ) {
        throw new ScopeViolationError("Repository network policy revisions are unsupported.");
      }
      const previous = snapshot.revisions.get(key) ?? [];
      if (previous.some((existing) => existing.id === revision.id)) {
        throw new ResourceConflictError("The server generated an existing AgentRevision identity.");
      }
      if (!Number.isSafeInteger(revision.revision) || revision.revision <= 0) {
        throw new ScopeViolationError("The Agent revision number must be a positive safe integer.");
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
      if (firstDeploymentDigest !== undefined) {
        if (
          previous.length !== 0 ||
          revision.revision !== 1 ||
          !/^[a-f0-9]{64}$/.test(firstDeploymentDigest)
        ) {
          throw new ResourceConflictError("Invalid first-deployment admission.");
        }
        snapshot.firstDeploymentDigests.set(saved.id, firstDeploymentDigest);
      }
      const history = [...previous];
      const last = previous.at(-1);
      if (last !== undefined && saved.revision <= last.revision) {
        const index = previous.findIndex((existing) => existing.revision >= saved.revision);
        if (previous[index]?.revision === saved.revision) {
          throw new ResourceConflictError("The Agent already has a revision with this number.");
        }
        history.splice(index, 0, saved);
      } else {
        history.push(saved);
      }
      snapshot.revisions.set(key, Object.freeze(history));
      return saved;
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
    if (resourceKind === "sandbox_policy") {
      const policy = await sandboxPolicies.find(namespaceId, `agt_${resourceId.slice(4)}`);
      return (
        policy?.id === resourceId &&
        (await agents.findAgent(namespaceId, policy.agentId))?.status === "active"
      );
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
      return saved;
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
      assertBindingSubjectNotEmail(binding.subjectId);
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
      return saved;
    },
    deleteAccessBinding: async (namespaceId, bindingId) =>
      snapshot.bindings.delete(iamPolicyKey(namespaceId, bindingId)),
    // In-memory State is no Native IAM Driver's policy source, so OCC writes no configured
    // policy or Owner bindings here (OpenClawController.occBindingDriver).
    listConfiguredPolicy: async () =>
      Object.freeze({ roles: Object.freeze([]), groups: Object.freeze([]), bindings: [] }),
    putConfiguredRole: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store configured Roles.");
    },
    deleteConfiguredRole: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store configured Roles.");
    },
    createConfiguredGroup: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store configured Groups.");
    },
    deleteConfiguredGroup: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store configured Groups.");
    },
    createOCCBinding: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store OCC bindings.");
    },
    deleteConfiguredBinding: async () => {
      throw new DependencyUnavailableError("The in-memory state does not store OCC bindings.");
    },
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
    snapshot.repositoryStandingExecutions,
    snapshot.repositoryStandingApprovals,
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
    (owner) => {
      const namespace = snapshot.namespaces.get(owner.namespaceId);
      const agent = snapshot.agents.get(agentKey(owner.namespaceId, owner.agentId));
      return (
        namespace?.status === "ready" &&
        agent?.status === "active" &&
        agent.desiredRuntimeState === "running" &&
        agent.activeRevisionId === owner.revisionId
      );
    },
    (owner, at) => {
      const namespace = snapshot.namespaces.get(owner.namespaceId);
      const agent = snapshot.agents.get(agentKey(owner.namespaceId, owner.agentId));
      if (
        namespace?.status !== "ready" ||
        agent?.status !== "active" ||
        agent.activeRevisionId !== owner.revisionId
      ) {
        throw new ScopeViolationError("Finite withdrawal requires the exact active revision.");
      }
      const original = snapshot.operations.find(
        (operation) =>
          operation.kind === "agent_revision" &&
          operation.target === undefined &&
          operation.namespaceId === owner.namespaceId &&
          operation.resourceId === owner.revisionId,
      );
      if (!original) {
        throw new ScopeViolationError(
          "Finite withdrawal requires the original deployment authority.",
        );
      }
      const actorId = original.actorId;
      const key = repositoryRemovalWorkKey(owner.revisionId);
      if (!snapshot.repositoryWithdrawals.has(key)) {
        const time = new Date(at);
        snapshot.repositoryWithdrawals.set(
          key,
          immutableCopy({
            kind: "lifecycle",
            idempotencyKey: key,
            ...owner,
            actorId,
            state: "queued",
            availableAt: time,
            attemptCount: 0,
            createdAt: time,
            updatedAt: time,
          }),
        );
      }
    },
    (owner) => {
      const withdrawal = snapshot.repositoryWithdrawals.get(
        repositoryRemovalWorkKey(owner.revisionId),
      );
      return (
        withdrawal?.namespaceId === owner.namespaceId &&
        withdrawal.agentId === owner.agentId &&
        withdrawal.revisionId === owner.revisionId
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
    connectionTemplates,
    savedConnections,
    authenticationStates,
    presets,
    secrets,
    credentialSources,
    serviceAccounts,
    agents,
    sandboxPolicies,
    workspaceSetups,
    revisions,
    iamPolicy,
    repositorySessions,
    preparedTokenProof,
    egressSendReceipts: memoryEgressSendReceipts(snapshot.egressSendReceipts),
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
      settleAbandonedEffect: provisioningUnavailable,
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
          if (
            operation.target !== "stopped" &&
            operation.target !== "deleted" &&
            operation.target !== "sandbox_policy"
          ) {
            throw new ScopeViolationError("Agent work does not match its exact lifecycle target.");
          }
          if (operation.target !== "deleted" && !isNonEmptyString(operation.operationId)) {
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
                  (operation.target !== "deleted" &&
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
      expediteCredentialWithdrawalWork: async () => false,
      findWorkAttempt: async () => undefined,
      hasRepositoryExecutionRedeployRequired: async () => false,
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
        const withdrawal = snapshot.repositoryWithdrawals.get(idempotencyKey);
        if (withdrawal) {
          return immutableCopy(withdrawal);
        }
        const operation = snapshot.operations.find(
          (candidate) => operationIdempotencyKey(candidate) === idempotencyKey,
        );
        if (operation === undefined) {
          return undefined;
        }
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
        return memoryLifecycleWork(idempotencyKey, operation, revisionOwner);
      },
      findWorkByKeys: async (idempotencyKeys) => {
        const pending = new Set(idempotencyKeys);
        const works = new Map<string, Readonly<ControllerWork>>();
        for (const key of pending) {
          const withdrawal = snapshot.repositoryWithdrawals.get(key);
          if (withdrawal !== undefined) {
            works.set(key, immutableCopy(withdrawal));
            pending.delete(key);
          }
        }
        if (pending.size === 0) {
          return works;
        }
        const revisionOwners = new Map<string, Map<string, string>>();
        for (const history of snapshot.revisions.values()) {
          for (const revision of history) {
            let namespaceOwners = revisionOwners.get(revision.namespaceId);
            if (namespaceOwners === undefined) {
              namespaceOwners = new Map();
              revisionOwners.set(revision.namespaceId, namespaceOwners);
            }
            if (!namespaceOwners.has(revision.id)) {
              namespaceOwners.set(revision.id, revision.agentId);
            }
          }
        }
        for (const operation of snapshot.operations) {
          let key: string;
          try {
            key = operationIdempotencyKey(operation);
          } catch (error) {
            return {
              get(idempotencyKey: string) {
                if (pending.has(idempotencyKey)) {
                  throw error;
                }
                return works.get(idempotencyKey);
              },
            };
          }
          if (!pending.delete(key)) {
            continue;
          }
          const revisionOwner = revisionOwners
            .get(operation.namespaceId)
            ?.get(operation.resourceId);
          works.set(key, memoryLifecycleWork(key, operation, revisionOwner));
          if (pending.size === 0) {
            break;
          }
        }
        return works;
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
      (binding.resourceKind === "sandbox_policy" &&
        binding.resourceId === `sbp_${agentId.slice(4)}`) ||
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
  for (const id of revisionIds) {
    snapshot.firstDeploymentDigests.delete(id);
  }
  snapshot.revisions.delete(key);
  snapshot.sandboxPolicies.delete(key);
  snapshot.agents.delete(key);
  snapshot.predecessorReplacements.delete(key);

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
    tokenServiceInstance: undefined,
    namespaces: new Map(),
    configurations: new Map(),
    connectionTemplates: new Map(),
    clientRegistrations: new Map(),
    oauthConnectionTemplateVersions: new Map(),
    connectionTokenCustody: new Map(),
    savedConnections: new Map(),
    presets: new Map(),
    authenticationStates: new Map(),
    secrets: new Map(),
    credentialSources: new Map(),
    credentialPolicyReductions: new Map(),
    credentialWithdrawals: new Map(),
    egressInstallations: new Map(),
    retiredEgressInstallations: new Set(),
    egressRejected: new Set(),
    egressSendReceipts: new Map(),
    serviceAccounts: new Map(),
    agents: new Map(),
    predecessorReplacements: new Map(),
    sandboxPolicies: new Map(),
    workspaceSetups: new Map(),
    revisions: new Map(),
    firstDeploymentDigests: new Map(),
    roles: new Map(),
    bindings: new Map(),
    servicePrincipals: new Map(),
    repositoryStandingExecutions: new Map(),
    repositoryStandingApprovals: new Map(),
    repositoryWithdrawals: new Map(),
    repositorySessions: new Map(),
    repositoryBrokerReceipts: new Map(),
    audit: [],
    operations: [],
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly auditSink: PlatformAuditSink | undefined;
  private readonly iamSubjects: IAMSubjectSource;
  private readonly preparedTokenProof: PreparedTokenCurrentProof;

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
    this.preparedTokenProof = options.preparedTokenProof ?? { current: async () => false };
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
          repositories(cloneSnapshot(this.snapshot), this.iamSubjects, this.preparedTokenProof),
          lifetime,
        ),
      );
    } finally {
      await lifetime.finish();
    }
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.commit((working, lifetime) =>
      work(
        bindPlatformUnitOfWork(
          repositories(working, this.iamSubjects, this.preparedTokenProof),
          lifetime,
        ),
      ),
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
