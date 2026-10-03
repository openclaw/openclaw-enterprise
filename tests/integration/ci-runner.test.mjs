import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      // Fixture failures quote this value; the reporter must redact env values.
      CI_RUNNER_FIXTURE_CREDENTIAL: "secretauthvalue",
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
      OCC_PROBE_LEAKED_SELECTOR: "1",
      OCC_PROBE_REQUIRED_SELECTOR: "required",
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
  const cliAndArtifact = `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}`;
  assert.doesNotMatch(cliAndArtifact, /secretauthvalue|strippedjobvalue42/);
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
    { CHILD_URL: "postgres://app:childpw77@db/app", JOB_ONLY_KEY: "otheropaque456" },
  ]);
  const render = async (cause) => {
    let text = "";
    for await (const chunk of reporter([
      { type: "test:fail", data: { name: "case", details: { error: { cause } } } },
    ])) {
      text += chunk;
    }
    return redactFailure(JSON.parse(text).data.error, secrets, "/repo");
  };
  const credentials = [
    "Authorization: Bearer abcdefghijklmnop0123",
    "postgres://occ:hunter2pass@db.internal:5432/occ",
    "token=ghp_0123456789abcdefghijABCDEFGHIJ",
    'password: "correct-horse"',
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl",
    "sk-proj-0123456789abcdef",
    "xoxb-1234-5678-abcdefgh",
    "xapp-1-A0123-4567-abcdef",
    "redis://:redispw99@cache:6379 https://tokenvalue123@git.example",
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

test("run keeps bounded Agent namespace activity from a passing k3d file", async (t) => {
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
      "setInterval(() => {}, 1000);",
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
