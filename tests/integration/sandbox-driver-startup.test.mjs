import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

async function fixture(t, configuration) {
  const directory = await mkdtemp(join(tmpdir(), "occ-sandbox-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function sandboxInstallation() {
  const configuration = installation();
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: { serviceName: "openshell-gateway", port: 50051 },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  return configuration;
}

test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
  const createdDriver = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, sandboxInstallation()) },
  });

  assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
  assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
  assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
  assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers: createdDriver,
      emit: () => {},
    }),
  );
});

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.unsupported = true;
  let invokedFactory = false;

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      createSandboxDriver() {
        invokedFactory = true;
        throw new Error("An injected factory must not bypass provider configuration validation.");
      },
    }),
    /drivers\.sandbox\.configuration does not match its Driver configuration schema/,
  );
  assert.equal(invokedFactory, false);
});

test("startup rejects OpenShell network values outside the v0.1 protocol enums", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "inspect";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects OpenShell network policies without binary identities", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].binaries = [];

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress requires at least one binary path/,
  );
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  const cases = [
    ["tls", "toString", /TLS mode must be one of: skip, terminate/],
    ["enforcement", "constructor", /enforcement mode must be one of: enforce, audit/],
    ["access", "__proto__", /access preset must be one of: read_only, read_write, full/],
  ];

  for (const [field, value, expected] of cases) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0][field] =
      value;
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "passthrough";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.kubernetes.serviceAccount.mode = "driverConfig";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell serviceAccount mode must be gatewayConfigured/,
  );
});
