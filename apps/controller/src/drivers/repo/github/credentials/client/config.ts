import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepositoryCredentialSessionFiles } from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "../../../credentials/client-contracts.ts";
import { normalizePushRefAllowlist } from "../../../credentials/client-contracts.ts";
import type { RepositoryCredentialSessionResult } from "../../../credentials/service-contracts.ts";
import { assertPrivateDirectory, readPrivateFile } from "./private-files.ts";

export interface ClientFiles {
  readonly sessionId: string;
  readonly deadlineWallMs: number;
  readonly client: RepositoryCredentialClientConfiguration;
  readonly hasPublicCa: boolean;
}

function validateClient(client: RepositoryCredentialClientConfiguration): void {
  if (Object.hasOwn(client, "pushRefAllowlist")) {
    normalizePushRefAllowlist(client.pushRefAllowlist);
  }
  const origin = new URL(client.gatewayOrigin);
  const remote = new URL(client.gitRemote);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== client.gatewayOrigin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    remote.origin !== origin.origin ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(remote.pathname) ||
    remote.pathname.includes("..") ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(client.gitUsername) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.apiHost) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.canonicalApiHost) ||
    client.apiHost !== origin.hostname ||
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
  if (
    !/^[A-Za-z0-9_-]{32,256}$/.test(opened.bearer) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(opened.session.sessionId) ||
    !Number.isFinite(opened.session.deadlineWallMs) ||
    (publicCa && publicCa.byteLength > 64 * 1024)
  ) {
    throw new Error("invalid-client-configuration");
  }
  const files: ClientFiles = {
    sessionId: opened.session.sessionId,
    deadlineWallMs: opened.session.deadlineWallMs,
    client: opened.client,
    hasPublicCa: publicCa !== undefined,
  };
  const clientJson = JSON.stringify(files) + "\n";
  // Apply the existing reader limit to the complete document, not individual rules.
  if (Buffer.byteLength(clientJson) > 16 * 1024) {
    throw new Error("client-configuration-too-large");
  }
  return {
    bearer: opened.bearer,
    "client.json": clientJson,
    gitconfig:
      "[credential]\n\thelper =\n\tuseHttpPath = true\n[http]\n\tfollowRedirects = false\n\tsslVerify = true\n",
    "gh/hosts.yml": `${JSON.stringify(opened.client.canonicalApiHost)}:\n  api_host: ${JSON.stringify(opened.client.apiHost)}\n  git_protocol: https\n  oauth_token: ${JSON.stringify(opened.bearer)}\n`,
    "gh/config.yml": "version: 1\nprompt: disabled\ngit_protocol: https\n",
    ...(publicCa === undefined
      ? {}
      : { "ca.pem": new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(publicCa) }),
  };
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
  await assertPrivateDirectory(parent);
  try {
    await lstat(target);
    throw new Error("client-directory-exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const staging = await mkdtemp(join(parent, ".session-"));
  try {
    await mkdir(join(staging, "gh"), { mode: 0o700 });
    for (const [name, content] of Object.entries(contents)) {
      const file = await open(join(staging, name), "wx", 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readClientConfiguration(directory: string): Promise<ClientFiles> {
  const value = JSON.parse(
    (await readPrivateFile(join(resolve(directory), "client.json"), 16 * 1024)).toString("utf8"),
  ) as ClientFiles;
  validateClient(value.client);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId) ||
    !Number.isFinite(value.deadlineWallMs) ||
    typeof value.hasPublicCa !== "boolean"
  ) {
    throw new Error("invalid-client-configuration");
  }
  return value;
}
