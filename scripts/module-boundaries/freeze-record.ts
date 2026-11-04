// Records cross stage boundaries as immutable values; ASTs stay in source analysis.
export function freezeRecord<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecord(child);
  }
  return Object.freeze(value);
}
