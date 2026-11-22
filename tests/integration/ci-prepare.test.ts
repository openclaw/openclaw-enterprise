import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { metricsMonitoringImages } from "../../scripts/ci/metrics-monitoring-images.ts";
import { defaultK3sImage, prepareLane, prepareFile } from "../../scripts/ci/prepare.ts";
import { registerNativeProfileUpgradeCases } from "./ci-prepare-native-profile-upgrade-cases.ts";
import { withStateLock } from "../../scripts/ci/state-lock.ts";
import { listen } from "../helpers/listen.ts";
import {
  assertStderrMatch,
  composePostgres,
  fixture,
  fixtureCommandServer,
  fixtureImageCommands,
  fixturePreparationMetrics,
  forwardedEnv,
  immutableImage,
  mutableImage,
  nodeBaseImage,
  spawnResult,
  writeFixtureCommand,
  writePostgresState,
} from "../helpers/ci-prepare-fixture.ts";
import { loadYaml } from "../helpers/kubernetes-yaml.ts";
import { waitUntil } from "../helpers/wait-for.ts";
import { startFakePostgres, type FakePostgresQuery } from "../helpers/fake-postgres-server.ts";
import type { TestContext } from "node:test";
import { registerAdvisoryCases } from "./ci-prepare-advisory-cases.ts";
import { registerSeccompCases } from "./ci-prepare-seccomp-cases.ts";
import {
  collectorImage,
  getGroup,
  getJob,
  getLane,
  loadSuites,
  parseActionSteps,
  parseWorkflow,
  readCommandLines,
  tuples,
} from "./ci-prepare-inputs.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preparePath = join(repositoryRoot, "scripts/ci/prepare.ts");
const packagingNodeBaseImage = JSON.parse(
  await readFile(join(repositoryRoot, "scripts/ci/test-suites/images-packaging.json"), "utf8"),
).prepare.defaultEnv.NODE_BASE_IMAGE;

registerNativeProfileUpgradeCases({ repositoryRoot, writeState });

async function writeState(path: string, state: unknown) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("focused first-Agent preparation leaves installation to Local Setup and refuses another file", async (t) => {
  const root = await fixture(t);
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
    OCC_HELM_BIN: process.env.OCC_HELM_BIN,
    OCC_TEST_OPENAI_MODEL: process.env.OCC_TEST_OPENAI_MODEL,
  };
  // Fail before side effects if generic stack preparation is accidentally restored.
  process.env.OCC_HELM_BIN = join(root, "unavailable-helm");
  process.env.OPENAI_API_KEY = "synthetic-model-credential";
  delete process.env.CODEX_ACCESS_TOKEN;
  process.env.OCC_TEST_OPENAI_MODEL = "synthetic-model";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  const suites = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await mkdir(join(root, "tests/integration"), { recursive: true });
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    `export { prepareFile } from ${JSON.stringify(new URL("../../scripts/ci/prepare.ts", import.meta.url).href)};`,
  );
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ version: 1, lanes: { openshell: getLane(suites, "openshell") }, groups: {} }),
  );
  for (const file of [
    "tests/integration/local-first-agent-openshell-real.test.mjs",
    "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
  ]) {
    const statePath = join(root, `${file.split("/").at(-1)}.json`);
    const lane = await prepareLane({ lane: "openshell", statePath, file });
    const prepared = await prepareFile({ lane: "openshell", statePath, file });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.resources, []);
    assert.equal(prepared.env.OCC_TEST_DATABASE_URL, undefined);
    assert.equal(prepared.env.OCC_TEST_KUBERNETES_CONTEXT, undefined);
    assert.equal(prepared.defaults.OCC_TEST_LOCAL_FIRST_AGENT_REAL, "1");
    await assert.rejects(
      prepareFile({
        lane: "openshell",
        statePath,
        file: file.endsWith("-k3d-real.test.mjs")
          ? "tests/integration/local-first-agent-openshell-real.test.mjs"
          : "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
      }),
      /Selected file must match/,
    );
    // Use canonical metadata and the real preparer/runner; only the child body is a
    // sentinel. This proves API-key-only runner admission, not a model turn.
    const testName = getLane(suites, "openshell").files.find(({ path }) => path === file)
      ?.expectedTests?.[0];
    assert.ok(testName);
    await writeFile(
      join(root, file),
      `import assert from "node:assert/strict"; import test from "node:test";
      test(${JSON.stringify(testName)}, () => {
        assert.equal(process.env.OPENAI_API_KEY, "synthetic-model-credential");
        assert.ok(!process.env.CODEX_ACCESS_TOKEN);
      });`,
    );
    const resultsPath = `${statePath}.results.json`;
    const result = await spawnResult(
      process.execPath,
      [
        join(repositoryRoot, "scripts/ci/run-tests.ts"),
        "run",
        "openshell",
        "--root",
        root,
        "--manifest",
        "manifest.json",
        "--state",
        statePath,
        "--results",
        resultsPath,
        "--file",
        file,
        "--test-name",
        testName,
      ],
      {
        env: {
          ...process.env,
          GITHUB_SHA: "a".repeat(40),
          GIT_CEILING_DIRECTORIES: root,
          CI_RUNNER_DEADLINE_MS: "",
          CODEX_ACCESS_TOKEN_FILE: "",
          OCC_CI_SUITE_VIEW: "default",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(receipt.files[0].tests[0].status, "passed");
    assert.deepEqual(receipt.files[0].issues, []);
    assert.ok(prepared.cleanup);
    await prepared.cleanup();
    await lane.cleanup();
  }
  await assert.rejects(
    prepareLane({
      lane: "openshell",
      statePath: join(root, "invalid.json"),
      file: "tests/integration/not-a-lane-file.test.ts",
    }),
    /Selected file must belong/,
  );
});

// A fake lane PostgreSQL server for one case (fake-postgres-server.ts), stopped after it.
// Each query is also appended to logPath as "postgres\t<database>\t<query>", beside the
// fake commands' lines.
async function laneFakePostgres(
  t: TestContext,
  { logPath, onQuery = () => undefined }: { logPath?: string; onQuery?: FakePostgresQuery } = {},
) {
  const postgres = await startFakePostgres({
    onQuery: async (query, session) => {
      if (logPath) {
        await appendFile(logPath, `postgres\t${session.database}\t${query}\n`);
      }
      return onQuery(query, session);
    },
  });
  t.after(() => postgres.close());
  return postgres;
}

// Every session reached the lane server as the superuser compose.postgres.yaml creates.
async function assertSuperuserSessions(postgres: Awaited<ReturnType<typeof startFakePostgres>>) {
  const compose = await readFile(join(repositoryRoot, "compose.postgres.yaml"), "utf8");
  const match = compose.match(/POSTGRES_PASSWORD: (\S+)/);
  assert.ok(match?.[1]);
  const password = match[1];
  assert.ok(postgres.sessions.length > 0);
  for (const { user, password: sent } of postgres.sessions) {
    assert.equal(user, "postgres");
    assert.equal(sent, password);
  }
}

// Runs a module program that imports prepare.ts (argv[1]) and uses the state at argv[2].
function runProgram(program: string, statePath: string, env: NodeJS.ProcessEnv, timeout?: number) {
  const prepare = new URL("../../scripts/ci/prepare.ts", import.meta.url).href;
  return spawnResult(process.execPath, ["--input-type=module", "-e", program, prepare, statePath], {
    env,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

// prepare.ts appends to $GITHUB_ENV when no --github-env is given, and in CI that is the job's
// own file, so a case passes GITHUB_ENV or GITHUB_OUTPUT on only when it sets them (finding 1216).
function runPrepare(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnResult(process.execPath, [preparePath, ...args], {
    env: { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "", ...env },
  });
}

function modelPreparationNotices(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("::notice title=k3d Model Runtime preparation::"))
    .map((line) => {
      const match =
        /^::notice title=k3d Model Runtime preparation::stage=([a-z0-9-]+) elapsed_ms=\d+ outcome=(success|failure)$/.exec(
          line,
        );
      assert.ok(match, line);
      assert.ok(match[1] && match[2]);
      return [match[1], match[2]];
    });
}

function modelImageRoleNotices(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("::notice title=k3d Model Runtime image::"))
    .map((line) => {
      const match =
        /^::notice title=k3d Model Runtime image::role=(controller|runtime) elapsed_ms=\d+ outcome=(success|failure)$/.exec(
          line,
        );
      assert.ok(match, line);
      assert.ok(match[1] && match[2]);
      return [match[1], match[2]];
    })
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

test("model preparation notices follow completed CLI phases", async (t) => {
  const commands = await fixtureImageCommands(t, "local-digest", "k3d-model", {
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "a".repeat(40),
    OPENAI_API_KEY: "synthetic-model-key",
    OCC_TEST_OPENAI_MODEL: "synthetic-model",
    NODE_BASE_IMAGE: nodeBaseImage,
    OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
  });
  const prepared = await commands.prepare();
  assert.equal(prepared.status, 1, prepared.stderr);
  // The fixture kubectl refuses the seccomp namespace, the first step after image import.
  assertStderrMatch(prepared.stderr, /create namespace .* failed/);
  assert.deepEqual(modelPreparationNotices(prepared.stderr), [
    ["k3d-cluster-preparation", "success"],
    ["postgres-start", "success"],
    ["runtime-image-preparation", "failure"],
  ]);
  assert.deepEqual(modelImageRoleNotices(prepared.stderr), []);
  assert.doesNotMatch(prepared.stderr, /^::notice title=Production Observability timing::/m);
  await commands.cleanupSuccessfully();
});

test("model image notices time only requested builds and preserve each outcome", async (t) => {
  for (const [scenario, suppliedPair] of tuples([
    ["save-failed", false],
    ["controller-build-failed", false],
    ["save-failed", true],
  ])) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "synthetic-model-key",
      OCC_TEST_OPENAI_MODEL: "synthetic-model",
      NODE_BASE_IMAGE: nodeBaseImage,
      ...(suppliedPair
        ? {
            OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
            OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
          }
        : {}),
    });
    // The shared fake recognizes controller builds under its buildx spelling.
    // Adapt only the plain controller command issued by this lane at the fake boundary.
    const bin = join(dirname(commands.statePath), "bin");
    const adapter = join(bin, "model-docker");
    await writeFile(
      adapter,
      `#!/bin/sh
if [ "$1" = build ]; then
  if [ "$3" = --target ]; then
    role=controller
    peer=runtime
    set -- buildx "$@"
  else
    role=runtime
    peer=controller
  fi
  if [ "$WAIT_FOR_PEER" = 1 ]; then
    : > "$TMPDIR/$role.started"
    tries=0
    while [ ! -f "$TMPDIR/$peer.started" ]; do
      [ "$tries" -lt 100 ] || { echo "peer build never started" >&2; exit 1; }
      /bin/sleep 0.05
      tries=$((tries + 1))
    done
  fi
fi
exec docker.mjs "$@"
`,
      { mode: 0o700 },
    );
    // Both requested builds must start before either command can finish.
    const result = await commands.prepare([], {
      env: { OCC_DOCKER_BIN: adapter, WAIT_FOR_PEER: suppliedPair ? "0" : "1" },
    });
    assert.equal(result.status, 1, result.stderr);
    const failed = scenario === "controller-build-failed";
    assertStderrMatch(
      result.stderr,
      failed ? /synthetic build failure/ : /synthetic export failure/,
    );
    assert.deepEqual(modelImageRoleNotices(result.stderr), [
      ["controller", failed ? "failure" : "success"],
      ...(suppliedPair ? [] : [["runtime", "success"]]),
    ]);
    await commands.cleanupSuccessfully();
  }
});

test("model preparation notices preserve outcomes and require Actions and a known stage", async (t) => {
  const root = await fixture(t);
  const result = await runProgram(
    `import assert from "node:assert/strict";
     const { timedK3dModelPreparation: time } = await import(process.argv[1]);
     const value = {};
     const failure = new Error("synthetic-private-detail");
     assert.equal(await time("k3d-model", "postgres-start", () => value), value);
     await assert.rejects(time("k3d-model", "gateway-routing", async () => { throw failure; }), error => error === failure);
     await time("k3d-model", "unknown-stage", () => value);
     await time("k3d-otel", "gateway-routing", () => value);
     delete process.env.GITHUB_ACTIONS;
     await time("k3d-model", "controller", () => value);
     await time("k3d-model", "postgres-start", () => value);`,
    join(root, "state.json"),
    { GITHUB_ACTIONS: "true" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /synthetic-private-detail|lane=k3d-otel/);
  assert.deepEqual(modelImageRoleNotices(result.stderr), []);
  assert.deepEqual(modelPreparationNotices(result.stderr), [
    ["postgres-start", "success"],
    ["gateway-routing", "failure"],
  ]);
});

test("Production Observability notices retain a failed preparation phase", async (t) => {
  const root = await fixture(t);
  const docker = join(root, "docker");
  const lane = "k3d-observability";
  const sha = "a".repeat(40);
  const canary = "synthetic-observability-command-failure";
  // A missing executable inside the first timed phase must leave the
  // phase red without disclosing the command path in the notice.
  await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' '${canary}' >&2\nexit 48\n`, { mode: 0o700 });
  const result = await spawnResult(
    process.execPath,
    [preparePath, "--lane", lane, "--state", join(root, "state.json")],
    {
      env: {
        PATH: root,
        TMPDIR: root,
        OCC_HELM_BIN: "/bin/true",
        OCC_DOCKER_BIN: docker,
        OPENCLAW_CI_K3D_BIN: "/bin/true",
        OCC_KUBECTL_BIN: join(root, canary),
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: sha,
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assertStderrMatch(result.stderr, new RegExp(canary));
  assert.match(
    result.stderr,
    /\[ci-timing\] lane=k3d-observability phase=cluster-build-pull duration_ms=\d+/,
  );
  const notices = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("::notice title=Production Observability timing::"));
  const binding = `::notice title=Production Observability timing::lane=${lane} run_id=12345 run_attempt=2 source_sha=${sha} phase=cluster-build-pull`;
  assert.equal(notices.length, 2, "failed preparation must publish one start and one terminal");
  assert.equal(notices[0], `${binding} event=start`);
  assert.match(
    notices[1] ?? "",
    new RegExp(`^${binding} event=finish outcome=failure elapsed_ms=[0-9]+$`),
  );
});

test("Production Observability notices accept only fixed outcomes for each phase", async () => {
  const noticeModule = new URL("../../scripts/ci/observability-phase-notice.ts", import.meta.url);
  // An untyped caller can supply values outside the TypeScript outcome union.
  const probe = `const { startObservabilityPhase } = await import(process.argv[1]);
const [phase, outcome] = process.argv.slice(2);
startObservabilityPhase("k3d-observability", phase)(outcome, 5);`;

  const canary = "synthetic-outcome-canary";
  const preparePhase = "workload-image-imports";
  const cleanupPhase = "lane-cleanup";
  const sha = "a".repeat(40);
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: sha,
  };

  for (const [phase, outcome, terminal] of tuples([
    [preparePhase, `failure\n::notice::${canary}`],
    [preparePhase, `failure%0A::notice::${canary}`],
    [cleanupPhase, "unknown"],
    [preparePhase, "skipped"],
    [preparePhase, "success", "success elapsed_ms=5"],
    [preparePhase, "failure", "failure elapsed_ms=5"],
    [cleanupPhase, "skipped", "skipped"],
  ])) {
    const result = await spawnResult(
      process.execPath,
      ["--input-type=module", "-e", probe, noticeModule.href, phase, outcome],
      { env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /^::notice::/m, "unexpected workflow command");
    assert.doesNotMatch(result.stderr, new RegExp(canary), "unexpected outcome text");
    const binding = `::notice title=Production Observability timing::lane=k3d-observability run_id=12345 run_attempt=2 source_sha=${sha} phase=${phase}`;
    const expected = [`${binding} event=start\n`];
    if (terminal) {
      expected.push(`${binding} event=finish outcome=${terminal}\n`);
    }
    assert.equal(result.stderr, expected.join(""), `unexpected notices for ${phase} ${outcome}`);
  }
});

// Most cases wait on preparation children: fake engines, deliberate command timeouts
// and retry backoff, so a few run at once: two per CPU, at most four. With four copies
// of this file on one CPU, four at once still passed, while all at once missed the 3 s
// command timeouts. More than four only takes CPU from the lane's other files.
const concurrency = Math.min(4, 2 * availableParallelism());

describe("CI preparation", { concurrency }, () => {
  for (const { scenario, error } of [
    { scenario: "success" },
    { scenario: "podman-success" },
    { scenario: "docker-manifest" },
    // An index digest can agree across nodes without identifying a platform image.
    { scenario: "oci-index", error: /Imported.*does not identify an image manifest/ },
    { scenario: "docker-manifest-list", error: /Imported.*does not identify an image manifest/ },
    { scenario: "delayed-overlay-route" },
    { scenario: "missing-tag", error: /Unable to find imported OCI manifest digest/ },
    {
      scenario: "missing-alias",
      error: /canonical image not found/,
    },
    { scenario: "missing-cri", error: /synthetic CRI image not found/ },
    { scenario: "missing-worker-cri", error: /synthetic CRI image not found/ },
    { scenario: "lagging-worker-cri" },
    // A present image may still await the CRI label event, but missing retention
    // must never publish successful offline workload inputs.
    { scenario: "lagging-worker-pin" },
    { scenario: "lagging-worker-missing-pin" },
    // Malformed CRI fields are not delayed cache or pin observations.
    { scenario: "string-worker-cri-digests", error: /CRI.*does not match the imported.*digest/ },
    { scenario: "mixed-worker-cri-digests", error: /CRI.*does not match the imported.*digest/ },
    { scenario: "malformed-worker-cri-pin", error: /CRI.*reported a malformed.*pin/ },
    // The worker must independently match containerd even if CRI would agree.
    {
      scenario: "wrong-worker-containerd-digest",
      error: /containerd.*does not match the imported.*digest/,
    },
    { scenario: "unpinned-worker-cri", error: /CRI.*did not report the imported.*image pinned/ },
    { scenario: "wrong-worker-cri-digest", error: /CRI.*does not match the imported.*digest/ },
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
      const result = await commands.prepare();
      assert.equal(result.error, undefined);
      const state = await commands.readState();

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
          assert.ok(
            typeof ready.elapsedMs === "number" &&
              Number.isFinite(ready.elapsedMs) &&
              ready.elapsedMs >= 0,
          );
          assert.ok(metrics.some(({ stage }) => stage === "k3d-host-before"));
          assert.ok(metrics.some(({ stage }) => stage === "k3d-host-after"));
        }
      }

      const cluster = state.resources.find((resource) => resource.kind === "k3d-cluster");
      assert.ok(cluster);
      assert.ok(cluster.name && cluster.directory);
      assert.equal(cluster.nodeImage, defaultK3sImage);
      assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
      const localImage = state.resources.find((resource) => resource.kind === "image-tag");
      const importedImage = state.resources.find((resource) => resource.kind === "k3d-image");
      assert.ok(localImage?.name && importedImage);
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
      if (scenario === "success") {
        // The lane's disposable PostgreSQL server gives up durability right after it
        // starts, before any database is created or migrated, over its published port.
        const started = preparation.findIndex(
          ({ command, args }) =>
            command === "docker" &&
            args[0] === "compose" &&
            args.slice(5).join(" ") === "up -d --wait",
        );
        assert.notEqual(started, -1, "preparation starts its PostgreSQL server");
        // k3d must not probe a released API port until Docker has published
        // PostgreSQL's allocation; otherwise the daemon can take that number.
        const published = preparation.findIndex(
          ({ command, args }) =>
            command === "docker" &&
            args[0] === "inspect" &&
            args.includes("{{json .NetworkSettings.Ports}}"),
        );
        const clusterStarted = preparation.findIndex(({ command }) => command === "k3d");
        assert.ok(published > started && clusterStarted > published);

        const sql = (entries: typeof preparation) =>
          entries.filter(({ command }) => command === "postgres").map(({ args }) => args);
        assert.deepEqual(sql(preparation.slice(0, started)), [], "no SQL before the server");
        assert.deepEqual(sql(preparation.slice(started)).slice(0, 4), [
          ["postgres", "ALTER SYSTEM SET fsync = off"],
          ["postgres", "ALTER SYSTEM SET synchronous_commit = off"],
          ["postgres", "ALTER SYSTEM SET full_page_writes = off"],
          ["postgres", "SELECT pg_catalog.pg_reload_conf()"],
        ]);
        assert.ok(
          preparation
            .slice(started)
            .every(
              ({ command, args }) =>
                command !== "docker" || !args.includes("exec") || args[0] !== "compose",
            ),
          "no docker compose exec for SQL",
        );
      }
      const criLookups = (suffix: string) =>
        preparation.filter(
          ({ args }) => args[1] === `k3d-${cluster.name}-${suffix}` && args[2] === "crictl",
        ).length;
      // Cache misses and valid unpinned observations can lag containerd events;
      // malformed fields and identity mismatches stay final on the first lookup.
      const expectedWorkerLookups = {
        "missing-worker-cri": 1,
        "lagging-worker-cri": 3,
        "lagging-worker-pin": 3,
        "lagging-worker-missing-pin": 3,
        "string-worker-cri-digests": 1,
        "mixed-worker-cri-digests": 1,
        "malformed-worker-cri-pin": 1,
        "wrong-worker-containerd-digest": 0,
        "oci-index": 0,
        "docker-manifest-list": 0,
        "wrong-worker-cri-digest": 1,
        "hung-worker-cri": 1,
      }[scenario];
      if (expectedWorkerLookups !== undefined) {
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
          [...result.stderr.matchAll(/\(attempt (\d+)\); retrying\./g)].map(
            ([, attempt]) => attempt,
          ),
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
        const first = times[0];
        const last = times.at(-1);
        assert.ok(first !== undefined && last !== undefined);
        assert.ok(last - first >= 2_500, `CRI lookups spanned ${last - first} ms`);
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
        assert.ok(state.env);
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

      const cleanup = await commands.cleanup();
      assert.equal(cleanup.error, undefined);
      assert.equal(cleanup.status, 0, cleanup.stderr);
      await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
      const clusterDirectory = cluster.directory;
      assert.ok(clusterDirectory);
      await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
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
      assert.ok(
        clusterRemoval > importedRemoval,
        "the cluster must outlive imported image cleanup",
      );
    });
  }

  // The fakes' command server listens on loopback, where any local user can connect. It
  // must run nothing for a request without its client token (the same request with the
  // token writes the metadata file), and a shim must run nothing from another listener.
  test("the fake command server and its shims run nothing for each other's impostors", async (t) => {
    const root = await fixture(t);
    const server = await fixtureCommandServer(t, root);
    const metadata = join(root, "metadata.json");
    const args = [
      "buildx",
      "build",
      "--output",
      "type=image,push=false,store=false",
      "--provenance=false",
      "--metadata-file",
      metadata,
      ".",
    ];
    // A shim's complete request: its argv, then each forwarded variable ("=" + value if set).
    const env = forwardedEnv.map((name) => (name === "CI_FIXTURE_SCENARIO" ? "=success" : ""));
    const request = (token: string[]) =>
      new Promise<string>((resolve, reject) => {
        const fields = [...token, "docker", root, String(args.length), ...args, ...env];
        let reply = "";
        const socket = connect(server.port, "127.0.0.1", () =>
          socket.write(fields.map((field) => field + "\0").join("")),
        );
        socket.setTimeout(30_000, () => {
          socket.destroy();
          reject(new Error("the command server neither answered nor closed the connection"));
        });
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (reply += chunk));
        // The server may reset the connection it refuses.
        socket.on(
          "error",
          (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" || reject(error),
        );
        socket.on("close", () => resolve(reply));
      });
    // The protocol without a token, a wrong token, and the server token sent back.
    for (const token of [[], ["0".repeat(64)], [server.serverToken]]) {
      assert.equal(await request(token), "", "an unauthenticated client gets no reply");
    }
    // Read, not stat: nothing was written, and no check precedes the read below.
    await assert.rejects(readFile(join(root, "commands.jsonl")), { code: "ENOENT" });
    await assert.rejects(readFile(metadata), { code: "ENOENT" });
    const served = await request([server.clientToken]);
    assert.match(served, new RegExp(`^${server.serverToken}\n[^]*exit 0\n$`));
    assert.equal(
      JSON.parse(await readFile(metadata, "utf8"))["containerimage.config.digest"],
      "sha256:" + "f".repeat(64),
    );

    // A listener that is not the fixture's server, as if another user took the port.
    const impostor = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("printf impostor-ran\nexit 0\n"));
    });
    const impostorPort = await listen(t, impostor);
    const misdirected = join(root, "misdirected-docker");
    await writeFixtureCommand(misdirected, "docker", server, impostorPort);
    const refused = await spawnResult(misdirected, ["version"], {
      env: { PATH: "/nonexistent", CI_FIXTURE_SCENARIO: "success" },
    });
    assert.equal(refused.status, 125);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /fixture command server did not authenticate/);
  });

  test("ordinary k3d preparation rejects mutable K3s overrides before creating state", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const result = await runPrepare(["--lane", "k3d-fixture-state", "--state", statePath], {
      OPENCLAW_CI_K3S_IMAGE: "rancher/k3s:latest",
      OCC_DOCKER_BIN: join(root, "no-docker-command"),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENCLAW_CI_K3S_IMAGE must be an immutable/);
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  });

  test("PostgreSQL CI selects and contains the per-file IAM barrier fixture", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const logPath = join(root, "fake-commands.log");
    const corepackPath = join(root, "fake-corepack.mjs");
    const postgres = await laneFakePostgres(t);
    await writePostgresState(statePath, composePostgres("synthetic", postgres.port));
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
  file: "tests/integration/postgres-native-iam-policy-barrier.test.ts",
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
const databases = (state) => state.resources.filter((resource) => resource.kind === "postgres-database" && resource.laneTemplate === undefined);
const prepared = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(databases(prepared).length, 1);
await selected.cleanup();
const settled = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(databases(settled).length, 0);
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
// The server and its lane template, which lane cleanup drops.
assert.deepEqual(finalState.resources.map(({ kind, laneTemplate }) => [kind, laneTemplate]), [["compose-postgres", undefined], ["postgres-database", "ci"]]);
`;
    const fakeEnv = {
      PATH: root,
      LANG: "C",
      // SQL reaches the server over its port; no container engine command runs.
      OCC_DOCKER_BIN: join(root, "must-not-run"),
      OPENCLAW_CI_COREPACK_BIN: corepackPath,
      CI_SYNTHETIC_LOG: logPath,
    };
    const result = await runProgram(program, statePath, fakeEnv, 20_000);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const sessions = () => [
      ...postgres.sessionLines(),
      ...readFileSync(logPath, "utf8").trim().split("\n"),
    ];
    const commandLog = sessions();
    // One migrated lane template, then a copy per file, each copy one session.
    assert.equal(commandLog.length, 7);
    assert.equal(commandLog.filter((line) => line.startsWith("migrate\t")).length, 1);
    const createCommands = commandLog.filter((line) => line.includes("CREATE DATABASE"));
    const dropCommands = commandLog.filter((line) => line.includes("DROP DATABASE"));
    assert.equal(createCommands.length, 3);
    assert.equal(createCommands.filter((line) => line.includes(" TEMPLATE ")).length, 2);
    assert.equal(dropCommands.length, 2);
    assert.ok(createCommands.every((line) => line.startsWith("postgres\tCREATE DATABASE ")));
    const githubEnv = join(root, "github.env");
    // Neither GITHUB_ENV nor --github-env may publish the barrier outside the runner.
    for (const [env, extra] of tuples([
      [{ ...fakeEnv, GITHUB_ENV: githubEnv }, []],
      [fakeEnv, ["--github-env", githubEnv]],
    ])) {
      const blocked = await spawnResult(
        process.execPath,
        [
          preparePath,
          "--lane",
          "postgres-application",
          "--file",
          "tests/integration/postgres-native-iam-policy-barrier.test.ts",
          "--state",
          statePath,
          ...extra,
        ],
        { timeout: 20_000, env },
      );
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /must be prepared within the test runner/);
      await assert.rejects(() => stat(githubEnv), { code: "ENOENT" });
    }
    assert.equal(sessions().length, 7);
  });

  test("prepareFile copies a per-test database from a ready template it owns without migrating", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const logPath = join(root, "fake-commands.log");
    const corepackPath = join(root, "fake-corepack.mjs");
    const postgres = await laneFakePostgres(t, { logPath });
    const server = composePostgres("synthetic", postgres.port);
    const database = (name: string, extra: Record<string, string | number> = {}) => ({
      id: `postgres-database-${name}`,
      kind: "postgres-database",
      owner: server.owner,
      status: "ready",
      name,
      composeProject: server.name,
      port: server.port,
      ...extra,
    });
    await writePostgresState(
      statePath,
      server,
      database("openclaw_ci_foreign_owner", { owner: "openclaw-ci-other" }),
      database("openclaw_ci_planned", { status: "planned" }),
      database("openclaw_ci_other_project", { composeProject: "openclaw_ci_pg_other" }),
      database("openclaw_ci_other_port", { port: 45432 }),
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
const laneTemplate = prepared.resources.find((resource) => resource.laneTemplate === "ci").name;
console.error(laneTemplate + " " + new URL(template.env.OCC_TEST_DATABASE_URL).pathname.slice(1) + " " + copied.pathname.slice(1));
`;
    const result = await runProgram(
      program,
      statePath,
      {
        PATH: root,
        LANG: "C",
        OCC_DOCKER_BIN: join(root, "must-not-run"),
        OPENCLAW_CI_COREPACK_BIN: corepackPath,
        CI_SYNTHETIC_LOG: logPath,
      },
      20_000,
    );
    assert.equal(result.status, 0, result.stderr);
    await assertSuperuserSessions(postgres);
    const [laneTemplateName, templateName, copyName] = result.stderr.trim().split(" ");
    assert.ok(laneTemplateName && templateName && copyName);
    assert.match(laneTemplateName, /^openclaw_ci_lane_template_[a-f0-9]{12}$/);
    assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
      // The lane's one migration, which each file's database copies.
      `postgres\tpostgres\tCREATE DATABASE "${laneTemplateName}"`,
      `postgres\t${laneTemplateName}\tGRANT CREATE ON DATABASE "${laneTemplateName}" TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      `migrate\t/${laneTemplateName}`,
      // A copy keeps the template's schemas and migrations; only the database grant is new.
      `postgres\tpostgres\tCREATE DATABASE "${templateName}" TEMPLATE "${laneTemplateName}"`,
      `postgres\tpostgres\tGRANT CREATE ON DATABASE "${templateName}" TO occ_migrator;`,
      `postgres\tpostgres\tCREATE DATABASE "${copyName}" TEMPLATE "${templateName}"`,
      `postgres\tpostgres\tGRANT CREATE ON DATABASE "${copyName}" TO occ_migrator;`,
      `postgres\tpostgres\tDROP DATABASE IF EXISTS "${copyName}" WITH (FORCE)`,
      `postgres\tpostgres\tDROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`,
    ]);
    // Each copy and its grant share one session, as each drop has its own.
    assert.deepEqual(postgres.sessionLines().slice(2), [
      `postgres\tCREATE DATABASE "${templateName}" TEMPLATE "${laneTemplateName}"\tGRANT CREATE ON DATABASE "${templateName}" TO occ_migrator;`,
      `postgres\tCREATE DATABASE "${copyName}" TEMPLATE "${templateName}"\tGRANT CREATE ON DATABASE "${copyName}" TO occ_migrator;`,
      `postgres\tDROP DATABASE IF EXISTS "${copyName}" WITH (FORCE)`,
      `postgres\tDROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`,
    ]);
  });

  test("prepareFile and cleanup in two processes keep each other's state entries", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const corepackPath = join(root, "fake-corepack.mjs");
    // Each statement and command takes a little while, so the two processes' state updates
    // overlap.
    const postgres = await laneFakePostgres(t, { onQuery: () => delay(10) });
    const server = composePostgres("synthetic", postgres.port);
    await writePostgresState(statePath, server);
    const slow = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n`;
    await writeFile(corepackPath, `#!${process.execPath}\n${slow}`, { mode: 0o700 });
    // A template per process, then a copy per test, like the worker revision suite, whose
    // template is the database the runner prepared for its file.
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
      runProgram(
        program,
        statePath,
        {
          PATH: root,
          LANG: "C",
          OCC_DOCKER_BIN: join(root, "must-not-run"),
          OPENCLAW_CI_COREPACK_BIN: corepackPath,
        },
        60_000,
      );
    const results = await Promise.all([run(), run()]);
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }
    const settled = JSON.parse(await readFile(statePath, "utf8"));
    // Both processes copied one lane template, which stays until lane cleanup.
    assert.deepEqual(settled.resources[0], server);
    assert.deepEqual(
      settled.resources
        .slice(1)
        .map(
          ({
            kind,
            laneTemplate,
            status,
          }: {
            kind: string;
            laneTemplate?: string;
            status: string;
          }) => ({
            kind,
            laneTemplate,
            status,
          }),
        ),
      [{ kind: "postgres-database", laneTemplate: "ci", status: "ready" }],
    );
    assert.deepEqual((await readdir(root)).sort(), ["fake-corepack.mjs", "state.json"]);
    // Every copy and drop reached the server: per process a copy of the lane template for
    // its file and 10 per-test copies, each dropped again.
    const statements = postgres.queries();
    assert.equal(statements.filter((line) => / TEMPLATE /.test(line)).length, 22);
    assert.equal(statements.filter((line) => /\tDROP DATABASE /.test(line)).length, 22);
  });

  test("the CI state lock removes an exited holder's lock and waits for a live one", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const lockPath = `${statePath}.lock`;
    const exited = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(exited.status, 0);
    await writeFile(lockPath, `${exited.pid} abandoned\n`, { mode: 0o600 });
    // Places in the queue older than any live waiter's: the exited process's, and one past
    // its deadline whose pid reads as alive (reused, here this process's).
    const ticket = (clock: string, expiry: string, pid: number) =>
      writeFile(
        join(
          root,
          `.state.json.lock.${clock.padStart(20, "0")}.${expiry.padStart(20, "0")}.${pid}.${randomUUID()}.ticket`,
        ),
        `${pid} queued\n`,
        { mode: 0o600 },
      );
    await ticket("1", String(process.hrtime.bigint() + 10n ** 12n), exited.pid);
    await ticket("2", "3", process.pid);
    // A nested call in the same async context reuses the held lock.
    assert.equal(
      await withStateLock(statePath, () => withStateLock(statePath, async () => "ran"), {
        timeoutMs: 10_000,
      }),
      "ran",
    );
    assert.deepEqual(await readdir(root), []);

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
        `Timed out after 300 ms waiting for the CI state lock .* \\(held by pid ${holder.pid}, 0 waiting ahead\\)`,
      ),
    );
    assert.equal(ran, false);
    assert.equal(await readFile(lockPath, "utf8"), `${holder.pid} live\n`);
    assert.deepEqual((await readdir(root)).sort(), ["state.json.lock"]);
  });

  test("the CI state lock serves waiters in arrival order across processes", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const orderPath = join(root, "order");
    const lock = new URL("../../scripts/ci/state-lock.ts", import.meta.url).href;
    // Each contender takes the lock `times` times in a row and records its name while
    // holding it for 50 ms.
    const contender = (name: string, times: number) =>
      spawnResult(process.execPath, [
        "--input-type=module",
        "-e",
        `import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const { withStateLock } = await import(${JSON.stringify(lock)});
const [statePath, orderPath, name, times] = process.argv.slice(1);
for (let index = 0; index < Number(times); index += 1) {
  await withStateLock(statePath, async () => {
    appendFileSync(orderPath, name + "\\n");
    await delay(50);
  });
}`,
        statePath,
        orderPath,
        name,
        String(times),
      ]);
    // Each waiter holds a ticket next to the lock while it waits.
    const waiting = (count: number) =>
      waitUntil(
        `${count} waiters to queue`,
        async () =>
          (await readdir(root)).filter((name) => name.endsWith(".ticket")).length >= count,
        { timeoutMs: 20_000, intervalMs: 10 },
      );
    let release: (() => void) | undefined;
    const holding = withStateLock(
      statePath,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await waitUntil("the test to hold the state lock", () => release !== undefined, {
      intervalMs: 10,
    });
    // The contenders queue one at a time, behind this process's hold. "first" asks again as
    // soon as it releases: before tickets, its process re-took the lock at once, and a
    // waiter that had backed off to 100 ms polls lost to newer ones (finding 2179).
    const runs = [];
    for (const [index, [name, times]] of tuples([
      ["first", 2],
      ["second", 1],
      ["third", 1],
      ["fourth", 1],
    ]).entries()) {
      runs.push(contender(name, times));
      await waiting(index + 1);
    }
    // A second call from this process queues behind them too.
    const local = withStateLock(statePath, () => appendFile(orderPath, "local\n"));
    await waiting(5);
    const released = Date.now();
    assert.ok(release);
    release();
    await holding;
    for (const result of await Promise.all(runs)) {
      assert.equal(result.status, 0, result.stderr);
    }
    await local;
    const elapsed = Date.now() - released;
    assert.deepEqual((await readFile(orderPath, "utf8")).trim().split("\n"), [
      "first",
      "second",
      "third",
      "fourth",
      "local",
      "first",
    ]);
    // Five 50 ms holds; each hand-off is a 5 ms poll by the next waiter.
    t.diagnostic(`six waiters served in ${elapsed} ms`);
    assert.ok(elapsed < 5_000, `six waiters took ${elapsed} ms`);
    assert.deepEqual(await readdir(root), ["order"]);
  });

  test("retired repository lane is unknown before inputs, state, or commands", async (t) => {
    const root = await fixture(t);
    const manifest = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
    assert.equal(Object.hasOwn(manifest.lanes, "repository-credentials-installed"), false);
    const commandLog = join(root, "commands.log");
    const commandGuard = join(root, "must-not-run");
    const statePath = join(root, "state.json");
    const githubEnv = join(root, "github.env");
    await writeFile(
      commandGuard,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(commandLog)}, "called\\n");
process.exit(97);
`,
      { mode: 0o700 },
    );
    const isolatedEnv = {
      HOME: root,
      PATH: root,
      OCC_DOCKER_BIN: commandGuard,
      OPENCLAW_CI_K3D_BIN: commandGuard,
      OCC_KUBECTL_BIN: commandGuard,
      OCC_HELM_BIN: commandGuard,
    };
    const control = await spawnResult(commandGuard, [], { env: isolatedEnv });
    assert.equal(control.status, 97);
    assert.equal(await readFile(commandLog, "utf8"), "called\n");
    await rm(commandLog);
    // Retirement must apply to both dispatch paths before provisioning or exporting state.
    for (const fileArgs of [
      [],
      ["--file", "tests/integration/repository-credentials-k3d-real.test.mjs"],
    ]) {
      const result = await spawnResult(
        process.execPath,
        [
          preparePath,
          "--lane",
          "repository-credentials-installed",
          "--state",
          statePath,
          "--github-env",
          githubEnv,
          ...fileArgs,
        ],
        {
          env: isolatedEnv,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), "Unknown CI lane: repository-credentials-installed");
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(root), ["must-not-run"]);
    }
  });

  test("preparation refuses malformed manifest policy before creating state", async (t) => {
    const root = await fixture(t);
    const scripts = join(root, "scripts");
    const ci = join(scripts, "ci");
    await mkdir(ci, { recursive: true });
    await symlink(join(repositoryRoot, "packages"), join(root, "packages"));
    await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
    await symlink(join(repositoryRoot, "package.json"), join(root, "package.json"));
    await symlink(join(repositoryRoot, "scripts/lib"), join(scripts, "lib"));
    // Copy the real entry modules so their repository root points at this owned manifest.
    for (const entry of await readdir(join(repositoryRoot, "scripts/ci"))) {
      if (entry === "test-suites.json") {
        continue;
      }
      const source = join(repositoryRoot, "scripts/ci", entry);
      const target = join(ci, entry);
      if (["prepare.ts", "prepare-cli.ts", "prepare-inputs.ts"].includes(entry)) {
        await copyFile(source, target);
      } else {
        await symlink(source, target);
      }
    }
    const manifest = join(ci, "test-suites.json");
    const statePath = join(root, "state.json");
    for (const prepare of ["invalid", { requiresPreparedStateForFile: "true" }]) {
      await writeFile(manifest, JSON.stringify({ lanes: { fixture: { files: [], prepare } } }));
      const result = await spawnResult(
        process.execPath,
        [join(ci, "prepare.ts"), "--lane", "fixture", "--state", statePath],
        { env: { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "" } },
      );
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /lanes\.fixture\.prepare(?:\.requiresPreparedStateForFile)? must be/,
      );
      await assert.rejects(stat(statePath), { code: "ENOENT" });
    }
    await writeFile(
      manifest,
      JSON.stringify({
        lanes: { fixture: { files: [], prepare: { requiresPreparedStateForFile: false } } },
      }),
    );
    const valid = await spawnResult(
      process.execPath,
      [
        join(ci, "prepare.ts"),
        "--lane",
        "fixture",
        "--file",
        "fixture.test.ts",
        "--state",
        statePath,
      ],
      { env: { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "" } },
    );
    assert.equal(valid.status, 0, valid.stderr);
  });

  test("repository credential file preparation extracts the binary only for manifest consumers and cleans it", async (t) => {
    const root = await fixture(t);
    const bin = join(root, "bin");
    const commandLog = join(root, "commands.jsonl");
    const statePath = join(root, "state.json");
    await mkdir(bin);
    const docker = join(bin, "docker");
    await writeFile(
      docker,
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  console.log("sha256:" + "a".repeat(64));
} else if (args[0] === "run") {
  const mount = args[args.indexOf("--mount") + 1];
  const directory = /(?:^|,)src=([^,]+)/.exec(mount)?.[1];
  if (!directory) process.exit(2);
  writeFileSync(join(directory, "gh"), ${JSON.stringify(`#!${process.execPath}\nconsole.log("gh version 2.103.2");\n`)});
}
`,
      { mode: 0o700 },
    );
    await writeFile(join(bin, "pnpm"), `#!${process.execPath}\n`, { mode: 0o700 });
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      OCC_DOCKER_BIN: docker,
      RUNNER_TEMP: root,
      REPOSITORY_CREDENTIALS_GH_BINARY: "",
    };
    // Build commands are controlled peers. The real lane journals its images and the
    // real file preparer decides which manifest files need delivered-binary extraction.
    const lane = await runPrepare(
      ["--lane", "repository-credentials-container", "--state", statePath],
      env,
    );
    assert.equal(lane.status, 0, lane.stderr);
    // The standalone CLI cannot retain the extraction callback after it exits.
    const refused = await runPrepare(
      [
        "--lane",
        "repository-credentials-container",
        "--state",
        statePath,
        "--file",
        "tests/conformance/repository-credentials-backend-conformance.test.ts",
        "--github-env",
        join(root, "missing", "github.env"),
      ],
      env,
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /must be prepared within the test runner/);
    assert.equal(
      (await readCommandLines(commandLog)).filter(([command]) => command === "run").length,
      0,
    );
    const program = `
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
const { prepareFile } = await import(process.argv[1]);
const lane = "repository-credentials-container";
const consumer = await prepareFile({
  lane, statePath: process.argv[2],
  file: "tests/conformance/repository-credentials-backend-conformance.test.ts",
});
assert.ok(consumer.env.REPOSITORY_CREDENTIALS_GH_BINARY);
assert.ok((await stat(consumer.env.REPOSITORY_CREDENTIALS_GH_BINARY)).isFile());
await consumer.cleanup();
await assert.rejects(stat(consumer.env.REPOSITORY_CREDENTIALS_GH_BINARY), { code: "ENOENT" });
const sibling = await prepareFile({
  lane, statePath: process.argv[2],
  file: "tests/integration/repository-credentials-gh.test.ts",
});
assert.equal(sibling.env.REPOSITORY_CREDENTIALS_GH_BINARY, undefined);
assert.equal(sibling.cleanup, null);
`;
    const prepared = await runProgram(program, statePath, { ...process.env, ...env });
    assert.equal(prepared.status, 0, prepared.stderr);
    const calls = await readCommandLines(commandLog);
    assert.equal(calls.filter(([command]) => command === "run").length, 1);
    assert.equal(calls.filter(([command]) => command === "rm").length, 1);
    const cleanup = await spawnResult(
      process.execPath,
      [join(repositoryRoot, "scripts/ci/cleanup.ts"), "--state", statePath],
      { env },
    );
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  });

  test("production upgrade preparation requires two distinct immutable image pairs before creating resources", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "upgrade-state.json");
    const image = (name: string, digit: string) =>
      `registry.example/${name}@sha256:${digit.repeat(64)}`;
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
    for (const [override, expected] of tuples([
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
    ])) {
      const rejected = await runPrepare(args, { ...env, ...override });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, expected);
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    }

    // A complete release selection reaches tool discovery without a source build
    // or secret-bearing preparation state; no cluster is created in this check.
    const admitted = await runPrepare(args, { ...env, OCC_HELM_BIN: join(root, "missing-helm") });
    assert.equal(admitted.status, 1);
    assert.match(admitted.stderr, /missing-helm/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.resources, []);
    assert.ok(!JSON.stringify(state).includes(env.OPENAI_API_KEY));

    const unprepared = await runPrepare(
      [...args, "--file", "tests/integration/production-tui-k3d-real.test.mjs"],
      env,
    );
    assert.equal(unprepared.status, 1);
    assert.match(unprepared.stderr, /must match the prepared lane state/);
  });

  // GitHub refuses NODE_OPTIONS in $GITHUB_ENV with an ##[error] annotation that reads like the
  // lane's failure. run-tests.ts applies the lane's env to each test process itself.
  test("lane preparation does not export the lane's NODE_OPTIONS to GITHUB_ENV", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const githubEnv = join(root, "github.env");
    const manifest = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
    assert.ok(getLane(manifest, "checks-baseline-1").env?.NODE_OPTIONS);
    const prepared = await runPrepare([
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
    assert.equal((await stat(githubEnv)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(prepared.stdout), {
      envNames: ["NODE_OPTIONS", "OPENCLAW_ENTERPRISE_CI_PREFIX", "OPENCLAW_ENTERPRISE_CI_STATE"],
    });
    const cleaned = await spawnResult(process.execPath, [
      join(repositoryRoot, "scripts/ci/cleanup.ts"),
      "--state",
      statePath,
    ]);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  });

  test("environment export rejects multiline values before appending any assignment", async (t) => {
    const root = await fixture(t);
    const githubEnv = join(root, "github.env");
    const statePath = join(root, "state\nINJECTED=value.json");
    await writeFile(githubEnv, "CANARY=unchanged\n");
    const prepared = await runPrepare([
      "--lane",
      "checks-baseline-1",
      "--state",
      statePath,
      "--github-env",
      githubEnv,
    ]);
    assert.equal(prepared.status, 1);
    assert.match(prepared.stderr, /Invalid GitHub environment value/);
    assert.equal(await readFile(githubEnv, "utf8"), "CANARY=unchanged\n");
    const cleaned = await spawnResult(process.execPath, [
      join(repositoryRoot, "scripts/ci/cleanup.ts"),
      "--state",
      statePath,
    ]);
    assert.equal(cleaned.status, 0, cleaned.stderr);
  });

  test("ordinary CI groups require controlled repository coverage and exclude installed live repository writes", async () => {
    const manifest = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
    for (const name of ["ci", "full"]) {
      assert.ok(getGroup(manifest, name).includes("repository-credentials-container"));
      for (const lane of getGroup(manifest, name)) {
        assert.notEqual(getLane(manifest, lane).env?.OCC_TEST_REPOSITORY_CREDENTIALS_REAL, "1");
      }
    }
  });

  test("CI installs Chromium for the PostgreSQL browser suites", async () => {
    const manifest = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
    const actionSteps = parseActionSteps(
      await readFile(join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"), "utf8"),
    );
    const browserSetup = actionSteps.find(
      (step) => step.run === "bash scripts/ci/setup-tools.sh browser",
    );
    assert.ok(browserSetup);
    // Moving a browser suite between lanes must carry its Chromium prerequisite.
    for (const path of [
      "tests/integration/postgres-human-session-cookie.test.ts",
      "tests/integration/postgres-native-host-only-browser.test.ts",
    ]) {
      const owners = Object.entries(manifest.lanes).filter(([, lane]) =>
        lane.files.some((file) => file.path === path),
      );
      assert.equal(owners.length, 1, path);
      const owner = owners[0];
      assert.ok(owner && typeof browserSetup.if === "string" && browserSetup.if);
      const [lane] = owner;
      assert.ok(
        browserSetup.if.split(/\s*\|\|\s*/).includes(`inputs.lane == '${lane}'`),
        `${lane} must install Chromium for ${path}`,
      );
    }
  });

  registerAdvisoryCases(repositoryRoot);

  registerSeccompCases();

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

    const result = await runPrepare(["--lane", "helper-timeout", "--state", statePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI state already exists/);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  });

  test("prepareFile refuses a state file it does not own before using it", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const owned = {
      version: 1,
      repositoryRoot,
      lane: "postgres-application",
      prefix: "openclaw-ci-local-foreign-state",
      statePath,
      resources: [composePostgres("foreign_state")],
    };
    for (const [label, change, error] of tuples([
      ["another version", { version: 2 }, /Unsupported CI state version: 2/],
      [
        "another checkout",
        { repositoryRoot: join(root, "other-checkout") },
        /CI state belongs to another repository root/,
      ],
      [
        "another prefix",
        { prefix: "someone-else" },
        /CI state prefix is not an OpenClaw Enterprise CI prefix/,
      ],
      ["no resource list", { resources: {} }, /CI state resources must be an array/],
      ["non-string environment", { env: { PROBE: 7 } }, /CI state env must contain string values/],
      [
        "non-string defaults",
        { defaults: { PROBE: 7 } },
        /CI state defaults must contain string values/,
      ],
    ])) {
      const state = { ...owned, ...change };
      await writeState(statePath, state);
      const result = await runPrepare(
        [
          "--lane",
          "postgres-application",
          "--file",
          "tests/integration/postgres-worker-agent-revision.test.mjs",
          "--state",
          statePath,
        ],
        { OCC_DOCKER_BIN: join(root, "must-not-run") },
      );
      assert.equal(result.status, 1, label);
      assertStderrMatch(result.stderr, error, label);
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state, label);
    }
  });

  test("prepareLane reports skipped image pulls when logging image configuration cannot be read", async (t) => {
    const root = await fixture(t);
    const summary = join(root, "summary.md");
    const preload = join(root, "fail-collector-config.mts");
    const prepareUrl = new URL("../../scripts/ci/prepare.ts", import.meta.url).href;
    // The preload also supplies the logging module when the prepare CLI imports it.
    await writeFile(
      preload,
      `import { registerHooks } from "node:module";

export function prepareLogging(): never {
  throw new Error("unexpected logging setup");
}

export async function readDefaultCollectorImage(): Promise<never> {
  throw new Error("fixture collector config read failed");
}

const prepareUrl = ${JSON.stringify(prepareUrl)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./logging.ts" && context.parentURL === prepareUrl) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const result = await spawnResult(
      process.execPath,
      [
        "--import",
        preload,
        preparePath,
        "--lane",
        "logging-collector",
        "--state",
        join(root, "state.json"),
      ],
      {
        env: {
          ...process.env,
          GITHUB_ENV: "",
          GITHUB_OUTPUT: "",
          GITHUB_STEP_SUMMARY: summary,
          OCC_DOCKER_BIN: join(root, "must-not-run"),
        },
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assertStderrMatch(result.stderr, /^fixture collector config read failed$/m);
    assert.doesNotMatch(result.stderr, /\[ci-timing\]/);
    assert.equal(await readFile(summary, "utf8"), "- logging-collector / image-pulls: skipped\n");
  });

  test("prepareLane pre-pulls logging and metrics images with retry and preserves its Node override", async (t) => {
    for (const failure of ["transient", "missing-manifest", "invalid-node-reference"]) {
      await t.test(failure, async (t) => {
        const root = await fixture(t);
        const statePath = join(root, "logging-state.json");
        const githubEnv = join(root, "github.env");
        const summary = join(root, "summary.md");
        const customNodeImage =
          "docker.io/library/node:24-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const loggingCollectorImage = collectorImage(
          await readFile(join(repositoryRoot, "compose.logging.yaml"), "utf8"),
        );
        // Images are absent until pulled; a registry 503 must retry, while a
        // missing Prometheus manifest must stop preparation before publishing env.
        // Two images are prepared concurrently, so the fake counts each image's
        // pulls in its own file: reading the shared call log while the other
        // image's process creates or appends to it can return an empty or torn line.
        const dockerPath = join(root, "docker");
        // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
        await writeFile(
          dockerPath,
          `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = process.getBuiltinModule("node:fs");
const { createHash } = process.getBuiltinModule("node:crypto");
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

        const result = await runPrepare(
          ["--lane", "logging-collector", "--state", statePath, "--github-env", githubEnv],
          {
            OCC_DOCKER_BIN: dockerPath,
            // Fails validation while the first worker is inspecting the Collector,
            // before either worker can start a queued metrics image. No sleep/race.
            OCC_TEST_LOGGING_NODE_IMAGE:
              failure === "invalid-node-reference" ? `invalid ${customNodeImage}` : customNodeImage,
            CI_METRICS_PULL_FAILURE: failure,
            GITHUB_STEP_SUMMARY: summary,
          },
        );

        const outcome = failure === "transient" ? "success" : "failure";
        assert.match(
          await readFile(summary, "utf8"),
          new RegExp(`^- logging-collector / image-pulls: ${outcome} \\(\\d+ ms\\)\\n$`),
        );

        const commands = await readCommandLines(join(root, "docker.jsonl"));
        const pulls = commands.filter((args) => args[0] === "pull").map((args) => args[1]);
        if (failure === "invalid-node-reference") {
          assert.equal(result.status, 1);
          assert.match(result.stderr, /OCC_TEST_LOGGING_NODE_IMAGE must be an immutable image/);
          assert.deepEqual(pulls, [loggingCollectorImage]);
          assert.ok(commands.every((args) => args.at(-1) === loggingCollectorImage));
          assert.ok(
            commands.some((args) => args.includes("{{.Id}}")),
            "active pull finished verification",
          );
          await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
          return;
        }
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
          [loggingCollectorImage, customNodeImage, ...Object.values(metricsMonitoringImages)]
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
    const manifest = loadSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
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
          (lane.requiredEnv ?? []).includes("OCC_TEST_CODEX_SECCOMP_PROFILE"),
          `${name} must require OCC_TEST_CODEX_SECCOMP_PROFILE`,
        );
      }
    }
    // The Git broker case is a known caller; this keeps the scan from passing
    // vacuously if the helper is renamed.
    assert.ok(
      callers.includes("images-runtime-startup:tests/integration/runtime-image-startup.test.ts"),
      callers.join(", "),
    );
    // Preparing the profile needs k3d, which only the full and k3d tool profiles install.
    const ciWorkflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const laneTable = /^ {10}LANE_TABLE: \|\n((?: {12}.*\n)+)/m.exec(ciWorkflow);
    assert.ok(laneTable, "ci.yml declares the CI Impact lane table");
    const fullIntegration = await readFile(
      join(repositoryRoot, ".github/workflows/full-integration-execution.yml"),
      "utf8",
    );
    const laneTableJson = laneTable[1];
    assert.ok(laneTableJson);
    const rawProfiles: unknown = JSON.parse(laneTableJson);
    assert.ok(Array.isArray(rawProfiles));
    const toolProfiles: [string, string, string][] = rawProfiles.map((value: unknown) => {
      const row = asRecord(value);
      assert.ok(typeof row?.lane === "string" && typeof row.profile === "string");
      return ["ci.yml " + row.lane, row.lane, row.profile];
    });
    for (const match of fullIntegration.matchAll(
      /- lane: ([a-z0-9-]+)\n\s+title: .*\n\s+profile: ([a-z]+)/g,
    )) {
      const lane = match[1];
      const profile = match[2];
      assert.ok(lane && profile);
      toolProfiles.push(["full-integration-execution.yml " + lane, lane, profile]);
    }
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

  test("QA workflows pin the Compose launcher's K3s image to the CI default", async () => {
    // Without the pin, dev-up resolves the +v1.35 channel through update.k3s.io,
    // so a channel-server outage fails every Compose QA run (finding 1056).
    const workflows = tuples([
      [".github/workflows/qa-advisory.yml", "qa"],
      [".github/workflows/full-integration-execution.yml", "qa-matrix"],
    ]);
    for (const [path, jobName] of workflows) {
      const source = await readFile(join(repositoryRoot, path), "utf8");
      const document = asRecord(loadYaml(source));
      assert.ok(document);
      // Scalar concurrency is valid workflow syntax and must not affect the image pin checks.
      for (const text of [
        source,
        JSON.stringify({ ...document, concurrency: "full-integration" }),
      ]) {
        const workflow = parseWorkflow(text);
        assert.equal(
          asRecord(getJob(workflow, jobName).env)?.OCC_DEVELOPMENT_K3S_IMAGE,
          defaultK3sImage,
          path,
        );
        // Workflow-wide would reach dev-up.test.mjs, which asserts the +v1.35 default.
        const workflowEnv = workflow.env;
        assert.ok(workflowEnv === undefined || asRecord(workflowEnv), path);
        assert.equal(asRecord(workflowEnv)?.OCC_DEVELOPMENT_K3S_IMAGE, undefined, path);
      }
    }
  });

  test("prepareFile applies the images packaging Node base default without hiding invalid overrides", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "missing-state.json");
    const file = "tests/integration/docker-compute-token-retry.test.ts";
    const customNodeBaseImage =
      "docker.io/library/node:24-bookworm@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const defaulted = await runPrepare(
      ["--lane", "images-packaging", "--file", file, "--state", statePath],
      {
        NODE_BASE_IMAGE: "",
      },
    );
    assert.equal(defaulted.status, 1);
    assert.match(defaulted.stderr, /requires a prior prepareLane/);

    const explicit = await runPrepare(
      ["--lane", "images-packaging", "--file", file, "--state", statePath],
      {
        NODE_BASE_IMAGE: customNodeBaseImage,
      },
    );
    assert.equal(explicit.status, 1);
    assert.match(explicit.stderr, /requires a prior prepareLane/);

    const invalid = await runPrepare(
      ["--lane", "images-packaging", "--file", file, "--state", statePath],
      {
        NODE_BASE_IMAGE: "docker.io/library/node:24-bookworm",
      },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /NODE_BASE_IMAGE must be an immutable/);

    const otherNode = await runPrepare(
      ["--lane", "images-packaging", "--file", file, "--state", statePath],
      { NODE_BASE_IMAGE: customNodeBaseImage.replace("node:24-", "node:22-") },
    );
    assert.equal(otherNode.status, 1);
    assertStderrMatch(otherNode.stderr, /NODE_BASE_IMAGE must select an approved Node 24 image/);

    // A blank override is a missing input, not a reason to fall back to the default.
    const blank = await runPrepare(
      ["--lane", "images-packaging", "--file", file, "--state", statePath],
      { NODE_BASE_IMAGE: "   " },
    );
    assert.equal(blank.status, 1);
    assertStderrMatch(blank.stderr, /Missing required CI input\(s\): NODE_BASE_IMAGE/);
  });

  // This command fixture tests preparation ordering only. The real launcher case
  // still reads genuine engine metadata and requires the revision-mismatch error.
  async function launcherImageEngine(t: TestContext, scenario = "cold") {
    const root = await fixture(t);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(root, "commands.jsonl"), "");
    const image =
      "rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657";
    const source = `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.equal(args.at(-1), ${JSON.stringify(image)});
appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))}, JSON.stringify([process.argv[1], ...args]) + "\\n");
assert.equal(existsSync(${JSON.stringify(join(root, "prepared.env"))}), false);
if (args[0] === "pull") {
  if (${JSON.stringify(scenario)} === "denied") {
    console.error("pull access denied"); process.exit(1);
  }
  writeFileSync(${JSON.stringify(join(root, "pulled"))}, "ready");
} else if (!existsSync(${JSON.stringify(join(root, "pulled"))})) {
  console.error("No such image"); process.exit(1);
} else if (args[3] === "{{json .RepoDigests}}") {
  console.log(JSON.stringify([${JSON.stringify(scenario === "wrong-digest" ? "rancher/k3s@sha256:" + "a".repeat(64) : image)}]));
} else if (args[3] === "{{.Id}}") {
  console.log("sha256:" + "b".repeat(64));
} else {
  throw new Error("Unexpected engine command");
}
`;
    for (const engine of ["docker", "podman"]) {
      await writeFile(join(bin, engine), source, { mode: 0o700 });
    }
    return {
      root,
      image,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        // The launcher engine selection must win over the general CI engine override.
        OCC_DOCKER_BIN: join(root, "must-not-run"),
      },
      commands: () => readCommandLines(join(root, "commands.jsonl"), { skipBlank: true }),
    };
  }

  test("local launcher preparation verifies the rejection image before publishing browser and engine inputs", async (t) => {
    for (const [name, inputs, expected] of tuples([
      [
        "selected",
        {
          OCC_TEST_BROWSER_EXECUTABLE: "/prepared/chromium",
          OCC_TEST_DEV_UP_CONTAINER_ENGINE: "podman",
        },
        {
          OCC_TEST_BROWSER_EXECUTABLE: "/prepared/chromium",
          OCC_TEST_DEV_UP_CONTAINER_ENGINE: "podman",
        },
      ],
      [
        "default",
        { OCC_TEST_BROWSER_EXECUTABLE: "", OCC_TEST_DEV_UP_CONTAINER_ENGINE: "" },
        { OCC_TEST_BROWSER_EXECUTABLE: "", OCC_TEST_DEV_UP_CONTAINER_ENGINE: "docker" },
      ],
    ])) {
      // The runner removes inherited OCC_TEST_* selectors. Preparation must
      // restore these explicit choices before the real launcher/browser starts.
      const engine = await launcherImageEngine(t);
      const root = engine.root;
      const envPath = join(root, "prepared.env");
      if (name === "selected") {
        // A later process must retain the prepared selection without re-exporting its inputs.
        const lane = await runPrepare(
          ["--lane", "dev-up-k3d", "--state", join(root, `${name}.json`)],
          { ...engine.env, ...inputs },
        );
        assert.equal(lane.status, 0, lane.stderr);
      }
      const result = await runPrepare(
        [
          "--lane",
          "dev-up-k3d",
          "--file",
          "tests/integration/dev-up-k3d-real.test.mjs",
          "--state",
          join(root, `${name}.json`),
          "--github-env",
          envPath,
        ],
        {
          ...engine.env,
          OCC_TEST_BROWSER_EXECUTABLE: "",
          OCC_TEST_DEV_UP_CONTAINER_ENGINE: "",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        await engine.commands(),
        [
          ["image", "inspect", "--format", "{{json .RepoDigests}}", engine.image],
          ["pull", engine.image],
          ["image", "inspect", "--format", "{{json .RepoDigests}}", engine.image],
          ["image", "inspect", "--format", "{{.Id}}", engine.image],
        ].map((args) => [join(root, "bin", expected.OCC_TEST_DEV_UP_CONTAINER_ENGINE), ...args]),
      );
      const prepared = await readFile(envPath, "utf8");
      for (const [key, value] of Object.entries(expected)) {
        assert.ok(prepared.split("\n").includes(`${key}=${value}`), `${name}: ${key}`);
      }
    }
  });

  test("local launcher preparation refuses failed pulls and unverified digests before publishing inputs", async (t) => {
    for (const [scenario, expected] of tuples([
      ["denied", /pull access denied/],
      ["wrong-digest", /pull did not materialize the requested registry digest/],
    ])) {
      const engine = await launcherImageEngine(t, scenario);
      const envPath = join(engine.root, "prepared.env");
      const result = await runPrepare(
        [
          "--lane",
          "dev-up-k3d",
          "--file",
          "tests/integration/dev-up-k3d-real.test.mjs",
          "--state",
          join(engine.root, "state.json"),
          "--github-env",
          envPath,
        ],
        { ...engine.env, OCC_TEST_DEV_UP_CONTAINER_ENGINE: "podman" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      await assert.rejects(stat(envPath), { code: "ENOENT" });
      assert.equal((await engine.commands()).filter(([, command]) => command === "pull").length, 1);
    }
  });

  test("OpenShell preparation binds custom credentials to a focused destination before effects", async (t) => {
    const root = await fixture(t);
    const upstream = "tests/integration/openshell-upstream-real.test.ts";
    const guided = [
      "tests/integration/local-first-agent-openshell-real.test.mjs",
      "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
    ];
    const cases = [];
    for (const lane of ["openshell", "openshell-installers", "openshell-policy"]) {
      cases.push(
        {
          lane,
          endpoint: "https://custom-model.example.test/v1",
          pat: true,
          error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
        },
        {
          lane,
          native: true,
          pat: true,
          error: /Custom native providers require a focused first-Agent file/u,
        },
      );
    }
    cases.push(
      { file: upstream, endpoint: "https://custom-model.example.test/v1" },
      {
        file: guided[0],
        endpoint: "https://custom-model.example.test/v1",
        error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
      },
      {
        file: upstream,
        native: true,
        error: /Custom native providers require a focused first-Agent file/u,
      },
    );
    for (const file of [
      "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
      "tests/integration/openshell-credentials-real.test.ts",
      "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
    ]) {
      cases.push({
        file,
        endpoint: "https://custom-model.example.test/v1",
        pat: true,
        error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
      });
    }
    for (const file of [undefined, upstream]) {
      cases.push({
        file,
        endpoint: "malformed-private-endpoint",
        error: /The OpenShell model endpoint must be a valid absolute URL/u,
      });
    }
    for (const file of guided) {
      cases.push(
        { file, native: true, error: /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/u },
        { file, native: "   ", error: /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/u },
        { file, native: true, pat: true },
        {
          file,
          native: true,
          pat: true,
          noKey: true,
          error: /Missing required CI input\(s\): OPENAI_API_KEY/u,
        },
      );
    }
    for (const [index, value] of cases.entries()) {
      await t.test(`selection ${index}`, async () => {
        const lane = value.lane ?? "openshell";
        const statePath = join(root, `bound-credential-${index}.json`);
        // Distinct synthetic destinations cannot share a key across whole-lane
        // siblings. Valid focused inputs stop at the immutable-image gate.
        const result = await runProgram(
          `const { prepareLane } = await import(process.argv[1]);
         await prepareLane({ lane: ${JSON.stringify(lane)}, statePath: process.argv[2], file: ${JSON.stringify(value.file)} });`,
          statePath,
          {
            ...process.env,
            GITHUB_ENV: "",
            GITHUB_OUTPUT: "",
            OCC_CI_SUITE_VIEW: lane === "openshell" ? "default" : "full-integration",
            OPENAI_API_KEY: value.noKey ? "" : "synthetic-custom-provider-key",
            CODEX_ACCESS_TOKEN: value.pat ? "synthetic-separate-codex-token" : "",
            OCC_TEST_OPENAI_MODEL: "fixture-model",
            OCC_TEST_OPENSHELL_HARNESS: "codex",
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: value.endpoint ?? "",
            OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE:
              value.native === true ? join(root, "custom-provider.json") : value.native || "",
            OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
          },
          10_000,
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, value.error ?? /must be an immutable image@sha256 reference/u);
        assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      });
    }
  });

  test("OpenShell preparation requires the selected owner's credential before side effects", async (t) => {
    const root = await fixture(t);
    const owner = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
    const other = "tests/integration/local-first-agent-openshell-real.test.mjs";
    const cases: {
      harness?: string | undefined;
      credentials: readonly string[];
      endpoint?: boolean;
      file?: string;
      missing?: string;
      prepareLane?: boolean;
      selectedFile?: boolean;
      unsupportedHarness?: boolean;
    }[] = [
      { harness: "codex", credentials: ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"] },
      { harness: "codex", credentials: ["CODEX_ACCESS_TOKEN"], missing: "OPENAI_API_KEY" },
      { harness: "codex", credentials: ["OPENAI_API_KEY"], missing: "CODEX_ACCESS_TOKEN" },
      { harness: "openclaw", credentials: ["OPENAI_API_KEY"], missing: "CODEX_ACCESS_TOKEN" },
      { harness: "openclaw", credentials: ["OPENAI_API_KEY"], file: owner },
      {
        harness: "openclaw",
        credentials: ["CODEX_ACCESS_TOKEN"],
        file: owner,
        missing: "OPENAI_API_KEY",
      },
      { harness: "codex", endpoint: true, credentials: ["OPENAI_API_KEY"], file: owner },
      {
        harness: "codex",
        endpoint: true,
        credentials: ["CODEX_ACCESS_TOKEN"],
        missing: "OPENAI_API_KEY",
        file: owner,
      },
      {
        harness: "openclaw",
        credentials: ["OPENAI_API_KEY"],
        file: other,
      },
      {
        harness: "openclaw",
        credentials: ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"],
        file: other,
      },
      {
        harness: "codex",
        endpoint: true,
        credentials: ["OPENAI_API_KEY"],
        missing: "CODEX_ACCESS_TOKEN",
        prepareLane: true,
      },
      {
        harness: "openclaw",
        credentials: ["OPENAI_API_KEY"],
        file: owner,
        prepareLane: true,
      },
      {
        harness: "codex",
        endpoint: true,
        credentials: ["OPENAI_API_KEY"],
        file: owner,
        prepareLane: true,
      },
    ];
    // The documented --selected-file command must admit the same API-key path.
    for (const credentials of [["OPENAI_API_KEY"], ["CODEX_ACCESS_TOKEN"]]) {
      cases.push({
        harness: "codex",
        endpoint: true,
        credentials,
        file: "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts",
        selectedFile: true,
        ...(credentials.includes("OPENAI_API_KEY") ? {} : { missing: "OPENAI_API_KEY" }),
      });
    }
    // Each split owner must retain the credential admission gate before any resource is created.
    for (const file of [
      "tests/integration/openshell-credentials-real.test.ts",
      "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts",
    ]) {
      cases.push(
        { harness: "codex", credentials: ["OPENAI_API_KEY"], file, missing: "CODEX_ACCESS_TOKEN" },
        {
          harness: "codex",
          endpoint: true,
          credentials: ["CODEX_ACCESS_TOKEN"],
          file,
          missing: "OPENAI_API_KEY",
        },
        { harness: "codex", endpoint: true, credentials: ["OPENAI_API_KEY"], file },
      );
    }
    // Namespace declares OpenClaw itself; both preparers must honor that declaration
    // even when an inherited selector asks for Codex. No PAT is needed by its child.
    for (const prepareLane of [false, true]) {
      for (const harness of [undefined, "codex"]) {
        for (const credentials of [["OPENAI_API_KEY"], ["CODEX_ACCESS_TOKEN"]]) {
          cases.push({
            file: "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
            prepareLane,
            harness,
            credentials,
            ...(credentials.includes("OPENAI_API_KEY") ? {} : { missing: "OPENAI_API_KEY" }),
          });
        }
      }
    }
    // Generic workflows use API keys even when an unrelated managed PAT is present.
    // PAT-only input must fail before the preparer creates a state file or any resources.
    for (const file of [
      "tests/integration/openshell-upstream-real.test.ts",
      "tests/integration/local-first-agent-openshell-real.test.mjs",
      "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
      "tests/integration/dev-up-openshell-k3d-real.test.mjs",
      "tests/integration/openshell-refresh-real.test.ts",
      "tests/integration/openshell-withdrawal-real.test.ts",
      "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      "tests/integration/openshell-git-retention-real.test.ts",
      "tests/integration/openshell-git-finite-removal-real.test.ts",
    ]) {
      cases.push(
        { harness: "codex", credentials: ["OPENAI_API_KEY"], file },
        { harness: "codex", credentials: ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"], file },
        { harness: "codex", credentials: ["CODEX_ACCESS_TOKEN"], file, missing: "OPENAI_API_KEY" },
      );
    }
    const scratch = "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts";
    for (const selectedFile of [false, true]) {
      cases.push({
        harness: "openclaw",
        credentials: ["OPENAI_API_KEY"],
        file: scratch,
        selectedFile,
        unsupportedHarness: true,
      });
    }
    cases.push({
      harness: "openclaw",
      credentials: ["OPENAI_API_KEY"],
      file: "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      selectedFile: true,
    });
    for (const [index, value] of cases.entries()) {
      const statePath = join(root, `credential-${index}.json`);
      const env = {
        OPENAI_API_KEY: "",
        CODEX_ACCESS_TOKEN: "",
        ...Object.fromEntries(
          value.credentials.map((name) => [name, "synthetic-fixture-credential"]),
        ),
        OCC_TEST_OPENAI_MODEL: "fixture-model",
        OCC_TEST_OPENSHELL_HARNESS: value.harness,
        OCC_TEST_OPENSHELL_MODEL_BASE_URL: value.endpoint ? "https://api.openai.com/v1" : "",
        // Stop after input validation even when the selected credential exists.
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      };
      const result = value.prepareLane
        ? await runProgram(
            `const { prepareLane } = await import(process.argv[1]);
             await prepareLane({ lane: "openshell", statePath: process.argv[2], file: ${JSON.stringify(value.file)} });`,
            statePath,
            { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "", ...env },
            10_000,
          )
        : await runPrepare(
            [
              "--lane",
              "openshell",
              "--state",
              statePath,
              ...(value.file
                ? [value.selectedFile ? "--selected-file" : "--file", value.file]
                : []),
            ],
            env,
          );
      assert.equal(result.status, 1);
      if (value.unsupportedHarness) {
        assert.match(result.stderr, /requires OCC_TEST_OPENSHELL_HARNESS=codex/);
      } else {
        assert.match(
          result.stderr,
          value.missing
            ? new RegExp(`Missing required CI input\\(s\\): ${value.missing}`)
            : /OCC_TEST_KUBERNETES_GATEWAY_IMAGE must be an immutable/,
        );
      }
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    }
  });

  // The installer cohort uses only API keys; the mixed cohorts also retain PAT
  // workflows. Reject each missing input before creating shared resources.
  for (const lane of ["openshell", "openshell-policy", "openshell-installers"]) {
    for (const harness of ["codex", "openclaw"]) {
      for (const credentials of [
        [],
        ["OPENAI_API_KEY"],
        ["CODEX_ACCESS_TOKEN"],
        ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
      ]) {
        test(`whole ${lane} admission with ${harness} and ${credentials.join("+") || "no credentials"}`, async (t) => {
          const root = await fixture(t);
          const statePath = join(root, "cohort.json");
          const result = await runProgram(
            `const { prepareLane } = await import(process.argv[1]);
           await prepareLane({ lane: ${JSON.stringify(lane)}, statePath: process.argv[2] });`,
            statePath,
            {
              ...process.env,
              GITHUB_ENV: "",
              GITHUB_OUTPUT: "",
              OCC_CI_SUITE_VIEW: lane === "openshell" ? "default" : "full-integration",
              OPENAI_API_KEY: "",
              CODEX_ACCESS_TOKEN: "",
              ...Object.fromEntries(
                credentials.map((name) => [name, "synthetic-fixture-credential"]),
              ),
              OCC_TEST_OPENAI_MODEL: "fixture-model",
              OCC_TEST_OPENSHELL_HARNESS: harness,
              OCC_K3D_HARNESS: harness,
              OCC_TEST_OPENSHELL_MODEL_BASE_URL: "",
              OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
              // Valid credential admission stops here instead of creating resources.
              OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
            },
            10_000,
          );
          assert.equal(result.status, 1);
          const required =
            lane === "openshell-installers"
              ? ["OPENAI_API_KEY"]
              : ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"];
          const missing = required.filter((name) => !credentials.includes(name));
          if (missing.length) {
            assert.match(result.stderr, /Missing required CI input/u);
            for (const name of missing) {
              assert.ok(
                result.stderr.includes(name),
                `missing credential ${name} must be reported`,
              );
            }
            assert.doesNotMatch(result.stderr, /must be an immutable/u);
          } else {
            assert.match(result.stderr, /OCC_TEST_KUBERNETES_GATEWAY_IMAGE must be an immutable/u);
          }
          await assert.rejects(stat(statePath), { code: "ENOENT" });
        });
      }
    }
  }

  test("OpenShell prepares the source selection once and passes the resulting inputs to a gateway file", async (t) => {
    const root = await fixture(t);
    const lane = "openshell";
    const file = "tests/integration/openshell-refresh-real.test.ts";
    const sourceRevision = "a".repeat(40);
    const baseEnv = {
      OPENAI_API_KEY: "synthetic-fixture-credential",
      OCC_TEST_OPENAI_MODEL: "fixture-model",
      OCC_HELM_BIN: join(root, "must-not-run-helm"),
      OCC_DOCKER_BIN: join(root, "must-not-run-docker"),
    };
    const invalidState = join(root, "incomplete.json");
    const incomplete = await runProgram(
      `const { prepareLane } = await import(process.argv[1]);
       await prepareLane({ lane: ${JSON.stringify(lane)}, file: ${JSON.stringify(file)}, statePath: process.argv[2] });`,
      invalidState,
      { ...baseEnv, OCC_TEST_OPENSHELL_SOURCE_REVISION: sourceRevision },
      10_000,
    );
    assert.equal(incomplete.status, 1);
    assert.match(
      incomplete.stderr,
      /requires a source revision, all three images, and both Helm charts/,
    );
    await assert.rejects(() => stat(invalidState), { code: "ENOENT" });

    // Model the already-prepared state and GITHUB_ENV export. The file copies
    // its database but must not reacquire or reinspect the lane's source inputs.
    const postgres = await laneFakePostgres(t);
    const server = composePostgres("openshell_handoff", postgres.port);
    const template = {
      id: "postgres-database-openshell_handoff",
      kind: "postgres-database",
      owner: server.owner,
      status: "ready",
      name: "openclaw_k8s_openshell_handoff",
      composeProject: server.name,
      port: server.port,
      laneTemplate: "k8s",
    };
    const preparedInputs = {
      OCC_TEST_OPENSHELL_HELM_CHART: join(root, "prepared-gateway-chart"),
      OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART: join(root, "prepared-workspace-chart"),
      OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
      OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
    };
    for (const [name, version] of tuples([
      ["stock", { OCC_TEST_OPENSHELL_CHART_VERSION: "0.1.9" }],
      [
        "candidate",
        {
          OCC_TEST_OPENSHELL_SOURCE_REVISION: sourceRevision,
          OCC_TEST_OPENSHELL_CHART_VERSION: "0.0.0",
        },
      ],
    ])) {
      const selectedFile =
        name === "stock"
          ? "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts"
          : file;
      const statePath = join(root, name + ".json");
      const env = { ...preparedInputs, ...version };
      await writeState(statePath, {
        version: 1,
        repositoryRoot,
        lane,
        prefix: server.owner,
        statePath,
        selectedFile,
        resources: [server, template],
        env,
      });
      const result = await runProgram(
        `import assert from "node:assert/strict";
         const { prepareFile } = await import(process.argv[1]);
         const prepared = await prepareFile({
           lane: ${JSON.stringify(lane)}, file: ${JSON.stringify(selectedFile)}, statePath: process.argv[2],
         });
         for (const [key, value] of Object.entries(${JSON.stringify(env)})) {
           assert.equal(prepared.env[key], value);
         }
         const application = new URL(prepared.env.OCC_TEST_DATABASE_URL);
         const migration = new URL(prepared.env.OCC_TEST_OPENSHELL_POLICY_MIGRATION_DATABASE_URL);
         assert.equal(application.username, "occ_app");
         assert.equal(migration.username, "occ_migrator");
         assert.equal(migration.host, application.host);
         assert.equal(migration.pathname, application.pathname);
         await prepared.cleanup();`,
        statePath,
        {
          ...baseEnv,
          ...env,
          // Main's stock scratch case retains its PAT path; the candidate refresh uses API keys.
          ...(name === "stock"
            ? { OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "synthetic-fixture-credential" }
            : {}),
        },
        10_000,
      );
      assert.equal(result.status, 0, result.stderr);
      const settled = JSON.parse(await readFile(statePath, "utf8"));
      assert.deepEqual(settled.resources, [server, template]);
    }
  });

  test("Kubernetes runtime image overrides require a complete pair before preparation", async (t) => {
    const root = await fixture(t);
    for (const [lane, file] of tuples([
      ["k3d-model", "tests/integration/harness-topology-k3d-real.test.mjs"],
      ["slack", "tests/integration/harness-topology-k3d-slack-real.test.mjs"],
    ])) {
      for (const selection of ["gateway", "agent", "both", "neither"]) {
        await t.test(`${lane}: ${selection}`, async () => {
          const statePath = join(root, `${lane}-${selection}.json`);
          const partial = selection === "gateway" || selection === "agent";
          // Partial overrides must fail before state or infrastructure is created.
          // Complete/default selections reach the existing prepared-state boundary.
          const result = await runPrepare(
            ["--lane", lane, "--state", statePath, ...(partial ? [] : ["--file", file])],
            {
              OPENAI_API_KEY: "test-openai-key",
              OCC_TEST_OPENAI_MODEL: "gpt-test",
              NODE_BASE_IMAGE: nodeBaseImage,
              ...(lane === "slack"
                ? {
                    OCC_TEST_SLACK_CHANNEL_ID: "C0123456789",
                    OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
                    SLACK_APP_TOKEN: "xapp-test",
                    SLACK_BOT_TOKEN: "xoxb-test",
                  }
                : {}),
              OCC_DOCKER_BIN: join(root, "docker-must-not-run"),
              OCC_TEST_KUBERNETES_GATEWAY_IMAGE:
                selection === "gateway" || selection === "both" ? immutableImage : "",
              OCC_TEST_KUBERNETES_AGENT_IMAGE:
                selection === "agent" || selection === "both" ? immutableImage : "",
              OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "",
              OCC_TEST_KUBERNETES_CODEX_IMAGE: "",
            },
          );
          assert.equal(result.status, 1);
          assertStderrMatch(
            result.stderr,
            partial
              ? /OCC_TEST_KUBERNETES_GATEWAY_IMAGE and OCC_TEST_KUBERNETES_AGENT_IMAGE must be supplied together/
              : /requires a prior prepareLane/,
          );
          await assert.rejects(() => stat(statePath), { code: "ENOENT" });
        });
      }
    }
  });

  test("Kubernetes runtime consumers reject a foreign artifact without a source-build fallback", async (t) => {
    for (const lane of ["gateway-routing", "production-tui"]) {
      const commands = await fixtureImageCommands(t, "artifact-import", lane, {
        GITHUB_ACTIONS: "true",
        NODE_BASE_IMAGE: packagingNodeBaseImage,
        OPENAI_API_KEY: "synthetic-model-key",
        OCC_TEST_OPENAI_MODEL: "synthetic-model",
        OCC_TEST_PRODUCTION_POSTGRES_IMAGE: immutableImage,
        OCC_TEST_PRODUCTION_NODE_IMAGE: nodeBaseImage,
        OCC_CI_RUNTIME_ARTIFACT_DIRECTORY: "/missing-foreign-artifact",
        OCC_CI_RUNTIME_ARTIFACT_SHA256: "a".repeat(64),
        OCC_CI_RUNTIME_ARTIFACT_SOURCE_SHA: "a".repeat(40),
        OCC_CI_RUNTIME_ARTIFACT_RUN_ID: "123456",
        OCC_CI_RUNTIME_ARTIFACT_ATTEMPT: "1",
      });
      // Real Git identifies this checkout; Docker, PostgreSQL and k3d are command
      // fixtures. This proves fail-closed orchestration, not image or model execution.
      await symlink("/usr/bin/git", join(dirname(commands.statePath), "bin", "git"));
      const prepared = await commands.prepare(
        lane === "gateway-routing"
          ? ["--selected-file", "tests/integration/harness-topology-k3d-routing-real.test.mjs"]
          : [],
      );
      assert.equal(prepared.status, 1, lane);
      assertStderrMatch(prepared.stderr, /Runtime artifact source differs from checkout/, lane);
      assert.deepEqual(modelPreparationNotices(prepared.stderr), []);
      const calls = await commands.commands();
      assert.equal(
        calls.some(
          ({ args }) =>
            (args[0] === "build" || (args[0] === "buildx" && args[1] === "build")) &&
            args.includes(join(repositoryRoot, "deploy/runtime/Dockerfile")),
        ),
        false,
      );
      const state = await commands.readState();
      assert.ok(
        state.resources.some(
          ({ kind, name }) => kind === "image-tag" && name?.endsWith("/runtime:local"),
        ),
      );
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
    }
  });

  test("runtime artifact selection rejects unsupported lanes and conflicting images before preparation", async (t) => {
    const root = await fixture(t);
    const commandLog = join(root, "commands.log");
    const commandGuard = join(root, "must-not-run");
    await writeFile(
      commandGuard,
      `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(commandLog)}, "called\\n");\nprocess.exit(97);\n`,
      { mode: 0o700 },
    );
    // Unsupported lanes and conflicting image selections must be refused
    // before state or source builds exist.
    for (const [lane, file, variable] of [
      ["dev-up-k3d", "tests/integration/dev-up-k3d-real.test.mjs"],
      ["qa-matrix", "tests/integration/qa-matrix-real.test.mjs"],
      ...["OCC_TEST_KUBERNETES_GATEWAY_IMAGE", "OCC_TEST_KUBERNETES_AGENT_IMAGE"].map(
        (variable) => [
          "gateway-routing",
          "tests/integration/harness-topology-k3d-routing-real.test.mjs",
          variable,
        ],
      ),
      ...[
        "OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE",
        "OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE",
      ].map((variable) => [
        "production-tui",
        "tests/integration/production-tui-k3d-real.test.mjs",
        variable,
      ]),
    ]) {
      assert.ok(lane && file);
      const statePath = join(root, `${lane}.json`);
      const result = await spawnResult(
        process.execPath,
        [preparePath, "--lane", lane, "--state", statePath, "--selected-file", file],
        {
          env: {
            HOME: root,
            PATH: root,
            RUNNER_TEMP: root,
            OCC_CI_IMAGE_CACHE: "1",
            BUILDX_BUILDER: "artifact-selection-test",
            OCC_DOCKER_BIN: commandGuard,
            OPENCLAW_CI_K3D_BIN: commandGuard,
            OCC_KUBECTL_BIN: commandGuard,
            ...(variable ? { [variable]: immutableImage } : {}),
            OCC_CI_RUNTIME_ARTIFACT_DIRECTORY: join(root, "missing-artifact"),
            OCC_CI_RUNTIME_ARTIFACT_SHA256: "a".repeat(64),
            OCC_CI_RUNTIME_ARTIFACT_SOURCE_SHA: "a".repeat(40),
            OCC_CI_RUNTIME_ARTIFACT_RUN_ID: "123456",
            OCC_CI_RUNTIME_ARTIFACT_ATTEMPT: "1",
          },
        },
      );
      assert.equal(result.status, 1, lane);
      assertStderrMatch(
        result.stderr,
        variable
          ? /A runtime artifact cannot be combined with selected Gateway or TUI upgrade images/
          : /Runtime artifacts are supported only by Docker Model Runtime, Gateway Routing, Production TUI and the ordinary image lanes/,
        lane,
      );
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
      await assert.rejects(() => stat(commandLog), { code: "ENOENT" });
    }
  });

  test("prepareLane rejects mutable Kubernetes image inputs before creating state", async (t) => {
    const root = await fixture(t);
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
    const openShellModelEnv = {
      ...baseModelEnv,
      CODEX_ACCESS_TOKEN: "synthetic-codex-pat",
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
          OCC_TEST_SLACK_CHANNEL_ID: "C0123456789",
          OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
          SLACK_APP_TOKEN: "xapp-test",
          SLACK_BOT_TOKEN: "xoxb-test",
        },
      },
      {
        lane: "openshell",
        envName: "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
        env: {
          ...openShellModelEnv,
          ...k3dImages,
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: mutableImage,
          OCC_TEST_OPENSHELL_HELM: "helm",
          OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        },
      },
      {
        lane: "openshell",
        envName: "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
        env: {
          ...openShellModelEnv,
          ...k3dImages,
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SANDBOX_IMAGE: mutableImage,
          OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_HELM: "helm",
          OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        },
      },
      {
        lane: "openshell",
        envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
        env: {
          ...openShellModelEnv,
          ...k3dImages,
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_HELM: "helm",
          OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        },
      },
      {
        lane: "openshell",
        envName: "OCC_TEST_KEYCLOAK_IMAGE",
        env: {
          ...openShellModelEnv,
          ...k3dImages,
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
          OCC_TEST_OPENSHELL_HELM: "helm",
          OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
          OCC_TEST_KEYCLOAK_IMAGE: mutableImage,
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const statePath = join(root, `state-${index}.json`);
      const result = await runPrepare(
        ["--lane", testCase.lane, "--state", statePath],
        testCase.env,
      );

      assert.equal(result.status, 1, `${testCase.lane} unexpectedly passed`);
      assert.match(result.stderr, new RegExp(`${testCase.envName} must be an immutable`));
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    }
  });
});
