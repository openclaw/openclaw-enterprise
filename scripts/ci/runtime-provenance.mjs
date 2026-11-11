import { join } from "node:path";
import { extractImageFile, removeImageFileContainer } from "../lib/image-file.mjs";
import { lstat, readFile, rm } from "node:fs/promises";

const digest = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,64})?$/;
const roles = ["OCC_TEST_KUBERNETES_GATEWAY_IMAGE", "OCC_TEST_KUBERNETES_AGENT_IMAGE"];

// Only image-owned build metadata crosses into uploaded evidence. In particular,
// do not copy arbitrary provenance fields, image configuration, or error output.
export function codexProvenance(metadata, platform) {
  const codex = metadata?.codex;
  if (
    !["linux/amd64", "linux/arm64"].includes(platform) ||
    codex?.architecture !== platform.slice(6) ||
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

export async function readRuntimeProvenance(statePath) {
  let records;
  try {
    records = JSON.parse(await readFile(statePath, "utf8")).runtimeProvenance;
  } catch {
    return undefined;
  }
  const projected = {};
  for (const role of roles) {
    const record = records?.[role];
    if (
      !record ||
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
          ...record.codex,
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
}) {
  const destination = join(directory, `${resource.id}.json`);
  let metadata;
  try {
    await extractImageFile({
      command,
      cleanup: [],
      image: imageId,
      platform,
      filename: "/opt/oce/runtime/provenance.json",
      destination,
      resource,
      persist,
    });
    const info = await lstat(destination);
    if (info.isFile() && info.size <= 64 * 1024) {
      metadata = codexProvenance(JSON.parse(await readFile(destination, "utf8")), platform);
    }
  } catch {
    // Read failures are observational; resource cleanup below is mandatory.
  }
  const outcomes = await Promise.allSettled([
    removeImageFileContainer({ command, resource }),
    rm(destination, { force: true }),
  ]);
  const errors = outcomes
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (errors.length) {
    throw new AggregateError(errors, "Runtime provenance cleanup failed");
  }
  return metadata;
}
