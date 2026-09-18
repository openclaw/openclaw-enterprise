import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolPolicySchema,
} from "./api/resources.ts";
import { Check } from "typebox/value";

export {
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  normalizeLoggingLevel,
  type LoggingLevel,
} from "./logging.ts";

export const DRIVER_CAPABILITIES = Object.freeze([
  "iam",
  "compute",
  "configuration",
  "service_account",
  "secret",
  "sandbox",
  "plugin",
] as const);

export type DriverCapability = (typeof DRIVER_CAPABILITIES)[number];

export type ProviderType = "chatgpt";

export type ProviderRef = string | null;

export interface ProviderConfiguration {
  readonly workspaceId: string;
  readonly apiKeyPath: string;
  readonly credentialTtlSeconds?: number;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly type: ProviderType;
  readonly configuration: ProviderConfiguration;
  readonly drivers: Readonly<Record<"service_account", string>>;
}

export interface ProviderSummary {
  readonly id: string;
  readonly type: ProviderType;
}

export interface Provider<Client = unknown> {
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
  "service_account",
  "secret",
  "agent",
  "agent_revision",
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

export type HarnessAuthBinding =
  | { readonly method: "api_key"; readonly source: SecretReference }
  | { readonly method: "chatgpt_service_account"; readonly serviceAccountId: string }
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
      readonly method: "chatgpt_service_account";
      readonly serviceAccountId: string;
      readonly credential: ServiceAccountCredential & { readonly kind: "access_token" };
      readonly providerBinding: {
        readonly providerId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      };
    };

/** Authoritative delivery references, resolved again at dispatch; never secret values. */
export type ResolvedHarnessAuth =
  | (Extract<HarnessAuthSnapshot, { method: "api_key" }> & {
      readonly backendRef: SecretBackendRef;
    })
  | Extract<HarnessAuthSnapshot, { method: "chatgpt_service_account" | "runtime" }>;

export interface ComputeRevisionContext {
  readonly harnessAuth: ResolvedHarnessAuth;
  readonly secretEnvironment: readonly SecretEnvironmentProjection[];
}

export type PluginApprovalMode = "always" | "never" | "prompt" | "auto";

export type PluginApprovalsReviewer = "user" | "auto_review";

export interface PluginDriverIdentity {
  readonly id: string;
  readonly implementation: string;
}

export interface PluginToolPolicy {
  readonly enabled?: boolean;
  readonly approvalMode?: PluginApprovalMode;
}

export interface PluginDesiredSelection {
  readonly enabled: boolean;
  readonly approvalMode: PluginApprovalMode;
  readonly approvalsReviewer?: PluginApprovalsReviewer;
  readonly destructiveActions?: PluginApprovalMode;
  readonly writes?: PluginApprovalMode;
  readonly tools?: Readonly<Record<string, PluginToolPolicy>>;
}

export type PluginDesiredState = Readonly<Record<string, PluginDesiredSelection>>;

export interface PluginToolCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly destructive: boolean;
  readonly writes: boolean;
}

export interface PluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tools: readonly PluginToolCatalogEntry[] | null;
}

export interface PluginRevisionState {
  readonly driver: PluginDriverIdentity;
  readonly plugins: PluginDesiredState;
}

export type PluginValidationFailure = (message: string) => never;

const PLUGIN_SCHEMA_REFS = {
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

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
export interface Agent extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly desiredRuntimeState: AgentDesiredRuntimeState;
  readonly configurationId: string;
  readonly providerId: ProviderRef;
  readonly harnessAuth: HarnessAuthBinding | null;
  readonly executionMode: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly servicePrincipalId: string;
  readonly activeRevisionId?: string;
  readonly createdAt: string;
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
  readonly providerId: ProviderRef;
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
  readonly harnessAuth: HarnessAuthSnapshot;
  readonly servicePrincipalId: string;
  readonly createdAt: string;
}

export function freezeAgentRevision(revision: AgentRevision): Readonly<AgentRevision> {
  return Object.freeze({
    ...revision,
    configuration: immutableCopy(revision.configuration),
    ...(revision.secretBindings === undefined
      ? {}
      : { secretBindings: immutableCopy(revision.secretBindings) }),
    ...(revision.plugins === undefined ? {} : { plugins: immutableCopy(revision.plugins) }),
    harness: Object.freeze({ ...revision.harness }),
    compute: Object.freeze({ ...revision.compute }),
    harnessAuth: immutableCopy(revision.harnessAuth),
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

export type PermissionAction =
  "create" | "read" | "update" | "delete" | "deploy" | "operate" | "administer";

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

export type AuditEventKind = "bootstrap" | "mutation" | "authorization_denial";

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

export interface HarnessWorkloadRequirements {
  readonly loginMode: HarnessAuthBinding["method"];
  readonly image: string;
  readonly command: readonly string[];
  readonly serviceAccountName: string;
  readonly serviceAccountToken: {
    readonly audience: string;
    readonly expirationSeconds: number;
    readonly mountPath: string;
    readonly path: string;
    readonly readOnly: true;
  };
  readonly workspaceMounts: readonly SandboxWorkspaceMount[];
  readonly environment: readonly SandboxEnvironmentVariable[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface SandboxResourceRef {
  readonly namespaceName: string;
  readonly resourceName: string;
  readonly agentId: string;
  readonly revisionId: string;
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
  lookupIdentity(input: IdentityLookup): Promise<Identity | undefined>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
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
  delete(secret: Secret): Promise<void>;
  /** Verify live exact ownership and return only safe projection identity. */
  resolve(secret: Secret): Promise<SecretBackendRef>;
}

export interface SandboxDriver extends Driver {
  readonly capability: "sandbox";
  /** One or more distinct containment facets implemented by this driver. */
  readonly facets: readonly SandboxFacet[];
  configureAgent?(
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): OpenClawConfigurationDocument;
  ensureNamespace?(context: SandboxNamespaceContext): Promise<void>;
  provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>;
  /** Required for revision stop, retirement, and Namespace cleanup, independent of Harness ownership. */
  cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void>;
}

export interface PluginDriverContext {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
  readonly harness: RevisionHarnessDescriptor;
  readonly configuration: Readonly<OpenClawConfigurationDocument>;
  readonly signal: AbortSignal;
}

export interface PluginDriver extends Driver {
  readonly capability: "plugin";
  listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]>;
}

export type NamespaceLifecycleFailure = "retryable" | "permanent";

export interface NamespaceEnsureResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceReady: boolean;
  readonly failure?: NamespaceLifecycleFailure;
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

export interface ComputeReadiness extends Scope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly ready: boolean;
  readonly warnings?: readonly PluginDeploymentWarning[];
}

/** Authorized, server-admitted resource identities for an Agent-owned runtime. */
export interface ComputeAgentBinding {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
}

export interface AgentRuntimeCredentialsInput {
  readonly slack?: {
    readonly appToken: string;
    readonly botToken: string;
  };
}

export interface AgentRuntimeCredentialStatus {
  readonly transportConfigured: boolean;
  readonly slackConfigured: boolean;
}

export interface ComputePreflightWarning {
  readonly code: string;
  readonly message: string;
}

export interface ComputePreflightResult {
  readonly warnings: readonly ComputePreflightWarning[];
}

export interface ComputeDriver extends Driver {
  readonly capability: "compute";
  /** Default: platform admission policy. Driver ownership preserves native logging settings. */
  readonly runtimeLogging?: "platform" | "driver";
  readonly activationOrder?: "beforeCommit" | "afterCommit";
  readonly maintenanceIntervalMs?: number;
  validateHarnessAuth?(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
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
  getGatewayEndpoint?(revision: AgentRevision): string | undefined;
  ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult>;
  deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult>;
  prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness>;
  activateRevision?(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void>;
  deactivateRevision?(revision: AgentRevision): Promise<void>;
  stopRevision(revision: AgentRevision): Promise<void>;
  retireRevision(revision: AgentRevision): Promise<void>;
}

export interface ConfigurationDriver extends Driver {
  readonly capability: "configuration";
  create(configuration: Configuration): Promise<Configuration>;
  read(reference: ConfigurationReference): Promise<Configuration>;
  update(configuration: Configuration): Promise<Configuration>;
  delete(reference: ConfigurationReference): Promise<void>;
  validate(configuration: Configuration): Promise<void>;
}

export { normalizeSecretBindings } from "./secret-bindings.ts";

export * from "./api/common.ts";
export * from "./api/resources.ts";
export * from "./api/routes.ts";

export { normalizeHarnessAuthBinding, harnessAuthBindingFromSnapshot } from "./harness-auth.ts";
