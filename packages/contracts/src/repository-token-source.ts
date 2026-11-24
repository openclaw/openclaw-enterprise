import {
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type SourceProviderPresetId,
} from "./model-providers.ts";
import {
  parseRepositoryNetworkPolicyCeiling,
  RepositoryNetworkPolicyAdmissionError,
  type RepositoryNetworkPolicyCeiling,
  type RepositoryApiMaximum,
  type RepositoryNetworkGrant,
} from "./repository-network-policy.ts";

/** The managed static Source preset for a GitHub repository token. It is not a model credential. */
export const GITHUB_SOURCE_PRESET_ID = "github" satisfies SourceProviderPresetId;

/**
 * The `github` Source's repository ceiling: `owner/name:read` or `owner/name:write` entries,
 * separated by commas. A literal :api suffix also permits issue and pull request routes. OCC stores it in canonical repository order.
 */
export const SOURCE_REPOSITORIES_CONFIG_KEY = "repositories";

/**
 * Whether a stored Source holds a repository token. The purpose is fixed at registration, so a
 * repository token never gets a model Provider copy, model delivery or workload projection.
 */
export function isRepositoryTokenSource(source: {
  readonly config: Readonly<Record<string, string>>;
}): boolean {
  return source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] === GITHUB_SOURCE_PRESET_ID;
}

// The documented prefix of a GitHub fine-grained personal access token.
const FINE_GRAINED_TOKEN_PREFIX = "github_pat_";

/**
 * Whether a value carries the fine-grained personal access token prefix. It reads only the
 * prefix and the length; no other character is returned or retained.
 */
export function isGitHubFineGrainedToken(value: string): boolean {
  return (
    value.length > FINE_GRAINED_TOKEN_PREFIX.length && value.startsWith(FINE_GRAINED_TOKEN_PREFIX)
  );
}

export class SourceRepositoryCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRepositoryCeilingError";
  }
}

function entryError(index: number, message: string) {
  return new SourceRepositoryCeilingError(`Repository entry ${index + 1}: ${message}`);
}

type SourceCeiling = readonly (RepositoryNetworkPolicyCeiling[number] & { readonly api?: true })[];

function parseCeiling(value: string): SourceCeiling {
  const apiRepositories = new Set<string>();
  const entries = value.split(",").map((entry, index) => {
    const parts = entry.split(":");
    if (parts.length === 3 && parts[2] === "api") {
      apiRepositories.add(parts[0]!);
    } else if (parts.length !== 2) {
      throw entryError(
        index,
        "Use owner/name:read or owner/name:write with an optional :api suffix.",
      );
    }
    return { repository: parts[0], access: parts[1] };
  });
  try {
    return parseRepositoryNetworkPolicyCeiling(entries).map((entry) =>
      apiRepositories.has(entry.repository) ? { ...entry, api: true as const } : entry,
    );
  } catch (error) {
    if (!(error instanceof RepositoryNetworkPolicyAdmissionError)) {
      throw new SourceRepositoryCeilingError("The repository ceiling is invalid.");
    }
    const index = /^\/repositoryNetworkPolicyCeiling\/(\d+)(?:\/|$)/.exec(error.path)?.[1];
    throw index === undefined
      ? new SourceRepositoryCeilingError(error.message)
      : entryError(Number(index), error.message);
  }
}

/** Reads a stored ceiling; an invalid value throws SourceRepositoryCeilingError. */
export function readSourceRepositoryCeiling(value: string): SourceCeiling {
  return parseCeiling(value);
}

/** Validates a submitted ceiling and returns its stored form, sorted by repository. */
export function canonicalSourceRepositoryCeiling(value: string): string {
  return [...parseCeiling(value)]
    .sort((a, b) => (a.repository < b.repository ? -1 : 1))
    .map(({ repository, access, api }) => `${repository}:${access}${api ? ":api" : ""}`)
    .join(",");
}

/** Check the additional PAT constraints at admission and on every locked material read.
 * The caller checks the ordinary Git ceiling first. Maxima include all bound repositories.
 */
export function sourceRepositoryApiRefusal(
  grants: readonly RepositoryNetworkGrant[],
  ceiling: SourceCeiling,
  maxima: readonly RepositoryApiMaximum[],
): "api-not-enrolled" | "ungranted-pr-source" | undefined {
  const granted = new Set(grants.map(({ repository }) => repository));
  // The native resolver already drops PR creation if any bound repository is ungranted.
  const allBoundGranted = maxima.every(({ repository }) => granted.has(repository));
  for (const grant of grants) {
    const maximum = maxima.find(({ repository }) => repository === grant.repository);
    if (!maximum) {
      return "api-not-enrolled";
    }
    const limits = grant.apiLimits;
    const issues = limits?.issues ?? limits?.default;
    const pulls = limits?.pull_requests ?? limits?.default;
    if (
      (maximum.issues === "none" || issues === "none") &&
      (maximum.pull_requests === "none" || pulls === "none")
    ) {
      continue;
    }
    if (!ceiling.some(({ repository, api }) => repository === grant.repository && api)) {
      return "api-not-enrolled";
    }
    if (
      allBoundGranted &&
      grant.access === "write" &&
      maximum.pull_requests === "write" &&
      (pulls === undefined || pulls === "write") &&
      ceiling.some(({ repository }) => !granted.has(repository))
    ) {
      return "ungranted-pr-source";
    }
  }
  return undefined;
}
