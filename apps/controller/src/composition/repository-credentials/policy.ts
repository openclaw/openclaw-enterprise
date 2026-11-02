import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import {
  githubRepositoryAuthorityIdentity,
  type githubRepositoryConfiguration,
} from "../../drivers/repo/github/installation.ts";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import type { SelectedDriverConfiguration } from "../installation-config.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";

type RepositoryPolicyInput = {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: SelectedDriverConfiguration;
  readonly policyConfiguration: { readonly sessionDurationSeconds: number };
  readonly configuration?: ReturnType<typeof githubRepositoryConfiguration>;
};

/** The caller validates the selected policy configuration before reading the registry. */
export async function loadRepositoryPolicy(input: RepositoryPolicyInput) {
  if (
    input.selection.implementation !== "github" ||
    input.selection.id !== input.backend.drivers.repo
  ) {
    throw new Error("The repository credential Driver must match its owning Backend.");
  }
  const registry = await loadGitHubRepositoryRegistry(
    input.backend.configuration.registryPath,
    input.backend.id,
  );
  const policy = composeRepositoryPolicy(input, registry);
  return Object.freeze({
    ...policy,
    authorityIdentity: githubRepositoryAuthorityIdentity(
      input.selection,
      input.backend,
      registry,
      input.configuration,
    ),
    resolveRepositoryDelivery: createGitHubRepositoryDeliveryResolver(registry),
  });
}

/** Native composition calls this only after its registry and public CA have been read. */
export function composeRepositoryPolicy(
  input: RepositoryPolicyInput,
  registry: GitHubRepositoryRegistry,
) {
  const { backend: definition, selection } = input;
  const repositoryOwner = Object.freeze({
    driverId: selection.id,
    implementation: selection.implementation,
    backendId: definition.id,
  });
  const repositoryPolicy = new GitHubRepositoryPolicy(repositoryOwner, registry, {
    sessionDurationSeconds: input.policyConfiguration.sessionDurationSeconds,
  });
  return Object.freeze({
    repositoryRegistry: registry,
    repositoryOwner,
    repositoryPolicy,
  });
}
