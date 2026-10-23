import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { imageConfigDigest } from "../../scripts/ci/image-config-digest.mjs";

const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const config = sha("image config");
const manifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config, size: 12 },
  layers: [],
});
const manifestDescriptor = {
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  digest: sha(manifest),
  size: manifest.length,
  platform: { architecture: "amd64", os: "linux" },
};
const noBlob = async () => assert.fail("the config digest needs no blob read");

test("classic Docker image store reports the config digest as Id", async () => {
  assert.equal(await imageConfigDigest({ Id: config }, noBlob), config);
});

test("an annotated platform descriptor names the config digest", async () => {
  const inspected = {
    Id: sha(manifest),
    Descriptor: { ...manifestDescriptor, annotations: { "config.digest": config } },
  };
  assert.equal(await imageConfigDigest(inspected, noBlob), config);
});

test("Docker 29 containerd store: unannotated platform manifest is read and verified", async () => {
  // docker image inspect --platform linux/amd64 on Docker 29.9 (containerd image store):
  // Id and Descriptor name the platform manifest and carry no config.digest annotation.
  const inspected = { Id: manifestDescriptor.digest, Descriptor: manifestDescriptor };
  const reads = [];
  const read = async (digest) => {
    reads.push(digest);
    return manifest;
  };
  assert.equal(await imageConfigDigest(inspected, read), config);
  assert.deepEqual(reads, [manifestDescriptor.digest]);
  // A blob that is not the described manifest cannot supply the config digest.
  const forged = manifest.replace(config, sha("other config"));
  await assert.rejects(
    imageConfigDigest(inspected, async () => forged),
    /does not match/,
  );
  const noConfig = JSON.stringify({ schemaVersion: 2, layers: [] });
  await assert.rejects(
    imageConfigDigest({ Descriptor: { ...manifestDescriptor, digest: sha(noConfig) } }, async () =>
      Buffer.from(noConfig),
    ),
    /no config digest/,
  );
});

test("an index descriptor without a platform keeps Id for the caller to compare", async () => {
  const index = sha("index");
  const inspected = {
    Id: index,
    Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json", digest: index, size: 1 },
  };
  assert.equal(await imageConfigDigest(inspected, noBlob), index);
});
