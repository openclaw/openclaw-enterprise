import { requireConfiguration } from "@openclaw-enterprise/contracts";
import type { githubRepositoryConfiguration } from "../../drivers/repo/github/installation.ts";
import { loadPublicCa } from "./public-ca.ts";
import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import { GitHubNativeRepositorySender } from "../../drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../backends/repository-credentials/control-client.ts";
import { loadGitHubRepositoryRegistry } from "./registry.ts";
import type { SelectedDriverConfiguration } from "../installation-config.ts";
import { composeRepositoryPolicy } from "./policy.ts";

/** Explicit native delivery; installation composition keeps this module off protected startup. */
export async function composeRepositoryAccess(input: {
  readonly backend: GitHubRepositoryCredentialBackendDefinition;
  readonly selection: SelectedDriverConfiguration;
  readonly configuration?: ReturnType<typeof githubRepositoryConfiguration>;
}) {
  const { backend: definition, selection } = input;
  if (selection.implementation !== "github" || selection.id !== definition.drivers.repo) {
    throw new Error("The repository credential Driver must match its owning Backend.");
  }
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
  const registry = await loadGitHubRepositoryRegistry(
    definition.configuration.registryPath,
    definition.id,
  );
  if (!configuration.publicCaPath || !configuration.controlSocket) {
    throw new Error("Native Git requires its configured repository broker and public CA.");
  }
  const publicCa = await loadPublicCa(configuration.publicCaPath);
  const client = new UnixRepositoryCredentialControlClient({
    controlSocket: configuration.controlSocket,
  });
  const policy = composeRepositoryPolicy(
    {
      ...input,
      policyConfiguration: { sessionDurationSeconds: configuration.sessionDurationSeconds },
    },
    registry,
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
      { id: definition.id, drivers: Object.freeze({ repo: selection.id }), client },
      { publicCa },
    ),
  });
}
