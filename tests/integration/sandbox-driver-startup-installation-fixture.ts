import type { TestContext } from "node:test";
import {
  assertStartupRefusal,
  buildSandboxInstallation,
} from "./sandbox-driver-installation-fixture.ts";

export { buildSandboxInstallation };

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
