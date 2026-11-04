import type { GitLabStaticTokenOwner, GitLabTokenClass } from "./types.ts";

/** GitLab personal and fine-grained access tokens share the documented `glpat-` prefix. */
export function classifyGitLabToken(bytes: Uint8Array): GitLabTokenClass {
  const prefix = "glpat-";
  if (bytes.length <= prefix.length) {
    return "unknown";
  }
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) {
      return "unknown";
    }
  }
  return "personal";
}

/** The process owns this token; finalizing a session never closes it. */
export function createGitLabStaticTokenOwner({
  token,
}: {
  readonly token: Uint8Array;
}): GitLabStaticTokenOwner {
  if (
    !(token instanceof Uint8Array) ||
    token.length < 1 ||
    token.length > 16384 ||
    !token.every((byte) => byte >= 0x21 && byte <= 0x7e)
  ) {
    throw new Error("invalid-token");
  }
  let bytes: Uint8Array | undefined = Uint8Array.from(token);
  const tokenClass = classifyGitLabToken(bytes);
  const assertCurrent = () => {
    if (!bytes) {
      throw new Error("authority-unavailable");
    }
  };
  return Object.freeze<GitLabStaticTokenOwner>({
    kind: "gitlab-token",
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
