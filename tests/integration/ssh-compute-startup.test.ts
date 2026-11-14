import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import {
  SshComputeDriver,
  type SshComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { testPool } from "../helpers/postgres-database.mjs";

function installation() {
  const value = createInstallationDriverConfiguration();
  const configuration = {
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
  } satisfies SshComputeDriverOptions;
  return {
    ...value,
    drivers: {
      ...value.drivers,
      compute: { id: "compute-ssh", configuration },
    },
  };
}

test("SSH startup selects occ/ssh in production without Kubernetes Compute fields and constructs a worker", async (t) => {
  const drivers = await loadInstallationFile(t, installation());
  assert.ok(drivers);
  assert.ok(drivers.computeDriver instanceof SshComputeDriver);
  assert.equal(drivers.computeDriver.id, "compute-ssh");
  assert.equal(drivers.computeDriver.implementation, "occ/ssh");
  assert.equal(drivers.installation.drivers.compute.implementation, "occ/ssh");
  assert.equal(drivers.installation.drivers.compute.configuration.images, undefined);
  // Construction proves production structural acceptance; it does not connect to PostgreSQL or SSH.
  const pool: Pool = testPool(t, { connectionString: "postgresql://127.0.0.1:1/occ" });
  assert.doesNotThrow(() =>
    createControllerWorker({ pool, mode: "production", drivers, emit: () => {} }),
  );
  const development = await loadInstallationFile(t, installation(), { mode: "development" });
  assert.ok(development?.computeDriver instanceof SshComputeDriver);
});

test("SSH startup rejects Sandbox composition, missing Secret selection and invalid SSH configuration", async (t) => {
  const baseline = installation();
  await assert.rejects(
    loadInstallationFile(t, {
      ...baseline,
      drivers: { ...baseline.drivers, sandbox: { id: "sandbox-openshell", configuration: {} } },
    }),
    /drivers\.sandbox.*compute-ssh.*Kubernetes/,
  );
  const { secret, ...driversWithoutSecret } = baseline.drivers;
  assert.ok(secret);
  await assert.rejects(
    loadInstallationFile(t, { ...baseline, drivers: driversWithoutSecret }),
    /drivers\.secret/,
  );
  const configuration = baseline.drivers.compute.configuration;
  const { ssh, hosts, runtime } = configuration;
  // The Installation loader receives raw configuration, including fields the schema rejects.
  for (const [input, path, code] of [
    [
      { ...configuration, ssh: { ...ssh, identityFile: "relative" } },
      "/ssh/identityFile",
      "INVALID_FORMAT",
    ],
    [
      { ...configuration, hosts: { stable: { ...hosts.stable, user: "deploy" } } },
      "/hosts",
      "INVALID_VALUE",
    ],
    [
      { ...configuration, hosts: { stable: { ...hosts.stable, port: 65536 } } },
      "/hosts",
      "INVALID_VALUE",
    ],
    [{ ...configuration, executor: {} }, "", "UNKNOWN_FIELD"],
    [{ ...configuration, runtime: { ...runtime, extra: true } }, "/runtime", "UNKNOWN_FIELD"],
  ] as const) {
    const invalid = {
      ...baseline,
      drivers: { ...baseline.drivers, compute: { id: "compute-ssh", configuration: input } },
    };
    await assert.rejects(loadInstallationFile(t, invalid), (error: unknown) => {
      assert.ok(error instanceof ConfigurationValidationError);
      assert.ok(
        error.error.details.some(
          (detail) => detail.path === path && detail.code === code && detail.message,
        ),
      );
      assert.doesNotMatch(JSON.stringify(error.error.details), /relative|deploy|65536/);
      return true;
    });
  }
  const range = installation();
  range.drivers.compute.configuration.network.gatewayPortRange = { start: 2000, end: 1999 };
  await assert.rejects(loadInstallationFile(t, range), (error: unknown) => {
    assert.ok(error instanceof ConfigurationValidationError);
    assert.deepEqual(error.error.details, [
      {
        path: "/network/gatewayPortRange/end",
        code: "INVALID_RANGE",
        message: "Gateway port range start must not exceed end.",
      },
    ]);
    return true;
  });
});

test("every other packageless Compute id retains Kubernetes selection and production checks", async (t) => {
  for (const id of ["compute-kubernetes", "custom-kubernetes-id"]) {
    const value = createInstallationDriverConfiguration();
    value.drivers.compute.id = id;
    const drivers = await loadInstallationFile(t, value);
    assert.ok(drivers);
    assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
    assert.equal(drivers.computeDriver.id, id);
    assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
    value.drivers.compute.configuration.images.requireImmutableDigest = false;
    await assert.rejects(loadInstallationFile(t, value), /immutable image digests/);
  }
});
