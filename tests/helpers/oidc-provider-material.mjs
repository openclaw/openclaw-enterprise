import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { caAndLeaf } from "./certificates.mjs";

const execute = promisify(execFile);

// One isolated issuer per run. The caller disposes it after all provider users stop.
/**
 * @param {string} parentDirectory
 * @param {{hostname: string, redirectUri: string, run?: (command: string, args: string[]) => Promise<unknown>}} options
 */
export async function createOidcProviderMaterial(
  parentDirectory,
  { hostname, redirectUri, run = (command, args) => execute(command, args, { timeout: 10_000 }) },
) {
  const origin = new URL(`https://${hostname}`);
  if (origin.hostname !== hostname || origin.port || origin.pathname !== "/") {
    throw new Error("The synthetic OIDC issuer requires a DNS hostname without a port or path");
  }
  const directory = await mkdtemp(join(parentDirectory, "oidc-provider-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const config = {
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
    await caAndLeaf(directory, {
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
