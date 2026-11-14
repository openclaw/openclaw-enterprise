import { readFile, writeFile } from "node:fs/promises";

import {
  redactFailureDetail,
  redactLogLine,
  redactOutputLines,
  type RedactionSecrets,
} from "./failure-redaction.ts";
import { isObject } from "./runner-inputs.ts";

// The private reporter emits projected fields. JSON syntax alone does not establish
// their types. Read each field where its consumer uses it, including on primitives.
export function reporterField(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  const target: object = Object(value);
  return Reflect.get(target, key, value);
}

export function optionalReporterField(value: unknown, key: string): unknown {
  return value == null ? undefined : reporterField(value, key);
}

// The job log and results keep 600 characters of a failure; the lane's
// diagnostics report keeps the whole redacted message, stack and output tail.
const maxFailureDetailFiles = 8;
const maxFailureDetailTests = 20;
const failureOutputLineChars = 1_000;
const writtenFailureDetails = new Set<string>();
export const failureDetailFiles: ReadonlySet<string> = writtenFailureDetails;

// The reporter sends the tail as one batch, or after an interruption as batches
// newest first, each counting the lines before it; a cut can lose the oldest.
function outputTailLines(events: readonly unknown[]) {
  const batches: { lines: string[]; omitted: number }[] = [];
  for (const event of events) {
    if (reporterField(event, "type") !== "test:output") {
      continue;
    }
    const data = reporterField(event, "data");
    const rawLines = optionalReporterField(data, "lines");
    if (!Array.isArray(rawLines)) {
      continue;
    }
    const entries: readonly unknown[] = rawLines;
    const lines = entries.filter((line): line is string => typeof line === "string");
    const omitted = reporterField(data, "omitted");
    batches.push({
      lines,
      omitted:
        typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted >= 0 ? omitted : 0,
    });
  }
  batches.sort((a, b) => a.omitted - b.omitted);
  return {
    lines: batches.flatMap((batch) => batch.lines),
    omitted: batches[0]?.omitted ?? 0,
  };
}

function testName(name: unknown, absolutePath: string, secrets: RedactionSecrets) {
  return name === absolutePath ? "(file)" : redactLogLine(String(name), secrets, 200);
}

export function failureDetails(
  events: readonly unknown[],
  absolutePath: string,
  secrets: RedactionSecrets,
  root: string,
) {
  const failed = events.filter(
    (event) =>
      reporterField(event, "type") === "test:fail" &&
      optionalReporterField(reporterField(event, "data"), "error"),
  );
  const output = outputTailLines(events);
  // Tests a runner timeout interrupted, without the file itself.
  const interrupted = events.find((event) => reporterField(event, "type") === "test:interrupted");
  const interruptedData = optionalReporterField(interrupted, "data");
  const running = optionalReporterField(interruptedData, "running") ?? [];
  if (!Array.isArray(running)) {
    throw new TypeError("Reporter interrupted test list is not an array");
  }
  const interruptedTests: { name: string; line: number | undefined }[] = [];
  const runningTests: readonly unknown[] = running;
  for (const test of runningTests) {
    const name = optionalReporterField(test, "name");
    if (typeof name === "string" && name !== absolutePath) {
      const line = reporterField(test, "line");
      interruptedTests.push({
        name: testName(name, absolutePath, secrets),
        line: typeof line === "number" && Number.isSafeInteger(line) ? line : undefined,
      });
    }
  }
  if (failed.length === 0 && output.lines.length === 0 && interruptedTests.length === 0) {
    return undefined;
  }
  return {
    ...(interruptedTests.length > 0 ? { interruptedTests } : {}),
    tests: failed.slice(0, maxFailureDetailTests).map((event) => {
      const data = reporterField(event, "data");
      const error = reporterField(data, "error");
      return {
        name: testName(reporterField(data, "name"), absolutePath, secrets),
        line:
          optionalReporterField(reporterField(error, "location"), "line") ??
          reporterField(data, "line"),
        ...redactFailureDetail(error, secrets, root),
      };
    }),
    omittedTests: Math.max(0, failed.length - maxFailureDetailTests),
    output: {
      lines: redactOutputLines(output.lines, secrets, root, failureOutputLineChars),
      omittedLines: output.omitted,
    },
  };
}

type FailureDetails = NonNullable<ReturnType<typeof failureDetails>>;
type FailureReportEntry =
  | {
      reason: "prepare";
      error: { name: string; message?: string | undefined; stack?: string | undefined };
    }
  | ({ reason: "failed" } & FailureDetails)
  | ({
      reason: "timeout";
      timeoutMs: number;
      laneDeadline?: true;
      elapsedMs: number | undefined;
    } & FailureDetails);

// Shares the diagnostics file with the k3d capture; keep it out of other setup.
export async function recordFailure(
  setup: (step: () => Promise<void>) => Promise<void>,
  statePath: string,
  lane: string,
  file: string,
  details: FailureReportEntry,
  preparationId: string,
) {
  await setup(async () => {
    const diagnosticsPath = `${statePath}.diagnostics.json`;
    let report: Record<string, unknown> = { lane, preparationId };
    try {
      const previous: unknown = JSON.parse(await readFile(diagnosticsPath, "utf8"));
      if (
        isObject(previous) &&
        previous.lane === lane &&
        previous.preparationId === preparationId
      ) {
        report = previous;
      }
    } catch {
      // The first failed file (or passing k3d file) starts the report.
    }
    const failures = report.failures ?? [];
    if (Number(reporterField(failures, "length")) >= maxFailureDetailFiles) {
      const omitted = report.omittedFailureFiles ?? 0;
      report.omittedFailureFiles =
        typeof omitted === "object" || typeof omitted === "string"
          ? String(omitted) + "1"
          : Number(omitted) + 1;
    } else {
      if (!Array.isArray(failures) && typeof failures !== "string") {
        throw new TypeError("Previous diagnostic failures are not iterable");
      }
      const previousFailures: readonly unknown[] | string = failures;
      report.failures = [
        ...previousFailures,
        { file, capturedAt: new Date().toISOString(), ...details },
      ];
    }
    await writeFile(diagnosticsPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    writtenFailureDetails.add(diagnosticsPath);
  }).catch(() => {
    console.error(`[run:${lane}] failure details unavailable for ${file}`);
  });
}
