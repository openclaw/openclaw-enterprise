import type {
  CredentialProxyBinding,
  CredentialProxyExchange,
  EgressExchangeOwner,
} from "./credential-proxy-exchange.ts";
import { repositoryGitDeliveryProfile } from "./repo.ts";

export { repositoryGitDeliveryProfile } from "./repo.ts";
import type {
  ProtectedRepositoryGitAuthority,
  RepositoryGitBinding,
} from "./protected-repository-git.ts";
import type {
  CredentialFreeEgressSource,
  CredentialFreeMetadataGrant,
  NoMaterialSelection,
} from "./credential-free-metadata.ts";
import type { GitHubMetadataGrant } from "./prepared-github-egress.ts";
import type {
  PreparedTokenGrant,
  PreparedTokenSource,
  PreparedTokenEvidence,
} from "./prepared-token.ts";
import type { Driver, DriverRegistrationRef } from "./driver.ts";
import type {
  AgentRevision,
  CredentialSource,
  CredentialSourceType,
  HarnessAuthSnapshot,
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
  StaticEgressSource | PreparedTokenSource | CredentialFreeEgressSource;

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
  readonly grant:
    InferenceGrant | GitHubMetadataGrant | CredentialFreeMetadataGrant | PreparedTokenGrant;
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
  /** Capability required by this admission, including after process restart. */
  readonly policyReductionVersion?: 1 | 2;
  /** v4–v7: the repository or installation grant, independent of sender and grant duration. */
  readonly repositoryGit?: RepositoryRevisionState;
  /** v4/v7 are exact dispatch; v5 requires online authorization; v6 records an observed request hook. */
  readonly repositoryGitAuthorization?: "online-request" | "request-hook-observed";
  /** v4–v7: the Harness model attachment independently admitted by the Credential Gateway. */
  readonly harnessCredentialSource?: Extract<HarnessAuthSnapshot, { method: "credential_source" }>;
  readonly routes: readonly EgressRoute[];
}

/**
 * Stable recipient observed by the installed Driver, in the same enforcement evidence as its
 * execution instance and sender guarantee. Provider and supervisor connection versions may rotate.
 */
export const repositoryGitRecipientFields = Object.freeze([
  "providerId",
  "attachmentEpoch",
  "processInstanceId",
  "networkInstanceId",
] as const);
export type RepositoryGitRecipient = Readonly<
  Record<(typeof repositoryGitRecipientFields)[number], string> & {
    /** Absent on the original repository Git wire. Installation scope needs positive evidence. */
    deliveryProfile?: "github_installation";
    /** v5 requires online authorization before injection for every new request. In v6 we
     * observed that hook at startup; a trusted operator could subsequently make stock skip it.
     * Both require verified TLS, a dedicated fresh recipient, and no bypass in the admitted
     * configuration. An already authorized request may finish. v4 enforces exact send start. */
    authorization?: "online-request" | "request-hook-observed";
    /** Per-start denial, present only in the explicitly admitted preview. */
    observedHook?: Readonly<{ startupId: string; observationId: string }>;
  }
>;

export type RepositoryGitDeliveryProfile = "repository_git" | "github_installation";

export function validRepositoryGitRecipient(
  value: RepositoryGitRecipient | undefined,
  profile: RepositoryGitDeliveryProfile | undefined,
  authorization?: ProxyPlan["repositoryGitAuthorization"],
): boolean {
  return (
    !!value &&
    profile !== undefined &&
    (authorization === undefined ||
      authorization === "online-request" ||
      (authorization === "request-hook-observed" &&
        profile === "github_installation" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value.observedHook?.startupId ?? "",
        ) &&
        /^[0-9a-f]{64}$/.test(value.observedHook?.observationId ?? ""))) &&
    value.authorization === authorization &&
    (authorization === "request-hook-observed" || value.observedHook === undefined) &&
    value.deliveryProfile === (profile === "github_installation" ? profile : undefined) &&
    repositoryGitRecipientFields.every(
      (key) => typeof value[key] === "string" && value[key].trim().length > 0,
    )
  );
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
    /** Required for protected repository Git. Never infer this association from a matching policy. */
    readonly repositoryGitRecipient?: RepositoryGitRecipient;
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
  | { readonly kind: "prepared_scope"; readonly action: string }
  | {
      readonly kind: "github_repository_metadata" | "credential_free_repository_metadata";
      readonly repository: string;
      readonly repositoryId: string;
    };

export type EgressMaterialEvidence = StaticMaterialEvidence | PreparedTokenEvidence;

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
  ): InferenceGrant | GitHubMetadataGrant | CredentialFreeMetadataGrant | PreparedTokenGrant;
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
  readonly backend: EgressRef;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  readonly providers: readonly CredentialProviderDefinition[];
  /** Capability evidence is obtained from the actual configured counterpart, never inferred. */
  assertAvailable(
    signal: AbortSignal,
    profile?: RepositoryGitDeliveryProfile,
  ): Promise<
    | void
    | "github_installation"
    | {
        readonly profile: RepositoryGitDeliveryProfile;
        readonly authorization: "online-request" | "request-hook-observed";
      }
  >;
}

/** An older Driver may silently ignore a new profile argument. Only an explicit confirmation
 * qualifies it to attempt installation-wide Git (Basic) and GitHub API (Bearer) delivery,
 * and a v4 sender must enforce the original send cutoff. Online authorization requires a
 * distinct positive response; discovery is not proof of the installed enforcement. */
export async function repositoryGitAuthorization(
  control: CredentialSourceControl,
  signal: AbortSignal,
  profile?: RepositoryGitDeliveryProfile,
): Promise<"exact-dispatch" | "online-request" | "request-hook-observed" | "unavailable"> {
  const confirmed = await control.assertAvailable(signal, profile);
  if (profile && typeof confirmed === "object" && confirmed !== null) {
    if (
      profile === "github_installation" &&
      confirmed.profile === profile &&
      confirmed.authorization === "request-hook-observed"
    ) {
      return "request-hook-observed";
    }
    return confirmed.profile === profile && confirmed.authorization === "online-request"
      ? "online-request"
      : "unavailable";
  }
  return (confirmed === undefined && profile !== "github_installation") ||
    (profile === "github_installation" && confirmed === profile)
    ? "exact-dispatch"
    : "unavailable";
}

/** Compatibility query for a sender that implements the v4 exact-dispatch contract. */
export async function repositoryGitProfileAvailable(
  control: CredentialSourceControl,
  signal: AbortSignal,
  profile?: RepositoryGitDeliveryProfile,
): Promise<boolean> {
  return (await repositoryGitAuthorization(control, signal, profile)) === "exact-dispatch";
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

/** Versioned, compare-and-reduce operation. The paired Sandbox must retain deny-all
 * when routes is empty. No creation, replacement, expansion or business request replay. */
export interface CredentialPolicyReduction {
  readonly version: 1 | 2;
  readonly operationId: string;
  readonly expected: EgressInstallation;
  readonly retained: ProxyPlan;
}

/** Positive observation from the enforcing peer, independently queried after apply. */
export interface CredentialPolicyObservation {
  readonly operationId: string;
  readonly installation: EgressInstallation;
}

/** Capability of the paired Credential Proxy and Sandbox. Every installation path must
 * honor persistent reduction tombstones: stale configure/enroll cannot restore a route.
 * Observation identifies the currently enforced policy, not just an accepted request.
 * An already authorized send may finish; this does not replace per-request OCC checks. */
export type CredentialPolicyReducer = CredentialPolicyReducerOperations &
  (
    | { readonly version: 1 }
    | {
        /** v2 also removes repositoryGit, preserving the exact recipient and other bindings. */
        readonly version: 2;
        /** Authenticate the configured enforcing counterpart's reduction capability. */
        assertAvailable(signal: AbortSignal): Promise<void>;
      }
  );

interface CredentialPolicyReducerOperations {
  /** Compare exact Driver registration, execution, recipient and policy generation before
   * applying. Persist operation identity and reject stale or conflicting reductions. */
  apply(context: ProxyRevisionContext, reduction: CredentialPolicyReduction): Promise<void>;
  /** Inspect the original operation and current enforced policy; never apply or repair. */
  observe(
    context: ProxyRevisionContext,
    reduction: CredentialPolicyReduction,
  ): Promise<CredentialPolicyObservation | undefined>;
}

export interface CredentialPolicyWithdrawalOptions {
  readonly recheck?: boolean;
  readonly reducePolicy?: (
    context: ProxyRevisionContext,
  ) => Promise<"withdrawn" | "pending" | "retire-runtime">;
}

export interface CredentialProxyDriver extends Driver {
  readonly capability: "credential_proxy";
  readonly sourceControl: CredentialSourceControl;
  readonly policyReduction?: CredentialPolicyReducer;
  /** API process: bind the installed transport's exchange owner once, before accepting requests. */
  bindExchange?(
    createCredentialProxy: (owner: EgressExchangeOwner) => CredentialProxyExchange,
  ): Promise<CredentialProxyBinding>;
  /** Worker process: bind this sender to the installation's checked Git delivery authority. */
  bindRepositoryGit?(authority: ProtectedRepositoryGitAuthority): Promise<RepositoryGitBinding>;
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
  removeRevision(context: ProxyRevisionContext): Promise<boolean>;
}

/** Durable admission semantics. v7 adds verified Git policy reduction to exact dispatch. */
export type ExecutionAdmission =
  | { readonly version: 2; readonly mode: "unprotected" }
  | { readonly version: 3 | 4 | 5 | 6 | 7; readonly mode: "protected" };

export function protectedRepositoryGitAdmission(
  admission: ExecutionAdmission | undefined,
): boolean {
  return (
    admission?.version === 4 ||
    admission?.version === 5 ||
    admission?.version === 6 ||
    admission?.version === 7
  );
}

/** Recognition only. A valid protected schema is not proof of deployability. */
export function assertExecutionAdmission(
  revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
): void {
  const admission = revision.executionAdmission;
  if (
    !admission ||
    (!(admission.version === 2 && admission.mode === "unprotected") &&
      !(
        (admission.version === 3 || protectedRepositoryGitAdmission(admission)) &&
        admission.mode === "protected"
      )) ||
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
  const plan = revision.egressPlan;
  if (
    (plan?.policyReductionVersion !== undefined &&
      !(
        (plan.policyReductionVersion === 1 && admission.version === 3) ||
        (plan.policyReductionVersion === 2 && admission.version === 7)
      )) ||
    (plan &&
      new Set(plan.routes.map((route) => route.binding.source.source.id)).size > 1 &&
      plan.policyReductionVersion === undefined)
  ) {
    throw new Error("Protected execution requires its admitted policy reduction capability.");
  }
  if (admission.version === 7 && plan?.policyReductionVersion !== 2) {
    throw new Error("Reducible repository Git requires reduction version 2.");
  }
  const repository = revision.egressPlan?.repositoryGit;
  if (
    (protectedRepositoryGitAdmission(admission)
      ? !repositoryGitDeliveryProfile(repository)
      : repository !== undefined) ||
    (admission.version === 6
      ? revision.egressPlan?.repositoryGitAuthorization !== "request-hook-observed" ||
        repositoryGitDeliveryProfile(repository) !== "github_installation"
      : admission.version === 5
        ? revision.egressPlan?.repositoryGitAuthorization !== "online-request"
        : revision.egressPlan?.repositoryGitAuthorization !== undefined)
  ) {
    throw new Error("Repository Credential Proxy requires its own protected execution admission.");
  }
  const source = revision.egressPlan?.harnessCredentialSource;
  if (
    source !== undefined &&
    (!protectedRepositoryGitAdmission(admission) ||
      source.method !== "credential_source" ||
      !source.sourceId ||
      !source.credentialGatewayId ||
      !source.sourceType ||
      (admission.version !== 7 && revision.egressPlan!.routes.length !== 0))
  ) {
    throw new Error(
      "Invalid independent Harness credential source in repository execution admission.",
    );
  }
  const owner = revision.egressPlan?.driver;
  if (
    admission.version === 3 || protectedRepositoryGitAdmission(admission)
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
