import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepositoryCredentialSessionFiles } from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "../../../access/client-contracts.ts";
import {
  clientGitconfig,
  clientGhConfiguration,
  renderClientGhHosts,
  isValidGitClientConnection,
  isValidGitClientUsernameAndHosts,
  normalizePushRefAllowlist,
} from "../../../access/client-contracts.ts";
import type { RepositoryCredentialSessionResult } from "../../../access/service-contracts.ts";
import {
  assertPrivateDirectory,
  clientSessionFileMaxBytes,
  readPrivateFile,
} from "./private-files.ts";

export interface ClientFiles {
  readonly sessionId: string;
  readonly deadlineWallMs: number;
  readonly client: RepositoryCredentialClientConfiguration;
  readonly hasPublicCa: boolean;
}

export function isClientBearer(bearer: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(bearer);
}

function isClientSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Refuse a direct gh session whose private files disagree. */
export async function requireGhMaterial(
  configuration: ClientFiles,
  directory: string,
): Promise<void> {
  const credential = await readPrivateFile(
    join(directory, "bearer"),
    clientSessionFileMaxBytes.bearer,
  );
  let hosts: Buffer | undefined;
  let expected: Buffer | undefined;
  try {
    const bearer = credential.toString("utf8");
    if (!isClientBearer(bearer)) {
      throw new Error("invalid-client-gh-material");
    }
    hosts = await readPrivateFile(
      join(directory, "gh", "hosts.yml"),
      clientSessionFileMaxBytes["gh/hosts.yml"],
    );
    expected = Buffer.from(renderClientGhHosts(configuration.client, bearer));
    if (!hosts.equals(expected)) {
      throw new Error("invalid-client-gh-material");
    }
  } finally {
    credential.fill(0);
    hosts?.fill(0);
    expected?.fill(0);
  }
}

function validateClient(client: RepositoryCredentialClientConfiguration): void {
  if (Object.hasOwn(client, "pushRefAllowlist")) {
    normalizePushRefAllowlist(client.pushRefAllowlist);
  }
  const origin = new URL(client.gatewayOrigin);
  const remote = new URL(client.gitRemote);
  if (
    !isValidGitClientConnection(origin, remote, client) ||
    !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(remote.pathname) ||
    remote.pathname.includes("..") ||
    !isValidGitClientUsernameAndHosts(origin, client) ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(client.repository) ||
    client.repository.length > 512 ||
    client.repository.includes("..") ||
    client.gitRemote !== `${client.gatewayOrigin}/${client.repository}.git`
  ) {
    throw new Error("invalid-client-configuration");
  }
}

/** Encode ephemeral client material; the caller owns its filesystem lifecycle. */
export function encodeRepositoryCredentialSessionFiles(
  opened: RepositoryCredentialSessionResult,
  publicCa?: Uint8Array,
): RepositoryCredentialSessionFiles {
  validateClient(opened.client);
  if (!isClientBearer(opened.bearer)) {
    throw new Error("invalid-client-configuration");
  }
  const sessionId = opened.session.sessionId;
  if (
    !isClientSessionId(sessionId) ||
    !Number.isFinite(opened.session.deadlineWallMs) ||
    (publicCa && publicCa.byteLength > clientSessionFileMaxBytes["ca.pem"])
  ) {
    throw new Error("invalid-client-configuration");
  }
  const files: ClientFiles = {
    sessionId,
    deadlineWallMs: opened.session.deadlineWallMs,
    client: opened.client,
    hasPublicCa: publicCa !== undefined,
  };
  const clientJson = JSON.stringify(files) + "\n";
  // Apply the existing reader limit to the complete document, not individual rules.
  if (Buffer.byteLength(clientJson) > clientSessionFileMaxBytes["client.json"]) {
    throw new Error("client-configuration-too-large");
  }
  return {
    bearer: opened.bearer,
    "client.json": clientJson,
    gitconfig: clientGitconfig,
    "gh/hosts.yml": renderClientGhHosts(opened.client, opened.bearer),
    "gh/config.yml": clientGhConfiguration,
    // Git loads this file as sslCAInfo. A leading UTF-8 BOM is not part of the
    // certificate; keeping it makes Git reject the file before the handshake.
    ...(publicCa === undefined
      ? {}
      : { "ca.pem": new TextDecoder("utf-8", { fatal: true }).decode(publicCa) }),
  };
}

/** Refuse an unpublishable client directory: a missing or shared parent, or an existing target. */
export async function assertClientDirectoryAvailable(directory: string): Promise<void> {
  const target = resolve(directory);
  try {
    await assertPrivateDirectory(dirname(target));
  } catch (error) {
    // A fixed code for a missing parent or ancestor; the OS message repeats the path.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("client-parent-missing", { cause: error });
    }
    throw error;
  }
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("client-directory-exists");
}

/** Publish a new private directory atomically; existing sessions are never overwritten. */
export async function writeClientConfiguration(
  opened: RepositoryCredentialSessionResult,
  directory: string,
  publicCa: Uint8Array | undefined,
): Promise<void> {
  const contents = encodeRepositoryCredentialSessionFiles(opened, publicCa);
  const target = resolve(directory);
  const parent = dirname(target);
  await assertClientDirectoryAvailable(target);
  const staging = await mkdtemp(join(parent, ".session-"));
  const gh = join(staging, "gh");
  try {
    // mkdtemp and open apply the process umask. A mask such as 0400 removes
    // owner read, the publish still succeeds, and the next read is EACCES.
    await chmod(staging, 0o700);
    await mkdir(gh, { mode: 0o700 });
    await chmod(gh, 0o700);
    for (const [name, content] of Object.entries(contents)) {
      const file = await open(join(staging, name), "wx", 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await rename(staging, target);
  } catch (error) {
    await chmod(gh, 0o700).catch(() => undefined);
    await chmod(staging, 0o700).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readClientConfiguration(directory: string): Promise<ClientFiles> {
  const value = JSON.parse(
    (
      await readPrivateFile(
        join(resolve(directory), "client.json"),
        clientSessionFileMaxBytes["client.json"],
      )
    ).toString("utf8"),
  ) as ClientFiles;
  validateClient(value.client);
  if (
    !isClientSessionId(value.sessionId) ||
    !Number.isFinite(value.deadlineWallMs) ||
    typeof value.hasPublicCa !== "boolean"
  ) {
    throw new Error("invalid-client-configuration");
  }
  return value;
}
