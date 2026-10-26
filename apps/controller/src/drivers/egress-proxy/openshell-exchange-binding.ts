import { readFile } from "node:fs/promises";
import type { CredentialProxyDriver, EgressRef } from "@openclaw-enterprise/contracts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import { OpenShellEgressIdentity } from "./openshell-identity.ts";
import {
  bindOpenShellEgressAuthority,
  createOpenShellEgressAuthority,
} from "./openshell-authority.ts";

export async function bindOpenShellExchange(
  configuration: EgressAuthorityConfiguration,
  sender: EgressRef,
  createCredentialProxy: Parameters<NonNullable<CredentialProxyDriver["bindExchange"]>>[0],
) {
  const [certificate, privateKey, publicKey] = await Promise.all([
    readFile(configuration.certificatePath),
    readFile(configuration.privateKeyPath),
    readFile(configuration.issuerPublicKeyPath),
  ]);
  const identity = new OpenShellEgressIdentity({
    issuer: configuration.issuer,
    audience: configuration.audience,
    keyId: configuration.keyId,
    publicKey,
    sender,
  });
  const server = createOpenShellEgressAuthority(identity, { createCredentialProxy });
  try {
    await bindOpenShellEgressAuthority(
      server,
      `${configuration.host.includes(":") ? `[${configuration.host}]` : configuration.host}:${configuration.port}`,
      certificate,
      privateKey,
    );
  } catch (error) {
    server.forceShutdown();
    throw error;
  } finally {
    privateKey.fill(0);
  }
  return { close: () => server.forceShutdown() };
}
