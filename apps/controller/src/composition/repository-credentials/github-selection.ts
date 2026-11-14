import { createHash } from "node:crypto";
import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import { githubRepositoryConfiguration } from "../../drivers/repo/github/installation.ts";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import type { GitHubRepositoryRegistry } from "../../drivers/repo/github/access/registry.ts";
import { closed, object } from "../installation-fields.ts";
import { selected, type SelectedDriverConfiguration } from "../installation-selection.ts";

/** Keep legacy YAML and its exact identity projection private to the integration edge. */
export function githubRepositorySelection(input: unknown) {
  if (input === undefined) {
    return undefined;
  }
  const selection = object(input, "repository");
  closed(
    selection,
    ["id", "configuration", "preparedGitHub", "openShell", "nativeSender", "policyMode"],
    "repository",
  );
  const { policyMode, openShell, ...portableSelection } = selection;
  if (policyMode !== undefined && policyMode !== "built-in") {
    throw new Error('repository.policyMode must be "built-in" when supplied.');
  }
  const portable = githubRepositoryConfiguration(portableSelection);
  // Preserve native/prepared validation before transport validation. Proxy preview
  // augmentation must not enter the raw selection used for the legacy digest.
  return {
    ...portable,
    selection,
    openShell,
  };
}

/** Validate the built-in policy and retain its accepted values for the authority digest. */
export function selectGitHubRepositoryPolicy(repository: { selection: ReturnType<typeof object> }) {
  const policySelection = selected(
    repository.selection,
    "repo",
    "github",
    GitHubRepositoryPolicy,
    "repository",
  ) as SelectedDriverConfiguration<Readonly<{ sessionDurationSeconds: number }>>;
  const configuration = Object.freeze({ ...policySelection.configuration });
  const { policyMode: _policyMode, ...selection } = repository.selection;
  // A non-enumerable configuration never contributed to the raw selection's digest.
  repository.selection = Object.hasOwn(selection, "configuration")
    ? { ...selection, configuration }
    : selection;
  return Object.freeze({ ...policySelection, configuration });
}

/** No key bytes or raw registry cross into generic installed-Driver identity composition. */
export function githubRepositoryAuthorityIdentity(
  selection: SelectedDriverConfiguration,
  backend: GitHubRepositoryCredentialBackendDefinition,
  registry: GitHubRepositoryRegistry,
  configuration: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ selection, backend, registry, configuration }, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")))
          : value,
      ),
    )
    .digest("hex");
}
