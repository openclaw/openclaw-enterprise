import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { isObject } from "../../scripts/ci/runner-inputs.ts";
import {
  createRunnerFixture as fixture,
  heldClock,
  killRecordedProcessGroupMembers,
  laneArgs,
  procStat,
  runnerArtifactPaths,
  runnerEnv,
  runRunnerAsync,
  runRunnerSync,
  unkilled,
  waitFor,
  writeRunnerLaneFiles,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.ts");
const timeoutSecret = /secretauthvalue|abcdefghijklmnop0123/u;

function jsonObject(value: unknown, field: string) {
  assert.ok(isObject(value), `Expected an object for ${field}`);
  return value;
}

function objectList(value: unknown, field: string) {
  assert.ok(Array.isArray(value), `Expected an array for ${field}`);
  const entries: readonly unknown[] = value;
  return entries.map((entry) => jsonObject(entry, field));
}

function readResult(text: string) {
  const parsed: unknown = JSON.parse(text);
  const result = jsonObject(parsed, "runner result");
  const { status } = result;
  assert.ok(status === "passed" || status === "failed");
  const issues = objectList(result.issues, "runner issues").map(({ code, file }) => {
    assert.ok(typeof code === "string");
    assert.ok(file === undefined || typeof file === "string");
    return { code, file };
  });
  return { status, issues, files: objectList(result.files, "file results") };
}

function timeoutRecord(text: string) {
  const parsed: unknown = JSON.parse(text);
  const report = jsonObject(parsed, "diagnostics report");
  const [record] = objectList(report.failures, "diagnostic failures");
  assert.ok(record);
  const { reason, file, timeoutMs, elapsedMs } = record;
  assert.equal(reason, "timeout");
  assert.ok(typeof file === "string");
  assert.ok(typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(typeof elapsedMs === "number" && Number.isFinite(elapsedMs));
  return {
    file,
    timeoutMs,
    elapsedMs,
    output: record.output,
    interruptedTests: record.interruptedTests,
  };
}

function diagnosticOutput(value: unknown) {
  const { lines, omittedLines } = jsonObject(value, "diagnostic output");
  assert.ok(Array.isArray(lines));
  const entries: readonly unknown[] = lines;
  assert.ok(entries.every((line) => typeof line === "string"));
  assert.ok(
    typeof omittedLines === "number" && Number.isSafeInteger(omittedLines) && omittedLines >= 0,
  );
  return { lines: entries, omittedLines };
}

function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

function readProcessReceipt(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const { runner, pgid, grandchild, file, grandchildPgid } = jsonObject(parsed, "process receipt");
  assert.ok(isProcessId(runner));
  assert.equal(pgid, runner);
  assert.ok(isProcessId(grandchild));
  assert.ok(file === undefined || isProcessId(file));
  assert.ok(grandchildPgid === undefined || grandchildPgid === runner);
  assert.notEqual(pgid, procStat(process.pid)?.pgid);
  return { runner, pgid: runner, grandchild, file, grandchildPgid };
}

async function processFixture(t: TestContext, lane: string) {
  const receipt: { path?: string } = {};
  // Read the atomic receipt before the fixture directory is removed, even if an
  // assertion failed before the test could read it. Signal only recorded members.
  t.after(() => {
    const pids = receipt.path === undefined ? undefined : readProcessReceipt(receipt.path);
    if (pids) {
      killRecordedProcessGroupMembers(pids.pgid, [
        pids.file === undefined ? undefined : pids.runner,
        pids.file,
        pids.grandchild,
      ]);
    }
  });
  const root = await fixture(t);
  const recordPath = join(root, "state", `${lane}-pids.json`);
  receipt.path = recordPath;
  return { root, recordPath, ...runnerArtifactPaths(root, lane) };
}

test("run records timeout cancellation without leaking child output", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/timeout.json");

  await writeSingleFileRunnerLane(
    root,
    "timeout",
    "tests/integration/timeout.test.mjs",
    [
      'import test from "node:test";',
      'test("hangs past the lane timeout", async () => {',
      '  console.error("secretauthvalue-timeout");',
      "  await new Promise((resolve) => setTimeout(resolve, 10_000));",
      "});",
      "",
    ].join("\n"),
  );

  const result = runRunnerSync(laneArgs(root, "timeout", "state/timeout.jsonl", resultsPath), {
    CI_RUNNER_TEST_TIMEOUT_MS: "100",
  });

  assert.equal(result.status, 1);
  const text = await readFile(resultsPath, "utf8");
  assert.doesNotMatch([result.stdout, result.stderr, text].join("\n"), timeoutSecret);
  const summary = readResult(text);
  assert.equal(summary.files[0]?.nodeExitCode, 1);
  assert(summary.issues.some((entry) => entry.code === "test-timeout"));
  // A timeout always leaves a record, even before the test printed anything.
  const report = await readFile(join(root, "state/timeout.jsonl.diagnostics.json"), "utf8");
  assert.doesNotMatch(report, timeoutSecret);
  const record = timeoutRecord(report);
  assert.equal(record.timeoutMs, 100);
});

test(
  "run kills what a passing file left in its process group",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const { root, statePath, resultsPath, recordPath } = await processFixture(t, "leftover");
    // The file passes and exits; its grandchild, unref'd, would run on for a minute.
    await writeSingleFileRunnerLane(
      root,
      "leftover",
      "tests/integration/leftover.test.mjs",
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync, renameSync, writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes and leaves a process behind", () => {',
        '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
        "  grandchild.unref();",
        '  const pgid = Number(readFileSync(`/proc/${grandchild.pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
        "  const record = process.env.CI_RUNNER_ORPHAN_RECORD;",
        "  writeFileSync(`${record}.partial`, JSON.stringify({ runner: process.ppid, grandchild: grandchild.pid, pgid }));",
        "  renameSync(`${record}.partial`, record);",
        "});",
        "",
      ].join("\n"),
    );

    const result = runRunnerSync(laneArgs(root, "leftover", statePath, resultsPath), {
      CI_RUNNER_ORPHAN_RECORD: recordPath,
    });

    assert.equal(result.status, 0, result.stderr);
    const pids = readProcessReceipt(recordPath);
    assert.ok(pids, "expected the fixture process receipt");
    assert.deepEqual(unkilled([pids.grandchild], pids.pgid), []);
  },
);

const forwardedSignals = [
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
] as const satisfies readonly NodeJS.Signals[];
for (const signal of forwardedSignals) {
  test(
    `run kills every live test group on ${signal} and exits by that signal`,
    { skip: process.platform !== "linux" && "reads /proc" },
    async (t) => {
      const { root, statePath, resultsPath, recordPath } = await processFixture(t, "hang");
      // The isolated test-file child ignores the signal and has a child of its own, so
      // only the forwarded SIGKILL to the Node test runner's group can end them.
      await writeSingleFileRunnerLane(
        root,
        "hang",
        "tests/integration/hang.test.mjs",
        [
          'import { spawn } from "node:child_process";',
          'import { readFileSync, renameSync, writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs with the signal ignored", async () => {',
          `  process.on(${JSON.stringify(signal)}, () => {});`,
          '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });',
          '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
          "  const record = process.env.CI_RUNNER_ORPHAN_RECORD;",
          "  writeFileSync(`${record}.partial`, JSON.stringify({",
          "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
          "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
          "  }));",
          "  renameSync(`${record}.partial`, record);",
          "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
          "});",
          "",
        ].join("\n"),
      );

      // Detached, so the signal reaches only run-tests.ts, never this test's group.
      const ciRunner = spawn(
        process.execPath,
        [runnerPath, ...laneArgs(root, "hang", statePath, resultsPath)],
        {
          cwd: repositoryRoot,
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: runnerEnv({
            CI_RUNNER_TEST_TIMEOUT_MS: "30000",
            CI_RUNNER_ORPHAN_RECORD: recordPath,
          }),
        },
      );
      let stderr = "";
      ciRunner.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const exited = new Promise<typeof exit>((resolveExit) => {
        ciRunner.on("exit", (code, exitSignal) => {
          exit = { code, signal: exitSignal };
          resolveExit(exit);
        });
        ciRunner.on("error", (error) => {
          stderr += String(error);
          exit = { code: null, signal: null };
          resolveExit(exit);
        });
      });

      const pid = ciRunner.pid;
      assert.ok(isProcessId(pid), "expected a detached CI runner PID");
      try {
        const recorded = await waitFor(
          () => readProcessReceipt(recordPath) ?? (exit === undefined ? undefined : "exited"),
          30_000,
        );
        assert.ok(
          recorded && recorded !== "exited",
          `no test file started (${recorded}): ${stderr}`,
        );
        const { pgid, runner, file, grandchild, grandchildPgid } = recorded;
        assert.ok(file !== undefined);
        assert.equal(grandchildPgid, runner);
        assert.notEqual(pgid, pid);

        process.kill(pid, signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            exited,
            new Promise<"still running">((resolveTimeout) => {
              timer = setTimeout(resolveTimeout, 10_000, "still running");
            }),
          ]);
          assert.deepEqual(outcome, { code: null, signal }, stderr);
        } finally {
          clearTimeout(timer);
        }
        // The runner queued SIGKILL before it exited. The kernel can finish reaping later.
        assert.deepEqual(unkilled([runner, file, grandchild], pgid), []);
      } finally {
        // Let the runner stop its groups first. They may not have published their receipts yet.
        for (const lastResort of ["SIGTERM", "SIGKILL"] as const) {
          if (exit !== undefined) {
            break;
          }
          ciRunner.kill(lastResort);
          await waitFor(() => exit !== undefined, 2_000);
        }
      }
    },
  );
}

test("run reports a cleanup that fails once a cancelled job's shell is gone as cancelled", async (t) => {
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "cancelled");
  // GitHub cancels a step by signalling and then killing its shell, never this runner, which
  // finishes as an orphan beside the job's own cleanup step. The second file's cleanup kills
  // the runner's parent, as the cancellation kills the shell, and then fails, as the racing
  // cleanup step makes it.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `export async function prepareFile({ file }) {
  if (file.path.endsWith('plain.test.mjs')) {
    return { cleanup: async () => { throw new Error('secretauthvalue cleanup'); } };
  }
  return {
    cleanup: async () => {
      const shell = process.ppid;
      process.kill(shell, 'SIGKILL');
      const deadline = Date.now() + 10_000;
      while (process.ppid === shell && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Object.assign(new Error('secretauthvalue cluster already removed'), { code: 'ENOENT' });
    },
  };
}
`,
  );
  await writeRunnerLaneFiles(
    root,
    "cancel",
    ["plain", "cancelled"],
    'import test from "node:test";\ntest("runs", () => {});\n',
  );

  // A parent process stands in for the step's shell: it waits for the runner until the second
  // file's cleanup kills it. No shell parses any of these arguments. The timeout only stops a
  // hang: a loaded host can take over 30 s to run both files, and the shell must die by the
  // cleanup's SIGKILL, not this SIGTERM.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" });',
      process.execPath,
      runnerPath,
      ...laneArgs(root, "cancel", statePath, resultsPath),
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: runnerEnv(), timeout: 120_000 },
  );

  assert.equal(result.signal, "SIGKILL", result.stderr);
  const text = await readFile(resultsPath, "utf8");
  const summary = readResult(text);
  assert.equal(summary.status, "failed");
  // A cleanup that fails while the job runs is still a cleanup failure.
  assert.deepEqual(summary.files[0]?.cleanup, { status: "failed", error: { name: "Error" } });
  // The cancelled record keeps the error's name and code, never its message.
  assert.deepEqual(summary.files[1]?.cleanup, {
    status: "cancelled",
    error: { name: "Error", code: "ENOENT" },
  });
  assert.deepEqual(
    summary.issues.map(({ code, file }) => [code, file]),
    [
      ["cleanup-failed", "tests/integration/plain.test.mjs"],
      ["cleanup-cancelled", "tests/integration/cancelled.test.mjs"],
    ],
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${text}`, /secretauthvalue/);
});

// The held-clock cases use independent fixtures and run their real timeout waits in parallel.
describe("tests that wait out real runner limits, side by side", { concurrency: true }, () => {
  test(
    "run kills a timed-out file's whole process group after the timeout record",
    { skip: process.platform !== "linux" && "reads /proc" },
    async (t) => {
      const { root, statePath, resultsPath, recordPath } = await processFixture(t, "orphan");
      const waiting = join(root, "state/orphan-waiting");
      // The isolated test-file child ignores SIGTERM and has a child of its own, so the
      // Node test runner's own SIGTERM handling cannot end either of them.
      await writeSingleFileRunnerLane(
        root,
        "orphan",
        "tests/integration/orphan.test.mjs",
        [
          'import { spawn } from "node:child_process";',
          'import { readFileSync, renameSync, writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("outlives its runner", async () => {',
          '  process.on("SIGTERM", () => {});',
          '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
          '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
          "  const record = process.env.CI_RUNNER_ORPHAN_RECORD;",
          "  writeFileSync(`${record}.partial`, JSON.stringify({",
          "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
          "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
          "  }));",
          "  renameSync(`${record}.partial`, record);",
          '  console.log("waiting with SIGTERM ignored");',
          `  writeFileSync(${JSON.stringify(waiting)}, "");`,
          "  await new Promise((resolve) => setTimeout(resolve, 60_000));",
          "});",
          "",
        ].join("\n"),
      );

      // The runner's clock stands still from the start until the file has recorded its pids and
      // printed its line, so its timeout comes five seconds after that however long the host takes
      // to get there.
      const started = Date.now();
      const result = await runRunnerAsync(
        laneArgs(root, "orphan", statePath, resultsPath),
        { CI_RUNNER_TEST_TIMEOUT_MS: "5000", CI_RUNNER_ORPHAN_RECORD: recordPath },
        { timeout: 60_000, execArgv: heldClock(started, [waiting]) },
      );

      assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
      assert.equal(result.status, 1, result.stderr);
      const pids = readProcessReceipt(recordPath);
      assert.ok(pids, "expected the fixture process receipt");
      // The timeout record still comes from the runner's reporter before the group dies.
      const record = timeoutRecord(await readFile(`${statePath}.diagnostics.json`, "utf8"));
      assert.equal(record.timeoutMs, 5000);
      assert.deepEqual(record.interruptedTests, [{ name: "outlives its runner", line: 4 }]);
      assert.deepEqual(diagnosticOutput(record.output).lines, [
        "stdout: waiting with SIGTERM ignored",
      ]);
      assert.ok(pids.file !== undefined);
      assert.equal(pids.grandchildPgid, pids.runner);
      const summary = readResult(await readFile(resultsPath, "utf8"));
      assert.equal(summary.files[0]?.processGroupId, pids.pgid);
      // The runner queued SIGKILL before it exited. The kernel can finish reaping later.
      assert.deepEqual(unkilled([pids.file, pids.grandchild], pids.pgid), []);
    },
  );

  test("run records a timed-out file's interrupted test and output tail in the diagnostics report", async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hang");
    // Holds when the file printed its last line.
    const printed = join(root, "state/hang-printed");
    await writeFile(
      join(root, "tests/integration/hang.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs", async () => {',
        "  for (let index = 0; index < 500; index += 1) {",
        '    console.log(`bulk ${index} ${"v".repeat(2_000)}`);',
        "  }",
        "  console.log(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
        '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
        '  console.log("waiting for a reply that never comes");',
        `  writeFileSync(${JSON.stringify(printed)}, String(Date.now()));`,
        "  // Ends by itself in case the runner leaves it behind.",
        "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
        "});",
        "",
      ].join("\n"),
    );
    // Node can exit mid-line after the interruption; the test runner process here
    // always does, and the runner must skip that cut line.
    const cutAtExit = join(root, "scripts/ci/cut-at-exit.cjs");
    await writeFile(
      cutAtExit,
      'if (process.execArgv.includes("--test")) process.on("exit", () => require("node:fs").writeSync(1, \'{"type":"test:output","data":{"lines":["cut\'));\n',
    );
    await writeRunnerManifest(root, {
      lanes: {
        hang: {
          env: { NODE_OPTIONS: `--require=${cutAtExit}` },
          files: [{ path: "tests/integration/hang.test.mjs" }],
        },
      },
    });

    // The runner's clock stands still from the start until the file has printed everything, so its
    // timeout comes five seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "hang", statePath, resultsPath),
      { CI_RUNNER_TEST_TIMEOUT_MS: "5000" },
      { timeout: 60_000, execArgv: heldClock(started, [printed]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const results = await readFile(resultsPath, "utf8");
    const summary = readResult(results);
    assert(summary.issues.some((entry) => entry.code === "test-timeout"));
    const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
    assert.doesNotMatch([result.stdout, result.stderr, results, text].join("\n"), timeoutSecret);
    const record = timeoutRecord(text);
    assert.equal(record.file, "tests/integration/hang.test.mjs");
    assert.equal(record.timeoutMs, 5000);
    // The file ran at least its timeout, and the timeout (with its 5 s grace) ended it well before
    // its own 30 s wait did. The held clock stood still until the last line, and the runner
    // records real time, so that bound counts from then.
    const sincePrinted = Number(await readFile(printed, "utf8")) - started;
    assert(
      record.elapsedMs >= 5000 && record.elapsedMs < sincePrinted + 15_000,
      `${record.elapsedMs} ms, last line ${sincePrinted} ms in`,
    );
    assert.deepEqual(record.interruptedTests, [{ name: "hangs", line: 4 }]);
    // Up to the last 400 of 503 lines, newest last, with the usual redaction. Node
    // exits soon after the interruption, so on a slow host only the newest batches
    // arrive; the rest are counted.
    const { lines, omittedLines } = diagnosticOutput(record.output);
    assert(lines.length >= 10 && lines.length <= 400, String(lines.length));
    assert.equal(lines.length + omittedLines, 503);
    assert.deepEqual(lines.slice(-3), [
      "stdout: credential [env:CI_RUNNER_FIXTURE_CREDENTIAL]",
      "[redacted credential-bearing line]",
      "stdout: waiting for a reply that never comes",
    ]);
    const bulk = lines.slice(0, -3);
    assert.deepEqual(
      bulk.map((line) => line.match(/^stdout: bulk (\d+) v+\.\.\. \[truncated\]$/u)?.[1]),
      bulk.map((_, index) => String(500 - bulk.length + index)),
    );
  });
});
