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
  const wellFormed = create("external-sandbox");
  controller.registerDriver(wellFormed);
  assert.equal(wellFormed.harnessTransportCredential, "verifier");

  const cases: [string, Record<string, unknown>][] = [
    ["transport credential other than verifier", { harnessTransportCredential: "secret" }],
    ["empty transport credential", { harnessTransportCredential: "" }],
    ["relative Harness home", { harnessHome: "home/node" }],
    ...[
      "harnessEndpoint",
      "harnessStatus",
      "enrollHarness",
      "withdrawHarnessExposure",
      "harnessResource",
      "workspaceNodePeerLabels",
      "observeHeldRepositoryGitPreview",
      "protectedWorkspaceEndpoint",
    ].map((member): [string, Record<string, unknown>] => [`${member} not a function`, { [member]: {} }]),
    // A protected workspace owns provision, enrollment and status; the fixture has no enroll.
    ["protected workspace without enrollment", { protectedWorkspaceEndpoint: async () => undefined }],
  ];
  for (const [index, [name, malformed]] of cases.entries()) {
    const driver = create(`external-sandbox-${index}`, malformed);
    assert.throws(() => controller.registerDriver(driver), DriverSelectionError, name);
  }
  // With enrollment the same member registers: the refusal above is about the lifecycle.
  controller.registerDriver(
    create("external-sandbox-protected", {
      enrollHarness: async () => ({}),
      protectedWorkspaceEndpoint: async () => undefined,
    }),
  );
});
