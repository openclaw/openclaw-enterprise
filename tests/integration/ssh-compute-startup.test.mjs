import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

function installation() {
  const value = createInstallationDriverConfiguration();
  value.drivers.compute = {
    id: "compute-ssh",
    configuration: {
      ssh: {
        identityFile: "/etc/openclaw/ssh/id",
        knownHostsFile: "/etc/openclaw/ssh/known_hosts",
      },
      hosts: { stable: { address: "192.0.2.1", user: "root" } },
      runtime: {
        nodePath: "/usr/bin/node",
        openclawPath: "/opt/openclaw/current/dist/index.js",
        user: "openclaw",
        root: "/var/lib/openclaw-enterprise",
      },
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    },
  };
  return value;
}

test("SSH startup selects occ/ssh in production without Kubernetes Compute fields and constructs a worker", async (t) => {
  const drivers = await loadInstallationFile(t, installation());
  assert.ok(drivers.computeDriver instanceof SshComputeDriver);
  assert.equal(drivers.computeDriver.id, "compute-ssh");
  assert.equal(drivers.computeDriver.implementation, "occ/ssh");
  assert.equal(drivers.installation.drivers.compute.implementation, "occ/ssh");
  assert.equal(drivers.installation.drivers.compute.configuration.images, undefined);
  // Construction proves production structural acceptance; it does not connect to PostgreSQL or SSH.
  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(() => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({ pool, mode: "production", drivers, emit: () => {} }),
  );
  assert.ok(
    (await loadInstallationFile(t, installation(), { mode: "development" }))
      .computeDriver instanceof SshComputeDriver,
  );
});

test("SSH startup rejects Sandbox composition, missing Secret selection and invalid SSH configuration", async (t) => {
  const sandbox = installation();
  sandbox.drivers.sandbox = { id: "sandbox-openshell", configuration: {} };
  await assert.rejects(
    loadInstallationFile(t, sandbox),
    /drivers\.sandbox.*compute-ssh.*Kubernetes/,
  );
  const missingSecret = installation();
  delete missingSecret.drivers.secret;
  await assert.rejects(loadInstallationFile(t, missingSecret), /drivers\.secret/);
  for (const mutate of [
    (c) => (c.ssh.identityFile = "relative"),
    (c) => (c.hosts.stable.user = "deploy"),
    (c) => (c.hosts.stable.port = 65536),
    (c) => (c.executor = {}),
    (c) => (c.runtime.extra = true),
  ]) {
    const invalid = installation();
    mutate(invalid.drivers.compute.configuration);
    await assert.rejects(loadInstallationFile(t, invalid), /configuration.*schema/);
  }
  const range = installation();
  range.drivers.compute.configuration.network.gatewayPortRange = { start: 2000, end: 1999 };
  await assert.rejects(loadInstallationFile(t, range), /start must not exceed end/);
});

test("every other packageless Compute id retains Kubernetes selection and production checks", async (t) => {
  for (const id of ["compute-kubernetes", "custom-kubernetes-id"]) {
    const value = createInstallationDriverConfiguration();
    value.drivers.compute.id = id;
    const drivers = await loadInstallationFile(t, value);
    assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
    assert.equal(drivers.computeDriver.id, id);
    assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
    value.drivers.compute.configuration.images.requireImmutableDigest = false;
    await assert.rejects(loadInstallationFile(t, value), /immutable image digests/);
  }
});
