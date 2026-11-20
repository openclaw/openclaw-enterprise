import type { SandboxDriver } from "@openclaw-enterprise/contracts";
import type { InstalledDriver, OpenClawController } from "@openclaw-enterprise/occ";

/** Install the selected Sandbox owner and only the capability views it actually advertises. */
export function installSelectedSandboxDrivers(
  controller: OpenClawController,
  drivers: {
    readonly sandboxDriver?: SandboxDriver;
    readonly protectedDriver?: InstalledDriver;
    readonly credentialDeliveryRegistration?: InstalledDriver;
  },
): void {
  const owner = drivers.protectedDriver ?? drivers.credentialDeliveryRegistration;
  if (owner !== undefined) {
    controller.installDriver(owner, [
      "sandbox",
      ...(drivers.protectedDriver === undefined ? [] : (["credential_proxy"] as const)),
      ...(owner.capabilities.includes("credential_proxy_delivery")
        ? (["credential_proxy_delivery"] as const)
        : []),
    ]);
  } else if (drivers.sandboxDriver !== undefined) {
    controller.registerDriver(drivers.sandboxDriver);
    controller.selectDriver("sandbox", drivers.sandboxDriver.id);
  }
}
