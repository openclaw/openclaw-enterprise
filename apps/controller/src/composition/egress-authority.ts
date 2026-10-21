import { isAbsolute } from "node:path";
import type { InstalledDriver, OpenClawController } from "@openclaw-enterprise/occ";
import type {
  CredentialProxyBinding,
  CredentialProxyExchange,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

export interface EgressAuthorityConfiguration {
  readonly host: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly issuerPublicKeyPath: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
}

export function egressAuthorityConfiguration(
  input: unknown,
  mode: "development" | "production",
): EgressAuthorityConfiguration {
  const value = asRecord(input);
  const fields = [
    "host",
    "port",
    "certificatePath",
    "privateKeyPath",
    "issuerPublicKeyPath",
    "issuer",
    "audience",
    "keyId",
  ];
  if (
    !value ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => key !== "port" && (typeof value[key] !== "string" || !value[key])) ||
    !Number.isSafeInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535 ||
    !["certificatePath", "privateKeyPath", "issuerPublicKeyPath"].every((key) =>
      isAbsolute(String(value[key])),
    ) ||
    (mode === "development" && !["127.0.0.1", "::1"].includes(String(value.host)))
  ) {
    throw new Error(
      "Protected egress requires explicit TLS, issuer identity and a loopback development listener.",
    );
  }
  return value as unknown as EgressAuthorityConfiguration;
}

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
