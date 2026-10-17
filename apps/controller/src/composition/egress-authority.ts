import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import type { CredentialProxyDriver } from "@openclaw-enterprise/contracts";
import { OpenShellEgressIdentity } from "../drivers/egress-proxy/openshell-identity.ts";
import {
  bindOpenShellEgressAuthority,
  createOpenShellEgressAuthority,
} from "../drivers/egress-proxy/openshell-authority.ts";
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

/** Started with the API and closed before its database; workers never open another listener. */
export async function installEgressAuthority(
  app: FastifyInstance,
  controller: OpenClawController,
  driver: CredentialProxyDriver,
  configuration: EgressAuthorityConfiguration,
): Promise<void> {
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
    sender: driver.sourceControl.sender,
  });
  const server = createOpenShellEgressAuthority(identity, controller);
  try {
    await bindOpenShellEgressAuthority(
      server,
      `${configuration.host.includes(":") ? `[${configuration.host}]` : configuration.host}:${configuration.port}`,
      certificate,
      privateKey,
    );
  } finally {
    privateKey.fill(0);
  }
  app.addHook("onClose", async () => {
    server.forceShutdown();
  });
}
