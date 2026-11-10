type TestCounts = {
  tests: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  todo: number;
};

type CaseEvent = {
  type: "test:pass" | "test:fail";
  data: { skip?: unknown; todo?: unknown; caseAssertionFailure?: true };
};

export function recordsCoverage(workflow: string | undefined): boolean {
  return workflow === "CI" || workflow === "Full Integration";
}

export function fileExercised(
  summaries: readonly TestCounts[],
  cases: readonly CaseEvent[],
  exitCode: number | null,
): boolean {
  const [counts] = summaries;
  if (!counts || summaries.length !== 1 || cases.length === 0) {
    return false;
  }
  const failures = cases.filter((entry) => entry.type === "test:fail");
  return (
    counts.tests === cases.length &&
    counts.passed === cases.length - failures.length &&
    counts.failed === failures.length &&
    counts.cancelled === 0 &&
    counts.skipped === 0 &&
    counts.todo === 0 &&
    cases.every(({ data }) => data.skip === undefined && data.todo === undefined) &&
    failures.every(({ data }) => data.caseAssertionFailure === true) &&
    exitCode === (failures.length === 0 ? 0 : 1)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function countsMatch(value: unknown, passed: number, failed: number): boolean {
  const counts = record(value);
  return (
    counts?.passed === passed &&
    counts.failed === failed &&
    counts.total === passed + failed &&
    counts.skipped === 0 &&
    counts.todo === 0
  );
}

function isAssertionIssue(value: unknown): boolean {
  const issue = record(value);
  return issue?.code === "expected-test-not-passed" && issue.status === "failed";
}

type ExpectedFile = { path: string; expectedTests: readonly string[] };

function fileCounts(value: unknown, expected: ExpectedFile) {
  const file = record(value);
  if (
    !file ||
    file.exercised !== true ||
    file.signal !== null ||
    file.fileFailure !== undefined ||
    (file.cleanup != null && record(file.cleanup)?.status !== "passed") ||
    !Array.isArray(file.issues) ||
    !file.issues.every(isAssertionIssue) ||
    !Array.isArray(file.tests) ||
    file.tests.length === 0
  ) {
    return undefined;
  }
  const names = new Set<string>();
  const failedNames = new Set<string>();
  let passed = 0;
  let failed = 0;
  for (const row of file.tests as unknown[]) {
    const testCase = record(row);
    if (!testCase || typeof testCase.name !== "string" || !testCase.name) {
      return undefined;
    }
    names.add(testCase.name);
    if (testCase.status === "passed") {
      passed += 1;
    } else if (testCase.status === "failed" && testCase.assertionFailure === true) {
      failed += 1;
      failedNames.add(testCase.name);
    } else {
      return undefined;
    }
  }
  const status = failed ? "failed" : "passed";
  if (
    !countsMatch(file.counts, passed, failed) ||
    expected.expectedTests.some((name) => !names.has(name)) ||
    !file.issues.every((issue: unknown) => {
      const name = record(issue)?.name;
      return typeof name === "string" && failedNames.has(name);
    }) ||
    file.status !== status ||
    file.nodeExitCode !== (failed ? 1 : 0)
  ) {
    return undefined;
  }
  return { passed, failed };
}

export function exercisedLaneStatus(
  value: unknown,
  expectedFiles: readonly ExpectedFile[],
): "passed" | "failed" | undefined {
  const receipt = record(value);
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.command !== "run" ||
    receipt.scope !== "full" ||
    !Array.isArray(receipt.files) ||
    expectedFiles.length === 0 ||
    receipt.files.length !== expectedFiles.length ||
    !Array.isArray(receipt.issues) ||
    !receipt.issues.every(isAssertionIssue)
  ) {
    return undefined;
  }
  const files = new Map<string, unknown>();
  for (const file of receipt.files as unknown[]) {
    const path = record(file)?.path;
    if (typeof path !== "string" || files.has(path)) {
      return undefined;
    }
    files.set(path, file);
  }
  let passed = 0;
  let failed = 0;
  for (const expected of expectedFiles) {
    const counts = fileCounts(files.get(expected.path), expected);
    if (!counts) {
      return undefined;
    }
    passed += counts.passed;
    failed += counts.failed;
  }
  const status = failed ? "failed" : "passed";
  if (
    countsMatch(receipt.counts, passed, failed) &&
    receipt.status === status &&
    receipt.exitCode === (failed ? 1 : 0)
  ) {
    return status;
  }
}
