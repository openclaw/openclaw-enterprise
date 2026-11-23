import { SOURCE_PROVIDER_PRESET_CONFIG_KEY, type SourceProviderPresetId } from "./model-providers.ts";
import {
  parseRepositoryNetworkPolicyCeiling,
  type RepositoryNetworkPolicyCeiling,
} from "./repository-network-policy.ts";

/** The managed static Source preset for a GitHub repository token. It is not a model credential. */
export const GITHUB_SOURCE_PRESET_ID = "github" satisfies SourceProviderPresetId;

/**
 * The `github` Source's repository ceiling: `owner/name:read` or `owner/name:write` entries,
 * separated by commas. OCC stores it in canonical repository order.
 */
export const SOURCE_REPOSITORIES_CONFIG_KEY = "repositories";

/** Derived from the token prefix; never secret and never more than the prefix. */
export type GitHubTokenClass =
  "fine-grained" | "classic" | "oauth" | "app-user" | "app-installation" | "unknown";

// Longest prefix first: "github_pat_" must not be read as an unknown "gh" token.
const prefixes: readonly (readonly [string, GitHubTokenClass])[] = [
  ["github_pat_", "fine-grained"],
  ["ghp_", "classic"],
  ["gho_", "oauth"],
  ["ghu_", "app-user"],
  ["ghs_", "app-installation"],
];

function startsWith(token: Uint8Array | string, prefix: string): boolean {
  if (token.length <= prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index++) {
    const code = typeof token === "string" ? token.charCodeAt(index) : token[index];
    if (code !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** Reads only the documented prefix; no other character is returned or retained. */
export function classifyGitHubToken(token: Uint8Array | string): GitHubTokenClass {
  return prefixes.find(([prefix]) => startsWith(token, prefix))?.[1] ?? "unknown";
}

export class SourceRepositoryCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRepositoryCeilingError";
  }
}

function parseCeiling(value: string): RepositoryNetworkPolicyCeiling {
  const entries = value.split(",").map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 2) {
      throw new SourceRepositoryCeilingError(
        "Write each repository as owner/name:read or owner/name:write, separated by commas.",
      );
    }
    return { repository: parts[0], access: parts[1] };
  });
  let ceiling: RepositoryNetworkPolicyCeiling;
  try {
    ceiling = parseRepositoryNetworkPolicyCeiling(entries);
  } catch (error) {
    throw new SourceRepositoryCeilingError(
      error instanceof Error ? error.message : "The repository ceiling is invalid.",
    );
  }
  if (ceiling.length === 0) {
    throw new SourceRepositoryCeilingError("A github Source requires at least one repository.");
  }
  return ceiling;
}

/** Validates a submitted ceiling and returns its stored form, sorted by repository. */
export function canonicalSourceRepositoryCeiling(value: string): string {
  return [...parseCeiling(value)]
    .sort((a, b) => (a.repository < b.repository ? -1 : 1))
    .map(({ repository, access }) => `${repository}:${access}`)
    .join(",");
}

/**
 * The repository ceiling a `github` Source carries, or undefined for any other Source. A stored
 * ceiling that does not parse fails closed with SourceRepositoryCeilingError.
 */
export function sourceRepositoryCeiling(
  config: Readonly<Record<string, string>>,
): RepositoryNetworkPolicyCeiling | undefined {
  if (config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] !== GITHUB_SOURCE_PRESET_ID) {
    return undefined;
  }
  return parseCeiling(config[SOURCE_REPOSITORIES_CONFIG_KEY] ?? "");
}
