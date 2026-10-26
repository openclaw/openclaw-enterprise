import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureAppId, fixtureInstallationId } from "../github.mjs";
import { temporaryDirectory } from "../process.mjs";

export async function createRegistryMaterial(
  resources,
  { definitions, namespaceId, backendId, maximumDurationSeconds },
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
