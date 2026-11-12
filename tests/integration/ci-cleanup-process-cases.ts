import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { writeCommand } from "../helpers/fake-commands.ts";
import { waitFor } from "../helpers/wait-for.mjs";

type ImageState = {
  version: number;
  repositoryRoot: string;
  prefix: string;
  resources: { id: string; kind: string; owner: string; name: string }[];
};

type ProcessCaseInputs = {
  repositoryRoot: string;
  cleanupPath: string;
  fixture: (t: TestContext) => Promise<string>;
  writeState: (path: string, state: ImageState) => Promise<void>;
  runCleanup: (statePath: string, env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
};

async function readJson(path: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return value;
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

// The process state letter of `pid` ("S", "Z", ...), or "" when no such process exists.
// On Linux it reads /proc/<pid>/stat: forking ps from a loaded runner took over a second
// and failed the observation (finding 2942), while the fixture process had already ended.
// Other errors (an unreadable /proc, a ps failure) still fail the caller.
function processState(pid: number) {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT", "ESRCH")) {
        return "";
      }
      throw error;
    }
    // Field 3, after the parenthesized command name, which may itself contain ") ".
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0];
    assert.ok(typeof state === "string", `could not observe process ${pid}`);
    return state;
  }
  const observation = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(observation.error, undefined, `could not observe process ${pid}`);
  const state = observation.stdout.trim();
  if (observation.status === 1 && state === "" && observation.stderr.trim() === "") {
    return "";
  }
  assert.equal(observation.status, 0, `process ${pid} observation failed`);
  return state;
}

async function commandTreeFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ci-cleanup-descendant-"));
  await mkdir(join(root, "bin"));
  const descendantPidPath = join(root, "descendant.pid");
  const pidPaths = [descendantPidPath];
  // Observe the exact process created by this wrapper before removing its
  // files. A zombie has terminated but awaits its host parent's reap. Never
  // signal a PID that may have been reused; an unexpected live PID fails.
  async function waitForTermination(timeoutMs: number, pidPath = descendantPidPath) {
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 1);
    const status = await waitFor(
      `fixture descendant ${pid} to stop running`,
      () => {
        const state = processState(pid);
        return state === "" || /^Z/.test(state) ? state : undefined;
      },
      { timeoutMs, intervalMs: 50 },
    );
    t.diagnostic(`fixture process ${pid}: ${status === "" ? "absent" : "terminated (zombie)"}`);
  }
  t.after(async () => {
    for (const path of pidPaths) {
      await waitForTermination(7000, path);
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    descendantPidPath,
    waitForTermination,
    trackPid: (path: string) => pidPaths.push(path),
  };
}

function waitForFile(path: string) {
  return waitFor(
    path,
    () =>
      readFile(path, "utf8").catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      }),
    { timeoutMs: 5000, intervalMs: 25 },
  );
}

// A cleanup whose only resource is an owned image tag; its removal is a container engine
// command under cleanup's command budget.
function imageTagState(repositoryRoot: string) {
  const prefix = "openclaw-ci-local-hungimage1234567890";
  return {
    version: 1,
    repositoryRoot,
    prefix,
    resources: [
      {
        id: "image-1",
        kind: "image-tag",
        owner: prefix,
        name: "localhost/openclaw-ci-image-hung:local",
      },
    ],
  };
}

export function registerInheritedOutputCases({
  repositoryRoot,
  writeState,
  runCleanup,
}: ProcessCaseInputs) {
  for (const stream of ["stdout", "stderr"]) {
    test(
      `cleanup drains inherited ${stream} before reporting a command failure`,
      {
        skip: process.platform === "win32" && "POSIX executable fixture",
      },
      async (t) => {
        const { root, descendantPidPath } = await commandTreeFixture(t);
        // The wrapper exits before its descendant writes the diagnostic. Waiting
        // only for exit loses the reason even though the pipes close within budget.
        await writeCommand(
          join(root, "bin"),
          "docker",
          `      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => process.${stream}.write("late cleanup failure detail"), 100)`)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      process.exit(23);
    `,
          { interpreter: "node" },
        );
        const prefix = "openclaw-ci-local-output1234567890";
        const statePath = join(root, "state.json");
        const state = {
          version: 1,
          repositoryRoot,
          prefix,
          resources: [
            {
              id: "image-1",
              kind: "image-tag",
              owner: prefix,
              name: "localhost/openclaw-ci-image-output:local",
            },
          ],
        };
        await writeState(statePath, state);
        const result = runCleanup(statePath, { OCC_DOCKER_BIN: join(root, "bin/docker") });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /failed: late cleanup failure detail/);
        assert.deepEqual(await readJson(statePath), state);
      },
    );
  }
}

export function registerInheritedPipeCases({
  repositoryRoot,
  cleanupPath,
  writeState,
}: ProcessCaseInputs) {
  // These are real command trees behind the supported container-binary override. The
  // wrapper and descendant do no container work; the descendant inherits both output
  // pipes and ignores TERM. Its finite lifetime also bounds a failed regression run.
  // Cleanup must leave the escaped descendant running, so the test releases it once it
  // has been observed alive instead of waiting out that lifetime in teardown. The hung
  // command is an image removal: database drops connect to the server directly (the case
  // above bounds those).
  for (const scenario of [
    "exit-before-timeout",
    "exit-on-term",
    "ignore-term",
    "close-on-term",
    "escaped-group",
  ]) {
    test(
      `cleanup bounds inherited pipes and retains a failed image removal: ${scenario}`,
      {
        skip: process.platform === "win32" && "POSIX process groups and executable fixtures",
      },
      async (t) => {
        const { root, descendantPidPath, waitForTermination } = await commandTreeFixture(t);
        const heartbeat = join(root, "heartbeat");
        const release = join(root, "release");
        const descendantPath = join(root, "descendant.cjs");
        await writeFile(
          descendantPath,
          `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        if (${JSON.stringify(scenario)} === "close-on-term") {
          fs.closeSync(1);
          fs.closeSync(2);
        }
      });
      let ticks = 0;
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
        fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks));
      }, 50);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, "0");
      process.send("ready");
      process.disconnect();
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 4000);
    `,
        );
        await writeCommand(
          join(root, "bin"),
          "docker",
          `      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      if (process.argv.slice(2, 4).join(" ") !== "image rm") throw new Error("expected image removal");
      process.on("SIGTERM", () => {
        if (["exit-on-term", "close-on-term"].includes(${JSON.stringify(scenario)})) process.exit(0);
      });
      const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: ${scenario === "escaped-group"},
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      descendant.once("message", () => {
        if (["exit-before-timeout", "escaped-group"].includes(${JSON.stringify(scenario)})) process.exit(0);
      });
    `,
          { interpreter: "node" },
        );
        const statePath = join(root, "state.json");
        const state = imageTagState(repositoryRoot);
        await writeState(statePath, state);

        // Apply the short command budget only to the hung removal. A separate test checks
        // that cleanup continues to Compose down after a deterministic failure.
        // The deadline starts at fork, but the supervisor, wrapper and descendant are
        // Node processes that handle TERM only once booted. Under CPU pressure a TERM
        // during startup killed the descendant before its first heartbeat (finding
        // 1652). The driver starts the removal's deadline once the heartbeat exists, when
        // every process in the tree has its TERM handler, and records that start.
        const budgetStartPath = join(root, "budget-start");
        const drop = `import { existsSync, writeFileSync } from "node:fs";
        import { cleanupResourceIds } from ${JSON.stringify(pathToFileURL(cleanupPath).href)};
        const [statePath, readyPath, budgetStartPath] = process.argv.slice(1);
        const budgetMs = Number(process.env.OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS);
        const setTimer = globalThis.setTimeout;
        let deadline;
        let ready = false;
        globalThis.setTimeout = (callback, ms, ...args) => {
          if (deadline || ms !== budgetMs) return setTimer(callback, ms, ...args);
          deadline = setTimer(() => ready && callback(...args), ms);
          const poll = setInterval(check, 10);
          poll.unref();
          function check() {
            if (ready || !existsSync(readyPath)) return;
            ready = true;
            clearInterval(poll);
            writeFileSync(budgetStartPath, String(Date.now()));
            deadline.refresh();
          }
          check();
          return deadline;
        };
        process.on("exit", () => {
          if (!ready) {
            process.stderr.write(deadline ? "fixture never became ready\\n" : "no command deadline\\n");
            process.exitCode = 2;
          }
        });
        await cleanupResourceIds(statePath, ["image-1"]);`;
        const started = Date.now();
        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", drop, statePath, heartbeat, budgetStartPath],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              OCC_DOCKER_BIN: join(root, "bin/docker"),
              OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "500",
              OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "200",
            },
            timeout: 6000,
            killSignal: "SIGKILL",
          },
        );
        assert.equal(result.error, undefined, "cleanup waited for the inherited pipes");
        assert.equal(result.status, 1, result.stderr);
        const budgetStart = Number(await readFile(budgetStartPath, "utf8"));
        const elapsed = Date.now() - budgetStart;
        t.diagnostic(`command tree ready after ${budgetStart - started} ms`);
        t.diagnostic(`cleanup command completed ${elapsed} ms after its deadline started`);
        assert.ok(elapsed < 2500, "cleanup exceeded the command and pipe deadlines");
        assert.match(
          result.stderr,
          /Cleanup failed for image-tag:localhost\/openclaw-ci-image-hung:local:.* image rm .* timed out after 500 ms/,
        );
        assert.deepEqual(await readJson(statePath), state);
        // PID state, not heartbeat timing, is the evidence: a heartbeat can stall under
        // CPU pressure, and the descendant's own four-second expiry runs from its boot.
        if (scenario === "escaped-group") {
          // A separate group is outside the executor's signalling authority. Cleanup
          // must end without killing that process.
          const pid = Number(await readFile(descendantPidPath, "utf8"));
          let state: string;
          try {
            state = processState(pid);
          } finally {
            // Released only after the observation, so a cleanup that waited for the
            // descendant's pipes still waits out its four-second lifetime and fails the
            // elapsed-time assertion above.
            await writeFile(release, "");
          }
          assert.notEqual(state, "", "escaped descendant stopped during cleanup");
          assert.doesNotMatch(state, /^Z/, "escaped descendant stopped during cleanup");
        } else {
          // Every owned kill path fires before the driver exits; the limit only covers
          // observing the reaped or zombie process.
          await waitForTermination(1000);
        }
      },
    );
  }
}

export function registerCommandOwnershipCases({
  repositoryRoot,
  cleanupPath,
  fixture,
  writeState,
  runCleanup,
}: ProcessCaseInputs) {
  for (const scenario of [
    "cli-SIGTERM",
    "cli-SIGINT",
    "runner-SIGTERM",
    "runner-SIGINT",
    "runner-timeout",
    "runner-file-exit",
    "runner-cleanup-exit",
    "fixture-exit",
    "natural-exit",
  ]) {
    test(
      `cleanup command ownership survives ${scenario}`,
      {
        skip: process.platform === "win32" && "POSIX command ownership",
      },
      async (t) => {
        const { root, descendantPidPath, waitForTermination, trackPid } =
          await commandTreeFixture(t);
        const heartbeat = join(root, "heartbeat");
        const supervisorPidPath = join(root, "supervisor.pid");
        const wrapperPidPath = join(root, "wrapper.pid");
        trackPid(supervisorPidPath);
        trackPid(wrapperPidPath);
        const descendantPath = join(root, "descendant.cjs");
        // The command exits before cancellation; its TERM/INT-ignoring descendant
        // retains pipes unless testing natural completion. It self-expires even on
        // the broken implementation; teardown observes its PID without signalling it.
        await writeFile(
          descendantPath,
          `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      let ticks = 0;
      const timer = setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 50);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, "0");
      process.send("ready");
      process.disconnect();
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 6000);
    `,
        );
        await writeCommand(
          join(root, "bin"),
          "docker",
          `      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      fs.writeFileSync(${JSON.stringify(supervisorPidPath)}, String(process.ppid));
      fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
      const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
        stdio: ["ignore", ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, "ipc"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      descendant.once("message", () => process.exit(0));
    `,
          { interpreter: "node" },
        );
        const prefix = "openclaw-ci-local-cancellation123456";
        const statePath = join(root, "state.json");
        const state = {
          version: 1,
          repositoryRoot,
          prefix,
          resources: [
            {
              id: "image-1",
              kind: "image-tag",
              owner: prefix,
              name: "localhost/openclaw-ci-image-cancellation:local",
            },
          ],
        };
        await writeState(statePath, state);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          OCC_DOCKER_BIN: join(root, "bin/docker"),
          OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "15000",
          OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "100",
          CI_RUNNER_DEADLINE_MS: "",
          CI_RUNNER_TEST_TIMEOUT_MS: scenario === "runner-timeout" ? "1500" : "15000",
          CI_RUNNER_TIMEOUT_GRACE_MS: "100",
          CI_RUNNER_CLEANUP_TIMEOUT_MS: "1500",
          GIT_CEILING_DIRECTORIES: tmpdir(),
        };
        delete env.NODE_TEST_CONTEXT;
        delete env.NODE_ENV;
        let args = [cleanupPath, "--state", statePath];
        const resultsPath = join(root, "results.json");
        if (scenario.startsWith("runner-") || scenario === "fixture-exit") {
          await mkdir(join(root, "tests/integration"), { recursive: true });
          const testPath = join(root, "tests/integration/cleanup.test.mjs");
          const cleanupImport = JSON.stringify(pathToFileURL(cleanupPath).href);
          const fixtureImport = JSON.stringify(
            new URL("../helpers/postgres-worker-revision-fixture.mjs", import.meta.url).href,
          );
          const body =
            scenario === "fixture-exit"
              ? `import { createWorkerRevisionFixtures, disposeStep } from ${fixtureImport};
           // A shorter exit grace than the fixture's 2 s: this file has one test to report.
           const { cleanup } = createWorkerRevisionFixtures(import.meta.url, { exitGraceMs: 500 });
           after(cleanup);
           test("abandons cleanup", async () => {
             await assert.rejects(disposeStep("cleanup command", 500, () => cleanupState(${JSON.stringify(statePath)})), /did not finish within 500 ms/);
             console.log("fixture cleanup abandoned");
           });`
              : scenario === "runner-cleanup-exit"
                ? 'test("finishes before cleanup", () => {});'
                : `test("owns cleanup", async () => {
             const operation = cleanupState(${JSON.stringify(statePath)});
             ${
               scenario === "runner-file-exit"
                 ? `
               while (!existsSync(${JSON.stringify(heartbeat)})) await delay(25);
               process.exit(23);`
                 : "await operation;"
             }
           });`;
          await writeFile(
            testPath,
            `
        import assert from "node:assert/strict";
        import test, { after } from "node:test";
        import { existsSync } from "node:fs";
        import { setTimeout as delay } from "node:timers/promises";
        import { cleanupState } from ${cleanupImport};
        ${body}
      `,
          );
          if (scenario === "fixture-exit") {
            args = ["--test", testPath];
          } else {
            if (scenario === "runner-cleanup-exit") {
              await mkdir(join(root, "scripts/ci"), { recursive: true });
              await writeFile(
                join(root, "scripts/ci/prepare.mjs"),
                `
              import { cleanupState } from ${cleanupImport};
              export async function prepareFile() {
                return { cleanup: () => cleanupState(${JSON.stringify(statePath)}) };
              }
            `,
              );
            }
            await writeFile(
              join(root, "manifest.json"),
              JSON.stringify({
                version: 1,
                lanes: { cleanup: { files: [{ path: "tests/integration/cleanup.test.mjs" }] } },
                groups: { ci: ["cleanup"] },
              }),
            );
            args = [
              join(repositoryRoot, "scripts/ci/run-tests.mjs"),
              "run",
              "cleanup",
              "--root",
              root,
              "--manifest",
              "manifest.json",
              "--state",
              join(root, "runner-state.json"),
              "--results",
              resultsPath,
            ];
          }
        }
        const owner = spawn(process.execPath, args, {
          cwd: repositoryRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        owner.stdout.on("data", (chunk: Buffer) => {
          output += chunk;
        });
        owner.stderr.on("data", (chunk: Buffer) => {
          output += chunk;
        });
        const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolvePromise, reject) => {
            owner.once("error", reject);
            owner.once("close", (code, signal) => resolvePromise({ code, signal }));
          },
        );
        // A finite fixture bounds failed assertions too. Join the exact owner before
        // its temporary files are removed; no cleanup signal can mask the assertion.
        t.after(async () => {
          await completion;
        });
        await waitForFile(heartbeat);
        const signal = scenario.endsWith("SIGTERM")
          ? "SIGTERM"
          : scenario.endsWith("SIGINT")
            ? "SIGINT"
            : undefined;
        if (signal) {
          owner.kill(signal);
        }
        const outcome = await completion;
        if (signal) {
          assert.deepEqual(outcome, { code: null, signal }, output);
        } else if (scenario.startsWith("runner-")) {
          assert.equal(outcome.code, 1, output);
          const summary = await readJson(resultsPath);
          assert.ok(
            typeof summary === "object" &&
              summary !== null &&
              "status" in summary &&
              "issues" in summary,
          );
          assert.ok(Array.isArray(summary.issues));
          const issues: unknown[] = summary.issues;
          const hasIssue = (code: string) =>
            issues.some(
              (issue) =>
                typeof issue === "object" &&
                issue !== null &&
                "code" in issue &&
                issue.code === code,
            );
          assert.equal(summary.status, "failed");
          if (scenario === "runner-timeout") {
            assert.ok(hasIssue("test-timeout"));
          }
          if (scenario === "runner-cleanup-exit") {
            assert.ok(hasIssue("cleanup-timeout"));
          }
        } else {
          assert.equal(outcome.code, 0, output);
          if (scenario === "fixture-exit") {
            assert.match(output, /fixture cleanup abandoned/);
          }
        }
        // Assert termination well before the six-second self-expiry. A heartbeat
        // alone can stall under scheduling pressure; the PID must also be terminal.
        await waitForTermination(1000);
        await waitForTermination(1000, supervisorPidPath);
        await waitForTermination(1000, wrapperPidPath);
        const ticks = await readFile(heartbeat, "utf8");
        await delay(200);
        assert.equal(await readFile(heartbeat, "utf8"), ticks, "command outlived its owner");
        if (scenario === "natural-exit") {
          await assert.rejects(stat(statePath), { code: "ENOENT" });
        } else {
          assert.deepEqual(await readJson(statePath), state);
        }
      },
    );
  }

  test("cleanup preserves command spawn diagnostics and failed resource state", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-spawn123456";
    const statePath = join(root, "state.json");
    const state = {
      version: 1,
      repositoryRoot,
      prefix,
      resources: [
        {
          id: "image-1",
          kind: "image-tag",
          owner: prefix,
          name: "localhost/openclaw-ci-image-spawn:local",
        },
      ],
    };
    await writeState(statePath, state);
    const result = runCleanup(statePath, { OCC_DOCKER_BIN: join(root, "missing-command") });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /spawn .*missing-command ENOENT/);
    assert.deepEqual(await readJson(statePath), state);
  });
}
