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
  configuration: EgressAuthorityConfiguration,
  start: (files: AuthorityFiles) => Promise<CredentialProxyBinding>,
) {
  const [cert, publicKey] = await Promise.all([
    readFile(configuration.certificatePath),
    readFile(configuration.issuerPublicKeyPath),
  ]);
  const key = await readFile(configuration.privateKeyPath);
  try {
    return await start({ cert, key, publicKey });
  } finally {
    key.fill(0);
  }
}

async function bindGrpc(
  configuration: EgressAuthorityConfiguration,
  server: Server,
  files: AuthorityFiles,
) {
  try {
    await bindOpenShellEgressAuthority(
      server,
      `${configuration.host.includes(":") ? `[${configuration.host}]` : configuration.host}:${configuration.port}`,
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
  createCredentialProxy: Parameters<NonNullable<CredentialProxyDriver["bindExchange"]>>[0],
  requestCredentials?: {
    readonly registrationName: string;
    readonly tokenGrant: OpenShellTokenGrantConfiguration;
  },
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
    if (
      requestCredentials &&
      (!requestCredentials.registrationName ||
        !proxy.authorizeRequestCredential ||
        !proxy.resolveRequestCredential)
    ) {
      throw new Error("The selected Credential Proxy cannot serve OpenShell token grants.");
    }
    const grpc = await bindGrpc(
      configuration,
      createOpenShellEgressAuthority(
        identity,
        { createCredentialProxy: () => proxy },
        requestCredentials?.registrationName,
      ),
      files,
    );
    if (!requestCredentials) {
      return grpc;
    }
    try {
      const http = await bindOpenShellTokenGrant(
        requestCredentials.tokenGrant,
        configuration,
        files,
        proxy.resolveRequestCredential!.bind(proxy),
      );
      return {
        close: async () => {
          grpc.close();
          await http.close();
        },
      };
    } catch (error) {
      grpc.close();
      throw error;
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
