import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

test("a GitLab Backend starts the Installation-selected native Agent sender", async (t) => {
  const root = await temporaryDirectory(t, "gitlab-installation-");
  const tls = await createTlsMaterial(t);
  const registryPath = join(root, "gitlab-registry.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      backendId: "gitlab-dev",
      providerInstanceId: "gitlab-com",
      configVersion: "1",
      maximumDurationSeconds: 900,
      projects: [
        {
          projectId: "88516404",
          path: "group/project",
          namespaces: [{ namespaceId: "ns_qa", profiles: ["git-write"], pushRefAllowlist: [] }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const configuration = createInstallationDriverConfiguration();
  configuration.backend = [
    {
      id: "gitlab-dev",
      type: "gitlab",
      configuration: { registryPath },
      drivers: { repo: "gitlab-policy" },
    },
  ];
  configuration.repository = {
    id: "gitlab-policy",
    configuration: { sessionDurationSeconds: 900 },
    nativeSender: {
      controlSocket: join(root, "repository-control.sock"),
      publicCaPath: tls.certFile,
    },
  };
  configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: "occ-system",
    podLabels: { "app.kubernetes.io/name": "repository-service" },
    port: 8443,
  };
  const configurationPath = join(root, "installation.json");
  await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });

  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: configurationPath },
  });
  assert.ok(loaded);
  assert.equal(loaded.repositoryPolicy?.implementation, "gitlab");
  assert.equal(loaded.repositoryOwner?.backendId, "gitlab-dev");
  assert.equal(typeof loaded.nativeRepositorySender?.open, "function");
  assert.equal(loaded.preparedGitHub, undefined);
});
