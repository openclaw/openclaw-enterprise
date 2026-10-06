import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import pg from "pg";

test("secret-driver-startup constructs the bundled KubernetesSecretDriver from Installation YAML", async (t) => {
  const drivers = await loadInstallationFile(t, installation());

  assert.deepEqual(drivers.installation.drivers.secret, {
    id: "secret-kubernetes",
    implementation: "occ/kubernetes-secret",
    configuration: { authentication: { mode: "inCluster" } },
  });
  assert.ok(drivers.secretDriver instanceof KubernetesSecretDriver);
  assert.equal(drivers.secretDriver.capability, "secret");
  assert.equal(drivers.secretDriver.id, "secret-kubernetes");
  assert.equal(drivers.secretDriver.implementation, "occ/kubernetes-secret");

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers,
      emit: () => {},
    }),
  );
});

test("secret-driver-startup requires one bundled SecretDriver selection and validates its configuration", async (t) => {
  const missing = installation();
  delete missing.drivers.secret;
  await assert.rejects(loadInstallationFile(t, missing), /drivers\.secret/);

  const packageSelection = installation();
  packageSelection.drivers.secret.package = "@example/secret-driver";
  await assert.rejects(
    loadInstallationFile(t, packageSelection),
    /drivers\.secret contains unsupported option package/,
  );

  const invalid = installation();
  invalid.drivers.secret.configuration.authentication = {
    mode: "kubeconfig",
    kubeconfigPath: "relative",
    context: "default",
  };
  await assert.rejects(
    loadInstallationFile(t, invalid),
    /Dedicated kubeconfig path must be absolute/,
  );
});
