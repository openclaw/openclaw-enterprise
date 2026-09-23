export interface RepositoryCredentialClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
  readonly pushRefAllowlist?: readonly string[];
}

/** Canonical nonsecret native-push policy. Git refs remain case-sensitive. */
export function normalizePushRefAllowlist(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid-push-ref-allowlist");
  }
  const entries = value.map((entry: unknown) => {
    if (typeof entry !== "string") {
      throw new Error("invalid-push-ref-allowlist");
    }
    const ref = entry.endsWith("/*") ? entry.slice(0, -1) + "branch" : entry;
    if (
      !ref.startsWith("refs/heads/") ||
      ref.length === "refs/heads/".length ||
      [...ref].some(
        (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
      ) ||
      /[~^:?*[\\]/.test(ref) ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.endsWith(".") ||
      ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
    ) {
      throw new Error("invalid-push-ref-allowlist");
    }
    return entry;
  });
  return Object.freeze([...new Set(entries)].sort());
}

export function allowsPushRef(allowlist: readonly string[], ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    allowlist.some((entry) =>
      entry.endsWith("/*") ? ref.startsWith(entry.slice(0, -1)) : ref === entry,
    )
  );
}
