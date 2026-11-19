import { createHash } from "node:crypto";
import { imageConfigDigest } from "../../scripts/ci/image-config-digest.ts";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

function verifiedJson(raw: string, digest: string): Record<string, unknown> {
  // buildx can add a display newline; accept it only if removing it restores the pinned bytes.
  const candidates = [raw, ...(raw.endsWith("\n") ? [raw.slice(0, -1)] : [])];
  const bytes = candidates.find(
    (candidate) => `sha256:${createHash("sha256").update(candidate).digest("hex")}` === digest,
  );
  if (!digestPattern.test(digest) || bytes === undefined) {
    throw new Error("stock image metadata does not match its digest");
  }
  const value: unknown = JSON.parse(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stock image metadata is not an object");
  }
  return value as Record<string, unknown>;
}

export function stockSupervisorManifest(indexRaw: string, indexDigest: string, platform: string) {
  if (!["linux/amd64", "linux/arm64"].includes(platform)) {
    throw new Error("unsupported stock Supervisor platform");
  }
  const index = verifiedJson(indexRaw, indexDigest);
  if (!indexTypes.has(String(index.mediaType)) || !Array.isArray(index.manifests)) {
    throw new Error("stock Supervisor pin does not identify an image index");
  }
  const matches = index.manifests.filter((entry: unknown) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const descriptor = entry as Record<string, unknown>;
    const selected = descriptor.platform as Record<string, unknown> | undefined;
    return selected && `${selected.os}/${selected.architecture}` === platform;
  }) as Record<string, unknown>[];
  if (
    matches.length !== 1 ||
    !manifestTypes.has(String(matches[0]?.mediaType)) ||
    typeof matches[0]?.digest !== "string" ||
    !digestPattern.test(matches[0].digest)
  ) {
    throw new Error("stock Supervisor index has no unique platform manifest");
  }
  return { mediaType: String(matches[0].mediaType), digest: matches[0].digest };
}

export async function stockSupervisorConfig(
  descriptor: { mediaType: string; digest: string },
  manifestRaw: string,
  inspected: Parameters<typeof imageConfigDigest>[0] & { Os?: string; Architecture?: string },
  platform: string,
): Promise<string> {
  const manifest = verifiedJson(manifestRaw, descriptor.digest);
  if (manifest.mediaType !== descriptor.mediaType) {
    throw new Error("stock Supervisor manifest media type differs from its descriptor");
  }
  const config = manifest.config as Record<string, unknown> | undefined;
  if (typeof config?.digest !== "string" || !digestPattern.test(config.digest)) {
    throw new Error("stock Supervisor manifest has no config digest");
  }
  if (`${inspected.Os}/${inspected.Architecture}` !== platform) {
    throw new Error("stock Supervisor inspection differs from the selected platform");
  }
  if (
    inspected.Descriptor &&
    (inspected.Descriptor.digest !== descriptor.digest ||
      inspected.Descriptor.mediaType !== descriptor.mediaType)
  ) {
    throw new Error("stock Supervisor inspection differs from the pinned platform manifest");
  }
  const resolved = await imageConfigDigest(inspected, async (digest) => {
    if (digest !== descriptor.digest) {
      throw new Error("stock Supervisor inspection requested an unexpected manifest");
    }
    return manifestRaw.endsWith("\n") &&
      `sha256:${createHash("sha256").update(manifestRaw).digest("hex")}` !== descriptor.digest
      ? manifestRaw.slice(0, -1)
      : manifestRaw;
  });
  if (resolved !== config.digest) {
    throw new Error("stock Supervisor inspection differs from the pinned config");
  }
  return config.digest;
}
