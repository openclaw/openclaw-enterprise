import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureAppId, fixtureInstallationId } from "../github.mjs";
import { temporaryDirectory } from "../process.mjs";
import { sharedRsaKeyPair } from "../shared-keys.mjs";

export async function createRegistryMaterial(
  resources,
  { definitions, namespaceId, backendId, maximumDurationSeconds },
) {
  const directory = await temporaryDirectory(resources, "rcs-registry-");
  await chmod(directory, 0o700);
  const privateKeyFile = join(directory, "app.pem");
  const registryFile = join(directory, "registry.json");
  // The same App key the GitHub fixture verifies by default (github/protocol.mjs).
  const keyPair = sharedRsaKeyPair("github-app");
  await writeFile(privateKeyFile, keyPair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
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
            profiles: entry.profiles ?? ["git-read", "git-write", "git-full"],
            ...(entry.pushRefAllowlist === undefined
              ? {}
              : { pushRefAllowlist: entry.pushRefAllowlist }),
          },
        ],
      })),
    }),
    { mode: 0o600 },
  );
  return { directory, privateKeyFile, registryFile, keyPair };
}
