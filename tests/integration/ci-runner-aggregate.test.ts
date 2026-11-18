import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateArgs,
  createRunnerFixture as fixture,
  currentSha,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

interface AggregateReceipt {
  status: string;
  issues: { code: string; need?: string }[];
  lanes: { lane: string; status: string }[];
}

interface FileEvidence {
  status: string;
  cleanup: { status: string };
  tests: { name: string; status: string }[];
}

interface LaneReceipt {
  scope: string;
  files: FileEvidence[];
}

function writePassedBaselineResult(root: string, sourceSha: string, filePath: string) {
  return writeJson(join(root, "results/baseline.json"), {
    version: 1,
    command: "run",
    sourceSha,
    lane: "baseline",
    status: "passed",
    exitCode: 0,
    files: [
      {
        path: filePath,
        status: "passed",
        counts: { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 },
        tests: [{ name: "baseline case", status: "passed" }],
      },
    ],
  });
}

function writeSingleLaneManifest(
  root: string,
  lane: string,
  files: { path: string; expectedTests?: string[] }[],
  groups: Record<string, string[]>,
) {
  return writeRunnerManifest(root, { lanes: { [lane]: { files } }, groups });
}

async function aggregateWithNeeds(root: string, target: string, needs: unknown) {
  const needsFile = "needs.json";
  await writeJson(join(root, needsFile), needs);
  return runRunnerSync([...aggregateArgs(root, target), "--needs", needsFile]);
}

test("aggregate requires fixed lane outputs, successful needs, and matching source SHA", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  const baselinePath = "tests/integration/a.test.mjs";
  await writeRunnerManifest(root, {
    lanes: {
      baseline: { files: [{ path: baselinePath }] },
      runtime: { files: [{ path: "tests/integration/b.test.mjs" }] },
      missing: { files: [{ path: "tests/integration/c.test.mjs" }] },
    },
    groups: {
      full: ["baseline", "runtime", "missing"],
    },
  });
  await writePassedBaselineResult(root, sha, baselinePath);
  await writeJson(join(root, "results/runtime.json"), {
    version: 1,
    command: "run",
    sourceSha: "different-sha",
    lane: "runtime",
    status: "failed",
    exitCode: 1,
    files: [],
  });
  const result = await aggregateWithNeeds(root, "full", {
    baseline: { result: "success" },
    runtime: { result: "failure" },
  });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout) as AggregateReceipt;
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "missing-lane-output",
    "missing-need",
    "need-not-success",
    "source-sha-mismatch",
  ]);
  // A different revision's failure cannot describe this revision's runtime lane.
  assert.deepEqual(
    summary.lanes.map((lane) => lane.lane),
    ["baseline"],
  );
});

test("aggregate accepts a lane as a singleton target and rejects tampered result evidence", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  const file = "tests/integration/model.test.mjs";
  const name = "real model case";
  await writeSingleLaneManifest(
    root,
    "docker-model",
    [
      {
        path: file,
        expectedTests: [name],
      },
    ],
    {
      runtime: ["docker-model"],
    },
  );
  await writeJson(join(root, "results/docker-model.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "docker-model",
    status: "passed",
    exitCode: 0,
    files: [],
  });

  const args = aggregateArgs(root, "docker-model");
  const tampered = runRunnerSync(args);
  assert.equal(tampered.status, 1);
  assert.deepEqual(
    (JSON.parse(tampered.stdout) as AggregateReceipt).issues.map((entry) => entry.code),
    ["missing-lane-evidence"],
  );

  // Produce full evidence with a required case and an optional nested case.
  await writeFile(
    join(root, file),
    [
      'import test from "node:test";',
      'await test("real model case", async (t) => {',
      '  await t.test("optional nested case", () => {});',
      "});",
      "",
    ].join("\n"),
  );
  const produced = runRunnerSync(
    laneArgs(root, "docker-model", "state/docker-model.json", "results/docker-model.json"),
  );
  assert.equal(produced.status, 0, produced.stderr);

  const checkOutcome = (
    result: ReturnType<typeof runRunnerSync>,
    exitCode: number,
    diagnostic: string,
  ) => {
    assert.equal(result.status, exitCode, diagnostic);
    const summary = JSON.parse(result.stdout) as AggregateReceipt;
    assert.equal(summary.status, exitCode === 0 ? "passed" : "failed");
    return summary;
  };
  const passed = runRunnerSync(args);
  const summary = checkOutcome(passed, 0, passed.stderr);
  assert.deepEqual(
    summary.lanes.map((entry) => entry.lane),
    ["docker-model"],
  );

  const resultPath = join(root, "results/docker-model.json");
  const evidence = JSON.parse(await readFile(resultPath, "utf8")) as LaneReceipt;
  assert.equal(evidence.scope, "full");
  const fileEvidence = evidence.files[0]!;
  const required = fileEvidence.tests.find((testCase) => testCase.name === name);
  const optional = fileEvidence.tests.find((testCase) => testCase.name === "optional nested case");
  assert.equal(required?.status, "passed");
  assert.equal(optional?.status, "passed");
  const aggregateFiles = async (files: readonly unknown[]) => {
    await writeJson(resultPath, { ...evidence, files });
    return runRunnerSync(args);
  };

  const failedFileEvidence = {
    ...fileEvidence,
    status: "failed",
    cleanup: { status: "failed" },
  };
  const duplicateFileIssue = {
    code: "duplicate-lane-file",
    message: `lane docker-model has duplicate file evidence for ${file}`,
    lane: "docker-model",
    file,
  };
  const failedFileIssues = [
    {
      code: "lane-file-failed",
      message: "lane docker-model file did not pass",
      lane: "docker-model",
      file,
      status: "failed",
    },
    {
      code: "cleanup-failed",
      message: "lane docker-model file cleanup did not pass",
      lane: "docker-model",
      file,
    },
  ];
  for (const [label, files, issues] of [
    ["duplicate file fails then passes", [failedFileEvidence, fileEvidence], failedFileIssues],
    ["duplicate file passes then fails", [fileEvidence, failedFileEvidence], failedFileIssues],
    ["duplicate file passes both times", [fileEvidence, fileEvidence], []],
  ] as const) {
    await t.test(label, async () => {
      const result = await aggregateFiles(files);
      const aggregate = checkOutcome(result, 1, result.stdout || result.stderr);
      assert.deepEqual(aggregate.issues, [duplicateFileIssue, ...issues]);
    });
  }

  await t.test("duplicate unregistered file evidence does not expose its path", async () => {
    const unregisteredPath = "tests/integration/untrusted-receipt-path-canary.test.mjs";
    const unregisteredFile = { ...fileEvidence, path: unregisteredPath };
    const result = await aggregateFiles([fileEvidence, unregisteredFile, unregisteredFile]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      !result.stdout.includes(unregisteredPath) && !result.stderr.includes(unregisteredPath),
      "aggregate printed an unregistered receipt path",
    );
    const aggregate = JSON.parse(result.stdout) as AggregateReceipt;
    assert.equal(aggregate.status, "failed");
    assert.deepEqual(aggregate.issues, [
      {
        code: "duplicate-lane-file",
        message: "lane docker-model has duplicate file evidence for an unregistered file",
        lane: "docker-model",
      },
    ]);
  });

  const skipped = { ...required, status: "skipped" };
  const unpassed = (status: string) => ({
    code: "expected-test-not-passed",
    message: `expected test did not pass: ${name}`,
    file,
    name,
    status,
  });
  const marker = "untrusted-case-status-marker";
  const invalidStatuses = [
    ["string", marker],
    ["object", { text: marker }],
    ["array", [marker]],
  ];

  // Keep the passing rollups and vary the individual case evidence.
  for (const [label, cases, issues] of [
    ["required skip", [skipped], [unpassed("skipped")]],
    ["skip before duplicate pass", [skipped, required], [unpassed("skipped")]],
    ["pass before duplicate skip", [required, skipped], [unpassed("skipped")]],
    ["both duplicates pass", [required, required], []],
    ["missing status before duplicate pass", [{ name }, required], [unpassed("invalid")]],
    ...invalidStatuses.map(
      ([type, status]) =>
        [`invalid ${type} status`, [{ ...required, status }], [unpassed("invalid")]] as const,
    ),
    [
      "null row in valid JSON",
      [required, null],
      [
        {
          code: "invalid-test-evidence",
          message: "test evidence contains an invalid case entry",
          file,
        },
      ],
    ],
  ] as const) {
    await t.test(label, async () => {
      const result = await aggregateFiles([{ ...fileEvidence, tests: [optional, ...cases] }]);
      assert.ok(
        !result.stdout.includes(marker) && !result.stderr.includes(marker),
        "aggregate printed untrusted case status",
      );
      const aggregate = checkOutcome(result, issues.length === 0 ? 0 : 1, result.stdout);
      assert.deepEqual(aggregate.issues, issues);
    });
  }
});

test("aggregate requires successful job gates and unambiguous lane ownership", async (t) => {
  const root = await fixture(t);
  const sha = currentSha();
  const baselinePath = "tests/integration/baseline.test.mjs";
  await writeSingleLaneManifest(root, "baseline", [{ path: baselinePath }], {
    ci: ["baseline"],
  });
  await writePassedBaselineResult(root, sha, baselinePath);
  const result = await aggregateWithNeeds(root, "ci", {
    audit: { result: "failure" },
    baseline: { result: "success" },
  });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout) as AggregateReceipt;
  assert.equal(summary.status, "failed");
  assert.deepEqual(
    summary.issues.map((entry) => entry.code),
    ["need-not-success"],
  );
  assert.equal(summary.issues[0]!.need, "audit");

  // A matrix parent carries its job conclusion, never a conclusion for each
  // child. Unselected siblings may remain in a shared workflow's parent list.
  for (const state of ["success", "failure", "cancelled", "skipped", undefined]) {
    const observed = await aggregateWithNeeds(root, "ci", {
      matrix: { result: state, lanes: ["baseline", "unselected-sibling"] },
    });
    assert.equal(observed.status, state === "success" ? 0 : 1, observed.stderr);
    const aggregated = JSON.parse(observed.stdout) as AggregateReceipt;
    assert.deepEqual(
      aggregated.issues.map((entry) => entry.code),
      state === "success" ? [] : ["need-not-success"],
    );
    assert.equal(aggregated.lanes[0]!.status, "passed");
    if (state !== "success") {
      assert.equal(aggregated.issues[0]!.need, "matrix");
    }
  }

  // Valid artifacts cannot replace missing ownership, and malformed ownership
  // must fail even when a separate direct job could otherwise satisfy the lane.
  const missing = await aggregateWithNeeds(root, "ci", {});
  assert.equal(missing.status, 1);
  assert.deepEqual(
    (JSON.parse(missing.stdout) as AggregateReceipt).issues.map((entry) => entry.code),
    ["missing-need"],
  );
  for (const lanes of [null, "baseline", [], [""], ["baseline", "baseline"], [1]]) {
    const malformed = await aggregateWithNeeds(root, "ci", {
      baseline: { result: "success" },
      matrix: { result: "success", lanes },
    });
    assert.equal(malformed.status, 1);
    assert.ok(
      (JSON.parse(malformed.stdout) as AggregateReceipt).issues.some(
        (entry) => entry.code === "invalid-need-lanes",
      ),
    );
  }

  for (const other of [
    { baseline: { result: "success" } },
    { another: { result: "success", lanes: ["baseline"] } },
  ]) {
    const ambiguous = await aggregateWithNeeds(root, "ci", {
      matrix: { result: "success", lanes: ["baseline"] },
      ...other,
    });
    assert.equal(ambiguous.status, 1);
    assert.deepEqual(
      (JSON.parse(ambiguous.stdout) as AggregateReceipt).issues.map((entry) => entry.code),
      ["ambiguous-need"],
    );
  }
});
