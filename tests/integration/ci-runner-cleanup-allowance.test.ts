import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  createRunnerFixture,
  heldClock,
  laneArgs,
  procStat,
  runnerArtifactPaths,
  runRunnerAsync,
  writeRunnerManifest,
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
    path: string;
    status: string;
    counts: { passed: number; total: number };
    issues: RunnerIssue[];
    cleanup?: { status: string };
  }[];
}

// Node arguments that hold the runner just after it lists /proc, the first time it ends its
// descendants, until the `forked` path exists. It creates the `window` path when
// the hold starts (tests/helpers/ci-runner-kill-window.ts, finding 2182).
function killWindow(window: string, forked: string) {
  const preload = new URL("../helpers/ci-runner-kill-window.ts", import.meta.url);
  preload.searchParams.set("window", window);
  preload.searchParams.set("forked", forked);
  return ["--import", preload.href];
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
    // The hung cleanup waits for a command that started one of its own (as `docker compose`
    // or `pnpm` would). Both record their pids, in one rename.
    const pidsPath = join(root, "state/command-pids");
    // The command starts another child while the runner is ending it: after the runner has listed
    // its processes and before it kills them (killWindow). That child records its pid too.
    const windowPath = join(root, "state/kill-window");
    const latePath = join(root, "state/late-pid");
    const commandPath = join(root, "command.cjs");
    const writeOnce = (path: string, value: string) =>
      `writeFileSync(${JSON.stringify(`${path}.partial`)}, ${value}); ` +
      `renameSync(${JSON.stringify(`${path}.partial`)}, ${JSON.stringify(path)});`;
    await writeFile(
      commandPath,
      [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, renameSync, writeFileSync } = require("node:fs");',
        'const forever = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {',
        '  stdio: "ignore",',
        "});",
        "const descendant = forever();",
        writeOnce(pidsPath, 'process.pid + "\\n" + descendant.pid + "\\n"'),
        "const poll = setInterval(() => {",
        `  if (existsSync(${JSON.stringify(windowPath)})) {`,
        "    clearInterval(poll);",
        `    ${writeOnce(latePath, 'forever().pid + "\\n"')}`,
        "  }",
        "}, 10);",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );
    const running = (pid: number) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A zombie (state Z) still answers kill(pid, 0), but it has exited.
      return procStat(pid)?.state !== "Z";
    };
    const pids: number[] = [];
    t.after(() => {
      for (const pid of pids.filter(running)) {
        process.kill(pid, "SIGKILL");
      }
    });
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFile, writeFile } from "node:fs/promises";',
        'import { setTimeout as delay } from "node:timers/promises";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        "    return {",
        "      cleanup: async () => {",
        `        spawn(process.execPath, [${JSON.stringify(commandPath)}], { stdio: "ignore" });`,
        // Hang only once both pids are on record.
        `        while (!(await readFile(${JSON.stringify(pidsPath)}, "utf8").catch(() => ""))) {`,
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
    const files = ["hung", "later"].map((name) => ({ path: `tests/integration/${name}.test.mjs` }));
    for (const { path } of files) {
      await writeFile(join(root, path), passingLaneFixture);
    }
    await writeRunnerManifest(root, { lanes: { cleanup: { files } } });

    // The runner's clock stands still from the start until the command and its descendant are on
    // record, so the cleanup's allowance ends two seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runRunnerAsync(
      laneArgs(root, "cleanup", statePath, resultsPath),
      { CI_RUNNER_CLEANUP_TIMEOUT_MS: "2000", CI_RUNNER_CLEANUP_MARKER: cleaned },
      {
        timeout: 60_000,
        execArgv: [...heldClock(started, [pidsPath]), ...killWindow(windowPath, latePath)],
      },
    );
    pids.push(...(await readFile(pidsPath, "utf8")).split("\n").filter(Boolean).map(Number));
    const late = Number(await readFile(latePath, "utf8").catch(() => ""));
    if (late > 1) {
      pids.push(late);
    }

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
    assert.equal(pids.length, 3, "the command recorded itself and both descendants");
    for (let attempt = 0; pids.some(running) && attempt < 50; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.deepEqual(
      pids.filter(running),
      [],
      "the abandoned cleanup's commands outlived the runner",
    );
  });

  test("run ends the cleanups of files the deadline stopped together one allowance past it", async (t) => {
    const root = await createRunnerFixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-cleanups");
    const files = ["one", "two", "three", "four"].map(
      (name) => `tests/integration/${name}.test.mjs`,
    );
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
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
