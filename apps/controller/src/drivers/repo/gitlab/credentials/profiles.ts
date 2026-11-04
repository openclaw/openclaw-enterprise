import type { GitLabTokenProfile } from "./types.ts";

const profiles = Object.freeze({
  "metadata-read": Object.freeze({ project: "read" }),
  "git-ref-write": Object.freeze({ project: "read", branches: "write" }),
  "git-ref-draft-pr": Object.freeze({
    project: "read",
    branches: "write",
    merge_requests: "write",
  }),
  "git-read": Object.freeze({
    project: "read",
    branches: "read",
    issues: "read",
    merge_requests: "read",
    pipelines: "read",
  }),
  "git-write": Object.freeze({
    project: "read",
    branches: "write",
    issues: "read",
    merge_requests: "write",
    pipelines: "read",
  }),
  "git-full": Object.freeze({
    project: "read",
    branches: "write",
    issues: "write",
    merge_requests: "write",
    pipelines: "read",
  }),
});

export function permissionsForProfile(
  profile: GitLabTokenProfile,
): Readonly<Record<string, string>> {
  if (typeof profile !== "string" || !Object.hasOwn(profiles, profile)) {
    throw new Error("unsupported-profile");
  }
  return profiles[profile];
}

/**
 * The static token cannot be narrowed per session: the route allowlist is its scope. Merge,
 * approval, project administration, and pipeline control have no permission entry.
 */
export function assertNoPrivilegedEffect(permission: string): void {
  if (permission !== "read" && permission !== "write") {
    throw new Error("unsupported-effect");
  }
}
