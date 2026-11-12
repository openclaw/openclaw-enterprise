import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadRuntimeArtifact,
  prepareRuntimeArtifactLayout,
} from "../../scripts/ci/runtime-artifact.ts";
import { prepareLane } from "../../scripts/ci/prepare.mjs";
import { cleanupResourceIds } from "../../scripts/ci/cleanup.mjs";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function firstRecord(value: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(value));
  return record(value[0]);
}

function resourceIds(value: unknown): string[] {
  const state = record(value);
  assert.ok(Array.isArray(state.resources));
  return state.resources.map((resource: unknown) => {
    const { id } = record(resource);
    assert.ok(typeof id === "string");
    return id;
  });
}

function artifactDescriptor(value: unknown): { digest: string; mediaType: string } {
  const entry = record(value);
  assert.ok(typeof entry.digest === "string");
  assert.ok(typeof entry.mediaType === "string");
  return { digest: entry.digest, mediaType: entry.mediaType };
}

const hash = (bytes: NodeJS.ArrayBufferView) => createHash("sha256").update(bytes).digest("hex");
const run = (program: string, args: string[]) =>
  execFileSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });

test("same-run runtime artifact enforces the OCI metadata limit before conversion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-metadata-"));
  const previousSha = process.env.GITHUB_SHA;
  const previousRun = process.env.GITHUB_RUN_ID;
  t.after(async () => {
    for (const [key, value] of [
      ["GITHUB_SHA", previousSha],
      ["GITHUB_RUN_ID", previousRun],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  const sourceSha = run("git", ["rev-parse", "HEAD"]).trim();
  const runId = "123456";
  const producerAttempt = "1";
  Object.assign(process.env, { GITHUB_SHA: sourceSha, GITHUB_RUN_ID: runId });
  const layout = join(directory, "layout");
  const archive = join(directory, "runtime.tar");
  await mkdir(layout);
  await writeFile(join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');

  const index = '{"schemaVersion":2,"manifests":[]}';
  const limit = 16 * 1024 * 1024;
  for (const [size, expected] of [
    [limit, /Expected one runtime platform/],
    [limit + 1, /Oversized OCI metadata/],
  ] as const) {
    await writeFile(join(layout, "index.json"), index.padEnd(size, " "));
    run("tar", ["-cf", archive, "-C", layout, "index.json", "oci-layout"]);
    const archiveSha256 = hash(await readFile(archive));
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        version: 1,
        sourceSha,
        runId,
        producerAttempt,
        archiveSha256,
        platform: `linux/${process.arch === "x64" ? "amd64" : process.arch}`,
      }),
    );
    await assert.rejects(
      loadRuntimeArtifact({
        directory,
        archiveSha256,
        sourceSha,
        runId,
        producerAttempt,
        tag: "localhost/oce-runtime-metadata:proof",
      }),
      expected,
    );
  }
});

test(
  "same-run runtime artifact prepares an owned image and supplies a real OCI build context",
  { skip: process.env.OCC_TEST_RUNTIME_ARTIFACT !== "1", timeout: 180_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-runtime-transport-"));
    const tag = `localhost/oce-runtime-transport:${randomUUID()}`;
    const derivedTag = `${tag}-derived`;
    const bakeTag = `${tag}-bake`;
    const builder = `oce-runtime-transport-${randomUUID()}`;
    let builderCreated = false;
    const statePath = join(directory, "state.json");
    const savedEnv = { ...process.env };
    const artifacts: {
      loaded?: Awaited<ReturnType<typeof loadRuntimeArtifact>>;
      namedContext?: Awaited<ReturnType<typeof prepareRuntimeArtifactLayout>>;
    } = {};
    t.after(async () => {
      await artifacts.loaded?.cleanup();
      await artifacts.namedContext?.cleanup();
      if (builderCreated) {
        run("docker", ["buildx", "rm", builder]);
      }
      try {
        await cleanupResourceIds(
          statePath,
          resourceIds(JSON.parse(await readFile(statePath, "utf8"))),
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      } finally {
        for (const image of [tag, derivedTag, bakeTag]) {
          try {
            run("docker", ["image", "rm", image]);
          } catch {
            /* A rejected load creates no tag. */
          }
        }
        for (const key of Object.keys(process.env)) {
          if (!(key in savedEnv)) {
            delete process.env[key];
          }
        }
        Object.assign(process.env, savedEnv);
        await rm(directory, { recursive: true, force: true });
      }
    });
    run("skopeo", ["--version"]);
    const sourceSha = run("git", ["rev-parse", "HEAD"]).trim();
    Object.assign(process.env, {
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "2",
    });
    const context = join(directory, "context");
    const artifact = join(directory, "artifact");
    const layout = join(directory, "layout");
    await Promise.all([mkdir(context), mkdir(artifact), mkdir(layout)]);
    await writeFile(join(context, "payload"), "runtime transport proof\n");
    await writeFile(
      join(context, "Dockerfile"),
      `FROM scratch\nCOPY payload /payload\nLABEL org.opencontainers.image.revision=${sourceSha}\nENV TRANSPORT_PROOF=kept\nUSER 1234:5678\nWORKDIR /workspace\nENTRYPOINT ["/does-not-run"]\nCMD ["proof"]\nSTOPSIGNAL SIGUSR1\nEXPOSE 12345\n`,
    );
    // No runtime compilation or registry image: BuildKit exports a real one-file
    // image, then the regular lane preparation consumes the transported bytes.
    run("docker", [
      "buildx",
      "build",
      "--provenance=false",
      "--sbom=false",
      "--output",
      `type=oci,dest=${artifact}/runtime.tar`,
      context,
    ]);
    run("tar", ["-xf", join(artifact, "runtime.tar"), "-C", layout]);
    const rootBytes = await readFile(join(layout, "index.json"));
    let descriptor = artifactDescriptor(
      firstRecord(record(JSON.parse(rootBytes.toString("utf8"))).manifests),
    );
    const indexDigest = descriptor.mediaType.endsWith("image.index.v1+json")
      ? descriptor.digest
      : `sha256:${hash(rootBytes)}`;
    const blob = async (entry: { digest: string }) =>
      record(
        JSON.parse(await readFile(join(layout, "blobs/sha256", entry.digest.slice(7)), "utf8")),
      );
    if (descriptor.mediaType.endsWith("image.index.v1+json")) {
      descriptor = artifactDescriptor(firstRecord((await blob(descriptor)).manifests));
    }
    const manifest = await blob(descriptor);
    const manifestConfig = artifactDescriptor(manifest.config);
    const selection = {
      directory: artifact,
      archiveSha256: hash(await readFile(join(artifact, "runtime.tar"))),
      sourceSha,
      runId: "123456",
      producerAttempt: "1",
    };
    const { directory: _directory, ...receiptSelection } = selection;
    const receipt = {
      version: 1,
      ...receiptSelection,
      platform: `linux/${process.arch === "x64" ? "amd64" : process.arch}`,
      indexDigest,
      platformManifestDigest: descriptor.digest,
      configDigest: manifestConfig.digest,
    };
    await writeFile(join(artifact, "receipt.json"), JSON.stringify(receipt));
    await assert.rejects(
      loadRuntimeArtifact({ ...selection, tag }, Date.now() - 1),
      /preparation deadline/,
    );
    assert.throws(() => run("docker", ["image", "inspect", tag]), { status: 1 });
    const probeBin = join(directory, "probe-bin");
    await mkdir(probeBin);
    await writeFile(
      join(probeBin, "git"),
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setTimeout(() => process.stdout.write(${JSON.stringify(`${sourceSha}\n`)}), 2100);
`,
      { mode: 0o700 },
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${probeBin}:${previousPath}`;
      await assert.rejects(loadRuntimeArtifact({ ...selection, tag }, Date.now() + 750), {
        code: "ETIMEDOUT",
        signal: "SIGKILL",
      });
    } finally {
      process.env.PATH = previousPath;
    }
    assert.throws(() => run("docker", ["image", "inspect", tag]), { status: 1 });
    const loaded = await loadRuntimeArtifact({ ...selection, tag }, Date.now() + 60_000);
    artifacts.loaded = loaded;
    assert.equal(loaded.configDigest, manifestConfig.digest);
    assert.equal(
      record(
        record(
          firstRecord(JSON.parse(run("docker", ["image", "inspect", loaded.reference]))).Config,
        ).Labels,
      )["org.opencontainers.image.revision"],
      sourceSha,
    );
    const imported = record(
      firstRecord(JSON.parse(run("docker", ["image", "inspect", loaded.reference]))).Config,
    );
    assert.ok(Array.isArray(imported.Env) && imported.Env.includes("TRANSPORT_PROOF=kept"));
    assert.deepEqual(imported.Entrypoint, ["/does-not-run"]);
    assert.deepEqual(imported.Cmd, ["proof"]);
    assert.equal(imported.User, "1234:5678");
    assert.equal(imported.WorkingDir, "/workspace");
    assert.equal(imported.StopSignal, "SIGUSR1");
    assert.deepEqual(imported.ExposedPorts, { "12345/tcp": {} });
    // The named context has its own verified layout and does not need the
    // imported Docker image. Keep both paths covered on the same bytes.
    const namedContext = await prepareRuntimeArtifactLayout(selection, Date.now() + 60_000);
    artifacts.namedContext = namedContext;
    assert.equal(namedContext.platformManifestDigest, loaded.platformManifestDigest);
    assert.notEqual(namedContext.layoutDirectory, loaded.layoutDirectory);
    await loaded.cleanup();
    await writeFile(
      join(context, "Dockerfile.derived"),
      "FROM runtime-base\nCOPY payload /derived\nCOPY --from=runtime-base /payload /from-base\n",
    );
    run("docker", [
      "buildx",
      "build",
      "--provenance=false",
      "--build-context",
      `runtime-base=oci-layout://${namedContext.layoutDirectory}@${namedContext.platformManifestDigest}`,
      "--load",
      "-t",
      derivedTag,
      "-f",
      join(context, "Dockerfile.derived"),
      context,
    ]);
    assert.equal(
      record(
        record(firstRecord(JSON.parse(run("docker", ["image", "inspect", derivedTag]))).Config)
          .Labels,
      )["org.opencontainers.image.revision"],
      sourceSha,
    );
    // An existing caller-owned tag must never be replaced, even by a valid
    // artifact from this same run. The original loaded image remains usable.
    const occupied = firstRecord(JSON.parse(run("docker", ["image", "inspect", derivedTag]))).Id;
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag: derivedTag }), /already exists/);
    assert.equal(
      firstRecord(JSON.parse(run("docker", ["image", "inspect", derivedTag]))).Id,
      occupied,
    );
    // Smoke's Bake path uses a separate BuildKit container, which cannot
    // resolve images solely from the host daemon's local tags.
    run("docker", [
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      "network=host",
    ]);
    builderCreated = true;
    const bakeFile = join(context, "docker-bake.json");
    await writeFile(
      bakeFile,
      JSON.stringify({
        target: {
          proof: {
            context,
            dockerfile: "Dockerfile.derived",
            contexts: {
              "runtime-base": `oci-layout://${namedContext.layoutDirectory}@${namedContext.platformManifestDigest}`,
            },
            output: ["type=docker"],
            tags: [bakeTag],
          },
        },
      }),
    );
    run("docker", [
      "buildx",
      "bake",
      "--builder",
      builder,
      `--allow=fs.read=${context}`,
      `--allow=fs.read=${namedContext.layoutDirectory}`,
      "-f",
      bakeFile,
      "proof",
    ]);
    for (const [index, image] of [derivedTag, bakeTag].entries()) {
      const container = run("docker", [
        "create",
        "--network",
        "none",
        image,
        "/not-executed",
      ]).trim();
      try {
        const copied = join(directory, `copied-${index}`);
        run("docker", ["cp", `${container}:/from-base`, copied]);
        assert.equal(await readFile(copied, "utf8"), "runtime transport proof\n");
      } finally {
        run("docker", ["rm", container]);
      }
    }
    Object.assign(process.env, {
      OCC_CI_RUNTIME_ARTIFACT_DIRECTORY: artifact,
      OCC_CI_RUNTIME_ARTIFACT_SHA256: selection.archiveSha256,
      OCC_CI_RUNTIME_ARTIFACT_SOURCE_SHA: sourceSha,
      OCC_CI_RUNTIME_ARTIFACT_RUN_ID: selection.runId,
      OCC_CI_RUNTIME_ARTIFACT_ATTEMPT: selection.producerAttempt,
    });
    const prepared = await prepareLane({
      cleanupOwner: undefined,
      file: undefined,
      lane: "images-runtime-startup-3",
      statePath,
    });
    const preparedTag: unknown = prepared.env.OCC_TEST_RUNTIME_IMAGE;
    assert.ok(typeof preparedTag === "string");
    assert.equal(
      firstRecord(JSON.parse(run("docker", ["image", "inspect", preparedTag]))).Id,
      loaded.reference,
    );
    await cleanupResourceIds(statePath, resourceIds(JSON.parse(await readFile(statePath, "utf8"))));
    assert.throws(() => run("docker", ["image", "inspect", preparedTag]), { status: 1 });
    assert.equal(
      firstRecord(JSON.parse(run("docker", ["image", "inspect", tag]))).Id,
      loaded.reference,
      "Cleanup must preserve the independently owned tag.",
    );
    // The producer's earlier attempt is accepted above. Wrong-run/source,
    // corruption and unavailable artifacts fail before a tag can be loaded.
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag, runId: "999" }), /workflow run/);
    await assert.rejects(
      loadRuntimeArtifact({ ...selection, tag, producerAttempt: "999" }),
      /producerAttempt mismatch/,
    );
    await assert.rejects(
      loadRuntimeArtifact({ ...selection, tag, sourceSha: "0".repeat(40) }),
      /checkout/,
    );
    await assert.rejects(
      loadRuntimeArtifact({ ...selection, tag, directory: join(directory, "missing") }),
      /ENOENT/,
    );
    await writeFile(
      join(artifact, "receipt.json"),
      JSON.stringify({ ...receipt, platform: "linux/wrong" }),
    );
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag }), /linux\/wrong/);
    await writeFile(join(artifact, "receipt.json"), JSON.stringify(receipt));
    const original = join(directory, "original.tar");
    await copyFile(join(artifact, "runtime.tar"), original);
    await writeFile(join(artifact, "runtime.tar"), "tampered");
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag }), /checksum/);
    await assert.rejects(
      prepareLane({
        cleanupOwner: undefined,
        file: undefined,
        lane: "images-runtime-startup-3",
        statePath: join(directory, "rejected-state.json"),
      }),
      /checksum/,
    );
    const rejected: unknown = JSON.parse(
      await readFile(join(directory, "rejected-state.json"), "utf8"),
    );
    await cleanupResourceIds(join(directory, "rejected-state.json"), resourceIds(rejected));
    await copyFile(original, join(artifact, "runtime.tar"));
    run("tar", ["-rf", join(artifact, "runtime.tar"), "-C", layout, "index.json"]);
    const duplicateHash = hash(await readFile(join(artifact, "runtime.tar")));
    await writeFile(
      join(artifact, "receipt.json"),
      JSON.stringify({ ...receipt, archiveSha256: duplicateHash }),
    );
    await assert.rejects(
      loadRuntimeArtifact({ ...selection, archiveSha256: duplicateHash, tag }),
      /Duplicate OCI archive member/,
    );

    // Keep all compressed bytes and descriptor checks valid, but make the
    // executable config claim a different uncompressed layer identity.
    const wrongConfig = await blob(manifestConfig);
    const wrongRootfs = record(wrongConfig.rootfs);
    assert.ok(Array.isArray(wrongRootfs.diff_ids));
    wrongRootfs.diff_ids[0] = `sha256:${"0".repeat(64)}`;
    const writeBlob = async (value: unknown, mediaType: string) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const digest = hash(bytes);
      await writeFile(join(layout, "blobs/sha256", digest), bytes);
      return { mediaType, digest: `sha256:${digest}`, size: bytes.length };
    };
    const config = await writeBlob(wrongConfig, manifestConfig.mediaType);
    const newManifest = await writeBlob({ ...manifest, config }, descriptor.mediaType);
    const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [newManifest] }));
    await writeFile(join(layout, "index.json"), index);
    run("tar", [
      "-cf",
      join(artifact, "runtime.tar"),
      "-C",
      layout,
      "oci-layout",
      "index.json",
      "blobs",
    ]);
    const archiveSha256 = hash(await readFile(join(artifact, "runtime.tar")));
    await writeFile(
      join(artifact, "receipt.json"),
      JSON.stringify({
        ...receipt,
        archiveSha256,
        indexDigest: `sha256:${hash(index)}`,
        platformManifestDigest: newManifest.digest,
        configDigest: config.digest,
      }),
    );
    await assert.rejects(
      prepareRuntimeArtifactLayout({ ...selection, archiveSha256 }),
      /OCI layer diff ID mismatch/,
    );
  },
);
