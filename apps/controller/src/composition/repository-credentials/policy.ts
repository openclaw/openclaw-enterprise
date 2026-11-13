import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import type { InstallationRepositoryAdmission } from "@openclaw-enterprise/occ";
import { createImmutableGitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/access/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";

export type BuiltInRepositoryAdmission = InstallationRepositoryAdmission & {
  readonly registry: GitHubRepositoryRegistry;
};

export type RepositoryPolicyBinding = Readonly<{
  registryPath: string;
  sessionDurationSeconds: number;
}>;

export type RepositoryPolicyInput<Configuration = Readonly<Record<string, unknown>>> = {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Configuration;
  };
};

export function repositoryPolicyOwner(input: RepositoryPolicyInput) {
  return Object.freeze({
    driverId: input.selection.id,
    implementation: input.selection.implementation,
    backendId: input.backend.id,
  });
}

export async function loadRepositoryPolicy(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>>,
) {
  const repositoryOwner = repositoryPolicyOwner(input);
  const { sessionDurationSeconds } = input.selection.configuration;
  const { registryPath } = input.backend.configuration;
  const registry = await loadGitHubRepositoryRegistry(registryPath, repositoryOwner.backendId);
  const policy = composeRepositoryPolicy(repositoryOwner, registry, {
    registryPath,
    sessionDurationSeconds,
  });
  return Object.freeze({
    ...policy,
    resolveRepositoryDelivery: createGitHubRepositoryDeliveryResolver(policy.repositoryRegistry),
  });
}

/** Native composition calls this only after its registry and public CA have been read. */
export function composeRepositoryPolicy(
  repositoryOwner: ReturnType<typeof repositoryPolicyOwner>,
  registry: GitHubRepositoryRegistry,
  binding: RepositoryPolicyBinding,
) {
  if (repositoryOwner.implementation !== "github") {
    throw new Error("Repository admission requires the GitHub implementation.");
  }
  const validatedRegistry = validateGitHubRepositoryRegistry(registry, repositoryOwner.backendId);
  const repositoryPolicy = createImmutableGitHubRepositoryPolicy(
    repositoryOwner,
    validatedRegistry,
    {
      sessionDurationSeconds: binding.sessionDurationSeconds,
    },
  );
  const repositoryAdmission: BuiltInRepositoryAdmission = Object.freeze({
    policy: repositoryPolicy,
    backendId: repositoryOwner.backendId,
    registry: validatedRegistry,
  });
  return Object.freeze({
    repositoryRegistry: validatedRegistry,
    repositoryOwner,
    repositoryAdmission,
    repositoryBinding: Object.freeze(binding),
  });
}
