import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createRunnerFixture,
  heldClock,
  laneArgs,
  runnerEnv,
  runRunnerAsync,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

const repositoryUrl = new URL("../../", import.meta.url);
const repositoryRoot = fileURLToPath(repositoryUrl);
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

async function reportingFixture(t: TestContext, lane: "failure" | "progress") {
  const root = await createRunnerFixture(t);
  const file = `tests/integration/${lane}.test.ts`;
  await copyFile(
    new URL(`../fixtures/ci-runner-openshell-${lane}-child.ts`, import.meta.url),
    join(root, file),
  );
  await writeFile(join(root, "tests/integration/repository-url"), repositoryUrl.href);
  await writeRunnerManifest(root, { lanes: { [lane]: { files: [{ path: file }] } }, groups: {} });
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
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
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
    tests: { name: string; error?: { message: string; code: string; cause: unknown } }[];
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
    assert.deepEqual(failure.error.cause, { code: "ERR_ASSERTION", name: "AssertionError" });
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
      { kind: "openshell-stage", stage: "installation", outcome: "passed", elapsedMs: 123 },
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
  const stageModule = new URL("tests/helpers/openshell-stage.mjs", repositoryUrl).href;
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

// Inspect only fixed facts from the real reporter stream for timeout assertions.
async function observeUpstreamTimeout(root: string, title: string, activation: boolean) {
  const preload = join(root, "observe-timeout.mjs");
  const receipt = join(root, "timeout-observed.json");
  const delivered = join(root, "state/deadline-progress-delivered");
  await writeFile(
    preload,
    `
    import childProcess from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { createInterface } from "node:readline";

    const title = ${JSON.stringify(title)};
    const expected = ["installation", "exposure-auth", "initial-model"].flatMap(
      (stage) => [stage + ":started", stage + ":passed"],
    ).concat("replacement:started", "redeploy-request", "activation");
    const gateIndex = ${activation} ? expected.length : expected.indexOf("initial-model:started") + 1;
    const spawn = childProcess.spawn;
    childProcess.spawn = function (...args) {
      const child = spawn.apply(this, args);
      if (!args[1]?.includes("--test-reporter")) return child;
      const facts = {
        exactActivationPrefix: false, activationSeen: false, interrupted: false,
        matchingInterruptedCase: false, matchingTerminalCase: false,
      };
      let index = 0;
      let ordered = true;
      createInterface({ input: child.stdout }).on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        const { type, data } = event;
        if (type === "test:progress" && !facts.interrupted) {
          if (data.kind === "openshell-replacement-checkpoint" || data.kind === "openshell-stage") {
            const value = data.kind === "openshell-stage" ? data.stage + ":" + data.outcome : data.checkpoint;
            facts.activationSeen ||= value === "activation";
            ordered &&= value === expected[index++];
            facts.exactActivationPrefix = ordered && index === expected.length;
            if (ordered && index === gateIndex) writeFileSync(${JSON.stringify(delivered)}, "");
          }
        } else if (type === "test:interrupted") {
          facts.interrupted = true;
          facts.matchingInterruptedCase = data.running.some(({ name, nesting }) => name === title && nesting === 0);
        } else if (type === "test:pass" || type === "test:fail") {
          facts.matchingTerminalCase ||= data.name === title && data.nesting === 0;
        }
      });
      child.once("close", () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(facts)));
      return child;
    };
    syncBuiltinESMExports();`,
  );
  return { preload: pathToFileURL(preload).href, receipt, delivered };
}

test("CI records only observed upstream replacement checkpoints on failure", async (t) => {
  const file = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const stageModule = new URL("tests/helpers/openshell-stage.mjs", repositoryUrl).href;
  const workflowModule = new URL("tests/helpers/openshell-sandbox-workflows.mjs", repositoryUrl)
    .href;
  const progressModule = new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href;
  const lane = "openshell-installers";

  for (const [mode, checkpoint, outcome] of [
    ["setup", undefined, undefined],
    ["request", "redeploy-request", "failed"],
    ["same-revision", "redeploy-request", "failed"],
    ["activation", "activation", "failed"],
    ["reconciliation", "reconciliation", "failed"],
    ["timeout", "activation", "unfinished"],
    ["missing-timeout", undefined, undefined],
    ["out-of-order", undefined, undefined],
    ["extra-field", undefined, undefined],
    ["later-stage", undefined, undefined],
    ["wrong-case", undefined, undefined],
    ["success", undefined, undefined],
  ] as const) {
    await t.test(mode, async (t) => {
      const root = await createRunnerFixture(t);
      const results = join(root, "results/upstream.json");
      const state = join(root, "state/upstream.jsonl");
      const success = mode === "success";
      const name = mode === "wrong-case" ? "another case" : title;
      const timedOut = mode.endsWith("timeout");
      const ready = join(root, "state/deadline-ready");
      const observer = timedOut
        ? await observeUpstreamTimeout(root, title, mode === "timeout")
        : undefined;
      await writeFile(
        join(root, "scripts/ci/prepare.mjs"),
        "export async function prepareFile() { return { cleanup: async () => {} }; }",
      );
      await writeFile(
        join(root, file),
        `import assert from "node:assert/strict";
         import test from "node:test";
         import { writeFileSync } from "node:fs";
         import { setTimeout } from "node:timers/promises";
         import { runOpenShellStage } from ${JSON.stringify(stageModule)};
         import { redeployOpenShellReplacement } from ${JSON.stringify(workflowModule)};
         import { emitOpenShellReplacementCheckpoint, openShellProgressPrefix } from ${JSON.stringify(progressModule)};

         const mode = ${JSON.stringify(mode)};
         const failure = new Error("controlled failure " + process.env.CI_RUNNER_FIXTURE_CREDENTIAL);
         const response = { status: 202, data: { id: "private-replacement-id" } };
         const agentPath = "/namespaces/fixture/agents/fixture";
         async function stall() {
           writeFileSync(${JSON.stringify(ready)}, "");
           await setTimeout(20_000);
         }
         test(${JSON.stringify(name)}, async (t) => {
           for (const step of ["installation", "exposure-auth", "initial-model"]) {
             await runOpenShellStage(t, step, async () => {
               if (mode === "missing-timeout" && step === "initial-model") await stall();
             });
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
                   if (mode === "timeout") await stall();
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
             if (mode === "reconciliation" || mode === "wrong-case") throw failure;
           }, "pod-replacement");
           if (mode === "later-stage") {
             await runOpenShellStage(t, "untrusted-upstream", async () => { throw failure; });
           }
         });`,
      );
      await writeRunnerManifest(root, {
        lanes: { [lane]: { files: [{ path: file, expectedTests: [name] }] } },
      });
      // The fixture can enter its poll before the reporter has delivered its progress.
      // Keep the real deadline held until both sides of that boundary have been observed.
      const runner = await runRunnerAsync(
        laneArgs(root, lane, state, results),
        { CI_RUNNER_TEST_TIMEOUT_MS: timedOut ? "6000" : "10000" },
        observer
          ? {
              timeout: 30_000,
              execArgv: [
                ...heldClock(Date.now(), [ready, observer.delivered]),
                "--import",
                observer.preload,
              ],
            }
          : undefined,
      );
      const evidence = observer
        ? await readFile(observer.receipt, "utf8").catch(() => '{"reporterObserved":false}')
        : "";
      assert.equal(runner.error, undefined, evidence);
      assert.equal(runner.status, success ? 0 : 1, evidence || runner.stderr);
      const artifact = await readFile(results, "utf8");
      const summary: {
        files: {
          openShellReplacement?: { checkpoint: string; outcome: string };
          openShellUnfinishedStage?: string;
          cleanup: { status: string };
          issues: { code: string }[];
          tests: { name: string; status: string; error?: { message: string } }[];
          measurements: { kind: string; stage: string; outcome: string }[];
        }[];
      } = JSON.parse(artifact);
      const [result] = summary.files;
      assert.ok(result);
      assert.equal(result.cleanup.status, "passed", evidence);
      assert.deepEqual(
        result.openShellReplacement,
        checkpoint ? { checkpoint, outcome } : undefined,
        evidence,
      );
      assert.equal(
        result.openShellUnfinishedStage,
        mode === "timeout" ? "replacement" : undefined,
        evidence || runner.stderr,
      );
      assert.equal(
        result.issues.some(({ code }) => code === "test-timeout"),
        timedOut,
        evidence,
      );
      const replacement = result.measurements?.find(
        ({ kind, stage }) => kind === "openshell-stage" && stage === "replacement",
      );
      if (timedOut) {
        assert.deepEqual(result.tests, [], evidence);
        assert.equal(replacement, undefined, evidence);
        assert.deepEqual(JSON.parse(evidence), {
          exactActivationPrefix: mode === "timeout",
          activationSeen: mode === "timeout",
          interrupted: true,
          matchingInterruptedCase: true,
          matchingTerminalCase: false,
        });
      } else {
        assert.deepEqual(
          result.tests.map(({ name, status }) => [name, status]),
          [[name, success ? "passed" : "failed"]],
        );
        assert.equal(replacement?.outcome, success || mode === "later-stage" ? "passed" : "failed");
        if (mode === "activation" || mode === "reconciliation" || mode === "request") {
          assert.match(result.tests[0]?.error?.message ?? "", /^controlled failure \[env:/u);
        }
      }
      for (const text of [artifact, runner.stdout, runner.stderr]) {
        assert.doesNotMatch(text, /private-progress-extra|secretauthvalue/u);
        assert.doesNotMatch(text, /private-replacement-id|private-previous-id/u);
      }
    });
  }
});

// Send controlled Node events through the real reporter. Native Node scheduling
// normally emits the live progress first, so a test-body throw alone cannot set this order.
test("CI binds upstream replacement progress to the case cutoff", async (t) => {
  const file = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const lane = "openshell-installers";
  const reporterUrl = new URL("scripts/ci/reporter.ts", repositoryUrl).href;
  for (const [mode, expected] of [
    ["after-failure", undefined],
    ["after-interruption", undefined],
    ["after-replacement", undefined],
    ["delayed-measurement", "failed"],
    ["before-interruption", "unfinished"],
  ] as const) {
    await t.test(mode, async (t) => {
      const root = await createRunnerFixture(t);
      const results = join(root, "results/upstream.json");
      const state = join(root, "state/upstream.jsonl");
      const child = join(root, "reporter-child.mjs");
      const preload = join(root, "reporter-child-preload.mjs");
      const interrupted = mode.endsWith("interruption");
      const ready = join(root, "state/deadline-ready");
      await writeFile(
        join(root, "scripts/ci/prepare.mjs"),
        "export async function prepareFile() { return { cleanup: async () => {} }; }",
      );
      await writeFile(join(root, file), "// This control supplies Node events to the reporter.\n");
      await writeFile(
        preload,
        `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(child)} });`,
      );
      await writeFile(
        child,
        `#!${process.execPath}
         import reporter from ${JSON.stringify(reporterUrl)};
         import { writeFileSync } from "node:fs";
         const data = {
           name: ${JSON.stringify(title)}, nesting: 0, line: 1, column: 1,
           file: process.argv.at(-1), details: { type: "test", duration_ms: 1 },
         };
         const progress = (value) => ({
           type: "test:stdout", data: { message: "openclaw-ci-progress " + JSON.stringify(value) + "\\n" },
         });
         const stage = (stage, outcome) => progress({ kind: "openshell-stage", stage, outcome });
         const checkpoint = (checkpoint) => progress({ kind: "openshell-replacement-checkpoint", checkpoint });
         const failure = { type: "test:fail", data };
         const failedStage = stage("replacement", "failed");
         const activation = checkpoint("activation");
         const measurement = { kind: "openshell-stage", stage: "replacement", outcome: "failed", elapsedMs: 1 };
         const mode = ${JSON.stringify(mode)};
         async function* events() {
           yield { type: "test:dequeue", data };
           for (const name of ["installation", "exposure-auth", "initial-model"]) {
             yield stage(name, "started");
             yield stage(name, "passed");
           }
           yield stage("replacement", "started");
           yield checkpoint("redeploy-request");
           switch (mode) {
             case "after-failure":
               yield failure;
               yield activation;
               yield failedStage;
               break;
             case "before-interruption":
             case "after-interruption": {
               const hold = setInterval(() => {}, 60_000);
               const terminated = new Promise((resolve) => process.once("SIGTERM", resolve));
               if (mode === "before-interruption") yield activation;
               writeFileSync(${JSON.stringify(ready)}, "");
               await terminated;
               clearInterval(hold);
               yield { type: "test:interrupted" };
               if (mode === "after-interruption") yield activation;
               return;
             }
             case "after-replacement":
               yield failedStage;
               yield activation;
               yield failure;
               break;
             case "delayed-measurement":
               yield activation;
               yield failedStage;
               yield failure;
               break;
           }
           yield {
             type: "test:diagnostic",
             data: { message: "openclaw-ci-measurement " + JSON.stringify(measurement) },
           };
         }
         for await (const line of reporter(events())) process.stdout.write(line);
         process.exitCode = 1;`,
        { mode: 0o700 },
      );
      await writeRunnerManifest(root, {
        lanes: { [lane]: { files: [{ path: file, expectedTests: [title] }] } },
      });
      const runner = await runRunnerAsync(
        laneArgs(root, lane, state, results),
        { CI_RUNNER_TEST_TIMEOUT_MS: interrupted ? "3000" : "10000" },
        {
          timeout: 30_000,
          execArgv: [
            ...(interrupted ? heldClock(Date.now(), [ready]) : []),
            "--import",
            pathToFileURL(preload).href,
          ],
        },
      );
      assert.equal(runner.error, undefined);
      assert.equal(runner.status, 1, runner.stderr);
      const summary: {
        files: {
          openShellReplacement?: { checkpoint: string; outcome: string };
          openShellUnfinishedStage?: string;
          cleanup: { status: string };
          issues: { code: string }[];
          tests: { name: string; status: string }[];
          measurements?: { kind: string; stage: string; outcome: string; elapsedMs: number }[];
        }[];
      } = JSON.parse(await readFile(results, "utf8"));
      const [result] = summary.files;
      assert.ok(result);
      assert.deepEqual(
        result.openShellReplacement,
        expected ? { checkpoint: "activation", outcome: expected } : undefined,
      );
      assert.equal(result.openShellUnfinishedStage, interrupted ? "replacement" : undefined);
      assert.equal(
        result.issues.some(({ code }) => code === "test-timeout"),
        interrupted,
      );
      assert.deepEqual(
        result.tests.map(({ name, status }) => [name, status]),
        interrupted ? [] : [[title, "failed"]],
      );
      assert.deepEqual(
        result.measurements,
        interrupted
          ? undefined
          : [{ kind: "openshell-stage", stage: "replacement", outcome: "failed", elapsedMs: 1 }],
      );
      assert.equal(result.cleanup.status, "passed");
    });
  }
});
