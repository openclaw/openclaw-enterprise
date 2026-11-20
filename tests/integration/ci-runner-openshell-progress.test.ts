import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  openShellProgressPrefix,
  upstreamOutageCase,
} from "../../scripts/ci/openshell-progress.mjs";
import { isRecord } from "../../scripts/ci/records.ts";
import reporter from "../../scripts/ci/reporter.ts";
import { readFileEvidence, type FileEvidence } from "../../scripts/ci/runner-reporter-output.ts";
import type { OpenShellReplacementChildOptions } from "../fixtures/ci-runner-openshell-replacement-child.ts";
import {
  observeDeadline,
  pendingMessage,
  readinessReceipt,
  timeoutReceipt,
} from "../helpers/ci-runner-deadline.ts";
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
      join(root, "scripts/ci/prepare.ts"),
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

async function runnerDeadlineDiagnostics(state: string, title: string) {
  let diagnostic: unknown;
  try {
    diagnostic = JSON.parse(await readFile(`${state}.diagnostics.json`, "utf8"));
  } catch (error) {
    return { status: isRecord(error) && error.code === "ENOENT" ? "missing" : "rejected" };
  }
  if (!isRecord(diagnostic) || !Array.isArray(diagnostic.failures)) {
    return { status: "rejected" };
  }
  if (diagnostic.failures.length === 0) {
    return { status: "empty" };
  }
  const [failure] = diagnostic.failures;
  if (diagnostic.failures.length !== 1 || !isRecord(failure)) {
    return { status: "rejected" };
  }

  const { reason, timeoutMs, interruptedTests } = failure;
  let interruptedStatus = "missing";
  let interruptedCount: number | undefined;
  let interruptedExpectedOnly: boolean | undefined;
  if (interruptedTests !== undefined) {
    if (
      Array.isArray(interruptedTests) &&
      interruptedTests.every((test) => isRecord(test) && typeof test.name === "string")
    ) {
      interruptedStatus = interruptedTests.length === 0 ? "empty" : "present";
      interruptedCount = interruptedTests.length;
      interruptedExpectedOnly =
        interruptedTests.length === 1 && interruptedTests[0]?.name === title;
    } else {
      interruptedStatus = "rejected";
    }
  }
  return {
    status: "present",
    reason: reason === "timeout" || reason === "failed" ? reason : null,
    timeoutMs:
      typeof timeoutMs === "number" &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 30_000
        ? timeoutMs
        : null,
    interruptedStatus,
    interruptedCount,
    interruptedExpectedOnly,
  };
}

const requestReceipts = {
  attempted: "state/request-attempted",
  sameRevisionRefusal: "state/same-revision-refusal",
  order: "state/request-reporter-order",
};
const requestStart = ["file:dequeue", "case:dequeue"];
const requestProgress = [
  ...["installation", "exposure-auth", "initial-model"].flatMap((stage) => [
    `${stage}:started`,
    `${stage}:passed`,
  ]),
  "replacement:started",
  "redeploy-request",
  "replacement:failed",
];
const requestBeforeFailure = [...requestStart, ...requestProgress];

async function observeRequest(root: string) {
  const observer = join(root, "request-observer.ts");
  const reporterUrl = new URL("scripts/ci/reporter.ts", repositoryUrl);
  const processUrl = new URL("scripts/ci/runner-process.ts", repositoryUrl).href;
  // Observe the stock reporter and runner without changing either file timer.
  // The child waits only for receipts produced by this exact reporter instance.
  await writeFile(
    observer,
    `import assert from "node:assert/strict";
     import { appendFileSync } from "node:fs";
     import { registerHooks } from "node:module";
     import { join } from "node:path";
     import { fileURLToPath } from "node:url";
     import { isRecord } from ${JSON.stringify(new URL("scripts/ci/records.ts", repositoryUrl).href)};
     import { upstreamOutageCase } from ${JSON.stringify(new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href)};
     import reporter from ${JSON.stringify(reporterUrl.href)};
     import { runNode as runNative } from ${JSON.stringify(processUrl)};
     export * from ${JSON.stringify(processUrl)};

     const self = new URL(import.meta.url);
     if (self.searchParams.has("preload")) {
       registerHooks({
         resolve(specifier, context, nextResolve) {
           return nextResolve(
             context.parentURL === ${JSON.stringify(new URL("scripts/ci/run-tests.ts", repositoryUrl).href)} && specifier === "./runner-process.ts"
               ? new URL("?adapter", self).href : specifier,
             context,
           );
         },
       });
     }
     export const runNode: typeof runNative = (args, options) => {
       const index = args.indexOf("--test-reporter") + 1;
       assert.equal(args[index], ${JSON.stringify(fileURLToPath(reporterUrl))});
       return runNative(args.with(index, fileURLToPath(self)), options);
     };

     export default async function* requestReporter(source: Parameters<typeof reporter>[0]) {
       const root = process.cwd();
       const entry = join(root, upstreamOutageCase.entry);
       const declaration = join(root, upstreamOutageCase.declaration);
       const order = join(root, ${JSON.stringify(requestReceipts.order)});
       const progress = ${JSON.stringify(requestProgress)};
       let count = 0;
       function record(step: string) {
         // The only persisted fields are these closed lifecycle and progress labels.
         if (count++ < 32) appendFileSync(order, step + "\\n");
       }
       async function* observe() {
         for await (const event of source) {
           yield event;
           if (!/^(test:dequeue|test:complete|test:fail)$/.test(event.type)) continue;
           const data = event.data;
           if (!isRecord(data)) continue;
           const kind = data.file === entry && data.name === entry && data.entryFile === undefined
             ? "file"
             : data.file === declaration && data.entryFile === entry && data.name === upstreamOutageCase.name
               ? "case" : "other";
           record(kind + ":" + event.type.slice(5));
         }
       }
       for await (const row of reporter(observe())) {
         const event: unknown = JSON.parse(row);
         if (isRecord(event) && event.type === "test:progress" && isRecord(event.data)) {
           const { kind, stage, outcome, checkpoint } = event.data;
           if (kind === "openshell-stage" || kind === "openshell-replacement-checkpoint") {
             const step = kind === "openshell-stage" && typeof stage === "string" && typeof outcome === "string"
               ? stage + ":" + outcome : checkpoint;
             record(typeof step === "string" && progress.includes(step) ? step : "unexpected-progress");
           }
         }
         if (isRecord(event) && event.type === "test:upstream-outage-attribution") record("attributed");
         yield row;
       }
     }
    `,
  );
  return ["--import", new URL("?preload", pathToFileURL(observer)).href];
}

test("CI records only observed upstream replacement checkpoints on failure", async (t) => {
  const upstreamFile = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const replacementChildModule = new URL(
    "tests/fixtures/ci-runner-openshell-replacement-child.ts",
    repositoryUrl,
  ).href;
  const progressModule = new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href;
  const reporterPath = fileURLToPath(new URL("scripts/ci/reporter.ts", repositoryUrl));

  await t.test("the upstream wrapper registers the helper-declared case", async (t) => {
    const home = await createRunnerFixture(t);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--test",
        "--test-reporter",
        reporterPath,
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

  for (const [mode, checkpoint, outcome, symlinkRoot] of [
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
    ["runner-deadline", undefined, undefined],
    ["runner-deadline-after-activation", "activation", "unfinished"],
    ["runner-deadline-after-wrapper", undefined, undefined],
    ["success", undefined, undefined],
    ["activation", "activation", "failed", true],
    ["case-deadline", "activation", "unfinished", true],
    ["runner-deadline", undefined, undefined, true],
    ["runner-deadline-after-activation", "activation", "unfinished", true],
    ["runner-deadline-after-wrapper", undefined, undefined, true],
    ["wrong-file", undefined, undefined, true],
    ["wrong-declaration", undefined, undefined, true],
    ["completed-wrapper-emitter", undefined, undefined, true],
  ] as const) {
    await t.test(symlinkRoot ? `${mode} through a symlinked root` : mode, async (t) => {
      const root = await realpath(await createRunnerFixture(t));
      const runnerRoot = symlinkRoot ? join(root, "linked-root") : root;
      if (symlinkRoot) {
        await symlink(root, runnerRoot, "dir");
      }
      const results = join(root, "results/upstream.json");
      const state = join(root, "state/upstream.jsonl");
      const cleanupMarker = join(root, "state/cleanup");
      const activationPoll = join(root, "state/activation-poll");
      const caseDeadline = mode === "case-deadline";
      const wallDeadline = mode === "runner-deadline";
      const completedWrapper = mode === "runner-deadline-after-wrapper";
      const controlledDeadline = mode === "runner-deadline-after-activation" || completedWrapper;
      const runnerDeadline = wallDeadline || controlledDeadline;
      // Controlled deadlines must wait for reporter readiness even when startup
      // takes longer than the nominal file budget. Wall-clock cases keep a real timer.
      const runnerTimeoutMs = controlledDeadline ? 1 : 5000;
      const fileTimeoutMs = runnerDeadline ? runnerTimeoutMs : 10000;
      const pendingActivation = caseDeadline || controlledDeadline;
      const sameRevision = mode === "same-revision";
      const observedRequest = mode === "request" || sameRevision;
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
      const aliasedEntry = symlinkRoot && mode === "wrong-file";
      const earlierCase =
        mode === "completed-wrapper-emitter"
          ? `test(${JSON.stringify(join(runnerRoot, file))}, () => {
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
          : completedWrapper
            ? `import test from "node:test";
               test(${JSON.stringify(join(runnerRoot, file))}, () => {});
              `
            : "";
      // The wall-clock case holds the worker before it can register the selected case.
      const wrapperSource = wallDeadline
        ? "setInterval(() => {}, 1000);\nawait new Promise(() => {});\n"
        : `${earlierCase}await import("../helpers/${declaration}");\n`;
      if (aliasedEntry) {
        const actualWrapper = join(root, upstreamFile);
        await writeFile(actualWrapper, wrapperSource);
        await symlink(actualWrapper, wrapper, "file");
      } else {
        await writeFile(wrapper, wrapperSource);
      }
      await writeFile(
        join(root, "scripts/ci/prepare.ts"),
        `import { writeFile } from "node:fs/promises";
         export async function prepareFile() {
           return { cleanup: () => writeFile(${JSON.stringify(cleanupMarker)}, "cleaned") };
         }`,
      );
      const childOptions: OpenShellReplacementChildOptions = {
        mode,
        requestOrderPath: requestReceipts.order,
        requestStart: requestStart.join("\n") + "\n",
        requestBeforeFailure: requestBeforeFailure.join("\n") + "\n",
        requestAttempted: requestReceipts.attempted,
        sameRevisionRefusal: requestReceipts.sameRevisionRefusal,
        activationPoll,
        pendingMessage,
      };
      await writeFile(
        join(root, "tests/helpers", declaration),
        `import test from "node:test";
         import { prepareOpenShellReplacementChild } from ${JSON.stringify(replacementChildModule)};
         const credential = process.env.CI_RUNNER_FIXTURE_CREDENTIAL;
         const failure = new Error("controlled failure " + credential);
         const runScenario = await prepareOpenShellReplacementChild(${JSON.stringify(childOptions)});
         test(${JSON.stringify(name)}, ${caseDeadline ? "{ timeout: 1200 }, " : runnerDeadline ? "{ timeout: 15000 }, " : ""}async (t) => {
           await runScenario(t, failure);
         });`,
      );
      await writeRunnerManifest(root, {
        lanes: {
          [lane]: { files: [{ path: file, expectedTests: [expectedName] }] },
        },
      });
      let execArgv = runnerDeadline ? observeDeadline(controlledDeadline) : [];
      if (observedRequest) {
        execArgv = await observeRequest(root);
      }
      const runner = await runRunnerAsync(
        laneArgs(runnerRoot, lane, state, results),
        { CI_RUNNER_TEST_TIMEOUT_MS: String(fileTimeoutMs) },
        {
          timeout: 30_000,
          execArgv,
        },
      );
      assert.equal(runner.error, undefined);
      if (sameRevision) {
        assert.equal(
          await readFile(join(root, requestReceipts.sameRevisionRefusal), "utf8"),
          "refused",
        );
        await assert.rejects(readFile(activationPoll), { code: "ENOENT" });
      }
      assert.equal(runner.status, success ? 0 : 1, runner.stderr);
      const artifact = await readFile(results, "utf8");
      const summary: {
        files: {
          status: string;
          nodeExitCode: number | null;
          signal: NodeJS.Signals | null;
          openShellReplacement?: { checkpoint: string; outcome: string };
          openShellUnfinishedStage?: string;
          cleanup: { status: string };
          issues: { code: string }[];
          tests: {
            name: string;
            status: string;
            error?: { message: string; failureType?: string; cause?: unknown };
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
      if (runnerDeadline) {
        const receipt: unknown = JSON.parse(await readFile(join(root, timeoutReceipt), "utf8"));
        assert.ok(isRecord(receipt));
        const { elapsedMs } = receipt;
        assert.ok(typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0);
        assert.deepEqual(
          receipt,
          {
            trigger: controlledDeadline ? "readiness" : "wall",
            elapsedMs,
            delay: fileTimeoutMs,
            code: "ETIMEDOUT",
            status: 1,
            signal: null,
            ...(controlledDeadline ? { orderedBeforeBarrier: true } : {}),
          },
          "the original file timeout callback must run from the expected trigger",
        );
        if (controlledDeadline) {
          assert.ok(elapsedMs >= fileTimeoutMs, "readiness must survive the nominal deadline");
        } else {
          // Node/libuv timers use millisecond ticks. Allow one tick of quantization.
          assert.ok(elapsedMs >= fileTimeoutMs - 1);
        }
        assert.deepEqual([result.nodeExitCode, result.signal], [1, null]);
      }
      if (controlledDeadline) {
        const receipt: unknown = JSON.parse(await readFile(join(root, readinessReceipt), "utf8"));
        const entry = join(runnerRoot, upstreamFile);
        const wrapper = join(root, upstreamFile);
        assert.deepEqual(
          receipt,
          {
            lifecycle: [
              ["test:dequeue", entry, null, entry, 0, true],
              ...(completedWrapper
                ? [
                    ["test:dequeue", wrapper, entry, entry, 0, true],
                    ["test:complete", wrapper, entry, entry, 0, true],
                  ]
                : []),
              ["test:dequeue", join(root, upstreamOutageCase.declaration), entry, title, 0, true],
            ],
            poll: 1,
            progress: [
              ...["installation", "exposure-auth", "initial-model"].flatMap((stage) =>
                ["started", "passed"].map((outcome) => ({
                  kind: "openshell-stage",
                  stage,
                  outcome,
                })),
              ),
              {
                kind: "openshell-stage",
                stage: "replacement",
                outcome: "started",
              },
              ...["redeploy-request", "activation"].map((checkpoint) => ({
                kind: "openshell-replacement-checkpoint",
                checkpoint,
              })),
            ],
          },
          "the native reporter must consume the exact lifecycle and nine ordered rows before timeout",
        );
      }
      if (observedRequest) {
        const order = await readFile(join(root, requestReceipts.order), "utf8").catch((error) => {
          if (isRecord(error) && error.code === "ENOENT") {
            return "";
          }
          throw error;
        });
        const context = `${mode} child: ${JSON.stringify({
          exit: result.nodeExitCode,
          signal: result.signal,
          issues: result.issues.map(({ code }) => code),
          order: order.trim().split("\n"),
        })}`;
        assert.deepEqual([result.nodeExitCode, result.signal], [1, null], context);
        assert.ok(
          !result.issues.some(({ code }) => code === "test-timeout" || code === "runner-error"),
          context,
        );
        assert.deepEqual(
          result.tests.map(({ name, status }) => [name, status]),
          [[title, "failed"]],
          context,
        );
        const error = result.tests[0]?.error;
        const message = error?.message ?? "";
        if (sameRevision) {
          assert.deepEqual(
            error?.cause,
            { code: "ERR_ASSERTION", name: "AssertionError" },
            context,
          );
          assert.ok(message.includes("[env:CI_RUNNER_FIXTURE_CREDENTIAL]"), context);
        } else {
          assert.match(message, /^controlled failure \[env:/u, context);
        }
        assert.equal(await readFile(join(root, requestReceipts.attempted), "utf8"), "invoked");
        assert.deepEqual(
          result.measurements
            .filter(({ kind, stage }) => kind === "openshell-stage" && stage === "replacement")
            .map(({ outcome }) => outcome),
          ["failed"],
          context,
        );
        assert.deepEqual(order.trim().split("\n"), [
          ...requestBeforeFailure,
          "case:complete",
          "case:fail",
          "file:complete",
          "attributed",
        ]);
      }
      const expectedReplacement = checkpoint ? { checkpoint, outcome } : undefined;
      if (
        runnerDeadline &&
        (result.openShellReplacement?.checkpoint !== checkpoint ||
          result.openShellReplacement?.outcome !== outcome)
      ) {
        const diagnostics = await runnerDeadlineDiagnostics(state, title);
        const deadlineContext = `OpenShell replacement checkpoint at runner deadline: ${JSON.stringify(
          {
            runnerTimedOut: result.issues.some(({ code }) => code === "test-timeout"),
            diagnostics,
            terminalCaseCount: result.tests.length,
            unfinishedStage:
              result.openShellUnfinishedStage === "replacement" ||
              result.openShellUnfinishedStage === "installation"
                ? result.openShellUnfinishedStage
                : null,
          },
        )}`;
        assert.deepEqual(result.openShellReplacement, expectedReplacement, deadlineContext);
      } else {
        assert.deepEqual(result.openShellReplacement, expectedReplacement);
      }
      assert.equal(result.openShellUnfinishedStage, pendingActivation ? "replacement" : undefined);
      if (runnerDeadline) {
        assert.equal(
          result.issues.some(({ code }) => code === "runner-error"),
          false,
        );
      }
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
        pendingActivation || wallDeadline
          ? undefined
          : success || mode === "later-stage"
            ? "passed"
            : "failed",
      );
      assert.equal(
        result.tests[0]?.error?.failureType,
        caseDeadline ? "testTimeoutFailure" : undefined,
      );
      if (caseDeadline || runnerDeadline) {
        const diagnostics: {
          failures: {
            reason: string;
            timeoutMs?: number;
            elapsedMs?: number;
            interruptedTests?: { name: string }[];
          }[];
        } = JSON.parse(await readFile(`${state}.diagnostics.json`, "utf8"));
        const [failure] = diagnostics.failures;
        assert.ok(failure);
        assert.equal(failure.reason, runnerDeadline ? "timeout" : "failed");
        assert.equal(failure.timeoutMs, runnerDeadline ? fileTimeoutMs : undefined);
        if (wallDeadline) {
          assert.ok((failure.elapsedMs ?? -1) >= 4999);
        }
        assert.deepEqual(
          failure.interruptedTests?.map(({ name }) => name),
          controlledDeadline ? [title] : undefined,
        );
      }
      if (
        mode === "activation" ||
        mode === "reconciliation" ||
        mode === "completed-wrapper-emitter"
      ) {
        assert.match(result.tests[0]?.error?.message ?? "", /^controlled failure \[env:/u);
      }
      if (aliasedEntry) {
        // Check the reporter as well as the runner's independent selected-path gate.
        const native = spawnSync(
          process.execPath,
          ["--test", "--test-reporter", reporterPath, join(runnerRoot, file)],
          { cwd: runnerRoot, env: {}, encoding: "utf8", timeout: 10_000 },
        );
        assert.equal(native.error, undefined);
        assert.equal(native.status, 1);
        const lines = native.stdout.split("\n");
        assert.ok(
          lines.includes(
            '{"type":"test:progress","data":{"kind":"openshell-replacement-checkpoint","checkpoint":"activation"}}',
          ),
        );
        assert.equal(lines.includes('{"type":"test:upstream-outage-attribution"}'), false);
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
  const exactActivation = {
    checkpoint: "activation",
    outcome: "unfinished",
  } as const;

  type Cutoff = {
    events: Event[];
    checkpoint?: FileEvidence["openShellReplacement"];
    unfinishedStage?: FileEvidence["unfinishedStage"];
    timedOut?: boolean;
  };
  const completions: Record<string, Cutoff> = {
    "request progress before failure": {
      events: [...active, failedStage, ...complete(), measurement("failed")],
      checkpoint: { checkpoint: "redeploy-request", outcome: "failed" },
    },
    "request progress after failure": {
      events: [
        ...active.slice(0, -1),
        ...complete(),
        replacement[1]!,
        failedStage,
        measurement("failed"),
      ],
    },
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
  type Interruption = Cutoff & {
    interruptedNames?: string[];
    partialLine?: string;
  };
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
          data: {
            name,
            nesting: 0,
            entryFile: absolutePath,
            file: testCase.file,
          },
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
