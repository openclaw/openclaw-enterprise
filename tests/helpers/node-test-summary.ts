// Reads the final counts that `node --test` prints (spec reporter "ℹ tests 7"
// or TAP "# tests 7"), so a test that runs another test file can check its
// outcome without hard-coding how many tests that file has. Each count must
// appear exactly once: a missing or repeated line means the output is not one
// complete run summary. Errors end with the output's last 2000 characters,
// where the runner prints the totals and any failing tests.
type SummaryKey = "tests" | "suites" | "pass" | "fail" | "cancelled" | "skipped" | "todo";

export function nodeTestSummary(output: string): Record<SummaryKey, number> {
  function count(key: SummaryKey): number {
    const matches = [...output.matchAll(new RegExp(`^(?:ℹ|#) ${key} (\\d+)\\r?$`, "gmu"))];
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
      throw new Error(
        `Expected one "${key}" count in the node test summary, found ${matches.length}: ${outputTail(output)}`,
      );
    }
    return Number(match[1]);
  }
  return {
    tests: count("tests"),
    suites: count("suites"),
    pass: count("pass"),
    fail: count("fail"),
    cancelled: count("cancelled"),
    skipped: count("skipped"),
    todo: count("todo"),
  };
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
