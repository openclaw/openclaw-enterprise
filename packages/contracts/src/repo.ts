import type { Driver } from "./index.ts";

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
  readonly descriptionsPending: boolean;
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

export interface RepoDriver extends Driver {
  readonly capability: "repo";
  readonly maintenanceIntervalMs: number;
  /** This Driver fences admission and retains confirmed terminal evidence durably. */
  readonly durableBrokerReceipts?: true;
  /** Check whether fresh credential admission is currently supported. */
  checkAdmissionReady?(signal: AbortSignal): Promise<void>;
  listOptions(input: {
    readonly namespaceId: string;
    readonly descriptionRefs?: readonly string[];
  }): Promise<RepositoryOptions>;
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
