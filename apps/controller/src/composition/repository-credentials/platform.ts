import { requireConfiguration } from "@openclaw-enterprise/contracts";
import { loadPublicCa } from "./public-ca.ts";
import { GitHubNativeRepositorySender } from "../../drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../backends/repository-credentials/control-client.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";
import {
  composeRepositoryPolicy,
  repositoryPolicyOwner,
  type RepositoryPolicyInput,
} from "./policy.ts";

/** Explicit native delivery; installation composition keeps this module off protected startup. */
export async function composeRepositoryAccess(
  input: RepositoryPolicyInput<Readonly<{ sessionDurationSeconds: number }>>,
  nativeSender: Readonly<{ controlSocket: string; publicCaPath: string }>,
) {
  const { backend: definition, selection } = input;
  const repositoryOwner = repositoryPolicyOwner(input);
  const configuration = requireConfiguration<typeof nativeSender>(
    GitHubNativeRepositorySender,
    nativeSender,
  );
  const registry = await loadGitHubRepositoryRegistry(
    definition.configuration.registryPath,
    definition.id,
  );
  const publicCa = await loadPublicCa(configuration.publicCaPath);
  const client = new UnixRepositoryCredentialControlClient({
    controlSocket: configuration.controlSocket,
  });
  const policy = composeRepositoryPolicy(
    repositoryOwner,
    registry,
    selection.configuration.sessionDurationSeconds,
  );
  return Object.freeze({
    ...policy,
    authorityIdentity: undefined,
    resolveRepositoryDelivery: undefined,
    repositoryOwner: Object.freeze({
      controlSocket: configuration.controlSocket,
      ...policy.repositoryOwner,
    }),
    nativeRepositorySender: new GitHubNativeRepositorySender(
      {
        id: repositoryOwner.backendId,
        drivers: Object.freeze({ repo: repositoryOwner.driverId }),
        client,
      },
      { publicCa },
    ),
  });
}
