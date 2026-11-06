import type { ConfigurationValidationOptions } from "../configuration/index.ts";
import type { CredentialAttachmentStatus } from "../credential-gateway/index.ts";
import type {
  CredentialPolicyWithdrawalOptions,
  EgressInstallation,
} from "../credential-proxy/index.ts";
import type { Driver, SelectedDriverRegistration } from "../index.ts";
import type {
  Agent,
  AgentRevision,
  CredentialSource,
  CredentialSourceType,
  HarnessAuthSnapshot,
  HarnessExecutionMode,
  Namespace,
  OpenClawConfigurationDocument,
  ResolvedHarnessAuth,
  RevisionHarnessDescriptor,
  Scope,
  SecretBindings,
  SecretEnvironmentProjection,
  ServiceAccountCredential,
} from "../../index.ts";
import type {
  RepositoryCredentialMaterialRef,
  RepositoryCredentialRuntimeBinding,
  RepositoryExecutionIdentity,
} from "../repo/index.ts";
import type {
  AgentRuntimeDescribeOptions,
  AgentRuntimeDescription,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
} from "../../runtime-logs.ts";
import type { SandboxHarnessObservation } from "../sandbox/index.ts";
import type { WorkspaceSetup } from "../../workspace-setup.ts";

export interface ComputeRevisionContext {
  /** Worker persists only an authenticated receipt for this admitted plan. */
  readonly recordEgressInstallation?: (installation: EgressInstallation) => Promise<void>;
  /** A fresh read of the still-authorized revision and its exact committed installation. */
  readonly currentEgressInstallation?: () => Promise<EgressInstallation | undefined>;
  /** Verify the live Worker-owned grant and exact broker session immediately before releasing it. */
  readonly verifyRepositorySessionRelease?: (
    binding: RepositoryCredentialMaterialRef & { readonly deadlineWallMs: number },
  ) => Promise<void>;
  readonly workspaceSetup?: Readonly<WorkspaceSetup>;
  readonly harnessAuth: ResolvedHarnessAuth;
  /** Non-model sources resolved again at dispatch, in admission order. */
  readonly credentialSources?: readonly Readonly<CredentialSource>[];
  readonly secretEnvironment: readonly SecretEnvironmentProjection[];
  readonly repositoryCredentials?: readonly RepositoryCredentialRuntimeBinding[];
}

export interface WorkloadLaunchContext {
  environment: Record<string, string>;
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
 * scheduled, a container image cannot be pulled, the Namespace's Pod quota refuses to
 * create them, its workspace setup failed and is being retried, or its workloads are ready
 * but the workspace node has not connected.
 */
export type ComputePendingReason =
  | "WORKLOAD_UNSCHEDULABLE"
  | "WORKLOAD_IMAGE_PULL_FAILED"
  | "NAMESPACE_POD_QUOTA_EXCEEDED"
  | "WORKSPACE_NODE_PENDING"
  | "WORKSPACE_SETUP_RETRYING"
  | "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING"
  /** The worker has not yet verified the Sandbox's prepared Git route (OpenShell). */
  | "REPOSITORY_GIT_ROUTE_PENDING";

export interface ComputeReadiness extends Scope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly ready: boolean;
  /** Only v6: select this execution for material while its launcher and user work remain held. */
  readonly heldForRepositoryGitMaterial?: true;
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

export interface ComputeDriver extends Driver {
  /**
   * Read only the selected revision's existing Harness. Never prepare, adopt, attach,
   * repair, release or authorize an execution. Missing support provides no assurance.
   * Lifecycle observations do not establish repository execution identity or authority.
   */
  observeRevision?(
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
  ): Promise<SandboxHarnessObservation>;
  /** Admission capability check, not release authority. Missing support fails closed. */
  validateExecutionAdmission?(
    revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
    /** Only the release of a revision already in durable custody can use its historical contract. */
    source?: SelectedDriverRegistration | "stored",
  ): void;
  /**
   * After release is refused, select a withdrawal only for a grant this Compute previously
   * admitted. Selection is side-effect free. The worker runs the withdrawal under the active
   * revision's authorized claim; resolve only after observing the grant and workload gone.
   * Neither selection nor completion permits preparing, activating or replacing that revision.
   */
  rejectedExecutionWithdrawal?(
    revision: Readonly<AgentRevision>,
  ): (() => Promise<void>) | undefined;
  readonly supportsWorkspaceSetup?: true;
  /** Enforces Gateway administration restrictions for managed Agent revisions. */
  readonly supportsGatewayManagedMode?: true;
  readonly capability: "compute";
  /** Deployment must observe and provision Agent-owned runtime credentials before revision admission. */
  readonly requiresAgentRuntimeCredentials?: true;
  /** Default: platform admission policy. Driver ownership preserves native logging settings. */
  readonly runtimeLogging?: "platform" | "driver";
  readonly agentProvisioning?: ComputeAgentProvisioningCapabilities;
  readonly activationOrder?: "beforeCommit" | "afterCommit";
  readonly maintenanceIntervalMs?: number;
  /** Side-effect-free, bounded Driver-owned facts frozen into a new revision. */
  admitRevision?(revision: Readonly<AgentRevision>): string | undefined;
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
  /**
   * Side-effect-free check of Configuration values against rules the Driver applies on every
   * topology, at Configuration create and update, Agent provisioning and Preset save (on the
   * values rendered with defaults). Throws ConfigurationHarnessError, naming the setting but
   * never its value. validateHarnessAuth applies the same rules at deployment. Preset saves pass
   * `options.unresolved`, which names their unfilled variables.
   */
  validateConfiguration?(
    configuration: Readonly<OpenClawConfigurationDocument>,
    options?: ConfigurationValidationOptions,
  ): void;
  /**
   * Side-effect-free check that the first deployment of an Agent with initial workspace files
   * can deliver them on this Harness topology, at Agent create and update while the setup is
   * pending, at deployment and at provisioning. `sandboxDriverId` names the Sandbox Driver the
   * revision would be pinned to, if any. Throws ConfigurationHarnessError, naming the setting,
   * for Configuration content preparation would refuse; any other error is an Installation
   * refusal.
   */
  validateWorkspaceSetup?(
    harness: RevisionHarnessDescriptor,
    configuration: Readonly<OpenClawConfigurationDocument>,
    sandboxDriverId?: string,
  ): void;
  validateHarnessAuth?(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
    /**
     * The Configuration's Secret bindings. Agent save passes `null` and expects only the rules
     * that depend on the Agent: a Configuration may stage its bindings after its values, and
     * Installation-wide facts about the Configuration wait for deployment.
     */
    secretBindings?: SecretBindings | null,
    /** Catalog entry for a `credential_source` binding; absent for every other method. */
    credentialSourceType?: CredentialSourceType,
  ): void;
  /**
   * Withdraw expired Git access or a standing grant durably withdrawn before its first deadline.
   * Observe that withdrawal again after a restart. Never grant
   * access, replace the runtime, or repeat an uncertain detach. Return `withdrawn` only after
   * verifying Git is revoked and the same independently authorized inference runtime is ready.
   * `pending` means Git is fenced but confirmation is outstanding; it asserts no model health.
   * Return `retire-runtime` if the fence, identity or independent authority cannot be preserved.
   */
  retireExpiredRepositoryAccess?(
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
  ): Promise<"withdrawn" | "pending" | "retire-runtime">;
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
    options?: CredentialPolicyWithdrawalOptions,
  ): Promise<CredentialAttachmentStatus>;
  /**
   * Withdraws the Harness exposure a Sandbox Driver created for Compute's status read of a
   * dedicated OpenClaw worker, outside a preparation pass: the worker calls it for every such
   * revision that is already active when it starts (an upgrade from a controller that kept the
   * exposure) and for one that failed for good while its Sandbox stays for diagnosis. Idempotent
   * and effect-free for revisions without such an exposure (a Codex Harness, no Sandbox Driver).
   * Resolves only once the provider confirms the exposure gone; the worker retries a bounded
   * number of times and logs the failure code.
   */
  withdrawHarnessExposure?(revision: Readonly<AgentRevision>, signal: AbortSignal): Promise<void>;
  /** Verify the existing execution without creating, replacing or repairing it. */
  verifyRepositoryExecution?(
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
  ): Promise<RepositoryExecutionIdentity | undefined>;
  /**
   * Throws OCC's ComputePreparationFailedError when initialization is terminal.
   * The worker durably fails deployment and schedules stopRevision for cleanup.
   */
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
