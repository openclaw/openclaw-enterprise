type TestCounts = {
  tests: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  todo: number;
  suites: number;
};

type TerminalEvent = {
  type: "test:pass" | "test:fail";
  data: {
    testType?: unknown;
    skip?: unknown;
    todo?: unknown;
    testId?: unknown;
    parentId?: unknown;
    nesting?: unknown;
    caseAssertionFailure?: true;
    caseSubtestsFailed?: true;
  };
};

export function recordsCoverage(workflow: string | undefined): boolean {
  return workflow === "CI" || workflow === "Full Integration";
}

function isTestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function exercisedAssertionFailures(
  summaries: readonly TestCounts[],
  terminal: readonly TerminalEvent[],
  exitCode: number | null,
): ReadonlySet<TerminalEvent> | undefined {
  const [counts] = summaries;
  const cases = terminal.filter(({ data }) => data.testType === "test");
  const failedCases = cases.filter(({ type }) => type === "test:fail").length;
  if (
    !counts ||
    summaries.length !== 1 ||
    cases.length === 0 ||
    counts.tests !== cases.length ||
    counts.suites !== terminal.length - cases.length ||
    counts.passed !== cases.length - failedCases ||
    counts.failed !== failedCases ||
    counts.cancelled !== 0 ||
    counts.skipped !== 0 ||
    counts.todo !== 0 ||
    terminal.some(({ data }) => data.skip !== undefined || data.todo !== undefined) ||
    exitCode !== (failedCases === 0 ? 0 : 1)
  ) {
    return undefined;
  }

  const failures = terminal.filter(({ type }) => type === "test:fail");
  const assertions = new Set(failures.filter(({ data }) => data.caseAssertionFailure === true));
  if (assertions.size === failures.length) {
    return assertions;
  }

  const nodes = new Map<
    number,
    { entry: TerminalEvent; index: number; parentId: number; nesting: number }
  >();
  for (const [index, entry] of terminal.entries()) {
    const { testId, parentId, nesting } = entry.data;
    if (
      !isTestId(testId) ||
      testId === 0 ||
      !isTestId(parentId) ||
      !isTestId(nesting) ||
      nodes.has(testId)
    ) {
      return undefined;
    }
    nodes.set(testId, { entry, index, parentId, nesting });
  }
  const children = new Map<number, TerminalEvent[]>();
  for (const { entry, index, parentId, nesting } of nodes.values()) {
    const parent = nodes.get(parentId);
    if (nesting === 0) {
      if (parent) {
        return undefined;
      }
      continue;
    }
    if (!parent || parent.index <= index || parent.nesting !== nesting - 1) {
      return undefined;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry);
    children.set(parentId, siblings);
  }
  // Node reports terminal children before their parent. Suites do not count
  // as cases, but a failed suite also needs a corroborated assertion.
  for (const entry of failures) {
    if (assertions.has(entry)) {
      continue;
    }
    const { testId, caseSubtestsFailed } = entry.data;
    const failedChildren = isTestId(testId)
      ? children.get(testId)?.filter((child) => child.type === "test:fail")
      : undefined;
    if (
      caseSubtestsFailed !== true ||
      !failedChildren?.length ||
      !failedChildren.every((child) => assertions.has(child))
    ) {
      return undefined;
    }
    assertions.add(entry);
  }
  return assertions;
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
    file.cleanup === undefined ||
    (file.cleanup !== null && record(file.cleanup)?.status !== "passed") ||
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
  const failedExpected = new Set(expected.expectedTests.filter((name) => failedNames.has(name)));
  const issueNames = new Set(file.issues.map((issue: unknown) => record(issue)?.name));
  const status = failed ? "failed" : "passed";
  if (
    file.issues.length !== failedExpected.size ||
    issueNames.size !== failedExpected.size ||
    !countsMatch(file.counts, passed, failed) ||
    expected.expectedTests.some((name) => !names.has(name)) ||
    !file.issues.every((issue: unknown) => {
      const name = record(issue)?.name;
      return (
        record(issue)?.file === expected.path &&
        typeof name === "string" &&
        failedExpected.has(name)
      );
    }) ||
    file.status !== status ||
    file.nodeExitCode !== (failed ? 1 : 0)
  ) {
    return undefined;
  }
  return { passed, failed, failedExpected };
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
    record(receipt.cleanup)?.status !== "passed" ||
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
  const issueKeys = new Set(
    receipt.issues.map((issue: unknown) => {
      const entry = record(issue);
      return JSON.stringify([entry?.file, entry?.name]);
    }),
  );
  if (issueKeys.size !== receipt.issues.length) {
    return undefined;
  }
  let passed = 0;
  let failed = 0;
  for (const expected of expectedFiles) {
    const counts = fileCounts(files.get(expected.path), expected);
    if (!counts) {
      return undefined;
    }
    for (const name of counts.failedExpected) {
      if (!issueKeys.delete(JSON.stringify([expected.path, name]))) {
        return undefined;
      }
    }
    passed += counts.passed;
    failed += counts.failed;
  }
  const status = failed ? "failed" : "passed";
  if (
    issueKeys.size === 0 &&
    countsMatch(receipt.counts, passed, failed) &&
    receipt.status === status &&
    receipt.exitCode === (failed ? 1 : 0)
  ) {
    return status;
  }
}
