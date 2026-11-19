import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateArgs,
  createRunnerFixture,
  currentSha,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { checkAggregateEvidence, readAggregateReceipt } from "./ci-runner-aggregate-evidence.ts";

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
  const root = await createRunnerFixture(t);
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

  const summary = readAggregateReceipt(result, 1);
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

test(
  "aggregate accepts a lane as a singleton target and rejects tampered result evidence",
  checkAggregateEvidence,
);

test("aggregate requires successful job gates and unambiguous lane ownership", async (t) => {
  const root = await createRunnerFixture(t);
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

  const summary = readAggregateReceipt(result, 1);
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
    const aggregated = readAggregateReceipt(observed, state === "success" ? 0 : 1);
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
  assert.deepEqual(
    readAggregateReceipt(missing, 1).issues.map((entry) => entry.code),
    ["missing-need"],
  );
  for (const lanes of [null, "baseline", [], [""], ["baseline", "baseline"], [1]]) {
    const malformed = await aggregateWithNeeds(root, "ci", {
      baseline: { result: "success" },
      matrix: { result: "success", lanes },
    });
    assert.ok(
      readAggregateReceipt(malformed, 1).issues.some(
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
    assert.deepEqual(
      readAggregateReceipt(ambiguous, 1).issues.map((entry) => entry.code),
      ["ambiguous-need"],
    );
  }
});
