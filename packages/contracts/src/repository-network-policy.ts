export interface RepositoryNetworkGrant {
  readonly repository: string;
  readonly access: "read" | "write";
}

export interface RepositoryNetworkPolicy {
  readonly version: 1;
  readonly grants: readonly RepositoryNetworkGrant[];
  readonly identity: string;
}

export const maxRepositoryNetworkGrants = 32;
export const repositoryNetworkGrantPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;

/** Match the persisted format, including a strict ordering that excludes duplicates. */
export function isCanonicalRepositoryGrantList(
  value: unknown,
): value is readonly RepositoryNetworkGrant[] {
  if (!Array.isArray(value) || value.length > maxRepositoryNetworkGrants) {
    return false;
  }
  let previous = "";
  for (const grant of value) {
    if (
      grant === null ||
      typeof grant !== "object" ||
      Array.isArray(grant) ||
      Object.keys(grant).length !== 2 ||
      !Object.hasOwn(grant, "repository") ||
      !Object.hasOwn(grant, "access")
    ) {
      return false;
    }
    const { repository, access } = grant as Record<string, unknown>;
    if (
      typeof repository !== "string" ||
      !repositoryNetworkGrantPattern.test(repository) ||
      repository.endsWith(".git") ||
      repository <= previous ||
      (access !== "read" && access !== "write")
    ) {
      return false;
    }
    previous = repository;
  }
  return true;
}
