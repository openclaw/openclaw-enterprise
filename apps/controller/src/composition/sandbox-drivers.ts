import type { SandboxDriver } from "@openclaw-enterprise/contracts";
import {
  DriverSelectionError,
  type InstalledDriver,
  type OpenClawController,
} from "@openclaw-enterprise/occ";

/** Install the selected Sandbox owner and only the capability views it actually advertises. */
export function installSelectedSandboxDrivers(
  controller: OpenClawController,
  drivers: {
    readonly sandboxDriver?: SandboxDriver | undefined;
    readonly protectedDriver?: InstalledDriver | undefined;
    readonly credentialDeliveryRegistration?: InstalledDriver | undefined;
  },
): void {
  const owner = drivers.protectedDriver ?? drivers.credentialDeliveryRegistration;
  if (owner !== undefined) {
    if (
      drivers.credentialDeliveryRegistration !== undefined &&
      drivers.credentialDeliveryRegistration !== owner
    ) {
      throw new DriverSelectionError("Credential delivery must use the selected Sandbox owner.");
    }
    controller.installDriver(owner, [
      "sandbox",
      ...(drivers.protectedDriver === undefined ? [] : (["credential_proxy"] as const)),
      ...(drivers.credentialDeliveryRegistration !== undefined
        ? (["credential_proxy_delivery"] as const)
        : []),
    ]);
  } else if (drivers.sandboxDriver !== undefined) {
    controller.registerDriver(drivers.sandboxDriver);
    controller.selectDriver("sandbox", drivers.sandboxDriver.id);
  }
}
