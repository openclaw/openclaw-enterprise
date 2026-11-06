import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeArtifact } from "../../scripts/ci/runtime-artifact.mjs";
import { prepareLane } from "../../scripts/ci/prepare.mjs";
import { cleanupResourceIds } from "../../scripts/ci/cleanup.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (program, args) =>
  execFileSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });

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
    let loaded;
    t.after(async () => {
      await loaded?.cleanup();
      if (builderCreated) {
        run("docker", ["buildx", "rm", builder]);
      }
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        await cleanupResourceIds(
          statePath,
          state.resources.map((resource) => resource.id),
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
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
    let descriptor = JSON.parse(rootBytes).manifests[0];
    const indexDigest = descriptor.mediaType.endsWith("image.index.v1+json")
      ? descriptor.digest
      : `sha256:${hash(rootBytes)}`;
    const blob = async (entry) =>
      JSON.parse(await readFile(join(layout, "blobs/sha256", entry.digest.slice(7)), "utf8"));
    if (descriptor.mediaType.endsWith("image.index.v1+json")) {
      descriptor = (await blob(descriptor)).manifests[0];
    }
    const manifest = await blob(descriptor);
    const selection = {
      directory: artifact,
      archiveSha256: hash(await readFile(join(artifact, "runtime.tar"))),
      sourceSha,
      runId: "123456",
      producerAttempt: "1",
    };
    const receipt = {
      version: 1,
      ...selection,
      platform: `linux/${process.arch === "x64" ? "amd64" : process.arch}`,
      indexDigest,
      platformManifestDigest: descriptor.digest,
      configDigest: manifest.config.digest,
    };
    delete receipt.directory;
    await writeFile(join(artifact, "receipt.json"), JSON.stringify(receipt));
    loaded = await loadRuntimeArtifact({ ...selection, tag });
    assert.equal(loaded.configDigest, manifest.config.digest);
    assert.equal(
      JSON.parse(run("docker", ["image", "inspect", loaded.reference]))[0].Config.Labels[
        "org.opencontainers.image.revision"
      ],
      sourceSha,
    );
    const imported = JSON.parse(run("docker", ["image", "inspect", loaded.reference]))[0];
    assert.ok(imported.Config.Env.includes("TRANSPORT_PROOF=kept"));
    assert.deepEqual(imported.Config.Entrypoint, ["/does-not-run"]);
    assert.deepEqual(imported.Config.Cmd, ["proof"]);
    assert.equal(imported.Config.User, "1234:5678");
    assert.equal(imported.Config.WorkingDir, "/workspace");
    assert.equal(imported.Config.StopSignal, "SIGUSR1");
    assert.deepEqual(imported.Config.ExposedPorts, { "12345/tcp": {} });
    // The separate BuildKit builder receives the verified OCI layout as a named
    // base; this proves that host Docker tag visibility is not required.
    await writeFile(
      join(context, "Dockerfile.derived"),
      "FROM runtime-base\nCOPY payload /derived\nCOPY --from=runtime-base /payload /from-base\n",
    );
    run("docker", [
      "buildx",
      "build",
      "--provenance=false",
      "--build-context",
      `runtime-base=oci-layout://${loaded.layoutDirectory}@${loaded.platformManifestDigest}`,
      "--load",
      "-t",
      derivedTag,
      "-f",
      join(context, "Dockerfile.derived"),
      context,
    ]);
    assert.equal(
      JSON.parse(run("docker", ["image", "inspect", derivedTag]))[0].Config.Labels[
        "org.opencontainers.image.revision"
      ],
      sourceSha,
    );
    // An existing caller-owned tag must never be replaced, even by a valid
    // artifact from this same run. The original loaded image remains usable.
    const occupied = JSON.parse(run("docker", ["image", "inspect", derivedTag]))[0].Id;
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag: derivedTag }), /already exists/);
    assert.equal(JSON.parse(run("docker", ["image", "inspect", derivedTag]))[0].Id, occupied);
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
              "runtime-base": `oci-layout://${loaded.layoutDirectory}@${loaded.platformManifestDigest}`,
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
      `--allow=fs.read=${loaded.layoutDirectory}`,
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
    const prepared = await prepareLane({ lane: "images-runtime-startup-3", statePath });
    const preparedTag = prepared.env.OCC_TEST_RUNTIME_IMAGE;
    assert.equal(
      JSON.parse(run("docker", ["image", "inspect", preparedTag]))[0].Id,
      loaded.reference,
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await cleanupResourceIds(
      statePath,
      state.resources.map((resource) => resource.id),
    );
    assert.throws(() => run("docker", ["image", "inspect", preparedTag]), { status: 1 });
    assert.equal(
      JSON.parse(run("docker", ["image", "inspect", tag]))[0].Id,
      loaded.reference,
      "Cleanup must preserve the independently owned tag.",
    );
    // The producer's earlier attempt is accepted above. Wrong-run/source,
    // corruption and unavailable artifacts fail before a tag can be loaded.
    await assert.rejects(loadRuntimeArtifact({ ...selection, tag, runId: "999" }), /workflow run/);
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
        lane: "images-runtime-startup-3",
        statePath: join(directory, "rejected-state.json"),
      }),
      /checksum/,
    );
    const rejected = JSON.parse(await readFile(join(directory, "rejected-state.json"), "utf8"));
    await cleanupResourceIds(
      join(directory, "rejected-state.json"),
      rejected.resources.map((resource) => resource.id),
    );
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
  },
);
