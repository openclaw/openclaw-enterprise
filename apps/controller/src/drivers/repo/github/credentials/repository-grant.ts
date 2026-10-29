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

export function validateGitHubRepositoryGrant(grant: GitHubRepositoryGrant): void {
  const id = (value: unknown) =>
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value));
  const repositories = grant.repositories;
  if (
    grant.profile !== "github-repository" ||
    !grant.id ||
    !grant.isolationId ||
    !id(grant.appId) ||
    !id(grant.installationId) ||
    !Array.isArray(repositories) ||
    repositories.length < 1 ||
    repositories.length > 16 ||
    repositories.some(
      (r) =>
        !id(r.repositoryId) ||
        typeof r.repository !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(r.repository),
    ) ||
    new Set(repositories.map((r) => r.repositoryId)).size !== repositories.length ||
    new Set(repositories.map((r) => r.repository.toLowerCase())).size !== repositories.length ||
    !isGitHubRepositoryPermissions(grant.permissions)
  ) {
    throw new Error("invalid-github-repository-grant");
  }
}
