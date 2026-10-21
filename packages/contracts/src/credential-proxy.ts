import type {
  CredentialFreeEgressSource,
  CredentialFreeMetadataGrant,
  NoMaterialSelection,
} from "./credential-free-metadata.ts";
import type {
  GitHubMetadataGrant,
  PreparedGitHubEgressLifecycle,
  PreparedGitHubEgressSource,
  PreparedGitHubMaterialEvidence,
} from "./prepared-github-egress.ts";
import type {
  AgentRevision,
  CredentialSource,
  CredentialSourceType,
  Driver,
  DriverRegistrationRef,
  Namespace,
  RepositoryRevisionState,
  Secret,
  SecretReference,
} from "./index.ts";

/** Configuration generations never advance merely because Secret material rotates. */
export interface EgressRef {
  readonly id: string;
  readonly generation: number;
}

export interface EgressSourceKey {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly source: EgressRef;
  readonly backend: EgressRef;
  readonly provider: EgressRef;
}

/** Only live static inputs are admitted by the first protected implementation. */
export interface StaticEgressSource {
  readonly key: EgressSourceKey;
  readonly schemaVersion: 1;
  readonly adoption: "live";
  readonly materialRefId: string;
  readonly secret: SecretReference;
  readonly secretDriver: EgressRef;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  /** Zero retention: every operation reads the authoritative selected store. */
  readonly retention: "none";
}

export type ProtectedEgressSource =
  StaticEgressSource | PreparedGitHubEgressSource | CredentialFreeEgressSource;

export interface VersionedSecretValue {
  readonly value: string;
  readonly version: string;
  readonly authoritativeObservedAt: string;
  readonly expiresAt?: string;
}

/** Cancellation and the absolute bound for one credential read. */
export interface CredentialReadLifetime {
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

/** Trusted Resolver-only input; values never become workload projections. */
export interface CredentialInputRead {
  readonly secret: Readonly<Secret>;
  readonly lifetime: CredentialReadLifetime;
  readonly retention: "none";
}

export interface EgressExecution {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly servicePrincipalId: string;
  readonly revisionId: string;
  readonly executionId: string;
}

export interface InferenceGrant {
  readonly kind: "inference";
  readonly models: readonly string[];
  readonly providerTools: "none";
}

export interface EgressBinding {
  readonly binding: EgressRef;
  readonly execution: EgressExecution;
  readonly source: EgressSourceKey;
  readonly grant: InferenceGrant | GitHubMetadataGrant | CredentialFreeMetadataGrant;
  readonly grantHash: string;
  readonly isolationId: string;
}

export interface EgressRoute {
  readonly route: EgressRef;
  readonly binding: EgressBinding;
  readonly origin: string;
  readonly path: string;
  readonly method: "POST" | "GET";
  readonly operationPolicy: EgressRef;
  readonly responsePolicy: EgressRef;
  readonly deadlineMs: number;
}

export interface ProxyPlan {
  readonly id: string;
  readonly generation: number;
  readonly execution: EgressExecution;
  readonly sandboxDriverId: string;
  readonly egressDriverId: string;
  /** Present on every v3 admission; v2 retains the exact capability IDs recorded at admission. */
  readonly driver?: DriverRegistrationRef;
  /** v4 only: authorize this exact repository grant through the installed online sender. */
  readonly repositoryGit?: RepositoryRevisionState;
  readonly routes: readonly EgressRoute[];
}

/** Recorded only from authenticated adapter observation of the exact installed policy. */
export interface EgressInstallation {
  readonly plan: ProxyPlan;
  readonly sandboxId: string;
  readonly sender: EgressRef;
  readonly installedAt: string;
  /** Adapter-verified installation fence. Historical evidence must be revalidated for each use. */
  readonly enforcement: {
    readonly instanceId: string;
    readonly configurationId: string;
    readonly policyHash: string;
    readonly authorityScope: "execution";
    /** Public key bound by the adapter to this installation, never selected by a request. */
    readonly peerKeyId?: string;
  };
}

export interface EgressRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly deadlineAt: string;
  readonly bindingId?: string;
  /** Execution policy observed on the intercepted connection, covered by the signed opening. */
  readonly verifiedExecutionPolicyHash?: string;
}

export interface InferenceOperation {
  readonly kind: "inference";
  readonly action: "generate";
  readonly model: string;
}

export type EgressOperation =
  | InferenceOperation
  | {
      readonly kind: "github_repository_metadata" | "credential_free_repository_metadata";
      readonly repository: string;
      readonly repositoryId: string;
    };

export type EgressMaterialEvidence = StaticMaterialEvidence | PreparedGitHubMaterialEvidence;

export type EgressSelectionEvidence = EgressMaterialEvidence | NoMaterialSelection;

export interface StaticMaterialEvidence {
  readonly kind: "static";
  readonly source: EgressSourceKey;
  readonly binding: EgressRef;
  readonly grantHash: string;
  readonly isolationId: string;
  readonly adoption: "live";
  readonly materialRefId: string;
  readonly secret: SecretReference;
  readonly secretDriver: EgressRef;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly authoritativeObservedAt: string;
  readonly usableUntil: string;
  readonly retention: "none";
}

export type EgressRefusal =
  | {
      readonly kind: "denied";
      readonly code:
        | "identity"
        | "unauthorized"
        | "withdrawn"
        | "stale_configuration"
        | "scope_mismatch"
        | "ambiguous_route"
        | "invalid_handle"
        | "unsupported_operation";
    }
  | {
      readonly kind: "not_ready";
      readonly code: "material_missing" | "attachment_pending" | "expired";
    }
  | { readonly kind: "unavailable"; readonly code: "authority" | "secret_store" | "resolver" }
  | { readonly kind: "cancelled" | "deadline_exceeded" };

export interface EgressResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  /** Complete, ordered trailers, including an empty list when the upstream sent none. */
  readonly trailers: readonly (readonly [string, string])[];
}

/** Installed trusted provider semantics; callers never supply code or an injection callback. */
export interface CredentialProviderDefinition {
  readonly ref: EgressRef;
  readonly schemaVersion: 1;
  readonly sourceType: CredentialSourceType;
  normalizeConfig(config: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  normalizeGrant(
    models: readonly string[],
    config?: Readonly<Record<string, string>>,
  ): InferenceGrant | GitHubMetadataGrant | CredentialFreeMetadataGrant;
  routes(source: Readonly<CredentialSource>, binding: EgressBinding): readonly EgressRoute[];
  classify(route: EgressRoute, request: EgressRequest): EgressOperation | undefined;
  inject(value: string): readonly (readonly [string, string])[];
  /** Positive provider evidence only; status alone never identifies rejected credentials. */
  credentialRejected(response: EgressResponse): boolean;
  protectResponse(
    response: EgressResponse,
    value: string | undefined,
    request: EgressRequest,
    operation: EgressOperation,
  ): EgressResponse | undefined;
}

export interface CredentialSourceControl {
  readonly preparedGitHub?: PreparedGitHubEgressLifecycle;
  readonly backend: EgressRef;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  readonly providers: readonly CredentialProviderDefinition[];
  /** Capability evidence is obtained from the actual configured counterpart, never inferred. */
  assertAvailable(signal: AbortSignal, profile?: "repository_git"): Promise<void>;
}

export interface ProxyWiring {
  readonly plan: ProxyPlan;
  /** Nonsecret adapter-owned configuration; only the paired Sandbox interprets it. */
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface ProxyRevisionContext {
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  readonly plan: ProxyPlan;
  readonly signal: AbortSignal;
}

export interface CredentialProxyDriver extends Driver {
  readonly capability: "credential_proxy";
  readonly sourceControl: CredentialSourceControl;
  configureRevision(context: ProxyRevisionContext): Promise<ProxyWiring>;
  wiringStatus(
    context: ProxyRevisionContext,
    prepared: ProxyWiring,
  ): Promise<EgressInstallation | undefined>;
  /** Query the counterpart again; persisted installation records are not readiness leases. */
  verifyInstallation(
    context: ProxyRevisionContext,
    installation: EgressInstallation,
  ): Promise<boolean>;
  withdrawBinding(context: ProxyRevisionContext, binding: EgressRef): Promise<boolean>;
  removeRevision(context: ProxyRevisionContext): Promise<boolean>;
}

/** Durable admission semantics, independent of credential bindings and route count. */
export type ExecutionAdmission =
  | { readonly version: 2; readonly mode: "protected" | "unprotected" }
  | { readonly version: 3 | 4; readonly mode: "protected" };

/** Recognition only. A valid protected schema is not proof of deployability. */
export function assertExecutionAdmission(
  revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
): void {
  const admission = revision.executionAdmission;
  if (
    !admission ||
    (admission.version !== 2 &&
      !((admission.version === 3 || admission.version === 4) && admission.mode === "protected")) ||
    (admission.mode !== "protected" && admission.mode !== "unprotected") ||
    Object.keys(admission).some((key) => key !== "version" && key !== "mode")
  ) {
    throw new Error("Missing or unsupported durable execution admission.");
  }
  if ((admission.mode === "protected") !== (revision.egressPlan !== undefined)) {
    throw new Error("Inconsistent durable execution admission and egress plan.");
  }
  if (admission.mode === "protected" && !Array.isArray(revision.egressPlan?.routes)) {
    throw new Error("Invalid protected execution plan.");
  }
  const repository = revision.egressPlan?.repositoryGit;
  if (
    admission.version === 4
      ? !repository ||
        repository.bindings?.length !== 1 ||
        repository.bindings[0]?.profile !== "git-write"
      : repository !== undefined
  ) {
    throw new Error("Repository Credential Proxy requires its own protected execution admission.");
  }
  const owner = revision.egressPlan?.driver;
  if (
    admission.version === 3 || admission.version === 4
      ? !owner ||
        typeof owner.id !== "string" ||
        !owner.id.trim() ||
        typeof owner.implementation !== "string" ||
        !owner.implementation.trim() ||
        !/^[0-9a-f]{64}$/u.test(owner.configurationId) ||
        Object.keys(owner).length !== 3
      : owner !== undefined
  ) {
    throw new Error("Invalid protected Driver registration in execution admission.");
  }
}

/** Default cutoff for Compute implementations without protected installation and release. */
export function assertExecutionReleaseAllowed(
  revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
): void {
  assertExecutionAdmission(revision);
  if (revision.executionAdmission.mode === "protected") {
    throw new Error(
      "Protected execution is unavailable on a Compute without exact installation and release.",
    );
  }
}
