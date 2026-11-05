import { hasControlCharacter } from "../../drivers/repo/credentials/client-contracts.ts";

/** Identical private JSON primitives; each boundary owns its failure diagnostic. */
export function createStatusWirePrimitives(invalid: () => never) {
  function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(value, key))
    ) {
      return invalid();
    }
    return value as Record<string, unknown>;
  }

  function identity(value: unknown): string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > 512 ||
      hasControlCharacter(value)
    ) {
      return invalid();
    }
    return value;
  }

  function counter(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return invalid();
    }
    return value;
  }

  return { object, identity, counter };
}
