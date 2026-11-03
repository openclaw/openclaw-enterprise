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
 * An `immutableCopy` that is also recorded as a snapshot, so consumers may memoize what they
 * derive from it by object identity (`isImmutableSnapshot`). Pass only plain JSON-like data
 * (objects, arrays, primitives): `deepFreeze` cannot freeze the contents of a Map, Set, Date
 * or typed array, so a snapshot holding one could still change.
 */
export function immutableSnapshot<T extends object>(value: T): Readonly<T> {
  const snapshot = immutableCopy(value);
  immutableSnapshots.add(snapshot);
  return snapshot;
}

/**
 * An `immutableSnapshot` of a value the caller has just built and shares with nobody: it is
 * frozen in place, without the copy. Any object in it, the value itself included, that is
 * already frozen must be frozen all the way down (as `immutableCopy` and `deepFreeze` leave
 * it), because `deepFreeze` stops at a frozen object. The same plain-data rule as `immutableSnapshot` applies.
 */
export function freezeSnapshot<T extends object>(value: T): Readonly<T> {
  const snapshot = deepFreeze(value);
  immutableSnapshots.add(snapshot);
  return snapshot;
}

/** Whether `value` came from `immutableSnapshot` or `freezeSnapshot`, so it can never change. */
export function isImmutableSnapshot(value: unknown): boolean {
  return typeof value === "object" && value !== null && immutableSnapshots.has(value);
}
