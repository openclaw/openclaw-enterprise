/**
 * Serializes a lent credential's Provider write with its owner's replacement and retirement.
 * The owner of the material keeps a lock that those writers wait on from its state and version
 * check until the Provider write returns; the writer sends nothing once the hold has ended.
 */
export interface MaterialWriteHold {
  /** True until release starts; the Provider write is dispatched only while it holds. */
  held(): boolean;
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
