import type { SourceProviderPresetId } from "./model-providers.ts";
import {
  parseRepositoryNetworkPolicyCeiling,
  RepositoryNetworkPolicyAdmissionError,
  type RepositoryNetworkPolicyCeiling,
} from "./repository-network-policy.ts";

/** The managed static Source preset for a GitHub repository token. It is not a model credential. */
export const GITHUB_SOURCE_PRESET_ID = "github" satisfies SourceProviderPresetId;

/**
 * The `github` Source's repository ceiling: `owner/name:read` or `owner/name:write` entries,
 * separated by commas. OCC stores it in canonical repository order.
 */
export const SOURCE_REPOSITORIES_CONFIG_KEY = "repositories";

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

function parseCeiling(value: string): RepositoryNetworkPolicyCeiling {
  const entries = value.split(",").map((entry, index) => {
    const parts = entry.split(":");
    if (parts.length !== 2) {
      throw entryError(index, "Write it as owner/name:read or owner/name:write.");
    }
    return { repository: parts[0], access: parts[1] };
  });
  try {
    return parseRepositoryNetworkPolicyCeiling(entries);
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

/** Validates a submitted ceiling and returns its stored form, sorted by repository. */
export function canonicalSourceRepositoryCeiling(value: string): string {
  return [...parseCeiling(value)]
    .sort((a, b) => (a.repository < b.repository ? -1 : 1))
    .map(({ repository, access }) => `${repository}:${access}`)
    .join(",");
}
