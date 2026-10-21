import { isDeepStrictEqual } from "node:util";

/** Trusted admission, never constructed from a request's repository or rights. */
export interface TokenAdmission {
  readonly familyId: string;
  readonly issuerAuthority: string;
  readonly generation: number;
  readonly ownerEpoch: number;
  readonly inputVersion: string;
  /** An immutable normalized grant, including all provider-specific scope. */
  readonly grant: Readonly<{ id: string; isolationId: string }>;
}

export interface TokenMaterial<A extends TokenAdmission> {
  readonly admission: A;
  readonly attemptId: string;
  /** Opaque version of this committed material, independent of the attempt and token. */
  readonly materialVersion: string;
  /** Exact verified provider expiry; usableUntil includes the existing skew margin. */
  readonly providerExpiresAt: number;
  readonly usableUntil: number;
  readonly bytes: Uint8Array;
}

export interface TokenAttempt<A extends TokenAdmission> {
  readonly id: string;
  readonly admission: A;
  state: "issuing" | "committed" | "quarantined";
  materialVersion?: string;
  /** Retained only for trusted cleanup, never eligible for warm reads. */
  candidate?: Uint8Array;
}

/** Private repository fragment. Admission and recovery belong to OCC. */
export interface TokenFamily<A extends TokenAdmission> {
  admission: A;
  /** This bounded implementation refuses shared families with multiple grants. */
  admittedGrantCount: number;
  enabled: boolean;
  attempts: TokenAttempt<A>[];
  committed?: TokenMaterial<A>;
}

export interface TokenReadPort<A extends TokenAdmission> {
  /**
   * Linearizable read against latest admission, not a replica/cache. Invoke select
   * once under the family lock and release its detached result at the read's
   * linearization point. No issuance, Secret resolution or scheduling is allowed.
   */
  readCurrent<T>(familyId: string, select: (row: TokenFamily<A> | undefined) => T): Promise<T>;
}

export interface TokenPreparationStore<A extends TokenAdmission> extends TokenReadPort<A> {
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
    update: (row: TokenFamily<A> | undefined, allocateMaterialVersion: () => string) => T,
  ): Promise<T>;
}

/** Compare the whole admitted scope; new provider fields must not become implicit wildcards. */
export function sameTokenAdmission(a: TokenAdmission, b: TokenAdmission): boolean {
  return isDeepStrictEqual(a, b);
}

export function preparationAdmitted<A extends TokenAdmission>(
  row: TokenFamily<A> | undefined,
  admission: A,
): row is TokenFamily<A> {
  return (
    !!row &&
    row.enabled &&
    row.admittedGrantCount === 1 &&
    sameTokenAdmission(row.admission, admission)
  );
}
