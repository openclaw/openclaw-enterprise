import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { failureSecrets, redactFailure } from "./failure-redaction.ts";
import { exercisedAssertionFailures, recordsCoverage } from "./full-integration-coverage.ts";
import {
  failureDetails,
  optionalReporterField,
  reporterField,
} from "./runner-failure-diagnostics.ts";
import { absoluteInputPath, isObject, issue, repoRelativePath } from "./runner-inputs.ts";

type TerminalEvent = Parameters<typeof exercisedAssertionFailures>[1][number] & {
  data: Record<string, unknown>;
};

type TestStatus = "passed" | "failed" | "skipped" | "todo";
type TestCase = {
  name: unknown;
  status: TestStatus;
  assertionFailure?: true;
  file: string;
  line: unknown;
  column: unknown;
  skip: unknown;
  todo: unknown;
  error: unknown;
  durationMs: unknown;
};

type SuiteSource = { file: string; line?: number; column?: number; nesting?: number };
type Issue = ReturnType<typeof issue>;
export type FileEvidence = {
  details?: NonNullable<ReturnType<typeof failureDetails>> | undefined;
  fileFailure?: { error: unknown; diagnosticKind?: "post-test-async-activity" };
  measurements: unknown[];
  unfinishedStage?: "installation" | "replacement" | undefined;
  testRunExercised: boolean;
  tests: TestCase[];
  skippedSuites: { name: unknown; source: SuiteSource | undefined }[];
};

function suiteSource(root: string, data: Record<string, unknown>): SuiteSource | undefined {
  if (typeof data.file !== "string" || data.file.length === 0) {
    return undefined;
  }
  try {
    // Normalizing '..' before resolving a symlink can identify a different file.
    const rawPath = data.file.startsWith("file://") ? decodeURIComponent(data.file) : data.file;
    if (rawPath.split(/[/\\]/).includes("..")) {
      return undefined;
    }
    const path = absoluteInputPath(root, data.file);
    const file = repoRelativePath(root, path);
    const actual = relative(realpathSync(root), realpathSync(path));
    if (
      !file ||
      file === ".." ||
      file.startsWith("../") ||
      isAbsolute(file) ||
      actual === ".." ||
      actual.startsWith(`..${sep}`) ||
      isAbsolute(actual) ||
      !statSync(path).isFile()
    ) {
      return undefined;
    }
    const source: SuiteSource = { file };
    for (const key of ["line", "column", "nesting"] as const) {
      const coordinate = data[key];
      if (
        typeof coordinate === "number" &&
        Number.isSafeInteger(coordinate) &&
        coordinate >= (key === "nesting" ? 0 : 1)
      ) {
        source[key] = coordinate;
      }
    }
    return source;
  } catch {
    return undefined;
  }
}

function parseReporter(stdout: string, timedOut: boolean): unknown[] {
  const events: unknown[] = [];
  const lines = stdout.split("\n");
  if (timedOut) {
    lines.pop();
  }
  for (const line of lines) {
    if (line.length > 0) {
      events.push(JSON.parse(line));
    }
  }
  return events;
}

// An unfinished start is useful only if the earlier operations finished in order
// and the independent terminal diagnostics agree with that sequence.
function upstreamUnfinishedStage(events: readonly unknown[], measurements: readonly unknown[]) {
  const stages = ["installation", "exposure-auth", "initial-model", "replacement"];
  const phases = ["installation", "exposure-auth", "gateway-turns", "pod-replacement"];
  let index = 0;
  let started = false;
  for (const event of events) {
    if (reporterField(event, "type") !== "test:progress") {
      continue;
    }
    const data = reporterField(event, "data");
    const kind = reporterField(data, "kind");
    if (kind === "openshell-stage-failure") {
      return undefined;
    }
    if (kind !== "openshell-stage") {
      continue;
    }
    if (
      reporterField(data, "stage") !== stages[index] ||
      reporterField(data, "outcome") !== (started ? "passed" : "started")
    ) {
      return undefined;
    }
    if (started) {
      index += 1;
    }
    started = !started;
  }
  const stage = stages[index];
  if (!started || (stage !== "installation" && stage !== "replacement")) {
    return undefined;
  }
  const previous = new Map<string, number>();
  for (const measurement of measurements) {
    const kind = reporterField(measurement, "kind");
    // Only these two streams establish completion of earlier operations. A
    // gateway failure or another diagnostic cannot corroborate this prefix.
    if (kind !== "openshell-stage" && kind !== "openshell-sandbox-phase") {
      return undefined;
    }
    const names = kind === "openshell-stage" ? stages : phases;
    const measuredStage = reporterField(measurement, "stage");
    const position = typeof measuredStage === "string" ? names.indexOf(measuredStage) : -1;
    if (
      reporterField(measurement, "outcome") !== "passed" ||
      position <= (previous.get(kind) ?? -1) ||
      position >= index
    ) {
      return undefined;
    }
    previous.set(kind, position);
  }
  return stage;
}

function isTerminalEvent(event: unknown, absolutePath: string): event is TerminalEvent {
  const type = reporterField(event, "type");
  if (type !== "test:pass" && type !== "test:fail") {
    return false;
  }
  const data = reporterField(event, "data");
  return (
    isObject(data) &&
    (data.testType === "suite" || (Number.isInteger(data.line) && data.name !== absolutePath))
  );
}

function testStatus(event: TerminalEvent): TestStatus {
  if (event.type === "test:fail") {
    return "failed";
  }
  if (event.data.skip !== undefined) {
    return "skipped";
  }
  if (event.data.todo !== undefined) {
    return "todo";
  }
  return "passed";
}

function assertionFailures(
  events: readonly unknown[],
  terminalEvents: readonly TerminalEvent[],
  exitCode: number | null,
) {
  const summaries = events
    .filter((event) => reporterField(event, "type") === "test:summary")
    .map((event) => reporterField(event, "data"));
  const [counts] = summaries;
  if (summaries.length !== 1 || !isObject(counts)) {
    return undefined;
  }
  const { tests, passed, failed, cancelled, skipped, todo, suites } = counts;
  if (
    typeof tests !== "number" ||
    typeof passed !== "number" ||
    typeof failed !== "number" ||
    typeof cancelled !== "number" ||
    typeof skipped !== "number" ||
    typeof todo !== "number" ||
    typeof suites !== "number"
  ) {
    return undefined;
  }
  // The helper returns the same terminal event objects it was given.
  return exercisedAssertionFailures(
    [{ tests, passed, failed, cancelled, skipped, todo, suites }],
    terminalEvents,
    exitCode,
  );
}

export function readFileEvidence(
  output: {
    stdout: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: { code?: string | undefined } | undefined;
  },
  context: {
    root: string;
    absolutePath: string;
    relativePath: string;
    laneName: string;
    env: NodeJS.ProcessEnv;
    testName?: string | undefined;
  },
  evidence: FileEvidence,
  issues: Issue[],
): void {
  const { root, absolutePath, relativePath, laneName, env, testName } = context;
  const events = parseReporter(output.stdout, output.error?.code === "ETIMEDOUT");
  if (
    testName !== undefined &&
    events.some((event) => {
      const type = reporterField(event, "type");
      if (type !== "test:pass" && type !== "test:fail") {
        return false;
      }
      const data = reporterField(event, "data");
      return (
        optionalReporterField(data, "testType") === "suite" ||
        Number(optionalReporterField(data, "nesting")) > 0
      );
    })
  ) {
    // Flat required names cannot establish which absent descendants belong
    // to a selected ancestor. Nested coverage still requires the whole file.
    issues.push(
      issue(
        "unsupported-test-selection",
        "--test-name supports only standalone top-level test cases; run the whole file for suites or subtests",
        { file: relativePath },
      ),
    );
  }

  // The job env holds OCC_TEST_* values the child never got; the child env
  // holds prepared values (database URLs) the job never had. Redact both.
  const secrets = failureSecrets([process.env, env]);
  const failureError = (error: unknown) => redactFailure(error, secrets, root);
  evidence.details = failureDetails(events, absolutePath, secrets, root);
  const rootFailure = events.find((event) => {
    if (reporterField(event, "type") !== "test:fail") {
      return false;
    }
    const data = reporterField(event, "data");
    return (
      optionalReporterField(data, "file") === absolutePath &&
      reporterField(data, "name") === absolutePath
    );
  });
  if (rootFailure) {
    evidence.fileFailure = {
      error: failureError(reporterField(reporterField(rootFailure, "data"), "error")),
      ...(events.some(
        (event) =>
          reporterField(event, "type") === "test:diagnostic" &&
          optionalReporterField(reporterField(event, "data"), "kind") ===
            "post-test-async-activity",
      )
        ? { diagnosticKind: "post-test-async-activity" }
        : {}),
    };
  }
  evidence.measurements = events
    .filter(
      (event) =>
        reporterField(event, "type") === "test:diagnostic" &&
        optionalReporterField(reporterField(event, "data"), "kind") === "measurement",
    )
    .map((event) => reporterField(reporterField(event, "data"), "measurement"));
  if (
    relativePath === "tests/integration/openshell-upstream-real.test.ts" &&
    ["openshell", "openshell-installers"].includes(laneName)
  ) {
    evidence.unfinishedStage = upstreamUnfinishedStage(events, evidence.measurements);
  }

  const terminalEvents = events.filter((event) => isTerminalEvent(event, absolutePath));
  const caseEvents = terminalEvents.filter(({ data }) => data.testType !== "suite");
  let coverageAssertions: ReturnType<typeof assertionFailures>;
  if (
    recordsCoverage(process.env.GITHUB_WORKFLOW) &&
    !output.error &&
    !output.signal &&
    !rootFailure &&
    !events.some((event) => reporterField(event, "type") === "test:interrupted")
  ) {
    coverageAssertions = assertionFailures(events, terminalEvents, output.status);
    evidence.testRunExercised = coverageAssertions !== undefined;
  }
  evidence.tests = caseEvents.map((event) => {
    const { name, file, line, column, skip, todo, error, durationMs } = event.data;
    let caseFile = relativePath;
    if (typeof file === "string" && file.length > 0) {
      caseFile = repoRelativePath(root, file);
    } else if (file) {
      // The existing path operation reports this code for a non-string input.
      throw Object.assign(new TypeError("Reporter file path is not a string"), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    return {
      name,
      status: testStatus(event),
      ...(coverageAssertions?.has(event) ? { assertionFailure: true } : {}),
      file: caseFile,
      line,
      column,
      skip,
      todo,
      error: failureError(error),
      durationMs,
    };
  });
  // A skipped describe() never registers its tests, so only its suite event shows the skip.
  evidence.skippedSuites = terminalEvents
    .filter(
      ({ type, data }) =>
        type === "test:pass" &&
        data.testType === "suite" &&
        data.skip !== undefined &&
        data.name !== absolutePath,
    )
    .map(({ data }) => ({ name: data.name, source: suiteSource(root, data) }));
}

export function validateExpectedTests(
  path: string,
  expectedTests: readonly string[],
  tests: readonly unknown[],
  issues: Issue[],
): void {
  if (expectedTests.length === 0) {
    return;
  }
  const statusByName = new Map<string, TestStatus | "invalid">();
  for (const testCase of tests) {
    if (!isObject(testCase) || typeof testCase.name !== "string") {
      issues.push(
        issue("invalid-test-evidence", "test evidence contains an invalid case entry", {
          file: path,
        }),
      );
      return;
    }
    const previousStatus = statusByName.get(testCase.name);
    // A pass cannot erase a non-passing occurrence of the same required name.
    if (previousStatus === undefined || previousStatus === "passed") {
      const { status } = testCase;
      statusByName.set(
        testCase.name,
        status === "passed" || status === "failed" || status === "skipped" || status === "todo"
          ? status
          : "invalid",
      );
    }
  }
  for (const name of expectedTests) {
    const status = statusByName.get(name);
    if (status === undefined) {
      issues.push(
        issue("missing-expected-test", `expected test did not run: ${name}`, {
          file: path,
          name,
        }),
      );
    } else if (status !== "passed") {
      issues.push(
        issue("expected-test-not-passed", `expected test did not pass: ${name}`, {
          file: path,
          name,
          status,
        }),
      );
    }
  }
}
