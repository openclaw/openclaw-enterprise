export interface RepositoryNetworkGrant {
  readonly repository: string;
  readonly access: "read" | "write";
}

export type RepositoryNetworkPolicyCeiling = readonly RepositoryNetworkGrant[];

export interface RepositoryNetworkPolicy {
  readonly version: 1;
  readonly grants: readonly RepositoryNetworkGrant[];
  /** Versioned canonical JSON of the validated grants in repository order. */
  readonly identity: string;
}

export class RepositoryNetworkPolicyAdmissionError extends Error {
  readonly code: "INVALID_VALUE" | "OUTSIDE_CEILING" | "UNSUPPORTED_POLICY";
  readonly path: string;

  constructor(code: RepositoryNetworkPolicyAdmissionError["code"], path: string, message: string) {
    super(message);
    this.name = "RepositoryNetworkPolicyAdmissionError";
    this.code = code;
    this.path = path;
  }
}

const repositoryPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const maxGrants = 32;

function parseGrants(value: unknown, path: string): RepositoryNetworkGrant[] {
  if (!Array.isArray(value)) {
    throw new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      "Provide an array of repository grants.",
    );
  }
  if (value.length > maxGrants) {
    throw new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      `Provide at most ${maxGrants} repository grants.`,
    );
  }
  const repositories = new Set<string>();
  const grants: RepositoryNetworkGrant[] = [];
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}/${index}`;
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "repository") ||
      !Object.hasOwn(entry, "access")
    ) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        entryPath,
        "Each grant must contain a repository and an access level.",
      );
    }
    const { repository, access } = entry as Record<string, unknown>;
    if (
      typeof repository !== "string" ||
      repository !== repository.trim() ||
      !repositoryPattern.test(repository) ||
      repository.endsWith(".git")
    ) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        `${entryPath}/repository`,
        "Use a canonical lowercase owner/name without a .git suffix.",
      );
    }
    if (repositories.has(repository)) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        `${entryPath}/repository`,
        "Each repository may have only one grant.",
      );
    }
    if (access !== "read" && access !== "write") {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        `${entryPath}/access`,
        "Use read or write access.",
      );
    }
    repositories.add(repository);
    grants.push({ repository, access });
  }
  return grants;
}

/** Validate and bind a requested ACL to the trusted Installation delegation limit. */
export function admitRepositoryNetworkPolicy(
  value: unknown,
  ceiling: unknown,
): RepositoryNetworkPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  const grants = parseGrants(value, "/repositoryNetworkPolicy");
  const limits = new Map(
    (ceiling === undefined ? [] : parseGrants(ceiling, "/repositoryNetworkPolicyCeiling")).map(
      ({ repository, access }) => [repository, access],
    ),
  );
  for (const [index, grant] of grants.entries()) {
    const limit = limits.get(grant.repository);
    if (limit === undefined || (limit === "read" && grant.access === "write")) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "OUTSIDE_CEILING",
        `/repositoryNetworkPolicy/${index}`,
        "The grant exceeds the Installation repository network policy delegation limit.",
      );
    }
  }

  grants.sort((a, b) => (a.repository < b.repository ? -1 : 1));
  const version = 1;
  const canonicalGrants = Object.freeze(grants.map((grant) => Object.freeze(grant)));
  return Object.freeze({
    version,
    grants: canonicalGrants,
    identity: JSON.stringify({ version, grants: canonicalGrants }),
  });
}
