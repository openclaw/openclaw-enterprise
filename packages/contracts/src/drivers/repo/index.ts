import type { RepositoryGitDeliveryProfile } from "../credential-proxy/index.ts";
import type { Driver } from "../index.ts";

/** Opaque, nonempty identities: at most 512 UTF-8 bytes each, without ASCII controls. */
export type RepositoryCredentialGrantIdentity = Readonly<{
  providerInstanceId: string;
  repositoryId: string;
  grantId: string;
}>;

export interface RepositoryCredentialSessionStatus {
  readonly sessionId: string;
  readonly state: "OPEN" | "CLOSED" | "DISPOSED";
  readonly deadlineWallMs: number;
  readonly binding: RepositoryCredentialGrantIdentity;
}

/** Installation-wide GitHub access must be explicitly selected, never inherited as a default. */
export const githubInstallationProfile = "github-installation";

/** An installation-scoped binding is always explicit, exclusive, and delivered by a protected sender. */
export function isInstallationRepositoryProfile(
  profile: unknown,
): profile is typeof githubInstallationProfile {
  return profile === githubInstallationProfile;
}

export interface RepositoryBindingRequest {
  readonly repositoryRef: string;
  readonly profile?: string;
}

export interface RepositoryBindingSelection {
  readonly repositoryRef: string;
  readonly profile: string;
}

/** Desired editing intent; admission always resolves concrete binding profiles. */
export interface RepositoryAccess {
  readonly defaultProfile: string;
  readonly repositories: readonly RepositoryBindingRequest[];
}

export interface RepositoryOption {
  readonly repositoryRef: string;
  readonly displayName: string;
  readonly allowedProfiles: readonly string[];
  /** Optional provider-supplied plain text; selection never depends on its availability. */
  readonly description?: string;
}

export interface RepositoryOptions {
  readonly options: readonly RepositoryOption[];
}

export interface AdmittedRepositoryBinding extends RepositoryBindingSelection {
  readonly backendId: string;
  readonly grant: RepositoryCredentialGrantIdentity;
}

export interface RepositoryCredentialResolution {
  readonly bindings: readonly AdmittedRepositoryBinding[];
  readonly sessionDurationSeconds: number;
}

/** Nonsecret identity obtained by a read-only verification of the already running execution. */
export interface RepositoryExecutionIdentity {
  readonly executionId: string;
  readonly fingerprint: string;
}

export interface RepositoryRevisionState {
  /** Nonempty opaque values use the same 512-byte, no-control bound as grant identities. */
  readonly driver: { readonly id: string; readonly implementation: string };
  /** Present only after an explicit, attributable standing approval. The retained
   * deadline is the original finite admission boundary, not standing authority. */
  readonly standingApprovalId?: string;
  readonly standingApprovalGeneration?: number;
  readonly standingApprovalScopeFingerprint?: string;
  readonly deadlineWallMs: number;
  readonly bindings: readonly AdmittedRepositoryBinding[];
}

export interface OpenRepositorySessionInput {
  readonly namespaceId: string;
  readonly admissionId: string;
  readonly binding: AdmittedRepositoryBinding;
  readonly durationSeconds: number;
  readonly deadlineWallMs: number;
  /** Restricts the operation to recovered/missing results, without creating authority. */
  readonly recoverOnly?: true;
  /** Retain the original prepared authority during lookup-only recovery. Fresh opens require it. */
  readonly preparedOnly?: true;
}

export type OpenRepositorySessionResult =
  | {
      readonly kind: "created";
      readonly session: RepositoryCredentialSessionStatus;
      readonly files: RepositoryCredentialSessionFiles;
    }
  | { readonly kind: "recovered"; readonly status: RepositoryCredentialSessionStatus }
  | { readonly kind: "missing" };

/** Canonical JSON-compatible provider scope; contains no credentials. */
export type RepositoryApprovalValue =
  | null
  | boolean
  | number
  | string
  | readonly RepositoryApprovalValue[]
  | { readonly [key: string]: RepositoryApprovalValue };
export type RepositoryApprovalScope = Readonly<Record<string, RepositoryApprovalValue>>;

export interface RepositoryPolicyDriver extends Driver {
  readonly capability: "repo";
  listOptions(input: { readonly namespaceId: string }): Promise<RepositoryOptions>;
  standingApprovalScope?(input: {
    readonly namespaceId: string;
    readonly binding: AdmittedRepositoryBinding;
  }): RepositoryApprovalScope | undefined;
  /** Current policy permission only; persisted operator approval is checked by OCC. */
  allowsStandingApproval?(input: {
    readonly namespaceId: string;
    readonly binding: AdmittedRepositoryBinding;
  }): boolean;
  resolve(input: {
    readonly namespaceId: string;
    readonly bindings: readonly RepositoryBindingRequest[];
  }): RepositoryCredentialResolution;
}

/** Explicit native sender and retained-session cleanup owner; never a protected fallback. */
export interface NativeRepositorySender {
  readonly id: string;
  readonly implementation: string;
  readonly maintenanceIntervalMs: number;
  /** This sender fences admission and retains confirmed terminal evidence durably. */
  readonly durableBrokerReceipts?: true;
  /** Check whether fresh credential admission is currently supported. */
  checkAdmissionReady?(signal: AbortSignal): Promise<void>;
  open(
    input: OpenRepositorySessionInput,
    signal: AbortSignal,
  ): Promise<OpenRepositorySessionResult>;
  status(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined>;
  close(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined>;
}

/** Ephemeral UTF-8 contents; Compute owns paths, modes, and runtime material objects. */
export type RepositoryCredentialSessionFiles = Readonly<{
  bearer: string;
  "client.json": string;
  gitconfig: string;
  "gh/hosts.yml": string;
  "gh/config.yml": string;
  "ca.pem"?: string;
}>;

export interface RepositoryCredentialMaterialRef {
  readonly repositoryRef: string;
  readonly sessionId: string;
}

export type RepositoryCredentialRuntimeBinding = RepositoryCredentialMaterialRef & {
  readonly deadlineWallMs: number;
  /** Original persisted attempt identity for correlation; it is not an authority proof. */
  readonly admissionId?: string;
} & (
    | { readonly kind: "new"; readonly files: RepositoryCredentialSessionFiles }
    | { readonly kind: "retained" }
  );

/** The Repo contract owns the mapping from admitted profiles to sender requirements. */
export function repositoryGitDeliveryProfile(
  repository: RepositoryRevisionState | undefined,
): RepositoryGitDeliveryProfile | undefined {
  if (
    repository?.bindings?.length &&
    repository.bindings.every((b) => b.profile === "github-repository")
  ) {
    return "github_repository";
  }
  if (repository?.bindings?.length !== 1) {
    return undefined;
  }
  const profile = repository.bindings[0]?.profile;
  return isInstallationRepositoryProfile(profile)
    ? "github_installation"
    : profile === "git-write"
      ? "repository_git"
      : undefined;
}
