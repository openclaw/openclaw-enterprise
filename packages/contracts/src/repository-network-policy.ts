import { isDeepStrictEqual } from "node:util";

export const repositoryApiActions = Object.freeze([
  "issues:read",
  "issues:create",
  "pull_requests:read",
  "pull_requests:create",
] as const);
export type RepositoryApiAction = (typeof repositoryApiActions)[number];
export type RepositoryApiActions = Readonly<
  { allow: readonly RepositoryApiAction[] } | { deny: readonly RepositoryApiAction[] }
>;

export interface RepositoryApiActionFilterOption extends RepositoryNetworkLimit {
  readonly available: readonly RepositoryApiAction[];
}

interface RepositoryNetworkLimit {
  readonly repository: string;
  readonly access: "read" | "write";
}

export interface RepositoryNetworkGrant extends RepositoryNetworkLimit {
  readonly apiActions?: RepositoryApiActions;
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
export const maxRepositoryNetworkGrants = 32;

/** An empty deny has no effect. An empty allow removes every optional API action. */
export function parseRepositoryApiActions(
  input: unknown,
  path = "/apiActions",
): RepositoryApiActions | undefined {
  const invalid = () =>
    new RepositoryNetworkPolicyAdmissionError(
      "INVALID_VALUE",
      path,
      "Choose one allow or deny list of distinct supported repository API actions.",
    );
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 1
  ) {
    throw invalid();
  }
  const [key] = Object.keys(input);
  if (key !== "allow" && key !== "deny") {
    throw invalid();
  }
  const raw = (input as Record<string, unknown>)[key];
  if (!Array.isArray(raw) || raw.length > repositoryApiActions.length) {
    throw invalid();
  }
  const actions = Object.freeze(
    repositoryApiActions.filter((action) => Array.prototype.includes.call(raw, action)),
  );
  if (actions.length !== raw.length) {
    throw invalid();
  }
  if (key === "allow") {
    return Object.freeze({ allow: actions });
  }
  return actions.length ? Object.freeze({ deny: actions }) : undefined;
}

function parseGrants(
  value: unknown,
  path: "/repositoryNetworkPolicy" | "/repositoryNetworkPolicyCeiling",
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
          (key !== "apiActions" || path !== "/repositoryNetworkPolicy"),
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
    const { repository, access } = entry as Record<string, unknown>;
    if (
      typeof repository !== "string" ||
      repository !== repository.trim() ||
      !repositoryNetworkGrantPattern.test(repository) ||
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
    const apiActions = Object.hasOwn(entry, "apiActions")
      ? parseRepositoryApiActions(entry.apiActions, `${entryPath}/apiActions`)
      : undefined;
    grants.push({ repository, access, ...(apiActions && { apiActions }) });
  }
  return grants;
}

/** Parse trusted Installation configuration without constructing an Agent policy. */
export function parseRepositoryNetworkPolicyCeiling(
  value: unknown,
): RepositoryNetworkPolicyCeiling {
  return Object.freeze(
    parseGrants(value, "/repositoryNetworkPolicyCeiling").map((grant) => Object.freeze(grant)),
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
