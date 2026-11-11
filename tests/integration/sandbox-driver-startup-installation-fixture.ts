import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  assertStartupRefusal,
  buildSandboxInstallation as buildInstallationFixture,
} from "./sandbox-driver-installation-fixture.ts";

export function buildSandboxInstallation() {
  const installation = buildInstallationFixture();
  const sandbox = installation.drivers.sandbox;
  const { configuration } = sandbox;
  const { workspaceMode } = configuration.gateway;
  const { mode } = configuration.kubernetes.serviceAccount;
  assert.ok(workspaceMode === "operator" || workspaceMode === "managed");
  assert.ok(mode === "gatewayConfigured");
  const gateway: { workspaceMode: OpenShellSandboxDriverOptions["gateway"]["workspaceMode"] } = {
    ...configuration.gateway,
    workspaceMode,
  };
  return {
    ...installation,
    drivers: {
      ...installation.drivers,
      sandbox: {
        ...sandbox,
        configuration: {
          ...configuration,
          gateway,
          kubernetes: {
            ...configuration.kubernetes,
            serviceAccount: { ...configuration.kubernetes.serviceAccount, mode },
          },
        } satisfies OpenShellSandboxDriverOptions,
      },
    },
  };
}

/** Startup refuses the Installation that the test modifies. */
export async function rejectsAtStartup(
  testContext: TestContext,
  change: (configuration: ReturnType<typeof buildSandboxInstallation>) => void,
  expected: Parameters<typeof assertStartupRefusal>[2],
  base: () => ReturnType<typeof buildSandboxInstallation> = buildSandboxInstallation,
): Promise<void> {
  const configuration = base();
  change(configuration);
  await assertStartupRefusal(testContext, configuration, expected);
}
