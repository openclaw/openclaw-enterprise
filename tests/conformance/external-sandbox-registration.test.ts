// External Sandbox conformance kit (RFC-0040), AC-6: the installed loader refuses each
// malformed optional member at registration with a typed startup error. Provider-free: the
// package under test is tests/fixtures/driver-packages/external-sandbox-driver.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createExternalDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages.ts";
import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import { DriverSelectionError, OpenClawController } from "../../packages/occ/src/index.ts";
import { installedDriverPackage } from "../helpers/protected-driver-package.ts";

const installation = {
  id: "installation-external-sandbox",
  name: "External Sandbox kit",
  createdAt: "2026-11-16T00:00:00.000Z",
};
const configuration = {
  endpoint: "wss://workspace.external.test:8443/",
  caBundle: "fixture-ca",
  workspaceRoot: "/srv/external-workspace",
  generationSha256: "a".repeat(64),
};

test("the installed loader admits a provider-free external Sandbox and refuses each malformed optional member", async (t) => {
  const packageName = "@kit/external-sandbox-driver";
  const { directory } = await installedDriverPackage(t, packageName, "external-sandbox-driver", [
    "index",
  ]);
  const loaded = await loadDriverPackage({ package: packageName }, "sandbox", directory, false);
  assert.ok(loaded);
  assert.deepEqual(loaded.module.validateConfiguration?.(configuration), []);
  const create = (id: string, malformed?: Record<string, unknown>) =>
    createExternalDriver(
      loaded.module,
      {
        id,
        implementation: loaded.implementation,
        configuration: malformed === undefined ? configuration : { ...configuration, malformed },
        definition: loaded.module,
      },
      "sandbox",
    ) as SandboxDriver;

  const controller = new OpenClawController(installation);
  controller.registerDriver(create("external-sandbox"));

  // Each contract addition of the external Sandbox profile adds its malformed cases here.
  const cases: [string, Record<string, unknown>][] = [
    ["relative Harness home", { harnessHome: "home/node" }],
    ["Harness home with a dot segment", { harnessHome: "/home/./node" }],
    ...["provisionHarness", "ensureNamespace", "readSandboxLogs", "observeHarness"].map(
      (member): [string, Record<string, unknown>] => [`${member} not a function`, { [member]: {} }],
    ),
    ["duplicate facet", { facets: ["networking", "networking"] }],
  ];
  for (const [index, [name, malformed]] of cases.entries()) {
    assert.throws(
      () => controller.registerDriver(create(`external-sandbox-${index}`, malformed)),
      // The package factory check or the controller's registration refuses it, before use.
      (error: unknown) =>
        error instanceof DriverSelectionError ||
        (error instanceof Error && error.message.startsWith("drivers.sandbox factory")),
      name,
    );
  }
});
