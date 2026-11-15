import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  assertStderrMatch,
  fixtureImageCommands,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function object(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, `${label} must be an object`);
  return record;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  return value;
}

function json(text: string): unknown {
  return JSON.parse(text);
}

const packaging = object(
  json(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/images-packaging.json"), "utf8"),
  ),
  "images-packaging",
);
const packagingEnv = object(object(packaging.prepare, "prepare").defaultEnv, "prepare.defaultEnv");
const packagingNodeBaseImage = string(packagingEnv.NODE_BASE_IMAGE, "NODE_BASE_IMAGE");

function isYamlLoader(value: unknown): value is (source: string) => unknown {
  return typeof value === "function";
}

async function readWarmWorkflow() {
  const client: unknown = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const { loadYaml } = object(client, "@kubernetes/client-node");
  assert.ok(isYamlLoader(loadYaml), "Kubernetes YAML loader is missing");
  const workflow = loadYaml(
    await readFile(join(repositoryRoot, ".github/workflows/ci-image-cache.yml"), "utf8"),
  );
  return object(workflow, "CI image cache workflow");
}

type DockerfileStage = {
  name: string | undefined;
  text: string;
  needs: string[];
};

const concurrency = Math.min(4, 2 * availableParallelism());

describe("CI preparation", { concurrency }, () => {
  // A hosted image lane's cache inputs; the token must reach no build argument or output.
  const imageCacheEnv = {
    GITHUB_ACTIONS: "true",
    OCC_CI_IMAGE_CACHE: "1",
    ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
    ACTIONS_RESULTS_URL: "https://cache.example.test/",
  };

  test("image cache preparation refuses missing credentials and unmapped lanes before building", async (t) => {
    for (const [lane, env] of [
      // A cache lane without its runtime token.
      ["images-packaging", { ...imageCacheEnv, ACTIONS_RUNTIME_TOKEN: "" }],
      // A lane outside the cache map, even with credentials.
      [
        "docker-model",
        {
          ...imageCacheEnv,
          OPENAI_API_KEY: "synthetic-model-key",
          OCC_TEST_OPENAI_MODEL: "gpt-synthetic",
          NODE_BASE_IMAGE: packagingNodeBaseImage,
        },
      ],
    ] as const) {
      const commands = await fixtureImageCommands(t, "success", lane, env);
      const prepared = await commands.prepare();
      assert.notEqual(prepared.status, 0, lane);
      assert.match(prepared.stderr, /Image caching requires the hosted image lane/, lane);
      const calls = await commands.commands();
      assert.equal(
        calls.some(({ args }) => args[0] === "buildx" || args[0] === "build"),
        false,
        lane,
      );
      assert.doesNotMatch(prepared.stdout + prepared.stderr, /synthetic-cache-credential/, lane);
      // Cleanup is not run: the refused build's planned tag stays owned, and this
      // shim cannot remove images. The fixture directory is removed with the test.
    }
  });

  // Only main's warm job exports: a lane export on main could land after a newer
  // commit's warm export and replace main's cache with older layers.
  test("image-building lanes restore read-only caches, on main pushes too", async (t) => {
    const source = object(
      json(await readFile(join(repositoryRoot, "deploy/runtime/openclaw-source.json"), "utf8")),
      "OpenClaw source pin",
    );
    const commit = string(source.commit, "source commit");
    const archiveSha256 = string(source.sourceArchiveSha256, "source archive SHA-256");
    const buildTimestamp = string(source.buildTimestamp, "source build timestamp");
    for (const [lane, event, scenario] of [
      ...["pull_request", "merge_group", "workflow_dispatch", "push"].map(
        (event) => ["images-packaging", event, "success"] as const,
      ),
      ["k3d-otel", "push", "save-failed"] as const,
    ]) {
      const commands = await fixtureImageCommands(t, scenario, lane, {
        ...imageCacheEnv,
        GITHUB_EVENT_NAME: event,
        NODE_BASE_IMAGE: packagingNodeBaseImage,
        OPENAI_API_KEY: "synthetic-model-key",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
      });
      const prepared = await commands.prepare();
      if (lane === "k3d-otel") {
        // Stop at image export after both real preparation builds, before routing
        // downloads. This proves cache orchestration, not Docker or OTLP execution.
        assert.equal(prepared.status, 1, prepared.stderr);
        assert.match(prepared.stderr, /synthetic export failure/);
        await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      } else {
        assert.equal(prepared.status, 0, `${event}: ${prepared.stderr}`);
      }
      assert.equal(
        prepared.stderr
          .split("\n")
          .some((line) => line.startsWith("::notice title=k3d Model Runtime image::")),
        false,
      );
      const calls = (await commands.commands()).filter(({ args }) => args[0] === "buildx");
      const builds = calls.filter(({ args }) => args.includes("--load"));
      if (lane === "k3d-otel") {
        // Parse synthetic BuildKit output through the real preparation entrypoint;
        // this proves sanitized counters, not live cache hits.
        assert.ok(calls.every(({ args }) => args.includes("--progress=plain")));
        const prefix = `[prepare:${lane}] `;
        const records = prepared.stderr.split("\n").flatMap((line) => {
          if (!line.startsWith(prefix + "{")) {
            return [];
          }
          const record = object(json(line.slice(prefix.length)), "preparation log record");
          return record.stage === "image-cache" ? [record] : [];
        });
        const phases = records.map(
          ({ role, phase }) =>
            `${string(role, "image-cache role")}:${string(phase, "image-cache phase")}`,
        );
        assert.deepEqual(phases.sort(), [
          "controller:load",
          "controller:probe",
          "runtime:load",
          "runtime:probe",
        ]);
        assert.doesNotMatch(
          prepared.stdout + prepared.stderr,
          /private-step|synthetic-build-command|synthetic-sibling-command|synthetic-build-output/,
        );
      }
      assert.equal(builds.length, 2, event);
      // Each build first probes for an image the engine already holds.
      assert.equal(calls.length, 4, event);
      // A fixed epoch keeps independent builds of the same layers on one image ID;
      // the probe must resolve the same ID the build would load.
      for (const { args } of calls) {
        assert.equal(args[args.indexOf("SOURCE_DATE_EPOCH=0") - 1], "--build-arg", event);
        // The cache probe and final build must select the same upstream source;
        // the controller image has no OpenClaw source build.
        const sourceArguments = args.filter((arg) => /^OPENCLAW_/.test(arg));
        assert.deepEqual(
          sourceArguments,
          args.includes("--target")
            ? []
            : [
                `OPENCLAW_COMMIT=${commit}`,
                `OPENCLAW_SOURCE_SHA256=${archiveSha256}`,
                `OPENCLAW_BUILD_TIMESTAMP=${buildTimestamp}`,
              ],
          event,
        );
      }
      assert.match(prepared.stderr, /"stage":"controller-image-reuse","outcome":"absent"/, event);
      assert.match(prepared.stderr, /"stage":"runtime-image-reuse","outcome":"absent"/, event);
      for (const { args } of builds) {
        const role = args.includes("--target") ? "controller" : "runtime";
        const cache = `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
        assert.equal(args[args.indexOf("--cache-from") + 1], `${cache},timeout=60s`, event);
        assert.equal(args.includes("--cache-to"), false, event);
      }
      assert.doesNotMatch(
        JSON.stringify(calls) +
          (await readFile(commands.statePath, "utf8")) +
          (prepared.status === 0 ? await readFile(commands.githubEnv, "utf8") : "") +
          prepared.stdout +
          prepared.stderr,
        /synthetic-cache-credential/,
      );
      const cleaned = await commands.cleanup();
      assert.equal(cleaned.status, 0, `${event}: ${cleaned.stderr}`);
    }
  });

  test("installer preparation populates its builder even when the engine holds the images", async (t) => {
    for (const file of [undefined, "tests/integration/qa-matrix-real.test.mjs"]) {
      const commands = await fixtureImageCommands(t, "engine-holds-images", "qa-matrix", {
        ...imageCacheEnv,
        NODE_BASE_IMAGE: packagingNodeBaseImage,
        BUILDX_BUILDER: "owned-installer-builder",
      });
      // Full Integration selects the whole lane. It needs the same preparation as
      // a focused file while retaining whole-lane accounting and installer builds.
      const prepared = await commands.prepare(file ? ["--selected-file", file] : []);
      assert.equal(prepared.status, 0, prepared.stderr);
      const builds = (await commands.commands()).filter(({ args }) => args[0] === "buildx");
      // Tagging an engine image cannot supply this builder's layers. This proves
      // orchestration, not live cache availability or installation performance.
      assert.equal(builds.length, 2);
      assert.ok(
        builds.every(({ args }) => args.includes("--load") && args.includes("--cache-from")),
      );
      assert.ok(builds.every(({ args }) => !args.includes("--cache-to")));
      const state = await commands.readState();
      assert.equal(state.selectedFile, file, "selected installer file");
      assert.ok(state.env, "CI preparation did not publish the installer environment");
      assert.equal(state.env.BUILDX_BUILDER, "owned-installer-builder");
      assert.equal(state.env.SOURCE_DATE_EPOCH, "0");
      assert.equal(state.env.OCC_TEST_QA_RUNTIME_IMAGE, undefined);
      assert.doesNotMatch(JSON.stringify(state), /synthetic-cache-credential/);
    }
  });

  test("whole-lane source builds require their selected builder before setup", async (t) => {
    for (const [lane, view] of [
      ["qa-matrix", "default"],
      ["dev-up-k3d", "default"],
      ["openshell", "default"],
      ["openshell-policy", "full-integration"],
      ["openshell-installers", "full-integration"],
    ] as const) {
      const commands = await fixtureImageCommands(t, "engine-holds-images", lane, {
        ...imageCacheEnv,
        OCC_CI_SUITE_VIEW: view,
        NODE_BASE_IMAGE: packagingNodeBaseImage,
        CODEX_ACCESS_TOKEN: "synthetic-model-credential",
        OPENAI_API_KEY: "synthetic-model-credential",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
        // The hosted action must supply its builder for the full lane, even
        // though no individual test file was selected. Fail before tool calls.
        BUILDX_BUILDER: "",
        OCC_HELM_BIN: "/missing-helm-must-not-run",
      });
      const prepared = await commands.prepare();
      assert.equal(prepared.status, 1, lane);
      assertStderrMatch(
        prepared.stderr,
        /Installer image preparation requires its selected job builder/,
        lane,
      );
      const state = await commands.readState();
      assert.deepEqual(state.resources, []);
      await commands.cleanupSuccessfully();
    }
  });

  test("full OpenShell preparation reaches stack setup without a duplicate image warm-up", async (t) => {
    const commands = await fixtureImageCommands(t, "engine-holds-images", "openshell-policy", {
      ...imageCacheEnv,
      OCC_CI_SUITE_VIEW: "full-integration",
      NODE_BASE_IMAGE: packagingNodeBaseImage,
      CODEX_ACCESS_TOKEN: "synthetic-model-credential",
      OPENAI_API_KEY: "synthetic-model-credential",
      OCC_TEST_OPENAI_MODEL: "synthetic-model",
      BUILDX_BUILDER: "owned-installer-builder",
    });
    const root = dirname(commands.statePath);
    // Stop at the first shared-stack tool check. This exercises the valid-builder
    // path without downloading kubectl or simulating the OpenShell installation.
    await writeFile(
      join(root, "bin", "helm"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))}, JSON.stringify({ command: "helm", args: process.argv.slice(2) }) + "\\n");
process.exit(73);
`,
      { mode: 0o700 },
    );
    const prepared = await commands.prepare();
    assert.equal(prepared.status, 1);
    const calls = await commands.commands();
    assert.deepEqual(
      calls.filter(({ command }) => command === "helm").map(({ args }) => args),
      [["version", "--short"]],
    );
    // A separate installer warm-up would perform two Buildx builds here before
    // the shared stack builds the same images again.
    assert.equal(calls.filter(({ args }) => args[0] === "buildx").length, 0);
    assert.deepEqual((await commands.readState()).resources, []);
    await commands.cleanupSuccessfully();
  });

  test("image lanes tag the engine's copy when the restored cache resolves to an image it holds", async (t) => {
    const commands = await fixtureImageCommands(t, "engine-holds-images", "images-packaging", {
      ...imageCacheEnv,
      GITHUB_EVENT_NAME: "pull_request",
    });
    const prepared = await commands.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const calls = (await commands.commands()).filter(({ command }) => command === "docker");
    // Both images resolve from the cache without loading any layer.
    const builds = calls.filter(({ args }) => args[0] === "buildx");
    assert.equal(builds.length, 2);
    assert.ok(builds.every(({ args }) => args.includes("--output") && !args.includes("--load")));
    const tags = calls.filter(({ args }) => args[0] === "tag");
    assert.deepEqual(tags.map(({ args }) => args[1]).sort(), [
      "sha256:" + "d".repeat(64),
      "sha256:" + "e".repeat(64),
    ]);
    const state = await commands.readState();
    for (const { args } of tags) {
      const tag = string(args[2], "reused image tag");
      const tagged = state.resources.find(({ kind, name }) => kind === "image-tag" && name === tag);
      assert.equal(tagged?.status, "ready", tag);
    }
    // The log names each resolved image ID.
    assert.match(
      prepared.stderr,
      new RegExp(
        `"stage":"controller-image-reuse","outcome":"reused","image":"sha256:${"d".repeat(64)}"`,
      ),
    );
    assert.match(
      prepared.stderr,
      new RegExp(
        `"stage":"runtime-image-reuse","outcome":"reused","image":"sha256:${"e".repeat(64)}"`,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(calls) + prepared.stdout + prepared.stderr,
      /synthetic-cache-credential/,
    );
    await commands.cleanupSuccessfully();
  });

  for (const { scenario, outcome, env = {} } of [
    {
      scenario: "engine-holds-different",
      outcome: { controller: "different", runtime: "different" },
    },
    {
      scenario: "engine-bad-metadata",
      outcome: { controller: "probe-failed", runtime: "unresolved" },
    },
    {
      scenario: "engine-inspect-failed",
      outcome: { controller: "probe-failed", runtime: "probe-failed" },
    },
    {
      scenario: "engine-inspect-hung",
      outcome: { controller: "probe-failed", runtime: "probe-failed" },
      env: { OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000" },
    },
    {
      scenario: "engine-tag-failed",
      outcome: { controller: "probe-failed", runtime: "probe-failed" },
    },
    // The probe's temporary directory cannot be created.
    {
      scenario: "engine-holds-images",
      outcome: { controller: "probe-failed", runtime: "probe-failed" },
      env: { RUNNER_TEMP: "/nonexistent/oce-ci-prepare-runner-temp" },
    },
  ] satisfies {
    scenario: string;
    outcome: { controller: string; runtime: string };
    env?: NodeJS.ProcessEnv;
  }[]) {
    test(`image lanes build when the engine image probe cannot reuse: ${scenario} ${JSON.stringify(env)}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario, "images-packaging", {
        ...imageCacheEnv,
        GITHUB_EVENT_NAME: "pull_request",
        ...env,
      });
      const prepared = await commands.prepare();
      assert.equal(prepared.status, 0, prepared.stderr);
      const calls = (await commands.commands()).filter(({ command }) => command === "docker");
      // Both images build and load as if no probe had run.
      const builds = calls.filter(({ args }) => args[0] === "buildx" && args.includes("--load"));
      assert.equal(builds.length, 2);
      const state = await commands.readState();
      for (const { args } of builds) {
        const tag = string(args[args.indexOf("-t") + 1], "built image tag");
        const tagged = state.resources.find(
          ({ kind, name }) => kind === "image-tag" && name === tag,
        );
        assert.equal(tagged?.status, "ready", tag);
      }
      for (const [role, expected] of Object.entries(outcome)) {
        assert.match(
          prepared.stderr,
          new RegExp(`"stage":"${role}-image-reuse","outcome":"${expected}"`),
          role,
        );
      }
      // Only a probe that failed at the tag itself tried to tag.
      assert.equal(
        calls.filter(({ args }) => args[0] === "tag").length,
        scenario === "engine-tag-failed" ? 2 : 0,
      );
      if (env.RUNNER_TEMP !== undefined) {
        // No probe build ran without a metadata directory.
        assert.equal(
          calls.filter(({ args }) => args.includes("type=image,push=false,store=false")).length,
          0,
        );
      }
      await commands.cleanupSuccessfully();
    });
  }

  // Finding 2103: a cold image build probe ran to a fixed 20 min, the build after it took 4 more
  // and the tests got 40 s. In a lane with a deadline the build keeps the reserve for the tests
  // and otherwise stops preparation with a message saying why.
  for (const { scenario, aheadMs, probes, outcome } of [
    // The probe (a full build on a cache miss) outlasts the budget: no second build starts.
    { scenario: "image-probe-hung", aheadMs: 6_000, probes: 1, outcome: "out-of-time" },
    // The probe resolves an image the engine lacks, and the loading build outlasts the budget.
    { scenario: "image-build-hung", aheadMs: 10_000, probes: 1, outcome: "absent" },
    // Nothing is left of the budget when the build would start.
    { scenario: "image-out-of-time", aheadMs: 0, probes: 0, outcome: "out-of-time" },
  ] as const) {
    test(`image lanes stop when the image build runs out of the lane's time: ${scenario}`, async (t) => {
      const reserveMs = 2_000;
      const commands = await fixtureImageCommands(t, scenario, "images-runtime-startup-3", {
        ...imageCacheEnv,
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_IMAGE_BUILD_TEST_RESERVE_MS: String(reserveMs),
        OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "200",
        CI_RUNNER_DEADLINE_MS: String(Date.now() + reserveMs + aheadMs),
      });
      const started = performance.now();
      const prepared = await commands.prepare();
      assert.notEqual(prepared.status, 0, prepared.stderr);
      // Stopped by the budget, well before the hung command's own exit.
      assert.ok(performance.now() - started < 30_000);
      assertStderrMatch(
        prepared.stderr,
        /The runtime image did not finish building within this lane's time.*keeps 2 s before its deadline for the rest of preparation and its tests/,
      );
      assert.match(
        prepared.stdout,
        /^::error title=Image build out of lane time::The runtime image /m,
      );
      assertStderrMatch(
        prepared.stderr,
        new RegExp(`"stage":"runtime-image-reuse","outcome":"${outcome}"`),
      );
      // Finding 2710: the stopped build's last progress names the step it was on.
      const progress = {
        "image-probe-hung": "#12 [openclaw-build 5/9] RUN pnpm build",
        "image-build-hung": "#14 exporting to image",
        "image-out-of-time": undefined,
      }[scenario];
      if (progress) {
        assertStderrMatch(
          prepared.stderr,
          new RegExp(
            `\\[image-build\\] the runtime image build's last output:\\n${RegExp.escape(progress)}\\n`,
          ),
        );
      } else {
        assert.doesNotMatch(prepared.stderr, /\[image-build\]/);
      }
      const calls = (await commands.commands()).filter(({ command }) => command === "docker");
      const builds = calls.filter(({ args }) => args[0] === "buildx");
      assert.equal(
        builds.filter(({ args }) => args.includes("type=image,push=false,store=false")).length,
        probes,
      );
      assert.equal(
        builds.filter(({ args }) => args.includes("--load")).length,
        scenario === "image-build-hung" ? 1 : 0,
      );
      await commands.cleanupSuccessfully();
    });
  }

  const warmCacheEnv = {
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    ...imageCacheEnv,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "push",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };

  async function runWarmImageCache(
    t: TestContext,
    scenario: string,
    { env = {}, args = [] }: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
  ) {
    const commands = await fixtureImageCommands(t, scenario, "images-packaging", {
      ...warmCacheEnv,
      ...env,
    });
    return { commands, warmed: await commands.warmImageCache(args) };
  }

  test("the main image cache warm job builds the packaging images, then exports both caches", async (t) => {
    const { commands, warmed } = await runWarmImageCache(t, "success");
    assert.equal(warmed.status, 0, warmed.stderr);
    assert.match(
      warmed.stderr,
      /\[ci-timing\] lane=image-cache-warm phase=controller-runtime-image-build/,
    );
    // Each image's BuildKit output is printed under its own heading.
    assert.match(warmed.stderr, /^\[image-cache-warm\] controller build$/m);
    assert.match(warmed.stderr, /^\[image-cache-warm\] runtime build$/m);
    assert.match(warmed.stderr, /^\[image-cache-warm\] controller cache export$/m);
    assert.match(warmed.stderr, /^\[image-cache-warm\] runtime cache export$/m);
    const all = (await commands.commands()).filter(({ args }) => args[0] === "buildx");
    // The runtime image's OpenClaw build runs alone before that image's build, which
    // reuses it: on the warm runner it cannot fit beside the bridge tests.
    const stage = all.filter(({ args }) => args.includes("openclaw-build"));
    const buildx = all.filter((call) => !stage.includes(call));
    const builds = buildx.filter(({ args }) => args.includes("--load"));
    const exports = buildx.filter(({ args }) => !args.includes("--load"));
    assert.match(warmed.stderr, /^\[image-cache-warm\] runtime openclaw-build build$/m);
    const runtimeLoad = builds.find(({ args }) => !args.includes("--target"));
    const [sourceStage] = stage;
    assert.equal(stage.length, 1);
    assert.ok(sourceStage && runtimeLoad, "expected the source stage and runtime load");
    assert.ok(all.indexOf(sourceStage) < all.indexOf(runtimeLoad));
    const runtimeTagIndex = runtimeLoad.args.indexOf("-t");
    assert.deepEqual(sourceStage.args, [
      "buildx",
      "build",
      "--output",
      "type=cacheonly",
      "--target",
      "openclaw-build",
      ...runtimeLoad.args.slice(3, runtimeTagIndex),
      ...runtimeLoad.args.slice(runtimeTagIndex + 2),
    ]);
    assert.deepEqual(
      builds.map(({ args }) => (args.includes("--target") ? "controller" : "runtime")).sort(),
      ["controller", "runtime"],
    );
    assert.equal(exports.length, 2);
    for (const build of builds) {
      const { args } = build;
      const role = args.includes("--target") ? "controller" : "runtime";
      const cache = `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
      assert.deepEqual(args.slice(0, 3), ["buildx", "build", "--load"]);
      // The lane's restore keys, no export in the build that loads the image, and
      // plain progress so the log shows each step's cache result.
      assert.equal(args[args.indexOf("--cache-from") + 1], `${cache},timeout=60s`);
      assert.equal(args.includes("--cache-to"), false);
      assert.ok(args.includes("--progress=plain"));
      if (role === "controller") {
        assert.ok(args.includes(`NODE_BASE_IMAGE=${packagingNodeBaseImage}`));
      }
      // Each image's export repeats its build without loading or tagging, after it.
      const tag = args.indexOf("-t");
      const exported = exports.find(
        ({ args: other }) => other.includes("--target") === (role === "controller"),
      );
      assert.ok(exported, `missing ${role} cache export`);
      assert.deepEqual(exported.args, [
        "buildx",
        "build",
        "--output",
        "type=cacheonly",
        "--cache-to",
        `${cache},mode=max,timeout=10m`,
        ...args.slice(3, tag),
        ...args.slice(tag + 2),
      ]);
      assert.ok(buildx.indexOf(exported) > buildx.indexOf(build), role);
      assert.match(
        warmed.stderr,
        new RegExp(`"stage":"${role}-cache-export","outcome":"exported"`),
      );
    }
    assert.doesNotMatch(warmed.stdout, /::warning/);
    const state = await readFile(commands.statePath, "utf8");
    assert.equal(object(json(state), "warm preparation state").lane, "images-packaging");
    assert.doesNotMatch(
      JSON.stringify(buildx) + state + warmed.stdout + warmed.stderr,
      /synthetic-cache-credential/,
    );
    // The runtime image stays tagged under a local name that cleanup does not own and that
    // names its ID, so the runners' shared image cache keeps main's image for the image lanes.
    const kept = `localhost/openclaw-ci-main/runtime:${"b".repeat(12)}`;
    const calls = await commands.commands();
    const runtimeBuild = calls.findIndex(
      ({ args }) => args[0] === "buildx" && !args.includes("--target"),
    );
    const tagged = calls.findIndex(({ args }) => args[0] === "tag" && args[2] === kept);
    assert.ok(runtimeBuild >= 0 && tagged > runtimeBuild);
    const runtimeTag = string(calls[tagged]?.args[1], "runtime tag");
    assert.match(runtimeTag, /^localhost\/openclaw-ci-image-[a-z0-9-]+\/runtime:local$/);
    assert.match(
      warmed.stderr,
      new RegExp(`"stage":"runtime-image-kept","image":"sha256:${"b".repeat(64)}","tag":"${kept}"`),
    );
    assert.doesNotMatch(state, /openclaw-ci-main/);
    await commands.cleanupSuccessfully();
    const removed = (await commands.commands()).filter(
      ({ args }) => args[0] === "image" && args[1] === "rm",
    );
    const controllerBuild = builds.find(({ args }) => args.includes("--target"));
    const controllerTag = string(controllerBuild?.args.at(-2), "controller tag");
    assert.deepEqual(
      removed.map(({ args }) => args.at(-1)).sort(),
      [controllerTag, runtimeTag].sort(),
    );
  });

  test("the image cache warm job prints a failed build's output and fails", async (t) => {
    const { commands, warmed } = await runWarmImageCache(t, "controller-build-failed");
    assert.notEqual(warmed.status, 0);
    assert.match(
      warmed.stderr,
      /^\[image-cache-warm\] controller build\n#7 \[runtime 3\/9\] synthetic controller step$/m,
    );
    // A failed warm build keeps nothing.
    assert.equal((await commands.commands()).filter(({ args }) => args[0] === "tag").length, 0);
    assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/);
    await commands.cleanupSuccessfully();
  });

  // A stalled upload once outlived BuildKit's own timeout=10m by 7 minutes, until
  // the build's 20-minute limit failed the job after the image had built (finding 1219).
  for (const scenario of ["controller-cache-export-hung", "controller-cache-export-failed"]) {
    test(`a warm cache export that cannot finish only warns: ${scenario}`, async (t) => {
      const { commands, warmed } = await runWarmImageCache(t, scenario, {
        env: {
          OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS: "5000",
          OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "500",
        },
      });
      assert.equal(warmed.status, 0, warmed.stderr);
      const outcome = scenario.endsWith("-hung") ? "timed-out" : "failed";
      assert.match(
        warmed.stderr,
        new RegExp(`"stage":"controller-cache-export","outcome":"${outcome}"`),
      );
      assert.match(warmed.stderr, /"stage":"runtime-cache-export","outcome":"exported"/);
      assert.match(
        warmed.stdout,
        new RegExp(
          `^::warning title=Image cache export::The controller image built, but its cache export ${
            outcome === "timed-out" ? "did not finish within 5000 ms" : "failed"
          }; `,
          "m",
        ),
      );
      if (outcome === "failed") {
        assert.match(
          warmed.stderr,
          /^\[image-cache-warm\] controller cache export\n#52 exporting to GitHub Actions Cache$/m,
        );
      }
      // Both images stay built, and main's runtime image is still kept.
      const state = await commands.readState();
      const tags = state.resources.filter(({ kind }) => kind === "image-tag");
      assert.deepEqual(
        tags.map(({ status }) => status),
        ["ready", "ready"],
      );
      assert.match(warmed.stderr, /"stage":"runtime-image-kept"/);
      assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/);
      await commands.cleanupSuccessfully();
    });
  }

  for (const scenario of [
    "success",
    "controller-cache-export-failed",
    "controller-cache-export-hung",
  ]) {
    test(`required warm exports settle before admission and cleanup: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario, "images-packaging", {
        ...warmCacheEnv,
        OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS: "5000",
        OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "500",
      });
      const selectedBase = `docker.io/library/node:24-bookworm@sha256:${"a".repeat(64)}`;
      const warmed = await commands.warmImageCache([
        "--require-cache-export",
        "--node-base-image",
        selectedBase,
      ]);
      assert.equal(warmed.status === 0, scenario === "success", warmed.stderr);
      // Even a failed controller export settles its sibling before the owner returns.
      assert.match(warmed.stderr, /"stage":"runtime-cache-export","outcome":"exported"/);
      const calls = await commands.commands();
      const controller = calls.find(
        ({ args }) => args.includes("--load") && args.includes("runtime"),
      );
      assert.ok(controller, "missing controller load");
      assert.ok(controller.args.includes(`NODE_BASE_IMAGE=${selectedBase}`));
      if (scenario !== "success") {
        const outcome = scenario.endsWith("hung") ? "timed-out" : "failed";
        assert.match(
          warmed.stderr,
          new RegExp(`"stage":"controller-cache-export","outcome":"${outcome}"`),
        );
        assert.doesNotMatch(warmed.stderr, /"stage":"runtime-image-kept"/);
      }
      assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/);
      await commands.cleanupSuccessfully();
    });
  }

  test("the strict warmer shell validates before setup and refuses a failed runtime export", async (t) => {
    const workflow = await readWarmWorkflow();
    const warm = object(object(workflow.jobs, "jobs").warm, "jobs.warm");
    const steps = array(warm.steps, "jobs.warm.steps").map((step) => object(step, "warm step"));
    const validate = steps.find((step) => step.name === "Validate required cache input");
    const exportStep = steps.find((step) => step.id === "export");
    const cleanup = steps.find((step) => step.name === "Cleanup");
    assert.ok(validate && exportStep && cleanup, "missing warm workflow shell steps");
    const validationShell = string(validate.run, "validation shell");
    const exportShell = string(exportStep.run, "export shell");
    const cleanupShell = string(cleanup.run, "cleanup shell");
    const validateEnv = object(validate.env, "validation environment");
    const exportEnv = object(exportStep.env, "export environment");
    assert.equal(validate.if, "${{ inputs.require-export }}");
    assert.equal(
      string(validateEnv.CACHE_NODE_BASE_IMAGE, "validation Node base image input"),
      "${{ inputs.node-base-image }}",
    );
    assert.ok(
      steps.indexOf(validate) <
        steps.findIndex(
          ({ uses }) => typeof uses === "string" && uses.startsWith("docker/setup-buildx-action@"),
        ),
    );
    assert.equal(
      string(exportEnv.REQUIRE_CACHE_EXPORT, "required export input"),
      "${{ inputs.require-export }}",
    );
    assert.equal(
      string(exportEnv.CACHE_NODE_BASE_IMAGE, "export Node base image input"),
      "${{ inputs.node-base-image }}",
    );
    assert.equal(cleanup.if, "always()");
    const commands = await fixtureImageCommands(
      t,
      "runtime-cache-export-failed",
      "images-packaging",
      warmCacheEnv,
    );
    const root = dirname(commands.statePath);
    const output = join(root, "output");
    const selectedBase = `docker.io/library/node:24-bookworm@sha256:${"a".repeat(64)}`;
    const env = {
      REQUIRE_CACHE_EXPORT: "true",
      CACHE_NODE_BASE_IMAGE: selectedBase,
      GITHUB_SHA: "b".repeat(40),
      GITHUB_OUTPUT: output,
    };
    // Run the checked-in validation and export shell, not a reconstructed invocation.
    for (const invalid of ["", "node:24-bookworm", selectedBase.replace("node:24-", "node:22-")]) {
      const result = await commands.runShell(validationShell, {
        ...env,
        CACHE_NODE_BASE_IMAGE: invalid,
      });
      assert.notEqual(result.status, 0, result.stderr);
    }
    await assert.rejects(stat(join(root, "commands.jsonl")), { code: "ENOENT" });
    assert.equal((await commands.runShell(validationShell, env)).status, 0);
    const warmed = await commands.runShell(exportShell, env);
    assert.notEqual(warmed.status, 0, warmed.stderr);
    assert.match(warmed.stderr, /"stage":"runtime-cache-export","outcome":"failed"/);
    assert.match(warmed.stderr, /"stage":"controller-cache-export","outcome":"exported"/);
    await assert.rejects(stat(output), { code: "ENOENT" });
    const calls = await commands.commands();
    assert.equal(
      calls.some(({ args }) => args[0] === "tag"),
      false,
    );
    const state = object(
      json(await readFile(join(root, "state/image-cache-warm.json"), "utf8")),
      "workflow warm preparation state",
    );
    const ownedTags = array(state.resources, "warm preparation resources")
      .map((resource) => object(resource, "warm preparation resource"))
      .filter(({ kind }) => kind === "image-tag")
      .map(({ name }) => string(name, "owned image tag"))
      .sort();
    assert.equal(ownedTags.length, 2);
    const cleaned = await commands.runShell(cleanupShell, env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const removed = (await commands.commands())
      .filter(({ args }) => args[0] === "image" && args[1] === "rm")
      .map(({ args }) => args.at(-1))
      .sort();
    assert.deepEqual(removed, ownedTags);
    assert.doesNotMatch(
      warmed.stdout + warmed.stderr + cleaned.stdout + cleaned.stderr,
      /synthetic-cache-credential/,
    );
  });

  // The schedule retries a store commit that lost to other jobs' commits (finding 1340).
  test("a scheduled run on main warms the image cache and keeps main's runtime image", async (t) => {
    const { commands, warmed } = await runWarmImageCache(t, "success", {
      env: { GITHUB_EVENT_NAME: "schedule" },
    });
    assert.equal(warmed.status, 0, warmed.stderr);
    assert.match(warmed.stderr, /"stage":"runtime-image-kept"/);
    await commands.cleanupSuccessfully();
  });

  test("the image cache warm job refuses refs other than main and lane arguments before building", async (t) => {
    for (const [label, env, args, error] of [
      [
        "pull request",
        { GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" },
        [],
        /Only a push, schedule or dispatch on main may warm the image cache/,
      ],
      [
        "branch dispatch",
        { GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_NAME: "workflow_dispatch" },
        [],
        /Only a push, schedule or dispatch on main may warm the image cache/,
      ],
      [
        "branch schedule",
        { GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_NAME: "schedule" },
        [],
        /Only a push, schedule or dispatch on main may warm the image cache/,
      ],
      [
        "merge queue on main",
        { GITHUB_EVENT_NAME: "merge_group" },
        [],
        /Only a push, schedule or dispatch on main may warm the image cache/,
      ],
      [
        "required export without protected base",
        {},
        ["--require-cache-export"],
        /NODE_BASE_IMAGE must be an immutable/,
      ],
      [
        "required export outside canonical repository",
        { GITHUB_REPOSITORY: "other/repository" },
        ["--require-cache-export", "--node-base-image", packagingNodeBaseImage],
        /Required cache exports run only in the canonical repository/,
      ],
      [
        "required export with mutable base",
        {},
        ["--require-cache-export", "--node-base-image", "node:24-bookworm"],
        /NODE_BASE_IMAGE must be an immutable/,
      ],
      ["Boolean value", {}, ["--require-cache-export", "true"], /Unexpected argument: true/],
      ["false value", {}, ["--require-cache-export", "false"], /Unexpected argument: false/],
      ["equals value", {}, ["--require-cache-export=true"], /takes no value/],
      ["selected file", {}, ["--selected-file", "anything"], /cannot be combined/],
      ["empty selected file", {}, ["--selected-file", ""], /cannot be combined/],
      [
        "lane argument",
        {},
        ["--lane", "images-packaging"],
        /--warm-image-cache cannot be combined with lane, file, selected-file or github-env/,
      ],
      [
        "missing credentials",
        { ACTIONS_RUNTIME_TOKEN: "" },
        [],
        /Image caching requires the hosted image lane/,
      ],
      [
        "malformed run ID",
        { GITHUB_RUN_ID: "0" },
        [],
        /Image CI state requires a valid run ID and attempt/,
      ],
      [
        "malformed run attempt",
        { GITHUB_RUN_ATTEMPT: "01" },
        [],
        /Image CI state requires a valid run ID and attempt/,
      ],
    ] satisfies [string, NodeJS.ProcessEnv, string[], RegExp][]) {
      const { commands, warmed } = await runWarmImageCache(t, "success", { env, args });
      assert.notEqual(warmed.status, 0, label);
      assert.match(warmed.stderr, error, label);
      const calls = await readFile(
        join(dirname(commands.statePath), "commands.jsonl"),
        "utf8",
      ).catch(() => "");
      assert.doesNotMatch(calls, /"buildx"/, label);
      assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/, label);
    }
  });

  test("warm-only arguments cannot silently change lane preparation", async (t) => {
    const commands = await fixtureImageCommands(t, "success", "images-packaging", warmCacheEnv);
    for (const args of [
      ["--require-cache-export"],
      ["--node-base-image", nodeBaseImage],
      ["--node-base-image", ""],
    ]) {
      const result = await commands.prepare(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /require --warm-image-cache/);
    }
    await assert.rejects(stat(commands.statePath), { code: "ENOENT" });
  });

  test("the image cache warm workflow runs for every change to an image build input", async () => {
    const workflow = await readWarmWorkflow();
    const triggers = object(workflow.on, "on");
    const push = object(triggers.push, "on.push");
    const paths = array(push.paths, "on.push.paths").map((path) => string(path, "push path"));
    assert.deepEqual(push.branches, ["main"]);
    assert.ok(
      array(triggers.schedule, "on.schedule").length > 0,
      "the warm job retries on a schedule",
    );
    assert.equal(object(workflow.concurrency, "concurrency")["cancel-in-progress"], false);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    const patterns = paths.map(
      (path) =>
        new RegExp(
          `^${path
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("**", "\u0000")
            .replaceAll("*", "[^/]*")
            .replaceAll("\u0000", ".*")}$`,
        ),
    );
    const covered = (path: string) => patterns.some((pattern) => pattern.test(path));
    const sources = [];
    // CI builds the controller's runtime target and the runtime Dockerfile's last
    // stage; only stages those reach are build inputs.
    for (const [dockerfile, target] of [
      ["Dockerfile", "runtime"],
      ["deploy/runtime/Dockerfile", undefined],
    ] as const) {
      const stages = (await readFile(join(repositoryRoot, dockerfile), "utf8"))
        .split(/^(?=FROM\s)/m)
        .slice(1)
        .map((text) => {
          const from = text.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
          assert.ok(from?.[1], `invalid FROM in ${dockerfile}`);
          const [, base, name] = from;
          const needs = [base];
          for (const [, stage] of text.matchAll(/(?:--from=|,from=)([^\s,]+)/g)) {
            assert.ok(stage, `missing source stage in ${dockerfile}`);
            needs.push(stage);
          }
          return { name, text, needs };
        });
      const reached = new Set<DockerfileStage>();
      const visit = (stage: DockerfileStage | undefined) => {
        if (stage && !reached.has(stage)) {
          reached.add(stage);
          stage.needs.forEach((name) => visit(stages.find((candidate) => candidate.name === name)));
        }
      };
      visit(target ? stages.find(({ name }) => name === target) : stages.at(-1));
      assert.ok(reached.size > 1, `${dockerfile} stages parsed`);
      const text = stages
        .filter((stage) => reached.has(stage))
        .map((stage) => stage.text)
        .join("");
      sources.push(dockerfile);
      for (const [, line] of text.matchAll(/^\s*COPY\s+(.+)$/gm)) {
        assert.ok(line, `missing COPY arguments in ${dockerfile}`);
        const words = line.trim().split(/\s+/);
        if (words.some((word) => word.startsWith("--from="))) {
          continue;
        }
        sources.push(...words.filter((word) => !word.startsWith("--")).slice(0, -1));
      }
      for (const [, options] of text.matchAll(/--mount=(\S*type=bind\S*)/g)) {
        assert.ok(options, `missing bind mount options in ${dockerfile}`);
        const fields = new Map(
          options.split(",").map((field) => {
            const [key, value] = field.split("=");
            return [key, value] as const;
          }),
        );
        if (!fields.get("from")) {
          const source = fields.get("source");
          assert.ok(source, `missing bind mount source in ${dockerfile}`);
          sources.push(source);
        }
      }
    }
    assert.ok(sources.length > 30, "both Dockerfiles parsed");
    // A COPY glob or directory is covered when a path inside it is.
    const uncovered = sources.filter((source) => {
      const [literal = ""] = source.split(/[*?[]/);
      return !covered(literal) && !covered(`${literal.replace(/\/$/, "")}/x`);
    });
    assert.deepEqual(uncovered, []);
    for (const input of [
      ".dockerignore",
      "scripts/ci/prepare.mjs",
      "scripts/ci/test-suites.ts",
      "scripts/ci/openshell-full-integration.ts",
      "scripts/ci/resource-names.ts",
      "scripts/ci/test-suites/images-packaging.json",
      ".github/workflows/ci-image-cache.yml",
    ]) {
      assert.ok(covered(input), input);
    }
  });
});
