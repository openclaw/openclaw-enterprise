import { requireConfiguration } from "@openclaw-enterprise/contracts";
import { readFile } from "node:fs/promises";
import { loadPublicCa } from "./public-ca.ts";
import { GitHubNativeRepositorySender } from "../../drivers/repo/github/driver.ts";
import { GitLabRepositoryPolicy } from "../../drivers/repo/gitlab/policy.ts";
import { UnixRepositoryCredentialControlClient } from "../../backends/repository-credentials/control-client.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";
import {
  composeRepositoryPolicy,
  repositoryPolicyOwner,
  type RepositoryPolicyInput,
} from "./policy.ts";

/** Explicit native delivery; installation composition keeps this module off protected startup. */
export async function composeRepositoryAccess(input: RepositoryPolicyInput) {
  const { backend: definition, selection } = input;
  const repositoryOwner = repositoryPolicyOwner(input);
  // Native sending has its own transport contract; it is not a Repo Driver. Each contract
  // refuses at load, before any Backend is built (finding 2214). The merged native
  // configuration is checked only here: the Repo Driver's installation parser stays inside
  // the repository credential import boundary.
  const configuration = requireConfiguration<
    Readonly<{
      controlSocket?: string;
      sessionDurationSeconds: number;
      publicCaPath?: string;
    }>
  >(GitHubNativeRepositorySender, selection.configuration);
  let policy;
  if (definition.type === "github") {
    const registry = await loadGitHubRepositoryRegistry(
      definition.configuration.registryPath,
      definition.id,
    );
    policy = composeRepositoryPolicy(
      repositoryOwner,
      registry,
      configuration.sessionDurationSeconds,
    );
  } else {
    const { validateGitLabRepositoryRegistry } =
      await import("../../drivers/repo/gitlab/credentials/registry.ts");
    const registry = validateGitLabRepositoryRegistry(
      JSON.parse(await readFile(definition.configuration.registryPath, "utf8")),
      definition.id,
    );
    const repositoryPolicy = new GitLabRepositoryPolicy(repositoryOwner, registry, {
      sessionDurationSeconds: configuration.sessionDurationSeconds,
    });
    policy = Object.freeze({
      repositoryRegistry: registry,
      repositoryOwner,
      repositoryPolicy,
      repositoryAdmission: Object.freeze({
        policy: repositoryPolicy,
        backendId: repositoryOwner.backendId,
      }),
    });
  }
  if (!configuration.publicCaPath || !configuration.controlSocket) {
    throw new Error("Native Git requires its configured repository broker and public CA.");
  }
  const publicCa = await loadPublicCa(configuration.publicCaPath);
  const client = new UnixRepositoryCredentialControlClient({
    controlSocket: configuration.controlSocket,
  });
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
      { publicCa, implementation: repositoryOwner.implementation },
    ),
  });
}
