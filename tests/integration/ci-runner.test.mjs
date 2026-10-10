import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    ...env,
  };
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: runnerEnv(env),
  });
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
      'import test from "node:test";',
      'test("ordinary pass", () => assert.equal(1, 1));',
      'test("expected but skipped", { skip: "not allowed for expected" }, () => {});',
      'test("unexpected skipped case", { skip: "missing prerequisite" }, () => {});',
      'test("todo case", { todo: "missing prerequisite" }, () => {});',
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
  ]);
  // Every issue is named in the job log, which keeps every attempt.
  for (const line of [
    "run-tests: issue missing-expected-test tests/integration/skips.test.mjs: expected test did not run: missing named case",
    "run-tests: issue expected-test-not-passed tests/integration/skips.test.mjs: expected test did not pass: expected but skipped",
    "run-tests: issue unexpected-skip tests/integration/skips.test.mjs: selected test did not run to completion: todo case",
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

test("run does not inherit parent NODE_ENV unless explicitly selected", async (t) => {
  const root = await fixture(t);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      isolated: {
        files: [{ path: "tests/integration/node-env.test.mjs" }],
      },
    },
    groups: { ci: ["isolated"] },
  });
  await writeFile(
    join(root, "tests/integration/node-env.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("NODE_ENV is scrubbed", () => {',
      "  assert.equal(process.env.NODE_ENV, undefined);",
      "});",
      "",
    ].join("\n"),
  );

  const result = run(root, [
    "run",
    "isolated",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    "state/node-env.jsonl",
    "--results",
    "results/node-env.json",
  ]);

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
  assert.equal(process.env.OCC_TEST_QA_SCENARIOS, "model-ui,calendar,git-full");
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
      OCC_TEST_QA_SCENARIOS: "model-ui,calendar,git-full",
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

test(
  "run kills a timed-out file's whole process group after the timeout record",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state/orphan.json");
    const recordPath = join(root, "state/orphan-pids.json");
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

    const result = run(
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
    );

    assert.equal(result.status, 1);
    pids = JSON.parse(await readFile(recordPath, "utf8"));
    // The timeout record still comes from the runner's reporter before the group dies.
    const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
    assert.equal(record.reason, "timeout");
    assert.equal(record.timeoutMs, 5000);
    assert.deepEqual(record.interruptedTests, [{ name: "outlives its runner", line: 4 }]);
    assert.deepEqual(record.output.lines, ["stdout: waiting with SIGTERM ignored"]);
    // Killed processes are reaped by their new parent asynchronously; a zombie is gone.
    const deadline = Date.now() + 5_000;
    const alive = () =>
      [pids.file, pids.grandchild].filter((pid) => {
        const stat = procStat(pid);
        return stat !== undefined && stat.state !== "Z" && stat.pgid === pids.pgid;
      });
    while (alive().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(alive(), []);
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
    const deadline = Date.now() + 5_000;
    const alive = () => {
      const stat = procStat(pids.grandchild);
      return stat !== undefined && stat.state !== "Z" && stat.pgid === pids.pgid;
    };
    while (alive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive(), false);
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
      // Killed processes are reaped by their new parent asynchronously; a zombie is gone.
      const alive = () =>
        [pids.runner, pids.file, pids.grandchild].filter((pid) => {
          const stat = procStat(pid);
          return stat !== undefined && stat.state !== "Z" && stat.pgid === pids.pgid;
        });
      await waitFor(() => alive().length === 0, 5_000);
      assert.deepEqual(alive(), []);
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
      '  assert.fail(`${"stage line\\n".repeat(80)}decisive line ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);',
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
  assert.doesNotMatch(failed.error.message, /decisive line/);
  assert.equal(failed.error.stack, undefined);
  assert.match(
    result.stderr,
    /run-tests: whole failure messages, stacks and output tails are in .*state\/details\.json\.diagnostics\.json \(artifact diagnostics-<prefix>-details-attempt-(?:\d+|<N>)\)/,
  );
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123|passing output/);
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

test("run records a timed-out file's interrupted test and output tail in the diagnostics report", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/hang.json");
  const statePath = join(root, "state/hang.json");
  await writeFile(
    join(root, "tests/integration/hang.test.mjs"),
    [
      'import test from "node:test";',
      'test("passes first", () => {});',
      'test("hangs", async () => {',
      "  for (let index = 0; index < 500; index += 1) {",
      '    console.log(`bulk ${index} ${"v".repeat(2_000)}`);',
      "  }",
      "  console.log(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
      '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
      '  console.log("waiting for a reply that never comes");',
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

  const result = run(
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
  );

  assert.equal(result.status, 1);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert(summary.issues.some((entry) => entry.code === "test-timeout"));
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123/);
  const [record] = JSON.parse(text).failures;
  assert.equal(record.file, "tests/integration/hang.test.mjs");
  assert.equal(record.reason, "timeout");
  assert.equal(record.timeoutMs, 5000);
  assert(record.elapsedMs >= 5000 && record.elapsedMs < 15_000, String(record.elapsedMs));
  assert.deepEqual(record.interruptedTests, [{ name: "hangs", line: 3 }]);
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
});

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

test("run records a timeout that came before any test started", async (t) => {
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

  const result = run(
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
      lastTimestamp: `2026-09-29T00:00:0${count}Z`,
    },
  });
  const pods = [
    pod(false, "ADDED"),
    pod(false, "MODIFIED"),
    pod(true, "MODIFIED"),
    pod(true, "DELETED"),
  ];
  const events = [
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
  await writeFile(
    join(root, "tests/integration/agent.test.mjs"),
    [
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      'test("agent file passes", () => delay(300));',
      "",
    ].join("\n"),
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
    { OCC_KUBECTL_BIN: kubectl },
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
  assert.deepEqual(
    activity.events.map(({ reason, count }) => [reason, count]),
    [
      ["Pulled", 1],
      ["Failed", 1],
      ["Unhealthy", 3],
    ],
  );
  assert.doesNotMatch(text, /do-not-publish|unrelated system event/);
  // Raw watch streams hold full Pod specs; only the projection survives.
  assert.deepEqual(await readdir(clusterDirectory), []);

  // Two files sharing the runner under fileConcurrency watch the same cluster at once. Each
  // keeps its own watch streams, so neither truncates nor deletes the other's capture.
  await writeFile(
    join(root, "tests/integration/agent-sibling.test.mjs"),
    [
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      'test("sibling file passes", () => delay(300));',
      "",
    ].join("\n"),
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
    { OCC_KUBECTL_BIN: kubectl, CI_RUNNER_FILE_CONCURRENCY: "2" },
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
      env: { ...process.env, GITHUB_SHA: currentSha(), OCC_KUBECTL_BIN: kubectl },
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

test("audit requires current discovered test files and rejects duplicate ownership", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/mapped.test.mjs"), "import 'node:test';\n");
  await writeFile(join(root, "tests/integration/unmapped.test.mjs"), "import 'node:test';\n");
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
    ["tests/docs/unmapped.test.mjs", "tests/integration/unmapped.test.mjs"],
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
  ]);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
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
      `  process.stdout.write(JSON.stringify({ items: [${JSON.stringify(event)}] }));`,
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
  assert.deepEqual(
    snapshot.events.map(({ reason, message }) => [reason, message]),
    [["Killing", "Stopping container gateway"]],
  );
  assert.doesNotMatch(text, /do-not-publish|secretauthvalue|childonlysecret/);
  // The record directory lived in the cluster's private directory and is gone.
  assert.deepEqual(
    (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
    [],
  );
});
