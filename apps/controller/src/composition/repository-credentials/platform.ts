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
  const { controlSocket, publicCaPath } = requireConfiguration<typeof nativeSender>(
    GitHubNativeRepositorySender,
    nativeSender,
  );
  const { registryPath } = definition.configuration;
  const { sessionDurationSeconds } = selection.configuration;
  const registry = await loadGitHubRepositoryRegistry(registryPath, repositoryOwner.backendId);
  const publicCa = await loadPublicCa(publicCaPath);
  const client = new UnixRepositoryCredentialControlClient({ controlSocket });
  const policy = composeRepositoryPolicy(repositoryOwner, registry, {
    registryPath,
    sessionDurationSeconds,
  });
  return Object.freeze({
    ...policy,
    repositoryOwner: Object.freeze({
      controlSocket,
      ...policy.repositoryOwner,
    }),
    nativeRepositorySender: new GitHubNativeRepositorySender(
      { ...repositoryOwner, client },
      { publicCa },
    ),
  });
}
