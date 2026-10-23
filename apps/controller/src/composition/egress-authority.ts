import type { InstalledDriver, OpenClawController } from "@openclaw-enterprise/occ";
import type {
  CredentialProxyBinding,
  CredentialProxyExchange,
} from "@openclaw-enterprise/contracts";

export {
  egressAuthorityConfiguration,
  type EgressAuthorityConfiguration,
} from "./installation-fields.ts";

/** Give the installed transport one exchange owner, bound before it accepts any request. */
export async function installEgressAuthority(
  controller: Pick<OpenClawController, "selectedDriver" | "createCredentialProxy">,
  owner: InstalledDriver,
): Promise<CredentialProxyBinding | undefined> {
  const driver = owner.require("credential_proxy");
  if (!driver.bindExchange) {
    return undefined;
  }
  if (
    driver !== controller.selectedDriver("credential_proxy") ||
    owner.require("sandbox") !== controller.selectedDriver("sandbox")
  ) {
    throw new Error("The exchange must belong to the selected protected Driver.");
  }
  let canBind = true;
  try {
    const binding = await driver.bindExchange((exchangeOwner): CredentialProxyExchange => {
      if (!canBind) {
        throw new Error("An exchange owner can be bound only at installation.");
      }
      canBind = false;
      const proxy = controller.createCredentialProxy(exchangeOwner);
      // Return only the transport contract, not the controller or the proxy's internal ports.
      return Object.freeze({
        resolve: proxy.resolve.bind(proxy),
        authorizeSend: proxy.authorizeSend.bind(proxy),
        beginResponse: proxy.beginResponse.bind(proxy),
        renewResponse: proxy.renewResponse.bind(proxy),
        protectResponse: proxy.protectResponse.bind(proxy),
      });
    });
    if (canBind) {
      await binding.close();
      throw new Error("The Credential Proxy transport did not bind its exchange owner.");
    }
    return binding;
  } finally {
    canBind = false;
  }
}
