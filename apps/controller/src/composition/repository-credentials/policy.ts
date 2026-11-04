import type {
  GitHubRepositoryCredentialBackendDefinition,
  GitLabRepositoryCredentialBackendDefinition,
} from "@openclaw-enterprise/contracts";
import { readFile } from "node:fs/promises";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import { GitLabRepositoryPolicy } from "../../drivers/repo/gitlab/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";

export type RepositoryPolicyInput<Configuration = Readonly<Record<string, unknown>>> = {
  readonly backend:
    GitHubRepositoryCredentialBackendDefinition | GitLabRepositoryCredentialBackendDefinition;
  readonly selection: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Configuration;
  };
};

export function repositoryPolicyOwner(input: RepositoryPolicyInput) {
  if (
    input.selection.implementation !== input.backend.type ||
    input.selection.id !== input.backend.drivers.repo
  ) {
    throw new Error("The repository credential Driver must match its owning Backend.");
  }
  return Object.freeze({
    driverId: input.selection.id,
    implementation: input.backend.type,
    backendId: input.backend.id,
  });
}

export async function loadRepositoryPolicy(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>> & {
    readonly backend: GitHubRepositoryCredentialBackendDefinition;
  },
) {
  const repositoryOwner = repositoryPolicyOwner(input);
  const { sessionDurationSeconds } = input.selection.configuration;
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

export async function loadGitLabRepositoryPolicy(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>> & {
    readonly backend: GitLabRepositoryCredentialBackendDefinition;
  },
) {
  const repositoryOwner = repositoryPolicyOwner(input);
  const { sessionDurationSeconds } = input.selection.configuration;
  const { validateGitLabRepositoryRegistry } =
    await import("../../drivers/repo/gitlab/credentials/registry.ts");
  const registry = validateGitLabRepositoryRegistry(
    JSON.parse(await readFile(input.backend.configuration.registryPath, "utf8")),
    input.backend.id,
  );
  const policy = new GitLabRepositoryPolicy(repositoryOwner, registry, {
    sessionDurationSeconds,
  });
  return Object.freeze({
    repositoryRegistry: registry,
    resolveRepositoryDelivery: undefined,
    repositoryOwner,
    repositoryPolicy: policy,
    repositoryAdmission: Object.freeze({
      policy,
      backendId: repositoryOwner.backendId,
    }),
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
