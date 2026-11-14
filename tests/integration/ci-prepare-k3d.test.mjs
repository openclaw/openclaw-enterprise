import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { nodeLogExcerpt } from "../../scripts/ci/k3d-diagnostics.mjs";
import { defaultK3sImage, prepareRuntimeImageSmoke } from "../../scripts/ci/prepare.mjs";
import { prepareGatewayRouting } from "../../scripts/ci/routing.ts";
import {
  assertStderrMatch,
  digest,
  fixture,
  fixtureImageCommands,
  fixturePreparationMetrics,
  immutableImage,
  nodeBaseImage,
  writeFixtureCommand,
} from "../helpers/ci-prepare-fixture.ts";
import { eachSettled } from "../helpers/child-processes.mjs";
import { waitFor, waitUntil, within } from "../helpers/wait-for.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { bashString, startCommandServer } from "../helpers/fixture-command-server.ts";

test("native container preparation summaries", async (t) => {
  const hostEnv = process.env;
  for (const mode of ["normal", "opt-out", "unset", "directory"]) {
    // Create each fresh fixture with the host PATH so it can resolve its shims.
    const commands = await fixtureImageCommands(t, "success", "images-packaging");
    const root = dirname(commands.statePath);
    const bin = join(root, "bin");
    const summary = join(root, "summary.md");
    const image = `sha256:${digest}`;
    try {
      process.env = {
        HOME: root,
        PATH: bin,
        TMPDIR: root,
        RUNNER_TEMP: root,
        CI_FIXTURE_SCENARIO: "success",
        CI_FIXTURE_LANE: "images-packaging",
        OCC_DOCKER_BIN: join(bin, "docker.mjs"),
        OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
        OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: image,
        // nodeBaseImage stands in for Envoy; the synthetic non-reviewed version
        // deliberately fails late, inside the third timed preparation phase.
        OCC_TEST_WORKSPACE_ENVOY_IMAGE: nodeBaseImage,
        OCC_TEST_KUBERNETES_CODEX_VERSION: "not-reviewed",
        OPENCLAW_CI_NATIVE_PREPARATION_SUMMARY: mode === "opt-out" ? "0" : "1",
      };
      if (mode !== "unset") {
        process.env.GITHUB_STEP_SUMMARY = mode === "directory" ? root : summary;
      }
      await writeFile(summary, "Existing summary\n");
      await assert.rejects(prepareRuntimeImageSmoke({ image, statePath: commands.statePath }), {
        code: "ERR_ASSERTION",
        message:
          "Codex seccomp profile verification is limited to reviewed Codex versions: " +
          "0.152.1, 0.154.0, 0.156.0, 0.158.0, 0.160.0, 0.163.0-alpha.1, 0.163.0-alpha.2, 0.164.0.",
      });
      await assert.rejects(stat(commands.statePath), { code: "ENOENT" });
      const text = await readFile(summary, "utf8");
      if (mode === "normal") {
        const rows = text.split("\n");
        assert.equal(rows.length, 5);
        assert.equal(rows[0], "Existing summary");
        assert.match(rows[1], /^- k3d-create: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/);
        assert.match(
          rows[2],
          /^- runtime-image-import: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/,
        );
        assert.match(
          rows[3],
          /^- codex-seccomp-profile: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/,
        );
        assert.equal(rows[4], "");
      } else {
        assert.equal(text, "Existing summary\n");
      }
    } finally {
      process.env = hostEnv;
    }
  }
});

// Override selected external commands while the normal CLI and fixture handle the rest.
async function interceptFixtureDocker(t, commands, scriptFor) {
  const engine = join(dirname(commands.statePath), "bin", "docker.mjs");
  const original = `${engine}.original`;
  await rename(engine, original);
  const server = await startCommandServer({
    forwardedEnv: [],
    handle: async ({ args, io }) => {
      const script = await scriptFor(args);
      io.script(script ?? `exec ${bashString(original)} ${args.map(bashString).join(" ")}`);
    },
  });
  t.after(() => server.close());
  await writeFixtureCommand(engine, "docker", server);
}

for (const scenario of [
  "available",
  "manifest",
  "missing",
  "invalid",
  "directory",
  "oversized",
  "different-image",
  "cleanup-failed",
  "invalid-inventory",
  "cleanup-failed-once",
  "receipt-write-failed",
  "replaced-container",
  "lost-reply-replaced",
]) {
  test(`runtime provenance retains only verified metadata: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(t, "success", "k3d-model", {
      NODE_BASE_IMAGE: nodeBaseImage,
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
      OPENAI_API_KEY: "synthetic-model-key",
      OCC_TEST_OPENAI_MODEL: "synthetic-model",
      OCC_TEST_KUBERNETES_CODEX_VERSION: "not-reviewed",
    });
    const configId = `sha256:${"b".repeat(64)}`;
    const imageId = scenario === "manifest" ? `sha256:${"9".repeat(64)}` : configId;
    const containerId = "d".repeat(64);
    const canary = "private-provenance-must-not-be-uploaded";
    const metadata = {
      commit: "e".repeat(40),
      codex: {
        architecture: "amd64",
        version: scenario === "manifest" ? "0.164.0-alpha.1+build.2" : "0.164.0",
        binarySha256: "f".repeat(64),
        config: canary,
      },
      private: canary,
    };
    const metadataPath = join(dirname(commands.statePath), "provenance.json");
    if (scenario === "directory") {
      await mkdir(metadataPath);
      await writeFile(join(metadataPath, "unexpected"), canary);
    } else {
      await writeFile(
        metadataPath,
        scenario === "oversized"
          ? "x".repeat(128 * 1024)
          : JSON.stringify(
              scenario === "invalid"
                ? { ...metadata, codex: { ...metadata.codex, binarySha256: canary } }
                : metadata,
            ),
      );
    }
    const archivePath = join(dirname(commands.statePath), "provenance.tar");
    const archived = spawnSync("tar", [
      "--format=ustar",
      "-C",
      dirname(commands.statePath),
      "-cf",
      archivePath,
      "provenance.json",
    ]);
    assert.equal(archived.status, 0, archived.stderr.toString());
    let hostCopy = false;
    let containerPresent = false;
    const cleanupFailure = [
      "cleanup-failed",
      "invalid-inventory",
      "cleanup-failed-once",
      "receipt-write-failed",
      "replaced-container",
      "lost-reply-replaced",
    ].includes(scenario);
    const retainedContainer = [
      "cleanup-failed",
      "invalid-inventory",
      "replaced-container",
      "lost-reply-replaced",
    ].includes(scenario);
    let allowRemoval = !retainedContainer;
    let removalAttempts = 0;
    let brokenReceipt = false;
    if (scenario === "available") {
      await writeFile(
        `${commands.statePath}.diagnostics.json`,
        JSON.stringify({
          lane: "previous-lane",
          preparationId: "previous-attempt",
          failure: canary,
        }),
      );
    }
    let ownershipToken;
    const manifest = JSON.stringify({ config: { digest: configId } });
    const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    let created = 0;
    await interceptFixtureDocker(t, commands, async (args) => {
      if (
        scenario === "manifest" &&
        args[0] === "image" &&
        args[1] === "inspect" &&
        args.includes("{{.Id}}")
      ) {
        return `printf '%s' ${bashString(imageId)}; exit 0`;
      }
      if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === imageId) {
        // Docker 29 selects a platform manifest from the immutable image index.
        const selected = args.includes("--platform");
        const descriptor = selected
          ? { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest }
          : { mediaType: "application/vnd.oci.image.index.v1+json", digest: imageId };
        return `printf '%s' ${bashString(
          JSON.stringify([
            {
              Id: imageId,
              Os: "linux",
              Architecture: "amd64",
              ...(scenario === "manifest" ? { Descriptor: descriptor } : {}),
            },
          ]),
        )}; exit 0`;
      }
      if (scenario === "different-image" && args.includes("inspecti")) {
        return `printf '%s' ${bashString(
          JSON.stringify({
            status: {
              id: `sha256:${"a".repeat(64)}`,
              repoDigests: [args.at(-1)],
              pinned: true,
            },
          }),
        )}; exit 0`;
      }
      if (scenario === "manifest" && args.includes("content") && args.at(-1) === manifestDigest) {
        return `printf '%s' ${bashString(manifest)}; exit 0`;
      }
      if (args[0] === "create") {
        assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
        assert.ok(
          args.includes(imageId),
          "copy from the immutable image, never its mutable build tag",
        );
        const state = await commands.readState();
        if (scenario === "manifest") {
          await writeFile(
            `${commands.statePath}.diagnostics.json`,
            JSON.stringify({
              lane: state.lane,
              preparationId: createHash("sha256").update(state.prefix).digest("hex"),
              currentAttempt: "retain",
            }),
          );
        }
        ownershipToken = state.resources.find(
          (resource) => resource.kind === "image-file",
        )?.ownershipToken;
        if (scenario === "lost-reply-replaced") {
          assert.ok(ownershipToken, "persist the ownership token before creating a container");
          assert.ok(args.includes(`org.openclaw.ci.image-file=${ownershipToken}`));
        }
        assert.ok(
          state.resources.some(
            (resource) => resource.kind === "image-file" && resource.name === args[2],
          ),
          "persist cleanup ownership before engine creation",
        );
        containerPresent = true;
        created += 1;
        if (scenario === "receipt-write-failed") {
          await rename(commands.statePath, `${commands.statePath}.backup`);
          await mkdir(commands.statePath);
          brokenReceipt = true;
        }
        return scenario === "lost-reply-replaced"
          ? "exit 1"
          : `printf '%s' ${bashString(containerId)}; exit 0`;
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return `printf '%s' ${bashString(allowRemoval ? ownershipToken : "unrelated-owner")}; exit 0`;
      }
      if (args[0] === "cp") {
        assert.equal(args[1], `${containerId}:/opt/oce/runtime/provenance.json`);
        if (scenario === "missing") {
          // A failed acquisition must not accept valid-looking residual content.
          const state = await commands.readState();
          const cluster = state.resources.find((resource) => resource.kind === "k3d-cluster");
          const extraction = state.resources.find((resource) => resource.kind === "image-file");
          await writeFile(
            join(cluster.directory, `${extraction.id}.json`),
            JSON.stringify(metadata),
          );
          return "exit 1";
        }
        if (args[2] === "-") {
          return `/bin/cat ${bashString(archivePath)}; exit 0`;
        }
        hostCopy = true;
        return `/bin/cp -R ${bashString(metadataPath)} ${bashString(args[2])}; exit 0`;
      }
      if (args[0] === "ps" && args.includes("--filter") && args.at(-1).includes("-provenance-")) {
        if (brokenReceipt) {
          await rm(commands.statePath, { recursive: true });
          await rename(`${commands.statePath}.backup`, commands.statePath);
          brokenReceipt = false;
        }
        if (scenario === "invalid-inventory" && !allowRemoval) {
          return `printf '%s' ${bashString(canary)}; exit 0`;
        }
        const observedId =
          scenario === "replaced-container" && !allowRemoval ? "e".repeat(64) : containerId;
        return `printf '%s' ${bashString(containerPresent ? observedId : "")}; exit 0`;
      }
      if (args[0] === "rm" && args.at(-1) === containerId) {
        removalAttempts += 1;
        assert.ok(args.includes("--volumes"), "remove anonymous extraction volumes");
        if (!allowRemoval || (scenario === "cleanup-failed-once" && removalAttempts === 1)) {
          return `printf '%s' ${bashString(canary)} >&2; exit 1`;
        }
        containerPresent = false;
        return "exit 0";
      }
    });
    const prepared = await commands.prepare();
    assert.equal(
      prepared.status,
      1,
      "the later unsupported seccomp version intentionally stops preparation",
    );
    assertStderrMatch(
      prepared.stderr,
      cleanupFailure ? /Runtime provenance cleanup failed/ : /limited to reviewed Codex versions/,
    );
    const state = await commands.readState();
    const expected = {
      imageId,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      status: ["available", "manifest"].includes(scenario) ? "available" : "unavailable",
      ...(["available", "manifest"].includes(scenario)
        ? {
            platform: "linux/amd64",
            openclawCommit: metadata.commit,
            codex: { version: metadata.codex.version, binarySha256: "f".repeat(64) },
          }
        : {}),
    };
    const expectedRoles = {
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: expected,
      ...(cleanupFailure ? {} : { OCC_TEST_KUBERNETES_AGENT_IMAGE: expected }),
    };
    assert.deepEqual(state.runtimeProvenance, expectedRoles);
    const diagnostics = await readFile(`${commands.statePath}.diagnostics.json`, "utf8");
    assert.deepEqual(JSON.parse(diagnostics).runtimeProvenance, expectedRoles);
    assert.equal(
      JSON.parse(diagnostics).preparationId,
      createHash("sha256").update(state.prefix).digest("hex"),
    );
    assert.equal(JSON.parse(diagnostics).lane, state.lane);
    if (scenario === "manifest") {
      assert.equal(JSON.parse(diagnostics).currentAttempt, "retain");
    }
    assert.ok(!diagnostics.includes(canary));
    assert.ok(!prepared.stderr.includes(canary));
    assert.equal(
      created,
      scenario === "different-image" ? 0 : 1,
      "reuse one extraction for the shared image",
    );
    assert.equal(containerPresent, retainedContainer);
    if (!allowRemoval) {
      const failedCleanup = await commands.cleanup();
      assert.equal(failedCleanup.status, 1);
      assert.ok(!failedCleanup.stderr.includes(canary));
      assert.ok(
        (await commands.readState()).resources.some((resource) => resource.kind === "image-file"),
      );
      if (scenario === "cleanup-failed") {
        // Rejected receipt fields stay private, and failed cleanup retains its exact receipt.
        const retained = await commands.readState();
        for (const field of ["name", "owner"]) {
          const malformed = structuredClone(retained);
          malformed.resources.find((resource) => resource.kind === "image-file")[field] = canary;
          await writeFile(commands.statePath, JSON.stringify(malformed));
          const rejected = await commands.cleanup();
          assert.equal(rejected.status, 1);
          assert.ok(!rejected.stderr.includes(canary));
          assert.deepEqual(await commands.readState(), malformed);
        }
        await writeFile(commands.statePath, JSON.stringify(retained));
      }
      allowRemoval = true;
    }
    await commands.cleanupSuccessfully();
    assert.equal(containerPresent, false);
    assert.equal(hostCopy, false, "metadata must be bounded before any host filesystem copy");
  });
}

// Exercise the real preparation log projection with controlled command output;
// these counters do not establish a remote cache hit or live BuildKit behavior.
function imageCacheObservations(stderr, lane) {
  const prefix = `[prepare:${lane}] `;
  return stderr.split("\n").flatMap((line) => {
    if (!line.startsWith(prefix + "{")) {
      return [];
    }
    const record = JSON.parse(line.slice(prefix.length));
    return record.stage === "image-cache" ? [record] : [];
  });
}

function assertImageCacheObservations(stderr, lane) {
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

// Each case waits on its own fake k3d and container engine processes, mostly for
// deliberate timeouts, so the cases run concurrently.
// Each case starts several child processes. Bound overlap so setup can reach
// the deliberately hung command before the deadline being tested expires.
describe("CI k3d preparation", { concurrency: 4 }, () => {
  for (const lane of ["slack", "production-tui"]) {
    test(`${lane} prepares checkout images with read-only BuildKit caches`, async (t) => {
      const commands = await fixtureImageCommands(t, "cache-progress", lane, {
        GITHUB_ACTIONS: "true",
        OCC_CI_IMAGE_CACHE: "1",
        ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
        ACTIONS_RESULTS_URL: "https://cache.example.test/",
        NODE_BASE_IMAGE: nodeBaseImage,
        ...(lane === "slack"
          ? {
              OCC_TEST_SLACK_CHANNEL_ID: "synthetic-channel",
              OCC_TEST_SLACK_SENDER_BOT_TOKEN: "synthetic-sender",
              SLACK_APP_TOKEN: "synthetic-app",
              SLACK_BOT_TOKEN: "synthetic-bot",
            }
          : {
              OCC_TEST_PRODUCTION_POSTGRES_IMAGE: immutableImage,
              OCC_TEST_PRODUCTION_NODE_IMAGE: immutableImage,
            }),
        OPENAI_API_KEY: "synthetic-model-key",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
      });
      // Stop at image import after both real preparation build commands. This
      // proves cache selection, not Docker execution, cache hits, or model access.
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
      for (const role of ["controller", "runtime"]) {
        assertStderrMatch(
          prepared.stderr,
          new RegExp(`"stage":"${role}-image-reuse","outcome":"absent"`),
        );
        const roleBuilds = builds.filter(
          ({ args }) => args.includes("--target") === (role === "controller"),
        );
        assert.equal(roleBuilds.filter(({ args }) => args.includes("--load")).length, 1, role);
        assert.equal(
          roleBuilds.filter(
            ({ args }) =>
              args[args.indexOf("--output") + 1] === "type=image,push=false,store=false",
          ).length,
          1,
          role,
        );
      }
      for (const { args } of builds) {
        const role = args.includes("--target") ? "controller" : "runtime";
        assert.equal(
          args[args.indexOf("--cache-from") + 1],
          `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
        );
        assert.equal(args[args.indexOf("SOURCE_DATE_EPOCH=0") - 1], "--build-arg");
        assert.ok(args.includes("--progress=plain"));
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
    });
  }
  test("Gateway Routing prepares checkout images with read-only BuildKit caches", async (t) => {
    const commands = await fixtureImageCommands(t, "cache-progress", "gateway-routing", {
      GITHUB_ACTIONS: "true",
      OCC_CI_IMAGE_CACHE: "1",
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      NODE_BASE_IMAGE: nodeBaseImage,
      OPENAI_API_KEY: "synthetic-model-key",
      OCC_TEST_OPENAI_MODEL: "synthetic-model",
    });
    // Stop at image import after both real preparation build commands. This
    // proves cache selection, not Docker execution, cache hits, or model access.
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
    assertImageCacheObservations(prepared.stderr, "gateway-routing");
    const calls = await commands.commands();
    const builds = calls.filter(
      ({ command, args }) => command === "docker" && args[0] === "buildx" && args[1] === "build",
    );
    assert.match(prepared.stderr, /"stage":"controller-image-reuse","outcome":"absent"/);
    assert.match(prepared.stderr, /"stage":"runtime-image-reuse","outcome":"absent"/);
    for (const target of [true, false]) {
      const roleBuilds = builds.filter(({ args }) => args.includes("--target") === target);
      assert.equal(roleBuilds.length, 2, "probe and load each checkout image");
      assert.equal(roleBuilds.filter(({ args }) => args.includes("--load")).length, 1);
      assert.equal(
        roleBuilds.filter(({ args }) => args.includes("type=image,push=false,store=false")).length,
        1,
      );
    }
    for (const { args } of builds) {
      const role = args.includes("--target") ? "controller" : "runtime";
      assert.equal(
        args[args.indexOf("--cache-from") + 1],
        `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
      );
      assert.equal(args[args.indexOf("SOURCE_DATE_EPOCH=0") - 1], "--build-arg");
      assert.ok(args.includes("--progress=plain"));
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
  });

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
    assert.equal(builds[0].args.at(-1), source);
    assert.ok(builds[0].args.includes("--progress=plain"));
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

  // Only external commands are substituted: the preparation CLI owns child deadlines,
  // cleanup inventory, and publication. These cases do not exercise Docker or Kubernetes.
  const fixtureImageStages = ["fixture-engine-version", "fixture-image-build"];
  for (const stage of fixtureImageStages) {
    test(`fixture preparation bounds ${stage} before publishing test inputs`, async (t) => {
      const version = stage === "fixture-engine-version";
      const buildBudgetMs = 8_000;
      const reserveMs = 2_000;
      const lane = "k3d-fixture-network";
      const commands = await fixtureImageCommands(t, "success", lane, {
        OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: version ? "3000" : "30000",
        OPENCLAW_CI_COMMAND_KILL_GRACE_MS: version ? "3000" : "100",
        OPENCLAW_CI_IMAGE_BUILD_TEST_RESERVE_MS: String(reserveMs),
        // Invalid deadlines still need a finite engine-probe limit.
        ...(version ? { CI_RUNNER_DEADLINE_MS: "invalid" } : {}),
      });
      const pidFile = join(dirname(commands.statePath), "fixture-command-pids");
      const privateUrl = syntheticCredentialUrl({
        username: "fixture-user",
        password: "fixture-password",
        host: "example.test",
      });
      // Only Docker's step identity is public; command arguments and arbitrary
      // container output can contain credentials and terminal control sequences.
      const buildTail = `#9 [9/9] RUN partial line\n#1 [1/4] FROM ${privateUrl}\r\n#1 DONE 0.1s\r\n#2 [2/4] RUN fetch ${privateUrl}\n#2 0.1 progress\r#2 DONE\n#2 0.1 private build output\n#3 [3/4] COPY \u001b[31mprivate terminal text\n`;
      // Clipping lands inside the first line, immediately before a valid-looking
      // step prefix. Neither that fragment nor the control-bearing step is evidence.
      const buildOutput = `prefix${buildTail}${"x".repeat(32_768 - buildTail.length)}`;

      await interceptFixtureDocker(t, commands, (args) => {
        const selected = version
          ? args.join(" ") === "version --format {{.Server.Version}}"
          : args[0] === "build" && args.at(-1).endsWith("/tests/fixtures/kubernetes");
        if (selected) {
          // PostgreSQL shares the version probe. Its unmodified caller finishes
          // normally; no arrival-order assumption selects the fixture's child.
          const original = join(dirname(commands.statePath), "bin", "docker.mjs.original");
          if (version) {
            // Allow command-server startup on busy runners without booting another
            // Node process just to record the probe. The real CLI still kills the
            // fixture probe before this delay ends; PostgreSQL completes normally.
            return (
              `printf '%s\\n' "$$" >> ${bashString(pidFile)}; ` +
              `printf '%s\\n' 'private build output' >&2; ` +
              `"$__sleep" 6; exec ${bashString(original)} ${args.map(bashString).join(" ")}`
            );
          }
          const program = `
            const { appendFileSync } = require("node:fs");
            const { spawn, spawnSync } = require("node:child_process");
            appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
            process.stderr.write("private build output\\n");
            process.stderr.write(${JSON.stringify(buildOutput)});
            const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
              require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
              process.on("SIGTERM", () => {});
              setTimeout(() => {}, 30_000);
            `)}], { stdio: "ignore" });
            setTimeout(() => {
              descendant.kill("SIGKILL");
              process.exit(spawnSync(${JSON.stringify(original)}, ${JSON.stringify(args)}, { stdio: "inherit" }).status);
            }, 10000);
          `;
          return `exec ${bashString(process.execPath)} -e ${bashString(program)}`;
        }
        if (
          !version &&
          args.slice(0, 3).join(" ") === "image rm -f" &&
          args[3].endsWith("/fixture:local")
        ) {
          // A timed-out build need not have created its planned local image.
          return "exit 0";
        }
        return undefined;
      });
      // Start the build budget at CLI launch, after synthetic shim setup.
      const result = version
        ? await commands.prepare()
        : await commands.prepare([], {
            env: { CI_RUNNER_DEADLINE_MS: String(Date.now() + buildBudgetMs) },
          });
      assert.equal(
        result.error,
        undefined,
        "the outer test watchdog must not enforce the deadline",
      );
      assert.equal(result.status, 1, "fixture preparation must fail");
      const pidText = await readFile(pidFile, "utf8").catch((error) => {
        if (version || error.code !== "ENOENT") {
          throw error;
        }
        const lines = result.stderr.split("\n");
        const refused = fixtureImageStages.find((candidate) =>
          lines.includes(
            `Fixture image preparation ${candidate} was not started: the lane keeps ` +
              `${reserveMs} ms before its deadline for remaining preparation and tests.`,
          ),
        );
        if (refused) {
          assert.fail(`missing build PID witness: ${refused} refused the remaining lane budget`);
        }
        let metrics;
        try {
          metrics = fixturePreparationMetrics(result.stderr, lane);
        } catch {
          assert.fail("missing build PID witness: invalid CI preparation metric");
        }
        const failedAttempt = metrics.findLast(
          (metric) =>
            metric.status === "failed" &&
            (fixtureImageStages.includes(metric.stage) || metric.stage === "k3d-create"),
        );
        assert.fail(
          failedAttempt
            ? `missing build PID witness: ${failedAttempt.stage} reported a failed attempt`
            : "missing build PID witness: prepare stage unknown",
        );
      });
      const pids = pidText.trim().split("\n").map(Number);
      t.after(() => {
        for (const pid of pids) {
          if (processRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      });
      assert.equal(pids.length, 2);
      // The build child has redirected pipes and ignores TERM. Its leader exits
      // first, so only a preserved group escalation can stop it before cleanup.
      for (const pid of pids) {
        assert.equal(processRunning(pid), false, `fixture command process ${pid} must stop`);
      }
      const timeout = result.stderr.match(
        new RegExp(`Fixture image preparation ${stage} timed out after ([0-9]+) ms`),
      );
      assert.ok(timeout, "expected fixture command timeout");
      if (!version) {
        const timeoutMs = Number(timeout[1]);
        assert.ok(
          timeoutMs > 0 && timeoutMs <= buildBudgetMs - reserveMs,
          "reported build timeout must leave the reserve for remaining preparation and tests",
        );
      }
      const metrics = fixturePreparationMetrics(result.stderr, lane);
      assert.ok(
        metrics.some((metric) => metric.stage === stage && metric.status === "started"),
        "expected fixture command start",
      );
      const failed = metrics.find((metric) => metric.stage === stage && metric.status === "failed");
      assert.ok(failed, "expected fixture command failure");
      if (version) {
        const { elapsedMs } = failed;
        // A prompt child exit releases its supervisor; do not wait on a stale
        // group number until the three-second escalation grace expires.
        // Two seconds of scheduling margin still excludes deadline + full grace.
        assert.ok(elapsedMs < 5000, `prompt timeout settlement took ${elapsedMs} ms`);
      }
      if (!version) {
        assert.ok(
          /Fixture image build steps \(captured tail\): #1 \[1\/4\] FROM DONE; #2 \[2\/4\] RUN$/m.test(
            result.stderr,
          ),
          "expected sanitized build steps",
        );
      }
      assert.ok(!result.stderr.includes(privateUrl));
      assert.ok(
        !/fixture-password|private terminal text/.test(result.stderr),
        "build progress must omit private text",
      );
      assert.ok(!result.stderr.includes("\u001b"));
      assert.ok(
        !result.stderr.includes("private build output"),
        "build progress must omit raw output",
      );
      const state = await commands.readState();
      const image = state.resources.find(({ kind }) => kind === "image-tag");
      if (version) {
        assert.equal(image, undefined);
      } else {
        assert.equal(image.status, "planned");
      }
      assert.equal(state.env, undefined);
      assert.ok(!state.resources.some(({ kind }) => kind === "k3d-image"));
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
      await assert.rejects(stat(commands.statePath), { code: "ENOENT" });
    });
  }

  test(
    "fixture preparation cancellation stops SIGINT-ignoring build descendants",
    {
      skip: process.platform === "win32" && "POSIX process-group cancellation",
    },
    async (t) => {
      let cli;
      let preparation;
      let pidFile;
      // Register before fixture cleanup so even the broken supervisor's leaked
      // processes are stopped while their ownership record is still available.
      t.after(async () => {
        const pids = pidFile ? JSON.parse(await readFile(pidFile, "utf8").catch(() => "[]")) : [];
        for (const pid of pids) {
          if (processRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        if (cli?.exitCode === null && cli.signalCode === null) {
          cli.kill("SIGKILL");
        }
        if (preparation) {
          await within(preparation, "cancelled preparation teardown", 5000);
        }
        await waitUntil(
          "cancelled test processes to stop",
          () => pids.every((pid) => !processRunning(pid)),
          1000,
        );
      });
      const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network");
      pidFile = join(dirname(commands.statePath), "cancelled-build-pids");
      // Cancellation can arrive after the real helper registers the cluster but
      // before the external create is accepted. Hold that boundary deterministically.
      let createStarted = false;
      const k3d = join(dirname(commands.statePath), "bin", "k3d.mjs");
      const originalK3d = `${k3d}.original`;
      await rename(k3d, originalK3d);
      const clusterServer = await startCommandServer({
        forwardedEnv: [],
        handle: ({ args, io }) => {
          if (args[0] === "cluster" && args[1] === "create") {
            createStarted = true;
            io.exitAfter(124, 60000);
          } else {
            io.script(`exec ${bashString(originalK3d)} ${args.map(bashString).join(" ")}`);
          }
        },
      });
      t.after(() => clusterServer.close());
      await writeFixtureCommand(k3d, "k3d", clusterServer);
      await interceptFixtureDocker(t, commands, (args) => {
        if (args[0] === "build" && args.at(-1).endsWith("/tests/fixtures/kubernetes")) {
          const descendant = `
          process.on("SIGINT", () => {});
          const fs = require("node:fs");
          fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, JSON.stringify([process.ppid, process.pid]));
          fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
          setTimeout(() => {}, 60000);
        `;
          const program = `
          require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
        `;
          return `exec ${bashString(process.execPath)} -e ${bashString(program)}`;
        }
        if (args.slice(0, 3).join(" ") === "image rm -f" && args[3].endsWith("/fixture:local")) {
          return "exit 0";
        }
        return undefined;
      });
      preparation = commands.prepare([], {
        onSpawn: (child) => {
          cli = child;
        },
      });
      const pids = await waitFor(
        "cluster create and build descendant signal handler",
        async () => {
          if (!createStarted) {
            return undefined;
          }
          const text = await readFile(pidFile, "utf8").catch(() => undefined);
          return text === undefined ? undefined : JSON.parse(text);
        },
        30000,
      );
      assert.equal(pids.length, 2);
      assert.ok(pids.every(processRunning));
      cli.kill("SIGINT");
      const result = await within(preparation, "SIGINT preparation cancellation", 5000);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, "SIGINT");
      // The public cancellation, not fixture cleanup or self-expiry, must stop
      // even a descendant that ignores INT and retains the command's pipes.
      await waitUntil(
        "cancelled build processes to stop",
        () => pids.every((pid) => !processRunning(pid)),
        1000,
      );
      const state = await commands.readState();
      assert.equal(state.env, undefined);
      assert.equal(state.resources.find(({ kind }) => kind === "image-tag").status, "planned");
      assert.equal(state.resources.find(({ kind }) => kind === "k3d-cluster").status, "planned");
      assert.ok(
        !(await commands.commands()).some(
          ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
        ),
      );
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
    },
  );

  test("fixture preparation refuses an exhausted image budget before probing Docker", async (t) => {
    const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network", {
      CI_RUNNER_DEADLINE_MS: String(Date.now()),
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1, result.stderr);
    assertStderrMatch(
      result.stderr,
      /Fixture image preparation fixture-engine-version was not started: the lane keeps 180000 ms/,
    );
    assert.doesNotMatch(result.stderr + result.stdout, /did not finish building|20 min|cache miss/);
    const state = await commands.readState();
    assert.ok(!state.resources.some(({ kind }) => kind === "image-tag"));
    assert.equal(state.env, undefined);
    // The only version probe belongs to concurrent PostgreSQL preparation.
    assert.equal(
      (await commands.commands()).filter(
        ({ command, args }) => command === "docker" && args[0] === "version",
      ).length,
      1,
    );
    await commands.cleanupSuccessfully();
  });

  for (const timeout of ["Infinity", "2147483648"]) {
    test(`fixture preparation rejects unsupported command timeout ${timeout}`, async (t) => {
      const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network", {
        OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: timeout,
        CI_RUNNER_DEADLINE_MS: "invalid",
      });
      const result = await commands.prepare();
      assert.equal(result.status, 1, result.stderr);
      assertStderrMatch(
        result.stderr,
        /fixture-engine-version requires a valid finite command timeout/,
      );
      const state = await commands.readState();
      assert.ok(!state.resources.some(({ kind }) => kind === "image-tag"));
      assert.equal(state.env, undefined);
      // Concurrent PostgreSQL still owns its existing version probe.
      assert.equal(
        (await commands.commands()).filter(
          ({ command, args }) => command === "docker" && args[0] === "version",
        ).length,
        1,
      );
      await commands.cleanupSuccessfully();
    });
  }

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
    // Docker runs the verified host config, while Kubernetes uses its imported manifest.
    assert.equal(state.env.OCC_DOCKER_RUNTIME_IMAGE, `sha256:${"b".repeat(64)}`);
    assert.match(state.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE, /^localhost\/.+@sha256:/);
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

  test("fixture preparation rejects an unknown proxy source before publishing its environment", async (t) => {
    const commands = await fixtureImageCommands(t, "missing-proxy-source");
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /Unable to determine the cross-node plugin status proxy source/,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    // Failed preparation retains ownership so cleanup can remove the partial cluster.
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
  });

  test("fixture preparation retries a failed worker Pod CIDR read and waits for assignment", async (t) => {
    const commands = await fixtureImageCommands(t, "late-pod-cidr");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    const calls = await commands.commands();
    const reads = calls.filter(
      ({ command, args }) =>
        command === "kubectl" &&
        args.slice(4, 6).join(" ") === "get node" &&
        args[6].endsWith("-agent-0") &&
        args.slice(7).join(" ") === "-o json",
    );
    // A refused read, a Ready node without a Pod CIDR, then the assigned CIDR.
    assert.equal(reads.length, 3);
    for (let index = 1; index < reads.length; index += 1) {
      const gap = reads[index].at - reads[index - 1].at;
      assert.ok(gap >= 245, `read ${index + 1} started ${gap} ms after the one before it`);
    }
    assertStderrMatch(result.stderr, /waiting for k3d-\S+-agent-0 to get its Pod CIDR/);
    // The wait is announced once, not on every read.
    assert.equal(result.stderr.match(/to get its Pod CIDR/g)?.length, 1);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation names the worker that never gets a Pod CIDR", async (t) => {
    const commands = await fixtureImageCommands(t, "no-pod-cidr", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "1000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(result.stderr, /k3d node k3d-\S+-agent-0 got no Pod CIDR within 1000 ms\./);
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await commands.cleanupSuccessfully();
  });

  // The deadline error names the last read's outcome: a refused read followed by reads that
  // answer without a Pod CIDR reports the missing CIDR, not the earlier refusal (finding 1699).
  // The wait only has to outlast one refused read (it fails only if that fake kubectl read takes
  // 2 s or more), so no read count or pacing is asserted.
  test("fixture preparation reports the last Pod CIDR read, not an earlier refusal", async (t) => {
    const commands = await fixtureImageCommands(t, "refused-then-no-pod-cidr", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "2000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(result.stderr, /k3d node k3d-\S+-agent-0 got no Pod CIDR within 2000 ms\./);
    assert.doesNotMatch(result.stderr, /synthetic node read refusal/);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation bounds a hung Pod CIDR read and reports its failure", async (t) => {
    // A wait shorter than the one-second read floor makes the first hung read decisive.
    const commands = await fixtureImageCommands(t, "hung-pod-cidr-read", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "100",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /Unable to read k3d node k3d-\S+-agent-0 within 100 ms: .*timed out after 1000ms/,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await commands.cleanupSuccessfully();
  });

  for (const { scenario, stage, error } of [
    {
      scenario: "nodes-unready",
      stage: "k3d-nodes-ready",
      error: /synthetic node readiness timeout$/,
    },
    {
      scenario: "nodes-unready-diagnostics-failed",
      stage: "k3d-nodes-ready",
      error: /synthetic node readiness timeout$/,
    },
    {
      scenario: "cluster-create-failed",
      stage: "k3d-create",
      error: /synthetic cluster creation failure$/,
    },
  ]) {
    test(`fixture preparation preserves bootstrap failure with bounded diagnostics: ${scenario}`, async (t) => {
      // The hung events read waits out the diagnostic command timeout (5 s here; 10 s by default).
      const commands = await fixtureImageCommands(
        t,
        scenario,
        undefined,
        scenario === "nodes-unready-diagnostics-failed"
          ? { OPENCLAW_CI_K3D_DIAGNOSTICS_TIMEOUT_MS: "5000" }
          : {},
      );
      const result = await commands.prepare();
      assert.equal(result.error, undefined, "diagnostics must finish within the CLI watchdog");
      assert.equal(result.status, 1);
      assert.match(result.stderr.trim().split("\n").at(-1), error);

      const failedTiming = fixturePreparationMetrics(result.stderr).find(
        (metric) => metric.stage === stage && metric.status === "failed",
      );
      assert.ok(failedTiming, "the bootstrap failure must retain its measured stage");
      assert.ok(Number.isFinite(failedTiming.elapsedMs) && failedTiming.elapsedMs >= 0);

      const artifactPath = `${commands.statePath}.diagnostics.json`;
      const artifactText = await readFile(artifactPath, "utf8");
      const evidence = JSON.parse(artifactText);
      assert.equal(evidence.lane, "k3d-fixture-configuration");
      assert.equal(evidence.nodeImage, defaultK3sImage);
      if (scenario === "cluster-create-failed") {
        // Container diagnostics remain available before a kubeconfig can be written.
        for (const field of ["nodes", "pods", "events"]) {
          assert.equal(evidence[field].status, "unavailable");
        }
      } else {
        assert.equal(evidence.nodes.status, "ok");
        assert.match(JSON.stringify(evidence.nodes.value), /KubeletNotReady/);
      }
      assert.equal(evidence.containers.length, 2);
      for (const container of evidence.containers) {
        assert.equal(container.state.status, "ok");
        assert.equal(container.logs.status, "ok");
        assert.match(
          container.logs.value,
          /network plugin is not ready\n.*Error updating node status/s,
        );
        assert.doesNotMatch(container.logs.value, /localhost:8080 was refused/);
        assert.match(
          container.logs.value,
          /omitted 150 kubectl retry lines against localhost:8080/,
        );
      }
      assert.doesNotMatch(artifactText, /do-not-publish/);
      assert.doesNotMatch(result.stderr, /do-not-publish/);
      if (scenario === "nodes-unready-diagnostics-failed") {
        assert.equal(evidence.pods.status, "unavailable");
        assert.equal(evidence.events.status, "timed-out");
      } else if (scenario === "nodes-unready") {
        assert.equal(evidence.pods.status, "ok");
        assert.match(JSON.stringify(evidence.pods.value), /Unschedulable/);
        assert.equal(evidence.events.status, "ok");
        assert.match(JSON.stringify(evidence.events.value), /FailedScheduling/);
      }

      // Failure must retain owned cleanup state without admitting workload execution.
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.equal(evidence.cluster, cluster.name);
      assert.equal(cluster.status, "planned");
      assert.equal(state.env, undefined);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
      await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
      await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
      assert.equal(await readFile(artifactPath, "utf8"), artifactText);
    });
  }

  // Linux reports an exited but unreaped process as a zombie; it holds nothing.
  function processRunning(pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return true;
    }
  }

  async function hungK3dProcesses(commands) {
    const text = await readFile(join(dirname(commands.statePath), "hung-pids"), "utf8");
    return text.trim().split("\n").map(Number);
  }

  test("staged sign-in preparation retains unacknowledged creation without rollback or retry", async (t) => {
    // Exercise the real staging producer and an actual timed-out child. The
    // command server models external k3d/Docker responses, not live resources.
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-once", "staging-signin", {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepareStagingSignin();
    assert.equal(result.error, undefined, "the producer must settle before the test watchdog");
    assert.equal(result.status, 1, "an unacknowledged creation cannot be retried as successful");
    assertStderrMatch(result.stderr, /unconfirmed creation.*reconciliation/u);
    const calls = await commands.commands();
    const creates = calls.filter(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
    );
    assert.equal(creates.length, 1);
    assert.ok(
      creates[0].args.includes("--no-rollback"),
      "k3d itself must preserve unacknowledged resources",
    );
    assert.ok(
      !calls.some(
        ({ command, args }) =>
          (command === "k3d" && args[0] === "cluster" && args[1] === "delete") ||
          (command === "docker" && args.includes("rm")),
      ),
      "no deletion authority exists before a receipt",
    );
    const state = await commands.readState();
    const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].status, "planned");
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `local child ${pid} must have settled`);
    }
    // The fixture directory is removed by its own hook; no modeled resource
    // deletion is invoked and this test does not establish daemon settlement.
  });

  test("k3d preparation times out a hung cluster create, discards it and retries once", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-once", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "5000",
    });
    const result = await commands.prepare();
    assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
    assert.equal(result.status, 0, result.stderr);
    assertStderrMatch(
      result.stderr,
      /k3d cluster create openclaw-k8s-\S+ did not finish within 5000 ms \(attempt 1 of 2\)/,
    );
    const stages = fixturePreparationMetrics(result.stderr)
      .filter(({ stage, status }) => stage.startsWith("k3d-create") && status !== "started")
      .map(({ stage, status }) => `${stage}:${status}`);
    assert.deepEqual(stages, [
      "k3d-create:failed",
      "k3d-create-discard:passed",
      "k3d-create:passed",
    ]);
    // k3d's own progress reaches the job log as it happens, without colour codes.
    assertStderrMatch(
      result.stderr,
      /^\[prepare:\S+\] k3d: INFO\[0002\] Starting node 'k3d-openclaw-k8s-\S+-server-0'$/m,
    );
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
    }

    // The retry reuses the owned name, deleting the first attempt before creating again.
    const k3d = (await commands.commands())
      .filter(({ command, args }) => command === "k3d" && args[0] === "cluster")
      .map(({ args }) => args.slice(0, 2).join(" "));
    const firstCreate = k3d.indexOf("cluster create");
    const secondCreate = k3d.indexOf("cluster create", firstCreate + 1);
    assert.ok(secondCreate > firstCreate);
    assert.ok(k3d.slice(firstCreate, secondCreate).includes("cluster delete"));
    const evidence = JSON.parse(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
    assert.match(evidence.failure, /\(attempt 1 of 2\)$/);
    // The step k3d stopped in, and a server that runs only k3d's retry loop.
    assert.match(
      evidence.k3dCreateOutput,
      /^INFO\[0002\] Starting node 'k3d-openclaw-k8s-\S+-server-0'$/,
    );
    assert.match(evidence.containers[0].processes.value, /kubectl uncordon/);

    const state = await commands.readState();
    const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].status, "ready");
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
  });

  test("k3d preparation stops waiting for create output held outside its process group", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-escaped", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "4000",
      OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "1000",
    });
    // Read before the fixture's own after hook removes the directory: hooks run in order.
    const escapedPids = join(dirname(commands.statePath), "escaped-pids");
    let escaped = "";
    t.after(() => {
      for (const pid of escaped.split("\n").map(Number)) {
        if (!Number.isInteger(pid) || pid <= 0) {
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    const result = await commands.prepare();
    escaped = await readFile(escapedPids, "utf8").catch(() => "");
    assert.equal(result.error, undefined, "held output must not reach the CLI watchdog");
    assert.equal(result.status, 0, result.stderr);
    const timings = fixturePreparationMetrics(result.stderr).filter(
      ({ stage, status }) => stage.startsWith("k3d-create") && status !== "started",
    );
    assert.deepEqual(
      timings.map(({ stage, status }) => `${stage}:${status}`),
      ["k3d-create:failed", "k3d-create-discard:passed", "k3d-create:passed"],
    );
    // SIGTERM is ignored: SIGKILL follows after the 1 s grace. Killing the
    // supervisor closes its output even while an escaped child holds its input.
    assert.ok(
      timings[0].elapsedMs >= 5_000,
      `first attempt ended after ${timings[0].elapsedMs} ms`,
    );
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
    }
    await commands.cleanupSuccessfully();
  });

  test("k3d preparation fails clearly when every cluster create attempt hangs", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
    assert.equal(result.status, 1);
    assert.match(
      result.stderr.trim().split("\n").at(-1),
      /^k3d cluster create openclaw-k8s-\S+ did not finish within 3000 ms \(attempt 2 of 2\); giving up\./,
    );
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
    }
    const creates = (await commands.commands()).filter(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
    );
    assert.equal(creates.length, 2);
    const evidence = JSON.parse(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
    assert.match(evidence.failure, /\(attempt 2 of 2\)$/);
    assert.equal(evidence.containers.length, 2);

    // The partial cluster stays registered for cleanup; nothing is published.
    const state = await commands.readState();
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.equal(cluster.status, "planned");
    assert.equal(state.env, undefined);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
  });

  test("k3d node log excerpts stay bounded and keep the start, later errors and the end", () => {
    const at = (second) => new Date(Date.UTC(2026, 8, 23, 0, 0, second)).toISOString();
    const info = (second) =>
      `${at(second)} I0923 kubelet.go:1] "fixture progress ${second}" ${"x".repeat(200)}`;
    const stdout = [
      // An output cap can start a stream mid-line, past the keyword of a credential.
      "=do-not-publish-cut-credential more",
      `${at(0)} level=info msg="Starting k3s agent fixture"`,
      ...Array.from({ length: 4_000 }, (_, second) => info(second + 1)),
      `${at(4_001)} level=info msg="fixture end of log"`,
    ].join("\n");
    const stderr = [
      `${at(2_000)} E0923 kubelet_node_status.go:1] "Error updating node status" err="fixture lease"`,
      `${at(2_001)} level=error msg="fixture join token=do-not-publish-node-token"`,
      // The credential keyword sits past the 1000-character line cut.
      `${at(2_001)} level=warning msg="do-not-publish-long-line ${"y".repeat(1_100)} password=hidden"`,
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `${at(2_002 + index)} The connection to the server localhost:8080 was refused`,
      ),
    ].join("\n");
    const excerpt = nodeLogExcerpt(stdout, stderr);
    assert.ok(excerpt.length < 42_000, `excerpt has ${excerpt.length} characters`);
    assert.match(excerpt, /^\[diagnostics dropped 1 unstamped line fragments\]\n/);
    assert.match(excerpt, /\n\[diagnostics omitted 500 kubectl retry lines against localhost:8080/);
    assert.match(excerpt, /Starting k3s agent fixture/);
    assert.match(excerpt, /Error updating node status/);
    assert.match(excerpt, /\[redacted credential-bearing line\]/);
    assert.match(excerpt, /fixture end of log"$/);
    assert.match(excerpt, /\[diagnostics omitted \d+ lines; 3 of 3 error and warning lines/);
    assert.doesNotMatch(excerpt, /do-not-publish|localhost:8080 was refused/);
  });

  test("k3d node log excerpts keep a K3s exit that the entrypoint's API retries follow", () => {
    const at = (second) => new Date(Date.UTC(2026, 9, 12, 22, 56, second)).toISOString();
    const discovery = (second, detail) =>
      `${at(second)} E1012 22:56:00.000000 ${second} memcache.go:265] "Unhandled Error" ` +
      `err="couldn't get current server API group list: ${detail}"`;
    const refused = (second, server) =>
      Array.from({ length: 4 }, () =>
        discovery(
          second,
          `Get \\"${server}/api?timeout=32s\\": dial tcp: connect: connection refused`,
        ),
      ).concat(
        `${at(second)} The connection to the server ${server.replace(/^https?:\/\//, "")} was refused - did you specify the right host or port?`,
      );
    const stdout = [
      `${at(0)} level=info msg="Starting k3s v1.35.9+k3s1"`,
      ...refused(0, "http://localhost:8080"),
      discovery(1, "the server is currently unable to handle the request"),
      `${at(1)} Error from server (ServiceUnavailable): the server is currently unable to handle the request`,
      // Newer kubectl appends a logger field after the error.
      `${at(1)} E1012 22:56:01.000000 1 memcache.go:265] "Unhandled Error" err="couldn't get current server ` +
        `API group list: Get \\"https://127.0.0.1:6443/api?timeout=32s\\": net/http: TLS handshake timeout" ` +
        `logger="UnhandledError"`,
      `${at(1)} Unable to connect to the server: net/http: TLS handshake timeout`,
      // K3s's own lines stay, whatever they say.
      `${at(2)} level=error msg="fixture K3s line: couldn't get current server API group list: kept"`,
      `${at(2)} level=fatal msg="fixture K3s exit cause"`,
      // The finding 1174 node logged API retries for five minutes after K3s exited.
      ...Array.from({ length: 400 }, (_, retry) =>
        refused(5 + retry * 3, "https://127.0.0.1:6443"),
      ).flat(),
    ].join("\n");
    const excerpt = nodeLogExcerpt(stdout, "");
    assert.match(
      excerpt,
      /msg="fixture K3s line: couldn't get current server API group list: kept"\n.*msg="fixture K3s exit cause"$/,
    );
    assert.match(
      excerpt,
      new RegExp(
        [
          `^\\[diagnostics omitted 5 kubectl retry lines against localhost:8080 \\(connection refused\\), ${at(0)} to ${at(0)}\\]`,
          `\\[diagnostics omitted 2 kubectl retry lines against the API server \\(ServiceUnavailable\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 1 kubectl retry lines against 127\\.0\\.0\\.1:6443 \\(TLS handshake timeout\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 1 kubectl retry lines against the API server \\(TLS handshake timeout\\), ${at(1)} to ${at(1)}\\]`,
          `\\[diagnostics omitted 2000 kubectl retry lines against 127\\.0\\.0\\.1:6443 \\(connection refused\\), ${at(5)} to ${at(1202)}\\]\n`,
        ].join("\n"),
      ),
    );
    assert.doesNotMatch(
      excerpt,
      /memcache|was refused|Error from server|Unable to connect|logger=/,
    );
  });

  for (const scenario of ["storage-unready", "storage-after-image-unready"]) {
    test(`fixture preparation reports unavailable storage without publishing workload inputs: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const result = await commands.prepare();
      assert.equal(result.status, 1);
      assertStderrMatch(result.stderr, /CI fixture storage controller is not ready/);
      assertStderrMatch(result.stderr, /CrashLoopBackOff/);
      assertStderrMatch(result.stderr, /fixture configuration rejected/);
      assertStderrMatch(result.stderr, /Unschedulable/);
      assertStderrMatch(result.stderr, /KubeletHasDiskPressure/);
      assert.doesNotMatch(result.stderr, /do-not-publish-pod-spec/);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      const state = await commands.readState();
      assert.equal(state.env, undefined);
      if (scenario === "storage-unready") {
        // The initial rollout failed. Preparation settles the concurrent import for
        // cleanup. It must not declare the cluster ready, pin the image or restart storage.
        const resource = (kind) => state.resources.find((entry) => entry.kind === kind);
        assert.equal(resource("k3d-image")?.status, "ready");
        assert.equal(resource("k3d-cluster").status, "planned");
        const calls = await commands.commands();
        assert.ok(!calls.some(({ args }) => args.includes("restart") || args.includes("apply")));
        const diagnostics = JSON.parse(
          await readFile(`${commands.statePath}.diagnostics.json`, "utf8"),
        );
        assert.equal(diagnostics.lane, state.lane);
      }
      await commands.cleanupSuccessfully();
    });
  }

  for (const [scenario, fault] of [
    ["storage-unready", "host inspection"],
    ["success", "host inspection"],
    ["success", "missing manifest"],
  ]) {
    test(`fixture image diagnostics for ${fault} with ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const detail = "synthetic host inspection detail";
      let faults = 0;
      await interceptFixtureDocker(t, commands, (args) => {
        if (
          fault === "host inspection" &&
          args.length === 3 &&
          args[0] === "image" &&
          args[1] === "inspect"
        ) {
          faults += 1;
          return `printf '%s\\n' ${bashString(detail)} >&2; exit 1`;
        }
        // Both nodes received the stream, but the server cannot find its manifest.
        if (
          fault === "missing manifest" &&
          args[0] === "exec" &&
          args.slice(2).join(" ") === "ctr -n k8s.io images list"
        ) {
          faults += 1;
          return "exit 0";
        }
      });
      const result = await commands.prepare();
      assert.equal(result.status, 1);
      assert.equal(faults, 1);
      const storageFailed = scenario === "storage-unready";
      const primary = result.stderr.trimEnd().split("\n").at(-1);
      if (storageFailed) {
        assert.match(primary, /CI fixture storage controller is not ready/);
        assert.ok(!result.stderr.includes(detail));
      } else if (fault === "host inspection") {
        assert.ok(primary.includes(detail));
      } else {
        assert.match(primary, /Unable to find imported OCI manifest digest/);
      }
      const diagnostic = await readFile(`${commands.statePath}.diagnostics.json`, "utf8");
      assert.equal(
        JSON.parse(diagnostic).failure,
        "Fixture image preparation failed during fixture-image-import.",
      );
      assert.ok(!diagnostic.includes(detail));
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.equal(cluster.status, storageFailed ? "planned" : "ready");
      assert.equal(state.env, undefined);
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      const calls = await commands.commands();
      const imports = calls.filter(({ args }) => args[0] === "exec" && args[1] === "-i");
      assert.equal(imports.length, fault === "missing manifest" ? 2 : 0);
      assert.ok(!calls.some(({ args }) => args.includes("apply") || args.includes("restart")));
      await commands.cleanupSuccessfully();
    });
  }

  test("k3d preparation reuses only matching local immutable images and verifies fresh pulls", async (t) => {
    await eachSettled(
      [
        "local-digest",
        "image-absent",
        "podman-image-absent",
        "image-absent-late-stderr",
        "local-mismatch",
        "pull-mismatch",
        "inspect-failed",
      ],
      async (scenario) => {
        const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
          NODE_BASE_IMAGE: nodeBaseImage,
          // Supply the controller artifact so this case isolates image import, not its build.
          OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
          OPENAI_API_KEY: "test-only-key",
          OCC_TEST_OPENAI_MODEL: "test-model",
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
          // Stop at the next independent preparation boundary after image import.
          OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
        });
        const result = await commands.prepare();
        assert.equal(result.status, 1);
        const calls = await commands.commands();
        const pulls = calls.filter(
          ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
        );
        assert.equal(
          pulls.length,
          ["local-digest", "inspect-failed"].includes(scenario) ? 0 : 1,
          scenario,
        );
        const state = await commands.readState();
        const imported = state.resources.filter(({ kind }) => kind === "k3d-image");
        if (scenario === "pull-mismatch") {
          assertStderrMatch(
            result.stderr,
            /pull did not materialize the requested registry digest/,
          );
          assert.equal(imported.length, 0);
        } else if (scenario === "inspect-failed") {
          assertStderrMatch(result.stderr, /Cannot connect to the Docker daemon/);
          assert.equal(imported.length, 0);
        } else {
          assertStderrMatch(result.stderr, /limited to reviewed Codex versions/);
          assert.equal(imported.length, 1);
          assert.equal(imported[0].status, "ready");
          assert.equal(imported[0].sourceImage, immutableImage);
          assert.equal(imported[0].hostImageId, `sha256:${"b".repeat(64)}`);
        }
        await commands.cleanupSuccessfully();
        assert.ok(
          !(await commands.commands()).some(
            ({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(immutableImage),
          ),
          "cleanup must preserve the caller's immutable source image",
        );
      },
    );
  });

  test("k3d preparation times out a hung host image command and never pulls for it", async (t) => {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imported = String.raw`localhost/\S+`;
    await eachSettled(
      [
        [
          "hung-host-digests",
          escape(`image inspect --format {{json .RepoDigests}} ${immutableImage}`),
        ],
        ["hung-host-id", escape(`image inspect --format {{.Id}} ${immutableImage}`)],
        ["hung-host-tag", `${escape(`tag ${immutableImage} `)}${imported}`],
        [
          "hung-host-platform",
          `${escape("image inspect --format {{.Os}}/{{.Architecture}} ")}${imported}`,
        ],
      ],
      async ([scenario, shown]) => {
        const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
          NODE_BASE_IMAGE: nodeBaseImage,
          OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
          OPENAI_API_KEY: "test-only-key",
          OCC_TEST_OPENAI_MODEL: "test-model",
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
          OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
          OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
        });
        const result = await commands.prepare();
        assert.equal(result.status, 1, scenario);
        assertStderrMatch(
          result.stderr,
          new RegExp(String.raw`The container engine did not answer within 3000 ms \(${shown}\)\.`),
          scenario,
        );
        // A timeout is not an absent image: nothing pulls, and nothing reaches the cluster.
        const calls = await commands.commands();
        assert.equal(
          calls.filter(
            ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
          ).length,
          0,
          scenario,
        );
        assert.equal(
          calls.some(({ args }) => args[0] === "exec" && args[1] === "-i"),
          false,
          scenario,
        );
        const state = await commands.readState();
        assert.equal(
          state.resources.some(({ kind, status }) => kind === "k3d-image" && status === "ready"),
          false,
          scenario,
        );
        await commands.cleanupSuccessfully();
      },
    );
  });

  test("fixture preparation times out a hung inspect of its own fixture image", async (t) => {
    const commands = await fixtureImageCommands(t, "hung-host-owned", undefined, {
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /The container engine did not answer within 3000 ms \(image inspect localhost\/\S+\/fixture:local\)\./,
    );
    await commands.cleanupSuccessfully();
  });

  test("ordinary k3d preparation forwards an immutable K3s override and retains the server version gate", async (t) => {
    const image = `registry.example/k3s:v1.35.8-k3s1@sha256:${digest}`;
    await eachSettled(["success", "wrong-server-version"], async (scenario) => {
      const commands = await fixtureImageCommands(t, scenario, "k3d-fixture-configuration", {
        OPENCLAW_CI_K3S_IMAGE: image,
      });
      const result = await commands.prepare();
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.equal(cluster.nodeImage, image);
      if (scenario === "success") {
        assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
      } else {
        assertStderrMatch(result.stderr, /must resolve to Kubernetes 1\.35\.x/);
        // The fixture build overlaps cluster creation; nothing reaches the cluster.
        assert.equal(
          (await commands.commands()).some(({ args }) => args[0] === "exec" && args[1] === "-i"),
          false,
        );
        assert.equal(
          state.resources.some(({ kind }) => kind === "k3d-image"),
          false,
        );
        assert.equal(state.env, undefined);
      }
      await commands.cleanupSuccessfully();
    });
  });

  // K3s installs the Gateway API CRDs with Traefik, and routing waits up to 180 s for each one.
  // A lane added to lanesWithoutK3sAddons that also sets up routing must fail at once instead.
  test("gateway routing refuses a cluster created without K3s's Traefik before any side effect", async (t) => {
    const commands = await fixtureImageCommands(t, "success", "k3d-fixture-configuration");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    const state = await commands.readState();
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.deepEqual(cluster.disabledK3sAddons, ["traefik", "servicelb", "metrics-server"]);
    await assert.rejects(
      prepareGatewayRouting({
        cluster,
        execFile: () => assert.fail("routing ran a command against a cluster without Traefik"),
      }),
      { message: /Gateway routing needs K3s's Traefik add-on/ },
    );
    await assert.rejects(stat(join(cluster.directory, "gateway-routing")), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation waits for a late worker and its containerd before importing", async (t) => {
    const commands = await fixtureImageCommands(t, "late-worker");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 is not answering yet \(attempt 2\)/,
    );
    const calls = await commands.commands();
    const index = (predicate) => calls.findIndex(predicate);
    const lastIndex = (predicate) => calls.findLastIndex(predicate);
    const listings = calls.filter(({ args }) => args.slice(-4).join(" ") === "get nodes -o name");
    // A refused listing, the server alone, then both nodes.
    assert.equal(listings.length, 3);
    // The Ready wait starts only once the worker is registered.
    assert.ok(
      lastIndex(({ args }) => args.slice(-4).join(" ") === "get nodes -o name") <
        index(({ args }) => args.includes("--for=condition=Ready")),
    );
    // The worker import starts only after its containerd answers.
    const agentProbe = lastIndex(
      ({ args }) => args[0] === "exec" && args[1].endsWith("-agent-0") && args.at(-1) === "version",
    );
    const agentImport = index(
      ({ args }) => args[0] === "exec" && args[1] === "-i" && args[2].endsWith("-agent-0"),
    );
    assert.ok(agentProbe >= 0 && agentImport > agentProbe);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation names the node whose containerd never answers and imports nothing", async (t) => {
    const commands = await fixtureImageCommands(t, "containerd-down", undefined, {
      OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS: "2000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 did not answer within 2000 ms: .*connect: connection refused/,
    );
    assert.equal(
      (await commands.commands()).some(({ args }) => args[0] === "exec" && args[1] === "-i"),
      false,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    // The failure keeps node diagnostics for the outage.
    const evidence = JSON.parse(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
    assert.match(
      evidence.failure,
      /image import into k3d nodes failed: containerd on k3d-\S+-agent-0 did not answer/,
    );
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation drains the active sibling probe before collecting diagnostics", async (t) => {
    const commands = await fixtureImageCommands(t, "success", undefined, {
      OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS: "1",
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const pidFile = join(dirname(commands.statePath), "server-probe.pid");
    const pidPath = bashString(pidFile);
    const probes = [];
    const siblingAliveAtDiagnostics = [];
    await interceptFixtureDocker(t, commands, async (args) => {
      if (args[0] === "exec" && args.slice(2).join(" ") === "ctr -n k8s.io version") {
        probes.push(args[1]);
        if (args[1].endsWith("-server-0")) {
          // This probe outlives the worker's refusal and ends at the command timeout.
          return `printf '%s\\n' "$$" > ${pidPath}; exec "$__sleep" 120`;
        }
        return (
          `while [[ ! -s ${pidPath} ]]; do "$__sleep" 0.01; done; ` +
          `read -r pid < ${pidPath}; kill -0 "$pid" || exit 2; ` +
          "echo 'first probe refusal' >&2; exit 1"
        );
      }
      if (args[0] === "inspect" && args[2] === "{{json .State}}") {
        siblingAliveAtDiagnostics.push(processRunning(Number(await readFile(pidFile, "utf8"))));
      }
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr.trimEnd().split("\n").at(-1),
      /containerd on \S+-agent-0.*first probe refusal/,
    );
    assert.equal(probes.length, 2);
    assert.equal(new Set(probes).size, 2);
    assert.deepEqual(siblingAliveAtDiagnostics, [false, false]);
    assert.equal((await commands.readState()).env, undefined);
    await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation fails on a hung containerd probe without polling again", async (t) => {
    const commands = await fixtureImageCommands(t, "hung-containerd-probe", undefined, {
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 did not answer within 3000 ms \(ctr -n k8s\.io version\)\./,
    );
    const calls = await commands.commands();
    const probes = (suffix) =>
      calls.filter(
        ({ args }) => args[0] === "exec" && args[1].endsWith(suffix) && args.at(-1) === "version",
      ).length;
    assert.equal(probes("-agent-0"), 1);
    // The refusing server stops polling once the hang fails the wait, well before its own
    // 60 s deadline (about 30 probes).
    assert.ok(probes("-server-0") <= 10, `${probes("-server-0")} server probes`);
    assert.equal(
      calls.some(({ args }) => args[0] === "exec" && args[1] === "-i"),
      false,
    );
    await commands.cleanupSuccessfully();
  });

  // Only the node's own containerd socket (refused or missing) gets the one retry.
  for (const { scenario, retried, imported, error } of [
    { scenario: "containerd-restart", retried: true, imported: true },
    { scenario: "containerd-socket-missing", retried: true, imported: true },
    {
      scenario: "containerd-refuses-imports",
      retried: true,
      error: /containerd\.sock: connect: connection refused/,
    },
    {
      scenario: "other-socket-refused",
      retried: false,
      error: /\/run\/other\.sock: connect: connection refused/,
    },
  ]) {
    test(`fixture preparation retries an import once only for the node socket: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const result = await commands.prepare();
      assert.equal(result.status, imported ? 0 : 1, result.stderr);
      assert.equal(
        /containerd refused the image import; waiting for it/.test(result.stderr),
        retried,
      );
      const calls = await commands.commands();
      const agentImports = calls.flatMap(({ args }, index) =>
        args[0] === "exec" && args[1] === "-i" && args[2].endsWith("-agent-0") ? [index] : [],
      );
      assert.equal(agentImports.length, retried ? 2 : 1);
      if (retried) {
        // The retry waits for the worker's containerd to answer again.
        assert.ok(
          calls
            .slice(agentImports[0], agentImports[1])
            .some(
              ({ args }) =>
                args[0] === "exec" && args[1].endsWith("-agent-0") && args.at(-1) === "version",
            ),
          "a containerd probe precedes the second import",
        );
      }
      if (imported) {
        // A recovered import writes no failure diagnostics.
        await assert.rejects(() => stat(`${commands.statePath}.diagnostics.json`), {
          code: "ENOENT",
        });
      } else {
        assertStderrMatch(result.stderr, error);
        const evidence = JSON.parse(
          await readFile(`${commands.statePath}.diagnostics.json`, "utf8"),
        );
        assert.match(evidence.failure, /image import into k3d nodes failed/);
      }
      await commands.cleanupSuccessfully();
    });
  }
});

test("node log excerpts retain sub-millisecond order across Docker streams", () => {
  const stdout = [
    "2026-10-21T00:00:00.123900000Z later stdout",
    "2026-10-21T00:00:00.123100002Z second nanosecond",
    "2026-10-21T00:00:01.000000001Z after whole second",
    "2026-10-21T00:00:02.1Z tied stdout",
  ].join("\n");
  const stderr = [
    "2026-10-21T00:00:00.123100000Z earlier stderr",
    "2026-10-21T00:00:00.123100001Z first nanosecond",
    "2026-10-21T00:00:01Z whole second",
    "2026-10-21T00:00:02.100000000Z tied stderr",
  ].join("\n");
  assert.deepEqual(nodeLogExcerpt(stdout, stderr).split("\n"), [
    "2026-10-21T00:00:00.123100000Z earlier stderr",
    "2026-10-21T00:00:00.123100001Z first nanosecond",
    "2026-10-21T00:00:00.123100002Z second nanosecond",
    "2026-10-21T00:00:00.123900000Z later stdout",
    "2026-10-21T00:00:01Z whole second",
    "2026-10-21T00:00:01.000000001Z after whole second",
    "2026-10-21T00:00:02.1Z tied stdout",
    "2026-10-21T00:00:02.100000000Z tied stderr",
  ]);
});

test("node log retry summaries retain the latest kinds within one millisecond", () => {
  const retries = Array.from(
    { length: 13 },
    (_, index) =>
      `2026-10-21T00:00:00.123${String(index + 1).padStart(6, "0")}Z The connection to the server 127.0.0.1:${2000 + index} was refused`,
  );
  const excerpt = nodeLogExcerpt(retries.join("\n"), "");
  assert.doesNotMatch(excerpt, /against 127\.0\.0\.1:2000 /u);
  assert.match(excerpt, /against 127\.0\.0\.1:2012 /u);
  assert.match(excerpt, /omitted 1 earlier kinds of kubectl retry lines/u);
});

test("node log retry summaries omit credential-bearing endpoints", () => {
  const endpoint = syntheticCredentialUrl({
    username: "fixture-user",
    password: "fixture-value",
    host: "diagnostic.example.test",
  });
  // Retry summaries may echo the endpoint and error detail into the published report.
  const stdout = `2026-10-21T00:00:00Z The connection to the server ${endpoint} was refused`;
  const stderr = `2026-10-21T00:00:01Z Unable to connect to the server: Get ${endpoint}`;
  assert.equal(
    nodeLogExcerpt(stdout, stderr),
    "2026-10-21T00:00:00Z [redacted credential-bearing line]\n" +
      "2026-10-21T00:00:01Z [redacted credential-bearing line]",
  );
});

test("node log chronology and retry retention do not depend on the process locale", () => {
  const moduleUrl = new URL("../../scripts/ci/k3d-diagnostics.mjs", import.meta.url).href;
  const script = `
    import { nodeLogExcerpt } from ${JSON.stringify(moduleUrl)};
    const early = "2026-10-21T00:00:00.020000000Z early stderr";
    const later = "2026-10-21T00:00:00.100000000Z later stdout";
    const tied = "2026-10-21T00:00:00.1Z tied stderr";
    const retries = ["020000000", "100000000", ...Array.from({ length: 11 }, (_, i) => String(i + 20) + "0000000")]
      .map((fraction, i) => "2026-10-21T00:00:00." + fraction + "Z The connection to the server 127.0.0.1:" + (2000 + i) + " was refused");
    console.log(JSON.stringify({
      numeric: new Intl.Collator().resolvedOptions().numeric,
      events: nodeLogExcerpt(later, early + "\\n" + tied).split("\\n"),
      retries: nodeLogExcerpt(retries.join("\\n"), ""),
    }));
  `;
  for (const [locale, numeric] of [
    ["en-US", false],
    ["en-US-u-kn-true", true],
  ]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.numeric, numeric, locale);
    assert.deepEqual(
      result.events,
      [
        "2026-10-21T00:00:00.020000000Z early stderr",
        "2026-10-21T00:00:00.100000000Z later stdout",
        "2026-10-21T00:00:00.1Z tied stderr",
      ],
      locale,
    );
    assert.doesNotMatch(result.retries, /against 127\.0\.0\.1:2000 /u, locale);
    assert.match(result.retries, /against 127\.0\.0\.1:2001 /u, locale);
    assert.match(result.retries, /omitted 1 earlier kinds of kubectl retry lines/u, locale);
  }
});

// Exercise the prepare-lane closure, importer journal and ordinary cleanup. Only
// unrelated installation/bootstrap dependencies are substituted; the real preload
// derives the native selection and calls the real registration closure twice.
test("Agent Sandbox preparation imports its native cache and verifies reuse", async (t) => {
  const repository = "registry.k8s.io/agent-sandbox/agent-sandbox-controller";
  const child = "sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6";
  const index = "sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403";
  const config = "sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17";
  const source = `${repository}:v0.5.2@${child}`;
  const cached = `${repository}:v0.5.2@${index}`;
  // Re-encode the independent pinned manifest to model transport changing its
  // digest without changing the selected native config.
  const content =
    JSON.stringify(
      JSON.parse(
        readFileSync(
          new URL("../fixtures/agent-sandbox-v0.5.2-amd64-manifest.json.txt", import.meta.url),
          "utf8",
        ),
      ),
    ) + "\n";
  const transport = "sha256:" + createHash("sha256").update(content).digest("hex");
  assert.notEqual(transport, child);
  for (const scenario of [
    "index-only",
    "config-id",
    "lost-descriptor",
    "falsy-descriptor",
    "inspect-error",
    "mixed-error",
    "reuse-config",
    "reuse-cri",
  ]) {
    await t.test(scenario, async (t) => {
      const commands = await fixtureImageCommands(t, "success", "openshell", {
        NODE_BASE_IMAGE: nodeBaseImage,
        CODEX_ACCESS_TOKEN: "synthetic-native-preparation-token",
        OPENAI_API_KEY: "synthetic-native-preparation-key",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
        OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      });
      const root = dirname(commands.statePath);
      const reused = join(root, "reuse");
      const body = join(root, "manifest.json");
      await writeFile(body, content);
      const calls = [];
      let tag;
      let reference;
      let removedHost = false;
      const removedNode = new Set();
      const held = {
        Id: index,
        RepoDigests: [`${repository}@${index}`],
        Os: "linux",
        Architecture: "amd64",
        Descriptor: { digest: index, mediaType: "application/vnd.oci.image.index.v1+json" },
      };
      const selected = {
        ...held,
        Id: child,
        Descriptor: {
          digest: child,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          platform: { os: "linux", architecture: "amd64" },
        },
      };
      if (scenario === "config-id") {
        held.Id = config;
        delete held.Descriptor;
      }
      if (scenario === "lost-descriptor") {
        selected.Id = config;
        delete selected.Descriptor;
      }
      if (scenario === "falsy-descriptor") {
        held.Id = config;
        held.Descriptor = false;
      }
      await interceptFixtureDocker(t, commands, async (args) => {
        calls.push(args);
        const output = (value) => `printf '%s\\n' ${bashString(JSON.stringify(value))}; exit 0`;
        if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === source) {
          const diagnostic =
            scenario === "inspect-error"
              ? "Cannot connect to the Docker daemon"
              : scenario === "mixed-error"
                ? `Cannot connect to the Docker daemon: No such image: ${source}`
                : `Error response from daemon: No such image: ${source}`;
          return `printf '%s\\n' ${bashString(diagnostic)} >&2; exit 1`;
        }
        if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === cached) {
          if (args.includes("--platform")) {
            assert.notEqual(
              scenario,
              "config-id",
              "verified single-native cache needs no optional platform inspect",
            );
            return output([selected]);
          }
          return output([held]);
        }
        if (args[0] === "pull" && args[1].startsWith(repository)) {
          return "echo offline-registry >&2; exit 61";
        }
        if (args[0] === "tag" && args[1].startsWith(repository)) {
          assert.equal(
            args[1],
            cached,
            "stage the locally available index, not its absent child alias",
          );
          tag = args[2];
          return "exit 0";
        }
        if (tag && args[0] === "image" && args[1] === "save" && args.at(-1) === tag) {
          assert.deepEqual(args, ["image", "save", "--platform", "linux/amd64", tag]);
          return "printf native-archive; exit 0";
        }
        if (tag && args[0] === "image" && args[1] === "rm" && args.at(-1) === tag) {
          removedHost = true;
          return "exit 0";
        }
        if (tag && args[0] === "exec") {
          if (args[1] === "-i") {
            return "/bin/cat >/dev/null; exit 0";
          }
          const operation = args.slice(2).join(" ");
          if (operation === "ctr -n k8s.io images list") {
            return `printf '%s\\n' ${bashString(`${tag} application/vnd.oci.image.manifest.v1+json ${transport} 1 linux/amd64 -`)} ${reference ? bashString(`${reference} application/vnd.oci.image.manifest.v1+json ${transport} 1 linux/amd64 -`) : ""}; exit 0`;
          }
          if (operation.startsWith("ctr -n k8s.io images tag ")) {
            reference = args.at(-1);
            return "exit 0";
          }
          if (operation.startsWith("ctr -n k8s.io images label ")) {
            return "exit 0";
          }
          if (operation.startsWith("ctr -n k8s.io images rm ")) {
            removedNode.add(args.at(-1));
            return "exit 0";
          }
          if (operation === `ctr -n k8s.io content get ${transport}`) {
            const present = await stat(reused).then(
              () => true,
              () => false,
            );
            return present && scenario === "reuse-config"
              ? 'printf \'{"config":{"digest":"wrong"}}\'; exit 0'
              : `/bin/cat ${bashString(body)}; exit 0`;
          }
          if (operation === `crictl inspecti ${reference}`) {
            const present = await stat(reused).then(
              () => true,
              () => false,
            );
            return output({
              status: {
                id: present && scenario === "reuse-cri" ? `sha256:${"f".repeat(64)}` : config,
                repoDigests: [reference],
                pinned: true,
              },
            });
          }
        }
        return undefined;
      });
      const helper = join(root, "native-preparation.mjs");
      await writeFile(
        helper,
        `
import { mock } from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as openshell from ${JSON.stringify(new URL("../../scripts/ci/openshell.ts", import.meta.url).href)};
import * as routing from ${JSON.stringify(new URL("../../scripts/ci/routing.ts", import.meta.url).href)};
import { preloadAgentSandboxController } from ${JSON.stringify(new URL("../../scripts/ci/agent-sandbox.ts", import.meta.url).href)};
mock.module(${JSON.stringify(new URL("../../scripts/ci/routing.ts", import.meta.url).href)}, { exports: { ...routing, prepareGatewayRouting: async () => ({ env: {} }) } });
mock.module(${JSON.stringify(new URL("../../scripts/ci/openshell.ts", import.meta.url).href)}, { exports: {
  ...openshell,
  prepareOpenShellClusterBootstrap: async () => ({ k3sImage: ${JSON.stringify(defaultK3sImage)}, kubectl: process.env.OCC_KUBECTL_BIN, runtimeClass: "openshell-sandbox", runtimeHandler: "runc" }),
  prepareOpenShellPodSecurityAdmission: async () => ({ k3dArgs: [] }),
  prepareOpenShell: async ({ cluster, registerImage }) => {
    const nodes = { items: cluster.nodes.map(name => ({ metadata: { name }, status: { nodeInfo: { operatingSystem: "linux", architecture: "amd64" } } })) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const directory = join(cluster.directory, "preload-" + attempt);
      await mkdir(directory);
      const manifest = join(directory, "sandbox.yaml");
      await writeFile(manifest, "      - name: agent-sandbox-controller\\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\\n");
      const result = await preloadAgentSandboxController(manifest, nodes, registerImage);
      await writeFile(${JSON.stringify(join(root, "result-"))} + attempt, await readFile(result));
      await writeFile(${JSON.stringify(reused)}, "reuse");
    }
    throw new Error("native-registration-complete");
  }
} });
const { prepareLane } = await import(${JSON.stringify(new URL("../../scripts/ci/prepare.mjs", import.meta.url).href)});
try { await prepareLane({ lane: "openshell", statePath: ${JSON.stringify(commands.statePath)} }); }
catch (error) { console.error(error); process.exitCode = 1; }
`,
      );
      const result = await commands.runShell(
        `node --experimental-test-module-mocks ${bashString(helper)}`,
      );
      assert.equal(result.status, 1, result.stderr);
      const state = await commands.readState();
      const imported = state.resources.filter(
        (resource) =>
          resource.kind === "k3d-image" && resource.envName === "Agent Sandbox controller",
      );
      if (["inspect-error", "mixed-error"].includes(scenario)) {
        assertStderrMatch(result.stderr, /Cannot connect to the Docker daemon/, scenario);
        assert.equal(imported.length, 0);
        assert.equal(tag, undefined);
      } else if (["lost-descriptor", "falsy-descriptor"].includes(scenario)) {
        assertStderrMatch(
          result.stderr,
          /(?:lost its descriptor|invalid local image descriptor)/,
          scenario,
        );
        assert.equal(imported.length, 0);
        assert.equal(tag, undefined);
      } else {
        assertStderrMatch(
          result.stderr,
          scenario === "reuse-config"
            ? /imported manifest does not match/
            : scenario === "reuse-cri"
              ? /imported CRI image does not match/
              : /native-registration-complete/,
          scenario,
        );
        assert.equal(imported.length, 1);
        assert.equal(imported[0].status, "ready");
        assert.equal(imported[0].sourceImage, source);
        assert.equal(imported[0].acquisitionReference, cached);
        assert.equal(imported[0].hostImageId, held.Id);
        assert.equal(imported[0].reference, reference);
        assert.equal(reference, tag.replace(/:local$/, "") + "@" + transport);
        assert.deepEqual(imported[0].nativeSelection, {
          platform: "linux/amd64",
          configDigest: config,
          cacheIndex: cached,
        });
        assert.equal(calls.filter((args) => args[0] === "tag" && args[1] === cached).length, 1);
        assert.equal(
          calls.filter(
            (args) => args[0] === "image" && args[1] === "inspect" && args.at(-1) === source,
          ).length,
          1,
          "reuse must not reacquire the source",
        );
        assert.match(await readFile(join(root, "result-0"), "utf8"), /imagePullPolicy: Never/);
      }
      assert.equal(
        calls.filter((args) => args[0] === "pull" && args[1].startsWith(repository)).length,
        0,
      );
      await commands.cleanupSuccessfully();
      if (tag) {
        assert.equal(removedHost, true);
        assert.ok(removedNode.has(reference));
      }
      assert.ok(
        !calls.some(
          (args) =>
            args[0] === "image" && args[1] === "rm" && [source, cached].includes(args.at(-1)),
        ),
      );
    });
  }
});
