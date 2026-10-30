import type { ComputeAgentProvisioningCapabilities } from "./drivers/compute/index.ts";
import type { DriverCapability } from "./drivers/index.ts";
import type {
  ExecutionAdmission,
  ProtectedEgressSource,
  ProxyPlan,
} from "./drivers/credential-proxy/index.ts";

export type {
  CredentialPolicyReduction,
  CredentialPolicyObservation,
  CredentialPolicyReducer,
  CredentialPolicyWithdrawalOptions,
  EgressRef,
  EgressSourceKey,
  ExecutionAdmission,
  StaticEgressSource,
  CredentialReadLifetime,
  CredentialInputRead,
  VersionedSecretValue,
  EgressExecution,
  InferenceGrant,
  EgressBinding,
  EgressRoute,
  ProxyPlan,
  RepositoryGitDeliveryProfile,
  RepositoryGitRecipient,
  EgressInstallation,
  EgressRequest,
  InferenceOperation,
  StaticMaterialEvidence,
  ProtectedEgressSource,
  EgressOperation,
  EgressMaterialEvidence,
  EgressSelectionEvidence,
  EgressRefusal,
  EgressResponse,
  ProxyWiring,
  ProxyRevisionContext,
  CredentialProviderDefinition,
  CredentialSourceControl,
  CredentialProxyDriver,
} from "./drivers/credential-proxy/index.ts";
export type {
  CredentialProxyBinding,
  CredentialProxyExchange,
  EgressPeer,
  CapturedEgressUse,
  EgressExchangeOwner,
  AcceptedEgressAssociation,
  AuthorizedSend,
  EgressResolution,
  EgressSendDecision,
  EgressStreamProgress,
  EgressStreamLease,
} from "./credential-proxy-exchange.ts";
export { egressAssociationInstallation } from "./credential-proxy-exchange.ts";
export type {
  PreparedTokenGrant,
  PreparedTokenSource,
  PreparedTokenSelection,
  PreparedTokenEvidence,
  PreparedTokenCurrentProof,
  PreparedTokenIssuer,
  PreparedTokenService,
} from "./prepared-token.ts";
export {
  preparedGitHubType,
  preparedGitHubProviderRef,
  preparedGitHubSourceFromRoute,
  githubMetadataGrant,
} from "./prepared-github-egress.ts";
export type {
  GitHubMetadataGrant,
  PreparedGitHubEgressSource,
  PreparedGitHubUseRequest,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubUseResponse,
  PreparedGitHubPullScope,
  PreparedGitHubPullProjection,
  PreparedGitHubPullResult,
} from "./prepared-github-egress.ts";
export {
  credentialFreeMetadataType,
  credentialFreeProviderRef,
  credentialFreeMetadataGrant,
} from "./credential-free-metadata.ts";
export type {
  CredentialFreeMetadataGrant,
  CredentialFreeEgressSource,
  NoMaterialSelection,
} from "./credential-free-metadata.ts";
export {
  assertExecutionAdmission,
  assertExecutionReleaseAllowed,
  repositoryGitRecipientFields,
  validRepositoryGitRecipient,
  repositoryGitAuthorization,
  repositoryGitProfileAvailable,
  protectedRepositoryGitAdmission,
} from "./drivers/credential-proxy/index.ts";

export type {
  ConfigurationDefinition,
  ConfigurationResult,
  ConfigurationContribution,
  DriverConfigurationDescriptor,
  ConfigurationContext,
} from "./configuration-definition.ts";
export {
  ConfigurationValidationError,
  assertConfigurationSchema,
  validateConfiguration,
  requireConfiguration,
  serializeStartupConfiguration,
} from "./configuration-definition.ts";
export type { SandboxPolicyDecision } from "./sandbox-policy.ts";
export type { SandboxPolicyViewWire } from "./api/sandbox-policy.ts";
export { SandboxPolicyDecisionSchema, validSandboxPolicyDecision } from "./sandbox-policy.ts";
import type { SandboxPolicySnapshot } from "./sandbox-policy.ts";

export type {
  SandboxNetworkGrant,
  SandboxPolicy,
  SandboxPolicySnapshot,
  SandboxPolicyApplication,
  SandboxPolicyObservation,
  SandboxPolicyRecommendation,
  SandboxPolicyRecommendations,
} from "./sandbox-policy.ts";
export {
  SandboxNetworkGrantSchema,
  SandboxNetworkGrantsSchema,
  SandboxNetworkPolicyConfiguration,
  validateSandboxNetworkGrants,
  sandboxNetworkGrantsWithinCeiling,
} from "./sandbox-policy.ts";

export type { ComputePreparationFailureEvidence } from "./compute-preparation.ts";
export { isComputePreparationFailureEvidence } from "./compute-preparation.ts";

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
  RepositoryRevisionState,
} from "./drivers/repo/index.ts";

export type {
  RuntimeLogContentClass,
  RuntimeLogContainerSourceId,
  RuntimeLogSourceId,
  RuntimeLogLevel,
  RuntimeLogKind,
  RuntimeLogGapReason,
  RuntimeLogWithheldReason,
  RuntimeLogStream,
  RuntimeLogRecord,
  AgentRuntimeContainerStatus,
  AgentRuntimeEvent,
  AgentRuntimePodStatus,
  AgentRuntimeLogSource,
  AgentRuntimeHarnessStatus,
  AgentHarnessStatusRead,
  AgentRuntimeDescription,
  AgentRuntimeDescribeOptions,
  AgentRuntimeLogRequest,
  AgentRuntimeLogChunk,
  SandboxLogContext,
  SandboxLogRequest,
  SandboxLogLine,
  SandboxLogChunk,
} from "./runtime-logs.ts";

export {
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  normalizeLoggingLevel,
  type LoggingLevel,
} from "./logging.ts";

export type {
  RepositoryExecutionIdentity,
  RepositoryAccess,
  AdmittedRepositoryBinding,
  NativeRepositorySender,
  OpenRepositorySessionInput,
  OpenRepositorySessionResult,
  RepositoryBindingRequest,
  RepositoryBindingSelection,
  RepositoryOption,
  RepositoryOptions,
  RepositoryPolicyDriver,
  RepositoryApprovalScope,
  RepositoryApprovalValue,
  RepositoryCredentialGrantIdentity,
  RepositoryCredentialMaterialRef,
  RepositoryCredentialResolution,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionFiles,
  RepositoryCredentialSessionStatus,
  RepositoryRevisionState,
} from "./drivers/repo/index.ts";
export {
  githubInstallationProfile,
  isInstallationRepositoryProfile,
  repositoryGitDeliveryProfile,
} from "./drivers/repo/index.ts";

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
    | { readonly mode: "bearerTokenFile"; readonly path: string }
    | {
        readonly mode: "mtls";
        readonly certificatePath: string;
        readonly privateKeyPath: string;
      };
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
    readonly credential_proxy?: string;
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
  /** A selected Credential Gateway requires source-backed model authentication. */
  readonly credentialSources?: { readonly types: readonly CredentialSourceType[] };
  readonly pluginPolicies?: PluginPolicyCapabilities & { readonly driver: PluginDriverIdentity };
  readonly pluginDiscovery?: { readonly credential: "required" | "none" };
  /** Present only when dedicated native OpenClaw can be admitted. */
  readonly nativeWorkers?: { readonly support: "pinned-runtime" | "custom-image" };
  /**
   * The OpenClaw execution modes an Agent can deploy in; empty when none. sandboxDriverUnavailable
   * marks an empty list caused by a selected Sandbox Driver outage, not the Installation's shape.
   * settingRefusals holds admission's refusal for a mode the Sandbox Driver could provision but
   * its settings refuse, naming the setting.
   */
  readonly openclaw?: {
    readonly executionModes: readonly HarnessExecutionMode[];
    readonly settingRefusals?: { readonly dedicated?: string };
    readonly sandboxDriverUnavailable?: true;
  };
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
  "sandbox_policy",
] as const);

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

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

/** Login modes a Harness can use when its model credential arrives from a source. */
export type CredentialSourceLoginMode = "api_key" | "codex_pat" | "chatgptAuthTokens";

export interface CredentialSourceFieldSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
  /**
   * The issuer may replace this value each time the gateway uses it (a rotating OAuth2 refresh
   * token), so the gateway's copy can be newer than the Secret that supplied it. An update must
   * reference a different Secret for the field; re-sending the recorded one would be stale.
   */
  readonly issuerRotated?: boolean;
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

/** Driver IDs are scoped to a capability. Both parts of a source owner are immutable. */
export type CredentialSourceOwnerCapability = "credential_gateway" | "credential_proxy";

/** OCC source admission, including its owner and Secret references, never credential values. */
export interface CredentialSource {
  readonly egress?: ProtectedEgressSource;
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SecretReference>>;
  readonly ownerCapability: CredentialSourceOwnerCapability;
  readonly driverId: string;
  readonly state: CredentialSourceState;
  readonly createdAt: string;
}

export interface CredentialSourceMetadata {
  readonly ownerCapability: CredentialSourceOwnerCapability;
  readonly egress?: Pick<ProtectedEgressSource, "adoption" | "retention">;
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
export type CredentialSourceSnapshot = {
  readonly sourceId: string;
  readonly sourceType: string;
} & (
  | { readonly credentialGatewayId: string; readonly credentialProxyId?: never }
  | { readonly credentialProxyId: string; readonly credentialGatewayId?: never }
);

/** Match the source owner recorded at admission, including for pre-Proxy Gateway snapshots. */
export function credentialSourceMatchesSnapshot(
  source: CredentialSource,
  snapshot: CredentialSourceSnapshot | undefined,
): boolean {
  if (!snapshot || source.id !== snapshot.sourceId || source.type !== snapshot.sourceType) {
    return false;
  }
  switch (source.ownerCapability) {
    case "credential_gateway":
      return (
        snapshot.credentialProxyId === undefined && snapshot.credentialGatewayId === source.driverId
      );
    case "credential_proxy":
      return (
        snapshot.credentialGatewayId === undefined && snapshot.credentialProxyId === source.driverId
      );
    default:
      return false;
  }
}

/** Withdrawal also supports revisions whose Harness source predates the separate source list. */
export function revisionCredentialSourceSnapshot(
  revision: AgentRevision,
  sourceId: string,
): CredentialSourceSnapshot | undefined {
  const listed = revision.credentialSources?.find((snapshot) => snapshot.sourceId === sourceId);
  const auth = revision.harnessAuth;
  return (
    listed ?? (auth.method === "credential_source" && auth.sourceId === sourceId ? auth : undefined)
  );
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
  /** An entry limits this plugin to its master switch. Unlisted plugins use the Driver defaults. */
  readonly policyScopeByPlugin?: Readonly<Record<string, "enablement_only">>;
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

/** Ready choices for a slot in the saved Agent's plugin picker. */
export interface AgentPluginCredentialSlot {
  readonly pluginId: string;
  readonly releaseSha256: string;
  readonly id: string;
  readonly label: string;
  readonly sources: readonly { readonly id: string; readonly name: string }[];
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

/**
 * The Harness a bundled Plugin Driver's runtime artifacts run in, or undefined when the pair
 * is supported (or the Driver is not bundled). Compute refuses any other pair when it prepares
 * a revision; OCC applies the same rule at Agent save, provisioning and deployment, before a
 * dedicated deployment stops the running revision.
 */
export const OPENCLAW_PLUGIN_DRIVER_IMPLEMENTATION = "occ/openclaw-plugin";
export const CODEX_PLUGIN_DRIVER_IMPLEMENTATION = "occ/codex-plugin";

export function pluginRuntimeHarnessRequirement(
  implementation: string,
  harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
): string | undefined {
  if (implementation === CODEX_PLUGIN_DRIVER_IMPLEMENTATION) {
    return (harness.id === "codex" && harness.mode === "dedicated") ||
      (harness.id === "openclaw" && harness.mode === "embedded")
      ? undefined
      : "a dedicated Codex Harness or embedded OpenClaw Harness";
  }
  if (implementation === OPENCLAW_PLUGIN_DRIVER_IMPLEMENTATION) {
    return harness.id === "openclaw" &&
      (harness.mode === "embedded" || harness.mode === "dedicated")
      ? undefined
      : "an OpenClaw Harness";
  }
  return undefined;
}

/**
 * Whether this Harness reaches the repository credential broker through the Codex network
 * proxy when Compute delivers repository material to it: a dedicated Codex Harness, or an
 * embedded OpenClaw Harness whose plugins run in the Codex Plugin Driver.
 */
export function codexProxiesRepositoryBroker(
  harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  pluginDriverImplementation: string | undefined,
): boolean {
  return (
    (harness.id === "codex" && harness.mode === "dedicated") ||
    (harness.id === "openclaw" &&
      harness.mode === "embedded" &&
      pluginDriverImplementation === CODEX_PLUGIN_DRIVER_IMPLEMENTATION)
  );
}

const CODEX_NETWORK_PROXY_SETTING = "plugins.entries.codex.config.appServer.networkProxy";

/**
 * The Codex network proxy domain decisions of a Configuration whose Harness reaches the
 * repository credential broker through that proxy, or the refusal of a setting that blocks the
 * broker. Compute applies it when it prepares a revision, with the broker host from the prepared
 * material. OCC applies it without the host at Agent save, provisioning and deployment, before a
 * dedicated deployment stops the running revision (finding 2350).
 */
export function codexRepositoryBrokerNetworkProxy(
  configuration: unknown,
  brokerHost?: string,
): { readonly domains: Readonly<Record<string, "allow" | "deny">> } | { readonly refusal: string } {
  const refuse = (setting: string, problem: string, change: string) => ({
    refusal: `Configuration setting ${CODEX_NETWORK_PROXY_SETTING}.${setting} ${problem}, so Codex cannot reach the repository credential broker. ${change}, or remove the repository bindings.`,
  });
  const appServer = asRecord(
    asRecord(asRecord(asRecord(asRecord(configuration)?.plugins)?.entries)?.codex)?.config,
  )?.appServer;
  const policy = asRecord(asRecord(appServer)?.networkProxy);
  if (policy?.enabled === false) {
    return refuse("enabled", "is false", "Set it to true or delete it");
  }
  if (policy?.mode !== undefined && policy.mode !== "limited" && policy.mode !== "full") {
    return refuse("mode", 'is not "limited" or "full"', "Set it to one of those or delete it");
  }
  if (policy?.allowLocalBinding !== undefined && typeof policy.allowLocalBinding !== "boolean") {
    return refuse(
      "allowLocalBinding",
      "is not true or false",
      "Set it to true or false or delete it",
    );
  }
  const domainsInput = policy?.domains === undefined ? undefined : asRecord(policy.domains);
  if (policy?.domains !== undefined && domainsInput === undefined) {
    return refuse("domains", "is not an object", 'Map each host to "allow" or "deny"');
  }
  const domains: Record<string, "allow" | "deny"> = {};
  for (const [entry, decision] of Object.entries(domainsInput ?? {})) {
    if (decision !== "allow" && decision !== "deny") {
      return refuse(
        "domains",
        'maps a host to neither "allow" nor "deny"',
        'Set each host to "allow" or "deny"',
      );
    }
    const host = entry.trim().toLowerCase();
    if (host.length === 0) {
      return refuse("domains", "has an empty host", "Delete that entry");
    }
    // A deny of a host wins over an allow of the same host in another spelling.
    domains[host] = domains[host] === "deny" || decision === "deny" ? "deny" : "allow";
  }
  if (brokerHost !== undefined && domains[brokerHost] === "deny") {
    // The text leaves out the host: the worker drops a preparation failure message over 256
    // characters, and a Namespace name can make the host long.
    return refuse("domains", "denies the repository credential broker's host", "Delete that deny");
  }
  return { domains };
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
  readonly sandboxPolicyEditing?: boolean;
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
  /** Desired Gateway administration mode; each deployment snapshots the selected value. */
  readonly gatewayManagedMode: boolean;
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
  readonly executionAdmission: ExecutionAdmission;
  readonly egressPlan?: ProxyPlan;
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly backendId: BackendRef;
  readonly configurationId: string;
  readonly configurationKind: ConfigurationKind;
  readonly configurationGeneration: number;
  readonly configuration: OpenClawConfigurationDocument;
  readonly gatewayManagedMode: boolean;
  readonly harness: RevisionHarnessDescriptor;
  readonly compute: {
    readonly id: string;
    readonly implementation: string;
    /** Private, immutable admission state owned by the selected Compute Driver. */
    readonly admission?: string;
  };
  readonly sandboxDriverId?: string;
  readonly sandboxPolicy?: SandboxPolicySnapshot;
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

/**
 * A revision without its saved settings: metadata plus the database-checked fields that tell
 * revisions apart. List routes return it; reading it never decodes the admitted snapshot.
 */
export type AgentRevisionSummary = AgentRevisionMetadata &
  Pick<AgentRevision, "configurationId" | "configurationGeneration" | "harness">;

/** One page of revision summaries, newest first, and the revision number the next page starts below. */
export interface AgentRevisionSummaryPage {
  readonly revisions: readonly Readonly<AgentRevisionSummary>[];
  /** Revisions numbered below this one remain; undefined on the last page. */
  readonly nextBefore?: number;
}

export type AgentRevisionRead =
  | AgentRevision
  | (AgentRevisionMetadata & { readonly configurationReadError: ConfigurationReadError });

export function freezeAgentRevision(revision: AgentRevision): Readonly<AgentRevision> {
  return Object.freeze({
    ...revision,
    executionAdmission: immutableCopy(revision.executionAdmission),
    ...(revision.egressPlan === undefined
      ? {}
      : { egressPlan: immutableCopy(revision.egressPlan) }),
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
  "manage_policy",
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
  sandbox_policy: Object.freeze(["read", "update"] as const),
  agent: Object.freeze([
    "create",
    "read",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
    "manage_policy",
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

export { DRIVER_CAPABILITIES, isDriverCapability } from "./drivers/index.ts";
export type {
  DriverCapability,
  Driver,
  DriverByCapability,
  DriverRegistration,
  DriverRegistrationRef,
  SelectedDriverRegistration,
  DriverImplementation,
} from "./drivers/index.ts";
export type {
  IAMDriver,
  IAMPolicyReadRepository,
  IAMPolicyRepository,
  IAMPolicyReadContext,
  IAMPolicyManagementContext,
  ManagedIAMResourceKind,
  IAMManagedRoleInput,
  IAMManagedAccessBindingInput,
  IAMManagedServicePrincipalInput,
} from "./drivers/iam/index.ts";
export type { ServiceAccountDriver } from "./drivers/service-account/index.ts";
export type { SecretDriver } from "./drivers/secret/index.ts";
export type {
  CredentialGatewayDriver,
  CredentialGatewayContext,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  CredentialRevisionContext,
  CredentialWithdrawalContext,
  ExternalChatgptAuth,
  CredentialSourceAttachment,
  CredentialAttachmentStatus,
  CredentialSourceToken,
} from "./drivers/credential-gateway/index.ts";
export type {
  CredentialRefreshDriver,
  CredentialRefreshInput,
  CredentialRefreshStatus,
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
} from "./drivers/credential-refresh/index.ts";
export type {
  HarnessExecutionModeSupport,
  SandboxDriver,
  SandboxRepositoryAccess,
  KubernetesNamespacedResource,
  SandboxWorkspaceMount,
  SandboxEnvironmentVariable,
  SandboxWorkloadFile,
  SandboxWorkloadIdentity,
  HarnessWorkloadRequirements,
  SandboxResourceRef,
  SandboxHarnessEndpoint,
  SandboxNamespaceContext,
  SandboxHarnessContext,
  SandboxHarnessWithdrawalContext,
  SandboxHarnessStatusContext,
  SandboxHarnessStatus,
  SandboxHarnessLostCode,
  SandboxHarnessRestart,
  SandboxHarnessObservation,
} from "./drivers/sandbox/index.ts";
export type {
  PluginDriver,
  PluginDriverContext,
  PluginDiscoveryAuthentication,
} from "./drivers/plugin/index.ts";
export type {
  ChannelDriver,
  ChannelDirectoryLookupInput,
  ChannelDirectoryResult,
  ChannelCredentialReader,
} from "./drivers/channel/index.ts";
export type {
  ComputeDriver,
  ComputeRevisionContext,
  WorkloadLaunchContext,
  ComputeLifecycleHooks,
  NamespaceLifecycleFailure,
  NamespaceEnsureResult,
  NamespaceDeleteResult,
  PluginDeploymentWarning,
  RuntimeFailureCause,
  RuntimeFailureEvidence,
  ComputePendingReason,
  ComputeReadiness,
  ComputePrepareRevisionFailureDiagnostic,
  ComputeAgentBinding,
  ComputeAgentProvisioningInput,
  ComputeAgentProvisioningCapabilities,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  RuntimeDiagnosticState,
  RuntimeDiagnosticCheck,
  AgentDeploymentDiagnostics,
  ComputeAgentRevisionBinding,
  RuntimeImage,
  ComputePreflightWarning,
  ComputePreflightResult,
} from "./drivers/compute/index.ts";
export type {
  ConfigurationDriver,
  ConfigurationValidationOptions,
} from "./drivers/configuration/index.ts";

export type JSONSchema = Readonly<Record<string, unknown>>;

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

export type {
  Preset,
  PresetSummary,
  PresetTemplate,
  PresetLaunchSettings,
  PresetVariable,
} from "./presets.ts";
export { normalizePresetTemplate } from "./presets.ts";
export {
  PRESET_JSON_MAX_BYTES,
  PresetValidationError,
  renderPresetTemplate,
  validatePresetTemplate,
  presetTemplateDefaults,
  presetTemplateDefaultsWithPlaceholders,
  requiredPresetVariables,
} from "./preset-variables.mjs";

export {
  CODEX_FAILURE_OUTPUT_CLASSES,
  PROCESS_EXIT_ERROR_CODES,
  PROCESS_EXIT_MAX_STATUS,
  PROCESS_EXIT_SIGNALS,
  RUNTIME_COMPONENTS,
  RUNTIME_DIAGNOSTIC_CHECKS,
  RUNTIME_DIAGNOSTIC_CODES,
  RUNTIME_FAILURE_CHECKS,
  UNRECOGNIZED_RUNTIME_VALUE,
  WORKSPACE_SETUP_CHECK,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
} from "./runtime-failure.mjs";

export type { InitialWorkspaceFiles, WorkspaceSetup } from "./workspace-setup.ts";
export { normalizeInitialWorkspaceFiles, normalizeWorkspaceDefaultsId } from "./workspace-setup.ts";
export {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
  WORKSPACE_DEFAULTS_VERSION,
} from "./workspace-defaults.mjs";

export type {
  ProtectedRepositoryGitAuthority,
  RepositoryGitBinding,
  ProtectedRepositoryGitMaterial,
  ProtectedGitHubInstallationMaterial,
  GitHubInstallationSendDecision,
  GitHubInstallationSendPermit,
  RepositoryGitInstallationFence,
  RepositoryGitMaterialVersion,
  RepositoryGitSendDecision,
  RepositoryGitAuthority,
  RepositoryGitOnlineAllow,
  RepositoryGitOnlineDecision,
  RepositoryGitSendPermit,
} from "./protected-repository-git.ts";
