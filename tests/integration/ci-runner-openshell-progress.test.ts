import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRunnerFixture,
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
