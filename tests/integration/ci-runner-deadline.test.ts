import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  createRunnerFixture,
  heldClock,
  laneArgs,
  runnerArtifactPaths,
  runRunnerAsync,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

interface RunnerIssue {
  code: string;
  file?: string;
  message: string;
  step?: string;
  timeoutMs?: number;
}

interface RunnerSummary {
  issues: RunnerIssue[];
  files: {
    status: string;
    counts: { total: number };
    issues: RunnerIssue[];
    nodeExitCode: number | null;
    cleanup: unknown;
  }[];
}

interface TimeoutDiagnostics {
  failures: {
    elapsedMs: number;
    reason: string;
    laneDeadline?: boolean;
    timeoutMs: number;
    interruptedTests?: { name: string; line: number }[];
  }[];
}

// Each case has its own fixture root. Run their real-time waits concurrently.
describe("tests that wait out real runner limits, side by side", { concurrency: true }, () => {
  test("run records a timeout that came before any test started", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "stuck");
    await writeSingleFileRunnerLane(
      root,
      "stuck",
      "tests/integration/stuck.test.mjs",
      'import test from "node:test";\nawait new Promise((resolve) => setTimeout(resolve, 30_000));\ntest("never registered", () => {});\n',
    );

    const result = await runRunnerAsync(laneArgs(root, "stuck", statePath, resultsPath), {
      CI_RUNNER_TEST_TIMEOUT_MS: "2000",
    });

    assert.equal(result.status, 1);
    const diagnostics: TimeoutDiagnostics = JSON.parse(
      await readFile(`${statePath}.diagnostics.json`, "utf8"),
    );
    const [record] = diagnostics.failures;
    assert.ok(record);
    assert.deepEqual(
      { ...record, capturedAt: undefined, elapsedMs: undefined },
      {
        file: "tests/integration/stuck.test.mjs",
        capturedAt: undefined,
        reason: "timeout",
        timeoutMs: 2000,
        elapsedMs: undefined,
        tests: [],
        omittedTests: 0,
        output: { lines: [], omittedLines: 0 },
      },
    );
    assert(record.elapsedMs >= 2000, String(record.elapsedMs));
  });

  // Finding 1209: a file hung in its teardown for 22 minutes, past the job's 25-minute timeout,
  // under the 60-minute per-file timeout. GitHub cancelled the job, so the results file was never
  // written and nothing named the test. The lane deadline stops the file first and names it.
  test("run stops a hung file at the lane deadline, names its test and starts nothing after it", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "deadline");
    const marker = join(root, "state/later-started");
    const hung = join(root, "state/teardown-hung");
    await writeFile(
      join(root, "tests/integration/teardown.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs in its teardown", async (t) => {',
        "  // Like a worker stop that never returns; the interval keeps the file alive.",
        "  t.after(() => {",
        `    writeFileSync(${JSON.stringify(hung)}, "");`,
        "    return new Promise(() => setInterval(() => {}, 1_000));",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "tests/integration/later.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("would start past the deadline", () => writeFileSync(process.env.CI_RUNNER_MARKER, ""));',
        "",
      ].join("\n"),
    );
    await writeRunnerManifest(root, {
      lanes: {
        deadline: {
          files: [
            { path: "tests/integration/teardown.test.mjs" },
            { path: "tests/integration/later.test.mjs" },
          ],
        },
      },
    });

    // The runner's clock stops a second in until the file hangs in its teardown, so the deadline
    // comes at least two seconds after that, however long the host takes to get there.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "deadline", statePath, resultsPath),
      // No per-file timeout: the default (60 minutes) is far past the deadline.
      {
        CI_RUNNER_TEST_TIMEOUT_MS: "",
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_MARKER: marker,
      },
      // Without the deadline the runner would wait out the 60-minute default.
      { timeout: 60_000, execArgv: heldClock(started + 1_000, [hung]) },
    );

    assert.equal(result.error, undefined, `the deadline stopped the lane: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [teardown, later] = summary.files;
    assert.ok(teardown && later);
    assert.equal(teardown.status, "failed");
    const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
    assert.ok(timeout);
    assert.equal(timeout.file, "tests/integration/teardown.test.mjs");
    assert.match(timeout.message, /cut to the lane deadline/);
    assert.match(timeout.message, /while running "hangs in its teardown"$/);
    // The job log names it too, not only the diagnostics artifact.
    assert.match(
      result.stderr,
      /run-tests: issue test-timeout tests\/integration\/teardown\.test\.mjs: .* while running "hangs in its teardown"\n/,
    );
    const diagnostics: TimeoutDiagnostics = JSON.parse(
      await readFile(`${statePath}.diagnostics.json`, "utf8"),
    );
    const [record] = diagnostics.failures;
    assert.ok(record);
    assert.equal(record.reason, "timeout");
    assert.equal(record.laneDeadline, true);
    assert(record.timeoutMs >= 2_000 && record.timeoutMs <= 3_000, String(record.timeoutMs));
    assert.deepEqual(record.interruptedTests, [{ name: "hangs in its teardown", line: 4 }]);
    // The serial file behind it never started.
    assert.equal(later.status, "failed");
    assert.equal(later.counts.total, 0);
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });

  test("run starts no file with under a second left before the lane deadline", async (t) => {
    // Finding 1215: a file whose turn came within a second of the deadline was started and
    // stopped at once, then reported as selected-zero and a test-timeout naming no test.
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "near-deadline");
    const marker = join(root, "state/started");
    // The preparation returns half a second before the deadline.
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        "export async function prepareFile() {",
        "  const left = Number(process.env.CI_RUNNER_DEADLINE_MS) - Date.now();",
        "  await new Promise((resolve) => setTimeout(resolve, left - 500));",
        "  return {};",
        "}",
        "",
      ].join("\n"),
    );
    await writeSingleFileRunnerLane(
      root,
      "near",
      "tests/integration/late.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'writeFileSync(process.env.CI_RUNNER_MARKER, "");',
        'test("starts too late", () => new Promise((resolve) => setTimeout(resolve, 5_000)));',
        "",
      ].join("\n"),
    );

    const result = await runRunnerAsync(
      laneArgs(root, "near", statePath, resultsPath),
      { CI_RUNNER_DEADLINE_MS: String(Date.now() + 5_000), CI_RUNNER_MARKER: marker },
      { timeout: 30_000 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [late] = summary.files;
    assert.ok(late);
    // A loaded host can run the preparation into the deadline instead; either way, nothing starts.
    const codes = late.issues.map((entry) => entry.code);
    assert.deepEqual(
      codes,
      codes.includes("prepare-timeout") ? ["prepare-timeout"] : ["lane-deadline"],
    );
    assert.equal(late.nodeExitCode, null);
    assert.equal(late.counts.total, 0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });

  test("a runner timeout while no test was running says so", async (t) => {
    // Finding 1215: a file stopped in a hook or teardown named no test, which read like a
    // reporting gap rather than where it hung.
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hook");
    const inHook = join(root, "state/in-hook");
    await writeSingleFileRunnerLane(
      root,
      "hook",
      "tests/integration/hook.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import test, { after } from "node:test";',
        'test("passes", () => {});',
        "after(() => {",
        `  writeFileSync(${JSON.stringify(inHook)}, "");`,
        "  // Ends by itself in case the runner leaves it behind.",
        "  return new Promise((resolve) => setTimeout(resolve, 30_000));",
        "});",
        "",
      ].join("\n"),
    );

    // The runner's clock stands still from the start until "passes" is done and the hook has
    // started, so the timeout comes three seconds after that however long the host takes to get
    // there. The hook outlasts it.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "hook", statePath, resultsPath),
      { CI_RUNNER_TEST_TIMEOUT_MS: "3000" },
      { timeout: 60_000, execArgv: heldClock(started, [inHook]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
    assert.ok(timeout);
    assert.equal(
      timeout.message,
      "selected file exceeded the runner timeout (3000 ms): tests/integration/hook.test.mjs; no test was running (stopped in a hook, teardown or top-level code)",
    );
  });

  // The preparation runs in the runner itself. The interval keeps it alive unless the
  // lane deadline stops it and records which file was being prepared.
  test("run gives up on a preparation still running at the lane deadline and names it", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-prepare");
    const preparing = join(root, "state/preparing");
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        `    writeFileSync(${JSON.stringify(preparing)}, "");`,
        "    await new Promise(() => setInterval(() => {}, 1_000));",
        "  }",
        "  return {};",
        "}",
        "",
      ].join("\n"),
    );
    const source = 'import test from "node:test";\ntest("runs", () => {});\n';
    const files = ["hung", "later"].map((name) => ({ path: `tests/integration/${name}.test.mjs` }));
    for (const { path } of files) {
      await writeFile(join(root, path), source);
    }
    await writeRunnerManifest(root, { lanes: { prepare: { files } } });

    // The runner's clock stands still from the start until the preparation has started, so the
    // deadline comes three seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "prepare", statePath, resultsPath),
      { CI_RUNNER_DEADLINE_MS: String(started + 3_000) },
      // Without a limit the preparation would hold the runner forever.
      { timeout: 60_000, execArgv: heldClock(started, [preparing]) },
    );

    assert.equal(
      result.error,
      undefined,
      `the runner gave up on the preparation: ${result.stderr}`,
    );
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    assert.ok(hung && later);
    assert.deepEqual(
      hung.issues.map(({ code, file, step }) => ({ code, file, step })),
      [{ code: "prepare-timeout", file: "tests/integration/hung.test.mjs", step: "prepare" }],
    );
    // Its limit is what was left before the deadline when it started: all of it, as the clock
    // stood still.
    assert.equal(hung.issues[0]?.timeoutMs, 3_000);
    // Its tests never started. What the preparation made is left to the job's Cleanup lane step.
    assert.equal(hung.nodeExitCode, null);
    assert.equal(hung.counts.total, 0);
    assert.equal(hung.cleanup, null);
    // The file behind it starts nothing past the deadline.
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    assert.match(
      result.stderr,
      /run-tests: issue prepare-timeout tests\/integration\/hung\.test\.mjs: prepareFile did not finish within \d+ ms, cut to the lane deadline/,
    );
  });
});
