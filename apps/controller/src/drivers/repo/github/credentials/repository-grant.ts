/** Repository set explicitly approved for one Agent revision. */
export interface GitHubRepositoryGrant {
  readonly id: string;
  readonly isolationId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly profile: "github-repository";
  readonly repositories: readonly Readonly<{ repositoryId: string; repository: string }>[];
  readonly permissions: Readonly<Record<string, string>>;
}

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
      ([key, level]) =>
        repositoryPermissions.has(key) &&
        (level === "read" || level === "write") &&
        (key !== "metadata" || level === "read"),
    )
  );
}

const numericIdPattern = /^[1-9][0-9]{0,15}$/;
const repositorySlugPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isNumericId(value: unknown): boolean {
  return (
    typeof value === "string" && numericIdPattern.test(value) && Number.isSafeInteger(Number(value))
  );
}

function hasValidGrantIdentity(grant: GitHubRepositoryGrant): boolean {
  return (
    grant.profile === "github-repository" &&
    !!grant.id &&
    !!grant.isolationId &&
    isNumericId(grant.appId) &&
    isNumericId(grant.installationId)
  );
}

function isValidRepository(repository: GitHubRepositoryGrant["repositories"][number]): boolean {
  return (
    isNumericId(repository.repositoryId) &&
    typeof repository.repository === "string" &&
    repositorySlugPattern.test(repository.repository)
  );
}

function hasValidRepositories(repositories: GitHubRepositoryGrant["repositories"]): boolean {
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > 16) {
    return false;
  }
  if (repositories.some((repository) => !isValidRepository(repository))) {
    return false;
  }
  const hasUniqueIds =
    new Set(repositories.map((repository) => repository.repositoryId)).size === repositories.length;
  return (
    hasUniqueIds &&
    new Set(repositories.map((repository) => repository.repository.toLowerCase())).size ===
      repositories.length
  );
}

export function validateGitHubRepositoryGrant(grant: GitHubRepositoryGrant): void {
  const repositories = grant.repositories;
  if (
    !hasValidGrantIdentity(grant) ||
    !hasValidRepositories(repositories) ||
    !isGitHubRepositoryPermissions(grant.permissions)
  ) {
    throw new Error("invalid-github-repository-grant");
  }
}
