import type { GitHubAppInstallationScope } from "@openclaw-enterprise/contracts";

/** Repository set explicitly approved for one Agent revision. */
export interface GitHubRepositoryGrant extends GitHubAppInstallationScope {
  readonly id: string;
  readonly isolationId: string;
  readonly profile: "github-repository";
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
const repositorySlugPattern = createRepositorySlugPattern();

export function createRepositorySlugPattern(): RegExp {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
}

export function parseGitHubNumericId(value: unknown): number | undefined {
  if (typeof value !== "string" || !numericIdPattern.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isValidRepository(
  repository: GitHubAppInstallationScope["repositories"][number],
): boolean {
  return (
    !!repository &&
    parseGitHubNumericId(repository.repositoryId) !== undefined &&
    typeof repository.repository === "string" &&
    repositorySlugPattern.test(repository.repository)
  );
}

function hasValidRepositories(repositories: GitHubAppInstallationScope["repositories"]): boolean {
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

export function validateGitHubFiniteInstallationScope(
  value: unknown,
): asserts value is GitHubAppInstallationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-github-repository-grant");
  }
  const scope = value as Partial<GitHubAppInstallationScope>;
  if (
    parseGitHubNumericId(scope.appId) === undefined ||
    parseGitHubNumericId(scope.installationId) === undefined ||
    scope.repositories === undefined ||
    !hasValidRepositories(scope.repositories) ||
    !isGitHubRepositoryPermissions(scope.permissions)
  ) {
    throw new Error("invalid-github-repository-grant");
  }
}

export function validateGitHubRepositoryGrant(grant: GitHubRepositoryGrant): void {
  if (grant.profile !== "github-repository" || !grant.id || !grant.isolationId) {
    throw new Error("invalid-github-repository-grant");
  }
  validateGitHubFiniteInstallationScope(grant);
}
