import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip, createZstdDecompress } from "node:zlib";
import { openclawBuildArguments, readOpenclawSource } from "../lib/openclaw-source.mjs";

type RuntimeIdentity = {
  sourceSha: string;
  runId: string;
  producerAttempt: string;
};

type RuntimeSelection = RuntimeIdentity & {
  directory: string;
  archiveSha256: string;
};

type Descriptor = {
  digest: string;
  size: number;
  mediaType: string;
  platform?: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function descriptor(value: unknown): Descriptor {
  const entry = record(value);
  assert.ok(typeof entry.digest === "string");
  assert.ok(typeof entry.size === "number");
  assert.ok(typeof entry.mediaType === "string");
  return {
    digest: entry.digest,
    size: entry.size,
    mediaType: entry.mediaType,
    ...(entry.platform ? { platform: record(entry.platform) } : {}),
  };
}

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;
const indexType = "application/vnd.oci.image.index.v1+json";
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const metadataLimit = 16 * 1024 * 1024;
const architecture = process.arch === "x64" ? "amd64" : process.arch;
const docker = () => process.env.OCC_DOCKER_BIN ?? "docker";

export function runtimeArtifactSelection(env: NodeJS.ProcessEnv) {
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
    typeof selection.directory === "string" &&
      selection.directory.length > 0 &&
      typeof selection.archiveSha256 === "string" &&
      selection.archiveSha256.length > 0 &&
      typeof selection.sourceSha === "string" &&
      selection.sourceSha.length > 0 &&
      typeof selection.runId === "string" &&
      selection.runId.length > 0 &&
      typeof selection.producerAttempt === "string" &&
      selection.producerAttempt.length > 0,
    "Runtime artifact selection is incomplete.",
  );
  assert.match(selection.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(selection.sourceSha, shaPattern);
  assert.match(selection.runId, integerPattern);
  assert.match(selection.producerAttempt, integerPattern);
  return {
    directory: selection.directory,
    archiveSha256: selection.archiveSha256,
    sourceSha: selection.sourceSha,
    runId: selection.runId,
    producerAttempt: selection.producerAttempt,
  };
}

function importTimeout(deadlineMs: number | undefined, maximumMs: number) {
  if (deadlineMs === undefined) {
    return maximumMs;
  }
  const remainingMs = Math.floor(deadlineMs - Date.now());
  if (remainingMs <= 0) {
    throw new Error("Runtime artifact import reached its preparation deadline.");
  }
  return Math.min(remainingMs, maximumMs);
}

function importProbeOptions(deadlineMs: number | undefined, maximumMs: number) {
  return {
    timeout: importTimeout(deadlineMs, maximumMs),
    ...(deadlineMs === undefined ? {} : { killSignal: "SIGKILL" as const }),
  };
}

function verifyContext(
  identity: {
    sourceSha: string | undefined;
    runId: string | undefined;
    producerAttempt: string | undefined;
  },
  deadlineMs?: number,
): asserts identity is RuntimeIdentity {
  const { sourceSha, runId, producerAttempt } = identity;
  assert.ok(typeof sourceSha === "string");
  assert.ok(typeof runId === "string");
  assert.ok(typeof producerAttempt === "string");
  assert.match(sourceSha, shaPattern);
  assert.match(runId, integerPattern);
  assert.match(producerAttempt, integerPattern);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      ...importProbeOptions(deadlineMs, 30_000),
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

async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path, { signal }) as AsyncIterable<unknown>) {
    assert.ok(Buffer.isBuffer(bytes));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Read only the OCI layout's small fixed vocabulary. In particular, no archive
// link or extension header can change the path interpreted by an extractor.
async function extractLayout(archive: string, destination: string, signal?: AbortSignal) {
  const file = await open(archive, "r");
  const members = new Set();
  const entries = [];
  const size = (await file.stat()).size;
  let offset = 0;
  try {
    while (offset + 512 <= size) {
      signal?.throwIfAborted();
      const header = Buffer.alloc(512);
      assert.equal((await file.read(header, 0, 512, offset)).bytesRead, 512);
      if (header.every((byte) => byte === 0)) {
        for await (const padding of createReadStream(archive, {
          start: offset,
          signal,
        }) as AsyncIterable<unknown>) {
          assert.ok(Buffer.isBuffer(padding));
          assert.ok(
            padding.every((byte) => byte === 0),
            "Unexpected data after OCI archive terminator.",
          );
        }
        break;
      }
      const string = (start: number, end: number) =>
        header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
      const octal = (start: number, end: number) => {
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
    signal?.throwIfAborted();
    const path = join(destination, entry.name);
    await mkdir(dirname(path), { recursive: true });
    if (entry.length === 0) {
      await writeFile(path, "", { flag: "wx", signal });
    } else {
      await pipeline(
        createReadStream(archive, { start: entry.start, end: entry.start + entry.length - 1 }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    }
  }
}

async function readMetadata(path: string, signal?: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile(), "OCI metadata must be a regular file.");
    assert.ok(stat.size <= metadataLimit, "Oversized OCI metadata.");
    const chunks = [];
    let size = 0;
    // Read at most one extra byte to detect growth after the descriptor's stat.
    for await (const chunk of file.createReadStream({
      autoClose: false,
      start: 0,
      end: metadataLimit,
      signal,
    }) as AsyncIterable<unknown>) {
      assert.ok(Buffer.isBuffer(chunk));
      size += chunk.length;
      assert.ok(size <= metadataLimit, "Oversized OCI metadata.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

// A named context may trust the config's diff IDs without hashing uncompressed
// content. Check them before making a layout available without Docker import.
async function verifyLayerDiffId(
  directory: string,
  layer: Descriptor,
  expected: string,
  signal?: AbortSignal,
) {
  const decoder = layer.mediaType.endsWith("+gzip")
    ? createGunzip()
    : layer.mediaType.endsWith("+zstd")
      ? createZstdDecompress()
      : undefined;
  if (!decoder) {
    assert.equal(layer.digest, expected, "OCI layer diff ID mismatch.");
    return;
  }
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(join(directory, "blobs/sha256", layer.digest.slice(7)), { signal }),
    decoder,
    async (chunks: AsyncIterable<unknown>) => {
      for await (const chunk of chunks) {
        assert.ok(Buffer.isBuffer(chunk));
        hash.update(chunk);
      }
    },
    { signal },
  );
  assert.equal(`sha256:${hash.digest("hex")}`, expected, "OCI layer diff ID mismatch.");
}

async function inspectLayout(
  directory: string,
  sourceSha: string,
  signal?: AbortSignal,
  verifyDiffIds = false,
) {
  const verified = new Set();
  async function blob(descriptor: Descriptor, parse = true) {
    assert.match(descriptor.digest ?? "", digestPattern);
    assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0);
    const path = join(directory, "blobs/sha256", descriptor.digest.slice(7));
    if (parse) {
      const bytes = await readMetadata(path, signal);
      assert.equal(bytes.length, descriptor.size, "OCI descriptor size mismatch.");
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        descriptor.digest,
        "OCI descriptor digest mismatch.",
      );
      return record(JSON.parse(bytes.toString("utf8")));
    }
    assert.equal((await lstat(path)).size, descriptor.size, "OCI descriptor size mismatch.");
    if (!verified.has(descriptor.digest)) {
      assert.equal(
        `sha256:${await hashFile(path, signal)}`,
        descriptor.digest,
        "OCI descriptor digest mismatch.",
      );
      verified.add(descriptor.digest);
    }
  }
  const layout = await readMetadata(join(directory, "oci-layout"), signal);
  assert.equal(record(JSON.parse(layout.toString("utf8"))).imageLayoutVersion, "1.0.0");
  const rootBytes = await readMetadata(join(directory, "index.json"), signal);
  const root = record(JSON.parse(rootBytes.toString("utf8")));
  assert.ok(Array.isArray(root.manifests));
  assert.equal(root.schemaVersion, 2);
  assert.equal(root.manifests.length, 1, "Expected one runtime platform.");
  let selected = descriptor(root.manifests[0]);
  const indexDigest =
    selected.mediaType === indexType
      ? selected.digest
      : `sha256:${createHash("sha256").update(rootBytes).digest("hex")}`;
  if (selected.mediaType === indexType) {
    const index = await blob(selected);
    assert.ok(index);
    assert.ok(Array.isArray(index.manifests));
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.manifests.length, 1, "Expected one runtime platform.");
    selected = descriptor(index.manifests[0]);
  }
  assert.equal(selected.mediaType, manifestType);
  if (selected.platform) {
    assert.equal(selected.platform.os, "linux");
    assert.equal(selected.platform.architecture, architecture);
    assert.ok(
      selected.platform.variant === undefined ||
        (architecture === "arm64" && selected.platform.variant === "v8"),
    );
  }
  const manifest = await blob(selected);
  assert.ok(manifest);
  const configDescriptor = descriptor(manifest.config);
  assert.ok(Array.isArray(manifest.layers));
  const layers: unknown[] = manifest.layers;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, manifestType);
  assert.equal(configDescriptor.mediaType, "application/vnd.oci.image.config.v1+json");
  const config = await blob(configDescriptor);
  assert.ok(config);
  const executableConfig = record(config.config);
  const labels = executableConfig.Labels == null ? undefined : record(executableConfig.Labels);
  const rootfs = record(config.rootfs);
  assert.ok(Array.isArray(rootfs.diff_ids));
  const diffIds: unknown[] = rootfs.diff_ids;
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, architecture);
  assert.equal(labels?.["org.opencontainers.image.revision"], sourceSha);
  assert.equal(rootfs.type, "layers");
  assert.equal(diffIds.length, layers.length);
  for (const digest of diffIds) {
    assert.ok(typeof digest === "string");
    assert.match(digest, digestPattern);
  }
  for (const [index, value] of layers.entries()) {
    const layer = descriptor(value);
    assert.ok(
      [
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
      ].includes(layer.mediaType),
    );
    await blob(layer, false);
    if (verifyDiffIds) {
      const expected: unknown = diffIds[index];
      assert.ok(typeof expected === "string");
      await verifyLayerDiffId(directory, layer, expected, signal);
    }
  }
  return {
    indexDigest,
    platformManifestDigest: selected.digest,
    configDigest: configDescriptor.digest,
    config: { config: executableConfig, rootfs: { diff_ids: diffIds } },
  };
}

function command(program: string, args: string[], timeoutMs = 20 * 60_000) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: repositoryRoot, stdio: "inherit", detached: true });
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
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
    const finish = (error?: Error) => {
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

export function assertRuntimeArtifactTagAvailable(tag: string, deadlineMs?: number) {
  assert.ok(
    typeof tag === "string" && tag.startsWith("localhost/"),
    "A caller-owned local image tag is required.",
  );
  try {
    execFileSync(docker(), ["image", "inspect", tag], {
      encoding: "utf8",
      ...importProbeOptions(deadlineMs, 120_000),
      stdio: "pipe",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      error.status === 1 &&
      "stderr" in error &&
      /No such (?:image|object):/.test(String(error.stderr))
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Runtime artifact tag already exists: ${tag}`);
}

function imageConfiguration(config: Record<string, unknown>) {
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

async function readVerifiedRuntimeLayout(
  selection: RuntimeSelection,
  deadlineMs?: number,
  verifyDiffIds = false,
) {
  const { directory, archiveSha256 } = selection;
  const signal =
    deadlineMs === undefined
      ? undefined
      : AbortSignal.timeout(importTimeout(deadlineMs, 2 ** 31 - 1));
  const receipt = record(
    JSON.parse(await readFile(join(directory, "receipt.json"), { encoding: "utf8", signal })),
  );
  for (const key of ["sourceSha", "runId", "producerAttempt", "archiveSha256"] as const) {
    assert.equal(receipt[key], selection[key], `Runtime receipt ${key} mismatch.`);
  }
  assert.equal(receipt.version, 1);
  assert.equal(receipt.platform, `linux/${architecture}`);
  const archive = join(directory, "runtime.tar");
  assert.equal(
    await hashFile(archive, signal),
    archiveSha256,
    "Runtime archive checksum mismatch.",
  );
  const layoutDirectory = await mkdtemp(join(tmpdir(), "oce-runtime-layout-"));
  const cleanup = () => rm(layoutDirectory, { recursive: true, force: true });
  try {
    await extractLayout(archive, layoutDirectory, signal);
    const verified = await inspectLayout(
      layoutDirectory,
      selection.sourceSha,
      signal,
      verifyDiffIds,
    );
    for (const key of ["indexDigest", "platformManifestDigest", "configDigest"] as const) {
      assert.equal(receipt[key], verified[key], `Runtime receipt ${key} mismatch.`);
    }
    return { layoutDirectory, verified, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function prepareRuntimeArtifactLayout(
  selection: RuntimeSelection,
  deadlineMs?: number,
) {
  verifyContext(selection, deadlineMs);
  assert.match(selection.archiveSha256, /^[a-f0-9]{64}$/);
  const { layoutDirectory, verified, cleanup } = await readVerifiedRuntimeLayout(
    selection,
    deadlineMs,
    true,
  );
  return { layoutDirectory, platformManifestDigest: verified.platformManifestDigest, cleanup };
}

export async function loadRuntimeArtifact(
  selection: RuntimeSelection & { tag: string },
  deadlineMs?: number,
) {
  const { tag } = selection;
  verifyContext(selection, deadlineMs);
  assert.match(selection.archiveSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    typeof tag === "string" && tag.startsWith("localhost/"),
    "A caller-owned local image tag is required.",
  );
  const { layoutDirectory, verified, cleanup } = await readVerifiedRuntimeLayout(
    selection,
    deadlineMs,
  );
  try {
    // Docker's supported API floor can be newer than Skopeo's daemon client.
    // Keep conversion local and let the installed Docker CLI negotiate loading.
    const importDirectory = join(layoutDirectory, "import");
    await mkdir(importDirectory);
    const dockerArchive = join(importDirectory, "docker.tar");
    await command(
      "skopeo",
      ["copy", `oci:${layoutDirectory}`, `docker-archive:${dockerArchive}:${tag}`],
      importTimeout(deadlineMs, 20 * 60_000),
    );
    const raw = record(
      JSON.parse(
        execFileSync("skopeo", ["inspect", "--raw", `docker-archive:${dockerArchive}`], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          ...importProbeOptions(deadlineMs, 120_000),
        }),
      ),
    );
    assert.equal(record(raw.config).digest, verified.configDigest);
    assertRuntimeArtifactTagAvailable(tag, deadlineMs);
    await command(
      docker(),
      ["image", "load", "--input", dockerArchive],
      importTimeout(deadlineMs, 20 * 60_000),
    );
    await rm(importDirectory, { recursive: true });
    const inspected: unknown = JSON.parse(
      execFileSync(docker(), ["image", "inspect", tag], {
        encoding: "utf8",
        ...importProbeOptions(deadlineMs, 120_000),
      }),
    );
    assert.ok(Array.isArray(inspected));
    const loaded = record(inspected[0]);
    assert.ok(typeof loaded.Id === "string");
    assert.match(loaded.Id, digestPattern);
    assert.equal(loaded.Os, "linux");
    assert.equal(loaded.Architecture, architecture);
    assert.deepEqual(record(loaded.RootFS).Layers ?? [], verified.config.rootfs.diff_ids);
    assert.deepEqual(
      imageConfiguration(record(loaded.Config)),
      imageConfiguration(verified.config.config),
      "Loaded runtime executable configuration differs from its verified OCI config.",
    );
    if (loaded.Descriptor) {
      assert.equal(record(loaded.Descriptor).digest, loaded.Id);
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

async function build(directory: string) {
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
  let verified: Awaited<ReturnType<typeof inspectLayout>>;
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
  assert.ok(typeof process.env.GITHUB_OUTPUT === "string");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `source-sha=${receipt.sourceSha}\nrun-id=${receipt.runId}\nproducer-attempt=${receipt.producerAttempt}\narchive-sha256=${receipt.archiveSha256}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, flag, directory, ...extra] = process.argv.slice(2);
  assert.ok(
    operation === "build" && flag === "--output" && directory && extra.length === 0,
    "Usage: runtime-artifact.ts build --output DIR",
  );
  await build(resolve(directory));
}
