import { generateKeyPairSync } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureAppId, fixtureInstallationId } from "../github.mjs";
import { temporaryDirectory } from "../process.mjs";

export async function createRegistryMaterial(
  resources,
  { definitions, namespaceId, providerId, maximumDurationSeconds },
) {
  const directory = await temporaryDirectory(resources, "rcs-registry-");
  await chmod(directory, 0o700);
  const privateKeyFile = join(directory, "app.pem");
  const registryFile = join(directory, "registry.json");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(privateKeyFile, keyPair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(
    registryFile,
    JSON.stringify({
      version: 1,
      providerId,
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
