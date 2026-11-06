/** Shared operator metadata, independent of Agent desired state and deployment. */
export interface AgentControlUiBookmark {
  readonly url: string | null;
  readonly version: number;
}

export interface UpdateAgentControlUiBookmark {
  readonly url: string | null;
  readonly expectedVersion: number;
}

/** Validate only: a bookmark is never fetched or used as runtime configuration. */
export function isValidAgentControlUiBookmarkUrl(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    /[\s\\?#]/u.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    !value.startsWith("https://")
  ) {
    return false;
  }
  const authority = value.slice("https://".length).split("/")[0]!;
  if (!authority || authority.includes("@") || authority.includes("%")) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}
