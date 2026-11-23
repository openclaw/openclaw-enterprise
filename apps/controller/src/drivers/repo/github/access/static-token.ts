import type {
  GitHubStaticTokenOptions,
  GitHubStaticTokenOwner,
  GitHubTokenClass,
} from "./types.ts";

// Longest prefix first: "github_pat_" must not be read as an unknown "gh" token.
const prefixes: readonly (readonly [string, GitHubTokenClass])[] = [
  ["github_pat_", "fine-grained"],
  ["ghp_", "classic"],
  ["gho_", "oauth"],
  ["ghu_", "app-user"],
  ["ghs_", "app-installation"],
];

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length <= prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** Reads only the documented prefix; no other byte is returned or retained. */
export function classifyGitHubToken(bytes: Uint8Array): GitHubTokenClass {
  return prefixes.find(([prefix]) => startsWith(bytes, prefix))?.[1] ?? "unknown";
}

/** The process owns this token; finalizing a session never closes it. */
export function createGitHubStaticTokenOwner({
  token,
}: GitHubStaticTokenOptions): GitHubStaticTokenOwner {
  if (
    !(token instanceof Uint8Array) ||
    token.length < 1 ||
    token.length > 16384 ||
    !token.every((byte) => byte >= 0x21 && byte <= 0x7e)
  ) {
    throw new Error("invalid-token");
  }
  let bytes: Uint8Array | undefined = Uint8Array.from(token);
  const tokenClass = classifyGitHubToken(bytes);
  const assertCurrent = () => {
    if (!bytes) {
      throw new Error("authority-unavailable");
    }
  };
  return Object.freeze<GitHubStaticTokenOwner>({
    kind: "github-token",
    tokenClass,
    async withToken<T>(
      consume: (lent: Uint8Array, assertCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      const copy = Uint8Array.from(bytes!);
      try {
        return await consume(copy, assertCurrent);
      } finally {
        copy.fill(0);
      }
    },
    close() {
      bytes?.fill(0);
      bytes = undefined;
    },
  });
}
