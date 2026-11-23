/**
 * Serializes a lent credential's Provider write with its owner's replacement and retirement.
 * The owner of the material keeps a lock that those writers wait on from its state and version
 * check until the Provider write returns; the writer sends nothing once the hold has ended.
 */
export interface MaterialWriteHold {
  /**
   * True until release starts or the hold limit passes; the Provider write is dispatched only
   * while it holds. A local answer: it cannot see a lock the database has already ended.
   */
  held(): boolean;
  /**
   * Asks the lock's owner whether the hold still stands (for a row lock, a round trip on the
   * holding session), and ends the hold when it does not. Called right before the write.
   * Never throws.
   */
  confirm(): Promise<boolean>;
  /** Ends the hold. Idempotent; never throws. */
  release(): Promise<void>;
}

const writeHold = Symbol("repository-material-write-hold");

/** Attaches the hold without making it part of the material's compared identity. */
export function withWriteHold<T extends object>(material: T, hold: MaterialWriteHold): T {
  Object.defineProperty(material, writeHold, { value: hold, enumerable: false });
  return material;
}

export function writeHoldOf(material: unknown): MaterialWriteHold | undefined {
  return material !== null && typeof material === "object"
    ? ((material as { [writeHold]?: MaterialWriteHold })[writeHold] ?? undefined)
    : undefined;
}
