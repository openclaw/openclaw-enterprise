import type { CredentialSourceAttachment } from "./credential-gateway.ts";
import type { EgressInstallation, ProxyWiring } from "./credential-proxy.ts";
import type { Driver } from "./driver.ts";
import type {
  AgentRevision,
  CredentialSourceLoginMode,
  HarnessAuthBinding,
  Namespace,
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
  SandboxFacet,
} from "./index.ts";
import type { RepositoryExecutionIdentity } from "./repo.ts";
import type { SandboxLogChunk, SandboxLogContext, SandboxLogRequest } from "./runtime-logs.ts";
import type {
  SandboxNetworkGrant,
  SandboxPolicyObservation,
  SandboxPolicyRecommendations,
  SandboxPolicySnapshot,
} from "./sandbox-policy.ts";

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
  readonly proxyWiring?: ProxyWiring;
  readonly labels: Readonly<Record<string, string>>;
}

export interface SandboxResourceRef {
  /** Trusted Sandbox output, including its exact auxiliary rules, for independent observation. */
  readonly proxyWiring?: ProxyWiring;
  readonly namespaceName: string;
  readonly resourceName: string;
  readonly agentId: string;
  readonly revisionId: string;
}

/** Provider-owned endpoint through which the Agent Gateway reaches its dedicated Harness. */
export interface SandboxHarnessEndpoint {
  readonly url: string;
  /** Public PEM CA certificates for this WSS endpoint; absent means system trust. */
  readonly tls?: {
    /** Certificate bytes only, never a source path, private key or client credential. */
    readonly caBundle: string;
  };
  /** Provider-local workspace root served by the Harness workspace node. */
  readonly workspaceRoot?: string;
  /** Request this native Codex profile when the provider supplies the sandbox boundary. */
  readonly codexPermissionProfile?: ":danger-full-access";
}

export interface SandboxNamespaceContext {
  readonly namespace: Readonly<Namespace>;
  readonly kubernetes: unknown;
  readonly signal: AbortSignal;
}

export interface SandboxHarnessContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  readonly requirements: HarnessWorkloadRequirements;
  /**
   * True once the revision's workspace node has enrolled with its Agent Gateway. A dedicated
   * OpenClaw worker's Harness exposure serves Compute's status read only before that: a Driver
   * withdraws it on `provisionHarness` and `withdrawHarnessExposure`, and refuses `harnessStatus`.
   */
  readonly workspaceNodeEnrolled?: boolean;
}

/**
 * What `withdrawHarnessExposure` needs: the revision names the exact Sandbox, and the Workspace
 * comes with the Namespace. Compute calls it outside a preparation pass too (for a revision that
 * is already active, or one that failed for good), where no Harness requirements are rendered.
 */
export type SandboxHarnessWithdrawalContext = Omit<SandboxHarnessContext, "requirements">;

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

/** Why a provisioned Harness Sandbox can no longer serve its revision. */
export type SandboxHarnessLostCode =
  "SANDBOX_MISSING" | "SANDBOX_DELETING" | "SANDBOX_STOPPED" | "SANDBOX_FAILED" | "HARNESS_EXITED";

/**
 * The provider restarts an exited Harness process itself: `exitCode` is the last exit and
 * `restarts` its restart number in the current crash loop (1 for a first restart).
 */
export interface SandboxHarnessRestart {
  readonly state: "starting";
  readonly code: "HARNESS_RESTARTING";
  readonly exitCode: number;
  readonly restarts: number;
}

/** The provider's own lifecycle record of a revision's Harness Sandbox. */
export type SandboxHarnessObservation =
  | { readonly state: "running" }
  | { readonly state: "starting" }
  | SandboxHarnessRestart
  | { readonly state: "unknown" }
  | { readonly state: "lost"; readonly code: SandboxHarnessLostCode };

/** The selected Sandbox owns the repository recipient, including proof after a worker restart. */
export interface SandboxRepositoryAccess {
  verifyExecution(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<RepositoryExecutionIdentity | undefined>;
  /** Remove only repository access when the same independently authorized execution can survive. */
  retireExpired(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<"withdrawn" | "pending" | "retire-runtime">;
  routeReadiness(revisionId: string): "ready" | "pending" | "blocked";
  /** Stable observation time after which Compute may verify the node survived credential installation. */
  materialSettledAt(revisionId: string): number | undefined;
  isRouteBlockedError(error: unknown): boolean;
}

export interface SandboxDriver extends Driver {
  readonly repositoryAccess?: SandboxRepositoryAccess;
  /** Explicit support; a networking facet alone never grants editable policy. */
  readonly networkPolicy?: {
    readonly wildcards: boolean;
    readonly portRanges: boolean;
    readonly live: boolean;
  };
  /**
   * `scope.repositoryCredentials` marks a policy for an Agent or revision with repository
   * bindings, which a Driver may route only through its own repository path; it refuses an
   * overlapping policy with a `SandboxNetworkPolicyConflictError` naming the rule.
   */
  admitNetworkPolicy?(
    additions: readonly SandboxNetworkGrant[],
    version: number,
    defaults?: SandboxPolicySnapshot["defaults"],
    scope?: { readonly repositoryCredentials?: boolean },
  ): SandboxPolicySnapshot;
  observeNetworkPolicy?(
    context: SandboxLogContext,
    snapshot: SandboxPolicySnapshot,
  ): Promise<SandboxPolicyObservation>;
  applyNetworkPolicy?(
    context: SandboxLogContext,
    input: {
      readonly snapshot: SandboxPolicySnapshot;
      readonly expectedProviderVersion: string;
      readonly operationId: string;
    },
  ): Promise<void>;
  readPolicyRecommendations?(
    context: SandboxLogContext,
    limit: number,
  ): Promise<SandboxPolicyRecommendations>;

  readonly capability: "sandbox";
  /** One or more distinct containment facets implemented by this driver. */
  readonly facets: readonly SandboxFacet[];
  /**
   * Absolute HOME of the Harness user inside this provider's Sandbox. Compute places
   * Harness-local paths it renders into the Agent Gateway configuration, such as the native
   * hook credential directory, under it. Defaults to the Compute-owned Harness Pod's HOME.
   */
  readonly harnessHome?: string;
  /**
   * Side-effect-free validation for initial workspace files this provider-owned Harness can
   * initialize. Compute delegates only when this Driver also provisions the Harness; omission
   * refuses workspace setup. Configuration errors name the setting, never its value.
   */
  validateWorkspaceSetup?(
    harness: Readonly<RevisionHarnessDescriptor>,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void;
  /**
   * The Agent Configuration this Driver admits for a dedicated Harness. Refusals that Driver
   * settings alone decide throw ConfigurationHarnessError, also for an empty Configuration:
   * the Installation's OpenClaw execution modes probe it that way.
   */
  configureAgent?(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
  ): OpenClawConfigurationDocument;
  ensureNamespace?(context: SandboxNamespaceContext): Promise<void>;
  provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>;
  /** The v6 launcher stays held. A denial observed here can select material, never release work. */
  observeHeldRepositoryGitPreview?(
    context: SandboxHarnessStatusContext,
  ): Promise<"held" | "installed" | undefined>;
  /**
   * Release the exact protected Harness startup only after Compute has committed
   * this current installation. Authenticate the transport peer and bind its fresh
   * startup challenge to the admitted execution/plan. No material or send authority
   * is conveyed. A starting transport may remain pending until the next reconcile.
   */
  enrollHarness?(
    context: SandboxHarnessStatusContext,
    installation: EgressInstallation,
    /** Compute alone may release this exact fresh startup; the transport bearer cannot. */
    release: (startupId: string) => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<void>;
  /**
   * Returns the provider-owned transport for the exact provisioned Harness. When present,
   * Compute must route the Agent Gateway through this endpoint instead of its native Harness
   * Service. Implementations must fail closed until the endpoint is observable and exact.
   */
  harnessEndpoint?(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint>;
  /**
   * Observes the provider-owned Harness through its exposed port, with the Agent transport
   * token. Compute fails the revision with a valid held `runtimeFailure`. For a Codex Harness it
   * treats only `serving` as ready, which requires an authenticated transport handshake; for a
   * dedicated OpenClaw worker it reads this only while the worker's node has not connected.
   */
  harnessStatus?(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus>;
  /**
   * Removes the exposure `provisionHarness` created for Compute's status read of a dedicated
   * OpenClaw worker, once its workspace node has enrolled: nothing of Compute's listens there
   * afterwards, and the exposure would route unauthenticated traffic to whatever does. Resolves
   * only once the provider confirms the exposure gone, with a read it can trust (a provider
   * that hides unauthorized Sandboxes behind "not found" confirms nothing by that alone);
   * Compute does not report the revision ready before that. Idempotent: called again for a
   * revision without the exposure, it resolves without a mutation. A Codex Harness keeps its
   * exposure as the Gateway's transport.
   */
  withdrawHarnessExposure?(context: SandboxHarnessWithdrawalContext): Promise<void>;
  /**
   * The exact Sandbox `provisionHarness` creates for this revision, derived without effects.
   * Required to revoke credentials from a running revision.
   */
  harnessResource?(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef;
  /**
   * Exact Pod labels of the provider Pods that open this revision's workspace-node connection to
   * its Agent Gateway, in the Sandbox namespace, or `undefined` while the revision has no Sandbox.
   * Compute admits only Pods with these labels to that Gateway's port, so they must select this
   * revision's Sandbox alone, never another Sandbox in the namespace.
   */
  workspaceNodePeerLabels?(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined>;
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
  /**
   * The provider's lifecycle record of the dedicated revision's Harness Sandbox, read-only.
   * `lost` means the Sandbox is not serving the revision and OCC will not restart it
   * (deleted, stopped, failed, or its Harness process exited); a new deployment replaces it.
   * `starting` with `HARNESS_RESTARTING` is a Harness process the provider is restarting
   * after it exited, as opposed to a first start.
   */
  observeHarness?(context: SandboxLogContext): Promise<SandboxHarnessObservation>;
}
