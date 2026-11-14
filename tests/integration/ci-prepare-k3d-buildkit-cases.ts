import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  assertStderrMatch,
  fixture,
  fixtureImageCommands,
  fixturePreparationMetrics,
  immutableImage,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.ts";
import { interceptFixtureDocker } from "./ci-prepare-k3d-docker-fixture.ts";

// Exercise the real preparation log projection with controlled command output;
// these counters do not establish a remote cache hit or live BuildKit behavior.
function imageCacheObservations(stderr: string, lane: string) {
  return fixturePreparationMetrics(stderr, lane).filter(({ stage }) => stage === "image-cache");
}

function assertImageCacheObservations(stderr: string, lane: string) {
  const records = imageCacheObservations(stderr, lane);
  assert.equal(records.length, 4, "one summary per image and completed probe/load");
  for (const role of ["controller", "runtime"]) {
    assert.deepEqual(
      records.filter((record) => record.role === role),
      ["probe", "load"].map((phase) => ({
        stage: "image-cache",
        role,
        phase,
        cacheImports: phase === "probe" ? 1 : 0,
        cachedSteps: phase === "probe" ? 2 : 3,
        openclawBuildSteps: 2,
        openclawBuildCached: phase === "probe" ? 1 : 2,
      })),
    );
  }
  assert.doesNotMatch(
    stderr,
    /private-step|synthetic-build-command|synthetic-sibling-command|synthetic-build-output/,
  );
}

async function assertReadOnlyBuildKitCache(t: TestContext, lane: string, env: NodeJS.ProcessEnv) {
  const commands = await fixtureImageCommands(t, "cache-progress", lane, {
    GITHUB_ACTIONS: "true",
    OCC_CI_IMAGE_CACHE: "1",
    ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
    ACTIONS_RESULTS_URL: "https://cache.example.test/",
    NODE_BASE_IMAGE: nodeBaseImage,
    OPENAI_API_KEY: "synthetic-model-key",
    OCC_TEST_OPENAI_MODEL: "synthetic-model",
    ...env,
  });
  // Stop at image import after both real preparation build commands. The command
  // log verifies read-only cache selection without depending on cache contents.
  let imports = 0;
  await interceptFixtureDocker(t, commands, (args) => {
    if (args.length === 3 && args[0] === "image" && args[1] === "inspect") {
      imports += 1;
      return "printf 'synthetic import stop\\n' >&2; exit 1";
    }
  });
  const prepared = await commands.prepare();
  assert.equal(prepared.status, 1);
  assertStderrMatch(prepared.stderr, /synthetic import stop/);
  assert.equal(imports, 1);
  assertImageCacheObservations(prepared.stderr, lane);

  const calls = await commands.commands();
  const builds = calls.filter(({ args }) => args[0] === "buildx" && args[1] === "build");
  assert.equal(builds.length, 4, "probe and load both checkout images");
  assert.ok(builds.every(({ command }) => command === "docker"));
  for (const role of ["controller", "runtime"]) {
    assertStderrMatch(
      prepared.stderr,
      new RegExp(`"stage":"${role}-image-reuse","outcome":"absent"`),
    );
    const roleBuilds = builds.filter(
      ({ args }) => args.includes("--target") === (role === "controller"),
    );
    assert.equal(roleBuilds.length, 2, role);
    assert.equal(roleBuilds.filter(({ args }) => args.includes("--load")).length, 1, role);
    assert.equal(
      roleBuilds.filter(
        ({ args }) => args[args.indexOf("--output") + 1] === "type=image,push=false,store=false",
      ).length,
      1,
      role,
    );
    for (const { args } of roleBuilds) {
      assert.equal(
        args[args.indexOf("--cache-from") + 1],
        `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
      );
      assert.equal(args[args.indexOf("SOURCE_DATE_EPOCH=0") - 1], "--build-arg");
      assert.ok(args.includes("--progress=plain"));
    }
  }
  assert.equal(
    calls.some(({ args }) =>
      args.some((arg) => arg === "--cache-to" || arg.startsWith("--cache-to=")),
    ),
    false,
    "preparation must not export a cache, including in a separate build",
  );
  assert.equal(
    calls.some(({ args }) => args[0] === "build"),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(calls) +
      (await readFile(commands.statePath, "utf8")) +
      prepared.stdout +
      prepared.stderr,
    /synthetic-cache-credential/,
  );
  await commands.cleanupSuccessfully();
}

export function registerBuildKitCases() {
  test("slack prepares checkout images with read-only BuildKit caches", (t) =>
    assertReadOnlyBuildKitCache(t, "slack", {
      OCC_TEST_SLACK_CHANNEL_ID: "synthetic-channel",
      OCC_TEST_SLACK_SENDER_BOT_TOKEN: "synthetic-sender",
      SLACK_APP_TOKEN: "synthetic-app",
      SLACK_BOT_TOKEN: "synthetic-bot",
    }));
  test("production-tui prepares checkout images with read-only BuildKit caches", (t) =>
    assertReadOnlyBuildKitCache(t, "production-tui", {
      OCC_TEST_PRODUCTION_POSTGRES_IMAGE: immutableImage,
      OCC_TEST_PRODUCTION_NODE_IMAGE: immutableImage,
    }));
  test("Gateway Routing prepares checkout images with read-only BuildKit caches", (t) =>
    assertReadOnlyBuildKitCache(t, "gateway-routing", {}));

  test("alternate OpenClaw source preparation requests plain progress for runtime cache observations", async (t) => {
    const source = await fixture(t);
    await writeFile(join(source, "Dockerfile"), "FROM scratch AS native-build\n");
    const commands = await fixtureImageCommands(t, "success", "gateway-routing", {
      GITHUB_ACTIONS: "true",
      OCC_CI_IMAGE_CACHE: "1",
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      NODE_BASE_IMAGE: nodeBaseImage,
      OPENAI_API_KEY: "synthetic-model-key",
      OCC_TEST_OPENAI_MODEL: "synthetic-model",
      OCC_K3D_OPENCLAW_SOURCE: source,
      OCC_K3D_OPENCLAW_COMMIT: "a".repeat(40),
    });
    // Stop after the real CLI has built both images, before importing into k3d.
    // The external command is controlled; no Docker or source build is claimed.
    await interceptFixtureDocker(t, commands, (args) => {
      if (args.length === 3 && args[0] === "image" && args[1] === "inspect") {
        return "printf 'synthetic import stop\\n' >&2; exit 1";
      }
    });
    const prepared = await commands.prepare();
    assert.equal(prepared.status, 1);
    assertStderrMatch(prepared.stderr, /synthetic import stop/);
    const builds = (await commands.commands()).filter(({ args }) =>
      args.includes("OPENCLAW_DOCKER_BUILD_SKIP_DTS=1"),
    );
    assert.equal(builds.length, 1);
    const [build] = builds;
    assert.ok(build);
    assert.equal(build.args.at(-1), source);
    assert.ok(build.args.includes("--progress=plain"));
    assert.deepEqual(
      imageCacheObservations(prepared.stderr, "gateway-routing").filter(
        (record) => record.role === "runtime",
      ),
      [
        {
          stage: "image-cache",
          role: "runtime",
          phase: "load",
          cacheImports: 0,
          cachedSteps: 1,
          openclawBuildSteps: 0,
          openclawBuildCached: 0,
        },
      ],
    );
    assert.doesNotMatch(
      prepared.stdout + prepared.stderr,
      /synthetic-native-command|synthetic-cache-credential/,
    );
    await commands.cleanupSuccessfully();
  });
}

export function registerVerifiedRuntimePublicationCase() {
  test("preselected runtime preparation publishes the verified host image for Docker relays", async (t) => {
    const preload = join(await fixture(t), "runtime-selection.mjs");
    const commands = await fixtureImageCommands(t, "local-digest", "k3d-model", {
      NODE_OPTIONS: `--import=${preload}`,
      NODE_BASE_IMAGE: nodeBaseImage,
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
      OPENAI_API_KEY: "test-only-key",
      OCC_TEST_OPENAI_MODEL: "test-model",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_CODEX_VERSION: "0.164.0",
    });
    // Exercise the real preparation CLI, image verification and environment publication.
    // Routing installation and seccomp generation are separate from image selection.
    const prepareUrl = new URL("../../scripts/ci/prepare.mjs", import.meta.url).href;
    await writeFile(
      preload,
      `import { registerHooks } from "node:module";
export async function prepareGatewayRouting() { return { env: {} }; }
export async function prepareCodexSeccompProfile() { return { profileName: "fixture-profile", nodes: [] }; }
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ${JSON.stringify(prepareUrl)} &&
        ["./routing.ts", "../lib/codex-seccomp-k3d.ts"].includes(specifier)) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    const state = await commands.readState();
    assert.ok(state.env, "expected published lane environment");
    // Docker runs the verified host config, while Kubernetes uses its imported manifest.
    assert.equal(state.env.OCC_DOCKER_RUNTIME_IMAGE, `sha256:${"b".repeat(64)}`);
    const kubernetesImage = state.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
    assert.ok(kubernetesImage, "expected the imported Kubernetes image");
    assert.match(kubernetesImage, /^localhost\/.+@sha256:/);
    assert.notEqual(
      state.env.OCC_DOCKER_RUNTIME_IMAGE,
      state.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
    );
    assert.match(
      await readFile(commands.githubEnv, "utf8"),
      new RegExp(`^OCC_DOCKER_RUNTIME_IMAGE=sha256:${"b".repeat(64)}$`, "m"),
    );
    await commands.cleanupSuccessfully();
    assert.ok(
      !(await commands.commands()).some(
        ({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(immutableImage),
      ),
      "cleanup must preserve the caller's immutable source image",
    );
  });
}
