import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openclawBuildArguments, readOpenclawSource } from "../lib/openclaw-source.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;
const indexType = "application/vnd.oci.image.index.v1+json";
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const architecture = process.arch === "x64" ? "amd64" : process.arch;
const docker = () => process.env.OCC_DOCKER_BIN ?? "docker";

export function runtimeArtifactSelection(env) {
  const selection = {
    directory: env.OCC_CI_RUNTIME_ARTIFACT_DIRECTORY,
    archiveSha256: env.OCC_CI_RUNTIME_ARTIFACT_SHA256,
    sourceSha: env.OCC_CI_RUNTIME_ARTIFACT_SOURCE_SHA,
    runId: env.OCC_CI_RUNTIME_ARTIFACT_RUN_ID,
    producerAttempt: env.OCC_CI_RUNTIME_ARTIFACT_ATTEMPT,
  };
  if (Object.values(selection).every((value) => !value)) {
    return undefined;
  }
  assert.ok(
    Object.values(selection).every((value) => typeof value === "string" && value.length > 0),
    "Runtime artifact selection is incomplete.",
  );
  assert.match(selection.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(selection.sourceSha, shaPattern);
  assert.match(selection.runId, integerPattern);
  assert.match(selection.producerAttempt, integerPattern);
  return selection;
}

function verifyContext({ sourceSha, runId, producerAttempt }) {
  assert.match(sourceSha, shaPattern);
  assert.match(runId, integerPattern);
  assert.match(producerAttempt, integerPattern);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim(),
    sourceSha,
    "Runtime artifact source differs from checkout.",
  );
  assert.equal(
    process.env.GITHUB_SHA,
    sourceSha,
    "Runtime artifact source differs from workflow source.",
  );
  assert.equal(
    process.env.GITHUB_RUN_ID,
    runId,
    "Runtime artifact must come from this workflow run.",
  );
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Read only the OCI layout's small fixed vocabulary. In particular, no archive
// link or extension header can change the path interpreted by an extractor.
async function extractLayout(archive, destination) {
  const file = await open(archive, "r");
  const members = new Set();
  const entries = [];
  const size = (await file.stat()).size;
  let offset = 0;
  try {
    while (offset + 512 <= size) {
      const header = Buffer.alloc(512);
      assert.equal((await file.read(header, 0, 512, offset)).bytesRead, 512);
      if (header.every((byte) => byte === 0)) {
        for await (const padding of createReadStream(archive, { start: offset })) {
          assert.ok(
            padding.every((byte) => byte === 0),
            "Unexpected data after OCI archive terminator.",
          );
        }
        break;
      }
      const string = (start, end) =>
        header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
      const octal = (start, end) => {
        const value = string(start, end).trim();
        assert.match(value, /^[0-7]+$/);
        const result = Number.parseInt(value, 8);
        assert.ok(Number.isSafeInteger(result));
        return result;
      };
      const checksum = octal(148, 156);
      const checked = Buffer.from(header);
      checked.fill(32, 148, 156);
      assert.equal(
        checked.reduce((sum, byte) => sum + byte, 0),
        checksum,
        "Invalid tar checksum.",
      );
      const name = `${string(345, 500) ? `${string(345, 500)}/` : ""}${string(0, 100)}`
        .replace(/^\.\//, "")
        .replace(/\/$/, "");
      const type = string(156, 157);
      const length = octal(124, 136);
      assert.ok(
        type === "0" || type === "" || type === "5",
        "OCI archive links and extension entries are not supported.",
      );
      assert.ok(
        type === "5"
          ? /^(blobs|blobs\/sha256)$/.test(name)
          : /^(index\.json|oci-layout|blobs\/sha256\/[a-f0-9]{64})$/.test(name),
        "Unsafe or unexpected OCI archive path.",
      );
      assert.ok(!members.has(name), `Duplicate OCI archive member: ${name}`);
      members.add(name);
      assert.ok(offset + 512 + length <= size, "Truncated OCI archive.");
      if (type === "5") {
        assert.equal(length, 0);
      } else {
        entries.push({ name, length, start: offset + 512 });
      }
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    assert.ok(members.has("index.json") && members.has("oci-layout"), "Missing OCI layout files.");
  } finally {
    await file.close();
  }
  // Validate the complete archive directory before writing any member.
  for (const entry of entries) {
    const path = join(destination, entry.name);
    await mkdir(dirname(path), { recursive: true });
    if (entry.length === 0) {
      await writeFile(path, "", { flag: "wx" });
    } else {
      await pipeline(
        createReadStream(archive, { start: entry.start, end: entry.start + entry.length - 1 }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
    }
  }
}

async function inspectLayout(directory, sourceSha) {
  async function json(path) {
    assert.ok((await lstat(path)).size <= 16 * 1024 * 1024, "Oversized OCI metadata.");
    return JSON.parse(await readFile(path, "utf8"));
  }
  const verified = new Set();
  async function blob(descriptor, parse = true) {
    assert.match(descriptor.digest ?? "", digestPattern);
    assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0);
    const path = join(directory, "blobs/sha256", descriptor.digest.slice(7));
    assert.equal((await lstat(path)).size, descriptor.size, "OCI descriptor size mismatch.");
    if (!verified.has(descriptor.digest)) {
      assert.equal(
        `sha256:${await hashFile(path)}`,
        descriptor.digest,
        "OCI descriptor digest mismatch.",
      );
      verified.add(descriptor.digest);
    }
    return parse ? json(path) : undefined;
  }
  assert.equal((await json(join(directory, "oci-layout"))).imageLayoutVersion, "1.0.0");
  const rootPath = join(directory, "index.json");
  const root = await json(rootPath);
  assert.equal(root.schemaVersion, 2);
  assert.equal(root.manifests.length, 1, "Expected one runtime platform.");
  let descriptor = root.manifests[0];
  const indexDigest =
    descriptor.mediaType === indexType ? descriptor.digest : `sha256:${await hashFile(rootPath)}`;
  if (descriptor.mediaType === indexType) {
    const index = await blob(descriptor);
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.manifests.length, 1, "Expected one runtime platform.");
    descriptor = index.manifests[0];
  }
  assert.equal(descriptor.mediaType, manifestType);
  if (descriptor.platform) {
    assert.equal(descriptor.platform.os, "linux");
    assert.equal(descriptor.platform.architecture, architecture);
    assert.ok(
      descriptor.platform.variant === undefined ||
        (architecture === "arm64" && descriptor.platform.variant === "v8"),
    );
  }
  const manifest = await blob(descriptor);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, manifestType);
  assert.equal(manifest.config.mediaType, "application/vnd.oci.image.config.v1+json");
  const config = await blob(manifest.config);
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, architecture);
  assert.equal(config.config?.Labels?.["org.opencontainers.image.revision"], sourceSha);
  assert.equal(config.rootfs.type, "layers");
  assert.equal(config.rootfs.diff_ids.length, manifest.layers.length);
  for (const digest of config.rootfs.diff_ids) {
    assert.match(digest, digestPattern);
  }
  for (const layer of manifest.layers) {
    assert.ok(
      [
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
      ].includes(layer.mediaType),
    );
    await blob(layer, false);
  }
  return {
    indexDigest,
    platformManifestDigest: descriptor.digest,
    configDigest: manifest.config.digest,
    config,
  };
}

function command(program, args, timeoutMs = 20 * 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: repositoryRoot, stdio: "inherit", detached: true });
    let stopped = false;
    let killTimer;
    const kill = (signal) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") {
            throw error;
          }
        }
      }
    };
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      kill("SIGTERM");
      // Keep this timer even when the group leader exits first: descendants
      // must not retain an abandoned build after cancellation.
      killTimer = setTimeout(() => kill("SIGKILL"), 10_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const finish = (error) => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      if (!stopped) {
        clearTimeout(killTimer);
      }
      if (error) {
        reject(error);
      } else {
        resolvePromise();
      }
    };
    child.once("error", finish);
    child.once("close", (code) =>
      finish(
        code === 0 && !stopped
          ? undefined
          : new Error(
              `${program} failed${stopped ? " after cancellation or its deadline" : ` with exit ${code}`}.`,
            ),
      ),
    );
  });
}

export function assertRuntimeArtifactTagAvailable(tag) {
  assert.ok(
    typeof tag === "string" && tag.startsWith("localhost/"),
    "A caller-owned local image tag is required.",
  );
  try {
    execFileSync(docker(), ["image", "inspect", tag], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    });
  } catch (error) {
    if (error.status === 1 && /No such (?:image|object):/.test(String(error.stderr))) {
      return;
    }
    throw error;
  }
  throw new Error(`Runtime artifact tag already exists: ${tag}`);
}

function imageConfiguration(config) {
  // Docker's legacy and OCI serializers differ in whether they emit unset
  // configuration values. Keep every nonempty field, including executable
  // defaults, rather than comparing only labels or a hand-picked subset.
  return Object.fromEntries(
    Object.entries(config).filter(
      ([, value]) =>
        value !== null &&
        value !== "" &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === "object" && Object.keys(value).length === 0),
    ),
  );
}

export async function loadRuntimeArtifact(selection) {
  const { directory, archiveSha256, tag } = selection;
  verifyContext(selection);
  assert.match(archiveSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    typeof tag === "string" && tag.startsWith("localhost/"),
    "A caller-owned local image tag is required.",
  );
  const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
  for (const key of ["sourceSha", "runId", "producerAttempt", "archiveSha256"]) {
    assert.equal(receipt[key], selection[key], `Runtime receipt ${key} mismatch.`);
  }
  assert.equal(receipt.version, 1);
  assert.equal(receipt.platform, `linux/${architecture}`);
  const archive = join(directory, "runtime.tar");
  assert.equal(await hashFile(archive), archiveSha256, "Runtime archive checksum mismatch.");
  const layoutDirectory = await mkdtemp(join(tmpdir(), "oce-runtime-layout-"));
  const cleanup = () => rm(layoutDirectory, { recursive: true, force: true });
  try {
    await extractLayout(archive, layoutDirectory);
    const verified = await inspectLayout(layoutDirectory, selection.sourceSha);
    for (const key of ["indexDigest", "platformManifestDigest", "configDigest"]) {
      assert.equal(receipt[key], verified[key], `Runtime receipt ${key} mismatch.`);
    }
    // Docker's supported API floor can be newer than Skopeo's daemon client.
    // Keep conversion local and let the installed Docker CLI negotiate loading.
    const importDirectory = join(layoutDirectory, "import");
    await mkdir(importDirectory);
    const dockerArchive = join(importDirectory, "docker.tar");
    await command("skopeo", [
      "copy",
      `oci:${layoutDirectory}`,
      `docker-archive:${dockerArchive}:${tag}`,
    ]);
    const raw = JSON.parse(
      execFileSync("skopeo", ["inspect", "--raw", `docker-archive:${dockerArchive}`], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      }),
    );
    assert.equal(raw.config.digest, verified.configDigest);
    assertRuntimeArtifactTagAvailable(tag);
    await command(docker(), ["image", "load", "--input", dockerArchive]);
    await rm(importDirectory, { recursive: true });
    const [loaded] = JSON.parse(
      execFileSync(docker(), ["image", "inspect", tag], { encoding: "utf8", timeout: 120_000 }),
    );
    assert.match(loaded.Id, digestPattern);
    assert.equal(loaded.Os, "linux");
    assert.equal(loaded.Architecture, architecture);
    assert.deepEqual(loaded.RootFS.Layers ?? [], verified.config.rootfs.diff_ids);
    assert.deepEqual(
      imageConfiguration(loaded.Config),
      imageConfiguration(verified.config.config),
      "Loaded runtime executable configuration differs from its verified OCI config.",
    );
    if (loaded.Descriptor) {
      assert.equal(loaded.Descriptor.digest, loaded.Id);
    } else {
      assert.equal(loaded.Id, verified.configDigest);
    }
    return {
      reference: loaded.Id,
      configDigest: verified.configDigest,
      platformManifestDigest: verified.platformManifestDigest,
      indexDigest: verified.indexDigest,
      layoutDirectory,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function build(directory) {
  const identity = {
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    producerAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  verifyContext(identity);
  assert.ok(["amd64", "arm64"].includes(architecture));
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "runtime.tar");
  const started = performance.now();
  await command(
    docker(),
    [
      "buildx",
      "build",
      "--platform",
      `linux/${architecture}`,
      "--progress=plain",
      "--provenance=false",
      "--sbom=false",
      "--build-arg",
      "SOURCE_DATE_EPOCH=0",
      "--build-arg",
      `OCC_BUILD_REVISION=${identity.sourceSha}`,
      "--label",
      `org.opencontainers.image.revision=${identity.sourceSha}`,
      ...openclawBuildArguments(await readOpenclawSource()),
      ...(process.env.OCC_CI_IMAGE_CACHE === "1"
        ? [
            "--cache-from",
            `type=gha,version=2,scope=oce-ci-runtime-${process.platform}-${process.arch}-v1,timeout=60s`,
          ]
        : []),
      "--output",
      `type=oci,dest=${archive}`,
      "--file",
      "deploy/runtime/Dockerfile",
      ".",
    ],
    180 * 60_000,
  );
  const layout = await mkdtemp(join(tmpdir(), "oce-runtime-producer-"));
  let verified;
  try {
    await extractLayout(archive, layout);
    verified = await inspectLayout(layout, identity.sourceSha);
  } finally {
    await rm(layout, { recursive: true, force: true });
  }
  const receipt = {
    version: 1,
    ...identity,
    platform: `linux/${architecture}`,
    indexDigest: verified.indexDigest,
    platformManifestDigest: verified.platformManifestDigest,
    configDigest: verified.configDigest,
    archiveSha256: await hashFile(archive),
    buildAndVerifyMs: Math.round(performance.now() - started),
  };
  await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `source-sha=${receipt.sourceSha}\nrun-id=${receipt.runId}\nproducer-attempt=${receipt.producerAttempt}\narchive-sha256=${receipt.archiveSha256}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, flag, directory, ...extra] = process.argv.slice(2);
  assert.ok(
    operation === "build" && flag === "--output" && directory && extra.length === 0,
    "Usage: runtime-artifact.mjs build --output DIR",
  );
  await build(resolve(directory));
}
