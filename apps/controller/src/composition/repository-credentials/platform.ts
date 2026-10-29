import { requireConfiguration } from "@openclaw-enterprise/contracts";
import type { RepositoryGitDeliveryResolver } from "../../drivers/repo/credentials/delivery.ts";
import {
  githubRepositoryAuthorityIdentity,
  type githubRepositoryConfiguration,
} from "../../drivers/repo/github/installation.ts";
import { GitHubRepositoryPolicy } from "../../drivers/repo/github/policy.ts";
import { loadPublicCa } from "./public-ca.ts";
import type {
  GitHubRepositoryCredentialBackendDefinition,
  Backend,
  RepositoryPolicyDriver,
  NativeRepositorySender,
} from "@openclaw-enterprise/contracts";
import { GitHubNativeRepositorySender } from "../../drivers/repo/github/driver.ts";
import {
  UnixRepositoryCredentialControlClient,
  type RepositoryCredentialControlClient,
} from "../../backends/repository-credentials/control-client.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";
import type { SelectedDriverConfiguration } from "../installation-config.ts";

export async function composeRepositoryAccess(input: {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: SelectedDriverConfiguration;
  readonly protectedGit: boolean;
  readonly configuration?: ReturnType<typeof githubRepositoryConfiguration>;
}): Promise<
  Readonly<{
    repositoryPolicy: RepositoryPolicyDriver;
    authorityIdentity: string;
    nativeRepositorySender?: NativeRepositorySender;
    repositoryRegistry: GitHubRepositoryRegistry;
    resolveRepositoryDelivery: RepositoryGitDeliveryResolver;
    repositoryOwner: Readonly<{
      controlSocket?: string;
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
  // Native sending has its own transport contract; it is not a Repo Driver. Each contract
  // refuses at load, before any Backend is built (finding 2214). The merged native
  // configuration is checked only here: the Repo Driver's installation parser stays inside
  // the repository credential import boundary.
  const configuration = requireConfiguration(
    input.protectedGit ? GitHubRepositoryPolicy : GitHubNativeRepositorySender,
    selection.configuration,
  ) as Readonly<{
    controlSocket?: string;
    sessionDurationSeconds: number;
    publicCaPath?: string;
  }>;
  const registry = await loadGitHubRepositoryRegistry(
    definition.configuration.registryPath,
    definition.id,
  );
  let client: RepositoryCredentialControlClient | undefined;
  let publicCa: Uint8Array | undefined;
  if (!input.protectedGit) {
    if (!configuration.publicCaPath || !configuration.controlSocket) {
      throw new Error("Native Git requires its configured repository broker and public CA.");
    }
    publicCa = await loadPublicCa(configuration.publicCaPath);
    client = new UnixRepositoryCredentialControlClient({
      controlSocket: configuration.controlSocket,
    });
  }
  // Copy only identity data: policy must not receive the native transport capability.
  const backend: Pick<Backend, "id" | "drivers"> = Object.freeze({
    id: definition.id,
    drivers: Object.freeze({ repo: selection.id }),
  });
  const repositoryPolicy = new GitHubRepositoryPolicy(backend, registry, {
    sessionDurationSeconds: configuration.sessionDurationSeconds,
  });
  return Object.freeze({
    authorityIdentity: githubRepositoryAuthorityIdentity(
      selection,
      definition,
      registry,
      input.configuration,
    ),
    repositoryRegistry: registry,
    resolveRepositoryDelivery: createGitHubRepositoryDeliveryResolver(registry),
    repositoryOwner: Object.freeze({
      ...(!input.protectedGit && { controlSocket: configuration.controlSocket }),
      driverId: selection.id,
      implementation: selection.implementation,
      backendId: definition.id,
    }),
    repositoryPolicy,
    ...(!input.protectedGit && {
      nativeRepositorySender: new GitHubNativeRepositorySender(
        { ...backend, client },
        {
          ...(publicCa && { publicCa }),
        },
      ),
    }),
  });
}
