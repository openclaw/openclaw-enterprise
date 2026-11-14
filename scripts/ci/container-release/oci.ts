import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  digestPattern,
  field,
  fileDigest,
  identity,
  integerPattern,
  isPlatform,
  match,
  platforms,
  shaPattern,
} from "./metadata.ts";

// Read the exact blobs named by the OCI index, never an extracted checkout path.
// Hash verification binds platform/config claims to the index's immutable digest.
export function readArchivePlatforms(archive: string, indexDigest: string) {
  function blob(value: unknown): unknown {
    const digest = value ?? "";
    match(digest, digestPattern);
    const bytes = execFileSync("tar", ["-xOf", archive, `blobs/sha256/${digest.slice(7)}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, digest);
    return JSON.parse(bytes.toString("utf8"));
  }
  const index = blob(indexDigest);
  assert.equal(field(index, "schemaVersion"), 2);
  assert.equal(field(index, "mediaType"), "application/vnd.oci.image.index.v1+json");
  const manifests = field(index, "manifests");
  assert.ok(Array.isArray(manifests));
  const selected = manifests
    .map((descriptor: unknown) => {
      const mediaType = field(descriptor, "mediaType");
      assert.equal(mediaType, "application/vnd.oci.image.manifest.v1+json");
      const description = field(descriptor, "platform");
      const platform = `${field(description, "os")}/${field(description, "architecture")}`;
      assert.ok(isPlatform(platform), `Unexpected image platform: ${platform}`);
      const variant = field(description, "variant");
      assert.ok(
        variant === undefined || (platform === "linux/arm64" && variant === "v8"),
        "Unsupported platform variant.",
      );
      const digest = field(descriptor, "digest");
      const manifest = blob(digest);
      assert.equal(field(manifest, "schemaVersion"), 2);
      assert.equal(field(manifest, "mediaType"), mediaType);
      const configDigest = field(field(manifest, "config"), "digest");
      const config = blob(configDigest);
      assert.equal(
        `${field(config, "os")}/${field(config, "architecture")}`,
        platform,
        "Config platform mismatch.",
      );
      assert.ok(typeof digest === "string" && typeof configDigest === "string");
      return { platform, digest, configDigest };
    })
    .sort((left, right) => left.platform.localeCompare(right.platform));
  assert.deepEqual(
    selected.map((image) => image.platform),
    platforms,
  );
  return selected;
}

// Verification shares the immutable OCI walk. Only assemble links its blobs.
export async function verifyPlatform(
  layout: string,
  env: NodeJS.ProcessEnv,
  platform: string | undefined,
  expectedDigest?: string,
  receiptName: "platform.json" | "build.json" = "platform.json",
) {
  const expected = identity(env, env.IMAGE);
  match(expected.sourceSha, shaPattern, "Expected a full source SHA.");
  match(expected.workflowSha, shaPattern, "Expected a full workflow SHA.");
  match(expected.runId, integerPattern, "Expected a producer run ID.");
  match(expected.attempt, integerPattern, "Expected a producer attempt.");
  if (expected.ciRunId !== "" || expected.ciAttempt !== "") {
    match(expected.ciRunId, integerPattern, "Expected a CI run ID.");
    match(expected.ciAttempt, integerPattern, "Expected a CI attempt.");
  }
  match(expected.nodeBaseImage, /^\S+@sha256:[a-f0-9]{64}$/, "Expected a pinned Node base image.");
  assert.ok(isPlatform(platform), "Expected linux/amd64 or linux/arm64.");
  const arch = platform === "linux/amd64" ? "amd64" : "arm64";
  for (const dir of [layout, join(layout, "blobs"), join(layout, "blobs/sha256")]) {
    assert.ok((await lstat(dir)).isDirectory(), "Expected an OCI layout directory.");
  }
  async function regularFile(path: string) {
    const info = await lstat(path);
    assert.ok(info.isFile() && info.nlink === 1, "Expected a regular OCI file without links.");
    return info;
  }
  async function metadata(name: string): Promise<unknown> {
    const path = join(layout, name);
    await regularFile(path);
    return JSON.parse(await readFile(path, "utf8"));
  }
  assert.equal(field(await metadata("oci-layout"), "imageLayoutVersion"), "1.0.0");
  const receipt = await metadata(receiptName);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(field(receipt, key), value, `Platform receipt ${key} mismatch.`);
  }
  assert.equal(field(receipt, "platform"), platform, "Platform receipt architecture mismatch.");
  assert.equal(
    field(receipt, "native"),
    receiptName === "platform.json",
    receiptName === "platform.json"
      ? "Platform must pass smoke on its native runner."
      : "Untested builds must not claim native smoke success.",
  );
  const rootDigest = field(receipt, "digest");
  if (expectedDigest !== undefined) {
    assert.equal(rootDigest, expectedDigest, "Selected build digest mismatch.");
  }
  const blobs = new Map<string, string>();
  async function verifyBlob(descriptor: unknown) {
    const digest = field(descriptor, "digest") ?? "";
    match(digest, digestPattern);
    const path = join(layout, "blobs/sha256", digest.slice(7));
    const info = await regularFile(path);
    assert.equal(info.size, field(descriptor, "size"), "OCI blob size mismatch.");
    assert.equal(`sha256:${await fileDigest(path)}`, digest, "OCI blob digest mismatch.");
    blobs.set(digest, path);
    return { path, digest, size: info.size };
  }
  async function readBlob(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8"));
  }
  function checkPlatform(descriptorPlatform: unknown) {
    if (descriptorPlatform !== undefined) {
      assert.equal(field(descriptorPlatform, "os"), "linux");
      assert.equal(
        field(descriptorPlatform, "architecture"),
        arch,
        "Exported platform configuration mismatch.",
      );
      assert.ok(
        field(descriptorPlatform, "variant") === undefined ||
          (arch === "arm64" && field(descriptorPlatform, "variant") === "v8"),
      );
    }
  }
  const root = await metadata("index.json");
  const rootMediaType = field(root, "mediaType");
  if (rootMediaType !== undefined) {
    assert.equal(rootMediaType, "application/vnd.oci.image.index.v1+json");
  }
  assert.equal(field(root, "subject"), undefined, "Unexpected OCI subject.");
  assert.equal(field(root, "schemaVersion"), 2);
  const exported = field(root, "manifests");
  assert.ok(
    Array.isArray(exported) && exported.length === 1,
    "Expected exactly one exported platform.",
  );
  let descriptor: unknown = exported[0];
  assert.equal(field(descriptor, "digest"), rootDigest, "Build output digest mismatch.");
  checkPlatform(field(descriptor, "platform"));
  if (field(descriptor, "mediaType") === "application/vnd.oci.image.index.v1+json") {
    const index = await readBlob((await verifyBlob(descriptor)).path);
    assert.equal(field(index, "schemaVersion"), 2);
    assert.equal(field(index, "mediaType"), field(descriptor, "mediaType"));
    assert.equal(field(index, "subject"), undefined, "Unexpected OCI subject.");
    const nested = field(index, "manifests");
    assert.ok(
      Array.isArray(nested) && nested.length === 1,
      "Expected exactly one platform manifest.",
    );
    descriptor = nested[0];
    checkPlatform(field(descriptor, "platform"));
  }
  const mediaType = field(descriptor, "mediaType");
  assert.equal(mediaType, "application/vnd.oci.image.manifest.v1+json");
  const manifestBlob = await verifyBlob(descriptor);
  const manifest = await readBlob(manifestBlob.path);
  assert.equal(field(manifest, "schemaVersion"), 2);
  assert.equal(field(manifest, "mediaType"), mediaType);
  assert.equal(field(manifest, "subject"), undefined, "Unexpected OCI subject.");
  const configDescriptor = field(manifest, "config");
  assert.equal(field(configDescriptor, "mediaType"), "application/vnd.oci.image.config.v1+json");
  const configBlob = await verifyBlob(configDescriptor);
  checkPlatform(await readBlob(configBlob.path));
  const layers = field(manifest, "layers");
  assert.ok(Array.isArray(layers), "Expected OCI image layers.");
  const layerDescriptors: readonly unknown[] = layers;
  for (const layer of layerDescriptors) {
    await verifyBlob(layer);
  }
  assert.ok(typeof rootDigest === "string");
  // Exporter annotations (including build time) must not affect the combined index.
  return {
    manifest: {
      mediaType,
      digest: manifestBlob.digest,
      size: manifestBlob.size,
      platform: { os: "linux", architecture: arch },
    },
    configDigest: configBlob.digest,
    rootDigest,
    blobs,
  };
}

export async function assemble(directory: string, env: NodeJS.ProcessEnv) {
  const combined = join(directory, "combined");
  await mkdir(combined);
  await mkdir(join(combined, "blobs/sha256"), { recursive: true });
  const retained = new Set<string>();
  const manifests: Awaited<ReturnType<typeof verifyPlatform>>["manifest"][] = [];
  for (const arch of ["amd64", "arm64"]) {
    const { manifest, blobs } = await verifyPlatform(join(directory, arch), env, `linux/${arch}`);
    for (const [digest, path] of blobs) {
      if (!retained.has(digest)) {
        await link(path, join(combined, "blobs/sha256", digest.slice(7)));
        retained.add(digest);
      }
    }
    manifests.push(manifest);
  }
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  };
  const bytes = JSON.stringify(index);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await writeFile(join(combined, "blobs/sha256", digest.slice(7)), bytes);
  await writeFile(
    join(combined, "index.json"),
    JSON.stringify({
      ...index,
      manifests: [{ mediaType: index.mediaType, digest, size: Buffer.byteLength(bytes) }],
    }),
  );
  await writeFile(join(combined, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const archive = join(directory, "image.tar");
  execFileSync("tar", ["-cf", archive, "-C", combined, "blobs", "index.json", "oci-layout"]);
  readArchivePlatforms(archive, digest);
  for (const path of ["amd64", "arm64", "combined"]) {
    await rm(join(directory, path), { recursive: true });
  }
  assert.ok(env.GITHUB_OUTPUT !== undefined, "GITHUB_OUTPUT is required.");
  await appendFile(env.GITHUB_OUTPUT, `digest=${digest}\n`);
}

// Intermediate runtime artifacts cannot satisfy the qualified platform receipt contract.
export async function runtimeBuild(directory: string, env: NodeJS.ProcessEnv, record: boolean) {
  assert.equal(env.IMAGE, "runtime");
  const qualified = await lstat(join(directory, "platform.json")).catch((error: unknown) => {
    if (field(error, "code") !== "ENOENT") {
      throw error;
    }
    return null;
  });
  assert.equal(qualified, null, "An untested runtime artifact must not contain platform.json.");
  if (record) {
    assert.match(env.IMAGE_DIGEST ?? "", digestPattern, "Expected the native build output digest.");
    await writeFile(
      join(directory, "build.json"),
      `${JSON.stringify(
        {
          ...identity(env, env.IMAGE),
          platform: env.PLATFORM,
          digest: env.IMAGE_DIGEST,
          native: false,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  }
  const { rootDigest } = await verifyPlatform(
    directory,
    env,
    env.PLATFORM,
    record ? env.IMAGE_DIGEST : undefined,
    "build.json",
  );
  return rootDigest;
}
