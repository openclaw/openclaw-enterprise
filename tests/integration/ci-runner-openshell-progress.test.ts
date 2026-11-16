import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  openShellProgressPrefix,
  upstreamOutageCase,
} from "../../scripts/ci/openshell-progress.mjs";
import reporter from "../../scripts/ci/reporter.ts";
import { readFileEvidence, type FileEvidence } from "../../scripts/ci/runner-reporter-output.ts";
import {
  createRunnerFixture,
  laneArgs,
  runnerEnv,
  runRunnerAsync,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

const repositoryUrl = new URL("../../", import.meta.url);
const repositoryRoot = fileURLToPath(repositoryUrl);
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.ts");
const execFileAsync = promisify(execFile);

async function reportingFixture(t: TestContext, lane: "failure" | "progress") {
  const root = await createRunnerFixture(t);
  const file = `tests/integration/${lane}.test.ts`;
  await copyFile(
    new URL(`../fixtures/ci-runner-openshell-${lane}-child.ts`, import.meta.url),
    join(root, file),
  );
  await writeFile(join(root, "tests/integration/repository-url"), repositoryUrl.href);
  await writeRunnerManifest(root, {
    lanes: { [lane]: { files: [{ path: file }] } },
    groups: {},
  });
  return {
    root,
    file,
    state: `state/${lane}.jsonl`,
    results: join(root, `results/${lane}.json`),
    lane,
  };
}

function startReportingRunner(
  t: TestContext,
  { root, lane, state, results }: Awaited<ReturnType<typeof reportingFixture>>,
  onLine: (line: string) => void,
) {
  const child = spawn(process.execPath, [runnerPath, ...laneArgs(root, lane, state, results)], {
    cwd: repositoryRoot,
    env: runnerEnv({ CI_RUNNER_TEST_TIMEOUT_MS: "10000" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const lines = createInterface({ input: child.stderr });
  lines.on("line", onLine);
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await closed;
  });
  return { child, closed, output: () => [stdout, stderr] };
}

type RunSummary = {
  counts: { passed: number; failed: number };
  files: {
    tests: {
      name: string;
      error?: { message: string; code: string; cause: unknown };
    }[];
    measurements: { kind: string; outcome: string }[];
  }[];
};

test(
  "CI streams safe OpenShell failures before cleanup and retains the original error",
  { timeout: 25_000 },
  async (t) => {
    const fixture = await reportingFixture(t, "failure");
    const { root, file, results } = fixture;
    const ready = Promise.withResolvers<boolean>();
    const watcher = watch(root, (_event, name) => {
      if (name === "cleanup-ready") {
        watcher.close();
        ready.resolve(true);
      }
    });
    t.after(() => watcher.close());

    const live = Promise.withResolvers<boolean>();
    const label = `[run:failure] ${file}: openshell-stage-failure `;
    const failures: string[] = [];
    const location = " workflow=tests/helpers/openshell-sandbox-workflows.mjs";
    const expected = [
      "Error code=ETIMEDOUT",
      "Error code=ENOENT",
      "RangeError code=unknown",
      "unknown code=unknown",
      "TypeError code=unknown",
      "RangeError code=unknown",
      "unknown code=unknown",
      "AssertionError code=ERR_ASSERTION",
    ].map((value) => `installation ${value}${location}`);
    const { child, closed, output } = startReportingRunner(t, fixture, (line) => {
      if (line.startsWith(label)) {
        failures.push(line.slice(label.length));
        if (failures.length === expected.length) {
          live.resolve(true);
        }
      }
    });
    const assertFailureLines = () => {
      assert.deepEqual(failures, expected);
      for (const stream of output()) {
        assert.equal(stream.includes("generated-credential-must-stay-private"), false);
        assert.equal(stream.includes("999999:123456"), false);
      }
    };

    // Read all eight failures while cleanup waits for the release file.
    assert.equal(
      await Promise.race([
        Promise.all([ready.promise, live.promise]).then(() => true),
        closed.then(() => false),
      ]),
      true,
      "safe failures and cleanup readiness must arrive before the runner closes",
    );
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(
      await readFile(join(root, "identity-verified"), "utf8"),
      "original-error-identity-verified",
    );
    assertFailureLines();

    await writeFile(join(root, "release"), "release cleanup");
    assert.deepEqual(await closed, { code: 1, signal: null });
    assertFailureLines();
    const summary: RunSummary = JSON.parse(await readFile(results, "utf8"));
    assert.equal(summary.counts.failed, 1);
    const [result] = summary.files;
    assert.ok(result);
    const failure = result.tests.find(({ name }) => name === "original failure");
    assert.ok(failure?.error);
    assert.equal(failure.error.message, "original-stage-failure");
    assert.equal(failure.error.code, "ERR_TEST_FAILURE");
    assert.deepEqual(failure.error.cause, {
      code: "ERR_ASSERTION",
      name: "AssertionError",
    });
    for (const expectedOutcome of ["passed", "failed"]) {
      assert.ok(
        result.measurements.some(
          ({ kind, outcome }) => kind === "openshell-sandbox-phase" && outcome === expectedOutcome,
        ),
      );
    }
  },
);

test(
  "run reports bounded OpenShell progress before the test file finishes",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await reportingFixture(t, "progress");
    const { root, file, results, state } = fixture;
    const live = Promise.withResolvers<boolean>();
    const label = `[run:progress] ${file}: `;
    const progress: string[] = [];
    const { child, closed, output } = startReportingRunner(t, fixture, (line) => {
      if (line.startsWith(label)) {
        progress.push(line.slice(label.length));
      }
      if (line === `${label}openshell-stage installation started`) {
        live.resolve(true);
      }
    });
    // A final buffered transcript cannot satisfy this handshake.
    assert.ok(
      await Promise.race([live.promise, closed.then(() => false)]),
      "progress must arrive while the child waits for its release file",
    );
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await writeFile(join(root, "release"), "");
    assert.deepEqual(await closed, { code: 1, signal: null });
    assert.deepEqual(progress, [
      "openshell-stage installation started",
      "openshell-stage installation passed",
      "openshell-stage initial-model started",
      "openshell-stage initial-model failed",
    ]);
    const artifact = await readFile(results, "utf8");
    const summary: RunSummary = JSON.parse(artifact);
    assert.equal(summary.counts.passed, 1);
    assert.equal(summary.counts.failed, 1);
    const [result] = summary.files;
    assert.ok(result);
    assert.deepEqual(result.measurements, [
      {
        kind: "openshell-stage",
        stage: "installation",
        outcome: "passed",
        elapsedMs: 123,
      },
    ]);
    const diagnostics = await readFile(join(root, `${state}.diagnostics.json`), "utf8");
    const failureDiagnostics: {
      failures: { output: { lines: string[]; omittedLines: number } }[];
    } = JSON.parse(diagnostics);
    const [failure] = failureDiagnostics.failures;
    assert.ok(failure);
    assert.deepEqual(failure.output.lines, [
      ...Array.from({ length: 398 }, (_, index) => `stdout: useful line ${index + 400}`),
      "stdout: ",
      "stdout: unfinished ordinary output",
    ]);
    assert.equal(failure.output.omittedLines, 400);
    for (const text of [...output(), artifact, diagnostics]) {
      assert.equal(/private-\w+-canary/.test(text), false);
    }
  },
);

test("CI retains the unfinished upstream stage without changing the failed case", async (t) => {
  const file = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const stageModule = new URL("tests/helpers/openshell-stage.ts", repositoryUrl).href;
  const gatewayFailure = {
    kind: "openshell-gateway-turn-failure",
    checkpoint: "gateway-setup",
    turn: 0,
    status: null,
  };
  function terminal(kind: string, stage: string, outcome: string) {
    return { kind, stage, outcome, elapsedMs: 1 };
  }
  for (const [stage, interruption, diagnostic, expected] of [
    ["installation", "deadline", null, "installation"],
    ["replacement", "deadline", null, "replacement"],
    ["replacement", "throw", null, undefined],
    [
      "installation",
      "deadline",
      terminal("openshell-sandbox-phase", "installation", "passed"),
      undefined,
    ],
    ["installation", "deadline", terminal("openshell-stage", "replacement", "passed"), undefined],
    [
      "replacement",
      "deadline",
      terminal("openshell-sandbox-phase", "pod-replacement", "failed"),
      undefined,
    ],
    [
      "replacement",
      "deadline",
      terminal("openshell-sandbox-phase", "gateway-turns", "failed"),
      undefined,
    ],
    ["installation", "deadline", gatewayFailure, undefined],
    ["replacement", "deadline", gatewayFailure, undefined],
  ] as const) {
    const root = await createRunnerFixture(t);
    const results = join(root, "results/upstream.json");
    const lane = "openshell-installers";
    const steps = ["installation", "exposure-auth", "initial-model", "replacement"];
    const selected = steps.slice(0, steps.indexOf(stage) + 1);
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      "export async function prepareFile() { return { cleanup: async () => {} }; }",
    );
    await writeFile(
      join(root, file),
      `import test from "node:test";
       import { runOpenShellStage } from ${JSON.stringify(stageModule)};
       test(${JSON.stringify(title)}, { timeout: 300 }, async (t) => {
         for (const step of ${JSON.stringify(selected)}) {
           await runOpenShellStage(t, step, async () => {
             if (step !== ${JSON.stringify(stage)}) return;
             if (${JSON.stringify(interruption)} === "throw") throw new Error("fixture failure");
             const diagnostic = ${JSON.stringify(diagnostic)};
             if (diagnostic) t.diagnostic("openclaw-ci-measurement " + JSON.stringify(diagnostic));
             await new Promise(() => {
               const timer = setInterval(() => {}, 1000);
               t.after(() => clearInterval(timer));
             });
           });
         }
       });`,
    );
    await writeRunnerManifest(root, {
      lanes: { [lane]: { files: [{ path: file, expectedTests: [title] }] } },
    });
    const result = await runRunnerAsync(laneArgs(root, lane, "state/upstream.jsonl", results), {
      CI_RUNNER_TEST_TIMEOUT_MS: "15000",
    });
    assert.equal(result.status, 1, result.stderr);
    const summary: {
      status: string;
      files: {
        openShellUnfinishedStage?: string;
        measurements?: { kind: string }[];
        cleanup: { status: string };
        tests: { name: string; status: string }[];
      }[];
    } = JSON.parse(await readFile(results, "utf8"));
    assert.equal(summary.status, "failed");
    const [upstream] = summary.files;
    assert.ok(upstream);
    assert.deepEqual(
      upstream.tests.map(({ name, status }) => [name, status]),
      [[title, "failed"]],
    );
    assert.equal(upstream.cleanup.status, "passed");
    if (diagnostic === gatewayFailure) {
      assert.deepEqual(
        upstream.measurements?.filter((row) => row.kind === gatewayFailure.kind),
        [gatewayFailure],
      );
    }
    assert.equal(upstream.openShellUnfinishedStage, expected);
  }
});

test("CI records only observed upstream replacement checkpoints on failure", async (t) => {
  const upstreamFile = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const stageModule = new URL("tests/helpers/openshell-stage.ts", repositoryUrl).href;
  const workflowModule = new URL("tests/helpers/openshell-sandbox-workflows.mjs", repositoryUrl)
    .href;
  const progressModule = new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href;

  await t.test("the upstream wrapper registers the helper-declared case", async (t) => {
    const home = await createRunnerFixture(t);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--test",
        "--test-reporter",
        fileURLToPath(new URL("scripts/ci/reporter.ts", repositoryUrl)),
        fileURLToPath(new URL(upstreamFile, repositoryUrl)),
      ],
      {
        cwd: fileURLToPath(repositoryUrl),
        env: { HOME: home, PATH: "" },
        timeout: 30_000,
      },
    );
    const records: {
      type: string;
      data?: {
        name?: string;
        file?: string;
        nesting?: number;
        skip?: unknown;
      };
    }[] = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const matches = records.filter(
      ({ type, data }) => type === "test:pass" && data?.name === title,
    );
    assert.equal(matches.length, 1);
    const data = matches[0]?.data;
    assert.ok(data?.skip);
    assert.equal(data.nesting, 0);
    assert.equal(
      data.file,
      fileURLToPath(new URL("tests/helpers/openshell-sandbox-workflows.mjs", repositoryUrl)),
    );
  });

  for (const [mode, checkpoint, outcome] of [
    ["setup", undefined, undefined],
    ["request", "redeploy-request", "failed"],
    ["same-revision", "redeploy-request", "failed"],
    ["activation", "activation", "failed"],
    ["reconciliation", "reconciliation", "failed"],
    ["out-of-order", undefined, undefined],
    ["extra-field", undefined, undefined],
    ["later-stage", undefined, undefined],
    ["wrong-case", undefined, undefined],
    ["wrong-lane", undefined, undefined],
    ["wrong-file", undefined, undefined],
    ["wrong-manifest", undefined, undefined],
    ["wrong-declaration", undefined, undefined],
    ["completed-wrapper-emitter", undefined, undefined],
    ["case-deadline", "activation", "unfinished"],
    ["runner-deadline", "activation", "unfinished"],
    ["success", undefined, undefined],
  ] as const) {
    await t.test(mode, async (t) => {
      const root = await createRunnerFixture(t);
      const results = join(root, "results/upstream.json");
      const state = join(root, "state/upstream.jsonl");
      const cleanupMarker = join(root, "state/cleanup");
      const activationPoll = join(root, "state/activation-poll");
      const caseDeadline = mode === "case-deadline";
      const runnerDeadline = mode === "runner-deadline";
      const pendingActivation = caseDeadline || runnerDeadline;
      const success = mode === "success";
      const name = mode === "wrong-case" ? "another case" : title;
      const upstreamLane = mode === "reconciliation" ? "openshell" : "openshell-installers";
      const lane = mode === "wrong-lane" ? "other-installers" : upstreamLane;
      const file =
        mode === "wrong-file" ? "tests/integration/other-upstream.test.ts" : upstreamFile;
      const expectedName = mode === "wrong-manifest" ? "another case" : title;
      const declaration =
        mode === "wrong-declaration" ? "unrelated.mjs" : "openshell-sandbox-workflows.mjs";
      await mkdir(join(root, "tests/helpers"), { recursive: true });
      const wrapper = join(root, file);
      const earlierCase =
        mode === "completed-wrapper-emitter"
          ? `test(${JSON.stringify(wrapper)}, () => {
             for (const stage of ["installation", "exposure-auth", "initial-model"]) {
               emitOpenShellProgress(stage, "started");
               emitOpenShellProgress(stage, "passed");
             }
             emitOpenShellProgress("replacement", "started");
             emitOpenShellReplacementCheckpoint("redeploy-request");
             emitOpenShellReplacementCheckpoint("activation");
           });
           import test from "node:test";
           import { emitOpenShellProgress, emitOpenShellReplacementCheckpoint } from ${JSON.stringify(progressModule)};
          `
          : "";
      await writeFile(wrapper, `${earlierCase}await import("../helpers/${declaration}");\n`);
      await writeFile(
        join(root, "scripts/ci/prepare.mjs"),
        `import { writeFile } from "node:fs/promises";
         export async function prepareFile() {
           return { cleanup: () => writeFile(${JSON.stringify(cleanupMarker)}, "cleaned") };
         }`,
      );
      await writeFile(
        join(root, "tests/helpers", declaration),
        `import assert from "node:assert/strict";
         import { writeFileSync } from "node:fs";
         import test from "node:test";
         import { runOpenShellStage } from ${JSON.stringify(stageModule)};
         import { emitOpenShellProgress, emitOpenShellReplacementCheckpoint, openShellProgressPrefix } from ${JSON.stringify(progressModule)};
         import { redeployOpenShellReplacement } from ${JSON.stringify(workflowModule)};

         const mode = ${JSON.stringify(mode)};
         const failure = new Error("controlled failure " + process.env.CI_RUNNER_FIXTURE_CREDENTIAL);
         const response = { status: 202, data: { id: "private-replacement-id" } };
         const agentPath = "/namespaces/fixture/agents/fixture";
         test(${JSON.stringify(name)}, ${caseDeadline ? "{ timeout: 1200 }, " : runnerDeadline ? "{ timeout: 15000 }, " : ""}async (t) => {
           if (mode === "completed-wrapper-emitter") {
             // Supply the genuine failed measurement and terminal, but none of the earlier progress.
             emitOpenShellProgress("replacement", "failed");
             t.diagnostic('openclaw-ci-measurement {"kind":"openshell-stage","stage":"replacement","outcome":"failed","elapsedMs":1}');
             throw failure;
           }
           for (const step of ["installation", "exposure-auth", "initial-model"]) {
             await runOpenShellStage(t, step, async () => {});
           }
           await runOpenShellStage(t, "replacement", async () => {
             if (mode === "setup") throw failure;
             if (mode === "out-of-order") {
               emitOpenShellReplacementCheckpoint("activation");
               emitOpenShellReplacementCheckpoint("redeploy-request");
               throw failure;
             }
             if (mode === "extra-field") {
               process.stdout.write(openShellProgressPrefix + JSON.stringify({
                 kind: "openshell-replacement-checkpoint", checkpoint: "redeploy-request", extra: "private-progress-extra",
               }) + "\\n");
               throw failure;
             }
             const topology = {
               namespaceId: "fixture",
               agent: { id: "fixture" },
               revision: { id: "private-previous-id" },
               async request(method, path) {
                 if (method === "POST") {
                   assert.equal(path, agentPath + "/deploy");
                   if (mode === "request") throw failure;
                   if (mode === "same-revision") {
                     topology.revision = { id: "same-test-revision" };
                     return { status: 202, data: topology.revision };
                   }
                   return response;
                 }
                 assert.equal(method, "GET");
                 if (path === agentPath) {
                 if (${pendingActivation}) {
                   writeFileSync(${JSON.stringify(activationPoll)}, "polling");
                   // Keep Node alive while the real activation poll and its caller are pending.
                   const hold = setInterval(() => {}, 1000);
                   t.signal.addEventListener("abort", () => clearInterval(hold), { once: true });
                   return new Promise(() => {});
                 }
                   return { status: 200, data: {
                     activeRevisionId: mode === "activation" ? topology.revision.id : response.data.id,
                   }};
                 }
                 assert.equal(path, agentPath + "/deployments/" + response.data.id);
                 assert.equal(mode, "activation");
                 throw failure;
               },
               async diagnoseRevision() { return {}; },
             };
             try {
               const deployed = await redeployOpenShellReplacement(topology, t, true, async () => "");
               assert.equal(deployed, response);
             } catch (error) {
               if (mode === "activation" || mode === "request") assert.equal(error, failure);
               throw error;
             }
             if (mode === "reconciliation" || mode.startsWith("wrong-")) throw failure;
           }, "pod-replacement");
           if (mode === "later-stage") {
             await runOpenShellStage(t, "untrusted-upstream", async () => { throw failure; });
           }
         });`,
      );
      await writeRunnerManifest(root, {
        lanes: {
          [lane]: { files: [{ path: file, expectedTests: [expectedName] }] },
        },
      });
      const runner = await runRunnerAsync(
        laneArgs(root, lane, state, results),
        { CI_RUNNER_TEST_TIMEOUT_MS: runnerDeadline ? "5000" : "10000" },
        { timeout: 30_000 },
      );
      assert.equal(runner.error, undefined);
      assert.equal(runner.status, success ? 0 : 1, runner.stderr);
      const artifact = await readFile(results, "utf8");
      const summary: {
        files: {
          status: string;
          openShellReplacement?: { checkpoint: string; outcome: string };
          openShellUnfinishedStage?: string;
          cleanup: { status: string };
          issues: { code: string }[];
          tests: {
            name: string;
            status: string;
            error?: { message: string; failureType?: string };
          }[];
          measurements: { kind: string; stage: string; outcome: string }[];
        }[];
      } = JSON.parse(artifact);
      const [result] = summary.files;
      assert.ok(result);
      assert.equal(result.cleanup.status, "passed");
      assert.equal(await readFile(cleanupMarker, "utf8"), "cleaned");
      assert.equal(result.status, success ? "passed" : "failed");
      if (pendingActivation) {
        assert.equal(await readFile(activationPoll, "utf8"), "polling");
      }
      assert.deepEqual(
        result.openShellReplacement,
        checkpoint ? { checkpoint, outcome } : undefined,
      );
      assert.equal(result.openShellUnfinishedStage, pendingActivation ? "replacement" : undefined);
      assert.equal(
        result.issues.some(({ code }) => code === "test-timeout"),
        runnerDeadline,
      );
      assert.equal(
        result.issues.some(({ code }) => code === "missing-expected-test"),
        runnerDeadline || mode === "wrong-manifest" || mode === "wrong-case",
      );
      assert.doesNotMatch(runner.stderr, /openshell-replacement-checkpoint|redeploy-request/u);
      const replacement = result.measurements?.find(
        ({ kind, stage }) => kind === "openshell-stage" && stage === "replacement",
      );
      assert.deepEqual(
        result.tests.map(({ name, status }) => [name, status]),
        runnerDeadline ? [] : [[name, success ? "passed" : "failed"]],
      );
      assert.equal(
        replacement?.outcome,
        pendingActivation ? undefined : success || mode === "later-stage" ? "passed" : "failed",
      );
      assert.equal(
        result.tests[0]?.error?.failureType,
        caseDeadline ? "testTimeoutFailure" : undefined,
      );
      if (pendingActivation) {
        const diagnostics: {
          failures: {
            reason: string;
            timeoutMs?: number;
            interruptedTests?: { name: string }[];
          }[];
        } = JSON.parse(await readFile(`${state}.diagnostics.json`, "utf8"));
        const [failure] = diagnostics.failures;
        assert.ok(failure);
        assert.equal(failure.reason, runnerDeadline ? "timeout" : "failed");
        assert.equal(failure.timeoutMs, runnerDeadline ? 5000 : undefined);
        assert.deepEqual(
          failure.interruptedTests?.map(({ name }) => name),
          runnerDeadline ? [title] : undefined,
        );
      }
      if (
        mode === "activation" ||
        mode === "reconciliation" ||
        mode === "request" ||
        mode === "completed-wrapper-emitter"
      ) {
        assert.match(result.tests[0]?.error?.message ?? "", /^controlled failure \[env:/u);
      }
      for (const text of [artifact, runner.stdout, runner.stderr]) {
        assert.doesNotMatch(
          text,
          /private-progress-extra|secretauthvalue|singleUpstreamOutageCase/u,
        );
        assert.doesNotMatch(text, /private-replacement-id|private-previous-id/u);
      }
    });
  }
});

// Deliver deterministic event orders through the same reporter and evidence reader as the runner.
test("CI binds upstream replacement progress to the case cutoff", async (t) => {
  const root = process.cwd();
  const { entry, declaration, name } = upstreamOutageCase;
  const absolutePath = join(root, entry);
  const envelope = {
    file: absolutePath,
    name: absolutePath,
    nesting: 0,
    line: 1,
    column: 1,
  };
  const testCase = {
    name,
    nesting: 0,
    line: 9,
    column: 5,
    entryFile: absolutePath,
    file: join(root, declaration),
  };
  const nativeTimeout = {
    code: "ERR_TEST_FAILURE",
    failureType: "testTimeoutFailure",
  };
  type IterableEvent<T> = T extends Iterable<infer Item> ? Item : never;
  type Event = IterableEvent<Parameters<typeof reporter>[0]>;
  const progress = (value: object): Event => ({
    type: "test:stdout",
    data: { message: openShellProgressPrefix + JSON.stringify(value) + "\n" },
  });
  const stage = (stage: string, outcome: string) =>
    progress({ kind: "openshell-stage", stage, outcome });
  const checkpoint = (checkpoint: string) =>
    progress({ kind: "openshell-replacement-checkpoint", checkpoint });
  const earlierStages = ["installation", "exposure-auth", "initial-model"].flatMap((name) => [
    stage(name, "started"),
    stage(name, "passed"),
  ]);
  const replacement = [stage("replacement", "started"), checkpoint("redeploy-request")];
  const activation = checkpoint("activation");
  const failedStage = stage("replacement", "failed");
  const measurement = (outcome: "passed" | "failed"): Event => ({
    type: "test:diagnostic",
    data: {
      message:
        "openclaw-ci-measurement " +
        JSON.stringify({
          kind: "openshell-stage",
          stage: "replacement",
          outcome,
          elapsedMs: 1,
        }),
    },
  });
  const complete = (data = testCase, error?: object): Event[] => [
    { type: "test:complete", data },
    { type: "test:fail", data: { ...data, details: { type: "test", error } } },
    { type: "test:complete", data: envelope },
  ];
  const dequeue = (data: typeof envelope | typeof testCase = testCase): Event => ({
    type: "test:dequeue",
    data,
  });
  const interrupted: Event = { type: "test:interrupted" };
  const fileStart = dequeue(envelope);

  const active = [dequeue(), ...earlierStages, ...replacement];
  const failed = [...active, activation, failedStage, ...complete()];
  const timedOut = complete(testCase, nativeTimeout);
  const malformed = progress({
    kind: "openshell-replacement-checkpoint",
    checkpoint: "activation",
    extra: "private-checkpoint-canary",
  });
  const prior = { ...envelope, entryFile: absolutePath };
  const completedWrapper: Event[] = [
    dequeue(prior),
    { type: "test:complete", data: prior },
    { type: "test:pass", data: { ...prior, details: { type: "test" } } },
  ];
  const siblings = Array.from({ length: 21 }, (_, i) => "other-" + i);
  const exactActivation = { checkpoint: "activation", outcome: "unfinished" } as const;

  type Cutoff = {
    events: Event[];
    checkpoint?: FileEvidence["openShellReplacement"];
    unfinishedStage?: FileEvidence["unfinishedStage"];
    timedOut?: boolean;
  };
  const completions: Record<string, Cutoff> = {
    "progress after failure": {
      events: [...active, ...complete(), activation, failedStage, measurement("failed")],
    },
    "progress after replacement fails": {
      events: [...active, failedStage, activation, ...complete(), measurement("failed")],
    },
    "delayed measurement": {
      events: [...failed, measurement("failed")],
      checkpoint: { checkpoint: "activation", outcome: "failed" },
    },
    "absent measurement": { events: failed },
    "contradictory measurement": { events: [...failed, measurement("passed")] },
    "case timeout after activation": {
      events: [...active, activation, ...timedOut],
      checkpoint: exactActivation,
      unfinishedStage: "replacement",
      timedOut: true,
    },
    "activation after case timeout": {
      events: [...active, ...timedOut, activation],
      unfinishedStage: "replacement",
      timedOut: true,
    },
    "checkpoint reordered before case timeout": {
      events: [...active.slice(0, -1), activation, replacement[1]!, ...timedOut],
      unfinishedStage: "replacement",
      timedOut: true,
    },
    "wrong timeout category": {
      events: [...active, activation, ...complete(testCase, { ...nativeTimeout, code: "OTHER" })],
      unfinishedStage: "replacement",
    },
    "wrong timeout case coordinate": {
      events: [...active, activation, ...complete({ ...testCase, line: 10 }, nativeTimeout)],
      unfinishedStage: "replacement",
    },
    "case timeout with contradictory measurement": {
      events: [...active, activation, ...timedOut, measurement("passed")],
      timedOut: true,
    },
    "malformed checkpoint beside an otherwise valid case timeout": {
      events: [...active, malformed, activation, ...timedOut],
      unfinishedStage: "replacement",
    },
  };
  type Interruption = Cutoff & { interruptedNames?: string[]; partialLine?: string };
  const interruptions: Record<string, Interruption> = {
    "progress after interruption": {
      events: [...active, interrupted, activation],
      unfinishedStage: "replacement",
    },
    "interruption before replacement": {
      events: [dequeue(), ...earlierStages.slice(0, -1), interrupted],
    },
    "nested interruption": {
      events: [dequeue({ ...testCase, nesting: 1 }), ...active.slice(1), interrupted],
      unfinishedStage: "replacement",
    },
    "foreign interruption": {
      events: [
        dequeue({ ...testCase, file: join(root, "tests/helpers/foreign.mjs") }),
        ...active.slice(1),
        interrupted,
      ],
      unfinishedStage: "replacement",
    },
    "duplicate interruption": {
      events: [dequeue(), ...active, interrupted],
      unfinishedStage: "replacement",
    },
    "completed wrapper interruption": {
      events: [...completedWrapper, ...active, interrupted],
      unfinishedStage: "replacement",
    },
    "missing coordinates at interruption": {
      events: [
        {
          type: "test:dequeue",
          data: { name, nesting: 0, entryFile: absolutePath, file: testCase.file },
        },
        ...active.slice(1),
        interrupted,
      ],
      unfinishedStage: "replacement",
    },
    "truncated interruption preview with siblings": {
      events: [
        ...siblings.map((name, i) => dequeue({ ...testCase, line: 20 + i, name })),
        ...active,
        interrupted,
      ],
      unfinishedStage: "replacement",
      interruptedNames: [...siblings.slice(-19), name],
      partialLine: '{"type":"test:output"',
    },
  };
  const controls = [
    ...Object.entries(completions).map(([label, control]) => ({
      label,
      ...control,
      deadline: false,
    })),
    ...Object.entries(interruptions).map(([label, control]) => ({
      label,
      interruptedNames: [name],
      ...control,
      deadline: true,
    })),
  ];
  for (const control of controls) {
    const { label, events, deadline, checkpoint, unfinishedStage, timedOut } = control;
    const partialLine = "partialLine" in control ? control.partialLine : undefined;
    const interruptedNames = "interruptedNames" in control ? control.interruptedNames : undefined;
    await t.test(label, async () => {
      let stdout = "";
      for await (const chunk of reporter([fileStart, ...events])) {
        stdout += chunk;
      }
      const evidence: FileEvidence = {
        measurements: [],
        testRunExercised: false,
        tests: [],
        skippedSuites: [],
      };
      const issues: Parameters<typeof readFileEvidence>[3] = [];
      readFileEvidence(
        {
          stdout: stdout + (partialLine ?? ""),
          status: deadline ? null : 1,
          signal: deadline ? "SIGTERM" : null,
          ...(deadline ? { error: { code: "ETIMEDOUT" } } : {}),
        },
        {
          root,
          absolutePath,
          relativePath: entry,
          laneName: "openshell-installers",
          expectedTests: [name],
          env: {},
          focused: false,
        },
        evidence,
        issues,
      );
      assert.deepEqual(issues, []);
      assert.deepEqual(evidence.openShellReplacement, checkpoint);
      assert.equal(evidence.unfinishedStage, unfinishedStage);
      assert.equal(evidence.tests.length, deadline ? 0 : 1);
      assert.doesNotMatch(stdout, /private-checkpoint-canary/u);
      for (const test of evidence.tests) {
        assert.equal(test.status, "failed");
        const failureType = timedOut ? "testTimeoutFailure" : undefined;
        assert.equal(
          test.error && typeof test.error === "object" && "failureType" in test.error
            ? test.error.failureType
            : undefined,
          failureType,
        );
      }
      assert.deepEqual(
        evidence.details?.interruptedTests?.map(({ name }) => name),
        interruptedNames,
      );
    });
  }
});
