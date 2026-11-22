import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { DriverSelectionError, OpenClawController } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { installedDriverPackage } from "../helpers/protected-driver-package.ts";

const packageName = "@fixture/external-sandbox-driver";
const sandboxId = "external-sandbox";
const installation = {
  id: "installation-external-sandbox",
  name: "External Sandbox registration",
  createdAt: "2026-11-16T00:00:00.000Z",
};

async function externalSandbox(t: TestContext) {
  const { directory } = await installedDriverPackage(t, packageName, "external-sandbox-driver", [
    "index",
  ]);
  const configPath = join(directory, "installation.yaml");
  const base = createInstallationDriverConfiguration();
  return async (malformed?: Record<string, unknown>) => {
    // Load an ordinary standalone Sandbox through its installed package and startup settings.
    await writeFile(
      configPath,
      JSON.stringify({
        ...base,
        presets: { includeDefaults: false },
        drivers: {
          ...base.drivers,
          sandbox: {
            id: sandboxId,
            package: packageName,
            configuration: malformed === undefined ? {} : { malformed },
          },
        },
      }),
    );
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: configPath },
      packageRoot: directory,
    });
    assert.ok(drivers?.sandboxDriver);
    return drivers;
  };
}

test("production startup selects an installed external Sandbox package", async (t) => {
  const load = await externalSandbox(t);
  const drivers = await load();
  const controller = new OpenClawController(installation);
  installSelectedSandboxDrivers(controller, drivers);
  const selected = controller.selectedDriver("sandbox");
  assert.equal(selected, drivers.sandboxDriver);
  assert.equal(selected.id, sandboxId);
  assert.equal(selected.implementation, `${packageName}@1.0.0`);
});

test("production startup refuses malformed installed Sandbox declarations", async (t) => {
  const load = await externalSandbox(t);
  // Each malformed lifecycle hook must fail during composition, before registration.
  for (const member of ["ensureNamespace", "provisionHarness"]) {
    await assert.rejects(
      load({ [member]: {} }),
      {
        name: "Error",
        message: "drivers.sandbox factory returned invalid optional lifecycle hooks.",
      },
      member,
    );
  }

  // These declarations reach the registry. A refusal must leave the driver unselectable.
  for (const [member, value] of [
    ["harnessHome", "home/node"],
    ["harnessHome", "/home/./node"],
    ["readSandboxLogs", {}],
    ["observeHarness", {}],
    ["facets", ["networking", "networking"]],
  ] as const) {
    const drivers = await load({ [member]: value });
    assert.ok(drivers.sandboxDriver);
    assert.deepEqual(drivers.sandboxDriver[member], value, member);
    const controller = new OpenClawController(installation);
    assert.throws(
      () => installSelectedSandboxDrivers(controller, drivers),
      {
        name: DriverSelectionError.name,
        message: "The Driver does not satisfy its exact capability contract.",
      },
      member,
    );
    assert.throws(
      () => controller.selectDriver("sandbox", sandboxId),
      {
        name: DriverSelectionError.name,
        message: "No registered Driver matches the exact selected capability and identity.",
      },
      member,
    );
  }
});
