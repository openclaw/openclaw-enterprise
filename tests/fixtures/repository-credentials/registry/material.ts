import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubRepositoryRegistration } from "../../../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { fixtureAppId, fixtureInstallationId } from "../github.mjs";
import { temporaryDirectory } from "../process.mjs";

export type FixtureOwner = { after(cleanup: () => void | Promise<void>): void };

type NamespaceRegistration = GitHubRepositoryRegistration["namespaces"][number];
export type RegistryFixtureDefinition = Pick<
  GitHubRepositoryRegistration,
  "repositoryRef" | "repositoryId" | "repository"
> &
  Pick<NamespaceRegistration, "transport" | "pushRefAllowlist" | "pullRequestBase"> & {
    profiles?: NamespaceRegistration["profiles"];
    profile?: NamespaceRegistration["profiles"][number];
    description?: string | null;
    beforeMetadataResponse?: (exchange: {
      request: IncomingMessage;
      response: ServerResponse;
    }) => void | Promise<void>;
  };

type RegistryMaterialOptions = {
  definitions: readonly RegistryFixtureDefinition[];
  namespaceId: string;
  backendId: string;
  maximumDurationSeconds: number;
};

export async function createRegistryMaterial(
  resources: FixtureOwner,
  { definitions, namespaceId, backendId, maximumDurationSeconds }: RegistryMaterialOptions,
) {
  const directory = await temporaryDirectory(resources, "rcs-registry-");
  await chmod(directory, 0o700);
  const registryFile = join(directory, "registry.json");
  await writeFile(
    registryFile,
    JSON.stringify({
      version: 1,
      backendId,
      providerInstanceId: "github-fixture-instance",
      appId: fixtureAppId,
      githubInstallationId: fixtureInstallationId,
      maximumDurationSeconds,
      repositories: definitions.map((entry) => ({
        repositoryRef: entry.repositoryRef,
        repositoryId: entry.repositoryId,
        repository: entry.repository,
        namespaces: [
          {
            namespaceId,
            profiles: entry.profiles ?? ["git-write"],
            transport: entry.transport ?? "git-only",
            pushRefAllowlist: entry.pushRefAllowlist ?? [`refs/heads/agent-${entry.repositoryRef}`],
            ...(entry.pullRequestBase === undefined
              ? {}
              : { pullRequestBase: entry.pullRequestBase }),
          },
        ],
      })),
    }),
    { mode: 0o600 },
  );
  return { directory, registryFile };
}
