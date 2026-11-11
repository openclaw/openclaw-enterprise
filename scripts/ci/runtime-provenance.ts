import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  extractImageFile,
  ImageFileReadError,
  removeImageFileContainer,
} from "../lib/image-file.mjs";
import { readFile, rm } from "node:fs/promises";

const digest = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const version =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
type RuntimeRole = "OCC_TEST_KUBERNETES_GATEWAY_IMAGE" | "OCC_TEST_KUBERNETES_AGENT_IMAGE";
type CodexProvenance = {
  platform: "linux/amd64" | "linux/arm64";
  openclawCommit: string;
  codex: { version: string; binarySha256: string };
};
type RuntimeProvenance = { imageId: string; manifestDigest: string } & (
  ({ status: "available" } & CodexProvenance) | { status: "unavailable" }
);
type ImageResource = {
  id: string;
  name: string;
  removed?: boolean;
  containerId?: string;
  ownershipToken?: string;
  creationAcknowledged?: boolean;
};
type ImageCommand = (
  executable: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; encoding?: "buffer"; maxBuffer?: number },
) => Promise<string | Buffer>;

const roles: RuntimeRole[] = [
  "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
  "OCC_TEST_KUBERNETES_AGENT_IMAGE",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Only image-owned build metadata crosses into uploaded evidence. In particular,
// do not copy arbitrary provenance fields, image configuration, or error output.
export function codexProvenance(metadata: unknown, platform: unknown): CodexProvenance | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const codex = metadata.codex;
  if (
    (platform !== "linux/amd64" && platform !== "linux/arm64") ||
    !isRecord(codex) ||
    codex.architecture !== platform.slice(6) ||
    typeof codex.version !== "string" ||
    codex.version.length > 96 ||
    !version.test(codex.version) ||
    typeof codex.binarySha256 !== "string" ||
    !hash.test(codex.binarySha256) ||
    typeof metadata.commit !== "string" ||
    !commit.test(metadata.commit)
  ) {
    return undefined;
  }
  return {
    platform,
    openclawCommit: metadata.commit,
    codex: { version: codex.version, binarySha256: codex.binarySha256 },
  };
}

// Publish an opaque attempt identity; the private prefix remains a resource owner.
export function preparationIdentity(prefix: unknown): string | undefined {
  return typeof prefix === "string" && prefix.length > 0
    ? createHash("sha256").update(prefix).digest("hex")
    : undefined;
}

export async function readRuntimeProvenance(
  statePath: string,
  { lane, preparationId }: { lane: string; preparationId: string | undefined },
): Promise<Partial<Record<RuntimeRole, RuntimeProvenance>> | undefined> {
  let records: unknown;
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof preparationId !== "string" ||
      !isRecord(state) ||
      state.lane !== lane ||
      preparationIdentity(state.prefix) !== preparationId
    ) {
      return undefined;
    }
    records = state.runtimeProvenance;
  } catch {
    return undefined;
  }
  const projected: Partial<Record<RuntimeRole, RuntimeProvenance>> = {};
  for (const role of roles) {
    const record = isRecord(records) ? records[role] : undefined;
    if (
      !isRecord(record) ||
      typeof record.imageId !== "string" ||
      typeof record.manifestDigest !== "string" ||
      !digest.test(record.imageId) ||
      !digest.test(record.manifestDigest)
    ) {
      continue;
    }
    const identity = { imageId: record.imageId, manifestDigest: record.manifestDigest };
    const metadata = codexProvenance(
      {
        commit: record.openclawCommit,
        codex: {
          ...(isRecord(record.codex) ? record.codex : {}),
          architecture: typeof record.platform === "string" ? record.platform.slice(6) : undefined,
        },
      },
      record.platform,
    );
    projected[role] =
      record.status === "available" && metadata
        ? { ...identity, status: "available", ...metadata }
        : { ...identity, status: "unavailable" };
  }
  return Object.keys(projected).length ? projected : undefined;
}

// Extract from a stopped container of the exact selected local image. The
// caller records resource ownership before this function can create anything.
export async function readImageCodexProvenance({
  imageId,
  platform,
  directory,
  resource,
  command,
  persist,
}: {
  imageId: string;
  platform: string;
  directory: string;
  resource: ImageResource;
  command: ImageCommand;
  persist: () => Promise<void>;
}): Promise<CodexProvenance | undefined> {
  const destination = join(directory, `${resource.id}.json`);
  let metadata: CodexProvenance | undefined;
  const errors: unknown[] = [];
  try {
    await extractImageFile({
      command,
      cleanup: [],
      image: imageId,
      platform,
      filename: "/opt/oce/runtime/provenance.json",
      destination,
      maxBytes: 64 * 1024,
      resource,
      persist,
    });
    try {
      metadata = codexProvenance(JSON.parse(await readFile(destination, "utf8")), platform);
    } catch {
      // Only content read/parse failures are observational.
    }
  } catch (error) {
    if (!(error instanceof ImageFileReadError)) {
      errors.push(error);
    }
  }
  const outcomes = await Promise.allSettled([
    removeImageFileContainer({ command, resource, persist }),
    rm(destination, { force: true }),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      const reason: unknown = outcome.reason;
      errors.push(reason);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Runtime provenance cleanup failed");
  }
  return metadata;
}
