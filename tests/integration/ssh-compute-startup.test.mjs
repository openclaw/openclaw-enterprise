import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

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

async function load(t, value, mode = "production") {
  const directory = await mkdtemp(join(tmpdir(), "occ-ssh-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(value));
  return loadInstallationConfiguration({ mode, environment: { OCC_CONFIG_PATH: path } });
}

test("SSH startup selects occ/ssh in production without Kubernetes Compute fields and constructs a worker", async (t) => {
  const drivers = await load(t, installation());
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
    (await load(t, installation(), "development")).computeDriver instanceof SshComputeDriver,
  );
});

test("SSH startup rejects Sandbox composition, missing Secret selection and invalid SSH configuration", async (t) => {
  const sandbox = installation();
  sandbox.drivers.sandbox = { id: "sandbox-openshell", configuration: {} };
  await assert.rejects(load(t, sandbox), /drivers\.sandbox.*compute-ssh.*Kubernetes/);
  const missingSecret = installation();
  delete missingSecret.drivers.secret;
  await assert.rejects(load(t, missingSecret), /drivers\.secret/);
  for (const mutate of [
    (c) => (c.ssh.identityFile = "relative"),
    (c) => (c.hosts.stable.user = "deploy"),
    (c) => (c.hosts.stable.port = 65536),
    (c) => (c.executor = {}),
    (c) => (c.runtime.extra = true),
  ]) {
    const invalid = installation();
    mutate(invalid.drivers.compute.configuration);
    await assert.rejects(load(t, invalid), /configuration.*schema/);
  }
  const range = installation();
  range.drivers.compute.configuration.network.gatewayPortRange = { start: 2000, end: 1999 };
  await assert.rejects(load(t, range), /start must not exceed end/);
});

test("every other packageless Compute id retains Kubernetes selection and production checks", async (t) => {
  for (const id of ["compute-kubernetes", "custom-kubernetes-id"]) {
    const value = createInstallationDriverConfiguration();
    value.drivers.compute.id = id;
    const drivers = await load(t, value);
    assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
    assert.equal(drivers.computeDriver.id, id);
    assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
    value.drivers.compute.configuration.images.requireImmutableDigest = false;
    await assert.rejects(load(t, value), /immutable image digests/);
  }
});
