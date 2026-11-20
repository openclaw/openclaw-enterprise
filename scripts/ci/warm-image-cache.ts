#!/usr/bin/env node
import { parseArgs } from "node:util";
import { assertNodeBaseImage } from "./image-build-cache.ts";
import { boundedImageCommand } from "./k3d-image-admission.ts";

type WarmImageCacheRequest = {
  statePath: string | undefined;
  requireCacheExport: boolean;
  nodeBaseImage: string | undefined;
};

async function warmImageCache({
  statePath,
  requireCacheExport,
  nodeBaseImage,
}: WarmImageCacheRequest) {
  const { GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_REPOSITORY } = process.env;
  if (
    GITHUB_REF !== "refs/heads/main" ||
    (GITHUB_EVENT_NAME !== "push" &&
      GITHUB_EVENT_NAME !== "schedule" &&
      GITHUB_EVENT_NAME !== "workflow_dispatch")
  ) {
    throw new Error("Only a push, schedule or dispatch on main may warm the image cache.");
  }
  if (requireCacheExport) {
    if (GITHUB_REPOSITORY !== "openclaw/openclaw-enterprise") {
      throw new Error("Required cache exports run only in the canonical repository.");
    }
    // The protected caller resolves this input once for the producer and consumers.
    assertNodeBaseImage(nodeBaseImage);
  }

  const { prepareImageCacheBuilds } = await import("./prepare.ts");
  const builds = await prepareImageCacheBuilds(statePath);
  const started = performance.now();
  // Both roles own engine tags. Wait for both before the workflow can clean up,
  // including when one build or required export fails.
  const [controller, runtime] = await Promise.allSettled([
    builds.buildController(nodeBaseImage, requireCacheExport),
    builds.buildRuntime(requireCacheExport),
  ]);
  process.stderr.write(
    `[ci-timing] lane=image-cache-warm phase=controller-runtime-image-build duration_ms=${Math.round(performance.now() - started)}\n`,
  );
  if (controller.status === "rejected") {
    throw controller.reason;
  }
  if (runtime.status === "rejected") {
    throw runtime.reason;
  }

  // The hosted runner keeps tagged images. Use a separate local tag named by
  // image ID so lanes can reuse it after cleanup removes the run-owned tag.
  const owned = runtime.value;
  const result = await boundedImageCommand(["image", "inspect", "--format", "{{.Id}}", owned]);
  const id = result.stdout.trim();
  const digest = /^sha256:([a-f0-9]{12})[a-f0-9]{52}$/u.exec(id)?.[1];
  if (!digest) {
    throw new Error("The warm runtime image has no image ID to keep.");
  }
  const tag = `localhost/openclaw-ci-main/runtime:${digest}`;
  await boundedImageCommand(["tag", owned, tag]);
  process.stderr.write(
    `[prepare:image-cache-warm] ${JSON.stringify({ stage: "runtime-image-kept", image: id, tag })}\n`,
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      "require-cache-export": { type: "boolean", default: false },
      "node-base-image": { type: "string" },
      "validate-node-base-image": { type: "string" },
    },
  });
  if (values["validate-node-base-image"] !== undefined) {
    if (
      values.state !== undefined ||
      values["require-cache-export"] ||
      values["node-base-image"] !== undefined
    ) {
      throw new Error("--validate-node-base-image must be used on its own.");
    }
    assertNodeBaseImage(values["validate-node-base-image"]);
    return;
  }
  await warmImageCache({
    statePath: values.state,
    requireCacheExport: values["require-cache-export"],
    nodeBaseImage: values["node-base-image"],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
