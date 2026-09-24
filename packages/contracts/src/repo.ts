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

export interface RepositoryOption {
  readonly repositoryRef: string;
  readonly displayName: string;
  readonly allowedProfiles: readonly string[];
}

export interface AdmittedRepositoryBinding extends RepositoryBindingSelection {
  readonly providerId: string;
  readonly grant: RepositoryCredentialGrantIdentity;
}

export interface RepositoryCredentialResolution {
  readonly bindings: readonly AdmittedRepositoryBinding[];
  readonly sessionDurationSeconds: number;
}

export interface RepositoryRevisionState {
  /** Nonempty opaque values use the same 512-byte, no-control bound as grant identities. */
  readonly driver: { readonly id: string; readonly implementation: string };
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

export interface RepoDriver extends Driver {
  readonly capability: "repo";
  readonly maintenanceIntervalMs: number;
  listOptions(input: { readonly namespaceId: string }): readonly RepositoryOption[];
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
} & (
    | { readonly kind: "new"; readonly files: RepositoryCredentialSessionFiles }
    | { readonly kind: "retained" }
  );
