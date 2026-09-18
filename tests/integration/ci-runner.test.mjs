import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: currentSha(),
      CI_RUNNER_PARENT_SECRET: "secretauthvalue-parent",
      ...env,
    },
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
      "      env: { CI_RUNNER_SCOPED_VALUE: 'one' },",
      "      cleanup: async () => appendFile(statePath, `${file.path}\\n`),",
      "    };",
      "  }",
      "  return { cleanup: async () => appendFile(statePath, `${file.path}\\n`) };",
      "}",
      "",
    ].join("\n"),
  );
}

test("run uses prepareFile env per file and records real named pass accounting", async (t) => {
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
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      baseline: {
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
      },
    },
    groups: {
      ci: ["baseline"],
    },
  });

  const result = run(root, [
    "run",
    "baseline",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--state",
    statePath,
    "--results",
    resultsPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.skipped, 0);
  assert.equal(summary.files[0].cleanup.status, "passed");
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
      "  assert.equal(process.env.OCC_TEST_LEAKED_SELECTOR, undefined);",
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
        requiredEnv: ["OCC_TEST_REQUIRED_SELECTOR"],
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
    },
  );

  assert.equal(result.status, 0, result.stderr);
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
});

test("run redacts arbitrary stdout, stderr, assertion payloads, and stacks from artifacts", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/redacted.json");
  const secret = "secretauthvalue";

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

  const result = run(root, [
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
  ]);

  assert.equal(result.status, 1);
  const cliAndArtifact = `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}`;
  assert.doesNotMatch(cliAndArtifact, /secretauthvalue/);
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
  const customFailure = summary.files[0].tests.find(
    (entry) => entry.name === "redacted custom error",
  );
  assert.equal(customFailure.status, "failed");
  assert.equal(customFailure.error.cause, undefined);
  assert.equal(customFailure.error.location.line, 11);
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

test("audit requires current discovered test files and rejects duplicate ownership", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/mapped.test.mjs"), "import 'node:test';\n");
  await writeFile(join(root, "tests/integration/unmapped.test.mjs"), "import 'node:test';\n");
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
  ]);
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
