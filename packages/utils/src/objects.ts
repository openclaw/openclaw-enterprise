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
