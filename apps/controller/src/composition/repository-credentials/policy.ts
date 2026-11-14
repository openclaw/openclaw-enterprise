import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/access/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";

export type RepositoryPolicyInput<Configuration = Readonly<Record<string, unknown>>> = {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Configuration;
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

export async function loadRepositoryPolicyInputs(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>>,
) {
  const repositoryOwner = repositoryPolicyOwner(input);
  GitHubRepositoryPolicy.validateDriverId(repositoryOwner.driverId);
  const { sessionDurationSeconds } = input.selection.configuration;
  const registry = await loadGitHubRepositoryRegistry(
    input.backend.configuration.registryPath,
    input.backend.id,
  );
  GitHubRepositoryPolicy.validateDuration(sessionDurationSeconds, registry.maximumDurationSeconds);
  return { repositoryOwner, registry, sessionDurationSeconds };
}

export async function loadRepositoryPolicy(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>>,
  selectedRepositoriesOnly = false,
) {
  const { repositoryOwner, registry, sessionDurationSeconds } =
    await loadRepositoryPolicyInputs(input);
  const policy = composeRepositoryPolicy(
    repositoryOwner,
    registry,
    sessionDurationSeconds,
    selectedRepositoriesOnly,
  );
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
  selectedRepositoriesOnly = false,
) {
  const repositoryPolicy = new GitHubRepositoryPolicy(repositoryOwner, registry, {
    sessionDurationSeconds,
    selectedRepositoriesOnly,
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
