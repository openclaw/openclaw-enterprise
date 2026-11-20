import { readFile } from "node:fs/promises";
import type { Server } from "@grpc/grpc-js";
import type { CredentialProxyDriver, EgressRef } from "@openclaw-enterprise/contracts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import { OpenShellEgressIdentity } from "./openshell-identity.ts";

export async function bindOpenShellExchange(
  configuration: EgressAuthorityConfiguration,
  sender: EgressRef,
  createCredentialProxy: Parameters<NonNullable<CredentialProxyDriver["bindExchange"]>>[0],
) {
  const { createOpenShellEgressAuthority } = await import("./openshell-authority.ts");
  return bindOpenShellMiddleware(configuration, (publicKey) => {
    const identity = new OpenShellEgressIdentity({
      issuer: configuration.issuer,
      audience: configuration.audience,
      keyId: configuration.keyId,
      publicKey,
      sender,
    });
    return createOpenShellEgressAuthority(identity, { createCredentialProxy });
  });
}

export async function bindOpenShellMiddleware(
  configuration: EgressAuthorityConfiguration,
  createServer: (publicKey: Buffer) => Server,
) {
  const { bindOpenShellEgressAuthority } = await import("./openshell-authority.ts");
  const [certificate, privateKey, publicKey] = await Promise.all([
    readFile(configuration.certificatePath),
    readFile(configuration.privateKeyPath),
    readFile(configuration.issuerPublicKeyPath),
  ]);
  const server = createServer(publicKey);
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
