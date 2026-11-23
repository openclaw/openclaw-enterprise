import { classifyGitHubToken } from "@openclaw-enterprise/contracts";

import type { GitHubStaticTokenOptions, GitHubStaticTokenOwner } from "./types.ts";

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
