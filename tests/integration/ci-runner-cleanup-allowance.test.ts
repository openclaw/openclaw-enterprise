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
  writeRunnerLaneFiles,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { createCleanupProcessTree } from "./ci-runner-cleanup-process-tree.ts";

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
    path: string;
    status: string;
    counts: { passed: number; total: number };
    issues: RunnerIssue[];
    cleanup?: { status: string };
  }[];
}

// Cleanup runs inside the runner. An interval keeps the fixture alive unless the runner
// stops waiting when the cleanup allowance expires.
const hangForever = "new Promise(() => setInterval(() => {}, 1_000))";

const passingLaneFixture = 'import test from "node:test";\ntest("runs", () => {});\n';

describe("runner cleanup allowances", { concurrency: true }, () => {
  test("run gives up on a hung cleanup after its allowance, ends its commands and starts no later file", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-cleanup");
    const cleaned = join(root, "state/later-cleaned");
    // The command forks a second descendant after the runner lists /proc but before it kills.
    const processTree = await createCleanupProcessTree(t, root);
    await writeFile(
      join(root, "scripts/ci/prepare.ts"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFile, writeFile } from "node:fs/promises";',
        'import { setTimeout as delay } from "node:timers/promises";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        "    return {",
        "      cleanup: async () => {",
        `        spawn(process.execPath, [${JSON.stringify(processTree.commandPath)}], { stdio: "ignore" });`,
        // Hang only once both pids are on record.
        `        while (!(await readFile(${JSON.stringify(processTree.pidsPath)}, "utf8").catch(() => ""))) {`,
        "          await delay(20);",
        "        }",
        `        return ${hangForever};`,
        "      },",
        "    };",
        "  }",
        '  return { cleanup: () => writeFile(process.env.CI_RUNNER_CLEANUP_MARKER, "") };',
        "}",
        "",
      ].join("\n"),
    );
    await writeRunnerLaneFiles(root, "cleanup", ["hung", "later"], passingLaneFixture);

    // The runner's clock stands still from the start until the command and its descendant are on
    // record, so the cleanup's allowance ends two seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "cleanup", statePath, resultsPath),
      { CI_RUNNER_CLEANUP_TIMEOUT_MS: "2000", CI_RUNNER_CLEANUP_MARKER: cleaned },
      {
        timeout: 60_000,
        execArgv: [...heldClock(started, [processTree.pidsPath]), ...processTree.execArgv],
      },
    );

    assert.equal(result.error, undefined, `the runner gave up on the cleanup: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    assert.ok(hung && later);
    // Its tests passed; only the cleanup failed it.
    assert.equal(hung.counts.passed, 1);
    assert.equal(hung.status, "failed");
    assert.deepEqual(hung.cleanup, { status: "timeout", timeoutMs: 2000 });
    assert.deepEqual(
      hung.issues.map(({ code, step, message }) => ({ code, step, message })),
      [
        {
          code: "cleanup-timeout",
          step: "cleanup",
          message: "cleanup did not finish within 2000 ms: tests/integration/hung.test.mjs",
        },
      ],
    );
    // The abandoned cleanup may still hold the CI state lock, so the next file never starts.
    assert.deepEqual(
      later.issues.map(({ code, file }) => ({ code, file })),
      [{ code: "setup-abandoned", file: "tests/integration/later.test.mjs" }],
    );
    assert.equal(later.counts.total, 0);
    await assert.rejects(readFile(cleaned), { code: "ENOENT" });
    // The runner ended the abandoned cleanup's command and its descendants before it exited, so
    // none is left running as an orphan (finding 1225), not even the one the command started
    // after the runner had listed its processes (finding 2182).
    await processTree.assertExited();
  });

  test("run ends the cleanups of files the deadline stopped together one allowance past it", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-cleanups");
    const files = ["one", "two", "three", "four"].map(
      (name) => `tests/integration/${name}.test.mjs`,
    );
    await writeFile(
      join(root, "scripts/ci/prepare.ts"),
      `export async function prepareFile() {\n  return { cleanup: () => ${hangForever} };\n}\n`,
    );
    const hung = files.map((file) => join(root, `state/${file.split("/").at(-1)}-hung`));
    for (const [index, file] of files.entries()) {
      await writeFile(
        join(root, file),
        [
          'import { writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs", () => {',
          `  writeFileSync(${JSON.stringify(hung[index])}, "");`,
          `  return ${hangForever};`,
          "});",
          "",
        ].join("\n"),
      );
    }
    await writeRunnerManifest(root, {
      lanes: {
        together: {
          fileConcurrency: 4,
          parallelFiles: files,
          files: files.map((path) => ({ path })),
        },
      },
    });

    // The runner's clock stops a second in until all four files hang, so the deadline stops
    // them together however long the host takes to start them.
    const allowanceMs = 5_000;
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "together", statePath, resultsPath),
      {
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_CLEANUP_TIMEOUT_MS: String(allowanceMs),
        CI_RUNNER_FILE_CONCURRENCY: "4",
      },
      { timeout: 60_000, execArgv: heldClock(started + 1_000, hung) },
    );

    assert.equal(result.error, undefined, `the runner gave up on the cleanups: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.deepEqual(
      summary.files.map((file) => [file.path, file.cleanup?.status]),
      files.map((file) => [file, "timeout"]),
    );
    // Cleanups run one at a time. One allowance each would end 20 s past the deadline; the window
    // they share closes one allowance past it. The first to start gets what is left of the window
    // and is still running when it closes, so the queued ones never start. (On a busy host the
    // window can close before the first one starts too.)
    const timeouts = summary.issues.filter((entry) => entry.code === "cleanup-timeout");
    assert.equal(timeouts.length, files.length);
    const ran = timeouts.filter(
      (entry) => !/window after the lane deadline closed/.test(entry.message),
    );
    assert(ran.length <= 1, JSON.stringify(timeouts));
    // It starts after its file stops, past the deadline, so it gets less than a full allowance.
    for (const entry of ran) {
      assert(
        typeof entry.timeoutMs === "number" && entry.timeoutMs < allowanceMs,
        JSON.stringify(entry),
      );
    }
  });
});
