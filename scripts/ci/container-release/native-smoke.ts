import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestPattern, field, identity, isImage, match } from "./metadata.ts";
import { inspectDigest, skopeo } from "./registry.ts";

// CI runs the runtime startup tests in three lanes; the release smoke runs their
// startup files one at a time, since some cases measure timing.
// container-release.test.ts pins this list to the lane manifests.
export const runtimeImageSmokeTests = Object.freeze([
  "tests/helpers/workspace-gateway-relay-container.test.ts",
  "tests/integration/codex-plugin-stdio-real.test.ts",
  "tests/integration/runtime-image-startup.test.mjs",
  "tests/integration/runtime-image-gateway-workspace.test.ts",
  "tests/integration/runtime-image-public-github-read.test.mjs",
  "tests/integration/runtime-image-state-migration.test.mjs",
  "tests/integration/runtime-image-managed-files.test.ts",
  "tests/integration/runtime-image-native-listener.test.mjs",
  "tests/integration/runtime-image-startup-probe.test.mjs",
  "tests/integration/runtime-image-codex-readiness.test.ts",
  "tests/integration/runtime-image-startup-termination.test.ts",
  "tests/integration/runtime-image-gateway-unclean-restart.test.ts",
  "tests/integration/runtime-image-gateway-retained-state.test.ts",
  "tests/integration/runtime-image-workspace-setup-lock.test.ts",
  "tests/integration/runtime-image-gateway-peer.test.ts",
  "tests/integration/runtime-image-native-worker.test.mjs",
  "tests/integration/runtime-image-node-state-permissions.test.ts",
  "tests/integration/runtime-image-node-state-lock.test.ts",
  "tests/integration/runtime-image-codex-local-plugins.test.ts",
  "tests/integration/sandbox-driver-startup.test.ts",
  "tests/integration/sandbox-driver-workspace-admission.test.ts",
  "tests/integration/sandbox-driver-startup-validation.test.ts",
  "tests/integration/sandbox-driver-installation-configuration.test.ts",
  "tests/integration/sandbox-driver-ipv6-endpoints.test.ts",
  "tests/integration/sandbox-driver-codex-app-server.test.ts",
  "tests/integration/workspace-files-native.test.ts",
]);

export async function smoke(directory: string | undefined, env: NodeJS.ProcessEnv) {
  assert.ok(isImage(env.IMAGE), "Expected IMAGE to be controller or runtime.");
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  assert.ok(["amd64", "arm64"].includes(arch));
  assert.equal(env.PLATFORM, `linux/${arch}`, "Smoke requires the target's native runner.");
  assert.ok(directory !== undefined, "An OCI layout directory is required.");
  // Resolve native runtime tooling before loading an image that would need cleanup.
  const runtimePreparation = env.IMAGE === "runtime" ? await import("../prepare.mjs") : undefined;
  assert.equal(inspectDigest(`oci:${directory}`), env.IMAGE_DIGEST);
  const root: unknown = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
  function singleDescriptor(index: unknown): unknown {
    const manifests = field(index, "manifests");
    assert.ok(Array.isArray(manifests));
    assert.equal(manifests.length, 1);
    return manifests[0];
  }
  const blob = async (entry: unknown): Promise<unknown> => {
    const digest = field(entry, "digest") ?? "";
    match(digest, digestPattern);
    const bytes = await readFile(join(directory, "blobs/sha256", digest.slice(7)));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, digest);
    return JSON.parse(bytes.toString("utf8"));
  };
  let descriptor = singleDescriptor(root);
  assert.equal(field(descriptor, "digest"), env.IMAGE_DIGEST);
  let manifest = await blob(descriptor);
  if (field(descriptor, "mediaType") === "application/vnd.oci.image.index.v1+json") {
    descriptor = singleDescriptor(manifest);
    manifest = await blob(descriptor);
  }
  assert.equal(field(manifest, "mediaType"), "application/vnd.oci.image.manifest.v1+json");
  const config = field(manifest, "config");
  assert.ok(config !== null && config !== undefined);
  const configDigest = field(config, "digest");
  const tag = `localhost/enterprise-${env.IMAGE}:prepared-${arch}`;
  skopeo(["copy", `oci:${directory}`, `docker-daemon:${tag}`], { stdio: "inherit" });
  let prepared:
    Awaited<ReturnType<(typeof import("../prepare.mjs"))["prepareRuntimeImageSmoke"]>> | undefined;
  try {
    const inspected: unknown = JSON.parse(
      execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }),
    );
    assert.ok(Array.isArray(inspected));
    const loaded: unknown = inspected[0];
    const loadedDescriptor = field(loaded, "Descriptor");
    const loadedId = field(loaded, "Id");
    if (loadedDescriptor) {
      // The containerd store's Id identifies a manifest/index, not its config.
      // Export and hash-check that immutable target before trusting its config.
      match(field(loadedDescriptor, "digest") ?? "", digestPattern);
      assert.equal(loadedId, field(loadedDescriptor, "digest"));
      const verified: unknown = JSON.parse(
        execFileSync(
          "python3",
          ["scripts/upgrade-image-identity.py", `${tag}@${loadedId}`, `linux/${arch}`],
          { encoding: "utf8" },
        ),
      );
      assert.equal(
        field(verified, "configDigest"),
        configDigest,
        "Loaded image configuration differs from the sealed OCI export.",
      );
    } else {
      assert.equal(loadedId, configDigest);
    }
    assert.equal(field(loaded, "Os"), "linux");
    assert.equal(field(loaded, "Architecture"), arch);
    assert.ok(typeof loadedId === "string");
    if (runtimePreparation) {
      prepared = await runtimePreparation.prepareRuntimeImageSmoke({
        image: loadedId,
        statePath: join(env.RUNNER_TEMP ?? tmpdir(), `runtime-smoke-${arch}.json`),
      });
    }
    console.log(`Smoke ${env.IMAGE} ${env.PLATFORM} @ ${field(descriptor, "digest")}`);
    execFileSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        ...(env.IMAGE === "controller"
          ? ["tests/integration/production-image-startup.test.mjs"]
          : runtimeImageSmokeTests),
      ],
      {
        env: {
          ...env,
          ...prepared?.env,
          OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER: "1",
          [env.IMAGE === "controller" ? "OCC_TEST_PRODUCTION_IMAGE" : "OCC_TEST_RUNTIME_IMAGE"]:
            loadedId,
        },
        stdio: "inherit",
      },
    );
    assert.equal(inspectDigest(`oci:${directory}`), env.IMAGE_DIGEST);
    await writeFile(
      join(directory, "platform.json"),
      `${JSON.stringify(
        {
          ...identity(env, env.IMAGE),
          platform: env.PLATFORM,
          digest: env.IMAGE_DIGEST,
          native: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    try {
      await prepared?.cleanup();
    } finally {
      execFileSync("docker", ["image", "rm", tag], { stdio: "inherit" });
    }
  }
}
