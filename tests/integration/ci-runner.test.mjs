import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { describe } from "node:test";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

// Fixtures live under tmpdir(), which may itself sit inside an unrelated Git
// checkout. Stop Git's repository search at tmpdir() so the runner never reads
// that checkout's HEAD as the fixture's source SHA.
const fixtureGitEnv = { GIT_CEILING_DIRECTORIES: tmpdir() };

async function fixture(t) {
  const root = await temporaryDirectory(t, "ci-runner-");
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await mkdir(join(root, "tests/integration"), { recursive: true });
  await mkdir(join(root, "results"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runnerEnv(env = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.NODE_ENV;
  return {
    ...baseEnv,
    GITHUB_SHA: currentSha(),
    CI_RUNNER_PARENT_SECRET: "secretauthvalue-parent",
    // Fixture failures quote this value; the reporter must redact env values.
    CI_RUNNER_FIXTURE_CREDENTIAL: "secretauthvalue",
    // The fixture runners never inherit the lane's own deadline.
    CI_RUNNER_DEADLINE_MS: "",
    ...fixtureGitEnv,
    ...env,
  };
}

function run(root, args, env = {}, { timeout } = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: runnerEnv(env),
    timeout,
  });
}

function mixedPrecisionEventBoundary({ namespace, pod, second, laterCount = 199 }) {
  const event = (uid, reason, timestamp) => ({
    metadata: { namespace, name: `${uid}.event`, uid },
    involvedObject: { kind: "Pod", name: pod, namespace },
    type: "Normal",
    reason,
    message: reason,
    count: 1,
    ...timestamp,
  });
  const older = event("older-whole-second", "OlderWholeSecond", {
    lastTimestamp: `${second}Z`,
  });
  const newer = event("newer-fractional-second", "NewerFractionalSecond", {
    eventTime: `${second}.100000Z`,
  });
  const later = Array.from({ length: laterCount }, (_, index) =>
    event(`later-${index}`, `Later${index}`, {
      eventTime: new Date(Date.parse(`${second}Z`) + (index + 1) * 1_000).toISOString(),
    }),
  );
  return { older, newer, events: [older, newer, ...later] };
}

// run() without blocking this process, for the waiting tests below, which run side by side.
// The result has spawnSync's shape, including its ETIMEDOUT error when `timeout` ends the runner.
function runAsync(root, args, env = {}, { timeout, execArgv = [] } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...execArgv, runnerPath, ...args], {
      cwd: repositoryRoot,
      env: runnerEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            error ??= Object.assign(new Error(`runner exceeded ${timeout} ms`), {
              code: "ETIMEDOUT",
            });
            child.kill("SIGTERM");
          }, timeout);
    const settle = (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr, error });
    };
    child.on("error", (spawnError) => {
      error ??= spawnError;
      settle(null, null);
    });
    child.on("close", settle);
  });
}

// These tests wait out a real runner timeout, lane deadline or cleanup allowance: seconds
// each, at almost no CPU. Each duration stays as it is, long enough for a loaded host to
// reach the state the test needs before it elapses, or the runner's clock waits for that
// state (heldClock below). Instead they run side by side, after the rest of the file (see
// the describe at its end), so the file waits about as long as the longest of them rather
// than their sum. Each has its own fixture root, state and lock files, and starts the
// runner with runAsync.
const waitingTests = [];

function waitingTest(...args) {
  waitingTests.push(args);
}

// Node arguments that give the runner a clock that stands still at holdAt (Unix epoch
// milliseconds) until every gate path exists (tests/helpers/ci-runner-held-clock.mjs). A test
// that needs its fixture in some state before the lane deadline creates a gate there, so a
// busy host delays the deadline instead of reaching it first (finding 2164).
function heldClock(holdAt, gates) {
  const preload = new URL("../helpers/ci-runner-held-clock.mjs", import.meta.url);
  preload.searchParams.set("hold", String(holdAt));
  for (const gate of gates) {
    preload.searchParams.append("gate", gate);
  }
  return ["--import", preload.href];
}

// Node arguments that hold the runner just after it lists /proc, the first time it ends its
// descendants, until the `forked` path exists. It creates the `window` path when
// the hold starts (tests/helpers/ci-runner-kill-window.mjs, finding 2182).
function killWindow(window, forked) {
  const preload = new URL("../helpers/ci-runner-kill-window.mjs", import.meta.url);
  preload.searchParams.set("window", window);
  preload.searchParams.set("forked", forked);
  return ["--import", preload.href];
}

function currentSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writePrepare(root) {
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "export async function prepareFile({ file, statePath }) {",
      "  if (file.path.endsWith('first.test.mjs')) {",
      "    return {",
      "      env: { CI_RUNNER_SCOPED_VALUE: 'one', OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'a'.repeat(64), OCC_TEST_KUBERNETES_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'b'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'd'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'e'.repeat(64), OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: 'private.example/broker@sha256:' + 'c'.repeat(64), OCC_TEST_PRODUCTION_NODE_IMAGE: 'untrusted-image-value' },",
      "      cleanup: async () => appendFile(statePath, `${file.path}\\n`),",
      "    };",
      "  }",
      "  return { cleanup: async () => appendFile(statePath, `${file.path}\\n`) };",
      "}",
      "",
    ].join("\n"),
  );
}

test("run resolves lane documents relative to the manifest and preserves ordered case accounting", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state/lane.jsonl");
  const resultsPath = join(root, "results/baseline.json");
  await writePrepare(root);

  await writeFile(
    join(root, "tests/integration/first.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("first file sees scoped env", () => {',
      '  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, "one");',
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE, /@sha256:d{64}$/);",
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE, /@sha256:e{64}$/);",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/second.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("second file does not inherit scoped env", () => {',
      "  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  // Lane documents follow the manifest, but test paths still follow --root.
  await mkdir(join(root, "manifests/lanes"), { recursive: true });
  await writeJson(join(root, "manifests/lanes/baseline.json"), {
    requiredEnv: [
      "OCC_PROBE_CONTROLLER_IMAGE",
      "OCC_PROBE_BROKER_IMAGE",
      "OCC_PROBE_OLD_CONTROLLER_IMAGE",
      "OCC_PROBE_OLD_BROKER_IMAGE",
    ],
    files: [
      {
        path: "tests/integration/first.test.mjs",
        expectedTests: ["first file sees scoped env"],
      },
      {
        path: "tests/integration/second.test.mjs",
        expectedTests: ["second file does not inherit scoped env"],
      },
    ],
  });
  await writeJson(join(root, "manifests/suites.json"), {
    version: 1,
    lanes: { baseline: "./lanes/baseline.json" },
    groups: { ci: ["baseline"] },
  });

  const result = run(
    root,
    [
      "run",
      "baseline",
      "--manifest",
      "manifests/suites.json",
      "--root",
      root,
      "--state",
      statePath,
      "--results",
      resultsPath,
    ],
    {
      OCC_PROBE_CONTROLLER_IMAGE: `private.example/current-controller@sha256:${"b".repeat(64)}`,
      OCC_PROBE_BROKER_IMAGE: `private.example/current-broker@sha256:${"c".repeat(64)}`,
      OCC_PROBE_OLD_CONTROLLER_IMAGE: `private.example/old-controller@sha256:${"d".repeat(64)}`,
      OCC_PROBE_OLD_BROKER_IMAGE: `private.example/old-broker@sha256:${"e".repeat(64)}`,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.skipped, 0);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["tests/integration/first.test.mjs", "tests/integration/second.test.mjs"],
  );
  assert.equal(summary.files[0].cleanup.status, "passed");
  assert.ok(
    summary.files.every(
      (file) => Number.isInteger(file.wallDurationMs) && file.wallDurationMs >= 0,
    ),
  );
  // Evidence must retain immutable identity without exporting private registry names
  // or arbitrary prepared environment values alongside the public CI artifact.
  const pairDigests = {
    pairController: `sha256:${"b".repeat(64)}`,
    pairBroker: `sha256:${"c".repeat(64)}`,
    pairOldController: `sha256:${"d".repeat(64)}`,
    pairOldBroker: `sha256:${"e".repeat(64)}`,
  };
  assert.deepEqual(summary.files[0].imageDigests, {
    controller: `sha256:${"a".repeat(64)}`,
    runtime: `sha256:${"b".repeat(64)}`,
    controllerUpgrade: `sha256:${"d".repeat(64)}`,
    runtimeUpgrade: `sha256:${"e".repeat(64)}`,
    repositoryCredentials: `sha256:${"c".repeat(64)}`,
    ...pairDigests,
  });
  assert.deepEqual(summary.files[1].imageDigests, pairDigests);
  assert.doesNotMatch(JSON.stringify(summary), /private\.example|untrusted-image-value/);
  assert.match(await readFile(statePath, "utf8"), /first\.test\.mjs/);
});

test("run preserves nonzero child Node exits and rejects zero-case files", async (t) => {
  const root = await fixture(t);
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      exits: {
        files: [{ path: "tests/integration/exits.test.mjs" }],
      },
      empty: {
        files: [{ path: "tests/integration/empty.test.mjs" }],
      },
    },
    groups: {
      ci: ["exits", "empty"],
    },
  });
  await writeFile(join(root, "tests/integration/exits.test.mjs"), "process.exit(42);\n");
  await writeFile(join(root, "tests/integration/empty.test.mjs"), "process.exit(0);\n");

  const exits = run(root, [
    "run",
    "exits",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/exits.jsonl",
    "--results",
    "results/exits.json",
  ]);
  assert.notEqual(exits.status, 0);
  const exitSummary = JSON.parse(await readFile(join(root, "results/exits.json"), "utf8"));
  assert.equal(exitSummary.exitCode, exits.status);

  const empty = run(root, [
    "run",
    "empty",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/empty.jsonl",
    "--results",
    "results/empty.json",
  ]);
  assert.equal(empty.status, 1);
  const emptySummary = JSON.parse(await readFile(join(root, "results/empty.json"), "utf8"));
  assert.deepEqual(
    emptySummary.issues.map((entry) => entry.code),
    ["selected-zero"],
  );
});

test(
  "run annotates the first failed file before the lane finishes",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t);
    const first = "first.test.mjs";
    const second = "second.test.mjs";
    const files = [first, second].map((path) => ({ path }));
    await writePrepare(root);
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: { sample: { files } },
      groups: {},
    });
    await writeFile(
      join(root, first),
      'import test from "node:test";\ntest("private-case-canary", () => { throw new Error("::warning::private-message-canary"); });\n',
    );
    // Hold another failing file open to distinguish live reporting from a final summary.
    const release = join(root, "release");
    await writeFile(
      join(root, second),
      `import { existsSync } from "node:fs";
     import { setTimeout } from "node:timers/promises";
     import test from "node:test";
     test("second failure", {timeout: 20000}, async () => {
       while (!existsSync(${JSON.stringify(release)})) await setTimeout(50);
       throw new Error("second failure");
     });\n`,
    );
    const args = [
      "run",
      "sample",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/lane.jsonl",
      "--results",
      "results/sample.json",
    ];
    const child = spawn(process.execPath, [runnerPath, ...args], {
      env: runnerEnv({ GITHUB_ACTIONS: "true" }),
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve, reject) =>
      child.once("error", reject).once("close", resolve),
    );
    let code;
    const commands = () => stderr.match(/^::.*$/gm) ?? [];
    try {
      // Match the entire workflow command: no child-controlled text or extra commands.
      assert.ok(await waitFor(() => /^::.*\n/m.test(stderr), 10_000), "live workflow command");
      assert.deepEqual(commands(), [
        "::error title=Test lane failure::A test file reported failed tests and its cleanup passed. Final lane results will follow.",
      ]);
    } finally {
      await writeFile(release, "");
      code = await closed;
    }
    assert.equal(code, 1);
    assert.equal(commands().length, 1);
    assert.equal(await readFile(join(root, "state/lane.jsonl"), "utf8"), `${first}\n${second}\n`);
    const result = JSON.parse(await readFile(join(root, "results/sample.json"), "utf8"));
    assert.equal(result.counts.failed, 2);
  },
);

test("run records a sanitized file failure after all reported cases pass", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/file-failure.json");
  await writeFile(
    join(root, "tests/integration/file-failure.test.mjs"),
    [
      'import test from "node:test";',
      'test("first pass", () => {});',
      'setImmediate(() => { throw new Error("secretauthvalue-root-failure"); });',
      'test("second pass", () => {});',
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { failure: { files: [{ path: "tests/integration/file-failure.test.mjs" }] } },
    groups: { ci: ["failure"] },
  });

  const result = run(root, [
    "run",
    "failure",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/file-failure.jsonl",
    "--results",
    resultsPath,
  ]);
  const artifact = await readFile(resultsPath, "utf8");
  const summary = JSON.parse(artifact);
  assert.equal(result.status, 1);
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.failed, 0);
  assert.deepEqual(summary.files[0].fileFailure, {
    error: {
      code: "ERR_TEST_FAILURE",
      name: "Error",
      failureType: "testCodeFailure",
      exitCode: 1,
      message: "test failed",
    },
    diagnosticKind: "post-test-async-activity",
  });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
});

test("run fails missing expected tests, skipped expected tests, skips, todos, and missing required env", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/lane.json");

  await writeFile(
    join(root, "tests/integration/skips.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test, { describe } from "node:test";',
      'test("ordinary pass", () => assert.equal(1, 1));',
      'test("expected but skipped", { skip: "not allowed for expected" }, () => {});',
      'test("unexpected skipped case", { skip: "missing prerequisite" }, () => {});',
      'test("todo case", { todo: "missing prerequisite" }, () => {});',
      // A skipped suite reports no test event for the cases it never registered.
      'describe("skipped suite", { skip: "missing prerequisite" }, () => {',
      '  test("hidden case", () => assert.fail("must not run"));',
      "});",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      lane: {
        requiredEnv: ["CI_RUNNER_REQUIRED_INPUT"],
        files: [
          {
            path: "tests/integration/skips.test.mjs",
            expectedTests: ["ordinary pass", "expected but skipped", "missing named case"],
          },
        ],
      },
    },
    groups: {
      ci: ["lane"],
    },
  });

  const missingEnv = run(root, [
    "run",
    "lane",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/lane.jsonl",
    "--results",
    resultsPath,
  ]);
  assert.equal(missingEnv.status, 1);
  let summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(
    summary.issues.map((entry) => entry.code),
    ["missing-env"],
  );

  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  delete manifest.lanes.lane.requiredEnv;
  await writeJson(join(root, "manifest.json"), manifest);
  const selected = run(root, [
    "run",
    "lane",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/lane.jsonl",
    "--results",
    resultsPath,
  ]);
  assert.equal(selected.status, 1);
  summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "expected-test-not-passed",
    "missing-expected-test",
    "unexpected-skip",
    "unexpected-skip",
    "unexpected-skip",
    "unexpected-skip",
  ]);
  // Every issue is named in the job log, which keeps every attempt.
  for (const line of [
    "run-tests: issue missing-expected-test tests/integration/skips.test.mjs: expected test did not run: missing named case",
    "run-tests: issue expected-test-not-passed tests/integration/skips.test.mjs: expected test did not pass: expected but skipped",
    "run-tests: issue unexpected-skip tests/integration/skips.test.mjs: selected test did not run to completion: todo case",
    "run-tests: issue unexpected-skip tests/integration/skips.test.mjs: selected suite did not run its tests: skipped suite",
  ]) {
    assert.ok(selected.stderr.split("\n").includes(line), line);
  }
});

test("run records failed, skipped, todo, and passed dispositions separately", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/dispositions.json");

  await writeFile(
    join(root, "tests/integration/dispositions.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("passes", () => assert.equal(1, 1));',
      'test("fails", () => assert.equal(1, 2));',
      'test("skips", { skip: "expected" }, () => {});',
      'test("todo case", { todo: "expected" }, () => {});',
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      dispositions: {
        files: [
          {
            path: "tests/integration/dispositions.test.mjs",
          },
        ],
      },
    },
    groups: {
      ci: ["dispositions"],
    },
  });

  const result = run(root, [
    "run",
    "dispositions",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/dispositions.jsonl",
    "--results",
    resultsPath,
  ]);

  assert.notEqual(result.status, 0);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.counts, { passed: 1, failed: 1, skipped: 1, todo: 1, total: 4 });
  assert.deepEqual(
    summary.files[0].tests.map((entry) => [entry.name, entry.status]),
    [
      ["passes", "passed"],
      ["fails", "failed"],
      ["skips", "skipped"],
      ["todo case", "todo"],
    ],
  );
});

test("run clears inherited selectors and keep flags while preserving explicit lane inputs", async (t) => {
  const root = await fixture(t);

  await writeFile(
    join(root, "tests/integration/env-isolation.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("child env contains only explicit CI selectors", () => {',
      '  assert.equal(process.env.OCC_TEST_REQUIRED_SELECTOR, "required");',
      '  assert.equal(process.env.OCC_TEST_LANE_SELECTOR, "lane");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_SELECTOR, "selected");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_EMPTY, "");',
      "  assert.equal(process.env.OCC_TEST_OPTIONAL_ABSENT, undefined);",
      "  assert.equal(process.env.OCC_TEST_LEAKED_SELECTOR, undefined);",
      '  assert.equal(process.env.OCC_PROBE_REQUIRED_SELECTOR, "required");',
      "  assert.equal(process.env.OCC_PROBE_LEAKED_SELECTOR, undefined);",
      "  assert.equal(process.env.KEEP, undefined);",
      "  assert.equal(process.env.OCC_RUNTIME_KEEP, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      isolated: {
        env: {
          OCC_TEST_LANE_SELECTOR: "lane",
        },
        requiredEnv: ["OCC_TEST_REQUIRED_SELECTOR", "OCC_PROBE_REQUIRED_SELECTOR"],
        optionalEnv: [
          "OCC_TEST_OPTIONAL_SELECTOR",
          "OCC_TEST_OPTIONAL_EMPTY",
          "OCC_TEST_OPTIONAL_ABSENT",
          "OCC_TEST_LANE_SELECTOR",
        ],
        files: [{ path: "tests/integration/env-isolation.test.mjs" }],
      },
    },
    groups: {
      ci: ["isolated"],
    },
  });

  const result = run(
    root,
    [
      "run",
      "isolated",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/isolated.jsonl",
      "--results",
      "results/isolated.json",
    ],
    {
      KEEP: "1",
      OCC_RUNTIME_KEEP: "1",
      OCC_TEST_LEAKED_SELECTOR: "1",
      OCC_TEST_REQUIRED_SELECTOR: "required",
      OCC_TEST_OPTIONAL_SELECTOR: "selected",
      OCC_TEST_OPTIONAL_EMPTY: "",
      OCC_TEST_LANE_SELECTOR: "inherited",
      OCC_PROBE_LEAKED_SELECTOR: "1",
      OCC_PROBE_REQUIRED_SELECTOR: "required",
    },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("QA lane forwards selected models and observer input and retains outcomes at the requested path", async (t) => {
  const root = await fixture(t);
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/qa-matrix.json"), "utf8"),
  );
  const artifacts = join(root, "evidence");
  await mkdir(artifacts);
  const file = "tests/integration/qa-inputs.test.mjs";
  const qaSelectionHelper = pathToFileURL(
    join(repositoryRoot, "tests/helpers/qa-selection.mjs"),
  ).href;
  // Exercise the shipped lane definition with a small child that consumes its
  // inputs. This proves transport and artifact placement, not a live model turn.
  await writeFile(
    join(root, file),
    `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { selectQaMatrix } from ${JSON.stringify(qaSelectionHelper)};
test("QA inputs", async () => {
  assert.equal(process.env.OCC_TEST_QA_OPENAI_MODEL, "selected-openai-model");
  assert.equal(process.env.OCC_TEST_QA_CODEX_MODEL, "selected-codex-model");
  assert.equal(process.env.OCC_TEST_CODEX_CALENDAR_PROMPT, "selected calendar read");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE, undefined);
  assert.equal(process.env.QA_REPOSITORY_FIXTURE, "isolated");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY, "selected-app-input");
  const selection = selectQaMatrix(process.env);
  assert.ok(selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.equal(process.env.OCC_TEST_QA_INSTALLATION, "compose");
  assert.equal(process.env.OCC_TEST_QA_PRESET, "Codex");
  assert.equal(process.env.OCC_TEST_QA_SCENARIOS, "model-ui,calendar,git-write");
  await writeFile(join(process.env.OCC_TEST_QA_ARTIFACTS, "matrix.json"), JSON.stringify({ outcome: "inputs received" }));
});
`,
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { "qa-matrix": { ...lane, files: [{ path: file }] } },
    groups: { qa: ["qa-matrix"] },
  });
  const result = run(
    root,
    [
      "run",
      "qa-matrix",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/qa.json",
      "--results",
      "results/qa.json",
    ],
    {
      ...Object.fromEntries(lane.requiredEnv.map((name) => [name, "fixture-input"])),
      OCC_TEST_QA_OPENAI_MODEL: "selected-openai-model",
      OCC_TEST_QA_CODEX_MODEL: "selected-codex-model",
      OCC_TEST_CODEX_CALENDAR_PROMPT: "selected calendar read",
      OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY: "selected-app-input",
      QA_REPOSITORY_FIXTURE: "isolated",
      OCC_TEST_QA_ARTIFACTS: artifacts,
      OCC_TEST_QA_INSTALLATION: "compose",
      OCC_TEST_QA_PRESET: "Codex",
      OCC_TEST_QA_SCENARIOS: "model-ui,calendar,git-write",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, "matrix.json"), "utf8")), {
    outcome: "inputs received",
  });
});

test("run records timeout cancellation without leaking child output", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/timeout.json");

  await writeFile(
    join(root, "tests/integration/timeout.test.mjs"),
    [
      'import test from "node:test";',
      'test("hangs past the lane timeout", async () => {',
      '  console.error("secretauthvalue-timeout");',
      "  await new Promise((resolve) => setTimeout(resolve, 10_000));",
      "});",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      timeout: {
        files: [{ path: "tests/integration/timeout.test.mjs" }],
      },
    },
    groups: {
      ci: ["timeout"],
    },
  });

  const result = run(
    root,
    [
      "run",
      "timeout",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/timeout.jsonl",
      "--results",
      resultsPath,
    ],
    { CI_RUNNER_TEST_TIMEOUT_MS: "100" },
  );

  assert.equal(result.status, 1);
  const text = await readFile(resultsPath, "utf8");
  assert.doesNotMatch(text, /secretauthvalue/);
  const summary = JSON.parse(text);
  assert.equal(summary.files[0].nodeExitCode, 1);
  assert(summary.issues.some((entry) => entry.code === "test-timeout"));
  // A timeout always leaves a record, even before the test printed anything.
  const report = await readFile(join(root, "state/timeout.jsonl.diagnostics.json"), "utf8");
  assert.doesNotMatch(report, /secretauthvalue/);
  const [record] = JSON.parse(report).failures;
  assert.equal(record.reason, "timeout");
  assert.equal(record.timeoutMs, 100);
});

// Field 5 of /proc/<pid>/stat is the process group; the name in parentheses may hold spaces.
function procStat(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /su, "")
      .split(" ");
    return { state: fields[0], pgid: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

// The recorded fixture processes still in group `pgid` that nothing has killed. A process
// counts as killed once it is gone, a zombie (Z) or dead and being reaped (X), or SIGKILL
// is pending for its whole thread group. kill(-pgid, "SIGKILL") queues that shared signal
// before it returns and the kernel clears it only when it releases the process, so this
// needs no deadline. Waiting for the processes to disappear did: on a busy host a killed
// multithreaded Node process can take seconds to finish exiting (a zombie leader with
// another thread still running its exit, or a process still being reaped).
function unkilled(pids, pgid) {
  return pids.filter((pid) => {
    const stat = procStat(pid);
    if (stat === undefined || stat.pgid !== pgid || stat.state === "Z" || stat.state === "X") {
      return false;
    }
    let status;
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return false;
    }
    // Signal masks are hexadecimal with bit (signal number - 1) set; SIGKILL is 9.
    const sharedPending = /^ShdPnd:\s*([0-9a-f]+)$/mu.exec(status);
    return sharedPending === null || (BigInt(`0x${sharedPending[1]}`) & (1n << 8n)) === 0n;
  });
}

waitingTest(
  "run kills a timed-out file's whole process group after the timeout record",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/orphan.json");
    const recordPath = join(root, "state/orphan-pids.json");
    const waiting = join(root, "state/orphan-waiting");
    // The isolated test-file child ignores SIGTERM and has a child of its own, so the
    // Node test runner's own SIGTERM handling cannot end either of them.
    await writeFile(
      join(root, "tests/integration/orphan.test.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("outlives its runner", async () => {',
        '  process.on("SIGTERM", () => {});',
        '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
        '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
        "  writeFileSync(process.env.CI_RUNNER_ORPHAN_RECORD, JSON.stringify({",
        "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
        "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
        "  }));",
        '  console.log("waiting with SIGTERM ignored");',
        `  writeFileSync(${JSON.stringify(waiting)}, "");`,
        "  await new Promise((resolve) => setTimeout(resolve, 60_000));",
        "});",
        "",
      ].join("\n"),
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: { orphan: { files: [{ path: "tests/integration/orphan.test.mjs" }] } },
      groups: { ci: ["orphan"] },
    });
    let pids;
    // Never leave the fixture's processes behind, whatever the outcome: only the exact
    // pids the fixture recorded, still in the fixture's group, never a group.
    t.after(() => {
      for (const pid of [pids?.runner, pids?.file, pids?.grandchild]) {
        if (Number.isSafeInteger(pid) && pid > 1 && procStat(pid)?.pgid === pids.pgid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    });

    // The runner's clock stands still from the start until the file has recorded its pids and
    // printed its line, so its timeout comes five seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      [
        "run",
        "orphan",
        "--manifest",
        "manifest.json",
        "--root",
        root,
        "--state",
        statePath,
        "--results",
        join(root, "results/orphan.json"),
      ],
      { CI_RUNNER_TEST_TIMEOUT_MS: "5000", CI_RUNNER_ORPHAN_RECORD: recordPath },
      { timeout: 60_000, execArgv: heldClock(started, [waiting]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    pids = JSON.parse(await readFile(recordPath, "utf8"));
    // The timeout record still comes from the runner's reporter before the group dies.
    const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
    assert.equal(record.reason, "timeout");
    assert.equal(record.timeoutMs, 5000);
    assert.deepEqual(record.interruptedTests, [{ name: "outlives its runner", line: 4 }]);
    assert.deepEqual(record.output.lines, ["stdout: waiting with SIGTERM ignored"]);
    // The runner sent the group SIGKILL before it exited; finishing the exit is the kernel's.
    assert.deepEqual(unkilled([pids.file, pids.grandchild], pids.pgid), []);
    // The Node test runner leads its own process group, apart from this test's.
    assert(Number.isSafeInteger(pids.runner) && pids.runner > 1, String(pids.runner));
    assert.equal(pids.pgid, pids.runner);
    assert.equal(pids.grandchildPgid, pids.runner);
    assert.notEqual(pids.pgid, procStat(process.pid).pgid);
  },
);

test(
  "run kills what a passing file left in its process group",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const recordPath = join(root, "state/leftover-pids.json");
    // The file passes and exits; its grandchild, unref'd, would run on for a minute.
    await writeFile(
      join(root, "tests/integration/leftover.test.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes and leaves a process behind", () => {',
        '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
        "  grandchild.unref();",
        '  const pgid = Number(readFileSync(`/proc/${grandchild.pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
        "  writeFileSync(process.env.CI_RUNNER_ORPHAN_RECORD, JSON.stringify({ runner: process.ppid, grandchild: grandchild.pid, pgid }));",
        "});",
        "",
      ].join("\n"),
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: { leftover: { files: [{ path: "tests/integration/leftover.test.mjs" }] } },
      groups: { ci: ["leftover"] },
    });
    let pids;
    t.after(() => {
      const pid = pids?.grandchild;
      if (Number.isSafeInteger(pid) && pid > 1 && procStat(pid)?.pgid === pids.pgid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });

    const result = run(
      root,
      [
        "run",
        "leftover",
        "--manifest",
        "manifest.json",
        "--root",
        root,
        "--state",
        join(root, "state/leftover.json"),
        "--results",
        join(root, "results/leftover.json"),
      ],
      { CI_RUNNER_ORPHAN_RECORD: recordPath },
    );

    assert.equal(result.status, 0, result.stderr);
    pids = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(pids.pgid, pids.runner);
    assert.deepEqual(unkilled([pids.grandchild], pids.pgid), []);
  },
);

// Polls until check() is truthy or the deadline passes; returns check()'s last value.
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = check();
  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = check();
  }
  return value;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(
    `run kills every live test group on ${signal} and exits by that signal`,
    { skip: process.platform !== "linux" && "reads /proc" },
    async (t) => {
      const root = await fixture(t);
      const recordPath = join(root, "state/hang-pids.json");
      // The isolated test-file child ignores the signal and has a child of its own, so
      // only the forwarded SIGKILL to the Node test runner's group can end them.
      await writeFile(
        join(root, "tests/integration/hang.test.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { readFileSync, renameSync, writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs with the signal ignored", async () => {',
          `  process.on(${JSON.stringify(signal)}, () => {});`,
          '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });',
          '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
          "  const record = process.env.CI_RUNNER_ORPHAN_RECORD;",
          "  writeFileSync(`${record}.partial`, JSON.stringify({",
          "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
          "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
          "  }));",
          "  renameSync(`${record}.partial`, record);",
          "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
          "});",
          "",
        ].join("\n"),
      );
      await writeJson(join(root, "manifest.json"), {
        version: 1,
        lanes: { hang: { files: [{ path: "tests/integration/hang.test.mjs" }] } },
        groups: { ci: ["hang"] },
      });

      // Detached, so the signal reaches only run-tests.mjs, never this test's group.
      const ciRunner = spawn(
        process.execPath,
        [
          runnerPath,
          "run",
          "hang",
          "--manifest",
          "manifest.json",
          "--root",
          root,
          "--state",
          join(root, "state/hang.json"),
          "--results",
          join(root, "results/hang.json"),
        ],
        {
          cwd: repositoryRoot,
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: runnerEnv({
            CI_RUNNER_TEST_TIMEOUT_MS: "30000",
            CI_RUNNER_ORPHAN_RECORD: recordPath,
          }),
        },
      );
      let stderr = "";
      ciRunner.stderr.setEncoding("utf8");
      ciRunner.stderr.on("data", (chunk) => (stderr += chunk));
      let exit;
      const exited = new Promise((resolve) =>
        ciRunner.on("exit", (code, exitSignal) => {
          exit = { code, signal: exitSignal };
          resolve(exit);
        }),
      );
      let pids;
      // Never leave processes behind, whatever the outcome: only the pid this test
      // spawned, and the exact pids the fixture recorded while still in its group.
      t.after(async () => {
        if (exit === undefined) {
          // Let run-tests.mjs end its test groups first: they may not have recorded pids.
          for (const lastResort of ["SIGTERM", "SIGKILL"]) {
            try {
              process.kill(ciRunner.pid, lastResort);
            } catch {
              // Already gone.
            }
            if (await waitFor(() => exit !== undefined, 2_000)) {
              break;
            }
          }
        }
        for (const pid of [pids?.runner, pids?.file, pids?.grandchild]) {
          if (Number.isSafeInteger(pid) && pid > 1 && procStat(pid)?.pgid === pids.pgid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      });

      const recorded = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(recordPath, "utf8"));
        } catch {
          return exit !== undefined ? "exited" : undefined;
        }
      }, 30_000);
      assert.equal(typeof recorded, "object", `no test file started (${recorded}): ${stderr}`);
      pids = recorded;
      // The Node test runner leads its own group, apart from run-tests.mjs and this test.
      assert(Number.isSafeInteger(pids.runner) && pids.runner > 1, String(pids.runner));
      assert.equal(pids.pgid, pids.runner);
      assert.equal(pids.grandchildPgid, pids.runner);
      assert.notEqual(pids.pgid, ciRunner.pid);
      assert.notEqual(pids.pgid, procStat(process.pid).pgid);

      process.kill(ciRunner.pid, signal);
      let timer;
      const outcome = await Promise.race([
        exited,
        new Promise((resolve) => (timer = setTimeout(resolve, 10_000, "still running"))),
      ]);
      clearTimeout(timer);
      assert.deepEqual(outcome, { code: null, signal }, stderr);
      // The runner sent the group SIGKILL before it exited; finishing the exit is the kernel's.
      assert.deepEqual(unkilled([pids.runner, pids.file, pids.grandchild], pids.pgid), []);
    },
  );
}

test("run redacts arbitrary stdout, stderr, assertion payloads, and stacks from artifacts", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/redacted.json");
  const secret = "secretauthvalue";
  const relayPodCases = [
    {
      name: "retains closed relay Pod status without payloads",
      relayPod: {
        lookup: "found",
        phase: "Running",
        scheduled: "True",
        ready: "False",
        containerState: "waiting",
        waitingReason: "CrashLoopBackOff",
        terminationReason: "OOMKilled",
        exitCode: 137,
        restartCount: 3,
        nodeAssigned: true,
        imageIdPresent: true,
        containerIdPresent: false,
        message: secret,
        pod: { spec: { containers: [{ env: [{ value: secret }] }] } },
      },
      expected: {
        lookup: "found",
        phase: "Running",
        scheduled: "True",
        ready: "False",
        containerState: "waiting",
        waitingReason: "CrashLoopBackOff",
        terminationReason: "OOMKilled",
        exitCode: 137,
        restartCount: 3,
        nodeAssigned: true,
        imageIdPresent: true,
        containerIdPresent: false,
      },
    },
    {
      name: "retains closed scheduling causes in canonical order",
      relayPod: {
        lookup: "found",
        phase: "Pending",
        scheduled: "False",
        scheduledReason: "Unschedulable",
        schedulingFailures: [
          "insufficient-memory",
          "disk-pressure",
          "disk-pressure",
          secret,
          { message: secret },
        ],
        message: secret,
      },
      expected: {
        lookup: "found",
        phase: "Pending",
        scheduled: "False",
        scheduledReason: "Unschedulable",
        schedulingFailures: ["disk-pressure", "insufficient-memory", "other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "replaces unknown relay Pod fields and omits invalid scalars",
      relayPod: {
        lookup: "found",
        phase: secret,
        scheduled: { value: secret },
        scheduledReason: secret,
        schedulingFailures: secret,
        ready: [secret],
        containerState: secret,
        waitingReason: secret,
        terminationReason: { message: secret },
        exitCode: 1.5,
        restartCount: -1,
        nodeAssigned: "true",
        imageIdPresent: 1,
        containerIdPresent: { value: secret },
      },
      expected: {
        lookup: "found",
        phase: "other",
        scheduled: "other",
        scheduledReason: "other",
        schedulingFailures: ["other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "rejects out-of-range relay Pod counters",
      relayPod: {
        lookup: "found",
        exitCode: 256,
        restartCount: 2 ** 31,
        scheduledReason: "SchedulingGated",
        schedulingFailures: Array(14).fill("disk-pressure"),
      },
      expected: {
        lookup: "found",
        phase: "other",
        scheduled: "other",
        scheduledReason: "SchedulingGated",
        schedulingFailures: ["other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "retains unavailable relay Pod lookup without its error",
      relayPod: { lookup: "unavailable", error: { message: secret }, exitCode: 137 },
      expected: { lookup: "unavailable" },
    },
    {
      name: "replaces unknown relay Pod lookup",
      relayPod: { lookup: secret, phase: secret },
      expected: { lookup: "other" },
    },
    ...[null, "invalid", []].map((relayPod, index) => ({
      name: `rejects malformed relay Pod diagnostic ${index}`,
      relayPod,
      expected: undefined,
    })),
    {
      name: "discards relay Pod status outside relay readiness",
      stage: "controller-startup",
      relayPod: { lookup: "found", phase: "Running", message: secret },
      expected: undefined,
    },
  ];

  const relayNodeCases = [
    {
      name: "retains closed node pressure evidence without node or workload identities",
      relayNode: {
        lookup: "found",
        conditions: {
          ready: "True",
          diskPressure: "True",
          memoryPressure: "False",
          pidPressure: "False",
          networkUnavailable: "Unknown",
          message: secret,
        },
        unschedulable: false,
        taints: [
          { category: "disk-pressure", effect: "NoSchedule", key: secret, value: secret },
          { category: "disk-pressure", effect: "NoSchedule" },
          { category: secret, effect: secret, message: secret },
        ],
        taintCount: 3,
        unrecognizedTaintCount: 1,
        name: secret,
        providerID: secret,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: 0,
            capacityBytes: 1024,
            inodesFree: 2,
            inodes: 4096,
            mountpoint: secret,
          },
          imageFs: {
            availableBytes: 512,
            capacityBytes: 2048,
            inodesFree: 0,
            inodes: Number.MAX_SAFE_INTEGER,
          },
          pods: [{ name: secret, containers: [{ logs: secret }] }],
        },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "True",
          diskPressure: "True",
          memoryPressure: "False",
          pidPressure: "False",
          networkUnavailable: "Unknown",
        },
        unschedulable: false,
        taints: [
          { category: "disk-pressure", effect: "NoSchedule" },
          { category: "other", effect: "other" },
        ],
        taintCount: 3,
        unrecognizedTaintCount: 1,
        filesystems: {
          lookup: "found",
          nodeFs: { availableBytes: 0, capacityBytes: 1024, inodesFree: 2, inodes: 4096 },
          imageFs: {
            availableBytes: 512,
            capacityBytes: 2048,
            inodesFree: 0,
            inodes: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    },
    {
      name: "rejects malformed node fields and unsafe filesystem counters",
      relayNode: {
        lookup: "found",
        conditions: { ready: secret, diskPressure: [secret] },
        unschedulable: "true",
        taints: Array(65).fill({ category: "disk-pressure", effect: "NoSchedule" }),
        taintCount: -1,
        unrecognizedTaintCount: 2 ** 31,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: -1,
            capacityBytes: 1.5,
            inodesFree: "3",
            inodes: Number.MAX_SAFE_INTEGER + 1,
          },
          imageFs: [secret],
          message: secret,
        },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [{ category: "other", effect: "other" }],
        filesystems: { lookup: "found", nodeFs: {} },
      },
    },
    {
      name: "retains node lookup when optional filesystem lookup fails",
      relayNode: {
        lookup: "found",
        conditions: null,
        taints: [],
        taintCount: 0,
        unrecognizedTaintCount: 0,
        filesystems: { lookup: "unavailable", error: secret },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [],
        taintCount: 0,
        unrecognizedTaintCount: 0,
        filesystems: { lookup: "unavailable" },
      },
    },
    {
      name: "replaces unknown node and filesystem categories",
      relayNode: {
        lookup: "found",
        taints: secret,
        filesystems: { lookup: secret, nodeFs: { availableBytes: 3 }, message: secret },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [{ category: "other", effect: "other" }],
        filesystems: { lookup: "other" },
      },
    },
    {
      name: "retains unavailable node lookup without its error",
      relayNode: { lookup: "unavailable", error: secret, name: secret },
      expected: { lookup: "unavailable" },
    },
    {
      name: "replaces unknown node lookup",
      relayNode: { lookup: secret, conditions: secret },
      expected: { lookup: "other" },
    },
    ...[null, secret, []].map((relayNode, index) => ({
      name: `rejects malformed relay node diagnostic ${index}`,
      relayNode,
      expected: undefined,
    })),
    {
      name: "discards node evidence outside relay readiness",
      stage: "controller-startup",
      relayNode: { lookup: "found", name: secret },
      expected: undefined,
    },
  ];

  await writeFile(
    join(root, "tests/integration/redacted.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("redacted failure locator", () => {',
      `  console.log("${secret}-stdout");`,
      `  console.error("${secret}-stderr");`,
      `  assert.equal("${secret}-actual", "expected");`,
      "});",
      'test("job env redaction", () => {',
      '  throw new Error("owner openclaw-public-owner strippedjobvalue42");',
      "});",
      'test("redacted custom error", () => {',
      `  console.log("${secret}-custom-stdout");`,
      `  console.error("${secret}-custom-stderr");`,
      `  const error = new Error("${secret}-message");`,
      `  error.name = "${secret}-name";`,
      `  error.code = "${secret}-code";`,
      "  throw error;",
      "});",
      'test("allowlisted controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(503, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 503,",
      "      expectedStatus: 201,",
      '      occErrorCode: "DEPENDENCY_UNAVAILABLE",',
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      '        operation: "create-service-account",',
      "        status: 403,",
      `        body: "${secret}-body",`,
      "      },",
      `      identity: "${secret}-identity",`,
      "    };",
      "    throw error;",
      "  }",
      "});",
      'test("allowlisted observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: true, worker: false, records: ["${secret}-record"] };`,
      "  throw error;",
      "});",
      'test("rejects unsafe observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: "${secret}", worker: false };`,
      "  throw error;",
      "});",
      'test("rejects unsafe controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(500, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 500,",
      "      expectedStatus: 201,",
      `      occErrorCode: "${secret}-code",`,
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      `        operation: "${secret}-operation",`,
      "        status: 401,",
      "      },",
      "    };",
      "    throw error;",
      "  }",
      "});",
      'for (const stage of ["ready-status", "warning-status", "initial-rollout", "warning-rollout", "secretauthvalue-stage"]) {',
      '  test(stage === "secretauthvalue-stage" ? "unsafe plugin stage" : stage, () => {',
      '    const error = new Error("secretauthvalue-message");',
      '    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage, body: "secretauthvalue-body" };',
      '    if (stage === "warning-rollout") error.openclawCiDiagnostic.pods = [',
      '      { phase: "Pending", ready: false, scheduled: true, secret: "secretauthvalue", containers: [',
      '        { name: "gateway", restartCount: 2, exitCode: 1, waitingReason: "CrashLoopBackOff", terminatedReason: "Error", message: "secretauthvalue" },',
      '        { name: "secretauthvalue", restartCount: 3 },',
      '        { name: "gateway", restartCount: 4 }',
      "      ] },",
      '      { phase: "secretauthvalue" },',
      '      { phase: "Running", ready: "secretauthvalue", scheduled: "secretauthvalue", containers: [',
      '        { name: "prepare-private-state", restartCount: -1, exitCode: 256, waitingReason: "secretauthvalue", terminatedReason: "secretauthvalue" }',
      "      ] },",
      '      { phase: "Failed" }',
      "    ];",
      "    throw error;",
      "  });",
      "}",
      `for (const { name, diagnostic } of ${JSON.stringify([
        {
          name: "allowlisted denied traffic diagnostic",
          diagnostic: {
            kind: "network-policy",
            stage: "Agent outbound platform traffic",
            target: secret,
          },
        },
        {
          name: "rejects unsafe denied traffic diagnostic",
          diagnostic: { kind: "network-policy", stage: secret },
        },
        {
          name: "allowlisted runtime stock broker diagnostic",
          diagnostic: {
            kind: "runtime-image-stock-broker",
            stage: "broker-denial",
            command: [secret],
            stderr: `${secret}-stderr`,
          },
        },
        {
          name: "rejects unsafe runtime stock broker stage",
          diagnostic: { kind: "runtime-image-stock-broker", stage: `${secret}-stage` },
        },
        {
          name: "retains native first-Agent proof failure stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement",
            output: `${secret}-output`,
          },
        },
        {
          name: "retains a terminal native first-Agent placement stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-reclaimed",
          },
        },
        {
          name: "rejects unknown native first-Agent proof stage",
          diagnostic: { kind: "native-first-agent-proof", failureStage: `${secret}-stage` },
        },
        {
          name: "retains safe monitoring readiness evidence",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: "prometheus-up",
            reason: "container-exited",
            container: "agent",
            exitCode: 2,
            lastHttpStatus: 503,
            logs: secret,
          },
        },
        {
          name: "rejects unsafe monitoring stage",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: secret,
            reason: "timeout",
          },
        },
        {
          name: "allowlisted repository platform setup diagnostic",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "relay-readiness",
            args: [secret],
            configuration: { credential: secret },
          },
        },
        {
          name: "allowlisted credential service startup reason",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "credential-service-startup",
            credentialService: "gateway-listener",
          },
        },
        {
          name: "rejects unsafe credential service startup reason",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "credential-service-startup",
            credentialService: `${secret}-reason`,
          },
        },
        {
          name: "rejects unsafe repository platform setup stage",
          diagnostic: { kind: "repository-platform-setup", stage: `${secret}-stage` },
        },
        {
          name: "rejects nonstring repository platform setup stage",
          diagnostic: { kind: "repository-platform-setup", stage: { value: secret } },
        },
        {
          name: "rejects unknown setup diagnostic kind",
          diagnostic: { kind: `${secret}-kind`, stage: "relay-readiness" },
        },
        ...relayPodCases.map(({ name, stage = "relay-readiness", relayPod }) => ({
          name,
          diagnostic: { kind: "repository-platform-setup", stage, relayPod },
        })),
        ...relayNodeCases.map(({ name, stage = "relay-readiness", relayNode }) => ({
          name,
          diagnostic: { kind: "repository-platform-setup", stage, relayNode },
        })),
      ])}) {`,
      "  test(name, () => {",
      `    const cause = new Error("${secret}-source-message");`,
      `    cause.args = ["${secret}-argument"];`,
      `    cause.configuration = { credential: "${secret}-credential" };`,
      `    const error = new Error("${secret}-setup-message", { cause });`,
      "    error.openclawCiDiagnostic = diagnostic;",
      "    throw error;",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      redacted: {
        files: [{ path: "tests/integration/redacted.test.mjs" }],
      },
    },
    groups: {
      ci: ["redacted"],
    },
  });

  const result = run(
    root,
    [
      "run",
      "redacted",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/redacted.jsonl",
      "--results",
      resultsPath,
    ],
    {
      // Public runner metadata stays readable; the runner strips OCC_TEST_* from
      // the test child, so only its own second pass can redact this value.
      GITHUB_REPOSITORY_OWNER: "openclaw-public-owner",
      OCC_TEST_STRIPPED_VALUE: "strippedjobvalue42",
    },
  );

  assert.equal(result.status, 1);
  const details = await readFile(join(root, "state/redacted.jsonl.diagnostics.json"), "utf8");
  const cliAndArtifact = `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}\n${details}`;
  assert.doesNotMatch(cliAndArtifact, /secretauthvalue|strippedjobvalue42/);
  assert.ok(JSON.parse(details).failures[0].tests.length > 0);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.files[0].tests[0].name, "redacted failure locator");
  assert.equal(summary.files[0].tests[0].line, 3);
  const failure = summary.files[0].tests[0].error;
  assert.equal(failure.code, "ERR_TEST_FAILURE");
  assert.equal(failure.name, "Error");
  assert.equal(failure.cause.code, "ERR_ASSERTION");
  assert.equal(failure.cause.name, "AssertionError");
  assert.equal(
    failure.location.file,
    await realpath(join(root, "tests/integration/redacted.test.mjs")),
  );
  assert.equal(failure.location.line, 6);
  assert.ok(failure.location.column > 0);
  // The bounded message and top frame name the failure; env values never survive.
  assert.match(failure.message, /'\[env:CI_RUNNER_FIXTURE_CREDENTIAL\]-actual'/);
  assert.match(failure.message, /'expected'/);
  assert.match(failure.frame, /\(tests\/integration\/redacted\.test\.mjs:6:\d+\)$/);
  assert.match(
    result.stderr,
    /run-tests: failed tests\/integration\/redacted\.test\.mjs:6 "redacted failure locator": Expected values/,
  );
  const customFailure = summary.files[0].tests.find(
    (entry) => entry.name === "redacted custom error",
  );
  assert.equal(customFailure.status, "failed");
  assert.equal(customFailure.error.cause, undefined);
  assert.equal(customFailure.error.location.line, 14);
  assert.equal(customFailure.error.message, "[env:CI_RUNNER_FIXTURE_CREDENTIAL]-message");
  assert.equal(
    summary.files[0].tests.find((entry) => entry.name === "job env redaction").error.message,
    "owner openclaw-public-owner [env:OCC_TEST_STRIPPED_VALUE]",
  );
  const httpFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted controller HTTP diagnostic",
  );
  assert.deepEqual(httpFailure.error.diagnostic, {
    kind: "controller-http",
    status: 503,
    expectedStatus: 201,
    occErrorCode: "DEPENDENCY_UNAVAILABLE",
    upstream: { kind: "chatgpt-admin-http", operation: "create-service-account", status: 403 },
  });
  const unsafeFailure = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe controller HTTP diagnostic",
  );
  assert.equal(unsafeFailure.error.diagnostic, undefined);
  const logExportFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted observability log export diagnostic",
  );
  assert.deepEqual(logExportFailure.error.diagnostic, {
    kind: "observability-log-export",
    api: true,
    worker: false,
  });
  const unsafeLogExportFailure = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe observability log export diagnostic",
  );
  assert.equal(unsafeLogExportFailure.error.diagnostic, undefined);
  // Keep the failed wait identifiable without exposing arbitrary runtime output.
  for (const stage of ["ready-status", "warning-status", "initial-rollout"]) {
    const failure = summary.files[0].tests.find((entry) => entry.name === stage);
    assert.deepEqual(failure.error.diagnostic, { kind: "kubernetes-plugin-status", stage });
  }
  const rolloutFailure = summary.files[0].tests.find((entry) => entry.name === "warning-rollout");
  assert.deepEqual(rolloutFailure.error.diagnostic, {
    kind: "kubernetes-plugin-status",
    stage: "warning-rollout",
    pods: [
      {
        phase: "Pending",
        ready: false,
        scheduled: true,
        containers: [
          {
            name: "gateway",
            restartCount: 2,
            exitCode: 1,
            waitingReason: "CrashLoopBackOff",
            terminatedReason: "Error",
          },
        ],
      },
      { phase: "Running", containers: [{ name: "prepare-private-state" }] },
    ],
  });
  const unsafeStage = summary.files[0].tests.find((entry) => entry.name === "unsafe plugin stage");
  assert.equal(unsafeStage.error.diagnostic, undefined);
  const deniedTraffic = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted denied traffic diagnostic",
  );
  assert.deepEqual(deniedTraffic.error.diagnostic, {
    kind: "network-policy",
    stage: "Agent outbound platform traffic",
  });
  const unsafeTraffic = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe denied traffic diagnostic",
  );
  assert.equal(unsafeTraffic.error.diagnostic, undefined);
  const stockBrokerFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted runtime stock broker diagnostic",
  );
  assert.deepEqual(stockBrokerFailure.error.diagnostic, {
    kind: "runtime-image-stock-broker",
    stage: "broker-denial",
  });
  const unsafeStockBroker = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe runtime stock broker stage",
  );
  assert.equal(unsafeStockBroker.error.diagnostic, undefined);
  const nativeProof = summary.files[0].tests.find(
    (entry) => entry.name === "retains native first-Agent proof failure stage",
  );
  assert.equal(nativeProof.status, "failed");
  assert.deepEqual(nativeProof.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement",
  });
  const terminalPlacement = summary.files[0].tests.find(
    (entry) => entry.name === "retains a terminal native first-Agent placement stage",
  );
  assert.deepEqual(terminalPlacement.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-reclaimed",
  });
  const monitoringFailure = summary.files[0].tests.find(
    (entry) => entry.name === "retains safe monitoring readiness evidence",
  );
  assert.deepEqual(monitoringFailure.error.diagnostic, {
    kind: "metrics-monitoring",
    stage: "prometheus-up",
    reason: "container-exited",
    container: "agent",
    exitCode: 2,
    lastHttpStatus: 503,
  });
  const unsafeMonitoring = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe monitoring stage",
  );
  assert.equal(unsafeMonitoring.error.diagnostic, undefined);
  const setupFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted repository platform setup diagnostic",
  );
  assert.deepEqual(setupFailure.error.diagnostic, {
    kind: "repository-platform-setup",
    stage: "relay-readiness",
  });
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "allowlisted credential service startup reason",
    ).error.diagnostic,
    {
      kind: "repository-platform-setup",
      stage: "credential-service-startup",
      credentialService: "gateway-listener",
    },
  );
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "rejects unsafe credential service startup reason",
    ).error.diagnostic,
    { kind: "repository-platform-setup", stage: "credential-service-startup" },
  );
  for (const { name, stage = "relay-readiness", expected } of relayPodCases) {
    const relayFailure = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(relayFailure.status, "failed");
    assert.equal(relayFailure.error.diagnostic.stage, stage);
    assert.deepEqual(relayFailure.error.diagnostic.relayPod, expected, name);
  }
  for (const { name, stage = "relay-readiness", expected } of relayNodeCases) {
    const nodeFailure = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(nodeFailure.status, "failed");
    assert.equal(nodeFailure.error.diagnostic.stage, stage);
    assert.deepEqual(nodeFailure.error.diagnostic.relayNode, expected, name);
  }
  for (const name of [
    "rejects unknown native first-Agent proof stage",
    "rejects unsafe repository platform setup stage",
    "rejects nonstring repository platform setup stage",
    "rejects unknown setup diagnostic kind",
  ]) {
    const rejected = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error.diagnostic, undefined);
  }
});

test("failure text is bounded and redacts env values and credential shapes", async () => {
  const { default: reporter } = await import("../../scripts/ci/reporter.mjs");
  const { failureSecrets, redactFailure } = await import("../../scripts/ci/failure-redaction.mjs");
  const secrets = failureSecrets([
    { GITHUB_REPOSITORY_OWNER: "openclaw", JOB_ONLY_KEY: "jobonlyopaque123" },
    {
      CHILD_URL: syntheticCredentialUrl({
        protocol: "postgres",
        username: "app",
        password: "childpw77",
        host: "db",
        pathname: "/app",
      }),
      JOB_ONLY_KEY: "otheropaque456",
    },
  ]);
  const render = async (cause) => {
    let text = "";
    for await (const chunk of reporter([
      { type: "test:fail", data: { name: "case", details: { error: { cause } } } },
    ])) {
      text += chunk;
    }
    const raw = JSON.parse(text.split("\n")[0]).data.error;
    const error = redactFailure(raw, secrets, "/repo");
    // The whole stack goes only to the diagnostics report's copy.
    assert.equal(error.stack, undefined);
    return error;
  };
  const credentials = [
    "Authorization: Bearer abcdefghijklmnop0123",
    syntheticCredentialUrl({
      protocol: "postgres",
      username: "occ",
      password: "hunter2pass",
      host: "db.internal",
      port: 5432,
      pathname: "/occ",
    }),
    "token=ghp_0123456789abcdefghijABCDEFGHIJ",
    'password: "correct-horse"',
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl",
    "sk-proj-0123456789abcdef",
    "xoxb-1234-5678-abcdefgh",
    "xapp-1-A0123-4567-abcdef",
    [
      syntheticCredentialUrl({
        protocol: "redis",
        username: "",
        password: "redispw99",
        host: "cache",
        port: 6379,
      }),
      syntheticCredentialUrl({
        username: "tokenvalue123",
        password: "",
        host: "git.example",
      }).replace(":@", "@"),
    ].join(" "),
    '{"privateKey":"pkvalue123"}',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
    "job jobonlyopaque123 child otheropaque456 password childpw77",
  ];
  const error = await render(
    new Error(`request failed for openclaw at /repo/x.mjs\n${credentials.join("\n")}`),
  );
  // Public runner metadata stays readable; the repository path is stripped.
  assert.match(error.message, /^request failed for openclaw at x\.mjs\n/);
  assert.match(
    error.message,
    /job \[env:JOB_ONLY_KEY\] child \[env:JOB_ONLY_KEY\] password \[env:CHILD_URL\]/,
  );
  for (const leaked of [
    "abcdefghijklmnop0123",
    "hunter2pass",
    "ghp_0123",
    "correct-horse",
    "eyJhbGci",
    "sk-proj",
    "xoxb-",
    "MIIEabc",
    "xapp-1",
    "redispw99",
    "tokenvalue123",
    "pkvalue123",
  ]) {
    assert.doesNotMatch(error.message, new RegExp(leaked));
  }
  assert.match(error.frame, /^at /);
  // A stack quoted in the message is not the frame.
  const quoted = await render({
    message: "child failed\n    at quoted (/elsewhere/child.js:1:1)",
    stack:
      "Error: child failed\n    at quoted (/elsewhere/child.js:1:1)\n    at real (helper.mjs:2:3)",
  });
  assert.equal(quoted.frame, "at real (helper.mjs:2:3)");
  // A value split by the cut survives as neither the value nor a prefix of it.
  const long = await render(new Error(`${"x".repeat(16_370)} jobonlyopaque123`));
  assert.ok(long.message.length < 700);
  assert.match(long.message, /\.\.\. \[truncated\]$/);
  const straddle = await render(new Error(`${"y ".repeat(296)}key jobonlyopaque123 tail`));
  assert.doesNotMatch(straddle.message, /jobonly/);
  assert.equal((await render("thrown string")).message, "thrown string");
  assert.equal((await render(undefined)).message, undefined);
});

test("the reporter forwards a failed file's output tail and whole stack only", async () => {
  const { default: reporter } = await import("../../scripts/ci/reporter.mjs");
  const { failureSecrets, redactFailureDetail, redactOutputLine } =
    await import("../../scripts/ci/failure-redaction.mjs");
  const render = async (events) => {
    const lines = [];
    let text = "";
    for await (const chunk of reporter(events)) {
      text += chunk;
    }
    for (const line of text.split("\n").filter(Boolean)) {
      lines.push(JSON.parse(line));
    }
    return lines;
  };
  const chatter = [
    { type: "test:stdout", data: { file: "a.mjs", message: "first line\nsplit " } },
    { type: "test:stderr", data: { file: "a.mjs", message: "err\n" } },
    { type: "test:stdout", data: { file: "a.mjs", message: "line\n" } },
    { type: "test:diagnostic", data: { file: "/repo/a.mjs", message: "phase timings" } },
    { type: "test:diagnostic", data: { message: "tests 1" } },
    ...Array.from({ length: 1_000 }, (_, index) => ({
      type: "test:stdout",
      data: { file: "a.mjs", message: `bulk ${index}\n` },
    })),
    { type: "test:stdout", data: { file: "a.mjs", message: "no newline" } },
  ];
  // A passing file sends only its case events.
  const passing = await render([...chatter, { type: "test:pass", data: { name: "case" } }]);
  assert.deepEqual(
    passing.map(({ type }) => type),
    ["test:pass"],
  );
  const failing = await render([
    { type: "test:stdout", data: { file: "a.mjs", message: "first line\nsplit " } },
    { type: "test:stderr", data: { file: "a.mjs", message: "err\n" } },
    { type: "test:stdout", data: { file: "a.mjs", message: "line\n" } },
    { type: "test:diagnostic", data: { file: "/repo/a.mjs", message: "phase timings" } },
    { type: "test:diagnostic", data: { message: "tests 1" } },
    { type: "test:fail", data: { name: "case", details: { error: new Error("boom") } } },
    { type: "test:stdout", data: { file: "a.mjs", message: "no newline" } },
  ]);
  assert.deepEqual(failing.at(-1), {
    type: "test:output",
    data: {
      lines: [
        "stdout: first line",
        "stderr: err",
        "stdout: split line",
        "diagnostic: phase timings",
        "stdout: no newline",
      ],
      omitted: 0,
    },
  });
  assert.match(failing[0].data.error.stack, /^at /);
  // The tail keeps the last 400 lines and counts the rest.
  const chatty = await render([...chatter, { type: "test:fail", data: { name: "case" } }]);
  const tail = chatty.at(-1).data;
  assert.equal(tail.lines.length, 400);
  assert.equal(tail.lines.at(-1), "stdout: no newline");
  assert.equal(tail.lines[0], "stdout: bulk 601");
  assert.equal(tail.omitted, 605);

  const secrets = failureSecrets([{ JOB_ONLY_KEY: "jobonlyopaque123" }]);
  const decisive = `${"x".repeat(700)}\nAuthorization: Basic c2hvcnQ=\nprobe code MODEL_PROBE_CPU_STARVED key jobonlyopaque123`;
  const detail = redactFailureDetail(
    { message: decisive, stack: "at helper (/repo/tests/a.mjs:2:3)\nat next (/repo/b.mjs:4:5)" },
    secrets,
    "/repo",
  );
  // The whole message survives where the job log keeps 600 characters.
  assert.match(detail.message, /probe code MODEL_PROBE_CPU_STARVED key \[env:JOB_ONLY_KEY\]$/);
  assert.match(detail.message, /\n\[redacted credential-bearing line\]\n/);
  assert.equal(detail.stack, "at helper (tests/a.mjs:2:3)\nat next (b.mjs:4:5)");
  assert.equal(redactFailureDetail(undefined, secrets, "/repo"), undefined);
  assert.equal(
    redactOutputLine(
      `stdout: proxy ${syntheticCredentialUrl({ username: "user", password: "pw", host: "example.test" })}`,
      secrets,
      "/repo",
      1_000,
    ),
    "[redacted credential-bearing line]",
  );
  assert.equal(
    redactOutputLine(`stdout: ${"y".repeat(2_000)}`, secrets, "/repo", 1_000),
    `stdout: ${"y".repeat(992)}... [truncated]`,
  );
  // A token the shape cannot match whole still drops its line.
  assert.equal(
    redactOutputLine("stdout: Bearer abcdefghij%rest-of-the-value", secrets, "/repo", 1_000),
    "[redacted credential-bearing line]",
  );
  assert.equal(
    redactFailureDetail({ message: "header Token abcdefgh%ijklmnop" }, secrets, "/repo").message,
    "[redacted credential-bearing line]",
  );
  assert.equal(
    redactFailureDetail({ message: "SyntaxError: Unexpected token '}'" }, secrets, "/repo").message,
    "SyntaxError: Unexpected token '}'",
  );
  // A message the reporter cut at 16 KiB still loses its possibly split tail after
  // the raw pass has shortened it.
  const cutMessage = `Bearer abcdefgh leak-value\n${"x".repeat(16_384 - 27 - 11)}jobonlyopaq`;
  assert.equal(cutMessage.length, 16_384);
  const cutDetail = redactFailureDetail({ message: cutMessage }, secrets, "/repo").message;
  assert.match(cutDetail, /^\[redacted credential-bearing line\]\nx+$/);
  assert.doesNotMatch(cutDetail, /jobonly|leak-value/);
  // A control character inside a private key header cannot keep its body.
  assert.doesNotMatch(
    redactFailureDetail(
      {
        message:
          "-----BEGIN RSA PRIV\u0000ATE KEY-----\nMIIEbodyline\n-----END RSA PRIVATE KEY-----",
      },
      secrets,
      "/repo",
    ).message,
    /MIIEbodyline/,
  );
  // A credential marker drops its whole line, though the token shape consumes the marker.
  const sameLine = redactFailureDetail(
    {
      message: "before\nBearer abcdefgh unrelated-runtime-value-12345\nafter",
      stack: "at test (Bearer abcdefgh unrelated-runtime-value-12345)\nat next (b.mjs:1:1)",
    },
    secrets,
    "/repo",
  );
  assert.equal(sameLine.message, "before\n[redacted credential-bearing line]\nafter");
  assert.equal(sameLine.stack, "[redacted credential-bearing line]\nat next (b.mjs:1:1)");
  assert.equal(
    redactFailureDetail({ message: "Bear\u001b[0mer abcdefgh other-value-9" }, secrets, "/repo")
      .message,
    "[redacted credential-bearing line]",
  );
  assert.equal(
    redactOutputLine("stdout: Bear\u001b[0mer abcdefgh other-value-9", secrets, "/repo", 1_000),
    "[redacted credential-bearing line]",
  );
  // A private key is replaced whole, its body lines included.
  assert.equal(
    redactFailureDetail(
      {
        message:
          "key\n-----BEGIN RSA PRIVATE KEY-----\nMIIEbody\n-----END RSA PRIVATE KEY-----\nend",
      },
      secrets,
      "/repo",
    ).message,
    "key\n[redacted]\nend",
  );
  // Each line of a multi-line env value (a PEM body) is redacted on its own.
  const pem = failureSecrets([{ TLS_KEY: "line one opaque value\nline two opaque value\n" }]);
  assert.equal(
    redactOutputLine("stdout: line two opaque value", pem, "/repo", 1_000),
    "stdout: [env:TLS_KEY]",
  );
  // The rest of a line cut at the input limit is dropped, not started as a new line.
  const cut = await render([
    { type: "test:stdout", data: { file: "a.mjs", message: "z".repeat(16_400) } },
    { type: "test:stdout", data: { file: "a.mjs", message: "1234567890 tail\nnext line\n" } },
    { type: "test:fail", data: { name: "case" } },
  ]);
  const cutLines = cut.at(-1).data.lines;
  assert.equal(cutLines.length, 2);
  assert.equal(cutLines[0].length, 16_384);
  assert.equal(cutLines[1], "stdout: next line");
});

test("the redactor removes URL userinfo of any shape and multi-line private keys", async () => {
  const { failureSecrets, redactFailure, redactLogLine, redactOutputLine, redactOutputLines } =
    await import("../../scripts/ci/failure-redaction.mjs");
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.mjs");
  const secrets = failureSecrets([{ JOB_ONLY_KEY: "jobonlyopaque123" }]);
  // Synthetic userinfo: a password with "/", one with an unescaped "@", a hex one,
  // and a user-only token.
  const slash = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_app",
    password: "pa/ss0123456789",
    host: "postgres",
    port: 5432,
    pathname: "/occ",
  });
  const at = syntheticCredentialUrl({
    protocol: "redis",
    username: "cache",
    password: "p@ssw0rd-tail",
    host: "cache",
    port: 6379,
  });
  const hex = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_app",
    password: "0123abcd4567ef89",
    host: "postgres",
    pathname: "/occ",
  });
  const user = syntheticCredentialUrl({
    username: "tokenvalue123",
    password: "",
    host: "git.example",
  }).replace(":@", "@");
  assert.equal(
    redactLogLine(`db ${slash} down`, secrets, 1_000),
    "db postgresql://[redacted]@postgres:5432/occ down",
  );
  assert.equal(redactLogLine(`cache ${at}`, secrets, 1_000), "cache redis://[redacted]@cache:6379");
  assert.equal(redactLogLine(hex, secrets, 1_000), "postgresql://[redacted]@postgres/occ");
  assert.equal(redactLogLine(user, secrets, 1_000), "https://[redacted]@git.example");
  const failure = redactFailure(
    { message: `${slash}\n${at}`, frame: `at x (${slash})` },
    secrets,
    "",
  );
  assert.doesNotMatch(JSON.stringify(failure), /pa\/ss|ssw0rd|0123456789/);
  // Any scheme's userinfo drops the whole output line, as http(s) did.
  for (const url of [slash, at, hex, user]) {
    assert.equal(
      redactOutputLine(`stderr: connect ${url}`, secrets, "", 1_000),
      "[redacted credential-bearing line]",
    );
  }
  // A password with both "@" and "/", and a user part with "?" or "#", lose it all.
  const mixed = syntheticCredentialUrl({
    username: "u",
    password: "p@ss/w0rd-tail",
    host: "host",
    port: 1,
    pathname: "/db",
  });
  assert.equal(redactLogLine(mixed, secrets, 1_000), "https://[redacted]@host:1/db");
  for (const odd of ["https://user?x@host/p", "https://user#x@host/p"]) {
    assert.equal(redactLogLine(odd, secrets, 1_000), "https://[redacted]@host/p");
  }
  // A path "@" (an npm scope) is not userinfo, and plain URLs stay readable.
  for (const line of [
    "stdout: GET https://registry.npmjs.org/@openclaw/cli 404",
    "stdout: see https://example.test:8443/docs/install for details",
  ]) {
    assert.equal(redactOutputLine(line, secrets, "", 1_000), line);
  }

  // A plain-text private key loses its body lines too, not only its header and footer.
  const body = ["MIIEsyntheticBodyLineOneAAAA", "syntheticBodyLineTwoBBBBBBBB"];
  const key = ["-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----"];
  const marker = "[redacted credential-bearing line]";
  assert.deepEqual(
    redactOutputLines(
      ["stdout: before", ...key.map((line) => `stderr: ${line}`), "stdout: after"],
      secrets,
      "",
      1_000,
    ),
    ["stdout: before", marker, marker, marker, marker, "stdout: after"],
  );
  // An unterminated key runs to the end; a tail that starts inside a key loses
  // every line above its END; a control character cannot hide the header.
  assert.deepEqual(redactOutputLines(["start", ...key.slice(0, 3)], secrets, "", 1_000), [
    "start",
    marker,
    marker,
    marker,
  ]);
  assert.deepEqual(redactOutputLines([...key.slice(1), "after"], secrets, "", 1_000), [
    marker,
    marker,
    marker,
    "after",
  ]);
  assert.deepEqual(
    redactOutputLines(
      ["-----BEGIN RSA PRIV\u0000ATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----", "end"],
      secrets,
      "",
      1_000,
    ),
    [marker, marker, marker, marker, "end"],
  );
  // A PGP key block counts; an element holding "\n" itself keeps the mapping.
  assert.deepEqual(
    redactOutputLines(
      [
        "x\ny",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        ...body,
        "-----END PGP PRIVATE KEY BLOCK-----",
        "after",
      ],
      secrets,
      "",
      1_000,
    ),
    ["x\ny", marker, marker, marker, marker, "after"],
  );
  // An orphan END masks a bounded number of lines above it, not the whole tail.
  const orphan = redactOutputLines(
    [...Array.from({ length: 1_100 }, (_, index) => `line ${index}`), ...key.slice(1)],
    secrets,
    "",
    1_000,
  );
  assert.equal(orphan.length, 1_103);
  assert.equal(orphan[0], "line 0");
  assert.equal(orphan[1_099], marker);
  assert.equal(orphan.filter((line) => line === marker).length, 1_025);
  // Lines without a key keep the per-line behaviour.
  assert.deepEqual(redactOutputLines(["plain", "key jobonlyopaque123"], secrets, "", 1_000), [
    "plain",
    "key [env:JOB_ONLY_KEY]",
  ]);

  // The container log projection follows the same rules.
  const projected = projectContainerLog(
    {
      lines: ["ready", ...key, `dial ${slash}`, "Authori\u0000zation: synthetic-xyz123", "done"],
      stream: { error: ["follow failed", ...key].join("\n") },
    },
    secrets,
  );
  assert.deepEqual(projected.lines, [
    "ready",
    marker,
    marker,
    marker,
    marker,
    marker,
    marker,
    "done",
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic|pa\/ss/);
});

test("the redactor removes secrets inside escaped JSON and keys from filtered log lines", async () => {
  const { failureSecrets, newestMatchingLogLines, redactFailureDetail, redactLogLine } =
    await import("../../scripts/ci/failure-redaction.mjs");
  const secrets = failureSecrets([{}]);
  // A JSON document embedded in a log string escapes its quotes, once or more (finding 1551).
  // Synthetic values only; none is in the env or has a known token shape.
  for (const [line, expected] of [
    [
      String.raw`body {\"password\":\"plainvalue123\"} end`,
      String.raw`body {\"password\":\"[redacted]\"} end`,
    ],
    [
      String.raw`{\"client_secret\":\"syntheticClientValue0123\",\"realm\":\"occ\"}`,
      String.raw`{\"client_secret\":\"[redacted]\",\"realm\":\"occ\"}`,
    ],
    [
      String.raw`{\\\"api_key\\\":\\\"syntheticApiValue456\\\"}`,
      String.raw`{\\\"api_key\\\":\\\"[redacted]\\\"}`,
    ],
    [
      String.raw`{\\\\\\\"token\\\\\\\":\\\\\\\"syntheticDeepValue789\\\\\\\"}`,
      String.raw`{\\\\\\\"token\\\\\\\":\\\\\\\"[redacted]\\\\\\\"}`,
    ],
    // Unescaped forms keep their behaviour, and a backslash inside a value is redacted with it.
    [`{"password":"plainvalue123"}`, `{"password":"[redacted]"}`],
    [String.raw`password=synthetic\value tail`, "password=[redacted] tail"],
    // Prose that names a keyword without assigning it is untouched.
    ["SyntaxError: Unexpected token in JSON at position 3", null],
    ["SyntaxError: Unexpected token '}'", null],
  ]) {
    assert.equal(redactLogLine(line, secrets, 1_000), expected ?? line);
  }
  assert.doesNotMatch(
    redactFailureDetail(
      { message: String.raw`config {\"password\":\"plainvalue123\"}` },
      secrets,
      "/repo",
    ).message,
    /plainvalue123/,
  );

  // A private key's body line that matches the filter is masked before the filter keeps it.
  const logs = [
    "worker start",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEsyntheticWorkerBodyLineAAAA",
    "syntheticBodyLineTwoBBBBBBBB",
    "-----END RSA PRIVATE KEY-----",
    "worker turn failed: ECONNRESET",
    "debug noise",
  ].join("\n");
  const shown = newestMatchingLogLines(logs, secrets, {
    pattern: /worker|turn/iu,
    exclude: /noise/u,
    budget: 1_000,
    lineChars: 400,
  });
  assert.equal(shown, "worker start\nworker turn failed: ECONNRESET");
  // Newest lines win the budget, and each kept line is clipped after redaction.
  assert.equal(
    newestMatchingLogLines("turn one\nturn two\nturn three", secrets, {
      pattern: /turn/u,
      budget: 20,
      lineChars: 400,
    }),
    "turn two\nturn three",
  );
  assert.equal(
    newestMatchingLogLines(`turn password=${"x".repeat(50)}`, secrets, {
      pattern: /turn/u,
      budget: 1_000,
      lineChars: 20,
    }),
    "turn password=[redac... [truncated]",
  );
});

test("secret redaction preserves JSON quoting, not pieces of the quoted value", async () => {
  const { redactLogLine, redactFailureDetail } =
    await import("../../scripts/ci/failure-redaction.mjs");
  const redacted = "[redacted]";
  // Serialize actual values instead of guessing how many backslashes the log contains.
  for (const value of [
    'first "middle", last',
    "first, last",
    "first last",
    "last\\",
    "",
    "é\n🎈",
  ]) {
    let input = JSON.stringify({ password: value, phase: "after" });
    let expected = JSON.stringify({ password: redacted, phase: "after" });
    for (let depth = 0; depth < 4; depth++) {
      assert.equal(redactLogLine(input, [], 2_000), expected);
      assert.equal(redactFailureDetail({ message: input }, [], "/repo").message, expected);
      input = JSON.stringify(input);
      expected = JSON.stringify(expected);
    }
  }
  // Logs can end mid-value. Neither a space nor an escaped quote ends the secret.
  assert.equal(
    redactLogLine('password="first part, still private', [], 200),
    'password="[redacted]',
  );
  // A failure message need not be JSON. A newline inside an open password is still private.
  assert.equal(
    redactLogLine('password="first part\nprivate tail" expected status 503', [], 200),
    'password="[redacted]" expected status 503',
  );
});

test("a quoted auth header keeps the failure text after it", async () => {
  const { failureSecrets, redactFailure, redactLogLine } =
    await import("../../scripts/ci/failure-redaction.mjs");
  const secrets = failureSecrets([{}]);
  const assertion = "\nexpected status 503, got 200\ndecisive: gateway refused the turn";
  // Synthetic values. The auth-scheme value used to take the closing quote, so the quoted
  // value then ran to the end of the text and took the assertion with it (finding 1556).
  for (const [header, expected] of [
    ['{"authorization":"Bearer syntheticBearer0123"}', '{"authorization":"[redacted]"}'],
    [
      "headers: { authorization: 'Bearer syntheticBearer0123' }",
      "headers: { authorization: '[redacted]' }",
    ],
    ['{"token":"Token syntheticToken0123"}', '{"token":"[redacted]"}'],
    [
      String.raw`{\"authorization\":\"Basic c3ludGhldGljOnZhbHVl\"}`,
      String.raw`{\"authorization\":\"[redacted]\"}`,
    ],
    ["map[Authorization:[Basic c3ludGhldGljOnZhbHVl]]", "map[Authorization:[redacted]]"],
    // A sibling field after the closing quote is not part of the value.
    [
      '{"authorization":"Bearer syntheticBearer0123","status":503}',
      '{"authorization":"[redacted]","status":503}',
    ],
    [
      "headers: { authorization: 'Bearer syntheticBearer0123', status: 503 }",
      "headers: { authorization: '[redacted]', status: 503 }",
    ],
    // Logs can escape or repeat delimiters inside the value. Keep only the actual closing ones.
    [String.raw`got Bearer synthetic0\"private-tail`, "got [redacted]"],
    ["map[Authorization:[Basic synthetic0))private-tail]]", "map[Authorization:[redacted]]"],
    // A quote that opens the value is kept with it.
    [`curl -H "Authorization: Bearer 'synthetic0'"`, `curl -H "Authorization: '[redacted]'"`],
    ['Authorization: Bearer "synthetic0"', 'Authorization: "[redacted]"'],
    [String.raw`Basic c3ludGhldGlj\/dmFsdWU=`, "[redacted]"],
  ]) {
    assert.equal(
      redactLogLine(`request ${header}${assertion}`, secrets, 1_000),
      `request ${expected}${assertion}`,
    );
    assert.equal(
      redactFailure({ message: `request ${header}${assertion}` }, secrets, "/repo").message,
      `request ${expected}${assertion}`,
    );
  }
});

test("the redactor removes structured, multi-word and short secret values", async () => {
  const { failureSecrets, redactLogLine } = await import("../../scripts/ci/failure-redaction.mjs");
  const secrets = failureSecrets([{}]);
  // Synthetic values only (finding 1559).
  for (const [line, expected] of [
    // An object or array after a credential key, to its close on the same line.
    [
      '{"credentials":{"key":"syntheticNested0"},"after":"keep"}',
      '{"credentials":[redacted],"after":"keep"}',
    ],
    [
      '{"tokens":["syntheticA0","syntheticB0"],"after":"keep"}',
      '{"tokens":[redacted],"after":"keep"}',
    ],
    [
      JSON.stringify(
        { credentials: { label: 'a "quote" and } private tail' }, after: "keep" },
        null,
        2,
      ),
      '{\n  "credentials": [redacted],\n  "after": "keep"\n}',
    ],
    ["tokens: [{value: '] private tail'}] status=503", "tokens: [redacted] status=503"],
    ["secret: { nested: { value: 'synthetic0' } } tail", "secret: [redacted] tail"],
    ["token: {unclosed synthetic0\nprivate tail", "token: [redacted]"],
    ["token: [{wrong close]private tail", "token: [redacted]"],
    // A bracket inside a string does not close the value, and text glued to the close
    // belongs to it.
    ['{"credentials":{"password":"ab}synthetic0"}}', '{"credentials":[redacted]}'],
    ['{"token":{"inner":"a]synthetic0"},"after":1}', '{"token":[redacted],"after":1}'],
    ["token: [a]synthetic0 tail", "token: [redacted] tail"],
    // A passphrase in prose or YAML, and an Authorization header, take every word.
    ["password: synthetic words here\nnext line", "password: [redacted]\nnext line"],
    ["passphrase: synthetic words, then more", "passphrase: [redacted], then more"],
    ['{"error":"bad password: synthetic words"}', '{"error":"bad password: [redacted]"}'],
    ["Authorization: Bearer syn", "Authorization: [redacted]"],
    // "=" stays one word, as in logfmt and query strings.
    ["password=synthetic0 next=keep", "password=[redacted] next=keep"],
    // A key inside the phrase starts its own assignment, so its quoted value is redacted.
    [
      'password: synthetic0 token="synthetic1" tail',
      'password: [redacted] token="[redacted]" tail',
    ],
    [
      "Authorization: Bearer s api_key='synthetic1'",
      "Authorization: [redacted] api_key='[redacted]'",
    ],
    // Short scheme values with a digit, and keys the list did not have.
    ["sent Bearer s0 upstream", "sent [redacted] upstream"],
    ["sent Basic ab)synthetic0] upstream", "sent [redacted]] upstream"],
    [
      "https://blob.example/x?sv=1&sig=syntheticSig0&se=2",
      "https://blob.example/x?sv=1&sig=[redacted]&se=2",
    ],
    ["pwd=synthetic0", "pwd=[redacted]"],
    ["passphrase=synthetic0", "passphrase=[redacted]"],
    ["accessKey=synthetic0", "accessKey=[redacted]"],
    ["signature: synthetic0", "signature: [redacted]"],
    // Ordinary diagnostics that name a keyword without a value stay readable.
    ["Bearer token expired", null],
    ["token expired", null],
    ["secretName: occ-gateway-password", null],
    ["tokenCount: 3", null],
    ["design=compact", null],
    ["SyntaxError: Unexpected token '}'", null],
  ]) {
    assert.equal(redactLogLine(line, secrets, 1_000), expected ?? line, line);
  }
});

test("run keeps a failed file's whole messages, stacks and output in the diagnostics report", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/details.json");
  const statePath = join(root, "state/details.json");
  await writeFile(
    join(root, "tests/integration/details.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("passes", () => {});',
      'test("long failure", (t) => {',
      '  console.log("progress before the failure");',
      "  console.error(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
      '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
      '  t.diagnostic("phase timings 1234 ms");',
      '  assert.fail(`password="fixture,\\nprivate-tail" phase=after ${"stage line\\n".repeat(80)}decisive line ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/quiet.test.mjs"),
    'import test from "node:test";\ntest("quiet", () => { console.log("passing output"); });\n',
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      details: {
        files: [
          { path: "tests/integration/details.test.mjs" },
          { path: "tests/integration/quiet.test.mjs" },
        ],
      },
    },
    groups: { ci: ["details"] },
  });

  const result = run(root, [
    "run",
    "details",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    statePath,
    "--results",
    resultsPath,
  ]);

  assert.equal(result.status, 1);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  const failed = summary.files[0].tests.find(({ name }) => name === "long failure");
  // Results and the job log keep the short message only.
  assert.match(failed.error.message, /\.\.\. \[truncated\]$/);
  assert.match(failed.error.message, /password="\[redacted\]" phase=after/);
  assert.doesNotMatch(failed.error.message, /private-tail|decisive line/);
  assert.equal(failed.error.stack, undefined);
  assert.match(
    result.stderr,
    /run-tests: whole failure messages, stacks and output tails are in .*state\/details\.json\.diagnostics\.json \(artifact diagnostics-<prefix>-details-attempt-(?:\d+|<N>)\)/,
  );
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123|private-tail|passing output/);
  const report = JSON.parse(text);
  assert.equal(report.lane, "details");
  assert.equal(report.failures.length, 1);
  const [record] = report.failures;
  assert.equal(record.file, "tests/integration/details.test.mjs");
  assert.equal(record.omittedTests, 0);
  const detail = record.tests.find(({ name }) => name === "long failure");
  assert.equal(detail.line, 9);
  assert.match(detail.message, /decisive line \[env:CI_RUNNER_FIXTURE_CREDENTIAL\]$/);
  assert.match(detail.stack, /tests\/integration\/details\.test\.mjs:9:\d+/);
  // stdout and stderr arrive on separate pipes, so only the set of lines is fixed.
  assert.deepEqual([...record.output.lines].sort(), [
    "[redacted credential-bearing line]",
    "diagnostic: phase timings 1234 ms",
    "stderr: credential [env:CI_RUNNER_FIXTURE_CREDENTIAL]",
    "stdout: progress before the failure",
  ]);
  assert.equal(record.output.omittedLines, 0);
});

test("the reporter sends interrupted tests and the output tail, newest first, on a timeout", async () => {
  const { default: reporter } = await import("../../scripts/ci/reporter.mjs");
  const render = async (events) => {
    let text = "";
    for await (const chunk of reporter(events)) {
      text += chunk;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const at = (name, line, nesting = 1) => ({ name, line, column: 1, nesting, file: "/repo/a.mjs" });
  const sent = await render([
    { type: "test:dequeue", data: at("/repo/a.mjs", 1, 0) },
    { type: "test:dequeue", data: at("done", 2) },
    { type: "test:stdout", data: { file: "a.mjs", message: "early\n" } },
    { type: "test:complete", data: at("done", 2) },
    { type: "test:dequeue", data: at("hangs", 5) },
    // Two runs of a test declared in a loop share a location; one is still running.
    { type: "test:dequeue", data: at("loop", 9) },
    { type: "test:dequeue", data: at("loop", 9) },
    { type: "test:complete", data: at("loop", 9) },
    ...Array.from({ length: 450 }, (_, index) => ({
      type: "test:stdout",
      // Quotes double in JSON; batches are measured as sent.
      data: { file: "a.mjs", message: `bulk ${index} ${'"'.repeat(1_000)}\n` },
    })),
    { type: "test:stderr", data: { file: "a.mjs", message: "last words" } },
    { type: "test:interrupted", data: { tests: [at("/repo/a.mjs", 1, 0)] } },
    { type: "test:fail", data: { name: "hangs", details: { error: new Error("cancelled") } } },
  ]);
  assert.equal(sent[0].type, "test:interrupted");
  assert.deepEqual(sent[0].data.running, [
    { name: "/repo/a.mjs", line: 1, nesting: 0 },
    { name: "hangs", line: 5, nesting: 1 },
    { name: "loop", line: 9, nesting: 1 },
  ]);
  const batches = sent.filter(({ type }) => type === "test:output");
  // Small batches, newest first, each counting the lines before it; nothing is sent twice.
  assert(batches.length > 1);
  assert(batches.every(({ data }) => JSON.stringify(data).length < 40 * 1024));
  assert.equal(batches[0].data.lines.at(-1), "stderr: last words");
  const omitted = batches.map(({ data }) => data.omitted);
  assert.deepEqual(
    omitted,
    [...omitted].sort((a, b) => b - a),
  );
  assert.equal(batches.at(-1).data.omitted, 52);
  const lines = batches.reverse().flatMap(({ data }) => data.lines);
  assert.equal(lines.length, 400);
  assert.match(lines[0], /^stdout: bulk 51 "+$/);
  assert.equal(new Set(lines).size, 400);
  assert.equal(sent.at(-1).type, "test:fail");
});

waitingTest(
  "run records a timed-out file's interrupted test and output tail in the diagnostics report",
  async (t) => {
    const root = await fixture(t);
    const resultsPath = join(root, "results/hang.json");
    const statePath = join(root, "state/hang.json");
    // Holds when the file printed its last line.
    const printed = join(root, "state/hang-printed");
    await writeFile(
      join(root, "tests/integration/hang.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs", async () => {',
        "  for (let index = 0; index < 500; index += 1) {",
        '    console.log(`bulk ${index} ${"v".repeat(2_000)}`);',
        "  }",
        "  console.log(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
        '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
        '  console.log("waiting for a reply that never comes");',
        `  writeFileSync(${JSON.stringify(printed)}, String(Date.now()));`,
        "  // Ends by itself in case the runner leaves it behind.",
        "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
        "});",
        "",
      ].join("\n"),
    );
    // Node can exit mid-line after the interruption; the test runner process here
    // always does, and the runner must skip that cut line.
    const cutAtExit = join(root, "scripts/ci/cut-at-exit.cjs");
    await writeFile(
      cutAtExit,
      'if (process.execArgv.includes("--test")) process.on("exit", () => process.stdout.write(\'{"type":"test:output","data":{"lines":["cut\'));\n',
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        hang: {
          env: { NODE_OPTIONS: `--require=${cutAtExit}` },
          files: [{ path: "tests/integration/hang.test.mjs" }],
        },
      },
      groups: { ci: ["hang"] },
    });

    // The runner's clock stands still from the start until the file has printed everything, so its
    // timeout comes five seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      [
        "run",
        "hang",
        "--manifest",
        "manifest.json",
        "--root",
        root,
        "--state",
        statePath,
        "--results",
        resultsPath,
      ],
      { CI_RUNNER_TEST_TIMEOUT_MS: "5000" },
      { timeout: 60_000, execArgv: heldClock(started, [printed]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert(summary.issues.some((entry) => entry.code === "test-timeout"));
    const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
    assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123/);
    const [record] = JSON.parse(text).failures;
    assert.equal(record.file, "tests/integration/hang.test.mjs");
    assert.equal(record.reason, "timeout");
    assert.equal(record.timeoutMs, 5000);
    // The file ran at least its timeout, and the timeout (with its 5 s grace) ended it well before
    // its own 30 s wait did. The held clock stood still until the last line, and the runner
    // records real time, so that bound counts from then.
    const sincePrinted = Number(await readFile(printed, "utf8")) - started;
    assert(
      record.elapsedMs >= 5000 && record.elapsedMs < sincePrinted + 15_000,
      `${record.elapsedMs} ms, last line ${sincePrinted} ms in`,
    );
    assert.deepEqual(record.interruptedTests, [{ name: "hangs", line: 4 }]);
    // Up to the last 400 of 503 lines, newest last, with the usual redaction. Node
    // exits soon after the interruption, so on a slow host only the newest batches
    // arrive; the rest are counted.
    const { lines, omittedLines } = record.output;
    assert(lines.length >= 10 && lines.length <= 400, String(lines.length));
    assert.equal(lines.length + omittedLines, 503);
    assert.deepEqual(lines.slice(-3), [
      "stdout: credential [env:CI_RUNNER_FIXTURE_CREDENTIAL]",
      "[redacted credential-bearing line]",
      "stdout: waiting for a reply that never comes",
    ]);
    const bulk = lines.slice(0, -3);
    assert.deepEqual(
      bulk.map((line) => line.match(/^stdout: bulk (\d+) v+\.\.\. \[truncated\]$/u)?.[1]),
      bulk.map((_, index) => String(500 - bulk.length + index)),
    );
  },
);

test("each job attempt uploads its own diagnostics report", async () => {
  // A passing rerun must not replace a failed attempt's report. This reads the
  // composite action; it is not a GitHub Actions execution.
  const action = await readFile(
    join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"),
    "utf8",
  );
  const upload = action.match(/- name: Upload cluster diagnostics\n[\s\S]*?\n {4}- /u)?.[0] ?? "";
  assert.match(
    upload,
    /\n\s+name: diagnostics-\$\{\{ inputs\.artifact-prefix \}\}-\$\{\{ inputs\.lane \}\}-attempt-\$\{\{ github\.run_attempt \}\}\n/u,
  );
});

waitingTest("run records a timeout that came before any test started", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state/stuck.json");
  await writeFile(
    join(root, "tests/integration/stuck.test.mjs"),
    'import test from "node:test";\nawait new Promise((resolve) => setTimeout(resolve, 30_000));\ntest("never registered", () => {});\n',
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { stuck: { files: [{ path: "tests/integration/stuck.test.mjs" }] } },
    groups: { ci: ["stuck"] },
  });

  const result = await runAsync(
    root,
    [
      "run",
      "stuck",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      statePath,
      "--results",
      join(root, "results/stuck.json"),
    ],
    { CI_RUNNER_TEST_TIMEOUT_MS: "2000" },
  );

  assert.equal(result.status, 1);
  const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
  assert.deepEqual(
    { ...record, capturedAt: undefined, elapsedMs: undefined },
    {
      file: "tests/integration/stuck.test.mjs",
      capturedAt: undefined,
      reason: "timeout",
      timeoutMs: 2000,
      elapsedMs: undefined,
      tests: [],
      omittedTests: 0,
      output: { lines: [], omittedLines: 0 },
    },
  );
  assert(record.elapsedMs >= 2000, String(record.elapsedMs));
});

// Finding 1209: a file hung in its teardown for 22 minutes, past the job's 25-minute timeout,
// under the 60-minute per-file timeout. GitHub cancelled the job, so the results file was never
// written and nothing named the test. The lane deadline stops the file first and names it.
waitingTest(
  "run stops a hung file at the lane deadline, names its test and starts nothing after it",
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/deadline.json");
    const resultsPath = join(root, "results/deadline.json");
    const marker = join(root, "state/later-started");
    const hung = join(root, "state/teardown-hung");
    await writeFile(
      join(root, "tests/integration/teardown.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs in its teardown", async (t) => {',
        "  // Like a worker stop that never returns; the interval keeps the file alive.",
        "  t.after(() => {",
        `    writeFileSync(${JSON.stringify(hung)}, "");`,
        "    return new Promise(() => setInterval(() => {}, 1_000));",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "tests/integration/later.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("would start past the deadline", () => writeFileSync(process.env.CI_RUNNER_MARKER, ""));',
        "",
      ].join("\n"),
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        deadline: {
          files: [
            { path: "tests/integration/teardown.test.mjs" },
            { path: "tests/integration/later.test.mjs" },
          ],
        },
      },
      groups: { ci: ["deadline"] },
    });

    // The runner's clock stops a second in until the file hangs in its teardown, so the deadline
    // comes at least two seconds after that, however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      [
        "run",
        "deadline",
        "--manifest",
        "manifest.json",
        "--root",
        root,
        "--state",
        statePath,
        "--results",
        resultsPath,
      ],
      // No per-file timeout: the default (60 minutes) is far past the deadline.
      {
        CI_RUNNER_TEST_TIMEOUT_MS: "",
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_MARKER: marker,
      },
      // Without the deadline the runner would wait out the 60-minute default.
      { timeout: 60_000, execArgv: heldClock(started + 1_000, [hung]) },
    );

    assert.equal(result.error, undefined, `the deadline stopped the lane: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [teardown, later] = summary.files;
    assert.equal(teardown.status, "failed");
    const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
    assert.equal(timeout.file, "tests/integration/teardown.test.mjs");
    assert.match(timeout.message, /cut to the lane deadline/);
    assert.match(timeout.message, /while running "hangs in its teardown"$/);
    // The job log names it too, not only the diagnostics artifact.
    assert.match(
      result.stderr,
      /run-tests: issue test-timeout tests\/integration\/teardown\.test\.mjs: .* while running "hangs in its teardown"\n/,
    );
    const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
    assert.equal(record.reason, "timeout");
    assert.equal(record.laneDeadline, true);
    assert(record.timeoutMs >= 2_000 && record.timeoutMs <= 3_000, String(record.timeoutMs));
    assert.deepEqual(record.interruptedTests, [{ name: "hangs in its teardown", line: 4 }]);
    // The serial file behind it never started.
    assert.equal(later.status, "failed");
    assert.equal(later.counts.total, 0);
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

waitingTest("run starts no file with under a second left before the lane deadline", async (t) => {
  // Finding 1215: a file whose turn came within a second of the deadline was started and
  // stopped at once, then reported as selected-zero and a test-timeout naming no test.
  const root = await fixture(t);
  const statePath = join(root, "state/near-deadline.json");
  const resultsPath = join(root, "results/near-deadline.json");
  const marker = join(root, "state/started");
  // The preparation returns half a second before the deadline.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      "export async function prepareFile() {",
      "  const left = Number(process.env.CI_RUNNER_DEADLINE_MS) - Date.now();",
      "  await new Promise((resolve) => setTimeout(resolve, left - 500));",
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/late.test.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      'writeFileSync(process.env.CI_RUNNER_MARKER, "");',
      'test("starts too late", () => new Promise((resolve) => setTimeout(resolve, 5_000)));',
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { near: { files: [{ path: "tests/integration/late.test.mjs" }] } },
    groups: { ci: ["near"] },
  });

  const result = await runAsync(
    root,
    laneArgs(root, "near", statePath, resultsPath),
    { CI_RUNNER_DEADLINE_MS: String(Date.now() + 5_000), CI_RUNNER_MARKER: marker },
    { timeout: 30_000 },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  const [late] = JSON.parse(await readFile(resultsPath, "utf8")).files;
  // A loaded host can run the preparation into the deadline instead; either way, nothing starts.
  const codes = late.issues.map((entry) => entry.code);
  assert.deepEqual(
    codes,
    codes.includes("prepare-timeout") ? ["prepare-timeout"] : ["lane-deadline"],
  );
  assert.equal(late.nodeExitCode, null);
  assert.equal(late.counts.total, 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

waitingTest("a runner timeout while no test was running says so", async (t) => {
  // Finding 1215: a file stopped in a hook or teardown named no test, which read like a
  // reporting gap rather than where it hung.
  const root = await fixture(t);
  const statePath = join(root, "state/hook.json");
  const resultsPath = join(root, "results/hook.json");
  const inHook = join(root, "state/in-hook");
  await writeFile(
    join(root, "tests/integration/hook.test.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'import test, { after } from "node:test";',
      'test("passes", () => {});',
      "after(() => {",
      `  writeFileSync(${JSON.stringify(inHook)}, "");`,
      "  // Ends by itself in case the runner leaves it behind.",
      "  return new Promise((resolve) => setTimeout(resolve, 30_000));",
      "});",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { hook: { files: [{ path: "tests/integration/hook.test.mjs" }] } },
    groups: { ci: ["hook"] },
  });

  // The runner's clock stands still from the start until "passes" is done and the hook has
  // started, so the timeout comes three seconds after that however long the host takes to get
  // there. The hook outlasts it.
  const started = Date.now();
  const result = await runAsync(
    root,
    laneArgs(root, "hook", statePath, resultsPath),
    { CI_RUNNER_TEST_TIMEOUT_MS: "3000" },
    { timeout: 60_000, execArgv: heldClock(started, [inHook]) },
  );

  assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
  assert.equal(
    timeout.message,
    "selected file exceeded the runner timeout (3000 ms): tests/integration/hook.test.mjs; no test was running (stopped in a hook, teardown or top-level code)",
  );
});

// Finding 1210: the lane deadline stopped only the test process. A preparation or cleanup that
// never returned (it runs in the runner itself) still ran on to the job timeout with no results.
// These fixtures hang forever, and their intervals keep the runner alive unless it gives up.
const hangForever = "new Promise(() => setInterval(() => {}, 1_000))";

function laneArgs(root, lane, statePath, resultsPath) {
  return [
    "run",
    lane,
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    statePath,
    "--results",
    resultsPath,
  ];
}

waitingTest(
  "run gives up on a preparation still running at the lane deadline and names it",
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/hung-prepare.json");
    const resultsPath = join(root, "results/hung-prepare.json");
    const preparing = join(root, "state/preparing");
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        `    writeFileSync(${JSON.stringify(preparing)}, "");`,
        `    await ${hangForever};`,
        "  }",
        "  return {};",
        "}",
        "",
      ].join("\n"),
    );
    for (const name of ["hung", "later"]) {
      await writeFile(
        join(root, `tests/integration/${name}.test.mjs`),
        'import test from "node:test";\ntest("runs", () => {});\n',
      );
    }
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        prepare: {
          files: [
            { path: "tests/integration/hung.test.mjs" },
            { path: "tests/integration/later.test.mjs" },
          ],
        },
      },
      groups: { ci: ["prepare"] },
    });

    // The runner's clock stands still from the start until the preparation has started, so the
    // deadline comes three seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "prepare", statePath, resultsPath),
      { CI_RUNNER_DEADLINE_MS: String(started + 3_000) },
      // Without a limit the preparation would hold the runner forever.
      { timeout: 60_000, execArgv: heldClock(started, [preparing]) },
    );

    assert.equal(
      result.error,
      undefined,
      `the runner gave up on the preparation: ${result.stderr}`,
    );
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    assert.deepEqual(
      hung.issues.map(({ code, file, step }) => ({ code, file, step })),
      [{ code: "prepare-timeout", file: "tests/integration/hung.test.mjs", step: "prepare" }],
    );
    // Its limit is what was left before the deadline when it started: all of it, as the clock
    // stood still.
    assert.equal(hung.issues[0].timeoutMs, 3_000);
    // Its tests never started. What the preparation made is left to the job's Cleanup lane step.
    assert.equal(hung.nodeExitCode, null);
    assert.equal(hung.counts.total, 0);
    assert.equal(hung.cleanup, null);
    // The file behind it starts nothing past the deadline.
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    assert.match(
      result.stderr,
      /run-tests: issue prepare-timeout tests\/integration\/hung\.test\.mjs: prepareFile did not finish within \d+ ms, cut to the lane deadline/,
    );
  },
);

waitingTest(
  "run gives up on a hung cleanup after its allowance, ends its commands and starts no later file",
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/hung-cleanup.json");
    const resultsPath = join(root, "results/hung-cleanup.json");
    const cleaned = join(root, "state/later-cleaned");
    // The hung cleanup waits for a command that started one of its own (as `docker compose`
    // or `pnpm` would). Both record their pids, in one rename.
    const pidsPath = join(root, "state/command-pids");
    // The command starts another child while the runner is ending it: after the runner has listed
    // its processes and before it kills them (killWindow). That child records its pid too.
    const windowPath = join(root, "state/kill-window");
    const latePath = join(root, "state/late-pid");
    const commandPath = join(root, "command.cjs");
    const writeOnce = (path, value) =>
      `writeFileSync(${JSON.stringify(`${path}.partial`)}, ${value}); ` +
      `renameSync(${JSON.stringify(`${path}.partial`)}, ${JSON.stringify(path)});`;
    await writeFile(
      commandPath,
      [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, renameSync, writeFileSync } = require("node:fs");',
        'const forever = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {',
        '  stdio: "ignore",',
        "});",
        "const descendant = forever();",
        writeOnce(pidsPath, 'process.pid + "\\n" + descendant.pid + "\\n"'),
        "const poll = setInterval(() => {",
        `  if (existsSync(${JSON.stringify(windowPath)})) {`,
        "    clearInterval(poll);",
        `    ${writeOnce(latePath, 'forever().pid + "\\n"')}`,
        "  }",
        "}, 10);",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );
    const running = (pid) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A zombie (state Z) still answers kill(pid, 0), but it has exited.
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat[stat.lastIndexOf(")") + 2] !== "Z";
      } catch {
        return true;
      }
    };
    const pids = [];
    t.after(() => {
      for (const pid of pids.filter(running)) {
        process.kill(pid, "SIGKILL");
      }
    });
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFile, writeFile } from "node:fs/promises";',
        'import { setTimeout as delay } from "node:timers/promises";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        "    return {",
        "      cleanup: async () => {",
        `        spawn(process.execPath, [${JSON.stringify(commandPath)}], { stdio: "ignore" });`,
        // Hang only once both pids are on record.
        `        while (!(await readFile(${JSON.stringify(pidsPath)}, "utf8").catch(() => ""))) {`,
        "          await delay(20);",
        "        }",
        `        return ${hangForever};`,
        "      },",
        "    };",
        "  }",
        '  return { cleanup: () => writeFile(process.env.CI_RUNNER_CLEANUP_MARKER, "") };',
        "}",
        "",
      ].join("\n"),
    );
    for (const name of ["hung", "later"]) {
      await writeFile(
        join(root, `tests/integration/${name}.test.mjs`),
        'import test from "node:test";\ntest("runs", () => {});\n',
      );
    }
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        cleanup: {
          files: [
            { path: "tests/integration/hung.test.mjs" },
            { path: "tests/integration/later.test.mjs" },
          ],
        },
      },
      groups: { ci: ["cleanup"] },
    });

    // The runner's clock stands still from the start until the command and its descendant are on
    // record, so the cleanup's allowance ends two seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "cleanup", statePath, resultsPath),
      { CI_RUNNER_CLEANUP_TIMEOUT_MS: "2000", CI_RUNNER_CLEANUP_MARKER: cleaned },
      {
        timeout: 60_000,
        execArgv: [...heldClock(started, [pidsPath]), ...killWindow(windowPath, latePath)],
      },
    );
    pids.push(...(await readFile(pidsPath, "utf8")).split("\n").filter(Boolean).map(Number));
    const late = Number(await readFile(latePath, "utf8").catch(() => ""));
    if (late > 1) {
      pids.push(late);
    }

    assert.equal(result.error, undefined, `the runner gave up on the cleanup: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    // Its tests passed; only the cleanup failed it.
    assert.equal(hung.counts.passed, 1);
    assert.equal(hung.status, "failed");
    assert.deepEqual(hung.cleanup, { status: "timeout", timeoutMs: 2000 });
    assert.deepEqual(
      hung.issues.map(({ code, step, message }) => ({ code, step, message })),
      [
        {
          code: "cleanup-timeout",
          step: "cleanup",
          message: "cleanup did not finish within 2000 ms: tests/integration/hung.test.mjs",
        },
      ],
    );
    // The abandoned cleanup may still hold the CI state lock, so the next file never starts.
    assert.deepEqual(
      later.issues.map(({ code, file }) => ({ code, file })),
      [{ code: "setup-abandoned", file: "tests/integration/later.test.mjs" }],
    );
    assert.equal(later.counts.total, 0);
    await assert.rejects(readFile(cleaned), { code: "ENOENT" });
    // The runner ended the abandoned cleanup's command and its descendants before it exited, so
    // none is left running as an orphan (finding 1225), not even the one the command started
    // after the runner had listed its processes (finding 2182).
    assert.equal(pids.length, 3, "the command recorded itself and both descendants");
    for (let attempt = 0; pids.some(running) && attempt < 50; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.deepEqual(
      pids.filter(running),
      [],
      "the abandoned cleanup's commands outlived the runner",
    );
  },
);

waitingTest(
  "run ends the cleanups of files the deadline stopped together one allowance past it",
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/hung-cleanups.json");
    const resultsPath = join(root, "results/hung-cleanups.json");
    const files = ["one", "two", "three", "four"].map(
      (name) => `tests/integration/${name}.test.mjs`,
    );
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      `export async function prepareFile() {\n  return { cleanup: () => ${hangForever} };\n}\n`,
    );
    const hung = files.map((file) => join(root, `state/${file.split("/").at(-1)}-hung`));
    for (const [index, file] of files.entries()) {
      await writeFile(
        join(root, file),
        [
          'import { writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs", () => {',
          `  writeFileSync(${JSON.stringify(hung[index])}, "");`,
          `  return ${hangForever};`,
          "});",
          "",
        ].join("\n"),
      );
    }
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        together: {
          fileConcurrency: 4,
          parallelFiles: files,
          files: files.map((path) => ({ path })),
        },
      },
      groups: { ci: ["together"] },
    });

    // The runner's clock stops a second in until all four files hang, so the deadline stops
    // them together however long the host takes to start them.
    const allowanceMs = 5_000;
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "together", statePath, resultsPath),
      {
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_CLEANUP_TIMEOUT_MS: String(allowanceMs),
        CI_RUNNER_FILE_CONCURRENCY: "4",
      },
      { timeout: 60_000, execArgv: heldClock(started + 1_000, hung) },
    );

    assert.equal(result.error, undefined, `the runner gave up on the cleanups: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.deepEqual(
      summary.files.map((file) => [file.path, file.cleanup?.status]),
      files.map((file) => [file, "timeout"]),
    );
    // Cleanups run one at a time. One allowance each would end 20 s past the deadline; the window
    // they share closes one allowance past it. The first to start gets what is left of the window
    // and is still running when it closes, so the queued ones never start. (On a busy host the
    // window can close before the first one starts too.)
    const timeouts = summary.issues.filter((entry) => entry.code === "cleanup-timeout");
    assert.equal(timeouts.length, files.length);
    const ran = timeouts.filter(
      (entry) => !/window after the lane deadline closed/.test(entry.message),
    );
    assert(ran.length <= 1, JSON.stringify(timeouts));
    // It starts after its file stops, past the deadline, so it gets less than a full allowance.
    for (const entry of ran) {
      assert(entry.timeoutMs < allowanceMs, JSON.stringify(entry));
    }
  },
);

test("run records a preparation failure's redacted message in the diagnostics report", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/prepare.json");
  const statePath = join(root, "state/prepare.json");
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export async function prepareFile({ file, statePath }) {",
      "  if (file.path.endsWith('broken.test.mjs')) {",
      "    // The lane state's env holds prepared values the job env never had.",
      "    await writeFile(statePath, JSON.stringify({ env: { OCC_TEST_STATE_IMAGE: 'stateonlyopaque-image-ref' } }));",
      `    const pullUrl = ${JSON.stringify(syntheticCredentialUrl({ username: "user", password: "hunter2pass", host: "registry.example", pathname: "/x" }))};`,
      "    const error = new Error(",
      "      `image import failed for ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL} stateonlyopaque-image-ref\\nAuthorization: Bearer abcdefghijklmnop0123\\npull ${pullUrl}`,",
      "    );",
      "    error.stderr = 'child output secretauthvalue-stderr';",
      "    throw error;",
      "  }",
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );
  for (const name of ["broken", "fine"]) {
    await writeFile(
      join(root, `tests/integration/${name}.test.mjs`),
      'import test from "node:test";\ntest("runs", () => {});\n',
    );
  }
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      prepare: {
        files: [
          { path: "tests/integration/broken.test.mjs" },
          { path: "tests/integration/fine.test.mjs" },
        ],
      },
    },
    groups: { ci: ["prepare"] },
  });

  const result = run(root, [
    "run",
    "prepare",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    statePath,
    "--results",
    resultsPath,
  ]);

  assert.equal(result.status, 1);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  // Results keep the closed contract.
  const prepareIssue = summary.issues.find((entry) => entry.code === "prepare-failed");
  assert.deepEqual(prepareIssue.error, { name: "Error" });
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123|hunter2pass|stateonlyopaque/);
  const report = JSON.parse(text);
  assert.equal(report.failures.length, 1);
  const [record] = report.failures;
  assert.equal(record.file, "tests/integration/broken.test.mjs");
  assert.equal(record.reason, "prepare");
  assert.equal(record.error.name, "Error");
  assert.equal(
    record.error.message,
    "image import failed for [env:CI_RUNNER_FIXTURE_CREDENTIAL] [env:OCC_TEST_STATE_IMAGE]\n[redacted credential-bearing line]\n[redacted credential-bearing line]",
  );
  assert.match(record.error.stack, /^at prepareFile \(.*scripts\/ci\/prepare\.mjs:7:\d+\)/);
});

test("run keeps bounded Agent namespace activity from passing k3d files, alone and side by side", async (t) => {
  const root = await fixture(t);
  const clusterDirectory = join(root, "cluster");
  await mkdir(clusterDirectory);
  const statePath = join(root, "state/k3d.json");
  const resultsPath = join(root, "results/k3d.json");
  await writeJson(statePath, {
    lane: "k3d-lane",
    resources: [
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "owned-cluster",
        directory: clusterDirectory,
        kubeconfig: join(clusterDirectory, "kubeconfig"),
        context: "k3d-owned-cluster",
      },
    ],
  });
  // This kubectl stand-in serves the raw watch streams a live API server would
  // send while the test file creates and deletes its Agent namespace.
  const kubectl = join(root, "kubectl");
  const pod = (ready, type) => ({
    type,
    object: {
      kind: "Pod",
      metadata: {
        namespace: "occ-agent-a",
        name: "harness-0",
        creationTimestamp: "2026-09-29T00:00:00Z",
      },
      spec: {
        nodeName: "server-0",
        containers: [{ name: "harness", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: ready ? "True" : "False", lastTransitionTime: "t" }],
        containerStatuses: [{ name: "harness", ready, restartCount: 0 }],
      },
    },
  });
  const event = (namespace, uid, reason, message, count = 1) => ({
    type: "ADDED",
    object: {
      metadata: { namespace, name: `${uid}.event`, uid },
      involvedObject: { kind: "Pod", name: "harness-0", namespace },
      type: "Normal",
      reason,
      message,
      count,
      firstTimestamp: "2026-09-29T00:00:01Z",
      lastTimestamp: `2026-09-29T00:10:0${count}Z`,
    },
  });
  const pods = [
    pod(false, "ADDED"),
    pod(false, "MODIFIED"),
    pod(true, "MODIFIED"),
    pod(true, "DELETED"),
  ];
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-09-29T00:00:10",
    laterCount: 196,
  });
  const repeatedSeries = {
    metadata: {
      namespace: "occ-agent-a",
      name: "repeated-series.event",
      uid: "repeated-series",
    },
    involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    eventTime: "2026-09-29T00:00:01Z",
    series: { count: 7, lastObservedTime: "2026-09-29T00:20:00Z" },
  };
  const events = [
    { type: "ADDED", object: repeatedSeries },
    ...boundary.events.map((object) => ({ type: "ADDED", object })),
    event("occ-agent-a", "e1", "Pulled", "Successfully pulled image"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed", 3),
    event("occ-agent-a", "e3", "Failed", "bearer do-not-publish-event"),
    event("kube-system", "e4", "Started", "unrelated system event"),
  ];
  await writeFile(
    kubectl,
    [
      `#!${process.execPath}`,
      "const query = process.argv.at(-1);",
      `const lines = query.startsWith("/api/v1/pods?") ? ${JSON.stringify(pods)} : ${JSON.stringify(events)};`,
      "for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');",
      'process.stdout.write(\'{"type":"MODIFIED","object":\');',
      // A live watch runs until stopped; a stranded one exits on its own after a minute.
      "setTimeout(() => {}, 60_000);",
      "",
    ].join("\n"),
  );
  await chmod(kubectl, 0o755);
  const captureBarrierDirectory = join(root, "state");
  const watchAwareTest = ({ name, id }) =>
    [
      'import { readdir, readFile, writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      `const clusterDirectory = ${JSON.stringify(clusterDirectory)};`,
      `const captureBarrierDirectory = ${JSON.stringify(captureBarrierDirectory)};`,
      "const expectedCaptures = Number(process.env.CI_RUNNER_TEST_EXPECTED_CAPTURES ?? 1);",
      'const barrier = process.env.CI_RUNNER_TEST_CAPTURE_BARRIER ?? "single";',
      "const markerPrefix = `capture-ready-${barrier}-`;",
      `test(${JSON.stringify(name)}, async () => {`,
      "  if (!process.env.OPENCLAW_CI_CONTAINER_LOG_DIR) return;",
      "  let watchReady = false;",
      "  for (let attempt = 0; attempt < 200; attempt += 1) {",
      "    const names = await readdir(clusterDirectory);",
      "    const streams = await Promise.all(",
      '      names.filter((entry) => entry.startsWith("agent-activity-")).map(async (entry) => ({',
      "        name: entry,",
      '        lines: (await readFile(join(clusterDirectory, entry), "utf8").catch((error) =>',
      '          error?.code === "ENOENT" ? "" : Promise.reject(error),',
      '        )).split("\\n").filter(Boolean).length,',
      "      })),",
      "    );",
      '    const podStreams = streams.filter(({ name: entry }) => entry.endsWith("-pods.ndjson"));',
      '    const eventStreams = streams.filter(({ name: entry }) => entry.endsWith("-events.ndjson"));',
      `    const podsReady = podStreams.length > 0 && podStreams.every(({ lines }) => lines >= ${pods.length});`,
      `    const eventsReady = eventStreams.length > 0 && eventStreams.every(({ lines }) => lines >= ${events.length});`,
      "    if (podStreams.length === expectedCaptures && eventStreams.length === expectedCaptures && podsReady && eventsReady) {",
      "      watchReady = true;",
      "      break;",
      "    }",
      "    await delay(10);",
      "  }",
      '  if (!watchReady) throw new Error("timed out waiting for Agent namespace watch output");',
      `  await writeFile(join(captureBarrierDirectory, \`\${markerPrefix}${id}\`), "ready");`,
      "  for (let attempt = 0; attempt < 200; attempt += 1) {",
      "    const acknowledgements = (await readdir(captureBarrierDirectory)).filter((entry) => entry.startsWith(markerPrefix));",
      "    if (acknowledgements.length === expectedCaptures) return;",
      "    await delay(10);",
      "  }",
      '  throw new Error("timed out waiting for concurrent capture acknowledgements");',
      "});",
      "",
    ].join("\n");
  await writeFile(
    join(root, "tests/integration/agent.test.mjs"),
    watchAwareTest({ name: "agent file passes", id: "agent" }),
  );
  await writeJson(join(root, "scripts/ci/k3d-lane.json"), {
    files: [{ path: "tests/integration/agent.test.mjs", expectedTests: ["agent file passes"] }],
  });
  await writeJson(join(root, "scripts/ci/suites.json"), {
    version: 1,
    lanes: { "k3d-lane": "./k3d-lane.json" },
    groups: {},
  });

  const result = run(
    root,
    [
      "run",
      "k3d-lane",
      "--manifest",
      join(root, "scripts/ci/suites.json"),
      "--root",
      root,
      "--state",
      statePath,
      "--results",
      resultsPath,
    ],
    {
      OCC_KUBECTL_BIN: kubectl,
      CI_RUNNER_TEST_CAPTURE_BARRIER: "single",
      CI_RUNNER_TEST_EXPECTED_CAPTURES: "1",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(resultsPath, "utf8")).status, "passed");
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const report = JSON.parse(text);
  assert.equal(report.lane, "k3d-lane");
  assert.equal(report.agentNamespaces.length, 1);
  const [activity] = report.agentNamespaces;
  assert.equal(activity.file, "tests/integration/agent.test.mjs");
  assert.equal(activity.cluster, "owned-cluster");
  assert.deepEqual(activity.namespaces, ["occ-agent-a"]);
  // Unchanged watch records collapse; readiness and deletion transitions remain.
  assert.deepEqual(
    activity.pods.map(({ watch, containers }) => [watch, containers[0].ready]),
    [
      ["ADDED", false],
      ["MODIFIED", true],
      ["DELETED", true],
    ],
  );
  assert.equal(activity.events.length, 200);
  assert.equal(activity.events[0].reason, boundary.events[2].reason);
  assert.equal(
    activity.events.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.equal(
    activity.events.some(({ reason }) => reason === boundary.newer.reason),
    false,
  );
  assert.equal(activity.omitted.events, 2);
  assert.deepEqual(
    activity.events.slice(-4).map(({ reason, count }) => [reason, count]),
    [
      ["Pulled", 1],
      ["Failed", 1],
      ["Unhealthy", 3],
      ["RepeatedSeries", 7],
    ],
  );
  assert.equal(activity.events.at(-1).lastTimestamp, repeatedSeries.series.lastObservedTime);
  assert.doesNotMatch(text, /do-not-publish|unrelated system event/);
  // Raw watch streams hold full Pod specs; only the projection survives.
  assert.deepEqual(await readdir(clusterDirectory), []);

  // Two files sharing the runner under fileConcurrency watch the same cluster at once. Each
  // keeps its own watch streams, so neither truncates nor deletes the other's capture.
  await writeFile(
    join(root, "tests/integration/agent-sibling.test.mjs"),
    watchAwareTest({ name: "sibling file passes", id: "sibling" }),
  );
  const pairFiles = [
    "tests/integration/agent.test.mjs",
    "tests/integration/agent-sibling.test.mjs",
  ];
  await writeJson(join(root, "scripts/ci/pair-suites.json"), {
    version: 1,
    lanes: {
      "k3d-pair": {
        fileConcurrency: 2,
        parallelFiles: pairFiles,
        files: [
          { path: pairFiles[0], expectedTests: ["agent file passes"] },
          { path: pairFiles[1], expectedTests: ["sibling file passes"] },
        ],
      },
    },
    groups: {},
  });
  const pairStatePath = join(root, "state/k3d-pair.json");
  await writeJson(pairStatePath, {
    lane: "k3d-pair",
    resources: JSON.parse(await readFile(statePath, "utf8")).resources,
  });
  const pairResultsPath = join(root, "results/k3d-pair.json");
  const pair = run(
    root,
    [
      "run",
      "k3d-pair",
      "--manifest",
      join(root, "scripts/ci/pair-suites.json"),
      "--root",
      root,
      "--state",
      pairStatePath,
      "--results",
      pairResultsPath,
    ],
    {
      OCC_KUBECTL_BIN: kubectl,
      CI_RUNNER_FILE_CONCURRENCY: "2",
      CI_RUNNER_TEST_CAPTURE_BARRIER: "pair",
      CI_RUNNER_TEST_EXPECTED_CAPTURES: "2",
    },
  );
  assert.equal(pair.status, 0, pair.stderr);
  const pairSummary = JSON.parse(await readFile(pairResultsPath, "utf8"));
  assert.deepEqual(
    pairSummary.files.map(({ mode }) => mode),
    ["parallel", "parallel"],
  );
  const pairReport = JSON.parse(await readFile(`${pairStatePath}.diagnostics.json`, "utf8"));
  assert.deepEqual(
    // Files finish in either order; each appends its own record.
    pairReport.agentNamespaces
      .map(({ file, namespaces, pods }) => [file, namespaces, pods.length])
      .sort(([left], [right]) => left.localeCompare(right)),
    pairFiles
      .map((file) => [file, ["occ-agent-a"], 3])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(await readdir(clusterDirectory), []);

  // A second cluster whose directory is gone fails the capture after the first cluster's
  // watches started. The file still runs, and those watches are stopped: left running,
  // their child processes would hold the runner until the watch timeout.
  const brokenStatePath = join(root, "state/k3d-broken.json");
  await writeJson(brokenStatePath, {
    lane: "k3d-lane",
    resources: [
      ...JSON.parse(await readFile(statePath, "utf8")).resources,
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "removed-cluster",
        directory: join(root, "removed-cluster"),
        kubeconfig: join(root, "removed-cluster/kubeconfig"),
        context: "k3d-removed-cluster",
      },
    ],
  });
  const broken = spawnSync(
    process.execPath,
    [
      runnerPath,
      "run",
      "k3d-lane",
      "--manifest",
      join(root, "scripts/ci/suites.json"),
      "--root",
      root,
      "--state",
      brokenStatePath,
      "--results",
      join(root, "results/k3d-broken.json"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fixtureGitEnv,
        GITHUB_SHA: currentSha(),
        OCC_KUBECTL_BIN: kubectl,
      },
      timeout: 30_000,
    },
  );
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(
    broken.stderr,
    /Agent namespace activity unavailable for tests\/integration\/agent\.test\.mjs/,
  );
  assert.deepEqual(await readdir(clusterDirectory), []);
});

test("k3d diagnostics preserve equal-instant event order across precision variants", async () => {
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.mjs");
  const { older, newer } = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-10-21T00:00:00",
    laterCount: 0,
  });
  const projected = projectContainerLog({
    lines: [],
    snapshots: [
      {
        events: [
          older,
          {
            ...older,
            metadata: { ...older.metadata, uid: "equal-fractional" },
            reason: "EqualFractional",
            eventTime: "2026-10-21T00:00:00.000000Z",
            lastTimestamp: undefined,
          },
          newer,
        ],
      },
      {
        events: [
          {
            metadata: { namespace: "occ-agent-a", uid: "repeated-series" },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Warning",
            reason: "RepeatedSeries",
            message: "Repeated event",
            eventTime: "2026-10-21T00:00:01Z",
            series: { count: 7, lastObservedTime: "2026-10-21T00:10:00Z" },
          },
          ...Array.from({ length: 200 }, (_, index) => ({
            metadata: { namespace: "occ-agent-a", uid: `intervening-${index}` },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Normal",
            reason: `Intervening${index}`,
            message: "Intervening event",
            count: 1,
            eventTime: new Date(
              Date.parse("2026-10-21T00:00:01Z") + (index + 1) * 1_000,
            ).toISOString(),
          })),
        ],
      },
    ],
  });
  assert.deepEqual(
    projected.snapshots[0].events.map(({ reason }) => reason),
    [older.reason, "EqualFractional", newer.reason],
  );
  assert.deepEqual(projected.snapshots[1].events.at(-1), {
    namespace: "occ-agent-a",
    kind: "Pod",
    name: "harness-0",
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    count: 7,
    firstTimestamp: "2026-10-21T00:00:01Z",
    lastTimestamp: "2026-10-21T00:10:00Z",
  });
});

test("audit fails when a referenced lane cannot be loaded", async (t) => {
  const root = await fixture(t);
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { missing: "./missing-lane.json" },
    groups: { ci: ["missing"] },
  });

  const missing = run(root, ["audit", "--manifest", "manifest.json", "--root", root]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT.*missing-lane\.json/);
  assert.equal(missing.stdout, "");
});

test("audit rejects obsolete manifest selectors", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/pattern.test.mjs"), "import 'node:test';\n");
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      obsolete: {
        files: [
          {
            path: "tests/integration/pattern.test.mjs",
            namePattern: "^selected case$",
            allowedSkips: ["skipped case"],
          },
        ],
      },
    },
    groups: {
      ci: ["obsolete"],
    },
  });

  const result = run(root, ["audit", "--manifest", "manifest.json", "--root", root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.issues.map((entry) => entry.message).sort(), [
    "lanes.obsolete.files.0.allowedSkips is no longer supported",
    "lanes.obsolete.files.0.namePattern is no longer supported",
  ]);
});

test("audit rejects invalid file concurrency marks", async (t) => {
  const root = await fixture(t);
  for (const name of ["one", "two"]) {
    await writeFile(join(root, `tests/integration/${name}.test.mjs`), "import 'node:test';\n");
  }
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      marks: {
        fileConcurrency: 0,
        parallelFiles: [
          "tests/integration/one.test.mjs",
          "tests/integration/one.test.mjs",
          "tests/integration/two.test.mjs",
          "tests/integration/other.test.mjs",
        ],
        serialFiles: {
          "tests/integration/two.test.mjs": "shared port",
          "tests/integration/one.test.mjs": " ",
          "tests/integration/gone.test.mjs": "moved",
        },
        files: [
          { path: "tests/integration/one.test.mjs" },
          { path: "tests/integration/two.test.mjs" },
        ],
      },
    },
    groups: { ci: ["marks"] },
  });

  const result = run(root, ["audit", "--manifest", "manifest.json", "--root", root]);
  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout)
      .issues.map((entry) => entry.message)
      .sort(),
    [
      "lanes.marks.fileConcurrency must be an integer from 1 to 32",
      "lanes.marks.parallelFiles lists tests/integration/one.test.mjs twice",
      "lanes.marks.parallelFiles tests/integration/one.test.mjs is also serial",
      "lanes.marks.parallelFiles tests/integration/other.test.mjs is not a lane file",
      "lanes.marks.parallelFiles tests/integration/two.test.mjs is also serial",
      "lanes.marks.serialFiles.tests/integration/gone.test.mjs is not a lane file",
      "lanes.marks.serialFiles.tests/integration/one.test.mjs must name a reason",
    ],
  );
});

// Each fixture file holds a marker in `running/` while it runs. A parallel file waits
// for its partner's marker, so it passes only if both share slots; a file that must
// run alone fails if any other marker exists. Neither depends on timing.
function concurrencyProbe(name, partner) {
  return [
    'import assert from "node:assert/strict";',
    'import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";',
    'import { setTimeout as sleep } from "node:timers/promises";',
    'import test from "node:test";',
    "const running = process.env.CI_RUNNER_PROBE_DIR;",
    `test(${JSON.stringify(`${name} probe`)}, async () => {`,
    `  writeFileSync(running + "/${name}", "");`,
    "  try {",
    partner
      ? [
          '    const deadline = Date.now() + Number(process.env.CI_RUNNER_PROBE_WAIT_MS ?? "20000");',
          `    while (!existsSync(running + "/${partner}")) {`,
          `      assert.ok(Date.now() < deadline, "${partner} never ran beside ${name}");`,
          "      await sleep(10);",
          "    }",
        ].join("\n")
      : `    assert.deepEqual(readdirSync(running), ["${name}"]);`,
    "    await sleep(50);",
    "  } finally {",
    `    rmSync(running + "/${name}", { force: true });`,
    "  }",
    "});",
    "",
  ].join("\n");
}

test("run shares slots only between audited parallel files and runs the rest alone", async (t) => {
  const root = await fixture(t);
  const running = join(root, "running");
  await mkdir(running);
  const probes = {
    unmarked: null,
    left: "right",
    serial: null,
    right: "left",
  };
  for (const [name, partner] of Object.entries(probes)) {
    await writeFile(
      join(root, `tests/integration/${name}.test.mjs`),
      concurrencyProbe(name, partner),
    );
  }
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      shared: {
        fileConcurrency: 4,
        parallelFiles: ["tests/integration/right.test.mjs", "tests/integration/left.test.mjs"],
        serialFiles: { "tests/integration/serial.test.mjs": "writes a fixed path" },
        files: [
          { path: "tests/integration/unmarked.test.mjs" },
          { path: "tests/integration/left.test.mjs" },
          { path: "tests/integration/serial.test.mjs" },
          { path: "tests/integration/right.test.mjs" },
        ],
      },
    },
    groups: { ci: ["shared"] },
  });
  const args = (name) => [
    "run",
    "shared",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    `state/${name}.jsonl`,
    "--results",
    `results/${name}.json`,
  ];
  const env = { CI_RUNNER_PROBE_DIR: running, CI_RUNNER_FILE_CONCURRENCY: "2" };

  const result = run(root, args("shared"), env);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(root, "results/shared.json"), "utf8"));
  assert.equal(summary.fileConcurrency, 2);
  assert.equal(summary.counts.passed, 4);
  // Results keep manifest order; serial files ran first, before the shared slots.
  assert.deepEqual(
    summary.files.map((file) => [file.path.split("/").at(-1), file.mode]),
    [
      ["unmarked.test.mjs", "serial"],
      ["left.test.mjs", "parallel"],
      ["serial.test.mjs", "serial"],
      ["right.test.mjs", "parallel"],
    ],
  );
  const [unmarked, left, serial, right] = summary.files;
  assert.ok(unmarked.startOffsetMs < serial.startOffsetMs);
  assert.ok(serial.startOffsetMs + serial.wallDurationMs <= left.startOffsetMs);
  assert.ok(serial.startOffsetMs + serial.wallDurationMs <= right.startOffsetMs);
  // Shared slots start in parallelFiles order.
  assert.ok(right.startOffsetMs <= left.startOffsetMs);
  assert.match(
    result.stderr,
    /^run-tests: passed tests\/integration\/left\.test\.mjs \d+\.\ds \(parallel\)$/m,
  );

  // One slot runs every file alone; the partners then cannot meet, and the
  // result says so instead of passing.
  const alone = run(root, args("alone"), {
    ...env,
    CI_RUNNER_FILE_CONCURRENCY: "1",
    CI_RUNNER_PROBE_WAIT_MS: "300",
  });
  assert.equal(alone.status, 1);
  const aloneSummary = JSON.parse(await readFile(join(root, "results/alone.json"), "utf8"));
  assert.equal(aloneSummary.fileConcurrency, 1);
  assert.deepEqual(
    aloneSummary.files.map((file) => [file.mode, file.status]),
    [
      ["serial", "passed"],
      ["serial", "failed"],
      ["serial", "passed"],
      ["serial", "failed"],
    ],
  );

  const invalid = run(root, args("invalid"), { ...env, CI_RUNNER_FILE_CONCURRENCY: "many" });
  assert.equal(invalid.status, 1);
  const invalidSummary = JSON.parse(await readFile(join(root, "results/invalid.json"), "utf8"));
  assert.deepEqual(invalidSummary.files, []);
  assert.deepEqual(
    invalidSummary.issues.map((entry) => entry.code),
    ["invalid-env"],
  );
});

test("run starts shared files longest first from the measured table, unmeasured first", async (t) => {
  const root = await fixture(t);
  const files = ["short", "long", "new", "middle"].map(
    (name) => `tests/integration/${name}.test.mjs`,
  );
  for (const path of files) {
    await writeFile(join(root, path), 'import test from "node:test";\ntest("case", () => {});\n');
  }
  // Rows for files outside the lane are ignored.
  await writeJson(join(root, "durations.json"), {
    version: 1,
    files: {
      "tests/integration/short.test.mjs": 10,
      "tests/integration/long.test.mjs": 50_000,
      "tests/integration/middle.test.mjs": 20,
      "tests/integration/gone.test.mjs": 90_000,
    },
  });
  const manifest = (fileDurations) => ({
    version: 1,
    ...(fileDurations === undefined ? {} : { fileDurations }),
    lanes: {
      shared: { fileConcurrency: 2, parallelFiles: files, files: files.map((path) => ({ path })) },
    },
    groups: { ci: ["shared"] },
  });
  const starts = async (name, fileDurations) => {
    await writeJson(join(root, `${name}.json`), manifest(fileDurations));
    const result = run(
      root,
      ["run", "shared", "--manifest", `${name}.json`, "--root", root].concat([
        "--state",
        `state/${name}.jsonl`,
        "--results",
        `results/${name}.json`,
      ]),
      { CI_RUNNER_FILE_CONCURRENCY: "2" },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(root, `results/${name}.json`), "utf8"));
    return {
      stderr: result.stderr,
      ...Object.fromEntries(
        summary.files.map((file) => [
          file.path.split("/").at(-1).replace(".test.mjs", ""),
          file.startOffsetMs,
        ]),
      ),
    };
  };

  // Two slots: the unmeasured and the longest file start together; the next freed slot
  // takes the middle file, the last one the shortest.
  const measured = await starts("measured", "./durations.json");
  assert.ok(measured.new < measured.middle && measured.long < measured.middle);
  assert.ok(measured.middle <= measured.short);
  assert.match(measured.stderr, /longest first \(3 of 4 shared files measured\)/);

  // Without a table, shared files start in parallelFiles order.
  const listed = await starts("listed");
  assert.ok(listed.short < listed.new && listed.long < listed.new);
  assert.ok(listed.new <= listed.middle);
  assert.doesNotMatch(listed.stderr, /longest first/);
});

test("audit rejects an unusable file duration table", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/one.test.mjs"), "import 'node:test';\n");
  await writeJson(join(root, "durations.json"), {
    version: 1,
    files: { "tests/integration/one.test.mjs": -1, "tests/integration/two.test.mjs": 1.5 },
  });
  const audit = async (fileDurations) => {
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      fileDurations,
      lanes: { one: { files: [{ path: "tests/integration/one.test.mjs" }] } },
      groups: { ci: ["one"] },
    });
    const result = run(root, ["audit", "--manifest", "manifest.json", "--root", root]);
    assert.equal(result.status, 1, result.stdout);
    return JSON.parse(result.stdout).issues.map((entry) => entry.message);
  };

  assert.deepEqual(await audit("./durations.json"), [
    "fileDurations tests/integration/one.test.mjs must be a whole number of milliseconds",
    "fileDurations tests/integration/two.test.mjs must be a whole number of milliseconds",
  ]);
  assert.deepEqual(await audit("./missing.json"), [
    "fileDurations ./missing.json is not readable JSON",
  ]);
  for (const reference of ["../durations.json", "./../durations.json", "durations.json", 5]) {
    assert.deepEqual(await audit(reference), ["fileDurations must be a ./relative .json path"]);
  }
  await writeJson(join(root, "durations.json"), { version: 2, files: {} });
  assert.deepEqual(await audit("./durations.json"), [
    "fileDurations ./durations.json must be version 1 with a files object",
  ]);
});

test("audit requires current discovered test files and rejects duplicate ownership", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/mapped.test.mjs"), "import 'node:test';\n");
  await writeFile(join(root, "tests/integration/unmapped.test.ts"), "import 'node:test';\n");
  await mkdir(join(root, "tests/docs"), { recursive: true });
  await writeFile(join(root, "tests/docs/unmapped.test.mjs"), "import 'node:test';\n");
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      one: {
        files: [
          { path: "tests/integration/mapped.test.mjs", expectedTests: ["case a"] },
          { path: "tests/integration/missing.test.mjs" },
        ],
      },
      two: {
        files: [{ path: "tests/integration/mapped.test.mjs", expectedTests: ["case b"] }],
      },
      broad: {
        files: [{ path: "tests/integration/mapped.test.mjs", expectedTests: ["case c"] }],
      },
      empty: {
        files: [],
      },
    },
    groups: {
      ci: ["one", "two", "broad", "empty", "unknown"],
    },
  });

  const result = run(root, ["audit", "--manifest", "manifest.json", "--root", root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "duplicate-file",
    "missing-file",
    "missing-lane",
    "selected-zero",
    "unmapped-file",
    "unmapped-file",
  ]);
  assert.deepEqual(
    summary.issues
      .filter((entry) => entry.code === "unmapped-file")
      .map((entry) => entry.file)
      .sort(),
    ["tests/docs/unmapped.test.mjs", "tests/integration/unmapped.test.ts"],
  );
});

test("aggregate requires fixed lane outputs, successful needs, and matching source SHA", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      baseline: { files: [{ path: "tests/integration/a.test.mjs" }] },
      runtime: { files: [{ path: "tests/integration/b.test.mjs" }] },
      missing: { files: [{ path: "tests/integration/c.test.mjs" }] },
    },
    groups: {
      full: ["baseline", "runtime", "missing"],
    },
  });
  await writeJson(join(root, "results/baseline.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "baseline",
    status: "passed",
    exitCode: 0,
    files: [
      {
        path: "tests/integration/a.test.mjs",
        status: "passed",
        counts: { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 },
        tests: [{ name: "baseline case", status: "passed" }],
      },
    ],
  });
  await writeJson(join(root, "results/runtime.json"), {
    version: 1,
    command: "run",
    sourceSha: "different-sha",
    lane: "runtime",
    status: "failed",
    exitCode: 1,
    files: [],
  });
  await writeJson(join(root, "needs.json"), {
    baseline: { result: "success" },
    runtime: { result: "failure" },
  });

  const result = run(root, [
    "aggregate",
    "full",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
    "--needs",
    "needs.json",
  ]);

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "lane-failed",
    "missing-lane-output",
    "missing-need",
    "need-not-success",
    "source-sha-mismatch",
  ]);
});

test("aggregate accepts a lane as a singleton target and rejects tampered result evidence", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      "docker-model": {
        files: [
          {
            path: "tests/integration/model.test.mjs",
            expectedTests: ["real model case"],
          },
        ],
      },
    },
    groups: {
      runtime: ["docker-model"],
    },
  });
  await writeJson(join(root, "results/docker-model.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "docker-model",
    status: "passed",
    exitCode: 0,
    files: [],
  });

  const tampered = run(root, [
    "aggregate",
    "docker-model",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
  ]);
  assert.equal(tampered.status, 1);
  let summary = JSON.parse(tampered.stdout);
  assert.deepEqual(
    summary.issues.map((entry) => entry.code),
    ["missing-lane-evidence"],
  );

  await writeJson(join(root, "results/docker-model.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "docker-model",
    status: "passed",
    exitCode: 0,
    files: [
      {
        path: "tests/integration/model.test.mjs",
        status: "passed",
        counts: { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 },
        tests: [{ name: "real model case", status: "passed" }],
      },
    ],
  });

  const passed = run(root, [
    "aggregate",
    "docker-model",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
  ]);
  assert.equal(passed.status, 0, passed.stderr);
  summary = JSON.parse(passed.stdout);
  assert.equal(summary.status, "passed");
  assert.deepEqual(
    summary.lanes.map((entry) => entry.lane),
    ["docker-model"],
  );
});

test("aggregate fails when a supplied non-lane need failed even if lane artifacts pass", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      baseline: {
        files: [{ path: "tests/integration/baseline.test.mjs" }],
      },
    },
    groups: {
      ci: ["baseline"],
    },
  });
  await writeJson(join(root, "results/baseline.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "baseline",
    status: "passed",
    exitCode: 0,
    files: [
      {
        path: "tests/integration/baseline.test.mjs",
        status: "passed",
        counts: { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 },
        tests: [{ name: "baseline case", status: "passed" }],
      },
    ],
  });
  await writeJson(join(root, "needs.json"), {
    audit: { result: "failure" },
    baseline: { result: "success" },
  });

  const result = run(root, [
    "aggregate",
    "ci",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
    "--needs",
    "needs.json",
  ]);

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.deepEqual(
    summary.issues.map((entry) => entry.code),
    ["need-not-success"],
  );
  assert.equal(summary.issues[0].need, "audit");
});

test("run records only allowlisted measurements from test diagnostics", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/measurements.json");
  const measurement = (value) => `openclaw-ci-measurement ${JSON.stringify(value)}`;
  await writeFile(
    join(root, "tests/integration/measurements.test.mjs"),
    [
      'import test from "node:test";',
      'test("measures", (t) => {',
      ...[
        measurement({
          kind: "kubelet-volume-refresh",
          volume: "secret",
          nudge: "pod-annotation",
          sample: 1,
          seconds: 1.234,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "kubelet-volume-refresh",
          volume: "secretauthvalue-volume",
          nudge: "none",
          sample: 0,
          seconds: 1,
        }),
        measurement({
          kind: "kubelet-volume-refresh",
          volume: "configmap",
          nudge: "none",
          sample: 0,
          seconds: "secretauthvalue-seconds",
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-answer",
          code: "READY",
          elapsedMs: 61_234,
          capMs: 110_000,
          cpuWaitMs: 4_321,
          setupMs: 2_345,
          probeDoneMs: 63_456,
          readyMs: null,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-1cpu-answer",
          code: "secretauthvalue-code",
          elapsedMs: 1,
          capMs: 65_000,
          cpuWaitMs: null,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-contended",
          code: null,
          elapsedMs: null,
          capMs: null,
          cpuWaitMs: null,
          setupMs: 1,
          probeDoneMs: null,
          readyMs: null,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "secretauthvalue-case",
          code: "READY",
          elapsedMs: 1,
          capMs: 1,
          cpuWaitMs: 1,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-hang",
          code: "MODEL_PROBE_TIMEOUT",
          elapsedMs: "secretauthvalue-elapsed",
          capMs: 1,
          cpuWaitMs: 1,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "gateway-model-probe",
          stopped: true,
          elapsedMs: 4_321,
          budgetMs: 15_000,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "secretauthvalue-case",
          stopped: true,
          elapsedMs: 1,
          budgetMs: 15_000,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "codex-ready",
          stopped: "secretauthvalue-stopped",
          elapsedMs: 1,
          budgetMs: 15_000,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "codex-ready",
          stopped: false,
          elapsedMs: 1.5,
          budgetMs: 15_000,
        }),
        "openclaw-ci-measurement secretauthvalue-not-json",
        "secretauthvalue-plain-diagnostic",
      ].map((message) => `  t.diagnostic(${JSON.stringify(message)});`),
      "});",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { measure: { files: [{ path: "tests/integration/measurements.test.mjs" }] } },
    groups: { ci: ["measure"] },
  });

  const result = run(root, [
    "run",
    "measure",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/measurements.jsonl",
    "--results",
    resultsPath,
  ]);
  const artifact = await readFile(resultsPath, "utf8");
  const summary = JSON.parse(artifact);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(summary.files[0].measurements, [
    {
      kind: "kubelet-volume-refresh",
      volume: "secret",
      nudge: "pod-annotation",
      sample: 1,
      seconds: 1.2,
    },
    {
      kind: "runtime-model-probe",
      case: "gateway-500m-answer",
      code: "READY",
      elapsedMs: 61_234,
      capMs: 110_000,
      cpuWaitMs: 4_321,
      setupMs: 2_345,
      probeDoneMs: 63_456,
      readyMs: null,
    },
    {
      kind: "runtime-model-probe",
      case: "gateway-1cpu-answer",
      code: "other",
      elapsedMs: 1,
      capMs: 65_000,
      cpuWaitMs: null,
      setupMs: 1,
      probeDoneMs: 1,
      readyMs: 1,
    },
    {
      kind: "runtime-model-probe",
      case: "gateway-500m-contended",
      code: null,
      elapsedMs: null,
      capMs: null,
      cpuWaitMs: null,
      setupMs: 1,
      probeDoneMs: null,
      readyMs: null,
    },
    {
      kind: "runtime-sigterm",
      case: "gateway-model-probe",
      stopped: true,
      elapsedMs: 4_321,
      budgetMs: 15_000,
    },
  ]);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
});

test("run reports a cleanup that fails once a cancelled job's shell is gone as cancelled", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/cancelled.json");
  // GitHub cancels a step by signalling and then killing its shell, never this runner, which
  // finishes as an orphan beside the job's own cleanup step. The second file's cleanup kills
  // the runner's parent, as the cancellation kills the shell, and then fails, as the racing
  // cleanup step makes it.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      "export async function prepareFile({ file }) {",
      "  if (file.path.endsWith('plain.test.mjs')) {",
      "    return { cleanup: async () => { throw new Error('secretauthvalue cleanup'); } };",
      "  }",
      "  return {",
      "    cleanup: async () => {",
      "      const shell = process.ppid;",
      "      process.kill(shell, 'SIGKILL');",
      "      const deadline = Date.now() + 10_000;",
      "      while (process.ppid === shell && Date.now() < deadline) {",
      "        await new Promise((resolve) => setTimeout(resolve, 10));",
      "      }",
      "      throw Object.assign(new Error('secretauthvalue cluster already removed'), { code: 'ENOENT' });",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  for (const name of ["plain", "cancelled"]) {
    await writeFile(
      join(root, `tests/integration/${name}.test.mjs`),
      'import test from "node:test";\ntest("runs", () => {});\n',
    );
  }
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      cancel: {
        files: [
          { path: "tests/integration/plain.test.mjs" },
          { path: "tests/integration/cancelled.test.mjs" },
        ],
      },
    },
    groups: { ci: ["cancel"] },
  });

  // A parent process stands in for the step's shell: it waits for the runner until the second
  // file's cleanup kills it. No shell parses any of these arguments. The timeout only stops a
  // hang: a loaded host can take over 30 s to run both files, and the shell must die by the
  // cleanup's SIGKILL, not this SIGTERM.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" });',
      process.execPath,
      runnerPath,
      "run",
      "cancel",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      join(root, "state/cancelled.json"),
      "--results",
      resultsPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: runnerEnv(), timeout: 120_000 },
  );

  assert.equal(result.signal, "SIGKILL", result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.status, "failed");
  // A cleanup that fails while the job runs is still a cleanup failure.
  assert.deepEqual(summary.files[0].cleanup, { status: "failed", error: { name: "Error" } });
  // The cancelled record keeps the error's name and code, never its message.
  assert.deepEqual(summary.files[1].cleanup, {
    status: "cancelled",
    error: { name: "Error", code: "ENOENT" },
  });
  assert.deepEqual(
    summary.issues.map(({ code, file }) => [code, file]),
    [
      ["cleanup-failed", "tests/integration/plain.test.mjs"],
      ["cleanup-cancelled", "tests/integration/cancelled.test.mjs"],
    ],
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}`,
    /secretauthvalue/,
  );
});

for (const scenario of [
  {
    name: "exit",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-create",
      failure: "exit",
      exitCode: 42,
      signal: null,
      timedOut: false,
    },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-create",
      failure: "exit",
      exitCode: 42,
      signal: null,
      timedOut: false,
    },
  },
  {
    name: "spawn",
    input: { code: "CI_PREPARATION_COMMAND_FAILED", stage: "database-schema", failure: "spawn" },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-schema",
      failure: "spawn",
    },
  },
  // A refused statement or no session, from the direct connection to the lane's server
  // (scripts/ci/postgres-admin.mjs), which has no process exit code or signal.
  {
    name: "query",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-create",
      failure: "query",
      timedOut: false,
    },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-create",
      failure: "query",
      timedOut: false,
    },
  },
  {
    name: "connect",
    input: { code: "CI_PREPARATION_COMMAND_FAILED", stage: "database-schema", failure: "connect" },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-schema",
      failure: "connect",
    },
  },
  {
    name: "signal",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-migrate",
      failure: "signal",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-migrate",
      failure: "signal",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    },
  },
  {
    name: "timeout",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-migrate",
      failure: "timeout",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
    },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-migrate",
      failure: "timeout",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
    },
  },
  {
    name: "unknown error",
    input: {
      code: "secret-canary-code",
      stage: "secret-canary-stage",
      failure: "secret-canary-failure",
    },
    expected: { name: "Error" },
  },
  {
    name: "unknown stage",
    input: { code: "CI_PREPARATION_COMMAND_FAILED", stage: "secret-canary-stage", failure: "exit" },
    expected: { name: "Error" },
  },
  {
    name: "unknown failure",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-create",
      failure: "secret-canary-failure",
    },
    expected: { name: "Error" },
  },
  {
    name: "invalid details",
    input: {
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-schema",
      failure: "exit",
      exitCode: 256,
      signal: "secret-canary-signal",
      timedOut: "secret-canary-timeout",
    },
    expected: {
      name: "Error",
      code: "CI_PREPARATION_COMMAND_FAILED",
      stage: "database-schema",
      failure: "exit",
    },
  },
]) {
  test(`run retains safe preparation ${scenario.name} diagnostics without starting tests`, async (t) => {
    const root = await fixture(t);
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: { preparation: { files: [{ path: "tests/integration/unstarted.test.mjs" }] } },
      groups: { ci: ["preparation"] },
    });
    await writeFile(
      join(root, "tests/integration/unstarted.test.mjs"),
      'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../../started", import.meta.url), "started");\n',
    );
    const payload = {
      name: "secret-canary-name",
      message: "secret-canary-message",
      command: "secret-canary-command",
      args: ["secret-canary-argv"],
      url: "https://secret-canary-url.invalid",
      env: { KEY: "secret-canary-env" },
      stdout: "secret-canary-stdout",
      stderr: "secret-canary-stderr",
      stack: "secret-canary-stack",
      ...scenario.input,
    };
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      `export async function prepareFile() { throw Object.assign(new Error(), ${JSON.stringify(payload)}); }\n`,
    );
    const result = run(root, [
      "run",
      "preparation",
      "--manifest",
      "manifest.json",
      "--root",
      root,
      "--state",
      "state/lane.json",
      "--results",
      "results/preparation.json",
    ]);
    assert.equal(result.status, 1, result.stderr);
    const artifact = await readFile(join(root, "results/preparation.json"), "utf8");
    const summary = JSON.parse(artifact);
    assert.deepEqual(
      summary.files[0].issues.find(({ code }) => code === "prepare-failed").error,
      scenario.expected,
    );
    assert.equal(summary.files[0].status, "failed");
    assert.equal(summary.files[0].nodeExitCode, null);
    assert.deepEqual(summary.files[0].tests, []);
    assert.equal(summary.counts.passed, 0);
    assert.equal(summary.counts.skipped, 0);
    assert.equal(summary.files[0].cleanup, null);
    await assert.rejects(readFile(join(root, "started")), { code: "ENOENT" });
    assert.doesNotMatch(artifact + result.stdout + result.stderr, /secret-canary/);
  });
}

test("run publishes a failed wait's followed container log, redacted, beside Agent activity", async (t) => {
  const root = await fixture(t);
  const clusterDirectory = join(root, "cluster");
  await mkdir(clusterDirectory);
  const statePath = join(root, "state/k3d.json");
  const resultsPath = join(root, "results/k3d.json");
  await writeJson(statePath, {
    lane: "k3d-lane",
    resources: [
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "owned-cluster",
        directory: clusterDirectory,
        kubeconfig: join(clusterDirectory, "kubeconfig"),
        context: "k3d-owned-cluster",
      },
    ],
  });
  const pod = {
    metadata: {
      namespace: "occ-agent-a",
      name: "gateway-0",
      uid: "uid-1",
      creationTimestamp: "2026-10-08T07:43:40Z",
      deletionTimestamp: "2026-10-08T07:43:53Z",
      deletionGracePeriodSeconds: 330,
    },
    spec: {
      containers: [{ name: "gateway", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "gateway", ready: false, restartCount: 0, state: { running: { startedAt: "t" } } },
      ],
    },
  };
  const event = {
    metadata: { namespace: "occ-agent-a", name: "gateway-0.kill", uid: "e1" },
    involvedObject: { kind: "Pod", name: "gateway-0", namespace: "occ-agent-a" },
    type: "Normal",
    reason: "Killing",
    message: "Stopping container gateway",
    count: 1,
    lastTimestamp: "2026-10-08T07:43:53Z",
  };
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "gateway-0",
    second: "2026-10-08T07:43:52",
    laterCount: 198,
  });
  const events = [...boundary.events, event];
  const logLines = [
    "2026-10-08T07:43:49.1Z [gateway] startup phase: config.auth starting",
    "2026-10-08T07:43:53.2Z [gateway] received SIGTERM; shutting down",
    "2026-10-08T07:43:53.3Z request Authorization: Bearer do-not-publish-header",
    "2026-10-08T07:43:53.4Z provider token=do-not-publish-assignment refreshed",
    "2026-10-08T07:43:53.5Z parent value secretauthvalue-parent seen",
  ];
  // Only the lane gives the child this value; the runner's own env never has it.
  const childSecret = "childonlysecret-1754";
  // One stand-in serves the runner's raw watches (which wait until stopped) and
  // the test helper's log follow and snapshots; the log ends after a slow exit.
  const bin = join(root, "bin");
  await mkdir(bin);
  const kubectl = join(bin, "kubectl");
  await writeFile(
    kubectl,
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      'if (args.includes("logs")) {',
      `  process.stdout.write(${JSON.stringify(`${logLines.join("\n")}\n`)});`,
      "  process.stdout.write(`2026-10-08T07:43:53.6Z child value ${process.env.OCC_TEST_CHILD_ONLY}\\n`);",
      "  process.stderr.write('follow note\\nGET https://api Authorization: Bearer do-not-publish-verbose');",
      "  setTimeout(() => process.stdout.write('2026-10-08T07:44:22.0Z [gateway] exit 0'), 300);",
      '} else if (args.includes("get") && args.includes("pods")) {',
      `  process.stdout.write(JSON.stringify({ items: [${JSON.stringify(pod)}] }));`,
      '} else if (args.includes("get") && args.includes("events")) {',
      `  process.stdout.write(JSON.stringify({ items: ${JSON.stringify(events)} }));`,
      "} else {",
      "  setTimeout(() => {}, 60_000);",
      "}",
      "",
    ].join("\n"),
  );
  await chmod(kubectl, 0o755);
  const helper = join(repositoryRoot, "tests/helpers/container-log-capture.mjs");
  await writeFile(
    join(root, "tests/integration/stop.test.mjs"),
    [
      'import test from "node:test";',
      `import { followContainerLog } from ${JSON.stringify(helper)};`,
      "let snapshots = 0;",
      'test("gateway stop is confirmed", async (t) => {',
      "  const log = followContainerLog({",
      '    args: ["logs", "--follow", "--timestamps"],',
      "    env: process.env,",
      '    target: { namespace: "occ-agent-a", pod: "gateway-0", container: "gateway" },',
      "    snapshot: async () => {",
      '      if (process.env.SNAPSHOT_FAILS_AFTER === String(++snapshots)) throw new Error("read failed");',
      '      const read = async (kind) => JSON.parse((await import("node:child_process"))',
      '        .execFileSync("kubectl", ["get", kind, "-o", "json"], { encoding: "utf8" })).items;',
      '      return { pods: await read("pods"), events: await read("events") };',
      "    },",
      "  });",
      "  try {",
      '    process.env.SNAPSHOT_FAILS_AFTER = "2";',
      '    await log.attachOnFailure(t, "passing wait", async () => "settled");',
      '    log.mark("stop requested");',
      '    await log.attachOnFailure(t, "terminal response wait", async () => {',
      '      throw new Error("timed out");',
      "    });",
      "  } finally {",
      "    await log.stop();",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/pass.test.mjs"),
    'import test from "node:test";\ntest("passes", () => {});\n',
  );
  await writeJson(join(root, "scripts/ci/k3d-lane.json"), {
    env: { OCC_TEST_CHILD_ONLY: childSecret },
    files: [
      { path: "tests/integration/stop.test.mjs", expectedTests: ["gateway stop is confirmed"] },
      { path: "tests/integration/pass.test.mjs", expectedTests: ["passes"] },
    ],
  });
  await writeJson(join(root, "scripts/ci/suites.json"), {
    version: 1,
    lanes: { "k3d-lane": "./k3d-lane.json" },
    groups: {},
  });

  const result = run(
    root,
    [
      "run",
      "k3d-lane",
      "--manifest",
      join(root, "scripts/ci/suites.json"),
      "--root",
      root,
      "--state",
      statePath,
      "--results",
      resultsPath,
    ],
    { OCC_KUBECTL_BIN: kubectl, PATH: `${bin}:${process.env.PATH}` },
  );

  assert.equal(result.status, 1, result.stderr);
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const { containerLogs } = JSON.parse(text);
  // Only the failed wait writes a record: not the wait that settled, not the passing file.
  assert.equal(containerLogs.length, 1);
  const [log] = containerLogs;
  assert.equal(log.file, "tests/integration/stop.test.mjs");
  assert.equal(log.test, "gateway stop is confirmed");
  assert.equal(log.reason, "terminal response wait");
  assert.deepEqual(
    [log.namespace, log.pod, log.container],
    ["occ-agent-a", "gateway-0", "gateway"],
  );
  assert.deepEqual(
    log.markers.map(({ label }) => label),
    ["stop requested", "failed: terminal response wait"],
  );
  // The follow ran to the container's exit, unterminated last line included.
  assert.equal(log.stream.ended, true);
  assert.equal(log.stream.exitCode, 0);
  assert.equal(log.stream.error, "follow note\n[redacted credential-bearing line]");
  assert.deepEqual(log.lines, [
    logLines[0],
    logLines[1],
    "[redacted credential-bearing line]",
    "2026-10-08T07:43:53.4Z provider token=[redacted] refreshed",
    "2026-10-08T07:43:53.5Z parent value [env:CI_RUNNER_PARENT_SECRET] seen",
    "2026-10-08T07:43:53.6Z child value [env:OCC_TEST_CHILD_ONLY]",
    "2026-10-08T07:44:22.0Z [gateway] exit 0",
  ]);
  // A failed read is marked, so it cannot pass for a Pod that is already gone.
  assert.deepEqual(
    log.snapshots.map(({ label, unavailable }) => [label, unavailable]),
    [
      ["at-failure", undefined],
      ["after-log", true],
    ],
  );
  const [snapshot] = log.snapshots;
  assert.equal(snapshot.pods[0].deletedAt, "2026-10-08T07:43:53Z");
  assert.equal(snapshot.pods[0].deletionGracePeriodSeconds, 330);
  assert.equal(snapshot.pods[0].containers[0].startedAt, "t");
  assert.equal(snapshot.events.length, 200);
  assert.equal(snapshot.events[0].reason, boundary.newer.reason);
  assert.equal(
    snapshot.events.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.deepEqual(
    snapshot.events.find(({ reason }) => reason === "Killing"),
    {
      namespace: "occ-agent-a",
      kind: "Pod",
      name: "gateway-0",
      type: "Normal",
      reason: "Killing",
      message: "Stopping container gateway",
      count: 1,
      lastTimestamp: "2026-10-08T07:43:53Z",
    },
  );
  assert.doesNotMatch(text, /do-not-publish|secretauthvalue|childonlysecret/);
  // The record directory lived in the cluster's private directory and is gone.
  assert.deepEqual(
    (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
    [],
  );
});

describe("tests that wait out real runner limits, side by side", { concurrency: true }, () => {
  for (const args of waitingTests) {
    test(...args);
  }
});
