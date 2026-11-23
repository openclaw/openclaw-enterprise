import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createRunnerFixture,
  laneArgs,
  lifecycleReady,
  procStat,
  runnerEnv,
  runRunnerAsync,
  runRunnerSync,
  spawnLifecycleRunner,
  unkilled,
  waitFor,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.ts");

type FailurePhase = "prepare" | "run" | "cleanup";
type LifecycleFixtureOptions = {
  failure?: FailurePhase | null;
  hold?: boolean;
  descendant?: boolean;
  running?: boolean;
};

type PreparationProcess = { pid: number; pgid: number };
type DetachedProcess = PreparationProcess & { ppid: number; start: string };

function writeLifecycleManifest(
  root: string,
  file: { path: string; expectedTests?: readonly string[] },
) {
  return writeRunnerManifest(
    root,
    { lanes: { lifecycle: { files: [file] } } },
    "scripts/ci/test-suites.json",
  );
}

function fixturePaths(root: string) {
  const attempt = join(root, "attempt");
  return {
    state: join(attempt, "state.json"),
    results: join(attempt, "result.json"),
    trace: join(root, "trace.json"),
    owned: join(root, "owned.json"),
    ready: join(root, "ready.json"),
    release: join(root, "release.json"),
    child: join(root, "child.json"),
    cleanupObservation: join(root, "cleanupObservation.json"),
    preparedSecret: join(root, "preparedSecret.json"),
    cleanupSecret: join(root, "cleanupSecret.json"),
    cleanupCommand: join(root, "cleanupCommand.json"),
    engine: join(root, "engine.mjs"),
    running: join(root, "running.json"),
    attempt,
  };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function jsonObject(value: unknown, label: string) {
  assert.ok(isJsonObject(value), label);
  return value;
}

function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPreparationProcess(value: unknown): value is PreparationProcess {
  return isJsonObject(value) && isProcessId(value.pid) && value.pid > 1 && isProcessId(value.pgid);
}

function isDetachedProcess(value: unknown): value is DetachedProcess {
  return (
    isPreparationProcess(value) &&
    "ppid" in value &&
    isProcessId(value.ppid) &&
    "start" in value &&
    typeof value.start === "string" &&
    /^\d+$/u.test(value.start)
  );
}

// Read the artifact's structure here and assert the expected outcomes in each case.
function completeResult(text: string) {
  const result = jsonObject(parseJson(text), "expected a complete lifecycle result");
  const lifecycle = jsonObject(result.lifecycle, "expected a lifecycle receipt");
  const phases = jsonObject(lifecycle.phases, "expected lifecycle phases");
  const files = result.files;
  assert.ok(isJsonArray(files), "expected a result file list");
  return {
    scope: result.scope,
    testName: result.testName,
    counts: jsonObject(result.counts, "expected result counts"),
    files,
    lifecycle: {
      status: lifecycle.status,
      interrupted: lifecycle.interrupted,
      phases: {
        prepare: jsonObject(phases.prepare, "expected a prepare phase"),
        run: jsonObject(phases.run, "expected a run phase"),
        cleanup: jsonObject(phases.cleanup, "expected a cleanup phase"),
      },
    },
  };
}

function resultTestNames(file: unknown) {
  const tests = jsonObject(file, "expected the selected file result").tests;
  assert.ok(isJsonArray(tests), "expected a test result list");
  return tests.map((entry) => jsonObject(entry, "expected a test result").name);
}

// These programs own a small filesystem resource through the real lifecycle hooks.
// The runner under test controls phase isolation, ordering, cancellation and cleanup.
async function lifecycleFixture(
  t: TestContext,
  {
    failure = null,
    hold = false,
    descendant = false,
    running = false,
  }: LifecycleFixtureOptions = {},
) {
  const setup: { paths?: ReturnType<typeof fixturePaths> } = {};
  // Register before the temporary directory's removal, so records remain readable
  // if a failed assertion leaves one of this fixture's processes alive.
  t.after(async () => {
    const { paths } = setup;
    if (!paths) {
      return;
    }
    for (const path of [paths.ready, paths.child]) {
      const record = parseJson(await readFile(path, "utf8").catch(() => "null"));
      if (!isPreparationProcess(record)) {
        continue;
      }
      if (procStat(record.pid)?.pgid === record.pgid) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // The process finished between the ownership check and signal.
        }
      }
    }
  });
  const root = await createRunnerFixture(t);
  const paths = fixturePaths(root);
  setup.paths = paths;
  const shared = `const paths = ${JSON.stringify(paths)};`;
  await writeFile(
    paths.engine,
    [
      `#!${process.execPath}`,
      'import { readFileSync, writeFileSync } from "node:fs";',
      shared,
      "writeFileSync(paths.cleanupCommand, JSON.stringify(process.argv.slice(2)));",
      'const opaque = readFileSync(paths.cleanupSecret, "utf8");',
      "process.stdout.write(opaque);",
      "process.stderr.write(opaque);",
      "process.exitCode = 7;",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    [
      'import { spawn } from "node:child_process";',
      'import { randomBytes } from "node:crypto";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { appendFile, writeFile } from "node:fs/promises";',
      shared,
      'const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
      "export async function prepareLane({ statePath }) {",
      '  await appendFile(paths.trace, "prepare:start\\n");',
      `  const state = { version: 1, repositoryRoot: ${JSON.stringify(await realpath(repositoryRoot))}, lane: "lifecycle", prefix: "openclaw-ci-lifecycle", resources: [], fixture: "owned" };`,
      `  if (${JSON.stringify(failure)} === "cleanup") {`,
      '    const opaque = randomBytes(18).toString("hex");',
      "    await writeFile(paths.cleanupSecret, opaque);",
      '    state.resources.push({ id: "fixture-image", kind: "image-tag", owner: state.prefix, name: `localhost/openclaw-ci-image-${opaque}` });',
      "  }",
      `  if (${JSON.stringify(failure)} === "prepare") {`,
      '    state.env = { CI_RUNNER_PREPARED_SECRET: `prepared-${randomBytes(18).toString("hex")}` };',
      "    await writeFile(paths.preparedSecret, state.env.CI_RUNNER_PREPARED_SECRET);",
      "  }",
      "  await writeFile(statePath, JSON.stringify(state));",
      '  await writeFile(paths.owned, "owned resource");',
      `  if (${descendant}) {`,
      '    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });',
      "    await writeFile(paths.child, JSON.stringify({ pid: child.pid, pgid: pgid(child.pid) }));",
      "    child.unref();",
      "  }",
      "  await writeFile(paths.ready, JSON.stringify({ pid: process.pid, pgid: pgid(process.pid) }));",
      `  while (${hold} && !existsSync(paths.release)) {`,
      "    await new Promise((resolve) => setTimeout(resolve, 20));",
      "  }",
      `  if (${JSON.stringify(failure)} === "prepare") throw Object.assign(new Error([process.env.CI_RUNNER_FIXTURE_CREDENTIAL, state.env.CI_RUNNER_PREPARED_SECRET].join(" ")), { args: ["private-lifecycle-argument"], stdout: "private-lifecycle-stdout", stderr: "private-lifecycle-stderr" });`,
      '  await appendFile(paths.trace, "prepare:end\\n");',
      "  return { env: {} };",
      "}",
      "export async function prepareFile() { return { env: {} }; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "scripts/ci/cleanup.ts"),
    [
      'import { appendFile, readFile, rm, writeFile } from "node:fs/promises";',
      shared,
      "export async function cleanupState(statePath) {",
      '  await appendFile(paths.trace, "cleanup\\n");',
      `  if (${descendant}) {`,
      '    const child = JSON.parse(await readFile(paths.child, "utf8"));',
      '    const stat = await readFile(`/proc/${child.pid}/stat`, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; });',
      '    const live = stat !== null && !["Z", "X"].includes(stat.replace(/^.*\\) /su, "").split(" ")[0]);',
      "    await writeFile(paths.cleanupObservation, JSON.stringify({ live }));",
      "  }",
      `  if (${JSON.stringify(failure)} === "cleanup") {`,
      "    process.env.OCC_DOCKER_BIN = paths.engine;",
      `    const { cleanupState } = await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/cleanup.ts")).href)});`,
      "    return cleanupState(statePath);",
      "  }",
      "  await rm(paths.owned);",
      "  await rm(statePath);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/lifecycle.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { appendFile, rename, writeFile } from "node:fs/promises";',
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      shared,
      'test("owned lifecycle resource is usable", async () => {',
      "  // Private lifecycle IPC routing must not reach test subprocesses.",
      "  assert.equal(process.env.OPENCLAW_CI_COMPLETE_PHASE, undefined);",
      '  await appendFile(paths.trace, "run\\n");',
      `  if (${running}) {`,
      "    const processes = [];",
      "    let pid = process.pid;",
      `    while (pid > 1 && pid !== ${process.pid} && processes.length < 16) {`,
      '      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").trim().split(/\\s+/u);',
      "      processes.push({ pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] });",
      "      pid = Number(fields[1]);",
      "    }",
      "    await writeFile(`${paths.running}.partial`, JSON.stringify(processes));",
      "    await rename(`${paths.running}.partial`, paths.running);",
      "    await new Promise(() => setInterval(() => {}, 1_000));",
      "  }",
      `  assert.notEqual(${JSON.stringify(failure)}, "run", process.env.CI_RUNNER_FIXTURE_CREDENTIAL);`,
      "});",
      "",
    ].join("\n"),
  );
  await writeLifecycleManifest(root, { path: "tests/integration/lifecycle.test.mjs" });
  return {
    root,
    ...paths,
    args: [
      "run",
      "lifecycle",
      "--root",
      root,
      "--lifecycle",
      "complete",
      "--attempt",
      paths.attempt,
    ],
  };
}

function lifecycleProcess(pid: number) {
  const stat = procStat(pid);
  if (!stat) {
    return undefined;
  }
  const { state, pgid, start } = stat;
  return state === undefined || start === undefined ? undefined : { state, pgid, start };
}

function lifecycleProcessLive(record: DetachedProcess) {
  const current = lifecycleProcess(record.pid);
  return current?.start === record.start && !["Z", "X"].includes(current.state);
}

async function startLifecycleFixture(
  t: TestContext,
  options: LifecycleFixtureOptions,
  env: NodeJS.ProcessEnv = {},
) {
  const owned: {
    runner?: ReturnType<typeof spawnLifecycleRunner>;
    processes: readonly DetachedProcess[];
  } = { processes: [] };
  // Reap only observed fixture identities, before temporaryDirectory removes the
  // evidence. Assertions below check termination before this fallback can run.
  t.after(async () => {
    for (const record of owned.processes) {
      if (lifecycleProcessLive(record)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // The owned process finished after the identity check.
        }
      }
    }
    const { runner } = owned;
    if (runner && runner.exit() === undefined) {
      runner.child.kill("SIGKILL");
      await waitFor(() => runner.exit() !== undefined, 2_000);
    }
  });
  const fixture = await lifecycleFixture(t, options);
  const runner = spawnLifecycleRunner(
    [runnerPath, ...fixture.args],
    repositoryRoot,
    runnerEnv(env),
  );
  owned.runner = runner;
  return {
    ...fixture,
    ...runner,
    remember: (records: readonly DetachedProcess[]) => {
      owned.processes = records;
    },
  };
}

export function registerCompleteLifecycleCases() {
  test(
    "complete lifecycle preserves phase failures and performs owned cleanup",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      for (const failure of [null, "prepare", "run", "cleanup"] as const) {
        await t.test(failure === null ? "success" : `${failure} failure`, async (t) => {
          const fixture = await lifecycleFixture(t, { failure, descendant: failure === null });
          const result = await runRunnerAsync(fixture.args, {}, { timeout: 30_000 });
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.status, failure === null ? 0 : 1, result.stderr);
          const artifact = await readFile(fixture.results, "utf8");
          const summary = completeResult(artifact);
          const phases = summary.lifecycle.phases;
          assert.equal(phases.prepare.status, failure === "prepare" ? "failed" : "passed");
          const runStatuses: Partial<Record<FailurePhase, string>> = {
            prepare: "not-run",
            run: "failed",
          };
          assert.equal(
            phases.run.status,
            (failure === null ? undefined : runStatuses[failure]) ?? "passed",
          );
          assert.equal(phases.cleanup.status, failure === "cleanup" ? "failed" : "passed");
          assert.equal(phases.prepare.terminal, true);
          assert.equal(phases.cleanup.terminal, true);
          assert.equal(summary.lifecycle.interrupted, null);
          assert.equal(summary.lifecycle.status, failure === null ? "passed" : "failed");
          assert.doesNotMatch(
            result.stdout + result.stderr + artifact,
            /secretauthvalue|private-lifecycle-(?:argument|stdout|stderr)/,
          );
          if (failure === "prepare") {
            // This value did not exist in the parent environment: redaction must
            // include secrets created by preparation and persisted in state.env.
            const preparedSecret = await readFile(fixture.preparedSecret, "utf8");
            assert.equal(
              (result.stdout + result.stderr + artifact).includes(preparedSecret),
              false,
              "prepared state secret escaped into lifecycle diagnostics",
            );
          }
          const expected =
            failure === "prepare"
              ? ["prepare:start", "cleanup"]
              : ["prepare:start", "prepare:end", "run", "cleanup"];
          assert.deepEqual((await readFile(fixture.trace, "utf8")).trim().split("\n"), expected);
          if (failure === "cleanup") {
            const opaque = await readFile(fixture.cleanupSecret, "utf8");
            assert.equal((result.stdout + result.stderr + artifact).includes(opaque), false);
            assert.deepEqual(parseJson(await readFile(fixture.cleanupCommand, "utf8")), [
              "image",
              "rm",
              "-f",
              `localhost/openclaw-ci-image-${opaque}`,
            ]);
            assert.deepEqual(phases.cleanup.error, { code: "phase-failed" });
            assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
          } else {
            await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
            await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
          }
          if (failure !== "prepare") {
            assert.equal(summary.files.length, 1);
            assert.equal(summary.counts.failed, failure === "run" ? 1 : 0);
            assert.equal(summary.counts.passed, failure === "run" ? 0 : 1);
          }
          if (failure === null) {
            assert.equal(summary.lifecycle.status, "passed");
            // A child surviving preparation must be dead before cleanup touches its resource.
            assert.deepEqual(parseJson(await readFile(fixture.cleanupObservation, "utf8")), {
              live: false,
            });
            const child = parseJson(await readFile(fixture.child, "utf8"));
            assert.ok(isPreparationProcess(child), "invalid preparation child record");
            assert.deepEqual(unkilled([child.pid], child.pgid), []);
          }
        });
      }
      // Focused execution shares the lifecycle, including a receipt when
      // preparation fails before Node can report any selected case.
      for (const failure of [null, "prepare"] as const) {
        await t.test(
          failure === null ? "focused success" : "focused preparation failure",
          async (t) => {
            const fixture = await lifecycleFixture(t, { failure });
            const path = "tests/integration/lifecycle.test.mjs";
            const name = "owned lifecycle resource is usable";
            await writeFile(
              join(fixture.root, path),
              'test("unselected lifecycle case", () => { throw new Error("unselected case executed"); });\n',
              { flag: "a" },
            );
            await writeLifecycleManifest(fixture.root, {
              path,
              expectedTests: [name, "unselected lifecycle case"],
            });
            const result = await runRunnerAsync(
              [...fixture.args, "--file", path, "--test-name", name],
              {},
              { timeout: 30_000 },
            );
            assert.equal(result.error, undefined, result.stderr);
            assert.equal(result.status, failure === null ? 0 : 1, result.stderr);
            const summary = completeResult(await readFile(fixture.results, "utf8"));
            assert.equal(summary.scope, "focused");
            assert.equal(summary.testName, name);
            assert.equal(
              summary.lifecycle.phases.prepare.status,
              failure === null ? "passed" : "failed",
            );
            assert.equal(
              summary.lifecycle.phases.run.status,
              failure === null ? "passed" : "not-run",
            );
            assert.equal(summary.lifecycle.phases.cleanup.status, "passed");
            assert.equal(summary.counts.total, failure === null ? 1 : 0);
            if (failure === null) {
              assert.deepEqual(resultTestNames(summary.files[0]), [name]);
            }
            assert.deepEqual(
              (await readFile(fixture.trace, "utf8")).trim().split("\n"),
              failure === null
                ? ["prepare:start", "prepare:end", "run", "cleanup"]
                : ["prepare:start", "cleanup"],
            );
            await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
            await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
          },
        );
      }
      for (const mode of [
        "intact",
        "replaced after file cleanup observes loss",
        "missing before final cleanup",
        "no resources",
      ] as const) {
        await t.test(`cleanup journal: ${mode}`, async (t) => {
          const root = await createRunnerFixture(t);
          const { attempt, results, state } = fixturePaths(root);
          const lane = "checks-baseline-2";
          const file = "tests/integration/ci-runner.test.ts";
          const name = "verify the prepared journal";
          const replacement = mode === "replaced after file cleanup observes loss";
          const lostAfterFile = mode === "missing before final cleanup";
          const lost = replacement || lostAfterFile;
          const ownsChild = mode !== "no resources";
          const nextFile = "tests/integration/after-journal-loss.test.ts";
          const nextPreparation = join(root, "later-preparation");
          const files = [{ path: file, expectedTests: [name] }];
          if (replacement) {
            files.push({ path: nextFile, expectedTests: ["later file"] });
            await writeFile(
              join(root, nextFile),
              'import test from "node:test"; test("later file", () => {});',
            );
          }
          await writeRunnerManifest(
            root,
            { lanes: { [lane]: { files } } },
            "scripts/ci/test-suites.json",
          );

          // A child journal gives stock cleanup an obligation without a running service.
          const prep = JSON.stringify(join(repositoryRoot, "scripts/ci/prepare.ts"));
          const clean = JSON.stringify(join(repositoryRoot, "scripts/ci/cleanup.ts"));
          await writeFile(
            join(root, "scripts/ci/prepare.ts"),
            `
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareFile as stockFile, prepareLane as stockLane } from ${prep};

async function addChild(path: string, journal: { prefix: string }, prefix?: string) {
  const suffix = prefix ? "fedcba654321" : "123456789abc";
  const owner = prefix ?? journal.prefix;
  const id = "child-state-" + suffix;
  const name = owner + "-child-" + suffix;
  const child = join(dirname(path), name + ".json");
  await writeFile(child, JSON.stringify({
    ...journal, prefix: owner, lane: "postgres-auth", statePath: child, cleanupOwner: id, resources: [],
  }));
  await writeFile(path, JSON.stringify({
    ...journal, prefix: owner, resources: [{ kind: "child-state", id, name, owner }],
  }), { flag: prefix ? "wx" : "w" });
}
export async function prepareLane(options: Parameters<typeof stockLane>[0]) {
  const prepared = await stockLane(options);
  const path = options.statePath!;
  if (${ownsChild}) await addChild(path, JSON.parse(await readFile(path, "utf8")));
  return prepared;
}
export async function prepareFile(options: Parameters<typeof stockFile>[0]) {
  if (options.file.path === ${JSON.stringify(nextFile)}) await writeFile(${JSON.stringify(nextPreparation)}, "called");
  const prepared = await stockFile(options);
  return { ...prepared, async cleanup(limits: Parameters<typeof prepared.cleanup>[0]) {
    const path = options.statePath!;
    if (${replacement}) {
      const journal = JSON.parse(await readFile(path, "utf8"));
      await unlink(path);
      try { await prepared.cleanup(limits); }
      finally { await addChild(path, journal, "openclaw-ci-replacement"); }
    } else {
      await prepared.cleanup(limits);
      if (${lostAfterFile}) await rm(path, { force: true });
    }
  } };
}
`,
          );
          await writeFile(
            join(root, "scripts/ci/cleanup.ts"),
            `export { cleanupState } from ${clean};\n`,
          );
          await writeFile(
            join(root, file),
            `
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test(${JSON.stringify(name)}, async () => {
  const journal = JSON.parse(await readFile(${JSON.stringify(state)}, "utf8"));
  assert.equal(journal.resources.length, ${ownsChild ? 1 : 0});
});
`,
          );
          const result = await runRunnerAsync(
            ["run", lane, "--root", root, "--lifecycle", "complete", "--attempt", attempt],
            {},
            { timeout: 30_000 },
          );
          const summary = completeResult(await readFile(results, "utf8"));
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.status, lost ? 1 : 0, result.stderr);
          assert.equal(summary.counts.passed, 1);
          assert.equal(summary.lifecycle.status, lost ? "reconciliation-required" : "passed");
          const { phases } = summary.lifecycle;
          assert.equal(phases.prepare.status, "passed");
          assert.equal(phases.run.status, replacement ? "failed" : "passed");
          assert.equal(
            phases.cleanup.status,
            replacement ? "not-run" : lostAfterFile ? "failed" : "passed",
          );
          if (lost) {
            assert.deepEqual((replacement ? phases.run : phases.cleanup).error, {
              code: "cleanup-state-missing",
            });
            assert.match(result.stderr, /Expected cleanup journal is missing.*reconcil/iu);
          }
          assert.equal(
            (await readdir(attempt)).some((name) => name.endsWith("-child-123456789abc.json")),
            lost,
          );
          if (replacement) {
            assert.match(await readFile(state, "utf8"), /openclaw-ci-replacement/);
            await stat(join(attempt, "openclaw-ci-replacement-child-fedcba654321.json"));
            await assert.rejects(stat(nextPreparation), { code: "ENOENT" });
          } else {
            await assert.rejects(stat(state), { code: "ENOENT" });
          }
        });
      }
      await t.test("phase child keeps selection receipts and path refusal timing", async (t) => {
        const root = await createRunnerFixture(t);
        const manifestPath = join(root, "scripts/ci/test-suites.json");
        const file = "tests/integration/phase.test.mjs";
        const marker = join(root, "ran");
        const name = "selected phase case";
        await writeFile(
          join(root, file),
          `import { writeFile } from "node:fs/promises";
import test from "node:test";
test(${JSON.stringify(name)}, () => writeFile("ran", "ran"));
`,
        );
        await writeLifecycleManifest(root, { path: file, expectedTests: [name] });

        // Start the real phase child to exercise values the public CLI cannot serialize.
        // A bad selection must still publish its receipt. A bad result path is
        // reached only after the selected file runs.
        const cases = [
          { fields: { lane: null, file: 1, statePath: null }, issue: "missing-lane" },
          { fields: { file: null, testName: {} }, issue: "invalid-file-selection" },
          { fields: { testName: null }, issue: "invalid-test-selection" },
          { fields: { resultsPath: null }, issue: null },
        ];
        for (const [index, { fields, issue }] of cases.entries()) {
          const resultsPath = join(root, "results", `${index}.json`);
          const child = fork(runnerPath, ["__lifecycle-phase"], {
            cwd: root,
            env: runnerEnv({ OPENCLAW_CI_COMPLETE_PHASE: "1" }),
            detached: true,
            execArgv: [],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          let stderr = "";
          child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          let reply: Record<string, unknown> | undefined;
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolveExit, rejectExit) => {
              child.once("error", rejectExit);
              child.once("close", (code, signal) => resolveExit({ code, signal }));
            },
          );
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, 15_000);
          child.on("message", (message: unknown) => {
            if (isJsonObject(message) && message.type === "ci-lifecycle-result") {
              reply = message;
              child.send({ type: "ci-lifecycle-ack" });
            }
          });
          child.send({
            phase: "run",
            root,
            manifestPath,
            lane: "lifecycle",
            statePath: join(root, "state", "phase.json"),
            resultsPath,
            file,
            ...fields,
          });
          try {
            assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
          } finally {
            clearTimeout(timeout);
          }
          assert.equal(timedOut, false, stderr);
          assert.deepEqual(reply, {
            type: "ci-lifecycle-result",
            exitCode: 1,
            uncertain: false,
            ...(issue === null ? { error: { code: "phase-failed" } } : {}),
          });
          if (issue === null) {
            assert.match(stderr, /run-tests: passed tests\/integration\/phase\.test\.mjs/);
            assert.equal(await readFile(marker, "utf8"), "ran");
            await assert.rejects(readFile(resultsPath), { code: "ENOENT" });
          } else {
            const report = jsonObject(
              parseJson(await readFile(resultsPath, "utf8")),
              "run receipt",
            );
            assert.equal(report.sourceSha, runnerEnv().GITHUB_SHA);
            assert.deepEqual(report.files, []);
            assert.ok(isJsonArray(report.issues));
            assert.deepEqual(
              report.issues.map((entry) => jsonObject(entry, "selection issue").code),
              [issue],
            );
            assert.ok(stderr.includes(`run-tests: issue ${issue}`), stderr);
            await assert.rejects(readFile(marker), { code: "ENOENT" });
          }
        }
      });
    },
  );

  test(
    "complete lifecycle drains interrupted preparation before cleanup and never starts tests",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      const setup: {
        active?: { release: string; runner: ReturnType<typeof spawnLifecycleRunner> };
      } = {};
      // Release or stop the owned CLI before the fixture directory is removed.
      t.after(async () => {
        const { active } = setup;
        if (!active || active.runner.exit() !== undefined) {
          return;
        }
        const { release, runner } = active;
        await writeFile(release, "release");
        if (!(await waitFor(() => runner.exit() !== undefined, 2_000))) {
          runner.child.kill("SIGKILL");
          await waitFor(() => runner.exit() !== undefined, 2_000);
        }
      });
      const fixture = await lifecycleFixture(t, { hold: true });
      const runner = spawnLifecycleRunner(
        [runnerPath, ...fixture.args],
        repositoryRoot,
        runnerEnv({ CI_RUNNER_DEADLINE_MS: String(Date.now() + 30_000) }),
      );
      setup.active = { release: fixture.release, runner };
      assert.equal(
        await waitFor(() => lifecycleReady(fixture.ready), 15_000),
        true,
        runner.stderr(),
      );
      const pid = runner.child.pid;
      assert.ok(isProcessId(pid), "expected a lifecycle coordinator PID");
      process.kill(pid, "SIGTERM");
      // Release only after the real CLI acknowledges the signal; an arbitrary sleep
      // could let preparation finish before the cancellation latch is exercised.
      assert.equal(
        await waitFor(() => runner.stderr().includes("SIGTERM"), 5_000),
        true,
        runner.stderr(),
      );
      assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\n");
      await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
      await writeFile(fixture.release, "release");
      assert.ok(await waitFor(() => runner.exit() !== undefined, 10_000), runner.stderr());
      assert.deepEqual(runner.exit(), { code: 143, signal: null }, runner.stderr());
      const summary = completeResult(await readFile(fixture.results, "utf8"));
      assert.equal(summary.lifecycle.interrupted, "SIGTERM");
      assert.equal(summary.lifecycle.phases.prepare.status, "passed");
      assert.equal(summary.lifecycle.phases.run.status, "not-run");
      assert.equal(summary.lifecycle.phases.cleanup.status, "passed");
      assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\nprepare:end\ncleanup\n");
      await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
    },
  );

  test(
    "complete lifecycle retains owned state when preparation exceeds its deadline",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      const fixture = await lifecycleFixture(t, { hold: true });
      const result = await runRunnerAsync(
        fixture.args,
        { CI_RUNNER_DEADLINE_MS: String(Date.now() + 5_000) },
        { timeout: 30_000 },
      );
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      const summary = completeResult(await readFile(fixture.results, "utf8"));
      assert.equal(summary.lifecycle.status, "reconciliation-required");
      assert.equal(summary.lifecycle.phases.prepare.status, "timed-out");
      assert.equal(summary.lifecycle.phases.run.status, "not-run");
      assert.equal(summary.lifecycle.phases.cleanup.status, "not-run");
      assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\n");
      assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
      const state = jsonObject(
        parseJson(await readFile(fixture.state, "utf8")),
        "expected attempt state",
      );
      assert.equal(state.fixture, "owned");
    },
  );

  test(
    "complete lifecycle refuses invalid attempts and legacy output paths before starting phases",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      type Fixture = Awaited<ReturnType<typeof lifecycleFixture>>;
      type Scenario = [
        name: string,
        buildArgs: (fixture: Fixture) => string[],
        condition?: "existing" | "missing file" | "missing parent" | "duplicate",
      ];
      const file = "tests/integration/lifecycle.test.mjs";
      const registeredName = "owned lifecycle resource is usable";
      const separate = ["--test-name", registeredName];
      const equals = `--test-name=${registeredName}`;
      const selected =
        (...selectors: string[]) =>
        (fixture: Fixture) => [...fixture.args, "--file", file, ...selectors];
      const scenarios: Scenario[] = [
        ["existing attempt", ({ args }) => args, "existing"],
        ["missing selected file", ({ args }) => args, "missing file"],
        [
          "missing parent",
          ({ args, root }) => [...args.slice(0, -1), join(root, "missing", "attempt")],
          "missing parent",
        ],
        ["legacy state", ({ args, state }) => [...args, "--state", state]],
        ["legacy results", ({ args, results }) => [...args, "--results", results]],
        // The former result/ownership-marker collision must be refused before either write.
        [
          "legacy state/result alias",
          ({ args, state }) => [...args, "--state", state, "--results", `${state}.lifecycle-owner`],
        ],
        ["name without file", ({ args }) => [...args, "--test-name", "resource"]],
        ["missing name value", selected("--test-name")],
        ["name followed by option", ({ args }) => [...args, "--test-name", "--file", file]],
        ["empty equals name", selected("--test-name=")],
        ["duplicate separate then equals", selected(...separate, equals), "duplicate"],
        ["duplicate equals then separate", selected(equals, ...separate), "duplicate"],
        ["duplicate separate", selected(...separate, ...separate), "duplicate"],
        ["duplicate equals", selected(equals, equals), "duplicate"],
        ["duplicate empty then separate", selected("--test-name=", ...separate), "duplicate"],
        ["duplicate empty then equals", selected("--test-name=", equals), "duplicate"],
        ["unregistered name", selected("--test-name", "unregistered")],
        ["empty name", selected("--test-name", " ")],
        ["overlong name", selected("--test-name", "é".repeat(129))],
        ["reserved root name", selected("--test-name", "<root>")],
        [
          "reserved file name",
          ({ args, root }) => [...args, "--file", file, "--test-name", join(root, file)],
        ],
        [
          "name on audit",
          ({ args }) => ["audit", ...args.slice(2), "--file", file, "--test-name", "resource"],
        ],
        ["removed pattern option", selected("--test-name-pattern", "resource")],
        ["removed equals pattern option", selected("--test-name-pattern=resource")],
      ];
      for (const [label, buildArgs, condition] of scenarios) {
        await t.test(label, async (t) => {
          const fixture = await lifecycleFixture(t);
          const sentinel = "state belongs to an earlier owner\n";
          if (condition === "existing") {
            await mkdir(fixture.attempt);
            await writeFile(fixture.state, sentinel);
          } else if (condition === "missing file") {
            await rm(join(fixture.root, file));
          } else if (condition === "duplicate") {
            await writeLifecycleManifest(fixture.root, {
              path: file,
              expectedTests: [registeredName],
            });
          }
          const args = buildArgs(fixture);
          const result = await runRunnerAsync(args, {}, { timeout: 30_000 });
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.status, 1, result.stderr);
          if (condition === "duplicate") {
            // Reject during parsing, before preparation or creation of an owned attempt.
            assert.match(result.stderr, /--test-name may only be specified once/);
          }
          if (condition === "existing") {
            assert.equal(await readFile(fixture.state, "utf8"), sentinel);
          } else {
            await assert.rejects(stat(fixture.attempt), { code: "ENOENT" });
          }
          if (condition === "missing parent") {
            await assert.rejects(stat(join(fixture.root, "missing")), { code: "ENOENT" });
          }
          await assert.rejects(readFile(fixture.trace), { code: "ENOENT" });
          await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
          await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
        });
      }
    },
  );

  test(
    "complete lifecycle restricts manifest selection before effects",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      for (const scenario of [
        "relative override",
        "absolute override",
        "symlink override",
        "canonical symlink alias",
      ] as const) {
        await t.test(scenario, async (t) => {
          const fixture = await lifecycleFixture(t);
          const canonical = join(fixture.root, "scripts/ci/test-suites.json");
          const alternate = jsonObject(
            parseJson(await readFile(canonical, "utf8")),
            "expected fixture manifest",
          );
          const lanes = jsonObject(alternate.lanes, "expected fixture manifest lanes");
          const lifecycle = jsonObject(lanes.lifecycle, "expected the lifecycle lane");
          // Both definitions select the same real file, but supply different inputs.
          // Use normal lane selection (no --file) so an override reaches the run owner.
          lifecycle.env = { CI_RUNNER_MANIFEST_SELECTION: "alternate" };
          await writeJson(join(fixture.root, "alternate.json"), alternate);
          await symlink("alternate.json", join(fixture.root, "alternate-link.json"));
          await symlink("scripts/ci/test-suites.json", join(fixture.root, "canonical-link.json"));
          const paths = {
            "relative override": "./scripts/../alternate.json",
            "absolute override": join(fixture.root, "alternate.json"),
            "symlink override": "alternate-link.json",
            "canonical symlink alias": "canonical-link.json",
          };
          const result = await runRunnerAsync(
            [...fixture.args, "--manifest", paths[scenario]],
            {},
            { timeout: 30_000 },
          );
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.status, 1, result.stderr);
          assert.equal(
            result.stderr.trim(),
            "Complete lifecycle requires the canonical scripts/ci/test-suites.json manifest under --root.",
          );
          for (const path of [fixture.attempt, fixture.trace, fixture.owned, fixture.results]) {
            await assert.rejects(stat(path), { code: "ENOENT" });
          }

          if (scenario === "relative override") {
            // Externally managed run still accepts the alternate definition and uses
            // its input, rather than silently substituting the canonical manifest.
            await writeFile(
              join(fixture.root, "tests/integration/lifecycle.test.mjs"),
              [
                'import assert from "node:assert/strict";',
                'import test from "node:test";',
                'test("alternate manifest input", () => assert.equal(process.env.CI_RUNNER_MANIFEST_SELECTION, "alternate"));',
              ].join("\n"),
            );
            const ordinary = runRunnerSync(
              laneArgs(
                fixture.root,
                "lifecycle",
                "state/ordinary.json",
                "results/ordinary.json",
                "alternate.json",
              ),
            );
            assert.equal(ordinary.status, 0, ordinary.stderr);
            const summary = jsonObject(
              parseJson(await readFile(join(fixture.root, "results/ordinary.json"), "utf8")),
              "expected the ordinary run result",
            );
            const counts = jsonObject(summary.counts, "expected ordinary run counts");
            assert.equal(counts.passed, 1);
          }
        });
      }
      for (const form of ["relative", "absolute"]) {
        await t.test(`explicit canonical ${form} path`, async (t) => {
          const fixture = await lifecycleFixture(t);
          const manifest =
            form === "relative"
              ? "./scripts/ci/../ci/test-suites.json"
              : join(fixture.root, "scripts/ci/test-suites.json");
          const result = await runRunnerAsync(
            [...fixture.args, "--manifest", manifest],
            {},
            { timeout: 30_000 },
          );
          assert.equal(result.status, 0, result.stderr);
          const summary = completeResult(await readFile(fixture.results, "utf8"));
          assert.equal(summary.lifecycle.status, "passed");
          assert.equal(summary.counts.passed, 1);
          await assert.rejects(stat(fixture.state), { code: "ENOENT" });
          await assert.rejects(stat(fixture.owned), { code: "ENOENT" });
        });
      }
    },
  );

  test(
    "complete lifecycle losing an attempt claim cannot run phases or clean its winner",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      const winner = await startLifecycleFixture(t, { hold: true });
      assert.equal(
        await waitFor(() => lifecycleReady(winner.ready), 15_000),
        true,
        winner.stderr(),
      );
      const state = await readFile(winner.state, "utf8");
      assert.equal(jsonObject(parseJson(state), "expected winner state").version, 1);
      assert.equal((await stat(winner.attempt)).mode & 0o777, 0o700);
      const owned = await readFile(winner.owned, "utf8");
      const sentinelPath = join(winner.attempt, "winner-sentinel");
      await writeFile(sentinelPath, "belongs to the winning attempt");
      // Both invocations use the same real atomic claim. The loser observes valid
      // foreign state but has no authority to invoke its cleanup hook.
      const loser = await runRunnerAsync(winner.args, {}, { timeout: 10_000 });
      assert.equal(loser.error, undefined, loser.stderr);
      assert.equal(loser.status, 1, loser.stderr);
      assert.equal(await readFile(winner.state, "utf8"), state);
      assert.equal(await readFile(winner.owned, "utf8"), owned);
      assert.equal(await readFile(sentinelPath, "utf8"), "belongs to the winning attempt");
      assert.equal(await readFile(winner.trace, "utf8"), "prepare:start\n");
      await assert.rejects(readFile(winner.results), { code: "ENOENT" });
      await writeFile(winner.release, "release");
      assert.ok(await waitFor(() => winner.exit() !== undefined, 10_000), winner.stderr());
      assert.deepEqual(winner.exit(), { code: 0, signal: null }, winner.stderr());
      assert.equal(
        await readFile(winner.trace, "utf8"),
        "prepare:start\nprepare:end\nrun\ncleanup\n",
      );
      await assert.rejects(readFile(winner.owned), { code: "ENOENT" });
    },
  );

  test(
    "complete lifecycle owns detached test groups after deadline or coordinator loss",
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      for (const cause of ["deadline", "coordinator disconnect"]) {
        await t.test(cause, async (t) => {
          const deadline = Date.now() + (cause === "deadline" ? 10_000 : 30_000);
          const fixture = await startLifecycleFixture(
            t,
            { running: true },
            {
              CI_RUNNER_DEADLINE_MS: String(deadline),
              CI_RUNNER_TEST_TIMEOUT_MS: "60000",
            },
          );
          const records = await waitFor(() => {
            try {
              return parseJson(readFileSync(fixture.running, "utf8"));
            } catch {
              return false;
            }
          }, 7_000);
          assert.ok(isJsonArray(records), fixture.stderr());
          fixture.remember(records.filter(isDetachedProcess));
          assert.ok(records.every(isDetachedProcess), fixture.stderr());
          const coordinator = records.at(-1);
          const body = records[0];
          assert.ok(coordinator && body, "expected recorded coordinator and test body");
          const coordinatorPid = fixture.child.pid;
          assert.ok(isProcessId(coordinatorPid), "expected a lifecycle coordinator PID");
          assert.equal(coordinator.pid, coordinatorPid);
          assert.equal(coordinator.ppid, process.pid);
          const anchor = records.find((record) => record.pid === body.pgid);
          assert.ok(anchor, "the detached Node test group has an observed live owner");
          const phase = records.find((record) => record.pid === anchor.ppid);
          assert.ok(phase, "the group owner belongs to the lifecycle run phase");
          assert.equal(phase.ppid, coordinatorPid);
          const testRunner = lifecycleProcess(process.pid);
          assert.ok(testRunner, "expected to observe the test runner process group");
          assert.notEqual(body.pgid, testRunner.pgid);
          assert.ok(
            records.every(lifecycleProcessLive),
            "readiness records live fixture processes",
          );
          if (cause === "deadline") {
            // Stop only the phase, leaving its detached Node group live. Its own
            // timer cannot hide a failure of the outer owner's deadline cleanup.
            process.kill(phase.pid, "SIGSTOP");
            assert.equal(
              await waitFor(() => lifecycleProcess(phase.pid)?.state === "T", 1_000),
              true,
            );
            assert.ok(lifecycleProcessLive(body));
          } else {
            // Killing the real coordinator closes IPC naturally; no synthetic
            // disconnect event or replacement handler supplies the behavior.
            process.kill(coordinatorPid, "SIGKILL");
          }
          assert.equal(
            await waitFor(() => records.every((record) => !lifecycleProcessLive(record)), 15_000),
            true,
            "owned detached test processes must terminate before fixture teardown",
          );
          assert.ok(await waitFor(() => fixture.exit() !== undefined, 2_000), fixture.stderr());
          assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\nprepare:end\nrun\n");
          assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
          const state = jsonObject(
            parseJson(await readFile(fixture.state, "utf8")),
            "expected attempt state",
          );
          assert.equal(state.version, 1);
          if (cause === "deadline") {
            assert.deepEqual(fixture.exit(), { code: 1, signal: null }, fixture.stderr());
            const summary = completeResult(await readFile(fixture.results, "utf8"));
            assert.equal(summary.lifecycle.status, "reconciliation-required");
            assert.equal(summary.lifecycle.phases.run.status, "timed-out");
            assert.equal(summary.lifecycle.phases.cleanup.status, "not-run");
          } else {
            assert.deepEqual(fixture.exit(), { code: null, signal: "SIGKILL" });
            await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
          }
        });
      }
    },
  );
}
