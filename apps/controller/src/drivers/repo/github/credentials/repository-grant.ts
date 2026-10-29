import type { GitHubRepositoryRegistry } from "./registry.ts";

/** Provider scope produced only from admitted repository identity and trusted Namespace permissions. */
export interface GitHubRepositoryGrant {
  readonly id: string;
  readonly isolationId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly profile: "github-repository";
  /** Canonical numeric ID from the bound registry entry; never a slug lookup at issuance. */
  readonly repositoryId: string;
  readonly repository: string;
  /** Explicit approved subset of the App's repository permissions, never inherited. */
  readonly permissions: Readonly<Record<string, string>>;
}

// Reviewed repository-local permissions, not a default permission request. Unknown names fail
// closed, including new GitHub permissions, organization/user permissions, repository creation
// and installation repository access. Some repository-labelled permissions can expand authority.
// https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
const repositoryPermissions = new Set([
  "actions",
  "administration",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "issues",
  "metadata",
  "pages",
  "pull_requests",
  "repository_hooks",
  "repository_projects",
  "secret_scanning_alerts",
  "secrets",
  "security_events",
  "statuses",
  "variables",
  "vulnerability_alerts",
  "workflows",
]);

/** Shared classification at registry admission and provider issuance; never a default map. */
export function isGitHubRepositoryPermissions(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "metadata") &&
    (value as Record<string, unknown>).metadata === "read" &&
    Object.entries(value).every(
      ([name, level]) =>
        repositoryPermissions.has(name) &&
        (level === "read" || level === "write") &&
        (name !== "metadata" || level === "read"),
    )
  );
}

export function validateGitHubRepositoryGrant(grant: GitHubRepositoryGrant): void {
  const fields = [
    "id",
    "isolationId",
    "appId",
    "installationId",
    "profile",
    "repositoryId",
    "repository",
    "permissions",
  ];
  const id = (value: unknown) =>
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value));
  const permissions = grant.permissions;
  if (
    grant.profile !== "github-repository" ||
    Object.keys(grant).length !== fields.length ||
    Object.keys(grant).some((key) => !fields.includes(key)) ||
    typeof grant.id !== "string" ||
    !grant.id ||
    typeof grant.isolationId !== "string" ||
    !grant.isolationId ||
    !id(grant.appId) ||
    !id(grant.installationId) ||
    !id(grant.repositoryId) ||
    typeof grant.repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(grant.repository) ||
    !isGitHubRepositoryPermissions(permissions)
  ) {
    throw new Error("invalid-github-repository-grant");
  }
}

/** Bind an already-authorized private selection; this does not authorize a Namespace or Agent. */
export function createGitHubRepositoryGrant(
  registry: GitHubRepositoryRegistry,
  selection: Readonly<{ repositoryRef: string; repositoryId: string }>,
  identity: Readonly<{ id: string; isolationId: string }>,
  permissions: Readonly<Record<string, string>>,
): GitHubRepositoryGrant {
  const repository = registry.repositories.find(
    (entry) => entry.repositoryRef === selection.repositoryRef,
  );
  if (!repository || repository.repositoryId !== selection.repositoryId) {
    throw new Error("github-repository-selection-changed");
  }
  const grant = Object.freeze({
    ...identity,
    appId: registry.appId,
    installationId: registry.githubInstallationId,
    profile: "github-repository" as const,
    repositoryId: repository.repositoryId,
    repository: repository.repository,
    permissions: Object.freeze({ ...permissions }),
  });
  validateGitHubRepositoryGrant(grant);
  return grant;
}
