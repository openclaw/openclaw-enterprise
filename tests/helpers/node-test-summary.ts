// Reads the final counts that `node --test` prints (spec reporter "ℹ tests 7"
// or TAP "# tests 7"), so a test that runs another test file can check its
// outcome without hard-coding how many tests that file has. Each count must
// appear exactly once: a missing or repeated line means the output is not one
// complete run summary. Errors end with the output's last 2000 characters,
// where the runner prints the totals and any failing tests.
export function nodeTestSummary(output: string) {
  return {
    tests: readCount(output, "tests"),
    suites: readCount(output, "suites"),
    pass: readCount(output, "pass"),
    fail: readCount(output, "fail"),
    cancelled: readCount(output, "cancelled"),
    skipped: readCount(output, "skipped"),
    todo: readCount(output, "todo"),
  };
}

function readCount(output: string, key: string): number {
  const matches = [...output.matchAll(new RegExp(`^(?:ℹ|#) ${key} (\\d+)\\r?$`, "gmu"))];
  const value = matches[0]?.[1];
  if (matches.length !== 1 || value === undefined) {
    throw new Error(
      `Expected one "${key}" count in the node test summary, found ${matches.length}: ${outputTail(output)}`,
    );
  }
  return Number(value);
}

// Every test in the run passed: at least `minimum` tests, none failed,
// cancelled, skipped or todo.
export function assertAllPassed(output: string, { minimum = 1 }: { minimum?: number } = {}) {
  const summary = nodeTestSummary(output);
  const { tests, pass, fail, cancelled, skipped, todo } = summary;
  if (
    tests < minimum ||
    pass !== tests ||
    fail !== 0 ||
    cancelled !== 0 ||
    skipped !== 0 ||
    todo !== 0
  ) {
    throw new Error(
      `Expected all of at least ${minimum} tests to pass, got ${JSON.stringify(summary)}: ${outputTail(output)}`,
    );
  }
  return summary;
}

function outputTail(output: string) {
  return output.trim().slice(-2_000);
}
