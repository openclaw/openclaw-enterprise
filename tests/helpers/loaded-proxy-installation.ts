import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createCredentialProxyInstallationConfiguration } from "./installation-driver-configuration.mjs";
import { loadInstallationFile } from "./installation-file.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

/** Startup owns the profile; a test must not manufacture the installed-owner exception. */
export async function loadedProxyInstallation(
  t: Parameters<typeof temporaryDirectory>[0],
  input: {
    profile: "repository" | "execution";
    id: string;
    registry: { backendId: string };
    preview?: boolean;
    createOpenShellBackend: NonNullable<
      Parameters<typeof loadInstallationConfiguration>[0]["createOpenShellBackend"]
    >;
  },
) {
  const directory = await temporaryDirectory(t, "proxy-installation-");
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(input.registry));
  const base = createCredentialProxyInstallationConfiguration();
  const authority = base.drivers.credential_proxy.configuration.authority;
  const repository = input.profile === "repository";
  const configuration = {
    ...base,
    backend: [
      {
        ...base.backend[0],
        configuration: {
          ...base.backend[0]!.configuration,
          ...(input.preview && {
            auth: {
              mode: "mtls",
              certificatePath: join(directory, "client.crt"),
              privateKeyPath: join(directory, "client.key"),
            },
          }),
        },
        drivers: {
          ...base.backend[0]!.drivers,
          sandbox: input.id,
          credential_proxy: input.id,
        },
      },
      ...(repository
        ? [
            {
              id: input.registry.backendId,
              type: "github",
              configuration: { registryPath },
              drivers: { repo: "repository-credentials" },
            },
          ]
        : []),
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
      credential_proxy: {
        id: input.id,
        configuration: repository
          ? { ...(input.preview && { observedHookPreviewWorkspace: "preview-1" }) }
          : base.drivers.credential_proxy.configuration,
      },
    },
    ...(repository && {
      repository: {
        id: "repository-credentials",
        configuration: { sessionDurationSeconds: 600 },
        preparedGitHub: {
          custodyKeyPath: join(directory, "custody.key"),
          privateKeyPath: join(directory, "app.pem"),
        },
        openShell: { registrationName: "oce-prepared-git", authority },
      },
    }),
  };
  const loaded = await loadInstallationFile(t, configuration, {
    mode: "development",
    createOpenShellBackend: input.createOpenShellBackend,
  });
  assert.ok(loaded);
  return loaded;
}
