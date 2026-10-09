import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import { prepareCodexSeccompProfile } from "../../scripts/ci/codex-seccomp.mjs";
import { metricsMonitoringImages } from "../../scripts/ci/metrics-monitoring-images.mjs";
import { defaultK3sImage } from "../../scripts/ci/prepare.mjs";
import { withStateLock } from "../../scripts/ci/state-lock.mjs";
import { createKubernetesInstallationConfiguration } from "../helpers/kubernetes-real.mjs";
import {
  assertStderrMatch,
  fixture,
  fixtureImageCommands,
  fixturePreparationMetrics,
  immutableImage,
  mutableImage,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preparePath = join(repositoryRoot, "scripts/ci/prepare.mjs");
const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function runPrepare(args, env = {}) {
  return spawnSync(process.execPath, [preparePath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

for (const { scenario, error } of [
  { scenario: "success" },
  { scenario: "podman-success" },
  { scenario: "delayed-overlay-route" },
  { scenario: "missing-tag", error: /Unable to find imported OCI manifest digest/ },
  {
    scenario: "missing-alias",
    error: /Unable to find imported OCC_TEST_KUBERNETES_IMAGE reference/,
  },
  { scenario: "missing-cri", error: /synthetic CRI image not found/ },
  { scenario: "missing-worker-cri", error: /synthetic CRI image not found/ },
  { scenario: "lagging-worker-cri" },
  { scenario: "absent-worker-cri", error: /level=fatal msg="no such image / },
  // A hung check fails at its own timeout (3 s here, so a busy runner does not trip the
  // host inspects that share it), never retried as a cache miss.
  {
    scenario: "hung-worker-cri",
    error: /CRI on k3d-\S+-agent-0 did not answer within 3000 ms \(crictl inspecti \S+\)\./,
  },
  {
    scenario: "hung-ctr-list",
    error:
      /containerd on k3d-\S+-agent-0 did not answer within 3000 ms \(ctr -n k8s\.io images list\)\./,
  },
  {
    scenario: "hung-server-list",
    error:
      /containerd on k3d-\S+-server-0 did not answer within 3000 ms \(ctr -n k8s\.io images list\)\./,
  },
  {
    scenario: "hung-ctr-tag",
    error:
      /containerd on k3d-\S+-agent-0 did not answer within 3000 ms \(ctr -n k8s\.io images tag \S+ \S+\)\./,
  },
  { scenario: "nonzero-import", error: /synthetic import command failure/ },
  { scenario: "nonzero-worker-import", error: /synthetic import command failure/ },
  { scenario: "save-failed", error: /synthetic export failure/ },
  { scenario: "save-failed-late-exit", error: /synthetic export failure/ },
]) {
  test(`fixture image CLI verifies runtime registration and cleanup: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(
      t,
      scenario,
      undefined,
      scenario.startsWith("hung-") ? { OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000" } : {},
    );
    const result = commands.prepare();
    assert.equal(result.error, undefined);
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));

    if (error) {
      assert.equal(result.status, 1, "preparation must reject an unusable imported fixture");
      assertStderrMatch(result.stderr, error);
      assert.equal(state.env, undefined);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    } else {
      assert.equal(result.status, 0, result.stderr);
      if (scenario === "success") {
        const metrics = fixturePreparationMetrics(result.stderr);
        const ready = metrics.find(
          ({ stage, status }) => stage === "k3d-nodes-ready" && status === "passed",
        );
        assert.ok(ready, "successful preparation must report node readiness timing");
        assert.ok(Number.isFinite(ready.elapsedMs) && ready.elapsedMs >= 0);
        assert.ok(metrics.some(({ stage }) => stage === "k3d-host-before"));
        assert.ok(metrics.some(({ stage }) => stage === "k3d-host-after"));
      }
    }

    const cluster = state.resources.find((resource) => resource.kind === "k3d-cluster");
    assert.equal(cluster.nodeImage, defaultK3sImage);
    assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
    const localImage = state.resources.find((resource) => resource.kind === "image-tag");
    const importedImage = state.resources.find((resource) => resource.kind === "k3d-image");
    assert.equal(localImage.status, "ready");
    assert.equal(importedImage.status, error ? "planned" : "ready");
    assert.notEqual(localImage.id, importedImage.id);
    assert.equal(importedImage.sourceImage, localImage.name);
    assert.equal(importedImage.cluster, cluster.name);
    assert.equal(importedImage.hostImageId, `sha256:${"b".repeat(64)}`);
    for (const resource of state.resources) {
      assert.equal(resource.owner, state.prefix);
    }

    const preparation = await commands.commands();
    const criLookups = (suffix) =>
      preparation.filter(
        ({ args }) => args[1] === `k3d-${cluster.name}-${suffix}` && args[2] === "crictl",
      ).length;
    // Only CRI's "no such image" answer waits for its event-fed cache; other
    // CRI failures stay final on the first lookup.
    const expectedWorkerLookups = {
      "missing-worker-cri": 1,
      "lagging-worker-cri": 3,
      "hung-worker-cri": 1,
    }[scenario];
    if (expectedWorkerLookups) {
      assert.equal(criLookups("agent-0"), expectedWorkerLookups);
    }
    if (scenario === "missing-cri") {
      assert.equal(criLookups("server-0"), 1);
    }
    if (scenario === "lagging-worker-cri" || scenario === "absent-worker-cri") {
      assertStderrMatch(
        result.stderr,
        /CRI on k3d-\S+-agent-0 does not list the imported \S+ reference yet \(attempt 1\); retrying\./,
      );
    }
    if (scenario === "lagging-worker-cri") {
      assert.deepEqual(
        [...result.stderr.matchAll(/\(attempt (\d+)\); retrying\./g)].map(([, attempt]) => attempt),
        ["1", "2"],
      );
    }
    if (scenario === "absent-worker-cri") {
      // The bounded wait is about 5 s; the lookups back off to one per second.
      const lookups = criLookups("agent-0");
      assert.ok(lookups >= 2 && lookups <= 12, `bounded CRI wait made ${lookups} lookups`);
      // The last lookup ends once the wait has run out, so the lookups span most of it.
      const times = preparation
        .filter(({ args }) => args[1] === `k3d-${cluster.name}-agent-0` && args[2] === "crictl")
        .map(({ at }) => at);
      assert.ok(
        times.at(-1) - times[0] >= 2_500,
        `CRI lookups spanned ${times.at(-1) - times[0]} ms`,
      );
    }
    const save = preparation.find(
      ({ command, args }) =>
        ["docker", "podman"].includes(command) && args[0] === "image" && args[1] === "save",
    );
    // An early node failure can stop the export before the engine records it.
    if (scenario !== "nonzero-worker-import") {
      assert.ok(save, "registration must export the task-owned image");
    }
    if (save) {
      // The export streams into each node; no archive is written or copied.
      assert.equal(save.args.includes("--output"), false);
      assert.equal(save.args.at(-1), localImage.name);
      assert.equal(save.args.includes("--platform"), scenario !== "podman-success");
    }
    assert.equal(
      preparation.some(({ args }) => args[0] === "cp"),
      false,
    );
    const imports = preparation.filter(
      ({ args }) => args[0] === "exec" && args[1] === "-i" && args.includes("import"),
    );
    assert.deepEqual(
      imports.map(({ args }) => args[2]).sort(),
      [`k3d-${cluster.name}-agent-0`, `k3d-${cluster.name}-server-0`],
      "every owned node must import the stream directly",
    );
    assert.equal(
      preparation.every(({ envPublished }) => !envPublished),
      true,
    );
    if (!error) {
      const expected = `${localImage.name.replace(/:local$/, "")}@sha256:${"c".repeat(64)}`;
      assert.equal(importedImage.reference, expected);
      assert.equal(state.env.OCC_TEST_KUBERNETES_IMAGE, expected);
      assert.equal(state.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS, "10.42.3.0/32");
      assert.ok(
        (await readFile(commands.githubEnv, "utf8"))
          .split("\n")
          .includes(`OCC_TEST_KUBERNETES_IMAGE=${expected}`),
      );
      for (const suffix of ["server-0", "agent-0"]) {
        assert.ok(
          preparation.some(
            ({ command, args }) =>
              command === (scenario === "podman-success" ? "podman" : "docker") &&
              args[1] === `k3d-${cluster.name}-${suffix}` &&
              args[2] === "crictl" &&
              args[4] === expected,
          ),
          "each schedulable node must resolve the published immutable image",
        );
      }
      assert.ok(
        preparation.some(
          ({ command, args }) =>
            command === "kubectl" &&
            args.includes("rollout") &&
            args.includes("daemonset/openclaw-ci-fixture-image-pin"),
        ),
        "preparation must keep the local-only fixture image active on every node",
      );
    }

    const cleanup = commands.cleanup();
    assert.equal(cleanup.error, undefined);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
    const cleanupCalls = (await commands.commands()).slice(preparation.length);
    const localRemoval = cleanupCalls.findIndex(
      ({ command, args }) =>
        ["docker", "podman"].includes(command) && args[0] === "image" && args[1] === "rm",
    );
    const importedRemoval = cleanupCalls.findIndex(
      ({ args }) => args[0] === "exec" && args.includes("ctr") && args.includes("rm"),
    );
    const clusterRemoval = cleanupCalls.findIndex(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "delete",
    );
    assert.ok(importedRemoval >= 0, "cleanup must remove the imported image from the nodes");
    assert.ok(
      localRemoval > importedRemoval,
      "imported image cleanup must precede local tag cleanup",
    );
    // The local tag may be created before the cluster now that the fixture build
    // overlaps cluster creation; only the node-side image needs the cluster.
    assert.ok(clusterRemoval > importedRemoval, "the cluster must outlive imported image cleanup");
  });
}

// The docker shim records argv only: this proves the cache credential stays out of
// build arguments and every output preparation hands on, not out of docker's environment.
test("repository platform preparation restores the runtime image cache without exporting it", async (t) => {
  const commands = await fixtureImageCommands(t, "success", "repository-credentials-platform", {
    GITHUB_ACTIONS: "true",
    OCC_CI_IMAGE_CACHE: "1",
    ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
    ACTIONS_RESULTS_URL: "https://cache.example.test/",
  });
  const prepared = commands.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const calls = (await commands.commands()).filter(({ command }) => command === "docker");
  const runtime = calls.filter(({ args }) => args[0] === "buildx" && args.includes("--load"));
  assert.equal(runtime.length, 1);
  const { args } = runtime[0];
  // The engine lacked the probed image, so the lane loaded the build.
  const probes = calls.filter(({ args }) => args[0] === "buildx" && args.includes("--output"));
  assert.deepEqual(
    probes.map(({ args: probe }) => probe.slice(7)),
    [args.slice(3)],
  );
  assert.deepEqual(args.slice(0, 3), ["buildx", "build", "--load"]);
  assert.equal(
    args[args.indexOf("--cache-from") + 1],
    `type=gha,version=2,scope=oce-ci-runtime-${process.platform}-${process.arch}-v1,timeout=60s`,
  );
  assert.equal(args.includes("--cache-to"), false);
  // The fixture derives from the loaded runtime image through the engine's own builder.
  const fixtureBuilds = calls.filter(({ args }) => args[0] === "build");
  assert.equal(fixtureBuilds.length, 1);
  assert.equal(fixtureBuilds[0].args[fixtureBuilds[0].args.indexOf("--builder") + 1], "default");
  assert.ok(fixtureBuilds[0].args.includes(`RUNTIME_IMAGE=${args[args.indexOf("-t") + 1]}`));
  const state = await readFile(commands.statePath, "utf8");
  const githubEnv = await readFile(commands.githubEnv, "utf8");
  assert.match(githubEnv, /^OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE=/m);
  assert.doesNotMatch(
    JSON.stringify(calls) + state + githubEnv + prepared.stdout + prepared.stderr,
    /synthetic-cache-credential/,
  );
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("image cache preparation refuses missing credentials and unmapped lanes before building", async (t) => {
  const credentials = {
    GITHUB_ACTIONS: "true",
    OCC_CI_IMAGE_CACHE: "1",
    ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
    ACTIONS_RESULTS_URL: "https://cache.example.test/",
  };
  const nodeBaseImage = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/images-packaging.json"), "utf8"),
  ).prepare.defaultEnv.NODE_BASE_IMAGE;
  for (const [lane, env] of [
    // A cache lane without its runtime token.
    ["repository-credentials-platform", { ...credentials, ACTIONS_RUNTIME_TOKEN: "" }],
    // A lane outside the cache map, even with credentials.
    [
      "docker-model",
      {
        ...credentials,
        OPENAI_API_KEY: "synthetic-model-key",
        OCC_TEST_OPENAI_MODEL: "gpt-synthetic",
        NODE_BASE_IMAGE: nodeBaseImage,
      },
    ],
  ]) {
    const commands = await fixtureImageCommands(t, "success", lane, env);
    const prepared = commands.prepare();
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

test("Images and Packaging exports the image caches only on main pushes", async (t) => {
  for (const [event, exported] of [
    ["pull_request", false],
    ["merge_group", false],
    ["workflow_dispatch", false],
    ["push", true],
  ]) {
    const commands = await fixtureImageCommands(t, "success", "images-packaging", {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: event,
      OCC_CI_IMAGE_CACHE: "1",
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
    });
    const prepared = commands.prepare();
    assert.equal(prepared.status, 0, `${event}: ${prepared.stderr}`);
    const calls = (await commands.commands()).filter(({ args }) => args[0] === "buildx");
    const builds = calls.filter(({ args }) => args.includes("--load"));
    assert.equal(builds.length, 2, event);
    // Only a lane that exports the cache skips the probe for an existing image.
    assert.equal(calls.length, exported ? 2 : 4, event);
    // A fixed epoch keeps independent builds of the same layers on one image ID;
    // the probe must resolve the same ID the build would load.
    for (const { args } of calls) {
      assert.equal(args[args.indexOf("SOURCE_DATE_EPOCH=0") - 1], "--build-arg", event);
    }
    if (!exported) {
      assert.match(prepared.stderr, /"stage":"controller-image-reuse","outcome":"absent"/, event);
      assert.match(prepared.stderr, /"stage":"runtime-image-reuse","outcome":"absent"/, event);
    }
    for (const { args } of builds) {
      const role = args.includes("--target") ? "controller" : "runtime";
      const cache = `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
      assert.equal(args[args.indexOf("--cache-from") + 1], `${cache},timeout=60s`, event);
      assert.equal(
        args.includes("--cache-to") && args[args.indexOf("--cache-to") + 1],
        exported && `${cache},mode=max,ignore-error=true,timeout=60s`,
        event,
      );
    }
    const cleaned = commands.cleanup();
    assert.equal(cleaned.status, 0, `${event}: ${cleaned.stderr}`);
  }
});

test("image lanes tag the engine's copy when the restored cache resolves to an image it holds", async (t) => {
  const commands = await fixtureImageCommands(t, "engine-holds-images", "images-packaging", {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request",
    OCC_CI_IMAGE_CACHE: "1",
    ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
    ACTIONS_RESULTS_URL: "https://cache.example.test/",
  });
  const prepared = commands.prepare();
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
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  for (const { args } of tags) {
    const tagged = state.resources.find(
      ({ kind, name }) => kind === "image-tag" && name === args[2],
    );
    assert.equal(tagged?.status, "ready", args[2]);
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
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
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
]) {
  test(`image lanes build when the engine image probe cannot reuse: ${scenario} ${JSON.stringify(env)}`, async (t) => {
    const commands = await fixtureImageCommands(t, scenario, "images-packaging", {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      OCC_CI_IMAGE_CACHE: "1",
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      ...env,
    });
    const prepared = commands.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const calls = (await commands.commands()).filter(({ command }) => command === "docker");
    // Both images build and load as if no probe had run.
    const builds = calls.filter(({ args }) => args[0] === "buildx" && args.includes("--load"));
    assert.equal(builds.length, 2);
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    for (const { args } of builds) {
      const tag = args[args.indexOf("-t") + 1];
      const tagged = state.resources.find(({ kind, name }) => kind === "image-tag" && name === tag);
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
    const cleaned = commands.cleanup();
    assert.equal(cleaned.status, 0, cleaned.stderr);
  });
}

const warmCacheEnv = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  OCC_CI_IMAGE_CACHE: "1",
  ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
  ACTIONS_RESULTS_URL: "https://cache.example.test/",
};

test("the main image cache warm job builds the packaging images and exports both caches strictly", async (t) => {
  const commands = await fixtureImageCommands(t, "success", "images-packaging", warmCacheEnv);
  const warmed = commands.warmImageCache();
  assert.equal(warmed.status, 0, warmed.stderr);
  assert.match(
    warmed.stderr,
    /\[ci-timing\] lane=image-cache-warm phase=controller-runtime-image-build/,
  );
  // Each image's BuildKit output is printed under its own heading.
  assert.match(warmed.stderr, /^\[image-cache-warm\] controller build$/m);
  assert.match(warmed.stderr, /^\[image-cache-warm\] runtime build$/m);
  const builds = (await commands.commands()).filter(({ args }) => args[0] === "buildx");
  assert.deepEqual(
    builds.map(({ args }) => (args.includes("--target") ? "controller" : "runtime")).sort(),
    ["controller", "runtime"],
  );
  const nodeBaseImage = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/images-packaging.json"), "utf8"),
  ).prepare.defaultEnv.NODE_BASE_IMAGE;
  for (const { args } of builds) {
    const role = args.includes("--target") ? "controller" : "runtime";
    const cache = `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
    assert.deepEqual(args.slice(0, 3), ["buildx", "build", "--load"]);
    // The lane's restore keys, an export that fails the job instead of being ignored,
    // and plain progress so the log shows each step's cache result.
    assert.equal(args[args.indexOf("--cache-from") + 1], `${cache},timeout=60s`);
    assert.equal(args[args.indexOf("--cache-to") + 1], `${cache},mode=max,timeout=10m`);
    assert.ok(args.includes("--progress=plain"));
    if (role === "controller") {
      assert.ok(args.includes(`NODE_BASE_IMAGE=${nodeBaseImage}`));
    }
  }
  const state = await readFile(commands.statePath, "utf8");
  assert.equal(JSON.parse(state).lane, "images-packaging");
  assert.doesNotMatch(
    JSON.stringify(builds) + state + warmed.stdout + warmed.stderr,
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
  assert.match(calls[tagged].args[1], /^localhost\/openclaw-ci-image-[a-z0-9-]+\/runtime:local$/);
  assert.match(
    warmed.stderr,
    new RegExp(`"stage":"runtime-image-kept","image":"sha256:${"b".repeat(64)}","tag":"${kept}"`),
  );
  assert.doesNotMatch(state, /openclaw-ci-main/);
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
  const removed = (await commands.commands()).filter(
    ({ args }) => args[0] === "image" && args[1] === "rm",
  );
  assert.deepEqual(
    removed.map(({ args }) => args.at(-1)).sort(),
    [
      calls[tagged].args[1],
      builds.find(({ args }) => args.includes("--target")).args.at(-2),
    ].sort(),
  );
});

test("the image cache warm job prints a failed build's output and fails", async (t) => {
  const commands = await fixtureImageCommands(
    t,
    "controller-build-failed",
    "images-packaging",
    warmCacheEnv,
  );
  const warmed = commands.warmImageCache();
  assert.notEqual(warmed.status, 0);
  assert.match(
    warmed.stderr,
    /^\[image-cache-warm\] controller build\n#7 \[runtime 3\/9\] synthetic controller step$/m,
  );
  // A failed warm build keeps nothing.
  assert.equal((await commands.commands()).filter(({ args }) => args[0] === "tag").length, 0);
  assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/);
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("the image cache warm job refuses refs other than main and lane arguments before building", async (t) => {
  for (const [label, env, args, error] of [
    [
      "pull request",
      { GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" },
      [],
      /Only a push or dispatch on main may warm the image cache/,
    ],
    [
      "branch dispatch",
      { GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_NAME: "workflow_dispatch" },
      [],
      /Only a push or dispatch on main may warm the image cache/,
    ],
    [
      "merge queue on main",
      { GITHUB_EVENT_NAME: "merge_group" },
      [],
      /Only a push or dispatch on main may warm the image cache/,
    ],
    ["lane argument", {}, ["--lane", "images-packaging"], /--warm-image-cache takes only --state/],
    [
      "missing credentials",
      { ACTIONS_RUNTIME_TOKEN: "" },
      [],
      /Image caching requires the hosted image lane/,
    ],
  ]) {
    const commands = await fixtureImageCommands(t, "success", "images-packaging", {
      ...warmCacheEnv,
      ...env,
    });
    const warmed = commands.warmImageCache(args);
    assert.notEqual(warmed.status, 0, label);
    assert.match(warmed.stderr, error, label);
    const calls = await readFile(join(dirname(commands.statePath), "commands.jsonl"), "utf8").catch(
      () => "",
    );
    assert.doesNotMatch(calls, /"buildx"/, label);
    assert.doesNotMatch(warmed.stdout + warmed.stderr, /synthetic-cache-credential/, label);
  }
});

test("the image cache warm workflow runs for every change to an image build input", async () => {
  const workflow = loadYaml(
    await readFile(join(repositoryRoot, ".github/workflows/ci-image-cache.yml"), "utf8"),
  );
  const paths = workflow.on.push.paths;
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
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
  const covered = (path) => patterns.some((pattern) => pattern.test(path));
  const sources = [];
  // CI builds the controller's runtime target and the runtime Dockerfile's last
  // stage; only stages those reach are build inputs.
  for (const [dockerfile, target] of [
    ["Dockerfile", "runtime"],
    ["deploy/runtime/Dockerfile", undefined],
  ]) {
    const stages = (await readFile(join(repositoryRoot, dockerfile), "utf8"))
      .split(/^(?=FROM\s)/m)
      .slice(1)
      .map((text) => {
        const [, base, name] = text.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
        const from = [...text.matchAll(/(?:--from=|,from=)([^\s,]+)/g)].map(([, stage]) => stage);
        return { name, text, needs: [base, ...from] };
      });
    const reached = new Set();
    const visit = (stage) => {
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
      const words = line.trim().split(/\s+/);
      if (words.some((word) => word.startsWith("--from="))) {
        continue;
      }
      sources.push(...words.filter((word) => !word.startsWith("--")).slice(0, -1));
    }
    for (const [, options] of text.matchAll(/--mount=(\S*type=bind\S*)/g)) {
      const fields = Object.fromEntries(options.split(",").map((field) => field.split("=")));
      if (!fields.from) {
        sources.push(fields.source);
      }
    }
  }
  assert.ok(sources.length > 30, "both Dockerfiles parsed");
  // A COPY glob or directory is covered when a path inside it is.
  const uncovered = sources.filter((source) => {
    const literal = source.split(/[*?[]/)[0];
    return !covered(literal) && !covered(`${literal.replace(/\/$/, "")}/x`);
  });
  assert.deepEqual(uncovered, []);
  for (const input of [
    ".dockerignore",
    "scripts/ci/prepare.mjs",
    "scripts/ci/test-suites/images-packaging.json",
    ".github/workflows/ci-image-cache.yml",
  ]) {
    assert.ok(covered(input), input);
  }
});

test("ordinary k3d preparation rejects mutable K3s overrides before creating state", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const result = runPrepare(["--lane", "repository-credentials-platform", "--state", statePath], {
    OPENCLAW_CI_K3S_IMAGE: "rancher/k3s:latest",
    OCC_DOCKER_BIN: join(root, "no-docker-command"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENCLAW_CI_K3S_IMAGE must be an immutable/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("repository platform preparation binds runtime clients, an owned gateway and a fresh migrated database", async (t) => {
  const commands = await fixtureImageCommands(t, "success", "repository-credentials-platform");
  const prepared = commands.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  for (const phase of [
    "postgres-start",
    "k3d-create",
    "runtime-image-build",
    "platform-fixture-build",
    "postgres-cluster-image-build",
    "image-stream-import",
    "platform-image-import",
  ]) {
    assert.match(
      prepared.stderr,
      new RegExp(
        `\\[ci-timing\\] lane=repository-credentials-platform phase=${phase} duration_ms=\\d+`,
      ),
    );
  }
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
  assert.equal(state.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM, "1");
  assert.equal(state.env.OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS, "172.19.0.1");
  assert.match(
    state.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE,
    new RegExp(
      `^localhost/openclaw-ci-image-[a-z0-9-]+/repository-platform@sha256:${"c".repeat(64)}$`,
    ),
  );
  const imported = state.resources.find(({ kind }) => kind === "k3d-image");
  assert.equal(imported.cluster, cluster.name);
  assert.equal(imported.status, "ready");
  assert.equal(state.env.OPENAI_API_KEY, undefined);

  const file = commands.prepareFile("tests/integration/repository-credentials-platform.test.mjs");
  assert.equal(file.status, 0, file.stderr);
  const migrated = JSON.parse(await readFile(commands.statePath, "utf8"));
  const database = migrated.resources.find(({ kind }) => kind === "postgres-database");
  assert.match(database.name, /^openclaw_k8s_/);
  assert.equal(database.status, "ready");
  const calls = await commands.commands();
  assert.ok(calls.some(({ command, args }) => command === "corepack" && args[1] === "db:migrate"));
  const builds = calls.filter(({ command, args }) => command === "docker" && args[0] === "build");
  assert.equal(builds.length, 2);
  for (const { args } of builds) {
    assert.equal(args[args.indexOf("--builder") + 1], "default");
    assert.ok(args.includes("--load"));
  }
  assert.ok(
    builds[1].args.includes(`RUNTIME_IMAGE=${builds[0].args[builds[0].args.indexOf("-t") + 1]}`),
  );
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
});

test("PostgreSQL CI selects and contains the per-file IAM barrier fixture", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const logPath = join(root, "fake-commands.log");
  const dockerPath = join(root, "fake-docker.mjs");
  const corepackPath = join(root, "fake-corepack.mjs");
  const prefix = "openclaw-ci-synthetic";
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    lane: "postgres-application",
    prefix,
    statePath,
    resources: [
      {
        id: "compose-postgres-synthetic",
        kind: "compose-postgres",
        owner: prefix,
        status: "ready",
        name: "openclaw_ci_pg_synthetic",
        composeFile: join(repositoryRoot, "compose.postgres.yaml"),
        port: 45431,
      },
    ],
  });
  await writeFile(
    dockerPath,
    `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.equal(args[0], "compose");
assert.equal(args[1], "-f");
assert.equal(args[3], "-p");
assert.deepEqual(args.slice(5, 9), ["exec", "-T", "postgres", "psql"]);
appendFileSync(process.env.CI_SYNTHETIC_LOG, "docker-exec\\t" + args.at(-1) + "\\n");
`,
    { mode: 0o700 },
  );
  await writeFile(
    corepackPath,
    `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
assert.deepEqual(process.argv.slice(2), ["pnpm", "db:migrate"]);
const url = new URL(process.env.OCC_MIGRATION_DATABASE_URL);
assert.equal(url.username, "occ_migrator");
assert.match(url.pathname, /^\\/openclaw_ci_/);
appendFileSync(process.env.CI_SYNTHETIC_LOG, "migrate\\t" + url.pathname + "\\n");
`,
    { mode: 0o700 },
  );
  const program = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { prepareFile } = await import(process.argv[1]);
const statePath = process.argv[2];
const lane = "postgres-application";
const selected = await prepareFile({
  lane,
  file: "tests/integration/postgres-native-iam-policy-barrier.test.mjs",
  statePath,
});
assert.equal(selected.env.OCC_TEST_NATIVE_IAM_BARRIER_CI, "1");
const app = new URL(selected.env.OCC_TEST_DATABASE_URL);
const migrator = new URL(selected.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL);
assert.equal(app.username, "occ_app");
assert.equal(migrator.username, "occ_migrator");
assert.equal(app.host, migrator.host);
assert.equal(app.pathname, migrator.pathname);
assert.equal(app.pathname, "/" + selected.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE);
assert.match(app.pathname, /^\\/openclaw_ci_postgres_native_iam_policy_barrier_[a-f0-9]{12}$/);
const prepared = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(prepared.resources.filter((resource) => resource.kind === "postgres-database").length, 1);
await selected.cleanup();
const settled = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(settled.resources.filter((resource) => resource.kind === "postgres-database").length, 0);
const other = await prepareFile({
  lane,
  file: "tests/integration/postgres-worker-agent-revision.test.mjs",
  statePath,
});
assert.equal(other.env.OCC_TEST_NATIVE_IAM_BARRIER_CI, undefined);
assert.equal(other.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE, undefined);
assert.equal(other.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL, undefined);
await other.cleanup();
const finalState = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(finalState.resources.length, 1);
`;
  const fakeEnv = {
    PATH: root,
    LANG: "C",
    OCC_DOCKER_BIN: dockerPath,
    OPENCLAW_CI_COREPACK_BIN: corepackPath,
    CI_SYNTHETIC_LOG: logPath,
  };
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      program,
      new URL("../../scripts/ci/prepare.mjs", import.meta.url).href,
      statePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: fakeEnv,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const commandLog = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(commandLog.length, 8);
  const createCommands = commandLog.filter((line) => line.includes("CREATE DATABASE"));
  const dropCommands = commandLog.filter((line) => line.includes("DROP DATABASE"));
  assert.equal(createCommands.length, 2);
  assert.equal(dropCommands.length, 2);
  assert.ok(createCommands.every((line) => line.startsWith("docker-exec\tCREATE DATABASE ")));
  const githubEnv = join(root, "github.env");
  const blocked = spawnSync(
    process.execPath,
    [
      preparePath,
      "--lane",
      "postgres-application",
      "--file",
      "tests/integration/postgres-native-iam-policy-barrier.test.mjs",
      "--state",
      statePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...fakeEnv, GITHUB_ENV: githubEnv },
    },
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /must be prepared within the test runner/);
  await assert.rejects(() => stat(githubEnv), { code: "ENOENT" });
  const blockedArgument = spawnSync(
    process.execPath,
    [
      preparePath,
      "--lane",
      "postgres-application",
      "--file",
      "tests/integration/postgres-native-iam-policy-barrier.test.mjs",
      "--state",
      statePath,
      "--github-env",
      githubEnv,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: fakeEnv,
    },
  );
  assert.equal(blockedArgument.status, 1);
  assert.match(blockedArgument.stderr, /must be prepared within the test runner/);
  await assert.rejects(() => stat(githubEnv), { code: "ENOENT" });
  assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 8);
});

test("prepareFile copies a per-test database from a ready template it owns without migrating", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const logPath = join(root, "fake-commands.log");
  const dockerPath = join(root, "fake-docker.mjs");
  const corepackPath = join(root, "fake-corepack.mjs");
  const prefix = "openclaw-ci-synthetic";
  const server = {
    id: "compose-postgres-synthetic",
    kind: "compose-postgres",
    owner: prefix,
    status: "ready",
    name: "openclaw_ci_pg_synthetic",
    composeFile: join(repositoryRoot, "compose.postgres.yaml"),
    port: 45431,
  };
  const database = (name, extra = {}) => ({
    id: `postgres-database-${name}`,
    kind: "postgres-database",
    owner: prefix,
    status: "ready",
    name,
    composeProject: server.name,
    port: server.port,
    ...extra,
  });
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    lane: "postgres-application",
    prefix,
    statePath,
    resources: [
      server,
      database("openclaw_ci_foreign_owner", { owner: "openclaw-ci-other" }),
      database("openclaw_ci_planned", { status: "planned" }),
      database("openclaw_ci_other_project", { composeProject: "openclaw_ci_pg_other" }),
      database("openclaw_ci_other_port", { port: 45432 }),
    ],
  });
  await writeFile(
    dockerPath,
    `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(5, 9), ["exec", "-T", "postgres", "psql"]);
appendFileSync(process.env.CI_SYNTHETIC_LOG, "docker-exec\\t" + args.at(-3) + "\\t" + args.at(-1) + "\\n");
`,
    { mode: 0o700 },
  );
  await writeFile(
    corepackPath,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CI_SYNTHETIC_LOG, "migrate\\t" + new URL(process.env.OCC_MIGRATION_DATABASE_URL).pathname + "\\n");
`,
    { mode: 0o700 },
  );
  const program = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { prepareFile } = await import(process.argv[1]);
const statePath = process.argv[2];
const options = {
  lane: "postgres-application",
  file: "tests/integration/postgres-worker-agent-revision.test.mjs",
  statePath,
};
const template = await prepareFile(options);
const url = (name) => template.env.OCC_TEST_DATABASE_URL.replace(/[^/]+$/, name);
for (const refused of [url("openclaw_ci_foreign_owner"), url("openclaw_ci_planned"), url("openclaw_ci_other_project"), url("openclaw_ci_other_port"), url("openclaw_ci_absent"), "not a url"]) {
  await assert.rejects(() => prepareFile({ ...options, template: refused }), /template must be/);
}
await assert.rejects(
  () => prepareFile({ ...options, lane: "checks-baseline-1", template: template.env.OCC_TEST_DATABASE_URL }),
  /requires a prepared PostgreSQL lane state/,
);
const copy = await prepareFile({ ...options, template: template.env.OCC_TEST_DATABASE_URL });
const copied = new URL(copy.env.OCC_TEST_DATABASE_URL);
assert.equal(copied.username, "occ_app");
assert.notEqual(copied.pathname, new URL(template.env.OCC_TEST_DATABASE_URL).pathname);
assert.match(copied.pathname, /^\\/openclaw_ci_postgres_worker_agent_revision_[a-f0-9]{12}$/);
const prepared = JSON.parse(await readFile(statePath, "utf8"));
assert.deepEqual(
  prepared.resources.filter((resource) => resource.kind === "postgres-database" && resource.owner === prepared.prefix && resource.status === "ready" && resource.name.startsWith("openclaw_ci_postgres_")).map((resource) => "/" + resource.name),
  [new URL(template.env.OCC_TEST_DATABASE_URL).pathname, copied.pathname],
);
// A refused template is rejected before a resource is recorded.
assert.deepEqual(
  prepared.resources.filter((resource) => resource.status === "planned").map((resource) => resource.name),
  ["openclaw_ci_planned"],
);
await copy.cleanup();
await template.cleanup();
console.error(new URL(template.env.OCC_TEST_DATABASE_URL).pathname.slice(1) + " " + copied.pathname.slice(1));
`;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      program,
      new URL("../../scripts/ci/prepare.mjs", import.meta.url).href,
      statePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: root,
        LANG: "C",
        OCC_DOCKER_BIN: dockerPath,
        OPENCLAW_CI_COREPACK_BIN: corepackPath,
        CI_SYNTHETIC_LOG: logPath,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [templateName, copyName] = result.stderr.trim().split(" ");
  assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
    `docker-exec\tpostgres\tCREATE DATABASE "${templateName}"`,
    `docker-exec\t${templateName}\tGRANT CREATE ON DATABASE "${templateName}" TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
    `migrate\t/${templateName}`,
    // The copy keeps the template's schemas and migrations; only the database grant is new.
    `docker-exec\tpostgres\tCREATE DATABASE "${copyName}" TEMPLATE "${templateName}"`,
    `docker-exec\t${copyName}\tGRANT CREATE ON DATABASE "${copyName}" TO occ_migrator;`,
    `docker-exec\tpostgres\tDROP DATABASE IF EXISTS "${copyName}" WITH (FORCE)`,
    `docker-exec\tpostgres\tDROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`,
  ]);
});

test("prepareFile and cleanup in two processes keep each other's state entries", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const dockerPath = join(root, "fake-docker.mjs");
  const corepackPath = join(root, "fake-corepack.mjs");
  const prefix = "openclaw-ci-synthetic";
  const server = {
    id: "compose-postgres-synthetic",
    kind: "compose-postgres",
    owner: prefix,
    status: "ready",
    name: "openclaw_ci_pg_synthetic",
    composeFile: join(repositoryRoot, "compose.postgres.yaml"),
    port: 45431,
  };
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    lane: "postgres-application",
    prefix,
    statePath,
    resources: [server],
  });
  // Each command takes a little while, so the two processes' state updates overlap.
  const slow = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n`;
  await writeFile(dockerPath, `#!${process.execPath}\n${slow}`, { mode: 0o700 });
  await writeFile(corepackPath, `#!${process.execPath}\n${slow}`, { mode: 0o700 });
  // Like the worker revision suite: a template per process, then a copy per test.
  const program = `
const { prepareFile } = await import(process.argv[1]);
const options = {
  lane: "postgres-application",
  file: "tests/integration/postgres-worker-agent-revision.test.mjs",
  statePath: process.argv[2],
};
const template = await prepareFile(options);
for (let index = 0; index < 10; index += 1) {
  const copy = await prepareFile({ ...options, template: template.env.OCC_TEST_DATABASE_URL });
  await copy.cleanup();
}
await template.cleanup();
`;
  const run = () =>
    new Promise((resolveRun) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          program,
          new URL("../../scripts/ci/prepare.mjs", import.meta.url).href,
          statePath,
        ],
        {
          cwd: repositoryRoot,
          env: {
            PATH: root,
            LANG: "C",
            OCC_DOCKER_BIN: dockerPath,
            OPENCLAW_CI_COREPACK_BIN: corepackPath,
          },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 60_000,
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
  const results = await Promise.all([run(), run()]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const settled = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(settled.resources, [server]);
  assert.deepEqual((await readdir(root)).sort(), [
    "fake-corepack.mjs",
    "fake-docker.mjs",
    "state.json",
  ]);
});

test("the CI state lock removes an exited holder's lock and waits for a live one", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const lockPath = `${statePath}.lock`;
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  await writeFile(lockPath, `${exited.pid} abandoned\n`, { mode: 0o600 });
  // A nested call in the same async context reuses the held lock.
  assert.equal(
    await withStateLock(statePath, () => withStateLock(statePath, async () => "ran")),
    "ran",
  );
  await assert.rejects(() => stat(lockPath), { code: "ENOENT" });

  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  t.after(() => holder.kill());
  await writeFile(lockPath, `${holder.pid} live\n`, { mode: 0o600 });
  let ran = false;
  await assert.rejects(
    () =>
      withStateLock(
        statePath,
        async () => {
          ran = true;
        },
        { timeoutMs: 300 },
      ),
    new RegExp(
      `Timed out after 300 ms waiting for the CI state lock .* \\(held by pid ${holder.pid}\\)`,
    ),
  );
  assert.equal(ran, false);
  assert.equal(await readFile(lockPath, "utf8"), `${holder.pid} live\n`);
  assert.deepEqual((await readdir(root)).sort(), ["state.json.lock"]);
});

test("repository platform preparation refuses a public relay gateway before importing images", async (t) => {
  const commands = await fixtureImageCommands(
    t,
    "public-gateway",
    "repository-credentials-platform",
  );
  const prepared = commands.prepare();
  assert.equal(prepared.status, 1);
  assert.match(prepared.stderr, /private IPv4 Docker host gateway/);
  // The image builds overlap cluster creation; nothing reaches the refused cluster.
  assert.equal(
    (await commands.commands()).some(({ args }) => args[0] === "exec" && args[1] === "-i"),
    false,
  );
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  assert.equal(
    state.resources.some(({ kind }) => kind === "k3d-image"),
    false,
  );
  assert.equal(state.env, undefined);
  await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("installed repository preparation is refused before prerequisite checks or side effects", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "installed-state.json");
  const configPath = join(root, "app.json");
  const keyPath = join(root, "app.pem");
  await writeFile(configPath, "{}", { mode: 0o600 });
  await writeFile(keyPath, "test-only key", { mode: 0o600 });
  const args = ["--lane", "repository-credentials-installed", "--state", statePath];

  // An operator who selects the lane without any inputs learns that it is
  // unavailable, instead of being asked for model, App and image inputs first.
  const unprepared = runPrepare(args, {});
  assert.equal(unprepared.status, 1);
  assert.match(unprepared.stderr, /Installed repository qualification is temporarily unavailable/);
  assert.doesNotMatch(unprepared.stderr, /Missing required CI input/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  // Inputs that previously passed the early checks cannot create a preparation state
  // while remote cleanup lacks a safe ownership boundary.
  const blocked = runPrepare(args, {
    OPENAI_API_KEY: "test-only-model-key",
    OCC_TEST_OPENAI_MODEL: "test-model",
    NODE_BASE_IMAGE: "",
    OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED: "1",
    OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY: "fixture/repository",
    OCC_TEST_REPOSITORY_CREDENTIALS_APP_CONFIG_FILE: configPath,
    OCC_TEST_REPOSITORY_CREDENTIALS_APP_KEY_FILE: keyPath,
    OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: immutableImage,
    OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE_MODE: "release",
    OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS: "203.0.113.1/32",
    OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: immutableImage,
    OCC_TEST_PRODUCTION_POSTGRES_IMAGE: immutableImage,
    OCC_TEST_PRODUCTION_NODE_IMAGE: immutableImage,
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Installed repository qualification is temporarily unavailable/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  // Per-file preparation, which the test runner uses, is refused the same way.
  const perFile = runPrepare(
    [...args, "--file", "tests/integration/repository-credentials-k3d-real.test.mjs"],
    {},
  );
  assert.equal(perFile.status, 1);
  assert.match(perFile.stderr, /Installed repository qualification is temporarily unavailable/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("the installed repository journey refuses direct execution before fixture setup", async (t) => {
  const root = await fixture(t);
  // Direct execution must fail at the safety guard even without credentials or
  // a cluster, before any setup or provider operation can be attempted.
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-name-pattern=^installed ",
      "tests/integration/repository-credentials-k3d-real.test.mjs",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: process.env.PATH,
        OCC_TEST_REPOSITORY_CREDENTIALS_REAL: "1",
      },
      timeout: 15000,
    },
  );
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /tests 3/);
  assert.equal(
    (output.match(/Installed repository qualification is temporarily unavailable/g) ?? []).length,
    3,
  );
});

test("production upgrade preparation requires two distinct immutable image pairs before creating resources", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "upgrade-state.json");
  const image = (name, digit) => `registry.example/${name}@sha256:${digit.repeat(64)}`;
  const env = {
    OPENAI_API_KEY: "test-only-model-key",
    OCC_TEST_OPENAI_MODEL: "test-model",
    NODE_BASE_IMAGE: "",
    OCC_TEST_PRODUCTION_POSTGRES_IMAGE: image("postgres", "a"),
    OCC_TEST_PRODUCTION_NODE_IMAGE: image("node", "b"),
    OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: image("controller", "c"),
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: image("runtime", "d"),
    OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: image("controller", "e"),
    OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: image("runtime", "f"),
  };
  const args = ["--lane", "production-tui", "--state", statePath];
  for (const [override, expected] of [
    [{ OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: "" }, /OCC_TEST_PRODUCTION_CONTROLLER_IMAGE/],
    [
      { OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: "" },
      /OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE/,
    ],
    [
      { OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: "controller:latest" },
      /OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE/,
    ],
    [
      { OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: image("another-controller", "c") },
      /must select a different digest/,
    ],
    [
      {
        OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: image("another-controller", "C").replace(
          "@sha256:",
          "@SHA256:",
        ),
      },
      /must select a different digest/,
    ],
  ]) {
    const rejected = runPrepare(args, { ...env, ...override });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, expected);
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  }

  // A complete release selection reaches tool discovery without a source build
  // or secret-bearing preparation state; no cluster is created in this check.
  const admitted = runPrepare(args, { ...env, OCC_HELM_BIN: join(root, "missing-helm") });
  assert.equal(admitted.status, 1);
  assert.match(admitted.stderr, /missing-helm/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.resources, []);
  assert.ok(!JSON.stringify(state).includes(env.OPENAI_API_KEY));

  const unprepared = runPrepare(
    [...args, "--file", "tests/integration/production-tui-k3d-real.test.mjs"],
    env,
  );
  assert.equal(unprepared.status, 1);
  assert.match(unprepared.stderr, /must match the prepared lane state/);
});

// GitHub refuses NODE_OPTIONS in $GITHUB_ENV with an ##[error] annotation that reads like the
// lane's failure. run-tests.mjs applies the lane's env to each test process itself.
test("lane preparation does not export the lane's NODE_OPTIONS to GITHUB_ENV", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const githubEnv = join(root, "github.env");
  const manifest = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  assert.ok(manifest.lanes["checks-baseline-1"].env.NODE_OPTIONS);
  const prepared = runPrepare([
    "--lane",
    "checks-baseline-1",
    "--state",
    statePath,
    "--github-env",
    githubEnv,
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const exported = (await readFile(githubEnv, "utf8")).trim().split("\n");
  assert.deepEqual(exported.map((line) => line.split("=")[0]).sort(), [
    "OPENCLAW_ENTERPRISE_CI_PREFIX",
    "OPENCLAW_ENTERPRISE_CI_STATE",
  ]);
});

test("ordinary CI groups require platform proof and exclude installed live repository writes", async () => {
  const manifest = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  for (const name of ["ci", "full"]) {
    assert.ok(manifest.groups[name].includes("repository-credentials-platform"));
    assert.ok(!manifest.groups[name].includes("repository-credentials-installed"));
    for (const lane of manifest.groups[name]) {
      assert.notEqual(manifest.lanes[lane].env?.OCC_TEST_REPOSITORY_CREDENTIALS_REAL, "1");
    }
  }
});

test("CI installs browsers for the PostgreSQL sign-in suite's owning lane", async () => {
  const manifest = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  const owners = Object.entries(manifest.lanes).filter(([, lane]) =>
    lane.files.some((file) => file.path === "tests/integration/postgres-github-sign-in.test.mjs"),
  );
  assert.equal(owners.length, 1);
  const [lane] = owners[0];
  const action = loadYaml(
    await readFile(join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"), "utf8"),
  );
  const browserSetup = action.runs.steps.find(
    (step) => step.run === "bash scripts/ci/setup-tools.sh browser",
  );
  assert.ok(browserSetup);
  // Moving the browser suite between lanes must carry its Chromium prerequisite.
  assert.ok(
    browserSetup.if.split(/\s*\|\|\s*/).includes(`inputs.lane == '${lane}'`),
    `${lane} must install browsers before running the PostgreSQL sign-in suite`,
  );
});

test("Kubernetes test helper passes an explicit Codex localhost seccomp profile into runtime config", () => {
  const profile = "openclaw/codex-bwrap.json";
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: "openclaw-platform",
    gatewayImage: immutableImage,
    codexImage: immutableImage,
    cluster: "k3d-openclaw-ci",
    codexSeccompProfile: profile,
  });

  assert.equal(configuration.drivers.compute.configuration.runtime.codexSeccompProfile, profile);
});

test("codex seccomp preparation fails closed for unverified Codex versions and foreign clusters", async () => {
  const execFile = async () => {
    throw new Error("execFile should not run before validation fails");
  };
  const cluster = {
    name: "openclaw-k8s-test",
    directory: "/tmp/openclaw-k8s-test-abcdef",
    kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
    context: "k3d-openclaw-k8s-test",
  };

  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile,
        codexVersion: "0.153.0",
      }),
    /reviewed Codex versions: 0\.152\.1, 0\.154\.0, 0\.156\.0, 0\.158\.0/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster: { ...cluster, name: "shared-cluster", context: "shared-cluster" },
        image: immutableImage,
        execFile,
      }),
    /run-owned openclaw-k8s k3d cluster/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        profileName: "openclaw\\codex-bwrap.json",
        execFile,
      }),
    /POSIX path separators/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster: {
          ...cluster,
          directory: "relative-openclaw-k8s-test",
          kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
        },
        image: immutableImage,
        execFile,
      }),
    /cluster\.directory must be absolute/,
  );
});

test("codex seccomp preparation requires a namespace/seccomp RuntimeDefault denial before node writes", async (t) => {
  const root = await fixture(t);
  const clusterDirectory = join(root, "openclaw-k8s-test-owned");
  await mkdir(clusterDirectory);
  const cluster = {
    name: "openclaw-k8s-test",
    directory: clusterDirectory,
    kubeconfig: join(clusterDirectory, "kubeconfig"),
    context: "k3d-openclaw-k8s-test",
  };
  const dockerCalls = [];
  const execFileForRuntimeDefaultFailure = (failure) => async (command, args) => {
    if (command === "kubectl") {
      if (args.includes("create") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("delete") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("apply")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("nodes")) {
        return {
          stdout: JSON.stringify({
            items: [{ metadata: { name: "k3d-openclaw-k8s-test-server-0" } }],
          }),
          stderr: "",
        };
      }
      if (args.includes("pod")) {
        return {
          stdout: JSON.stringify({
            metadata: { name: "runtime-default-probe" },
            status: {
              containerStatuses: [
                {
                  name: "probe",
                  ready: true,
                  containerID: "containerd://runtime-default-container",
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        const nonce = args.at(-1);
        assert.match(nonce, /^[a-f0-9]{32}$/);
        const error = failure(command, args);
        const stage = error.exitCode === 64 ? "VERSION" : "SANDBOX";
        error.stderr = `OCE_SANDBOX_PROBE_V1:${nonce}:START\n${error.stderr}\nOCE_SANDBOX_PROBE_V1:${nonce}:END:${stage}:${error.exitCode}\n`;
        error.signal = null;
        throw error;
      }
    }
    if (command === "docker") {
      dockerCalls.push(args);
      throw new Error("docker should not be reached");
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        // The current runtime must still reject unrelated setup failures before node writes.
        codexVersion: "0.163.0-alpha.1",
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const commandText = `${command} ${args.join(" ")}`;
          assert.match(commandText, /--namespace/);
          assert.match(commandText, /codex-seccomp-ok/);
          assert.match(commandText, /codex-seccomp-outside/);
          const error = new Error(`${commandText} failed: unrelated setup failure`);
          error.stderr = "unrelated setup failure";
          error.stdout = "";
          error.exitCode = 1;
          error.timedOut = false;
          return error;
        }),
      }),
    /unrelated setup failure/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const error = new Error(`${command} ${args.join(" ")} timed out after 195000ms`);
          error.stderr = "operation not permitted";
          error.stdout = "";
          error.exitCode = 1;
          error.timedOut = true;
          return error;
        }),
      }),
    /timed out after 195000ms/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const error = new Error(`${command} ${args.join(" ")} failed: version mismatch`);
          error.stderr = "Codex version mismatch: expected 0.158.0, got 0.152.1";
          error.stdout = "";
          error.exitCode = 64;
          error.timedOut = false;
          return error;
        }),
      }),
    /version mismatch/,
  );
  assert.deepEqual(dockerCalls, []);
});

test("codex seccomp preparation publishes a reviewed Docker profile for native smoke tests", async (t) => {
  const root = await fixture(t);
  const clusterDirectory = join(root, "openclaw-k8s-test-owned");
  await mkdir(clusterDirectory);
  const cluster = {
    name: "openclaw-k8s-test",
    directory: clusterDirectory,
    kubeconfig: join(clusterDirectory, "kubeconfig"),
    context: "k3d-openclaw-k8s-test",
  };
  const baseline = {
    defaultAction: "SCMP_ACT_ERRNO",
    architectures: ["SCMP_ARCH_X86_64"],
    syscalls: [{ names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }],
  };
  let installedProfile;
  const applied = new Map();
  const execFile = async (command, args) => {
    if (command === "kubectl") {
      if (args.includes("create") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("delete") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("apply")) {
        const manifest = JSON.parse(await readFile(args.at(-1), "utf8"));
        applied.set(manifest.metadata.name, manifest);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("nodes")) {
        return {
          stdout: JSON.stringify({
            items: [{ metadata: { name: "k3d-openclaw-k8s-test-server-0" } }],
          }),
          stderr: "",
        };
      }
      if (args.includes("pod")) {
        const name = args[args.indexOf("pod") + 1];
        const manifest = applied.get(name);
        const localhostProfile =
          manifest?.spec?.containers?.[0]?.securityContext?.seccompProfile?.localhostProfile;
        if (localhostProfile?.includes("missing-")) {
          const missingProfilePath = `/var/lib/kubelet/seccomp/${localhostProfile}`;
          return {
            stdout: JSON.stringify({
              metadata: { name },
              status: {
                containerStatuses: [
                  {
                    name: "probe",
                    state: {
                      waiting: {
                        reason: "CreateContainerError",
                        message: `failed to create containerd container: cannot load seccomp profile ${JSON.stringify(missingProfilePath)}: open ${missingProfilePath}: no such file or directory`,
                      },
                    },
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            metadata: { name },
            status: {
              containerStatuses: [
                {
                  name: "probe",
                  ready: true,
                  containerID: `containerd://${localhostProfile ? "installed" : "runtime-default"}`,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        const podName = args[args.indexOf("exec") + 1];
        const manifest = applied.get(podName);
        const nonce = args.at(-1);
        assert.match(nonce, /^[a-f0-9]{32}$/);
        if (!manifest?.spec?.containers?.[0]?.securityContext?.seccompProfile?.localhostProfile) {
          const error = new Error("RuntimeDefault denied bwrap namespace creation");
          error.stderr = `OCE_SANDBOX_PROBE_V1:${nonce}:START\noperation not permitted: bwrap clone namespace denied by seccomp\nOCE_SANDBOX_PROBE_V1:${nonce}:END:SANDBOX:1\n`;
          error.stdout = "";
          error.exitCode = 1;
          error.signal = null;
          error.timedOut = false;
          throw error;
        }
        return {
          stdout: "",
          stderr: `OCE_SANDBOX_PROBE_V1:${nonce}:START\nOCE_SANDBOX_PROBE_V1:${nonce}:ENTERED\nOCE_SANDBOX_PROBE_V1:${nonce}:END:DONE:0\n`,
          exitCode: 0,
          signal: null,
          timedOut: false,
        };
      }
    }
    if (command === "docker") {
      if (args[0] === "exec" && args[2] === "crictl" && args[3] === "inspect") {
        const seccomp = args[4] === "runtime-default" ? baseline : installedProfile;
        return {
          stdout: JSON.stringify({ info: { runtimeSpec: { linux: { seccomp } } } }),
          stderr: "",
        };
      }
      if (args[0] === "exec" && args[2] === "mkdir") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "cp") {
        installedProfile = JSON.parse(await readFile(args[1], "utf8"));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec" && args[2] === "chmod") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec" && args[2] === "sha256sum") {
        const data = `${JSON.stringify(installedProfile, null, 2)}\n`;
        const digest = createHash("sha256").update(data).digest("hex");
        return { stdout: `${digest}  ${args[4]}\n`, stderr: "" };
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  const seccomp = await prepareCodexSeccompProfile({
    cluster,
    image: immutableImage,
    execFile,
  });

  assert.equal(seccomp.profileName, "openclaw/codex-bwrap.json");
  assert.match(seccomp.profileSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    seccomp.dockerProfilePath,
    join(clusterDirectory, "docker-seccomp", `codex-0.163.0-alpha.1-${seccomp.profileSha256}.json`),
  );
  const profileData = await readFile(seccomp.dockerProfilePath, "utf8");
  assert.deepEqual(JSON.parse(profileData), installedProfile);
  assert.equal((await stat(seccomp.dockerProfilePath)).mode & 0o777, 0o644);
});

test("prepareLane fails closed instead of overwriting an existing CI state file", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    lane: "postgres",
    prefix: "openclaw-ci-local-existing-state",
    statePath,
    resources: [
      {
        id: "resource-1",
        kind: "compose-postgres",
        owner: "openclaw-ci-local-existing-state",
        name: "openclaw_ci_pg_existing_state_abcdef123456",
        composeFile: join(repositoryRoot, "compose.postgres.yaml"),
        port: 51234,
      },
    ],
  };
  await writeState(statePath, state);

  const result = runPrepare(["--lane", "helper-timeout", "--state", statePath]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CI state already exists/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("prepareLane pre-pulls logging and metrics images with retry and preserves its Node override", async (t) => {
  for (const failure of ["transient", "missing-manifest"]) {
    await t.test(failure, async (t) => {
      const root = await fixture(t);
      const statePath = join(root, "logging-state.json");
      const githubEnv = join(root, "github.env");
      const customNodeImage =
        "docker.io/library/node:24-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const collectorImage = loadYaml(
        await readFile(join(repositoryRoot, "compose.logging.yaml"), "utf8"),
      ).services.collector.image;
      // Images are absent until pulled; a registry 503 must retry, while a
      // missing Prometheus manifest must stop preparation before publishing env.
      // Two images are prepared concurrently, so the fake counts each image's
      // pulls in its own file: reading the shared call log while the other
      // image's process creates or appends to it can return an empty or torn line.
      const dockerPath = join(root, "docker");
      await writeFile(
        dockerPath,
        `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const log = ${JSON.stringify(join(root, "docker.jsonl"))};
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + "\\n");
const image = args.at(-1);
const pullLog = log + "." + createHash("sha256").update(image).digest("hex") + ".pulls";
const pulls = existsSync(pullLog) ? readFileSync(pullLog, "utf8").length : 0;
if (args[0] === "pull") {
  appendFileSync(pullLog, "p");
  if (process.env.CI_METRICS_PULL_FAILURE === "missing-manifest" && image === ${JSON.stringify(metricsMonitoringImages.prometheus)}) {
    process.stderr.write("Error response from daemon: manifest unknown\\n");
    process.exit(1);
  }
  if (process.env.CI_METRICS_PULL_FAILURE === "transient" && pulls === 0) {
    process.stderr.write("Error response from daemon: HTTP 503 Service Unavailable\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  if (pulls < (process.env.CI_METRICS_PULL_FAILURE === "transient" ? 2 : 1)) {
    process.stderr.write("Error response from daemon: No such image: " + image + "\\n");
    process.exit(1);
  }
  process.stdout.write(args[3] === "{{.Id}}" ? "sha256:${"e".repeat(64)}\\n" : JSON.stringify([image]));
  process.exit(0);
}
process.stderr.write("unexpected docker " + args.join(" ") + "\\n");
process.exit(2);
`,
        { mode: 0o700 },
      );

      const result = runPrepare(
        ["--lane", "logging-collector", "--state", statePath, "--github-env", githubEnv],
        {
          OCC_DOCKER_BIN: dockerPath,
          OCC_TEST_LOGGING_NODE_IMAGE: customNodeImage,
          CI_METRICS_PULL_FAILURE: failure,
        },
      );

      const pulls = (await readFile(join(root, "docker.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((args) => args[0] === "pull")
        .map((args) => args[1]);
      if (failure === "missing-manifest") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /manifest unknown/);
        assert.doesNotMatch(result.stderr, /Transient image pull failure/);
        assert.equal(
          pulls.filter((image) => image === metricsMonitoringImages.prometheus).length,
          1,
        );
        await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const exported = await readFile(githubEnv, "utf8");
      assert.match(exported, /OCC_TEST_LOGGING_COLLECTOR=1/);
      assert.match(exported, new RegExp(`OCC_TEST_LOGGING_NODE_IMAGE=${customNodeImage}`));
      // Every container image is prepared before the tests run; the real
      // pullImage classifier and retry loop handle the injected registry failure.
      assert.deepEqual(
        pulls.toSorted(),
        [collectorImage, customNodeImage, ...Object.values(metricsMonitoringImages)]
          .flatMap((image) => [image, image])
          .toSorted(),
      );
      assert.match(
        result.stderr,
        /Transient image pull failure \(Error response from daemon: HTTP 503/,
      );
    });
  }
});

test("every lane whose tests run the Codex sandbox prepares the reviewed Docker seccomp profile", async () => {
  // A test file that calls reviewedCodexSeccompSecurityOptions runs the stock
  // Codex sandbox under Docker. Its lane must prepare the reviewed profile, or
  // the helper throws in CI. This is derived from the files, not a lane list,
  // so moving such a case into another lane fails here first.
  const manifest = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  const callers = [];
  for (const [name, lane] of Object.entries(manifest.lanes)) {
    for (const { path } of lane.files) {
      const source = await readFile(join(repositoryRoot, path), "utf8");
      if (!/\breviewedCodexSeccompSecurityOptions\(/.test(source)) {
        continue;
      }
      callers.push(`${name}:${path}`);
      assert.equal(lane.prepare?.codexSeccomp, true, `${name} must set prepare.codexSeccomp`);
      assert.ok(
        lane.requiredEnv.includes("OCC_TEST_CODEX_SECCOMP_PROFILE"),
        `${name} must require OCC_TEST_CODEX_SECCOMP_PROFILE`,
      );
    }
  }
  // The Git broker case is a known caller; this keeps the scan from passing
  // vacuously if the helper is renamed.
  assert.ok(
    callers.includes("images-runtime-startup:tests/integration/runtime-image-startup.test.mjs"),
    callers.join(", "),
  );
  // Preparing the profile needs k3d, which only the full and k3d tool profiles install.
  const ciWorkflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const laneTable = /^ {10}LANE_TABLE: \|\n((?: {12}.*\n)+)/m.exec(ciWorkflow);
  assert.ok(laneTable, "ci.yml declares the CI Impact lane table");
  const fullIntegration = await readFile(
    join(repositoryRoot, ".github/workflows/full-integration.yml"),
    "utf8",
  );
  const toolProfiles = [
    ...JSON.parse(laneTable[1]).map(({ lane, profile }) => [`ci.yml ${lane}`, lane, profile]),
    ...[
      ...fullIntegration.matchAll(/- lane: ([a-z0-9-]+)\n\s+title: .*\n\s+profile: ([a-z]+)/g),
    ].map(([, lane, profile]) => [`full-integration.yml ${lane}`, lane, profile]),
  ];
  for (const [where, lane, profile] of toolProfiles) {
    if (manifest.lanes[lane]?.prepare?.codexSeccomp) {
      assert.ok(["full", "k3d"].includes(profile), `${where} needs the full or k3d tool profile`);
    }
  }
  assert.ok(
    toolProfiles.some(([where]) => where === "ci.yml images-runtime-startup"),
    "the tool profile scan finds runtime startup lane 1",
  );
});

test("prepareFile applies the images packaging Node base default without hiding invalid overrides", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "missing-state.json");
  const file = "tests/integration/docker-compute-token-retry.test.mjs";
  const customNodeBaseImage =
    "docker.io/library/node:24-bookworm@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  const defaulted = runPrepare(
    ["--lane", "images-packaging", "--file", file, "--state", statePath],
    {
      NODE_BASE_IMAGE: "",
    },
  );
  assert.equal(defaulted.status, 1);
  assert.match(defaulted.stderr, /requires a prior prepareLane/);

  const explicit = runPrepare(
    ["--lane", "images-packaging", "--file", file, "--state", statePath],
    {
      NODE_BASE_IMAGE: customNodeBaseImage,
    },
  );
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /requires a prior prepareLane/);

  const invalid = runPrepare(["--lane", "images-packaging", "--file", file, "--state", statePath], {
    NODE_BASE_IMAGE: "docker.io/library/node:24-bookworm",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /NODE_BASE_IMAGE must be an immutable/);
});

test("provider-account preparation accepts absent image inputs before prepared state exists", async (t) => {
  const root = await fixture(t);
  const adminKeyPath = join(root, "chatgpt-admin.key");
  const statePath = join(root, "missing-state.json");
  await writeFile(adminKeyPath, "admin key\n", { mode: 0o600 });
  await chmod(adminKeyPath, 0o600);

  const result = runPrepare(
    [
      "--lane",
      "provider-account",
      "--file",
      "tests/integration/service-account-driver-real.test.mjs",
      "--state",
      statePath,
    ],
    {
      OCC_TEST_OPENAI_MODEL: "gpt-test",
      OCC_TEST_CHATGPT_WORKSPACE_ID: "workspace-test",
      OCC_TEST_CHATGPT_ADMIN_KEY_PATH: adminKeyPath,
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "",
      OCC_TEST_KUBERNETES_AGENT_IMAGE: "",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a prior prepareLane/);
  assert.doesNotMatch(result.stderr, /OCC_TEST_KUBERNETES_.*IMAGE/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("prepareLane rejects mutable Kubernetes image inputs before creating state", async (t) => {
  const root = await fixture(t);
  const adminKeyPath = join(root, "admin.key");
  await writeFile(adminKeyPath, "admin key\n", { mode: 0o600 });
  await chmod(adminKeyPath, 0o600);

  const optionalKubernetesImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "",
    OCC_TEST_KUBERNETES_AGENT_IMAGE: "",
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "",
    OCC_TEST_KUBERNETES_CODEX_IMAGE: "",
  };
  const baseModelEnv = {
    OPENAI_API_KEY: "test-openai-key",
    OCC_TEST_OPENAI_MODEL: "gpt-test",
  };
  const k3dImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
  };
  const cases = [
    {
      lane: "k3d-model",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      },
    },
    {
      lane: "k3d-otel",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "gateway-routing",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        NODE_BASE_IMAGE: nodeBaseImage,
        OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "slack",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_SLACK_PROXY_URL: "http://127.0.0.1:3000",
        OCC_TEST_SLACK_CHANNEL_ID: "C0123456789",
        OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
    },
    {
      lane: "provider-account",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...k3dImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
        OCC_TEST_OPENAI_MODEL: "gpt-test",
        OCC_TEST_CHATGPT_WORKSPACE_ID: "workspace-test",
        OCC_TEST_CHATGPT_ADMIN_KEY_PATH: adminKeyPath,
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_KEYCLOAK_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
        OCC_TEST_KEYCLOAK_IMAGE: mutableImage,
      },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const statePath = join(root, `state-${index}.json`);
    const result = runPrepare(["--lane", testCase.lane, "--state", statePath], testCase.env);

    assert.equal(result.status, 1, `${testCase.lane} unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`${testCase.envName} must be an immutable`));
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  }
});

for (const scenario of [
  { stage: "database-create", failure: "exit", exitCode: 42, signal: null },
  { stage: "database-schema", failure: "exit", exitCode: 43, signal: null },
  { stage: "database-migrate", failure: "exit", exitCode: 44, signal: null },
  { stage: "database-migrate", failure: "spawn" },
  { stage: "database-migrate", failure: "signal", exitCode: null, signal: "SIGTERM" },
]) {
  test(`PostgreSQL preparation identifies ${scenario.stage} ${scenario.failure}`, async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const commandsPath = join(root, "commands.jsonl");
    const dockerPath = join(root, "docker.mjs");
    const corepackPath = join(root, "corepack.mjs");
    const prefix = "openclaw-ci-diagnostics";
    await writeState(statePath, {
      version: 1,
      repositoryRoot,
      lane: "postgres-application",
      prefix,
      statePath,
      resources: [
        {
          id: "compose-postgres-diagnostics",
          kind: "compose-postgres",
          owner: prefix,
          status: "ready",
          name: "openclaw_ci_pg_diagnostics",
          composeFile: join(repositoryRoot, "compose.postgres.yaml"),
          port: 45431,
        },
      ],
    });
    const commandSource = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const stage = args[0] === "pnpm" ? "database-migrate" :
  args.at(-1).startsWith("CREATE DATABASE") ? "database-create" : "database-schema";
appendFileSync(process.env.CI_DIAGNOSTIC_COMMANDS, JSON.stringify(stage) + "\\n");
if (stage === ${JSON.stringify(scenario.stage)}) {
  process.stdout.write("secret-canary-stdout");
  process.stderr.write("secret-canary-stderr");
  ${scenario.failure === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${scenario.exitCode ?? 45});`}
}
`;
    await writeFile(dockerPath, commandSource, { mode: 0o700 });
    if (scenario.failure !== "spawn") {
      await writeFile(corepackPath, commandSource, { mode: 0o700 });
    }
    const program = `
import assert from "node:assert/strict";
const { prepareFile } = await import(process.argv[1]);
await assert.rejects(() => prepareFile({ lane: "postgres-application",
  file: "tests/integration/postgres-platform-state.test.mjs", statePath: process.argv[2] }),
  error => {
    assert.equal(error.code, "CI_PREPARATION_COMMAND_FAILED");
    assert.equal(error.stage, ${JSON.stringify(scenario.stage)});
    assert.equal(error.failure, ${JSON.stringify(scenario.failure)});
    ${scenario.failure === "spawn" ? "" : `assert.equal(error.exitCode, ${JSON.stringify(scenario.exitCode)}); assert.equal(error.signal, ${JSON.stringify(scenario.signal)}); assert.equal(error.timedOut, false);`}
    return true;
  });
`;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        program,
        new URL("../../scripts/ci/prepare.mjs", import.meta.url).href,
        statePath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: root,
          OCC_DOCKER_BIN: dockerPath,
          OPENCLAW_CI_COREPACK_BIN: corepackPath,
          CI_DIAGNOSTIC_COMMANDS: commandsPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const commands = (await readFile(commandsPath, "utf8")).trim().split("\n").map(JSON.parse);
    const expected = ["database-create", "database-schema", "database-migrate"];
    assert.deepEqual(
      commands,
      expected.slice(0, scenario.failure === "spawn" ? 2 : expected.indexOf(scenario.stage) + 1),
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.notEqual(
      state.resources.find(({ kind }) => kind === "postgres-database").status,
      "ready",
    );
  });
}
