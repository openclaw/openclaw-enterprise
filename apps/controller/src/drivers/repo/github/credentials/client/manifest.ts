import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { readClientConfiguration, type ClientFiles } from "./config.ts";
import { normalizePushRefAllowlist } from "../../../credentials/client-contracts.ts";
import { assertPrivateDirectory, readPrivateFile } from "./private-files.ts";

export const repositoryMaterialRoot = "/run/oce/repository-credentials";
export const repositoryManifestPath = join(repositoryMaterialRoot, "manifest.json");
export const repositorySelectionVariable = "OCE_REPOSITORY_SELECTION";

export interface RuntimeRepositoryBinding {
  readonly repositoryRef: string;
  readonly sessionId: string;
  readonly deadlineWallMs: number;
  readonly directory: string;
  readonly materialDirectory: string;
  readonly client: ClientFiles["client"];
  readonly configuration: ClientFiles;
}

export interface RuntimeRepositoryManifest {
  readonly generation: string;
  readonly bindings: readonly RuntimeRepositoryBinding[];
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error("invalid-repository-material");
  }
  return value as Record<string, unknown>;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function readPublicClient(value: unknown): ClientFiles["client"] {
  const hasPolicy =
    value !== null && typeof value === "object" && Object.hasOwn(value, "pushRefAllowlist");
  const client = record(value, [
    "gatewayOrigin",
    "gitRemote",
    "gitUsername",
    "canonicalApiHost",
    "apiHost",
    "repository",
    ...(hasPolicy ? ["pushRefAllowlist"] : []),
  ]);
  if (
    !Object.entries(client).every(
      ([key, item]) => key === "pushRefAllowlist" || typeof item === "string",
    )
  ) {
    throw new Error("invalid-repository-material");
  }
  if (hasPolicy) {
    normalizePushRefAllowlist(client.pushRefAllowlist);
  }
  return Object.freeze(client) as unknown as ClientFiles["client"];
}

function clientsAgree(first: ClientFiles["client"], second: ClientFiles["client"]): boolean {
  return (
    first.gatewayOrigin === second.gatewayOrigin &&
    first.gitRemote === second.gitRemote &&
    first.gitUsername === second.gitUsername &&
    first.canonicalApiHost === second.canonicalApiHost &&
    first.apiHost === second.apiHost &&
    first.repository === second.repository &&
    JSON.stringify(first.pushRefAllowlist) === JSON.stringify(second.pushRefAllowlist)
  );
}

async function validateMaterialFiles(directory: string, hasPublicCa: boolean): Promise<void> {
  await assertPrivateDirectory(directory);
  await assertPrivateDirectory(join(directory, "gh"));
  const bounds = new Map([
    ["bearer", 256],
    ["client.json", 16 * 1024],
    ["gitconfig", 16 * 1024],
    ["gh/hosts.yml", 16 * 1024],
    ["gh/config.yml", 16 * 1024],
  ]);
  if (hasPublicCa) {
    bounds.set("ca.pem", 64 * 1024);
  }
  // Validate the complete generation without loading another binding's bearer.
  for (const [name, maximum] of bounds) {
    const stat = await lstat(join(directory, name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size === 0 ||
      stat.size > maximum
    ) {
      throw new Error("invalid-repository-material");
    }
  }
}

/** Read the Compute-owned, immutable Pod generation once for this invocation. */
export async function readRuntimeRepositoryManifest(
  root = repositoryMaterialRoot,
  finalRoot = root,
): Promise<RuntimeRepositoryManifest> {
  for (const directory of [root, finalRoot]) {
    if (
      !isAbsolute(directory) ||
      resolve(directory) !== directory ||
      directory.length > 4096 ||
      [...directory].some(
        (character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
      )
    ) {
      throw new Error("invalid-repository-material");
    }
  }
  await assertPrivateDirectory(root);
  await assertPrivateDirectory(join(root, "sessions"));
  const parsed = record(
    JSON.parse((await readPrivateFile(join(root, "manifest.json"), 256 * 1024)).toString("utf8")),
    ["version", "generation", "bindings"],
  );
  if (
    parsed.version !== 1 ||
    typeof parsed.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.generation) ||
    !Array.isArray(parsed.bindings) ||
    parsed.bindings.length === 0 ||
    parsed.bindings.length > 16
  ) {
    throw new Error("invalid-repository-material");
  }
  const refs = new Set<string>();
  const sessions = new Set<string>();
  const bindings: RuntimeRepositoryBinding[] = [];
  for (const value of parsed.bindings) {
    const binding = record(value, [
      "repositoryRef",
      "sessionId",
      "deadlineWallMs",
      "directory",
      "client",
    ]);
    if (
      typeof binding.repositoryRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.repositoryRef) ||
      typeof binding.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(binding.sessionId) ||
      typeof binding.deadlineWallMs !== "number" ||
      !Number.isSafeInteger(binding.deadlineWallMs) ||
      binding.deadlineWallMs <= 0 ||
      refs.has(binding.repositoryRef) ||
      sessions.has(binding.sessionId)
    ) {
      throw new Error("invalid-repository-material");
    }
    const directory = join(
      finalRoot,
      "sessions",
      digest([binding.repositoryRef, binding.sessionId]),
    );
    if (binding.directory !== directory) {
      throw new Error("invalid-repository-material");
    }
    const client = readPublicClient(binding.client);
    const materialDirectory = join(
      root,
      "sessions",
      digest([binding.repositoryRef, binding.sessionId]),
    );
    const configuration = await readClientConfiguration(materialDirectory);
    record(configuration, ["sessionId", "deadlineWallMs", "client", "hasPublicCa"]);
    readPublicClient(configuration.client);
    if (
      configuration.sessionId !== binding.sessionId ||
      configuration.deadlineWallMs !== binding.deadlineWallMs ||
      !clientsAgree(client, configuration.client)
    ) {
      throw new Error("invalid-repository-material");
    }
    await validateMaterialFiles(materialDirectory, configuration.hasPublicCa);
    refs.add(binding.repositoryRef);
    sessions.add(binding.sessionId);
    bindings.push(
      Object.freeze({
        repositoryRef: binding.repositoryRef,
        sessionId: binding.sessionId,
        deadlineWallMs: binding.deadlineWallMs,
        directory,
        materialDirectory,
        client,
        configuration,
      }),
    );
  }
  const tuples = bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId]);
  const sorted = [...tuples].sort((left, right) => {
    const first = left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0;
    return first || (left[1]! < right[1]! ? -1 : left[1]! > right[1]! ? 1 : 0);
  });
  if (JSON.stringify(tuples) !== JSON.stringify(sorted) || digest(sorted) !== parsed.generation) {
    throw new Error("invalid-repository-material");
  }
  return Object.freeze({ generation: parsed.generation, bindings: Object.freeze(bindings) });
}

export function requireCurrentBinding(binding: RuntimeRepositoryBinding): void {
  if (binding.deadlineWallMs <= Date.now()) {
    throw new Error("repository-session-expired");
  }
}

export function inheritedRepositoryBinding(
  manifest: RuntimeRepositoryManifest,
  environment: NodeJS.ProcessEnv,
): RuntimeRepositoryBinding | undefined {
  const inherited = environment[repositorySelectionVariable];
  const reference = environment.OCE_REPOSITORY_REF;
  let pinned: RuntimeRepositoryBinding | undefined;
  if (inherited !== undefined) {
    if (inherited.length > 1024) {
      throw new Error("invalid-repository-selection");
    }
    const tuple: unknown = JSON.parse(inherited);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      !tuple.every((part) => typeof part === "string") ||
      tuple[0] !== manifest.generation
    ) {
      throw new Error("invalid-repository-selection");
    }
    pinned = manifest.bindings.find(
      (binding) => binding.repositoryRef === tuple[1] && binding.sessionId === tuple[2],
    );
    if (!pinned) {
      throw new Error("invalid-repository-selection");
    }
  }
  if (reference !== undefined) {
    const selected = manifest.bindings.find((binding) => binding.repositoryRef === reference);
    if (!selected || (pinned && selected !== pinned)) {
      throw new Error("conflicting-repository-selection");
    }
    pinned = selected;
  }
  if (pinned) {
    requireCurrentBinding(pinned);
  }
  return pinned;
}

export function repositorySelection(
  manifest: RuntimeRepositoryManifest,
  binding: RuntimeRepositoryBinding,
): string {
  return JSON.stringify([manifest.generation, binding.repositoryRef, binding.sessionId]);
}
