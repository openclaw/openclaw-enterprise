import {
  requireConfiguration,
  type GitHubRepositoryCredentialBackendDefinition,
} from "@openclaw-enterprise/contracts";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";

export type RepositoryPolicyInput = {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Readonly<Record<string, unknown>>;
  };
};

export function repositoryPolicyOwner(input: RepositoryPolicyInput) {
  if (
    input.selection.implementation !== "github" ||
    input.selection.id !== input.backend.drivers.repo
  ) {
    throw new Error("The repository credential Driver must match its owning Backend.");
  }
  return Object.freeze({
    driverId: input.selection.id,
    implementation: input.selection.implementation,
    backendId: input.backend.id,
  });
}

export async function loadRepositoryPolicy(input: RepositoryPolicyInput) {
  const repositoryOwner = repositoryPolicyOwner(input);
  const { sessionDurationSeconds } = requireConfiguration<{
    readonly sessionDurationSeconds: number;
  }>(GitHubRepositoryPolicy, input.selection.configuration);
  const registry = await loadGitHubRepositoryRegistry(
    input.backend.configuration.registryPath,
    input.backend.id,
  );
  const policy = composeRepositoryPolicy(repositoryOwner, registry, sessionDurationSeconds);
  return Object.freeze({
    ...policy,
    resolveRepositoryDelivery: createGitHubRepositoryDeliveryResolver(registry),
  });
}

/** Native composition calls this only after its registry and public CA have been read. */
export function composeRepositoryPolicy(
  repositoryOwner: ReturnType<typeof repositoryPolicyOwner>,
  registry: GitHubRepositoryRegistry,
  sessionDurationSeconds: number,
) {
  const repositoryPolicy = new GitHubRepositoryPolicy(repositoryOwner, registry, {
    sessionDurationSeconds,
  });
  return Object.freeze({
    repositoryRegistry: registry,
    repositoryOwner,
    repositoryPolicy,
    repositoryAdmission: Object.freeze({
      policy: repositoryPolicy,
      backendId: repositoryOwner.backendId,
    }),
  });
}
