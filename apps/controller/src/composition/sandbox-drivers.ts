import type { SandboxDriver } from "@openclaw-enterprise/contracts";
import type { InstalledDriver, OpenClawController } from "@openclaw-enterprise/occ";

/** Install the selected Sandbox and its credential delivery view when available. */
export function installSelectedSandboxDrivers(
  controller: OpenClawController,
  drivers: {
    readonly sandboxDriver?: SandboxDriver | undefined;
    readonly credentialDeliveryRegistration?: InstalledDriver | undefined;
  },
): void {
  if (drivers.credentialDeliveryRegistration !== undefined) {
    controller.installDriver(drivers.credentialDeliveryRegistration, [
      "sandbox",
      "credential_proxy",
    ]);
  } else if (drivers.sandboxDriver !== undefined) {
    controller.registerDriver(drivers.sandboxDriver);
    controller.selectDriver("sandbox", drivers.sandboxDriver.id);
  }
}
