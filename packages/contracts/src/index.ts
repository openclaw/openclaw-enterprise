import type { WorkspaceSetup } from "./workspace-setup.ts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolPolicySchema,
  PluginToolDefaultsSchema,
} from "./api/resources.ts";
import { Check } from "typebox/value";
import { PluginApproversSchema } from "./api/common.ts";
import type {
  RepositoryAccess,
  RepositoryBindingSelection,
  RepositoryCredentialMaterialRef,
  RepositoryCredentialRuntimeBinding,
  RepositoryRevisionState,
} from "./repo.ts";

export {
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  normalizeLoggingLevel,
  type LoggingLevel,
} from "./logging.ts";

export type {
  RepositoryAccess,
  AdmittedRepositoryBinding,
  OpenRepositorySessionInput,
  OpenRepositorySessionResult,
  RepositoryBindingRequest,
  RepositoryBindingSelection,
  RepositoryOption,
  RepositoryOptions,
  RepoDriver,
  RepositoryCredentialGrantIdentity,
  RepositoryCredentialMaterialRef,
  RepositoryCredentialResolution,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionFiles,
  RepositoryCredentialSessionStatus,
  RepositoryRevisionState,
} from "./repo.ts";

export const DRIVER_CAPABILITIES = Object.freeze([
  "iam",
  "compute",
  "configuration",
  "service_account",
  "secret",
  "sandbox",
  "plugin",
  "channel",
  "repo",
  "credential_gateway",
  "credential_refresh",
] as const);

export type DriverCapability = (typeof DRIVER_CAPABILITIES)[number];

/** Experimental Installation backend composition; separate from native model providers. */
export type BackendType = BackendDefinition["type"];

export type BackendRef = string | null;

export interface BackendConfiguration {
  readonly workspaceId: string;
  readonly apiKeyPath: string;
  readonly credentialTtlSeconds?: number;
}

export interface ChatGPTBackendDefinition {
  readonly id: string;
  readonly type: "chatgpt";
  readonly configuration: BackendConfiguration;
  readonly drivers: Readonly<Record<"service_account", string>>;
}

export interface GitHubRepositoryCredentialBackendDefinition {
  readonly id: string;
  readonly type: "github";
  readonly configuration: { readonly registryPath: string };
  readonly drivers: { readonly repo: string };
}

/** Connection settings for one OpenShell gateway deployment; no workspace policy. */
export interface OpenShellBackendConfiguration {
  readonly endpoint?: string;
  readonly scheme?: "http" | "https";
  /** A dotted name is used as-is; a bare name resolves in each Sandbox namespace. */
  readonly serviceName?: string;
  readonly port?: number;
  readonly auth?:
    | { readonly mode: "unauthenticated" }
    | { readonly mode: "bearerTokenFile"; readonly path: string };
  /** Direct operator mTLS for credential retrieval only; ordinary RPCs keep auth above. */
  readonly operatorTls?: {
    readonly certificatePath: string;
    readonly privateKeyPath: string;
  };
  /** At most 30 s; it bounds how late a timed-out credential registration can land. */
  readonly requestTimeoutMs?: number;
  readonly rootCertificatePath?: string;
  /**
   * Declares that NetworkPolicy isolates a gateway reached without TLS or bearer authentication.
   * Required for such transport because credential registration sends resolved values.
   */
  readonly insecureTransport?: "network-policy";
}

export interface OpenShellBackendDefinition {
  readonly id: string;
  readonly type: "openshell";
  readonly configuration: OpenShellBackendConfiguration;
  readonly drivers: {
    readonly sandbox: string;
    readonly credential_gateway: string;
    /** Refreshes the gateway's refresh-type sources; absent when none are offered. */
    readonly credential_refresh?: string;
  };
}

export type BackendDefinition =
  | ChatGPTBackendDefinition
  | GitHubRepositoryCredentialBackendDefinition
  | OpenShellBackendDefinition;

export interface BackendSummary {
  readonly id: string;
  readonly type: BackendType;
}

export interface InstallationCapabilities {
  readonly agentProvisioning?: ComputeAgentProvisioningCapabilities;
  readonly pluginPolicies?: PluginPolicyCapabilities & { readonly driver: PluginDriverIdentity };
  readonly pluginDiscovery?: { readonly credential: "required" | "none" };
  /** Present only when dedicated native OpenClaw can be admitted. */
  readonly nativeWorkers?: { readonly support: "pinned-runtime" | "custom-image" };
}

/** Experimental authenticated client shared by related Installation Drivers. */
export interface Backend<Client = unknown> {
  readonly id: string;
  readonly client: Client;
  readonly drivers: Readonly<Partial<Record<DriverCapability, string>>>;
}

export const CONFIGURATION_KINDS = Object.freeze(["agent"] as const);

export type ConfigurationKind = (typeof CONFIGURATION_KINDS)[number];

export const HARNESS_EXECUTION_MODES = Object.freeze(["embedded", "dedicated"] as const);

export type HarnessExecutionMode = (typeof HARNESS_EXECUTION_MODES)[number];

export const SANDBOX_FACETS = Object.freeze(["networking", "filesystem", "process"] as const);

export type SandboxFacet = (typeof SANDBOX_FACETS)[number];

export const RESOURCE_KINDS = Object.freeze([
  "installation",
  "namespace",
  "configuration",
  "preset",
  "service_account",
  "secret",
  "agent",
  "agent_revision",
  "credential_source",
] as const);

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export function isDriverCapability(value: unknown): value is DriverCapability {
  return (
    typeof value === "string" && DRIVER_CAPABILITIES.some((capability) => capability === value)
  );
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && RESOURCE_KINDS.some((kind) => kind === value);
}

export function isSandboxFacet(value: unknown): value is SandboxFacet {
  return typeof value === "string" && SANDBOX_FACETS.some((facet) => facet === value);
}

export interface Scope {
  readonly namespaceId?: string;
}

export interface ResourceRef extends Scope {
  readonly kind: ResourceKind;
  readonly id: string;
}

export interface Installation {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly capabilities?: InstallationCapabilities;
}

export type NamespaceStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface Namespace {
  readonly id: string;
  readonly name: string;
  readonly existingNamespace?: string;
  readonly status: NamespaceStatus;
  readonly createdAt: string;
}

export type OpenClawConfigurationValue =
  | null
  | boolean
  | number
  | string
  | readonly OpenClawConfigurationValue[]
  | { readonly [key: string]: OpenClawConfigurationValue };

export interface OpenClawConfigurationDocument {
  readonly [key: string]: OpenClawConfigurationValue;
}

/** Secret material is never part of an OCC resource or revision. */
export interface SecretReference extends ResourceRef {
  readonly kind: "secret";
  readonly namespaceId: string;
}

export interface ServiceAccountReference extends ResourceRef {
  readonly kind: "service_account";
  readonly namespaceId: string;
}

export interface SecretIdentity {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
}

/** Backend identity is internal OCC metadata, not a public selector. */
export interface SecretBackendRef {
  readonly namespaceName: string;
  readonly name: string;
  readonly key: string;
  readonly uid: string;
}

export interface Secret extends SecretIdentity {
  readonly driverId: string;
  readonly backendRef: SecretBackendRef;
  readonly createdAt: string;
}

export interface SecretMetadata extends SecretIdentity {
  readonly ref: SecretReference;
}

/**
 * Current references that keep a Secret from deletion, limited to resources the caller may
 * read. `unreadable` counts the examined references the caller may not read, without naming
 * them; `truncated` means more references exist than OCC examined.
 */
export interface SecretConsumers {
  readonly agents: readonly string[];
  readonly configurations: readonly string[];
  readonly credentialSources: readonly string[];
  readonly provisioningRequests: readonly string[];
  readonly unreadable: number;
  readonly truncated: boolean;
}

export interface SecretDetail extends SecretMetadata {
  readonly consumers: SecretConsumers;
}

export interface SecretBinding {
  readonly source: SecretReference;
  readonly delivery?: { readonly type: "env" };
}

export type SecretBindings = Readonly<Record<string, SecretBinding>>;

/** Prepared from authoritative OCC metadata; never persisted in AgentRevision. */
export interface SecretEnvironmentProjection {
  readonly name: string;
  readonly secretId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly backendRef: SecretBackendRef;
}

export interface CredentialSourceReference extends ResourceRef {
  readonly kind: "credential_source";
  readonly namespaceId: string;
}

/** Source-backed login modes; `chatgptAuthTokens` requires a dedicated Codex Harness. */
export type CredentialSourceLoginMode = "api_key" | "chatgptAuthTokens";

export interface CredentialSourceFieldSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

/** One entry in a Credential Gateway implementation's catalog. */
export interface CredentialSourceType {
  /** Device login defers the first mint to the selected Credential Refresh Driver. */
  readonly deviceAuthorization?: { readonly harnessId: string };
  readonly type: string;
  readonly config: readonly CredentialSourceFieldSpec[];
  readonly secrets: readonly CredentialSourceFieldSpec[];
  /** `refresh` types need the Backend's Credential Refresh Driver to mint their tokens. */
  readonly rotation: "none" | "external" | "refresh";
  readonly harnessAuth?: {
    readonly modelProvider: string;
    readonly loginMode: CredentialSourceLoginMode;
  };
}

/** `registering` is recorded before the gateway write, so an uncertain outcome stays visible. */
export type CredentialSourceState = "registering" | "ready" | "deleting";

/** OCC record for a credential held by the selected Credential Gateway; never values. */
export interface CredentialSource {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SecretReference>>;
  readonly driverId: string;
  readonly state: CredentialSourceState;
  readonly createdAt: string;
}

export interface CredentialSourceMetadata {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SecretReference>>;
  readonly state: CredentialSourceState;
  readonly ref: CredentialSourceReference;
}

/**
 * An authorized request to revoke one credential source from one Agent revision. `revoked`
 * is recorded only after the Credential Gateway confirms the revision's placeholders no
 * longer resolve; the revision cannot re-attach the source.
 */
export interface CredentialWithdrawal {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly credentialSourceId: string;
  readonly state: "pending" | "revoked";
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly completedAt?: string;
  /** The worker's most recent outcome code, for example why the withdrawal is still pending. */
  readonly lastReason?: string;
  readonly lastAttemptAt?: string;
}

/**
 * A withdrawal as the API reports it. `withdrawalInProgress` is true while an attempt is queued
 * or running. A `pending` withdrawal without one has no attempt queued (attempts ran out or a
 * permanent failure ended them): nothing retries it until the withdraw request is sent again,
 * or revision maintenance, where Compute or repository credentials schedule it, queues one.
 * Maintenance never re-queues one whose last attempt was denied to its requester.
 * The API reports the active revision's withdrawal unless another revision that may still run
 * with the source has a `pending` one, preferring one with no attempt queued.
 */
export interface CredentialWithdrawalStatus extends CredentialWithdrawal {
  readonly withdrawalInProgress: boolean;
}

/** A non-model credential source the Agent's Harness may use at its source's endpoints. */
export interface AgentCredentialSourceBinding {
  readonly sourceId: string;
}

/** Private admission metadata for one non-model source frozen into a revision. */
export interface CredentialSourceSnapshot {
  readonly sourceId: string;
  readonly credentialGatewayId: string;
  readonly sourceType: string;
}

export type HarnessAuthBinding =
  | { readonly method: "api_key"; readonly source: SecretReference }
  | { readonly method: "codex_pat"; readonly source: SecretReference }
  | { readonly method: "codex_pat"; readonly source: ServiceAccountReference }
  | { readonly method: "credential_source"; readonly sourceId: string }
  | { readonly method: "runtime" };

/** Private admission metadata. Public APIs expose only HarnessAuthBinding. */
export type HarnessAuthSnapshot =
  | { readonly method: "runtime" }
  | {
      readonly method: "api_key";
      readonly source: SecretReference;
      readonly secretDriverId: string;
    }
  | {
      readonly method: "codex_pat";
      readonly source: SecretReference;
      readonly secretDriverId: string;
    }
  | {
      readonly method: "codex_pat";
      readonly source: ServiceAccountReference;
      readonly credential: ServiceAccountCredential & { readonly kind: "access_token" };
      readonly backendBinding: {
        readonly backendId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      };
    }
  | {
      readonly method: "credential_source";
      readonly sourceId: string;
      readonly credentialGatewayId: string;
      readonly sourceType: string;
      readonly loginMode: CredentialSourceLoginMode;
    };

/** Authoritative delivery references, resolved again at dispatch; never secret values. */
export type ResolvedHarnessAuth =
  | (Extract<HarnessAuthSnapshot, { source: SecretReference }> & {
      readonly backendRef: SecretBackendRef;
    })
  | (Extract<HarnessAuthSnapshot, { method: "credential_source" }> & {
      readonly source: Readonly<CredentialSource>;
    })
  | Extract<HarnessAuthSnapshot, { source: ServiceAccountReference } | { method: "runtime" }>;

export interface ComputeRevisionContext {
  readonly workspaceSetup?: Readonly<WorkspaceSetup>;
  readonly harnessAuth: ResolvedHarnessAuth;
  /** Non-model sources resolved again at dispatch, in admission order. */
  readonly credentialSources?: readonly Readonly<CredentialSource>[];
  readonly secretEnvironment: readonly SecretEnvironmentProjection[];
  readonly repositoryCredentials?: readonly RepositoryCredentialRuntimeBinding[];
}

export type PluginReviewer = "human" | "auto";

export type PluginApprovalMode = "provider_default" | "all_actions" | "write_actions" | "none";

export interface PluginDriverIdentity {
  readonly id: string;
  readonly implementation: string;
}

export interface PluginToolPolicy {
  readonly enabled?: boolean;
  readonly approval?: PluginApprovalMode;
  readonly reviewer?: PluginReviewer;
  readonly approvers?: PluginApprovers;
}

export type PluginToolDefaults = Omit<PluginToolPolicy, "approvers">;

/** The channel Driver interprets each opaque actor identity. */
export interface PluginApprover {
  readonly channel: string;
  readonly id: string;
}

export type PluginApprovers = readonly PluginApprover[];

export interface PluginDesiredSelection {
  readonly enabled: boolean;
  readonly approvers?: PluginApprovers;
  readonly toolDefaults?: PluginToolDefaults;
  /** Validated by the selected Plugin Driver, never interpreted by the control plane. */
  readonly driverPolicy?: Readonly<Record<string, unknown>>;
  readonly tools?: Readonly<Record<string, PluginToolPolicy>>;
}

export type PluginDesiredState = Readonly<Record<string, PluginDesiredSelection>>;

export interface PluginToolCatalogEntry {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly destructive?: boolean;
  readonly writes?: boolean;
}

export interface PluginPolicyCapabilities {
  readonly approvers?: {
    readonly agent: boolean;
    readonly plugin: boolean;
    readonly tools: boolean;
  };
  readonly toolDefaults: {
    readonly enabled: boolean;
    readonly approval: readonly PluginApprovalMode[];
    readonly reviewer: readonly PluginReviewer[];
  };
  readonly tools: {
    readonly enabled: boolean;
    readonly approval: readonly PluginApprovalMode[];
    readonly reviewer: readonly PluginReviewer[];
  };
  readonly driverPolicySchema: JSONSchema;
}

export interface PluginCatalogLink {
  readonly label: string;
  readonly url: string;
}

export interface PluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly remoteId?: string;
  readonly description?: string;
  /** Public HTTPS presentation image; may expire and is never selection state. */
  readonly logoUrl?: string;
  readonly websiteUrl?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly unavailableHelp?: PluginCatalogLink;
  readonly selectableWithoutTools?: boolean;
  readonly tools: readonly PluginToolCatalogEntry[] | null;
}

export interface PluginCatalogPage {
  readonly plugins: readonly PluginCatalogEntry[];
  readonly nextCursor: string | null;
  readonly setup?: { readonly message: string; readonly links: readonly PluginCatalogLink[] };
}

export interface PluginRevisionState {
  readonly driver: PluginDriverIdentity;
  readonly plugins: PluginDesiredState;
}

export type PluginValidationFailure = (message: string) => never;

const PLUGIN_SCHEMA_REFS = {
  PluginApprovers: PluginApproversSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

export function normalizePluginApprovers(
  approvers: unknown,
  fail: PluginValidationFailure,
): PluginApprovers | undefined {
  if (approvers === undefined) {
    return undefined;
  }
  if (!validPluginApprovers(approvers)) {
    return fail("Agent plugin approvers are invalid.");
  }
  return immutableCopy(approvers as PluginApprovers);
}

export function validPluginApprovers(approvers: unknown): approvers is PluginApprovers | undefined {
  return approvers === undefined || Check(PLUGIN_SCHEMA_REFS, PluginApproversSchema, approvers);
}

function validPluginDriverIdentity(value: unknown): value is PluginDriverIdentity {
  if (!Check(PLUGIN_SCHEMA_REFS, PluginDriverIdentitySchema, value)) {
    return false;
  }
  const driver = value as PluginDriverIdentity;
  return isNonEmptyString(driver.id) && isNonEmptyString(driver.implementation);
}

export function normalizePluginDesiredState(
  plugins: unknown,
  fail: PluginValidationFailure,
): PluginDesiredState | undefined {
  if (plugins === undefined) {
    return undefined;
  }
  if (!Check(PLUGIN_SCHEMA_REFS, PluginDesiredStateSchema, plugins)) {
    return fail("Agent plugin selections are invalid.");
  }
  return immutableCopy(plugins as PluginDesiredState);
}

export function validPluginRevisionState(value: unknown): value is PluginRevisionState | undefined {
  if (value === undefined) {
    return true;
  }
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).some((key) => key !== "driver" && key !== "plugins")
  ) {
    return false;
  }
  if (!validPluginDriverIdentity(record.driver) || record.plugins === undefined) {
    return false;
  }
  try {
    normalizePluginDesiredState(record.plugins, (message) => {
      throw new Error(message);
    });
  } catch {
    return false;
  }
  return true;
}

export interface Configuration extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: ConfigurationKind;
  readonly generation: number;
  readonly values: OpenClawConfigurationDocument;
  readonly secretBindings?: SecretBindings;
  readonly createdAt: string;
}

export interface ConfigurationReference extends Scope {
  readonly id: string;
  readonly namespaceId: string;
}

export interface ServiceAccountCredential {
  readonly kind: "api_key" | "access_token" | "oauth_access_token";
  readonly secretRef: {
    readonly name: string;
    readonly key: string;
  };
}

export interface ServiceAccount extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly credential?: ServiceAccountCredential;
}

export type AgentDesiredRuntimeState = "running" | "stopped";

/**
 * `deleting` is a terminal transition: the Agent row is removed once teardown
 * succeeds, so there is no `deleted` status and no tombstone to observe.
 */
export type AgentStatus = "active" | "deleting";
export interface Agent extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly desiredRuntimeState: AgentDesiredRuntimeState;
  readonly status: AgentStatus;
  readonly configurationId: string;
  readonly backendId: BackendRef;
  readonly harnessAuth: HarnessAuthBinding | null;
  readonly credentialSources?: readonly AgentCredentialSourceBinding[];
  readonly executionMode: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly pluginApprovers?: PluginApprovers;
  readonly repositoryBindings?: readonly RepositoryBindingSelection[];
  readonly repositoryAccess?: RepositoryAccess;
  readonly servicePrincipalId: string;
  readonly activeRevisionId?: string;
  readonly createdAt: string;
}

/** Browsing failures never stand in for an empty or deployable configuration. */
export interface ConfigurationReadError {
  readonly code: "SAVED_CONFIGURATION_UNREADABLE";
  readonly field:
    | "plugins"
    | "pluginApprovers"
    | "repositoryBindings"
    | "repositoryAccess"
    | "harnessAuth"
    | "credentialSources"
    | "secretBindings"
    | "repositoryCredentials"
    | "configuration";
}

export type AgentMetadata = Omit<
  Agent,
  | "plugins"
  | "pluginApprovers"
  | "repositoryBindings"
  | "repositoryAccess"
  | "harnessAuth"
  | "credentialSources"
>;

export type AgentRead =
  Agent | (AgentMetadata & { readonly configurationReadError: ConfigurationReadError });

export interface InstallationDeploymentInventoryAgent {
  readonly id: string;
  readonly status: AgentStatus;
  readonly desiredRuntimeState: AgentDesiredRuntimeState;
  readonly executionMode: HarnessExecutionMode;
  readonly activeRevisionId?: string;
  readonly deploymentInProgress: boolean;
}

export interface InstallationDeploymentInventoryNamespace {
  readonly id: string;
  readonly status: NamespaceStatus;
  readonly agents: readonly InstallationDeploymentInventoryAgent[];
}

export interface InstallationDeploymentInventory {
  readonly installationId: string;
  readonly namespaces: readonly InstallationDeploymentInventoryNamespace[];
}

export interface HarnessDescriptor {
  readonly id: string;
  readonly version: string;
}

export interface RevisionHarnessDescriptor extends HarnessDescriptor {
  readonly mode: HarnessExecutionMode;
}

export interface AgentRevision extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly backendId: BackendRef;
  readonly configurationId: string;
  readonly configurationKind: ConfigurationKind;
  readonly configurationGeneration: number;
  readonly configuration: OpenClawConfigurationDocument;
  readonly harness: RevisionHarnessDescriptor;
  readonly compute: {
    readonly id: string;
    readonly implementation: string;
  };
  readonly sandboxDriverId?: string;
  readonly secretDriverId?: string;
  readonly secretBindings?: SecretBindings;
  readonly plugins?: PluginRevisionState;
  readonly pluginApprovers?: PluginApprovers;
  readonly repositoryCredentials?: RepositoryRevisionState;
  readonly harnessAuth: HarnessAuthSnapshot;
  readonly credentialSources?: readonly CredentialSourceSnapshot[];
  readonly servicePrincipalId: string;
  readonly createdAt: string;
}

export type AgentRevisionMetadata = Pick<
  AgentRevision,
  "id" | "namespaceId" | "agentId" | "revision" | "backendId" | "createdAt"
>;

export type AgentRevisionRead =
  | AgentRevision
  | (AgentRevisionMetadata & { readonly configurationReadError: ConfigurationReadError });

export function freezeAgentRevision(revision: AgentRevision): Readonly<AgentRevision> {
  return Object.freeze({
    ...revision,
    configuration: immutableCopy(revision.configuration),
    ...(revision.secretBindings === undefined
      ? {}
      : { secretBindings: immutableCopy(revision.secretBindings) }),
    ...(revision.plugins === undefined ? {} : { plugins: immutableCopy(revision.plugins) }),
    ...(revision.pluginApprovers === undefined
      ? {}
      : { pluginApprovers: immutableCopy(revision.pluginApprovers) }),
    ...(revision.repositoryCredentials === undefined
      ? {}
      : { repositoryCredentials: immutableCopy(revision.repositoryCredentials) }),
    harness: Object.freeze({ ...revision.harness }),
    compute: Object.freeze({ ...revision.compute }),
    harnessAuth: immutableCopy(revision.harnessAuth),
    ...(revision.credentialSources === undefined
      ? {}
      : { credentialSources: immutableCopy(revision.credentialSources) }),
  });
}

export type IdentityKind = "principal" | "service_principal";

export interface Principal extends Scope {
  readonly id: string;
  readonly kind: "principal";
  readonly namespaceId?: never;
  readonly issuer: string;
  readonly subject: string;
}

export interface ServicePrincipal extends Scope {
  readonly id: string;
  readonly kind: "service_principal";
  readonly namespaceId?: string;
  readonly agentId?: string;
}

export type Identity = Principal | ServicePrincipal;

/**
 * `read_logs` delegates reading an Agent's runtime log text without `administer`.
 * No action implies another.
 */
export const PERMISSION_ACTIONS = Object.freeze([
  "create",
  "read",
  "update",
  "delete",
  "deploy",
  "operate",
  "administer",
  "read_logs",
] as const);

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * The actions some platform operation checks for each resource kind (the per-kind table in
 * docs/reference/cheatsheets/permissions.md). A Permission outside this table grants nothing,
 * so Namespace Role writes refuse it.
 */
export const SUPPORTED_PERMISSION_ACTIONS: Readonly<
  Record<ResourceKind, readonly PermissionAction[]>
> = Object.freeze({
  installation: Object.freeze(["read", "administer"] as const),
  namespace: Object.freeze(["create", "read", "delete"] as const),
  configuration: Object.freeze(["create", "read", "update", "delete"] as const),
  preset: Object.freeze(["create", "read", "update", "delete"] as const),
  service_account: Object.freeze(["create", "read", "update", "delete"] as const),
  secret: Object.freeze(["create", "read", "update", "delete", "operate"] as const),
  credential_source: Object.freeze(["create", "read", "update", "delete", "operate"] as const),
  agent: Object.freeze([
    "create",
    "read",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ] as const),
  agent_revision: Object.freeze(["read"] as const),
});

export function isSupportedPermission(permission: Readonly<Permission>): boolean {
  return SUPPORTED_PERMISSION_ACTIONS[permission.resourceKind].includes(permission.action);
}

export interface Permission {
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
}

export interface Role extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export interface Group extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly name: string;
}

export interface GroupMembership extends Scope {
  readonly namespaceId?: string;
  readonly groupId: string;
  readonly principalId: string;
}

export type AccessBindingSubjectKind = "identity" | "group";

export interface AccessBinding extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly subjectKind: AccessBindingSubjectKind;
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind?: ResourceKind;
  readonly resourceId?: string;
}

export interface Restriction extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly resourceId?: string;
  readonly effect: "deny";
}

export interface AuthorizationRequest {
  readonly principalId: string;
  readonly action: PermissionAction;
  readonly resource: ResourceRef;
}

/** Asks whether one identity already holds every grant of another identity. */
export interface IdentityAccessCoverageRequest {
  readonly principalId: string;
  readonly targetIdentityId: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly driverId: string;
  readonly evidence: AuthorizationEvidence;
}

export interface AuthorizationEvidence {
  readonly identityId?: string;
  readonly groupIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly restrictionIds: readonly string[];
}

export type IdentityLookup = Scope &
  (
    | { readonly issuer: string; readonly subject: string; readonly servicePrincipalId?: never }
    // Supplied only after credential verification or authorized credential management.
    | { readonly servicePrincipalId: string; readonly issuer?: never; readonly subject?: never }
  );

/** `access` records an audited read, such as viewing or downloading runtime log text. */
export type AuditEventKind = "bootstrap" | "mutation" | "access" | "authorization_denial";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEvent extends Scope {
  readonly id: string;
  readonly installationId: string;
  readonly namespaceId?: string;
  readonly occurredAt: string;
  readonly kind: AuditEventKind;
  readonly actorId: string;
  readonly schemaVersion?: number;
  readonly source?: "occ";
  readonly requestId?: string;
  readonly admissionDecisionId?: string;
  readonly actor?: {
    readonly principalId?: string;
    readonly id?: string;
    readonly kind?: IdentityKind;
    readonly issuer?: string;
    readonly subject?: string;
    readonly unresolved?: true;
  };
  readonly action: string;
  readonly resource: ResourceRef;
  readonly iamDriverId?: string;
  readonly authorization?: AuthorizationRequest;
  readonly decisionReason?: string;
  readonly reasonCode?: string;
  readonly outcome: AuditOutcome;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Driver {
  readonly id: string;
  readonly capability: DriverCapability;
  readonly implementation: string;
  readonly computeLifecycleHooks?: ComputeLifecycleHooks;
}

export interface WorkloadLaunchContext {
  environment: Record<string, string>;
}

export type KubernetesNamespacedResource = Readonly<Record<string, unknown>>;

export interface SandboxWorkspaceMount {
  readonly claimName: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}

export type SandboxEnvironmentVariable =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly valueFrom: {
        readonly secretKeyRef: { readonly name: string; readonly key: string };
      };
    };

export interface SandboxWorkloadFile {
  /** Safe logical name; the Sandbox implementation selects the absolute workload path. */
  readonly name: string;
  /** Immutable, non-secret UTF-8 content admitted with the revision. */
  readonly content: string;
  /** Environment variable through which the workload opens the implementation-selected path. */
  readonly environmentVariable: string;
}

export interface SandboxWorkloadIdentity {
  readonly serviceAccountName: string;
  readonly token: {
    readonly audience: string;
    readonly expirationSeconds: number;
    readonly mountPath: string;
    readonly path: string;
    readonly readOnly: true;
  };
}

export interface HarnessWorkloadRequirements {
  readonly loginMode: HarnessAuthBinding["method"] | CredentialSourceLoginMode;
  readonly image: string;
  readonly command: readonly string[];
  /** Optional identity that a Sandbox must preserve in full or reject before provisioning. */
  readonly workloadIdentity?: SandboxWorkloadIdentity;
  readonly workspaceMounts: readonly SandboxWorkspaceMount[];
  /** Initialize the mounted workspace privately before starting the Harness; never copy file contents here. */
  readonly workspaceSetup?: {
    readonly id: string;
    readonly defaultsId?: string;
    /** Agent-owned, same-Namespace setup delivery; the Sandbox consumes only this exact key. */
    readonly secretKeyRef: { readonly name: string; readonly key: string };
  };
  readonly environment: readonly SandboxEnvironmentVariable[];
  readonly files: readonly SandboxWorkloadFile[];
  /** Credential Gateway attachments the paired Sandbox must consume in full. */
  readonly credentialAttachments: readonly CredentialSourceAttachment[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface SandboxResourceRef {
  readonly namespaceName: string;
  readonly resourceName: string;
  readonly agentId: string;
  readonly revisionId: string;
}

/** Provider-owned endpoint through which the Agent Gateway reaches its dedicated Harness. */
export interface SandboxHarnessEndpoint {
  readonly url: string;
  /** Provider-local workspace root served by the Harness workspace node. */
  readonly workspaceRoot?: string;
  /** Required for Codex: provider-created private hook directory outside its workspace. */
  readonly nativeHookCredentialDirectory?: string;
}

export interface SandboxNamespaceContext {
  readonly namespace: Readonly<Namespace>;
  readonly kubernetes: unknown;
  readonly signal: AbortSignal;
}

export interface SandboxHarnessContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  readonly requirements: HarnessWorkloadRequirements;
}

export interface SandboxHarnessStatusContext extends SandboxHarnessContext {
  /** The Agent transport token the Agent Gateway presents to the Harness. */
  readonly transportToken: string;
}

/**
 * What the provider-owned Harness answers at its endpoint. `failed` carries the Harness's own
 * held startup failure, unvalidated; Compute validates it like a Compute-owned status port.
 */
export type SandboxHarnessStatus =
  | { readonly state: "starting" }
  | { readonly state: "serving" }
  | { readonly state: "failed"; readonly runtimeFailure: unknown };

export interface ComputeLifecycleHooks {
  afterNamespacePrepared?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
  beforeWorkloadStart?(
    revision: Readonly<AgentRevision>,
    launch: WorkloadLaunchContext,
    signal: AbortSignal,
  ): Promise<void>;
  beforeWorkloadStop?(revision: Readonly<AgentRevision>, signal: AbortSignal): Promise<void>;
  beforeNamespaceDelete?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
}

export type JSONSchema = Readonly<Record<string, unknown>>;

export interface DriverImplementation {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(configuration: unknown): void;
}

export interface IAMDriver extends Driver {
  readonly capability: "iam";
  readonly namespacePolicyTransaction?: "platform-unit-of-work";
  lookupIdentity(input: IdentityLookup): Promise<Identity | undefined>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  /**
   * True only when `principalId` holds every grant of `targetIdentityId` at the
   * same or a broader scope. Credential issuance for another identity requires it;
   * a Driver without it cannot issue such credentials.
   */
  coversIdentityAccess?(request: IdentityAccessCoverageRequest): Promise<boolean>;
  listNamespaceRoles?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<Role>[]>;
  getNamespaceRole?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role> | undefined>;
  createNamespaceRole?(
    context: IAMPolicyManagementContext,
    input: IAMManagedRoleInput,
  ): Promise<Readonly<Role>>;
  deleteNamespaceRole?(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    roleId: string,
  ): Promise<boolean>;
  listNamespaceAccessBindings?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]>;
  getNamespaceAccessBinding?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  createNamespaceAccessBinding?(
    context: IAMPolicyManagementContext,
    input: IAMManagedAccessBindingInput,
  ): Promise<Readonly<AccessBinding>>;
  deleteNamespaceAccessBinding?(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<boolean>;
  listNamespaceServicePrincipals?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]>;
  getNamespaceServicePrincipal?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal> | undefined>;
  createNamespaceServicePrincipal?(
    context: IAMPolicyManagementContext,
    input: IAMManagedServicePrincipalInput,
  ): Promise<Readonly<ServicePrincipal>>;
}

export interface IAMPolicyReadRepository {
  listRoles(namespaceId: string): Promise<readonly Readonly<Role>[]>;
  getRole(namespaceId: string, roleId: string): Promise<Readonly<Role> | undefined>;
  listAccessBindings(namespaceId: string): Promise<readonly Readonly<AccessBinding>[]>;
  getAccessBinding(
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  /**
   * Lists the deny Restrictions on these exact resources in every scope (Installation and
   * Namespace), as deleting the resources removes them. A store that keeps no Restrictions
   * (the in-memory one; its IAM driver seed holds them and no deletion removes them)
   * returns none.
   */
  listRestrictionsTargeting(
    resourceKind: ResourceKind,
    resourceIds: readonly string[],
  ): Promise<readonly Readonly<Restriction>[]>;
  /** Non-Agent ServicePrincipals of the exact Namespace; Agent identities are excluded. */
  listServicePrincipals(namespaceId: string): Promise<readonly Readonly<ServicePrincipal>[]>;
  getServicePrincipal(
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal> | undefined>;
}

export interface IAMPolicyRepository extends IAMPolicyReadRepository {
  createRole(role: Role): Promise<Readonly<Role>>;
  deleteRole(namespaceId: string, roleId: string): Promise<boolean>;
  createAccessBinding(binding: AccessBinding): Promise<Readonly<AccessBinding>>;
  deleteAccessBinding(namespaceId: string, bindingId: string): Promise<boolean>;
  createServicePrincipal(servicePrincipal: ServicePrincipal): Promise<Readonly<ServicePrincipal>>;
}

export interface IAMPolicyReadContext {
  readonly policy: IAMPolicyReadRepository;
}

export interface IAMPolicyManagementContext {
  readonly policy: IAMPolicyRepository;
}

export type ManagedIAMResourceKind =
  | "namespace"
  | "agent"
  | "agent_revision"
  | "configuration"
  | "credential_source"
  | "preset"
  | "secret"
  | "service_account";

export interface IAMManagedRoleInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export interface IAMManagedAccessBindingInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly subjectKind: "identity";
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind: ManagedIAMResourceKind;
  readonly resourceId: string;
}

/** A non-Agent automation identity fixed to one Namespace; it carries no grant. */
export interface IAMManagedServicePrincipalInput {
  readonly id: string;
  readonly namespaceId: string;
}

export interface ServiceAccountDriver extends Driver {
  readonly capability: "service_account";
  create(account: ServiceAccount): Promise<void>;
  createCredential(account: ServiceAccount): Promise<ServiceAccountCredential>;
  delete(account: ServiceAccount): Promise<void>;
}

export interface SecretDriver extends Driver {
  readonly capability: "secret";
  create(identity: SecretIdentity, value: string): Promise<SecretBackendRef>;
  update(secret: Secret, value: string): Promise<void>;
  /** Replace an exact current value atomically; used to fence device authorization exchanges. */
  compareAndSwap?(secret: Secret, expected: string, value: string): Promise<boolean>;
  delete(secret: Secret): Promise<void>;
  /** Verify live exact ownership and return only safe projection identity. */
  resolve(secret: Secret): Promise<SecretBackendRef>;
  /** Verify live ownership and use the current value only within a transient server-side operation. */
  withValue?<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T>;
}

export interface CredentialGatewayContext {
  readonly signal: AbortSignal;
}

export interface CredentialSourceContext extends CredentialGatewayContext {
  /** Resolved by Compute: `name` is the runtime placement shared with the paired Sandbox. */
  readonly namespace: Readonly<Namespace>;
  readonly source: Readonly<CredentialSource>;
}

export interface CredentialSourceInput {
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  /** Resolved secret values keyed by catalog field; never persisted by OCC. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface CredentialSourceStatus {
  readonly state: "ready" | "pending" | "failed" | "absent";
  readonly reason?: string;
  /** Present for a `refresh` type: the Credential Refresh Driver's view of its tokens. */
  readonly refresh?: CredentialRefreshStatus;
}

export interface CredentialRevisionContext extends CredentialGatewayContext {
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  readonly sources: readonly Readonly<CredentialSource>[];
  /** The paired Sandbox's workload, once provisioned; required for attachment status. */
  readonly sandbox?: SandboxResourceRef;
}

/** Names the one source to revoke from one provisioned revision Sandbox. */
export interface CredentialWithdrawalContext extends CredentialGatewayContext {
  /** Resolved by Compute: `name` is the runtime placement shared with the paired Sandbox. */
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  /** The Sandbox provisioning created for `revision`. */
  readonly sandbox: SandboxResourceRef;
  readonly sourceId: string;
  /**
   * Re-checks a withdrawal already recorded `revoked`: the gateway detaches again only when
   * the Sandbox still lists the source, and otherwise reports `revoked` without a mutation.
   */
  readonly recheck?: boolean;
}

/** Selected identity metadata owned by the trusted Credential Gateway, never caller claims. */
export interface ExternalChatgptAuth {
  /** Placeholder only: copy unchanged for the paired Sandbox to resolve; never a real token. */
  readonly accessTokenPlaceholder: string;
  readonly accountId: string;
  readonly planType: string;
  readonly userId?: string;
  /** Membership identity from the access token, distinct from the global user ID. */
  readonly accountUserId?: string;
  readonly email?: string;
  readonly isFedramp?: boolean;
}

/** Gateway attachment whose opaque grant ref only the paired SandboxDriver consumes. */
export interface CredentialSourceAttachment {
  readonly sourceId: string;
  readonly ref: string;
  /** External Codex authentication carries no refresh token into the workload. */
  readonly externalChatgptAuth?: ExternalChatgptAuth;
}

export interface CredentialAttachmentStatus {
  readonly sourceId: string;
  readonly state: "ready" | "pending" | "withheld" | "failed" | "revoked" | "absent";
  readonly reason?: string;
}

/** Holds credential sources and applies them outside the Agent workload. */
export interface CredentialGatewayDriver extends Driver {
  readonly capability: "credential_gateway";
  /** The token service may refresh to ensure usability; refresh material stays there. Tokens exist only during the callback. */
  withSourceToken?<T>(
    context: CredentialSourceContext,
    use: (token: CredentialSourceToken) => Promise<T>,
  ): Promise<T>;
  listSourceTypes(context: CredentialGatewayContext): Promise<readonly CredentialSourceType[]>;
  registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus>;
  /** Idempotent; an already-absent source counts as removed. */
  removeSource(context: CredentialSourceContext): Promise<void>;
  /** Returns exactly one attachment per bound source, or throws. */
  attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]>;
  attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]>;
  /**
   * Returns `revoked` only on gateway evidence that the revision's placeholders no longer
   * resolve, `absent` when the Sandbox no longer exists, and `pending` otherwise.
   */
  withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus>;
}

export interface CredentialRefreshInput {
  readonly config: Readonly<Record<string, string>>;
  /** Resolved refresh material keyed by catalog field; never persisted by OCC. */
  readonly secrets: Readonly<Record<string, string>>;
  /** A UUID, stable per source and configuration attempt, so a replay is not applied twice. */
  readonly requestId: string;
}

export interface CredentialRefreshStatus {
  readonly state: "pending" | "ready" | "failed";
  readonly expiresAt?: string;
  readonly nextRefreshAt?: string;
  readonly lastRefreshAt?: string;
  /** Implementation-owned identifier, never provider-controlled text. */
  readonly failureCode?: string;
  readonly recoveryAction?: "retry" | "reauthorize" | "fix_configuration" | "investigate";
}

/**
 * Mints and re-mints tokens for the paired Credential Gateway's `refresh` sources. OCC drives
 * only setup, incident rotation, and status; the implementation refreshes before expiry.
 */
export interface CredentialRefreshDriver extends Driver {
  readonly capability: "credential_refresh";
  /** Owns the private device exchange; OCC retains only an opaque login handle. */
  startDeviceAuthorization?(
    context: CredentialSourceContext,
  ): Promise<CredentialSourceDeviceAuthorization>;
  /** Ready means refresh custody and the first managed token are established; never returns tokens. */
  pollDeviceAuthorization?(
    context: CredentialSourceContext,
    privateState: string,
  ): Promise<CredentialSourceDeviceAuthorizationResult>;
  /** Replaces the source's refresh material; replaying a successful `requestId` is a no-op. */
  configureRefresh(
    context: CredentialSourceContext,
    input: CredentialRefreshInput,
  ): Promise<CredentialRefreshStatus>;
  /** Forces one refresh; it does not revoke the previous token at the issuer. */
  rotate(context: CredentialSourceContext, requestId: string): Promise<CredentialRefreshStatus>;
  refreshStatus(context: CredentialSourceContext): Promise<CredentialRefreshStatus>;
  /** Idempotent; deletes the stored refresh material. */
  removeRefresh(context: CredentialSourceContext): Promise<void>;
}

export interface SandboxDriver extends Driver {
  readonly capability: "sandbox";
  /** One or more distinct containment facets implemented by this driver. */
  readonly facets: readonly SandboxFacet[];
  configureAgent?(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
  ): OpenClawConfigurationDocument;
  ensureNamespace?(context: SandboxNamespaceContext): Promise<void>;
  provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>;
  /**
   * Returns the provider-owned transport for the exact provisioned Harness. When present,
   * Compute must route the Agent Gateway through this endpoint instead of its native Harness
   * Service. Implementations must fail closed until the endpoint is observable and exact.
   */
  harnessEndpoint?(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint>;
  /**
   * Observes the provider-owned Harness through the endpoint `harnessEndpoint` returns, with the
   * Agent transport token. Compute treats only `serving` as ready and fails the revision with a
   * valid held `runtimeFailure`. `serving` requires an authenticated transport handshake.
   */
  harnessStatus?(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus>;
  /**
   * The exact Sandbox `provisionHarness` creates for this revision, derived without effects.
   * Required to revoke credentials from a running revision.
   */
  harnessResource?(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef;
  /** Required for revision stop, retirement, and Namespace cleanup, independent of Harness ownership. */
  cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void>;
  /**
   * Bounded raw log lines of the revision's Sandbox. Read-only: an implementation must
   * reach its runtime through a read-only interface. The Sandbox name is the Driver's own
   * derivation from the revision; callers never name it.
   */
  readSandboxLogs?(
    context: SandboxLogContext,
    request: SandboxLogRequest,
  ): Promise<SandboxLogChunk>;
}

export interface PluginDriverContext {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
  readonly harness: RevisionHarnessDescriptor;
  readonly configuration: Readonly<OpenClawConfigurationDocument>;
  readonly signal: AbortSignal;
}

/** Short-lived source authentication for an authorized control-plane operation. */
export interface CredentialSourceToken {
  readonly accessToken: string;
  /** Trusted provider identity, never browser-supplied metadata. */
  readonly accountId?: string;
  readonly isFedramp?: boolean;
}

export interface PluginDiscoveryAuthentication {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly isFedramp?: boolean;
}

export interface PluginDriver extends Driver {
  readonly capability: "plugin";
  readonly policyCapabilities: PluginPolicyCapabilities;
  /** Checks policy support without installing plugins or performing authenticated discovery. */
  validatePolicies(selections: PluginDesiredState, defaultApprovers?: PluginApprovers): void;
  listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]>;
  /** Pre-Agent discovery defaults to requiring a transient credential. Results are not persisted. */
  readonly discoveryCredential?: "required" | "none";
  discoverCatalog?(
    input: PluginDiscoveryAuthentication & { readonly cursor?: string; readonly q?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage>;
  getCatalogPlugin?(
    input: PluginDiscoveryAuthentication & { readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry>;
}

export interface ChannelDirectoryLookupInput {
  readonly token: string;
  readonly kind: "users" | "channels";
  readonly query?: string;
  readonly cursor?: string;
  readonly ids?: readonly string[];
}

export interface ChannelDirectoryResult {
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly name: string;
    readonly displayName?: string;
  }[];
  readonly nextCursor?: string;
  readonly complete: boolean;
}

/** Values stay inside the Secret Driver callback; adapters own native field semantics. */
export type ChannelCredentialReader = (
  binding: string,
  path: string,
  validate: (value: string) => Promise<void>,
) => Promise<void>;

export interface ChannelDriver extends Driver {
  readonly capability: "channel";
  validateCredentials?(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void>;
  lookupDirectory(
    input: ChannelDirectoryLookupInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult>;
}

export type NamespaceLifecycleFailure = "retryable" | "permanent";

export interface NamespaceEnsureResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceReady: boolean;
  readonly failure?: NamespaceLifecycleFailure;
  /**
   * Optional bounded, non-secret operator explanation of `failure`, at most 256 printable
   * characters. It names only this Namespace's own placement, never another tenant's
   * identifiers or marker values. The worker logs it; status and audit keep only `failure`.
   * The log keeps only letters, digits, spaces and `. _ : / @ -`; other text is dropped.
   */
  readonly reason?: string;
}

export interface NamespaceDeleteResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceDeleted: boolean;
  readonly failure?: NamespaceLifecycleFailure;
}

export interface PluginDeploymentWarning {
  readonly code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED";
  readonly pluginId: string;
}

/**
 * Why a runtime startup model check failed, classified by the runtime from a
 * closed vocabulary. It never carries native output, provider responses or
 * credentials: `detail` is a short token such as `exit-1` or `rate_limit`.
 */
export interface RuntimeFailureCause {
  readonly kind: "PROCESS_EXIT" | "PROBE_STATUS" | "INVALID_OUTPUT" | "WRAPPER_ERROR";
  readonly detail?: string;
}

export interface RuntimeFailureEvidence {
  readonly component: string;
  readonly check: string;
  readonly checkedAt: string;
  readonly code: string;
  /** Present only with code MODEL_PROBE_FAILED. */
  readonly cause?: RuntimeFailureCause;
}

/**
 * Why an unready revision is still pending, when Compute knows: its Pods cannot be
 * scheduled, or its workloads are ready but the workspace node has not connected.
 */
export type ComputePendingReason = "WORKLOAD_UNSCHEDULABLE" | "WORKSPACE_NODE_PENDING";

export interface ComputeReadiness extends Scope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly ready: boolean;
  readonly warnings?: readonly PluginDeploymentWarning[];
  readonly runtimeFailure?: RuntimeFailureEvidence;
  /** Only on an unready observation; the worker ignores unknown values. */
  readonly pendingReason?: ComputePendingReason;
  readonly repositoryCredentialMaterialMissing?: readonly RepositoryCredentialMaterialRef[];
}

/** Safe operational context for one failed Compute preparation attempt. */
export interface ComputePrepareRevisionFailureDiagnostic {
  /** Stable Driver-owned reason code; never a provider response or credential value. */
  readonly code: string;
  /** Stable preparation stage that identifies the failed reconciliation boundary. */
  readonly stage: string;
  /** Reviewed error classification, not an arbitrary constructor or provider value. */
  readonly errorClass?: string;
  /** Optional bounded, non-secret operator explanation. */
  readonly message?: string;
  /** Optional dependency status code when it is safe and meaningful. */
  readonly status?: number;
}

/** Authorized, server-admitted resource identities for an Agent-owned runtime. */
export interface ComputeAgentBinding {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
}

export interface ComputeAgentProvisioningInput {
  readonly executionMode: HarnessExecutionMode;
  readonly configuration: Readonly<OpenClawConfigurationDocument>;
}

export interface ComputeAgentProvisioningCapabilities {
  readonly executionModes: readonly HarnessExecutionMode[];
}

export type AgentRuntimeCredentialsInput = Readonly<Record<never, never>>;

export interface AgentRuntimeCredentialStatus {
  readonly transportConfigured: boolean;
}

export type RuntimeDiagnosticState = "succeeded" | "failed" | "unknown";

export interface RuntimeDiagnosticCheck {
  readonly component: string;
  readonly check: string;
  readonly state: RuntimeDiagnosticState;
  readonly checkedAt: string | null;
  readonly code?: string;
}

export interface AgentDeploymentDiagnostics {
  readonly revisionId: string;
  readonly observedAt: string;
  readonly checks: readonly RuntimeDiagnosticCheck[];
}

export interface ComputeAgentRevisionBinding extends ComputeAgentBinding {
  readonly revision: Readonly<AgentRevision>;
}

/**
 * Runtime log classes. OCC classifies every record; a source never sets the class.
 * `content` (message text, prompts, tool output) is reserved and has no producer.
 */
export type RuntimeLogContentClass = "operational" | "activity" | "content";
/** Container sources are Pods the Compute Driver lists; `sandbox` is the Sandbox Driver's log. */
export type RuntimeLogContainerSourceId = "gateway" | "agent";
export type RuntimeLogSourceId = RuntimeLogContainerSourceId | "sandbox";
export type RuntimeLogLevel = "error" | "warn" | "info" | "debug" | "unknown";
export type RuntimeLogKind = "wrapper" | "openclaw" | "codex" | "sandbox" | "text";
export type RuntimeLogGapReason =
  "stream_replaced" | "window_exceeded" | "cursor_expired" | "truncated" | "buffer_lost";
export type RuntimeLogWithheldReason = "unrecognised_structured" | "oversized" | "malformed";

/** One container instance or sandbox, keyed on server-observed identity only. */
export interface RuntimeLogStream {
  readonly source: RuntimeLogSourceId;
  readonly pod?: string;
  readonly podUid?: string;
  readonly container?: string;
  readonly restartCount?: number;
  /** Sandbox source: the OCC-derived Sandbox name of this revision. */
  readonly sandbox?: string;
}

export type RuntimeLogRecord =
  | {
      readonly type: "line";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly contentClass: RuntimeLogContentClass;
      readonly kind: RuntimeLogKind;
      readonly level: RuntimeLogLevel;
      readonly message: string;
      readonly subsystem?: string;
      readonly fields?: Readonly<Record<string, string | number | boolean>>;
      readonly truncated?: true;
    }
  | {
      readonly type: "gap";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly reason: RuntimeLogGapReason;
      readonly remedy: string;
    }
  | {
      readonly type: "withheld";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly count: number;
      readonly reason: RuntimeLogWithheldReason;
    };

export interface AgentRuntimeContainerStatus {
  readonly name: string;
  readonly state: "waiting" | "running" | "terminated" | "unknown";
  readonly reason: string | null;
  readonly ready: boolean;
  readonly restartCount: number;
  readonly startedAt: string | null;
  readonly lastTermination: {
    readonly reason: string | null;
    readonly exitCode: number | null;
    readonly finishedAt: string | null;
  } | null;
}

export interface AgentRuntimeEvent {
  readonly type: "Normal" | "Warning";
  /** Container the Event concerns (from `involvedObject.fieldPath`), or null for the Pod. */
  readonly container: string | null;
  readonly reason: string;
  readonly message: string;
  readonly count: number;
  readonly lastObservedAt: string | null;
}

export interface AgentRuntimePodStatus {
  readonly role: RuntimeLogContainerSourceId;
  /** `execution` only when the Pod runs on a separately configured execution cluster. */
  readonly cluster: "control" | "execution";
  readonly name: string;
  readonly uid: string;
  readonly phase: string;
  readonly ready: boolean;
  readonly createdAt: string | null;
  readonly containers: readonly AgentRuntimeContainerStatus[];
  /** Pod-scoped Events, newest first, at most 100. */
  readonly events: readonly AgentRuntimeEvent[];
}

export interface AgentRuntimeLogSource {
  readonly id: RuntimeLogSourceId;
  /** `sandbox` sources list no Pods; OCC derives the Sandbox from the revision. */
  readonly kind: "container" | "sandbox";
  readonly pods: readonly {
    readonly name: string;
    readonly uid: string;
    readonly container: string;
    readonly restartCount: number;
  }[];
  readonly available: boolean;
  readonly unavailableCode?: "NO_POD";
  /** Fixed notice for loss the API cannot observe. */
  readonly retention: string;
}

export interface AgentRuntimeDescription {
  readonly revisionId: string;
  readonly observedAt: string;
  readonly pods: readonly AgentRuntimePodStatus[];
  readonly sources: readonly AgentRuntimeLogSource[];
}

/** Narrows a description for a log read, which needs one source's Pods and no Events. */
export interface AgentRuntimeDescribeOptions {
  /** Describe only this source's Pods; other sources are omitted. */
  readonly source?: RuntimeLogContainerSourceId;
  /** `false` skips Pod Event lists; each Pod then carries no Events. */
  readonly events?: boolean;
}

export interface AgentRuntimeLogRequest {
  readonly source: RuntimeLogContainerSourceId;
  readonly pod: string;
  readonly podUid: string;
  readonly container: string;
  readonly previous: boolean;
  readonly tailLines: number;
  readonly sinceSeconds?: number;
  readonly limitBytes: number;
  readonly signal: AbortSignal;
}

/** Raw lines as the runtime wrote them; OCC classifies and redacts every line. */
export interface AgentRuntimeLogChunk {
  /** Stream identity re-read after the log read. */
  readonly stream: RuntimeLogStream;
  readonly observedAt: string;
  readonly lines: readonly { readonly time: string | null; readonly raw: string }[];
  /** The byte limit cut the output; the final line may be partial. */
  readonly truncated: boolean;
}

/** Where a Sandbox Driver finds one revision's Sandbox; the Namespace is Compute's placement. */
export interface SandboxLogContext {
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  readonly signal: AbortSignal;
}

export interface SandboxLogRequest {
  /** Most recent lines to return, 1 to 1000. */
  readonly lines: number;
  /** Only lines at or after this RFC 3339 time. */
  readonly sinceTime?: string;
}

/** One raw Sandbox log line as the Sandbox runtime reported it; OCC sanitizes every field. */
export interface SandboxLogLine {
  readonly time: string | null;
  readonly sandboxId: string;
  readonly level: string;
  readonly target: string;
  readonly message: string;
  /** Where the line was produced, for example `gateway` or `sandbox`. */
  readonly source: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Raw, bounded Sandbox log lines in chronological order. */
export interface SandboxLogChunk {
  /** The Sandbox name the Driver read; OCC checks it against the revision. */
  readonly sandbox: string;
  readonly observedAt: string;
  readonly lines: readonly SandboxLogLine[];
  /**
   * Lines the source examined before applying `sinceTime`: the requested line count
   * when the buffer held at least that many, otherwise the whole buffer.
   */
  readonly bufferTotal: number;
}

/** Observed workload image identity; missing provenance must never be inferred from a tag. */
export interface RuntimeImage {
  readonly workload: string;
  readonly container: string;
  readonly image: string;
  readonly imageId: string | null;
  readonly commit: string | null;
  readonly openclawCommit: string | null;
}

export interface ComputePreflightWarning {
  readonly code: string;
  readonly message: string;
}

export interface ComputePreflightResult {
  readonly warnings: readonly ComputePreflightWarning[];
}

export interface CredentialSourceDeviceAuthorization {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /** Opaque Refresh Driver login handle; never an access or refresh token. */
  readonly privateState: string;
}

export type CredentialSourceDeviceAuthorizationResult = { readonly status: "pending" | "ready" };

export interface ComputeDriver extends Driver {
  readonly supportsWorkspaceSetup?: true;
  readonly capability: "compute";
  /** Deployment must observe and provision Agent-owned runtime credentials before revision admission. */
  readonly requiresAgentRuntimeCredentials?: true;
  /** Default: platform admission policy. Driver ownership preserves native logging settings. */
  readonly runtimeLogging?: "platform" | "driver";
  readonly agentProvisioning?: ComputeAgentProvisioningCapabilities;
  readonly activationOrder?: "beforeCommit" | "afterCommit";
  readonly maintenanceIntervalMs?: number;
  /**
   * Opt into exclusive replacement: the worker stops all earlier revisions before
   * preparation and supersedes their reconciliation once a newer exclusive
   * revision is admitted. Recovery uses a new revision, never an older snapshot.
   * Stop must wait for resource release; repeated calls must preserve durable data.
   */
  requiresStoppedPredecessors?(revision: AgentRevision): boolean;
  getRuntimeImages?(revision: AgentRevision): Promise<readonly RuntimeImage[]>;
  /** Read-only native model discovery; supplied credentials must never be persisted. */
  discoverHarnessModels?(input: {
    readonly authMethod: "api_key" | "codex_pat";
    readonly provider: string;
    readonly apiKey: string;
  }): Promise<readonly { readonly id: string; readonly name: string }[]>;
  validateAgentProvisioning?(input: ComputeAgentProvisioningInput): void;
  /**
   * Side-effect-free deployment admission check of the caller's native gateway settings.
   * Throws ComputeGatewaySettingError, naming the setting but never its value, for a setting
   * every preparation attempt would refuse; other refusals stay with preparation.
   */
  validateGatewaySettings?(configuration: Readonly<OpenClawConfigurationDocument>): void;
  validateHarnessAuth?(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
    secretBindings?: SecretBindings,
    /** Catalog entry for a `credential_source` binding; absent for every other method. */
    credentialSourceType?: CredentialSourceType,
  ): void;
  /** Discovery availability; deployment must still validate its exact Harness. */
  validateRepositoryCredentialSupport?(sandboxDriverId?: string): void;
  validateRepositoryCredentials?(
    harness: RevisionHarnessDescriptor,
    sandboxDriverId?: string,
  ): void;
  preflight?(): Promise<void | ComputePreflightResult>;
  setLifecycleDrivers?(drivers: readonly Driver[]): void;
  bindAgent?(binding: ComputeAgentBinding): void | Promise<void>;
  getAgentRuntimeCredentialStatus?(
    binding: ComputeAgentBinding,
  ): Promise<AgentRuntimeCredentialStatus>;
  provisionAgentRuntimeCredentials?(
    binding: ComputeAgentBinding,
    input: AgentRuntimeCredentialsInput,
  ): Promise<AgentRuntimeCredentialStatus>;
  diagnoseAgentDeployment?(
    binding: ComputeAgentRevisionBinding,
  ): Promise<AgentDeploymentDiagnostics>;
  /** Read-only runtime status and log sources for one exact revision. */
  describeAgentRuntime?(
    binding: ComputeAgentRevisionBinding,
    signal: AbortSignal,
    options?: AgentRuntimeDescribeOptions,
  ): Promise<AgentRuntimeDescription>;
  /** Bounded raw container output; `request.pod` was listed by `describeAgentRuntime`. */
  readAgentRuntimeLogs?(
    binding: ComputeAgentRevisionBinding,
    request: AgentRuntimeLogRequest,
  ): Promise<AgentRuntimeLogChunk>;
  deleteAgentRuntimeCredentials?(binding: ComputeAgentBinding): Promise<void>;
  /**
   * Removes a ServiceAccount's account-owned access-token Secret. A force-delete with no
   * ServiceAccount Driver left calls it so no copy of the unrevoked token stays behind.
   */
  deleteServiceAccountCredential?(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly secretRef: ServiceAccountCredential["secretRef"];
  }): Promise<void>;
  getGatewayEndpoint?(revision: AgentRevision): string | undefined;
  ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult>;
  deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult>;
  /**
   * The Namespace as the paired Sandbox and Credential Gateway see it: `name` is this
   * Compute Driver's runtime placement. Required to register Credential Gateway sources.
   */
  resolveSandboxNamespace?(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>>;
  /**
   * Revokes `source` from the revision's paired Sandbox through the selected Credential
   * Gateway. Returns `revoked` only after the gateway confirms revocation, and `absent` when
   * the revision has no Sandbox or attachment left to revoke. Required for withdrawal.
   * `options.recheck` is passed through to the gateway's withdrawal context. Throws OCC's
   * CredentialWithdrawalRefusedError when retrying cannot help: a configuration that cannot
   * reach the revision's Sandbox, or an object the Driver does not own.
   */
  withdrawCredentialSource?(
    revision: Readonly<AgentRevision>,
    source: Readonly<CredentialSource>,
    signal: AbortSignal,
    options?: { readonly recheck?: boolean },
  ): Promise<CredentialAttachmentStatus>;
  prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness>;
  /** Maps a rejected preparation to bounded operational fields; never return raw errors. */
  describePrepareRevisionFailure?(
    error: unknown,
  ): ComputePrepareRevisionFailureDiagnostic | undefined;
  activateRevision?(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void>;
  deactivateRevision?(revision: AgentRevision): Promise<void>;
  stopRevision(revision: AgentRevision): Promise<void>;
  retireRevision(revision: AgentRevision): Promise<void>;
}

export interface ConfigurationDriver extends Driver {
  readonly capability: "configuration";
  /** Side-effect-free admission of partial native values before Preset storage. */
  validateValues?(values: OpenClawConfigurationDocument): Promise<void>;
  create(configuration: Configuration): Promise<Configuration>;
  createExact?(configuration: Configuration): Promise<Configuration>;
  inspectExact?(configuration: Configuration): Promise<Configuration | undefined>;
  read(reference: ConfigurationReference): Promise<Configuration>;
  update(configuration: Configuration): Promise<Configuration>;
  delete(reference: ConfigurationReference): Promise<void>;
  validate(configuration: Configuration): Promise<void>;
}

export { normalizeSecretBindings } from "./secret-bindings.ts";

export * from "./api/common.ts";
export * from "./api/resources.ts";
export * from "./api/routes.ts";

export {
  normalizeHarnessAuthBinding,
  harnessAuthBindingFromSnapshot,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
} from "./harness-auth.ts";

export type { Preset, PresetTemplate, PresetLaunchSettings, PresetVariable } from "./presets.ts";
export { normalizePresetTemplate } from "./presets.ts";
export {
  PRESET_JSON_MAX_BYTES,
  PresetValidationError,
  renderPresetTemplate,
  validatePresetTemplate,
  presetTemplateDefaults,
} from "./preset-variables.mjs";

export type { InitialWorkspaceFiles, WorkspaceSetup } from "./workspace-setup.ts";
export { normalizeInitialWorkspaceFiles, normalizeWorkspaceDefaultsId } from "./workspace-setup.ts";
export {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
  WORKSPACE_DEFAULTS_VERSION,
} from "./workspace-defaults.mjs";
