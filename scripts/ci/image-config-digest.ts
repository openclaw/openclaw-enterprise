import { createHash } from "node:crypto";

interface InspectedImage {
  Id?: string;
  Descriptor?: {
    mediaType?: string;
    digest: string;
    annotations?: { [name: string]: string };
  };
}

type ReadImageBlob = (digest: string) => Promise<string | Uint8Array>;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

/**
 * The config digest (the CRI image ID) of one `docker image inspect` result.
 *
 * A classic Docker image store reports the config digest as `Id`. The containerd image
 * store (the default since Docker 29) reports the index or manifest digest instead; with
 * `--platform` its `Descriptor` is the platform manifest, which some versions annotate with
 * `config.digest` and others do not. Without the annotation, read the manifest blob through
 * `readBlob(digest)`, check it against its digest, and take its config descriptor.
 */
export async function imageConfigDigest(
  inspected: InspectedImage,
  readBlob: ReadImageBlob,
): Promise<string | undefined> {
  const descriptor = inspected.Descriptor;
  const annotated = descriptor?.annotations?.["config.digest"];
  if (annotated !== undefined) {
    return annotated;
  }
  if (!descriptor || !manifestTypes.has(descriptor.mediaType ?? "")) {
    return inspected.Id;
  }
  if (!digestPattern.test(descriptor.digest)) {
    throw new Error("The image manifest descriptor has no SHA-256 digest.");
  }
  const blob = Buffer.from(await readBlob(descriptor.digest));
  if ("sha256:" + createHash("sha256").update(blob).digest("hex") !== descriptor.digest) {
    throw new Error(`The image manifest ${descriptor.digest} does not match its digest.`);
  }
  const manifest: unknown = JSON.parse(blob.toString("utf8"));
  const configDescriptor =
    manifest !== null && typeof manifest === "object" && "config" in manifest
      ? manifest.config
      : undefined;
  const config =
    configDescriptor !== null &&
    typeof configDescriptor === "object" &&
    "digest" in configDescriptor
      ? configDescriptor.digest
      : undefined;
  if (typeof config !== "string" || !digestPattern.test(config)) {
    throw new Error(`The image manifest ${descriptor.digest} has no config digest.`);
  }
  return config;
}
