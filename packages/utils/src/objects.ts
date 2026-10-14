/** Return a non-null, non-array object without copying or checking its prototype. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const property of Object.values(value)) {
    deepFreeze(property);
  }

  return value;
}

export function immutableCopy<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

const immutableSnapshots = new WeakSet<object>();

/**
 * An `immutableCopy` that is also recorded as a snapshot: a deep-frozen structured clone
 * holding only plain data, which can never change. Consumers may therefore memoize what
 * they derive from it by object identity (`isImmutableSnapshot`).
 */
export function immutableSnapshot<T extends object>(value: T): Readonly<T> {
  const snapshot = immutableCopy(value);
  immutableSnapshots.add(snapshot);
  return snapshot;
}

/** Whether `value` came from `immutableSnapshot`, so it can never change. */
export function isImmutableSnapshot(value: unknown): boolean {
  return typeof value === "object" && value !== null && immutableSnapshots.has(value);
}
