/** The material owner blocks replacement and retirement while this hold stands. */
export interface MaterialWriteHold {
  /**
   * True until release starts or the hold limit passes; the Provider write is dispatched only
   * while it holds. A local answer: it cannot see a lock the database has already ended.
   */
  held(): boolean;
  /**
   * Asks the lock's owner whether the hold still stands (for a row lock, a round trip on the
   * holding session), and ends the hold when it does not. Called before dispatch and after the response.
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
