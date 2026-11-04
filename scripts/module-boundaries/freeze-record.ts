// Records cross stage boundaries as immutable values; ASTs stay in source analysis.
export function freezeRecord<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  const children: unknown[] = Object.values(value);
  for (const child of children) {
    freezeRecord(child);
  }
  return Object.freeze(value);
}
