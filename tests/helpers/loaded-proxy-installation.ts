import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createCredentialProxyInstallationConfiguration } from "./installation-driver-configuration.ts";
import { loadInstallationFile } from "./installation-file.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

/** Startup owns the profile; a test must not manufacture the installed-owner exception. */
export async function loadedProxyInstallation(
  t: Parameters<typeof temporaryDirectory>[0],
  input: {
    id: string;
    registry: { backendId: string };
    createOpenShellBackend: NonNullable<
      Parameters<typeof loadInstallationConfiguration>[0]["createOpenShellBackend"]
    >;
  },
) {
  const directory = await temporaryDirectory(t, "proxy-installation-");
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(input.registry), { mode: 0o644 });
  const base = createCredentialProxyInstallationConfiguration();
  const configuration = {
    ...base,
    backend: [
      { ...base.backend[0], drivers: { sandbox: input.id } },
      {
        id: input.registry.backendId,
        type: "github",
        configuration: { registryPath },
        drivers: { repo: "repository-credentials" },
      },
    ],
    drivers: {
      ...base.drivers,
      sandbox: {
        ...base.drivers.sandbox,
        id: input.id,
        configuration: {
          ...base.drivers.sandbox.configuration,
          kubernetes: { ...base.drivers.sandbox.configuration.kubernetes, userNamespaces: false },
        },
      },
    },
    repository: {
      id: "repository-credentials",
      configuration: { sessionDurationSeconds: 600 },
    },
  };
  const loaded = await loadInstallationFile(t, configuration, {
    mode: "development",
    createOpenShellBackend: input.createOpenShellBackend,
  });
  assert.ok(loaded);
  return loaded;
}
