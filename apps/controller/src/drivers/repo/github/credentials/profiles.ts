import type { GitHubTokenProfile } from "./types.ts";

const profiles = Object.freeze({
  "metadata-read": Object.freeze({ metadata: "read" }),
  "git-read": Object.freeze({
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
  }),
  "git-write": Object.freeze({
    metadata: "read",
    contents: "write",
    issues: "read",
    pull_requests: "write",
    checks: "read",
    statuses: "read",
  }),
  "git-full": Object.freeze({
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
    statuses: "read",
  }),
});

// Bump when route or capability semantics change without changing token permissions.
// Both registry and standalone grants bind this policy, including token-bounded GraphQL.
export const githubCapabilityPolicy = "permission-aligned-rest-token-bounded-graphql-v1";
// A static token cannot be narrowed per session: the route allowlist is its scope.
export const staticTokenCapabilityPolicy = Object.freeze({
  deny: "static-token-route-bounded-rest-only-v1",
  "read-only": "static-token-route-bounded-read-only-graphql-v1",
});

export function permissionsForProfile(
  profile: GitHubTokenProfile,
): Readonly<Record<string, string>> {
  if (typeof profile !== "string" || !Object.hasOwn(profiles, profile)) {
    throw new Error("unsupported-profile");
  }
  return profiles[profile];
}
