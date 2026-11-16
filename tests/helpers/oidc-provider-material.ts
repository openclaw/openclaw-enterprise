import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OidcTokenAuth } from "../../apps/controller/src/auth/oidc.ts";
import { caAndLeaf } from "./certificates.mjs";
import type { OidcIssuerEndpoints } from "./oidc-provider.ts";

const execute = promisify(execFile);

export interface OidcProviderConfig extends OidcIssuerEndpoints {
  clientId: string;
  clientSecret: string;
  subject: string;
  redirectUri: string;
  tokenAuth: OidcTokenAuth;
}

type RunCommand = (command: string, args: string[]) => Promise<unknown>;

interface MaterialOptions {
  hostname: string;
  redirectUri: string;
  run?: RunCommand;
}

// One isolated issuer per run. The caller disposes it after all provider users stop.
export async function createOidcProviderMaterial(
  parentDirectory: string,
  {
    hostname,
    redirectUri,
    run = (command, args) => execute(command, args, { timeout: 10_000 }),
  }: MaterialOptions,
) {
  const origin = new URL(`https://${hostname}`);
  if (origin.hostname !== hostname || origin.port || origin.pathname !== "/") {
    throw new Error("The synthetic OIDC issuer requires a DNS hostname without a port or path");
  }
  const directory = await mkdtemp(join(parentDirectory, "oidc-provider-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const config: OidcProviderConfig = {
      issuer: `${origin.origin}/`,
      authorizationUrl: `${origin.origin}/authorize`,
      tokenUrl: `${origin.origin}/oauth/token`,
      jwksUrl: `${origin.origin}/.well-known/jwks.json`,
      clientId: `fixture-${randomUUID()}`,
      clientSecret: randomBytes(32).toString("base64url"),
      subject: `fixture-${randomUUID()}`,
      redirectUri,
      tokenAuth: "client_secret_post",
    };
    // The JS helper's inferred default is stricter than its command-runner contract.
    const createCertificates = caAndLeaf as (
      directory: string,
      options: {
        caName: string;
        commonName: string;
        subjectAltName: string;
        days: number;
        run: RunCommand;
      },
    ) => Promise<unknown>;
    await createCertificates(directory, {
      caName: "Disposable OIDC provider CA",
      commonName: hostname,
      subjectAltName: `DNS:${hostname}`,
      days: 2,
      run,
    });
    await rename(join(directory, "key.pem"), join(directory, "server.key"));
    await rename(join(directory, "cert.pem"), join(directory, "server.pem"));
    for (const name of ["ca-key.pem", "ca.srl", "leaf.csr", "leaf.ext"]) {
      await rm(join(directory, name), { force: true });
    }
    for (const [name, content] of Object.entries({
      "config.json": JSON.stringify(config),
      "client-id": config.clientId,
      "client-secret": config.clientSecret,
    })) {
      await writeFile(join(directory, name), content, { mode: 0o600 });
    }
    for (const name of ["ca.pem", "server.pem", "server.key"]) {
      await chmod(join(directory, name), 0o600);
    }
    return { directory, config, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OIDC provider setup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
