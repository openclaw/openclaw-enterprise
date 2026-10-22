import assert from "node:assert/strict";
import test from "node:test";
import { assertAllPassed, nodeTestSummary } from "../helpers/node-test-summary.ts";

function report(counts: Partial<ReturnType<typeof nodeTestSummary>>, prefix = "ℹ") {
  const all = {
    tests: 7,
    suites: 0,
    pass: 7,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...counts,
  };
  return [
    "✔ a proof (1.2ms)",
    ...Object.entries(all).map(([key, value]) => `${prefix} ${key} ${value}`),
    `${prefix} duration_ms 12.3`,
  ].join("\n");
}

test("node test summary reads spec and TAP totals", () => {
  assert.deepEqual(nodeTestSummary(report({ tests: 9, pass: 8, skipped: 1 })), {
    tests: 9,
    suites: 0,
    pass: 8,
    fail: 0,
    cancelled: 0,
    skipped: 1,
    todo: 0,
  });
  assert.equal(nodeTestSummary(report({ fail: 2 }, "#")).fail, 2);
  assert.equal(nodeTestSummary(report({ todo: 1 }).replaceAll("\n", "\r\n")).todo, 1);
});

test("node test summary refuses a missing or repeated total", () => {
  assert.throws(() => nodeTestSummary("ℹ tests 7\nℹ pass 7"), /one "suites" count.*found 0/);
  assert.throws(
    () => nodeTestSummary(`${report({})}\n${report({})}`),
    /one "tests" count.*found 2/,
  );
  // A total inside a test's own output line does not count.
  assert.throws(
    () => nodeTestSummary(report({}).replace("ℹ pass 7", "log: ℹ pass 7")),
    /"pass".*found 0/,
  );
});

test("all-passed check follows the run's own test count", () => {
  assert.equal(assertAllPassed(report({ tests: 8, pass: 8 }), { minimum: 7 }).tests, 8);
  // Leave pass equal to tests for non-success counts so each count must veto success.
  for (const { label, counts } of [
    { label: "nonzero fail count", counts: { fail: 1 } },
    { label: "nonzero skipped count", counts: { skipped: 1 } },
    { label: "nonzero todo count", counts: { todo: 1 } },
    { label: "nonzero cancelled count", counts: { cancelled: 1 } },
    { label: "fewer passes than tests", counts: { pass: 6 } },
    { label: "below the minimum", counts: { tests: 6, pass: 6 } },
    { label: "no tests", counts: { tests: 0, pass: 0 } },
  ]) {
    assert.throws(
      () => assertAllPassed(report(counts), { minimum: 7 }),
      /Expected all of at least 7 .*ℹ duration_ms 12\.3$/s,
      label,
    );
  }
  assert.throws(() => assertAllPassed(report({ tests: 0, pass: 0 })), /at least 1 tests/);
});
