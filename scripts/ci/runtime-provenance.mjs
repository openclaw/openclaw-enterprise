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

// Publish an opaque attempt identity; the private prefix remains a resource owner.
export function preparationIdentity(prefix) {
  return typeof prefix === "string" && prefix.length > 0
    ? createHash("sha256").update(prefix).digest("hex")
    : undefined;
}

export async function readRuntimeProvenance(statePath, { lane, preparationId }) {
  let records;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof preparationId !== "string" ||
      state.lane !== lane ||
      preparationIdentity(state.prefix) !== preparationId
    ) {
      return undefined;
    }
    records = state.runtimeProvenance;
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
  const errors = [];
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
  errors.push(
    ...outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason),
  );
  if (errors.length) {
    throw new AggregateError(errors, "Runtime provenance cleanup failed");
  }
  return metadata;
}
