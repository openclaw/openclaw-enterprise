import type { GitHubTokenProfile } from "./types.ts";

/** Trusted admission, never constructed from a request's repository or rights. */
export interface GitHubPreparationAdmission {
  readonly familyId: string;
  readonly issuerAuthority: string;
  readonly generation: number;
  readonly ownerEpoch: number;
  readonly inputVersion: string;
  readonly grant: Readonly<{
    id: string;
    isolationId: string;
    appId: string;
    installationId: string;
    repositoryId: string;
    repository: string;
    profile: GitHubTokenProfile;
    /** Only the repository Git family has an exact admitted review ref. */
    pushRef?: string;
    pullRequestBase?: string;
  }>;
}

export interface GitHubPreparedMaterial {
  readonly admission: GitHubPreparationAdmission;
  readonly attemptId: string;
  /** Opaque version of this committed material, independent of the attempt and token. */
  readonly materialVersion: string;
  /** Exact verified provider expiry; usableUntil includes the existing skew margin. */
  readonly providerExpiresAt: number;
  readonly usableUntil: number;
  readonly bytes: Uint8Array;
}

export interface GitHubPreparationAttempt {
  readonly id: string;
  readonly admission: GitHubPreparationAdmission;
  state: "issuing" | "committed" | "quarantined";
  materialVersion?: string;
  /** Retained only for trusted cleanup, never eligible for warm reads. */
  candidate?: Uint8Array;
}

/** Private repository fragment. Admission and recovery belong to OCC. */
export interface GitHubPreparationFamily {
  admission: GitHubPreparationAdmission;
  /** This bounded implementation refuses shared families with multiple grants. */
  admittedGrantCount: number;
  enabled: boolean;
  attempts: GitHubPreparationAttempt[];
  committed?: GitHubPreparedMaterial;
}

export interface GitHubPreparedReadPort {
  /**
   * Linearizable read against latest admission, not a replica/cache. Invoke select
   * once under the family lock and release its detached result at the read's
   * linearization point. No issuance, Secret resolution or scheduling is allowed.
   */
  readCurrent<T>(
    familyId: string,
    select: (row: GitHubPreparationFamily | undefined) => T,
  ): Promise<T>;
}

export interface GitHubPreparationStore extends GitHubPreparedReadPort {
  /**
   * Serializable durable transaction/CAS under a family-wide lock shared with
   * admission, withdrawal and takeover. Commit the entire fragment atomically
   * before resolving. The synchronous callback runs once on an isolated draft;
   * no reference may escape. On a thrown/ambiguous commit, callers cannot assume
   * rollback. Never discard attempts (including successes) on epoch/input change.
   * Encrypt material at rest; do not log callback values or row contents.
   * Allocate an opaque, store-qualified material version, never reused or derived from the token.
   * Recovery must explicitly settle quarantined/issuing attempts before reuse.
   */
  transact<T>(
    familyId: string,
    update: (row: GitHubPreparationFamily | undefined, allocateMaterialVersion: () => string) => T,
  ): Promise<T>;
}

export function samePreparationAdmission(
  a: GitHubPreparationAdmission,
  b: GitHubPreparationAdmission,
): boolean {
  return (
    a.familyId === b.familyId &&
    a.issuerAuthority === b.issuerAuthority &&
    a.generation === b.generation &&
    a.ownerEpoch === b.ownerEpoch &&
    a.inputVersion === b.inputVersion &&
    a.grant.id === b.grant.id &&
    a.grant.isolationId === b.grant.isolationId &&
    a.grant.appId === b.grant.appId &&
    a.grant.installationId === b.grant.installationId &&
    a.grant.repositoryId === b.grant.repositoryId &&
    a.grant.repository === b.grant.repository &&
    a.grant.profile === b.grant.profile &&
    a.grant.pushRef === b.grant.pushRef &&
    a.grant.pullRequestBase === b.grant.pullRequestBase
  );
}

export function preparationAdmitted(
  row: GitHubPreparationFamily | undefined,
  admission: GitHubPreparationAdmission,
): row is GitHubPreparationFamily {
  return (
    !!row &&
    row.enabled &&
    row.admittedGrantCount === 1 &&
    samePreparationAdmission(row.admission, admission)
  );
}
