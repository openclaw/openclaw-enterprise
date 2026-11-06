import { readFile } from "node:fs/promises";
import type { Server } from "@grpc/grpc-js";
import type {
  CredentialProxyBinding,
  CredentialProxyDriver,
  EgressRef,
} from "@openclaw-enterprise/contracts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import { OpenShellEgressIdentity } from "./openshell-identity.ts";
import {
  bindOpenShellTokenGrant,
  type OpenShellTokenGrantConfiguration,
} from "./openshell-token-grant.ts";
import {
  bindOpenShellEgressAuthority,
  createOpenShellEgressAuthority,
} from "./openshell-authority.ts";

interface AuthorityFiles {
  cert: Buffer;
  key: Buffer;
  publicKey: Buffer;
}

async function withAuthorityFiles(
  config: EgressAuthorityConfiguration,
  start: (files: AuthorityFiles) => Promise<CredentialProxyBinding>,
) {
  const [cert, key, publicKey] = await Promise.all([
    readFile(config.certificatePath),
    readFile(config.privateKeyPath),
    readFile(config.issuerPublicKeyPath),
  ]);
  try {
    return await start({ cert, key, publicKey });
  } finally {
    key.fill(0);
  }
}

async function bindGrpc(
  config: EgressAuthorityConfiguration,
  server: Server,
  files: AuthorityFiles,
) {
  try {
    await bindOpenShellEgressAuthority(
      server,
      `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
      files.cert,
      files.key,
    );
    return { close: () => server.forceShutdown() };
  } catch (error) {
    server.forceShutdown();
    throw error;
  }
}

export function bindOpenShellExchange(
  configuration: EgressAuthorityConfiguration,
  sender: EgressRef,
  registrationName: string,
  createCredentialProxy: Parameters<NonNullable<CredentialProxyDriver["bindExchange"]>>[0],
  tokenGrant?: OpenShellTokenGrantConfiguration,
) {
  return withAuthorityFiles(configuration, async (files) => {
    const identity = new OpenShellEgressIdentity({
      issuer: configuration.issuer,
      audience: configuration.audience,
      keyId: configuration.keyId,
      publicKey: files.publicKey,
      sender,
    });
    const proxy = createCredentialProxy(identity);
    const grpc = await bindGrpc(
      configuration,
      createOpenShellEgressAuthority(identity, proxy, registrationName),
      files,
    );
    if (!tokenGrant) {
      return grpc;
    }
    try {
      if (!proxy.resolveRequestCredential || !proxy.authorizeRequestCredential) {
        throw new Error("The selected Credential Proxy cannot serve OpenShell token grants.");
      }
      const http = await bindOpenShellTokenGrant(
        tokenGrant,
        configuration,
        files,
        proxy.resolveRequestCredential.bind(proxy),
      );
      return {
        close: async () => {
          grpc.close();
          await http.close();
        },
      };
    } catch (err) {
      grpc.close();
      throw err;
    }
  });
}

export function bindOpenShellMiddleware(
  configuration: EgressAuthorityConfiguration,
  createServer: (publicKey: Buffer) => Server,
) {
  return withAuthorityFiles(configuration, (files) =>
    bindGrpc(configuration, createServer(files.publicKey), files),
  );
}
