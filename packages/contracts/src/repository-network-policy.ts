import { isDeepStrictEqual } from "node:util";

export type RepositoryApiLevel = "none" | "read" | "write";

export interface RepositoryApiLimits {
  readonly default?: "none";
  readonly issues?: RepositoryApiLevel;
  readonly pull_requests?: RepositoryApiLevel;
}

export interface RepositoryApiMaximum extends RepositoryNetworkLimit {
  readonly issues: RepositoryApiLevel;
  readonly pull_requests: RepositoryApiLevel;
}

interface RepositoryNetworkLimit {
  readonly repository: string;
  readonly access: "read" | "write";
}

export interface RepositoryNetworkGrant extends RepositoryNetworkLimit {
  readonly apiLimits?: RepositoryApiLimits;
}

export type RepositoryNetworkPolicyCeiling = readonly RepositoryNetworkLimit[];

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

export const repositoryNetworkGrantPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const repositoryNamePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const maxRepositoryNetworkGrants = 32;

export function parseRepositoryApiLimits(input: unknown, path = "/apiLimits"): RepositoryApiLimits {
  const invalid = () =>
    new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      "Set issues or pull_requests to none, read or write, or default to none.",
    );
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid();
  }
  const limits = input as Record<string, unknown>;
  if (
    !Object.keys(limits).length ||
    Reflect.ownKeys(limits).some(
      (key) => key !== "default" && key !== "issues" && key !== "pull_requests",
    ) ||
    (Object.hasOwn(limits, "default") && limits.default !== "none")
  ) {
    throw invalid();
  }
  function level(value: unknown): RepositoryApiLevel {
    if (value !== "none" && value !== "read" && value !== "write") {
      throw invalid();
    }
    return value;
  }
  // Match the revision identity even if the input or database reordered the keys.
  return Object.freeze({
    ...(Object.hasOwn(limits, "default") && { default: "none" as const }),
    ...(Object.hasOwn(limits, "issues") && { issues: level(limits.issues) }),
    ...(Object.hasOwn(limits, "pull_requests") && { pull_requests: level(limits.pull_requests) }),
  });
}

function parseGrants(
  value: unknown,
  path: "/repositoryNetworkPolicy" | "/repositoryNetworkPolicyCeiling",
  allowRepositoryNames = false,
): RepositoryNetworkGrant[] {
  if (!Array.isArray(value)) {
    throw new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      "Provide an array of repository grants.",
    );
  }
  if (value.length > maxRepositoryNetworkGrants) {
    throw new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      `Provide at most ${maxRepositoryNetworkGrants} repository grants.`,
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
      Reflect.ownKeys(entry).some(
        (key) =>
          key !== "repository" &&
          key !== "access" &&
          (key !== "apiLimits" || path !== "/repositoryNetworkPolicy"),
      ) ||
      !Object.hasOwn(entry, "repository") ||
      !Object.hasOwn(entry, "access")
    ) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        entryPath,
        "Each grant must contain a repository and an access level.",
      );
    }
    const { repository: configuredRepository, access } = entry as Record<string, unknown>;
    const repository =
      allowRepositoryNames &&
      typeof configuredRepository === "string" &&
      !configuredRepository.includes("/")
        ? configuredRepository.toLowerCase()
        : configuredRepository;
    if (
      typeof repository !== "string" ||
      repository !== repository.trim() ||
      (!repositoryNetworkGrantPattern.test(repository) &&
        !(allowRepositoryNames && repositoryNamePattern.test(repository))) ||
      repository.endsWith(".git")
    ) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "INVALID_VALUE",
        `${entryPath}/repository`,
        allowRepositoryNames
          ? "Use a repository name or lowercase owner/name without a .git suffix."
          : "Use a canonical lowercase owner/name without a .git suffix.",
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
    const apiLimits = Object.hasOwn(entry, "apiLimits")
      ? parseRepositoryApiLimits(entry.apiLimits, `${entryPath}/apiLimits`)
      : undefined;
    grants.push({ repository, access, ...(apiLimits && { apiLimits }) });
  }
  return grants;
}

/** Parse trusted Installation configuration without constructing an Agent policy. */
export function parseRepositoryNetworkPolicyCeiling(
  value: unknown,
  allowRepositoryNames = false,
): RepositoryNetworkPolicyCeiling {
  return Object.freeze(
    parseGrants(value, "/repositoryNetworkPolicyCeiling", allowRepositoryNames).map((grant) =>
      Object.freeze(grant),
    ),
  );
}

/** Match the persisted format, including a strict ordering that excludes duplicates. */
export function isCanonicalRepositoryGrantList(
  value: unknown,
): value is readonly RepositoryNetworkGrant[] {
  try {
    const grants = parseGrants(value, "/repositoryNetworkPolicy");
    return (
      isDeepStrictEqual(value, grants) &&
      grants.every(
        (grant, index) => index === 0 || grants[index - 1]!.repository < grant.repository,
      )
    );
  } catch {
    return false;
  }
}

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

  return freezePolicy(grants);
}

/** Validate stored revision identity without treating the Agent grants as Installation authority. */
export function isCanonicalRepositoryNetworkPolicy(policy: RepositoryNetworkPolicy): boolean {
  try {
    return isDeepStrictEqual(
      policy,
      freezePolicy(parseGrants(policy.grants, "/repositoryNetworkPolicy")),
    );
  } catch {
    return false;
  }
}

function freezePolicy(grants: RepositoryNetworkGrant[]): RepositoryNetworkPolicy {
  grants.sort((a, b) => (a.repository < b.repository ? -1 : 1));
  const version = 1;
  const canonicalGrants = Object.freeze(grants.map((grant) => Object.freeze(grant)));
  return Object.freeze({
    version,
    grants: canonicalGrants,
    identity: JSON.stringify({ version, grants: canonicalGrants }),
  });
}
