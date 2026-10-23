/** The sender's installed version. Neither identifier is a token or a grant of access. */
export interface InstalledTokenVersion {
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
}

export interface CurrentTokenVersion extends InstalledTokenVersion {
  /** Absolute wall-clock milliseconds; the caller may only tighten this bound. */
  readonly usableUntil: number;
}

/**
 * Private access inside the caller's existing authorization transaction. The caller locks live
 * execution and source authority first, then keeps both locks through its installation decision or
 * possible-use record (and any grant debit). No method prepares, issues, or schedules work.
 */
export interface TokenMaterialReader<Transaction, Source> {
  /** Trusted sender only. Open under the lock; clear bytes on refusal, lost commit, or transfer. */
  readWarm(
    tx: Transaction,
    source: Source,
  ): Promise<(CurrentTokenVersion & { open(): Buffer }) | undefined>;
  /** Lock this exact current version, without selecting encrypted or plaintext material. */
  current(
    tx: Transaction,
    source: Source,
    installed: InstalledTokenVersion,
  ): Promise<(CurrentTokenVersion & { readonly open?: never }) | undefined>;
}
