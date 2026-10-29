import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

interface ImageFixture {
  runtimeImage: string;
  runtimeImageIndexFile?: string;
  runtimeImageManifestFile?: string;
}
interface ImageIdentity {
  selected: string;
  indexDigest: string | undefined;
  manifestDigest: string;
  configDigest: string | undefined;
}
interface ImageDescriptor {
  digest: string;
  platform?: { os: string; architecture: string; variant?: string };
}
interface ObservedPod {
  metadata: { name: string };
  status?: {
    containerStatuses?: { name: string; imageID?: string; state?: { running?: object } }[];
  };
}
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Resolve only digest-verified, operator-supplied OCI documents; no registry access. */
export async function strandsImageIdentity(fixture: ImageFixture): Promise<ImageIdentity> {
  const selected = fixture.runtimeImage.match(/@(?<digest>sha256:[a-f0-9]{64})$/u)?.groups?.digest;
  assert.ok(selected, "select an immutable runtime image");
  let manifestDigest = selected;
  let indexDigest;
  if (fixture.runtimeImageIndexFile) {
    const bytes = await readFile(fixture.runtimeImageIndexFile);
    assert.equal(digest(bytes), selected, "runtime image index digest mismatch");
    const candidates = (JSON.parse(bytes.toString()).manifests as ImageDescriptor[]).filter(
      ({ platform }) =>
        platform?.os === "linux" &&
        platform.architecture === "arm64" &&
        (!platform.variant || platform.variant === "v8"),
    );
    assert.equal(candidates.length, 1, "index must select exactly one Linux ARM64 manifest");
    const candidate = candidates[0];
    assert.ok(candidate);
    manifestDigest = candidate.digest;
    assert.match(manifestDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(
      fixture.runtimeImageManifestFile,
      "provide the selected ARM64 manifest with the index",
    );
    indexDigest = selected;
  }
  let configDigest: string | undefined;
  if (fixture.runtimeImageManifestFile) {
    const bytes = await readFile(fixture.runtimeImageManifestFile);
    assert.equal(digest(bytes), manifestDigest, "runtime ARM64 manifest digest mismatch");
    const manifest = JSON.parse(bytes.toString());
    assert.ok(Array.isArray(manifest.layers), "expected an image manifest");
    configDigest = manifest.config.digest;
    assert.match(configDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
  }
  return { selected, indexDigest, manifestDigest, configDigest };
}

export function assertStrandsRunningImage(
  pod: ObservedPod,
  container: { name: string },
  identity: ImageIdentity,
) {
  const status = pod.status?.containerStatuses?.find((item) => item.name === container.name);
  assert.ok(
    status?.state?.running,
    `${pod.metadata.name}/${container.name}: container is not running`,
  );
  assert.ok(typeof status.imageID === "string", "running image ID is absent");
  assert.ok(status.imageID.trim(), "running image ID is empty");
  const observed = status.imageID.match(/(?:^|\/\/|@)(sha256:[a-f0-9]{64})$/u)?.[1];
  assert.ok(observed, `unrecognized running image ID: ${status.imageID}`);
  assert.ok(
    observed === identity.manifestDigest || observed === identity.configDigest,
    "running image ID does not match the selected ARM64 manifest/config; provide digest-verified OCI documents for an index or config ID",
  );
  return status.imageID;
}
