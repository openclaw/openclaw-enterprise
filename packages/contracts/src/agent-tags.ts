/** User-owned, non-secret metadata snapshotted into each AgentRevision. */
export type AgentTags = Readonly<Record<string, string>>;

function characterLength(value: string): number {
  return Array.from(value).length;
}

const invalidUnicode = /[\uD800-\uDFFF]/u;

/** Validate and copy an Agent-owned tag map without invoking `__proto__` setters. */
export function normalizeAgentTags(input: unknown): AgentTags {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Agent tags must be a string map.");
  }

  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Agent tags must use string keys.");
  }
  if (keys.length > 64) {
    throw new Error("Too many Agent tags.");
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const key of keys as string[]) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (property === undefined || !property.enumerable || !("value" in property)) {
      throw new Error("Agent tags must contain plain string values.");
    }
    if (
      characterLength(key) < 1 ||
      characterLength(key) > 128 ||
      key.includes("\u0000") ||
      invalidUnicode.test(key)
    ) {
      throw new Error("An Agent tag key is invalid.");
    }
    if (
      typeof property.value !== "string" ||
      characterLength(property.value) > 1024 ||
      property.value.includes("\u0000") ||
      invalidUnicode.test(property.value)
    ) {
      throw new Error("An Agent tag value is invalid.");
    }
    normalized[key] = property.value;
  }
  return Object.freeze(normalized);
}
