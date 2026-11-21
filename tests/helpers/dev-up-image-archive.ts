import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const blockSize = 512;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function blobPath(id: string): string {
  assert.match(id, digestPattern);
  return `blobs/sha256/${id.slice("sha256:".length)}`;
}

// Only ordinary USTAR files are needed for the small, uncompressed fixture image.
function tarFiles(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, bytes] of entries) {
    assert.ok(Buffer.byteLength(name) <= 100);
    const header = Buffer.alloc(blockSize);
    header.write(name, 0, 100);
    header.write("0000600\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    parts.push(header, bytes, Buffer.alloc((blockSize - (bytes.length % blockSize)) % blockSize));
  }
  return Buffer.concat([...parts, Buffer.alloc(blockSize * 2)]);
}

function tarString(bytes: Buffer): string {
  return bytes.toString("utf8").split("\0", 1)[0] ?? "";
}

function readTarFiles(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + blockSize <= archive.length) {
    const header = archive.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) {
      assert.ok(archive.length - offset >= blockSize * 2, "Missing tar end marker");
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        "Data follows tar end marker",
      );
      return files;
    }
    const expectedChecksum = Number.parseInt(tarString(header.subarray(148, 156)).trim(), 8);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    assert.equal(checksum, expectedChecksum, "Invalid fixture tar checksum");
    assert.ok(header[156] === 0 || header[156] === 0x30, "Expected a regular tar file");
    const prefix = tarString(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${tarString(header.subarray(0, 100))}`;
    assert.ok(name !== "" && !files.has(name), "Duplicate or empty fixture tar path");
    const size = Number.parseInt(tarString(header.subarray(124, 136)).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, "Invalid fixture tar size");
    offset += blockSize;
    assert.ok(offset + size <= archive.length, "Truncated fixture tar file");
    files.set(name, archive.subarray(offset, offset + size));
    offset += Math.ceil(size / blockSize) * blockSize;
  }
  assert.fail("Missing fixture tar end marker");
}

type FixtureImage = {
  id: string;
  config: Buffer;
  layer: Buffer;
  manifest: Buffer;
  manifestDigest: string;
};

function makeImage(source: string): FixtureImage {
  // An empty uncompressed tar is a valid layer. The source label makes separate
  // fixture images distinct without using a credential or real registry content.
  const layer = tarFiles([]);
  const layerDigest = digest(layer);
  const config = jsonBytes({
    architecture: "amd64",
    os: "linux",
    config: { Labels: { "org.openclaw.test.image": source } },
    rootfs: { type: "layers", diff_ids: [layerDigest] },
  });
  const id = digest(config);
  const manifest = jsonBytes({
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: id,
      size: config.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: layerDigest,
        size: layer.length,
      },
    ],
  });
  return { id, config, layer, manifest, manifestDigest: digest(manifest) };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** The image store for one dev-up command fixture; it never contacts a daemon. */
export class DevUpImageArchives {
  private readonly sources = new Map<string, FixtureImage>();
  private readonly identities = new Map<string, FixtureImage>();

  private image(source: string): FixtureImage {
    if (digestPattern.test(source)) {
      const image = this.identities.get(source);
      assert.ok(image, "Image save must use an inspected fixture image identity");
      return image;
    }
    let image = this.sources.get(source);
    if (!image) {
      image = makeImage(source);
      this.sources.set(source, image);
      this.identities.set(image.id, image);
    }
    return image;
  }

  identity(source: string): string {
    return this.image(source).id;
  }

  platform(source: string): string {
    this.image(source);
    return "linux/amd64";
  }

  save(source: string, destination: string, omitConfig = false): void {
    assert.ok(
      digestPattern.test(source) || /@sha256:[a-f0-9]{64}$/.test(source),
      "Image export must be immutable",
    );
    const image = this.image(source);
    const configPath = blobPath(image.id);
    const layerPath = blobPath(digest(image.layer));
    const manifestPath = blobPath(image.manifestDigest);
    const entries: [string, Buffer][] = [
      [layerPath, image.layer],
      [
        "manifest.json",
        jsonBytes([{ Config: configPath, RepoTags: [], Layers: [layerPath], LayerSources: {} }]),
      ],
      [manifestPath, image.manifest],
      ["oci-layout", jsonBytes({ imageLayoutVersion: "1.0.0" })],
      [
        "index.json",
        jsonBytes({
          schemaVersion: 2,
          manifests: [
            {
              mediaType: manifestMediaType,
              digest: image.manifestDigest,
              size: image.manifest.length,
              annotations: { "io.containerd.image.name": "example.invalid/dev-up:original" },
            },
          ],
        }),
      ],
      ["repositories", jsonBytes({ "example.invalid/dev-up": { original: "fixture-layer" } })],
    ];
    if (!omitConfig) {
      entries.unshift([configPath, image.config]);
    }
    writeFileSync(destination, tarFiles(entries), { flag: "wx", mode: 0o600 });
  }

  imported(archive: string): { name: string; digest: string } {
    const files = readTarFiles(readFileSync(archive));
    for (const metadata of ["oci-layout", "index.json", "repositories"]) {
      assert.ok(!files.has(metadata), "The prepared archive must use Docker naming only");
    }
    const bytes = files.get("manifest.json");
    assert.ok(bytes, "The imported archive must contain a Docker manifest");
    const manifests: unknown = JSON.parse(bytes.toString("utf8"));
    assert.ok(Array.isArray(manifests) && manifests.length === 1);
    const manifest = object(manifests[0]);
    assert.ok(typeof manifest.Config === "string");
    const config = files.get(manifest.Config);
    assert.ok(config, "The imported config must exist");
    const image = this.identities.get(digest(config));
    assert.ok(image, "The imported config must be from this fixture's image export");
    assert.equal(manifest.Config, blobPath(image.id));
    assert.deepEqual(config, image.config);
    const layerPath = blobPath(digest(image.layer));
    assert.deepEqual(manifest.Layers, [layerPath]);
    assert.deepEqual(files.get(layerPath), image.layer);
    assert.deepEqual(files.get(blobPath(image.manifestDigest)), image.manifest);
    const names = manifest.RepoTags;
    assert.ok(Array.isArray(names) && names.length === 1 && typeof names[0] === "string");
    return { name: names[0], digest: image.manifestDigest };
  }
}
