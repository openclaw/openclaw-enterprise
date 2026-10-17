import { loadPublicCa } from "./public-ca.ts";
import type {
  GitHubRepositoryCredentialBackendDefinition,
  Backend,
  RepoDriver,
} from "@openclaw-enterprise/contracts";
import { GitHubRepoDriver } from "../../drivers/repo/github/driver.ts";
import {
  UnixRepositoryCredentialControlClient,
  type RepositoryCredentialControlClient,
} from "../../backends/repository-credentials/control-client.ts";
import type { GitHubRepositoryRegistry } from "../../drivers/repo/github/credentials/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";
import type { SelectedDriverConfiguration } from "../installation-config.ts";

export async function composeRepoDriver(input: {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: SelectedDriverConfiguration;
}): Promise<
  Readonly<{
    repoDriver: RepoDriver;
    repositoryRegistry: GitHubRepositoryRegistry;
    repositoryReceipt: Readonly<{
      controlSocket: string;
      driverId: string;
      implementation: string;
      backendId: string;
    }>;
  }>
> {
  const { backend: definition, selection } = input;
  if (selection.implementation !== "github" || selection.id !== definition.drivers.repo) {
    throw new Error("The repository credential Driver must match its owning Backend.");
  }
  GitHubRepoDriver.validateConfiguration(selection.configuration);
  const configuration = selection.configuration as Readonly<{
    controlSocket: string;
    sessionDurationSeconds: number;
    publicCaPath: string;
  }>;
  const registry = await loadGitHubRepositoryRegistry(
    definition.configuration.registryPath,
    definition.id,
  );
  let publicCa: Uint8Array;
  try {
    publicCa = await loadPublicCa(configuration.publicCaPath);
  } catch {
    throw new Error("The repository credential public CA file is unavailable or invalid.");
  }
  const backend: Backend<RepositoryCredentialControlClient> = Object.freeze({
    id: definition.id,
    drivers: Object.freeze({ repo: selection.id }),
    client: new UnixRepositoryCredentialControlClient({
      controlSocket: configuration.controlSocket,
    }),
  });
  return Object.freeze({
    repositoryRegistry: registry,
    repositoryReceipt: Object.freeze({
      controlSocket: configuration.controlSocket,
      driverId: selection.id,
      implementation: selection.implementation,
      backendId: definition.id,
    }),
    repoDriver: new GitHubRepoDriver(backend, registry, {
      sessionDurationSeconds: configuration.sessionDurationSeconds,
      publicCa,
    }),
  });
}
